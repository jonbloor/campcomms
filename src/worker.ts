import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import webpush from "web-push";

type User = { id: string; email: string; display_name: string; parent_of: string; status: string; email_notification_preference: EmailPreference };
type EmailPreference = "daily" | "important_only" | "none";
type Membership = {
  event_id: string; user_id: string; role: string; access_ends_at: string | null;
  can_view_private: number; can_reply_private: number; can_post_announcements: number;
};
type Variables = { user: User };
type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const SESSION_COOKIE = "events_session";
const PHOTO_GUEST_COOKIE = "photo_guest_session";
const SESSION_DAYS = 30;

app.use("*", secureHeaders());
app.use(
  "/api/*",
  cors({
    origin: (origin, c) => origin === c.env.APP_ORIGIN ? origin : c.env.APP_ORIGIN,
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type"],
    credentials: true,
  }),
);

app.onError((error, c) => {
  console.error(JSON.stringify({ level: "error", message: error.message, path: c.req.path }));
  return c.json({ error: "Something went wrong. Please try again." }, 500);
});

app.get("/api/health", (c) => c.json({ ok: true, service: c.env.APP_NAME }));

app.post("/api/auth/request-link", async (c) => {
  const body = await safeJson<{ email?: string; redirectPath?: string }>(c.req.raw);
  const email = normaliseEmail(body.email);
  const redirectPath = safeRedirect(body.redirectPath);
  const generic = { ok: true, message: "If that address is invited, a sign-in email is on its way." };

  if (!email) return c.json(generic);

  const user = await c.env.DB.prepare(
    "SELECT id, email, display_name, status FROM users WHERE email = ? COLLATE NOCASE AND status != 'suspended'",
  )
    .bind(email)
    .first<User>();
  if (!user) return c.json(generic);

  const recent = await c.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM magic_links WHERE user_id = ? AND created_at > datetime('now', '-15 minutes')",
  )
    .bind(user.id)
    .first<{ count: number }>();
  if ((recent?.count ?? 0) >= 5) return c.json(generic);

  const token = randomToken(32);
  const tokenHash = await sha256(token);
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  const ipHash = await sha256(c.req.header("CF-Connecting-IP") ?? "unknown");
  await c.env.DB.prepare(
    "INSERT INTO magic_links (id, user_id, token_hash, redirect_path, expires_at, requested_ip_hash) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(id, user.id, tokenHash, redirectPath, expiresAt, ipHash)
    .run();

  const url = `${c.env.APP_ORIGIN}/auth/verify?token=${encodeURIComponent(token)}`;
  const delivery = await sendEmail(c.env, {
    to: user.email,
    subject: "Your secure sign-in link",
    purpose: "magic_link",
    html: magicLinkEmail(user.display_name, url),
  });
  await recordEmail(c.env.DB, user.id, "magic_link", delivery);

  if (!delivery.ok && String(c.env.ENVIRONMENT) !== "development") {
    console.error(JSON.stringify({ level: "error", message: "Magic-link email failed", userId: user.id }));
  }

  return c.json(generic);
});

app.get("/auth/verify", (c) => {
  const token = c.req.query("token") ?? "";
  if (token.length >= 20) return c.html(magicLinkConfirmationPage(token));
  return c.html(
    brandedStatusPage(
      "That sign-in link is unavailable",
      "It may be incomplete. Return to CampComms and request a new email.",
      [{ label: "Return to CampComms", href: "/", primary: true }],
    ),
    400,
  );
});

app.post("/auth/verify", async (c) => {
  const form = await c.req.parseBody();
  const token = typeof form.token === "string" ? form.token : "";
  const verification = await consumeMagicLink(c, token);
  if (!verification) {
    return c.html(brandedStatusPage(
      "That sign-in link is unavailable",
      "It may have expired or already been used. Return to CampComms and request a new email.",
      [{ label: "Return to CampComms", href: "/", primary: true }],
    ),
      400,
    );
  }
  return c.redirect(verification.redirectPath, 303);
});

export function magicLinkConfirmationPage(token: string) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Continue to CampComms</title><body style="font-family:Arial,sans-serif;max-width:36rem;margin:4rem auto;padding:1rem;color:#222"><main><p style="font-weight:700;color:#7413dc">4th Ashby CampComms</p><h1>Continue to CampComms</h1><p>Press the button below to use your secure sign-in link. This extra step prevents email security checks from using the link before you do.</p><form method="post" action="/auth/verify"><input type="hidden" name="token" value="${escapeHtml(token)}"><button type="submit" style="border:0;border-radius:8px;background:#7413dc;color:white;padding:12px 18px;font-weight:700;cursor:pointer">Continue to CampComms</button></form><p style="margin-top:1.5rem"><a href="/" style="color:#5c10b4">Return without signing in</a></p></main></body></html>`;
}

app.get("/email/unsubscribe", async (c) => {
  const token = c.req.query("token") ?? "";
  const tokenHash = token.length >= 20 ? await sha256(token) : "invalid";
  const available = await c.env.DB.prepare(
    "SELECT id FROM email_unsubscribe_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')",
  ).bind(tokenHash).first();
  if (!available) return unsubscribePage(c, "Link unavailable", "This link has expired or has already been used. Sign in to CampComms to review your notification preference.", null, 400);
  return unsubscribePage(c, "Stop update emails?", "This will stop daily summaries and important-announcement emails. Sign-in and invitation emails will still work.", token, 200);
});

app.post("/email/unsubscribe", async (c) => {
  const form = await c.req.parseBody();
  const token = typeof form.token === "string" ? form.token : "";
  const tokenHash = token.length >= 20 ? await sha256(token) : "invalid";
  const unsubscribed = await c.env.DB.prepare(
    `UPDATE email_unsubscribe_tokens SET used_at = CURRENT_TIMESTAMP
     WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now') RETURNING user_id`,
  ).bind(tokenHash).first<{ user_id: string }>();
  if (!unsubscribed) return unsubscribePage(c, "Link unavailable", "This link has expired or has already been used.", null, 400);
  await c.env.DB.prepare("UPDATE users SET email_notification_preference = 'none', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(unsubscribed.user_id).run();
  return unsubscribePage(c, "Email updates stopped", "You will no longer receive CampComms update emails. You can change this again under Information → Notifications after signing in.", null, 200);
});

function unsubscribePage(c: AppContext, title: string, copy: string, token: string | null, status: 200 | 400) {
  const action = token ? `<form method="post" action="/email/unsubscribe"><input type="hidden" name="token" value="${escapeHtml(token)}"><button style="border:0;border-radius:8px;background:#7413dc;color:white;padding:12px 18px;font-weight:700;cursor:pointer">Stop update emails</button></form>` : "";
  return c.html(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><body style="font-family:Arial,sans-serif;max-width:36rem;margin:4rem auto;padding:1rem;color:#222"><h1 style="color:#7413dc">${escapeHtml(title)}</h1><p>${escapeHtml(copy)}</p>${action}<p><a href="${escapeHtml(c.env.APP_ORIGIN)}" style="color:#5c10b4">Return to 4th Ashby CampComms</a></p></body></html>`, status);
}

app.get("/api/auth/verify", async (c) => {
  const verification = await consumeMagicLink(c);
  if (!verification) return c.json({ error: "This sign-in link has expired or has already been used." }, 400);
  return c.json({ ok: true, redirectPath: verification.redirectPath });
});

app.get("/photos/guest/verify", (c) => {
  const token = c.req.query("token") ?? "";
  if (token.length >= 20) return c.html(photoGuestConfirmationPage(token));
  return c.html(brandedStatusPage(
    "Photo invitation unavailable",
    "This invitation link appears to be incomplete. Ask the event organiser to send a fresh invitation.",
    [{ label: "Return to CampComms", href: "/", primary: true }],
  ), 400);
});

app.post("/photos/guest/verify", async (c) => {
  const form = await c.req.parseBody();
  const token = typeof form.token === "string" ? form.token : "";
  const link = token.length >= 20 ? await c.env.DB.prepare(
    `UPDATE photo_guest_links SET used_at = CURRENT_TIMESTAMP WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')
     AND EXISTS (SELECT 1 FROM photo_guests pg WHERE pg.id = photo_guest_links.guest_id AND pg.status != 'revoked' AND pg.access_ends_at > datetime('now'))
     RETURNING guest_id`,
  ).bind(await sha256(token)).first<{ guest_id: string }>() : null;
  if (!link) return c.html(brandedStatusPage(
    "Photo invitation already used",
    "This secure invitation works once and may also have expired. If you opened it successfully before, use the button below on the same device. Otherwise, ask the event organiser to send a fresh invitation.",
    [{ label: "Open photo albums", href: "/photos/guest", primary: true }, { label: "Return to CampComms", href: "/" }],
  ), 410);
  const sessionToken = randomToken(32);
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO photo_guest_sessions (id, guest_id, token_hash, expires_at) VALUES (?, ?, ?, datetime('now', '+30 days'))").bind(crypto.randomUUID(), link.guest_id, await sha256(sessionToken)),
    c.env.DB.prepare("UPDATE photo_guests SET status = 'active' WHERE id = ?").bind(link.guest_id),
  ]);
  setCookie(c, PHOTO_GUEST_COOKIE, sessionToken, { httpOnly: true, secure: String(c.env.ENVIRONMENT) !== "development", sameSite: "Lax", path: "/", maxAge: 30 * 86_400 });
  return c.redirect("/photos/guest", 303);
});

export function photoGuestConfirmationPage(token: string) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Open CampComms photos</title><body style="font-family:Arial,sans-serif;max-width:36rem;margin:4rem auto;padding:1rem;color:#222"><main><p style="font-weight:700;color:#7413dc">4th Ashby CampComms</p><h1>Open CampComms photos</h1><p>Press the button below to use your secure photo invitation. This extra step prevents email security checks from using the invitation before you do.</p><form method="post" action="/photos/guest/verify"><input type="hidden" name="token" value="${escapeHtml(token)}"><button type="submit" style="border:0;border-radius:8px;background:#7413dc;color:white;padding:12px 18px;font-weight:700;cursor:pointer">Open photo albums</button></form><p style="margin-top:1.5rem"><a href="/" style="color:#5c10b4">Return without signing in</a></p></main></body></html>`;
}

app.get("/photos/guest", async (c) => {
  const asset = await c.env.ASSETS.fetch(new Request(new URL("/", c.req.url).toString(), { headers: c.req.raw.headers }));
  return new Response(asset.body, asset);
});

app.get("/api/photo-guest", async (c) => {
  const access = await requirePhotoGuest(c);
  if (access instanceof Response) return access;
  const albums = await c.env.DB.prepare(
    `SELECT pa.id, pa.title, pa.description, pa.taken_on, COUNT(p.id) AS media_count
     FROM photo_albums pa LEFT JOIN photos p ON p.album_id = pa.id WHERE pa.event_id = ? GROUP BY pa.id ORDER BY COALESCE(pa.taken_on, pa.created_at) DESC`,
  ).bind(access.event_id).all();
  return c.json({ guest: { displayName: access.display_name }, event: { name: access.event_name, endsAt: access.ends_at }, albums: albums.results });
});

app.get("/api/photo-guest/albums/:albumId", async (c) => {
  const access = await requirePhotoGuest(c);
  if (access instanceof Response) return access;
  const album = await c.env.DB.prepare("SELECT id, title, description, taken_on FROM photo_albums WHERE id = ? AND event_id = ?")
    .bind(c.req.param("albumId"), access.event_id).first();
  if (!album) return c.json({ error: "Album not found." }, 404);
  const media = await c.env.DB.prepare("SELECT id, caption, media_kind, content_type, created_at FROM photos WHERE album_id = ? ORDER BY created_at DESC")
    .bind(c.req.param("albumId")).all();
  return c.json({ album, media: media.results });
});

app.get("/api/photo-guest/media/:photoId", async (c) => {
  const access = await requirePhotoGuest(c);
  if (access instanceof Response) return access;
  const photo = await c.env.DB.prepare(
    `SELECT p.id, p.album_id, p.display_key, p.video_key, p.media_kind, p.content_type FROM photos p JOIN photo_albums pa ON pa.id = p.album_id
     WHERE p.id = ? AND pa.event_id = ?`,
  ).bind(c.req.param("photoId"), access.event_id).first<{ id: string; album_id: string; display_key: string; video_key: string | null; media_kind: string; content_type: string }>();
  if (!photo) return c.json({ error: "Media not found." }, 404);
  const object = await c.env.PHOTOS.get(photo.media_kind === "video" ? photo.video_key! : photo.display_key);
  if (!object) return c.json({ error: "Media file not found." }, 404);
  c.executionCtx.waitUntil(recordPhotoView(c.env.DB, access.event_id, photo.album_id, photo.id, null, access.id));
  return new Response(object.body, { headers: { "Content-Type": photo.content_type, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", ETag: object.httpEtag } });
});

app.post("/api/photo-guest/logout", async (c) => {
  const token = getCookie(c, PHOTO_GUEST_COOKIE);
  if (token) await c.env.DB.prepare("DELETE FROM photo_guest_sessions WHERE token_hash = ?").bind(await sha256(token)).run();
  deleteCookie(c, PHOTO_GUEST_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

async function consumeMagicLink(c: AppContext, suppliedToken?: string) {
  const token = suppliedToken ?? c.req.query("token") ?? "";
  if (token.length < 20) return null;
  const tokenHash = await sha256(token);

  const link = await c.env.DB.prepare(
    `UPDATE magic_links SET used_at = CURRENT_TIMESTAMP
     WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')
       AND EXISTS (SELECT 1 FROM users u WHERE u.id = magic_links.user_id AND u.status != 'suspended')
     RETURNING user_id, redirect_path`,
  )
    .bind(tokenHash)
    .first<{ user_id: string; redirect_path: string }>();
  if (!link) return null;

  const sessionToken = randomToken(32);
  const sessionHash = await sha256(sessionToken);
  const sessionId = crypto.randomUUID();
  const sessionExpiry = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();

  await c.env.DB.prepare(
    "INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)",
  ).bind(sessionId, link.user_id, sessionHash, sessionExpiry).run();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(link.user_id),
    c.env.DB.prepare(
      "UPDATE event_invitations SET status = 'accepted', accepted_at = CURRENT_TIMESTAMP WHERE user_id = ? AND status IN ('sent', 'delivered') AND expires_at > datetime('now')",
    ).bind(link.user_id),
  ]);

  setCookie(c, SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    secure: String(c.env.ENVIRONMENT) !== "development",
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_DAYS * 86_400,
  });
  return { redirectPath: link.redirect_path };
}

app.post("/api/auth/logout", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

app.use("/api/*", async (c, next) => {
  if (c.req.path.startsWith("/api/auth/") || c.req.path.startsWith("/api/photo-guest") || c.req.path === "/api/health" || c.req.path === "/api/resend/webhook") {
    return next();
  }
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return c.json({ error: "Please sign in.", code: "UNAUTHENTICATED" }, 401);
  const user = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.display_name, u.parent_of, u.status, u.email_notification_preference
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > datetime('now') AND u.status != 'suspended'`,
  )
    .bind(await sha256(token))
    .first<User>();
  if (!user) {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ error: "Your session has expired.", code: "UNAUTHENTICATED" }, 401);
  }
  c.set("user", user);
  await next();
});

app.get("/api/me", async (c) => {
  const user = c.get("user");
  const children = await c.env.DB.prepare(
    "SELECT c.id, c.display_name FROM children c JOIN parent_children pc ON pc.child_id = c.id WHERE pc.user_id = ?",
  )
    .bind(user.id)
    .all<{ id: string; display_name: string }>();
  return c.json({ user: { ...publicUser(user), isSystemAdmin: user.email.toLowerCase() === c.env.SYSTEM_ADMIN_EMAIL.toLowerCase() }, children: children.results });
});

app.patch("/api/me", async (c) => {
  const body = await safeJson<{ displayName?: string; parentOf?: string; emailNotificationPreference?: string }>(c.req.raw);
  if (body.emailNotificationPreference !== undefined) {
    const preference = validEmailPreference(body.emailNotificationPreference);
    if (!preference) return c.json({ error: "Choose a valid email notification preference." }, 400);
    await c.env.DB.prepare("UPDATE users SET email_notification_preference = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(preference, c.get("user").id).run();
    await c.env.DB.prepare("INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, metadata_json) VALUES (?, ?, 'email_preference.updated', 'user', ?, ?)")
      .bind(crypto.randomUUID(), c.get("user").id, c.get("user").id, JSON.stringify({ preference })).run();
    return c.json({ ok: true, emailNotificationPreference: preference });
  }
  const displayName = cleanText(body.displayName, 80);
  const parentOf = cleanText(body.parentOf, 160);
  if (!displayName) return c.json({ error: "Please enter the name or nickname other parents should see." }, 400);
  await c.env.DB.prepare("UPDATE users SET display_name = ?, parent_of = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(displayName, parentOf, c.get("user").id).run();
  await c.env.DB.prepare("INSERT INTO audit_logs (id, actor_id, action, target_type, target_id) VALUES (?, ?, 'profile.updated', 'user', ?)")
    .bind(crypto.randomUUID(), c.get("user").id, c.get("user").id).run();
  return c.json({ user: { id: c.get("user").id, email: c.get("user").email, displayName, parentOf, emailNotificationPreference: c.get("user").email_notification_preference } });
});

app.get("/api/push/config", async (c) => {
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS count FROM push_subscriptions WHERE user_id = ?")
    .bind(c.get("user").id).first<{ count: number }>();
  return c.json({ publicKey: c.env.VAPID_PUBLIC_KEY, subscriptionCount: count?.count ?? 0 });
});

app.post("/api/push/subscriptions", async (c) => {
  const body = await safeJson<{ endpoint?: string; keys?: { p256dh?: string; auth?: string } }>(c.req.raw);
  const endpoint = safePushEndpoint(body.endpoint);
  const p256dh = cleanPushKey(body.keys?.p256dh, 200);
  const auth = cleanPushKey(body.keys?.auth, 100);
  if (!endpoint || !p256dh || !auth) return c.json({ error: "The browser supplied an invalid notification subscription." }, 400);
  await c.env.DB.prepare(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, last_success_at = NULL`,
  ).bind(crypto.randomUUID(), c.get("user").id, endpoint, p256dh, auth).run();
  return c.json({ ok: true }, 201);
});

app.delete("/api/push/subscriptions", async (c) => {
  const body = await safeJson<{ endpoint?: string }>(c.req.raw);
  if (typeof body.endpoint === "string") {
    await c.env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?").bind(body.endpoint, c.get("user").id).run();
  }
  return c.json({ ok: true });
});

app.post("/api/push/test", async (c) => {
  const user = c.get("user");
  const count = await sendPushToUsers(c.env, [user.id], { title: "Notifications are working", body: "4th Ashby CampComms can now alert this device to important updates.", url: "/", tag: "push-test" });
  return c.json({ ok: count > 0, sent: count });
});

app.get("/api/events", async (c) => {
  const user = c.get("user");
  const events = await c.env.DB.prepare(
    `SELECT e.id, e.slug, e.name, e.summary, e.location, e.section, e.starts_at, e.ends_at, e.status,
            e.posting_closes_at, e.read_only_until, em.role,
            (SELECT COUNT(*) FROM announcements a WHERE a.event_id = e.id) AS announcement_count,
            (SELECT COUNT(*) FROM photos p JOIN photo_albums pa ON pa.id = p.album_id WHERE pa.event_id = e.id) AS photo_count
     FROM events e JOIN event_memberships em ON em.event_id = e.id
     WHERE em.user_id = ? AND (em.access_ends_at IS NULL OR em.access_ends_at > datetime('now'))
       AND e.status != 'archived'
     ORDER BY e.starts_at DESC`,
  )
    .bind(user.id)
    .all();
  return c.json({ events: events.results });
});

app.get("/api/events/:eventId", async (c) => {
  const membership = await requireMembership(c, c.req.param("eventId"));
  if (membership instanceof Response) return membership;
  const eventId = membership.event_id;
  const [event, announcements, topics, lifts, albums, privateUnread] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM events WHERE id = ?").bind(eventId).first(),
    c.env.DB.prepare(
      `SELECT a.*, u.display_name AS author_name, u.parent_of AS author_parent_of, em.role AS author_role,
              EXISTS(SELECT 1 FROM announcement_acknowledgements aa WHERE aa.announcement_id = a.id AND aa.user_id = ?) AS acknowledged,
              (SELECT COUNT(*) FROM announcement_acknowledgements aa WHERE aa.announcement_id = a.id) AS acknowledgement_count
       FROM announcements a JOIN users u ON u.id = a.author_id JOIN event_memberships em ON em.event_id = a.event_id AND em.user_id = a.author_id WHERE a.event_id = ? ORDER BY a.published_at DESC`,
    ).bind(c.get("user").id, eventId).all(),
    c.env.DB.prepare(
      `SELECT t.*, u.display_name AS author_name, u.parent_of AS author_parent_of, em.role AS author_role,
              (SELECT COUNT(*) FROM posts p WHERE p.topic_id = t.id AND p.deleted_at IS NULL) AS reply_count,
              (SELECT MAX(p.created_at) FROM posts p WHERE p.topic_id = t.id AND p.deleted_at IS NULL) AS last_reply_at,
              EXISTS(SELECT 1 FROM posts p WHERE p.topic_id = t.id AND p.deleted_at IS NULL AND p.author_id != ?
                AND p.created_at > COALESCE((SELECT cr.last_read_at FROM content_reads cr WHERE cr.user_id = ? AND cr.resource_type = 'topic' AND cr.resource_id = t.id), '1970-01-01')) AS unread
       FROM topics t JOIN users u ON u.id = t.created_by JOIN event_memberships em ON em.event_id = t.event_id AND em.user_id = t.created_by
       WHERE t.event_id = ? AND (t.audience = 'everyone' OR ? = 1) ORDER BY COALESCE(last_reply_at, t.created_at) DESC`,
    ).bind(c.get("user").id, c.get("user").id, eventId, canAccessLeaderDiscussions(membership.role) ? 1 : 0).all(),
    c.env.DB.prepare(
      `SELECT l.*, u.display_name AS author_name, u.parent_of AS author_parent_of, em.role AS author_role,
              (SELECT COUNT(*) FROM lift_responses lr WHERE lr.lift_post_id = l.id) AS response_count,
              EXISTS(SELECT 1 FROM lift_responses lr WHERE lr.lift_post_id = l.id AND lr.author_id != ?
                AND lr.created_at > COALESCE((SELECT cr.last_read_at FROM content_reads cr WHERE cr.user_id = ? AND cr.resource_type = 'lift' AND cr.resource_id = l.id), '1970-01-01')) AS unread
       FROM lift_posts l JOIN users u ON u.id = l.author_id JOIN event_memberships em ON em.event_id = l.event_id AND em.user_id = l.author_id
       WHERE l.event_id = ? AND l.status != 'withdrawn' AND ? = 0 ORDER BY l.journey_at`,
    ).bind(c.get("user").id, c.get("user").id, eventId, membership.role === "young_leader" ? 1 : 0).all(),
    c.env.DB.prepare(
      `SELECT pa.*, (SELECT COUNT(*) FROM photos p WHERE p.album_id = pa.id) AS photo_count,
              (SELECT p.id FROM photos p WHERE p.album_id = pa.id AND p.media_kind = 'photo' ORDER BY p.created_at DESC LIMIT 1) AS cover_photo_id
       FROM photo_albums pa WHERE pa.event_id = ? ORDER BY COALESCE(pa.taken_on, pa.created_at) DESC`,
    ).bind(eventId).all(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS count FROM private_threads pt
       WHERE pt.event_id = ? AND ? = 0 AND (? = 1 OR pt.opened_by = ?)
         AND EXISTS(SELECT 1 FROM private_messages pm WHERE pm.thread_id = pt.id AND pm.author_id != ?
           AND pm.created_at > COALESCE((SELECT cr.last_read_at FROM content_reads cr WHERE cr.user_id = ? AND cr.resource_type = 'private_thread' AND cr.resource_id = pt.id), '1970-01-01'))`,
    ).bind(eventId, membership.role === "young_leader" ? 1 : 0, hasCapability(membership, "can_view_private") ? 1 : 0, c.get("user").id, c.get("user").id, c.get("user").id).first<{ count: number }>(),
  ]);
  const topicRows = topics.results as Array<{ unread: number; kind: "discussion" | "lost" | "found" }>;
  const liftRows = lifts.results as Array<{ unread: number }>;
  return c.json({
    event, membership, announcements: announcements.results, topics: topics.results, lifts: lifts.results, albums: albums.results,
    unread_counts: {
      discussions: topicRows.filter((topic) => topic.kind === "discussion").reduce((count, topic) => count + Number(Boolean(topic.unread)), 0),
      lost_found: topicRows.filter((topic) => topic.kind !== "discussion").reduce((count, topic) => count + Number(Boolean(topic.unread)), 0),
      lifts: liftRows.reduce((count, lift) => count + Number(Boolean(lift.unread)), 0),
      private_messages: privateUnread?.count ?? 0,
    },
  });
});

app.post("/api/events/:eventId/albums", async (c) => {
  const membership = await requireMembership(c, c.req.param("eventId"), ["young_leader", "leader", "event_admin", "safeguarding"]);
  if (membership instanceof Response) return membership;
  const body = await safeJson<{ title?: string; description?: string; takenOn?: string }>(c.req.raw);
  const title = cleanText(body.title, 120);
  const description = cleanText(body.description, 500);
  const takenOn = validDay(body.takenOn);
  if (!title) return c.json({ error: "Please enter an album title." }, 400);
  if (body.takenOn && !takenOn) return c.json({ error: "Choose a valid album date." }, 400);
  const id = crypto.randomUUID();
  await c.env.DB.prepare("INSERT INTO photo_albums (id, event_id, title, description, taken_on, created_by) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, membership.event_id, title, description, takenOn, c.get("user").id).run();
  await audit(c.env.DB, c.get("user").id, membership.event_id, "photo_album.created", "photo_album", id);
  return c.json({ id }, 201);
});

app.get("/api/events/:eventId/photo-guests", async (c) => {
  const membership = await requireMembership(c, c.req.param("eventId"), ["event_admin"]);
  if (membership instanceof Response) return membership;
  const guests = await c.env.DB.prepare("SELECT id, email, display_name, status, access_ends_at, created_at FROM photo_guests WHERE event_id = ? ORDER BY created_at DESC")
    .bind(membership.event_id).all();
  return c.json({ guests: guests.results });
});

app.post("/api/events/:eventId/photo-guests", async (c) => {
  const membership = await requireMembership(c, c.req.param("eventId"), ["event_admin"]);
  if (membership instanceof Response) return membership;
  const body = await safeJson<{ email?: string; displayName?: string }>(c.req.raw);
  const email = normaliseEmail(body.email); const displayName = cleanText(body.displayName, 100);
  if (!email || !displayName) return c.json({ error: "Enter the guest’s name and a valid email address." }, 400);
  const event = await c.env.DB.prepare("SELECT name, read_only_until FROM events WHERE id = ?").bind(membership.event_id).first<{ name: string; read_only_until: string }>();
  if (!event) return c.json({ error: "Event not found." }, 404);
  const guestId = crypto.randomUUID();
  const guest = await c.env.DB.prepare(
    `INSERT INTO photo_guests (id, event_id, email, display_name, status, access_ends_at, invited_by) VALUES (?, ?, ?, ?, 'invited', ?, ?)
     ON CONFLICT(event_id, email) DO UPDATE SET display_name = excluded.display_name, status = 'invited', access_ends_at = excluded.access_ends_at, invited_by = excluded.invited_by
     RETURNING id`,
  ).bind(guestId, membership.event_id, email, displayName, event.read_only_until, c.get("user").id).first<{ id: string }>();
  const token = randomToken(32);
  await c.env.DB.prepare("INSERT INTO photo_guest_links (id, guest_id, token_hash, expires_at) VALUES (?, ?, ?, datetime('now', '+48 hours'))")
    .bind(crypto.randomUUID(), guest!.id, await sha256(token)).run();
  const url = `${c.env.APP_ORIGIN}/photos/guest/verify?token=${encodeURIComponent(token)}`;
  const delivery = await sendEmail(c.env, { to: email, subject: `Photographs from ${event.name}`, purpose: "photo_guest_invitation", html: photoGuestEmail(displayName, event.name, url) });
  await audit(c.env.DB, c.get("user").id, membership.event_id, "photo_guest.invited", "photo_guest", guest!.id, { delivered: delivery.ok });
  return c.json({ id: guest!.id, sent: delivery.ok }, delivery.ok ? 201 : 502);
});

app.delete("/api/events/:eventId/photo-guests/:guestId", async (c) => {
  const membership = await requireMembership(c, c.req.param("eventId"), ["event_admin"]);
  if (membership instanceof Response) return membership;
  const result = await c.env.DB.prepare("UPDATE photo_guests SET status = 'revoked' WHERE id = ? AND event_id = ?")
    .bind(c.req.param("guestId"), membership.event_id).run();
  if (!result.meta.changes) return c.json({ error: "Photo guest not found." }, 404);
  await c.env.DB.prepare("DELETE FROM photo_guest_sessions WHERE guest_id = ?").bind(c.req.param("guestId")).run();
  await audit(c.env.DB, c.get("user").id, membership.event_id, "photo_guest.revoked", "photo_guest", c.req.param("guestId"));
  return c.json({ ok: true });
});

app.get("/api/events/:eventId/albums/:albumId", async (c) => {
  const membership = await requireMembership(c, c.req.param("eventId"));
  if (membership instanceof Response) return membership;
  const album = await c.env.DB.prepare(
    `SELECT pa.*, u.display_name AS created_by_name FROM photo_albums pa JOIN users u ON u.id = pa.created_by
     WHERE pa.id = ? AND pa.event_id = ?`,
  ).bind(c.req.param("albumId"), membership.event_id).first();
  if (!album) return c.json({ error: "Album not found." }, 404);
  const photos = await c.env.DB.prepare(
    `SELECT p.id, p.caption, p.content_type, p.size_bytes, p.created_at, p.media_kind, u.display_name AS uploaded_by_name
     FROM photos p JOIN users u ON u.id = p.uploaded_by WHERE p.album_id = ? ORDER BY p.created_at DESC`,
  ).bind(c.req.param("albumId")).all<{ id: string; caption: string; content_type: string; size_bytes: number; created_at: string; media_kind: "photo" | "video"; uploaded_by_name: string }>();
  return c.json({ album, photos: photos.results.map((photo) => ({ ...photo, thumbnailUrl: photo.media_kind === "photo" ? `/api/events/${membership.event_id}/photos/${photo.id}/thumbnail` : null, displayUrl: `/api/events/${membership.event_id}/photos/${photo.id}/${photo.media_kind === "video" ? "video" : "display"}` })) });
});

app.post("/api/events/:eventId/albums/:albumId/photos", async (c) => {
  const membership = await requireMembership(c, c.req.param("eventId"), ["young_leader", "leader", "event_admin", "safeguarding"]);
  if (membership instanceof Response) return membership;
  const contentLength = Number(c.req.header("Content-Length") ?? 0);
  if (!contentLength || contentLength > 45 * 1024 * 1024) return c.json({ error: "Each upload must be under 45 MB." }, 413);
  const album = await c.env.DB.prepare(
    `SELECT pa.id, e.purge_after FROM photo_albums pa JOIN events e ON e.id = pa.event_id WHERE pa.id = ? AND pa.event_id = ?`,
  ).bind(c.req.param("albumId"), membership.event_id).first<{ id: string; purge_after: string }>();
  if (!album) return c.json({ error: "Album not found." }, 404);
  const form = await c.req.raw.formData();
  const video = form.get("video");
  const original = form.get("original");
  const display = form.get("display");
  const thumbnail = form.get("thumbnail");
  const id = crypto.randomUUID();
  const base = `${membership.event_id}/${album.id}/${id}`;
  if (validVideoFile(video, 40 * 1024 * 1024)) {
    const extension = video.type === "video/webm" ? "webm" : video.type === "video/quicktime" ? "mov" : "mp4";
    const videoKey = `${base}/video.${extension}`;
    try {
      await c.env.PHOTOS.put(videoKey, video.stream(), { httpMetadata: { contentType: video.type, cacheControl: "private, no-store" } });
      await c.env.DB.prepare(
        `INSERT INTO photos (id, album_id, uploaded_by, original_key, display_key, thumbnail_key, video_key, media_kind, content_type, size_bytes, caption, delete_after)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'video', ?, ?, ?, ?)`,
      ).bind(id, album.id, c.get("user").id, `${base}/unused-original`, `${base}/unused-display`, `${base}/unused-thumbnail`, videoKey, video.type, video.size, cleanText(form.get("caption"), 300), album.purge_after).run();
    } catch (error) { await c.env.PHOTOS.delete(videoKey); throw error; }
    await audit(c.env.DB, c.get("user").id, membership.event_id, "video.uploaded", "photo", id);
    return c.json({ id }, 201);
  }
  if (!validPhotoFile(original, 9 * 1024 * 1024) || !validPhotoFile(display, 4 * 1024 * 1024) || !validPhotoFile(thumbnail, 1 * 1024 * 1024)) {
    return c.json({ error: "The processed image files are missing, too large or unsupported." }, 400);
  }
  const originalKey = `${base}/original.jpg`;
  const displayKey = `${base}/display.jpg`;
  const thumbnailKey = `${base}/thumbnail.jpg`;
  try {
    await c.env.PHOTOS.put(originalKey, original.stream(), { httpMetadata: { contentType: "image/jpeg", cacheControl: "private, no-store" } });
    await c.env.PHOTOS.put(displayKey, display.stream(), { httpMetadata: { contentType: "image/jpeg", cacheControl: "private, no-store" } });
    await c.env.PHOTOS.put(thumbnailKey, thumbnail.stream(), { httpMetadata: { contentType: "image/jpeg", cacheControl: "private, no-store" } });
    await c.env.DB.prepare(
      `INSERT INTO photos (id, album_id, uploaded_by, original_key, display_key, thumbnail_key, content_type, size_bytes, caption, delete_after)
       VALUES (?, ?, ?, ?, ?, ?, 'image/jpeg', ?, ?, ?)`,
    ).bind(id, album.id, c.get("user").id, originalKey, displayKey, thumbnailKey, original.size, cleanText(form.get("caption"), 300), album.purge_after).run();
  } catch (error) {
    await c.env.PHOTOS.delete([originalKey, displayKey, thumbnailKey]);
    throw error;
  }
  await audit(c.env.DB, c.get("user").id, membership.event_id, "photo.uploaded", "photo", id);
  return c.json({ id }, 201);
});

app.get("/api/events/:eventId/photos/:photoId/:variant", async (c) => {
  const membership = await requireMembership(c, c.req.param("eventId"));
  if (membership instanceof Response) return membership;
  const variant = c.req.param("variant");
  if (!(["display", "thumbnail", "video"] as const).includes(variant as "display" | "thumbnail" | "video")) return c.json({ error: "Media variant not found." }, 404);
  const photo = await c.env.DB.prepare(
    `SELECT p.display_key, p.thumbnail_key, p.video_key, p.media_kind, p.content_type, p.album_id FROM photos p JOIN photo_albums pa ON pa.id = p.album_id
     WHERE p.id = ? AND pa.event_id = ?`,
  ).bind(c.req.param("photoId"), membership.event_id).first<{ display_key: string; thumbnail_key: string; video_key: string | null; media_kind: string; content_type: string; album_id: string }>();
  if (!photo) return c.json({ error: "Photograph not found." }, 404);
  if (photo.media_kind === "video" && variant !== "video") return c.json({ error: "Video preview not found." }, 404);
  if (photo.media_kind === "photo" && variant === "video") return c.json({ error: "Video not found." }, 404);
  const key = variant === "video" ? photo.video_key! : variant === "display" ? photo.display_key : photo.thumbnail_key;
  const object = await c.env.PHOTOS.get(key);
  if (!object) return c.json({ error: "Photograph file not found." }, 404);
  if (variant === "display" || variant === "video") c.executionCtx.waitUntil(recordPhotoView(c.env.DB, membership.event_id, photo.album_id, c.req.param("photoId"), c.get("user").id, null));
  return new Response(object.body, { headers: { "Content-Type": photo.content_type, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", ETag: object.httpEtag } });
});

app.patch("/api/events/:eventId/photos/:photoId", async (c) => {
  const membership = await requireMembership(c, c.req.param("eventId"), ["leader", "event_admin", "safeguarding"]);
  if (membership instanceof Response) return membership;
  const body = await safeJson<{ caption?: string }>(c.req.raw);
  const result = await c.env.DB.prepare(
    `UPDATE photos SET caption = ? WHERE id = ? AND album_id IN (SELECT id FROM photo_albums WHERE event_id = ?)`,
  ).bind(cleanText(body.caption, 300), c.req.param("photoId"), membership.event_id).run();
  if (!result.meta.changes) return c.json({ error: "Photograph not found." }, 404);
  return c.json({ ok: true });
});

app.delete("/api/events/:eventId/photos/:photoId", async (c) => {
  const membership = await requireMembership(c, c.req.param("eventId"), ["leader", "event_admin", "safeguarding"]);
  if (membership instanceof Response) return membership;
  const photo = await c.env.DB.prepare(
    `SELECT p.original_key, p.display_key, p.thumbnail_key, p.video_key FROM photos p JOIN photo_albums pa ON pa.id = p.album_id
     WHERE p.id = ? AND pa.event_id = ?`,
  ).bind(c.req.param("photoId"), membership.event_id).first<{ original_key: string; display_key: string; thumbnail_key: string; video_key: string | null }>();
  if (!photo) return c.json({ error: "Photograph not found." }, 404);
  await deleteMediaObjects(c.env.PHOTOS, [photo.original_key, photo.display_key, photo.thumbnail_key, photo.video_key]);
  await c.env.DB.prepare("DELETE FROM photos WHERE id = ?").bind(c.req.param("photoId")).run();
  await audit(c.env.DB, c.get("user").id, membership.event_id, "photo.deleted", "photo", c.req.param("photoId"));
  return c.json({ ok: true });
});

app.post("/api/events/:eventId/albums/:albumId/photos/bulk-delete", async (c) => {
  const membership = await requireMembership(c, c.req.param("eventId"), ["leader", "event_admin", "safeguarding"]);
  if (membership instanceof Response) return membership;
  const body = await safeJson<{ photoIds?: string[] }>(c.req.raw);
  const ids = Array.isArray(body.photoIds) ? [...new Set(body.photoIds.filter((id) => typeof id === "string"))].slice(0, 100) : [];
  if (!ids.length) return c.json({ error: "Select at least one photograph or video." }, 400);
  const placeholders = ids.map(() => "?").join(",");
  const photos = await c.env.DB.prepare(
    `SELECT p.id, p.original_key, p.display_key, p.thumbnail_key, p.video_key FROM photos p JOIN photo_albums pa ON pa.id = p.album_id
     WHERE p.id IN (${placeholders}) AND p.album_id = ? AND pa.event_id = ?`,
  ).bind(...ids, c.req.param("albumId"), membership.event_id).all<{ id: string; original_key: string; display_key: string; thumbnail_key: string; video_key: string | null }>();
  await deleteMediaObjects(c.env.PHOTOS, photos.results.flatMap((photo) => [photo.original_key, photo.display_key, photo.thumbnail_key, photo.video_key]));
  if (photos.results.length) {
    const found = photos.results.map((photo) => photo.id);
    await c.env.DB.prepare(`DELETE FROM photos WHERE id IN (${found.map(() => "?").join(",")})`).bind(...found).run();
    await audit(c.env.DB, c.get("user").id, membership.event_id, "photos.bulk_deleted", "photo_album", c.req.param("albumId"), { count: found.length });
  }
  return c.json({ deleted: photos.results.length });
});

app.get("/api/events/:eventId/albums/:albumId/access-report", async (c) => {
  const membership = await requireMembership(c, c.req.param("eventId"), ["leader", "event_admin", "safeguarding"]);
  if (membership instanceof Response) return membership;
  const rows = await c.env.DB.prepare(
    `SELECT COALESCE(u.display_name, pg.display_name, 'Former viewer') AS viewer_name,
            CASE WHEN pv.guest_id IS NULL THEN 'Event member' ELSE 'Photo guest' END AS viewer_type,
            COUNT(*) AS view_count, COUNT(DISTINCT pv.photo_id) AS media_count, MAX(pv.viewed_at) AS last_viewed_at
     FROM photo_views pv LEFT JOIN users u ON u.id = pv.viewer_user_id LEFT JOIN photo_guests pg ON pg.id = pv.guest_id
     WHERE pv.event_id = ? AND pv.album_id = ? GROUP BY pv.viewer_user_id, pv.guest_id ORDER BY last_viewed_at DESC`,
  ).bind(membership.event_id, c.req.param("albumId")).all();
  return c.json({ viewers: rows.results });
});

app.delete("/api/events/:eventId/albums/:albumId", async (c) => {
  const membership = await requireMembership(c, c.req.param("eventId"), ["leader", "event_admin", "safeguarding"]);
  if (membership instanceof Response) return membership;
  const album = await c.env.DB.prepare("SELECT id FROM photo_albums WHERE id = ? AND event_id = ?").bind(c.req.param("albumId"), membership.event_id).first();
  if (!album) return c.json({ error: "Album not found." }, 404);
  const photos = await c.env.DB.prepare("SELECT original_key, display_key, thumbnail_key, video_key FROM photos WHERE album_id = ?")
    .bind(c.req.param("albumId")).all<{ original_key: string; display_key: string; thumbnail_key: string; video_key: string | null }>();
  await deleteMediaObjects(c.env.PHOTOS, photos.results.flatMap((photo) => [photo.original_key, photo.display_key, photo.thumbnail_key, photo.video_key]));
  await c.env.DB.prepare("DELETE FROM photo_albums WHERE id = ?").bind(c.req.param("albumId")).run();
  await audit(c.env.DB, c.get("user").id, membership.event_id, "photo_album.deleted", "photo_album", c.req.param("albumId"));
  return c.json({ ok: true });
});

app.post("/api/events/:eventId/announcements", async (c) => {
  const membership = await requireCapability(c, c.req.param("eventId"), "can_post_announcements");
  if (membership instanceof Response) return membership;
  const body = await safeJson<{ title?: string; body?: string; importance?: string; acknowledgementRequired?: boolean }>(c.req.raw);
  const title = cleanText(body.title, 120);
  const message = cleanText(body.body, 5_000);
  if (!title || !message) return c.json({ error: "A title and message are required." }, 400);
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO announcements (id, event_id, author_id, title, body, importance, acknowledgement_required)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, membership.event_id, c.get("user").id, title, message, body.importance === "important" ? "important" : "normal", body.acknowledgementRequired ? 1 : 0)
    .run();
  await audit(c.env.DB, c.get("user").id, membership.event_id, "announcement.created", "announcement", id);
  c.executionCtx.waitUntil(sendEventPush(c.env, membership.event_id, c.get("user").id, {
    title: title, body: "A new CampComms announcement is available.", url: `/?tab=home&announcement=${id}`, tag: `announcement-${id}`,
  }));
  if (body.importance === "important") {
    c.executionCtx.waitUntil(sendImportantAnnouncementEmails(c.env, membership.event_id, c.get("user").id, id, title));
  }
  return c.json({ id }, 201);
});

app.patch("/api/events/:eventId/announcements/:announcementId", async (c) => {
  const membership = await requireCapability(c, c.req.param("eventId"), "can_post_announcements");
  if (membership instanceof Response) return membership;
  const body = await safeJson<{ title?: string; body?: string; importance?: string; acknowledgementRequired?: boolean }>(c.req.raw);
  const title = cleanText(body.title, 120);
  const message = cleanText(body.body, 5_000);
  if (!title || !message) return c.json({ error: "A title and message are required." }, 400);
  const result = await c.env.DB.prepare(
    "UPDATE announcements SET title = ?, body = ?, importance = ?, acknowledgement_required = ?, edited_at = CURRENT_TIMESTAMP WHERE id = ? AND event_id = ?",
  ).bind(title, message, body.importance === "important" ? "important" : "normal", body.acknowledgementRequired ? 1 : 0, c.req.param("announcementId"), membership.event_id).run();
  if (!result.meta.changes) return c.json({ error: "Announcement not found." }, 404);
  await audit(c.env.DB, c.get("user").id, membership.event_id, "announcement.updated", "announcement", c.req.param("announcementId"));
  return c.json({ ok: true });
});

app.delete("/api/events/:eventId/announcements/:announcementId", async (c) => {
  const membership = await requireCapability(c, c.req.param("eventId"), "can_post_announcements");
  if (membership instanceof Response) return membership;
  const result = await c.env.DB.prepare("DELETE FROM announcements WHERE id = ? AND event_id = ?")
    .bind(c.req.param("announcementId"), membership.event_id).run();
  if (!result.meta.changes) return c.json({ error: "Announcement not found." }, 404);
  await audit(c.env.DB, c.get("user").id, membership.event_id, "announcement.deleted", "announcement", c.req.param("announcementId"));
  return c.json({ ok: true });
});

app.get("/api/events/:eventId/announcements/:announcementId/acknowledgements", async (c) => {
  const membership = await requireCapability(c, c.req.param("eventId"), "can_post_announcements");
  if (membership instanceof Response) return membership;
  const announcement = await c.env.DB.prepare("SELECT id, title, acknowledgement_required FROM announcements WHERE id = ? AND event_id = ?")
    .bind(c.req.param("announcementId"), membership.event_id).first();
  if (!announcement) return c.json({ error: "Announcement not found." }, 404);
  const people = await c.env.DB.prepare(
    `SELECT u.id, u.display_name, u.parent_of, aa.acknowledged_at
     FROM event_memberships em JOIN users u ON u.id = em.user_id
     LEFT JOIN announcement_acknowledgements aa ON aa.announcement_id = ? AND aa.user_id = u.id
     WHERE em.event_id = ? AND em.role = 'parent' AND (em.access_ends_at IS NULL OR em.access_ends_at > datetime('now'))
     ORDER BY aa.acknowledged_at IS NULL, u.display_name`,
  ).bind(c.req.param("announcementId"), membership.event_id).all();
  return c.json({ announcement, people: people.results });
});

app.post("/api/events/:eventId/announcements/:announcementId/acknowledge", async (c) => {
  const membership = await requireMembership(c, c.req.param("eventId"));
  if (membership instanceof Response) return membership;
  const announcementId = c.req.param("announcementId");
  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO announcement_acknowledgements (announcement_id, user_id)
     SELECT id, ? FROM announcements WHERE id = ? AND event_id = ?`,
  )
    .bind(c.get("user").id, announcementId, membership.event_id)
    .run();
  return c.json({ ok: true });
});

app.post("/api/events/:eventId/topics", async (c) => {
  const body = await safeJson<{ title?: string; body?: string; category?: string; audience?: string; kind?: string }>(c.req.raw);
  const kind = body.kind === "lost" || body.kind === "found" ? body.kind : "discussion";
  const membership = await requireWritableEvent(c, c.req.param("eventId"), kind === "discussion" ? "standard" : "lost_found");
  if (membership instanceof Response) return membership;
  const title = cleanText(body.title, 120);
  const message = cleanText(body.body, 3_000);
  if (!title || !message) return c.json({ error: "A title and opening message are required." }, 400);
  const topicId = crypto.randomUUID();
  const postId = crypto.randomUUID();
  const category = ["general", "kit", "travel", "food", "programme"].includes(body.category ?? "") ? body.category : "general";
  const audience = kind === "discussion" && body.audience === "leaders" && canAccessLeaderDiscussions(membership.role) ? "leaders" : "everyone";
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO topics (id, event_id, created_by, title, category, audience, kind) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(topicId, membership.event_id, c.get("user").id, title, category, audience, kind),
    c.env.DB.prepare("INSERT INTO posts (id, topic_id, author_id, body) VALUES (?, ?, ?, ?)").bind(postId, topicId, c.get("user").id, message),
  ]);
  await audit(c.env.DB, c.get("user").id, membership.event_id, kind === "discussion" ? "topic.created" : `lost_found.${kind}_created`, "topic", topicId);
  return c.json({ id: topicId }, 201);
});

app.get("/api/events/:eventId/topics/:topicId", async (c) => {
  const membership = await requireMembership(c, c.req.param("eventId"));
  if (membership instanceof Response) return membership;
  const topic = await c.env.DB.prepare("SELECT * FROM topics WHERE id = ? AND event_id = ? AND (audience = 'everyone' OR ? = 1)").bind(c.req.param("topicId"), membership.event_id, canAccessLeaderDiscussions(membership.role) ? 1 : 0).first();
  if (!topic) return c.json({ error: "Topic not found." }, 404);
  const posts = await c.env.DB.prepare(
    `SELECT p.id, p.body, p.created_at, p.edited_at, u.display_name AS author_name, u.parent_of AS author_parent_of, u.id AS author_id, em.role AS author_role
     FROM posts p JOIN users u ON u.id = p.author_id JOIN topics t ON t.id = p.topic_id JOIN event_memberships em ON em.event_id = t.event_id AND em.user_id = p.author_id
     WHERE p.topic_id = ? AND p.deleted_at IS NULL ORDER BY p.created_at`,
  ).bind(c.req.param("topicId")).all();
  await markRead(c.env.DB, c.get("user").id, "topic", c.req.param("topicId"));
  return c.json({ topic, posts: posts.results });
});

app.post("/api/events/:eventId/topics/:topicId/posts", async (c) => {
  const membership = await requireMembership(c, c.req.param("eventId"));
  if (membership instanceof Response) return membership;
  const topic = await c.env.DB.prepare("SELECT id, is_locked, audience, kind FROM topics WHERE id = ? AND event_id = ? AND (audience = 'everyone' OR ? = 1)").bind(c.req.param("topicId"), membership.event_id, canAccessLeaderDiscussions(membership.role) ? 1 : 0).first<{ id: string; is_locked: number; audience: string; kind: string }>();
  if (!topic) return c.json({ error: "Topic not found." }, 404);
  if (topic.is_locked) return c.json({ error: "This topic is closed." }, 409);
  const event = await c.env.DB.prepare("SELECT status, posting_closes_at, read_only_until FROM events WHERE id = ?")
    .bind(membership.event_id).first<EventWriteWindow>();
  const feature = topic.kind === "lost" || topic.kind === "found" ? "lost_found" : "standard";
  if (!event || !canWriteEventFeature(event, feature)) {
    return c.json({ error: feature === "lost_found" ? "Lost & Found updates have now closed." : "This event is now read-only." }, 409);
  }
  const body = await safeJson<{ body?: string }>(c.req.raw);
  const message = cleanText(body.body, 3_000);
  if (!message) return c.json({ error: "Please enter a reply." }, 400);
  const id = crypto.randomUUID();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO posts (id, topic_id, author_id, body) VALUES (?, ?, ?, ?)").bind(id, topic.id, c.get("user").id, message),
    c.env.DB.prepare("UPDATE topics SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(topic.id),
  ]);
  await audit(c.env.DB, c.get("user").id, membership.event_id, "topic.replied", "topic", topic.id);
  const isLostFound = topic.kind === "lost" || topic.kind === "found";
  c.executionCtx.waitUntil(sendEventPush(c.env, membership.event_id, c.get("user").id, {
    title: isLostFound ? "New Lost & Found reply" : "New discussion reply", body: isLostFound ? "A Lost & Found item has a new reply." : "A discussion in CampComms has a new reply.", url: `/?tab=${isLostFound ? "lost-found" : "discuss"}&topic=${topic.id}`, tag: `topic-${topic.id}`,
  }, topic.audience === "leaders" ? ["young_leader", "leader", "event_admin", "safeguarding"] : undefined));
  return c.json({ id }, 201);
});

app.patch("/api/events/:eventId/topics/:topicId", async (c) => {
  const membership = await requireMembership(c, c.req.param("eventId"));
  if (membership instanceof Response) return membership;
  const topic = await c.env.DB.prepare("SELECT id, created_by, kind FROM topics WHERE id = ? AND event_id = ?")
    .bind(c.req.param("topicId"), membership.event_id).first<{ id: string; created_by: string; kind: string }>();
  if (!topic) return c.json({ error: "Topic not found." }, 404);
  const mayLock = canManageTopicLock(membership.role, topic.kind, topic.created_by, c.get("user").id);
  if (!mayLock) return c.json({ error: "You do not have permission to change this topic." }, 403);
  const body = await safeJson<{ locked?: boolean }>(c.req.raw);
  if (typeof body.locked !== "boolean") return c.json({ error: "Choose whether the discussion is open or locked." }, 400);
  const result = await c.env.DB.prepare("UPDATE topics SET is_locked = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND event_id = ?")
    .bind(body.locked ? 1 : 0, c.req.param("topicId"), membership.event_id).run();
  if (!result.meta.changes) return c.json({ error: "Topic not found." }, 404);
  await audit(c.env.DB, c.get("user").id, membership.event_id, topic.kind === "discussion" ? (body.locked ? "topic.locked" : "topic.unlocked") : (body.locked ? "lost_found.resolved" : "lost_found.reopened"), "topic", c.req.param("topicId"));
  return c.json({ ok: true });
});

app.delete("/api/events/:eventId/topics/:topicId", async (c) => {
  const membership = await requireMembership(c, c.req.param("eventId"), ["event_admin"]);
  if (membership instanceof Response) return membership;
  const result = await c.env.DB.prepare("DELETE FROM topics WHERE id = ? AND event_id = ?").bind(c.req.param("topicId"), membership.event_id).run();
  if (!result.meta.changes) return c.json({ error: "Topic not found." }, 404);
  await audit(c.env.DB, c.get("user").id, membership.event_id, "topic.deleted", "topic", c.req.param("topicId"));
  return c.json({ ok: true });
});

app.delete("/api/events/:eventId/topics/:topicId/posts/:postId", async (c) => {
  const membership = await requireMembership(c, c.req.param("eventId"));
  if (membership instanceof Response) return membership;
  const post = await c.env.DB.prepare("SELECT p.id, p.author_id FROM posts p JOIN topics t ON t.id = p.topic_id WHERE p.id = ? AND p.topic_id = ? AND t.event_id = ? AND p.deleted_at IS NULL")
    .bind(c.req.param("postId"), c.req.param("topicId"), membership.event_id).first<{ id: string; author_id: string }>();
  if (!post) return c.json({ error: "Reply not found." }, 404);
  if (post.author_id !== c.get("user").id && !isLeader(membership.role)) return c.json({ error: "You cannot remove this reply." }, 403);
  await c.env.DB.prepare("UPDATE posts SET deleted_at = CURRENT_TIMESTAMP, body = '[removed]' WHERE id = ?").bind(post.id).run();
  await audit(c.env.DB, c.get("user").id, membership.event_id, "topic.reply_removed", "post", post.id);
  return c.json({ ok: true });
});

app.use("/api/events/:eventId/private-threads", blockYoungLeader);
app.use("/api/events/:eventId/private-threads/*", blockYoungLeader);

app.post("/api/events/:eventId/private-threads", async (c) => {
  const membership = await requireOpenEvent(c, c.req.param("eventId"));
  if (membership instanceof Response) return membership;
  const body = await safeJson<{ subject?: string; body?: string }>(c.req.raw);
  const subject = cleanText(body.subject, 120);
  const message = cleanText(body.body, 5_000);
  if (!subject || !message) return c.json({ error: "A subject and message are required." }, 400);
  const threadId = crypto.randomUUID();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO private_threads (id, event_id, opened_by, subject) VALUES (?, ?, ?, ?)").bind(threadId, membership.event_id, c.get("user").id, subject),
    c.env.DB.prepare("INSERT INTO private_messages (id, thread_id, author_id, body) VALUES (?, ?, ?, ?)").bind(crypto.randomUUID(), threadId, c.get("user").id, message),
  ]);
  await audit(c.env.DB, c.get("user").id, membership.event_id, "private_thread.opened", "private_thread", threadId);
  c.executionCtx.waitUntil(sendEventCapabilityPush(c.env, membership.event_id, c.get("user").id, "can_view_private", {
    title: "New private message", body: "A parent has opened a private event conversation.", url: `/?tab=private&thread=${threadId}`, tag: `private-${threadId}`,
  }));
  return c.json({ id: threadId }, 201);
});

app.get("/api/events/:eventId/private-threads", async (c) => {
  const membership = await requireMembership(c, c.req.param("eventId"));
  if (membership instanceof Response) return membership;
  const privileged = hasCapability(membership, "can_view_private");
  const threads = await c.env.DB.prepare(
    `SELECT pt.*, u.display_name AS opened_by_name, u.parent_of AS opened_by_parent_of, em.role AS opened_by_role,
            (SELECT COUNT(*) FROM private_messages pm WHERE pm.thread_id = pt.id) AS message_count,
            EXISTS(SELECT 1 FROM private_messages pm WHERE pm.thread_id = pt.id AND pm.author_id != ?
              AND pm.created_at > COALESCE((SELECT cr.last_read_at FROM content_reads cr WHERE cr.user_id = ? AND cr.resource_type = 'private_thread' AND cr.resource_id = pt.id), '1970-01-01')) AS unread
     FROM private_threads pt JOIN users u ON u.id = pt.opened_by JOIN event_memberships em ON em.event_id = pt.event_id AND em.user_id = pt.opened_by
     WHERE pt.event_id = ? AND (? = 1 OR pt.opened_by = ?) ORDER BY pt.updated_at DESC`,
  ).bind(c.get("user").id, c.get("user").id, membership.event_id, privileged ? 1 : 0, c.get("user").id).all();
  return c.json({ threads: threads.results });
});

app.get("/api/events/:eventId/private-threads/:threadId", async (c) => {
  const access = await requireThreadAccess(c, c.req.param("eventId"), c.req.param("threadId"));
  if (access instanceof Response) return access;
  const messages = await c.env.DB.prepare(
    `SELECT pm.id, pm.body, pm.created_at, u.display_name AS author_name, u.parent_of AS author_parent_of, u.id AS author_id, em.role AS author_role
     FROM private_messages pm JOIN users u ON u.id = pm.author_id JOIN private_threads pt ON pt.id = pm.thread_id JOIN event_memberships em ON em.event_id = pt.event_id AND em.user_id = pm.author_id
     WHERE pm.thread_id = ? ORDER BY pm.created_at`,
  ).bind(access.thread.id).all();
  await markRead(c.env.DB, c.get("user").id, "private_thread", access.thread.id);
  return c.json({ thread: access.thread, messages: messages.results });
});

app.post("/api/events/:eventId/private-threads/:threadId/messages", async (c) => {
  const access = await requireThreadAccess(c, c.req.param("eventId"), c.req.param("threadId"));
  if (access instanceof Response) return access;
  if (access.thread.status === "closed") return c.json({ error: "This private conversation is closed." }, 409);
  if (access.thread.opened_by !== c.get("user").id && !hasCapability(access.membership, "can_reply_private")) return c.json({ error: "You do not have permission to reply to private messages." }, 403);
  const body = await safeJson<{ body?: string }>(c.req.raw);
  const message = cleanText(body.body, 5_000);
  if (!message) return c.json({ error: "Please enter a message." }, 400);
  const id = crypto.randomUUID();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO private_messages (id, thread_id, author_id, body) VALUES (?, ?, ?, ?)").bind(id, access.thread.id, c.get("user").id, message),
    c.env.DB.prepare("UPDATE private_threads SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(access.thread.id),
  ]);
  const recipients = access.thread.opened_by === c.get("user").id
    ? await eventUserIdsWithCapability(c.env.DB, access.membership.event_id, c.get("user").id, "can_view_private")
    : [access.thread.opened_by];
  c.executionCtx.waitUntil(sendPushToUsers(c.env, recipients, {
    title: "Private conversation updated", body: "There is a new reply in a private event conversation.", url: `/?tab=private&thread=${access.thread.id}`, tag: `private-${access.thread.id}`,
  }));
  return c.json({ id }, 201);
});

app.patch("/api/events/:eventId/private-threads/:threadId", async (c) => {
  const access = await requireThreadAccess(c, c.req.param("eventId"), c.req.param("threadId"));
  if (access instanceof Response) return access;
  if (!hasCapability(access.membership, "can_reply_private")) return c.json({ error: "You do not have permission to close or reopen private messages." }, 403);
  const body = await safeJson<{ status?: string }>(c.req.raw);
  if (!body.status || !["open", "closed"].includes(body.status)) return c.json({ error: "Choose a valid conversation status." }, 400);
  await c.env.DB.prepare("UPDATE private_threads SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(body.status, access.thread.id).run();
  await audit(c.env.DB, c.get("user").id, access.membership.event_id, `private_thread.${body.status}`, "private_thread", access.thread.id);
  return c.json({ ok: true });
});

app.delete("/api/events/:eventId/private-threads/:threadId", async (c) => {
  const membership = await requireMembership(c, c.req.param("eventId"), ["event_admin"]);
  if (membership instanceof Response) return membership;
  const result = await c.env.DB.prepare("DELETE FROM private_threads WHERE id = ? AND event_id = ?").bind(c.req.param("threadId"), membership.event_id).run();
  if (!result.meta.changes) return c.json({ error: "Private conversation not found." }, 404);
  await audit(c.env.DB, c.get("user").id, membership.event_id, "private_thread.deleted", "private_thread", c.req.param("threadId"));
  return c.json({ ok: true });
});

app.use("/api/events/:eventId/lifts", blockYoungLeader);
app.use("/api/events/:eventId/lifts/*", blockYoungLeader);

app.post("/api/events/:eventId/lifts", async (c) => {
  const membership = await requireOpenEvent(c, c.req.param("eventId"));
  if (membership instanceof Response) return membership;
  const body = await safeJson<{ kind?: string; journey?: string; area?: string; seats?: number; journeyAt?: string; note?: string }>(c.req.raw);
  if (!["offer", "request"].includes(body.kind ?? "") || !["outbound", "return"].includes(body.journey ?? "")) return c.json({ error: "Choose whether you are offering or requesting a lift." }, 400);
  const area = cleanText(body.area, 100);
  const seats = Number(body.seats);
  const journeyAt = validFutureDate(body.journeyAt);
  if (!area || !Number.isInteger(seats) || seats < 1 || seats > 8 || !journeyAt) return c.json({ error: "Check the area, number of seats and journey time." }, 400);
  const id = crypto.randomUUID();
  const expiresAt = new Date(new Date(journeyAt).getTime() + 2 * 60 * 60_000).toISOString();
  await c.env.DB.prepare(
    `INSERT INTO lift_posts (id, event_id, author_id, kind, journey, area, seats, journey_at, note, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, membership.event_id, c.get("user").id, body.kind, body.journey, area, seats, journeyAt, cleanText(body.note, 500), expiresAt).run();
  await audit(c.env.DB, c.get("user").id, membership.event_id, "lift.created", "lift_post", id);
  return c.json({ id }, 201);
});

app.post("/api/events/:eventId/lifts/:liftId/responses", async (c) => {
  const membership = await requireOpenEvent(c, c.req.param("eventId"));
  if (membership instanceof Response) return membership;
  const lift = await c.env.DB.prepare("SELECT id, author_id FROM lift_posts WHERE id = ? AND event_id = ? AND status = 'open'").bind(c.req.param("liftId"), membership.event_id).first<{ id: string; author_id: string }>();
  if (!lift) return c.json({ error: "This lift post is no longer available." }, 404);
  const body = await safeJson<{ body?: string }>(c.req.raw);
  const message = cleanText(body.body, 1_000);
  if (!message) return c.json({ error: "Please enter a response." }, 400);
  await c.env.DB.prepare("INSERT INTO lift_responses (id, lift_post_id, author_id, body) VALUES (?, ?, ?, ?)")
    .bind(crypto.randomUUID(), c.req.param("liftId"), c.get("user").id, message).run();
  await audit(c.env.DB, c.get("user").id, membership.event_id, "lift.responded", "lift_post", lift.id);
  if (lift.author_id !== c.get("user").id) c.executionCtx.waitUntil(sendPushToUsers(c.env, [lift.author_id], {
    title: "New lift-share response", body: "Someone has responded to your lift-share post.", url: `/?tab=lifts&lift=${lift.id}`, tag: `lift-${lift.id}`,
  }));
  return c.json({ ok: true }, 201);
});

app.get("/api/events/:eventId/lifts/:liftId", async (c) => {
  const membership = await requireMembership(c, c.req.param("eventId"));
  if (membership instanceof Response) return membership;
  const lift = await c.env.DB.prepare("SELECT l.*, u.display_name AS author_name, u.parent_of AS author_parent_of, em.role AS author_role FROM lift_posts l JOIN users u ON u.id = l.author_id JOIN event_memberships em ON em.event_id = l.event_id AND em.user_id = l.author_id WHERE l.id = ? AND l.event_id = ?")
    .bind(c.req.param("liftId"), membership.event_id).first();
  if (!lift) return c.json({ error: "Lift post not found." }, 404);
  const responses = await c.env.DB.prepare("SELECT lr.id, lr.body, lr.created_at, lr.author_id, u.display_name AS author_name, u.parent_of AS author_parent_of, em.role AS author_role FROM lift_responses lr JOIN users u ON u.id = lr.author_id JOIN lift_posts lp ON lp.id = lr.lift_post_id JOIN event_memberships em ON em.event_id = lp.event_id AND em.user_id = lr.author_id WHERE lr.lift_post_id = ? ORDER BY lr.created_at")
    .bind(c.req.param("liftId")).all();
  await markRead(c.env.DB, c.get("user").id, "lift", c.req.param("liftId"));
  return c.json({ lift, responses: responses.results });
});

app.patch("/api/events/:eventId/lifts/:liftId", async (c) => {
  const membership = await requireMembership(c, c.req.param("eventId"));
  if (membership instanceof Response) return membership;
  const lift = await c.env.DB.prepare("SELECT id, author_id FROM lift_posts WHERE id = ? AND event_id = ?").bind(c.req.param("liftId"), membership.event_id).first<{ id: string; author_id: string }>();
  if (!lift) return c.json({ error: "Lift post not found." }, 404);
  if (lift.author_id !== c.get("user").id && !isLeader(membership.role)) return c.json({ error: "You cannot change this lift post." }, 403);
  const body = await safeJson<{ status?: string }>(c.req.raw);
  if (!body.status || !["open", "matched", "withdrawn"].includes(body.status)) return c.json({ error: "Choose a valid lift status." }, 400);
  await c.env.DB.prepare("UPDATE lift_posts SET status = ? WHERE id = ?").bind(body.status, lift.id).run();
  await audit(c.env.DB, c.get("user").id, membership.event_id, `lift.${body.status}`, "lift_post", lift.id);
  return c.json({ ok: true });
});

app.delete("/api/events/:eventId/lifts/:liftId", async (c) => {
  const membership = await requireMembership(c, c.req.param("eventId"), ["event_admin"]);
  if (membership instanceof Response) return membership;
  const result = await c.env.DB.prepare("DELETE FROM lift_posts WHERE id = ? AND event_id = ?").bind(c.req.param("liftId"), membership.event_id).run();
  if (!result.meta.changes) return c.json({ error: "Lift post not found." }, 404);
  await audit(c.env.DB, c.get("user").id, membership.event_id, "lift.deleted", "lift_post", c.req.param("liftId"));
  return c.json({ ok: true });
});

app.get("/api/admin/events/:eventId", async (c) => {
  const membership = await requireMembership(c, c.req.param("eventId"), ["event_admin"]);
  if (membership instanceof Response) return membership;
  const [event, members] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM events WHERE id = ?").bind(membership.event_id).first(),
    c.env.DB.prepare(
      `SELECT u.id, u.email, u.display_name, u.parent_of, u.status, em.role, em.joined_at, em.access_ends_at,
              em.can_view_private, em.can_reply_private, em.can_post_announcements,
              (SELECT ed.status FROM email_deliveries ed WHERE ed.user_id = u.id ORDER BY ed.created_at DESC LIMIT 1) AS last_email_status,
              (SELECT ed.created_at FROM email_deliveries ed WHERE ed.user_id = u.id ORDER BY ed.created_at DESC LIMIT 1) AS last_email_at,
              (SELECT ei.status FROM event_invitations ei WHERE ei.event_id = em.event_id AND ei.user_id = u.id ORDER BY ei.created_at DESC LIMIT 1) AS invitation_status,
              (SELECT ei.created_at FROM event_invitations ei WHERE ei.event_id = em.event_id AND ei.user_id = u.id ORDER BY ei.created_at DESC LIMIT 1) AS invited_at
       FROM event_memberships em JOIN users u ON u.id = em.user_id
       WHERE em.event_id = ? ORDER BY CASE em.role WHEN 'event_admin' THEN 0 WHEN 'safeguarding' THEN 1 WHEN 'leader' THEN 2 ELSE 3 END, u.display_name`,
    ).bind(membership.event_id).all(),
  ]);
  const [emailPreferences, pushDevices, recentDeliveries] = await Promise.all([
    c.env.DB.prepare(
      `SELECT
        SUM(CASE WHEN u.email_notification_preference = 'daily' THEN 1 ELSE 0 END) AS daily,
        SUM(CASE WHEN u.email_notification_preference = 'important_only' THEN 1 ELSE 0 END) AS important_only,
        SUM(CASE WHEN u.email_notification_preference = 'none' THEN 1 ELSE 0 END) AS none
       FROM event_memberships em JOIN users u ON u.id = em.user_id WHERE em.event_id = ? AND em.role = 'parent'`,
    ).bind(membership.event_id).first(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS count FROM push_subscriptions ps JOIN event_memberships em ON em.user_id = ps.user_id WHERE em.event_id = ?`,
    ).bind(membership.event_id).first<{ count: number }>(),
    c.env.DB.prepare(
      `SELECT
        SUM(CASE WHEN ed.status IN ('delivered', 'sent') THEN 1 ELSE 0 END) AS successful,
        SUM(CASE WHEN ed.status LIKE 'failed%' OR ed.status IN ('bounced', 'complained') THEN 1 ELSE 0 END) AS failed,
        MAX(ed.updated_at) AS last_update
       FROM email_deliveries ed JOIN event_memberships em ON em.user_id = ed.user_id
       WHERE em.event_id = ? AND (ed.event_id = ? OR (ed.event_id IS NULL AND ed.purpose = 'daily_digest'))
         AND ed.created_at > datetime('now', '-30 days')`,
    ).bind(membership.event_id, membership.event_id).first(),
  ]);
  return c.json({ event, members: members.results, operations: { emailPreferences, pushDevices: pushDevices?.count ?? 0, recentDeliveries } });
});

app.post("/api/admin/events", async (c) => {
  const authorised = await requireAnyEventAdmin(c);
  if (authorised instanceof Response) return authorised;
  const input = await readEventInput(c);
  if (input instanceof Response) return input;
  const duplicate = await c.env.DB.prepare("SELECT id FROM events WHERE slug = ?").bind(input.slug).first();
  if (duplicate) return c.json({ error: "That short event address is already in use." }, 409);
  const id = crypto.randomUUID();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO events (id, slug, name, summary, location, section, starts_at, ends_at, posting_closes_at, read_only_until, purge_after, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, input.slug, input.name, input.summary, input.location, input.section, input.startsAt, input.endsAt, input.postingClosesAt, input.readOnlyUntil, input.purgeAfter, input.status),
    c.env.DB.prepare("INSERT INTO event_memberships (event_id, user_id, role, can_view_private, can_reply_private, can_post_announcements) VALUES (?, ?, 'event_admin', 1, 1, 1)").bind(id, c.get("user").id),
  ]);
  await audit(c.env.DB, c.get("user").id, id, "event.created", "event", id);
  return c.json({ id }, 201);
});

app.patch("/api/admin/events/:eventId", async (c) => {
  const membership = await requireMembership(c, c.req.param("eventId"), ["event_admin"]);
  if (membership instanceof Response) return membership;
  const input = await readEventInput(c);
  if (input instanceof Response) return input;
  const duplicate = await c.env.DB.prepare("SELECT id FROM events WHERE slug = ? AND id != ?").bind(input.slug, membership.event_id).first();
  if (duplicate) return c.json({ error: "That short event address is already in use." }, 409);
  await c.env.DB.prepare(
    `UPDATE events SET slug = ?, name = ?, summary = ?, location = ?, section = ?, starts_at = ?, ends_at = ?, posting_closes_at = ?,
       read_only_until = ?, purge_after = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
  ).bind(input.slug, input.name, input.summary, input.location, input.section, input.startsAt, input.endsAt, input.postingClosesAt, input.readOnlyUntil, input.purgeAfter, input.status, membership.event_id).run();
  await audit(c.env.DB, c.get("user").id, membership.event_id, "event.updated", "event", membership.event_id);
  return c.json({ ok: true });
});

app.post("/api/admin/events/:eventId/invitations", async (c) => {
  const membership = await requireMembership(c, c.req.param("eventId"), ["event_admin"]);
  if (membership instanceof Response) return membership;
  const body = await safeJson<{ email?: string; displayName?: string; role?: string }>(c.req.raw);
  const result = await inviteMember(c, membership.event_id, body);
  if (result instanceof Response) return result;
  return c.json(result, 201);
});

app.post("/api/admin/events/:eventId/bulk-invitations", async (c) => {
  const membership = await requireMembership(c, c.req.param("eventId"), ["event_admin"]);
  if (membership instanceof Response) return membership;
  const body = await safeJson<{ invitations?: Array<{ email?: string; displayName?: string; role?: string }> }>(c.req.raw);
  if (!Array.isArray(body.invitations) || body.invitations.length < 1 || body.invitations.length > 40) {
    return c.json({ error: "Provide between 1 and 40 invitations." }, 400);
  }
  const invalid = body.invitations.some((invitation) => !normaliseEmail(invitation.email) || !cleanText(invitation.displayName, 120));
  const uniqueEmails = new Set(body.invitations.map((invitation) => normaliseEmail(invitation.email))).size;
  if (invalid || uniqueEmails !== body.invitations.length) return c.json({ error: "Check every name and email address, and remove duplicates." }, 400);
  const results = [];
  for (const invitation of body.invitations) {
    const result = await inviteMember(c, membership.event_id, invitation);
    if (result instanceof Response) return result;
    results.push(result);
  }
  return c.json({ invitations: results }, 201);
});

app.patch("/api/admin/events/:eventId/members/:userId", async (c) => {
  const membership = await requireMembership(c, c.req.param("eventId"), ["event_admin"]);
  if (membership instanceof Response) return membership;
  const body = await safeJson<{ role?: string; accessEndsAt?: string | null; canViewPrivate?: boolean; canReplyPrivate?: boolean; canPostAnnouncements?: boolean }>(c.req.raw);
  const role = ["parent", "young_leader", "leader", "event_admin", "safeguarding"].includes(body.role ?? "") ? body.role! : null;
  if (!role) return c.json({ error: "Choose a valid event role." }, 400);
  if (c.req.param("userId") === c.get("user").id && role !== "event_admin") return c.json({ error: "You cannot remove your own administrator access." }, 409);
  const accessEndsAt = body.accessEndsAt ? validDate(body.accessEndsAt) : null;
  if (body.accessEndsAt && !accessEndsAt) return c.json({ error: "Choose a valid access end date." }, 400);
  const restricted = role === "parent" || role === "young_leader";
  const canViewPrivate = role === "event_admin" || role === "safeguarding" ? 1 : restricted ? 0 : body.canViewPrivate ? 1 : 0;
  const canReplyPrivate = role === "event_admin" || role === "safeguarding" ? 1 : restricted ? 0 : body.canReplyPrivate && canViewPrivate ? 1 : 0;
  const canPostAnnouncements = role === "event_admin" ? 1 : restricted ? 0 : body.canPostAnnouncements ? 1 : 0;
  const result = await c.env.DB.prepare("UPDATE event_memberships SET role = ?, access_ends_at = ?, can_view_private = ?, can_reply_private = ?, can_post_announcements = ? WHERE event_id = ? AND user_id = ?")
    .bind(role, accessEndsAt, canViewPrivate, canReplyPrivate, canPostAnnouncements, membership.event_id, c.req.param("userId")).run();
  if (!result.meta.changes) return c.json({ error: "Event member not found." }, 404);
  await audit(c.env.DB, c.get("user").id, membership.event_id, "membership.updated", "user", c.req.param("userId"), { role, accessEndsAt, canViewPrivate, canReplyPrivate, canPostAnnouncements });
  return c.json({ ok: true });
});

app.delete("/api/admin/events/:eventId/members/:userId", async (c) => {
  const membership = await requireMembership(c, c.req.param("eventId"), ["event_admin"]);
  if (membership instanceof Response) return membership;
  const userId = c.req.param("userId");
  if (userId === c.get("user").id) return c.json({ error: "You cannot remove your own administrator access." }, 409);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM event_memberships WHERE event_id = ? AND user_id = ?").bind(membership.event_id, userId),
    c.env.DB.prepare("UPDATE event_invitations SET status = 'revoked' WHERE event_id = ? AND user_id = ? AND status IN ('sent', 'delivered')").bind(membership.event_id, userId),
  ]);
  await audit(c.env.DB, c.get("user").id, membership.event_id, "membership.removed", "user", userId);
  return c.json({ ok: true });
});

app.post("/api/resend/webhook", async (c) => {
  const rawBody = await c.req.text();
  if (!await validResendWebhook(c.env.RESEND_WEBHOOK_SECRET, c.req.raw.headers, rawBody)) {
    return c.json({ error: "Invalid webhook signature." }, 401);
  }
  let payload: { type?: string; data?: { email_id?: string } } = {};
  try { payload = JSON.parse(rawBody) as typeof payload; } catch { return c.json({ error: "Invalid payload." }, 400); }
  if (!payload.type || !payload.data?.email_id) return c.json({ ok: true });
  await c.env.DB.prepare("UPDATE email_deliveries SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE provider_id = ?")
    .bind(payload.type.replace("email.", ""), payload.data.email_id).run();
  await c.env.DB.prepare("UPDATE event_invitations SET status = ? WHERE provider_id = ? AND status != 'accepted'")
    .bind(payload.type === "email.delivered" ? "delivered" : payload.type === "email.bounced" || payload.type === "email.complained" ? "failed" : "sent", payload.data.email_id).run();
  return c.json({ ok: true });
});

async function inviteMember(
  c: AppContext,
  eventId: string,
  input: { email?: string; displayName?: string; role?: string },
) {
  const email = normaliseEmail(input.email);
  const requestedName = cleanText(input.displayName, 120);
  const role = ["parent", "young_leader", "leader", "event_admin", "safeguarding"].includes(input.role ?? "") ? input.role! : "parent";
  if (!email || !requestedName) return c.json({ error: "A valid email address and display name are required." }, 400);

  const existing = await c.env.DB.prepare("SELECT id, display_name FROM users WHERE email = ? COLLATE NOCASE")
    .bind(email).first<{ id: string; display_name: string }>();
  const userId = existing?.id ?? crypto.randomUUID();
  const displayName = existing?.display_name ?? requestedName;
  const statements = [];
  if (!existing) {
    statements.push(c.env.DB.prepare("INSERT INTO users (id, email, display_name, status) VALUES (?, ?, ?, 'invited')").bind(userId, email, displayName));
  }
  const defaultViewPrivate = role === "event_admin" || role === "safeguarding" ? 1 : 0;
  const defaultReplyPrivate = defaultViewPrivate;
  const defaultPostAnnouncements = role === "event_admin" ? 1 : 0;
  statements.push(c.env.DB.prepare(
    `INSERT INTO event_memberships (event_id, user_id, role, can_view_private, can_reply_private, can_post_announcements) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_id, user_id) DO UPDATE SET role = excluded.role, access_ends_at = NULL,
       can_view_private = excluded.can_view_private, can_reply_private = excluded.can_reply_private, can_post_announcements = excluded.can_post_announcements`,
  ).bind(eventId, userId, role, defaultViewPrivate, defaultReplyPrivate, defaultPostAnnouncements));
  await c.env.DB.batch(statements);

  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + 48 * 60 * 60_000).toISOString();
  await c.env.DB.prepare(
    "INSERT INTO magic_links (id, user_id, token_hash, redirect_path, expires_at) VALUES (?, ?, ?, '/', ?)",
  ).bind(crypto.randomUUID(), userId, await sha256(token), expiresAt).run();
  const delivery = await sendEmail(c.env, {
    to: email,
    subject: "You’re invited to 4th Ashby CampComms",
    purpose: "invitation",
    html: invitationEmail(displayName, `${c.env.APP_ORIGIN}/auth/verify?token=${encodeURIComponent(token)}`),
  });
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO email_deliveries (id, user_id, event_id, provider_id, purpose, status) VALUES (?, ?, ?, ?, 'invitation', ?)")
      .bind(crypto.randomUUID(), userId, eventId, delivery.id, delivery.ok ? "sent" : `failed:${delivery.error ?? "unknown"}`),
    c.env.DB.prepare(
      "INSERT INTO event_invitations (id, event_id, user_id, invited_by, role, status, provider_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), eventId, userId, c.get("user").id, role, delivery.ok ? "sent" : "failed", delivery.id, expiresAt),
  ]);
  await audit(c.env.DB, c.get("user").id, eventId, "invitation.created", "user", userId, { role });
  return { id: userId, email, invited: delivery.ok };
}

async function readEventInput(c: AppContext) {
  const body = await safeJson<{
    name?: string; slug?: string; summary?: string; location?: string; section?: string; startsAt?: string; endsAt?: string;
    postingClosesAt?: string; readOnlyUntil?: string; purgeAfter?: string; status?: string;
  }>(c.req.raw);
  const name = cleanText(body.name, 120);
  const slug = slugify(body.slug || name);
  const summary = cleanText(body.summary, 500);
  const location = cleanText(body.location, 200) || null;
  const section = ["squirrels", "beavers", "cubs", "scouts"].includes(body.section ?? "") ? body.section! : null;
  const startsAt = validDate(body.startsAt);
  const endsAt = validDate(body.endsAt);
  const postingClosesAt = validDate(body.postingClosesAt);
  const readOnlyUntil = validDate(body.readOnlyUntil);
  const purgeAfter = validDate(body.purgeAfter);
  const status = ["draft", "open", "read_only", "archived"].includes(body.status ?? "") ? body.status! : "draft";
  if (!name || !slug || !startsAt || !endsAt || !postingClosesAt || !readOnlyUntil || !purgeAfter) {
    return c.json({ error: "Complete the event name and all lifecycle dates." }, 400);
  }
  const times = [startsAt, endsAt, postingClosesAt, readOnlyUntil, purgeAfter].map((value) => new Date(value).getTime());
  if (!(times[0] < times[1] && times[1] <= times[2] && times[2] <= times[3] && times[3] < times[4])) {
    return c.json({ error: "Dates must run from event start through posting closure, read-only access and final deletion." }, 400);
  }
  return { name, slug, summary, location, section, startsAt, endsAt, postingClosesAt, readOnlyUntil, purgeAfter, status };
}

async function requireAnyEventAdmin(c: AppContext) {
  const membership = await c.env.DB.prepare(
    "SELECT event_id FROM event_memberships WHERE user_id = ? AND role = 'event_admin' AND (access_ends_at IS NULL OR access_ends_at > datetime('now')) LIMIT 1",
  ).bind(c.get("user").id).first();
  if (membership) return membership;
  return c.get("user").email.toLowerCase() === c.env.SYSTEM_ADMIN_EMAIL.toLowerCase()
    ? { system_admin: true }
    : c.json({ error: "You do not have permission to create events." }, 403);
}

async function requirePhotoGuest(c: AppContext) {
  const token = getCookie(c, PHOTO_GUEST_COOKIE);
  if (!token) return c.json({ error: "Please use the photo invitation sent to you.", code: "UNAUTHENTICATED" }, 401);
  const guest = await c.env.DB.prepare(
    `SELECT pg.id, pg.event_id, pg.display_name, e.name AS event_name, e.ends_at
     FROM photo_guest_sessions pgs JOIN photo_guests pg ON pg.id = pgs.guest_id JOIN events e ON e.id = pg.event_id
     WHERE pgs.token_hash = ? AND pgs.expires_at > datetime('now') AND pg.status = 'active' AND pg.access_ends_at > datetime('now') AND e.status != 'archived'`,
  ).bind(await sha256(token)).first<{ id: string; event_id: string; display_name: string; event_name: string; ends_at: string }>();
  if (!guest) { deleteCookie(c, PHOTO_GUEST_COOKIE, { path: "/" }); return c.json({ error: "Your photo access has expired.", code: "UNAUTHENTICATED" }, 401); }
  return guest;
}

async function requireMembership(
  c: AppContext,
  eventId: string,
  roles?: string[],
): Promise<Membership | Response> {
  const membership = await c.env.DB.prepare(
    `SELECT event_id, user_id, role, access_ends_at, can_view_private, can_reply_private, can_post_announcements FROM event_memberships
     WHERE event_id = ? AND user_id = ? AND (access_ends_at IS NULL OR access_ends_at > datetime('now'))`,
  ).bind(eventId, c.get("user").id).first<Membership>();
  if (!membership) return c.json({ error: "You do not have access to this event." }, 403);
  if (roles && !roles.includes(membership.role)) return c.json({ error: "You do not have permission to do that." }, 403);
  return membership;
}

type MembershipCapability = "can_view_private" | "can_reply_private" | "can_post_announcements";

async function requireCapability(c: AppContext, eventId: string, capability: MembershipCapability): Promise<Membership | Response> {
  const membership = await requireMembership(c, eventId);
  if (membership instanceof Response) return membership;
  if (!hasCapability(membership, capability)) return c.json({ error: "You do not have permission to do that." }, 403);
  return membership;
}

function hasCapability(membership: Membership, capability: MembershipCapability) {
  if (membership.role === "event_admin") return true;
  if (membership.role === "safeguarding" && (capability === "can_view_private" || capability === "can_reply_private")) return true;
  return membership[capability] === 1;
}

async function requireOpenEvent(
  c: AppContext,
  eventId: string,
): Promise<Membership | Response> {
  return requireWritableEvent(c, eventId, "standard");
}

type EventWriteFeature = "standard" | "lost_found";
type EventWriteWindow = { status: string; posting_closes_at: string; read_only_until: string };

export function canWriteEventFeature(event: EventWriteWindow, feature: EventWriteFeature, now = Date.now()) {
  if (event.status !== "open" && !(feature === "lost_found" && event.status === "read_only")) return false;
  const closesAt = feature === "lost_found" ? event.read_only_until : event.posting_closes_at;
  const closesAtTime = new Date(closesAt).getTime();
  return Number.isFinite(closesAtTime) && closesAtTime > now;
}

async function requireWritableEvent(
  c: AppContext,
  eventId: string,
  feature: EventWriteFeature,
): Promise<Membership | Response> {
  const membership = await requireMembership(c, eventId);
  if (membership instanceof Response) return membership;
  const event = await c.env.DB.prepare("SELECT status, posting_closes_at, read_only_until FROM events WHERE id = ?")
    .bind(eventId).first<EventWriteWindow>();
  if (!event || !canWriteEventFeature(event, feature)) {
    return c.json({ error: feature === "lost_found" ? "Lost & Found updates have now closed." : "This event is now read-only." }, 409);
  }
  return membership;
}

async function requireThreadAccess(
  c: AppContext,
  eventId: string,
  threadId: string,
): Promise<{ membership: Membership; thread: { id: string; opened_by: string; subject: string; status: string } } | Response> {
  const membership = await requireMembership(c, eventId);
  if (membership instanceof Response) return membership;
  const thread = await c.env.DB.prepare("SELECT id, opened_by, subject, status FROM private_threads WHERE id = ? AND event_id = ?")
    .bind(threadId, eventId).first<{ id: string; opened_by: string; subject: string; status: string }>();
  if (!thread) return c.json({ error: "Private conversation not found." }, 404);
  if (thread.opened_by !== c.get("user").id && !hasCapability(membership, "can_view_private")) return c.json({ error: "You do not have access to this conversation." }, 403);
  return { membership, thread };
}

function isLeader(role: string) {
  return ["leader", "event_admin", "safeguarding"].includes(role);
}

export function canAccessLeaderDiscussions(role: string) {
  return role === "young_leader" || isLeader(role);
}

export function canUsePrivateMessagesAndLifts(role: string) {
  return role !== "young_leader";
}

export function canManageTopicLock(role: string, kind: string, creatorId: string, userId: string) {
  return isLeader(role) || ((kind === "lost" || kind === "found") && creatorId === userId);
}

async function blockYoungLeader(c: AppContext, next: () => Promise<void>) {
  const membership = await requireMembership(c, c.req.param("eventId") ?? "");
  if (membership instanceof Response) return membership;
  if (!canUsePrivateMessagesAndLifts(membership.role)) return c.json({ error: "Young Leaders do not have access to this area." }, 403);
  await next();
}

async function markRead(db: D1Database, userId: string, resourceType: "topic" | "lift" | "private_thread", resourceId: string) {
  await db.prepare(
    `INSERT INTO content_reads (user_id, resource_type, resource_id, last_read_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id, resource_type, resource_id) DO UPDATE SET last_read_at = CURRENT_TIMESTAMP`,
  ).bind(userId, resourceType, resourceId).run();
}

function publicUser(user: User) {
  return { id: user.id, email: user.email, displayName: user.display_name, parentOf: user.parent_of, emailNotificationPreference: user.email_notification_preference };
}

function validEmailPreference(value: unknown): EmailPreference | null {
  return value === "daily" || value === "important_only" || value === "none" ? value : null;
}

type PushPayload = { title: string; body: string; url: string; tag: string };

async function eventUserIds(db: D1Database, eventId: string, excludeUserId: string, roles?: string[]) {
  const result = await db.prepare(
    `SELECT user_id FROM event_memberships
     WHERE event_id = ? AND user_id != ? AND (access_ends_at IS NULL OR access_ends_at > datetime('now'))
       AND (? = '' OR instr(?, ',' || role || ',') > 0)`,
  ).bind(eventId, excludeUserId, roles?.length ? "roles" : "", roles?.length ? `,${roles.join(",")},` : "").all<{ user_id: string }>();
  return result.results.map((row) => row.user_id);
}

async function eventUserIdsWithCapability(db: D1Database, eventId: string, excludeUserId: string, capability: MembershipCapability) {
  const capabilitySql = capability === "can_view_private" ? "can_view_private" : capability === "can_reply_private" ? "can_reply_private" : "can_post_announcements";
  const result = await db.prepare(
    `SELECT user_id FROM event_memberships
     WHERE event_id = ? AND user_id != ? AND (access_ends_at IS NULL OR access_ends_at > datetime('now'))
       AND (role = 'event_admin' OR (${capabilitySql} = 1) OR (? != 'can_post_announcements' AND role = 'safeguarding'))`,
  ).bind(eventId, excludeUserId, capability).all<{ user_id: string }>();
  return result.results.map((row) => row.user_id);
}

async function sendEventCapabilityPush(env: Env, eventId: string, excludeUserId: string, capability: MembershipCapability, payload: PushPayload) {
  return sendPushToUsers(env, await eventUserIdsWithCapability(env.DB, eventId, excludeUserId, capability), payload);
}

async function sendEventPush(env: Env, eventId: string, excludeUserId: string, payload: PushPayload, roles?: string[]) {
  return sendPushToUsers(env, await eventUserIds(env.DB, eventId, excludeUserId, roles), payload);
}

async function sendPushToUsers(env: Env, userIds: string[], payload: PushPayload) {
  if (!userIds.length || !env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return 0;
  const placeholders = userIds.map(() => "?").join(",");
  const subscriptions = await env.DB.prepare(
    `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id IN (${placeholders})`,
  ).bind(...userIds).all<{ id: string; endpoint: string; p256dh: string; auth: string }>();
  let sent = 0;
  for (const subscription of subscriptions.results) {
    if (!safePushEndpoint(subscription.endpoint)) {
      await env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ?").bind(subscription.id).run();
      continue;
    }
    try {
      await webpush.sendNotification(
        { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
        JSON.stringify(payload),
        { TTL: 86_400, urgency: "normal", contentEncoding: "aes128gcm", vapidDetails: { subject: "mailto:jon@4thashby.org.uk", publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY } },
      );
      sent += 1;
      await env.DB.prepare("UPDATE push_subscriptions SET last_success_at = CURRENT_TIMESTAMP WHERE id = ?").bind(subscription.id).run();
    } catch (error) {
      const statusCode = error instanceof webpush.WebPushError ? error.statusCode : 0;
      if (statusCode === 404 || statusCode === 410) await env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ?").bind(subscription.id).run();
      else console.error(JSON.stringify({ level: "error", message: "Push delivery failed", statusCode }));
    }
  }
  return sent;
}

async function sendEmail(env: Env, input: { to: string; subject: string; html: string; purpose: string }) {
  if (!env.RESEND_API_KEY) return { ok: false, id: null, error: "not_configured" };
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [input.to], subject: input.subject, html: input.html }),
  });
  const result = await response.json<{ id?: string; message?: string }>();
  return response.ok ? { ok: true, id: result.id ?? null, error: null } : { ok: false, id: null, error: result.message ?? "send_failed" };
}

async function recordEmail(db: D1Database, userId: string, purpose: string, delivery: { ok: boolean; id: string | null; error: string | null }, eventId: string | null = null) {
  await db.prepare("INSERT INTO email_deliveries (id, user_id, event_id, provider_id, purpose, status) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), userId, eventId, delivery.id, purpose, delivery.ok ? "sent" : `failed:${delivery.error ?? "unknown"}`).run();
}

async function createUnsubscribeUrl(env: Env, userId: string) {
  const token = randomToken(32);
  await env.DB.prepare(
    "INSERT INTO email_unsubscribe_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, datetime('now', '+90 days'))",
  ).bind(crypto.randomUUID(), userId, await sha256(token)).run();
  return `${env.APP_ORIGIN}/email/unsubscribe?token=${encodeURIComponent(token)}`;
}

async function sendImportantAnnouncementEmails(env: Env, eventId: string, authorId: string, announcementId: string, title: string) {
  const recipients = await env.DB.prepare(
    `SELECT u.id, u.email, u.display_name FROM users u
     JOIN event_memberships em ON em.user_id = u.id
     WHERE em.event_id = ? AND u.id != ? AND u.status = 'active'
       AND u.email_notification_preference = 'important_only'
       AND (em.access_ends_at IS NULL OR em.access_ends_at > datetime('now'))`,
  ).bind(eventId, authorId).all<{ id: string; email: string; display_name: string }>();
  for (const user of recipients.results) {
    const unsubscribeUrl = await createUnsubscribeUrl(env, user.id);
    const announcementUrl = `${env.APP_ORIGIN}/?tab=home&announcement=${encodeURIComponent(announcementId)}`;
    const delivery = await sendEmail(env, {
      to: user.email,
      subject: `Important CampComms announcement: ${title}`,
      purpose: "important_announcement",
      html: updateEmail(user.display_name, "Important announcement", escapeHtml(title), "Read announcement", announcementUrl, unsubscribeUrl),
    });
    await recordEmail(env.DB, user.id, "important_announcement", delivery, eventId);
  }
}

type DigestCounts = { announcements: number; discussions: number; lifts: number; photos: number; private_updates: number };

async function runDailyDigests(env: Env) {
  const hour = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", hour12: false }).format(new Date());
  if (hour !== "18") return;
  const users = await env.DB.prepare(
    `SELECT id, email, display_name, COALESCE(digest_last_checked_at, datetime('now', '-1 day')) AS since
     FROM users WHERE status = 'active' AND email_notification_preference = 'daily'`,
  ).all<{ id: string; email: string; display_name: string; since: string }>();
  for (const user of users.results) {
    const memberships = await env.DB.prepare(
      `SELECT e.id, e.name, em.role, em.can_view_private
       FROM event_memberships em JOIN events e ON e.id = em.event_id
       WHERE em.user_id = ? AND e.status != 'archived'
         AND (em.access_ends_at IS NULL OR em.access_ends_at > datetime('now'))`,
    ).bind(user.id).all<{ id: string; name: string; role: string; can_view_private: number }>();
    const sections: Array<{ name: string; counts: DigestCounts }> = [];
    for (const event of memberships.results) {
      const counts = await env.DB.prepare(
        `SELECT
          (SELECT COUNT(*) FROM announcements WHERE event_id = ? AND COALESCE(edited_at, published_at) > ?) AS announcements,
          (SELECT COUNT(*) FROM posts p JOIN topics t ON t.id = p.topic_id WHERE t.event_id = ? AND p.created_at > ? AND p.deleted_at IS NULL AND p.author_id != ?
            AND (t.audience = 'everyone' OR ? = 1)) AS discussions,
          ((SELECT COUNT(*) FROM lift_posts WHERE event_id = ? AND created_at > ? AND author_id != ?) +
           (SELECT COUNT(*) FROM lift_responses lr JOIN lift_posts lp ON lp.id = lr.lift_post_id WHERE lp.event_id = ? AND lr.created_at > ? AND lr.author_id != ?)) AS lifts,
          (SELECT COUNT(*) FROM photos p JOIN photo_albums pa ON pa.id = p.album_id WHERE pa.event_id = ? AND p.created_at > ? AND p.uploaded_by != ?) AS photos,
          (SELECT COUNT(*) FROM private_messages pm JOIN private_threads pt ON pt.id = pm.thread_id
            WHERE pt.event_id = ? AND pm.created_at > ? AND pm.author_id != ?
              AND (pt.opened_by = ? OR ? = 1 OR ? IN ('event_admin', 'safeguarding'))) AS private_updates`,
      ).bind(
        event.id, user.since,
        event.id, user.since, user.id, canAccessLeaderDiscussions(event.role) ? 1 : 0,
        event.id, user.since, user.id, event.id, user.since, user.id,
        event.id, user.since, user.id,
        event.id, user.since, user.id, user.id, event.can_view_private, event.role,
      ).first<DigestCounts>();
      if (counts && event.role === "young_leader") {
        counts.lifts = 0;
        counts.private_updates = 0;
      }
      if (counts && Object.values(counts).some((count) => Number(count) > 0)) sections.push({ name: event.name, counts });
    }
    if (!sections.length) {
      await env.DB.prepare("UPDATE users SET digest_last_checked_at = CURRENT_TIMESTAMP WHERE id = ?").bind(user.id).run();
      continue;
    }
    const unsubscribeUrl = await createUnsubscribeUrl(env, user.id);
    const lines = sections.map(({ name, counts }) => {
      const items = [
        countLabel(counts.announcements, "announcement"), countLabel(counts.discussions, "discussion update"),
        countLabel(counts.lifts, "lift-share update"), countLabel(counts.photos, "new photo"),
        countLabel(counts.private_updates, "private-message update"),
      ].filter(Boolean).map((item) => `<li>${item}</li>`).join("");
      return `<h2 style="font-size:18px;margin:22px 0 6px">${escapeHtml(name)}</h2><ul style="margin-top:6px">${items}</ul>`;
    }).join("");
    const delivery = await sendEmail(env, {
      to: user.email, subject: "Your daily CampComms summary", purpose: "daily_digest",
      html: updateEmail(user.display_name, "Your daily summary", lines, "Open CampComms", env.APP_ORIGIN, unsubscribeUrl),
    });
    await recordEmail(env.DB, user.id, "daily_digest", delivery);
    if (delivery.ok) {
      await env.DB.prepare("UPDATE users SET digest_last_checked_at = CURRENT_TIMESTAMP, digest_last_sent_at = CURRENT_TIMESTAMP WHERE id = ?").bind(user.id).run();
    }
  }
}

function countLabel(value: number, singular: string) {
  const count = Number(value);
  return count ? `${count} ${singular}${count === 1 ? "" : "s"}` : "";
}

function updateEmail(name: string, heading: string, content: string, button: string, url: string, unsubscribeUrl: string) {
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#173c2d;line-height:1.5"><div style="max-width:560px;margin:auto;padding:28px"><p style="font-weight:700;color:#00693c">4th Ashby CampComms</p><h1 style="font-size:24px">${escapeHtml(heading)}</h1><p>Hello ${escapeHtml(name)},</p><div>${content}</div><p><a href="${escapeHtml(url)}" style="display:inline-block;background:#00693c;color:white;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:700">${escapeHtml(button)}</a></p><p style="color:#66756f;font-size:13px">This summary deliberately excludes message text, private subjects, contact details, exact addresses and photographs. CampComms is not monitored for emergencies.</p><p style="font-size:12px"><a href="${escapeHtml(unsubscribeUrl)}" style="color:#66756f">Stop CampComms update emails</a></p></div></body></html>`;
}

async function audit(db: D1Database, actorId: string, eventId: string, action: string, targetType: string, targetId: string, metadata: Record<string, unknown> = {}) {
  await db.prepare("INSERT INTO audit_logs (id, actor_id, event_id, action, target_type, target_id, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), actorId, eventId, action, targetType, targetId, JSON.stringify(metadata)).run();
}

function magicLinkEmail(name: string, url: string) {
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#222;line-height:1.5"><div style="max-width:560px;margin:auto;padding:28px"><h1 style="font-size:24px;color:#7413dc">Sign in to 4th Ashby CampComms</h1><p>Hello ${escapeHtml(name)},</p><p>Use the secure button below to sign in. It expires in 15 minutes and works once.</p><p><a href="${escapeHtml(url)}" style="display:inline-block;background:#7413dc;color:white;padding:12px 18px;border-radius:8px;text-decoration:none">Sign in securely</a></p><p style="color:#66756f;font-size:14px">If you did not request this, you can ignore the email. This service is not monitored for emergencies.</p></div></body></html>`;
}

function invitationEmail(name: string, url: string) {
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#222;line-height:1.5"><div style="max-width:560px;margin:auto;padding:28px"><h1 style="font-size:24px;color:#7413dc">You’re invited to 4th Ashby CampComms</h1><p>Hello ${escapeHtml(name)},</p><p>You have been invited to a private event hub for updates, conversations, lift sharing and photographs.</p><p><a href="${escapeHtml(url)}" style="display:inline-block;background:#7413dc;color:white;padding:12px 18px;border-radius:8px;text-decoration:none">Accept invitation</a></p><p style="color:#66756f;font-size:14px">This link expires in 48 hours and works once. Your email address and telephone number are not shown to other parents.</p></div></body></html>`;
}

function photoGuestEmail(name: string, eventName: string, url: string) {
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#222;line-height:1.5"><div style="max-width:560px;margin:auto;padding:28px"><h1 style="font-size:24px;color:#7413dc">Private photographs from ${escapeHtml(eventName)}</h1><p>Hello ${escapeHtml(name)},</p><p>An event administrator has invited you to view this event’s private photo albums. This does not give access to CampComms messages or parent information.</p><p><a href="${escapeHtml(url)}" style="display:inline-block;background:#7413dc;color:white;padding:12px 18px;border-radius:8px;text-decoration:none">View private photographs</a></p><p style="color:#66756f;font-size:14px">The invitation expires in 48 hours and works once. Please do not download or share photographs on social media.</p></div></body></html>`;
}

export function randomToken(bytes: number) {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const value of values) binary += String.fromCharCode(value);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function safeJson<T>(request: Request): Promise<T> {
  try { return (await request.json()) as T; } catch { return {} as T; }
}

export function normaliseEmail(value: unknown) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : null;
}

export function cleanText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return "";
  return value.replace(/\r\n/g, "\n").trim().slice(0, maxLength);
}

function cleanPushKey(value: unknown, maxLength: number) {
  if (typeof value !== "string" || value.length < 8 || value.length > maxLength || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  return value;
}

export function safePushEndpoint(value: unknown) {
  if (typeof value !== "string" || value.length > 2_000) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    const allowed = host === "fcm.googleapis.com" || host === "updates.push.services.mozilla.com" || host === "web.push.apple.com" || host.endsWith(".notify.windows.com");
    return allowed ? url.toString() : null;
  } catch { return null; }
}

export function safeRedirect(value: unknown) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value.slice(0, 500);
}

function validFutureDate(value: unknown) {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.getTime() > Date.now() - 86_400_000 ? date.toISOString() : null;
}

function validDate(value: unknown) {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function validDay(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

function validPhotoFile(value: FormDataEntryValue | null, maxBytes: number): value is File {
  return value instanceof File && value.type === "image/jpeg" && value.size > 0 && value.size <= maxBytes;
}

function validVideoFile(value: FormDataEntryValue | null, maxBytes: number): value is File {
  return value instanceof File && ["video/mp4", "video/webm", "video/quicktime"].includes(value.type) && value.size > 0 && value.size <= maxBytes;
}

export async function deleteMediaObjects(bucket: Pick<R2Bucket, "delete">, keys: Array<string | null | undefined>) {
  const unique = [...new Set(keys.filter((key): key is string => Boolean(key)))];
  if (unique.length) await bucket.delete(unique);
  return unique;
}

async function recordPhotoView(db: D1Database, eventId: string, albumId: string, photoId: string, userId: string | null, guestId: string | null) {
  await db.prepare("INSERT INTO photo_views (id, event_id, album_id, photo_id, viewer_user_id, guest_id) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), eventId, albumId, photoId, userId, guestId).run();
}

export function slugify(value: unknown) {
  if (typeof value !== "string") return "";
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char] ?? char);
}

export async function validResendWebhook(secret: string, headers: Headers, body: string) {
  if (!secret) return false;
  const messageId = headers.get("svix-id");
  const timestamp = headers.get("svix-timestamp");
  const signatures = headers.get("svix-signature");
  if (!messageId || !timestamp || !signatures) return false;
  const timestampNumber = Number(timestamp);
  if (!Number.isFinite(timestampNumber) || Math.abs(Date.now() / 1000 - timestampNumber) > 300) return false;
  const rawSecret = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  let keyBytes: Uint8Array;
  try { keyBytes = Uint8Array.from(atob(rawSecret), (char) => char.charCodeAt(0)); } catch { return false; }
  const keyBuffer = new ArrayBuffer(keyBytes.length);
  new Uint8Array(keyBuffer).set(keyBytes);
  const key = await crypto.subtle.importKey("raw", keyBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const signedContent = new TextEncoder().encode(`${messageId}.${timestamp}.${body}`);
  for (const candidate of signatures.split(" ")) {
    const encoded = candidate.startsWith("v1,") ? candidate.slice(3) : "";
    if (!encoded) continue;
    try {
      const signatureBytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
      const signature = new ArrayBuffer(signatureBytes.length);
      new Uint8Array(signature).set(signatureBytes);
      if (await crypto.subtle.verify("HMAC", key, signature, signedContent)) return true;
    } catch { /* Try any remaining signature. */ }
  }
  return false;
}

async function runRetention(env: Env) {
  const duePhotos = await env.DB.prepare(
    `SELECT p.id, p.original_key, p.display_key, p.thumbnail_key, p.video_key FROM photos p
     JOIN photo_albums pa ON pa.id = p.album_id JOIN events e ON e.id = pa.event_id
     WHERE p.delete_after <= datetime('now') OR e.purge_after <= datetime('now')`,
  ).all<RetainedMedia>();
  await purgeMediaRecords(duePhotos.results, env.PHOTOS, async (id) => { await env.DB.prepare("DELETE FROM photos WHERE id = ?").bind(id).run(); });
  await env.DB.batch([
    env.DB.prepare("DELETE FROM magic_links WHERE expires_at <= datetime('now') OR used_at IS NOT NULL"),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')"),
    env.DB.prepare("DELETE FROM photo_guest_links WHERE expires_at <= datetime('now') OR used_at IS NOT NULL"),
    env.DB.prepare("DELETE FROM photo_guest_sessions WHERE expires_at <= datetime('now')"),
    env.DB.prepare("UPDATE lift_posts SET status = 'expired' WHERE expires_at <= datetime('now') AND status = 'open'"),
    env.DB.prepare("UPDATE events SET status = 'read_only' WHERE posting_closes_at <= datetime('now') AND status = 'open'"),
    env.DB.prepare("DELETE FROM events WHERE purge_after <= datetime('now')"),
  ]);
}

type RetainedMedia = { id: string; original_key: string; display_key: string; thumbnail_key: string; video_key: string | null };

export async function purgeMediaRecords(duePhotos: RetainedMedia[], bucket: Pick<R2Bucket, "delete">, deleteRecord: (id: string) => Promise<void>) {
  for (const photo of duePhotos) {
    await deleteMediaObjects(bucket, [photo.original_key, photo.display_key, photo.thumbnail_key, photo.video_key]);
    await deleteRecord(photo.id);
  }
  return duePhotos.length;
}

function brandedStatusPage(title: string, message: string, actions: Array<{ label: string; href: string; primary?: boolean }>) {
  const links = actions.map((action) => `<a class="${action.primary ? "primary" : "secondary"}" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#7413dc"><title>${escapeHtml(title)} · 4th Ashby CampComms</title><style>
  *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:linear-gradient(145deg,#f8f4fc,#edf7f2);font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#29252d}.card{width:min(560px,100%);background:#fff;border:1px solid #e5ddeb;border-radius:22px;padding:34px;box-shadow:0 20px 60px #35134b1a}.brand{display:flex;align-items:center;gap:11px;color:#7413dc;font-weight:850}.mark{display:grid;place-items:center;width:42px;height:42px;border-radius:13px;background:#7413dc;color:#fff;font-size:23px}.brand small{display:block;color:#617069;font-weight:650}h1{margin:32px 0 12px;font-size:clamp(28px,6vw,40px);line-height:1.08;color:#3e1458}p{font-size:17px;line-height:1.65;color:#59635f}.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:26px}a{display:inline-flex;justify-content:center;padding:12px 17px;border-radius:10px;text-decoration:none;font-weight:800}.primary{background:#7413dc;color:#fff}.secondary{border:1px solid #cfc3d7;color:#5c10b4;background:#fff}@media(max-width:480px){.card{padding:25px}.actions a{width:100%}}
  </style></head><body><main class="card"><div class="brand"><span class="mark" aria-hidden="true">⌁</span><span>4th Ashby<small>CampComms</small></span></div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><div class="actions">${links}</div></main></body></html>`;
}

app.notFound((c) => {
  if (c.req.path.startsWith("/api/")) return c.json({ error: "That service address does not exist." }, 404);
  return c.html(brandedStatusPage(
    "We couldn’t find that page",
    "The address may be incomplete, or the page may have moved. Return to CampComms to continue.",
    [{ label: "Return to CampComms", href: "/", primary: true }],
  ), 404);
});

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (controller.cron === "17 2 * * *") ctx.waitUntil(runRetention(env));
    else ctx.waitUntil(runDailyDigests(env));
  },
} satisfies ExportedHandler<Env>;

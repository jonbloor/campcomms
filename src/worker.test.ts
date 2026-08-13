import { describe, expect, it } from "vitest";
import { canAccessLeaderDiscussions, canManageTopicLock, canUsePrivateMessagesAndLifts, canWriteEventFeature, cleanText, isPlannerDocument, magicLinkConfirmationPage, normaliseEmail, photoGuestConfirmationPage, purgeMediaRecords, randomToken, safePushEndpoint, safeRedirect, slugify, validDay, validResendWebhook } from "./worker";

describe("security helpers", () => {
  it("accepts bounded planner documents and rejects incomplete ones", () => {
    expect(isPlannerDocument({ leaders: [], groups: [], items: [] })).toBe(true);
    expect(isPlannerDocument({ leaders: [], groups: [] })).toBe(false);
    expect(isPlannerDocument({ leaders: [], groups: [], items: new Array(1001).fill({}) })).toBe(false);
  });
  it("normalises valid email addresses and rejects malformed input", () => {
    expect(normaliseEmail(" Parent@Example.ORG ")).toBe("parent@example.org");
    expect(normaliseEmail("not-an-address")).toBeNull();
    expect(normaliseEmail(null)).toBeNull();
  });

  it("allows only local redirect paths", () => {
    expect(safeRedirect("/event/123")).toBe("/event/123");
    expect(safeRedirect("https://evil.example/path")).toBe("/");
    expect(safeRedirect("//evil.example/path")).toBe("/");
  });

  it("normalises line endings and enforces text limits", () => {
    expect(cleanText("  hello\r\nworld  ", 20)).toBe("hello\nworld");
    expect(cleanText("123456", 4)).toBe("1234");
  });

  it("creates safe reusable event slugs", () => {
    expect(slugify("  Cubs at Conkers! 2026 ")).toBe("cubs-at-conkers-2026");
    expect(slugify("---")).toBe("");
  });

  it("accepts known browser push services and blocks arbitrary endpoints", () => {
    expect(safePushEndpoint("https://fcm.googleapis.com/fcm/send/example")).toBe("https://fcm.googleapis.com/fcm/send/example");
    expect(safePushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/example")).toBe("https://updates.push.services.mozilla.com/wpush/v2/example");
    expect(safePushEndpoint("https://127.0.0.1/internal")).toBeNull();
    expect(safePushEndpoint("http://fcm.googleapis.com/example")).toBeNull();
  });

  it("accepts calendar days without accepting arbitrary date text", () => {
    expect(validDay("2026-08-15")).toBe("2026-08-15");
    expect(validDay("2026-02-31")).toBeNull();
    expect(validDay("15 August 2026")).toBeNull();
    expect(validDay(123)).toBeNull();
  });

  it("creates unpredictable URL-safe tokens of the requested strength", () => {
    const first = randomToken(32);
    const second = randomToken(32);
    expect(first).not.toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("requires an explicit POST before consuming an emailed sign-in token", () => {
    const html = magicLinkConfirmationPage('\"><script>alert("scanner")</script>');
    expect(html).toContain('method="post"');
    expect(html).toContain('action="/auth/verify"');
    expect(html).toContain("Continue to CampComms");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });

  it("protects photo-guest invitations from link scanners too", () => {
    const html = photoGuestConfirmationPage("a-secure-photo-invitation-token");
    expect(html).toContain('method="post"');
    expect(html).toContain('action="/photos/guest/verify"');
    expect(html).toContain("Open photo albums");
  });

  it("keeps the Young Leader access boundary distinct from adult and parent roles", () => {
    expect(canAccessLeaderDiscussions("young_leader")).toBe(true);
    expect(canAccessLeaderDiscussions("parent")).toBe(false);
    expect(canUsePrivateMessagesAndLifts("young_leader")).toBe(false);
    expect(canUsePrivateMessagesAndLifts("leader")).toBe(true);
    expect(canUsePrivateMessagesAndLifts("parent")).toBe(true);
  });

  it("lets item creators and leaders resolve Lost & Found posts without letting parents lock discussions", () => {
    expect(canManageTopicLock("parent", "lost", "user-1", "user-1")).toBe(true);
    expect(canManageTopicLock("young_leader", "found", "user-2", "user-2")).toBe(true);
    expect(canManageTopicLock("parent", "found", "user-1", "user-2")).toBe(false);
    expect(canManageTopicLock("parent", "discussion", "user-1", "user-1")).toBe(false);
    expect(canManageTopicLock("leader", "discussion", "user-1", "leader-1")).toBe(true);
  });

  it("keeps Lost & Found writable during the post-event read-only window", () => {
    const now = Date.parse("2026-08-20T12:00:00Z");
    const event = { status: "read_only", posting_closes_at: "2026-08-19T12:00:00Z", read_only_until: "2026-09-20T12:00:00Z" };
    expect(canWriteEventFeature(event, "standard", now)).toBe(false);
    expect(canWriteEventFeature(event, "lost_found", now)).toBe(true);
    expect(canWriteEventFeature({ ...event, read_only_until: "2026-08-20T11:59:59Z" }, "lost_found", now)).toBe(false);
    expect(canWriteEventFeature({ ...event, status: "archived" }, "lost_found", now)).toBe(false);
  });

  it("verifies valid Resend/Svix signatures and rejects changed content", async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const secret = `whsec_${Buffer.from(key).toString("base64")}`;
    const id = "msg_test";
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const body = JSON.stringify({ type: "email.delivered", data: { email_id: "email_1" } });
    const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
    const headers = new Headers({ "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${Buffer.from(signature).toString("base64")}` });
    expect(await validResendWebhook(secret, headers, body)).toBe(true);
    expect(await validResendWebhook(secret, headers, `${body}changed`)).toBe(false);
  });

  it("removes every R2 image variant before deleting its D1 record", async () => {
    const calls: string[] = [];
    const bucket = { delete: async (keys: string[]) => { calls.push(`r2:${keys.join(",")}`); } };
    const deleted = await purgeMediaRecords([{ id: "photo-1", original_key: "original", display_key: "display", thumbnail_key: "thumbnail", video_key: null }], bucket, async (id) => { calls.push(`db:${id}`); });
    expect(deleted).toBe(1);
    expect(calls).toEqual(["r2:original,display,thumbnail", "db:photo-1"]);
  });

  it("removes a retained video object and its D1 record", async () => {
    const removed: string[] = [];
    const bucket = { delete: async (keys: string[]) => { removed.push(...keys); } };
    await purgeMediaRecords([{ id: "video-1", original_key: "unused-original", display_key: "unused-display", thumbnail_key: "unused-thumbnail", video_key: "clip.mp4" }], bucket, async () => { removed.push("record"); });
    expect(removed).toEqual(["unused-original", "unused-display", "unused-thumbnail", "clip.mp4", "record"]);
  });
});

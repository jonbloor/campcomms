import React, { FormEvent, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowLeft, Bell, Bus, CalendarDays, Camera, Check, CircleAlert, Compass, Eye,
  ClipboardCheck, Home, Info, LockKeyhole, LogOut, MessageCircle, Pencil, Plus, Send, ShieldCheck,
  PackageSearch, Settings, TentTree, Trash2, Unlock, Users, X, Mail, MoreHorizontal,
} from "lucide-react";
import { api, ApiError, type EventDetails, type EventSummary } from "./api";
import { AdminTab, EventForm } from "./AdminTab";
import { PhotosTab } from "./PhotosTab";
import { PrivacyNotice } from "./PrivacyNotice";
import { FeaturesPage } from "./FeaturesPage";
import { PlannerTab } from "./PlannerTab";
import "./styles.css";

type Me = { user: { id: string; email: string; displayName: string; parentOf: string; emailNotificationPreference: "daily" | "important_only" | "none"; isSystemAdmin: boolean }; children: Array<{ id: string; display_name: string }> };
type Tab = "home" | "discuss" | "lost-found" | "lifts" | "photos" | "private" | "planner" | "info" | "admin";

function App() {
  return window.location.pathname === "/privacy" ? <PrivacyNotice /> : window.location.pathname === "/features" ? <FeaturesPage /> : <CampCommsApp />;
}

function CampCommsApp() {
  const [me, setMe] = useState<Me | null>(null);
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [details, setDetails] = useState<EventDetails | null>(null);
  const [tab, setTab] = useState<Tab>(() => {
    const requested = new URL(window.location.href).searchParams.get("tab") as Tab | null;
    return requested && ["home", "discuss", "lost-found", "lifts", "photos", "private", "planner", "info", "admin"].includes(requested) ? requested : "home";
  });
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState("");
  const [online, setOnline] = useState(navigator.onLine);
  const [moreOpen, setMoreOpen] = useState(false);

  async function loadSession(preferredId?: string) {
    setLoading(true); setAuthError("");
    try {
      const [meData, eventData] = await Promise.all([api<Me>("/api/me"), api<{ events: EventSummary[] }>("/api/events")]);
      setMe(meData);
      setEvents(eventData.events);
      const id = preferredId ?? selectedId ?? eventData.events[0]?.id ?? null;
      setSelectedId(id);
      if (id) setDetails(await api<EventDetails>(`/api/events/${id}`));
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setMe(null);
      else setAuthError(error instanceof Error ? error.message : "Could not load CampComms.");
    } finally { setLoading(false); }
  }

  useEffect(() => {
    const url = new URL(window.location.href);
    const token = url.pathname === "/auth/verify" ? url.searchParams.get("token") : null;
    if (token) {
      api<{ redirectPath: string }>(`/api/auth/verify?token=${encodeURIComponent(token)}`)
        .then((result) => { history.replaceState({}, "", result.redirectPath); return loadSession(); })
        .catch((error) => { setAuthError(error instanceof Error ? error.message : "The sign-in link could not be used."); setLoading(false); });
    } else void loadSession();
  }, []);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update); window.addEventListener("offline", update);
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, []);

  async function refreshEvent() {
    if (selectedId) setDetails(await api<EventDetails>(`/api/events/${selectedId}`));
  }

  async function chooseEvent(id: string) {
    setSelectedId(id); setTab("home"); setLoading(true);
    try { setDetails(await api<EventDetails>(`/api/events/${id}`)); }
    finally { setLoading(false); }
  }

  if (loading) return <Loading />;
  if (!me) return <SignIn error={authError} />;
  if (!details && events.length) return <ErrorState message={authError || "The event could not be loaded."} onRetry={loadSession} onLogout={() => logout(setMe)} />;
  if (!details) return <EmptyState me={me} onLogout={() => logout(setMe)} onCreated={loadSession} />;
  const youngLeader = details.membership.role === "young_leader";
  const activeTab = youngLeader && (tab === "lifts" || tab === "private") ? "home" : tab;
  const moreTabs: Tab[] = ["lost-found", "lifts", "planner", "info", "admin"];
  const moreBadge = details.unread_counts.lost_found + (youngLeader ? 0 : details.unread_counts.lifts) + (details.membership.role === "event_admin" ? details.unread_counts.access_requests : 0);
  const navigate = (next: Tab) => { setTab(next); setMoreOpen(false); };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to event content</a>
      <aside className="sidebar">
        <Brand />
        <p className="sidebar-label">Your events</p>
        <div className="event-switcher">
          {events.map((event) => (
            <button className={event.id === selectedId ? "event-button active" : "event-button"} key={event.id} onClick={() => void chooseEvent(event.id)}>
              <span className="event-icon"><TentTree size={19} /></span>
              <span><strong>{event.name}</strong><small>{event.section && <span className={`section-tag ${event.section}`}>{sectionName(event.section)}</span>}{formatRange(event.starts_at, event.ends_at)}</small></span>
            </button>
          ))}
        </div>
        <div className="sidebar-profile">
          <div className="avatar">{initials(me.user.displayName)}</div>
          <div><strong><LeaderName name={me.user.displayName.split(" — ")[0]} role={details.membership.role} compact /></strong><small>{friendlyRole(details.membership.role)}</small></div>
          <button className="icon-button" title="Sign out" onClick={() => void logout(setMe)}><LogOut size={18} /></button>
        </div>
      </aside>

      <main className="main" id="main-content">
        {!online && <div className="offline-banner" role="status"><CircleAlert size={17} /> You’re offline. Previously opened information may remain available, but changes cannot be saved.</div>}
        <header className="topbar">
          <div>
            <p className="eyebrow">{statusLabel(details.event.status)}</p>
            <h1>{details.event.name}</h1>
          </div>
          <div className="topbar-actions">
            {events.length > 1 && <select className="mobile-event-select" aria-label="Choose event" value={selectedId ?? ""} onChange={(event) => void chooseEvent(event.target.value)}>{events.map((event) => <option value={event.id} key={event.id}>{event.name}</option>)}</select>}
            <button type="button" className="notification-button" aria-label="Notification settings" title="Notification settings" onClick={() => setTab("info")}><Bell size={20} /></button>
            <button type="button" className="notification-button mobile-signout" aria-label="Sign out" title="Sign out" onClick={() => void logout(setMe)}><LogOut size={19} /></button>
          </div>
        </header>

        <nav className="tabs desktop-tabs" aria-label="Event sections">
          <TabButton id="home" current={activeTab} onClick={setTab} icon={Home} label="Home" />
          <TabButton id="discuss" current={activeTab} onClick={setTab} icon={MessageCircle} label="Discuss" badge={details.unread_counts.discussions} />
          <TabButton id="lost-found" current={activeTab} onClick={setTab} icon={PackageSearch} label="Lost & found" badge={details.unread_counts.lost_found} />
          {!youngLeader && <TabButton id="lifts" current={activeTab} onClick={setTab} icon={Bus} label="Lifts" badge={details.unread_counts.lifts} />}
          <TabButton id="photos" current={activeTab} onClick={setTab} icon={Camera} label="Photos" />
          {!youngLeader && <TabButton id="private" current={activeTab} onClick={setTab} icon={LockKeyhole} label="Private" badge={details.unread_counts.private_messages} />}
          {isLeaderRole(details.membership.role) && <TabButton id="planner" current={activeTab} onClick={setTab} icon={ClipboardCheck} label="Planner" />}
          <TabButton id="info" current={activeTab} onClick={setTab} icon={Info} label="Information" />
          {details.membership.role === "event_admin" && <TabButton id="admin" current={activeTab} onClick={setTab} icon={Settings} label="Manage" badge={details.unread_counts.access_requests} />}
        </nav>

        <nav className="mobile-tabs" aria-label="Event sections">
          <TabButton id="home" current={activeTab} onClick={navigate} icon={Home} label="Home" />
          <TabButton id="discuss" current={activeTab} onClick={navigate} icon={MessageCircle} label="Discuss" badge={details.unread_counts.discussions} />
          <TabButton id="photos" current={activeTab} onClick={navigate} icon={Camera} label="Photos" />
          {!youngLeader && <TabButton id="private" current={activeTab} onClick={navigate} icon={LockKeyhole} label="Private" badge={details.unread_counts.private_messages} />}
          <button type="button" aria-expanded={moreOpen} aria-current={moreTabs.includes(activeTab) ? "page" : undefined} className={moreTabs.includes(activeTab) ? "active" : ""} onClick={() => setMoreOpen((open) => !open)}><MoreHorizontal size={19} /><span>More</span>{moreBadge > 0 && <span className="tab-badge" aria-label={`${moreBadge} items need attention`}>{moreBadge > 99 ? "99+" : moreBadge}</span>}</button>
        </nav>
        {moreOpen && <><button type="button" className="more-menu-backdrop" aria-label="Close more menu" onClick={() => setMoreOpen(false)} /><section className="more-menu" aria-label="More event sections">
          <header><strong>More</strong><button type="button" className="icon-button" aria-label="Close" onClick={() => setMoreOpen(false)}><X size={19} /></button></header>
          <button type="button" onClick={() => navigate("lost-found")}><PackageSearch size={20} /><span><strong>Lost &amp; Found</strong><small>Items lost or found after the event</small></span>{details.unread_counts.lost_found > 0 && <span className="tab-badge">{details.unread_counts.lost_found}</span>}</button>
          {!youngLeader && <button type="button" onClick={() => navigate("lifts")}><Bus size={20} /><span><strong>Lift sharing</strong><small>Offers and requests from families</small></span>{details.unread_counts.lifts > 0 && <span className="tab-badge">{details.unread_counts.lifts}</span>}</button>}
          {isLeaderRole(details.membership.role) && <button type="button" onClick={() => navigate("planner")}><ClipboardCheck size={20} /><span><strong>Camp planner</strong><small>Programme, groups and leader assignments</small></span></button>}
          <button type="button" onClick={() => navigate("info")}><Info size={20} /><span><strong>Information</strong><small>Profile, notifications and event details</small></span></button>
          {details.membership.role === "event_admin" && <button type="button" onClick={() => navigate("admin")}><Settings size={20} /><span><strong>Manage</strong><small>People, requests and event settings</small></span>{details.unread_counts.access_requests > 0 && <span className="tab-badge">{details.unread_counts.access_requests}</span>}</button>}
        </section></>}

        <div className="content">
          {activeTab === "home" && <HomeTab details={details} onRefresh={refreshEvent} />}
          {activeTab === "discuss" && <DiscussTab details={details} me={me} onRefresh={refreshEvent} />}
          {activeTab === "lost-found" && <LostFoundTab details={details} me={me} onRefresh={refreshEvent} />}
          {activeTab === "lifts" && <LiftsTab details={details} me={me} onRefresh={refreshEvent} />}
          {activeTab === "photos" && <PhotosTab details={details} onRefresh={refreshEvent} />}
          {activeTab === "private" && <PrivateTab eventId={details.event.id} membership={details.membership} me={me} onRefresh={refreshEvent} />}
          {activeTab === "planner" && isLeaderRole(details.membership.role) && <PlannerTab eventId={details.event.id} eventName={details.event.name} start={details.event.starts_at} end={details.event.ends_at} />}
          {activeTab === "info" && <InfoTab details={details} me={me} onProfileChanged={() => loadSession(selectedId ?? undefined)} />}
          {activeTab === "admin" && details.membership.role === "event_admin" && <AdminTab details={details} onEventsChanged={loadSession} />}
        </div>
      </main>
    </div>
  );
}

function SignIn({ error }: { error: string }) {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState(error);
  const [busy, setBusy] = useState(false);
  const [requestingAccess, setRequestingAccess] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      const result = await api<{ message: string }>("/api/auth/request-link", { method: "POST", body: JSON.stringify({ email }) });
      setMessage(result.message);
    } catch (e) { setMessage(e instanceof Error ? e.message : "Could not request a sign-in link."); }
    finally { setBusy(false); }
  }

  return (
    <div className="sign-in-page">
      <div className="sign-in-art">
        <Brand large />
        <div className="art-copy"><span className="pill light">Private event communications</span><h1>Everything for camp, in one place.</h1><p>Stay connected before, during and after 4th Ashby activities, with announcements, conversations, lift sharing and photographs—all without sharing personal details.</p></div>
      </div>
      <div className="sign-in-panel">
        <form className="sign-in-card" onSubmit={submit}>
          <p className="eyebrow">Secure access</p><h2>Sign in to your event</h2>
          <p>Enter the email address that received your invitation. We’ll send you a one-time link.</p>
          <label>Email address<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.org" required autoComplete="email" /></label>
          <button className="primary-button" disabled={busy}>{busy ? "Sending…" : "Email me a secure link"}<Send size={17} /></button>
          <button id="request-access" type="button" className="request-access-button" onClick={() => setRequestingAccess(true)}>Not invited yet? Request access</button>
          {message && <div className="form-message"><ShieldCheck size={19} /><span>{message}</span></div>}
          <small className="safety-note"><CircleAlert size={15} /> This service is not monitored for emergencies.</small>
          <div className="public-links"><a href="/features">What CampComms does</a><a href="/privacy">Privacy notice</a></div>
        </form>
      </div>
      {requestingAccess && <Modal title="Request access" onClose={() => setRequestingAccess(false)}><AccessRequestForm initialEmail={email} onDone={() => setRequestingAccess(false)} /></Modal>}
    </div>
  );
}

type PublicEvent = { id: string; name: string; section: string | null; starts_at: string; ends_at: string };

function AccessRequestForm({ initialEmail, onDone }: { initialEmail: string; onDone: () => void }) {
  const [events, setEvents] = useState<PublicEvent[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [complete, setComplete] = useState("");
  useEffect(() => { api<{ events: PublicEvent[] }>("/api/access-request-events").then((result) => setEvents(result.events)).catch(() => setEvents([])); }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try { const result = await api<{ message: string }>("/api/access-requests", { method: "POST", body: JSON.stringify(values) }); setComplete(result.message); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not send your request."); }
    finally { setBusy(false); }
  }
  if (complete) return <div className="access-request-complete"><ShieldCheck size={30} /><p>{complete}</p><button type="button" className="primary-button" onClick={onDone}>Done</button></div>;
  if (events === null) return <p>Loading events…</p>;
  if (!events.length) return <div className="access-request-complete"><CircleAlert size={30} /><p>No events are currently accepting online access requests. Please contact an event Leader.</p><button type="button" className="secondary-button" onClick={onDone}>Close</button></div>;
  return <form className="modal-form" onSubmit={submit}>
    <p className="form-help">Choose the event you need. An administrator will review the request before any access is granted.</p>
    <label>Event<select name="eventId" required defaultValue=""><option value="" disabled>Choose an event</option>{events.map((item) => <option key={item.id} value={item.id}>{item.name}{item.section ? ` · ${item.section[0].toUpperCase()}${item.section.slice(1)}` : ""}</option>)}</select></label>
    <label>Your name or nickname<input name="displayName" maxLength={120} autoComplete="name" required /></label>
    <label>Email address<input name="email" type="email" maxLength={254} defaultValue={initialEmail} autoComplete="email" required /></label>
    <label>Parent/carer of<input name="parentOf" maxLength={160} placeholder="Child’s first name(s)" /></label>
    <label>Optional note<textarea name="note" rows={3} maxLength={800} placeholder="Anything that will help the Leaders identify you" /></label>
    <label className="request-honeypot" aria-hidden="true">Website<input name="website" tabIndex={-1} autoComplete="off" /></label>
    <p className="privacy-inline"><ShieldCheck size={18} /> Your details go only to authorised event administrators and are removed after 30 days.</p>
    {error && <p className="error-text">{error}</p>}<button className="primary-button" disabled={busy}>{busy ? "Sending…" : "Send access request"}</button>
  </form>;
}

function HomeTab({ details, onRefresh }: { details: EventDetails; onRefresh: () => Promise<void> }) {
  const next = details.announcements[0];
  const [editing, setEditing] = useState<EventDetails["announcements"][number] | "new" | null>(null);
  const [report, setReport] = useState<EventDetails["announcements"][number] | null>(null);
  const canPost = details.membership.role === "event_admin" || Boolean(details.membership.can_post_announcements);
  useEffect(() => {
    const id = new URL(window.location.href).searchParams.get("announcement");
    if (!id) return;
    window.setTimeout(() => document.getElementById(`announcement-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 80);
  }, []);
  useEffect(() => {
    const viewed = new Set<string>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting || entry.intersectionRatio < 0.35) continue;
        const announcementId = (entry.target as HTMLElement).dataset.announcementId;
        if (!announcementId || viewed.has(announcementId) || document.visibilityState !== "visible") continue;
        viewed.add(announcementId);
        observer.unobserve(entry.target);
        void api(`/api/events/${details.event.id}/announcements/${announcementId}/view`, { method: "POST" });
      }
    }, { threshold: [0.35] });
    document.querySelectorAll<HTMLElement>("[data-announcement-id]").forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [details.event.id, details.announcements]);
  return <>
    <section className="event-hero">
      <div><span className="pill"><Compass size={14} /> Summer camp</span><h2>{details.event.summary}</h2><p><CalendarDays size={17} /> {formatRange(details.event.starts_at, details.event.ends_at)} · {details.event.location}</p></div>
      <div className="hero-stat"><strong>{daysUntil(details.event.starts_at)}</strong><span>days to go</span></div>
    </section>
    <div className="section-heading"><div><p className="eyebrow">Latest from the leaders</p><h2>Announcements</h2></div>{canPost && <button className="primary-button compact" onClick={() => setEditing("new")}><Plus size={18} /> New announcement</button>}</div>
    <div className="card-list">
      {details.announcements.map((item) => <article id={`announcement-${item.id}`} data-announcement-id={item.id} className={`announcement-card ${item.importance}`} key={item.id}>
        <div className="card-icon">{item.importance === "important" ? <CircleAlert size={21} /> : <Bell size={21} />}</div>
        <div className="card-main"><div className="card-meta"><LeaderName name={item.author_name} parentOf={item.author_parent_of} role={item.author_role} compact /><time>{relativeDate(item.published_at)}</time></div><h3>{item.title}</h3><p className="message-body">{item.body}</p>
          <div className="announcement-actions">{canPost && <span className="announcement-views" title="Unique signed-in people who have seen this announcement"><Eye size={15} /> {Number(item.view_count)} viewed</span>}{item.acknowledgement_required ? item.acknowledged ? <span className="acknowledged"><Check size={16} /> Acknowledged</span> : <button className="secondary-button" onClick={async () => { await api(`/api/events/${details.event.id}/announcements/${item.id}/acknowledge`, { method: "POST" }); await onRefresh(); }}><Check size={16} /> Acknowledge</button> : null}
          {canPost && <><button className="text-button neutral" onClick={() => setEditing(item)}><Pencil size={15} /> Edit</button>{Boolean(item.acknowledgement_required) && <button className="text-button neutral" onClick={() => setReport(item)}><ClipboardCheck size={15} /> Responses</button>}<button className="text-button" onClick={async () => { if (confirm(`Delete “${item.title}”? This cannot be undone.`)) { await api(`/api/events/${details.event.id}/announcements/${item.id}`, { method: "DELETE" }); await onRefresh(); } }}><Trash2 size={15} /> Delete</button></>}</div>
        </div>
      </article>)}
      {!next && <EmptyCard icon={Bell} title="No announcements yet" text="Leader updates will appear here." />}
    </div>
    {editing && <Modal title={editing === "new" ? "New announcement" : "Edit announcement"} onClose={() => setEditing(null)}><AnnouncementForm eventId={details.event.id} announcement={editing === "new" ? undefined : editing} onDone={async () => { setEditing(null); await onRefresh(); }} /></Modal>}
    {report && <AcknowledgementReport eventId={details.event.id} announcement={report} onClose={() => setReport(null)} />}
  </>;
}

function DiscussTab({ details, me, onRefresh }: { details: EventDetails; me: Me; onRefresh: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(() => new URL(window.location.href).searchParams.get("topic"));
  const writable = eventFeatureWritable(details.event, "standard");
  return <>
    <div className="section-heading"><div><p className="eyebrow">Event conversations</p><h2>Discussions</h2><p>Public topics are visible to everyone; leaders can also keep non-urgent operational notes in leader-only topics.</p></div>{writable && <button className="primary-button compact" onClick={() => setOpen(true)}><Plus size={18} /> New topic</button>}</div>
    <div className="topic-grid">{details.topics.filter((topic) => topic.kind === "discussion").map((topic) => <button className="topic-card conversation-card" key={topic.id} onClick={() => setSelected(topic.id)}>{topic.unread ? <span className="unread-badge">New</span> : null}<span className={`category ${topic.category}`}>{topic.category}</span>{topic.audience === "leaders" && <span className="category leaders-only"><LockKeyhole size={11} /> Leaders only</span>}<h3>{topic.title}</h3><p>Started by <LeaderName name={topic.author_name} parentOf={topic.author_parent_of} role={topic.author_role} compact /></p><div><span><MessageCircle size={16} /> {topic.reply_count} {topic.reply_count === 1 ? "reply" : "replies"}</span><time>{topic.is_locked ? "Locked" : relativeDate(topic.last_reply_at ?? topic.created_at)}</time></div></button>)}</div>
    {!details.topics.some((topic) => topic.kind === "discussion") && <EmptyCard icon={MessageCircle} title="No discussions yet" text="Start a topic for questions other event members can help with." />}
    {open && <Modal title="Start a discussion" onClose={() => setOpen(false)}><TopicForm eventId={details.event.id} canRestrict={canAccessLeaderTopics(details.membership.role)} onDone={async () => { setOpen(false); await onRefresh(); }} /></Modal>}
    {selected && <TopicConversation eventId={details.event.id} topicId={selected} role={details.membership.role} userId={me.user.id} writable={writable} onClose={async () => { setSelected(null); await onRefresh(); }} />}
  </>;
}

function LostFoundTab({ details, me, onRefresh }: { details: EventDetails; me: Me; onRefresh: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(() => new URL(window.location.href).searchParams.get("topic"));
  const items = details.topics.filter((topic) => topic.kind === "lost" || topic.kind === "found");
  const writable = eventFeatureWritable(details.event, "lost_found");
  return <>
    <div className="section-heading"><div><p className="eyebrow">Help belongings find their way home</p><h2>Lost &amp; Found</h2><p>{writable ? `Items and replies remain open until ${formatDate(details.event.read_only_until)}, after normal event conversations close.` : "Items remain visible until the event is deleted, but updates have now closed."}</p></div>{writable && <button className="primary-button compact" onClick={() => setOpen(true)}><Plus size={18} /> Add item</button>}</div>
    <div className="topic-grid">{items.map((item) => <button className={`topic-card conversation-card lost-found-card ${item.is_locked ? "resolved" : ""}`} key={item.id} onClick={() => setSelected(item.id)}>{item.unread ? <span className="unread-badge">New</span> : null}<span className={`category lost-found-kind ${item.kind}`}>{item.kind === "lost" ? "Lost" : "Found"}</span>{item.is_locked && <span className="category resolved"><Check size={11} /> Resolved</span>}<h3>{item.title}</h3><p>Listed by <LeaderName name={item.author_name} parentOf={item.author_parent_of} role={item.author_role} compact /></p><div><span><MessageCircle size={16} /> {item.reply_count} {item.reply_count === 1 ? "reply" : "replies"}</span><time>{item.is_locked ? "Closed" : relativeDate(item.last_reply_at ?? item.created_at)}</time></div></button>)}</div>
    {!items.length && <EmptyCard icon={PackageSearch} title="Nothing listed" text="Add an item if something has gone missing or been found after the event." />}
    {open && <Modal title="Add a Lost & Found item" onClose={() => setOpen(false)}><LostFoundForm eventId={details.event.id} onDone={async () => { setOpen(false); await onRefresh(); }} /></Modal>}
    {selected && <TopicConversation eventId={details.event.id} topicId={selected} role={details.membership.role} userId={me.user.id} writable={writable} onClose={async () => { setSelected(null); await onRefresh(); }} />}
  </>;
}

function LiftsTab({ details, me, onRefresh }: { details: EventDetails; me: Me; onRefresh: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(() => new URL(window.location.href).searchParams.get("lift"));
  return <>
    <div className="section-heading"><div><p className="eyebrow">Public to event members</p><h2>Lift sharing</h2><p>Share approximate areas only. Agree exact addresses away from the public board.</p></div><button className="primary-button compact" onClick={() => setOpen(true)}><Plus size={18} /> Offer or request</button></div>
    <div className="lift-grid">{details.lifts.map((lift) => <button className="lift-card conversation-card" key={lift.id} onClick={() => setSelected(lift.id)}>{lift.unread ? <span className="unread-badge">New</span> : null}<div className={`lift-kind ${lift.kind}`}><Bus size={19} /> {lift.kind === "offer" ? "Offering a lift" : "Looking for a lift"}</div><h3>{lift.area}</h3><dl><div><dt>Journey</dt><dd>{lift.journey}</dd></div><div><dt>When</dt><dd>{formatDateTime(lift.journey_at)}</dd></div><div><dt>Seats</dt><dd>{lift.seats}</dd></div></dl>{lift.note && <p>{lift.note}</p>}<footer><LeaderName name={lift.author_name} parentOf={lift.author_parent_of} role={lift.author_role} compact /><span>{lift.status === "open" ? `${lift.response_count} responses` : lift.status}</span></footer></button>)}</div>
    {!details.lifts.length && <EmptyCard icon={Bus} title="No lift posts yet" text="Offer a space or ask whether someone can help." />}
    {open && <Modal title="Lift sharing" onClose={() => setOpen(false)}><LiftForm eventId={details.event.id} onDone={async () => { setOpen(false); await onRefresh(); }} /></Modal>}
    {selected && <LiftConversation eventId={details.event.id} liftId={selected} role={details.membership.role} userId={me.user.id} onClose={async () => { setSelected(null); await onRefresh(); }} />}
  </>;
}

function PrivateTab({ eventId, membership, me, onRefresh }: { eventId: string; membership: EventDetails["membership"]; me: Me; onRefresh: () => Promise<void> }) {
  const [threads, setThreads] = useState<Array<{ id: string; subject: string; status: string; opened_by_name: string; opened_by_parent_of: string; opened_by_role: string; message_count: number; updated_at: string; unread: number }>>([]);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(() => new URL(window.location.href).searchParams.get("thread"));
  const [filter, setFilter] = useState<"all" | "unread" | "open" | "closed">("all");
  const load = () => api<{ threads: typeof threads }>(`/api/events/${eventId}/private-threads`).then((r) => setThreads(r.threads));
  useEffect(() => { void load(); }, [eventId]);
  const canViewAll = membership.role === "event_admin" || membership.role === "safeguarding" || Boolean(membership.can_view_private);
  const canReply = membership.role === "event_admin" || membership.role === "safeguarding" || Boolean(membership.can_reply_private);
  const visibleThreads = threads.filter((thread) => filter === "all" || filter === "unread" ? filter === "all" || Boolean(thread.unread) : thread.status === filter);
  return <><div className="private-banner"><LockKeyhole size={28} /><div><h2>Private messages</h2><p>Messages here are visible only to you and authorised members of the event leadership team. Other parents cannot see them.</p></div></div>
    <div className="section-heading"><div><p className="eyebrow">Confidential event conversation</p><h2>{canViewAll ? "Private conversations" : "Your conversations"}</h2></div><div className="heading-actions">{threads.length > 0 && <select aria-label="Filter private messages" value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}><option value="all">All</option><option value="unread">Unread</option><option value="open">Open</option><option value="closed">Closed</option></select>}<button className="primary-button compact" onClick={() => setOpen(true)}><Plus size={18} /> New private message</button></div></div>
    <div className="card-list">{visibleThreads.map((thread) => <button className="private-thread conversation-card" onClick={() => setSelected(thread.id)} key={thread.id}><div>{thread.unread ? <span className="unread-dot" aria-label="Unread" /> : <span className={`status-dot ${thread.status}`} />} <strong>{thread.subject}</strong><p>{canViewAll && <><LeaderName name={thread.opened_by_name} parentOf={thread.opened_by_parent_of} role={thread.opened_by_role} /> · </>}{thread.message_count} messages · Updated {relativeDate(thread.updated_at)}</p></div><span>{thread.status}</span></button>)}{!threads.length && <EmptyCard icon={LockKeyhole} title="No private messages" text="Use this area for messages you do not want other parents to see." />}{threads.length > 0 && !visibleThreads.length && <EmptyCard icon={LockKeyhole} title="Nothing in this view" text="Choose another filter to see your other private messages." />}</div>
    {open && <Modal title="New private message" onClose={() => setOpen(false)}><PrivateForm eventId={eventId} onDone={async () => { setOpen(false); await load(); }} /></Modal>}
    {selected && <PrivateConversation eventId={eventId} threadId={selected} canReply={canReply} isAdmin={membership.role === "event_admin"} userId={me.user.id} onClose={async () => { setSelected(null); await Promise.all([load(), onRefresh()]); }} />}
  </>;
}

type ConversationMessage = { id: string; body: string; created_at: string; author_id: string; author_name: string; author_parent_of: string; author_role: string };

function TopicConversation({ eventId, topicId, role, userId, writable, onClose }: { eventId: string; topicId: string; role: string; userId: string; writable: boolean; onClose: () => Promise<void> }) {
  const [data, setData] = useState<{ topic: { title: string; category: string; kind: "discussion" | "lost" | "found"; created_by: string; is_locked: number }; posts: ConversationMessage[] } | null>(null);
  const load = () => api<typeof data>(`/api/events/${eventId}/topics/${topicId}`).then((value) => setData(value));
  useEffect(() => { void load(); }, [eventId, topicId]);
  if (!data) return <ConversationShell title="Loading discussion…" onClose={onClose}><div className="conversation-loading">Loading…</div></ConversationShell>;
  const leader = isLeaderRole(role);
  const lostFound = data.topic.kind === "lost" || data.topic.kind === "found";
  const canLock = leader || (lostFound && data.topic.created_by === userId);
  const remove = async () => { if (!confirm("Permanently delete this discussion and all its replies?")) return; await api(`/api/events/${eventId}/topics/${topicId}`, { method: "DELETE" }); await onClose(); };
  return <ConversationShell title={data.topic.title} label={lostFound ? `${data.topic.kind === "lost" ? "Lost" : "Found"} item` : `${data.topic.category} discussion`} onClose={onClose} actions={<>{canLock && <button className="secondary-button" onClick={async () => { await api(`/api/events/${eventId}/topics/${topicId}`, { method: "PATCH", body: JSON.stringify({ locked: !data.topic.is_locked }) }); await load(); }}>{data.topic.is_locked ? <Unlock size={16} /> : lostFound ? <Check size={16} /> : <LockKeyhole size={16} />}{data.topic.is_locked ? "Reopen" : lostFound ? "Mark resolved" : "Lock"}</button>}{role === "event_admin" && <button className="text-button" onClick={() => void remove()}><Trash2 size={15} /> Delete</button>}</>}>
    <MessageList messages={data.posts} userId={userId} canModerate={leader} onDelete={async (id) => { if (confirm("Remove this reply?")) { await api(`/api/events/${eventId}/topics/${topicId}/posts/${id}`, { method: "DELETE" }); await load(); } }} />
    {data.topic.is_locked ? <p className="closed-notice">{lostFound ? <Check size={16} /> : <LockKeyhole size={16} />} {lostFound ? "This item has been resolved and replies are closed." : "This discussion is locked."}</p> : writable ? <ReplyForm label={lostFound ? "Reply about this item" : "Add a public reply"} endpoint={`/api/events/${eventId}/topics/${topicId}/posts`} maxLength={3000} onDone={load} /> : <p className="closed-notice"><LockKeyhole size={16} /> {lostFound ? "Lost & Found updates have now closed." : "This event is now read-only."}</p>}
  </ConversationShell>;
}

function LiftConversation({ eventId, liftId, role, userId, onClose }: { eventId: string; liftId: string; role: string; userId: string; onClose: () => Promise<void> }) {
  const [data, setData] = useState<{ lift: { id: string; author_id: string; author_name: string; author_parent_of: string; author_role: string; kind: string; journey: string; area: string; seats: number; journey_at: string; note: string; status: string }; responses: ConversationMessage[] } | null>(null);
  const load = () => api<typeof data>(`/api/events/${eventId}/lifts/${liftId}`).then((value) => setData(value));
  useEffect(() => { void load(); }, [eventId, liftId]);
  if (!data) return <ConversationShell title="Loading lift post…" onClose={onClose}><div className="conversation-loading">Loading…</div></ConversationShell>;
  const canManage = data.lift.author_id === userId || isLeaderRole(role);
  const action = async (status: string) => { await api(`/api/events/${eventId}/lifts/${liftId}`, { method: "PATCH", body: JSON.stringify({ status }) }); if (status === "withdrawn") await onClose(); else await load(); };
  const remove = async () => { if (!confirm("Permanently delete this lift-share conversation and all its responses?")) return; await api(`/api/events/${eventId}/lifts/${liftId}`, { method: "DELETE" }); await onClose(); };
  return <ConversationShell title={data.lift.area} label={data.lift.kind === "offer" ? "Lift offered" : "Lift requested"} onClose={onClose} actions={<>{canManage && data.lift.status === "open" && <><button className="secondary-button" onClick={() => void action("matched")}><Check size={16} /> Arranged</button><button className="text-button" onClick={() => void action("withdrawn")}>Withdraw</button></>}{role === "event_admin" && <button className="text-button" onClick={() => void remove()}><Trash2 size={15} /> Delete</button>}</>}>
    <div className="conversation-summary"><p><LeaderName name={data.lift.author_name} parentOf={data.lift.author_parent_of} role={data.lift.author_role} /></p><dl><div><dt>Journey</dt><dd>{data.lift.journey}</dd></div><div><dt>When</dt><dd>{formatDateTime(data.lift.journey_at)}</dd></div><div><dt>Seats</dt><dd>{data.lift.seats}</dd></div></dl>{data.lift.note && <p>{data.lift.note}</p>}</div>
    <MessageList messages={data.responses} userId={userId} />
    {data.lift.status === "open" ? <ReplyForm label="Respond to this lift post" endpoint={`/api/events/${eventId}/lifts/${liftId}/responses`} maxLength={1000} onDone={load} /> : <p className="closed-notice"><Check size={16} /> This lift post is {data.lift.status}.</p>}
  </ConversationShell>;
}

function PrivateConversation({ eventId, threadId, canReply, isAdmin, userId, onClose }: { eventId: string; threadId: string; canReply: boolean; isAdmin: boolean; userId: string; onClose: () => Promise<void> }) {
  const [data, setData] = useState<{ thread: { subject: string; status: string; opened_by: string }; messages: ConversationMessage[] } | null>(null);
  const load = () => api<typeof data>(`/api/events/${eventId}/private-threads/${threadId}`).then((value) => setData(value));
  useEffect(() => { void load(); }, [eventId, threadId]);
  if (!data) return <ConversationShell title="Loading private conversation…" onClose={onClose}><div className="conversation-loading">Loading…</div></ConversationShell>;
  const mayReply = data.thread.opened_by === userId || canReply;
  const updateStatus = async (status: string) => { await api(`/api/events/${eventId}/private-threads/${threadId}`, { method: "PATCH", body: JSON.stringify({ status }) }); await load(); };
  const remove = async () => { if (!confirm("Permanently delete this private conversation and all its messages?")) return; await api(`/api/events/${eventId}/private-threads/${threadId}`, { method: "DELETE" }); await onClose(); };
  return <ConversationShell title={data.thread.subject} label="Private conversation" onClose={onClose} privateView actions={<>{canReply && <button className="secondary-button" onClick={() => void updateStatus(data.thread.status === "open" ? "closed" : "open")}>{data.thread.status === "open" ? <Check size={16} /> : <Unlock size={16} />}{data.thread.status === "open" ? "Close" : "Reopen"}</button>}{isAdmin && <button className="text-button" onClick={() => void remove()}><Trash2 size={15} /> Delete</button>}</>}>
    <MessageList messages={data.messages} userId={userId} />
    {data.thread.status === "open" && mayReply ? <ReplyForm label="Reply privately" endpoint={`/api/events/${eventId}/private-threads/${threadId}/messages`} maxLength={5000} onDone={load} /> : data.thread.status === "closed" ? <p className="closed-notice"><LockKeyhole size={16} /> This private conversation is closed.</p> : null}
  </ConversationShell>;
}

function ConversationShell({ title, label, actions, privateView = false, children, onClose }: { title: string; label?: string; actions?: React.ReactNode; privateView?: boolean; children: React.ReactNode; onClose: () => Promise<void> }) {
  useEffect(() => { const key = (event: KeyboardEvent) => event.key === "Escape" && void onClose(); window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key); }, [onClose]);
  return <div className="conversation-backdrop"><section className={`conversation-panel ${privateView ? "private-view" : ""}`} role="dialog" aria-modal="true" aria-label={title}><header><button className="back-button" onClick={() => void onClose()}><ArrowLeft size={19} /> Back</button><div>{label && <p className="eyebrow">{privateView && <LockKeyhole size={13} />} {label}</p>}<h2>{title}</h2></div><div className="conversation-actions">{actions}</div></header><div className="conversation-body">{children}</div></section></div>;
}

function MessageList({ messages, userId, canModerate = false, onDelete }: { messages: ConversationMessage[]; userId: string; canModerate?: boolean; onDelete?: (id: string) => Promise<void> }) {
  if (!messages.length) return <p className="conversation-empty">No responses yet.</p>;
  return <div className="message-list">{messages.map((message) => <article className={message.author_id === userId ? "chat-message mine" : "chat-message"} key={message.id}><header><strong><LeaderName name={message.author_name} parentOf={message.author_parent_of} role={message.author_role} /></strong><time>{formatDateTime(message.created_at)}</time></header><p>{message.body}</p>{onDelete && (canModerate || message.author_id === userId) && <button className="delete-message" onClick={() => void onDelete(message.id)} aria-label="Remove reply"><Trash2 size={14} /> Remove</button>}</article>)}</div>;
}

function ReplyForm({ label, endpoint, maxLength, onDone }: { label: string; endpoint: string; maxLength: number; onDone: () => Promise<void> }) {
  const [body, setBody] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  async function submit(event: FormEvent) { event.preventDefault(); if (!body.trim()) return; setBusy(true); setError(""); try { await api(endpoint, { method: "POST", body: JSON.stringify({ body }) }); setBody(""); await onDone(); } catch (e) { setError(e instanceof Error ? e.message : "Could not send this reply."); } finally { setBusy(false); } }
  return <form className="reply-form" onSubmit={submit}><label>{label}<textarea value={body} onChange={(event) => setBody(event.target.value)} rows={3} maxLength={maxLength} required /></label>{error && <p className="error-text">{error}</p>}<button className="primary-button" disabled={busy || !body.trim()}>{busy ? "Sending…" : "Send reply"}<Send size={16} /></button></form>;
}

function InfoTab({ details, me, onProfileChanged }: { details: EventDetails; me: Me; onProfileChanged: () => Promise<void> }) {
  return <><div className="section-heading"><div><p className="eyebrow">At a glance</p><h2>Event information</h2></div></div><div className="info-grid">
    <InfoCard icon={CalendarDays} title="Dates" value={formatRange(details.event.starts_at, details.event.ends_at)} />
    <InfoCard icon={Compass} title="Location" value={details.event.location ?? "To be confirmed"} />
    <InfoCard icon={Users} title="Your access" value={friendlyRole(details.membership.role)} />
    <InfoCard icon={ShieldCheck} title="Retention" value={`Read-only until ${formatDate(details.event.read_only_until)}`} />
  </div>
  <div className="settings-grid"><ProfileSettings me={me} onDone={onProfileChanged} /><PushSettings /><EmailSettings me={me} onDone={onProfileChanged} /></div>
  <section className="privacy-summary"><ShieldCheck size={22} /><div><h3>Your privacy</h3><p>Read how CampComms uses, protects and deletes personal information.</p><a href="/privacy">Read the CampComms privacy notice</a></div></section>
  <div className="emergency-card"><CircleAlert size={24} /><div><h3>Not for emergencies</h3><p>This service is not monitored continuously. For emergencies or urgent changes requiring an immediate response, use the contact arrangements supplied by the event leadership team.</p></div></div></>;
}

function ProfileSettings({ me, onDone }: { me: Me; onDone: () => Promise<void> }) {
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage("");
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try { await api("/api/me", { method: "PATCH", body: JSON.stringify(values) }); setMessage("Profile saved."); await onDone(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not save your profile."); }
    finally { setBusy(false); }
  }
  return <section className="settings-card"><div className="settings-icon"><Users size={21} /></div><div><p className="eyebrow">Visible to event members</p><h2>Your parent profile</h2><p>Help leaders and other parents recognise who belongs with whom. Your email address stays private.</p></div><form className="profile-form" onSubmit={submit}>
    <label>Name or nickname<input name="displayName" defaultValue={me.user.displayName} maxLength={80} required /></label>
    <label>Parent of<input name="parentOf" defaultValue={me.user.parentOf} maxLength={160} placeholder="e.g. Freddie and Alice" /></label>
    {message && <p className="inline-message" role="status" aria-live="polite">{message}</p>}<button className="secondary-button" disabled={busy}>{busy ? "Saving…" : "Save profile"}</button>
  </form></section>;
}

function PushSettings() {
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const [enabled, setEnabled] = useState(false); const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
  useEffect(() => {
    if (!supported) return;
    void navigator.serviceWorker.getRegistration().then((registration) => registration?.pushManager.getSubscription()).then((subscription) => setEnabled(Boolean(subscription)));
  }, [supported]);

  async function enable() {
    setBusy(true); setMessage("");
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") { setMessage("Notifications were not allowed on this device."); return; }
      const config = await api<{ publicKey: string }>("/api/push/config");
      const registration = await navigator.serviceWorker.register("/sw.js");
      const existing = await registration.pushManager.getSubscription();
      const subscription = existing ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToArrayBuffer(config.publicKey) });
      await api("/api/push/subscriptions", { method: "POST", body: JSON.stringify(subscription.toJSON()) });
      setEnabled(true); setMessage("Notifications enabled on this device.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not enable notifications."); }
    finally { setBusy(false); }
  }

  async function disable() {
    setBusy(true); setMessage("");
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) { await api("/api/push/subscriptions", { method: "DELETE", body: JSON.stringify({ endpoint: subscription.endpoint }) }); await subscription.unsubscribe(); }
      setEnabled(false); setMessage("Notifications disabled on this device.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not disable notifications."); }
    finally { setBusy(false); }
  }

  async function test() {
    setBusy(true); setMessage("");
    try { const result = await api<{ sent: number }>("/api/push/test", { method: "POST" }); setMessage(result.sent ? "Test notification sent." : "No active subscription was found."); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not send a test notification."); }
    finally { setBusy(false); }
  }

  return <section className="settings-card"><div className="settings-icon"><Bell size={21} /></div><div><p className="eyebrow">Optional on each device</p><h2>Mobile notifications</h2><p>Receive leader announcements and private-conversation replies. Notifications never include confidential message text.</p></div>
    {!supported ? <p className="inline-message">This browser does not support web push. On iPhone or iPad, install the site on the Home Screen first.</p> : <div className="notification-actions">{enabled ? <><button className="secondary-button" disabled={busy} onClick={() => void test()}>Send a test</button><button className="text-button" disabled={busy} onClick={() => void disable()}>Disable on this device</button></> : <button className="primary-button" disabled={busy} onClick={() => void enable()}>{busy ? "Enabling…" : "Enable notifications"}</button>}</div>}
    {message && <p className="inline-message" role="status" aria-live="polite">{message}</p>}
  </section>;
}

function EmailSettings({ me, onDone }: { me: Me; onDone: () => Promise<void> }) {
  const [preference, setPreference] = useState(me.user.emailNotificationPreference);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
  async function save() {
    setBusy(true); setMessage("");
    try {
      await api("/api/me", { method: "PATCH", body: JSON.stringify({ emailNotificationPreference: preference }) });
      setMessage("Email preference saved."); await onDone();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not save your email preference."); }
    finally { setBusy(false); }
  }
  return <section className="settings-card email-settings"><div className="settings-icon"><Mail size={21} /></div><div><p className="eyebrow">Optional</p><h2>Email updates</h2><p>Choose how CampComms emails you. Mobile notifications are controlled separately.</p></div>
    <fieldset className="email-options"><legend className="sr-only">Email update preference</legend>
      <label><input type="radio" name="emailPreference" checked={preference === "daily"} onChange={() => setPreference("daily")} /><span><strong>Daily summary</strong><small>One privacy-safe email at about 6pm, only on days when something changed.</small></span></label>
      <label><input type="radio" name="emailPreference" checked={preference === "important_only"} onChange={() => setPreference("important_only")} /><span><strong>Important announcements only</strong><small>An email when a leader publishes an important announcement.</small></span></label>
      <label><input type="radio" name="emailPreference" checked={preference === "none"} onChange={() => setPreference("none")} /><span><strong>No update emails</strong><small>Sign-in and invitation emails will still be sent.</small></span></label>
      {message && <p className="inline-message" role="status" aria-live="polite">{message}</p>}<button type="button" className="secondary-button" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save email preference"}</button>
    </fieldset>
  </section>;
}

function AnnouncementForm({ eventId, announcement, onDone }: { eventId: string; announcement?: EventDetails["announcements"][number]; onDone: () => Promise<void> }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const form = new FormData(event.currentTarget);
    const body = { title: String(form.get("title") ?? ""), body: String(form.get("body") ?? ""), importance: String(form.get("importance") ?? "normal"), acknowledgementRequired: form.get("acknowledgementRequired") === "yes" };
    try { await api(`/api/events/${eventId}/announcements${announcement ? `/${announcement.id}` : ""}`, { method: announcement ? "PATCH" : "POST", body: JSON.stringify(body) }); await onDone(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save the announcement."); setBusy(false); }
  }
  return <form className="modal-form" onSubmit={submit}>
    <label>Title<input name="title" defaultValue={announcement?.title} maxLength={120} required /></label>
    <label>Message<textarea name="body" defaultValue={announcement?.body} rows={7} maxLength={5000} required /></label>
    <label>Importance<select name="importance" defaultValue={announcement?.importance ?? "normal"}><option value="normal">Normal</option><option value="important">Important</option></select></label>
    <label className="check-field"><input name="acknowledgementRequired" value="yes" type="checkbox" defaultChecked={Boolean(announcement?.acknowledgement_required)} /> Ask parents to acknowledge this announcement</label>
    {error && <p className="error-text">{error}</p>}<button className="primary-button" disabled={busy}>{busy ? "Saving…" : announcement ? "Save changes" : "Publish announcement"}</button>
  </form>;
}

function AcknowledgementReport({ eventId, announcement, onClose }: { eventId: string; announcement: EventDetails["announcements"][number]; onClose: () => void }) {
  type Person = { id: string; display_name: string; parent_of: string; acknowledged_at: string | null };
  const [people, setPeople] = useState<Person[] | null>(null);
  useEffect(() => { void api<{ people: Person[] }>(`/api/events/${eventId}/announcements/${announcement.id}/acknowledgements`).then((result) => setPeople(result.people)); }, [eventId, announcement.id]);
  const acknowledged = people?.filter((person) => person.acknowledged_at).length ?? 0;
  return <Modal title="Acknowledgements" onClose={onClose}><div className="ack-report"><h3>{announcement.title}</h3>{people ? <><p>{acknowledged} of {people.length} parents acknowledged</p><div className="ack-list">{people.map((person) => <div key={person.id}><span className={person.acknowledged_at ? "ack-state yes" : "ack-state"}>{person.acknowledged_at ? <Check size={15} /> : <X size={15} />}</span><span><strong>{personLabel(person.display_name, person.parent_of)}</strong><small>{person.acknowledged_at ? `Acknowledged ${formatDateTime(person.acknowledged_at)}` : "Not yet acknowledged"}</small></span></div>)}</div></> : <div className="conversation-loading">Loading responses…</div>}</div></Modal>;
}

function TopicForm({ eventId, canRestrict, onDone }: { eventId: string; canRestrict: boolean; onDone: () => Promise<void> }) {
  return <JsonForm endpoint={`/api/events/${eventId}/topics`} onDone={onDone} fields={<><label>Topic title<input name="title" maxLength={120} required /></label><label>Category<select name="category"><option value="general">General</option><option value="kit">Kit</option><option value="travel">Travel</option><option value="food">Food</option><option value="programme">Programme</option></select></label>{canRestrict && <label>Who can see this?<select name="audience"><option value="everyone">Everyone in the event</option><option value="leaders">Leaders only</option></select></label>}<label>Opening message<textarea name="body" rows={5} maxLength={3000} required /></label></>} />;
}

function LostFoundForm({ eventId, onDone }: { eventId: string; onDone: () => Promise<void> }) {
  return <JsonForm endpoint={`/api/events/${eventId}/topics`} onDone={onDone} fields={<>
    <label>Is the item lost or found?<select name="kind" required><option value="lost">Lost</option><option value="found">Found</option></select></label>
    <label>Item<input name="title" maxLength={120} placeholder="e.g. Blue waterproof jacket" required /></label>
    <label>Description and last known location<textarea name="body" rows={5} maxLength={3000} placeholder="Include useful identifying details, but no private contact information." required /></label>
  </>} />;
}

function LiftForm({ eventId, onDone }: { eventId: string; onDone: () => Promise<void> }) {
  return <JsonForm endpoint={`/api/events/${eventId}/lifts`} onDone={onDone} fields={<><div className="field-row"><label>I am<select name="kind"><option value="offer">Offering a lift</option><option value="request">Looking for a lift</option></select></label><label>Journey<select name="journey"><option value="outbound">To the event</option><option value="return">Returning home</option></select></label></div><label>Approximate area<input name="area" placeholder="e.g. Ashby town centre" required /></label><div className="field-row"><label>Seats<input name="seats" type="number" min="1" max="8" defaultValue="1" required /></label><label>Date and time<input name="journeyAt" type="datetime-local" required /></label></div><label>Optional note<textarea name="note" rows={3} maxLength={500} /></label></>} numeric={["seats"]} />;
}

function PrivateForm({ eventId, onDone }: { eventId: string; onDone: () => Promise<void> }) {
  return <JsonForm endpoint={`/api/events/${eventId}/private-threads`} onDone={onDone} fields={<><div className="privacy-inline"><LockKeyhole size={19} /> Only you and designated event leaders can read this.</div><label>Subject<input name="subject" maxLength={120} required /></label><label>Message<textarea name="body" rows={6} maxLength={5000} required /></label></>} />;
}

function JsonForm({ endpoint, fields, onDone, numeric = [] }: { endpoint: string; fields: React.ReactNode; onDone: () => Promise<void>; numeric?: string[] }) {
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setBusy(true); setError(""); const values = Object.fromEntries(new FormData(event.currentTarget)); for (const key of numeric) values[key] = Number(values[key]) as never; try { await api(endpoint, { method: "POST", body: JSON.stringify(values) }); await onDone(); } catch (e) { setError(e instanceof Error ? e.message : "Could not save this."); setBusy(false); } }
  return <form className="modal-form" onSubmit={submit}>{fields}{error && <p className="error-text">{error}</p>}<button className="primary-button" disabled={busy}>{busy ? "Saving…" : "Save"}<Check size={17} /></button></form>;
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; dialog.current?.querySelector<HTMLElement>("button, input, textarea, select")?.focus(); const key = (event: KeyboardEvent) => event.key === "Escape" && onClose(); window.addEventListener("keydown", key); return () => { window.removeEventListener("keydown", key); previous?.focus(); }; }, [onClose]);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><section ref={dialog} className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><header><h2 id="modal-title">{title}</h2><button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X /></button></header>{children}</section></div>;
}

function TabButton({ id, current, onClick, icon: Icon, label, badge = 0 }: { id: Tab; current: Tab; onClick: (tab: Tab) => void; icon: typeof Home; label: string; badge?: number }) { return <button type="button" aria-current={current === id ? "page" : undefined} className={current === id ? "active" : ""} onClick={() => onClick(id)}><Icon size={18} /><span>{label}</span>{badge > 0 && <span className="tab-badge" aria-label={`${badge} unread`}>{badge > 99 ? "99+" : badge}</span>}</button>; }
function InfoCard({ icon: Icon, title, value }: { icon: typeof Home; title: string; value: string }) { return <article className="info-card"><Icon size={22} /><div><span>{title}</span><strong>{value}</strong></div></article>; }
function EmptyCard({ icon: Icon, title, text }: { icon: typeof Home; title: string; text: string }) { return <div className="empty-card"><Icon size={30} /><h3>{title}</h3><p>{text}</p></div>; }
function Loading() { return <div className="loading" role="status" aria-live="polite"><div className="brand-mark"><TentTree /></div><span>Preparing CampComms…</span></div>; }
function EmptyState({ me, onLogout, onCreated }: { me: Me; onLogout: () => void; onCreated: (eventId?: string) => Promise<void> }) { const [creating, setCreating] = useState(false); return <div className="loading"><Brand large /><h2>No active events</h2><p>{me.user.displayName}, CampComms is ready for your first event.</p><div className="button-row">{me.user.isSystemAdmin && <button className="primary-button" onClick={() => setCreating(true)}>Create first event</button>}<button className="secondary-button" onClick={onLogout}>Sign out</button></div>{creating && <Modal title="Create an event" onClose={() => setCreating(false)}><EventForm onDone={async (id) => { setCreating(false); await onCreated(id); }} /></Modal>}</div>; }
function ErrorState({ message, onRetry, onLogout }: { message: string; onRetry: () => Promise<void>; onLogout: () => void }) { return <div className="loading" role="alert"><CircleAlert size={35} /><h2>CampComms could not load</h2><p>{message}</p><div className="button-row"><button className="primary-button" onClick={() => void onRetry()}>Try again</button><button className="secondary-button" onClick={onLogout}>Sign out</button></div></div>; }
function Brand({ large = false }: { large?: boolean }) { return <div className={large ? "brand large" : "brand"}><span className="brand-mark"><TentTree /></span><span><strong>4th Ashby</strong><small>CampComms</small></span></div>; }

async function logout(setMe: (me: Me | null) => void) { await api("/api/auth/logout", { method: "POST" }); setMe(null); }
function initials(name: string) { return name.split(" — ")[0].split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase(); }
function personLabel(name: string, parentOf?: string) { return parentOf ? `${name} · Parent of ${parentOf}` : name; }
function LeaderName({ name, parentOf, role, compact = false }: { name: string; parentOf?: string; role?: string; compact?: boolean }) {
  const youngLeader = role === "young_leader";
  const leader = role ? isLeaderRole(role) : false;
  return <span className="person-name">{compact ? name : personLabel(name, parentOf)}{youngLeader ? <span className="leader-badge young-leader-badge" title="Young Leader"><ShieldCheck size={12} /> Young Leader</span> : leader && <span className="leader-badge" title={friendlyRole(role!)}><ShieldCheck size={12} /> Leader</span>}</span>;
}
function sectionName(section: EventSummary["section"]) { return section ? section[0].toUpperCase() + section.slice(1) : ""; }
function isLeaderRole(role: string) { return ["leader", "event_admin", "safeguarding"].includes(role); }
function canAccessLeaderTopics(role: string) { return role === "young_leader" || isLeaderRole(role); }
function eventFeatureWritable(event: EventDetails["event"], feature: "standard" | "lost_found") { const eligible = event.status === "open" || (feature === "lost_found" && event.status === "read_only"); const closesAt = feature === "lost_found" ? event.read_only_until : event.posting_closes_at; return eligible && new Date(closesAt).getTime() > Date.now(); }
function base64UrlToArrayBuffer(value: string) {
  const padded = value + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer as ArrayBuffer;
}
function friendlyRole(role: string) { return ({ parent: "Parent", young_leader: "Young Leader", leader: "Event leader", event_admin: "Event administrator", safeguarding: "Safeguarding lead" } as Record<string, string>)[role] ?? role; }
function statusLabel(status: string) { return status === "open" ? "Event hub open" : status === "read_only" ? "Event hub read-only" : status; }
function formatDate(value: string) { return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(new Date(value)); }
function formatDateTime(value: string) { return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function formatRange(start: string, end: string) { const a = new Date(start); const b = new Date(end); const sameMonth = a.getMonth() === b.getMonth(); return `${a.getDate()}${sameMonth ? "" : ` ${a.toLocaleDateString("en-GB", { month: "short" })}`}–${b.getDate()} ${b.toLocaleDateString("en-GB", { month: "short", year: "numeric" })}`; }
function relativeDate(value: string) { const diff = Date.now() - new Date(value).getTime(); const days = Math.floor(diff / 86_400_000); if (days <= 0) return "today"; if (days === 1) return "yesterday"; return `${days} days ago`; }
function daysUntil(value: string) { return Math.max(0, Math.ceil((new Date(value).getTime() - Date.now()) / 86_400_000)); }

function GuestPhotoApp() {
  type GuestHome = { guest: { displayName: string }; event: { name: string; endsAt: string }; albums: Array<{ id: string; title: string; description: string; taken_on: string | null; media_count: number }> };
  type GuestAlbum = { album: { id: string; title: string; description: string }; media: Array<{ id: string; caption: string; media_kind: "photo" | "video" }> };
  const [home, setHome] = useState<GuestHome | null>(null); const [album, setAlbum] = useState<GuestAlbum | null>(null); const [error, setError] = useState("");
  useEffect(() => { void api<GuestHome>("/api/photo-guest").then(setHome).catch((cause) => setError(cause instanceof Error ? cause.message : "Photo access is unavailable.")); }, []);
  async function signOut() { await api("/api/photo-guest/logout", { method: "POST" }); location.href = "/"; }
  if (error) return <div className="loading"><Brand large /><h2>Photo access unavailable</h2><p>{error}</p></div>;
  if (!home) return <Loading />;
  return <main className="guest-gallery"><header><Brand /><div><strong>{home.guest.displayName}</strong><button className="text-button" onClick={() => void signOut()}>Sign out</button></div></header><div className="guest-content"><p className="eyebrow">Private photo invitation</p><h1>{home.event.name}</h1><div className="social-sharing-note"><ShieldCheck size={18} /> Please do not download, forward or post these photographs or videos on social media.</div>{album ? <><button className="secondary-button" onClick={() => setAlbum(null)}><ArrowLeft size={17} /> All albums</button><h2>{album.album.title}</h2>{album.album.description && <p>{album.album.description}</p>}<div className="photo-grid">{album.media.map((item) => item.media_kind === "video" ? <video key={item.id} className="guest-media" src={`/api/photo-guest/media/${item.id}`} controls playsInline preload="metadata" /> : <img key={item.id} className="guest-media" src={`/api/photo-guest/media/${item.id}`} alt={item.caption || "Event photograph"} loading="lazy" />)}</div></> : <div className="album-grid">{home.albums.map((item) => <button className="album-card album-button" key={item.id} onClick={() => void api<GuestAlbum>(`/api/photo-guest/albums/${item.id}`).then(setAlbum)}><div className="album-placeholder"><Camera size={32} /></div><h3>{item.title}</h3><p>{item.media_count} item{item.media_count === 1 ? "" : "s"}</p></button>)}</div>}</div></main>;
}

const guestPhotoPath = window.location.pathname === "/photos/guest";
createRoot(document.getElementById("root")!).render(<React.StrictMode>{guestPhotoPath ? <GuestPhotoApp /> : <App />}</React.StrictMode>);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => void navigator.serviceWorker.register("/sw.js"));
}

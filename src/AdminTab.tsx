import { FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Bell, CalendarPlus, Check, CircleAlert, Mail, Pencil, RefreshCw, ShieldCheck, Trash2, UserPlus, Users } from "lucide-react";
import { api, type EventDetails } from "./api";

type AdminMember = {
  id: string; email: string; display_name: string; parent_of: string; status: string; role: string;
  joined_at: string; access_ends_at: string | null; invitation_status: string | null; invited_at: string | null;
  last_email_status: string | null; last_email_at: string | null;
  can_view_private: number; can_reply_private: number; can_post_announcements: number;
};

type AdminData = { event: EventDetails["event"]; members: AdminMember[]; operations: { emailPreferences: { daily: number; important_only: number; none: number }; pushDevices: number; recentDeliveries: { successful: number; failed: number; last_update: string | null } } };
type MigrationStatus = {
  source: { database: { totalRows: number; tables: Record<string, number> }; media: { objects: number; bytes: number } };
  eu: { database: { totalRows: number; tables: Record<string, number> }; media: { objects: number; bytes: number } };
  schema: { matches: boolean; missingInEu: string[]; extraInEu: string[] };
  readyToCopy: boolean;
};

export function AdminTab({ details, isSystemAdmin, onEventsChanged }: { details: EventDetails; isSystemAdmin: boolean; onEventsChanged: (eventId?: string) => Promise<void> }) {
  const [data, setData] = useState<AdminData | null>(null);
  const [dialog, setDialog] = useState<"invite" | "bulk" | "edit" | "create" | null>(null);
  const [notice, setNotice] = useState("");

  async function load() {
    setData(await api<AdminData>(`/api/admin/events/${details.event.id}`));
  }
  useEffect(() => { void load(); }, [details.event.id]);

  if (!data) return <div className="admin-loading"><RefreshCw className="spin" size={20} /> Loading administration…</div>;
  return <>
    <section className="admin-hero">
      <div><p className="eyebrow">Event administration</p><h2>Manage {data.event.name}</h2><p>Invite families and leaders, control access, and reuse the hub for future activities.</p></div>
      <button className="primary-button" onClick={() => setDialog("create")}><CalendarPlus size={18} /> New event</button>
    </section>
    {notice && <div className="success-banner"><Check size={18} /> {notice}</div>}

    <div className="admin-grid">
      <section className="admin-panel">
        <header><div><p className="eyebrow">Lifecycle</p><h2>Event settings</h2></div><button className="secondary-button" onClick={() => setDialog("edit")}><Pencil size={16} /> Edit</button></header>
        <dl className="settings-list">
          <div><dt>Status</dt><dd><span className={`status-badge ${data.event.status}`}>{data.event.status.replace("_", " ")}</span></dd></div>
          <div><dt>Event</dt><dd>{dateRange(data.event.starts_at, data.event.ends_at)}</dd></div>
          <div><dt>Posting closes</dt><dd>{dateTime(data.event.posting_closes_at)}</dd></div>
          <div><dt>Read-only until</dt><dd>{dateTime(data.event.read_only_until)}</dd></div>
          <div><dt>Deleted after</dt><dd>{dateTime(data.event.purge_after)}</dd></div>
        </dl>
      </section>

      <section className="admin-panel people-panel">
        <header><div><p className="eyebrow">Access list</p><h2>{data.members.length} people</h2></div><div className="button-row"><button className="secondary-button" onClick={() => setDialog("bulk")}><Users size={16} /> Bulk invite</button><button className="primary-button compact" onClick={() => setDialog("invite")}><UserPlus size={17} /> Invite</button></div></header>
        <div className="people-list">
          {data.members.map((member) => <MemberRow key={member.id} eventId={details.event.id} member={member} onChanged={load} />)}
        </div>
      </section>
      <section className="admin-panel operations-panel">
        <header><div><p className="eyebrow">Pre-launch checks</p><h2>Notifications</h2></div><ShieldCheck size={22} /></header>
        <dl className="settings-list">
          <div><dt><Mail size={15} /> Email choices</dt><dd>{Number(data.operations.emailPreferences.daily || 0)} daily · {Number(data.operations.emailPreferences.important_only || 0)} important only · {Number(data.operations.emailPreferences.none || 0)} off</dd></div>
          <div><dt><Bell size={15} /> Push devices</dt><dd>{data.operations.pushDevices} active subscription{data.operations.pushDevices === 1 ? "" : "s"}</dd></div>
          <div><dt><Check size={15} /> Last 30 days</dt><dd>{Number(data.operations.recentDeliveries.successful || 0)} sent or delivered</dd></div>
          <div><dt><CircleAlert size={15} /> Delivery issues</dt><dd className={Number(data.operations.recentDeliveries.failed || 0) ? "delivery-warning" : ""}>{Number(data.operations.recentDeliveries.failed || 0)} failed, bounced or complained</dd></div>
        </dl>
        <p className="operations-note">Parents control their own email choice. This panel reports delivery health without revealing message contents.</p>
      </section>
      {isSystemAdmin && <MigrationCheck />}
    </div>

    {dialog === "invite" && <AdminModal title="Invite someone" onClose={() => setDialog(null)}><InviteForm eventId={details.event.id} onDone={async () => { setDialog(null); setNotice("Invitation sent."); await load(); }} /></AdminModal>}
    {dialog === "bulk" && <AdminModal title="Invite several parents" onClose={() => setDialog(null)}><BulkInviteForm eventId={details.event.id} onDone={async (count) => { setDialog(null); setNotice(`${count} invitation${count === 1 ? "" : "s"} sent.`); await load(); }} /></AdminModal>}
    {dialog === "edit" && <AdminModal title="Edit event" onClose={() => setDialog(null)}><EventForm event={data.event} onDone={async () => { setDialog(null); setNotice("Event settings saved."); await onEventsChanged(details.event.id); await load(); }} /></AdminModal>}
    {dialog === "create" && <AdminModal title="Create an event" onClose={() => setDialog(null)}><EventForm onDone={async (id) => { setDialog(null); await onEventsChanged(id); }} /></AdminModal>}
  </>;
}

function MigrationCheck() {
  const [status, setStatus] = useState<MigrationStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function check() {
    setBusy(true); setError("");
    try { setStatus(await api<MigrationStatus>("/api/admin/eu-migration-status")); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not inspect EU storage."); }
    finally { setBusy(false); }
  }
  async function migrate() {
    if (!window.confirm("Copy all current CampComms data to the empty EU resources? The current resources will remain unchanged.")) return;
    setBusy(true); setError("");
    try {
      const result = await api<{ verifiedRows: number; verifiedMediaObjects: number }>("/api/admin/eu-migration", { method: "POST" });
      setError(`Verified copy complete: ${result.verifiedRows} database rows and ${result.verifiedMediaObjects} media objects.`);
      await check();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not copy data to EU storage."); }
    finally { setBusy(false); }
  }
  async function createSchema() {
    if (!window.confirm("Create the CampComms table structure in the empty EU database? No current data will be changed.")) return;
    setBusy(true); setError("");
    try {
      const result = await api<{ tablesCreated: number }>("/api/admin/eu-schema", { method: "POST" });
      setError(`EU database structure created: ${result.tablesCreated} tables.`);
      await check();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create the EU database structure."); }
    finally { setBusy(false); }
  }
  return <section className="admin-panel operations-panel">
    <header><div><p className="eyebrow">System administration</p><h2>EU storage migration</h2></div><ShieldCheck size={22} /></header>
    <p className="operations-note">This read-only check compares record and media counts. It does not copy, change or delete anything.</p>
    <button className="secondary-button" disabled={busy} onClick={() => void check()}>{busy ? "Checking…" : "Check EU storage"}</button>
    {error && <p className="error-text">{error}</p>}
    {status && <dl className="settings-list">
      <div><dt>Current database</dt><dd>{status.source.database.totalRows} rows</dd></div>
      <div><dt>EU database</dt><dd>{status.eu.database.totalRows} rows</dd></div>
      <div><dt>Current media</dt><dd>{status.source.media.objects} objects</dd></div>
      <div><dt>EU media</dt><dd>{status.eu.media.objects} objects</dd></div>
      <div><dt>Database schema</dt><dd>{status.schema.matches ? "Matches" : `Mismatch: missing ${status.schema.missingInEu.join(", ") || "none"}; extra ${status.schema.extraInEu.join(", ") || "none"}`}</dd></div>
      <div><dt>Migration state</dt><dd>{status.readyToCopy ? "EU targets are empty and ready" : "EU targets contain data—review required"}</dd></div>
    </dl>}
    {status?.readyToCopy && <button className="primary-button" disabled={busy} onClick={() => void migrate()}>{busy ? "Copying and verifying…" : "Copy data to EU storage"}</button>}
    {status && !status.schema.matches && status.eu.database.totalRows === 0 && <button className="primary-button" disabled={busy} onClick={() => void createSchema()}>{busy ? "Creating structure…" : "Create EU database structure"}</button>}
  </section>;
}

function MemberRow({ eventId, member, onChanged }: { eventId: string; member: AdminMember; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  async function update(changes: { role?: string; canViewPrivate?: boolean; canReplyPrivate?: boolean; canPostAnnouncements?: boolean }) {
    setBusy(true);
    const role = changes.role ?? member.role;
    const defaults = role === "event_admin"
      ? { canViewPrivate: true, canReplyPrivate: true, canPostAnnouncements: true }
      : role === "safeguarding"
        ? { canViewPrivate: true, canReplyPrivate: true, canPostAnnouncements: Boolean(member.can_post_announcements) }
        : role === "parent" || role === "young_leader"
          ? { canViewPrivate: false, canReplyPrivate: false, canPostAnnouncements: false }
          : { canViewPrivate: Boolean(member.can_view_private), canReplyPrivate: Boolean(member.can_reply_private), canPostAnnouncements: Boolean(member.can_post_announcements) };
    const permissions = { ...defaults, ...changes };
    if (!permissions.canViewPrivate) permissions.canReplyPrivate = false;
    try { await api(`/api/admin/events/${eventId}/members/${member.id}`, { method: "PATCH", body: JSON.stringify({ role, accessEndsAt: member.access_ends_at, ...permissions }) }); await onChanged(); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!window.confirm(`Remove ${member.display_name} from this event?`)) return;
    setBusy(true);
    try { await api(`/api/admin/events/${eventId}/members/${member.id}`, { method: "DELETE" }); await onChanged(); }
    finally { setBusy(false); }
  }
  return <article className="person-row">
    <div className="person-avatar">{initials(member.display_name)}</div>
    <div className="person-details"><strong>{member.display_name}{member.parent_of ? ` · Parent of ${member.parent_of}` : ""}{member.role === "young_leader" ? <span className="leader-badge young-leader-badge"><ShieldCheck size={12} /> Young Leader</span> : member.role !== "parent" && <span className="leader-badge"><ShieldCheck size={12} /> Leader</span>}</strong><span>{member.email}</span><small>{member.invitation_status ? `Invitation ${member.invitation_status}` : member.status}{member.last_email_status ? ` · Latest email ${friendlyDelivery(member.last_email_status)}` : ""}</small></div>
    <select aria-label={`Role for ${member.display_name}`} value={member.role} disabled={busy} onChange={(event) => void update({ role: event.target.value })}>
      <option value="parent">Parent</option><option value="young_leader">Young Leader</option><option value="leader">Leader</option><option value="safeguarding">Safeguarding</option><option value="event_admin">Administrator</option>
    </select>
    <button className="icon-button danger" aria-label={`Remove ${member.display_name}`} disabled={busy} onClick={() => void remove()}><Trash2 size={17} /></button>
    {member.role !== "parent" && <div className="person-permissions" aria-label={`Permissions for ${member.display_name}`}>
      {member.role === "event_admin" ? <span className="permission-summary">Administrators have all event permissions.</span> : member.role === "young_leader" ? <span className="permission-summary">Young Leaders can use announcements, all discussions and photos. Private messages and lift sharing are unavailable.</span> : <>
        <label><input type="checkbox" checked={member.role === "safeguarding" || Boolean(member.can_view_private)} disabled={busy || member.role === "safeguarding"} onChange={(event) => void update({ canViewPrivate: event.target.checked })} /> View private messages</label>
        <label><input type="checkbox" checked={member.role === "safeguarding" || Boolean(member.can_reply_private)} disabled={busy || member.role === "safeguarding" || !member.can_view_private} onChange={(event) => void update({ canReplyPrivate: event.target.checked })} /> Reply to private messages</label>
        <label><input type="checkbox" checked={Boolean(member.can_post_announcements)} disabled={busy} onChange={(event) => void update({ canPostAnnouncements: event.target.checked })} /> Post announcements</label>
      </>}
    </div>}
  </article>;
}

function InviteForm({ eventId, onDone }: { eventId: string; onDone: () => Promise<void> }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try { await api(`/api/admin/events/${eventId}/invitations`, { method: "POST", body: JSON.stringify(values) }); await onDone(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not send the invitation."); setBusy(false); }
  }
  return <form className="modal-form" onSubmit={submit}>
    <label>Display name<input name="displayName" maxLength={120} placeholder="e.g. Sam – Freddie’s parent" required /></label>
    <label>Email address<input name="email" type="email" autoComplete="off" required /></label>
    <label>Event role<select name="role" defaultValue="parent"><option value="parent">Parent</option><option value="young_leader">Young Leader</option><option value="leader">Leader</option><option value="safeguarding">Safeguarding</option><option value="event_admin">Administrator</option></select></label>
    <p className="privacy-inline"><Mail size={18} /> A secure invitation link will expire after 48 hours.</p>
    {error && <p className="error-text">{error}</p>}<button className="primary-button" disabled={busy}>{busy ? "Sending…" : "Send invitation"}</button>
  </form>;
}

function BulkInviteForm({ eventId, onDone }: { eventId: string; onDone: (count: number) => Promise<void> }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const text = String(new FormData(event.currentTarget).get("people") ?? "");
    const invitations = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const splitAt = line.lastIndexOf(",");
      return { displayName: line.slice(0, splitAt).trim(), email: line.slice(splitAt + 1).trim(), role: "parent" };
    });
    if (!invitations.length || invitations.some((item) => !item.displayName || !item.email.includes("@"))) { setError("Use one person per line in the format Name, email@example.org"); setBusy(false); return; }
    try { await api(`/api/admin/events/${eventId}/bulk-invitations`, { method: "POST", body: JSON.stringify({ invitations }) }); await onDone(invitations.length); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not send the invitations."); setBusy(false); }
  }
  return <form className="modal-form" onSubmit={submit}>
    <p className="form-help">Enter up to 40 parents, one per line:</p>
    <textarea name="people" rows={10} placeholder={"Sam Taylor, sam@example.org\nAlex Morgan, alex@example.org"} required />
    <p className="privacy-inline"><Mail size={18} /> Each parent receives their own private, one-use link.</p>
    {error && <p className="error-text">{error}</p>}<button className="primary-button" disabled={busy}>{busy ? "Sending invitations…" : "Send parent invitations"}</button>
  </form>;
}

export function EventForm({ event, onDone }: { event?: EventDetails["event"]; onDone: (id?: string) => Promise<void> }) {
  const defaults = lifecycleDefaults(event); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  async function submit(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault(); setBusy(true); setError("");
    const values = Object.fromEntries(new FormData(formEvent.currentTarget));
    try {
      const result = await api<{ id?: string }>(event ? `/api/admin/events/${event.id}` : "/api/admin/events", { method: event ? "PATCH" : "POST", body: JSON.stringify(values) });
      await onDone(result.id ?? event?.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save the event."); setBusy(false); }
  }
  return <form className="modal-form" onSubmit={submit}>
    <label>Event name<input name="name" defaultValue={event?.name} maxLength={120} required /></label>
    <div className="field-row"><label>Short address<input name="slug" defaultValue={event?.slug} placeholder="generated from name" /></label><label>Section<select name="section" defaultValue={event?.section ?? ""}><option value="">Not specified</option><option value="squirrels">Squirrels</option><option value="beavers">Beavers</option><option value="cubs">Cubs</option><option value="scouts">Scouts</option></select></label></div>
    <label>Status<select name="status" defaultValue={event?.status ?? "draft"}><option value="draft">Draft</option><option value="open">Open</option><option value="read_only">Read-only</option><option value="archived">Archived</option></select></label>
    <label>Summary<textarea name="summary" rows={3} defaultValue={event?.summary} maxLength={500} /></label>
    <label>Location<input name="location" defaultValue={event?.location ?? ""} maxLength={200} /></label>
    <div className="field-row"><DateField name="startsAt" label="Starts" value={defaults.startsAt} /><DateField name="endsAt" label="Ends" value={defaults.endsAt} /></div>
    <DateField name="postingClosesAt" label="Posting closes" value={defaults.postingClosesAt} />
    <DateField name="readOnlyUntil" label="Read-only access until" value={defaults.readOnlyUntil} />
    <DateField name="purgeAfter" label="Delete event data after" value={defaults.purgeAfter} />
    <p className="form-help">The final three dates control when discussion closes, how long families can still view the event, and when its retained data is deleted.</p>
    {error && <p className="error-text">{error}</p>}<button className="primary-button" disabled={busy}>{busy ? "Saving…" : event ? "Save event" : "Create event"}</button>
  </form>;
}

function DateField({ name, label, value }: { name: string; label: string; value: string }) { return <label>{label}<input name={name} type="datetime-local" defaultValue={value} required /></label>; }

function AdminModal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; dialog.current?.querySelector<HTMLElement>("button, input, textarea, select")?.focus(); const key = (event: KeyboardEvent) => event.key === "Escape" && onClose(); window.addEventListener("keydown", key); return () => { window.removeEventListener("keydown", key); previous?.focus(); }; }, [onClose]);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section ref={dialog} className="modal" role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button type="button" className="icon-button" aria-label="Close" onClick={onClose}>×</button></header>{children}</section></div>;
}

function lifecycleDefaults(event?: EventDetails["event"]) {
  const start = event ? new Date(event.starts_at) : new Date(Date.now() + 86_400_000);
  const end = event ? new Date(event.ends_at) : new Date(start.getTime() + 86_400_000);
  return {
    startsAt: localValue(start), endsAt: localValue(end),
    postingClosesAt: localValue(event ? new Date(event.posting_closes_at) : new Date(end.getTime() + 2 * 86_400_000)),
    readOnlyUntil: localValue(event ? new Date(event.read_only_until) : new Date(end.getTime() + 32 * 86_400_000)),
    purgeAfter: localValue(event ? new Date(event.purge_after) : new Date(end.getTime() + 33 * 86_400_000)),
  };
}
function localValue(date: Date) { return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); }
function dateTime(value: string) { return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
function dateRange(start: string, end: string) { return `${new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" }).format(new Date(start))} – ${new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" }).format(new Date(end))}`; }
function initials(name: string) { return name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase(); }
function friendlyDelivery(status: string) { return status.startsWith("failed") ? "failed" : status.replaceAll("_", " "); }

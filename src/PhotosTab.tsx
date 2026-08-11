import { FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { ArrowLeft, Camera, Check, ClipboardList, ImagePlus, Plus, ShieldCheck, Trash2, Upload, Users, Video, X } from "lucide-react";
import { api, type EventDetails } from "./api";

type AlbumPhoto = {
  id: string; caption: string; content_type: string; size_bytes: number; created_at: string; media_kind: "photo" | "video";
  uploaded_by_name: string; thumbnailUrl: string | null; displayUrl: string;
};
type AlbumData = {
  album: { id: string; title: string; description: string; taken_on: string | null; created_by_name: string };
  photos: AlbumPhoto[];
};

export function PhotosTab({ details, onRefresh }: { details: EventDetails; onRefresh: () => Promise<void> }) {
  const canManage = ["leader", "event_admin", "safeguarding"].includes(details.membership.role);
  const canContribute = canManage || details.membership.role === "young_leader";
  const [albumId, setAlbumId] = useState<string | null>(null);
  const [album, setAlbum] = useState<AlbumData | null>(null);
  const [creating, setCreating] = useState(false);
  const [guestsOpen, setGuestsOpen] = useState(false);

  async function openAlbum(id: string) { setAlbumId(id); setAlbum(await api<AlbumData>(`/api/events/${details.event.id}/albums/${id}`)); }
  async function refreshAlbum() { if (albumId) setAlbum(await api<AlbumData>(`/api/events/${details.event.id}/albums/${albumId}`)); }
  useEffect(() => { setAlbumId(null); setAlbum(null); }, [details.event.id]);

  if (albumId) return <AlbumView eventId={details.event.id} data={album} canManage={canManage} canContribute={canContribute} onBack={() => { setAlbumId(null); setAlbum(null); void onRefresh(); }} onRefresh={refreshAlbum} />;

  return <>
    <div className="section-heading"><div><p className="eyebrow">Private event albums</p><h2>Photographs and videos</h2><p>Only event members and specifically invited photo guests can view this media.</p></div>{canContribute && <div className="heading-actions">{details.membership.role === "event_admin" && <button className="secondary-button" onClick={() => setGuestsOpen(true)}><Users size={17} /> Photo guests</button>}<button className="primary-button compact" onClick={() => setCreating(true)}><Plus size={18} /> New album</button></div>}</div>
    <div className="photo-privacy"><ShieldCheck size={20} /><span>Images are stored privately, stripped of location metadata before upload, and deleted with the event retention schedule.</span></div>
    <div className="album-grid">
      {details.albums.map((item) => <button className="album-card album-button" key={item.id} onClick={() => void openAlbum(item.id)}>
        {item.cover_photo_id ? <img className="album-cover" src={`/api/events/${details.event.id}/photos/${item.cover_photo_id}/thumbnail`} alt="" loading="lazy" /> : <div className="album-placeholder"><Camera size={34} /></div>}
        <h3>{item.title}</h3><p>{item.photo_count} {item.photo_count === 1 ? "photograph" : "photographs"}{item.taken_on ? ` · ${formatDay(item.taken_on)}` : ""}</p>
      </button>)}
    </div>
    {!details.albums.length && <div className="empty-card photo-empty"><Camera size={32} /><h3>No albums yet</h3><p>{canContribute ? "Create the first private album for this event." : "Leaders will publish event photographs here."}</p></div>}
    {creating && <PhotoModal title="Create an album" onClose={() => setCreating(false)}><AlbumForm eventId={details.event.id} onDone={async (id) => { setCreating(false); await onRefresh(); await openAlbum(id); }} /></PhotoModal>}
    {guestsOpen && <PhotoModal title="Photo-only guests" onClose={() => setGuestsOpen(false)}><PhotoGuests eventId={details.event.id} /></PhotoModal>}
  </>;
}

function AlbumView({ eventId, data, canManage, canContribute, onBack, onRefresh }: { eventId: string; data: AlbumData | null; canManage: boolean; canContribute: boolean; onBack: () => void; onRefresh: () => Promise<void> }) {
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState("");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<AlbumPhoto | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [reportOpen, setReportOpen] = useState(false);

  async function upload(files: FileList | null) {
    if (!files?.length || !data) return;
    if (files.length > 20) { setError("Upload no more than 20 photographs or videos at once."); return; }
    setError("");
    try {
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const form = new FormData();
        if (["video/mp4", "video/webm", "video/quicktime"].includes(file.type)) {
          if (file.size > 40 * 1024 * 1024) throw new Error(`${file.name} is over the 40 MB video limit.`);
          form.set("video", file, file.name);
        } else {
          if (!file.type.startsWith("image/") || file.size > 25 * 1024 * 1024) throw new Error(`${file.name} is not a supported image under 25 MB.`);
          setUploading(`Preparing ${index + 1} of ${files.length}: ${file.name}`);
          const [original, display, thumbnail] = await processPhoto(file);
          form.set("original", original, "original.jpg"); form.set("display", display, "display.jpg"); form.set("thumbnail", thumbnail, "thumbnail.jpg");
        }
        form.set("caption", file.name.replace(/\.[^.]+$/, ""));
        setUploading(`Uploading ${index + 1} of ${files.length}: ${file.name}`);
        await api(`/api/events/${eventId}/albums/${data.album.id}/photos`, { method: "POST", body: form });
      }
      setUploading(""); if (input.current) input.current.value = ""; await onRefresh();
    } catch (cause) { setUploading(""); setError(cause instanceof Error ? cause.message : "The photographs could not be uploaded."); }
  }

  async function deleteAlbum() {
    if (!data || !window.confirm(`Delete “${data.album.title}” and every photograph in it? This cannot be undone.`)) return;
    await api(`/api/events/${eventId}/albums/${data.album.id}`, { method: "DELETE" }); onBack();
  }

  async function deleteSelected() {
    if (!data || !selectedIds.size || !window.confirm(`Delete ${selectedIds.size} selected item${selectedIds.size === 1 ? "" : "s"}? This cannot be undone.`)) return;
    await api(`/api/events/${eventId}/albums/${data.album.id}/photos/bulk-delete`, { method: "POST", body: JSON.stringify({ photoIds: [...selectedIds] }) });
    setSelectedIds(new Set()); await onRefresh();
  }

  if (!data) return <div className="admin-loading">Loading album…</div>;
  return <>
    <div className="album-toolbar"><button className="secondary-button" onClick={onBack}><ArrowLeft size={17} /> All albums</button>{canContribute && <div><input ref={input} className="file-input" type="file" accept="image/*,video/mp4,video/webm,video/quicktime,.mov" multiple onChange={(event) => void upload(event.target.files)} />{canManage && <button className="secondary-button" onClick={() => setReportOpen(true)}><ClipboardList size={16} /> Access</button>}{canManage && selectedIds.size > 0 && <button className="text-button" onClick={() => void deleteSelected()}><Trash2 size={16} /> Delete {selectedIds.size}</button>}<button className="primary-button" disabled={Boolean(uploading)} onClick={() => input.current?.click()}><Upload size={17} /> {uploading || "Upload media"}</button>{canManage && <button className="icon-button danger" title="Delete album" onClick={() => void deleteAlbum()}><Trash2 size={18} /></button>}</div>}</div>
    <header className="album-heading"><p className="eyebrow">{data.album.taken_on ? formatDay(data.album.taken_on) : "Event album"}</p><h2>{data.album.title}</h2>{data.album.description && <p>{data.album.description}</p>}</header>
    {!canManage && <div className="social-sharing-note"><ShieldCheck size={18} /><span>These are private event photographs. Please do not download, forward or post them on social media without permission from everyone shown.</span></div>}
    {canContribute && <p className="form-help">Short MP4, WebM and MOV videos are accepted up to 40 MB. MP4 has the widest browser support.{canManage ? " Select the circles on media tiles to remove several items together." : ""}</p>}
    {error && <p className="error-banner">{error}</p>}
    <div className="photo-grid">{data.photos.map((photo) => <div className="photo-select-wrap" key={photo.id}>{canManage && <label className="photo-select"><input type="checkbox" checked={selectedIds.has(photo.id)} onChange={(event) => setSelectedIds((current) => { const next = new Set(current); event.target.checked ? next.add(photo.id) : next.delete(photo.id); return next; })} /><span className="sr-only">Select {photo.caption || (photo.media_kind === "video" ? "video" : "photograph")}</span></label>}<button className="photo-tile" onClick={() => setSelected(photo)}>{photo.media_kind === "video" ? <span className="video-placeholder"><Video size={38} /><small>Video</small></span> : <img src={photo.thumbnailUrl!} alt={photo.caption || "Event photograph"} loading="lazy" />}<span>{photo.caption || (photo.media_kind === "video" ? "View video" : "View photograph")}</span></button></div>)}</div>
    {!data.photos.length && <div className="empty-card photo-empty"><ImagePlus size={32} /><h3>No photographs yet</h3><p>{canContribute ? "Upload processed photographs from a phone or computer." : "Photographs will appear here when leaders publish them."}</p></div>}
    {selected && <PhotoViewer eventId={eventId} photo={selected} canManage={canManage} onClose={() => setSelected(null)} onChanged={async () => { setSelected(null); await onRefresh(); }} />}
    {reportOpen && <PhotoModal title="Album access report" onClose={() => setReportOpen(false)}><AccessReport eventId={eventId} albumId={data.album.id} /></PhotoModal>}
  </>;
}

function AlbumForm({ eventId, onDone }: { eventId: string; onDone: (id: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    try { const result = await api<{ id: string }>(`/api/events/${eventId}/albums`, { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) }); await onDone(result.id); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create the album."); setBusy(false); }
  }
  return <form className="modal-form" onSubmit={submit}><label>Album title<input name="title" maxLength={120} placeholder="e.g. Saturday activities" required /></label><label>Date taken<input name="takenOn" type="date" /></label><label>Description<textarea name="description" rows={3} maxLength={500} /></label>{error && <p className="error-text">{error}</p>}<button className="primary-button" disabled={busy}>{busy ? "Creating…" : "Create album"}<Check size={17} /></button></form>;
}

function PhotoViewer({ eventId, photo, canManage, onClose, onChanged }: { eventId: string; photo: AlbumPhoto; canManage: boolean; onClose: () => void; onChanged: () => Promise<void> }) {
  const [caption, setCaption] = useState(photo.caption); const [busy, setBusy] = useState(false);
  async function save() { setBusy(true); await api(`/api/events/${eventId}/photos/${photo.id}`, { method: "PATCH", body: JSON.stringify({ caption }) }); await onChanged(); }
  async function remove() { if (!window.confirm(`Delete this ${photo.media_kind}? This cannot be undone.`)) return; setBusy(true); await api(`/api/events/${eventId}/photos/${photo.id}`, { method: "DELETE" }); await onChanged(); }
  return <PhotoModal title={photo.caption || (photo.media_kind === "video" ? "Event video" : "Event photograph")} wide onClose={onClose}>{photo.media_kind === "video" ? <video className="photo-viewer-image" src={photo.displayUrl} controls playsInline preload="metadata" /> : <img className="photo-viewer-image" src={photo.displayUrl} alt={photo.caption || "Event photograph"} />}<p className="photo-credit">Uploaded by {photo.uploaded_by_name}</p>{canManage && <div className="caption-editor"><label>Caption<input value={caption} maxLength={300} onChange={(event) => setCaption(event.target.value)} /></label><div><button className="secondary-button" disabled={busy} onClick={() => void save()}>Save caption</button><button className="text-button" disabled={busy} onClick={() => void remove()}><Trash2 size={15} /> Delete {photo.media_kind}</button></div></div>}</PhotoModal>;
}

function PhotoModal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; dialog.current?.querySelector<HTMLElement>("button, input, video")?.focus(); const key = (event: KeyboardEvent) => event.key === "Escape" && onClose(); window.addEventListener("keydown", key); return () => { window.removeEventListener("keydown", key); previous?.focus(); }; }, [onClose]);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section ref={dialog} className={`modal ${wide ? "photo-modal" : ""}`} role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button type="button" className="icon-button" aria-label="Close" onClick={onClose}><X /></button></header>{children}</section></div>;
}

function AccessReport({ eventId, albumId }: { eventId: string; albumId: string }) {
  type Viewer = { viewer_name: string; viewer_type: string; view_count: number; media_count: number; last_viewed_at: string };
  const [viewers, setViewers] = useState<Viewer[] | null>(null);
  useEffect(() => { void api<{ viewers: Viewer[] }>(`/api/events/${eventId}/albums/${albumId}/access-report`).then((result) => setViewers(result.viewers)); }, [eventId, albumId]);
  if (!viewers) return <p className="conversation-loading">Loading access report…</p>;
  return <div className="access-report">{viewers.length ? viewers.map((viewer) => <div key={`${viewer.viewer_type}-${viewer.viewer_name}`}><strong>{viewer.viewer_name}</strong><span>{viewer.viewer_type} · {viewer.media_count} item{viewer.media_count === 1 ? "" : "s"} · {viewer.view_count} view{viewer.view_count === 1 ? "" : "s"}</span><small>Last viewed {new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(viewer.last_viewed_at))}</small></div>) : <p>No parent or guest has opened media in this album yet.</p>}</div>;
}

function PhotoGuests({ eventId }: { eventId: string }) {
  type Guest = { id: string; email: string; display_name: string; status: string; access_ends_at: string };
  const [guests, setGuests] = useState<Guest[]>([]); const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
  const load = () => api<{ guests: Guest[] }>(`/api/events/${eventId}/photo-guests`).then((result) => setGuests(result.guests));
  useEffect(() => { void load(); }, [eventId]);
  async function invite(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setBusy(true); setMessage(""); const form = event.currentTarget; try { await api(`/api/events/${eventId}/photo-guests`, { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) }); form.reset(); setMessage("Photo invitation sent."); await load(); } catch (error) { setMessage(error instanceof Error ? error.message : "Could not invite this guest."); } finally { setBusy(false); } }
  async function revoke(guest: Guest) { if (!window.confirm(`Remove photo access for ${guest.display_name}?`)) return; await api(`/api/events/${eventId}/photo-guests/${guest.id}`, { method: "DELETE" }); await load(); }
  return <div className="photo-guests"><p>Invite a grandparent or other trusted person to photographs only. They cannot see messages, parent details or other CampComms areas.</p><form className="modal-form guest-form" onSubmit={invite}><label>Name<input name="displayName" required maxLength={100} /></label><label>Email address<input name="email" type="email" required /></label><button className="primary-button" disabled={busy}>{busy ? "Sending…" : "Send photo invitation"}</button>{message && <p className="inline-message" role="status">{message}</p>}</form><div className="guest-list">{guests.map((guest) => <div key={guest.id}><span><strong>{guest.display_name}</strong><small>{guest.email} · {guest.status}</small></span>{guest.status !== "revoked" && <button className="text-button" onClick={() => void revoke(guest)}>Remove</button>}</div>)}</div></div>;
}

async function processPhoto(file: File) {
  const url = URL.createObjectURL(file);
  try {
    const image = await loadImage(url);
    const original = await resizeLoadedPhoto(image, 2400, .9);
    const display = await resizeLoadedPhoto(image, 1400, .82);
    const thumbnail = await resizeLoadedPhoto(image, 420, .74);
    return [original, display, thumbnail] as const;
  } finally { URL.revokeObjectURL(url); }
}
async function resizeLoadedPhoto(image: HTMLImageElement, maxDimension: number, quality: number) {
  const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale)); const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d"); if (!context) throw new Error("This browser cannot process photographs.");
  context.fillStyle = "#fff"; context.fillRect(0, 0, width, height); context.drawImage(image, 0, 0, width, height);
  return await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => resolve(blob ?? new Blob()), "image/jpeg", quality)).then((blob) => {
    canvas.width = 1; canvas.height = 1;
    if (!blob.size) throw new Error("The photograph could not be processed.");
    return blob;
  });
}
function loadImage(url: string) { return new Promise<HTMLImageElement>((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error("One of the selected files is not a readable image.")); image.src = url; }); }
function formatDay(value: string) { return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`)); }

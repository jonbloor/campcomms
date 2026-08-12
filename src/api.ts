export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (!(options.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(path, {
    ...options,
    credentials: "include",
    headers,
  });
  const payload = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new ApiError(payload.error ?? "Request failed.", response.status);
  return payload as T;
}

export type EventSummary = {
  id: string; slug: string; name: string; summary: string; location: string | null;
  starts_at: string; ends_at: string; status: string; role: string; section: "squirrels" | "beavers" | "cubs" | "scouts" | null;
  announcement_count: number; photo_count: number;
};

export type EventDetails = {
  event: EventSummary & { posting_closes_at: string; read_only_until: string; purge_after: string };
  membership: { role: string; can_view_private: number; can_reply_private: number; can_post_announcements: number };
  unread_counts: { discussions: number; lost_found: number; lifts: number; private_messages: number; access_requests: number };
  announcements: Array<{ id: string; title: string; body: string; importance: string; acknowledgement_required: number; acknowledged: number; acknowledgement_count: number; view_count: number; author_name: string; author_parent_of: string; author_role: string; published_at: string }>;
  topics: Array<{ id: string; title: string; category: string; kind: "discussion" | "lost" | "found"; audience: "everyone" | "leaders"; is_locked: number; author_name: string; author_parent_of: string; author_role: string; reply_count: number; last_reply_at: string | null; created_at: string; unread: number }>;
  lifts: Array<{ id: string; kind: string; journey: string; area: string; seats: number; journey_at: string; note: string; status: string; author_id: string; author_name: string; author_parent_of: string; author_role: string; response_count: number; unread: number }>;
  albums: Array<{ id: string; title: string; description: string; taken_on: string | null; photo_count: number; cover_photo_id: string | null }>;
};

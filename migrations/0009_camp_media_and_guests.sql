ALTER TABLE photos ADD COLUMN media_kind TEXT NOT NULL DEFAULT 'photo' CHECK (media_kind IN ('photo', 'video'));
ALTER TABLE photos ADD COLUMN video_key TEXT;
ALTER TABLE topics ADD COLUMN audience TEXT NOT NULL DEFAULT 'everyone' CHECK (audience IN ('everyone', 'leaders'));

CREATE TABLE photo_guests (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'revoked')),
  access_ends_at TEXT NOT NULL,
  invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(event_id, email)
);

CREATE TABLE photo_guest_links (
  id TEXT PRIMARY KEY,
  guest_id TEXT NOT NULL REFERENCES photo_guests(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE photo_guest_sessions (
  id TEXT PRIMARY KEY,
  guest_id TEXT NOT NULL REFERENCES photo_guests(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE photo_views (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  album_id TEXT NOT NULL REFERENCES photo_albums(id) ON DELETE CASCADE,
  photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  viewer_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  guest_id TEXT REFERENCES photo_guests(id) ON DELETE SET NULL,
  viewed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((viewer_user_id IS NOT NULL AND guest_id IS NULL) OR (viewer_user_id IS NULL AND guest_id IS NOT NULL))
);

CREATE INDEX idx_photo_views_album ON photo_views(album_id, viewed_at DESC);
CREATE INDEX idx_photo_guests_event ON photo_guests(event_id, status);
CREATE INDEX idx_photo_guest_links_hash ON photo_guest_links(token_hash, expires_at);
CREATE INDEX idx_photo_guest_sessions_hash ON photo_guest_sessions(token_hash, expires_at);

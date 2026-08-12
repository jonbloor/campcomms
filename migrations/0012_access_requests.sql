CREATE TABLE event_access_settings (
  event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  accepting_requests INTEGER NOT NULL DEFAULT 0 CHECK (accepting_requests IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE access_requests (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  display_name TEXT NOT NULL,
  parent_of TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  requested_ip_hash TEXT NOT NULL,
  reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX idx_access_requests_pending ON access_requests(event_id, email) WHERE status = 'pending';
CREATE INDEX idx_access_requests_event ON access_requests(event_id, status, created_at DESC);
CREATE INDEX idx_access_requests_ip ON access_requests(requested_ip_hash, created_at DESC);

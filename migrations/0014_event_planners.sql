CREATE TABLE IF NOT EXISTS event_planners (
  event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  document_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_event_planners_updated_at ON event_planners(updated_at);

PRAGMA foreign_keys = ON;

CREATE TABLE event_invitations (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_by TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('parent', 'leader', 'event_admin', 'safeguarding')),
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'delivered', 'failed', 'accepted', 'revoked')),
  provider_id TEXT,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_event_invitations_event ON event_invitations(event_id, created_at DESC);
CREATE INDEX idx_event_invitations_user ON event_invitations(user_id, event_id, created_at DESC);

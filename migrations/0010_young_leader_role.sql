PRAGMA foreign_keys = OFF;

CREATE TABLE event_memberships_new (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('parent', 'young_leader', 'leader', 'event_admin', 'safeguarding')),
  joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  access_ends_at TEXT,
  can_view_private INTEGER NOT NULL DEFAULT 0 CHECK (can_view_private IN (0, 1)),
  can_reply_private INTEGER NOT NULL DEFAULT 0 CHECK (can_reply_private IN (0, 1)),
  can_post_announcements INTEGER NOT NULL DEFAULT 0 CHECK (can_post_announcements IN (0, 1)),
  PRIMARY KEY (event_id, user_id)
);

INSERT INTO event_memberships_new
SELECT event_id, user_id, role, joined_at, access_ends_at, can_view_private, can_reply_private, can_post_announcements
FROM event_memberships;
DROP TABLE event_memberships;
ALTER TABLE event_memberships_new RENAME TO event_memberships;
CREATE INDEX idx_memberships_user ON event_memberships(user_id, event_id);

CREATE TABLE event_invitations_new (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_by TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('parent', 'young_leader', 'leader', 'event_admin', 'safeguarding')),
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'delivered', 'failed', 'accepted', 'revoked')),
  provider_id TEXT,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO event_invitations_new
SELECT id, event_id, user_id, invited_by, role, status, provider_id, expires_at, accepted_at, created_at
FROM event_invitations;
DROP TABLE event_invitations;
ALTER TABLE event_invitations_new RENAME TO event_invitations;
CREATE INDEX idx_event_invitations_event ON event_invitations(event_id, created_at DESC);
CREATE INDEX idx_event_invitations_user ON event_invitations(user_id, event_id, created_at DESC);

PRAGMA foreign_keys = ON;

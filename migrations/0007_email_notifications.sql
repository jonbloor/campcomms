ALTER TABLE users ADD COLUMN email_notification_preference TEXT NOT NULL DEFAULT 'none'
  CHECK (email_notification_preference IN ('daily', 'important_only', 'none'));
ALTER TABLE users ADD COLUMN digest_last_checked_at TEXT;
ALTER TABLE users ADD COLUMN digest_last_sent_at TEXT;
ALTER TABLE events ADD COLUMN section TEXT CHECK (section IN ('squirrels', 'beavers', 'cubs', 'scouts'));

CREATE TABLE email_unsubscribe_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_email_unsubscribe_tokens_hash
  ON email_unsubscribe_tokens(token_hash, expires_at);

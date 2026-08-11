PRAGMA foreign_keys = ON;

ALTER TABLE users ADD COLUMN parent_of TEXT NOT NULL DEFAULT '';

CREATE INDEX idx_push_subscriptions_user ON push_subscriptions(user_id, created_at DESC);

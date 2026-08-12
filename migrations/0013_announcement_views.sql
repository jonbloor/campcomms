CREATE TABLE announcement_views (
  announcement_id TEXT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  first_viewed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_viewed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (announcement_id, user_id)
);

CREATE INDEX idx_announcement_views_announcement ON announcement_views(announcement_id, first_viewed_at);

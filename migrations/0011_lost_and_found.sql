ALTER TABLE topics ADD COLUMN kind TEXT NOT NULL DEFAULT 'discussion'
  CHECK (kind IN ('discussion', 'lost', 'found'));

CREATE INDEX idx_topics_event_kind ON topics(event_id, kind, updated_at DESC);

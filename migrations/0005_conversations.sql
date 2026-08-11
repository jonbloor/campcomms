CREATE TABLE content_reads (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('topic', 'lift', 'private_thread')),
  resource_id TEXT NOT NULL,
  last_read_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, resource_type, resource_id)
);

CREATE INDEX idx_content_reads_resource ON content_reads(resource_type, resource_id, user_id);

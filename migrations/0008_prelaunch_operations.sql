ALTER TABLE email_deliveries ADD COLUMN event_id TEXT REFERENCES events(id) ON DELETE SET NULL;
CREATE INDEX idx_email_deliveries_event ON email_deliveries(event_id, created_at DESC);
CREATE INDEX idx_email_deliveries_user ON email_deliveries(user_id, created_at DESC);

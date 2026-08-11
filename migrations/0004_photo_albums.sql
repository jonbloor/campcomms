PRAGMA foreign_keys = ON;

CREATE INDEX idx_photos_album ON photos(album_id, created_at DESC);

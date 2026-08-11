ALTER TABLE event_memberships ADD COLUMN can_view_private INTEGER NOT NULL DEFAULT 0 CHECK (can_view_private IN (0, 1));
ALTER TABLE event_memberships ADD COLUMN can_reply_private INTEGER NOT NULL DEFAULT 0 CHECK (can_reply_private IN (0, 1));
ALTER TABLE event_memberships ADD COLUMN can_post_announcements INTEGER NOT NULL DEFAULT 0 CHECK (can_post_announcements IN (0, 1));

UPDATE event_memberships
SET can_view_private = 1, can_reply_private = 1, can_post_announcements = 1
WHERE role = 'event_admin';

UPDATE event_memberships
SET can_view_private = 1, can_reply_private = 1
WHERE role = 'safeguarding';

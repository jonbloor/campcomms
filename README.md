# 4th Ashby CampComms

A private, event-scoped progressive web application for parents and leaders. It is designed for camps, day trips, sleepovers and other activities without exposing personal telephone numbers.

## Current milestone

- Branded expired-invitation and not-found pages with useful recovery actions
- Direct photo-guest gallery routing for fresh browsers without a cached PWA shell
- Distinct Young Leader event role and badge
- Young Leader access to announcements, all discussions and photo/video contribution
- Young Leader exclusion from private messages, lift sharing and adult administration
- Photo and video access auditing with an administrator album access report
- Optional bulk media deletion and short MP4, WebM and MOV uploads
- Keyboard-safe photo/video viewer with Escape-to-close and restored focus
- Photo-only guest invitations for grandparents and other trusted relatives
- Parent album-level social-sharing guidance
- Leader-only discussion topics for internal, non-urgent notes
- Announcement deletion with the same permission model as announcement editing
- Thirty-day parent and leader sign-in sessions
- Retention tests covering D1 deletion with all three R2 image variants and video objects
- Pre-launch responsive UI, accessibility and failure-state review
- Mobile event switching and sign-out controls
- Keyboard focus management, skip navigation and reduced-motion support
- Offline and load-retry feedback
- Administrator notification adoption and email-delivery health summary
- Safer confirmation-based email unsubscribe flow
- Parent-controlled daily summaries, important-announcement-only emails or no update emails
- Privacy-safe daily summaries at 18:00 UK time, skipped when nothing changed
- One-click unsubscribe links and delivery records
- Squirrels, Beavers, Cubs and Scouts event tags with event-switcher indicators
- Server-derived leader badges beside leader, safeguarding and administrator names
- Announcement creation and editing for authorised leaders
- Parent-by-parent announcement acknowledgement reporting
- Unread navigation badges for discussions, lift sharing and private messages
- Private-message filters for all, unread, open and closed conversations
- Direct notification links to specific announcements and conversations
- Event-specific permissions for viewing/replying to private messages and posting announcements
- Safeguarding and administrator permission defaults with audited changes
- Administrator deletion of complete discussions, private conversations and lift-share conversations
- CampComms sender name and purple email actions
- Production login screen without local-preview controls
- Full public discussion conversations with replies and leader locking
- Full private message conversations with leader close/reopen controls
- Lift-share response conversations with arranged and withdrawn states
- Per-person unread indicators and deep links from push notifications
- Author and leader moderation with audit records
- Visual styling aligned with the public 4th Ashby website

- Private R2-backed event photo albums
- Leader album creation, mobile uploads, captions and deletion
- Browser-side resizing and metadata stripping before upload
- Authenticated image delivery with no public R2 URLs
- Self-service name/nickname and separate “Parent of” identity
- Opt-in browser push notifications on each supported device
- Push alerts for leader announcements and privacy-safe private replies
- Reusable event creation and lifecycle controls
- Administrator participant list and event-scoped role management
- Individual and bulk parent/leader invitations with delivery status
- Revocable access and invitation audit history
- Passwordless email sign-in through Resend
- Individual parent and leader identities
- Event-scoped roles and expiring access
- Leader announcements with parent acknowledgements
- Public, threaded event discussions
- Structured lift offers and requests
- Private parent-to-leadership conversations
- D1 audit and retention records
- R2 photo schema and storage binding ready for the photo migration
- Installable PWA shell and notification service worker
- Daily expiry of sessions, links, lift posts, event data and photograph objects

Version 1.1.0 adds a dedicated **Lost & Found** area to **CampComms** at `campcomms.4thashby.org.uk`. Event members can list and discuss lost or found items; the person who listed an item can mark it resolved or reopen it, leaders can moderate it, and administrators can delete it. The former Campfire, Events and legacy Photos addresses remain retired.

Lost & Found remains writable until the event's configured `read_only_until` date, even after normal event posting closes. It becomes read-only after that point and is deleted with all other event data at `purge_after`.

Version 1.1.1 makes emailed sign-in and photo-guest invitation links resistant to email-security scanners. Opening a link now presents a confirmation button; the one-time token is consumed only when the recipient explicitly continues.

Production deployments are built automatically by Cloudflare Workers Builds when a reviewed commit reaches the `main` branch of the private GitHub repository.

## Local development

Requirements: Node.js 20 or later and a current Wrangler 4 release.

```sh
npm install
cp .dev.vars.example .dev.vars
npm run cf-typegen
npm run db:migrate:local
npm run dev
```

## Production resources

Before the first deployment:

1. Confirm `4thashby.org.uk` is active in the intended Cloudflare account.
2. Create or automatically provision the `events-db` D1 database.
3. Create the `fourth-ashby-events-photos` R2 bucket.
4. Apply D1 migrations remotely.
5. Verify `notify.events.4thashby.org.uk` in Resend with SPF, DKIM and DMARC.
6. Add `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` and `VAPID_PRIVATE_KEY` using Cloudflare secrets.
7. Configure the Resend webhook at `https://campcomms.4thashby.org.uk/api/resend/webhook`.
8. Deploy and test an invited parent account before importing a real event.

Never put production API keys or webhook secrets in `wrangler.jsonc`, `.dev.vars.example`, source code or version control.

## Data boundaries

- Parents cannot privately message other parents.
- Private messages are visible only to the opening parent and authorised event leaders.
- Leader-only discussions are visible to Young Leaders, event leaders, safeguarding leads and event administrators.
- Young Leaders can access leader-only discussions but cannot access private messages or lift sharing.
- Photo-only guests can view private event media but cannot access messages, participant details or the parent application.
- Email notifications contain no private message body, health information, addresses or photographs.
- Original camera files never leave the browser: resized JPEG variants are generated first, stripping EXIF location metadata.
- R2 objects have no public URLs and are served only after event-membership checks.
- Lift posts request approximate areas only.
- The service is explicitly not intended for emergencies.
- Event access, posting closure, read-only and purge dates are stored separately.

## Commands

```sh
npm run build
npm run test
npm run deploy:dry
npm run cf-typegen
```

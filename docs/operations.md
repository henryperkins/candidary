# Operations runbook

## Scheduled lifecycle work

Two triggers share one handler and are selected by `controller.cron`.

The hourly `47 * * * *` handler delivers lifecycle email from the outbox and runs one bounded media
promotion pass. Those promises have independent failure boundaries: promotion cannot abort
notification delivery, and one promotion row cannot abort the rest of its pass.

The daily `17 3 * * *` handler performs these idempotent phases in order:

1. Sweep expired and consumed pending registrations, expired login challenges, and rate-limit buckets older than the enforcement window, in repeated bounded passes until each table is drained.
2. Sweep expired or revoked RSVP sessions and lookup rate windows older than one 15-minute bucket, in the same bounded 100-row passes capped at 50 per run. Both statements report counts only; neither can name a household, a guest, or a scope.
3. Delete expired album-share sessions in 100-row statements, stopping after a short batch or 50 batches (5,000 rows) in one invocation. A stopped share removes its sessions immediately through the share row's foreign-key cascade; this bounded sweep is for ordinary seven-day session expiry.
4. Delete objects for upload reservations older than fifteen minutes and release event counters.
5. Run the same bounded durable media promotion pass used by the hourly trigger.
6. Delete every manifest and numbered archive for exports past their 24-hour window, then mark those jobs expired.
7. Resolve globally bounded backfill jobs whose exact legacy source is no longer current, rotating still-current blockers fairly rather than letting the oldest 100 starve newer work.
8. Recover stale initial backfill creates with the same stored Workflow ID, then confirm their existing generation/fence.
9. Reconcile retryable backfill jobs with platform status. Guarded Worker transitions own resume and restart. A successful `unknown` or unmapped status changes nothing. A failed lookup remains classified `unknown`, but after the exact D1/fence/generation/currentness/capacity/checkpoint claim succeeds the Worker replays its deterministic ID through idempotent `createBatch`; a retained ID is skipped, an absent ID is created, and an invalid ID is rejected.
10. Close eligible backfill and verification runs. The Worker re-derives the four zero-legacy predicates inside the status-changing statement; no operator payload writes `verified_at`.
11. Sweep cover drafts, previews, retired sets/masters/originals, receipts, fences, jobs, and closed runs in bounded classes, deleting R2 before the inventory row that named an object.
12. Resume retention-due or already soft-deleted event purges. Cover fences are coordinated before R2, and cover children are deleted before the event. A failed purge remains selected on later passes rather than stranding objects.

Re-running cleanup is safe because D1 transitions and R2 deletes are idempotent.

Backfill selection and each cover-cleanup class are bounded at 100 rows. One event-purge pass inspects
at most 10 fences and performs at most five platform mutations. Saturation is scheduling information,
not quiescence; later safety phases still run within their own bounds, and another pass must confirm a
backlog is empty. These in-process summaries are not emitted as structured logs or exposed through an
operator route.

## Deployment boundary

Routine code deployment is intentionally separate from operations that mutate durable data. A merge
to protected `main` is built once by Cloudflare and that generated artifact is deployed directly.
The full Git commit SHA is the Worker version tag. See [deployment.md](deployment.md) for the exact
commands, required checks, isolated preview topology, and rollback procedure.

Migration `0011_release_certifications.sql` remains in the immutable D1 history. Its table is unused;
there is no repository, route, scheduled job, deploy hook, local evidence generator, or readiness gate
that reads or writes it. Do not insert certification rows. A future schema cleanup may remove the
unused table through a new forward migration, but an applied migration file must never be rewritten or
deleted.

## Delivery and publication

A finalized `stored` media row is a private host delivery. Its `publication_status` is independently `unpublished`, `published`, or `hidden`; changing publication never changes private retention or export eligibility. Originals are never guest-readable. Cached previews use separate R2 keys and can be regenerated without changing the original.

One event permits 10,000 photos, 100 GiB of originals, and 20 MB per photo. Guests reserve metadata in ordered batches of 20 with one aggregate event-counter write, then transfer at most two files concurrently per device. Capacity failures are per-file; accepted siblings remain valid. In canonical-live mode each reservation returns an authenticated same-origin content URL, never an R2 presigned URL.

An expired same-origin content URL is refreshed against the same reservation. The Worker reauthorizes
the session and CSRF token immediately before accepting bytes, validates exact declared size, MIME,
header signature, and dimensions, creates the deterministic canonical object only if absent, re-reads
the complete object, and commits the canonical D1 generation. A transient confirmation failure can
observe the already Stored row without sending the bytes again.

### Manager upload authority and management-link rotation (0021)

Manager uploads use the same reservation, buffering, R2, promotion, and commit path as guest uploads.
The route constructs one of two Manager authorities; the client never supplies one. A
management-link Manager uses the authenticated Manager event session. An account owner or cohost uses
one live server-only `event_sessions` actor for `(event_id, manager_upload_account_id)`, bound to the
event's current live Manager token. The actor stores random secret and CSRF digests whose source
secrets are discarded. It is identity storage only: it cannot mint a cookie, and browser session
resolution rejects an actor row before comparing any secret. Reservation may create/reuse this actor;
content, finalize, and cancel are lookup-only and never create one while probing an upload.

Authority and intake are independent SQL predicates. Reserve, idempotent refresh, post-buffer claim,
commit, and cancel all re-prove the target event and exact authority. Guest authority still carries
the guest schedule and pause predicate. Both Manager authorities ignore only that guest predicate;
they still require a live management window, Worker ingress, capacity, and all file and promotion
checks. Manager attribution is always the server-owned `guest_name = 'Host'`.

Management-link rotation compares the client-observed `manager_link_revision`, increments it with a
CAS, revokes the exact predecessor only for that CAS winner, and inserts the replacement only for that
revoke winner. The same D1 batch revokes predecessor bearer sessions, rebinds live account actors to
the replacement, and terminally cancels the predecessor link actor's `reserved` and `failed` rows
with exact counter deltas. Account-owned reservations survive. Every optional statement is guarded
independently by the replacement token ID, never by a timestamp or the previous optional statement's
change count. Post-commit object deletion remains tombstone/janitor owned if R2 deletion fails.

The following read-only query finds account actors that are still marked live but are no longer usable
because their account, membership, event, expiry, or current-token binding is invalid. A healthy row
has an active account, owner/cohost membership, a live management window, a future actor expiry, and
`current_token_id = actor_token_id`. Rotation should rebind the token, and membership removal should
revoke the actor, so any returned row is an invariant alarm; do not repair it by creating a cookie or
reconstructing a discarded secret.

```sql
SELECT
  s.id AS actor_id,
  s.event_id,
  s.manager_upload_account_id AS account_id,
  s.access_token_id AS actor_token_id,
  current_token.id AS current_token_id,
  s.expires_at AS actor_expires_at,
  account.disabled_at AS account_disabled_at,
  membership.role AS membership_role,
  event.deleted_at AS event_deleted_at,
  event.management_access_expires_at
FROM event_sessions AS s
JOIN events AS event ON event.id = s.event_id
LEFT JOIN host_accounts AS account ON account.id = s.manager_upload_account_id
LEFT JOIN event_hosts AS membership
  ON membership.event_id = s.event_id
 AND membership.account_id = s.manager_upload_account_id
LEFT JOIN event_access_tokens AS current_token
  ON current_token.event_id = s.event_id
 AND current_token.role = 'manager'
 AND current_token.revoked_at IS NULL
 AND current_token.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE s.manager_upload_account_id IS NOT NULL
  AND s.revoked_at IS NULL
  AND (
    s.expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    OR account.id IS NULL
    OR account.disabled_at IS NOT NULL
    OR membership.role IS NULL
    OR membership.role NOT IN ('owner', 'cohost')
    OR event.deleted_at IS NOT NULL
    OR event.management_access_expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    OR current_token.id IS NULL
    OR current_token.id <> s.access_token_id
  )
ORDER BY s.event_id, s.manager_upload_account_id;
```

### Distinct-bucket media cutover

Migration 0015 records `legacy` or `canonical` generation on every media and export pointer. The legacy
bucket remains readable only for recorded legacy rows; new canonical-live uploads write through the
authenticated Worker to the distinct canonical bucket. Content, preview, export, delete, and cleanup
paths choose the bucket from the recorded generation and never probe a fallback bucket.

The three runtime modes are exact. Candidate A (`canonical-cutover-disabled`) disables ingress, legacy
copy, pointer cutover, and relational purge. Copy-only (`canonical-copy-only`) enables only legacy
copy. Candidate B (`canonical-live`) enables all four. All three keep single/batch presigning, replay
presigning, reserved finalization, and export-download presigning false.

Copy-only claims a live legacy Stored row, conditionally reads its exact ETag, and validates MIME,
size, image header, width, height, and SHA-256. It writes the deterministic canonical key create-only,
then re-reads and hashes the complete canonical object before persisting immutable
`target_verified` proof. Copy-only never changes the media pointer. The one primary readiness query
must report zero live legacy rows lacking that exact proof before Candidate B is eligible to cut over
pointers.

Candidate B performs the exact proof-bound D1 pointer CAS and clears any legacy preview pointer. It
then hands legacy-source cleanup to permanent write tombstones. `source_writable_until` schedules
work but is never evidence that old writes are finished. The legacy bucket scanner and tombstone
janitor continue forever; completed scans wrap into another epoch so an arbitrarily late admitted
legacy write is rediscovered and suppressed.

After the first canonical pointer, rollback is limited to a reviewed schema-15 dual-bucket Candidate
A-compatible version with ingress, promotion, and purge disabled. Never route the old Worker or schema
14 again, and never restore a raw pre-0015 D1 state. Token revocation, TTL expiry, waiting, repeated
HEAD requests, or a bucket lock cannot replace the permanent scanner/tombstone protocol.

Closed gallery, delivery-history, and notes sections do not fetch their data or previews. The manager's visible Live intake refreshes event counts and private media every five seconds; polling pauses outside Intake and while the document is hidden.

## Album sharing and album exports

Provision `ALBUM_SHARE_HMAC_KEY` and `ALBUM_SHARE_ENCRYPTION_KEY` as independent Worker secrets in
every environment before deploying this schema. The HMAC value must be an independent high-entropy
secret of at least 32 random bytes. The encryption value must decode from unpadded base64url to
exactly 32 bytes for AES-256-GCM. Preview and production values must also be independent from each
other. With shell tracing disabled, pipe generated values directly to the intended environment:

```bash
# Preview pair
node -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('base64url'))" | npx wrangler secret put ALBUM_SHARE_HMAC_KEY --env preview --config wrangler.jsonc
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))" | npx wrangler secret put ALBUM_SHARE_ENCRYPTION_KEY --env preview --config wrangler.jsonc

# Independently generated production pair
node -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('base64url'))" | npx wrangler secret put ALBUM_SHARE_HMAC_KEY --config wrangler.jsonc
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))" | npx wrangler secret put ALBUM_SHARE_ENCRYPTION_KEY --config wrangler.jsonc
```

Never copy either value into `wrangler.jsonc`, a migration, a log, or a ticket. `npm run
verify:bindings` proves the binding names, not that production holds usable secret material.

One active share admits at most 2,000 sessions whose expiry is later than the exchange time. Expired
rows do not consume a slot. The count and insert run in one D1 batch, so concurrent exchanges cannot
both claim the final slot. At capacity, exchange returns `RATE_LIMITED` with HTTP 429 and a
`Retry-After` derived from the earliest still-active session expiry; the caller should not retry before
that delay. Admission also verifies the share in the same transaction, so a concurrent stop wins as
revocation rather than leaving an orphan session.

**Stop sharing is the supported revocation operation.** It deletes the event's one
`event_album_shares` row; D1 cascades that deletion to every `event_album_share_sessions` row. The
fragment link, existing seven-day cookies, album reads, and album preview reads then all return the
same unavailable response. Enabling sharing again creates a different credential; an old link never
becomes valid again. An enable that observed the old row before a concurrent stop may return that
observed URL, but it cannot recreate the deleted row or authorize a session. The daily cleanup removes
naturally expired sessions in 100-row batches, with a 50-batch/5,000-row ceiling per invocation; a
larger backlog is continued by the next daily pass.

Do not rotate either album-share key as an ordinary session-key change. A deliberate invalidating
rotation must use a maintenance window: revoke all active shares (and verify both share and session
counts are zero), replace both Worker secrets together in every target environment, deploy, then let
hosts create new links. Preserving active links instead requires a reviewed forward migration that,
while the old keys are still available, decrypts each stored secret and atomically writes its digest
and ciphertext under the new independent keys. No such migration is shipped by this repository.

Library **Download all** creates a `complete` export: every stored, non-deleted original plus the
photo manifest and printable/private Guestbook artifacts frozen at creation. Album **Download album
photos** creates an `album` export from the album's immutable ordered photo snapshot; it omits
Guestbook artifacts and never expands when the album later changes. Both kinds write manifest/ZIP
artifacts with a 24-hour Ready window. The pre-0020 daily cleanup deletes expired objects before
marking the job expired; that legacy ordering is an explicit release hazard covered by the 0020
admission gate below. Current cleanup first wins the exact Ready-to-Expired transition and captures
that winner's complete top-level and part inventory atomically, then deletes only those keys and
clears only that same expired inventory. An R2 failure leaves the inventory on the Expired row for a
bounded later recovery pass. Immutable snapshot rows remain available for an authorized retry until
event purge.

## Public pages, crawlers, and agents

Four URLs are public: `/`, `/create`, `/privacy`, and `/terms`. `public/sitemap.xml` lists exactly
those, and `public/robots.txt` disallows every other prefix — `/api/`, `/event/`, `/manage/`,
`/join`, `/recover/`, and `/host/`.

`robots.txt` also declares one preference for the wildcard group,
`Content-Signal: search=yes, ai-input=yes, ai-train=no`: indexable, readable to answer a live
question, refused as model training data. It sits inside the group and above the first `Disallow`,
because a blank line ends a robots group and a directive past one applies to nobody. Changing the
declaration is that line plus its pin in `tests/unit/discoverability-assets.test.ts`.

Those same four URLs answer `Accept: text/markdown` with markdown rather than the SPA shell
(`worker/http/agent-markdown.ts`). The site is client-rendered, so an HTML-to-markdown converter at
the edge — Cloudflare's zone-level Markdown for Agents included — would convert an empty shell. The
documents are built in the Worker instead, from the `shared/site-content.ts` copy the React pages
render and the `shared/constants.ts` ceilings the upload routes enforce. A negotiated answer carries
`Content-Type: text/markdown; charset=utf-8`, `Vary: Accept`, `Cache-Control: public, max-age=300`,
an estimated `X-Markdown-Tokens`, and a canonical `Link`. The HTML answer to the same four URLs
carries `Vary: Accept` as well, so no cache can hand a shell to a client that asked for markdown.

Only a client that names `text/markdown`, and does not rank `text/html` above it, is served markdown.
Every browser sends a catch-all range, so a wildcard never selects it. Nothing else negotiates: no
event, manager, host, or entry URL has a markdown form, and none should acquire one — the delivery
routes are where authorization is written, and this middleware has none of it.

## Export jobs

Only one queued or running export exists per event. A request snapshots every stored, non-deleted
original at `snapshot_at`, regardless of publication, but fails with `EXPORT_MEDIA_UPGRADE_REQUIRED`
while any eligible stored row still uses a noncanonical key. Retry after scheduled promotion closes
that inventory; do not bypass the gate or snapshot a writable alias. The Workflow partitions source
payload at 2 GiB, streams numbered store-mode ZIP archives through multipart R2 upload, and creates
`candidary-export-manifest.csv` covering every file and part.

Each retry increments `attempt`, uses a new deterministic Workflow ID/prefix, and clears prior persisted part rows in D1 before establishing or adopting that exact Workflow. Only after the new attempt is recoverable are captured prior-attempt objects deleted. Ready objects expire after 24 hours; managers read them through authenticated same-origin conditional/ranged streaming rather than presigned download URLs.

Post-cutover exports also freeze Guestbook snapshot metadata and entries. They produce a guest-visible
printable HTML keepsake and a separate private CSV archive; the private CSV may include author-only
content and is never a guest download. Both objects share the 24-hour Ready expiry and are deleted
only after the exact job becomes Expired with its inventory retained for recovery; successful R2
deletion then clears the exact expired inventory. Event purge removes the objects, dependent snapshot
rows, notes/captions, and finally the event in that order.

Investigate:

- `EXPORT_SOURCE_MISSING` as an R2/D1 consistency failure.
- `EXPORT_SNAPSHOT_CHANGED` as deletion or mutation inside a captured snapshot.
- `EXPORT_PART_LIMIT_EXCEEDED` as a configuration error because one accepted original is far below the 2 GiB part limit.

## RSVP and photo entry

One permanent credential is printed on the invitation. `GET /api/manage/events/:eventId/entry` returns
`{ eventLink, disabledAt }` and is the only way to redisplay it; the response is `no-store` because it
carries the credential in full.

Two host actions look similar and are not:

- **Sign out guest devices** (`POST .../guest-sessions/rotate`) replaces the internal guest grant.
  Every guest must rescan. The event link and every printed QR are byte-identical afterwards. Confirm
  by typing the exact event name.
- **Disable printed event QR** (`POST .../entry/disable`) is irreversible. It pauses RSVP and photo
  intake, revokes guest and household sessions, and makes every printed invitation and sign stop
  working. There is no replacement and no re-enable. Rehearse it only on a disposable event, and
  verify afterwards that manager access still works while both future scans and existing guest and
  household sessions do not.

`uploads_enabled` means photo delivery is **permitted** for this event, not that it is open. Three
stored values decide what a guest actually sees:

- `uploads_enabled` — capability. A new event is created with it on.
- `event_start_at` — the schedule. It is derived server-side from `event_date`, the host's local
  start time, and `event_timezone`, and it opens photo delivery by itself. Nothing has to be run and
  nobody has to remember anything on the day of the event.
- `photos_open_from` — `NULL` normally. A non-null value is a manual early opening and holds the
  server instant at which the host performed it.

`POST /api/manage/events/:eventId/photo-intake` takes one of four explicit actions and never a client
timestamp. Which one is legal is decided in SQL against the row as it stands, not against the state a
manager page read earlier:

| Action | Legal from | Effect |
| --- | --- | --- |
| `open_early` | `scheduled` — permitted, before the start, not already opened early | Stamps `photos_open_from` with the server's own clock |
| `return_to_schedule` | `open-early` | Clears `photos_open_from` |
| `pause` | `open` — permitted, at or after the start | `uploads_enabled = 0` |
| `reopen` | `paused`, at or after the start, printed entry still enabled | `uploads_enabled = 1` |

A pause **before** the start is `return_to_schedule`, and it clears `photos_open_from` only. It
deliberately does not withdraw capability: if it did, a host who opened photos early and then thought
better of it would silently cancel the scheduled opening, and the event would sit on the guest waiting
surface through its own reception. There is deliberately no pre-start control that revokes capability
at all — a host who wants photo delivery off for the event does it after the start, when the effect is
visible to them.

If a host pauses after the start and then moves the event start back into the future, the guarded
settings write returns photo delivery to `scheduled`: it restores capability and clears any manual
opening stamp. It does so only while the printed entry remains enabled; an irreversible entry disable
continues to win.

A stale or illegal transition — most often a manager page that loaded before the start sending a
pre-start action after it — is the existing `VALIDATION_FAILED` envelope at HTTP 409, telling the host
to reload. No new error code was added for it.

The irreversible entry disable still wins over all four: it sets `uploads_enabled = 0` and
`rsvp_enabled = 0`, and no photo-intake action may open or reopen an event whose printed entry is
disabled. That is enforced inside the statement, not only ahead of it.

`uploadsEnabled` has left the settings payload entirely; `PATCH .../settings` no longer accepts it.
This follows `Sign out guest devices` and `Disable printed event QR`, which are explicit actions for
the same reason: a stale autosave draft could send `uploadsEnabled: false` meaning "pause until the
start" and instead destroy capability for the whole event.

RSVP opens only when the event has a deadline and the active roster passes collision and capacity
validation. The deadline is a calendar date in the event's IANA time zone; the server stores the final
millisecond of that local day, and that instant must be strictly earlier than `event_start_at`. Because
the stored deadline is the last millisecond of its own local day, the deadline date must therefore be
earlier than the event date. Create and settings enforce the rule identically, on the resolved instants
rather than on the dates, and report it on `rsvpDeadlineDate`. Any edit to the deadline date, the start
time, or the time zone recomputes both instants from the same tuple in the same guarded write, so a
zone change can never move one without the other. Shortening a deadline takes effect immediately for
sessions already issued; extending one requires each household to look itself up again before it
regains write authority. A host may correct any household after the deadline, and after the start:
from `event_start_at` onward every guest RSVP route is unavailable while manager correction, roster
management, import, and export all keep working.

The manager's **Add guests** workspace is additive at both initial setup and later use. It stages file,
paste, and direct-entry sources locally, previews a normalized batch without writes, and commits every
new household or explicit existing-household append in one transaction. An unchanged retry reuses its
idempotency key and replays the durable manager receipt instead of adding the guests twice.

The original strict CSV preview/commit API remains available for compatibility only. It can commit
once, while RSVP is disabled and the event has no active or archived household rows. The universal
workspace recognizes that exact header but still uses the additive batch endpoints. Source formats,
limits, key behavior, and export columns are in [rsvp-csv.md](rsvp-csv.md).

## Load harnesses

Both commands print a plan and make no network requests unless their explicit confirmation is set. A
live run writes real objects and rows, so use only a disposable rehearsal event and watch account
limits and cost.

```powershell
$env:CANDIDARY_LOAD_BASE_URL='https://staging.example.com'
$env:CANDIDARY_LOAD_EVENT_LINK='https://staging.example.com/join#REDACTED'
$env:CANDIDARY_LOAD_GUESTS='500'
$env:CANDIDARY_LOAD_PHOTOS='10000'
$env:CANDIDARY_LOAD_CONFIRM='I_UNDERSTAND'
npm run test:load:wedding
```

The photo harness creates separate guest sessions from the one durable entry link, reserves in batches
of 20, performs valid 64-byte PNG PUTs with two transfers per guest, and finalizes every object. It
intentionally leaves the data for host/export inspection; delete the disposable event afterward.

```powershell
$env:CANDIDARY_RSVP_BASE_URL='https://staging.example.com'
$env:CANDIDARY_RSVP_EVENT_ID='REDACTED'
$env:CANDIDARY_RSVP_EVENT_LINK='https://staging.example.com/join#REDACTED'
$env:CANDIDARY_RSVP_MANAGER_COOKIE='REDACTED'
$env:CANDIDARY_RSVP_MANAGER_CSRF='REDACTED'
$env:CANDIDARY_RSVP_CONFIRM='I_UNDERSTAND'
npm run test:load:rsvp
```

The RSVP harness previews and commits a 500-capacity additive batch (250 households of one named guest
and one plus-one slot), asserts both serialized envelopes remain below 512 KiB, replays the same
idempotency receipt, and reconciles the fully pending summary against the server's own totals. It then
uses the same entry link for exactly 20 lookup and submission attempts from the harness address and
requires the twenty-first to return a generic `429` with `Retry-After: 900`. It reconciles those 20
responses plus the remaining pending capacity and prints payload sizes, latency percentiles, and error
counts by code — never a name, a cookie, a token, or a URL.

This is not a 500-household concurrency test and must not be reported as one. Every request comes from
one address, which is the only way to exercise the durable per-IP boundary without weakening a
production abuse control. Maximum-household payload sizing and D1 parameter bounds are proved by
Worker integration tests; a true distributed lookup test needs separately provisioned source
addresses and its own authorized rehearsal.

## Support signals

Ask for the response request ID and inspect Worker logs. Common expected codes:

- `TOKEN_REVOKED`, `SESSION_EXPIRED`, `EVENT_EXPIRED`, `EVENT_DELETED` — use a current link or confirm lifecycle state.
- `FILE_TYPE_UNSUPPORTED`, `FILE_TOO_LARGE` — a selected or stored object failed type/signature/20 MB validation.
- `EVENT_MEDIA_LIMIT`, `EVENT_STORAGE_LIMIT` — the 10,000-photo or 100-GiB event quota is full.
- `MESSAGE_SUBMISSION_CONFLICT` — a successful guest-note key was reused with different words. The client replaces the key and offers the preserved note for another send.
- `MESSAGE_PURGED` — a permanently deleted note was retried with its original key; it cannot be restored or recreated.
- `MESSAGE_EVENT_LIMIT` — the event has reached its retained standalone-note cap. Existing Guestbook content remains readable and manageable.
- `EVENT_PHASE_CONFLICT` — the event phase no longer accepts a new note. Preserve the draft and keep the existing book readable.
- `MESSAGE_STATE_CONFLICT`, `MEDIA_STATE_CONFLICT` — a conditional host action lost a race; refresh the affected surface. For a stale Manager Guestbook action, refetch the row or first page instead of replaying the mutation. On the recovery routes this is also the ordinary answer to a repeated `trash`, a `restore` past `restore_until`, a `restore` that lost to permanent cleanup, and a `cancel-reservation` aimed at a delivered photo. Every one of those changes no counter.
- `UPLOAD_RESERVATION_CANCELED` — Manager-only 409 for an idempotent reservation replay whose row was terminally canceled or deleted. The row is not resurrected; choose the photo again with a new key. The equivalent guest replay deliberately keeps the existing `UPLOAD_FINALIZE_CONFLICT` contract.
- `RESOURCE_FORBIDDEN` — a host action referred to a photo, note, cover, or export outside the current event. On upload reserve, idempotent refresh, post-buffer claim, commit, or cancel, it also means the credential or exact actor lost liveness. That 403 is authorization-terminal and must not be retried as a row race; obtain current authority and start again.
- `UPLOAD_FINALIZE_CONFLICT` and the other upload-specific 409 outcomes — the authority is still live but the reservation or intake state moved. Preserve the selection and follow the queue's retry path rather than treating the response as credential revocation.
- `OWNER_CLAIM_REQUIRED` — save an ownerless event from its original creator session before rotating its management link.
- `EVENT_ENTRY_UNAVAILABLE` — the printed entry is missing or was disabled. It cannot be replaced; the event needs a new event and a new printed code. This is also what a **Sign out guest devices** attempt returns once the entry has been disabled.
- `EVENT_EXPIRED` on a scan — the printed credential is valid but the event's internal guest grant has expired. The event's own guest window has ended; nothing about the QR is wrong. (`GUEST_LINK_UNAVAILABLE` is retired: the route that raised it was replaced by `GET /api/manage/events/:eventId/entry`, and no code path emits it any more.)
- `RSVP_UNAVAILABLE` — RSVP is disabled or paused for this event.
- `RSVP_CLOSED` — the event has started. Before the start, deadline and session-window write races use the conflict/session envelopes below; a prior response remains readable and an already committed idempotency key can replay its receipt. At and after `event_start_at` every guest RSVP route is unavailable — reads and idempotent replays included — because RSVP has left the guest experience entirely. A host may still correct the household throughout.
- `RSVP_SESSION_REQUIRED` — the household session is missing, expired, revoked, or archived. The guest looks the invitation up again.
- `RSVP_HOUSEHOLD_CONFLICT` — the version the write was built on is no longer current, and nothing was written. The response carries a message only, deliberately: the caller re-reads the household (`GET /api/event/:slug/rsvp/household`, or the manager household detail) and submits again against the current version. A host roster edit that changes who is in a household reports this too, rather than a validation failure.
- `RSVP_SUBMISSION_CONFLICT` — a previously successful idempotency key was reused with different content. Use a new key rather than editing the old payload.
- `RSVP_ROSTER_INVALID` — the roster cannot be opened or edited into this shape: a collision no second name can resolve, an active household with no named guest, a capacity limit, or a plus-one reduction that would remove an attending slot.
- `RSVP_IMPORT_CONFLICT` — the file, the roster version, or the event's emptiness changed since preview. Preview the same file again.
- `RSVP_ROSTER_BATCH_TOO_LARGE` — the serialized additive preview or commit envelope exceeded 512 KiB. Keep the staged list and split it into smaller Add guests batches.
- `RSVP_ROSTER_BATCH_CONFLICT` — the event roster or an explicitly targeted household changed after preview, and nothing was written. The typed details identify changed, archived, or missing targets; refresh them and preview the preserved draft again.
- `RSVP_ROSTER_BATCH_IDEMPOTENCY_CONFLICT` — a committed manager batch key was reused for different canonical content. Keep the original key only for an unchanged retry; changed staged work needs a fresh preview and key.
- `RATE_LIMITED` on a lookup — the edge budget (30/IP/minute, `Retry-After: 60`) or a D1 budget (20/event/IP or 8/event/name per 15 minutes, `Retry-After: 900`) is spent. The body is deliberately generic.
- `RATE_LIMITED` on a Guestbook submission — either the isolated edge budget (120/event/trusted-IP/minute) or a durable session/IP window is spent. Honor `Retry-After`, preserve the draft, and never log a raw IP or digest.
- `RATE_LIMITED` on an album-share exchange — 2,000 unexpired sessions already exist for that share. Honor the exact `Retry-After`, which reaches the earliest active expiry; expired rows do not count.
- `EXPORT_MEDIA_UPGRADE_REQUIRED` — one or more stored originals still point at the legacy bucket. Copy-only may already have verified the canonical bytes, but export remains closed until the reviewed canonical-live pointer cutover completes. Never bypass the canonical-generation snapshot rule.
- `EXPORT_ALREADY_ACTIVE`, `EXPORT_EMPTY`, `EXPORT_FAILED`, `EXPORT_LIMIT_EXCEEDED`, `EXPORT_SNAPSHOT_CHANGED` — inspect the active job, immutable Guestbook snapshot metadata, and persisted object inventory.
- `EXPORT_SOURCE_REMOVED` — a frozen export source is gone for good, so this job can never run again. It is produced by the guarded retry transition in `worker/db/exports.ts` and stored by migration `0019_media_recovery.sql` when it validates existing queued jobs; it is never passed through from an arbitrary stored string. Causes, in the order worth checking: the photo was permanently deleted (by its guest, by recovery expiry, or by purge); its pointer moved and the frozen key is no longer current; or that exact key's `media_object_write_tombstones` row already entered suppression. A photo the host merely moved to Recently deleted does **not** produce this — its bytes are retained and its job stays retryable. The only action is to prepare the current collection; there is nothing to repair on the old job, and no `HEAD` loop will change the answer.

### Recoverable host deletion (0019)

Moving a photo to Recently deleted is a D1 state change and nothing else. The bytes, the object
inventory, the publication status, the album position, and the favorite all stay exactly as they were;
`media.trashed_at` and `media.restore_until` are set together, and `deleted_at` is set to the same
instant as `trashed_at`. That equality is the whole discriminator:

| Shape | Meaning |
| --- | --- |
| `trashed_at IS NULL AND deleted_at IS NULL` | active, delivered |
| `trashed_at IS NOT NULL AND deleted_at = trashed_at` | recoverable |
| `upload_state = 'deleted' AND trashed_at IS NULL` | permanently deleted |

`deleted_at = trashed_at` is also a deliberate compatibility marker: an 0018 Worker reads it as
ordinary deletion, filters the row out of every read, and refuses its own delete path before touching
R2 — which is what makes migration-first deployment safe up to the first trash write.

A retained photo still spends the event's capacity. `events.recoverable_media_count` and
`events.recoverable_bytes` carry it, reservation and finalization count `reserved + stored +
recoverable`, and a database trigger enforces that sum against the same 10,000-photo and 100-GiB caps
on every counter write — including one issued by the older Worker. Trash that appeared to free space
would make a later Restore fail for want of room, and a UI that promised recovery would have lied.

`restore_until` is `min(now + 30 days, management_access_expires_at, purge_after)`, computed inside the
transition from the event's own live values. Recovery never outlives the authorization needed to
perform it, and the exact deadline does not exist until the server accepts the transition.

Diagnosing a stuck row:

```sql
SELECT id, upload_state, trashed_at, deleted_at, restore_until
FROM media WHERE event_id = ? AND trashed_at IS NOT NULL
ORDER BY restore_until;
```

An expired row that is still listed is not a bug. `MediaRepository.permanentlyDeleteTrashed` refuses
while an accepted export still holds that exact `(object_bucket_generation, object_key)` through an
`export_media_entries` row of a `queued` or `running` job — the host sees **Recovery expired · cleanup
pending**, Restore is already gone, and the next pass after that job becomes terminal removes it. To
see the hold:

```sql
SELECT j.id, j.state FROM export_media_entries e
JOIN export_jobs j ON j.id = e.export_job_id
WHERE e.media_id = ?
  AND e.object_bucket_generation = ?
  AND e.object_key = ?
  AND j.state IN ('queued', 'running');
```

Supply the media id, bucket generation, and object key from the expired row's current pointer. A job
that froze a different generation or key is not a hold on the bytes cleanup is trying to remove.

Physical deletion is a separate claim. `MediaRepository.claimMediaObjectDeletion` wins the suppression
transition for the exact aliases nothing else owns and returns them as a `MediaObjectDeletionClaim`;
`deleteMediaObjectAliases` deletes only those keys. A key an active export holds, or a recoverable
photo owns, never appears in a claim, and its bytes stay for the existing tombstone janitor. Never
delete a media object by assembling key sets by hand — that is exactly the bypass the source hold
exists to close.

Applying `0019` is all-or-nothing and refuses while any export job is `running`. Wait for the existing
Workflow to become terminal and apply it again; the migration cannot reason about a job that is
reading R2 right now. Inside its transaction it also fails every queued job it cannot vouch for —
`EXPORT_SOURCE_REMOVED` — which is expected and needs no repair beyond preparing the collection again.
After the new Worker admits the first trash write or `attempt-v2` export, the release is
forward-fix-only: the standard 0018 code rollback is no longer a valid recovery path.

### Export execution ownership (0020)

Migration `0020_export_progress.sql` is additive and deliberately differs from 0019's application
gate. It may be applied while a `legacy` export is running: every existing row receives
`execution_protocol = 'legacy'`, `execution_transition = 0`, null execution/progress fields, and its
state, attempt, `started_at`, and artifact inventory remain untouched. Old Worker SQL continues to
operate on those legacy rows. New code opts in only a pristine queued job, or one exact terminal Retry,
to `attempt-v2`. The migration installs the immutable singleton `export_protocol_admission` in
`legacy-open`, so old HTTP remains usable after the additive migration. D1 gates every active job
INSERT and terminal-to-active Retry by protocol: `legacy-open` admits only `legacy`, `closed` admits
neither protocol, and `open` admits only `attempt-v2`. Closing and opening both require zero queued or
running legacy rows. A successful close serializes against racing old writes and cannot be reversed.
Once the candidate owns HTTP, closed admission returns a safe 503 and cannot leave a job, delete an
artifact, or dispatch a Workflow.

For a v2 row, D1 owns the exact state, attempt, execution start, transition counter, and durable
whole-part progress tuple. A pinned old Workflow callback cannot claim, complete, fail, retry, or
expire that row: its old statement loses at the D1 trigger before it reaches the callback's R2 work.
That protection does **not** make the old scheduled cleanup safe. The old daily path deletes R2
artifacts before its `Ready -> Expired` D1 update, so it can destroy a v2 winner's bytes and only then
discover that its update lost.

An inert Worker upload does not activate its Workflow implementations, and `triggers deploy` is not a
Workflow-code deployment operation. Treat the first v2/trash-capable production release as an
exclusive admission, not as the routine automatic-deploy path:

First cut over the isolated preview environment. Freeze all preview uploads, apply 0020 and verify
`legacy-open`, then upload and inspect one exact reviewed version while it is inert. Drain active legacy
work and atomically close. Prove the full preview config has the expected Workers.dev identity and no
route, Cron, queue, event-trigger, or address side effects; then use pinned `wrangler deploy` from that
same clean exact-SHA artifact to advance Worker code and all three Workflow implementations together.
Require one new sole 100% active exact-SHA Worker version and three new latest Workflow version IDs,
verify safe 503 while closed, then open with that new active lowercase UUID and canonical timestamps.
If the control-plane proof or any later check fails, keep
admission non-open, record hosted export conformance as unavailable, and ship only a reviewed forward
fix. The canonical preview commands are in [deployment.md](deployment.md).

1. Name one release owner, record the UTC start, freeze every production deployment and every merge
   except the exact immutable reviewed release, and prove no build or deployment is in flight.
2. Before applying 0020, prove the sole active production version is at 100% and its tag is the exact
   frozen old source `df2b66510ccee6893ca91ab752337df8e52c6207`. Stop and freeze/review the actual
   deployed source if it differs.
3. Before the reviewed merge, change the connected production Build deploy command to the repository's
   upload-only production-version command. The Build must upload an inert version tagged with the
   exact merged full SHA; it must not promote traffic or mutate triggers.
4. Apply and verify 0020 while the old Worker remains active. Unlike 0019, do not wait for a running
   legacy export merely to apply 0020. Prove the admission singleton is exactly `legacy-open` with null
   audit fields; old create/Retry remains legal at this stage.
5. Merge only the reviewed SHA under the recorded exception. Capture the inert Build version ID and
   prove its tag equals the merged SHA. From that clean `main`, use the existing deploy helper to emit
   `wrangler.cron-only.json` plus a full `wrangler.cutover.json` whose only delta from the verified
   production config is `triggers.crons: []`. Record all three pre-cutover Workflow latest-version IDs.
6. With the Cron-only config, detach daily `17 3 * * *` while retaining hourly `47 * * * *`. Record the
   successful detach time and wait at least 30 minutes; extend the drain through any old daily invocation
   observed to finish later. A Workflow drain or timing guess is not proof that old scheduled cleanup is
   gone.
7. After that daily drain, wait for every legacy queued/running export to become terminal and atomically
   close only while that count remains zero. A racing old active INSERT/Retry either blocks the close or
   loses after it. Closing is the one-way export-availability cutover: old writes cannot be re-enabled.
8. Immediately use the existing helper's cutover mode to run pinned `wrangler deploy` from the same
   clean exact-SHA artifact and full no-Cron cutover config. Prove one new sole active Worker version at
   100%, an exact-SHA tag, all three latest Workflow version IDs changed from their baselines, and every
   expected script/class mapping retained. The new Worker returns safe 503 while closed. This deployment
   remains the separate trash/data rollback point: from here a pre-0020 Worker is forbidden.
9. Open `export_protocol_admission` exactly once with that new active lowercase UUID Worker version ID,
   preserved canonical close time, and an exact canonical UTC admission time. The trigger rechecks zero
   active legacy rows. Require one changed row and read back the exact open row.
10. Restore both Crons with the Cron-only config only after that proof. Keep the merge/deploy freeze
   until a later `cleanup_completed` record from the daily Cron has
   `cleanupKind = 'daily-lifecycle'`, exact cron `17 3 * * *`, and the active Worker version ID. An
   hourly maintenance record is not substitute evidence. Restore the connected Build command only after
   this proof and verify the settings change itself started no build or deployment.

The old unsafe ordering is why steps 6–10 are hard gates:

- Detaching Cron with the Cron-only config must happen before the full cutover deployment.
- `wrangler versions deploy` plus `wrangler triggers deploy` does not prove that Workflow code advanced.
- The full no-Cron cutover deployment is safe only because D1 admission is still closed.
- The admission row cannot be deleted, replaced, returned to `legacy-open`, reclosed, or retargeted.

The exact commands and expected control-plane config keys are canonical in
[deployment.md](deployment.md).

Closing is already a forward-only export-availability decision because legacy admission cannot be
restored. The ordinary previous-version code rollback remains permitted only before the new Worker is
deployed and before the first admitted trash or v2 write. The cutover deployment is the broader
trash/data rollback point. After it, never deploy a pre-0020 Worker. Keep Build upload-only and the
freeze in place, independently review a current forward fix, verify its inert preflight version/tag,
then deploy its matching clean built artifact and require a new active exact-SHA Worker version plus
three changed Workflow latest-version IDs. Match its Worker/Workflow protocol to the existing gate
state. If admission is still closed, continue
the original one-time open after the fix passes. If admission is already open, preserve it and deploy
only `attempt-v2`-compatible forward changes; never reclose or rerun admission. Repeat the applicable
Workflow/version/Cron proof. Remote Build settings, migration application, Cron changes, merge,
admission, and cutover deployment require a
separately authorized production operation; this repository work does none of them.

Platform behavior references: [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/),
[build branches](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/),
[GitHub integration](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/),
[Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/),
[versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments/), and
[Workflows deployment](https://developers.cloudflare.com/workflows/get-started/guide/).

Production secret provisioning and remote D1 migration are explicit durable-state operations, not
steps hidden inside routine code deployment. Follow [deployment.md](deployment.md), and never rotate
persisted-data keys merely to release application code.

The active schema-v2 Worker requires ten application secrets, including the two album-share keys, and
no R2 access-key secret. Do not
reintroduce `R2_ACCESS_KEY_ID` or `R2_SECRET_ACCESS_KEY`; the old signer token is revocation evidence,
not a credential for Candidate A, copy-only, or Candidate B.

Cover codes are Manager-only. None is reachable from a guest load, which is why all ten classify as
`retry` in `shared/load-failure.ts` — none of `latest-link`, `ended-event`, or `sign-in` describes a
host whose upload was refused.

- `COVER_SOURCE_UNSUPPORTED` — the file is not one of JPEG, PNG, WebP, or HEIC, or the bytes are not
  the kind of image the reservation declared. Generic HEIF and HEIC/HEIF *sequence* types are refused
  on purpose in v1; advertise them only after they work against real Images in an isolated preview.
- `COVER_SOURCE_TOO_SMALL` — after orientation the photo is under 620 × 420, which is the floor for
  producing every 1x layout without upscaling. It is refused at inspection, never at `Done`.
- `COVER_MASTER_BUDGET_EXHAUSTED` — no rung of the five-attempt normalization ladder produced a valid
  master inside 9,000,000 bytes. Usually a very large or very panoramic source; ask for a smaller or
  less wide photo. The active cover is untouched.
- `COVER_PREVIEW_BUDGET_EXHAUSTED` — the four-rung preview ladder could not fit a style preview inside
  660,000 bytes. Recorded per draft, effect, and recipe version, so an identical request replays that
  result rather than re-encoding a dense image forever. The draft stays usable; another style or photo
  will work.
- `COVER_OUTPUT_BUDGET_EXHAUSTED` — a required profile could not be encoded inside its byte ceiling, or
  the final manifest verification found a slot missing. Publication fails permanently, the staged
  render set is abandoned, the draft returns to `ready`, and the previous cover stays live.
- `COVER_DRAFT_LIMIT`, `COVER_RAW_STORAGE_LIMIT` — three live drafts, or 57,000,000 declared/verified
  raw bytes, are already outstanding for this event. The error identifies which drafts the host may
  resume or discard. Note that discarding stops future ingress but does not release the bytes: they
  stay charged until R2 absence is verified by the scheduled sweep.
- `COVER_DRAFT_STATE_CONFLICT` — the draft moved on since the page loaded, or a discard was attempted
  while it was publishing. Reload; a publishing draft is released by its own receipt, never by a retry.
- `COVER_PUBLICATION_CONFLICT` — an operation ID was reused with different request bytes, or another
  preparation is already outstanding for this event.
- `COVER_RENDER_UNAVAILABLE` — the Images binding is unavailable, or a Workflow dispatch failed. Always
  retryable, and deliberately distinct from `FILE_TYPE_UNSUPPORTED`, whose name would contradict its
  meaning here. The active cover is unchanged and the same operation can be restarted.

A lost `cover_revision` race deliberately gets **no** new code: it is the existing `VALIDATION_FAILED`
envelope at HTTP 409 with cover-appropriate prose, following the precedent recorded above for a stale
photo-delivery transition.

Cover delivery itself has no new guest-visible error taxonomy. Current behavior is:

- Manager and guest event responses carry a nested cover view and revision, never a storage key. The
  browser requests only `/api/event/:slug/cover/:revision/:profile/:density.:format` or the equivalent
  `/api/manage/events/:eventId/...` route. The revisionless compatibility readers are absent.
- Every slot read reauthorizes the current event and requires the exact current revision and one of the
  six registered profiles. Uploaded bytes are read only from the exact active set and return
  `private, no-store` plus `nosniff`; presets return a private/no-store `307` to the immutable event-free
  asset. Missing, stale, retired, or cross-event inventory returns no alternate object. Never work
  around a 404 by returning a legacy object or normalized master.
- `ResponsiveEventCover` measures its actual container, advertises only server-qualified 2x slots,
  tries current WebP and then current JPEG once, and replaces a double failure with the event gradient
  before the broken-image icon can appear. It emits one sanitized audience/profile/revision observation
  and asks its event owner for at most one refresh for that revision/profile. A newer revision resets
  recovery; an unchanged revision cannot loop.

One Manager-level reconciler owns an accepted publication. It persists the operation reference before
dispatch, adopts any server-selected preparation on an event read, respects the greater of its bounded
poll cadence and `Retry-After`, pauses authorization-dependent reads while hidden or signed out, and
resumes the same operation after access recovery. Closing and reopening Cover Studio does not abandon
or duplicate the receipt. A dropped create response is ambiguous, not a new-operation signal; only a
terminal applied, conflict, or permanent failure releases the owner for later work. A retryable failure
restarts the same receipt.

Displaced uploaded render sets and normalized masters, and any displaced legacy original, are never
deleted eagerly. They share a cleanup deadline no earlier than seven days after displacement and no
earlier than the publication receipt's expiry. The bounded scheduled sweep removes inventoried R2
objects first, verifies absence, and only then removes the row that named each object. Within that
window the inventory remains the recovery boundary; after verified cleanup, it does not.

### Backfill and deletion signals

The current Worker exposes these support signals:

- Manager event deletion returns `202` with exactly `data.deletionScheduled === true` while cover
  cleanup remains, or `200` with exactly `data.deleted === true` when the purge completes in that
  request. The first response promises immediate access revocation and scheduled physical cleanup,
  not that every object is already gone.
- `event_cover_backfill_runs` stores the durable mode, status, cursor, rolling inventory digest,
  counters, timestamps, `verified_at`, and expiry. `event_cover_backfill_jobs` stores job,
  dispatch-generation, retryability, terminal, reference-release, and expiry state.
- `event_cover_workflow_fences` stores the open or deletion-owned fence and generation;
  `event_cover_purge_progress` stores `phase`, cumulative `fences_resolved`, cumulative
  `platform_mutations`, and its update clock.
- The launcher prints or writes ordered private artifacts and evaluates saved Wrangler `--json`
  payloads. Its display proof is diagnostic only. The Worker is the only writer of a verified run.

The Worker emits a structured `cover_platform_observation` for every non-null platform diagnostic.
It contains only a fixed `source` (`publication`, `backfill`, or `purge`) and a bounded,
low-cardinality `code`; it never contains raw status/error text, Workflow IDs, or object keys. The
Worker does **not** log the cleanup/reconciliation summary objects, expose a cleanup endpoint,
store an `unknown` platform marker, or publish a fence-backlog metric. A diagnostic event or unchanged
job/fence is therefore not evidence that an instance is missing. Use the read-only
`npm run cover-backfill:inventory` and `npm run cover-backfill:verify` modes to compare snapshots
across scheduled passes, and stop for engineering investigation when platform status is unknown or
purge/fence state remains unexplained. Do not fill those observability gaps with raw D1 edits or
operator resume/restart calls.

## Recovery boundaries

The application does not promise recovery for a lost management link, explicit deletion, or retention purge. There is also no recovery for a disabled printed entry or an archived household: both are irreversible in v1 and both are confirmed by typing the exact name before they run. Do not restore an object without its matching D1 lifecycle state. Preview generation can be retried safely; an unavailable preview does not mean the original failed delivery. Never copy an original into the preview key as a fallback: every served derivative must pass through the Images binding so original metadata is not exposed.

## Host notifications

Three lifecycle emails are scheduled as `host_notification_outbox` rows in the same D1 batch that commits a host's ownership of an event: a getting-started guide, a reminder the day before the event date, and a warning seven days before management access ends. Because the rows are written with the membership, a refused or rolled-back ownership claim can never leave mail scheduled that implies ownership.

The warning is keyed to `management_access_expires_at`, not `purge_after`. Management access ends 90 days after the event and photos are deleted at 120, so a warning keyed to deletion would reach the host a month after they could still act on it.

The hourly `47 * * * *` dispatcher reclaims leases older than ten minutes, claims at most 100 due rows in one conditional UPDATE under one random claim token, loads them with account and event data in one explicit-column join, then obtains a fresh conditional authorization immediately before each provider call. That authorization is the durable send permit: a row that opts out, becomes unverified or disabled, is deleted, or expires after page load is retired without a send. The ceiling is therefore 203 D1 statements per run, and 100 messages per run is inside the account's 1,000-per-day quota.

Row states are `pending → sending → sent`. A transient provider failure returns the row to `pending` with an incremented attempt count and a retry at 5 minutes, 1 hour, 6 hours, then 24 hours; the fifth failed attempt is terminal. A missed run does not erase eligibility because `available_at` is immutable and `retry_at` only moves forward. `discard_after` retires a reminder once its event has passed and a warning once its deadline has, rather than sending either late.

Rows whose account is disabled, unverified, or opted out are retired with a non-sensitive `last_error_code` and no send. A provider call already holding its authorization permit may finish if an opt-out commits just before the external invocation; every later row must obtain a new permit and is suppressed. Scheduled jobs use wall-clock execution time for both dispatch and cleanup, while recording the nominal schedule time separately in telemetry. Delivery is at least once: an isolate that dies between provider acceptance and the fenced success update will resend on the next run.

Investigate a growing count of `status = 'failed'` rows by `last_error_code`. `suppressed_by_preference`, `address_unverified`, `account_disabled`, `event_deleted`, and `obsolete` are ordinary; repeated provider codes are not.

## Email preferences

`GET /host/unsubscribe/:token` renders a confirmation form and changes nothing — inbox links are followed by scanners, prefetchers, and preview generators before a person reads them. The signed `POST` to the same URL performs the opt-out, which is what mail providers issue for one-click `List-Unsubscribe`. A signed-in host re-enables lifecycle email from the account page through the authenticated preferences endpoint.

Cloudflare Queues remain the next scaling step rather than part of this design. A durable D1 row would still be written first, because publishing a queue message cannot be atomic with the account and event transaction.

Sending is capped at 1,000 messages per day for the account. Outbound sends appear as **dropped** in the Email Routing summary even when delivered; use the Email Sending metrics instead. A hard-bounced address is added to Cloudflare's suppression list, after which its codes silently stop arriving — the management link is the remaining route for that host.

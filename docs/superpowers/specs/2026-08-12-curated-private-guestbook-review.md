# Written-spec review: Curated Private Guestbook

- **Reviews:** [2026-08-12-curated-private-guestbook-design.md](./2026-08-12-curated-private-guestbook-design.md)
- **Date:** 2026-08-12
- **Verdict:** Needs revision before planning — thirteen major defects, including a wire-contract type block whose central union (`GuestbookItem`) is never declared but is named as §9.1's return type, an undefined sort component (`source_rank`) that two cursors and a required index depend on, and an export path with no specified way to reach Ready or download for the notes-only case §12.1 and §12.4 both call valid.

## Summary

The architecture is right and should not be re-litigated: one projection over `guest_messages` and `media` (§5.1), the repo's guarded-`changes()` batch for creation (§11.2), an immutable snapshot table with a staged Ready flip (§10.5, §12.4), and two deliberately unbundled export artifacts (§12.1). What fails is precision at the seams. Three contract-level defects make sections literally unimplementable as written: §5.3 never declares the `GuestbookItem` that §9.1 returns and gives no rule that produces its own `host_only` value; `source_rank` (§9.2, §10.4) is the tie-break of two cursors and a required index but has no type, domain, or source mapping; and §12.4 widens only `markReady`, leaving a notes-only export with no specified path to Ready or to download. Two more are unresolved self-contradictions — §9.3 orders exactly the mutation responses §14 forbids, and §12.4/§13.3/§16.3 assert an immutability the photo half of the export does not have. The remainder are required edits the repo's binding conventions make mandatory and the spec omits entirely: the new rate-limit binding and the three exact-match release-topology assertions it breaks (§11.1), the migration count and `events` column tuple `verify:fresh-d1` pins (§10.1), two missing `ApiErrorCode` members, `shared/constants.ts` as limit owner, and two design allow-lists. Fix the thirteen majors in the spec text before a plan is written; the seven minors fold into the same revision pass.

## What is settled

These are correct and should not be re-litigated by the implementation plan.

- §5.1's layered projection with a read-only `GuestbookRepository` over `guest_messages` and `media`, and §5.2's explicit rejection of a canonical guestbook table, is the right call — it avoids dual writes, backfill rules, and a second deletion lifecycle — and §8.3 correctly routes caption actions through the existing media publication mutation so photo and caption cannot acquire contradictory publication states. Do not reopen this.
- §11.2's creation path is exactly the repo's prescribed D1 pattern: a guarded batch whose first statement reserves under both the window and the event cap, later statements gated on `changes()`, and the unique `(event_id, guest_session_id, idempotency_key)` index as the final duplicate guard — matching `MediaRepository.reserve` and CLAUDE.md's "enforced in SQL, not in JS". No read-then-write counter appears anywhere in §11.
- §10.5's snapshot as one atomic `INSERT ... SELECT` batch into an immutable `export_guestbook_entries`, plus §12.4's "The job becomes Ready only when every applicable artifact succeeds", mirrors the cover pipeline's staging-then-flip discipline; §12.5's "No cleanup path infers object keys from prefixes when a durable inventory row exists" is the same rule the retired-legacy-object sweep already follows.
- §12.1's refusal to bundle `guestbook.html` and `guestbook-private.csv` into one ZIP, with the label "Private entry archive - contains entries guests cannot see", is a genuine privacy control rather than a naming convention, and §12.3 routes every field through the shared `csvCell()` formula defence per CLAUDE.md's CSV rule.
- §5.4's nine-row state/visibility matrix is complete across all four consumers and is evaluated only from server-owned state ("Browser state, remembered names, and route identifiers never grant visibility", line 198), which is the correct expression of the repo's rule that route identifiers alone never grant access; §8.1's "Published · gallery off" label is the right refusal to silently rewrite a source state.
- §8.1's summary-only initial load with no rows until the destination opens, §8.5's "Summary polling never claims that unchanged counts prove unchanged rows" with no auto-prepend, and §8.4's row-local mutation with no whole-page refresh together fix all four Manager defects §2 lists, and §16.4 pins them as tests.

## Blockers

None.

## Major

### 1. §5.3's type block cannot serve as a wire contract: `GuestbookItem` is never declared, `host_only` is produced by no rule, and the Deleted view has no legal `visibility`

**Sections:** 5.3 (lines 149-176), 9.1, 5.4, 8.1, 10.4, 12.3

Three defects in one block. (a) The block declares `GuestbookItemBase`, `GuestGuestbookItem`, and `ManagerGuestbookItem` — never `GuestbookItem` — so §9.1's POST return type `{ item: GuestbookItem, replayed: boolean }` is undefined, and read against the declared names it resolves to the arm without `isOwn`, giving POST and GET different shapes for the same row. (b) No rule anywhere yields `host_only`: §5.4's only non-guest-visible row is "None", and §10.4 and §12.3 both restrict derived visibility to `shared` or `author_only`. (c) §8.1's Deleted view must serialize `ManagerGuestbookItem` rows whose `visibility` has no legal value, because "None" is not in the union. Separately, `GuestGuestbookItem = GuestbookItemBase & { isOwn }` structurally admits `state: 'deleted'` and `visibility: 'host_only'` in a guest response — exactly what §5.4 forbids a guest from receiving. `shared/contracts.ts`, where these wire types must land, is named nowhere in the spec.

**Evidence.** Lines 149-176 are the complete block. `GuestbookItem` occurs only at lines 12, 146, and 457; `host_only` occurs only at line 150 (declaration) and line 170 (`Exclude<GuestbookVisibility, 'host_only'>`) — never produced. Line 191: "| Note soft-deleted | None | Deleted | Excluded | Excluded |". Line 581: "derived `guest_visibility` (`shared` or `author_only`)".

**Fix.** Rename the union to `GuestbookItem` and derive both consumer types from it. Type §9.1's POST as `{ item: GuestGuestbookItem, replayed: boolean }`. Split the arms: the guest note arm carries `state: 'pending' | 'approved' | 'rejected'` with `visibility: 'shared' | 'author_only'`; the manager note arm adds `state: 'deleted'` with `visibility: 'host_only'`, defined as "soft-deleted, host-recoverable, present in no guest read and no export row". Replace §5.4's soft-deleted "None" cell with `host_only`. Name `shared/contracts.ts` as the owning file for all three types.

### 2. `source_rank` is the tie-break of the manager cursor, the export sort key, and a required index, but is never defined — and §9.2 and §10.4 spell the key two different ways

**Sections:** 9.2, 10.4, 16.1, 9.1

`source_rank` occurs three times in 978 lines and is never given a type, a domain, or a mapping from `guest_note`/`photo_caption` to a value. The manager list is a UNION over `guest_messages` and `media`, where no such column exists, so each arm must emit a literal while `export_guestbook_entries` stores it as a real column — and the two must agree or the export order diverges from the manager order. §9.2's key is `(created_at, source_rank, id)` while §10.4's is `(created_at, source_rank, source_id)`, so even the third component has two names. Rows from the two tables routinely share a `created_at`; two implementers choosing opposite literals produce a stable-looking cursor that silently skips or repeats rows across a tie, §10.4's index stops matching the query, and §16.1's required test ("Guest/manager keyset ordering across equal timestamps and both sources") has no value to assert. The guest cursor is separately left at `(createdAt, id)`, so guest and manager order the same union differently.

**Evidence.** Spec lines 493, 584, 587 are the only occurrences. Today's union carries no rank: worker/db/messages.ts:141 `'message' AS kind`, :146 `'caption' AS kind`, :158 `ORDER BY created_at DESC, id DESC`; worker/http/message-cursor.ts cursor schema is `{ createdAt, id }` only.

**Fix.** Define in §5.3 and export from `shared/constants.ts`: `GUESTBOOK_SOURCE_RANK = { guest_note: 0, photo_caption: 1 }` as a fixed small integer. State that both manager UNION arms select that literal as `source_rank`, that `export_guestbook_entries.source_rank` stores the same integer, and that every read uses one spelling — `(created_at DESC, source_rank ASC, id DESC)` newest-first and its exact inverse for §10.4's oldest-first rendering. Add `source_rank` to the guest cursor payload in §9.1 so the two feeds cannot order the same union differently.

### 3. Notes-only and private-only exports have no specified path to Ready or to download: §12.4 widens only `markReady`

**Sections:** 12.1, 12.4, 10.3

§12.4 widens exactly one function. A notes-only job produces no photo manifest by §12.4 step 2, but the manifest is mandatory in three places the spec never touches: `markReady` takes `manifestObjectKey` as a non-nullable `string`, the download route treats a null manifest key as not-ready and then unconditionally presigns it, and the client view types `manifest` as non-nullable and dereferences it. A notes-only or private-only export — both explicitly valid per §12.1 and §12.4 — therefore either cannot be marked Ready or reaches Ready and 409s on every download, making the two guestbook artifacts unreachable for the exact case §12.1 names. The only nullability the spec grants is for the two new descriptors (line 686) and the new `export_jobs` columns (§10.3).

**Evidence.** worker/db/exports.ts:130-137 `async markReady(id: string, manifestObjectKey: string, parts: ReadyExportPart[], ...)` opening with `if (!parts.length) throw new Error('A ready export must contain at least one part.');`. worker/routes/exports.ts:66 `if (job.state !== 'ready' || !job.manifestObjectKey || !job.expiresAt || ...) throw new ApiError('EXPORT_FAILED', 'This export is not ready to download.', 409);` then :73 `presignDownload(context.env, job.manifestObjectKey)`. src/app/types.ts:46 `manifest: { url: string; expiresAt: string; filename: string };`, dereferenced at src/components/ManagerExportPanel.tsx:28.

**Fix.** Add to §12.4: "`export_jobs.manifest_object_key` becomes nullable. `markReady` accepts `manifestObjectKey: string | null` together with zero photo parts when at least one guestbook snapshot row exists. The download readiness predicate becomes `state = 'ready'`, unexpired, and at least one signable artifact among manifest, ZIP parts, and the two guestbook objects. `ExportDownloadView.manifest` and the Manager export panel become nullable alongside the two new descriptors." If instead a header-only manifest is always written, say so and delete "or the final two groups for a notes-only event" from §12.1.

### 4. §9.1 replaces the guest payloads on retained routes with no rollout rule; a mid-deploy page labels every shared note "Kept private"

**Sections:** 9.1, 5.3, 7.2, 13.1

Keeping the URL is the breaking case, not the safe one. The POST body key moves from `message` to `item`, and GET items lose `kind`/`moderationStatus` for `source`/`state`/`visibility`. A guest keeps the event page open for hours at a venue while the Worker deploys atomically, so an already-loaded page reads a contract that no longer exists — and with `moderationStatus` absent, the shipped status mapper falls through to "Kept private / Only you can see this" for every row, including other guests' approved shared notes and the reader's own shared note. That is the exact inverse of the truth on the one surface whose subject is privacy. `item.kind` also disappears, so captions lose their thumbnail and render as "Note", and the POST shape change surfaces a false "not sent" error on a note that was in fact created. §13.1, §16, and §17 contain no versioning, invalidation, or same-release rule.

**Evidence.** src/pages/EventPage.tsx:50-61 `messageStatus` returns `{ label: 'Kept private', visibility: 'Only you can see this.' }` for anything not exactly `'approved'` or `'pending'` — including `undefined` — and :424 renders it for every row. Worker today: worker/routes/messages.ts:59-62 `data: { message: guestMessageView(created.message), replayed: created.replayed }`. Spec line 159 gives the note arm `state`, not `moderationStatus`.

**Fix.** Add to §9.1: "This is a breaking replacement of the guest payload on a retained URL; the Worker ships in the same release as the client. For one release the GET item additionally carries deprecated `kind` and `moderationStatus` aliases and the POST response carries a deprecated `message` alias, so an already-loaded page keeps rendering correct labels. A guest page that receives an item without a recognized `state` renders the feed error with Retry rather than any privacy label." State that `idempotencyKey` becoming required breaks no shipped caller because the current client always sends one.

### 5. §9.3 and §14 give contradictory instructions for the same two responses: "the complete canonical record" versus "never session IDs or object keys"

**Sections:** 9.3, 14, 5.3, 8.2, 16.2

§9.3 orders both manager mutations to keep returning the complete canonical record and then says "the client projects the returned canonical record into its active row". Today those records carry `guestSessionId` and `idempotencyKey` for a note, and `uploaderSessionId`, `objectKey`, `previewObjectKey`, and `idempotencyKey` for media — precisely what §14 says manager responses never contain and §8.2 says a row never exposes. §5.3's narrowing rule ("the manager serializer must omit that property and never include a guest-session ID") is scoped to the read projection, so nothing resolves which instruction wins. Following §9.3 literally also hands hosts a stable per-guest ownership identifier linking every note and photo from the same guest. This is a pre-existing condition — the shipped manager list routes have the same shape — but §9.3 preserves it and no section scopes the narrowing as work.

**Evidence.** worker/routes/messages.ts:112 `return context.json({ data: { message }, requestId: ... })` where `message` is the repository record; worker/db/messages.ts:34 `guestSessionId: row.guest_session_id`, :38 `idempotencyKey: row.idempotency_key`. worker/routes/manage.ts:353 `{ media: result }`; worker/db/media.ts:70-71 `uploaderSessionId`, `objectKey`, :86 `previewObjectKey`. Spec line 850: "never session IDs, credential digests, IP addresses, or object keys."

**Fix.** Replace §9.3's two "retains the existing ... complete canonical record" sentences with: "Both mutations return the affected row as a `ManagerGuestbookItem` plus its canonical source state; neither returns a raw `MessageRecord` or `MediaRecord`. Narrowing the already-shipped `GET /api/manage/events/:eventId/messages` and the manager media list to the same projection is part of this work." Add that narrowing to §16.2 beside "no session IDs leave the Worker".

### 6. "One immutable export snapshot" is false for the photo half; §13.3 and §16.3 assert it without qualification

**Sections:** 12.4, 13.3, 16.3, 12.3, 10.5

There is no persisted media snapshot. `exportSnapshot` re-queries live `media` with `deleted_at IS NULL` on every workflow attempt and the workflow aborts the whole job on a count mismatch, so a photo deleted after `snapshotAt` permanently fails a mixed export and every retry of it — including the guestbook artifacts, which are fully renderable from frozen rows. The manifest also emits each row's current `caption` and `publication_status`, so one download can carry a manifest saying `hidden` and a frozen `guestbook-private.csv` saying `published` for the same media ID. Count equality is not membership either: `created_at` is stamped at reservation, so one deletion plus one late finalize of a row created before `snapshotAt` keeps the count equal while changing membership, leaving a frozen caption row with no partition entry and no defined answer to §12.3's "Caption rows map to the filename/path assigned by the existing photo export partitioner."

**Evidence.** worker/workflows/export.ts:29-30 `const snapshot = await new MediaRepository(env.DB).exportSnapshot(job.eventId, job.snapshotAt); if (snapshot.length !== job.mediaCount) throw new Error('EXPORT_SNAPSHOT_CHANGED');`. worker/db/media.ts:183-191 `SELECT * FROM media WHERE event_id = ? AND upload_state = 'stored' AND deleted_at IS NULL AND created_at <= ?`. Spec line 833: "Retry never reads current moderation/publication state." Line 919: "State changes and deletions after snapshot do not change that job or retry."

**Fix.** Either add to §10.5 that the same batch persists the resolved photo plan (media ID, part number, in-archive path, caption, publication status) so both halves are frozen; or scope the language precisely: §12.4 → "renders the guestbook from the same immutable snapshot rows and recomputes the photo plan from the existing media snapshot query"; §13.3 → "Retry never reads current note moderation state. Photo membership is re-derived, and a post-snapshot photo deletion still fails the job and every retry"; §16.3 → split the unqualified line into the guestbook case and the photo case. Either way state that a frozen caption row whose media is absent from the recomputed plan leaves the three photo columns empty rather than failing the job.

### 7. The "durable session window" resets for free on re-entry, and the 1,000-note cap it backstops is unrecoverable

**Sections:** 11, 11.1, 11.2, 11.3, 10.2

§11 calls these "three independent protections", but the durable window is keyed on a session ID any guest can replace at zero cost. `POST /api/entry/exchange` has no rate limiter of any kind and mints a fresh `event_sessions` row on every call, and every guest at the venue holds the printed credential that feeds it. Clearing cookies and rescanning therefore resets the 5-per-15-minutes window, leaving only the 120/min edge shield — roughly nine minutes from one address to 1,000 notes. Because §11.3 makes the cap count soft-deleted notes and releasable only by purge, one guest can permanently close a live event's guestbook and the spec offers hosts no remedy short of deleting the event. The window is not durable in the sense §11 claims.

**Evidence.** worker/routes/entry.ts:33-49 `entryRoutes.post('/entry/exchange', ...)` calls only `assertRequestOrigin(context)`, the schema parse, and `new AuthService(context.env).exchangeEntry(...)` — no `*_RATE_LIMIT.limit(...)` in the file. worker/auth/service.ts:129 `return this.createEventSession(event, token, 'guest', now);`. Spec line 663: "Purge, not soft deletion, releases retained-note capacity."

**Fix.** Add a second durable dimension re-entry cannot reset: §11.2 keys a D1 window on `(event_id, trusted-client-IP digest)` alongside the session window, following the RSVP lookup budget pattern in `worker/routes/rsvp.ts`. And add to §11.3: "A host may reclaim retained-note capacity by permanently purging soft-deleted notes from the Deleted view; the action is bounded, irreversible, and labelled as such." If neither is in scope, replace §11's "three independent protections" with a stated limitation: the session window shapes one honest device only, and the 1,000-note cap is a permanent per-event ceiling with no host remedy.

### 8. `GUEST_MESSAGE_RATE_LIMIT` is declared nowhere, and a third limiter breaks three exact-match release-topology assertions

**Sections:** 11.1, 16.5

`wrangler.jsonc`, `cf-typegen`, `worker-configuration.d.ts`, `docs/deployment.md`, and the release scripts are named zero times in the spec. `AppEnv` is `Cloudflare.Env`, generated from `wrangler.jsonc`, so `context.env.GUEST_MESSAGE_RATE_LIMIT` does not compile until the binding is declared with a fresh namespace ID and types are regenerated — and §16.5 names the binding-verification gate that fails on exactly that drift. Worse, three release scripts assert the rate-limit set by exact canonical value rather than as a superset, so a third limiter throws in the production topology check, the staging safety check, and the staging record shape; their pinned unit fixtures must be widened in the same change or §16.5's full-unit-test gate fails.

**Evidence.** worker/env.ts:9 `export type AppEnv = Cloudflare.Env;`. wrangler.jsonc `ratelimits` declares only HOST_AUTH_RATE_LIMIT (1001) and RSVP_LOOKUP_RATE_LIMIT (1002). scripts/migrate-release.ts:437-439 `canonicalJson(topology) !== canonicalJson(expected)` → "Generated config is not the exact canonical production topology."; scripts/staging-release-candidate.ts:415-421 → "Staging rate-limit bindings are unsafe."; scripts/staging-release.ts:436 `exactRecord(item.rateLimits, ['hostAuth', 'rsvpLookup'], 'Staging rate limits')`, where `exactRecord` rejects any extra key.

**Fix.** Add to §11.1: "Declare `GUEST_MESSAGE_RATE_LIMIT` in `wrangler.jsonc` `ratelimits` with the next free `namespace_id` (1003) and `simple: { limit: 120, period: 60 }`, then run `npm run cf-typegen`. Extend the expected rate-limit tuples in `scripts/migrate-release.ts`, `scripts/staging-release-candidate.ts`, and `scripts/staging-release.ts` together with their fixtures in `tests/unit/migrate-release.test.ts`, `tests/unit/release-candidate.test.ts`, `tests/unit/staging-release-candidate.test.ts`, and `tests/unit/staging-release.test.ts`, and update the rate-limiting section of `docs/deployment.md` from two namespaces to three."

### 9. The new migration fails `verify:fresh-d1` — the exact gate §16.5 requires — which pins 14 migrations and the exact ordered `events` column tuple

**Sections:** 10, 10.1, 16.1, 16.5, 17

"Migration verification" in §16.5 is `npm run verify:fresh-d1`, which hard-pins both the migration count and the exact ordered `events` column list, rejecting on tuple length and on any cid/name mismatch. Adding `events.guestbook_prompt` in a 0015 migration fails that gate on two independent assertions, and the spec names neither the file number, the count, nor the column pin — although the immediately prior schema-touching spec in this repo (2026-08-03 cover studio, lines 1769 and 1889) names exactly this work. §16.1's "Ordered migration discovery through the next numbered migration" is the closest line and does not cover the verifier or its fixtures.

**Evidence.** scripts/verify-fresh-d1.ts:94 `const EXPECTED_MIGRATION_COUNT = 14;` asserted at :709-711 with "This candidate must contain exactly ${EXPECTED_MIGRATION_COUNT} migrations."; :247-257 pins `EXPECTED_COLUMN_NAMES.events` as an ordered literal ending `'cover_config', 'cover_revision', 'cover_render_set_id'`. docs/deployment.md:256-258: "the Phase-3 candidate has 14 and adds only `0014_event_cover_invariants.sql`."

**Fix.** Name the file in §10 (`migrations/0015_curated_private_guestbook.sql`) and add to §16.1: "Bump `EXPECTED_MIGRATION_COUNT` to 15 and append `guestbook_prompt` to `EXPECTED_COLUMN_NAMES.events` in `scripts/verify-fresh-d1.ts`, and update the pinned ledgers in `tests/unit/verify-fresh-d1.test.ts:62-74`, `tests/unit/deploy-release.test.ts:48`, and `tests/unit/staging-release-evidence.test.ts:199`." Add to §17: "This migration cannot land until the 14-migration cover cutover contract in `docs/deployment.md:254-258` is closed or amended, because any later candidate is no longer the candidate those gates describe."

### 10. A guest's own private entries share the single 50-row unified window, so the private read-back §7.3 promises can render empty

**Sections:** 7.1, 7.3, 7.4, 9.1, 16.2

Owned unshared rows are merged into one newest-first, time-keyed 50-row window shared with every approved note and published caption, with no separate bound, count, or cursor. Once 50 guest-visible entries are newer than a guest's own pending note or unpublished caption, a fresh first page contains none of them, so "Your private entries" renders empty on reopen — even though §7.1 conditions that section on the session *having* unshared content, which the API gives the client no way to determine. §7.3's caveat list for losing the private read-back names only storage clearing, another device, session rotation, and session expiry; pagination is not among them, so the promise reads as unconditional. The rows remain reachable via Show earlier, so this is a read-back and contract-completeness gap, not data loss.

**Evidence.** worker/db/messages.ts:139-160 is one `UNION ALL` over `(moderation_status = 'approved' OR guest_session_id = ?)` and `(publication_status = 'published' OR uploader_session_id = ?)` with a single `ORDER BY created_at DESC, id DESC LIMIT ?`; worker/http/message-cursor.ts pins the cursor to `{ createdAt, id }`; shared/constants.ts `GUEST_MESSAGE_PAGE_SIZE = 50`. Spec line 248: "**Your private entries**, when the current session has unshared content".

**Fix.** Change §9.1's GET response to `{ items, nextCursor, ownUnshared, ownUnsharedCount }`, where `ownUnshared` returns the session's own non-deleted unshared entries out of band under their own bound and cursor, independent of the shared cursor. State in §7.4 that `nextCursor` paginates the shared section only and that owned unshared entries are always present on the first page regardless of age. Add "own unshared entries survive 50+ newer shared entries" to §16.2.

### 11. §6's `photos-primary` availability rule has no counterpart in the §9 route contract, and enforcing it on reads erases the book during a routine intake pause

**Sections:** 6, 9, 9.1, 13.1, 16.2

§6 states "The guestbook is available only in the `photos-primary` phase", but §9 states the complete guest authorization rule as current guest session plus exact slug match with no phase condition, §13.1 lists no phase failure, and §16.2 has no phase-refusal test. The spec never says whether the Worker enforces the phase, on creation only or on reads too, or with what code and status — leaving the only gate the client render condition that exists today, which contradicts §5.4's "Browser state ... never grant[s] visibility" and §14's "Every request reauthorizes the event and credential scope." Enforced on reads it is actively harmful: an explicit photo-intake pause drops the event out of `photos-primary`, which would withdraw the shared book and every guest's private read-back mid-event, contradicting §1's "approved notes are visible to guests with current event access."

**Evidence.** worker/routes/messages.ts:17-24 `guestAuth` checks only `auth.session.role !== 'guest' || context.req.param('slug') !== auth.event.slug` plus CSRF — no phase resolution in the route family. shared/rsvp.ts:235 `const photosOpen = input.uploadsEnabled && nowMs >= scheduledOpenAt;`. src/pages/EventPage.tsx:304 `{!terminal && event.phase === 'photos-primary' && <section className="guest-secondary" ...>` is the only gate today. (`uploadsEnabled` is not a settings field: worker/routes/manage.ts:37-42 states it is deliberately absent and moves only through the explicit photo-intake action.)

**Fix.** Replace §6's last paragraph with: "The Worker refuses new note creation outside `photos-primary` with `409 EVENT_PHASE_CONFLICT` and calm copy. Reading an already-contributed book, including a guest's own private entries, remains available to any valid guest session in any phase, so a photo-intake pause never withdraws entries a guest can already see." Add that failure to §13.1, the refusal test to §16.2, and the new code to `shared/errors.ts` and the `## Support signals` list in `docs/operations.md`.

### 12. §7.1's receipt action opens a Guestbook disclosure that is unmounted the instant the receipt renders

**Sections:** 7.1, 16.4, 17

There is no existing disclosure to open once the receipt is showing. `EventPage` removes the entire `guest-secondary` section — gallery, previous deliveries, and the notes disclosure — the moment terminal state is set, which is exactly when the receipt renders. The spec asserts a DOM node that does not exist in the state it describes and never decides what the terminal state renders instead: a guestbook-only region kept mounted, a remount, or an inline composer. §16.4 restates the requirement as a test ("Receipt action opens Guestbook without replacing photo-delivery success") without deciding it, and whichever the implementer picks contradicts three recorded fidelity-ledger rows the spec never names.

**Evidence.** src/pages/EventPage.tsx:304 `{!terminal && event.phase === 'photos-primary' && <section className="guest-secondary" ...>` with the notes disclosure at :343 nested inside it; `terminal` is set only by `onDelivered` at :299, which src/features/uploads/GuestUploadFlow.tsx:103-108 fires as the receipt renders. design/fidelity-ledger.md:20 "disappear with the rest of the page after the terminal receipt"; :19 "It has no redirect, gallery prompt, or fourth step"; :117 "the terminal receipt still hides every secondary section including RSVP."

**Fix.** Add to §7.1: "When `terminal` is true, the `guest-secondary` block is replaced by a guestbook-only region that stays mounted; gallery and previous deliveries remain hidden. The receipt content itself is unchanged, and the action moves focus to the composer heading inside that region." Name the amendment of design/fidelity-ledger.md rows "Terminal receipt", "Secondary features", and "Photo journey unchanged" as a deliverable in §17.

### 13. Two binding design-system allow-lists are violated with no amendment named: the Manager label rename and the receipt action

**Sections:** 8.1, 7.1, 16.5, 17

`design/design-system.md` is binding and enumerates permitted above-the-fold copy by name. It lists `Notes` among the six Manager destination labels and closes the section by forbidding added navigation copy outside those entry points; the guest allow-list ends at "the terminal delivered receipt", and the fidelity ledger records that receipt as having no next action. §8.1 renames the label and §7.1 adds an action to the receipt, and the spec proposes no amendment to either document — "design-system", "fidelity", and "amend" appear nowhere in 978 lines, unlike every prior spec in this repo that touched these documents. The Manager label is additionally pinned as a literal tuple in three e2e specs and one accessibility fixture that §16 never mentions, and §8.1's badge redefinition changes the meaning of an existing rendered count.

**Evidence.** design/design-system.md:298 "the six destination labels `Intake`, `RSVP`, `Gallery`, `Notes`, `Share`, `Settings`"; :346 "Apart from those entry points, no eyebrow, badge, pill, fake metric, pricing, account, or unrelated navigation copy may be added."; :290 guest list ends at "the terminal delivered receipt". design/fidelity-ledger.md:19 "no next action". Pins: tests/e2e/manager-responsive.spec.ts:18, rsvp-responsive.spec.ts:31, visual-qa.spec.ts:27 (`const DESTINATIONS = ['Intake', 'RSVP', 'Gallery', 'Notes', 'Share', 'Settings'] as const;`), accessibility.spec.ts:48 `{ name: 'Notes', heading: 'Notes from the day' }`.

**Fix.** Add to §17 a named deliverable: amend design/design-system.md:298 to read `Guestbook` in place of `Notes`, and amend :290 to permit exactly one receipt affordance worded `Leave a guestbook note`, with the stated reason that it belongs to the delivered receipt. Add to §16.5: update the `DESTINATIONS` tuples at tests/e2e/manager-responsive.spec.ts:18, rsvp-responsive.spec.ts:31, and visual-qa.spec.ts:27, the accessibility fixture at accessibility.spec.ts:48, and the `manager-nav-*` baselines — including `manager-nav-count-390.png`, because §8.1 changes the existing `manager-nav__count` badge (src/pages/ManagerPage.tsx:782) from total notes to `needsReviewCount`.

## Minor

### 1. Caption eligibility loses its "non-empty" qualifier in §8.1 and §7.4, so every captionless photo inflates the Guestbook badge and the private feed

**Sections:** 8.1, 7.4, 10.5, 12.3

Captions are optional and every delivered photo starts `unpublished`, so §8.1's unqualified predicate ("pending notes plus unpublished captions on stored, non-deleted media") counts every captionless photo into the Guestbook badge and lists it as an empty-bodied row in Needs review — contradicting §8.1's own claim about what does not inflate the badge. §7.4's second and third bullets are likewise unqualified, so every captionless photo a guest uploaded would appear as an empty row in "Your private entries", and §12.2's "content-equivalent to the shared book" keepsake would then omit rows the feed showed. §10.5 (line 605) and §12.3 (line 732) use the correct "non-empty caption" predicate, so the document says both things. The existing feed already filters `caption IS NOT NULL` (worker/db/messages.ts:154), so the qualifier is load-bearing today.

**Fix.** Use the phrase "non-empty caption on stored, non-deleted media" verbatim in §7.4's second and third bullets, in §8.1's `needsReviewCount` definition, and in §8.1's Needs review view description, matching §10.5 and §12.3 exactly.

### 2. `MESSAGE_STATE_CONFLICT` and `MESSAGE_EVENT_LIMIT` are used as existing codes; neither is in `ApiErrorCode` and neither required edit is named

**Sections:** 9.3, 11.3, 13.2

§9.3 and §11.3 use `MESSAGE_STATE_CONFLICT` and `MESSAGE_EVENT_LIMIT` as if they already ship, and §13.2 lists the first beside `MEDIA_STATE_CONFLICT` as a peer. Neither is in the `ApiErrorCode` union, and the spec names neither `shared/errors.ts` nor `docs/operations.md` — the pair CLAUDE.md makes mandatory for any new code. It also silently changes a shipped response: note moderation and delete conflicts return `MEDIA_STATE_CONFLICT` today (worker/db/messages.ts:191, :203). The parallel concern about new `EXPORT_*` codes does not apply — workflow codes are free-form `error_code` strings persisted on the job row, not union members.

**Fix.** Add to §9.3: "Add `MESSAGE_STATE_CONFLICT` and `MESSAGE_EVENT_LIMIT` to the `ApiErrorCode` union in `shared/errors.ts` and to the `## Support signals` list in `docs/operations.md`. Note moderation and deletion conflicts change from `MEDIA_STATE_CONFLICT` to `MESSAGE_STATE_CONFLICT` in the same release as the client; caption conflicts are unchanged."

### 3. §10.5's exhaustive two-outcome enumeration silently drops the existing `EXPORT_LIMIT_EXCEEDED` refusal

**Sections:** 10.5

§10.5 step 3 enumerates export-creation outcomes exhaustively as `EXPORT_ALREADY_ACTIVE` and `EXPORT_EMPTY`. Export creation today has a third refusal: it sums source bytes and rejects an oversized event with `409 EXPORT_LIMIT_EXCEEDED` (worker/routes/exports.ts:35). An implementer following §10.5 literally removes a live `ApiErrorCode` from the product contract by omission. Practical risk is low because the reservation path already caps an event at the same `MAX_EVENT_BYTES` (worker/db/media.ts:411, :435), making the export-side guard defensive — but the code is consumed downstream as a retry decision, so it must not vanish silently.

**Fix.** Carry `SUM(byte_size) <= MAX_EVENT_BYTES` in the same guarded `INSERT ... SELECT` and add to §10.5 step 3: "an oversize snapshot returns `409 EXPORT_LIMIT_EXCEEDED`, distinguishable from empty and already-active."

### 4. §12.2 scopes HTML escaping to "contributed strings", leaving two host free-text values raw in a document promised to have no JavaScript

**Sections:** 12.2, 16.3

§12.2 says "Contributed strings are HTML-escaped, rendered as text" immediately after listing interpolated values that are not guest-contributed — the event name and the snapshotted guestbook prompt — while asserting as a property of the whole document that it has "no JavaScript, forms, analytics, remote fonts, remote styles, remote images, cookies, or network requests." Both of those are host free text with length-only validation (worker/routes/manage.ts:44 `name: z.string().trim().min(1).max(80).optional()`; §10.1's 1-160 check), so a literal implementation can violate the stated no-script property in the file §12.1 designates as the artifact a host shares or prints — and `event_hosts` membership is multi-party, so the injecting writer and the opening reader need not be the same person. The archive part/path also named in that list is already safe (worker/export/paths.ts `safeBasename` strips to `[a-z0-9-]`), and timestamps and media IDs are server-generated.

**Fix.** Replace §12.2's sentence with: "Every interpolated value in `guestbook.html` — event name, prompt, timestamps, guest names, bodies, media IDs, and archive part and path — passes through the same HTML escaper. Escaping is a property of the generator, not of a subset of its inputs. The stored object is written with `Content-Type: text/html; charset=utf-8` and `Content-Disposition: attachment; filename=\"guestbook.html\"`." Add "hostile event name and prompt" to §16.3's escaping test.

### 5. §7.2's "existing uploader-name mechanism" is a device-global key snapshotted once at mount, and the spec names no reactive source of truth

**Sections:** 7.2, 16.4

§7.2 mandates that **Change** and **Add your name** write through "the existing uploader-name mechanism" — a single device-global `localStorage` key (`candidary_guest_name`) that `GuestUploadFlow` snapshots once at mount into component state (src/features/uploads/GuestUploadFlow.tsx:83-84) — while `EventPage` renders the upload flow (:296) and the guestbook disclosure (:343) simultaneously during `photos-primary`. With no shared store or subscription, a name changed in the composer leaves the mounted upload form showing the old signature, and its next `saveName()` silently reverts the stored value, so the two surfaces show different signatures for the rest of the session — exactly the confusion §7.2 exists to remove. The key is also unscoped by event and is written by the RSVP lookup flow (src/features/rsvp/GuestRsvpFlow.tsx:161), which the spec does not acknowledge either way.

**Fix.** Add to §7.2: "The remembered signature has one source of truth — a subscribable store, or state lifted into `EventPage` — that both `GuestUploadFlow` and the guestbook composer read and write, so a change in either surface is immediately reflected in the other. The value stays device-global and unscoped by event, matching today's photo-uploader behavior including a value written by the RSVP lookup; it is always surfaced as **Signed as ...** with **Change** and **Leave unsigned** before anything is sent." Add "composer and uploader signature stay in sync" to §16.4.

### 6. Every new numeric limit is prose-only; `shared/constants.ts` is named zero times

**Sections:** 6, 7.2, 8.2, 10.1, 11.2, 11.3

CLAUDE.md is binding — "**Limits** live in `shared/constants.ts` ... Treat those files as the source of truth" — and the spec never names that file in 978 lines, although it is otherwise highly file-specific (it names `MessagesRepository`, `MediaRepository`, `markReady`, `csvCell()`, `requireManager`, `guest_messages`, `export_jobs`, `ExportWorkflow`). It introduces the 1,000 retained-note cap, the 5-per-15-minute window, the 1-160 prompt bound, and the 25-default/50-max manager page as prose only, while §7.2 requires "The client and Worker enforce the same bounds" without naming a shared source, so they can drift. The 120/min edge budget correctly belongs in `wrangler.jsonc` rather than constants, and the 1-128 idempotency bound is already inline zod.

**Fix.** Add to §10: "`shared/constants.ts` owns every new numeric limit and exports `MAX_EVENT_GUEST_NOTES = 1000`, `MAX_GUEST_NOTES_PER_SESSION_WINDOW = 5`, `GUEST_NOTE_WINDOW_MS = 900_000`, `MAX_GUESTBOOK_PROMPT_LENGTH = 160`, `MANAGER_GUESTBOOK_DEFAULT_PAGE_SIZE = 25`, and `MANAGER_GUESTBOOK_MAX_PAGE_SIZE = 50`. The migration CHECK constraints, the Worker guards, and the React bounds all derive from these values."

### 7. §12.4's retry never resets the six new `guestbook_*` columns or includes the two new keys in the attempt-object delete list

**Sections:** 12.4, 12.5, 10.3

§12.4 does not say that `ExportsRepository.retry` must null the six new `guestbook_*` columns, nor that the retry route's attempt-object delete list must include `guestbook.html` and `guestbook-private.csv`. The consequence is narrow rather than an orphaned private archive: the columns are written only by `markReady` (worker/db/exports.ts:130-155), so a failed attempt leaves them null and `markFailed` writes only `state` and `error_code`. The residual gaps are that a retried *expired* job carries prior-attempt key, byte, and digest values on its row until the new attempt's `markReady` overwrites them — and they persist if that retry also fails — and that if the expiry-time R2 delete throws, the retry route is the only recovery path and would not reach the two guestbook objects.

**Fix.** Add to §12.4: "Retry deletes the prior attempt's `guestbook.html` and `guestbook-private.csv` using the keys stored on the job row, and the same guarded update that resets `object_key`, `manifest_object_key`, and `part_count` also nulls all six `guestbook_*` object, byte, and digest columns."

## Checked and dismissed

Two candidate findings were checked and dismissed. First, the claim that the new `restore` action and `expectedState` have no representable state, guard, or owner is refuted by the spec itself: §5.3 already defines the four-value derived note state including `deleted` (so `deleted` never needed to be a column value), §8.3 states the restore mutation verbatim ("Clear `deleted_at`, set `rejected`, and clear `approved_at`"), §8.4 fixes the restore target as Hidden and never directly Shared, §9.3 defines the stale-action conflict, and §16.2 pins it as a test. The only residual is that §9.3 does not flag `expectedStatus` → `expectedState` as a breaking rename of an existing request field, and that lands inside the Manager rewrite §8 already mandates. Second, the claim that §12.5 states an expiry order the cleanup sweep does not have is refuted as a spec defect: the code description is accurate (`expireReady` at worker/db/exports.ts:182-192 flips state before worker/workflows/cleanup.ts:64-73 deletes objects), but §12.5 normatively requires the opposite order — "deletes the HTML, private CSV, manifest, and every ZIP part before moving the job to Expired" — and §13.3 requires the retry property, which together are the fix; a design spec stating target behavior that differs from current code is the spec doing its job. Sub-claims dismissed inside surviving findings, so the planner does not chase them: the new `EXPORT_*` strings need no `ApiErrorCode` entry (workflow codes are free-form `error_code` values, and the existing catch already defaults to `EXPORT_FAILED`); `uploadsEnabled` is not a settings-schema field (worker/routes/manage.ts:37-42 states it is deliberately absent); the archive part/path interpolated into `guestbook.html` is already sanitized by `safeBasename`; making `idempotencyKey` required breaks no shipped caller because EventPage always sends one; no client code branches on `MEDIA_STATE_CONFLICT`; and the `guest_message_rate_limits` CHECK is bounded scratch that can be dropped and recreated rather than shadow-rebuilt.

## Method

Seven independent reviewers covered internal consistency, codebase fit, privacy and
authorization, D1/SQLite feasibility, export and cleanup integration, binding repository
conventions, and load-bearing omissions. They produced 83 findings, merged to 22 canonical
ones. Each was then given to an adversarial verifier instructed to refute it and to default
to refutation under uncertainty; findings that survived are reported above, with the
verifiers' narrowed claims preferred over the original wording. Every file:line citation in
this document was re-opened against the working tree at 911f8df.

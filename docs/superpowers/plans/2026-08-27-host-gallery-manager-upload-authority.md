# Host Gallery Manager Upload Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan one task at a time. Use test-driven development, preserve all existing Slice 1–4 work, and do not commit unless the user asks.

**Goal:** Let an authorized host add photos through the existing canonical upload pipeline, make Pause mean *guest uploads only*, and give the Album a durable provenance and generation contract — all on the server, without a second upload implementation.

**Architecture:** `0021_manager_upload_and_album_era.sql` is the one additive migration this slice may create; it carries both the server-only upload actor and the Album era columns because a migration is immutable once written and both halves must reach D1 together. `UploadService` gains a server-created `UploadAuthority` discriminant so guest schedule enforcement and Manager allowance are two branches of one pipeline rather than two pipelines. `ManagerUploadActorService` resolves a role-aware `uploader_session_id` and never mints a cookie. Four Manager routes mirror the guest reserve/content/finalize/cancel paths and drive the one `receiveMediaUpload`, the one `retireMediaObjects`, the one `MediaRepository.reserve*`, and every existing promotion fence — those gain the authority as a parameter and are not forked. Because the guest pause and schedule are encoded in the repository's own SQL, the authority also selects the intake predicate; a route-level guard alone would leave a paused Manager upload writing bytes it could never commit.

**Tech Stack:** TypeScript, Hono on Cloudflare Workers, D1, R2, Zod, Vitest with `vitest-pool-workers`.

**Spec:** `docs/superpowers/specs/2026-08-23-host-gallery-lifecycle-contribution-design.md`

## Global constraints and preflight rulings

- Work only in `/home/henry/candidary/.worktrees/gallery-roadmap-remediation` on branch `codex/gallery-roadmap-remediation`. Do not push, deploy, merge, migrate a remote database, mutate a pull request, or change secrets.
- **Compatibility-target ruling.** The slice specification says migration 0021 must be safe "while the 0018 Worker is still serving." That sentence was written against the pre-Slice-1 baseline. Slices 1 and 3 have since shipped `0019_media_recovery.sql` and `0020_export_progress.sql`, so the real migration-first predecessor for this release is the **0020 Worker**. Read every "0018 Worker" sentence in the slice spec as "the currently deployed predecessor Worker," and prove compatibility against a populated 0020 fixture. Record this ruling in the checkpoint report; do not silently reinterpret any other spec sentence.
- Existing migrations `0001`–`0020` are immutable. This slice creates exactly `0021_manager_upload_and_album_era.sql`. It must pass fresh-D1 and populated-0020 upgrade tests.
- The migration writes **both** halves — upload actor and Album era — in one file. The Album-era half is consumed by a later checkpoint (`2026-08-27-host-gallery-album-era-reconciliation.md`); authoring it here is deliberate and is not scope creep. Its triggers must be correct and tested here even though no route reads them yet.
- Do not add a second upload pipeline, a Manager-only queue, a presigned URL, or a new R2 write path. `receiveMediaUpload`, `retireMediaObjects`, `assertWorkerIngressEnabled`, `MediaRepository.reserve`/`reserveBatch`/`refreshIdempotent`, and the tombstone/promotion fences are reuse boundaries. **A reuse boundary means one implementation, not a frozen signature.** `receiveMediaUpload` and the repository statements it drives take the authority as a new parameter in Task 4; what may not be duplicated is the buffering, validation, create-only write, re-read, and commit sequence itself.
- A server-only upload actor is identity storage. It has random secret and CSRF digests whose source secrets are discarded at creation, and browser session resolution rejects it **before** any secret comparison. It can never authorize a request.
- The client may never choose its own authority. `UploadAuthority` is constructed by the route from `requireManager`/`resolveEventSession` output only.
- Authority is carried through reservation, idempotent refresh, post-buffer ingress claim, and final commit SQL. Do not reduce it to a route-time boolean. A request that was authorized at the route and then spent seconds buffering bytes must be re-proved against the *same* authority in the claim and the commit, so a rotation, sign-out, membership removal, or account disablement that lands mid-buffer loses the write.
- **Intake-predicate ruling.** `worker/db/media.ts` interpolates the module constant `PHOTO_INTAKE_OPEN_SQL` — `uploads_enabled = 1 AND COALESCE(photos_open_from, event_start_at) <= ?` — at eight upload-path sites. At `153d05f` they are: `claimReservationIngress`, `commitReservationIngress`, `idempotentRefreshConflict`, both branches of `refreshIdempotent`, `reserve`, and two sites in `reserveBatch`. Every one of them encodes the *guest* pause and the *guest* schedule. Replacing `assertCanUpload` alone therefore does not open the Manager path: a paused or pre-start Manager reserve would still be refused by SQL, and a Manager upload paused between the route check and the commit would lose its bytes after they were already written. All eight sites must take their predicate from the authority. No other `PHOTO_INTAKE_OPEN_SQL` site exists, and no site outside this list may change.
- Every cross-actor probe — guest touching a Manager reservation, Manager touching a guest, another account's, a revoked link's, or another event's — returns the existing generic `RESOURCE_FORBIDDEN` 403. Never disclose which condition failed.
- Manager cancel accepts only `reserved` and `failed` media. A stored original is removed only through Intake's Slice 1 recoverable trash path.
- Manager upload responses use the Slice 1 `UploadMediaView` allowlist and batch envelopes. No route may return a session ID, object key, bucket generation, access-token ID, reservation internals, or account identity.
- The server always stores `guest_name = 'Host'` for a Manager upload. The batch body accepts no guest name, account ID, actor ID, event ID, upload URL, or object key.
- Manager actors deliberately ignore the guest schedule and the guest pause, but still require a live event management window, Worker ingress, reservation/media/storage caps, and the full type/size/signature/dimension validation.
- Every behavior change follows RED → GREEN → REFACTOR. The test must fail for the intended missing behavior before production code changes.
- Record RED/GREEN evidence and exact files in `.superpowers/sdd/2026-08-27-host-gallery-manager-upload-authority/`, then take an independent spec and code review. Fix every P1/P2 before advancing.

## Checkpoint boundary

This is the first of five Slice 5 checkpoints. It owns the migration, the server upload authority, the Manager upload routes, and the atomic management-link rotation transaction that keeps actors and reservations consistent. It does **not** own the Manager upload dialog, the queue's `onFinalized`/`cancelReservation` extensions, `hostUploadAvailability` in the Manager projection, the Album reconciliation projection or `/album/start` extension, the rotation availability projection or its confirmation UI, first-run copy, or the safety ladder. Those belong to the four later checkpoints. Do not implement them opportunistically.

---

### Task 1: Migration 0021 — upload actor and Album era

**Files:**
- Create: `migrations/0021_manager_upload_and_album_era.sql`
- Create: `tests/worker/migration-0021.test.ts`
- Modify: `scripts/verify-fresh-d1.ts`
- Modify: `tests/unit/verify-fresh-d1.test.ts`

**Interfaces:**
- Produces schema only. No TypeScript contract changes in this task.

Schema added:

```sql
ALTER TABLE event_sessions ADD COLUMN manager_upload_account_id TEXT
  REFERENCES host_accounts(id);
ALTER TABLE media ADD COLUMN album_pick_version INTEGER
  CHECK (album_pick_version IS NULL OR album_pick_version = 1);
ALTER TABLE events ADD COLUMN album_pick_generation INTEGER NOT NULL DEFAULT 0
  CHECK (album_pick_generation >= 0);
```

- [ ] **Step 1: Write the failing migration suite**

Create `tests/worker/migration-0021.test.ts` covering, against `TEST_MIGRATIONS`:

*Actor half*
- the partial unique index rejects a second **live** actor row for the same `(event_id, manager_upload_account_id)` and accepts one after the first is revoked;
- an insert or update setting `manager_upload_account_id` non-null with `role = 'guest'` fails;
- the same with `can_claim_owner = 1` fails;
- a null `manager_upload_account_id` row is unaffected by both triggers;
- the foreign key to `host_accounts(id)` is enforced.

*Album era half*
- backfill stamps `album_pick_version = 1` on exactly those `media` rows with non-null `favorited_at` whose event has a **saved** album (`event_albums.saved_at IS NOT NULL`), and leaves unsaved-album favorites null;
- a legacy-shaped write of `favorited_at` from null to an instant — the predecessor Worker's exact statement, touching no other column — **commits** and stamps version `1`;
- a legacy-shaped write from an instant to null **commits** and clears the version;
- both of those assert on the committed row, not on the absence of an exception, so a guard that aborts the statement before the normalizer runs fails the test rather than passing it vacuously;
- a direct version-only write whose resulting `(favorited_at, album_pick_version)` pair disagrees is rejected, and the row is unchanged afterwards;
- a compound write that sets both columns to a consistent pair in one statement commits and fires no normalizer twice;
- `events.album_pick_generation` increments **exactly once** for each of: pick, unpick, trash of a picked row, restore of a picked row, permanent guest deletion of an *active* picked row;
- cleanup of an **already-trashed** picked row does **not** increment, because it was already ineligible;
- a stored/deleted transition on an unpicked row does not increment;
- two events' generations move independently.

Use identical timestamps across fixture rows so no assertion can pass by clock ordering.

- [ ] **Step 2: Run the new suite and verify RED**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/migration-0021.test.ts
```

Expected: FAIL because `migrations/0021_manager_upload_and_album_era.sql` does not exist.

- [ ] **Step 3: Write the migration**

Write the three `ALTER TABLE` statements above, then:

- `CREATE UNIQUE INDEX event_sessions_manager_upload_actor ON event_sessions (event_id, manager_upload_account_id) WHERE manager_upload_account_id IS NOT NULL AND revoked_at IS NULL;`
- `BEFORE INSERT` and `BEFORE UPDATE` triggers on `event_sessions` that `RAISE(ABORT, ...)` when `NEW.manager_upload_account_id IS NOT NULL AND (NEW.role <> 'manager' OR NEW.can_claim_owner <> 0)`;
- one backfill `UPDATE media SET album_pick_version = 1 WHERE favorited_at IS NOT NULL AND event_id IN (SELECT event_id FROM event_albums WHERE saved_at IS NOT NULL)`;
- `AFTER UPDATE OF favorited_at ON media` normalization triggers for the two legacy transitions, each `WHEN` fenced on the exact old/new pair so a compound write does not fire twice;
- a `BEFORE UPDATE ON media` guard that aborts when the resulting `(favorited_at, album_pick_version)` pair disagrees — a non-null stamp with a null version, or a null stamp with a non-null version — subject to the trigger-ordering ruling below;
- `AFTER UPDATE ON media` and `AFTER DELETE ON media` generation triggers, each `WHEN`-fenced on an actual Album-eligibility change, performing `UPDATE events SET album_pick_generation = album_pick_generation + 1 WHERE id = ...`.

Document at the top of the file why the triggers rather than the Worker own the generation: they cover a predecessor Worker's writes and the new Worker's writes exactly once, so no fourth finalization migration is needed.

**Trigger-ordering ruling.** SQLite runs every `BEFORE UPDATE` trigger before the row is written and before any `AFTER UPDATE` trigger. A guard that aborts on *any* disagreeing pair therefore rejects the very write the normalizer exists to repair: the predecessor Worker's `UPDATE media SET favorited_at = ?` produces `(instant, NULL)` at BEFORE time, and the statement dies with `inconsistent pair` before the `AFTER` trigger can stamp version `1`. Confirmed against SQLite directly at plan time. The guard must therefore carve out exactly the two predecessor-shaped transitions the normalizer repairs, and nothing else:

```sql
CREATE TRIGGER media_album_pick_pair_guard BEFORE UPDATE ON media
WHEN ((NEW.favorited_at IS NOT NULL AND NEW.album_pick_version IS NULL)
   OR (NEW.favorited_at IS NULL AND NEW.album_pick_version IS NOT NULL))
  -- Predecessor pick: stamps arrive one statement later, from the AFTER trigger.
  AND NOT (OLD.favorited_at IS NULL AND NEW.favorited_at IS NOT NULL
           AND NEW.album_pick_version IS NULL AND OLD.album_pick_version IS NULL)
  -- Predecessor unpick: the stale version is cleared one statement later.
  AND NOT (OLD.favorited_at IS NOT NULL AND NEW.favorited_at IS NULL
           AND NEW.album_pick_version IS NOT NULL
           AND NEW.album_pick_version IS OLD.album_pick_version)
BEGIN SELECT RAISE(ABORT, 'media.album_pick_version disagrees with media.favorited_at'); END;
```

The carve-outs are transition-shaped, not column-shaped: each requires the *old* value to prove the row is mid-normalization, so a direct version-only write — where `favorited_at` does not move — still aborts. The normalizers' own writes re-enter the guard with a consistent pair and pass it on the ordinary branch, so no recursion fence is needed. Do not widen either carve-out to a bare `NEW`-only condition; that would let an arbitrary inconsistent write through.

Verify the ordering directly against `sqlite3` before writing the migration, not only through the Vitest suite: a single `.sql` script that creates the table, both normalizers, and the guard, then runs `UPDATE media SET favorited_at = ?`, must exit zero and leave `album_pick_version = 1`. That probe takes seconds and localizes the failure to the trigger, where the suite would only report a migration that does not apply.

- [ ] **Step 4: Verify GREEN**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/migration-0021.test.ts
```

Expected: PASS.

- [ ] **Step 5: Prove upgrade from a populated 0020 database**

Extend the suite with a fixture that applies `0001`–`0020`, writes guest media, favorites, a saved album, an unsaved album, trashed rows, and export jobs, and only then applies `0021`. Assert the backfill result, that no pre-existing row changed except the intended version stamps, and that `album_pick_generation` starts at `0` for every event.

- [ ] **Step 6: Extend fresh-D1 verification**

Update `scripts/verify-fresh-d1.ts` and `tests/unit/verify-fresh-d1.test.ts` for the new expected final migration and post-`0021` schema fingerprint.

```bash
npm run verify:fresh-d1
npx vitest run --config vitest.config.ts tests/unit/verify-fresh-d1.test.ts
```

Expected: both exit zero.

- [ ] **Step 7: Commit the schema**

```bash
git add migrations/0021_manager_upload_and_album_era.sql tests/worker/migration-0021.test.ts scripts/verify-fresh-d1.ts tests/unit/verify-fresh-d1.test.ts
git commit -m "feat: add the manager upload actor and album era schema"
```

---

### Task 2: Actor-aware session storage that cannot authorize

**Files:**
- Modify: `worker/db/types.ts`
- Modify: `worker/db/sessions.ts`
- Modify: `worker/auth/service.ts`
- Modify: `tests/worker/auth-api.test.ts`
- Modify: `tests/worker/repositories.test.ts`

**Interfaces:**
- Produces:

```ts
export interface SessionRecord {
  // …existing fields
  /** Non-null only for a server-only Manager upload actor. Never authorizes a request. */
  managerUploadAccountId: string | null;
}
```

- `SessionsRepository.createManagerUploadActor(input)` inserts an actor row with random discarded-source digests.
- `SessionsRepository.getLiveManagerUploadActor(eventId, accountId)` returns the one live actor or null.
- `SessionsRepository.revokeManagerUploadActors(eventId, accountId | null, revokedAt)` revokes by account or by event.

- [ ] **Step 1: Write the failing rejection test**

In `tests/worker/auth-api.test.ts`, insert an actor row directly, then attempt to resolve an event session cookie built from a secret whose digest was *deliberately made to match* that row. Assert the resolve fails with the ordinary session refusal and that the failure occurs without a secret comparison — assert it by making the row's `secret_digest` equal the tested digest, so only an explicit actor rejection can produce a refusal.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/auth-api.test.ts -t 'upload actor'
```

Expected: FAIL — the actor row currently resolves as an ordinary manager session.

- [ ] **Step 3: Implement the field and the rejection**

Add `manager_upload_account_id` to every `event_sessions` column list and to `mapSession`. In `AuthService.resolve`/`resolveEventSession`, reject a row whose `managerUploadAccountId !== null` **before** the digest comparison. Add the three repository methods; `createManagerUploadActor` generates two random secrets, digests them, and lets the plaintext go out of scope without returning it.

- [ ] **Step 4: Verify GREEN and prove no secret leaves the service**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/auth-api.test.ts tests/worker/repositories.test.ts
```

Expected: PASS. Add a repository assertion that `createManagerUploadActor` returns a record with no secret-bearing field.

- [ ] **Step 5: Commit**

```bash
git add worker/db/types.ts worker/db/sessions.ts worker/auth/service.ts tests/worker/auth-api.test.ts tests/worker/repositories.test.ts
git commit -m "feat: store a server-only manager upload actor"
```

---

### Task 3: `ManagerUploadActorService`

**Files:**
- Create: `worker/services/manager-upload-actor.ts`
- Create: `tests/worker/manager-upload-actor.test.ts`

**Interfaces:**
- Produces:

```ts
export class ManagerUploadActorService {
  constructor(env: AppEnv);
  /** Reservation-time resolution. May create the one live account actor. */
  ensureForReservation(auth: ManagerAuth, now?: Date): Promise<UploadAuthority>;
  /** Content/finalize/cancel resolution. Never creates. */
  lookupForExistingUpload(auth: ManagerAuth): Promise<UploadAuthority | null>;
}
```

- [ ] **Step 1: Write the failing service suite**

Cover:
- a `via: 'link'` Manager resolves to `{ kind: 'manager-link', actorSessionId: <that event session id> }` and creates no row;
- an account owner and an account cohost each resolve to `{ kind: 'manager-account', … }`, creating exactly one row the first time and reusing it the second;
- two concurrent `ensureForReservation` calls for the same `(eventId, accountId)` produce exactly one live row — assert with a `DB.batch`-level race or by asserting the unique index converts the loser into a re-read rather than an error;
- `lookupForExistingUpload` returns null when no live actor exists and never inserts;
- a revoked actor is not reused; a new `ensureForReservation` creates a fresh identity;
- the created actor carries the event's **current** Manager access-token FK and the event's `managementAccessExpiresAt`.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/manager-upload-actor.test.ts
```

Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement the service**

Membership and lifecycle are already checked by `requireManager` before the service is called; the service must not re-derive authorization, only identity. On unique-index conflict, re-read and return the winner rather than throwing.

- [ ] **Step 4: Verify GREEN**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/manager-upload-actor.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add worker/services/manager-upload-actor.ts tests/worker/manager-upload-actor.test.ts
git commit -m "feat: resolve a role-aware manager upload actor"
```

---

### Task 4: One pipeline, two authorities

**Files:**
- Modify: `shared/errors.ts`
- Modify: `worker/services/uploads.ts`
- Modify: `worker/db/media.ts`
- Modify: `worker/storage/media.ts`
- Modify: `tests/worker/upload-api.test.ts`
- Modify: `tests/worker/photo-intake-api.test.ts`
- Modify: `tests/worker/repositories.test.ts`

**Interfaces:**
- Produces:

```ts
export type UploadAuthority =
  | { kind: 'guest'; actorSessionId: string; eventSessionId: string }
  | { kind: 'manager-link'; actorSessionId: string; eventSessionId: string }
  | { kind: 'manager-account'; actorSessionId: string; hostSessionId: string; accountId: string };
```

`UploadService.initiate`/`initiateBatch` accept `(authority, event, input, now)` instead of `AuthenticatedSession`. `prepareReservation` takes the attribution separately, so no account field can become display copy.

- The authority also selects the SQL intake predicate, which is what actually admits or refuses the write:

```ts
/** The event-state predicate this authority's writes must satisfy, in SQL. */
export function intakePredicateSql(authority: UploadAuthority): string;
// 'guest'                       → uploads_enabled = 1 AND COALESCE(photos_open_from, event_start_at) <= ?
// 'manager-link' | 'manager-account' → management_access_expires_at > ?
```

Both branches bind exactly one instant, so every existing call site keeps its parameter order. The guest string stays byte-identical to today's `PHOTO_INTAKE_OPEN_SQL`; a diff of the guest SQL is a defect, not a refactor.

- `receiveMediaUpload` takes the authority in place of the bare `uploaderSessionId`:

```ts
export async function receiveMediaUpload(
  canonicalBucket: R2Bucket,
  repository: MediaRepository,
  media: MediaRecord,
  timelineContext: MediaTimelineContext,
  authority: UploadAuthority,   // was: uploaderSessionId: string
  bytes: ArrayBuffer,
  contentType: string,
  now?: Date,
): Promise<MediaRecord>;
```

It forwards the authority to `claimReservationIngress` and `commitReservationIngress`, which keep matching `m.uploader_session_id = authority.actorSessionId` and now also interpolate that authority's intake predicate. Nothing else in the function changes.

- One new `ApiErrorCode` in `shared/errors.ts`, `UPLOAD_RESERVATION_CANCELED`, answers an idempotent replay whose `(event, actor, idempotencyKey)` resolves to a terminally canceled or deleted row. Today `refreshIdempotent` collapses that case into the generic `UPLOAD_FINALIZE_CONFLICT`, which is indistinguishable from a live conflict — and the browser cannot then tell "my cancel landed and the response was lost" from "something else went wrong," which is exactly the ambiguity the Manager cleanup controller must resolve in the next checkpoint.

  The distinction is **authority-scoped**: the two Manager kinds receive `UPLOAD_RESERVATION_CANCELED` 409; `kind: 'guest'` keeps `UPLOAD_FINALIZE_CONFLICT` and its existing message byte for byte, because the guest wire contract is not this slice's to change. Neither branch resurrects the row. Document the new code in `docs/operations.md` in Task 7, per the repository's error convention.

- [ ] **Step 1: Write the failing pause-split tests**

In `tests/worker/photo-intake-api.test.ts`, add:
- with the event paused, a guest reserve returns `UPLOADS_DISABLED` 409 (existing behavior — keep it as a regression);
- with the event paused, a Manager reserve **succeeds**;
- before the scheduled start, a guest reserve fails and a Manager reserve succeeds;
- after `managementAccessExpiresAt`, a Manager reserve fails with the existing lifecycle refusal;
- a Manager reservation still fails on media cap, storage cap, unsupported type, oversize, and disabled Worker ingress;
- with the event paused, a Manager reservation **also completes its content PUT and finalize** — the row reaches `stored` with `object_bucket_generation = 'canonical'`. This is the case a route-level guard alone silently fails: the reservation is admitted and the bytes are written to R2, and only the claim or the commit refuses, so the assertion must be on the committed row, not on the reserve response;
- an idempotent Manager replay while paused re-enters the same media row rather than creating a second one.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/photo-intake-api.test.ts
```

Expected: FAIL — `assertCanUpload` refuses every non-guest role.

- [ ] **Step 3: Implement the authority split**

Replace `assertCanUpload` with an authority-driven guard: `kind: 'guest'` requires `resolvePhotoIntake(event, now).photosOpen`; the two Manager kinds require only the live management window. Thread `authority.actorSessionId` into `ReserveMediaRecord.uploaderSessionId` and pass the fixed `'Host'` attribution for Manager kinds. Guest call sites keep their behavior byte for byte.

Then replace the hard-coded `PHOTO_INTAKE_OPEN_SQL` interpolation with `intakePredicateSql(authority)` at all eight sites named in the intake-predicate ruling. `ReserveMediaRecord` carries the authority so `reserve`, `reserveBatch`, `refreshIdempotent`, and `idempotentRefreshConflict` reach it without a second parameter; `claimReservationIngress` and `commitReservationIngress` take it in their input objects. `idempotentRefreshConflict` must keep deriving its refusal from the *authority's* predicate, or a paused Manager replay reports `UPLOADS_DISABLED` for a state that does not apply to it.

`intakePredicateSql` lives in `worker/db/media.ts` beside `PHOTO_INTAKE_OPEN_SQL`, which stays the guest branch's value, and takes `UploadAuthority` through an `import type` so no value-level cycle forms with `worker/services/uploads.ts`. Delete no site and add none: after this step every one of the eight interpolations reads `intakePredicateSql(...)`, and the constant is referenced only by its own definition and that function.

- [ ] **Step 4: Carry authority into the claim and the commit**

`receiveMediaUpload` takes the authority and forwards it. `claimReservationIngress` and `commitReservationIngress` must re-prove, in the same statement that admits the write, that the authority which reserved the row is *still* the authority now committing it. Matching `uploader_session_id` alone is not sufficient for the account kind: the actor row outlives the browser credential that created it, so the claim and the commit each add an `EXISTS` over the authority's own credential — for `manager-account`, a live `host_accounts` row plus live `event_hosts` membership for that event; for `manager-link`, the actor's access token still unrevoked and unexpired; for `guest`, today's behavior unchanged.

Cover, in `tests/worker/repositories.test.ts` and `tests/worker/upload-api.test.ts`:
- an idempotent replay under a *different* actor for the same `(event, idempotencyKey)` does not re-enter the other actor's row;
- **revocation during buffer, per authority kind.** Reserve, then revoke between the reserve and the content PUT, then send the bytes: an account disabled, a membership removed, a management link rotated, and a guest event session signed out each lose the claim, leave the media row `reserved`, leave the promotion row unmoved, and return the generic refusal;
- the same four revocations applied between a successful claim and the commit each lose the commit, so no `stored` row and no counter delta appears;
- a Manager upload whose event's `managementAccessExpiresAt` passes mid-buffer is refused by the same predicate, and the guest equivalent — a pause landing mid-buffer — still refuses the guest;
- a Manager reserve replayed after that same reservation was canceled returns `UPLOAD_RESERVATION_CANCELED` 409, creates no row, and leaves the canceled row terminal;
- the identical guest replay still returns `UPLOAD_FINALIZE_CONFLICT` with its existing message — assert the exact code and string, so the authority-scoped branch cannot drift into the guest path.

- [ ] **Step 5: Verify GREEN**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/upload-api.test.ts tests/worker/photo-intake-api.test.ts tests/worker/repositories.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add shared/errors.ts worker/services/uploads.ts worker/db/media.ts worker/storage/media.ts tests/worker/upload-api.test.ts tests/worker/photo-intake-api.test.ts tests/worker/repositories.test.ts
git commit -m "feat: give the upload pipeline a server-created authority"
```

---

### Task 5: The four Manager upload routes

**Files:**
- Modify: `worker/routes/manage.ts`
- Create: `tests/worker/manager-upload-api.test.ts`
- Modify: `worker/http/csrf.ts` *(only if the account/link pair selection needs an explicit helper)*

**Interfaces:**
- Produces four routes, each calling `requireManager(context, { write: true })` **before** reading or buffering a body:

```
POST   /api/manage/events/:eventId/uploads/batch
PUT    /api/manage/events/:eventId/uploads/:mediaId/content
POST   /api/manage/events/:eventId/uploads/:mediaId/finalize
DELETE /api/manage/events/:eventId/uploads/:mediaId
```

Batch body: `z.object({ files: z.array(fileSchema).min(1).max(UPLOAD_BATCH_SIZE) }).strict()` — `fileSchema` reused from the guest routes, with no `guestName`. Reservation URLs point only at the Manager content path.

- [ ] **Step 1: Write the failing authorization matrix**

In `tests/worker/manager-upload-api.test.ts`, table-drive every row from the slice spec's matrix: account owner, account cohost, current management link, both cookies present (account takes precedence), missing CSRF, invalid CSRF, wrong-scope CSRF header, cross-event path, a guest's reservation, another account's actor reservation, a rotated old link's reservation, expired link, expired event, deleted event, disabled account, and removed membership. Assert the generic `RESOURCE_FORBIDDEN` 403 body for every cross-actor probe, and assert that a probe never creates an actor row.

Add response-shape assertions: no `uploaderSessionId`, `objectKey`, `objectBucketGeneration`, `accessTokenId`, `accountId`, or `reservationExpiresAt`-adjacent internals in any Manager upload response; `guestName` is exactly `'Host'`.

- [ ] **Step 2: Write the failing ingress-ordering test**

Assert that a `PUT .../content` with a bad Origin or missing CSRF is refused **without** the body being read: send an oversize body and assert the refusal arrives with the existing 403 and that no promotion row moved.

- [ ] **Step 3: Run and verify RED**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/manager-upload-api.test.ts
```

Expected: FAIL — the routes do not exist.

- [ ] **Step 4: Implement the routes**

Mirror `worker/routes/uploads.ts` exactly, substituting `requireManager({ write: true })` plus `ManagerUploadActorService` for `guestForSlug`, and matching media on `uploaderSessionId === authority.actorSessionId`. The routes call the one `receiveMediaUpload` and the one `retireMediaObjects` — the same implementations the guest routes call, now passing the authority Task 4 threaded through them rather than a bare session id. `DELETE` accepts only `reserved` and `failed` state and returns the existing conflict for a stored row.

The content route resolves its authority with `lookupForExistingUpload` **before** buffering and passes that same object to `receiveMediaUpload`; it must not re-resolve, re-`ensure`, or downgrade to `media.uploaderSessionId` after the bytes arrive. Re-resolving after the buffer would re-admit exactly the mid-buffer revocation Task 4 exists to refuse.

- [ ] **Step 5: Verify GREEN and re-run the guest suite**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/manager-upload-api.test.ts tests/worker/upload-api.test.ts tests/worker/manage-api.test.ts
```

Expected: PASS with no guest-route behavior change.

- [ ] **Step 6: Commit**

```bash
git add worker/routes/manage.ts tests/worker/manager-upload-api.test.ts
git commit -m "feat: accept host photos through the manager routes"
```

---

### Task 6: Atomic management-link rotation

**Files:**
- Modify: `worker/services/links.ts`
- Modify: `worker/db/tokens.ts`
- Modify: `worker/db/sessions.ts`
- Modify: `worker/db/media.ts`
- Modify: `tests/worker/manage-api.test.ts`
- Modify: `tests/worker/manager-upload-api.test.ts`

**Interfaces:**
- `LinkService.rotateManagementLink(event, now)` becomes one `DB.batch([...])` that, as a unit: **revokes the prior Manager token**; creates the replacement; revokes every session derived from the prior token; rebinds live **account** upload actors to the replacement token; terminally cancels every revoked **link** actor's `reserved`/`failed` media with exact counter deltas; and inventories those rows' object keys for typed deletion.
- The revoke is deliberately first, because `revoked_at IS NULL` is the condition that makes a concurrent double rotation resolve to one winner. It is the batch's guarded statement, and every later statement keys its own guard off the stamp it wrote — see Step 3.
- Deletion claims run **after** commit through the existing tombstone cleanup. A failed R2 delete stays janitor-owned and never rolls credentials back.

- [ ] **Step 1: Write the failing rotation tests**

- an account-owned reservation survives rotation and can still finalize afterwards;
- a link-owned reservation does **not** transfer: it is terminally canceled, and the event's media count and byte counters fall by exactly the canceled rows;
- the old link's sessions are revoked;
- the account's live actor now points at the replacement token;
- a rejected transaction (force a constraint failure inside the batch) leaves the old token, its sessions, its actors, and its reservations usable;
- a failing R2 delete after commit does not restore the old credential.

**Zero-row permutations.** Every dependent step of this batch is legitimately empty on some real event, and each empty step must leave every *later* step intact. Drive one table over the presence or absence of each optional cohort and assert the full end state for all of them:
- no live sessions on the old token — the account actor is still rebound and link reservations are still canceled;
- no live account actor — sessions are still revoked and link reservations are still canceled;
- no link-owned `reserved`/`failed` media — the token still rotates, sessions are still revoked, and the actor is still rebound;
- none of the three — the token still rotates and the response still carries the replacement link;
- all three present — every effect lands exactly once, and the counters fall by exactly the canceled rows.

An implementation that chains each statement to its predecessor passes the all-present row and silently skips work on every other row, so the empty permutations are the ones that must exist before the code does.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/manage-api.test.ts -t 'rotate'
```

Expected: FAIL — rotation is currently two sequential statements with no session, actor, or reservation handling.

- [ ] **Step 3: Implement the batch**

Guard the first statement — the rotation itself — and check `results[0].meta.changes === 1`, per the repository's D1 concurrency convention. Do not read-then-write any counter.

**`changes()` is the wrong guard for this batch.** `changes()` reports the row count of the *immediately preceding* completed statement, so the convention documented in `CLAUDE.md` — first statement guarded, dependents appending `AND changes() = 1` — holds only while every dependent changes exactly one row. This batch breaks that precondition: revoking sessions, rebinding an actor, and canceling reservations are each legitimately zero-row. A SQLite probe of the chained form at plan time rotated the token, revoked zero sessions, and then left the account actor bound to the **old** token, because the zero from the empty step propagated into the next statement's `WHERE`.

Every dependent therefore guards on a **stable fact of the transaction**, not on the previous statement:

```sql
-- Statement 1: the guarded rotation. `?rot` is the rotation instant.
UPDATE event_access_tokens SET revoked_at = ?rot
 WHERE event_id = ? AND role = 'manager' AND revoked_at IS NULL;

-- Every dependent re-proves that same rotation and is unaffected by an empty sibling.
... WHERE <its own condition>
  AND EXISTS (SELECT 1 FROM event_access_tokens
              WHERE event_id = ? AND role = 'manager' AND revoked_at = ?rot);
```

The instant is generated once by the caller and bound into every statement, so the predicate identifies *this* rotation rather than any rotation. Counter deltas stay in SQL — derive them from the same guarded selection that cancels the rows, never from a prior read. Verify the guard choice directly: the zero-row permutations from Step 1 are exactly the cases the chained form passes vacuously.

- [ ] **Step 4: Verify GREEN**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/manage-api.test.ts tests/worker/manager-upload-api.test.ts tests/worker/auth-api.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add worker/services/links.ts worker/db/tokens.ts worker/db/sessions.ts worker/db/media.ts tests/worker/manage-api.test.ts tests/worker/manager-upload-api.test.ts
git commit -m "fix: make management link rotation one transaction"
```

---

### Task 7: Evidence and checkpoint gates

**Files:**
- Modify: `docs/superpowers/host-gallery-verification-matrix.md`
- Modify: `docs/operations.md`
- Modify: `docs/deployment.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Open the Slice 5 matrix section**

Add a `## Slice 5 — Lifecycle and contribution` section with its table header and **no rows yet**.

**Row-completeness ruling.** The matrix admits exactly four dispositions — `verified-existing`, `implemented`, `deferred-approved`, `out-of-scope-approved` — and its own rule is that "a row is complete only when its owning test file names a real test that fails without the change." C-08 and C-12 are each half-proved by this checkpoint: the server behavior exists and is tested, but the Manager dialog and the guest surfaces that the findings are actually about arrive in later checkpoints. There is no disposition for that, and inventing a fifth would weaken the four that Slices 1–4 already rely on. **A finding's row is written once, by the checkpoint that closes it** — C-12 by the Manager upload dialog checkpoint, C-08 by the pause-scope checkpoint. Do not write a partial row here and rewrite it later; a reader must never encounter a matrix row that overstates what is proved.

Record this checkpoint's landed work instead as a short prose paragraph directly beneath the section heading and above the table, explicitly labelled as progress rather than disposition: the server upload authority and its four Manager routes, the pause split at the service and SQL layers, migration `0021`, and the atomic rotation transaction C-10 depends on — each naming its owning Worker test file. Do not claim a UI behavior from a Worker test.

- [ ] **Step 2: Document the operational contract**

In `docs/operations.md`, describe the server-only upload actor: what it is, that it cannot mint a cookie, that rotation rebinds account actors and cancels link-owned reservations, and how to read a stranded actor. Document `UPLOAD_RESERVATION_CANCELED` beside the other `UPLOAD_*` codes, including that it is Manager-only and that the guest path still answers `UPLOAD_FINALIZE_CONFLICT`. In `docs/deployment.md`, add `0021` to the migration-first ordering with the compatibility-target ruling from Global constraints. In `CLAUDE.md`, extend the upload-path and authorization sections with the two Manager authorities, the authority-selected intake predicate, and the `guest_name = 'Host'` rule.

- [ ] **Step 3: Run the complete checkpoint gates**

```bash
npm run typecheck
npm run lint
npm run verify:bindings
npx vitest run --config vitest.worker.config.ts tests/worker/migration-0021.test.ts tests/worker/manager-upload-actor.test.ts tests/worker/manager-upload-api.test.ts tests/worker/upload-api.test.ts tests/worker/photo-intake-api.test.ts tests/worker/manage-api.test.ts tests/worker/auth-api.test.ts
npm test
npm run build
CI_BASE_SHA="$(git merge-base origin/main HEAD)" CI_HEAD_SHA="$(git rev-parse HEAD)" npm run ci:migrations
git diff --check
```

Expected: every command exits zero. The known build chunk-size and missing-local-secret warnings may remain; no new warning is accepted.

- [ ] **Step 4: Commit the record**

```bash
git add docs/superpowers/host-gallery-verification-matrix.md docs/operations.md docs/deployment.md CLAUDE.md
git commit -m "docs: record manager upload authority evidence"
```

Do not push. The next Slice 5 checkpoint is the Manager upload dialog and queue extensions.

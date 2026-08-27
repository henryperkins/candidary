# Host Gallery Manager Upload Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan one task at a time. Use test-driven development, preserve all existing Slice 1–4 work, and do not commit unless the user asks.

**Goal:** Let an authorized host add photos through the existing canonical upload pipeline, make Pause mean *guest uploads only*, and give the Album a durable provenance and generation contract — all on the server, without a second upload implementation.

**Architecture:** `0021_manager_upload_and_album_era.sql` is the one additive migration this slice may create; it carries both the server-only upload actor and the Album era columns because a migration is immutable once written and both halves must reach D1 together. `UploadService` gains a server-created `UploadAuthority` discriminant so guest schedule enforcement and Manager allowance are two branches of one pipeline rather than two pipelines. `ManagerUploadActorService` resolves a role-aware `uploader_session_id` and never mints a cookie. Four Manager routes mirror the guest reserve/content/finalize/cancel paths and reuse `receiveMediaUpload`, `retireMediaObjects`, `MediaRepository.reserve*`, and every existing promotion fence untouched.

**Tech Stack:** TypeScript, Hono on Cloudflare Workers, D1, R2, Zod, Vitest with `vitest-pool-workers`.

**Spec:** `docs/superpowers/specs/2026-08-23-host-gallery-lifecycle-contribution-design.md`

## Global constraints and preflight rulings

- Work only in `/home/henry/candidary/.worktrees/gallery-roadmap-remediation` on branch `codex/gallery-roadmap-remediation`. Do not push, deploy, merge, migrate a remote database, mutate a pull request, or change secrets.
- **Compatibility-target ruling.** The slice specification says migration 0021 must be safe "while the 0018 Worker is still serving." That sentence was written against the pre-Slice-1 baseline. Slices 1 and 3 have since shipped `0019_media_recovery.sql` and `0020_export_progress.sql`, so the real migration-first predecessor for this release is the **0020 Worker**. Read every "0018 Worker" sentence in the slice spec as "the currently deployed predecessor Worker," and prove compatibility against a populated 0020 fixture. Record this ruling in the checkpoint report; do not silently reinterpret any other spec sentence.
- Existing migrations `0001`–`0020` are immutable. This slice creates exactly `0021_manager_upload_and_album_era.sql`. It must pass fresh-D1 and populated-0020 upgrade tests.
- The migration writes **both** halves — upload actor and Album era — in one file. The Album-era half is consumed by a later checkpoint (`2026-08-27-host-gallery-album-era-reconciliation.md`); authoring it here is deliberate and is not scope creep. Its triggers must be correct and tested here even though no route reads them yet.
- Do not add a second upload pipeline, a Manager-only queue, a presigned URL, or a new R2 write path. `receiveMediaUpload`, `retireMediaObjects`, `assertWorkerIngressEnabled`, `MediaRepository.reserve`/`reserveBatch`/`refreshIdempotent`, and the tombstone/promotion fences are reuse boundaries.
- A server-only upload actor is identity storage. It has random secret and CSRF digests whose source secrets are discarded at creation, and browser session resolution rejects it **before** any secret comparison. It can never authorize a request.
- The client may never choose its own authority. `UploadAuthority` is constructed by the route from `requireManager`/`resolveEventSession` output only.
- Authority is carried through reservation, idempotent refresh, post-buffer ingress claim, and final commit SQL. Do not reduce it to a route-time boolean.
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
- a legacy-shaped write of `favorited_at` from null to an instant stamps version `1` atomically;
- a legacy-shaped write from an instant to null clears the version;
- a direct version-only write whose resulting `(favorited_at, album_pick_version)` pair disagrees is rejected;
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
- a `BEFORE UPDATE ON media` guard that aborts when the resulting `(favorited_at, album_pick_version)` pair disagrees — a non-null version with a null stamp, or a null version with a non-null stamp — **except** during the normalization triggers' own writes, which are expressed as the same final consistent pair;
- `AFTER UPDATE ON media` and `AFTER DELETE ON media` generation triggers, each `WHEN`-fenced on an actual Album-eligibility change, performing `UPDATE events SET album_pick_generation = album_pick_generation + 1 WHERE id = ...`.

Document at the top of the file why the triggers rather than the Worker own the generation: they cover a predecessor Worker's writes and the new Worker's writes exactly once, so no fourth finalization migration is needed.

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
- Modify: `worker/services/uploads.ts`
- Modify: `worker/db/media.ts`
- Modify: `tests/worker/upload-api.test.ts`
- Modify: `tests/worker/photo-intake-api.test.ts`

**Interfaces:**
- Produces:

```ts
export type UploadAuthority =
  | { kind: 'guest'; actorSessionId: string; eventSessionId: string }
  | { kind: 'manager-link'; actorSessionId: string; eventSessionId: string }
  | { kind: 'manager-account'; actorSessionId: string; hostSessionId: string; accountId: string };
```

`UploadService.initiate`/`initiateBatch` accept `(authority, event, input, now)` instead of `AuthenticatedSession`. `prepareReservation` takes the attribution separately, so no account field can become display copy.

- [ ] **Step 1: Write the failing pause-split tests**

In `tests/worker/photo-intake-api.test.ts`, add:
- with the event paused, a guest reserve returns `UPLOADS_DISABLED` 409 (existing behavior — keep it as a regression);
- with the event paused, a Manager reserve **succeeds**;
- before the scheduled start, a guest reserve fails and a Manager reserve succeeds;
- after `managementAccessExpiresAt`, a Manager reserve fails with the existing lifecycle refusal;
- a Manager reservation still fails on media cap, storage cap, unsupported type, oversize, and disabled Worker ingress.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/photo-intake-api.test.ts
```

Expected: FAIL — `assertCanUpload` refuses every non-guest role.

- [ ] **Step 3: Implement the authority split**

Replace `assertCanUpload` with an authority-driven guard: `kind: 'guest'` requires `resolvePhotoIntake(event, now).photosOpen`; the two Manager kinds require only the live management window. Thread `authority.actorSessionId` into `ReserveMediaRecord.uploaderSessionId` and pass the fixed `'Host'` attribution for Manager kinds. Guest call sites keep their behavior byte for byte.

- [ ] **Step 4: Carry authority into the commit SQL**

`MediaRepository.refreshIdempotent` and the ingress-claim/commit statements must match on the exact `uploader_session_id` they were given. Add a repository test that an idempotent replay under a *different* actor for the same `(event, idempotencyKey)` does not re-enter the other actor's row.

- [ ] **Step 5: Verify GREEN**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/upload-api.test.ts tests/worker/photo-intake-api.test.ts tests/worker/repositories.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add worker/services/uploads.ts worker/db/media.ts tests/worker/upload-api.test.ts tests/worker/photo-intake-api.test.ts tests/worker/repositories.test.ts
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

Mirror `worker/routes/uploads.ts` exactly, substituting `requireManager({ write: true })` plus `ManagerUploadActorService` for `guestForSlug`, and matching media on `uploaderSessionId === authority.actorSessionId`. `receiveMediaUpload` and `retireMediaObjects` are called unchanged. `DELETE` accepts only `reserved` and `failed` state and returns the existing conflict for a stored row.

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
- `LinkService.rotateManagementLink(event, now)` becomes one `DB.batch([...])` that, as a unit: creates the replacement Manager token; revokes the prior token and every session derived from it; rebinds live **account** upload actors to the replacement token; terminally cancels every revoked **link** actor's `reserved`/`failed` media with exact counter deltas; and inventories those rows' object keys for typed deletion.
- Deletion claims run **after** commit through the existing tombstone cleanup. A failed R2 delete stays janitor-owned and never rolls credentials back.

- [ ] **Step 1: Write the failing rotation tests**

- an account-owned reservation survives rotation and can still finalize afterwards;
- a link-owned reservation does **not** transfer: it is terminally canceled, and the event's media count and byte counters fall by exactly the canceled rows;
- the old link's sessions are revoked;
- the account's live actor now points at the replacement token;
- a rejected transaction (force a constraint failure inside the batch) leaves the old token, its sessions, its actors, and its reservations usable;
- a failing R2 delete after commit does not restore the old credential.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/manage-api.test.ts -t 'rotate'
```

Expected: FAIL — rotation is currently two sequential statements with no session, actor, or reservation handling.

- [ ] **Step 3: Implement the batch**

Guard the first statement, append `AND changes() = 1` to the dependents, and check `results[0].meta.changes === 1` per the repository's D1 concurrency convention. Do not read-then-write any counter.

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

Add a `## Slice 5 — Lifecycle and contribution` section. Record only what this checkpoint proved: the server half of C-12 (a host can contribute a photo through the existing pipeline), the server half of C-08 (pause gates guest uploads and nothing else), and the rotation transaction that C-10 depends on. Leave every other Slice 5 finding unrecorded until its own checkpoint lands. Do not claim a UI behavior from a Worker test.

- [ ] **Step 2: Document the operational contract**

In `docs/operations.md`, describe the server-only upload actor: what it is, that it cannot mint a cookie, that rotation rebinds account actors and cancels link-owned reservations, and how to read a stranded actor. In `docs/deployment.md`, add `0021` to the migration-first ordering with the compatibility-target ruling from Global constraints. In `CLAUDE.md`, extend the upload-path and authorization sections with the two Manager authorities and the `guest_name = 'Host'` rule.

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

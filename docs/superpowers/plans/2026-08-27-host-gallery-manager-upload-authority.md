# Host Gallery Manager Upload Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan one task at a time. Use strict focused RED, minimal implementation, focused GREEN, then a fresh implementer handoff and independent review for every task. Do not commit this task or checkpoint: all five Slice 5 plans receive exactly one final commit only after every task and final Slice review gate passes.

**Goal:** Let an authorized host add photos through the existing canonical upload pipeline, make Pause mean *guest uploads only*, and give the Album a durable provenance and generation contract — all on the server, without a second upload implementation.

**Architecture:** `0021_manager_upload_and_album_era.sql` is the one additive migration this slice may create; it carries both the server-only upload actor and the Album era columns so both halves are reviewed in the one Slice change set and reach D1 together. It remains editable and reviewable until the single final Slice commit/deployment, after which normal migration immutability applies. `UploadService` gains a server-created `UploadAuthority` discriminant so guest schedule enforcement and Manager allowance are two branches of one pipeline rather than two pipelines. `ManagerUploadActorService` resolves a role-aware `uploader_session_id` and never mints a cookie. One `authorityLivenessSql`/`authorityLivenessBindings` pair is the single re-proof of that authority, `AND`-ed into reserve, idempotent refresh, ingress claim, and commit alongside the intake predicate, and the two ingress methods answer with a tagged outcome so a lost credential refuses as `RESOURCE_FORBIDDEN` rather than masquerading as a retryable conflict. Four Manager routes mirror the guest reserve/content/finalize/cancel paths and drive the one `receiveMediaUpload`, the one `retireMediaObjects`, the one `MediaRepository.reserve*`, and every existing promotion fence — those gain the authority as a parameter and are not forked. Because the guest pause and schedule are encoded in the repository's own SQL, the authority also selects the intake predicate; a route-level guard alone would leave a paused Manager upload writing bytes it could never commit.

**Tech Stack:** TypeScript, Hono on Cloudflare Workers, D1, R2, Zod, Vitest with `vitest-pool-workers`.

**Spec:** `docs/superpowers/specs/2026-08-23-host-gallery-lifecycle-contribution-design.md`

## Global constraints and preflight rulings

- Work only in `/home/henry/candidary/.worktrees/gallery-roadmap-remediation` on branch `codex/gallery-roadmap-remediation`. Do not push, deploy, merge, migrate a remote database, mutate a pull request, or change secrets.
- Preserve unrelated and untracked files plus all authored/custom content. Keep Slice 6 findings C-34, C-38, and C-62 out of scope.
- Every task is independently testable and receives a fresh implementer handoff plus an independent task review. Record focused RED/GREEN evidence; resolve every P1/P2 before advancing.
- Do not run repository-wide verification, full builds, full lint/typecheck, full E2E, `npm test`, or `ci:migrations`. Use only the named test files/spec filters, changed-file lint where applicable, the matrix parser, and `git diff --check`.
- Do not make task-level or checkpoint commits. The release owner creates exactly one final Slice 5 commit only after all five plans, focused gates, and final independent Slice review are complete.
- **Compatibility target.** The canonical Slice design names the currently deployed **0020 Worker** as 0021's migration-first predecessor. Prove compatibility against a populated 0020 fixture; no plan-local reinterpretation is permitted.
- Existing migrations `0001`–`0020` are immutable. This slice creates exactly `0021_manager_upload_and_album_era.sql`. It must pass fresh-D1 and populated-0020 upgrade tests.
- The migration writes **both** halves — upload actor and Album era — in one file. The Album-era half is consumed by a later checkpoint (`2026-08-27-host-gallery-album-era-reconciliation.md`); authoring it here is deliberate and is not scope creep. Its triggers must be correct and tested here even though no route reads them yet.
- Do not add a second upload pipeline, a Manager-only queue, a presigned URL, or a new R2 write path. `receiveMediaUpload`, `retireMediaObjects`, `assertWorkerIngressEnabled`, `MediaRepository.reserve`/`reserveBatch`/`refreshIdempotent`, and the tombstone/promotion fences are reuse boundaries. **A reuse boundary means one implementation, not a frozen signature.** `receiveMediaUpload` and the repository statements it drives take the authority as a new parameter in Task 4; what may not be duplicated is the buffering, validation, create-only write, re-read, and commit sequence itself.
- A server-only upload actor is identity storage. It has random secret and CSRF digests whose source secrets are discarded at creation, and browser session resolution rejects it **before** any secret comparison. It can never authorize a request.
- The client may never choose its own authority. `UploadAuthority` is constructed by the route from `requireManager`/`resolveEventSession` output only.
- Authority is carried through reservation, idempotent refresh, post-buffer ingress claim, and final commit SQL. Do not reduce it to a route-time boolean. A request that was authorized at the route and then spent seconds buffering bytes must be re-proved against the *same* authority in every one of those four phases, so a rotation, sign-out, membership removal, account disablement, credential-version bump, or session expiry that lands mid-request loses the write.
- **Authority-liveness ruling.** "Carried through" means one predicate, four phases, and a refusal that names the right failure. Three separate things follow from that, and a plan that supplies only the first has not carried authority anywhere:

  *One predicate, not a per-phase re-derivation.* `authorityLivenessSql(authority)` and `authorityLivenessBindings(authority, nowIso)` are the single source of the liveness fact, and every phase interpolates exactly that string with exactly those bindings. Two phases that spell the same check differently will drift, and the phase that drifts is the one nobody tests.

  *Four phases, not two.* Reserve and idempotent refresh admit rows; claim and commit admit bytes. Only guarding the last two leaves the route-authorization → reserve window open: `requireManager` resolves, the account is disabled or the link rotated, and the reserve still inserts a live reservation whose bytes are then correctly refused — a row the host is told they own and can never finish. All four phases carry it.

  *Exactly these facts, per kind.* Matching `uploader_session_id` proves which actor reserved the row, not that the actor is still authorized; for `manager-account` the actor row deliberately outlives the browser credential that created it, so the session match proves nothing about the account at all. Each kind's liveness is:

  | Kind | Liveness facts re-proved in SQL |
  | --- | --- |
  | `guest` | the `event_sessions` row for `eventSessionId` — same event, `role = 'guest'`, `revoked_at IS NULL`, `expires_at >` now — and its `event_access_tokens` row unrevoked and unexpired |
  | `manager-link` | the same, with `role = 'manager'` and `manager_upload_account_id IS NULL`, plus its access token unrevoked and unexpired |
  | `manager-account` | the `host_sessions` row for `hostSessionId` — `account_id = accountId`, `revoked_at IS NULL`, `expires_at >` now, `auth_version` equal to the account's current `auth_version` — plus `host_accounts.disabled_at IS NULL`, an owner/cohost `event_hosts` row for `(eventId, accountId)`, and the actor `event_sessions` row for `actorSessionId` — same event/account, `role = 'manager'`, `manager_upload_account_id = accountId`, non-revoked/non-expired, with `access_token_id` equal to the event's current unrevoked/unexpired Manager token |

  The `host_sessions.auth_version = host_accounts.auth_version` comparison is not decoration: a password reset or a sign-out-everywhere bumps the account version and is the *only* signal that distinguishes a still-unexpired session row from a credential the host has already invalidated. Omitting it makes "account disablement loses the write" true and "credential revocation loses the write" false.

  **The guest kind is not exempt.** The governing specification requires every phase to recheck "the current guest/link session or host session, access token, account, membership, event lifecycle, media event, and exact `uploader_session_id`" — the guest session included, which is why Task 4's own test list already requires a signed-out guest to lose the claim. What stays byte-identical for guests is the **intake predicate string** and the **wire error codes**, not the absence of a liveness recheck. A guest whose event session was revoked mid-buffer loses the write exactly as a Manager does; that is a fix, and its regression belongs in `tests/worker/upload-api.test.ts`.
- Authority liveness and the intake predicate are two independent conditions on the same statements, and neither substitutes for the other. The intake predicate answers *is this event open to this kind of actor*; liveness answers *is this actor still who it claimed to be*. Both are `AND`-ed into all eight upload-path sites.
- **Intake-predicate ruling.** `worker/db/media.ts` interpolates the module constant `PHOTO_INTAKE_OPEN_SQL` — `uploads_enabled = 1 AND COALESCE(photos_open_from, event_start_at) <= ?` — at eight upload-path sites. At `153d05f` they are: `claimReservationIngress`, `commitReservationIngress`, `idempotentRefreshConflict`, both branches of `refreshIdempotent`, `reserve`, and two sites in `reserveBatch`. Every one of them encodes the *guest* pause and the *guest* schedule. Replacing `assertCanUpload` alone therefore does not open the Manager path: a paused or pre-start Manager reserve would still be refused by SQL, and a Manager upload paused between the route check and the commit would lose its bytes after they were already written. All eight sites must take their predicate from the authority. No other `PHOTO_INTAKE_OPEN_SQL` site exists, and no site outside this list may change.
- Every cross-actor probe — guest touching a Manager reservation, Manager touching a guest, another account's, a revoked link's, or another event's — returns the existing generic `RESOURCE_FORBIDDEN` 403. Never disclose which condition failed.
- Manager cancel accepts only `reserved` and `failed` media. A stored original is removed only through Intake's Slice 1 recoverable trash path.
- **Cancel-CAS ruling.** That restriction is a property of the transition, not of the route, and it cannot be implemented as a route-level state check in front of the existing deletion path. `MediaRepository.delete` is deliberately a read-then-CAS *retry loop*: its own comment says the observed state can change between the read and the CAS — `reserved → stored` finalization is the example it names — and it re-reads and deletes the winner so a 200 never reports success while leaving an active photo behind. Handing it a media ID that the route observed as `reserved` therefore permanently deletes a stored original if the finalize lands in between, with `deleted_at` terminal and no trash row: the exact outcome this slice forbids, reached through the path that exists to be correct. `delete` also takes only `(id, deletedAt)` — it is not actor-scoped, so it cannot refuse another actor's row either. Manager cancel gets its own transition in Task 5.
- Manager upload responses use the Slice 1 `UploadMediaView` allowlist and batch envelopes. No route may return a session ID, object key, bucket generation, access-token ID, reservation internals, or account identity.
- The server always stores `guest_name = 'Host'` for a Manager upload. The batch body accepts no guest name, account ID, actor ID, event ID, upload URL, or object key.
- Manager actors deliberately ignore the guest schedule and the guest pause, but still require a live event management window, Worker ingress, reservation/media/storage caps, and the full type/size/signature/dimension validation.
- Every behavior change follows RED → minimal GREEN → scoped refactor. The test must fail for the intended missing behavior before production code changes.
- Record RED/GREEN evidence and exact files in `.superpowers/sdd/2026-08-27-host-gallery-manager-upload-authority/`; the task review checkpoint records the fresh implementer and independent reviewer outcome without committing.

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
ALTER TABLE events ADD COLUMN manager_link_revision INTEGER NOT NULL DEFAULT 0
  CHECK (manager_link_revision >= 0);
```

- [ ] **Step 1: Write the failing migration suite**

Create `tests/worker/migration-0021.test.ts` covering, against `TEST_MIGRATIONS`:

*Actor half*
- duplicate live Manager tokens are normalized deterministically: retain newest by `(created_at DESC, id DESC)`, revoke older live tokens and their live sessions, then prove the partial unique index rejects another live Manager token for the same event;
- the retained-token tie-break uses `id DESC` when `created_at` is identical;
- the partial unique index rejects a second **live** actor row for the same `(event_id, manager_upload_account_id)` and accepts one after the first is revoked;
- an insert or update setting `manager_upload_account_id` non-null with `role = 'guest'` fails;
- the same with `can_claim_owner = 1` fails;
- a null `manager_upload_account_id` row is unaffected by both triggers;
- the foreign key to `host_accounts(id)` is enforced.
- deleting an `event_hosts` membership revokes that account's live Manager upload actor in the same database mutation; delete then re-add leaves the old actor revoked and permits one fresh actor identity.

*Album era and rotation-revision half*
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
- `manager_link_revision` is `0` for fresh and upgraded events, is non-negative, and is not exposed as a token ID.

Use identical timestamps across fixture rows so no assertion can pass by clock ordering.

*Populated-0020 and migration-first compatibility half*
- build the fixture by applying `0001`–`0020`, then insert guest media, favorites, saved and unsaved Albums, trashed rows, export jobs, and duplicate live Manager tokens with distinct and identical creation instants before applying 0021;
- after 0021, assert the provenance backfill, deterministic token/session revocation, unchanged unrelated rows, and both new event revisions at `0`;
- issue the old 0020 Worker's exact live-Manager-token insert after the schema upgrade and assert the new partial unique index rejects it.

Put these rows under the exact describe name `populated 0020 compatibility`, with test names containing `duplicate live Manager tokens` and `old 0020 Worker` respectively. They are part of the initial failing suite and must fail before the migration is written; do not append them after a first GREEN.

- [ ] **Step 2: Run the new suite and verify RED**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/migration-0021.test.ts
```

Expected: FAIL because `migrations/0021_manager_upload_and_album_era.sql` does not exist.

- [ ] **Step 3: Write the migration**

Write the four `ALTER TABLE` statements above, then:

- normalize live Manager tokens with a ranked update retaining `(created_at DESC, id DESC)`, revoke the older tokens and their live `event_sessions`, then create `CREATE UNIQUE INDEX event_access_tokens_one_live_manager ON event_access_tokens(event_id) WHERE role = 'manager' AND revoked_at IS NULL;`;
- `CREATE UNIQUE INDEX event_sessions_manager_upload_actor ON event_sessions (event_id, manager_upload_account_id) WHERE manager_upload_account_id IS NOT NULL AND revoked_at IS NULL;`
- `BEFORE INSERT` and `BEFORE UPDATE` triggers on `event_sessions` that `RAISE(ABORT, ...)` when `NEW.manager_upload_account_id IS NOT NULL AND (NEW.role <> 'manager' OR NEW.can_claim_owner <> 0)`;
- an `AFTER DELETE ON event_hosts` trigger that revokes the matching live account actor, so every direct or future membership-deletion path has the same invariant;
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

The carve-outs are transition-shaped, not column-shaped: each requires the *old* value to prove the row is mid-normalization, so a direct version-only write — where `favorited_at` does not move — still aborts. The normalizers' own writes re-enter the guard with a consistent pair and pass it on the ordinary branch, so no recursion fence is needed. Do not widen either carve-out to a bare `NEW`-only condition; that would let an arbitrary inconsistent write through. Keep the predecessor-shaped pick/unpick cases as named rows in `tests/worker/migration-0021.test.ts`, so Step 4's exact focused command proves the trigger ordering and committed end state.

- [ ] **Step 4: Verify GREEN**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/migration-0021.test.ts
```

Expected: PASS.

- [ ] **Step 5: Re-run the migration-first compatibility focus**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/migration-0021.test.ts -t '(populated 0020|old 0020 Worker|duplicate live Manager tokens)'
```

Expected: PASS. This is closing evidence for the compatibility rows that were already RED in Step 2, not the point where those tests are first written.

- [ ] **Step 6: Extend fresh-D1 verification**

First update only `tests/unit/verify-fresh-d1.test.ts` with the new expected final migration and post-`0021` schema fingerprint, then run:

```bash
npx vitest run --config vitest.config.ts tests/unit/verify-fresh-d1.test.ts
```

Expected: FAIL against the old verifier expectation. Then update `scripts/verify-fresh-d1.ts` minimally and rerun the same command.

Expected GREEN: exit zero. Do not run the repository-wide migration gate.

- [ ] **Step 7: Task review checkpoint**

Record the focused RED/GREEN outputs and migration compatibility fixture in the task evidence directory. Hand the uncommitted diff to a fresh implementer and an independent reviewer; resolve every P1/P2 before Task 2. Do not stage or commit.

---

### Task 2: Actor-aware session storage that cannot authorize

**Files:**
- Create: `worker/services/upload-authority.ts`
- Modify: `worker/db/types.ts`
- Modify: `worker/db/sessions.ts`
- Modify: `worker/auth/service.ts`
- Modify: `tests/worker/auth-api.test.ts`

**Interfaces:**
- Produces the neutral authority contract before `ManagerUploadActorService` or `UploadService` consumes it:

```ts
export type UploadAuthority =
  | { kind: 'guest'; actorSessionId: string; eventSessionId: string }
  | { kind: 'manager-link'; actorSessionId: string; eventSessionId: string }
  | {
      kind: 'manager-account';
      actorSessionId: string;
      hostSessionId: string;
      accountId: string;
    };
```

The module contains the type only and imports neither actor nor upload service. It also produces:

```ts
export interface SessionRecord {
  // …existing fields
  /** Non-null only for a server-only Manager upload actor. Never authorizes a request. */
  managerUploadAccountId: string | null;
}
```

- [ ] **Step 1: Write the failing rejection test**

In `tests/worker/auth-api.test.ts`, insert an actor row directly, then attempt to resolve an event session cookie built from a secret whose digest was *deliberately made to match* that row. Assert the resolve fails with the ordinary session refusal and that the failure occurs without a secret comparison — assert it by making the row's `secret_digest` equal the tested digest, so only an explicit actor rejection can produce a refusal.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/auth-api.test.ts -t 'upload actor'
```

Expected: FAIL — the actor row currently resolves as an ordinary manager session.

- [ ] **Step 3: Define the neutral authority type, then implement the field and rejection**

Create `worker/services/upload-authority.ts` with the exact union above before importing it anywhere. Add `manager_upload_account_id` to every `event_sessions` column list and to `mapSession`. In `AuthService.resolve`/`resolveEventSession`, reject a row whose `managerUploadAccountId !== null` **before** the digest comparison. Do not add an actor-creation repository API in this task; Task 3 introduces it together with the atomic authorization statement it requires.

- [ ] **Step 4: Verify GREEN and prove no secret leaves the service**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/auth-api.test.ts
```

Expected: PASS. The neutral type exists before either service consumes it, and browser resolution refuses a matching actor digest.

- [ ] **Step 5: Task review checkpoint**

Record the focused evidence, then obtain fresh-implementer and independent review of the neutral type boundary, browser-resolution refusal, and secret non-disclosure. Resolve P1/P2; do not stage or commit.

---

### Task 3: `ManagerUploadActorService`

**Files:**
- Create: `worker/services/manager-upload-actor.ts`
- Create: `tests/worker/manager-upload-actor.test.ts`
- Modify: `worker/db/sessions.ts`
- Modify: `tests/worker/repositories.test.ts`

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

Consumes `UploadAuthority` from `worker/services/upload-authority.ts`; this task does not redeclare it.

It introduces the repository boundary only together with the guarded statement:

```ts
export interface CreateManagerUploadActorRecord {
  id: string;
  secretDigest: string;
  csrfDigest: string;
  hostSessionId: string;
  accountId: string;
  eventId: string;
  createdAt: string;
  nowIso: string;
}

export interface ManagerUploadActorRecord {
  id: string;
  eventId: string;
  accessTokenId: string;
  accountId: string;
  expiresAt: string;
}

SessionsRepository.createManagerUploadActor(
  input: CreateManagerUploadActorRecord,
): Promise<ManagerUploadActorRecord | null>;

SessionsRepository.getLiveManagerUploadActor(
  eventId: string,
  accountId: string,
  nowIso: string,
): Promise<ManagerUploadActorRecord | null>;

SessionsRepository.revokeManagerUploadActors(
  eventId: string,
  accountId: string | null,
  revokedAt: string,
): Promise<number>;
```

`createManagerUploadActor` returns `null` when any atomic proof fails. `getLiveManagerUploadActor` refuses revoked/expired actors and actors not bound to the event's current live Manager token. The narrow actor record intentionally excludes both plaintext and digest credential fields. The service creates random actor secret/CSRF source values, passes only their digests, and lets the plaintext go out of scope; neither repository nor service result exposes a credential-bearing field.

**Atomic-authorization and rotation-race ruling.** "Carries the event's current Manager access-token FK" cannot be satisfied by reading the token and then inserting. Nor may actor creation rely on a separate earlier `requireManager`: the host session can be revoked, its auth version bumped, the account disabled, membership removed, the event deleted/expired, or the token rotated before the insert. The insert is the authorization proof and identity creation together.

The insert is one statement, no read-then-write. It joins the exact `host_sessions.id = auth.sessionId`, `host_sessions.account_id = auth.accountId`, current `host_accounts.auth_version`, active account, current owner/cohost `event_hosts` row, live event management window, and the unique live Manager token:

```sql
INSERT INTO event_sessions (
  id, secret_digest, csrf_digest, event_id, access_token_id, role,
  can_claim_owner, manager_upload_account_id, expires_at, created_at
)
SELECT ?, ?, ?, e.id, t.id, 'manager', 0, a.id,
       e.management_access_expires_at, ?
  FROM host_sessions AS hs
  JOIN host_accounts AS a ON a.id = hs.account_id
  JOIN event_hosts AS eh ON eh.account_id = a.id
  JOIN events AS e ON e.id = eh.event_id
  JOIN event_access_tokens AS t ON t.event_id = e.id AND t.role = 'manager'
 WHERE hs.id = ? AND hs.account_id = ?
   AND hs.revoked_at IS NULL AND hs.expires_at > ?
   AND hs.auth_version = a.auth_version AND a.disabled_at IS NULL
   AND eh.event_id = ? AND eh.role IN ('owner', 'cohost')
   AND e.deleted_at IS NULL AND e.management_access_expires_at > ?
   AND t.revoked_at IS NULL AND t.expires_at > ?;
```

Zero rows inserted means one of the exact proofs failed. Re-resolve through the existing authorization/lifecycle classifier; do not guess "rotation" from zero changes. If authorization remains live, re-read the actor and retry only the bounded unique-index/token race. If the proof remains false, raise the existing session/account/role/lifecycle refusal and insert nothing. The `SELECT` and uniqueness checks are evaluated in the same statement, so the loser of a genuine two-caller race reuses the winner.

- [ ] **Step 1: Write the failing service suite**

Cover:
- a `via: 'link'` Manager resolves to `{ kind: 'manager-link', actorSessionId: <that event session id> }` and creates no row;
- an account owner and an account cohost each resolve to `{ kind: 'manager-account', … }`, creating exactly one row the first time and reusing it the second;
- two concurrent `ensureForReservation` calls for the same `(eventId, accountId)` produce exactly one live row — assert with a `DB.batch`-level race or by asserting the unique index converts the loser into a re-read rather than an error;
- `lookupForExistingUpload` returns null when no live actor exists and never inserts;
- a revoked actor is not reused; a new `ensureForReservation` creates a fresh identity;
- the created actor carries the event's **current** Manager access-token FK and the event's `managementAccessExpiresAt`;
- **ensure versus rotation.** Drive the interleaving explicitly: read the active token, run `LinkService.rotateManagementLink` to completion, then let the insert proceed. Assert that no live actor is bound to the revoked predecessor, that the actor the service finally returns is bound to the **replacement** token, and that a reservation made through it then commits. This is the row a read-then-write implementation fails, and it must exist before the service does;
- the mirror case: rotation lands with no live actor at all, and a first `ensureForReservation` afterwards binds to the replacement on its first attempt;
- with **no** active Manager token — the window closed — `ensureForReservation` inserts nothing and raises the existing lifecycle refusal.
- revoke the host session, bump account `auth_version`, disable the account, remove membership, delete the event, or expire the event after `requireManager` but before the insert; each case inserts nothing and returns its existing refusal;
- delete membership after an actor and reservation exist: the migration trigger revokes the actor, every later phase refuses the old authority, and remove-then-readd creates a fresh actor ID whose new reservation cannot resume the old row.
- repository results contain no secret-bearing field, and `getLiveManagerUploadActor` excludes revoked and expired rows.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/manager-upload-actor.test.ts tests/worker/repositories.test.ts
```

Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement the service**

Pass the exact `ManagerAuth.sessionId`, `accountId`, and event ID into the guarded `INSERT … SELECT` above. `requireManager` supplies candidate inputs, not a durable authorization fact; the statement proves every fact again. Generate the random actor credentials in the service, pass only their digests to the repository, and return only `UploadAuthority`. On unique-index conflict, re-read and return the winner only if it is still live under the same proofs. On zero rows, re-resolve the existing refusal and retry only when authorization is still live and the current-token race is the sole missing fact.

- [ ] **Step 4: Verify GREEN**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/manager-upload-actor.test.ts tests/worker/repositories.test.ts
```

- [ ] **Step 5: Task review checkpoint**

Record the atomic authorization and removal-race evidence. A fresh implementer and independent reviewer must confirm the statement re-proves every named fact before Task 4. Resolve P1/P2; do not stage or commit.

---

### Task 4: One pipeline, two authorities

**Files:**
- Modify: `shared/errors.ts`
- Create: `worker/http/upload-schemas.ts`
- Modify: `worker/services/uploads.ts`
- Modify: `worker/db/media.ts`
- Modify: `worker/storage/media.ts`
- Modify: `worker/routes/uploads.ts`
- Modify: `tests/worker/upload-api.test.ts`
- Modify: `tests/worker/photo-intake-api.test.ts`
- Modify: `tests/worker/repositories.test.ts`

**Interfaces:**
- Consumes `UploadAuthority` from `worker/services/upload-authority.ts`; no upload or actor module redeclares the union.

- Produces strict reusable schemas in `worker/http/upload-schemas.ts`:

```ts
export const uploadFileSchema = z.object({
  filename: z.string().min(1).max(255),
  mimeType: z.string().max(100),
  byteSize: z.number(),
  idempotencyKey: z.string().min(1).max(128),
  caption: z.string().max(300).nullish(),
}).strict();

export const guestUploadBatchSchema = z.object({
  guestName: z.string().trim().min(1).max(80),
  files: z.array(uploadFileSchema).min(1).max(UPLOAD_BATCH_SIZE),
}).strict();

export const managerUploadBatchSchema = z.object({
  files: z.array(uploadFileSchema).min(1).max(UPLOAD_BATCH_SIZE),
}).strict();
```

`worker/routes/uploads.ts` imports the guest schema; Task 5 imports the Manager schema. Both outer objects and the nested file object reject unknown keys.

`UploadService.initiate`/`initiateBatch` accept `(authority, event, input, now)` instead of `AuthenticatedSession`. `prepareReservation` takes the attribution separately, so no account field can become display copy.

- The authority also selects the SQL intake predicate, which is what actually admits or refuses the write:

```ts
/** The event-state predicate this authority's writes must satisfy, in SQL. */
export function intakePredicateSql(authority: UploadAuthority): string;
// 'guest'                       → uploads_enabled = 1 AND COALESCE(photos_open_from, event_start_at) <= ?
// 'manager-link' | 'manager-account' → management_access_expires_at > ?
```

Both branches bind exactly one instant, so every existing call site keeps its parameter order. The guest string stays byte-identical to today's `PHOTO_INTAKE_OPEN_SQL`; a diff of the guest SQL is a defect, not a refactor.

- The authority also supplies the liveness fact required by the Authority-liveness ruling, as one string and one binding list so no phase can spell it differently:

```ts
/** The `EXISTS (…)` fragment proving this authority is still authorized, in SQL. */
export function authorityLivenessSql(authority: UploadAuthority): string;
/** Its bindings, in the order the fragment consumes them. */
export function authorityLivenessBindings(authority: UploadAuthority, nowIso: string): unknown[];
```

  Both live in `worker/db/media.ts` beside `intakePredicateSql`, take `UploadAuthority` through an `import type`, and are `AND`-ed into the same eight upload-path sites the intake predicate reaches. The two are independent: a live authority on a closed event is refused, and a rotated credential on an open event is refused. Because the fragment's binding count varies by kind, every one of the eight statements builds its parameter list by concatenation rather than by a fixed positional array — a hand-counted `?` index is the defect this pair exists to prevent.

- Reserve and idempotent refresh carry it too, which is what closes the route-authorization → reserve window. `ReserveMediaRecord` already carries the authority for the intake predicate; the same value drives liveness, so no further parameter is added to `reserve`, `reserveBatch`, `refreshIdempotent`, or `idempotentRefreshConflict`.

- The claim and the commit stop answering in `null`/`false`, because those collapse "you are no longer allowed" into "the row moved":

```ts
export type UploadIngressOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'forbidden' | 'conflict' };

claimReservationIngress(input): Promise<UploadIngressOutcome<ClaimedMediaIngress>>;
commitReservationIngress(input): Promise<UploadIngressOutcome<null>>;
```

  A zero-row `UPDATE` cannot say by itself which condition failed, so on the failure path — and only there — each method runs the liveness fragment alone as a standalone `SELECT` and reports `forbidden` when it does not hold, `conflict` otherwise. **Liveness has precedence:** when management expiry makes both the actor/token/session liveness fragment and the intake predicate false at the same instant, the answer is `forbidden` and the client treats it as authorization-terminal. `conflict` is reserved for a still-live authority whose row or intake state moved. That read never re-admits the write: the statement has already failed closed, and the probe only chooses which refusal to raise. Do not invert it into a pre-check that gates the write.

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

It forwards the authority to `claimReservationIngress` and `commitReservationIngress`, which keep matching `m.uploader_session_id = authority.actorSessionId` and now also interpolate that authority's intake predicate and liveness fragment.

  Its two refusal sites change with the tagged outcomes. A `reason: 'forbidden'` from either phase raises the generic `RESOURCE_FORBIDDEN` 403 that every cross-actor probe already answers with — never `UPLOAD_FINALIZE_CONFLICT`. At `153d05f` both sites answer 409: a revoked credential is currently reported to the browser as "This upload is already being secured. Wait a moment and try again," which invites the retry that can never succeed and is indistinguishable from a live race. A `reason: 'conflict'` keeps today's exact 409 code and message at both sites, so the existing conflict assertions stand unedited. The already-stored idempotent short-circuits — the `getById` re-reads that return a committed row before raising — run **before** the outcome is classified in both places, so a delivered upload whose credential died afterwards still answers 200.

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

In the same RED/GREEN cycle, move the route-local guest schemas into `worker/http/upload-schemas.ts`, make both levels strict, and update `worker/routes/uploads.ts`. Add guest API cases for an unknown outer key and unknown nested file key so strictness is proved before the Manager route consumes the schema. Update every direct service/repository/storage call to pass an explicit authority, including all direct tests; do not preserve a bare-session overload.

`intakePredicateSql` lives in `worker/db/media.ts` beside `PHOTO_INTAKE_OPEN_SQL`, which stays the guest branch's value, and takes `UploadAuthority` through an `import type` so no value-level cycle forms with `worker/services/uploads.ts`. Delete no site and add none: after this step every one of the eight interpolations reads `intakePredicateSql(...)`, and the constant is referenced only by its own definition and that function.

In the same pass, `AND` `authorityLivenessSql(authority)` into those same eight statements and append `authorityLivenessBindings(authority, nowIso)` to each one's parameter list. Reserve and refresh are not optional here: without them the route-authorization → reserve window stays open, and Step 4's revocation table can only ever prove the second half of the promise. Because the fragment's binding count differs by kind, build each statement's bindings by concatenating the fixed prefix, the intake instant, and the liveness list — never by editing a positional array by hand.

- [ ] **Step 3b: Close the route-authorization → reserve window**

The Manager routes do not exist until Task 5, so this is proved at the service and repository seam, in `tests/worker/repositories.test.ts` and `tests/worker/photo-intake-api.test.ts`: for each of the three kinds, construct the authority, revoke that credential, and only then call `UploadService.initiate`/`initiateBatch` with it. Assert the reservation is refused with the generic `RESOURCE_FORBIDDEN` 403, that no `media` row exists, and that no event counter moved. Drive the interleaving from that seam rather than from wall-clock timing — a test that only sometimes lands in the window proves nothing on the run where it does not.

Cover the same window on idempotent refresh: a replay whose credential died between the route and the refresh is refused rather than re-entering the row.

- [ ] **Step 4: Carry authority into the claim and the commit, and tag their refusals**

`receiveMediaUpload` takes the authority and forwards it. `claimReservationIngress` and `commitReservationIngress` re-prove, in the same statement that admits the write, that the authority which reserved the row is *still* the authority now committing it, by interpolating the same `authorityLivenessSql`/`authorityLivenessBindings` pair Step 3 wired into reserve and refresh. Matching `uploader_session_id` alone is not sufficient for any kind and is actively misleading for the account kind: the actor row deliberately outlives the browser credential that created it, so the session match says nothing at all about whether that account is still authorized.

Then change what a failure *says*. Both methods return the tagged `UploadIngressOutcome` from this task's Interfaces instead of `null`/`false`, classifying a zero-row result by running the liveness fragment alone. `receiveMediaUpload` raises the generic `RESOURCE_FORBIDDEN` 403 for `forbidden` and keeps today's exact `UPLOAD_FINALIZE_CONFLICT` 409 code and message for `conflict`, at both its claim site and its commit site. The classifier evaluates liveness first and never lets a simultaneous intake failure downgrade a dead actor to `conflict`. Without this the whole revocation table below is unfalsifiable from the browser's side: every row would pass while the response still told the host to wait a moment and try again.

Cover, in `tests/worker/repositories.test.ts` and `tests/worker/upload-api.test.ts`:
- an idempotent replay under a *different* actor for the same `(event, idempotencyKey)` does not re-enter the other actor's row;
- **revocation during buffer, per authority kind.** Reserve, then revoke between the reserve and the content PUT, then send the bytes. Each of these loses the claim, leaves the media row `reserved`, leaves the promotion row unmoved, and returns the generic `RESOURCE_FORBIDDEN` 403 — asserted as that exact code, not merely as "not 200": an account disabled; a membership removed; the account's `auth_version` bumped by a password reset while its `host_sessions` row is still unexpired; that `host_sessions` row revoked; that `host_sessions` row expired; a management link rotated; the Manager's own event session revoked; and a guest event session signed out;
- the account actor itself revoked or expired while the host session/account/membership remain live, and the actor still live but bound to a revoked/non-current Manager token; both lose claim and commit with `RESOURCE_FORBIDDEN` and cannot resume the old reservation;
- every one of those revocations applied instead between a successful claim and the commit likewise loses the commit with the same 403, so no `stored` row and no counter delta appears;
- a Manager upload whose event's `managementAccessExpiresAt` passes mid-buffer makes both intake and actor/token/session liveness false; liveness wins, so claim and commit return the generic `RESOURCE_FORBIDDEN` 403. Assert that exact code and record it as authorization-terminal evidence for the dialog's local table, never as retryable `UPLOAD_FINALIZE_CONFLICT`;
- the guest equivalent — a pause landing mid-buffer — still refuses the guest with today's `UPLOAD_FINALIZE_CONFLICT` code and message, asserted character for character;
- a claim or commit that fails because the row genuinely moved — a competing finalize, an expired reservation — still reports `conflict` with today's wire answer, so the new 403 branch cannot swallow the existing conflict assertions;
- an upload whose bytes committed successfully and whose credential is revoked immediately afterwards still answers 200 from the already-stored short-circuit, because a delivered photo is not retroactively unauthorized;
- a Manager reserve replayed after that same reservation was canceled returns `UPLOAD_RESERVATION_CANCELED` 409, creates no row, and leaves the canceled row terminal;
- the identical guest replay still returns `UPLOAD_FINALIZE_CONFLICT` with its existing message — assert the exact code and string, so the authority-scoped branch cannot drift into the guest path.

- [ ] **Step 5: Verify GREEN**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/upload-api.test.ts tests/worker/photo-intake-api.test.ts tests/worker/repositories.test.ts
```

- [ ] **Step 6: Task review checkpoint**

Record the focused authority, schema, guest-call-site, and ingress-race evidence. Hand the uncommitted diff to a fresh implementer and independent reviewer; resolve P1/P2 before routes consume it. Do not stage or commit.

---

### Task 5: The four Manager upload routes

**Files:**
- Modify: `worker/routes/manage.ts`
- Modify: `worker/db/media.ts` *(the actor-scoped cancel transition)*
- Modify: `tests/worker/repositories.test.ts`
- Create: `tests/worker/manager-upload-api.test.ts`

**Interfaces:**
- Produces four routes, each calling `requireManager(context, { write: true })` **before** reading or buffering a body:

```
POST   /api/manage/events/:eventId/uploads/batch
PUT    /api/manage/events/:eventId/uploads/:mediaId/content
POST   /api/manage/events/:eventId/uploads/:mediaId/finalize
DELETE /api/manage/events/:eventId/uploads/:mediaId
```

Batch body: `managerUploadBatchSchema` from Task 4, with no `guestName`. Reservation URLs point only at the Manager content path.

The batch route imports `managerUploadBatchSchema` from Task 4. Unknown outer keys and unknown nested file keys—including actor, account, event, upload URL, and object-key attempts—are `VALIDATION_FAILED`; no route-local permissive schema remains. Mount `privateJson` with `.use(...)` for all four Manager paths before registering any handler. Every success and error assertion checks `Cache-Control: private, no-store` and `Vary: Cookie`.

- Also produces the actor-scoped cancel transition the cancel-CAS ruling requires:

```ts
export type UploadCancelOutcome =
  | { kind: 'canceled'; claim: MediaObjectDeletionClaim }
  | { kind: 'already-canceled' }
  | { kind: 'forbidden' }
  | { kind: 'conflict' };

cancelReservation(
  mediaId: string,
  authority: UploadAuthority,
  canceledAt: string,
): Promise<UploadCancelOutcome>;
```

  It is a sibling of `MediaRepository.delete`, not a wrapper around it, and `delete` is not modified.

- [ ] **Step 1: Write the failing authorization matrix**

In `tests/worker/manager-upload-api.test.ts`, table-drive every row from the slice spec's matrix: account owner, account cohost, current management link, both cookies present (account takes precedence), missing CSRF, invalid CSRF, wrong-scope CSRF header, cross-event path, a guest's reservation, another account's actor reservation, a rotated old link's reservation, expired link, expired event, deleted event, disabled account, and removed membership. Assert the generic `RESOURCE_FORBIDDEN` 403 body for every cross-actor probe, and assert that a probe never creates an actor row.

Add response-shape assertions: no `uploaderSessionId`, `objectKey`, `objectBucketGeneration`, `accessTokenId`, `accountId`, or `reservationExpiresAt`-adjacent internals in any Manager upload response; `guestName` is exactly `'Host'`.

- [ ] **Step 1b: Write the failing cancel-race table**

In `tests/worker/repositories.test.ts` and `tests/worker/manager-upload-api.test.ts`, prove the cancel-CAS ruling rather than assuming it:
- **finalization lands between the route's read and the DELETE.** Reserve, let the route observe `reserved`, complete the content PUT so the row commits to `stored`, and only then run the cancel. Assert the response is the existing conflict, that the row is still `stored` with `deleted_at IS NULL`, that its object key is still present in R2, and that the event's stored counters are unchanged. Drive the interleaving from the repository seam, not from timing;
- a `stored` row that the host had already moved to Recently deleted is likewise refused, and its `trashed_at`/`restore_until` pair is untouched — a cancel may not shortcut the recoverable window;
- cancel of a genuinely `reserved` row and of a genuinely `failed` row each succeed exactly once, release the reserved counters by exactly that row's declared bytes, and are idempotent on replay;
- another actor's reserved row — a guest's, another account's, a rotated link's, another event's — is refused with `RESOURCE_FORBIDDEN` 403 and stays reserved;
- a cancel whose own credential died between route authorization and the statement is refused with the same 403 and leaves the row reserved.
- a lost cancel response followed by the same actor replay returns `already-canceled`; a lost CAS may run one classification-only read, but cancel is never retried against the winner;
- the legacy `POST /manage/events/:eventId/media/:mediaId/cancel-reservation` succeeds only for a **guest-owned** `reserved`/`failed` row, returns `RESOURCE_FORBIDDEN` for a Manager-owned row, and returns conflict without changing a finalize winner.

Assert on the persisted row in every case. A test that only reads the HTTP status cannot tell a refusal from a deletion that also happened to return 409.

- [ ] **Step 2: Write the failing ingress-ordering test**

Assert that a `PUT .../content` with a bad Origin or missing CSRF is refused **without** the body being read: send an oversize body and assert the refusal arrives with the existing 403 and that no promotion row moved.

- [ ] **Step 3: Run and verify RED**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/manager-upload-api.test.ts
```

Expected: FAIL — the routes do not exist.

- [ ] **Step 4: Implement the routes**

Mirror `worker/routes/uploads.ts` exactly, substituting `requireManager({ write: true })` plus `ManagerUploadActorService` for `guestForSlug`, and matching media on `uploaderSessionId === authority.actorSessionId`. The routes call the one `receiveMediaUpload` and the one `retireMediaObjects` — the same implementations the guest routes call, now passing the authority Task 4 threaded through them rather than a bare session id.

`DELETE` does **not** call `MediaRepository.delete`. Per the cancel-CAS ruling it gets its own transition, `MediaRepository.cancelReservation(mediaId, authority, canceledAt)`, whose single guarded statement carries the whole restriction in its `WHERE` — the media ID, the event, `uploader_session_id = authority.actorSessionId`, `upload_state IN ('reserved', 'failed')`, `deleted_at IS NULL`, `trashed_at IS NULL`, and the authority's liveness fragment — with the reserved-counter release and object-key inventory chained off that winner. It returns the four-way `UploadCancelOutcome`. On a zero-row CAS, one classification-only read may distinguish already canceled, foreign/dead authority, and moved-state conflict; it may not issue a second delete.

Preserve the legacy host cleanup route at its existing path. Replace its read-then-`MediaRepository.delete` flow with `cancelGuestReservationFromManager(mediaId, eventId, canceledAt)`, another one-shot CAS whose `WHERE` requires a guest-owned uploader session (`role = 'guest'`, no Manager actor), `reserved`/`failed`, same event, live row, and no trash. It is not self-cancel—this is the host cleanup tool—but it can never match a Manager-owned row or a finalize winner. Its lost-CAS classification is read-only.

The content route resolves its authority with `lookupForExistingUpload` **before** buffering and passes that same object to `receiveMediaUpload`; it must not re-resolve, re-`ensure`, or downgrade to `media.uploaderSessionId` after the bytes arrive. Re-resolving after the buffer would re-admit exactly the mid-buffer revocation Task 4 exists to refuse.

- [ ] **Step 5: Verify GREEN and re-run the guest suite**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/manager-upload-api.test.ts tests/worker/repositories.test.ts tests/worker/upload-api.test.ts tests/worker/manage-api.test.ts
```

Expected: PASS with no guest-route behavior change, and `MediaRepository.delete` unchanged — assert that by diff, since the cancel path must not have been implemented by loosening it.

- [ ] **Step 6: Task review checkpoint**

Record the route matrix, strict-schema, header, and one-shot cancel evidence. A fresh implementer and independent reviewer must confirm both cancel endpoints refuse Manager/finalize winners as applicable. Resolve P1/P2; do not stage or commit.

---

### Task 6: Atomic management-link rotation

**Files:**
- Modify: `shared/contracts.ts`
- Modify: `worker/services/links.ts`
- Modify: `worker/db/tokens.ts`
- Modify: `worker/db/sessions.ts`
- Modify: `worker/db/media.ts`
- Modify: `worker/http/event-view.ts`
- Modify: `worker/routes/manage.ts`
- Modify: `tests/worker/manage-api.test.ts`
- Modify: `tests/worker/manager-upload-api.test.ts`
- Modify: `tests/worker/event-theme-api.test.ts`
- Modify: `tests/e2e/event-cover-studio.spec.ts`
- Modify: `tests/e2e/fixtures/routes.ts`
- Modify: `tests/ui/event-settings-editor.test.tsx`
- Modify: `tests/unit/event-settings-draft.test.ts`
- Modify: `tests/unit/manager-event-merge.test.ts`
- Modify: `tests/ui/manager-guestbook.test.tsx`
- Modify: `tests/ui/manager-recovery.test.tsx`
- Modify: `tests/ui/host-private-gallery.test.tsx`
- Modify: `tests/ui/manager-rsvp-panel.test.tsx`
- Modify: `tests/ui/event-appearance-editor.test.tsx`
- Modify: `tests/ui/manager-photo-intake.test.tsx`
- Modify: `tests/ui/album-workspace.test.tsx`

**Interfaces:**
- `EventView` gains `managerLinkRevision: number | null`: account-authorized Manager projections carry the non-negative revision; link-only projections carry `null`; no response exposes token IDs. Update `EVENT_VIEW_KEYS`, `tests/e2e/fixtures/routes.ts`, and every direct typed `EventView` fixture explicitly listed in this task. Confirm the current inventory with `rg -l ": EventView =|satisfies EventView" tests src`; any new match is added explicitly before implementation.
- The rotation route accepts only `z.object({ expectedManagerLinkRevision: z.number().int().nonnegative() }).strict()` and calls:

```ts
LinkService.rotateManagementLink(
  event: EventRecord,
  expectedManagerLinkRevision: number,
  now?: Date,
): Promise<{ managementLink: string; managerLinkRevision: number }>;
```

- One `DB.batch([...])` compare-and-sets/increments the event revision, revokes the exact predecessor token, creates the unique replacement, revokes every session derived from the predecessor, rebinds live **account** upload actors, terminally cancels predecessor **link** actors' `reserved`/`failed` media with exact counter deltas, and inventories those rows' object keys for typed deletion.
- Deletion claims run **after** commit through the existing tombstone cleanup. A failed R2 delete stays janitor-owned and never rolls credentials back.

- [ ] **Step 1: Write the failing rotation tests**

- account-authorized projection carries revision `0`, link-only carries `null`, exact-key coverage includes the new key, and no response contains a token ID;
- **two concurrent rotations with the same expected revision produce exactly one success.** Both callers observe revision `0`; exactly one returns revision `1` and a resolving link, the other conflicts without creating or revoking a token, and exactly one live Manager token remains;
- delayed request A observed revision `0`; request B succeeds to revision `1`; A arrives afterwards and conflicts without rotating B's replacement;
- an exact predecessor revoked by something else between revision CAS and revoke makes the batch fail closed: no replacement is inserted and no optional dependent changes;
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

Read the unique live predecessor token ID once, generate the replacement token ID/secret once, and construct the batch in this exact order:

```sql
-- 1. The client-observed revision is the single-winner fact.
UPDATE events
   SET manager_link_revision = manager_link_revision + 1
 WHERE id = ?event
   AND manager_link_revision = ?expected_revision
   AND deleted_at IS NULL
   AND management_access_expires_at > ?now;

-- 2. Revoke only the predecessor this caller observed, and only if CAS won.
UPDATE event_access_tokens
   SET revoked_at = ?now
 WHERE id = ?predecessor AND event_id = ?event
   AND role = 'manager' AND revoked_at IS NULL
   AND changes() = 1;

-- 3. Insert the unique replacement only if exact predecessor revoke won.
INSERT INTO event_access_tokens (...)
SELECT ...
 WHERE changes() = 1;
```

Check `results[0].meta.changes === 1`, `results[1].meta.changes === 1`, and `results[2].meta.changes === 1`; otherwise return the canonical rotation conflict and expose no secret. The first two `changes()` links are safe because each required predecessor changes exactly one row. They are not reused after statement 3.

Every optional dependent guards on the unique replacement token ID, the stable winner fact for the remainder of the batch:

```sql
... WHERE <its own condition>
  AND EXISTS (SELECT 1 FROM event_access_tokens
              WHERE id = ?replacement AND event_id = ?event
                AND role = 'manager' AND revoked_at IS NULL);
```

Do not guard optional session/actor/media statements with a timestamp or the immediately preceding `changes()`: any optional cohort may contain zero rows. Counter deltas stay in SQL and derive from the same replacement-guarded selection that cancels link-owned rows. The event projection returns `managerLinkRevision` only when `requireManager` resolved through the account; link-only gets `null`. The route parses the strict body before calling the service and returns the incremented revision with the link.

- [ ] **Step 4: Verify GREEN**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/manage-api.test.ts tests/worker/manager-upload-api.test.ts tests/worker/manager-upload-actor.test.ts tests/worker/auth-api.test.ts
npx vitest run --config vitest.config.ts tests/unit/event-settings-draft.test.ts tests/ui/event-settings-editor.test.tsx tests/ui/host-private-gallery.test.tsx tests/ui/manager-rsvp-panel.test.tsx tests/ui/event-appearance-editor.test.tsx
npx playwright test tests/e2e/event-cover-studio.spec.ts --project=desktop
```

The actor suite is re-run here deliberately: Task 3's ensure-versus-rotation row was written against the two-statement rotation, and this is where it is re-proved against the atomic one. The two additional commands are the bounded closing evidence for every direct typed fixture/spec named in this task; they are not a full UI or E2E gate.

- [ ] **Step 5: Task review checkpoint**

Record the delayed-request, zero-row optional cohort, and projection privacy evidence. A fresh implementer and independent reviewer must confirm the revision/revoke/insert ordering and replacement-ID guards. Resolve P1/P2; do not stage or commit.

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

In `docs/operations.md`, describe the server-only upload actor: what it is, that it cannot mint a cookie, that rotation rebinds account actors and cancels link-owned reservations, and how to read a stranded actor. Record that rotation compares and increments the client-observed Manager-link revision, revokes the exact predecessor only for the CAS winner, inserts the replacement only for that revoke winner, and guards optional work by replacement token ID. Document `UPLOAD_RESERVATION_CANCELED` beside the other `UPLOAD_*` codes, including that it is Manager-only and that the guest path still answers `UPLOAD_FINALIZE_CONFLICT`. Document the refusal split the tagged ingress outcomes produce — a lost credential at reserve, refresh, claim, commit, or cancel answers the generic `RESOURCE_FORBIDDEN` 403 and is not retryable, while a moved row keeps its existing `UPLOAD_*` 409 and is — because that distinction is what an operator reads to tell a revocation from a race. In `docs/deployment.md`, add `0021` to the migration-first ordering with the compatibility-target ruling from Global constraints. In `CLAUDE.md`, extend the upload-path and authorization sections with the two Manager authorities, the authority-selected intake predicate, and the `guest_name = 'Host'` rule.

- [ ] **Step 3: Run the complete checkpoint gates**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/migration-0021.test.ts tests/worker/manager-upload-actor.test.ts tests/worker/manager-upload-api.test.ts tests/worker/upload-api.test.ts tests/worker/photo-intake-api.test.ts tests/worker/manage-api.test.ts tests/worker/auth-api.test.ts tests/worker/repositories.test.ts
npx vitest run --config vitest.config.ts tests/unit/verify-fresh-d1.test.ts
npx vitest run --config vitest.config.ts tests/unit/event-settings-draft.test.ts tests/ui/event-settings-editor.test.tsx tests/ui/host-private-gallery.test.tsx tests/ui/manager-rsvp-panel.test.tsx tests/ui/event-appearance-editor.test.tsx
npx playwright test tests/e2e/event-cover-studio.spec.ts --project=desktop
git diff --name-only --diff-filter=ACMR -- '*.ts' '*.tsx' | xargs -r npx eslint --
git diff --check -- migrations/0021_manager_upload_and_album_era.sql shared/errors.ts shared/contracts.ts worker tests/worker tests/e2e/fixtures/routes.ts docs/superpowers/host-gallery-verification-matrix.md docs/operations.md docs/deployment.md CLAUDE.md
```

Expected: every focused command exits zero. Do not substitute a full test, build, lint, typecheck, E2E, or migration run.

- [ ] **Step 4: Checkpoint review handoff**

Record the changed documentation and focused outputs, run `git diff --check --` against the files listed in this task, and obtain independent checkpoint review. Keep the entire Slice diff uncommitted for the later plans.

Do not push. The next Slice 5 checkpoint is the Manager upload dialog and queue extensions.

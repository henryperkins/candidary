# Event Appearance Cover Studio — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce one reviewable phase-1 candidate that adds additive migration `0012_event_cover_storage.sql`, moves every new and replacement event cover onto the bounded normalization, durable-receipt, and `CoverRenderWorkflow` publication pipeline, keeps the current `coverObjectKey` projection and the two revision-less delivery URLs as the only client-facing cover contract, ships the responsive reader and Cover Studio as unwired modules, and stops deleting a displaced legacy original — without merging to `main`, pushing, applying a remote migration, deploying, running a backfill, or claiming deployed Images/Workflow or physical-device conformance.

**Architecture:** One additive migration adds three `events` columns and twelve cover-owned inventory tables. A new pure `shared/event-cover.ts` owns identifiers, strict schemas, registries, geometry, pipeline version axes, and the safe projections; the numbers stay in `shared/constants.ts`. Worker-side, a storage service owns R2 keys, draft/master/preview inventory, and the guarded event-pointer statements; a rendering service owns every Images recipe and the manifest verification; a publication service owns durable receipts, dispatch fences, and persisted rate events; and `CoverRenderWorkflow` orchestrates eight replay-safe steps. The presigned cover reserve/finalize pair is replaced by the specification's draft-and-publish surface; the two delivery routes keep their paths and gain a three-way compatibility reader. The Manager projection keeps `coverObjectKey` as a constant presence sentinel and gains two additive top-level fields: `coverPreparation`, driving a sheet-independent status component, and `coverRevision`, without which no first publication has a legal `expectedRevision` to send. Cover Studio, `ResponsiveEventCover`, the preset asset matrix, and `CoverBackfillWorkflow` ship complete but unreachable.

**Tech Stack:** TypeScript 6, React 19, Hono 4, Zod 4, Cloudflare Workers/Wrangler 4, D1/SQLite, R2, the Images binding, Cloudflare Workflows, Vite 8 with `@cloudflare/vite-plugin`, Vitest (jsdom + `vitest-pool-workers`/workerd), Playwright, and Node.js 24 native type stripping for scripts.

---

## Global Constraints

- Implement only phase 1 of `docs/superpowers/specs/2026-08-03-event-appearance-cover-studio-design.md` §9.5. Phase 2 (backfill execution) and phase 3 (`0013`, the new projections, the responsive routes, Cover Studio activation) are separate candidates.
- **`migrations/` must contain exactly twelve files at candidate time.** `vitest.worker.config.ts` discovers the directory with `readD1Migrations()` and `verify:fresh-d1` applies the whole directory, so a checked-in `0013_event_cover_invariants.sql` would take effect immediately in every Worker test and in every fresh database. Do not author it in this branch.
- Do not merge this branch into `main`, push any ref, apply `0012` to remote D1, deploy the Worker or the preset static assets, create/restart/terminate a remote Workflow instance, mutate production R2, launch the backfill, or claim deployed Images/Workflow conformance or physical iPhone/Android/VoiceOver/TalkBack support.
- Preserve the main checkout and its user-owned untracked files unchanged: `CandidaryDesignSystem.zip`, `candidaryhomepageredesign.patch`, `docs/superpowers/plans/2026-08-01-settings-autosave.md`, `docs/superpowers/plans/2026-08-02-release-convergence-and-evidence.md`, and this plan file. Work in an isolated worktree.
- Write a failing focused test before each new behavior. Documentation, generated assets, and baseline recapture are evidence tasks and are exempt from manufacturing a RED test.
- Every new limit is a **decimal** literal written with underscore separators. Never reuse `MAX_IMAGE_BYTES` (binary `20 * 1024 * 1024` = 20,971,520) for a cover; it exceeds the Images binding's 20 MB `.input()` ceiling, which is the entire reason `MAX_COVER_UPLOAD_BYTES` is `19_000_000`.
- `COVER_UPLOAD_MIME_TYPES` is an independent literal tuple, never a filter or subset over `SUPPORTED_IMAGE_TYPES`, or a future guest-media format addition silently widens cover intake.
- Object keys, R2 pointers, recipes, checksums, Workflow instance IDs, and raw platform status names never appear in a Manager or guest response body, a client module, or a fixture standing in for a response.
- Route handlers authorize and translate HTTP only. They do not build object keys, transformation recipes, manifests, or cleanup rules inline.
- Every Workflow side effect runs inside a deterministically named `step.do`. Do not copy `ExportWorkflow`'s single-giant-step shape (`worker/index.ts:13`).
- `worker/env.ts` is never edited. It is `export type AppEnv = Cloudflare.Env;` with an in-file comment forbidding redeclaration; the generated `worker-configuration.d.ts` is the only place a binding type appears.
- Commit each independently testable task. Run `npm run typecheck`, `npm run lint`, and the task's focused tests before every commit.

### Interpretation decisions

The specification is ambiguous in three places that change what phase 1 builds. These readings are recorded so review can reject them cheaply rather than discovering them in a diff.

1. **Phase 1 registers the full §11 mutation surface and retires the presigned cover routes.** §9.5 phase-1 item 3 requires new and replacement uploads to use the bounded normalization and `CoverRenderWorkflow` path, and says the existing Manager/create controls "gain the shared inspection/composition worker". A composition `PATCH` presupposes a draft, and §10.1 forbids an unconstrained presigned R2 PUT for cover raw bytes. `POST /api/manage/events/:eventId/cover`, `POST .../cover/finalize`, and `DELETE .../cover` are therefore removed and replaced by the draft/publication/restart routes. What §9.5 preserves is the *projection* and the *delivery URL shape*, not the mutation verbs.
2. **Phase 1 publishes only `{source: {kind: 'upload'}, focus: {mode: 'auto'}, effect: 'natural'}` and `{source: {kind: 'none'}}`.** This is §7's create-flow boundary applied to both controls. The preset branch, the manual-focus branch, and the four non-`natural` effects are parsed, validated, tested, and rendered by the service, but no shipped surface can select them. Cover **removal** is one of those two shipped configs, so the existing `Remove cover` control is rewired in Task 12 along with the two upload controls.
3. **Phase 1 extends `deleteEventData()` with the §14 relational order.** The specification assigns this to phase 3, but §9 puts `ON DELETE RESTRICT` on every cover table's `event_id` in `0012`, and phase-1 traffic creates those children on every upload and every replacement. See the blocking hazard below; this is not deferrable.

### Blocking hazards verified in the code

**The `RESTRICT` inversion.** There is **zero precedent** in this schema for `ON DELETE RESTRICT` against `events(id)`. All fifteen existing `REFERENCES events(id)` clauses are `ON DELETE CASCADE` (`0001:26,41,55,82,96`; `0002:7`; `0006:43,93,112,125`; `0008:50,61,173`; `0009:7`), plus one `ON DELETE SET NULL` (`0006:66`). The only three `RESTRICT` foreign keys in the whole database point at `event_sessions(id)`. Specification §9 inverts that contract for twelve new tables at once. `worker/workflows/cleanup.ts:191-195` ends with a fixed three-statement batch, and `tests/worker/cleanup.test.ts:131` asserts `foreignKeyCheck()` returns `[]`, which proves foreign keys are genuinely enforced in miniflare — so the first event owning a cover row fails its purge with a hard foreign-key error and retries forever. Three further tests (`migration-0008.test.ts:263,311`, `migration-0009.test.ts:84`) execute a bare `DELETE FROM events` and stay green only while their fixtures create no cover row. **Task 4 must land before any writer creates a cover row.**

**The composition Web Worker has no foothold.** `rg` for `new Worker`, `OffscreenCanvas`, `createImageBitmap`, and `?worker` across `src/` returns zero hits; `vite.config.ts` has no `worker` block (plugins are exactly `[react(), cloudflare(), omitLocalDevVarsPlugin()]`); and `src/test/setup.ts` is the single line `import '@testing-library/jest-dom/vitest';` with no canvas in jsdom. §9.5 phase-1 item 3 requires the shipped controls to gain it. Task 12 introduces Vite Web Worker bundling from nothing and splits the saliency algorithm behind a pure array-in/coordinates-out boundary so `test:unit` can cover it without canvas.

**`verify:fresh-d1` cannot satisfy §15.2 by extending a list.** `READ_ONLY_INVARIANT_QUERY` has exactly six statements, `parseWranglerInvariantOutput` hard-codes `parsed.length !== 6`, and the query is compared byte-for-byte in `buildFreshD1CommandPlan`, again in `assertFreshD1CommandPlan`, and a third time in the unit fixture. Asserting new tables, indexes, foreign keys, and the absence of `0013` needs new statement kinds — and `PRAGMA foreign_key_check` proves only that no violating rows exist, never that a `RESTRICT` clause is present.

### Type-gate ordering

Five dependencies force the task order and are the reason Tasks 1, 5, 6, and 10 sit where they do. Each would otherwise fail its own gate — and the last two fail gates that are not `npm run typecheck`.

| Consumer needs | Producer | Placement |
| --- | --- | --- |
| `COVER_*` members of the closed `ApiErrorCode` union | `shared/errors.ts` | Folded into **Task 1**, not the rendering task — the storage task's RED tests already throw four of them |
| Ten matching entries in the exhaustive `Record<ApiErrorCode, …>` | `shared/load-failure.ts` | Same commit as the codes, in **Task 1**. Widening the union without it is a typecheck failure in Task 1's own Step 4 |
| `env.COVER_RENDER_WORKFLOW` in `Cloudflare.Env` | `wrangler.jsonc` + `worker/index.ts` + `cf-typegen` | **Task 5**, before every service that dispatches or fences a Workflow |
| The guarded event-pointer statements | `worker/db/events.ts` | **Task 6**, before both consumers: the Workflow's finalize batch and the routes' synchronous `none` publication |
| The compatibility reader, before any writer repoints `cover_object_key` | `worker/routes/content.ts` | **Task 10**, ahead of the routes in Task 11. This one is a *correctness* ordering, not a compile ordering: the reverse order produces a commit that streams the private normalized master to guests, and no gate catches it |

One ordering constraint has no gate at all and is recorded rather than enforced: nothing in this repository type-checks a `fetch` URL against a registered route, so the commit at the end of Task 11 has three client callers pointed at deleted routes. Task 12 closes it, and the two must stay adjacent. See Task 12's opening note.

### Spec gaps this plan closes

Four things the specification requires but never defines. Each becomes an append-only release constant the moment `0012` ships, so a naming mistake is not correctable later.

1. **`EventCoverProfileId` is never defined.** It is referenced twice (specification lines 465 and 473) and its six members are only inferable from the §10.2 table. This plan authors the union in `shared/event-cover.ts`.
2. **`available2xProfiles` is "a sorted allowlisted delivery capability" with no stated sort key.** Pin **ASCII-lexical** order, the only unambiguous reading: `compact-default`, `compact-expanded`, `framed-default`, `short-lookup`, `standard-default`, `wide-expanded`. This differs from the layout order the §10.2 table presents; the registry keeps layout order and only the projection sorts.
3. **At least eleven version axes are required to be pinned with no names and no values.** One is baked into an R2 key template (`{effect}-{recipeVersion}.webp`). Task 1 defines them as one exported record, all initially `1`.
4. **The compatibility reader's third branch is undefined.** §9.5 phase-1 item 2 gives only two branches (active render set, legacy null-set). §8's invariants give `none` **and** `preset` null render-set pointers. Task 10 specifies the exact three-way branch.

A fifth gap is smaller but blocks the first publication of every event: §11 makes `expectedRevision` mandatory and a stale value a `409`, and the `409` recovery view carries the current revision — but a manager who has never published has no recovery view to read, and no other response exposes `cover_revision`. Task 10 closes it by projecting `coverRevision` onto the Manager event view.

### Consequences the specification does not name

Every row is a verified property of the current repository, and is why a task below exists.

| Fact | File | Consequence |
| --- | --- | --- |
| `EXPECTED_COLUMN_NAMES.events` is an exact ordered 26-name list ending at `photos_open_from`; `assertTerminalTable` compares `cid` positionally | `scripts/verify-fresh-d1.ts:45-63,368` | `verify:fresh-d1` fails the moment `0012` lands unless the array is extended, appending only. There is no function named `assertColumns` |
| The unit fixture duplicates that list and patches rows by hard index (`events[18]`, `events[24]`, `events[25]`) | `tests/unit/verify-fresh-d1.test.ts:96-100` | New columns are safe only at cid 26/27/28; insertion silently mispatches |
| `EVENT_VIEW_KEYS` has exactly 29 entries and is asserted with `Object.keys(...).sort()` at five sites; `GUEST_EVENT_VIEW_KEYS` has 18 | `tests/worker/event-theme-api.test.ts:20-71,200,240,250,664,677,680` | `coverPreparation` and `coverRevision` make it 31; the guest list stays 18 and is the guard proving guests receive neither |
| **Seven** object literals are annotated `: EventView`, and they do not all fail the same gate — six are in `tsconfig.app.json`, one only in `tsconfig.e2e.json` | `npm run typecheck`: `tests/ui/event-appearance-editor.test.tsx:31`, `event-settings-editor.test.tsx:24`, `manager-photo-intake.test.tsx:22`, `manager-rsvp-panel.test.tsx:28`, `tests/unit/event-settings-draft.test.ts:14`, `manager-event-merge.test.ts:15`. `npm run typecheck:e2e`: `tests/e2e/fixtures/routes.ts:64` | Two required fields break every one; `npm run typecheck` alone reports success while `tests/e2e` is still broken, so Task 10 runs both gates. Seven further literals spread a base fixture and compile unchanged |
| `mergeOwned` copies only listed keys; `COVER_OWNED = ['coverObjectKey']` | `src/features/settings/event-merge.ts:41` | A response carrying `coverPreparation` or `coverRevision` is silently dropped until the list grows — and a dropped revision makes the *next* publication take an unearned `409` |
| `eventView(event, now)` is pure and synchronous over an `EventRecord`, with **eight** call sites | `worker/http/event-view.ts:33`; `worker/routes/event.ts:28`, `manage.ts:178,186,220,257,301,336`, `public.ts:87` | `coverPreparation` needs a D1 read, so the caller resolves it and passes it in; the projection stays pure. `coverRevision` needs no read — it is already on the `EventRecord` |
| `guestEventView` assigns `coverObjectKey: event.coverObjectKey` on **its own line**, independent of `eventView` | `worker/http/event-view.ts:41` and `:83` | Sentinelling only the Manager projection hands guests the repurposed normalized-master key — worse than the status quo, because that column now holds a private master rather than a legacy original |
| `GET /manage/events/:eventId` — the Manager event read — is in a **third** route file no cover task would otherwise touch | `worker/routes/event.ts:26-29` | Without editing it, `coverPreparation` is always `null` on the read that the whole recovery story depends on |
| `EventRow` is a hand-maintained projection, not a schema mirror: it orders `theme_config` before `cover_object_key` and omits `legacy_owner_claim_open` entirely | `worker/db/events.ts:4-30,52-80` | `SELECT *` returns the new columns and silently drops them until `EventRow`, `EventRecord`, and `mapEvent` are all extended |
| `EventsRepository` has seven methods and uses `db.batch` **zero** times | `worker/db/events.ts:119-320` | The guarded-batch convention `CLAUDE.md` mandates lives only in `media.ts` and `exports.ts`; the pointer transaction has no precedent inside the class owning the cover column |
| Three different guard-failure conventions coexist: `applyPhotoIntake` returns `null`, `updateTheme` and `setCover` throw plain `Error` (which becomes `INTERNAL_ERROR` 500) | `worker/db/events.ts:243,302,314` | Pick one deliberately. The house precedent for a lost optimistic guard is `ApiError('VALIDATION_FAILED', 'Photo delivery has moved on since this page loaded. Reload and try again.', 409)` at `worker/routes/manage.ts:329-335`, recorded in `docs/operations.md:150-151` as "No new error code was added for it" |
| The cover surface is split across two route files and two mount positions | `worker/app.ts:39,41` | "Change the cover routes in `manage.ts`" silently omits both readers, which is exactly where the compatibility reader lives |
| Eager deletion of the displaced original, twice | `worker/routes/manage.ts:177,185` | Both sites are removed; §9.5 item 4 inventories the key instead |
| Cover finalize does not apply the heic-sequence→heic aliasing `finalizeStoredMedia` applies | `worker/routes/manage.ts:171` vs `worker/storage/media.ts:47-49` | `image/heic-sequence` and `image/heif-sequence` can be reserved but can never finalize — a latent dead path this candidate closes rather than carries forward |
| `env.IMAGES` is typed non-optional but guarded `if (env.IMAGES)`; Images unavailability surfaces as `FILE_TYPE_UNSUPPORTED` 503 | `worker-configuration.d.ts:10`, `worker/storage/previews.ts:26,35` | Cover code needs its own failure codes rather than a code whose name contradicts its meaning |
| `ImageTransform.gravity`'s coordinate object requires `mode` (`'remainder' \| 'box-center'`), not optional | `worker-configuration.d.ts:12522-12530` | A focal-crop recipe omitting `mode` will not typecheck |
| `R2PutOptions.onlyIf` and `sha256` exist natively but `onlyIf` is used nowhere in the repo | `worker-configuration.d.ts:2111-2122` | §9.4's "immutable conditional creates" is natively expressible; name the exact conditional rather than inventing a read-then-write |
| The only Images fake is file-local, discards every `transform()` argument, and returns a fixed 400×300 PNG | `tests/worker/upload-api.test.ts:72-78,317-330` | §15.2's "exact Images parameters" and byte-ceiling assertions need a recording, parameterizable fake in a shared helper |
| `hostAccess` **and** `hostWriteHeaders` are file-local, not exported from the shared helpers, and are useless apart | `tests/worker/event-theme-api.test.ts:150,173` | Host-account (scope `host`, header `x-candidary-host-csrf`) coverage for new cover writes requires lifting **both** into `tests/worker/helpers.ts`; lifting only the credential leaves every cover task hand-rolling the header map |
| `shared/load-failure.ts` closes with `satisfies Record<ApiErrorCode, LoadFailureDecision>` — an **exhaustive** map, not a partial one | `shared/load-failure.ts:67` | Ten new error codes without ten new entries fails `npm run typecheck` inside Task 1's own gate; `UNKNOWN_FAILURE_DECISION` at `:69` is a runtime fallback and does not satisfy a type constraint |
| Five test files already read the `TEST_MIGRATIONS` binding, and `migration-0010.test.ts` already defines `upTo(name)` / `only(name)` over it | `migration-0006/0007/0008/0010.test.ts`, `repositories.test.ts:35,175`; `migration-0010.test.ts:19-34` | The partial-migration harness is **lifted**, not invented; do not write a second one |
| `deletePrefix` is module-private | `worker/workflows/cleanup.ts:7` | Export it rather than duplicating prefix deletion |
| Workflow binding **presence** is already proven under miniflare — `POST .../exports` awaits `EXPORT_WORKFLOW.create()` before returning, and the test asserts the `202` | `worker/routes/exports.ts:40-41`; `tests/worker/export-api.test.ts:29` | Do not plan around `create()` being unavailable in the workerd pool. It works |
| Instance **lifecycle** has no precedent anywhere: nothing calls `get()`, `.status()`, `.resume()`, `.restart()`, or `.terminate()`, and `ExportWorkflow` is one `step.do` | `worker/index.ts:13`; repo-wide | Every §9.4 disposition depends on exactly those unproven calls. Each new Workflow ships a pure driver tested directly, plus an injected accessor faked over the lifecycle surface only |
| `resetDatabase()` flattens every migration into one pseudo-migration | `tests/worker/helpers.ts:36-42` | A populated-legacy `0012` test cannot use it |
| `vitest.config.ts` collects `tests/unit/**/*.test.ts` only | `vitest.config.ts` | A `.tsx` test under `tests/unit` is silently not collected; component tests go in `tests/ui` |
| `api<T>()` forces `content-type: application/json` on any body and always `await response.json()` | `src/app/api.ts` | A raw binary PUT needs a sibling helper that still attaches the scope CSRF header and `credentials: 'same-origin'` |
| No route reads `If-Match`; every optimistic check passes the expected version in the JSON body | repo-wide | §11's `If-Match` on draft `DELETE` has no precedent; specify parsing and its error mapping |
| `exports.ts` returns `202` with no `Location` and no `Retry-After` | `worker/routes/exports.ts:41,60` | The `Retry-After` precedent is `worker/routes/rsvp.ts:57`, set immediately before the throw |
| `ExportsRepository.createActive`'s `try/catch` cannot distinguish an idempotent replay from a genuine conflict | `worker/db/exports.ts` | Use the read-then-classify idiom `MediaRepository.reserve` uses with `getIdempotent` in its catch |
| A streaming byte-count-and-abort request reader exists but buffers every chunk | `worker/routes/manage-rsvp.ts:248-283` | Cite it as the abort precedent; the never-buffer-the-whole-photo half of §10.1 still has none |
| No cover rate-limit binding exists (only namespaces 1001 and 1002) | `wrangler.jsonc:44-61` | Implement the budgets in D1 as the RSVP lookup budgets do. Do **not** add a third `ratelimits` entry |
| `useEventCover` keys its effect on `[path]`, and neither cover path carries a key or revision | `src/app/use-event-cover.ts` | Replacing a cover already produces no refetch; under a constant sentinel nothing in the client can detect a replacement at all |
| `security.spec.ts` asserts the guest hero's `background-image` matches `/blob:/` | `tests/e2e/security.spec.ts:208` | Confirms the responsive `<picture>` reader must stay unwired in phase 1 |
| Three cover baselines live in `event-theming-visual.spec.ts-snapshots/`, are zero-tolerance, and are Windows-only | `guest-default-cover-390`, `guest-garden-cover-390`, `manager-event-appearance-390` | Only the Manager one should change; if a guest one changes, the reader has been wired |
| A **fourth** baseline is invalidated, in the other snapshot directory: `create-validation-focus-390` captures the `.create-form` locator, which contains the cover-field copy line | `tests/e2e/visual-qa.spec.ts:97` captures `.create-form`; `src/pages/CreatePage.tsx:172,184` | Correcting `Optional · JPEG, PNG, or WebP · 10 MB max` in Task 12 moves those pixels. A recapture guard scoped to the cover directory alone fails the run |
| `verify:pwa-build` reads `_headers` from the client build as a required file and runs **twice** in the release plan | `scripts/verify-pwa-build.mjs:13-20,58-61` | A scoped `/assets/event-covers/*` block does not break its anchored regex, but the file now sits under two gates |
| `build.assetsInlineLimit: 0` and Vite's default `assetsDir` is `assets`; `public/` holds nine files | `vite.config.ts:70-73`, `public/` | 721 preset files land in the same output directory as content-hashed bundle assets, on both of the two builds `verify:release` performs |
| `output/` is gitignored; no committed evidence pins a pre-`0012` migration digest | `.gitignore:7` | Changing the manifest digest invalidates nothing checked in |
| `MigrationVerification.terminalSchema` is a closed three-key type and `parseMigrationVerification` rejects unknown fields; the literal recurs in four test files | `scripts/release-evidence.ts:32-42`; `verify-fresh-d1`, `verify-release`, `release-evidence`, `deploy-release` unit tests | Keep the reported shape at three keys; hold new assertions internal to the verifier so the schema version need not move |
| `design/design-system.md:182-188` binds the current pipeline as "the only event image system" and forbids "a second upload, asset, or background-image system" | `design/design-system.md` | Phase 1 violates the doc unless it is amended; the specification never mentions this file |
| `docs/deployment.md` pins the expected pending set in four places | `docs/deployment.md:128-129,187-189,277-278,455` | All four go stale the moment `0012` is checked in |
| `PHYSICAL_EVIDENCE_CATEGORIES` is a closed 13-member set with no cover category | `shared/release.ts:57-71` | Phase 1 claims no physical evidence, so no category is added; state this rather than leaving it open |

### Pinned planning state

The execution preflight must re-read these and stop if any differ.

| Ref/fact | Reviewed value |
| --- | --- |
| `main` | `d63e88b` (`docs: harden event cover studio design`) |
| approved base for `verify:release` | `0b92387d2e237d568d2514373dcc3044e7960d4b` |
| migrations before this branch | 11, terminating at `0011_release_certifications.sql` |
| `events` columns before this branch | 26, terminating at `photos_open_from` |
| complete trigger set before this branch | `media_stamp_stored_at_compat`, `events_rsvp_deadline_insert`, `events_rsvp_deadline_update` |
| `ApiErrorCode` members before this branch | **47**, terminating at `INTERNAL_ERROR` (`shared/errors.ts:2-48`) |
| `EVENT_VIEW_KEYS` / `GUEST_EVENT_VIEW_KEYS` | 29 / 18 |
| `eventView` call sites outside its definition | 8 |
| `wrangler.jsonc` workflows | exactly one: `candidary-export` / `EXPORT_WORKFLOW` / `ExportWorkflow` |
| cover mutation routes | `POST /cover`, `POST /cover/finalize`, `DELETE /cover` (`worker/routes/manage.ts:145-187`) |
| cover delivery routes | `GET /event/:slug/cover`, `GET /manage/events/:eventId/cover` (`worker/routes/content.ts:25-36`) |
| `config/release.json` | exactly `{"guestJourneyVersion": 1}` — one key. `tests/unit/release.test.ts:186-190` asserts `toEqual({ guestJourneyVersion: 1 })`, so adding a key here is a RED test, not a reconciliation |
| evidence manifest schema version | `CANDIDATE_MANIFEST_SCHEMA_VERSION = 1` at `scripts/release-evidence.ts:19` — **not** in `config/release.json` |

External platform contracts are the ones enumerated in specification §17, read on 2026-08-03. Re-read the Images `.input()` ceiling, the Workflows instance-ID retention rule, and the Workers Static Assets immutability contract before Tasks 7, 9, and 14; a changed platform limit invalidates a pinned constant, not just a comment.

---

### Task 1: Establish cover-owned constants, error codes, and the shared cover contract

**Files:**
- Modify: `shared/constants.ts`
- Modify: `shared/errors.ts`
- Modify: `shared/load-failure.ts`
- Create: `shared/event-cover.ts`
- Create: `tests/unit/event-cover.test.ts`

**Interfaces:**

Numbers live in `shared/constants.ts`, because that file states in its own comment (lines 36-38) that it "stays the single place a number is allowed to change" and `shared/rsvp.ts` is the established precedent for a domain module that re-exports them. `shared/event-cover.ts` owns identifiers, registries, schemas, versions, and projections.

The error codes land **here**, not with the rendering service, because the storage task's RED tests already throw four of them and `ApiErrorCode` is a closed union — `new ApiError('COVER_DRAFT_LIMIT', …)` will not typecheck until this edit exists. Ten new members bring the union from 47 to 57: `COVER_SOURCE_UNSUPPORTED`, `COVER_SOURCE_TOO_SMALL`, `COVER_MASTER_BUDGET_EXHAUSTED`, `COVER_PREVIEW_BUDGET_EXHAUSTED`, `COVER_OUTPUT_BUDGET_EXHAUSTED`, `COVER_DRAFT_LIMIT`, `COVER_RAW_STORAGE_LIMIT`, `COVER_DRAFT_STATE_CONFLICT`, `COVER_PUBLICATION_CONFLICT`, and `COVER_RENDER_UNAVAILABLE`.

A `cover_revision` compare-and-swap conflict deliberately gets **no** code. `worker/routes/manage.ts:329-335` establishes the house precedent for a lost optimistic guard — `ApiError('VALIDATION_FAILED', …, 409)` — and `docs/operations.md:150-151` records that no new code was added for it. Use the same shape with cover-appropriate prose. `ApiErrorDetails` is a bare alias to `RsvpRosterBatchConflictDetails`, not a union; **do not widen it**. Cover conflicts carry their recovery view in the response envelope.

**Widening the union has one non-obvious consequence, and it lands inside this task's own gate.** `shared/load-failure.ts:67` closes its table with `} as const satisfies Record<ApiErrorCode, LoadFailureDecision>` — an exhaustive map, not a partial one. Ten new members without ten new entries is a `npm run typecheck` failure in Step 4, and the `UNKNOWN_FAILURE_DECISION` fallback at `:69` does not rescue it because that fallback is a runtime path and the constraint is a type. Add all ten as `decision('retry')`. That is the correct classification and not a placeholder: every cover code is Manager-only, none is reachable from a guest load, and none of `latest-link`, `ended-event`, or `sign-in` describes a manager whose upload was rejected. Do not attach `offerSignIn`.

Added to `shared/constants.ts`:

```ts
export const COVER_UPLOAD_MIME_TYPES = [
  'image/jpeg', 'image/png', 'image/webp', 'image/heic',
] as const;
export const MAX_COVER_UPLOAD_BYTES = 19_000_000;
export const MAX_COVER_MASTER_BYTES = 12_000_000;
export const MIN_COVER_SOURCE_WIDTH = 620;
export const MIN_COVER_SOURCE_HEIGHT = 420;
export const MAX_COVER_MANUAL_ZOOM = 2.0;
export const COVER_PAPER_MATTE = '#fffaf3';
export const MAX_LIVE_COVER_DRAFTS_PER_EVENT = 3;
export const MAX_LIVE_COVER_RAW_BYTES_PER_EVENT = 57_000_000;
export const MAX_COVER_PREVIEW_FILES_PER_DRAFT = 5;
export const MAX_COVER_PREVIEW_BYTES = 1_000_000;
export const MAX_COVER_PREVIEW_BYTES_PER_DRAFT = 5_000_000;
export const MAX_PREPARING_COVER_PUBLICATIONS_PER_EVENT = 1;
export const MAX_NONACTIVE_COVER_RENDER_SETS_PER_EVENT = 32;
export const MAX_RETAINED_COVER_RECEIPTS_PER_EVENT = 1_024;
export const MAX_COVER_RESERVATIONS_PER_HOUR = 12;
export const MAX_COVER_INSPECTIONS_PER_HOUR = 12;
export const MAX_COVER_PREVIEWS_PER_HOUR = 30;
export const MAX_COVER_PUBLICATIONS_PER_HOUR = 6;
export const MAX_COVER_BACKFILL_PAGE_SIZE = 100;
export const MAX_COVER_BACKFILL_CREATE_BATCH = 25;
export const MAX_COVER_BACKFILL_IN_FLIGHT = 25;
export const MAX_COVER_BACKFILL_CREATIONS_PER_MINUTE = 25;
export const MAX_COVER_PURGE_FENCES_PER_PASS = 10;
export const MAX_COVER_PURGE_PLATFORM_MUTATIONS_PER_PASS = 5;
export const COVER_CLEANUP_ROWS_PER_CLASS = 100;
```

`shared/event-cover.ts` exports the §8 types verbatim, plus the four things the specification requires but never defines:

```ts
// Spec gap 1: referenced twice, never defined. Registry order is layout order.
export type EventCoverProfileId =
  | 'short-lookup' | 'compact-default' | 'standard-default'
  | 'framed-default' | 'compact-expanded' | 'wide-expanded';
export type EventCoverDensity = '1x' | '2x';
export type EventCoverFormat = 'webp' | 'jpeg';

// Spec gap 3: eleven unnamed, unvalued version axes. Append-only from 0012 onward.
export const COVER_PIPELINE_VERSIONS = {
  compositionModel: 1,
  inspectionRecipe: 1,
  previewRecipe: 1,      // the {recipeVersion} baked into the preview object key
  normalizationLadder: 1,
  imagesParameterRecipe: 1,
  matte: 1,
  metadataPolicy: 1,
  cropProfileRegistry: 1,
  tonalEffect: 1,
  sharpening: 1,
  outputQualityLadder: 1,
  presetAsset: 1,        // the assetVersion pinned into a published preset config
} as const;
export type CoverPipelineVersionAxis = keyof typeof COVER_PIPELINE_VERSIONS;

export interface EventCoverProfile {
  id: EventCoverProfileId;
  width: number; height: number;
  // Four ceilings per profile: one per density, per format.
  webpByteCeiling: Record<EventCoverDensity, number>;
  jpegByteCeiling: Record<EventCoverDensity, number>;
}
export const EVENT_COVER_PROFILES: readonly EventCoverProfile[];   // layout order
export const EVENT_COVER_PRESETS: readonly { id: EventCoverPresetId; name: string }[];
export const EVENT_COVER_EFFECTS: readonly EventCoverEffectId[];
export const COVER_MASTER_LADDER: readonly { longEdge: number; area: number; quality: number }[];
export const COVER_PREVIEW_LADDER: readonly { longEdge: number; quality: number }[];
export const COVER_OUTPUT_WEBP_QUALITIES: readonly [82, 78, 74, 70];
export const COVER_OUTPUT_JPEG_QUALITIES: readonly [84, 80, 76, 72];

export function resolveCoverProfile(input: {
  containerWidth: number; viewportWidth: number; viewportHeight: number;
  welcomeExpanded: boolean; lookup: boolean;
}): EventCoverProfileId;

export function coverTrimRectangle(master: { width: number; height: number },
  focus: { x: number; y: number; zoom: number }): { left: number; top: number; width: number; height: number };
export function coverProfileCrop(trim: { width: number; height: number },
  profile: EventCoverProfile, density: EventCoverDensity): { width: number; height: number } | null;
export function safeCoverZoomMaximum(master: { width: number; height: number }): number;

// Spec gap 2: "sorted" pinned to ASCII-lexical. Registry order stays layout order.
export function qualifiedCover2xProfiles(master: { width: number; height: number },
  focus: { x: number; y: number; zoom: number }): readonly EventCoverProfileId[];

export const eventCoverDraftCreateSchema: ZodType<EventCoverDraftCreateRequestV1>;
export const eventCoverPublishSchema: ZodType<EventCoverPublishRequestV1>;
export const eventCoverCompositionSchema: ZodType<{
  expectedDraftRevision: number; modelVersion: number; x: number; y: number;
}>;
export function canonicalCoverConfig(config: StoredEventCoverConfigV1): string;
export function canonicalCoverRequest(request: EventCoverPublishRequestV1): string;
export function parseStoredCoverConfig(value: unknown): StoredEventCoverConfigV1 | null;
export function coverSurfaceTreatment(config: StoredEventCoverConfigV1): EventCoverSurfaceTreatmentId;
```

Zod has no `discriminatedUnion` precedent anywhere in `shared/`, `worker/`, or `src/`, and `EventCoverPublishRequestV1` discriminates on the nested key `source.kind`, which `z.discriminatedUnion` cannot address. Use `z.union([...])` of three fully `.strict()` object schemas, each with its own `.strict()` `source`.

- [ ] **Step 1: Write the failing shared-contract test**

Cover: exactly six preset IDs and five effect IDs, independent of the four theme presets; the exact four-member `COVER_UPLOAD_MIME_TYPES` tuple with `image/heif`, `image/heic-sequence`, and `image/heif-sequence` rejected; every limit's exact decimal value; all six profiles' exact dimensions and **four** byte ceilings each; the eleven version axes present and all `1`; the five master rungs and four preview/output rungs in order; `resolveCoverProfile` at the boundary pairs 360/361, 390/391, 699/700 and heights 599/600/601 and 759/760, in every hero state, with no unmapped tuple; `qualifiedCover2xProfiles` returning ASCII-lexical order, preserving all six 1x profiles for any master at or above 620×420, and adding a 2x profile only when its crop is producible without upscaling; `safeCoverZoomMaximum` never exceeding `2.0` and never permitting a zoom that invalidates a 1x profile; canonical serialization stable under key reordering; and strict rejection of unknown keys, arbitrary preset/effect names, out-of-range focus or zoom, object keys, URLs, CSS, and transform parameters at every nesting level.

Do **not** try to assert the union's member count. `ApiErrorCode` is a pure type with no runtime representation — there is no array to read and `Object.keys` has nothing to enumerate. The ten codes are proven three other ways, all of which already exist: `shared/load-failure.ts`'s exhaustive `satisfies` turns a missing member into a compile error, `classifyApiErrorCode('COVER_DRAFT_LIMIT')` returning `'retry'` is a runtime assertion that reaches the same table, and every route test in Tasks 6-11 asserts the code it actually receives. Assert the ten new `load-failure` entries here; that is the runtime half.

- [ ] **Step 2: Verify RED**

```powershell
npx vitest run --config vitest.config.ts tests/unit/event-cover.test.ts
```

- [ ] **Step 3: Implement the constants, codes, and contract module**

Keep `shared/event-cover.ts` dependency-free apart from `zod` and `./constants`. It is imported by the browser, the Worker, and the scripts project, so it may not reach for a Worker global, a DOM global, or a Node built-in.

- [ ] **Step 4: Verify GREEN and commit**

```powershell
npx vitest run --config vitest.config.ts tests/unit/event-cover.test.ts
npm run typecheck
npm run lint
git add shared/constants.ts shared/errors.ts shared/load-failure.ts shared/event-cover.ts tests/unit/event-cover.test.ts
git commit -m "feat: define the shared event cover contract"
```

---

### Task 2: Add migration 0012 and the cover inventory row types

**Files:**
- Create: `migrations/0012_event_cover_storage.sql`
- Modify: `worker/db/types.ts`
- Modify: `worker/db/events.ts`
- Modify: `tests/worker/helpers.ts`
- Modify: `tests/worker/migration-0010.test.ts`
- Modify: `tests/worker/event-theme-api.test.ts`
- Create: `tests/worker/migration-0012.test.ts`

**Interfaces:**

Three columns are appended to `events`, in this order, so they land at `cid` 26, 27, and 28:

```sql
ALTER TABLE events ADD COLUMN cover_config TEXT NOT NULL
  DEFAULT '{"version":1,"source":{"kind":"none"}}'
  CHECK (length(cover_config) <= 4096)
  CHECK (json_valid(cover_config))
  CHECK (json_type(cover_config) = 'object');
ALTER TABLE events ADD COLUMN cover_revision INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(cover_revision) = 'integer')
  CHECK (cover_revision >= 0);
ALTER TABLE events ADD COLUMN cover_render_set_id TEXT;
```

Use `0011`'s stacked-`CHECK` style rather than `0007`'s single `AND` chain. SQLite cannot attach a cross-column constraint through `ALTER TABLE ADD COLUMN`, so §8's canonical invariants are **not** enforced in SQL during phase 1. That is deliberate and is what `0013` exists for. Say so in the comment block.

The twelve tables are the §9.1-§9.5 set: `event_cover_masters`, `event_cover_drafts`, `event_cover_draft_previews`, `event_cover_render_sets`, `event_cover_render_objects`, `event_cover_publish_receipts`, `event_cover_workflow_fences`, `event_cover_rate_events`, `event_cover_retired_legacy_objects`, `event_cover_purge_progress`, `event_cover_backfill_runs`, and `event_cover_backfill_jobs`. Every `event_id` uses `REFERENCES events(id) ON DELETE RESTRICT` — the first such clauses in this schema, and the reason Task 4 exists. `event_cover_workflow_fences` intentionally has **no** foreign key to `events`, because it must outlive the row it protected.

Partial unique indexes:

```sql
CREATE UNIQUE INDEX event_cover_render_sets_one_active_per_event
  ON event_cover_render_sets(event_id)
  WHERE state = 'active';
CREATE UNIQUE INDEX event_cover_receipts_one_preparing_per_event
  ON event_cover_publish_receipts(event_id)
  WHERE status IN ('queued', 'rendering', 'finalizing')
     OR (status = 'failed' AND retryable = 1);
```

`worker/db/types.ts` gains `coverConfig: string`, `coverRevision: number`, and `coverRenderSetId: string | null` on `EventRecord`, plus a row type per new table. `worker/db/events.ts` extends both `EventRow` and `mapEvent`; without both, `SELECT *` returns the columns and silently drops them.

`tests/worker/helpers.ts` **lifts three existing patterns** rather than inventing them. `migration-0010.test.ts:19-34` already reads the `TEST_MIGRATIONS` binding and defines `upTo(name)` / `only(name)`; five test files already parse that binding. Move that pair into the shared helpers unchanged in behavior. Then lift **both** halves of the host-account credential out of `tests/worker/event-theme-api.test.ts` — `hostAccess` at `:150` *and* `hostWriteHeaders` at `:173`. They are one unit: `hostAccess` returns `{ account, cookie, csrf }`, and `hostWriteHeaders` is what turns that into a request with `x-candidary-host-csrf` and the `origin` header set. Lifting only the first leaves every cover task hand-rolling the header map, which is exactly how a scope gets tested against the wrong CSRF header and passes. Without the pair, the `{ write: true }` scope-selection branch of `assertCsrf` is untested for the whole cover surface.

```ts
export const orderedMigrations: Migration[];              // from the TEST_MIGRATIONS binding
export function migrationsUpTo(name: string): Migration[];
export function migrationOnly(name: string): Migration;
export async function hostAccess(events?: readonly EventAccess[]): ReturnType<typeof hostAccess>;
export function hostWriteHeaders(
  host: { cookie: string; csrf: string },
  extraCookie?: string,
): Record<string, string>;
```

`hostAccess`'s return type stays **inferred**, as it is today — `{ account, cookie, csrf }`, where `account` is whatever `AccountsRepository.create` resolves to. Do not introduce a hand-written `HostAccess` interface to name it; that would be a second declaration of a shape the repository already derives, and it drifts the moment the accounts row type changes.

`migrationsUpTo` inherits `upTo`'s **exclusive** semantics unchanged: `slice(0, index)` stops *before* the named migration. `migrationsUpTo('0012')` therefore applies `0001`–`0011`, which is what Step 1 depends on — it seeds against the pre-`0012` schema and then applies `migrationOnly('0012')` as the unit under test. Do not "fix" it to be inclusive; `migration-0010.test.ts` reads it the same way.

Update `migration-0010.test.ts` and `event-theme-api.test.ts` to import all five rather than keeping private copies.

- [ ] **Step 1: Write the failing migration test**

Apply `migrationsUpTo('0012')`, seed one event with a legacy `cover_object_key` and one without, then apply `migrationOnly('0012')` and prove:

- both rows survive with `cover_config` exactly `{"version":1,"source":{"kind":"none"}}`, `cover_revision` `0`, `cover_render_set_id` null, and the legacy `cover_object_key` untouched;
- `events` reports exactly 29 columns with the three new names last and in the stated order;
- the `cover_config` CHECKs reject a >4 KiB value, invalid JSON, and a JSON array; `cover_revision` rejects a negative and a real number;
- every new table rejects an `event_id` naming no event, and **rejects deleting a referenced event with a foreign-key error** — assert this explicitly, because it is the behavior Task 4 exists to accommodate;
- both partial unique indexes behave as specified, including a `failed` receipt blocking only while `retryable = 1`;
- `(event_id, draft_intent_id)`, `(draft_id, effect_id, recipe_version)`, `(render_set_id, profile_id, density, format)`, `(event_id, operation_id)`, `(event_id, action, replay_key)`, `(run_id, event_id)`, and the unique object-key and Workflow-instance-ID constraints each reject their duplicate;
- the trigger set is still exactly the three pre-existing triggers; and
- an empty database migrated `0001` through `0012` in order reaches the identical schema.

- [ ] **Step 2: Verify RED**

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/migration-0012.test.ts
```

- [ ] **Step 3: Write the migration, row types, and mapping**

Follow `0010`'s commentary density. This is the widest schema change in the repository's history, and the comment block must say what each table owns, why `ON DELETE RESTRICT` was chosen over the schema's universal `CASCADE` (an object must be proven gone from R2 before its inventory row may go, and a cascade would delete the only record of an object still sitting in the bucket), and that cross-column invariants are deferred to `0013`.

- [ ] **Step 4: Verify GREEN, measure the cost, and commit**

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/migration-0012.test.ts tests/worker/migration-0010.test.ts tests/worker/event-theme-api.test.ts
Measure-Command { npx vitest run --config vitest.worker.config.ts }
npm run typecheck
npm run lint
git add migrations/0012_event_cover_storage.sql worker/db/types.ts worker/db/events.ts tests/worker
git commit -m "feat: add event cover storage schema"
```

Every Worker test now applies twelve extra tables in setup, against the configured `testTimeout: 20_000`. Record the measured total. If a suite approaches the timeout, that is information the release needs — do not raise the timeout to hide it.

---

### Task 3: Extend the fresh-D1 verifier and its fixture

**Files:**
- Modify: `scripts/verify-fresh-d1.ts`
- Modify: `tests/unit/verify-fresh-d1.test.ts`

**Interfaces:**

`READ_ONLY_INVARIANT_QUERY` gains new statements, **appended** after the existing six so every positional index in the fixture stays valid:

- one `pragma_table_info` per new cover table the phase-1 schema must expose;
- `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'event\_cover\_%' ESCAPE '\' ORDER BY name`, to pin the exact table set;
- `PRAGMA foreign_key_list` for each cover table, to prove the `RESTRICT` clause exists — `PRAGMA foreign_key_check` proves only that no violating rows exist and would pass on a `CASCADE` schema;
- `PRAGMA index_list` for each cover table, plus `PRAGMA index_info` for the two partial unique indexes; and
- `SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name`, expected to be exactly the three pre-existing triggers.

The index assertions are not redundant with `migration-0012.test.ts`. That test proves the indexes *behave* by inserting a duplicate and catching the error; this verifier proves they **exist on a freshly migrated remote-shaped database**, which is a different failure. An index silently dropped by an out-of-order or partially applied migration leaves a schema that accepts every insert the behavioral test never runs — a second active render set per event, or a second preparing receipt, both of which §9.2 and §9.3 treat as impossible and neither of which any later code re-checks. `PRAGMA index_list` alone is insufficient for the two partial uniques: it reports `unique` and `partial` flags but not the `WHERE` clause, so pair it with the `sqlite_master.sql` text for those two index names and compare the predicate exactly. Their names are fixed by §15.2 and are part of the contract, not an implementation detail — assert the names, not just the count.

That trigger query is how the absence of `0013` is asserted **positively**. The ledger comparison cannot do it: the ledger derives from `collectMigrationManifest(candidateRoot)`, so a file that is not checked in is never seen, and `collectMigrationManifest` would accept a correctly numbered `0013` without complaint. Pair it with an exact expected ledger length of twelve.

`parseWranglerInvariantOutput`'s `parsed.length !== 6` literal is bumped to the new statement count. `MigrationVerification.terminalSchema` **keeps its three keys**: `exactRecord` rejects unknown fields, the literal recurs in four test files, and `CANDIDATE_MANIFEST_SCHEMA_VERSION` is `1`. New assertions stay internal to the verifier and throw on failure.

- [ ] **Step 1: Write the failing verifier test**

Extend the fixture so `eventColumnNames` appends the three names at index 26/27/28, `terminalRows()` patches them by their new indices, `invariantOutput()` gains one envelope per appended statement in order, and the drift table gains a mutation per new assertion: a missing cover table, an extra cover table, a wrong `cover_config` default, a `CASCADE` where a `RESTRICT` is required, a **missing partial unique index**, a **partial unique index whose `WHERE` predicate has drifted** (drop `OR (status = 'failed' AND retryable = 1)` — the mutation a hand-edited migration would most plausibly produce, and the one that reopens duplicate preparing receipts), a present `0013` trigger, and a thirteen-entry ledger. Assert the reported `terminalSchema` still has exactly three keys.

`dflt_value` for `cover_config` must be captured exactly as SQLite renders the stored literal, including its embedded double quotes. Read it from a real applied database rather than hand-writing it.

- [ ] **Step 2: Verify RED**

```powershell
npx vitest run --config vitest.config.ts tests/unit/verify-fresh-d1.test.ts
```

- [ ] **Step 3: Implement the verifier changes**

`READ_ONLY_INVARIANT_QUERY` is compared byte-for-byte in `buildFreshD1CommandPlan`, again in `assertFreshD1CommandPlan`, and a third time in the test. Change the constant once; do not reformat it. The exact-column gate is `assertTerminalTable`, not `assertColumns`.

- [ ] **Step 4: Verify GREEN against a real fresh database and commit**

```powershell
npx vitest run --config vitest.config.ts tests/unit/verify-fresh-d1.test.ts
$runRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('candidary-release-cover-' + (git rev-parse --short=12 HEAD))
if (Test-Path -LiteralPath $runRoot) { throw 'Inspect and remove that exact temp directory before retrying.' }
New-Item -ItemType Directory -Path $runRoot | Out-Null
npm run verify:fresh-d1 -- --run-root $runRoot --report-file (Join-Path $runRoot 'migration-verification.json')
npm run typecheck
npm run lint
git add scripts/verify-fresh-d1.ts tests/unit/verify-fresh-d1.test.ts
git commit -m "test: verify the cover storage schema on fresh D1"
```

Record the reported `migrationCount` (twelve) and `ledgerSha256`, then remove the validated temp root.

---

### Task 4: Extend the event purge order before any writer creates a cover row

**Files:**
- Modify: `worker/workflows/cleanup.ts`
- Modify: `tests/worker/cleanup.test.ts`

This task is not optional and cannot move later in the sequence. See the blocking hazard above.

**Interfaces:**

`deleteEventData()` keeps its signature and its load-bearing shape — revoke, delete the R2 prefix, then relational — and gains two things between the prefix deletion and the existing `media`/`guest_messages` batch:

1. clearing the event's own cover pointers on the already soft-deleted row (`cover_config` to canonical `none`, `cover_object_key` and `cover_render_set_id` to null); and
2. deleting the event-owned cover rows in exactly this order: rate events → publication receipts and backfill jobs → render objects → render sets → draft previews → drafts → retired-legacy inventory → masters → purge-progress row.

An affected backfill run's counters are recomputed from its remaining jobs in the same transaction, and the run row is deleted only when it has no remaining jobs. Workflow fences are intentionally left alone: they have no event foreign key and age out on their own 31-day schedule.

`deletePrefix` is module-private at `worker/workflows/cleanup.ts:7`; export it rather than duplicating prefix deletion in the storage service. Its existing `events/${eventId}/` prefix already covers all four cover key shapes — assert that rather than assuming it.

The bounded fence coordinator, the per-pass mutation budgets, `event_cover_purge_progress` writes, and the `202 deletionScheduled` response remain phase 3.

- [ ] **Step 1: Write the failing purge test**

Seed an event owning at least one row in every cover table, including a retired-legacy row and a terminal backfill job, and prove `deleteEventData` removes the event, that no cover row survives, that `foreignKeyCheck()` returns `[]`, and that the R2 prefix is empty. Add a second case where R2 deletion fails: the error propagates, the event stays soft-deleted, every cover row survives, and a second pass completes.

- [ ] **Step 2: Verify RED**

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/cleanup.test.ts
```

Expected: the foreign-key failure this task exists to prevent.

- [ ] **Step 3: Implement the extended order, then verify GREEN and commit**

```powershell
npx vitest run --config vitest.worker.config.ts
npm run typecheck
npm run lint
git add worker/workflows/cleanup.ts tests/worker/cleanup.test.ts
git commit -m "fix: purge event cover inventory before the event row"
```

---

### Task 5: Declare both Workflow bindings and regenerate the binding types

**Files:**
- Create: `worker/workflows/cover-render.ts` (payload type and class skeleton)
- Create: `worker/workflows/cover-backfill.ts` (payload type and class skeleton)
- Modify: `worker/index.ts`
- Modify: `wrangler.jsonc`
- Modify: `worker-configuration.d.ts` (generated)
- Modify: `tests/worker/smoke.test.ts`

This task exists purely to open the type gate. Every service from Task 6 onward references `env.COVER_RENDER_WORKFLOW`, which does not exist in `Cloudflare.Env` until the wrangler entry, the exported class, and `cf-typegen` all land together.

**Interfaces:**

```jsonc
{ "name": "candidary-cover-render", "binding": "COVER_RENDER_WORKFLOW", "class_name": "CoverRenderWorkflow" },
{ "name": "candidary-cover-backfill", "binding": "COVER_BACKFILL_WORKFLOW", "class_name": "CoverBackfillWorkflow" }
```

Both binding names become persisted D1 data in `event_cover_workflow_fences`, so they are immutable release constants from `0012` onward; renaming one later orphans fence rows. Declare both now — a wrangler entry whose class is not exported fails at the build/dry-run stage — with skeleton `run()` bodies that Task 9 and Task 15 fill in.

`worker-configuration.d.ts` derives each binding type as `Workflow<Parameters<import("./worker/index").ClassName['run']>[0]['payload']>`, so typegen resolves the class by its exact exported name: the wrangler entry, the `export class`, and `npm run cf-typegen` must land in **one** commit. `verify:bindings` is the second command in the `verify:release` plan, before typecheck, lint, and every test, so a stale generated file fails the whole gate before anything else runs.

The export routes at `worker/routes/exports.ts:40,59` dispatch with no fence, no post-call check, and no `202` headers. They are deliberately untouched; the repository will hold two dispatch idioms and the newer one is the cover pipeline's.

- [ ] **Step 1: Extend the smoke test, implement, and commit**

`tests/worker/smoke.test.ts` currently asserts `expect(ExportWorkflow).toBeTypeOf('function')`. Add the same assertion for both new classes and assert both bindings are present on `testEnv`.

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/smoke.test.ts
npm run cf-typegen
npm run verify:bindings
npm run typecheck
npm run lint
git add worker/workflows/cover-render.ts worker/workflows/cover-backfill.ts worker/index.ts wrangler.jsonc worker-configuration.d.ts tests/worker/smoke.test.ts
git commit -m "chore: declare the cover workflow bindings"
```

---

### Task 6: Build the cover storage service, inventory repositories, and the guarded pointer statements

**Files:**
- Create: `worker/storage/event-cover-keys.ts`
- Create: `worker/db/event-covers.ts`
- Modify: `worker/db/events.ts`
- Create: `tests/worker/event-cover-storage.test.ts`

**Interfaces:**

`worker/storage/event-cover-keys.ts` is the only place a cover R2 key is constructed:

```ts
export function coverRawKey(eventId: string, draftId: string): string;
export function coverMasterKey(eventId: string, masterId: string): string;
export function coverPreviewKey(eventId: string, draftId: string, effect: EventCoverEffectId, recipeVersion: number): string;
export function coverRenderKey(eventId: string, renderSetId: string, profile: EventCoverProfileId, density: EventCoverDensity, format: EventCoverFormat): string;
export function presetAssetPath(assetVersion: number, presetId: EventCoverPresetId, effect: EventCoverEffectId, profile: EventCoverProfileId, density: EventCoverDensity, format: EventCoverFormat): string;
```

`recipeVersion` is `COVER_PIPELINE_VERSIONS.previewRecipe`, never a caller-chosen number.

**The guarded pointer statements are a statement *builder*, not a self-executing method.** The upload publication's finalize must commit the pointer flip, the retirement insert, the previous-set retirement, the new-set activation, the draft `published` flip, and the receipt `applied` flip in **one** `db.batch`. A method that runs its own batch cannot participate in that. `worker/db/events.ts` therefore gains:

```ts
export function coverPointerStatements(db: D1Database, input: {
  eventId: string;
  expectedRevision: number;
  expectedCurrentKey: string | null;
  expectedCurrentRenderSetId: string | null;
  nextConfig: string;
  nextObjectKey: string | null;
  nextRenderSetId: string | null;
  retiredAt: string;
  cleanupAfter: string;
}): D1PreparedStatement[];
```

Statement order follows the house convention exactly — **guard first**:

1. the guarded pointer move, whose `WHERE` carries `id = ?`, `deleted_at IS NULL`, `cover_revision = ?`, `cover_object_key IS ?`, and `cover_render_set_id IS ?` (SQLite `IS` for null-safe comparison), setting the three pointers and `cover_revision = cover_revision + 1`; then
2. the retirement insert as `INSERT INTO event_cover_retired_legacy_objects (...) SELECT ?, ?, ?, ?, ?, ? WHERE changes() = 1 AND ? IS NOT NULL AND ? IS NULL`, so the row is written **only** when the guard held, a key was actually displaced, and that key was a legacy original rather than a render-set master.

That ordering matters for two reasons the naive shape gets wrong. A D1 `db.batch()` rolls back only when a statement **errors**; a zero-change `UPDATE` does not error, so an unguarded insert placed first would commit a retirement row naming a cover that is still current. And with `expectedCurrentKey: null` — the first cover an event ever gets — an unconditional insert would write `NULL` into the table's `NOT NULL UNIQUE object_key` and fail every first-cover publication. Guarding on `changes() = 1` plus the two null tests fixes both.

The caller checks `results[0].meta.changes === 1` and raises the `worker/routes/manage.ts:329-335` 409 shape on a lost guard, not the plain `Error` the old `setCover` threw — that became `INTERNAL_ERROR` 500, the wrong signal for a revision conflict. **No R2 delete happens here.** Only bounded cleanup may delete a retired object.

`worker/db/event-covers.ts` holds the inventory repositories. `EventsRepository` uses `db.batch` zero times, so this module carries the guarded-batch convention: the guard in the first statement's `WHERE`, later statements appending `AND changes() = 1`, then `results[0].meta.changes === 1` checked and the error derived from current state, exactly as `MediaRepository.reserve` does.

Idempotency uses read-then-classify, not `ExportsRepository.createActive`'s bare `try { INSERT } catch { throw 409 }` — that catch swallows the constraint and cannot tell a same-intent, same-digest replay from a genuine conflict. Follow `MediaRepository.reserve`, which re-reads with `getIdempotent` inside its catch.

R2 writes use `R2PutOptions.onlyIf` for create-if-absent and `sha256` for write-time verification. Both exist in the generated types and neither is used anywhere in the repository today. The application-level digest is still recorded in inventory: R2's `sha256` proves the write, the stored digest proves the row.

The raw-byte aggregate gets one helper so reservation, ingress completion, discard, and cleanup cannot drift:

```ts
export function liveCoverRawBytesSql(): string; // declared bytes for reserved in-flight drafts with
                                               // no raw object, plus max(declared, verified) for
                                               // every non-null raw key in ANY state
```

A discard marks a draft `expired` but cannot subtract cleanup-pending bytes. Only verified R2 absence followed by a guarded transaction clearing the raw pointer and verified size releases the amount. If an oversized object can be HEAD-observed but not deleted, its observed size replaces the declaration and keeps counting.

Rate budgets are D1-only, following the RSVP lookup precedent. **Do not add a third `ratelimits` entry** — that would change the generated bindings and the topology digest for no functional gain. Rows use `window_start = floor(serverUnixSeconds / 3600) * 3600` and the unique key `(event_id, action, replay_key)`.

- [ ] **Step 1: Write the failing storage test**

Cover key determinism and event-prefix containment; draft-intent replay returning the original draft without consuming a second live-draft slot or rate event; a same-intent different-digest request returning `409`; the three-live-draft cap and the 57,000,000-byte aggregate; repeated fail/discard cycles staying charged until verified R2 absence clears the raw pointer; guarded discard requiring the current draft revision, idempotent for an already-expired draft, `409` for a stale revision or a `publishing` draft, and never expiring the event's active master; preview file-count and aggregate-byte checks counting only ready files and running transactionally before adoption; same-tuple preview replay returning the stored terminal result with only a retryable failure re-entering `rendering`; conditional-create adoption reading and verifying an existing key rather than overwriting it; and rate-window counting, replay exemption, and expiry reconstruction across a simulated restart.

For `coverPointerStatements` specifically: the retirement row is written in the same batch that moves the pointer; the displaced object still exists in R2 afterward; a **stale expected revision writes no retirement row at all** (the lost-guard case the naive ordering gets wrong); a changed current key likewise; a first-ever cover (`expectedCurrentKey: null`) succeeds and writes no retirement row; a replacement whose current key belongs to an active render set writes no retirement row either; and no code path deletes a displaced original eagerly.

- [ ] **Step 2: Verify RED, implement, verify GREEN, and commit**

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/event-cover-storage.test.ts
npm run typecheck
npm run lint
git add worker/storage/event-cover-keys.ts worker/db/event-covers.ts worker/db/events.ts tests/worker/event-cover-storage.test.ts
git commit -m "feat: add event cover storage inventory"
```

---

### Task 7: Build the normalization and rendering service

**Files:**
- Create: `worker/storage/event-cover-images.ts`
- Modify: `tests/worker/helpers.ts`
- Modify: `tests/worker/upload-api.test.ts`
- Create: `tests/worker/event-cover-images.test.ts`

**Interfaces:**

This service owns every Images call and is the only module permitted to name a transform parameter.

```ts
export async function normalizeCoverMaster(env: AppEnv, input: {
  eventId: string; draftId: string; masterId: string; rawKey: string;
}): Promise<CoverMasterResult>;                     // five-rung ladder, first qualifying rung wins
export async function renderCoverPreview(env: AppEnv, input: {
  eventId: string; draftId: string; masterKey: string; effect: EventCoverEffectId;
}): Promise<CoverPreviewResult>;                    // four-rung ladder, uncropped, metadata-free
export async function renderCoverProfileObject(env: AppEnv, input: {
  eventId: string; renderSetId: string; masterKey: string;
  focus: { x: number; y: number; zoom: number }; effect: EventCoverEffectId;
  profile: EventCoverProfileId; density: EventCoverDensity; format: EventCoverFormat;
}): Promise<CoverRenderObjectResult>;               // conditional create; an existing key is verified, never overwritten
export async function verifyCoverManifest(env: AppEnv, renderSetId: string): Promise<CoverManifestVerdict>;
```

Every transform applies the fixed `#fffaf3` matte before the selected effect, so a transparent PNG or WebP cannot produce format-dependent edges. Normalization sets `metadata: 'none'`, applies EXIF orientation, disables animation, and never upscales. `renderCoverProfileObject` computes the trim rectangle from `shared/event-cover.ts` geometry, applies the profile aspect crop with upscaling disabled, then the fixed effect and restrained output sharpening. Cloudflare Images' face-only `zoom` parameter is not used. `ImageTransform.gravity`'s coordinate object requires `mode` — a recipe omitting it will not typecheck.

`tests/worker/helpers.ts` gains a shared recording fake, because the only existing one discards every `transform()` argument:

```ts
export interface RecordedImagesCall {
  input: { byteLength: number };
  transforms: unknown[];
  output: unknown;
}
export function withRecordingImages(options?: {
  encode?(call: RecordedImagesCall): { bytes: Uint8Array; width: number; height: number; contentType: string };
}): { env: AppEnv; calls: RecordedImagesCall[] };
```

The default encoder returns deterministic bytes sized from the requested dimensions and quality, so a test can force a specific ladder rung to miss its byte ceiling. Migrate both inline fakes in `tests/worker/upload-api.test.ts` (lines 72-78 and 317-330) onto this helper in the same commit, so the repository has exactly one Images fake.

- [ ] **Step 1: Write the failing rendering test**

Assert the exact Images parameters for normalization, the automatic and manual crop, all five tonal recipes, both output formats, every profile, and every quality rung; that arbitrary dimensions, quality values, and transform parameters are refused; the five-rung master ladder skipping a rung that would fall below 620×420 and failing when none qualifies; the four-rung preview ladder with `COVER_PREVIEW_BUDGET_EXHAUSTED` on exhaustion; per-slot output ladders accepting the first encoding within the ceiling and failing publication when exhausted; the exact 12-to-24-object manifest with mandatory 1x pairs and conditionally-present 2x pairs; conditional-create adoption; and manifest verification checking R2 existence, dimensions, MIME, checksum, rung, and byte ceiling.

- [ ] **Step 2: Verify RED, implement, verify GREEN, and commit**

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/event-cover-images.test.ts tests/worker/upload-api.test.ts
npm run typecheck
npm run lint
git add worker/storage/event-cover-images.ts tests/worker/helpers.ts tests/worker/event-cover-images.test.ts tests/worker/upload-api.test.ts
git commit -m "feat: add the event cover rendering service"
```

These tests prove request recipes, orchestration, persistence, controlled byte enforcement, and failure handling against a deterministic fake. They do **not** prove real Cloudflare codec bytes, EXIF/GPS removal, encoder sizes, tonal output, or crop pixels; §15.5 owns those claims.

---

### Task 8: Build the publication receipt, dispatch-fence, and reconciliation service

**Files:**
- Create: `worker/services/event-cover-publication.ts`
- Create: `tests/worker/event-cover-publication.test.ts`

**Interfaces:**

```ts
export async function acceptCoverPublication(env: AppEnv, input: {
  event: EventRecord; request: EventCoverPublishRequestV1; requestDigest: string; now: Date;
}): Promise<CoverPublicationAcceptance>;   // insert-or-load, early revision check, freeze draft, allocate set
export async function applyRemovalPublication(env: AppEnv, input: {
  event: EventRecord; operationId: string; requestDigest: string; now: Date;
}): Promise<CoverPublicationOutcome>;      // synchronous `none`, using coverPointerStatements
export async function readCoverPublication(env: AppEnv, input: {
  eventId: string; operationId: string; now: Date;
}): Promise<EventCoverPreparationView | null>;   // side-effect-free
export async function restartCoverPublication(env: AppEnv, input: {
  eventId: string; operationId: string; now: Date;
}): Promise<CoverPublicationRestartResult>;      // the only failed -> queued edge
export function mapPlatformStatus(status: string | 'unknown' | 'not-found'): CoverPlatformDisposition;
export async function selectEventCoverPreparation(env: AppEnv, eventId: string, now: Date): Promise<EventCoverPreparationView | null>;
```

`applyRemovalPublication` lives here rather than in a route, so the `none` publication and the Workflow's finalize share one writer for the event pointers. Both compose `coverPointerStatements` from Task 6 into their own `db.batch`.

`mapPlatformStatus` is a **total switch** over `queued`, `running`, `waiting`, `waitingForPause`, `paused`, `errored`, `terminated`, `complete`, `unknown`, and confirmed not-found. Its `default` preserves product state and emits sanitized operations telemetry; no other value is ever treated as non-running. Dispositions are exactly §9.4's: active statuses keep preparing and poll; `paused` recovers by `resume()` on the same instance, never `restart()`; `errored`/`terminated` may `restart()` only inside the retryable receipt's restart window after revision, cap, and fence checks; `complete` reconciles D1 first and records a safe retryable divergence when D1 is unexpectedly nonterminal; `unknown` never satisfies a mutation predicate and yields retryable `503` guidance; and a confirmed not-found may `create()` the same ID with the pinned payload after mapping the previously missing instance to a safe retryable failure and claiming a new dispatch generation.

The status read applies this map **only** as read-only product-view synthesis. The Workflow handler, the restart route, and bounded cleanup are the authoritative writers. The restart route may additionally persist a recoverable mapping from stale nonterminal D1 and claim its recovery edge in one guarded transaction, so recovery never waits for the daily sweep.

`selectEventCoverPreparation` is the server-side selector behind the Manager projection: the one unresolved receipt, otherwise the most recently updated terminal receipt from the last 24 hours, otherwise null. It never returns a Workflow ID, object key, recipe, checksum, or platform telemetry.

**The injected Workflow accessor is scoped to what is actually unproven, not to a blanket doubt.** Binding *presence* under miniflare is already demonstrated: `tests/worker/export-api.test.ts:29` asserts a `202` from a route that `await`s `EXPORT_WORKFLOW.create()`, so `create()` resolves in the workerd pool today and this plan does not need to work around it. What has no precedent anywhere in this repository is instance *lifecycle* — `get()`, `.status()`, `.resume()`, `.restart()`, `.terminate()`. `ExportWorkflow` never calls one; `worker/index.ts:13` is a single `step.do` and nothing reads an instance back. Every disposition in `mapPlatformStatus` depends on exactly those unproven calls.

So the service takes its Workflow accessor as an injected dependency defaulting to `env.COVER_RENDER_WORKFLOW` (present because Task 5 landed the binding), and the tests drive the lifecycle surface through a fake. Record the finding either way: if a spike shows miniflare returns real statuses, note it in Task 17's document reconciliation so a later phase can narrow the fake to `create()` only; if it does not, the fake is the only way §9.4's ten-status map is testable at all, and the gap between fake and platform is a stated phase-1 limitation rather than a silent one.

**Authorization decision to record.** `resolveManager` prefers the account credential and propagates lifecycle failures as 404/410. A preparation started under a management link whose `managementAccessExpiresAt` passes mid-render makes the status `GET` throw `EVENT_EXPIRED` 410 rather than return a preparation view. That is correct — an expired management window is not a cover problem — but it must be tested and stated, because §11's "recovered authentication" language does not address it.

- [ ] **Step 1: Write the failing publication test**

Cover receipt insertion and same-digest replay; digest collision returning `409`; rate and storage caps rejecting a first-seen operation but never a replay; the early revision check recording `conflict` with zero Workflow dispatch and zero Images work; deterministic Workflow ID derivation and uniqueness; dispatch failure recording retryable `failed` and returning `503`; replay moving that receipt back to `queued` and creating or restarting the same instance without allocating a competitor; the complete platform-status map including `waiting`, `waitingForPause`, and an unrecognized value hitting the preserving default; dispatch-fence create/restart races; deletion winning the commit/dispatch gap and the mandatory post-call termination; a late failure handler being unable to overwrite `applied` or `conflict`; accepted `conflict` and permanent-failure receipts releasing the draft back to `ready`; retryable-failed receipts keeping the draft `publishing` through the restart window; the side-effect-free status read synthesizing an immediate retryable view for `paused`/`errored`/`terminated`/complete-divergent/not-found while `unknown` stays preparing; `applyRemovalPublication` retiring a legacy original into inventory, being idempotent under replay, and losing its revision guard without writing a retirement row; and the expired-management-window case above.

- [ ] **Step 2: Verify RED, implement, verify GREEN, and commit**

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/event-cover-publication.test.ts
npm run typecheck
npm run lint
git add worker/services/event-cover-publication.ts tests/worker/event-cover-publication.test.ts
git commit -m "feat: add durable event cover publication receipts"
```

---

### Task 9: Implement CoverRenderWorkflow

**Files:**
- Modify: `worker/workflows/cover-render.ts`
- Create: `tests/worker/cover-render-workflow.test.ts`

**Interfaces:**

The module exports a pure driver; the class from Task 5 calls it. This split is what makes the orchestration testable, and it follows `processExport`.

```ts
export interface CoverRenderPayload { eventId: string; operationId: string }
export async function coverRenderPreflight(env: AppEnv, payload: CoverRenderPayload): Promise<CoverRenderPreflight>;
export async function coverRenderProfileStep(env: AppEnv, payload: CoverRenderPayload, profile: EventCoverProfileId): Promise<CoverRenderStepSummary>;
export async function coverRenderFinalize(env: AppEnv, payload: CoverRenderPayload): Promise<CoverRenderOutcome>;
```

```ts
export class CoverRenderWorkflow extends WorkflowEntrypoint<AppEnv, CoverRenderPayload> {
  async run(event: WorkflowEvent<CoverRenderPayload>, step: WorkflowStep) {
    const preflight = await step.do('preflight cover publication', () => coverRenderPreflight(this.env, event.payload));
    if (!preflight.shouldRender) return preflight.outcome;
    for (const profile of EVENT_COVER_PROFILES) {
      await step.do(`render cover profile ${profile.id}`, () => coverRenderProfileStep(this.env, event.payload, profile.id));
    }
    return step.do('finalize cover publication', () => coverRenderFinalize(this.env, event.payload));
  }
}
```

Eight deterministically named steps, not one. Each profile step creates or verifies that profile's mandatory 1x WebP/JPEG pair and its optional 2x pair, uses conditional R2 creates, and records only a small inventory summary in Workflow state — image bytes stay in R2. No cross-step state comes from mutable top-level memory.

`coverRenderFinalize` composes `coverPointerStatements` into **one** `db.batch` that also retires the previous set, activates the new one, marks the draft `published`, and marks the receipt `applied`. That is the single transaction §9.5 item 4 requires: the displaced key is inventoried by the same statements that move the pointer.

- [ ] **Step 1: Write the failing Workflow-driver test**

Cover the preflight rehydrating server state and rechecking receipt digest/status, event deletion, revision, draft ownership, master, pinned recipe, the source-qualified density manifest, and platform limits before any Images work; a known-stale event atomically recording `conflict`, abandoning the empty set, and returning the draft to `ready` without transforming; a deleted event recording safe failure and a deletion-blocked fence exiting before work; the six profile steps in order being individually replay-safe (running a step twice adopts rather than rewrites); manifest verification gating `staging → ready` and `rendering → finalizing`; the final one-batch transaction requiring the event revision, the same nonterminal receipt/digest/Workflow ID, the frozen draft, and the ready set, then writing the retirement row when a legacy original is displaced, retiring the previous set, activating the new one, incrementing the revision exactly once, and marking the draft and receipt terminal; and the losing-guard case recording `conflict`, abandoning the set, returning the draft to `ready`, writing **no** retirement row, and touching no active pointer.

- [ ] **Step 2: Verify RED, implement, verify GREEN, and commit**

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/cover-render-workflow.test.ts
npx vitest run --config vitest.worker.config.ts
npm run typecheck
npm run lint
git add worker/workflows/cover-render.ts tests/worker/cover-render-workflow.test.ts
git commit -m "feat: render event covers in a bounded workflow"
```

---

### Task 10: Install the compatibility reader and the cover projection

**Files:**
- Modify: `worker/routes/content.ts`
- Modify: `worker/routes/event.ts`
- Modify: `worker/http/event-view.ts`
- Modify: `shared/contracts.ts`
- Modify: `tests/worker/event-theme-api.test.ts`
- Modify: `tests/ui/event-appearance-editor.test.tsx`
- Modify: `tests/ui/event-settings-editor.test.tsx`
- Modify: `tests/ui/manager-photo-intake.test.tsx`
- Modify: `tests/ui/manager-rsvp-panel.test.tsx`
- Modify: `tests/unit/event-settings-draft.test.ts`
- Modify: `tests/unit/manager-event-merge.test.ts`
- Modify: `tests/e2e/fixtures/routes.ts`
- Create: `tests/worker/event-cover-delivery.test.ts`

**This task runs before the routes**, reversing the order an earlier draft of this plan used. The reader is a safe no-op-then-active change: branch 1 below is unreachable until something writes `cover_render_set_id`, branch 2 is exactly current behavior, and branch 3 is exactly the current 404. Registering the routes first would produce a commit where an upload has already repointed `cover_object_key` at the normalized WebP master while `coverResponse` still streams that column verbatim — serving the private high-resolution master to guests, which §11 forbids outright ("The normalized master is never a guest response") and §9.5 item 3 names explicitly. It would also force `manage-api.test.ts`'s content-type assertion to be rewritten twice.

**Interfaces:**

The cover surface is split across two route files (`worker/app.ts:39` mounts `contentRoutes`, `:41` mounts `manageRoutes`), and the reader lives in the first. `coverResponse` changes signature from `(context, objectKey)` to `(context, event: EventRecord)` so it can branch on `cover_render_set_id`. The branch is **three-way**, closing the gap §9.5 leaves open:

1. an active render set → that set's `wide-expanded` 1x JPEG, with `Content-Type: image/jpeg`, `Cache-Control: private, no-store`, and `X-Content-Type-Options: nosniff`;
2. a legacy null-set row with a non-null `cover_object_key` → the current original response, content type from stored R2 metadata; and
3. `none` or `preset` (null render set **and** null `cover_object_key`) → the existing `ApiError('EVENT_NOT_FOUND', 'This event does not have a cover image.', 404)`.

A missing derivative in branch 1 is `UPLOAD_OBJECT_MISSING` 404 and never falls back to a prior set, a master, an object key, or an on-demand transform. Both routes return a bare `new Response(...)`, and neither the security-headers middleware nor any test verifies the global block reaches those; the existing routes defensively re-set `X-Content-Type-Options` themselves. Keep that pattern and add the missing assertion.

`worker/http/event-view.ts` is the **only** place the sentinel is introduced. `worker/routes/content.ts` reads `auth.event.coverObjectKey` from the `EventRecord`; putting the sentinel in `mapEvent` would make delivery do `MEDIA_BUCKET.get('cover-present')`.

**Both projections apply it.** `guestEventView` (`worker/http/event-view.ts:83`) assigns `coverObjectKey: event.coverObjectKey` on its own line, independent of `eventView` (`:41`). Changing only the Manager projection would hand every guest the repurposed normalized-master key — the precise leak §9.5 item 2 exists to prevent, and worse than the status quo because that column now holds a private master rather than a legacy original.

```ts
const COVER_PRESENT_SENTINEL = 'cover-present';

export function eventView(
  event: EventRecord,
  now = new Date(),
  coverPreparation: EventCoverPreparationView | null = null,
): EventView;

export function guestEventView(event: EventRecord, now = new Date()): GuestEventView;
// unchanged signature; its coverObjectKey line becomes the same sentinel expression
```

`eventView` stays pure and synchronous; the caller resolves the preparation view and passes it in. The default `null` keeps all **eight** existing call sites compiling.

**`worker/routes/event.ts` is a third route file no other cover task touches, and it owns the Manager event read.** Without editing it, `coverPreparation` is always `null` on exactly the read the whole recovery story depends on — §8's "clearing session storage cannot cancel or hide accepted work" and Task 12's "a reload with cleared session storage still resumes". Change `GET /manage/events/:eventId` to resolve the receipt with the same `now` it projects with, so the projection and the selection cannot disagree:

```ts
const now = new Date();
const preparation = await selectEventCoverPreparation(context.env, auth.event.id, now);
return context.json({ data: { event: eventView(auth.event, now, preparation) }, requestId: context.get('requestId') });
```

`shared/contracts.ts` gains **two** additive top-level Manager fields, not one:

```ts
coverPreparation: EventCoverPreparationView | null;
coverRevision: number;
```

`coverRevision` is not optional polish. §11 makes `expectedRevision` mandatory on draft creation and on `POST .../publications`, and makes a stale value a `409`; the `409` recovery view carries the current revision so a client that lost the race can recover. But a client that has *never* published has no recovery view to read, and the sentinel `coverObjectKey` deliberately carries no revision. Without this field the very first publication of every event has no legal value to send — the manager would have to force a `409` to learn the number, which turns the guard into a handshake. It projects `event.coverRevision` from the `0012` column added in Task 2; `mapEvent` already carries it.

`GuestEventView` is a `Pick<EventView, ...>` allowlist, so it receives neither field and must not be extended. `coverRevision` is a monotonic counter over an event's own covers and leaks nothing about storage; it is nonetheless Manager-only, because the guest read has no use for it and §9.5 favours the narrower list.

Because both fields are required, every object literal annotated `: EventView` stops compiling. The census is **seven** files, and they do not all fail the same gate:

| Gate | File |
| --- | --- |
| `npm run typecheck` (`tsconfig.app.json`) | `tests/ui/event-appearance-editor.test.tsx:31` |
| | `tests/ui/event-settings-editor.test.tsx:24` |
| | `tests/ui/manager-photo-intake.test.tsx:22` |
| | `tests/ui/manager-rsvp-panel.test.tsx:28` |
| | `tests/unit/event-settings-draft.test.ts:14` |
| | `tests/unit/manager-event-merge.test.ts:15` |
| `npm run typecheck:e2e` (`tsconfig.e2e.json`) | `tests/e2e/fixtures/routes.ts:64` |

Seven further `EventView`-shaped literals exist across those same suites and compile unchanged, because they spread a base fixture rather than restate the shape. Do not "fix" them. The split matters because `npm run typecheck` does not include `tests/e2e` — a run that stops at the first gate reports success while the e2e project is still broken, which is why both commands appear in this task's Step 2 and why `tests/e2e/fixtures/routes.ts` is in its Files.

- [ ] **Step 1: Write the failing projection and delivery tests**

Projection: extend `EVENT_VIEW_KEYS` from 29 to **31** (`coverPreparation`, `coverRevision`) and leave `GUEST_EVENT_VIEW_KEYS` at 18 — that untouched list is the guard proving guests receive neither. Assert the projected `coverObjectKey` is exactly `'cover-present'` when a cover exists, `null` when it does not, and never begins with `events/`. Assert `coverRevision` is `0` on a freshly created event and matches the row after a publication applies. Add a Worker test that `GET /api/manage/events/:eventId` returns a populated `coverPreparation` while a receipt is nonterminal and `null` when none is selectable, and that the guest read never carries either field.

Delivery: prove all three branches with their exact headers and error codes; that a missing derivative does not fall back; that a manager cover request with a guest cookie is `403 ROLE_FORBIDDEN` (the existing credential table in `event-theme-api.test.ts` also covers missing, unrelated-account, and cross-event cases); and that the guest route's deliberately loose check — session slug equals path slug, with no role, gallery, phase, or uploads test — is preserved exactly.

- [ ] **Step 2: Verify RED, implement, verify GREEN, and commit**

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/event-cover-delivery.test.ts tests/worker/event-theme-api.test.ts
npx vitest run --config vitest.config.ts
npx vitest run --config vitest.worker.config.ts
npm run typecheck
npm run typecheck:e2e
npm run lint
git add worker/routes/content.ts worker/routes/event.ts worker/http/event-view.ts shared/contracts.ts tests
git commit -m "feat: serve covers through the compatibility reader"
```

---

### Task 11: Register the draft, publication, and restart routes

**Files:**
- Create: `worker/routes/event-cover.ts`
- Modify: `worker/routes/manage.ts`
- Modify: `worker/app.ts`
- Create: `tests/worker/event-cover-api.test.ts`
- Modify: `tests/worker/manage-api.test.ts`
- Modify: `tests/worker/event-theme-api.test.ts`

**Interfaces:**

The ten routes from §11 are registered exactly as written. Every mutation opens with the existing manager preamble — `requireManager(context, { write: true })`, which resolves account membership and management-link credentials with explicit precedence and then runs `assertCsrf(context, auth.scope, auth.csrfDigest)` against the credential that actually authorized the request. Every write route is tested under **both** credentials using the `hostAccess` helper lifted in Task 2.

`PUT .../drafts/{draftId}/raw` is the one route that does not take JSON. It requires the reserved draft revision, an exact `Content-Type` from `COVER_UPLOAD_MIME_TYPES`, and a `Content-Length` equal to the reserved `byteSize`; it rejects a missing, mismatched, or over-limit length before storage; and it streams through a server-side byte counter that aborts as soon as byte 19,000,001 arrives. The abort precedent is `rosterRequestBody` at `worker/routes/manage-rsvp.ts:248-283` — `getReader()`, accumulate, `reader.cancel()`, throw, `releaseLock()` in `finally` — but that function buffers every chunk, so the never-buffer-the-whole-photo half has no precedent and must stream straight into the R2 write. CSRF is checked before the body stream is consumed. The Worker writes only to the draft's server-owned conditional raw key and never accepts a client key or a multipart envelope. A complete write is HEAD-verified, records the actual size and ETag, increments the draft revision, and moves `reserved → transferred`. An interrupted, mismatched, or oversized stream deletes any raw key before returning; if deletion fails, the draft stays failed with its inventory intact.

`DELETE .../drafts/{draftId}` carries no client object key and requires `If-Match: "<current draft revision>"`. No route in this repository reads `If-Match` today and every existing optimistic check passes its expected version in the JSON body, so specify the parsing explicitly: absent is `428`, malformed or stale is `409`. The Origin check is unaffected — `assertRequestOrigin` only reads the header — so a bodyless `DELETE` still passes.

`POST .../publications` returns `202`, `Location`, and `Retry-After: 2` for a new or same-digest in-progress upload; `200` with `appliedRevision` and the latest Manager event view for an applied replay or a synchronous `none` publication (which delegates to `applyRemovalPublication` from Task 8 — the route builds no statements itself); and `409` with a safe recovery view for a stale revision, digest collision, or competing preparation. There is no `202`-with-headers precedent — `exports.ts` returns `202` bare — so set both headers with `context.header(...)` alongside the normal `{ data, requestId }` envelope, following the `Retry-After` precedent at `worker/routes/rsvp.ts:57`. The `409` recovery view travels in the response envelope, **not** inside `ApiErrorDetails`.

`GET .../publications/{operationId}` is manager-authorized, event-scoped, and side-effect-free. `POST .../publications/{operationId}/restart` takes a strict empty JSON body and reconstructs nothing from the client.

The three legacy cover routes in `worker/routes/manage.ts:145-187` are deleted, along with `coverSchema` and both eager `MEDIA_BUCKET.delete(previousKey)` calls. This also closes the latent dead path where the two sequence MIME types can be reserved but never finalize.

**Two Worker tests drive the deleted routes and must be rewritten in this task, not merely re-run.** `tests/worker/manage-api.test.ts` reserves, PUTs to R2, finalizes, asserts `content-type: image/png` at line 356, and asserts `coverObjectKey` is null after `DELETE` at line 363. `tests/worker/event-theme-api.test.ts:650-664` — "uses the explicit event view for cover finalize, settings, and theme update responses" — calls both `POST .../cover` and `POST .../cover/finalize` before its `EVENT_VIEW_KEYS` assertion and will 404 on its first request. Rewrite both onto the draft/publication routes with `withRecordingImages()`. The separate `coveredEvent()` fixture in `event-theme-api.test.ts` seeds `cover_object_key` by direct SQL and drives only the delivery read, so its `image/png` assertion at line 701 genuinely survives — confirm rather than edit that one.

- [ ] **Step 1: Write the failing route test**

Cover the discriminated draft-create union and intent replay; both branches' expected-revision behavior; the four-member MIME guard with `image/heif` and both sequence types rejected; raw ingress across missing, mismatched, and lying `Content-Length`, bytes 19,000,000 and 19,000,001, stream interruption, partial-deletion failure and retry, same-draft replay, and the event aggregate; inspection across declared/detected MIME mismatch, low 1x resolution, excessive area, and a controlled master-byte failure; the composition endpoint's event/draft scope, CSRF, expected draft revision, pinned model version, coordinate bounds, one-time write, idempotent replay, and `inspected → ready` transition; `If-Match` present, absent, malformed, and stale; the publication route's `202`/`Location`/`Retry-After`, applied replay, synchronous `none`, and every `409` path; the status route's side-effect freedom; the restart route's authorization, empty-body strictness, and eligibility rules; and every write route under both credentials.

- [ ] **Step 2: Verify RED, implement, verify GREEN, and commit**

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/event-cover-api.test.ts tests/worker/manage-api.test.ts tests/worker/event-theme-api.test.ts
npx vitest run --config vitest.worker.config.ts
npm run typecheck
npm run lint
git add worker/routes/event-cover.ts worker/routes/manage.ts worker/app.ts tests/worker
git commit -m "feat: publish event covers through drafts and receipts"
```

---

### Task 12: Rewire the client cover controls and add the preparation status

**Files:**
- Modify: `vite.config.ts`
- Modify: `src/components/EventAppearanceEditor.tsx`
- Modify: `src/pages/CreatePage.tsx`
- Modify: `src/app/api.ts`
- Modify: `src/features/settings/event-merge.ts`
- Create: `src/features/cover/saliency.ts`
- Create: `src/features/cover/cover-composition.worker.ts`
- Create: `src/features/cover/cover-draft-client.ts`
- Create: `src/components/ManagerCoverPreparationStatus.tsx`
- Modify: `src/pages/ManagerPage.tsx`
- Modify: `tests/unit/manager-event-merge.test.ts`
- Create: `tests/unit/cover-saliency.test.ts`
- Modify: `tests/ui/event-appearance-editor.test.tsx`
- Modify: `tests/ui/manager-settings-autosave.test.tsx`
- Modify: `tests/ui/event-theme-creation.test.tsx`
- Create: `tests/ui/manager-cover-preparation.test.tsx`

**Interfaces:**

**This task closes a runtime window Task 11 opens, and no gate catches it in between.** Task 11 deletes the three legacy cover routes while all three client callers still address them, so the commit at the end of Task 11 is a checkout where a manager's cover upload 404s in a real browser. Every gate still passes there — `npm run typecheck` sees only string literals in `fetch` paths, the `tests/ui` suites stub the network with handlers this task rewrites, and `tests/e2e` stubs every API with `page.route`. Nothing in this repository type-checks a URL against a registered route. Accept the window rather than trying to engineer it away: an intermediate commit that keeps the old routes alive alongside the new ones would mean two writers for `cover_object_key` at once, which is the exact condition Task 10's reader ordering exists to prevent. Do not push, deploy, or hand off a checkout between Tasks 11 and 12, and keep them adjacent in the sequence.

**Three controls move, not two.** Task 11 deletes `DELETE /api/manage/events/:eventId/cover`, so `EventAppearanceEditor.removeCover` (lines 345-361) is as broken as the two upload paths. Removal becomes a `{source: {kind: 'none'}}` publication with a client-generated `operationId` — one of exactly two shipped publishable configs under interpretation decision 2. `tests/ui/event-appearance-editor.test.tsx:448` ("uploads and removes a cover immediately without creating a theme write") exercises the round trip and must be rewritten, not merely re-run.

**The limit drift.** Four literals and three copy strings disagree with each other and with the server: `COVER_ACCEPT = 'image/jpeg,image/png,image/webp'` and `COVER_MAX_BYTES = 10 * 1024 * 1024` (`EventAppearanceEditor.tsx:53-54`), plus an inline `accept`, two inline `10 * 1024 * 1024` comparisons, and the copy `'Optional · JPEG, PNG, or WebP · 10 MB max'` and `'Cover photos must be 10 MB or smaller.'` (`CreatePage.tsx:184`). The server meanwhile accepted all seven `SUPPORTED_IMAGE_TYPES` up to 20 MiB. **Neither client control accepts HEIC**, which is what an iPhone photo picker hands over — so §15.4's iPhone HEIC acceptance is blocked client-side before any server sees it. Delete every literal, drive both controls from `COVER_UPLOAD_MIME_TYPES` and `MAX_COVER_UPLOAD_BYTES`, and correct all three copy strings. `tests/ui/event-theme-creation.test.tsx:45-48` asserts the create page's `Cover photo` label position and must keep passing across the copy change.

`src/features/cover/saliency.ts` is a **pure** array-in/coordinates-out module. jsdom has no canvas, `OffscreenCanvas`, `ImageBitmap`, or `Worker`, and `src/test/setup.ts` is one line, so pixel logic cannot be tested in `test:unit` unless it is behind this boundary. `cover-composition.worker.ts` is the thin Web Worker wrapper that decodes the natural preview and calls it, returning normalized coordinates plus `COVER_PIPELINE_VERSIONS.compositionModel`; a low-confidence result returns center focus. No third-party service receives the photo.

`vite.config.ts` gains Web Worker bundling. There is no `?worker` import, no `worker` config block, and no precedent anywhere in `src/` — this is introduced from nothing. Keep `build.assetsInlineLimit: 0` and the plugin list unchanged.

`src/features/cover/cover-draft-client.ts` owns the sequence both upload controls share: persist a `draftIntentId` before the first request, create the draft, PUT the raw bytes, inspect, run the composition worker, `PATCH` the composition against the expected draft revision, then publish with a client-generated `operationId` persisted in event-scoped session storage. `api<T>()` forces `content-type: application/json` on any body and always `await response.json()`, so it cannot carry the raw stream; add a sibling helper that still attaches the scope CSRF header and `credentials: 'same-origin'`.

`src/features/settings/event-merge.ts` extends the cover-owned domain:

```ts
const COVER_OWNED = ['coverObjectKey', 'coverPreparation', 'coverRevision'] as const satisfies readonly (keyof EventView)[];
```

All three, not just the new preparation view. `mergeOwned` copies **only** the listed keys, so an unlisted `coverRevision` means a cover response carrying the post-publication revision is merged into client state that keeps the pre-publication number — and the next publication sends a stale `expectedRevision` and takes a `409` that no user action caused. Settings, theme, and photo-intake responses must own none of the three.

`ManagerCoverPreparationStatus` sits beside the cover summary, is independent of any sheet, and resumes polling on Manager load, network recovery, and authentication recovery. It shows `Preparing cover {n} of 6. Your current cover is still live.` from durable progress — never from elapsed time, never exposing the word "profile" — switches to `Still preparing. Your current cover is safe, and you can close this window.` after 60 seconds without a terminal result, and announces applied, permanent-failed, and conflict outcomes once. Its `Try again` sends only the operation ID to the restart route. Polling is 2, 4, 8, then at most 10 seconds between responses, honoring a longer server `Retry-After`, pausing while the document is hidden.

`EventAppearanceEditor` receives `onEventWrite` but not `onEventRead`; only `EventSettingsEditor` gets `onEventRead={eventRead}` at `ManagerPage.tsx:902`. Plumb the same fresh-read accessor into the appearance subtree.

`tests/ui/manager-settings-autosave.test.tsx:787-828` stubs the presigned three-step flow (`/cover` POST → R2 PUT → `/cover/finalize` POST) and asserts write-domain isolation through a `.cover-field__input` upload and a visible `Remove cover` button. Its stubs never match the draft/publication client, so it is rewritten here rather than discovered failing.

- [ ] **Step 1: Write the failing client tests**

Merge: `coverPreparation` and `coverRevision` are both adopted from a cover response and both ignored by settings, theme, and photo-intake responses — assert the revision case explicitly with a response whose revision differs from current state. Saliency: the pure function returns stable coordinates for fixture arrays and center focus below the confidence floor. Editor: the accept set includes HEIC, the ceiling is 19,000,000, all three copy strings state the real values, the draft sequence issues exactly one draft-create per intent and replays rather than re-reserving after a lost response, removal publishes `none` with a client operation ID, and the control stays disabled until the ready draft returns. Preparation status: durable step progress renders as product copy, the 60-second message replaces it without a terminal result, a reload with cleared session storage still resumes from the server-selected operation, and `Try again` posts only the operation ID.

- [ ] **Step 2: Verify RED, implement, verify GREEN, and commit**

```powershell
npx vitest run --config vitest.config.ts
npm run typecheck
npm run lint
npm run build
git add vite.config.ts src tests/unit tests/ui
git commit -m "feat: upload event covers through the draft pipeline"
```

Existing UI fixtures use realistic keys such as `'events/event-a/cover/private-photo.jpg'`. They keep working because every consumer is presence-only, but substitute the sentinel so the fixtures describe what the server now sends.

**Known phase-1 limitation to carry into review.** `useEventCover` keys its effect on `[path]`, and neither cover path carries a key or a revision, so replacing a cover already produces no refetch today. Under a constant sentinel nothing in the client can detect a replacement at all, so a phase-1 replacement becomes visible only after a reload. The specification's fix is `cover.revision` in the URL, which §9.5 defers to phase 3. Do not invent a phase-1 cache-buster; record the limitation in `design-qa.md` under Task 17.

---

### Task 13: Ship the unwired Cover Studio and responsive reader modules

**Files:**
- Create: `src/features/cover/CoverStudio.tsx`
- Create: `src/features/cover/CoverSourcePicker.tsx`
- Create: `src/features/cover/CoverComposer.tsx`
- Create: `src/features/cover/CoverStylePicker.tsx`
- Create: `src/features/cover/cover-operation-controller.ts`
- Create: `src/components/ResponsiveEventCover.tsx`
- Create: `src/components/EventAppearanceCanvas.tsx`
- Create: `tests/ui/cover-studio.test.tsx`
- Create: `tests/ui/responsive-event-cover.test.tsx`

**Interfaces:**

These modules are complete and tested but reachable from no shipped route or control. `EventAppearancePreview` stays mounted and `EventAppearanceCanvas` stays unused, so the theme-overlay scope list at `design/design-system.md:35-46` does **not** change in phase 1.

`ResponsiveEventCover` measures its container and hero state, resolves the profile through `resolveCoverProfile`, and installs one WebP `<source>` plus a JPEG fallback using density descriptors — so no `sizes` attribute is needed. It adds the 2x candidate only when the safe guest projection advertises the profile. Its `<img>` has empty alternative text because event identity and welcome copy already name the experience. Its `onError` recovery suppresses the failed picture immediately, reveals the theme's no-cover hero, may drop the WebP source and try the verified JPEG once, then emits one sanitized observable event and performs at most one event-view refresh for that revision/profile; a newer revision resets recovery, and an unchanged or removed cover stays on the gradient without another loop.

`tests/e2e/security.spec.ts:208` asserts the guest hero's `background-image` matches `/blob:/`, and the CSP allows `img-src 'self' blob: data:`. That assertion is untouched in phase 1 precisely because the reader stays unwired — confirm it still passes rather than editing it.

`CoverStudio` implements the §6 and §13 contracts: the full-screen sheet at ≤760 CSS pixels sized to `100dvh` and the centered dialog above it; the stable accessible name `Cover Studio`; focus trapping and restoration; scroll-lock and `inert` on the Manager page; the sticky 56-pixel header with an accurate `Step n of m`; the `min-height: 0` work area; the safe-area-padded footer; the sticky canvas at ≥144 CSS pixels at 320×568 compacting to 96 when the visual viewport falls below 500; short-height mode below 421 visual pixels collapsing to one dialog-level scroller with nothing sticky; and `visualViewport`-bound top and height. Three native ranges carry the crop, drag is a convenience over the horizontal and vertical values only, Zoom stays a native range so browser pinch remains page zoom, and the polite summary fires when an interaction settles.

- [ ] **Step 1: Write the failing component tests**

Studio: Choose, Compose, Style, Done, Cancel, remove, retry, session expiry, discard confirmation, and existing-upload re-edit without a redundant upload; the accurate three-step preset path and four-step upload path; removal jumping straight to a focused, labelled Done; `Done` staying disabled until the ready draft returns; `202`/`Location`/`Retry-After` handling, durable 0-6 progress, hidden-page pause and resume, lost response, sheet close and reopen, retryable same-operation restart, permanent failure, and applied/conflict merging; Cancel becoming Close once dispatch begins even when the client sees `503`, a lost response, or no `202`; keyboard crop adjustment; labelled controls, focus order and restoration, live announcements, reduced motion, and axe.

Responsive cover: profile selection at 360/361, 390/391, 699/700 and heights 599/600/601 and 759/760 across every hero state with no unmapped case; the mandatory 1x pair always advertised and the 2x pair only when advertised; WebP failure trying JPEG at most once; final failure showing the no-cover hero, refreshing at most once, resetting on a newer revision or profile, never looping, and never revealing a broken-image icon.

- [ ] **Step 2: Verify RED, implement, verify GREEN, and prove the modules are unreachable**

```powershell
npx vitest run --config vitest.config.ts tests/ui/cover-studio.test.tsx tests/ui/responsive-event-cover.test.tsx
npm run typecheck
npm run lint
npm run build
rg -n "CoverStudio|ResponsiveEventCover|EventAppearanceCanvas" src --glob '!src/features/cover/**' --glob '!src/components/ResponsiveEventCover.tsx' --glob '!src/components/EventAppearanceCanvas.tsx'
```

Expected: the last command prints nothing. A match means the module is wired and this candidate has left its release boundary.

```powershell
git add src/features/cover src/components/ResponsiveEventCover.tsx src/components/EventAppearanceCanvas.tsx tests/ui
git commit -m "feat: add the unwired cover studio modules"
```

---

### Task 14: Generate and verify the preset asset matrix

**Files:**
- Create: `scripts/build-cover-presets.ts`
- Create: `scripts/verify-cover-presets.ts`
- Modify: `public/_headers`
- Modify: `package.json`
- Create: `tests/unit/cover-presets.test.ts`
- Create: `design/cover-presets/` (six art-directed masters, each ≥2400×1600)

**Interfaces:**

The build produces and checksum-verifies six presets × five effects × six profiles × two densities × two formats — 720 versioned static files under `public/assets/event-covers/v1/` — plus the `film-grain-v1` tile. Asset version 1 is immutable: a later refresh ships a new version directory, retains the old bytes, and cannot alter an active event until the host publishes again.

```json
"build:cover-presets": "node --experimental-strip-types scripts/build-cover-presets.ts",
"verify:cover-presets": "node --experimental-strip-types scripts/verify-cover-presets.ts"
```

`public/_headers` gains a scoped rule for `/assets/event-covers/*` only. It does not relax headers for any event-bound route, and `assets.run_worker_first` is **not** changed — the responsive and preset delivery routes stay unregistered in phase 1, so these are versioned bytes with no serving route yet. State that in the commit message. Asset immutability in this repository comes from Vite content hashing, not a declared `Cache-Control`; the specification's `immutable` header for versioned preset targets is a phase-3 delivery concern and is not asserted here.

Two cost facts to verify rather than assume. `verify:pwa-build` reads `_headers` from the client build as a **required** file and asserts an anchored `manifest.webmanifest` regex; it runs twice in the `verify:release` plan, so the file now sits under two gates — a scoped block appended after that rule does not break it, but prove it. And `build.assetsInlineLimit: 0` with Vite's default `assetsDir` of `assets` means 721 files are copied verbatim into the same output directory as the content-hashed bundle assets on **both** builds `verify:release` performs; measure the added build time and output size.

`tests/unit/cover-presets.test.ts` verifies the manifest checksums and the exact 720-file count, performing real filesystem I/O inside the jsdom project; the only precedent is `tests/unit/pwa-assets.test.ts`. `tests/e2e/fixtures/cover-images.ts:42` reads `public/assets/candidary-hero.png` with a cwd-relative `readFileSync` at module import, so any preset asset used as an e2e fixture must be a checked-in file, never a build artifact.

Contrast evidence for all 720 preset/effect/theme/profile contexts comes from a deterministic compositor here, plus a mathematical worst-case-luminance proof that the fixed scrim — including the lightest and darkest grain texels — protects an arbitrary uploaded image. Axe covers semantics, not text-over-image contrast, and 720 Playwright screenshots are not the evidence.

- [ ] **Step 1: Write the failing asset test, then generate, verify, and commit**

```powershell
npx vitest run --config vitest.config.ts tests/unit/cover-presets.test.ts
npm run build:cover-presets
npm run verify:cover-presets
npx vitest run --config vitest.config.ts tests/unit/cover-presets.test.ts
Measure-Command { npm run build }
npm run verify:pwa-build
npm run typecheck
npm run lint
git add scripts/build-cover-presets.ts scripts/verify-cover-presets.ts public tests/unit/cover-presets.test.ts design/cover-presets package.json
git commit -m "feat: generate the versioned cover preset assets"
```

---

### Task 15: Complete CoverBackfillWorkflow and add the dry-run-first launcher

**Files:**
- Modify: `worker/workflows/cover-backfill.ts`
- Create: `scripts/cover-backfill.ts`
- Modify: `package.json`
- Create: `tests/worker/cover-backfill-workflow.test.ts`
- Create: `tests/unit/cover-backfill-launcher.test.ts`

**Interfaces:**

Following the `event-start-backfill` precedent:

```json
"cover-backfill:inventory": "node --experimental-strip-types scripts/cover-backfill.ts inventory",
"cover-backfill:execute":   "node --experimental-strip-types scripts/cover-backfill.ts execute",
"cover-backfill:verify":    "node --experimental-strip-types scripts/cover-backfill.ts verify"
```

`inventory` is the default and is read-only; only an explicitly authorized `execute` creates a job or a Workflow instance. The launcher inventories only rows where `cover_object_key IS NOT NULL AND cover_render_set_id IS NULL`, records its cursor, inventory digest, and counts durably, resumes after interruption within the exact bounds, and never treats SQL migration execution as image backfill.

Each job derives its instance ID from `hash('cover-backfill-v1', run_id, job_id, event_id)`. A later inventory run creates a new job and ID rather than reusing a retained instance. The launcher creates at most one 25-instance batch per minute and stops whenever 25 jobs are nonterminal.

The Workflow uses the same pinned normalization service, source-qualified manifest rules, replay-safe profile operations, and total platform-status map as publication, but does not consume Manager draft, receipt, or mutation-rate capacity. Its seven-step sequence is §9.5 phase-2 items 1 through 7. A source that cannot enter Images, cannot satisfy the 1x minimum without upscaling, or cannot pass the master ladder becomes `needs_replacement` and stays on the compatibility reader — never silently degraded, never deleted.

**No backfill is executed in this candidate.** The launcher ships, its dry run is exercised against a local fixture database only, and phase 2 is a separately authorized activity.

- [ ] **Step 1: Write the failing backfill tests, implement, and commit**

Cover exact paging, batching, in-flight, and creation-rate bounds; source-independent dependency pinning at job creation from `COVER_PIPELINE_VERSIONS`; derived-manifest and staging-set pinning only after normalization reveals the winning master dimensions; interruption and resume; same-job restart requiring `retryable`, the same pinned dependencies, the same derived manifest, the original fingerprint, the 24-hour window, and an open fence; new runs never restarting an older job; skip-on-change; `needs_replacement` resolution; retired-original inventory; reference release and ledger expiry; the zero-legacy proof; and the complete-manifest proof.

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/cover-backfill-workflow.test.ts
npx vitest run --config vitest.config.ts tests/unit/cover-backfill-launcher.test.ts
npm run typecheck
npm run lint
git add worker/workflows/cover-backfill.ts scripts/cover-backfill.ts package.json tests
git commit -m "feat: add the legacy cover backfill workflow"
```

---

### Task 16: Add the bounded cover phase to scheduled cleanup

**Files:**
- Modify: `worker/workflows/cleanup.ts`
- Modify: `tests/worker/cleanup.test.ts`

**Interfaces:**

`scheduledCleanup` gains a cover phase **before** event purge. Each daily pass processes at most 100 rows in each expiry class and leaves the remainder for the next scheduled or explicitly invoked pass. The seven sub-phases are §14's, in order, and every one deletes the R2 object and verifies its absence before removing the D1 inventory row. Any R2 deletion failure leaves the inventory intact so the next pass retries.

`scheduledCleanup` currently returns `Promise<void>`, logs nothing, and has no cursor; the event purge is a bare `LIMIT 100`. The cover phase needs a resumable, explicitly invocable shape:

```ts
export interface CoverCleanupSummary {
  draftsExpired: number; previewsDeleted: number; receiptsExpired: number;
  backfillJobsReleased: number; rateEventsDeleted: number; fencesDeleted: number;
  setsAbandoned: number; renderObjectsDeleted: number; setsDeleted: number;
  legacyObjectsDeleted: number; mastersDeleted: number; remainder: boolean;
}
export async function cleanupEventCovers(env: AppEnv, now?: Date): Promise<CoverCleanupSummary>;
```

Receipt and backfill-job reconciliation is against recorded Workflow and fence state, not wall time alone. **Add no cron expression** — `worker/index.ts`'s `scheduled` handler routes by `controller.cron === NOTIFICATION_CRON` with cleanup as the catch-all `else`, so a third expression would silently run `scheduledCleanup` anyway. Global preset static assets are release files and never participate in event cleanup.

Deadlines: reservations and unpublished drafts at 24 hours; a `publishing` draft never while its receipt is nonterminal or inside its retryable restart window; applied receipts at 7 days; conflict and permanent-failed at 24 hours; a retryable-failed receipt gets a 24-hour restart window during which its draft stays `publishing` and its staging set stays intact; a retired set or replaced master at `max(retired_at + 7 days, every referencing receipt.expires_at)`; rate rows at 26 hours after their window start; and terminal Workflow fences at 31 days after terminal verification, exceeding the platform's 30-day completed-instance retention.

- [ ] **Step 1: Write the failing cleanup test, implement, and commit**

Prove every deadline, the 100-row-per-class bound with a truthful `remainder`, R2-before-D1 ordering, reference-safe master and set cleanup, platform-state reconciliation for each disposition, R2 failure and retry, and that a still-referenced object is never deleted.

```powershell
npx vitest run --config vitest.worker.config.ts
npm run typecheck
npm run lint
git add worker/workflows/cleanup.ts tests/worker/cleanup.test.ts
git commit -m "feat: sweep event cover storage on the daily pass"
```

---

### Task 17: Reconcile the binding documents with what phase 1 actually ships

**Files:**
- Modify: `design/design-system.md`
- Modify: `docs/operations.md`
- Modify: `docs/deployment.md`
- Modify: `design-qa.md`
- Modify: `CLAUDE.md`

**Interfaces:**

`design/design-system.md` is binding per `CLAUDE.md`, and lines 182-188 read: *"The existing private cover reservation, direct upload, inspection, storage, and read pipeline remains the only event image system… it creates no second upload, asset, or background-image system."* Phase 1 replaces the presigned direct upload with an authenticated bounded ingress, adds a normalized WebP master and render sets, and ships a versioned preset asset matrix. The specification never mentions this file. Rewrite that paragraph; state that the theme-overlay scope list at lines 35-46 is **unchanged** in phase 1 because `EventAppearancePreview` stays mounted and `EventAppearanceCanvas` is unwired; and record that `surfaceTreatment` and the `#fffaf3` matte are server-resolved values that never become a forty-sixth `--event-*` property or a `[data-*]` conditional.

Add the §10.2 profile registry — six state names, breakpoints, dimensions, and byte ceilings — beside the 45-property token table. That information is design-system-grade and currently lives only in the specification.

Add the new host-facing strings to the allow-list with the document's customary justification sentence, or record why controls below the Settings fold sit outside its reach. Phase 1 renders only the preparation status, whose exact prose is `Preparing cover {n} of 6. Your current cover is still live.`, `Still preparing. Your current cover is safe, and you can close this window.`, and `Try again`, plus the corrected cover-format and size copy on both upload controls. The studio's copy, the six preset names, and the five effect names arrive unrendered and are recorded as reserved rather than allowed.

`docs/operations.md` has no code table, only a `## Support signals` bullet list. Append one bullet per new `ApiErrorCode` member in the established voice, plus a bullet for the three-way compatibility reader and one for the retired-legacy inventory. Note that a `cover_revision` conflict deliberately reuses `VALIDATION_FAILED` 409, following the recorded decision at lines 150-151, and that all ten new codes classify as `retry` in `shared/load-failure.ts` because none is reachable from a guest load.

`docs/deployment.md` pins the expected pending set in four places (128-129, 187-189, 277-278, 455). All go stale the moment `0012` is checked in. Update them to name `0012` as the next migration, restate that it must be applied as its own separately authorized operation, and add the phase-1/2/3 gate structure so nobody applies `0012` and reads it as authorization to backfill.

`design-qa.md` gains a `### Cover storage targeted verification` block in "How this evidence is produced" listing the new commands, and `## Decisions recorded` entries for the `cover-present` sentinel, for the known phase-1 limitation that a replaced cover becomes visible only after a reload, and for **whatever Task 8's spike found about miniflare Workflow lifecycle fidelity**. Record it either way: that `create()` is proven under miniflare (`export-api.test.ts:29`) while `get()`/`.status()`/`.resume()`/`.restart()`/`.terminate()` are exercised only against an injected fake, and whether a local probe showed real statuses. That gap is the single largest distance between what this candidate tested and what the platform will do, and leaving it unwritten is how a later phase mistakes the fake for evidence. Add **no** rows to `design/fidelity-ledger.md`: phase 1 renders no new guest surface and only one small Manager status, and the ledger's own convention is that evidence is recorded at exactly the strength it was observed.

`CLAUDE.md`'s "New image format" checklist gains a fourth item pointing at `COVER_UPLOAD_MIME_TYPES`. Its Architecture section gains the two new Workflow bindings and a one-paragraph cover-pipeline summary.

**Release-version decisions to record.** `config/release.json` stays exactly `{"guestJourneyVersion": 1}` — `tests/unit/release.test.ts:186-190` asserts that shape, so adding a key is a RED test rather than a reconciliation. Phase 1 changes the *value* semantics of a guest-visible field, but every guest consumer treats `coverObjectKey` as a presence flag and no guest-visible behavior changes, so the journey version does not move. `CANDIDATE_MANIFEST_SCHEMA_VERSION` stays `1`, and `PHYSICAL_EVIDENCE_CATEGORIES` gains no cover member because phase 1 claims no physical evidence.

- [ ] **Step 1: Make the edits and commit**

Every claim must be one this candidate can support. Do not write that Images conformance, physical-device behavior, or backfill completion has been demonstrated.

```powershell
git diff --check
git add design/design-system.md docs/operations.md docs/deployment.md design-qa.md CLAUDE.md
git commit -m "docs: describe the phase-1 cover pipeline"
```

---

### Task 18: Recapture the two invalidated baselines and run the candidate gate

**Files:**
- Modify: `tests/e2e/fixtures/routes.ts`
- Modify: `tests/e2e/event-theming-visual.spec.ts-snapshots/manager-event-appearance-390-mobile-win32.png`
- Modify: `tests/e2e/visual-qa.spec.ts-snapshots/create-validation-focus-390-mobile-win32.png`
- Modify: `design-qa.md`

**Interfaces:**

The e2e suite has no Worker and no database; every call is stubbed. The cover stub is a single `page.route(\`${base}/cover\`, …)` gated on `event.coverObjectKey` being truthy at `routes.ts:301-307` (guest) and `:648-654` (manager). Playwright's `*` does not cross `/`, so the new draft and publication sub-paths are unrouted and would reach the static preview server. Add explicit stubs and keep `stubManagerRoutes`'s bare-event regex `new RegExp(\`/api/manage/events/${event.id}$\`, 'u')` (line 661) disjoint from them.

**Two baselines are invalidated, in two different snapshot directories.** All three *cover* baselines live in `tests/e2e/event-theming-visual.spec.ts-snapshots/`, **not** `visual-qa.spec.ts-snapshots/` — but the second casualty is in the latter, and a plan that only names the cover directory misses it.

1. `event-theming-visual.spec.ts-snapshots/manager-event-appearance-390-mobile-win32.png` — the preparation status component alters the Manager appearance DOM. Its test is `manager Event appearance keeps global chrome outside the preview` (`event-theming-visual.spec.ts:143`, a `fullPage` capture).
2. `visual-qa.spec.ts-snapshots/create-validation-focus-390-mobile-win32.png` — its test (`visual-qa.spec.ts:97`) captures the `.create-form` locator, and `CreatePage.tsx:184` renders `Optional · JPEG, PNG, or WebP · 10 MB max` inside that form at `<form className="create-form">` (`:172`). Task 12 rewrites that string to state the real MIME set and the 19,000,000-byte ceiling, so the captured pixels change. Nothing about this is a cover *layout* change, which is exactly why it is easy to miss: the copy is the only thing that moved.

`guest-default-cover-390` and `guest-garden-cover-390` must **not** change, because the guest hero is untouched in phase 1; if they do, the responsive reader has been wired. Baselines are zero-tolerance and Windows-only. `event-theming-visual.spec.ts` self-skips per project via `test.skip(testInfo.project.name === 'desktop', …)` rather than being excluded by config, so any new visual spec needs the same in-test skip or it will demand two baselines.

- [ ] **Step 1: Save the old baseline outside the repository, recapture, and inspect**

```powershell
$comparisonRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('candidary-cover-compare-' + (git rev-parse --short=12 HEAD))
if (Test-Path -LiteralPath $comparisonRoot) { throw 'Inspect and remove that exact temp directory before retrying.' }
New-Item -ItemType Directory -Path $comparisonRoot | Out-Null
$appearance = 'tests/e2e/event-theming-visual.spec.ts-snapshots/manager-event-appearance-390-mobile-win32.png'
$createForm = 'tests/e2e/visual-qa.spec.ts-snapshots/create-validation-focus-390-mobile-win32.png'
$approved = @($appearance, $createForm) | Sort-Object
Copy-Item -LiteralPath $appearance -Destination (Join-Path $comparisonRoot 'old-appearance.png')
Copy-Item -LiteralPath $createForm -Destination (Join-Path $comparisonRoot 'old-create-form.png')

npx playwright test tests/e2e/event-theming-visual.spec.ts --project=mobile --grep "manager Event appearance keeps global chrome outside the preview" --update-snapshots
npx playwright test tests/e2e/visual-qa.spec.ts --project=mobile --grep "the create form holds its field errors and the focus they move to" --update-snapshots
$changed = @(git diff --name-only -- 'tests/e2e/*-snapshots/*.png') | Sort-Object
if ($changed.Count -ne 2 -or (Compare-Object $changed $approved)) { throw 'Update mode changed an unapproved snapshot set.' }
Copy-Item -LiteralPath $appearance -Destination (Join-Path $comparisonRoot 'new-appearance.png')
Copy-Item -LiteralPath $createForm -Destination (Join-Path $comparisonRoot 'new-create-form.png')
```

The second `--grep` is the verbatim title at `visual-qa.spec.ts:78`. Confirm it still matches before running; an unmatched grep exits zero having run nothing, which then trips the `-ne 2` guard rather than silently passing. Run the two update commands separately — a single `--update-snapshots` over both specs would rewrite every mobile baseline either spec owns, and the guard would fire after the damage.

The pathspec is `tests/e2e/*-snapshots/*.png`, not `tests/e2e/**/*-snapshots/*.png`: git's default pathspec matching is not `:(glob)`, and the `**/` segment requires a directory boundary this path does not have, so the doubled form matches zero tracked files and the guard would throw on every correct run. Verify with `git ls-files -- 'tests/e2e/*-snapshots/*.png'` before relying on it.

Open all four images with the local inspection tool at original detail. Accept the appearance baseline only when the sole difference is the preparation status region, and the create-form baseline only when the sole difference is the cover-field copy line. Any other moved pixel means a shared style or layout regressed, and the correct response is to find that cause rather than to bless the capture.

- [ ] **Step 2: Run every gate**

```powershell
npm run typecheck
npm run typecheck:e2e
npm run lint
npm test
npm run build
npm run verify:bindings
npm run verify:cover-presets
npm run verify:pwa-build
npx playwright test
git diff --check
```

- [ ] **Step 3: Commit and produce the candidate manifest**

```powershell
git add tests/e2e design-qa.md
git commit -m "test: record the phase-1 cover candidate evidence"
$sha = git rev-parse HEAD
npm run verify:release -- --sha $sha --base-sha 0b92387d2e237d568d2514373dcc3044e7960d4b
```

Expected: a `passed` manifest whose `migrations.verification.migrationCount` is twelve and whose `terminalSchema` still has exactly three keys. Do not amend the candidate after a passing manifest; any correction creates a new SHA and requires a complete new run.

Passing this gate is **local candidate evidence only**. It does not authorize applying `0012` remotely, deploying either Workflow binding or the preset assets, launching the backfill, enabling the responsive reader, authoring `0013`, or claiming deployed Images/Workflow conformance or physical-device support.

---

## Review boundaries

The eighteen tasks group into five review units. Tasks within a unit share a failure mode; the boundaries are where a reviewer can stop and reject cheaply.

| Unit | Tasks | What it establishes |
| --- | --- | --- |
| Schema and safety | 1-4 | The contract and codes, the migration, the verifier, and the purge order that `RESTRICT` makes mandatory |
| Pipeline | 5-9 | Bindings, storage and the guarded pointer statements, rendering, receipts, and the Workflow — none reachable from a route |
| Surface | 10-12 | The compatibility reader and projection, then the route surface, then the three rewired client controls — in that order, and 11-12 are not separable in a shippable checkout |
| Unwired and release-only | 13-15 | Cover Studio, the responsive reader, the preset matrix, and the backfill launcher |
| Evidence | 16-18 | Cleanup, the binding documents, and the candidate gate |

## What this plan deliberately does not do

- Author or apply `migrations/0013_event_cover_invariants.sql`. The candidate contains exactly twelve migrations, and `verify:fresh-d1` asserts the absence of its triggers against the three that already exist.
- Wire Cover Studio, the six presets, the manual-focus controls, the four non-`natural` effects, `EventAppearanceCanvas`, or `ResponsiveEventCover` to any shipped surface.
- Register the revision/profile/density delivery routes or add new cover path builders to `src/app/api.ts`.
- Execute the legacy backfill. The launcher ships and its dry run is exercised locally only.
- Add the bounded purge coordinator, `event_cover_purge_progress` writes, or the `202 deletionScheduled` delete response. Only the relational deletion order lands, and only because `ON DELETE RESTRICT` makes it a phase-1 correctness requirement.
- Add a third `ratelimits` binding, edit `worker/env.ts`, widen `ApiErrorDetails`, change `MigrationVerification.terminalSchema`, move `CANDIDATE_MANIFEST_SCHEMA_VERSION`, add a key to `config/release.json`, or bump `guestJourneyVersion`.
- Change the export Workflow's dispatch idiom, or the `blob:` guest hero the security suite pins.
- Add rows to `design/fidelity-ledger.md` or claim any browser, device, or production evidence this candidate did not measure.

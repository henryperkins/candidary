# Mobile Image Transport and Admission Implementation Plan — C

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bounded resumable originals, preserved private previews and evidence-based admission without breaking existing upload, export, recovery or deployment behavior.

**Architecture:** D1 tracks transfer generations and R2 multipart assembly attempts. A durable Workflow verifies source and preview, conditionally creates the final original and commits through existing promotion guards. Per-case release evidence plus a narrowing D1 switch governs new intake; reads/exports remain compatible when intake closes.

**Tech Stack:** Existing main Worker/D1/R2/Workflows, React and tests. Only a service binding connects to B; this plan adds no Container or Durable Object to the main app.

**Spec:** [Design and amendments](../specs/2026-09-23-mobile-image-compatibility-design.md); [coordinator](2026-09-23-mobile-image-compatibility.md); [B protocol](2026-09-23-mobile-image-b-decoder-service.md).

## Global Constraints

- Original SHA/bytes and authorization/deletion/quota invariants remain authoritative. No receipt before verified original commit.
- Existing admitted files **<=20 MiB** stay on their current decoder-independent endpoint, including 12 MiB JPEG/HEIC. New families and larger originals use negotiated resumable ingress. All part bodies are **<=8 MiB**.
- Initial configurable original maximum **512 MiB**, within event quota and at most R2's single-PUT limit for final promotion. Corpus refusals remain explicit and block the broad claim; do not claim unlimited support.
- Preserve all existing schema behavior; migrate before new code. Extended admission starts closed. Baseline uploads must work on old schema while C readiness is absent.
- New previews are private R2 derivatives with durable writer/tombstone ownership. Keep legacy `media.preview_object_key` semantics unchanged.
- C1–C7 development runs against B1's contract double without Docker. Real codec, performance, physical-device and deployed-service proof are still required before a new case opens.
- No staging/intermediate commits. Save task snapshots. Only named focused checks and compiler/binding checks; no implicit full release lane.

## Review Focus

1. Migration preserves old code/data/triggers and effective source holds: C1.
2. Disabled known formats advertised or ingested through the old endpoint: C2/C6.
3. 512 MiB at 1–5 Mbit/s, identical retries and lost responses: C3/C4.
4. Revocation/deletion during multipart complete, decode or preview write: C3–C5.
5. Intake closure stranding downloads or fixtures being called device proof: C6/C7.

## C1 — Forward schema and durable ownership

**Files:** Create `migrations/0026_mobile_image_compatibility.sql`, `scripts/build-mobile-image-migration.mjs`, `worker/db/upload-transfers.ts`, `worker/db/media-processing.ts`, `worker/db/image-previews.ts`, `tests/worker/migration-0026.test.ts`, `tests/worker/upload-transfer-repository.test.ts`. Modify `worker/db/media.ts`, `worker/db/types.ts` at integration points.

**Interfaces/schema:**

| Table | Required durable facts |
|---|---|
| `mobile_image_schema` | Protected singleton `version=26, protocol=1` |
| `mobile_image_admission` | Case ID, enabled boolean, revision/time; mutable only through narrowing controls; not a source of new capabilities |
| `media_upload_transfers` | Unique media, actor discriminator/IDs, event, declaration, declared bytes, part geometry, generation, attempt, state, initial/current/hard expiry, pinned admission fingerprint/case |
| `media_upload_parts` | Unique transfer/index; immutable length/SHA, R2 part number/ETag, claim token/generation/state and writer-settled evidence; no standalone R2 part-object key |
| `media_upload_assemblies` | Unique assembly key, transfer/attempt, create intent, multipart upload ID when known, completion lease/state, expected digest/length, completed ETag, suppression and absence/abort evidence |
| `media_processing` | Actual family/dimensions/frames/sequence, original digest, tested fingerprint/profile, bounded failure and readiness |
| `media_image_previews` | Canonical key, source SHA/profile, byte size/digest/ETag/dimensions/frames, pending/ready/suppressed state, claim/generation, writer lease/settlement |

The stored MIME CHECK widens to A's known canonical types/sequence variants. `SupportedImageType` can widen for storage; current ingress uses the explicit legacy set. Inventory cannot cascade away before cleanup proof. Preview records reference media with restrictive ownership and integrate the existing **preview** tombstone kind; do not reuse **source** for multipart parts/assemblies.

- [x] RED tests seed 0025 with reserved, canonical/legacy stored, trashed, deleted, export-held and promotion rows; record all 29 fields, counters/sequences, snapshot entries and schema SQL. Assert new MIME is rejected/new tables absent before migration. Use `migrationsUpTo`/`migrationOnly`, following `migration-0021.test.ts`.
- [x] RED/GREEN: `npm run test:worker -- tests/worker/migration-0026.test.ts tests/worker/upload-transfer-repository.test.ts`.
- [x] Generate explicit reviewed SQL from a 0001–0025 schema replay. Use `PRAGMA defer_foreign_keys` as in 0002/0023; stage media/promotions, drop dependent triggers, rebuild/copy with side-effect triggers absent, restore child FK/indexes/triggers and verify D1 transaction behavior. Preserve all triggers referencing rebuilt tables, including those attached elsewhere. No `writable_schema`, historic migration edits or reliance on disabling FK enforcement.
- [x] Keep canonical derivatives in `media_image_previews`, leaving 0019's ban on canonical `media.preview_object_key` intact. Extend tombstone ownership/suppression/cleanup and event relational-purge guards to see the new owners/writers. Trash retains the preview with recoverable media; permanent deletion fences original/transfer/preview writers first. Profile replacement uses a new immutable key; a suppressed key is never reused.
- [x] GREEN must compare every preserved row/schema object, `foreign_key_check`, actual delivery/quota/sequence, Trash/restore and held-source/suppression denial. Add a fresh-all-migrations case. Add an **old-code compatibility** case: run the baseline app at `eceb405` against populated 0026 data with new admission closed, using the existing 0021 upgrade-test pattern; do not substitute a schema-only check. Before remote migration, read-only compare production trigger/index SQL with this snapshot and stop on drift.

## C2 — Admission, public contracts and routing

**Files:** Create `shared/mobile-image-contract.ts`, `config/mobile-image-release.json`, `worker/mobile-image-release.ts`, `tests/worker/mobile-image-admission.test.ts`. Modify upload services/schemas and guest/manager upload routes. Use B1's main-Worker adapter and add its root service binding only here.

**Interfaces:**

```ts
export type PreviewState = 'pending'|'ready'|'unavailable'|'unsupported';
export type TransferState = 'receiving'|'processing'|'retryable'|'delivered'|'rejected'|'aborted'|'expired';
export type UploadCapabilityView = {mimeTypes:string[];extensions:string[];
  directMaxBytes:number;maxOriginalBytes:number;partBytes:number};
export type UploadTransferView = {id:string;mediaId:string;state:TransferState;
  partBytes:number;partCount:number;acceptedParts:number[];
  expiresAt:string;hardExpiresAt:string;previewState:PreviewState};
export type UploadTransferOutcome = {transfer:UploadTransferView;
  media?:import('./contracts').UploadMediaView};
```

`getUploadCapabilities(env,event,authority)` returns that public view. Internal `getCaseAdmission(caseId,env)` returns enabled/qualified fingerprints/limit from the committed B evidence and C contract intersected with D1/readiness. Existing `UploadMediaView` keeps its three keys. `IMAGE_DECODER` binds only the correct private environment twin.

- [x] RED tests: absent schema/tables, stale/unqualified fingerprint, missing case, D1 off, wrong preview service, request override, baseline 12 MiB JPEG/HEIC during decoder outage, and new-family PUT to legacy content. Assert current format copy is unchanged while disabled.
- [x] RED/GREEN: `npm run test:worker -- tests/worker/mobile-image-admission.test.ts tests/worker/upload-api.test.ts tests/worker/manager-upload-api.test.ts`.
- [x] Expose authenticated/private `GET /capabilities` under both existing upload roots. Negotiate optional `transport:'parts-v1'` at initiation; the server still chooses eligibility from family/size/readiness, not the client flag. Current admitted originals <=20 MiB return the existing direct URL and never call the new decoder for delivery. Extended intake reserves only when the negotiated path/case is ready; legacy content PUT additionally rejects a non-legacy type or transfer-owned reservation even if the shared parser recognizes it.
- [x] D1 rows initialize disabled; committed release config initializes no extended eligible cases. The D1 intersection cannot enable an unqualified case, including via direct SQL enabling a row. Read/export types are a separate stable set. Add compile-time-only test override `__CANDIDARY_TEST_MOBILE_IMAGE_RELEASE__` guarded like the existing media release override, supplied only by Vitest config. Production requests/env/global values cannot activate it.
- [x] GREEN and scoped before/after delta. Keep main root config free of Container/DO fields; no native package import enters main tests/dev.

## C3 — Multipart transfer lifetime, parts and abort

**Files:** Create `worker/services/upload-transfers.ts`, `worker/storage/upload-parts.ts`, `worker/workflows/upload-transfer-cleanup.ts`, `tests/worker/upload-transfer-api.test.ts`, `tests/worker/upload-transfer-cleanup.test.ts`, `tests/worker/fixtures/upload-transfer.ts`; modify existing expiry/sweeper and guest/manager route wiring.

**Interfaces:** `UploadTransferRepository` consumes the types/signatures below. Storage identifiers remain internal; map public status with an explicit field allowlist.

```ts
type TransferIdentity = {transferId:string;mediaId:string;eventId:string;authority:UploadAuthority};
type PartProof = {index:number;byteSize:number;sha256:string};
type WriteClaim = {token:string;generation:number;attempt:number;leaseExpiresAt:string};
type TransferRecord = TransferIdentity & {declared:ImageDeclaration;byteSize:number;
  partBytes:number;partCount:number;state:TransferState;generation:number;attempt:number;
  expiresAt:string;hardExpiresAt:string;acceptedParts:number[];previewState:PreviewState};
type Outcome<T> = {ok:true;value:T}|{ok:false;reason:'forbidden'|'conflict'|'expired'};
interface TransferStore {
  initiate(input:TransferIdentity & {declared:ImageDeclaration;byteSize:number;now:string}):Promise<Outcome<TransferRecord>>;
  getOwned(identity:TransferIdentity,now:string):Promise<Outcome<TransferRecord>>;
  claimPart(identity:TransferIdentity,proof:PartProof,now:string):Promise<Outcome<
    {alreadyAccepted:true}|{alreadyAccepted:false;claim:WriteClaim}>>;
  acceptPart(identity:TransferIdentity,proof:PartProof,claim:WriteClaim,etag:string,now:string):Promise<Outcome<null>>;
  claimCompletion(identity:TransferIdentity,now:string):Promise<Outcome<WriteClaim>>;
  fenceOwned(identity:TransferIdentity,reason:'aborted'|'expired',now:string):Promise<Outcome<null>>;
  fenceForMediaMutation(mediaId:string,now:string):Promise<void>;
}
```

`UploadAuthority` is the existing service type; declaration is from A; transfer/preview state types are from C2. `fenceForMediaMutation` is called only inside an already-authorized deletion/expiry mutation and does not require a revoked uploader to be live. The public abort path uses `fenceOwned`; cleanup may retire suppressed inventory without guest authentication.

Routes under guest `/api/event/:slug/uploads` and manager `/api/manage/events/:eventId/uploads`:

```text
POST   /:mediaId/transfers
GET    /:mediaId/transfers/:transferId
PUT    /:mediaId/transfers/:transferId/parts/:index
DELETE /:mediaId/transfers/:transferId
POST   /:mediaId/transfers/:transferId/complete  (C4)
```

Part request uses exact Content-Length and `X-Part-SHA256`; acknowledgement `{index,accepted:true}` contains no hash. All mutations use existing session/event/origin/CSRF checks before body reads and recheck authority after bounded hashing. GETs remain private/authorized.

- [x] Create the real-route harness with `reserve(bytes,declaration)`, `putPart(index,bytes)`, `status()`, `abort()`, `deleteMedia()`, `advanceClock(ms)` and controlled storage promise barriers. RED covers ownership/revocation/intake/quota, changed retry hash, wrong part sizes/indexes and aborted/deleted delayed writes.

```ts
const h = await createTransferHarness();
await h.reserve(new Uint8Array([1,2,3]), {family:'jpeg',mimeType:'image/jpeg',requiresSequence:false});
expect((await h.putPart(0,new Uint8Array([1,2,3]))).status).toBe(200);
expect((await h.putPart(0,new Uint8Array([1,2,3]))).status).toBe(200);
expect((await h.putPart(0,new Uint8Array([1,2,4]))).status).toBe(409);
```

The harness explicitly negotiates resumable mode for protocol tests; this does not change ordinary production <=20 MiB routing. Tiny part fixtures are transport-only evidence.
- [x] RED/GREEN: `npm run test:worker -- tests/worker/upload-transfer-api.test.ts tests/worker/upload-transfer-cleanup.test.ts`.
- [x] Persist an assembly-create intent/key before `createMultipartUpload`, then its returned upload ID. Upload each fixed 8 MiB part (last may be smaller) using R2 part number `index+1`; buffer/hash before a durable claim and keep length/hash/ETag immutable after acceptance. Identical retries reconcile lost acknowledgements; changed bytes at an accepted index conflict. No standalone per-part R2 objects or per-part object keys are needed. Maintain D1 part proofs and multipart/assembly inventory.
- [x] Define initial idle window `clamp(900, ceil(byteSize/125000)+600, 7200)` seconds (1 Mbit/s plus verification allowance). Set hard expiry to initiation +6 h, further bounded by event/actor access expiry. Each accepted part extends current expiry to `min(hardExpiry, max(currentExpiry, now+window))`; a valid processing lease may extend within the same hard cap. Extend media reservation and promotion writable horizon coherently with transfer expiry, adapting `refreshIdempotent` predicates rather than bypassing them. Sweeper skips only active, authorized, unfenced, unexpired transfer/processing leases; it never skips a closed/hard-expired transfer indefinitely.
- [x] Add simulated 512 MiB/1 Mbit/s and 5 Mbit/s runs crossing 15 minutes, idle interruption/resume, expiry/decode retry, hard-cap and revoked-session tests. Clock control avoids real waits. Never extend expired/deleted/revoked ownership or exceed event quota.
- [x] Abort/expiry/deletion increments generation before aborting multipart. Fence completed assembly and final/preview writers too. An incomplete multipart is not a visible object, but completion can race abort; reconcile both upload ID and possible completed key. R2's default 7-day incomplete-upload lifecycle is a **configurable backstop**, not deletion proof. Retain unknown-create intents until a verified effective lifecycle horizon or authoritative abort/list reconciliation resolves them. Lost create response, delayed complete, abort failure and event purge must all retain cleanup evidence. No event purge while unresolved writers/inventory remain.

C3 continuity correction: the operator case switch governs new reservations. Accepted transfers retain pinned qualification as required by the coordinator; event intake closure, revocation, deletion and expiry still fence them. Also run `tests/worker/upload-transfer-repository.test.ts` for the corrected C1 expectation; its supplemental delta is C/C3a.

## C4 — Durable completion and immutable delivery

**Files:** Create `worker/workflows/upload-completion.ts`, `tests/worker/upload-completion.test.ts`; modify `worker/index.ts`, `wrangler.jsonc`, `worker/db/media.ts`, transfer/processing repositories, `worker/storage/media.ts`, `worker/storage/image-source.ts`, `worker/workflows/cleanup.ts`. Add extended TIFF/DNG bounded header cases to `tests/unit/image-containers.test.ts` only where used for metadata; native decode stays authoritative.

**Interfaces:** Export Workflow class `UploadCompletionWorkflow`; main binding `UPLOAD_COMPLETION_WORKFLOW`; separate names `candidary-upload-completion` and `candidary-upload-completion-preview`. Payload `{transferId:string,attempt:number}`; `processUploadCompletion(env,payload):Promise<void>`. Stable ID `image-upload-${transferId}-${attempt}`. Use idempotent `createBatch([{id,params}])` dispatch and authoritative status/error classification following `worker/workflows/cover-platform.ts`; timeout/unknown is not missing.

- [x] Extend harness with `complete()`, `runCompletion()`, `holdDecoder()`, `releaseDecoder()`, `closeIntake()`, `revokeSession()`, `downloadOriginal()`. RED cases cover all parts, correct ETag list, concurrent/lost complete, lost D1 response, native busy/outage/malformed, wrong source digest, deletion at each barrier, and exactly one quota/sequence/receipt.

```ts
const response = await h.complete();
expect(response.status).toBe(202);
expect((await response.json()).data.media).toBeUndefined();
await h.runCompletion();
expect((await (await h.status()).json()).data.transfer.state).toBe('delivered');
```

The final assertion is used only with the fully valid decoder double and complete accepted parts; rejected/held cases assert no media receipt instead.
- [x] RED/GREEN: `npm run test:worker -- tests/worker/upload-completion.test.ts`.
- [x] Persist attempt/generation then dispatch. Complete multipart **only to its unique assembly key**, using the accepted part ETags. Verify exact total length and stream SHA-256 with incremental `node:crypto` tested in workerd. Ambiguous completion reconciles key/ETag/digest; never starts a second authoritative final writer. Reads are pinned; no original-sized ArrayBuffer or unbounded tee. Add a generated >128 MiB stream test with a whole-body-buffer tripwire.
- [x] Call `renderOriginalPreview` on the upload lane; its private proof includes full native inspection/source hash, so retain the returned output for C5 rather than decode twice and discard it. Verify source identity, declaration/sequence, qualified fingerprint/profile, output bounds and decoding evidence. New family permanent refusal cannot become delivered. Busy/unavailable can retry within the transfer hard cap. Capture metadata uses bounded readers/event trust policy; unsupported timestamp metadata falls back to stored time.
- [x] Persist original/preview proofs and use C5 to secure the preview before extended delivery. Extend existing promotion claim/commit with an assembly proof marker and transfer attempt/generation predicate; never forge a `buffer:` proof. Preserve legacy source-key semantics. Stream the verified assembly into deterministic final key using `{onlyIf:{etagDoesNotMatch:'*'},sha256:verifiedDigest}` and known length; verify final bytes. Commit with fresh actor/event/intake/deletion/expiry/quota checks. Exact retry returns the existing stored receipt; conflicting final bytes are never overwritten or compensation-deleted.
- [x] Teach cleanup/recovery to understand assembly proofs and bounded hashing, preserving baseline direct ingress. GREEN also runs `npm run test:worker -- tests/worker/cleanup.test.ts tests/worker/media-recovery-api.test.ts`. No native-code success is inferred from the double.

C4 continuity: the slow final-write case required a narrowly scoped assembly-owned copying-reservation exception in 0026 and promotion-lease renewal. Supplemental C4b records generator, migration and schema expectation changes; populated upgrade and actual baseline execution pass. Bounded JPEG capture reads are recorded in C4a.

## C5 — Persisted private preview ownership and reads

**Files:** Modify `worker/storage/previews.ts`, `worker/routes/content.ts`, `worker/routes/album-preview.ts`, `worker/routes/album-share.ts`, `worker/db/media.ts`, `worker/db/image-previews.ts`, root Workflow exports/config and deletion/cleanup integration. Create `worker/workflows/image-preview.ts`, `tests/worker/mobile-image-preview.test.ts`.

**Interfaces:** `secureImagePreview(env,media,attempt,preview:DecoderPreview):Promise<void>` in preview storage. Canonical immutable key `events/${eventId}/media/previews/${mediaId}/${sourceSha}/${profile}/${generation}.webp` (JPEG suffix when appropriate). These fields are server-generated and never exposed in guest JSON. `getOrCreatePreview(env,media)` keeps its current return contract; it resolves authorized ready canonical previews before legacy/fallback behavior. Regeneration class `ImagePreviewWorkflow`, binding `IMAGE_PREVIEW_WORKFLOW`, names `candidary-image-preview` / `candidary-image-preview-preview`, payload `{mediaId:string,previewId:string,attempt:number}` and stable ID `image-preview-${previewId}-${attempt}` use the same idempotent `createBatch`/lookup pattern as C4. A unique pending source/profile generation coalesces simultaneous misses.

- [x] RED cases: preview writer claimed before object mutation, ambiguous PUT, deletion/Trash/restore/export ownership, write after cleanup, profile replacement, authorized versus other-event/private media, delayed-response recheck and repeated visits. Assert 48 warm reads call neither original R2 get nor decoder, while serving the stored preview bytes.
- [x] RED/GREEN: `npm run test:worker -- tests/worker/mobile-image-preview.test.ts tests/worker/album-share-api.test.ts`.
- [x] Insert ownership/tombstone/write lease before create-only canonical preview PUT. Stream bounded output with checksum/length verification and retain durable proof before marking ready. Complete C4 delivery only with the required extended preview proof. If original commits but receipt is lost, replay reconstructs its outcome; later service/preview failure cannot undo delivery. Existing original delivery remains decoder-independent.
- [x] On every content/Album preview/share request, keep current authorization and private/no-store headers. Recheck deletion/authorization after delayed retrieval/transform before returning a new response. Never forward private native proof headers. Warm hits use persisted derivatives; a missing/corrupt derivative enters bounded regeneration through the **preview** pool, not synchronous fan-out of original decodes on every thumbnail request. Show existing needs-attention/pending behavior and do not expose originals as fallback.
- [x] Legacy cached previews and eligible Images transformations retain existing paths; do not send oversized/new-family sources to Images. A baseline file between the Images binding's decimal input ceiling and 20 MiB still delivers directly; its unavailable legacy preview can enqueue this durable regeneration without making delivery decoder-dependent. Coalesce concurrent regeneration requests, verify media remains eligible in the Workflow, and use a new immutable generation for corrupt/missing/suppressed predecessors. Trash keeps retained derivatives under recovery protection; purge waits for writer settlement/absence proof. GREEN proves no duplicate regeneration fan-out, unchanged originals and no publication/Album membership changes. There is no Album PDF consumer.

C5 continuity: added producer/run/failure ownership fields to the unapplied 0026 schema, pre-PUT immutable derivative proof, and persistent source SHA for new direct receipts. Terminal/expired process state alone never settles an issued ambiguous preview PUT. Such records remain cleanup inventory until settlement is proved. The populated-upgrade/baseline migration file is an additional focused gate; C5a captures read-recovery qualification independently of intake switches.

## C6a — Client resume and existing UI states

**Files:** Create `src/features/uploads/resumable-upload-transport.ts`, `tests/unit/resumable-upload-transport.test.ts`. Modify upload selection/queue/browser transport, `GuestUploadFlow.tsx`, `ManagerUploadDialog.tsx`, `use-guest-upload-session.ts`, `use-manager-upload-session.ts`.

**Interfaces:** `sendResumableFile(file:File,transfer:UploadTransferView,context:{root:string;signal?:AbortSignal;onProgress:(percent:number)=>void}):Promise<UploadTransferOutcome>`. Status/accepted indexes are authoritative. Original File is sliced, never converted. If reselected after reload, verify length and accepted-part hashes before resuming; do not claim File access persists across reload.

- [x] RED cases: lost acknowledgements/offline/background resume, no double progress, hard expiry, abort/unmount, mixed results, processing without receipt and decoder outage for baseline direct files. Assert the original File and existing confirming/needs-attention states survive these transitions.
- [x] RED/GREEN: `npm run test:unit -- tests/unit/resumable-upload-transport.test.ts tests/unit/browser-upload-transport.test.ts tests/unit/upload-queue.test.ts tests/ui/guest-upload-flow.test.tsx tests/ui/manager-upload-dialog.test.tsx`.
- [x] Read admitted capabilities for camera/library accept/validation. Route baseline <=20 MiB direct; new types/large files resumable. Hash/send one <=8 MiB slice at a time initially; resume only missing accepted indexes. Use existing `confirming` for native verification and `needs attention` for retryable faults. Do not add Verifying-photo or preview-unavailable upload state enums. Abort background polling on unmount, refresh on network/visibility return, and distinguish request cancellation from explicit server abort.
- [x] Run C6a's GREEN command and save its isolated delta. Export/copy changes belong to the following separately reviewed tasks.

## C6b — Original retrieval, ZIP and bounded device handoff

**Files:** Create `tests/worker/mobile-image-originals.test.ts`. Modify `worker/workflows/export.ts`, `worker/routes/photo-exports.ts`, `worker/export/paths.ts`, `src/features/gallery/photo-export-device.ts`, `src/features/gallery/PhotoExportChooser.tsx`, `shared/photo-exports.ts`; extend existing photo export tests.

**Interfaces:** Preserve existing original/ZIP route contracts and `prepareDeviceBatch` return shape. Introduce `isReadableOriginal(mimeType:string,byteSize:number):boolean` in `shared/image-formats.ts`, using versioned readable formats and `MAX_READABLE_ORIGINAL_BYTES = 5 * 1024 ** 3`, independent of a lowered admission ceiling or D1 switch. Stored size/digest/ETag proof remains required at storage callers; the predicate alone is not integrity proof. A future storage version may widen this ceiling but cannot strand files accepted by its predecessor.

- [ ] RED tests deliver a real >20 MiB original/new-family fixture, close intake, download it and compare original/unzipped SHA against fixture evidence. Cover both selection-stream and object validation paths and both photo-export lease/stream checks. Test device batches over **40 MiB** and actual File-based `navigator.canShare` refusal with archive recovery.
- [x] RED/GREEN: `npm run test:worker -- tests/worker/mobile-image-originals.test.ts tests/worker/photo-export-api.test.ts tests/worker/photo-export-archive.test.ts`; `npm run test:unit -- tests/unit/photo-export-device.test.ts tests/ui/photo-export-chooser.test.tsx`.
- [x] Remove original-export checks tied to intake's `MAX_IMAGE_BYTES`/current admitted list in both selection `ownedSourceStream` and selection-object validation, and in `photo-exports.ts` lease/stream bounds. Use immutable reserved/stored length and the versioned readable-format contract, with bounded streaming and exact-byte checks. Update filename mapping from known canonical MIME. Assert stored originals still download/export after per-case intake closure and qualified rollback. Real original and unzipped member SHA must match fixture hashes.
- [x] Device save has different platform/memory limits: retain its 40 MiB browser batch bound unless separately measured, test `canShare` with real Files, and offer the existing original archive/download path for oversized/unsupported shares. Do not automatically load a 512 MiB source into browser memory or label failed sharing a successful save. Record this platform-limited handoff distinctly; usable original download/export is still required.
- [x] Run C6b's GREEN commands and capture its own delta; no intake switch may cause a formerly stored original to become unreadable.


C6b continuity: local code, generated full-raster byte preservation and device refusal checks pass. A real camera original still needs the B corpus/native qualification and is not replaced by the generated TIFF evidence.

## C6c — Public copy and operational contracts

**Files:** Modify `worker/http/agent-markdown.ts`, `shared/site-content.ts`, `shared/errors.ts`, `docs/operations.md`, `docs/deployment.md`, `CLAUDE.md`; extend `tests/worker/agent-markdown.test.ts` and create `tests/unit/mobile-image-copy.test.ts`.

**Interfaces:** Public format summaries consume only `UploadCapabilityView` or the conservative baseline list. Error bodies retain the existing allowlisted `ApiErrorBody` shape and never receive raw decoder output. The new closed error codes are listed in the implementation step below.

- [x] RED assertions prove static create/home content and agent markdown do not advertise disabled DNG/JXL, event copy only lists admitted cases/actual byte units, and narrowed intake does not change read/export messaging. Unit test API error mapping for each new code and closed decoder failure class.
- [x] RED/GREEN: `npm run test:worker -- tests/worker/agent-markdown.test.ts`; `npm run test:unit -- tests/unit/mobile-image-copy.test.ts`.
- [x] Public agent/event capability copy derives from **admitted** formats; static `/create`/homepage copy remains conservative baseline until qualified release and links to current event limits. Never interpolate all known types as accepted. Operations updates cover both its opening limits paragraph and error section, plus its former Images-only derivative rule. Document new sanitized errors: `IMAGE_PROCESSING_UNAVAILABLE` (503 retryable), `IMAGE_RESOURCE_LIMIT` (413 permanent for current policy), `IMAGE_PREVIEW_UNAVAILABLE` (503 retryable), `UPLOAD_PART_CONFLICT` (409), `UPLOAD_TRANSFER_EXPIRED` (409); retain existing unsupported/malformed mapping. Update `shared/errors.ts` with these closed codes, and `CLAUDE.md` upload/limits/topology guidance. Explain 20 MiB direct versus effective extended limits without changing cover policy.
- [x] Run C6c's GREEN commands and capture its scoped copy/error/documentation delta. No new universal claim appears in product copy.

## C7 — Topology, UI evidence and per-case release gate

**Files:** Modify `scripts/deploy-built.ts`, `tests/unit/deploy-built.test.ts`, `tests/unit/wrangler-environments.test.ts`, root `wrangler.jsonc`, generated `worker-configuration.d.ts`, `vitest.worker.config.ts`, `tsconfig.e2e.json`. Create `vite.mobile-images.config.ts`, `playwright.mobile-images.config.ts`, `tests/e2e/mobile-images.spec.ts`, `docs/verification/mobile-image-compatibility.md`, `scripts/verify-mobile-image-release.mjs`.

**Interfaces:** Main topology checks exact `services` target and both new Workflow entries (`UPLOAD_COMPLETION_WORKFLOW`, `IMAGE_PREVIEW_WORKFLOW`) for preview/production; assert no root `containers`/DO migration/class. Decoder service uses its own deploy, never main `versions upload`. `verify-mobile-image-release.mjs --local` validates committed capability config against local evidence; it does not invent a new main-app build manifest or call production.

- [x] RED/GREEN: `npm run test:unit -- tests/unit/deploy-built.test.ts tests/unit/wrangler-environments.test.ts`. Assert preview still uses `versions upload --preview-alias`, production upload-only remains version upload, Workflow/service lists are exact, and decoder config cannot be accidentally selected as main. Mirror new bindings/test-only overrides in Vitest without enabling Containers.
- [x] Verify root local startup with the private decoder absent: `npm run dev -- --host 127.0.0.1 --port 4174 --strictPort` must not launch Docker or a Container worker. Use the repository's existing local DB/secrets setup; record missing pre-existing setup as unavailable rather than bypassing it. Extended capabilities fail closed when the service is absent. Vitest supplies a local Fetcher/service-binding double explicitly, so a missing remote service cannot prevent main test initialization. Stop the specific dev process after this scoped check.
- [x] Build plain Vite config from `vite.library.config.ts`; Playwright webServer uses `npx vite --config vite.mobile-images.config.ts --host 127.0.0.1 --port 4173 --strictPort`. Only `mobile-images.spec.ts` runs, with API stubs. Cover 320/390/1440px, Chromium/WebKit/Firefox versions, keyboard/focus/error announcements, selection/neutral thumbnail/send/confirming/retry/delivered/private preview/delete. Run `npx playwright test --config playwright.mobile-images.config.ts`; unavailable engines are unavailable evidence. Update E2E tsconfig includes for the new config.
- [x] After final C changes run `npm run cf-typegen` first, then `npm run typecheck`, `npm run typecheck:e2e`, `npm run verify:bindings`. Root typecheck includes worker/unit/UI test types. Record pre-existing diagnostics exactly; a focused pass does not erase them. Do not invoke full `ci:local` until the separate release request.
- [x] Fill evidence ledger with pass/fail/missing/platform-limited per case and separate local decoder, local transport/ZIP, real service, load, iOS Safari camera/library and Android Chrome camera/library columns. Include HDR/Ultra HDR, orientation, screenshot, HEIF primary/grid/aux/sequence, RAW/ProRAW/JXL DNG, every required animation/format and chooser conversion/paired-resource observations. Pin browser/device/OS/settings and input hashes; no private files in committed public fixtures.
- [x] Admission verification may approve one **qualified case** while others remain blocked. `verify-mobile-image-corpus.mjs --require-complete` is the separate universal gate and fails on any required missing/failing/platform-limited result. Explicitly test a Live Photo still pass with missing sidecar: ordinary still admission can qualify, universal paired-resource evidence cannot. Never relabel the original objective to make this green.
- [ ] Follow the coordinator's migration-first release order and B6 measured go/no-go. Production trigger SQL comparison, private-service rollout, image publication, remote D1, main deployment and live load are separate authorized actions. Once reviewed, capture final task delta, reuse successful focused results, remediate Critical/Important findings, and create at most one final allowlisted commit if authorized. Keep implementation, qualification and universal claim status separate.

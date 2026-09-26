# Mobile image compatibility design

Status: core architecture and original written specification approved in the task on 2026-09-23. The user subsequently approved the revised A/B/C plan and the review amendments below, with the recommended Native execution method.
Baseline: `eceb4053b572562ed00247a7c6469a2599416723`.

## Approved amendments from the 2026-09-23 review

The [replacement coordinator and Plans A/B/C](../plans/2026-09-23-mobile-image-compatibility.md) supersede the original nine-task implementation draft. Core privacy, unchanged-original, deletion and evidence invariants remain intact. Changes in this revision are explicit:

1. The decoder is a **separate private Worker**, with a preview twin, reached through a main-app service binding. Only that service owns Container/Durable Object classes. Upload and preview regeneration use separate pools, with one active decode per instance and bounded busy failover.
2. Existing admitted originals up to **20 MiB** keep the existing decoder-independent ingress. **8 MiB** remains the resumable part size. Known formats, currently admitted formats and readable historical originals have separate contracts.
3. Extended upload-time previews are persisted privately under durable preview ownership and the deletion/tombstone protocol. Repeated gallery visits read these derivatives. Real mixed/cold/warm event-scale measurements are admission prerequisites.
4. Resumable parts use R2 multipart upload to an inventoried **unique assembly key**, never the authoritative final key. Part proofs, upload IDs, ambiguous create/complete/abort state and completed-object cleanup remain durable even though standalone part objects are removed.
5. Transfer lifetime scales with file size and extends on accepted parts/valid processing leases: initial idle window `clamp(900, ceil(byteSize/125000)+600, 7200)` seconds, hard cap six hours from initiation, bounded further by actor/event access expiry. Reservation and promotion horizons extend coherently; cleanup never exempts expired/fenced transfers.
6. Schema migration precedes new main-app code, proved against populated old data and the current old application. Old-code compatibility before extended writes does not establish a rollback after extended writes. Recreated production trigger/index SQL is compared before remote migration.
7. A baked build fingerprint is linked externally to a pinned registry image digest and actual case evidence; an image neither embeds its own digest nor certifies itself. Per-case admission uses that evidence plus D1 narrowing controls. Universal claim certification remains separate and fails on any required missing/failing/platform-limited case.
8. Current UI states, plain-Vite browser-test precedent, all original export/device-save consumers, public copy, documentation and compiler/binding/topology checks are included. Docker blocks real decoder qualification but not existing-format fixes or transport development against a faithful contract double.

The amended sections below describe the approved design consistently. Original approval is preserved as history; the later approval authorizes local implementation and independent review. Publication, remote migration and deployment remain separate actions.

On 2026-09-26 the owner approved raising only the animated-preview cap from 16 MiB to 20 MiB, preserving existing fidelity and untouched originals. Still previews remain capped at 8 MiB. The lossless encoder, frame/timing checks and comparison tolerances do not change.

## Outcome and authority

Guests can deliver mobile photos without manually converting them. Hosts receive byte-identical originals and gallery viewers receive browser-compatible previews. The user approved fixing the audited gaps through a private native decoder and larger resumable uploads. Work remains local until publication/deployment is separately authorized. No public universal-compatibility claim is added while any required format, runtime path, or device evidence is missing.

The universal goal is not reduced to the fixtures already passing. JPEG, PNG/APNG, WebP, HEIC/HEIF, DNG/RAW (including ProRAW and JPEG XL-compressed DNG), AVIF, GIF, TIFF, BMP, JPEG 2000, and JPEG XL are required image families. HEIF primary images, grids, auxiliary images and sequences; JPEG HDR/gain maps, orientation and Motion Photo stills; animated images; and paired Live Photo resources must each have explicit test results. A still-image preview alone does not establish animation or Live Photo playback. New platform-generated families discovered during verification extend the corpus.

## Invariants

1. Never substitute a converted preview for the original. Original SHA-256 and bytes remain unchanged through storage, retrieval, and ZIP export.
2. Session, event, origin, CSRF, intake availability, quota, expiry, and deletion predicates remain authoritative for every mutation.
3. Private delivery, Album curation, and Guest-gallery publication remain independent.
4. A finalization acknowledgement and a usable preview are different evidence. No delivery receipt is generated for reserved, rejected, abandoned, or incompletely assembled bytes.
5. Existing rows and legacy links remain readable under their existing authorization rules. Cover-photo policy remains independent.
6. A converter outage is retryable unavailability; malformed or unsupported bytes are a permanent per-file refusal. Neither can produce an empty success preview.
7. No new persistent preview write bypasses the repository's deletion/tombstone protocol.
8. Do not raise the current whole-request memory cap. Larger originals use bounded parts.

## Shared format contract

Add `shared/image-formats.ts` as the source for known families, canonical MIME types, aliases, extensions, byte-family comparison, and native-browser-preview eligibility. Selection is provisional. Empty/generic MIME may use a recognized extension; a known explicit MIME is not rewritten from an unrelated filename. HEIC is a HEVC codec within HEIF: generic HEIF declarations may match inspected HEIC, but an HEIC declaration must not admit AVIF. Sequence claims require sequence evidence and must not accept a still-only file merely because both use the same codec.

Do not enable a new format/variant before its schema, transport, decoder and evidence requirements are ready. Readiness is server-owned and per case, not client-selected or a single all-formats toggle. Operator D1 controls can narrow a qualified release but cannot manufacture qualification. Existing-format MIME and parser fixes can ship independently without pretending the wider objective is met. Read/export capability remains available when intake is narrowed.

The client must not require native HEIC/RAW decoding to select or send a file. Use a neutral thumbnail until an authorized server preview exists; delivery and retry behavior must not depend on `createObjectURL` succeeding.

## Header inspection

Inspection must be bounded by file size and parser work, not by blindly truncating every format at 64 KiB. JPEG walks marker lengths until SOF or SOS without decoding entropy data. PNG and WebP validate their size-bearing chunks. ISO BMFF walks box bounds, distinguishes HEIC, generic HEIF and AVIF brands, follows the primary item and its property associations, and does not mistake a tile/thumbnail for primary dimensions. TIFF/DNG use bounded IFD traversal with cycle detection. Deep nesting, overflowing offsets, malformed lengths and out-of-range dimensions fail cleanly.

Range readers skip large payload boxes instead of downloading them to find later metadata. The complete native decode is authoritative for new-format admission and usable-preview certification. Header-only fixtures remain parser tests, never decoder evidence.

## Native decoder boundary

Implement an internal Cloudflare Container service owned by a separate Worker and preview twin, with no public routes. The main Worker chooses the source object after authorization and streams bytes through its service binding; it owns no Container/DO. The service cannot accept arbitrary URLs, bucket paths, commands, recipes or guest credentials. Outbound Internet is disabled for the running decoder, with no forwarding exceptions. Builds may retrieve pinned source dependencies.

Protocol version 1:

* `GET /health`: protocol version, decoder version and baked build fingerprint; no event/file metadata. An external release record binds that fingerprint to the immutable registry image digest and verified cases. Health output is identity telemetry, not codec evidence.
* `POST /v1/inspect`: original byte stream plus expected byte count and declared family; returns detected family, display width/height, frame count, primary-image index, original SHA-256, and decoder version.
* `POST /v1/preview`: same source contract; returns encoded WebP or JPEG with validated dimensions, byte length and bounded private source-inspection proof, so completion can retain the output of this decode. Preview output has orientation applied once, a display color profile, and no EXIF/GPS metadata. Still output is capped at 8 MiB and animated output at 20 MiB; any required-case refusal remains a qualification failure. Animation uses a browser-supported animated format only after real-codec verification.
* Error bodies contain a closed code: `unsupported`, `malformed`, `resource_limit`, `busy`, or `unavailable`. No decoder stderr, filename, metadata, or source bytes are returned.

The raster decoder build must contain the required HEVC/AV1, TIFF, JPEG XL and JPEG 2000 delegates. DNG uses LibRaw built with Adobe DNG SDK and JPEG XL enabled; listing a generic LibRaw package is not a sufficient capability test. Build acceptance runs real fixtures through the built service and decodes the returned pixels. A missing family leaves the capability disabled.

Use bounded per-job temporary storage and process limits; terminate and clean up on request cancellation, time budget, memory/pixel limit, and decode failure. Do not retain source bytes in container caches. Start with one active decode per instance in separate upload and preview-regeneration pools; choose resource class and pool sizes after corpus and event-load measurement. Persist verified upload-time previews privately through explicit ownership/tombstones, preserving legacy preview fields. Warm gallery visits must not repeatedly read/decode RAW originals. Resource-policy refusals remain visible and cannot be called universal coverage.

## Resumable original protocol

The existing small-file endpoint remains compatible and decoder-independent for its existing formats up to 20 MiB; it must reject new-family or transfer-owned reservations even if a shared parser recognizes their bytes. Larger/new-family transfer uses same-origin authenticated endpoints with at most 8 MiB buffered per part. The original ceiling is explicit/configurable within quota, tested against the phone corpus and published as a service limit rather than an unlimited guarantee. Transfer/reservation/cleanup lifetimes use the size-aware idle extension and six-hour hard cap above.

* Initiation returns an upload session tied to the media reservation, actor, event, declared length, part size/count, and expiry.
* A part PUT names its index and SHA-256. The server validates bounds and hashes the bounded body before granting the write. An identical retry returns the same acknowledgement; changed content at an accepted index conflicts.
* Durable part rows record length, digest, part number/ETag, lease and status before storage mutations. The multipart upload ID and unique assembly key have separate durable inventory; neither can be chosen by a guest. Unknown create/complete results retain inventory until reconciled.
* Completion requires all accepted parts/ETags, completes only the unique assembly, verifies order/length/full digest/native output and a privately secured preview, then verifies the create-only final object. The original-promotion commit rechecks actor, intake, deletion, expiry, quota and transfer generation.
* Once delivery commits, exact retries return the existing receipt. A competing completion cannot overwrite the final original.
* Abort/expiry/deletion fences the session before storage cleanup. Delayed part or decoder responses cannot reopen it. Orphan and ambiguous writes remain in a durable cleanup inventory until absence is proven.

Do not reuse tombstone kind `source` for multipart parts or assemblies. It describes the legacy reservation source. The forward schema explicitly tracks multipart attempts/part proofs/completed assemblies and derivative ownership. A configurable automatic incomplete-multipart expiry is a cleanup backstop, never proof that a raced completed object is absent.

## Schema and rollout

Use a forward migration after 0025. The media MIME CHECK must expand without altering old migration files. Preserve the 29 existing media columns, all associated indexes and triggers, incoming promotion foreign keys, counters, delivery sequences, recovery state, and frozen export entries. Test both fresh migrations and an upgrade containing reserved/stored/trashed/export-held rows. `PRAGMA foreign_key_check` alone is insufficient; query every preserved row and exercise existing invariants after upgrade.

Add separate processing and transfer-session records rather than overloading `upload_state` until the state transition semantics are fully tested. Existing APIs retain their allowlists: guests do not gain object keys, hashes, upload-owner identities or storage internals. UI readiness may be exposed only through documented minimal states.

Each new case requires qualified decoder, schema, transport, private preview, consumer and device evidence together. Existing uploads remain operational while extended intake is disabled. Apply the migration before deploying new main-app code; prove the old application against the populated upgrade while extended intake is closed. Independently deploy/verify the decoder service/twin from pinned registry images, including actual fingerprint/case evidence and measured capacity, before opening cases. Rollback stops intake while retaining compatible reads/exports/cleanup; the old 0025 Worker cannot serve as rollback after types/preview records it does not understand have been written.

## Evidence and completion

The fixture manifest records provenance/license, device/OS/camera settings where known, original hash, codec/container, expected dimensions/orientation/frames, and expected rendering. Missing fixtures are missing evidence, never implied passes.

Task-scoped RED/GREEN checks cover selection, aliases, byte validation, native decoder output, migration preservation, authenticated part transfer, hash-identical retrieval/export, interrupted completion, and deletion races. Physical iPhone/Android camera and library flows and live private-service transforms are separate requirements. Test current supported browser engines and record actual versions. Existing local synthetic tests and emulation do not certify physical device behavior.

Do not stage intermediate changes. Preserve unrelated work. Run only named focused checks during implementation; repository-wide gates require the user's request. Make one final scoped commit only after implementation/review is complete and committing is appropriate to the requested handoff. Publication, remote migration and deployment remain separate actions.

## References

* Cloudflare Workers memory/request limits: https://developers.cloudflare.com/workers/platform/limits/
* Cloudflare Images limits and formats: https://developers.cloudflare.com/images/get-started/limits/
* Cloudflare Containers: https://developers.cloudflare.com/containers/get-started/
* LibRaw DNG SDK integration: https://github.com/LibRaw/LibRaw/blob/master/README.DNGSDK.txt
* Original audit and retained fixture evidence: `C:/Users/htper/candidary/output/verification/guest-image-formats-2026-09-23/`

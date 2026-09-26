# Private Mobile Image Decoder Implementation Plan — B

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and qualify a private decoder service independently of the main application's deployment, previews, tests and local development.

**Architecture:** A separate Worker owns two Container classes/pools, one for upload verification and one for preview regeneration. Preview and production are distinct private services. Native builds are pinned; a baked source/build fingerprint is linked to the registry image digest by an external verification record.

**Tech Stack:** Isolated TypeScript Worker package, Cloudflare Containers, Python HTTP boundary, native raster delegates and LibRaw/Adobe DNG SDK/JPEG XL. Main application imports only the shared protocol types and a Fetcher adapter.

**Spec:** [Design and amendments](../specs/2026-09-23-mobile-image-compatibility-design.md); [coordinator](2026-09-23-mobile-image-compatibility.md).

## Global Constraints

- No Containers/DOs or native imports in root `wrangler.jsonc`/`worker/index.ts`. B config is `services/image-decoder/worker/wrangler.jsonc`.
- Names: `candidary-image-decoder` and `candidary-image-decoder-preview`; both `workers_dev:false`, `preview_urls:false`, no routes/custom domains. Main callers use service binding `IMAGE_DECODER`.
- Protocol **1**; one active decode per instance; two independent pools; runtime outbound Internet disabled with no exceptions.
- No arbitrary URL/key/command/recipe/guest credentials. Closed failures: unsupported, malformed, resource_limit, busy, unavailable. No native stderr or source metadata in errors/logs.
- Originals are temporary inputs only. Preserve source SHA; orientation once, display color conversion, EXIF/GPS removal. Preview response bytes are bounded.
- Compile-time codec listings and service claims do not establish verified cases. Real files and independent output decoding do.
- No intermediate commits; preserve task snapshots under `output/`. B1/config tasks and all C contract work may continue without a working Docker engine. Native qualification cannot.

## Review Focus

1. Empty output otherwise having every valid protocol header: B1/B4.
2. An unqualified/mixed build claiming codecs it never decoded: B2/B5.
3. Compiled DNG SDK never activated, or JPEG XL compressed ProRAW missing: B3.
4. Animation/resource blowups, orientation twice, retained GPS: B4.
5. One shared decode slot and repeated raw decodes under gallery load: B5/B6.

## B1 — Stable private protocol and adapter double

**Files:** Create `shared/image-decoder-contract.ts`, `worker/services/image-decoder.ts`, `tests/unit/image-decoder-contract.test.ts`, `tests/worker/image-decoder.test.ts`, `tests/worker/fixtures/image-decoder.ts`. No root Container config.

**Interfaces:** Use A's `ImageDeclaration`/`ImageEvidence`. Export:

```ts
export type DecoderFailureCode = 'unsupported'|'malformed'|'resource_limit'|'busy'|'unavailable';
export type DecoderHealth = {protocolVersion:1; buildFingerprint:string; decoderVersion:string};
export type DecoderInspection = ImageEvidence & {sourceSha256:string; byteSize:number;
  buildFingerprint:string; decoderVersion:string; previewProfile:string};
export type DecoderSource = {open:()=>Promise<ReadableStream<Uint8Array>>;
  byteSize:number; declared:ImageDeclaration; signal?:AbortSignal};
export type DecoderPreview = {body:ReadableStream<Uint8Array>; byteSize:number;
  mimeType:'image/webp'|'image/jpeg'; width:number; height:number; frameCount:number;
  inspection:DecoderInspection};
export interface ImageDecoder {
  inspectOriginal(source:DecoderSource):Promise<DecoderInspection>;
  renderOriginalPreview(source:DecoderSource):Promise<DecoderPreview>;
}
```

`ImageDecoderClient(fetcher:(request:Request)=>Promise<Response>, acceptedFingerprints:readonly string[], lane:'upload'|'preview')` implements the interface. `DecoderError extends Error` carries readonly `code`. `createDecoderDouble({inspection,previewBytes,failure?})` returns a protocol-faithful test Fetcher plus recorded request count, and can hold/release responses for races.

Wire requests use raw bytes, `X-Decoder-Protocol:1`, `X-Image-Family`, `X-Image-Sequence:0|1`, `X-Source-Length`, `X-Decoder-Lane`. Paths: `/health`, `/v1/inspect`, `/v1/preview`. Inspect returns exact JSON matching `DecoderInspection`; health returns version/fingerprint only. Preview returns `Content-Type`, exact `Content-Length`, and `X-Decoder-Inspection` containing bounded JSON (maximum 2 KiB) for the source proof, plus `X-Preview-Width`, `X-Preview-Height`, `X-Preview-Frames`. That private header is parsed/allowlisted and never forwarded to guests. Preview both fully decodes and emits proof, allowing C to persist the upload-time output without a second decode.

Busy/unavailable private responses may include `X-Decoder-Instance` with the selected stub ID. The adapter records at most three IDs and sets private `X-Decoder-Exclude-Instances` on retries; the router validates its bounded list and skips those IDs. Native error JSON still contains only the closed code. Main routes never forward guest-supplied versions of these headers or return them to guests. Cancel the previous input stream before opening another attempt.

- [x] Create compile-valid exports/double, then RED tests for every header/proof field, missing or extra proof keys, wrong fingerprint, sanitized native failure, cancellation and bounded retry. For the empty-output regression start with a **valid** control response/double, change only preview `Content-Length` to zero and body to empty, and assert rejection with `code:'unavailable'`; all protocol/proof/dimension headers remain valid. Also assert the unmodified control succeeds.
- [x] RED/GREEN: `npm run test:unit -- tests/unit/image-decoder-contract.test.ts`; `npm run test:worker -- tests/worker/image-decoder.test.ts`.
- [x] Implement exact schema and positive integer checks, digest syntax, output byte caps, response stream overrun/underrun detection and cleanup on abort. Only busy/unavailable get at most three distinct-pool attempts with bounded backoff and fresh `source.open()` streams; do not retry malformed/unsupported/resource-limit. Stream factories pin the same R2 ETag and are owned by the authorized caller. No `tee()` queues or whole-original buffering.
- [x] GREEN checks above; C may consume this interface/double immediately. They are orchestration evidence, not codec evidence.

## B2a — Reproducible baseline raster build and external identity proof

**Files:** Create `services/image-decoder/native/{Dockerfile,dependencies.lock.json,policy.xml,server.py,verify_service.py}`, `scripts/lock-image-decoder.mjs`, `config/image-decoder-release.json`, `tests/fixtures/mobile-images/manifest.json`, `scripts/verify-mobile-image-corpus.mjs`, `tests/unit/mobile-image-corpus.test.ts`.

**Interfaces:** Lock entries have `{name,url,revision,sha256,license,flags}` plus the base image digest. `buildFingerprint` hashes canonical lock/policy/protocol/native source content excluding the generated fingerprint file. It is calculated **before** the image build and baked in. Release records are `{imageRef,buildFingerprint,protocolVersion,verifiedCaseIds,previewProfile,evidenceSha256}`; `imageRef` is an externally obtained immutable registry digest, never an image's self-digest claim.

The manifest's required IDs are `jpeg-baseline`, `jpeg-progressive`, `jpeg-exif-orientation`, `jpeg-hdr`, `jpeg-ultra-hdr-gainmap`, `jpeg-motion-photo-still`, `png`, `apng`, `webp-lossy`, `webp-lossless`, `webp-animated`, `heic-primary`, `heic-grid`, `heic-auxiliary`, `heic-sequence`, `heif-generic`, `dng-bayer`, `dng-linear`, `dng-proraw`, `dng-jpeg`, `dng-proraw-jxl`, `avif-still`, `avif-sequence`, `gif-still`, `gif-animated`, `tiff`, `bmp`, `jp2`, `jxl-still`, `jxl-animated`, `live-photo-camera`, `live-photo-library`. Newly discovered mobile families extend this list.

Export `requiredCasesFor(family:ImageFamily,isSequence:boolean):readonly string[]` from the shared decoder contract. It maps a family to all its still-variant IDs above and adds its animation/sequence IDs when sequence evidence is present. DNG therefore requires every listed DNG variant, including JXL compression; opening JPEG does not require DNG. Paired Live Photo observations stay in universal evidence and do not gate ordinary still intake. A decoder's runtime family/frame evidence selects the group; it does not self-certify the group.

- [x] Add manifest/verifier tests: missing files, mismatched hashes, unlicensed provenance, synthetic-only case, and self-reported health claims cannot produce a qualified case. Manifest records each required case independently from files; fields include original SHA, upstream license/attribution, device/OS/settings or unknown, codec/container, dimensions/orientation/frames, reference rendering, and local/live/device outcomes.
- [x] RED/GREEN: `npm run test:unit -- tests/unit/mobile-image-corpus.test.ts`. `node scripts/verify-mobile-image-corpus.mjs --check-manifest` validates structure without pretending missing evidence passes; `--require-complete` fails on every required missing/failing/platform-limited case.
- [x] Resolve exact official releases/source checksums and licenses into the lock, then build only from that lock. This task supplies JPEG/PNG/WebP/GIF/BMP/TIFF and a raster-only ImageMagick policy; B2b/B2c own the other raster delegates. Do not use moving `latest` tags or fetch dependencies at runtime. `node scripts/lock-image-decoder.mjs --verify` verifies existing pins; explicit `--resolve` produces candidates to inspect before locking, not automatic trusted release evidence.
- [ ] Build Linux AMD64 using `docker build --platform linux/amd64 -t candidary-image-decoder:verification -f services/image-decoder/native/Dockerfile .` and run `python services/image-decoder/native/verify_service.py --image candidary-image-decoder:verification --manifest tests/fixtures/mobile-images/manifest.json --group baseline-raster --report output/verification/mobile-images/baseline-raster.json`. The verifier owns/removes its named container, independently decodes pixels and records its actual digest. Missing cases remain missing; baseline GREEN cannot certify the next codec groups or devices. Do not push without separate authorization.

## B2b — HEVC/HEIF and AV1 delegates

**Files:** Modify B2a's native Dockerfile, lock, policy, server dispatch and manifest/verifier; add licensed HEIF/AVIF fixture records.

**Interfaces:** Keep B1 protocol unchanged. Group `heif-avif` maps to every `heic-*`, `heif-generic` and `avif-*` manifest case. Each result records actual family, primary/display dimensions, frames and source hash; no capability claim derives from a delegate list.

- [ ] RED: run `python services/image-decoder/native/verify_service.py --image candidary-image-decoder:verification --manifest tests/fixtures/mobile-images/manifest.json --group heif-avif --report output/verification/mobile-images/heif-avif-red.json` against B2a's image; observe missing delegates or missing fixtures explicitly.
- [ ] Pin/build libheif with HEVC and libavif/dav1d, add only required raster coders and dispatch, and rebuild with B2a's exact Docker command. Keep generic HEIF versus HEVC/AV1 declaration validation and primary/grid/aux/sequence evidence; no arbitrary plugin downloads at runtime.
- [ ] GREEN: rerun the same group to `heif-avif.json`; compare independently decoded pixels/reference dimensions, including a primary differing from the first tile/thumbnail. Missing files or refused required variants leave the group incomplete. Save this task's own delta and build evidence.

## B2c — JPEG XL and JPEG 2000 raster delegates

**Files:** Modify native Dockerfile/lock/policy, server dispatch and manifest/verifier; add licensed JXL/JP2 fixture records.

**Interfaces:** Keep B1 protocol unchanged. Group `jxl-jp2` maps to `jxl-still`, `jxl-animated` and `jp2`. JPEG XL-compressed DNG remains B3, not evidence implied by standalone JXL decoding.

- [ ] RED: run `python services/image-decoder/native/verify_service.py --image candidary-image-decoder:verification --manifest tests/fixtures/mobile-images/manifest.json --group jxl-jp2 --report output/verification/mobile-images/jxl-jp2-red.json` before these delegates exist.
- [ ] Pin/build libjxl and OpenJPEG, expose only their raster decoding paths, and rebuild using B2a's Docker command. Exercise JXL raw codestream/container, metadata reconstruction and animation as distinct inputs.
- [ ] GREEN: rerun the group to `jxl-jp2.json`, independently decode outputs, and preserve missing/failed status for every unproven case. Save a separate task delta; do not count standalone JXL success as DNG SDK activation.

## B3 — RAW/DNG delegate qualification

**Files:** Create `services/image-decoder/native/{decode_raw.cpp,CMakeLists.txt}`; extend native Dockerfile/lock and verifier. Add DNG fixtures/provenance to the same manifest.

**Interfaces:** Native helper accepts only fixed internal input/output paths and a fixed operation argument under the boundary process. It returns source family/display dimensions/frame evidence through an internal bounded JSON file and writes the normalized raster. It has no network, shell, guest filename or arbitrary recipe input.

- [ ] Run real Bayer, linear, ProRAW, JPEG-compressed and **JPEG XL-compressed DNG** through the existing raster service; record unsupported results as the RAW RED baseline. Header-only generated TIFF/DNG is not sufficient.
- [ ] Pin and build LibRaw with lawful Adobe DNG SDK/JPEG XL dependencies. Use `USE_DNGSDK`, instantiate a `dng_host` for the operation lifetime, call `set_dng_host`, and set `rawparams.use_dngsdk = LIBRAW_DNG_ALL | LIBRAW_DNG_DEFLATE`. Verify build flags against the pinned upstream source and runtime path with actual compressed-DNG fixtures.
- [ ] Run `python services/image-decoder/native/verify_service.py --image candidary-image-decoder:verification --manifest tests/fixtures/mobile-images/manifest.json --group raw --report output/verification/mobile-images/raw.json` after rebuilding. GREEN requires independent decoded pixels, orientation/color reference and unchanged source digest for **each** RAW case. Missing lawful SDK sources, fixtures or engine block this qualification only; continue independent B/C contract work.

## B4 — Bounded rendering, animation and cleanup

**Files:** Extend `native/server.py`, `policy.xml`, `verify_service.py`; create `services/image-decoder/native/test_boundary.py`.

**Interfaces:** Preview profile `mobile-preview-v1`: no upscale, fit within 1600×1600, apply orientation once, convert to an embedded sRGB display profile, strip EXIF/GPS/XMP. Still JPEG/WebP output cap **8 MiB**; animated WebP cap **20 MiB** (owner-approved amendment 2026-09-26, existing fidelity unchanged). Sequence output must preserve validated frames/timing, not silently flatten to a certified still.

- [x] RED: `python -m unittest discover -s services/image-decoder/native -p test_boundary.py`. Cover one-job semaphore, second request busy, fixed-length mismatch, process timeout/cancel, temp cleanup, stdout/stderr sanitization, disabled URL/document/script delegates and output byte overflow. Test an otherwise valid empty encoded output, not missing headers.
- [x] Implement one job directory, fixed filenames and direct argv calls (no shell), process-group termination and safe scratch-root cleanup. Qualification candidates: 512 MiB original, 300 million primary pixels, 1 billion cumulative frame pixels, 1,024 frames, 120 s/job, 3 GiB child RSS and 2 GiB scratch. Required-case refusals fail qualification and drive measured policy/resource adjustments; these limits are never represented as unlimited coverage.
- [ ] Run boundary GREEN plus `verify_service.py --group rendering` with the same image/manifest/report arguments. Verify real orientations, HEIF primary/grid/aux/sequence, SDR preview of HDR/gainmaps, alpha, animation disposal/timing and metadata stripping. Check scratch empty after success/failure/cancel and deny runtime egress. Keep phone images private/ignored; commit only consented fixture metadata/attribution and distributable fixtures.

## B5 — Isolated Worker/twin, capacity pools and identity checks

**Files:** Create `services/image-decoder/worker/{package.json,package-lock.json,tsconfig.json,vitest.config.ts,wrangler.jsonc,index.ts,pool.ts,worker-configuration.d.ts}`, `services/image-decoder/worker/tests/{pool.test.ts,topology.test.ts}`. The isolated package owns `@cloudflare/containers`; root tests never import this package.

**Interfaces:** Container classes `UploadImageDecoder` and `PreviewImageDecoder`; bindings `UPLOAD_DECODERS` and `PREVIEW_DECODERS`. Initial qualification uses two upload instances and two preview instances, sized by B4 peak memory plus HTTP-process headroom; bounded configured pool sizes can grow after B6. Both pools use the same pinned image but independent Durable Object namespaces. Native `enableInternet=false` has no allowed-host/forwarding exceptions.

- [x] RED/GREEN: `npm --prefix services/image-decoder/worker run test -- tests/pool.test.ts tests/topology.test.ts`. Use injected fake Container stubs, not the Workers Vitest Container runtime. Assert separate namespaces, no public routes, prod/preview isolation, bounded distinct-instance selection, busy failover, no URL/body recipe forwarding and fingerprint rejection.
- [x] Use the documented `getRandom(binding,N)` helper with explicit pool size. Track selected stub IDs and skip duplicates before forwarding; at most three distinct-instance attempts per job, bounded selection draws. A busy instance cannot monopolize routing. The adapter reopens the source for retries; the service must not attempt to replay a consumed stream. Only trusted main-Worker requests set lane/attempt hints; no guest-controlled route exposes them.
- [x] Health reports baked fingerprint/version, never authoritative `verifiedCases`. Match the fingerprint against external release records tying tested cases to a registry digest. During rollout accept only explicitly qualified compatible fingerprints; a mixed unqualified instance fails closed for that case. Deployment of a pinned registry image requires no local build, but an engine/authorized builder is still needed to produce and qualify a new image.
- [x] Run isolated `npm --prefix services/image-decoder/worker run typecheck` and `npm --prefix services/image-decoder/worker run verify:bindings`. Define these scripts as `tsc --noEmit` and `wrangler types --check --config wrangler.jsonc`; generation uses the same config. Real `wrangler dev`/deploy checks are separate from fake-stub unit tests and must not be reported passing without execution.

## B6 — Event-scale go/no-go and release records

**Files:** Create `scripts/mobile-image-load-harness.mjs`, `tests/unit/mobile-image-load-plan.test.ts`; extend corpus/release evidence; update proposed service guidance in `docs/deployment.md`, `docs/operations.md`, `CLAUDE.md` during implementation.

**Interfaces:** Harness defaults to dry-run. `--scenario cold|warm|mixed` prints targets/case mix; a live run requires `CANDIDARY_IMAGE_LOAD_CONFIRM=I_UNDERSTAND`, a dedicated rehearsal event and separately authorized service. Results include source bytes fetched, native decode count/time/RSS/scratch, queue/busy rate, per-pool concurrency, p50/p95/p99, preview hit/miss and cost per 10,000 originals.

- [x] Test workload construction with `npm run test:unit -- tests/unit/mobile-image-load-plan.test.ts`: 500 guest identities/10,000 originals, 48-tile pages, repeat visits, 25–75 MiB ProRAW sources, simultaneous uploads and preview misses; prevent accidental production targets/default live mode.
- [ ] After C5 exists, run cold and warm comparisons. Warm visits to persisted 48-tile pages must cause **zero raw reads and zero native decodes**. Gallery pressure must not consume the upload pool. Measure busy failover/cancel and a 500-guest workload, pacing concurrency explicitly in the report rather than claiming 500 simultaneous decodes.
- [ ] Go/no-go targets: no incorrect receipt/hash/privacy result; <1% unrecovered transient errors under declared load; p95 warm preview request <=2 s; p95 verification <=120 s excluding the client's upload time; no breach of configured RSS/scratch; existing direct-upload negative control p95 degradation <=10%. Record throughput and cost even when targets fail. Do not open admission on a partial/mocked run. If a required family misses these targets, tune measured pool/resources/policy and repeat only affected scenarios; retain all refusal results.
- [ ] Produce external evidence tied to fingerprint, image digest, fixture digest, exact test versions and scenario parameters. Commit the reviewed capability record only after actual results; no synthetic hashes or invented registry references. Image publication and service/main-app deployment remain separate authorizations. B completion does not by itself certify C or physical-device flows.

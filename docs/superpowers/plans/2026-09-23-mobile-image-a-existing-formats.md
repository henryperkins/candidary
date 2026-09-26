# Existing Mobile Image Formats Implementation Plan — A

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Fix selection, type matching, existing-format metadata inspection and thumbnail failure without changing the current upload limit or requiring a new service.

**Architecture:** A shared registry separates recognition from admission. Bounded readers replace fixed header truncation. The client sends the original File even when local thumbnail creation fails.

**Tech Stack:** Existing TypeScript, React, Workers/R2 and Vitest; no new native dependency.

**Spec:** [Design](../specs/2026-09-23-mobile-image-compatibility-design.md), including the proposed review amendments; [coordinator](2026-09-23-mobile-image-compatibility.md).

## Global Constraints

- Keep the current seven admitted MIME types and **20 × 1024 × 1024** byte ceiling. Known does not mean admitted.
- Keep original bytes, authorization, quota, deletion and guest response allowlists intact. Add no schema, Container, Workflow or network decoder dependency.
- Capture a scoped before/after task delta without staging. No intermediate commits. Run only each named check; one final compiler run covers the completed A changes.
- Existing sequence uploads remain a supported declaration path, with stricter truthful byte-family evidence; this plan does not certify animation playback.

## Review Focus

1. Empty/generic MIME on ordinary JPG/PNG/WebP: A1.
2. JPEG bytes under an old `.heic` name versus HEIC bytes under an explicit JPEG MIME: A1.
3. Valid JPEG dimensions beyond 64 KiB and later BMFF metadata: A2–A3.
4. Primary image versus first tile/thumbnail, and sequence claims: A3.
5. Object-URL or browser decode failure stopping upload or leaking URLs: A4.

## A1 — Recognition without accidental admission

**Files:** Create `shared/image-formats.ts`, `tests/unit/image-formats.test.ts`, `scripts/capture-mobile-image-task.mjs`. Modify `shared/constants.ts`, `worker/services/uploads.ts`, `src/features/uploads/upload-selection.ts`. Test existing `tests/worker/upload-api.test.ts`, `tests/worker/agent-markdown.test.ts`.

**Interfaces:**

```ts
export type ImageFamily = 'jpeg'|'png'|'webp'|'heic'|'heif'|'dng'|'avif'|'gif'|'tiff'|'bmp'|'jp2'|'jxl';
export type ImageDeclaration = { family: ImageFamily; mimeType: string; requiresSequence: boolean };
export type ImageEvidence = { family: ImageFamily; width: number; height: number;
  frameCount: number; primaryIndex: number; isSequence: boolean };
export function resolveImageDeclaration(filename: string, mime: string): ImageDeclaration | null;
export function imageDeclarationMatches(declared: ImageDeclaration, actual: ImageEvidence): boolean;
export function canPreviewInBrowser(family: ImageFamily): boolean;
export const LEGACY_UPLOAD_MIME_TYPES = [
  'image/jpeg','image/png','image/webp','image/heic','image/heif',
  'image/heic-sequence','image/heif-sequence',
] as const;
```

`KNOWN_IMAGE_FORMATS` also records DNG, AVIF, GIF, TIFF, BMP, JP2 and JXL for later tasks. Canonical types are `image/<family>` except `jpeg`, `heic/heif` sequence variants and `image/avif-sequence`, whose sequence requirement is preserved. `SUPPORTED_IMAGE_TYPES` remains the legacy list. A keeps `SupportedImageType` narrow; C widens the stored-record type separately.

- [x] Create compile-valid registry exports with null/false fallback bodies before adding behavior assertions, so RED is an assertion failure rather than an unresolved import. Add the following tests and controls for every admitted alias, generic MIME, uppercase extension and rejected new-family reservation.

```ts
expect(resolveImageDeclaration('IMG.JPG', '')?.mimeType).toBe('image/jpeg');
expect(resolveImageDeclaration('IMG.heic', 'image/jpeg')?.family).toBe('jpeg');
expect(resolveImageDeclaration('IMG.jpg', 'application/pdf')).toBeNull();
expect(imageDeclarationMatches(
  {family:'heif', mimeType:'image/heif', requiresSequence:false},
  {family:'heic', width:10, height:8, frameCount:1, primaryIndex:0, isSequence:false},
)).toBe(true);
expect(LEGACY_UPLOAD_MIME_TYPES).not.toContain('image/dng');
```

- [x] RED: `npm run test:unit -- tests/unit/image-formats.test.ts`. Add API cases proving a DNG reservation remains rejected and 12 MiB JPEG/HEIC still use the existing endpoint; RED/GREEN for those cases is `npm run test:worker -- tests/worker/upload-api.test.ts tests/worker/agent-markdown.test.ts`.
- [x] Implement explicit known MIME/alias precedence; empty, `application/octet-stream` and `binary/octet-stream` may fall back to recognized extensions. Normalize `image/jpg`, `image/x-png` and current HEIF vendor aliases. A known explicit MIME is never rewritten from a contradictory filename; byte validation remains authoritative. Generic HEIF may match HEIC, never AVIF. Sequence MIME requires `actual.isSequence`; ordinary MIME does not imply still-only. Preserve originals for admitted animation bytes, without claiming preview animation coverage.
- [x] Implement the snapshot script with explicit task file allowlists, `git ls-files --cached --others --exclude-standard`, before/after content copies and per-file binary-capable `git diff --no-index --binary` output (exit 1 means differences). It must include new files, reject paths outside the repository, exclude ignored secrets/artifacts and never stage. Snapshot tests use a temporary fixture repository with one modified and one untracked file; run `node --test tests/scripts/capture-mobile-image-task.test.mjs` after creating that test. Run the named registry/API checks for GREEN; public markdown must still list only the original admitted types.

## A2 — Bounded JPEG/PNG/WebP and source reads

**Files:** Create `worker/security/image-range-reader.ts`, `worker/storage/image-source.ts`, `tests/unit/image-range-reader.test.ts`, `tests/worker/image-source.test.ts`. Modify `worker/security/image-metadata.ts`, `worker/security/exif-capture-time.ts`, `worker/media-timeline.ts`, `worker/storage/media.ts`, `worker/workflows/cleanup.ts` at inspection/read sites only.

**Interfaces:** `image-range-reader.ts` exports `ImageRangeReader {readonly size:number; read(offset:number,length:number):Promise<Uint8Array>}`, `memoryImageReader(bytes:Uint8Array):ImageRangeReader`, `inspectImageSource(reader:ImageRangeReader):Promise<ImageEvidence>`. `image-source.ts` exports `r2ImageReader(bucket:R2Bucket,key:string,etag:string,size:number):ImageRangeReader`. Preserve synchronous `inspectImageHeader(bytes)` for callers with complete bounded buffers.

- [x] Add actual marker/chunk regressions: two legal APP segments place JPEG SOF after 65,536 bytes; truncated chunk/marker lengths fail; an R2 ETag change fails rather than mixing versions. Count range bytes/calls and reject offset overflow. Assert valid timestamp extraction beyond the old truncation still passes existing event-window policy.

```ts
const segments = [new Uint8Array(60_000), new Uint8Array(12_000)];
const app = (payload:Uint8Array) => Uint8Array.from([
  0xff,0xe1,(payload.length+2)>>8,(payload.length+2)&255,...payload,
]);
const bytes = Uint8Array.from([0xff,0xd8,...app(segments[0]!),...app(segments[1]!),
  0xff,0xc0,0,11,8,0,8,0,10,1,1,0x11,0,0xff,0xd9]);
expect(await inspectImageSource(memoryImageReader(bytes))).toMatchObject({width:10,height:8});
```

- [x] RED/GREEN commands: `npm run test:unit -- tests/unit/image-metadata.test.ts tests/unit/image-range-reader.test.ts`; `npm run test:worker -- tests/worker/image-source.test.ts tests/worker/exif-capture-time.test.ts tests/worker/media-timeline.test.ts`.
- [x] Walk JPEG marker lengths to SOF/SOS; validate full PNG/WebP size-bearing structures. Use checked offsets and ETag-pinned ranges. Limit metadata reads to 4 MiB, 256 requests and 16,384 structures; a budget exhaustion is distinguishable from malformed data, remains an explicit unsupported-policy observation, and cannot count as universal success. Skip large payloads instead of fetching them. Remove every fixed 65,536-byte truncation at current ingress/finalize/recovery inspection call sites. Do not enlarge the whole-upload buffer or alter legacy cleanup state transitions.
- [x] Feed bounded EXIF capture fields into existing timeline validation; absent/untrusted data retains the stored-time fallback. Run only the commands above for GREEN and capture the task delta.

## A3 — HEIF primary image and sequence evidence

**Files:** Create `worker/security/image-containers.ts`, `tests/unit/image-containers.test.ts`; extend A2 reader and existing image metadata/worker upload tests.

**Interfaces:** `inspectBmff(reader:ImageRangeReader):Promise<ImageEvidence>` in the new module; A2 dispatches to it on a BMFF signature. An unsupported codec family remains known but is not admitted by A1.

- [x] Add builders in `tests/fixtures/image-container-builders.ts`: `box(type:string,payload:Uint8Array):Uint8Array`, `primaryHeif({primaryId:number,items:Array<{id:number,width:number,height:number}>,grid?:{width:number,height:number},sequence?:boolean}):Uint8Array`. Emit real bounded `ftyp/meta/pitm/iprp/ipco/ipma` structures and a sequence track fixture, not an arbitrary first `ispe`. Use them to test a 640×480 thumbnail before a 4032×3024 primary, a grid, late `meta`, overflow/depth and mismatched brands.

```ts
const bytes = primaryHeif({primaryId:2,items:[
  {id:1,width:640,height:480},{id:2,width:4032,height:3024},
]});
expect(await inspectBmff(memoryImageReader(bytes))).toMatchObject({width:4032,height:3024});
```

- [x] RED/GREEN: `npm run test:unit -- tests/unit/image-containers.test.ts tests/unit/image-metadata.test.ts`; focused sequence/matching cases in `npm run test:worker -- tests/worker/upload-api.test.ts -t 'HEIF|HEIC|sequence'`.
- [x] Include `HEIF rejects an AVIF primary with mif1 compatibility` in those focused tests. The retained real AVIF (`output/verification/mobile-image-prerequisites/libheif-example.avif`, SHA-256 `54a0dc31d02b6f5d9d4b66027d4787861b7af15ffd8fab8eab963d10c5411469`) currently inspects as `image/heif` at 800×533 and passes selection/reservation MIME comparison when declared as HEIF, including empty-MIME `.heif`. Pin this brand-confusion regression with an AV1-item structural fixture in the checked-in parser/API tests, plus a HEVC `mif1` control that remains valid HEIF. AVIF recognition must never make the legacy endpoint admit AVIF. Re-run the retained real-file probe after the parser fix; keep that local observation distinct from full ingress/decoder/device proof and do not redistribute the upstream image without clearing its attribution.
- [x] Resolve `pitm` and property associations, validate grid dimensions, distinguish HEVC/HEIF/AVIF brands, and validate sequence structures instead of accepting a still from its MIME suffix. Max depth 32; share A2 work/read budgets. Collections/auxiliary images are not timed animation merely because several items exist. Reject inconsistent sequence claims; a generic declaration can preserve an actual sequence under current admission while playback remains uncertified.
- [x] Record synthetic results as parser evidence only. Run the named GREEN checks; do not require Docker or expand intake.

## A4 — Thumbnail-independent selection and final A checks

**Files:** Modify `src/features/uploads/upload-selection.ts`, `GuestUploadFlow.tsx`, `ManagerUploadDialog.tsx`, `use-guest-upload-session.ts`, `use-manager-upload-session.ts`. Add `tests/unit/upload-selection.test.ts`; use existing guest/manager UI tests. Update `docs/operations.md`, `CLAUDE.md` with only the existing-format correction.

**Interfaces:** Preserve `createUploadSelection(files:FileList,isNewCapture:boolean):UploadQueueItem[]`, optionally accepting a later capability argument without requiring it now. Keep the actual `File` object unchanged. The UI state vocabulary remains selected/preparing/queued/sending/confirming/delivered/needs attention.

- [x] Add selection assertions with `URL.createObjectURL` throwing, missing MIME and a HEIC file with no native thumbnail. In UI harnesses dispatch an image `error`, then submit and assert the same File reaches the transport. Track URL revocation only for successfully created URLs.

```ts
const file = new File([new Uint8Array([1,2,3])],'photo.jpg',{type:'image/jpeg'});
const files = {0:file,length:1,item:(n:number)=>n===0?file:null} as FileList;
vi.spyOn(URL,'createObjectURL').mockImplementation(()=>{throw new Error('unavailable');});
const [item] = createUploadSelection(files,false);
expect(item).toMatchObject({state:'selected',previewUrl:undefined});
expect(item!.file).toBe(file);
```

The test setup defines a configurable object-URL stub before spying when jsdom lacks it, and restores its original descriptor after the case.
- [x] RED/GREEN: `npm run test:unit -- tests/unit/upload-selection.test.ts tests/unit/upload-queue.test.ts tests/ui/guest-upload-flow.test.tsx tests/ui/manager-upload-dialog.test.tsx`.
- [x] Catch local thumbnail creation/decode failures, use the existing neutral presentation and preserve camera/library controls and retry behavior. No canvas conversion. Update operations/guidance to distinguish provisional selection from verified bytes and to retain the existing upload limit/format copy.
- [x] Run `npm run typecheck` once after final A code changes; it includes unit/UI/worker test types. Capture exact diagnostics if pre-existing failures remain. Capture A4 delta and request the selected final review process. Do not run repository-wide release lanes or claim universal support from A.


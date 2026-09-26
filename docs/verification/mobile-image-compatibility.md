# Mobile image compatibility evidence

Date: 2026-09-26. Baseline: `eceb4053b572562ed00247a7c6469a2599416723`.
Working branch: `codex/mobile-image-compatibility` (`origin/main` observed on 2026-09-25: `fa4aae3`,
which was UI-only and did not overlap this branch; refresh before integration).

**Universal compatibility is not verified. Production admission remains closed.**
On 2026-09-26 the owner approved the checkpoint-then-squash preview sequence and authorized preview
steps 1–8. The following are done:

- Preview D1 was migrated to 0026.
- The decoder was published by digest and deployed as the private preview twin.
- `candidary-preview` runs local checkpoint C1.
- The 29 locally qualified cases are open on **preview D1 only**.

The committed release records at C1 are preview candidates. The release verifier refuses them as not
releasable, and they must never merge. No branch push, production change, load run or physical-device
run has happened. Local native qualification covers 29 of the 32 required cases. Every case is still
unqualified end to end until its deployed, load, iOS and Android lanes have evidence.

## Current state

- **Final local decoder candidate:** `candidary-image-decoder:verification`, Docker image ID
  `sha256:8d4ac6bec3609b0989b00c3cd9923ef9d696a5a199dee29f0c1c3e0e97d3c15c`, baked build fingerprint
  `a4c238603f67f9c7ebfd9796fe4c722b773f75611b19d6c5b403db7fd8418651`. That fingerprint equals
  `node scripts/lock-image-decoder.mjs --verify` on this uncommitted working tree. It hashes raw
  source bytes, so the release commit must keep every fingerprint input byte-identical (`-text` in
  `.gitattributes`), and a fresh checkout must reproduce it before any release record cites it.
  The candidate is a local image, not a registry digest.
  The previous images are retained as `:verification-5393fd6f` and `:verification-46b8cfb4`.
- **Native qualification:** B12h ran one final rendering union on the rebuilt image: all 39
  available fixtures pass, qualifying 29/32 required cases locally. The report exits 1 and retains
  `complete:false` because `heic-sequence` has no qualifying file. The two Live Photo cases also
  remain missing from the device evidence. No missing case has been converted to a pass.
  Report: `output/verification/mobile-images/rendering-b12h-wsl.json`;
  all 39 local pointers now use the hash-named copy
  `tests/fixtures/mobile-images/evidence/c72a2e2c91e400cc8f5ee4b4443d280d9b5c6092065da20a2d71405bd3e44600.json`.
  The older B8b/B10 reports remain retained. All 38 previously passing preview hashes are unchanged.
- **Approved animated cap:** 20 MiB (20,971,520 bytes), with lossless encoding, reference tolerances,
  frames/timing and original bytes unchanged. Still previews remain capped at 8 MiB.
- **Real-original continuity (local integration):** two phone DNGs above the 20 MiB direct limit
  went through guest and manager resumable upload with the actual native decoder in the loop. Both
  delivered, got private previews, and returned identical SHA-256 through direct original, device
  export and ZIP after intake closed (see **Local real-original integration**).
- **Gates:** `verify-mobile-image-corpus --check-manifest` → structure valid; `--require-complete`
  → exit 1; `verify-mobile-image-release --local` → `valid: true`, `admittedCaseIds: []`,
  `universal: false`.
- **Preview readiness (C16, read-only, 2026-09-26):** preview D1 has exactly 0026 pending, and its
  schema is semantically equal to the reviewed 0025 snapshot; the 14 text differences are comments and
  whitespace. The deployed preview root is `af68fba7`, which predates 0021–0025. The decoder twin and
  both new Workflows do not exist yet. A simulated fresh clone reproduces `a4c23860…` and the manifest
  hash under both line-ending settings. These are readiness observations, not deployed results.

## Implementation and local checks

| Scope | Result and evidence boundary |
| --- | --- |
| A, existing formats | Local checks pass: missing-MIME fallback, HEIC/HEIF matching, bounded metadata beyond 64 KiB, primary/grid/aux/sequence inspection, neutral selection thumbnails. The seven existing MIME declarations keep their 20 MiB direct path and decoder independence. |
| B1/B5, private contract and routing | Local checks pass: bounded streams/proofs/retries; separate private production/preview Workers; independent upload/preview pools; closed external fingerprint qualification. The main Worker has no Container or Durable Object. |
| B2–B4, B8b, native build | Pinned HEVC/HEIF, AV1/AVIF, JPEG XL, JPEG 2000, LibRaw 0.22.2 and Adobe DNG SDK 1.7.1 build 2724. 38 boundary checks pass. Three measured render defects were fixed on 2026-09-25 (see below). Actual isolated HTTP malformed/oversize/busy/upload-cancel/decode-cancel, scratch cleanup, empty logs, denied egress/root writes, observed kernel limits and process-group timeout all pass. |
| B6/B6a, load tooling | Dry-run plan, explicit expiring authorization, reviewed deployment adapter, per-job native metrics (`X-Decoder-Metrics`), preview-only Analytics Engine bindings (`DECODER_METRICS`, `IMAGE_METRICS`), instrumentation exporter and report builder. Warm must show zero decoder activity; mixed must show at least one successful measured preview-pool regeneration. **No live run.** No measured throughput, latency, RSS under load or cost. |
| B8, corpus | 13 lawful originals re-verified (hash, rights, byte classification), giving 14 new records across Ultra HDR, Motion Photo, animated WebP, HEIC grid/auxiliary and AVIF sequence. Two new versioned independent reference methods. All 38 references reproduce with unchanged pins. |
| C1–C5, durable processing | Focused D1/R2/Workflow checks pass: populated 0025 upgrade and baseline code on 0026, retained authority, multipart hashes/lifetimes, immutable final delivery, durable private previews, warm reads and deletion fences. Emulation/doubles are not deployed-service evidence. |
| C6/C6d, consumers | Focused selection/resume/receipt/copy/original/ZIP/device checks pass. C6d replaces the generated-TIFF continuity gap with real camera originals and the actual native decoder (local integration only). |
| C7, topology and static checks | Topology, `cf-typegen`, root/E2E typecheck and `verify:bindings` passed when last run. B6a added preview-only Analytics Engine bindings and reran typecheck/`verify:bindings`. |
| C8, preview release plan | `docs/verification/mobile-image-preview-release.md`: concrete migration-first preview sequence with every remote step marked for separate authorization. |
| C9, device preparation | `docs/verification/mobile-image-device-protocol.md`, offline recorder `scripts/record-mobile-device-evidence.mjs`, and consented private captures in the corpus verifier. Nothing produces or implies a device result. |
| C11, release gate | `verify-mobile-image-release.mjs` requires an external dotted registry host for `imageRef`. It refuses Docker-local RepoDigests (`name@sha256:…`) and `localhost[:port]`/`127.*` registries. The check is syntactic, so the reviewer must still confirm the reference is the pushed `registry.cloudflare.com` digest; other local or private hosts are not detected (for example `*.localhost`, `0.0.0.0`, `host.docker.internal`, RFC 1918 addresses). Evidence documents up to 128 MiB are read (the declared load bundle is about 30 MiB); larger ones are refused. |
| Reproducible fingerprint | The build fingerprint hashes raw source bytes. `.gitattributes` marks every fingerprint input and the corpus manifest `-text`. The earlier simulated fresh-clone checks with `core.autocrlf` true and false reproduced the then-current `5393fd6f…` (`FINAL-fix-fingerprint-eol-green.log`). B12h's new `a4c23860…` is verified against current source and the built image; after the release commit, a real fresh clone must reproduce that new value. |
| Independent review | Each delegated task (C6d, B6a, C9, B8, B8b) had one fresh implementer and one fresh reviewer. B6a's one Important finding (failed preview-pool jobs counted as regenerations) was fixed and passed a scoped re-review. The controller's follow-ups have focused logs:<br>• C11 (`C11-registry-red/green`), the evidence cap (`B6am-evidence-cap-red/green`) and the C9 path guard (`C9m-red/green`) each have RED and GREEN.<br>• The C6d hardening has GREEN only (`C6d-minor-bridge-unit-green.log`).<br>• The C9 privacy guard was written before its test; it was later tightened with RED/GREEN (`C12-red/green`).<br>• The licence `-text` attribute was checked with `git check-attr` and the pinned licence hashes.<br>A final independent audit (`FINAL-audit-*.log`) found one more Important issue: the fingerprint depended on line endings. It was fixed without a rebuild and passed a scoped re-audit. No Critical/Important findings remain. Minor notes are recorded in the ledger. |

Authoritative command results and immutable before/after snapshots are under the ignored
`output/verification/mobile-image-tasks/` (see `progress.md`). Only named focused checks ran. No full
repository test, build, lint, CI or publication gate is claimed. On 2026-09-26, the focused check
`node node_modules/eslint/bin/eslint.js 'scripts/*mobile*.mjs' scripts/lock-image-decoder.mjs --max-warnings=0`
went from 66 errors in eight scripts to exit 0 (`C14-lint-red.log`, `C14-lint-green.log`). The changes
declare existing runtime globals, remove an unused import, and document why the device recorder
must not retain a filesystem error cause containing private capture paths. Runtime behavior and
native inputs are unchanged; `C14-fingerprint.log` still verifies `5393fd6f…`. Full repository lint
and the publication gates remain unrun.

## Working Linux Docker environment

Local preparation update, 2026-09-26 (B9): both missing JPEG load controls are selected, with
unchanged source hashes and independent/native preview checks. The suspect 50 MP load source
also matches a reference produced through Adobe DNG Converter 18.6 and distribution LibRaw;
the original older-reader warning is retained. All six load source/control hashes were checked.
See `docs/verification/mobile-image-load-sources.json` and the rehearsal runbook. This is local
input preparation only. A newly located CC0 Samsung SM-S901E original has actual JPEG XL
compression (52546); its supplemental preview matches the independent reference. Formal corpus
integration and reference reproduction for that case are the next task, so the table above has
not yet been changed by this diagnostic.

The `Ubuntu-26.04` WSL2 Unix socket reaches Docker Desktop 4.92.0 (Linux Engine 29.8.0). Windows Docker
contexts are unchanged. Reference tooling in WSL: Python 3.14.4, Pillow 12.1.1, libheif-examples
1.21.2, libjxl-tools 0.11.1, libraw-bin 0.21.5b, exiftool 13.50.

```powershell
.\scripts\image-decoder-linux.ps1 -Action check
.\scripts\image-decoder-linux.ps1 -Action boundary
.\scripts\image-decoder-linux.ps1 -Action build        # -Image <tag> for a separate candidate
.\scripts\image-decoder-linux.ps1 -Action verify -Group rendering
.\scripts\image-decoder-linux.ps1 -Action serve         # disposable bridge container, prints its name
.\scripts\image-decoder-linux.ps1 -Action stop -Container <name>
```

`serve` uses the qualification harness's isolation flags and `--pull never`. The rendering verifier
exits 1 while the matrix is incomplete. Rather than the exit status, inspect the report's per-fixture
`status`/`failureCode`, the top-level `runtimeFailure`/`cleanupFailure` (present only on failure) and
`runtime.privateLogsEmpty`.

## Current codec and rendering qualification

The 2026-09-25 corpus measurement on the previous image (`46b8cfb4`) found four native failures.
Three were fixed in `server.py` (B8b) and verified with RED/GREEN boundary tests and real containers:

1. **Large stills.** `-coalesce` on a single-frame still forced extra full-resolution Q16-HDRI pixel
   caches. ImageMagick then reported *cache resources exhausted* for the measured 50 MP stills
   (Galaxy A16 HEIC, S24 Ultra Expert RAW). The threshold between 24 MP and 50 MP was not bracketed.
   A single frame whose page equals the frame at `+0+0` now uses
   `+repage`. Every multi-frame input, APNG, and any canvas or offset keeps `-coalesce`. Thirteen
   geometry probes rendered byte-identical RGBA on both images.
2. **Misclassification.** Every positive native exit was reported as `malformed`. Resource-exhaustion
   messages now map to `resource_limit` through a private, bounded stderr file inside the job directory,
   which is deleted and never logged or returned. Truncated input stays `malformed`.
3. **Colour clip order.** Out-of-gamut Display P3 values were resized before clipping. The render now
   runs `-profile sRGB -clamp` before `-resize`, then strips and re-embeds sRGB.

No reference, tolerance or output cap changed. Every previously passing preview is byte-identical,
except four wide-gamut HEIC/Ultra HDR previews that the colour fix was expected to change.

**Animated cap resolved (B12, approved 2026-09-26):** the owner raised only animated previews
from 16 MiB to 20 MiB and kept existing fidelity. The native server, shared Worker limit, generated
unpublished migration 0026 and local response readers now agree. The 98-frame Commons *Socorro
Von Kármán Vortices* WebP passes the unchanged independent pixel and timing checks. Its previously
measured 19,047,388-byte lossless preview is within the new limit. Still previews remain at 8 MiB;
no original, reference, comparison tolerance or encoder setting changed. All 38 previously passing
preview SHA-256 values match the old build (`B12-evidence-delta.json`).

Focused boundary evidence: native 38/38; Worker adapter and migration checks plus private storage /
serving at exactly 20 MiB total 56 passing tests across the union and scoped fixture correction.
The corrected preview test uses a recognized sequence declaration; the first two fixture attempts
failed on admission setup, not on a production decoder defect. The local native readers' old 17 MiB
ceiling also had to be raised; the first B12 rendering report retains that harness failure. B12h's
final union passes all 39 available files. Bridge tests 9/9, Worker typecheck and focused lint pass.
Above-cap refusals and the 8 MiB still boundary remain covered. The fresh scoped B12/B12h review found no Critical, Important or Minor findings. Logs: `B12-*` / `B12h-*` in the task
ledger directory. The bounded extra lossless-optimization experiment timed out without a result;
it is not evidence that a smaller lossless encoding is impossible.

Observed per-job resource useObserved per-job resource use (from `X-Decoder-Metrics`; animation updated to B12h, other rows retain the B8b measurements):

| Input | Peak RSS | Peak scratch | Native time |
| --- | --- | --- | --- |
| 50 MP Samsung Galaxy A16 HEIC grid | 729 MiB | 4.9 MiB | 4.7 s |
| 98-frame animated WebP (passes at 20 MiB cap) | 1,061 MiB | 22.4 MiB | 26.0 s |
| iPhone 16 HEIC with gain map, mattes and tmap | 394 MiB | 4.2 MiB | 5.8 s |
| Phone DNGs (Pixel 2 XL, S23 Ultra, iPhone 12 Pro, iPhone 8) | 197–228 MiB | 47–65 MiB | 1.6–2.3 s |

These are single-job measurements under the harness's 4 GiB container, not load results. Stills much
larger than about 50 MP (for example 200 MP phone modes) still exceed the 1 GiB memory / 1 GiB map
policy and are refused as `resource_limit`: a synthetic 280 MP PNG shows this. The largest qualified
still is 50 MP.

**Earlier diagnostic only (not corpus evidence):** Galaxy S24 Ultra Expert RAW JPEG XL-compressed DNGs from a
personal mirror, whose rights are unconfirmed. On the final image, the 12 MP and 50 MP files render
through the Adobe SDK path (`sdkUsed` required). The 50 MP file used 818 MiB peak RSS and 7.1 s. A
CC0 Canon Enhanced-NR JXL linear DNG (raw.pixls.us 7023) also renders. This shows the JXL-DNG codec
path works on real files. Those files remain excluded from qualification. Distribution `dcraw_emu`
0.21.5b cannot decode the compressed source directly.

**B10 closes the local JXL-DNG evidence gap:** raw.pixls.us record 7783 is an unchanged CC0 Samsung
Galaxy S22 (SM-S901E) phone DNG, 42,970,855 bytes, TIFF compression 52546 (JPEG XL), 16-bit linear
RGB, DNG 1.7, 4000×3000, orientation 6. Its reference uses the independently downloaded, signed and
SHA-pinned Adobe DNG Converter 18.6 to decompress into a temporary DNG, then distribution LibRaw
0.21.5b and Pillow 12.1.1. Original bytes are unchanged; the existing RAW tolerance remains 16.
The focused missing-tool, wrong-binary-pin and real-reference tests pass 3/3, and native RAW
qualification passes 5/5 on `5393fd6f`. The new fixture uses about 225 MiB RSS, 78 MiB scratch and
1.95 seconds native time in that run. This is a Samsung phone codec case, not proof of Apple's
JPEG XL ProRAW capture settings or either platform's chooser. The converter's optional GPU/model
resource warnings are retained; its installer was not run. Reproduction and executable pins are
in `tests/fixtures/mobile-images/README.md`.

Known Minor gaps, recorded without a remediation loop: finite animation loop counts are not compared
(the Link-U AVIS plays once, the preview loops), Motion Photo video trailers are retained in the
original but not decoded, gain-map HDR rendering is not checked (SDR primary only), and the Pixel 9
C2PA signature was not cryptographically validated.

## Local real-original integration

`tests/worker/mobile-image-real-original.test.ts` runs only when a disposable native container is
named in `CANDIDARY_NATIVE_BRIDGE_CONTAINER`. The chain is the actual main-Worker adapter, the actual
private router `routeDecoderRequest` (separate upload and preview pools), the actual native server
through a Node service-binding bridge (`scripts/mobile-image-native-bridge.mjs`, `wsl docker exec`),
miniflare D1/R2 multipart, completion, previews and exports. The test's readiness check refuses a
container whose logs are not empty, or whose settings differ from the qualification harness in any of
these: network, read-only root, user, memory, PID limit, dropped capabilities, no-new-privileges. CPU
and tmpfs settings are recorded, not compared.

Final-image run (3/3, `output/verification/mobile-images/real-original-local.json`, fingerprint `a4c23860`):

- iPhone 12 Pro ProRAW (guest, 29,195,592 B) and Galaxy S23 Ultra linear DNG (manager link,
  31,311,854 B). Both use `parts-v1`, 4 × 8 MiB parts, never the direct path.
- A 202 processing acknowledgement comes before a delivered `stored` receipt with preview `ready`.
- Exactly one native decode on the upload pool and none on the preview pool.
- Five warm private reads each: WebP, `private, no-store`, `nosniff`, ICC, no EXIF/XMP, SHA equal
  to the persisted proof, no native call, only the preview key read. Other principals get 403.
- After intake closed, the direct original, the device-export stream and the frozen ZIP member all
  match the source SHA-256.

This is local integration. The `wsl`/`docker exec` hop, miniflare and the test-local release override
do not exist in production. The deployed lane is still missing. The prior `5393fd6f` run is preserved as
`real-original-local-5393fd6f.json`; the B12h bridge container was removed after its passing run.

## Rendered workflow

Nine guest and nine manager Playwright cases passed across 320×568, 390×844 and 1440×1000. They ran on
Chromium 149.0.7827.55, WebKit 26.5 and Firefox 151.0, with plain Vite and API stubs. They cover File
selection, capability-driven accept attributes, camera capture attribute, neutral preview,
keyboard/focus, reload and accepted-part proof, confirming without a receipt, retry, delivered
receipt, private preview and Trash. Axe, overflow, reduced-motion and console checks passed. They do
not exercise the physical OS chooser, a real decoder or live storage.

## Required-case qualification

`pass` in the **Local native** column means every fixture of the case passed the native harness on the
final image against an independent reference. The other columns need deployed, load and physical-device
evidence, and none exists. `platform-limited` may be recorded only after observing the actual platform
result.

| Required case | Local native | Real service / original & ZIP | Event load | iOS Safari camera/library | Android Chrome camera/library |
| --- | --- | --- | --- | --- | --- |
| jpeg-baseline | pass | missing | missing | missing | missing |
| jpeg-progressive | pass | missing | missing | missing | missing |
| jpeg-exif-orientation | pass | missing | missing | missing | missing |
| jpeg-hdr | pass (2) | missing | missing | missing | missing |
| jpeg-ultra-hdr-gainmap | pass (2: Pixel 8a, Pixel 9) | missing | missing | missing | missing |
| jpeg-motion-photo-still | pass (2: Pixel 6a Motion Photo, Pixel 2 MicroVideo) | missing | missing | missing | missing |
| png | pass | missing | missing | missing | missing |
| apng | pass | missing | missing | missing | missing |
| webp-lossy | pass | missing | missing | missing | missing |
| webp-lossless | pass | missing | missing | missing | missing |
| webp-animated | pass (2, including 98 frames at the approved cap) | missing | missing | missing | missing |
| heic-primary | pass | missing | missing | missing | missing |
| heic-grid | pass (3: iPhone 14 Pro, iPhone 11 Pro irot, Galaxy A16 50 MP) | missing | missing | missing | missing |
| heic-auxiliary | pass (3: HDR gain map, depth, iPhone 16 mattes/tmap) | missing | missing | missing | missing |
| heic-sequence | missing (no lawful file) | missing | missing | missing | missing |
| heif-generic | pass | missing | missing | missing | missing |
| dng-bayer | pass | missing | missing | missing | missing |
| dng-linear | pass | missing | missing | missing | missing |
| dng-proraw | pass | missing | missing | missing | missing |
| dng-jpeg | pass | missing | missing | missing | missing |
| dng-proraw-jxl | pass (Samsung phone JXL-DNG; not Apple capture proof) | missing | missing | missing | missing |
| avif-still | pass | missing | missing | missing | missing |
| avif-sequence | pass (2; real encodings of artwork, not camera AVIS) | missing | missing | missing | missing |
| gif-still | pass | missing | missing | missing | missing |
| gif-animated | pass | missing | missing | missing | missing |
| tiff | pass | missing | missing | missing | missing |
| bmp | pass | missing | missing | missing | missing |
| jp2 | pass | missing | missing | missing | missing |
| jxl-still | pass (2) | missing | missing | missing | missing |
| jxl-animated | pass | missing | missing | missing | missing |
| live-photo-camera | missing (device observation needed) | missing | missing | missing | missing |
| live-photo-library | missing (device observation needed) | missing | missing | missing | missing |

Coupling that affects admission: a still declaration implicates every still case of its family
(`requiredCasesFor`), and a sequence declaration adds the family's sequence cases. So a DNG needs all
five `dng-*` cases. All five now have local native evidence, but DNG admission and rehearsal still
need the separately authorized preview candidate records, publication and D1 switches; production
also needs the complete release evidence. An extended JPEG needs all six JPEG still cases. HEIC and HEIF add `heic-sequence` only for
sequence MIME types, and animated WebP needs `webp-animated`.

## Release evidence and invocation

`node scripts/verify-mobile-image-release.mjs --local` currently returns `valid: true`,
`admittedCaseIds: []`, `universal: false`: a valid **closed** configuration.
`node scripts/verify-mobile-image-corpus.mjs --require-complete` exits 1. The universal gate remains
separate from per-case admission.

A future qualified release needs corpus pointers to lawful originals, pinned independent references,
native reports from `docker inspect`, deployed original/privacy/deletion results and physical-device
reports. All lanes must match one build fingerprint and one **external registry digest**
(`<dotted registry host>/<repository>@sha256:<digest>`). After `wrangler containers push`, rerun the
native union so the report's `image.registryDigests` lists that reference; a local RepoDigest is refused.

Run the release verifier with explicit `--manifest`, `--fixture-root` and `--evidence-root`. The
evidence root holds release/load JSON named by SHA-256 (at most 128 MiB each). Each decoder/mobile
`evidenceSha256` names a reviewed `mobile-image-qualification` document:

```json
{
  "kind": "mobile-image-qualification",
  "harnessVersion": 1,
  "buildFingerprint": "<actual fingerprint>",
  "imageRef": "registry.cloudflare.com/<account>/candidary-image-decoder@sha256:<actual digest>",
  "previewProfile": "mobile-preview-v1",
  "manifestSha256": "<exact corpus manifest hash>",
  "maxOriginalBytes": 536870912,
  "caseIds": ["<actually qualified case>"],
  "loadEvidenceSha256": "<actual reviewed load report hash>"
}
```

The 512 MiB limit shown is a candidate, not a measured safe limit; the preview candidate proposes 128
MiB per case. Preview qualification needs candidate case records in a deployed build before the live,
device and load lanes can exist. They go in a local checkpoint commit that the cutover helper deploys,
not a pushed branch. The release verifier correctly reports those records as not releasable until
that evidence exists, so that state must never merge. `docs/verification/mobile-image-preview-release.md`
gives the sequence.

## Load rehearsal (not run)

`docs/verification/mobile-image-load-rehearsal.md` is the runbook. The workload is 500 guest
identities, 10,000 originals, 48-tile pages, two visits, cold/warm/mixed, paced 4 upload and 8 preview
operations, and 2 + 2 pool candidates: 58,290 logical operations per authorization. With the listed
CC0 sources, the three scenarios move about 1.07 TB up and 1.07 TB down, so a well-connected
load-generation host is required.

The instrumentation reads preview-only Analytics Engine data points, which carry no guest or media
identifiers. The preview environment must otherwise be idle during each window. The go/no-go
thresholds are unchanged: zero incorrect receipts/hash/privacy results, under 1% unrecovered
transient errors, warm-preview p95 ≤ 2 s, verification p95 ≤ 120 s, RSS ≤ 3 GiB, scratch ≤ 2 GiB,
direct-upload p95 degradation ≤ 10%, and zero original reads and native decodes in warm.

The CC0 raw.pixls.us load sources (about 25.6, 50.2 and 76.3 MiB) are Samsung linear DNGs, not
Apple ProRAW. The only CC0 Apple ProRAW above 25 MiB is the 27.8 MiB iPhone 12 Pro file. Cost figures
are estimates with documented bounds.

## Physical devices (not run)

`docs/verification/mobile-image-device-protocol.md` defines the iOS Safari and Android Chrome runs:
device identity and settings, per-case camera versus library routes, chooser conversion recorded
before the app receives the File, Live Photo and Motion Photo resources,
resume/background/offline/retry, private previews, deletion barriers, original and frozen ZIP after
intake closes, and File-based `navigator.canShare` with its download fallback.
`scripts/record-mobile-device-evidence.mjs` hashes every file itself and writes one SHA-named
`physical-device` document into ignored storage. Browser engines on Windows do not substitute for
hardware.

## Decisions and inputs needed

1. **`heic-sequence` source.** No lawful HEIF image sequence was found. The MPEG/Nokia conformance
   files and WebKit's `sea_animation.heics` lack documented content rights. Options: written permission
   for a specific file, or a consented HEICS produced by a real platform tool. B11 traced the
   SDWebImage animated HEIC samples back to Nokia examples; the code license does not establish
   media rights. B13 (2026-09-26) checked only new avenues and found nothing: the CC0
   `lots-of-sample-files` repository (two stills), Zenodo and figshare. No diagnostic sample was
   added to the qualifying corpus.
2. **Commit/publication sequence.** C16 found no honest preview path that keeps the literal
   single-final-commit rule. A branch alias (`versions upload`) never registers Workflows, so
   resumable completion, preview regeneration and the candidate export cannot run there. The only
   repository path that deploys `candidary-preview` (`deploy:preview-cutover:built`) requires a clean
   commit and tags its SHA, and the preview candidate needs release records the final commit must
   not keep. The recommendation is local checkpoint commits (C1 candidate, C2 records), squashed into
   one commit before the first push. It is proposed, not approved.
3. **Authorizations.** Each remote step needs its own authorization. The ordered list is in the
   preview release plan: preview D1 migration, registry push, local checkpoint, decoder twin
   deployment, preview cutover deployment, preview D1 case switch, live tests, load rehearsal and
   Analytics export, then the squash, repository gates and branch push.
4. **Hardware and people.** Physical iPhone and Android devices (Pro models for ProRAW, Pixel/Samsung
   for Ultra HDR, Motion Photo and Expert RAW), a tester, and consent for any captured test photos.

## Remaining work and release boundary

1. Resolve the remaining source and commit-sequence inputs. Add lawful fixtures and independent references. Use focused
   checks for corpus-only additions; after any native change, rebuild and run one final rendering
   union with refreshed evidence pointers. Do not repeat unchanged successful checks.
2. Under separate authorization, follow `docs/verification/mobile-image-preview-release.md`: migrate
   preview D1 to 0026 first with intake closed, push and pin the decoder image by registry digest,
   deploy the private preview twin, and deploy the clean candidate checkpoint (candidate records
   included) to `candidary-preview` with the cutover helper. Then open candidate cases in preview D1
   only.
3. Run the deployed original/privacy/deletion lane, the load rehearsal and the physical-device protocol.
   Record platform limitations only when observed.
4. Commit only records whose local, live, iOS, Android and load evidence all verify. The universal
   claim stays closed while any required case is missing, failing or platform-limited.
5. Production repeats the migration-first order through the normal merge build. Once an extended
   original or native preview exists, rollback needs a schema-26-compatible reader/export/cleanup
   version. The old baseline is not a rollback target.

Changes remain uncommitted in the isolated worktree under the single-final-commit instruction. The
user's primary checkout is untouched.

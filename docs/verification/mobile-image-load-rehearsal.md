# Mobile image load rehearsal (preview only)

Status: prepared locally on 2026-09-25. **No live request, Cloudflare API call, deployment or
remote mutation has been made.** Every step marked **[authorization]** needs the release owner's
explicit, separate approval. Approving the local implementation does not cover any of them.

This rehearsal produces the `mobile-image-load` evidence that `scripts/verify-mobile-image-release.mjs`
requires before any main-app intake case can be admitted. It runs only against the private
**preview** deployment (`candidary-preview` plus `candidary-image-decoder-preview`), on dedicated
rehearsal events, while the preview environment is otherwise idle. The release order around it is
in `docs/verification/mobile-image-preview-release.md` (step 7).

## What it measures, and what it cannot prove

| Output | Source | Checked by |
| --- | --- | --- |
| Observations: per-request outcome, latency, receipt, SHA-256 match, preview privacy, paced concurrency | `scripts/mobile-image-load-harness.mjs` with the reviewed adapter `scripts/mobile-image-load-adapter.mjs` | `verifyLoadArtifacts` recomputes every observation-derived metric |
| Instrumentation: original reads, preview hits/misses, native decodes, native time, peak RSS/scratch, busy failover, pool separation, cost | Analytics Engine datasets written by the deployed Workers, plus documented GraphQL usage datasets; `scripts/mobile-image-load-instrumentation.mjs` | Report metrics must equal the instrumentation metrics exactly |
| Report | `scripts/mobile-image-load-report.mjs` | `assessLoadEvidence` (go/no-go) and `verifyLoadArtifacts`, the same functions the release verifier calls |

The rehearsal is a paced event-scale load test of one candidate build. It does not qualify codecs,
devices or production capacity, and it does not open intake. A passing report is one input to a
qualification record; it never admits a case on its own. Observations always carry
`complete:false` / `qualification:missing`.

## Declared workload

`node scripts/mobile-image-load-harness.mjs --scenario <name>` prints the exact plan. Unchanged
values:

| Item | Value |
| --- | --- |
| Guest identities | 500 (one cookie jar each, exchanged from the printed entry credential) |
| Originals per uploading scenario | 10,000 in whole 25/50/75 MiB bucket triples (3,334 / 3,333 / 3,333) |
| Gallery reads | 48-tile pages, two visits per guest: 48,000 preview requests per scenario |
| Upload pacing | at most 4 concurrent uploads, 100 ms between starts |
| Preview pacing | at most 8 concurrent reads, 50 ms between starts |
| Controls | 100 direct-path baseline + 100 during-load direct uploads (≤ 20 MiB JPEG) |
| Probes | 50 privacy, 10 deletion, 10 cancellation; mixed adds 20 regeneration seeds |
| Decoder pools | 2 upload + 2 preview `standard-2` instances (measurement candidates, not a capacity claim) |
| Event shards | 6 gallery events (and 6 separate upload events for mixed), inside the 10,000-photo / 100 GiB event limits with 10% headroom |

| Scenario | Uploads | Previews | Controls | Probes | `approvedRequests` |
| --- | ---: | ---: | ---: | ---: | ---: |
| cold | 10,000 | 48,000 | 200 | 70 | 58,270 |
| warm | 0 | 48,000 | 200 | 70 | 48,270 |
| mixed | 10,000 | 48,000 | 200 | 90 | 58,290 |

These are logical operations. The adapter issues more HTTP requests (8 MiB parts, status polls,
one verification download per delivered original). The reports record the concurrency actually
reached (`concurrency.<lane>.maxActive/meanActive`), never a claim of 500 simultaneous decodes.

## Prerequisites

1. **Deployed preview decoder twin from a pinned registry digest.**
   `candidary-image-decoder-preview` deployed from
   `registry.cloudflare.com/<account>/candidary-image-decoder@sha256:<digest>` (preview-release steps
   3–4), with every instance's health reporting the candidate build fingerprint, and the
   preview-only `DECODER_METRICS` → `candidary_image_decoder_preview` dataset binding present.
2. **Preview main-app version.** Migration 0026 applied to `candidary-preview-core`; the branch
   version of `candidary-preview` uploaded with `IMAGE_DECODER` → `candidary-image-decoder-preview`
   and `IMAGE_METRICS` → `candidary_image_metrics_preview`; candidate case records for the build
   (preview-release step 5); and the candidate cases enabled in preview D1 only (step 6). Record
   the main Worker version ID and the decoder Worker version ID for `versions.json`.
3. **The load-source family must be admissible on preview.** Admission is per family group
   (`requiredCasesFor`). DNG sources need all five `dng-*` cases enabled, including
   `dng-proraw-jxl`. All five pass local native qualification on B12h (`a4c23860`); the full available corpus is 39/39.
   **The rehearsal still requires separately authorized preview publication and all five candidate
   records and D1 switches; no local result opens admission.**
4. **Dedicated rehearsal events created through existing product flows.** Create 13 events through
   the normal host flow on the preview origin: 6 gallery events, 6 upload events (used by mixed
   only) and 1 isolation event. Record each event ID, its printed entry credential (`id.secret`) and
   its management link token. Do not create events by direct D1 writes. The same events serve all
   three scenarios; use a fresh set for any repeat.
5. **Private credential and source files outside git.** Keep both under an ignored path such as
   `output/verification/mobile-image-load/private/` or outside the repository; `authorizeLoad`
   refuses tracked paths. Never commit, paste or log them.

   ```json
   { "kind": "candidary.image-load-credentials",
     "events": [{ "eventId": "<id>", "entryCredential": "<id.secret>", "managementToken": "<id.secret>" }] }
   ```

   ```json
   { "kind": "candidary.image-load-sources",
     "sources": [{ "path": "<absolute path>", "sha256": "<hex>", "byteSize": 26798986, "bucketBytes": 26214400, "mimeType": "image/dng", "extension": "dng" }],
     "directControl": { "path": "<absolute path>", "sha256": "<hex>", "byteSize": 0, "mimeType": "image/jpeg", "extension": "jpg" },
     "regenerationSeed": { "path": "<absolute path>", "sha256": "<hex>", "byteSize": 0, "mimeType": "image/jpeg", "extension": "jpg" } }
   ```

   Each source must be within 0.5×–1.5× of its bucket and larger than one 8 MiB part. The adapter
   re-hashes every file before its first request. `directControl` is a lawful JPEG of at most
   20 MiB. `regenerationSeed` (mixed only) is a lawful JPEG of 20,000,001–20,971,520 bytes, so that
   it takes the direct path but exceeds the Images input bound and forces native regeneration.
   Both are now selected and hashed (B9, 2026-09-26): the existing 6,412-byte public-domain
   Hopper JPEG is the direct control; Mohsin ali44's unchanged CC-BY-SA-4.0 *Mountains With Sky*
   JPEG is the regeneration seed (20,949,907 bytes, SHA-256
   `6c82e113546ecabc61a49e4de79efd08676a950747b03c886b0d7ac15d3491fe`). The seed is above the
   Images limit and below the direct-ingress ceiling without padding or transcoding. Both pass
   the local native preview and independent pixel comparison. Source URLs, hashes, attribution
   and retained rights records are in `docs/verification/mobile-image-load-sources.json`.
   All six original source/control hashes were checked; a machine-local source file is prepared
   at `output/verification/mobile-image-load/private/prepared-sources.json`. It contains no
   credentials and grants no authorization. Recreate its absolute paths on a different host;
   the adapter must re-hash every input before any authorized run.
6. **Load sources.** Candidates found by research, downloaded (not committed) under
   `output/verification/mobile-image-research/candidates/b6-proraw-load/` and re-hashed locally on
   2026-09-25:

   | raw.pixls.us id | Device (download name) | Bytes | SHA-256 | Bucket |
   | --- | --- | ---: | --- | --- |
   | 6625 | Samsung Galaxy S22 Ultra (`Samsung - Galaxy S22 Ultra - 4:3.dng`) | 26,798,986 | `13ddd4b117299d16d47b6404ad1981258a00b6bce60382524a51cab15a41334d` | 25 MiB |
   | 7150 | Samsung Galaxy S23+ (`Samsung - Galaxy S23+ - 4:3.dng`) | 52,652,755 | `3c0436a269b7182079aead2d6eaf207efc95a35c3dd613a19a6d6514ab6bb012` | 50 MiB |
   | 7104 | Samsung Galaxy S23 Ultra, 50 MP (`Samsung - Galaxy S23 Ultra - 4:3.dng`) | 79,999,280 (76.29 MiB) | `e53a7b2afd6f2e298ca9343c2e7411f321e4329ae0132c4f615aa22b72d09986` | 75 MiB |
   | 4264 | Apple iPhone 12 Pro ProRAW (corpus `originals/iphone-12-pro.dng`) | 29,195,592 | `e91e77a4533ed7cce551d83330676ea5c47dd5e55fb38adda7819366afdbdfc2` | 25 MiB |

   Download URLs follow `https://raw.pixls.us/getfile.php/<id>/nice/<download name>`; the
   repository listing marks each file CC0. The three Samsung files are **linear DNGs**
   (PhotometricInterpretation 34892 LinearRaw, 3 samples/pixel, lossless-JPEG compression 7): the
   same raw representation Apple ProRAW uses, and therefore ProRAW-like, but they are **not Apple
   ProRAW** (no Apple semantic-mask sub-IFDs). The iPhone 12 Pro file is the only CC0 Apple ProRAW
   over 25 MiB known here. None is JPEG XL-compressed. List both 25 MiB entries; the adapter
   alternates sources within a bucket. On the then-current B9 local image (fingerprint `5393fd6f…`),
   single isolated jobs for 6625, 7150 and 7104 each returned a preview
   (`output/verification/mobile-image-tasks/FINAL-audit-load-sources.log`). The two 50 MP files took
   5.2 s and 4.6 s of native time, with about 817 MiB peak RSS and up to 230 MB scratch. Before the
   B8b fix, the measured 50 MP stills (Galaxy A16 HEIC, S24 Ultra Expert RAW) failed with a
   misreported `malformed`; the threshold between 24 MP and 50 MP was not bracketed. These single-job
   figures are not load evidence.
   Distribution `dcraw_emu` warns of data corruption when reading 7150's original restart-interval-1
   JPEG stream. B9 retains that observation and uses an independent reference path: signed Adobe
   DNG Converter 18.6 outputs an uncompressed DNG; distribution LibRaw 0.21.5b renders it; Pillow
   12.1.1 creates the preview reference. The candidate's preview matches at the existing RAW
   tolerance and the complete frame was visually inspected (candle scene, no visible truncation
   or bands). Original SHA-256 is unchanged. This qualifies the local load input, not event
   capacity, and does not claim the older reader's warning is fixed. Evidence:
   `output/verification/mobile-image-research/b9-load-inputs/preflight-raw-restart-50mp.json`.
7. **An idle preview environment.** No other preview uploads, decoder work, deployment or test
   traffic from `windowStart` to `windowEnd`. The decoder dataset has no event dimension, so any
   other preview decoder job inside a window is counted against the rehearsal. Leave at least
   15 minutes between scenario runs so asynchronous work settles and containers sleep (`sleepAfter`
   is 10 minutes).
8. **A load-generation host with enough bandwidth.** With the four sources above, the declared
   workload moves:

   | Scenario | Upload (fixed) | Download (fixed) | Variable bytes |
   | --- | ---: | ---: | --- |
   | cold | 535,556,080,261 B | 535,472,194,181 B | + 210 control/deletion JPEGs up; + 48,000 previews down |
   | warm | 83,886,080 B | 0 B | same variable terms |
   | mixed | 535,556,080,261 B | 535,472,194,181 B | same, + 20 regeneration seeds up |
   | **all three** | **1,071,196,046,602 B (~1.07 TB)** | **1,070,944,388,362 B (~1.07 TB)** | |

   Fixed upload is the 10,000 originals (535,472,194,181 B = 498.70 GiB, in 69,997 part PUTs) plus
   ten 8 MiB cancellation parts. Fixed download is the one hash-verified original download per
   delivered original. Worst-case variable terms, using the 20 MiB control bound and the 8 MiB
   still-preview cap, add at most 4,404,019,200 B up (plus 419,430,400 B of seeds in mixed) and
   402,653,184,000 B down per scenario; totals are then ≤ 1,084,827,534,602 B up and
   ≤ 2,278,903,940,362 B down. At a sustained 1 Gbit/s each direction, cold needs at least about
   72 minutes of upload and 72 minutes of download transfer time; at 100 Mbit/s about 12 hours
   each. Each authorization expires within 72 hours. The largest event holds 83.81 GiB of
   originals, under the 90 GiB planning headroom.
9. **Export credentials.** An API token limited to this account with *Account Analytics: Read*
   (the Analytics Engine SQL API permission; the same scope reads the GraphQL datasets). Supply it
   only as `CLOUDFLARE_API_TOKEN`, with the 32-hex account ID as `CLOUDFLARE_ACCOUNT_ID`, in the
   shell running the export. The tooling never writes, prints or embeds either value.
10. **Three authorization files**, one per scenario, copied from
    `config/mobile-image-load-authorization.example.json` (which authorizes nothing) into the private
    directory. Each must name the release owner, `environment: "preview"`, the workers.dev preview
    target, `dedicatedRehearsalEvent: true`, the six gallery IDs (and six upload IDs for mixed),
    the isolation ID, an expiry within 72 hours, the idle-window statement, the private paths and
    `approvedRequests` equal to the table above.

## Command sequence

All commands run from the repository root in PowerShell. `<private>` is the ignored private
directory; `<evidence>` is an ignored evidence directory.

1. **Local focused checks (no authorization).**

   ```powershell
   npx vitest run --config vitest.config.ts tests/unit/mobile-image-load-plan.test.ts tests/unit/mobile-image-load-adapter.test.ts tests/unit/mobile-image-load-instrumentation.test.ts tests/unit/mobile-image-release.test.ts
   node scripts/verify-mobile-image-release.mjs --local
   ```

2. **Dry runs (no authorization, no network).** Confirm each plan and `declaredOperations.total`.

   ```powershell
   node scripts/mobile-image-load-harness.mjs --scenario cold
   node scripts/mobile-image-load-harness.mjs --scenario warm
   node scripts/mobile-image-load-harness.mjs --scenario mixed
   ```

3. **Live scenarios [authorization: live preview load, one per scenario].** Run cold, then warm,
   then mixed. Warm and mixed read the gallery that cold published. Wait at least 15 minutes
   between runs. Never reuse an expired authorization.

   ```powershell
   $env:CANDIDARY_IMAGE_LOAD_CONFIRM = 'I_UNDERSTAND'
   node scripts/mobile-image-load-harness.mjs --scenario cold --live --authorization <private>\cold-authorization.json --adapter scripts/mobile-image-load-adapter.mjs --report <private>\cold-observations.json
   # wait >= 15 minutes
   node scripts/mobile-image-load-harness.mjs --scenario warm --live --authorization <private>\warm-authorization.json --adapter scripts/mobile-image-load-adapter.mjs --report <private>\warm-observations.json
   # wait >= 15 minutes
   node scripts/mobile-image-load-harness.mjs --scenario mixed --live --authorization <private>\mixed-authorization.json --adapter scripts/mobile-image-load-adapter.mjs --report <private>\mixed-observations.json
   Remove-Item Env:CANDIDARY_IMAGE_LOAD_CONFIRM
   ```

   A refused or failed run prints only a fixed message. Keep every observation file, including
   failing ones: refusals and failures are evidence too.

4. **Bundle and scope (offline).** `identity.json` holds the candidate
   `{ "buildFingerprint": "<64 hex>", "imageRef": "registry.cloudflare.com/<account>/candidary-image-decoder@sha256:<digest>" }`.

   ```powershell
   node scripts/mobile-image-load-report.mjs bundle --identity <private>\identity.json --out <private>\bundle.json <private>\cold-observations.json <private>\warm-observations.json <private>\mixed-observations.json
   node scripts/mobile-image-load-instrumentation.mjs scope --cold <private>\cold-authorization.json --warm <private>\warm-authorization.json --mixed <private>\mixed-authorization.json --out <private>\scope.json
   ```

5. **Export plan (offline dry run).** Prints the exact SQL and GraphQL for each observed window and
   makes no request. Review it before step 6.

   ```powershell
   node scripts/mobile-image-load-instrumentation.mjs export --scope <private>\scope.json --observations <private>\bundle.json --out <private>\export.json
   ```

6. **Live export [authorization: Cloudflare API read].** Run at least 5 minutes (15 recommended)
   after the last window ends and within 30 days of the first. This is the only network step in
   the instrumentation tooling.

   ```powershell
   $env:CLOUDFLARE_ACCOUNT_ID = '<32 hex>'
   $env:CLOUDFLARE_API_TOKEN = '<Account Analytics: Read token>'
   node scripts/mobile-image-load-instrumentation.mjs export --scope <private>\scope.json --observations <private>\bundle.json --out <private>\export.json --live-export
   Remove-Item Env:CLOUDFLARE_API_TOKEN, Env:CLOUDFLARE_ACCOUNT_ID
   ```

7. **Instrumentation and report (offline).** `versions.json` holds
   `{ "worker": "<main Worker version ID>", "decoder": "<decoder Worker version ID>" }`; the
   harness version is the SHA-256 of the four rehearsal scripts, computed by the report tool.

   ```powershell
   node scripts/mobile-image-load-instrumentation.mjs build --scope <private>\scope.json --observations <private>\bundle.json --export <private>\export.json --out <private>\instrumentation.json
   node scripts/mobile-image-load-report.mjs build --observations <private>\bundle.json --instrumentation <private>\instrumentation.json --versions <private>\versions.json --evidence-root <evidence>
   ```

   The report step writes the bundle, instrumentation and report as `<sha256>.json` whenever they
   reproduce each other, including when a go/no-go target fails, and prints the three digests,
   `pass`, `issues`, throughput and cost. It exits 0 only when the gate passes.

8. **Bind and verify (offline).** Put the report digest in the qualification record's
   `loadEvidenceSha256`, then run the release verifier with explicit `--manifest`, `--fixture-root`
   and `--evidence-root`. It re-reads all three files by digest and repeats both checks.

## Instrumentation definitions

Main Worker points (`candidary_image_metrics_preview`): index = event ID, blobs = environment,
`original-read`/`preview-read`, label; doubles = bytes, 1. Decoder points
(`candidary_image_decoder_preview`): index = environment, blobs = environment, `pool/lane`, path,
closed outcome, family; doubles = native ms, peak RSS, peak scratch, source bytes, 1. No guest,
session, media, key, hash or filename is written.

| Metric | Definition |
| --- | --- |
| `originalBytesFetched` | Bytes of every original read in the scenario events: native decode, verification download, export and Images transform |
| `previewHits` / `previewMisses` | Hits: `persisted-hit`, `legacy-hit`. Misses: `legacy-images`, `miss-regeneration`, `unavailable`. `denied` is excluded. Hits plus misses must equal the 48,000 preview requests |
| `nativeDecodes` | Forwarded decoder jobs of every outcome except `busy` |
| `regenerationDecodes` | Successful decodes only: jobs in the preview pool on the preview lane with outcome `ok` whose group reports native time above zero. `unavailable`, `malformed`, `resource_limit`, `unsupported` and `busy` preview-pool jobs never count, and neither does an `ok` group with zero native ms |
| `nativeSeconds`, `peakRssBytes`, `peakScratchBytes` | Sum of native ms / 1000; maxima of the native per-job header values |
| `busyFailoverChecks`, `busyRate` | Busy refusals, each followed by a failover attempt; busy ÷ all forwarded jobs |
| `uploadPoolPreviewJobs`, `previewPoolUploadJobs` | Jobs whose pool differs from their lane; must be zero |
| Latency, receipts, hashes, privacy, controls, throughput | Recomputed from observations by `observationMetrics` (nearest-rank percentiles) |

The export fails closed on: sampled data (`_sample_interval` other than 1), missing, duplicated or
unknown rows, non-integer or negative values, an empty main-Worker aggregate, GraphQL errors,
a window that differs from the observations, queries that differ from the reviewed text, scope or
dataset drift, a missing scenario, or an export taken less than 5 minutes after a window.
GraphQL usage is used only for cost; the adaptive datasets are estimates.

## Cost model

`costPer10000Originals` = the scenario window's priced usage × 10,000 / declared originals.
Prices are Workers Paid list prices retrieved 2026-09-25. Included monthly usage, free tiers and
billable-unit rounding are not applied.

| Component | Basis | Price | Source |
| --- | --- | --- | --- |
| Main Worker requests | measured (GraphQL `workersInvocationsAdaptive`) | $0.30 / million | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Decoder service-binding calls | no request fee | — | [Service bindings](https://developers.cloudflare.com/workers/platform/pricing/#service-bindings) |
| R2 Class A / Class B | measured (`r2OperationsAdaptiveGroups`); undocumented action types priced as Class A | $4.50 / $0.36 per million | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| R2 storage | one month of delivered original bytes (decimal GB) | $0.015 / GB-month | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| Containers | upper bound: every instance of each active pool for window + `sleepAfter`, provisioned `standard-2` memory 6 GiB and disk 12 GB, full 1 vCPU | $0.0000025 / GiB-s, $0.00000007 / GB-s, $0.000020 / vCPU-s | [Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/) |
| Durable Objects | 2 stub requests per forwarded job; duration bounded by container instance-seconds at 128 MB | $0.15 / million; $12.50 / million GB-s | [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| Analytics Engine points | measured points in both datasets (listed price; not billed yet) | $0.25 / million | [Analytics Engine pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/) |
| Images transformations | every `images-transform` read (upper bound on unique transformations) | $0.50 / 1,000 | [Images pricing](https://developers.cloudflare.com/images/pricing/) |

Excluded and listed in each instrumentation document: Workers CPU time (only CPU quantiles are
documented for the GraphQL dataset), D1 rows (only daily filters are documented), Workflows
storage, persisted preview storage, container egress (Internet is disabled) and included
allowances. The figure is therefore an estimate with stated bounds, not an invoice.

## Go/no-go

`assessLoadEvidence` keeps the approved targets: zero incorrect receipts, hash or privacy failures;
<1% unrecovered transient errors; warm-preview p95 ≤ 2 s; verification p95 ≤ 120 s excluding the
client upload; peak RSS ≤ 3 GiB and scratch ≤ 2 GiB; direct-upload control p95 degradation ≤ 10%;
no cross-pool jobs; every declared operation accounted for. Cold and mixed must show nonzero peak
RSS, at least one busy failover, native work and ≥ 25 MiB fetched per delivered original; mixed
must show preview misses, more native decodes than delivered originals, and at least one
successful `regenerationDecodes` in the preview pool. The last rule is new: upload retries alone
could previously satisfy the "more decodes than uploads" test without any regeneration, and a
preview pool whose every regeneration failed must not count as regeneration either.

Warm now requires zero decoder activity of any kind: no original read, native decode,
regeneration decode, native time, RSS, scratch, busy refusal or busy rate. Earlier, every scenario had to show nonzero peak
RSS and at least one busy failover, which a genuinely warm window can never produce. That rule
made the gate unpassable by honest evidence and did not flag busy-only decoder traffic during warm.
No target was relaxed; warm and mixed are stricter than before.

## Still unauthorized and unproven

- Every bracketed step: event creation, live scenario runs, the Cloudflare API export, decoder
  image publication, deployment, remote migration and preview D1 case switches.
- No rehearsal has run, so there is no measured throughput, latency, RSS, busy rate or cost, and no
  load pass. Unit tests use recorded fixtures only; the complete synthetic chain is labelled a
  schema proof and is never qualification evidence.
- The Analytics Engine SQL and GraphQL queries use documented fields and columns but have not been
  executed against the live API.
- All five DNG cases now have local native qualification; preview publication, candidate admission
  and live-run authorization remain prerequisites. Both JPEG controls are selected and locally
  checked; the source catalog and prepared local paths are described above.
- Rehearsal events retain about 1.07 TB of originals after all three runs. Deleting them through
  the product's host deletion and purge flow is a separate **[authorization]**; until then R2
  storage accrues.

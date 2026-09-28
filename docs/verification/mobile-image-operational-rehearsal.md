# Bounded mobile image operational check

Status: narrower qualification scope approved on 2026-09-27. Tooling is implemented
locally on `codex/mobile-image-qualification-recovery`. The first bounded live attempt
completed on 2026-09-27 and did not qualify: eight mixed preview operations exhausted
retries before regeneration was ready, and sampled image-accounting rows prevented
instrumentation admission. See [its execution record](mobile-image-operational-results-20260927.md).
No passing operational or physical-device result is claimed. This supersedes the mandatory full-scale load
prerequisite for individual case admission; the [capacity rehearsal](mobile-image-load-rehearsal.md)
is deferred and retains its original criteria.

## What this qualifies

`operational-v1` checks a small sample of real uploads, private cached previews,
regeneration, an explicit multipart retry, original hashes, receipts, deletion,
cancellation and resource isolation on the pinned preview build. It is eligible as
the operational part of a release record only when the same case also has matching
native, live, physical iOS and physical Android evidence. It does not open intake by
itself. Missing phone evidence cannot be replaced with emulation or this check.

A passing operational record keeps `capacityQualified: false` and `universal: false`.
Measured latency, throughput and the cost of this small run are diagnostic. They do
not establish 500-guest capacity or a cost per 10,000 originals. Existing full-scale
reports with no profile keep their historical `capacity-v1` interpretation; a small
report cannot be relabeled as a full run.

## Fixed scope

| Setting | Operational profile |
| --- | --- |
| Guest identities | 4 |
| Large originals | 24 in cold, none in warm, 24 in mixed |
| Source mix | 25/50/75 MiB buckets; exact unchanged files from the existing pinned source catalog |
| Gallery | 12 tiles, two visits per guest: 96 previews per scenario |
| Concurrency | At most 4 uploads and 8 preview requests, using the existing pacing |
| Direct controls | 10 before each scenario and 10 during it |
| Probes per scenario | 4 privacy, 2 deletion, 2 cancellation |
| Additional probes | 1 real multipart retry in cold/mixed; 2 preview-regeneration seeds in mixed |
| Event allocation | One gallery, one mixed-upload, one isolation event: 3 total |
| Logical operations | Cold 149; warm 124; mixed 151 |

Cold creates the published gallery; warm and mixed reuse it. Mixed uploads go to a
separate event. Its regeneration seeds must be selected in the preview requests.
The retry probe deliberately resends an accepted part with identical bytes/hash,
then verifies the delivered original; configuring a retry count is not proof of a retry.
The declared operation counts include these probes, but multipart requests, status
polls and other protocol calls add HTTP requests.

The existing source catalog yields approximately 2.57 GB of main original uploads
and the same amount of verification downloads across cold and mixed, before probes,
controls, previews or retries. The authoritative conservative media-payload ceilings
are printed by the dry run as `payloadBounds.uploadBytes` and `downloadBytes` for each
scenario. They account for validated source maxima and multipart retries, with previews
capped at 20 MiB and original downloads capped at the expected length. They also
include at most 64 KiB for each of ten denial-response checks per scenario; an
unexpected successful response is cancelled immediately. Other JSON/headers, polling
and internal R2/decoder traffic are excluded, so these are not total network or billing
caps. Copy the exact ceilings into the scoped authorization; do not substitute the
estimate above.

| Scenario | `approvedUploadBytes` | `approvedDownloadBytes` |
| --- | ---: | ---: |
| Cold | 6,300,368,896 | 3,940,679,680 |
| Warm | 511,705,088 | 2,013,921,280 |
| Mixed | 6,342,311,936 | 3,940,679,680 |

These worst-case payload ceilings total 12,545 MiB uploaded and 9,436.875 MiB downloaded.
They deliberately allow every multipart part to use its retry allowance and every
preview to reach the animated-preview cap. Normal traffic with the pinned sources is
substantially lower; the dry-run values must still match the authorization exactly.

## Prepare locally

Use the recovered pinned originals and references. The existing ignored
`output/verification/mobile-image-load/private/prepared-sources.json` lists the prepared
load sources and JPEG controls on this Windows machine; recreate paths on another host.
The adapter hashes every input before making its first network request.

```powershell
node scripts/mobile-image-load-harness.mjs --profile operational-v1 --scenario cold
node scripts/mobile-image-load-harness.mjs --profile operational-v1 --scenario warm
node scripts/mobile-image-load-harness.mjs --profile operational-v1 --scenario mixed
```

These are local dry runs. The legacy command without `--profile` still selects the
full capacity workload; always specify the operational profile for this scope.

Create one gallery event, one mixed-upload event and one isolation event through the
normal preview host flow. Store IDs and credentials in the private ignored directory,
using the credential schema from the capacity runbook. Do not create events through
direct D1 writes. The gallery needs at least 12 successfully published originals from
cold before warm/mixed can start. A repeat uses a fresh event set.

Copy `config/mobile-image-operational-authorization.example.json` into that private
directory three times. The template itself authorizes nothing. Each completed file
names the profile, exact scenario, event IDs, private source/credential paths, owner,
idle preview window, expiry within 72 hours, exact logical count and media-payload
ceilings. Warm and cold have no separate upload event; mixed names the one upload
event. Keep the isolation event distinct.

Before live execution, verify the current main/decoder versions, build fingerprint,
registry digest, schema 0026, needed preview admission and metrics bindings. Historical
deployment records do not substitute for that check. The smaller profile still needs
independent deployed resource measurements, so metrics export needs Account Analytics:
Read access. An authenticated MCP transport can provide the same genuine query results
to the existing offline builder; a shell token is only needed for the CLI's direct
network export. No token belongs in a report or Git.

## Run and record

Run cold, warm, then mixed in an otherwise idle preview window, with at least 15 minutes
between runs so resource/caching windows stay separate. Once the scoped inputs are in
place, the live command for each scenario is:

```powershell
$env:CANDIDARY_IMAGE_LOAD_CONFIRM = 'I_UNDERSTAND'
node scripts/mobile-image-load-harness.mjs --profile operational-v1 --scenario cold --live --authorization <private>\cold-authorization.json --adapter scripts/mobile-image-load-adapter.mjs --report <private>\cold-observations.json
Remove-Item Env:CANDIDARY_IMAGE_LOAD_CONFIRM
```

Use the corresponding scenario and paths for warm/mixed. Keep failed observations too.
After all three runs, follow the existing offline bundle, scope, export-plan,
independent metrics export, instrumentation and report commands in the
[capacity runbook](mobile-image-load-rehearsal.md#command-sequence). The profile must
agree across authorizations, observations, bundle, scope/export, instrumentation and
report. Do not edit a report's profile or recorded counts after execution.

Operational checks require every declared operation to succeed, byte-identical originals,
correct receipts and privacy/deletion/cancellation barriers, measured overlapping uploads,
successful mixed preview regeneration, no decoder work in warm, and the same 3 GiB RSS /
2 GiB scratch limits. The 120-second verification and 2-second warm-preview guardrails
remain. Ten direct-control samples provide diagnostics, not the old full-workload 10%
degradation qualification. An unobserved busy refusal is unexercised, not a fabricated pass.

The qualification document must select `qualificationProfile: "operational-v1"`, pin
the resulting report and current corpus manifest, and keep per-case originals at or
below the existing 128 MiB candidate cap. Historical native/live/device identity and
evidence requirements remain. Do not regenerate a candidate record to hide missing
device or live operational results. Deleting rehearsal events follows the normal
authorized host cleanup flow; keep evidence before cleanup.

## Current external inputs

The owner confirmed on 2026-09-27 that preview testing and metrics access should be
available now, and that no physical phones are available. The fresh
[access preflight](mobile-image-operational-preflight-20260927.md) confirms the pinned
preview deployments, schema and GraphQL access. Analytics Engine SQL currently fails
inside the MCP connection with `Cloudflare API error: 200`; no query rows are returned.
The owner selected a privately supplied Analytics Read token instead of the browser
fallback. A subsequently supplied token passed direct read-only SQL checks for both
preview datasets and the Workers/R2 GraphQL query at 18:51:44 UTC. It was tested only
in process memory. The owner subsequently chose to use the existing key; it is now
stored in the ignored private file. All three scenarios and the independent export
have now completed; the failed attempt is preserved in the linked execution record.

The three new events and scoped authorizations were prepared after the working SQL
path and updated idle-window check were confirmed. Physical
iOS/Android evidence remains missing because hardware is unavailable; it cannot be
replaced by this run. The lawful HEIC-sequence source and Live Photo observations
remain open. Tooling completion does not resolve those evidence gaps.

## Local verification

The named focused Vitest union for load-plan, adapter, instrumentation and release
verification passed 36/36. Subsequent fail-closed refinements passed the affected
instrumentation (12/12) and release (8/8) checks. Scoped ESLint and whitespace checks
passed. Independent review identified two Important findings: unbounded denial-body
reads and incomplete nested metrics-scope profile validation. Both were fixed with
focused regression checks; the scoped re-review closed both findings with no open
Critical, Important or Minor findings. The affected plan/release checks passed; the
final narrow adapter and capacity-profile regressions each passed 1/1. The three
operational dry runs were refreshed and printed 149/124/151 operations and the ceilings
above; the default mixed capacity dry run retained 58,290 operations. These checks use
synthetic unit controls and offline plans, not live qualification evidence. Full logs
and the implementation report are under the ignored
`output/verification/mobile-image-operational-20260927/` directory. Repository-wide
gates were not run; release configs and the historical corpus/evidence remain unchanged.

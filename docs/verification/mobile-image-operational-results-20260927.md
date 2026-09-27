# Bounded operational rehearsal — 2026-09-27

Status: all three live scenarios completed; **operational qualification did not pass**.
Eight mixed preview operations failed, and the independent instrumentation builder
refused sampled Analytics Engine rows. No qualifying load report was produced.
Capacity and universal compatibility remain unqualified. Physical phones are unavailable.

## Scope and identity

- Profile: `operational-v1`, four guests, three dedicated preview events.
- Cold/warm/mixed logical operations: 149 / 124 / 151; all 424 were recorded.
- Main Worker: `2c42b186-3b75-4d30-81ea-982fcb579079` at 100%.
- Private decoder: `ca4d8ff4-831d-4e92-867c-eafc806277f4` at 100%.
- Fingerprint: `a4c238603f67f9c7ebfd9796fe4c722b773f75611b19d6c5b403db7fd8418651`.
- Image: `registry.cloudflare.com/a77e479f6736120eadd99973dbeb705e/candidary-image-decoder@sha256:d014ac551e24b9ce74737a4aebdd9c2f7d0ba0d4e50a2a87bd5fa4c5d3b82f80`.
- Tooling digest: `sha256:e9f9d075143b622ec40cbb429cac3b4157a0f952d50d525c7ca1fd0f7c51352d`.
- Preview schema: 26, protocol 1, all five DNG candidate cases enabled.

The owner's existing Analytics Read key passed direct SQL and GraphQL access checks
and was used for the final export. It remains in an ignored private file. Three events
were created through normal `POST /api/events` calls after both preview datasets had
zero points in the preceding 15 minutes. No direct database writes, admission changes
or deployment were required. Read-only postflight at 19:42:33 UTC confirmed both
deployed versions remained unchanged at 100%.

## Observed results

| Scenario | UTC window | Originals verified | Previews successful | Controls | Probes | Verification p95 | Cached-preview p95 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Cold | 18:55:54.758–19:03:19.116 | 24/24 | 96/96 | 20/20 | 9/9 | 38.671 s | 1.086 s |
| Warm | 19:18:19.276–19:18:59.996 | None declared | 96/96 | 20/20 | 8/8 | Not applicable | 1.218 s |
| Mixed | 19:34:00.171–19:41:18.693 | 24/24 | 88/96 | 20/20 | 11/11 | 45.420 s | 1.207 s |

Warm began 900.160 seconds after cold ended; mixed began 900.175 seconds after warm
ended. Both uploading scenarios reached four simultaneous upload operations. Across
all scenarios, 48 main originals had matching bytes and receipts; 60 controls and 28
probes succeeded. The probes include privacy, deletion, cancellation, two explicit
multipart replays and two mixed regeneration seeds. No privacy violation or original
hash mismatch was observed. A failed preview's `previewPrivate: false` records that
no successful private preview was returned; it is not evidence of a privacy leak.

Direct-control p95 increases were 0%, 21.85% and 7.24% for cold/warm/mixed. These
small-sample diagnostics remain recorded; the deferred capacity profile's 10% gate
does not apply to this approved operational profile.

## Regeneration finding

All eight failed preview indexes — 0, 1, 12, 13, 50, 51, 62, 63 — map to the two
regeneration seeds and every declared visit to them. Each operation exhausted three
GET attempts after 3.424–5.947 seconds. The adapter waits 350 ms and 700 ms between
attempts. The Worker queues missing previews asynchronously and returns HTTP 503
while they are pending.

A read-only D1 aggregate selected exactly two seed records. Both were stored with a
ready preview, one workflow run and no failure code. Their claim timestamps span
19:34:35.326–35.581 UTC; database-ready timestamps span 19:34:53.437–55.459 UTC.
These unpaired aggregate bounds place the claim-to-ready delays within
17.856–20.133 seconds. They support a mismatch between the short request retry period
and asynchronous readiness, rather than persistent regeneration failure.

The guest gallery shows "Preview unavailable" and offers a manual "Retry preview"
button; it does not retry the image automatically. This is a source finding, not
physical-device proof. No later seed preview GET or fresh R2 integrity check was
performed. Later database readiness does not turn the eight failed operations into
passes. The detailed source trace and aggregate SQL are retained in `diagnosis.md`
inside the evidence archive.

## Independent metrics export

The genuine export completed at `2026-09-27T19:46:21.904Z`, 303.211 seconds after
mixed ended. The builder correctly refused `sampled Analytics Engine data`.

| Scenario | Sampled image group | Maximum sample interval |
| --- | --- | ---: |
| Cold | persisted-hit | 4 |
| Warm | denied / persisted-hit | 2 / 4 |
| Mixed | denied / miss-regeneration / persisted-hit | 2 / 2 / 3 |

These are real numeric sampling fields, not a parser or token-access failure.
Cold and warm were already 43 and 27 minutes old when exported. Cloudflare documents
sampling at both write time and query time; this export does not identify which
stage produced these sampled groups. Another identical export cannot be assumed
to recover exact data. See [Cloudflare's sampling documentation](https://developers.cloudflare.com/analytics/analytics-engine/sampling/)
and [Analytics Engine FAQ](https://developers.cloudflare.com/analytics/faq/wae-faqs/).
No repeated export or relaxed sampling rule was used.

All returned decoder rows had sample interval 1. As partial raw diagnostics, the
largest RSS was 856,674,304 bytes and scratch was 230,475,011 bytes, below the
3 GiB / 2 GiB limits. Mixed contained two successful preview-pool native decodes
totaling 21,707 ms, plus one preview-pool busy refusal. Warm returned no decoder rows.
These rows do not replace the refused complete instrumentation document, prove exact
image-read counts or create a passing qualification record.

## Preserved evidence and next work

The local execution directory is
`output/verification/mobile-image-operational-live-20260927/`.
`attempt-status.json` explicitly records complete execution, failed operations,
refused instrumentation and no qualification report. It is not a `mobile-image-load`
qualification artifact.

- Observation bundle SHA-256:
  `4234f7baee53e30a82f5da7e8837244430fb17609e81247104a374eb8f4e3c73`.
- Raw deployment export SHA-256:
  `37e6ecdad9fab9779ce35aa5b05bca21adf2ee06f19d9dc84c646b6fc97bb208`.
- [Portable failed-attempt archive](evidence/mobile-image-operational-20260927.tar.gz):
  SHA-256 `47177aaa9e99f19bef6118618a95792a2a26628ba66e4c9feab68512e9cb7239`.
  It includes the exact observation bundle, raw export and query scope/plan, attempt
  status, identities, read-only postflight, diagnosis, independent review and an
  internal file-hash manifest. Credentials, event creation responses, completed
  authorizations, source paths and fixture binaries are excluded.

Independent review found no Critical or Important defect in execution or evidence
preservation. The eight failed previews and sampled image measurements remain
material qualification blockers. All allowed archive files passed an exact-value
credential-exclusion check. No successful focused unit union or broad gate was rerun
for this evidence task; the earlier implementation checks remain the code evidence.

The next software work is to define and review the intended asynchronous preview
recovery behavior and obtain exact independent telemetry for the qualification gate,
then run a fresh bounded rehearsal on the reviewed build. Do not recast failed
requests as successes, extend retries merely to make this record pass, substitute
sampled estimates for exact counters, or mix evidence from changed tooling.

The rehearsal events and media are retained; cleanup was not performed. Physical
iOS/Android evidence, the lawful HEIC-sequence source, Live Photo observations and
the deferred full capacity/cost rehearsal remain open. No release config or admission
manifest was regenerated. Changes and evidence remain local and uncommitted.

# Practical mobile-image acceptance — 2026-09-27

**Current status: core practical acceptance is satisfied by the existing supported-format
proof and successful two-preview retrieval. Limited real-device BrowserStack observations
are complete; unobserved end-to-end device behavior is deferred.** The owner's latest
instruction, “Relax the requirements of achieving the goal,” supersedes the earlier universal-completion and bounded-operational
completion requirements. The project now targets broad iPhone and Android photo support
across the 29 implemented cases, with the exceptions and evidence limits below.

This is a documentation-only project-scope amendment. It does not change runtime code,
admission/release configuration, fixture manifests, strict verifiers or historical reports.
The strict universal verifier remains unchanged; its unmet requirements do not prevent
completion of this reduced project scope. `universal: false` and `capacityQualified: false`
remain truthful. Completing this scope does not make the candidate release records
mergeable or authorize a production release.

## Acceptance requirements and evidence

| Requirement | Evidence and current status |
| --- | --- |
| Existing native coverage for the 29 implemented cases | **Recorded pass:** 39 available fixture results in the [recovered native report](../../tests/fixtures/mobile-images/evidence/9083069a702632a78ba8a663d9b0d7d36266a20ab4363b6561f3f9b17548d4fe.json), fingerprint `a4c238603f67f9c7ebfd9796fe4c722b773f75611b19d6c5b403db7fd8418651`. The [recovery record](mobile-image-recovery-20260927.md) records hash verification of 37 distinct originals, 39 references and the historical reports. Reuse this evidence; no new native run is required for this amendment. |
| Unchanged originals and private access through the deployed preview workflow | **Recorded pass:** the [reviewed live report](../../tests/fixtures/mobile-images/evidence/f99ae2d2082638007282a2704132379291f348f78ca3bfe377551de59625900f.json) covers 39 fixtures across 29 cases, original/ZIP/restored-byte checks, private access and deletion. The [handoff](mobile-image-handoff.md) records the deployed identity and cleanup observations. These are existing preview results, not a production claim. |
| Representative iPhone Safari smoke check, best effort | **Limited observation complete:** BrowserStack real iPhone 16 Pro, iOS 18.7, Safari rendered the guest upload page and exercised required-name validation. The exact browser build was not captured. This establishes only the observed page/validation behavior; it is not an end-to-end or device-qualified pass. |
| Representative Android Chrome smoke check, best effort | **Limited observation complete:** BrowserStack real Samsung Galaxy S25, Android 15.0, Chrome rendered the guest upload page and accepted a synthetic participant name. The exact browser build was not captured. This establishes only the observed page/input behavior; it is not an end-to-end or device-qualified pass. |
| Retrieval of the two regenerated previews from the failed mixed scenario | **PASS, 2026-09-27:** both authorized guest requests returned HTTP 200 WebP, each 1,991,104 bytes, matching stored byte counts and SHA-256 proofs. Private/no-store, `Vary: Cookie`, same-origin resource policy and nosniff headers passed; both signed-out probes returned HTTP 401 JSON without image bodies. The [sanitized recovery observation](evidence/mobile-image-preview-recovery-20260927.json) records unchanged deployed versions. This follow-up does not turn the earlier eight failed operations into passes. |
| Operational diagnostics and honest limitations | **Recorded:** the [bounded attempt](mobile-image-operational-results-20260927.md) remains **FAILED** and immutable. Its successful original/control/probe observations can inform diagnostics. Sampled Analytics Engine data is accepted only as diagnostic information; it is not exact accounting, cost or capacity qualification. No instrumentation repair or new operational pass is required for reduced-scope completion. |

The [portable device observation record](evidence/mobile-image-practical-20260927/device-smoke.json)
identifies both limited real-device observations and their screenshots. Both one-minute
Free Trial sessions ended before native picker behavior, upload/receipt, private preview,
file metadata, original download or save/share could be verified. Those lanes are
**DEFERRED** on both devices. RAW, Motion Photo and camera-specific behavior also remain
unverified. A paid upgrade is not a completion prerequisite.

The final handoff must preserve these actual retrieval results and the BrowserStack
observations or access limitations. An unavailable session, observation
or retrieval must remain pending, deferred or failed with its reason; no pass is inferred
from configuration, database state or desktop emulation. BrowserStack real hardware
counts as an actual device observation for the steps performed; it does not complete the
older exhaustive protocol. Preserve the existing original-byte, private-access, deletion
and intake invariants throughout the checks.

The recovery observation's SHA-256 is
`0c4f5c713c47125464b4bbe5279050b4f7a08e9ed223cd6c66105cfeae88fc49`; the portable copy
retains its exact bytes. Its single-request timings, 1391.472 ms and 2054.999 ms, are
diagnostics only and establish no latency or fresh regeneration-delay qualification.

## Coverage and deferred work

The 29 implemented case IDs are `apng`, `avif-sequence`, `avif-still`, `bmp`, `dng-bayer`,
`dng-jpeg`, `dng-linear`, `dng-proraw`, `dng-proraw-jxl`, `gif-animated`, `gif-still`,
`heic-auxiliary`, `heic-grid`, `heic-primary`, `heif-generic`, `jp2`, `jpeg-baseline`,
`jpeg-exif-orientation`, `jpeg-hdr`, `jpeg-motion-photo-still`, `jpeg-progressive`,
`jpeg-ultra-hdr-gainmap`, `jxl-animated`, `jxl-still`, `png`, `tiff`, `webp-animated`,
`webp-lossless` and `webp-lossy`. Their native/live evidence does not imply that every
device can capture, select or export every format.

The following are deferred and are not blockers for this reduced project goal:

- HEIC/HEIF image sequences (`heic-sequence`).
- Live Photo movie companions and the `live-photo-camera` / `live-photo-library` cases.
- The exhaustive per-fixture iOS/Android, camera/library and device-save matrix.
- Native picker, upload/receipt, private preview, file metadata, original download and
  save/share observations prevented by the existing BrowserStack trial on both devices.
- Full event capacity and cost qualification, including the 500-guest/10,000-original rehearsal.
- Exact telemetry/accounting engineering and a passing strict bounded-operational report.

## Public wording and completion boundary

Use **“Broad iPhone and Android photo support, backed by native and live-preview evidence
for 29 implemented cases”** with the listed exceptions: **HEIC image sequences and Live
Photo movie companions are excluded; device selection, camera, save and share behavior
remain limited to the observations actually recorded.** Describe BrowserStack checks
with their actual results and trial limitations. Reduced-scope completion is the
supported-format engineering/evidence handoff, including the focused preview-retrieval
result and honest device limitations; full device certification or paid BrowserStack
access is not required.

Never turn this scope amendment into a universal-compatibility, full-capacity or exact-cost
claim. This work remains local and uncommitted and makes no production-release claim.
Existing candidate-state restrictions remain; any later merge, schema/admission change
or deployment is separate work with its applicable authorization.
The [design](../superpowers/specs/2026-09-23-mobile-image-compatibility-design.md),
[implementation plan](../superpowers/plans/2026-09-23-mobile-image-compatibility.md),
[evidence summary](mobile-image-compatibility.md) and
[preview release plan](mobile-image-preview-release.md) retain their older details as
historical procedures; this document controls current project-completion scope.

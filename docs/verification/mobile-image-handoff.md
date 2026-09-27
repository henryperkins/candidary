# Mobile image compatibility handoff

**Current scope, 2026-09-27:** The owner's latest instruction to relax completion
requirements supersedes the earlier universal and operational completion scope. Use
[practical acceptance](mobile-image-practical-acceptance-20260927.md): existing native/live
proof for 29 implemented cases, best-effort BrowserStack iPhone Safari and Android
Chrome observations, and a focused private retrieval check of the two regenerated previews.
Both regenerated preview retrievals passed with byte/hash and private-access checks;
the practical acceptance record preserves the actual limited device observations. Trial-limited device steps may
be explicitly deferred without buying access or blocking the handoff. Sampled analytics is diagnostic
only. HEIC sequences, Live Photo movie companions, exhaustive device coverage, full
capacity/cost and exact telemetry engineering are deferred. `universal: false` and
`capacityQualified: false` remain truthful; the strict verifier is unchanged and is not
a blocker for completing this reduced project scope. Candidate release and production
boundaries remain in force.

## Historical handoff and operational attempt

Updated 2026-09-27 for the owner's instruction to commit and push local work so it can
be resumed on another machine. This branch contains the runtime fix and the subsequent
evidence checkpoint. Preview observations below were verified on 2026-09-26, not rechecked
against Cloudflare during this Git handoff. Release qualification remains incomplete.

**Windows recovery, later on 2026-09-27:** all 37 distinct originals and 39 independent
references were found and hash-verified, together with both named historical reports.
The local source branch diverged from the published handoff, so it was preserved and
recovery continues on local `codex/mobile-image-qualification-recovery` from `270104e`.
These recovery changes have not been committed or pushed. See the
[recovery and lane-readiness record](mobile-image-recovery-20260927.md) for fresh focused
check results and remaining external inputs. No native, live, load or device run was repeated.

**Approved narrower scope:** The owner subsequently approved the
[bounded operational check](mobile-image-operational-rehearsal.md) for individual case
admission and deferred the full capacity/cost rehearsal. The tooling and release-policy
amendment remain local. Matching native/live/iOS/Android evidence is still required;
operational qualification keeps capacity and universal claims closed. No new live result
or release record has been manufactured by this change.

**Latest live attempt, 2026-09-27:** The owner's existing Analytics Read key works for
direct SQL and GraphQL access. All three bounded scenarios completed. Cold and warm
passed every declared operation; mixed passed all uploads, controls and probes but
only 88 of 96 preview operations. Both regeneration seeds later became ready after
roughly 18–20 seconds, beyond the harness's short retry period. The settled export
also contained six sampled image-accounting groups, which the strict builder refused.
No qualifying instrumentation or load report was produced. See the
[results and preserved failed evidence](mobile-image-operational-results-20260927.md)
and [access preflight](mobile-image-operational-preflight-20260927.md). Physical phones
are unavailable. Retry/readiness behavior and exact telemetry need reviewed software
work before a fresh rehearsal; device, capacity and universal claims remain closed.

## Resume from GitHub

```sh
git clone --branch codex/mobile-image-compatibility https://github.com/henryperkins/candidary.git
cd candidary
git status --short --branch
npm ci
node scripts/lock-image-decoder.mjs --verify
node scripts/verify-mobile-image-corpus.mjs --check-manifest
```

Read `AGENTS.md`, this document, and the current-status header of
[the preview runbook](mobile-image-preview-release.md) before continuing. The corpus
check distinguishes structural validity from qualification: missing native/reference,
device and load evidence must remain visible, even when the live lane passes.

## Completed work and identities

| Item | Recorded result |
| --- | --- |
| Branch | `codex/mobile-image-compatibility` |
| Deployed runtime checkpoint | `be6811c4beb9cb113ffb446deec9acebfe14759b` |
| Preview origin | `https://candidary-preview.lfd.workers.dev` |
| Preview Worker version | `2c42b186-3b75-4d30-81ea-982fcb579079`, verified at 100% traffic with all five Workflows |
| Private decoder | `candidary-image-decoder-preview`, version `ca4d8ff4-831d-4e92-867c-eafc806277f4` |
| Decoder fingerprint | `a4c238603f67f9c7ebfd9796fe4c722b773f75611b19d6c5b403db7fd8418651` |
| Decoder image | `registry.cloudflare.com/a77e479f6736120eadd99973dbeb705e/candidary-image-decoder@sha256:d014ac551e24b9ce74737a4aebdd9c2f7d0ba0d4e50a2a87bd5fa4c5d3b82f80` |

Complete ZIP exports exhausted Worker API requests because small R2 fragments caused
repeated D1 ownership checks. The fix extends the existing Album export mechanism for
bounded 1 MiB source reads to complete exports. Ownership/deletion fences and
selection-v1 expiry checks remain intact. The focused export union passed 20/20,
recorder unit tests passed 49/49, and build/PWA verification passed before deployment.
Independent code review had no Critical/Important issue; an exact ZIP filename assertion
was recorded as a deferred Minor note. These are prior results, not reruns for this handoff.

The fresh dedicated preview event passed all 39 fixtures across 29 cases: 23 direct and
16 resumable uploads. Original, ZIP and restored hashes matched; private access,
Trash/Restore and deletion checks passed without runtime or cleanup failure. Independent
evidence/records review passed. D1 cleanup observations found all 39 media records deleted,
none in Trash and guest uploads closed. The complete export was Ready with 176,437,716
original bytes processed; the export artifact remains retained. The previous event and
failed export were preserved.

The current evidence checkpoint commits all 39 live manifest pointers and the exact
hash-named report. It does not change runtime code or claim a new preview deployment.
No production deployment or merge was authorized by the commit/push request.

## Evidence available from this clone

- [Reviewed live report](../../tests/fixtures/mobile-images/evidence/f99ae2d2082638007282a2704132379291f348f78ca3bfe377551de59625900f.json):
  SHA-256 equals its filename. `.gitattributes` preserves its bytes on Windows and Linux.
- [Recovered native report](../../tests/fixtures/mobile-images/evidence/9083069a702632a78ba8a663d9b0d7d36266a20ab4363b6561f3f9b17548d4fe.json)
  and [historical qualification report](../../tests/fixtures/mobile-images/evidence/38530b5b38fe2fab1c31bc0a8b54a5888c04268e84b73559640decfd91bc2a55.json):
  exact hash-named bytes recovered on Windows and explicitly allowlisted for the next
  commit. The qualification report pins an earlier manifest and is not a final release gate.
- [Historical evidence archive](evidence/mobile-image-preview-be6811c.tar.gz): build,
  deployment, cleanup, focused verification, independent reviews, corpus output and
  manifest/runbook snapshots from the completed preview continuation. SHA-256:
  `8bd890fdd3fa870bc5b8c54a64121765096c8129b10fbd63d58e2e635bc0b776`.
- [Fixture provenance and reproduction](../../tests/fixtures/mobile-images/README.md):
  source URLs, licenses, pinned original/reference hashes and exact reference-tool requirements.

Extract the archive into a separate directory to avoid overwriting current tracked files:

```sh
mkdir -p output/verification/mobile-image-historical-evidence
tar -xzf docs/verification/evidence/mobile-image-preview-be6811c.tar.gz \
  -C output/verification/mobile-image-historical-evidence
```

Archive records are historical. Statements such as `branchPushed: false`, an uncommitted
manifest, a pending deployment or a pending review describe the stage when that record
was written; the final independent review and this handoff describe the completed state.
The archive contains no event credentials or authorization files.

Downloaded originals remain outside Git. All 37 distinct originals for the 39 records were
recovered and SHA-verified on the Ubuntu machine; another machine can fetch their pinned
sources using `scripts/fetch-mobile-image-fixtures.py` after installing the exact reference
tools documented in the corpus README. The full fetcher also generates references and
requires those tools, including the documented Windows/WSL Adobe converter for JXL-DNG.
Wikimedia may rate-limit downloads; a failed fetch is not a qualification failure.
Historical native reports and independent references were missing on Ubuntu. They were
subsequently recovered on Windows: the two named reports are now preserved as local
reviewable changes, while original/reference binaries remain excluded from Git. Private
authorization must be provisioned separately when needed.

## Reduced-scope completion, deferrals and release boundary

The [practical acceptance handoff](mobile-image-practical-acceptance-20260927.md) is complete
for the reduced project scope. Existing native/live evidence covers 29 implemented cases;
the [fresh private retrieval observation](evidence/mobile-image-preview-recovery-20260927.json)
records both regenerated previews' byte/hash matches, private response headers and two
signed-out HTTP 401 denials. The earlier eight failed operations remain failed.

The [limited device record](evidence/mobile-image-practical-20260927/device-smoke.json)
records real iPhone 16 Pro / iOS 18.7 / Safari guest-page rendering and required-name
validation, and Samsung Galaxy S25 / Android 15.0 / Chrome guest-page rendering and
synthetic participant-name entry. Exact browser builds were not captured. Both one-minute
trials ended before picker, upload/receipt, private preview, metadata, original download
or save/share verification; those lanes are DEFERRED. There is no end-to-end or
device-qualified pass, and no paid upgrade is required for the reduced goal.

HEIC sequences, Live Photo movie companions, exhaustive device coverage, full capacity/cost
and exact telemetry engineering remain deferred. Keep sampled analytics diagnostic,
`universal: false`, `capacityQualified: false`, historical qualification and candidate
release records unchanged. Production admission/release, D1 changes, merge and deployment
remain separate work with their applicable authorization; practical acceptance does not
satisfy those strict release gates.

Native/reference recovery is already complete in this Windows checkout. Another machine
still needs the ignored originals/references or their pinned reproduction. The recovered
qualification report remains historical because its manifest identity is stale.

## Continuation rules

- The current push authorization covers preserving this branch for another machine.
  It does not authorize load execution, production deployment, merging or history rewrite.
- C1 was already pushed. Do not replay historical `git reset --soft` or “never pushed”
  instructions lower in the old runbook. Compare later records-only changes against
  `be6811c`, because it includes the runtime fix. Use the planned GitHub squash merge after
  qualification; a history rewrite requires separate authorization.
- Preview has schema 0026 and extended writes. Rollback must retain schema-26-compatible
  readers, exports and cleanup; do not deploy a pre-0026 Worker or restore/drop the schema.
- Reuse successful focused evidence unless changes or failures justify more checks.
  Follow AGENTS.md for proportional independent review and commit boundaries; repository-wide
  gates require an explicit user request.

## Copy-ready continuation prompt

```text
Continue Candidary mobile-image compatibility qualification on
the preserved isolated worktree, currently codex/mobile-image-qualification-recovery.
Read AGENTS.md, docs/verification/mobile-image-practical-acceptance-20260927.md,
docs/verification/mobile-image-handoff.md and the current preview-runbook header.

The branch contains deployed runtime checkpoint be6811c4beb9cb113ffb446deec9acebfe14759b
and committed live evidence. Preview passed 39/39 fixtures. Windows native/reference
recovery is complete and recorded in docs/verification/mobile-image-recovery-20260927.md;
those recovery changes remain local until separately committed/published. The owner
relaxed project completion to broad iPhone and Android photo support across 29 implemented
cases. Reuse existing focused evidence unless a change requires new checks.

Retain the successful authorized private retrieval of both regenerated previews and
the completed limited BrowserStack iPhone Safari / Android Chrome observations.
Picker, upload/receipt, private preview, metadata, original download and save/share
remain deferred after both one-minute trials ended. No device-qualified pass is claimed.
Paid access and full device certification are not prerequisites for the reduced-scope
engineering/evidence handoff. The historical operational attempt remains FAILED.
Sampled analytics is diagnostic only. HEIC sequences, Live Photo movie companions,
exhaustive device coverage, full capacity/cost and exact telemetry engineering are deferred.
Keep universal:false and capacityQualified:false. The strict verifier remains unchanged
and is not a reduced-project-completion blocker. Preserve schema 0026 compatibility,
candidate-state restrictions and separate release/publication authorization boundaries.
Do not replay historical reset instructions, fabricate evidence or expose credentials.

Report exact completed work, evidence, remaining blockers and next actions.
```

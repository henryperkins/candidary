# Mobile image compatibility handoff

Updated 2026-09-27 for the owner's instruction to commit and push local work so it can
be resumed on another machine. This branch contains the runtime fix and the subsequent
evidence checkpoint. Preview observations below were verified on 2026-09-26, not rechecked
against Cloudflare during this Git handoff. Release qualification remains incomplete.

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
Historical native reports and independent references were already missing on Ubuntu and
are not included here. Private authorization must be provisioned separately when needed.

## Remaining work, in order

1. Recover native reports and independent references from the previous checkout at
   `C:/Users/htper/.codex/worktrees/mobile-image-compatibility/candidary`, especially ignored
   `tests/fixtures/mobile-images/evidence/`, `references/`, and native task output. The
   current manifest references native report
   `9083069a702632a78ba8a663d9b0d7d36266a20ab4363b6561f3f9b17548d4fe.json`;
   qualification configuration references
   `38530b5b38fe2fab1c31bc0a8b54a5888c04268e84b73559640decfd91bc2a55`.
   If unavailable, regenerate with the pinned decoder and independent reference tools.
   Do not fabricate records or change reviewed hashes to conceal missing evidence.
2. Prepare [the load rehearsal](mobile-image-load-rehearsal.md): cold, warm and mixed
   scenarios, 13 dedicated events, idle preview, suitable bandwidth, three expiring
   authorization files and an Account Analytics:Read token. The documented workload is
   approximately 1.07 TB upload plus 1.07 TB download. Scenario execution and cleanup
   require their documented authorization. Reduced workloads do not qualify the full lane.
3. Complete [physical-device testing](mobile-image-device-protocol.md) with a human tester,
   capture consent, iPhone Pro and suitable Pixel/Samsung hardware. Emulation is insufficient.
4. Resolve `heic-sequence` with a lawful source and independent reference, and
   `live-photo-camera` / `live-photo-library` with physical observations. Universal
   compatibility remains unverified.
5. Finalize only cases whose required native, live, iOS, Android and load evidence passes;
   regenerate qualification hashes and prepare the final release checkpoint. Candidate
   admission/release records must not merge as-is. D1 changes, merge and production need
   their applicable authorization.

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
codex/mobile-image-compatibility. Read AGENTS.md,
docs/verification/mobile-image-handoff.md and the current preview-runbook header.

The branch contains deployed runtime checkpoint be6811c4beb9cb113ffb446deec9acebfe14759b
and committed live evidence. Preview passed 39/39 fixtures; physical devices, load,
historical native/reference recovery and three compatibility cases remain incomplete.
Reuse existing focused test evidence unless a change requires new checks.

Start with native/reference recovery from the previous Windows checkout or backups.
Then prepare load and device lanes, identifying external inputs and scoped authorization
still required. Preserve schema 0026 compatibility and candidate-state restrictions.
Do not replay historical reset instructions, fabricate evidence or expose credentials.
The Git handoff approval does not authorize load, merge, rewrite or production.

Report exact completed work, evidence, remaining blockers and next actions.
```

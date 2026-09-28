# Mobile image recovery and lane readiness — 2026-09-27

**Later scope amendment:** Following this recovery, the owner approved the
[bounded operational profile](mobile-image-operational-rehearsal.md) and deferred the
full capacity rehearsal. The full-load preparation below records the earlier recovery
checkpoint. Use the operational runbook for current qualification scope; the recovered
hashes and historical verifier results below are unchanged.

Local recovery resumed from published checkpoint `270104ee417d9107a212ae394029c223d3a4f403`.
The original Windows checkout still held the native reports, originals and independent
references missing from the Ubuntu handoff. Their recovery does not constitute a new
decoder run, preview deployment, load run or physical-device result.

## Git state

The local `codex/mobile-image-compatibility` branch at `136be2f` and published fix `be6811c`
both descend directly from `495587a`; the local branch cannot fast-forward to `270104e`.
The local branch was preserved. Work continues in the existing isolated worktree on
`codex/mobile-image-qualification-recovery`, starting at `270104e`. No history was rewritten.
These recovery changes are local and have not been committed or pushed.

## Recovered evidence

| Artifact | Result |
| --- | --- |
| Manifest originals | All 37 distinct files for 39 fixture records exist and match pinned SHA-256 |
| Independent reference images | All 39 exist and match pinned SHA-256 |
| Native rendering report | `9083069a702632a78ba8a663d9b0d7d36266a20ab4363b6561f3f9b17548d4fe.json`, 60,253 bytes; SHA-256 equals filename |
| Historical qualification report | `38530b5b38fe2fab1c31bc0a8b54a5888c04268e84b73559640decfd91bc2a55.json`, 1,058 bytes; SHA-256 equals filename |

The native report records 39 passing fixture results, the expected missing HEIC-sequence
result, no runtime/cleanup failure, and the pinned decoder fingerprint `a4c23860…`.
It is recovered historical execution evidence. The qualification report pins an earlier
manifest, before the successful live pointers were recorded. Its hash is intact, but it
is not current final release qualification; do not repoint or regenerate it merely to
make a gate pass.

Both reports are preserved byte-for-byte under `tests/fixtures/mobile-images/evidence/`.
The fixture ignore file allows only these two reports and the existing reviewed live
report; `.gitattributes` preserves their raw bytes. Originals, reference images, other
evidence, device captures and private authorization remain ignored. Another machine still
needs the originals/references, using the pinned reproduction procedure in the
[corpus README](../../tests/fixtures/mobile-images/README.md).

Detailed local inventory, command outputs and review notes are under the ignored
`output/verification/mobile-image-recovery-20260927/`. Existing runtime tests and native
rendering results were reused; repository-wide gates were not rerun.
Fresh independent reviews of native recovery and lane preparation found no Critical or
Important issues. The lane review's Minor scope clarification is reflected below: the
full load gate is separate from continuing recovery and functional/device checks.

| Focused check | Fresh result |
| --- | --- |
| `node scripts/lock-image-decoder.mjs --verify` | Exit 0; pinned fingerprint `a4c23860…` |
| `node scripts/verify-mobile-image-corpus.mjs --check-manifest` | Exit 0; structure valid, 29/32 locally qualified, `complete: false`; all 32 end-to-end cases remain incomplete |
| `node scripts/verify-mobile-image-release.mjs --local` | Exit 1; `valid: false`, zero admitted, `universal: false`; default evidence root does not contain the qualification report |
| Release check with `--evidence-root output/verification/mobile-image-release-evidence` | Exit 1; recovered historical qualification fails with `Qualification identity/manifest mismatch.` |

The explicit-root check used the surviving historical evidence directory after a
byte-checked copy of the current live report was added there. Preserving the historical
qualification under `evidence/` for review does not make the release CLI's default root
resolve it. Neither release check is a pass, and no release record was changed.

## Load preparation

The full workload is not needed to recover artifacts or continue functional and device
verification. It measures event-scale behavior, resource isolation and cost. The current
release verifier nevertheless requires this exact load evidence for new-case admission;
a smaller operational check would require an explicitly revised release qualification
policy and must not be described as a pass of the existing full-load gate. No such policy
change or live load execution was made during this recovery.

All three no-network harness dry runs succeeded:

| Command | Declared logical operations |
| --- | ---: |
| `node scripts/mobile-image-load-harness.mjs --scenario cold` | 58,270 |
| `node scripts/mobile-image-load-harness.mjs --scenario warm` | 48,270 |
| `node scripts/mobile-image-load-harness.mjs --scenario mixed` | 58,290 |

The ignored prepared source manifest exists, and its four source files and two JPEG
controls exist at their recorded paths. This preparation checked their presence, not
their hashes. The live adapter rehashes them before its first request. No load credential,
authorization, observation or final report files were found in the inspected local load
directory. No Cloudflare state was rechecked during this recovery.

The [load runbook](mobile-image-load-rehearsal.md) remains the execution authority. Its
concrete prerequisites are:

- A load host and idle preview window for approximately 1.07 TB upload and 1.07 TB
  download, plus variable previews/controls; reduced workloads do not qualify.
- Thirteen dedicated preview events: six gallery events shared across scenarios, six
  upload events for mixed, and one isolation event. Create them through the normal host
  flow and store credentials only in the ignored private directory.
- Three scenario authorizations tied to those events and operation counts, expiring
  within 72 hours; an Account Analytics: Read token supplied privately for metrics export.
- Fresh deployed-version/admission checks before execution, at least 15 minutes between
  cold, warm and mixed, and the documented authorization for eventual event cleanup.

The full local preparation packet is `output/verification/mobile-image-recovery-20260927/lane-readiness.md`.
No load scenario, event creation, Analytics export or cleanup was performed.

## Device and source inputs

The [physical-device protocol](mobile-image-device-protocol.md) needs a consenting human
operator, a suitable iPhone Pro with a Mac for Safari inspection, and suitable Pixel or
Samsung hardware with Chrome USB inspection. Exact model, OS/build, browser and camera
settings must be observed. Device availability is pending; neither device lane has run.
The protocol provides the selection observer, private run-directory layout, observation
form and local recorder command. It checks original/ZIP/restored/handoff bytes, privacy,
deletion and interrupted transfers. Emulation does not satisfy these requirements.

`heic-sequence` still needs a source with explicit media rights or a consented
platform-produced HEICS, followed by an independent reference. Prior B11/B13 source
searches are recorded in the compatibility report and were not repeated. The two
Live Photo cases need consented still/movie pairs and physical chooser observations.

The next work is to supply those external inputs and perform the remaining lanes under
their documented scope, then regenerate final qualification only for passing cases.
Candidate release records remain unsuitable for merge. Schema 0026 compatibility and
the handoff's merge/production/history boundaries remain in place.

# Mobile Image Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver unchanged mobile originals and authorized previews for the complete approved scope; make a universal claim only when the complete evidence supports it.

**Architecture:** Three independently testable plans replace the rejected nine-task draft. A fixes current formats. B builds a separate private decoder Worker and preview twin. C adds transport, storage and admission, developing against B's contract double while real codec qualification is unavailable.

**Tech Stack:** React/TypeScript/Hono, Workers/D1/R2/Workflows, Vitest and Playwright. B alone adds Containers, Durable Objects and native libraries.

**Spec:** [Design and review amendments](../specs/2026-09-23-mobile-image-compatibility-design.md).

**Status (2026-09-26):** Revised plan and review amendments approved on 2026-09-23; local implementation and Linux native execution are authorized. Local A/B/C implementation passed independent review. C14 fixes the focused mobile-script lint errors; B9 prepares the declared load sources; B10 closes the lawful phone JXL-DNG gap. The owner approved raising only animated previews to 20 MiB, preserving existing fidelity. B12 applies that limit across native output, Worker transport/storage and the unpublished 0026 constraint; the still cap remains 8 MiB. B12h's rebuilt image (`a4c23860…`) passes all 39 available real-file fixtures in one final union, qualifying 29/32 local cases. All previously passing preview hashes, original bytes, references and tolerances are unchanged. The fresh B12/B12h scoped review found no Critical, Important or Minor findings. HEIC-sequence and both Live Photo cases remain missing; the report deliberately stays incomplete. A fresh clone after the eventual release commit must reproduce the new fingerprint with the existing `-text` attributes. Remaining work: lawful sequence/device evidence, resolution of the draft publication sequence's conflict with the single-final-commit rule, and separately authorized publication, migration, deployed/load and physical-device checks. Later on 2026-09-26, C16 showed that no honest preview path keeps the literal single-final-commit rule, and rewrote the preview runbook as an executable checkpoint-then-squash sequence awaiting approval. The same task ran a read-only preflight: preview D1 has only 0026 pending, and its schema is semantically equal to the reviewed 0025 snapshot. C18 adds the missing `live-workflow` evidence recorder. B13 found no new lawful HEIC-sequence source. Release lists remain empty and universal compatibility is unverified. See `docs/verification/mobile-image-compatibility.md` and the task ledger under `output/verification/mobile-image-tasks/`. Nothing is staged or committed.

**Checkout:** `C:/Users/htper/.codex/worktrees/mobile-image-compatibility/candidary`, branch `codex/mobile-image-compatibility`, baseline `eceb4053b572562ed00247a7c6469a2599416723`.

## Global Constraints

- Original bytes/SHA-256 survive storage, retrieval and ZIP export. Record chooser conversion before the app receives the File separately.
- Session/event/origin/CSRF/intake/quota/expiry/deletion remain authoritative. Delivery, Album and publication remain independent.
- Existing ingress keeps its **20 MiB (20 × 1024 × 1024 bytes)** ceiling and decoder independence. **8 MiB** is a part size, not the threshold for rerouting current uploads.
- One decode per container instance, with separate upload and preview pools. No Container or Durable Object in the main Worker.
- Required families/variants remain those in the spec. Missing, failing and platform-limited results do not relax the universal claim.
- Separate known formats, admitted uploads and readable stored originals. Closing intake preserves historical reads/exports.
- New canonical previews require durable inventory, suppression and deletion fencing. Never serve an original as a preview fallback.
- Processing acknowledgement is not delivery; preview readiness is separate. Public views stay allowlisted.
- Migration **0026** preserves **29 media columns**, indexes/triggers, promotion FK, counters, sequences, recovery and export holds. Migrate before new main-Worker code.
- Preserve unrelated work. No intermediate staging/commits. Save task deltas under ignored `output/`; at most one final scoped commit for the authorized handoff.
- Run named focused tests and compiler/binding checks. Publication follows the separate repository gates; implementation does not authorize push, deployment or remote migration.

## Review Focus

1. Missing MIME, misleading names and metadata beyond 64 KiB: A1–A3.
2. Decoder outage breaking today's 12 MiB JPEG/HEIC or public copy advertising disabled types: A1, C2, C6.
3. Slow transfers/lost responses producing expiry, duplicate receipts or immortal reservations: C3–C4.
4. Late multipart completion/preview writes after deletion: C1, C3–C5.
5. Single-instance contention, self-reported capabilities or platform limitations presented as proof: B2–B6, C7.

## Execution map

| Plan | Deliverable | Without Docker |
|---|---|---|
| [A — Existing-format fixes](2026-09-23-mobile-image-a-existing-formats.md) | MIME fallback/matching, bounded inspection, neutral thumbnails | All tasks |
| [B — Private decoder](2026-09-23-mobile-image-b-decoder-service.md) | Separate Worker/twin, raster/RAW build, protocol, pools, capacity evidence | Contract/config tests; native checks need an engine |
| [C — Transport and admission](2026-09-23-mobile-image-c-transport-admission.md) | Multipart, preview ownership, migration, consumers, release controls | All development against the protocol double; no admission without real qualification |

Do not execute the old draft. Its historical copy is `output/verification/mobile-image-plan-review/original-plan-before-review.md`. A may have its own separately authorized release while B/C continue; that does not finish the universal objective or authorize intermediate commits here.

Native remains recommended: shared implementation context and one fresh independent review at the end. Subagent-driven execution follows AGENTS.md's one fresh implementer/reviewer per task, reusing successful evidence.

## Shared semantics

A owns format/declaration/evidence types in `shared/image-formats.ts`. B1 owns `shared/image-decoder-contract.ts`. C2 owns guest-safe `shared/mobile-image-contract.ts`. Producing tasks define exact signatures.

Explicit sequence MIME requires actual sequence evidence. Ordinary HEIC/AVIF/GIF/WebP MIME is sequence-unspecified, not a still-only promise: animated bytes require the admitted animation case and verified frames/timing. A keeps legacy behavior available without claiming animation certification. Motion Photo stills and paired Live Photo resources have separate observations.

The registry describes known formats. A leaves `SUPPORTED_IMAGE_TYPES` as the existing seven-entry admission list. C intersects a reviewed per-case release contract, runtime readiness and a D1 switch that can only narrow it. Cases receive `pass`, `fail`, `missing` or `platform-limited`; only qualified cases open. A chooser returning no Live Photo sidecar does not disable ordinary qualified JPEG/HEIC intake, and does not pass the paired-resource requirement.

The **universal claim gate is separate and stays closed** while any required case is missing, failing or platform-limited. Do not assume all web choosers have the same limitation. Read/export support uses a versioned readable-format set and stored-object proof, never the current intake switch. Static pages keep conservative baseline copy; event-specific copy reflects effective admission.

## Release order and topology

1. Complete local work/review; separately satisfy `docs/deployment.md` gates when publication is requested. No new candidate/build-manifest ceremony.
2. Inspect preview's pending ledger and recreated-trigger schema against the reviewed snapshot. Apply 0026 before new main-app code. Prove current `eceb405` code still operates on populated upgraded data with new intake closed.
3. Deploy B's private preview twin independently from a pinned registry image. Verify registry digest, baked fingerprint, codec cases and pools. Account for non-atomic Container rollout and mixed eligible fingerprints.
4. Publish the main-app branch preview through existing `versions upload --preview-alias`. Main config gains a service binding and upload Workflow, never Containers/DOs. Complete private transforms, dedicated-event load and physical-device proof.
   **Correction, 2026-09-26 (C16), awaiting the owner's approval:** an alias version cannot run Workflows, because `versions upload` never registers them. The live lanes therefore need the clean candidate commit deployed to `candidary-preview` with `deploy:preview-cutover:built`. That in turn needs a commit before the final one; see the decision in `docs/verification/mobile-image-preview-release.md`.
5. For production, compare schema/ledger and migrate first while old-code compatibility holds. Deploy/verify the private production decoder. Merge the reviewed main-app head through the existing single-build release; verify service/Workflow topology.
6. Open only qualified cases. A D1 switch closes new extended intake immediately. Accepted transfers retain pinned qualification unless deliberately fenced for an unsafe build. Reads, exports and cleanup remain operational.
7. Rollback closes intake and retains a schema-26-compatible reader/export/cleanup version. Old 0025 code is proved compatible only before new-format/preview writes; it is not a rollback target afterward.

Schema readiness is explicit: 0026 creates protected singleton `mobile_image_schema(version=26, protocol=1)`. Check marker plus required tables/columns; missing readiness closes extended intake without disabling baseline uploads.

## Evidence and task review

A/C name `npm run typecheck`; C also names `typecheck:e2e`, `verify:bindings`, deploy and topology tests. B has isolated compiler/binding checks. Reuse unchanged successful results across reviewers. UI tests follow the plain `vite.library.config.ts` API-stub pattern, with no hidden Worker/D1/secrets/Docker startup.

A1 creates `scripts/capture-mobile-image-task.mjs`. `--plan A --task A1 --phase before|after` snapshots allowlisted tracked and untracked content, hashes and binary-capable deltas under `output/verification/mobile-image-tasks/`. Compare each task's own before/after snapshots, not HEAD; never stage to take a snapshot. Keep its focused logs alongside the delta.

[Review disposition](2026-09-23-mobile-image-review-resolution.md) maps all findings and qualified recommendations. Docker currently blocks real B qualification, not A or C contract development. Real AVIF fails in the bundled HEVC-only utility; candidate fixtures are not live/device proof. The complete goal remains unverified.

## Sources

- [Container deploy/version behavior](https://developers.cloudflare.com/containers/guides/deploy/).
- [Container routing](https://developers.cloudflare.com/containers/configuration/scaling-and-routing/).
- [Container local development](https://developers.cloudflare.com/containers/guides/local-dev/).
- [R2 multipart and configurable lifecycle](https://developers.cloudflare.com/r2/objects/upload-objects/).

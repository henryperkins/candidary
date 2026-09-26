# Mobile-image plan review disposition — 2026-09-23

The user's pasted review was checked against baseline `eceb405`, the deployment/operations/design documents, actual consumers and current primary Cloudflare documentation. This is a document revision, not implementation or runtime certification. No application tests or new container build were run for the revision.

The old nine-task draft is replaced by the [coordinator and A/B/C plans](2026-09-23-mobile-image-compatibility.md). Its pre-review copy is retained under ignored `output/verification/mobile-image-plan-review/`. The [specification](../specs/2026-09-23-mobile-image-compatibility-design.md) preserves original approval history and labels review amendments as proposed.

| Finding | Disposition and owner |
|---|---|
| 1. Container in main Worker breaks preview/upload-only/test/dev paths | Accepted. B5 owns separate private production/preview services and DO classes. C7 adds only a main service binding and exact topology checks. Existing main version-upload paths remain intact. |
| 2. Release order/schema marker | Accepted. Coordinator and C1/C7 require migration first, populated-upgrade old-code proof and explicit protected `mobile_image_schema(version=26, protocol=1)`. |
| 3. One slot, no preview reuse, missing load measurement | Accepted. B5 separates two pools with multi-instance routing/failover; C5 persists upload-time output through ownership/tombstones and coalesces missing-preview work in a durable Workflow; B6 adds mixed/cold/warm event go/no-go. One active decode remains a per-instance resource rule. |
| 4. Fixed 15-minute expiry | Accepted. C3 defines size-aware idle lifetime, accepted-part/processing extension, synchronized media/promotion horizons, six-hour/access hard cap and 1/5 Mbit/s clock tests. |
| 5. Existing uploads gain decoder dependency/new types bypass decoding | Accepted. A/current <=20 MiB ingress remains independent. C2 explicitly rejects new-family/transfer-owned reservations at the old content endpoint. |
| 6. Missing export/device/preview/public consumers | Accepted with a qualification: C5 names content/album-preview/album-share; C6 names both selection export checks, photo-export lease/stream checks, device helper, agent markdown/site copy/operations. Public intake copy uses admission; historical read/export uses a stable readable set so the kill switch cannot strand files. |
| 7. All-or-nothing admission, Live Photo, D1 switch | Accepted with evidence qualification. C2 opens individual qualified cases through a narrowing D1 switch. C7 retains missing/fail/platform-limited outcomes and a separate strict universal claim gate. A web chooser's sidecar limitation must be observed for the tested platform, not assumed universal. |
| 8. Circular digest/self-certified cases | Accepted. B2 bakes a pre-build source/dependency fingerprint; external qualification records bind it to registry digest/cases. Health only identifies the build. |
| 9. Unsupported UI vocabulary | Accepted. C6 uses confirming and needs attention from `design/design-system.md`; no new upload-state enum. |
| 10. Playwright bootstraps Worker/secrets | Accepted. C7 uses a new plain Vite config following `vite.library.config.ts` and labels API-stub evidence. |
| 11. Migration precedents/live schema drift | Accepted. C1 uses 0002/0023 deferred-FK precedents, actual D1 upgrade helpers, full preservation checks and a read-only production schema comparison before migration. |
| 12. Multipart assembly simplification | Accepted with lifecycle qualification. C3 uses multipart at a unique assembly key and removes standalone part objects. It retains D1 part proofs, upload IDs, create intents and completion/abort cleanup inventory. Seven-day auto-abort is configurable and cannot prove a raced completed object was deleted. |
| 13. Split, focused checks, Docker independence, task diffs, invented machinery | Accepted. A/B/C separate release units; B decomposes protocol/baseline raster/HEIF-AVIF/JXL-JP2/RAW/rendering/pools/load. C6a/b/c separately review client, exports and copy. C can use B1 doubles while Docker is unavailable. Compiler/binding/deploy/topology checks are explicit; snapshots include untracked files without staging. No main-app candidate/build-manifest mechanism is introduced. |

## Smaller findings

| Finding | Resolution |
|---|---|
| Missing-module RED is a harness error | A1/B1 require compile-valid exports before behavior assertions. |
| Empty-preview test fails for missing headers | B1 starts with a valid control and changes only body/length; all proof/protocol headers remain valid. |
| Sequence direction unspecified | Coordinator/A1/A3 define explicit-sequence requirements versus ordinary sequence-unspecified MIME. C2 gates animation separately from still qualification. |
| Tests cannot enable closed admission | C2 adds a compile-time-only Vitest switch modeled on the existing release override. |
| Workflow identity/dispatch absent | C4 names class, binding, env names, payload, stable ID and `createBatch`/lookup semantics from `worker/workflows/cover-platform.ts`. |
| Upload hooks and EXIF files missing | A2/A4 and C6 name `exif-capture-time.ts` and both upload-session hooks. |
| Nonexistent Album PDF | Removed; C5 states actual preview/share consumers only. |
| Animated preview cap absent | B4 specifies 16 MiB animated output and 8 MiB still output, with refusal counted as failed qualification. |
| Docs/CLAUDE missing | A4 and C6/B6 update deployment, operations, public copy and agent guidance in their owning implementation tasks. |

## Verification and qualifications

- Source inspection confirmed main `deploy-built.ts` version uploads, strict Workflow topology, migration-first documentation, the 15-minute reservation/refresh query, every cited export/preview consumer, public format text, design-state vocabulary and plain Vite precedent. Reused the earlier exact-baseline schema inventory; did not rerun an unchanged schema audit merely to duplicate the review.
- Current Cloudflare deployment docs confirm version uploads do not publish Container images and DO/Container Workers do not receive version URLs. Local Container development requires an engine. These support isolating the service, regardless of future Vitest changes.
- The linked workers-sdk PR describes current Container-test limitations; no claim is made that an unmerged upstream change is installed in this repository. Main tests use a Fetcher double and B pool tests use injected stubs.
- Original source bytes, create-only final writes, independent privacy states, no chunk reuse of `source`, runtime DNG SDK activation and strict evidence labels are retained.
- This revision is ready for another plan review, not an assertion that every decoder dependency or resource policy has been qualified. Real Docker/native, service, event-load and physical-device evidence is still missing.

## Primary sources checked

- [Deploy Containers](https://developers.cloudflare.com/containers/guides/deploy/)
- [Scaling and routing](https://developers.cloudflare.com/containers/configuration/scaling-and-routing/)
- [Local development](https://developers.cloudflare.com/containers/guides/local-dev/)
- [Container environment variables](https://developers.cloudflare.com/containers/configuration/environment-variables/)
- [R2 multipart sizes and lifecycle](https://developers.cloudflare.com/r2/objects/upload-objects/)
- [Workers SDK Container test support proposal](https://github.com/cloudflare/workers-sdk/pull/15695)

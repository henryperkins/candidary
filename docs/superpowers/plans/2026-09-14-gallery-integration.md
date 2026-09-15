# Gallery integration implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Integrate the useful fixes from `cdb1a9e` into the current Library, Album, and guest gallery work, then commit and push `main` as authorized.

**Architecture:** Preserve the current AlbumDelivery and Library Exports interfaces. Port bounded timeline repair and run-wide archive numbering into the existing maintenance and streaming workflow. Project expired downloads using the existing export state contract and admit their retry through the existing atomic ownership fence.

**Tech Stack:** React, TypeScript, Cloudflare Workers/D1/R2, Vitest, Playwright.

**Spec:** User-approved recommendation following the read-only assessment of `fix/gallery-review-standalone-four` against `5007de4` and the current uncommitted gallery changes.

## Global constraints

- Preserve all pre-existing work; stage only explicit gallery implementation, tests, migration, and this plan.
- Keep selection export source validation, cancellation, ownership, and replay handling intact.
- Execute in the current worktree, with an external backup before editing. Make one final commit and a normal push to `main`.
- Use focused checks only. Do not deploy, clean up branches, or run repository-wide gates.

## Tasks

- [x] Back up the current changes and add failing tests for archive numbering, scheduled repair, and elapsed-ready retry.
- [x] Port the backend fixes; preserve exact-attempt cleanup and atomic retry admission.
- [x] Pass management deadlines through the current Library and Album interfaces, with focused UI regression tests and no stale download links after expiry.
- [x] Verify export unit tests; export API, workflow ownership, cleanup ownership, progress, photo archive, and guest pagination Worker tests; focused hourly cleanup; gallery hardening, guest pagination, export presentation, and Album delivery/save integration UI tests. Run scoped TypeScript and lint checks, and inspect desktop/mobile Library and Album delivery.
- [ ] Publication: review the allowlisted diff, commit once, push `main`, and verify the remote commit. The final execution report records publication after it occurs.

## Integration evidence

- 105 tests passed across export metadata, export presentation, Library, gallery hardening, and guest pagination. The 14 export metadata tests passed again after preserving part numbers in long download filenames.
- 130 Worker tests passed across export API, execution ownership, cleanup ownership, progress, selection archive streaming, and guest pagination. The hourly sentinel repair check passed separately.
- Six Album integration checks passed after adapting their controls to the current Download Album, Album settings, and Library Exports interfaces. They retain draft-save, canonical reload, selection, and cross-kind exclusion assertions.
- Scoped app, Worker, and e2e TypeScript checks and lint passed. No repository-wide gate was run.
- Chromium at 320px and 1440px verified ready/expired Library and Album downloads, event-zone deadlines, timed withdrawal of cached links, keyboard focus return, and page containment. Scoped axe checks found no violations; no page or console errors occurred. Manual visual review corrected an inherited two-column Library export layout, and the confirmation pass passed.
- Expiry is recorded with the existing exact-attempt compare-and-swap before retry; the database's allowed state transitions and cleanup ordering remain intact. No export schema migration is required. Guest pagination includes migration `0024` for deployment.
- Browser checks use local route fixtures. Production deployment and assistive-technology testing are outside this integration.

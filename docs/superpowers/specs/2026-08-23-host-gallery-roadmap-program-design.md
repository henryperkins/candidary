# Host Gallery Roadmap Program Design

**Date:** 23 August 2026

**Status:** Approved product direction; slice specifications pending user review

**Source:** [Combined Host Gallery Experience Review](../../../gallery-host-combined-review.md)

**Baseline:** `df2b665` on `main`; 1,407 unit/UI and 1,326 Worker tests pass

## Goal

Resolve the full actionable host-gallery roadmap without replacing Candidary's existing delivery, Album, Guest-gallery, export, navigation, or recovery systems. The work ships as six independently testable vertical slices. Findings already repaired after the review's `9a55a9e` baseline receive regression coverage instead of duplicate implementation.

## Delivery slices

1. [Privacy, recovery, and Manager isolation](2026-08-23-host-gallery-privacy-recovery-design.md)
2. [Audience clarity](2026-08-23-host-gallery-audience-clarity-design.md)
3. [Completion and liveness](2026-08-23-host-gallery-completion-liveness-design.md)
4. [Navigation, responsive behavior, and accessibility](2026-08-23-host-gallery-navigation-responsive-accessibility-design.md)
5. [Lifecycle and contribution](2026-08-23-host-gallery-lifecycle-contribution-design.md)
6. [Scale and resilience](2026-08-23-host-gallery-scale-resilience-design.md)

The slices are ordered. Later slices may consume contracts introduced earlier, but each slice must leave the application deployable and its focused suites green.

## Binding product decisions

- Album links remain live request-time projections. Album membership, metadata, and order changes affect subsequent link reads.
- Hide remains scoped to the Guest gallery. A cross-audience "Withdraw from all guest views" action is deferred to keep the workflow simple.
- An Album link shows a guest-written caption only while that photo's publication state is `published`. `unpublished` and `hidden` captions are withheld; the photo itself remains eligible for the Album.
- A host-deleted original is recoverable until the earliest of 30 days after deletion, the event's existing management-access expiry, or the event's existing purge time. Recovery never outlives the authorization needed to perform it.
- A live Album with no photos retains its URL and renders an intentional empty state.
- Settings remains the sole owner of the Guest-gallery availability toggle. Guest gallery provides a focused route to the setting and an exact return intent.
- Original download and deletion remain owned by Intake. Library may route to Intake but does not duplicate source-file actions.
- The Manager shows the latest dated export snapshot per kind, not a full export-history product.
- Manager section and Gallery mode use query parameters on the existing `/manage/event/:eventId` route.
- Pause becomes upload-only. Existing Gallery, Guestbook, and My deliveries remain readable.
- The broader ownerless-management-link recovery product is out of scope. Manager-link rotation is therefore account-gated: a signed-in owner/cohost can recover from an ambiguous response and rotate again, while link-only access receives the existing account/ownership path instead of risking an unrecoverable replacement.
- Gallery may use one compact state line for Album count, Album-link state, and Guest-gallery state.
- Host-contributed photos use the public attribution `Host`; account names are not exposed.

## Reuse ledger

Implementation must extend these existing mechanisms before considering a new abstraction:

| Need | Existing mechanism to extend |
| --- | --- |
| Guest/host upload queue | `GuestUploadFlow`, `UploadTransport`, `UploadService`, canonical Worker ingress |
| Public Album rendering | `PublicAlbum`, `ResponsiveEventCover`, Album share projection |
| Autosave | `createAutosaveQueue`, `AutosaveStatus`, Album generation guard |
| Navigation settlement | React Router `useBlocker`, `useSearchParams`, `UnsavedSettingsPrompt` |
| Undo | `useUndo`/`UndoBar` in `src/features/gallery/undo.tsx`, wrapped once at Manager scope |
| Announcements | Manager/Gallery visible notice and the single Gallery live region |
| Export cards | `GalleryExportControl`, `AlbumExportControl`, `export-control-status.tsx` |
| Selection | `selection-state.ts`, `SelectionTray`, the 50-action cap |
| Modal focus | The tested `GalleryViewer`/Cover Studio focus and restoration behavior |
| API failures | `ApiError`, `ClientApiError`, `describeLoadFailure`, existing recovery hints |
| Event state merging | `event-merge.ts`, `event-read-guard.ts` |
| Styling | Existing design tokens and responsive rules in `src/styles.css` |

New shared code is justified only when two existing consumers must produce the same contract, such as one public Album projection for Preview and the live link. It must replace duplication rather than run alongside it.

## Finding ownership

| Slice | Findings |
| --- | --- |
| Privacy and recovery | C-03, C-04, C-06, C-11, C-22, C-35, export/delete retention race |
| Audience clarity | C-01, C-02, C-18, C-20, C-24, C-28, C-29, C-30, C-31, C-39, C-40, C-48, C-51, C-60, C-65, C-66 |
| Completion and liveness | C-05, C-07, C-13, C-14, C-19, C-25, C-26, C-32, C-33, C-36, C-41, C-42, C-47, C-54 |
| Navigation/responsive/accessibility | C-15, C-21, C-23, C-27, C-37, C-43, C-44, C-45, C-46, C-63, C-64 |
| Lifecycle and contribution | C-08, C-09, C-10, C-12, C-16, C-17, C-49, C-50, C-52, C-53, C-55, C-56, C-57, C-58, C-59, C-61 |
| Scale and resilience | C-34, C-38, C-62 |

No finding is silently dropped. During implementation the program keeps a machine-readable or Markdown verification matrix with one of four dispositions:

- `verified-existing`: current code satisfies the finding and a regression proves it;
- `implemented`: this roadmap changed code and the regression passes;
- `deferred-approved`: cross-audience withdrawal only;
- `out-of-scope-approved`: broader ownerless recovery only.

## Global invariants

- Delivered source existence, Album membership, Guest-gallery publication, and Album-link availability remain separate axes.
- Public and guest responses are positive allowlists; repository records are never serialized directly.
- No UI claims recoverability unless original bytes and required database state can be restored.
- Recoverable trash continues to consume the event's media-count and byte capacity until restoration or permanent cleanup, so a later Restore never fails because the host filled the released-looking space.
- No accepted active export loses a source object because a host later deletes the photo.
- No destructive request is sent before its required confirmation succeeds.
- Existing management URLs, public Album URLs, and printed event credentials remain compatible.
- Existing migrations 0001–0018 are immutable. New schema work uses additive, fresh-D1-verified migrations.
- A panel failure cannot erase unrelated working Manager panels.
- All mobile changes retain at least 44 px targets and no page-level horizontal overflow at 320 or 390 px.

## Additive schema sequence

The slices use exactly three new migrations:

1. `0019_media_recovery.sql`: trash/restore fields, recoverable-capacity counters, old-Worker exclusion markers/invariants, and the exact export-source hold index/tombstone suppression fence;
2. `0020_export_progress.sql`: progress fields/invariants plus the minimal legacy-versus-attempt-v2 execution fence required for migration-first Workflow compatibility;
3. `0021_manager_upload_and_album_era.sql`: server-only account upload-actor identity, the durable per-pick provenance marker, and an event-owned Album-pick generation.

Each runs against a fresh D1 database and an upgraded 0018 fixture. No existing migration is edited.

Migration 0019 deliberately refuses to run while any export job is `running`; deployment waits for the existing Workflow to become terminal and retries the all-or-nothing migration. Migration-first compatibility is required while the 0018 Worker is still serving. After the new Worker admits the first trash write or `attempt-v2` export, the release is forward-fix-only: the standard 0018 code rollback is no longer a valid recovery path because it cannot own attempt-v2 execution. The deploy runbook records a pre-write rollback gate and the verification suite proves both that rollback remains safe before the gate and that forward repair completes/release holds after v2 writes.

## HTTP convention for new routes

Every new Manager JSON route returns `{ data: <payload>, requestId }`; failures use the existing `ApiErrorBody`. Reads call `requireManager`; mutations call `requireManager({ write: true })` before parsing or buffering a body. Success and error responses send `Cache-Control: private, no-store` and `Vary: Cookie`. Existing mappings remain authoritative: `SESSION_REQUIRED`, `SESSION_EXPIRED`, and `TOKEN_REVOKED` are 401; `ROLE_FORBIDDEN` and `ACCOUNT_DISABLED` are 403; `EVENT_NOT_FOUND` is 404; `EVENT_DELETED` and `EVENT_EXPIRED` are 410; writes additionally expose `CSRF_INVALID` and `ORIGIN_FORBIDDEN` as 403. Resource-specific specs define their 409/422 contracts and exact allowlisted payloads.

Changed guest Gallery/contribution/upload responses retain their existing status codes and outer envelopes, replace every nested raw media record with the declared allowlist, and send `private, no-store` plus `Vary: Cookie`. Guest writes continue to validate role/event slug and Origin/CSRF before body ingress.

## Verification ownership

- `tests/worker` owns API envelopes, authorization, D1 transitions/migrations, repository atomicity, Workflow attempt fencing, and controlled R2 races. Race tests use deferred fake-R2/Workflow barriers at named reads and multipart completions; timing sleeps are not correctness evidence.
- `tests/ui` owns React state, StrictMode, focus, announcements, queue behavior, query parsing, selection, and deferred-request generation races with fake timers where time is the contract.
- `tests/e2e` owns real Router history/reload, production-build responsive geometry, keyboard traces, and axe fixtures. Mocked API fixtures prove presentation only; Worker/D1/R2 claims must also have Worker tests.
- A roadmap verification matrix records every C-01 through C-66 plus the export/delete race, its disposition, owning test file, and final command. Broad phrases such as “every modal” or “every destructive action” are expanded into the named matrices in the slice specs before implementation is marked complete.

## Delivery and release gates

Each slice follows test-driven development and its own implementation plan. It runs focused unit/UI, Worker, and Playwright coverage before integration. The completed program runs:

```bash
npm run typecheck
npm run typecheck:e2e
npm run lint
npm test
npm run build
npm run ci:migrations
npm run test:e2e
```

No deployment, remote migration, secret mutation, external message, or pull-request mutation is part of this program without a separate user request.

## Explicit non-goals

- Frozen Album release revisions
- Cross-audience withdrawal orchestration
- A support or unauthenticated ownerless-recovery bypass
- Full export history or audit-log UI
- Duplicating original-file actions in Library
- Replacing the Manager shell, upload queue, autosave queue, Router, or design system

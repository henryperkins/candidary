# Photo export and RSVP review index

Date: 2026-09-12
Status: Approved and implemented locally. Named focused RSVP and export checks and independent task reviews passed; final whole-change review passed with no Critical or Important findings.
Verified baseline: `7990dab` on `main`.

## Current documents

- [RSVP household selection and focus design](2026-09-12-rsvp-selection-and-focus-design.md) — the three verified defects, ownership/focus behavior, existing systems retained, focused verification, and non-goals.
- [RSVP implementation plan](../plans/2026-09-12-rsvp-selection-and-focus.md) — independent host and guest tasks followed by browser proof; unchecked steps have not run.
- [Gallery photo selection and export destinations](2026-09-12-photo-export-design.md) — full-tile selection, source snapshots and holds, card placement, device handoff, and cloud delivery after the September 18 target.
- [Device and selected archive implementation plan](../plans/2026-09-12-gallery-device-export.md) — forward schema, private snapshots and reads, selected ZIP assembly, Gallery controls, and focused browser proof.

The RSVP repair does not wait for export decisions, provider registration, or iPhone acceptance.

## Review dispositions

| Review issue | Recorded decision |
| --- | --- |
| Launch scope | Google Photos and OneDrive are both after September 18, 2026. The date is the target from this conversation's launch brief. No cloud launch claim is authorized by this design. |
| OneDrive app folder | Use delegated Files.ReadWrite and a visible Candidary event folder; disclose the broader permission. App-folder limits are product guidance, not a hard technical prohibition. |
| Destination source hold | Destination jobs use export_jobs and frozen export_media_entries. Extend protocol/state guards; keep one active export per event and the exact-object deletion hold, with bounded expiry and cancellation. |
| Arbitrary selection / Select all | Add a selection kind and dedicated manager route, a forward migration, atomic server descriptor snapshots, and single JSON-array bindings for explicit IDs/exclusions under the D1 limit. |
| Intake/Library boundary and duplicate cards | Amend only the bulk-export boundary; individual source actions remain in Intake. The chooser replaces the action area inside the existing complete/Album cards, and the selection toolbar opens that same chooser. |
| Selection idiom | Library's existing whole-tile pressed button is canonical. Album needs new multi-select; Shared-gallery publication checkboxes are outside scope. |
| Host focus and races | Gate result/error/finally by selection ownership and include delayed write/conflict results. Preserve the existing ID/version/update-time editor key, add normal-open focus, and restore focus on close. |
| Guest focus | Focus explicit lookup/submit/change transitions; automatic session restore and lifecycle changes remain passive. |
| Google storage | Require the storage disclosure for every Google transfer. Google's 25 MB-per-user threshold does not mean every possible transfer exceeds that size. |
| Home Screen and provider grants | Verify both providers in Safari and standalone mode, including separate session stores and HTML callback/error recovery. A dedicated grant key and generated binding/config checks belong to cloud implementation. |
| Evidence and document structure | Tracked regression tests carry the reproduction. Ignored local screenshots are supplemental. Each feature now has its own Goal, Existing systems retained, Verification, and Non-goals. |

The pasted review repeated several bullets and contained a broken sentence around focus/configuration. The complete repeated text and current source were used to resolve those passages. In particular, the editor already has an identity/version key; the correction is focus intent, not introducing an ID-only remount.

## Evidence boundary

Source inspection confirmed the manager detail race, conflict-only heading focus, missing close restoration, and passive guest-stage transitions. Earlier browser discovery used fictional fixtures and an isolated localhost CSP workaround. Those observations are not automated passing results or production/device acceptance.

Implementation is isolated in `.worktrees/rsvp-photo-export` on `codex/rsvp-photo-export` from the verified baseline. The RSVP focused checks passed: 48 host UI cases, 26 guest UI cases, and 6 browser cases across the desktop/mobile projects. Each task passed independent spec and quality review with no open Critical or Important finding. The browser build prerequisite succeeded; existing missing-local-secret/chunk-size warnings and Git line-ending notices remain recorded in the execution evidence. Physical devices, Safari/WebKit, and assistive technology have not been tested.

Device and selected archive implementation is locally complete. Focused export results are 30 contract/verifier unit cases, 12 D1 schema cases, 19 repository cases, 29 private-route/archive/ownership cases, 12 selection/device/chooser cases, 6 targeted surface cases, and 5 browser cases with 5 intentional opposite-project skips. The configured build passed, each task passed independent review, and the final whole-change review passed with no Critical or Important findings. The current automated browser checks use the normal runtime without a CSP bypass. Physical iPhone acceptance remains unchecked in the release record. Direct cloud delivery remains a subsequent phase. No changes have been staged, committed, pushed, merged, deployed, or applied to production; no provider account configuration or remote photo transfer has occurred.

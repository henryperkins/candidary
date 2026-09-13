# Gallery photo selection and export destinations

Date: 2026-09-12
Status: Approved; device and selected archive implementation is locally complete, with named focused checks and independent task reviews passed. Final whole-change review passed with no Critical or Important findings. Physical iPhone and provider acceptance remain unchecked.
Baseline: `7990dab` on `main`.
Related independent repair: [RSVP selection and focus](2026-09-12-rsvp-selection-and-focus-design.md).

## Goal

Let a host tap photos in Library or Album, select the complete chosen result set across pagination, and export the frozen selection to a device or supported cloud destination. On iPhone, hand actual image files to the native share sheet so the host can save them to Photos and organize them into a new or existing personal album.

Google Photos and OneDrive are explicitly **after the September 18, 2026 launch target**. That date comes from the launch brief in this conversation; it is not an independently established repository release date. Neither cloud destination is part of the launch acceptance criteria or launch copy. RSVP repair proceeds independently. Gallery device export also needs its own completed implementation and physical-iPhone acceptance before any launch claim; this design does not promise it will meet that date.

## Existing systems retained

- Originals remain private and manager-authorized. Guest/Album-link readers do not gain access to originals through this feature.
- Library source existence, Album membership/order, Guest-gallery publication, and Album-link availability remain separate axes.
- The existing complete archive and Album archive remain supported, with their dated snapshots, ZIP parts, manifests, and correct Guestbook inclusion/exclusion.
- `export_jobs` and `export_media_entries` remain the authoritative ownership model for accepted source snapshots. Exact bucket generation and object key matter, not just media ID.
- Queued/running jobs retain the database source hold and the current one-active-export-per-event constraint.
- Recovery/deletion stays behind tombstone suppression and `MediaRepository.claimMediaObjectDeletion`. New code must not delete held source objects by calling R2 directly.
- Existing 50-item client and server limits remain on Album/publication editing operations. Export receives a separate request contract.
- Current event expiry, manager access, account/link ownership, CSRF/origin enforcement, private JSON envelopes, no-store/Vary headers, and no-guest-account behavior remain authoritative.

## Product placement and the roadmap amendment

The earlier [roadmap](2026-08-23-host-gallery-roadmap-program-design.md) assigns original-file actions to Intake. The new user instruction explicitly adds **bulk photo export from Gallery pages**. This is a narrow amendment: Gallery receives selection and bulk export; individual original-file download, deletion, and recovery controls remain in Intake.

Current code already places `GalleryExportControl` in Library and `AlbumExportControl` in Album. Preserve those locations. The destination chooser **replaces the prepare/download action area inside each existing card**, using a shared component with the card's source preselected; do not add a third export card beside them. Keep each card's snapshot/progress/receipt context. A selection toolbar opens the same chooser with the selected source, rather than creating a second export subsystem or duplicated card.

The complete card still offers the full archive, including its separate Guestbook artifacts. Every device/cloud photo destination and every selection archive is photo-only. Selecting a destination never changes Album membership or publishes photos. Unsupported native sharing may offer the existing archive fallback in this shared export flow; it does not add individual source-download controls to Library.

## Tap-to-select interaction

`GalleryMoment` is the canonical interaction: its Library photo is already a whole-tile pressed button in Select mode, with an aria-hidden checkmark. Reuse that behavior and visual language. Album currently lacks this multi-select behavior, so adding it there is real work. Shared/Guest-gallery management currently uses separate checkboxes; converting its publication controls is outside this feature.

1. Tap **Select**. Tapping anywhere on a photo selects it; tapping again deselects it. The checkmark indicates state. There is no separate checkbox target and no long press requirement.
2. Keep **Select all**, the selected count, **Clear selection**, and **Save / Share photos** reachable. A selected photo tap toggles exactly once and does not open the viewer. Scrolling does not select photos.
3. **Select all** means every eligible result in the explicitly named Library/Album/filter scope, including unloaded pages. Preserve deselections as exclusions. Show the source and exact frozen count before transfer; reconcile any difference from the earlier live count before the user starts delivery.
4. Outside Select mode, photo viewing remains unchanged. Each selectable tile is one named, keyboard-focusable toggle with pressed state; Enter and Space toggle it. Keep 44px minimum targets and restore focus when selection/export closes.

## Selection is a new export kind

Add `selection` alongside `complete` and `album`, rather than treating a set of IDs as an incidental client state. The existing create route accepts only omitted kind or `album`; its payload remains backward compatible. Introduce a manager-write-authorized `POST /api/manage/events/:eventId/photo-exports` for photo snapshots, using the same private response envelope as other manager routes.

The request is versioned and names its source, target, and idempotency key:

```ts
type PhotoExportSource =
  | { mode: 'ids'; scope: 'library' | 'album'; mediaIds: string[] }
  | {
      mode: 'all'; scope: 'library';
      filter: { query?: string; favorites?: true; order: 'newest' | 'oldest' };
      excludedMediaIds: string[];
    }
  | { mode: 'all'; scope: 'album'; excludedMediaIds: string[] };

interface CreatePhotoExportRequest {
  version: 1;
  idempotencyKey: string;
  source: PhotoExportSource;
  destination: 'archive' | 'device' | 'google-photos' | 'onedrive';
}
```

Use the existing Library query validation and literal-search semantics; reject unsupported filters rather than broadening the source. Album scope means the current eligible Album photo entries in their current order, excluding notes. Selecting a subset in Album remains confined to those entries.

Authenticate and enforce origin/CSRF before buffering the body. Limit the body to 1 MiB and each unique ID/exclusion set to 10,000 UUIDs. Reject malformed, duplicate, cross-event, unauthorized, suppressed, or ineligible explicit IDs with a generic source-changed response; do not leak another event's inventory or silently omit selected IDs. Reject an empty eligible result. A repeated idempotency key with the same canonical request returns the same snapshot; a changed request under that key conflicts.

**All-results selection freezes a server descriptor, not a client enumeration.** In one atomic D1 batch, admit the job, evaluate the validated filter/Album membership at the snapshot timestamp, insert the exact original inventory with `INSERT … SELECT`, and verify count and byte totals. Later additions, reordering, favorites changes, or Album edits cannot change those frozen entries.

For explicit IDs and exclusions, bind a JSON array once and use `json_each` as a set in SQL; never generate 10,000 placeholders. This repository already uses `json_each` for media sets. Admission diagnostics, counts, and per-statement bindings must remain under D1's 100-bound-parameter limit. The server enforces the 10,000-photo event ceiling independently of the editing bulk route. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)

## Job, migration, and source-hold decisions

**Destination jobs are export jobs.** Store the destination on `export_jobs`, defaulting existing rows to `archive`, and use a new execution-protocol discriminator for selection/destination operations. Per-photo delivery state lives in child records keyed to the frozen export entry. Provider credentials live separately and are referenced by the owning job. Do not introduce a parallel job table that bypasses the existing source hold.

This requires a forward migration, not edits to historical migrations or just a TypeScript union change:

- Extend the `kind`, state, and execution-protocol constraints. Add destination, versioned source descriptor, idempotency/digest, initiating-principal identity, and hold-deadline fields. Preserve legacy complete/album rows and their defaults.
- Add terminal `delivered`, `handed-off`, and `cancelled` states. Keep `ready` specific to downloadable artifacts, `delivered` specific to acknowledged cloud items, and `handed-off` specific to device handoff. Do not label a native handoff as a confirmed Photos save.
- Add per-photo destination records with states for pending, uploading, acknowledged, failed, and unresolved; record provider IDs, attempt ownership, and acknowledgments without exposing upload URLs or tokens in public payloads.
- Recreate the applicable 0019 source-admission/retry/kind guards and 0020 execution-transition guards to cover selection jobs and their new protocol. The tombstone hold remains an exact join from entry bucket/key to a queued/running owning export, across every kind/destination.
- Verify photo-only counts and entries on admission and queued-to-running transitions. An entryless selection cannot enter active execution. Selection retry reacquires exactly its old inventory, after proving that inventory is still eligible and unsuppressed; it never re-evaluates a filter into a new set silently.
- Update kind/state/protocol consumers: database types, shared contracts, route projections, archive manifest/Guestbook branching, retry, cleanup, active-job conflicts, and status UI. Legacy card/latest queries continue to receive only their intended archive jobs; a cloud result cannot be mistaken for a downloadable archive.
- Preserve the one-active-export-per-event index/check across complete, Album, selection, device, and cloud work. Show the active operation in a conflict response; require the host to finish or cancel it before another starts. More concurrency is outside this version.

A new snapshot acquires its hold before any source reads or provider delivery. An already-suppressed source rejects admission. A later host trash action may hide the live item, but cannot destroy bytes held by the accepted export. All physical deletion paths, including scheduled cleanup, must continue through the claim and database suppression fence.

Selection jobs waiting for confirmation expire after 30 minutes. Once started, a device job has a 30-minute inactivity deadline, renewable by authenticated progress, with an absolute 24-hour lifetime. A cloud job has a seven-day absolute lifetime so rate-limit pauses are bounded. Every deadline is further bounded by existing management access and event purge; none extends the event's retention. At a deadline, cancellation, or event deletion, retire the execution owner before releasing the hold. Existing lifecycle cleanup must terminate expired selection jobs and release their rows/holds even when the browser or Workflow disappears.

Do not release a hold while an old execution can still read or upload. Each batch/chunk verifies its current attempt owner; finalization and cancellation fence the owner atomically. A late provider acknowledgment may record the actual result for its already-started item but cannot resume a retired job. Downloadable archives retain their existing artifact expiry independently of released source holds.

Migration acceptance includes a fresh database, an upgrade from the current schema with complete/Album fixtures, kind-sensitive triggers, active-hold races, and an old-Worker/Workflow compatibility check. Keep new admission disabled until the migration and supporting Worker/Workflow are installed together under the repository's release procedure. The implementation/release plan must enumerate every affected 0019/0020 trigger and caller; enabling selection with an old consumer is prohibited.

## iPhone and other device sharing

Prepare actual original `File` objects in count-and-byte-bounded batches, preserving original media bytes and embedded metadata. Select all remains selected across batches. Each batch uses `navigator.canShare({ files })`; the native share call is made from a fresh user tap after preparation. The UI shows prepared, handed-off, remaining, and unavailable counts separately. Cancellation retains the current selection and batch. Repeating a handed-off batch is deliberate because Candidary cannot inspect the device library for duplicates. [Web Share API](https://www.w3.org/TR/web-share/)

Use authenticated, same-origin per-entry reads tied to the active frozen job, not public source URLs or current live-gallery enumeration. Keep manager links, signed storage URLs, roster data, and Guestbook content out of the shared payload. A lost permission or expired job stops further reads with a recoverable message. Do not claim background phone transfer after the page closes.

The initial device batch policy is at most 20 photos and 40 MiB of original bytes, with at most two concurrent downloads. Release file references after advancing. A file-share rejection offers a smaller retry batch or the original archive fallback; no format is silently converted or discarded. These are product limits to validate on physical devices, not claimed Safari platform limits. Device acceptance may reduce them before release without reducing the selected result set.

WebKit documents the native Save N images action and fixed its iOS 16 regression in April 2023. That establishes the intended integration path, not fresh device proof for Candidary. Verify JPEG, PNG, WebP, HEIC, and HEIF originals, including mixed batches, on supported iPhones. [WebKit image sharing](https://bugs.webkit.org/show_bug.cgi?id=255641)

Apple documents selection-to-existing-album and new-album creation inside Photos. A Safari file share sheet is not established to offer the same album chooser. Use an appropriate native album action if present; otherwise the complete route is save to Photos, then create/select the personal album inside Photos. Keep concise guidance available after handoff. iCloud Photos handles synchronization if enabled; Candidary does not verify it or ask for Apple credentials. Shared Albums are a different publishing action and are not the default destination. [Add photos to albums](https://support.apple.com/guide/iphone/add-delete-find-photos-videos-albums-iphee7aff030/ios), [create albums](https://support.apple.com/guide/iphone/create-and-work-with-photo-albums-iphc0fc668ab/ios)

Compatible installed applications may also appear in the device share sheet. Advertise the tested native sharing capability, not an exhaustive list of apps or a universal import guarantee.

## Direct cloud destinations: after launch

### OneDrive

Choose delegated **`Files.ReadWrite`** for personal and work/school accounts. Do not use `Files.ReadWrite.AppFolder`, application-only permission, or `Files.ReadWrite.All`. Create a visible `/Candidary/<event name>-<export short ID>/` folder in the user's drive. Store and use returned drive/folder IDs; never overwrite unrelated user files. A general folder picker is outside the initial version.

Disclose before connecting: Microsoft grants this app read/write access to the user's files; Candidary uses it to copy the chosen photos into the displayed event folder. Show the actual destination account, folder, count, and bytes again before starting. An organization may refuse consent; do not silently expand scopes or change the destination.

The app folder is unsuitable for this selected experience: Microsoft describes configuration, temporary storage, and drafts as ideal uses and suggests broader file scopes for files users access outside the app. This is a product fit decision, not a claim that large files are technically forbidden there. [Microsoft app-folder guidance](https://learn.microsoft.com/en-us/graph/onedrive-sharepoint-appfolder)

Use upload sessions and record the committed drive item before counting success. Use deterministic, collision-safe filenames within the chosen job folder while retaining the original name in the receipt. If a user moves, removes, or replaces a destination file, report it rather than restoring or overwriting it automatically. [Microsoft upload sessions](https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession?view=graph-rest-1.0)

### Google Photos

Use `photoslibrary.appendonly` and a Candidary-created event album. Arbitrary existing albums and library browsing are outside this scope. Send bytes, then create media items in batches of at most 50, serially per Google user. Count only acknowledged media creation, not a returned upload token. [Google upload protocol](https://developers.google.com/photos/library/guides/upload-media)

The default 10,000-request quota is shared by the entire project each day. Two 5,000-photo events already consume that allowance in uploads alone, before album/media-creation overhead. Reserve capacity in a project-wide daily quota ledger, fairly queue hosts, and stop/retry with provider backoff on 429. Do not assume another host's quota is independent or that a larger quota will be approved. Google directs additional-quota applicants to a partner program aimed at large consumer applications. [Google quotas](https://developers.google.com/photos/overview/api-limits-quotas)

Every Google confirmation must say: **These photos will be stored at original quality and count toward your Google Account storage.** Show the count and source bytes. Google's reminder threshold is uploads above 25 MB per user; that does not mean every possible transfer exceeds 25 MB. Always showing the disclosure satisfies the intended notice without maintaining a threshold-dependent prompt. [Google storage rules](https://developers.google.com/photos/overview/api-limits-quotas)

Google requires OAuth verification for Photos access. Treat approved consent configuration, scope verification, realistic quota capacity, and authorized test transfers as release gates. Google lists an estimated ten business days for sensitive-scope verification, without a guarantee; this task has not inspected the project's actual registration or approval status. There is no basis to promise a launch-week approval. [Photos authorization](https://developers.google.com/photos/overview/authorization), [Google verification estimates](https://support.google.com/cloud/answer/13463817?hl=en)

### Shared delivery behavior

Provider acknowledgments and progress survive execution restarts. Retry confirmed failures against the frozen entries only. If a response is lost after the provider may have committed, mark the item unresolved. With append-only Google access, do not promise arbitrary-library reconciliation; retain the unresolved result and require a deliberate user choice before a possibly duplicate resend. OneDrive may reconcile a known item/upload-session identity within its granted scope. Never turn uncertainty into success, silently drop the item, or blindly repeat the entire selection.

Provider-specific delivery adapters remain separate from RSVP and ZIP assembly, but they run under the shared export job/hold owner. Cloud jobs may continue after the tab closes only within their grant, attempt, source hold, and event deadlines. Destination full, account disconnected, quota waiting, and expired source hold have distinct recovery messages.

## Authorization, configuration, and Home Screen mode

Use a short-lived, single-use OAuth state bound server-side to provider, event, snapshot job, and initiating manager principal. A management-link principal cannot reuse another host's saved cloud grant. Returning from OAuth connects a pending grant only; the host must still confirm the account, source, folder/album, and storage disclosure before delivery begins. Use provider authorization-code flows with PKCE and validated redirect/state/nonce handling; credentials remain server-side.

At cloud implementation time, add `PHOTO_EXPORT_GRANT_ENCRYPTION_KEY` as a new independent 32-byte secret in `.dev.vars.example` and the relevant `wrangler.jsonc` `secrets.required` lists. Regenerate `worker-configuration.d.ts` and pass `npm run verify:bindings`; do not redeclare it only in `worker/env.ts`. Add provider IDs/secrets and exact registered redirect URLs to example/configuration documentation in the same feature. No secret or real provider registration changes are made by this design.

Encrypt grants with authenticated encryption and a key version. Rotating this dedicated key invalidates/reconnects provider grants without rotating RSVP, account/session, invitation, or Album-link keys. Keep acknowledged delivery records through reconnection. A decryption failure retires the unusable grant and asks the initiating manager to reconnect; it is not grounds to replay delivered items. Delete credentials when the bounded job/recovery window ends or the user disconnects.

Use the Worker callback namespace `/oauth/photo-export/:provider/callback` and explicitly add `/oauth/photo-export/*` to the worker-first asset routing list. Consume authorization codes on the Worker and return a token-free HTML navigation to the manager/export context. Errors also end on an HTML recovery surface; never strand an installed app on a JSON response or expose tokens in SPA parameters.

The [existing iOS design](2026-07-27-ios-home-screen-host-workflow-design.md) records separate Safari/Home Screen website data after installation. Do not assume an external Safari round trip repairs the installed app's session. Missing current manager authority must lead to existing in-context recovery, not a new session inferred from an OAuth state value. The pending grant remains bound to its original principal; starting/resuming delivery requires that principal's valid event authorization and explicit confirmation in the returning context.

Google prohibits developer-controlled embedded user agents. This is not evidence that every iOS Home Screen user agent is rejected. Verify the actual standalone flow and browser transitions. If a provider requires Safari, explain that route and its required manager reauthorization; do not spoof the user agent or copy session credentials between cookie jars. [Google OAuth browser policy](https://developers.google.com/identity/protocols/oauth2/policies)

## Verification

The export implementation plan must name focused checks for these contracts before code starts. Screenshots/scripts in ignored `output/` are supplemental only; tracked regression tests carry the reviewable evidence.

| Area | Required evidence |
| --- | --- |
| Selection and migration | Legacy complete/Album exports remain correct; selection kind and every changed guard work on fresh and upgraded D1; 10,000 explicit IDs use bounded bindings; all-results descriptors include unloaded pages and freeze membership/order |
| Ownership and deletion | Concurrent admission versus suppression; delete during active native/cloud work; cancellation/timeout versus late callbacks; failed retry after the old hold was released; exact bucket-generation/key identity |
| UI | Full-tile tapping and keyboard toggles in Library/Album; existing editing cap unchanged; card chooser placement; accurate selected/failed counts; focus, 320/390px containment, touch targets, cancellation |
| Device sharing | Physical iPhone Safari and Home Screen; real mixed image files; memory/batch bounds; fresh share gesture; cancel/return; native Save images; documented new/existing personal album route; no false save/iCloud receipt |
| OAuth | Google and Microsoft in desktop browsers, iPhone Safari, and iOS Home Screen; accepted/refused consent; separate cookie jars; HTML callbacks/errors; state replay; principal isolation; manager expiry; grant-key rotation/reconnection |
| Delivery | Real authorized transfers; Google creation acknowledgments, serial batches and shared quota; OneDrive personal/work accounts and folder visibility; storage/full/quota recovery; ambiguous results without duplicate replay |
| Configuration | Registered callbacks, worker-first routing, example vars, secret declarations, generated bindings, and disabled/unconfigured destination presentation agree |

A local browser mock cannot prove a provider consent flow, remote photo import, real-device Save action, or iCloud sync. Record those acceptance results separately and enable/advertise only verified destinations.

## Non-goals

- Google Photos or OneDrive delivery by September 18, 2026.
- RSVP changes or blocking the RSVP repair on this work.
- A native iOS app, an Apple-login integration, or a fabricated in-browser Photos album picker.
- A universal platform guarantee, two-way sync, or automatic repeat transfers of new event photos.
- Sharing private originals with guests, moving individual Intake actions into Gallery, or changing publication/Album membership.
- Removing the existing editing cap, adding simultaneous exports per event, or an export-history product.
- Broad OneDrive folder browsing, overwriting user files, arbitrary Google existing albums, or unapproved scope escalation.
- Rewriting historical migrations, configuring production credentials, running production transfers, committing, or deploying as part of this design task.

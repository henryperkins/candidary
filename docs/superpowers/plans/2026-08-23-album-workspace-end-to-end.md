# Album Workspace End-to-End Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the supplied Album workspace as a persistent, accessible host editor with revocable guest sharing and an album-only original-photo export.

**Architecture:** Keep delivery, album membership, Shared-gallery publication, and album-link visibility as four independent state axes. Extend the existing revisioned `event_albums` document for metadata, add a narrow fragment-to-session share service for preview-only public access, and add an immutable `kind='album'` snapshot path to the existing export Workflow. Build the handoff UI from the current Gallery components and CSS tokens rather than adding a second design system.

**Tech Stack:** TypeScript 6, React 19, Hono, Cloudflare Workers/D1/R2/Workflows, Zod, lucide-react, Vitest/workerd, Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-23-album-workspace-end-to-end-design.md`

## Global Constraints

- The canonical visual source is `Candidary Design System-handoff.zip:candidary-design-system/project/templates/album-workspace/AlbumWorkspace.dc.html`; its handoff README and 924×540 captures are acceptance evidence.
- Preserve the four independent axes exactly: delivered Library media, `media.favorited_at` album membership, Shared-gallery publication, and active album-share authorization. No album write may alter `publication_status` or `gallery_visible`.
- Use two ordered additive migrations: `migrations/0017_event_album.sql` creates the album/order
  foundation and `migrations/0018_album_end_to_end.sql` adds metadata, sharing, sessions, and
  album-export snapshot fields. Never rewrite either migration after application.
- Keep one event album, one active album share, and at most one queued/running export across both export kinds.
- Album metadata and entries save atomically under the existing revision compare-and-set; the client debounce is 600 ms and serializes/coalesces writes.
- Album-share links use `/album#id.secret`; raw credentials never enter request URLs, logs, DOM, history after exchange, or preview URLs. Public access is preview-only and never authorizes an original.
- Add exactly two required secrets: `ALBUM_SHARE_HMAC_KEY` and `ALBUM_SHARE_ENCRYPTION_KEY`; album sessions use `SESSION_HMAC_KEY`.
- Album export snapshots current picked originals and frozen raw order in D1, retries the snapshot without reading live media, preserves current complete-export behavior, omits Guestbook artifacts, and expires ready downloads after 86,400,000 ms.
- Use real `mediaPreview(id)` images, existing DM Sans/Manrope fonts, `lucide-react`, and `src/styles.css`; add no dependency, UI framework, CSS-in-JS system, token file, bucket, or Workflow binding.
- Begin each behavioral task with focused failing tests and observe the expected RED result before production edits.
- Preserve the supplied ZIP and unrelated untracked `src/features/print/`; stage only explicit task files.
- Browser QA uses the user-approved Playwright fallback because no browser plugin is callable. Compare reference and implementation together at the same 924×540 viewport and state.

---

## File map

- `migrations/0017_event_album.sql`: the revisioned album/order foundation.
- `migrations/0018_album_end_to_end.sql`: album metadata, share credentials/sessions, and album export discriminator/snapshot columns.
- `worker/db/album.ts`: canonical album read, cover fallback, byte total, and atomic metadata/order replacement.
- `worker/db/album-shares.ts` and `worker/services/album-share.ts`: recoverable link lifecycle and narrow session verification.
- `worker/routes/album-share.ts`: manager share resource, public exchange/view, and public preview authorization.
- `worker/export/album-order.ts`: pure frozen-order resolver used only by album export jobs.
- `worker/db/exports.ts`, `worker/routes/exports.ts`, `worker/workflows/export.ts`: immutable album job creation, status, retry, and artifact production.
- `src/features/gallery/ManagerAlbum.tsx`: editor state, autosave, cover/order/section/reset/undo, share and export exits.
- `src/features/gallery/AlbumPreview.tsx`: inline host preview, not a modal.
- `src/features/gallery/PublicAlbum.tsx` and `src/pages/AlbumSharePage.tsx`: allowlisted public album renderer and fragment exchange.
- `src/features/gallery/AlbumExportControl.tsx`: album-only export states and authenticated artifact links.
- Existing Library/Shared components: exact selection semantics, tray, separate-axis copy, busy states, and failed previews.

### Task 1: Additive schema, contracts, and atomic album metadata

**Files:**
- Create: `migrations/0017_event_album.sql`
- Create: `migrations/0018_album_end_to_end.sql`
- Modify: `shared/constants.ts`
- Modify: `shared/contracts.ts`
- Modify: `worker/db/album.ts`
- Modify: `worker/routes/manage.ts`
- Modify: `src/features/gallery/album-api.ts`
- Test: `tests/worker/migration-0018.test.ts`
- Test: `tests/worker/album-api.test.ts`
- Test: `tests/unit/album-order.test.ts`

**Interfaces:**
- Produces `AlbumMetadataInput`, the extended top-level `AlbumView`, `AlbumSaveRequest`, and `ExportKind` from spec §4.2.
- Produces `AlbumRepository.replace(eventId, expectedRevision, entries, metadata, now): Promise<AlbumView>` and `moveEntryTo(entries, from, to)`.
- Tasks 2–5 consume the exact migration tables and wire names established here.

- [ ] **Step 1: Write migration and album API tests that require every 0018 field**

  In `tests/worker/migration-0018.test.ts`, apply the 0017 album/order foundation, migrate that
  populated database through 0018, and assert metadata defaults, the share-table uniqueness/cascades,
  both session indexes, old export jobs defaulting to `complete`, valid album JSON constraints, and
  unique 1-based tail positions. Extend `tests/worker/album-api.test.ts` with metadata persistence, one
  revision increment, stale-write 409, omitted-metadata compatibility, invalid blank/overlong values,
  cover fallback after unpick/delete, and unchanged publication state.

  The migration DDL under test is:

  ```sql
  -- 0017_event_album.sql
  CREATE TABLE event_albums (
    event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
    entries TEXT NOT NULL DEFAULT '[]',
    saved_at TEXT,
    revision INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- 0018_album_end_to_end.sql
  ALTER TABLE event_albums ADD COLUMN title TEXT NOT NULL DEFAULT 'Album'
    CHECK (length(trim(title)) BETWEEN 1 AND 120);
  ALTER TABLE event_albums ADD COLUMN description TEXT NOT NULL DEFAULT ''
    CHECK (length(description) <= 1000);
  ALTER TABLE event_albums ADD COLUMN cover_media_id TEXT;

  CREATE TABLE event_album_shares (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE REFERENCES events(id) ON DELETE CASCADE,
    secret_digest TEXT NOT NULL,
    secret_ciphertext TEXT NOT NULL,
    shared_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE event_album_share_sessions (
    id TEXT PRIMARY KEY,
    share_id TEXT NOT NULL REFERENCES event_album_shares(id) ON DELETE CASCADE,
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    secret_digest TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX event_album_share_sessions_expiry
    ON event_album_share_sessions(expires_at, id);
  CREATE INDEX event_album_share_sessions_share_expiry
    ON event_album_share_sessions(share_id, expires_at, id);

  ALTER TABLE export_jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'complete'
    CHECK (kind IN ('complete', 'album'));
  ALTER TABLE export_jobs ADD COLUMN album_entries_json TEXT
    CHECK (
      (kind = 'complete' AND album_entries_json IS NULL)
      OR (kind = 'album' AND album_entries_json IS NOT NULL
          AND json_valid(album_entries_json) AND json_type(album_entries_json) = 'array')
    );
  ALTER TABLE export_media_entries ADD COLUMN album_tail_position INTEGER
    CHECK (album_tail_position IS NULL OR album_tail_position >= 1);
  CREATE UNIQUE INDEX export_album_media_position
    ON export_media_entries(export_job_id, album_tail_position)
    WHERE album_tail_position IS NOT NULL;
  ```

- [ ] **Step 2: Run focused tests and verify RED**

  Run:

  ```bash
  npx vitest run --config vitest.worker.config.ts tests/worker/migration-0018.test.ts tests/worker/album-api.test.ts
  npx vitest run --config vitest.config.ts tests/unit/album-order.test.ts
  ```

  Expected: migration tests fail because the ordered 0017/0018 schema is absent; API/unit tests fail because metadata fields, `replace`, and `moveEntryTo` do not exist.

- [ ] **Step 3: Add the shared contracts and constants**

  Add `ALBUM_TITLE_MAX_LENGTH = 120`, `ALBUM_DESCRIPTION_MAX_LENGTH = 1_000`, and `ALBUM_SHARE_SESSION_SECONDS = 7 * 24 * 60 * 60`. Define:

  ```ts
  export type ExportKind = 'complete' | 'album';

  export interface AlbumMetadataInput {
    title: string;
    description: string;
    coverMediaId: string | null;
  }

  export interface AlbumSaveRequest {
    revision: number;
    entries: AlbumEntryInput[];
    metadata?: AlbumMetadataInput;
  }

  export interface AlbumView extends AlbumMetadataInput {
    revision: number;
    saved: boolean;
    effectiveCoverMediaId: string | null;
    entries: AlbumEntryView[];
    photoCount: number;
    sectionCount: number;
    totalBytes: number;
  }
  ```

- [ ] **Step 4: Implement metadata resolution and atomic replacement**

  Extend `AlbumRow`, parse metadata defensively, and resolve an explicit cover only when it is in the live picked set. Preserve metadata when an old client omits it. The repository signature is:

  ```ts
  async replace(
    eventId: string,
    expectedRevision: number,
    entries: AlbumEntryInput[],
    metadata: AlbumMetadataInput | undefined,
    now: string,
  ): Promise<AlbumView>
  ```

  The guarded update changes entries and all metadata together, increments `revision` once, and retains the existing 409 conflict copy. Extend the strict PUT Zod schema to accept optional all-or-nothing `metadata`; new clients always send it.

  Implement arbitrary index movement without mutation:

  ```ts
  export function moveEntryTo<T>(entries: readonly T[], from: number, to: number): T[] {
    if (from < 0 || to < 0 || from >= entries.length || to >= entries.length || from === to) {
      return [...entries];
    }
    const next = [...entries];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    return next;
  }
  ```

- [ ] **Step 5: Run focused and compatibility tests GREEN**

  Run:

  ```bash
  npx vitest run --config vitest.worker.config.ts tests/worker/migration-0018.test.ts tests/worker/album-api.test.ts tests/worker/manage-api.test.ts
  npx vitest run --config vitest.config.ts tests/unit/album-order.test.ts
  npm run typecheck
  ```

  Expected: all commands exit 0; legacy `{revision, entries}` PUTs preserve metadata.

- [ ] **Step 6: Commit the foundation**

  ```bash
  git add migrations/0017_event_album.sql migrations/0018_album_end_to_end.sql shared/constants.ts shared/contracts.ts worker/db/album.ts worker/routes/manage.ts src/features/gallery/album-api.ts tests/worker/migration-0018.test.ts tests/worker/album-api.test.ts tests/unit/album-order.test.ts
  git commit -m "feat: persist album metadata and cover"
  ```

### Task 2: Revocable public album sharing

**Files:**
- Create: `worker/db/album-shares.ts`
- Create: `worker/services/album-share.ts`
- Create: `worker/routes/album-share.ts`
- Create: `src/features/gallery/album-share-api.ts`
- Create: `src/features/gallery/PublicAlbum.tsx`
- Create: `src/pages/AlbumSharePage.tsx`
- Modify: `shared/contracts.ts`
- Modify: `shared/errors.ts`
- Modify: `worker/http/cookies.ts`
- Modify: `worker/workflows/cleanup.ts`
- Modify: `worker/app.ts`
- Modify: `src/app/router.tsx`
- Modify: `src/styles.css`
- Modify: `wrangler.jsonc`
- Modify: `worker-configuration.d.ts`
- Modify: `.dev.vars.example`
- Modify: `scripts/deploy-built.ts`
- Test: `tests/worker/album-share-api.test.ts`
- Test: `tests/worker/cleanup.test.ts`
- Create: `tests/ui/album-share-page.test.tsx`
- Test: `tests/unit/deploy-built.test.ts`

**Interfaces:**
- Consumes Task 1's `event_album_shares`, `event_album_share_sessions`, album metadata, and live resolved entries.
- Produces manager `GET|POST|DELETE /api/manage/events/:eventId/album/share`, public `POST /api/album-share/exchange`, `GET /api/album-share`, `GET /api/album-share/media/:mediaId/preview`, `fetchAlbumShare`, `shareAlbum`, and `stopAlbumShare`.
- Produces the `/album` route that Task 5 styles and verifies end to end.

- [ ] **Step 1: Write security-first share tests**

  Cover manager/CSRF/event ownership; refusal of unsaved/empty albums; idempotent enable and concurrent
  enable/stop linearization; stable recoverable fragment link; ciphertext/digest storage with no raw
  secret; stop-and-reshare rotation; immediate session invalidation; indistinguishable
  malformed/wrong/revoked/purged responses; seven-day-or-purge session expiry; atomic admission capped
  at 2,000 active sessions per share with expired rows excluded and an accurate 429 `Retry-After`;
  unpublished picked photos visible without changing Shared; unpick/delete revoking public view and
  preview; foreign/unpicked preview refusal; original refusal; allowlisted JSON; `no-store`; and
  expired-session cleanup in 100-row batches capped at 50 batches per invocation.

  Define the public projection exactly:

  ```ts
  export type PublicAlbumEntryView =
    | { kind: 'section'; id: string; heading: string }
    | { kind: 'photo'; photo: { id: string; caption: string | null; previewAvailable: boolean } };

  export interface PublicAlbumView {
    title: string;
    description: string;
    coverMediaId: string | null;
    entries: PublicAlbumEntryView[];
    photoCount: number;
  }

  export interface AlbumShareView {
    active: true;
    url: string;
    sharedAt: string;
  }
  export type AlbumShareStatus = AlbumShareView | null;
  ```

- [ ] **Step 2: Run focused tests and verify RED**

  Run:

  ```bash
  npx vitest run --config vitest.worker.config.ts tests/worker/album-share-api.test.ts tests/worker/cleanup.test.ts
  npx vitest run --config vitest.config.ts tests/ui/album-share-page.test.tsx tests/unit/deploy-built.test.ts
  ```

  Expected: failures identify missing routes, repositories, cookie, `/album` page, error code, and secret bindings.

- [ ] **Step 3: Implement the repository and service lifecycle**

  `AlbumSharesRepository` exposes `getForEvent`, `getById`, `create`, `deleteForEvent`, atomic
  `admitSession`, `getSession`, and `deleteExpiredSessions(now, limit)`. `admitSession` inserts only
  while the share still exists and fewer than 2,000 unexpired sessions are active; its same-transaction
  diagnostic distinguishes revocation from capacity and returns the earliest active expiry for
  `Retry-After`. `AlbumShareService` uses `createSecretToken`, `digestSecret`, `constantTimeEqual`,
  `encryptSecret`, and `decryptSecret` with the dedicated share keys. Session secrets use
  `SESSION_HMAC_KEY`.

  Manager enable returns:

  ```ts
  { active: true, url: `${canonicalOrigin(env)}/album#${shareToken.token}`, sharedAt }
  ```

  Stop deletes the event's share row so the foreign-key cascade removes all sessions. A later enable
  creates a new ID and secret. An enable that read an existing share before a concurrent stop may
  return that observed link, but cannot recreate the deleted share or authorize access. Neither
  operation updates media or event visibility.

- [ ] **Step 4: Add narrow cookie, routes, and public preview authorization**

  Add dedicated helpers rather than a CSRF-bearing general session scope:

  ```ts
  setCookie(context, 'candidary_album', session.token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    path: '/api/album-share',
    maxAge,
  });
  ```

  The exchange calls `assertRequestOrigin`, erases credential distinctions behind `ALBUM_SHARE_UNAVAILABLE`, and sets `Cache-Control: private, no-store`. Every GET resolves the session and its still-present share row. The preview route additionally verifies event ownership, `stored`, not deleted, and `favorited_at IS NOT NULL`, then calls the existing preview generator. It never calls or widens the original route.

- [ ] **Step 5: Add the `/album` client without retaining the fragment**

  In the first effect, copy `location.hash.slice(1)` to a local variable and, only when it contains a
  token, immediately call:

  ```ts
  history.replaceState(history.state, '', `${location.pathname}${location.search}`);
  ```

  Exchange the copied token when present and otherwise reuse the narrow cookie on reload. Render
  loading, unavailable, and `PublicAlbum` states. Image URLs are only
  `/api/album-share/media/{id}/preview`.

  Add `/album` to the React router and Worker-first asset routes. Add both secrets to production and preview `secrets.required`, generated bindings, `.dev.vars.example`, deploy validation, and test bindings. Do not edit `.dev.vars`.

- [ ] **Step 6: Run share, cleanup, binding, and type tests GREEN**

  ```bash
  npx vitest run --config vitest.worker.config.ts tests/worker/album-share-api.test.ts tests/worker/cleanup.test.ts
  npx vitest run --config vitest.config.ts tests/ui/album-share-page.test.tsx tests/unit/deploy-built.test.ts
  npm run verify:bindings
  npm run typecheck
  ```

  Expected: all commands exit 0 and raw link tokens appear in neither response bodies after exchange nor public preview URLs.

- [ ] **Step 7: Commit sharing**

  ```bash
  git add worker/db/album-shares.ts worker/services/album-share.ts worker/routes/album-share.ts src/features/gallery/album-share-api.ts src/features/gallery/PublicAlbum.tsx src/pages/AlbumSharePage.tsx shared/contracts.ts shared/errors.ts worker/http/cookies.ts worker/workflows/cleanup.ts worker/app.ts src/app/router.tsx src/styles.css wrangler.jsonc worker-configuration.d.ts .dev.vars.example scripts/deploy-built.ts tests/worker/album-share-api.test.ts tests/worker/cleanup.test.ts tests/ui/album-share-page.test.tsx tests/unit/deploy-built.test.ts
  git commit -m "feat: add revocable album sharing"
  ```

### Task 3: Immutable album-only export and download

**Files:**
- Create: `worker/export/album-order.ts`
- Create: `src/features/gallery/AlbumExportControl.tsx`
- Modify: `worker/db/types.ts`
- Modify: `worker/db/exports.ts`
- Modify: `worker/routes/exports.ts`
- Modify: `worker/workflows/export.ts`
- Modify: `src/app/types.ts`
- Modify: `src/pages/ManagerPage.tsx`
- Modify: `src/features/gallery/ManagerGalleryWorkspace.tsx`
- Modify: `src/features/gallery/ManagerAlbum.tsx`
- Modify: `src/features/gallery/GalleryExportControl.tsx`
- Test: `tests/unit/export.test.ts`
- Test: `tests/worker/export-api.test.ts`
- Test: `tests/worker/cleanup.test.ts`
- Test: `tests/ui/app.test.tsx`
- Test: `tests/ui/album-workspace.test.tsx`
- Test: `tests/ui/host-private-gallery.test.tsx`

**Interfaces:**
- Consumes Task 1's `ExportKind`, `ExportRecord.kind`, `albumEntriesJson`, and `albumTailPosition`.
- Produces `resolveFrozenAlbumOrder(rawEntries, tailEntries)`, `ExportsRepository.createAlbumActive`, `ExportView.kind`, and `AlbumExportControl`.
- Task 4 preserves `AlbumExportControl` while rebuilding the surrounding editor.

- [ ] **Step 1: Write frozen-order, API, Workflow, and UI tests**

  Unit tests cover valid stored order, malformed JSON, duplicate/stale IDs, and tail append. Worker tests cover picked-only atomic membership, canonical-source checks scoped only to picks, empty refusal, immutable retry after live changes, order across ZIP partitions, null Guestbook artifacts, one-active cross-kind conflicts, complete `{}` compatibility, ready/range/expiry behavior, and cleanup. UI tests assert independent latest job per kind and exact request body `{kind:'album'}`.

  The resolver contract is:

  ```ts
  export function resolveFrozenAlbumOrder<T extends { id: string; albumTailPosition: number | null }>(
    rawEntries: string,
    media: readonly T[],
  ): T[];
  ```

- [ ] **Step 2: Run focused tests and verify RED**

  ```bash
  npx vitest run --config vitest.config.ts tests/unit/export.test.ts tests/ui/app.test.tsx tests/ui/album-workspace.test.tsx tests/ui/host-private-gallery.test.tsx
  npx vitest run --config vitest.worker.config.ts tests/worker/export-api.test.ts tests/worker/cleanup.test.ts
  ```

  Expected: failures identify the missing kind mapping, album snapshot creator/resolver, UI control, and cross-kind selection.

- [ ] **Step 3: Implement atomic `createAlbumActive` without changing complete creation**

  Add `kind: ExportKind` and `albumEntriesJson: string | null` to `ExportRecord`, and `albumTailPosition: number | null` to `ExportMediaEntryRecord`; map all three in `worker/db/exports.ts` before creating jobs.

  Leave `createActive()` as the complete path. `createAlbumActive()` uses one `DB.batch()` to insert a queued `kind='album'` job with canonicalized `event_albums.entries`, counts only live picks, refuses only picked legacy sources, and inserts only picked rows with:

  ```sql
  row_number() OVER (ORDER BY timeline_at ASC, id ASC) AS album_tail_position
  ```

  Guard snapshot statements on existence of the new queued job. Preserve the existing partial unique index across kinds. Make retry test `NOT EXISTS` for a different queued/running job and return `EXPORT_ALREADY_ACTIVE`, never a raw constraint error.

- [ ] **Step 4: Resolve the frozen snapshot in the Workflow**

  For album jobs, read immutable media ordered by tail position, resolve stored IDs first, append tail rows, partition that result, and require its length to equal `mediaCount`. Do not call `AlbumRepository` or query live favorites. Keep existing manifest, ZIP paths, part sizing, R2 tombstones, run claims, and 24-hour completion expiry. Pass `guestbook: null` for album jobs; retain complete and pre-0015 compatibility branches.

- [ ] **Step 5: Wire export kind through manager state and controls**

  Parse strict optional body `{kind?: 'album'}`; absent means complete. Include `kind` in list/status responses. In `ManagerPage` derive:

  ```ts
  const completeExport = exports.find((job) => job.kind === 'complete');
  const albumExport = exports.find((job) => job.kind === 'album');
  const activeExport = exports.find((job) => job.state === 'queued' || job.state === 'running');
  ```

  `AlbumExportControl` shows empty-disabled, preparing, failed/retry, ready manifest, and ordered part links. It never renders Guestbook links. `GalleryExportControl` retains the complete export and changes only “favorites” to “album picks” in its scope copy.

- [ ] **Step 6: Run export tests GREEN**

  ```bash
  npx vitest run --config vitest.config.ts tests/unit/export.test.ts tests/ui/app.test.tsx tests/ui/album-workspace.test.tsx tests/ui/host-private-gallery.test.tsx
  npx vitest run --config vitest.worker.config.ts tests/worker/export-api.test.ts tests/worker/cleanup.test.ts
  npm run typecheck
  ```

  Expected: all commands exit 0; complete export fixture bytes/filenames remain unchanged and album descriptors contain no Guestbook artifacts.

- [ ] **Step 7: Commit album export**

  ```bash
  git add worker/export/album-order.ts src/features/gallery/AlbumExportControl.tsx worker/db/types.ts worker/db/exports.ts worker/routes/exports.ts worker/workflows/export.ts src/app/types.ts src/pages/ManagerPage.tsx src/features/gallery/ManagerGalleryWorkspace.tsx src/features/gallery/ManagerAlbum.tsx src/features/gallery/GalleryExportControl.tsx tests/unit/export.test.ts tests/worker/export-api.test.ts tests/worker/cleanup.test.ts tests/ui/app.test.tsx tests/ui/album-workspace.test.tsx tests/ui/host-private-gallery.test.tsx
  git commit -m "feat: export album photo snapshots"
  ```

### Task 4: High-fidelity album editor, inline preview, share, and export exits

**Files:**
- Modify: `src/features/gallery/ManagerAlbum.tsx`
- Modify: `src/features/gallery/AlbumPreview.tsx`
- Modify: `src/features/gallery/ManagerGalleryWorkspace.tsx`
- Modify: `src/features/gallery/album-api.ts`
- Modify: `src/features/gallery/album-share-api.ts`
- Modify: `src/features/gallery/undo.tsx`
- Modify: `src/features/settings/autosave-queue.ts`
- Modify: `src/styles.css`
- Test: `tests/ui/album-workspace.test.tsx`
- Test: `tests/unit/settings-autosave-queue.test.ts`

**Interfaces:**
- Consumes Task 1's full-draft PUT and `moveEntryTo`, Task 2's share API, Task 3's `AlbumExportControl`, and existing `createAutosaveQueue`.
- Produces the complete Manager Album surface with one `AlbumDraft` and one serialized revision stream.
- Task 5 consumes stable accessible labels/classes for browser flows: `.album-review-grid`, `Album title`, `Description`, `Preview album`, `Share album`, `Stop sharing album`, and `Download album photos`.

- [ ] **Step 1: Expand UI tests before the component rewrite**

  Test exact reconciliation/status copy; 600 ms debounced metadata save; current revision after overlapping edits; blank-title invalid state; explicit/fallback cover; photo-only number pills; section spanning/rename/remove; earlier/later keyboard movement; drag/drop through `moveEntryTo`; reset timeline plus section removal and nine-second undo; remove/undo preserving originals and cover; inline preview replacing editing; failed preview tiles; share/copy/stop states; flush-before-preview/share/export; and empty album navigation.

- [ ] **Step 2: Run the Album UI test and verify RED**

  ```bash
  npx vitest run --config vitest.config.ts tests/ui/album-workspace.test.tsx tests/unit/settings-autosave-queue.test.ts
  ```

  Expected: assertions fail against the old vertical list, modal preview, absent metadata, absent cover, absent drag/reset, and absent share/export exits.

- [ ] **Step 3: Replace ad-hoc order saving with one full draft queue**

  Use:

  ```ts
  type AlbumDraft = {
    entries: AlbumEntryView[];
    title: string;
    description: string;
    coverMediaId: string | null;
  };
  ```

  `revisionRef.current` updates from every successful response before the next queued save starts. Submit the full draft key and intent to `createAutosaveQueue` with `AUTOSAVE_DEBOUNCE_MS`; invalid title submits `snapshot:null`. On 409, discard pending work, reload, and show the existing conflict notice.

  Extend the generic queue with `waitForSettled(): Promise<AutosaveState>`. It resolves when scheduled, in-flight, pending, and rebasing work is absent and returns `saved`, `failed`, or `invalid`; it never reports `saved` while a request remains. Preview, share, export, and mode exit call `flush()`, await `waitForSettled()`, and proceed only on `saved`.

  Expose `ManagerAlbumHandle.prepareToLeave(): Promise<boolean>` through `forwardRef`. `ManagerGalleryWorkspace` awaits it before changing away from Album; `false` keeps Album active and focuses the invalid title or failed-save recovery. This prevents the conditionally mounted editor from disposing a scheduled draft.

- [ ] **Step 4: Build the exact review surface and undo semantics**

  Render the cover/metadata card, **The order guests will see**, 196px-min photo-card grid, full-width section rows, photo-only pills, Cover badge, always-visible Lucide chevron/star/X controls, and real previews. Keep button ordering primary; native drag calls the same movement function. Reset sorts `(timelineAt, id)`, removes sections, preserves metadata/live explicit cover, and snapshots the whole draft for undo.

  Removal announcements use the exact spec strings and never imply deletion or publication. Empty state includes **Go to Library**.

- [ ] **Step 5: Convert preview and exits**

  Refactor `AlbumPreview` into an inline paper-card body headed **What a guest opening the link sees**. It replaces editor content and the toggle becomes **Back to editing**. Group lead photos and section blocks in 150px-min grids with per-photo fallbacks.

  Below the editor/preview render **When the album is right**, Preview, Share/Stop, and Download. Copy uses `navigator.clipboard.writeText` with the existing safe fallback, changes to **Copied** for 2.2 seconds, and announces the result. The share card contains the exact holding-link warning.

- [ ] **Step 6: Run UI, type, and lint checks GREEN**

  ```bash
  npx vitest run --config vitest.config.ts tests/ui/album-workspace.test.tsx tests/unit/settings-autosave-queue.test.ts
  npm run typecheck
  npm run lint
  ```

  Expected: all exit 0; no test depends on arbitrary sleep beyond fake-timer advancement of 600 ms, 2.2 s, or 9 s.

- [ ] **Step 7: Commit the editor**

  ```bash
  git add src/features/gallery/ManagerAlbum.tsx src/features/gallery/AlbumPreview.tsx src/features/gallery/ManagerGalleryWorkspace.tsx src/features/gallery/album-api.ts src/features/gallery/album-share-api.ts src/features/gallery/undo.tsx src/features/settings/autosave-queue.ts src/styles.css tests/ui/album-workspace.test.tsx tests/unit/settings-autosave-queue.test.ts
  git commit -m "feat: finish the album review workspace"
  ```

### Task 5: Library, Shared, public album, and browser-flow hardening

**Files:**
- Modify: `src/features/gallery/ManagerGalleryWorkspace.tsx`
- Modify: `src/features/gallery/ManagerPrivateGallery.tsx`
- Modify: `src/features/gallery/GalleryMoment.tsx`
- Modify: `src/features/gallery/SelectionTray.tsx`
- Modify: `src/features/gallery/ManagerSharedGallery.tsx`
- Modify: `src/features/gallery/PublicAlbum.tsx`
- Modify: `src/pages/AlbumSharePage.tsx`
- Modify: `src/styles.css`
- Modify: `tests/e2e/fixtures/routes.ts`
- Create: `tests/e2e/album-workspace.spec.ts`
- Create: `tests/e2e/album-share.spec.ts`
- Modify: `tests/e2e/security.spec.ts`
- Modify: `tests/e2e/manager-responsive.spec.ts`
- Modify: `tests/e2e/public-responsive.spec.ts`
- Test: `tests/ui/album-workspace.test.tsx`
- Test: `tests/ui/app.test.tsx`

**Interfaces:**
- Consumes Tasks 2–4 routes, labels, and editor exits.
- Produces deterministic stateful Playwright album/share fixtures and the complete manager-to-guest journey.
- Task 6 uses these fixtures to capture the handoff states without a real account or remote data.

- [ ] **Step 1: Add failing UI and browser assertions for exact behavior**

  Assert the three exact mode notes; dynamic Select/Deselect photo name; Select/Clear moment; selection clearing on query/filter/order/mode; tray `role=region` and `aria-label=Album`; album badge/state text; Shared filter-clearing, disabled busy buttons and Publishing/Hiding labels; per-card failed preview. Browser tests cover manager share → copy → fragment exchange → public render → stop → unavailable, plus album export prepare/ready links and 390×844 overflow/touch targets.

- [ ] **Step 2: Run focused tests and verify RED**

  ```bash
  npx vitest run --config vitest.config.ts tests/ui/album-workspace.test.tsx tests/ui/app.test.tsx
  npx playwright test tests/e2e/album-workspace.spec.ts tests/e2e/album-share.spec.ts tests/e2e/security.spec.ts --project=desktop
  ```

  Expected: UI tests fail on old labels/tray/Shared behavior; Playwright fails until stateful album fixtures and the full route journey exist.

- [ ] **Step 3: Harden Library and the selection tray**

  Use Plus/Check with `aria-pressed`, exact add/remove accessible names, hidden **In the album** state, denim selected ring/check badge, and exact whole-moment state. Clear selection in every spec transition. Make the docked tray `position:fixed; right:24px; bottom:24px; width:min(92vw,470px)` on desktop and keep it clear of content/safe areas on mobile.

- [ ] **Step 4: Harden Shared and public rendering**

  Add the exact separate-axis lede. Clear Shared selection on status change. Disable both bulk actions during a write and relabel only the active verbs to **Publishing…**/**Hiding…**. Keep cards' selected border in stylesheet and handle each `img` error independently. Style `PublicAlbum` from the same paper/preview language, including title, optional description, section blocks, cover, and unavailable page; do not expose manager navigation or private metadata.

- [ ] **Step 5: Add deterministic browser fixtures and security assertions**

  Extend `stubManagerRoutes` with mutable gallery picks, album GET/PUT/start/picks/share/export, album public exchange/read/preview, and stop invalidation. Use the existing photographic fixture for previews. In security tests record requests, console, DOM, history, and image URLs; assert the fragment secret is absent after exchange and that album cookies cannot authorize `/api/media/:id/original`.

- [ ] **Step 6: Run UI and browser flows GREEN**

  ```bash
  npx vitest run --config vitest.config.ts tests/ui/album-workspace.test.tsx tests/ui/app.test.tsx
  npx playwright test tests/e2e/album-workspace.spec.ts tests/e2e/album-share.spec.ts tests/e2e/security.spec.ts tests/e2e/manager-responsive.spec.ts tests/e2e/public-responsive.spec.ts
  npm run typecheck:e2e
  ```

  Expected: all exit 0 on desktop and mobile projects with no document-level horizontal overflow and 44px controls.

- [ ] **Step 7: Commit journey hardening**

  ```bash
  git add src/features/gallery/ManagerGalleryWorkspace.tsx src/features/gallery/ManagerPrivateGallery.tsx src/features/gallery/GalleryMoment.tsx src/features/gallery/SelectionTray.tsx src/features/gallery/ManagerSharedGallery.tsx src/features/gallery/PublicAlbum.tsx src/pages/AlbumSharePage.tsx src/styles.css tests/e2e/fixtures/routes.ts tests/e2e/album-workspace.spec.ts tests/e2e/album-share.spec.ts tests/e2e/security.spec.ts tests/e2e/manager-responsive.spec.ts tests/e2e/public-responsive.spec.ts tests/ui/album-workspace.test.tsx tests/ui/app.test.tsx
  git commit -m "fix: harden the album gallery journey"
  ```

### Task 6: Same-state visual QA, accessibility, operations, and full verification

**Files:**
- Create: `tests/e2e/album-workspace.visual.spec.ts`
- Create: `design-qa.md`
- Modify: `docs/operations.md`
- Modify: `docs/security.md`
- Modify: `CLAUDE.md`
- Modify: `src/styles.css`
- Modify: `src/features/gallery/ManagerAlbum.tsx`
- Modify: `src/features/gallery/ManagerPrivateGallery.tsx`
- Modify: `src/features/gallery/ManagerSharedGallery.tsx`
- Modify: `src/features/gallery/PublicAlbum.tsx`
- Modify: `tests/ui/album-workspace.test.tsx`
- Modify: `tests/ui/app.test.tsx`

**Interfaces:**
- Consumes Task 5's deterministic fixtures and the ZIP captures `01-state.png` through `07-state.png`.
- Produces final same-input comparison evidence, `design-qa.md` with `final result: passed`, operational documentation for two new secrets, and a clean full-suite/build result.

- [ ] **Step 1: Write the visual/accessibility test at exact viewports**

  Pin manager captures to 924×540 for Library, four-photo selection tray, reconciliation, populated editor, inline preview/exits, and Shared. Pin Library, selection, editor, preview, Shared, and public album to 390×844. Use stable role selectors and:

  ```ts
  await page.setViewportSize({ width: 924, height: 540 });
  await settleRendering(page, { parkPointer: true });
  await page.screenshot({ path: implementationPath, fullPage: false });
  ```

  Include axe scans, keyboard movement, 44px target geometry, reduced-motion, 200%/400% zoom operability, and horizontal overflow assertions.

- [ ] **Step 2: Run visual/browser tests and observe the first RED or captured deltas**

  ```bash
  npx playwright test tests/e2e/album-workspace.visual.spec.ts --project=desktop
  npx playwright test tests/e2e/album-workspace.visual.spec.ts --project=mobile
  ```

  Expected on the first run: missing captured acceptance evidence or visible reference differences are recorded as P0/P1/P2 before styling is finalized.

- [ ] **Step 3: Compare reference and implementation together and remediate P0/P1**

  Extract source captures to a temporary directory. For each state, create `/tmp/album-compare.html` with two native 924×540 `<img>` elements, capture it at 1848×540 in Playwright, and inspect the combined image. Correct wrong layout, spacing, font weight, border, radius, crop, copy, target, and overflow in the owning file. Repeat until no P0 or P1 remains. P2 items may remain only when documented with rationale.

- [ ] **Step 4: Write exact QA and operations evidence**

  `design-qa.md` contains: source path, implementation route/state, 924×540 and 390×844 capture paths, combined comparison method, P0/P1/P2 findings, remediation for each finding, browser fallback note, accessibility results, and the exact final line:

  ```text
  final result: passed
  ```

  Document independent preview/production provisioning and rotation of `ALBUM_SHARE_HMAC_KEY` and
  `ALBUM_SHARE_ENCRYPTION_KEY`, the ten-secret inventory, Stop-sharing invalidation, the 2,000-active
  session admission ceiling, 100×50 cleanup bound, album-vs-complete export behavior, migration-before-
  deploy ordering, and the 24-hour artifact window in operations/security docs and `CLAUDE.md`.

- [ ] **Step 5: Run fresh full verification**

  ```bash
  npm run lint
  npm run typecheck
  npm run typecheck:e2e
  npm run verify:bindings
  npm run ci:migrations
  npm run verify:fresh-d1
  npm run test:unit
  npm run test:worker
  npm run build
  npm run test:e2e
  ```

  Expected: every command exits 0. Capture actual pass counts in the task report; do not infer success from a prior run.

- [ ] **Step 6: Commit verification evidence**

  ```bash
  git add tests/e2e/album-workspace.visual.spec.ts design-qa.md docs/operations.md docs/security.md CLAUDE.md src/styles.css src/features/gallery/ManagerAlbum.tsx src/features/gallery/ManagerPrivateGallery.tsx src/features/gallery/ManagerSharedGallery.tsx src/features/gallery/PublicAlbum.tsx tests/ui/album-workspace.test.tsx tests/ui/app.test.tsx
  git commit -m "test: verify the album workspace end to end"
  ```

  Before committing, inspect `git diff --cached --name-only` and unstage anything outside this plan, especially `src/features/print/` and the supplied ZIP.

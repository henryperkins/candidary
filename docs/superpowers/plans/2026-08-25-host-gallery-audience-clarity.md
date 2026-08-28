# Host Gallery Audience Clarity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make delivered photos, Album membership, Guest-gallery publication, and Album-link availability predictable at every Manager action point without coupling those four axes.

**Architecture:** Add one credential-free Manager summary projection and load it through the existing per-resource controller. Reuse the current Gallery workspace, Album autosave queue, public Album projection/renderer, modal focus pattern, selection helpers, and `CopyableLinkCard`; only extend their contracts where Slice 2 requires shared behavior. Keep `shared` and `isFavorite` as compatibility names below the UI boundary while changing host-facing language to Guest gallery and Album membership.

**Tech Stack:** React 19, React Router, TypeScript, Hono on Cloudflare Workers, D1, Vitest/Testing Library, and Playwright.

**Spec:** `docs/superpowers/specs/2026-08-23-host-gallery-audience-clarity-design.md`

## Global Constraints

- Delivered source existence, Album membership, Guest-gallery publication, and Album-link availability remain separate axes.
- Album links remain live request-time projections; later membership, metadata, order, and eligible-caption changes affect subsequent reads.
- Hide remains Guest-gallery-only and must never remove an Album pick or claim to withdraw an Album link.
- Album captions cross the public boundary only while their photo is `published`; unpublished and hidden photos remain eligible but lose their caption.
- Settings remains the sole owner of the Guest-gallery availability toggle.
- `ManagerGalleryWorkspace`, `ManagerPrivateGallery`, `ManagerAlbum`, `ManagerSharedGallery`, `selection-state.ts`, `SelectionTray`, `PublicAlbum`, `useManagerResource`, the Album autosave queue, and the existing modal/live-region patterns are extended, not replaced.
- Host-facing language is exactly Delivered photos; Pick / In Album / Remove from Album; Guest gallery / Published / Unpublished / Hidden; Album link / Off / Live; event guests; and people with the Album link.
- The summary route is `GET /api/manage/events/:eventId/gallery/summary`, returns `{ data: { summary }, requestId }`, selects no credential material, and sends `Cache-Control: private, no-store` plus `Vary: Cookie` on success and error.
- Summary failures remain Gallery-scoped, preserve any last trusted summary, and never clear the event, media, export, or sibling resource state.
- Public Album page semantics are `main`, `h1`, `h2`; Manager Preview semantics are `section`, `h3`, `h4` beneath the retained Gallery `h2`.
- Sensitive values are absent from DOM text, attributes, accessible names, and focusable descendants until Reveal; the mask length is fixed and Copy works while hidden.
- No new toast, notification framework, Guest-gallery toggle, credential component, frozen Album revision, or cross-audience withdrawal action is introduced.
- All behavior changes follow red-green-refactor. A changed test must name the production break it catches and assert real observable behavior, not mock existence.
- Preserve the existing dirty Slice 1 worktree. Do not commit, push, deploy, migrate a remote database, or mutate a pull request; the user has not requested those side effects.

---

### Task 1: Credential-free Gallery audience summary

**Files:**
- Modify: `shared/contracts.ts`
- Modify: `worker/db/album-shares.ts`
- Modify: `worker/db/media.ts`
- Modify: `worker/routes/manage.ts`
- Create: `tests/worker/gallery-audience-summary.test.ts`

**Interfaces:**
- Consumes: `AlbumRepository.get(eventId)`, `requireManager(context)`, and `privateJson`.
- Produces: `GalleryAudienceSummaryView`, `AlbumSharesRepository.audienceStatus(eventId)`, `MediaRepository.countPublishedForGallerySummary(eventId)`, and `GET /api/manage/events/:eventId/gallery/summary` for Task 2.

- [ ] **Step 1: Write failing Worker tests for the exact private contract**

Add a focused suite that authenticates through the existing Manager helpers and asserts literal keys, not `objectContaining`:

```ts
expect(Object.keys(body.data)).toEqual(['summary']);
expect(Object.keys(body.data.summary)).toEqual([
  'albumPhotoCount',
  'albumEntryCount',
  'albumLink',
  'guestGalleryVisible',
  'guestGalleryPublishedCount',
]);
expect(Object.keys(body.data.summary.albumLink)).toEqual(['active', 'sharedAt']);
expect(response.headers.get('cache-control')).toBe('private, no-store');
expect(response.headers.get('vary')).toContain('Cookie');
expect(JSON.stringify(body)).not.toMatch(/url|secret|ciphertext|digest/iu);
```

Build one event with an active pick, one recoverable picked photo, one unpicked stale stored entry, and one section. Assert `albumPhotoCount === 1` and `albumEntryCount === 3` (active pick + retained slot + section). Add active published, active unpublished, trashed-published, and deleted-published photos; only the active published row counts. Enable and stop an Album share and assert `{ active: true, sharedAt }` then `{ active: false, sharedAt: null }`. Cover missing/foreign Manager authority and confirm private headers remain on the error response.

- [ ] **Step 2: Run the focused suite and verify RED**

Run:

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/gallery-audience-summary.test.ts
```

Expected: FAIL because the route returns 404 and `GalleryAudienceSummaryView` does not exist.

- [ ] **Step 3: Add the exact shared contract**

Add beside the Album view contracts:

```ts
export interface GalleryAudienceSummaryView {
  albumPhotoCount: number;
  albumEntryCount: number;
  albumLink: { active: boolean; sharedAt: string | null };
  guestGalleryVisible: boolean;
  guestGalleryPublishedCount: number;
}
```

- [ ] **Step 4: Add narrow repository reads without decrypting a share**

Add this shape to `AlbumSharesRepository`; the query must select only `shared_at`:

```ts
async audienceStatus(eventId: string): Promise<GalleryAudienceSummaryView['albumLink']> {
  const row = await this.db.prepare(`
    SELECT shared_at FROM event_album_shares WHERE event_id = ?
  `).bind(eventId).first<{ shared_at: string }>();
  return { active: row !== null, sharedAt: row?.shared_at ?? null };
}
```

Add a media count that uses the same active-photo predicate as publication writes:

```sql
SELECT COUNT(*) AS count
FROM media
WHERE event_id = ?
  AND upload_state = 'stored'
  AND publication_status = 'published'
  AND deleted_at IS NULL
  AND trashed_at IS NULL
```

Return `0` when D1 has no row. Do not return or reuse a raw media record.

- [ ] **Step 5: Implement the Manager route through existing owners**

Register `privateJson` for the exact summary path. In the GET handler, call `requireManager`, then load the resolved Album, narrow link state, and published count in parallel:

```ts
const auth = await requireManager(context);
const [album, albumLink, guestGalleryPublishedCount] = await Promise.all([
  new AlbumRepository(context.env.DB).get(auth.event.id),
  new AlbumSharesRepository(context.env.DB).audienceStatus(auth.event.id),
  new MediaRepository(context.env.DB).countPublishedForGallerySummary(auth.event.id),
]);
const summary: GalleryAudienceSummaryView = {
  albumPhotoCount: album.photoCount,
  albumEntryCount: album.entries.length,
  albumLink,
  guestGalleryVisible: auth.event.galleryVisible,
  guestGalleryPublishedCount,
};
return context.json({ data: { summary }, requestId: context.get('requestId') });
```

Do not call `AlbumShareService.status()` or map a credential-bearing share row.

- [ ] **Step 6: Verify GREEN and the adjacent Worker contracts**

Run:

```bash
npx vitest run --config vitest.worker.config.ts \
  tests/worker/gallery-audience-summary.test.ts \
  tests/worker/album-api.test.ts \
  tests/worker/album-share-api.test.ts \
  tests/worker/media-recovery-api.test.ts \
  tests/worker/manage-api.test.ts
```

Expected: PASS with no credential field in the summary response.

- [ ] **Step 7: Record the task checkpoint without committing**

Record the changed files, RED command/result, GREEN command/result, and any concerns in the Slice 2 SDD report. Leave the worktree uncommitted.

---

### Task 2: Resource-owned persistent summary and exact invalidation

**Files:**
- Modify: `src/features/gallery/ManagerGalleryWorkspace.tsx`
- Modify: `src/features/gallery/ManagerAlbum.tsx`
- Modify: `src/pages/ManagerPage.tsx`
- Modify: `tests/ui/album-workspace.test.tsx`
- Modify: `tests/ui/app.test.tsx`
- Modify: `tests/e2e/fixtures/routes.ts`

**Interfaces:**
- Consumes: `GalleryAudienceSummaryView` and the Task 1 endpoint.
- Produces: one `useManagerResource<GalleryAudienceSummaryView>` owner, the compact line, `ManagerGalleryWorkspaceHandle.invalidateAudienceSummary()`, and `ManagerAlbum.onAudienceChanged()` for later tasks.

- [ ] **Step 1: Write failing UI tests for ownership and display**

Add tests with literal summaries for these observable contracts:

```ts
expect(screen.getByText(
  'Album: 12 photos · Link: Live · Guest gallery: On, 8 published',
)).toBeVisible();
```

Cover Off/zero/plural rendering; a retryable first-load failure that leaves Library and exports usable; a retry failure after a trusted value that keeps the old line visible; and a late event-A response that cannot enter event B. Assert the old decoration request to `/album` is not made merely to calculate counts while Library is active.

Add one request-count test for each successful invalidation boundary: single/bulk Pick, Album save/section change, share start/stop callback, single/bulk Publish/Hide, parent trash/restore `invalidate()`, and confirmed `galleryVisible` settings reconciliation. A failed or cancelled operation must not invalidate.

- [ ] **Step 2: Run the focused UI tests and verify RED**

Run:

```bash
npx vitest run --config vitest.config.ts \
  tests/ui/album-workspace.test.tsx \
  tests/ui/app.test.tsx
```

Expected: FAIL because the workspace has only `pickCount`/`albumEntryCount` derived from `fetchAlbum` and no audience summary request or line.

- [ ] **Step 3: Replace duplicate count state with one Manager resource**

Remove `pickGeneration`, `refreshPickCount`, and the decoration-only `fetchAlbum` call. Load the Task 1 route through the existing hook:

```ts
const audienceResource = useManagerResource<GalleryAudienceSummaryView>({
  eventId,
  queryKey: 'gallery-audience-summary',
  fallbackMessage: 'The Gallery audience status could not be loaded.',
  onEscalate: onResourceEscalate ?? (() => {}),
  load: useCallback(async (signal: AbortSignal) => (
    await api<{ summary: GalleryAudienceSummaryView }>(
      `/api/manage/events/${eventId}/gallery/summary`,
      { signal },
    )
  ).summary, [eventId]),
});
```

Use `albumPhotoCount` for visible Album copy and `albumEntryCount` for the existing capacity guard. While a retry runs, render the last value. If no value exists, show a compact loading state or the resource-scoped `ErrorState`; never replace the workspace.

- [ ] **Step 4: Render the persistent line and live-link consequence**

Under the mode note render the exact line with singular/plural handling:

```tsx
<p className="gallery-audience-summary">
  Album: {summary.albumPhotoCount} {summary.albumPhotoCount === 1 ? 'photo' : 'photos'}
  {' · '}Link: {summary.albumLink.active ? 'Live' : 'Off'}
  {' · '}Guest gallery: {summary.guestGalleryVisible ? 'On' : 'Off'}, {summary.guestGalleryPublishedCount} published
</p>
```

When the link is live and mode is Library or Album, add exactly:

```text
Album link live—membership and Album edits affect the link.
```

This is ordinary text, not a badge row.

- [ ] **Step 5: Wire successful mutations to one invalidation callback**

Expose `invalidateAudienceSummary()` on the workspace handle. Keep `invalidate()` as the parent trash/restore boundary that invalidates both Library and the summary.

Pass `onAudienceChanged` to `ManagerAlbum`. Because its autosave queue is constructed once, store the latest callback in a ref and invoke it only after a confirmed save/adoption, successful start/membership change, or successful share lifecycle mutation. Do not invalidate on queued drafts, modal cancellation, or rejected writes.

After confirmed single/bulk publication writes, invalidate the summary. In `ManagerPage.onSettingsSaved`, compare the previously trusted `galleryVisible` to the confirmed response and call `invalidateAudienceSummary()` only when it changed. Preserve the existing generation guards.

- [ ] **Step 6: Add the E2E fixture route**

Extend `installManagerRoutes` with a default `GalleryAudienceSummaryView` and an optional override. Fulfill only the exact path ending `/gallery/summary` before the broader `/gallery` matcher so it cannot be swallowed by the Library fixture.

- [ ] **Step 7: Verify GREEN**

Run:

```bash
npx vitest run --config vitest.config.ts \
  tests/ui/album-workspace.test.tsx \
  tests/ui/app.test.tsx \
  tests/ui/manager-resources.test.tsx
npm run typecheck
npm run typecheck:e2e
```

Expected: PASS; invalidations are event-scoped and the summary failure never clears sibling resources.

- [ ] **Step 8: Record the task checkpoint without committing**

Record the task-scoped file list and RED/GREEN evidence in the SDD report. Leave the worktree uncommitted.

---

### Task 3: Canonical audience language, one selection model, and precise feedback

**Files:**
- Modify: `src/features/gallery/ManagerGalleryWorkspace.tsx`
- Modify: `src/features/gallery/ManagerPrivateGallery.tsx`
- Modify: `src/features/gallery/ManagerSharedGallery.tsx`
- Modify: `src/features/gallery/GalleryMoment.tsx`
- Modify: `src/features/gallery/GalleryViewer.tsx`
- Modify: `src/features/gallery/SelectionTray.tsx`
- Modify: `src/features/gallery/selection-state.ts`
- Modify: `src/features/guestbook/manager-guestbook-state.ts`
- Modify: `src/features/guestbook/ManagerGuestbookPanel.tsx`
- Modify: `src/styles.css`
- Modify: `tests/unit/gallery-selection-state.test.ts`
- Modify: `tests/ui/host-private-gallery.test.tsx`
- Modify: `tests/ui/album-workspace.test.tsx`
- Modify: `tests/ui/manager-guestbook.test.tsx`
- Modify: `tests/e2e/album-workspace.spec.ts`
- Modify: `tests/e2e/manager-responsive.spec.ts`

**Interfaces:**
- Consumes: Task 2 summary state, existing `transitionSelection`, and the one Gallery live region.
- Produces: host-facing Guest gallery terminology, uniform loaded/cap selection copy, one visible Album-membership state per Library photo, contextual action hierarchy, and exact audience feedback.

- [ ] **Step 1: Write failing pure and component tests**

Pin these literal behaviors:

```ts
expect(selectionCountMessage(1)).toBe('1 of 50 selected');
expect(selectionCountMessage(49)).toBe('49 of 50 selected');
expect(selectionCapacityMessage()).toBe('50 of 50 selected. Remove one to choose another.');
expect(screen.getByRole('button', { name: 'Select all 48 loaded photos' })).toBeVisible();
```

At 0, 1, 49, and 50 selections, assert both Library and Guest gallery use the same helper output. Assert a Guest-gallery filter change clears the selection and announces it.

For a Library card, assert one visible `Pick` or `In Album` membership state, never both, plus one `Guest gallery · Published|Unpublished|Hidden` label. Mutating publication must not mutate membership and vice versa.

Retain explicit regressions for the Minus icon and literal `Remove from Album` accessible action; do not let the terminology pass bring back the old heart/favorite metaphor or leak filenames/contributor names into the public Album.

For Guest gallery, assert the on/off lede, state-leading action classes/order, exact single/bulk result state and audience, off-state consequence, and opposite-action recovery. Assert the Guestbook suppressed caption label is exactly `Not currently visible to event guests`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npx vitest run --config vitest.config.ts \
  tests/unit/gallery-selection-state.test.ts \
  tests/ui/host-private-gallery.test.tsx \
  tests/ui/album-workspace.test.tsx \
  tests/ui/manager-guestbook.test.tsx
```

Expected: FAIL on Shared/optional-shared terminology, duplicate selection helpers, card state labels, and generic publication feedback.

- [ ] **Step 3: Apply canonical host-facing terms without renaming transport fields**

Keep the internal mode key `shared` and compatibility field `isFavorite`. Change visible mode labels and notes so the third mode is `Guest gallery`, Library says picking affects Album membership and never Guest-gallery publication, and Guest gallery says Publish/Hide affects event guests but not Album membership or the Album link.

Use `Delivered photos` for the Library collection and reserve `original` for source download/deletion copy. Replace Share/Shared wording on Manager Album and Gallery surfaces with `Album link` or `Guest gallery` according to the audience.

- [ ] **Step 4: Unify selection copy through `selection-state.ts`**

Export literal helpers:

```ts
export function selectionCountMessage(count: number): string {
  return `${count} of ${MANAGER_BULK_SELECTION_MAX} selected`;
}

export function selectionCapacityMessage(): string {
  return `${MANAGER_BULK_SELECTION_MAX} of ${MANAGER_BULK_SELECTION_MAX} selected. Remove one to choose another.`;
}
```

Use the pure `transitionSelection` helper for Guest-gallery toggle/clear decisions instead of maintaining a second cap algorithm in JSX. Change Library to `Select all N loaded photo(s)` and render `N of 50 selected` in `SelectionTray`.

- [ ] **Step 5: Make each Library card expose exactly one membership state**

Remove `.gallery-mosaic__album-badge`. The primary card control itself renders `Pick` when out and `In Album` when in; its accessible action is `Pick <photo> for the Album` or `Remove <photo> from Album`. Apply the same canonical visible state/action pair in `GalleryViewer`.

Add one compact, noninteractive publication label:

```tsx
<span className={`gallery-mosaic__publication publication--${photo.publicationStatus}`}>
  Guest gallery · {PUBLICATION_LABELS[photo.publicationStatus]}
</span>
```

Do not turn this label into a publication control on Library.

- [ ] **Step 6: Implement Guest-gallery hierarchy and one announcement path**

Render one availability sentence in the header:

```text
Published photos are visible to event guests.
Publication choices are saved, but the Guest gallery is off.
```

Keep only the Settings route when off. In Unpublished, Publish is primary and Hide secondary; in Published, Hide is primary; in Hidden, Publish is primary. Do not add confirmations.

The workspace, which sees confirmed API results, owns final announcements. Use literal patterns:

```text
<name> is Published in the Guest gallery for event guests. Hide it to reverse this.
<name> is Hidden from event guests in the Guest gallery. Publish it to reverse this.
<N> photos are Published in the Guest gallery for event guests. Hide them to reverse this.
<N> photos are Hidden from event guests in the Guest gallery. Publish them to reverse this.
```

When the Gallery is off, replace the visibility clause with `The Guest gallery is off, so event guests cannot see this choice yet.` Keep progressive and failure announcements but remove the generic duplicate `Publishing finished.` / `Hiding finished.` messages.

- [ ] **Step 7: Correct Guestbook suppression language**

For a published photo caption whose Gallery is off, return the exact state label `Not currently visible to event guests`. Update the explanatory notice to use `Guest gallery` and make clear that the saved publication state is still Published.

- [ ] **Step 8: Verify GREEN and browser geometry for the renamed mode**

Run:

```bash
npx vitest run --config vitest.config.ts \
  tests/unit/gallery-selection-state.test.ts \
  tests/ui/host-private-gallery.test.tsx \
  tests/ui/album-workspace.test.tsx \
  tests/ui/manager-guestbook.test.tsx
npx playwright test tests/e2e/album-workspace.spec.ts tests/e2e/manager-responsive.spec.ts --project=mobile
```

Expected: PASS; no page-level horizontal overflow at 320/390 px and no `Shared` mode button remains in Manager.

- [ ] **Step 9: Record the task checkpoint without committing**

Record task files and RED/GREEN evidence. Leave the worktree uncommitted.

---

### Task 4: One semantic Public Album tree for page and Preview

**Files:**
- Modify: `src/features/gallery/PublicAlbum.tsx`
- Modify: `src/features/gallery/AlbumPreview.tsx`
- Modify: `src/pages/AlbumSharePage.tsx`
- Modify: `tests/ui/album-share-page.test.tsx`
- Modify: `tests/worker/album-api.test.ts`
- Modify: `tests/worker/album-share-api.test.ts`
- Modify: `tests/e2e/fixtures/routes.ts`
- Modify: `tests/e2e/accessibility.spec.ts`

**Interfaces:**
- Consumes: the Slice 1 `PublicAlbumService` projection and Manager Preview endpoint.
- Produces: required `PublicAlbum` `variant: 'page' | 'embedded'` semantics and identical zero-photo/empty-section rendering.

- [ ] **Step 1: Write failing semantic and parity tests**

Render the same literal `PublicAlbumView` through both variants. Assert:

```ts
expect(page.container.querySelector('main.public-album > header h1')).toHaveTextContent('The evening');
expect(page.container.querySelector('main.public-album h2')).toHaveTextContent('Ceremony');
expect(embedded.container.querySelector('section.public-album > header h3')).toHaveTextContent('The evening');
expect(embedded.container.querySelector('section.public-album h4')).toHaveTextContent('Ceremony');
```

Assert matching cover/title/description/count/photo order/captions/fallback labels for page and embedded. Add published, unpublished, and hidden caption states with Guest gallery both On and Off: visibility availability never changes Album-link eligibility, and only `published` carries a caption. Add empty leading, adjacent, and trailing sections and prove they render no headings. Add zero photos and prove both variants render the same intentional `No photos in this Album yet.` state while retaining title, description, and `0 photos`.

Keep the existing never-shared/revoked Manager Preview regression: it calls neither share status nor exchange, emits no `Set-Cookie`, and carries no URL, token, digest, or ciphertext.

- [ ] **Step 2: Run UI/Worker parity tests and verify RED**

Run:

```bash
npx vitest run --config vitest.config.ts tests/ui/album-share-page.test.tsx
npx vitest run --config vitest.worker.config.ts \
  tests/worker/album-api.test.ts tests/worker/album-share-api.test.ts
```

Expected: UI FAIL because embedded still renders `div`/`h1`/`h2` and Preview forks the zero-photo tree. Existing Worker projection tests should remain green.

- [ ] **Step 3: Make the semantic variant required**

Replace `embedded?: boolean` with:

```ts
interface PublicAlbumProps {
  album: PublicAlbumView;
  imageSource: (mediaId: string) => string;
  variant: 'page' | 'embedded';
}
```

Choose `main/h1/h2` for `page` and `section/h3/h4` for `embedded`. Pass `variant="page"` from `AlbumSharePage` and `variant="embedded"` from `AlbumPreview`.

- [ ] **Step 4: Remove the Preview-only empty renderer and harden block projection**

Always render `PublicAlbum` once `album` is loaded, including zero photos. Change `publicAlbumBlocks` so a section becomes a block only when a following photo exists; adjacent/leading/trailing empty headings disappear. Render the literal shared empty state when `album.photoCount === 0`.

- [ ] **Step 5: Align E2E fixtures with the real projection**

Change the fixture `publicAlbumView()` to keep a section pending until the next included photo, matching `PublicAlbumService`. Do not let E2E presentation fixtures serialize an empty section the Worker would omit.

- [ ] **Step 6: Verify GREEN and heading accessibility**

Run:

```bash
npx vitest run --config vitest.config.ts tests/ui/album-share-page.test.tsx
npx vitest run --config vitest.worker.config.ts \
  tests/worker/album-api.test.ts tests/worker/album-share-api.test.ts
npx playwright test tests/e2e/accessibility.spec.ts --project=desktop
```

Expected: PASS with one Manager `h2`, embedded Album `h3/h4`, and public page `h1/h2`.

- [ ] **Step 7: Record the task checkpoint without committing**

Record task files and RED/GREEN evidence. Leave the worktree uncommitted.

---

### Task 5: Contextual Album section insertion

**Files:**
- Modify: `src/features/gallery/ManagerAlbum.tsx`
- Modify: `tests/ui/album-workspace.test.tsx`

**Interfaces:**
- Consumes: the current Album draft, `data-entry-key`, `removedEntryContext`, operation journal, and existing autosave queue.
- Produces: section insertion after the most recently focused editor entry, with append as the no-context fallback.

- [ ] **Step 1: Write failing insertion and persistence tests**

Focus an Album entry in the middle, activate Add section, and assert the new section is directly after that entry, its input is selected, the announcement names its position, and the saved `entries` request has that exact order. Add a no-prior-entry case that appends. Add a revision-conflict replay case to prove the existing `insert-entry` operation preserves the same neighboring keys.

Add editor regressions for an empty leading, middle, and trailing section. Each section remains editable and visibly says `Empty section—omitted from the Album link` until an active photo follows it before the next section. A retained-trash marker alone does not make a public section nonempty.

- [ ] **Step 2: Run the focused Album tests and verify RED**

Run:

```bash
npx vitest run --config vitest.config.ts tests/ui/album-workspace.test.tsx -t 'section'
```

Expected: FAIL because `addSection()` always appends and announces `Section added at the end.`

- [ ] **Step 3: Track editing context with existing entry keys**

Keep a ref to the last entry that received focus. Update it from the Album list's existing `data-entry-key` boundary using `onFocusCapture`; clicking the Add section control may move DOM focus, but it must not erase that stored context.

In `addSection()`, insert after the stored key when it still exists; otherwise append. Reuse `removedEntryContext` and the existing `insert-entry` journal operation—do not create another ordering system. After insertion, make the new section the current context and select its input.

Derive empty-section flags from the current draft in one pure helper: scan from a section to the next section/end and treat only `entry.kind === 'photo'` as public content. Render the literal editor note without deleting or hiding the section itself.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npx vitest run --config vitest.config.ts tests/ui/album-workspace.test.tsx -t 'section'
```

Expected: PASS for contextual, fallback, autosave, and conflict-replay cases.

- [ ] **Step 5: Record the task checkpoint without committing**

Record task files and RED/GREEN evidence. Leave the worktree uncommitted.

---

### Task 6: Sensitive mode for the existing link card

**Files:**
- Modify: `src/components/CopyableLinkCard.tsx`
- Modify: `src/pages/CreatePage.tsx`
- Modify: `src/styles.css`
- Create: `tests/ui/copyable-link-card.test.tsx`
- Modify: `tests/ui/app.test.tsx`
- Modify: `tests/e2e/public-responsive.spec.ts`

**Interfaces:**
- Consumes: the existing `CopyableLinkCard` API and Clipboard behavior.
- Produces: `sensitive?: boolean` plus a forwarded ref to the Copy button for Task 7. Non-sensitive callers retain the current presentation.

- [ ] **Step 1: Write failing sensitive-card tests**

Use a literal secret URL and inspect `container.innerHTML`, every attribute, `textContent`, accessible names, and focusable descendants before Reveal. Assert the URL is absent and the visible mask is exactly 12 bullets for both a short and long value.

Cover:

```ts
expect(screen.getByRole('button', { name: 'Reveal management link' })).toBeVisible();
expect(screen.getByRole('button', { name: 'Copy management link' })).toBeVisible();
expect(navigator.clipboard.writeText).toHaveBeenCalledWith(secret);
expect(screen.queryByDisplayValue(secret)).not.toBeInTheDocument();
```

After Reveal, require one read-only text field. When Clipboard is absent or rejects, require Reveal first, then after commit the field has focus and selection `[0, secret.length]`. Rerender with a replacement value and assert immediate remasking, no old/new secret while hidden, and cleared Copied/fallback state. Also pin the current non-sensitive Event-link presentation.

- [ ] **Step 2: Run the component tests and verify RED**

Run:

```bash
npx vitest run --config vitest.config.ts \
  tests/ui/copyable-link-card.test.tsx \
  tests/ui/app.test.tsx -t 'link'
```

Expected: FAIL because the current card always mounts the complete value in `<code>`.

- [ ] **Step 3: Extend the component instead of creating a new credential widget**

Add `sensitive?: boolean` and forward the component ref to Copy. Keep state keyed to `value` so a prop change is remasked during render rather than waiting for an effect:

```ts
interface CopyResult {
  value: string;
  state: 'copied' | 'unavailable';
}

const revealed = revealedValue === value;
const currentCopyState = copyResult?.value === value ? copyResult.state : 'idle';
```

While sensitive and hidden, mount only an `aria-hidden` fixed mask plus Reveal and Copy buttons. Reveal mounts `<input readOnly value={value}>`. Copy reads the prop without revealing. On fallback, set the revealed value and in `useLayoutEffect` focus/select the input. A stale Clipboard completion for value A cannot mark value B copied.

- [ ] **Step 4: Apply sensitive mode only to credentials in this slice**

In the Create success screen use:

```tsx
<CopyableLinkCard label="Event link" value={created.eventLink} />
<CopyableLinkCard label="Management link" value={created.managementLink} sensitive />
```

Do not change the Manager-link rotation workflow here; C-10 and the replacement acknowledgement flow belong to ordered Slice 5, which will consume this sensitive component. Ordinary event links remain non-sensitive.

- [ ] **Step 5: Verify GREEN and responsive behavior**

Run:

```bash
npx vitest run --config vitest.config.ts \
  tests/ui/copyable-link-card.test.tsx \
  tests/ui/app.test.tsx -t 'link'
npx playwright test tests/e2e/public-responsive.spec.ts --project=mobile
```

Expected: PASS; hidden credentials do not enter the DOM and all controls remain reachable at 320/390 px.

- [ ] **Step 6: Record the task checkpoint without committing**

Record task files and RED/GREEN evidence. Leave the worktree uncommitted.

---

### Task 7: Consequence-aware Album-link creation and sensitive result

**Files:**
- Modify: `src/features/gallery/ManagerAlbum.tsx`
- Modify: `src/features/gallery/ManagerGalleryWorkspace.tsx`
- Modify: `src/components/CopyableLinkCard.tsx` only if the reviewed Task 6 ref contract needs a narrow correction
- Modify: `src/styles.css`
- Modify: `tests/ui/album-workspace.test.tsx`
- Modify: `tests/e2e/album-share.spec.ts`
- Modify: `tests/e2e/album-workspace.visual.spec.ts`
- Modify: `tests/e2e/accessibility.spec.ts`
- Modify: `docs/superpowers/host-gallery-verification-matrix.md`

**Interfaces:**
- Consumes: Task 2 summary invalidation, current Album draft, Task 6 sensitive card/copy ref, and the existing Stop-link modal focus trap/restoration pattern.
- Produces: explicit Create Album link confirmation, precise audience/live-projection copy, sensitive credential result, and Slice 2 verification rows.

- [ ] **Step 1: Write failing confirmation and result tests**

Open the creation dialog and assert no POST or draft flush has occurred. Pin literal consequence content containing current Album photo count, published-caption count, `people with the Album link`, and the live request-time rule that later membership/metadata/order changes affect the link.

Assert Cancel has initial focus. Escape, backdrop, and Cancel send no request and restore the invoking `Create Album link` control. Double activation of the explicit nondefault `Create Album link` confirm sends exactly one POST. On success, the complete URL is absent while hidden and `Copy Album link` has focus. A rejected request keeps the dialog open with one scoped error and allows safe cancellation/retry.

- [ ] **Step 2: Run focused UI/E2E tests and verify RED**

Run:

```bash
npx vitest run --config vitest.config.ts tests/ui/album-workspace.test.tsx -t 'Album link'
npx playwright test tests/e2e/album-share.spec.ts --project=desktop
```

Expected: FAIL because the existing action creates immediately and renders a raw `<code>` credential.

- [ ] **Step 3: Reuse the established modal contract for creation**

Opening the dialog snapshots the invoking element and current draft counts but sends no request. Published-caption count is:

```ts
draft.entries.filter((entry) => (
  entry.kind === 'photo'
  && entry.photo.publicationStatus === 'published'
  && Boolean(entry.photo.caption?.trim())
)).length
```

Only the explicit confirm settles the Album draft and then calls `shareAlbum`. Guard the operation with the existing synchronous ref so double submit remains one credential. Reuse the Stop modal's focus trap, Escape/backdrop cancellation, and return-focus behavior rather than adding a modal abstraction.

- [ ] **Step 4: Replace the custom Album credential display**

Delete the Album-specific raw `<code>`, copied/unavailable state, timer, and Clipboard function. Render:

```tsx
<CopyableLinkCard ref={shareCopyRef} label="Album link" value={share.url} sensitive />
```

After React commits the successful share, focus that Copy action. Announce `Album link is Live.` through the existing Gallery live region and call `onAudienceChanged()` so the persistent summary reloads. Align Stop-link copy with `Album link`, `Guest gallery`, `event guests`, and `people with the Album link` without changing its already-correct cancellation or revocation behavior.

- [ ] **Step 5: Update browser tests and the verification matrix**

Update selectors that assumed `Share album`, `Shared`, or `.album-share__link code`. Add keyboard traces for Cancel-first focus, Escape cancellation, explicit confirmation, success focus, Reveal/Copy, and heading hierarchy. Retain 44 px target/overflow checks at mobile sizes.

Replace the matrix's `Slices 2–6 — Not started` block with a complete Slice 2 table for C-01, C-02, C-18, C-20, C-24, C-28, C-29, C-30, C-31, C-39, C-40, C-48, C-51, C-60, C-65, and C-66. Each row names `implemented` or `verified-existing`, the concrete behavior, and at least one test that would fail without it. Preserve the Slice 1 section byte-for-byte apart from any necessary heading renumbering.

- [ ] **Step 6: Verify the completed slice**

Run:

```bash
npx vitest run --config vitest.config.ts \
  tests/unit/gallery-selection-state.test.ts \
  tests/ui/copyable-link-card.test.tsx \
  tests/ui/host-private-gallery.test.tsx \
  tests/ui/album-workspace.test.tsx \
  tests/ui/album-share-page.test.tsx \
  tests/ui/manager-guestbook.test.tsx \
  tests/ui/app.test.tsx
npx vitest run --config vitest.worker.config.ts \
  tests/worker/gallery-audience-summary.test.ts \
  tests/worker/album-api.test.ts \
  tests/worker/album-share-api.test.ts \
  tests/worker/media-recovery-api.test.ts \
  tests/worker/manage-api.test.ts
npx playwright test \
  tests/e2e/album-share.spec.ts \
  tests/e2e/album-workspace.spec.ts \
  tests/e2e/album-workspace.visual.spec.ts \
  tests/e2e/manager-responsive.spec.ts \
  tests/e2e/public-responsive.spec.ts \
  tests/e2e/accessibility.spec.ts
npm run typecheck
npm run typecheck:e2e
npm run lint
npm run build
git diff --check
```

Expected: every focused suite and static gate passes with no warnings or unexpected snapshot churn.

- [ ] **Step 7: Request broad Slice 2 review**

Prepare a task-scoped diff/report that distinguishes prior Slice 1 changes from Slice 2 changes. Request independent spec-compliance and code-quality review. Address every Critical/P1 and Important/P2 finding through test-first fix rounds before marking Slice 2 complete.

- [ ] **Step 8: Record the final checkpoint without committing**

Record final test counts, browser project/skip details, matrix coverage, review verdict, and remaining environmental gates. Leave the worktree uncommitted and do not start Slice 3 until Slice 2 review is clean.

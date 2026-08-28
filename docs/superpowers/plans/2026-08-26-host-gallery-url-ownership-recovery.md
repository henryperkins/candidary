# Host Gallery URL Ownership and Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Manager section and Gallery mode canonical URL-owned state, preserve those destinations through account recovery, and keep Album settlement authoritative before navigation is adopted.

**Architecture:** A pure `manager-location.ts` module owns query parsing, canonical serialization, Manager pathname validation, and strict recovery-return validation. `ManagerPage` derives its rendered section/mode from React Router, while `ManagerGalleryWorkspace` becomes controlled and requests mode changes without owning durable location. Existing Manager/Album settlement remains the only authorization boundary before navigation changes the URL.

**Tech Stack:** TypeScript, React 19, React Router, Vitest, Testing Library, Playwright

**Spec:** `docs/superpowers/specs/2026-08-23-host-gallery-navigation-responsive-accessibility-design.md`

## Global Constraints

- The route remains `/manage/event/:eventId`; do not add nested Manager routes.
- Canonical public Gallery modes are exactly `library | album | guest-gallery`; obsolete `mode=shared` is an input alias only.
- Query names and decoded values are case-sensitive; duplicate known keys are detected from all query pairs.
- Host-initiated destination changes push history; canonical cleanup replaces history while preserving pathname, hash, and Router state.
- No requested section or mode renders before Album/Router settlement authorizes adoption.
- Recovery accepts only origin-relative `/host/events` or a well-formed Manager path; it rejects fragments, protocol-relative/absolute input, credentials, unknown keys, duplicate known keys, and queries on `/host/events`.
- Preserve the existing six Manager labels, three Gallery labels, content, data ownership, resource controllers, autosave behavior, and focus contracts.
- No Worker route, API contract, database schema, migration, package, or dependency change belongs to this checkpoint.
- Every behavior change follows RED → GREEN → REFACTOR; the test must fail for the intended missing behavior before production code changes.
- Work only in `/home/henry/candidary/.worktrees/gallery-roadmap-remediation`; do not push, deploy, merge, or open a PR.

## Checkpoint Boundary

This is the first independently testable Slice 4 sub-project. It completes C-15 and the recovery prerequisite for later one-use intents. Separate plans own the versioned history-state envelope and C-44/C-45 anchors/intents, C-46 viewer continuation, C-23/C-27/C-43 responsive and focus remediation, and C-37's complete named Axe matrix. This checkpoint must not implement those later behaviors opportunistically.

---

### Task 1: Pure Manager location contract

**Files:**
- Create: `src/app/manager-location.ts`
- Create: `tests/unit/manager-location.test.ts`

**Interfaces:**
- Consumes: standard `URLSearchParams`; no React or Router imports.
- Produces:

```ts
export type ManagerSection =
  | 'intake' | 'rsvp' | 'gallery' | 'guestbook' | 'share' | 'settings';

export type GalleryMode = 'library' | 'album' | 'guest-gallery';

export type ManagerLocation =
  | { section: Exclude<ManagerSection, 'gallery'> }
  | { section: 'gallery'; mode: GalleryMode };

export interface ParsedManagerLocation {
  location: ManagerLocation;
  canonicalSearch: string;
  needsReplace: boolean;
  hasUnknownKeys: boolean;
  hasDuplicateKnownKeys: boolean;
}

export function parseManagerLocation(search: string): ParsedManagerLocation;
export function serializeManagerSearch(location: ManagerLocation): string;
export function managerHref(eventId: string, location: ManagerLocation): string;
export function isManagerEventId(value: string): boolean;
export function managerEventIdFromPathname(pathname: string): string | null;
export function canonicalManagerReturnPath(value: string): {
  eventId: string;
  href: string;
} | null;
```

- `canonicalSearch` is either empty or begins with `?`; `managerHref` is pathname plus canonical search.
- `canonicalManagerReturnPath` accepts recognized known keys at most once and applies the normal aliases/fallbacks, but rejects unknown keys, fragments, nonlocal input, and malformed Manager path/event ID.

- [ ] **Step 1: Write the failing parser/serializer table**

Create literal table cases in `tests/unit/manager-location.test.ts`:

```ts
it.each([
  ['', { section: 'intake' }, ''],
  ['?section=intake', { section: 'intake' }, ''],
  ['?section=rsvp', { section: 'rsvp' }, '?section=rsvp'],
  ['?section=guestbook', { section: 'guestbook' }, '?section=guestbook'],
  ['?section=share', { section: 'share' }, '?section=share'],
  ['?section=settings', { section: 'settings' }, '?section=settings'],
  ['?section=gallery', { section: 'gallery', mode: 'library' }, '?section=gallery'],
  ['?section=gallery&mode=library', { section: 'gallery', mode: 'library' }, '?section=gallery'],
  ['?section=gallery&mode=album', { section: 'gallery', mode: 'album' }, '?section=gallery&mode=album'],
  ['?section=gallery&mode=guest-gallery', { section: 'gallery', mode: 'guest-gallery' }, '?section=gallery&mode=guest-gallery'],
  ['?section=gallery&mode=shared', { section: 'gallery', mode: 'guest-gallery' }, '?section=gallery&mode=guest-gallery'],
  ['?mode=album', { section: 'intake' }, ''],
  ['?section=', { section: 'intake' }, ''],
  ['?section=%72svp', { section: 'rsvp' }, '?section=rsvp'],
  ['?section=%52svp', { section: 'intake' }, ''],
  ['?section=rsvp&mode=album', { section: 'rsvp' }, '?section=rsvp'],
  ['?section=gallery&mode=', { section: 'gallery', mode: 'library' }, '?section=gallery'],
  ['?section=gallery&mode=wrong', { section: 'gallery', mode: 'library' }, '?section=gallery'],
  ['?section=gallery&mode=album&mode=guest-gallery', { section: 'gallery', mode: 'library' }, '?section=gallery'],
  ['?section=rsvp&section=gallery&mode=album', { section: 'intake' }, ''],
  ['?section=Gallery', { section: 'intake' }, ''],
  ['?section=gallery&mode=Album', { section: 'gallery', mode: 'library' }, '?section=gallery'],
  ['?extra=1', { section: 'intake' }, ''],
  ['?section=gallery&mode=album&extra=1', { section: 'gallery', mode: 'album' }, '?section=gallery&mode=album'],
] as const)('parses %s to a canonical Manager location', (search, location, canonicalSearch) => {
  const parsed = parseManagerLocation(search);
  expect(parsed.location).toEqual(location);
  expect(parsed.canonicalSearch).toBe(canonicalSearch);
  expect(parsed.needsReplace).toBe(search !== canonicalSearch);
});
```

Add separate assertions that only unknown keys set `hasUnknownKeys`, only repeated `section`/`mode` set `hasDuplicateKnownKeys`, serializer order is `section` then `mode`, and all eight canonical locations round-trip.

- [ ] **Step 2: Run the new unit file and verify RED**

Run:

```bash
npx vitest run --config vitest.config.ts tests/unit/manager-location.test.ts
```

Expected: FAIL because `src/app/manager-location.ts` does not exist.

- [ ] **Step 3: Implement the minimal pure contract**

Implement exact known-key collection before branching:

```ts
const values = { section: [] as string[], mode: [] as string[] };
let hasUnknownKeys = false;
for (const [key, value] of new URLSearchParams(search)) {
  if (key === 'section' || key === 'mode') values[key].push(value);
  else hasUnknownKeys = true;
}
```

Use literal `Set`/`switch` validation, canonical `URLSearchParams` serialization, a module-level UUID-shape regular expression, and `new URL(value, 'https://candidary.invalid')` only after rejecting values that do not begin with `/` or begin with `//`. Strict return validation also rejects `url.hash`, `url.username`, `url.password`, foreign origin, unknown keys, and duplicate known keys.

- [ ] **Step 4: Run the new unit file and verify GREEN**

Run the command from Step 2. Expected: all new tests pass.

- [ ] **Step 5: Run the focused unit suite and commit**

Run:

```bash
npx vitest run --config vitest.config.ts tests/unit/manager-location.test.ts tests/unit/recovery.test.ts
npm run typecheck
```

Commit:

```bash
git add src/app/manager-location.ts tests/unit/manager-location.test.ts
git commit -m "feat: define canonical manager locations"
```

### Task 2: Recovery adopts the shared Manager location contract

**Files:**
- Modify: `src/app/recovery.ts`
- Modify: `src/components/HostAuthNav.tsx`
- Modify: `tests/unit/recovery.test.ts`
- Modify: `tests/ui/app.test.tsx`

**Interfaces:**
- Consumes: `canonicalManagerReturnPath()` and `isManagerEventId()` from Task 1.
- Produces: unchanged public signatures for `safeReturnTo`, `adoptTargetFor`, `hostSignInHref`, and `hostRegisterHref`.
- `safeReturnTo('/host/events')` remains exact; Manager aliases return the canonical Manager href.
- `AuthReturnNote` extracts its event ID with the shared canonical Manager parser, so query-bearing returns retain the event-specific note and authorized event-name read.

- [ ] **Step 1: Write failing recovery tests**

Add literal assertions covering:

```ts
expect(safeReturnTo(`/manage/event/${EVENT}?section=gallery&mode=album`))
  .toBe(`/manage/event/${EVENT}?section=gallery&mode=album`);
expect(safeReturnTo(`/manage/event/${EVENT}?section=gallery&mode=shared`))
  .toBe(`/manage/event/${EVENT}?section=gallery&mode=guest-gallery`);
expect(safeReturnTo(`/manage/event/${EVENT}?section=intake`))
  .toBe(`/manage/event/${EVENT}`);
expect(safeReturnTo(`/manage/event/${EVENT}?section=gallery&mode=album&extra=1`)).toBeNull();
expect(safeReturnTo(`/manage/event/${EVENT}?section=gallery&mode=album&mode=library`)).toBeNull();
expect(safeReturnTo(`/manage/event/${EVENT}?section=gallery#secret`)).toBeNull();
expect(safeReturnTo('/host/events?section=gallery')).toBeNull();
expect(adoptTargetFor(`/manage/event/${EVENT}?section=gallery&mode=album`, EVENT)).toBe(EVENT);
```

Retain existing absolute URL, protocol-relative, malformed UUID, mismatched adoption, and invalid-event tests. Add a `hostSignInHref` assertion whose encoded `returnTo` decodes to the canonical Guest-gallery URL.

In `tests/ui/app.test.tsx`, extend the existing expired-management-link return-note case with `/host/login?returnTo=<encoded Album URL>&adopt=<event ID>`. Assert the event-name read occurs and the note says the event will be added to the account. This catches any return to the current pathname-only extraction regular expression.

- [ ] **Step 2: Run recovery tests and verify RED**

Run:

```bash
npx vitest run --config vitest.config.ts tests/unit/recovery.test.ts
npx vitest run --config vitest.config.ts tests/ui/app.test.tsx -t "keeps the return note for a query-bearing Manager destination"
```

Expected: FAIL because the current path-only regular expression rejects query-bearing Manager returns.

- [ ] **Step 3: Replace the recovery-local Manager regular expression**

Keep the public API and host-event behavior, but make Manager validation delegate:

```ts
export function safeReturnTo(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value === HOST_EVENTS_PATH) return value;
  return canonicalManagerReturnPath(value)?.href ?? null;
}

export function adoptTargetFor(returnTo: string | null, adopt: string | null | undefined): string | null {
  if (!adopt || !isManagerEventId(adopt) || !returnTo) return null;
  const eventId = canonicalManagerReturnPath(returnTo)?.eventId;
  return eventId?.toLowerCase() === adopt.toLowerCase() ? adopt : null;
}
```

Use `isManagerEventId()` from `manager-location.ts` rather than retaining a second divergent pattern.

Delete `HostAuthNav`'s pathname-only `MANAGER_EVENT` regular expression. Because `returnTo` has already passed `safeReturnTo`, read the ID with `canonicalManagerReturnPath(returnTo)?.eventId ?? null`; do not make the component a second validator.

- [ ] **Step 4: Run recovery and manager-location tests and verify GREEN**

Run:

```bash
npx vitest run --config vitest.config.ts tests/unit/manager-location.test.ts tests/unit/recovery.test.ts
npx vitest run --config vitest.config.ts tests/ui/app.test.tsx -t "keeps the return note for a query-bearing Manager destination"
```

- [ ] **Step 5: Run typecheck and commit**

Run `npm run typecheck`, then commit:

```bash
git add src/app/recovery.ts src/components/HostAuthNav.tsx tests/unit/recovery.test.ts tests/ui/app.test.tsx
git commit -m "fix: preserve manager destinations through recovery"
```

### Task 3: Make Gallery mode a controlled Router-facing value

**Files:**
- Modify: `src/features/gallery/ManagerGalleryWorkspace.tsx`
- Modify: `src/pages/ManagerPage.tsx`
- Modify: `tests/ui/album-workspace.test.tsx`
- Modify: `tests/ui/app.test.tsx`
- Modify: `tests/ui/host-private-gallery.test.tsx`

**Interfaces:**
- Consumes: exported `GalleryMode` from `src/app/manager-location.ts`.
- Produces an exported `ManagerGalleryWorkspaceProps` interface with two required props:

```ts
mode: GalleryMode;
onModeChange(mode: GalleryMode): void;
```

- The mode button requests a change; it does not render the requested mode until the parent supplies that prop.
- The existing imperative `ManagerGalleryWorkspaceHandle` remains unchanged and reports Album preparation from the controlled mode.
- Replace the private `shared` mode value with canonical `guest-gallery` throughout production code; compatibility remains only at URL parsing.
- During this intermediate refactor commit, `ManagerPage` temporarily owns one `GalleryMode` state and adopts mode requests through its existing Album-leave coordinator. Task 4 removes that transitional state and derives the value from Router location; no second or optional workspace owner is permitted.

- [ ] **Step 1: Write the failing controlled-mode regression**

In `tests/ui/album-workspace.test.tsx`, render with `mode="library"` and a spy callback. Click **Album** and assert the callback receives `album` while Library content remains until `rerender` supplies `mode="album"`. Add the inverse assertion from `guest-gallery` to Library so selection cleanup is tied to adopted mode rather than a click that might be blocked.

The mutation caught is restoring local `useState('library')` or committing the requested mode before Router adoption.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run --config vitest.config.ts tests/ui/album-workspace.test.tsx -t "waits for the controlled Gallery mode to be adopted"
```

Expected: FAIL because `mode` and `onModeChange` are not production props and the workspace commits local state.

- [ ] **Step 3: Convert the workspace to controlled mode**

Remove the workspace's local `useState<GalleryMode>('library')` and local mode-leave destination owner. Mode buttons call `onModeChange(value)`. Keep external Album settlement methods and `externalLeaveActive` ownership. On an adopted transition away from Guest gallery, clear its selection once; do not add Slice 4 anchor or intent behavior in this checkpoint.

Move the single temporary mode owner to `ManagerPage`, pass it through both required props, and extend `ManagerLeaveDestination` with `{ kind: 'gallery-mode'; mode: GalleryMode }`. A non-Album request may adopt the parent value directly. A request away from controlled Album must enter the existing `beginAlbumLeave()` generation and adopt only after its exact outcome is ready; retry, stay, and discard keep using the existing Manager prompt. This is a compile-safe migration bridge, not URL ownership: do not call `navigate()` or read search state here. Task 4 replaces this temporary state and rewires the already-centralized destination commit to Router navigation.

Update all test render helpers with small test-owned controlled wrappers where a test clicks modes:

```tsx
function ControlledWorkspace(props: Omit<ManagerGalleryWorkspaceProps, 'mode' | 'onModeChange'>) {
  const [mode, setMode] = useState<GalleryMode>('library');
  return <ManagerGalleryWorkspace {...props} mode={mode} onModeChange={setMode} />;
}
```

Tests that do not navigate pass an explicit fixed mode and no-op callback. Do not make the production props optional merely to satisfy older tests.

- [ ] **Step 4: Run Gallery UI tests and verify GREEN**

Run:

```bash
npx vitest run --config vitest.config.ts tests/ui/album-workspace.test.tsx tests/ui/host-private-gallery.test.tsx tests/ui/app.test.tsx
```

- [ ] **Step 5: Run both typechecks and commit**

Run:

```bash
npm run typecheck
npm run typecheck:e2e
```

Commit:

```bash
git add src/features/gallery/ManagerGalleryWorkspace.tsx src/pages/ManagerPage.tsx tests/ui/album-workspace.test.tsx tests/ui/app.test.tsx tests/ui/host-private-gallery.test.tsx
git commit -m "refactor: control gallery mode from its owner"
```

### Task 4: Make React Router the sole rendered Manager location owner

**Files:**
- Modify: `src/pages/ManagerPage.tsx`
- Modify: `tests/ui/app.test.tsx`
- Modify: `tests/ui/manager-recovery.test.tsx`
- Modify: `tests/e2e/album-workspace.visual.spec.ts`
- Modify: `docs/superpowers/host-gallery-verification-matrix.md`

**Interfaces:**
- Consumes: `parseManagerLocation()`, `managerHref()`, `ManagerLocation`, and Task 3's transitional controlled Gallery owner.
- Produces URL-controlled section/mode rendering, canonical `replace`, user-navigation `push`, recovery links retaining `pathname + canonicalSearch`, and unchanged Album settlement behavior.
- Existing `openRecentlyDeleted` and Settings-repair paths remain local transient actions until the later intent checkpoint; their side effects occur only when the authorized destination is committed.
- The Router blocker predicate covers both unconfirmed work and leaving the current canonical Album location. An exact programmatic target authorized by a completed Album preparation bypasses only the Album-location part of that predicate, never unrelated unsaved-work guards.

- [ ] **Step 1: Write failing Router-table and history tests**

Extend `tests/ui/app.test.tsx` with a literal table for these initial entries, selected Manager navigation labels, and selected Gallery modes:

```ts
[
  [`/manage/event/${EVENT}`, 'Intake', null, ''],
  [`/manage/event/${EVENT}?section=intake`, 'Intake', null, ''],
  [`/manage/event/${EVENT}?section=rsvp`, 'RSVP', null, '?section=rsvp'],
  [`/manage/event/${EVENT}?section=gallery`, 'Gallery', 'Library', '?section=gallery'],
  [`/manage/event/${EVENT}?section=gallery&mode=album`, 'Gallery', 'Album', '?section=gallery&mode=album'],
  [`/manage/event/${EVENT}?section=gallery&mode=guest-gallery`, 'Gallery', 'Guest gallery', '?section=gallery&mode=guest-gallery'],
  [`/manage/event/${EVENT}?section=guestbook`, 'Guestbook', null, '?section=guestbook'],
  [`/manage/event/${EVENT}?section=share`, 'Share', null, '?section=share'],
  [`/manage/event/${EVENT}?section=settings`, 'Settings', null, '?section=settings'],
]
```

Assert the selected Manager button with `aria-pressed="true"`; when a Gallery mode is present, assert its selected mode button the same way. For redundant Intake, assert Router replaces to the empty search. Add malformed/alias inputs for duplicate section, mode outside Gallery, obsolete Shared, and unknown keys; assert canonical URL plus the canonical rendered destination.

Add one history traversal test: start Intake, click Gallery, click Album, then `router.navigate(-1)` twice and assert Album → Library → Intake with matching searches. This catches a reintroduced local state owner.

Add a recovery test from `?section=gallery&mode=album` that asserts the rendered Sign-in href decodes to the same canonical Manager destination.

- [ ] **Step 2: Write failing Album settlement navigation tests**

Use the existing deferred Album-save fixture in `tests/ui/app.test.tsx`. From Album, click Library and assert URL/content remain Album while preparation is waiting or invalid; after the exact ready settlement, assert one pushed `?section=gallery` entry and Library content. Repeat with a Manager-section click and browser Back to prove all three request sources authorize adoption through the existing generation/blocker owner.

Add a clean-Album Back regression: enter Album through history, make no edit, request Back, and assert the Router location remains Album in the turn where the blocker owns the request before automatically adopting the prior entry after ready settlement. The temporary clean check must not render the unsaved-Album prompt. This observable pause catches a blocker predicate based only on `unconfirmedDomains`, which lets clean Album history navigation bypass settlement.

The mutation caught is calling `navigate()` before `prepareToLeave()` settles or rendering from requested state instead of Router location.

- [ ] **Step 3: Run the new focused tests and verify RED**

Run the exact new test names with:

```bash
npx vitest run --config vitest.config.ts tests/ui/app.test.tsx tests/ui/manager-recovery.test.tsx -t "canonical Manager location|traverses Manager work in history|keeps Album rendered until URL settlement|preserves the Manager destination in recovery"
```

Expected: failures showing current initial-only section parsing, transitional local Gallery mode, Back exiting work, and queryless recovery links.

- [ ] **Step 4: Derive section and mode from Router**

Use `useLocation()` and `useNavigate()` in `ManagerEventPage`:

```ts
const routerLocation = useLocation();
const navigate = useNavigate();
const parsedLocation = parseManagerLocation(routerLocation.search);
const section = parsedLocation.location.section;
const galleryMode = parsedLocation.location.section === 'gallery'
  ? parsedLocation.location.mode
  : 'library';
```

Canonicalize in a layout effect only when `needsReplace`, preserving `routerLocation.state` and hash. Remove `initialSection()`, the independent `section` state, and Task 3's transitional `galleryMode` state. Initialize Settings' retained mount from the parsed section. Split destination request, settlement, and adoption cleanup so selection/error resets and top scrolling happen after the URL is adopted, while Settings/Appearance flush still happens when leaving is requested.

Reuse the local `{ kind: 'gallery-mode'; mode: GalleryMode }` destination added in Task 3. Replace its temporary state commit with serialization and `navigate(target)` only after the current Album preparation generation is ready. Record that exact authorized target in a ref until adoption so the Router blocker does not repeat the Album preparation; the authorization bypasses only the Album-location condition and is retired on adoption, cancellation, or replacement. Pass Router-derived `galleryMode` and the request callback to `ManagerGalleryWorkspace`.

Change `useBlocker` from the current boolean to a function. It returns true when ordinary `shouldBlockNavigation` is true or when the current pathname/event and parsed location are the canonical Gallery Album and the next location is anything else. Browser Back/Forward therefore enters the existing destination-keyed `beginAlbumLeave({ kind: 'router' })` generation and calls `blocker.proceed()` only after ready settlement. Hide the Album prompt while a clean Album check is merely waiting with no unconfirmed domains; show the existing prompt for invalid/failed Album outcomes or actual unconfirmed work.

Pass `routerLocation.pathname + parsedLocation.canonicalSearch` into both full-page and inline `ManagerAccessRecovery` instances, and then into `hostSignInHref`.

- [ ] **Step 5: Run focused UI tests and verify GREEN**

Run:

```bash
npx vitest run --config vitest.config.ts tests/unit/manager-location.test.ts tests/unit/recovery.test.ts tests/ui/app.test.tsx tests/ui/manager-recovery.test.tsx tests/ui/album-workspace.test.tsx tests/ui/host-private-gallery.test.tsx
```

- [ ] **Step 6: Run the focused browser regression**

Update the visual test helper to navigate through canonical Gallery URLs/controls, then run:

```bash
npx playwright test tests/e2e/album-workspace.visual.spec.ts --project=desktop -g "album mode is keyboard-operable and respects reduced motion"
```

Expected: one pass. Do not update or create visual baselines in this checkpoint.

- [ ] **Step 7: Record C-15 and run final checkpoint gates**

Replace the `Slices 4–6 Not started` placeholder with a Slice 4 section containing C-15 as `implemented`, naming `manager-location.ts`, URL-controlled Manager/Gallery, recovery preservation, and the owning unit/UI/E2E tests. Leave every other Slice 4 finding unclaimed.

Run:

```bash
npm run typecheck
npm run typecheck:e2e
npm run lint
npm test
npm run build
git diff --check
```

Then run the changed browser paths functionally on Linux:

```bash
npx playwright test tests/e2e/album-workspace.visual.spec.ts --project=desktop -g "album mode is keyboard-operable and respects reduced motion"
```

- [ ] **Step 8: Commit the URL-ownership checkpoint**

```bash
git add src/pages/ManagerPage.tsx tests/ui/app.test.tsx tests/ui/manager-recovery.test.tsx tests/e2e/album-workspace.visual.spec.ts docs/superpowers/host-gallery-verification-matrix.md
git commit -m "feat: make manager location URL-owned"
```

Do not push. The next Slice 4 plan starts the versioned history-state envelope, one-use intents, and per-mode anchors from the now-canonical Router location.

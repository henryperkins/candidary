# Mobile-First UI Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every P1, P2, and P3 item from the July 27 mobile-first UI audit and replace the current desktop-first repair layer with tested narrow-first behavior from 320 px upward.

**Architecture:** Keep the existing React/Vite and Hono/Cloudflare architecture. Convert each touched surface to narrow-screen base rules with progressive `min-width` enhancements, add keyset pagination to manager media, and promote deterministic long-content fixtures into the tracked Playwright suite. Product behavior changes stay local to the upload queue, link fallback, manager media paging, and recoverable load states.

**Tech Stack:** TypeScript 6, React 19, React Router 7, Hono, Cloudflare Workers/D1/R2, Vitest, Testing Library, Playwright 1.61.1, and `@axe-core/playwright` 4.12.1.

## Global Constraints

- Preserve the pre-existing uncommitted changes in `docs/security.md`, `src/pages/CreatePage.tsx`, and `src/pages/ManagerPage.tsx`, plus the untracked `CLAUDE.md`. Never stage those changes by accident.
- Treat 320 px as the minimum supported width. Verify 320, 360, 390, 430, 761, 768, 780, 860, 1024, 1100, 1101, 1120, 1133, 1134, and 1440 px where the audit identified boundary behavior.
- Use narrow-screen base styles and progressive `@media (min-width: ...)` enhancements for every selector touched by this plan. Do not add another `max-width` repair for a failing band.
- The document must satisfy `document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1` in every tested state. `overflow: hidden` is not an accepted containment fix.
- Interactive targets must measure at least 44 by 44 CSS pixels. Caption, filename, status, and error text must remain within the design-system 12–14 px range.
- Preserve the Candidary palette, Manrope/DM Sans typography, Lucide icons, approved above-the-fold copy, and the existing five manager destinations.
- Keep originals private, publication state orthogonal, exports complete, and authorization behavior unchanged.
- Manager media uses keyset pagination with a default page size of 24 and a hard maximum of 50. Polling refreshes only the first page and must not discard already-loaded pages.
- A client-side validation failure may not suppress the receipt for photos that were actually delivered. Server or transfer failures remain retryable and continue to block a terminal receipt.
- Automated accessibility checks supplement, but do not replace, keyboard, geometry, zoom, reduced-motion, and physical-device release gates.
- Do not deploy. This plan ends with a verified source branch and tracked test evidence.

## Scope and File Map

The audit covers three coupled workstreams: public/guest responsive composition, manager scale/layout, and cross-surface accessibility evidence. They remain in one ordered plan because they share fixtures, geometry helpers, breakpoint rules, and final visual baselines; the manager pagination API and client are still separate review gates.

**Create:**

- `tests/e2e/fixtures/ui-data.ts` — deterministic long-content and scale fixtures.
- `tests/e2e/fixtures/routes.ts` — reusable guest, manager, image, and error route stubs.
- `tests/e2e/helpers/geometry.ts` — measurement helpers with no product-specific assertions.
- `tests/e2e/guest-responsive.spec.ts` — guest first-fold, gallery, fullscreen, review, landscape, and motion coverage.
- `tests/e2e/public-responsive.spec.ts` — landing, create, link fallback, and workflow breakpoint coverage.
- `tests/e2e/manager-responsive.spec.ts` — manager navigation, content containment, labels, contrast, and target coverage.
- `tests/e2e/manager-scale.spec.ts` — pagination, polling, export reachability, and section-scroll coverage.
- `tests/e2e/error-recovery.spec.ts` — guest and manager retry flows.
- `migrations/0004_manager_media_pagination.sql` — manager keyset-paging indexes.
- `worker/http/media-cursor.ts` — opaque manager-media cursor codec.
- `src/components/ManagerExportPanel.tsx` — one export presentation reused by the desktop utility rail and mobile Share section.

**Modify:**

- `src/styles.css`
- `src/pages/LandingPage.tsx`
- `src/pages/CreatePage.tsx`
- `src/pages/EventPage.tsx`
- `src/pages/ManagerPage.tsx`
- `src/components/Brand.tsx`
- `src/components/CopyableLinkCard.tsx`
- `src/components/States.tsx`
- `src/features/uploads/GuestUploadFlow.tsx`
- `src/features/uploads/upload-queue.ts`
- `src/app/types.ts`
- `shared/constants.ts`
- `worker/db/media.ts`
- `worker/routes/manage.ts`
- `tests/unit/upload-queue.test.ts`
- `tests/ui/guest-upload-flow.test.tsx`
- `tests/ui/app.test.tsx`
- `tests/worker/manage-api.test.ts`
- `tests/worker/repositories.test.ts`
- `tests/e2e/core-journey.spec.ts`
- `tests/e2e/accessibility.spec.ts`
- `tests/e2e/visual-qa.spec.ts`
- `playwright.config.ts`
- `package.json`
- `package-lock.json`
- `vitest.worker.config.ts`
- `design-qa.md`
- `design/fidelity-ledger.md`
- `docs/deployment.md`

One additive index migration is required; no table shape or binding changes are required. This deliberately amends the earlier host-view spec's “no API changes” boundary because the audit established that client-only lazy loading cannot close P1-4 at the supported 10,000-photo scale.

---

### Task 1: Tracked responsive fixtures and guest secondary-content containment

**Findings:** P1-1, P1-2, P2-3

**Files:**

- Create: `tests/e2e/fixtures/ui-data.ts`
- Create: `tests/e2e/fixtures/routes.ts`
- Create: `tests/e2e/helpers/geometry.ts`
- Create: `tests/e2e/guest-responsive.spec.ts`
- Modify: `src/pages/EventPage.tsx:79-83,101-114`
- Modify: `src/styles.css:21,84-90,102,186-187`
- Modify: `tests/e2e/core-journey.spec.ts:43-118`

**Interfaces:**

- Produces `LONG_FILENAME`, `UNBROKEN_TOKEN`, `makeMedia(count)`, `stubGuestRoutes(page, options)`, `measureDocument(page)`, and `measureTarget(locator)`.
- Later browser tasks consume the same fixtures and geometry helpers.

- [ ] **Step 1: Add deterministic fixture and geometry helpers**

```ts
// tests/e2e/helpers/geometry.ts
import type { Locator, Page } from '@playwright/test';

export async function measureDocument(page: Page) {
  return page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
}

export async function measureTarget(locator: Locator) {
  const box = await locator.boundingBox();
  return { width: box?.width ?? 0, height: box?.height ?? 0 };
}

export async function measureOverflow(locator: Locator) {
  return locator.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
}
```

Define the tracked literals in `tests/e2e/fixtures/ui-data.ts`:

```ts
export const LONG_FILENAME = `IMG_${'A'.repeat(80)}.HEIC`;
export const UNBROKEN_TOKEN = 'https://candidary.example/'.concat('x'.repeat(110));

export function makeMedia(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    originalFilename: index === 0 ? LONG_FILENAME : `moment-${index + 1}.jpg`,
    guestName: 'Avery Stone',
    caption: index === 0 ? LONG_FILENAME : `Moment ${index + 1}`,
    publicationStatus: 'published' as const,
    uploadState: 'stored' as const,
    width: 1200,
    height: 900,
    createdAt: new Date(Date.UTC(2026, 6, 27, 12, 0, index)).toISOString(),
  }));
}
```

Add the reusable guest route stub:

```ts
// tests/e2e/fixtures/routes.ts
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';

import { makeMedia } from './ui-data';

const preview = readFileSync('public/assets/candidary-hero.png');

export const EVENT_FIXTURE = {
  id: 'event-a',
  slug: 'maya-theo',
  name: 'Maya & Theo',
  eventDate: '2026-09-19',
  welcomeMessage: 'We would love to see the day through your eyes.',
  uploadsEnabled: true,
  galleryVisible: true,
  moderationRequired: true,
  storedMediaCount: 1,
  storedBytes: 128,
  guestAccessExpiresAt: '2026-10-19T00:00:00Z',
  purgeAfter: '2026-12-19T00:00:00Z',
};

interface GuestRouteOptions {
  event?: typeof EVENT_FIXTURE;
  gallery?: ReturnType<typeof makeMedia>;
  contributions?: ReturnType<typeof makeMedia>;
  messages?: Array<{
    id: string;
    guestName: string;
    body: string;
    moderationStatus: 'approved';
    createdAt: string;
  }>;
}

export async function stubGuestRoutes(page: Page, options: GuestRouteOptions = {}) {
  const event = options.event ?? EVENT_FIXTURE;
  const gallery = options.gallery ?? makeMedia(1);
  const contributions = options.contributions ?? gallery;
  const messages = options.messages ?? [];

  await page.route('**/api/media/*/preview', (route) => route.fulfill({
    status: 200,
    contentType: 'image/png',
    body: preview,
  }));
  await page.route('**/api/event/maya-theo', (route) => route.fulfill({
    json: { data: { event, role: 'guest' }, requestId: 'request-a' },
  }));
  await page.route('**/api/event/maya-theo/gallery', (route) => route.fulfill({
    json: { data: { media: gallery }, requestId: 'request-a' },
  }));
  await page.route('**/api/event/maya-theo/contributions', (route) => route.fulfill({
    json: { data: { media: contributions }, requestId: 'request-a' },
  }));
  await page.route('**/api/event/maya-theo/messages', (route) => route.fulfill({
    json: { data: { items: messages }, requestId: 'request-a' },
  }));
}
```

- [ ] **Step 2: Write failing guest gallery and fullscreen geometry tests**

Add tests that set the existing mobile context to 320 by 844, expand `Shared gallery` and `My deliveries`, and assert:

```ts
const documentSize = await measureDocument(page);
expect(documentSize.scrollWidth).toBeLessThanOrEqual(documentSize.clientWidth + 1);

const filenameSize = await measureOverflow(page.locator('.contributions li > span').first());
expect(filenameSize.scrollWidth).toBeLessThanOrEqual(filenameSize.clientWidth + 1);
```

For `/event/maya-theo/fullscreen`, assert the same document condition, contained `figcaption`, and a close target at least 44 by 44:

```ts
const closeSize = await measureTarget(page.getByRole('link', { name: 'Close full-screen gallery' }));
expect(closeSize.width).toBeGreaterThanOrEqual(44);
expect(closeSize.height).toBeGreaterThanOrEqual(44);
```

- [ ] **Step 3: Run the tests and confirm the audit failures**

Run:

```powershell
npx playwright test tests/e2e/guest-responsive.spec.ts --project=mobile -g "secondary sections|full-screen gallery"
```

Expected: FAIL because the document widens for long filenames, the fullscreen caption widens its track, and the close target is narrower than 44 px.

- [ ] **Step 4: Convert the affected guest grids to contained narrow-first rules**

Implement these rules as the base behavior, then move the existing multi-column forms into `min-width` enhancements:

```css
figure {
  margin: 0;
}

.photo-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 9px;
}

.photo-grid figure,
.photo-grid figcaption,
.photo-grid figcaption span,
.contributions li > span,
.fullscreen figure,
.fullscreen figcaption {
  min-width: 0;
  overflow-wrap: anywhere;
}

.contributions {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
}

.contributions li {
  grid-template-columns: 52px minmax(0, 1fr) auto;
}

.fullscreen__grid {
  grid-template-columns: minmax(0, 1fr);
}

.fullscreen__bar a {
  min-width: 44px;
  min-height: 44px;
  display: grid;
  place-items: center;
}

@media (min-width: 761px) {
  .photo-grid {
    grid-template-columns: repeat(12, minmax(0, 1fr));
  }

  .contributions {
    grid-template-columns: 300px minmax(0, 1fr);
  }

  .fullscreen__grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
```

- [ ] **Step 5: Replace the vacuous body overflow assertion**

In `tests/e2e/core-journey.spec.ts`, replace the `body` CSS-property check with:

```ts
const documentSize = await page.evaluate(() => ({
  clientWidth: document.documentElement.clientWidth,
  scrollWidth: document.documentElement.scrollWidth,
}));
expect(documentSize.scrollWidth).toBeLessThanOrEqual(documentSize.clientWidth + 1);
```

Derive direct-upload URLs from the active page origin:

```ts
const uploadOrigin = new URL(page.url()).origin;
uploadUrl: `${uploadOrigin}/direct-upload/${file.idempotencyKey}`,
```

- [ ] **Step 6: Run targeted guest tests**

Run:

```powershell
npx playwright test tests/e2e/guest-responsive.spec.ts tests/e2e/core-journey.spec.ts --project=mobile
```

Expected: PASS with no document overflow at 320 or 390 px.

- [ ] **Step 7: Commit only this task**

```powershell
git add tests/e2e/fixtures/ui-data.ts tests/e2e/fixtures/routes.ts tests/e2e/helpers/geometry.ts tests/e2e/guest-responsive.spec.ts tests/e2e/core-journey.spec.ts src/pages/EventPage.tsx src/styles.css
git diff --cached --check
git commit -m "fix: contain guest media on narrow screens"
```

---

### Task 2: Delivered-receipt semantics for mixed valid and invalid selections

**Findings:** P2-2

**Files:**

- Modify: `src/features/uploads/upload-queue.ts:140-144`
- Modify: `src/features/uploads/GuestUploadFlow.tsx:195,270-288,358-365`
- Modify: `tests/unit/upload-queue.test.ts`
- Modify: `tests/ui/guest-upload-flow.test.tsx`

**Interfaces:**

- `getReceiptCount(items)` ignores client-validation failures when deciding whether every deliverable item completed.
- Transfer, reservation, or finalization failures still return `null`.
- An all-invalid selection remains in review with explicit remove-or-replace guidance.

- [ ] **Step 1: Write the failing queue tests**

```ts
it('counts delivered photos when validation failures remain', () => {
  const delivered = { ...item('sent'), state: 'delivered' as const };
  const invalid = {
    ...item('invalid'),
    state: 'failed' as const,
    validationError: true,
    error: 'Choose a supported photo.',
  };
  expect(getReceiptCount([delivered, invalid])).toBe(1);
  expect(getReceiptCount([invalid])).toBeNull();
});

it('keeps a transfer failure from producing a receipt', () => {
  const delivered = { ...item('sent'), state: 'delivered' as const };
  const failed = { ...item('failed'), state: 'failed' as const, error: 'Reception dropped out.' };
  expect(getReceiptCount([delivered, failed])).toBeNull();
});
```

- [ ] **Step 2: Run the unit test and verify RED**

Run:

```powershell
npx vitest run --config vitest.config.ts tests/unit/upload-queue.test.ts -t "validation failures|transfer failure"
```

Expected: the mixed delivered/validation case returns `null`.

- [ ] **Step 3: Implement the minimal queue rule**

```ts
export function getReceiptCount(items: readonly UploadQueueItem[]): number | null {
  const deliverable = items.filter(({ validationError }) => !validationError);
  if (deliverable.length === 0 || deliverable.some(({ state }) => state !== 'delivered')) return null;
  return deliverable.length;
}
```

- [ ] **Step 4: Add failing UI cases for mixed and all-invalid selections**

The mixed case selects one JPEG and one invalid text file, sends the JPEG, and expects:

```ts
expect(await screen.findByRole('heading', { name: 'Your 1 photo was sent.' })).toBeVisible();
expect(screen.getByText('1 photo could not be added.')).toBeVisible();
```

The all-invalid case expects no Send button and exact guidance:

```ts
expect(screen.queryByRole('button', { name: /^Send/u })).not.toBeInTheDocument();
expect(screen.getByText('Remove or replace the photos that need attention.')).toBeVisible();
expect(screen.queryByText('Keep this page open while your photos transfer.')).not.toBeInTheDocument();
```

- [ ] **Step 5: Render accurate receipt and recovery copy**

Compute `validationFailureCount` separately. In the terminal receipt, retain the delivered count and add:

```tsx
{validationFailureCount > 0 && (
  <p>{validationFailureCount} {plural(validationFailureCount, 'photo')} could not be added.</p>
)}
```

When every item is a validation failure, replace the transfer note with:

```tsx
<p className="progress-note">Remove or replace the photos that need attention.</p>
```

- [ ] **Step 6: Run queue and component tests**

Run:

```powershell
npx vitest run --config vitest.config.ts tests/unit/upload-queue.test.ts tests/ui/guest-upload-flow.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/features/uploads/upload-queue.ts src/features/uploads/GuestUploadFlow.tsx tests/unit/upload-queue.test.ts tests/ui/guest-upload-flow.test.tsx
git diff --cached --check
git commit -m "fix: receipt delivered photos with invalid siblings"
```

---

### Task 3: Explicit in-flight upload state and safe cancellation

**Findings:** P3-2

**Files:**

- Modify: `src/features/uploads/upload-queue.ts:29-137`
- Modify: `src/features/uploads/GuestUploadFlow.tsx:67-151,183-268,298-365`
- Modify: `tests/unit/upload-queue.test.ts`
- Modify: `tests/ui/guest-upload-flow.test.tsx`

**Interfaces:**

- Produces `RunUploadQueueOptions { concurrency?: number; onChange?: (items) => void; signal?: AbortSignal }`.
- `UploadTransport.reserve`, `upload`, and `finalize` accept an optional `AbortSignal`.
- Cancelling marks undelivered items as recoverable failures; already-delivered items remain delivered.

- [ ] **Step 1: Add failing unit tests for cancellation**

Create a deferred upload transport, abort it, and assert:

```ts
const controller = new AbortController();
const promise = runUploadQueue([item('a'), item('b')], transport, {
  concurrency: 2,
  signal: controller.signal,
});
controller.abort();
const result = await promise;
expect(result.filter(({ state }) => state === 'delivered')).toHaveLength(0);
expect(result.every(({ state }) => state === 'failed')).toBe(true);
expect(result.every(({ error }) => error === 'Sending was cancelled. Retry when you are ready.')).toBe(true);
```

- [ ] **Step 2: Run the cancellation test and verify RED**

Run:

```powershell
npx vitest run --config vitest.config.ts tests/unit/upload-queue.test.ts -t "cancels undelivered"
```

Expected: FAIL because the queue and transport do not accept a signal.

- [ ] **Step 3: Introduce the options and signal contracts**

```ts
export interface RunUploadQueueOptions {
  concurrency?: number;
  onChange?: (items: UploadQueueItem[]) => void;
  signal?: AbortSignal;
}

export interface UploadTransport {
  reserve(items: readonly UploadQueueItem[], signal?: AbortSignal): Promise<readonly ReservationResult[]>;
  upload(
    item: UploadQueueItem,
    reservation: UploadReservation,
    progress: (percent: number) => void,
    signal?: AbortSignal,
  ): Promise<void>;
  finalize(item: UploadQueueItem, reservation: UploadReservation, signal?: AbortSignal): Promise<void>;
  retryUploadAfterFinalizeError?(error: unknown): boolean;
}
```

Change `runUploadQueue` to accept the options object, pass `signal` to each transport stage, stop dequeuing work after abort, and normalize every non-delivered active item to:

```ts
{
  state: 'failed',
  error: 'Sending was cancelled. Retry when you are ready.',
  retryStage: undefined,
}
```

- [ ] **Step 4: Wire AbortSignal into fetch and XHR**

Update `xhrUpload` to accept a signal:

```ts
function xhrUpload(
  file: File,
  reservation: UploadReservation,
  progress: (percent: number) => void,
  signal?: AbortSignal,
) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    signal?.addEventListener('abort', abort, { once: true });
    request.open('PUT', reservation.uploadUrl);
    request.setRequestHeader('Content-Type', reservation.mimeType);
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) progress((event.loaded / event.total) * 100);
    });
    request.addEventListener('load', () => {
      signal?.removeEventListener('abort', abort);
      request.status >= 200 && request.status < 300
        ? resolve()
        : reject(new Error('The transfer was interrupted. Try this photo again.'));
    });
    request.addEventListener('error', () => reject(new Error('Reception dropped out. Try this photo again.')));
    request.addEventListener('abort', () => reject(new DOMException('Sending was cancelled.', 'AbortError')));
    request.send(file);
  });
}
```

Pass `signal` into `api` request init for reserve/finalize and stop retry delays when it is aborted.

- [ ] **Step 5: Add a failing UI test for stable in-flight controls**

Use a deferred upload and assert:

```ts
await user.click(screen.getByRole('button', { name: 'Send 1 photo' }));
expect(screen.getByRole('heading', { name: 'Sending photos' })).toBeVisible();
expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled();
expect(screen.getByRole('button', { name: 'Cancel sending' })).toBeEnabled();
```

After clicking Cancel, assert `Retry 1 photo` and the cancellation message are visible.

- [ ] **Step 6: Keep the in-flight action mounted and add cancellation**

Store the active controller in a ref. Render the action whenever `sending || unresolvedCount > 0`:

```tsx
{(sending || unresolvedCount > 0) && (
  <button type="button" className="send-button" disabled={sending} onClick={() => void send()}>
    {sending ? <><LoaderCircle aria-hidden="true" /> Sending…</> : sendLabel}
  </button>
)}
{sending && (
  <button type="button" className="text-button" onClick={() => uploadController.current?.abort()}>
    Cancel sending
  </button>
)}
```

Change the review heading to `Sending photos` while `sending` is true.

- [ ] **Step 7: Run all upload state-machine tests**

Run:

```powershell
npx vitest run --config vitest.config.ts tests/unit/upload-queue.test.ts tests/ui/guest-upload-flow.test.tsx
```

Expected: PASS, including existing concurrency, finalize-only retry, and terminal receipt cases.

- [ ] **Step 8: Commit**

```powershell
git add src/features/uploads/upload-queue.ts src/features/uploads/GuestUploadFlow.tsx tests/unit/upload-queue.test.ts tests/ui/guest-upload-flow.test.tsx
git diff --cached --check
git commit -m "feat: add recoverable upload cancellation"
```

---

### Task 4: Guest first-fold, landscape, review identity, typography, and motion

**Findings:** P1-5, P1-6, P2-1, P2-13, P3-1, P3-5, P3-9, P3-10

**Files:**

- Modify: `src/features/uploads/GuestUploadFlow.tsx:274-365`
- Modify: `src/styles.css:106,111-116,151-161,195-217`
- Modify: `tests/ui/guest-upload-flow.test.tsx`
- Modify: `tests/e2e/guest-responsive.spec.ts`
- Modify: `tests/e2e/accessibility.spec.ts`

**Interfaces:**

- Long welcome text is visually clamped with an explicit `aria-expanded` disclosure; the complete text remains in the DOM.
- Review mode retains event name and formatted date.
- Reduced-motion mode removes spinner animation rather than making it nearly instantaneous.

- [ ] **Step 1: Write failing long-welcome and landscape tests**

At 320 by 568 with a 500-character welcome containing `UNBROKEN_TOKEN`, assert the bottom of both photo-source actions is within `window.innerHeight` and the document is contained. At 844 by 390, assert the camera action remains in view.

Run:

```powershell
npx playwright test tests/e2e/guest-responsive.spec.ts --project=mobile -g "500-character welcome|phone landscape"
```

Expected: FAIL because the welcome expands the hero and the width-only 700 px enhancement applies in landscape.

- [ ] **Step 2: Add the welcome disclosure and emergency wrapping**

```tsx
const [welcomeExpanded, setWelcomeExpanded] = useState(false);
const welcomeMessage = event.welcomeMessage || 'Help us remember tonight.';
const welcomeNeedsDisclosure = welcomeMessage.length > 180;

<h1 className={welcomeNeedsDisclosure && !welcomeExpanded ? 'photo-drop__welcome--clamped' : undefined}>
  {welcomeMessage}
</h1>
{welcomeNeedsDisclosure && (
  <button
    type="button"
    className="photo-drop__welcome-toggle"
    aria-expanded={welcomeExpanded}
    onClick={() => setWelcomeExpanded((current) => !current)}
  >
    {welcomeExpanded ? 'Show less' : 'Read full welcome'}
  </button>
)}
```

```css
.photo-drop__hero h1 {
  overflow-wrap: anywhere;
}

.photo-drop__welcome--clamped {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 4;
}
```

- [ ] **Step 3: Guard the tablet card by height**

Change the current `@media (min-width: 700px)` guest-card enhancement to:

```css
@media (min-width: 700px) and (min-height: 760px) {
  .photo-drop {
    min-height: 720px;
  }
}
```

Keep the narrow base rules active for 844 by 390.

- [ ] **Step 4: Write failing review identity and type-floor tests**

The component test adds one photo and expects `Alex & Jordan` and `Sep 14` in the review header.

The browser test adds a valid and invalid file at 320 px and asserts:

```ts
for (const locator of [
  page.locator('.selection-card__status strong'),
  page.locator('.selection-card__status span'),
  page.locator('.selection-card__status small'),
]) {
  const fontSize = await locator.first().evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  expect(fontSize).toBeGreaterThanOrEqual(12);
}
```

- [ ] **Step 5: Retain event identity and remove review dead space**

Render event/date in `.review-heading` and add:

```css
.photo-drop--review {
  min-height: auto;
}

.photo-drop--review .photo-drop__card {
  min-height: auto;
}

.selection-card__status strong,
.selection-card__status span,
.selection-card__status small {
  font-size: .75rem;
  line-height: 1.35;
}
```

Replace `.selection-summary span:last-child` with a dedicated `.selection-summary__attention` class so the neutral count never inherits danger color.

- [ ] **Step 6: Add and satisfy the reduced-motion test**

Use Playwright reduced-motion emulation and assert `.spin`, `.selection-card__spinner svg`, and `.send-button svg` compute `animationName === 'none'`.

Implement:

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    scroll-behavior: auto !important;
    animation: none !important;
    transition-duration: .01ms !important;
  }
}
```

- [ ] **Step 7: Run guest component and browser tests**

Run:

```powershell
npx vitest run --config vitest.config.ts tests/ui/guest-upload-flow.test.tsx
npx playwright test tests/e2e/guest-responsive.spec.ts tests/e2e/accessibility.spec.ts --project=mobile
```

Expected: PASS at portrait, landscape, long-message, invalid-file, review, and reduced-motion states.

- [ ] **Step 8: Commit**

```powershell
git add src/features/uploads/GuestUploadFlow.tsx src/styles.css tests/ui/guest-upload-flow.test.tsx tests/e2e/guest-responsive.spec.ts tests/e2e/accessibility.spec.ts
git diff --cached --check
git commit -m "fix: keep guest delivery mobile first under stress"
```

---

### Task 5: Mobile-first landing composition and workflow breakpoints

**Findings:** P2-4, P2-9, P3-6

**Files:**

- Create: `tests/e2e/public-responsive.spec.ts`
- Modify: `src/pages/LandingPage.tsx:10-28`
- Modify: `src/styles.css:52-66,89,100,105,194`
- Modify: `tests/e2e/guest-responsive.spec.ts`

**Interfaces:**

- The landing copy and primary action precede the decorative image at narrow widths.
- Workflow steps are one column by default, two columns when each text column can remain at least 160 px, and three columns at 900 px and above.

- [ ] **Step 1: Write failing first-fold, workflow-width, and footer-gap tests**

Test 320 by 568, 360 by 640, and 390 by 844 for the headline and primary CTA bottom within the viewport. Test 761, 780, and 860 px for every workflow paragraph width at least 160 px. Measure at least 12 px separation between footer brand and tagline.

Run:

```powershell
npx playwright test tests/e2e/public-responsive.spec.ts tests/e2e/guest-responsive.spec.ts --project=mobile
```

Expected: FAIL for image-first mobile ordering and the immediate three-column workflow.

- [ ] **Step 2: Make the narrow landing order the base composition**

```css
.hero {
  min-height: auto;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  padding: 32px 20px 40px;
}

.hero__copy {
  grid-row: 1;
}

.hero__image {
  height: clamp(280px, 82vw, 360px);
  grid-row: 2;
}

.workflow ol {
  grid-template-columns: minmax(0, 1fr);
}

@media (min-width: 700px) {
  .workflow ol {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (min-width: 900px) {
  .hero {
    min-height: 700px;
    grid-template-columns: 1.04fr .96fr;
  }

  .hero__copy,
  .hero__image {
    grid-row: auto;
  }

  .workflow ol {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
```

Remove the superseded `max-width: 760px` and `max-width: 430px` landing repairs.

- [ ] **Step 3: Give the guest footer explicit wrapping and gap**

```css
.guest-shell footer {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 12px 24px;
}
```

- [ ] **Step 4: Run landing tests at every audited boundary**

Run:

```powershell
npx playwright test tests/e2e/public-responsive.spec.ts tests/e2e/guest-responsive.spec.ts --project=mobile
```

Expected: PASS at 320, 360, 390, 430, 761, 780, and 860 px.

- [ ] **Step 5: Commit**

```powershell
git add tests/e2e/public-responsive.spec.ts tests/e2e/guest-responsive.spec.ts src/pages/LandingPage.tsx src/styles.css
git diff --cached --check
git commit -m "fix: make the public landing layout narrow first"
```

---

### Task 6: Accessible create validation, visible file focus, and readable private links

**Findings:** P2-10, P2-11, P2-12

**Files:**

- Modify: `src/pages/CreatePage.tsx:13-68`
- Modify: `src/components/CopyableLinkCard.tsx`
- Modify: `src/styles.css:71-78,260-276`
- Modify: `tests/ui/app.test.tsx`
- Modify: `tests/e2e/accessibility.spec.ts`
- Modify: `tests/e2e/public-responsive.spec.ts`

**Interfaces:**

- Create field errors use stable IDs `<field-name>-error`, `aria-invalid`, and `aria-describedby`; the first invalid field receives focus.
- `CopyableLinkCard` exposes a Show/Hide full-link control and automatically reveals the link when clipboard access fails.
- Preserve the existing dirty quota import and copy in `CreatePage.tsx`.

- [ ] **Step 1: Add failing field-association and focus tests**

Return a 422 response with:

```ts
{
  code: 'VALIDATION_FAILED',
  message: 'Check the event details.',
  fieldErrors: {
    name: 'Enter an event name.',
    eventDate: 'Choose an event date.',
    welcomeMessage: 'Write a welcome message.',
  },
  requestId: 'request-a',
}
```

Assert each field has `aria-invalid="true"`, each `aria-describedby` resolves to its visible error, the welcome textarea is included, and Event name is focused.

- [ ] **Step 2: Run the create validation test and verify RED**

Run:

```powershell
npx vitest run --config vitest.config.ts tests/ui/app.test.tsx -t "associates create errors"
```

Expected: FAIL for the textarea, missing descriptions, and missing focus.

- [ ] **Step 3: Implement stable error relations and first-error focus**

Add a form ref and fixed order:

```ts
const formRef = useRef<HTMLFormElement>(null);
const CREATE_FIELDS = ['name', 'eventDate', 'welcomeMessage'] as const;

function focusFirstInvalid(fieldErrors: Record<string, string>) {
  const firstName = CREATE_FIELDS.find((name) => fieldErrors[name]);
  if (!firstName) return;
  requestAnimationFrame(() => {
    const control = formRef.current?.elements.namedItem(firstName);
    if (control instanceof HTMLElement) control.focus();
  });
}
```

For every control, apply:

```tsx
aria-invalid={Boolean(fields.welcomeMessage)}
aria-describedby={fields.welcomeMessage ? 'welcomeMessage-error' : undefined}
```

Render `<small id="welcomeMessage-error">` and the equivalent IDs for name/date.

- [ ] **Step 4: Make cover-photo focus visible on the complete control**

Give the file input class `cover-field__input`, keep its accessible label from the wrapping `<label>`, and add:

```css
.cover-field {
  position: relative;
}

.cover-field:focus-within {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}

.cover-field__input:focus {
  outline: 0;
}
```

The browser test must confirm the visible `.cover-field` target is at least 44 px tall and has a 2 px focus outline when the file input receives keyboard focus.

- [ ] **Step 5: Add failing private-link reveal tests**

Extend the existing clipboard tests to assert:

```ts
await user.click(screen.getByRole('button', { name: 'Show full guest link' }));
expect(screen.getByRole('button', { name: 'Hide full guest link' })).toHaveAttribute('aria-expanded', 'true');

vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('Permission denied'));
await user.click(screen.getByRole('button', { name: 'Copy guest link' }));
expect(await screen.findByText('Copy unavailable. Select the link instead.')).toBeVisible();
expect(screen.getByRole('button', { name: 'Hide full guest link' })).toHaveAttribute('aria-expanded', 'true');
```

- [ ] **Step 6: Implement the reveal fallback**

Add `expanded` state and an ID from `useId()`. The `<code>` receives `tabIndex={0}` and the disclosure button receives `aria-expanded` and `aria-controls`.

Use:

```css
.link-card--expanded code {
  overflow: visible;
  white-space: normal;
  overflow-wrap: anywhere;
}
```

On clipboard failure, set `expanded` to true and use the exact fallback message from the test.

- [ ] **Step 7: Run create, link, and accessibility tests**

Run:

```powershell
npx vitest run --config vitest.config.ts tests/ui/app.test.tsx
npx playwright test tests/e2e/public-responsive.spec.ts tests/e2e/accessibility.spec.ts --project=mobile
```

Expected: PASS.

- [ ] **Step 8: Stage around the pre-existing CreatePage change and commit**

Use patch staging for `CreatePage.tsx`, preserving the existing `MAX_EVENT_MEDIA` change:

```powershell
git add src/components/CopyableLinkCard.tsx src/styles.css tests/ui/app.test.tsx tests/e2e/accessibility.spec.ts tests/e2e/public-responsive.spec.ts
git add -p src/pages/CreatePage.tsx
git diff --cached --check
git diff --cached
git commit -m "fix: make create errors and private links recoverable"
```

---

### Task 7: Stable keyset pagination for manager media

**Findings:** P1-4, server half

**Files:**

- Create: `migrations/0004_manager_media_pagination.sql`
- Create: `worker/http/media-cursor.ts`
- Modify: `shared/constants.ts`
- Modify: `worker/db/media.ts:81-98`
- Modify: `worker/routes/manage.ts:116-125`
- Modify: `vitest.worker.config.ts`
- Modify: `tests/worker/manage-api.test.ts`
- Modify: `tests/worker/repositories.test.ts`

**Interfaces:**

- Produces `MANAGER_MEDIA_PAGE_SIZE = 24` and `MANAGER_MEDIA_MAX_PAGE_SIZE = 50`.
- Produces `ManagerMediaCursor { createdAt: string; id: string }`.
- `MediaRepository.listForManager(eventId, options)` returns `{ media, nextCursor }`.
- `GET /api/manage/events/:eventId/media` returns `{ media, nextCursor }`; `cursor` is opaque to clients.

- [ ] **Step 1: Add failing route tests for stable pagination**

Seed 51 stored rows with deterministic `created_at` and IDs. Request `?limit=50`, follow `nextCursor`, and assert:

```ts
expect(firstBody.data.media).toHaveLength(50);
expect(firstBody.data.nextCursor).toEqual(expect.any(String));
expect(secondBody.data.media).toHaveLength(1);
expect(secondBody.data.nextCursor).toBeNull();
expect(new Set([...firstIds, ...secondIds]).size).toBe(51);
```

Insert a newer row between page requests and verify it does not duplicate or skip an older row. Add invalid-cursor and `limit=51` cases expecting 422.

- [ ] **Step 2: Run the worker test and verify RED**

Run:

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/manage-api.test.ts -t "cursor-paginates|rejects invalid media cursor"
```

Expected: FAIL because the endpoint returns the complete list and no cursor.

- [ ] **Step 3: Add the opaque cursor codec**

```ts
// worker/http/media-cursor.ts
import { z } from 'zod';

import { ApiError } from '../../shared/errors';

const cursorSchema = z.object({
  createdAt: z.string().datetime({ offset: true }),
  id: z.string().uuid(),
});

export type ManagerMediaCursor = z.infer<typeof cursorSchema>;

export function encodeMediaCursor(cursor: ManagerMediaCursor): string {
  return btoa(JSON.stringify(cursor))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

export function decodeMediaCursor(value: string): ManagerMediaCursor {
  try {
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
    const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), '=');
    return cursorSchema.parse(JSON.parse(atob(padded)));
  } catch {
    throw new ApiError('VALIDATION_FAILED', 'The media page cursor is invalid.', 422);
  }
}
```

- [ ] **Step 4: Add indexes for both all-status and status-filtered pages**

```sql
-- migrations/0004_manager_media_pagination.sql
CREATE INDEX media_manager_page_all
ON media(event_id, upload_state, created_at DESC, id DESC)
WHERE deleted_at IS NULL;

CREATE INDEX media_manager_page_status
ON media(event_id, upload_state, publication_status, created_at DESC, id DESC)
WHERE deleted_at IS NULL;
```

Append the migration filename to `migrationSql` in `vitest.worker.config.ts`. Add a repository test using `EXPLAIN QUERY PLAN` to confirm the unfiltered page uses `media_manager_page_all` and the status-filtered page uses `media_manager_page_status`.

- [ ] **Step 5: Implement keyset pagination in the repository**

Use this options shape:

```ts
interface ManagerMediaOptions {
  status?: PublicationStatus;
  guestName?: string;
  cursor?: ManagerMediaCursor;
  limit?: number;
}
```

Build the SQL predicates from the provided filters. Only when a cursor is present, append:

```sql
AND (created_at < ? OR (created_at = ? AND id < ?))
ORDER BY created_at DESC, id DESC
LIMIT ?
```

Bind `cursor.createdAt`, `cursor.createdAt`, and `cursor.id` for that predicate. Fetch `limit + 1`, return the first `limit`, and derive `nextCursor` from the last returned row only when the extra row exists.

- [ ] **Step 6: Parse and serialize pagination in the route**

Parse `limit` with `z.coerce.number().int().min(1).max(MANAGER_MEDIA_MAX_PAGE_SIZE)` and default it to `MANAGER_MEDIA_PAGE_SIZE`. Decode `cursor` only when present. Return:

```ts
return context.json({
  data: {
    media: page.media,
    nextCursor: page.nextCursor ? encodeMediaCursor(page.nextCursor) : null,
  },
  requestId: context.get('requestId'),
});
```

- [ ] **Step 7: Run worker tests**

Run:

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/manage-api.test.ts tests/worker/repositories.test.ts
```

Expected: PASS for pagination, filtering, publication, and existing repository behavior.

- [ ] **Step 8: Commit**

```powershell
git add migrations/0004_manager_media_pagination.sql worker/http/media-cursor.ts shared/constants.ts worker/db/media.ts worker/routes/manage.ts vitest.worker.config.ts tests/worker/manage-api.test.ts tests/worker/repositories.test.ts
git diff --cached --check
git commit -m "feat: paginate manager media with stable cursors"
```

---

### Task 8: Incremental manager intake, first-page polling, lazy previews, and mobile export access

**Findings:** P1-4, client half

**Files:**

- Create: `src/components/ManagerExportPanel.tsx`
- Create: `tests/e2e/manager-scale.spec.ts`
- Modify: `src/app/types.ts`
- Modify: `src/pages/ManagerPage.tsx:28-89,135-186,230-233`
- Modify: `src/styles.css:91-94,223-245,290-304`
- Modify: `tests/ui/app.test.tsx`

**Interfaces:**

- Produces `ManagerMediaPage { media: MediaView[]; nextCursor: string | null }`.
- `loadMoreMedia()` appends unique rows.
- Intake polling fetches only the first page and merges it ahead of retained pages.
- `ManagerExportPanel` receives the current job/download state and exact prepare/download/retry callbacks.
- Manager mutations report an inline recoverable action error without replacing the last usable manager view.

- [ ] **Step 1: Write failing manager paging and image-loading UI tests**

Extend `tests/e2e/fixtures/routes.ts` with a paged manager stub:

```ts
interface ManagerRouteOptions {
  mediaPages: Record<string, { media: ReturnType<typeof makeMedia>; nextCursor: string | null }>;
  messages?: Array<{
    id: string;
    guestName: string;
    body: string;
    moderationStatus: 'approved';
    createdAt: string;
  }>;
  exports?: unknown[];
}

export async function stubManagerRoutes(page: Page, options: ManagerRouteOptions) {
  await page.route('**/api/manage/events/event-a/media*', (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor') ?? 'first';
    const mediaPage = options.mediaPages[cursor] ?? { media: [], nextCursor: null };
    return route.fulfill({ json: { data: mediaPage, requestId: 'request-a' } });
  });
  await page.route(/\/api\/manage\/events\/event-a$/, (route) => route.fulfill({
    json: { data: { event: EVENT_FIXTURE }, requestId: 'request-a' },
  }));
  await page.route('**/api/manage/events/event-a/messages', (route) => route.fulfill({
    json: { data: { messages: options.messages ?? [] }, requestId: 'request-a' },
  }));
  await page.route('**/api/manage/events/event-a/exports', (route) => route.fulfill({
    json: { data: { exports: options.exports ?? [] }, requestId: 'request-a' },
  }));
  await page.route('**/api/manage/events/event-a/links', (route) => route.fulfill({
    json: {
      data: { guestLink: `https://candidary.test/join/${'guest-secret-'.repeat(8)}` },
      requestId: 'request-a',
    },
  }));
  await page.route('**/api/media/*/preview', (route) => route.fulfill({
    status: 200,
    contentType: 'image/png',
    body: preview,
  }));
}
```

Mock page one with 24 rows and `nextCursor: 'page-two'`, then page two with one row and `nextCursor: null`. Assert:

```ts
expect(document.querySelectorAll('.moderation-grid img')).toHaveLength(24);
await user.click(screen.getByRole('button', { name: 'Load more photos' }));
expect(document.querySelectorAll('.moderation-grid img')).toHaveLength(25);
expect(new Set(
  Array.from(document.querySelectorAll('.moderation-grid img'), (image) => image.getAttribute('src')),
).size).toBe(25);
```

For every manager preview:

```ts
expect(image).toHaveAttribute('loading', 'lazy');
expect(image).toHaveAttribute('decoding', 'async');
```

- [ ] **Step 2: Run the UI tests and verify RED**

Run:

```powershell
npx vitest run --config vitest.config.ts tests/ui/app.test.tsx -t "appends the next media page|previews use lazy"
```

Expected: FAIL because the client assumes an unpaged array and images are eager.

- [ ] **Step 3: Add typed page state and load-more behavior**

```ts
export interface ManagerMediaPage {
  media: MediaView[];
  nextCursor: string | null;
}
```

In `ManagerPage`, add `nextMediaCursor` and `loadingMore`. Build the path from status, guest name, and an optional cursor. Initial refresh replaces the current list. `loadMoreMedia` appends only IDs not already present:

```ts
setMedia((current) => {
  const known = new Set(current.map(({ id }) => id));
  return [...current, ...page.media.filter(({ id }) => !known.has(id))];
});
setNextMediaCursor(page.nextCursor);
```

Render `Load more photos` only when `nextMediaCursor` is non-null.

- [ ] **Step 4: Make polling merge only the first page**

The five-second poll requests no cursor. Merge its rows before retained rows:

```ts
setMedia((current) => {
  const refreshedIds = new Set(firstPage.media.map(({ id }) => id));
  return [...firstPage.media, ...current.filter(({ id }) => !refreshedIds.has(id))];
});
```

Do not reset a non-null continuation cursor during polling. Reset media and cursor when status or guest filter changes.

- [ ] **Step 5: Add lazy preview attributes**

```tsx
<img
  src={mediaPreview(item.id)}
  alt={item.caption || item.originalFilename}
  loading="lazy"
  decoding="async"
/>
```

- [ ] **Step 6: Extract and reuse the export panel**

Define:

```ts
interface ManagerExportPanelProps {
  className?: string;
  job?: ExportView;
  download?: ExportDownloadView;
  onPrepare(): Promise<void>;
  onDownload(job: ExportView): Promise<void>;
  onRetry(job: ExportView): Promise<void>;
}
```

Render it once in the desktop utility rail and once in the Share section with complementary responsive classes:

```css
.manager-export-panel--share {
  display: block;
}

.manager-export-panel--utility {
  display: none;
}

@media (min-width: 761px) {
  .manager-export-panel--share {
    display: none;
  }

  .manager-export-panel--utility {
    display: block;
  }
}
```

This keeps complete export reachable near the top of mobile Share without duplicating visible controls.

- [ ] **Step 7: Keep mutation failures recoverable in place**

Add `actionError` state and one wrapper for bulk, publication, message, export, settings, and rotation actions:

```ts
async function runManagerAction(action: () => Promise<void>) {
  setActionError('');
  try {
    await action();
  } catch (caught) {
    setActionError(caught instanceof Error ? caught.message : 'The manager action could not be completed.');
  }
}
```

Render a dismissible `<p className="manager-action-error" role="alert">` above the active section. Add UI tests proving a failed bulk publish, delete, and export request leaves the current cards and selected section visible.

- [ ] **Step 8: Add and satisfy the 120-item scale test**

The route returns only the first 24 of a 120-item fixture plus a cursor. Assert 24 manager preview elements, 24 preview requests before Load more, a visible export action in Share, and the export panel above the media grid in the mobile reading path.

Run:

```powershell
npx playwright test tests/e2e/manager-scale.spec.ts --project=mobile -g "paginates intake|exposes export"
```

Expected: PASS.

- [ ] **Step 9: Run manager UI tests**

Run:

```powershell
npx vitest run --config vitest.config.ts tests/ui/app.test.tsx
npx playwright test tests/e2e/manager-scale.spec.ts --project=mobile
```

Expected: PASS, including first-page polling without duplicate rows.

- [ ] **Step 10: Stage around the pre-existing ManagerPage capacity changes and commit**

```powershell
git add src/components/ManagerExportPanel.tsx src/app/types.ts src/styles.css tests/ui/app.test.tsx tests/e2e/manager-scale.spec.ts
git add -p src/pages/ManagerPage.tsx
git diff --cached --check
git diff --cached
git commit -m "feat: page manager intake and surface mobile export"
```

---

### Task 9: Manager breakpoint model, visible navigation, readable content, and touch targets

**Findings:** P1-3, P2-5, P2-6, P2-7, P2-8, P2-14, P3-3, P3-4

**Files:**

- Create: `tests/e2e/manager-responsive.spec.ts`
- Modify: `src/pages/ManagerPage.tsx:94-99,168-186,194-225`
- Modify: `src/styles.css:91-105,223-304`
- Modify: `tests/e2e/accessibility.spec.ts`

**Interfaces:**

- Base manager layout is the labeled two-tier mobile header.
- At 761 px the manager becomes a labeled compact rail plus main content.
- At 1101 px the 184 px rail and 330 px utility rail return, with the center track allowed to shrink to zero intrinsic minimum.
- Section changes restore the new heading below the active navigation.

- [ ] **Step 1: Write failing navigation and breakpoint tests**

At 761, 768, 900, 1024, and 1100 px, assert every `.manager-nav__label` has a nonzero box and computed font size at least 10 px. At 1101, 1120, 1133, and 1134 px, assert document containment. At 390 and 1024, assert the inactive Notes count remains visible and has nonzero font size.

Run:

```powershell
npx playwright test tests/e2e/manager-responsive.spec.ts --project=desktop -g "navigation|manager shell"
```

Expected: FAIL in the audited breakpoint gaps.

- [ ] **Step 2: Replace manager max-width repairs with three narrow-first modes**

Use a mobile base, then:

```css
@media (min-width: 761px) {
  .manager-shell--intake {
    display: grid;
    grid-template-columns: 104px minmax(0, 1fr);
  }

  .manager-nav button {
    min-width: 0;
    min-height: 52px;
    flex-direction: column;
  }

  .manager-nav__label {
    display: block;
    color: var(--ink);
    font-size: .75rem;
  }

  .manager-utility {
    grid-column: 2;
  }
}

@media (min-width: 1101px) {
  .manager-shell--intake {
    grid-template-columns: 184px minmax(0, 1fr) 330px;
  }

  .manager-nav button {
    flex-direction: row;
  }

  .manager-utility {
    grid-column: 3;
  }
}
```

Remove the broad `.manager-nav button:not(.active) span` font-size rule. Style `.manager-nav__label` and `.manager-nav__count` directly so label and count specificity cannot conflict. Remove the center track’s 620 px minimum.

- [ ] **Step 3: Add and satisfy contrast and count assertions**

Use the geometry helper to calculate WCAG relative luminance from computed label foreground and nav background. Assert at least 4.5:1. Keep the nav-local label color at `var(--ink)` or another measured passing token; do not darken `--muted` globally.

- [ ] **Step 4: Add failing scroll-reset and long-note tests**

With 120 media items, scroll deep into Intake, click Share, and assert `scrollY <= 1` and the Share heading begins below the sticky nav. With an 80-character unbroken note at 320 and 900 px, assert the note and document remain contained.

- [ ] **Step 5: Restore section position and wrap untrusted content**

After changing the section, restore the viewport in the next frame:

```ts
function openSection(next: Section) {
  setSection(next);
  setSelected([]);
  if (next === 'intake') setStatus('all');
  if (next === 'gallery' && status === 'all') setStatus('unpublished');
  requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: 'auto' }));
}
```

Add:

```css
.manager-main {
  min-width: 0;
  overflow: visible;
}

.manager-messages p {
  min-width: 0;
  overflow-wrap: anywhere;
}
```

- [ ] **Step 6: Preserve full manager card names**

Add `title={item.caption || item.originalFilename}` to the card `<strong>` and allow a two-line compact label:

```css
.moderation-grid strong {
  display: -webkit-box;
  overflow: hidden;
  white-space: normal;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
```

- [ ] **Step 7: Normalize every audited manager target to 44 px**

Apply `min-width: 44px; min-height: 44px` to:

- `.intake-card-actions a`
- `.intake-card-actions button`
- `.moderation-grid article button`
- `.filter-tabs button`
- `.bulk-bar .button`
- `.manager-messages .button`
- `.export-links a`

The browser test must measure the visible controls in Intake, Gallery, Notes, and a ready export rather than asserting CSS text.

- [ ] **Step 8: Run manager responsive and accessibility tests**

Run:

```powershell
npx playwright test tests/e2e/manager-responsive.spec.ts tests/e2e/manager-scale.spec.ts tests/e2e/accessibility.spec.ts --project=desktop
npx playwright test tests/e2e/manager-responsive.spec.ts tests/e2e/manager-scale.spec.ts tests/e2e/accessibility.spec.ts --project=mobile
```

Expected: PASS across the breakpoint band, long note, section switch, contrast, count, and target measurements.

- [ ] **Step 9: Stage around the pre-existing ManagerPage changes and commit**

```powershell
git add tests/e2e/manager-responsive.spec.ts tests/e2e/accessibility.spec.ts src/styles.css
git add -p src/pages/ManagerPage.tsx
git diff --cached --check
git diff --cached
git commit -m "fix: make manager navigation readable at every width"
```

---

### Task 10: Named note input, recoverable error states, and public header targets

**Findings:** P1-7, P3-7, P3-8

**Files:**

- Create: `tests/e2e/error-recovery.spec.ts`
- Modify: `src/components/States.tsx`
- Modify: `src/components/Brand.tsx`
- Modify: `src/pages/EventPage.tsx:22-78,117-126`
- Modify: `src/pages/ManagerPage.tsx:49-67,189`
- Modify: `src/styles.css:30-38,80,99,192-194`
- Modify: `tests/ui/app.test.tsx`
- Modify: `tests/e2e/accessibility.spec.ts`

**Interfaces:**

- `ErrorState` accepts `message`, `recoveryHint`, and optional `onRetry`.
- Event and manager load functions are callable both on mount and from Try again.
- `SESSION_REQUIRED`, `SESSION_EXPIRED`, `TOKEN_REVOKED`, and `ROLE_FORBIDDEN` show link-specific guidance without an ineffective retry loop.
- The guest note textarea is named `Note for <event name>`.

- [ ] **Step 1: Add the failing note-name test**

Open Leave a note and assert:

```ts
expect(screen.getByRole('textbox', { name: 'Note for Maya & Theo' })).toBeVisible();
```

Replace the placeholder-only control with:

```tsx
<label>
  <span className="sr-only">Note for {event.name}</span>
  <textarea name="body" rows={3} maxLength={500} required placeholder="Write a note…" />
</label>
```

- [ ] **Step 2: Add failing guest and manager retry tests**

In `tests/e2e/error-recovery.spec.ts`, make the first event request return 500 and the second return the normal fixture. Assert the alert, recovery hint, and Try again button; click Try again and assert the normal screen. Mirror the same behavior for Manager. Add revoked/session-expired cases that show “Open the latest guest link” or “Open the latest management link” and no Try again button.

Run:

```powershell
npx playwright test tests/e2e/error-recovery.spec.ts --project=mobile
```

Expected: FAIL because `ErrorState` has no retry action and EventPage’s load is not reusable.

- [ ] **Step 3: Add a recoverable ErrorState interface**

```tsx
interface ErrorStateProps {
  message: string;
  recoveryHint: string;
  onRetry?: () => void;
}

export function ErrorState({ message, recoveryHint, onRetry }: ErrorStateProps) {
  return <div className="state-card state-card--error">
    <TriangleAlert aria-hidden="true" />
    <p role="alert">{message}</p>
    <p>{recoveryHint}</p>
    {onRetry && (
      <button type="button" className="button button--secondary" onClick={onRetry}>Try again</button>
    )}
  </div>;
}
```

Extract EventPage’s initial API request into `loadEvent` with `useCallback`; ManagerPage reuses `refresh`. Preserve the `ClientApiError.code` alongside its message. Clear the prior error before retry and preserve the last usable manager intake during poll failures. Omit `onRetry` for access/session codes and pass the role-appropriate latest-link guidance instead.

- [ ] **Step 4: Add failing public-header target tests**

At `/` and `/create`, at 320 and 768 px, assert every visible header link is at least 44 by 44 and that both `Candidary home` and `Back home` remain reachable on Create.

- [ ] **Step 5: Keep header exits visible and large enough**

```css
.brand,
.page-header .text-link {
  min-height: 44px;
  display: inline-flex;
  align-items: center;
}

.page-header .text-link {
  min-width: 44px;
  justify-content: center;
}
```

Remove the mobile rule that hides `.page-header .text-link`. Keep the existing navigation copy; do not add a new destination.

- [ ] **Step 6: Run UI, recovery, and accessibility tests**

Run:

```powershell
npx vitest run --config vitest.config.ts tests/ui/app.test.tsx
npx playwright test tests/e2e/error-recovery.spec.ts tests/e2e/accessibility.spec.ts --project=mobile
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add tests/e2e/error-recovery.spec.ts src/components/States.tsx src/components/Brand.tsx src/pages/EventPage.tsx src/styles.css tests/ui/app.test.tsx tests/e2e/accessibility.spec.ts
git add -p src/pages/ManagerPage.tsx
git diff --cached --check
git diff --cached
git commit -m "fix: add accessible recovery paths"
```

---

### Task 11: Accessibility engine, boundary matrix, tracked visual baselines, and final QA

**Findings:** Test-coverage gaps and all residual regression risk

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `playwright.config.ts`
- Modify: `tests/e2e/accessibility.spec.ts`
- Modify: `tests/e2e/visual-qa.spec.ts`
- Create: Playwright snapshots under `tests/e2e/visual-qa.spec.ts-snapshots/`
- Modify: `design-qa.md`
- Modify: `design/fidelity-ledger.md`
- Modify: `docs/deployment.md`

**Interfaces:**

- Playwright keeps the existing `mobile` and `desktop` projects; boundary tests use explicit `page.setViewportSize()` tables instead of multiplying every suite across projects.
- `@axe-core/playwright` runs on landing, create, guest, fullscreen, and all five manager sections.
- `toHaveScreenshot()` baselines become the tracked visual evidence; `output/` remains disposable.

- [ ] **Step 1: Install the pinned accessibility test dependency**

Run:

```powershell
npm install --save-dev @axe-core/playwright@4.12.1
```

Expected: only `package.json` and `package-lock.json` change.

- [ ] **Step 2: Add automated axe checks**

Use:

```ts
import AxeBuilder from '@axe-core/playwright';

const results = await new AxeBuilder({ page }).analyze();
expect(results.violations).toEqual([]);
```

Run it after route-specific content is visible on `/`, `/create`, guest hero, guest secondary content, fullscreen, and each manager section. Keep the manual accessible-name, target-size, focus, contrast, reduced-motion, and scroll assertions; axe does not replace them.

- [ ] **Step 3: Add exact breakpoint tables without adding global projects**

In the responsive specs, use:

```ts
const PHONE_WIDTHS = [320, 360, 390, 430] as const;
const MANAGER_BOUNDARIES = [760, 761, 768, 860, 1024, 1100, 1101, 1120, 1133, 1134] as const;
```

Loop with `page.setViewportSize()` inside the focused test files. Retain the existing mobile-emulated context for phone/landscape cases and desktop context for medium/wide breakpoint cases.

- [ ] **Step 4: Add zoom, landscape, large-set, and mutation-error coverage**

Add explicit cases for:

- 844 by 390 phone landscape.
- 640 by 450 as the 1280-at-200%-zoom-equivalent layout.
- A 120-item response where only 24 items render per page.
- Bulk publish, individual delete, and export request failures that display recoverable error feedback without clearing the current manager view.
- Reduced-motion loading and upload spinners.

- [ ] **Step 5: Replace ignored screenshots with tracked baselines**

Convert the current `page.screenshot()` calls to deterministic `toHaveScreenshot()` assertions for:

- `guest-secondary-long-content-320.png`
- `fullscreen-long-caption-320.png`
- `manager-nav-768.png`
- `manager-nav-count-390.png`
- `guest-long-welcome-320.png`
- `guest-landscape-844x390.png`
- `manager-export-first-390.png`
- `landing-first-fold-320.png`
- `landing-workflow-780.png`
- `create-validation-focus-390.png`
- `manager-actions-320.png`
- `guest-review-320.png`

Generate candidates:

```powershell
npx playwright test tests/e2e/visual-qa.spec.ts --update-snapshots
```

Review every image before accepting it, then prove reproducibility:

```powershell
npx playwright test tests/e2e/visual-qa.spec.ts
```

- [ ] **Step 6: Run the complete automated verification**

Preflight port 4173 without killing an unknown process:

```powershell
Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue
```

If occupied, identify the owning process and coordinate before stopping it. Then run:

```powershell
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
git diff --check
```

Expected: every command exits 0 with no unexplained warning, test failure, visual diff, console error, document overflow, or accessibility violation.

- [ ] **Step 7: Update tracked QA and release documentation**

Update `design-qa.md` with the exact routes, states, widths, test commands, baseline filenames, and zero open P0/P1/P2 result. Update `design/fidelity-ledger.md` so it no longer cites only gitignored `output/` evidence. Add physical iPhone Safari, Android Chrome, VoiceOver/TalkBack, real HEIC selection, dynamic toolbar, and 10,000-photo disposable-event checks to `docs/deployment.md`; keep them as production rehearsal gates rather than automated-conformance claims.

- [ ] **Step 8: Verify finding coverage and dirty-worktree preservation**

Run:

```powershell
git status --short
git diff -- docs/security.md src/pages/CreatePage.tsx src/pages/ManagerPage.tsx
git diff --cached
```

Confirm the original `docs/security.md` change and `CLAUDE.md` remain untouched. Confirm any original CreatePage/ManagerPage hunks not intentionally adopted are still unstaged.

- [ ] **Step 9: Commit the test evidence and documentation**

```powershell
git add package.json package-lock.json playwright.config.ts tests/e2e design-qa.md design/fidelity-ledger.md docs/deployment.md
git diff --cached --check
git commit -m "test: lock mobile-first UI regressions"
```

## Finding Coverage Matrix

| Task | Covered audit findings |
| --- | --- |
| 1 | P1-1, P1-2, P2-3 |
| 2 | P2-2 |
| 3 | P3-2 |
| 4 | P1-5, P1-6, P2-1, P2-13, P3-1, P3-5, P3-9, P3-10 |
| 5 | P2-4, P2-9, P3-6 |
| 6 | P2-10, P2-11, P2-12 |
| 7 | P1-4 server-side pagination |
| 8 | P1-4 client paging, lazy loading, polling, and export reachability |
| 9 | P1-3, P2-5, P2-6, P2-7, P2-8, P2-14, P3-3, P3-4 |
| 10 | P1-7, P3-7, P3-8 |
| 11 | Missing viewport, long-content, zoom, motion, a11y-engine, visual-baseline, mutation-error, and tracked-evidence coverage |

## Completion Gate

The plan is complete only when:

1. Every row in the coverage matrix has a failing test captured before its implementation and a passing targeted test after it.
2. Typecheck, lint, unit/UI tests, Worker tests, build, full Playwright, axe, and tracked screenshot comparisons pass.
3. Browser evidence covers every listed viewport and all five manager sections with long and scale fixtures.
4. No P0, P1, or P2 finding remains open; any deferred P3 has an explicit owner and release decision.
5. The pre-existing dirty-worktree content is preserved and excluded from commits unless the user explicitly adopts it.
6. Physical iPhone, Android, and screen-reader checks remain clearly labeled production rehearsal gates rather than automated proof.

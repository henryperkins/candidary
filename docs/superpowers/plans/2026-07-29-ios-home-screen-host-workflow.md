# iOS Home Screen Host Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship route-preserving iOS Home Screen metadata and artwork, plus account-or-management-link recovery that keeps an installed host manager usable after either credential lapses.

**Architecture:** A static root-scoped manifest deliberately omits `start_url` and `id`, so installation inherits the current manager document. A dependency-free shared failure-decision module drives both React recovery surfaces and the existing management-link exchange route; failed document navigations redirect to a token-free React recovery route while API-style requests keep their JSON contract.

**Tech Stack:** React 19, React Router 7, TypeScript 6, Hono, Cloudflare Workers static assets, Vitest, Playwright, Vite 8.

## Global Constraints

- Do not add an Add to Home Screen prompt, install banner, modal, tooltip, `beforeinstallprompt` listener, service worker, or offline behavior.
- `public/manifest.webmanifest` must use `scope: "/"`, `display: "standalone"`, Aubergine `#42103b`, and Parchment `#f7f1e7`; it must omit both `start_url` and `id`.
- The manifest remains a static asset and must not be added to `assets.run_worker_first`.
- Link-derived manager sessions remain 12 hours, host-account sessions remain 30 days, and both remain bounded by the existing management deadline.
- Recovery must not add an endpoint, change token shape or lifetime, persist/log the bearer token, create ownership, or present account creation as guaranteed event recovery.
- A successful management-link exchange changes only the event-cookie pair and must not clear or replace `candidary_host` or `candidary_host_csrf`.
- Failed manager document navigation must end at token-free `/recover/manage`; JSON-oriented clients retain the existing status and body.
- `Referrer-Policy: no-referrer` remains on Worker and static responses.
- Management-link recovery appears only on manager and `/recover/manage` surfaces, never guest, landing, or account-registration surfaces.
- Physical-iPhone installation, cookie isolation, export handoff, and expired-session re-entry remain unverified until the design document's device checklist is run.
- Every behavioral change follows RED-GREEN TDD: add the focused test, run it and capture the expected failure, implement the minimum behavior, then rerun it green.

---

### Task 1: Shared load-failure decision contract

**Files:**
- Create: `shared/load-failure.ts`
- Modify: `src/components/States.tsx`
- Modify: `tests/unit/states.test.ts`

**Interfaces:**
- Produces: `LoadFailureKind`, `LoadFailureDecision`, `failureDecisionForCode(code)`, and `classifyApiErrorCode(code)` from `shared/load-failure.ts`.
- Produces: `LoadFailure.kind` alongside the existing message, hint, retry, and sign-in fields.
- Consumes: `ApiErrorCode` from `shared/errors.ts`.

- [ ] **Step 1: Write the failing shared-decision tests**

Replace the component import in `tests/unit/states.test.ts` with the shared module and add decision assertions that catch the behavior changes:

```ts
import {
  classifyApiErrorCode,
  failureDecisionForCode,
} from '../../shared/load-failure';
import { ClientApiError } from '../../src/app/api';
import { describeLoadFailure } from '../../src/components/States';

expect(failureDecisionForCode('SESSION_EXPIRED'))
  .toEqual({ kind: 'latest-link', offerSignIn: true });
expect(failureDecisionForCode('HOST_SESSION_REQUIRED'))
  .toEqual({ kind: 'sign-in', offerSignIn: true });
expect(failureDecisionForCode('ACCOUNT_DISABLED'))
  .toEqual({ kind: 'latest-link', offerSignIn: false });

const disabled = describeLoadFailure(
  new ClientApiError('ACCOUNT_DISABLED', 'This account is no longer active.'),
  'manager',
  'fallback',
);
expect(disabled.kind).toBe('latest-link');
expect(disabled.offerSignIn).toBe(false);

const guest = describeLoadFailure(
  new ClientApiError('SESSION_REQUIRED', 'Open a link.'),
  'guest',
  'fallback',
);
expect(guest.kind).toBe('latest-link');
expect(guest.offerSignIn).toBe(false);
```

Keep the existing representative classification table and add `SESSION_EXPIRED`, `TOKEN_REVOKED`, `HOST_SESSION_REQUIRED`, and `ACCOUNT_DISABLED`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npx vitest run --config vitest.config.ts tests/unit/states.test.ts
```

Expected: failure because `shared/load-failure.ts` does not exist and `LoadFailure` does not expose `kind`.

- [ ] **Step 3: Add the dependency-free exhaustive decision table**

Create `shared/load-failure.ts` with this public shape:

```ts
import type { ApiErrorCode } from './errors';

export type LoadFailureKind = 'latest-link' | 'ended-event' | 'sign-in' | 'retry';

export interface LoadFailureDecision {
  readonly kind: LoadFailureKind;
  readonly offerSignIn: boolean;
}

const decision = (
  kind: LoadFailureKind,
  offerSignIn = false,
): LoadFailureDecision => ({ kind, offerSignIn });

const LOAD_FAILURE_DECISION = {
  EVENT_NOT_FOUND: decision('ended-event'),
  EVENT_DELETED: decision('ended-event'),
  EVENT_EXPIRED: decision('ended-event'),
  SESSION_REQUIRED: decision('latest-link', true),
  SESSION_EXPIRED: decision('latest-link', true),
  ROLE_FORBIDDEN: decision('latest-link', true),
  RESOURCE_FORBIDDEN: decision('retry'),
  OWNER_CLAIM_REQUIRED: decision('retry'),
  UPLOADS_DISABLED: decision('retry'),
  GALLERY_HIDDEN: decision('retry'),
  TOKEN_REVOKED: decision('latest-link', true),
  GUEST_LINK_UNAVAILABLE: decision('retry'),
  FILE_TYPE_UNSUPPORTED: decision('retry'),
  FILE_TOO_LARGE: decision('retry'),
  EVENT_MEDIA_LIMIT: decision('retry'),
  EVENT_STORAGE_LIMIT: decision('retry'),
  UPLOAD_RESERVATION_EXPIRED: decision('retry'),
  UPLOAD_OBJECT_MISSING: decision('retry'),
  UPLOAD_FINALIZE_CONFLICT: decision('retry'),
  MEDIA_STATE_CONFLICT: decision('retry'),
  EXPORT_ALREADY_ACTIVE: decision('retry'),
  EXPORT_EMPTY: decision('retry'),
  EXPORT_LIMIT_EXCEEDED: decision('retry'),
  EXPORT_FAILED: decision('retry'),
  VALIDATION_FAILED: decision('retry'),
  CSRF_INVALID: decision('retry'),
  ORIGIN_FORBIDDEN: decision('retry'),
  HOST_SESSION_REQUIRED: decision('sign-in', true),
  LOGIN_CREDENTIALS_INVALID: decision('retry'),
  LOGIN_CODE_INVALID: decision('retry'),
  LOGIN_CODE_EXPIRED: decision('retry'),
  LOGIN_RATE_LIMITED: decision('retry'),
  RATE_LIMITED: decision('retry'),
  LOGIN_EMAIL_UNDELIVERABLE: decision('retry'),
  ACCOUNT_DISABLED: decision('latest-link'),
  INTERNAL_ERROR: decision('retry'),
} as const satisfies Record<ApiErrorCode, LoadFailureDecision>;

export function failureDecisionForCode(code: ApiErrorCode): LoadFailureDecision {
  return LOAD_FAILURE_DECISION[code];
}

export function classifyApiErrorCode(code: ApiErrorCode): LoadFailureKind {
  return failureDecisionForCode(code).kind;
}
```

In `States.tsx`, remove the local type/table/classifier, import the shared decision, add `kind` to `LoadFailure`, and derive sign-in as:

```ts
const decision = caught instanceof ClientApiError
  ? failureDecisionForCode(caught.code)
  : { kind: 'retry' as const, offerSignIn: false };
const offerSignIn = role === 'manager' && decision.offerSignIn;
```

Every return from `describeLoadFailure` must include `kind: decision.kind`.

- [ ] **Step 4: Run focused tests and typecheck GREEN**

Run:

```powershell
npx vitest run --config vitest.config.ts tests/unit/states.test.ts
npm run typecheck
```

Expected: all state tests pass and TypeScript accepts both browser and Worker consumers.

- [ ] **Step 5: Commit**

```powershell
git add shared/load-failure.ts src/components/States.tsx tests/unit/states.test.ts
git commit -m "refactor: share host recovery decisions"
```

---

### Task 2: Pure management-link parser and reusable form

**Files:**
- Create: `src/app/management-link.ts`
- Create: `src/components/ManagementLinkRecovery.tsx`
- Modify: `src/styles.css`
- Modify: `tests/unit/recovery.test.ts`
- Modify: `tests/ui/app.test.tsx`

**Interfaces:**
- Produces: `parseManagementLink(value: string, currentOrigin: string): string | null`.
- Produces: `ManagementLinkRecovery`, which validates and calls `window.location.replace()` only with the returned pathname.
- Consumes: no API endpoint and no storage.

- [ ] **Step 1: Write the parser RED matrix**

Add literal cases to `tests/unit/recovery.test.ts`:

```ts
const ORIGIN = 'https://candidary.test';
const TOKEN = 'Abc_123.Xyz-789';

expect(parseManagementLink(`${ORIGIN}/manage/${TOKEN}`, ORIGIN))
  .toBe(`/manage/${TOKEN}`);
expect(parseManagementLink(`/manage/${TOKEN}?from=mail#saved`, ORIGIN))
  .toBe(`/manage/${TOKEN}`);

it.each([
  ['foreign origin', `https://evil.example/manage/${TOKEN}`],
  ['credentials', `https://user:pass@candidary.test/manage/${TOKEN}`],
  ['manager client route', '/manage/event'],
  ['extra segment', `/manage/${TOKEN}/more`],
  ['trailing slash', `/manage/${TOKEN}/`],
  ['missing dot', '/manage/Abc_123'],
  ['duplicate dot', '/manage/Abc_123.Xyz-789.extra'],
  ['empty id', '/manage/.Xyz-789'],
  ['empty secret', '/manage/Abc_123.'],
  ['invalid id alphabet', '/manage/Abc%2F123.Xyz-789'],
  ['invalid secret alphabet', '/manage/Abc_123.Xyz%2F789'],
  ['non-management path', `/join/${TOKEN}`],
])('rejects %s', (_label, value) => {
  expect(parseManagementLink(value, ORIGIN)).toBeNull();
});
```

- [ ] **Step 2: Run parser tests and verify RED**

Run:

```powershell
npx vitest run --config vitest.config.ts tests/unit/recovery.test.ts
```

Expected: failure because `parseManagementLink` is missing.

- [ ] **Step 3: Implement the parser**

Create `src/app/management-link.ts`:

```ts
const MANAGEMENT_PATH = /^\/manage\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;

export function parseManagementLink(value: string, currentOrigin: string): string | null {
  try {
    const origin = new URL(currentOrigin).origin;
    const parsed = new URL(value.trim(), origin);
    if (parsed.origin !== origin || parsed.username || parsed.password) return null;
    return MANAGEMENT_PATH.test(parsed.pathname) ? parsed.pathname : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Write form accessibility and invalid-submit RED tests**

Render `ManagementLinkRecovery` in `tests/ui/app.test.tsx` and assert:

```ts
expect(screen.getByLabelText('Management link')).toHaveAttribute('autocomplete', 'off');
expect(screen.getByLabelText('Management link')).toHaveAttribute('spellcheck', 'false');
expect(screen.getByRole('button', { name: 'Open event manager' })).toBeVisible();

await user.type(screen.getByLabelText('Management link'), '/manage/event');
await user.click(screen.getByRole('button', { name: 'Open event manager' }));

expect(screen.getByLabelText('Management link')).toHaveAttribute('aria-invalid', 'true');
expect(screen.getByText('Enter a Candidary management link from this site.')).toBeVisible();
expect(screen.getByLabelText('Management link')).toHaveFocus();
```

- [ ] **Step 5: Run the UI test and verify RED**

Run:

```powershell
npx vitest run --config vitest.config.ts tests/ui/app.test.tsx -t "management link"
```

Expected: failure because the form component is missing.

- [ ] **Step 6: Implement the form and focused styling**

Create a labelled `section` and labelled `form`. The component must:

```tsx
const input = useRef<HTMLInputElement>(null);
const [error, setError] = useState('');

function submit(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const pathname = parseManagementLink(String(data.get('managementLink') ?? ''), window.location.origin);
  if (!pathname) {
    setError('Enter a Candidary management link from this site.');
    input.current?.focus();
    return;
  }
  setError('');
  window.location.replace(pathname);
}
```

Use a visible `Management link` label, `type="url"`, `name="managementLink"`, `autoComplete="off"`, `spellCheck={false}`, `aria-invalid`, field-associated error text, the explanation “Your link is used only to reopen this event manager.”, and the submit label `Open event manager`.

Add `.management-link-recovery` styles using existing paper, border, ink, danger, and button tokens. The form must be single-column at narrow widths, use the existing 48-pixel `.button` minimum, and avoid fixed widths that can overflow at 320 CSS pixels.

- [ ] **Step 7: Run focused tests GREEN**

Run:

```powershell
npx vitest run --config vitest.config.ts tests/unit/recovery.test.ts tests/ui/app.test.tsx -t "management link|host recovery paths"
npm run typecheck
```

Expected: parser and form tests pass.

- [ ] **Step 8: Commit**

```powershell
git add src/app/management-link.ts src/components/ManagementLinkRecovery.tsx src/styles.css tests/unit/recovery.test.ts tests/ui/app.test.tsx
git commit -m "feat: add secure management link recovery form"
```

---

### Task 3: Token-free recovery page and route

**Files:**
- Create: `src/pages/ManagementRecoveryPage.tsx`
- Modify: `src/app/router.tsx`
- Modify: `src/styles.css`
- Modify: `tests/ui/app.test.tsx`

**Interfaces:**
- Produces: client route `/recover/manage`.
- Consumes: `LoadFailureKind` and `ManagementLinkRecovery`.
- Sends account recovery to bare `/host/login`, which returns to `/host/events` through existing login behavior.

- [ ] **Step 1: Write route-kind and presentation RED tests**

Add table-driven UI cases:

```ts
it.each(['latest-link', 'sign-in', 'retry'] as const)(
  'offers account and management-link recovery for %s',
  async (kind) => {
    render(<RouterProvider router={createAppRouter([`/recover/manage?kind=${kind}`])} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Recover event manager' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/host/login');
    expect(screen.getByLabelText('Management link')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Create account' })).not.toBeInTheDocument();
  },
);

it.each(['/recover/manage', '/recover/manage?kind=unknown'])(
  'falls back to recoverable latest-link guidance for %s',
  (entry) => {
    render(<RouterProvider router={createAppRouter([entry])} />);
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/host/login');
    expect(screen.getByLabelText('Management link')).toBeVisible();
  },
);

render(<RouterProvider router={createAppRouter(['/recover/manage?kind=ended-event'])} />);
expect(screen.getByRole('heading', { level: 1, name: 'This event can no longer be managed' })).toBeVisible();
expect(screen.queryByRole('link', { name: 'Sign in' })).not.toBeInTheDocument();
expect(screen.queryByLabelText('Management link')).not.toBeInTheDocument();
```

- [ ] **Step 2: Run the route tests and verify RED**

Run:

```powershell
npx vitest run --config vitest.config.ts tests/ui/app.test.tsx -t "recover event manager|recoverable latest-link|no longer be managed"
```

Expected: the router falls through to the not-found page.

- [ ] **Step 3: Implement the allow-listed page**

`ManagementRecoveryPage` reads `kind` with `useSearchParams`. Accept exactly the four `LoadFailureKind` strings; default absent or unknown values to `latest-link`.

For `ended-event`, render:

```tsx
<main className="management-recovery-page">
  <Brand />
  <section aria-labelledby="management-recovery-title">
    <h1 id="management-recovery-title">This event can no longer be managed</h1>
    <p role="alert">
      Check the management link you saved. A closed or deleted event cannot be reopened from here.
    </p>
  </section>
</main>
```

For the other three kinds, render the level-one heading `Recover event manager`, explanatory text that sign-in helps only when the event is already saved to the account, a clearly labelled “Saved to your account” route containing `<Link to="/host/login">Sign in</Link>`, and the management-link form as the distinct “Use a management link” route. Do not link to registration.

Add the route before `*`:

```tsx
{ path: '/recover/manage', element: <ManagementRecoveryPage /> },
```

Style the page with the existing centered/public surfaces while keeping the two recovery methods visually separate and contained at 320 pixels.

- [ ] **Step 4: Run focused UI tests GREEN**

Run:

```powershell
npx vitest run --config vitest.config.ts tests/ui/app.test.tsx -t "recover event manager|recoverable latest-link|no longer be managed"
npm run typecheck
```

Expected: all recovery-page cases pass.

- [ ] **Step 5: Commit**

```powershell
git add src/pages/ManagementRecoveryPage.tsx src/app/router.tsx src/styles.css tests/ui/app.test.tsx
git commit -m "feat: add token-free manager recovery page"
```

---

### Task 4: Full-page and inline manager access recovery

**Files:**
- Modify: `src/pages/ManagerPage.tsx`
- Modify: `src/styles.css`
- Modify: `tests/ui/app.test.tsx`
- Modify: `tests/e2e/error-recovery.spec.ts`
- Modify: `tests/e2e/accessibility.spec.ts`

**Interfaces:**
- Consumes: `LoadFailure.kind`, `LoadFailure.offerSignIn`, `hostSignInHref(eventId)`, and `ManagementLinkRecovery`.
- Produces: manager recovery actions for initial load, later refresh, polling, pagination, and manager actions that reveal credential loss.

- [ ] **Step 1: Write full-page and inline recovery RED tests**

Extend the existing `SESSION_EXPIRED` manager cases to assert both recovery routes:

```ts
expect(screen.getByRole('link', { name: 'Sign in' }))
  .toHaveAttribute('href', hostSignInHref('event-a'));
expect(screen.getByLabelText('Management link')).toBeVisible();
expect(screen.queryByRole('link', { name: 'Create account' })).not.toBeInTheDocument();
```

Add `HOST_SESSION_REQUIRED` with the same two actions. Add `ACCOUNT_DISABLED` and assert the form is present but **Sign in** is absent. Add `EVENT_EXPIRED` and `INTERNAL_ERROR` cases and assert neither shows the management-link form.

For the already-rendered session-expiry test, assert the form and event-aware sign-in appear beside the alert and the manager heading remains visible.

In `tests/e2e/error-recovery.spec.ts`, add the equivalent full-page and inline manager expectations, plus:

- an invalid-link submission that stays on the page with focus on `Management link`;
- a same-origin valid-link submission whose intercepted `/manage/:token` document request redirects to token-free `/manage/event/:eventId` and renders the manager;
- a structurally valid stale-link document request that ends at `/recover/manage` with an HTML recovery form rather than a JSON document;
- an event-aware **Sign in** flow whose intercepted login succeeds and returns to the event already saved to that account;
- a link-only recovery that succeeds without account registration or sign-in;
- unknown/absent `/recover/manage` kinds that remain recoverable and `ended-event` that remains terminal; and
- guest terminal cases explicitly free of manager recovery.

In `tests/e2e/accessibility.spec.ts`, render the recoverable full-page manager and inline notice, run axe, and assert the management input's visible label/error association, 44-pixel submit and sign-in targets, and no document overflow at 320 and 768 pixels.

- [ ] **Step 2: Write the polling-session-loss RED regression**

Adapt the existing “keeps the last usable intake on screen when a poll fails” setup:

```ts
return mediaRequests > 1
  ? errorJson({
      code: 'SESSION_EXPIRED',
      message: 'This session has expired.',
      requestId: 'request-a',
    }, 401)
  : json({ media: makeMedia(2).slice(1), nextCursor: null });
```

Invoke the captured five-second poll and expect the existing intake plus an inline alert, event-aware sign-in, and management-link form. Keep the existing `INTERNAL_ERROR` poll test unchanged to prove transient failures remain silent.

- [ ] **Step 3: Run manager UI tests and verify RED**

Run both layers:

```powershell
npx vitest run --config vitest.config.ts tests/ui/app.test.tsx -t "manager|poll|session|disabled"
npx playwright test tests/e2e/error-recovery.spec.ts tests/e2e/accessibility.spec.ts --project=mobile
```

Expected: missing forms/actions and swallowed polling credential loss cause failures.

- [ ] **Step 4: Preserve load decisions in manager notices**

Use a discriminated notice so action failures cannot accidentally acquire access-recovery UI:

```ts
type ManagerNotice =
  | { type: 'action'; message: string; recoveryHint?: string }
  | { type: 'load'; failure: LoadFailure };
```

Add a helper that returns a load notice only for `latest-link`, `sign-in`, or `ended-event`; ordinary retry-classified action failures remain `{ type: 'action', message }`.

Apply it to:

- `refresh()` after `loadedOnce`;
- `refreshIntake()` only when `failure.kind !== 'retry'`;
- `loadMoreMedia()` when the caught API error is access/lifecycle classified; and
- `runManagerAction()` when the caught API error is access/lifecycle classified.

Keep ordinary transient polling failures silent and ordinary refused writes as the existing dismissible message.

- [ ] **Step 5: Compose recovery outside alert live regions**

For the initial full-page error, render `ErrorState` without its `action` prop, then an adjacent recovery section only when `failure.kind` is `latest-link` or `sign-in`. Inside that section:

```tsx
{failure.offerSignIn && (
  <a className="button button--secondary" href={hostSignInHref(eventId)}>Sign in</a>
)}
<ManagementLinkRecovery />
```

For inline load notices, render the message/hint in a `role="alert"` block and render the sign-in/link actions as its siblings in the same dismissible notice wrapper. Do not nest a form in `<p>` or in `role="alert"`. `ACCOUNT_DISABLED` is represented by `latest-link` with `offerSignIn: false`, so it naturally shows only the link form.

- [ ] **Step 6: Run focused unit/UI tests GREEN**

Run:

```powershell
npx vitest run --config vitest.config.ts tests/unit/states.test.ts tests/ui/app.test.tsx -t "manager|poll|session|disabled|load failure"
npx playwright test tests/e2e/error-recovery.spec.ts tests/e2e/accessibility.spec.ts --project=mobile
npm run typecheck
```

Expected: full-page, inline, polling, account-disabled, non-recoverable, containment, and accessibility cases pass.

- [ ] **Step 7: Commit**

```powershell
git add src/pages/ManagerPage.tsx src/styles.css tests/ui/app.test.tsx tests/e2e/error-recovery.spec.ts tests/e2e/accessibility.spec.ts
git commit -m "feat: recover expired manager access in app"
```

---

### Task 5: Navigation-safe management-link exchange errors

**Files:**
- Modify: `worker/routes/exchange.ts`
- Modify: `wrangler.jsonc`
- Modify: `tests/worker/auth-api.test.ts`
- Modify: `tests/worker/smoke.test.ts`
- Modify: `tests/unit/static-headers.test.ts`

**Interfaces:**
- Produces: `isDocumentNavigation(request: Request): boolean`.
- Produces: `classifyExchangeFailure(error: unknown): 'latest-link' | 'ended-event' | 'retry'`.
- Consumes: `failureDecisionForCode` from `shared/load-failure.ts`.

- [ ] **Step 1: Write exchange RED tests**

In `tests/worker/auth-api.test.ts`, add cases for:

```ts
const invalidPath = '/manage/invalid.token';

const navigate = await createApp().request(invalidPath, {
  redirect: 'manual',
  headers: { 'sec-fetch-mode': 'navigate' },
}, testEnv);
expect(navigate.status).toBe(302);
expect(navigate.headers.get('location')).toBe('/recover/manage?kind=latest-link');
expect(navigate.headers.get('location')).not.toContain('invalid.token');
expect(navigate.headers.get('referrer-policy')).toBe('no-referrer');

const html = await createApp().request(invalidPath, {
  redirect: 'manual',
  headers: { accept: 'text/html,application/xhtml+xml' },
}, testEnv);
expect(html.headers.get('location')).toBe('/recover/manage?kind=latest-link');

const json = await createApp().request(invalidPath, {
  headers: { accept: 'application/json' },
}, testEnv);
expect(json.status).toBe(401);
expect((await json.json<{ code: string }>()).code).toBe('SESSION_REQUIRED');
```

Create an event, update its manager token to `revoked_at`, `expires_at`, and its event to `deleted_at` in separate test setup, then assert document redirects choose `latest-link` for revoked and `ended-event` for expired/deleted. Assert the exported pure classifier maps `new Error('unexpected')` to `retry`.

For a valid manager exchange sent with dummy host cookies, assert the response sets `candidary_session` and `candidary_csrf`, redirects to `/manage/event/:eventId`, and `response.headers.getSetCookie()` contains neither `candidary_host=` nor `candidary_host_csrf=`.

- [ ] **Step 2: Write Worker-first route RED tests**

Add:

```ts
expect(wranglerConfig.assets?.run_worker_first)
  .toContain('/recover/manage');
```

In `tests/worker/smoke.test.ts`, request `/recover/manage` with a fake `ASSETS` binding and assert HTML, CSP, and `Referrer-Policy: no-referrer`.

- [ ] **Step 3: Run Worker and route tests and verify RED**

Run:

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/auth-api.test.ts tests/worker/smoke.test.ts
npx vitest run --config vitest.config.ts tests/unit/static-headers.test.ts
```

Expected: failed manager exchanges still return JSON to navigations and `/recover/manage` is absent from Worker-first routing.

- [ ] **Step 4: Split only the manager exchange failure path**

Keep `/join/:token` on the existing uncaught exchange path. Export:

```ts
export function isDocumentNavigation(request: Request): boolean {
  return request.headers.get('sec-fetch-mode') === 'navigate'
    || (request.headers.get('accept') ?? '').toLowerCase().includes('text/html');
}

export function classifyExchangeFailure(
  error: unknown,
): 'latest-link' | 'ended-event' | 'retry' {
  if (!(error instanceof ApiError)) return 'retry';
  const kind = failureDecisionForCode(error.code).kind;
  if (kind === 'latest-link' || kind === 'ended-event') return kind;
  return 'retry';
}
```

The manager route wraps only `AuthService.exchange()` and cookie/redirect construction:

```ts
try {
  return await exchange(context, 'manager');
} catch (error) {
  if (!isDocumentNavigation(context.req.raw)) throw error;
  const kind = classifyExchangeFailure(error);
  return context.redirect(`/recover/manage?kind=${kind}`, 302);
}
```

The redirect must contain only the allow-listed kind. Do not include token, event ID, message, status, or request ID.

Add exact `"/recover/manage"` to `assets.run_worker_first`. Do not add the manifest.

- [ ] **Step 5: Run focused tests GREEN**

Run:

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/auth-api.test.ts tests/worker/smoke.test.ts
npx vitest run --config vitest.config.ts tests/unit/static-headers.test.ts
npm run typecheck
```

Expected: navigation redirects, JSON compatibility, cookie coexistence, token secrecy, Worker-first shell, and headers pass.

- [ ] **Step 6: Commit**

```powershell
git add worker/routes/exchange.ts wrangler.jsonc tests/worker/auth-api.test.ts tests/worker/smoke.test.ts tests/unit/static-headers.test.ts
git commit -m "fix: recover failed manager link navigations"
```

---

### Task 6: Static manifest, app icons, response type, and build verifier

**Files:**
- Create: `public/manifest.webmanifest`
- Create: `design/assets/candidary-app-icon.svg`
- Create: `scripts/generate-app-icons.mjs`
- Create: `public/icons/candidary-180.png`
- Create: `public/icons/candidary-192.png`
- Create: `public/icons/candidary-512.png`
- Create: `public/icons/candidary-maskable-512.png`
- Create: `scripts/verify-pwa-build.mjs`
- Create: `tests/unit/pwa-assets.test.ts`
- Create: `tests/e2e/pwa.spec.ts`
- Modify: `index.html`
- Modify: `public/_headers`
- Modify: `package.json`
- Modify: `design/fidelity-ledger.md`
- Modify: `tests/unit/static-headers.test.ts`

**Interfaces:**
- Produces: `npm run generate:app-icons`.
- Produces: `npm run verify:pwa-build`, which resolves `config.environments.client.build.outDir`.
- Produces: public static assets referenced by the manifest and Apple metadata.

- [ ] **Step 1: Write metadata, manifest, icon, header, and preview RED tests**

Create `tests/unit/pwa-assets.test.ts` to:

- parse `index.html` with `DOMParser`;
- require theme color `#42103b`;
- require `mobile-web-app-capable=yes`, Apple capable/title/status-bar metadata, touch icon `/icons/candidary-180.png`, and `/manifest.webmanifest`;
- parse the manifest and assert exact name, short name, description, `standalone`, `/`, `#42103b`, and `#f7f1e7`;
- assert `start_url` and `id` are absent;
- assert exact `any` 192/512 and `maskable` 512 declarations;
- read every referenced PNG, compare bytes `89 50 4e 47 0d 0a 1a 0a`, and compare IHDR width/height at offsets 16 and 20;
- require `design/assets/candidary-app-icon.svg`, `scripts/generate-app-icons.mjs`, and `scripts/verify-pwa-build.mjs`; and
- load the application entry with a test service-worker registration spy and assert no registration side effect occurs, then render landing/manager surfaces and assert no Add to Home Screen control is present.

Add this static-header assertion:

```ts
expect(headers).toMatch(
  /\/manifest\.webmanifest\s+Content-Type: application\/manifest\+json/u,
);
```

Create `tests/e2e/pwa.spec.ts` that fetches `/manifest.webmanifest`, requires 200, requires a content type containing `application/manifest+json`, parses the response, fetches every declared icon, and asserts each icon returns 200 with `image/png`. Open a manager route with API fixtures and assert the document contains the manifest/touch metadata, `navigator.serviceWorker.getRegistrations()` is empty, and no visible Add to Home Screen prompt exists.

- [ ] **Step 2: Run asset tests and verify RED**

Run:

```powershell
npx vitest run --config vitest.config.ts tests/unit/pwa-assets.test.ts tests/unit/static-headers.test.ts
npx playwright test tests/e2e/pwa.spec.ts --project=mobile
```

Expected: missing manifest, metadata, source, scripts, icons, and MIME rule fail.

- [ ] **Step 3: Add exact manifest and document metadata**

Add the manifest JSON from the approved design verbatim. Update `index.html` with:

```html
<meta name="theme-color" content="#42103b" />
<meta name="mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-title" content="Candidary" />
<meta name="apple-mobile-web-app-status-bar-style" content="default" />
<link rel="apple-touch-icon" sizes="180x180" href="/icons/candidary-180.png" />
<link rel="manifest" href="/manifest.webmanifest" />
```

Do not add `crossorigin` to the manifest link.

- [ ] **Step 4: Add source artwork and deterministic regeneration command**

Create an opaque 512-by-512 SVG with Parchment background and the Apricot/Aubergine three-stem mark fully inside coordinates 102.4 through 409.6 on both axes. Do not add a wordmark, transparency, shadow, or rounded platform mask.

Implement `scripts/generate-app-icons.mjs` with `chromium` from `@playwright/test`. Read the checked-in SVG, render it in a fresh Chromium context with `deviceScaleFactor: 1`, zero body margin, and a viewport matching each target. Write the four named PNG files; render the maskable file separately from the same safe-zone source.

Add:

```json
"generate:app-icons": "node scripts/generate-app-icons.mjs"
```

Run:

```powershell
npm run generate:app-icons
```

- [ ] **Step 5: Add the manifest MIME rule and fidelity ledger entry**

Append:

```text
/manifest.webmanifest
  Content-Type: application/manifest+json
```

Keep the existing global security rule unchanged. Add a fidelity-ledger row recording the global browser theme change from undocumented `#32122f` to Aubergine `#42103b`, with no visual-snapshot churn because browser chrome is outside page captures.

- [ ] **Step 6: Add the resolved-output build verifier**

`scripts/verify-pwa-build.mjs` must:

```js
const config = await resolveConfig({}, 'build');
const outDir = config.environments?.client?.build?.outDir;
if (!outDir) throw new Error('Vite client build output could not be resolved.');
const clientOut = resolve(config.root, outDir);
```

It then requires `manifest.webmanifest`, the four PNGs, `index.html`, and `_headers`; parses the manifest; verifies the updated HTML links; and verifies the manifest MIME rule. Do not regenerate or byte-compare icons.

Add:

```json
"verify:pwa-build": "node scripts/verify-pwa-build.mjs"
```

- [ ] **Step 7: Run asset/build verification GREEN**

Run:

```powershell
npx vitest run --config vitest.config.ts tests/unit/pwa-assets.test.ts tests/unit/static-headers.test.ts
npm run build
npm run verify:pwa-build
```

Expected: metadata/assets pass, build succeeds, and the verifier reads the resolved `dist/client` output without hardcoding it.

- [ ] **Step 8: Run preview coverage GREEN**

Run:

```powershell
npx playwright test tests/e2e/pwa.spec.ts
```

Expected: desktop and mobile projects pass against build plus Vite preview.

- [ ] **Step 9: Commit**

```powershell
git add index.html public design/assets scripts package.json design/fidelity-ledger.md tests/unit/pwa-assets.test.ts tests/unit/static-headers.test.ts tests/e2e/pwa.spec.ts
git commit -m "feat: add route-preserving iOS web app metadata"
```

---

### Task 7: Cross-surface browser coverage and release verification

**Files:**
- Modify: `docs/superpowers/specs/2026-07-27-ios-home-screen-host-workflow-design.md`

**Interfaces:**
- Verifies the complete feature; does not add a new runtime interface.

- [ ] **Step 1: Run cross-surface browser verification**

Run:

```powershell
npx playwright test tests/e2e/error-recovery.spec.ts tests/e2e/accessibility.spec.ts tests/e2e/pwa.spec.ts
```

Expected: account/link recovery, stale-link return, guest isolation, metadata, containment, and accessibility pass in desktop and mobile projects.

- [ ] **Step 2: Run the complete repository release gates**

Run in this order:

```powershell
npm run typecheck
npm run lint
npm test
npm run build
npm run verify:pwa-build
npm run test:e2e
```

Expected: typecheck, lint, all unit/UI/Worker tests, build verification, and all Playwright projects pass.

- [ ] **Step 3: Verify the final diff against every acceptance criterion**

Confirm:

- no `start_url`, `id`, service worker, or install prompt;
- `/recover/manage` is token-free and Worker-first;
- the only bearer navigation target is validated same-origin `/manage/:token`;
- JSON exchange errors are unchanged;
- host cookies are not cleared by exchange;
- guest/landing/registration surfaces gained no manager form;
- manifest MIME and `no-referrer` policies remain;
- source/build/browser checks are distinguished from the unrun physical-iPhone list.

Update the design status to `Implemented; physical-iPhone acceptance pending` only after all automated gates are green.

- [ ] **Step 4: Commit the final specification status**

```powershell
git add docs/superpowers/specs/2026-07-27-ios-home-screen-host-workflow-design.md
git commit -m "test: verify installed manager recovery workflow"
```

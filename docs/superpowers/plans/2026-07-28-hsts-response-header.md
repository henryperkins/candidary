# HSTS Response Header Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve `Strict-Transport-Security` on every Candidary response so a link-bearer session cookie can never be presented over plain HTTP.

**Architecture:** Candidary answers browser requests from two surfaces, and both already carry an identical security-header set kept in sync by a test. `worker/http/security-headers.ts` is Hono middleware covering every path in `assets.run_worker_first` — including the SPA fallback for `/create`, `/event/*`, and `/manage/*`. `public/_headers` is the Cloudflare static-asset manifest covering everything the asset server answers directly, critically including `/`, the landing page and most common first visit. HSTS is added to both. The Worker copy is emitted only on HTTPS requests, because RFC 6797 §7.2 forbids an HSTS host from sending the header over non-secure transport and `npm run dev` serves over `http://localhost`. `_headers` has no scheme predicate, which is harmless because a browser ignores the header over plain HTTP anyway.

**Tech Stack:** Cloudflare Workers, Hono middleware, Cloudflare Workers Static Assets `_headers`, Vitest (`vitest-pool-workers` for worker tests, jsdom for unit tests).

## Global Constraints

- Header value, byte-identical on both surfaces: `max-age=31536000; includeSubDomains`. **No `preload`.** Preload-list submission is not practically reversible and is a separate, deliberate decision.
- The Worker emits HSTS only when the request URL scheme is `https:`. The `_headers` manifest emits it unconditionally — no scheme predicate exists in that format.
- `tests/unit/static-headers.test.ts` is the existing guard that the two surfaces agree. Extend it; do not replace it.
- `tests/unit/**` belongs to `tsconfig.app.json` (`src`, `shared`, `tests/unit`, `tests/ui`) and **cannot import from `worker/`**. It asserts against `public/_headers` as text. Do not try to share a constant across that project boundary. For symmetry, the worker test asserts the same literal rather than importing one.
- `@typescript-eslint/consistent-type-imports` is an error and `npm run lint` runs with `--max-warnings=0`. Type-only imports must use `import type`.
- No migration, no new `ApiErrorCode`, no `wrangler.jsonc` change. `assets.run_worker_first` is unchanged.
- Do not `git add -A`. The working tree has unrelated untracked files (`CLAUDE.md`, `CandidaryDesignSystem.zip`, other plan docs). Stage explicit paths only.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `tests/worker/security-headers.test.ts` | Create | First worker-side coverage of the security middleware: HSTS on HTTPS, its absence on HTTP, and the middleware reaching the `ASSETS`-served SPA fallback. |
| `worker/http/security-headers.ts` | Modify | Scheme-conditional HSTS emission, value in a named constant. |
| `public/_headers` | Modify | The same header on the static-asset surface. |
| `tests/unit/static-headers.test.ts` | Modify | Extend the surface-parity assertion to include HSTS. |
| `docs/security.md` | Modify | Record the transport-security control and the `preload` omission under Browser controls. |
| `docs/deployment.md` | Modify | New Transport security section: zone prerequisite, the two-surface split, the subdomain precondition. |

There is currently **no worker test covering `securityHeaders` at all** — `tests/unit/static-headers.test.ts` only reads the static manifest off disk and never exercises the middleware. Task 2 closes that gap as a side effect, which is why it asserts the full existing header set and not only HSTS.

---

### Task 1: Pre-flight audit and branch

This task gates the header value. If the audit finds a subdomain of `candidary.online` that answers over plain HTTP, `includeSubDomains` would break it for a year and the rest of the plan must be re-decided before proceeding. It also captures the "before" baseline that Task 5 compares against.

**Files:**
- Create: none. Findings are recorded in the task notes and carried into Task 5.

**Interfaces:**
- Consumes: nothing
- Produces: a confirmed header value string for Tasks 2–4, and a recorded live-header baseline for Task 5

- [ ] **Step 1: Branch off main**

```powershell
git switch -c feat/hsts-header
```

- [ ] **Step 2: Record the current live header baseline**

```powershell
curl.exe -sSI https://candidary.online/ | Select-String -Pattern 'strict-transport-security|content-security-policy'
curl.exe -sSI https://candidary.online/create | Select-String -Pattern 'strict-transport-security|content-security-policy'
curl.exe -sSI https://candidary.online/api/does-not-exist | Select-String -Pattern 'strict-transport-security|content-security-policy'
```

Expected today: no `strict-transport-security` on any of the three; `content-security-policy` present on all three.

`/` is served by the asset server (it is not in `run_worker_first`), so its CSP proves `public/_headers` is live.

> **Correction, recorded during execution:** the `/create` probe was originally described here as proving the Hono middleware can set headers on a binding-returned response. It does not. `_headers` also applies to responses served through the `ASSETS` binding, and both surfaces set an identical five-header set, so a CSP on `/create` is not attributable to either one. What actually settled the question was Task 2's RED run: the SPA-fallback test failed on its HSTS assertion having already passed `expect(response.status).toBe(200)` and the CSP assertion, which is only reachable if the middleware does mutate the `ASSETS` response. Keep the `/create` probe as a coverage check; do not read it as a discriminating one.

**If `/create` comes back with no `content-security-policy`,** stop and report it — whichever surface is responsible, that path would be unprotected.

- [ ] **Step 3: Audit subdomains of the apex for plain-HTTP services**

```powershell
curl.exe -sS "https://dns.google/resolve?name=candidary.online&type=NS"
curl.exe -sSI http://cf-bounce.candidary.online/
```

Then open the Cloudflare dashboard DNS records for the zone and check for any additional proxied hostname.

`cf-bounce` is the documented mail return-path subdomain (`docs/deployment.md`) and carries SPF/DKIM DNS records, not an HTTP service, so `includeSubDomains` does not affect it. Expected: no subdomain answers HTTP with real content.

- [ ] **Step 4: Confirm the zone redirects plain HTTP**

In the Cloudflare dashboard for `candidary.online`, confirm **SSL/TLS → Edge Certificates → Always Use HTTPS** is enabled; enable it if not. This is what keeps a plain-HTTP request from reaching the Worker at all, and it is why the scheme predicate in Task 2 is belt-and-braces rather than the primary defense.

- [ ] **Step 5: Confirm the header value**

If Steps 3 and 4 are clean, the value for Tasks 2–4 is exactly:

```text
max-age=31536000; includeSubDomains
```

If Step 3 found a plain-HTTP subdomain, stop and report — do not silently drop `includeSubDomains` and continue.

> **Ramp alternative (not taken):** the cautious rollout starts at `max-age=300`, then `86400`, then a year, across separate deploys. Declined here because the apex has served only HTTPS since launch and sits behind Always Use HTTPS. Task 2 puts the value in a single named constant, so a ramp is a one-line change if the reviewer prefers it.

---

### Task 2: Worker sends HSTS on HTTPS requests

**Files:**
- Create: `tests/worker/security-headers.test.ts`
- Modify: `worker/http/security-headers.ts:5-15`

**Interfaces:**
- Consumes: the confirmed header value from Task 1; `createApp()` from `worker/app.ts`; `AppEnv` from `worker/env.ts`
- Produces: nothing consumed by later tasks. `STRICT_TRANSPORT_SECURITY` stays module-local — the test asserts the literal, matching how `tests/unit/static-headers.test.ts` already treats the CSP string.

Two request targets are used deliberately. `/api/<unknown>` falls to the API branch of `app.notFound` and returns JSON with no database, R2, or fixture setup. `/create` falls to the asset branch and is served through the `ASSETS` binding — the path where header mutation on a binding-returned response is most likely to fail.

- [ ] **Step 1: Write the failing test**

Create `tests/worker/security-headers.test.ts`:

```ts
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { createApp } from '../../worker/app';
import type { AppEnv } from '../../worker/env';

const EXPECTED_HSTS = 'max-age=31536000; includeSubDomains';

function testEnv(): AppEnv {
  const assets = {
    fetch: () => Promise.resolve(
      new Response('<div id="root"></div>', { headers: { 'content-type': 'text/html' } }),
    ),
  } as unknown as Fetcher;
  return { ...env, ASSETS: assets } as AppEnv;
}

describe('security header middleware', () => {
  it('sends Strict-Transport-Security over HTTPS', async () => {
    const response = await createApp().request('https://candidary.online/api/does-not-exist', {}, testEnv());
    expect(response.headers.get('strict-transport-security')).toBe(EXPECTED_HSTS);
  });

  it('omits Strict-Transport-Security over plain HTTP', async () => {
    const response = await createApp().request('http://127.0.0.1:5173/api/does-not-exist', {}, testEnv());
    expect(response.headers.get('strict-transport-security')).toBeNull();
  });

  it('sends the header on the SPA fallback served through the ASSETS binding', async () => {
    const response = await createApp().request('https://candidary.online/create', {}, testEnv());
    expect(response.status).toBe(200);
    expect(response.headers.get('strict-transport-security')).toBe(EXPECTED_HSTS);
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
  });

  it('keeps the rest of the header set on every response', async () => {
    const response = await createApp().request('http://127.0.0.1:5173/api/does-not-exist', {}, testEnv());
    expect(response.headers.get('content-security-policy')).toContain(
      "connect-src 'self' https://*.r2.cloudflarestorage.com",
    );
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('permissions-policy')).toBe('camera=(), microphone=(), geolocation=()');
    expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails for the right reason**

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/security-headers.test.ts
```

Expected: 2 failed, 2 passed.

- `sends Strict-Transport-Security over HTTPS` — FAIL, `expected null to be 'max-age=31536000; includeSubDomains'`
- `sends the header on the SPA fallback served through the ASSETS binding` — FAIL, same assertion
- `omits Strict-Transport-Security over plain HTTP` — PASS (vacuously, nothing sets it yet)
- `keeps the rest of the header set on every response` — PASS

If the SPA-fallback test fails on `expect(response.status).toBe(200)` or on the CSP assertion instead, stop: that is a pre-existing problem with the middleware reaching `ASSETS` responses, not something this change introduces.

- [ ] **Step 3: Implement the header**

Replace the whole of `worker/http/security-headers.ts` with:

```ts
import type { MiddlewareHandler } from 'hono';

import type { AppBindings } from '../env';

// One year, subdomains included. `preload` is deliberately absent: the browser
// preload list is not practically reversible, so joining it is its own decision.
// Named rather than inlined so a max-age ramp stays a one-line change.
const STRICT_TRANSPORT_SECURITY = 'max-age=31536000; includeSubDomains';

export const securityHeaders: MiddlewareHandler<AppBindings> = async (context, next) => {
  await next();
  context.header(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' blob: data:; connect-src 'self' https://*.r2.cloudflarestorage.com; style-src 'self' 'unsafe-inline'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  context.header('Referrer-Policy', 'no-referrer');
  context.header('X-Content-Type-Options', 'nosniff');
  context.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  context.header('Cross-Origin-Opener-Policy', 'same-origin');
  // RFC 6797 section 7.2 forbids sending this over non-secure transport, and
  // `npm run dev` serves the SPA over http://localhost.
  if (new URL(context.req.url).protocol === 'https:') {
    context.header('Strict-Transport-Security', STRICT_TRANSPORT_SECURITY);
  }
};
```

- [ ] **Step 4: Run the test to confirm it passes**

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/security-headers.test.ts
```

Expected: 4 passed.

- [ ] **Step 5: Run the whole worker suite and the linters**

```powershell
npm run test:worker
npm run typecheck
npm run lint
```

Expected: all pass. The middleware now parses the request URL once more per request; nothing should change behaviorally.

- [ ] **Step 6: Commit**

```powershell
git add worker/http/security-headers.ts tests/worker/security-headers.test.ts
git commit -m "feat(security): send HSTS from the Worker on HTTPS requests"
```

---

### Task 3: Add HSTS to the static asset manifest

`/` — the landing page, and the most likely first visit — is not in `assets.run_worker_first`, so it never reaches the Worker middleware. Without this task a first-time visitor to the apex receives no HSTS at all, which is the case that matters most.

**Files:**
- Modify: `tests/unit/static-headers.test.ts:17-24`
- Modify: `public/_headers:1-6`

**Interfaces:**
- Consumes: the confirmed header value from Task 1, as a literal
- Produces: nothing consumed by later tasks

- [ ] **Step 1: Write the failing assertion**

In `tests/unit/static-headers.test.ts`, inside the `it('matches the Worker security header policy', ...)` block, add as the last assertion:

```ts
    expect(headers).toContain('Strict-Transport-Security: max-age=31536000; includeSubDomains');
```

- [ ] **Step 2: Run it and confirm it fails**

```powershell
npx vitest run --config vitest.config.ts tests/unit/static-headers.test.ts
```

Expected: FAIL on `matches the Worker security header policy`, because `public/_headers` does not contain the string yet.

- [ ] **Step 3: Add the header to the manifest**

Replace the whole of `public/_headers` with:

```text
/*
  Content-Security-Policy: default-src 'self'; img-src 'self' blob: data:; connect-src 'self' https://*.r2.cloudflarestorage.com; style-src 'self' 'unsafe-inline'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Cross-Origin-Opener-Policy: same-origin
  Strict-Transport-Security: max-age=31536000; includeSubDomains
```

Two-space indentation on the header lines, matching the existing rule block. Do not add a `#` comment explaining the scheme caveat — a malformed comment would break the whole rule silently and the string assertions would not catch it. That caveat is documented in `docs/security.md` in Task 4 instead.

- [ ] **Step 4: Run the test to confirm it passes**

```powershell
npx vitest run --config vitest.config.ts tests/unit/static-headers.test.ts
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```powershell
git add public/_headers tests/unit/static-headers.test.ts
git commit -m "feat(security): send HSTS from the static asset manifest"
```

---

### Task 4: Document the control and its operator prerequisites

**Files:**
- Modify: `docs/security.md:38` (Browser controls list)
- Modify: `docs/deployment.md:21-23` (new section between the R2 CORS paragraph and `## Secrets`)

**Interfaces:**
- Consumes: the behavior landed in Tasks 2 and 3
- Produces: nothing consumed by later tasks

- [ ] **Step 1: Add the Browser controls bullet**

In `docs/security.md`, immediately after the line:

```markdown
- The Worker applies a restrictive content security policy, no-referrer policy, and stable request IDs.
```

insert:

```markdown
- HTTPS is pinned for a year including subdomains: `Strict-Transport-Security: max-age=31536000; includeSubDomains`. This matters more here than in an account-based app, because the session cookie *is* the whole authorization story and there is no second factor behind it. The Worker sends the header only on HTTPS requests, as RFC 6797 requires; `public/_headers` has no scheme predicate, which is harmless because a browser ignores the header over plain HTTP. `preload` is deliberately omitted — the browser preload list is not practically reversible, so joining it is a separate decision, not a side effect of this control.
```

- [ ] **Step 2: Add the deployment section**

In `docs/deployment.md`, after the paragraph ending `export links are short-lived and manager-only.` and before `## Secrets`, insert:

```markdown
## Transport security

Enable **SSL/TLS → Edge Certificates → Always Use HTTPS** for the zone. A plain-HTTP
request is then redirected at the edge and never reaches the Worker.

Both response surfaces send `Strict-Transport-Security: max-age=31536000;
includeSubDomains`: `worker/http/security-headers.ts` for the paths in
`assets.run_worker_first`, and `public/_headers` for everything the asset server
answers directly — including `/`, which is where most first visits land.
`tests/unit/static-headers.test.ts` fails if the two surfaces drift.

Before changing the apex, confirm no subdomain is expected to answer over plain
HTTP. `includeSubDomains` commits every subdomain to HTTPS for a year and cannot be
withdrawn from browsers that already saw it. The only subdomain in use today is the
mail return-path `cf-bounce`, which carries DNS records rather than an HTTP service.
`preload` is omitted on purpose.

Leave the dashboard's own HSTS setting off. The policy lives in the repo so it stays
under version control and under test; two sources would let a second, different
max-age ship without review.
```

- [ ] **Step 3: Confirm no source file was touched by accident**

```powershell
git status --short
```

Expected: only `docs/security.md` and `docs/deployment.md` modified.

- [ ] **Step 4: Commit**

```powershell
git add docs/security.md docs/deployment.md
git commit -m "docs: record the HSTS control and its zone prerequisite"
```

---

### Task 5: Full verification, deploy, and live check

**Files:**
- Modify: none

**Interfaces:**
- Consumes: everything from Tasks 2–4, and the baseline recorded in Task 1 Step 2
- Produces: the evidence that the header is actually being served

- [ ] **Step 1: Run the full test suite**

```powershell
npm test
```

Expected: `test:unit` and `test:worker` both pass. Do not proceed on a partial run.

- [ ] **Step 2: Build and confirm the manifest ships**

```powershell
npm run build
Get-ChildItem -Path dist -Recurse -Filter _headers | Select-Object -ExpandProperty FullName
```

Expected: `tsc -b` clean, `vite build` succeeds, and exactly one `_headers` path is printed. Read it:

```powershell
Get-ChildItem -Path dist -Recurse -Filter _headers | Get-Content
```

Expected: the six header lines including `Strict-Transport-Security`.

If no `_headers` is found in the build output, stop — the static surface would ship with no security headers at all. That is a pre-existing problem, larger than this change, and worth reporting separately rather than working around here.

- [ ] **Step 3: Run the e2e suite**

```powershell
npm run test:e2e
```

Expected: pass. These run against a static `vite preview` over plain HTTP with every API call stubbed, so they exercise no HSTS behavior — this is a regression check only.

- [ ] **Step 4: Deploy**

```powershell
npm run deploy
```

- [ ] **Step 5: Verify all three surfaces on the live origin**

```powershell
curl.exe -sSI https://candidary.online/ | Select-String -Pattern 'strict-transport-security'
curl.exe -sSI https://candidary.online/create | Select-String -Pattern 'strict-transport-security'
curl.exe -sSI https://candidary.online/api/does-not-exist | Select-String -Pattern 'strict-transport-security'
```

Expected on all three: `strict-transport-security: max-age=31536000; includeSubDomains`.

- `/` is never handled by the Worker (not in `run_worker_first`), so it isolates the `public/_headers` surface.
- `/api/does-not-exist` is never handled by the asset server, so it isolates the Worker middleware.
- `/create` is the Worker falling through to `ASSETS`, and `_headers` applies to that response too — so it proves the path is covered without proving *which* surface covered it. Check it anyway: it is a real entry point, and a miss there is a miss regardless of cause.

A miss on any one of the three means that surface is uncovered. Report which one; do not describe the change as done.

- [ ] **Step 6: Confirm exactly one header value**

```powershell
(curl.exe -sSI https://candidary.online/ | Select-String -Pattern 'strict-transport-security').Count
```

Expected: `1`. A `2` means the zone-level HSTS setting is also on and appending a second, possibly different, policy. If so, turn the dashboard setting off and keep the in-repo one.

- [ ] **Step 7: Merge**

```powershell
git switch main
git merge --no-ff feat/hsts-header
git push
```

---

## Out of scope

- **`preload`.** Not added. Removal takes months and depends on browser vendors' release cadence.
- **A max-age ramp.** Declined in Task 1 with the reasoning recorded; the value is a single constant if the reviewer wants it.
- **Zone-level HSTS via the Cloudflare dashboard.** Deliberately unused, so the policy stays in the repo, under test, and reviewable in a diff. Task 5 Step 6 checks it is not also on.
- **The wedding rehearsal gate.** `docs/deployment.md` items 11–16 require physical devices, real HEIC from a phone library, VoiceOver, TalkBack, and a 10,000-photo disposable event. This change neither touches nor advances that gate.

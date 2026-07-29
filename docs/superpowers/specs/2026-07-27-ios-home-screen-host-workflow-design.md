# iOS Home Screen Host Workflow Design

- **Date:** 2026-07-27
- **Revalidated:** 2026-07-28 against `origin/main` at `051478a`
- **Status:** Implemented; physical-iPhone acceptance pending

## Objective

Make Candidary work as an iOS Home Screen web app, with the host manager as the
primary use case. A host who installs from `/manage/event/:eventId` must return
to that exact event in standalone mode. The feature must not add an install
banner, modal, tooltip, or other promotion.

The installed manager must also remain recoverable when either credential
available to the current application stops working:

- a host whose event is saved to an account can sign in again inside the
  standalone app; and
- a host with a link-only event can paste the latest management link inside the
  standalone app.

Recovery must preserve the current account-or-link authorization model. It must
not change token, session, event-lifecycle, ownership, or account-registration
rules. It may change how the existing management-link route renders errors for
top-level document navigation, but it must not add an API endpoint.

## Product decisions

- Installation is initiated by the user through iOS Add to Home Screen. Candidary
  does not promote installation in its interface.
- The page from which the user installs is the page the icon launches.
- Host workflows are the acceptance priority, but the metadata is global and
  does not prevent a guest from installing an event page.
- Link-derived manager sessions remain limited to 12 hours. Existing host
  account sessions remain limited to 30 days.
- Both credential types remain bounded by the event's management deadline:
  through 90 days after the event day, with a minimum of 90 days from creation.
- Management links retain their existing fixed event lifecycle. Opening a valid
  management link creates a new 12-hour link session without replacing or
  clearing an existing host-account session.
- Host accounts remain optional. Signing in recovers only events already saved
  to that account; the management link remains the recovery path for a
  link-only event.
- Recovery does not offer account creation. A newly exchanged management link
  cannot recreate the original creator session or extend its 12-hour ownership
  claim window, so presenting registration as a guaranteed recovery would be
  false.
- A failed top-level management-link exchange returns to a token-free in-app
  recovery page. That page offers existing-account sign-in and management-link
  entry where either can help. Non-navigation clients retain the existing JSON
  error contract.
- The installed app does not provide offline behavior.
- The feature is scoped to iOS Home Screen behavior. It does not attempt to
  satisfy Chrome's in-browser install-promotion criteria.

## Current constraints

### Routing

Candidary is a React Router SPA served with Cloudflare Workers static assets.
The relevant paths are:

- `/create`;
- `/event/:slug`;
- `/manage/:token`, which is a Worker exchange route;
- `/manage/event/:eventId`, which is the token-free manager SPA route;
- `/host/login`, `/host/register`, `/host/events`, and `/host/verify`, which are
  existing account SPA routes; and
- `/recover/manage`, which will be a token-free manager recovery SPA route.

The brand links to `/`. A standalone manager app therefore needs a root
navigation scope; a default scope derived from `/manage/event/:eventId` would
be too narrow.

### Authorization

Candidary now has two independent host credentials:

1. a management link is a bearer secret exchanged for the
   `candidary_session` and `candidary_csrf` event-cookie pair; and
2. an optional account sign-in creates the `candidary_host` and
   `candidary_host_csrf` account-cookie pair.

The Worker redirects a successful management-link exchange to the token-free
manager route. Link-derived manager sessions last 12 hours. Host-account
sessions last 30 days. `worker/auth/manager.ts` tries an account membership
first, then the independent link session, and enforces
`managementAccessExpiresAt` for both. A stale account credential therefore
cannot block a working management link, and opening a link must not sign the
host out of an existing account.

Account access does not change event ownership. A saved owner or cohost may
reach the event by signing in. A link-only event still depends on the bearer
link, and exchanging that link after the creator session has expired does not
make it eligible for a new first-owner claim.

On current iOS, Add to Home Screen copies the installing browser's current
cookies into the new web app. The installed app therefore begins with whichever
event and host-account cookies authorized the installing manager page. After
installation, Safari and the web app no longer share website data, so opening a
saved management link in Safari cannot be relied on to renew either cookie pair
in the installed app.

Today, every exception from `/manage/:token` reaches `app.onError`, which
returns JSON even for a top-level navigation. That is tolerable as an API
response but strands a standalone app without browser chrome. The design must
remove the bearer URL and return document navigations to an HTML recovery
surface while preserving JSON for programmatic requests.

### Static delivery

`public/_headers` applies `X-Content-Type-Options: nosniff` to static assets.
The manifest therefore needs an explicit, deterministic manifest content type.
The manifest remains a static asset and does not run through the Worker.

### Brand assets

The existing Candidary mark is CSS-only: three slightly rotated, rounded stems
using Apricot and Aubergine. There is no reusable source image for an app icon.
The application currently uses an undocumented `#32122f` browser theme color
instead of a design-system token.

Changing the browser theme color affects browser chrome on every route, not
only installed apps. Implementation records the `#32122f` to `#42103b` change
in `design/fidelity-ledger.md`. Browser chrome is outside the tracked page
screenshots, so the change requires a ledger entry but no visual-baseline
regeneration.

## Selected architecture

### Route-preserving static manifest

Add `public/manifest.webmanifest` with this semantic shape:

```json
{
  "name": "Candidary",
  "short_name": "Candidary",
  "description": "A private place for guests to deliver event photos.",
  "display": "standalone",
  "scope": "/",
  "theme_color": "#42103b",
  "background_color": "#f7f1e7",
  "icons": [
    {
      "src": "/icons/candidary-192.png",
      "sizes": "192x192",
      "type": "image/png",
      "purpose": "any"
    },
    {
      "src": "/icons/candidary-512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "any"
    },
    {
      "src": "/icons/candidary-maskable-512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "maskable"
    }
  ]
}
```

The manifest deliberately omits both `start_url` and `id`.

The Web App Manifest processing algorithm first sets the effective start URL to
the installing document URL. With no `start_url` member, installing from
`/manage/event/:eventId` therefore preserves that exact path. With no `id`
member, the effective ID also defaults to that start URL. Separate events can
therefore become distinct installations on platforms that use manifest IDs.
Every installation still has the same default `Candidary` label; iOS lets the
user edit that label during installation.

`scope: "/"` is explicit. It keeps `/`, `/create`, event pages, the
management-link exchange, manager pages, host-account pages, and the recovery
page inside the standalone application context.

### Rejected alternatives

#### Dynamic per-event manifests

A Worker-generated or client-switched manifest could provide an explicit
event-specific start URL and label. It would add routing, cache variation,
early-manifest switching, and preview-test complexity while producing no
required iOS behavior that the static manifest lacks.

#### Dedicated host application shell

A separate host launcher could choose or remember an event, but it would no
longer launch the exact page from which the host installed. It would also
expand navigation and authentication scope beyond this feature.

#### Account-only recovery

Redirecting every failed manager to `/host/login` would reuse the current
account UI, but it would strand link-only events and imply that account
membership exists when it may not. Sign-in remains one recovery path, not a
replacement for management-link entry.

#### Reusing the sign-in page as a mixed recovery page

Adding management-link parsing to `/host/login` would conflate account
authentication with bearer-link exchange and would leave ended-event guidance
without a clear home. The dedicated `/recover/manage` route can present
sign-in, link entry, or terminal lifecycle guidance without changing the
meaning of the existing account page.

## Document metadata

Update `index.html` to include:

```html
<meta name="theme-color" content="#42103b" />
<meta name="mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-title" content="Candidary" />
<meta name="apple-mobile-web-app-status-bar-style" content="default" />
<link rel="apple-touch-icon" sizes="180x180" href="/icons/candidary-180.png" />
<link rel="manifest" href="/manifest.webmanifest" />
```

The manifest link is same-origin and public, so it does not use
`crossorigin="use-credentials"`.

The status-bar style is `default`. The application does not use
`viewport-fit=cover` or safe-area inset CSS, so it must not use
`black-translucent`, which could place content under the iOS status bar.

The HTML and manifest share the documented design tokens:

- theme/chrome: Aubergine `#42103b`;
- launch background: Parchment `#f7f1e7`.

## Icon source and generation

Add an opaque, square source artwork at:

`design/assets/candidary-app-icon.svg`

The source reproduces the three-stem mark from `Brand.tsx` on a Parchment
background using the exact Apricot and Aubergine tokens. The mark stays inside
the central 60 percent of the canvas, leaving a 20 percent safe-zone margin on
every side. The source contains no wordmark, transparency, shadows, or
platform-shaped corner mask.

Add `scripts/generate-app-icons.mjs`. It uses the repository's existing
Playwright Chromium dependency to render the checked-in SVG at device scale
factor 1 and write:

- `public/icons/candidary-180.png`;
- `public/icons/candidary-192.png`;
- `public/icons/candidary-512.png`; and
- `public/icons/candidary-maskable-512.png`.

All four files are checked in. The maskable file is a separate reviewed output,
even though it is generated from the same safe-zone-compliant master. The
generator provides a repeatable manual regeneration command, but PNG bytes are
not expected to remain identical across Chromium or operating-system
antialiasing changes. Tests do not regenerate and byte-compare the checked-in
PNGs. Add the package script
`"generate:app-icons": "node scripts/generate-app-icons.mjs"` as the documented
regeneration command.

## Static response headers

Add a specific rule to `public/_headers`:

```text
/manifest.webmanifest
  Content-Type: application/manifest+json
```

The existing global security-header rule still applies. Cloudflare merges
matching `_headers` rules, and the specific content type overrides the inferred
static-asset content type. The manifest is not added to
`assets.run_worker_first`.

No Content Security Policy change is required. In the absence of a
`manifest-src` directive, the same-origin manifest is allowed by
`default-src 'self'`.

Both `public/_headers` and Worker security middleware retain
`Referrer-Policy: no-referrer`. This is part of the bearer-secret boundary: a
management-token request must not become a referrer when the standalone app
later opens a cross-origin presigned R2 export URL.

## Host access recovery

### When recovery appears

The current client has four `LoadFailureKind` values: `latest-link`,
`ended-event`, `sign-in`, and `retry`. Manager access recovery appears for
`latest-link` and `sign-in` failures:

- `latest-link` covers a missing or expired event session, a forbidden event
  role, a revoked management token, and a disabled account for which an
  independent management link may still work;
- `sign-in` covers `HOST_SESSION_REQUIRED`.

It appears in both manager failure presentations:

1. the initial full-page error state when the manager cannot load; and
2. the inline manager notice when a previously loaded manager loses access.

Each recoverable presentation provides the management-link form. It also keeps
the current **Sign in** route when an account could answer the failure. A
disabled account is the exception: signing in to the same disabled account
cannot help, so that state offers the independent management-link path only.

Recovery does not appear for ended or deleted events, ordinary retryable
transport failures, guest failures, or ordinary manager pages. The
management-link form is not added to the landing page or account-registration
page. The landing page's existing returning-host sign-in link remains
unchanged.

The token-free `/recover/manage` page uses the same recovery pieces when an
existing management-link exchange redirects there.

### Failure model

Move the existing `LoadFailureKind` and exhaustive API-code classification
table from `States.tsx` into a small shared module used by the client and
Worker. Expose the resulting `kind` on `LoadFailure` instead of discarding it
after selecting recovery prose, and carry the full recovery decision into
manager notices.

Preserve the current `offerSignIn` behavior while making it explicit and
code-driven:

- manager failures caused by `SESSION_REQUIRED`, `SESSION_EXPIRED`,
  `ROLE_FORBIDDEN`, `TOKEN_REVOKED`, or `HOST_SESSION_REQUIRED` may offer
  sign-in;
- `ACCOUNT_DISABLED` classifies as `latest-link` but does not offer sign-in;
- event lifecycle failures remain `ended-event`; and
- all other current API codes remain `retry`.

The `ACCOUNT_DISABLED` correction is required by the current dual-credential
model. `worker/auth/manager.ts` deliberately lets an independent management
link succeed when the account credential is disabled, so terminal-event
guidance would suppress a recovery path that still exists.

Rendering and exchange redirects use the shared decision, never message text,
to choose recovery behavior. The shared table remains exhaustive with
`satisfies Record<ApiErrorCode, ...>` so adding a new API code cannot silently
inherit the wrong recovery.

### Top-level exchange failure handling

Change the existing `/manage/:token` exchange route; do not add a server
endpoint. The route catches exchange errors only long enough to distinguish a
top-level document navigation from a programmatic request.

A request is a document navigation when either:

- `Sec-Fetch-Mode` is `navigate`; or
- `Accept` contains `text/html`, as a compatibility fallback.

For a non-navigation request, the error is rethrown and the existing
`app.onError` JSON response remains unchanged.

For a document navigation, the route redirects to the token-free
`/recover/manage` SPA route. The redirect contains only a sanitized failure
kind:

- `latest-link` for invalid, missing, wrong-role, or revoked management links;
- `ended-event` for expired, deleted, or missing events; and
- `retry` for an unexpected failure.

The redirect never includes the pasted token, raw error message, event ID, or
request ID. A valid exchange remains unchanged: it sets the session and CSRF
event cookies, leaves any host-account cookies untouched, and redirects to
`/manage/event/:eventId`.

Add `/recover/manage` to the React router. It reads only the allow-listed
failure kind. `latest-link`, `sign-in`, and `retry` render:

- an in-app explanation;
- **Sign in** linking to `/host/login` for an event already saved to an
  account; and
- the management-link form for link-only access.

The exchange route itself emits only `latest-link`, `ended-event`, or `retry`;
accepting `sign-in` keeps the client route aligned with the shared allow-list.
`ended-event` renders the existing terminal event guidance without sign-in or
the form. An absent or unrecognized kind falls back to `latest-link`, ensuring
a malformed recovery URL remains recoverable.

The page does not offer **Create account**. With no trusted event ID and no live
creator session, registration cannot promise to attach the event. Hosts may
still create accounts through the existing product flows; it is not presented
as recovery from a failed bearer link.

Because `/recover/manage` does not begin with `/manage/`, it does not collide
with the Worker exchange matcher. Add the exact path to
`assets.run_worker_first`; the Worker `notFound` handler then serves the SPA
shell through `ASSETS` with the same security middleware as the other clean
client routes. The route remains inside the root manifest scope.

### Recovery component

Add a reusable `ManagementLinkRecovery` component and a pure management-link
parser. Compose it with the existing account sign-in action rather than
embedding account authentication in the parser:

- on `/manage/event/:eventId`, the sign-in action uses the existing
  `hostSignInHref(eventId)` helper so a saved membership can return to that
  event and the server can idempotently recognize an existing owner or cohost;
- on `/recover/manage`, where a failed token cannot supply a trusted event ID,
  sign-in goes to `/host/login` and then `/host/events`; and
- neither surface offers account creation as though a new account could claim
  an event after the creator window.

The component contains:

- a visible `Management link` label;
- a URL input with autocomplete and spellcheck disabled;
- brief text explaining that the link is used only to reopen the manager; and
- an `Open event manager` submit button.

On submit, the parser:

1. trims the input;
2. parses it relative to the current origin;
3. requires the parsed origin to equal the current origin;
4. rejects usernames and passwords;
5. requires exactly one path segment after `/manage/`;
6. requires that segment to contain exactly two non-empty base64url-shaped
   components separated by one dot; and
7. discards any query string or fragment and returns only the validated
   pathname.

The parser does not pin current token lengths; the Worker remains authoritative
for token validity. Requiring the existing `id.secret` shape prevents
`/manage/event` and similarly malformed paths from leaving the recoverable
form, while ignoring harmless mail-client query or fragment additions.

An invalid value stays on the page, shows a field-associated validation message,
and moves focus to the invalid field. A valid value replaces the current
location with the validated `/manage/:token` pathname. The existing Worker
exchange sets event cookies in the installed app's own cookie jar, preserves
the separate host-account cookie pair, and redirects to the token-free event
manager named by that link. If the structurally valid token is stale, wrong, or
truncated in a way the server alone can detect, the navigation-only exchange
handling redirects to `/recover/manage` rather than rendering JSON. The host
therefore retains both sign-in and link recovery and can try again.

The component does not:

- persist the link or token;
- place it in local or session storage;
- send it to analytics or logs;
- accept another origin;
- change link or session expiry;
- create an account or claim event ownership;
- introduce a new API endpoint;
- leave a failed bearer URL as the standalone app's current document.

## Navigation and known platform behavior

- Launching the icon returns to the installing route because `start_url` is
  absent.
- Root-scoped manager, host-account, event, and public navigation remains
  inside the standalone app.
- A saved event can be recovered by signing in inside the standalone app. A
  link-only event can be recovered by entering its latest management link.
- A 30-day host-account session can outlive a 12-hour link-derived manager
  session, but neither extends the event's management deadline.
- A failed management-link document navigation ends on token-free
  `/recover/manage`; API-style requests still receive JSON.
- Cross-origin presigned R2 export links are outside manifest scope and are
  expected to leave the standalone context. This is verified on a physical
  iPhone rather than changed.
- The manifest has no `start_url`, so it intentionally does not satisfy
  Chrome's in-browser install-promotion criteria. Current Chrome criteria do
  not require a service worker, so the missing start URL—not the lack of a
  service worker—is the relevant limitation.
- No service worker is registered. The manager depends on live API, D1, R2, and
  Images state, and no offline shell or stale manager data is promised.

## Accessibility

- The recovery form uses visible labels and field-associated error text.
- The token-free recovery page has a level-one heading and an explicit
  accessible name for the recovery region and form.
- Sign-in and management-link entry are presented as two clearly labelled
  routes to access, not as one combined form.
- The submit button retains the existing minimum 44-pixel target behavior.
- Invalid input receives focus so the correction is announced and immediately
  actionable.
- The existing failure alert continues to announce the failure and recovery
  hint. The interactive form is adjacent to, not nested inside, the alert live
  region.
- No status or outcome relies on color alone.
- The icon is decorative operating-system artwork and does not change document
  accessibility.

## Automated verification

Implementation follows test-driven development. Each behavior is introduced by
a failing test that fails for the missing feature before production code or
assets are added.

### Source metadata and assets

Unit tests verify:

- `index.html` links the manifest and 180-pixel Apple touch icon;
- standard and Apple-prefixed standalone metadata are present;
- status-bar style is `default`;
- the HTML theme color is Aubergine;
- the manifest parses as JSON;
- `name`, `short_name`, `display`, `scope`, and both colors are exact;
- `start_url` and `id` are absent;
- 192- and 512-pixel `any` icons are declared;
- a 512-pixel `maskable` icon is declared;
- every referenced source icon exists;
- PNG signatures and IHDR dimensions match their declared sizes;
- the checked-in SVG source and generator exist; and
- no service-worker registration or install-prompt component is introduced.

`tests/unit/static-headers.test.ts` additionally verifies the manifest-specific
`Content-Type: application/manifest+json` rule while preserving the existing
security-header assertions. Its route contract also requires
`/recover/manage` in `assets.run_worker_first`.

### Manager recovery

Unit and UI tests verify:

- same-origin management links return only `/manage/:token`;
- foreign origins, credentials, extra path segments, malformed token shapes,
  and non-management paths are rejected;
- query strings and fragments are stripped from otherwise valid links;
- the shared classifier and `describeLoadFailure` expose the same stable kind
  while retaining the current code-driven sign-in decision;
- `ACCOUNT_DISABLED` offers the management-link form without offering sign-in;
- `latest-link` and `sign-in` manager failures show the management-link form
  on both the full-page and inline surfaces;
- those manager failures preserve the existing sign-in action when it can
  recover an account-owned event, using `hostSignInHref(eventId)`;
- ordinary manager `ended-event` and `retry` failures do not show access
  recovery;
- the dedicated exchange-recovery page shows sign-in plus the form for
  `latest-link`, `sign-in`, and `retry`, but neither for `ended-event`;
- absent or unrecognized recovery-page kinds fall back to `latest-link`;
- recovery surfaces do not present account creation as an event-recovery path;
- invalid submissions show and focus the validation error; and
- guest failure surfaces do not gain manager recovery.

Worker tests verify:

- a valid management-link exchange still sets event cookies and redirects to
  the token-free event manager without clearing the separate host-account
  cookies;
- an invalid or revoked management link requested with
  `Sec-Fetch-Mode: navigate` redirects to
  `/recover/manage?kind=latest-link`;
- an expired or deleted event navigation redirects with
  `kind=ended-event`;
- the pure exchange-error classifier maps an unexpected error to `retry`;
- no redirect location contains the bearer token;
- `Accept: text/html` triggers the same navigation behavior when
  `Sec-Fetch-Mode` is absent;
- JSON-oriented requests preserve their current status and JSON body; and
- navigation redirects retain `Referrer-Policy: no-referrer`.

The existing host-authorization regressions also remain green: a saved account
can reach its event without a management link, a stale host session can fall
back to a working link, account and link cookies coexist, and neither credential
can extend `managementAccessExpiresAt` or create ownership it did not already
have.

Browser tests verify:

- the manager document exposes the manifest metadata without a visible install
  prompt;
- a full-page expired manager offers account sign-in and can submit a valid
  management link;
- an inline expired-session notice offers the same two recovery paths;
- a host can sign in and reopen an event already saved to the account;
- a link-only event remains recoverable by its valid management link without
  requiring an account;
- recovery requests the existing `/manage/:token` path and follows its
  token-free redirect;
- a structurally valid but stale link returns to the in-app recovery form
  instead of a JSON document;
- a malformed token shape remains in the client-side form with a focused
  validation error; and
- manager, host-account, and recovery routes remain within the root manifest
  scope.

### Built client output

Add `scripts/verify-pwa-build.mjs` and the package script
`"verify:pwa-build": "node scripts/verify-pwa-build.mjs"`. Verification runs
`npm run build` and then `npm run verify:pwa-build`. The verifier calls Vite's
`resolveConfig` and reads `config.environments.client.build.outDir`; it does not
hardcode `dist/` or `dist/client`.

It verifies that the resolved Cloudflare client output contains:

- `manifest.webmanifest`;
- all four PNG icons;
- the updated `index.html`; and
- `_headers` with the manifest content-type rule.

The production-like preview test fetches `/manifest.webmanifest`, requires HTTP
200, parses the response, and requires a response content type containing
`application/manifest+json`.

## Physical iPhone acceptance

Desktop and Playwright checks cannot perform iOS Home Screen installation.
Before claiming physical-device readiness, use a current iPhone against
controlled events that are still inside their management deadline. Prepare one
event saved to a host account and one link-only event, then verify:

1. open the link-only event's valid management link and reach
   `/manage/event/:eventId`;
2. add that page to the Home Screen;
3. confirm the Candidary icon and editable label;
4. launch it and confirm standalone mode;
5. confirm it opens the exact event manager rather than `/`;
6. move among Intake, Gallery, Notes, Share, Settings, the Candidary brand, and
   the existing host sign-in/events routes without unexpectedly opening Safari;
7. expire the link-derived manager session in the controlled environment,
   relaunch, paste the saved link inside the app, and return to the same
   token-free manager;
8. open the saved-account event, expire or revoke the host-account session,
   sign in again inside the standalone app, and reopen that event without its
   management link;
9. confirm signing in does not claim or promise recovery for the link-only
   event, then confirm its management link still works while signed in;
10. open a saved management link in Safari and confirm that action alone does
    not repair the standalone app's separate cookie jar;
11. paste a malformed link and a structurally valid stale or rotated link, then
    confirm both failures leave a usable in-app recovery surface from which
    sign-in or a valid link can proceed, and confirm back navigation reveals
    neither the bearer URL nor a JSON document;
12. request an export and confirm each presigned cross-origin download opens
    outside the standalone app without losing the installed manager; and
13. confirm no install promotion appears inside Candidary.

## Deployment and operational boundaries

This feature adds no migration, binding, server endpoint, API wire contract,
token change, session-duration change, retention change, account-registration
change, or ownership change. In particular, it does not modify migration 0006
or the account-or-link resolver introduced after the original version of this
document.

It adds one client route, static manifest/icon assets, account-aware recovery
presentation, and top-level error rendering on the existing management-link
exchange route. Deployment still uses the repository's normal release gates.

A deployed verification must check the live manifest, icon responses, content
type, security headers, and manager route. Source and preview verification do
not by themselves prove iOS installation behavior. Physical-iPhone acceptance
remains a separate release claim.

## Acceptance criteria

- Candidary contains no visible Add to Home Screen prompt.
- The manifest and Apple metadata create an iOS standalone web-app
  configuration with reviewed Candidary artwork.
- Installing from a manager event preserves that exact event URL.
- Root-scoped manager, account, recovery, event, and public navigation stays
  inside the standalone app.
- A host whose event is saved to an account can sign in inside the standalone
  app and recover the event without its management link.
- A host with a link-only event or a disabled account can paste a valid
  same-origin management link inside the app and re-enter through the existing
  exchange route.
- Recovery does not imply that signing in can reach an unsaved event or that
  creating an account after the creator claim window can attach it.
- Malformed links remain in the form, and structurally valid but invalid or
  revoked links return to a token-free in-app recovery page rather than a JSON
  document.
- Expired or deleted events return to token-free terminal guidance without
  offering recovery that cannot work.
- Recovery never stores, logs, or submits the management secret anywhere except
  the existing same-origin exchange path.
- Opening a management link changes only the event-cookie pair and does not
  clear or replace the separate host-account cookie pair.
- `Referrer-Policy: no-referrer` remains enforced on static and Worker
  responses.
- Link-derived manager sessions remain 12 hours, host-account sessions remain
  30 days, and both remain bounded by the existing management deadline of
  90 days after the event day with a 90-day minimum from creation.
- Manifest delivery has an explicit `application/manifest+json` content type
  under the existing `nosniff` policy.
- Theme and launch colors use documented design-system tokens.
- `design/fidelity-ledger.md` records the global browser-chrome token change.
- Source, UI, browser, build-output, and static-header tests pass.
- Actual iOS install, expired-session re-entry, failed-link recovery, and export
  behavior are not described as device-verified until the physical acceptance
  list passes.

## References

- [W3C Web Application Manifest](https://www.w3.org/TR/appmanifest/)
- [WebKit: Web apps and login cookies in Safari 17.2](https://webkit.org/blog/14787/webkit-features-in-safari-17-2/)
- [WebKit: Every site can be a web app on iOS and iPadOS 26](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/)
- [Apple: Configuring Web Applications](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/ConfiguringWebApplications/ConfiguringWebApplications.html)
- [Cloudflare Workers static-asset headers](https://developers.cloudflare.com/workers/static-assets/headers/)
- [Cloudflare Vite plugin static assets](https://developers.cloudflare.com/workers/vite-plugin/reference/static-assets/)
- [Chrome install-promotion criteria](https://web.dev/articles/install-criteria)
- [Host Account Hardening Design](./2026-07-28-host-account-hardening-design.md)
- [Pull Request 3 Review Remediation Design](./2026-07-28-pr3-review-remediation-design.md)

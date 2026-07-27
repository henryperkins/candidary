# iOS Home Screen Host Workflow Design

- **Date:** 2026-07-27
- **Status:** Revised after code review; awaiting approval

## Objective

Make Candidary work as an iOS Home Screen web app, with the host manager as the
primary use case. A host who installs from `/manage/event/:eventId` must return
to that exact event in standalone mode. The feature must not add an install
banner, modal, tooltip, or other promotion.

The installed manager must also have a path back into the event after its
12-hour manager session expires. That recovery must reuse the existing
management-link exchange and must not change token lifetimes, session
lifetimes, or authorization. It may change how the existing management-link
route renders errors for top-level document navigation, but it must not add an
API endpoint.

## Product decisions

- Installation is initiated by the user through iOS Add to Home Screen. Candidary
  does not promote installation in its interface.
- The page from which the user installs is the page the icon launches.
- Host workflows are the acceptance priority, but the metadata is global and
  does not prevent a guest from installing an event page.
- Manager sessions remain limited to 12 hours.
- Management links retain their existing fixed event lifecycle. Opening a valid
  management link creates a new manager session.
- A failed top-level management-link exchange returns to a token-free in-app
  recovery page. Non-navigation clients retain the existing JSON error contract.
- The installed app does not provide offline behavior.
- The feature is scoped to iOS Home Screen behavior. It does not attempt to
  satisfy Chrome's in-browser install-promotion criteria.

## Current constraints

### Routing

Candidary is a React Router SPA served with Cloudflare Workers static assets.
The relevant paths are:

- `/create`;
- `/event/:slug`;
- `/manage/:token`, which is a Worker exchange route; and
- `/manage/event/:eventId`, which is the token-free manager SPA route; and
- `/recover/manage`, which will be a token-free manager recovery SPA route.

The brand links to `/`. A standalone manager app therefore needs a root
navigation scope; a default scope derived from `/manage/event/:eventId` would
be too narrow.

### Authorization

The manager link is a bearer secret. The Worker exchanges it for HttpOnly
session and readable CSRF cookies, then redirects to the token-free manager
route. Manager sessions last 12 hours. The installed iOS web app has storage
separate from Safari after installation, so opening a saved management link in
Safari cannot be relied on to renew the installed app's cookie jar.

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
management-link exchange, and manager pages inside the standalone application
context.

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

## Manager-link recovery

### When recovery appears

Recovery appears only on manager failures classified as `latest-link`, which
currently covers:

- missing sessions;
- expired sessions;
- forbidden roles;
- revoked access tokens.

It appears in both manager failure presentations:

1. the initial full-page error state when the manager cannot load; and
2. the inline manager notice when a previously loaded manager loses access.

It does not appear for ended or deleted events, retryable transport failures,
guest failures, or ordinary manager pages. It is not added to the landing page.
The token-free `/recover/manage` page also uses the same component when an
existing management-link exchange redirects there with a recoverable failure.

### Failure model

Move the existing `LoadFailureKind` and API-code classification table into a
small shared module used by the client and Worker. Expose the resulting kind on
`LoadFailure` instead of discarding it after selecting recovery prose, and
carry that kind into manager notices. Rendering and exchange redirects use the
shared kind, never message text, to decide whether management-link recovery is
available.

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
cookies and redirects to `/manage/event/:eventId`.

Add `/recover/manage` to the React router. It reads only the allow-listed
failure kind. `latest-link` and `retry` render an in-app explanation plus the
management-link recovery form; `ended-event` renders the existing terminal
event guidance without the form. An absent or unrecognized kind falls back to
`latest-link`, ensuring a malformed recovery URL remains recoverable.

Because `/recover/manage` does not begin with `/manage/`, it does not collide
with the Worker exchange matcher. Add the exact path to
`assets.run_worker_first`; the Worker `notFound` handler then serves the SPA
shell through `ASSETS` with the same security middleware as the other clean
client routes. The route remains inside the root manifest scope.

### Recovery component

Add a reusable `ManagementLinkRecovery` component and a pure management-link
parser.

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
exchange sets cookies in the installed app's own cookie jar and redirects to
the token-free event manager. If the structurally valid token is stale, wrong,
or truncated in a way the server alone can detect, the navigation-only exchange
handling redirects to `/recover/manage` rather than rendering JSON. The host
therefore retains the form and can paste another link.

The component does not:

- persist the link or token;
- place it in local or session storage;
- send it to analytics or logs;
- accept another origin;
- change link or session expiry;
- introduce a new API endpoint;
- leave a failed bearer URL as the standalone app's current document.

## Navigation and known platform behavior

- Launching the icon returns to the installing route because `start_url` is
  absent.
- Root-scoped Candidary navigation remains inside the standalone app.
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
  accessible name for the form.
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
- the shared classifier and `describeLoadFailure` expose the same stable kind;
- `latest-link` manager failures show the recovery form;
- ordinary manager ended-event and retry failures do not show it;
- the dedicated exchange-recovery page shows the form for `latest-link` and
  `retry`, but not `ended-event`;
- absent or unrecognized recovery-page kinds fall back to `latest-link`;
- invalid submissions show and focus the validation error; and
- guest failure surfaces do not gain manager recovery.

Worker tests verify:

- a valid management-link exchange still sets cookies and redirects to the
  token-free event manager;
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

Browser tests verify:

- the manager document exposes the manifest metadata without a visible install
  prompt;
- a full-page expired manager can submit a valid management link;
- an inline expired-session notice can submit the same recovery;
- recovery requests the existing `/manage/:token` path and follows its
  token-free redirect;
- a structurally valid but stale link returns to the in-app recovery form
  instead of a JSON document;
- a malformed token shape remains in the client-side form with a focused
  validation error; and
- the manager route remains within the root manifest scope.

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
Before claiming physical-device readiness, use a current iPhone against a
staging or controlled-production event and verify:

1. open a valid management link and reach `/manage/event/:eventId`;
2. add that page to the Home Screen;
3. confirm the Candidary icon and editable label;
4. launch it and confirm standalone mode;
5. confirm it opens the exact event manager rather than `/`;
6. move among Intake, Gallery, Notes, Share, Settings, and the Candidary brand
   without unexpectedly opening Safari;
7. expire the manager session in the controlled environment, relaunch, paste
   the saved management link, and return to the same token-free manager;
8. paste a malformed link and a structurally valid stale or rotated link, then
   confirm both failures leave a usable in-app recovery form from which a valid
   link can reopen the manager, and confirm back navigation reveals neither the
   bearer URL nor a JSON document;
9. request an export and confirm each presigned cross-origin download opens
   outside the standalone app without losing the installed manager; and
10. confirm no install promotion appears inside Candidary.

## Deployment and operational boundaries

This feature adds no migration, binding, server endpoint, API contract, token
change, or retention change. It adds one client route and changes top-level
error rendering on the existing management-link exchange route. Deployment
still uses the repository's normal release gates.

A deployed verification must check the live manifest, icon responses, content
type, security headers, and manager route. Source and preview verification do
not by themselves prove iOS installation behavior. Physical-iPhone acceptance
remains a separate release claim.

## Acceptance criteria

- Candidary contains no visible Add to Home Screen prompt.
- The manifest and Apple metadata create an iOS standalone web-app
  configuration with reviewed Candidary artwork.
- Installing from a manager event preserves that exact event URL.
- Root-scoped navigation stays inside the standalone app.
- A host with a missing, expired, forbidden, or revoked manager session can
  paste a valid same-origin management link inside the app and re-enter through
  the existing exchange route.
- Malformed links remain in the form, and structurally valid but invalid or
  revoked links return to a token-free in-app recovery page rather than a JSON
  document.
- Expired or deleted events return to token-free terminal guidance without
  offering recovery that cannot work.
- Recovery never stores, logs, or submits the management secret anywhere except
  the existing same-origin exchange path.
- `Referrer-Policy: no-referrer` remains enforced on static and Worker
  responses.
- Session and management-link lifetimes remain unchanged.
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

# Security model

## Authorization boundary

A host reaches an event by either of two credentials, and every host-only route resolves both through one function (`worker/auth/manager.ts`). A management link resolves to a session carrying its own event, which must match the requested one. A signed-in account resolves to a session carrying no event; the event comes from the request path and is granted only when `event_hosts` records the membership, and the event's own management window is re-checked because an account session outlives any single event. A browser may hold both at once in separate cookie pairs, and the account is preferred when it does.

Every event-scoped request resolves an HttpOnly session, loads its current access token and event, then compares the authenticated event and role with the requested resource. Route identifiers never grant access. Media reads re-check upload and publication state on every request, so hidden or deleted bytes stop being readable immediately. Originals are manager-only; a guest may read a preview only for their own upload or for a published photo in a visible gallery.

Access links contain a random token ID and 256-bit secret. D1 stores keyed HMAC digests, not raw secrets. The guest secret is additionally stored as AES-256-GCM ciphertext so an authenticated manager can redisplay the current share link; the one-time management secret is not recoverable. Rotating a role revokes both its tokens and sessions.

## Host accounts

Registration does not create an account. `POST /api/host/register` reserves rate-limit capacity, hashes the proposed password, and stores a short-lived `host_registration_challenges` row holding the normalized address, the proposed hash, digests of an opaque browser secret and the emailed code, and — only when the request held that event's live management session — the event to bind and the exact session authorizing that claim. No account, membership, or host session exists until `POST /api/host/register/complete` proves both the browser secret and the mailbox code. Completion re-resolves that same creator session live, so rotation, expiry, or a different browser cannot replay a pending claim.

Completing a challenge for an address that already has an account neither duplicates it nor changes its password, display name, or authentication version; the verified code acts as passwordless recovery for that one request. Pending registration has its own resend endpoint authenticated by the registration cookie, distinct from the host-session verification flow an existing account uses.

For creator ownership, eligibility ends at the earlier of the event's management deadline and 12 hours after creation. The browser's registration URL may remember a pending code-entry screen and a validated local return path, but it is only a presentation hint: the server's live creator session and the completion result remain the authority for event attachment.

Password authority is versioned. `host_accounts.auth_version` starts at 1 and every host session records the version it authenticated against; resolution requires the two to match. A reset increments the version, changes the password, verifies the address, and revokes existing host sessions in one D1 batch, so a login that authenticated with the old password cannot mint a session afterwards. Opportunistic rehash is a compare-and-swap on the previous hash and version, so it can upgrade a hash's cost without resurrecting a superseded password.

Registration, sign-in, verification resend, and password-reset requests reserve fixed-window capacity in `host_auth_rate_limits` before any scrypt or mail work, through one atomic UPSERT per scope. Scopes are HMAC digests keyed with `LOGIN_HMAC_KEY` and domain-separated as `rate-limit:<action>:<scope-kind>:<normalized-value>`. The client IP comes from `CF-Connecting-IP`; a missing header shares one `unknown` scope rather than trusting a client-supplied alternative. Exhaustion returns the same `429 RATE_LIMITED` body for new and existing addresses.

Durable ownership is deliberately narrow. A partial unique index permits one `owner` row per event. For events created after migration 0006 only the creator session may claim that owner; every later management-link exchange is marked ineligible. Events that predate 0006 carry no creator provenance, so each gets exactly one legacy first-owner claim through a live management credential, and a successful claim closes that path in the same batch that inserts the owner. An existing non-owner membership never authorizes promotion, and this release adds no cohost invitation or removal.

Passwords are hashed with scrypt from `node:crypto` at N=32768, r=8, p=3 — an OWASP-listed parameter set chosen because scrypt needs roughly `128 * N * r` bytes and the larger sets exceed the 128 MiB isolate. WebCrypto PBKDF2 is deliberately not used: workerd caps it at 100,000 iterations. The stored value is self-describing (`scrypt$N$r$p$salt$hash`), verification refuses parameters that would exhaust the isolate, and a successful sign-in rehashes anything below the current cost.

Registration and password-reset requests answer identically whether or not the address is registered — same status, same body, same cookie name and attributes — and sign-in runs the same scrypt work for an unknown address so timing does not disclose one. Forgotten-password performs its lookup and both rate-limit reservations for every address, returns immediately, and tracks the challenge and mail through `ExecutionContext.waitUntil()`, so a known account does not hold the response open while an unknown one returns at once. Reset completion answers unknown, missing, expired, and consumed challenges with the same `LOGIN_CODE_INVALID`. A taken address is told only in the inbox that owns it. Emailed six-digit codes are stored as keyed digests, expire in 15 minutes, are single-use, are superseded when a new one is requested, and are capped at five attempts spent atomically before the digest is compared — the attempt cap, not the code width, is the defense. Resetting a password revokes every session for the account.

Confirming an address gates notifications only, never access; a bounced confirmation must not lock a host out of their own event. The management link remains a valid credential in its own right, so a planner or coordinator can be given access without an account.

## Browser controls

- Session cookie: `HttpOnly`, `Secure`, `SameSite=Lax`, path `/`.
- CSRF cookie: `Secure`, `SameSite=Strict`; writes require a matching HMAC-verified header and allowed origin.
- Account sessions use a second, independent cookie pair (`candidary_host`, `candidary_host_csrf`) with the same flags and their own CSRF header, so the two credentials cannot authorize each other's writes.
- Token exchange redirects immediately to token-free `/event/:slug` or `/manage/event/:eventId` routes.
- Content responses are `private, no-store` and include `X-Content-Type-Options: nosniff`.
- The Worker applies a restrictive content security policy, no-referrer policy, and stable request IDs.
- HTTPS is pinned for a year including subdomains: `Strict-Transport-Security: max-age=31536000; includeSubDomains`. No credential here has a second factor behind it — an access link carries its secret in the URL, and a session cookie is the whole authorization story — so a first request must never reach plain HTTP. The Worker sends the header only on HTTPS requests, as RFC 6797 requires; `public/_headers` has no scheme predicate, which is harmless because a browser ignores the header over plain HTTP. `preload` is deliberately omitted — the browser preload list is not practically reversible, so joining it is a separate decision, not a side effect of this control.
- Permanent R2 URLs are never public. PUT URLs are object-specific, MIME-bound, and valid for ten minutes; export GET URLs are manager-only and valid for fifteen minutes.

## Upload defenses

The API accepts JPEG, PNG, WebP, HEIC, and HEIF originals up to 20 MB, 10,000 media rows per event, and 100 GiB stored per event. `shared/constants.ts` is the single source of truth for these values; the authoritative quota guard is in the reservation SQL itself, so concurrent reservations cannot oversubscribe an event. The cap counts reserved plus stored rows, so in-flight reservations hold quota until they finalize or expire. Initiation reserves counters atomically and is idempotent per guest session. A phone may present a `.heic` or `.heif` file with an empty, vendor-specific, or `application/octet-stream` type, so reservation resolves the type from the extension only provisionally and finalization confirms it by container inspection. Finalization checks R2 size, content type, file signature, and dimensions before making the row visible. Invalid objects are deleted and reservations released. Abandoned reservations expire after fifteen minutes.

## Data lifecycle

Event dates anchor immutable access and purge timestamps. Explicit deletion atomically marks the event inaccessible and revokes tokens/sessions before R2 cleanup. The daily scheduled handler uses the same deny-first behavior for retention purges. Export snapshots include every stored, non-deleted original as of their recorded snapshot, regardless of publication status.

## Operational launch requirements

- Rate limit and Turnstile-protect public event creation before open signup.
- Scope R2 credentials to one bucket; keep all secrets in Worker secret bindings.
- Monitor repeated validation, authorization, quota, and export failures by stable error code and request ID.
- Treat management links as bearer credentials. An event with no account bound to it still has no recovery path.
- Rate limit and Turnstile-protect registration, sign-in, and password-reset requests alongside event creation.
- Outbound mail requires a domain onboarded to Cloudflare Email Service and the Workers Paid plan; sends to arbitrary recipients fail without both.
- Run dependency, secret, and configuration review before every production release.

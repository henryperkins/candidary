# Security model

## Authorization boundary

A host reaches an event by either of two credentials, and every host-only route resolves both through one function (`worker/auth/manager.ts`). A management link resolves to a session carrying its own event, which must match the requested one. A signed-in account resolves to a session carrying no event; the event comes from the request path and is granted only when `event_hosts` records the membership, and the event's own management window is re-checked because an account session outlives any single event. A browser may hold both at once in separate cookie pairs, and the account is preferred when it does.

Every event-scoped request resolves an HttpOnly session, loads its current access token and event, then compares the authenticated event and role with the requested resource. Route identifiers never grant access. Media reads re-check upload and publication state on every request, so hidden or deleted bytes stop being readable immediately. Originals are manager-only; a guest may read a preview only for their own upload or for a published photo in a visible gallery.

Access links contain a random token ID and 256-bit secret. D1 stores keyed HMAC digests, not raw secrets. The guest secret is additionally stored as AES-256-GCM ciphertext so an authenticated manager can redisplay the current share link; the one-time management secret is not recoverable. Rotating a role revokes both its tokens and sessions.

## Event cover delivery

Cover configuration is public presentation, but cover storage identity is private. Manager event JSON
contains one nested `cover` object with exactly `config`, `revision`, `hasCover`,
`available2xProfiles`, `surfaceTreatment`, and the sanitized `preparation`; the guest projection
contains only `revision`, `hasCover`, `available2xProfiles`, and `surfaceTreatment`. Neither response
contains an R2 key, normalized-master or render-set ID, draft ID, publication receipt ID, Workflow ID,
private URL, recipe, or manifest. A projection that cannot prove the stored semantic config and active
inventory agree emits one identifier-free invariant reason and returns a generic failure rather than
guessing a safe-looking view.

Guests and Managers fetch bytes only through these same-origin allowlisted shapes:

```text
GET /api/event/:slug/cover/:revision/:profile/:density.:format
GET /api/manage/events/:eventId/cover/:revision/:profile/:density.:format
```

Each request resolves current authorization and the current event again. The guest route requires the
authenticated event slug; the Manager route uses the ordinary manager-link/account boundary. Both
require an exact non-negative current revision and registered profile, density, and format. An uploaded
cover additionally requires the event's exact active render set, its published revision, an event-owned
object key, and the expected content type before the one read-only R2 `GET`. The response is always
`private, no-store` with `X-Content-Type-Options: nosniff`. Presets return a `307` carrying the same
private/no-store boundary to a versioned, event-free static asset path; the static prefix alone carries
`Cache-Control: public, max-age=31536000, immutable`.

The revisionless guest and Manager readers do not exist. Stale/future revisions, `none`, missing or
retired slots, cross-event sets, wrong audiences, and missing objects fail closed. Delivery never reads
or returns a normalized master or legacy object, never invokes Images, and never falls back to another
revision, profile, density, or format. The browser may try current WebP and then current JPEG; if both
fail it removes the image, emits one sanitized `(audience, profile, revision)` observation, and requests
at most one event-view refresh for that slot. It does not expose the failed URL or storage state.

Publication recovery follows the same no-key rule. One Manager-level controller retains only the
event-scoped operation ID needed to re-read the server-selected sanitized receipt; closing Cover Studio,
a dropped response, a hidden tab, or temporary access loss does not mint a second operation. Receipt
views expose bounded status/progress/failure codes and no platform or storage identity. Server and
cleanup observations are closed low-cardinality codes without raw Cloudflare errors, Workflow IDs,
object keys, event IDs, or private image data.

## The printed event entry

A guest reaches an event only by scanning the code printed on the invitation, and that code must not change for the life of the event. `event_entry_credentials` holds one permanent `id.secret` per event, digested with `ENTRY_HMAC_KEY` and additionally stored as AES-256-GCM ciphertext under `ENTRY_ENCRYPTION_KEY` so a manager can redisplay it.

The QR encodes `/join#<id.secret>`. A URL fragment is never placed in a request line, a `Referer` header, an access log, or a proxy record, so the credential does not reach the Worker through the URL at all. `EventEntryPage` reads it once into a local variable, erases it with `history.replaceState` before any network call, and sends it in a same-origin `POST /api/entry/exchange` body. After that the credential exists nowhere in the browser: not in React state, not in history, not in a log line, and not on the page. A missing, malformed, or refused credential lands on one token-free recovery page that says the same thing in every case, because distinguishing them would tell a stranger which guess was closest.

The exchange mints an ordinary guest event session against the event's *internal* guest access token, which is a separate credential the browser never sees. That internal grant can be replaced whenever a host wants to sign guest devices out — `POST /api/manage/events/:eventId/guest-sessions/rotate`, confirmed by the exact event name — and the printed URL is byte-identical afterwards.

### Codes printed before migration 0008

Events created before 0008 carry a QR encoding `/join/<id>.<secret>`, where the token is the event's guest access token. A code already printed on a sign or an invitation cannot be recalled, so that path still resolves — for those events only.

On first use the printed token is *adopted*: its secret is decrypted under `GUEST_TOKEN_ENCRYPTION_KEY` (it was stored recoverably so a host could redisplay the share link), re-digested under `ENTRY_HMAC_KEY`, re-encrypted under `ENTRY_ENCRYPTION_KEY`, and written to `event_entry_credentials` under the same id. The printed string is then the entry credential itself, and the exchange runs through exactly the same `exchangeEntry` as the fragment form. Because it is its own row rather than a pointer at the guest grant, signing guest devices out replaces the internal grant and leaves the printed code working — the same guarantee a post-0008 event gets — while disabling the entry stops it.

Two limits keep this from widening the attack surface:

- **The path form is closed to everything issued since.** An adopted credential's id is also an `event_access_tokens` row id, and revoking a token leaves that row behind, so the fact is durable. A credential minted after 0008 has a fresh random id with no token behind it and is refused on this path even when otherwise valid.
- **Adoption requires possession.** The unauthenticated scan path verifies the supplied secret against the stored guest-token digest before writing anything, so a caller who does not already hold guest access cannot cause a credential to be created.

The trade-off is stated plainly: a path carries the secret in the request line, so it reaches access logs and any outbound `Referer` in a way the fragment form does not. That exposure is inherent to codes that were already printed in this shape; it is not extended to anything issued afterwards.

Disabling the printed entry is irreversible in v1. `POST /api/manage/events/:eventId/entry/disable` sets `disabled_at`, pauses uploads and RSVP, and revokes active guest sessions and every household RSVP session in one batch. Manager and host-account sessions are untouched. There is no replacement and no re-enable, because a code that has been printed on paper cannot be recalled; every settings path that would reopen uploads or RSVP re-reads `disabled_at` inside its guarded write, so manager authority cannot bypass the state.

## Household RSVP

RSVP is a third authority, independent of both the event guest session and the host account. A household proves itself by typing a full name exactly as printed on its invitation. The normalizer is version 1 and immutable for this release: NFKC, trim, collapse Unicode whitespace, curly apostrophes to `'`, Unicode dashes to `-`, lowercase without locale rules, diacritics and all other punctuation preserved. `José` and `Jose` are therefore different people. D1 stores only `HMAC(RSVP_LOOKUP_HMAC_KEY, "rsvp-name:v1:<eventId>:<normalized>")`, so the invitee table cannot be read back into a list of submitted names.

This is knowledge-based access, and its limitation is stated plainly: anyone who knows an invited guest's exact full name can open that household's response. It is bounded by never disclosing the list and by two independent abuse controls, not by secrecy of the names themselves.

- The Cloudflare rate binding `RSVP_LOOKUP_RATE_LIMIT` refuses more than 30 attempts per IP per minute, applied before any body parse or D1 read, with `Retry-After: 60`.
- D1 defense-in-depth then charges 20 attempts per event/IP and 8 attempts per event/normalized-name in a fixed 15-minute bucket, with `Retry-After: 900`. A two-name request charges the IP once and each supplied name once. Both scopes are stored as domain-separated HMAC digests; the table holds no address and no name.
- The client IP is read only from `CF-Connecting-IP` (`worker/http/client-ip.ts`). `X-Forwarded-For` and `Forwarded` are ignored, and a missing header shares one literal `unknown` scope. Host authentication uses the same helper.

A first name matching more than one household returns only `second_name_required` — never a count, a candidate, or a label. Misses, paused RSVP, archived households, unresolved second names, and closed events with nothing saved all return one identical `not_available` body. A roster whose collisions cannot be resolved by any second name blocks RSVP activation instead of quietly making some households unreachable.

Success sets `candidary_rsvp` and `candidary_rsvp_csrf`. That pair authorizes only that household's read and write; it cannot authorize an upload, a host write, or another household, and neither of the other CSRF pairs can authorize an RSVP write. The session captures the event's deadline at the moment it was issued, and every write enforces the *earlier* of that captured deadline and the event's current one — shortening a deadline takes effect immediately, while an extension requires a fresh exact lookup.

Every successful `(household, idempotencyKey)` is retained in `rsvp_submission_receipts` with the canonical payload digest and committed version until the event is purged. Replaying a successful key with the same payload returns success, so a household whose response was lost in transit can safely retry; reusing it with different content is refused. Receipts are not a host-visible revision history and never appear in a manager list or an export.

No raw credential, ciphertext, submitted name, RSVP body, or CSV row is ever logged. Import failures are reported by row number, field, and code — never by content.

## Host accounts

Registration does not create an account. `POST /api/host/register` reserves rate-limit capacity, hashes the proposed password, and stores a short-lived `host_registration_challenges` row holding the normalized address, the proposed hash, digests of an opaque browser secret and the emailed code, and — only when the request held that event's live management session — the event to bind and the exact session authorizing that claim. No account, membership, or host session exists until `POST /api/host/register/complete` proves both the browser secret and the mailbox code. Completion re-resolves that same creator session live, so rotation, expiry, or a different browser cannot replay a pending claim.

Completing a challenge for an address that already has an account neither duplicates it nor changes its password, display name, or authentication version; the verified code acts as passwordless recovery for that one request. Pending registration has its own resend endpoint authenticated by the registration cookie, distinct from the host-session verification flow an existing account uses.

For creator ownership, eligibility ends at the earlier of the event's management deadline and 12 hours after creation. The browser's registration URL may remember a pending code-entry screen and a validated local return path, but it is only a presentation hint: the server's live creator session and the completion result remain the authority for event attachment.

Password authority is versioned. `host_accounts.auth_version` starts at 1 and every host session records the version it authenticated against; resolution requires the two to match. A reset increments the version, changes the password, verifies the address, and revokes existing host sessions in one D1 batch, so a login that authenticated with the old password cannot mint a session afterwards. Opportunistic rehash is a compare-and-swap on the previous hash and version, so it can upgrade a hash's cost without resurrecting a superseded password.

New registrations and password resets enforce the current 15-character minimum. Sign-in deliberately
does not reuse that creation-time floor: it accepts an otherwise valid shorter legacy password so an
existing host is not locked out after the policy rises, and opportunistically upgrades the stored
hash when its encoded cost is below the current parameters.

Registration, sign-in, verification resend, and password-reset requests reserve fixed-window capacity in `host_auth_rate_limits` before any scrypt or mail work, through one atomic UPSERT per scope. Scopes are HMAC digests keyed with `LOGIN_HMAC_KEY` and domain-separated as `rate-limit:<action>:<scope-kind>:<normalized-value>`. The client IP comes from `CF-Connecting-IP`; a missing header shares one `unknown` scope rather than trusting a client-supplied alternative. Exhaustion returns the same `429 RATE_LIMITED` body for new and existing addresses.

Durable ownership is deliberately narrow. A partial unique index permits one `owner` row per event. For events created after migration 0006 only the creator session may claim that owner; every later management-link exchange is marked ineligible. Events that predate 0006 carry no creator provenance, so each gets exactly one legacy first-owner claim through a live management credential, and a successful claim closes that path in the same batch that inserts the owner. An existing non-owner membership never authorizes promotion, and this release adds no cohost invitation or removal.

Passwords are hashed with scrypt from `node:crypto` at N=32768, r=8, p=3 — an OWASP-listed parameter set chosen because scrypt needs roughly `128 * N * r` bytes and the larger sets exceed the 128 MiB isolate. WebCrypto PBKDF2 is deliberately not used: workerd caps it at 100,000 iterations. The stored value is self-describing (`scrypt$N$r$p$salt$hash`), verification refuses parameters that would exhaust the isolate, and a successful sign-in rehashes anything below the current cost.

Registration and password-reset requests answer identically whether or not the address is registered — same status, same body, same cookie name and attributes — and sign-in runs the same scrypt work for an unknown address so timing does not disclose one. Forgotten-password performs its lookup and both rate-limit reservations for every address, returns immediately, and tracks the challenge and mail through `ExecutionContext.waitUntil()`, so a known account does not hold the response open while an unknown one returns at once. Reset completion answers unknown, missing, expired, and consumed challenges with the same `LOGIN_CODE_INVALID`. A taken address is told only in the inbox that owns it. Emailed six-digit codes are stored as keyed digests, expire in 15 minutes, are single-use, are superseded when a new one is requested, and are capped at five attempts spent atomically before the digest is compared — the attempt cap, not the code width, is the defense. Resetting a password revokes every session for the account.

Confirming an address gates notifications only, never access; a bounced confirmation must not lock a host out of their own event. The management link remains a valid credential in its own right, so a planner or coordinator can be given access without an account.

## Browser controls

- Session cookie: `HttpOnly`, `Secure`, `SameSite=Lax`, path `/`.
- CSRF cookie: `Secure`, `SameSite=Strict`; writes require a matching HMAC-verified header and allowed origin.
- Account sessions use a second, independent cookie pair (`candidary_host`, `candidary_host_csrf`) with the same flags and their own CSRF header, so the two credentials cannot authorize each other's writes.
- Household RSVP uses a third independent pair (`candidary_rsvp`, `candidary_rsvp_csrf`) with the same flags and the `X-Candidary-RSVP-CSRF` header. All three may coexist in one browser, and each route validates only the credential it accepts.
- The printed entry is exchanged in a same-origin POST body, never a URL; the join shell removes the fragment before the request. Management-link exchange redirects immediately to a token-free `/manage/event/:eventId` route.
- Content responses are `private, no-store` and include `X-Content-Type-Options: nosniff`.
- The Worker applies a restrictive content security policy, no-referrer policy, and stable request IDs.
- HTTPS is pinned for a year including subdomains: `Strict-Transport-Security: max-age=31536000; includeSubDomains`. No credential here has a second factor behind it — an access link carries its secret in the URL, and a session cookie is the whole authorization story. Cloudflare **Always Use HTTPS** keeps a first plain-HTTP navigation out of the Worker; after a browser receives the policy, HSTS upgrades later requests before sending them. Because `preload` is deliberately omitted, HSTS alone does not protect a browser's first-ever request to the host. The Worker sends the header only on HTTPS requests, as RFC 6797 requires; `public/_headers` has no scheme predicate, which is harmless because a browser ignores the header over plain HTTP. The preload list is not practically reversible, so joining it remains a separate decision rather than a side effect of this control.
- Permanent R2 URLs are never public. PUT URLs are object-specific, MIME-bound, and valid for ten minutes; export GET URLs are manager-only and valid for fifteen minutes.

## Upload defenses

The API accepts JPEG, PNG, WebP, HEIC, and HEIF originals up to 20 MB, 10,000 media rows per event, and 100 GiB stored per event. `shared/constants.ts` is the single source of truth for these values; the authoritative quota guard is in the reservation SQL itself, so concurrent reservations cannot oversubscribe an event. The cap counts reserved plus stored rows, so in-flight reservations hold quota until they finalize or expire. Initiation reserves counters atomically and is idempotent per guest session. A phone may present a `.heic` or `.heif` file with an empty, vendor-specific, or `application/octet-stream` type, so reservation resolves the type from the extension only provisionally and finalization confirms it by container inspection. Finalization checks R2 size, content type, file signature, and dimensions before making the row visible. Invalid objects are deleted and reservations released. Abandoned reservations expire after fifteen minutes.

## Export safety

Every cell in every generated CSV passes through `csvCell()` in `shared/csv.ts`. A cell whose first non-whitespace character is `=`, `+`, `-`, or `@` gains a leading apostrophe, so a guest-supplied name, filename, caption, or household label cannot become a formula when the host opens the file in a spreadsheet. Ordinary cells are byte-for-byte unchanged. This applies to the media CSV and manifest as well as the RSVP export; both keep backward-output regression coverage.

## Key rotation limits

`TOKEN_HMAC_KEY`, `SESSION_HMAC_KEY`, and `LOGIN_HMAC_KEY` protect credentials that can be reissued, so rotating one costs an ordinary sign-out. Four keys are different in kind, because they protect data already written down:

- `ENTRY_HMAC_KEY` digests the credential printed on every invitation. Rotating it without re-digesting `event_entry_credentials` makes every printed QR stop working.
- `ENTRY_ENCRYPTION_KEY` encrypts the same credential for redisplay. Rotating it without re-encrypting makes the share link unrecoverable, though the printed code keeps working.
- `RSVP_LOOKUP_HMAC_KEY` keys every stored name digest and every rate-limit scope. Rotating it without recomputing `rsvp_invitees.lookup_digest` makes every household unreachable by lookup.
- `GUEST_MESSAGE_HMAC_KEY` domain-separates Guestbook session/IP window digests and durable request HMACs in purge receipts. Receipts survive ordinary deletion until event purge, so rotation requires a coordinated re-HMAC migration or an explicit receipt-invalidation decision.

Rotating an internal guest grant or a management link is a routine operation and must never touch these four keys.

## Data lifecycle

Event dates anchor immutable access and purge timestamps. Explicit deletion first marks the event inaccessible, revokes guest, session, and household RSVP credentials, and disables the printed entry; it then removes the event's R2 prefix and Guestbook export objects, and only afterwards deletes `media`, `guest_messages`, Guestbook snapshot/receipt rows, and the event so the remaining cascades run. Guestbook rate events are bounded scratch; purge receipts retain only the minimum non-content idempotency tuple until event purge and are never exposed over HTTP. If object deletion fails, the event stays soft-deleted so a later scheduled pass retries it. Ready Guestbook HTML and private CSV inherit the export's 24-hour object expiry, while immutable snapshot rows remain for an authorized retry.

Archiving a household is irreversible in v1. It revokes that household's RSVP sessions, removes it from lookup and from active totals, and keeps its marked rows in the host list and CSV export until the event is purged.

## Operational launch requirements

- Rate limit and Turnstile-protect public event creation before open signup.
- Scope R2 credentials to one bucket; keep all secrets in Worker secret bindings.
- Monitor repeated validation, authorization, quota, and export failures by stable error code and request ID.
- Treat management links as bearer credentials. An event with no account bound to it still has no recovery path.
- Rate limit and Turnstile-protect registration, sign-in, and password-reset requests alongside event creation.
- Verify the `RSVP_LOOKUP_RATE_LIMIT` binding and its 30-per-minute rule before an event goes live; the D1 budgets are defense in depth, not a replacement for it.
- Verify `GUEST_MESSAGE_RATE_LIMIT` uses its isolated target namespace and 120-per-60-second rule; never reuse the host-auth or RSVP counter.
- Review live logs after deployment and confirm that no line carries a raw credential, ciphertext, submitted name, RSVP body, or CSV row.
- Outbound mail requires a domain onboarded to Cloudflare Email Service and the Workers Paid plan; sends to arbitrary recipients fail without both.
- Run dependency, secret, and configuration review before every production release.

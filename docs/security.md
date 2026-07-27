# Security model

## Authorization boundary

Every event-scoped request resolves an HttpOnly session, loads its current access token and event, then compares the authenticated event and role with the requested resource. Route identifiers never grant access. Media reads re-check upload and publication state on every request, so hidden or deleted bytes stop being readable immediately. Originals are manager-only; a guest may read a preview only for their own upload or for a published photo in a visible gallery.

Access links contain a random token ID and 256-bit secret. D1 stores keyed HMAC digests, not raw secrets. The guest secret is additionally stored as AES-256-GCM ciphertext so an authenticated manager can redisplay the current share link; the one-time management secret is not recoverable. Rotating a role revokes both its tokens and sessions.

## Browser controls

- Session cookie: `HttpOnly`, `Secure`, `SameSite=Lax`, path `/`.
- CSRF cookie: `Secure`, `SameSite=Strict`; writes require a matching HMAC-verified header and allowed origin.
- Token exchange redirects immediately to token-free `/event/:slug` or `/manage/event/:eventId` routes.
- Content responses are `private, no-store` and include `X-Content-Type-Options: nosniff`.
- The Worker applies a restrictive content security policy, no-referrer policy, and stable request IDs.
- Permanent R2 URLs are never public. PUT URLs are object-specific, MIME-bound, and valid for ten minutes; export GET URLs are manager-only and valid for fifteen minutes.

## Upload defenses

The API accepts JPEG, PNG, WebP, HEIC, and HEIF originals up to 20 MB, 10,000 media rows per event, and 100 GiB stored per event. `shared/constants.ts` is the single source of truth for these values; the authoritative quota guard is in the reservation SQL itself, so concurrent reservations cannot oversubscribe an event. The cap counts reserved plus stored rows, so in-flight reservations hold quota until they finalize or expire. Initiation reserves counters atomically and is idempotent per guest session. A phone may present a `.heic` or `.heif` file with an empty, vendor-specific, or `application/octet-stream` type, so reservation resolves the type from the extension only provisionally and finalization confirms it by container inspection. Finalization checks R2 size, content type, file signature, and dimensions before making the row visible. Invalid objects are deleted and reservations released. Abandoned reservations expire after fifteen minutes.

## Data lifecycle

Event dates anchor immutable access and purge timestamps. Explicit deletion atomically marks the event inaccessible and revokes tokens/sessions before R2 cleanup. The daily scheduled handler uses the same deny-first behavior for retention purges. Export snapshots include every stored, non-deleted original as of their recorded snapshot, regardless of publication status.

## Operational launch requirements

- Rate limit and Turnstile-protect public event creation before open signup.
- Scope R2 credentials to one bucket; keep all secrets in Worker secret bindings.
- Monitor repeated validation, authorization, quota, and export failures by stable error code and request ID.
- Treat management links as bearer credentials. Candidary Core has no account recovery.
- Run dependency, secret, and configuration review before every production release.

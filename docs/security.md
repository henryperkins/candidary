# Security model

## Authorization boundary

Every event-scoped request resolves an HttpOnly session, loads its current access token and event, then compares the authenticated event and role with the requested resource. Route identifiers never grant access. Media reads re-check upload and moderation state on every request, so rejected or deleted bytes stop being readable immediately.

Access links contain a random token ID and 256-bit secret. D1 stores keyed HMAC digests, not raw secrets. The guest secret is additionally stored as AES-256-GCM ciphertext so an authenticated manager can redisplay the current share link; the one-time management secret is not recoverable. Rotating a role revokes both its tokens and sessions.

## Browser controls

- Session cookie: `HttpOnly`, `Secure`, `SameSite=Lax`, path `/`.
- CSRF cookie: `Secure`, `SameSite=Strict`; writes require a matching HMAC-verified header and allowed origin.
- Token exchange redirects immediately to token-free `/event/:slug` or `/manage/event/:eventId` routes.
- Content responses are `private, no-store` and include `X-Content-Type-Options: nosniff`.
- The Worker applies a restrictive content security policy, no-referrer policy, and stable request IDs.
- Permanent R2 URLs are never public. PUT URLs are object-specific, MIME-bound, and valid for ten minutes; export GET URLs are manager-only and valid for fifteen minutes.

## Upload defenses

The API accepts JPEG, PNG, and WebP originals up to 10 MB, 50 media rows per event, and 300 MB stored per event. Initiation reserves counters atomically and is idempotent per guest session. Finalization checks R2 size, content type, file signature, and dimensions before making the row visible. Invalid objects are deleted and reservations released. Abandoned reservations expire after fifteen minutes.

## Data lifecycle

Event dates anchor immutable access and purge timestamps. Explicit deletion atomically marks the event inaccessible and revokes tokens/sessions before R2 cleanup. The daily scheduled handler uses the same deny-first behavior for retention purges. Export snapshots include only approved, stored, non-deleted media as of their recorded snapshot.

## Operational launch requirements

- Rate limit and Turnstile-protect public event creation before open signup.
- Scope R2 credentials to one bucket; keep all secrets in Worker secret bindings.
- Monitor repeated validation, authorization, quota, and export failures by stable error code and request ID.
- Treat management links as bearer credentials. Candidary Core has no account recovery.
- Run dependency, secret, and configuration review before every production release.

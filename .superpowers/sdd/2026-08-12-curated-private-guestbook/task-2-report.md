# Task 2 report: privacy-correct projection repository and versioned cursors

Status: complete

Implementation commit: `25ef2f3` (`feat: add privacy-safe guestbook projections`)

No push, deployment, remote migration, paid provider call, or remote-state mutation was performed.

## Files

Task 2 implementation and tests:

- `worker/db/guestbook.ts` — allowlisted unified guest/Manager projections, bounded keyset pages, Manager summary/views, point projections, and immutable export-entry snapshot statement.
- `worker/http/guestbook-cursor.ts` — strict version-2 guest and Manager cursors bound to their authorized stream/event/session or view/event/source context.
- `worker/db/messages.ts` — safe Manager note projection, gallery-aware legacy caption privacy, whitespace-caption exclusion, and explicit version-1 continuation metadata.
- `worker/http/message-cursor.ts` — marks decoded legacy cursor chains as version 1 while retaining the exact legacy `{ createdAt, id }` encoded wire shape.
- `worker/routes/messages.ts` — `contract=2` split streams, exact-one-cursor advancement, bound cursor validation, safe POST/Manager note responses, legacy compatibility, and Manager guestbook list/summary routes.
- `worker/db/media.ts` — explicit `ManagerMediaView` serializer and allowlisted Manager media query/page.
- `worker/routes/manage.ts` — allowlisted Manager media mutation response with the qualifying caption item projection.
- `tests/worker/guestbook-repository.test.ts` — projection, ordering, privacy, pagination, Manager view/summary, source filtering, allowlist, point lookup, and export-snapshot tests.
- `tests/worker/messages-api.test.ts` — split-stream API, cursor binding, legacy version-1 continuation, legacy gallery-off privacy, Manager four-view API, and raw-field non-disclosure tests.
- `tests/worker/manage-api.test.ts` — Manager media list/mutation allowlist and caption item test.
- `tests/unit/guestbook-cursor.test.ts` — strict version/binding/malformed cursor and legacy version-1 unit coverage.

Controller-authorized cross-task contract corrections:

- `shared/contracts.ts` — added the approved `ManagerMediaView` contract and modeled caption aliases by both source state and effective visibility so gallery-suppressed published captions fail closed to legacy clients.
- `tests/unit/guestbook-contracts.test.ts` — added compile-time coverage for `published + author_only => rejected` and rejected the impossible `published + author_only => approved` combination.

These two files were added to the explicit Task 2 staging allowlist after controller authorization. `src/app/types.ts` was not changed; that client-owned slice remains later work.

## RED evidence

Required focused Worker command before production implementation:

```text
npx vitest run --config vitest.worker.config.ts tests/worker/guestbook-repository.test.ts tests/worker/messages-api.test.ts

Test Files  2 failed (2)
Tests       1 failed | 5 passed (6)
```

Expected failures:

- `tests/worker/guestbook-repository.test.ts` could not import the missing `worker/db/guestbook` module.
- the new `contract=2` API test received `undefined` for `data.ownUnshared` because split streams did not exist.

Additional unit RED:

```text
npx vitest run --config vitest.config.ts tests/unit/guestbook-cursor.test.ts

Test Files  1 failed (1)
Tests       no tests
```

- Import failed because `worker/http/guestbook-cursor.ts` did not exist.

Additional behavior-specific RED evidence captured during the TDD loop:

- Manager media allowlist test failed because the response exposed raw `eventId`, `uploaderSessionId`, `objectKey`, `previewObjectKey`, `idempotencyKey`, storage sizes, MIME type, and lifecycle timestamps.
- Manager guestbook API test received 404 while the route was deliberately absent.
- the legacy version marker test showed `decodeMessageCursor()` omitted `version: 1`.
- the legacy gallery-off privacy test showed a published caption emitted `moderationStatus: pending` instead of the required fail-closed `rejected` alias.

## GREEN evidence

Final focused Worker gate:

```text
npx vitest run --config vitest.worker.config.ts tests/worker/guestbook-repository.test.ts tests/worker/messages-api.test.ts tests/worker/manage-api.test.ts

Test Files  3 passed (3)
Tests       55 passed (55)
```

Cursor and shared-contract unit gate (the narrow additional compile/runtime command required because the cursor test lives under the unit Vitest project):

```text
npx vitest run --config vitest.config.ts tests/unit/guestbook-cursor.test.ts tests/unit/guestbook-contracts.test.ts

Test Files  2 passed (2)
Tests       5 passed (5)
```

Static gates:

```text
npm run typecheck -- --pretty false
# exit 0

npm run lint
# exit 0, zero warnings

git diff --check
# exit 0
```

Worker runs printed the repository's standard missing-local-secrets warning for bindings supplied by the test environment; the tests themselves passed.

One earlier combined typecheck/three-file Worker invocation timed out without diagnostics during heavy concurrent Node/workerd process load. Narrow reruns passed, followed by the successful fresh final gates above.

## Self-review against Task 2

- Explicit serializers and SQL select lists return only wire-safe fields; no raw message/media row is returned from guest, Manager list, mutation, or compatibility responses.
- Guest shared ordering is exactly `(created_at DESC, source_rank ASC, id DESC)`, including equal-time/equal-rank coverage.
- Export snapshot insert source is explicitly ordered `(created_at ASC, source_rank DESC, source_id ASC)` and does not truncate eligible legacy rows.
- Null, empty, and whitespace-only captions are excluded; bodies are trimmed in SQL.
- Gallery-off published captions leave the shared feed, remain available only to the uploader as author-only, and expose the legacy `rejected` alias rather than implying shared visibility.
- Shared and private streams query independently. More than 50 newer shared rows do not hide an old private row; private rows have their own page/cursor/count.
- `contract=2` accepts no more than one continuation cursor and rejects malformed, unsupported, wrong stream, wrong session, and wrong event cursors with 422.
- Legacy requests retain the pre-existing unified projection/order and exact version-1 cursor wire shape through continuation chains.
- Manager cursors bind event, view, and source; all four views and both gallery states are covered, with page sizes bounded to 50.
- Manager media responses contain only `ManagerMediaView`; caption mutation responses add only a safe `ManagerGuestbookItem | null`.
- Queries are parameterized, page queries fetch only `limit + 1`, and snapshot work returns D1 prepared statements suitable for the caller's atomic batch.
- Task 3 creation enforcement, Task 4 guest UI, Task 5 Manager UI beyond required repository/routes, Task 6 rendering, deployment, and remote migration remain out of scope.

## Concerns

- The feature has repository/Worker/static verification only. No deployment, live D1 inspection, remote migration, browser acceptance, or physical-device evidence is claimed.
- `ManagerMediaView` and the visibility-correlated caption compatibility union were necessary controller-authorized corrections to Task 1's shared contracts; downstream client adoption remains a later task.

## Fix round 1

Status: complete

Implementation commit: `3651012` (`fix: harden guestbook cursors and responses`)

No push, deployment, remote migration, paid provider call, or remote-state mutation was performed.

### Accepted findings and changed files

- `worker/http/guestbook-cursor.ts` — replaced the raw guest session ID in the wire payload with a domain-separated HMAC binding derived from the canonical session ID, and authenticated the complete encoded version-2 payload with a second domain-separated HMAC under the existing generated `SESSION_HMAC_KEY`. Guest and Manager encode/decode are async, all semantic bindings and the 512-character/malformed gates remain enforced, and comparisons use the existing constant-time helper.
- `worker/routes/messages.ts` — awaits the authenticated guest/Manager cursor codec with `SESSION_HMAC_KEY`; shared-only continuation now returns an empty private item page and null private cursor while retaining the real private count.
- `worker/db/guestbook.ts` — added a bounded, parameterized count-only query for the current guest's author-only rows, avoiding a discarded private page fetch.
- `worker/db/media.ts` — bulk publication now retrieves the changed records with a bounded parameterized statement and restores request order so the route can serialize every result safely.
- `worker/routes/manage.ts` — maps every bulk result through the existing `managerMediaView` allowlist.
- `tests/unit/guestbook-cursor.test.ts` — proves guest payload privacy, guest and Manager full-payload authentication, one-byte payload/signature tamper rejection, current-session binding, semantic binding, malformed/oversized/unsigned rejection, and 422 error behavior.
- `tests/worker/manage-api.test.ts` — proves every bulk result has exactly the ten `ManagerMediaView` keys, preserves request order, and discloses no session, storage, preview-object, idempotency, MIME, byte-size, or lifecycle fields.
- `tests/worker/messages-api.test.ts` — proves a shared continuation returns no private rows/cursor but preserves the true `ownUnsharedCount` when private rows exist; direct cursor fixtures now use the authenticated async codec.

### RED evidence

Cursor privacy/integrity:

```text
npx vitest run --config vitest.config.ts tests/unit/guestbook-cursor.test.ts

Test Files  1 failed (1)
Tests       4 failed | 1 passed (5)
```

The pre-fix cursor was a synchronous, unsigned base64 JSON payload containing `sessionId`; signed round-trip and tamper tests failed before implementation.

Bulk Manager media response:

```text
npx vitest run --config vitest.worker.config.ts tests/worker/manage-api.test.ts -t "returns only ManagerMediaView fields for every bulk"

Test Files  1 failed (1)
Tests       1 failed | 37 skipped (38)
```

The pre-fix `changed` response contained bare ID strings, so its response objects did not have the required allowlisted view keys.

Shared-continuation private count:

```text
npx vitest run --config vitest.worker.config.ts tests/worker/messages-api.test.ts -t "returns independently paginated shared and private"

Test Files  1 failed (1)
Tests       1 failed | 11 skipped (12)
```

The continuation returned `ownUnsharedCount: 0`; the fixture's real private count was 1.

### GREEN evidence

Each new focused test passed after its minimal implementation. The fresh final Task 2 gate was:

```text
npx vitest run --config vitest.worker.config.ts tests/worker/guestbook-repository.test.ts tests/worker/messages-api.test.ts tests/worker/manage-api.test.ts

Test Files  3 passed (3)
Tests       56 passed (56)
```

Cursor and shared-contract unit gate:

```text
npx vitest run --config vitest.config.ts tests/unit/guestbook-cursor.test.ts tests/unit/guestbook-contracts.test.ts

Test Files  2 passed (2)
Tests       6 passed (6)
```

Static and diff gates:

```text
npm run typecheck -- --pretty false
# exit 0

npm run lint
# exit 0, zero warnings

git diff --check
# exit 0
```

Worker runs printed the repository's standard missing-local-secrets warning for bindings supplied by the test environment; all tests passed.

### Fix-round self-review

- The guest wire payload contains only the non-reversible session binding, never the canonical session ID; both guest and Manager version-2 payloads are authenticated before parsing or semantic use.
- Domain labels distinguish session-binding and cursor-payload HMAC inputs while retaining the existing generated secret and constant-time comparison helper.
- Routes still perform normal guest/Manager authorization on every request; the cursor is only pagination state.
- Wrong event, session, stream, view, or source still fails with 422, as do malformed, oversized, unsigned, payload-tampered, and signature-tampered values.
- Every bulk record crosses the explicit `managerMediaView` serializer, and the behavioral test asserts the exact response-key set for each result.
- The bulk reread is parameterized and bounded by the existing 50-ID request limit; result order is restored to request order.
- Shared continuation executes a count-only author-private query and never fetches/discards a private page; its response still uses empty private items and a null private cursor.

### Fix-round concerns

- Verification remains local Worker/unit/static evidence only. No deployment, remote migration, live D1 inspection, browser acceptance, or physical-device proof is claimed.
- Cursor signing invalidates unsigned version-2 cursors issued by the pre-fix local implementation; that implementation was not deployed under this task.

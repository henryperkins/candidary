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

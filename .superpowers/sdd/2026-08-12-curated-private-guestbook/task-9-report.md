# Task 9 report — full local verification and evidence boundary

## Outcome

Task 9 is locally complete at verification head
`a0b03e82260932bd9e8a0b86d9466929cd8d1404` on
`codex/curated-private-guestbook` in
`C:\Users\htper\candidary\.worktrees\curated-private-guestbook`.

Every required final local gate is green. The fresh full Playwright run finished
with 347 passed, 121 intentional project skips, zero failures, and zero flaky
classifications. Fresh local D1 verification applied all 15 migrations and
reported zero foreign-key violations, `integrity: ok`, and all terminal-schema
checks true.

This is local implementation and verification evidence only. No immutable
release candidate was created or certified; no secret was provisioned; no
remote D1 migration, deployment, push, runtime certification, policy approval,
manual print/spreadsheet check, or physical-device/assistive-technology check
was performed or claimed.

## Final verification gates

| Gate | Exit | Exact final evidence | Wall duration | Warnings / notes |
| --- | ---: | --- | ---: | --- |
| `npm run typecheck` | 0 | TypeScript build graph passed | 21.648 s | None. The initial pre-regression run also passed in 21.254 s. |
| `npm run typecheck:e2e` | 0 | E2E TypeScript project passed after the final harness-only edit | 5.9 s | None. The initial run passed in 3.811 s. |
| `npm run lint` | 0 | ESLint passed with `--max-warnings=0` after the final harness-only edit | 23.9 s | Zero lint warnings. Initial and post-production-fix runs also passed in 11.558 s and 12.067 s. |
| `npm run test` | 0 | Unit/UI: 76 files, 1,425 tests; Worker: 47 files, 1,131 tests; total 2,556 tests | 263.551 s | jsdom printed eight non-failing `Window.scrollTo()` notices. Worker fixtures printed missing-local-secret warnings and expected disconnect/network-loss diagnostics from failure-path tests. |
| `npm run build` | 0 | Worker bundle 1,011.03 kB / 225.44 kB gzip; client JS 669.55 kB / 196.24 kB gzip; CSS 99.63 kB / 18.20 kB gzip | 26.302 s | Required local secrets absent; Vite emitted the existing greater-than-500-kB chunk advisory. |
| `npm run test:e2e` | 0 | 468 total: 347 passed, 121 intentional skips, 0 failed, 0 flaky | 364.9 s shell / 356.939 s Playwright | Required local secrets absent; greater-than-500-kB chunk advisory; inspector 9229 was occupied, so the test web server used 9233. No snapshot update mode was used. |
| `npm run verify:bindings` | 0 | `worker-configuration.d.ts` is current | 3.539 s | Wrangler 4.113.0 reported 4.122.0 available. |
| `npm run verify:fresh-d1` with the retained absolute run/report paths below | 0 | 15 migrations; FK rows 0; integrity `ok`; terminal events/roster-batch-receipts/release-certifications all true | 16.828 s | Local-only Wrangler execution. The first setup attempt used a nonconforming temp prefix and was rejected before any migration; a new compliant UUID root was used for the recorded run. |
| Final Git/diff checks | 0 | Baseline range, working tree, and cached `git diff --check` passed; staged and unstaged quiet checks were both clean before report authoring | 2.2 s | No whitespace errors. |

Final Playwright project split, extracted from the generated report:

- `desktop`: 228 total — 213 passed, 15 intentional skips, 0 failed, 0 flaky.
- `mobile`: 240 total — 134 passed, 106 intentional skips, 0 failed, 0 flaky.

## Deterministic regression found and repaired

The first fresh `npm run test` did not pass. Unit/UI stopped with 75 passing
files, one failing file, 1,418 passing tests, and six failures; the Worker suite
therefore did not run. All six failures were in
`tests/unit/verify-release.test.ts`:

1. `writes schema-valid precondition_failed evidence after the safe-output boundary`
2. `writes schema-valid command_failed evidence after the safe-output boundary`
3. `writes schema-valid evidence_invalid evidence after the safe-output boundary`
4. `writes schema-valid artifact_drift evidence after the safe-output boundary`
5. `writes schema-valid binding_drift evidence after the safe-output boundary`
6. `writes schema-valid status_drift evidence after the safe-output boundary`

They expected the canonical `complete passed candidate` rejection but received
`Deployment candidate is not at a supported historical or post-cutover
boundary.` Task 7 had advanced `scripts/deploy-release.ts` to select the 14- or
15-migration topology by reading the declared migration count before the
existing complete/passed-candidate validation. Failed and incomplete evidence
therefore reached migration-boundary selection first. Task 7's brief and focused
test list did not include `verify-release.test.ts`, so that cross-suite contract
was not exercised there.

The repair retained every existing release boundary:

- `1becc5bd3c3e92a939b7bc19cef079db6eae2745` —
  `fix: preserve failed release evidence rejection`; validates candidate
  completeness/passed status before 14/15 boundary selection.
- `31510843d7e96ccfcc1bd287b2602567cc973a44` —
  `test: validate deployment manifest before phase selection`; calls the
  existing candidate-manifest schema assertion before field access and adds a
  malformed-manifest regression. This prevents incidental property-access
  `TypeError`s without weakening `verifyExactReleaseCandidate` or broadening
  accepted phases.

The focused `verify-release.test.ts` plus `deploy-release.test.ts` gate finished
green with 2 files and 87 tests. The subsequent fresh full unit/Worker command
produced the 2,556-test green result in the table.

## Browser stabilization and contamination classification

The browser gate required investigation rather than snapshot updates:

- First full run: exit 1 in 337.648 s; 343 passed, 121 skipped, 4 failed.
  Desktop had two failures (one 3-second status-audit poll and the eight-context
  geometry test's 30-second whole-test timeout). Mobile had two zero-tolerance
  corner-antialias snapshot differences. The one permitted failed-tests-only
  rerun passed all four selected tests with four opposite-project skips in
  58.237 s; this classified the failures but did not make the full gate green.
- Second fresh full run after bindings and D1: exit 1 in 325.764 s; 344 passed,
  121 skipped, 3 failed. Both initial status-audit polls crossed their 3-second
  bound under full load, and the eight-context geometry test again crossed the
  30-second whole-test timeout. The earlier mobile visuals passed.
- The authorized harness-only change in
  `tests/e2e/event-cover-studio.spec.ts` raised only those two initial audit
  polls from 3 to 5 seconds and gave only the eight-context geometry test a
  60-second bound. Assertions, snapshots, pixel tolerances, production code,
  and unrelated waits were unchanged. Commit:
  `a0b03e82260932bd9e8a0b86d9466929cd8d1404`.
- During targeted verification, one geometry screenshot initially showed the
  main checkout's older Cover Studio layout. Its trace loaded stale
  `/assets/index-BfocRy1h.css` (93,524 bytes, `cf-cache-status: HIT`) rather
  than this worktree's current `index-BANlS2ol.css` (99,636 bytes). The actual
  screenshot hash was
  `3d4d739c6779de0d4f6212cadd843719f243ae3b989d37c6af6c945d197b1283`;
  the tracked expected hash was
  `f8b8085e676d30361b11a0a81fbc321bc4b4fd1eb141a606b1b761f024a1ca9d`.
  Source order and CSS independently matched the tracked baseline, proving
  cross-worktree port-4173 contamination rather than baseline drift.
- No unrelated process was terminated. On the permitted isolated rerun, the
  active server chain was conclusively this worktree's Playwright process to
  `npm run build && npx vite preview --host 127.0.0.1 --port 4173` to this
  worktree's Vite executable. Geometry passed in 11.2 seconds (mobile project
  intentionally skipped). The two audit cases had already passed in 4.2 and
  4.4 seconds.
- After typecheck:e2e, lint, and diff checks, the harness edit was committed
  separately. The one final fresh full suite then passed with the project totals
  above. No snapshot was updated anywhere in Task 9.

## Fresh D1 evidence

Successful explicit UUID run root:

`C:\Users\htper\AppData\Local\Temp\candidary-release-task9-f41c1a7499264b029459f201fdc33d54`

Retained report:

`C:\Users\htper\AppData\Local\Temp\candidary-release-task9-f41c1a7499264b029459f201fdc33d54\migration-verification.json`

Exact report values:

```json
{"foreignKeyRows":0,"integrity":"ok","ledgerSha256":"5a10f52efab2793890a050713e3e0f8fea660a15d8c5f37368d3e8df18ec60c1","migrationCount":15,"terminalSchema":{"events":true,"releaseCertifications":true,"rosterBatchReceipts":true}}
```

The active migration is
`0015_curated_private_guestbook.sql`, SHA-256
`04b065de5493fdb4353ffe8bbc93faf826271e1208563f9d2c8222973485a716`.
This proves a fresh local schema only; it does not prove any remote database
state.

## Whole-branch inventory

Range inspected:
`911f8df9df96fbc882e0d3c1361894df488d3435..a0b03e82260932bd9e8a0b86d9466929cd8d1404`.

- 32 commits; 128 tracked files changed; 10,188 insertions and 736 deletions.
- Migration inventory is contiguous from `0001_core.sql` through
  `0015_curated_private_guestbook.sql`; all 15 names and SHA-256 hashes were
  inspected, and fresh-D1 verification matched a 15-entry ledger.
- `worker-configuration.d.ts` is Wrangler-generated with hash
  `5c4f229e44232245ad86babacc0edb8c`; it contains the generated
  `GUEST_MESSAGE_RATE_LIMIT: RateLimit` and `GUEST_MESSAGE_HMAC_KEY: string`
  declarations.
- `wrangler.jsonc` defines production namespace `1003` with limit 120 and
  period 60, and includes `GUEST_MESSAGE_HMAC_KEY` in the generated-types secret
  inventory. `.dev.vars.example` documents the new persisted-data HMAC key.
- Release topology retains distinct historical 13/14-migration paths and the
  post-cutover 15-migration schema-v2 path. The Task 9 verifier repair preserves
  canonical failed/incomplete-candidate rejection before selecting 14 versus
  15; it neither verifies nor creates a release candidate.
- Snapshot diff inventory contains 13 modified baselines, 2 new Guestbook
  baselines, and 1 removed superseded Notes baseline. Task 8 inspected all 15
  current changed/new images at original resolution and passed the exact
  zero-tolerance named run. Task 9 used read-only comparisons and made no
  snapshot changes.

## Design §§5–17 evidence map

| Design section | Local implementation/evidence | Explicit boundary or accepted refinement |
| --- | --- | --- |
| §5 Chosen architecture | Canonical note/media stores remain in `worker/db/messages.ts` and `worker/db/media.ts`; `worker/db/guestbook.ts` provides unified projection/summary/snapshot reads; shared discriminated contracts and source/state visibility tests live in `shared/contracts.ts`, `tests/unit/guestbook-contracts.test.ts`, `tests/unit/guestbook-cursor.test.ts`, `tests/worker/guestbook-repository.test.ts`, and `tests/worker/messages-api.test.ts`. | No denormalized canonical Guestbook table was introduced. Task 2's reviewed contract-v2 split streams are a privacy-preserving wire refinement of the design's simplified `{ items, nextCursor }` sketch. |
| §6 Event setting and prompt | Migration default/check, event mappings, complete Settings payload/autosave/reset, moderation label, manager and guest allowlists are covered by migration, Manager API, settings unit/UI, and final full Worker/unit gates. | Local schema and UI/API evidence only; no remote event data was migrated. |
| §7 Guest experience | `Guestbook.tsx`, guestbook state, `EventPage.tsx`, upload/RSVP name ownership, API client, and styling implement placement, attribution, draft/idempotency safety, owned/private and shared reading, refresh, pagination, focus, and reduced motion. Guestbook UI/unit, Worker messages, core journey, accessibility, guest-responsive, theming, and final full E2E gates passed. | Browser evidence is local Chromium with stubbed APIs; it does not establish durable identity, native-device behavior, or production sessions. |
| §8 Host experience | `ManagerGuestbookPanel.tsx`, manager state/Page integration, summary/list/mutation routes, lazy loading, badge/views/filters, row-local actions, Undo, polling, refresh, focus/scroll, and gallery-off behavior are covered by Manager UI, Worker, responsive, accessibility, and visual tests. | No bulk moderation was added, consistent with the design. No live concurrent-host rehearsal was performed. |
| §9 API contracts | Existing guest message routes, Manager summary/list routes, state-guarded note mutations, existing media publication mutations, envelopes, bounded limits, authenticated cursors, cross-event refusal, and conflicts are exercised in Worker/API and cursor tests. | Exact authorization/runtime behavior is locally simulated; no deployed endpoint was called. |
| §10 D1 schema and repository behavior | Migration 0015, prompt constraints, bounded rate/purge storage, legacy-nullable export metadata, immutable export rows, indexes, snapshot transaction, >1,000 legacy snapshot coverage, and retry immutability are covered by migration, repository, messages, export, cleanup, and fresh-D1 tests. | The reviewed implementation uses a bounded `guest_message_rate_events` ledger plus cleanup rather than the prose's literal single current-window row; Task 1 preserved this reviewed schema and Task 3 proves the same fixed-window/cap/privacy behavior. No remote D1 evidence. |
| §11 Submission protection and capacity | Dedicated generated Cloudflare limiter binding, domain-separated persisted HMAC scopes, guarded D1 creation/replay/conflict logic, fixed windows, retained-note cap, purge receipts, and bounded cleanup are covered by security and Worker tests. | Miniflare does not instantiate the native Rate Limit service; the Worker suite uses a generated-`RateLimit`-compatible fixture. Native edge shedding and eventual-consistency behavior remain a runtime gate. |
| §12 Export artifacts | Immutable snapshot rows, deterministic photo mapping, self-contained `guestbook.html`, formula-hardened `guestbook-private.csv`, distinct signed descriptors, notes/photos/mixed/private/empty/legacy cases, Workflow ownership/retry/Ready atomicity, expiry and purge are covered by renderer units plus export/cleanup/repository Worker tests. Browser tests exercise semantic screen and print-media rendering. | No OS print dialog, manual common-browser file opening, or common spreadsheet application opened the CSV. No remote R2 object was written. |
| §13 Error handling and resilience | Guest draft/feed failures, conflicts/limits, Manager section/row failures, export snapshot/generation/retry/cleanup failures, disconnects, and network loss are represented across UI, Worker, and browser recovery tests; full local suites passed. | Stubbed/local failure injection is not production degraded-network rehearsal. |
| §14 Privacy, authorization, observability | Authenticated domain-separated cursors, canonical session ownership, exact event/manager/CSRF boundaries, allowlisted serializers, no object keys/digests/session IDs in responses, and security documentation/tests passed. | No production log/metric stream or live authorization audit was inspected, so operational redaction/metrics are source- and test-proven only. |
| §15 Accessibility and visual behavior | Native semantics, live regions, focus/scroll stability, 44-pixel targets, `dir="auto"`, RTL/Unicode/max text, 320/390 widths, zoom-equivalent layouts, reduced motion, Axe/contrast, printable HTML screen/print media, and zero-tolerance snapshots are exercised by the final browser suite and Task 8's inspected baselines. | Local Chromium automation does not prove VoiceOver, TalkBack, physical iPhone/Android, camera picker, QR, or device-specific 200%/400% behavior. |
| §16 Testing and acceptance | Migration/repository, Worker/API, export/cleanup, client/unit, build, binding, fresh-D1, and complete browser gates are green at the verification head. Final unit/Worker total is 2,556 tests; final browser total is 468 cases with 121 intentional cross-project skips. | The design's manual common-browser print and common-spreadsheet CSV checks remain open, as do immutable candidate, remote migration, deploy, runtime, and physical-device release gates. |
| §17 Implementation boundaries | The branch is decomposed into the approved task slices with focused RED/GREEN evidence, review-fix commits, explicit path-scoped commits, and separate reports. Task 9 fixes were committed independently and did not broaden product scope. | No push, deploy, remote migration, secret provisioning, release-candidate creation, or device-proof claim was made. |

## Remaining release and acceptance gates

The implementation is locally verified, but none of the following is implied by
that result:

- immutable release-candidate generation or `verify:release` certification;
- production/staging secret or Rate Limit namespace provisioning;
- remote D1 migration, remote R2 writes, deployment, or runtime certification;
- production log/metric redaction inspection or policy/legal approval;
- OS print-dialog and common-browser manual opening of `guestbook.html`;
- common spreadsheet opening of `guestbook-private.csv` without byte/privacy
  changes;
- physical iPhone/Android, native camera picker, QR, VoiceOver, TalkBack, or
  degraded-network rehearsal.

## Git and retained evidence

Before authoring this ignored report, `git diff --check`,
`git diff --cached --check`, staged/unstaged quiet checks, and
`git status --short` were all clean at
`a0b03e82260932bd9e8a0b86d9466929cd8d1404`.

Task 9 command logs and failure traces are retained under:

`C:\Users\htper\AppData\Local\Temp\candidary-task9-06f421f069eb473b96843833799e0b77`

The report is intentionally committed separately with `git add -f` and an
explicit path. The ignored `progress.md` ledger is appended but not staged.

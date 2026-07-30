# Candidary Event RSVP and Durable Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an invited household use one permanent printed event QR to submit or revise attendance for every named member and approved plus-one slot, while the same QR later opens Candidary's existing private photo drop.

**Architecture:** Add a durable event-entry credential in front of the existing short-lived guest grant, then isolate RSVP behind its own household-scoped session, service, repositories, and React components. D1 remains the source of truth for the roster, deadlines, versions, and derived totals; the Worker computes the guest phase from server time, and `EventPage` composes either RSVP or the unchanged photo flow as the primary surface.

**Tech Stack:** TypeScript 6, Zod 4, Hono 4, React 19, Cloudflare Workers, D1, the Cloudflare Rate Limiting binding, Vitest with workerd, Testing Library, Playwright against Vite preview, and the existing QR, R2, Images, and Workflows infrastructure.

## Global Constraints

- Implement the approved contract in
  `docs/superpowers/specs/2026-07-30-event-rsvp-and-photo-entry-design.md`.
  Do not reopen meal, dietary, seating, reminder, account, unique-code, or
  self-registration scope.
- Preserve the approved photo journey exactly:
  required guest name -> camera or library -> review -> explicit Send ->
  per-file progress/retry -> terminal delivered receipt. RSVP must not become a
  prerequisite for upload, and `GuestUploadFlow` must not become an RSVP state
  controller.
- The invitation QR carries one high-entropy event-entry credential. Its raw URL
  stays byte-for-byte stable across normal guest-grant rotation, session expiry,
  RSVP phase changes, and opening photo intake.
- Put the raw credential in the event link's URL fragment
  (`/join#<id.secret>`), which browsers do not send in HTTP requests or
  referrers. The join shell copies it into memory, immediately removes the
  fragment with `history.replaceState`, and exchanges it in a same-origin POST
  body that application/platform request logs must not record.
- Emergency entry disable is irreversible in v1. It pauses RSVP and uploads,
  disables future exchanges, revokes active event-guest and RSVP sessions, and
  warns that every printed QR will stop. It does not revoke manager or host
  account sessions, and there is no silent replacement or re-enable action.
- Use dedicated `ENTRY_HMAC_KEY` and `ENTRY_ENCRYPTION_KEY` secrets for the
  printed credential, `RSVP_LOOKUP_HMAC_KEY` for name/rate-limit scopes, and the
  existing `SESSION_HMAC_KEY` for session and CSRF digests. Never log raw
  credentials, ciphertext, submitted names, RSVP bodies, or CSV contents.
- Treat entry and RSVP lookup keys as persisted-data keys, not routine session
  rotation controls. Rotating them without an explicit re-encryption/re-digest
  migration breaks printed entries or roster lookup. Normal internal guest-grant
  and session rotation must leave those keys and the printed QR unchanged.
- Exact-name normalization is version 1 and immutable for this release: NFKC;
  trim; collapse Unicode whitespace; normalize curly apostrophes to `'`;
  normalize Unicode hyphen/dash variants to `-`; lowercase without
  locale-specific rules; preserve diacritics and all other punctuation.
- Invitee names and household labels reject line breaks and Unicode control or
  format code points after normalization. The CSV parser may understand quoted
  newlines structurally, but they are not valid inside these product fields.
- The RSVP deadline input is a calendar date in the selected IANA event time
  zone. The server stores the final millisecond of that local day as an absolute
  timestamp. The event remains open through that instant and closes on the next
  millisecond.
- Hosts may shorten or extend the deadline. Writes enforce the earlier of the
  RSVP session's captured write deadline and the event's current deadline:
  shortening takes effect immediately, while an extension requires a new exact
  lookup to gain the extended write window.
- The browser never infers phase or write authority from its clock. The Worker
  returns `rsvp-primary`, `photos-primary`, or `waiting`, plus the current RSVP
  state.
- New events start with photo intake paused and RSVP disabled. RSVP can only be
  enabled when a deadline exists and the active roster passes collision and
  capacity validation.
- The first CSV import can commit only while RSVP is disabled and the event has
  no household rows, active or archived. It is previewed, reparsed, and committed
  once; all later roster changes are explicit manager edits.
- CSV import is UTF-8 with an optional BOM, at most 256 KiB, with the exact header
  `household_key,household_label,invitee_name,plus_one_slots`. It permits at most
  500 event capacity, 500 households, 20 named invitees and 10 plus-one slots per
  household, and 30 total people per household.
- Household keys are lowercase ASCII identifiers matching
  `[a-z0-9][a-z0-9_-]{0,63}`. Labels and names are 1-80 characters after trim.
  Repeated household rows must use the same label and plus-one count. Every
  active household contains at least one named invitee; plus-one-only
  households cannot be imported, manually created, edited, or activated.
- A named invitee may be renamed after a response without losing attendance. A
  named invitee may only be removed before the household's first response.
  Increasing plus-one capacity appends stable slots; reducing it removes only
  highest-order non-attending slots and is rejected if an affected slot attends.
- Archiving is irreversible in v1. It revokes that household's RSVP sessions,
  removes it from lookup and active totals, and keeps its marked rows in the host
  list and CSV export until event purge.
- RSVP stores current state plus first/latest response metadata, not a
  host-visible revision history. Preserve every successful household
  idempotency key, canonical payload digest, and committed result version in a
  compact receipt row until event purge. Replaying any successful key with the
  same payload returns success; reusing it with different content is rejected.
- Edge lookup limiting is 30 attempts per IP per minute. D1 defense-in-depth is
  20 attempts per event/IP and 8 attempts per event/normalized-name in a fixed
  15-minute bucket. A second-name request charges the IP once and each supplied
  name once. Rate-limit rows store only domain-separated HMAC digests.
- Every RSVP write uses its own `candidary_rsvp` HttpOnly cookie,
  `candidary_rsvp_csrf` readable CSRF cookie, and
  `X-Candidary-RSVP-CSRF` header. Photo APIs continue to accept only the existing
  event guest session.
- Host routes continue through `requireManager()` so signed-in host ownership and
  delegated management links keep their current precedence and CSRF behavior.
- Use additive migration `0008_event_rsvp.sql`. Do not rewrite migrations
  0001-0007, add a compatibility fallback for old `/join` tokens, or backfill old
  events. Existing data is not a supported input to this first product shape.
- No statement may bind more than 100 D1 parameters. A 500-person import must
  commit as one `DB.batch()` using parameter-bounded multi-row statements.
- Formula-neutralize every exported CSV cell whose first non-whitespace
  character is `=`, `+`, `-`, or `@`. Apply the shared encoder to the existing
  media CSV/manifest too.
- The media CSV change is an intentional security hardening required by the
  approved spreadsheet-injection constraint: ordinary cells remain byte-for-byte
  unchanged, while only formula-shaped cells gain a leading apostrophe. Keep
  backward-output regression coverage for both media and RSVP exports.
- Use a failing behavioral test before each production change and commit each
  independently reviewable task. Worker test setup already discovers migrations
  dynamically; do not hardcode 0008 in `vitest.worker.config.ts`.
- Run browser tests through the repository Playwright configuration
  (`npm run build` plus Vite preview), never the Vite development server.
- Do not modify, extract, delete, or stage the user-owned
  `CandidaryDesignSystem.zip`.
- Do not push, merge, deploy, change Cloudflare secrets, reset remote D1, or
  delete R2 objects as part of implementation. Because no entry backfill or
  legacy `/join` fallback exists, release must prove there are zero active
  pre-0008 events or use the user's authorized clean-D1/fresh-D1 path after
  exact-target verification. R2 disposition remains a separate explicit
  decision; never infer permission to delete objects from permission to reset
  D1.
- Deployment success is not wedding-readiness proof. The actual printed QR must
  pass physical iPhone Safari and Android Chrome rehearsal before the feature is
  called ready.

## Execution Setup

- [ ] Create an isolated feature worktree from the commit containing this plan by
  following `superpowers:using-git-worktrees`; keep the primary checkout and its
  untracked ZIP untouched.
- [ ] Record the starting SHA and confirm `git status --short` contains no
  unexpected files in the worktree.
- [ ] Run `npm ci`, then establish the baseline:

```powershell
npm run typecheck
npm run lint
npm test
npm run build
npx tsc -p tsconfig.e2e.json --pretty false
npm run test:e2e
```

- [ ] Verify 0007 is still the highest migration before creating 0008:

```powershell
Get-ChildItem migrations | Sort-Object Name
```

Expected: `0007_event_theme.sql` is last. If another branch has claimed 0008,
stop and renumber this plan's migration before writing production code.

## File Map

### New shared/domain files

- `shared/rsvp.ts` — immutable limits, normalization, phase, totals, and wire
  helpers.
- `shared/event-time.ts` — IANA validation and date-only end-of-local-day
  conversion.
- `shared/csv.ts` — UTF-8 RSVP parsing and formula-safe CSV cell encoding.
- `tests/unit/rsvp.test.ts`
- `tests/unit/event-time.test.ts`
- `tests/unit/csv.test.ts`

### New Worker/data files

- `migrations/0008_event_rsvp.sql`
- `worker/db/event-entries.ts`
- `worker/db/rsvp.ts`
- `worker/db/rsvp-sessions.ts`
- `worker/db/rsvp-rate-limits.ts`
- `worker/auth/rsvp.ts`
- `worker/http/client-ip.ts`
- `worker/http/rsvp-cursor.ts`
- `worker/services/event-entry.ts`
- `worker/services/rsvp.ts`
- `worker/routes/rsvp.ts`
- `worker/routes/manage-rsvp.ts`
- `worker/routes/entry.ts`
- `tests/worker/migration-0008.test.ts`
- `tests/worker/event-entry-api.test.ts`
- `tests/worker/rsvp-import-api.test.ts`
- `tests/worker/rsvp-lookup-api.test.ts`
- `tests/worker/rsvp-submission-api.test.ts`
- `tests/worker/rsvp-manage-api.test.ts`

### New React/browser files

- `src/features/rsvp/GuestRsvpFlow.tsx`
- `src/features/rsvp/RsvpLookup.tsx`
- `src/features/rsvp/RsvpHouseholdForm.tsx`
- `src/features/rsvp/RsvpReceipt.tsx`
- `src/features/rsvp/rsvp-form.ts`
- `src/components/ManagerRsvpPanel.tsx`
- `src/features/rsvp/ManagerRsvpDashboard.tsx`
- `src/features/rsvp/ManagerRsvpImport.tsx`
- `src/features/rsvp/ManagerRsvpHouseholdEditor.tsx`
- `src/pages/EventEntryUnavailablePage.tsx`
- `src/pages/EventEntryPage.tsx`
- `tests/ui/guest-rsvp-flow.test.tsx`
- `tests/ui/manager-rsvp-panel.test.tsx`
- `tests/ui/event-entry.test.tsx`
- `tests/e2e/rsvp-journey.spec.ts`
- `tests/e2e/rsvp-responsive.spec.ts`
- `scripts/rsvp-load-harness.mjs`
- `docs/rsvp-csv.md`

### Existing files changed

- Contracts/config: `shared/contracts.ts`, `shared/errors.ts`,
  `shared/constants.ts`, `.dev.vars.example`, `wrangler.jsonc`,
  `worker-configuration.d.ts`, `vitest.worker.config.ts`, `package.json`.
- Event/auth Worker: `worker/db/types.ts`, `worker/db/events.ts`,
  `worker/security/crypto.ts`, `worker/auth/service.ts`,
  `worker/services/events.ts`, `worker/services/links.ts`,
  `worker/routes/public.ts`, `worker/routes/exchange.ts`,
  `worker/routes/event.ts`, `worker/routes/manage.ts`, `worker/app.ts`,
  `worker/env.ts`, `worker/http/cookies.ts`, `worker/http/csrf.ts`,
  `worker/http/event-view.ts`, `worker/workflows/cleanup.ts`,
  `worker/export/csv.ts`.
- React: `src/app/api.ts`, `src/pages/CreatePage.tsx`,
  `src/pages/EventPage.tsx`, `src/pages/ManagerPage.tsx`,
  `src/styles.css`.
- Fixtures/regressions: `tests/worker/helpers.ts`,
  `tests/worker/auth-api.test.ts`, `tests/worker/manage-api.test.ts`,
  `tests/worker/cleanup.test.ts`, `tests/unit/export.test.ts`,
  `tests/ui/app.test.tsx`, `tests/ui/event-theme-rendering.test.tsx`,
  `tests/e2e/fixtures/routes.ts`, `tests/e2e/fixtures/ui-data.ts`,
  `tests/e2e/core-journey.spec.ts`, `tests/e2e/guest-responsive.spec.ts`,
  `tests/e2e/manager-responsive.spec.ts`, `tests/e2e/accessibility.spec.ts`,
  `tests/e2e/security.spec.ts`, `tests/e2e/visual-qa.spec.ts`.
- Product/operations docs: `README.md`, `CLAUDE.md`,
  `docs/security.md`, `docs/operations.md`, `docs/deployment.md`,
  `design/design-system.md`, `design/fidelity-ledger.md`, and the older
  wedding/photo and manager design specifications noted in Task 11.

---

### Task 1: Freeze the shared RSVP, phase, deadline, and CSV contracts

**Files:**

- Modify: `shared/contracts.ts`
- Modify: `shared/errors.ts`
- Modify: `shared/constants.ts`
- Create: `shared/rsvp.ts`
- Create: `shared/event-time.ts`
- Create: `shared/csv.ts`
- Create: `tests/unit/rsvp.test.ts`
- Create: `tests/unit/event-time.test.ts`
- Create: `tests/unit/csv.test.ts`
- Modify: `tests/unit/export.test.ts`
- Modify: `worker/export/csv.ts`

**Interfaces:**

- Produces `RsvpAttendance`, `RsvpInviteeKind`, `RsvpState`,
  `GuestEventPhase`, `RsvpHouseholdView`, `RsvpSummary`,
  `RsvpImportPreview`, and manager/guest request contracts.
- Produces `normalizeInvitedName(value): string`.
- Produces `resolveGuestEventPhase(input, now): GuestPhaseView`.
- Produces `endOfLocalDate(dateOnly, timeZone): string`.
- Produces `localDateForInstant(instant, timeZone): string`.
- Produces `parseRsvpCsv(csv): ParsedRsvpRoster`.
- Produces `csvCell(value): string`.

- [ ] **Step 1: Write the failing domain and phase tests**

Create `tests/unit/rsvp.test.ts` with exact invariants:

```ts
import { describe, expect, it } from 'vitest';

import {
  normalizeInvitedName,
  resolveGuestEventPhase,
} from '../../shared/rsvp';

describe('RSVP domain', () => {
  it('normalizes exact invited names without folding diacritics', () => {
    expect(normalizeInvitedName('  ＭARY\u00a0O’NEIL–SMITH  '))
      .toBe("mary o'neil-smith");
    expect(normalizeInvitedName('José')).toBe('josé');
    expect(normalizeInvitedName('Jose')).not.toBe(normalizeInvitedName('José'));
  });

  it('uses server time to select phase and close RSVP', () => {
    const input = {
      uploadsEnabled: false,
      rsvpEnabled: true,
      rsvpDeadlineAt: '2026-07-31T04:59:59.999Z',
    };
    expect(resolveGuestEventPhase(input, new Date('2026-07-31T04:59:59.999Z')))
      .toEqual({ phase: 'rsvp-primary', rsvpState: 'open' });
    expect(resolveGuestEventPhase(input, new Date('2026-07-31T05:00:00.000Z')))
      .toEqual({ phase: 'waiting', rsvpState: 'closed' });
    expect(resolveGuestEventPhase(
      { ...input, uploadsEnabled: true },
      new Date('2026-07-30T12:00:00.000Z'),
    )).toEqual({ phase: 'photos-primary', rsvpState: 'open' });
  });
});
```

Add table cases for paused RSVP, photos-only, closed/waiting, empty/control-only
names, whitespace collapse, all approved apostrophe/dash code points, and the
500/20/10/30 capacity constants.

- [ ] **Step 2: Write deadline tests around both Chicago DST boundaries**

Create `tests/unit/event-time.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  endOfLocalDate,
  isIanaTimeZone,
  localDateForInstant,
} from '../../shared/event-time';

describe('event-local RSVP deadlines', () => {
  it('stores the last local millisecond across spring DST', () => {
    expect(endOfLocalDate('2026-03-08', 'America/Chicago'))
      .toBe('2026-03-09T04:59:59.999Z');
  });

  it('stores the last local millisecond across fall DST', () => {
    expect(endOfLocalDate('2026-11-01', 'America/Chicago'))
      .toBe('2026-11-02T05:59:59.999Z');
  });

  it('rejects invented zones and impossible dates', () => {
    expect(isIanaTimeZone('America/Chicago')).toBe(true);
    expect(isIanaTimeZone('Central Wedding Time')).toBe(false);
    expect(() => endOfLocalDate('2026-02-30', 'America/Chicago')).toThrow();
  });

  it('returns the event-local date on a guest device in another zone', () => {
    expect(localDateForInstant(
      '2026-07-31T04:59:59.999Z',
      'America/Chicago',
    )).toBe('2026-07-30');
  });
});
```

- [ ] **Step 3: Write CSV parser and injection tests**

In `tests/unit/csv.test.ts`, assert the exact header, BOM handling, CRLF/LF,
quoted commas/newlines/doubled quotes, byte limit, stable-key grammar,
inconsistent repeated household fields, duplicate invitees, household/event
capacity, and collision issue shape. Add this exact neutralization table:

```ts
it.each([
  ['=1+1', "'=1+1"],
  [' +SUM(A1:A2)', "' +SUM(A1:A2)"],
  ['-cmd', "'-cmd"],
  ['@evil', "'@evil"],
  ['Avery', 'Avery'],
  ['Avery, Jr.', '"Avery, Jr."'],
])('encodes formula-safe cells', (input, output) => {
  expect(csvCell(input)).toBe(output);
});
```

Add regression assertions to `tests/unit/export.test.ts` proving media filenames,
guest names, and captions use the same safe encoder.

- [ ] **Step 4: Run the focused tests and verify missing exports**

```powershell
npx vitest run --config vitest.config.ts tests/unit/rsvp.test.ts tests/unit/event-time.test.ts tests/unit/csv.test.ts tests/unit/export.test.ts
```

Expected: FAIL because the three shared modules and new contracts do not exist.

- [ ] **Step 5: Add the exact shared domain types and constants**

Extend `shared/contracts.ts` with explicit wire types rather than spreading
database records. The core additions are:

```ts
export type RsvpAttendance = 'pending' | 'attending' | 'declined';
export type RsvpInviteeKind = 'named' | 'plus_one';
export type RsvpState = 'disabled' | 'paused' | 'open' | 'closed';
export type GuestEventPhase = 'rsvp-primary' | 'photos-primary' | 'waiting';
export type RsvpActor = 'household' | 'host';

export interface GuestPhaseView {
  phase: GuestEventPhase;
  rsvpState: RsvpState;
}

export interface RsvpInviteeView {
  id: string;
  kind: RsvpInviteeKind;
  displayName: string | null;
  attendance: RsvpAttendance;
  order: number;
}

export interface RsvpHouseholdView {
  id: string;
  label: string;
  version: number;
  editable: boolean;
  renewalRequired: boolean;
  deadlineAt: string;
  invitees: RsvpInviteeView[];
  firstRespondedAt: string | null;
  latestRespondedAt: string | null;
  latestActor: RsvpActor | null;
}
```

Add named interfaces for lookup, household submission, import preview issues,
summary totals, list filters, manual editor payloads, and export metadata. Add
the RSVP-specific error codes:

```ts
| 'EVENT_ENTRY_UNAVAILABLE'
| 'RSVP_UNAVAILABLE'
| 'RSVP_CLOSED'
| 'RSVP_SESSION_REQUIRED'
| 'RSVP_HOUSEHOLD_CONFLICT'
| 'RSVP_SUBMISSION_CONFLICT'
| 'RSVP_ROSTER_INVALID'
| 'RSVP_IMPORT_CONFLICT'
```

- [ ] **Step 6: Implement deterministic normalization and phase selection**

Create `shared/rsvp.ts`:

```ts
export const MAX_EVENT_RSVP_CAPACITY = 500;
export const MAX_RSVP_HOUSEHOLDS = 500;
export const MAX_NAMED_INVITEES_PER_HOUSEHOLD = 20;
export const MAX_PLUS_ONES_PER_HOUSEHOLD = 10;
export const MAX_HOUSEHOLD_CAPACITY = 30;

const APOSTROPHES = /[\u2018\u2019\u02bc]/gu;
const DASHES = /[\u2010-\u2015\u2212]/gu;
const WHITESPACE = /\p{White_Space}+/gu;

export function normalizeInvitedName(value: string): string {
  return value.normalize('NFKC')
    .replace(APOSTROPHES, "'")
    .replace(DASHES, '-')
    .replace(WHITESPACE, ' ')
    .trim()
    .toLowerCase();
}

export function resolveGuestEventPhase(
  input: {
    uploadsEnabled: boolean;
    rsvpEnabled: boolean;
    rsvpDeadlineAt: string | null;
  },
  now = new Date(),
): { phase: GuestEventPhase; rsvpState: RsvpState } {
  const deadline = input.rsvpDeadlineAt ? Date.parse(input.rsvpDeadlineAt) : NaN;
  const hasValidDeadline = Number.isFinite(deadline);
  const expired = hasValidDeadline && now.getTime() > deadline;
  const rsvpState: RsvpState = !hasValidDeadline
    ? 'disabled'
    : expired
      ? 'closed'
      : input.rsvpEnabled ? 'open' : 'paused';
  if (input.uploadsEnabled) return { phase: 'photos-primary', rsvpState };
  if (rsvpState === 'open') return { phase: 'rsvp-primary', rsvpState };
  return { phase: 'waiting', rsvpState };
}
```

Keep collision analysis and derived totals as pure functions in this module so
CSV preview, manual edits, service activation, and unit tests call the same
rules.

The collision algorithm is exact: build a map from normalized-name digest to
the active household IDs containing it. For every household `H` and each digest
`d` in `H` that maps to more than one household, require another distinct
digest `e` in `H` where the intersection of `households(d)` and
`households(e)` is exactly `{H}`. If no such second name exists, emit a blocking
`household_lookup_unresolvable` issue for `H`. Also reject two named rows in one
household that normalize to the same value.

- [ ] **Step 7: Implement event-local end-of-day conversion without a new dependency**

Create `shared/event-time.ts`. Parse calendar components strictly, calculate the
next local midnight by iteratively comparing `Intl.DateTimeFormat` parts, and
subtract one millisecond. Fix `hourCycle: 'h23'` to avoid a `24:00` result:

```ts
const formatter = (timeZone: string) => new Intl.DateTimeFormat('en-CA', {
  timeZone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

export function isIanaTimeZone(value: string): boolean {
  try {
    formatter(value).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}
```

The conversion must use only the requested zone, never the Worker's host zone,
and must throw for a formatted wall time that cannot round-trip to the requested
calendar date. `localDateForInstant()` uses the same formatter to return
`YYYY-MM-DD`; event views use it instead of asking a guest browser to reinterpret
the absolute timestamp.

- [ ] **Step 8: Implement the shared CSV parser and safe encoder**

Create `shared/csv.ts` as a small state machine with `field`, `row`, `quoted`,
and `afterQuote` states. Do not use `split(',')`. Validate the exact four-column
header before mapping rows, then aggregate by household key and run the shared
capacity/collision rules.

Use this exact output encoder:

```ts
const FORMULA_PREFIX = /^[\p{White_Space}]*[=+\-@]/u;

export function csvCell(value: string | number | null): string {
  const text = value === null ? '' : String(value);
  const safe = FORMULA_PREFIX.test(text) ? `'${text}` : text;
  return /[",\r\n]/u.test(safe)
    ? `"${safe.replaceAll('"', '""')}"`
    : safe;
}
```

Replace the private `cell()` in `worker/export/csv.ts` with this helper so both
photo and RSVP exports share the mitigation.

- [ ] **Step 9: Run focused tests, typecheck, lint, and commit**

```powershell
npx vitest run --config vitest.config.ts tests/unit/rsvp.test.ts tests/unit/event-time.test.ts tests/unit/csv.test.ts tests/unit/export.test.ts
npm run typecheck
npm run lint
git diff --check
git add shared/contracts.ts shared/errors.ts shared/constants.ts shared/rsvp.ts shared/event-time.ts shared/csv.ts tests/unit/rsvp.test.ts tests/unit/event-time.test.ts tests/unit/csv.test.ts tests/unit/export.test.ts worker/export/csv.ts
git commit -m "feat: define RSVP domain contracts"
```

Expected: focused tests, typecheck, lint, and diff check all pass.

---

### Task 2: Add the clean RSVP and durable-entry D1 schema

**Files:**

- Create: `migrations/0008_event_rsvp.sql`
- Modify: `worker/db/types.ts`
- Modify: `worker/db/events.ts`
- Create: `worker/db/event-entries.ts`
- Create: `worker/db/rsvp.ts`
- Create: `worker/db/rsvp-sessions.ts`
- Create: `worker/db/rsvp-rate-limits.ts`
- Create: `tests/worker/migration-0008.test.ts`
- Modify: `tests/worker/repositories.test.ts`

**Interfaces:**

- Produces `EventEntryRecord`, `RsvpHouseholdRecord`,
  `RsvpInviteeRecord`, `RsvpSessionRecord`, and row mappers.
- Produces repositories for entry credentials, households/invitees,
  household sessions, and rate reservations.
- Extends `EventRecord` with `eventTimezone`, `rsvpEnabled`,
  `rsvpDeadlineAt`, and `rsvpRosterVersion`.

- [ ] **Step 1: Write migration constraints and cascade tests**

Create `tests/worker/migration-0008.test.ts` to assert:

- all new tables and event columns exist on a clean migration run;
- one entry credential per event;
- household keys are unique per event;
- submission receipt keys are unique per household and cascade on purge;
- a session cannot combine one event with another event's household;
- named invitees require a name and digest;
- import/manual/activation services reject an active household with no named
  invitee;
- plus-one slots never carry a lookup digest and require a name only when
  attending;
- RSVP cannot be enabled with a null deadline;
- deleting an event cascades through entry, household, invitee, RSVP session,
  and rate-limit rows; and
- `PRAGMA foreign_key_check` returns no rows.

- [ ] **Step 2: Run the migration test and verify missing schema**

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/migration-0008.test.ts
```

Expected: FAIL because migration 0008 and its tables do not exist.

- [ ] **Step 3: Add event configuration and durable entry SQL**

Start `migrations/0008_event_rsvp.sql` with:

```sql
ALTER TABLE events
  ADD COLUMN event_timezone TEXT NOT NULL DEFAULT 'UTC'
  CHECK (length(event_timezone) BETWEEN 1 AND 64);
ALTER TABLE events
  ADD COLUMN rsvp_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (rsvp_enabled IN (0, 1));
ALTER TABLE events ADD COLUMN rsvp_deadline_at TEXT;
ALTER TABLE events
  ADD COLUMN rsvp_roster_version INTEGER NOT NULL DEFAULT 0
  CHECK (rsvp_roster_version >= 0);

CREATE TRIGGER events_rsvp_deadline_insert
BEFORE INSERT ON events
WHEN NEW.rsvp_enabled = 1 AND NEW.rsvp_deadline_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'RSVP deadline required');
END;

CREATE TRIGGER events_rsvp_deadline_update
BEFORE UPDATE OF rsvp_enabled, rsvp_deadline_at ON events
WHEN NEW.rsvp_enabled = 1 AND NEW.rsvp_deadline_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'RSVP deadline required');
END;

CREATE TABLE event_entry_credentials (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE REFERENCES events(id) ON DELETE CASCADE,
  secret_digest TEXT NOT NULL,
  secret_ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL,
  disabled_at TEXT
);
```

Do not insert entry rows for old events.

- [ ] **Step 4: Add household, invitee, session, and rate-limit SQL**

Use these ownership and consistency constraints:

```sql
CREATE TABLE rsvp_households (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  household_key TEXT NOT NULL,
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_submission_key TEXT,
  last_submission_digest TEXT,
  last_submission_result_version INTEGER,
  first_responded_at TEXT,
  latest_responded_at TEXT,
  latest_actor_kind TEXT CHECK (
    latest_actor_kind IS NULL OR latest_actor_kind IN ('household', 'host')
  ),
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (event_id, household_key),
  UNIQUE (event_id, id),
  CHECK (
    (last_submission_key IS NULL
      AND last_submission_digest IS NULL
      AND last_submission_result_version IS NULL)
    OR
    (last_submission_key IS NOT NULL
      AND last_submission_digest IS NOT NULL
      AND last_submission_result_version IS NOT NULL)
  )
);

CREATE TABLE rsvp_invitees (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  household_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('named', 'plus_one')),
  display_name TEXT CHECK (
    display_name IS NULL OR length(display_name) BETWEEN 1 AND 80
  ),
  lookup_digest TEXT,
  attendance TEXT NOT NULL DEFAULT 'pending'
    CHECK (attendance IN ('pending', 'attending', 'declined')),
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (event_id, household_id)
    REFERENCES rsvp_households(event_id, id) ON DELETE CASCADE,
  UNIQUE (household_id, sort_order),
  CHECK (
    (kind = 'named' AND display_name IS NOT NULL AND lookup_digest IS NOT NULL)
    OR
    (kind = 'plus_one' AND lookup_digest IS NULL
      AND (
        (attendance = 'attending' AND display_name IS NOT NULL)
        OR
        (attendance IN ('pending', 'declined') AND display_name IS NULL)
      ))
  )
);

CREATE INDEX rsvp_invitees_lookup
  ON rsvp_invitees(event_id, lookup_digest, kind);

CREATE TABLE rsvp_submission_receipts (
  event_id TEXT NOT NULL,
  household_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  result_version INTEGER NOT NULL CHECK (result_version >= 1),
  created_at TEXT NOT NULL,
  PRIMARY KEY (household_id, idempotency_key),
  FOREIGN KEY (event_id, household_id)
    REFERENCES rsvp_households(event_id, id) ON DELETE CASCADE
);

CREATE TABLE rsvp_sessions (
  id TEXT PRIMARY KEY,
  secret_digest TEXT NOT NULL,
  csrf_digest TEXT NOT NULL,
  event_id TEXT NOT NULL,
  household_id TEXT NOT NULL,
  write_authority_deadline TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (event_id, household_id)
    REFERENCES rsvp_households(event_id, id) ON DELETE CASCADE
);

CREATE INDEX rsvp_sessions_household
  ON rsvp_sessions(event_id, household_id, revoked_at, expires_at);
CREATE INDEX rsvp_sessions_cleanup
  ON rsvp_sessions(expires_at, revoked_at);

CREATE TABLE rsvp_lookup_rate_limits (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('lookup_ip', 'lookup_name')),
  scope_digest TEXT NOT NULL,
  window_started_at TEXT NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts >= 1),
  PRIMARY KEY (event_id, action, scope_digest, window_started_at)
);

CREATE INDEX rsvp_households_manager_page
  ON rsvp_households(event_id, archived_at, updated_at, id);
CREATE INDEX rsvp_lookup_rate_limits_cleanup
  ON rsvp_lookup_rate_limits(window_started_at);
```

- [ ] **Step 5: Add typed row mapping and narrow repositories**

Implement explicit snake_case row interfaces and camelCase mappers. Repositories
return records, expose statement builders for atomic event/import batches, and
do not perform authorization. The entry repository must expose:

```ts
createStatement(input: CreateEventEntryRecord): D1PreparedStatement;
getById(id: string): Promise<EventEntryRecord | null>;
getForEvent(eventId: string): Promise<EventEntryRecord | null>;
disableForEvent(eventId: string, disabledAt: string): Promise<boolean>;
```

The RSVP repository must expose lookup-by-digest, safe household views,
collision validation inputs, derived totals, paginated manager search, initial
import statement builders, and version-guarded mutation primitives. The session
repository must expose create/get/revoke for one household. The rate repository
must implement the existing atomic UPSERT pattern with a 15-minute bucket.
The RSVP repository also exposes receipt lookup/insert statement builders; a
receipt is never returned through a manager list or export.

- [ ] **Step 6: Prove statement binding bounds**

Add repository tests that build the worst-case 500-capacity import and inspect
the generated statement plan. Chunk rows by the real number of bound fields so
each prepared statement binds at most 100 values and the complete import stays
in one `DB.batch()`.

- [ ] **Step 7: Run worker tests, foreign-key proof, and commit**

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/migration-0008.test.ts tests/worker/repositories.test.ts
npm run typecheck
npm run lint
git diff --check
git add migrations/0008_event_rsvp.sql worker/db/types.ts worker/db/events.ts worker/db/event-entries.ts worker/db/rsvp.ts worker/db/rsvp-sessions.ts worker/db/rsvp-rate-limits.ts tests/worker/migration-0008.test.ts tests/worker/repositories.test.ts
git commit -m "feat: add RSVP launch schema"
```

Expected: focused Worker tests, typecheck, lint, and diff check pass.

---

### Task 3: Put the permanent printed entry in front of guest sessions

**Files:**

- Modify: `.dev.vars.example`
- Modify: `wrangler.jsonc`
- Modify: `worker-configuration.d.ts` via `npm run cf-typegen`
- Modify: `vitest.worker.config.ts`
- Modify: `worker/security/crypto.ts`
- Modify: `worker/auth/service.ts`
- Create: `worker/services/event-entry.ts`
- Modify: `worker/services/events.ts`
- Modify: `worker/services/links.ts`
- Create: `worker/routes/entry.ts`
- Modify: `worker/routes/exchange.ts`
- Modify: `worker/app.ts`
- Modify: `worker/routes/public.ts`
- Modify: `worker/routes/manage.ts`
- Modify: `src/app/router.tsx`
- Modify: `src/pages/CreatePage.tsx`
- Create: `src/pages/EventEntryPage.tsx`
- Create: `src/pages/EventEntryUnavailablePage.tsx`
- Modify: `src/pages/ManagerPage.tsx`
- Modify: `tests/ui/app.test.tsx`
- Create: `tests/ui/event-entry.test.tsx`
- Modify: `tests/ui/event-theme-creation.test.tsx`
- Modify: `tests/e2e/fixtures/routes.ts`
- Modify: `tests/e2e/accessibility.spec.ts`
- Modify: `tests/e2e/core-journey.spec.ts`
- Modify: `tests/e2e/public-responsive.spec.ts`
- Modify: `tests/worker/helpers.ts`
- Modify: `tests/worker/auth-api.test.ts`
- Modify: `tests/worker/event-theme-api.test.ts`
- Modify: `tests/worker/host-auth.test.ts`
- Modify: `tests/worker/manage-api.test.ts`
- Modify: `tests/worker/messages-api.test.ts`
- Modify: `tests/worker/security-headers.test.ts`
- Modify: `tests/worker/upload-api.test.ts`
- Create: `tests/worker/event-entry-api.test.ts`

**Interfaces:**

- Produces `AuthService.exchangeEntry(rawEntry, now)`.
- Produces `EventEntryService.recover(eventId)`,
  `rotateInternalGuestGrant(event, now)`, and
  `disable(event, now)`.
- Produces manager-only
  `POST /api/manage/events/:eventId/guest-sessions/rotate`.
- Renames the public creation/share response from `guestLink` to `eventLink`.
- Uses `/join#<entry-token>` as the printed URL,
  `POST /api/entry/exchange` as the secret-bearing exchange, and
  `/event/:slug` as the clean SPA destination.

- [ ] **Step 1: Write durable-entry exchange and lifecycle tests**

Cover this sequence in `tests/worker/event-entry-api.test.ts`:

1. create an event and capture `eventLink`;
2. open the join shell, strip the fragment, POST the token, and verify a
   token-free `/event/:slug` navigation plus event cookies;
3. rotate the internal guest grant;
4. assert the original `eventLink` string is unchanged and exchanges again;
5. assert the old event guest session is revoked;
6. emergency-disable the entry;
7. assert future exchanges return `EVENT_ENTRY_UNAVAILABLE`;
8. assert existing guest and RSVP sessions are revoked, uploads and RSVP are
   paused, and the manager session still works;
9. assert internal rotation and settings cannot reopen a disabled entry; and
10. assert missing/malformed fragments and disabled/expired POST exchanges end
    on a token-free unavailable page with typed API errors; and
11. assert security/no-store/referrer headers on the static join document and
    real Worker API success/failure responses.

Update auth tests to prove entry digest/ciphertext differ from the raw secret and
that manager recovery returns the identical event URL. Update UI integration
tests to prove Create encodes `eventLink`, Manager Share loads `/entry`, and the
old guest-link rotation control is gone. Add exact-expiry coverage proving
`exchangeEntry()` rejects a current internal guest row whose `expires_at` is not
in the future; `getActiveForRole()` filtering only `revoked_at` is not enough.
The `EventEntryPage` UI test must observe that the fragment is removed before
`fetch`, the fetch URL contains no credential, the token exists only in the JSON
body, and success uses replacement navigation.

- [ ] **Step 2: Run tests and verify the old rotatable-link behavior fails**

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/auth-api.test.ts tests/worker/manage-api.test.ts tests/worker/event-entry-api.test.ts
npx vitest run --config vitest.config.ts tests/ui/app.test.tsx tests/ui/event-entry.test.tsx
```

Expected: FAIL because creation still returns the rotatable guest access token
and no entry credential exists.

- [ ] **Step 3: Add dedicated entry secrets and generic encryption helpers**

Add these bindings to `.dev.vars.example`, `wrangler.jsonc`,
`vitest.worker.config.ts`, and generated types:

```dotenv
ENTRY_HMAC_KEY=replace-with-a-different-32-byte-or-longer-random-secret
ENTRY_ENCRYPTION_KEY=replace-with-32-random-bytes-encoded-as-base64url
RSVP_LOOKUP_HMAC_KEY=replace-with-another-32-byte-or-longer-random-secret
```

Refactor AES helpers to generic `encryptSecret()`/`decryptSecret()` and keep
backward-compatible aliases inside source for the existing encrypted internal
guest-token row. Generate types with:

```powershell
npm run cf-typegen
```

- [ ] **Step 4: Generate event entry atomically with event creation**

In `EventService.create()`, create an `entryToken` in addition to the internal
guest grant and manager token. Add its statement to the existing event creation
batch:

```ts
entries.createStatement({
  id: entryToken.id,
  eventId,
  secretDigest: await digestSecret(entryToken.secret, this.env.ENTRY_HMAC_KEY),
  secretCiphertext: await encryptSecret(
    entryToken.secret,
    this.env.ENTRY_ENCRYPTION_KEY,
  ),
  createdAt,
});
```

Return:

```ts
eventLink: `${origin}/join#${entryToken.token}`
```

Keep the internal guest access-token row because existing upload authorization
and `event_sessions.access_token_id` depend on it. Do not expose that token to
the browser or QR.

- [ ] **Step 5: Refactor guest-session minting and exchange the entry**

Extract the session creation half of `AuthService.exchange()` into a private
`createEventSession(event, token, role, now)` helper. Add
`exchangeEntry(rawEntry, now)` that:

- parses exactly `id.secret`;
- loads `event_entry_credentials`;
- rejects missing/disabled credentials with one
  `EVENT_ENTRY_UNAVAILABLE` response;
- constant-time verifies `ENTRY_HMAC_KEY`;
- loads and validates the event;
- selects the current non-revoked internal guest token and explicitly verifies
  `expiresAt > now`; and
- mints the ordinary guest event session against that token.

Create a same-origin API route:

```ts
entryRoutes.post('/entry/exchange', async (context) => {
  assertRequestOrigin(context);
  const { token } = entryExchangeSchema.parse(
    await context.req.json().catch(() => null),
  );
  const exchanged = await new AuthService(context.env)
    .exchangeEntry(token);
  const maxAge = sessionMaxAge(exchanged.session.expiresAt);
  setSessionCookies(
    context,
    'event',
    exchanged.sessionToken,
    exchanged.csrfToken,
    maxAge,
  );
  return context.json({
    data: { location: `/event/${exchanged.event.slug}` },
    requestId: context.get('requestId'),
  });
});
```

Register `entryRoutes` at `/api`. `/manage/:token` continues to use the existing
manager token exchange and recovery behavior. Remove the guest branch from
`worker/routes/exchange.ts`.

Add `EventEntryPage` at the static `/join` SPA route. It reads
`window.location.hash.slice(1)` once, immediately calls
`history.replaceState(null, '', '/join')`, then POSTs the in-memory token. On
success use `window.location.replace(location)`. On a missing/malformed fragment
or typed exchange failure, navigate with replacement to
`/recover/event-entry?kind=unavailable` and render a clear page explaining that
the event entry is no longer available. Add `/join` and the recovery path to
`wrangler.jsonc`. Do not place the rejected token in a request URL, query,
React state after exchange, log, error string, or page.

Keep a GET `/join/:token` legacy-path refusal only to remove an old credential
from the address bar with a token-free recovery redirect. It is not a
compatibility exchange and never accepts the old token.

- [ ] **Step 6: Recover the entry link and separate internal rotation from disable**

Replace `GET /api/manage/events/:eventId/links` with
`GET /api/manage/events/:eventId/entry`; authorize it with `requireManager()`,
decrypt only that event's entry ciphertext, and return:

```ts
{
  eventLink: entry.disabledAt
    ? null
    : `${origin}/join#${entry.id}.${secret}`,
  disabledAt: entry.disabledAt,
}
```

Remove the public guest-link replacement behavior. Retain manager-link
rotation. Rename the guest branch in `LinkService` to
`rotateInternalGuestGrant()` and expose it only as the manager-CSRF-protected
`/guest-sessions/rotate` operation with exact event-name confirmation and copy
that it signs out guest devices without changing the printed QR. Return
`{ rotated: true, eventLink }` and prove the link string is identical.

Add `POST /api/manage/events/:eventId/entry/disable` with manager CSRF and exact
event-name confirmation. Its one D1 batch:

- sets `event_entry_credentials.disabled_at`;
- sets `events.uploads_enabled = 0` and `events.rsvp_enabled = 0`;
- revokes active guest `event_access_tokens` and guest `event_sessions`; and
- revokes all active `rsvp_sessions` for the event.

If already disabled, return the same successful disabled state without changing
the timestamp.

Both `rotateInternalGuestGrant()` and every settings path that would enable RSVP
or uploads query `event_entry_credentials.disabled_at` in their guarded write
and return `EVENT_ENTRY_UNAVAILABLE` after disable. Manager/account authority
must not bypass the irreversible entry state.

- [ ] **Step 7: Rename creation/share fixtures without compatibility aliases**

Change creation payloads, `eventAccess()`, `CreatePage`, Manager Share,
UI/browser fixtures, and assertions from `guestLink` to `eventLink`. Point the
Manager's initial share request at `/entry`, remove the guest-link rotation
button, and keep manager-link rotation unchanged. Do not return both response
fields and do not accept an old guest access token at `/join`.

Worker helpers exchange the fragment explicitly rather than calling
`new URL(eventLink).pathname`, which intentionally excludes it:

```ts
const entry = new URL(body.data.eventLink);
const guestExchange = await createApp().request('/api/entry/exchange', {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin },
  body: JSON.stringify({ token: entry.hash.slice(1) }),
}, testEnv);
```

Update every direct consumer in the same commit, including event-theme,
host-auth, message, upload, accessibility, core-journey, and public-responsive
tests plus the wedding load harness. Leave historical plan prose unchanged.

- [ ] **Step 8: Run focused tests and commit**

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/auth-api.test.ts tests/worker/event-theme-api.test.ts tests/worker/host-auth.test.ts tests/worker/manage-api.test.ts tests/worker/messages-api.test.ts tests/worker/security-headers.test.ts tests/worker/upload-api.test.ts tests/worker/event-entry-api.test.ts
npx vitest run --config vitest.config.ts tests/ui/app.test.tsx tests/ui/event-entry.test.tsx tests/ui/event-theme-creation.test.tsx
npx tsc -p tsconfig.e2e.json --pretty false
npm run typecheck
npm run lint
git diff --check
git add .dev.vars.example wrangler.jsonc worker-configuration.d.ts vitest.worker.config.ts worker/security/crypto.ts worker/auth/service.ts worker/services/event-entry.ts worker/services/events.ts worker/services/links.ts worker/routes/entry.ts worker/routes/exchange.ts worker/app.ts worker/routes/public.ts worker/routes/manage.ts src/app/router.tsx src/pages/CreatePage.tsx src/pages/EventEntryPage.tsx src/pages/EventEntryUnavailablePage.tsx src/pages/ManagerPage.tsx scripts/wedding-load-harness.mjs tests/ui/app.test.tsx tests/ui/event-entry.test.tsx tests/ui/event-theme-creation.test.tsx tests/e2e/fixtures/routes.ts tests/e2e/accessibility.spec.ts tests/e2e/core-journey.spec.ts tests/e2e/public-responsive.spec.ts tests/worker/helpers.ts tests/worker/auth-api.test.ts tests/worker/event-theme-api.test.ts tests/worker/host-auth.test.ts tests/worker/manage-api.test.ts tests/worker/messages-api.test.ts tests/worker/security-headers.test.ts tests/worker/upload-api.test.ts tests/worker/event-entry-api.test.ts
git commit -m "feat: make event entry QR durable"
```

Expected: same-link rotation, disable, auth, typecheck, lint, and diff checks
pass.

---

### Task 4: Create events with server-owned RSVP configuration and phase

**Files:**

- Modify: `worker/db/events.ts`
- Modify: `worker/db/types.ts`
- Modify: `worker/services/events.ts`
- Modify: `worker/routes/public.ts`
- Modify: `worker/routes/manage.ts`
- Modify: `worker/http/event-view.ts`
- Modify: `worker/routes/event.ts`
- Create: `worker/services/rsvp.ts`
- Modify: `src/pages/CreatePage.tsx`
- Modify: `src/pages/ManagerPage.tsx`
- Modify: `tests/worker/core-journey.test.ts`
- Modify: `tests/worker/manage-api.test.ts`
- Modify: `tests/ui/app.test.tsx`
- Modify: `tests/e2e/fixtures/routes.ts`
- Modify: `tests/e2e/public-responsive.spec.ts`
- Modify: `tests/e2e/manager-responsive.spec.ts`
- Modify: `src/styles.css`

**Interfaces:**

- Creation accepts `eventTimezone` and `rsvpDeadlineDate`.
- Manager settings accept `eventTimezone`, `rsvpDeadlineDate`,
  `rsvpEnabled`, and existing independent photo/gallery controls.
- `eventView()` exposes manager configuration.
- `guestEventView(event, now)` exposes only absolute deadline, RSVP state, and
  server-computed phase.

- [ ] **Step 1: Write failing create, settings, and phase integration tests**

Extend Worker tests to prove:

- a valid Chicago deadline date is stored as the exact absolute end-of-day;
- an invented time zone, impossible date, and deadline after the event date
  return field errors;
- a new event has `uploadsEnabled: false`, `rsvpEnabled: false`,
  `rsvpRosterVersion: 0`, and the selected time zone/deadline;
- a guest in `Pacific/Auckland` still receives the Chicago
  `rsvpDeadlineDate` selected by the host rather than a browser-local date;
- enabling RSVP with no roster returns `RSVP_ROSTER_INVALID`;
- Manager Settings sends the current roster version, associates zone/deadline/
  activation errors with their controls, and focuses the first invalid field;
- uploads may be enabled independently;
- `guestEventView` changes phase at the exact server deadline; and
- changing a deadline does not trust any timestamp from the browser beyond the
  date and time-zone fields.

Update `tests/ui/app.test.tsx` so Create focus moves through:

```ts
const CREATE_FIELDS = [
  'name',
  'eventDate',
  'eventTimezone',
  'rsvpDeadlineDate',
  'welcomeMessage',
] as const;
```

- [ ] **Step 2: Run focused tests and verify missing fields**

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/core-journey.test.ts tests/worker/manage-api.test.ts
npx vitest run --config vitest.config.ts tests/ui/app.test.tsx
```

Expected: FAIL because event configuration and wire phase fields are absent.

- [ ] **Step 3: Extend event persistence and creation**

Add these fields to `CreateEventRecord`, its insert statement, `EventRow`,
`mapEvent()`, and `EventRecord`:

```ts
eventTimezone: string;
rsvpEnabled: boolean;
rsvpDeadlineAt: string | null;
rsvpRosterVersion: number;
```

`EventsRepository.createStatement()` must explicitly insert
`uploads_enabled = 0`, `rsvp_enabled = 0`, the selected zone, and the derived
deadline rather than relying on the old upload default.

In `worker/routes/public.ts`, validate:

```ts
eventTimezone: z.string().min(1).max(64)
  .refine(isIanaTimeZone, 'Choose a valid time zone.'),
rsvpDeadlineDate: z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, 'Choose a valid RSVP deadline.'),
```

After schema parsing, reject `rsvpDeadlineDate > eventDate`, call
`endOfLocalDate()`, and pass the resulting absolute value into
`EventService.create()`.

- [ ] **Step 4: Return an explicit server phase**

Extend `EventView` with the full manager configuration fields. Extend the
narrow `GuestEventView` only with the safe display/phase fields:

```ts
rsvpDeadlineAt: string | null;
rsvpDeadlineDate: string | null;
eventTimezone: string;
rsvpState: RsvpState;
phase: GuestEventPhase;
```

Change the view signature to:

```ts
export function guestEventView(
  event: EventRecord,
  now = new Date(),
): GuestEventView {
  const phase = resolveGuestEventPhase(event, now);
  return {
    id: event.id,
    slug: event.slug,
    name: event.name,
    eventDate: event.eventDate,
    welcomeMessage: event.welcomeMessage,
    coverObjectKey: event.coverObjectKey,
    uploadsEnabled: event.uploadsEnabled,
    galleryVisible: event.galleryVisible,
    moderationRequired: event.moderationRequired,
    rsvpDeadlineAt: event.rsvpDeadlineAt,
    rsvpDeadlineDate: event.rsvpDeadlineAt
      ? localDateForInstant(event.rsvpDeadlineAt, event.eventTimezone)
      : null,
    eventTimezone: event.eventTimezone,
    ...phase,
    theme: resolvedThemeView(event.themeConfig),
  };
}
```

Keep the explicit allowlist; never spread `EventRecord`.

- [ ] **Step 5: Make manager settings validate RSVP activation atomically**

Extend the settings schema with the time-zone/deadline inputs and RSVP toggle.
Implement `RsvpService.assertRosterCanOpen(eventId)` to derive active capacity
and collision status at the moment of enabling. Then update the event with one
guarded statement that rechecks the roster version returned by that same
server-side validation read. Treat the client's `rsvpRosterVersion` only as an
early stale-view signal; it must not replace the server validation/CAS value.

For a deadline edit, store the new absolute end-of-day. Do not update existing
RSVP session deadlines; Task 7 enforces the earlier session/event deadline.

- [ ] **Step 6: Add accessible Create controls and durable-QR copy**

In `CreatePage`:

- default `eventTimezone` to
  `Intl.DateTimeFormat().resolvedOptions().timeZone`, falling back to `UTC`;
- render a validated searchable time-zone text input with a `<datalist>` filled
  by `Intl.supportedValuesOf('timeZone')` where available; a browser without
  that API still permits the host to type any server-validated IANA zone;
- render a required RSVP deadline date;
- send both values;
- generate the QR from `created.eventLink`;
- label it **Event QR code** and describe that the same code handles RSVP and
  event photos; and
- label the share card **Event link**, not **Guest link**.

Preserve the proven WebKit rule `width: auto; min-width: 0` for both native date
inputs. Use `width: 100%; min-width: 0` for the time-zone text input, and do not
reproduce the prior iOS native-date overflow.

Add the matching event time-zone, RSVP deadline, and **Accept RSVPs** controls
to Manager Settings. Submit the complete settings payload, display roster
activation failures next to the RSVP toggle, and keep **Accept private photo
deliveries** independent. Populate the deadline input from the returned
`rsvpDeadlineDate`, never by formatting the absolute instant in the host
browser's zone. Include `rsvpRosterVersion`, focus the first invalid settings
control, and refresh the phase/event view after success.

On the Create receipt, explain **RSVP is paused until you add and validate the
guest list**. Task 9 adds the direct RSVP-panel action in the same commit that
the new Manager section becomes routable.

- [ ] **Step 7: Update fixtures and prove responsive creation**

Give every `EVENT_FIXTURE`/`GUEST_EVENT_FIXTURE` an explicit phase, deadline,
RSVP state, and manager time zone. Add a 320px Playwright case that checks no
horizontal overflow, 44px controls, the detected time-zone field, both dates,
and focus on a server-returned deadline error.

- [ ] **Step 8: Run focused tests and commit**

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/core-journey.test.ts tests/worker/manage-api.test.ts
npx vitest run --config vitest.config.ts tests/ui/app.test.tsx
npx playwright test tests/e2e/public-responsive.spec.ts tests/e2e/manager-responsive.spec.ts --project=mobile
npx tsc -p tsconfig.e2e.json --pretty false
npm run typecheck
npm run lint
git diff --check
git add worker/db/events.ts worker/db/types.ts worker/services/events.ts worker/services/rsvp.ts worker/routes/public.ts worker/routes/manage.ts worker/http/event-view.ts worker/routes/event.ts src/pages/CreatePage.tsx src/pages/ManagerPage.tsx src/styles.css tests/worker/core-journey.test.ts tests/worker/manage-api.test.ts tests/ui/app.test.tsx tests/e2e/fixtures/routes.ts tests/e2e/public-responsive.spec.ts tests/e2e/manager-responsive.spec.ts
git commit -m "feat: configure server-owned RSVP phases"
```

Expected: create, settings, phase, responsive, type, lint, and diff checks pass.

---

### Task 5: Build preview-then-commit roster import

**Files:**

- Modify: `worker/services/rsvp.ts`
- Create: `worker/routes/manage-rsvp.ts`
- Modify: `worker/app.ts`
- Create: `tests/worker/rsvp-import-api.test.ts`
- Modify: `tests/worker/helpers.ts`
- Create: `docs/rsvp-csv.md`

**Interfaces:**

- `POST /api/manage/events/:eventId/rsvp/import/preview`
- `POST /api/manage/events/:eventId/rsvp/import/commit`
- `RsvpService.previewImport(event, csv)`
- `RsvpService.commitInitialImport(event, input)`

- [ ] **Step 1: Write import preview and atomic-commit tests**

Create `tests/worker/rsvp-import-api.test.ts` with:

- exact four-column CSV success and totals;
- optional UTF-8 BOM and quoted field success;
- wrong headers, malformed quoting, duplicate row, invalid key/name/count,
  inconsistent repeated label/count, within-household normalized duplicate, and
  plus-one-only household and unresolvable cross-household collision failures;
- preview writes zero rows on every error;
- source digest changes when one byte changes;
- commit reparses the CSV and checks both digest and expected roster version;
- a changed roster/version returns `RSVP_IMPORT_CONFLICT` with zero partial rows;
- import is rejected while RSVP is enabled or any household row exists;
- a full 500-capacity roster commits atomically; and
- no generated D1 statement exceeds 100 bindings.

Use a collision fixture with identical single-person `Alex Lee` households and
a resolvable fixture where a second named household member uniquely intersects.

- [ ] **Step 2: Run the import suite and verify route absence**

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/rsvp-import-api.test.ts
```

Expected: FAIL because manager RSVP routes and service do not exist.

- [ ] **Step 3: Implement versioned preview output**

`previewImport()` must:

1. enforce the byte limit before parsing;
2. parse and normalize all rows;
3. compute lookup digests with:

```ts
await digestSecret(
  `rsvp-name:v1:${event.id}:${normalizeInvitedName(name)}`,
  this.env.RSVP_LOOKUP_HMAC_KEY,
);
```

4. run collision resolvability for every household/name combination;
5. return ordered issues as
   `{ row, field, code, message, blocking: true }`;
6. derive household, named, plus-one, and total-capacity counts; and
7. return a SHA-256 `sourceDigest` plus the current
   `event.rsvpRosterVersion`.

Preview returns `200` even with blocking issues because the issues are the
preview result. It performs no D1 write.

- [ ] **Step 4: Implement one guarded initial commit**

Commit accepts the original `csv`, `sourceDigest`, and
`expectedRosterVersion`. Reparse and recompute everything server-side. Refuse
blocking issues or a changed digest.

Make the first statement deliberately fail the NOT NULL constraint if the event
is stale, enabled, or non-empty, so `DB.batch()` rolls back all later inserts:

```sql
UPDATE events
SET rsvp_roster_version = CASE
  WHEN rsvp_roster_version = ?
    AND rsvp_enabled = 0
    AND NOT EXISTS (
      SELECT 1 FROM rsvp_households WHERE event_id = events.id
    )
  THEN rsvp_roster_version + 1
  ELSE NULL
END
WHERE id = ?
```

`rsvp_roster_version` is NOT NULL, so an invalid guard aborts rather than
silently allowing later statements. Follow it with chunked multi-row household
and invitee inserts. Generate stable UUIDs and order before building statements;
submit the guard and every chunk in one `DB.batch()`.

Catch only the expected guard/constraint outcome and translate it to
`RSVP_IMPORT_CONFLICT`; unexpected D1 failures remain internal errors.

- [ ] **Step 5: Register manager routes with existing authorization**

Both routes call:

```ts
const auth = await requireManager(context, { write: true });
```

Use Zod to cap CSV string length as defense in depth, never log parse errors with
row contents, and return only counts/issues/digests. Register
`manageRsvpRoutes` under `/api` in `worker/app.ts`.

- [ ] **Step 6: Publish the exact CSV contract**

Create `docs/rsvp-csv.md` with:

- UTF-8/BOM/file limits;
- the exact header and one-row-per-named-invitee rule;
- lowercase stable-key grammar;
- repeated household consistency;
- 500/20/10/30 limits;
- lookup normalizer and collision examples;
- preview/commit semantics;
- a valid sample:

```csv
household_key,household_label,invitee_name,plus_one_slots
perkins,Perkins household,Henry Perkins,1
perkins,Perkins household,Jordan Perkins,1
rivera,Rivera household,Avery Rivera,0
```

- the rule that import never synchronizes or overwrites a response; and
- formula-safety behavior for later export.

- [ ] **Step 7: Run focused tests and commit**

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/rsvp-import-api.test.ts
npm run typecheck
npm run lint
git diff --check
git add worker/services/rsvp.ts worker/routes/manage-rsvp.ts worker/app.ts tests/worker/rsvp-import-api.test.ts tests/worker/helpers.ts docs/rsvp-csv.md
git commit -m "feat: import RSVP household rosters"
```

Expected: malformed previews write nothing, the 500-person commit is atomic,
and all checks pass.

---

### Task 6: Add private exact-name lookup and household authority

**Files:**

- Modify: `wrangler.jsonc`
- Modify: `worker-configuration.d.ts` via `npm run cf-typegen`
- Modify: `vitest.worker.config.ts`
- Modify: `worker/http/cookies.ts`
- Modify: `worker/http/csrf.ts`
- Create: `worker/http/client-ip.ts`
- Modify: `worker/routes/host-auth.ts`
- Modify: `src/app/api.ts`
- Create: `worker/auth/rsvp.ts`
- Create: `worker/routes/rsvp.ts`
- Modify: `worker/app.ts`
- Modify: `worker/services/rsvp.ts`
- Create: `tests/worker/rsvp-lookup-api.test.ts`
- Modify: `tests/worker/helpers.ts`
- Modify: `tests/worker/host-auth-boundary.test.ts`
- Modify: `tests/unit/security.test.ts`

**Interfaces:**

- `POST /api/event/:slug/rsvp/lookup`
- `GET /api/event/:slug/rsvp/household`
- `RsvpAuthService.create()` and `RsvpAuthService.resolve()`
- Cookie scope `rsvp`
- Cloudflare binding `RSVP_LOOKUP_RATE_LIMIT`

- [ ] **Step 1: Write lookup privacy, rate-limit, and cookie-scope tests**

Cover:

- full exact named match issues one household session;
- partial, diacritic-folded, plus-one, archived, and cross-event names do not
  match;
- miss and blocked/paused responses share the same generic body;
- an ambiguous first name returns only `second_name_required`;
- the second request resubmits both names and resolves by set intersection;
- no response includes candidate IDs, household labels, or guest names before
  successful resolution;
- impossible collisions keep RSVP activation blocked;
- post-deadline lookup returns a prior response read-only but does not reveal a
  never-responded household;
- event, RSVP, and host cookies can coexist;
- RSVP CSRF cannot authorize event/upload or host writes, and the other CSRF
  tokens cannot authorize RSVP writes;
- one household session cannot read a different household or event;
- edge limiting runs before JSON/name parsing or D1 lookup; and
- D1 IP/name boundaries return generic `429` plus `Retry-After` without storing
  raw IP/name values; and
- only `CF-Connecting-IP` defines the client scope: spoofed
  `X-Forwarded-For`/`Forwarded` values are ignored and a missing Cloudflare
  header uses the single literal `unknown` before HMAC.

- [ ] **Step 2: Run the lookup suite and verify missing scope/routes**

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/rsvp-lookup-api.test.ts
```

Expected: FAIL because the rate binding, RSVP scope, auth service, and routes do
not exist.

- [ ] **Step 3: Add the edge binding and generated types**

Append a second rate binding in `wrangler.jsonc`:

```jsonc
{
  "name": "RSVP_LOOKUP_RATE_LIMIT",
  "namespace_id": "1002",
  "simple": {
    "limit": 30,
    "period": 60
  }
}
```

Add the matching test binding and run:

```powershell
npm run cf-typegen
```

- [ ] **Step 4: Add the third cookie and CSRF pair**

Extend `CookieScope` and `COOKIE_NAMES`:

```ts
export type CookieScope = 'event' | 'host' | 'rsvp';

rsvp: {
  session: 'candidary_rsvp',
  csrf: 'candidary_rsvp_csrf',
},
```

`assertCsrf()` selects `X-Candidary-RSVP-CSRF` for the RSVP scope.
`src/app/api.ts` offers all three CSRF headers on non-GET requests; each server
route validates only its accepted credential.

- [ ] **Step 5: Implement RSVP session minting and resolution**

`RsvpAuthService.create(event, household, now)`:

- creates independent session and CSRF secrets;
- stores only `SESSION_HMAC_KEY` digests;
- captures the current event RSVP deadline as `writeAuthorityDeadline`;
- expires at `event.guestAccessExpiresAt`; and
- sets the RSVP cookie pair with that max age.

`resolve()` constant-time verifies the secret, expiry, revocation, event,
household, archive, and event deletion. It returns current event and household
records; it does not grant an event guest role or manager authority.

- [ ] **Step 6: Apply edge then durable limits before lookup**

The route order is normative:

```ts
await assertLookupEdgeBoundary(context);       // no body parse or D1
const eventAuth = await eventGuestForSlug(context);
const body = lookupSchema.parse(await context.req.json());
await rsvp.reserveLookupAttempts(eventAuth.event, clientIp(context), body);
const result = await rsvp.lookup(eventAuth.event, body);
```

Hash the edge key as
`rsvp-edge:v1:lookup:ip:${clientIp(context)}` with
`RSVP_LOOKUP_HMAC_KEY`. The D1
repository reserves one `lookup_ip` scope and one `lookup_name` scope per
submitted normalized name. Set `Retry-After: 60` for edge refusal and `900` for
D1 refusal.

Define `eventGuestForSlug()` locally in `worker/routes/rsvp.ts` with the same
event-cookie, guest-role, slug-equality, and event-CSRF checks used by
`worker/routes/uploads.ts`; do not let an RSVP household cookie satisfy it.

Create `worker/http/client-ip.ts` with one `clientIp(context)` helper that reads
only trimmed `CF-Connecting-IP` or returns `unknown`. Replace the local host-auth
extractor with this helper too, so both abuse boundaries share the hardened
source and spoofing tests.

- [ ] **Step 7: Implement exact lookup and non-enumerating responses**

For the first name, query only the keyed digest and active named rows. Return:

```ts
{ status: 'second_name_required' }
```

only when more than one household matches. For two names, intersect household
IDs server-side and issue authority only when exactly one remains. On success,
set RSVP cookies and return the safe household view.

Use one generic successful HTTP shape for no match, paused, unresolved second
name, archived, and post-deadline households with no saved response:

```ts
{
  status: 'not_available',
  message: 'We could not open an invitation with those details.',
}
```

Do not return lookup digests, internal keys, event totals, or alternate names.

- [ ] **Step 8: Implement returning-device reads**

`GET /rsvp/household` resolves only the RSVP cookie and returns the current safe
household view. `editable` is true only when:

- RSVP is currently enabled;
- the current event deadline has not passed; and
- the captured session deadline has not passed.

Set `renewalRequired: true` only when the event is currently open but the
session's earlier captured write deadline has passed. The guest UI then offers
**Find my invitation again**; a successful exact lookup replaces the RSVP cookie
with the extended write window.

Paused/closed sessions may still read a prior response. A revoked/expired
household session returns `RSVP_SESSION_REQUIRED` so the UI goes back to exact
lookup.

- [ ] **Step 9: Run focused tests and commit**

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/rsvp-lookup-api.test.ts tests/worker/host-auth-boundary.test.ts
npx vitest run --config vitest.config.ts tests/unit/security.test.ts
npm run typecheck
npm run lint
git diff --check
git add wrangler.jsonc worker-configuration.d.ts vitest.worker.config.ts worker/http/cookies.ts worker/http/csrf.ts worker/http/client-ip.ts worker/routes/host-auth.ts src/app/api.ts worker/auth/rsvp.ts worker/routes/rsvp.ts worker/app.ts worker/services/rsvp.ts tests/worker/rsvp-lookup-api.test.ts tests/worker/host-auth-boundary.test.ts tests/worker/helpers.ts tests/unit/security.test.ts
git commit -m "feat: authorize household RSVP lookup"
```

Expected: privacy, scope isolation, rate limits, typecheck, lint, and diff checks
pass.

---

### Task 7: Commit household responses and host roster changes without overwrite

**Files:**

- Modify: `worker/db/rsvp.ts`
- Create: `worker/http/rsvp-cursor.ts`
- Modify: `worker/services/rsvp.ts`
- Modify: `worker/routes/rsvp.ts`
- Modify: `worker/routes/manage-rsvp.ts`
- Create: `tests/worker/rsvp-submission-api.test.ts`
- Create: `tests/worker/rsvp-manage-api.test.ts`

**Interfaces:**

- `PUT /api/event/:slug/rsvp/household`
- `GET /api/manage/events/:eventId/rsvp/summary`
- `GET /api/manage/events/:eventId/rsvp/households`
- `GET /api/manage/events/:eventId/rsvp/households/:householdId`
- `POST /api/manage/events/:eventId/rsvp/households`
- `PUT /api/manage/events/:eventId/rsvp/households/:householdId`
- `PUT /api/manage/events/:eventId/rsvp/households/:householdId/response`
- `POST /api/manage/events/:eventId/rsvp/households/:householdId/archive`
- `GET /api/manage/events/:eventId/rsvp/export.csv`

- [ ] **Step 1: Write submission, replay, conflict, and deadline tests**

Cover:

- all-attend, all-decline, and mixed named/plus-one households;
- a required choice for every row;
- attending plus-one name length 1-80 and declined plus-one name clearing;
- no new IDs, omitted IDs, duplicates, or capacity overflow;
- exact deadline millisecond success and next-millisecond read-only response;
- RSVP pause during editing;
- current deadline shortening overrides a later captured session deadline;
- extension requires a new lookup;
- lost-response replay of any previously successful key and payload, including
  after a later household or host version;
- same key/different canonical payload conflict;
- simultaneous household/household and household/host versions never silently
  overwrite; and
- a conflict response contains only the current safe household view.

- [ ] **Step 2: Write manager roster, totals, archive, and export tests**

Cover manual create/edit/rename, post-response removal refusal, stable plus-one
growth/shrink rules, collision validation on every edit, host correction after
deadline, version advancement, active-only totals, query/state filters,
pagination, archive/session revocation, archived export marking, pending rows,
formula neutralization, ISO UTC timestamps, event time zone, filename, content
type, and `Content-Disposition`. Manual create/edit and RSVP activation must
also reject any active household left with zero named invitees. Pagination
tests include malformed, non-UUID, non-ISO, oversized, cross-filter, and
end-of-list cursors.

- [ ] **Step 3: Run both suites and verify missing behavior**

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/rsvp-submission-api.test.ts tests/worker/rsvp-manage-api.test.ts
```

Expected: FAIL because RSVP submissions and manager CRUD/export routes are not
implemented.

- [ ] **Step 4: Canonicalize and digest household submissions**

Validate the submitted ID set against the complete active household view, sort
by stable `sort_order`, clear declined plus-one names, and serialize only:

```ts
{
  version,
  invitees: canonicalInvitees.map(({ id, attendance, displayName }) => ({
    id,
    attendance,
    displayName,
  })),
}
```

Hash that deterministic JSON with SHA-256. Before writing:

- an existing receipt with the same key/digest returns
  `{ replayed: true, committedVersion, household: currentSafeView }`;
- an existing receipt with the same key/different digest returns
  `RSVP_SUBMISSION_CONFLICT`; and
- a stale version with no matching successful receipt returns
  `RSVP_HOUSEHOLD_CONFLICT`.

- [ ] **Step 5: Update all invitees and the household in one guarded batch**

Pass the canonical rows as one JSON binding and use `json_each()` so household
size does not approach D1's parameter limit:

```sql
WITH submitted AS (
  SELECT
    json_extract(value, '$.id') AS id,
    json_extract(value, '$.attendance') AS attendance,
    json_extract(value, '$.displayName') AS display_name
  FROM json_each(?)
)
UPDATE rsvp_invitees
SET attendance = (
      SELECT attendance FROM submitted WHERE submitted.id = rsvp_invitees.id
    ),
    display_name = CASE
      WHEN kind = 'named' THEN display_name
      WHEN (
        SELECT attendance FROM submitted WHERE submitted.id = rsvp_invitees.id
      ) = 'attending'
      THEN (
        SELECT display_name FROM submitted WHERE submitted.id = rsvp_invitees.id
      )
      ELSE NULL
    END,
    updated_at = ?
WHERE event_id = ?
  AND household_id = ?
  AND id IN (SELECT id FROM submitted)
  AND (
    SELECT version FROM rsvp_households
    WHERE id = ? AND archived_at IS NULL
  ) = ?
  AND EXISTS (
    SELECT 1 FROM events
    WHERE id = rsvp_invitees.event_id
      AND deleted_at IS NULL
      AND rsvp_enabled = 1
      AND rsvp_deadline_at >= ?
  )
  AND EXISTS (
    SELECT 1 FROM rsvp_sessions
    WHERE id = ?
      AND event_id = rsvp_invitees.event_id
      AND household_id = rsvp_invitees.household_id
      AND revoked_at IS NULL
      AND expires_at >= ?
      AND write_authority_deadline >= ?
  )
```

The following household update checks `changes() === expectedInviteeCount`. Set
`version = NULL` on a count mismatch so the NOT NULL constraint aborts and rolls
back the batch; otherwise increment version and set key/digest/result,
first/latest timestamps, and actor. Inspect both batch result counts. On a
concurrent loss, reload and apply the receipt replay/conflict rules.

Append a receipt insert to the same batch:

```sql
INSERT INTO rsvp_submission_receipts (
  event_id, household_id, idempotency_key, request_digest,
  result_version, created_at
) VALUES (?, ?, ?, ?, ?, ?)
```

The receipt's `result_version` is the household version committed by this
batch. If a concurrent identical request wins the receipt key, catch the unique
constraint, reload the receipt, and return replay success only when its digest
matches. Receipt rows are retained until the event cascade and are not a
manager-facing revision log.

Household writes also check the current event `rsvp_enabled` and deadline plus
the session's captured deadline inside the guarded SQL, using one server-owned
`nowIso` binding for every comparison. A deadline/pause race therefore changes
zero invitee rows and rolls the complete batch back; it is not merely a
read-before-write service check.

- [ ] **Step 6: Implement versioned host operations**

All manager mutations call `requireManager(context, { write: true })`, accept
`expectedVersion` or `expectedRosterVersion`, rerun collision/capacity
validation, and increment `events.rsvp_roster_version`.

Rules:

- manual creation assigns stable IDs/order and starts pending;
- a responded household edit cannot remove a named row or leave a newly added
  row pending;
- rename preserves attendance and recomputes the named lookup digest;
- plus-one reduction removes highest-order declined/pending slots only;
- host response correction uses the same canonical batch with actor `host` but
  bypasses the guest deadline;
- archive sets `archived_at`, advances versions, and revokes household sessions;
  and
- no route hard-deletes or restores a household.

- [ ] **Step 7: Implement server-derived summaries, search, and CSV**

Derive active totals directly from invitee rows:

```ts
{
  invitedCapacity,
  namedInvitees,
  plusOneCapacity,
  attending,
  declined,
  awaitingResponse,
  householdsResponded,
  householdsAwaitingResponse,
}
```

A household is responded when it has no pending active row; otherwise it is
awaiting. Search stored display text with escaped `LIKE` across household labels
and every non-null named/plus-one display name, filter by `responded`,
`awaiting`, or `archived`, and paginate 50 at a time with a stable
`(updated_at, id)` cursor.

Create `worker/http/rsvp-cursor.ts` parallel to `media-cursor.ts`, with a strict
Zod payload `{ updatedAt: z.iso.datetime({ offset: true }), id: z.uuid() }`,
base64url encoding, a 512-character input cap, and one
`VALIDATION_FAILED` error for every malformed form. A cursor is only a position;
the current query/state filters remain explicit request parameters and are
reapplied to the page query.

Export one row per named invitee/plus-one slot with exact columns:

```text
household_key,household_label,household_archived_at,member_kind,member_name,attendance,member_order,household_version,first_responded_at,last_responded_at,last_actor,event_timezone
```

Include pending and archived rows, use `csvCell()`, ISO UTC timestamps, and
`<slug>-rsvp-<YYYY-MM-DD>.csv`, where the filename date is the current
calendar date in `eventTimezone`.

- [ ] **Step 8: Run focused tests and commit**

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/rsvp-submission-api.test.ts tests/worker/rsvp-manage-api.test.ts
npm run typecheck
npm run lint
git diff --check
git add worker/db/rsvp.ts worker/http/rsvp-cursor.ts worker/services/rsvp.ts worker/routes/rsvp.ts worker/routes/manage-rsvp.ts tests/worker/rsvp-submission-api.test.ts tests/worker/rsvp-manage-api.test.ts
git commit -m "feat: save and manage household RSVPs"
```

Expected: submission, replay, conflict, deadline, host, export, type, lint, and
diff checks pass.

---

### Task 8: Build the mobile household RSVP journey around the photo flow

**Files:**

- Create: `src/features/rsvp/rsvp-form.ts`
- Create: `src/features/rsvp/GuestRsvpFlow.tsx`
- Create: `src/features/rsvp/RsvpLookup.tsx`
- Create: `src/features/rsvp/RsvpHouseholdForm.tsx`
- Create: `src/features/rsvp/RsvpReceipt.tsx`
- Modify: `src/pages/EventPage.tsx`
- Modify: `src/styles.css`
- Create: `tests/ui/guest-rsvp-flow.test.tsx`
- Modify: `tests/ui/event-theme-rendering.test.tsx`
- Modify: `tests/ui/app.test.tsx`
- Modify: `tests/e2e/fixtures/routes.ts`
- Modify: `tests/e2e/guest-responsive.spec.ts`
- Modify: `tests/e2e/accessibility.spec.ts`

**Interfaces:**

- `GuestRsvpFlow({ event, presentation })`, where `presentation` is
  `'primary' | 'secondary' | 'read-only'`.
- Pure `validateHouseholdDraft(household, draft)`
- `EventPage` composes RSVP-primary, photos-primary, and waiting states from the
  server-provided phase.

- [ ] **Step 1: Write focused guest-flow component tests**

Create `tests/ui/guest-rsvp-flow.test.tsx` to cover:

- first exact-name lookup with semantic `autoComplete="name"` but no roster
  suggestion/listbox UI and no request while typing;
- generic no-match;
- ambiguous lookup moving focus to a second full-name field without names or
  household choices;
- second-name success;
- returning-device session recovery via `GET /household`;
- named rows and fixed plus-one slots as labelled native radio groups;
- all-attend, all-decline, and mixed drafts;
- attending plus-one conditional name; declined plus-one payload clearing;
- first incomplete row focus and associated inline error;
- live household counts without event-wide totals;
- explicit **Submit RSVP** and no network write before it;
- dropped save preserving the draft and stable idempotency key for retry;
- successful **You're all set** receipt and **Change RSVP**;
- stale-version current-view refresh requiring review rather than overwrite;
- deadline-crossed read-only receipt;
- deadline extension showing **Find my invitation again**, then restoring edit
  authority only after exact lookup;
- paused state retaining a previously saved response;
- lookup success calling `rememberGuestName()` only after authority is granted;
  and
- no use of the remembered upload name as automatic RSVP authentication.

- [ ] **Step 2: Write EventPage phase-composition tests**

In `tests/ui/app.test.tsx`, assert:

- `rsvp-primary` renders RSVP above the fold and does not mount upload controls;
- `photos-primary` mounts `GuestUploadFlow` first;
- photos-primary + open RSVP offers a secondary **View or change RSVP** action
  that lazy-mounts RSVP;
- photos-primary + closed/paused RSVP offers a secondary **View RSVP** action
  for a previously matched household and never delays camera/library controls;
- waiting renders a clear RSVP-closed/paused message and lets a previously
  matched household restore its read-only saved response; and
- after `GuestUploadFlow` calls `onDelivered`, the existing terminal receipt
  still hides all secondary sections, including RSVP.

- [ ] **Step 3: Run UI tests and verify missing components**

```powershell
npx vitest run --config vitest.config.ts tests/ui/guest-rsvp-flow.test.tsx tests/ui/app.test.tsx tests/ui/event-theme-rendering.test.tsx
```

Expected: FAIL because `GuestRsvpFlow` and phase composition do not exist.

- [ ] **Step 4: Implement a pure draft validator**

Create `src/features/rsvp/rsvp-form.ts` with a draft keyed by stable invitee ID:

```ts
export interface RsvpDraftValue {
  attendance: 'attending' | 'declined' | null;
  displayName: string;
}

export function validateHouseholdDraft(
  household: RsvpHouseholdView,
  draft: Record<string, RsvpDraftValue>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const invitee of household.invitees) {
    const value = draft[invitee.id];
    if (!value?.attendance) {
      errors[invitee.id] = 'Choose attending or not attending.';
    } else if (
      invitee.kind === 'plus_one'
      && value.attendance === 'attending'
      && (value.displayName.trim().length < 1 || value.displayName.trim().length > 80)
    ) {
      errors[`${invitee.id}.displayName`] = 'Enter this guest’s name.';
    }
  }
  return errors;
}
```

Build the request with every row, the loaded version, and one
`crypto.randomUUID()` retained until success or an intentional form change after
success.

- [ ] **Step 5: Implement the explicit guest state machine**

`GuestRsvpFlow` owns these discriminated states:

```ts
type Screen =
  | { kind: 'restoring' }
  | { kind: 'lookup'; secondNameRequired: boolean }
  | { kind: 'editing'; household: RsvpHouseholdView; draft: RsvpDraft }
  | { kind: 'saving'; household: RsvpHouseholdView; draft: RsvpDraft }
  | { kind: 'receipt'; household: RsvpHouseholdView }
  | { kind: 'read-only'; household: RsvpHouseholdView }
  | { kind: 'paused'; household: RsvpHouseholdView | null };
```

On mount, try the household GET. Treat `RSVP_SESSION_REQUIRED` as normal
first-visit state; surface other errors. Lookup sends one or two names. Only a
successful lookup calls `rememberGuestName(firstName.trim())`.

Keep `GuestRsvpFlow` as the network/state orchestrator. Put name/ambiguity UI in
`RsvpLookup`, editable attendance and conflict review in
`RsvpHouseholdForm`, and saved/read-only completion in `RsvpReceipt`.

Use `<fieldset>`/`<legend>` for each person, native radios with visible
**Attending**/**Not attending** labels, an `aria-live="polite"` status region,
and `aria-describedby` for row errors. Move focus to the second-name input on
ambiguity. For incomplete attendance, focus the first radio in the first invalid
group; for a missing attending plus-one name, focus that name input. After a
version conflict, replace the view and focus a `tabIndex={-1}` household review
heading so the respondent reviews the newer roster from the top.

- [ ] **Step 6: Compose server phase in EventPage**

Use the returned phase directly:

```tsx
{event.phase === 'rsvp-primary' && (
  <GuestRsvpFlow event={event} presentation="primary" />
)}

{event.phase === 'photos-primary' && (
  <GuestUploadFlow
    event={event}
    slug={slug}
    onDelivered={() => setTerminal(true)}
  />
)}

{event.phase === 'photos-primary'
  && event.rsvpDeadlineAt
  && !terminal
  && (
    <details
      className="event-extra"
      onToggle={(toggle) => setRsvpExpanded(toggle.currentTarget.open)}
    >
      <summary>
        {event.rsvpState === 'open' ? 'View or change RSVP' : 'View RSVP'}
      </summary>
      {rsvpExpanded && (
        <div className="event-extra__content guest-secondary">
          <GuestRsvpFlow event={event} presentation="secondary" />
        </div>
      )}
    </details>
  )}

{event.phase === 'waiting' && event.rsvpDeadlineAt && (
  <GuestRsvpFlow event={event} presentation="read-only" />
)}
```

Do not change `GuestUploadFlow` request, queue, progress, retry, or receipt code.
Add a test proving no RSVP household request occurs before this disclosure is
opened.

- [ ] **Step 7: Add event-themed, narrow-first RSVP styling**

Add isolated `.rsvp-*` selectors using the installed event semantic variables.
Requirements:

- 320px and 390px reflow with no horizontal overflow;
- 44x44 minimum radio labels/buttons;
- long 80-character names wrap rather than truncate;
- visible focus, invalid, disabled, and read-only states;
- attendance not conveyed by color alone;
- reduced-motion compliance; and
- the primary lookup first viewport retains event identity, date, deadline,
  full-name field, privacy copy, and complete action.

- [ ] **Step 8: Run focused UI tests and commit**

```powershell
npx vitest run --config vitest.config.ts tests/ui/guest-rsvp-flow.test.tsx tests/ui/app.test.tsx tests/ui/event-theme-rendering.test.tsx
npx playwright test tests/e2e/guest-responsive.spec.ts tests/e2e/accessibility.spec.ts --project=mobile
npx tsc -p tsconfig.e2e.json --pretty false
npm run typecheck
npm run lint
git diff --check
git add src/features/rsvp/rsvp-form.ts src/features/rsvp/GuestRsvpFlow.tsx src/features/rsvp/RsvpLookup.tsx src/features/rsvp/RsvpHouseholdForm.tsx src/features/rsvp/RsvpReceipt.tsx src/pages/EventPage.tsx src/styles.css tests/ui/guest-rsvp-flow.test.tsx tests/ui/event-theme-rendering.test.tsx tests/ui/app.test.tsx tests/e2e/fixtures/routes.ts tests/e2e/guest-responsive.spec.ts tests/e2e/accessibility.spec.ts
git commit -m "feat: add household RSVP guest flow"
```

Expected: guest and phase tests pass without changing the photo-flow contract.

---

### Task 9: Add the host RSVP dashboard, roster editor, and durable-QR controls

**Files:**

- Create: `src/components/ManagerRsvpPanel.tsx`
- Create: `src/features/rsvp/ManagerRsvpDashboard.tsx`
- Create: `src/features/rsvp/ManagerRsvpImport.tsx`
- Create: `src/features/rsvp/ManagerRsvpHouseholdEditor.tsx`
- Modify: `src/pages/CreatePage.tsx`
- Modify: `src/pages/ManagerPage.tsx`
- Modify: `src/styles.css`
- Create: `tests/ui/manager-rsvp-panel.test.tsx`
- Modify: `tests/ui/app.test.tsx`
- Modify: `tests/e2e/fixtures/routes.ts`
- Modify: `tests/e2e/fixtures/ui-data.ts`
- Modify: `tests/e2e/manager-responsive.spec.ts`
- Modify: `tests/e2e/accessibility.spec.ts`

**Interfaces:**

- `ManagerRsvpPanel({ event, onEventChanged })`
- Manager section union gains `'rsvp'`.
- Share surface consumes `{ eventLink, disabledAt }`.

- [ ] **Step 1: Write focused manager panel tests**

Cover:

- lazy summary/household loading only after RSVP navigation;
- all eight approved totals;
- query and responded/awaiting/archived filters;
- stable pagination;
- CSV file read -> preview counts/issues -> explicit commit;
- no commit action while blocking issues exist;
- stale preview conflict preserving the selected file;
- manual household creation and editing;
- named rename, fixed plus-one changes, and collision errors;
- version-conflict refresh;
- host correction after deadline;
- explicit archive confirmation and archived marker;
- current CSV download; and
- status/error announcements and focus.

- [ ] **Step 2: Update ManagerPage integration tests**

Assert six destinations, RSVP panel mounting, Share using `eventLink`, absence of
**Rotate guest link**, manager-link rotation remaining, and emergency disable
requiring the exact event name plus an explicit printed-QR warning.

- [ ] **Step 3: Run UI tests and verify missing panel**

```powershell
npx vitest run --config vitest.config.ts tests/ui/manager-rsvp-panel.test.tsx tests/ui/app.test.tsx
```

Expected: FAIL because the section/panel and durable-entry share response are
absent.

- [ ] **Step 4: Add the lazy RSVP manager section**

Keep `ManagerPage` as shell/navigation. Add:

```ts
type Section =
  | 'intake'
  | 'rsvp'
  | 'gallery'
  | 'messages'
  | 'share'
  | 'settings';
```

Render one RSVP navigation button with an address-book/check icon. Mount
`ManagerRsvpPanel` only when selected so CSV/household data does not join the
current initial `Promise.all`.

Allowlist `?section=rsvp` as Manager's initial section. Add **Set up guest
list** to the Create receipt with
`/manage/event/<eventId>?section=rsvp`, so the paused-by-default event has a
direct next action.

- [ ] **Step 5: Implement dashboard and filter behavior**

`ManagerRsvpPanel` loads summary and the first 50 household rows in parallel,
debounces textual filtering, replaces list results rather than client-filtering
hidden pages, and shows an explicit empty state. Use server totals verbatim;
never recompute event totals from one page of households.

Use compact cards for totals and contained list/detail layouts rather than a
wide desktop-only table. Household detail renders named/plus-one rows and
versioned actions. Keep the top-level panel as orchestrator: render totals and
filters through `ManagerRsvpDashboard`, CSV preview/commit through
`ManagerRsvpImport`, and manual/correction/archive flows through
`ManagerRsvpHouseholdEditor`.

- [ ] **Step 6: Implement preview, manual editor, correction, and archive UI**

Read CSV as text in the browser but send the original string to both preview and
commit. Show row number, field, and message as text only. Commit sends the
preview digest/version and the unchanged source.

Use native inputs/radios for manual editing and host correction. Every mutation
uses the last loaded version; on `RSVP_HOUSEHOLD_CONFLICT`, replace with the
returned safe current view and announce that another person changed it.
Focus the refreshed household editor heading (`tabIndex={-1}`), not a stale
control, so the host reviews the winning version before editing again.

Archive confirmation names the household and explains that lookup/sessions stop
while export retains the marked rows.

- [ ] **Step 7: Replace guest-link rotation with permanent entry controls**

Manager load/share uses `/entry`, labels it **Event link**, and generates the QR
from `eventLink`. Keep manager-link rotation in Settings.

Add a distinct **Sign out guest devices** action that requires the exact event
name, calls `/guest-sessions/rotate`, and explains that guests must rescan but
the event link and every printed QR remain unchanged. Assert the QR data and
copyable URL are byte-identical after the response.

Add a separate danger action:

> Disable printed event QR
>
> This immediately signs out guests, pauses RSVP and photo intake, and makes
> every invitation and sign using this QR stop working. It cannot be undone.

Require exact event name and POST to `/entry/disable`. After success, remove
copy/download controls and show `disabledAt`; do not generate a replacement.

- [ ] **Step 8: Reflow six-destination manager navigation**

Change the narrow navigation grid from five to six equal columns. At 320px use
short visible labels (`Intake`, `RSVP`, `Gallery`, `Notes`, `Share`, `Settings`)
and prove none overlap count badges. Desktop remains the existing vertical rail,
with RSVP inserted after Intake.

Add contained `.rsvp-manager-*` layouts, 44px actions, wrapped household names,
and scroll only within deliberately labelled CSV issue regions—not the whole
page.

- [ ] **Step 9: Run focused tests and commit**

```powershell
npx vitest run --config vitest.config.ts tests/ui/manager-rsvp-panel.test.tsx tests/ui/app.test.tsx
npx playwright test tests/e2e/manager-responsive.spec.ts tests/e2e/accessibility.spec.ts --project=mobile
npx tsc -p tsconfig.e2e.json --pretty false
npm run typecheck
npm run lint
git diff --check
git add src/components/ManagerRsvpPanel.tsx src/features/rsvp/ManagerRsvpDashboard.tsx src/features/rsvp/ManagerRsvpImport.tsx src/features/rsvp/ManagerRsvpHouseholdEditor.tsx src/pages/CreatePage.tsx src/pages/ManagerPage.tsx src/styles.css tests/ui/manager-rsvp-panel.test.tsx tests/ui/app.test.tsx tests/e2e/fixtures/routes.ts tests/e2e/fixtures/ui-data.ts tests/e2e/manager-responsive.spec.ts tests/e2e/accessibility.spec.ts
git commit -m "feat: manage RSVP households and totals"
```

Expected: manager workflows, durable share controls, typecheck, lint, and diff
checks pass.

---

### Task 10: Prove the same QR journey in production-like browsers

**Files:**

- Create: `tests/e2e/rsvp-journey.spec.ts`
- Create: `tests/e2e/rsvp-responsive.spec.ts`
- Modify: `tests/e2e/fixtures/routes.ts`
- Modify: `tests/e2e/core-journey.spec.ts`
- Modify: `tests/e2e/guest-responsive.spec.ts`
- Modify: `tests/e2e/manager-responsive.spec.ts`
- Modify: `tests/e2e/accessibility.spec.ts`
- Modify: `tests/e2e/security.spec.ts`
- Modify: `tests/e2e/event-theming.spec.ts`
- Modify: `tests/e2e/event-theming-visual.spec.ts`
- Modify: `tests/e2e/visual-qa.spec.ts`
- Add approved snapshots under:
  `tests/e2e/visual-qa.spec.ts-snapshots/`

- [ ] **Step 1: Add phase-aware route fixtures**

Extend `stubGuestRoutes()` with lookup, household GET/PUT, and phase options.
Extend `stubManagerRoutes()` with summary/list/detail/import/edit/archive/export
and entry responses. Keep fixture data typed against shared contracts.

Provide one durable entry URL constant for both pre-event and event-day tests.
Navigate a same-origin `http://127.0.0.1:4173/join#<fixture>` URL, let the real
`EventEntryPage` strip its fragment, and stub only
`POST /api/entry/exchange` to return the clean event location. Do not navigate
an external `candidary.test` fixture. Task 3 Worker tests remain the authority
for real exchange/cookie behavior.

- [ ] **Step 2: Write the pre-event and event-day journey**

`tests/e2e/rsvp-journey.spec.ts` must:

1. open the durable URL in RSVP-primary state;
2. exact-match a household containing two named people and one plus-one;
3. choose individual attendance, name the attending plus-one, and submit;
4. assert exact receipt counts and **You're all set**;
5. reload and revise from the restored household session;
6. reopen the identical durable URL with uploads enabled;
7. assert camera/library controls precede the secondary RSVP action; and
8. complete the existing review/Send/progress/retry/terminal receipt path.

Add ambiguity, stale conflict, and read-only deadline cases without exposing
candidate names.

- [ ] **Step 3: Write narrow, zoom, and long-content cases**

`tests/e2e/rsvp-responsive.spec.ts` covers:

- 320x568 lookup first viewport;
- 320px and 390px household forms;
- 200% browser zoom/reflow;
- 20 named + 10 plus-one maximum household;
- 80-character names/labels and long validation copy;
- no page-level horizontal overflow;
- all interactive targets at least 44x44 CSS pixels;
- six manager destinations at 320, 390, and 768 widths;
- contained CSV issues and household editor; and
- long-content theme containment.

Put all-preset RSVP lifecycle/contrast assertions in
`event-theming.spec.ts` and reviewed themed visual states in
`event-theming-visual.spec.ts`, alongside the existing theme contract rather
than hiding theme evidence inside a generic responsive suite.

- [ ] **Step 4: Add accessibility and security assertions**

Run Axe on guest lookup, household editor, receipt, and Manager RSVP. Add
semantic assertions for fieldset/legend, radio labels, error descriptions,
live-region updates, ambiguity focus, first-invalid focus, conflict focus, and
keyboard-only operation.

Extend security E2E to check `_headers` behavior on the clean event, Manager,
and recovery SPA documents. Ensure no rendered HTML, URL, console message, or
error state includes lookup digests, internal IDs before match, CSV source, or
raw credentials.

Do not claim entry-exchange or RSVP API response headers from Playwright route
stubs. Assert those through `tests/worker/security-headers.test.ts`,
`event-entry-api.test.ts`, and the live post-deploy checklist.

- [ ] **Step 5: Add reviewed visual evidence**

Capture exact Windows baselines for:

- `rsvp-lookup-390-mobile`;
- `rsvp-household-320-mobile`;
- `rsvp-receipt-390-mobile`;
- `rsvp-closed-390-mobile`; and
- `manager-rsvp-390-mobile`.

Creation fields, six-section navigation, Event-link copy, and Settings controls
may intentionally change these existing baselines:

- `create-validation-focus-390-mobile-win32.png`;
- `manager-actions-320-mobile-win32.png`;
- `manager-nav-768-mobile-win32.png`;
- `manager-nav-count-390-mobile-win32.png`; and
- `manager-event-appearance-390-mobile-win32.png`.

Update only the named cases after their assertions pass:

```powershell
npx playwright test tests/e2e/visual-qa.spec.ts tests/e2e/event-theming-visual.spec.ts --project=mobile --update-snapshots
```

Use the repository's zero-tolerance screenshot settings. Inspect every image
before accepting it, then rerun normally. Do not update baselines solely to make
a test green. Keep existing photo fixtures explicitly
`phase: 'photos-primary'`, `rsvpState: 'disabled'`, and
`rsvpDeadlineAt: null`, `rsvpDeadlineDate: null` so
upload/review/receipt baselines do not gain an RSVP disclosure.

- [ ] **Step 6: Run production-like E2E and photo regressions**

```powershell
npx tsc -p tsconfig.e2e.json --pretty false
npx playwright test tests/e2e/rsvp-journey.spec.ts tests/e2e/rsvp-responsive.spec.ts tests/e2e/accessibility.spec.ts tests/e2e/security.spec.ts tests/e2e/event-theming.spec.ts tests/e2e/event-theming-visual.spec.ts
npx playwright test tests/e2e/core-journey.spec.ts tests/e2e/guest-responsive.spec.ts tests/e2e/manager-responsive.spec.ts tests/e2e/visual-qa.spec.ts
```

Expected: RSVP, responsive, accessibility, security, existing photo, and visual
tests pass through build + Vite preview.

- [ ] **Step 7: Run typecheck/lint and commit browser evidence**

```powershell
npm run typecheck
npm run lint
git diff --check
git add tests/e2e/rsvp-journey.spec.ts tests/e2e/rsvp-responsive.spec.ts tests/e2e/fixtures/routes.ts tests/e2e/core-journey.spec.ts tests/e2e/guest-responsive.spec.ts tests/e2e/manager-responsive.spec.ts tests/e2e/accessibility.spec.ts tests/e2e/security.spec.ts tests/e2e/event-theming.spec.ts tests/e2e/event-theming-visual.spec.ts tests/e2e/visual-qa.spec.ts tests/e2e/visual-qa.spec.ts-snapshots tests/e2e/event-theming-visual.spec.ts-snapshots
git commit -m "test: cover same-QR RSVP journeys"
```

Expected: checks pass and only reviewed RSVP snapshots are added.

---

### Task 11: Finish lifecycle cleanup, operational contracts, and load rehearsal

**Files:**

- Modify: `worker/workflows/cleanup.ts`
- Modify: `tests/worker/cleanup.test.ts`
- Create: `scripts/rsvp-load-harness.mjs`
- Modify: `scripts/wedding-load-harness.mjs`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `2026-07-21-candidary-core-design.md`
- Modify: `design-qa.md`
- Modify: `docs/security.md`
- Modify: `docs/operations.md`
- Modify: `docs/deployment.md`
- Modify: `design/design-system.md`
- Modify: `design/fidelity-ledger.md`
- Modify: `docs/superpowers/specs/2026-07-22-wedding-photo-drop-design.md`
- Modify: `docs/superpowers/specs/2026-07-22-mobile-first-host-views-design.md`
- Modify: `docs/superpowers/specs/2026-07-29-event-theming-design.md`
- Modify: `docs/superpowers/plans/2026-07-21-candidary-core.md`

- [ ] **Step 1: Write cleanup tests before changing lifecycle code**

Add tests that:

- sweep expired/revoked RSVP sessions in bounded passes;
- sweep RSVP rate windows older than 15 minutes;
- emergency disable revokes but does not delete household data;
- archive retains rows until purge;
- `deleteEventData()` immediately disables entry, revokes event and RSVP
  sessions, removes the event's R2 prefix, deletes `media` and `guest_messages`,
  then hard-deletes the event row;
- that purge succeeds for an event containing stored media plus a guest message,
  proving the existing session foreign keys with `ON DELETE RESTRICT` are
  handled deliberately;
- an R2 deletion failure leaves a soft-deleted/revoked event that a later
  scheduled pass retries instead of orphaning it forever;
- final event deletion cascades every RSVP row; and
- `PRAGMA foreign_key_check` remains clean after each path.

- [ ] **Step 2: Run cleanup tests and verify missing sweeps**

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/cleanup.test.ts
```

Expected: FAIL because RSVP sessions/rate rows are not swept.

- [ ] **Step 3: Add bounded RSVP scratch cleanup**

Follow `cleanupAuthScratch()`:

- delete at most 100 expired/revoked RSVP sessions per table/pass;
- delete at most 100 stale rate rows per pass;
- cap passes at 50;
- report counts for tests/observability without names or scopes; and
- include entry/session revocation in `deleteEventData()` before R2 prefix
  removal.

After the event prefix is removed successfully, execute
`DELETE FROM media WHERE event_id = ?` and
`DELETE FROM guest_messages WHERE event_id = ?` before
`DELETE FROM events WHERE id = ?`. Those two tables reference event sessions
with `ON DELETE RESTRICT`; deleting the event directly is not a valid cascade
for a populated event. The final event delete then lets the remaining existing
and new `ON DELETE CASCADE` relationships perform the relational purge.

If object deletion fails, keep the event marked deleted/revoked, propagate the
failure, and change scheduled selection to retry due rows with
`deleted_at IS NOT NULL` until hard deletion succeeds. Never hard-delete D1
first and strand undiscoverable R2 objects.

- [ ] **Step 4: Add a guarded 500-guest RSVP load harness**

Create `scripts/rsvp-load-harness.mjs` with dry-run default and these required
live variables:

```text
CANDIDARY_RSVP_BASE_URL
CANDIDARY_RSVP_EVENT_LINK
CANDIDARY_RSVP_MANAGER_COOKIE
CANDIDARY_RSVP_MANAGER_CSRF
CANDIDARY_RSVP_CONFIRM=I_UNDERSTAND
```

The live path is only for a dedicated disposable rehearsal event. It imports a
500-capacity roster and reconciles the full pending summary, then uses the same
entry URL for exactly 20 lookup/submission attempts from the harness IP and
expects the 21st D1-scoped attempt to return generic `429` with
`Retry-After: 900`. Reconcile those 20 responses plus the remaining pending
capacity and print latency/error aggregates without names, cookies, or URLs.

Do not pretend one-origin traffic is a 500-household concurrency test and do
not weaken production abuse controls. The 500-row D1/import boundary is proved
by Worker integration and this live roster reconciliation; a true distributed
lookup load test requires separately provisioned source IPs and its own
authorized rehearsal.

Add:

```json
"test:load:rsvp": "node scripts/rsvp-load-harness.mjs"
```

Update the wedding photo harness variable/copy from guest link to durable event
link while preserving its 500-guest/10,000-photo/two-transfer behavior.

- [ ] **Step 5: Update security, operations, deployment, and product docs**

Document:

- three authority/cookie scopes and their route boundaries;
- dedicated secrets and Cloudflare rate binding;
- persisted-key rotation limits versus safe guest/session rotation;
- exact lookup normalizer/security limitation;
- edge 30/min and D1 20-IP/8-name per 15-minute limits;
- successful-key receipt retention and replay semantics;
- deadline/date/time-zone and extension rules;
- initial import/manual-edit/archive/export behavior;
- permanent entry versus internal guest grant;
- irreversible emergency disable runbook;
- CSV contract link and formula neutralization;
- migration 0008 and clean-launch/no-backfill stance;
- additive migration mechanics for both fresh and existing D1 targets;
- the required zero-active-legacy-entry query and the controlled clean/fresh D1
  path when that query is nonzero;
- exact-target verification and a separate R2 preserve/delete decision before
  any clean-D1 operation;
- live log review that rejects raw names/tokens/bodies;
- same-QR physical rehearsal and device evidence; and
- RSVP as first product capability in README/CLAUDE.

Add explicit supersession notes to older specs: RSVP broadens the themed guest
states and Manager navigation from five to six, while the photo upload flow and
terminal receipt remain authoritative and unchanged.

Update the root core design/plan and `design-qa.md` route/state/viewport matrix
so they no longer describe RSVP as excluded or the Manager as permanently
five-destination.

Expand `docs/rsvp-csv.md` with the exact export columns from Task 7, inclusion
of pending and archived rows, UTC timestamp/event-time-zone rules, filename
date source, `text/csv; charset=utf-8`, and exact `Content-Disposition`.

- [ ] **Step 6: Update design contracts and fidelity ledger**

Add RSVP lookup, household, receipt, closed, dashboard, CSV issue, and danger
states to `design/design-system.md`. Record reviewed screenshot names, viewport,
theme, test, and the actual verified SHA only when real evidence exists in
`design/fidelity-ledger.md`; do not claim physical device evidence yet.

- [ ] **Step 7: Run cleanup, dry-run load, docs checks, and commit**

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/cleanup.test.ts
npm run test:load:rsvp
npm run test:load:wedding
npm run typecheck
npm run lint
git diff --check
git add worker/workflows/cleanup.ts tests/worker/cleanup.test.ts scripts/rsvp-load-harness.mjs scripts/wedding-load-harness.mjs package.json README.md CLAUDE.md 2026-07-21-candidary-core-design.md design-qa.md docs/security.md docs/operations.md docs/deployment.md docs/rsvp-csv.md design/design-system.md design/fidelity-ledger.md docs/superpowers/specs/2026-07-22-wedding-photo-drop-design.md docs/superpowers/specs/2026-07-22-mobile-first-host-views-design.md docs/superpowers/specs/2026-07-29-event-theming-design.md docs/superpowers/plans/2026-07-21-candidary-core.md
git commit -m "docs: operationalize RSVP launch"
```

Expected: cleanup tests pass; both load scripts report dry-run plans without
network writes; docs, type, lint, and diff checks pass.

---

### Task 12: Run the final local gates and prepare release evidence

**Files:**

- Modify only if a failing gate reveals an in-scope defect.
- Update: `design/fidelity-ledger.md` only with evidence actually produced.

- [ ] **Step 1: Run every local gate on the final head**

```powershell
npm run typecheck
npm run lint
npm test
npm run build
npm run verify:pwa-build
npx tsc -p tsconfig.e2e.json --pretty false
npm run test:e2e
git diff --check
```

Expected: all commands exit zero. If any fix is needed, write a failing
regression first, make the smallest correction, rerun the focused test, then
rerun this complete sequence.

- [ ] **Step 2: Run explicit Worker integrity and authority regressions**

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/migration-0008.test.ts tests/worker/event-entry-api.test.ts tests/worker/rsvp-import-api.test.ts tests/worker/rsvp-lookup-api.test.ts tests/worker/rsvp-submission-api.test.ts tests/worker/rsvp-manage-api.test.ts tests/worker/upload-api.test.ts tests/worker/manage-api.test.ts tests/worker/cleanup.test.ts
```

Expected: all pass, including same-entry rotation, cookie separation,
500-capacity import, idempotent replay, conflict, deadline, host correction,
export, and purge.

- [ ] **Step 3: Audit the final diff and repository scope**

```powershell
git status --short
$rsvpPlanBaseSha = git merge-base HEAD origin/main
git diff --stat "$rsvpPlanBaseSha..HEAD"
git diff --check "$rsvpPlanBaseSha..HEAD"
git log --oneline --decorate -15
```

Confirm no ZIP, secret, `.dev.vars`, output artifact, unreviewed snapshot,
database file, or unrelated change is staged/committed.

- [ ] **Step 4: Request code review before integration**

Invoke `superpowers:requesting-code-review`. The reviewer must compare final
behavior to the approved specification and explicitly inspect:

- durable-entry versus internal guest-token separation;
- no compatibility fallback for old data;
- household/event foreign-key scope;
- lookup enumeration resistance and rate order;
- submission atomicity, `changes()` guards, idempotency, and version conflicts;
- import statement/parameter bounds;
- host edit/archive/totals/export reconciliation;
- photo-flow non-regression;
- narrow/accessibility evidence; and
- cleanup and secret/log handling.

Address findings through `superpowers:receiving-code-review`, with verification
on the resulting final head.

- [ ] **Step 5: Commit any evidence-only final update**

If review produced no code changes but the fidelity ledger needs final SHAs:

```powershell
git add design/fidelity-ledger.md
git commit -m "docs: record RSVP verification evidence"
```

Do not create an empty commit.

- [ ] **Step 6: Stop at the release boundary**

Report:

- final feature SHA;
- every local gate and its result;
- migration name;
- required new secret/binding names, never values;
- dry-run load plan;
- absence of remote D1/R2/deployment changes; and
- the still-required physical/manual gates.

Do not apply remote migrations, set secrets, wipe D1, deploy, push, or merge
without the user's next explicit release instruction.

## Post-Implementation Release Checklist

This checklist is intentionally not executed by the implementation plan.

- [ ] Verify the exact Cloudflare account, Worker, D1 database ID/name, R2
  bucket, Images binding, and current remote migration ledger.
- [ ] Before applying 0008, count active events on the pre-0008 ledger; every
  such event will lack an entry because this plan performs no backfill. If the
  result is nonzero, do not deploy mixed-version behavior: use the authorized,
  exact-target clean-D1 or fresh-D1 binding procedure and record whether
  existing R2 objects are preserved. Do not delete R2 without separate explicit
  authorization.
- [ ] Provision `ENTRY_HMAC_KEY`, `ENTRY_ENCRYPTION_KEY`, and
  `RSVP_LOOKUP_HMAC_KEY` through secret-safe tooling; verify only their names.
- [ ] Verify the `RSVP_LOOKUP_RATE_LIMIT` production binding and 30/minute rule.
- [ ] Apply `0008_event_rsvp.sql` to the exact remote D1 target and prove no
  pending migrations plus a clean `PRAGMA foreign_key_check`.
- [ ] Deploy the exact reviewed SHA and verify live headers/routes without
  placing credentials in shell history or logs.
- [ ] Create a disposable rehearsal event, import 500 capacity, run the guarded
  RSVP load harness, and reconcile all totals.
- [ ] Print the actual production QR once, decode it locally, and record only a
  SHA-256 fingerprint plus the non-secret origin/path prefix. Never place the
  raw credential URL in evidence.
- [ ] Scan that same physical artifact on iPhone Safari and Android Chrome
  during RSVP-primary, after an ordinary internal guest-grant rotation, and
  during photos-primary. Compare local SHA-256 fingerprints; they must not
  change.
- [ ] Rehearse ambiguity, revision, deadline closure, host correction,
  degraded-network retry, VoiceOver/TalkBack, and event-day photo delivery on
  the venue network.
- [ ] Rehearse emergency disable only on a disposable event and prove both
  future scans and existing guest/household sessions stop while manager access
  remains.
- [ ] Record device, OS, browser, network, date, reviewed SHA, deployment
  version, migration ledger, and observed result in the fidelity/operations
  evidence.

## Acceptance Trace

| Approved outcome | Implemented/proved by |
| --- | --- |
| One permanent QR for RSVP and photos | Tasks 3, 4, 10; physical release checklist |
| Household member accounts for every named member and slot | Tasks 5, 7, 8 |
| Exact lookup without guest-list browsing | Tasks 1, 5, 6 |
| Second-name ambiguity without candidates | Tasks 5, 6, 8 |
| Individual attend/decline and attending plus-one name | Tasks 1, 7, 8 |
| No meal, dietary, accessibility questionnaire, or seating fields | Global constraints; UI/contract tests in Tasks 1 and 8 |
| Revisions until server deadline; host correction afterward | Tasks 4, 7, 8 |
| No silent overwrite; successful-key lost-response replay | Task 7 |
| Manual roster and initial CSV preview/commit | Tasks 5, 7, 9 |
| Exact totals, filters, archive, and safe CSV export | Tasks 7 and 9 |
| Separate event/household/host authority and CSRF | Tasks 3 and 6 |
| Edge plus D1 abuse controls and no sensitive logs | Tasks 6 and 11 |
| Existing photo journey remains primary on event day | Tasks 8 and 10 |
| Clean first-product schema with no backfill | Tasks 2 and 11 |
| 500-person and D1 parameter evidence | Tasks 2, 5, and 11 |
| 320/390 mobile, accessibility, and themes | Tasks 8-10 |
| Physical iPhone/Android same-QR proof | Post-implementation release checklist |

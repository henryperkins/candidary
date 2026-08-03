# Candidary Date-Driven Guest Phase Design

**Date:** 2026-08-01

**Status:** Approved for implementation

This document amends the lifecycle, guest-surface, and host-control portions of
`2026-07-30-event-rsvp-and-photo-entry-design.md`. The earlier design remains
authoritative for RSVP roster rules, privacy budgets, durable entry, uploads,
manager correction, and every requirement this document does not replace.

## 1. Decision

The one printed event QR will change what it opens on its own, driven by the
event's own schedule rather than by a host remembering to flip a checkbox on the
morning of the event.

Before the start, an open RSVP is the whole page unless the host has opened
photos early; in that early-open case photos become primary and RSVP remains a
secondary action until its deadline. Once RSVP is shut and photos are still on
their schedule, the page says the event has not started, thanks the household
for responding if it did, and lets a guest on a new device find a saved response.
At the start, photo delivery opens automatically; if the host pauses it after
that, the guest gets the designed waiting surface. The printed credential, the
URL it encodes, and the exchange that redeems it are all unchanged.

Two host intents that today share one boolean are separated into three concepts:
whether photo delivery is *permitted*, when it is *scheduled* to open, and
whether the host has *opened it early*. Separating them is what lets the schedule
be authoritative while still leaving the host an override.

## 2. Goals

- Move the guest between RSVP, before-start, photo delivery, and paused waiting
  with no required host action on the day of the event.
- Give the post-deadline, pre-event window a designed surface of its own rather
  than a fallback that talks about a deadline the guest can no longer act on.
- Recognize a household that has already responded, including one arriving on a
  device that never held an RSVP session.
- Keep the server the sole authority on what phase an event is in. The browser
  never compares a clock.
- Require no cron or scheduled mutation; reads resolve the current phase from
  stored intent and server time.
- Leave the printed QR, `/join#<id.secret>`, `POST /api/entry/exchange`, and the
  guest event session untouched.
- Keep every existing RSVP privacy property: the enumeration budgets, the single
  uniform refusal body, and the guarded atomic write.
- Preserve the host's ability to open photos early and to stop them outright.

## 3. Non-goals

- Per-household or per-guest scheduling. The schedule belongs to the event.
- A separate start *date*. `event_date` remains the one date; the host adds a
  time to it.
- Any change to the printed credential, its adoption path, or the irreversible
  entry disable.
- Any change to the upload reserve/transfer/finalize path, media privacy, or
  exports.
- Backfilling a correctly zoned start inside the migration itself. SQLite cannot
  resolve an IANA zone; release handles legacy events instead (§11).

## 4. What exists today

`resolveGuestEventPhase` in `shared/rsvp.ts` decides everything from two
booleans and one deadline:

```ts
if (input.uploadsEnabled) return { phase: 'photos-primary', rsvpState };
if (rsvpState === 'open')  return { phase: 'rsvp-primary', rsvpState };
return { phase: 'waiting', rsvpState };
```

`uploadsEnabled` is an unconditional override, so RSVP can never be primary while
photo delivery is on. `event_date` is a bare `YYYY-MM-DD` that is compared to
nothing; it drives lifecycle windows, host reminder emails, the
deadline-precedes-event validation, and display, and nothing else. New events are
created with both intakes written off explicitly (`worker/db/events.ts:82`), so
the transition from RSVP to photos is a host unchecking one box and checking
another. The only nudge is the `event_reminder` email, which reaches only hosts
who hold an account.

In the window this design is about — deadline passed, event not begun, host has
not flipped the box — the phase is `waiting`. A guest on the device that
responded sees a receipt headed "Your RSVP" whose body is "RSVP is closed." A
guest on any other device sees a bare card reading "RSVP is closed / The response
deadline has passed," with no event name, no date, and no indication that photos
are coming; `screenWithoutHousehold` offers lookup only while `rsvpState` is
`open`. A household that never responded reads copy identical to one that did.

## 5. Time model

### 5.1 Stored values

Two columns are added to `events`.

`event_start_at` is an absolute instant, `NOT NULL`. It is derived server-side
from the host's `event_date`, a new local start time, and `event_timezone`. The
host supplies a local wall-clock time; the instant is computed here, never sent
by a browser, for the same reason `rsvp_deadline_at` is computed here.

`photos_open_from` is a nullable absolute instant. `NULL` means "open
automatically at the event start." A non-null value means the host opened photo
delivery early, and holds the server time at which they did.

### 5.2 Derivation

```
scheduledOpenAt = photosOpenFrom ?? eventStartAt
photosOpen      = uploadsEnabled && now >= scheduledOpenAt
started         = now >= eventStartAt
```

`uploadsEnabled` reverts to meaning what it reads like: photo delivery is
permitted for this event. The clock, not the host, does the opening.

New events are created with `uploads_enabled = 1`. This is a change to
`EventsRepository.createStatement`, which today writes `0` explicitly rather than
taking the column default; the column default is not touched, so existing rows
are unaffected. `rsvp_enabled` continues to be written `0` — RSVP still waits for
a roster that has passed collision and capacity validation, and nothing about
that changes here.

### 5.3 Host controls over time

The schedule is authoritative, and the control set is shaped so a host cannot
accidentally defeat it.

| When | Action | Effect |
| --- | --- | --- |
| Before start | Open photos early | `photos_open_from = serverNow.toISOString()` |
| Before start | Pause until event start | `photos_open_from = NULL` |
| At or after start | Pause photo delivery | `uploads_enabled = 0` |
| At or after start | Reopen photo delivery | `uploads_enabled = 1` |

A pause *before* the start clears the early-open instant; it does not disable
capability. This is the load-bearing rule of the whole design. If a pre-start
pause wrote `uploads_enabled = 0`, a host who opened photos early and then
thought better of it would silently cancel the scheduled opening, and the event
would sit on `waiting` through its own reception.

There is deliberately no pre-start control that revokes capability. A host who
wants photo delivery off for the event does it after the start, when the effect
is visible to them.

### 5.4 Host input

The create form shows a local start-time field prefilled to `12:00 AM`. The host
may accept that default, so start time is not a new completion hurdle, but it is
never an invisible server assumption: the field is visible, and the create
receipt and manager summary render the resulting date, time, and time zone.

Settings expose the same editable local time beside the existing read-only event
date and editable time zone; this design does not add event-date editing. The
browser submits wall-clock date and time values, not an instant. For compatibility
during rollout, an omitted start time is interpreted as `00:00` local, but every
current client sends the field explicitly.

### 5.5 `instantForLocalDateTime`

A new helper joins `endOfLocalDate` in `shared/event-time.ts`, using the same
probe-and-bisect search so it inherits the existing DST reasoning. Its contract
is explicit at both discontinuities:

- A local time that does not exist (spring forward) is **rejected**. The host is
  asked for a different time rather than being silently moved.
- A local time that occurs twice (fall back) resolves to the **earlier**
  occurrence, deterministically.

### 5.6 Validation

`rsvpDeadlineAt < eventStartAt`, strictly, enforced identically on create
(`worker/routes/public.ts`) and settings (`worker/routes/manage.ts`). This
replaces the current date-level `rsvpDeadlineDate <= eventDate` rule.

Strictness matters. `rsvpState` treats the deadline instant itself as still open
(`expired = now > deadline`), so a non-strict rule would admit a single instant
that is simultaneously RSVP-open and event-started — a state no phase can
describe and every guest RSVP route would refuse.

Because `rsvp_deadline_at` is the last millisecond of the host's chosen local
day, a date-only RSVP deadline on the event date is always after every possible
start time on that date. Under this model the deadline date must therefore be
earlier than the event date. The server still validates the resolved instants,
and reports the failure on `rsvpDeadlineDate` as "RSVP deadline must be before
the event starts."

Any edit to the start time, the RSVP deadline date, or the time zone recomputes
**both** absolute instants from the same tuple, in the same guarded write.
Recomputing one without the other would let a time-zone change move the deadline
past the start. If event-date editing is added later, it has the same invariant;
it is not added by this feature.

## 6. Phase contract

`GuestEventPhase` gains a fourth value. `before-start` is a distinct product
state, not merely a reason photos are unavailable.

```ts
export type GuestEventPhase =
  | 'rsvp-primary' | 'before-start' | 'photos-primary' | 'waiting';

export type RsvpAccess = 'editable' | 'read-only' | 'unavailable';

export interface GuestPhaseView {
  phase: GuestEventPhase;
  rsvpState: RsvpState;
  rsvpAccess: RsvpAccess;
  lifecycleRecheckAfterMs: number | null;
}
```

### 6.1 Resolution order

| Condition | Phase |
| --- | --- |
| Photo delivery effectively open, including a manual early opening | `photos-primary` |
| Before event start and RSVP open | `rsvp-primary` |
| Before event start and RSVP shut | `before-start` |
| At or after event start and photo delivery paused | `waiting` |

```ts
if (photosOpen)                      return 'photos-primary';
if (!started && rsvpState === 'open') return 'rsvp-primary';
if (!started)                         return 'before-start';
                                      return 'waiting';
```

`waiting` now means exactly one thing: the event has started and photo delivery
is currently unavailable.

### 6.2 `rsvpAccess`

`rsvpState` cannot distinguish "closed before the start" from "closed because the
event started" — both read `closed`. Rather than have the browser resolve that
with a clock, the server states it. `rsvpAccess` is the same sentence the guest
RSVP routes enforce, so the interface and the boundary derive from one value.

| Phase | `rsvpAccess` |
| --- | --- |
| `rsvp-primary` | always `editable` |
| `before-start` | `read-only` when saved-household lookup is available, otherwise `unavailable` |
| `photos-primary` before start (early open) | `editable`, `read-only`, or `unavailable` |
| `photos-primary` at or after start | always `unavailable` |
| `waiting` | always `unavailable` |

Phase says *where* RSVP appears; `rsvpAccess` says *whether and how*; `rsvpState`
continues to supply the paused/closed wording.

The phase resolver also receives a server-only `rsvpConfigured` input, derived as
`event.rsvpRosterVersion > 0` with a valid deadline. It is not sent to guests;
only the resulting `rsvpAccess` is. This matters because every new event has a
deadline but starts with RSVP paused while the host builds a roster. An event
that never adopted RSVP must not advertise a household lookup that can only miss.

The server derives access in this order:

1. At or after the start, access is `unavailable` without exception.
2. Before the start, `rsvpConfigured === false` or an RSVP state of `disabled`
   makes access `unavailable`.
3. Before the start, an RSVP state of `open` makes access `editable`.
4. Every other pre-start RSVP state is `read-only`.

The read-only lookup searches only households with a saved response. An
unresponded invited name therefore receives the same uniform `not_available`
result as a miss; the read-only window does not become a roster-enumeration
surface. When access is unavailable, `GuestBeforeStart` renders the event and
its start without any RSVP affordance. A disabled printed entry never reaches
this resolver: disabling it revokes the guest and household sessions at the
authentication boundary.

### 6.3 `lifecycleRecheckAfterMs`

A **relative** delay in milliseconds, computed by the server from the same
authoritative `now` that resolved the view, or `null` when no boundary remains.

It is relative, not an absolute instant, on purpose. An absolute instant compared
against `Date.now()` is a browser-clock comparison: a clock running fast would
switch early and a clock running slow would switch hours late. A server-computed
delay removes the browser clock from the decision entirely.

It schedules the next **guest-view boundary**, not merely the next phase change.
During an early-open `photos-primary` period the phase does not change at the
RSVP deadline or at the event start, but the RSVP disclosure changes from
editable to read-only and then disappears. The delay is therefore the shortest
interval to any of `scheduledOpenAt`, `eventStartAt`, or `rsvpClosesAt` that is
still in the future at the resolving instant; `null` once none are.

`rsvpClosesAt` is one millisecond after `rsvpDeadlineAt`. The existing RSVP
contract keeps the exact deadline millisecond open (`now > deadline` closes it),
so refetching at the deadline itself would return the same view and could leave
the tab editable until another wake-up. Scheduling the first closed millisecond
preserves the current deadline semantics without a spin.

### 6.4 Event views

`EventView` (manager) gains `eventStartAt`, a host-editable local
`eventStartTime`, `photosOpen`, `photoIntakeRecheckAfterMs`, and:

```ts
photoIntakeState: 'scheduled' | 'open-early' | 'open' | 'paused';
```

| Value | Condition |
| --- | --- |
| `paused` | `uploads_enabled = 0` — capability withheld, whatever the clock says |
| `scheduled` | permitted, and `now < scheduledOpenAt` |
| `open-early` | permitted, `now >= scheduledOpenAt`, and `now < eventStartAt` |
| `open` | permitted, and `now >= eventStartAt` |

`paused` is checked first, so a paused event never reports itself as scheduled to
open. The manager control set in §5.3 is chosen from this value, not from a
comparison the browser performs.

`photoIntakeRecheckAfterMs` is the server-computed relative delay to the next
future `scheduledOpenAt` or `eventStartAt`, or `null`. The manager uses the same
quiet boundary-refetch behavior as the guest, so a page left open across the
start updates its status and action without consulting the browser clock.

The normal pre-start control never creates `paused`; before the start it can only
set or clear `photos_open_from`. A pre-start `paused` value can exist only on a
legacy row or after an irreversible entry disable, and the manager explains that
exception rather than offering `reopen` early.

`GuestEventView` gains `eventStartAt`, so the before-start surface can render a
correctly zoned start using the event's own time zone.

## 7. Server enforcement

### 7.1 Guest RSVP routes

Every **guest** RSVP route refuses at or after `event_start_at`. The interface
not mounting a component is not the security boundary.

- `POST /api/event/:slug/rsvp/lookup` keeps its current edge-first ordering, its
  D1 per-event/IP and per-event/name budgets, its candidate filtering, and its
  single uniform `not_available` body, unchanged, right through the read-only
  window. At and after the start it returns that same uniform result, so the
  boundary is not an oracle.
- `GET` and `PUT /api/event/:slug/rsvp/household` return the existing
  unavailable/closed recovery shapes.

A household session minted during the read-only window is already write-dead: it
captures `writeAuthorityDeadline: event.rsvpDeadlineAt` at creation.

Before the start, a `PUT` carrying an idempotency key for an already committed,
identical response may still replay that durable receipt; it may not perform a
new mutation. This preserves the existing retry contract when a response was
accepted immediately before the deadline. At and after the start, every guest
RSVP route is unavailable, including replay, because RSVP has left the guest
experience entirely.

### 7.2 Manager RSVP routes

Manager correction, roster management, import, and export remain available after
the start. Hosts correct households after the deadline as a matter of course —
`RsvpActor` exists for exactly that — and an export that stopped working when the
event began would be useless.

### 7.3 The submission guard

`event_start_at > now` joins the household write's guarded `WHERE`, alongside the
version, `rsvp_enabled`, the deadline, and the session's captured write deadline.

A route-level check alone would reopen the race the guarded write exists to
close: a submission that passes the route check microseconds before the start
would otherwise commit after it. Capacity and state transitions are enforced in
SQL in this codebase, and this is one of them.

### 7.4 Photo intake actions

`POST /api/manage/events/:eventId/photo-intake` accepts
`{ action: 'open_early' | 'return_to_schedule' | 'pause' | 'reopen' }` and never
a client timestamp. Only the transition named in §5.3 is legal from the current
server-derived state. `open_early` stamps the server's own clock. The endpoint
returns the refreshed `EventView`; an invalid or stale transition returns the
existing `VALIDATION_FAILED` envelope with HTTP 409 and tells the manager to
reload. No new `ApiErrorCode` is added. A page that loaded before the start
therefore cannot send a pre-start action after it.

`uploadsEnabled` leaves the autosaved settings payload and its merge logic
entirely. Two reasons: the control's meaning depends on the server clock, and a
stale autosave draft could send `uploadsEnabled: false` meaning "pause until
start" and instead destroy capability. This follows the precedent already set by
`Sign out guest devices` and `Disable printed event QR`, which are explicit
actions rather than settings fields.

The irreversible entry disable continues to win over everything: it sets both
`uploads_enabled = 0` and `rsvp_enabled = 0`, and no photo-intake action may
reopen an event whose entry is disabled.

## 8. Guest interface

`EventPage` stays a flat four-way branch on `phase`.

### 8.1 `GuestBeforeStart`

A new surface at `src/features/guest/GuestBeforeStart.tsx`. It owns the page's
single `<h1>`, the hero, a line naming when the event starts — formatted from
`eventStartAt` with an explicit `timeZone`, never the browser's — and a line
saying photos open when the event does.

For the household portion it embeds `GuestRsvpFlow`, reusing lookup and receipt
rather than duplicating them. When `rsvpAccess` is `unavailable` it does not
mount or call `GuestRsvpFlow` at all.

A household with `firstRespondedAt` set receives the appreciation copy. One
without receives a neutral line; it must not thank a household that did not
respond, and must not scold one either. `RsvpReceipt` gains a `before-start`
mode so this distinction is explicit rather than inferred from generic closed
copy.

The permitted above-the-fold copy is:

- Heading: **The event hasn't started yet**
- Start line: **{event name} begins {formatted date} at {formatted time}.**
- Photo line: **Come back when the event begins to take or add photos.**
- Responded household: **We appreciate your RSVP. Your saved household response
  is below.**
- Household lookup: **Find your household to view a saved response.**
- Located household without a saved response: **There isn't a saved RSVP for
  this household.**

Dynamic date and time fragments follow Candidary's established `en-US` display
format and are always formatted with `eventTimezone`. No other deadline,
waiting, or gratitude sentence appears above the fold on this surface.

### 8.2 Presentation is layout only

`GuestRsvpFlow`'s `presentation` prop controls layout; `rsvpAccess` controls
authority. The two must not be conflated, so a third presentation is added rather
than passing `read-only` and separately suppressing its hero:

- `primary` — full RSVP surface with its own hero.
- `secondary` — the disclosure inside an early-open `photos-primary` page.
- `embedded` — household content inside `GuestBeforeStart`, with no second hero.

Under `embedded`, the lookup and receipt headings become `<h2>`, because
`GuestBeforeStart` owns the `<h1>`. Two level-one headings on one page is an
accessibility defect the existing e2e pass would catch.

### 8.3 The RSVP disclosure under `photos-primary`

During an early-open period the disclosure at `EventPage.tsx:153` appears when
`rsvpAccess` is `editable` or `read-only` and is omitted when it is
`unavailable`. At the event start it disappears completely. It is driven by
`rsvpAccess`, not by a date comparison.

### 8.4 `useLifecycleRecheck`

A hook taking `lifecycleRecheckAfterMs` and a reload callback.

- `null` arms nothing.
- Otherwise it arms one timer for the supplied delay, capped at approximately 24
  hours per armed timer and re-armed on fire.
- It also rechecks on `visibilitychange`, `pageshow`, and network reconnect.
- A failed background refresh keeps the current surface on screen; it never
  replaces a working page with an error. Failures retry with bounded backoff.
- A 30-second anti-spin floor applies only after a recheck that returned an
  unchanged view or failed — never to the initial boundary delay, which must fire
  on time.

The timer only triggers a refetch. The server remains authoritative about whether
anything changed.

### 8.5 `waiting`

At or after the start, when photo capability is paused, the complete primary
copy is **Photo delivery is paused** and **The host has paused photo delivery for
now. Please try again later.** The existing event hero still names the event;
RSVP lookup, receipt, and disclosure do not mount.

## 9. Migration

`migrations/0010_event_start.sql`.

```sql
ALTER TABLE events ADD COLUMN event_start_at TEXT NOT NULL
  DEFAULT '1970-01-01T00:00:00.000Z';
ALTER TABLE events ADD COLUMN photos_open_from TEXT;

UPDATE events SET event_start_at = event_date || 'T00:00:00.000Z';
UPDATE events SET photos_open_from = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE uploads_enabled = 1;
```

`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` reproduces the millisecond-precision ISO
form `toISOString()` writes everywhere else in this schema.

`NOT NULL` with a constant default is available on `ADD COLUMN`, so the column is
genuinely non-nullable rather than policed by a trigger.

The second `UPDATE` preserves every event currently showing `photos-primary`.

The first is an approximation and is **not** harmless. SQLite has no IANA
database, so a legacy start lands at UTC midnight rather than local midnight — up
to roughly fourteen hours off. For an event whose photo delivery is on, the
`photos_open_from` stamp makes that irrelevant. For an uploads-off event with an
active roster it is not irrelevant at all: guest RSVP routes would begin refusing
at the approximate start, potentially most of a day early or late.

Release therefore gates on §11. This migration must not be treated as safe on the
strength of the stamp alone.

## 10. Documentation and design contract

`design/design-system.md` gains three rows in the RSVP state table and one in the
manager section:

| Surface | State |
| --- | --- |
| Guest before-start | responded |
| Guest before-start | unrecognized or not responded |
| Guest waiting | photo delivery paused after start |
| Manager photo intake | scheduled / open-early / open / paused |

It also gains one above-the-fold paragraph naming the permitted before-start copy
exactly as listed in §8.1, alongside the existing `Guest RSVP` entry. The waiting
row uses the exact two sentences in §8.5.

`design-qa.md` and `design/fidelity-ledger.md` record the new surfaces at 320 and
390 px.

`docs/operations.md` needs real edits despite no new error code. Its "RSVP and
photo entry" section describes the old host controls and deadline behavior. The
support-code meanings distinguish deadline/version write conflicts and expired
sessions from `RSVP_CLOSED`, which now means the event start has made every guest
RSVP route unavailable. The runbook must document the scheduled opening and the
four explicit actions.

`docs/deployment.md` carries the release gate.

## 11. Release gate

Before start-time enforcement is enabled, release must either:

1. prove there are no non-deleted legacy events; or
2. perform a data-aware backfill that resolves each non-deleted event's start
   through its own IANA zone.

A second condition applies to either path: an existing event whose RSVP deadline
date equals its event date cannot satisfy `rsvpDeadlineAt < eventStartAt` at any
start time on that date. Those rows require an explicit host correction or a
reviewed data correction before the new validation is enforced; checking only
for the backfill's zone error is insufficient.

The deterministic rollout order is:

1. Before applying `0010`, inventory every non-deleted event ID, its photo
   capability, printed-entry state, database inventory instant, and schedule sources used to calculate its expected
   local-midnight start through `instantForLocalDateTime`. Resolve any same-day
   deadline rows before continuing.
2. Apply `0010` while the old Worker is still serving. Its UTC-midnight values are
   not yet interpreted as lifecycle starts.
3. Freeze the inventoried schedule sources, data-aware backfill every ID, preserve photo delivery for rows the old Worker considers
   open, and verify the exact IANA instant plus the preserved photo-open stamp. Leave legacy
   uploads-off rows unchanged while the old Worker is serving so they cannot open early.
   The new Worker is not deployed while any inventoried row still holds the
   approximate value or has lost that open-delivery proof.
4. Deploy the compatible Worker, then apply the separately generated capability finalization that
   restores enabled future legacy entries to `scheduled`; never restore a disabled-entry tombstone.
   An event created by the old Worker after the
   migration has the epoch default; the new Worker recognizes that sentinel and
   temporarily retains the old boolean/deadline phase rules and RSVP route
   availability for that row.
5. Run a final epoch-sentinel scan. Validate each gap row's deadline, data-aware
   backfill and capability-finalize rows that satisfy the invariant, and stop for host or reviewed data
   correction if one does not. Verify that no non-deleted event retains the
   sentinel before closing the release gate.

The epoch value is therefore an intermediate migration sentinel, never a live
start. Corrected legacy rows and events created by the new Worker use the new
lifecycle immediately; a deploy-gap row remains safely on the old behavior only
until step 5.

## 12. Testing

**`tests/unit`** — `resolveGuestEventPhase` table-driven across all four phases;
the exact-instant boundaries at `eventStartAt`, `scheduledOpenAt`, and
`rsvpDeadlineAt`, including closure at `rsvpDeadlineAt + 1ms`; the `rsvpAccess`
invariants of §6.2, including an event that never configured RSVP;
`lifecycleRecheckAfterMs` selection including the early-open case where the
boundary is not a phase change;
`instantForLocalDateTime` rejecting a nonexistent spring-forward time and
resolving a repeated fall-back time to the earlier occurrence.

**`tests/worker`** — guest RSVP lookup, read, and write all refuse at and after
the start, lookup with the same uniform body it uses for a miss; the submission
`DB.batch()` itself refuses at the boundary, proving the guard is in SQL rather
than only at the route; an already committed identical idempotency key replays
before the start without mutation but is unavailable at or after the start;
lookup's edge-then-D1 ordering and budgets are unchanged during the read-only
window; manager correction, roster, and export routes still answer after the
start; `rsvpDeadlineAt < eventStartAt` rejected on both create and settings,
including every same-day deadline; a deadline-date, start-time, or zone edit
recomputes both instants atomically; all four photo-intake actions, a
stale-boundary action refused, and the entry disable winning over a reopen; the
migration backfill, inventoried IANA correction, and epoch-sentinel deploy-gap
path.

**`tests/ui`** — `GuestBeforeStart` for a responded household, an unresponded
one, and an unrecognized device; no RSVP request issued at all when `rsvpAccess`
is `unavailable`; the embedded heading hierarchy holding one `<h1>` and `<h2>`
beneath it; the visible midnight default on create and its zoned summary; the
disclosure present during early-open and gone after the start, with no guest
RSVP request issued after that boundary; the manager status and available action
refetching across the start from `photoIntakeRecheckAfterMs`.

**`tests/e2e`** — the stubbed phase sequence asserting the page moves itself from
`before-start` to `photos-primary` with no user action; a quiet refresh failure
leaving the surface intact; `pageshow` triggering a recheck; timer re-arming past
the 24-hour cap; clock independence, by driving the transition with the stubbed
relative delay while the browser clock is wrong. All at 390 × 844 and 320 × 844
with the accessibility pass.

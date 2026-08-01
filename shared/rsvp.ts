import {
  MAX_EVENT_RSVP_CAPACITY,
  MAX_HOUSEHOLD_CAPACITY,
  MAX_NAMED_INVITEES_PER_HOUSEHOLD,
  MAX_PLUS_ONES_PER_HOUSEHOLD,
  MAX_RSVP_HOUSEHOLDS,
  MAX_RSVP_HOUSEHOLD_KEY_LENGTH,
  MAX_RSVP_TEXT_LENGTH,
} from './constants';
import type {
  GuestEventPhase,
  GuestPhaseView,
  PhotoIntakeState,
  RsvpAccess,
  RsvpAttendance,
  RsvpInviteeKind,
  RsvpState,
  RsvpSummary,
} from './contracts';

// Re-exported so the RSVP domain reads as one module. `shared/constants.ts`
// remains the only place these numbers are allowed to change.
export {
  MAX_EVENT_RSVP_CAPACITY,
  MAX_HOUSEHOLD_CAPACITY,
  MAX_NAMED_INVITEES_PER_HOUSEHOLD,
  MAX_PLUS_ONES_PER_HOUSEHOLD,
  MAX_RSVP_HOUSEHOLDS,
};

export const RSVP_HOUSEHOLD_KEY_PATTERN = new RegExp(
  `^[a-z0-9][a-z0-9_-]{0,${MAX_RSVP_HOUSEHOLD_KEY_LENGTH - 1}}$`,
  'u',
);

// Written as escaped source rather than literal characters: these classes are
// the whole definition of who can open a household, and a reviewer must be able
// to read which code points are folded without trusting their font.
// U+2018/U+2019 curly quotes and U+02BC modifier letter apostrophe.
const APOSTROPHES = new RegExp('[\\u2018\\u2019\\u02bc]', 'gu');
// U+2010..U+2015 hyphen through horizontal bar, plus U+2212 minus sign.
const DASHES = new RegExp('[\\u2010-\\u2015\\u2212]', 'gu');
const WHITESPACE = /\p{White_Space}+/gu;
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;

/**
 * Version 1 of the exact-name lookup key, frozen for this release. Changing any
 * step of it invalidates every stored `lookup_digest`, so it may only move with
 * a migration that re-digests the roster.
 *
 * Diacritics and every other punctuation mark survive on purpose: "Jose" and
 * "José" are different people, and treating them as one would hand a stranger a
 * household that is not theirs.
 */
export function normalizeInvitedName(value: string): string {
  return value.normalize('NFKC')
    .replace(APOSTROPHES, "'")
    .replace(DASHES, '-')
    .replace(WHITESPACE, ' ')
    .trim()
    .toLowerCase();
}

export type PersonTextIssue = 'empty' | 'too_long' | 'control_character';

export type PersonTextResult =
  | { ok: true; value: string }
  | { ok: false; issue: PersonTextIssue };

/**
 * Validates and cleans text a host typed or uploaded for a household label or a
 * person's name. Unlike the lookup key this preserves the host's own
 * apostrophes and casing, so the name a guest reads back is the name that was
 * written for them.
 *
 * Control and format code points are refused rather than stripped. They are
 * invisible, so silently removing one would let two rows that look identical
 * carry different bytes, and a right-to-left override can reorder a rendered
 * name away from what the host approved.
 */
export function parsePersonText(value: string): PersonTextResult {
  const normalized = value.normalize('NFKC');
  if (CONTROL_OR_FORMAT.test(normalized)) {
    return { ok: false, issue: 'control_character' };
  }
  const collapsed = normalized.replace(WHITESPACE, ' ').trim();
  if (collapsed.length === 0) return { ok: false, issue: 'empty' };
  if (collapsed.length > MAX_RSVP_TEXT_LENGTH) return { ok: false, issue: 'too_long' };
  return { ok: true, value: collapsed };
}

/**
 * The value `migrations/0010_event_start.sql` writes where it cannot compute a
 * correctly zoned start, because SQLite has no IANA database.
 *
 * It is an intermediate migration sentinel and never a live start. A row still
 * holding it keeps the pre-0010 boolean/deadline lifecycle — phase, RSVP route
 * availability, and the household write guard alike — so a deploy that lands
 * before the data-aware backfill cannot begin refusing RSVPs at a start time
 * that is up to fourteen hours wrong. Release closes on there being none left.
 */
export const EVENT_START_MIGRATION_SENTINEL = '1970-01-01T00:00:00.000Z';

export interface EventLifecycleInput {
  // Photo delivery is *permitted* for this event. It no longer means "open":
  // the clock decides that.
  uploadsEnabled: boolean;
  rsvpEnabled: boolean;
  rsvpDeadlineAt: string | null;
  eventStartAt: string;
  // Non-null only when the host opened photo delivery early, holding the server
  // instant at which they did. Null means "open automatically at the start".
  photosOpenFrom: string | null;
  // The irreversible printed-entry stop. It withdraws every guest affordance,
  // including the read-only saved-response lookup.
  entryDisabled?: boolean;
}

function rsvpStateFor(input: EventLifecycleInput, nowMs: number): RsvpState {
  const deadline = input.rsvpDeadlineAt ? Date.parse(input.rsvpDeadlineAt) : NaN;
  if (!Number.isFinite(deadline)) return 'disabled';
  if (nowMs > deadline) return 'closed';
  return input.rsvpEnabled ? 'open' : 'paused';
}

/**
 * The first millisecond on which RSVP reads as closed.
 *
 * The existing contract keeps the deadline instant itself open (`now >
 * deadline` closes it), so a boundary scheduled at the deadline would return
 * the same view and leave a tab editable until some later wake-up. Scheduling
 * the first closed millisecond keeps that semantics without a spin.
 */
function rsvpClosesAt(input: EventLifecycleInput): number | null {
  const deadline = input.rsvpDeadlineAt ? Date.parse(input.rsvpDeadlineAt) : NaN;
  return Number.isFinite(deadline) ? deadline + 1 : null;
}

function nextBoundaryDelay(
  nowMs: number,
  boundaries: readonly (number | null)[],
): number | null {
  let soonest: number | null = null;
  for (const boundary of boundaries) {
    if (boundary === null || !Number.isFinite(boundary)) continue;
    if (boundary <= nowMs) continue;
    if (soonest === null || boundary < soonest) soonest = boundary;
  }
  return soonest === null ? null : soonest - nowMs;
}

export function isLegacyEventStart(eventStartAt: string): boolean {
  return eventStartAt === EVENT_START_MIGRATION_SENTINEL
    || !Number.isFinite(Date.parse(eventStartAt));
}

/**
 * Whether the event's start has passed *and* that start is trustworthy.
 *
 * A migration-sentinel row is never "started", so nothing built on this — the
 * guest RSVP routes above all — begins refusing at an instant that row does not
 * really have.
 */
export function eventStartHasPassed(eventStartAt: string, now = new Date()): boolean {
  if (isLegacyEventStart(eventStartAt)) return false;
  return now.getTime() >= Date.parse(eventStartAt);
}

/**
 * The instant photo delivery is scheduled to open, and whether it has.
 *
 * `uploadsEnabled` is capability; the clock does the opening. Separating them
 * is what lets the schedule be authoritative while still leaving the host an
 * override that a stale page cannot defeat.
 */
export function resolveScheduledOpen(input: EventLifecycleInput): number {
  const early = input.photosOpenFrom ? Date.parse(input.photosOpenFrom) : NaN;
  const start = Date.parse(input.eventStartAt);
  if (Number.isFinite(early)) return early;
  return Number.isFinite(start) ? start : 0;
}

/**
 * Whether the event has begun. A sentinel row has no trustworthy start, so it
 * is treated as begun for the host's photo controls — its pause and reopen keep
 * working exactly as they did before 0010 — while `resolveGuestEventPhase`
 * keeps its guest surface on the old rules.
 */
function hasStarted(input: EventLifecycleInput, nowMs: number): boolean {
  const start = Date.parse(input.eventStartAt);
  return Number.isFinite(start) ? nowMs >= start : true;
}

export function resolveGuestEventPhase(
  input: EventLifecycleInput,
  now = new Date(),
): GuestPhaseView {
  const nowMs = now.getTime();
  const rsvpState = rsvpStateFor(input, nowMs);
  const entryDisabled = input.entryDisabled === true;

  if (isLegacyEventStart(input.eventStartAt)) {
    // Pre-0010 rules, unchanged: the boolean is the override it used to be, and
    // nothing refuses at a start instant this row does not really have.
    const phase: GuestEventPhase = input.uploadsEnabled
      ? 'photos-primary'
      : rsvpState === 'open' ? 'rsvp-primary' : 'waiting';
    const rsvpAccess: RsvpAccess = entryDisabled || rsvpState === 'disabled'
      ? 'unavailable'
      : rsvpState === 'open' ? 'editable' : 'read-only';
    return {
      phase,
      rsvpState,
      rsvpAccess,
      lifecycleRecheckAfterMs: nextBoundaryDelay(nowMs, [rsvpClosesAt(input)]),
    };
  }

  const scheduledOpenAt = resolveScheduledOpen(input);
  const photosOpen = input.uploadsEnabled && nowMs >= scheduledOpenAt;
  const started = hasStarted(input, nowMs);

  const phase: GuestEventPhase = photosOpen
    ? 'photos-primary'
    : !started
      ? (rsvpState === 'open' ? 'rsvp-primary' : 'before-start')
      : 'waiting';

  // Order is the contract. At or after the start RSVP has left the guest
  // experience entirely, without exception; before it, the irreversible entry
  // stop and a disabled RSVP withdraw it; an open RSVP is editable; and every
  // other pre-start state leaves the read-only saved-response window.
  const rsvpAccess: RsvpAccess = started
    ? 'unavailable'
    : entryDisabled || rsvpState === 'disabled'
      ? 'unavailable'
      : rsvpState === 'open' ? 'editable' : 'read-only';

  return {
    phase,
    rsvpState,
    rsvpAccess,
    // Every guest-view boundary, not merely every phase change: during an
    // early-open `photos-primary` period the phase does not move at the
    // deadline or at the start, but the RSVP disclosure goes from editable to
    // read-only and then disappears.
    lifecycleRecheckAfterMs: nextBoundaryDelay(nowMs, [
      scheduledOpenAt,
      Date.parse(input.eventStartAt),
      rsvpClosesAt(input),
    ]),
  };
}

export interface PhotoIntakeView {
  photoIntakeState: PhotoIntakeState;
  photosOpen: boolean;
  photoIntakeRecheckAfterMs: number | null;
}

export function resolvePhotoIntake(
  input: EventLifecycleInput,
  now = new Date(),
): PhotoIntakeView {
  const nowMs = now.getTime();
  const scheduledOpenAt = resolveScheduledOpen(input);
  const started = hasStarted(input, nowMs);
  const photoIntakeRecheckAfterMs = nextBoundaryDelay(nowMs, [
    scheduledOpenAt,
    Date.parse(input.eventStartAt),
  ]);

  if (!input.uploadsEnabled) {
    // Checked first, so an event whose capability is withheld never reports
    // itself as scheduled to open.
    return { photoIntakeState: 'paused', photosOpen: false, photoIntakeRecheckAfterMs };
  }
  if (nowMs < scheduledOpenAt) {
    return { photoIntakeState: 'scheduled', photosOpen: false, photoIntakeRecheckAfterMs };
  }
  return {
    photoIntakeState: started ? 'open' : 'open-early',
    photosOpen: true,
    photoIntakeRecheckAfterMs,
  };
}

export interface HouseholdNameKeys {
  householdId: string;
  nameKeys: readonly string[];
}

export type RsvpCollisionCode =
  | 'household_duplicate_name'
  | 'household_lookup_unresolvable';

export interface RsvpCollisionIssue {
  householdId: string;
  nameKey: string;
  code: RsvpCollisionCode;
}

/**
 * Decides whether every active household can still be reached by exact name.
 *
 * A guest may submit one name and, if that is ambiguous, a second. The server
 * then intersects the households holding both names. So a shared name `d` in
 * household `H` is only acceptable when `H` also holds some other name `e`
 * whose household set narrows the pair down to exactly `H`. Note that `e` may
 * itself be shared — what matters is the intersection, not whether `e` is
 * unique on its own.
 *
 * Callers pass either normalized names or their keyed digests; both partition
 * the roster identically.
 */
export function findLookupCollisions(
  households: readonly HouseholdNameKeys[],
): RsvpCollisionIssue[] {
  const owners = new Map<string, Set<string>>();
  for (const household of households) {
    for (const nameKey of household.nameKeys) {
      const existing = owners.get(nameKey);
      if (existing) existing.add(household.householdId);
      else owners.set(nameKey, new Set([household.householdId]));
    }
  }

  const issues: RsvpCollisionIssue[] = [];
  for (const household of households) {
    const seen = new Set<string>();
    const distinct: string[] = [];
    for (const nameKey of household.nameKeys) {
      if (seen.has(nameKey)) {
        issues.push({
          householdId: household.householdId,
          nameKey,
          code: 'household_duplicate_name',
        });
        continue;
      }
      seen.add(nameKey);
      distinct.push(nameKey);
    }

    for (const nameKey of distinct) {
      const holders = owners.get(nameKey);
      if (!holders || holders.size <= 1) continue;
      const resolvable = distinct.some((other) => {
        if (other === nameKey) return false;
        const otherHolders = owners.get(other);
        if (!otherHolders) return false;
        // Both sets contain this household, so an intersection of exactly one
        // is an intersection of exactly this household.
        let shared = 0;
        for (const holder of holders) {
          if (!otherHolders.has(holder)) continue;
          shared += 1;
          if (shared > 1) return false;
        }
        return shared === 1;
      });
      if (!resolvable) {
        issues.push({
          householdId: household.householdId,
          nameKey,
          code: 'household_lookup_unresolvable',
        });
      }
    }
  }
  return issues;
}

export type HouseholdCapacityIssue =
  | 'household_named_required'
  | 'household_named_limit'
  | 'plus_one_slots_invalid'
  | 'household_capacity_limit';

/**
 * Shared by CSV import, manual host edits, and RSVP activation so one household
 * cannot pass through one door and fail at another.
 */
export function checkHouseholdCapacity(input: {
  namedCount: number;
  plusOneSlots: number;
}): HouseholdCapacityIssue | null {
  if (
    !Number.isInteger(input.plusOneSlots)
    || input.plusOneSlots < 0
    || input.plusOneSlots > MAX_PLUS_ONES_PER_HOUSEHOLD
  ) {
    return 'plus_one_slots_invalid';
  }
  if (input.namedCount < 1) return 'household_named_required';
  if (input.namedCount > MAX_NAMED_INVITEES_PER_HOUSEHOLD) return 'household_named_limit';
  if (input.namedCount + input.plusOneSlots > MAX_HOUSEHOLD_CAPACITY) {
    return 'household_capacity_limit';
  }
  return null;
}

export type RosterCapacityIssue = 'event_household_limit' | 'event_capacity_limit';

export function checkRosterCapacity(input: {
  households: number;
  invitedCapacity: number;
}): RosterCapacityIssue | null {
  if (input.households > MAX_RSVP_HOUSEHOLDS) return 'event_household_limit';
  if (input.invitedCapacity > MAX_EVENT_RSVP_CAPACITY) return 'event_capacity_limit';
  return null;
}

export interface RsvpSummaryInvitee {
  kind: RsvpInviteeKind;
  attendance: RsvpAttendance;
}

export interface RsvpSummaryHousehold {
  archived: boolean;
  invitees: readonly RsvpSummaryInvitee[];
}

/**
 * Totals are always derived from the current invitee rows of active households.
 * Nothing here reads a stored counter, so an archived household leaves the
 * numbers the moment it is archived and a host page can never drift.
 */
export function deriveRsvpSummary(
  households: readonly RsvpSummaryHousehold[],
): RsvpSummary {
  let namedInvitees = 0;
  let plusOneCapacity = 0;
  let attending = 0;
  let declined = 0;
  let awaitingResponse = 0;
  let householdsResponded = 0;
  let householdsAwaitingResponse = 0;

  for (const household of households) {
    if (household.archived) continue;
    let pending = 0;
    for (const invitee of household.invitees) {
      if (invitee.kind === 'named') namedInvitees += 1;
      else plusOneCapacity += 1;

      if (invitee.attendance === 'attending') attending += 1;
      else if (invitee.attendance === 'declined') declined += 1;
      else {
        awaitingResponse += 1;
        pending += 1;
      }
    }
    if (pending > 0) householdsAwaitingResponse += 1;
    else householdsResponded += 1;
  }

  return {
    invitedCapacity: namedInvitees + plusOneCapacity,
    namedInvitees,
    plusOneCapacity,
    attending,
    declined,
    awaitingResponse,
    householdsResponded,
    householdsAwaitingResponse,
  };
}

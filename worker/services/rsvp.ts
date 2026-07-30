import type {
  RsvpHouseholdView,
  RsvpImportCommitResponse,
  RsvpImportPreview,
  RsvpSubmissionInvitee,
  RsvpSubmissionRequest,
  RsvpSubmissionResponse,
} from '../../shared/contracts';
import { parseRsvpCsv } from '../../shared/csv';
import { ApiError } from '../../shared/errors';
import {
  checkHouseholdCapacity,
  checkRosterCapacity,
  findLookupCollisions,
  normalizeInvitedName,
  parsePersonText,
  resolveGuestEventPhase,
} from '../../shared/rsvp';
import { EventsRepository } from '../db/events';
import type { AuthenticatedHousehold } from '../auth/rsvp';
import {
  buildRosterStatements,
  COMMIT_HOUSEHOLD_SQL,
  RsvpRepository,
  SUBMIT_INVITEES_SQL,
  type RosterInviteeInput,
} from '../db/rsvp';
import {
  RSVP_LOOKUP_IP_LIMIT,
  RSVP_LOOKUP_NAME_LIMIT,
  RsvpRateLimitsRepository,
} from '../db/rsvp-rate-limits';
import type { EventRecord, RsvpHouseholdRecord, RsvpInviteeRecord } from '../db/types';
import type { AppEnv } from '../env';
import { digestSecret } from '../security/crypto';

function rosterInvalid(message: string): ApiError {
  return new ApiError('RSVP_ROSTER_INVALID', message, 409);
}

function importConflict(message: string): ApiError {
  return new ApiError('RSVP_IMPORT_CONFLICT', message, 409);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The guard's `ELSE NULL` is load-bearing. `rsvp_roster_version` is NOT NULL, so
 * a refused import aborts the statement and rolls the whole batch back, rather
 * than quietly matching no rows and letting the inserts behind it land.
 */
const IMPORT_GUARD_SQL = `
  UPDATE events
  SET rsvp_roster_version = CASE
    WHEN rsvp_roster_version = ?
      AND rsvp_enabled = 0
      AND deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM rsvp_households WHERE event_id = events.id)
    THEN rsvp_roster_version + 1
    ELSE NULL
  END
  WHERE id = ?
`;

// The guard aborting, or a concurrent import winning a household key, are the
// two refusals this path expects. Anything else is a real fault and must not be
// dressed up as a conflict the host could resolve by trying again.
function isExpectedImportAbort(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('NOT NULL constraint failed: events.rsvp_roster_version')
    || message.includes('UNIQUE constraint failed: rsvp_households');
}

// The service answers with the household record; the route turns it into the
// view a guest may see, because only the route knows which session is asking.
export type RsvpLookupResult =
  | { status: 'matched'; household: RsvpHouseholdRecord }
  | { status: 'second_name_required' }
  | { status: 'not_available'; message: string };

export class RsvpService {
  private readonly events: EventsRepository;
  private readonly rates: RsvpRateLimitsRepository;
  private readonly rsvp: RsvpRepository;

  constructor(private readonly env: AppEnv) {
    this.events = new EventsRepository(env.DB);
    this.rates = new RsvpRateLimitsRepository(env.DB, env.RSVP_LOOKUP_HMAC_KEY);
    this.rsvp = new RsvpRepository(env.DB);
  }

  /**
   * Decides whether RSVP may be switched on right now, and reports the roster
   * version it decided against.
   *
   * The version travels back to the caller so the write that follows can be
   * guarded on the same value. Validating a roster and then opening RSVP
   * against a different one is the failure this exists to prevent.
   *
   * Everything checked here is a reason a guest would be unable to reach their
   * own invitation: an empty list, a household nobody named, a name that cannot
   * be told from another household's, or more people than the event holds.
   */
  async assertRosterCanOpen(eventId: string): Promise<{ rosterVersion: number }> {
    const event = await this.events.getById(eventId);
    if (!event) throw new ApiError('EVENT_NOT_FOUND', 'This event could not be found.', 404);

    const households = await this.rsvp.listHouseholdCompositions(eventId);
    if (households.length === 0) {
      throw rosterInvalid('Add a guest list before accepting RSVPs.');
    }

    const namelessHouseholds = households.filter((household) => household.namedCount === 0);
    if (namelessHouseholds.length > 0) {
      throw rosterInvalid(
        `${namelessHouseholds.length} household${namelessHouseholds.length === 1 ? '' : 's'} `
        + 'have no named guest, so nobody could look them up. Add a name to each.',
      );
    }

    for (const household of households) {
      const capacity = checkHouseholdCapacity({
        namedCount: household.namedCount,
        plusOneSlots: household.plusOneCount,
      });
      if (capacity) {
        throw rosterInvalid('A household is over its size limit. Review the guest list.');
      }
    }

    const invitedCapacity = households.reduce(
      (total, household) => total + household.namedCount + household.plusOneCount,
      0,
    );
    const roster = checkRosterCapacity({ households: households.length, invitedCapacity });
    if (roster === 'event_household_limit') {
      throw rosterInvalid('This event can hold at most 500 households.');
    }
    if (roster === 'event_capacity_limit') {
      throw rosterInvalid('This event can invite at most 500 people including plus-one slots.');
    }

    const collisions = findLookupCollisions(await this.rsvp.listActiveLookupKeys(eventId));
    if (collisions.length > 0) {
      const affected = new Set(collisions.map((collision) => collision.householdId)).size;
      throw rosterInvalid(
        `${affected} household${affected === 1 ? '' : 's'} cannot be told apart by name. `
        + 'Add a distinguishing name to each before accepting RSVPs.',
      );
    }

    return { rosterVersion: event.rsvpRosterVersion };
  }

  /**
   * What one household is allowed to see about itself.
   *
   * `deadlineAt` is the event's deadline, because that is the date on the
   * invitation. The session's own captured window shows up as `editable` and
   * `renewalRequired` instead, which is what the guest can act on.
   */
  householdView(
    event: EventRecord,
    household: RsvpHouseholdRecord,
    invitees: readonly RsvpInviteeRecord[],
    session: { writeAuthorityDeadline: string } | null,
    now = new Date(),
  ): RsvpHouseholdView {
    const { rsvpState } = resolveGuestEventPhase(event, now);
    const sessionOpen = session
      ? now.getTime() <= Date.parse(session.writeAuthorityDeadline)
      : false;
    return {
      id: household.id,
      label: household.label,
      version: household.version,
      editable: rsvpState === 'open' && sessionOpen,
      // The event is still open, but this device's proof is older than the
      // deadline it was given. A fresh exact lookup restores the window.
      renewalRequired: rsvpState === 'open' && session !== null && !sessionOpen,
      deadlineAt: event.rsvpDeadlineAt ?? '',
      invitees: invitees.map((invitee) => ({
        id: invitee.id,
        kind: invitee.kind,
        displayName: invitee.displayName,
        attendance: invitee.attendance,
        order: invitee.sortOrder,
      })),
      firstRespondedAt: household.firstRespondedAt,
      latestRespondedAt: household.latestRespondedAt,
      latestActor: household.latestActorKind,
    };
  }

  /**
   * Charges the durable half of the abuse budget: one attempt against the
   * caller's address, and one against each name they submitted.
   *
   * Naming a second person costs a second name-attempt, so a two-name probe
   * cannot search twice as fast as a one-name probe.
   */
  async reserveLookupAttempts(
    event: EventRecord,
    ip: string,
    names: readonly string[],
    now = new Date(),
  ): Promise<void> {
    const refusals: boolean[] = [
      await this.rates.reserve({
        eventId: event.id,
        action: 'lookup_ip',
        normalizedValue: ip,
        limit: RSVP_LOOKUP_IP_LIMIT,
        now,
      }),
    ];
    for (const name of names) {
      refusals.push(await this.rates.reserve({
        eventId: event.id,
        action: 'lookup_name',
        normalizedValue: normalizeInvitedName(name),
        limit: RSVP_LOOKUP_NAME_LIMIT,
        now,
      }));
    }
    // Every budget is charged before any is checked, so a refusal cannot be
    // used to learn which of the two limits was reached.
    if (refusals.includes(false)) {
      throw new ApiError(
        'RATE_LIMITED',
        'Too many attempts. Try again in a few minutes.',
        429,
      );
    }
  }

  /**
   * Resolves an exact name, or one of two exact names, to a single household.
   *
   * Every way this can fail answers with the same generic shape. A stranger
   * guessing names must not be able to tell a miss from a paused event, an
   * archived household, or a name that exists in two households — each of those
   * is a fact about somebody's guest list.
   */
  async lookup(
    event: EventRecord,
    input: { firstName: string; secondName?: string },
    now = new Date(),
  ): Promise<RsvpLookupResult> {
    const notAvailable = {
      status: 'not_available',
      message: 'We could not open an invitation with those details.',
    } as const;

    const { rsvpState } = resolveGuestEventPhase(event, now);
    if (rsvpState === 'disabled') return notAvailable;

    const names = [input.firstName, input.secondName]
      .filter((name): name is string => typeof name === 'string' && name.trim().length > 0);
    if (names.length === 0) return notAvailable;

    const matches: string[][] = [];
    for (const name of names) {
      matches.push(await this.rsvp.householdsByLookupDigest(
        event.id,
        await this.lookupDigest(event.id, normalizeInvitedName(name)),
      ));
    }

    const candidates = matches.reduce<string[]>(
      (narrowed, current) => narrowed.filter((id) => current.includes(id)),
      matches[0] ?? [],
    );
    if (candidates.length === 0) return notAvailable;
    if (candidates.length > 1) {
      // Only ever with one name in hand: two names that still do not resolve is
      // a dead end, not an invitation to keep guessing.
      return names.length === 1 ? { status: 'second_name_required' } : notAvailable;
    }

    const household = await this.rsvp.getHousehold(event.id, candidates[0]!);
    if (!household || household.archivedAt) return notAvailable;
    // Paused or closed, a household may still read what it already sent. One
    // that never answered stays invisible, so the closed state cannot be used
    // to confirm that a name is on the list.
    if (rsvpState !== 'open' && !household.firstRespondedAt) return notAvailable;

    return { status: 'matched', household };
  }

  /**
   * Turns a submitted set of answers into the exact rows that will be written,
   * refusing anything that is not a complete answer for this household.
   *
   * The submitted set has to be the household's whole active set: no invented
   * ids, none omitted, none repeated. A partial submission is not a smaller
   * update, it is a request whose meaning cannot be determined.
   */
  private canonicalize(
    invitees: readonly RsvpInviteeRecord[],
    submitted: readonly RsvpSubmissionInvitee[],
  ): RsvpSubmissionInvitee[] {
    const byId = new Map(invitees.map((invitee) => [invitee.id, invitee]));
    const seen = new Set<string>();
    for (const row of submitted) {
      if (!byId.has(row.id) || seen.has(row.id)) {
        throw new ApiError(
          'VALIDATION_FAILED',
          'This response does not match the current guest list. Reload and try again.',
          422,
        );
      }
      seen.add(row.id);
    }
    if (seen.size !== invitees.length) {
      throw new ApiError(
        'VALIDATION_FAILED',
        'Choose attending or not attending for everyone in the household.',
        422,
      );
    }

    const answers = new Map(submitted.map((row) => [row.id, row]));
    // Sorted by the stored order rather than the order the browser sent, so the
    // digest is a property of the answer and not of the request.
    return [...invitees]
      .sort((left, right) => left.sortOrder - right.sortOrder)
      .map((invitee) => {
        const answer = answers.get(invitee.id)!;
        if (invitee.kind === 'named') {
          // A named guest's name belongs to the roster, not to the response.
          return { id: invitee.id, attendance: answer.attendance, displayName: invitee.displayName };
        }
        if (answer.attendance !== 'attending') {
          // A declined slot carries no name at all: nobody is coming in it.
          return { id: invitee.id, attendance: answer.attendance, displayName: null };
        }
        const name = parsePersonText(answer.displayName ?? '');
        if (!name.ok) {
          throw new ApiError(
            'VALIDATION_FAILED',
            'Enter a name for each attending guest.',
            422,
            { [`${invitee.id}.displayName`]: 'Enter this guest’s name.' },
          );
        }
        return { id: invitee.id, attendance: answer.attendance, displayName: name.value };
      });
  }

  private async requestDigest(
    version: number,
    invitees: readonly RsvpSubmissionInvitee[],
  ): Promise<string> {
    return sha256Hex(JSON.stringify({
      version,
      invitees: invitees.map(({ id, attendance, displayName }) => ({ id, attendance, displayName })),
    }));
  }

  /**
   * Commits one household's response.
   *
   * Two different things can look like a repeat, and they are answered
   * differently. The same idempotency key with the same answer is a lost
   * confirmation, and replays as success even if the household has moved on
   * since — a guest on a bad connection must never be asked to answer twice.
   * The same key with a *different* answer is a bug or a tampered retry, and is
   * refused rather than silently applied.
   */
  async submitHousehold(
    auth: AuthenticatedHousehold,
    request: RsvpSubmissionRequest,
    now = new Date(),
  ): Promise<RsvpSubmissionResponse> {
    const invitees = await this.rsvp.listInvitees(auth.event.id, auth.household.id);
    const canonical = this.canonicalize(invitees, request.invitees);
    const digest = await this.requestDigest(request.version, canonical);

    const replayed = await this.settleReceipt(auth, request, digest, now);
    if (replayed) return replayed;

    if (request.version !== auth.household.version) {
      throw this.householdConflict();
    }

    const nowIso = now.toISOString();
    try {
      const results = await this.env.DB.batch([
        this.env.DB.prepare(SUBMIT_INVITEES_SQL).bind(
          JSON.stringify(canonical),
          nowIso,
          auth.event.id,
          auth.household.id,
          auth.household.id,
          request.version,
          nowIso,
          auth.session.id,
          nowIso,
          nowIso,
        ),
        this.env.DB.prepare(COMMIT_HOUSEHOLD_SQL).bind(
          canonical.length,
          request.idempotencyKey,
          digest,
          nowIso,
          nowIso,
          'household',
          nowIso,
          auth.household.id,
          auth.event.id,
          request.version,
        ),
        this.rsvp.receiptStatement({
          eventId: auth.event.id,
          householdId: auth.household.id,
          idempotencyKey: request.idempotencyKey,
          requestDigest: digest,
          resultVersion: request.version + 1,
          createdAt: nowIso,
        }),
      ]);
      // A guarded write that matched nothing means the deadline passed, RSVP
      // paused, or the session lapsed between the check and the write.
      if ((results[1]?.meta.changes ?? 0) !== 1) {
        throw this.householdConflict();
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // A concurrent identical request won the receipt key. Whether that is a
      // success or a conflict is decided by the digest, exactly as above.
      const settled = await this.settleReceipt(auth, request, digest, now);
      if (settled) return settled;
      throw this.householdConflict();
    }

    return {
      household: await this.currentHouseholdView(auth, now),
      committedVersion: request.version + 1,
      replayed: false,
    };
  }

  private async settleReceipt(
    auth: AuthenticatedHousehold,
    request: RsvpSubmissionRequest,
    digest: string,
    now: Date,
  ): Promise<RsvpSubmissionResponse | null> {
    const receipt = await this.rsvp.getReceipt(auth.household.id, request.idempotencyKey);
    if (!receipt) return null;
    if (receipt.requestDigest !== digest) {
      throw new ApiError(
        'RSVP_SUBMISSION_CONFLICT',
        'This response was already sent with different answers. Reload and review it.',
        409,
      );
    }
    return {
      household: await this.currentHouseholdView(auth, now),
      committedVersion: receipt.resultVersion,
      replayed: true,
    };
  }

  private async currentHouseholdView(
    auth: AuthenticatedHousehold,
    now: Date,
  ): Promise<RsvpHouseholdView> {
    const household = await this.rsvp.getHousehold(auth.event.id, auth.household.id);
    if (!household) throw new ApiError('EVENT_NOT_FOUND', 'This invitation is no longer available.', 404);
    const invitees = await this.rsvp.listInvitees(auth.event.id, household.id);
    const event = await this.events.getById(auth.event.id) ?? auth.event;
    return this.householdView(event, household, invitees, auth.session, now);
  }

  /**
   * A conflict carries a message and nothing else; the caller re-reads the
   * household. The error envelope has one shape across this whole API, and
   * smuggling a view through `fieldErrors` to save a request would break it.
   *
   * What matters is that nothing is written: the respondent reads what is there
   * now before replacing it, which is the whole difference between resolving a
   * conflict and overwriting somebody.
   */
  private householdConflict(): ApiError {
    return new ApiError(
      'RSVP_HOUSEHOLD_CONFLICT',
      'This invitation changed since you opened it. Review it and send again.',
      409,
    );
  }

  private lookupDigest(eventId: string, normalizedName: string): Promise<string> {
    return digestSecret(
      `rsvp-name:v1:${eventId}:${normalizedName}`,
      this.env.RSVP_LOOKUP_HMAC_KEY,
    );
  }

  /**
   * Reads an uploaded file and reports what it would create, or every reason it
   * cannot be used. Writes nothing.
   *
   * A blocking file still answers 200: the issues *are* the preview result, and
   * a host who uploaded the wrong export needs to read them, not a status code.
   *
   * Collision resolvability is decided on normalized names rather than on the
   * keyed digests stored later. Within one event the digest is a deterministic
   * function of the normalized name, so the two partition the roster
   * identically, and preview has no reason to hold key material.
   */
  async previewImport(event: EventRecord, csv: string): Promise<RsvpImportPreview> {
    const parsed = parseRsvpCsv(csv);
    return {
      issues: parsed.issues,
      totals: parsed.totals,
      sourceDigest: await sha256Hex(csv),
      rosterVersion: event.rsvpRosterVersion,
    };
  }

  /**
   * Commits the first and only roster import for an event.
   *
   * Everything is recomputed from the submitted file: the preview is a
   * courtesy, not evidence. The digest proves the host is committing the file
   * they looked at, and the guarded batch proves the event is still empty,
   * still closed, and still at the version that was previewed.
   */
  async commitInitialImport(
    event: EventRecord,
    input: { csv: string; sourceDigest: string; expectedRosterVersion: number },
  ): Promise<RsvpImportCommitResponse> {
    const parsed = parseRsvpCsv(input.csv);
    if (parsed.issues.length > 0) {
      throw importConflict('This guest list has problems that must be fixed before importing.');
    }
    if (await sha256Hex(input.csv) !== input.sourceDigest) {
      throw importConflict('This file changed since it was checked. Preview it again.');
    }
    if (input.expectedRosterVersion !== event.rsvpRosterVersion) {
      throw importConflict('The guest list changed since this file was checked. Preview it again.');
    }

    const createdAt = new Date().toISOString();
    const households = parsed.households.map((household) => ({
      id: crypto.randomUUID(),
      householdKey: household.householdKey,
      label: household.label,
    }));

    const invitees: RosterInviteeInput[] = [];
    for (const [index, household] of parsed.households.entries()) {
      const householdId = households[index]!.id;
      // Named guests first, then the fixed plus-one slots. The order is stable
      // so a host reading the list and a guest answering it see the same rows.
      for (const [order, invitee] of household.invitees.entries()) {
        invitees.push({
          id: crypto.randomUUID(),
          householdId,
          kind: 'named',
          displayName: invitee.displayName,
          lookupDigest: await this.lookupDigest(event.id, invitee.normalizedName),
          sortOrder: order,
        });
      }
      for (let slot = 0; slot < household.plusOneSlots; slot += 1) {
        invitees.push({
          id: crypto.randomUUID(),
          householdId,
          kind: 'plus_one',
          displayName: null,
          lookupDigest: null,
          sortOrder: household.invitees.length + slot,
        });
      }
    }

    const plans = buildRosterStatements({
      eventId: event.id,
      households,
      invitees,
      createdAt,
    });

    try {
      await this.env.DB.batch([
        this.env.DB.prepare(IMPORT_GUARD_SQL).bind(input.expectedRosterVersion, event.id),
        ...this.rsvp.toStatements(plans),
      ]);
    } catch (error) {
      if (!isExpectedImportAbort(error)) throw error;
      throw importConflict(
        'This event already has a guest list, or RSVP is already open. Reload and try again.',
      );
    }

    return { totals: parsed.totals, rosterVersion: input.expectedRosterVersion + 1 };
  }
}

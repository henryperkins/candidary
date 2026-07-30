import type {
  RsvpImportCommitResponse,
  RsvpImportPreview,
} from '../../shared/contracts';
import { parseRsvpCsv } from '../../shared/csv';
import { ApiError } from '../../shared/errors';
import {
  checkHouseholdCapacity,
  checkRosterCapacity,
  findLookupCollisions,
} from '../../shared/rsvp';
import { EventsRepository } from '../db/events';
import { buildRosterStatements, RsvpRepository, type RosterInviteeInput } from '../db/rsvp';
import type { EventRecord } from '../db/types';
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

export class RsvpService {
  private readonly events: EventsRepository;
  private readonly rsvp: RsvpRepository;

  constructor(private readonly env: AppEnv) {
    this.events = new EventsRepository(env.DB);
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

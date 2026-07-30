import { ApiError } from '../../shared/errors';
import {
  checkHouseholdCapacity,
  checkRosterCapacity,
  findLookupCollisions,
} from '../../shared/rsvp';
import { EventsRepository } from '../db/events';
import { RsvpRepository } from '../db/rsvp';
import type { AppEnv } from '../env';

function rosterInvalid(message: string): ApiError {
  return new ApiError('RSVP_ROSTER_INVALID', message, 409);
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
}

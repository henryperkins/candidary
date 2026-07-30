import { ApiError } from '../../shared/errors';
import { EventsRepository } from '../db/events';
import { RsvpRepository } from '../db/rsvp';
import { RsvpSessionsRepository } from '../db/rsvp-sessions';
import type { EventRecord, RsvpHouseholdRecord, RsvpSessionRecord } from '../db/types';
import type { AppEnv } from '../env';
import { constantTimeEqual, createSecretToken, digestSecret } from '../security/crypto';

export interface AuthenticatedHousehold {
  event: EventRecord;
  household: RsvpHouseholdRecord;
  session: RsvpSessionRecord;
}

function sessionRequired(): ApiError {
  return new ApiError(
    'RSVP_SESSION_REQUIRED',
    'Find your invitation again to continue.',
    401,
  );
}

/**
 * The third authority in the system, beside the event guest session and the
 * host account session.
 *
 * It speaks for exactly one household of one event. It cannot upload a photo,
 * read a gallery, or touch anything a manager can, and no other credential can
 * stand in for it.
 */
export class RsvpAuthService {
  private readonly events: EventsRepository;
  private readonly rsvp: RsvpRepository;
  private readonly sessions: RsvpSessionsRepository;

  constructor(private readonly env: AppEnv) {
    this.events = new EventsRepository(env.DB);
    this.rsvp = new RsvpRepository(env.DB);
    this.sessions = new RsvpSessionsRepository(env.DB);
  }

  /**
   * Mints a household session after an exact-name match.
   *
   * `writeAuthorityDeadline` freezes the event's deadline as it stood when this
   * device proved who it was. Shortening the event deadline beats it because
   * writes check both; extending it does not, so a longer window requires
   * proving identity again rather than being granted to a cookie that has been
   * sitting on a phone.
   */
  async create(event: EventRecord, household: RsvpHouseholdRecord, now = new Date()) {
    if (!event.rsvpDeadlineAt) {
      throw new ApiError('RSVP_UNAVAILABLE', 'RSVP is not open for this event.', 409);
    }
    const sessionToken = createSecretToken();
    const csrfToken = createSecretToken().secret;
    const session = await this.sessions.create({
      id: sessionToken.id,
      secretDigest: await digestSecret(sessionToken.secret, this.env.SESSION_HMAC_KEY),
      csrfDigest: await digestSecret(csrfToken, this.env.SESSION_HMAC_KEY),
      eventId: event.id,
      householdId: household.id,
      writeAuthorityDeadline: event.rsvpDeadlineAt,
      expiresAt: event.guestAccessExpiresAt,
      createdAt: now.toISOString(),
    });
    return { session, sessionToken, csrfToken };
  }

  async resolve(rawSession: string | undefined, now = new Date()): Promise<AuthenticatedHousehold> {
    if (!rawSession) throw sessionRequired();
    const [id, secret, extra] = rawSession.split('.');
    if (!id || !secret || extra) throw sessionRequired();

    const session = await this.sessions.getById(id);
    if (!session) throw sessionRequired();
    const supplied = await digestSecret(secret, this.env.SESSION_HMAC_KEY);
    if (!constantTimeEqual(supplied, session.secretDigest)) throw sessionRequired();
    if (session.revokedAt || Date.parse(session.expiresAt) <= now.getTime()) {
      throw sessionRequired();
    }

    // Scoped by event as well as id, so a session can never be pointed at a
    // household that belongs to somebody else's event.
    const household = await this.rsvp.getHousehold(session.eventId, session.householdId);
    if (!household || household.archivedAt) throw sessionRequired();

    const event = await this.events.getById(session.eventId);
    if (!event) throw new ApiError('EVENT_NOT_FOUND', 'This event could not be found.', 404);
    if (event.deletedAt) throw new ApiError('EVENT_DELETED', 'This event has been deleted.', 410);

    return { event, household, session };
  }
}

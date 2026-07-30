import { ApiError } from '../../shared/errors';
import { EventEntriesRepository } from '../db/event-entries';
import { RsvpSessionsRepository } from '../db/rsvp-sessions';
import { TokensRepository } from '../db/tokens';
import type { EventEntryRecord, EventRecord } from '../db/types';
import type { AppEnv } from '../env';
import {
  createSecretToken,
  decryptSecret,
  digestSecret,
  encryptSecret,
} from '../security/crypto';

function entryUnavailable(): ApiError {
  return new ApiError(
    'EVENT_ENTRY_UNAVAILABLE',
    'This event entry has been disabled and cannot be reopened.',
    410,
  );
}

export class EventEntryService {
  private readonly entries: EventEntriesRepository;
  private readonly rsvpSessions: RsvpSessionsRepository;
  private readonly tokens: TokensRepository;

  constructor(private readonly env: AppEnv) {
    this.entries = new EventEntriesRepository(env.DB);
    this.rsvpSessions = new RsvpSessionsRepository(env.DB);
    this.tokens = new TokensRepository(env.DB);
  }

  private origin(): string {
    return this.env.APP_ORIGIN.replace(/\/$/u, '');
  }

  /**
   * The gate every path that would reopen guest access has to pass through.
   *
   * Disabling is irreversible by design, so manager authority — link or account
   * — must not be able to route around it. An event with no entry row at all is
   * pre-0008 and equally unusable: there is no backfill.
   */
  async requireOpenEntry(eventId: string): Promise<EventEntryRecord> {
    const entry = await this.entries.getForEvent(eventId);
    if (!entry || entry.disabledAt) throw entryUnavailable();
    return entry;
  }

  async recover(eventId: string): Promise<{ eventLink: string | null; disabledAt: string | null }> {
    const entry = await this.entries.getForEvent(eventId);
    if (!entry) throw entryUnavailable();
    if (entry.disabledAt) return { eventLink: null, disabledAt: entry.disabledAt };
    const secret = await decryptSecret(entry.secretCiphertext, this.env.ENTRY_ENCRYPTION_KEY);
    return { eventLink: `${this.origin()}/join#${entry.id}.${secret}`, disabledAt: null };
  }

  /**
   * Replaces the internal guest grant, which signs every guest device out and
   * forces a rescan. The printed credential is untouched, so the QR on the
   * invitations and the signs at the venue keep working unchanged — that is the
   * entire point of keeping the two credentials separate.
   */
  async rotateInternalGuestGrant(event: EventRecord, now = new Date()) {
    await this.requireOpenEntry(event.id);
    await this.tokens.revokeRole(event.id, 'guest', now.toISOString());
    const replacement = createSecretToken();
    await this.tokens.create({
      id: replacement.id,
      eventId: event.id,
      role: 'guest',
      secretDigest: await digestSecret(replacement.secret, this.env.TOKEN_HMAC_KEY),
      secretCiphertext: await encryptSecret(
        replacement.secret,
        this.env.GUEST_TOKEN_ENCRYPTION_KEY,
      ),
      expiresAt: event.guestAccessExpiresAt,
      createdAt: now.toISOString(),
    });
    const recovered = await this.recover(event.id);
    return { rotated: true as const, eventLink: recovered.eventLink! };
  }

  /**
   * The emergency stop. One batch ends the entry, pauses both intakes, and
   * revokes every guest and household credential for the event. Manager and
   * host-account sessions are deliberately untouched: this protects guests from
   * a credential that escaped, and locking the host out of their own event in
   * the same moment would help nobody.
   */
  async disable(event: EventRecord, now = new Date()): Promise<{ disabledAt: string }> {
    const timestamp = now.toISOString();
    await this.env.DB.batch([
      this.env.DB.prepare(`
        UPDATE event_entry_credentials SET disabled_at = ?
        WHERE event_id = ? AND disabled_at IS NULL
      `).bind(timestamp, event.id),
      this.env.DB.prepare(`
        UPDATE events SET uploads_enabled = 0, rsvp_enabled = 0 WHERE id = ?
      `).bind(event.id),
      this.env.DB.prepare(`
        UPDATE event_access_tokens SET revoked_at = ?
        WHERE event_id = ? AND role = 'guest' AND revoked_at IS NULL
      `).bind(timestamp, event.id),
      this.env.DB.prepare(`
        UPDATE event_sessions SET revoked_at = ?
        WHERE event_id = ? AND role = 'guest' AND revoked_at IS NULL
      `).bind(timestamp, event.id),
      this.rsvpSessions.revokeForEventStatement(event.id, timestamp),
    ]);

    // Read back rather than return `timestamp`: a host who confirms twice must
    // see when it actually happened, not when they clicked again.
    const entry = await this.entries.getForEvent(event.id);
    if (!entry?.disabledAt) throw entryUnavailable();
    return { disabledAt: entry.disabledAt };
  }
}

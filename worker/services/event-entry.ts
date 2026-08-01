import { ApiError } from '../../shared/errors';
import { EventEntriesRepository } from '../db/event-entries';
import { RsvpSessionsRepository } from '../db/rsvp-sessions';
import { TokensRepository } from '../db/tokens';
import type { EventEntryRecord, EventRecord } from '../db/types';
import type { AppEnv } from '../env';
import {
  constantTimeEqual,
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
   * Turns an event created before 0008 into one with a printed credential,
   * without invalidating the code already printed on its invitations.
   *
   * The QR those events carry is `/join/<id>.<secret>`, where the token is the
   * event's guest access token — and that secret is recoverable, because it was
   * stored as ciphertext so a host could redisplay the share link. So adoption
   * copies it rather than minting a new one: same id, same secret, re-digested
   * under `ENTRY_HMAC_KEY` and re-encrypted under `ENTRY_ENCRYPTION_KEY`. The
   * string in the printed code becomes the entry credential exactly.
   *
   * Copying rather than pointing at the same row is what makes it durable. The
   * entry credential is its own row, so signing guest devices out replaces the
   * internal grant and leaves the printed code working — the same guarantee an
   * event created after 0008 gets, rather than a QR that dies on the first
   * rotation.
   *
   * Idempotent, and safe to lose a race: `event_id` is unique, so a second
   * caller's insert fails and it re-reads the row the first one wrote.
   */
  private async adoptLegacyEntry(eventId: string, now: Date): Promise<EventEntryRecord | null> {
    const token = await this.tokens.getActiveForRole(eventId, 'guest');
    if (!token?.secretCiphertext) return null;

    let secret: string;
    try {
      secret = await decryptSecret(token.secretCiphertext, this.env.GUEST_TOKEN_ENCRYPTION_KEY);
    } catch {
      // A grant this Worker cannot decrypt cannot be adopted. The event keeps
      // working for whoever already holds a session; nothing here is destroyed.
      return null;
    }

    try {
      await this.entries.createLegacyAdoptionStatement({
        id: token.id,
        eventId,
        secretDigest: await digestSecret(secret, this.env.ENTRY_HMAC_KEY),
        secretCiphertext: await encryptSecret(secret, this.env.ENTRY_ENCRYPTION_KEY),
        createdAt: now.toISOString(),
      }).run();
    } catch {
      // Adopted concurrently. That row is the same credential, so read it.
    }
    return this.entries.getForEvent(eventId);
  }

  /**
   * Adopts from a printed token the holder has proved they possess.
   *
   * The manager paths below can adopt from the event id alone because they are
   * already authorized. This one is reached by an unauthenticated scan, so the
   * supplied secret is verified against the stored guest-token digest first —
   * the caller has to already hold guest access before anything is written.
   */
  async adoptPrintedToken(rawToken: string, now = new Date()): Promise<void> {
    const [id, secret, extra] = rawToken.split('.');
    if (!id || !secret || extra) return;
    if (await this.entries.getById(id)) return;

    const token = await this.tokens.getById(id);
    if (!token || token.role !== 'guest' || token.revokedAt) return;
    const supplied = await digestSecret(secret, this.env.TOKEN_HMAC_KEY);
    if (!constantTimeEqual(supplied, token.secretDigest)) return;
    // An event that already has an entry under a different id keeps it; this
    // only ever fills an absence.
    if (await this.entries.getForEvent(token.eventId)) return;

    await this.adoptLegacyEntry(token.eventId, now);
  }

  /**
   * Whether this credential was ever issued in the path form.
   *
   * Only a code printed before 0008 may be redeemed as `/join/<token>`, and an
   * adopted credential carries its own proof: its id is the guest access token's
   * id, and revoking that token leaves the row behind. A credential minted after
   * 0008 has a fresh random id with no token behind it, so the leaky path form
   * stays closed for every event issued since.
   */
  async isPrintedPathCredential(rawToken: string): Promise<boolean> {
    const [id, secret, extra] = rawToken.split('.');
    if (!id || !secret || extra) return false;
    const token = await this.tokens.getById(id);
    return token?.role === 'guest';
  }

  /**
   * The gate every path that would reopen guest access has to pass through.
   *
   * Disabling is irreversible by design, so manager authority — link or account
   * — must not be able to route around it. An event with no entry row is
   * pre-0008 and adopts its printed credential here rather than staying locked.
   */
  async requireOpenEntry(eventId: string, now = new Date()): Promise<EventEntryRecord> {
    const entry = await this.entries.getForEvent(eventId)
      ?? await this.adoptLegacyEntry(eventId, now);
    if (!entry || entry.disabledAt) throw entryUnavailable();
    return entry;
  }

  async recover(eventId: string, now = new Date()): Promise<{ eventLink: string | null; disabledAt: string | null }> {
    const entry = await this.entries.getForEvent(eventId)
      ?? await this.adoptLegacyEntry(eventId, now);
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
      // A pre-0008 event has no entry row yet. Materialize its disabled
      // tombstone before revoking the source token so a delayed adopter can
      // neither recreate active entry nor erase the original stop time.
      this.entries.createDisabledLegacyStatement(event.id, timestamp),
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

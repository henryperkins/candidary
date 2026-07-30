import { serializeEventThemeConfig } from '../../shared/event-theme';
import type { EventThemeConfigV1 } from '../../shared/contracts';
import { EventEntriesRepository } from '../db/event-entries';
import { EventsRepository } from '../db/events';
import { NotificationOutboxRepository } from '../db/notification-outbox';
import { SessionsRepository } from '../db/sessions';
import { TokensRepository } from '../db/tokens';
import type { AppEnv } from '../env';
import {
  createSecretToken,
  digestSecret,
  encryptSecret,
} from '../security/crypto';
import { calculateLifecycle } from '../security/lifecycle';
import { eventSlug } from '../security/slugs';

export interface CreateEventInput {
  name: string;
  eventDate: string;
  welcomeMessage: string;
  theme: EventThemeConfigV1;
}

export class EventService {
  constructor(private readonly env: AppEnv) {}

  // `accountId` is the resolved host account when the creator was signed in, and
  // null otherwise. It is never taken from the request body: the caller resolves
  // the account cookie first, so an unusable credential simply creates a link-only
  // event instead of claiming a recovery the host does not have.
  async create(input: CreateEventInput, accountId: string | null = null, now = new Date()) {
    const events = new EventsRepository(this.env.DB);
    const entries = new EventEntriesRepository(this.env.DB);
    const tokens = new TokensRepository(this.env.DB);
    const sessions = new SessionsRepository(this.env.DB);
    const eventId = crypto.randomUUID();
    // Two guest-side credentials, doing two different jobs. `entryToken` is what
    // gets printed and must never change; `guestToken` is the internal grant
    // that upload authorization and `event_sessions.access_token_id` hang off,
    // and it stays rotatable.
    const entryToken = createSecretToken();
    const guestToken = createSecretToken();
    const managerToken = createSecretToken();
    const managementSession = createSecretToken();
    const csrfToken = createSecretToken().secret;
    const lifecycle = calculateLifecycle(input.eventDate, now);
    const createdAt = now.toISOString();
    const sessionExpiresAt = new Date(Math.min(
      Date.parse(lifecycle.managementAccessExpiresAt),
      now.getTime() + 12 * 60 * 60 * 1000,
    )).toISOString();

    const statements = [
      events.createStatement({
        id: eventId,
        slug: eventSlug(input.name, guestToken.id.slice(0, 6)),
        name: input.name,
        eventDate: input.eventDate,
        welcomeMessage: input.welcomeMessage,
        ...lifecycle,
        createdAt,
        themeConfig: serializeEventThemeConfig(input.theme),
      }),
      entries.createStatement({
        id: entryToken.id,
        eventId,
        secretDigest: await digestSecret(entryToken.secret, this.env.ENTRY_HMAC_KEY),
        secretCiphertext: await encryptSecret(entryToken.secret, this.env.ENTRY_ENCRYPTION_KEY),
        createdAt,
      }),
      tokens.createStatement({
        id: guestToken.id,
        eventId,
        role: 'guest',
        secretDigest: await digestSecret(guestToken.secret, this.env.TOKEN_HMAC_KEY),
        secretCiphertext: await encryptSecret(guestToken.secret, this.env.GUEST_TOKEN_ENCRYPTION_KEY),
        expiresAt: lifecycle.guestAccessExpiresAt,
        createdAt,
      }),
      tokens.createStatement({
        id: managerToken.id,
        eventId,
        role: 'manager',
        secretDigest: await digestSecret(managerToken.secret, this.env.TOKEN_HMAC_KEY),
        secretCiphertext: null,
        expiresAt: lifecycle.managementAccessExpiresAt,
        createdAt,
      }),
      sessions.createStatement({
        id: managementSession.id,
        secretDigest: await digestSecret(managementSession.secret, this.env.SESSION_HMAC_KEY),
        csrfDigest: await digestSecret(csrfToken, this.env.SESSION_HMAC_KEY),
        eventId,
        accessTokenId: managerToken.id,
        role: 'manager',
        canClaimOwner: true,
        expiresAt: sessionExpiresAt,
        createdAt,
      }),
    ];

    if (accountId) {
      // Selected through `host_accounts` rather than inserted blind, so a disabled
      // account cannot acquire ownership between resolving the cookie and committing.
      statements.push(this.env.DB.prepare(`
        INSERT INTO event_hosts (event_id, account_id, role, created_at)
        SELECT ?, id, 'owner', ? FROM host_accounts WHERE id = ? AND disabled_at IS NULL
      `).bind(eventId, createdAt, accountId));
      // Each insert selects through the membership committed just above, so mail
      // that implies ownership cannot outlive a refused claim.
      statements.push(...new NotificationOutboxRepository(this.env.DB).scheduleStatements({
        accountId,
        accountEmail: null,
        eventId,
        createdAt,
        ownerCreatedAt: createdAt,
      }));
    }

    await this.env.DB.batch(statements);

    const event = (await events.getById(eventId))!;
    // Reported from what actually committed, never from the request's intent.
    const savedToAccount = accountId
      ? Boolean(await this.env.DB.prepare(`
          SELECT 1 FROM event_hosts WHERE event_id = ? AND account_id = ? AND role = 'owner'
        `).bind(eventId, accountId).first())
      : false;

    const origin = this.env.APP_ORIGIN.replace(/\/$/u, '');
    return {
      event,
      // In the fragment, not the path: browsers never send a fragment in a
      // request line or a Referer header, so the printed secret stays out of
      // every access log between the guest's phone and this Worker.
      eventLink: `${origin}/join#${entryToken.token}`,
      managementLink: `${origin}/manage/${managerToken.token}`,
      managementSession,
      csrfToken,
      sessionExpiresAt,
      savedToAccount,
    };
  }
}

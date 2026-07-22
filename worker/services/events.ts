import { EventsRepository } from '../db/events';
import { SessionsRepository } from '../db/sessions';
import { TokensRepository } from '../db/tokens';
import type { AppEnv } from '../env';
import {
  createSecretToken,
  digestSecret,
  encryptGuestSecret,
} from '../security/crypto';
import { calculateLifecycle } from '../security/lifecycle';

function slugify(name: string, suffix: string): string {
  const stem = name.normalize('NFKD').toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48) || 'event';
  return `${stem}-${suffix.toLowerCase()}`;
}

export interface CreateEventInput {
  name: string;
  eventDate: string;
  welcomeMessage: string;
}

export class EventService {
  constructor(private readonly env: AppEnv) {}

  async create(input: CreateEventInput, now = new Date()) {
    const events = new EventsRepository(this.env.DB);
    const tokens = new TokensRepository(this.env.DB);
    const sessions = new SessionsRepository(this.env.DB);
    const eventId = crypto.randomUUID();
    const guestToken = createSecretToken();
    const managerToken = createSecretToken();
    const managementSession = createSecretToken();
    const csrfToken = createSecretToken().secret;
    const lifecycle = calculateLifecycle(input.eventDate, now);
    const event = await events.create({
      id: eventId,
      slug: slugify(input.name, guestToken.id.slice(0, 6)),
      name: input.name,
      eventDate: input.eventDate,
      welcomeMessage: input.welcomeMessage,
      ...lifecycle,
      createdAt: now.toISOString(),
    });
    await tokens.create({
      id: guestToken.id,
      eventId,
      role: 'guest',
      secretDigest: await digestSecret(guestToken.secret, this.env.TOKEN_HMAC_KEY),
      secretCiphertext: await encryptGuestSecret(guestToken.secret, this.env.GUEST_TOKEN_ENCRYPTION_KEY),
      expiresAt: lifecycle.guestAccessExpiresAt,
      createdAt: now.toISOString(),
    });
    await tokens.create({
      id: managerToken.id,
      eventId,
      role: 'manager',
      secretDigest: await digestSecret(managerToken.secret, this.env.TOKEN_HMAC_KEY),
      secretCiphertext: null,
      expiresAt: lifecycle.managementAccessExpiresAt,
      createdAt: now.toISOString(),
    });
    const sessionExpiresAt = new Date(Math.min(
      Date.parse(lifecycle.managementAccessExpiresAt),
      now.getTime() + 12 * 60 * 60 * 1000,
    )).toISOString();
    await sessions.create({
      id: managementSession.id,
      secretDigest: await digestSecret(managementSession.secret, this.env.SESSION_HMAC_KEY),
      csrfDigest: await digestSecret(csrfToken, this.env.SESSION_HMAC_KEY),
      eventId,
      accessTokenId: managerToken.id,
      role: 'manager',
      expiresAt: sessionExpiresAt,
      createdAt: now.toISOString(),
    });

    const origin = this.env.APP_ORIGIN.replace(/\/$/u, '');
    return {
      event,
      guestLink: `${origin}/join/${guestToken.token}`,
      managementLink: `${origin}/manage/${managerToken.token}`,
      managementSession,
      csrfToken,
      sessionExpiresAt,
    };
  }
}


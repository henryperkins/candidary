import type { Role } from '../../shared/contracts';
import { TokensRepository } from '../db/tokens';
import type { EventRecord } from '../db/types';
import type { AppEnv } from '../env';
import { createSecretToken, digestSecret, encryptGuestSecret } from '../security/crypto';

export class LinkService {
  constructor(private readonly env: AppEnv) {}

  async rotate(event: EventRecord, role: Role, now = new Date()) {
    const tokens = new TokensRepository(this.env.DB);
    await tokens.revokeRole(event.id, role, now.toISOString());
    const replacement = createSecretToken();
    await tokens.create({
      id: replacement.id,
      eventId: event.id,
      role,
      secretDigest: await digestSecret(replacement.secret, this.env.TOKEN_HMAC_KEY),
      secretCiphertext: role === 'guest'
        ? await encryptGuestSecret(replacement.secret, this.env.GUEST_TOKEN_ENCRYPTION_KEY)
        : null,
      expiresAt: role === 'guest'
        ? event.guestAccessExpiresAt
        : event.managementAccessExpiresAt,
      createdAt: now.toISOString(),
    });
    const origin = this.env.APP_ORIGIN.replace(/\/$/u, '');
    return role === 'guest'
      ? { guestLink: `${origin}/join/${replacement.token}` }
      : { managementLink: `${origin}/manage/${replacement.token}` };
  }
}


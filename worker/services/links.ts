import { TokensRepository } from '../db/tokens';
import type { EventRecord } from '../db/types';
import type { AppEnv } from '../env';
import { canonicalOrigin } from '../origins';
import { createSecretToken, digestSecret } from '../security/crypto';

/**
 * Rotation for the one credential that is still a link.
 *
 * Guest entry no longer works this way: it is reached through the permanent
 * printed credential, and rotating the grant behind it deliberately produces no
 * new URL. That lives in `EventEntryService.rotateInternalGuestGrant`.
 */
export class LinkService {
  // The origin the caller is being answered on, so a rotation performed on one
  // hostname hands back a link on that same hostname — the client navigates
  // straight to it, and a cross-origin jump would sign the host out of the page
  // they were working in.
  constructor(private readonly env: AppEnv, private readonly origin: string = canonicalOrigin(env)) {}

  async rotateManagementLink(event: EventRecord, now = new Date()) {
    const tokens = new TokensRepository(this.env.DB);
    await tokens.revokeRole(event.id, 'manager', now.toISOString());
    const replacement = createSecretToken();
    await tokens.create({
      id: replacement.id,
      eventId: event.id,
      role: 'manager',
      secretDigest: await digestSecret(replacement.secret, this.env.TOKEN_HMAC_KEY),
      // A management secret is never recoverable by design: losing it is what
      // host accounts exist to solve.
      secretCiphertext: null,
      expiresAt: event.managementAccessExpiresAt,
      createdAt: now.toISOString(),
    });
    return { managementLink: `${this.origin}/manage/${replacement.token}` };
  }
}

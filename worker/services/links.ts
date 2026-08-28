import { ApiError } from '../../shared/errors';
import { MediaRepository } from '../db/media';
import { SessionsRepository } from '../db/sessions';
import { TokensRepository } from '../db/tokens';
import type { EventRecord } from '../db/types';
import type { AppEnv } from '../env';
import { canonicalOrigin } from '../origins';
import { createSecretToken, digestSecret } from '../security/crypto';
import { deleteMediaObjectAliases } from '../storage/media';

function rotationConflict(): ApiError {
  return new ApiError(
    'REVISION_CONFLICT',
    'The management link changed since this page loaded. Reload and try again.',
    409,
  );
}

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

  async rotateManagementLink(
    event: EventRecord,
    expectedManagerLinkRevision: number,
    now = new Date(),
  ): Promise<{ managementLink: string; managerLinkRevision: number }> {
    if (!Number.isInteger(expectedManagerLinkRevision) || expectedManagerLinkRevision < 0) {
      throw rotationConflict();
    }
    const tokens = new TokensRepository(this.env.DB);
    const predecessor = await tokens.getActiveForRole(event.id, 'manager');
    if (!predecessor) throw rotationConflict();
    const replacement = createSecretToken();
    const rotatedAt = now.toISOString();
    const tokenStatements = tokens.managerLinkRotationStatements({
      id: replacement.id,
      eventId: event.id,
      role: 'manager',
      secretDigest: await digestSecret(replacement.secret, this.env.TOKEN_HMAC_KEY),
      // A management secret is never recoverable by design: losing it is what
      // host accounts exist to solve.
      secretCiphertext: null,
      expiresAt: event.managementAccessExpiresAt,
      createdAt: rotatedAt,
      expectedRevision: expectedManagerLinkRevision,
      predecessorId: predecessor.id,
      rotatedAt,
    });
    const sessionStatements = new SessionsRepository(this.env.DB)
      .managerLinkRotationStatements({
        eventId: event.id,
        predecessorId: predecessor.id,
        replacementId: replacement.id,
        rotatedAt,
      });
    const mediaRepository = new MediaRepository(this.env.DB);
    const mediaBatch = mediaRepository.managerLinkRotationStatements({
      eventId: event.id,
      predecessorId: predecessor.id,
      replacementId: replacement.id,
      rotatedAt,
      rotationMarker: `rotation:${rotatedAt}:${replacement.id}`,
    });
    let results: D1Result[];
    try {
      results = await this.env.DB.batch([
        ...tokenStatements,
        ...sessionStatements,
        ...mediaBatch.statements,
      ]);
    } catch (error) {
      // The fourth token statement deliberately makes a missing replacement a
      // transactional NOT NULL failure. Other constraint failures are real
      // integrity problems and must retain their original error.
      if (String(error).includes('events.manager_link_revision')) throw rotationConflict();
      throw error;
    }
    if ([0, 1, 2].some((index) => (results[index]?.meta.changes ?? 0) !== 1)) {
      throw rotationConflict();
    }

    const claimIndex = tokenStatements.length
      + sessionStatements.length
      + mediaBatch.deletionClaimResultOffset;
    const claims = mediaRepository.managerLinkRotationDeletionClaims(results[claimIndex]!);
    await Promise.all(claims.map((claim) => deleteMediaObjectAliases(
      this.env.MEDIA_BUCKET,
      this.env.CANONICAL_MEDIA_BUCKET,
      claim,
    ))).catch(() => undefined);

    return {
      managementLink: `${this.origin}/manage/${replacement.token}`,
      managerLinkRevision: expectedManagerLinkRevision + 1,
    };
  }
}

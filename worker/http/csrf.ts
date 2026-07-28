import type { Context } from 'hono';

import { ApiError } from '../../shared/errors';
import type { AppBindings } from '../env';
import { constantTimeEqual, digestSecret } from '../security/crypto';
import { getCsrfCookie, type CookieScope } from './cookies';

export function assertRequestOrigin(context: Context<AppBindings>): void {
  if (context.req.header('Origin') !== context.env.APP_ORIGIN) {
    throw new ApiError('ORIGIN_FORBIDDEN', 'This request came from an untrusted origin.', 403);
  }
}

// Scoped, because a browser can now hold two sessions at once and each carries its
// own token. Checking the wrong pair would either reject a legitimate write or,
// worse, accept one authorized by the other credential.
export async function assertCsrf(
  context: Context<AppBindings>,
  scope: CookieScope,
  expectedDigest: string,
): Promise<void> {
  assertRequestOrigin(context);
  const cookieToken = getCsrfCookie(context, scope);
  const headerToken = scope === 'host'
    ? context.req.header('X-Candidary-Host-CSRF')
    : context.req.header('X-Candidary-CSRF');
  if (!cookieToken || !headerToken || !constantTimeEqual(cookieToken, headerToken)) {
    throw new ApiError('CSRF_INVALID', 'Refresh the page and try again.', 403);
  }
  const digest = await digestSecret(headerToken, context.env.SESSION_HMAC_KEY);
  if (!constantTimeEqual(digest, expectedDigest)) {
    throw new ApiError('CSRF_INVALID', 'Refresh the page and try again.', 403);
  }
}

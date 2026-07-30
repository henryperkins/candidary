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

// Each scope has its own header, so a token minted for one authority can never
// authorize a write in another. The client offers all three on every non-GET
// request; the route decides which pair it will accept.
const CSRF_HEADERS = {
  event: 'X-Candidary-CSRF',
  host: 'X-Candidary-Host-CSRF',
  rsvp: 'X-Candidary-RSVP-CSRF',
} as const satisfies Record<CookieScope, string>;

// Scoped, because a browser can hold several sessions at once and each carries
// its own token. Checking the wrong pair would either reject a legitimate write
// or, worse, accept one authorized by a different credential.
export async function assertCsrf(
  context: Context<AppBindings>,
  scope: CookieScope,
  expectedDigest: string,
): Promise<void> {
  assertRequestOrigin(context);
  const cookieToken = getCsrfCookie(context, scope);
  const headerToken = context.req.header(CSRF_HEADERS[scope]);
  if (!cookieToken || !headerToken || !constantTimeEqual(cookieToken, headerToken)) {
    throw new ApiError('CSRF_INVALID', 'Refresh the page and try again.', 403);
  }
  const digest = await digestSecret(headerToken, context.env.SESSION_HMAC_KEY);
  if (!constantTimeEqual(digest, expectedDigest)) {
    throw new ApiError('CSRF_INVALID', 'Refresh the page and try again.', 403);
  }
}

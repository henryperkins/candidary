import type { Context } from 'hono';

import { ApiError } from '../../shared/errors';
import type { AppBindings, AuthenticatedSession } from '../env';
import { constantTimeEqual, digestSecret } from '../security/crypto';
import { getCsrfCookie } from './cookies';

export function assertRequestOrigin(context: Context<AppBindings>): void {
  if (context.req.header('Origin') !== context.env.APP_ORIGIN) {
    throw new ApiError('ORIGIN_FORBIDDEN', 'This request came from an untrusted origin.', 403);
  }
}

export async function assertCsrf(
  context: Context<AppBindings>,
  auth: AuthenticatedSession,
): Promise<void> {
  assertRequestOrigin(context);
  const cookieToken = getCsrfCookie(context);
  const headerToken = context.req.header('X-Candidary-CSRF');
  if (!cookieToken || !headerToken || !constantTimeEqual(cookieToken, headerToken)) {
    throw new ApiError('CSRF_INVALID', 'Refresh the page and try again.', 403);
  }
  const digest = await digestSecret(headerToken, context.env.SESSION_HMAC_KEY);
  if (!constantTimeEqual(digest, auth.session.csrfDigest)) {
    throw new ApiError('CSRF_INVALID', 'Refresh the page and try again.', 403);
  }
}


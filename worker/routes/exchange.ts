import { Hono, type Context } from 'hono';

import type { Role } from '../../shared/contracts';
import { failureDecisionForCode } from '../../shared/load-failure';
import { ApiError } from '../../shared/errors';
import type { AppBindings } from '../env';
import { setSessionCookies } from '../http/cookies';
import { AuthService } from '../auth/service';

export const exchangeRoutes = new Hono<AppBindings>();

export function isDocumentNavigation(request: Request): boolean {
  return request.headers.get('sec-fetch-mode') === 'navigate'
    || (request.headers.get('accept') ?? '').toLowerCase().includes('text/html');
}

export function classifyExchangeFailure(
  error: unknown,
): 'latest-link' | 'ended-event' | 'retry' {
  if (!(error instanceof ApiError)) return 'retry';
  const kind = failureDecisionForCode(error.code).kind;
  if (kind === 'latest-link' || kind === 'ended-event') return kind;
  return 'retry';
}

async function exchange(context: Context<AppBindings>, role: Role) {
  const exchanged = await new AuthService(context.env).exchange(context.req.param('token') ?? '', role);
  const maxAge = Math.max(1, Math.floor((Date.parse(exchanged.session.expiresAt) - Date.now()) / 1000));
  setSessionCookies(context, 'event', exchanged.sessionToken, exchanged.csrfToken, maxAge);
  const location = role === 'guest'
    ? `/event/${exchanged.event.slug}`
    : `/manage/event/${exchanged.event.id}`;
  return context.redirect(location, 302);
}

// Not a compatibility exchange. Guest entry moved to `/join#<credential>` and a
// POST body, and this path only ever carried a credential in the URL. It exists
// to get that credential out of the address bar and off the next Referer header,
// and it never accepts the token it is handed.
exchangeRoutes.get('/join/:token', (context) => context.redirect(
  '/recover/event-entry?kind=unavailable',
  302,
));
exchangeRoutes.get('/manage/:token', async (context) => {
  try {
    return await exchange(context, 'manager');
  } catch (error) {
    if (!isDocumentNavigation(context.req.raw)) throw error;
    if (!(error instanceof ApiError)) {
      // Preserve token-free document recovery without logging the bearer token or
      // an exception message that may contain request data.
      console.error(JSON.stringify({
        event: 'manager_exchange_failed',
        requestId: context.get('requestId'),
        errorName: error instanceof Error ? error.name : 'UnknownError',
      }));
    }
    return context.redirect(`/recover/manage?kind=${classifyExchangeFailure(error)}`, 302);
  }
});

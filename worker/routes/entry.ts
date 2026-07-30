import { Hono } from 'hono';
import { z } from 'zod';

import { ApiError } from '../../shared/errors';
import { AuthService } from '../auth/service';
import type { AppBindings } from '../env';
import { setSessionCookies } from '../http/cookies';
import { assertRequestOrigin } from '../http/csrf';

// Any string: shape is checked inside `exchangeEntry`, so a malformed guess and
// an unknown one produce the same answer rather than different status codes.
const entryExchangeSchema = z.object({ token: z.string().max(512) });

export const entryRoutes = new Hono<AppBindings>();

// Every answer on this path either carries a session cookie or says why a
// credential was refused. Neither belongs in an intermediary's cache. This runs
// after `next()` resolves, which it does for refusals too, because Hono turns a
// thrown ApiError into a response before unwinding the middleware chain.
entryRoutes.use('*', async (context, next) => {
  await next();
  if (!context.res.headers.get('cache-control')) context.header('Cache-Control', 'no-store');
});

/**
 * Trades the printed credential for a session cookie.
 *
 * A POST rather than a navigation, because the secret has to travel in a body.
 * The join shell reads it from `location.hash`, removes the fragment, and sends
 * it here — so the credential never appears in a request line, a Referer, or
 * any log between the guest's phone and this Worker.
 */
entryRoutes.post('/entry/exchange', async (context) => {
  assertRequestOrigin(context);
  const parsed = entryExchangeSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError(
      'EVENT_ENTRY_UNAVAILABLE',
      'This event entry is no longer available. Ask the host for the current invitation.',
      410,
    );
  }

  const exchanged = await new AuthService(context.env).exchangeEntry(parsed.data.token);
  const maxAge = Math.max(
    1,
    Math.floor((Date.parse(exchanged.session.expiresAt) - Date.now()) / 1000),
  );
  setSessionCookies(context, 'event', exchanged.sessionToken, exchanged.csrfToken, maxAge);

  // A location, not a redirect: the browser replaces its history entry so the
  // fragment-bearing URL cannot be reached with the back button.
  return context.json({
    data: { location: `/event/${exchanged.event.slug}` },
    requestId: context.get('requestId'),
  });
});

import { Hono } from 'hono';

import { ApiError } from '../../shared/errors';
import { requireManager } from '../auth/manager';
import { AuthService } from '../auth/service';
import type { AppBindings } from '../env';
import { getSessionCookie } from '../http/cookies';
import { selectGuestEventView, selectManagerEventView } from '../http/event-view';

export const eventRoutes = new Hono<AppBindings>();

eventRoutes.get('/event/:slug', async (context) => {
  const auth = await new AuthService(context.env).resolveEventSession(getSessionCookie(context));
  if (auth.event.slug !== context.req.param('slug')) {
    throw new ApiError('ROLE_FORBIDDEN', 'This session belongs to a different event.', 403);
  }
  return context.json({
    data: {
      event: await selectGuestEventView(context.env.DB, auth.event),
      role: auth.session.role,
    },
    requestId: context.get('requestId'),
  });
});

eventRoutes.get('/manage/events/:eventId', async (context) => {
  const auth = await requireManager(context);
  // The Manager event read is in a third route file no other cover task
  // touches, and it is exactly the read the whole recovery story depends on:
  // §8's "clearing session storage cannot cancel or hide accepted work" is only
  // true if this response carries the server-selected receipt. One `now` for
  // both, so the selection and the projection cannot disagree.
  const now = new Date();
  return context.json({
    data: { event: await selectManagerEventView(context.env, auth.event, now) },
    requestId: context.get('requestId'),
  });
});


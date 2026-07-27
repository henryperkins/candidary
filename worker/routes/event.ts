import { Hono } from 'hono';

import { ApiError } from '../../shared/errors';
import { requireManager } from '../auth/manager';
import { AuthService } from '../auth/service';
import type { AppBindings } from '../env';
import { getSessionCookie } from '../http/cookies';

export const eventRoutes = new Hono<AppBindings>();

eventRoutes.get('/event/:slug', async (context) => {
  const auth = await new AuthService(context.env).resolveEventSession(getSessionCookie(context));
  if (auth.event.slug !== context.req.param('slug')) {
    throw new ApiError('ROLE_FORBIDDEN', 'This session belongs to a different event.', 403);
  }
  return context.json({
    data: {
      event: {
        id: auth.event.id,
        slug: auth.event.slug,
        name: auth.event.name,
        eventDate: auth.event.eventDate,
        welcomeMessage: auth.event.welcomeMessage,
        coverObjectKey: auth.event.coverObjectKey,
        uploadsEnabled: auth.event.uploadsEnabled,
        galleryVisible: auth.event.galleryVisible,
        moderationRequired: auth.event.moderationRequired,
      },
      role: auth.session.role,
    },
    requestId: context.get('requestId'),
  });
});

eventRoutes.get('/manage/events/:eventId', async (context) => {
  const auth = await requireManager(context);
  return context.json({ data: { event: auth.event }, requestId: context.get('requestId') });
});


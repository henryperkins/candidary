import { Hono } from 'hono';

import { ApiError } from '../../shared/errors';
import { AuthService } from '../auth/service';
import { MediaRepository } from '../db/media';
import type { AppBindings } from '../env';
import { getSessionCookie } from '../http/cookies';

export const galleryRoutes = new Hono<AppBindings>();

galleryRoutes.get('/event/:slug/gallery', async (context) => {
  const auth = await new AuthService(context.env).resolve(getSessionCookie(context));
  if (auth.event.slug !== context.req.param('slug')) {
    throw new ApiError('ROLE_FORBIDDEN', 'This session belongs to a different event.', 403);
  }
  if (!auth.event.galleryVisible && auth.session.role !== 'manager') {
    throw new ApiError('GALLERY_HIDDEN', 'The shared gallery is not visible yet.', 403);
  }
  const media = await new MediaRepository(context.env.DB).listGallery(auth.event.id);
  return context.json({ data: { media }, requestId: context.get('requestId') });
});

galleryRoutes.get('/event/:slug/contributions', async (context) => {
  const auth = await new AuthService(context.env).resolve(getSessionCookie(context));
  if (auth.session.role !== 'guest' || auth.event.slug !== context.req.param('slug')) {
    throw new ApiError('ROLE_FORBIDDEN', 'This session belongs to a different event.', 403);
  }
  const media = await new MediaRepository(context.env.DB).listContributions(auth.event.id, auth.session.id);
  return context.json({ data: { media }, requestId: context.get('requestId') });
});


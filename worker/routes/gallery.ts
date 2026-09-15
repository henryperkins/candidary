import { Hono } from 'hono';

import { ApiError } from '../../shared/errors';
import { AuthService } from '../auth/service';
import {
  MediaRepository,
  guestContributionMediaView,
} from '../db/media';
import type { AppBindings } from '../env';
import { getSessionCookie } from '../http/cookies';
import { assertGuestReadSurfacesAvailable } from '../http/event-view';
import { privateJson } from '../http/private-json';
import { decodeGuestGalleryCursor, encodeGuestGalleryCursor } from '../http/guest-gallery-cursor';

export const galleryRoutes = new Hono<AppBindings>();

galleryRoutes.use('/event/:slug/gallery', privateJson);
galleryRoutes.use('/event/:slug/contributions', privateJson);

galleryRoutes.get('/event/:slug/gallery', async (context) => {
  const auth = await new AuthService(context.env).resolveEventSession(getSessionCookie(context));
  if (auth.event.slug !== context.req.param('slug')) {
    throw new ApiError('ROLE_FORBIDDEN', 'This session belongs to a different event.', 403);
  }
  if (auth.session.role === 'guest') assertGuestReadSurfacesAvailable(auth.event);
  if (!auth.event.galleryVisible && auth.session.role !== 'manager') {
    throw new ApiError('GALLERY_HIDDEN', 'The shared gallery is not visible yet.', 403);
  }
  const cursor = context.req.query('cursor');
  const page = await new MediaRepository(context.env.DB).listGallery(
    auth.event.id,
    cursor === undefined ? undefined : decodeGuestGalleryCursor(auth.event.id, cursor),
  );
  return context.json({
    data: {
      media: page.media,
      nextCursor: page.nextCursor ? encodeGuestGalleryCursor(auth.event.id, page.nextCursor) : null,
    },
    requestId: context.get('requestId'),
  });
});

galleryRoutes.get('/event/:slug/contributions', async (context) => {
  const auth = await new AuthService(context.env).resolveEventSession(getSessionCookie(context));
  if (auth.session.role !== 'guest' || auth.event.slug !== context.req.param('slug')) {
    throw new ApiError('ROLE_FORBIDDEN', 'This session belongs to a different event.', 403);
  }
  assertGuestReadSurfacesAvailable(auth.event);
  const media = await new MediaRepository(context.env.DB).listContributions(auth.event.id, auth.session.id);
  return context.json({
    data: { media: media.map(guestContributionMediaView) },
    requestId: context.get('requestId'),
  });
});

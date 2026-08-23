import { Hono, type MiddlewareHandler } from 'hono';

import { requireManager } from '../auth/manager';
import { MediaRepository } from '../db/media';
import type { AppBindings } from '../env';
import { getAlbumShareCookie, setAlbumShareCookie } from '../http/cookies';
import { assertRequestOrigin } from '../http/csrf';
import {
  AlbumShareService,
  AlbumShareSessionCapacityError,
  albumShareUnavailable,
} from '../services/album-share';
import { getOrCreatePreview } from '../storage/previews';

export const albumShareRoutes = new Hono<AppBindings>();

const privateNoStore: MiddlewareHandler<AppBindings> = async (context, next) => {
  await next();
  context.header('Cache-Control', 'private, no-store');
};

albumShareRoutes.use('/album-share', privateNoStore);
albumShareRoutes.use('/album-share/*', privateNoStore);
albumShareRoutes.use('/manage/events/:eventId/album/share', privateNoStore);

albumShareRoutes.get('/manage/events/:eventId/album/share', async (context) => {
  await requireManager(context);
  const share = await new AlbumShareService(context.env).status(context.req.param('eventId'));
  return context.json({ data: { share }, requestId: context.get('requestId') });
});

albumShareRoutes.post('/manage/events/:eventId/album/share', async (context) => {
  await requireManager(context, { write: true });
  const share = await new AlbumShareService(context.env).enable(context.req.param('eventId'));
  return context.json({ data: { share }, requestId: context.get('requestId') });
});

albumShareRoutes.delete('/manage/events/:eventId/album/share', async (context) => {
  await requireManager(context, { write: true });
  const share = await new AlbumShareService(context.env).stop(context.req.param('eventId'));
  return context.json({ data: { share }, requestId: context.get('requestId') });
});

albumShareRoutes.post('/album-share/exchange', async (context) => {
  assertRequestOrigin(context);
  const body = await context.req.json().catch(() => null) as { token?: unknown } | null;
  let exchanged;
  try {
    exchanged = await new AlbumShareService(context.env).exchange(
      typeof body?.token === 'string' ? body.token : '',
    );
  } catch (error) {
    if (error instanceof AlbumShareSessionCapacityError) {
      context.header('Retry-After', String(error.retryAfterSeconds));
    }
    throw error;
  }
  setAlbumShareCookie(context, exchanged.session, exchanged.maxAgeSeconds);
  return context.json({
    data: { album: exchanged.album },
    requestId: context.get('requestId'),
  });
});

albumShareRoutes.get('/album-share', async (context) => {
  const album = await new AlbumShareService(context.env).publicAlbum(
    getAlbumShareCookie(context) ?? '',
  );
  return context.json({ data: { album }, requestId: context.get('requestId') });
});

albumShareRoutes.get('/album-share/media/:mediaId/preview', async (context) => {
  const session = await new AlbumShareService(context.env).authorizeSession(
    getAlbumShareCookie(context) ?? '',
  );
  const media = await new MediaRepository(context.env.DB).getById(context.req.param('mediaId'));
  if (!media
    || media.eventId !== session.eventId
    || media.uploadState !== 'stored'
    || media.deletedAt
    || !media.favoritedAt) {
    throw albumShareUnavailable();
  }

  const object = await getOrCreatePreview(context.env, media)
    .catch(() => { throw albumShareUnavailable(); });
  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType ?? 'image/webp',
      'Content-Length': String(object.size),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
  });
});

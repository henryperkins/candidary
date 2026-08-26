import { Hono } from 'hono';

import { ApiError } from '../../shared/errors';
import { requireManager } from '../auth/manager';
import { MediaRepository } from '../db/media';
import type { AppBindings } from '../env';
import { privateJson } from '../http/private-json';
import { PublicAlbumService } from '../services/public-album';
import { getOrCreatePreview } from '../storage/previews';

/**
 * What the Album link shows, read with the host's own credential.
 *
 * Deliberately separate from `routes/album-share.ts`. Preview answers "what will
 * they see", and answering it must never require, mint, expose, or even consult
 * a share credential — a host checking their album before sending it should not
 * be creating a link, and a host who already revoked one should still be able to
 * look. Nothing here reads or writes the album-share cookie, and no response
 * from this file carries `Set-Cookie`.
 */
export const albumPreviewRoutes = new Hono<AppBindings>();

albumPreviewRoutes.use('/manage/events/:eventId/album/preview', privateJson);
albumPreviewRoutes.use('/manage/events/:eventId/album/media/:mediaId/preview', privateJson);

albumPreviewRoutes.get('/manage/events/:eventId/album/preview', async (context) => {
  const auth = await requireManager(context);
  const album = await new PublicAlbumService(context.env.DB).project(auth.event.id);
  return context.json({ data: { album }, requestId: context.get('requestId') });
});

albumPreviewRoutes.get('/manage/events/:eventId/album/media/:mediaId/preview', async (context) => {
  const auth = await requireManager(context);
  const mediaId = context.req.param('mediaId');
  const media = await new MediaRepository(context.env.DB).getById(mediaId);
  // One body for every reason a photo is not previewable here — wrong event,
  // never existed, unpicked, trashed — so this route cannot be walked to
  // enumerate which media ids are real.
  if (!media
    || media.eventId !== auth.event.id
    || media.uploadState !== 'stored'
    || media.deletedAt !== null
    || media.trashedAt !== null
    || !await new PublicAlbumService(context.env.DB).includesPhoto(auth.event.id, mediaId)) {
    throw new ApiError('RESOURCE_FORBIDDEN', 'This photo is not available.', 403);
  }

  const object = await getOrCreatePreview(context.env, media);
  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType ?? 'image/webp',
      'Content-Length': String(object.size),
      'Cache-Control': 'private, no-store',
      Vary: 'Cookie',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
  });
});

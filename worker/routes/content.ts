import { Hono, type Context } from 'hono';

import { ApiError } from '../../shared/errors';
import { requireManager, resolveManager } from '../auth/manager';
import { AuthService } from '../auth/service';
import { MediaRepository } from '../db/media';
import type { AppBindings } from '../env';
import { getSessionCookie } from '../http/cookies';
import { getOrCreatePreview } from '../storage/previews';

export const contentRoutes = new Hono<AppBindings>();

async function coverResponse(context: Context<AppBindings>, objectKey: string | null) {
  if (!objectKey) {
    throw new ApiError('EVENT_NOT_FOUND', 'This event does not have a cover image.', 404);
  }
  const object = await context.env.MEDIA_BUCKET.get(objectKey);
  if (!object?.body) throw new ApiError('UPLOAD_OBJECT_MISSING', 'The cover is temporarily unavailable.', 404);
  return new Response(object.body, { headers: {
    'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
    'Content-Length': String(object.size), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
  } });
}

contentRoutes.get('/event/:slug/cover', async (context) => {
  const auth = await new AuthService(context.env).resolveEventSession(getSessionCookie(context));
  if (auth.event.slug !== context.req.param('slug')) {
    throw new ApiError('EVENT_NOT_FOUND', 'This event does not have a cover image.', 404);
  }
  return coverResponse(context, auth.event.coverObjectKey);
});

contentRoutes.get('/manage/events/:eventId/cover', async (context) => {
  const auth = await requireManager(context);
  return coverResponse(context, auth.event.coverObjectKey);
});

async function previewResponse(context: Context<AppBindings>) {
  const repository = new MediaRepository(context.env.DB);
  const media = await repository.getById(context.req.param('mediaId')!);
  if (!media || media.uploadState !== 'stored' || media.deletedAt) {
    throw new ApiError('ROLE_FORBIDDEN', 'This photo is not available.', 403);
  }
  // The event comes from the row here, not the path, so authorization is asked per
  // photo: hosting the event by either credential is enough, and anyone else falls
  // back to the guest rules for their own upload or a published one.
  if (!await resolveManager(context, media.eventId)) {
    const auth = await new AuthService(context.env).resolveEventSession(getSessionCookie(context));
    const guestCanRead = auth.event.id === media.eventId
      && (media.uploaderSessionId === auth.session.id
        || (media.publicationStatus === 'published' && auth.event.galleryVisible));
    if (!guestCanRead) throw new ApiError('ROLE_FORBIDDEN', 'This photo is not available.', 403);
  }

  const object = await getOrCreatePreview(context.env, media, repository);
  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType ?? 'image/webp',
      'Content-Length': String(object.size),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

contentRoutes.get('/media/:mediaId/preview', previewResponse);
contentRoutes.get('/media/:mediaId/content', previewResponse);

contentRoutes.get('/media/:mediaId/original', async (context) => {
  const media = await new MediaRepository(context.env.DB).getById(context.req.param('mediaId'));
  if (!media || media.uploadState !== 'stored' || media.deletedAt) {
    throw new ApiError('ROLE_FORBIDDEN', 'This photo is not available.', 403);
  }
  await requireManager(context, {
    eventId: media.eventId,
    deniedMessage: 'Only the event host can download original photos.',
  });
  const object = await context.env.MEDIA_BUCKET.get(media.objectKey);
  if (!object?.body) throw new ApiError('UPLOAD_OBJECT_MISSING', 'This original photo is temporarily unavailable.', 404);
  const filename = encodeURIComponent(media.originalFilename);
  return new Response(object.body, {
    headers: {
      'Content-Type': media.mimeType,
      'Content-Length': String(object.size),
      'Content-Disposition': `attachment; filename*=UTF-8''${filename}`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

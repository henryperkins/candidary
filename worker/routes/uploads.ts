import { Hono } from 'hono';
import { z } from 'zod';

import { ApiError } from '../../shared/errors';
import { AuthService } from '../auth/service';
import { MediaRepository } from '../db/media';
import type { AppBindings } from '../env';
import { getSessionCookie } from '../http/cookies';
import { assertCsrf } from '../http/csrf';
import { UploadService } from '../services/uploads';
import { finalizeStoredMedia } from '../storage/media';

const initiateSchema = z.object({
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1),
  byteSize: z.number(),
  idempotencyKey: z.string().min(1).max(128),
  guestName: z.string().max(80).nullish(),
  caption: z.string().max(300).nullish(),
});

async function guestForSlug(context: Parameters<typeof assertCsrf>[0]) {
  const auth = await new AuthService(context.env).resolve(getSessionCookie(context));
  if (auth.session.role !== 'guest' || auth.event.slug !== context.req.param('slug')) {
    throw new ApiError('ROLE_FORBIDDEN', 'This session belongs to a different event.', 403);
  }
  await assertCsrf(context, auth);
  return auth;
}

export const uploadRoutes = new Hono<AppBindings>();

uploadRoutes.post('/event/:slug/uploads', async (context) => {
  const auth = await guestForSlug(context);
  const parsed = initiateSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) throw new ApiError('VALIDATION_FAILED', 'Check this file and try again.', 422);
  const result = await new UploadService(context.env).initiate(auth, parsed.data);
  return context.json({ data: result, requestId: context.get('requestId') }, 201);
});

uploadRoutes.post('/event/:slug/uploads/:mediaId/finalize', async (context) => {
  const auth = await guestForSlug(context);
  const repository = new MediaRepository(context.env.DB);
  const media = await repository.getById(context.req.param('mediaId'));
  if (!media || media.eventId !== auth.event.id || media.uploaderSessionId !== auth.session.id) {
    throw new ApiError('ROLE_FORBIDDEN', 'This upload belongs to a different guest or event.', 403);
  }
  const finalized = await finalizeStoredMedia(
    context.env.MEDIA_BUCKET,
    repository,
    media,
    auth.event.moderationRequired,
  );
  return context.json({ data: { media: finalized }, requestId: context.get('requestId') });
});

uploadRoutes.delete('/event/:slug/uploads/:mediaId', async (context) => {
  const auth = await guestForSlug(context);
  const repository = new MediaRepository(context.env.DB);
  const media = await repository.getById(context.req.param('mediaId'));
  if (!media || media.eventId !== auth.event.id || media.uploaderSessionId !== auth.session.id) {
    throw new ApiError('ROLE_FORBIDDEN', 'This upload belongs to a different guest or event.', 403);
  }
  await context.env.MEDIA_BUCKET.delete(media.objectKey);
  const deleted = await repository.delete(media.id, new Date().toISOString());
  return context.json({ data: { media: deleted }, requestId: context.get('requestId') });
});


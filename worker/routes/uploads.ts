import { Hono } from 'hono';
import { z } from 'zod';

import { MAX_IMAGE_BYTES, UPLOAD_BATCH_SIZE } from '../../shared/constants';
import { ApiError } from '../../shared/errors';
import { AuthService } from '../auth/service';
import { MediaRepository } from '../db/media';
import type { AppBindings } from '../env';
import { getSessionCookie } from '../http/cookies';
import { assertCsrf } from '../http/csrf';
import { UploadService } from '../services/uploads';
import { deleteMediaObjectAliases, receiveMediaUpload } from '../storage/media';

const fileSchema = z.object({
  filename: z.string().min(1).max(255),
  mimeType: z.string().max(100),
  byteSize: z.number(),
  idempotencyKey: z.string().min(1).max(128),
  caption: z.string().max(300).nullish(),
});

const initiateSchema = fileSchema.extend({
  guestName: z.string().trim().min(1).max(80),
});

const batchSchema = z.object({
  guestName: z.string().trim().min(1).max(80),
  files: z.array(fileSchema).min(1).max(UPLOAD_BATCH_SIZE),
});

function validationError(parsed: { error: z.ZodError }) {
  const guestNameIssue = parsed.error.issues.some((issue) => issue.path[0] === 'guestName');
  return new ApiError(
    'VALIDATION_FAILED',
    guestNameIssue ? 'Enter your name before adding photos.' : 'Check these photos and try again.',
    422,
    guestNameIssue ? { guestName: 'Your name is required.' } : undefined,
  );
}

async function guestForSlug(context: Parameters<typeof assertCsrf>[0]) {
  const auth = await new AuthService(context.env).resolveEventSession(getSessionCookie(context));
  if (auth.session.role !== 'guest' || auth.event.slug !== context.req.param('slug')) {
    throw new ApiError('ROLE_FORBIDDEN', 'This session belongs to a different event.', 403);
  }
  await assertCsrf(context, 'event', auth.session.csrfDigest);
  return auth;
}

export const uploadRoutes = new Hono<AppBindings>();

uploadRoutes.post('/event/:slug/uploads', async (context) => {
  const auth = await guestForSlug(context);
  const parsed = initiateSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) throw validationError(parsed);
  const result = await new UploadService(context.env).initiate(auth, parsed.data);
  return context.json({ data: result, requestId: context.get('requestId') }, 201);
});

uploadRoutes.post('/event/:slug/uploads/batch', async (context) => {
  const auth = await guestForSlug(context);
  const parsed = batchSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) throw validationError(parsed);
  const result = await new UploadService(context.env).initiateBatch(auth, parsed.data);
  return context.json({ data: result, requestId: context.get('requestId') }, 201);
});

uploadRoutes.post('/event/:slug/uploads/:mediaId/finalize', async (context) => {
  const auth = await guestForSlug(context);
  const repository = new MediaRepository(context.env.DB);
  const media = await repository.getById(context.req.param('mediaId'));
  if (!media || media.eventId !== auth.event.id || media.uploaderSessionId !== auth.session.id) {
    throw new ApiError('ROLE_FORBIDDEN', 'This upload belongs to a different guest or event.', 403);
  }
  if (media.uploadState === 'stored') {
    return context.json({ data: { media }, requestId: context.get('requestId') });
  }
  // New Workers never start an unbounded R2 write from this legacy handshake.
  // The browser queue interprets this domain conflict by replaying bytes through
  // the authenticated, buffer-before-claim PUT ingress above.
  throw new ApiError(
    'UPLOAD_FINALIZE_CONFLICT',
    'This upload needs its photo bytes again before it can be secured.',
    409,
  );
});

uploadRoutes.delete('/event/:slug/uploads/:mediaId', async (context) => {
  const auth = await guestForSlug(context);
  const repository = new MediaRepository(context.env.DB);
  const media = await repository.getById(context.req.param('mediaId'));
  if (!media || media.eventId !== auth.event.id || media.uploaderSessionId !== auth.session.id) {
    throw new ApiError('ROLE_FORBIDDEN', 'This upload belongs to a different guest or event.', 403);
  }
  const deleted = await repository.delete(media.id, new Date().toISOString());
  await deleteMediaObjectAliases(
    context.env.MEDIA_BUCKET,
    context.env.CANONICAL_MEDIA_BUCKET,
    repository,
    media,
  ).catch(() => undefined);
  return context.json({ data: { media: deleted }, requestId: context.get('requestId') });
});

uploadRoutes.put('/event/:slug/uploads/:mediaId/content', async (context) => {
  // Authentication, origin, and CSRF all complete before the body is read.
  const auth = await guestForSlug(context);
  const repository = new MediaRepository(context.env.DB);
  const media = await repository.getById(context.req.param('mediaId'));
  if (!media || media.eventId !== auth.event.id || media.uploaderSessionId !== auth.session.id) {
    throw new ApiError('ROLE_FORBIDDEN', 'This upload belongs to a different guest or event.', 403);
  }
  if (media.uploadState === 'stored') {
    return context.json({ data: { media }, requestId: context.get('requestId') });
  }
  if (media.uploadState !== 'reserved' || media.deletedAt !== null) {
    throw new ApiError('UPLOAD_FINALIZE_CONFLICT', 'This upload can no longer receive bytes.', 409);
  }
  const promotion = await repository.getPromotion(media.id);
  const canBufferExactRetry = promotion?.state === 'copying'
    && promotion.sourceEtag?.startsWith('buffer:') === true;
  if (!promotion || (promotion.state !== 'pending' && !canBufferExactRetry)) {
    throw new ApiError(
      'UPLOAD_FINALIZE_CONFLICT',
      'This upload is already being secured. Wait a moment and try again.',
      409,
    );
  }
  if (Date.parse(media.reservationExpiresAt) <= Date.now()) {
    throw new ApiError('UPLOAD_RESERVATION_EXPIRED', 'This upload reservation expired. Choose the file again.', 409);
  }

  const lengthHeader = context.req.header('content-length');
  if (!lengthHeader) {
    throw new ApiError('VALIDATION_FAILED', 'This upload needs to say how large the photo is.', 411);
  }
  const contentLength = Number(lengthHeader);
  if (!Number.isSafeInteger(contentLength) || contentLength < 1) {
    throw new ApiError('VALIDATION_FAILED', 'That upload could not be read. Try again.', 422);
  }
  if (contentLength > MAX_IMAGE_BYTES || contentLength !== media.declaredByteSize) {
    throw new ApiError('VALIDATION_FAILED', 'That photo is a different size than the one reserved.', 422);
  }
  if ((context.req.header('content-type') ?? '') !== media.mimeType) {
    throw new ApiError('FILE_TYPE_UNSUPPORTED', 'The uploaded image type does not match its reservation.', 415);
  }

  // The whole bounded request is received before D1 grants an R2 writer. A
  // client-paused HTTP body therefore cannot outlive a cleanup lease or land an
  // object after purge. The post-buffer CAS inside receiveMediaUpload rechecks
  // every mutable reservation/event/fence predicate.
  const bytes = await context.req.raw.arrayBuffer();
  if (bytes.byteLength !== contentLength) {
    throw new ApiError('VALIDATION_FAILED', 'That upload did not finish. Choose the photo again.', 422);
  }
  const stored = await receiveMediaUpload(
    context.env.CANONICAL_MEDIA_BUCKET,
    repository,
    media,
    auth.session.id,
    bytes,
    context.req.header('content-type') ?? '',
  );
  return context.json({ data: { media: stored }, requestId: context.get('requestId') });
});

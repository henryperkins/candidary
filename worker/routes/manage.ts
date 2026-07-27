import { Hono, type Context } from 'hono';
import { z } from 'zod';

import type { PublicationStatus } from '../../shared/contracts';
import { ApiError } from '../../shared/errors';
import { AuthService } from '../auth/service';
import { EventsRepository } from '../db/events';
import { MediaRepository } from '../db/media';
import type { AppBindings } from '../env';
import { getSessionCookie } from '../http/cookies';
import { assertCsrf } from '../http/csrf';
import { LinkService } from '../services/links';
import { TokensRepository } from '../db/tokens';
import { decryptGuestSecret } from '../security/crypto';
import {
  MANAGER_MEDIA_MAX_PAGE_SIZE,
  MANAGER_MEDIA_PAGE_SIZE,
  MAX_IMAGE_BYTES,
  SUPPORTED_IMAGE_TYPES,
} from '../../shared/constants';
import { decodeMediaCursor, encodeMediaCursor } from '../http/media-cursor';
import { sanitizeFilename } from '../security/filenames';
import { inspectImageHeader } from '../security/image-metadata';
import { presignUpload } from '../storage/presign';
import { deleteEventData } from '../workflows/cleanup';

const settingsSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  welcomeMessage: z.string().trim().min(1).max(500).optional(),
  uploadsEnabled: z.boolean(),
  galleryVisible: z.boolean(),
  moderationRequired: z.boolean(),
});
const actionSchema = z.object({
  action: z.enum(['publish', 'hide', 'delete']),
  expectedStatus: z.enum(['unpublished', 'published', 'hidden']).default('unpublished'),
});
const deleteSchema = z.object({ confirmation: z.string() });
const mediaLimitSchema = z.coerce.number().int().min(1).max(MANAGER_MEDIA_MAX_PAGE_SIZE)
  .default(MANAGER_MEDIA_PAGE_SIZE);
const coverSchema = z.object({
  filename: z.string().min(1).max(255), mimeType: z.enum(SUPPORTED_IMAGE_TYPES),
  byteSize: z.number().int().positive().max(MAX_IMAGE_BYTES),
});

async function managerForEvent(context: Context<AppBindings>, write = false) {
  const auth = await new AuthService(context.env).resolve(getSessionCookie(context));
  if (auth.session.role !== 'manager' || auth.event.id !== context.req.param('eventId')) {
    throw new ApiError('ROLE_FORBIDDEN', 'This management session belongs to a different event.', 403);
  }
  if (write) await assertCsrf(context, auth);
  return auth;
}

function publicationTarget(action: 'publish' | 'hide'): PublicationStatus {
  return action === 'publish' ? 'published' : 'hidden';
}

export const manageRoutes = new Hono<AppBindings>();

manageRoutes.get('/manage/events/:eventId/links', async (context) => {
  const auth = await managerForEvent(context);
  const token = await new TokensRepository(context.env.DB).getActiveForRole(auth.event.id, 'guest');
  if (!token?.secretCiphertext) throw new ApiError('TOKEN_REVOKED', 'The guest link is unavailable. Rotate it to create a replacement.', 410);
  const secret = await decryptGuestSecret(token.secretCiphertext, context.env.GUEST_TOKEN_ENCRYPTION_KEY);
  const origin = context.env.APP_ORIGIN.replace(/\/$/u, '');
  return context.json({ data: { guestLink: `${origin}/join/${token.id}.${secret}` }, requestId: context.get('requestId') });
});

manageRoutes.post('/manage/events/:eventId/cover', async (context) => {
  const auth = await managerForEvent(context, true);
  const parsed = coverSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) throw new ApiError('VALIDATION_FAILED', 'Choose a JPG, PNG, WebP, HEIC, or HEIF image up to 20 MB.', 422);
  const objectKey = `events/${auth.event.id}/cover/${crypto.randomUUID()}-${sanitizeFilename(parsed.data.filename)}`;
  const signed = await presignUpload(context.env, objectKey, parsed.data.mimeType);
  return context.json({ data: { objectKey, ...signed }, requestId: context.get('requestId') }, 201);
});

manageRoutes.post('/manage/events/:eventId/cover/finalize', async (context) => {
  const auth = await managerForEvent(context, true);
  const parsed = z.object({ objectKey: z.string(), mimeType: z.enum(SUPPORTED_IMAGE_TYPES) }).safeParse(await context.req.json().catch(() => null));
  if (!parsed.success || !parsed.data.objectKey.startsWith(`events/${auth.event.id}/cover/`)) {
    throw new ApiError('ROLE_FORBIDDEN', 'This cover belongs to a different event.', 403);
  }
  const object = await context.env.MEDIA_BUCKET.get(parsed.data.objectKey);
  if (!object || object.size > MAX_IMAGE_BYTES || object.httpMetadata?.contentType !== parsed.data.mimeType) {
    await context.env.MEDIA_BUCKET.delete(parsed.data.objectKey);
    throw new ApiError('UPLOAD_OBJECT_MISSING', 'The cover upload could not be verified.', 409);
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  let metadata;
  try { metadata = inspectImageHeader(bytes); } catch {
    await context.env.MEDIA_BUCKET.delete(parsed.data.objectKey);
    throw new ApiError('FILE_TYPE_UNSUPPORTED', 'The cover is not a supported image.', 415);
  }
  if (metadata.mimeType !== parsed.data.mimeType) {
    await context.env.MEDIA_BUCKET.delete(parsed.data.objectKey);
    throw new ApiError('FILE_TYPE_UNSUPPORTED', 'The cover type does not match its content.', 415);
  }
  const previousKey = auth.event.coverObjectKey;
  const event = await new EventsRepository(context.env.DB).setCover(auth.event.id, parsed.data.objectKey);
  if (previousKey && previousKey !== parsed.data.objectKey) await context.env.MEDIA_BUCKET.delete(previousKey);
  return context.json({ data: { event }, requestId: context.get('requestId') });
});

manageRoutes.delete('/manage/events/:eventId', async (context) => {
  const auth = await managerForEvent(context, true);
  const parsed = deleteSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success || parsed.data.confirmation !== auth.event.name) {
    throw new ApiError('VALIDATION_FAILED', 'Type the event name exactly to delete it.', 422, { confirmation: 'Event name does not match.' });
  }
  await deleteEventData(context.env, auth.event.id);
  return context.json({ data: { deleted: true }, requestId: context.get('requestId') });
});

manageRoutes.patch('/manage/events/:eventId/settings', async (context) => {
  await managerForEvent(context, true);
  const parsed = settingsSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) throw new ApiError('VALIDATION_FAILED', 'Check the event settings.', 422);
  const event = await new EventsRepository(context.env.DB).updateSettings(context.req.param('eventId'), parsed.data);
  return context.json({ data: { event }, requestId: context.get('requestId') });
});

manageRoutes.get('/manage/events/:eventId/media', async (context) => {
  await managerForEvent(context);
  const rawStatus = context.req.query('status');
  const status = rawStatus && ['unpublished', 'published', 'hidden'].includes(rawStatus)
    ? rawStatus as PublicationStatus
    : undefined;
  const guestName = context.req.query('guestName');
  const limit = mediaLimitSchema.safeParse(context.req.query('limit'));
  if (!limit.success) {
    throw new ApiError('VALIDATION_FAILED', `Ask for between 1 and ${MANAGER_MEDIA_MAX_PAGE_SIZE} photos per page.`, 422);
  }
  const rawCursor = context.req.query('cursor');
  const cursor = rawCursor === undefined ? undefined : decodeMediaCursor(rawCursor);
  const page = await new MediaRepository(context.env.DB).listForManager(context.req.param('eventId'), {
    status, guestName, cursor, limit: limit.data,
  });
  return context.json({
    data: {
      media: page.media,
      nextCursor: page.nextCursor ? encodeMediaCursor(page.nextCursor) : null,
    },
    requestId: context.get('requestId'),
  });
});

manageRoutes.patch('/manage/events/:eventId/media/:mediaId', async (context) => {
  await managerForEvent(context, true);
  const parsed = actionSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) throw new ApiError('VALIDATION_FAILED', 'Choose a valid moderation action.', 422);
  const repository = new MediaRepository(context.env.DB);
  const media = await repository.getById(context.req.param('mediaId'));
  if (!media || media.eventId !== context.req.param('eventId')) {
    throw new ApiError('ROLE_FORBIDDEN', 'This photo belongs to a different event.', 403);
  }
  const changedAt = new Date().toISOString();
  const result = parsed.data.action === 'delete'
    ? await repository.delete(media.id, changedAt)
    : await repository.setPublication(media.id, parsed.data.expectedStatus, publicationTarget(parsed.data.action), changedAt);
  if (parsed.data.action === 'delete') {
    await context.env.MEDIA_BUCKET.delete([
      media.objectKey,
      ...(media.previewObjectKey ? [media.previewObjectKey] : []),
    ]);
  }
  return context.json({ data: { media: result }, requestId: context.get('requestId') });
});

manageRoutes.post('/manage/events/:eventId/media/bulk', async (context) => {
  await managerForEvent(context, true);
  const parsed = z.object({
    ids: z.array(z.string().uuid()).min(1).max(50),
    action: z.enum(['publish', 'hide']),
    expectedStatus: z.enum(['unpublished', 'published', 'hidden']).default('unpublished'),
  }).safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) throw new ApiError('VALIDATION_FAILED', 'Select valid photos to moderate.', 422);
  const repository = new MediaRepository(context.env.DB);
  const changed: string[] = [];
  for (const id of parsed.data.ids) {
    const media = await repository.getById(id);
    if (!media || media.eventId !== context.req.param('eventId')) {
      throw new ApiError('ROLE_FORBIDDEN', 'One selected photo belongs to a different event.', 403);
    }
    await repository.setPublication(id, parsed.data.expectedStatus, publicationTarget(parsed.data.action), new Date().toISOString());
    changed.push(id);
  }
  return context.json({ data: { changed }, requestId: context.get('requestId') });
});

for (const role of ['guest', 'manager'] as const) {
  manageRoutes.post(`/manage/events/:eventId/links/${role}/rotate`, async (context) => {
    const auth = await managerForEvent(context, true);
    const result = await new LinkService(context.env).rotate(auth, role);
    return context.json({ data: result, requestId: context.get('requestId') });
  });
}

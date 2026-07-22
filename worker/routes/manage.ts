import { Hono, type Context } from 'hono';
import { z } from 'zod';

import type { ModerationStatus } from '../../shared/contracts';
import { ApiError } from '../../shared/errors';
import { AuthService } from '../auth/service';
import { EventsRepository } from '../db/events';
import { MediaRepository } from '../db/media';
import type { AppBindings } from '../env';
import { getSessionCookie } from '../http/cookies';
import { assertCsrf } from '../http/csrf';
import { LinkService } from '../services/links';

const settingsSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  welcomeMessage: z.string().trim().min(1).max(500).optional(),
  uploadsEnabled: z.boolean(),
  galleryVisible: z.boolean(),
  moderationRequired: z.boolean(),
});
const actionSchema = z.object({
  action: z.enum(['approve', 'reject', 'delete']),
  expectedStatus: z.enum(['pending', 'approved', 'rejected']).default('pending'),
});
const deleteSchema = z.object({ confirmation: z.string() });

async function managerForEvent(context: Context<AppBindings>, write = false) {
  const auth = await new AuthService(context.env).resolve(getSessionCookie(context));
  if (auth.session.role !== 'manager' || auth.event.id !== context.req.param('eventId')) {
    throw new ApiError('ROLE_FORBIDDEN', 'This management session belongs to a different event.', 403);
  }
  if (write) await assertCsrf(context, auth);
  return auth;
}

function moderationTarget(action: 'approve' | 'reject'): ModerationStatus {
  return action === 'approve' ? 'approved' : 'rejected';
}

export const manageRoutes = new Hono<AppBindings>();

manageRoutes.delete('/manage/events/:eventId', async (context) => {
  const auth = await managerForEvent(context, true);
  const parsed = deleteSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success || parsed.data.confirmation !== auth.event.name) {
    throw new ApiError('VALIDATION_FAILED', 'Type the event name exactly to delete it.', 422, { confirmation: 'Event name does not match.' });
  }
  const { deleteEventData } = await import('../workflows/cleanup');
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
  const status = rawStatus && ['pending', 'approved', 'rejected'].includes(rawStatus)
    ? rawStatus as ModerationStatus
    : undefined;
  const media = await new MediaRepository(context.env.DB).listForManager(context.req.param('eventId'), status);
  return context.json({ data: { media }, requestId: context.get('requestId') });
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
    : await repository.moderate(media.id, parsed.data.expectedStatus, moderationTarget(parsed.data.action), changedAt);
  if (parsed.data.action === 'delete') await context.env.MEDIA_BUCKET.delete(media.objectKey);
  return context.json({ data: { media: result }, requestId: context.get('requestId') });
});

manageRoutes.post('/manage/events/:eventId/media/bulk', async (context) => {
  await managerForEvent(context, true);
  const parsed = z.object({
    ids: z.array(z.string().uuid()).min(1).max(50),
    action: z.enum(['approve', 'reject']),
    expectedStatus: z.enum(['pending', 'approved', 'rejected']).default('pending'),
  }).safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) throw new ApiError('VALIDATION_FAILED', 'Select valid photos to moderate.', 422);
  const repository = new MediaRepository(context.env.DB);
  const changed: string[] = [];
  for (const id of parsed.data.ids) {
    const media = await repository.getById(id);
    if (!media || media.eventId !== context.req.param('eventId')) {
      throw new ApiError('ROLE_FORBIDDEN', 'One selected photo belongs to a different event.', 403);
    }
    await repository.moderate(id, parsed.data.expectedStatus, moderationTarget(parsed.data.action), new Date().toISOString());
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

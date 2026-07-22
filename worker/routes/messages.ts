import { Hono, type Context } from 'hono';
import { z } from 'zod';

import type { ModerationStatus } from '../../shared/contracts';
import { ApiError } from '../../shared/errors';
import { AuthService } from '../auth/service';
import { MessagesRepository } from '../db/messages';
import type { AppBindings } from '../env';
import { getSessionCookie } from '../http/cookies';
import { assertCsrf } from '../http/csrf';

async function eventAuth(context: Context<AppBindings>, role?: 'guest' | 'manager', write = false) {
  const auth = await new AuthService(context.env).resolve(getSessionCookie(context));
  const pathEvent = context.req.param('eventId') ?? context.req.param('slug');
  const matches = pathEvent === auth.event.id || pathEvent === auth.event.slug;
  if (!matches || (role && auth.session.role !== role)) {
    throw new ApiError('ROLE_FORBIDDEN', 'This session belongs to a different event.', 403);
  }
  if (write) await assertCsrf(context, auth);
  return auth;
}

export const messageRoutes = new Hono<AppBindings>();

messageRoutes.post('/event/:slug/messages', async (context) => {
  const auth = await eventAuth(context, 'guest', true);
  const parsed = z.object({
    guestName: z.string().trim().max(80).nullish(),
    body: z.string().trim().min(1).max(500),
  }).safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) throw new ApiError('VALIDATION_FAILED', 'Write a note between 1 and 500 characters.', 422);
  const now = new Date().toISOString();
  const message = await new MessagesRepository(context.env.DB).create({
    id: crypto.randomUUID(),
    eventId: auth.event.id,
    guestSessionId: auth.session.id,
    guestName: parsed.data.guestName || null,
    body: parsed.data.body,
    moderationStatus: auth.event.moderationRequired ? 'pending' : 'approved',
    createdAt: now,
  });
  return context.json({ data: { message }, requestId: context.get('requestId') }, 201);
});

messageRoutes.get('/event/:slug/messages', async (context) => {
  const auth = await eventAuth(context, 'guest');
  const items = await new MessagesRepository(context.env.DB).listFeed(auth.event.id, auth.session.id);
  return context.json({ data: { items }, requestId: context.get('requestId') });
});

messageRoutes.get('/manage/events/:eventId/messages', async (context) => {
  await eventAuth(context, 'manager');
  const rawStatus = context.req.query('status');
  const status = rawStatus && ['pending', 'approved', 'rejected'].includes(rawStatus)
    ? rawStatus as ModerationStatus
    : undefined;
  const messages = await new MessagesRepository(context.env.DB).listForManager(context.req.param('eventId'), status);
  return context.json({ data: { messages }, requestId: context.get('requestId') });
});

messageRoutes.patch('/manage/events/:eventId/messages/:messageId', async (context) => {
  const auth = await eventAuth(context, 'manager', true);
  const parsed = z.object({
    action: z.enum(['approve', 'reject', 'delete']),
    expectedStatus: z.enum(['pending', 'approved', 'rejected']).default('pending'),
  }).safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) throw new ApiError('VALIDATION_FAILED', 'Choose a valid note action.', 422);
  const repository = new MessagesRepository(context.env.DB);
  const current = await repository.getById(context.req.param('messageId'));
  if (!current || current.eventId !== auth.event.id) {
    throw new ApiError('ROLE_FORBIDDEN', 'This note belongs to a different event.', 403);
  }
  const message = parsed.data.action === 'delete'
    ? await repository.delete(current.id, new Date().toISOString())
    : await repository.moderate(
      current.id,
      parsed.data.expectedStatus,
      parsed.data.action === 'approve' ? 'approved' : 'rejected',
      new Date().toISOString(),
    );
  return context.json({ data: { message }, requestId: context.get('requestId') });
});


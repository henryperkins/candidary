import { Hono, type Context } from 'hono';
import { z } from 'zod';

import type { ModerationStatus } from '../../shared/contracts';
import { ApiError } from '../../shared/errors';
import { requireManager } from '../auth/manager';
import { AuthService } from '../auth/service';
import { MessagesRepository } from '../db/messages';
import type { AppBindings } from '../env';
import { getSessionCookie } from '../http/cookies';
import { assertCsrf } from '../http/csrf';
import { decodeMessageCursor, encodeMessageCursor } from '../http/message-cursor';
import type { MessageRecord } from '../db/types';

// Guest notes are a link-session surface; host moderation goes through the shared
// manager check so an account session reaches it too.
async function guestAuth(context: Context<AppBindings>, write = false) {
  const auth = await new AuthService(context.env).resolveEventSession(getSessionCookie(context));
  if (auth.session.role !== 'guest' || context.req.param('slug') !== auth.event.slug) {
    throw new ApiError('ROLE_FORBIDDEN', 'This session belongs to a different event.', 403);
  }
  if (write) await assertCsrf(context, 'event', auth.session.csrfDigest);
  return auth;
}

export const messageRoutes = new Hono<AppBindings>();

function guestMessageView(message: MessageRecord) {
  return {
    id: message.id,
    kind: 'message' as const,
    guestName: message.guestName,
    body: message.body,
    moderationStatus: message.moderationStatus,
    createdAt: message.createdAt,
    mediaId: null,
  };
}

messageRoutes.post('/event/:slug/messages', async (context) => {
  const auth = await guestAuth(context, true);
  const parsed = z.object({
    idempotencyKey: z.string().trim().min(1).max(128).optional(),
    guestName: z.string().trim().max(80).nullish(),
    body: z.string().trim().min(1).max(500),
  }).safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) throw new ApiError('VALIDATION_FAILED', 'Write a note with 1 to 500 characters.', 422);
  const now = new Date().toISOString();
  const created = await new MessagesRepository(context.env.DB).create({
    id: crypto.randomUUID(),
    eventId: auth.event.id,
    guestSessionId: auth.session.id,
    guestName: parsed.data.guestName || null,
    body: parsed.data.body,
    moderationStatus: auth.event.moderationRequired ? 'pending' : 'approved',
    idempotencyKey: parsed.data.idempotencyKey ?? null,
    createdAt: now,
  });
  return context.json({
    data: { message: guestMessageView(created.message), replayed: created.replayed },
    requestId: context.get('requestId'),
  }, created.replayed ? 200 : 201);
});

messageRoutes.get('/event/:slug/messages', async (context) => {
  const auth = await guestAuth(context);
  const rawCursor = context.req.query('cursor');
  const page = await new MessagesRepository(context.env.DB).listFeed(
    auth.event.id,
    auth.session.id,
    rawCursor === undefined ? undefined : decodeMessageCursor(rawCursor),
  );
  return context.json({
    data: {
      items: page.items,
      nextCursor: page.nextCursor ? encodeMessageCursor(page.nextCursor) : null,
    },
    requestId: context.get('requestId'),
  });
});

messageRoutes.get('/manage/events/:eventId/messages', async (context) => {
  await requireManager(context);
  const rawStatus = context.req.query('status');
  const status = rawStatus && ['pending', 'approved', 'rejected'].includes(rawStatus)
    ? rawStatus as ModerationStatus
    : undefined;
  const messages = await new MessagesRepository(context.env.DB).listForManager(context.req.param('eventId'), status);
  return context.json({ data: { messages }, requestId: context.get('requestId') });
});

messageRoutes.patch('/manage/events/:eventId/messages/:messageId', async (context) => {
  const auth = await requireManager(context, { write: true });
  const parsed = z.object({
    action: z.enum(['approve', 'reject', 'delete']),
    expectedStatus: z.enum(['pending', 'approved', 'rejected']).default('pending'),
  }).safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) throw new ApiError('VALIDATION_FAILED', 'Choose a valid note action.', 422);
  const repository = new MessagesRepository(context.env.DB);
  const current = await repository.getById(context.req.param('messageId'));
  if (!current || current.eventId !== auth.event.id) {
    throw new ApiError('RESOURCE_FORBIDDEN', 'This note belongs to a different event.', 403);
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

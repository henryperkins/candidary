import { Hono, type Context } from 'hono';
import { z } from 'zod';

import type { GuestGuestbookItem, LegacyGuestbookItem, ModerationStatus } from '../../shared/contracts';
import {
  MANAGER_GUESTBOOK_DEFAULT_PAGE_SIZE,
  MANAGER_GUESTBOOK_MAX_PAGE_SIZE,
} from '../../shared/constants';
import { ApiError } from '../../shared/errors';
import { requireManager } from '../auth/manager';
import { AuthService } from '../auth/service';
import { MessagesRepository } from '../db/messages';
import { GuestbookRepository } from '../db/guestbook';
import type { AppBindings } from '../env';
import { getSessionCookie } from '../http/cookies';
import { assertCsrf } from '../http/csrf';
import { decodeMessageCursor, encodeMessageCursor } from '../http/message-cursor';
import { decodeGuestbookCursor, encodeGuestbookCursor } from '../http/guestbook-cursor';
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

function legacyMessageView(message: MessageRecord): LegacyGuestbookItem {
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

function guestMessageItem(message: MessageRecord): GuestGuestbookItem {
  const base = {
    id: message.id,
    source: 'guest_note',
    guestName: message.guestName,
    body: message.body,
    createdAt: message.createdAt,
    visibility: message.moderationStatus === 'approved' ? 'shared' : 'author_only',
    isOwn: true,
    kind: 'message',
    mediaId: null,
  } as const;
  if (message.moderationStatus === 'approved') {
    return { ...base, state: 'approved', moderationStatus: 'approved' };
  }
  if (message.moderationStatus === 'rejected') {
    return { ...base, state: 'rejected', moderationStatus: 'rejected' };
  }
  return { ...base, state: 'pending', moderationStatus: 'pending' };
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
  const item = guestMessageItem(created.message);
  return context.json({
    data: {
      item,
      message: legacyMessageView(created.message),
      replayed: created.replayed,
    },
    requestId: context.get('requestId'),
  }, created.replayed ? 200 : 201);
});

messageRoutes.get('/event/:slug/messages', async (context) => {
  const auth = await guestAuth(context);
  if (context.req.query('contract') === '2') {
    const rawCursor = context.req.query('cursor');
    const rawOwnCursor = context.req.query('ownCursor');
    if (rawCursor !== undefined && rawOwnCursor !== undefined) {
      throw new ApiError('VALIDATION_FAILED', 'Advance one guestbook section at a time.', 422);
    }
    const repository = new GuestbookRepository(context.env.DB);
    const sharedCursor = rawCursor === undefined
      ? undefined
      : decodeGuestbookCursor(rawCursor, {
        audience: 'guest',
        stream: 'shared',
        eventId: auth.event.id,
        sessionId: auth.session.id,
      });
    const ownCursor = rawOwnCursor === undefined
      ? undefined
      : decodeGuestbookCursor(rawOwnCursor, {
        audience: 'guest',
        stream: 'own_unshared',
        eventId: auth.event.id,
        sessionId: auth.session.id,
      });
    const advancingShared = rawCursor !== undefined;
    const advancingOwn = rawOwnCursor !== undefined;
    const [shared, own] = await Promise.all([
      advancingOwn
        ? Promise.resolve({ items: [], nextCursor: null })
        : repository.listGuestShared(auth.event.id, auth.session.id, sharedCursor),
      advancingShared
        ? Promise.resolve({ items: [], count: 0, nextCursor: null })
        : repository.listGuestOwnUnshared(auth.event.id, auth.session.id, ownCursor),
    ]);
    return context.json({
      data: {
        items: shared.items,
        nextCursor: shared.nextCursor
          ? encodeGuestbookCursor({
            version: 2,
            audience: 'guest',
            stream: 'shared',
            eventId: auth.event.id,
            sessionId: auth.session.id,
            ...shared.nextCursor,
          })
          : null,
        ownUnshared: own.items,
        ownUnsharedCount: own.count,
        ownUnsharedNextCursor: own.nextCursor
          ? encodeGuestbookCursor({
            version: 2,
            audience: 'guest',
            stream: 'own_unshared',
            eventId: auth.event.id,
            sessionId: auth.session.id,
            ...own.nextCursor,
          })
          : null,
      },
      requestId: context.get('requestId'),
    });
  }
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

const managerGuestbookQuery = z.object({
  view: z.enum(['needs-review', 'shared', 'hidden', 'deleted']),
  source: z.enum(['all', 'guest_note', 'photo_caption']).default('all'),
  limit: z.coerce.number().int().min(1).max(MANAGER_GUESTBOOK_MAX_PAGE_SIZE)
    .default(MANAGER_GUESTBOOK_DEFAULT_PAGE_SIZE),
  cursor: z.string().optional(),
});

messageRoutes.get('/manage/events/:eventId/guestbook/summary', async (context) => {
  const auth = await requireManager(context);
  const summary = await new GuestbookRepository(context.env.DB).summaryForManager(auth.event.id);
  return context.json({ data: { summary }, requestId: context.get('requestId') });
});

messageRoutes.get('/manage/events/:eventId/guestbook', async (context) => {
  const auth = await requireManager(context);
  const parsed = managerGuestbookQuery.safeParse({
    view: context.req.query('view'),
    source: context.req.query('source'),
    limit: context.req.query('limit'),
    cursor: context.req.query('cursor'),
  });
  if (!parsed.success) {
    throw new ApiError('VALIDATION_FAILED', 'Choose a valid guestbook view, source, and page size.', 422);
  }
  const cursor = parsed.data.cursor === undefined
    ? undefined
    : decodeGuestbookCursor(parsed.data.cursor, {
      audience: 'manager',
      eventId: auth.event.id,
      view: parsed.data.view,
      source: parsed.data.source,
    });
  const repository = new GuestbookRepository(context.env.DB);
  const [page, summary] = await Promise.all([
    repository.listForManager(auth.event.id, {
      view: parsed.data.view,
      source: parsed.data.source,
      limit: parsed.data.limit,
      cursor,
    }),
    repository.summaryForManager(auth.event.id),
  ]);
  return context.json({
    data: {
      items: page.items,
      nextCursor: page.nextCursor
        ? encodeGuestbookCursor({
          version: 2,
          audience: 'manager',
          eventId: auth.event.id,
          view: parsed.data.view,
          source: parsed.data.source,
          ...page.nextCursor,
        })
        : null,
      summary,
    },
    requestId: context.get('requestId'),
  });
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
  const item = await new GuestbookRepository(context.env.DB).noteItemById(message.id);
  if (!item) throw new Error('Updated note projection was not found.');
  return context.json({ data: { item }, requestId: context.get('requestId') });
});

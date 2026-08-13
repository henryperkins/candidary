import { Hono, type Context } from 'hono';
import { z } from 'zod';

import type { GuestGuestbookItem, LegacyGuestbookItem, ModerationStatus } from '../../shared/contracts';
import {
  GUEST_NOTE_WINDOW_MS,
  MANAGER_GUESTBOOK_DEFAULT_PAGE_SIZE,
  MANAGER_GUESTBOOK_MAX_PAGE_SIZE,
} from '../../shared/constants';
import { ApiError } from '../../shared/errors';
import { requireManager } from '../auth/manager';
import { AuthService } from '../auth/service';
import {
  MessagesRepository,
  type GuestMessageState,
  type GuestMessageStateAction,
} from '../db/messages';
import { GuestbookRepository } from '../db/guestbook';
import type { AppBindings } from '../env';
import { getSessionCookie } from '../http/cookies';
import { assertCsrf } from '../http/csrf';
import { decodeMessageCursor, encodeMessageCursor } from '../http/message-cursor';
import { decodeGuestbookCursor, encodeGuestbookCursor } from '../http/guestbook-cursor';
import { clientIp } from '../http/client-ip';
import {
  guestMessageIpScopeDigest,
  guestMessagePayloadHmac,
  guestMessageSessionScopeDigest,
} from '../security/guest-message';
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
  const trustedIp = clientIp(context);
  const ipScopeDigest = await guestMessageIpScopeDigest(
    context.env.GUEST_MESSAGE_HMAC_KEY,
    auth.event.id,
    trustedIp,
  );
  if (!(await context.env.GUEST_MESSAGE_RATE_LIMIT.limit({ key: ipScopeDigest })).success) {
    context.header('Retry-After', '60');
    throw new ApiError('RATE_LIMITED', 'Too many note attempts. Try again in a minute.', 429);
  }
  const parsed = z.object({
    idempotencyKey: z.string().trim().min(1).max(128),
    guestName: z.string().trim().max(80).nullish(),
    body: z.string().trim().min(1).max(500),
  }).safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) throw new ApiError('VALIDATION_FAILED', 'Write a note with 1 to 500 characters.', 422);
  const now = new Date().toISOString();
  const requestHmac = await guestMessagePayloadHmac(
    context.env.GUEST_MESSAGE_HMAC_KEY,
    parsed.data.guestName || null,
    parsed.data.body,
  );
  const sessionScopeDigest = await guestMessageSessionScopeDigest(
    context.env.GUEST_MESSAGE_HMAC_KEY,
    auth.event.id,
    auth.session.id,
  );
  const windowStartedAt = new Date(
    Math.floor(Date.parse(now) / GUEST_NOTE_WINDOW_MS) * GUEST_NOTE_WINDOW_MS,
  ).toISOString();
  let created;
  try {
    created = await new MessagesRepository(context.env.DB).createBounded({
      id: crypto.randomUUID(),
      eventId: auth.event.id,
      guestSessionId: auth.session.id,
      guestName: parsed.data.guestName || null,
      body: parsed.data.body,
      idempotencyKey: parsed.data.idempotencyKey,
      createdAt: now,
      sessionScopeDigest,
      ipScopeDigest,
      windowStartedAt,
      requestHmac,
    });
  } catch (error) {
    if (error instanceof ApiError && error.code === 'RATE_LIMITED') {
      const retryAfter = Math.max(1, Math.ceil(
        (Date.parse(windowStartedAt) + GUEST_NOTE_WINDOW_MS - Date.parse(now)) / 1_000,
      ));
      context.header('Retry-After', String(retryAfter));
    }
    throw error;
  }
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
      : await decodeGuestbookCursor(rawCursor, {
        audience: 'guest',
        stream: 'shared',
        eventId: auth.event.id,
        sessionId: auth.session.id,
      }, context.env.SESSION_HMAC_KEY);
    const ownCursor = rawOwnCursor === undefined
      ? undefined
      : await decodeGuestbookCursor(rawOwnCursor, {
        audience: 'guest',
        stream: 'own_unshared',
        eventId: auth.event.id,
        sessionId: auth.session.id,
      }, context.env.SESSION_HMAC_KEY);
    const advancingShared = rawCursor !== undefined;
    const advancingOwn = rawOwnCursor !== undefined;
    const [shared, own] = await Promise.all([
      advancingOwn
        ? Promise.resolve({ items: [], nextCursor: null })
        : repository.listGuestShared(auth.event.id, auth.session.id, sharedCursor),
      advancingShared
        ? repository.countGuestOwnUnshared(auth.event.id, auth.session.id)
          .then((count) => ({ items: [], count, nextCursor: null }))
        : repository.listGuestOwnUnshared(auth.event.id, auth.session.id, ownCursor),
    ]);
    return context.json({
      data: {
        items: shared.items,
        nextCursor: shared.nextCursor
          ? await encodeGuestbookCursor({
            version: 2,
            audience: 'guest',
            stream: 'shared',
            eventId: auth.event.id,
            sessionId: auth.session.id,
            ...shared.nextCursor,
          }, context.env.SESSION_HMAC_KEY)
          : null,
        ownUnshared: own.items,
        ownUnsharedCount: own.count,
        ownUnsharedNextCursor: own.nextCursor
          ? await encodeGuestbookCursor({
            version: 2,
            audience: 'guest',
            stream: 'own_unshared',
            eventId: auth.event.id,
            sessionId: auth.session.id,
            ...own.nextCursor,
          }, context.env.SESSION_HMAC_KEY)
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
    : await decodeGuestbookCursor(parsed.data.cursor, {
      audience: 'manager',
      eventId: auth.event.id,
      view: parsed.data.view,
      source: parsed.data.source,
    }, context.env.SESSION_HMAC_KEY);
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
        ? await encodeGuestbookCursor({
          version: 2,
          audience: 'manager',
          eventId: auth.event.id,
          view: parsed.data.view,
          source: parsed.data.source,
          ...page.nextCursor,
        }, context.env.SESSION_HMAC_KEY)
        : null,
      summary,
    },
    requestId: context.get('requestId'),
  });
});

messageRoutes.patch('/manage/events/:eventId/messages/:messageId', async (context) => {
  const auth = await requireManager(context, { write: true });
  const parsed = z.object({
    action: z.enum(['approve', 'reject', 'delete', 'restore', 'purge']),
    expectedState: z.enum(['pending', 'approved', 'rejected', 'deleted']).optional(),
    expectedStatus: z.enum(['pending', 'approved', 'rejected']).optional(),
  }).safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) throw new ApiError('VALIDATION_FAILED', 'Choose a valid note action.', 422);
  const expectedState = parsed.data.expectedState ?? parsed.data.expectedStatus;
  if (!expectedState || (parsed.data.expectedState && parsed.data.expectedStatus
    && parsed.data.expectedState !== parsed.data.expectedStatus)) {
    throw new ApiError('VALIDATION_FAILED', 'Use one matching expected note state.', 422);
  }
  const repository = new MessagesRepository(context.env.DB);
  const current = await repository.getById(context.req.param('messageId'));
  if (!current || current.eventId !== auth.event.id) {
    throw new ApiError('RESOURCE_FORBIDDEN', 'This note belongs to a different event.', 403);
  }
  if (parsed.data.action === 'purge') {
    const purged = await repository.purgeDeleted(
      current.id,
      auth.event.id,
      expectedState as GuestMessageState,
      await guestMessagePayloadHmac(
        context.env.GUEST_MESSAGE_HMAC_KEY,
        current.guestName,
        current.body,
      ),
      new Date().toISOString(),
    );
    return context.json({ data: { purged }, requestId: context.get('requestId') });
  }
  const message = await repository.changeState(
    current.id,
    auth.event.id,
    expectedState as GuestMessageState,
    parsed.data.action as GuestMessageStateAction,
    new Date().toISOString(),
  );
  const item = await new GuestbookRepository(context.env.DB).noteItemById(message.id);
  if (!item) throw new Error('Updated note projection was not found.');
  return context.json({
    data: { item, message: legacyMessageView(message) },
    requestId: context.get('requestId'),
  });
});

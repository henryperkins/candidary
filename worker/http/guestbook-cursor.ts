import { z } from 'zod';

import { ApiError } from '../../shared/errors';

const keySchema = z.object({
  createdAt: z.iso.datetime({ offset: true }),
  sourceRank: z.union([z.literal(0), z.literal(1)]),
  id: z.uuid(),
});

const guestCursorSchema = keySchema.extend({
  version: z.literal(2),
  audience: z.literal('guest'),
  stream: z.enum(['shared', 'own_unshared']),
  eventId: z.uuid(),
  sessionId: z.string().min(1).max(128),
}).strict();

const managerCursorSchema = keySchema.extend({
  version: z.literal(2),
  audience: z.literal('manager'),
  eventId: z.uuid(),
  view: z.enum(['needs-review', 'shared', 'hidden', 'deleted']),
  source: z.enum(['all', 'guest_note', 'photo_caption']),
}).strict();

const cursorSchema = z.discriminatedUnion('audience', [guestCursorSchema, managerCursorSchema]);

export type GuestbookCursor = z.infer<typeof cursorSchema>;
export type GuestbookCursorKey = Pick<GuestbookCursor, 'createdAt' | 'sourceRank' | 'id'>;
export type GuestbookManagerView = z.infer<typeof managerCursorSchema>['view'];
export type GuestbookManagerSource = z.infer<typeof managerCursorSchema>['source'];

export type GuestbookCursorBinding =
  | Pick<z.infer<typeof guestCursorSchema>, 'audience' | 'stream' | 'eventId' | 'sessionId'>
  | Pick<z.infer<typeof managerCursorSchema>, 'audience' | 'eventId' | 'view' | 'source'>;

const MAX_CURSOR_LENGTH = 512;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

function invalidCursor(): ApiError {
  return new ApiError('VALIDATION_FAILED', 'The guestbook page cursor is invalid.', 422);
}

export function encodeGuestbookCursor(cursor: GuestbookCursor): string {
  return btoa(JSON.stringify(cursor))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

export function decodeGuestbookCursor(
  value: string,
  binding: GuestbookCursorBinding,
): GuestbookCursor {
  if (value.length > MAX_CURSOR_LENGTH || !BASE64URL.test(value)) throw invalidCursor();
  try {
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
    const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), '=');
    const cursor = cursorSchema.parse(JSON.parse(atob(padded)));
    if (cursor.audience !== binding.audience || cursor.eventId !== binding.eventId) throw invalidCursor();
    if (cursor.audience === 'guest' && binding.audience === 'guest') {
      if (cursor.stream !== binding.stream || cursor.sessionId !== binding.sessionId) throw invalidCursor();
    } else if (cursor.audience === 'manager' && binding.audience === 'manager') {
      if (cursor.view !== binding.view || cursor.source !== binding.source) throw invalidCursor();
    } else {
      throw invalidCursor();
    }
    return cursor;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw invalidCursor();
  }
}

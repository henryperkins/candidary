import { z } from 'zod';

import { ApiError } from '../../shared/errors';
import { constantTimeEqual, digestSecret } from '../security/crypto';

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
  sessionBinding: z.string().min(1).max(128),
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
export type GuestbookCursorInput =
  | Omit<z.infer<typeof guestCursorSchema>, 'sessionBinding'> & { sessionId: string }
  | z.infer<typeof managerCursorSchema>;
export type GuestbookCursorKey = Pick<GuestbookCursor, 'createdAt' | 'sourceRank' | 'id'>;
export type GuestbookManagerView = z.infer<typeof managerCursorSchema>['view'];
export type GuestbookManagerSource = z.infer<typeof managerCursorSchema>['source'];

export type GuestbookCursorBinding =
  | Pick<z.infer<typeof guestCursorSchema>, 'audience' | 'stream' | 'eventId'> & { sessionId: string }
  | Pick<z.infer<typeof managerCursorSchema>, 'audience' | 'eventId' | 'view' | 'source'>;

const MAX_CURSOR_LENGTH = 512;
const SIGNED_CURSOR = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/u;
const SESSION_BINDING_DOMAIN = 'guestbook-cursor-session:v2:';
const CURSOR_MAC_DOMAIN = 'guestbook-cursor-payload:v2:';

function invalidCursor(): ApiError {
  return new ApiError('VALIDATION_FAILED', 'The guestbook page cursor is invalid.', 422);
}

function encodePayload(cursor: GuestbookCursor): string {
  return btoa(JSON.stringify(cursor))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

async function sessionBinding(sessionId: string, keyMaterial: string): Promise<string> {
  return digestSecret(`${SESSION_BINDING_DOMAIN}${sessionId}`, keyMaterial);
}

export async function encodeGuestbookCursor(
  input: GuestbookCursorInput,
  keyMaterial: string,
): Promise<string> {
  let cursor: GuestbookCursor;
  if (input.audience === 'guest') {
    const { sessionId, ...wire } = input;
    cursor = guestCursorSchema.parse({
      ...wire,
      sessionBinding: await sessionBinding(sessionId, keyMaterial),
    });
  } else {
    cursor = managerCursorSchema.parse(input);
  }
  const payload = encodePayload(cursor);
  const mac = await digestSecret(`${CURSOR_MAC_DOMAIN}${payload}`, keyMaterial);
  return `${payload}.${mac}`;
}

export async function decodeGuestbookCursor(
  value: string,
  binding: GuestbookCursorBinding,
  keyMaterial: string,
): Promise<GuestbookCursor> {
  if (value.length > MAX_CURSOR_LENGTH) throw invalidCursor();
  try {
    const match = SIGNED_CURSOR.exec(value);
    if (!match) throw invalidCursor();
    const [, payload, suppliedMac] = match;
    if (!payload || !suppliedMac) throw invalidCursor();
    const expectedMac = await digestSecret(`${CURSOR_MAC_DOMAIN}${payload}`, keyMaterial);
    if (!constantTimeEqual(suppliedMac, expectedMac)) throw invalidCursor();
    const normalized = payload.replaceAll('-', '+').replaceAll('_', '/');
    const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), '=');
    const cursor = cursorSchema.parse(JSON.parse(atob(padded)));
    if (cursor.audience !== binding.audience || cursor.eventId !== binding.eventId) throw invalidCursor();
    if (cursor.audience === 'guest' && binding.audience === 'guest') {
      const expectedBinding = await sessionBinding(binding.sessionId, keyMaterial);
      if (cursor.stream !== binding.stream || !constantTimeEqual(cursor.sessionBinding, expectedBinding)) {
        throw invalidCursor();
      }
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

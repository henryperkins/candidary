import { z } from 'zod';

import { ApiError } from '../../shared/errors';

const cursorSchema = z.object({
  createdAt: z.iso.datetime({ offset: true }),
  id: z.uuid(),
}).strict();

export type MessageCursor = z.infer<typeof cursorSchema> & { version: 1 };

const MAX_CURSOR_LENGTH = 512;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

export function encodeMessageCursor(cursor: MessageCursor): string {
  return btoa(JSON.stringify({ createdAt: cursor.createdAt, id: cursor.id }))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

export function decodeMessageCursor(value: string): MessageCursor {
  if (value.length > MAX_CURSOR_LENGTH || !BASE64URL.test(value)) {
    throw new ApiError('VALIDATION_FAILED', 'The notes page cursor is invalid.', 422);
  }
  try {
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
    const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), '=');
    return { version: 1, ...cursorSchema.parse(JSON.parse(atob(padded))) };
  } catch {
    throw new ApiError('VALIDATION_FAILED', 'The notes page cursor is invalid.', 422);
  }
}

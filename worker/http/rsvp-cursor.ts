import { z } from 'zod';

import { ApiError } from '../../shared/errors';

// A cursor is a position and nothing else. The query text and the state filter
// stay explicit request parameters, so a cursor cannot smuggle a different
// filter into the page it continues.
const cursorSchema = z.object({
  updatedAt: z.iso.datetime({ offset: true }),
  id: z.uuid(),
}).strict();

export type RsvpHouseholdCursor = z.infer<typeof cursorSchema>;

// Long enough for any cursor this encodes, short enough that a hostile value is
// rejected before it is decoded.
const MAX_CURSOR_LENGTH = 512;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

export function encodeRsvpCursor(cursor: RsvpHouseholdCursor): string {
  return btoa(JSON.stringify({ updatedAt: cursor.updatedAt, id: cursor.id }))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

export function decodeRsvpCursor(value: string): RsvpHouseholdCursor {
  // Every malformed shape — bad base64, bad JSON, a non-UUID id, a timestamp
  // without an offset, an oversized string — answers identically. A cursor the
  // host did not receive from us is simply not a cursor.
  if (value.length > MAX_CURSOR_LENGTH || !BASE64URL.test(value)) {
    throw new ApiError('VALIDATION_FAILED', 'The guest list page cursor is invalid.', 422);
  }
  try {
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
    const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), '=');
    return cursorSchema.parse(JSON.parse(atob(padded)));
  } catch {
    throw new ApiError('VALIDATION_FAILED', 'The guest list page cursor is invalid.', 422);
  }
}

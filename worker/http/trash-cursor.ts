import { z } from 'zod';

import { ApiError } from '../../shared/errors';

// Recently deleted pages on `(trashed_at DESC, id DESC)`, which is its own
// keyset: an Intake cursor and a trash cursor are never interchangeable, and
// decoding one as the other is a validation failure rather than a silent
// jump to a different position in a different list.
const cursorSchema = z.object({
  trashedAt: z.iso.datetime({ offset: true }),
  id: z.uuid(),
});

export type ManagerTrashCursor = z.infer<typeof cursorSchema>;

export function encodeTrashCursor(cursor: ManagerTrashCursor): string {
  return btoa(JSON.stringify({ trashedAt: cursor.trashedAt, id: cursor.id }))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

export function decodeTrashCursor(value: string): ManagerTrashCursor {
  try {
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
    const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), '=');
    return cursorSchema.parse(JSON.parse(atob(padded)));
  } catch {
    throw new ApiError('VALIDATION_FAILED', 'The Recently deleted page cursor is invalid.', 422);
  }
}

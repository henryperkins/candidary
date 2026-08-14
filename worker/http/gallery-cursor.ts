import { z } from 'zod';

import { ApiError } from '../../shared/errors';

// zod 4 moved the string formats to the top level; `z.string().uuid()` and
// `z.string().datetime()` are both marked deprecated in this version.
const cursorSchema = z.object({
  timelineAt: z.iso.datetime({ offset: true }),
  id: z.uuid(),
});

export type GalleryCursor = z.infer<typeof cursorSchema>;

export function encodeGalleryCursor(cursor: GalleryCursor): string {
  return btoa(JSON.stringify({ timelineAt: cursor.timelineAt, id: cursor.id }))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

export function decodeGalleryCursor(value: string): GalleryCursor {
  try {
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
    const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), '=');
    return cursorSchema.parse(JSON.parse(atob(padded)));
  } catch {
    throw new ApiError('VALIDATION_FAILED', 'The gallery page cursor is invalid.', 422);
  }
}

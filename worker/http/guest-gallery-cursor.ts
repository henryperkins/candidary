import { z } from 'zod';
import { ApiError } from '../../shared/errors';

const cursorSchema = z.object({
  v: z.literal(1),
  eventId: z.string().min(1).max(100),
  publishedAt: z.iso.datetime({ offset: true }).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  id: z.uuid(),
}).strict();

export interface GuestGalleryCursor {
  publishedAt: string | null;
  createdAt: string;
  id: string;
}

export function encodeGuestGalleryCursor(eventId: string, cursor: GuestGalleryCursor): string {
  return btoa(JSON.stringify({ v: 1, eventId, ...cursor }))
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

export function decodeGuestGalleryCursor(eventId: string, value: string): GuestGalleryCursor {
  try {
    if (value.length > 1024 || !/^[\w-]+$/u.test(value)) throw new Error('Invalid cursor encoding.');
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
    const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), '=');
    const cursor = cursorSchema.parse(JSON.parse(atob(padded)));
    if (cursor.eventId !== eventId) throw new Error('Different event.');
    return { publishedAt: cursor.publishedAt, createdAt: cursor.createdAt, id: cursor.id };
  } catch {
    throw new ApiError('VALIDATION_FAILED', 'The shared gallery page cursor is invalid. Reload the gallery to start again.', 422);
  }
}

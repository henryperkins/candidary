import { z } from 'zod';

import { GALLERY_TIMELINE_ORDERS, type GalleryTimelineOrder } from '../../shared/constants';
import { ApiError } from '../../shared/errors';
import type { LibraryCursorV3, LibraryQuery } from '../../shared/library-arrivals';

// zod 4 moved the string formats to the top level; `z.string().uuid()` and
// `z.string().datetime()` are both marked deprecated in this version.
const position = {
  timelineAt: z.iso.datetime({ offset: true }),
  id: z.uuid(),
};
/**
 * A cursor is a position *and* the direction it was cut for: the keyset predicate
 * flips with the order, so replaying an earliest-first position against a
 * newest-first query would silently return the wrong side of the stream. v1
 * predates the order control and can only have meant earliest-first.
 */
const cursorSchema = z.union([
  z.object({ v: z.literal(1), ...position }).strict(),
  z.object({ v: z.literal(2), order: z.enum(GALLERY_TIMELINE_ORDERS), ...position }).strict(),
]);

const libraryCursorSchema = z.object({
  v: z.literal(3),
  eventId: z.string().min(1),
  snapshotSequence: z.number().int().nonnegative().safe(),
  query: z.string()
    .refine((value) => value === value.trim())
    .refine((value) => [...value].length <= 120),
  favorites: z.boolean(),
  order: z.enum(GALLERY_TIMELINE_ORDERS),
  ...position,
}).strict();

export interface GalleryCursor {
  timelineAt: string;
  id: string;
}

export function encodeGalleryCursor(cursor: GalleryCursor, order: GalleryTimelineOrder): string {
  return btoa(JSON.stringify({ v: 2, order, timelineAt: cursor.timelineAt, id: cursor.id }))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

export function decodeGalleryCursor(value: string, order: GalleryTimelineOrder): GalleryCursor {
  let parsed;
  try {
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
    const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), '=');
    parsed = cursorSchema.parse(JSON.parse(atob(padded)));
  } catch {
    throw new ApiError('VALIDATION_FAILED', 'The gallery page cursor is invalid.', 422);
  }
  const cursorOrder: GalleryTimelineOrder = parsed.v === 1 ? 'earliest' : parsed.order;
  if (cursorOrder !== order) {
    throw new ApiError('VALIDATION_FAILED', 'The gallery page cursor is for a different order.', 422);
  }
  return { timelineAt: parsed.timelineAt, id: parsed.id };
}

function encodeUtf8Base64Url(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

function decodeUtf8Base64Url(value: string): unknown {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), '=');
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

export function encodeLibraryCursor(cursor: LibraryCursorV3): string {
  return encodeUtf8Base64Url(cursor);
}

export function decodeLibraryCursor(
  value: string,
  eventId: string,
  query: LibraryQuery,
): LibraryCursorV3 {
  let parsed: LibraryCursorV3;
  try {
    parsed = libraryCursorSchema.parse(decodeUtf8Base64Url(value));
  } catch {
    throw new ApiError('VALIDATION_FAILED', 'The Library page cursor is invalid.', 422);
  }
  if (parsed.eventId !== eventId
    || parsed.query !== query.query
    || parsed.favorites !== query.favorites
    || parsed.order !== query.order) {
    throw new ApiError('VALIDATION_FAILED', 'The Library page cursor is for a different view.', 422);
  }
  return parsed;
}

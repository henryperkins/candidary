import { z } from 'zod';
import type { ExportKind, ExportState, ManagerExportErrorCode } from './contracts';

export type PhotoExportDestination = 'archive' | 'device' | 'google-photos' | 'onedrive';
export type PhotoExportSource =
  | { mode: 'ids'; scope: 'library' | 'album'; mediaIds: string[] }
  | { mode: 'all'; scope: 'library'; filter: { query?: string; favorites?: true; order: 'newest' | 'oldest' }; excludedMediaIds: string[] }
  | { mode: 'all'; scope: 'album'; excludedMediaIds: string[] };
export interface CreatePhotoExportRequest {
  version: 1;
  idempotencyKey: string;
  source: PhotoExportSource;
  destination: PhotoExportDestination;
}
export const PHOTO_EXPORT_MAX_IDS = 10_000;
export const PHOTO_EXPORT_BODY_MAX_BYTES = 1024 * 1024;
export const DEVICE_EXPORT_MAX_FILES = 20;
export const DEVICE_EXPORT_MAX_BYTES = 40 * 1024 * 1024;
export const DEVICE_EXPORT_CONCURRENCY = 2;

const ids = z.array(z.string().uuid()).max(PHOTO_EXPORT_MAX_IDS)
  .refine(value => new Set(value.map(id => id.toLowerCase())).size === value.length, 'Duplicate media IDs');
const query = z.string().trim().refine(value => [...value].length >= 1 && [...value].length <= 120,
  'Search must contain between 1 and 120 characters');
export const createPhotoExportSchema = z.object({
  version: z.literal(1),
  idempotencyKey: z.string().uuid(),
  destination: z.enum(['archive', 'device', 'google-photos', 'onedrive']),
  source: z.union([
    z.object({ mode: z.literal('ids'), scope: z.enum(['library', 'album']), mediaIds: ids.refine(value => value.length > 0, 'Select at least one photo') }).strict(),
    z.object({ mode: z.literal('all'), scope: z.literal('library'), filter: z.object({
      query: query.optional(), favorites: z.literal(true).optional(), order: z.enum(['newest', 'oldest']),
    }).strict(), excludedMediaIds: ids }).strict(),
    z.object({ mode: z.literal('all'), scope: z.literal('album'), excludedMediaIds: ids }).strict(),
  ]),
}).strict();

/** Descriptor equality is independent of selection click order and request identity. */
export function canonicalPhotoExportRequest(request: CreatePhotoExportRequest): string {
  const parsed = createPhotoExportSchema.parse(request);
  const source = parsed.source;
  const canonicalSource = source.mode === 'ids'
    ? { mode: source.mode, scope: source.scope, mediaIds: [...source.mediaIds].sort() }
    : source.scope === 'album'
      ? { mode: source.mode, scope: source.scope, excludedMediaIds: [...source.excludedMediaIds].sort() }
      : { mode: source.mode, scope: source.scope,
        // Library uses SQLite lower(), which folds ASCII, not Unicode case.
        filter: { ...(source.filter.query === undefined ? {} : { query: source.filter.query.replace(/[A-Z]/gu, letter => letter.toLowerCase()) }),
          ...(source.filter.favorites ? { favorites: true } : {}), order: source.filter.order },
        excludedMediaIds: [...source.excludedMediaIds].sort() };
  return JSON.stringify({ version: parsed.version, source: canonicalSource, destination: parsed.destination });
}

export interface PhotoExportView {
  id: string;
  kind: 'selection';
  destination: PhotoExportDestination;
  source: PhotoExportSource;
  state: ExportState;
  snapshotAt: string;
  createdAt: string;
  confirmedAt: string | null;
  completedAt: string | null;
  mediaCount: number;
  totalBytes: number;
  handedOffCount: number;
  unavailableCount: number;
  holdExpiresAt: string;
  absoluteExpiresAt: string;
  cancelRequested: boolean;
  errorCode: ManagerExportErrorCode | null;
  attempt: number;
}
export interface PhotoExportEntryView {
  mediaId: string;
  position: number;
  filename: string;
  mimeType: string;
  byteSize: number;
  state: 'pending' | 'prepared' | 'acknowledged' | 'failed' | 'unresolved';
}
export interface PhotoExportCapabilities {
  enabled: boolean;
  destinations: Array<'archive' | 'device'>;
  activeJob: null | {
    id: PhotoExportView['id'];
    kind: ExportKind;
    state: ExportState;
    destination: PhotoExportDestination;
    mediaCount: PhotoExportView['mediaCount'];
    totalBytes: PhotoExportView['totalBytes'];
    ownedByCurrentPrincipal: boolean;
  };
}

/** Private HTTP 409 data, deliberately omitting the owner's source and credentials. */
export interface PhotoExportActiveConflict {
  kind: 'active-export-conflict';
  activeJob: NonNullable<PhotoExportCapabilities['activeJob']>;
}

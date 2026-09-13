import { describe, expect, it } from 'vitest';
import { canonicalPhotoExportRequest, createPhotoExportSchema, PHOTO_EXPORT_MAX_IDS } from '../../shared/photo-exports';

const a = '123e4567-e89b-42d3-a456-426614174000';
const b = '123e4567-e89b-42d3-a456-426614174001';
const request = { version: 1 as const, idempotencyKey: a, destination: 'device' as const,
  source: { mode: 'ids' as const, scope: 'library' as const, mediaIds: [a, b] } };

describe('photo export selection contract', () => {
  it('accepts supported descriptors without enabling a destination', () => {
    for (const destination of ['archive', 'device', 'google-photos', 'onedrive']) {
      expect(createPhotoExportSchema.safeParse({ ...request, destination }).success).toBe(true);
    }
  });
  it('rejects malformed, duplicate, empty and oversized explicit sets', () => {
    const maximum = Array.from({ length: PHOTO_EXPORT_MAX_IDS }, (_, index) => `123e4567-e89b-42d3-a456-${index.toString(16).padStart(12, '0')}`);
    expect(createPhotoExportSchema.safeParse({ ...request, source: { ...request.source, mediaIds: maximum } }).success).toBe(true);
    for (const mediaIds of [[], [a, a], ['invalid'], [...maximum, b]]) {
      expect(createPhotoExportSchema.safeParse({ ...request, source: { ...request.source, mediaIds } }).success).toBe(false);
    }
  });
  it('strictly rejects extra fields at every nesting level and invalid identity', () => {
    for (const value of [{ ...request, unexpected: true }, { ...request, idempotencyKey: 'bad' },
      { ...request, source: { ...request.source, filter: {} } },
      { ...request, source: { mode: 'all', scope: 'album', filter: {}, excludedMediaIds: [] } },
      { ...request, source: { mode: 'all', scope: 'library', filter: { order: 'newest', extra: 1 }, excludedMediaIds: [] } }]) {
      expect(createPhotoExportSchema.safeParse(value).success).toBe(false);
    }
  });
  it('bounds query code points and rejects duplicate exclusions', () => {
    const source = { mode: 'all', scope: 'library', filter: { order: 'oldest', query: '😀'.repeat(120) }, excludedMediaIds: [] };
    expect(createPhotoExportSchema.safeParse({ ...request, source }).success).toBe(true);
    expect(createPhotoExportSchema.safeParse({ ...request, source: { ...source, filter: { ...source.filter, query: '😀'.repeat(121) } } }).success).toBe(false);
    expect(createPhotoExportSchema.safeParse({ ...request, source: { ...source, excludedMediaIds: [a, a] } }).success).toBe(false);
    expect(createPhotoExportSchema.safeParse({ ...request, source: { ...source, filter: { ...source.filter, query: '  ' } } }).success).toBe(false);
  });
  it('canonicalizes sets without mutating their ordering and excludes the idempotency key', () => {
    const reversed = { ...request, idempotencyKey: b, source: { ...request.source, mediaIds: [b, a] } };
    expect(canonicalPhotoExportRequest(request)).toBe(canonicalPhotoExportRequest(reversed));
    expect(reversed.source.mediaIds).toEqual([b, a]);
    expect(canonicalPhotoExportRequest(request)).not.toContain('idempotencyKey');
  });
  it('normalizes Library trim and SQLite ASCII case semantics without changing spacing or order', () => {
    const all = { ...request, source: { mode: 'all' as const, scope: 'library' as const, filter: { order: 'newest' as const, query: '  A  B  ' }, excludedMediaIds: [b, a] } };
    expect(canonicalPhotoExportRequest(all)).toBe(canonicalPhotoExportRequest({ ...all, source: { ...all.source, filter: { order: 'newest', query: 'A  B' }, excludedMediaIds: [a, b] } }));
    expect(canonicalPhotoExportRequest(all)).toBe(canonicalPhotoExportRequest({ ...all, source: { ...all.source, filter: { order: 'newest', query: 'a  b' } } }));
    expect(canonicalPhotoExportRequest(all)).not.toBe(canonicalPhotoExportRequest({ ...all, source: { ...all.source, filter: { order: 'newest', query: 'a b' } } }));
    expect(canonicalPhotoExportRequest({ ...all, source: { ...all.source, filter: { order: 'newest', query: 'Ä' } } })).not.toBe(canonicalPhotoExportRequest({ ...all, source: { ...all.source, filter: { order: 'newest', query: 'ä' } } }));
    expect(canonicalPhotoExportRequest(all)).not.toBe(canonicalPhotoExportRequest({ ...all, source: { ...all.source, filter: { order: 'oldest', query: 'A  B' } } }));
  });
});

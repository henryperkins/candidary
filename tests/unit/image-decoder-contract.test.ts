import { describe, expect, it } from 'vitest';
import { parseDecoderFailure, parseDecoderHealth, parseDecoderInspection } from '../../shared/image-decoder-contract';

const inspection = {
  family: 'heic', width: 4032, height: 3024, frameCount: 1, primaryIndex: 1, isSequence: false,
  sourceSha256: 'a'.repeat(64), byteSize: 12 * 1024 * 1024, buildFingerprint: 'b'.repeat(64),
  decoderVersion: 'qualified-test-1', previewProfile: 'mobile-preview-v1',
};

describe('closed private decoder proof', () => {
  it('accepts a complete primary image proof and identity-only health', () => {
    expect(parseDecoderInspection(inspection)).toEqual(inspection);
    expect(parseDecoderHealth({ protocolVersion: 1, buildFingerprint: inspection.buildFingerprint, decoderVersion: '1.0' }))
      .toEqual({ protocolVersion: 1, buildFingerprint: inspection.buildFingerprint, decoderVersion: '1.0' });
  });

  it.each(Object.keys(inspection))('rejects a missing %s', (key) => {
    const value: Record<string, unknown> = { ...inspection };
    delete value[key];
    expect(() => parseDecoderInspection(value)).toThrow(expect.objectContaining({ code: 'unavailable' }));
  });

  it.each([
    { family: 'svg' }, { width: 0 }, { height: 1.5 }, { width: 300_000_001 }, { frameCount: 1025 },
    { frameCount: 2 }, { isSequence: 'false' }, { primaryIndex: -1 }, { byteSize: 0 }, { byteSize: 512 * 1024 * 1024 + 1 },
    { sourceSha256: 'xyz' }, { buildFingerprint: 'b'.repeat(63) }, { decoderVersion: 'a\nsecret' },
    { previewProfile: 'arbitrary-transform' }, { guestName: 'private guest' },
  ])('rejects invalid or extra proof fields: %j', (change) => {
    expect(() => parseDecoderInspection({ ...inspection, ...change })).toThrow(expect.objectContaining({ code: 'unavailable' }));
  });

  it('refuses self-certified case lists in health and unknown protocol versions', () => {
    const health = { protocolVersion: 1, buildFingerprint: inspection.buildFingerprint, decoderVersion: '1.0' };
    expect(() => parseDecoderHealth({ ...health, verifiedCases: ['all'] })).toThrow();
    expect(() => parseDecoderHealth({ ...health, protocolVersion: 2 })).toThrow();
  });

  it.each(['unsupported', 'malformed', 'resource_limit', 'busy', 'unavailable'] as const)('admits only the closed %s failure', (code) => {
    expect(parseDecoderFailure({ code })).toBe(code);
    expect(parseDecoderFailure({ code, stderr: 'private path and native metadata' })).toBe('unavailable');
  });
  it('sanitizes unknown native failures', () => {
    expect(parseDecoderFailure({ code: 'native_crash', message: 'secret' })).toBe('unavailable');
  });
});

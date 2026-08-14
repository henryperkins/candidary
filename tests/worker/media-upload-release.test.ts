import { afterEach, describe, expect, it } from 'vitest';

import {
  assertEventRelationalPurgeEnabled,
  assertLegacyMediaCopyEnabled,
  assertLegacyPointerCutoverEnabled,
  assertWorkerIngressEnabled,
  mediaUploadRelease,
} from '../../worker/media-upload-release';

describe('schema 15 media upload release contract', () => {
  afterEach(() => {
    delete globalThis.__CANDIDARY_TEST_MEDIA_UPLOAD_RELEASE_OVERRIDE__;
  });

  it('binds Candidate B production behavior to the exact live capability set', () => {
    expect(mediaUploadRelease).toEqual({
      kind: 'candidary.media-upload-release',
      schemaVersion: 2,
      mode: 'canonical-live',
      capabilities: {
        singleInitiationPresign: false,
        batchInitiationPresign: false,
        storedReplayPresign: false,
        reservedFinalize: false,
        authenticatedWorkerIngress: true,
        legacyMediaCopy: true,
        legacyPointerCutover: true,
        eventRelationalPurge: true,
        exportDownloadPresign: false,
      },
    });
    // Worker tests are compiled with an explicit test-only live switch. The
    // checked-in artifact above is Candidate B, so ingress, copy, pointer
    // cutover, and relational purge are all on. The five historical signer and
    // download capabilities stay false in every schema-v2 mode.
    expect(() => assertWorkerIngressEnabled()).not.toThrow();
    expect(() => assertLegacyMediaCopyEnabled()).not.toThrow();
    expect(() => assertLegacyPointerCutoverEnabled()).not.toThrow();
    expect(() => assertEventRelationalPurgeEnabled()).not.toThrow();
  });

  it('keeps copy-only distinct from every pointer-mutating capability', () => {
    globalThis.__CANDIDARY_TEST_MEDIA_UPLOAD_RELEASE_OVERRIDE__ = 'copy-only';

    expect(() => assertLegacyMediaCopyEnabled()).not.toThrow();
    expect(() => assertWorkerIngressEnabled()).toThrow(/disabled/u);
    expect(() => assertLegacyPointerCutoverEnabled()).toThrow(/disabled/u);
    expect(() => assertEventRelationalPurgeEnabled()).toThrow(/disabled/u);
  });
});

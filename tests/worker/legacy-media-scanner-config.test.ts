import { describe, expect, it } from 'vitest';

import scannerConfig from '../../config/legacy-media-scanner.json';
import {
  legacyMediaScannerContract,
  validateLegacyMediaScannerContract,
} from '../../worker/legacy-media-scanner-contract';

describe('legacy media scanner release contract', () => {
  it('strictly consumes the checked-in permanent scanner invariants', () => {
    expect(legacyMediaScannerContract).toEqual(scannerConfig);
    expect(legacyMediaScannerContract).toMatchObject({
      enabled: true,
      bucketGeneration: 'legacy',
      binding: 'MEDIA_BUCKET',
      prefix: 'events/',
      namespaces: {
        guestMedia: { unowned: 'suppress-before-cursor' },
        exports: { unowned: 'suppress-before-cursor' },
        cover: {
          liveEvent: 'preserve-whole-namespace',
          absentOrDeletedEvent: 'suppress-before-cursor',
        },
      },
      retention: {
        tombstones: 'permanent',
        completedEpoch: 'wrap',
        absence: 'telemetry-only',
        cursorAdvance: 'after-durable-inventory',
        errors: 'rotate-without-retirement',
        runtimeModes: [
          'canonical-cutover-disabled',
          'canonical-copy-only',
          'canonical-live',
        ],
      },
      throughput: {
        scanPagesPerInvocation: 5,
        scanObjectsPerPage: 1000,
        tombstonesPerInvocation: 500,
        suppressedTombstoneQuota: 400,
        classificationTombstoneQuota: 100,
        expectedLegacyGrowthCeilingPerHour: 1000,
        fullEpochSlaHours: 24,
      },
    });
  });

  it('rejects capability drift and decorative extra keys', () => {
    expect(() => validateLegacyMediaScannerContract({
      ...scannerConfig,
      enabled: false,
    })).toThrow(/legacy media scanner contract/u);
    expect(() => validateLegacyMediaScannerContract({
      ...scannerConfig,
      decorative: true,
    })).toThrow(/legacy media scanner contract/u);
    expect(() => validateLegacyMediaScannerContract({
      ...scannerConfig,
      namespaces: {
        ...scannerConfig.namespaces,
        cover: {
          ...scannerConfig.namespaces.cover,
          liveEvent: 'delete',
        },
      },
    })).toThrow(/legacy media scanner contract/u);
  });
});

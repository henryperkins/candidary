// @vitest-environment node

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { canonicalJson, sha256 } from '../../scripts/release-evidence';
import {
  BRIDGE_DISABLED_CAPABILITIES,
  CANONICAL_COPY_ONLY_CAPABILITIES,
  CANONICAL_LIVE_CAPABILITIES,
  CANONICAL_MEDIA_BUCKET_NAME,
  CANONICAL_MEDIA_BINDING,
  CUTOVER_DISABLED_CAPABILITIES,
  LEGACY_MEDIA_BUCKET_NAME,
  LEGACY_MEDIA_BINDING,
  parseMediaUploadReleaseContract,
  parseMediaWriteBridgeRuntimeContract,
  verifyCanonicalMediaBucketProvisioningEvidence,
  verifyLegacyMediaScannerContract,
  verifyMediaUploadReleaseContract,
  type CanonicalMediaBucketProvisioningEvidenceV1,
} from '../../scripts/media-cutover-release-contract';

const ACCOUNT = 'f'.repeat(32);
const RUN_ID = '1000000a-0000-4000-8000-000000000001';
const TOKEN_ID = 'c580e42d532fea4f8cf3897a9c637346';
const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true });
  roots.clear();
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'candidary-media-cutover-contract-'));
  roots.add(root);
  return root;
}

function put(root: string, path: string, contents: string): string {
  const target = join(root, ...path.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, 'utf8');
  return target;
}

function writeCanonicalInput(path: string, value: unknown): string {
  const bytes = `${canonicalJson(value)}\n`;
  put(dirname(path), basename(path), bytes);
  const digest = sha256(bytes);
  put(dirname(path), `${basename(path)}.sha256`, `${digest}  ${basename(path)}\n`);
  return digest;
}

function bucketEvidence(): CanonicalMediaBucketProvisioningEvidenceV1 {
  return {
    kind: 'candidary.canonical-media-bucket-provisioning-evidence',
    schemaVersion: 1,
    status: 'ready',
    runId: RUN_ID,
    provider: 'cloudflare-r2',
    accountId: ACCOUNT,
    legacyBucket: {
      binding: LEGACY_MEDIA_BINDING,
      bucketName: LEGACY_MEDIA_BUCKET_NAME,
      r2SigningTokenId: TOKEN_ID,
    },
    canonicalBucket: {
      binding: CANONICAL_MEDIA_BINDING,
      bucketName: CANONICAL_MEDIA_BUCKET_NAME,
    },
    providerResponses: {
      bucketCreateReceiptSha256: '1'.repeat(64),
      bucketStatusObservationSha256: '2'.repeat(64),
      corsPolicyObservationSha256: '3'.repeat(64),
      publicAccessObservationSha256: '4'.repeat(64),
      initialEmptyBucketObservationSha256: '5'.repeat(64),
    },
    canonicalAccess: {
      publicAccess: 'disabled',
      developmentUrl: 'disabled',
      cors: 'none',
    },
    createdAt: '2026-08-13T11:00:00.000Z',
    observedAt: '2026-08-13T11:15:00.000Z',
    operator: 'storage-owner',
  };
}

describe('media upload release configs', () => {
  it('keeps the checked-in disabled config consumable by the release verifier', () => {
    expect(verifyMediaUploadReleaseContract(
      resolve('config/media-upload-release.json'),
      'canonical-cutover-disabled',
    ).artifact).toEqual({
      kind: 'candidary.media-upload-release',
      schemaVersion: 2,
      mode: 'canonical-cutover-disabled',
      capabilities: { ...CUTOVER_DISABLED_CAPABILITIES },
    });
  });

  it('accepts only the exact disabled, copy-only, and live schema-v2 contracts', () => {
    expect(parseMediaUploadReleaseContract({
      kind: 'candidary.media-upload-release',
      schemaVersion: 2,
      mode: 'canonical-copy-only',
      capabilities: { ...CANONICAL_COPY_ONLY_CAPABILITIES },
    })).toEqual({
      kind: 'candidary.media-upload-release',
      schemaVersion: 2,
      mode: 'canonical-copy-only',
      capabilities: { ...CANONICAL_COPY_ONLY_CAPABILITIES },
    });
    expect(parseMediaUploadReleaseContract({
      kind: 'candidary.media-upload-release',
      schemaVersion: 2,
      mode: 'canonical-cutover-disabled',
      capabilities: { ...CUTOVER_DISABLED_CAPABILITIES },
    })).toEqual({
      kind: 'candidary.media-upload-release',
      schemaVersion: 2,
      mode: 'canonical-cutover-disabled',
      capabilities: { ...CUTOVER_DISABLED_CAPABILITIES },
    });
    expect(parseMediaUploadReleaseContract({
      kind: 'candidary.media-upload-release',
      schemaVersion: 2,
      mode: 'canonical-live',
      capabilities: { ...CANONICAL_LIVE_CAPABILITIES },
    })).toEqual({
      kind: 'candidary.media-upload-release',
      schemaVersion: 2,
      mode: 'canonical-live',
      capabilities: { ...CANONICAL_LIVE_CAPABILITIES },
    });

    for (const mutate of [
      (value: Record<string, unknown>) => { value.schemaVersion = 1; },
      (value: Record<string, unknown>) => { value.mode = 'worker-ingress'; },
      (value: Record<string, unknown>) => { value.extra = true; },
      (value: Record<string, unknown>) => {
        (value.capabilities as Record<string, unknown>).authenticatedWorkerIngress = true;
      },
      (value: Record<string, unknown>) => {
        delete (value.capabilities as Record<string, unknown>).legacyMediaCopy;
      },
      (value: Record<string, unknown>) => {
        (value.capabilities as Record<string, unknown>).unexpectedCapability = false;
      },
    ]) {
      const value: Record<string, unknown> = {
        kind: 'candidary.media-upload-release',
        schemaVersion: 2,
        mode: 'canonical-cutover-disabled',
        capabilities: { ...CUTOVER_DISABLED_CAPABILITIES },
      };
      mutate(value);
      expect(() => parseMediaUploadReleaseContract(value)).toThrow(/media|contract|capabilit|mode|schema/iu);
    }
  });

  it('keeps the schema-v1 bridge contract at its exact eight false capabilities', () => {
    expect(parseMediaWriteBridgeRuntimeContract({
      kind: 'candidary.media-upload-release',
      schemaVersion: 1,
      mode: 'bridge-disabled',
      capabilities: { ...BRIDGE_DISABLED_CAPABILITIES },
    })).toEqual({
      kind: 'candidary.media-upload-release',
      schemaVersion: 1,
      mode: 'bridge-disabled',
      capabilities: { ...BRIDGE_DISABLED_CAPABILITIES },
    });

    expect(() => parseMediaWriteBridgeRuntimeContract({
      kind: 'candidary.media-upload-release',
      schemaVersion: 1,
      mode: 'bridge-disabled',
      capabilities: {
        ...BRIDGE_DISABLED_CAPABILITIES,
        legacyMediaCopy: false,
      },
    })).toThrow(/bridge|capabilit/iu);
  });

  it('binds exact canonical config bytes, not only equivalent parsed JSON', () => {
    const root = temporaryRoot();
    const path = put(root, 'media-upload-release.json', `${canonicalJson({
      kind: 'candidary.media-upload-release',
      schemaVersion: 2,
      mode: 'canonical-cutover-disabled',
      capabilities: { ...CUTOVER_DISABLED_CAPABILITIES },
    })}\n`);
    expect(verifyMediaUploadReleaseContract(path, 'canonical-cutover-disabled').sha256)
      .toBe(sha256(readFileSync(path)));

    const equivalentNoncanonical = `${JSON.stringify(JSON.parse(readFileSync(path, 'utf8')), null, 2)}\n`;
    writeFileSync(path, equivalentNoncanonical, 'utf8');
    expect(() => verifyMediaUploadReleaseContract(path, 'canonical-cutover-disabled'))
      .toThrow(/canonical/iu);
  });
});

describe('canonical bucket provisioning evidence', () => {
  it('requires exact isolated-bucket identity, empty proof, and old-signer denial proof', () => {
    const root = temporaryRoot();
    const path = resolve(root, 'canonical-media-bucket-provisioning-evidence.json');
    const evidence = bucketEvidence();
    const digest = writeCanonicalInput(path, evidence);
    expect(verifyCanonicalMediaBucketProvisioningEvidence(path)).toEqual({
      artifact: evidence,
      path,
      sha256: digest,
    });

    const mutations: Array<(value: Record<string, unknown>) => void> = [
      (value) => {
        (value.canonicalBucket as Record<string, unknown>).bucketName = LEGACY_MEDIA_BUCKET_NAME;
      },
      (value) => {
        (value.canonicalBucket as Record<string, unknown>).binding = LEGACY_MEDIA_BINDING;
      },
      (value) => {
        (value.canonicalAccess as Record<string, unknown>).publicAccess = 'enabled';
      },
      (value) => {
        (value.canonicalAccess as Record<string, unknown>).developmentUrl = 'enabled';
      },
      (value) => {
        (value.canonicalAccess as Record<string, unknown>).cors = 'permissive';
      },
      (value) => {
        delete (value.providerResponses as Record<string, unknown>).initialEmptyBucketObservationSha256;
      },
      (value) => { value.extra = true; },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(evidence) as unknown as Record<string, unknown>;
      mutate(changed);
      writeCanonicalInput(path, changed);
      expect(() => verifyCanonicalMediaBucketProvisioningEvidence(path)).toThrow();
    }

    const bytes = readFileSync(path, 'utf8').replace(/\n$/u, ' \n');
    writeFileSync(path, bytes, 'utf8');
    writeFileSync(`${path}.sha256`, `${sha256(bytes)}  ${basename(path)}\n`, 'utf8');
    expect(() => verifyCanonicalMediaBucketProvisioningEvidence(path)).toThrow(/canonical/iu);
  });
});

describe('permanent legacy media scanner contract', () => {
  it('keeps the checked-in scanner config consumable by the release verifier', () => {
    expect(verifyLegacyMediaScannerContract(
      resolve('config/legacy-media-scanner.json'),
    ).artifact).toMatchObject({
      kind: 'candidary.legacy-media-scanner',
      enabled: true,
      retention: {
        runtimeModes: [
          'canonical-cutover-disabled',
          'canonical-copy-only',
          'canonical-live',
        ],
      },
    });
  });

  it('requires exact runtime-consumed guest, export, cover, cursor, and permanence invariants', () => {
    const root = temporaryRoot();
    const path = resolve(root, 'legacy-media-scanner.json');
    const contract = {
      kind: 'candidary.legacy-media-scanner',
      schemaVersion: 1,
      enabled: true,
      bucketGeneration: 'legacy',
      binding: 'MEDIA_BUCKET',
      prefix: 'events/',
      namespaces: {
        guestMedia: {
          segments: ['uploads', 'media', 'previews'],
          unowned: 'suppress-before-cursor',
        },
        exports: {
          segment: 'exports',
          owned: [
            'queued-current-attempt',
            'running-current-attempt',
            'ready-unexpired-exact-inventory',
          ],
          unowned: 'suppress-before-cursor',
        },
        cover: {
          segment: 'cover',
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
    };
    writeCanonicalInput(path, contract);
    const verified = verifyLegacyMediaScannerContract(path);
    expect(verified.sha256).toBe(sha256(readFileSync(path)));

    const mutations: Array<(value: Record<string, unknown>) => void> = [
      (value) => { value.enabled = false; },
      (value) => {
        ((value.namespaces as Record<string, unknown>).cover as Record<string, unknown>)
          .liveEvent = 'row-inventory-only';
      },
      (value) => {
        ((value.namespaces as Record<string, unknown>).exports as Record<string, unknown>)
          .owned = ['ready-unexpired-exact-inventory'];
      },
      (value) => {
        ((value.retention as Record<string, unknown>).cursorAdvance) = 'before-inventory';
      },
      (value) => {
        ((value.retention as Record<string, unknown>).runtimeModes as unknown[]).pop();
      },
      (value) => {
        (value.throughput as Record<string, unknown>).scanPagesPerInvocation = 1;
      },
      (value) => {
        (value.throughput as Record<string, unknown>).fullEpochSlaHours = 48;
      },
      (value) => { value.extra = true; },
    ];
    const original = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    for (const mutate of mutations) {
      const changed = structuredClone(original);
      mutate(changed);
      writeCanonicalInput(path, changed);
      expect(() => verifyLegacyMediaScannerContract(path)).toThrow(/legacy|scanner|contract/iu);
    }
  });
});

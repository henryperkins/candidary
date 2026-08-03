import { describe, expect, it } from 'vitest';

import { parseRuntimeReleaseIdentity } from '../../shared/release';
import { createApp } from '../../worker/app';
import { resolveRuntimeReleaseIdentity } from '../../worker/release-identity';

const BUILD_SHA = '0123456789abcdef0123456789abcdef01234567';
const MIGRATION_SHA = 'a'.repeat(64);

describe('runtime release identity', () => {
  // Production break caught: request initialization omits identity or resolves version metadata more than once.
  it('normalizes release identity once during request initialization', async () => {
    let metadataReads = 0;
    const metadata: WorkerVersionMetadata = {
      get id() {
        metadataReads += 1;
        return 'worker-version-1';
      },
      get tag() {
        metadataReads += 1;
        return BUILD_SHA;
      },
      timestamp: '2026-08-03T00:00:00.000Z',
    };
    const app = createApp();
    app.get('/__test/release-identity', (context) => context.json(context.get('releaseIdentity')));

    const response = await app.request(
      'http://candidary.test/__test/release-identity',
      {},
      { CF_VERSION_METADATA: metadata } as Cloudflare.Env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      buildSha: BUILD_SHA,
      workerVersionId: 'worker-version-1',
      guestJourneyVersion: 1,
      migrationManifestSha256: MIGRATION_SHA,
    });
    expect(metadataReads).toBe(2);
  });

  // Production break caught: matching immutable build and Worker Version Metadata cannot form runtime identity.
  it('resolves matching injected literals and version metadata', () => {
    expect(resolveRuntimeReleaseIdentity({
      CF_VERSION_METADATA: {
        id: 'worker-version-1',
        tag: BUILD_SHA,
        timestamp: '2026-08-03T00:00:00.000Z',
      },
    })).toEqual({
      buildSha: BUILD_SHA,
      workerVersionId: 'worker-version-1',
      guestJourneyVersion: 1,
      migrationManifestSha256: MIGRATION_SHA,
    });
  });

  // Production break caught: absent or nonmatching deployment metadata is treated as certified identity.
  it.each([
    ['missing binding', {}],
    ['empty ID', {
      CF_VERSION_METADATA: { id: '', tag: BUILD_SHA, timestamp: '2026-08-03T00:00:00.000Z' },
    }],
    ['empty tag', {
      CF_VERSION_METADATA: { id: 'worker-version-1', tag: '', timestamp: '2026-08-03T00:00:00.000Z' },
    }],
    ['mismatched tag', {
      CF_VERSION_METADATA: {
        id: 'worker-version-1',
        tag: 'fedcba9876543210fedcba9876543210fedcba98',
        timestamp: '2026-08-03T00:00:00.000Z',
      },
    }],
  ] as const)('returns null for %s', (_label, env) => {
    expect(resolveRuntimeReleaseIdentity(env)).toBeNull();
  });

  // Production break caught: malformed build-time literals survive the strict parser used by the Worker adapter.
  it.each([
    ['uppercase SHA', { buildSha: BUILD_SHA.toUpperCase(), migrationManifestSha256: MIGRATION_SHA }],
    ['malformed migration digest', { buildSha: BUILD_SHA, migrationManifestSha256: 'a'.repeat(63) }],
  ])('returns null for an injected %s', (_label, injected) => {
    expect(parseRuntimeReleaseIdentity({
      ...injected,
      workerVersionId: 'worker-version-1',
      workerVersionTag: injected.buildSha,
    })).toBeNull();
  });
});

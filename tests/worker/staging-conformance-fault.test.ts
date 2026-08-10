import { describe, expect, it, vi } from 'vitest';

import { STAGING_ORIGIN } from '../../shared/staging-conformance';
import type { AppEnv } from '../../worker/env';
import {
  consumeStagingFailOnce,
  stagingFaultMarkerKey,
} from '../../worker/workflows/staging-conformance-fault';
import type { CoverBackfillPayload } from '../../worker/workflows/cover-backfill';
import { testEnv } from './helpers';

const payload: CoverBackfillPayload = {
  runId: '1000000a-0000-4000-8000-000000000001',
  jobId: '1000000a-0000-4000-8000-000000000002',
  eventId: '1000000a-0000-4000-8000-000000000003',
};

function env(origin: string): AppEnv {
  return new Proxy(testEnv, {
    get(target, property, receiver) {
      if (property === 'APP_ORIGIN') return origin;
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

describe('staging Workflow fail-once control', () => {
  it('does not touch R2 outside the exact staging origin', async () => {
    const get = vi.fn(async () => { throw new Error('must not be called'); });
    const productionEnv = new Proxy(testEnv, {
      get(target, property, receiver) {
        if (property === 'APP_ORIGIN') return 'https://candidary.app';
        if (property === 'MEDIA_BUCKET') return { get };
        return Reflect.get(target, property, receiver) as unknown;
      },
    }) as AppEnv;
    await expect(consumeStagingFailOnce(productionEnv, payload, 'normalize')).resolves.toBe(false);
    expect(get).not.toHaveBeenCalled();
  });

  it('conditionally consumes one marker, throws once, then removes the tombstone', async () => {
    const stagingEnv = env(STAGING_ORIGIN);
    const key = await stagingFaultMarkerKey(payload, 'normalize');
    await testEnv.MEDIA_BUCKET.put(key, 'armed-v1', {
      httpMetadata: { contentType: 'text/plain' },
    });

    await expect(consumeStagingFailOnce(stagingEnv, payload, 'normalize'))
      .rejects.toThrow('STAGING_CONFORMANCE_FAIL_ONCE');
    expect(await (await testEnv.MEDIA_BUCKET.get(key))?.text()).toBe('consumed-v1');

    await expect(consumeStagingFailOnce(stagingEnv, payload, 'normalize')).resolves.toBe(false);
    expect(await testEnv.MEDIA_BUCKET.head(key)).toBeNull();
  });

  it('fails closed for foreign steps, malformed payloads, and unexpected marker bytes', async () => {
    const stagingEnv = env(STAGING_ORIGIN);
    await expect(consumeStagingFailOnce(stagingEnv, payload, 'profile' as 'normalize'))
      .rejects.toThrow('STAGING_CONFORMANCE_FAULT_INPUT_INVALID');
    await expect(consumeStagingFailOnce(stagingEnv, { ...payload, runId: 'foreign' }, 'normalize'))
      .rejects.toThrow('STAGING_CONFORMANCE_FAULT_INPUT_INVALID');

    const key = await stagingFaultMarkerKey(payload, 'normalize');
    await testEnv.MEDIA_BUCKET.put(key, 'unexpected private bytes');
    await expect(consumeStagingFailOnce(stagingEnv, payload, 'normalize'))
      .rejects.toThrow('STAGING_CONFORMANCE_FAULT_MARKER_INVALID');
    await testEnv.MEDIA_BUCKET.delete(key);
  });
});

import { describe, expect, it } from 'vitest';

import {
  STAGING_RPC_METHODS,
  buildStagingCallerConfig,
  parseRpcEnvelope,
} from '../../scripts/staging-release-rpc';

const RUN_ID = '12345678-1234-4123-8123-123456789abc';

describe('Task 11 local RPC caller', () => {
  it('binds only the route-less staging entrypoint through one remote service', () => {
    expect(buildStagingCallerConfig(RUN_ID)).toEqual({
      name: 'candidary-staging-conformance-caller-12345678',
      main: 'staging-caller.js',
      compatibility_date: '2026-07-21',
      compatibility_flags: ['nodejs_compat'],
      workers_dev: false,
      preview_urls: false,
      dev: { ip: '127.0.0.1', local_protocol: 'http' },
      services: [{
        binding: 'STAGING',
        service: 'candidary-staging-conformance',
        entrypoint: 'StagingConformanceEntrypoint',
        remote: true,
      }],
    });
  });

  it('parses only closed successful envelopes and refuses foreign methods', () => {
    expect(STAGING_RPC_METHODS).toContain('runtimeIdentity');
    expect(parseRpcEnvelope({ ok: true, result: { status: 'complete' } }, 'runtimeIdentity'))
      .toEqual({ status: 'complete' });
    expect(() => parseRpcEnvelope({ ok: false, code: 'RPC_FAILED' }, 'runtimeIdentity'))
      .toThrow(/RPC_FAILED/u);
    expect(() => parseRpcEnvelope({ ok: true, result: null }, 'deleteEverything' as never))
      .toThrow(/method/u);
  });
});

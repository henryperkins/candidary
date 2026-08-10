// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import {
  fingerprintWorkflowError,
  qualifyMissingFingerprint,
  type WorkflowErrorFingerprint,
} from '../../shared/staging-workflow-fingerprint';
import {
  buildProbeCallerConfig,
  buildProbeWranglerConfig,
  runProbeDiscovery,
  type ProbeDiscoveryAdapter,
} from '../../scripts/staging-release-probe';
import { STAGING_TARGET } from '../../scripts/staging-release-contract';

const absent = (): WorkflowErrorFingerprint => ({
  constructorFamily: 'Error',
  name: 'Error',
  codeFields: [{ field: 'code', value: 10091 }],
  ownKeys: ['code', 'instanceId', 'internal'],
});

describe('Workflow missing-instance fingerprinting', () => {
  it('never retains messages, stacks, identifiers, URLs, causes, or unknown scalar values', () => {
    const error = Object.assign(new Error('instance abc at https://example.invalid/private'), {
      code: 10091,
      instanceId: 'abc',
      internal: 'secret',
      statusCode: 'NOT_FOUND',
      cause: new Error('private cause'),
    });
    expect(fingerprintWorkflowError(error)).toEqual({
      constructorFamily: 'Error',
      name: 'Error',
      codeFields: [
        { field: 'code', value: 10091 },
        { field: 'statusCode', value: 'NOT_FOUND' },
      ],
      ownKeys: ['cause', 'code', 'instanceId', 'internal', 'statusCode'],
    });
    expect(JSON.stringify(fingerprintWorkflowError(error))).not.toMatch(/abc|example|private|secret/u);
  });

  it('qualifies one code-like value stable across absent IDs and distinct elsewhere', () => {
    const result = qualifyMissingFingerprint({
      absent: [absent(), absent(), absent()],
      invalid: [{
        constructorFamily: 'Error', name: 'Error',
        codeFields: [{ field: 'code', value: 10090 }], ownKeys: ['code'],
      }],
      synthetic: [{
        constructorFamily: 'Error', name: 'Error', codeFields: [], ownKeys: [],
      }],
    });
    expect(result).toEqual({ field: 'code', value: 10091 });
  });

  it('refuses unstable, shared, or multiply qualifying code-like properties', () => {
    expect(() => qualifyMissingFingerprint({
      absent: [absent(), { ...absent(), codeFields: [{ field: 'code', value: 10092 }] }, absent()],
      invalid: [], synthetic: [],
    })).toThrow(/stable discriminator/u);
    expect(() => qualifyMissingFingerprint({
      absent: [absent(), absent(), absent()],
      invalid: [absent()], synthetic: [],
    })).toThrow(/stable discriminator/u);
    const two = (): WorkflowErrorFingerprint => ({
      ...absent(),
      codeFields: [
        { field: 'code', value: 10091 },
        { field: 'statusCode', value: 'NOT_FOUND' },
      ],
    });
    expect(() => qualifyMissingFingerprint({
      absent: [two(), two(), two()], invalid: [], synthetic: [],
    })).toThrow(/exactly one/u);
  });
});

describe('route-disabled discovery probe', () => {
  it('binds only the isolated Workflow and exposes no public or unrelated binding', () => {
    expect(buildProbeWranglerConfig()).toEqual({
      name: 'candidary-staging-workflow-probe',
      main: 'worker/staging-workflow-probe.ts',
      compatibility_date: '2026-07-21',
      compatibility_flags: ['nodejs_compat'],
      workers_dev: false,
      preview_urls: false,
      workflows: [{
        name: STAGING_TARGET.workflows.backfill,
        binding: 'COVER_BACKFILL_WORKFLOW',
        class_name: 'CoverBackfillWorkflow',
      }],
    });
    const caller = buildProbeCallerConfig();
    expect(caller).toMatchObject({
      name: 'candidary-staging-workflow-probe-caller',
      main: 'probe-caller.ts',
      dev: { ip: '127.0.0.1', local_protocol: 'http' },
      services: [{
        binding: 'PROBE',
        service: 'candidary-staging-workflow-probe',
        entrypoint: 'StagingWorkflowProbe',
        remote: true,
      }],
    });
    expect(JSON.stringify(caller)).not.toMatch(/routes|custom_domain|workflows/u);
  });

  it('always destroys the probe and proves absence', async () => {
    const calls: string[] = [];
    const adapter: ProbeDiscoveryAdapter = {
      async deploy() { calls.push('deploy'); },
      async sample() {
        calls.push('sample');
        return { absent: [absent(), absent(), absent()], invalid: [], synthetic: [] };
      },
      async destroy() { calls.push('destroy'); },
      async observeAbsent() { calls.push('absent'); return true; },
    };
    await expect(runProbeDiscovery(adapter)).resolves.toEqual({
      discriminator: { field: 'code', value: 10091 }, probeAbsent: true,
    });
    expect(calls).toEqual(['deploy', 'sample', 'destroy', 'absent']);

    const failing = { ...adapter, sample: vi.fn(async () => { throw new Error('sampling failed'); }) };
    calls.length = 0;
    await expect(runProbeDiscovery(failing)).rejects.toThrow(/sampling failed/u);
    expect(calls).toEqual(['deploy', 'destroy', 'absent']);
  });

  it('fails closed if probe absence cannot be proved', async () => {
    const adapter: ProbeDiscoveryAdapter = {
      async deploy() {},
      async sample() { return { absent: [absent(), absent(), absent()], invalid: [], synthetic: [] }; },
      async destroy() {},
      async observeAbsent() { return false; },
    };
    await expect(runProbeDiscovery(adapter)).rejects.toThrow(/absence/u);
  });
});

import {
  WorkflowFingerprintQualificationError,
  qualifyMissingFingerprint,
  type CertifiedWorkflowMissingDiscriminator,
  type WorkflowProbeSamples,
} from '../shared/staging-workflow-fingerprint.ts';
import { STAGING_TARGET } from './staging-release-contract.ts';

export const PROBE_WORKER_NAME = 'candidary-staging-workflow-probe' as const;
export const PROBE_CALLER_NAME = 'candidary-staging-workflow-probe-caller' as const;

export function buildProbeWranglerConfig(): Record<string, unknown> {
  return {
    name: PROBE_WORKER_NAME,
    main: 'worker/staging-workflow-probe.ts',
    compatibility_date: '2026-07-21',
    compatibility_flags: ['nodejs_compat'],
    workers_dev: false,
    preview_urls: false,
    workflows: [{
      name: STAGING_TARGET.workflows.backfill,
      binding: 'COVER_BACKFILL_WORKFLOW',
      class_name: 'CoverBackfillWorkflow',
      script_name: STAGING_TARGET.workerName,
    }],
  };
}

export function buildProbeCallerConfig(): Record<string, unknown> {
  return {
    name: PROBE_CALLER_NAME,
    main: 'probe-caller.ts',
    compatibility_date: '2026-07-21',
    compatibility_flags: ['nodejs_compat'],
    workers_dev: false,
    preview_urls: false,
    dev: { ip: '127.0.0.1', local_protocol: 'http' },
    services: [{
      binding: 'PROBE',
      service: PROBE_WORKER_NAME,
      entrypoint: 'StagingWorkflowProbe',
      remote: true,
    }],
  };
}

export const PROBE_CALLER_SOURCE = `
interface Env {
  PROBE: { sample(instanceId: string): Promise<unknown> };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/sample') {
      return new Response(null, { status: 404 });
    }
    const body = await request.json() as { instanceId?: unknown };
    if (typeof body.instanceId !== 'string') return new Response(null, { status: 400 });
    const result = await env.PROBE.sample(body.instanceId);
    return Response.json(result);
  },
};
`.trimStart();

export interface ProbeDiscoveryAdapter {
  readonly deploy: () => Promise<void>;
  readonly sample: () => Promise<WorkflowProbeSamples>;
  readonly destroy: () => Promise<void>;
  readonly observeAbsent: () => Promise<boolean>;
}

export interface ProbeDiscoveryResult {
  readonly status: 'passed';
  readonly discriminator: CertifiedWorkflowMissingDiscriminator;
  readonly probeAbsent: true;
}

export interface ProbeDiscoveryFallbackResult {
  readonly status: 'passed';
  readonly recovery: 'idempotent-create-batch';
  readonly discriminator: null;
  readonly observationCode:
    | 'no-distinct-workflow-missing-discriminator'
    | 'ambiguous-workflow-missing-discriminator';
  readonly probeAbsent: true;
}

export async function runProbeDiscovery(
  adapter: ProbeDiscoveryAdapter,
): Promise<ProbeDiscoveryResult | ProbeDiscoveryFallbackResult> {
  let primaryFailure: unknown;
  let discriminator: CertifiedWorkflowMissingDiscriminator | null = null;
  let fallbackCode: ProbeDiscoveryFallbackResult['observationCode'] | null = null;
  try {
    await adapter.deploy();
    try {
      discriminator = qualifyMissingFingerprint(await adapter.sample());
    } catch (error) {
      if (!(error instanceof WorkflowFingerprintQualificationError)) throw error;
      fallbackCode = error.blockerCode === 'NO_DISTINCT_WORKFLOW_MISSING_DISCRIMINATOR'
        ? 'no-distinct-workflow-missing-discriminator'
        : 'ambiguous-workflow-missing-discriminator';
    }
  } catch (error) {
    primaryFailure = error;
  }

  let cleanupFailure: unknown;
  try {
    await adapter.destroy();
    if (!await adapter.observeAbsent()) {
      throw new Error('Probe absence could not be proved after cleanup.');
    }
  } catch (error) {
    cleanupFailure = error;
  }

  if (primaryFailure !== undefined && cleanupFailure !== undefined) {
    throw new AggregateError([primaryFailure, cleanupFailure], 'Probe failed and cleanup absence was not proved.');
  }
  if (cleanupFailure !== undefined) throw cleanupFailure;
  if (primaryFailure !== undefined) throw primaryFailure;
  if (fallbackCode !== null) {
    return {
      status: 'passed', recovery: 'idempotent-create-batch', discriminator: null,
      observationCode: fallbackCode, probeAbsent: true,
    };
  }
  if (discriminator === null) throw new Error('Probe produced no discriminator.');
  return { status: 'passed', discriminator, probeAbsent: true };
}

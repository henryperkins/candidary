import { STAGING_TARGET, assertCanonicalRunId } from './staging-release-contract.ts';

export const STAGING_RPC_METHODS = [
  'runtimeIdentity',
  'inspectImageCase',
  'normalizeImageCase',
  'renderPreviewCase',
  'renderProfileCase',
  'workflowLookup',
  'workflowControl',
  'createBackfillBatch',
  'pauseBackfill',
  'resumeBackfill',
  'restartBackfill',
  'terminateBackfill',
  'runScheduledCleanup',
  'emptyStagingBucket',
  'readConformanceSummary',
] as const;

export type StagingRpcMethod = typeof STAGING_RPC_METHODS[number];

export function stagingCallerName(runId: string): string {
  return `candidary-staging-conformance-caller-${assertCanonicalRunId(runId).slice(0, 8)}`;
}

export function buildStagingCallerConfig(runId: string): Record<string, unknown> {
  return {
    name: stagingCallerName(runId),
    main: 'staging-caller.js',
    compatibility_date: '2026-07-21',
    compatibility_flags: ['nodejs_compat'],
    workers_dev: false,
    preview_urls: false,
    dev: { ip: '127.0.0.1', local_protocol: 'http' },
    services: [{
      binding: 'STAGING',
      service: STAGING_TARGET.workerName,
      entrypoint: 'StagingConformanceEntrypoint',
      remote: true,
    }],
  };
}

export const STAGING_CALLER_SOURCE = `
const METHODS = new Set(${JSON.stringify(STAGING_RPC_METHODS)});

export default {
  async fetch(request, env) {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/rpc') {
      return new Response(null, { status: 404 });
    }
    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ ok: false, code: 'RPC_INPUT_INVALID' }, { status: 400 });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).sort().join(',') !== 'input,method'
      || typeof body.method !== 'string' || !METHODS.has(body.method)
      || !body.input || typeof body.input !== 'object' || Array.isArray(body.input)) {
      return Response.json({ ok: false, code: 'RPC_INPUT_INVALID' }, { status: 400 });
    }
    try {
      const result = await env.STAGING[body.method](body.input);
      return Response.json({ ok: true, result });
    } catch {
      return Response.json({ ok: false, code: 'RPC_REMOTE_FAILED' }, { status: 502 });
    }
  },
};
`.trimStart();

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Task 11 RPC envelope is invalid.');
  }
  return value as Record<string, unknown>;
}

export function parseRpcEnvelope(value: unknown, method: StagingRpcMethod): unknown {
  if (!STAGING_RPC_METHODS.includes(method)) throw new Error('Task 11 RPC method is unknown.');
  const envelope = record(value);
  if (envelope.ok === true) {
    const keys = Object.keys(envelope).sort();
    if (keys.length !== 2 || keys[0] !== 'ok' || keys[1] !== 'result') {
      throw new Error('Task 11 RPC success envelope is invalid.');
    }
    return envelope.result;
  }
  if (envelope.ok === false && typeof envelope.code === 'string'
    && /^[A-Z][A-Z0-9_]{0,63}$/u.test(envelope.code)) {
    throw new Error(envelope.code);
  }
  throw new Error('Task 11 RPC envelope is invalid.');
}

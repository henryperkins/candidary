import { STAGING_ORIGIN, assertConformanceRunId } from '../../shared/staging-conformance';
import type { AppEnv } from '../env';
import { coverBackfillInstanceId, type CoverBackfillPayload } from './cover-backfill';

export const STAGING_FAULT_STEPS = ['normalize'] as const;
export type StagingFaultStep = typeof STAGING_FAULT_STEPS[number];

function assertPayload(payload: CoverBackfillPayload): CoverBackfillPayload {
  try {
    assertConformanceRunId(payload.runId);
    assertConformanceRunId(payload.jobId);
    assertConformanceRunId(payload.eventId);
  } catch {
    throw new Error('STAGING_CONFORMANCE_FAULT_INPUT_INVALID');
  }
  return payload;
}

function assertStep(value: unknown): StagingFaultStep {
  if (value !== 'normalize') throw new Error('STAGING_CONFORMANCE_FAULT_INPUT_INVALID');
  return value;
}

export async function stagingFaultMarkerKey(
  payloadInput: CoverBackfillPayload,
  stepInput: StagingFaultStep,
): Promise<string> {
  const payload = assertPayload(payloadInput);
  const step = assertStep(stepInput);
  const instanceId = await coverBackfillInstanceId(payload.runId, payload.jobId, payload.eventId);
  return `conformance/${payload.runId}/faults/${instanceId}/${step}`;
}

function fixedFailure(error: unknown): never {
  if (error instanceof Error && error.message.startsWith('STAGING_CONFORMANCE_')) throw error;
  throw new Error('STAGING_CONFORMANCE_FAULT_STORAGE_FAILED');
}

export async function consumeStagingFailOnce(
  env: AppEnv,
  payloadInput: CoverBackfillPayload,
  stepInput: StagingFaultStep,
): Promise<boolean> {
  if (String(env.APP_ORIGIN) !== STAGING_ORIGIN) return false;
  const key = await stagingFaultMarkerKey(payloadInput, stepInput);
  try {
    const marker = await env.MEDIA_BUCKET.get(key);
    if (!marker?.body) return false;
    const state = await marker.text();
    if (state === 'consumed-v1') {
      await env.MEDIA_BUCKET.delete(key);
      if (await env.MEDIA_BUCKET.head(key)) {
        throw new Error('STAGING_CONFORMANCE_FAULT_MARKER_INVALID');
      }
      return false;
    }
    if (state !== 'armed-v1') {
      throw new Error('STAGING_CONFORMANCE_FAULT_MARKER_INVALID');
    }
    const consumed = await env.MEDIA_BUCKET.put(key, 'consumed-v1', {
      onlyIf: { etagMatches: marker.etag },
      httpMetadata: { contentType: 'text/plain' },
    });
    if (consumed === null) return false;
    console.warn(JSON.stringify({
      event: 'staging_conformance_fail_once',
      step: assertStep(stepInput),
    }));
    throw new Error('STAGING_CONFORMANCE_FAIL_ONCE');
  } catch (error) {
    fixedFailure(error);
  }
}

export const STAGING_ORIGIN = 'https://staging.candidary.invalid' as const;
export const CONFORMANCE_CASE_ID_PATTERN = /^[a-z][a-z0-9-]{0,47}$/u;
export const CONFORMANCE_RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function assertConformanceRunId(value: unknown): string {
  if (typeof value !== 'string' || !CONFORMANCE_RUN_ID_PATTERN.test(value)) {
    throw new Error('STAGING_CONFORMANCE_INPUT_INVALID');
  }
  return value;
}

export function assertConformanceCaseId(value: unknown): string {
  if (typeof value !== 'string' || !CONFORMANCE_CASE_ID_PATTERN.test(value)) {
    throw new Error('STAGING_CONFORMANCE_INPUT_INVALID');
  }
  return value;
}

function digestHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function conformanceUuid(
  runId: string,
  caseId: string,
  kind: string,
  index = 0,
): Promise<string> {
  const canonicalRunId = assertConformanceRunId(runId);
  const canonicalCaseId = assertConformanceCaseId(caseId);
  if (!/^[a-z][a-z0-9-]{0,31}$/u.test(kind)
    || !Number.isSafeInteger(index) || index < 0 || index > 99) {
    throw new Error('STAGING_CONFORMANCE_INPUT_INVALID');
  }
  const input = new TextEncoder().encode(
    `candidary-task-11:${canonicalRunId}:${canonicalCaseId}:${kind}:${index}`,
  );
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digestHex(digest.buffer).slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function physicalConformancePrefix(runId: string): string {
  return `conformance/${assertConformanceRunId(runId)}/`;
}

async function coverBackfillInstanceId(runId: string, jobId: string, eventId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`cover-backfill-v1|${runId}|${jobId}|${eventId}`),
  );
  return `cb1-${digestHex(digest).slice(0, 48)}`;
}

export interface ConformanceBackfillIdentity {
  readonly runId: string;
  readonly jobId: string;
  readonly eventId: string;
  readonly instanceId: string;
}

export async function conformanceBackfillIdentity(
  rootRunId: string,
  caseId: string,
  index = 0,
): Promise<ConformanceBackfillIdentity> {
  const runId = await conformanceUuid(rootRunId, caseId, 'run', index);
  const jobId = await conformanceUuid(rootRunId, caseId, 'job', index);
  const eventId = await conformanceUuid(rootRunId, caseId, 'event', index);
  return {
    runId,
    jobId,
    eventId,
    instanceId: await coverBackfillInstanceId(runId, jobId, eventId),
  };
}

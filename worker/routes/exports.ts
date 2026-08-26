import { Hono, type Context } from 'hono';
import { z } from 'zod';

import { normalizeManagerExportErrorCode } from '../../shared/contracts';
import { ApiError } from '../../shared/errors';
import { requireManager } from '../auth/manager';
import { ExportsRepository } from '../db/exports';
import type { ExportRecord } from '../db/types';
import type { AppBindings, AppEnv } from '../env';

function manager(context: Context<AppBindings>, write = false) {
  return requireManager(context, { write });
}

async function ownedJob(context: Context<AppBindings>) {
  const job = await new ExportsRepository(context.env.DB).getById(context.req.param('jobId')!);
  if (!job || job.eventId !== context.req.param('eventId')) throw new ApiError('RESOURCE_FORBIDDEN', 'This export belongs to a different event.', 403);
  return job;
}

function managerExport(job: ExportRecord) {
  return {
    id: job.id,
    kind: job.kind,
    state: job.state,
    snapshotAt: job.snapshotAt,
    createdAt: job.createdAt,
    startedAt: job.executionProtocol === 'attempt-v2'
      ? job.executionStartedAt
      : job.startedAt,
    completedAt: job.completedAt,
    mediaCount: job.mediaCount,
    totalBytes: job.totalBytes,
    processedMediaCount: job.processedMediaCount,
    processedBytes: job.processedBytes,
    progressUpdatedAt: job.progressUpdatedAt,
    attempt: job.attempt,
    partCount: job.partCount,
    expiresAt: job.expiresAt,
    guestbookEntryCount: job.guestbookEntryCount,
    guestbookSharedCount: job.guestbookSharedCount,
    guestbookEventName: job.guestbookEventName,
    guestbookEventDate: job.guestbookEventDate,
    guestbookEventTimezone: job.guestbookEventTimezone,
    guestbookPrompt: job.guestbookPrompt,
    guestbookGalleryVisible: job.guestbookGalleryVisible,
    errorCode: normalizeManagerExportErrorCode(job.errorCode),
  };
}

function albumGuestbookSnapshotEmpty(job: ExportRecord): boolean {
  return job.guestbookEntryCount === null
    && job.guestbookSharedCount === null
    && job.guestbookEventName === null
    && job.guestbookEventDate === null
    && job.guestbookEventTimezone === null
    && job.guestbookPrompt === null
    && job.guestbookGalleryVisible === null;
}

async function commitOrRecoverRetry(
  repository: ExportsRepository,
  current: Awaited<ReturnType<typeof ownedJob>>,
) {
  try {
    return await repository.retry(current.id);
  } catch (error) {
    const committed = await repository.getById(current.id);
    if (committed?.state === 'queued'
      && committed.attempt === current.attempt + 1
      && committed.executionProtocol === 'attempt-v2'
      && committed.executionTransition === current.executionTransition + 1
      && committed.executionStartedAt === null
      && committed.processedMediaCount === null
      && committed.processedBytes === null
      && committed.progressUpdatedAt === null
      && committed.eventId === current.eventId
      && committed.kind === current.kind
      && committed.albumEntriesJson === current.albumEntriesJson
      && committed.snapshotAt === current.snapshotAt
      && committed.mediaCount === current.mediaCount
      && committed.totalBytes === current.totalBytes
      && committed.createdAt === current.createdAt
      && committed.guestbookEntryCount === current.guestbookEntryCount
      && committed.guestbookSharedCount === current.guestbookSharedCount
      && committed.guestbookEventName === current.guestbookEventName
      && committed.guestbookEventDate === current.guestbookEventDate
      && committed.guestbookEventTimezone === current.guestbookEventTimezone
      && committed.guestbookPrompt === current.guestbookPrompt
      && committed.guestbookGalleryVisible === current.guestbookGalleryVisible
      && committed.objectKey === null
      && committed.manifestObjectKey === null
      && committed.partCount === 0
      && committed.guestbookHtmlObjectKey === null
      && committed.guestbookHtmlBytes === null
      && committed.guestbookHtmlSha256 === null
      && committed.guestbookCsvObjectKey === null
      && committed.guestbookCsvBytes === null
      && committed.guestbookCsvSha256 === null
      && committed.errorCode === null
      && committed.startedAt === null
      && committed.completedAt === null
      && committed.expiresAt === null
      && (await repository.listParts(committed.id)).length === 0) {
      return committed;
    }
    throw error;
  }
}

function isRecoverableQueuedRetry(
  job: Awaited<ReturnType<typeof ownedJob>>,
): boolean {
  return job.state === 'queued'
    && job.attempt > 1
    && job.executionProtocol === 'attempt-v2'
    && Number.isSafeInteger(job.executionTransition)
    && job.executionTransition > 0
    && job.objectKey === null
    && job.manifestObjectKey === null
    && job.partCount === 0
    && job.startedAt === null
    && job.executionStartedAt === null
    && job.processedMediaCount === null
    && job.processedBytes === null
    && job.progressUpdatedAt === null
    && job.errorCode === null
    && job.completedAt === null
    && job.expiresAt === null;
}

async function observedWorkflowDispatch(
  workflow: AppEnv['EXPORT_WORKFLOW'],
  id: string,
): Promise<'dispatched' | 'failed' | 'unknown'> {
  const observed = await (await workflow.get(id)).status();
  if (observed.status === 'errored'
    || observed.status === 'terminated'
    || observed.status === 'complete') {
    return 'failed';
  }
  return observed.status === 'unknown' ? 'unknown' : 'dispatched';
}

async function dispatchWorkflowBatch(
  workflow: AppEnv['EXPORT_WORKFLOW'],
  id: string,
  input: Parameters<AppEnv['EXPORT_WORKFLOW']['createBatch']>[0],
): Promise<'dispatched' | 'failed' | 'unknown'> {
  const created = await workflow.createBatch(input);
  if (created.length > 0) return 'dispatched';
  return observedWorkflowDispatch(workflow, id);
}

async function ensureRetryWorkflow(
  workflow: AppEnv['EXPORT_WORKFLOW'],
  job: Awaited<ReturnType<typeof ownedJob>>,
): Promise<'dispatched' | 'failed'> {
  const id = `${job.id}-${job.attempt}`;
  try {
    const dispatch = await dispatchWorkflowBatch(workflow, id, [{
      id,
      params: { jobId: job.id, attempt: job.attempt },
    }]);
    if (dispatch !== 'unknown') return dispatch;
  } catch (error) {
    try {
      const observed = await observedWorkflowDispatch(workflow, id);
      if (observed !== 'unknown') return observed;
    } catch {
      // The original creation failure remains authoritative when existence
      // cannot be observed. A later request can safely retry the same ID.
    }
    throw error;
  }
  throw new Error(`Retained retry Workflow ${id} has unknown status.`);
}

async function ensureInitialWorkflow(
  workflow: AppEnv['EXPORT_WORKFLOW'],
  job: Awaited<ReturnType<typeof ownedJob>>,
): Promise<'dispatched' | 'failed'> {
  const input = [{
    id: job.id,
    params: { jobId: job.id, attempt: job.attempt },
  }];
  try {
    const dispatch = await dispatchWorkflowBatch(workflow, job.id, input);
    return dispatch === 'unknown' ? 'dispatched' : dispatch;
  } catch {
    try {
      const observed = await observedWorkflowDispatch(workflow, job.id);
      if (observed === 'failed') return 'failed';
      // A successful lookup is evidence that the deterministic instance ID is
      // retained, even when status propagation still reports `unknown`.
      return 'dispatched';
    } catch {
      // Neither a failed create response nor an unobservable lookup proves that
      // the deterministic instance is absent. createBatch is idempotent for a
      // retained ID, so replay exactly that ID instead of inventing a successor.
    }
    try {
      const dispatch = await dispatchWorkflowBatch(workflow, job.id, input);
      return dispatch === 'unknown' ? 'dispatched' : dispatch;
    } catch {
      // Creation is still ambiguous, but leaving the D1 row queued would block every
      // future export and attempt-1 is not eligible for retry redrive. The caller
      // fences a pristine row to failed; if the Workflow concurrently claims it, that
      // transition loses and the observed running row remains authoritative.
      return 'failed';
    }
  }
}

async function attemptKeys(
  bucket: R2Bucket,
  job: Awaited<ReturnType<typeof ownedJob>>,
  attempt: number,
): Promise<string[]> {
  const prefix = `events/${job.eventId}/exports/${job.id}/attempt-${attempt}/`;
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1_000 });
    keys.push(...page.objects.map(({ key }) => key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

async function deleteExportKeys(bucket: R2Bucket, keys: string[]): Promise<void> {
  for (let offset = 0; offset < keys.length; offset += 1_000) {
    await bucket.delete(keys.slice(offset, offset + 1_000));
  }
}

export const exportRoutes = new Hono<AppBindings>();

const createExportSchema = z.object({ kind: z.literal('album').optional() }).strict();

type ExportArtifactKind = 'manifest' | 'part' | 'printable-guestbook' | 'private-guestbook';

async function ownedReadyArtifact(
  context: Context<AppBindings>,
  kind: ExportArtifactKind,
  partNumber?: number,
) {
  await manager(context);
  const job = await ownedJob(context);
  if (job.kind === 'album'
    && (kind === 'printable-guestbook' || kind === 'private-guestbook')) {
    throw new ApiError('EXPORT_FAILED', 'That export artifact is not available.', 404);
  }
  if (job.state !== 'ready' || !job.expiresAt || Date.parse(job.expiresAt) <= Date.now()) {
    throw new ApiError('EXPORT_FAILED', 'This export is not ready to download.', 409);
  }
  if (kind === 'manifest' && job.manifestObjectKey) {
    return {
      key: job.manifestObjectKey,
      filename: 'candidary-export-manifest.csv',
      contentType: 'text/csv; charset=utf-8',
    };
  }
  if (kind === 'printable-guestbook' && job.guestbookHtmlObjectKey) {
    return {
      key: job.guestbookHtmlObjectKey,
      filename: 'guestbook.html',
      contentType: 'text/html; charset=utf-8',
    };
  }
  if (kind === 'private-guestbook' && job.guestbookCsvObjectKey) {
    return {
      key: job.guestbookCsvObjectKey,
      filename: 'guestbook-private.csv',
      contentType: 'text/csv; charset=utf-8',
    };
  }
  if (kind === 'part' && Number.isSafeInteger(partNumber) && (partNumber ?? 0) > 0) {
    const part = (await new ExportsRepository(context.env.DB).listParts(job.id))
      .find((candidate) => candidate.partNumber === partNumber);
    if (part) return {
      key: part.objectKey,
      filename: `photos-${String(part.partNumber).padStart(3, '0')}.zip`,
      contentType: 'application/zip',
    };
  }
  throw new ApiError('EXPORT_FAILED', 'That export artifact is not available.', 404);
}

function artifactUrl(eventId: string, jobId: string, kind: ExportArtifactKind, part?: number) {
  const suffix = kind === 'part' ? `/part/${part}` : `/${kind}`;
  return `/api/manage/events/${encodeURIComponent(eventId)}/exports/${encodeURIComponent(jobId)}/artifact${suffix}`;
}

class InvalidExportRange extends Error {}

function requestedRange(value: string | undefined, size: number): { offset: number; length: number } | null {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value);
  if (!match || (!match[1] && !match[2])) throw new InvalidExportRange();
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || size === 0) {
      throw new InvalidExportRange();
    }
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const offset = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(requestedEnd)
    || offset < 0 || offset >= size || requestedEnd < offset) {
    throw new InvalidExportRange();
  }
  const end = Math.min(requestedEnd, size - 1);
  return { offset, length: end - offset + 1 };
}

async function streamArtifact(
  context: Context<AppBindings>,
  kind: ExportArtifactKind,
  partNumber?: number,
) {
  const artifact = await ownedReadyArtifact(context, kind, partNumber);
  const metadata = await context.env.MEDIA_BUCKET.head(artifact.key);
  if (!metadata) {
    throw new ApiError('EXPORT_FAILED', 'This export artifact is unavailable. Retry the export.', 409);
  }
  let range: { offset: number; length: number } | null;
  try {
    range = requestedRange(context.req.header('range'), metadata.size);
  } catch (error) {
    if (error instanceof InvalidExportRange) {
      return new Response(null, {
        status: 416,
        headers: {
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'private, no-store',
          'Content-Range': `bytes */${metadata.size}`,
          'Cross-Origin-Resource-Policy': 'same-origin',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }
    throw error;
  }
  const object = await context.env.MEDIA_BUCKET.get(artifact.key, {
    onlyIf: { etagMatches: metadata.etag },
    ...(range ? { range } : {}),
  });
  if (!object || !('body' in object) || !object.body) {
    throw new ApiError('EXPORT_FAILED', 'This export artifact is unavailable. Retry the export.', 409);
  }
  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
    'Content-Disposition': `attachment; filename="${artifact.filename}"`,
    'Content-Length': String(range?.length ?? metadata.size),
    'Content-Type': artifact.contentType,
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
  });
  if (range) {
    headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${metadata.size}`);
  }
  return new Response(object.body, { status: range ? 206 : 200, headers });
}

exportRoutes.get('/manage/events/:eventId/exports', async (context) => {
  await manager(context);
  const jobs = await new ExportsRepository(context.env.DB)
    .listLatestForManager(context.req.param('eventId'));
  return context.json({ data: { exports: jobs.map(managerExport) }, requestId: context.get('requestId') });
});

exportRoutes.post('/manage/events/:eventId/exports', async (context) => {
  await manager(context, true);
  const rawBody = await context.req.text();
  let body: unknown = {};
  if (rawBody.trim().length > 0) {
    try {
      body = JSON.parse(rawBody) as unknown;
    } catch {
      body = null;
    }
  }
  const parsed = createExportSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(
      'VALIDATION_FAILED',
      'Choose the album export or omit kind for the complete export.',
      422,
    );
  }
  const snapshotAt = new Date().toISOString();
  const repository = new ExportsRepository(context.env.DB);
  const input = {
    id: crypto.randomUUID(), eventId: context.req.param('eventId'), snapshotAt,
    createdAt: snapshotAt,
  };
  let job = parsed.data.kind === 'album'
    ? await repository.createAlbumActive(input)
    : await repository.createActive(input);
  const dispatch = await ensureInitialWorkflow(context.env.EXPORT_WORKFLOW, job);
  if (dispatch === 'failed') {
    const recovered = await repository.markInitialDispatchFailed(
      job.id,
      'EXPORT_WORKFLOW_DISPATCH_FAILED',
    );
    if (recovered.job) job = recovered.job;
  } else {
    // A Workflow may claim the row before its create response reaches us. Return
    // the claimed state without weakening the repository's queued->running fence.
    job = await repository.getById(job.id) ?? job;
  }
  return context.json({ data: { export: managerExport(job) }, requestId: context.get('requestId') }, 202);
});

exportRoutes.get('/manage/events/:eventId/exports/:jobId', async (context) => {
  await manager(context);
  const job = await ownedJob(context);
  return context.json({ data: { export: managerExport(job) }, requestId: context.get('requestId') });
});

exportRoutes.post('/manage/events/:eventId/exports/:jobId/retry', async (context) => {
  await manager(context, true);
  const current = await ownedJob(context);
  const repository = new ExportsRepository(context.env.DB);
  const currentParts = await repository.listParts(current.id);
  const recovering = isRecoverableQueuedRetry(current) && currentParts.length === 0;
  if (current.state !== 'failed' && current.state !== 'expired' && !recovering) {
    throw new ApiError('EXPORT_ALREADY_ACTIVE', 'Only failed or expired exports can be retried.', 409);
  }
  const recordedKeys = [
    current.objectKey,
    current.manifestObjectKey,
    ...currentParts.map(({ objectKey }) => objectKey),
    current.guestbookHtmlObjectKey,
    current.guestbookCsvObjectKey,
  ].filter((key): key is string => Boolean(key));
  const rediscoveredKeys = current.executionProtocol === 'attempt-v2'
    ? await attemptKeys(
      context.env.MEDIA_BUCKET,
      current,
      recovering ? current.attempt - 1 : current.attempt,
    )
    : [];
  const keys = [...new Set([...recordedKeys, ...rediscoveredKeys])];
  let job = recovering ? current : await commitOrRecoverRetry(repository, current);
  // The won/recovered D1 transition is the ownership fence. Clean the exact
  // prior attempt before a replacement Workflow can claim and write attempt N.
  // A deletion failure leaves a pristine queued retry for this same route to
  // rediscover and redrive; it never races cleanup against a running attempt.
  await deleteExportKeys(context.env.MEDIA_BUCKET, keys);
  const dispatch = await ensureRetryWorkflow(context.env.EXPORT_WORKFLOW, job);
  if (dispatch === 'failed') {
    const recovered = await repository.markRetryDispatchFailed(
      job.id,
      job.attempt,
      'EXPORT_WORKFLOW_DISPATCH_FAILED',
    );
    if (recovered.job) job = recovered.job;
  } else {
    job = await repository.getById(job.id) ?? job;
  }
  return context.json({ data: { export: managerExport(job) }, requestId: context.get('requestId') }, 202);
});

exportRoutes.post('/manage/events/:eventId/exports/:jobId/download', async (context) => {
  await manager(context, true);
  const job = await ownedJob(context);
  if (job.state !== 'ready' || !job.expiresAt || Date.parse(job.expiresAt) <= Date.now()) {
    throw new ApiError('EXPORT_FAILED', 'This export is not ready to download.', 409);
  }
  const repository = new ExportsRepository(context.env.DB);
  const parts = await repository.listParts(job.id);
  const albumFormat = job.kind === 'album';
  const newCompleteFormat = !albumFormat && job.guestbookEntryCount !== null;
  const snapshotMetadataComplete = albumFormat
    ? job.albumEntriesJson !== null && albumGuestbookSnapshotEmpty(job)
    : !newCompleteFormat || (
    job.guestbookSharedCount !== null && job.guestbookEventName !== null
    && job.guestbookEventDate !== null && job.guestbookEventTimezone !== null
    && job.guestbookPrompt !== null && job.guestbookGalleryVisible !== null
  );
  const partsComplete = parts.every((part, index) => part.partNumber === index + 1
    && part.mediaCount > 0 && part.sourceBytes >= 0 && Boolean(part.objectKey));
  const photoComplete = job.mediaCount === 0
    ? newCompleteFormat && job.manifestObjectKey === null && job.partCount === 0 && parts.length === 0
    : Boolean(job.manifestObjectKey) && partsComplete
      && parts.length === job.partCount && job.partCount > 0
      && parts.reduce((count, part) => count + part.mediaCount, 0) === job.mediaCount;
  const guestbookComplete = albumFormat
    ? job.guestbookHtmlObjectKey === null && job.guestbookHtmlBytes === null
      && job.guestbookHtmlSha256 === null && job.guestbookCsvObjectKey === null
      && job.guestbookCsvBytes === null && job.guestbookCsvSha256 === null
    : !newCompleteFormat || Boolean(
      job.guestbookHtmlObjectKey && job.guestbookHtmlBytes !== null && job.guestbookHtmlSha256
      && job.guestbookCsvObjectKey && job.guestbookCsvBytes !== null && job.guestbookCsvSha256,
    );
  if (!snapshotMetadataComplete || !photoComplete || !guestbookComplete) {
    throw new ApiError('EXPORT_FAILED', 'This export is incomplete. Retry it.', 409);
  }
  return context.json({
    data: {
      manifest: job.manifestObjectKey ? {
        url: artifactUrl(job.eventId, job.id, 'manifest'),
        expiresAt: job.expiresAt,
        filename: 'candidary-export-manifest.csv',
      } : null,
      parts: parts.map((part) => ({
        partNumber: part.partNumber,
        mediaCount: part.mediaCount,
        sourceBytes: part.sourceBytes,
        url: artifactUrl(job.eventId, job.id, 'part', part.partNumber),
        expiresAt: job.expiresAt,
        filename: `photos-${String(part.partNumber).padStart(3, '0')}.zip`,
      })),
      printableGuestbook: job.guestbookHtmlObjectKey
        ? { url: artifactUrl(job.eventId, job.id, 'printable-guestbook'), expiresAt: job.expiresAt, filename: 'guestbook.html' }
        : null,
      privateGuestbook: job.guestbookCsvObjectKey
        ? { url: artifactUrl(job.eventId, job.id, 'private-guestbook'), expiresAt: job.expiresAt, filename: 'guestbook-private.csv' }
        : null,
    },
    requestId: context.get('requestId'),
  });
});

exportRoutes.get('/manage/events/:eventId/exports/:jobId/artifact/manifest', (context) => (
  streamArtifact(context, 'manifest')
));
exportRoutes.get('/manage/events/:eventId/exports/:jobId/artifact/part/:partNumber', (context) => (
  streamArtifact(context, 'part', Number(context.req.param('partNumber')))
));
exportRoutes.get('/manage/events/:eventId/exports/:jobId/artifact/printable-guestbook', (context) => (
  streamArtifact(context, 'printable-guestbook')
));
exportRoutes.get('/manage/events/:eventId/exports/:jobId/artifact/private-guestbook', (context) => (
  streamArtifact(context, 'private-guestbook')
));

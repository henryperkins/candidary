import { Hono, type Context } from 'hono';

import { MAX_EVENT_BYTES } from '../../shared/constants';
import { ApiError } from '../../shared/errors';
import { requireManager } from '../auth/manager';
import { ExportsRepository } from '../db/exports';
import { MediaRepository } from '../db/media';
import type { AppBindings, AppEnv } from '../env';

function manager(context: Context<AppBindings>, write = false) {
  return requireManager(context, { write });
}

async function ownedJob(context: Context<AppBindings>) {
  const job = await new ExportsRepository(context.env.DB).getById(context.req.param('jobId')!);
  if (!job || job.eventId !== context.req.param('eventId')) throw new ApiError('RESOURCE_FORBIDDEN', 'This export belongs to a different event.', 403);
  return job;
}

async function readyInventory(context: Context<AppBindings>) {
  const job = await ownedJob(context);
  const expiresAt = job.expiresAt ? Date.parse(job.expiresAt) : Number.NaN;
  if (job.state !== 'ready' || !job.manifestObjectKey
    || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new ApiError('EXPORT_FAILED', 'This export is not ready to download.', 409);
  }
  const parts = await new ExportsRepository(context.env.DB).listParts(job.id);
  if (parts.length !== job.partCount
    || parts.some((part, index) => part.partNumber !== index + 1 || !part.objectKey)) {
    throw new ApiError('EXPORT_FAILED', 'This export is incomplete. Retry it.', 409);
  }
  return { job, parts };
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
      && committed.eventId === current.eventId
      && committed.snapshotAt === current.snapshotAt
      && committed.mediaCount === current.mediaCount
      && committed.totalBytes === current.totalBytes
      && committed.createdAt === current.createdAt) {
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
    && job.objectKey === null
    && job.manifestObjectKey === null
    && job.partCount === 0
    && job.startedAt === null
    && job.completedAt === null
    && job.expiresAt === null;
}

async function ensureRetryWorkflow(
  workflow: AppEnv['EXPORT_WORKFLOW'],
  job: Awaited<ReturnType<typeof ownedJob>>,
): Promise<void> {
  const id = `${job.id}-${job.attempt}`;
  try {
    await workflow.createBatch([{ id, params: { jobId: job.id } }]);
  } catch (error) {
    try {
      const observed = await (await workflow.get(id)).status();
      if (observed.status !== 'unknown') return;
    } catch {
      // The original creation failure remains authoritative when existence
      // cannot be observed. A later request can safely retry the same ID.
    }
    throw error;
  }
}

async function priorAttemptKeys(
  bucket: R2Bucket,
  job: Awaited<ReturnType<typeof ownedJob>>,
): Promise<string[]> {
  const prefix = `events/${job.eventId}/exports/${job.id}/attempt-${job.attempt - 1}/`;
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

function artifactUrl(eventId: string, jobId: string, artifact: string): string {
  return `/api/manage/events/${encodeURIComponent(eventId)}/exports/${encodeURIComponent(jobId)}/artifacts/${artifact}`;
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

async function artifactResponse(
  context: Context<AppBindings>,
  key: string,
  filename: string,
  contentType: string,
) {
  const metadata = await context.env.MEDIA_BUCKET.head(key);
  if (!metadata) throw new ApiError('EXPORT_FAILED', 'This export artifact is unavailable. Retry the export.', 409);
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
  const object = await context.env.MEDIA_BUCKET.get(key, {
    onlyIf: { etagMatches: metadata.etag },
    ...(range ? { range } : {}),
  });
  if (!object || !('body' in object) || !object.body) {
    throw new ApiError('EXPORT_FAILED', 'This export artifact is unavailable. Retry the export.', 409);
  }
  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': String(range?.length ?? metadata.size),
    'Content-Type': contentType,
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
  });
  if (range) {
    headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${metadata.size}`);
  }
  return new Response(object.body, { status: range ? 206 : 200, headers });
}

export const exportRoutes = new Hono<AppBindings>();

exportRoutes.get('/manage/events/:eventId/exports', async (context) => {
  await manager(context);
  const jobs = await new ExportsRepository(context.env.DB).listForEvent(context.req.param('eventId'));
  return context.json({ data: { exports: jobs }, requestId: context.get('requestId') });
});

exportRoutes.post('/manage/events/:eventId/exports', async (context) => {
  await manager(context, true);
  const snapshotAt = new Date().toISOString();
  const media = await new MediaRepository(context.env.DB).exportSnapshot(context.req.param('eventId'), snapshotAt);
  if (!media.length) throw new ApiError('EXPORT_EMPTY', 'Deliver at least one photo before preparing an export.', 409);
  const totalBytes = media.reduce((sum, item) => sum + (item.byteSize ?? 0), 0);
  if (totalBytes > MAX_EVENT_BYTES) throw new ApiError('EXPORT_LIMIT_EXCEEDED', 'This event is too large to export.', 409);
  const job = await new ExportsRepository(context.env.DB).createActive({
    id: crypto.randomUUID(), eventId: context.req.param('eventId'), snapshotAt,
    mediaCount: media.length, totalBytes, createdAt: snapshotAt,
  });
  await context.env.EXPORT_WORKFLOW.create({ id: job.id, params: { jobId: job.id } });
  return context.json({ data: { export: job }, requestId: context.get('requestId') }, 202);
});

exportRoutes.get('/manage/events/:eventId/exports/:jobId', async (context) => {
  await manager(context);
  const job = await ownedJob(context);
  return context.json({ data: { export: job }, requestId: context.get('requestId') });
});

exportRoutes.post('/manage/events/:eventId/exports/:jobId/retry', async (context) => {
  await manager(context, true);
  const current = await ownedJob(context);
  const recovering = isRecoverableQueuedRetry(current);
  if (current.state !== 'failed' && current.state !== 'expired' && !recovering) {
    throw new ApiError('EXPORT_ALREADY_ACTIVE', 'Only failed or expired exports can be retried.', 409);
  }
  const repository = new ExportsRepository(context.env.DB);
  const currentParts = await repository.listParts(current.id);
  const keys = recovering
    ? await priorAttemptKeys(context.env.MEDIA_BUCKET, current)
    : [current.objectKey, current.manifestObjectKey, ...currentParts.map(({ objectKey }) => objectKey)]
      .filter((key): key is string => Boolean(key));
  const job = recovering ? current : await commitOrRecoverRetry(repository, current);
  await ensureRetryWorkflow(context.env.EXPORT_WORKFLOW, job);
  await deleteExportKeys(context.env.MEDIA_BUCKET, keys);
  return context.json({ data: { export: job }, requestId: context.get('requestId') }, 202);
});

exportRoutes.post('/manage/events/:eventId/exports/:jobId/download', async (context) => {
  await manager(context, true);
  const { job, parts } = await readyInventory(context);
  const eventId = context.req.param('eventId');
  return context.json({
    data: {
      manifest: {
        url: artifactUrl(eventId, job.id, 'manifest'),
        expiresAt: job.expiresAt,
        filename: 'candidary-export-manifest.csv',
      },
      parts: parts.map((part) => ({
        partNumber: part.partNumber,
        mediaCount: part.mediaCount,
        sourceBytes: part.sourceBytes,
        url: artifactUrl(eventId, job.id, `parts/${part.partNumber}`),
        expiresAt: job.expiresAt,
        filename: `photos-${String(part.partNumber).padStart(3, '0')}.zip`,
      })),
    },
    requestId: context.get('requestId'),
  });
});

exportRoutes.get('/manage/events/:eventId/exports/:jobId/artifacts/manifest', async (context) => {
  await manager(context);
  const { job } = await readyInventory(context);
  return artifactResponse(
    context,
    job.manifestObjectKey!,
    'candidary-export-manifest.csv',
    'text/csv; charset=utf-8',
  );
});

exportRoutes.get('/manage/events/:eventId/exports/:jobId/artifacts/parts/:partNumber', async (context) => {
  await manager(context);
  const { parts } = await readyInventory(context);
  const rawPartNumber = context.req.param('partNumber');
  const partNumber = /^[1-9][0-9]*$/u.test(rawPartNumber) ? Number(rawPartNumber) : Number.NaN;
  const part = Number.isSafeInteger(partNumber)
    ? parts.find((candidate) => candidate.partNumber === partNumber)
    : undefined;
  if (!part) throw new ApiError('RESOURCE_FORBIDDEN', 'This export artifact is not available.', 403);
  return artifactResponse(
    context,
    part.objectKey,
    `photos-${String(part.partNumber).padStart(3, '0')}.zip`,
    'application/zip',
  );
});

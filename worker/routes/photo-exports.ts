import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { isReadableOriginal,MAX_READABLE_ORIGINAL_BYTES } from '../../shared/image-formats';
import { ApiError } from '../../shared/errors';
import { createPhotoExportSchema, DEVICE_EXPORT_MAX_FILES, PHOTO_EXPORT_BODY_MAX_BYTES,
  type PhotoExportActiveConflict, type PhotoExportView } from '../../shared/photo-exports';
import { requireManager } from '../auth/manager';
import { PhotoExportsRepository, type PhotoExportReadLease } from '../db/photo-exports';
import { ExportsRepository } from '../db/exports';
import type { AppBindings } from '../env';
import { sanitizeFilename } from '../security/filenames';
import { recordOriginalRead } from '../observability/image-metrics';
import { attemptKeys, deleteExportKeys, ensureInitialWorkflow, ensureRetryWorkflow } from './exports';

const empty = z.object({}).strict();
const handoff = z.object({ mediaIds: z.array(z.string().uuid()).min(1).max(DEVICE_EXPORT_MAX_FILES)
  .refine(ids => new Set(ids.map(id => id.toLowerCase())).size === ids.length, 'Duplicate media IDs') }).strict();
const fallback = z.object({ idempotencyKey: z.string().uuid() }).strict();
const timestamp = () => new Date().toISOString();
const unavailable = () => new ApiError('EXPORT_FAILED', 'This original is unavailable. Retry preparation or choose an archive.', 409);

/** Caller must authorize writes (including CSRF) before invoking this reader. */
async function body<T>(context: Context<AppBindings>, schema: z.ZodType<T>): Promise<T> {
  const invalid = () => new ApiError('VALIDATION_FAILED', 'Use a valid photo export request under 1 MiB.', 422);
  const length = context.req.header('content-length');
  if (length !== undefined && (!/^\d+$/u.test(length) || Number(length) > PHOTO_EXPORT_BODY_MAX_BYTES)) throw invalid();
  const reader = context.req.raw.body?.getReader();
  const chunks: Uint8Array[] = []; let count = 0;
  if (reader) {
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        count += chunk.value.byteLength;
        if (count > PHOTO_EXPORT_BODY_MAX_BYTES) { await reader.cancel(); throw invalid(); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
  }
  const bytes = new Uint8Array(count); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let value: unknown;
  try { const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); value = text.trim() ? JSON.parse(text) : {}; }
  catch { throw invalid(); }
  const parsed = schema.safeParse(value); if (!parsed.success) throw invalid(); return parsed.data;
}

async function authorized(context: Context<AppBindings>, write: boolean,
  action: (repository: PhotoExportsRepository, eventId: string, principal: string) => Promise<Response>) {
  const auth = await requireManager(context, { write });
  const principal = auth.via === 'account' ? `account:${auth.accountId}` : `link:${auth.sessionId}`;
  const repository = new PhotoExportsRepository(context.env.DB);
  try { return await action(repository, auth.event.id, principal); }
  catch (error) {
    if (error instanceof ApiError && error.code === 'EXPORT_ALREADY_ACTIVE') {
      const activeJob = (await repository.capabilities(auth.event.id, principal)).activeJob;
      if (activeJob) {
        const data: PhotoExportActiveConflict = { kind: 'active-export-conflict', activeJob };
        return context.json({ data, requestId: context.get('requestId') }, 409);
      }
    }
    throw error;
  }
}

async function original(context: Context<AppBindings>, repository: PhotoExportsRepository, lease: PhotoExportReadLease) {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const finish = async (outcome: 'prepared' | 'failed') => {
    if (finished) return;
    finished = true; clearTimeout(timer); context.req.raw.signal.removeEventListener('abort', aborted);
    try { if (outcome === 'failed') await reader?.cancel(); }
    finally { await repository.releaseRead(lease, outcome, timestamp()); }
  };
  const stop = async () => {
    if (finished) return;
    controller?.error(unavailable());
    await finish('failed');
  };
  const aborted = () => { void stop().catch(() => undefined); };
  const assertActive = async () => {
    if (finished || Date.now() >= Date.parse(lease.leaseExpiresAt)
      || !await repository.assertReadActive(lease, timestamp())) throw unavailable();
  };
  try {
    await assertActive();
    if (!isReadableOriginal(lease.mimeType,lease.byteSize)) throw unavailable();
    const bucket = lease.objectBucketGeneration === 'canonical' ? context.env.CANONICAL_MEDIA_BUCKET : context.env.MEDIA_BUCKET;
    const object = await bucket.get(lease.objectKey);
    if (object?.body) { reader = object.body.getReader(); recordOriginalRead(context.env, lease.eventId, 'export', object.size); }
    await assertActive();
    if (!reader || !object || object.size !== lease.byteSize
      || object.httpMetadata?.contentType !== lease.mimeType) throw unavailable();
    let received = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(value) { controller = value; },
      async pull(value) {
        try {
          await assertActive();
          const chunk = await reader!.read();
          await assertActive();
          if (chunk.done) {
            if (received !== lease.byteSize) throw unavailable();
            await finish('prepared'); value.close(); return;
          }
          received += chunk.value.byteLength;
          if (received > lease.byteSize || received > MAX_READABLE_ORIGINAL_BYTES) throw unavailable();
          value.enqueue(chunk.value);
        } catch (error) {
          // EOF receipt persistence may fail after finish has retired the timer.
          // Always settle the response stream, including that failure path.
          value.error(error);
          await finish('failed');
        }
      },
      async cancel() { await finish('failed'); },
    }, { highWaterMark: 0 });
    context.req.raw.signal.addEventListener('abort', aborted, { once: true });
    timer = setTimeout(aborted, Math.max(0, Date.parse(lease.leaseExpiresAt) - Date.now()));
    if (context.req.raw.signal.aborted) await stop();
    const filename = sanitizeFilename(lease.filename);
    const asciiName = filename.replace(/[^\x20-\x7e]/gu, '_');
    return new Response(stream, { headers: {
      'Content-Type': lease.mimeType, 'Content-Length': String(lease.byteSize),
      'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/gu, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`,
      'Cache-Control': 'private, no-store', 'Cross-Origin-Resource-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff',
    } });
  } catch (error) { await finish('failed'); throw error; }
}

export const photoExportRoutes = new Hono<AppBindings>();
const base = '/manage/events/:eventId/photo-exports';
photoExportRoutes.use(`${base}/*`, async (context, next) => {
  context.header('Cache-Control', 'private, no-store'); context.header('Cross-Origin-Resource-Policy', 'same-origin');
  await next();
});
photoExportRoutes.get(`${base}/capabilities`, context => authorized(context, false, async (repository, eventId, principal) =>
  context.json({ data: await repository.capabilities(eventId, principal), requestId: context.get('requestId') })));
photoExportRoutes.post(base, context => authorized(context, true, async (repository, eventId, principal) => {
  const request = await body(context, createPhotoExportSchema);
  const job = await repository.create({ eventId, principal, request, now: timestamp() });
  return context.json({ data: { export: job }, requestId: context.get('requestId') }, 202);
}));
photoExportRoutes.get(`${base}/:jobId`, context => authorized(context, false, async (repository, eventId, principal) =>
  context.json({ data: { export: await repository.get(eventId, context.req.param('jobId')!, principal, timestamp()) }, requestId: context.get('requestId') })));
photoExportRoutes.get(`${base}/:jobId/entries`, context => authorized(context, false, async (repository, eventId, principal) => {
  const after = context.req.query('after') ?? '0';
  if (!/^\d+$/u.test(after)) throw new ApiError('VALIDATION_FAILED', 'Use a valid photo cursor.', 422);
  return context.json({ data: await repository.listEntries(eventId, context.req.param('jobId')!, principal, Number(after), 100, timestamp()), requestId: context.get('requestId') });
}));
for (const action of ['confirm', 'cancel', 'retry', 'handoff', 'archive'] as const) {
  photoExportRoutes.post(`${base}/:jobId/${action}`, context => authorized(context, true, async (repository, eventId, principal) => {
    const jobId = context.req.param('jobId')!;
    let job: PhotoExportView;
    if (action === 'handoff') job = await repository.recordHandoff(eventId, jobId, principal, (await body(context, handoff)).mediaIds, timestamp());
    else if (action === 'archive') job = await repository.prepareArchiveFallback(eventId, jobId, principal, (await body(context, fallback)).idempotencyKey, timestamp());
    else {
      await body(context, empty);
      if (action === 'retry') {
        await repository.get(eventId, jobId, principal, timestamp());
        const exports = new ExportsRepository(context.env.DB);
        const previous = (await exports.getById(jobId))!;
        const parts = await exports.listParts(jobId);
        const keys = [...new Set([previous.objectKey, previous.manifestObjectKey,
          ...parts.map(part => part.objectKey), ...await attemptKeys(context.env.MEDIA_BUCKET, previous, previous.attempt),
        ].filter((key): key is string => Boolean(key)))];
        job = await repository.retryArchive(eventId, jobId, principal, timestamp());
        await deleteExportKeys(context.env.MEDIA_BUCKET, keys);
      } else job = action === 'confirm' ? await repository.confirm(eventId, jobId, principal, timestamp())
        : await repository.cancel(eventId, jobId, principal, timestamp());
    }
    if (action === 'confirm' && job.destination === 'archive' && job.state === 'queued') {
      const exports = new ExportsRepository(context.env.DB);
      const record = (await exports.getById(job.id))!;
      const dispatch = job.attempt === 1 ? await ensureInitialWorkflow(context.env.EXPORT_WORKFLOW, record)
        : await ensureRetryWorkflow(context.env.EXPORT_WORKFLOW, record);
      if (dispatch === 'failed') await exports.markSelectionDispatchFailed(record.id, record.attempt, timestamp());
      job = await repository.get(eventId, job.id, principal, timestamp());
    }
    return context.json({ data: { export: job }, requestId: context.get('requestId') });
  }));
}
photoExportRoutes.get(`${base}/:jobId/entries/:mediaId/file`, context => authorized(context, false, async (repository, eventId, principal) =>
  original(context, repository, await repository.claimRead(eventId, context.req.param('jobId')!, context.req.param('mediaId')!, principal, timestamp()))));

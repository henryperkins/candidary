import { Hono, type Context } from 'hono';

import { ApiError } from '../../shared/errors';
import { requireManager } from '../auth/manager';
import { ExportsRepository } from '../db/exports';
import type { AppBindings } from '../env';
import { presignDownload } from '../storage/presign';

function manager(context: Context<AppBindings>, write = false) {
  return requireManager(context, { write });
}

async function ownedJob(context: Context<AppBindings>) {
  const job = await new ExportsRepository(context.env.DB).getById(context.req.param('jobId')!);
  if (!job || job.eventId !== context.req.param('eventId')) throw new ApiError('RESOURCE_FORBIDDEN', 'This export belongs to a different event.', 403);
  return job;
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
  const job = await new ExportsRepository(context.env.DB).createActive({
    id: crypto.randomUUID(), eventId: context.req.param('eventId'), snapshotAt,
    createdAt: snapshotAt,
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
  if (current.state !== 'failed' && current.state !== 'expired') {
    throw new ApiError('EXPORT_ALREADY_ACTIVE', 'Only failed or expired exports can be retried.', 409);
  }
  const repository = new ExportsRepository(context.env.DB);
  const currentParts = await repository.listParts(current.id);
  const keys = [
    current.objectKey,
    current.manifestObjectKey,
    ...currentParts.map(({ objectKey }) => objectKey),
    current.guestbookHtmlObjectKey,
    current.guestbookCsvObjectKey,
  ]
    .filter((key): key is string => Boolean(key));
  if (keys.length) await context.env.MEDIA_BUCKET.delete(keys);
  const job = await repository.retry(current.id);
  await context.env.EXPORT_WORKFLOW.create({ id: `${job.id}-${job.attempt}`, params: { jobId: job.id } });
  return context.json({ data: { export: job }, requestId: context.get('requestId') }, 202);
});

exportRoutes.post('/manage/events/:eventId/exports/:jobId/download', async (context) => {
  await manager(context, true);
  const job = await ownedJob(context);
  if (job.state !== 'ready' || !job.expiresAt || Date.parse(job.expiresAt) <= Date.now()) {
    throw new ApiError('EXPORT_FAILED', 'This export is not ready to download.', 409);
  }
  const repository = new ExportsRepository(context.env.DB);
  const parts = await repository.listParts(job.id);
  const newFormat = job.guestbookEntryCount !== null;
  const snapshotMetadataComplete = !newFormat || (
    job.guestbookSharedCount !== null && job.guestbookEventName !== null
    && job.guestbookEventDate !== null && job.guestbookEventTimezone !== null
    && job.guestbookPrompt !== null && job.guestbookGalleryVisible !== null
  );
  const partsComplete = parts.every((part, index) => part.partNumber === index + 1
    && part.mediaCount > 0 && part.sourceBytes >= 0 && Boolean(part.objectKey));
  const photoComplete = job.mediaCount === 0
    ? newFormat && job.manifestObjectKey === null && job.partCount === 0 && parts.length === 0
    : Boolean(job.manifestObjectKey) && partsComplete
      && parts.length === job.partCount && job.partCount > 0
      && parts.reduce((count, part) => count + part.mediaCount, 0) === job.mediaCount;
  const guestbookComplete = !newFormat || Boolean(
    job.guestbookHtmlObjectKey && job.guestbookHtmlBytes !== null && job.guestbookHtmlSha256
    && job.guestbookCsvObjectKey && job.guestbookCsvBytes !== null && job.guestbookCsvSha256,
  );
  if (!snapshotMetadataComplete || !photoComplete || !guestbookComplete) {
    throw new ApiError('EXPORT_FAILED', 'This export is incomplete. Retry it.', 409);
  }
  const [manifest, signedParts, printableGuestbook, privateGuestbook] = await Promise.all([
    job.manifestObjectKey ? presignDownload(context.env, job.manifestObjectKey) : null,
    Promise.all(parts.map(async (part) => ({
      ...part,
      ...(await presignDownload(context.env, part.objectKey)),
    }))),
    job.guestbookHtmlObjectKey ? presignDownload(context.env, job.guestbookHtmlObjectKey) : null,
    job.guestbookCsvObjectKey ? presignDownload(context.env, job.guestbookCsvObjectKey) : null,
  ]);
  const signedExpiry = manifest?.expiresAt
    ?? signedParts[0]?.expiresAt
    ?? printableGuestbook?.expiresAt
    ?? privateGuestbook?.expiresAt;
  if (!signedExpiry) throw new ApiError('EXPORT_FAILED', 'This export has no downloadable artifacts.', 409);
  return context.json({
    data: {
      manifest: manifest ? { ...manifest, expiresAt: signedExpiry, filename: 'candidary-export-manifest.csv' } : null,
      parts: signedParts.map((part) => ({
        partNumber: part.partNumber,
        mediaCount: part.mediaCount,
        sourceBytes: part.sourceBytes,
        url: part.url,
        expiresAt: signedExpiry,
        filename: `photos-${String(part.partNumber).padStart(3, '0')}.zip`,
      })),
      printableGuestbook: printableGuestbook
        ? { ...printableGuestbook, expiresAt: signedExpiry, filename: 'guestbook.html' }
        : null,
      privateGuestbook: privateGuestbook
        ? { ...privateGuestbook, expiresAt: signedExpiry, filename: 'guestbook-private.csv' }
        : null,
    },
    requestId: context.get('requestId'),
  });
});

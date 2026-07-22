import { Hono, type Context } from 'hono';

import { MAX_EVENT_BYTES } from '../../shared/constants';
import { ApiError } from '../../shared/errors';
import { AuthService } from '../auth/service';
import { ExportsRepository } from '../db/exports';
import { MediaRepository } from '../db/media';
import type { AppBindings } from '../env';
import { getSessionCookie } from '../http/cookies';
import { assertCsrf } from '../http/csrf';
import { presignDownload } from '../storage/presign';

async function manager(context: Context<AppBindings>, write = false) {
  const auth = await new AuthService(context.env).resolve(getSessionCookie(context));
  if (auth.session.role !== 'manager' || auth.event.id !== context.req.param('eventId')) {
    throw new ApiError('ROLE_FORBIDDEN', 'This management session belongs to a different event.', 403);
  }
  if (write) await assertCsrf(context, auth);
  return auth;
}

async function ownedJob(context: Context<AppBindings>) {
  const job = await new ExportsRepository(context.env.DB).getById(context.req.param('jobId')!);
  if (!job || job.eventId !== context.req.param('eventId')) throw new ApiError('ROLE_FORBIDDEN', 'This export belongs to a different event.', 403);
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
  const media = await new MediaRepository(context.env.DB).exportSnapshot(context.req.param('eventId'), snapshotAt);
  if (!media.length) throw new ApiError('EXPORT_EMPTY', 'Approve at least one photo before preparing an export.', 409);
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
  if (current.objectKey) await context.env.MEDIA_BUCKET.delete(current.objectKey);
  const job = await new ExportsRepository(context.env.DB).retry(current.id);
  await context.env.EXPORT_WORKFLOW.create({ id: `${job.id}-${job.attempt}`, params: { jobId: job.id } });
  return context.json({ data: { export: job }, requestId: context.get('requestId') }, 202);
});

exportRoutes.post('/manage/events/:eventId/exports/:jobId/download', async (context) => {
  await manager(context, true);
  const job = await ownedJob(context);
  if (job.state !== 'ready' || !job.objectKey || !job.expiresAt || Date.parse(job.expiresAt) <= Date.now()) {
    throw new ApiError('EXPORT_FAILED', 'This export is not ready to download.', 409);
  }
  const signed = await presignDownload(context.env, job.objectKey);
  return context.json({ data: signed, requestId: context.get('requestId') });
});

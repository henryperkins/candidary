import type { AppEnv } from '../env';
import { ExportsRepository } from '../db/exports';
import { MediaRepository } from '../db/media';
import { buildExportZipStream } from '../export/zip-stream';
import { multipartPut } from '../storage/multipart';

export async function processExport(env: AppEnv, jobId: string, now = new Date()) {
  const exports = new ExportsRepository(env.DB);
  let job = await exports.getById(jobId);
  if (!job) return null;
  if (job.state === 'ready') return job;
  job = await exports.markRunning(jobId, now.toISOString());
  const temporaryKey = `events/${job.eventId}/exports/${job.id}/attempt-${job.attempt}.zip`;
  try {
    const snapshot = await new MediaRepository(env.DB).exportSnapshot(job.eventId, job.snapshotAt);
    if (snapshot.length !== job.mediaCount) throw new Error('EXPORT_SNAPSHOT_CHANGED');
    const entries = [];
    for (const media of snapshot) {
      const object = await env.MEDIA_BUCKET.get(media.objectKey);
      if (!object) throw new Error('EXPORT_SOURCE_MISSING');
      entries.push({ media, body: object.body });
    }
    const archive = buildExportZipStream(entries);
    await multipartPut(env.MEDIA_BUCKET, temporaryKey, archive, {
      httpMetadata: { contentType: 'application/zip', contentDisposition: `attachment; filename="candidary-${job.eventId}.zip"` },
    });
    const completedAt = now.toISOString();
    return await exports.markReady(job.id, temporaryKey, completedAt, new Date(now.getTime() + 86_400_000).toISOString());
  } catch (error) {
    await env.MEDIA_BUCKET.delete(temporaryKey);
    const code = error instanceof Error && error.message.startsWith('EXPORT_') ? error.message : 'EXPORT_FAILED';
    return await exports.markFailed(job.id, code);
  }
}

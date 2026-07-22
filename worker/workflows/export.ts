import { MAX_EXPORT_PART_SOURCE_BYTES } from '../../shared/constants';
import type { AppEnv } from '../env';
import { ExportsRepository, type ReadyExportPart } from '../db/exports';
import { MediaRepository } from '../db/media';
import { buildExportManifest } from '../export/csv';
import { partitionExportSnapshot } from '../export/partition';
import { exportPartName } from '../export/paths';
import { buildExportZipStream } from '../export/zip-stream';
import { multipartPut } from '../storage/multipart';

export { partitionExportSnapshot } from '../export/partition';

export async function processExport(
  env: AppEnv,
  jobId: string,
  now = new Date(),
  maxPartBytes = MAX_EXPORT_PART_SOURCE_BYTES,
) {
  const exports = new ExportsRepository(env.DB);
  let job = await exports.getById(jobId);
  if (!job) return null;
  if (job.state === 'ready') return job;
  job = await exports.markRunning(jobId, now.toISOString());

  const baseKey = `events/${job.eventId}/exports/${job.id}/attempt-${job.attempt}`;
  const manifestObjectKey = `${baseKey}/candidary-export-manifest.csv`;
  const uploadedKeys: string[] = [];
  try {
    const snapshot = await new MediaRepository(env.DB).exportSnapshot(job.eventId, job.snapshotAt);
    if (snapshot.length !== job.mediaCount) throw new Error('EXPORT_SNAPSHOT_CHANGED');
    const partitions = partitionExportSnapshot(snapshot, maxPartBytes);
    const storedParts: ReadyExportPart[] = [];

    for (const part of partitions) {
      const entries = [];
      for (const media of part.media) {
        const object = await env.MEDIA_BUCKET.get(media.objectKey);
        if (!object?.body) throw new Error('EXPORT_SOURCE_MISSING');
        entries.push({ media, body: object.body });
      }
      const name = exportPartName(part.partNumber);
      const objectKey = `${baseKey}/${name}`;
      await multipartPut(env.MEDIA_BUCKET, objectKey, buildExportZipStream(entries), {
        httpMetadata: {
          contentType: 'application/zip',
          contentDisposition: `attachment; filename="candidary-${job.eventId}-${name}"`,
        },
      });
      uploadedKeys.push(objectKey);
      storedParts.push({
        partNumber: part.partNumber,
        objectKey,
        mediaCount: part.media.length,
        sourceBytes: part.sourceBytes,
      });
    }

    await env.MEDIA_BUCKET.put(manifestObjectKey, buildExportManifest(partitions), {
      httpMetadata: {
        contentType: 'text/csv; charset=utf-8',
        contentDisposition: 'attachment; filename="candidary-export-manifest.csv"',
      },
    });
    uploadedKeys.push(manifestObjectKey);
    const completedAt = now.toISOString();
    return await exports.markReady(
      job.id,
      manifestObjectKey,
      storedParts,
      completedAt,
      new Date(now.getTime() + 86_400_000).toISOString(),
    );
  } catch (error) {
    if (uploadedKeys.length) await env.MEDIA_BUCKET.delete(uploadedKeys);
    const code = error instanceof Error && error.message.startsWith('EXPORT_') ? error.message : 'EXPORT_FAILED';
    return await exports.markFailed(job.id, code);
  }
}

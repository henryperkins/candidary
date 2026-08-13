import { MAX_EXPORT_PART_SOURCE_BYTES } from '../../shared/constants';
import type { AppEnv } from '../env';
import { ExportsRepository, type ReadyExportPart } from '../db/exports';
import { GuestbookRepository } from '../db/guestbook';
import { MediaRepository } from '../db/media';
import { buildExportManifest } from '../export/csv';
import { buildGuestbookPrivateCsv, type GuestbookPhotoArchiveLocation } from '../export/guestbook-csv';
import { buildGuestbookHtml } from '../export/guestbook-html';
import { partitionExportSnapshot } from '../export/partition';
import { exportPartName, exportPath } from '../export/paths';
import { buildExportZipStream } from '../export/zip-stream';
import { multipartPut } from '../storage/multipart';

export { partitionExportSnapshot } from '../export/partition';

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function immutableGuestbookEntries(db: D1Database, jobId: string) {
  const repository = new GuestbookRepository(db);
  const entries = [];
  let cursor;
  do {
    const page = await repository.listExportEntries(jobId, cursor, 100);
    entries.push(...page.entries);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return entries;
}

async function immutableMediaEntries(repository: ExportsRepository, jobId: string) {
  const entries = [];
  let cursor;
  do {
    const page = await repository.listMediaEntries(jobId, cursor, 100);
    entries.push(...page.entries);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return entries;
}

async function clearIncompleteAttempt(bucket: R2Bucket, prefix: string) {
  for (;;) {
    const page = await bucket.list({ prefix, limit: 1_000 });
    const keys = page.objects.map(({ key }) => key);
    if (!keys.length) return;
    await bucket.delete(keys);
  }
}

export async function processExport(
  env: AppEnv,
  jobId: string,
  now = new Date(),
  maxPartBytes = MAX_EXPORT_PART_SOURCE_BYTES,
  claimStartedAt = now.toISOString(),
) {
  const exports = new ExportsRepository(env.DB);
  let job = await exports.getById(jobId);
  if (!job) return null;
  if (job.state === 'ready') return job;
  const claim = await exports.claimRunning(jobId, claimStartedAt);
  if (!claim.owned) return claim.job;
  job = claim.job;

  const baseKey = `events/${job.eventId}/exports/${job.id}/attempt-${job.attempt}`;
  // A callback retry resumes the same Workflow claim after an exception. No
  // Ready inventory exists while the job is Running, so clear that exact
  // deterministic attempt prefix before writing it again. Keep this outside
  // the failure handler: a cleanup error must retry the Workflow callback and
  // must not settle the job as Failed with unknown orphaned objects.
  try {
    await exports.assertOwnedRunActive(job.id, claimStartedAt);
  } catch (error) {
    const code = error instanceof Error && error.message.startsWith('EXPORT_')
      ? error.message
      : 'EXPORT_FAILED';
    return exports.markFailed(job.id, code);
  }
  if (claim.resumed) await clearIncompleteAttempt(env.MEDIA_BUCKET, `${baseKey}/`);
  const manifestObjectKey = `${baseKey}/candidary-export-manifest.csv`;
  const uploadedKeys: string[] = [];
  try {
    const snapshot = job.guestbookEntryCount === null
      ? await new MediaRepository(env.DB).exportSnapshot(job.eventId, job.snapshotAt)
      : await immutableMediaEntries(exports, job.id);
    if (snapshot.length !== job.mediaCount) throw new Error('EXPORT_SNAPSHOT_CHANGED');
    const partitions = partitionExportSnapshot(snapshot, maxPartBytes);
    const storedParts: ReadyExportPart[] = [];
    const photoArchiveByMediaId = new Map<string, GuestbookPhotoArchiveLocation>();

    for (const part of partitions) {
      const entries = [];
      for (const media of part.media) {
        const object = await env.MEDIA_BUCKET.get(media.objectKey);
        if (!object?.body) throw new Error('EXPORT_SOURCE_MISSING');
        await exports.assertOwnedRunActive(job.id, claimStartedAt);
        entries.push({ media, body: object.body });
      }
      part.media.forEach((media, index) => photoArchiveByMediaId.set(media.id, {
        partNumber: part.partNumber,
        path: exportPath(media, index),
      }));
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

    if (partitions.length) {
      await exports.assertOwnedRunActive(job.id, claimStartedAt);
      await env.MEDIA_BUCKET.put(manifestObjectKey, buildExportManifest(partitions), {
        httpMetadata: {
          contentType: 'text/csv; charset=utf-8',
          contentDisposition: 'attachment; filename="candidary-export-manifest.csv"',
        },
      });
      uploadedKeys.push(manifestObjectKey);
    }

    let guestbook = null;
    if (job.guestbookEntryCount !== null) {
      if (!job.guestbookEventName || !job.guestbookEventDate
        || !job.guestbookEventTimezone || !job.guestbookPrompt) {
        throw new Error('EXPORT_GUESTBOOK_SNAPSHOT_INVALID');
      }
      const entries = await immutableGuestbookEntries(env.DB, job.id);
      if (entries.length !== job.guestbookEntryCount) throw new Error('EXPORT_GUESTBOOK_SNAPSHOT_INVALID');
      const htmlObjectKey = `${baseKey}/guestbook.html`;
      const csvObjectKey = `${baseKey}/guestbook-private.csv`;
      const encoder = new TextEncoder();
      const htmlBytes = encoder.encode(buildGuestbookHtml({
        eventName: job.guestbookEventName,
        eventDate: job.guestbookEventDate,
        eventTimezone: job.guestbookEventTimezone,
        prompt: job.guestbookPrompt,
        snapshotAt: job.snapshotAt,
        entries,
        photoArchiveByMediaId,
      }));
      const csvBytes = encoder.encode(buildGuestbookPrivateCsv(entries, photoArchiveByMediaId));
      await exports.assertOwnedRunActive(job.id, claimStartedAt);
      await env.MEDIA_BUCKET.put(htmlObjectKey, htmlBytes, {
        httpMetadata: {
          contentType: 'text/html; charset=utf-8',
          contentDisposition: 'attachment; filename="guestbook.html"',
        },
      });
      uploadedKeys.push(htmlObjectKey);
      await exports.assertOwnedRunActive(job.id, claimStartedAt);
      await env.MEDIA_BUCKET.put(csvObjectKey, csvBytes, {
        httpMetadata: {
          contentType: 'text/csv; charset=utf-8',
          contentDisposition: 'attachment; filename="guestbook-private.csv"',
        },
      });
      uploadedKeys.push(csvObjectKey);
      guestbook = {
        htmlObjectKey,
        htmlBytes: htmlBytes.byteLength,
        htmlSha256: await sha256(htmlBytes),
        csvObjectKey,
        csvBytes: csvBytes.byteLength,
        csvSha256: await sha256(csvBytes),
      };
    }
    const completedAt = now.toISOString();
    await exports.assertOwnedRunActive(job.id, claimStartedAt);
    return await exports.markReady(
      job.id,
      {
        manifestObjectKey: partitions.length ? manifestObjectKey : null,
        parts: storedParts,
        guestbook,
      },
      completedAt,
      new Date(now.getTime() + 86_400_000).toISOString(),
    );
  } catch (error) {
    if (uploadedKeys.length) await env.MEDIA_BUCKET.delete(uploadedKeys);
    const code = error instanceof Error && error.message.startsWith('EXPORT_') ? error.message : 'EXPORT_FAILED';
    return await exports.markFailed(job.id, code);
  }
}

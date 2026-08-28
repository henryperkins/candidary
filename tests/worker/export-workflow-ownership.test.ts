import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppEnv } from '../../worker/env';
import {
  ExportsRepository,
  type ExportRunOwner,
} from '../../worker/db/exports';
import { processExport } from '../../worker/workflows/export';
import {
  eventAccess,
  resetDatabase,
  testEnv,
  uploadPending,
} from './helpers';

const NOW = new Date('2026-08-25T12:00:00.000Z');
const STARTED_AT = '2026-08-25T11:55:00.000Z';
const RETRY_STARTED_AT = '2026-08-25T11:58:00.000Z';
const PROGRESS_AT = '2026-08-25T11:57:00.000Z';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitForPhase(phase: Promise<void>, run: Promise<unknown>, label: string) {
  await Promise.race([
    phase,
    run.then(() => { throw new Error(`Export completed before ${label}.`); }),
  ]);
}

function replaceBuckets(input: {
  media?: R2Bucket;
  canonical?: R2Bucket;
}): AppEnv {
  const fixture = Object.create(testEnv) as AppEnv;
  Object.defineProperties(fixture, {
    MEDIA_BUCKET: { value: input.media ?? testEnv.MEDIA_BUCKET },
    CANONICAL_MEDIA_BUCKET: { value: input.canonical ?? testEnv.CANONICAL_MEDIA_BUCKET },
  });
  return fixture;
}

function forbiddenBucket(base: R2Bucket, name: string, calls: string[]): R2Bucket {
  const forbidden = new Set<PropertyKey>([
    'list', 'delete', 'get', 'put', 'createMultipartUpload',
  ]);
  return new Proxy(base, {
    get(target, property) {
      if (forbidden.has(property)) {
        return () => {
          calls.push(`${name}.${String(property)}`);
          return Promise.reject(new Error(`Stale export reached ${name}.${String(property)}.`));
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function blockFirstGet(base: R2Bucket, entered: ReturnType<typeof deferred>, release: ReturnType<typeof deferred>) {
  const originalGet = base.get.bind(base);
  let blocked = false;
  return new Proxy(base, {
    get(target, property) {
      if (property === 'get') {
        return async (...args: Parameters<R2Bucket['get']>) => {
          if (!blocked) {
            blocked = true;
            entered.resolve();
            await release.promise;
          }
          return originalGet(...args);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function blockPhotoCompletions(
  base: R2Bucket,
  gates: ReadonlyArray<{
    entered: ReturnType<typeof deferred>;
    release: ReturnType<typeof deferred>;
  }>,
) {
  const originalCreate = base.createMultipartUpload.bind(base);
  let photoUploads = 0;
  return new Proxy(base, {
    get(target, property) {
      if (property === 'createMultipartUpload') {
        return async (...args: Parameters<R2Bucket['createMultipartUpload']>) => {
          const upload = await originalCreate(...args);
          if (!args[0].includes('/photos-')) return upload;
          photoUploads += 1;
          const gate = gates[photoUploads - 1];
          if (!gate) return upload;
          const originalComplete = upload.complete.bind(upload);
          return new Proxy(upload, {
            get(uploadTarget, uploadProperty) {
              if (uploadProperty === 'complete') {
                return async (...completeArgs: Parameters<typeof upload.complete>) => {
                  gate.entered.resolve();
                  await gate.release.promise;
                  return originalComplete(...completeArgs);
                };
              }
              const value = Reflect.get(uploadTarget, uploadProperty, uploadTarget) as unknown;
              return typeof value === 'function' ? value.bind(uploadTarget) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function recordDeletes(base: R2Bucket, deleted: string[][]): R2Bucket {
  const originalDelete = base.delete.bind(base);
  return new Proxy(base, {
    get(target, property) {
      if (property === 'delete') {
        return async (...args: Parameters<R2Bucket['delete']>) => {
          deleted.push(typeof args[0] === 'string' ? [args[0]] : [...args[0]]);
          return originalDelete(...args);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function queuedExport(id: string, mediaCount: number) {
  const access = await eventAccess();
  const media = [];
  for (let index = 0; index < mediaCount; index += 1) {
    media.push(await uploadPending(access, `${id}-${index + 1}`, null));
  }
  const snapshotAt = new Date(Date.now() + 60_000).toISOString();
  const repository = new ExportsRepository(testEnv.DB);
  const job = await repository.createActive({
    id,
    eventId: access.event.id,
    snapshotAt,
    createdAt: snapshotAt,
  });
  return { access, job, media, repository };
}

function owner(id: string, attempt = 1): ExportRunOwner {
  return {
    id,
    executionProtocol: 'attempt-v2',
    attempt,
    executionStartedAt: STARTED_AT,
  };
}

describe('attempt-owned export Workflow', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await resetDatabase();
  });

  it('returns a stale attempt before any R2 read, write, multipart work, or delete', async () => {
    const { job, repository } = await queuedExport('stale-attempt', 1);
    const claimed = await repository.claimRunning(job.id, 1, STARTED_AT);
    expect(claimed.status).toBe('claimed');
    await repository.markOwnedFailed(owner(job.id), 'EXPORT_FAILED', PROGRESS_AT);
    const winner = await repository.retry(job.id);
    expect(winner).toMatchObject({ state: 'queued', attempt: 2 });

    const calls: string[] = [];
    const env = replaceBuckets({
      media: forbiddenBucket(testEnv.MEDIA_BUCKET, 'media', calls),
      canonical: forbiddenBucket(testEnv.CANONICAL_MEDIA_BUCKET, 'canonical', calls),
    });
    const result = await processExport(
      env,
      { jobId: job.id, attempt: 1 },
      NOW,
      64,
      STARTED_AT,
    );

    expect(result).toMatchObject({ id: job.id, state: 'queued', attempt: 2 });
    expect(calls).toEqual([]);
  });

  it('clears only the resumed attempt prefix and resets progress before rebuilding', async () => {
    const { job, repository } = await queuedExport('resumed-attempt', 1);
    expect(await repository.claimRunning(job.id, 1, STARTED_AT)).toMatchObject({ status: 'claimed' });
    expect(await repository.recordProgress(owner(job.id), {
      processedMediaCount: job.mediaCount,
      processedBytes: job.totalBytes,
      progressUpdatedAt: PROGRESS_AT,
    })).toBe(true);
    const exactAttemptKey = `events/${job.eventId}/exports/${job.id}/attempt-1/orphan.zip`;
    const otherAttemptKey = `events/${job.eventId}/exports/${job.id}/attempt-2/winner.zip`;
    await testEnv.MEDIA_BUCKET.put(exactAttemptKey, new Uint8Array([1]));
    await testEnv.MEDIA_BUCKET.put(otherAttemptKey, new Uint8Array([2]));

    const sourceRead = deferred();
    const releaseSource = deferred();
    const env = replaceBuckets({
      canonical: blockFirstGet(testEnv.CANONICAL_MEDIA_BUCKET, sourceRead, releaseSource),
    });
    const run = processExport(
      env,
      { jobId: job.id, attempt: 1 },
      NOW,
      64,
      STARTED_AT,
    );

    try {
      await waitForPhase(sourceRead.promise, run, 'the first rebuilt source read');
      expect(await testEnv.MEDIA_BUCKET.head(exactAttemptKey)).toBeNull();
      expect(await testEnv.MEDIA_BUCKET.head(otherAttemptKey)).not.toBeNull();
      expect(await repository.getById(job.id)).toMatchObject({
        state: 'running',
        attempt: 1,
        processedMediaCount: 0,
        processedBytes: 0,
      });
    } finally {
      releaseSource.resolve();
      await run.catch(() => undefined);
    }
    expect(await run).toMatchObject({ state: 'ready', attempt: 1 });
  });

  it('records cumulative absolute progress only after each whole photo part completes', async () => {
    const { job, repository } = await queuedExport('whole-part-progress', 2);
    expect(job).toMatchObject({ mediaCount: 2, totalBytes: 128 });
    const firstCompletion = deferred();
    const releaseFirstCompletion = deferred();
    const secondCompletion = deferred();
    const releaseSecondCompletion = deferred();
    const env = replaceBuckets({
      media: blockPhotoCompletions(
        testEnv.MEDIA_BUCKET,
        [
          { entered: firstCompletion, release: releaseFirstCompletion },
          { entered: secondCompletion, release: releaseSecondCompletion },
        ],
      ),
    });
    const run = processExport(
      env,
      { jobId: job.id, attempt: 1 },
      NOW,
      64,
      STARTED_AT,
    );

    try {
      await waitForPhase(firstCompletion.promise, run, 'the first whole-part completion');
      expect(await repository.getById(job.id)).toMatchObject({
        state: 'running',
        processedMediaCount: 0,
        processedBytes: 0,
      });
      releaseFirstCompletion.resolve();
      await waitForPhase(secondCompletion.promise, run, 'the second whole-part completion');
      expect(await repository.getById(job.id)).toMatchObject({
        state: 'running',
        processedMediaCount: 1,
        processedBytes: 64,
      });
    } finally {
      releaseFirstCompletion.resolve();
      releaseSecondCompletion.resolve();
      await run.catch(() => undefined);
    }
    expect(await run).toMatchObject({
      state: 'ready',
      processedMediaCount: 2,
      processedBytes: 128,
    });
  });

  it('timestamps completion after the final progress write and grants 24 hours from completion', async () => {
    const { job } = await queuedExport('completion-clock', 1);
    const progressAt = new Date('2026-08-25T12:10:00.000Z');
    const completedAt = new Date('2026-08-25T12:15:00.000Z');
    const clock = vi.fn()
      .mockReturnValueOnce(progressAt)
      .mockReturnValueOnce(completedAt);

    const result = await processExport(
      testEnv,
      { jobId: job.id, attempt: 1 },
      NOW,
      64,
      STARTED_AT,
      clock,
    );

    expect(clock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      state: 'ready',
      progressUpdatedAt: progressAt.toISOString(),
      completedAt: completedAt.toISOString(),
      expiresAt: new Date(completedAt.getTime() + 86_400_000).toISOString(),
    });
    expect(Date.parse(result!.completedAt!)).toBeGreaterThanOrEqual(
      Date.parse(result!.progressUpdatedAt!),
    );
  });

  it('does not delete a replacement winner after losing ownership following multipart completion', async () => {
    const { job, repository } = await queuedExport('post-upload-owner-loss', 1);
    const stalePartKey = `events/${job.eventId}/exports/${job.id}/attempt-1/photos-001.zip`;
    const progressEntered = deferred();
    const releaseProgress = deferred();
    const originalRecordProgress = ExportsRepository.prototype.recordProgress;
    vi.spyOn(ExportsRepository.prototype, 'recordProgress').mockImplementationOnce(async function (
      this: ExportsRepository,
      ...args: Parameters<ExportsRepository['recordProgress']>
    ) {
      progressEntered.resolve();
      await releaseProgress.promise;
      return originalRecordProgress.apply(this, args);
    });
    const deleted: string[][] = [];
    const env = replaceBuckets({ media: recordDeletes(testEnv.MEDIA_BUCKET, deleted) });
    const staleRun = processExport(
      env,
      { jobId: job.id, attempt: 1 },
      NOW,
      64,
      STARTED_AT,
    );

    try {
      await waitForPhase(progressEntered.promise, staleRun, 'the first progress commit');
      expect(await testEnv.MEDIA_BUCKET.head(stalePartKey)).not.toBeNull();
      expect(await repository.markOwnedFailed(owner(job.id), 'EXPORT_FAILED', PROGRESS_AT))
        .toMatchObject({ changed: true, job: { state: 'failed', attempt: 1 } });
      expect(await repository.retry(job.id)).toMatchObject({ state: 'queued', attempt: 2 });

      const winner = await processExport(
        env,
        { jobId: job.id, attempt: 2 },
        new Date('2026-08-25T12:01:00.000Z'),
        64,
        RETRY_STARTED_AT,
      );
      expect(winner).toMatchObject({ state: 'ready', attempt: 2 });
    } finally {
      releaseProgress.resolve();
      await staleRun.catch(() => undefined);
    }

    expect(await staleRun).toMatchObject({ state: 'ready', attempt: 2 });
    expect(deleted).toEqual([]);
    expect(await testEnv.MEDIA_BUCKET.head(stalePartKey)).not.toBeNull();
    const winner = await repository.getById(job.id);
    const winnerParts = await repository.listParts(job.id);
    const winnerKeys = [
      winner?.manifestObjectKey,
      winner?.guestbookHtmlObjectKey,
      winner?.guestbookCsvObjectKey,
      ...winnerParts.map((part) => part.objectKey),
    ].filter((key): key is string => key !== null && key !== undefined);
    expect(winnerKeys).toHaveLength(4);
    expect(winnerParts).toEqual([
      expect.objectContaining({
        partNumber: 1,
        objectKey: `events/${job.eventId}/exports/${job.id}/attempt-2/photos-001.zip`,
      }),
    ]);
    for (const key of winnerKeys) expect(await testEnv.MEDIA_BUCKET.head(key)).not.toBeNull();
  });

  it('terminalizes event deletion only for the exact claimed owner before touching R2', async () => {
    const { access, job, repository } = await queuedExport('event-deleted-owner', 1);
    const originalClaim = ExportsRepository.prototype.claimRunning;
    vi.spyOn(ExportsRepository.prototype, 'claimRunning').mockImplementationOnce(async function (
      this: ExportsRepository,
      ...args: Parameters<ExportsRepository['claimRunning']>
    ) {
      const claim = await originalClaim.apply(this, args);
      await testEnv.DB.prepare('UPDATE events SET deleted_at = ? WHERE id = ?')
        .bind(NOW.toISOString(), access.event.id).run();
      return claim;
    });
    const calls: string[] = [];
    const env = replaceBuckets({
      media: forbiddenBucket(testEnv.MEDIA_BUCKET, 'media', calls),
      canonical: forbiddenBucket(testEnv.CANONICAL_MEDIA_BUCKET, 'canonical', calls),
    });

    const result = await processExport(
      env,
      { jobId: job.id, attempt: 1 },
      NOW,
      64,
      STARTED_AT,
    );

    expect(result).toMatchObject({
      id: job.id,
      state: 'failed',
      errorCode: 'EXPORT_EVENT_DELETED',
      executionTransition: 2,
    });
    expect(await repository.getById(job.id)).toMatchObject({
      state: 'failed',
      errorCode: 'EXPORT_EVENT_DELETED',
    });
    expect(calls).toEqual([]);
  });

  it('reconciles a lost Ready race without deleting the winning inventory', async () => {
    const { job, repository } = await queuedExport('ready-race', 1);
    const originalMarkReady = ExportsRepository.prototype.markReady;
    vi.spyOn(ExportsRepository.prototype, 'markReady').mockImplementationOnce(async function (
      this: ExportsRepository,
      ...args: Parameters<ExportsRepository['markReady']>
    ) {
      const winner = await originalMarkReady.apply(this, args);
      if (!winner.changed) throw new Error('Ready race fixture did not commit its winner.');
      return originalMarkReady.apply(this, args);
    });
    const deleted: string[][] = [];
    const env = replaceBuckets({ media: recordDeletes(testEnv.MEDIA_BUCKET, deleted) });

    const result = await processExport(
      env,
      { jobId: job.id, attempt: 1 },
      NOW,
      64,
      STARTED_AT,
    );
    expect(result).toMatchObject({ state: 'ready', attempt: 1 });
    expect(deleted).toEqual([]);

    const ready = await repository.getById(job.id);
    const parts = await repository.listParts(job.id);
    const keys = [
      ready?.manifestObjectKey,
      ready?.guestbookHtmlObjectKey,
      ready?.guestbookCsvObjectKey,
      ...parts.map((part) => part.objectKey),
    ].filter((key): key is string => key !== null && key !== undefined);
    expect(keys).toHaveLength(4);
    for (const key of keys) expect(await testEnv.MEDIA_BUCKET.head(key)).not.toBeNull();
  });
});

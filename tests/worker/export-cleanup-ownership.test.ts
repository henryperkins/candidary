import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ExportsRepository, type ReadyExportInventory } from '../../worker/db/exports';
import { cleanupExpiredExports } from '../../worker/workflows/cleanup';
import {
  eventAccess,
  resetDatabase,
  testEnv,
  uploadPending,
} from './helpers';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitForPhase(phase: Promise<void>, run: Promise<unknown>, label: string) {
  await Promise.race([
    phase,
    run.then(() => { throw new Error(`Cleanup completed before ${label}.`); }),
  ]);
}

async function readyExport(id: string) {
  const access = await eventAccess();
  await uploadPending(access, `${id}-photo`, null);
  const base = Date.now();
  const snapshotAt = new Date(base + 60_000).toISOString();
  const executionStartedAt = new Date(base + 90_000).toISOString();
  const completedAt = new Date(base + 120_000).toISOString();
  const expiresAt = new Date(base + 180_000).toISOString();
  const cleanupAt = new Date(base + 240_000);
  const repository = new ExportsRepository(testEnv.DB);
  const job = await repository.createActive({
    id,
    eventId: access.event.id,
    snapshotAt,
    createdAt: snapshotAt,
  });
  const claim = await repository.claimRunning(id, 1, executionStartedAt);
  if (claim.status === 'lost') throw new Error('Ready fixture could not claim its attempt.');
  expect(await repository.recordProgress(claim.owner, {
    processedMediaCount: job.mediaCount,
    processedBytes: job.totalBytes,
    progressUpdatedAt: completedAt,
  })).toBe(true);
  const prefix = `events/${job.eventId}/exports/${job.id}/attempt-1`;
  const inventory = {
    manifestObjectKey: `${prefix}/candidary-export-manifest.csv`,
    parts: [{
      partNumber: 1,
      objectKey: `${prefix}/photos-1.zip`,
      mediaCount: 1,
      sourceBytes: job.totalBytes,
    }],
    guestbook: {
      htmlObjectKey: `${prefix}/guestbook.html`,
      htmlBytes: 1,
      htmlSha256: 'a'.repeat(64),
      csvObjectKey: `${prefix}/guestbook-private.csv`,
      csvBytes: 1,
      csvSha256: 'b'.repeat(64),
    },
  } satisfies ReadyExportInventory;
  const keys = [
    inventory.manifestObjectKey,
    inventory.parts[0]!.objectKey,
    inventory.guestbook.htmlObjectKey,
    inventory.guestbook.csvObjectKey,
  ];
  for (const key of keys) await testEnv.MEDIA_BUCKET.put(key, new Uint8Array([1]));
  expect(await repository.markReady(claim.owner, inventory, completedAt, expiresAt))
    .toMatchObject({ changed: true, job: { state: 'ready' } });
  return { cleanupAt, id, inventory, keys, repository };
}

async function completeRetryAttempt(fixture: Awaited<ReturnType<typeof readyExport>>) {
  const startedAt = new Date(fixture.cleanupAt.getTime() + 1_000).toISOString();
  const completedAt = new Date(fixture.cleanupAt.getTime() + 2_000).toISOString();
  const expiresAt = new Date(fixture.cleanupAt.getTime() + 86_400_000).toISOString();
  const claim = await fixture.repository.claimRunning(fixture.id, 2, startedAt);
  if (claim.status === 'lost') throw new Error('Replacement fixture could not claim attempt 2.');
  expect(await fixture.repository.recordProgress(claim.owner, {
    processedMediaCount: claim.job.mediaCount,
    processedBytes: claim.job.totalBytes,
    progressUpdatedAt: completedAt,
  })).toBe(true);
  const prefix = `events/${claim.job.eventId}/exports/${claim.job.id}/attempt-2`;
  const inventory = {
    manifestObjectKey: `${prefix}/candidary-export-manifest.csv`,
    parts: [{
      partNumber: 1,
      objectKey: `${prefix}/photos-1.zip`,
      mediaCount: 1,
      sourceBytes: claim.job.totalBytes,
    }],
    guestbook: {
      htmlObjectKey: `${prefix}/guestbook.html`,
      htmlBytes: 1,
      htmlSha256: 'c'.repeat(64),
      csvObjectKey: `${prefix}/guestbook-private.csv`,
      csvBytes: 1,
      csvSha256: 'd'.repeat(64),
    },
  } satisfies ReadyExportInventory;
  const keys = [
    inventory.manifestObjectKey,
    inventory.parts[0]!.objectKey,
    inventory.guestbook.htmlObjectKey,
    inventory.guestbook.csvObjectKey,
  ];
  for (const key of keys) await testEnv.MEDIA_BUCKET.put(key, new Uint8Array([2]));
  expect(await fixture.repository.markReady(claim.owner, inventory, completedAt, expiresAt))
    .toMatchObject({ changed: true, job: { state: 'ready', attempt: 2 } });
  return { inventory, keys };
}

describe('export cleanup ownership', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await resetDatabase();
  });

  it('wins Ready to Expired and captures inventory before the first R2 delete', async () => {
    const fixture = await readyExport('expiry-before-delete');
    const deleteEntered = deferred();
    const releaseDelete = deferred();
    const originalDelete = testEnv.MEDIA_BUCKET.delete.bind(testEnv.MEDIA_BUCKET);
    vi.spyOn(testEnv.MEDIA_BUCKET, 'delete').mockImplementationOnce(async (keys) => {
      deleteEntered.resolve();
      await releaseDelete.promise;
      return originalDelete(keys);
    });
    const run = cleanupExpiredExports(testEnv, fixture.cleanupAt);

    try {
      await waitForPhase(deleteEntered.promise, run, 'its R2 delete boundary');
      expect(await fixture.repository.getById(fixture.id)).toMatchObject({
        state: 'expired',
        manifestObjectKey: fixture.inventory.manifestObjectKey,
        guestbookHtmlObjectKey: fixture.inventory.guestbook.htmlObjectKey,
        guestbookCsvObjectKey: fixture.inventory.guestbook.csvObjectKey,
      });
      expect(await fixture.repository.listParts(fixture.id)).toEqual([
        expect.objectContaining({ objectKey: fixture.inventory.parts[0]!.objectKey }),
      ]);
    } finally {
      releaseDelete.resolve();
      await run.catch(() => undefined);
    }
    await run;
    expect(await fixture.repository.getById(fixture.id)).toMatchObject({
      state: 'expired',
      manifestObjectKey: null,
      guestbookHtmlObjectKey: null,
      guestbookCsvObjectKey: null,
    });
    expect(await fixture.repository.listParts(fixture.id)).toEqual([]);
  });

  it('preserves a replacement attempt when Retry commits before the expired delete and clear', async () => {
    const fixture = await readyExport('expiry-retry-before-delete');
    const deleteEntered = deferred();
    const releaseDelete = deferred();
    const originalDelete = testEnv.MEDIA_BUCKET.delete.bind(testEnv.MEDIA_BUCKET);
    vi.spyOn(testEnv.MEDIA_BUCKET, 'delete').mockImplementationOnce(async (keys) => {
      deleteEntered.resolve();
      await releaseDelete.promise;
      return originalDelete(keys);
    });
    const cleanup = cleanupExpiredExports(testEnv, fixture.cleanupAt);
    let replacement: Awaited<ReturnType<typeof completeRetryAttempt>> | undefined;

    try {
      await waitForPhase(deleteEntered.promise, cleanup, 'its expired-artifact delete');
      expect(await fixture.repository.getById(fixture.id)).toMatchObject({
        state: 'expired',
        attempt: 1,
        manifestObjectKey: fixture.inventory.manifestObjectKey,
      });
      expect(await fixture.repository.retry(fixture.id)).toMatchObject({
        state: 'queued',
        attempt: 2,
      });
      replacement = await completeRetryAttempt(fixture);
    } finally {
      releaseDelete.resolve();
      await cleanup.catch(() => undefined);
    }

    expect(await cleanup).toBe(1);
    expect(replacement).toBeDefined();
    expect(await fixture.repository.getById(fixture.id)).toMatchObject({
      state: 'ready',
      attempt: 2,
      manifestObjectKey: replacement!.inventory.manifestObjectKey,
      partCount: 1,
    });
    expect(await fixture.repository.listParts(fixture.id)).toEqual([
      expect.objectContaining({
        partNumber: 1,
        objectKey: replacement!.inventory.parts[0]!.objectKey,
      }),
    ]);
    for (const key of fixture.keys) expect(await testEnv.MEDIA_BUCKET.head(key)).toBeNull();
    for (const key of replacement!.keys) expect(await testEnv.MEDIA_BUCKET.head(key)).not.toBeNull();
  });

  it('rejects a stale inventory clear after Retry replaces the expired attempt', async () => {
    const fixture = await readyExport('expiry-retry-before-clear');
    const clearEntered = deferred();
    const releaseClear = deferred();
    const originalClear = ExportsRepository.prototype.clearExpiredInventory;
    vi.spyOn(ExportsRepository.prototype, 'clearExpiredInventory').mockImplementationOnce(async function (
      this: ExportsRepository,
      ...args: Parameters<ExportsRepository['clearExpiredInventory']>
    ) {
      clearEntered.resolve();
      await releaseClear.promise;
      return originalClear.apply(this, args);
    });
    const cleanup = cleanupExpiredExports(testEnv, fixture.cleanupAt);
    let replacement: Awaited<ReturnType<typeof completeRetryAttempt>> | undefined;

    try {
      await waitForPhase(clearEntered.promise, cleanup, 'its expired-inventory clear');
      for (const key of fixture.keys) expect(await testEnv.MEDIA_BUCKET.head(key)).toBeNull();
      expect(await fixture.repository.getById(fixture.id)).toMatchObject({
        state: 'expired',
        attempt: 1,
        manifestObjectKey: fixture.inventory.manifestObjectKey,
      });
      expect(await fixture.repository.retry(fixture.id)).toMatchObject({
        state: 'queued',
        attempt: 2,
      });
      replacement = await completeRetryAttempt(fixture);
    } finally {
      releaseClear.resolve();
      await cleanup.catch(() => undefined);
    }

    expect(await cleanup).toBe(1);
    expect(replacement).toBeDefined();
    expect(await fixture.repository.getById(fixture.id)).toMatchObject({
      state: 'ready',
      attempt: 2,
      manifestObjectKey: replacement!.inventory.manifestObjectKey,
      partCount: 1,
    });
    expect(await fixture.repository.listParts(fixture.id)).toEqual([
      expect.objectContaining({
        partNumber: 1,
        objectKey: replacement!.inventory.parts[0]!.objectKey,
      }),
    ]);
    for (const key of replacement!.keys) expect(await testEnv.MEDIA_BUCKET.head(key)).not.toBeNull();
  });

  it('retains failed-delete inventory and clears it only after a later successful retry', async () => {
    const fixture = await readyExport('expiry-delete-recovery');
    const failedDelete = vi.spyOn(testEnv.MEDIA_BUCKET, 'delete')
      .mockRejectedValue(new Error('R2 delete unavailable'));

    await cleanupExpiredExports(testEnv, fixture.cleanupAt).catch(() => undefined);
    failedDelete.mockRestore();

    expect(await fixture.repository.getById(fixture.id)).toMatchObject({
      state: 'expired',
      manifestObjectKey: fixture.inventory.manifestObjectKey,
      guestbookHtmlObjectKey: fixture.inventory.guestbook.htmlObjectKey,
      guestbookCsvObjectKey: fixture.inventory.guestbook.csvObjectKey,
    });
    expect(await fixture.repository.listParts(fixture.id)).toHaveLength(1);
    for (const key of fixture.keys) expect(await testEnv.MEDIA_BUCKET.head(key)).not.toBeNull();

    await cleanupExpiredExports(testEnv, fixture.cleanupAt);

    expect(await fixture.repository.getById(fixture.id)).toMatchObject({
      state: 'expired',
      manifestObjectKey: null,
      guestbookHtmlObjectKey: null,
      guestbookCsvObjectKey: null,
    });
    expect(await fixture.repository.listParts(fixture.id)).toEqual([]);
    for (const key of fixture.keys) expect(await testEnv.MEDIA_BUCKET.head(key)).toBeNull();
  });
});

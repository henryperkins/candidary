import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UploadTransferRepository } from '../../worker/db/upload-transfers';
import { cleanupUploadTransfers, eventHasUploadInventory, purgeUploadInventory } from '../../worker/workflows/upload-transfer-cleanup';
import { deleteEventData } from '../../worker/workflows/cleanup';
import { createTransferHarness, barrier } from './fixtures/upload-transfer';
import { resetDatabase, testEnv } from './helpers';

beforeEach(resetDatabase);
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); globalThis.__CANDIDARY_TEST_MOBILE_IMAGE_RELEASE_OVERRIDE__ = undefined; });
describe('multipart cleanup inventory', () => {
  it('persists create intent before R2 and retains lost create responses beyond seven days', async () => {
    vi.useFakeTimers({toFake:['Date']}); const h = await createTransferHarness(); await h.reserve(3);
    h.hooks.create = async () => { expect((await h.assembly()).state).toBe('creating'); throw new Error('Lost create response'); };
    expect((await h.putPart(0,new Uint8Array([1,2,3]))).status).toBe(503);
    expect((await h.abort()).status).toBe(200);
    h.advanceClock(8*86400_000); await cleanupUploadTransfers(h.environment);
    const a = await h.assembly(); expect(a.multipart_upload_id).toBeNull(); expect(a.state).toBe('suppressed');
    expect(await eventHasUploadInventory(h.environment,h.access.event.id)).toBe(true);
    expect((await testEnv.CANONICAL_MEDIA_BUCKET.head(a.object_key))).toBeNull();
  });

  it('records late create IDs after deletion and cleans only after the writer settles', async () => {
    const h = await createTransferHarness(); await h.reserve(3); const hold = barrier(); h.hooks.create = hold.wait;
    const pending = h.putPart(0,new Uint8Array([1,2,3])); await hold.entered;
    expect((await h.deleteMedia()).status).toBe(200); await cleanupUploadTransfers(h.environment);
    expect(await eventHasUploadInventory(h.environment,h.access.event.id)).toBe(true);
    hold.release(); expect((await pending).status).toBe(409);
    expect((await h.assembly()).multipart_upload_id).toBeTruthy();
    await cleanupUploadTransfers(h.environment);
    expect((await h.assembly()).state).toBe('absent');
  });

  it('fences a delayed part before abort and does not acknowledge its late result', async () => {
    const h = await createTransferHarness(); await h.reserve(3); const hold = barrier(); h.hooks.part = hold.wait;
    const pending = h.putPart(0,new Uint8Array([1,2,3])); await hold.entered;
    h.hooks.abort = async () => { expect(await testEnv.DB.prepare('SELECT generation FROM media_upload_transfers WHERE id=?').bind(h.identity.transferId).first<number>('generation')).toBeGreaterThan(1); };
    expect((await h.abort()).status).toBe(200); await cleanupUploadTransfers(h.environment);
    expect((await h.assembly()).state).toBe('suppressed');
    hold.release(); expect((await pending).status).toBe(409); await cleanupUploadTransfers(h.environment);
    expect((await h.assembly()).state).toBe('absent');
  });

  it('retains failed aborts and deletes a completed key only after completion settles', async () => {
    const h = await createTransferHarness(); await h.reserve(3); expect((await h.putPart(0,new Uint8Array([1,2,3]))).status).toBe(200);
    const repo = new UploadTransferRepository(testEnv.DB);
    expect((await repo.claimCompletion(h.identity,new Date().toISOString())).ok).toBe(true);
    expect(await repo.beginCompletion(h.identity,new Date().toISOString())).not.toBeNull();
    const a = await h.assembly(); h.hooks.abort = async () => {throw new Error('Unavailable');};
    expect((await h.abort()).status).toBe(200); expect((await h.assembly()).state).toBe('suppressed');
    h.hooks.abort = async () => {}; await cleanupUploadTransfers(h.environment);
    expect((await h.assembly()).state).toBe('suppressed'); // Not proof of a settled completion.
    await testEnv.CANONICAL_MEDIA_BUCKET.put(a.object_key,new Uint8Array([1,2,3]));
    await testEnv.DB.prepare('UPDATE media_upload_assemblies SET writer_settled_at=? WHERE id=?').bind(new Date().toISOString(),a.id).run();
    await cleanupUploadTransfers(h.environment);
    expect(await testEnv.CANONICAL_MEDIA_BUCKET.head(a.object_key)).toBeNull(); expect((await h.assembly()).state).toBe('absent');
  });

  it('blocks event relational purge until multipart inventory has authoritative cleanup proof', async () => {
    vi.useFakeTimers({toFake:['Date']});
    const h = await createTransferHarness(); await h.reserve(3);
    h.hooks.create = async () => {throw new Error('Lost create response');}; await h.putPart(0,new Uint8Array([1,2,3]));
    await testEnv.DB.prepare('UPDATE events SET deleted_at=? WHERE id=?').bind(new Date().toISOString(),h.access.event.id).run();
    await cleanupUploadTransfers(h.environment,new Date(),h.access.event.id);
    expect(await eventHasUploadInventory(h.environment,h.access.event.id)).toBe(true);
    await expect(testEnv.DB.prepare('DELETE FROM events WHERE id=?').bind(h.access.event.id).run()).rejects.toThrow();
    expect((await h.assembly()).state).toBe('suppressed');
    h.advanceClock(8*86400_000);
    const progress = await deleteEventData(h.environment,h.access.event.id);
    expect(progress.remainder).toBe(true); expect(progress.phase).toBe('fences');
    expect(await testEnv.DB.prepare('SELECT id FROM events WHERE id=?').bind(h.access.event.id).first()).not.toBeNull();
    expect((await h.assembly()).state).toBe('suppressed');
  });

  it('retains replay records until event purge and releases only proven-absent multipart inventory', async () => {
    const h = await createTransferHarness({realStorage:true}); await h.reserve(3);
    expect((await h.putPart(0,new Uint8Array([1,2,3]))).status).toBe(200);
    expect((await h.abort()).status).toBe(200); expect((await h.abort()).status).toBe(200);
    expect((await h.assembly()).state).toBe('absent');
    expect(await eventHasUploadInventory(h.environment,h.access.event.id)).toBe(false);
    expect((await (await h.status()).json<any>()).data.transfer.state).toBe('aborted');
    await testEnv.DB.prepare('UPDATE events SET deleted_at=? WHERE id=?').bind(new Date().toISOString(),h.access.event.id).run();
    await purgeUploadInventory(h.environment,h.access.event.id);
    expect(await testEnv.DB.prepare('SELECT id FROM media_upload_transfers WHERE event_id=?').bind(h.access.event.id).first()).toBeNull();
  });
});

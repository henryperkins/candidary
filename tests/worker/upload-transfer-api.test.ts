import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTransferHarness, barrier, sha256, transportDng } from './fixtures/upload-transfer';
import { eventAccess, resetDatabase, secondGuest, testEnv, writeHeaders } from './helpers';
import { cleanupUploadTransfers } from '../../worker/workflows/upload-transfer-cleanup';
import { cleanupExpiredReservations } from '../../worker/workflows/cleanup';
import { UploadTransferRepository } from '../../worker/db/upload-transfers';
import { MAX_EVENT_MEDIA } from '../../shared/constants';

beforeEach(resetDatabase);
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); globalThis.__CANDIDARY_TEST_MOBILE_IMAGE_RELEASE_OVERRIDE__ = undefined; });

describe('multipart upload routes', () => {
  it.each([false,true])('verifies a reselected original against private accepted-part proofs (manager=%s)', async (manager) => {
    const h=await createTransferHarness({manager}); const bytes=new Uint8Array([1,2,3]); await h.reserve(bytes,transportDng); await h.putPart(0,bytes);
    const parts=[{index:0,byteSize:3,sha256:await sha256(bytes)}];
    const verify=(body:unknown) => h.request(`${h.path()}/verify`,{method:'POST',headers:writeHeaders(h.credentials),body:JSON.stringify(body)});
    const response=await verify({byteSize:3,parts}); expect(response.status).toBe(200);
    expect((await response.json<any>()).data).toEqual({verifiedParts:[0]});
    expect((await verify({byteSize:3,parts:[{...parts[0],sha256:'f'.repeat(64)}]})).status).toBe(409);
    expect((await verify({byteSize:4,parts})).status).toBe(409);
    expect((await verify({byteSize:3,parts:[]})).status).toBe(409);
    await h.complete(); expect((await verify({byteSize:3,parts})).status).toBe(200);
    expect(h.create).toHaveBeenCalledTimes(1);
    expect([...h.handles.values()][0]!.uploadPart).toHaveBeenCalledTimes(1);
    await h.deleteMedia(); expect((await verify({byteSize:3,parts})).status).toBe(409);
  });
  it.each([false,true])('keeps accepted bytes and public status immutable (manager=%s)', async (manager) => {
    const h = await createTransferHarness({manager,realStorage:true}); await h.reserve(new Uint8Array([1,2,3]));
    expect((await h.start()).status).toBe(200);
    const first = await h.putPart(0,new Uint8Array([1,2,3])); expect(first.status,h.storageErrors.map(String).join('\n')).toBe(200);
    expect((await first.json<any>()).data).toEqual({index:0,accepted:true});
    expect((await h.putPart(0,new Uint8Array([1,2,3]))).status).toBe(200);
    expect((await h.putPart(0,new Uint8Array([1,2,4]))).status).toBe(409);
    expect(h.create).toHaveBeenCalledTimes(1);
    const response = await h.status(); expect(response.headers.get('cache-control')).toBe('private, no-store');
    const t = (await response.json<any>()).data.transfer;
    expect(Object.keys(t).sort()).toEqual(['acceptedParts','expiresAt','hardExpiresAt','id','mediaId','partBytes','partCount','previewState','state']);
    expect(t.acceptedParts).toEqual([0]); expect(t.state).toBe('receiving');
    expect((await h.abort()).status).toBe(200);
  });

  it('rejects foreign actors and invalid origin/CSRF before reading bytes', async () => {
    const h = await createTransferHarness(); await h.reserve(3);
    const other = await eventAccess('Other'); const sameEvent = await secondGuest(h.access.eventLink);
    for (const credential of [other.guest,sameEvent]) {
      const pull = vi.fn(); const response = await h.request(`${h.path()}/parts/0`,{method:'PUT',headers:{...writeHeaders(credential),'content-length':'3','x-part-sha256':'a'.repeat(64)},body:new ReadableStream({pull},{highWaterMark:0})});
      expect(response.status).toBe(403); expect(pull).not.toHaveBeenCalled();
    }
    for (const patch of [{origin:'https://foreign.example'},{'x-candidary-csrf':'invalid'}]) {
      const pull = vi.fn(); const response = await h.request(`${h.path()}/parts/0`,{method:'PUT',headers:{...writeHeaders(h.credentials),'content-length':'3','x-part-sha256':'a'.repeat(64),...patch},body:new ReadableStream({pull},{highWaterMark:0})});
      expect(response.status).toBe(403); expect(pull).not.toHaveBeenCalled();
    }
    expect(h.create).not.toHaveBeenCalled();
  });

  it('bounds bodies and checks exact indexes, lengths and hashes before R2 mutations', async () => {
    const h = await createTransferHarness(); await h.reserve(3);
    for (const [index,bytes,headers] of [[1,new Uint8Array(3),{}],[0,new Uint8Array(2),{}],[0,new Uint8Array(3),{'x-part-sha256':'b'.repeat(64)}],[0,new Uint8Array(4),{'content-length':'3'}]] as const) {
      expect((await h.putPart(index,bytes,headers)).status).toBe(422);
    }
    expect(h.create).not.toHaveBeenCalled();
  });

  it.each(['closure','revocation','deletion'] as const)('rechecks %s after the request body arrives', async (action) => {
    const h = await createTransferHarness(); await h.reserve(3); const hold = barrier();
    const pending = h.request(`${h.path()}/parts/0`,{method:'PUT',headers:{...writeHeaders(h.credentials),'content-length':'3','x-part-sha256':await sha256(new Uint8Array([1,2,3]))},body:new ReadableStream({async pull(c) {await hold.wait(); c.enqueue(new Uint8Array([1,2,3])); c.close();}},{highWaterMark:0})});
    await hold.entered;
    if (action === 'closure') await h.closeIntake();
    else if (action === 'revocation') await h.revokeSession();
    else expect((await h.deleteMedia()).status).toBe(200);
    hold.release();
    expect((await pending).status).toBe(action === 'revocation' ? 403 : 409); expect(h.create).not.toHaveBeenCalled();
  });

  it('coalesces concurrent creates and accepted-part replay after a lost response', async () => {
    const h = await createTransferHarness(); await h.reserve(3); const hold = barrier(); h.hooks.create = hold.wait;
    const first = h.putPart(0,new Uint8Array([1,2,3])); await hold.entered;
    expect((await h.putPart(0,new Uint8Array([1,2,3]))).status).toBe(503);
    hold.release(); expect((await first).status).toBe(200);
    expect((await h.putPart(0,new Uint8Array([1,2,3]))).status).toBe(200); expect(h.create).toHaveBeenCalledTimes(1);
  });

  it('retries identical bytes after an R2 part acknowledgement is lost', async () => {
    const h = await createTransferHarness({realStorage:true}); await h.reserve(3);
    h.hooks.partAfter = async () => {throw new Error('Lost part acknowledgement');};
    expect((await h.putPart(0,new Uint8Array([1,2,3]))).status).toBe(503);
    expect((await (await h.status()).json<any>()).data.transfer.acceptedParts).toEqual([]);
    expect((await h.putPart(0,new Uint8Array([1,2,4]))).status).toBe(409);
    h.hooks.partAfter = async () => {};
    expect((await h.putPart(0,new Uint8Array([1,2,3]))).status).toBe(200);
    expect((await h.abort()).status).toBe(200);
  });

  it.each([1,5])('extends 512 MiB transport at %s Mbit/s beyond 15 minutes without quota duplication', async (mbits) => {
    vi.useFakeTimers({toFake:['Date']}); const h = await createTransferHarness(); await h.reserve(512*1024**2);
    const bytes = new Uint8Array(8*1024**2); const initial = Date.now();
    expect((await (await h.status()).json<any>()).data.transfer.hardExpiresAt).toBe(new Date(initial+6*3600_000).toISOString());
    for (let i=0;i<64;i++) {
      h.advanceClock(Math.ceil(bytes.length*8/(mbits*1_000_000)*1000));
      expect((await h.putPart(i,bytes)).status).toBe(200);
      if (i === 31) expect(await cleanupExpiredReservations(h.environment)).toBe(0);
    }
    // At 5 Mbit/s the raw payload takes ~14.3 minutes; processing/resume allowance
    // crosses 15 minutes without extending an expired transfer.
    h.advanceClock(90_000); expect(Date.now()-initial).toBeGreaterThan(900_000);
    expect((await (await h.status()).json<any>()).data.transfer.acceptedParts).toHaveLength(64);
    expect(await testEnv.DB.prepare('SELECT reserved_media_count,reserved_bytes FROM events WHERE id = ?').bind(h.access.event.id).first()).toEqual({reserved_media_count:1,reserved_bytes:512*1024**2});
    const horizons = await testEnv.DB.prepare('SELECT t.expires_at,m.reservation_expires_at,p.source_writable_until FROM media_upload_transfers t JOIN media m ON m.id=t.media_id JOIN media_object_promotions p ON p.media_id=m.id WHERE t.id=?').bind(h.identity.transferId).first<any>();
    expect(horizons.reservation_expires_at).toBe(horizons.expires_at); expect(horizons.source_writable_until).toBe(horizons.expires_at);
  },60_000);

  it('expires idle and revoked transfers instead of keeping quota indefinitely', async () => {
    vi.useFakeTimers({toFake:['Date']}); const h = await createTransferHarness(); await h.reserve(3,transportDng);
    await h.revokeSession(); expect((await h.putPart(0,new Uint8Array([1,2,3]))).status).toBe(401);
    await cleanupUploadTransfers(h.environment);
    expect(await testEnv.DB.prepare('SELECT upload_state FROM media WHERE id=?').bind(h.identity.mediaId).first<string>('upload_state')).toBe('failed');
    const next = await createTransferHarness(); await next.reserve(3); next.advanceClock(901_000);
    expect((await next.putPart(0,new Uint8Array([1,2,3]))).status).toBe(409);
    await cleanupUploadTransfers(next.environment);
    expect(await testEnv.DB.prepare('SELECT state FROM media_upload_transfers WHERE id=?').bind(next.identity.transferId).first<string>('state')).toBe('expired');
  });

  it('resumes inside the idle window and clamps renewed processing leases to actor expiry', async () => {
    vi.useFakeTimers({toFake:['Date']});
    const h = await createTransferHarness();
    const actor = await testEnv.DB.prepare("SELECT id FROM event_sessions WHERE event_id=? AND role='guest'").bind(h.access.event.id).first<string>('id');
    const hard = new Date(Date.now()+17*60_000).toISOString();
    await testEnv.DB.prepare('UPDATE event_sessions SET expires_at=? WHERE id=?').bind(hard,actor).run();
    await h.reserve(3); h.advanceClock(14*60_000);
    expect((await h.putPart(0,new Uint8Array([1,2,3]))).status).toBe(200);
    const repo = new UploadTransferRepository(testEnv.DB); const claimed = await repo.claimCompletion(h.identity,new Date().toISOString());
    expect(claimed.ok).toBe(true); if (!claimed.ok) throw new Error(claimed.reason);
    h.advanceClock(2*60_000);
    const renewed = await repo.renewCompletionLease(h.identity,claimed.value,new Date().toISOString());
    expect(renewed.ok).toBe(true); if (!renewed.ok) throw new Error(renewed.reason);
    expect(renewed.value.leaseExpiresAt).toBe(hard);
    expect((await (await h.status()).json<any>()).data.transfer.expiresAt).toBe(hard);
    expect(await cleanupExpiredReservations(h.environment)).toBe(0);
    h.advanceClock(61_000);
    expect((await repo.renewCompletionLease(h.identity,renewed.value,new Date().toISOString())).ok).toBe(false);
    await cleanupUploadTransfers(h.environment);
    expect(await testEnv.DB.prepare('SELECT state FROM media_upload_transfers WHERE id=?').bind(h.identity.transferId).first<string>('state')).toBe('expired');
  });

  it('closes new intake without invalidating pinned transfers, and still enforces quota', async () => {
    const h = await createTransferHarness(); await h.reserve(3,transportDng);
    await testEnv.DB.prepare("UPDATE mobile_image_admission SET enabled=0,revision=revision+1 WHERE case_id='dng-proraw-jxl'").run();
    expect((await h.putPart(0,new Uint8Array([1,2,3]))).status).toBe(200);
    await cleanupUploadTransfers(h.environment);
    expect((await (await h.status()).json<any>()).data.transfer.state).toBe('receiving');
    const before = await testEnv.DB.prepare('SELECT reserved_media_count,reserved_bytes FROM events WHERE id=?').bind(h.access.event.id).first();
    await testEnv.DB.prepare('UPDATE events SET stored_media_count=? WHERE id=?').bind(MAX_EVENT_MEDIA-1,h.access.event.id).run();
    await expect(h.reserve(3,transportDng)).rejects.toThrow('EVENT_MEDIA_LIMIT');
    expect(await testEnv.DB.prepare('SELECT reserved_media_count,reserved_bytes FROM events WHERE id=?').bind(h.access.event.id).first()).toEqual(before);
  });
});

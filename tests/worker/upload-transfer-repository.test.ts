import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { eventAccess, resetDatabase, testEnv, trashMedia, uploadPending } from './helpers';
import { UploadTransferRepository, transferWindowSeconds, type TransferOutcome, type WriteClaim } from '../../worker/db/upload-transfers';
import { ImagePreviewRepository } from '../../worker/db/image-previews';
import { MediaProcessingRepository } from '../../worker/db/media-processing';
import { reservedTransfer, PART_BYTES, TEST_FINGERPRINT, TEST_SHA } from './fixtures/mobile-image-db';
import { decoderInspection } from './fixtures/image-decoder';

function value<T>(outcome: TransferOutcome<T>): T {
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome.value;
}
const store = () => new UploadTransferRepository(env.DB,{buildFingerprint:TEST_FINGERPRINT,caseId:'png'});
const plus = (now:string,seconds:number) => new Date(Date.parse(now)+seconds*1000).toISOString();
const proof = {index:0,byteSize:64,sha256:TEST_SHA};
function claimValue(outcome: TransferOutcome<{alreadyAccepted:true}|{alreadyAccepted:false;claim:WriteClaim}>) {
  const result = value(outcome);
  if (result.alreadyAccepted) throw new Error('Expected a new writer.');
  return result.claim;
}

async function completion() {
  const fixture = await reservedTransfer();
  const repo = store();
  value(await repo.initiate(fixture.input));
  const assembly = value(await repo.createAssemblyIntent(fixture.identity,fixture.now));
  expect(await repo.recordAssemblyCreated(assembly,'test-r2-upload',fixture.now)).toBe(true);
  const claim = claimValue(await repo.claimPart(fixture.identity,proof,fixture.now));
  value(await repo.acceptPart(fixture.identity,proof,claim,'part-etag',fixture.now));
  return {...fixture,repo,assembly,completionClaim:value(await repo.claimCompletion(fixture.identity,fixture.now))};
}

beforeEach(resetDatabase);
describe('durable upload ownership', () => {
  it('keeps transfer, multipart and preview inventories separate', async () => {
    const tables = (await env.DB.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all<{ name: string }>()).results.map((row) => row.name);
    for (const name of ['media_upload_transfers', 'media_upload_parts', 'media_upload_assemblies', 'media_processing', 'media_image_previews']) expect(tables).toContain(name);
  });

  it('reserves once with coherent geometry, pinned evidence and bounded expiry', async () => {
    const f = await reservedTransfer(PART_BYTES+1);
    const repo = store();
    const transfer = value(await repo.initiate(f.input));
    expect(transfer).toMatchObject({partBytes:PART_BYTES,partCount:2,generation:1,attempt:1,acceptedParts:[],buildFingerprint:TEST_FINGERPRINT,admissionCase:'png'});
    expect(transfer.expiresAt).toBe(plus(f.now,900));
    expect(transfer.hardExpiresAt <= plus(f.now,6*3600)).toBe(true);
    expect(value(await repo.initiate(f.input))).toEqual(transfer);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM media_upload_transfers').first()).toEqual({n:1});
    expect(await env.DB.prepare('SELECT reservation_expires_at FROM media WHERE id = ?').bind(f.identity.mediaId).first()).toEqual({reservation_expires_at:transfer.expiresAt});
    expect(await env.DB.prepare('SELECT source_writable_until FROM media_object_promotions WHERE media_id = ?').bind(f.identity.mediaId).first()).toEqual({source_writable_until:transfer.expiresAt});
    expect(transferWindowSeconds(512*1024**2)).toBe(4895);
    await expect(env.DB.prepare('UPDATE media_upload_transfers SET byte_size = byte_size + 1 WHERE id = ?').bind(f.identity.transferId).run()).rejects.toThrow('immutable upload transfer');
  });

  it('requires matching ownership and a live actor for every durable mutation', async () => {
    const f = await reservedTransfer();
    const repo = store(); value(await repo.initiate(f.input));
    expect(await repo.getOwned({...f.identity,eventId:'another-event'},f.now)).toEqual({ok:false,reason:'forbidden'});
    expect(await repo.claimPart({...f.identity,authority:{kind:'guest',actorSessionId:'other',eventSessionId:'other'}},proof,f.now)).toEqual({ok:false,reason:'forbidden'});
    const claim = claimValue(await repo.claimPart(f.identity,proof,f.now));
    await env.DB.prepare('UPDATE event_sessions SET revoked_at = ? WHERE id = ?').bind(f.now,f.identity.authority.actorSessionId).run();
    expect(await repo.acceptPart(f.identity,proof,claim,'etag',f.now)).toEqual({ok:false,reason:'forbidden'});
    expect((await repo.fenceOwned(f.identity,'aborted',f.now)).ok).toBe(false);
    await repo.fenceForMediaMutation(f.identity.mediaId,f.now);
    expect(await env.DB.prepare('SELECT state,generation FROM media_upload_transfers').first()).toEqual({state:'aborted',generation:2});
    expect(await env.DB.prepare('SELECT state,writer_settled_at FROM media_upload_parts').first()).toEqual({state:'suppressed',writer_settled_at:null});
  });

  it('refuses wrong part geometry and digest conflicts, but replays identical accepted parts', async () => {
    const f = await reservedTransfer(); const repo = store(); value(await repo.initiate(f.input));
    for (const candidate of [{...proof,index:1},{...proof,byteSize:63},{...proof,sha256:'invalid'}]) expect((await repo.claimPart(f.identity,candidate,f.now)).ok).toBe(false);
    const claim = claimValue(await repo.claimPart(f.identity,proof,f.now));
    expect((await repo.claimPart(f.identity,proof,f.now)).ok).toBe(false);
    expect((await repo.acceptPart(f.identity,proof,{...claim,token:'another-writer'},'etag',f.now)).ok).toBe(false);
    value(await repo.acceptPart(f.identity,proof,claim,'etag',plus(f.now,60)));
    expect(value(await repo.claimPart(f.identity,proof,plus(f.now,60)))).toEqual({alreadyAccepted:true});
    expect((await repo.claimPart(f.identity,{...proof,sha256:'c'.repeat(64)},plus(f.now,60))).ok).toBe(false);
    expect(value(await repo.getOwned(f.identity,plus(f.now,60)))).toMatchObject({acceptedParts:[0],expiresAt:plus(f.now,960)});
    expect((await repo.claimCompletion(f.identity,plus(f.now,60))).ok).toBe(false);
  });

  it('checks event intake after a write while retaining already-pinned admission', async () => {
    const f = await reservedTransfer(); const repo = store(); value(await repo.initiate(f.input));
    const claim = claimValue(await repo.claimPart(f.identity,proof,f.now));
    await env.DB.prepare('UPDATE events SET uploads_enabled = 0 WHERE id = ?').bind(f.identity.eventId).run();
    expect((await repo.acceptPart(f.identity,proof,claim,'etag',f.now)).ok).toBe(false);
    await env.DB.prepare('UPDATE events SET uploads_enabled = 1 WHERE id = ?').bind(f.identity.eventId).run();
    await env.DB.prepare("UPDATE mobile_image_admission SET enabled = 0,revision = revision + 1 WHERE case_id = 'png'").run();
    expect((await repo.acceptPart(f.identity,proof,claim,'etag',f.now)).ok).toBe(true);
    expect(await repo.getOwned(f.identity,plus(f.now,901))).toEqual({ok:false,reason:'expired'});
    expect((await repo.fenceOwned(f.identity,'expired',plus(f.now,901))).ok).toBe(true);
  });

  it('fences delayed part and multipart-create results on permanent media deletion', async () => {
    const f = await reservedTransfer(); const repo = store(); value(await repo.initiate(f.input));
    const a = value(await repo.createAssemblyIntent(f.identity,f.now));
    expect(value(await repo.createAssemblyIntent(f.identity,f.now))).toEqual(a);
    const claim = claimValue(await repo.claimPart(f.identity,proof,f.now));
    await env.DB.prepare("UPDATE media SET deleted_at = ?,upload_state = 'deleted' WHERE id = ?").bind(f.now,f.identity.mediaId).run();
    expect((await repo.acceptPart(f.identity,proof,claim,'late-etag',f.now)).ok).toBe(false);
    expect(await repo.recordAssemblyCreated(a,'late-upload-id',f.now)).toBe(true);
    expect(await env.DB.prepare('SELECT state,multipart_upload_id,suppression_started_at FROM media_upload_assemblies').first()).toEqual({state:'suppressed',multipart_upload_id:'late-upload-id',suppression_started_at:f.now});
    await expect(env.DB.prepare('DELETE FROM media_upload_assemblies').run()).rejects.toThrow('cleanup unproved');
    await expect(env.DB.prepare('DELETE FROM media_upload_parts').run()).rejects.toThrow('writer unsettled');
    await expect(env.DB.prepare('DELETE FROM media_upload_transfers').run()).rejects.toThrow();
    await expect(env.DB.prepare('DELETE FROM events WHERE id = ?').bind(f.identity.eventId).run()).rejects.toThrow('inventory must settle');
  });

  it('claims completion once and records only the current matching decoder proof', async () => {
    const f = await completion();
    expect((await f.repo.claimCompletion(f.identity,f.now)).ok).toBe(false);
    const processing = new MediaProcessingRepository(env.DB);
    const inspection = decoderInspection({family:'png',byteSize:64,sourceSha256:TEST_SHA,buildFingerprint:TEST_FINGERPRINT});
    expect(await processing.recordInspection(f.identity,{...f.completionClaim,token:'stale'},inspection,f.now)).toBe(false);
    expect(await processing.recordInspection(f.identity,f.completionClaim,{...inspection,buildFingerprint:'c'.repeat(64)},f.now)).toBe(false);
    expect(await processing.recordInspection(f.identity,f.completionClaim,inspection,f.now)).toBe(true);
    expect(await processing.recordInspection(f.identity,f.completionClaim,{...inspection,sourceSha256:'d'.repeat(64)},f.now)).toBe(false);
    value(await f.repo.fenceOwned(f.identity,'aborted',f.now));
    expect(await processing.recordInspection(f.identity,f.completionClaim,inspection,f.now)).toBe(false);
    expect(await env.DB.prepare('SELECT state FROM media_processing').first()).toEqual({state:'suppressed'});
  });

  it('coalesces preview writers before R2 and protects ready/trashed derivatives from suppression', async () => {
    const access = await eventAccess(); const media = await uploadPending(access,'preview');
    const now = new Date().toISOString(); const repo = new ImagePreviewRepository(env.DB);
    const input = {mediaId:media.id,eventId:access.event.id,sourceSha256:TEST_SHA,profile:'mobile-preview-v1',mimeType:'image/webp' as const,now,leaseExpiresAt:plus(now,180)};
    const claim = await repo.claim(input); expect(claim?.claimed).toBe(true);
    const second = await repo.claim(input); expect(second).toEqual({claimed:false,record:claim!.record});
    const record = claim!.record;
    expect(await env.DB.prepare('SELECT object_kind,bucket_generation,media_id FROM media_object_write_tombstones WHERE object_key = ?').bind(record.objectKey).first()).toEqual({object_kind:'preview',bucket_generation:'canonical',media_id:media.id});
    expect(await repo.markReady(record,{byteSize:10,sha256:TEST_SHA,etag:'preview-etag',width:40,height:30,frameCount:1},now)).toBe(true);
    await trashMedia(access,media.id);
    expect((await repo.get(record.id))?.state).toBe('ready');
    await expect(env.DB.prepare('UPDATE media_object_write_tombstones SET suppression_started_at = ? WHERE object_key = ?').bind(now,record.objectKey).run()).rejects.toThrow('owner retained');
    await expect(env.DB.prepare('DELETE FROM media_image_previews WHERE id = ?').bind(record.id).run()).rejects.toThrow();
  });

  it('retains a suppressed preview writer through deletion until settlement and absence proof', async () => {
    const f = await reservedTransfer(); const now = f.now; const repo = new ImagePreviewRepository(env.DB);
    const claim = await repo.claim({mediaId:f.identity.mediaId,eventId:f.identity.eventId,sourceSha256:TEST_SHA,profile:'mobile-preview-v1',mimeType:'image/webp',now,leaseExpiresAt:plus(now,180)});
    const record = claim!.record;
    await env.DB.prepare('UPDATE events SET deleted_at = ? WHERE id = ?').bind(now,f.identity.eventId).run();
    expect(await repo.markReady(record,{byteSize:10,sha256:TEST_SHA,etag:'late',width:4,height:3,frameCount:1},now)).toBe(false);
    await env.DB.prepare('UPDATE media_object_write_tombstones SET suppression_started_at = ? WHERE object_key = ?').bind(now,record.objectKey).run();
    expect(await repo.recordAbsence(record,now)).toBe(false);
    await expect(env.DB.prepare('DELETE FROM media_image_previews').run()).rejects.toThrow();
    expect(await repo.settleWriter(record,now)).toBe(true);
    expect(await repo.recordAbsence(record,now)).toBe(true);
    expect((await env.DB.prepare('DELETE FROM media_image_previews WHERE id = ?').bind(record.id).run()).meta.changes).toBe(1);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM media_object_write_tombstones WHERE object_key = ?').bind(record.objectKey).first()).toEqual({n:1});
  });

  it('uses a new immutable key on preview replacement and cannot block the original commit', async () => {
    const f = await reservedTransfer(); const repo = new ImagePreviewRepository(env.DB);
    const input = {mediaId:f.identity.mediaId,eventId:f.identity.eventId,sourceSha256:TEST_SHA,profile:'mobile-preview-v1',mimeType:'image/webp' as const,now:f.now,leaseExpiresAt:plus(f.now,180)};
    const first = (await repo.claim(input))!.record;
    await repo.suppress(first,f.now);
    await env.DB.prepare('UPDATE media_object_write_tombstones SET suppression_started_at = ? WHERE object_key = ?').bind(f.now,first.objectKey).run();
    const second = (await repo.claim(input))!.record;
    expect(second.generation).toBe(2);
    expect(second.objectKey).not.toBe(first.objectKey);
    await expect(env.DB.prepare('UPDATE media SET upload_state = upload_state WHERE id = ?').bind(f.identity.mediaId).run()).resolves.toBeDefined();
    await repo.settleWriter(first,f.now); await repo.recordAbsence(first,f.now);
    await expect(env.DB.prepare('DELETE FROM media_image_previews WHERE id = ?').bind(first.id).run()).rejects.toThrow('retained');
  });

  it('clamps successful progress to the original authority deadline', async () => {
    const f = await reservedTransfer(PART_BYTES+1); const repo = store();
    await env.DB.prepare('UPDATE event_sessions SET expires_at = ? WHERE id = ?').bind(plus(f.now,1000),f.identity.authority.actorSessionId).run();
    const t = value(await repo.initiate(f.input));
    expect(t.hardExpiresAt).toBe(plus(f.now,1000));
    const first = {...proof,byteSize:PART_BYTES};
    const claim = claimValue(await repo.claimPart(f.identity,first,plus(f.now,750)));
    value(await repo.acceptPart(f.identity,first,claim,'etag',plus(f.now,800)));
    expect(value(await repo.getOwned(f.identity,plus(f.now,800))).expiresAt).toBe(t.hardExpiresAt);
    const last = {...proof,index:1,byteSize:1};
    const lastClaim = claimValue(await repo.claimPart(f.identity,last,plus(f.now,950)));
    expect(lastClaim.leaseExpiresAt).toBe(t.hardExpiresAt);
  });
});

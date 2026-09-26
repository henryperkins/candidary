import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../worker/app';
import { EventsRepository } from '../../worker/db/events';
import { getCaseAdmission, getUploadCapabilities } from '../../worker/mobile-image-release';
import { LEGACY_UPLOAD_MIME_TYPES } from '../../shared/image-formats';
import { requiredCasesFor } from '../../shared/image-decoder-contract';
import { eventAccess, migrationsUpTo, png, resetDatabase, testEnv, writeHeaders } from './helpers';
import { reservedTransfer, TEST_FINGERPRINT } from './fixtures/mobile-image-db';
import { UploadTransferRepository } from '../../worker/db/upload-transfers';
import { getUploadCapabilities as productionCapabilities } from '../../output/verification/mobile-image-baseline/production-mobile-release.mjs';
import { primaryHeif } from '../fixtures/image-container-builders';
import { createTransferHarness,sha256,transportDng } from './fixtures/upload-transfer';
import { createDecoderDouble,decoderInspection } from './fixtures/image-decoder';
import committedDecoderRelease from '../../config/image-decoder-release.json';

beforeEach(resetDatabase);
afterEach(() => { globalThis.__CANDIDARY_TEST_MOBILE_IMAGE_RELEASE_OVERRIDE__ = undefined; vi.restoreAllMocks(); });
const required = [...requiredCasesFor('dng',false),...requiredCasesFor('png',false)];
function fixtureRelease() {
  return {
    decoderRelease:{protocolVersion:1,previewProfile:'mobile-preview-v1',releases:[{imageRef:`registry.example/decoder@sha256:${'b'.repeat(64)}`,buildFingerprint:TEST_FINGERPRINT,protocolVersion:1,previewProfile:'mobile-preview-v1',verifiedCaseIds:required,evidenceSha256:'c'.repeat(64)}]},
    mobileRelease:{kind:'candidary.mobile-image-release',schemaVersion:26,protocolVersion:1,previewProfile:'mobile-preview-v1',maxOriginalBytes:512*1024**2,
      cases:required.map((caseId) => ({caseId,buildFingerprint:TEST_FINGERPRINT,evidenceSha256:'d'.repeat(64),maxOriginalBytes:512*1024**2}))},
  };
}
function decoderEnvironment(options: {fingerprint?:string;twin?:string;unavailable?:boolean} = {}) {
  const calls: Request[] = [];
  const IMAGE_DECODER = {fetch:vi.fn(async (request:Request) => {
    calls.push(request);
    return options.unavailable ? new Response(null,{status:503}) : Response.json({protocolVersion:1,buildFingerprint:options.fingerprint ?? TEST_FINGERPRINT,decoderVersion:'test-double-1'}, {headers:{'X-Decoder-Protocol':'1','X-Decoder-Environment':options.twin ?? 'production'}});
  })};
  return {calls,environment:Object.assign(Object.create(testEnv),{IMAGE_DECODER,IMAGE_DECODER_ENVIRONMENT:'production'}) as typeof testEnv};
}
async function qualify() {
  globalThis.__CANDIDARY_TEST_MOBILE_IMAGE_RELEASE_OVERRIDE__ = fixtureRelease();
  for (const caseId of required) await env.DB.prepare('UPDATE mobile_image_admission SET enabled = 1,revision = revision + 1 WHERE case_id = ?').bind(caseId).run();
}
async function caps(environment = testEnv) {
  const access = await eventAccess();
  const event = await new EventsRepository(env.DB).getById(access.event.id);
  if (!event) throw new Error('Missing event.');
  return getUploadCapabilities(environment,event,{kind:'guest'});
}
function reservation(access: Awaited<ReturnType<typeof eventAccess>>, environment = testEnv, patch: Record<string,unknown> = {}) {
  return createApp().request(`/api/event/${access.event.slug}/uploads`,{method:'POST',headers:writeHeaders(access.guest),body:JSON.stringify({filename:'original.dng',mimeType:'image/dng',byteSize:64,idempotencyKey:crypto.randomUUID(),guestName:'Avery',transport:'parts-v1',...patch})},environment);
}

describe('mobile image admission intersection', () => {
  it('includes the delivered transfer on reservation replay so reselected bytes must be proved',async () => {
    const bytes=new Uint8Array([1,2,3]); const h=await createTransferHarness({realStorage:true});
    await h.reserve(bytes,transportDng); await h.putPart(0,bytes);
    const decoder=createDecoderDouble({inspection:decoderInspection({family:'dng',byteSize:3,sourceSha256:await sha256(bytes),buildFingerprint:TEST_FINGERPRINT}),previewBytes:new Uint8Array([4,5,6]),
      transformResponse:response => {response.headers.set('X-Decoder-Environment','production'); return response;}});
    h.setDecoder(decoder.fetch); await h.complete(); await h.runCompletion();
    const row=await env.DB.prepare('SELECT idempotency_key FROM media WHERE id=?').bind(h.identity.mediaId).first<{idempotency_key:string}>();
    await env.DB.prepare('UPDATE mobile_image_admission SET enabled=0,revision=revision+1').run();
    const response=await reservation(h.access,h.environment,{idempotencyKey:row!.idempotency_key,byteSize:3});
    expect(response.status).toBe(201); const result=(await response.json<any>()).data;
    expect(result.media.uploadState).toBe('stored'); expect(result.alreadyDelivered).toBe(true);
    expect(result.transfer).toMatchObject({id:h.identity.transferId,state:'delivered',acceptedParts:[0]});
  });
  it('replays a pinned transfer after admission closes without reserving more quota', async () => {
    await qualify(); const fake = decoderEnvironment(); const access = await eventAccess();
    const first = await reservation(access,fake.environment,{idempotencyKey:'resume-pinned'});
    const original = (await first.json<any>()).data;
    await env.DB.prepare('UPDATE mobile_image_admission SET enabled = 0,revision = revision + 1').run();
    const replay = await reservation(access,fake.environment,{idempotencyKey:'resume-pinned'});
    expect(replay.status).toBe(201);
    expect((await replay.json<any>()).data.transfer.id).toBe(original.transfer.id);
    expect((await reservation(access,fake.environment,{idempotencyKey:'resume-pinned',byteSize:65})).status).toBe(409);
    expect((await reservation(access,fake.environment)).status).toBe(415);
    expect(await env.DB.prepare('SELECT reserved_media_count FROM events WHERE id = ?').bind(access.event.id).first()).toEqual({reserved_media_count:1});
  });
  it('stays on the exact legacy formats when committed evidence is absent, even if D1 is enabled', async () => {
    // The committed files may hold preview candidate or released records, so state the premise explicitly.
    globalThis.__CANDIDARY_TEST_MOBILE_IMAGE_RELEASE_OVERRIDE__ = {
      decoderRelease:{protocolVersion:1,previewProfile:'mobile-preview-v1',releases:[]},
      mobileRelease:{kind:'candidary.mobile-image-release',schemaVersion:26,protocolVersion:1,previewProfile:'mobile-preview-v1',maxOriginalBytes:512*1024**2,cases:[]},
    };
    await env.DB.prepare('UPDATE mobile_image_admission SET enabled = 1,revision = revision + 1').run();
    const fake = decoderEnvironment();
    expect((await caps(fake.environment)).mimeTypes).toEqual([...LEGACY_UPLOAD_MIME_TYPES]);
    expect(fake.calls).toHaveLength(0);
    expect((await getCaseAdmission('dng-bayer',fake.environment)).enabled).toBe(false);
  });

  it('cannot activate the production bundle with either global test flag', async () => {
    await qualify(); const fake = decoderEnvironment(); const access = await eventAccess();
    const event = await new EventsRepository(env.DB).getById(access.event.id);
    const previous = Object.getOwnPropertyDescriptor(globalThis,'__CANDIDARY_TEST_MOBILE_IMAGE_RELEASE__');
    Object.defineProperty(globalThis,'__CANDIDARY_TEST_MOBILE_IMAGE_RELEASE__',{configurable:true,value:true});
    try {
      // The override qualifies TEST_FINGERPRINT, which the double reports. A production bundle that honored it
      // would open DNG/PNG; committed records never name that fingerprint, so only a health probe may happen.
      expect((committedDecoderRelease.releases as Array<{buildFingerprint:string}>).some((release) => release.buildFingerprint === TEST_FINGERPRINT)).toBe(false);
      expect((await productionCapabilities(fake.environment,event!,{kind:'guest'})).mimeTypes).toEqual([...LEGACY_UPLOAD_MIME_TYPES]);
      expect(fake.calls.every((request) => new URL(request.url).pathname === '/health')).toBe(true);
    } finally {
      if (previous) Object.defineProperty(globalThis,'__CANDIDARY_TEST_MOBILE_IMAGE_RELEASE__',previous);
      else Reflect.deleteProperty(globalThis,'__CANDIDARY_TEST_MOBILE_IMAGE_RELEASE__');
    }
  });

  it('requires every implicated case and qualified fingerprint, and rejects the wrong environment twin', async () => {
    await qualify();
    const fake = decoderEnvironment();
    expect((await caps(fake.environment)).mimeTypes).toContain('image/dng');
    expect((await getCaseAdmission('dng-bayer',fake.environment)).qualifiedFingerprints).toEqual([TEST_FINGERPRINT]);
    for (const candidate of [decoderEnvironment({fingerprint:'e'.repeat(64)}),decoderEnvironment({twin:'preview'}),decoderEnvironment({unavailable:true})]) {
      expect((await caps(candidate.environment)).mimeTypes).not.toContain('image/dng');
    }
    await env.DB.prepare("UPDATE mobile_image_admission SET enabled = 0,revision = revision + 1 WHERE case_id = 'dng-proraw-jxl'").run();
    expect((await caps(fake.environment)).mimeTypes).not.toContain('image/dng');
    await qualify();
    const missing = fixtureRelease(); missing.decoderRelease.releases[0]!.verifiedCaseIds = ['dng-bayer'];
    globalThis.__CANDIDARY_TEST_MOBILE_IMAGE_RELEASE_OVERRIDE__ = missing;
    expect((await caps(fake.environment)).mimeTypes).not.toContain('image/dng');
  });

  it('falls back on the old schema and ignores request, binding and global lookalike overrides', async () => {
    await reset(); await applyD1Migrations(env.DB,migrationsUpTo('0026'));
    globalThis.__CANDIDARY_TEST_MOBILE_IMAGE_RELEASE_OVERRIDE__ = fixtureRelease();
    const fake = decoderEnvironment();
    expect((await caps(fake.environment)).mimeTypes).toEqual([...LEGACY_UPLOAD_MIME_TYPES]);
    expect(fake.calls).toHaveLength(0);
    const access = await eventAccess();
    expect((await reservation(access,fake.environment,{admitted:true})).status).toBe(422);
    const direct = await reservation(access,fake.environment,{filename:'old-schema.png',mimeType:'image/png',transport:undefined});
    expect(direct.status).toBe(201);
    const directData = (await direct.json<any>()).data;
    expect((await createApp().request(directData.uploadUrl,{method:'PUT',headers:{...writeHeaders(access.guest),'content-type':'image/png','content-length':'64'},body:png()},fake.environment)).status).toBe(200);
    globalThis.__CANDIDARY_TEST_MOBILE_IMAGE_RELEASE_OVERRIDE__ = undefined;
    const bound = Object.assign(Object.create(fake.environment),{MOBILE_IMAGE_RELEASE:fixtureRelease(),MOBILE_IMAGE_ENABLED:true});
    expect((await caps(bound)).mimeTypes).not.toContain('image/dng');
  });

  it('serves private guest and manager capabilities without accepting cross-event credentials', async () => {
    const access = await eventAccess(); const other = await eventAccess('Other');
    for (const [path,cookie] of [[`/api/event/${access.event.slug}/uploads/capabilities`,access.guest.cookie],[`/api/manage/events/${access.event.id}/uploads/capabilities`,access.manager.cookie]]) {
      const response = await createApp().request(path!,{headers:{cookie:cookie!}},testEnv);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(response.headers.get('vary')).toBe('Cookie');
      const body = await response.json<any>();
      expect(Object.keys(body.data).sort()).toEqual(['directMaxBytes','extensions','maxOriginalBytes','mimeTypes','partBytes']);
      expect(body.data.mimeTypes).toEqual([...LEGACY_UPLOAD_MIME_TYPES]);
      expect((await createApp().request(path!,{headers:{cookie:other.guest.cookie}},testEnv)).status).toBe(403);
    }
  });

  it('requires parts negotiation for qualified extended intake and returns only the transfer allowlist', async () => {
    await qualify(); const fake = decoderEnvironment(); const access = await eventAccess();
    expect((await reservation(access,fake.environment,{transport:undefined})).status).toBe(415);
    const admitted = await reservation(access,fake.environment,{idempotencyKey:'new-original'});
    expect(admitted.status).toBe(201);
    const {data} = await admitted.json<any>();
    expect(data.transport).toBe('parts-v1');
    expect(data.media.uploadState).toBe('reserved');
    expect(Object.keys(data.media).sort()).toEqual(['id','mimeType','uploadState']);
    expect(Object.keys(data.transfer).sort()).toEqual(['acceptedParts','expiresAt','hardExpiresAt','id','mediaId','partBytes','partCount','previewState','state']);
    expect(data.uploadUrl).toBeUndefined();
    const replay = await reservation(access,fake.environment,{idempotencyKey:'new-original'});
    expect((await replay.json<any>()).data.transfer.id).toBe(data.transfer.id);
    expect(await env.DB.prepare('SELECT reserved_media_count FROM events WHERE id = ?').bind(access.event.id).first()).toEqual({reserved_media_count:1});
  });

  it('does not reserve quota if an implicated case closes while health is in flight', async () => {
    await qualify(); const access = await eventAccess(); const fake = decoderEnvironment();
    const forwarding = fake.environment.IMAGE_DECODER.fetch.bind(fake.environment.IMAGE_DECODER);
    const environment = Object.assign(Object.create(fake.environment),{IMAGE_DECODER:{fetch:async (request:Request) => {
      await env.DB.prepare("UPDATE mobile_image_admission SET enabled = 0,revision = revision + 1 WHERE case_id = 'dng-proraw-jxl'").run();
      return forwarding(request);
    }}});
    expect((await reservation(access,environment)).status).toBe(415);
    expect(await env.DB.prepare('SELECT reserved_media_count,reserved_bytes FROM events WHERE id = ?').bind(access.event.id).first()).toEqual({reserved_media_count:0,reserved_bytes:0});
    expect(await env.DB.prepare('SELECT count(*) AS n FROM media WHERE event_id = ?').bind(access.event.id).first()).toEqual({n:0});
  });

  it('negotiates manager batches and larger baseline originals without adding fields to direct items', async () => {
    await qualify(); const fake = decoderEnvironment(); const access = await eventAccess();
    const response = await createApp().request(`/api/manage/events/${access.event.id}/uploads/batch`,{method:'POST',headers:writeHeaders(access.manager),body:JSON.stringify({files:[
      {filename:'raw.dng',mimeType:'image/dng',byteSize:64,idempotencyKey:'raw',transport:'parts-v1'},
      {filename:'large.png',mimeType:'image/png',byteSize:21*1024**2,idempotencyKey:'large',transport:'parts-v1'},
      {filename:'small.png',mimeType:'image/png',byteSize:64,idempotencyKey:'small',transport:'parts-v1'},
    ]})},fake.environment);
    expect(response.status).toBe(201);
    const items = (await response.json<any>()).data.items;
    expect(items.map((item:any) => [item.status,item.transport,item.transfer?.partCount])).toEqual([['accepted','parts-v1',1],['accepted','parts-v1',3],['accepted',undefined,undefined]]);
    expect(items[2].uploadUrl).toMatch(/\/content$/u);
  });

  it('delivers identical 12 MiB JPEG and HEIC parser-fixture bytes through direct ingress during decoder failure', async () => {
    await qualify(); const fake = decoderEnvironment({unavailable:true}); const access = await eventAccess();
    for (const mimeType of ['image/jpeg','image/heic']) {
      const response = await reservation(access,fake.environment,{filename:`original.${mimeType.slice(6)}`,mimeType,byteSize:12*1024**2});
      expect(response.status).toBe(201);
      const {data} = await response.json<any>();
      expect(data.uploadUrl).toMatch(/\/content$/u);
      expect(data.transfer).toBeUndefined();
      // Structural routing fixtures only; these do not qualify native codecs.
      const bytes = new Uint8Array(12*1024**2);
      if (mimeType === 'image/jpeg') bytes.set([0xff,0xd8,0xff,0xc0,0,11,8,0,8,0,10,1,1,0x11,0,0xff,0xd9]);
      else {
        const header = primaryHeif({primaryId:1,items:[{id:1,width:1280,height:854}]});
        bytes.set(header);
        new DataView(bytes.buffer).setUint32(header.length,bytes.length-header.length);
        bytes.set(new TextEncoder().encode('free'),header.length+4);
      }
      const expectedHash = await crypto.subtle.digest('SHA-256',bytes);
      const delivered = await createApp().request(data.uploadUrl,{method:'PUT',headers:{...writeHeaders(access.guest),'content-type':mimeType,'content-length':String(bytes.byteLength)},body:bytes},fake.environment);
      expect(delivered.status).toBe(200);
      const row = await env.DB.prepare('SELECT object_key FROM media WHERE id = ?').bind(data.media.id).first<{object_key:string}>();
      const stored = await env.CANONICAL_MEDIA_BUCKET.get(row!.object_key);
      expect(new Uint8Array(await crypto.subtle.digest('SHA-256',await stored!.arrayBuffer()))).toEqual(new Uint8Array(expectedHash));
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('rejects recognized new families and transfer-owned reservations before legacy PUT body reads', async () => {
    const f = await reservedTransfer();
    const repo = new UploadTransferRepository(env.DB,{buildFingerprint:TEST_FINGERPRINT,caseId:'png'});
    expect((await repo.initiate(f.input)).ok).toBe(true);
    const send = async (mimeType:string) => {
      const spy = vi.spyOn(Request.prototype,'arrayBuffer');
      const response = await createApp().request(`/api/event/${f.access.event.slug}/uploads/${f.identity.mediaId}/content`,{method:'PUT',headers:{...writeHeaders(f.access.guest),'content-type':mimeType,'content-length':'64'},body:png()},testEnv);
      expect(response.status).toBe(mimeType === 'image/png' ? 409 : 415);
      expect(spy).not.toHaveBeenCalled(); spy.mockRestore();
    };
    await send('image/png');
    await env.DB.prepare("UPDATE media SET mime_type = 'image/avif' WHERE id = ?").bind(f.identity.mediaId).run();
    await send('image/avif');
    expect(await env.CANONICAL_MEDIA_BUCKET.list()).toMatchObject({objects:[]});
  });
});

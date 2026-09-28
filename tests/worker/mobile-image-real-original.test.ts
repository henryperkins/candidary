import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { unzipSync } from 'fflate';
import { createApp } from '../../worker/app';
import { AuthService } from '../../worker/auth/service';
import { PhotoExportsRepository } from '../../worker/db/photo-exports';
import { ExportsRepository } from '../../worker/db/exports';
import { processExport } from '../../worker/workflows/export';
import { sha256ImageStream } from '../../worker/storage/image-source';
import { requiredCasesFor } from '../../shared/image-decoder-contract';
import manifest from '../fixtures/mobile-images/manifest.json';
import { createTransferHarness, sha256, transportDng } from './fixtures/upload-transfer';
import { bridgeFetch, createNativeDecoder, nativeBridgeEnabled, nativeReadiness, nativeRelease, type NativeIdentity } from './fixtures/native-decoder-bridge';
import { eventAccess, resetDatabase, secondGuest, testEnv, writeHeaders } from './helpers';
import type { DecoderHealth } from '../../shared/image-decoder-contract';

// Local integration only: Miniflare D1/R2 plus the actual adapter, private router and native
// server in a disposable local container. Not deployed-service, load or physical-device proof.
const PART = 8 * 1024 ** 2;
const DIRECT_MAX = 20 * 1024 ** 2;
const WARM_READS = 5;
const originals = [
  { fixtureId: 'raw-pixls-iphone-12-pro', caseId: 'dng-proraw', byteSize: 29_195_592, principal: 'guest', manager: false },
  { fixtureId: 'raw-pixls-galaxy-s23-ultra', caseId: 'dng-linear', byteSize: 31_311_854, principal: 'manager-link', manager: true },
] as const;
type Fixture = { id: string; sha256: string; synthetic: boolean; evidence: { local: { sha256: string } | null } };
const fixtures = (manifest as unknown as { cases: Array<{ id: string; fixtures: Fixture[] }> }).cases
  .flatMap((record) => record.fixtures.map((fixture) => ({ ...fixture, caseId: record.id })));

/** Bounded RIFF walk: canvas dimensions and the chunks that could carry metadata. */
function webpFacts(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fourcc = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (bytes.byteLength < 20 || fourcc(0) !== 'RIFF' || fourcc(8) !== 'WEBP' || view.getUint32(4, true) + 8 !== bytes.byteLength) throw new Error('Incomplete WebP.');
  const chunks: string[] = []; let width = 0; let height = 0; let flags = 0;
  for (let offset = 12; offset < bytes.byteLength;) {
    const type = fourcc(offset); const size = view.getUint32(offset + 4, true); const data = offset + 8;
    if (data + size > bytes.byteLength || chunks.length > 64) throw new Error('Malformed WebP chunk.');
    chunks.push(type);
    if (type === 'VP8X') { flags = bytes[data]!; width = 1 + (view.getUint32(data + 4, true) & 0xffffff); height = 1 + (view.getUint32(data + 7, true) & 0xffffff); }
    else if (type === 'VP8L' && !width) { const bits = view.getUint32(data + 1, true); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1; }
    else if (type === 'VP8 ' && !width) { width = view.getUint16(data + 6, true) & 0x3fff; height = view.getUint16(data + 8, true) & 0x3fff; }
    offset = data + size + (size & 1);
  }
  return { width, height, chunks, metadataFlags: (flags & 0x0c) !== 0 };
}

describe.skipIf(!nativeBridgeEnabled)('real camera originals through the actual native decoder (local integration)', () => {
  let native!: { health: DecoderHealth; identity: NativeIdentity };
  const results: Record<string, unknown>[] = [];
  beforeAll(async () => { native = await nativeReadiness(); }, 60_000);
  beforeEach(resetDatabase);
  afterEach(() => { vi.restoreAllMocks(); globalThis.__CANDIDARY_TEST_MOBILE_IMAGE_RELEASE_OVERRIDE__ = undefined; });

  it.each(originals)('$fixtureId ($principal) delivers, previews privately and exports byte-identically', async (original) => {
    const fixture = fixtures.find((entry) => entry.id === original.fixtureId)!;
    expect(fixture).toMatchObject({ caseId: original.caseId, synthetic: false });
    const source = await bridgeFetch(`/fixture/${original.fixtureId}`); expect(source.status).toBe(200);
    const bytes = new Uint8Array(await source.arrayBuffer()); const digest = await sha256(bytes);
    expect(digest).toBe(fixture.sha256); expect(bytes.byteLength).toBe(original.byteSize); expect(bytes.byteLength).toBeGreaterThan(DIRECT_MAX);

    const h = await createTransferHarness({ manager: original.manager, realStorage: true, fingerprint: native.health.buildFingerprint });
    const decoder = createNativeDecoder({ environment: 'production',
      release: nativeRelease(native.health.buildFingerprint, native.identity.imageId, fixture.evidence.local!.sha256, 'dng') });
    h.setDecoder(decoder.fetch);
    const partCount = Math.ceil(bytes.byteLength / PART);
    const reserved = await h.reserve(bytes, transportDng);
    expect(reserved.transfer).toMatchObject({ partBytes: PART, partCount, acceptedParts: [] });
    for (let index = 0; index < partCount; index++) expect((await h.putPart(index, bytes.slice(index * PART, (index + 1) * PART))).status).toBe(200);
    expect(decoder.decodes('upload')).toHaveLength(0);
    // Processing acknowledgement is not delivery or preview readiness.
    const acknowledged = await h.complete(); expect(acknowledged.status).toBe(202);
    expect((await acknowledged.json<any>()).data.media).toBeUndefined();
    expect((await (await h.status()).json<any>()).data).toMatchObject({ transfer: { state: 'processing', previewState: 'pending' } });
    const started = Date.now(); await h.runCompletion(); const completionMs = Date.now() - started;

    const status = await (await h.status()).json<any>();
    expect(status.data.transfer).toMatchObject({ state: 'delivered', previewState: 'ready', partCount, acceptedParts: [...Array(partCount).keys()] });
    expect(status.data.media).toMatchObject({ id: h.identity.mediaId, uploadState: 'stored' });
    const [decode, ...extra] = decoder.decodes('upload');
    expect(extra).toEqual([]); expect(decode).toMatchObject({ path: '/v1/preview', status: 200 });
    expect(decoder.calls.filter((call) => call.lane === 'preview')).toEqual([]);
    const nativePreview = decode!.preview!;
    expect(nativePreview.contentType).toBe('image/webp'); expect(nativePreview.frames).toBe(1);
    expect(Math.max(nativePreview.width, nativePreview.height)).toBeLessThanOrEqual(1600);

    const media = await testEnv.DB.prepare('SELECT object_key,byte_size,mime_type FROM media WHERE id=?').bind(h.identity.mediaId).first<any>();
    expect(media).toMatchObject({ byte_size: bytes.byteLength, mime_type: 'image/dng' });
    const assembly = await h.assembly();
    const processing = await testEnv.DB.prepare('SELECT * FROM media_processing WHERE media_id=?').bind(h.identity.mediaId).first<any>();
    expect(processing).toMatchObject({ state: 'ready', actual_family: 'dng', frame_count: 1, is_sequence: 0, source_sha256: digest,
      byte_size: bytes.byteLength, build_fingerprint: native.health.buildFingerprint, preview_profile: 'mobile-preview-v1' });
    const proof = await testEnv.DB.prepare("SELECT * FROM media_image_previews WHERE media_id=? AND state<>'suppressed'").bind(h.identity.mediaId).first<any>();
    expect(proof).toMatchObject({ state: 'ready', source_sha256: digest, profile: 'mobile-preview-v1', mime_type: 'image/webp', producer_kind: 'upload',
      byte_size: nativePreview.contentLength, width: nativePreview.width, height: nativePreview.height, frame_count: 1 });
    // Guest-facing wire data carries readiness only: no keys, hashes or native identity.
    const wire = JSON.stringify(status);
    for (const secret of [digest, proof.sha256, proof.object_key, media.object_key, assembly.object_key, native.health.buildFingerprint, native.health.decoderVersion]) expect(wire).not.toContain(secret);

    const get = vi.spyOn(testEnv.CANONICAL_MEDIA_BUCKET, 'get');
    const nativeCalls = decoder.calls.length;
    const readPreview = (cookie: string) => h.request(`/api/media/${h.identity.mediaId}/preview`, { headers: { cookie } });
    let previewBytes!: Uint8Array<ArrayBuffer>;
    for (let read = 0; read < WARM_READS; read++) {
      const response = await readPreview(h.credentials.cookie);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/webp');
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect([...response.headers.keys()].filter((name) => name.startsWith('x-decoder') || name.startsWith('x-preview'))).toEqual([]);
      previewBytes = new Uint8Array(await response.arrayBuffer());
      expect(previewBytes.byteLength).toBe(proof.byte_size); expect(await sha256(previewBytes)).toBe(proof.sha256);
    }
    const facts = webpFacts(previewBytes);
    expect({ width: facts.width, height: facts.height }).toEqual({ width: nativePreview.width, height: nativePreview.height });
    expect(facts.chunks).toContain('ICCP');
    expect(facts.chunks.filter((chunk) => chunk === 'EXIF' || chunk === 'XMP ')).toEqual([]); expect(facts.metadataFlags).toBe(false);
    expect(decoder.calls).toHaveLength(nativeCalls);
    expect(get.mock.calls.length).toBe(WARM_READS);
    expect(get.mock.calls.every(([key]) => key === proof.object_key)).toBe(true);
    get.mockRestore();

    const other = await eventAccess('Other event');
    const denied = original.manager
      ? [['same-event-guest', h.access.guest.cookie], ['other-event-manager', other.manager.cookie]]
      : [['same-event-second-guest', (await secondGuest(h.access.eventLink)).cookie], ['other-event-guest', other.guest.cookie]];
    const deniedPreviewReads: Array<{ principal: string; status: number }> = [];
    for (const [principal, cookie] of denied) {
      const response = await readPreview(cookie!); expect(response.status).toBe(403);
      deniedPreviewReads.push({ principal: principal!, status: response.status });
    }

    await testEnv.DB.prepare('UPDATE mobile_image_admission SET enabled=0,revision=revision+1').run();
    await testEnv.DB.prepare('UPDATE events SET uploads_enabled=0 WHERE id=?').bind(h.access.event.id).run();
    expect(await testEnv.DB.prepare('SELECT count(*) AS n FROM mobile_image_admission WHERE enabled=1').first<number>('n')).toBe(0);
    expect(await testEnv.DB.prepare('SELECT uploads_enabled FROM events WHERE id=?').bind(h.access.event.id).first<number>('uploads_enabled')).toBe(0);
    const direct = await h.request(`/api/media/${h.identity.mediaId}/original`, { headers: { cookie: h.access.manager.cookie } });
    expect(direct.status).toBe(200); expect(direct.headers.get('content-type')).toBe('image/dng');
    const directSha = await sha256ImageStream(direct.body!, bytes.byteLength); expect(directSha).toBe(digest);
    expect((await h.request(`/api/media/${h.identity.mediaId}/original`, { headers: writeHeaders(h.access.guest) })).status).toBe(403);

    const token = /candidary_session=([^;]+)/u.exec(h.access.manager.cookie)![1]!;
    const auth = await new AuthService(testEnv).resolve(token); const principal = `link:${auth.session.id}`;
    const now = new Date(); const repo = new PhotoExportsRepository(testEnv.DB);
    await testEnv.DB.prepare('UPDATE photo_export_admission SET enabled=1,worker_version_id=?,admitted_at=?').bind(crypto.randomUUID(), now.toISOString()).run();
    const create = async (destination: 'archive' | 'device') => repo.create({ eventId: h.access.event.id, principal, now: now.toISOString(),
      request: { version: 1, destination, idempotencyKey: crypto.randomUUID(), source: { mode: 'ids', scope: 'library', mediaIds: [h.identity.mediaId] } } });
    const device = await create('device'); await repo.confirm(h.access.event.id, device.id, principal, now.toISOString());
    const file = await createApp().request(`/api/manage/events/${h.access.event.id}/photo-exports/${device.id}/entries/${h.identity.mediaId}/file`, { headers: { cookie: h.access.manager.cookie } }, testEnv);
    expect(file.status).toBe(200); const deviceSha = await sha256ImageStream(file.body!, bytes.byteLength); expect(deviceSha).toBe(digest);
    await repo.cancel(h.access.event.id, device.id, principal, new Date().toISOString());
    const archive = await create('archive'); await repo.confirm(h.access.event.id, archive.id, principal, now.toISOString());
    expect((await processExport(testEnv, { jobId: archive.id, attempt: 1 }, now))?.state).toBe('ready');
    const part = (await new ExportsRepository(testEnv.DB).listParts(archive.id))[0]!;
    const members = unzipSync(new Uint8Array(await (await testEnv.MEDIA_BUCKET.get(part.objectKey))!.arrayBuffer()));
    expect(Object.keys(members)).toEqual(['photos/001-original.dng', 'media.csv']);
    const zipSha = await sha256(Uint8Array.from(members['photos/001-original.dng']!)); expect(zipSha).toBe(digest);
    expect(decoder.calls).toHaveLength(nativeCalls);

    results.push({ fixtureId: original.fixtureId, caseId: original.caseId, principal: original.principal,
      source: { sha256: digest, byteSize: bytes.byteLength, manifestSha256Match: digest === fixture.sha256, aboveDirectMaxBytes: DIRECT_MAX },
      transfer: { transport: 'parts-v1', partBytes: PART, partCount, directPath: false },
      receipt: { transferState: status.data.transfer.state, uploadState: status.data.media.uploadState, previewState: status.data.transfer.previewState },
      nativeCalls: { uploadDecodes: 1, previewDecodes: 0, uploadHealth: decoder.calls.filter((call) => call.lane === 'upload' && call.method === 'GET').length,
        decodeRoundTripMs: decode!.ms, completionMs },
      preview: { sha256: proof.sha256, byteSize: proof.byte_size, width: facts.width, height: facts.height, frames: 1, mimeType: 'image/webp',
        matchesNativeHeaders: true, iccProfile: true, exifOrXmp: false },
      warmReads: { count: WARM_READS, nativeCalls: 0, originalReads: 0 }, deniedPreviewReads, intakeClosed: true,
      original: { sha256Match: directSha === digest }, device: { sha256Match: deviceSha === digest },
      zip: { member: 'photos/001-original.dng', sha256Match: zipSha === digest } });
  // Two >28 MB authorized streams, an uncompressed ZIP and one native RAW decode.
  }, 240_000);

  it('records the local-integration evidence summary', async () => {
    expect(results.map((result) => result.fixtureId)).toEqual(originals.map((original) => original.fixtureId));
    const response = await bridgeFetch('/evidence/real-original-local', { method: 'POST', body: JSON.stringify({
      kind: 'local-integration', harnessVersion: 1, live: false, physicalDevice: false, test: 'tests/worker/mobile-image-real-original.test.ts',
      scope: 'Real >20 MiB camera originals through Miniflare D1/R2 multipart, completion, receipt, private preview, original, device export and ZIP, with the actual main adapter, private router and native server in a local container.',
      native: { buildFingerprint: native.health.buildFingerprint, decoderVersion: native.health.decoderVersion, dockerImageId: native.identity.imageId,
        imageName: native.identity.imageName, isolation: native.identity.isolation, logsEmptyAtStart: native.identity.logsEmpty },
      release: { source: 'test-local override', family: 'dng', caseIds: requiredCasesFor('dng', false),
        note: 'Any DNG declaration requires every DNG case; this override qualifies nothing beyond the fixture results listed here.' },
      results,
    }) });
    expect(response.status).toBe(201);
  });
});

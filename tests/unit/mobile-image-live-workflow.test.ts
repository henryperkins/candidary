import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Zip, ZipPassThrough } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_IMAGE_BYTES } from '../../shared/constants';
import { KNOWN_IMAGE_FORMATS, LEGACY_UPLOAD_MIME_TYPES, resolveImageDeclaration } from '../../shared/image-formats';
import type { KnownImageMimeType } from '../../shared/image-formats';
import { MOBILE_IMAGE_PART_BYTES } from '../../shared/mobile-image-contract';
import { PREVIEW_APPLICATION_ROOT_ORIGIN, isPreviewApplicationOrigin } from '../../shared/origins';
import { buildExportManifest } from '../../worker/export/csv';
import { partitionExportSnapshot } from '../../worker/export/partition';
import { exportPath, exportPathWidth } from '../../worker/export/paths';
import { buildExportZip, buildExportZipStream } from '../../worker/export/zip-stream';
import {
  DIRECT_MAX_BYTES, DIRECT_MIME_TYPES, LiveRefusal, MIME_BY_EXTENSION, PART_BYTES, PREVIEW_ROOT_ORIGIN,
  createLiveClient, isPreviewOrigin, parseExportManifest, readStoredZip, recordLiveWorkflow, runLiveWorkflow,
// @ts-expect-error Node live-workflow recorder is exercised through its runtime interface.
} from '../../scripts/mobile-image-live-workflow.mjs';
// @ts-expect-error Node corpus verifier's actual interface is tested here.
import { verifyCorpus } from '../../scripts/verify-mobile-image-corpus.mjs';

type Json = Record<string, any>;
const MiB = 1024 ** 2;
const ORIGIN = 'https://live-candidary-preview.lfd.workers.dev';
const EVENT_ID = 'live_event_0001';
const SLUG = 'live-rehearsal';
const ENTRY = `entry0001.${'e'.repeat(40)}`;
const MANAGE = `manage0001.${'m'.repeat(40)}`;
const IDENTITY = {
  buildFingerprint: 'b'.repeat(64),
  imageRef: `registry.example/decoder@sha256:${'c'.repeat(64)}`,
  workerVersionId: '0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0',
};
const script = resolve('scripts/mobile-image-live-workflow.mjs');
const confirm = { CANDIDARY_LIVE_WORKFLOW_CONFIRM: 'I_UNDERSTAND' };
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function pattern(size: number, seed: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index++) bytes[index] = (index * 31 + seed * 7 + (index >> 9)) & 255;
  return bytes;
}
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
const scratch: string[] = [];
afterEach(() => { scratch.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })); });

/* ------------------------------------------------------------ fixtures */

type Entry = { caseId: string; id: string; extension: string; bytes: Uint8Array<ArrayBuffer> };
const pngEntry: Entry = { caseId: 'png', id: 'unit-png', extension: 'png', bytes: png };

/** A throwaway corpus outside any Git work tree, shaped exactly like the committed manifest. */
function corpus(entries: Entry[]) {
  const root = mkdtempSync(join(tmpdir(), 'candidary-live-')); scratch.push(root);
  const evidence = join(root, 'evidence');
  mkdirSync(join(root, 'originals'), { recursive: true }); mkdirSync(evidence);
  const manifest = JSON.parse(readFileSync('tests/fixtures/mobile-images/manifest.json', 'utf8'));
  // Ignore the operator's local downloaded corpus when constructing unit controls.
  for (const record of manifest.cases) record.fixtures = [];
  const fixtures = entries.map(({ caseId, id, extension, bytes }) => {
    writeFileSync(join(root, 'originals', `${id}.${extension}`), bytes);
    const entry: Json = {
      id, path: `originals/${id}.${extension}`, sha256: sha(bytes), synthetic: false,
      provenance: { url: 'https://example.org/licensed-fixture', license: 'CC0-1.0', attribution: 'Unit fixture', redistributable: true, consent: true },
      capture: { device: 'unknown', os: 'unknown', settings: 'unknown' },
      encoded: { codec: extension, container: extension, width: 1, height: 1, orientation: 1, frames: 1 },
      reference: null, evidence: { local: null, live: null, android: null, ios: null },
    };
    manifest.cases.find((item: Json) => item.id === caseId).fixtures.push(entry);
    return entry;
  });
  const manifestPath = join(root, 'manifest.json');
  const save = () => writeFileSync(manifestPath, JSON.stringify(manifest));
  save();
  return { root, evidence, manifest, manifestPath, fixtures, save };
}
type Corpus = ReturnType<typeof corpus>;

/** A separately issued authorization and credential pair, each in its own private (untracked) file. */
function authorize(root: string, changes: Json = {}, credentials: Json = {}) {
  const dir = join(root, 'private'); mkdirSync(dir, { recursive: true });
  const credentialsPath = join(dir, `credentials-${randomUUID()}.json`);
  writeFileSync(credentialsPath, JSON.stringify({ kind: 'candidary.image-live-credentials', eventId: EVENT_ID, entryCredential: ENTRY, managementToken: MANAGE, ...credentials }));
  const authorizationPath = join(dir, `authorization-${randomUUID()}.json`);
  writeFileSync(authorizationPath, JSON.stringify({
    kind: 'candidary.mobile-image-live-authorization', version: 1, environment: 'preview', target: ORIGIN, owner: 'release-owner',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(), eventId: EVENT_ID, dedicatedLiveEvent: true, credentialsPath,
    identity: { ...IDENTITY }, caseIds: ['png'], ...changes,
  }));
  return { authorizationPath, credentialsPath };
}

function record(test: Corpus, authorizationPath: string, fetch: unknown, extra: Json = {}) {
  return recordLiveWorkflow({
    live: true, authorizationPath, manifestPath: test.manifestPath, outputDir: test.evidence, env: confirm, fetch,
    sleep: async () => {}, timeouts: { pollMs: 0 }, ...extra,
  });
}
function readDocument(test: Corpus, printed: Json): Json {
  const bytes = readFileSync(join(test.root, printed.pointer.path));
  expect(sha(bytes)).toBe(printed.pointer.sha256);
  return JSON.parse(bytes.toString('utf8'));
}
async function refusal(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (error) {
    if (error instanceof LiveRefusal) return (error as { code: string }).code;
    throw error;
  }
  throw new Error('Expected the recorder to refuse.');
}

/* ------------------------------------------------ fake Candidary (HTTP) */

type Session = { token: string; csrf: string; role: 'guest' | 'manager' };
type Item = {
  id: string; owner: string | null; mimeType: KnownImageMimeType; byteSize: number; filename: string;
  state: 'reserved' | 'stored' | 'deleted'; trashed: boolean; bytes: Uint8Array<ArrayBuffer> | null;
  parts: Map<number, Uint8Array<ArrayBuffer>>; transferId: string | null; transferState: string | null; polls: number; createdAt: string;
};
type Job = {
  id: string; state: 'queued' | 'running' | 'ready'; manifest: string; zips: Map<number, Uint8Array<ArrayBuffer>>;
  parts: Array<{ partNumber: number; mediaCount: number; sourceBytes: number }>;
};
type ServerOptions = {
  started?: boolean; admitted?: string[]; maxPartBytes?: number; prematureReceipt?: boolean; leakDenial?: boolean;
  foreignUploadUrl?: boolean; pauseBlocksDeletion?: boolean; sameGuestSession?: boolean; manifestTamper?: (csv: string) => string;
  directOnly?: boolean; refuseTypes?: string[];
};
type Logged = { method: string; url: string; origin: string | null; csrf: string | null; cookie: string | null };
const LEGACY = new Set<string>(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

/** Candidary's public route shapes, cookie scopes, Origin/CSRF rules and export writer, served in-process. */
function fakeCandidary(options: ServerOptions = {}) {
  const started = options.started ?? true;
  const admitted = options.admitted ?? ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/dng'];
  // Started events move between open and paused; events before their start between scheduled and open-early.
  const gate = { uploadsEnabled: !started, openEarly: false };
  const intake = () => (started
    ? { photosOpen: gate.uploadsEnabled, photoIntakeState: gate.uploadsEnabled ? 'open' : 'paused' }
    : { photosOpen: gate.openEarly, photoIntakeState: gate.openEarly ? 'open-early' : 'scheduled' });
  const sessions = new Map<string, Session>();
  const media = new Map<string, Item>();
  const jobs = new Map<string, Job>();
  const requests: Logged[] = [];
  const reservations: Array<{ mimeType: string; extension: string | undefined; transport: string | null }> = [];
  const intakeLog: Array<{ action: string; at: number }> = [];
  const violations: string[] = [];
  let sequence = 0;
  const nextId = (prefix: string) => `${prefix}-${++sequence}-${randomUUID()}`;
  // A photo from an earlier rehearsal shares the dedicated event and therefore every archive.
  const leftover = pattern(4096, 11);
  media.set('leftover-1', { id: 'leftover-1', owner: null, mimeType: 'image/jpeg', byteSize: leftover.length, filename: 'Earlier, "rehearsal".jpg',
    state: 'stored', trashed: false, bytes: leftover, parts: new Map(), transferId: null, transferState: null, polls: 0, createdAt: '2026-08-19T10:00:00.000Z' });

  const json = (data: unknown, status = 200) => Response.json({ data, requestId: randomUUID() }, { status });
  const error = (code: string, status: number, extra: Json = {}) => Response.json({ code, message: 'Refused.', requestId: randomUUID(), ...extra }, { status });
  const denial = (code: string, status: number, item: Item | undefined) => (options.leakDenial && item
    ? error(code, status, { detail: `media/${item.id}`, digest: sha(item.bytes ?? new Uint8Array(0)) }) : error(code, status));
  function mint(role: Session['role'], status: number, headers: Record<string, string>, body?: unknown, existing?: Session) {
    const created = existing ?? { token: randomUUID(), csrf: randomUUID(), role }; sessions.set(created.token, created);
    const response = body === undefined ? new Response(null, { status, headers }) : Response.json({ data: body, requestId: randomUUID() }, { status, headers });
    response.headers.append('Set-Cookie', `candidary_session=${created.token}; Path=/; HttpOnly; Secure; SameSite=Lax`);
    response.headers.append('Set-Cookie', `candidary_csrf=${created.csrf}; Path=/; Secure; SameSite=Lax`);
    return response;
  }
  function write(request: Request, actor: Session) {
    const ok = request.headers.get('origin') === ORIGIN && request.headers.get('x-candidary-csrf') === actor.csrf;
    if (!ok) violations.push(`${request.method} ${new URL(request.url).pathname}`);
    return ok;
  }
  const eventView = () => ({ id: EVENT_ID, slug: SLUG, name: 'Live rehearsal', ...intake() });
  const uploadView = (item: Item) => ({ id: item.id, mimeType: item.mimeType, uploadState: item.state });
  const transferView = (item: Item) => ({
    id: item.transferId, mediaId: item.id, state: item.transferState, partBytes: 8 * MiB, partCount: Math.ceil(item.byteSize / (8 * MiB)),
    acceptedParts: [...item.parts.keys()].sort((a, b) => a - b), expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    hardExpiresAt: new Date(Date.now() + 7200_000).toISOString(), previewState: item.transferState === 'delivered' ? 'ready' : 'pending',
  });
  const preview = pattern(12, 13);
  const image = () => new Response(preview.slice(), { headers: {
    'Content-Type': 'image/webp', 'Content-Length': String(preview.length), 'Cache-Control': 'private, no-store', Vary: 'Cookie',
    'Cross-Origin-Resource-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff' } });
  const exportable = (item: Item) => ({
    id: item.id, objectKey: `events/${EVENT_ID}/media/${item.id}`, objectBucketGeneration: 'canonical' as const, originalFilename: item.filename,
    mimeType: item.mimeType, declaredByteSize: item.byteSize, byteSize: item.byteSize, width: 1, height: 1, guestName: 'Live workflow recorder',
    caption: item.owner ? null : 'Earlier,\r\n"rehearsal"', publicationStatus: 'unpublished' as const, createdAt: item.createdAt, publishedAt: null,
  });
  /** The actual export writer: whole-run numbering across size-bounded parts, plus the run manifest. */
  async function build(job: Job) {
    const snapshot = [...media.values()].filter((item) => item.state === 'stored' && !item.trashed).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const records = snapshot.map(exportable);
    const parts = partitionExportSnapshot(records, options.maxPartBytes ?? 2 * 1024 ** 3);
    const width = exportPathWidth(records.length);
    let startIndex = 0;
    for (const part of parts) {
      const entries = part.media.map((entry) => ({ media: entry, body: new Response(media.get(entry.id)!.bytes!.slice()).body! }));
      job.zips.set(part.partNumber, new Uint8Array(await new Response(buildExportZipStream(entries, { startIndex, width })).arrayBuffer()));
      job.parts.push({ partNumber: part.partNumber, mediaCount: part.media.length, sourceBytes: part.sourceBytes });
      startIndex += part.media.length;
    }
    const manifest = buildExportManifest(parts, width);
    job.manifest = options.manifestTamper ? options.manifestTamper(manifest) : manifest;
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url); const path = url.pathname; const method = request.method;
    const cookie = request.headers.get('cookie');
    const actor = sessions.get(/candidary_session=([^;]+)/u.exec(cookie ?? '')?.[1] ?? '');
    requests.push({ method, url: request.url, origin: request.headers.get('origin'), csrf: request.headers.get('x-candidary-csrf'), cookie });
    if (url.origin !== ORIGIN) return error('ORIGIN_FORBIDDEN', 403);
    let m: RegExpExecArray | null;
    if (method === 'POST' && path === '/api/entry/exchange') {
      if (request.headers.get('origin') !== ORIGIN) return error('ORIGIN_FORBIDDEN', 403);
      const body = await request.json() as { token?: string };
      const existing = options.sameGuestSession ? [...sessions.values()].find((session) => session.role === 'guest') : undefined;
      return body.token === ENTRY ? mint('guest', 200, {}, { location: `/event/${SLUG}` }, existing) : error('EVENT_ENTRY_UNAVAILABLE', 410);
    }
    if (method === 'GET' && path === `/manage/${MANAGE}`) return mint('manager', 302, { Location: `/manage/event/${EVENT_ID}` });
    if ((m = /^\/api\/manage\/events\/([^/]+)(\/.*)?$/u.exec(path))) {
      if (m[1] !== EVENT_ID || actor?.role !== 'manager') return error('ROLE_FORBIDDEN', 403);
      if (method !== 'GET' && !write(request, actor)) return error('CSRF_INVALID', 403);
      const rest = m[2] ?? '';
      if (method === 'GET' && rest === '') return json({ event: eventView() });
      if (method === 'POST' && rest === '/photo-intake') {
        const { action } = await request.json() as { action?: string };
        const legal = started
          ? (action === 'pause' && gate.uploadsEnabled) || (action === 'reopen' && !gate.uploadsEnabled)
          : (action === 'open_early' && !gate.openEarly) || (action === 'return_to_schedule' && gate.openEarly);
        if (!legal) return error('VALIDATION_FAILED', 409);
        intakeLog.push({ action: action!, at: requests.length - 1 });
        if (started) gate.uploadsEnabled = action === 'reopen'; else gate.openEarly = action === 'open_early';
        return json({ event: eventView() });
      }
      if (method === 'POST' && rest === '/exports') {
        const job: Job = { id: nextId('export'), state: 'queued', manifest: '', zips: new Map(), parts: [] };
        jobs.set(job.id, job);
        return json({ export: { id: job.id, kind: 'complete', state: job.state } }, 202);
      }
      if ((m = /^\/exports\/([^/]+)(\/.*)?$/u.exec(rest))) {
        const job = jobs.get(m[1]!);
        if (!job) return error('RESOURCE_FORBIDDEN', 403);
        const suffix = m[2] ?? '';
        if (method === 'GET' && suffix === '') {
          if (job.state === 'running') { await build(job); job.state = 'ready'; } else if (job.state === 'queued') job.state = 'running';
          return json({ export: { id: job.id, kind: 'complete', state: job.state } });
        }
        if (job.state !== 'ready') return error('EXPORT_FAILED', 409);
        const artifact = `/api/manage/events/${EVENT_ID}/exports/${job.id}/artifact`;
        if (method === 'POST' && suffix === '/download') {
          return json({ manifest: { url: `${artifact}/manifest`, filename: 'candidary-export-manifest.csv' },
            parts: job.parts.map((part) => ({ ...part, url: `${artifact}/part/${part.partNumber}`, filename: `photos-${part.partNumber}.zip` })),
            printableGuestbook: null, privateGuestbook: null });
        }
        if (method === 'GET' && suffix === '/artifact/manifest') return new Response(job.manifest, { headers: { 'Content-Type': 'text/csv; charset=utf-8' } });
        if (method === 'GET' && (m = /^\/artifact\/part\/(\d+)$/u.exec(suffix))) {
          const zip = job.zips.get(Number(m[1]));
          return zip ? new Response(zip.slice(), { headers: { 'Content-Type': 'application/zip', 'Content-Length': String(zip.length) } }) : error('EXPORT_FAILED', 404);
        }
        return error('NOT_FOUND', 404);
      }
      if (method === 'GET' && rest === '/media/trash') {
        const trashed = [...media.values()].filter((item) => item.state === 'stored' && item.trashed);
        const start = Number(url.searchParams.get('cursor') ?? 0); const limit = Number(url.searchParams.get('limit') ?? 50);
        return json({ media: trashed.slice(start, start + limit).map((item) => ({ id: item.id })), nextCursor: start + limit < trashed.length ? String(start + limit) : null });
      }
      if (method === 'POST' && (m = /^\/media\/([^/]+)\/(trash|restore)$/u.exec(rest))) {
        if ((await request.text()).trim()) return error('VALIDATION_FAILED', 422);
        const item = media.get(m[1]!);
        if (!item || item.state !== 'stored' || item.trashed !== (m[2] === 'restore')) return error('MEDIA_STATE_CONFLICT', 409);
        item.trashed = m[2] === 'trash';
        return json({ media: { id: item.id } });
      }
      return error('NOT_FOUND', 404);
    }
    if ((m = /^\/api\/event\/([^/]+)\/uploads(\/.*)?$/u.exec(path))) {
      if (m[1] !== SLUG || actor?.role !== 'guest') return error('ROLE_FORBIDDEN', 403);
      if (method !== 'GET' && !write(request, actor)) return error('CSRF_INVALID', 403);
      const rest = m[2] ?? '';
      if (method === 'GET' && rest === '/capabilities') {
        const open = intake().photosOpen;
        const extensions = Object.values(KNOWN_IMAGE_FORMATS).filter((format) => admitted.includes(format.mimeType)).flatMap((format) => [...format.extensions]);
        return json({ mimeTypes: open ? admitted : [], extensions: open ? extensions : [], directMaxBytes: MAX_IMAGE_BYTES, maxOriginalBytes: 512 * MiB, partBytes: MOBILE_IMAGE_PART_BYTES });
      }
      if (method === 'POST' && rest === '/batch') {
        if (!intake().photosOpen) return error('UPLOADS_DISABLED', 409);
        const body = await request.json() as { guestName: string; files: Array<{ filename: string; mimeType: string; byteSize: number; idempotencyKey: string; transport?: string }> };
        const items = body.files.map((file) => {
          reservations.push({ mimeType: file.mimeType, extension: file.filename.split('.').pop(), transport: file.transport ?? null });
          if (!admitted.includes(file.mimeType) || options.refuseTypes?.includes(file.mimeType)) {
            return { idempotencyKey: file.idempotencyKey, status: 'rejected', error: { code: 'FILE_TYPE_UNSUPPORTED', message: 'Not available.' } };
          }
          const item: Item = { id: nextId('media'), owner: actor.token, mimeType: file.mimeType as KnownImageMimeType, byteSize: file.byteSize, filename: file.filename,
            state: 'reserved', trashed: false, bytes: null, parts: new Map(), transferId: null, transferState: null, polls: 0,
            createdAt: new Date(Date.UTC(2026, 7, 20, 12, 0, sequence)).toISOString() };
          media.set(item.id, item);
          if (!options.directOnly && file.transport === 'parts-v1' && (!LEGACY.has(file.mimeType) || file.byteSize > MAX_IMAGE_BYTES)) {
            item.transferId = nextId('transfer'); item.transferState = 'receiving';
            return { idempotencyKey: file.idempotencyKey, status: 'accepted', alreadyDelivered: false, media: uploadView(item), transport: 'parts-v1', transfer: transferView(item) };
          }
          const content = `/api/event/${SLUG}/uploads/${item.id}/content`;
          return { idempotencyKey: file.idempotencyKey, status: 'accepted', alreadyDelivered: false, media: uploadView(item),
            uploadUrl: options.foreignUploadUrl ? `https://evil.example${content}` : content, uploadUrlExpiresAt: new Date(Date.now() + 900_000).toISOString() };
        });
        return json({ items }, 201);
      }
      const match = /^\/([^/]+)(\/.*)?$/u.exec(rest);
      const item = match ? media.get(match[1]!) : undefined;
      if (!item || item.owner !== actor.token) return error('ROLE_FORBIDDEN', 403);
      const tail = match?.[2] ?? '';
      if (method === 'DELETE' && tail === '') {
        if (options.pauseBlocksDeletion && !intake().photosOpen) return error('UPLOADS_DISABLED', 409);
        item.state = 'deleted'; item.trashed = false;
        return json({ media: { id: item.id, deleted: true } });
      }
      if (method === 'PUT' && tail === '/content') {
        const bytes = new Uint8Array(await request.arrayBuffer());
        if (item.transferId || Number(request.headers.get('content-length')) !== item.byteSize || bytes.length !== item.byteSize
          || request.headers.get('content-type') !== item.mimeType) return error('VALIDATION_FAILED', 422);
        item.bytes = bytes; item.state = 'stored';
        return json({ media: uploadView(item) });
      }
      if (method === 'POST' && tail === '/finalize') return item.state === 'stored' ? json({ media: uploadView(item) }) : error('UPLOAD_FINALIZE_CONFLICT', 409);
      const base = `/transfers/${item.transferId}`;
      if (method === 'GET' && tail === base) {
        if (item.transferState === 'processing' && ++item.polls >= 2) { item.transferState = 'delivered'; item.state = 'stored'; }
        const receipt = item.transferState === 'delivered' || (options.prematureReceipt && item.transferState === 'processing');
        return json({ transfer: transferView(item), ...(receipt ? { media: { ...uploadView(item), uploadState: 'stored' } } : {}) });
      }
      if (method === 'PUT' && (m = new RegExp(`^${base}/parts/(\\d+)$`, 'u').exec(tail))) {
        const index = Number(m[1]); const bytes = new Uint8Array(await request.arrayBuffer());
        const expected = Math.min(8 * MiB, item.byteSize - index * 8 * MiB);
        if (item.transferState !== 'receiving' || bytes.length !== expected || Number(request.headers.get('content-length')) !== bytes.length
          || request.headers.get('x-part-sha256') !== sha(bytes) || request.headers.get('content-type') !== 'application/octet-stream') return error('VALIDATION_FAILED', 422);
        item.parts.set(index, bytes);
        return json({ index, accepted: true });
      }
      if (method === 'POST' && tail === `${base}/complete`) {
        if (item.transferState !== 'receiving' || item.parts.size !== Math.ceil(item.byteSize / (8 * MiB))) return error('UPLOAD_FINALIZE_CONFLICT', 409);
        const joined = new Uint8Array(item.byteSize); let offset = 0;
        for (const index of [...item.parts.keys()].sort((a, b) => a - b)) { joined.set(item.parts.get(index)!, offset); offset += item.parts.get(index)!.length; }
        item.bytes = joined; item.transferState = 'processing';
        // Processing acknowledgement only; a delivered receipt belongs to the status route.
        return json({ transfer: transferView(item), ...(options.prematureReceipt ? { media: { ...uploadView(item), uploadState: 'stored' } } : {}) }, 202);
      }
      return error('NOT_FOUND', 404);
    }
    if (method === 'GET' && (m = /^\/api\/media\/([^/]+)\/(preview|original)$/u.exec(path))) {
      const item = media.get(m[1]!);
      if (!item || item.state !== 'stored' || item.trashed) return denial('ROLE_FORBIDDEN', 403, item);
      const manager = actor?.role === 'manager';
      if (m[2] === 'original') {
        if (!manager) return denial(actor ? 'ROLE_FORBIDDEN' : 'SESSION_REQUIRED', actor ? 403 : 401, item);
        return new Response(item.bytes!.slice(), { headers: { 'Content-Type': item.mimeType, 'Content-Length': String(item.byteSize),
          'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
      }
      if (manager || (actor?.role === 'guest' && actor.token === item.owner)) return image();
      return denial(actor ? 'ROLE_FORBIDDEN' : 'SESSION_REQUIRED', actor ? 403 : 401, item);
    }
    return error('NOT_FOUND', 404);
  }
  return {
    media, jobs, requests, reservations, intakeLog, violations, intake,
    secrets: () => [
      ...[...sessions.values()].flatMap((session) => [session.token, session.csrf]), ...media.keys(), ...jobs.keys(),
      ...[...media.values()].flatMap((item) => (item.transferId ? [item.transferId] : [])),
    ],
    fetch: async (input: URL | string, init?: RequestInit) => handle(new Request(input, init)),
  };
}
const ours = (server: ReturnType<typeof fakeCandidary>) => [...server.media.values()].filter((item) => item.id !== 'leftover-1');

/* ------------------------------------------------- fake client (pure) */

type Observed = { status: number; contentType: string; cacheControl: string; nosniff: boolean; setCookie: boolean; decoderHeader: boolean; bytes: number; lengthMatches: boolean; leak: boolean };
const visible = (): Observed => ({ status: 200, contentType: 'image/webp', cacheControl: 'private, no-store', nosniff: true, setCookie: false, decoderHeader: false, bytes: 12, lengthMatches: true, leak: false });
const refusedRead = (status: number, leak = false): Observed => ({ status, contentType: 'application/json', cacheControl: 'private, no-store', nosniff: true, setCookie: false, decoderHeader: false, bytes: 0, lengthMatches: true, leak });
type FakeMedia = { sha256: string; byteSize: number; state: 'stored' | 'trashed' | 'deleted'; reads: number };
type Context = { id: string; item: FakeMedia | undefined; intake: { photosOpen: boolean; state: string } };
type Hooks = {
  connect?: () => unknown;
  capabilities?: () => unknown;
  upload?: (context: Context, source: Json) => Json | undefined;
  preview?: (principal: string, context: Context) => Observed | undefined;
  original?: (context: Context) => Json | undefined;
  exportMembers?: (targets: Json[]) => unknown;
  deleteOwn?: (context: Context) => Json | undefined;
  trashListing?: () => Json | undefined;
};
const partsTrace = (id: string, observations: Json[]) => ({ reservation: 'accepted', rejectionCode: null, transport: 'parts-v1', mediaId: id,
  alreadyDelivered: false, partsAccepted: true, complete: { status: 202 }, observations, timedOut: false });

function fakeClient(hooks: Hooks = {}) {
  const media = new Map<string, FakeMedia>();
  const calls: string[] = [];
  const declared: string[] = [];
  const intake = { photosOpen: false, state: 'paused' };
  const context = (id: string): Context => ({ id, item: media.get(id), intake: { ...intake } });
  const client = {
    async connect() { calls.push('connect'); return hooks.connect ? hooks.connect() : { intake: { ...intake } }; },
    async photoIntake(action: string) {
      calls.push(`intake:${action}`);
      if (action === 'reopen' && intake.state === 'paused') Object.assign(intake, { photosOpen: true, state: 'open' });
      if (action === 'pause' && intake.state === 'open') Object.assign(intake, { photosOpen: false, state: 'paused' });
      return { changed: true, intake: { ...intake } };
    },
    async capabilities() {
      calls.push('capabilities');
      return hooks.capabilities?.() ?? { mimeTypes: ['image/png', 'image/dng'], extensions: ['png', 'dng'], directMaxBytes: MAX_IMAGE_BYTES, maxOriginalBytes: 512 * MiB, partBytes: 8 * MiB };
    },
    async upload(source: Json, options: Json) {
      const id = `media-${options.index}`;
      calls.push(`upload:${options.index}`);
      declared.push(`${source.extension} ${source.mimeType}`);
      const receipt = { mediaId: id, uploadState: 'stored' };
      const trace = hooks.upload?.(context(id), source) ?? (source.mimeType === 'image/png'
        ? { reservation: 'accepted', rejectionCode: null, transport: 'direct', mediaId: id, alreadyDelivered: false,
          content: { status: 200, receipt }, finalize: { status: 200, receipt }, observations: [], timedOut: false }
        : partsTrace(id, [{ state: 'processing', transferMatches: true, receipt: null }, { state: 'delivered', transferMatches: true, receipt }]));
      if (typeof trace.mediaId === 'string') {
        media.set(trace.mediaId, { sha256: source.sha256, byteSize: source.byteSize, state: 'stored', reads: 0 });
        options.onReserved?.(trace.mediaId);
      }
      return trace;
    },
    async preview(principal: string, id: string) {
      calls.push(`preview:${principal}`);
      const override = hooks.preview?.(principal, context(id));
      if (override) return override;
      if (media.get(id)?.state !== 'stored') return refusedRead(403);
      return principal === 'owner' || principal === 'manager' ? visible() : refusedRead(principal === 'signed-out' ? 401 : 403);
    },
    async original(id: string) {
      calls.push('original');
      const item = media.get(id);
      if (item) item.reads += 1;
      const override = hooks.original?.(context(id));
      if (override) return override;
      return item?.state === 'stored' ? { status: 200, sha256: item.sha256, byteSize: item.byteSize, leak: false, decoderHeader: false }
        : { status: 403, sha256: null, byteSize: 0, leak: false, decoderHeader: false };
    },
    async exportMembers(targets: Json[]) {
      calls.push('export');
      return hooks.exportMembers?.(targets) ?? { failure: null, members: new Map(targets.map((target) => [target.mediaId,
        { sha256: media.get(target.mediaId)!.sha256, byteSize: media.get(target.mediaId)!.byteSize }])) };
    },
    async trash(id: string) {
      calls.push('trash');
      const item = media.get(id);
      if (item?.state !== 'stored') return { status: 409, ok: false };
      item.state = 'trashed'; return { status: 200, ok: true };
    },
    async restore(id: string) {
      calls.push('restore');
      const item = media.get(id);
      if (item?.state !== 'trashed') return { status: 409, ok: false };
      item.state = 'stored'; return { status: 200, ok: true };
    },
    async trashListing() {
      return hooks.trashListing?.() ?? { ok: true, ids: [...media].filter(([, item]) => item.state === 'trashed').map(([id]) => id) };
    },
    async deleteOwn(id: string) {
      calls.push('delete');
      const override = hooks.deleteOwn?.(context(id));
      if (override) return override;
      const item = media.get(id);
      if (item) item.state = 'deleted';
      return { status: 200, code: null, deleted: true };
    },
    close() { calls.push('close'); },
  };
  return { client, media, calls, declared, intake };
}
const unitPng = { caseId: 'png', fixtureId: 'unit-png', sha256: 'a'.repeat(64), byteSize: 67, extension: 'png', file: 'unused.png' };
const unitDng = { caseId: 'dng-bayer', fixtureId: 'unit-dng', sha256: 'd'.repeat(64), byteSize: 9 * MiB, extension: 'dng', file: 'unused.dng' };
async function run(hooks: Hooks = {}, fixtures: Json[] = [unitPng, unitDng]) {
  const fake = fakeClient(hooks);
  const report: Json = await runLiveWorkflow({ client: fake.client, fixtures, identity: { origin: ORIGIN, ...IDENTITY } });
  return { report, ...fake };
}

/* --------------------------------------------------------------- tests */

describe('mobile-image live workflow recorder contract', () => {
  it('pins the declared MIME table, direct ceiling and part size to the shared contracts', () => {
    const expected = Object.fromEntries(Object.values(KNOWN_IMAGE_FORMATS).flatMap((format) => format.extensions.map((extension) => [extension, format.mimeType])));
    // Exactly one explicit entry outside KNOWN_IMAGE_FORMATS: an AVIF sequence is declared as the IANA-registered,
    // sequence-unspecified image/avif, which the server resolves as a still AVIF declaration (never image/avif-sequence).
    const { avifs, ...known } = MIME_BY_EXTENSION;
    expect(known).toEqual(expected);
    expect(Object.hasOwn(expected, 'avifs')).toBe(false);
    expect(avifs).toBe('image/avif');
    expect(resolveImageDeclaration('x.avifs', 'image/avif')).toEqual({ family: 'avif', mimeType: 'image/avif', requiresSequence: false });
    const declared = new Set(Object.values(MIME_BY_EXTENSION));
    expect([...DIRECT_MIME_TYPES].sort()).toEqual(LEGACY_UPLOAD_MIME_TYPES.filter((mime) => declared.has(mime)).sort());
    expect(PART_BYTES).toBe(MOBILE_IMAGE_PART_BYTES);
    expect(DIRECT_MAX_BYTES).toBe(MAX_IMAGE_BYTES);
  });

  it('accepts exactly the shared preview-origin rule, and only in bare form', () => {
    expect(PREVIEW_ROOT_ORIGIN).toBe(PREVIEW_APPLICATION_ROOT_ORIGIN);
    const suffix = 'candidary-preview.lfd.workers.dev';
    for (const origin of [`https://${suffix}`, `https://pr-42-${suffix}`, `https://4f3a2b1c-${suffix}`, `https://${'a'.repeat(45)}-${suffix}`,
      `https://${'a'.repeat(46)}-${suffix}`, `https://-x-${suffix}`, `https://a_b-${suffix}`, `https://x${suffix}`, `https://${suffix}.evil.example`,
      `http://${suffix}`, `https://${suffix}:8443`, 'https://candidary.app', 'https://candidary.online', 'https://evil.example']) {
      expect(isPreviewOrigin(origin), origin).toBe(isPreviewApplicationOrigin(origin));
    }
    for (const value of [`https://${suffix}/`, `https://${suffix}/api`, `https://${suffix}?x=1`, `https://user@${suffix}`, `https://Candidary-Preview.lfd.workers.dev`, null]) {
      expect(isPreviewOrigin(value), String(value)).toBe(false);
    }
  });
});

describe('dry run', () => {
  it('plans transfers and totals without reading the authorization or credentials and without any request', async () => {
    const dng = pattern(8 * MiB + 5, 5);
    const avifs = pattern(900, 6);
    const test = corpus([pngEntry, { caseId: 'dng-bayer', id: 'unit-dng', extension: 'dng', bytes: dng },
      { caseId: 'avif-sequence', id: 'unit-avifs', extension: 'avifs', bytes: avifs }]);
    const garbage = join(test.root, 'authorization.json'); writeFileSync(garbage, 'not json');
    const fetch = vi.fn();
    const plan = await recordLiveWorkflow({ manifestPath: test.manifestPath, authorizationPath: garbage, fetch, caseIds: ['png', 'dng-bayer', 'avif-sequence'] });
    expect(fetch).not.toHaveBeenCalled();
    expect(plan).toMatchObject({ mode: 'dry-run', requests: 0, environment: 'preview', directMaxBytes: MAX_IMAGE_BYTES, partBytes: MOBILE_IMAGE_PART_BYTES });
    expect(plan.fixtures).toEqual([
      { caseId: 'png', fixtureId: 'unit-png', byteSize: png.length, declaredMimeType: 'image/png', expectedTransport: 'direct', parts: 1 },
      { caseId: 'dng-bayer', fixtureId: 'unit-dng', byteSize: dng.length, declaredMimeType: 'image/dng', expectedTransport: 'parts-v1', parts: 2 },
      // An AVIF sequence is declared as sequence-unspecified image/avif, which is never a direct (legacy) type.
      { caseId: 'avif-sequence', fixtureId: 'unit-avifs', byteSize: avifs.length, declaredMimeType: 'image/avif', expectedTransport: 'parts-v1', parts: 1 },
    ]);
    const uploadBytes = png.length + dng.length + avifs.length;
    expect(plan.totals).toEqual({ fixtures: 3, planned: 3, uploadBytes, downloadBytes: 3 * uploadBytes });
  });

  it('is the command-line default, and --live without its confirmation is refused with a fixed message', () => {
    const test = corpus([pngEntry]);
    const env = { ...process.env }; delete env.CANDIDARY_LIVE_WORKFLOW_CONFIRM;
    const dry = spawnSync(process.execPath, [script, '--manifest', test.manifestPath, '--cases', 'png'], { encoding: 'utf8', env });
    expect(dry.status).toBe(0);
    expect(JSON.parse(dry.stdout)).toMatchObject({ mode: 'dry-run', requests: 0, fixtures: [{ caseId: 'png', fixtureId: 'unit-png', expectedTransport: 'direct' }] });
    const live = spawnSync(process.execPath, [script, '--live', '--manifest', test.manifestPath, '--authorization', join(test.root, 'absent.json'),
      '--out', test.evidence], { encoding: 'utf8', env });
    expect(live.status).toBe(1);
    expect(JSON.parse(live.stdout)).toEqual({ refused: true, code: 'confirmation-required', message: expect.any(String) });
    expect(live.stdout).not.toContain(test.root.split(/[\\/]/u).pop());
    expect(readdirSync(test.evidence)).toEqual([]);
  });
});

describe('live gating', () => {
  it('refuses every incomplete gate before reading credentials or sending a request', async () => {
    const test = corpus([pngEntry]);
    const fetch = vi.fn();
    const attempt = (authorizationPath: string, extra: Json = {}) => refusal(record(test, authorizationPath, fetch, extra));
    const good = authorize(test.root).authorizationPath;
    expect(await attempt(good, { env: {} })).toBe('confirmation-required');
    expect(await attempt(good, { env: { CANDIDARY_LIVE_WORKFLOW_CONFIRM: 'yes' } })).toBe('confirmation-required');
    expect(await attempt('relative/authorization.json')).toBe('confirmation-required');
    // A tracked repository file can never be a private authorization or credential file.
    expect(await attempt(resolve('package.json'))).toBe('private-path');
    const later = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();
    const invalid: Json[] = [
      { kind: 'candidary.image-load-authorization' }, { version: 2 }, { environment: 'production' }, { dedicatedLiveEvent: false }, { owner: ' ' },
      { target: 'https://candidary.app' }, { target: 'https://candidary-preview.lfd.workers.dev/api' }, { target: 'https://candidary-preview.lfd.workers.dev/' },
      { target: 'http://candidary-preview.lfd.workers.dev' }, { target: 'https://evil.example-candidary-preview.lfd.workers.dev' },
      { expiresAt: later(-1) }, { expiresAt: later(73) }, { expiresAt: 'soon' }, { eventId: 'short' },
      { identity: { ...IDENTITY, buildFingerprint: 'B'.repeat(64) } },
      { identity: { ...IDENTITY, imageRef: `decoder@sha256:${'c'.repeat(64)}` } },
      { identity: { ...IDENTITY, imageRef: `localhost:5000/decoder@sha256:${'c'.repeat(64)}` } },
      { identity: { ...IDENTITY, imageRef: `127.0.0.1:5000/decoder@sha256:${'c'.repeat(64)}` } },
      { identity: { ...IDENTITY, imageRef: 'registry.example/decoder:latest' } },
      { identity: { ...IDENTITY, workerVersionId: 'latest' } },
      { caseIds: [] }, { caseIds: ['not-a-case'] }, { caseIds: ['png', 'png'] },
    ];
    for (const change of invalid) expect(await attempt(authorize(test.root, change).authorizationPath), JSON.stringify(change)).toBe('authorization-invalid');
    for (const credentialsPath of [resolve('package.json'), 'credentials.json', join(test.root, 'missing.json')]) {
      expect(await attempt(authorize(test.root, { credentialsPath }).authorizationPath), credentialsPath).toBe('private-path');
    }
    expect(await attempt(good, { outputDir: join(test.root, 'absent') })).toBe('output-invalid');
    expect(await attempt(good, { outputDir: tmpdir() })).toBe('output-invalid');
    // `apng` is a required case, but this manifest has no fixture for it.
    expect(await attempt(authorize(test.root, { caseIds: ['apng'] }).authorizationPath)).toBe('fixtures-invalid');
    expect(await attempt(authorize(test.root, {}, { eventId: 'other_event_0001' }).authorizationPath)).toBe('credentials-invalid');
    expect(await attempt(authorize(test.root, {}, { managementToken: 'not a token' }).authorizationPath)).toBe('credentials-invalid');
    expect(fetch).not.toHaveBeenCalled();
    expect(readdirSync(test.evidence)).toEqual([]);
  });

  it('writes only into Git-ignored storage, and still records a harness failure there', async () => {
    const test = corpus([pngEntry]);
    expect(spawnSync('git', ['init', '-q', test.root]).status).toBe(0);
    const fetch = vi.fn(async () => { throw new TypeError('offline'); });
    const { authorizationPath } = authorize(test.root);
    expect(await refusal(record(test, authorizationPath, fetch))).toBe('output-invalid');
    expect(fetch).not.toHaveBeenCalled();
    writeFileSync(join(test.root, '.gitignore'), 'evidence/\n');
    const printed = await record(test, authorizationPath, fetch);
    expect(printed).toMatchObject({ runtimeFailure: 'session', results: [{ caseId: 'png', fixtureId: 'unit-png', status: 'missing' }] });
    expect(readDocument(test, printed)).toMatchObject({ kind: 'live-workflow', runtimeFailure: 'session', results: [{ reason: 'runtime-failure' }] });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('re-hashes every selected original and refuses a mismatch or missing file before the first request', async () => {
    const test = corpus([pngEntry]);
    const fetch = vi.fn();
    const { authorizationPath } = authorize(test.root);
    writeFileSync(join(test.root, 'originals', 'unit-png.png'), Buffer.concat([png, Buffer.from([0])]));
    expect(await refusal(record(test, authorizationPath, fetch))).toBe('fixtures-invalid');
    rmSync(join(test.root, 'originals', 'unit-png.png'));
    expect(await refusal(record(test, authorizationPath, fetch))).toBe('fixtures-invalid');
    expect(fetch).not.toHaveBeenCalled();
    expect(readdirSync(test.evidence)).toEqual([]);
  });
});

describe('live workflow over the public API', () => {
  it.each([true, false])('records a verifier-accepted pass for direct and resumable originals (event started: %s)', async (started) => {
    const dng = pattern(8 * MiB + 5, 5);
    const gif = Uint8Array.from(Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1'));
    const test = corpus([pngEntry, { caseId: 'dng-bayer', id: 'unit-dng', extension: 'dng', bytes: dng }, { caseId: 'gif-still', id: 'unit-gif', extension: 'gif', bytes: gif }]);
    // Two ZIP parts: the leftover photo and the PNG, then the DNG on its own.
    const server = fakeCandidary({ started, maxPartBytes: 8 * MiB + 5 });
    const { authorizationPath } = authorize(test.root, { caseIds: ['png', 'dng-bayer', 'gif-still'] });
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn')];
    const printed = await record(test, authorizationPath, server.fetch);
    expect(spies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
    expect(printed).toEqual({
      pointer: { path: `evidence/${printed.pointer.sha256}.json`, sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
      results: [{ caseId: 'png', fixtureId: 'unit-png', status: 'pass' }, { caseId: 'dng-bayer', fixtureId: 'unit-dng', status: 'pass' },
        { caseId: 'gif-still', fixtureId: 'unit-gif', status: 'missing' }],
    });
    expect(readdirSync(test.evidence)).toEqual([`${printed.pointer.sha256}.json`]);
    const document = readDocument(test, printed);
    expect(Object.keys(document).sort()).toEqual(['buildFingerprint', 'environment', 'finishedAt', 'harnessVersion', 'imageRef', 'kind', 'origin',
      'recorderVersion', 'results', 'startedAt', 'workerVersionId']);
    expect(document).toMatchObject({ kind: 'live-workflow', harnessVersion: 1, recorderVersion: 1, environment: 'preview', origin: ORIGIN, ...IDENTITY });
    const passed = (sourceSha256: string, transport: string) => ({ sourceSha256, status: 'pass', transport, delivered: true, privatePreview: true, deleted: true,
      originalRoundTripSha256: sourceSha256, zipMemberVerified: true, restoredVerified: true, deletionRequiredReopen: false });
    expect(document.results).toEqual([
      { caseId: 'png', fixtureId: 'unit-png', ...passed(sha(png), 'direct') },
      { caseId: 'dng-bayer', fixtureId: 'unit-dng', ...passed(sha(dng), 'parts-v1') },
      { caseId: 'gif-still', fixtureId: 'unit-gif', sourceSha256: sha(gif), status: 'missing', transport: null, delivered: false, privatePreview: false,
        deleted: false, originalRoundTripSha256: null, zipMemberVerified: false, restoredVerified: false, deletionRequiredReopen: false, reason: 'not-admitted' },
    ]);
    const text = JSON.stringify(document);
    for (const secret of [ENTRY, MANAGE, EVENT_ID, SLUG, 'live-workflow-1', 'unit-png.png', JSON.stringify(test.root).slice(1, -1), ...server.secrets()]) {
      expect(text).not.toContain(secret);
    }

    // Browser-equivalent protocol: one origin, Origin and scope CSRF on every write, neither on any read.
    expect(server.violations).toEqual([]);
    expect(server.requests.every((request) => request.url.startsWith(`${ORIGIN}/`))).toBe(true);
    const reads = server.requests.filter((request) => request.method === 'GET');
    const writes = server.requests.filter((request) => request.method !== 'GET');
    expect(reads.every((request) => request.origin === null && request.csrf === null)).toBe(true);
    expect(writes.every((request) => request.origin === ORIGIN)).toBe(true);
    expect(writes.filter((request) => !request.url.endsWith('/api/entry/exchange')).every((request) => request.csrf !== null)).toBe(true);
    expect(reads.some((request) => request.url.endsWith('/preview') && request.cookie === null)).toBe(true);
    // The server negotiated the transport: one direct content PUT, two 8 MiB-bounded parts.
    expect(writes.filter((request) => request.url.endsWith('/content'))).toHaveLength(1);
    expect(writes.filter((request) => /\/parts\/\d+$/u.test(request.url))).toHaveLength(2);
    // Guest intake closed before any original or archive was read, and is closed at the end.
    const closedAt = server.intakeLog.find((entry) => entry.action === (started ? 'pause' : 'return_to_schedule'))!.at;
    expect(server.intakeLog.map((entry) => entry.action)).toEqual(started ? ['reopen', 'pause'] : ['open_early', 'return_to_schedule']);
    expect(closedAt).toBeLessThan(server.requests.findIndex((request) => request.url.endsWith('/original')));
    expect(closedAt).toBeLessThan(server.requests.findIndex((request) => request.method === 'POST' && request.url.endsWith('/exports')));
    expect(server.intake().photosOpen).toBe(false);
    // Both parts of the multi-part archive were read; every recorder upload is gone, the leftover untouched.
    expect([...server.jobs.values()][0]!.parts).toHaveLength(2);
    expect(reads.filter((request) => /\/artifact\/part\/\d+$/u.test(request.url))).toHaveLength(2);
    expect(ours(server).every((item) => item.state === 'deleted')).toBe(true);
    expect(server.media.get('leftover-1')).toMatchObject({ state: 'stored', trashed: false });

    // The real corpus verifier accepts the document for exactly these originals.
    for (const fixture of test.fixtures.slice(0, 2)) fixture.evidence.live = printed.pointer;
    test.save();
    const verified = await verifyCorpus({ manifestPath: test.manifestPath });
    for (const [caseId, fixtureId] of [['png', 'unit-png'], ['dng-bayer', 'unit-dng']]) {
      const lane = verified.cases.find((item: Json) => item.id === caseId).fixtures.find((item: Json) => item.id === fixtureId).evidence.live;
      expect(lane).toEqual({ status: 'pass', evidenceSha256: printed.pointer.sha256, buildFingerprint: IDENTITY.buildFingerprint, imageRefs: [IDENTITY.imageRef] });
    }
  }, 60_000);

  it('pins every request to the authorized origin and records a harness failure without any pass', async () => {
    const credentials = { eventId: EVENT_ID, entryCredential: ENTRY, managementToken: MANAGE };
    for (const origin of ['https://candidary.app', `${ORIGIN}/`, 'https://evil.example']) {
      expect(() => createLiveClient({ origin, credentials, fetch: vi.fn() }), origin).toThrow();
    }
    const test = corpus([pngEntry]);
    const server = fakeCandidary({ foreignUploadUrl: true });
    const printed = await record(test, authorize(test.root).authorizationPath, server.fetch);
    expect(printed).toMatchObject({ runtimeFailure: 'upload', results: [{ caseId: 'png', fixtureId: 'unit-png', status: 'missing' }] });
    const document = readDocument(test, printed);
    expect(document).toMatchObject({ runtimeFailure: 'upload' });
    expect(document.results[0]).toMatchObject({ status: 'missing', reason: 'runtime-failure', delivered: false });
    expect(server.requests.every((request) => new URL(request.url).origin === ORIGIN)).toBe(true);
    // Cleanup still removed the reservation and closed intake.
    expect(ours(server).every((item) => item.state === 'deleted')).toBe(true);
    expect(server.intake().photosOpen).toBe(false);
    expect(document.cleanupFailure).toBeUndefined();
  });

  it('declares an AVIF sequence as image/avif and sends it through the normal resumable path', async () => {
    const avifs = pattern(900, 6);
    const test = corpus([{ caseId: 'avif-sequence', id: 'unit-avifs', extension: 'avifs', bytes: avifs }]);
    // The capabilities advertise image/avif and its `avif` extension only; `.avifs` is never listed.
    const server = fakeCandidary({ admitted: ['image/avif'] });
    const printed = await record(test, authorize(test.root, { caseIds: ['avif-sequence'] }).authorizationPath, server.fetch);
    const document = readDocument(test, printed);
    expect(document.results[0]).toMatchObject({ caseId: 'avif-sequence', fixtureId: 'unit-avifs', status: 'pass', transport: 'parts-v1',
      delivered: true, privatePreview: true, deleted: true, originalRoundTripSha256: sha(avifs), zipMemberVerified: true, restoredVerified: true });
    expect(server.reservations).toEqual([{ mimeType: 'image/avif', extension: 'avifs', transport: 'parts-v1' }]);
    test.fixtures[0]!.evidence.live = printed.pointer; test.save();
    const verified = await verifyCorpus({ manifestPath: test.manifestPath });
    expect(verified.cases.find((item: Json) => item.id === 'avif-sequence').fixtures[0].evidence.live).toMatchObject({ status: 'pass' });
  });

  it('fails a type the capabilities advertised but the reservation refuses as unsupported', async () => {
    const test = corpus([pngEntry]);
    const server = fakeCandidary({ refuseTypes: ['image/png'] });
    const document = readDocument(test, await record(test, authorize(test.root).authorizationPath, server.fetch));
    expect(document.results[0]).toMatchObject({ status: 'fail', reason: 'type-refused-despite-capabilities', transport: null, delivered: false });
    expect(server.reservations).toEqual([{ mimeType: 'image/png', extension: 'png', transport: 'parts-v1' }]);
    expect(document.runtimeFailure).toBeUndefined(); expect(document.cleanupFailure).toBeUndefined();
  });

  it('never follows a direct transport beyond the 20 MiB ceiling', async () => {
    const test = corpus([{ caseId: 'dng-bayer', id: 'unit-dng', extension: 'dng', bytes: pattern(DIRECT_MAX_BYTES + 1, 8) }]);
    const server = fakeCandidary({ directOnly: true });
    const document = readDocument(test, await record(test, authorize(test.root, { caseIds: ['dng-bayer'] }).authorizationPath, server.fetch));
    expect(document.results[0]).toMatchObject({ status: 'fail', reason: 'reservation-rejected', delivered: false });
    expect(server.requests.some((request) => request.method === 'PUT')).toBe(false);
    expect(ours(server).every((item) => item.state === 'deleted')).toBe(true);
  });

  it('refuses to treat one guest session as two principals', async () => {
    const test = corpus([pngEntry]);
    const server = fakeCandidary({ sameGuestSession: true });
    const printed = await record(test, authorize(test.root).authorizationPath, server.fetch);
    expect(printed).toMatchObject({ runtimeFailure: 'session', results: [{ caseId: 'png', status: 'missing' }] });
    expect(server.requests.some((request) => request.url.includes('/uploads'))).toBe(false);
  });

  it('maps archive members only through an unambiguous run manifest', async () => {
    const test = corpus([pngEntry]);
    const tampers: Array<[(csv: string) => string, string]> = [
      // The same photo listed twice (at a second path): which member is it? Neither is trusted.
      [(csv) => { const lines = csv.split('\r\n'); return [...lines.slice(0, -1), lines.at(-2)!.replace('photos/002-', 'photos/009-'), ''].join('\r\n'); }, 'zip-member-missing'],
      [() => 'not,the,manifest\r\n', 'zip-export-failed'],
    ];
    for (const [manifestTamper, reason] of tampers) {
      const server = fakeCandidary({ manifestTamper });
      const document = readDocument(test, await record(test, authorize(test.root).authorizationPath, server.fetch));
      expect(document.results[0], reason).toMatchObject({ status: 'fail', reason, delivered: true, zipMemberVerified: false, deleted: true });
      expect(server.requests.some((request) => /\/artifact\/part\//u.test(request.url))).toBe(false);
    }
  });

  it('fails a delivered receipt that arrives before the transfer reports delivery', async () => {
    const test = corpus([{ caseId: 'dng-bayer', id: 'unit-dng', extension: 'dng', bytes: pattern(1000, 9) }]);
    const server = fakeCandidary({ prematureReceipt: true });
    const printed = await record(test, authorize(test.root, { caseIds: ['dng-bayer'] }).authorizationPath, server.fetch);
    const document = readDocument(test, printed);
    expect(document.results[0]).toMatchObject({ status: 'fail', reason: 'premature-receipt', transport: 'parts-v1', delivered: false, deleted: false });
    expect(document.runtimeFailure).toBeUndefined(); expect(document.cleanupFailure).toBeUndefined();
    expect(ours(server).every((item) => item.state === 'deleted')).toBe(true);
    expect(server.intake().photosOpen).toBe(false);
  });

  it('treats digest or object-key text in a denial body as a privacy failure', async () => {
    const test = corpus([pngEntry]);
    const server = fakeCandidary({ leakDenial: true });
    const document = readDocument(test, await record(test, authorize(test.root).authorizationPath, server.fetch));
    expect(document.results[0]).toMatchObject({ status: 'fail', reason: 'preview-denial-leak', delivered: true, privatePreview: false, deleted: false });
  });

  it('reopens paused intake once when a guest deletion is refused only for that reason, and closes it again', async () => {
    const test = corpus([pngEntry, { caseId: 'webp-lossy', id: 'unit-webp', extension: 'webp', bytes: pattern(300, 4) }]);
    const server = fakeCandidary({ pauseBlocksDeletion: true });
    const document = readDocument(test, await record(test, authorize(test.root, { caseIds: ['png', 'webp-lossy'] }).authorizationPath, server.fetch));
    expect(document.results.map((result: Json) => [result.status, result.deletionRequiredReopen])).toEqual([['pass', true], ['pass', false]]);
    expect(server.intakeLog.map((entry) => entry.action)).toEqual(['reopen', 'pause', 'reopen', 'pause']);
    expect(server.intake().photosOpen).toBe(false);
    expect(document.cleanupFailure).toBeUndefined();
  });
});

describe('classification and evidence assembly', () => {
  it('assembles an allowlisted passing document from the observations', async () => {
    const { report, calls, media, intake } = await run();
    expect(report.results).toEqual([
      { caseId: 'png', fixtureId: 'unit-png', sourceSha256: unitPng.sha256, status: 'pass', transport: 'direct', delivered: true, privatePreview: true,
        deleted: true, originalRoundTripSha256: unitPng.sha256, zipMemberVerified: true, restoredVerified: true, deletionRequiredReopen: false },
      { caseId: 'dng-bayer', fixtureId: 'unit-dng', sourceSha256: unitDng.sha256, status: 'pass', transport: 'parts-v1', delivered: true, privatePreview: true,
        deleted: true, originalRoundTripSha256: unitDng.sha256, zipMemberVerified: true, restoredVerified: true, deletionRequiredReopen: false },
    ]);
    expect(report).toMatchObject({ kind: 'live-workflow', harnessVersion: 1, recorderVersion: 1, environment: 'preview', origin: ORIGIN, ...IDENTITY });
    expect(report.runtimeFailure).toBeUndefined(); expect(report.cleanupFailure).toBeUndefined();
    expect(JSON.stringify(report)).not.toMatch(/media-\d|unused\./u);
    expect([...media.values()].every((item) => item.state === 'deleted')).toBe(true);
    expect(intake.photosOpen).toBe(false);
    expect(calls.indexOf('intake:reopen')).toBeLessThan(calls.indexOf('upload:1'));
    expect(calls.indexOf('intake:pause')).toBeLessThan(calls.indexOf('original'));
    expect(calls.indexOf('intake:pause')).toBeLessThan(calls.indexOf('export'));
    expect(calls.at(-1)).toBe('close');
  });

  const e = 'e'.repeat(64);
  const failures: Array<[string, Hooks, string, Json]> = [
    ['a reservation the server refuses for another reason', { upload: () => ({ reservation: 'rejected', rejectionCode: 'UPLOADS_DISABLED', mediaId: null, transport: null }) },
      'reservation-rejected', { delivered: false, transport: null }],
    ['a delivered receipt before the transfer reports delivery', { upload: ({ id }) => partsTrace(id, [{ state: 'processing', transferMatches: true, receipt: { mediaId: id, uploadState: 'stored' } }]) },
      'premature-receipt', { delivered: false, deleted: false, originalRoundTripSha256: null }],
    ['a fresh reservation that claims it was already delivered', { upload: ({ id }) => ({ reservation: 'accepted', rejectionCode: null, transport: null, mediaId: id, alreadyDelivered: true }) },
      'premature-receipt', { delivered: false }],
    ['a delivered receipt naming another photo',{ upload: ({ id }) => partsTrace(id, [{ state: 'delivered', transferMatches: true, receipt: { mediaId: 'other', uploadState: 'stored' } }]) },
      'receipt-mismatch', { delivered: false }],
    ['a transfer that never delivers', { upload: ({ id }) => ({ ...partsTrace(id, [{ state: 'processing', transferMatches: true, receipt: null }]), timedOut: true }) },
      'delivery-timeout', { delivered: false }],
    ['a public-cacheable owner preview', { preview: (principal) => (principal === 'owner' ? { ...visible(), cacheControl: 'public, max-age=60' } : undefined) },
      'preview-not-private', { privatePreview: false, delivered: true }],
    ['an owner preview that sets a cookie', { preview: (principal) => (principal === 'owner' ? { ...visible(), setCookie: true } : undefined) },
      'preview-not-private', { privatePreview: false }],
    ['an owner preview carrying a decoder header', { preview: (principal) => (principal === 'owner' ? { ...visible(), decoderHeader: true } : undefined) },
      'preview-not-private', { privatePreview: false }],
    ['a truncated manager preview', { preview: (principal) => (principal === 'manager' ? { ...visible(), lengthMatches: false } : undefined) },
      'preview-manager-unavailable', { privatePreview: false }],
    ['a signed-out denial carrying a decoder header', { preview: (principal) => (principal === 'signed-out' ? { ...refusedRead(401), decoderHeader: true } : undefined) },
      'preview-denial-leak', { privatePreview: false }],
    ['a trashed photo missing from Recently deleted', { trashListing: () => ({ ok: true, ids: [] }) },
      'trash-not-listed', { restoredVerified: true, deleted: true }],
    ['a permanently deleted photo still listed in Recently deleted', { trashListing: () => ({ ok: true, ids: ['media-1'] }) },
      'deletion-not-enforced', { restoredVerified: true, deleted: false }],
    ['a preview visible to another guest', { preview: (principal) => (principal === 'other-guest' ? visible() : undefined) },
      'preview-visible-to-other-guest', { privatePreview: false, delivered: true, deleted: true }],
    ['a preview visible when signed out', { preview: (principal) => (principal === 'signed-out' ? visible() : undefined) },
      'preview-visible-signed-out', { privatePreview: false }],
    ['digest text in a denial body', { preview: (principal) => (principal === 'other-guest' ? refusedRead(403, true) : undefined) },
      'preview-denial-leak', { privatePreview: false }],
    ['a manager original that differs from the fixture', { original: ({ item }) => (item?.reads === 1 ? { status: 200, sha256: e, byteSize: item.byteSize, leak: false, decoderHeader: false } : undefined) },
      'original-mismatch', { originalRoundTripSha256: e, zipMemberVerified: true, restoredVerified: true }],
    ['a ZIP member that differs from the fixture', { exportMembers: (targets) => ({ failure: null, members: new Map(targets.map((target) => [target.mediaId, { sha256: 'f'.repeat(64), byteSize: target.byteSize }])) }) },
      'zip-member-mismatch', { zipMemberVerified: false, originalRoundTripSha256: 'f'.repeat(64) }],
    ['a trashed photo still visible to its owner', { preview: (principal, { item }) => (principal === 'owner' && item?.state === 'trashed' ? visible() : undefined) },
      'trash-not-denied', { privatePreview: true, restoredVerified: true, deleted: true }],
    ['a restored original that differs from the fixture', { original: ({ item }) => (item?.reads === 2 ? { status: 200, sha256: '9'.repeat(64), byteSize: item.byteSize, leak: false, decoderHeader: false } : undefined) },
      'restore-mismatch', { restoredVerified: false, originalRoundTripSha256: '9'.repeat(64) }],
    ['a deleted original the manager can still download', { original: ({ item }) => (item?.state === 'deleted' ? { status: 200, sha256: item.sha256, byteSize: item.byteSize, leak: false, decoderHeader: false } : undefined) },
      'deletion-not-enforced', { deleted: false, restoredVerified: true }],
  ];
  it.each(failures)('records %s as a failure with its fixed reason', async (_label, hooks, reason, fields) => {
    const { report } = await run(hooks, [unitPng]);
    expect(report.runtimeFailure).toBeUndefined(); expect(report.cleanupFailure).toBeUndefined();
    expect(report.results[0]).toMatchObject({ status: 'fail', reason, ...fields });
  });

  it('records formats the server does not offer or admit as missing, never as pass or fail', async () => {
    const unitGif = { caseId: 'gif-still', fixtureId: 'unit-gif', sha256: '1'.repeat(64), byteSize: 14, extension: 'gif', file: 'unused.gif' };
    const unitAvifs = { caseId: 'avif-sequence', fixtureId: 'unit-avifs', sha256: '2'.repeat(64), byteSize: 900, extension: 'avifs', file: 'unused.avifs' };
    const huge = { ...unitPng, fixtureId: 'unit-huge', byteSize: 600 * MiB };
    // The MIME type is offered but this extension is not.
    const unitJfif = { caseId: 'jpeg-baseline', fixtureId: 'unit-jfif', sha256: '3'.repeat(64), byteSize: 20, extension: 'jfif', file: 'unused.jfif' };
    const { report, calls } = await run({
      capabilities: () => ({ mimeTypes: ['image/png', 'image/dng', 'image/jpeg'], extensions: ['png', 'dng', 'jpg'], directMaxBytes: MAX_IMAGE_BYTES,
        maxOriginalBytes: 512 * MiB, partBytes: 8 * MiB }),
      upload: (_context, source) => (source.mimeType === 'image/dng' ? { reservation: 'rejected', rejectionCode: 'FILE_TOO_LARGE', mediaId: null, transport: null } : undefined),
    }, [unitPng, unitDng, unitGif, unitAvifs, huge, unitJfif]);
    expect(report.results.map((result: Json) => [result.fixtureId, result.status, result.reason])).toEqual([
      ['unit-png', 'pass', undefined], ['unit-dng', 'missing', 'not-admitted'], ['unit-gif', 'missing', 'not-admitted'],
      ['unit-avifs', 'missing', 'not-admitted'], ['unit-huge', 'missing', 'not-admitted'], ['unit-jfif', 'missing', 'not-admitted'],
    ]);
    expect(calls.filter((call) => call.startsWith('upload:'))).toEqual(['upload:1', 'upload:2']);
  });

  it('separates unadvertised types and per-case size refusals (missing) from refusals that contradict the capabilities (fail)', async () => {
    const rejected = (rejectionCode: string) => () => ({ reservation: 'rejected', rejectionCode, mediaId: null, transport: null });
    const contradicted = await run({ upload: rejected('FILE_TYPE_UNSUPPORTED') }, [unitPng]);
    expect(contradicted.report.results[0]).toMatchObject({ status: 'fail', reason: 'type-refused-despite-capabilities', transport: null, delivered: false });
    const tooLarge = await run({ upload: rejected('FILE_TOO_LARGE') }, [unitPng]);
    expect(tooLarge.report.results[0]).toMatchObject({ status: 'missing', reason: 'not-admitted', transport: null, delivered: false });
    const unadvertised = await run({ capabilities: () => ({ mimeTypes: ['image/dng'], extensions: ['dng'], directMaxBytes: MAX_IMAGE_BYTES,
      maxOriginalBytes: 512 * MiB, partBytes: 8 * MiB }) }, [unitPng]);
    expect(unadvertised.report.results[0]).toMatchObject({ status: 'missing', reason: 'not-admitted' });
    expect(unadvertised.calls.some((call) => call.startsWith('upload:'))).toBe(false);
    for (const { report } of [contradicted, tooLarge, unadvertised]) expect(report.runtimeFailure).toBeUndefined();
  });

  it('uploads an AVIF sequence declared as image/avif whenever the capabilities advertise image/avif', async () => {
    const unitAvifs = { caseId: 'avif-sequence', fixtureId: 'unit-avifs', sha256: '2'.repeat(64), byteSize: 900, extension: 'avifs', file: 'unused.avifs' };
    const { report, declared } = await run({ capabilities: () => ({ mimeTypes: ['image/avif'], extensions: ['avif'], directMaxBytes: MAX_IMAGE_BYTES,
      maxOriginalBytes: 512 * MiB, partBytes: 8 * MiB }) }, [unitAvifs]);
    expect(declared).toEqual(['avifs image/avif']);
    expect(report.results[0]).toMatchObject({ caseId: 'avif-sequence', status: 'pass', transport: 'parts-v1' });
  });

  it('marks a harness failure as runtimeFailure, never leaves a pass, and still cleans up', async () => {
    const early = await run({ connect: () => { throw new Error('credential text that must not escape'); } });
    expect(early.report.runtimeFailure).toBe('session');
    expect(early.report.results.map((result: Json) => [result.status, result.reason])).toEqual([['missing', 'runtime-failure'], ['missing', 'runtime-failure']]);
    expect(JSON.stringify(early.report)).not.toContain('credential text');
    expect(early.calls).toEqual(['connect', 'close']);
    const late = await run({
      preview: (principal) => (principal === 'signed-out' ? visible() : undefined),
      exportMembers: () => { throw new Error('boom'); },
    });
    expect(late.report.runtimeFailure).toBe('export');
    expect(late.report.results.map((result: Json) => [result.status, result.reason])).toEqual([
      ['fail', 'preview-visible-signed-out'], ['fail', 'preview-visible-signed-out']]);
    const quiet = await run({ exportMembers: () => { throw new Error('boom'); } });
    expect(quiet.report.results.map((result: Json) => [result.status, result.reason])).toEqual([['missing', 'runtime-failure'], ['missing', 'runtime-failure']]);
    expect([...quiet.media.values()].every((item) => item.state === 'deleted')).toBe(true);
    expect(quiet.intake.photosOpen).toBe(false);
    expect(quiet.report.cleanupFailure).toBeUndefined();
    // Every observation for the first photo held before the harness failed on the second: still no pass.
    const last = await run({ deleteOwn: ({ id }) => { if (id === 'media-2') throw new Error('boom'); return undefined; } });
    expect(last.report.runtimeFailure).toBe('deletion');
    expect(last.report.cleanupFailure).toBe('media');
    expect(last.report.results[0]).toMatchObject({ status: 'missing', reason: 'runtime-failure', delivered: true, privatePreview: true,
      deleted: true, zipMemberVerified: true, restoredVerified: true, originalRoundTripSha256: unitPng.sha256 });
    expect(last.report.results.some((result: Json) => result.status === 'pass')).toBe(false);
  });

  it('reopens paused intake once for a deletion refused only because intake is paused', async () => {
    const { report, calls, intake } = await run({
      deleteOwn: ({ intake: current }) => (current.photosOpen ? undefined : { status: 409, code: 'UPLOADS_DISABLED', deleted: false }),
    });
    expect(report.results.map((result: Json) => [result.status, result.deletionRequiredReopen])).toEqual([['pass', true], ['pass', false]]);
    expect(calls.filter((call) => call.startsWith('intake:'))).toEqual(['intake:reopen', 'intake:pause', 'intake:reopen', 'intake:pause']);
    expect(intake.photosOpen).toBe(false);
    expect(report.cleanupFailure).toBeUndefined();
  });

  it('reports a cleanup failure when an upload cannot be removed', async () => {
    const { report } = await run({ deleteOwn: () => ({ status: 403, code: 'ROLE_FORBIDDEN', deleted: false }) }, [unitPng]);
    expect(report.results[0]).toMatchObject({ status: 'fail', reason: 'delete-refused', deleted: false });
    expect(report.cleanupFailure).toBe('media');
    expect(report.runtimeFailure).toBeUndefined();
  });
});

describe('frozen ZIP parsing', () => {
  type ExportMedia = Parameters<typeof buildExportZipStream>[0][number]['media'];
  const exportRecord = (id: string, filename: string, mimeType: KnownImageMimeType, bytes: Uint8Array, extra: Partial<ExportMedia> = {}): ExportMedia => ({
    id, objectKey: `events/${EVENT_ID}/media/${id}`, objectBucketGeneration: 'canonical', originalFilename: filename, mimeType,
    declaredByteSize: bytes.length, byteSize: bytes.length, width: 1, height: 1, guestName: 'Live workflow recorder', caption: null,
    publicationStatus: 'unpublished', createdAt: '2026-08-20T10:00:00.000Z', publishedAt: null, ...extra,
  });
  const collect = async (stream: ReadableStream<Uint8Array>) => new Uint8Array(await new Response(stream).arrayBuffer());
  function chunked(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
    let offset = 0;
    return new ReadableStream({ pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(offset, offset + size)); offset += size;
    } });
  }
  const photos: Array<{ id: string; name: string; mime: KnownImageMimeType; bytes: Uint8Array<ArrayBuffer> }> = [
    { id: 'm1', name: 'IMG_0001.HEIC', mime: 'image/heic', bytes: pattern(70_001, 1) },
    { id: 'm2', name: 'raw.dng', mime: 'image/dng', bytes: pattern(3, 2) },
    { id: 'm3', name: 'Guest, "quoted".png', mime: 'image/png', bytes: pattern(1, 3) },
  ];
  /** Exactly the export writer: fflate streaming ZIP, stored members with data descriptors, plus media.csv. */
  async function writerArchive() {
    const records = photos.map((photo) => exportRecord(photo.id, photo.name, photo.mime, photo.bytes, { caption: 'Line one,\r\n"two"' }));
    const width = exportPathWidth(records.length);
    const zip = await collect(buildExportZipStream(records.map((media, index) => ({ media, body: new Response(photos[index]!.bytes).body! })), { startIndex: 0, width }));
    const rows: Json[] = parseExportManifest(buildExportManifest([{ partNumber: 1, media: records }], width));
    return { zip, rows, sizes: new Map(rows.map((row) => [row.archivePath, row.byteSize])) };
  }

  it('hashes members of the actual export writer across arbitrary chunk boundaries', async () => {
    const { zip, rows, sizes } = await writerArchive();
    expect(rows.map((row) => row.mediaId)).toEqual(['m1', 'm2', 'm3']);
    for (const size of [1, 7, 4096, zip.length]) {
      const found = await readStoredZip(chunked(zip, size), { sizes, targets: new Set([...rows.map((row) => row.archivePath), 'photos/999-absent.png']) });
      for (const [index, row] of rows.entries()) {
        expect(found.get(row.archivePath), `${size}`).toEqual({ sha256: sha(photos[index]!.bytes), byteSize: photos[index]!.bytes.length });
      }
      expect(found.has('photos/999-absent.png')).toBe(false);
    }
  });

  it('hashes stored members whose sizes are in their local headers', async () => {
    const records = photos.map((photo) => exportRecord(photo.id, photo.name, photo.mime, photo.bytes));
    const zip = buildExportZip(records.map((media, index) => ({ media, bytes: photos[index]!.bytes })), { startIndex: 0, width: 3 });
    const target = exportPath(records[0]!, 0, 3);
    const found = await readStoredZip(chunked(zip, 5), { sizes: new Map(), targets: new Set([target]) });
    expect(found.get(target)).toEqual({ sha256: sha(photos[0]!.bytes), byteSize: photos[0]!.bytes.length });
  });

  it('fails closed on tampered, truncated, duplicated, oversized-descriptor or ZIP64 archives', async () => {
    const { zip, rows, sizes } = await writerArchive();
    const targets = new Set([rows[0]!.archivePath]);
    const attempt = (bytes: Uint8Array, options: Json = { sizes, targets }) => readStoredZip(chunked(bytes, 64), options);
    const flip = (bytes: Uint8Array, at: number) => { const copy = bytes.slice(); copy[at] = copy[at]! ^ 1; return copy; };
    await expect(attempt(flip(zip, 30 + rows[0]!.archivePath.length + 5))).rejects.toThrow();
    await expect(attempt(zip.slice(0, zip.length - 10))).rejects.toThrow();
    await expect(attempt(Uint8Array.from([...zip, 0]))).rejects.toThrow();
    await expect(attempt(zip, { sizes: new Map([...sizes, [rows[0]!.archivePath, rows[0]!.byteSize + 1]]), targets })).rejects.toThrow();
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const directory = view.getUint32(zip.length - 22 + 16, true);
    await expect(attempt(flip(zip, directory + 16))).rejects.toThrow();
    // A signed descriptor whose sizes disagree with the manifest length is refused even when its CRC-32 matches.
    const descriptorAt = 30 + rows[0]!.archivePath.length + rows[0]!.byteSize;
    expect(view.getUint32(descriptorAt, true)).toBe(0x08074b50);
    const lying = zip.slice(); const lies = new DataView(lying.buffer);
    lies.setUint32(descriptorAt + 8, rows[0]!.byteSize + 1, true); lies.setUint32(descriptorAt + 12, rows[0]!.byteSize + 1, true);
    await expect(attempt(lying)).rejects.toThrow();
    // media.csv has no manifest size: its descriptor is found by content, but never beyond the scan bound.
    await expect(attempt(zip, { sizes, targets, maxScanBytes: 8 })).rejects.toThrow();
    const archive = (build: (add: (name: string, bytes: Uint8Array, extra?: Record<number, Uint8Array>) => void) => void) => {
      const chunks: Uint8Array[] = [];
      const zipper = new Zip((error, data) => { if (error) throw error; chunks.push(data); });
      build((name, bytes, extra) => { const file = new ZipPassThrough(name); if (extra) file.extra = extra; zipper.add(file); file.push(bytes, true); });
      zipper.end();
      return Uint8Array.from(Buffer.concat(chunks));
    };
    const member = 'photos/001-a.png';
    const duplicate = archive((add) => { add(member, pattern(10, 1)); add(member, pattern(10, 2)); });
    await expect(attempt(duplicate, { sizes: new Map([[member, 10]]), targets: new Set([member]) })).rejects.toThrow();
    const zip64 = archive((add) => { add(member, pattern(10, 1), { 1: new Uint8Array(16) }); });
    await expect(attempt(zip64, { sizes: new Map([[member, 10]]), targets: new Set([member]) })).rejects.toThrow();
    // ZIP64 in the local header alone (its central-directory copy renamed to an unknown field) still fails closed.
    const localOnly = zip64.slice();
    const listed = new DataView(localOnly.buffer).getUint32(localOnly.length - 22 + 16, true) + 46 + member.length;
    localOnly[listed] = 0x99; localOnly[listed + 1] = 0x99;
    await expect(attempt(localOnly, { sizes: new Map([[member, 10]]), targets: new Set([member]) })).rejects.toThrow();
  });

  it('reads the run manifest exactly as the writer escapes it, across parts', () => {
    const records = [
      exportRecord('m1', '=cmd|,"x".jpg', 'image/jpeg', pattern(5, 1), { guestName: '+Guest, "A"', caption: 'multi\r\nline, "quoted"' }),
      exportRecord('m2', 'b.png', 'image/png', pattern(6, 2)),
    ];
    const parts = partitionExportSnapshot(records, 6);
    const manifest = buildExportManifest(parts, 3);
    expect(parseExportManifest(manifest)).toEqual([
      { partNumber: 1, archivePath: exportPath(records[0]!, 0, 3), mediaId: 'm1', byteSize: 5 },
      { partNumber: 2, archivePath: exportPath(records[1]!, 1, 3), mediaId: 'm2', byteSize: 6 },
    ]);
    expect(parseExportManifest('part_number\r\n1\r\n')).toBeNull();
    expect(parseExportManifest(manifest.replace('"', ''))).toBeNull();
    expect(parseExportManifest(manifest.replace(/\r\n1,/u, '\r\n0,'))).toBeNull();
  });
});

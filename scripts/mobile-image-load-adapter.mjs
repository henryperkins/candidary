/* global AbortSignal, Buffer, Headers, URL, URLSearchParams, performance, setTimeout */
/**
 * Reviewed deployment adapter for the mobile-image rehearsal harness.
 *
 * It speaks only Candidary's public HTTP API exactly as the browser does:
 * per-identity cookie jars, printed-entry and management-link exchanges, the
 * target Origin plus scope CSRF headers on writes, parts-v1 transfers with
 * `x-part-sha256`, and the direct path for negative controls. It never logs, and
 * returns only the harness allowlist (no credential, filename, path, identifier or
 * exception text). Egress: every delivered original is downloaded once through
 * the manager original route to prove its SHA-256.
 */
import { createHash, randomUUID } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const MiB = 1024 ** 2;
export const PART_BYTES = 8 * MiB;
const DIRECT_MAX_BYTES = 20 * MiB;
const IMAGES_INPUT_MAX_BYTES = 20_000_000;
const MAX_ORIGINAL_BYTES = 512 * MiB;
const CSRF_HEADERS = { candidary_csrf: 'x-candidary-csrf', candidary_host_csrf: 'x-candidary-host-csrf', candidary_rsvp_csrf: 'x-candidary-rsvp-csrf' };
const credentialPattern = /^[A-Za-z0-9_-]{1,256}\.[A-Za-z0-9_-]{1,512}$/u;
const eventIdPattern = /^[a-zA-Z0-9_-]{8,128}$/u;
const hex = /^[a-f0-9]{64}$/u;

/** Deliberately message-free: nothing request- or credential-derived can escape in an exception. */
class RehearsalFailure extends Error { constructor() { super('Rehearsal operation failed.'); } }
const fail = () => { throw new RehearsalFailure(); };

class CookieJar {
  #cookies = new Map();
  absorb(headers) {
    const lines = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
    for (const line of lines) {
      const [pair, ...attributes] = line.split(';');
      const split = pair.indexOf('=');
      if (split < 1) continue;
      const name = pair.slice(0, split).trim(), value = pair.slice(split + 1).trim();
      if (!value || attributes.some(item => /^\s*max-age\s*=\s*(0|-\d+)\s*$/iu.test(item))) this.#cookies.delete(name);
      else this.#cookies.set(name, value);
    }
  }
  header() { return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join('; '); }
  get(name) { return this.#cookies.get(name); }
  clear() { this.#cookies.clear(); }
}

async function sha256File(path, size) {
  const handle = await open(path, 'r');
  try {
    const hash = createHash('sha256'); const buffer = Buffer.alloc(PART_BYTES); let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (!bytesRead) fail();
      hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
    }
    if ((await handle.stat()).size !== size) fail();
    return hash.digest('hex');
  } finally { await handle.close(); }
}
function sourceShape(entry, { mime, maxBytes, minBytes = 1 }) {
  return entry && typeof entry === 'object' && typeof entry.path === 'string' && isAbsolute(entry.path) && hex.test(entry.sha256 ?? '')
    && Number.isSafeInteger(entry.byteSize) && entry.byteSize >= minBytes && entry.byteSize <= maxBytes
    && typeof entry.mimeType === 'string' && (mime ? entry.mimeType === mime : /^image\/[a-z0-9.+-]{1,40}$/u.test(entry.mimeType))
    && typeof entry.extension === 'string' && /^[a-z0-9]{2,5}$/u.test(entry.extension);
}
/** Private sources are verified byte-for-byte before the first request. */
async function loadSources(path, plan) {
  if (typeof path !== 'string' || !isAbsolute(path)) fail();
  const data = JSON.parse(await readFile(path, 'utf8'));
  const buckets = [...new Set(plan.sourceSizes)];
  if (data?.kind !== 'candidary.image-load-sources' || !Array.isArray(data.sources) || data.sources.length < 1 || data.sources.length > 1024
    || data.sources.some(entry => !sourceShape(entry, { maxBytes: MAX_ORIGINAL_BYTES }) || !buckets.includes(entry.bucketBytes)
      || entry.byteSize < entry.bucketBytes / 2 || entry.byteSize > entry.bucketBytes * 1.5 || entry.byteSize <= PART_BYTES)
    || buckets.some(size => !data.sources.some(entry => entry.bucketBytes === size))
    || !sourceShape(data.directControl, { mime: 'image/jpeg', maxBytes: DIRECT_MAX_BYTES })
    || (data.regenerationSeed !== undefined && !sourceShape(data.regenerationSeed, { mime: 'image/jpeg', minBytes: IMAGES_INPUT_MAX_BYTES + 1, maxBytes: DIRECT_MAX_BYTES }))
    || (plan.controls.regenerationSeeds > 0 && !data.regenerationSeed)) fail();
  for (const entry of [...data.sources, data.directControl, ...(data.regenerationSeed ? [data.regenerationSeed] : [])]) {
    if (await sha256File(entry.path, entry.byteSize) !== entry.sha256) fail();
  }
  const bytes = async entry => { const value = await readFile(entry.path); if (value.length !== entry.byteSize) fail(); return new Uint8Array(value); };
  return { byBucket: new Map(buckets.map(size => [size, data.sources.filter(entry => entry.bucketBytes === size)])),
    smallest: data.sources.reduce((low, entry) => entry.byteSize < low.byteSize ? entry : low),
    direct: { ...data.directControl, bytes: await bytes(data.directControl) },
    seed: data.regenerationSeed ? { ...data.regenerationSeed, bytes: await bytes(data.regenerationSeed) } : null };
}
async function loadCredentials(path, required) {
  if (typeof path !== 'string' || !isAbsolute(path)) fail();
  const data = JSON.parse(await readFile(path, 'utf8'));
  if (data?.kind !== 'candidary.image-load-credentials' || !Array.isArray(data.events)) fail();
  // One private file may serve all three runs; only the authorized events are ever exchanged.
  const events = new Map(data.events.map(item => [item?.eventId, item]));
  if (events.size !== data.events.length || required.some(id => {
    const item = events.get(id);
    return !eventIdPattern.test(id) || !credentialPattern.test(item?.entryCredential ?? '') || !credentialPattern.test(item?.managementToken ?? '');
  })) fail();
  return events;
}

export function createLoadAdapter(options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const pollTimeoutMs = options.pollTimeoutMs ?? 600_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
  const downloadTimeoutMs = options.downloadTimeoutMs ?? 900_000;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const now = options.now ?? (() => performance.now());
  let state = null;
  const handles = new Map();

  async function call(jar, method, path, { json, body, headers = {}, timeoutMs = requestTimeoutMs } = {}) {
    const url = new URL(path, state.origin);
    if (url.origin !== state.origin) fail();
    const outgoing = new Headers(headers);
    const cookie = jar?.header();
    if (cookie) outgoing.set('cookie', cookie);
    // The browser sends Origin on same-origin writes, never on GET; api.ts offers every scope CSRF token.
    if (method !== 'GET' && method !== 'HEAD') {
      outgoing.set('origin', state.origin);
      for (const [name, header] of Object.entries(CSRF_HEADERS)) {
        const value = jar?.get(name);
        if (value) outgoing.set(header, decodeURIComponent(value));
      }
    }
    let payload = body;
    if (json !== undefined) { payload = JSON.stringify(json); outgoing.set('content-type', 'application/json'); }
    const response = await fetchImpl(url, { method, headers: outgoing, body: payload, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    jar?.absorb(response.headers);
    return response;
  }
  async function data(response, ...statuses) {
    if (!statuses.includes(response.status)) { await response.body?.cancel().catch(() => {}); fail(); }
    const value = await response.json().catch(fail);
    if (!value || typeof value !== 'object' || !('data' in value)) fail();
    return value.data;
  }
  async function exchangeGuest(eventId) {
    const jar = new CookieJar();
    await data(await call(jar, 'POST', '/api/entry/exchange', { json: { token: state.credentials.get(eventId).entryCredential } }), 200);
    if (!jar.get('candidary_session') || !jar.get('candidary_csrf')) fail();
    return jar;
  }
  async function guestJar(eventId, guestIndex) {
    const key = `${eventId}:${guestIndex}`;
    if (!state.guests.has(key)) state.guests.set(key, exchangeGuest(eventId));
    return state.guests.get(key);
  }
  async function manager(eventId) {
    const jar = new CookieJar();
    const response = await call(jar, 'GET', `/manage/${state.credentials.get(eventId).managementToken}`);
    await response.body?.cancel().catch(() => {});
    if (response.status !== 302 || !jar.get('candidary_session')) fail();
    const { event } = await data(await call(jar, 'GET', `/api/manage/events/${eventId}`), 200);
    if (event?.id !== eventId || typeof event.slug !== 'string') fail();
    return { jar, event };
  }
  async function openIntake(eventId, gallery) {
    const { jar } = state.managers.get(eventId);
    let { event } = state.managers.get(eventId);
    if (!event.photosOpen) {
      ({ event } = await data(await call(jar, 'POST', `/api/manage/events/${eventId}/photo-intake`, { json: { action: 'open_early' } }), 200));
      if (!event?.photosOpen) fail();
    }
    if (gallery && !event.galleryVisible) {
      const keep = ['name', 'welcomeMessage', 'guestbookPrompt', 'moderationRequired', 'eventTimezone', 'eventStartTime', 'rsvpDeadlineDate', 'rsvpEnabled', 'rsvpRosterVersion'];
      const settings = Object.fromEntries(keep.filter(key => event[key] !== undefined && event[key] !== null).map(key => [key, event[key]]));
      ({ event } = await data(await call(jar, 'PATCH', `/api/manage/events/${eventId}/settings`, { json: { ...settings, galleryVisible: true } }), 200));
      if (event?.galleryVisible !== true) fail();
    }
    state.managers.get(eventId).event = event;
  }
  async function publishedList(eventId) {
    const ids = []; let cursor = null;
    do {
      const query = new URLSearchParams({ status: 'published', limit: '50', ...(cursor ? { cursor } : {}) });
      const page = await data(await call(state.managers.get(eventId).jar, 'GET', `/api/manage/events/${eventId}/media?${query}`), 200);
      if (!Array.isArray(page?.media)) fail();
      for (const item of page.media) if (typeof item?.id === 'string') ids.push(item.id);
      cursor = page.nextCursor ?? null;
    } while (cursor);
    return ids;
  }
  async function handle(entry) {
    if (!handles.has(entry.path)) handles.set(entry.path, open(entry.path, 'r'));
    return handles.get(entry.path);
  }
  async function part(entry, index) {
    const size = Math.min(PART_BYTES, entry.byteSize - index * PART_BYTES);
    const bytes = Buffer.alloc(size);
    const { bytesRead } = await (await handle(entry)).read(bytes, 0, size, index * PART_BYTES);
    if (bytesRead !== size) fail();
    return { bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, size), sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  const slug = eventId => state.managers.get(eventId).event.slug;
  const retryable = status => status === 429 || status >= 500;

  async function reserveTransfer(jar, eventId, entry, key, guestName) {
    const reserved = await data(await call(jar, 'POST', `/api/event/${slug(eventId)}/uploads`, { json: {
      filename: `rehearsal-${key}.${entry.extension}`, mimeType: entry.mimeType, byteSize: entry.byteSize, idempotencyKey: key, guestName, transport: 'parts-v1',
    } }), 201);
    const transfer = reserved?.transfer, mediaId = reserved?.media?.id;
    if (reserved?.alreadyDelivered !== false || typeof mediaId !== 'string' || transfer?.mediaId !== mediaId || transfer.partBytes !== PART_BYTES
      || transfer.partCount !== Math.ceil(entry.byteSize / PART_BYTES) || transfer.state !== 'receiving') fail();
    return { mediaId, transfer, path: `/api/event/${slug(eventId)}/uploads/${encodeURIComponent(mediaId)}/transfers/${encodeURIComponent(transfer.id)}` };
  }
  async function sendPart(jar, path, entry, index) {
    for (let attempt = 0; ; attempt++) {
      const chunk = await part(entry, index);
      let response;
      try {
        response = await call(jar, 'PUT', `${path}/parts/${index}`, { body: chunk.bytes, headers: {
          'content-type': 'application/octet-stream', 'x-part-sha256': chunk.sha256, 'content-length': String(chunk.bytes.byteLength) } });
      } catch { response = null; }
      if (response?.status === 200) {
        const ack = await data(response, 200);
        if (ack?.index !== index || ack.accepted !== true) fail();
        return;
      }
      await response?.body?.cancel().catch(() => {});
      if (response && !retryable(response.status)) fail();
      // A lost acknowledgement may still have accepted the exact part.
      const status = await data(await call(jar, 'GET', path), 200).catch(() => null);
      if (status?.transfer?.acceptedParts?.includes(index)) return;
      if (attempt === 2) fail();
      await sleep(350 * 2 ** attempt);
    }
  }
  async function directUpload(jar, eventId, entry, key, guestName) {
    const reserved = await data(await call(jar, 'POST', `/api/event/${slug(eventId)}/uploads`, { json: {
      filename: `control-${key}.${entry.extension}`, mimeType: entry.mimeType, byteSize: entry.byteSize, idempotencyKey: key, guestName,
    } }), 201);
    const uploadUrl = reserved?.uploadUrl;
    if (reserved?.alreadyDelivered !== false || typeof uploadUrl !== 'string' || !uploadUrl.startsWith(`/api/event/${slug(eventId)}/uploads/`)) fail();
    const stored = await data(await call(jar, 'PUT', uploadUrl, { body: entry.bytes, headers: {
      'content-type': entry.mimeType, 'content-length': String(entry.bytes.byteLength) } }), 200);
    if (stored?.media?.id !== reserved.media?.id || stored.media.uploadState !== 'stored') fail();
    return stored.media.id;
  }
  async function download(eventId, mediaId, expectedBytes) {
    const response = await call(state.managers.get(eventId).jar, 'GET', `/api/media/${encodeURIComponent(mediaId)}/original`, { timeoutMs: downloadTimeoutMs });
    if (response.status !== 200 || !response.body) { await response.body?.cancel().catch(() => {}); return null; }
    const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of response.body) { hash.update(chunk); bytes += chunk.byteLength; if (bytes > expectedBytes) break; }
    return { sha256: hash.digest('hex'), bytes, declared: Number(response.headers.get('content-length')) };
  }
  async function publish(eventId, mediaId) {
    const published = await data(await call(state.managers.get(eventId).jar, 'PATCH', `/api/manage/events/${eventId}/media/${encodeURIComponent(mediaId)}`,
      { json: { action: 'publish', expectedStatus: 'unpublished' } }), 200).catch(() => null);
    if (published?.media?.id !== mediaId) return false;
    state.published.get(eventId).push(mediaId);
    return true;
  }
  /** A denial must be a closed 401/403 envelope with no decoder, object-key or digest material. */
  async function denied(response) {
    const text = await response.text().catch(() => '');
    const leak = [...response.headers.keys()].some(name => name.startsWith('x-decoder')) || /[a-f0-9]{64}/u.test(text) || /media\//u.test(text);
    return { denied: (response.status === 401 || response.status === 403) && !leak, violation: (response.status >= 200 && response.status < 300) || leak };
  }
  /** Cold probes run beside the first uploads; they wait for a published target instead of failing. */
  async function target(index) {
    const shard = index % state.plan.eventShards;
    const eventId = state.galleryEvents[shard], list = state.published.get(eventId), started = now();
    while (!list.length) { if (now() - started > pollTimeoutMs) fail(); await sleep(pollIntervalMs); }
    return { eventId, mediaId: list[Math.floor(index / state.plan.eventShards) % list.length], shard };
  }
  const guestName = index => `Rehearsal guest ${index + 1}`;

  return {
    async prepare({ plan, authorization }) {
      const galleryEvents = [...authorization.eventIds].slice(0, plan.eventShards);
      const uploadEvents = plan.scenario === 'mixed' ? [...authorization.uploadEventIds].slice(0, plan.eventShards) : galleryEvents;
      const isolation = authorization.isolationEventId;
      const required = [...new Set([...authorization.eventIds, ...(authorization.uploadEventIds ?? []), isolation])];
      if (galleryEvents.length !== plan.eventShards || uploadEvents.length !== plan.eventShards) fail();
      const origin = new URL(authorization.target).origin;
      // Every private input is validated before the first request leaves this process.
      const credentials = await loadCredentials(authorization.credentialsPath, required);
      const sources = await loadSources(authorization.sourcesPath, plan);
      state = { plan, origin, credentials, sources, galleryEvents, uploadEvents, isolation, runId: randomUUID(),
        managers: new Map(), guests: new Map(), published: new Map() };
      for (const eventId of required) state.managers.set(eventId, await manager(eventId));
      for (const eventId of new Set([...galleryEvents, ...uploadEvents])) await openIntake(eventId, galleryEvents.includes(eventId));
      for (const eventId of galleryEvents) state.published.set(eventId, plan.scenario === 'cold' ? [] : await publishedList(eventId));
      if (plan.scenario !== 'cold' && galleryEvents.some(eventId => state.published.get(eventId).length < plan.pageTiles)) fail();
      for (let guest = 0; guest < plan.guests; guest++) {
        const eventId = galleryEvents[guest % plan.eventShards];
        await data(await call(await guestJar(eventId, guest), 'GET', `/api/event/${slug(eventId)}/gallery`), 200);
      }
      state.isolationJar = await exchangeGuest(isolation);
    },

    async upload({ index, shard, guestIndex, byteSize }) {
      const eventId = state.uploadEvents[shard];
      const candidates = state.sources.byBucket.get(byteSize);
      const entry = candidates[Math.floor(index / state.plan.sourceSizes.length) % candidates.length];
      const jar = await guestJar(eventId, guestIndex);
      const { mediaId, transfer, path } = await reserveTransfer(jar, eventId, entry, `load-${state.runId}-${index}`, guestName(guestIndex));
      for (let partIndex = 0; partIndex < transfer.partCount; partIndex++) await sendPart(jar, path, entry, partIndex);
      // Verification time excludes the client transfer: complete request to stored receipt.
      const started = now();
      await data(await call(jar, 'POST', `${path}/complete`, { json: {} }), 200, 202);
      // Assigned only on the delivered exit; every other exit returns a failure row.
      let receiptVerified, incorrectReceipt;
      for (;;) {
        const status = await data(await call(jar, 'GET', path), 200);
        const current = status?.transfer?.state;
        if (current === 'delivered') {
          receiptVerified = status.transfer.mediaId === mediaId && status.media?.id === mediaId && status.media.uploadState === 'stored';
          incorrectReceipt = !receiptVerified;
          break;
        }
        if (!['processing', 'retryable'].includes(current) || now() - started > pollTimeoutMs) return { ok: false, sourceBytes: entry.byteSize };
        await sleep(pollIntervalMs);
      }
      const verificationMs = now() - started;
      const original = await download(eventId, mediaId, entry.byteSize);
      const hashVerified = !!original && original.sha256 === entry.sha256 && original.bytes === entry.byteSize && original.declared === entry.byteSize;
      if (state.plan.scenario === 'cold' && receiptVerified) await publish(eventId, mediaId);
      return { ok: receiptVerified && hashVerified, receiptVerified, hashVerified, incorrectReceipt,
        hashMismatch: !!original && !hashVerified, verificationMs, sourceBytes: entry.byteSize };
    },

    async preview({ guestIndex, shard, localGuest, tile }) {
      const eventId = state.galleryEvents[shard], list = state.published.get(eventId);
      if (!list.length) fail();
      const mediaId = list[(localGuest * state.plan.pageTiles + tile) % list.length];
      const response = await call(await guestJar(eventId, guestIndex), 'GET', `/api/media/${encodeURIComponent(mediaId)}/preview`);
      const bytes = response.body ? new Uint8Array(await response.arrayBuffer()).byteLength : 0;
      const h = response.headers;
      const previewHit = response.status === 200;
      const previewPrivate = previewHit && h.get('cache-control') === 'private, no-store' && /\bcookie\b/iu.test(h.get('vary') ?? '')
        && h.get('x-content-type-options') === 'nosniff' && h.get('cross-origin-resource-policy') === 'same-origin'
        && /^image\//u.test(h.get('content-type') ?? '') && !h.has('set-cookie') && ![...h.keys()].some(name => name.startsWith('x-decoder'));
      return { ok: previewHit && previewPrivate && bytes > 0 && bytes === Number(h.get('content-length')), previewHit, previewPrivate };
    },

    async control({ index, phase }) {
      const guest = index % state.plan.guests, eventId = state.galleryEvents[guest % state.plan.eventShards];
      await directUpload(await guestJar(eventId, guest), eventId, state.sources.direct, `control-${state.runId}-${phase}-${index}`, guestName(guest));
      return { ok: true };
    },

    async probe({ index, kind }) {
      if (kind === 'privacy') {
        const { eventId, mediaId, shard } = await target(index);
        const guest = await guestJar(eventId, shard);
        const variant = index % 4;
        const response = await call(variant === 1 ? state.isolationJar : variant === 2 ? guest : null, 'GET',
          `/api/media/${encodeURIComponent(mediaId)}/${variant === 0 || variant === 1 ? 'preview' : 'original'}`);
        const result = await denied(response);
        return { ok: result.denied, violation: result.violation };
      }
      if (kind === 'deletion') {
        const shard = index % state.plan.eventShards, eventId = state.galleryEvents[shard];
        const jar = await guestJar(eventId, shard);
        const mediaId = await directUpload(jar, eventId, state.sources.direct, `delete-${state.runId}-${index}`, guestName(shard));
        const removed = await data(await call(jar, 'DELETE', `/api/event/${slug(eventId)}/uploads/${encodeURIComponent(mediaId)}`), 200);
        if (removed?.media?.id !== mediaId || removed.media.deleted !== true) fail();
        const preview = await denied(await call(jar, 'GET', `/api/media/${encodeURIComponent(mediaId)}/preview`));
        const original = await denied(await call(state.managers.get(eventId).jar, 'GET', `/api/media/${encodeURIComponent(mediaId)}/original`));
        return { ok: preview.denied && original.denied, violation: preview.violation || original.violation };
      }
      if (kind === 'cancellation') {
        const shard = index % state.plan.eventShards, eventId = state.uploadEvents[shard];
        const jar = await guestJar(eventId, shard), entry = state.sources.smallest;
        const { mediaId, path } = await reserveTransfer(jar, eventId, entry, `cancel-${state.runId}-${index}`, guestName(shard));
        await sendPart(jar, path, entry, 0);
        const aborted = await data(await call(jar, 'DELETE', path), 200);
        const status = await data(await call(jar, 'GET', path), 200);
        const complete = await call(jar, 'POST', `${path}/complete`, { json: {} });
        const completed = complete.status >= 200 && complete.status < 300 ? await complete.json().catch(() => null) : (await complete.body?.cancel().catch(() => {}), null);
        const original = await denied(await call(state.managers.get(eventId).jar, 'GET', `/api/media/${encodeURIComponent(mediaId)}/original`));
        const receipt = status?.media !== undefined || completed?.data?.transfer?.state === 'delivered' || completed?.data?.media !== undefined;
        return { ok: aborted?.transfer?.state === 'aborted' && status?.transfer?.state === 'aborted' && !receipt && original.denied,
          violation: receipt || original.violation };
      }
      if (kind === 'regeneration-seed') {
        const shard = index % state.plan.eventShards, eventId = state.galleryEvents[shard];
        const mediaId = await directUpload(await guestJar(eventId, shard), eventId, state.sources.seed, `seed-${state.runId}-${index}`, guestName(shard));
        return { ok: await publish(eventId, mediaId) };
      }
      fail();
    },

    async close() {
      const pending = [...handles.values()]; handles.clear();
      await Promise.all(pending.map(item => item.then(value => value.close()).catch(() => {})));
      if (state) { for (const jar of await Promise.all([...state.guests.values()].map(item => item.catch(() => null)))) jar?.clear(); state = null; }
    },
  };
}

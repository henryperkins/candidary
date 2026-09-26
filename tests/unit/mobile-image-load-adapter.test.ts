import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error Node rehearsal script is exercised through its runtime interface.
import { buildLoadPlan, runScenario, declaredOperations, observationMetrics } from '../../scripts/mobile-image-load-harness.mjs';
// @ts-expect-error Node rehearsal adapter is exercised through its runtime interface.
import { createLoadAdapter } from '../../scripts/mobile-image-load-adapter.mjs';

const MiB = 1024 ** 2;
const ORIGIN = 'https://rehearsal-candidary-preview.lfd.workers.dev';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const dir = mkdtempSync(join(tmpdir(), 'candidary-load-adapter-'));
function file(name: string, size: number, fill: number) {
  const bytes = new Uint8Array(size); for (let index = 0; index < size; index++) bytes[index] = (index * 31 + fill) & 255;
  const path = join(dir, name); writeFileSync(path, bytes); return { path, bytes };
}
const raw = file('source.dng', 9 * MiB + 3, 7);
const direct = file('control.jpg', 64 * 1024, 11);
const seed = file('seed.jpg', 20_000_001, 13);

type Session = { token: string; csrf: string; eventId: string; role: 'guest' | 'manager' };
type Media = { id: string; eventId: string; owner: string; mimeType: string; byteSize: number; state: string; publication: string;
  bytes?: Uint8Array; parts: Map<number, Uint8Array>; transferId?: string; transferState?: string; polls: number; previewReads: number };
type Options = { corruptOriginal?: boolean; leakPreview?: boolean };

/** Real Candidary route shapes, Origin/CSRF rules and cookie scopes, served in-process. */
function fakeCandidary(eventIds: string[], options: Options = {}) {
  const events = new Map(eventIds.map((id, index) => [id, { id, slug: `event-${index}`, entry: `${id}entry.${'s'.repeat(24)}${index}`,
    manage: `${id}manage.${'m'.repeat(24)}${index}`, galleryVisible: false, photosOpen: true }]));
  const sessions = new Map<string, Session>(), media = new Map<string, Media>();
  const requests: Array<{ method: string; path: string; origin: string | null; csrf: string | null; cookie: string | null }> = [];
  const violations: string[] = [];
  const json = (data: unknown, status = 200, headers: HeadersInit = {}) => Response.json({ data, requestId: randomUUID() }, { status, headers });
  const error = (code: string, status: number) => Response.json({ code, message: 'Refused.', requestId: randomUUID() }, { status });
  function session(request: Request) {
    const cookie = request.headers.get('cookie') ?? '';
    const token = /candidary_session=([^;]+)/u.exec(cookie)?.[1];
    return token ? sessions.get(token) : undefined;
  }
  function mint(eventId: string, role: Session['role'], status = 200, headers: Record<string, string> = {}, body?: unknown) {
    const created = { token: randomUUID(), csrf: randomUUID(), eventId, role }; sessions.set(created.token, created);
    const response = body === undefined ? new Response(null, { status, headers }) : Response.json({ data: body, requestId: randomUUID() }, { status, headers });
    response.headers.append('Set-Cookie', `candidary_session=${created.token}; Path=/; HttpOnly; Secure; SameSite=Lax`);
    response.headers.append('Set-Cookie', `candidary_csrf=${created.csrf}; Path=/; Secure; SameSite=Lax`);
    return response;
  }
  function write(request: Request, actor: Session | undefined) {
    const originOk = request.headers.get('origin') === ORIGIN;
    const csrfOk = !!actor && request.headers.get('x-candidary-csrf') === actor.csrf;
    if (!originOk || !csrfOk) violations.push(`${request.method} ${new URL(request.url).pathname}`);
    return originOk && csrfOk;
  }
  const view = (item: Media) => ({ id: item.id, mimeType: item.mimeType, uploadState: item.state });
  const transfer = (item: Media) => ({ id: item.transferId, mediaId: item.id, state: item.transferState, partBytes: 8 * MiB,
    partCount: Math.ceil(item.byteSize / (8 * MiB)), acceptedParts: [...item.parts.keys()].sort(), expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    hardExpiresAt: new Date(Date.now() + 7200_000).toISOString(), previewState: item.state === 'stored' ? 'ready' : 'pending' });
  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url); const path = url.pathname; const method = request.method;
    const actor = session(request);
    requests.push({ method, path, origin: request.headers.get('origin'), csrf: request.headers.get('x-candidary-csrf'), cookie: request.headers.get('cookie') });
    if (url.origin !== ORIGIN) return error('ORIGIN_FORBIDDEN', 403);
    let m: RegExpExecArray | null;
    if (method === 'POST' && path === '/api/entry/exchange') {
      if (request.headers.get('origin') !== ORIGIN) return error('ORIGIN_FORBIDDEN', 403);
      const body = await request.json() as { token: string };
      const event = [...events.values()].find(item => item.entry === body.token);
      return event ? mint(event.id, 'guest', 200, {}, { location: `/event/${event.slug}` }) : error('EVENT_ENTRY_UNAVAILABLE', 410);
    }
    if (method === 'GET' && (m = /^\/manage\/([^/]+)$/u.exec(path))) {
      const event = [...events.values()].find(item => item.manage === m![1]);
      return event ? mint(event.id, 'manager', 302, { Location: `/manage/event/${event.id}` }) : error('LINK_INVALID', 404);
    }
    if ((m = /^\/api\/manage\/events\/([^/]+)(\/.*)?$/u.exec(path))) {
      const event = events.get(m[1]!); const rest = m[2] ?? '';
      if (!event || actor?.role !== 'manager' || actor.eventId !== event.id) return error('ROLE_FORBIDDEN', 403);
      const eventView = () => ({ id: event.id, slug: event.slug, name: 'Rehearsal', welcomeMessage: 'Welcome.', guestbookPrompt: 'Leave a note',
        galleryVisible: event.galleryVisible, moderationRequired: true, eventTimezone: 'America/Chicago', eventStartTime: '17:00',
        rsvpDeadlineDate: '2026-10-01', rsvpEnabled: false, rsvpRosterVersion: 0, photosOpen: event.photosOpen });
      if (method === 'GET' && rest === '') return json({ event: eventView() });
      if (method === 'PATCH' && rest === '/settings') {
        if (!write(request, actor)) return error('CSRF_INVALID', 403);
        const body = await request.json() as Record<string, unknown>;
        for (const key of ['guestbookPrompt', 'galleryVisible', 'moderationRequired', 'eventTimezone', 'rsvpDeadlineDate', 'rsvpEnabled', 'rsvpRosterVersion'])
          if (!(key in body)) return error('VALIDATION_FAILED', 422);
        event.galleryVisible = body.galleryVisible === true; return json({ event: eventView() });
      }
      if (method === 'GET' && rest === '/media') {
        const list = [...media.values()].filter(item => item.eventId === event.id && item.state === 'stored' && item.publication === url.searchParams.get('status'));
        const start = Number(url.searchParams.get('cursor') ?? 0); const limit = Number(url.searchParams.get('limit'));
        return json({ media: list.slice(start, start + limit).map(item => ({ id: item.id })), nextCursor: start + limit < list.length ? String(start + limit) : null });
      }
      if (method === 'PATCH' && (m = /^\/media\/([^/]+)$/u.exec(rest))) {
        if (!write(request, actor)) return error('CSRF_INVALID', 403);
        const item = media.get(m[1]!); const body = await request.json() as { action: string; expectedStatus: string };
        if (!item || item.eventId !== event.id || body.action !== 'publish' || item.publication !== body.expectedStatus) return error('VALIDATION_FAILED', 409);
        item.publication = 'published'; return json({ media: { id: item.id } });
      }
      return error('NOT_FOUND', 404);
    }
    if ((m = /^\/api\/event\/([^/]+)\/(gallery|uploads)(\/.*)?$/u.exec(path))) {
      const event = [...events.values()].find(item => item.slug === m![1]);
      if (!event || actor?.role !== 'guest' || actor.eventId !== event.id) return error('ROLE_FORBIDDEN', 403);
      const rest = m[3] ?? '';
      if (m[2] === 'gallery') return event.galleryVisible ? json({ media: [], nextCursor: null }) : error('GALLERY_HIDDEN', 403);
      if (method === 'POST' && rest === '') {
        if (!write(request, actor)) return error('CSRF_INVALID', 403);
        const body = await request.json() as { filename: string; mimeType: string; byteSize: number; idempotencyKey: string; guestName: string; transport?: string };
        const item: Media = { id: randomUUID(), eventId: event.id, owner: actor.token, mimeType: body.mimeType, byteSize: body.byteSize, state: 'reserved',
          publication: 'unpublished', parts: new Map(), polls: 0, previewReads: 0 };
        media.set(item.id, item);
        if (body.transport === 'parts-v1') {
          item.transferId = randomUUID(); item.transferState = 'receiving';
          return json({ media: view(item), alreadyDelivered: false, transport: 'parts-v1', transfer: transfer(item) }, 201);
        }
        return json({ media: view(item), alreadyDelivered: false, uploadUrl: `/api/event/${event.slug}/uploads/${item.id}/content` }, 201);
      }
      m = /^\/([^/]+)/u.exec(rest);
      const item = m ? media.get(m[1]!) : undefined;
      if (!item || item.owner !== actor.token) return error('ROLE_FORBIDDEN', 403);
      if (method === 'PUT' && rest === `/${item.id}/content`) {
        if (!write(request, actor)) return error('CSRF_INVALID', 403);
        const bytes = new Uint8Array(await request.arrayBuffer());
        if (Number(request.headers.get('content-length')) !== item.byteSize || bytes.length !== item.byteSize || request.headers.get('content-type') !== item.mimeType) return error('VALIDATION_FAILED', 422);
        item.bytes = bytes; item.state = 'stored'; return json({ media: view(item) });
      }
      if (method === 'DELETE' && rest === `/${item.id}`) {
        if (!write(request, actor)) return error('CSRF_INVALID', 403);
        item.state = 'deleted'; return json({ media: { id: item.id, deleted: true } });
      }
      const base = `/${item.id}/transfers/${item.transferId}`;
      if (method === 'GET' && rest === base) return json({ transfer: transfer(item), ...(item.transferState === 'delivered' && item.polls++ >= 0 ? { media: view(item) } : {}) });
      if (!write(request, actor)) return error('CSRF_INVALID', 403);
      if (method === 'PUT' && (m = new RegExp(`^${base}/parts/(\\d+)$`, 'u').exec(rest))) {
        const bytes = new Uint8Array(await request.arrayBuffer());
        if (bytes.length > 8 * MiB || Number(request.headers.get('content-length')) !== bytes.length || request.headers.get('x-part-sha256') !== sha(bytes)
          || request.headers.get('content-type') !== 'application/octet-stream' || item.transferState !== 'receiving') return error('VALIDATION_FAILED', 422);
        item.parts.set(Number(m[1]), bytes); return json({ index: Number(m[1]), accepted: true });
      }
      if (method === 'POST' && rest === `${base}/complete`) {
        if (item.transferState !== 'receiving' || item.parts.size !== Math.ceil(item.byteSize / (8 * MiB))) return error('UPLOAD_FINALIZE_CONFLICT', 409);
        const joined = new Uint8Array(item.byteSize); let offset = 0;
        for (const index of [...item.parts.keys()].sort((a, b) => a - b)) { joined.set(item.parts.get(index)!, offset); offset += item.parts.get(index)!.length; }
        item.bytes = joined; item.transferState = 'processing';
        setTimeout(() => { item.transferState = 'delivered'; item.state = 'stored'; }, 5);
        return json({ transfer: transfer(item) }, 202);
      }
      if (method === 'DELETE' && rest === base) { item.transferState = 'aborted'; item.state = 'failed'; return json({ transfer: transfer(item) }); }
      return error('NOT_FOUND', 404);
    }
    if (method === 'GET' && (m = /^\/api\/media\/([^/]+)\/(original|preview)$/u.exec(path))) {
      const item = media.get(m[1]!);
      if (!item || item.state !== 'stored') return error('ROLE_FORBIDDEN', 403);
      const manager = actor?.role === 'manager' && actor.eventId === item.eventId;
      if (m[2] === 'original') {
        if (!manager) return actor ? error('ROLE_FORBIDDEN', 403) : error('SESSION_REQUIRED', 401);
        // Copy into an ArrayBuffer-backed view: the DOM BodyInit type rejects ArrayBufferLike views.
        const bytes = new Uint8Array(options.corruptOriginal ? item.bytes!.map((value, index) => index === 0 ? value ^ 1 : value) : item.bytes!);
        return new Response(bytes, { headers: { 'Content-Type': item.mimeType, 'Content-Length': String(bytes.length), 'Cache-Control': 'private, no-store' } });
      }
      const guest = actor?.role === 'guest' && actor.eventId === item.eventId && (item.owner === actor.token || item.publication === 'published');
      if (!manager && !guest && !options.leakPreview) return actor ? error('ROLE_FORBIDDEN', 403) : error('SESSION_REQUIRED', 401);
      if (item.byteSize > 20_000_000 && item.previewReads++ === 0) return error('IMAGE_PREVIEW_UNAVAILABLE', 503);
      const bytes = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);
      return new Response(bytes, { headers: { 'Content-Type': 'image/webp', 'Content-Length': String(bytes.length), 'Cache-Control': 'private, no-store',
        Vary: 'Cookie', 'Cross-Origin-Resource-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff' } });
    }
    return error('NOT_FOUND', 404);
  }
  return { events, media, requests, violations, fetch: async (url: URL | string, init: RequestInit) => handle(new Request(url, init)) };
}

function inputs(scenario: string, gallery: string[], uploads: string[], isolation: string, server: ReturnType<typeof fakeCandidary>, sourceChanges: Record<string, unknown> = {}) {
  const credentials = { kind: 'candidary.image-load-credentials', events: [...server.events.values()].map(event => ({
    eventId: event.id, entryCredential: event.entry, managementToken: event.manage })) };
  const sources = { kind: 'candidary.image-load-sources',
    sources: [{ path: raw.path, sha256: sha(raw.bytes), byteSize: raw.bytes.length, bucketBytes: 9 * MiB, mimeType: 'image/dng', extension: 'dng' }],
    directControl: { path: direct.path, sha256: sha(direct.bytes), byteSize: direct.bytes.length, mimeType: 'image/jpeg', extension: 'jpg' },
    regenerationSeed: { path: seed.path, sha256: sha(seed.bytes), byteSize: seed.bytes.length, mimeType: 'image/jpeg', extension: 'jpg' }, ...sourceChanges };
  const credentialsPath = join(dir, `credentials-${randomUUID()}.json`); writeFileSync(credentialsPath, JSON.stringify(credentials));
  const sourcesPath = join(dir, `sources-${randomUUID()}.json`); writeFileSync(sourcesPath, JSON.stringify(sources));
  return { kind: 'candidary.image-load-authorization', target: `${ORIGIN}/`, scenario, eventIds: gallery, uploadEventIds: uploads, isolationEventId: isolation,
    credentialsPath, sourcesPath, secrets: credentials };
}
function smallPlan(scenario: string) {
  return { ...buildLoadPlan({ scenario }), guests: 4, originals: 6, pageTiles: 2, visitsPerGuest: 2, sourceSizes: [9 * MiB, 9 * MiB, 9 * MiB], eventShards: 2,
    uploadConcurrency: 2, previewConcurrency: 3, uploadIntervalMs: 0, previewIntervalMs: 0, controlIntervalMs: 0, live: true,
    controls: { directBaseline: 2, directDuringLoad: 2, privacy: 4, deletion: 1, cancellation: 1, regenerationSeeds: scenario === 'mixed' ? 1 : 0 } };
}
const adapterOptions = { pollIntervalMs: 1, sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)) };
afterEach(() => { vi.restoreAllMocks(); });

describe('reviewed Candidary rehearsal adapter against real route shapes', () => {
  it('runs cold uploads, publication, gallery previews, controls and probes with browser credentials and no logging', async () => {
    const log = vi.spyOn(console, 'log'); const err = vi.spyOn(console, 'error'); const warn = vi.spyOn(console, 'warn');
    const server = fakeCandidary(['gallery_event_0', 'gallery_event_1', 'isolation_event']);
    const authorization = inputs('cold', ['gallery_event_0', 'gallery_event_1'], [], 'isolation_event', server);
    const plan = smallPlan('cold');
    const report = await runScenario(plan, createLoadAdapter({ ...adapterOptions, fetch: server.fetch }), authorization);
    expect(server.violations).toEqual([]);
    expect(report.uploads).toHaveLength(6);
    expect(report.uploads.every((row: any) => row.ok && row.receiptVerified && row.hashVerified && row.verificationMs > 0 && row.sourceBytes === raw.bytes.length)).toBe(true);
    expect(report.previews).toHaveLength(16);
    expect(report.previews.every((row: any) => row.ok && row.previewHit && row.previewPrivate)).toBe(true);
    expect(report.controls.every((row: any) => row.ok)).toBe(true);
    expect(report.probes.map((row: any) => [row.kind, row.ok, row.violation])).toEqual([
      ...Array(4).fill(['privacy', true, false]), ['deletion', true, false], ['cancellation', true, false]]);
    const derived = observationMetrics(report);
    expect(derived).toMatchObject({ deliveredOriginals: 6, verifiedOriginalHashes: 6, successfulPreviewRequests: 16, privacyChecks: 4, deletionChecks: 1,
      cancellationChecks: 1, incorrectReceipts: 0, originalHashFailures: 0, privacyFailures: 0, unrecoveredTransientErrorRate: 0 });
    expect(declaredOperations(plan).total).toBe(6 + 16 + 4 + 6);
    // Browser-equivalent writes: every non-GET carried the target Origin and the event-scope CSRF header.
    expect(server.requests.filter(r => r.method !== 'GET').every(r => r.origin === ORIGIN)).toBe(true);
    expect(server.requests.filter(r => r.method === 'GET').every(r => r.origin === null && r.csrf === null)).toBe(true);
    expect(server.requests.filter(r => r.path.includes('/parts/')).length).toBe(6 * 2 + 1);
    expect([...server.events.values()].filter(event => event.id.startsWith('gallery')).every(event => event.galleryVisible)).toBe(true);
    expect([...server.media.values()].filter(item => item.byteSize === raw.bytes.length && item.state === 'stored').every(item => item.publication === 'published')).toBe(true);
    const text = JSON.stringify(report);
    for (const secret of authorization.secrets.events.flatMap(event => [event.entryCredential, event.managementToken])) expect(text).not.toContain(secret);
    for (const request of server.requests) if (request.cookie) expect(text).not.toContain(request.cookie.split('=')[1]!.split(';')[0]!);
    expect(text).not.toContain('source.dng'); expect(text).not.toContain(dir);
    expect([log, err, warn].every(spy => spy.mock.calls.length === 0)).toBe(true);
  });

  it('reads a warm gallery prepared only through manager APIs and uses no uploads', async () => {
    const server = fakeCandidary(['gallery_event_0', 'gallery_event_1', 'isolation_event']);
    const auth = inputs('cold', ['gallery_event_0', 'gallery_event_1'], [], 'isolation_event', server);
    await runScenario(smallPlan('cold'), createLoadAdapter({ ...adapterOptions, fetch: server.fetch }), auth);
    const before = server.requests.length;
    const warm = await runScenario(smallPlan('warm'), createLoadAdapter({ ...adapterOptions, fetch: server.fetch }), { ...auth, scenario: 'warm' });
    const after = server.requests.slice(before);
    expect(warm.uploads).toEqual([]);
    expect(warm.previews.every((row: any) => row.ok && row.previewHit)).toBe(true);
    expect(after.some(r => r.path.includes('/transfers/'))).toBe(true); // Only the cancellation probe touches a transfer.
    expect(after.filter(r => r.path.includes('/manage/events/') && r.path.endsWith('/media') && r.method === 'GET').length).toBeGreaterThan(0);
    expect(server.violations).toEqual([]);
  });

  it('uploads mixed originals to separate capacity events and seeds real regeneration misses into the read gallery', async () => {
    const server = fakeCandidary(['gallery_event_0', 'gallery_event_1', 'upload_event_0', 'upload_event_1', 'isolation_event']);
    const auth = inputs('cold', ['gallery_event_0', 'gallery_event_1'], [], 'isolation_event', server);
    await runScenario(smallPlan('cold'), createLoadAdapter({ ...adapterOptions, fetch: server.fetch }), auth);
    const mixed = await runScenario(smallPlan('mixed'), createLoadAdapter({ ...adapterOptions, fetch: server.fetch }),
      { ...auth, scenario: 'mixed', uploadEventIds: ['upload_event_0', 'upload_event_1'] });
    expect(mixed.uploads.every((row: any) => row.ok)).toBe(true);
    const uploaded = [...server.media.values()].filter(item => item.byteSize === raw.bytes.length && item.state === 'stored');
    expect(uploaded.filter(item => item.eventId.startsWith('upload_')).length).toBe(6);
    const seeded = [...server.media.values()].filter(item => item.byteSize === seed.bytes.length);
    expect(seeded).toHaveLength(1); expect(seeded[0]!.publication).toBe('published'); expect(seeded[0]!.eventId.startsWith('gallery_')).toBe(true);
    expect(mixed.probes.find((row: any) => row.kind === 'regeneration-seed')).toMatchObject({ ok: true });
    expect(mixed.previews.filter((row: any) => !row.previewHit)).toHaveLength(1);
    expect(mixed.previews.filter((row: any) => !row.previewHit)[0]).toMatchObject({ ok: false, previewPrivate: false });
  });

  it('refuses sources whose bytes or declared hashes differ before any request', async () => {
    const server = fakeCandidary(['gallery_event_0', 'gallery_event_1', 'isolation_event']);
    for (const change of [{ sources: [{ path: raw.path, sha256: '0'.repeat(64), byteSize: raw.bytes.length, bucketBytes: 9 * MiB, mimeType: 'image/dng', extension: 'dng' }] },
      { sources: [{ path: raw.path, sha256: sha(raw.bytes), byteSize: raw.bytes.length + 1, bucketBytes: 9 * MiB, mimeType: 'image/dng', extension: 'dng' }] },
      { sources: [{ path: 'relative.dng', sha256: sha(raw.bytes), byteSize: raw.bytes.length, bucketBytes: 9 * MiB, mimeType: 'image/dng', extension: 'dng' }] },
      { directControl: { path: direct.path, sha256: sha(direct.bytes), byteSize: direct.bytes.length, mimeType: 'image/dng', extension: 'dng' } },
      { regenerationSeed: { path: direct.path, sha256: sha(direct.bytes), byteSize: direct.bytes.length, mimeType: 'image/jpeg', extension: 'jpg' } }]) {
      const auth = inputs('cold', ['gallery_event_0', 'gallery_event_1'], [], 'isolation_event', server, change);
      const adapter = createLoadAdapter({ ...adapterOptions, fetch: server.fetch });
      await expect(adapter.prepare({ plan: smallPlan('cold'), authorization: auth })).rejects.toThrow();
      await adapter.close();
    }
    expect(server.requests).toEqual([]);
  });

  it('classifies original hash mismatches and privacy leaks as failures, never as successes', async () => {
    const corrupt = fakeCandidary(['gallery_event_0', 'gallery_event_1', 'isolation_event'], { corruptOriginal: true });
    const bad = await runScenario(smallPlan('cold'), createLoadAdapter({ ...adapterOptions, fetch: corrupt.fetch }),
      inputs('cold', ['gallery_event_0', 'gallery_event_1'], [], 'isolation_event', corrupt));
    expect(bad.uploads.every((row: any) => !row.ok && row.hashMismatch && row.receiptVerified)).toBe(true);
    expect(observationMetrics(bad).originalHashFailures).toBe(6);
    const leak = fakeCandidary(['gallery_event_0', 'gallery_event_1', 'isolation_event'], { leakPreview: true });
    const leaked = await runScenario(smallPlan('cold'), createLoadAdapter({ ...adapterOptions, fetch: leak.fetch }),
      inputs('cold', ['gallery_event_0', 'gallery_event_1'], [], 'isolation_event', leak));
    const privacy = leaked.probes.filter((row: any) => row.kind === 'privacy');
    expect(privacy.some((row: any) => row.violation === true && row.ok === false)).toBe(true);
    expect(observationMetrics(leaked).privacyFailures).toBeGreaterThan(0);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  COVER_WORKFLOW_FENCE_TERMINAL_TTL_MS,
  MAX_COVER_UPLOAD_BYTES,
} from '../../shared/constants';
import { COVER_PIPELINE_VERSIONS, canonicalCoverRequest } from '../../shared/event-cover';
import { createApp } from '../../worker/app';
import type { AppEnv } from '../../worker/env';
import {
  coverRequestDigest,
} from '../../worker/services/event-cover-publication';
import {
  eventAccess,
  hostAccess,
  hostWriteHeaders,
  origin,
  resetDatabase,
  seedEventCoverGraph,
  testEnv,
  withRecordingImages,
  writeHeaders,
} from './helpers';

type Access = Awaited<ReturnType<typeof eventAccess>>;
type Body = Record<string, any>;

const RAW_BYTES = 4_000;
const COMPETING_PRESET_ONE = '{"version":1,"source":{"kind":"preset","presetId":"warm-linen","assetVersion":1},"effect":"natural"}';
const COMPETING_PRESET_TWO = '{"version":1,"source":{"kind":"preset","presetId":"pressed-paper","assetVersion":1},"effect":"natural"}';

// `draftIntentId` and `operationId` are opaque UUIDs by schema, so a readable
// fixture string is rejected before any handler sees it. Fixed values keep the
// replay cases replaying; `resetDatabase()` between tests keeps them distinct.
const INTENT_A = '11111111-1111-4111-8111-111111111111';
const INTENT_B = '22222222-2222-4222-8222-222222222222';
const INTENT_C = '33333333-3333-4333-8333-333333333333';
const INTENT_D = '44444444-4444-4444-8444-444444444444';
const INTENT_E = '55555555-5555-4555-8555-555555555555';
const ABSENT_DRAFT_ID = '66666666-6666-4666-8666-666666666666';

function coverPath(eventId: string, suffix = '') {
  return `/api/manage/events/${eventId}/cover${suffix}`;
}

function jsonHeaders(access: Access) {
  return writeHeaders(access.manager);
}

async function reserve(access: Access, patch: Body = {}, env: AppEnv = testEnv) {
  return createApp().request(coverPath(access.event.id, '/drafts'), {
    method: 'POST',
    headers: jsonHeaders(access),
    body: JSON.stringify({
      draftIntentId: INTENT_A,
      source: { kind: 'new-upload' },
      filename: 'porch.jpg',
      mimeType: 'image/jpeg',
      byteSize: RAW_BYTES,
      ...patch,
    }),
  }, env);
}

/** The raw ingress is not JSON: the revision travels as `If-Match`. */
async function putRaw(
  access: Access,
  draftId: string,
  options: {
    revision?: number;
    body?: BodyInit;
    contentType?: string;
    contentLength?: string | null;
    env?: AppEnv;
  } = {},
) {
  const headers: Record<string, string> = {
    origin,
    cookie: access.manager.cookie,
    'x-candidary-csrf': access.manager.csrf,
    'content-type': options.contentType ?? 'image/jpeg',
  };
  if (options.revision !== undefined) headers['if-match'] = `"${options.revision}"`;
  if (options.contentLength !== null) {
    headers['content-length'] = options.contentLength ?? String(RAW_BYTES);
  }
  return createApp().request(coverPath(access.event.id, `/drafts/${draftId}/raw`), {
    method: 'PUT',
    headers,
    body: options.body ?? new Uint8Array(RAW_BYTES).fill(9),
  }, options.env ?? testEnv);
}

async function inspect(access: Access, draftId: string, env: AppEnv = testEnv) {
  return createApp().request(coverPath(access.event.id, `/drafts/${draftId}/inspect`), {
    method: 'POST',
    headers: jsonHeaders(access),
  }, env);
}

async function compose(access: Access, draftId: string, patch: Body = {}, env: AppEnv = testEnv) {
  return createApp().request(coverPath(access.event.id, `/drafts/${draftId}/composition`), {
    method: 'PATCH',
    headers: jsonHeaders(access),
    body: JSON.stringify({
      expectedDraftRevision: 3,
      modelVersion: COVER_PIPELINE_VERSIONS.compositionModel,
      x: 0.5,
      y: 0.4,
      ...patch,
    }),
  }, env);
}

async function publish(access: Access, body: Body, env: AppEnv = testEnv) {
  return createApp().request(coverPath(access.event.id, '/publications'), {
    method: 'POST',
    headers: jsonHeaders(access),
    body: JSON.stringify(body),
  }, env);
}

/** Reserve, transfer, inspect, and compose, leaving a `ready` draft. */
async function readyDraft(access: Access) {
  const recording = withRecordingImages({ source: { width: 2400, height: 1600 } });
  const reserved = await reserve(access, {}, recording.env);
  const draft = (await reserved.json<any>()).data.draft;
  await putRaw(access, draft.id, { revision: draft.revision, env: recording.env });
  const inspected = await inspect(access, draft.id, recording.env);
  const inspectedDraft = (await inspected.json<any>()).data.draft;
  const composed = await compose(
    access,
    draft.id,
    { expectedDraftRevision: inspectedDraft.revision },
    recording.env,
  );
  return { draft: (await composed.json<any>()).data.draft, env: recording.env };
}

function withCoverRenderWorkflow(
  base: AppEnv,
  options: {
    status?: string;
    lookupRejects?: boolean;
    rejectDuplicate?: boolean;
    onCreate?(id: string): Promise<void>;
    onStatus?(): Promise<void>;
  } = {},
) {
  const calls: string[] = [];
  const createdIds = new Set<string>();
  const instance = {
    id: '',
    async pause() { calls.push('pause'); },
    async resume() { calls.push('resume'); },
    async terminate() { calls.push('terminate'); },
    async restart() { calls.push('restart'); },
    async status() {
      await options.onStatus?.();
      return { status: options.status ?? 'running' };
    },
    async sendEvent() { calls.push('sendEvent'); },
  };
  const workflow = {
    async get(id: string) {
      calls.push(`get:${id}`);
      if (options.lookupRejects) throw new Error('lookup unavailable');
      return { ...instance, id };
    },
    async create(input?: { id?: string }) {
      const id = input?.id ?? '';
      calls.push(`create:${id}`);
      if (options.rejectDuplicate && createdIds.has(id)) throw new Error('duplicate instance');
      await options.onCreate?.(id);
      createdIds.add(id);
      return { ...instance, id };
    },
    async createBatch(batch: Array<{ id?: string }>) {
      const created = [];
      for (const { id = '' } of batch) {
        calls.push(`create:${id}`);
        // Cloudflare's batch primitive skips retained IDs instead of colliding.
        if (createdIds.has(id)) continue;
        await options.onCreate?.(id);
        createdIds.add(id);
        created.push({ ...instance, id });
      }
      return created;
    },
  } as unknown as AppEnv['COVER_RENDER_WORKFLOW'];
  return { env: { ...base, COVER_RENDER_WORKFLOW: workflow }, calls };
}

describe('cover draft reservation', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('reserves a new upload and returns its authenticated ingress route', async () => {
    const access = await eventAccess();
    const response = await reserve(access);
    expect(response.status).toBe(201);
    const data = (await response.json<any>()).data;
    expect(data.draft.state).toBe('reserved');
    expect(data.draft.revision).toBe(0);
    expect(data.ingress.method).toBe('PUT');
    expect(data.ingress.path).toBe(coverPath(access.event.id, `/drafts/${data.draft.id}/raw`));
    // No storage identifier ever reaches a manager response. The ingress path
    // is an API route, so the assertion is scoped to the projection itself.
    expect(JSON.stringify(data.draft)).not.toContain('events/');
  });

  it('replays the same intent without consuming a second draft slot', async () => {
    const access = await eventAccess();
    const first = (await (await reserve(access)).json<any>()).data;
    const second = await reserve(access);
    expect(second.status).toBe(201);
    const replayed = (await second.json<any>()).data;
    expect(replayed.draft.id).toBe(first.draft.id);
    expect(replayed.replayed).toBe(true);
    const live = await testEnv.DB
      .prepare('SELECT count(*) AS count FROM event_cover_drafts WHERE event_id = ?')
      .bind(access.event.id).first<{ count: number }>();
    expect(live?.count).toBe(1);
  });

  it('rejects the same intent carrying different details', async () => {
    const access = await eventAccess();
    await reserve(access);
    const changed = await reserve(access, { filename: 'other.jpg' });
    expect(changed.status).toBe(409);
    expect((await changed.json<any>()).code).toBe('COVER_DRAFT_STATE_CONFLICT');
  });

  it('replays an existing-upload reservation after the active cover revision advances', async () => {
    const access = await eventAccess();
    const graph = await seedEventCoverGraph(testEnv.DB, access.event.id);
    const uploadConfig = JSON.stringify({
      version: 1,
      source: { kind: 'upload' },
      focus: { mode: 'auto' },
      effect: 'natural',
    });
    const master = await testEnv.DB.prepare(
      'SELECT object_key FROM event_cover_masters WHERE id = ?',
    ).bind(graph.masterId).first<{ object_key: string }>();
    await testEnv.DB.prepare(`
      UPDATE events
      SET cover_config = ?, cover_object_key = ?, cover_render_set_id = ?, cover_revision = 1
      WHERE id = ?
    `).bind(uploadConfig, master!.object_key, graph.renderSetId, access.event.id).run();
    const request = {
      draftIntentId: INTENT_B,
      source: { kind: 'existing-upload' },
      expectedCoverRevision: 1,
      filename: undefined,
      mimeType: undefined,
      byteSize: undefined,
    };

    const first = await reserve(access, request);
    expect(first.status).toBe(201);
    const firstDraft = (await first.json<any>()).data.draft;
    await testEnv.DB.prepare(`
      UPDATE events
      SET cover_config = ?, cover_object_key = NULL, cover_render_set_id = NULL, cover_revision = 2
      WHERE id = ?
    `).bind(COMPETING_PRESET_ONE, access.event.id).run();

    const replay = await reserve(access, request);
    expect(replay.status).toBe(201);
    const replayed = (await replay.json<any>()).data;
    expect(replayed.replayed).toBe(true);
    expect(replayed.draft.id).toBe(firstDraft.id);
  });

  it.each([
    ['image/heif'],
    ['image/heic-sequence'],
    ['image/heif-sequence'],
    ['image/gif'],
  ])('refuses %s at reservation', async (mimeType) => {
    const access = await eventAccess();
    const response = await reserve(access, { mimeType });
    expect(response.status).toBe(422);
  });

  it('refuses a declared size above the cover ceiling and accepts the ceiling itself', async () => {
    const access = await eventAccess();
    const over = await reserve(access, { byteSize: MAX_COVER_UPLOAD_BYTES + 1 });
    expect(over.status).toBe(422);
    const exact = await reserve(access, {
      draftIntentId: INTENT_B,
      byteSize: MAX_COVER_UPLOAD_BYTES,
    });
    expect(exact.status).toBe(201);
  });

  it('refuses an existing-upload draft when no uploaded cover is active', async () => {
    const access = await eventAccess();
    const response = await reserve(access, {
      draftIntentId: INTENT_C,
      source: { kind: 'existing-upload' },
      expectedCoverRevision: 0,
      filename: undefined,
      mimeType: undefined,
      byteSize: undefined,
    });
    expect(response.status).toBe(409);
  });

  it('accepts a host-account credential with its own CSRF header', async () => {
    const access = await eventAccess();
    const host = await hostAccess([access]);
    const response = await createApp().request(coverPath(access.event.id, '/drafts'), {
      method: 'POST',
      headers: hostWriteHeaders(host),
      body: JSON.stringify({
        draftIntentId: INTENT_D,
        source: { kind: 'new-upload' },
        filename: 'porch.jpg',
        mimeType: 'image/jpeg',
        byteSize: RAW_BYTES,
      }),
    }, testEnv);
    expect(response.status).toBe(201);
  });

  it('refuses a manager write carrying the wrong scope CSRF header', async () => {
    const access = await eventAccess();
    const response = await createApp().request(coverPath(access.event.id, '/drafts'), {
      method: 'POST',
      headers: {
        origin,
        cookie: access.manager.cookie,
        'content-type': 'application/json',
        'x-candidary-host-csrf': access.manager.csrf,
      },
      body: JSON.stringify({
        draftIntentId: INTENT_E,
        source: { kind: 'new-upload' },
        filename: 'porch.jpg',
        mimeType: 'image/jpeg',
        byteSize: RAW_BYTES,
      }),
    }, testEnv);
    expect(response.status).toBe(403);
  });
});

describe('cover raw ingress', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('stores exactly the reserved bytes and moves the draft to transferred', async () => {
    const access = await eventAccess();
    const draft = (await (await reserve(access)).json<any>()).data.draft;
    const response = await putRaw(access, draft.id, { revision: draft.revision });
    expect(response.status).toBe(200);
    const updated = (await response.json<any>()).data.draft;
    expect(updated.state).toBe('transferred');
    expect(updated.revision).toBeGreaterThan(draft.revision);
    const stored = await testEnv.MEDIA_BUCKET.head(
      `events/${access.event.id}/cover/raw/${draft.id}`,
    );
    expect(stored?.size).toBe(RAW_BYTES);
  });

  it('refuses a missing content-length before anything is stored', async () => {
    const access = await eventAccess();
    const draft = (await (await reserve(access)).json<any>()).data.draft;
    const response = await putRaw(access, draft.id, {
      revision: draft.revision,
      contentLength: null,
    });
    expect(response.status).toBe(411);
    expect(await testEnv.MEDIA_BUCKET.head(
      `events/${access.event.id}/cover/raw/${draft.id}`,
    )).toBeNull();
  });

  it('refuses a content-length that disagrees with the reservation', async () => {
    const access = await eventAccess();
    const draft = (await (await reserve(access)).json<any>()).data.draft;
    const response = await putRaw(access, draft.id, {
      revision: draft.revision,
      contentLength: String(RAW_BYTES + 1),
    });
    expect(response.status).toBe(422);
  });

  it('aborts a stream that exceeds its declared length and leaves no object', async () => {
    const access = await eventAccess();
    const draft = (await (await reserve(access)).json<any>()).data.draft;
    const response = await putRaw(access, draft.id, {
      revision: draft.revision,
      body: new Uint8Array(RAW_BYTES + 512).fill(3),
    });
    expect(response.status).toBe(413);
    expect(await testEnv.MEDIA_BUCKET.head(
      `events/${access.event.id}/cover/raw/${draft.id}`,
    )).toBeNull();
    // Confirmed absent, so the same draft may be retried rather than forcing a
    // fresh reservation. §14: "Verify/delete the partial key, then offer
    // same-draft retry or a fresh reservation."
    const row = await testEnv.DB
      .prepare('SELECT state, raw_object_key FROM event_cover_drafts WHERE id = ?')
      .bind(draft.id).first<{ state: string; raw_object_key: string | null }>();
    expect(row?.state).toBe('reserved');
    expect(row?.raw_object_key).toBeNull();

    const retried = await putRaw(access, draft.id, { revision: row ? draft.revision + 1 : 0 });
    expect(retried.status).toBe(200);
  });

  it('refuses a content-type the reservation did not declare', async () => {
    const access = await eventAccess();
    const draft = (await (await reserve(access)).json<any>()).data.draft;
    const response = await putRaw(access, draft.id, {
      revision: draft.revision,
      contentType: 'image/png',
    });
    expect(response.status).toBe(415);
  });

  it('refuses a stale draft revision', async () => {
    const access = await eventAccess();
    const draft = (await (await reserve(access)).json<any>()).data.draft;
    const response = await putRaw(access, draft.id, { revision: draft.revision + 7 });
    expect(response.status).toBe(409);
  });

  it('refuses a draft that belongs to another event', async () => {
    const first = await eventAccess();
    const second = await eventAccess('Other Event');
    const draft = (await (await reserve(first)).json<any>()).data.draft;
    const response = await createApp().request(
      coverPath(second.event.id, `/drafts/${draft.id}/raw`),
      {
        method: 'PUT',
        headers: {
          origin,
          cookie: second.manager.cookie,
          'x-candidary-csrf': second.manager.csrf,
          'content-type': 'image/jpeg',
          'content-length': String(RAW_BYTES),
          'if-match': '"0"',
        },
        body: new Uint8Array(RAW_BYTES).fill(9),
      },
      testEnv,
    );
    expect(response.status).toBe(404);
  });
});

describe('cover inspection and composition', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('normalizes a master, returns the natural preview, and deletes the raw', async () => {
    const access = await eventAccess();
    const recording = withRecordingImages({ source: { width: 2400, height: 1600 } });
    const draft = (await (await reserve(access, {}, recording.env)).json<any>()).data.draft;
    await putRaw(access, draft.id, { revision: draft.revision, env: recording.env });

    const response = await inspect(access, draft.id, recording.env);
    expect(response.status).toBe(200);
    const inspected = (await response.json<any>()).data.draft;
    expect(inspected.state).toBe('inspected');
    expect(inspected.master.width).toBeGreaterThanOrEqual(620);
    expect(inspected.master.safeZoomMaximum).toBeLessThanOrEqual(2);
    expect(inspected.preview.effect).toBe('natural');
    expect(inspected.compositionModelVersion).toBe(COVER_PIPELINE_VERSIONS.compositionModel);
    expect(JSON.stringify(inspected)).not.toContain('events/');

    expect(await testEnv.MEDIA_BUCKET.head(
      `events/${access.event.id}/cover/raw/${draft.id}`,
    )).toBeNull();
    const master = await testEnv.DB
      .prepare('SELECT object_key FROM event_cover_masters WHERE event_id = ?')
      .bind(access.event.id).first<{ object_key: string }>();
    expect(await testEnv.MEDIA_BUCKET.head(master!.object_key)).not.toBeNull();
  });

  it('refuses a source below the 1x minimum and keeps the active cover', async () => {
    const access = await eventAccess();
    const recording = withRecordingImages({ source: { width: 480, height: 320 } });
    const draft = (await (await reserve(access, {}, recording.env)).json<any>()).data.draft;
    await putRaw(access, draft.id, { revision: draft.revision, env: recording.env });
    const response = await inspect(access, draft.id, recording.env);
    expect(response.status).toBe(422);
    expect((await response.json<any>()).code).toBe('COVER_SOURCE_TOO_SMALL');
  });

  it('refuses to inspect a draft whose bytes never arrived', async () => {
    const access = await eventAccess();
    const draft = (await (await reserve(access)).json<any>()).data.draft;
    const response = await inspect(access, draft.id);
    expect(response.status).toBe(409);
  });

  it('writes the composition once, replays it, and refuses a stale revision', async () => {
    const access = await eventAccess();
    const recording = withRecordingImages({ source: { width: 2400, height: 1600 } });
    const draft = (await (await reserve(access, {}, recording.env)).json<any>()).data.draft;
    await putRaw(access, draft.id, { revision: draft.revision, env: recording.env });
    const inspected = (await (await inspect(access, draft.id, recording.env)).json<any>()).data.draft;

    const first = await compose(access, draft.id, { expectedDraftRevision: inspected.revision });
    expect(first.status).toBe(200);
    const ready = (await first.json<any>()).data.draft;
    expect(ready.state).toBe('ready');
    expect(ready.focus).toEqual({
      x: 0.5,
      y: 0.4,
      modelVersion: COVER_PIPELINE_VERSIONS.compositionModel,
    });

    const replay = await compose(access, draft.id, { expectedDraftRevision: inspected.revision });
    expect(replay.status).toBe(200);
    expect((await replay.json<any>()).data.draft.revision).toBe(ready.revision);

    const moved = await compose(access, draft.id, {
      expectedDraftRevision: inspected.revision,
      x: 0.9,
    });
    expect(moved.status).toBe(409);
  });

  it('refuses a composition carrying the wrong model version or out-of-range point', async () => {
    const access = await eventAccess();
    const recording = withRecordingImages({ source: { width: 2400, height: 1600 } });
    const draft = (await (await reserve(access, {}, recording.env)).json<any>()).data.draft;
    await putRaw(access, draft.id, { revision: draft.revision, env: recording.env });
    const inspected = (await (await inspect(access, draft.id, recording.env)).json<any>()).data.draft;

    // `modelVersion` is a pinned `z.literal`, so a client running an older
    // composition worker is refused by strict parsing rather than reaching the
    // guarded write with coordinates a newer model would reinterpret.
    const wrongModel = await compose(access, draft.id, {
      expectedDraftRevision: inspected.revision,
      modelVersion: COVER_PIPELINE_VERSIONS.compositionModel + 1,
    });
    expect(wrongModel.status).toBe(422);

    const outOfRange = await compose(access, draft.id, {
      expectedDraftRevision: inspected.revision,
      x: 1.5,
    });
    expect(outOfRange.status).toBe(422);
  });

  it('returns at most one preview per draft and effect', async () => {
    const access = await eventAccess();
    const { draft, env } = await readyDraft(access);
    const first = await createApp().request(
      coverPath(access.event.id, `/drafts/${draft.id}/previews/film`),
      { method: 'POST', headers: jsonHeaders(access) },
      env,
    );
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toBe('image/webp');
    expect(first.headers.get('cache-control')).toBe('private, no-store');

    const replay = await createApp().request(
      coverPath(access.event.id, `/drafts/${draft.id}/previews/film`),
      { method: 'POST', headers: jsonHeaders(access) },
      env,
    );
    expect(replay.status).toBe(200);
    const previews = await testEnv.DB
      .prepare('SELECT count(*) AS count FROM event_cover_draft_previews WHERE draft_id = ?')
      .bind(draft.id).first<{ count: number }>();
    expect(previews?.count).toBe(2); // natural from inspection, plus film
  });

  it('refuses an effect outside the allowlist', async () => {
    const access = await eventAccess();
    const { draft, env } = await readyDraft(access);
    const response = await createApp().request(
      coverPath(access.event.id, `/drafts/${draft.id}/previews/sepia`),
      { method: 'POST', headers: jsonHeaders(access) },
      env,
    );
    expect(response.status).toBe(422);
  });
});

describe('cover draft discard', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  async function discard(access: Access, draftId: string, ifMatch?: string | null) {
    const headers: Record<string, string> = {
      origin,
      cookie: access.manager.cookie,
      'x-candidary-csrf': access.manager.csrf,
    };
    if (ifMatch !== null && ifMatch !== undefined) headers['if-match'] = ifMatch;
    return createApp().request(coverPath(access.event.id, `/drafts/${draftId}`), {
      method: 'DELETE',
      headers,
    }, testEnv);
  }

  it('requires If-Match, refuses a malformed or stale one, and then discards', async () => {
    const access = await eventAccess();
    const draft = (await (await reserve(access)).json<any>()).data.draft;

    expect((await discard(access, draft.id, null)).status).toBe(428);
    expect((await discard(access, draft.id, 'not-a-revision')).status).toBe(409);
    expect((await discard(access, draft.id, '"99"')).status).toBe(409);

    const removed = await discard(access, draft.id, `"${draft.revision}"`);
    expect(removed.status).toBe(200);
    const row = await testEnv.DB
      .prepare('SELECT state FROM event_cover_drafts WHERE id = ?')
      .bind(draft.id).first<{ state: string }>();
    expect(row?.state).toBe('expired');
  });

  it('is idempotent for an already-discarded draft', async () => {
    const access = await eventAccess();
    const draft = (await (await reserve(access)).json<any>()).data.draft;
    await discard(access, draft.id, `"${draft.revision}"`);
    const again = await discard(access, draft.id, `"${draft.revision}"`);
    expect(again.status).toBe(200);
  });
});

describe('cover publication', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('applies a removal synchronously and increments the revision once', async () => {
    const access = await eventAccess();
    const response = await publish(access, {
      operationId: crypto.randomUUID(),
      expectedRevision: 0,
      source: { kind: 'none' },
    });
    expect(response.status).toBe(200);
    const data = (await response.json<any>()).data;
    expect(data.applied).toBe(true);
    expect(data.appliedRevision).toBe(1);
    expect(data.event.cover.revision).toBe(1);
    expect(data.event.cover.hasCover).toBe(false);
  });

  it('replays an applied removal without publishing twice', async () => {
    const access = await eventAccess();
    const operationId = crypto.randomUUID();
    const body = { operationId, expectedRevision: 0, source: { kind: 'none' } };
    await publish(access, body);
    const replay = await publish(access, body);
    expect(replay.status).toBe(200);
    expect((await replay.json<any>()).data.appliedRevision).toBe(1);
    const event = await testEnv.DB
      .prepare('SELECT cover_revision FROM events WHERE id = ?')
      .bind(access.event.id).first<{ cover_revision: number }>();
    expect(event?.cover_revision).toBe(1);
  });

  it('returns 409 when a pending removal becomes conflict before application', async () => {
    const access = await eventAccess();
    const operationId = crypto.randomUUID();
    const request = {
      operationId,
      expectedRevision: 0,
      source: { kind: 'none' as const },
    };
    const requestDigest = await coverRequestDigest(canonicalCoverRequest(request));
    const timestamp = new Date().toISOString();
    await testEnv.DB.prepare(`
      INSERT INTO event_cover_publish_receipts (
        event_id, operation_id, request_sha256, action, expected_revision, status,
        dependency_versions_json, completed_profiles, required_profiles, retryable,
        dispatch_state, dispatch_generation, created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, 'remove', 0, 'queued', '{}', 0, 0, 0,
        'pending', 0, ?, ?, ?)
    `).bind(
      access.event.id,
      operationId,
      requestDigest,
      timestamp,
      timestamp,
      new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    ).run();

    let receiptReads = 0;
    const wrapStatement = (
      statement: D1PreparedStatement,
      isReceiptRead: boolean,
    ): D1PreparedStatement => new Proxy(statement, {
      get(target, property) {
        if (property === 'bind') {
          return (...values: unknown[]) => wrapStatement(target.bind(...values), isReceiptRead);
        }
        if (property === 'first') {
          return async <T>(columnName?: string) => {
            if (isReceiptRead) {
              receiptReads += 1;
              if (receiptReads === 2) {
                await testEnv.DB.prepare(`
                  UPDATE event_cover_publish_receipts
                  SET status = 'conflict', retryable = 0
                  WHERE event_id = ? AND operation_id = ?
                `).bind(access.event.id, operationId).run();
              }
            }
            return columnName === undefined
              ? target.first<T>()
              : target.first<T>(columnName);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const db = new Proxy(testEnv.DB, {
      get(target, property) {
        if (property === 'prepare') {
          return (sql: string) => wrapStatement(
            target.prepare(sql),
            sql.includes('SELECT * FROM event_cover_publish_receipts')
              && sql.includes('event_id = ? AND operation_id = ?'),
          );
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const response = await publish(access, request, { ...testEnv, DB: db });

    expect(response.status).toBe(409);
    expect(await response.json<any>()).toMatchObject({
      data: { applied: false, operation: { status: 'conflict' } },
    });
  });

  it('refuses reuse of an operation ID with different bytes', async () => {
    const access = await eventAccess();
    const operationId = crypto.randomUUID();
    await publish(access, { operationId, expectedRevision: 0, source: { kind: 'none' } });
    const collision = await publish(access, {
      operationId,
      expectedRevision: 1,
      source: { kind: 'none' },
    });
    expect(collision.status).toBe(409);
    expect(await collision.json<any>()).toMatchObject({
      code: 'COVER_PUBLICATION_CONFLICT',
      data: {
        operation: { operationId, status: 'applied' },
        event: { cover: { revision: 1 } },
      },
    });
  });

  it('refuses a stale expected revision with a recovery view', async () => {
    const access = await eventAccess();
    await publish(access, {
      operationId: crypto.randomUUID(),
      expectedRevision: 0,
      source: { kind: 'none' },
    });
    const stale = await publish(access, {
      operationId: crypto.randomUUID(),
      expectedRevision: 0,
      source: { kind: 'none' },
    });
    expect(stale.status).toBe(409);
  });

  it('accepts an upload publication with 202, Location, and Retry-After', async () => {
    const access = await eventAccess();
    const { draft, env } = await readyDraft(access);
    const operationId = crypto.randomUUID();
    const response = await publish(access, {
      operationId,
      expectedRevision: 0,
      source: { kind: 'upload', draftId: draft.id },
      focus: { mode: 'auto' },
      effect: 'natural',
    }, env);
    expect(response.status).toBe(202);
    expect(response.headers.get('location'))
      .toBe(coverPath(access.event.id, `/publications/${operationId}`));
    expect(response.headers.get('retry-after')).toBe('2');
    const operation = (await response.json<any>()).data.operation;
    expect(operation.operationId).toBe(operationId);
    expect(operation.status).toBe('preparing');
    expect(operation.requiredSteps).toBe(6);
    // The draft is frozen and no longer discardable.
    const row = await testEnv.DB
      .prepare('SELECT state FROM event_cover_drafts WHERE id = ?')
      .bind(draft.id).first<{ state: string }>();
    expect(row?.state).toBe('publishing');
  });

  it('keeps a rejected create with an unknown lookup preparing and recoverable', async () => {
    const access = await eventAccess();
    const { draft, env } = await readyDraft(access);
    const workflow = withCoverRenderWorkflow(env, {
      lookupRejects: true,
      async onCreate() { throw new Error('create unavailable'); },
    });
    const operationId = crypto.randomUUID();

    const reported = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let response: Response;
    try {
      response = await publish(access, {
        operationId,
        expectedRevision: 0,
        source: { kind: 'upload', draftId: draft.id },
        focus: { mode: 'auto' },
        effect: 'natural',
      }, workflow.env);

      // The rejected create is observed once by dispatch and once by the
      // side-effect-free response read. Each observation is independently
      // bounded and contains no operation/event identity.
      expect(reported).toHaveBeenCalledTimes(2);
      for (const call of reported.mock.calls) {
        const observation = JSON.parse(String(call[0])) as Record<string, unknown>;
        expect(observation).toEqual({
          event: 'cover_platform_observation',
          source: 'publication',
          code: 'cover_platform_lookup_failed',
        });
        expect(JSON.stringify(observation)).not.toContain(operationId);
        expect(JSON.stringify(observation)).not.toContain(access.event.id);
      }
    } finally {
      reported.mockRestore();
    }

    expect(response.status).toBe(503);
    expect((await response.json<any>()).data.operation).toMatchObject({
      operationId,
      status: 'preparing',
      retryable: false,
    });
    expect(await testEnv.DB.prepare(`
      SELECT status, dispatch_state, dispatch_generation, failure_code, retryable
      FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(operationId).first()).toEqual({
      status: 'queued', dispatch_state: 'creating', dispatch_generation: 1,
      failure_code: null, retryable: 0,
    });
    expect(await testEnv.DB.prepare(`
      SELECT state, dispatch_generation FROM event_cover_workflow_fences
      WHERE workflow_instance_id = (
        SELECT workflow_instance_id FROM event_cover_publish_receipts WHERE operation_id = ?
      )
    `).bind(operationId).first()).toEqual({ state: 'open', dispatch_generation: 1 });
    expect(workflow.calls.filter((call) => /^(?:create|resume|restart|terminate):?/u.test(call)))
      .toHaveLength(1);
  });

  it('keeps a rejected create with an unmapped status unconfirmed and sanitized', async () => {
    const access = await eventAccess();
    const { draft, env } = await readyDraft(access);
    const workflow = withCoverRenderWorkflow(env, {
      status: 'events/private/cover/cr1-secret',
      async onCreate() { throw new Error('create unavailable'); },
    });
    const operationId = crypto.randomUUID();
    const reported = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const response = await publish(access, {
        operationId,
        expectedRevision: 0,
        source: { kind: 'upload', draftId: draft.id },
        focus: { mode: 'auto' },
        effect: 'natural',
      }, workflow.env);

      expect(response.status).toBe(503);
      expect((await response.json<any>()).data.operation.status).toBe('preparing');
      expect(await testEnv.DB.prepare(`
        SELECT status, dispatch_state, dispatch_generation, failure_code
        FROM event_cover_publish_receipts WHERE operation_id = ?
      `).bind(operationId).first()).toEqual({
        status: 'queued', dispatch_state: 'creating', dispatch_generation: 1,
        failure_code: null,
      });
      expect(workflow.calls.filter((call) => call.startsWith('create:'))).toHaveLength(1);
      expect(reported).toHaveBeenCalledTimes(2);
      for (const call of reported.mock.calls) {
        expect(JSON.parse(String(call[0]))).toEqual({
          event: 'cover_platform_observation',
          source: 'publication',
          code: 'cover_platform_unmapped',
        });
        expect(String(call[0])).not.toContain('private');
      }
    } finally {
      reported.mockRestore();
    }
  });

  it('does not issue another create for a young initial-dispatch claim', async () => {
    const access = await eventAccess();
    const { draft, env } = await readyDraft(access);
    const workflow = withCoverRenderWorkflow(env, {
      lookupRejects: true,
      async onCreate() { throw new Error('create unavailable'); },
    });
    const operationId = crypto.randomUUID();
    const body = {
      operationId,
      expectedRevision: 0,
      source: { kind: 'upload', draftId: draft.id },
      focus: { mode: 'auto' },
      effect: 'natural',
    };

    await publish(access, body, workflow.env);
    const replay = await publish(access, body, workflow.env);

    expect(replay.status).toBe(503);
    expect((await replay.json<any>()).data.operation.status).toBe('preparing');
    expect(workflow.calls.filter((call) => call.startsWith('create:'))).toHaveLength(1);
  });

  it('recovers a stale initial-dispatch claim with the retained instance ID', async () => {
    const access = await eventAccess();
    const { draft, env } = await readyDraft(access);
    const unavailable = withCoverRenderWorkflow(env, {
      lookupRejects: true,
      async onCreate() { throw new Error('create unavailable'); },
    });
    const operationId = crypto.randomUUID();
    const body = {
      operationId,
      expectedRevision: 0,
      source: { kind: 'upload', draftId: draft.id },
      focus: { mode: 'auto' },
      effect: 'natural',
    };
    expect((await publish(access, body, unavailable.env)).status).toBe(503);
    await testEnv.DB.prepare(`
      UPDATE event_cover_publish_receipts
      SET last_dispatch_at = '2000-01-01T00:00:00.000Z'
      WHERE operation_id = ?
    `).bind(operationId).run();
    const recoverable = withCoverRenderWorkflow(env, { status: 'errored' });

    const replay = await publish(access, body, recoverable.env);

    expect(replay.status).toBe(202);
    expect(recoverable.calls.filter((call) => call === 'restart')).toHaveLength(1);
    expect(recoverable.calls.some((call) => call.startsWith('create:'))).toBe(false);
    expect(await testEnv.DB.prepare(`
      SELECT status, dispatch_state, dispatch_generation
      FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(operationId).first()).toEqual({
      status: 'queued', dispatch_state: 'confirmed', dispatch_generation: 2,
    });
  });

  it('materializes a stale initial claim idempotently when its retained lookup fails', async () => {
    const access = await eventAccess();
    const { draft, env } = await readyDraft(access);
    const unavailable = withCoverRenderWorkflow(env, {
      lookupRejects: true,
      async onCreate() { throw new Error('create unavailable'); },
    });
    const operationId = crypto.randomUUID();
    const body = {
      operationId,
      expectedRevision: 0,
      source: { kind: 'upload', draftId: draft.id },
      focus: { mode: 'auto' },
      effect: 'natural',
    };
    expect((await publish(access, body, unavailable.env)).status).toBe(503);
    await testEnv.DB.prepare(`
      UPDATE event_cover_publish_receipts
      SET last_dispatch_at = '2000-01-01T00:00:00.000Z'
      WHERE operation_id = ?
    `).bind(operationId).run();
    const stillUnknown = withCoverRenderWorkflow(env, { lookupRejects: true });

    const replay = await publish(access, body, stillUnknown.env);

    expect(replay.status).toBe(202);
    expect(replay.headers.get('retry-after')).toBe('2');
    expect(stillUnknown.calls.filter((call) => call.startsWith('create:'))).toHaveLength(1);
    expect(stillUnknown.calls.filter((call) => call === 'restart')).toHaveLength(0);
    expect(await testEnv.DB.prepare(`
      SELECT status, dispatch_state, dispatch_generation
      FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(operationId).first()).toEqual({
      status: 'queued', dispatch_state: 'confirmed', dispatch_generation: 2,
    });
  });

  it('returns accepted progress for a young initial claim whose retained instance is active', async () => {
    const access = await eventAccess();
    const { draft, env } = await readyDraft(access);
    const unavailable = withCoverRenderWorkflow(env, {
      lookupRejects: true,
      async onCreate() { throw new Error('create unavailable'); },
    });
    const operationId = crypto.randomUUID();
    const body = {
      operationId,
      expectedRevision: 0,
      source: { kind: 'upload', draftId: draft.id },
      focus: { mode: 'auto' },
      effect: 'natural',
    };
    expect((await publish(access, body, unavailable.env)).status).toBe(503);
    const active = withCoverRenderWorkflow(env, { status: 'running' });

    const replay = await publish(access, body, active.env);

    expect(replay.status).toBe(202);
    expect(replay.headers.get('location')).toBe(
      coverPath(access.event.id, `/publications/${operationId}`),
    );
    expect((await replay.json<any>()).data.operation).toMatchObject({
      status: 'preparing', retryable: false,
    });
    expect(active.calls.some((call) => call.startsWith('create:'))).toBe(false);
  });

  it('does not issue another create for a failed publication replay', async () => {
    const access = await eventAccess();
    const { draft, env } = await readyDraft(access);
    const workflow = withCoverRenderWorkflow(env, { rejectDuplicate: true });
    const operationId = crypto.randomUUID();
    const body = {
      operationId,
      expectedRevision: 0,
      source: { kind: 'upload', draftId: draft.id },
      focus: { mode: 'auto' },
      effect: 'natural',
    };
    expect((await publish(access, body, workflow.env)).status).toBe(202);
    await testEnv.DB.prepare(`
      UPDATE event_cover_publish_receipts
      SET status = 'failed', retryable = 1, failure_code = 'COVER_RENDER_UNAVAILABLE',
          dispatch_state = 'failed'
      WHERE operation_id = ?
    `).bind(operationId).run();

    const replay = await publish(access, body, workflow.env);

    expect(replay.status).toBe(202);
    expect(replay.headers.get('location')).toBe(
      coverPath(access.event.id, `/publications/${operationId}`),
    );
    expect((await replay.json<any>()).data.operation).toMatchObject({
      status: 'preparing', retryable: false, safeFailureCode: null,
    });
    expect(workflow.calls.filter((call) => call.startsWith('create:'))).toHaveLength(1);
    expect(await testEnv.DB.prepare(`
      SELECT status, dispatch_state, dispatch_generation, failure_code
      FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(operationId).first()).toEqual({
      status: 'failed', dispatch_state: 'failed', dispatch_generation: 1,
      failure_code: 'COVER_RENDER_UNAVAILABLE',
    });
  });

  it('uses guarded recovery for a same-digest retryable failed replay', async () => {
    const access = await eventAccess();
    const { draft, env } = await readyDraft(access);
    const workflow = withCoverRenderWorkflow(env, { status: 'errored' });
    const operationId = crypto.randomUUID();
    const body = {
      operationId,
      expectedRevision: 0,
      source: { kind: 'upload', draftId: draft.id },
      focus: { mode: 'auto' },
      effect: 'natural',
    };
    expect((await publish(access, body, workflow.env)).status).toBe(202);
    await testEnv.DB.prepare(`
      UPDATE event_cover_publish_receipts
      SET status = 'failed', retryable = 1, failure_code = 'COVER_RENDER_UNAVAILABLE',
          dispatch_state = 'failed'
      WHERE operation_id = ?
    `).bind(operationId).run();

    const replay = await publish(access, body, workflow.env);

    expect(replay.status).toBe(202);
    expect((await replay.json<any>()).data.operation.status).toBe('preparing');
    expect(workflow.calls.filter((call) => call.startsWith('create:'))).toHaveLength(1);
    expect(workflow.calls.filter((call) => call === 'restart')).toHaveLength(1);
    expect(await testEnv.DB.prepare(`
      SELECT status, dispatch_state, dispatch_generation, failure_code
      FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(operationId).first()).toEqual({
      status: 'queued', dispatch_state: 'confirmed', dispatch_generation: 2,
      failure_code: null,
    });
  });

  it('returns the retained failed result when same-digest recovery observes completion', async () => {
    const access = await eventAccess();
    const { draft, env } = await readyDraft(access);
    const workflow = withCoverRenderWorkflow(env, { status: 'complete' });
    const operationId = crypto.randomUUID();
    const body = {
      operationId,
      expectedRevision: 0,
      source: { kind: 'upload', draftId: draft.id },
      focus: { mode: 'auto' },
      effect: 'natural',
    };
    expect((await publish(access, body, workflow.env)).status).toBe(202);
    await testEnv.DB.prepare(`
      UPDATE event_cover_publish_receipts
      SET status = 'failed', retryable = 1, failure_code = 'COVER_RENDER_UNAVAILABLE',
          dispatch_state = 'failed'
      WHERE operation_id = ?
    `).bind(operationId).run();

    const replay = await publish(access, body, workflow.env);

    expect(replay.status).toBe(200);
    expect((await replay.json<any>()).data).toMatchObject({
      applied: false,
      operation: {
        status: 'retryable-failed',
        safeFailureCode: 'COVER_RENDER_UNAVAILABLE',
      },
    });
    expect(workflow.calls.filter((call) => call === 'restart')).toHaveLength(0);
    expect(workflow.calls.filter((call) => call.startsWith('create:'))).toHaveLength(1);
  });

  it('returns a permanent conflict for an expired same-digest recovery', async () => {
    const access = await eventAccess();
    const { draft, env } = await readyDraft(access);
    const workflow = withCoverRenderWorkflow(env, { status: 'errored' });
    const operationId = crypto.randomUUID();
    const body = {
      operationId,
      expectedRevision: 0,
      source: { kind: 'upload', draftId: draft.id },
      focus: { mode: 'auto' },
      effect: 'natural',
    };
    expect((await publish(access, body, workflow.env)).status).toBe(202);
    await testEnv.DB.prepare(`
      UPDATE event_cover_publish_receipts
      SET status = 'failed', retryable = 1, failure_code = 'COVER_RENDER_UNAVAILABLE',
          dispatch_state = 'failed', expires_at = '2000-01-01T00:00:00.000Z'
      WHERE operation_id = ?
    `).bind(operationId).run();

    const replay = await publish(access, body, workflow.env);

    expect(replay.status).toBe(409);
    expect(await replay.json<any>()).toMatchObject({ code: 'COVER_PUBLICATION_CONFLICT' });
    expect(workflow.calls.filter((call) => call === 'restart')).toHaveLength(0);
    expect(workflow.calls.filter((call) => call.startsWith('create:'))).toHaveLength(1);
  });

  it('does not issue another create for a confirmed replay', async () => {
    const access = await eventAccess();
    const { draft, env } = await readyDraft(access);
    const workflow = withCoverRenderWorkflow(env, { rejectDuplicate: true });
    const operationId = crypto.randomUUID();
    const body = {
      operationId,
      expectedRevision: 0,
      source: { kind: 'upload', draftId: draft.id },
      focus: { mode: 'auto' },
      effect: 'natural',
    };

    expect((await publish(access, body, workflow.env)).status).toBe(202);
    expect((await publish(access, body, workflow.env)).status).toBe(202);

    expect(workflow.calls.filter((call) => call.startsWith('create:'))).toHaveLength(1);
    expect(await testEnv.DB.prepare(`
      SELECT dispatch_state, dispatch_generation
      FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(operationId).first()).toEqual({ dispatch_state: 'confirmed', dispatch_generation: 1 });
  });

  it.each([
    ['applied', 200, 'applied', true],
    ['conflict', 409, 'conflict', false],
    ['failed', 200, 'permanent-failed', false],
  ] as const)(
    'returns the exact %s envelope when it wins during the post-dispatch status lookup',
    async (storedStatus, expectedHttp, expectedProductStatus, expectedApplied) => {
      const access = await eventAccess();
      const { draft, env } = await readyDraft(access);
      const operationId = crypto.randomUUID();
      let settled = false;
      const workflow = withCoverRenderWorkflow(env, {
        async onStatus() {
          if (settled) return;
          settled = true;
          await testEnv.DB.batch([
            testEnv.DB.prepare(`
              UPDATE events SET cover_config = ?, cover_revision = 1 WHERE id = ?
            `).bind(COMPETING_PRESET_ONE, access.event.id),
            testEnv.DB.prepare(`
              UPDATE event_cover_publish_receipts
              SET status = ?, retryable = 0,
                  failure_code = CASE WHEN ? = 'failed' THEN 'EVENT_DELETED' ELSE NULL END,
                  applied_revision = CASE WHEN ? = 'applied' THEN 1 ELSE NULL END
              WHERE operation_id = ?
            `).bind(storedStatus, storedStatus, storedStatus, operationId),
          ]);
        },
      });

      const response = await publish(access, {
        operationId,
        expectedRevision: 0,
        source: { kind: 'upload', draftId: draft.id },
        focus: { mode: 'auto' },
        effect: 'natural',
      }, workflow.env);
      const body = await response.json<any>();

      expect(response.status).toBe(expectedHttp);
      expect(body.data).toMatchObject({
        applied: expectedApplied,
        operation: { operationId, status: expectedProductStatus },
      });
      if (storedStatus === 'applied') {
        expect(body.data).toMatchObject({
          appliedRevision: 1,
          event: { cover: { revision: 1 } },
        });
      } else if (storedStatus === 'conflict') {
        expect(body.data.event).toMatchObject({ cover: { revision: 1 } });
      }
    },
  );

  it('does not report a confirmed replay after deletion blocks its exact fence', async () => {
    const access = await eventAccess();
    const { draft, env } = await readyDraft(access);
    const workflow = withCoverRenderWorkflow(env, { rejectDuplicate: true });
    const operationId = crypto.randomUUID();
    const body = {
      operationId,
      expectedRevision: 0,
      source: { kind: 'upload', draftId: draft.id },
      focus: { mode: 'auto' },
      effect: 'natural',
    };

    expect((await publish(access, body, workflow.env)).status).toBe(202);
    await testEnv.DB.prepare(`
      UPDATE event_cover_workflow_fences SET state = 'deletion-blocked'
      WHERE workflow_instance_id = (
        SELECT workflow_instance_id FROM event_cover_publish_receipts WHERE operation_id = ?
      )
    `).bind(operationId).run();

    expect((await publish(access, body, workflow.env)).status).toBe(503);
    expect(workflow.calls.filter((call) => call.startsWith('create:'))).toHaveLength(1);
    expect(await testEnv.DB.prepare(`
      SELECT dispatch_state, dispatch_generation
      FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(operationId).first()).toEqual({ dispatch_state: 'confirmed', dispatch_generation: 1 });
  });

  it('confirms the exact claim when the Workflow advances D1 before create returns', async () => {
    const access = await eventAccess();
    const { draft, env } = await readyDraft(access);
    const operationId = crypto.randomUUID();
    const workflow = withCoverRenderWorkflow(env, {
      async onCreate() {
        await testEnv.DB.prepare(`
          UPDATE event_cover_publish_receipts SET status = 'rendering'
          WHERE operation_id = ?
        `).bind(operationId).run();
      },
    });

    const response = await publish(access, {
      operationId,
      expectedRevision: 0,
      source: { kind: 'upload', draftId: draft.id },
      focus: { mode: 'auto' },
      effect: 'natural',
    }, workflow.env);

    expect(response.status).toBe(202);
    expect(await testEnv.DB.prepare(`
      SELECT status, dispatch_state, dispatch_generation
      FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(operationId).first()).toEqual({
      status: 'rendering', dispatch_state: 'confirmed', dispatch_generation: 1,
    });
  });

  it('confirms an exact claim that the Workflow already applied before create returns', async () => {
    const access = await eventAccess();
    const { draft, env } = await readyDraft(access);
    const operationId = crypto.randomUUID();
    const terminalAt = '2026-08-09T12:34:56.000Z';
    const terminalExpiresAt = new Date(
      Date.parse(terminalAt) + COVER_WORKFLOW_FENCE_TERMINAL_TTL_MS,
    ).toISOString();
    const workflow = withCoverRenderWorkflow(env, {
      async onCreate() {
        await testEnv.DB.batch([
          testEnv.DB.prepare(`
            UPDATE events SET cover_config = ?, cover_revision = 1 WHERE id = ?
          `).bind(COMPETING_PRESET_ONE, access.event.id),
          testEnv.DB.prepare(`
            UPDATE event_cover_publish_receipts
            SET status = 'applied', applied_revision = 1, retryable = 0, updated_at = ?
            WHERE operation_id = ?
          `).bind(terminalAt, operationId),
          testEnv.DB.prepare(`
            UPDATE event_cover_workflow_fences
            SET updated_at = ?, expires_at = ?
            WHERE event_id = ? AND workflow_binding = 'COVER_RENDER_WORKFLOW'
          `).bind(terminalAt, terminalExpiresAt, access.event.id),
        ]);
      },
    });

    const response = await publish(access, {
      operationId,
      expectedRevision: 0,
      source: { kind: 'upload', draftId: draft.id },
      focus: { mode: 'auto' },
      effect: 'natural',
    }, workflow.env);

    expect(response.status).toBe(200);
    expect(await response.json<any>()).toMatchObject({
      data: { applied: true, appliedRevision: 1, operation: { status: 'applied' } },
    });
    expect(await testEnv.DB.prepare(`
      SELECT status, applied_revision, dispatch_state, dispatch_generation, updated_at
      FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(operationId).first()).toEqual({
      status: 'applied', applied_revision: 1,
      dispatch_state: 'confirmed', dispatch_generation: 1, updated_at: terminalAt,
    });
    expect(await testEnv.DB.prepare(`
      SELECT updated_at, expires_at FROM event_cover_workflow_fences WHERE event_id = ?
    `).bind(access.event.id).first()).toEqual({
      updated_at: terminalAt, expires_at: terminalExpiresAt,
    });
    expect(workflow.calls.filter((call) => call === 'terminate')).toHaveLength(0);
  });

  it('returns the exact applied receipt after a later publication advances the event again', async () => {
    const access = await eventAccess();
    const { draft, env } = await readyDraft(access);
    const operationId = crypto.randomUUID();
    const workflow = withCoverRenderWorkflow(env, {
      async onCreate() {
        await testEnv.DB.batch([
          testEnv.DB.prepare(`
            UPDATE events SET cover_config = ?, cover_revision = 1 WHERE id = ?
          `).bind(COMPETING_PRESET_ONE, access.event.id),
          testEnv.DB.prepare(`
            UPDATE events SET cover_config = ?, cover_revision = 2 WHERE id = ?
          `).bind(COMPETING_PRESET_TWO, access.event.id),
          testEnv.DB.prepare(`
            UPDATE event_cover_publish_receipts
            SET status = 'applied', applied_revision = 1, retryable = 0
            WHERE operation_id = ?
          `).bind(operationId),
        ]);
      },
    });

    const response = await publish(access, {
      operationId,
      expectedRevision: 0,
      source: { kind: 'upload', draftId: draft.id },
      focus: { mode: 'auto' },
      effect: 'natural',
    }, workflow.env);

    expect(response.status).toBe(200);
    expect(await response.json<any>()).toMatchObject({
      data: { applied: true, appliedRevision: 1, operation: { status: 'applied' } },
    });
    expect(await testEnv.DB.prepare(`
      SELECT dispatch_state, dispatch_generation FROM event_cover_publish_receipts
      WHERE operation_id = ?
    `).bind(operationId).first()).toEqual({ dispatch_state: 'confirmed', dispatch_generation: 1 });
    expect(workflow.calls.filter((call) => call === 'terminate')).toHaveLength(0);
  });

  it('returns the exact conflict when the Workflow records revision movement before create returns', async () => {
    const access = await eventAccess();
    const { draft, env } = await readyDraft(access);
    const operationId = crypto.randomUUID();
    const workflow = withCoverRenderWorkflow(env, {
      async onCreate() {
        await testEnv.DB.batch([
          testEnv.DB.prepare(`
            UPDATE events SET cover_config = ?, cover_revision = 1 WHERE id = ?
          `).bind(COMPETING_PRESET_ONE, access.event.id),
          testEnv.DB.prepare(`
            UPDATE event_cover_publish_receipts
            SET status = 'conflict', retryable = 0
            WHERE operation_id = ?
          `).bind(operationId),
        ]);
      },
    });

    const response = await publish(access, {
      operationId,
      expectedRevision: 0,
      source: { kind: 'upload', draftId: draft.id },
      focus: { mode: 'auto' },
      effect: 'natural',
    }, workflow.env);

    expect(response.status).toBe(409);
    expect(await response.json<any>()).toMatchObject({
      data: { applied: false, operation: { status: 'conflict' } },
    });
    expect(await testEnv.DB.prepare(`
      SELECT dispatch_state, dispatch_generation FROM event_cover_publish_receipts
      WHERE operation_id = ?
    `).bind(operationId).first()).toEqual({ dispatch_state: 'confirmed', dispatch_generation: 1 });
    expect(workflow.calls.filter((call) => call === 'terminate')).toHaveLength(0);
  });

  it('does not overwrite deletion settlement that wins after create starts', async () => {
    const access = await eventAccess();
    const { draft, env } = await readyDraft(access);
    const operationId = crypto.randomUUID();
    const workflow = withCoverRenderWorkflow(env, {
      async onCreate(id) {
        await testEnv.DB.batch([
          testEnv.DB.prepare(`
            UPDATE event_cover_workflow_fences SET state = 'deletion-blocked'
            WHERE workflow_instance_id = ?
          `).bind(id),
          testEnv.DB.prepare(`
            UPDATE event_cover_publish_receipts
            SET status = 'failed', retryable = 0, failure_code = 'EVENT_DELETED',
                dispatch_state = CASE
                  WHEN dispatch_state IN ('creating', 'resuming', 'restarting') THEN dispatch_state
                  ELSE 'blocked'
                END
            WHERE operation_id = ?
          `).bind(operationId),
        ]);
      },
    });

    const response = await publish(access, {
      operationId,
      expectedRevision: 0,
      source: { kind: 'upload', draftId: draft.id },
      focus: { mode: 'auto' },
      effect: 'natural',
    }, workflow.env);

    expect(response.status).toBe(200);
    expect(await response.clone().json<any>()).toMatchObject({
      data: { applied: false, operation: { status: 'permanent-failed' } },
    });
    expect(await testEnv.DB.prepare(`
      SELECT status, dispatch_state, dispatch_generation, failure_code, retryable
      FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(operationId).first()).toEqual({
      status: 'failed', dispatch_state: 'creating', dispatch_generation: 1,
      failure_code: 'EVENT_DELETED', retryable: 0,
    });
    expect(workflow.calls.filter((call) => call === 'terminate')).toHaveLength(1);
  });

  it('does not confirm an exact claim after the event is deleted but before its fence is blocked', async () => {
    const access = await eventAccess();
    const { draft, env } = await readyDraft(access);
    const operationId = crypto.randomUUID();
    const workflow = withCoverRenderWorkflow(env, {
      async onCreate() {
        await testEnv.DB.prepare('UPDATE events SET deleted_at = ? WHERE id = ?')
          .bind(new Date().toISOString(), access.event.id).run();
      },
    });

    const response = await publish(access, {
      operationId,
      expectedRevision: 0,
      source: { kind: 'upload', draftId: draft.id },
      focus: { mode: 'auto' },
      effect: 'natural',
    }, workflow.env);

    expect(response.status).toBe(503);
    expect(await testEnv.DB.prepare(`
      SELECT status, dispatch_state, dispatch_generation
      FROM event_cover_publish_receipts WHERE operation_id = ?
    `).bind(operationId).first()).toEqual({
      status: 'queued', dispatch_state: 'creating', dispatch_generation: 1,
    });
    expect(workflow.calls.filter((call) => call === 'terminate')).toHaveLength(1);
  });

  it('runs the deletion guard after an uncertain rejected create', async () => {
    const access = await eventAccess();
    const { draft, env } = await readyDraft(access);
    const operationId = crypto.randomUUID();
    const workflow = withCoverRenderWorkflow(env, {
      status: 'events/private/cover/cr1-secret',
      async onCreate() {
        await testEnv.DB.prepare('UPDATE events SET deleted_at = ? WHERE id = ?')
          .bind(new Date().toISOString(), access.event.id).run();
        throw new Error('create result unavailable');
      },
    });
    const reported = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const response = await publish(access, {
        operationId,
        expectedRevision: 0,
        source: { kind: 'upload', draftId: draft.id },
        focus: { mode: 'auto' },
        effect: 'natural',
      }, workflow.env);

      expect(response.status).toBe(503);
      expect(workflow.calls.filter((call) => call === 'terminate')).toHaveLength(1);
      expect(await testEnv.DB.prepare(`
        SELECT status, dispatch_state, dispatch_generation
        FROM event_cover_publish_receipts WHERE operation_id = ?
      `).bind(operationId).first()).toEqual({
        status: 'queued', dispatch_state: 'creating', dispatch_generation: 1,
      });
      expect(reported.mock.calls.every((call) => !String(call[0]).includes('private'))).toBe(true);
    } finally {
      reported.mockRestore();
    }
  });

  it('refuses a second preparing publication for the same event', async () => {
    const access = await eventAccess();
    const { draft, env } = await readyDraft(access);
    await publish(access, {
      operationId: crypto.randomUUID(),
      expectedRevision: 0,
      source: { kind: 'upload', draftId: draft.id },
      focus: { mode: 'auto' },
      effect: 'natural',
    }, env);
    const second = await publish(access, {
      operationId: crypto.randomUUID(),
      expectedRevision: 0,
      source: { kind: 'none' },
    }, env);
    expect(second.status).toBe(409);
  });

  it('applies a preset publication synchronously with its pinned semantic config', async () => {
    const access = await eventAccess();
    const response = await publish(access, {
      operationId: crypto.randomUUID(),
      expectedRevision: 0,
      source: { kind: 'preset', presetId: 'warm-linen' },
      effect: 'film',
    });
    expect(response.status).toBe(200);
    expect((await response.json<any>()).data).toMatchObject({
      applied: true,
      appliedRevision: 1,
      event: { cover: { revision: 1, hasCover: true } },
    });
    expect(await testEnv.DB.prepare(`
      SELECT cover_config, cover_object_key, cover_render_set_id
      FROM events WHERE id = ?
    `).bind(access.event.id).first()).toEqual({
      cover_config: JSON.stringify({
        version: 1,
        source: { kind: 'preset', presetId: 'warm-linen', assetVersion: 1 },
        effect: 'film',
      }),
      cover_object_key: null,
      cover_render_set_id: null,
    });
  });

  it('refuses an unknown preset, effect, or focus value', async () => {
    const access = await eventAccess();
    for (const body of [
      { source: { kind: 'preset', presetId: 'sunset-blur' }, effect: 'natural' },
      { source: { kind: 'none' }, effect: 'vivid' },
      {
        source: { kind: 'upload', draftId: ABSENT_DRAFT_ID },
        focus: { mode: 'manual', x: 2, y: 0.5, zoom: 1 },
        effect: 'natural',
      },
    ]) {
      const response = await publish(access, {
        operationId: crypto.randomUUID(),
        expectedRevision: 0,
        ...body,
      });
      expect(response.status).toBe(422);
    }
  });

  it('refuses a draft that is not ready', async () => {
    const access = await eventAccess();
    const draft = (await (await reserve(access)).json<any>()).data.draft;
    const response = await publish(access, {
      operationId: crypto.randomUUID(),
      expectedRevision: 0,
      source: { kind: 'upload', draftId: draft.id },
      focus: { mode: 'auto' },
      effect: 'natural',
    });
    expect(response.status).toBe(409);
    expect((await response.json<any>()).code).toBe('COVER_DRAFT_STATE_CONFLICT');
  });
});

describe('cover review regressions', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('carries Retry-After on a cover rate rejection', async () => {
    const access = await eventAccess();
    // The hourly reservation window is 12; the thirteenth first-seen intent is
    // the one that must say when to come back.
    let last: Response | null = null;
    for (let index = 0; index < 13; index += 1) {
      last = await reserve(access, {
        draftIntentId: `0000000${index.toString(16)}-1111-4111-8111-111111111111`,
        byteSize: RAW_BYTES,
      });
      if (last.status === 429) break;
    }
    expect(last?.status).toBe(429);
    const retryAfter = Number(last?.headers.get('retry-after'));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(3_600);
  });

  it('fails the draft and releases the raw when the natural preview is exhausted', async () => {
    const access = await eventAccess();
    // A master that normalizes, then a preview ladder that cannot fit any rung.
    const recording = withRecordingImages({
      source: { width: 2400, height: 1600 },
      encode: (call) => {
        const output = call.output as { format?: string; quality?: number };
        const last = call.transforms.at(-1) as { width?: number } | undefined;
        // The master transform is the one without an effect recipe behind it.
        const isPreview = call.transforms.length > 1;
        const byteLength = isPreview ? 4_000_000 : 900_000;
        return {
          bytes: new Uint8Array(byteLength).fill(7),
          width: last?.width ?? 2400,
          height: 1600,
          contentType: output.format ?? 'image/webp',
        };
      },
    });
    const draft = (await (await reserve(access, {}, recording.env)).json<any>()).data.draft;
    await putRaw(access, draft.id, { revision: draft.revision, env: recording.env });

    const response = await inspect(access, draft.id, recording.env);
    expect(response.status).toBe(422);
    expect((await response.json<any>()).code).toBe('COVER_PREVIEW_BUDGET_EXHAUSTED');

    const row = await testEnv.DB
      .prepare('SELECT state, raw_object_key FROM event_cover_drafts WHERE id = ?')
      .bind(draft.id).first<{ state: string; raw_object_key: string | null }>();
    // §10.1: the failure is permanent, and its raw and master become eligible
    // for cleanup rather than sitting charged against the event's budget.
    expect(row?.state).toBe('failed');
    expect(row?.raw_object_key).toBeNull();
    expect(await testEnv.MEDIA_BUCKET.head(
      `events/${access.event.id}/cover/raw/${draft.id}`,
    )).toBeNull();
    const master = await testEnv.DB
      .prepare('SELECT cleanup_after FROM event_cover_masters WHERE event_id = ?')
      .bind(access.event.id).first<{ cleanup_after: string | null }>();
    expect(master?.cleanup_after).not.toBeNull();
  });

});

describe('cover publication status and restart', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('reads a receipt without mutating it', async () => {
    const access = await eventAccess();
    const { draft, env } = await readyDraft(access);
    const operationId = crypto.randomUUID();
    await publish(access, {
      operationId,
      expectedRevision: 0,
      source: { kind: 'upload', draftId: draft.id },
      focus: { mode: 'auto' },
      effect: 'natural',
    }, env);

    const before = await testEnv.DB
      .prepare('SELECT updated_at, status FROM event_cover_publish_receipts WHERE operation_id = ?')
      .bind(operationId).first<{ updated_at: string; status: string }>();
    const response = await createApp().request(
      coverPath(access.event.id, `/publications/${operationId}`),
      { headers: { cookie: access.manager.cookie } },
      env,
    );
    expect(response.status).toBe(200);
    const operation = (await response.json<any>()).data.operation;
    expect(operation.operationId).toBe(operationId);
    expect(operation.completedSteps).toBe(0);
    const after = await testEnv.DB
      .prepare('SELECT updated_at, status FROM event_cover_publish_receipts WHERE operation_id = ?')
      .bind(operationId).first<{ updated_at: string; status: string }>();
    expect(after).toEqual(before);
  });

  it('returns the applied revision and fresh event from the status endpoint', async () => {
    const access = await eventAccess();
    const operationId = crypto.randomUUID();
    expect((await publish(access, {
      operationId, expectedRevision: 0, source: { kind: 'none' },
    })).status).toBe(200);

    const response = await createApp().request(
      coverPath(access.event.id, `/publications/${operationId}`),
      { headers: { cookie: access.manager.cookie } },
      testEnv,
    );

    expect(response.status).toBe(200);
    expect(await response.json<any>()).toMatchObject({
      data: {
        operation: { operationId, status: 'applied' },
        appliedRevision: 1,
        event: { cover: { revision: 1 } },
      },
    });
  });

  it('upgrades to the applied envelope when apply wins during the status lookup', async () => {
    const access = await eventAccess();
    const { draft, env } = await readyDraft(access);
    const operationId = crypto.randomUUID();
    let applied = false;
    let allowApply = false;
    const workflow = withCoverRenderWorkflow(env, {
      async onStatus() {
        if (!allowApply || applied) return;
        applied = true;
        await testEnv.DB.batch([
          testEnv.DB.prepare(`
            UPDATE events SET cover_config = ?, cover_revision = 1 WHERE id = ?
          `).bind(COMPETING_PRESET_ONE, access.event.id),
          testEnv.DB.prepare(`
            UPDATE event_cover_publish_receipts
            SET status = 'applied', applied_revision = 1, retryable = 0
            WHERE operation_id = ?
          `).bind(operationId),
        ]);
      },
    });
    expect((await publish(access, {
      operationId,
      expectedRevision: 0,
      source: { kind: 'upload', draftId: draft.id },
      focus: { mode: 'auto' },
      effect: 'natural',
    }, workflow.env)).status).toBe(202);
    allowApply = true;

    const response = await createApp().request(
      coverPath(access.event.id, `/publications/${operationId}`),
      { headers: { cookie: access.manager.cookie } },
      workflow.env,
    );

    expect(response.status).toBe(200);
    expect(await response.json<any>()).toMatchObject({
      data: {
        operation: { operationId, status: 'applied' },
        appliedRevision: 1,
        event: { cover: { revision: 1 } },
      },
    });
  });

  it('reports an unknown operation as not found', async () => {
    const access = await eventAccess();
    const response = await createApp().request(
      coverPath(access.event.id, `/publications/${crypto.randomUUID()}`),
      { headers: { cookie: access.manager.cookie } },
      testEnv,
    );
    expect(response.status).toBe(404);
  });

  it('takes a strictly empty body and refuses an unknown operation', async () => {
    const access = await eventAccess();
    const { draft, env } = await readyDraft(access);
    const operationId = crypto.randomUUID();
    await publish(access, {
      operationId,
      expectedRevision: 0,
      source: { kind: 'upload', draftId: draft.id },
      focus: { mode: 'auto' },
      effect: 'natural',
    }, env);

    // The client never reconstructs the recipe: everything a restart needs is
    // pinned on the receipt, so anything in the body is a mistake.
    const withBody = await createApp().request(
      coverPath(access.event.id, `/publications/${operationId}/restart`),
      { method: 'POST', headers: jsonHeaders(access), body: JSON.stringify({ draftId: draft.id }) },
      env,
    );
    expect(withBody.status).toBe(422);

    const unknown = await createApp().request(
      coverPath(access.event.id, `/publications/${crypto.randomUUID()}/restart`),
      { method: 'POST', headers: jsonHeaders(access), body: JSON.stringify({}) },
      env,
    );
    expect(unknown.status).toBe(409);
  });

  it.each([
    ['an empty body', undefined],
    ['malformed JSON', '{'],
    ['JSON null', 'null'],
  ])('rejects %s on the restart endpoint', async (_label, body) => {
    const access = await eventAccess();
    const response = await createApp().request(
      coverPath(access.event.id, `/publications/${crypto.randomUUID()}/restart`),
      { method: 'POST', headers: jsonHeaders(access), ...(body === undefined ? {} : { body }) },
      testEnv,
    );
    expect(response.status).toBe(422);
    expect(await response.json<any>()).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses restarting an applied receipt', async () => {
    const access = await eventAccess();
    const operationId = crypto.randomUUID();
    await publish(access, { operationId, expectedRevision: 0, source: { kind: 'none' } });
    const response = await createApp().request(
      coverPath(access.event.id, `/publications/${operationId}/restart`),
      { method: 'POST', headers: jsonHeaders(access), body: JSON.stringify({}) },
      testEnv,
    );
    expect(response.status).toBe(200);
    expect((await response.json<any>()).data.operation.status).toBe('applied');
  });

  it('returns 409 when restart replays a stored conflict', async () => {
    const access = await eventAccess();
    await testEnv.DB.prepare(`
      UPDATE events SET cover_config = ?, cover_revision = 1 WHERE id = ?
    `).bind(COMPETING_PRESET_ONE, access.event.id).run();
    const operationId = crypto.randomUUID();
    expect((await publish(access, {
      operationId, expectedRevision: 0, source: { kind: 'none' },
    })).status).toBe(409);

    const response = await createApp().request(
      coverPath(access.event.id, `/publications/${operationId}/restart`),
      { method: 'POST', headers: jsonHeaders(access), body: JSON.stringify({}) },
      testEnv,
    );

    expect(response.status).toBe(409);
    expect((await response.json<any>()).data.operation.status).toBe('conflict');
  });

  it('refuses every cover route to a guest session', async () => {
    const access = await eventAccess();
    const paths = [
      coverPath(access.event.id, '/drafts'),
      coverPath(access.event.id, '/publications'),
    ];
    for (const path of paths) {
      const response = await createApp().request(path, {
        method: 'POST',
        headers: { origin, cookie: access.guest.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }, testEnv);
      expect([401, 403]).toContain(response.status);
    }
  });
});

describe('cover ingress and inspection boundaries', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('accepts the byte at the ceiling and aborts the one past it', async () => {
    const access = await eventAccess();
    // Declared at the ceiling, because the schema refuses anything larger. The
    // only way byte 19,000,001 can arrive is a client that lied.
    const reserved = await reserve(access, {
      draftIntentId: INTENT_A,
      byteSize: MAX_COVER_UPLOAD_BYTES,
    });
    const draft = (await reserved.json<any>()).data.draft;

    const overflowing = await putRaw(access, draft.id, {
      revision: draft.revision,
      contentLength: String(MAX_COVER_UPLOAD_BYTES),
      body: new Uint8Array(MAX_COVER_UPLOAD_BYTES + 1),
    });
    expect(overflowing.status).toBe(413);
    expect(await testEnv.MEDIA_BUCKET.head(
      `events/${access.event.id}/cover/raw/${draft.id}`,
    )).toBeNull();

    // Confirmed absent, so the same draft retries at its current revision.
    const current = await testEnv.DB
      .prepare('SELECT draft_revision FROM event_cover_drafts WHERE id = ?')
      .bind(draft.id).first<{ draft_revision: number }>();
    const exact = await putRaw(access, draft.id, {
      revision: current!.draft_revision,
      contentLength: String(MAX_COVER_UPLOAD_BYTES),
      body: new Uint8Array(MAX_COVER_UPLOAD_BYTES),
    });
    expect(exact.status).toBe(200);
    const stored = await testEnv.MEDIA_BUCKET.head(
      `events/${access.event.id}/cover/raw/${draft.id}`,
    );
    expect(stored?.size).toBe(MAX_COVER_UPLOAD_BYTES);
  }, 60_000);

  it('keeps a partial charged when its deletion fails', async () => {
    const access = await eventAccess();
    const draft = (await (await reserve(access)).json<any>()).data.draft;
    // R2 refuses to delete: the bytes may still be there, so the accounting must
    // keep counting them rather than optimistically forgiving the charge.
    // Bound explicitly rather than layered with `Object.create`: the R2 binding
    // is native, and a derived receiver makes its own methods throw.
    const bucket = testEnv.MEDIA_BUCKET;
    const refusing: AppEnv = {
      ...testEnv,
      MEDIA_BUCKET: {
        put: bucket.put.bind(bucket),
        get: bucket.get.bind(bucket),
        head: bucket.head.bind(bucket),
        list: bucket.list.bind(bucket),
        delete: () => Promise.reject(new Error('R2 refused')),
      } as unknown as R2Bucket,
    };

    const response = await putRaw(access, draft.id, {
      revision: draft.revision,
      body: new Uint8Array(RAW_BYTES + 512).fill(3),
      env: refusing,
    });
    expect(response.status).toBe(413);

    const row = await testEnv.DB
      .prepare('SELECT state, raw_object_key FROM event_cover_drafts WHERE id = ?')
      .bind(draft.id).first<{ state: string; raw_object_key: string | null }>();
    expect(row?.state).toBe('failed');
    // Inventory intact for a later bounded pass to retry.
    expect(row?.raw_object_key).not.toBeNull();
  });

  it('replays a verified transfer without allocating another raw slot', async () => {
    const access = await eventAccess();
    const draft = (await (await reserve(access)).json<any>()).data.draft;
    const first = await putRaw(access, draft.id, { revision: draft.revision });
    expect(first.status).toBe(200);
    const transferred = (await first.json<any>()).data.draft;

    // The same bytes again at the revision the transfer left behind.
    const replay = await putRaw(access, draft.id, { revision: transferred.revision });
    expect(replay.status).toBe(200);
    const drafts = await testEnv.DB
      .prepare('SELECT count(*) AS count FROM event_cover_drafts WHERE event_id = ?')
      .bind(access.event.id).first<{ count: number }>();
    expect(drafts?.count).toBe(1);
  });

  it('refuses a reservation that would pass the event raw-byte aggregate', async () => {
    const access = await eventAccess();
    // Three at the ceiling is 57,000,000 exactly; the fourth cannot fit.
    for (const [index, intent] of [INTENT_A, INTENT_B, INTENT_C].entries()) {
      const response = await reserve(access, {
        draftIntentId: intent,
        byteSize: MAX_COVER_UPLOAD_BYTES,
      });
      expect([index, response.status]).toEqual([index, 201]);
    }
    const fourth = await reserve(access, {
      draftIntentId: INTENT_D,
      byteSize: MAX_COVER_UPLOAD_BYTES,
    });
    // The live-draft cap of three is reached first, which is itself the answer:
    // whichever bound binds, the host is told which one and how to clear it.
    expect(fourth.status).toBe(409);
    expect(['COVER_DRAFT_LIMIT', 'COVER_RAW_STORAGE_LIMIT'])
      .toContain((await fourth.json<any>()).code);
  });

  it('refuses bytes whose decoded type contradicts the declaration', async () => {
    const access = await eventAccess();
    const recording = withRecordingImages({ source: { width: 2400, height: 1600 } });
    // The reservation says JPEG; the decoder says PNG.
    const info = recording.env.IMAGES.info.bind(recording.env.IMAGES);
    const contradicting: AppEnv = {
      ...recording.env,
      IMAGES: Object.create(recording.env.IMAGES, {
        info: {
          value: async (stream: ReadableStream) => ({
            ...(await info(stream)),
            format: 'image/png',
          }),
        },
      }) as ImagesBinding,
    };
    const draft = (await (await reserve(access, {}, contradicting)).json<any>()).data.draft;
    await putRaw(access, draft.id, { revision: draft.revision, env: contradicting });

    const response = await inspect(access, draft.id, contradicting);
    // §10.1: the detected type is rechecked before bytes reach Images.
    expect(response.status).toBe(415);
    expect((await response.json<any>()).code).toBe('COVER_SOURCE_UNSUPPORTED');
  });

  it('fails inspection when no normalization rung fits the master ceiling', async () => {
    const access = await eventAccess();
    const recording = withRecordingImages({
      source: { width: 4000, height: 3000 },
      // Every rung encodes above MAX_COVER_MASTER_BYTES.
      encode: () => ({
        bytes: new Uint8Array(13_000_000),
        width: 4000,
        height: 3000,
        contentType: 'image/webp',
      }),
    });
    const draft = (await (await reserve(access, {}, recording.env)).json<any>()).data.draft;
    await putRaw(access, draft.id, { revision: draft.revision, env: recording.env });

    const response = await inspect(access, draft.id, recording.env);
    expect(response.status).toBe(422);
    expect((await response.json<any>()).code).toBe('COVER_MASTER_BUDGET_EXHAUSTED');
    // The failure never waits until `Done`, and it never touches the cover.
    const event = await testEnv.DB
      .prepare('SELECT cover_revision FROM events WHERE id = ?')
      .bind(access.event.id).first<{ cover_revision: number }>();
    expect(event?.cover_revision).toBe(0);
  }, 30_000);

  it('writes the automatic point onto the master exactly once', async () => {
    const access = await eventAccess();
    const { draft, env } = await readyDraft(access);
    const master = await testEnv.DB
      .prepare('SELECT auto_focus_x, auto_focus_y FROM event_cover_masters WHERE event_id = ?')
      .bind(access.event.id).first<{ auto_focus_x: number; auto_focus_y: number }>();
    expect(master?.auto_focus_x).toBe(0.5);
    expect(master?.auto_focus_y).toBe(0.4);

    // A later edit must still be able to reset to the composition Candidary
    // originally proposed for these exact bytes, so the master's point is
    // written once and never moved by a subsequent composition write.
    await compose(access, draft.id, { expectedDraftRevision: draft.revision, y: 0.9 }, env);
    const after = await testEnv.DB
      .prepare('SELECT auto_focus_y FROM event_cover_masters WHERE event_id = ?')
      .bind(access.event.id).first<{ auto_focus_y: number }>();
    expect(after?.auto_focus_y).toBe(0.4);
  });
});

describe('cover publication replay and restart eligibility', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('replays an in-progress upload publication as the same operation', async () => {
    const access = await eventAccess();
    const { draft, env } = await readyDraft(access);
    const operationId = crypto.randomUUID();
    const body = {
      operationId,
      expectedRevision: 0,
      source: { kind: 'upload', draftId: draft.id },
      focus: { mode: 'auto' },
      effect: 'natural',
    };

    const first = await publish(access, body, env);
    expect(first.status).toBe(202);
    const replay = await publish(access, body, env);
    // The same digest replays into the same receipt rather than allocating a
    // second one, which the one-preparing-per-event index would refuse anyway.
    expect([200, 202]).toContain(replay.status);
    expect((await replay.json<any>()).data.operation.operationId).toBe(operationId);

    const receipts = await testEnv.DB
      .prepare('SELECT count(*) AS count FROM event_cover_publish_receipts WHERE event_id = ?')
      .bind(access.event.id).first<{ count: number }>();
    expect(receipts?.count).toBe(1);
  });

  it('refuses an upload operation ID reused with different bytes', async () => {
    const access = await eventAccess();
    const { draft, env } = await readyDraft(access);
    const operationId = crypto.randomUUID();
    await publish(access, {
      operationId,
      expectedRevision: 0,
      source: { kind: 'upload', draftId: draft.id },
      focus: { mode: 'auto' },
      effect: 'natural',
    }, env);

    const collision = await publish(access, {
      operationId,
      expectedRevision: 0,
      source: { kind: 'upload', draftId: draft.id },
      focus: { mode: 'auto' },
      // A different style is different bytes, and the digest says so.
      effect: 'film',
    }, env);
    expect(collision.status).toBe(409);
    expect((await collision.json<any>()).code).toBe('COVER_PUBLICATION_CONFLICT');
  });

  it('returns the exact terminal result for a permanently failed receipt', async () => {
    const access = await eventAccess();
    const { draft, env } = await readyDraft(access);
    const operationId = crypto.randomUUID();
    await publish(access, {
      operationId,
      expectedRevision: 0,
      source: { kind: 'upload', draftId: draft.id },
      focus: { mode: 'auto' },
      effect: 'natural',
    }, env);
    await testEnv.DB.prepare(`
      UPDATE event_cover_publish_receipts
      SET status = 'failed', retryable = 0, failure_code = 'COVER_OUTPUT_BUDGET_EXHAUSTED'
      WHERE event_id = ? AND operation_id = ?
    `).bind(access.event.id, operationId).run();

    const response = await createApp().request(
      coverPath(access.event.id, `/publications/${operationId}/restart`),
      { method: 'POST', headers: jsonHeaders(access), body: JSON.stringify({}) },
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json<any>()).toMatchObject({
      data: { operation: { status: 'permanent-failed', retryable: false } },
    });
  });

  it('refuses a restart from a manager of another event', async () => {
    const access = await eventAccess();
    const other = await eventAccess('Other Event');
    const operationId = crypto.randomUUID();
    await publish(access, { operationId, expectedRevision: 0, source: { kind: 'none' } });

    const response = await createApp().request(
      coverPath(other.event.id, `/publications/${operationId}/restart`),
      { method: 'POST', headers: jsonHeaders(other), body: JSON.stringify({}) },
      testEnv,
    );
    // Event-scoped by the receipt read: another event's operation resolves to
    // nothing here rather than to someone else's cover.
    expect(response.status).toBe(409);
  });
});

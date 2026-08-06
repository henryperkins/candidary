import { beforeEach, describe, expect, it } from 'vitest';

import { MAX_COVER_UPLOAD_BYTES } from '../../shared/constants';
import { COVER_PIPELINE_VERSIONS } from '../../shared/event-cover';
import { createApp } from '../../worker/app';
import type { AppEnv } from '../../worker/env';
import {
  eventAccess,
  hostAccess,
  hostWriteHeaders,
  origin,
  resetDatabase,
  testEnv,
  withRecordingImages,
  writeHeaders,
} from './helpers';

type Access = Awaited<ReturnType<typeof eventAccess>>;
type Body = Record<string, any>;

const RAW_BYTES = 4_000;

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
    expect(data.event.coverRevision).toBe(1);
    expect(data.event.coverObjectKey).toBeNull();
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
    expect((await collision.json<any>()).code).toBe('COVER_PUBLICATION_CONFLICT');
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

  it('refuses a preset publication in this release', async () => {
    const access = await eventAccess();
    const response = await publish(access, {
      operationId: crypto.randomUUID(),
      expectedRevision: 0,
      source: { kind: 'preset', presetId: 'warm-linen' },
      effect: 'natural',
    });
    expect(response.status).toBe(422);
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

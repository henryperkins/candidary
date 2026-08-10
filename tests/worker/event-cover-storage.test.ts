import { beforeEach, describe, expect, it } from 'vitest';

import { MAX_LIVE_COVER_DRAFTS_PER_EVENT } from '../../shared/constants';
import { COVER_PIPELINE_VERSIONS } from '../../shared/event-cover';
import { presetCoverAssetPath } from '../../shared/event-cover-assets';
import {
  adoptCoverPreview,
  chargeCoverRateEvent,
  claimCoverRawIngress,
  createCoverDraft,
  discardCoverDraft,
  insertCoverMaster,
  liveCoverRawBytes,
  recordVerifiedCoverRaw,
  releaseCoverRawBytes,
  writeCoverComposition,
} from '../../worker/db/event-covers';
import { coverPointerStatements } from '../../worker/db/events';
import {
  coverKeyFingerprint,
  coverMasterKey,
  coverPreviewKey,
  coverRawKey,
  coverRenderKey,
  isEventCoverKey,
} from '../../worker/storage/event-cover-keys';
import { eventAccess, resetDatabase, seedEventCoverGraph, testEnv } from './helpers';

const HEX_64 = 'a'.repeat(64);
const OTHER_HEX = 'b'.repeat(64);
const now = new Date('2026-08-04T12:00:00.000Z');

type Access = Awaited<ReturnType<typeof eventAccess>>;

function draftInput(access: Access, patch: Record<string, unknown> = {}) {
  return {
    eventId: access.event.id,
    draftIntentId: 'intent-a',
    requestDigest: HEX_64,
    source: 'new_upload' as const,
    filename: 'porch.jpg',
    mimeType: 'image/jpeg',
    byteSize: 4_000_000,
    now,
    ...patch,
  };
}

async function seedMaster(eventId: string, id: string) {
  await insertCoverMaster(testEnv.DB, {
    id,
    eventId,
    objectKey: coverMasterKey(eventId, id),
    byteSize: 900_000,
    width: 2400,
    height: 1600,
    sha256: HEX_64,
    normalizationVersion: COVER_PIPELINE_VERSIONS.normalizationLadder,
    normalizationRung: 1,
    now,
  });
  return id;
}

describe('event cover object keys', () => {
  it('builds deterministic keys that stay inside the event prefix', () => {
    expect(coverRawKey('e1', 'd1')).toBe('events/e1/cover/raw/d1');
    expect(coverMasterKey('e1', 'm1')).toBe('events/e1/cover/masters/m1.webp');
    expect(coverPreviewKey('e1', 'd1', 'film', 1)).toBe('events/e1/cover/previews/d1/film-1.webp');
    expect(coverRenderKey('e1', 's1', 'wide-expanded', '2x', 'jpeg'))
      .toBe('events/e1/cover/rendered/s1/wide-expanded-2x.jpeg');
    expect(presetCoverAssetPath(1, 'warm-linen', 'natural', 'short-lookup', '1x', 'webp'))
      .toBe('/assets/event-covers/v1/warm-linen/natural/short-lookup-1x.webp');

    for (const key of [
      coverRawKey('e1', 'd1'),
      coverMasterKey('e1', 'm1'),
      coverPreviewKey('e1', 'd1', 'natural', 1),
      coverRenderKey('e1', 's1', 'compact-default', '1x', 'webp'),
    ]) {
      expect(isEventCoverKey('e1', key)).toBe(true);
      // The whole point of a server-built key: no other event can address it,
      // and a prefix that merely starts the same does not count.
      expect(isEventCoverKey('e2', key)).toBe(false);
      expect(isEventCoverKey('e', key)).toBe(false);
      expect(key.startsWith('events/e1/')).toBe(true);
    }
    expect(isEventCoverKey('e1', 'events/e1/media/photo.jpg')).toBe(false);
    expect(isEventCoverKey('e1', '../events/e1/cover/raw/d1')).toBe(false);
  });
});

describe('cover draft reservation', () => {
  let access: Access;
  beforeEach(async () => {
    await resetDatabase();
    access = await eventAccess();
  });

  it('replays the same intent without consuming a second slot', async () => {
    const first = await createCoverDraft(testEnv.DB, draftInput(access));
    expect(first.replayed).toBe(false);

    const replay = await createCoverDraft(testEnv.DB, draftInput(access));
    expect(replay.replayed).toBe(true);
    expect(replay.draft.id).toBe(first.draft.id);

    const count = await testEnv.DB.prepare(
      'SELECT count(*) AS count FROM event_cover_drafts WHERE event_id = ?',
    ).bind(access.event.id).first<{ count: number }>();
    expect(count).toEqual({ count: 1 });
  });

  it('refuses the same intent with different bytes', async () => {
    await createCoverDraft(testEnv.DB, draftInput(access));
    await expect(createCoverDraft(testEnv.DB, draftInput(access, { requestDigest: OTHER_HEX })))
      .rejects.toMatchObject({ code: 'COVER_DRAFT_STATE_CONFLICT', status: 409 });
  });

  it('holds the three-live-draft cap', async () => {
    for (let index = 0; index < MAX_LIVE_COVER_DRAFTS_PER_EVENT; index += 1) {
      await createCoverDraft(testEnv.DB, draftInput(access, {
        draftIntentId: `intent-${index}`, byteSize: 1_000,
      }));
    }
    await expect(createCoverDraft(testEnv.DB, draftInput(access, {
      draftIntentId: 'intent-over', byteSize: 1_000,
    }))).rejects.toMatchObject({ code: 'COVER_DRAFT_LIMIT', status: 409 });
  });

  it('holds the 57,000,000-byte aggregate', async () => {
    await createCoverDraft(testEnv.DB, draftInput(access, { draftIntentId: 'a', byteSize: 19_000_000 }));
    await createCoverDraft(testEnv.DB, draftInput(access, { draftIntentId: 'b', byteSize: 19_000_000 }));
    expect(await liveCoverRawBytes(testEnv.DB, access.event.id)).toBe(38_000_000);
    await expect(createCoverDraft(testEnv.DB, draftInput(access, {
      draftIntentId: 'c', byteSize: 19_000_001,
    }))).rejects.toMatchObject({ code: 'COVER_RAW_STORAGE_LIMIT', status: 409 });
    // Exactly at the bound is legal.
    const third = await createCoverDraft(testEnv.DB, draftInput(access, {
      draftIntentId: 'c', byteSize: 19_000_000,
    }));
    expect(third.replayed).toBe(false);
    expect(await liveCoverRawBytes(testEnv.DB, access.event.id)).toBe(57_000_000);
  });

  it('stays charged through fail and discard cycles until R2 absence is verified', async () => {
    const created = await createCoverDraft(testEnv.DB, draftInput(access, { byteSize: 19_000_000 }));
    // Claiming ingress records the key before any byte is written, so a crash
    // mid-transfer cannot leave bytes nothing is accounted for.
    await claimCoverRawIngress(testEnv.DB, {
      draftId: created.draft.id, eventId: access.event.id, expectedDraftRevision: 0, now,
    });
    await recordVerifiedCoverRaw(testEnv.DB, {
      draftId: created.draft.id, eventId: access.event.id, expectedDraftRevision: 1,
      verifiedByteSize: 19_000_500, etag: 'etag-a', now,
    });
    // The observed size replaces the declaration and keeps counting.
    expect(await liveCoverRawBytes(testEnv.DB, access.event.id)).toBe(19_000_500);

    await discardCoverDraft(testEnv.DB, {
      draftId: created.draft.id, eventId: access.event.id, expectedDraftRevision: 2, now,
    });
    // A discard stops future ingress; it cannot subtract cleanup-pending bytes.
    expect(await liveCoverRawBytes(testEnv.DB, access.event.id)).toBe(19_000_500);

    await releaseCoverRawBytes(testEnv.DB, { draftId: created.draft.id, now });
    expect(await liveCoverRawBytes(testEnv.DB, access.event.id)).toBe(0);
  });
});

describe('guarded draft discard', () => {
  let access: Access;
  beforeEach(async () => {
    await resetDatabase();
    access = await eventAccess();
  });

  it('requires the current revision, is idempotent, and refuses a publishing draft', async () => {
    const created = await createCoverDraft(testEnv.DB, draftInput(access));
    await expect(discardCoverDraft(testEnv.DB, {
      draftId: created.draft.id, eventId: access.event.id, expectedDraftRevision: 7, now,
    })).rejects.toMatchObject({ code: 'COVER_DRAFT_STATE_CONFLICT', status: 409 });

    const discarded = await discardCoverDraft(testEnv.DB, {
      draftId: created.draft.id, eventId: access.event.id, expectedDraftRevision: 0, now,
    });
    expect(discarded.state).toBe('expired');
    // Already expired: a replay with any revision is success, not a conflict.
    const replay = await discardCoverDraft(testEnv.DB, {
      draftId: created.draft.id, eventId: access.event.id, expectedDraftRevision: 0, now,
    });
    expect(replay.state).toBe('expired');

    const publishing = await createCoverDraft(testEnv.DB, draftInput(access, { draftIntentId: 'p' }));
    await testEnv.DB.prepare(`UPDATE event_cover_drafts SET state = 'publishing' WHERE id = ?`)
      .bind(publishing.draft.id).run();
    await expect(discardCoverDraft(testEnv.DB, {
      draftId: publishing.draft.id, eventId: access.event.id, expectedDraftRevision: 0, now,
    })).rejects.toMatchObject({ code: 'COVER_DRAFT_STATE_CONFLICT', status: 409 });
  });

  it('never makes the event’s active master cleanup-eligible', async () => {
    const graph = await seedEventCoverGraph(testEnv.DB, access.event.id, now.toISOString());
    const masterId = graph.masterId;
    await testEnv.DB.prepare(`
      UPDATE events
      SET cover_config = ?, cover_object_key = ?, cover_render_set_id = ?, cover_revision = 1
      WHERE id = ?
    `).bind(
      '{"version":1,"source":{"kind":"upload"},"focus":{"mode":"auto"},"effect":"natural"}',
      coverMasterKey(access.event.id, masterId),
      graph.renderSetId,
      access.event.id,
    ).run();
    const edit = await createCoverDraft(testEnv.DB, draftInput(access, {
      draftIntentId: 'edit', source: 'existing_upload', masterId,
      filename: null, mimeType: null, byteSize: null,
    }));

    await discardCoverDraft(testEnv.DB, {
      draftId: edit.draft.id, eventId: access.event.id, expectedDraftRevision: 0, now,
    });

    const master = await testEnv.DB.prepare(
      'SELECT cleanup_after FROM event_cover_masters WHERE id = ?',
    ).bind(masterId).first<{ cleanup_after: string | null }>();
    expect(master?.cleanup_after).toBeNull();
  });
});

describe('composition write', () => {
  let access: Access;
  beforeEach(async () => {
    await resetDatabase();
    access = await eventAccess();
  });

  it('moves inspected to ready once, replays identically, and refuses a stale revision', async () => {
    const created = await createCoverDraft(testEnv.DB, draftInput(access));
    const masterId = await seedMaster(access.event.id, 'master-a');
    await testEnv.DB.prepare(`
      UPDATE event_cover_drafts SET state = 'inspected', master_id = ?, draft_revision = 2 WHERE id = ?
    `).bind(masterId, created.draft.id).run();

    const ready = await writeCoverComposition(testEnv.DB, {
      draftId: created.draft.id,
      eventId: access.event.id,
      expectedDraftRevision: 2,
      modelVersion: COVER_PIPELINE_VERSIONS.compositionModel,
      x: 0.4,
      y: 0.6,
      now,
    });
    expect(ready.state).toBe('ready');
    expect(ready.draft_revision).toBe(3);

    // Both the draft and the master carry the point, so a later edit can reset.
    const master = await testEnv.DB.prepare(
      'SELECT auto_focus_x, auto_focus_y, composition_model_version FROM event_cover_masters WHERE id = ?',
    ).bind(masterId).first<any>();
    expect(master).toEqual({ auto_focus_x: 0.4, auto_focus_y: 0.6, composition_model_version: 1 });

    const replay = await writeCoverComposition(testEnv.DB, {
      draftId: created.draft.id, eventId: access.event.id, expectedDraftRevision: 3,
      modelVersion: COVER_PIPELINE_VERSIONS.compositionModel, x: 0.4, y: 0.6, now,
    });
    expect(replay.draft_revision).toBe(3);

    await expect(writeCoverComposition(testEnv.DB, {
      draftId: created.draft.id, eventId: access.event.id, expectedDraftRevision: 2,
      modelVersion: COVER_PIPELINE_VERSIONS.compositionModel, x: 0.9, y: 0.1, now,
    })).rejects.toMatchObject({ code: 'COVER_DRAFT_STATE_CONFLICT', status: 409 });
  });
});

describe('draft preview inventory', () => {
  let access: Access;
  let draftId: string;
  beforeEach(async () => {
    await resetDatabase();
    access = await eventAccess();
    const created = await createCoverDraft(testEnv.DB, draftInput(access));
    draftId = created.draft.id;
  });

  const preview = (effect: string, patch: Record<string, unknown> = {}) => ({
    draftId,
    eventId: access.event.id,
    effect,
    recipeVersion: COVER_PIPELINE_VERSIONS.previewRecipe,
    objectKey: coverPreviewKey(access.event.id, draftId, effect as never, 1),
    byteSize: 90_000,
    width: 1280,
    height: 853,
    ladderRung: 1,
    sha256: HEX_64,
    now,
    ...patch,
  });

  it('counts only ready files and refuses the sixth', async () => {
    for (const effect of ['natural', 'warm', 'film', 'soft', 'monochrome']) {
      await adoptCoverPreview(testEnv.DB, preview(effect));
    }
    // A sixth effect does not exist in the registry, so exhaustion is proven by
    // a re-render of an existing tuple rather than by inventing an effect.
    const replay = await adoptCoverPreview(testEnv.DB, preview('film'));
    expect(replay.replayed).toBe(true);
    expect(replay.row.state).toBe('ready');

    const count = await testEnv.DB.prepare(
      'SELECT count(*) AS count FROM event_cover_draft_previews WHERE draft_id = ?',
    ).bind(draftId).first<{ count: number }>();
    expect(count).toEqual({ count: 5 });
  });

  it('holds the per-file budget, and the two bounds meet exactly at five files', async () => {
    await expect(adoptCoverPreview(testEnv.DB, preview('natural', { byteSize: 1_000_001 })))
      .rejects.toMatchObject({ code: 'COVER_PREVIEW_BUDGET_EXHAUSTED' });
    // Five files at the per-file ceiling is exactly the 5,000,000-byte aggregate,
    // so the two constants meet rather than one shadowing the other. Both are
    // still enforced: the aggregate is what catches a future file-count change.
    for (const effect of ['natural', 'warm', 'film', 'soft', 'monochrome']) {
      await adoptCoverPreview(testEnv.DB, preview(effect, { byteSize: 1_000_000 }));
    }
    const totals = await testEnv.DB.prepare(`
      SELECT count(*) AS count, SUM(byte_size) AS bytes FROM event_cover_draft_previews
      WHERE draft_id = ? AND state = 'ready'
    `).bind(draftId).first<{ count: number; bytes: number }>();
    expect(totals).toEqual({ count: 5, bytes: 5_000_000 });
  });

  it('replays a terminal failure and lets only a retryable one re-enter rendering', async () => {
    await adoptCoverPreview(testEnv.DB, preview('warm', {
      failureCode: 'COVER_PREVIEW_BUDGET_EXHAUSTED', retryable: false,
    }));
    const permanent = await adoptCoverPreview(testEnv.DB, preview('warm'));
    expect(permanent.replayed).toBe(true);
    expect(permanent.row.state).toBe('failed');

    await adoptCoverPreview(testEnv.DB, preview('soft', { failureCode: 'COVER_RENDER_UNAVAILABLE', retryable: true }));
    const retried = await adoptCoverPreview(testEnv.DB, preview('soft'));
    expect(retried.replayed).toBe(false);
    expect(retried.row.state).toBe('ready');
  });
});

describe('persisted rate windows', () => {
  let access: Access;
  beforeEach(async () => {
    await resetDatabase();
    access = await eventAccess();
  });

  const charge = (replayKey: string, patch: Record<string, unknown> = {}) => chargeCoverRateEvent(testEnv.DB, {
    eventId: access.event.id,
    action: 'publication' as const,
    replayKey,
    requestDigest: HEX_64,
    limit: 6,
    now,
    ...patch,
  });

  function rateDbWithInsertRace(winnerDigest: string): D1Database {
    let raced = false;
    const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(
      statement,
      {
        get(target, property) {
          if (property === 'bind') {
            return (...values: unknown[]) => wrap(target.bind(...values), sql);
          }
          if (property === 'first') {
            return async <T>() => {
              const result = await target.first<T>();
              if (!raced && sql.includes('SELECT request_sha256 FROM event_cover_rate_events')) {
                raced = true;
                await testEnv.DB.prepare(`
                  INSERT INTO event_cover_rate_events (
                    id, event_id, action, replay_key, request_sha256,
                    window_start, created_at, expires_at
                  ) VALUES (?, ?, 'publication', 'op-race', ?, ?, ?, ?)
                `).bind(
                  crypto.randomUUID(), access.event.id, winnerDigest,
                  Math.floor(now.getTime() / 1000 / 3600) * 3600,
                  now.toISOString(), '2026-08-05T14:00:00.000Z',
                ).run();
              }
              return result;
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      },
    );
    return new Proxy(testEnv.DB, {
      get(target, property) {
        if (property === 'prepare') {
          return (sql: string) => wrap(target.prepare(sql), sql);
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  it('counts a fixed hourly window, exempts replays, and reconstructs after a restart', async () => {
    for (let index = 0; index < 6; index += 1) await charge(`op-${index}`);
    await expect(charge('op-over')).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 });
    // A replay of a counted operation costs nothing.
    expect((await charge('op-0')).replayed).toBe(true);

    // The window is derived from the row, not from process memory, so a restart
    // reconstructs the same count.
    const rows = await testEnv.DB.prepare(`
      SELECT window_start, count(*) AS count FROM event_cover_rate_events
      WHERE event_id = ? AND action = 'publication' GROUP BY window_start
    `).bind(access.event.id).all<{ window_start: number; count: number }>();
    expect(rows.results).toEqual([
      { window_start: Math.floor(now.getTime() / 1000 / 3600) * 3600, count: 6 },
    ]);

    // The next window starts clean.
    const later = new Date('2026-08-04T13:00:00.000Z');
    expect((await charge('op-next', { now: later })).replayed).toBe(false);
  });

  it('rejects a replay key reused with different bytes', async () => {
    await charge('op-a');
    await expect(charge('op-a', { requestDigest: OTHER_HEX }))
      .rejects.toMatchObject({ code: 'COVER_PUBLICATION_CONFLICT', status: 409 });
  });

  it('resolves a concurrent first insert as replay or digest conflict instead of a 500', async () => {
    const input = {
      eventId: access.event.id,
      action: 'publication' as const,
      replayKey: 'op-race',
      requestDigest: HEX_64,
      limit: 6,
      now,
    };
    await expect(chargeCoverRateEvent(rateDbWithInsertRace(HEX_64), input))
      .resolves.toEqual({ replayed: true });

    await resetDatabase();
    access = await eventAccess();
    await expect(chargeCoverRateEvent(rateDbWithInsertRace(OTHER_HEX), {
      ...input, eventId: access.event.id,
    }))
      .rejects.toMatchObject({ code: 'COVER_PUBLICATION_CONFLICT', status: 409 });
  });
});

describe('coverPointerStatements', () => {
  let access: Access;
  beforeEach(async () => {
    await resetDatabase();
    access = await eventAccess();
    // These are statement-builder unit tests. Their deliberately incomplete
    // old/next pointer fixtures predate 0014 and isolate the guarded update plus
    // conditional retirement SQL. Migration tests and publication-service
    // tests exercise the final trigger layer with complete relational graphs.
    await testEnv.DB.exec('DROP TRIGGER event_cover_source_pointer_update');
  });

  const move = (patch: Record<string, unknown> = {}) => coverPointerStatements(testEnv.DB, {
    eventId: access.event.id,
    expectedRevision: 0,
    expectedCurrentKey: null,
    expectedCurrentRenderSetId: null,
    nextConfig: '{"version":1,"source":{"kind":"none"}}',
    nextObjectKey: null,
    nextRenderSetId: null,
    retiredAt: now.toISOString(),
    cleanupAfter: '2026-08-11T12:00:00.000Z',
    retiredKeyFingerprint: 'c'.repeat(64),
    ...patch,
  });

  async function eventPointers() {
    return testEnv.DB.prepare(`
      SELECT cover_config, cover_revision, cover_object_key, cover_render_set_id
      FROM events WHERE id = ?
    `).bind(access.event.id).first<any>();
  }

  async function retiredKeys() {
    const rows = await testEnv.DB.prepare(
      'SELECT object_key FROM event_cover_retired_legacy_objects WHERE event_id = ?',
    ).bind(access.event.id).all<{ object_key: string }>();
    return rows.results.map((row) => row.object_key);
  }

  it('increments the revision exactly once and writes no retirement for a first cover', async () => {
    const results = await testEnv.DB.batch(move({
      nextConfig: '{"version":1,"source":{"kind":"upload"},"focus":{"mode":"auto"},"effect":"natural"}',
      nextObjectKey: coverMasterKey(access.event.id, 'master-a'),
      nextRenderSetId: 'set-a',
    }));
    expect(results[0]!.meta.changes).toBe(1);
    expect(await eventPointers()).toEqual({
      cover_config: '{"version":1,"source":{"kind":"upload"},"focus":{"mode":"auto"},"effect":"natural"}',
      cover_revision: 1,
      cover_object_key: coverMasterKey(access.event.id, 'master-a'),
      cover_render_set_id: 'set-a',
    });
    // No key was displaced, so an unconditional insert would have written NULL
    // into a NOT NULL UNIQUE column and failed every first publication.
    expect(await retiredKeys()).toEqual([]);
  });

  it('inventories a displaced legacy original in the same batch, without deleting it', async () => {
    const legacy = `events/${access.event.id}/cover/9f1c-porch.jpg`;
    await testEnv.DB.prepare('UPDATE events SET cover_object_key = ? WHERE id = ?')
      .bind(legacy, access.event.id).run();
    await testEnv.MEDIA_BUCKET.put(legacy, new Uint8Array([1, 2, 3]));

    await testEnv.DB.batch(move({
      expectedCurrentKey: legacy,
      retiredKeyFingerprint: await coverKeyFingerprint(legacy),
      nextConfig: '{"version":1,"source":{"kind":"upload"},"focus":{"mode":"auto"},"effect":"natural"}',
      nextObjectKey: coverMasterKey(access.event.id, 'master-b'),
      nextRenderSetId: 'set-b',
    }));

    expect(await retiredKeys()).toEqual([legacy]);
    // The fingerprint is a real SHA-256 of the key, so a recovery audit holding
    // the key can match the row without comparing full keys.
    const stored = await testEnv.DB.prepare(
      'SELECT key_fingerprint AS v FROM event_cover_retired_legacy_objects WHERE object_key = ?',
    ).bind(legacy).first<{ v: string }>();
    expect(stored?.v).toBe(await coverKeyFingerprint(legacy));
    // Only bounded cleanup may delete it, and only after the recovery window.
    expect(await testEnv.MEDIA_BUCKET.head(legacy)).not.toBeNull();
  });

  it('writes no retirement row when the guard is lost', async () => {
    const legacy = `events/${access.event.id}/cover/9f1c-porch.jpg`;
    await testEnv.DB.prepare('UPDATE events SET cover_object_key = ?, cover_revision = 4 WHERE id = ?')
      .bind(legacy, access.event.id).run();

    // A stale revision. The UPDATE changes nothing and does not error, so an
    // unguarded insert placed first would commit a retirement row naming a
    // cover that is still current.
    const stale = await testEnv.DB.batch(move({ expectedRevision: 0, expectedCurrentKey: legacy }));
    expect(stale[0]!.meta.changes).toBe(0);
    expect(await retiredKeys()).toEqual([]);

    // A changed current key loses the same way.
    const changed = await testEnv.DB.batch(move({
      expectedRevision: 4, expectedCurrentKey: 'events/other/cover/x.jpg',
    }));
    expect(changed[0]!.meta.changes).toBe(0);
    expect(await retiredKeys()).toEqual([]);
    expect((await eventPointers()).cover_revision).toBe(4);
  });

  it('writes no retirement row when the displaced key belongs to a render set', async () => {
    const masterKey = coverMasterKey(access.event.id, 'master-old');
    await testEnv.DB.prepare(
      'UPDATE events SET cover_object_key = ?, cover_render_set_id = ? WHERE id = ?',
    ).bind(masterKey, 'set-old', access.event.id).run();

    await testEnv.DB.batch(move({
      expectedCurrentKey: masterKey,
      expectedCurrentRenderSetId: 'set-old',
      nextObjectKey: coverMasterKey(access.event.id, 'master-new'),
      nextRenderSetId: 'set-new',
    }));

    // A normalized master is not a legacy original; the retirement table is the
    // recovery inventory for pre-0012 originals only.
    expect(await retiredKeys()).toEqual([]);
    expect((await eventPointers()).cover_render_set_id).toBe('set-new');
  });
});

describe('concurrent raw ingress', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('refuses a second claim holding the revision the first already moved', async () => {
    const access = await eventAccess();
    const { draft } = await createCoverDraft(testEnv.DB, draftInput(access));

    // Two in-flight PUTs both read revision 0 before either lands.
    const first = await claimCoverRawIngress(testEnv.DB, {
      draftId: draft.id,
      eventId: access.event.id,
      expectedDraftRevision: 0,
      now,
    });
    expect(first.replayed).toBe(false);

    // Without a revision guard this returns `replayed: true` and both requests
    // stream to the same key: the loser's object is then orphaned in R2 with no
    // inventory row, because the winner clears the pointer that charged for it.
    await expect(claimCoverRawIngress(testEnv.DB, {
      draftId: draft.id,
      eventId: access.event.id,
      expectedDraftRevision: 0,
      now,
    })).rejects.toThrow();
  });

  it('replays a claim that still holds the current revision', async () => {
    const access = await eventAccess();
    const { draft } = await createCoverDraft(testEnv.DB, draftInput(access));
    const claimed = await claimCoverRawIngress(testEnv.DB, {
      draftId: draft.id,
      eventId: access.event.id,
      expectedDraftRevision: 0,
      now,
    });
    const current = await testEnv.DB
      .prepare('SELECT draft_revision FROM event_cover_drafts WHERE id = ?')
      .bind(draft.id).first<{ draft_revision: number }>();

    // A genuine retry after a confirmed-absent partial re-enters the same slot
    // rather than allocating another.
    const replayed = await claimCoverRawIngress(testEnv.DB, {
      draftId: draft.id,
      eventId: access.event.id,
      expectedDraftRevision: current!.draft_revision,
      now,
    });
    expect(replayed.replayed).toBe(true);
    expect(replayed.objectKey).toBe(claimed.objectKey);
  });
});

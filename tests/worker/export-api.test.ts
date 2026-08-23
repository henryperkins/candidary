import { beforeEach, describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';

import { MAX_EVENT_BYTES } from '../../shared/constants';
import { createApp } from '../../worker/app';
import { ExportsRepository } from '../../worker/db/exports';
import { processExport } from '../../worker/workflows/export';
import { eventAccess, png, resetDatabase, testEnv, uploadPending, writeHeaders } from './helpers';

const managerExportKeys = [
  'attempt',
  'expiresAt',
  'guestbookEntryCount',
  'guestbookEventDate',
  'guestbookEventName',
  'guestbookEventTimezone',
  'guestbookGalleryVisible',
  'guestbookPrompt',
  'guestbookSharedCount',
  'id',
  'kind',
  'mediaCount',
  'partCount',
  'snapshotAt',
  'state',
  'totalBytes',
].sort();

function expectManagerExport(value: Record<string, unknown>) {
  expect(Object.keys(value).sort()).toEqual(managerExportKeys);
}

async function failedExportWithArtifacts(
  access: Awaited<ReturnType<typeof eventAccess>>,
  label: string,
) {
  await uploadPending(access, label, null);
  const created = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
    method: 'POST', headers: writeHeaders(access.manager), body: '{}',
  }, testEnv);
  const job = (await created.json<any>()).data.export;
  const ready = await processExport(testEnv, job.id, new Date());
  const repository = new ExportsRepository(testEnv.DB);
  const parts = await repository.listParts(job.id);
  const keys = [
    ready!.manifestObjectKey,
    ...parts.map(({ objectKey }) => objectKey),
    ready!.guestbookHtmlObjectKey,
    ready!.guestbookCsvObjectKey,
  ].filter((key): key is string => Boolean(key));
  await testEnv.DB.prepare(`
    UPDATE export_jobs SET state = 'failed', error_code = 'EXPORT_TEST_FAILURE' WHERE id = ?
  `).bind(job.id).run();
  return { job, keys };
}

function signerFreeEnv() {
  return new Proxy(testEnv, {
    get(target, property, receiver) {
      if (property === 'R2_ACCESS_KEY_ID' || property === 'R2_SECRET_ACCESS_KEY') {
        throw new Error(`Export download read retired signer secret ${String(property)}.`);
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

const ALBUM_SNAPSHOT_SOURCE_AT = '2026-08-23T00:00:00.000Z';

async function setAlbumSnapshotSource(
  access: Awaited<ReturnType<typeof eventAccess>>,
  pickedIds: string[],
  entriesJson: string,
) {
  await testEnv.DB.batch([
    testEnv.DB.prepare(`
      UPDATE media SET
        created_at = ?2,
        stored_at = ?2,
        favorited_at = CASE
        WHEN id IN (SELECT value FROM json_each(?1)) THEN ?2 ELSE NULL END
      WHERE event_id = ?3
    `).bind(JSON.stringify(pickedIds), ALBUM_SNAPSHOT_SOURCE_AT, access.event.id),
    testEnv.DB.prepare(`
      INSERT INTO event_albums (
        event_id, entries, saved_at, revision, created_at, updated_at
      ) VALUES (?1, ?2, ?3, 1, ?3, ?3)
      ON CONFLICT(event_id) DO UPDATE SET
        entries = excluded.entries, saved_at = excluded.saved_at,
        revision = event_albums.revision + 1, updated_at = excluded.updated_at
    `).bind(access.event.id, entriesJson, ALBUM_SNAPSHOT_SOURCE_AT),
  ]);
}

describe('manager exports', () => {
  beforeEach(resetDatabase);

  it('atomically creates a new-format notes-only job with frozen metadata and entries', async () => {
    const access = await eventAccess();
    const guestSessionId = await testEnv.DB.prepare(`
      SELECT id FROM event_sessions WHERE event_id = ? AND role = 'guest' LIMIT 1
    `).bind(access.event.id).first<string>('id');
    await testEnv.DB.prepare(`
      INSERT INTO guest_messages (
        id, event_id, guest_session_id, guest_name, body, moderation_status,
        idempotency_key, created_at, approved_at, deleted_at
      ) VALUES ('note-only', ?, ?, 'Avery', 'A frozen note', 'approved',
        'note-only-key', '2026-08-12T12:00:00.000Z', '2026-08-12T12:00:00.000Z', NULL)
    `).bind(access.event.id, guestSessionId).run();

    const response = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);

    expect(response.status).toBe(202);
    const job = (await response.json<any>()).data.export;
    expect(job).toMatchObject({
      mediaCount: 0,
      guestbookEntryCount: 1,
      guestbookSharedCount: 1,
      guestbookEventName: access.event.name,
      guestbookEventDate: access.event.eventDate,
      guestbookEventTimezone: access.event.eventTimezone,
      guestbookPrompt: access.event.guestbookPrompt,
      guestbookGalleryVisible: access.event.galleryVisible,
    });
    expect(job.snapshotAt).toBeTruthy();
    const rows = await testEnv.DB.prepare(`
      SELECT source, source_id, body, source_state, guest_visibility, included_in_keepsake
      FROM export_guestbook_entries WHERE export_job_id = ?
    `).bind(job.id).all();
    expect(rows.results).toEqual([{
      source: 'guest_note', source_id: 'note-only', body: 'A frozen note',
      source_state: 'approved', guest_visibility: 'shared', included_in_keepsake: 1,
    }]);

    await testEnv.DB.prepare(`
      UPDATE guest_messages SET body = 'Changed after snapshot', moderation_status = 'rejected'
      WHERE id = 'note-only'
    `).run();
    const ready = await processExport(testEnv, job.id, new Date());
    expect(ready).toMatchObject({ state: 'ready', manifestObjectKey: null, partCount: 0 });
    expect(ready?.guestbookHtmlBytes).toBeGreaterThan(0);
    expect(ready?.guestbookHtmlSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(ready?.guestbookCsvBytes).toBeGreaterThan(0);
    expect(ready?.guestbookCsvSha256).toMatch(/^[a-f0-9]{64}$/u);
    const htmlObject = await testEnv.MEDIA_BUCKET.get(ready!.guestbookHtmlObjectKey!);
    const csvObject = await testEnv.MEDIA_BUCKET.get(ready!.guestbookCsvObjectKey!);
    expect(await htmlObject!.text()).toContain('A frozen note');
    expect(await csvObject!.text()).toContain('A frozen note');
    expect(await (await testEnv.MEDIA_BUCKET.get(ready!.guestbookCsvObjectKey!))!.text())
      .not.toContain('Changed after snapshot');
    expect(htmlObject!.httpMetadata).toMatchObject({
      contentType: 'text/html; charset=utf-8',
      contentDisposition: 'attachment; filename="guestbook.html"',
    });

    const download = await createApp().request(
      `/api/manage/events/${access.event.id}/exports/${job.id}/download`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      testEnv,
    );
    expect(download.status).toBe(200);
    const data = (await download.json<any>()).data;
    expect(data.manifest).toBeNull();
    expect(data.parts).toEqual([]);
    expect(data.printableGuestbook.filename).toBe('guestbook.html');
    expect(data.privateGuestbook.filename).toBe('guestbook-private.csv');
    expect(data.printableGuestbook.expiresAt).toBe(data.privateGuestbook.expiresAt);
    expect(data.printableGuestbook.url).toContain('/artifact/printable-guestbook');
    expect(data.privateGuestbook.url).toContain('/artifact/private-guestbook');
  });

  it('rejects an empty snapshot', async () => {
    const access = await eventAccess();
    const response = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    expect(response.status).toBe(409);
    expect((await response.json<any>()).code).toBe('EXPORT_EMPTY');
  });

  it('atomically freezes only live album picks, canonical raw order, and deterministic tail positions', async () => {
    const access = await eventAccess();
    const first = await uploadPending(access, 'album-snapshot-first', 'First pick');
    const second = await uploadPending(access, 'album-snapshot-second', 'Second pick');
    const unpickedLegacy = await uploadPending(access, 'album-snapshot-unpicked', 'Unpicked legacy');
    await testEnv.DB.batch([
      testEnv.DB.prepare('UPDATE media SET timeline_at = ? WHERE id = ?')
        .bind('2026-08-23T10:00:00.000Z', first.id),
      testEnv.DB.prepare('UPDATE media SET timeline_at = ? WHERE id = ?')
        .bind('2026-08-23T11:00:00.000Z', second.id),
      testEnv.DB.prepare('UPDATE media SET object_key = ? WHERE id = ?')
        .bind(`events/${access.event.id}/media/${unpickedLegacy.id}`, unpickedLegacy.id),
    ]);
    const rawEntries = `[
      { "kind": "section", "id": "section-a", "heading": "Dinner" },
      { "kind": "photo", "mediaId": "${second.id}" },
      { "kind": "photo", "mediaId": "stale-id" },
      { "kind": "photo", "mediaId": "${first.id}" }
    ]`;
    await setAlbumSnapshotSource(access, [first.id, second.id], rawEntries);

    const response = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: JSON.stringify({ kind: 'album' }),
    }, testEnv);

    expect(response.status).toBe(202);
    const job = (await response.json<any>()).data.export;
    expect(job).toMatchObject({ kind: 'album', mediaCount: 2, totalBytes: 128 });
    const frozen = await testEnv.DB.prepare(`
      SELECT kind, album_entries_json, guestbook_entry_count, guestbook_event_name
      FROM export_jobs WHERE id = ?
    `).bind(job.id).first<any>();
    expect(frozen).toEqual({
      kind: 'album',
      album_entries_json: JSON.stringify(JSON.parse(rawEntries)),
      guestbook_entry_count: null,
      guestbook_event_name: null,
    });
    expect((await testEnv.DB.prepare(`
      SELECT media_id, album_tail_position FROM export_media_entries
      WHERE export_job_id = ? ORDER BY album_tail_position
    `).bind(job.id).all()).results).toEqual([
      { media_id: first.id, album_tail_position: 1 },
      { media_id: second.id, album_tail_position: 2 },
    ]);
    expect(await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM export_guestbook_entries WHERE export_job_id = ?
    `).bind(job.id).first<number>('count')).toBe(0);
  });

  it('bounds album membership, bytes, and canonical validation by storage and pick transition times', async () => {
    const access = await eventAccess();
    const included = await uploadPending(access, 'album-boundary-included', null);
    const storedAfter = await uploadPending(access, 'album-boundary-stored-after', null);
    const pickedAfter = await uploadPending(access, 'album-boundary-picked-after', null);
    const boundary = '2026-08-23T12:00:00.000Z';
    await setAlbumSnapshotSource(
      access,
      [included.id, storedAfter.id, pickedAfter.id],
      JSON.stringify([
        { kind: 'photo', mediaId: storedAfter.id },
        { kind: 'photo', mediaId: included.id },
        { kind: 'photo', mediaId: pickedAfter.id },
      ]),
    );
    await testEnv.DB.batch([
      testEnv.DB.prepare(`
        UPDATE media SET created_at = '2026-08-23T09:00:00.000Z',
          stored_at = '2026-08-23T10:00:00.000Z', favorited_at = '2026-08-23T11:00:00.000Z'
        WHERE id = ?
      `).bind(included.id),
      testEnv.DB.prepare(`
        UPDATE media SET created_at = '2026-08-23T09:00:00.000Z',
          stored_at = '2026-08-23T13:00:00.000Z', favorited_at = '2026-08-23T11:00:00.000Z',
          object_key = ?, byte_size = ?
        WHERE id = ?
      `).bind(`events/${access.event.id}/media/${storedAfter.id}`, MAX_EVENT_BYTES + 1, storedAfter.id),
      testEnv.DB.prepare(`
        UPDATE media SET created_at = '2026-08-23T09:00:00.000Z',
          stored_at = '2026-08-23T10:00:00.000Z', favorited_at = '2026-08-23T13:00:00.000Z',
          object_key = ?, byte_size = ?
        WHERE id = ?
      `).bind(`events/${access.event.id}/media/${pickedAfter.id}`, MAX_EVENT_BYTES + 1, pickedAfter.id),
    ]);

    const job = await new ExportsRepository(testEnv.DB).createAlbumActive({
      id: crypto.randomUUID(), eventId: access.event.id, snapshotAt: boundary, createdAt: boundary,
    });

    expect(job).toMatchObject({ kind: 'album', mediaCount: 1, totalBytes: 64 });
    expect((await testEnv.DB.prepare(`
      SELECT media_id FROM export_media_entries WHERE export_job_id = ?
    `).bind(job.id).all()).results).toEqual([{ media_id: included.id }]);
  });

  it('classifies an album with only post-boundary transitions as empty', async () => {
    const access = await eventAccess();
    const after = await uploadPending(access, 'album-boundary-empty', null);
    const boundary = '2026-08-23T12:00:00.000Z';
    await setAlbumSnapshotSource(access, [after.id], '[]');
    await testEnv.DB.prepare(`
      UPDATE media SET created_at = '2026-08-23T09:00:00.000Z',
        stored_at = '2026-08-23T13:00:00.000Z', favorited_at = '2026-08-23T13:00:00.000Z',
        object_key = ?, byte_size = ?
      WHERE id = ?
    `).bind(`events/${access.event.id}/media/${after.id}`, MAX_EVENT_BYTES + 1, after.id).run();

    await expect(new ExportsRepository(testEnv.DB).createAlbumActive({
      id: crypto.randomUUID(), eventId: access.event.id, snapshotAt: boundary, createdAt: boundary,
    })).rejects.toMatchObject({ code: 'EXPORT_EMPTY' });
  });

  it('freezes malformed and non-array historical album order as canonical empty order', async () => {
    for (const [index, raw] of ['{', '{"kind":"photo"}'].entries()) {
      const access = await eventAccess();
      const picked = await uploadPending(access, `album-malformed-order-${index}`, null);
      await setAlbumSnapshotSource(access, [picked.id], '[]');
      await testEnv.DB.prepare('PRAGMA ignore_check_constraints = ON').run();
      await testEnv.DB.prepare('UPDATE event_albums SET entries = ? WHERE event_id = ?')
        .bind(raw, access.event.id).run();
      await testEnv.DB.prepare('PRAGMA ignore_check_constraints = OFF').run();

      const response = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
        method: 'POST', headers: writeHeaders(access.manager), body: JSON.stringify({ kind: 'album' }),
      }, testEnv);

      expect(response.status).toBe(202);
      const job = (await response.json<any>()).data.export;
      expect(await testEnv.DB.prepare('SELECT album_entries_json FROM export_jobs WHERE id = ?')
        .bind(job.id).first<string>('album_entries_json')).toBe('[]');
      expect((await testEnv.DB.prepare(`
        SELECT media_id, album_tail_position FROM export_media_entries WHERE export_job_id = ?
      `).bind(job.id).all()).results).toEqual([
        { media_id: picked.id, album_tail_position: 1 },
      ]);
    }
  });

  it('refuses an empty album even when the event has complete-export content', async () => {
    const access = await eventAccess();
    await uploadPending(access, 'album-empty-unpicked', 'Still delivered');
    await setAlbumSnapshotSource(access, [], '[]');

    const response = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: JSON.stringify({ kind: 'album' }),
    }, testEnv);

    expect(response.status).toBe(409);
    expect((await response.json<any>()).code).toBe('EXPORT_EMPTY');
    expect(await testEnv.DB.prepare('SELECT count(*) AS count FROM export_jobs WHERE event_id = ?')
      .bind(access.event.id).first<number>('count')).toBe(0);
  });

  it('rolls back the album job and its frozen order when picked-row insertion fails', async () => {
    const access = await eventAccess();
    const picked = await uploadPending(access, 'album-snapshot-rollback', null);
    await setAlbumSnapshotSource(
      access,
      [picked.id],
      JSON.stringify([{ kind: 'photo', mediaId: picked.id }]),
    );
    await testEnv.DB.prepare(`
      CREATE TRIGGER fail_album_media_snapshot BEFORE INSERT ON export_media_entries
      BEGIN SELECT RAISE(ABORT, 'album snapshot insert failed'); END
    `).run();

    const response = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: JSON.stringify({ kind: 'album' }),
    }, testEnv);

    expect(response.status).toBe(500);
    expect(await testEnv.DB.prepare('SELECT count(*) AS count FROM export_jobs WHERE event_id = ?')
      .bind(access.event.id).first<number>('count')).toBe(0);
    expect(await testEnv.DB.prepare('SELECT count(*) AS count FROM export_media_entries')
      .first<number>('count')).toBe(0);
  });

  it('rejects unknown export selectors and preserves the empty-object complete contract', async () => {
    const access = await eventAccess();
    await uploadPending(access, 'complete-empty-object', null);
    const invalid = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager),
      body: JSON.stringify({ kind: 'complete', extra: true }),
    }, testEnv);
    expect(invalid.status).toBe(422);

    const complete = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    expect(complete.status).toBe(202);
    expect((await complete.json<any>()).data.export).toMatchObject({ kind: 'complete' });
    expect(await testEnv.DB.prepare('SELECT album_entries_json FROM export_jobs WHERE event_id = ?')
      .bind(access.event.id).first<string | null>('album_entries_json')).toBeNull();
  });

  it('lists equal-time exports newest-first with a stable ID tie-breaker', async () => {
    const access = await eventAccess();
    const repository = new ExportsRepository(testEnv.DB);
    const createdAt = '2026-08-23T12:00:00.000Z';
    for (const id of ['export-a', 'export-b']) {
      await repository.createActive({
        id, eventId: access.event.id, snapshotAt: createdAt,
        mediaCount: 0, totalBytes: 0, createdAt,
      });
      await repository.markFailed(id, 'EXPORT_TEST_FAILURE');
    }

    expect((await repository.listForEvent(access.event.id)).map(({ id }) => id))
      .toEqual(['export-b', 'export-a']);
  });

  it('refuses a legacy writable photo before creating or dispatching an export', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'legacy-writable-export', 'Legacy photo');
    await testEnv.DB.prepare('UPDATE media SET object_key = ? WHERE id = ?')
      .bind(`events/${access.event.id}/media/${media.id}`, media.id).run();
    let dispatches = 0;
    const guardedEnv = Object.create(testEnv) as typeof testEnv;
    Object.defineProperty(guardedEnv, 'EXPORT_WORKFLOW', {
      value: {
        async create() {
          dispatches += 1;
          return { id: 'unexpected-export-workflow' };
        },
      },
    });

    const response = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, guardedEnv);

    expect(response.status).toBe(409);
    expect(await response.json<any>()).toMatchObject({
      code: 'EXPORT_MEDIA_UPGRADE_REQUIRED',
      message: 'Some photos need a storage upgrade before they can be exported. Try again after the upgrade is complete.',
    });
    expect(dispatches).toBe(0);
    expect(await testEnv.DB.prepare('SELECT count(*) AS count FROM export_jobs WHERE event_id = ?')
      .bind(access.event.id).first<number>('count')).toBe(0);
    expect(await testEnv.DB.prepare('SELECT count(*) AS count FROM export_media_entries')
      .first<number>('count')).toBe(0);
    expect(await testEnv.DB.prepare('SELECT count(*) AS count FROM export_guestbook_entries')
      .first<number>('count')).toBe(0);
  });

  it('discriminates active and oversized snapshots without leaving partial jobs', async () => {
    const activeAccess = await eventAccess();
    await uploadPending(activeAccess, 'active-export', null);
    const first = await createApp().request(`/api/manage/events/${activeAccess.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(activeAccess.manager), body: '{}',
    }, testEnv);
    const second = await createApp().request(`/api/manage/events/${activeAccess.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(activeAccess.manager), body: '{}',
    }, testEnv);
    expect(first.status).toBe(202);
    expect(second.status).toBe(409);
    expect((await second.json<any>()).code).toBe('EXPORT_ALREADY_ACTIVE');

    const oversizedAccess = await eventAccess();
    const media = await uploadPending(oversizedAccess, 'oversized-export', 'Too large');
    await testEnv.DB.prepare('UPDATE media SET byte_size = ? WHERE id = ?')
      .bind(MAX_EVENT_BYTES + 1, media.id).run();
    const oversized = await createApp().request(`/api/manage/events/${oversizedAccess.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(oversizedAccess.manager), body: '{}',
    }, testEnv);
    expect(oversized.status).toBe(409);
    expect((await oversized.json<any>()).code).toBe('EXPORT_LIMIT_EXCEEDED');
    expect(await testEnv.DB.prepare(`SELECT count(*) AS count FROM export_jobs WHERE event_id = ?`)
      .bind(oversizedAccess.event.id).first<number>('count')).toBe(0);
  });

  it('rolls back the queued job when immutable entry insertion fails', async () => {
    const access = await eventAccess();
    const sessionId = await testEnv.DB.prepare(`
      SELECT id FROM event_sessions WHERE event_id = ? AND role = 'guest' LIMIT 1
    `).bind(access.event.id).first<string>('id');
    await testEnv.DB.prepare(`
      INSERT INTO guest_messages (
        id, event_id, guest_session_id, guest_name, body, moderation_status,
        idempotency_key, created_at, approved_at, deleted_at
      ) VALUES ('rollback-note', ?, ?, 'Avery', 'Rollback me', 'approved',
        'rollback-note-key', '2026-08-12T12:00:00.000Z', '2026-08-12T12:00:00.000Z', NULL)
    `).bind(access.event.id, sessionId).run();
    await testEnv.DB.prepare(`
      CREATE TRIGGER fail_guestbook_snapshot BEFORE INSERT ON export_guestbook_entries
      BEGIN SELECT RAISE(ABORT, 'snapshot insert failed'); END
    `).run();
    const response = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    expect(response.status).toBe(500);
    expect(await testEnv.DB.prepare(`SELECT count(*) AS count FROM export_jobs WHERE event_id = ?`)
      .bind(access.event.id).first<number>('count')).toBe(0);
    expect(await testEnv.DB.prepare(`SELECT count(*) AS count FROM export_guestbook_entries`)
      .first<number>('count')).toBe(0);
  });

  it('preserves more than 1,000 legacy notes without truncating the private snapshot', async () => {
    const access = await eventAccess();
    const sessionId = await testEnv.DB.prepare(`
      SELECT id FROM event_sessions WHERE event_id = ? AND role = 'guest' LIMIT 1
    `).bind(access.event.id).first<string>('id');
    await testEnv.DB.prepare(`
      WITH RECURSIVE notes(n) AS (
        SELECT 1 UNION ALL SELECT n + 1 FROM notes WHERE n < 1001
      )
      INSERT INTO guest_messages (
        id, event_id, guest_session_id, guest_name, body, moderation_status,
        idempotency_key, created_at, approved_at, deleted_at
      ) SELECT printf('legacy-note-%04d', n), ?, ?, 'Legacy', printf('Note %d', n),
        CASE WHEN n % 2 = 0 THEN 'approved' ELSE 'pending' END,
        printf('legacy-key-%04d', n), '2026-08-12T12:00:00.000Z',
        CASE WHEN n % 2 = 0 THEN '2026-08-12T12:00:00.000Z' ELSE NULL END, NULL
      FROM notes
    `).bind(access.event.id, sessionId).run();
    const response = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    expect(response.status).toBe(202);
    const job = (await response.json<any>()).data.export;
    expect(job.guestbookEntryCount).toBe(1001);
    expect(await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM export_guestbook_entries WHERE export_job_id = ?
    `).bind(job.id).first<number>('count')).toBe(1001);
    expect(await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM export_media_entries WHERE export_job_id = ?
    `).bind(job.id).first<number>('count')).toBe(0);
  });

  it('exports unpublished originals in bounded parts with a manifest and manager-only URLs', async () => {
    const access = await eventAccess();
    await uploadPending(access, 'exportable-a', 'Sunset toast');
    await uploadPending(access, 'exportable-b', 'Dance floor');

    const created = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    expect(created.status).toBe(202);
    const job = (await created.json<any>()).data.export;
    // Completion is dated from the clock the run actually sees. A literal here silently rots: the
    // download route refuses a job whose retention window has already elapsed, so a fixed date turns
    // this into a 409 the moment real time passes it.
    await processExport(testEnv, job.id, new Date(), 100);

    const status = await createApp().request(`/api/manage/events/${access.event.id}/exports/${job.id}`, {
      headers: { cookie: access.manager.cookie },
    }, testEnv);
    expect((await status.json<any>()).data.export.state).toBe('ready');
    const repository = new ExportsRepository(testEnv.DB);
    const ready = await repository.getById(job.id);
    const parts = await repository.listParts(job.id);
    expect(ready).toMatchObject({ partCount: 2 });
    expect(parts.map(({ partNumber, mediaCount, sourceBytes }) => ({ partNumber, mediaCount, sourceBytes }))).toEqual([
      { partNumber: 1, mediaCount: 1, sourceBytes: 64 },
      { partNumber: 2, mediaCount: 1, sourceBytes: 64 },
    ]);
    const firstObject = await testEnv.MEDIA_BUCKET.get(parts[0]!.objectKey);
    const firstArchive = unzipSync(new Uint8Array(await firstObject!.arrayBuffer()));
    expect(Object.keys(firstArchive)).toEqual(['photos/001-exportable-a.png', 'media.csv']);
    expect(strFromU8(firstArchive['media.csv']!)).toContain('unpublished');
    const manifestObject = await testEnv.MEDIA_BUCKET.get(ready!.manifestObjectKey!);
    const manifest = await manifestObject!.text();
    expect(manifest).toContain('photos-001.zip');
    expect(manifest).toContain('photos-002.zip');
    expect(manifest).toContain('Sunset toast');
    expect(ready!.guestbookHtmlObjectKey).toContain('/attempt-1/guestbook.html');
    expect(ready!.guestbookCsvObjectKey).toContain('/attempt-1/guestbook-private.csv');
    expect(await (await testEnv.MEDIA_BUCKET.get(ready!.guestbookHtmlObjectKey!))!.text())
      .toContain('No guestbook entries were shared at this snapshot.');

    const env = signerFreeEnv();
    const download = await createApp().request(`/api/manage/events/${access.event.id}/exports/${job.id}/download`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, env);
    expect(download.status).toBe(200);
    const downloadData = (await download.json<any>()).data;
    expect(downloadData.manifest.url).toContain('/artifact/manifest');
    expect(downloadData.parts).toHaveLength(2);
    expect(downloadData.parts.every((part: any) => part.url.includes('/artifact/part/'))).toBe(true);
    expect(downloadData.printableGuestbook.filename).toBe('guestbook.html');
    expect(downloadData.privateGuestbook.filename).toBe('guestbook-private.csv');

    const denied = await createApp().request(`/api/manage/events/${access.event.id}/exports/${job.id}/download`, {
      method: 'POST', headers: writeHeaders(access.guest), body: '{}',
    }, env);
    expect(denied.status).toBe(403);

    const artifact = await createApp().request(downloadData.parts[0].url, {
      headers: { cookie: access.manager.cookie, range: 'bytes=0-9' },
    }, testEnv);
    expect(artifact.status).toBe(206);
    expect(artifact.headers.get('content-range')).toMatch(/^bytes 0-9\//u);
    expect(artifact.headers.get('content-length')).toBe('10');
    expect(artifact.headers.get('content-disposition')).toContain('attachment');
    expect(artifact.headers.get('cache-control')).toBe('private, no-store');
    expect(artifact.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await artifact.arrayBuffer()).byteLength).toBe(10);

    const suffix = await createApp().request(downloadData.parts[0].url, {
      headers: { cookie: access.manager.cookie, range: 'bytes=-8' },
    }, testEnv);
    expect(suffix.status).toBe(206);
    expect((await suffix.arrayBuffer()).byteLength).toBe(8);

    const artifactDenied = await createApp().request(downloadData.parts[0].url, {}, testEnv);
    expect(artifactDenied.status).toBe(401);
    const unsatisfiable = await createApp().request(downloadData.parts[0].url, {
      headers: { cookie: access.manager.cookie, range: 'bytes=999999999-' },
    }, testEnv);
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get('content-range')).toMatch(/^bytes \*\//u);

    const other = await eventAccess();
    const crossEvent = await createApp().request(downloadData.manifest.url, {
      headers: { cookie: other.manager.cookie },
    }, env);
    expect(crossEvent.status).toBe(403);

    await testEnv.MEDIA_BUCKET.delete(ready!.manifestObjectKey!);
    const missing = await createApp().request(downloadData.manifest.url, {
      headers: { cookie: access.manager.cookie },
    }, env);
    expect(missing.status).toBe(409);
    expect(await missing.json<any>()).toMatchObject({ code: 'EXPORT_FAILED' });
  });

  it('does not stream changed export bytes after the conditional metadata read', async () => {
    const access = await eventAccess();
    await uploadPending(access, 'conditional-export', null);
    const created = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const job = (await created.json<any>()).data.export;
    const ready = await processExport(testEnv, job.id, new Date());
    const download = await createApp().request(
      `/api/manage/events/${access.event.id}/exports/${job.id}/download`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      testEnv,
    );
    const url = (await download.json<any>()).data.manifest.url as string;
    let replaced = false;
    const changingBucket = new Proxy(testEnv.MEDIA_BUCKET, {
      get(target, property) {
        if (property === 'get') {
          return async (...args: Parameters<R2Bucket['get']>) => {
            if (!replaced) {
              replaced = true;
              await target.put(ready!.manifestObjectKey!, 'changed-after-head');
            }
            return target.get(...args);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const response = await createApp().request(url, {
      headers: { cookie: access.manager.cookie },
    }, { ...testEnv, MEDIA_BUCKET: changingBucket });

    expect(response.status).toBe(409);
    expect(await response.json<any>()).toMatchObject({ code: 'EXPORT_FAILED' });
  });

  it('uses an attempt-specific object key when retrying a failed job', async () => {
    const access = await eventAccess();
    const repository = new ExportsRepository(testEnv.DB);
    const job = await repository.createActive({
      id: crypto.randomUUID(), eventId: access.event.id,
      snapshotAt: '2026-07-21T12:00:00.000Z', mediaCount: 1, totalBytes: 64,
      createdAt: '2026-07-21T12:00:00.000Z',
    });
    await repository.markFailed(job.id, 'EXPORT_SOURCE_MISSING');
    const retry = await createApp().request(`/api/manage/events/${access.event.id}/exports/${job.id}/retry`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    expect(retry.status).toBe(202);
    expect((await retry.json<any>()).data.export.attempt).toBe(2);
  });

  it('keeps a found initial Workflow with unknown status on its one deterministic instance ID', async () => {
    const access = await eventAccess();
    await uploadPending(access, 'initial-workflow-failure', null);
    const createdIds: string[] = [];
    const workflow = new Proxy(testEnv.EXPORT_WORKFLOW, {
      get(target, property, receiver) {
        if (property === 'create') return async () => { throw new Error('non-idempotent create used'); };
        if (property === 'createBatch') {
          return async (batch: Array<{ id: string }>) => {
            createdIds.push(batch[0]!.id);
            throw new Error('simulated lost initial Workflow creation response');
          };
        }
        if (property === 'get') {
          return async (id: string) => ({ id, status: async () => ({ status: 'unknown' }) });
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const response = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, { ...testEnv, EXPORT_WORKFLOW: workflow });

    expect(response.status).toBe(202);
    const [job] = await new ExportsRepository(testEnv.DB).listForEvent(access.event.id);
    expect(job).toMatchObject({ state: 'queued', attempt: 1, errorCode: null });
    expect(createdIds).toEqual([job!.id]);
  });

  it.each(['errored', 'terminated'] as const)(
    'durably fails a pristine initial job whose only Workflow instance is %s before claim',
    async (terminal) => {
      const access = await eventAccess();
      await uploadPending(access, `initial-workflow-${terminal}`, null);
      const createdIds: string[] = [];
      const workflow = new Proxy(testEnv.EXPORT_WORKFLOW, {
        get(target, property, receiver) {
          if (property === 'create') return async () => { throw new Error('non-idempotent create used'); };
          if (property === 'createBatch') {
            return async (batch: Array<{ id: string }>) => {
              createdIds.push(batch[0]!.id);
              throw new Error('simulated lost terminal Workflow response');
            };
          }
          if (property === 'get') {
            return async (id: string) => ({ id, status: async () => ({ status: terminal }) });
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });

      const response = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
        method: 'POST', headers: writeHeaders(access.manager), body: '{}',
      }, { ...testEnv, EXPORT_WORKFLOW: workflow });

      expect(response.status).toBe(202);
      const body = await response.json<any>();
      expect(body.data.export).toMatchObject({ state: 'failed', attempt: 1 });
      const job = await new ExportsRepository(testEnv.DB).getById(body.data.export.id);
      expect(job).toMatchObject({
        state: 'failed', attempt: 1, errorCode: 'EXPORT_WORKFLOW_DISPATCH_FAILED',
      });
      expect(createdIds).toEqual([job!.id]);
      expect((await testEnv.DB.prepare(`
        SELECT count(*) AS count FROM export_parts WHERE export_job_id = ?
      `).bind(job!.id).first<number>('count'))).toBe(0);
    },
  );

  it.each(['get', 'status'] as const)(
    'replays idempotent creation on the same initial ID after an unobservable %s outcome',
    async (unobservable) => {
      const access = await eventAccess();
      await uploadPending(access, `initial-workflow-unobservable-${unobservable}`, null);
      const createdIds: string[] = [];
      const workflow = new Proxy(testEnv.EXPORT_WORKFLOW, {
        get(target, property, receiver) {
          if (property === 'create') return async () => { throw new Error('non-idempotent create used'); };
          if (property === 'createBatch') {
            return async (batch: Array<{ id: string }>) => {
              createdIds.push(batch[0]!.id);
              if (createdIds.length === 1) throw new Error('simulated unobservable createBatch result');
            };
          }
          if (property === 'get') {
            if (unobservable === 'get') {
              return async () => { throw new Error('simulated unobservable Workflow lookup'); };
            }
            return async (id: string) => ({
              id,
              status: async () => { throw new Error('simulated unobservable Workflow status'); },
            });
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });

      const response = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
        method: 'POST', headers: writeHeaders(access.manager), body: '{}',
      }, { ...testEnv, EXPORT_WORKFLOW: workflow });

      expect(response.status).toBe(202);
      const job = (await response.json<any>()).data.export;
      expect(job).toMatchObject({ state: 'queued', attempt: 1 });
      expect(createdIds).toEqual([job.id, job.id]);
      expect((await new ExportsRepository(testEnv.DB).listForEvent(access.event.id))).toHaveLength(1);
      expect((await testEnv.DB.prepare(`
        SELECT count(*) AS count FROM export_parts WHERE export_job_id = ?
      `).bind(job.id).first<number>('count'))).toBe(0);
    },
  );

  it('fails a still-unobservable initial dispatch after replay so its snapshot can be retried', async () => {
    const access = await eventAccess();
    await uploadPending(access, 'initial-workflow-unobservable-replay', null);
    const createdIds: string[] = [];
    const workflow = new Proxy(testEnv.EXPORT_WORKFLOW, {
      get(target, property, receiver) {
        if (property === 'create') return async () => { throw new Error('non-idempotent create used'); };
        if (property === 'createBatch') {
          return async (batch: Array<{ id: string }>) => {
            createdIds.push(batch[0]!.id);
            throw new Error('simulated unobservable Workflow creation');
          };
        }
        if (property === 'get') {
          return async () => { throw new Error('simulated unavailable Workflow lookup'); };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const response = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, { ...testEnv, EXPORT_WORKFLOW: workflow });

    expect(response.status).toBe(202);
    const failed = (await response.json<any>()).data.export;
    expect(failed).toMatchObject({ state: 'failed', attempt: 1 });
    expect(await new ExportsRepository(testEnv.DB).getById(failed.id)).toMatchObject({
      state: 'failed', attempt: 1, errorCode: 'EXPORT_WORKFLOW_DISPATCH_FAILED',
    });
    expect(createdIds).toEqual([failed.id, failed.id]);

    const retried = await createApp().request(
      `/api/manage/events/${access.event.id}/exports/${failed.id}/retry`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      testEnv,
    );
    expect(retried.status).toBe(202);
    expect((await retried.json<any>()).data.export).toMatchObject({
      state: 'queued', attempt: 2,
    });
    expect((await new ExportsRepository(testEnv.DB).listForEvent(access.event.id))).toHaveLength(1);
  });

  it('retries a terminal-before-claim initial job without duplicating its frozen snapshot', async () => {
    const access = await eventAccess();
    await uploadPending(access, 'initial-workflow-terminal-retry', null);
    const workflow = new Proxy(testEnv.EXPORT_WORKFLOW, {
      get(target, property, receiver) {
        if (property === 'create') return async () => { throw new Error('non-idempotent create used'); };
        if (property === 'createBatch') {
          return async () => { throw new Error('simulated terminal initial Workflow'); };
        }
        if (property === 'get') {
          return async (id: string) => ({ id, status: async () => ({ status: 'errored' }) });
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const initial = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, { ...testEnv, EXPORT_WORKFLOW: workflow });
    const failed = (await initial.json<any>()).data.export;
    const frozenBefore = await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM export_media_entries WHERE export_job_id = ?
    `).bind(failed.id).first<number>('count');

    const retry = await createApp().request(
      `/api/manage/events/${access.event.id}/exports/${failed.id}/retry`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      testEnv,
    );

    expect(retry.status).toBe(202);
    expect((await retry.json<any>()).data.export).toMatchObject({ state: 'queued', attempt: 2 });
    expect(await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM export_media_entries WHERE export_job_id = ?
    `).bind(failed.id).first<number>('count')).toBe(frozenBefore);
  });

  it('adopts an initial Workflow whose creation response was lost', async () => {
    const access = await eventAccess();
    await uploadPending(access, 'initial-workflow-response-loss', null);
    const workflow = new Proxy(testEnv.EXPORT_WORKFLOW, {
      get(target, property, receiver) {
        if (property === 'create') return async () => { throw new Error('non-idempotent create used'); };
        if (property === 'createBatch') {
          return async () => { throw new Error('simulated lost initial Workflow response'); };
        }
        if (property === 'get') {
          return async (id: string) => ({ id, status: async () => ({ status: 'queued' }) });
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const response = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, { ...testEnv, EXPORT_WORKFLOW: workflow });

    expect(response.status).toBe(202);
    expect((await response.json<any>()).data.export).toMatchObject({ state: 'queued', attempt: 1 });
  });

  it('does not overwrite an initial job that crossed from pristine queued to running', async () => {
    const access = await eventAccess();
    await uploadPending(access, 'initial-workflow-running-race', null);
    const workflow = new Proxy(testEnv.EXPORT_WORKFLOW, {
      get(target, property, receiver) {
        if (property === 'create') return async () => { throw new Error('non-idempotent create used'); };
        if (property === 'createBatch') {
          return async (batch: Array<{ id: string }>) => {
            const id = batch[0]!.id;
            await testEnv.DB.prepare(`
              UPDATE export_jobs SET state = 'running', started_at = ? WHERE id = ?
            `).bind('2026-08-23T12:00:01.000Z', id).run();
            throw new Error('simulated lost initial Workflow response after claim');
          };
        }
        if (property === 'get') {
          return async (id: string) => ({ id, status: async () => ({ status: 'unknown' }) });
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const response = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, { ...testEnv, EXPORT_WORKFLOW: workflow });

    expect(response.status).toBe(202);
    expect((await response.json<any>()).data.export).toMatchObject({ state: 'running', attempt: 1 });
  });

  it('keeps prior-attempt objects when the retry transition fails before commit', async () => {
    const access = await eventAccess();
    const { job, keys } = await failedExportWithArtifacts(access, 'retry-before-commit');
    const failingDb = new Proxy(testEnv.DB, {
      get(target, property) {
        if (property === 'batch') return async () => { throw new Error('simulated retry failure'); };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const response = await createApp().request(
      `/api/manage/events/${access.event.id}/exports/${job.id}/retry`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      { ...testEnv, DB: failingDb },
    );

    expect(response.status).toBe(500);
    expect(await new ExportsRepository(testEnv.DB).getById(job.id)).toMatchObject({ state: 'failed' });
    for (const key of keys) expect(await testEnv.MEDIA_BUCKET.head(key)).not.toBeNull();
  });

  it('recovers the exact retry transition after its committed D1 response is lost', async () => {
    const access = await eventAccess();
    const { job, keys } = await failedExportWithArtifacts(access, 'retry-response-loss');
    let lost = false;
    const responseLossDb = new Proxy(testEnv.DB, {
      get(target, property) {
        if (property === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            const result = await target.batch(statements);
            if (!lost) {
              lost = true;
              throw new Error('simulated lost retry response');
            }
            return result;
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const response = await createApp().request(
      `/api/manage/events/${access.event.id}/exports/${job.id}/retry`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      { ...testEnv, DB: responseLossDb },
    );

    expect(response.status).toBe(202);
    expect((await response.json<any>()).data.export).toMatchObject({ state: 'queued', attempt: 2 });
    for (const key of keys) expect(await testEnv.MEDIA_BUCKET.head(key)).toBeNull();
  });

  it('recovers a queued retry after Workflow creation fails without deleting prior-attempt objects early', async () => {
    const access = await eventAccess();
    const { job, keys } = await failedExportWithArtifacts(access, 'retry-workflow-failure');
    const workflow = new Proxy(testEnv.EXPORT_WORKFLOW, {
      get(target, property, receiver) {
        if (property === 'createBatch' || property === 'create') {
          return async () => { throw new Error('simulated Workflow creation failure'); };
        }
        if (property === 'get') {
          return async (id: string) => ({
            id,
            status: async () => ({ status: 'unknown' }),
          });
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const response = await createApp().request(
      `/api/manage/events/${access.event.id}/exports/${job.id}/retry`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      { ...testEnv, EXPORT_WORKFLOW: workflow },
    );

    expect(response.status).toBe(500);
    expect(await new ExportsRepository(testEnv.DB).getById(job.id)).toMatchObject({
      state: 'queued', attempt: 2,
    });
    for (const key of keys) expect(await testEnv.MEDIA_BUCKET.head(key)).not.toBeNull();

    const recovered = await createApp().request(
      `/api/manage/events/${access.event.id}/exports/${job.id}/retry`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      testEnv,
    );

    expect(recovered.status).toBe(202);
    expect((await recovered.json<any>()).data.export).toMatchObject({ state: 'queued', attempt: 2 });
    for (const key of keys) expect(await testEnv.MEDIA_BUCKET.head(key)).toBeNull();
  });

  it('adopts the deterministic retry Workflow after its creation response is lost', async () => {
    const access = await eventAccess();
    const { job, keys } = await failedExportWithArtifacts(access, 'retry-workflow-response-loss');
    let created = false;
    const workflow = new Proxy(testEnv.EXPORT_WORKFLOW, {
      get(target, property, receiver) {
        if (property === 'createBatch' || property === 'create') {
          return async () => {
            if (created) throw new Error('simulated duplicate Workflow instance');
            created = true;
            throw new Error('simulated lost Workflow creation response');
          };
        }
        if (property === 'get') {
          return async (id: string) => ({
            id,
            status: async () => ({ status: created ? 'queued' : 'unknown' }),
          });
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const response = await createApp().request(
      `/api/manage/events/${access.event.id}/exports/${job.id}/retry`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      { ...testEnv, EXPORT_WORKFLOW: workflow },
    );
    expect(response.status).toBe(202);
    expect((await response.json<any>()).data.export).toMatchObject({ state: 'queued', attempt: 2 });
    for (const key of keys) expect(await testEnv.MEDIA_BUCKET.head(key)).toBeNull();
  });

  it.each(['errored', 'terminated', 'complete'] as const)(
    'fails a terminal retry Workflow in %s state and advances the next retry',
    async (terminal) => {
      const access = await eventAccess();
      const { job } = await failedExportWithArtifacts(access, `retry-workflow-${terminal}`);
      const createdIds: string[] = [];
      const workflow = new Proxy(testEnv.EXPORT_WORKFLOW, {
        get(target, property, receiver) {
          if (property === 'createBatch') {
            return async (batch: Array<{ id: string }>) => {
              createdIds.push(batch[0]!.id);
              throw new Error(`simulated retained ${terminal} retry Workflow`);
            };
          }
          if (property === 'get') {
            return async (id: string) => ({ id, status: async () => ({ status: terminal }) });
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });

      const response = await createApp().request(
        `/api/manage/events/${access.event.id}/exports/${job.id}/retry`,
        { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
        { ...testEnv, EXPORT_WORKFLOW: workflow },
      );

      expect(response.status).toBe(202);
      const failed = (await response.json<any>()).data.export;
      expect(createdIds).toEqual([`${job.id}-2`]);
      expect(failed).toMatchObject({
        id: job.id,
        state: 'failed',
        attempt: 2,
      });
      expect(await new ExportsRepository(testEnv.DB).getById(job.id)).toMatchObject({
        state: 'failed',
        attempt: 2,
        errorCode: 'EXPORT_WORKFLOW_DISPATCH_FAILED',
      });
      expect(await testEnv.DB.prepare(`
        SELECT count(*) AS count FROM export_parts WHERE export_job_id = ?
      `).bind(job.id).first<number>('count')).toBe(0);

      const next = await createApp().request(
        `/api/manage/events/${access.event.id}/exports/${job.id}/retry`,
        { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
        testEnv,
      );
      expect(next.status).toBe(202);
      expect((await next.json<any>()).data.export).toMatchObject({
        state: 'queued',
        attempt: 3,
      });
    },
  );

  it('keeps the running attempt when the retry claim wins the terminal dispatch failure fence', async () => {
    const access = await eventAccess();
    const { job } = await failedExportWithArtifacts(access, 'retry-workflow-claim-race');
    const workflow = new Proxy(testEnv.EXPORT_WORKFLOW, {
      get(target, property, receiver) {
        if (property === 'createBatch') {
          return async () => { throw new Error('simulated lost retry Workflow response'); };
        }
        if (property === 'get') {
          return async (id: string) => ({
            id,
            status: async () => {
              await testEnv.DB.prepare(`
                UPDATE export_jobs SET state = 'running', started_at = ?2
                WHERE id = ?1 AND state = 'queued' AND attempt = 2
              `).bind(job.id, '2026-08-23T12:00:01.000Z').run();
              return { status: 'errored' };
            },
          });
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const response = await createApp().request(
      `/api/manage/events/${access.event.id}/exports/${job.id}/retry`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      { ...testEnv, EXPORT_WORKFLOW: workflow },
    );

    expect(response.status).toBe(202);
    expect((await response.json<any>()).data.export).toMatchObject({
      id: job.id,
      state: 'running',
      attempt: 2,
    });
    expect(await new ExportsRepository(testEnv.DB).getById(job.id)).toMatchObject({
      state: 'running',
      attempt: 2,
      errorCode: null,
    });
  });

  it('converges concurrent failed-job retries on one deterministic next attempt', async () => {
    const access = await eventAccess();
    const { job, keys } = await failedExportWithArtifacts(access, 'retry-concurrent');
    let waiting = 0;
    let release!: () => void;
    const bothAtTransition = new Promise<void>((resolve) => { release = resolve; });
    const synchronizedDb = new Proxy(testEnv.DB, {
      get(target, property) {
        if (property === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            waiting += 1;
            if (waiting === 2) release();
            await bothAtTransition;
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const env = { ...testEnv, DB: synchronizedDb };
    const request = () => createApp().request(
      `/api/manage/events/${access.event.id}/exports/${job.id}/retry`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      env,
    );

    const responses = await Promise.all([request(), request()]);

    expect(responses.map(({ status }) => status)).toEqual([202, 202]);
    expect(await Promise.all(responses.map(async (response) => (
      (await response.json<any>()).data.export.attempt
    )))).toEqual([2, 2]);
    expect(await new ExportsRepository(testEnv.DB).getById(job.id)).toMatchObject({
      state: 'queued', attempt: 2,
    });
    for (const key of keys) expect(await testEnv.MEDIA_BUCKET.head(key)).toBeNull();
  });

  it('builds part bytes and source-size inventory from the immutable finalized object, not a replayed upload key', async () => {
    const access = await eventAccess();
    const original = png(1600, 900, 64);
    const initiated = await createApp().request(`/api/event/${access.event.slug}/uploads`, {
      method: 'POST', headers: writeHeaders(access.guest),
      body: JSON.stringify({
        filename: 'immutable-export.png', mimeType: 'image/png', byteSize: original.byteLength,
        idempotencyKey: 'immutable-export', guestName: 'Avery', caption: null,
      }),
    }, testEnv);
    const reserved = (await initiated.json<any>()).data.media;
    const finalized = await createApp().request(
      `/api/event/${access.event.slug}/uploads/${reserved.id}/content`,
      {
        method: 'PUT',
        headers: {
          ...writeHeaders(access.guest),
          'content-type': 'image/png',
          'content-length': String(original.byteLength),
        },
        body: original.buffer.slice(
          original.byteOffset,
          original.byteOffset + original.byteLength,
        ) as ArrayBuffer,
      },
      testEnv,
    );
    expect(finalized.status).toBe(200);
    const stored = (await finalized.json<any>()).data.media;
    expect(stored.objectKey).not.toBe(reserved.objectKey);

    const created = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const job = (await created.json<any>()).data.export;
    await testEnv.MEDIA_BUCKET.put(reserved.objectKey, png(320, 240, 96), {
      httpMetadata: { contentType: 'image/png' },
    });
    const ready = await processExport(testEnv, job.id, new Date());
    const parts = await new ExportsRepository(testEnv.DB).listParts(job.id);
    const archiveObject = await testEnv.MEDIA_BUCKET.get(parts[0]!.objectKey);
    const archive = unzipSync(new Uint8Array(await archiveObject!.arrayBuffer()));
    const photo = archive['photos/001-immutable-export.png'];

    expect(ready?.state).toBe('ready');
    expect(parts).toHaveLength(1);
    expect(parts[0]!.sourceBytes).toBe(original.byteLength);
    expect(photo).toEqual(original);
    expect(photo?.byteLength).toBe(parts[0]!.sourceBytes);
  });

  it('preserves frozen album order across parts and retries without live album or favorite reads', async () => {
    const access = await eventAccess();
    const first = await uploadPending(access, 'album-ordered-first', 'First by timeline');
    const second = await uploadPending(access, 'album-ordered-second', 'Second by timeline');
    const third = await uploadPending(access, 'album-ordered-third', 'Placed first');
    await testEnv.DB.batch([
      testEnv.DB.prepare('UPDATE media SET timeline_at = ? WHERE id = ?')
        .bind('2026-08-23T10:00:00.000Z', first.id),
      testEnv.DB.prepare('UPDATE media SET timeline_at = ? WHERE id = ?')
        .bind('2026-08-23T11:00:00.000Z', second.id),
      testEnv.DB.prepare('UPDATE media SET timeline_at = ? WHERE id = ?')
        .bind('2026-08-23T12:00:00.000Z', third.id),
    ]);
    await setAlbumSnapshotSource(access, [first.id, second.id, third.id], JSON.stringify([
      { kind: 'section', id: 'section-a', heading: 'Placed photos' },
      { kind: 'photo', mediaId: third.id },
      { kind: 'photo', mediaId: first.id },
    ]));
    const created = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: JSON.stringify({ kind: 'album' }),
    }, testEnv);
    expect(created.status).toBe(202);
    const job = (await created.json<any>()).data.export;
    expect(job).toMatchObject({ kind: 'album', mediaCount: 3 });

    // Every live source changes before the Workflow reads. An implementation that re-opens
    // event_albums or favorited_at will now export only the wrong photo in the wrong order.
    await setAlbumSnapshotSource(
      access,
      [second.id],
      JSON.stringify([{ kind: 'photo', mediaId: second.id }]),
    );
    const runAt = new Date();
    const ready = await processExport(testEnv, job.id, runAt, 100);
    expect(ready).toMatchObject({
      kind: 'album', state: 'ready', partCount: 3,
      guestbookHtmlObjectKey: null, guestbookCsvObjectKey: null,
      guestbookEntryCount: null,
    });
    expect(Date.parse(ready!.expiresAt!) - runAt.getTime()).toBe(86_400_000);
    const repository = new ExportsRepository(testEnv.DB);
    const firstParts = await repository.listParts(job.id);
    const archivedNames: string[] = [];
    for (const part of firstParts) {
      const object = await testEnv.MEDIA_BUCKET.get(part.objectKey);
      const archive = unzipSync(new Uint8Array(await object!.arrayBuffer()));
      archivedNames.push(Object.keys(archive).find((name) => name.startsWith('photos/'))!);
    }
    expect(archivedNames).toEqual([
      'photos/001-album-ordered-third.png',
      'photos/001-album-ordered-first.png',
      'photos/001-album-ordered-second.png',
    ]);
    const firstManifest = await (await testEnv.MEDIA_BUCKET.get(ready!.manifestObjectKey!))!.text();
    expect([...firstManifest.matchAll(/,(album-ordered-(?:third|first|second)\.png),/gu)]
      .map((match) => match[1])).toEqual([
      'album-ordered-third.png', 'album-ordered-first.png', 'album-ordered-second.png',
    ]);

    const download = await createApp().request(
      `/api/manage/events/${access.event.id}/exports/${job.id}/download`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      testEnv,
    );
    expect(download.status).toBe(200);
    const descriptors = (await download.json<any>()).data;
    expect(descriptors).toMatchObject({ printableGuestbook: null, privateGuestbook: null });
    expect(descriptors.parts).toHaveLength(3);
    const range = await createApp().request(descriptors.parts[1].url, {
      headers: { cookie: access.manager.cookie, range: 'bytes=0-7' },
    }, testEnv);
    expect(range.status).toBe(206);
    expect((await range.arrayBuffer()).byteLength).toBe(8);

    await testEnv.DB.prepare("UPDATE export_jobs SET state = 'failed' WHERE id = ?")
      .bind(job.id).run();
    const retried = await createApp().request(
      `/api/manage/events/${access.event.id}/exports/${job.id}/retry`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      testEnv,
    );
    expect(retried.status).toBe(202);
    await setAlbumSnapshotSource(
      access,
      [first.id, third.id],
      JSON.stringify([{ kind: 'photo', mediaId: first.id }]),
    );
    const retryReady = await processExport(testEnv, job.id, new Date(), 100);
    const retryManifest = await (await testEnv.MEDIA_BUCKET.get(retryReady!.manifestObjectKey!))!.text();
    expect(retryManifest).toBe(firstManifest);
    expect(retryReady).toMatchObject({
      kind: 'album', attempt: 2, guestbookHtmlObjectKey: null, guestbookCsvObjectKey: null,
    });
  });

  it('enforces one queued or running export across kinds and refuses a conflicting retry cleanly', async () => {
    const access = await eventAccess();
    const picked = await uploadPending(access, 'album-active-conflict', null);
    await setAlbumSnapshotSource(
      access,
      [picked.id],
      JSON.stringify([{ kind: 'photo', mediaId: picked.id }]),
    );
    const album = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: JSON.stringify({ kind: 'album' }),
    }, testEnv);
    expect(album.status).toBe(202);
    const albumJob = (await album.json<any>()).data.export;
    const completeConflict = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    expect(completeConflict.status).toBe(409);
    expect((await completeConflict.json<any>()).code).toBe('EXPORT_ALREADY_ACTIVE');

    await new ExportsRepository(testEnv.DB).markFailed(albumJob.id, 'EXPORT_TEST_FAILURE');
    const complete = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    expect(complete.status).toBe(202);
    expect((await complete.json<any>()).data.export.kind).toBe('complete');

    const retryConflict = await createApp().request(
      `/api/manage/events/${access.event.id}/exports/${albumJob.id}/retry`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      testEnv,
    );
    expect(retryConflict.status).toBe(409);
    expect((await retryConflict.json<any>()).code).toBe('EXPORT_ALREADY_ACTIVE');
    expect(await new ExportsRepository(testEnv.DB).getById(albumJob.id)).toMatchObject({
      kind: 'album', state: 'failed', attempt: 1,
    });
  });

  it('keeps the cross-kind create conflict cause when the winner turns terminal after the batch', async () => {
    const access = await eventAccess();
    const picked = await uploadPending(access, 'album-create-conflict-race', null);
    await setAlbumSnapshotSource(access, [picked.id], '[]');
    const repository = new ExportsRepository(testEnv.DB);
    const boundary = '2026-08-23T12:00:00.000Z';
    const winner = await repository.createActive({
      id: 'complete-create-winner', eventId: access.event.id, snapshotAt: boundary,
      mediaCount: 0, totalBytes: 0, createdAt: boundary,
    });
    let transitioned = false;
    const terminalAfterBatch = new Proxy(testEnv.DB, {
      get(target, property) {
        if (property === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            const results = await target.batch(statements);
            if (!transitioned) {
              transitioned = true;
              await target.prepare(`UPDATE export_jobs SET state = 'failed' WHERE id = ?`)
                .bind(winner.id).run();
            }
            return results;
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await expect(new ExportsRepository(terminalAfterBatch).createAlbumActive({
      id: 'album-create-loser', eventId: access.event.id, snapshotAt: boundary, createdAt: boundary,
    })).rejects.toMatchObject({
      code: 'EXPORT_ALREADY_ACTIVE',
      message: 'An export is already being prepared for this event.',
    });
  });

  it('keeps the cross-kind retry conflict cause when the winner turns terminal after the batch', async () => {
    const access = await eventAccess();
    const picked = await uploadPending(access, 'album-retry-conflict-race', null);
    await setAlbumSnapshotSource(access, [picked.id], '[]');
    const repository = new ExportsRepository(testEnv.DB);
    const boundary = '2026-08-23T12:00:00.000Z';
    const candidate = await repository.createAlbumActive({
      id: 'album-retry-candidate', eventId: access.event.id, snapshotAt: boundary, createdAt: boundary,
    });
    await repository.markFailed(candidate.id, 'EXPORT_TEST_FAILURE');
    const winner = await repository.createActive({
      id: 'complete-retry-winner', eventId: access.event.id, snapshotAt: boundary,
      mediaCount: 0, totalBytes: 0, createdAt: boundary,
    });
    let transitioned = false;
    const terminalAfterBatch = new Proxy(testEnv.DB, {
      get(target, property) {
        if (property === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            const results = await target.batch(statements);
            if (!transitioned) {
              transitioned = true;
              await target.prepare(`UPDATE export_jobs SET state = 'failed' WHERE id = ?`)
                .bind(winner.id).run();
            }
            return results;
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await expect(new ExportsRepository(terminalAfterBatch).retry(candidate.id)).rejects.toMatchObject({
      code: 'EXPORT_ALREADY_ACTIVE',
      message: 'An export is already being prepared for this event.',
    });
  });

  it('returns only the Manager export allowlist from create, get, list, and retry', async () => {
    const access = await eventAccess();
    await uploadPending(access, 'safe-manager-export', 'Visible caption');
    const app = createApp();
    const created = await app.request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const createdJob = (await created.json<any>()).data.export;
    expectManagerExport(createdJob);
    expect(createdJob.kind).toBe('complete');

    const fetched = await app.request(
      `/api/manage/events/${access.event.id}/exports/${createdJob.id}`,
      { headers: { cookie: access.manager.cookie } },
      testEnv,
    );
    expectManagerExport((await fetched.json<any>()).data.export);

    const listed = await app.request(`/api/manage/events/${access.event.id}/exports`, {
      headers: { cookie: access.manager.cookie },
    }, testEnv);
    const listedJobs = (await listed.json<any>()).data.exports;
    expect(listedJobs).toHaveLength(1);
    expectManagerExport(listedJobs[0]);

    await new ExportsRepository(testEnv.DB).markFailed(createdJob.id, 'EXPORT_SOURCE_MISSING');
    const retried = await app.request(
      `/api/manage/events/${access.event.id}/exports/${createdJob.id}/retry`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      testEnv,
    );
    expect(retried.status).toBe(202);
    expectManagerExport((await retried.json<any>()).data.export);
  });

  it('cleans every object from repeated failed attempts and keeps deterministic prefixes', async () => {
    const access = await eventAccess();
    await uploadPending(access, 'failure-cleanup-a', null);
    const missing = await uploadPending(access, 'failure-cleanup-b', null);
    const created = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const job = (await created.json<any>()).data.export;
    expect((await testEnv.DB.prepare(`
      SELECT media_id, original_filename FROM export_media_entries
      WHERE export_job_id = ? ORDER BY created_at, media_id
    `).bind(job.id).all()).results).toHaveLength(2);
    await testEnv.CANONICAL_MEDIA_BUCKET.delete(missing.objectKey);

    const firstFailure = await processExport(testEnv, job.id, new Date(), 100);
    expect(firstFailure).toMatchObject({ state: 'failed', errorCode: 'EXPORT_SOURCE_MISSING' });
    expect((await testEnv.MEDIA_BUCKET.list({
      prefix: `events/${access.event.id}/exports/${job.id}/attempt-1/`,
    })).objects).toEqual([]);
    const retry = await createApp().request(`/api/manage/events/${access.event.id}/exports/${job.id}/retry`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    expect((await retry.json<any>()).data.export.attempt).toBe(2);
    const secondFailure = await processExport(testEnv, job.id, new Date(), 100);
    expect(secondFailure).toMatchObject({ state: 'failed', attempt: 2, errorCode: 'EXPORT_SOURCE_MISSING' });
    expect((await testEnv.MEDIA_BUCKET.list({
      prefix: `events/${access.event.id}/exports/${job.id}/attempt-2/`,
    })).objects).toEqual([]);
  });

  it('lets the same serialized Workflow owner resume a Running attempt', async () => {
    const access = await eventAccess();
    await uploadPending(access, 'same-owner-retry', null);
    const created = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const job = (await created.json<any>()).data.export;
    const repository = new ExportsRepository(testEnv.DB);
    const claimStartedAt = '2026-08-12T12:00:00.000Z';
    expect(await repository.claimRunning(job.id, claimStartedAt)).toMatchObject({ owned: true });
    const attemptPrefix = `events/${access.event.id}/exports/${job.id}/attempt-1/`;
    const staleObjectKey = `${attemptPrefix}orphaned-before-step-retry`;
    await testEnv.MEDIA_BUCKET.put(staleObjectKey, 'stale');
    const failingCleanupBucket = new Proxy(testEnv.MEDIA_BUCKET, {
      get(target, property) {
        if (property === 'delete') {
          return async () => {
            throw new Error('attempt cleanup unavailable');
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await expect(processExport(
      { ...testEnv, MEDIA_BUCKET: failingCleanupBucket },
      job.id,
      new Date('2026-08-12T12:00:30.000Z'),
      undefined,
      claimStartedAt,
    )).rejects.toThrow('attempt cleanup unavailable');
    expect(await repository.getById(job.id)).toMatchObject({
      state: 'running', startedAt: claimStartedAt,
    });

    const resumed = await processExport(
      testEnv,
      job.id,
      new Date('2026-08-12T12:01:00.000Z'),
      undefined,
      claimStartedAt,
    );

    expect(resumed).toMatchObject({ state: 'ready', startedAt: claimStartedAt });
    expect(await testEnv.MEDIA_BUCKET.get(staleObjectKey)).toBeNull();
  });

  it('lets only the distinct queued-to-running transition owner process one attempt', async () => {
    const access = await eventAccess();
    const snapshotAt = new Date().toISOString();
    const repository = new ExportsRepository(testEnv.DB);
    const job = await repository.createActive({
      id: crypto.randomUUID(), eventId: access.event.id, snapshotAt,
      mediaCount: 1, totalBytes: 64, createdAt: snapshotAt,
    });
    const ownerStartedAt = '2026-08-12T12:00:00.000Z';
    expect(await repository.claimRunning(job.id, ownerStartedAt)).toMatchObject({ owned: true });

    const duplicate = await processExport(
      testEnv,
      job.id,
      new Date('2026-08-12T12:01:00.000Z'),
      undefined,
      '2026-08-12T12:00:01.000Z',
    );

    expect(duplicate).toMatchObject({ state: 'running', startedAt: ownerStartedAt });
    expect(await repository.getById(job.id)).toMatchObject({
      state: 'running', startedAt: ownerStartedAt, errorCode: null,
    });
    expect((await testEnv.MEDIA_BUCKET.list({
      prefix: `events/${access.event.id}/exports/${job.id}/`,
    })).objects).toEqual([]);
  });

  it('returns an already-Ready job without trying to claim or process it again', async () => {
    const access = await eventAccess();
    await uploadPending(access, 'already-ready', null);
    const created = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const job = (await created.json<any>()).data.export;
    const ready = await processExport(testEnv, job.id, new Date());
    const returned = await processExport(testEnv, job.id, new Date(Date.now() + 60_000));

    expect(returned).toEqual(ready);
  });

  it('keeps committed export objects when the markReady response is lost', async () => {
    const access = await eventAccess();
    await uploadPending(access, 'ready-response-loss', null);
    const created = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const job = (await created.json<any>()).data.export;
    const responseLossDb = new Proxy(testEnv.DB, {
      get(target, property) {
        if (property === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            await target.batch(statements);
            throw new Error('simulated lost markReady response');
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const ready = await processExport(
      { ...testEnv, DB: responseLossDb },
      job.id,
      new Date('2026-08-12T12:00:00.000Z'),
    );
    const repository = new ExportsRepository(testEnv.DB);
    const parts = await repository.listParts(job.id);
    const keys = [
      ready!.manifestObjectKey,
      ...parts.map(({ objectKey }) => objectKey),
      ready!.guestbookHtmlObjectKey,
      ready!.guestbookCsvObjectKey,
    ].filter((key): key is string => Boolean(key));

    expect(ready).toMatchObject({ state: 'ready', partCount: 1 });
    expect(keys).toHaveLength(4);
    for (const key of keys) expect(await testEnv.MEDIA_BUCKET.head(key)).not.toBeNull();
  });

  it('does not mutate winner parts when markReady loses the running-state transition', async () => {
    const access = await eventAccess();
    const snapshotAt = new Date().toISOString();
    const repository = new ExportsRepository(testEnv.DB);
    const job = await repository.createActive({
      id: crypto.randomUUID(), eventId: access.event.id, snapshotAt,
      mediaCount: 1, totalBytes: 64, createdAt: snapshotAt,
    });
    await testEnv.DB.prepare(`
      UPDATE export_jobs SET state = 'running', started_at = ? WHERE id = ?
    `).bind(snapshotAt, job.id).run();

    let interleaved = false;
    const interleavingDb = new Proxy(testEnv.DB, {
      get(target, property) {
        if (property === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            if (!interleaved) {
              interleaved = true;
              await testEnv.DB.batch([
                testEnv.DB.prepare(`
                  UPDATE export_jobs SET state = 'ready', manifest_object_key = 'winner-manifest',
                    part_count = 1, completed_at = ?, expires_at = ?, error_code = NULL
                  WHERE id = ? AND state = 'running'
                `).bind(snapshotAt, new Date(Date.now() + 60_000).toISOString(), job.id),
                testEnv.DB.prepare(`
                  INSERT INTO export_parts (
                    id, export_job_id, part_number, object_key, media_count, source_bytes, created_at
                  ) VALUES ('winner-part-id', ?, 1, 'winner-part', 1, 64, ?)
                `).bind(job.id, snapshotAt),
              ]);
            }
            return testEnv.DB.batch(statements);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const staleRepository = new ExportsRepository(interleavingDb);

    await expect(staleRepository.markReady(job.id, {
      manifestObjectKey: 'stale-manifest',
      parts: [{ partNumber: 1, objectKey: 'stale-part', mediaCount: 1, sourceBytes: 64 }],
      guestbook: null,
    }, snapshotAt, new Date(Date.now() + 120_000).toISOString()))
      .rejects.toThrow('Export job was not running.');

    expect(await repository.getById(job.id)).toMatchObject({
      state: 'ready', manifestObjectKey: 'winner-manifest', partCount: 1,
    });
    expect(await repository.listParts(job.id)).toMatchObject([{
      id: 'winner-part-id', partNumber: 1, objectKey: 'winner-part',
    }]);
  });

  it('exports the immutable photo membership even when the live media row is later deleted', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'count-drift', 'Frozen caption');
    const created = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const job = (await created.json<any>()).data.export;
    await testEnv.DB.prepare(`UPDATE media SET deleted_at = ? WHERE id = ?`)
      .bind(new Date().toISOString(), media.id).run();
    const ready = await processExport(testEnv, job.id, new Date());
    expect(ready).toMatchObject({ state: 'ready', mediaCount: 1 });
    const manifest = await (await testEnv.MEDIA_BUCKET.get(ready!.manifestObjectKey!))!.text();
    expect(manifest).toContain(media.id);
  });

  it('never substitutes a reservation finalized after snapshot for a deleted frozen photo', async () => {
    const access = await eventAccess();
    const frozen = await uploadPending(access, 'frozen-member', 'Frozen member caption');
    const replacementBytes = png();
    const initiated = await createApp().request(`/api/event/${access.event.slug}/uploads`, {
      method: 'POST', headers: writeHeaders(access.guest),
      body: JSON.stringify({
        filename: 'replacement-member.png', mimeType: 'image/png',
        byteSize: replacementBytes.byteLength,
        idempotencyKey: 'replacement-member', guestName: 'Avery', caption: null,
      }),
    }, testEnv);
    expect(initiated.status).toBe(201);
    const replacement = (await initiated.json<any>()).data.media;
    const created = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const job = (await created.json<any>()).data.export;
    await testEnv.DB.prepare(`UPDATE media SET deleted_at = ? WHERE id = ?`)
      .bind(new Date().toISOString(), frozen.id).run();
    const finalized = await createApp().request(
      `/api/event/${access.event.slug}/uploads/${replacement.id}/content`,
      {
        method: 'PUT',
        headers: {
          ...writeHeaders(access.guest),
          'content-type': 'image/png',
          'content-length': String(replacementBytes.byteLength),
        },
        body: replacementBytes.buffer.slice(
          replacementBytes.byteOffset,
          replacementBytes.byteOffset + replacementBytes.byteLength,
        ) as ArrayBuffer,
      },
      testEnv,
    );
    expect(finalized.status).toBe(200);

    const ready = await processExport(testEnv, job.id, new Date());
    expect(ready).toMatchObject({ state: 'ready', mediaCount: 1, guestbookEntryCount: 1 });
    const csv = await (await testEnv.MEDIA_BUCKET.get(ready!.guestbookCsvObjectKey!))!.text();
    expect(csv).toContain(`photo_caption,${frozen.id}`);
    expect(csv).toContain(`,${frozen.id},1,photos/001-frozen-member.png\r\n`);
    const manifest = await (await testEnv.MEDIA_BUCKET.get(ready!.manifestObjectKey!))!.text();
    expect(manifest).toContain(frozen.id);
    expect(manifest).not.toContain(replacement.id);

    await testEnv.DB.prepare(`UPDATE export_jobs SET state = 'failed' WHERE id = ?`)
      .bind(job.id).run();
    const retried = await createApp().request(
      `/api/manage/events/${access.event.id}/exports/${job.id}/retry`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      testEnv,
    );
    expect(retried.status).toBe(202);
    const retryReady = await processExport(testEnv, job.id, new Date());
    const retryManifest = await (await testEnv.MEDIA_BUCKET.get(retryReady!.manifestObjectKey!))!.text();
    const retryCsv = await (await testEnv.MEDIA_BUCKET.get(retryReady!.guestbookCsvObjectKey!))!.text();
    expect(retryManifest).toBe(manifest);
    expect(retryCsv).toBe(csv);
  });

  it('refuses retry before deleting ready inventory and resets all six Guestbook fields after durable deletion', async () => {
    const access = await eventAccess();
    await uploadPending(access, 'retry-inventory', null);
    const created = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const job = (await created.json<any>()).data.export;
    const ready = await processExport(testEnv, job.id, new Date());
    const repository = new ExportsRepository(testEnv.DB);
    const parts = await repository.listParts(job.id);
    const frozenRows = await testEnv.DB.prepare(`
      SELECT source, source_id, body FROM export_guestbook_entries WHERE export_job_id = ?
    `).bind(job.id).all();
    const keys = [
      ready!.manifestObjectKey,
      ...parts.map(({ objectKey }) => objectKey),
      ready!.guestbookHtmlObjectKey,
      ready!.guestbookCsvObjectKey,
    ]
      .filter((key): key is string => Boolean(key));
    const readyRetry = await createApp().request(`/api/manage/events/${access.event.id}/exports/${job.id}/retry`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    expect(readyRetry.status).toBe(409);
    for (const key of keys) expect(await testEnv.MEDIA_BUCKET.head(key)).not.toBeNull();

    await testEnv.DB.prepare(`UPDATE export_jobs SET state = 'failed' WHERE id = ?`).bind(job.id).run();
    const retry = await createApp().request(`/api/manage/events/${access.event.id}/exports/${job.id}/retry`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    expect(retry.status).toBe(202);
    for (const key of keys) expect(await testEnv.MEDIA_BUCKET.head(key)).toBeNull();
    expect((await new ExportsRepository(testEnv.DB).getById(job.id))).toMatchObject({
      state: 'queued', attempt: 2,
      guestbookHtmlObjectKey: null, guestbookHtmlBytes: null, guestbookHtmlSha256: null,
      guestbookCsvObjectKey: null, guestbookCsvBytes: null, guestbookCsvSha256: null,
      guestbookEntryCount: ready!.guestbookEntryCount,
      guestbookPrompt: ready!.guestbookPrompt,
    });
    expect((await testEnv.DB.prepare(`
      SELECT source, source_id, body FROM export_guestbook_entries WHERE export_job_id = ?
    `).bind(job.id).all()).results).toEqual(frozenRows.results);
  });

  it('keeps private-only entries out of printable HTML and in the private archive', async () => {
    const access = await eventAccess();
    const sessionId = await testEnv.DB.prepare(`
      SELECT id FROM event_sessions WHERE event_id = ? AND role = 'guest' LIMIT 1
    `).bind(access.event.id).first<string>('id');
    await testEnv.DB.prepare(`
      INSERT INTO guest_messages (
        id, event_id, guest_session_id, guest_name, body, moderation_status,
        idempotency_key, created_at, approved_at, deleted_at
      ) VALUES ('private-note', ?, ?, 'Taylor', 'For the hosts only', 'pending',
        'private-note-key', '2026-08-12T12:00:00.000Z', NULL, NULL)
    `).bind(access.event.id, sessionId).run();
    const created = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const job = (await created.json<any>()).data.export;
    const ready = await processExport(testEnv, job.id, new Date());
    expect(ready).toMatchObject({ guestbookEntryCount: 1, guestbookSharedCount: 0 });
    expect(await (await testEnv.MEDIA_BUCKET.get(ready!.guestbookHtmlObjectKey!))!.text())
      .toContain('No guestbook entries were shared at this snapshot.');
    expect(await (await testEnv.MEDIA_BUCKET.get(ready!.guestbookHtmlObjectKey!))!.text())
      .not.toContain('For the hosts only');
    expect(await (await testEnv.MEDIA_BUCKET.get(ready!.guestbookCsvObjectKey!))!.text())
      .toContain('pending,author_only');
  });

  it('refuses partial Ready inventory and partial signed-download inventory', async () => {
    const access = await eventAccess();
    await uploadPending(access, 'partial-inventory', null);
    const created = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const job = (await created.json<any>()).data.export;
    const repository = new ExportsRepository(testEnv.DB);
    await repository.claimRunning(job.id, new Date().toISOString());
    await expect(repository.markReady(job.id, {
      manifestObjectKey: null,
      parts: [],
      guestbook: {
        htmlObjectKey: 'html', htmlBytes: 1, htmlSha256: 'a'.repeat(64),
        csvObjectKey: 'csv', csvBytes: 1, csvSha256: 'b'.repeat(64),
      },
    }, new Date().toISOString(), new Date(Date.now() + 60_000).toISOString()))
      .rejects.toThrow('requires a manifest and parts');

    await testEnv.DB.prepare(`UPDATE export_jobs SET state = 'queued' WHERE id = ?`).bind(job.id).run();
    const ready = await processExport(testEnv, job.id, new Date());
    await testEnv.DB.prepare(`UPDATE export_jobs SET guestbook_csv_sha256 = NULL WHERE id = ?`)
      .bind(job.id).run();
    const download = await createApp().request(
      `/api/manage/events/${access.event.id}/exports/${ready!.id}/download`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      testEnv,
    );
    expect(download.status).toBe(409);
    expect((await download.json<any>()).code).toBe('EXPORT_FAILED');

    const notesAccess = await eventAccess();
    const sessionId = await testEnv.DB.prepare(`
      SELECT id FROM event_sessions WHERE event_id = ? AND role = 'guest' LIMIT 1
    `).bind(notesAccess.event.id).first<string>('id');
    await testEnv.DB.prepare(`
      INSERT INTO guest_messages (
        id, event_id, guest_session_id, guest_name, body, moderation_status,
        idempotency_key, created_at, approved_at, deleted_at
      ) VALUES ('partial-note', ?, ?, NULL, 'Partial note', 'pending',
        'partial-note-key', '2026-08-12T12:00:00.000Z', NULL, NULL)
    `).bind(notesAccess.event.id, sessionId).run();
    const notesCreated = await createApp().request(`/api/manage/events/${notesAccess.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(notesAccess.manager), body: '{}',
    }, testEnv);
    const notesJob = (await notesCreated.json<any>()).data.export;
    await repository.claimRunning(notesJob.id, new Date().toISOString());
    await expect(repository.markReady(notesJob.id, {
      manifestObjectKey: null, parts: [], guestbook: null,
    }, new Date().toISOString(), new Date(Date.now() + 60_000).toISOString()))
      .rejects.toThrow('requires complete Guestbook inventory');
    await expect(repository.markReady(notesJob.id, {
      manifestObjectKey: 'unexpected-manifest',
      parts: [],
      guestbook: {
        htmlObjectKey: 'html', htmlBytes: 1, htmlSha256: 'a'.repeat(64),
        csvObjectKey: 'csv', csvBytes: 1, csvSha256: 'b'.repeat(64),
      },
    }, new Date().toISOString(), new Date(Date.now() + 60_000).toISOString()))
      .rejects.toThrow('cannot contain photo inventory');
  });

  it('rejects every Guestbook field at album readiness and blocks direct Guestbook artifact routes', async () => {
    const access = await eventAccess();
    const picked = await uploadPending(access, 'album-guestbook-fields', null);
    await setAlbumSnapshotSource(access, [picked.id], '[]');
    const repository = new ExportsRepository(testEnv.DB);
    const boundary = '2026-08-23T12:00:00.000Z';
    const job = await repository.createAlbumActive({
      id: crypto.randomUUID(), eventId: access.event.id, snapshotAt: boundary, createdAt: boundary,
    });
    await repository.claimRunning(job.id, '2026-08-23T12:00:01.000Z');
    const inventory = {
      manifestObjectKey: `events/${access.event.id}/exports/${job.id}/attempt-1/candidary-export-manifest.csv`,
      parts: [{
        partNumber: 1,
        objectKey: `events/${access.event.id}/exports/${job.id}/attempt-1/photos-001.zip`,
        mediaCount: 1,
        sourceBytes: 64,
      }],
      guestbook: null,
    };
    const guestbookFields: Array<[string, string | number]> = [
      ['guestbook_entry_count', 1],
      ['guestbook_shared_count', 1],
      ['guestbook_event_name', 'Maya & Theo'],
      ['guestbook_event_date', '2026-09-19'],
      ['guestbook_event_timezone', 'America/Chicago'],
      ['guestbook_prompt', 'Share a memory'],
      ['guestbook_gallery_visible', 1],
      ['guestbook_html_object_key', 'guestbook.html'],
      ['guestbook_html_bytes', 1],
      ['guestbook_html_sha256', 'a'.repeat(64)],
      ['guestbook_csv_object_key', 'guestbook.csv'],
      ['guestbook_csv_bytes', 1],
      ['guestbook_csv_sha256', 'b'.repeat(64)],
    ];
    for (const [column, value] of guestbookFields) {
      await testEnv.DB.prepare(`UPDATE export_jobs SET ${column} = ? WHERE id = ?`)
        .bind(value, job.id).run();
      await expect(repository.markReady(
        job.id,
        inventory,
        '2026-08-23T12:00:02.000Z',
        '2026-08-24T12:00:02.000Z',
      )).rejects.toThrow('An album export cannot contain Guestbook data.');
      await testEnv.DB.prepare(`UPDATE export_jobs SET ${column} = NULL WHERE id = ?`)
        .bind(job.id).run();
    }

    await repository.markReady(
      job.id,
      inventory,
      '2026-08-23T12:00:02.000Z',
      '2026-08-24T12:00:02.000Z',
    );
    await testEnv.DB.prepare(`
      UPDATE export_jobs SET guestbook_html_object_key = 'forged-guestbook.html' WHERE id = ?
    `).bind(job.id).run();
    const direct = await createApp().request(
      `/api/manage/events/${access.event.id}/exports/${job.id}/artifact/printable-guestbook`,
      { headers: { cookie: access.manager.cookie } },
      testEnv,
    );
    expect(direct.status).toBe(404);
    expect(await direct.json<any>()).toMatchObject({ code: 'EXPORT_FAILED' });
  });

  it('keeps legacy photo-only rows downloadable with null Guestbook descriptors', async () => {
    const access = await eventAccess();
    await uploadPending(access, 'legacy-download', null);
    const snapshotAt = new Date().toISOString();
    const repository = new ExportsRepository(testEnv.DB);
    const legacy = await repository.createActive({
      id: crypto.randomUUID(), eventId: access.event.id, snapshotAt,
      mediaCount: 1, totalBytes: 64, createdAt: snapshotAt,
    });
    expect(legacy).toMatchObject({
      guestbookEntryCount: null,
      guestbookHtmlObjectKey: null,
      guestbookCsvObjectKey: null,
    });
    const ready = await processExport(testEnv, legacy.id, new Date());
    expect(ready).toMatchObject({ state: 'ready', guestbookEntryCount: null });
    const response = await createApp().request(
      `/api/manage/events/${access.event.id}/exports/${legacy.id}/download`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      testEnv,
    );
    expect(response.status).toBe(200);
    expect((await response.json<any>()).data).toMatchObject({
      printableGuestbook: null,
      privateGuestbook: null,
    });
  });

  it('uses a domain refusal when an export belongs to another event', async () => {
    const first = await eventAccess();
    const second = await eventAccess();
    const job = await new ExportsRepository(testEnv.DB).createActive({
      id: crypto.randomUUID(),
      eventId: second.event.id,
      snapshotAt: new Date().toISOString(),
      mediaCount: 1,
      totalBytes: 64,
      createdAt: new Date().toISOString(),
    });

    const response = await createApp().request(
      `/api/manage/events/${first.event.id}/exports/${job.id}`,
      { headers: { cookie: first.manager.cookie } },
      testEnv,
    );

    expect(response.status).toBe(403);
    expect((await response.json<any>()).code).toBe('RESOURCE_FORBIDDEN');
  });
});

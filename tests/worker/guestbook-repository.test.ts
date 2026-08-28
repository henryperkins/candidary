import { beforeEach, describe, expect, it } from 'vitest';

import type { ManagerGuestbookItem } from '../../shared/contracts';
import { GuestbookRepository } from '../../worker/db/guestbook';
import { eventAccess, resetDatabase, seedExportJob, testEnv, uploadPending } from './helpers';

beforeEach(resetDatabase);

async function guestSessionId(eventId: string) {
  const id = await testEnv.DB.prepare(`
    SELECT id FROM event_sessions
    WHERE event_id = ? AND role = 'guest' AND revoked_at IS NULL
    ORDER BY created_at DESC LIMIT 1
  `).bind(eventId).first<string>('id');
  if (!id) throw new Error('Expected a guest session fixture.');
  return id;
}

async function seedNote(input: {
  id: string;
  eventId: string;
  sessionId: string;
  state: 'pending' | 'approved' | 'rejected';
  body: string;
  createdAt: string;
  deletedAt?: string | null;
}) {
  await testEnv.DB.prepare(`
    INSERT INTO guest_messages (
      id, event_id, guest_session_id, guest_name, body, moderation_status,
      idempotency_key, created_at, approved_at, deleted_at
    ) VALUES (?, ?, ?, 'Avery', ?, ?, ?, ?, ?, ?)
  `).bind(
    input.id,
    input.eventId,
    input.sessionId,
    input.body,
    input.state,
    `key-${input.id}`,
    input.createdAt,
    input.state === 'approved' ? input.createdAt : null,
    input.deletedAt ?? null,
  ).run();
}

describe('GuestbookRepository', () => {
  it('orders equal timestamps by source rank and equal-rank IDs', async () => {
    const access = await eventAccess();
    const sessionId = await guestSessionId(access.event.id);
    const createdAt = '2026-09-19T20:00:00.000Z';
    await testEnv.DB.batch([
      testEnv.DB.prepare(`
        INSERT INTO guest_messages (
          id, event_id, guest_session_id, guest_name, body, moderation_status,
          idempotency_key, created_at, approved_at
        ) VALUES (?, ?, ?, 'Avery', 'First note ID', 'approved', 'equal-note-1', ?, ?)
      `).bind('10000000-0000-4000-8000-000000000001', access.event.id, sessionId, createdAt, createdAt),
      testEnv.DB.prepare(`
        INSERT INTO guest_messages (
          id, event_id, guest_session_id, guest_name, body, moderation_status,
          idempotency_key, created_at, approved_at
        ) VALUES (?, ?, ?, 'Avery', 'Second note ID', 'approved', 'equal-note-2', ?, ?)
      `).bind('10000000-0000-4000-8000-000000000002', access.event.id, sessionId, createdAt, createdAt),
    ]);
    const media = await uploadPending(access, 'equal-caption', 'Equal caption');
    await testEnv.DB.prepare(`
      UPDATE media SET publication_status = 'published', published_at = ?, created_at = ? WHERE id = ?
    `).bind(createdAt, createdAt, media.id).run();
    await testEnv.DB.prepare('UPDATE events SET gallery_visible = 1 WHERE id = ?')
      .bind(access.event.id).run();

    const page = await new GuestbookRepository(testEnv.DB)
      .listGuestShared(access.event.id, sessionId);

    expect(page.items.map((item) => [item.source, item.id])).toEqual([
      ['guest_note', '10000000-0000-4000-8000-000000000002'],
      ['guest_note', '10000000-0000-4000-8000-000000000001'],
      ['photo_caption', media.id],
    ]);
  });

  it('keeps gallery-off captions private to their uploader and drops whitespace captions', async () => {
    const access = await eventAccess();
    const sessionId = await guestSessionId(access.event.id);
    const caption = await uploadPending(access, 'private-caption', '  Private caption  ');
    const whitespace = await uploadPending(access, 'whitespace-caption', '   ');
    await testEnv.DB.prepare(`
      UPDATE media SET publication_status = 'published', published_at = created_at WHERE id IN (?, ?)
    `).bind(caption.id, whitespace.id).run();
    await testEnv.DB.prepare('UPDATE events SET gallery_visible = 0 WHERE id = ?')
      .bind(access.event.id).run();

    const repository = new GuestbookRepository(testEnv.DB);
    expect((await repository.listGuestShared(access.event.id, sessionId)).items).toEqual([]);
    expect((await repository.listGuestOwnUnshared(access.event.id, sessionId)).items)
      .toEqual([expect.objectContaining({
        id: caption.id,
        body: 'Private caption',
        source: 'photo_caption',
        state: 'published',
        visibility: 'author_only',
      })]);
  });

  it('paginates the private stream independently and reports its complete count', async () => {
    const access = await eventAccess();
    const sessionId = await guestSessionId(access.event.id);
    for (let index = 0; index < 52; index += 1) {
      await seedNote({
        id: `30000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        eventId: access.event.id,
        sessionId,
        state: index % 2 === 0 ? 'pending' : 'rejected',
        body: `Private ${index}`,
        createdAt: new Date(Date.UTC(2026, 8, 19, 20, 0, index)).toISOString(),
      });
    }

    const repository = new GuestbookRepository(testEnv.DB);
    const first = await repository.listGuestOwnUnshared(access.event.id, sessionId);
    expect(first.items).toHaveLength(50);
    expect(first.count).toBe(52);
    expect(first.nextCursor).not.toBeNull();
    const second = await repository.listGuestOwnUnshared(
      access.event.id,
      sessionId,
      first.nextCursor ?? undefined,
    );
    expect(second.items).toHaveLength(2);
    expect(second.count).toBe(52);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((item) => item.id))).toHaveLength(52);
  });

  it('maps every source state into the four Manager views and summary counts', async () => {
    const access = await eventAccess();
    const sessionId = await guestSessionId(access.event.id);
    const states = [
      ['40000000-0000-4000-8000-000000000001', 'pending', 'Pending note'],
      ['40000000-0000-4000-8000-000000000002', 'approved', 'Approved note'],
      ['40000000-0000-4000-8000-000000000003', 'rejected', 'Rejected note'],
    ] as const;
    for (const [id, state, body] of states) {
      await seedNote({ id, eventId: access.event.id, sessionId, state, body, createdAt: `2026-09-19T20:00:0${id.at(-1)}.000Z` });
    }
    await seedNote({
      id: '40000000-0000-4000-8000-000000000004',
      eventId: access.event.id,
      sessionId,
      state: 'rejected',
      body: 'Deleted note',
      createdAt: '2026-09-19T20:00:04.000Z',
      deletedAt: '2026-09-19T21:00:00.000Z',
    });
    const unpublished = await uploadPending(access, 'manager-unpublished', 'Unpublished caption');
    const published = await uploadPending(access, 'manager-published', 'Published caption');
    const hidden = await uploadPending(access, 'manager-hidden', 'Hidden caption');
    await testEnv.DB.batch([
      testEnv.DB.prepare("UPDATE media SET publication_status = 'published', published_at = created_at WHERE id = ?")
        .bind(published.id),
      testEnv.DB.prepare("UPDATE media SET publication_status = 'hidden' WHERE id = ?").bind(hidden.id),
      testEnv.DB.prepare('UPDATE events SET gallery_visible = 1 WHERE id = ?').bind(access.event.id),
    ]);

    const repository = new GuestbookRepository(testEnv.DB);
    const views = Object.fromEntries(await Promise.all(
      (['needs-review', 'shared', 'hidden', 'deleted'] as const).map(async (view) => [
        view,
        (await repository.listForManager(access.event.id, { view, source: 'all' })).items,
      ]),
    )) as Record<'needs-review' | 'shared' | 'hidden' | 'deleted', ManagerGuestbookItem[]>;
    expect(views['needs-review'].map((item) => item.id)).toEqual(expect.arrayContaining([
      '40000000-0000-4000-8000-000000000001',
      unpublished.id,
    ]));
    expect(views.shared.map((item) => item.id)).toEqual(expect.arrayContaining([
      '40000000-0000-4000-8000-000000000002',
      published.id,
    ]));
    expect(views.hidden.map((item) => item.id)).toEqual(expect.arrayContaining([
      '40000000-0000-4000-8000-000000000003',
      hidden.id,
    ]));
    expect(views.deleted).toEqual([
      expect.objectContaining({
        id: '40000000-0000-4000-8000-000000000004',
        state: 'deleted',
        visibility: 'host_only',
      }),
    ]);
    expect(await repository.summaryForManager(access.event.id)).toEqual({
      needsReviewCount: 2,
      sharedCount: 2,
      hiddenCount: 2,
      deletedCount: 1,
      galleryVisible: true,
    });

    await testEnv.DB.prepare('UPDATE events SET gallery_visible = 0 WHERE id = ?').bind(access.event.id).run();
    expect(await repository.summaryForManager(access.event.id)).toMatchObject({
      needsReviewCount: 2,
      sharedCount: 1,
      hiddenCount: 3,
      deletedCount: 1,
      galleryVisible: false,
    });
  });

  it('filters Manager views by source and exposes only allowlisted item fields', async () => {
    const access = await eventAccess();
    const sessionId = await guestSessionId(access.event.id);
    await seedNote({
      id: '50000000-0000-4000-8000-000000000001',
      eventId: access.event.id,
      sessionId,
      state: 'pending',
      body: 'Manager safe note',
      createdAt: '2026-09-19T20:00:00.000Z',
    });
    const media = await uploadPending(access, 'manager-safe-caption', 'Manager safe caption');
    await new GuestbookRepository(testEnv.DB).captionItemById(media.id);

    const repository = new GuestbookRepository(testEnv.DB);
    const notes = await repository.listForManager(access.event.id, {
      view: 'needs-review',
      source: 'guest_note',
    });
    expect(notes.items).toEqual([{
      id: '50000000-0000-4000-8000-000000000001',
      source: 'guest_note',
      guestName: 'Avery',
      body: 'Manager safe note',
      createdAt: '2026-09-19T20:00:00.000Z',
      state: 'pending',
      visibility: 'author_only',
    }]);
    expect(await repository.noteItemById('50000000-0000-4000-8000-000000000001'))
      .toEqual(notes.items[0]);
    expect(Object.keys((await repository.captionItemById(media.id))!)).toEqual([
      'id', 'source', 'mediaId', 'guestName', 'body', 'createdAt',
      'state', 'visibility', 'previewAvailable',
    ]);
  });

  it('builds a complete oldest-first immutable snapshot projection', async () => {
    const access = await eventAccess();
    const sessionId = await guestSessionId(access.event.id);
    const createdAt = '2026-09-19T20:00:00.000Z';
    await seedNote({
      id: '60000000-0000-4000-8000-000000000001', eventId: access.event.id,
      sessionId, state: 'approved', body: 'Snapshot note', createdAt,
    });
    const caption = await uploadPending(access, 'snapshot-caption', 'Snapshot caption');
    await testEnv.DB.prepare(`
      UPDATE media SET publication_status = 'published', published_at = ?, created_at = ? WHERE id = ?
    `).bind(createdAt, createdAt, caption.id).run();
    const exportJobId = crypto.randomUUID();
    // A queued complete job has to be entry-backed since 0019: it freezes its
    // photo sources and states its Guestbook counts up front. The counts start
    // at zero because this test is exercising the statements that fill the
    // Guestbook snapshot, not the creation service that totals it.
    await seedExportJob({
      id: exportJobId,
      eventId: access.event.id,
      snapshotAt: '2026-09-19T21:00:00.000Z',
      createdAt,
      media: [caption],
    });

    const statements = new GuestbookRepository(testEnv.DB).snapshotStatements({
      exportJobId,
      eventId: access.event.id,
      snapshotAt: '2026-09-19T21:00:00.000Z',
    });
    await testEnv.DB.batch([
      testEnv.DB.prepare('UPDATE export_jobs SET snapshot_at = snapshot_at WHERE id = ?').bind(exportJobId),
      ...statements,
    ]);
    const rows = await testEnv.DB.prepare(`
      SELECT source, source_id, source_rank, body
      FROM export_guestbook_entries WHERE export_job_id = ?
      ORDER BY created_at ASC, source_rank DESC, source_id ASC
    `).bind(exportJobId).all();
    expect(rows.results).toEqual([
      { source: 'photo_caption', source_id: caption.id, source_rank: 1, body: 'Snapshot caption' },
      { source: 'guest_note', source_id: '60000000-0000-4000-8000-000000000001', source_rank: 0, body: 'Snapshot note' },
    ]);
  });
});

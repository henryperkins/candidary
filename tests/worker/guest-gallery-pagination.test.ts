import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

import type { GuestGalleryMediaView } from '../../shared/contracts';
import { createApp } from '../../worker/app';
import { batchD1Statements, eventAccess, resetDatabase, testEnv } from './helpers';

type Access = Awaited<ReturnType<typeof eventAccess>>;
type Page = { media: GuestGalleryMediaView[]; nextCursor: string | null };
const stamp = '2026-09-19T22:00:00.000Z';
const id = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

beforeEach(resetDatabase);

async function seed(count: number) {
  const access = await eventAccess();
  await env.DB.prepare("UPDATE events SET gallery_visible = 1, event_start_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").bind(access.event.id).run();
  const session = await env.DB.prepare("SELECT id FROM event_sessions WHERE event_id = ? AND role = 'guest' LIMIT 1").bind(access.event.id).first<{ id: string }>();
  await batchD1Statements(env.DB, Array.from({ length: count }, (_, index) => env.DB.prepare(`
    INSERT INTO media (
      id, event_id, uploader_session_id, object_key, object_bucket_generation,
      original_filename, mime_type, declared_byte_size, byte_size, width, height,
      guest_name, caption, upload_state, publication_status, idempotency_key,
      reservation_expires_at, created_at, stored_at, timeline_at, published_at
    ) VALUES (?, ?, ?, ?, 'canonical', ?, 'image/jpeg', 1024, 1024, 800, 600,
      'Avery', ?, 'stored', 'published', ?, ?, ?, ?, ?, ?)
  `).bind(id(index), access.event.id, session!.id, `events/${access.event.id}/media/final/${id(index)}`,
    `private-filename-${index}.jpg`, `Moment ${index}`, `seed-${index}`, stamp, stamp, stamp, stamp,
    index < 2 ? null : stamp)));
  return access;
}

function read(access: Access, cursor?: string, cookie = access.guest.cookie) {
  return createApp().request(`/api/event/${access.event.slug}/gallery${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, {
    headers: { cookie },
  }, testEnv);
}

async function page(access: Access, cursor?: string): Promise<Page> {
  const response = await read(access, cursor);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toContain('no-store');
  return (await response.json<{ data: Page }>()).data;
}

describe('guest gallery pagination', () => {
  it('bounds every page and traverses tied and legacy null publication times without gaps', async () => {
    const access = await seed(51);
    await env.DB.prepare('UPDATE media SET published_at = NULL WHERE event_id = ? AND id <= ?').bind(access.event.id, id(26)).run();
    const first = await page(access);
    expect(first.media).toHaveLength(24);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(Object.keys(first.media[0]!).sort()).toEqual(['caption', 'guestName', 'id', 'previewAvailable']);
    const second = await page(access, first.nextCursor!);
    const third = await page(access, second.nextCursor!);
    expect(second.media).toHaveLength(24);
    expect(third.media).toHaveLength(3);
    expect(third.nextCursor).toBeNull();
    expect([...first.media, ...second.media, ...third.media].map(photo => photo.id))
      .toEqual(Array.from({ length: 51 }, (_, index) => id(index)));
    const raw = JSON.stringify([first, second, third]);
    expect(raw).not.toContain('private-filename');
    expect(raw).not.toContain('objectKey');
  });

  it('continues after a removed anchor and omits newly hidden photos without offset skips', async () => {
    const access = await seed(52);
    const first = await page(access);
    await env.DB.prepare("UPDATE media SET publication_status = 'hidden' WHERE id IN (?, ?, ?)")
      .bind(id(0), id(23), id(25)).run();
    const second = await page(access, first.nextCursor!);
    expect(second.media.map(photo => photo.id)).toEqual([id(24), ...Array.from({ length: 23 }, (_, index) => id(index + 26))]);
  });

  it('validates cursors and repeats event, session and visibility checks for each page', async () => {
    const access = await seed(25);
    const first = await page(access);
    for (const invalid of ['garbage', 'x'.repeat(2048), btoa(JSON.stringify({ v: 99 }))]) {
      expect((await read(access, invalid)).status).toBe(422);
    }
    const other = await eventAccess('Another event');
    await env.DB.prepare("UPDATE events SET gallery_visible = 1, event_start_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").bind(other.event.id).run();
    expect((await read(other, first.nextCursor!)).status).toBe(422);
    expect((await read(access, first.nextCursor!, other.guest.cookie)).status).toBe(403);
    expect((await read(access, first.nextCursor!, '')).status).toBe(401);
    await env.DB.prepare('UPDATE events SET gallery_visible = 0 WHERE id = ?').bind(access.event.id).run();
    expect((await read(access, first.nextCursor!)).status).toBe(403);
  });

  it('uses an ordered index and returns a bounded payload with 1000 published photos', async () => {
    const access = await seed(1000);
    const response = await createApp().request(`/api/event/${access.event.slug}/gallery?limit=1000000`, {
      headers: { cookie: access.guest.cookie },
    }, testEnv);
    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(JSON.parse(raw).data.media).toHaveLength(24);
    expect(raw.length).toBeLessThan(5000);
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN
      SELECT id, guest_name, caption, published_at, created_at FROM media
      WHERE event_id = ? AND upload_state = 'stored' AND publication_status = 'published'
        AND deleted_at IS NULL AND trashed_at IS NULL
        AND (published_at, created_at, id) > (?, ?, ?)
      ORDER BY published_at ASC, created_at ASC, id ASC LIMIT 25
    `).bind(access.event.id, stamp, stamp, id(900)).all<{ detail: string }>();
    const detail = plan.results.map(row => row.detail).join('\n');
    expect(detail).toContain('media_guest_gallery_page');
    expect(detail).not.toContain('TEMP B-TREE');
    const deepPage = await env.DB.prepare(`
      SELECT id, guest_name, caption, upload_state, published_at, created_at FROM media
      WHERE event_id = ? AND upload_state = 'stored' AND publication_status = 'published'
        AND deleted_at IS NULL AND trashed_at IS NULL
        AND (published_at, created_at, id) > (?, ?, ?)
      ORDER BY published_at ASC, created_at ASC, id ASC LIMIT 25
    `).bind(access.event.id, stamp, stamp, id(900)).all();
    expect(deepPage.results).toHaveLength(25);
    expect(deepPage.meta.rows_read).toBeLessThan(75);
    console.info('Guest gallery profile:', JSON.stringify({ totalPhotos: 1000, firstPageBytes: raw.length, returnedRows: deepPage.results.length, deepPageRowsRead: deepPage.meta.rows_read }));
  });

  it('returns an explicit end cursor for a truly empty gallery', async () => {
    const access = await seed(0);
    expect(await page(access)).toEqual({ media: [], nextCursor: null });
  });
});

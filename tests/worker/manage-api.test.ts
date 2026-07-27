import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../worker/app';
import { MediaRepository } from '../../worker/db/media';
import {
  eventAccess,
  png,
  resetDatabase,
  secondGuest,
  testEnv,
  uploadPending,
  writeHeaders,
} from './helpers';

beforeEach(resetDatabase);

type Access = Awaited<ReturnType<typeof eventAccess>>;
type SeededMedia = { id: string; storedAt: string };

const SEED_EPOCH_MS = Date.UTC(2026, 6, 20, 9, 0, 0);

function seedId(index: number, group = 0) {
  return `${String(group).padStart(8, '0')}-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function seedCreatedAt(index: number) {
  // Indexes 0 and 1 deliberately share a timestamp so a 50-row page boundary
  // lands on a `created_at` tie and only the id tie-break can resolve it.
  return new Date(SEED_EPOCH_MS + (index === 1 ? 0 : index) * 60_000).toISOString();
}

function range(count: number, start = 0) {
  return Array.from({ length: count }, (_, offset) => start + offset);
}

/** Insert `stored` rows straight into D1 so `stored_at` and ids are deterministic. */
async function seedStoredMedia(access: Access, indexes: readonly number[], group = 0): Promise<SeededMedia[]> {
  const session = await env.DB
    .prepare("SELECT id FROM event_sessions WHERE event_id = ? AND role = 'guest' LIMIT 1")
    .bind(access.event.id)
    .first<{ id: string }>();
  if (!session) throw new Error('Expected a guest session for the seeded event.');

  const seeded: SeededMedia[] = [];
  for (const index of indexes) {
    const id = seedId(index, group);
    const createdAt = seedCreatedAt(index);
    await env.DB.prepare(`
      INSERT INTO media (
        id, event_id, uploader_session_id, object_key, original_filename, mime_type,
        declared_byte_size, byte_size, width, height, guest_name, caption, upload_state,
        publication_status, idempotency_key, reservation_expires_at, created_at, stored_at
      )
      VALUES (?, ?, ?, ?, ?, 'image/png', 128, 128, 800, 600, ?, NULL, 'stored', 'unpublished', ?, ?, ?, ?)
    `).bind(
      id,
      access.event.id,
      session.id,
      `events/${access.event.id}/media/${id}`,
      `seed-${index}.png`,
      index % 2 === 0 ? 'Avery Stone' : 'Jordan Lee',
      `seed-${group}-${index}`,
      createdAt,
      createdAt,
      createdAt,
    ).run();
    seeded.push({ id, storedAt: createdAt });
  }
  return seeded;
}

/** The exact order `stored_at DESC, id DESC` must produce. */
function expectedOrder(seeded: readonly SeededMedia[]) {
  return [...seeded]
    .sort((left, right) => right.storedAt.localeCompare(left.storedAt) || right.id.localeCompare(left.id))
    .map((row) => row.id);
}

function managerMedia(access: Access, query = '') {
  return createApp().request(`/api/manage/events/${access.event.id}/media${query}`, {
    headers: { cookie: access.manager.cookie },
  }, testEnv);
}

async function managerMediaPage(access: Access, query = '') {
  const response = await managerMedia(access, query);
  expect(response.status).toBe(200);
  const body = await response.json<any>();
  return {
    ids: (body.data.media as Array<{ id: string }>).map((item) => item.id),
    nextCursor: body.data.nextCursor as string | null,
  };
}

describe('manager media pagination', () => {
  it('cursor-paginates the manager intake in stable pages', async () => {
    const access = await eventAccess();
    const seeded = await seedStoredMedia(access, range(51));
    const order = expectedOrder(seeded);

    const defaults = await managerMediaPage(access);
    expect(defaults.ids).toHaveLength(24);
    expect(defaults.ids).toEqual(order.slice(0, 24));
    expect(defaults.nextCursor).toEqual(expect.any(String));

    const first = await managerMediaPage(access, '?limit=50');
    expect(first.ids).toHaveLength(50);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await managerMediaPage(access, `?limit=50&cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(second.ids).toHaveLength(1);
    expect(second.nextCursor).toBeNull();

    expect(first.ids).toEqual(order.slice(0, 50));
    expect(second.ids).toEqual(order.slice(50));
    expect(new Set([...first.ids, ...second.ids]).size).toBe(51);
  });

  it('cursor-paginates past a photo that arrives between page requests', async () => {
    const access = await eventAccess();
    const seeded = await seedStoredMedia(access, range(51));
    const order = expectedOrder(seeded);

    const first = await managerMediaPage(access, '?limit=50');
    expect(first.ids).toEqual(order.slice(0, 50));

    // A guest delivers a newer photo while the manager is between pages. An
    // offset-based page two would shift by one and re-serve an already-seen row.
    const newer = (await seedStoredMedia(access, [80]))[0]!;

    const second = await managerMediaPage(access, `?limit=50&cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(second.ids).toHaveLength(1);
    expect(second.ids).toEqual(order.slice(50));
    expect(second.ids).not.toContain(newer.id);
    expect(second.nextCursor).toBeNull();
    expect(first.ids.filter((id) => second.ids.includes(id))).toEqual([]);
    expect(new Set([...first.ids, ...second.ids]).size).toBe(51);
  });

  it('positions a late finalization by storage time without corrupting a consumed cursor', async () => {
    const access = await eventAccess();
    const seeded = await seedStoredMedia(access, range(5));
    const order = expectedOrder(seeded);
    const initiated = await createApp().request(`/api/event/${access.event.slug}/uploads`, {
      method: 'POST',
      headers: writeHeaders(access.guest),
      body: JSON.stringify({
        filename: 'late.png',
        mimeType: 'image/png',
        byteSize: 128,
        idempotencyKey: 'late-finalization',
        guestName: 'Avery Stone',
      }),
    }, testEnv);
    const reserved = (await initiated.json<any>()).data.media as { id: string; objectKey: string };
    const behindCursor = '2026-07-20T08:00:00.000Z';
    await env.DB.prepare('UPDATE media SET created_at = ? WHERE id = ?')
      .bind(behindCursor, reserved.id)
      .run();
    await testEnv.MEDIA_BUCKET.put(reserved.objectKey, png(), {
      httpMetadata: { contentType: 'image/png' },
    });

    const first = await managerMediaPage(access, '?limit=2');
    expect(first.ids).toEqual(order.slice(0, 2));
    expect(first.nextCursor).toEqual(expect.any(String));

    const finalized = await createApp().request(
      `/api/event/${access.event.slug}/uploads/${reserved.id}/finalize`,
      { method: 'POST', headers: writeHeaders(access.guest), body: '{}' },
      testEnv,
    );
    expect(finalized.status).toBe(200);

    const poll = await managerMediaPage(access, '?limit=2');
    expect(poll.ids).toContain(reserved.id);

    const walked = [...first.ids];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await managerMediaPage(access, `?limit=2&cursor=${encodeURIComponent(cursor)}`);
      walked.push(...page.ids);
      cursor = page.nextCursor;
    }
    expect(walked).toEqual(order);
    expect(new Set(walked).size).toBe(order.length);

    const merged = [...poll.ids, ...walked.filter((id) => !poll.ids.includes(id))];
    expect(new Set(merged)).toEqual(new Set([...order, reserved.id]));
  });

  it('cursor-paginates rows the upload flow actually created', async () => {
    // Seeded rows use synthetic ids; this walks real `crypto.randomUUID()` ids
    // and real `toISOString()` timestamps so the cursor codec cannot drift from
    // the values the upload path writes.
    const access = await eventAccess();
    const uploaded = await Promise.all([
      uploadPending(access, 'page-1'),
      uploadPending(access, 'page-2'),
    ]);
    const seededUploaded: SeededMedia[] = await Promise.all(uploaded.map(async ({ id }) => {
      const row = await env.DB.prepare('SELECT stored_at FROM media WHERE id = ?')
        .bind(id)
        .first<{ stored_at: string }>();
      if (!row) throw new Error('Expected the uploaded row to have a storage timestamp.');
      return { id, storedAt: row.stored_at };
    }));
    const order = expectedOrder(seededUploaded);

    const first = await managerMediaPage(access, '?limit=1');
    expect(first.ids).toEqual(order.slice(0, 1));
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await managerMediaPage(access, `?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(second.ids).toEqual(order.slice(1));
    expect(second.nextCursor).toBeNull();
  });

  it('cursor-paginates a guest-name filtered intake', async () => {
    const access = await eventAccess();
    const seeded = await seedStoredMedia(access, range(12));
    const jordan = expectedOrder(seeded.filter((_, index) => index % 2 === 1));
    expect(jordan).toHaveLength(6);

    const first = await managerMediaPage(access, '?guestName=jordan&limit=4');
    expect(first.ids).toEqual(jordan.slice(0, 4));
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await managerMediaPage(access, `?guestName=jordan&limit=4&cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(second.ids).toEqual(jordan.slice(4));
    expect(second.nextCursor).toBeNull();
  });

  it('cursor-paginates only within the authenticated event', async () => {
    const mine = await eventAccess();
    const theirs = await eventAccess('Rowan & Sky');
    const myMedia = await seedStoredMedia(mine, range(6));
    const theirMedia = await seedStoredMedia(theirs, range(6), 1);

    // A cursor minted for another event is just an opaque position marker.
    const foreign = await managerMediaPage(theirs, '?limit=2');
    expect(foreign.nextCursor).toEqual(expect.any(String));

    const forged = await managerMediaPage(mine, `?limit=50&cursor=${encodeURIComponent(foreign.nextCursor!)}`);
    const theirIds = new Set(theirMedia.map((row) => row.id));
    const myIds = new Set(myMedia.map((row) => row.id));
    expect(forged.ids.filter((id) => theirIds.has(id))).toEqual([]);
    expect(forged.ids.every((id) => myIds.has(id))).toBe(true);

    const crossEvent = await createApp().request(`/api/manage/events/${theirs.event.id}/media`, {
      headers: { cookie: mine.manager.cookie },
    }, testEnv);
    expect(crossEvent.status).toBe(403);
  });

  it('rejects invalid media cursors and out-of-range page limits', async () => {
    const access = await eventAccess();
    await seedStoredMedia(access, range(3));
    const wrongShape = btoa(JSON.stringify({ createdAt: 'not-a-date', id: 'not-a-uuid' }));

    const rejected = [
      'cursor=not-a-cursor',
      'cursor=',
      `cursor=${encodeURIComponent(wrongShape)}`,
      `cursor=${encodeURIComponent(btoa('"just-a-string"'))}`,
      'limit=51',
      'limit=0',
      'limit=-1',
      'limit=abc',
      'limit=99999999999999999999',
    ];
    for (const query of rejected) {
      const response = await managerMedia(access, `?${query}`);
      expect([query, response.status]).toEqual([query, 422]);
      expect((await response.json<any>()).code).toBe('VALIDATION_FAILED');
    }
  });
});

describe('manager settings and private photo intake', () => {
  it('uploads and serves an event cover only to event sessions', async () => {
    const access = await eventAccess();
    const initiated = await createApp().request(`/api/manage/events/${access.event.id}/cover`, {
      method: 'POST', headers: writeHeaders(access.manager),
      body: JSON.stringify({ filename: 'cover.png', mimeType: 'image/png', byteSize: 64 }),
    }, testEnv);
    expect(initiated.status).toBe(201);
    const upload = (await initiated.json<any>()).data;
    await testEnv.MEDIA_BUCKET.put(upload.objectKey, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 2, 0]), { httpMetadata: { contentType: 'image/png' } });
    const finalized = await createApp().request(`/api/manage/events/${access.event.id}/cover/finalize`, {
      method: 'POST', headers: writeHeaders(access.manager),
      body: JSON.stringify({ objectKey: upload.objectKey, mimeType: 'image/png' }),
    }, testEnv);
    expect(finalized.status).toBe(200);
    const cover = await createApp().request(`/api/event/${access.event.slug}/cover`, {
      headers: { cookie: access.guest.cookie },
    }, testEnv);
    expect(cover.status).toBe(200);
    expect(cover.headers.get('cache-control')).toBe('private, no-store');
  });

  it('keeps every delivery in intake, filters by guest name, and publishes separately', async () => {
    const access = await eventAccess();
    const avery = await uploadPending(access, 'review-1', null, 'Avery Stone');
    const jordan = await uploadPending(access, 'review-2', null, 'Jordan Lee');
    const all = await createApp().request(`/api/manage/events/${access.event.id}/media`, {
      headers: { cookie: access.manager.cookie },
    }, testEnv);
    expect((await all.json<any>()).data.media.map((item: any) => item.id)).toEqual(expect.arrayContaining([avery.id, jordan.id]));
    const filtered = await createApp().request(`/api/manage/events/${access.event.id}/media?guestName=avery`, {
      headers: { cookie: access.manager.cookie },
    }, testEnv);
    expect((await filtered.json<any>()).data.media.map((item: any) => item.id)).toEqual([avery.id]);

    const hiddenGallery = await createApp().request(`/api/event/${access.event.slug}/gallery`, {
      headers: { cookie: access.guest.cookie },
    }, testEnv);
    expect((await hiddenGallery.json<any>()).code).toBe('GALLERY_HIDDEN');

    await createApp().request(`/api/manage/events/${access.event.id}/settings`, {
      method: 'PATCH', headers: writeHeaders(access.manager),
      body: JSON.stringify({ galleryVisible: true, uploadsEnabled: true, moderationRequired: true }),
    }, testEnv);
    const published = await createApp().request(`/api/manage/events/${access.event.id}/media/${avery.id}`, {
      method: 'PATCH', headers: writeHeaders(access.manager),
      body: JSON.stringify({ action: 'publish', expectedStatus: 'unpublished' }),
    }, testEnv);
    expect(published.status).toBe(200);
    expect((await published.json<any>()).data.media.publicationStatus).toBe('published');
    const gallery = await createApp().request(`/api/event/${access.event.slug}/gallery`, {
      headers: { cookie: access.guest.cookie },
    }, testEnv);
    expect((await gallery.json<any>()).data.media.map((item: any) => item.id)).toEqual([avery.id]);

    await createApp().request(`/api/manage/events/${access.event.id}/media/${avery.id}`, {
      method: 'PATCH', headers: writeHeaders(access.manager),
      body: JSON.stringify({ action: 'hide', expectedStatus: 'published' }),
    }, testEnv);
    const intakeAfterHide = await createApp().request(`/api/manage/events/${access.event.id}/media?status=hidden`, {
      headers: { cookie: access.manager.cookie },
    }, testEnv);
    expect((await intakeAfterHide.json<any>()).data.media.map((item: any) => item.id)).toEqual([avery.id]);
  });

  it('bulk-publishes only the selected unpublished items', async () => {
    const access = await eventAccess();
    const first = await uploadPending(access, 'bulk-1');
    const second = await uploadPending(access, 'bulk-2');
    const untouched = await uploadPending(access, 'bulk-3');
    const response = await createApp().request(`/api/manage/events/${access.event.id}/media/bulk`, {
      method: 'POST', headers: writeHeaders(access.manager),
      body: JSON.stringify({ ids: [first.id, second.id], action: 'publish', expectedStatus: 'unpublished' }),
    }, testEnv);
    expect(response.status).toBe(200);
    const rows = await env.DB.prepare('SELECT id, publication_status FROM media ORDER BY id').all<any>();
    const states = Object.fromEntries(rows.results.map((row: any) => [row.id, row.publication_status]));
    expect(states).toMatchObject({ [first.id]: 'published', [second.id]: 'published', [untouched.id]: 'unpublished' });
  });

  it('deletes the cached preview with an individual private original', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'delete-preview');
    const previewObjectKey = `events/${access.event.id}/previews/${media.id}.webp`;
    await testEnv.MEDIA_BUCKET.put(previewObjectKey, new Uint8Array([1, 2, 3]));
    await new MediaRepository(env.DB).setPreviewObjectKey(media.id, previewObjectKey);

    const deleted = await createApp().request(`/api/manage/events/${access.event.id}/media/${media.id}`, {
      method: 'PATCH', headers: writeHeaders(access.manager),
      body: JSON.stringify({ action: 'delete', expectedStatus: 'unpublished' }),
    }, testEnv);

    expect(deleted.status).toBe(200);
    expect(await testEnv.MEDIA_BUCKET.head(media.objectKey)).toBeNull();
    expect(await testEnv.MEDIA_BUCKET.head(previewObjectKey)).toBeNull();
  });
});

describe('access link rotation', () => {
  it('redisplays the active guest link without exposing it to guests', async () => {
    const access = await eventAccess();
    const response = await createApp().request(`/api/manage/events/${access.event.id}/links`, {
      headers: { cookie: access.manager.cookie },
    }, testEnv);
    expect(response.status).toBe(200);
    expect((await response.json<any>()).data.guestLink).toBe(access.guestLink);

    const denied = await createApp().request(`/api/manage/events/${access.event.id}/links`, {
      headers: { cookie: access.guest.cookie },
    }, testEnv);
    expect(denied.status).toBe(403);
  });

  it('rotates the guest link and invalidates every old guest session immediately', async () => {
    const access = await eventAccess();
    const rotated = await createApp().request(`/api/manage/events/${access.event.id}/links/guest/rotate`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const body = await rotated.json<any>();
    expect(body.data.guestLink).not.toBe(access.guestLink);

    const oldShell = await createApp().request(`/api/event/${access.event.slug}`, {
      headers: { cookie: access.guest.cookie },
    }, testEnv);
    expect((await oldShell.json<any>()).code).toBe('TOKEN_REVOKED');

    const replacement = await secondGuest(body.data.guestLink);
    const newShell = await createApp().request(`/api/event/${access.event.slug}`, {
      headers: { cookie: replacement.cookie },
    }, testEnv);
    expect(newShell.status).toBe(200);
  });

  it('returns a one-time replacement management link and revokes the current manager session', async () => {
    const access = await eventAccess();
    const rotated = await createApp().request(`/api/manage/events/${access.event.id}/links/manager/rotate`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const body = await rotated.json<any>();
    expect(body.data.managementLink).not.toBe(access.managementLink);

    const oldManager = await createApp().request(`/api/manage/events/${access.event.id}`, {
      headers: { cookie: access.manager.cookie },
    }, testEnv);
    expect((await oldManager.json<any>()).code).toBe('TOKEN_REVOKED');
  });
});

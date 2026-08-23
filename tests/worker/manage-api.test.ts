import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ALBUM_MAX_ENTRIES,
  DEFAULT_GUESTBOOK_PROMPT,
  MANAGER_BULK_SELECTION_MAX,
  MAX_GUESTBOOK_PROMPT_LENGTH,
} from '../../shared/constants';
import { createApp } from '../../worker/app';
import { EventEntriesRepository } from '../../worker/db/event-entries';
import { EventsRepository } from '../../worker/db/events';
import { MediaRepository } from '../../worker/db/media';
import { MediaObjectWriteTombstoneRepository } from '../../worker/db/media-write-tombstones';
import {
  cleanupMediaObjectWriteTombstones,
  deleteEventData,
  promoteLegacyStoredMedia,
} from '../../worker/workflows/cleanup';
import {
  applySettings,
  cookiesFrom,
  eventAccess,
  importRoster,
  png,
  resetDatabase,
  seedEventCoverGraph,
  secondGuest,
  testEnv,
  uploadPending,
  writeHeaders,
} from './helpers';

beforeEach(resetDatabase);
afterEach(() => {
  delete globalThis.__CANDIDARY_TEST_MEDIA_UPLOAD_RELEASE_OVERRIDE__;
});

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
        id, event_id, uploader_session_id, object_key, object_bucket_generation,
        original_filename, mime_type,
        declared_byte_size, byte_size, width, height, guest_name, caption, upload_state,
        publication_status, idempotency_key, reservation_expires_at, created_at, stored_at
      )
      VALUES (?, ?, ?, ?, 'canonical', ?, 'image/png', 128, 128, 800, 600,
        ?, NULL, 'stored', 'unpublished', ?, ?, ?, ?)
    `).bind(
      id,
      access.event.id,
      session.id,
      `events/${access.event.id}/media/final/${id}`,
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
    const lateBytes = png();
    const initiated = await createApp().request(`/api/event/${access.event.slug}/uploads`, {
      method: 'POST',
      headers: writeHeaders(access.guest),
      body: JSON.stringify({
        filename: 'late.png',
        mimeType: 'image/png',
        byteSize: lateBytes.byteLength,
        idempotencyKey: 'late-finalization',
        guestName: 'Avery Stone',
      }),
    }, testEnv);
    const reserved = (await initiated.json<any>()).data.media as { id: string; objectKey: string };
    const behindCursor = '2026-07-20T08:00:00.000Z';
    await env.DB.prepare('UPDATE media SET created_at = ? WHERE id = ?')
      .bind(behindCursor, reserved.id)
      .run();
    const first = await managerMediaPage(access, '?limit=2');
    expect(first.ids).toEqual(order.slice(0, 2));
    expect(first.nextCursor).toEqual(expect.any(String));

    const finalized = await createApp().request(
      `/api/event/${access.event.slug}/uploads/${reserved.id}/content`,
      {
        method: 'PUT',
        headers: {
          ...writeHeaders(access.guest),
          'content-type': 'image/png',
          'content-length': String(lateBytes.byteLength),
        },
        body: lateBytes.buffer.slice(
          lateBytes.byteOffset,
          lateBytes.byteOffset + lateBytes.byteLength,
        ) as ArrayBuffer,
      },
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
  it('returns allowlisted Manager media and caption projections without private storage fields', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'safe-manager-media', 'A safe caption');

    const listed = await createApp().request(`/api/manage/events/${access.event.id}/media`, {
      headers: { cookie: access.manager.cookie },
    }, testEnv);
    const listedBody = await listed.json<any>();
    expect(listedBody.data.media).toEqual([{
      id: media.id,
      originalFilename: 'safe-manager-media.png',
      guestName: 'Avery',
      caption: 'A safe caption',
      publicationStatus: 'unpublished',
      uploadState: 'stored',
      previewAvailable: true,
      width: 800,
      height: 600,
      createdAt: media.createdAt,
    }]);

    const published = await createApp().request(`/api/manage/events/${access.event.id}/media/${media.id}`, {
      method: 'PATCH',
      headers: writeHeaders(access.manager),
      body: JSON.stringify({ action: 'publish', expectedStatus: 'unpublished' }),
    }, testEnv);
    const publishedBody = await published.json<any>();
    expect(publishedBody.data.media).toMatchObject({
      id: media.id,
      publicationStatus: 'published',
      previewAvailable: true,
    });
    expect(publishedBody.data.item).toMatchObject({
      id: media.id,
      source: 'photo_caption',
      mediaId: media.id,
      state: 'published',
      visibility: 'author_only',
      previewAvailable: true,
    });
    expect(JSON.stringify([listedBody, publishedBody]))
      .not.toMatch(/objectKey|object_key|previewObjectKey|preview_object_key|uploaderSessionId|idempotencyKey/u);
  });

  it('defaults the guestbook prompt on creation and returns it to guests and managers', async () => {
    const access = await eventAccess();

    expect(access.event.guestbookPrompt).toBe(DEFAULT_GUESTBOOK_PROMPT);
    const guest = await createApp().request(`/api/event/${access.event.slug}`, {
      headers: { cookie: access.guest.cookie },
    }, testEnv);
    expect((await guest.json<any>()).data.event.guestbookPrompt).toBe(DEFAULT_GUESTBOOK_PROMPT);
    expect(await env.DB.prepare('SELECT guestbook_prompt FROM events WHERE id = ?')
      .bind(access.event.id).first()).toEqual({ guestbook_prompt: DEFAULT_GUESTBOOK_PROMPT });
  });

  it('trims and persists a valid guestbook prompt', async () => {
    const access = await eventAccess();

    const response = await applySettings(access, {
      guestbookPrompt: '  Leave us a favorite memory.  ',
    });

    expect(response.status).toBe(200);
    expect((await response.json<any>()).data.event.guestbookPrompt)
      .toBe('Leave us a favorite memory.');
    expect(await env.DB.prepare('SELECT guestbook_prompt FROM events WHERE id = ?')
      .bind(access.event.id).first()).toEqual({ guestbook_prompt: 'Leave us a favorite memory.' });
  });

  it('requires the guestbook prompt in the complete settings payload without changing storage', async () => {
    const access = await eventAccess();
    const storedPrompt = 'Tell us what made you smile.';
    expect((await applySettings(access, { guestbookPrompt: storedPrompt })).status).toBe(200);

    const response = await createApp().request(`/api/manage/events/${access.event.id}/settings`, {
      method: 'PATCH',
      headers: writeHeaders(access.manager),
      body: JSON.stringify({
        galleryVisible: access.event.galleryVisible,
        moderationRequired: access.event.moderationRequired,
        eventTimezone: access.event.eventTimezone,
        eventStartTime: access.event.eventStartTime,
        rsvpDeadlineDate: access.event.rsvpDeadlineDate,
        rsvpEnabled: access.event.rsvpEnabled,
        rsvpRosterVersion: access.event.rsvpRosterVersion,
      }),
    }, testEnv);

    expect(response.status).toBe(422);
    expect((await response.json<any>()).fieldErrors.guestbookPrompt).toEqual(expect.any(String));
    expect(await env.DB.prepare('SELECT guestbook_prompt FROM events WHERE id = ?')
      .bind(access.event.id).first()).toEqual({ guestbook_prompt: storedPrompt });
  });

  it.each([
    ['', 'String must contain at least 1 character(s)'],
    [' '.repeat(4), 'String must contain at least 1 character(s)'],
    ['g'.repeat(MAX_GUESTBOOK_PROMPT_LENGTH + 1),
      `String must contain at most ${MAX_GUESTBOOK_PROMPT_LENGTH} character(s)`],
  ])('rejects an invalid guestbook prompt without changing the stored value', async (value) => {
    const access = await eventAccess();

    const response = await applySettings(access, { guestbookPrompt: value });

    expect(response.status).toBe(422);
    const body = await response.json<any>();
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.fieldErrors.guestbookPrompt).toEqual(expect.any(String));
    expect(await env.DB.prepare('SELECT guestbook_prompt FROM events WHERE id = ?')
      .bind(access.event.id).first()).toEqual({ guestbook_prompt: DEFAULT_GUESTBOOK_PROMPT });
  });

  it('rejects an implausible RSVP deadline year before storing it', async () => {
    const access = await eventAccess();

    const response = await applySettings(access, { rsvpDeadlineDate: '0202-09-19' });
    const body = await response.json<any>();

    expect(response.status).toBe(422);
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.fieldErrors).toMatchObject({
      rsvpDeadlineDate: 'Choose a valid RSVP deadline.',
    });
  });

  it('classifies a guarded settings refusal as the entry stop, not a roster race', async () => {
    const access = await eventAccess();
    await importRoster(
      access,
      'household_key,household_label,invitee_name,plus_one_slots\nperkins,Perkins household,Henry Perkins,0',
    );
    const current = await createApp().request(`/api/manage/events/${access.event.id}`, {
      headers: { cookie: access.manager.cookie },
    }, testEnv);
    access.event = (await current.json<any>()).data.event;
    const entries = new EventEntriesRepository(env.DB);
    const guardedUpdate = vi.spyOn(EventsRepository.prototype, 'updateSettings').mockImplementationOnce(
      async (eventId) => {
        // The route's first entry read succeeded. The irreversible stop lands in
        // the narrow window before the atomic settings statement decides whether
        // it can reopen RSVP, so the route receives the guarded null result.
        await entries.disableForEvent(eventId, '2026-07-21T12:00:00.000Z');
        return null;
      },
    );

    try {
      const response = await applySettings(access, { rsvpEnabled: true });

      expect(response.status).toBe(410);
      expect((await response.json<any>()).code).toBe('EVENT_ENTRY_UNAVAILABLE');
    } finally {
      guardedUpdate.mockRestore();
    }
  });

  it('no longer exposes the presigned cover trio', async () => {
    const access = await eventAccess();
    // The draft-and-publish surface in `routes/event-cover.ts` replaced these.
    // Removing them also closes the dead path where `image/heic-sequence` and
    // `image/heif-sequence` could be reserved but could never finalize, because
    // cover finalize never applied the aliasing `finalizeStoredMedia` applies.
    const retired = [
      ['POST', `/api/manage/events/${access.event.id}/cover`],
      ['POST', `/api/manage/events/${access.event.id}/cover/finalize`],
      ['DELETE', `/api/manage/events/${access.event.id}/cover`],
    ] as const;
    for (const [method, path] of retired) {
      const response = await createApp().request(path, {
        method,
        headers: writeHeaders(access.manager),
        body: method === 'DELETE' ? undefined : JSON.stringify({}),
      }, testEnv);
      expect([method, response.status]).toEqual([method, 404]);
    }
  });

  it('removes a cover through one guarded publication', async () => {
    const access = await eventAccess();
    const removed = await createApp().request(
      `/api/manage/events/${access.event.id}/cover/publications`,
      {
        method: 'POST',
        headers: writeHeaders(access.manager),
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          expectedRevision: 0,
          source: { kind: 'none' },
        }),
      },
      testEnv,
    );
    expect(removed.status).toBe(200);
    const data = (await removed.json<any>()).data;
    expect(data.event.cover.hasCover).toBe(false);
    // Exactly once, and only because the expected revision still matched.
    expect(data.event.cover.revision).toBe(1);

    const gone = await createApp().request(`/api/event/${access.event.slug}/cover`, {
      headers: { cookie: access.guest.cookie },
    }, testEnv);
    expect(gone.status).toBe(404);
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
      body: JSON.stringify({
        guestbookPrompt: access.event.guestbookPrompt,
        galleryVisible: true, moderationRequired: true,
        eventTimezone: 'America/Chicago', eventStartTime: '00:00',
        rsvpDeadlineDate: '2026-09-05', rsvpEnabled: false, rsvpRosterVersion: 0,
      }),
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
    expect((await response.json<any>()).data.changed.map((item: any) => item.id)).toEqual([first.id, second.id]);
  });

  it('returns only ManagerMediaView fields for every bulk moderation result', async () => {
    const access = await eventAccess();
    const first = await uploadPending(access, 'bulk-safe-1', 'First caption');
    const second = await uploadPending(access, 'bulk-safe-2', 'Second caption');

    const response = await createApp().request(`/api/manage/events/${access.event.id}/media/bulk`, {
      method: 'POST',
      headers: writeHeaders(access.manager),
      body: JSON.stringify({
        ids: [first.id, second.id],
        action: 'publish',
        expectedStatus: 'unpublished',
      }),
    }, testEnv);

    expect(response.status).toBe(200);
    const changed = (await response.json<any>()).data.changed;
    const expectedKeys = [
      'caption',
      'createdAt',
      'guestName',
      'height',
      'id',
      'originalFilename',
      'previewAvailable',
      'publicationStatus',
      'uploadState',
      'width',
    ];
    expect(changed).toHaveLength(2);
    for (const item of changed) {
      expect(Object.keys(item).sort()).toEqual(expectedKeys);
    }
    expect(changed.map((item: any) => item.id)).toEqual([first.id, second.id]);
    expect(changed).toEqual([
      expect.objectContaining({ publicationStatus: 'published', previewAvailable: true }),
      expect.objectContaining({ publicationStatus: 'published', previewAvailable: true }),
    ]);
    expect(JSON.stringify(changed)).not.toMatch(
      /objectKey|previewObjectKey|uploaderSessionId|idempotencyKey|byteSize|mimeType|reservationExpiresAt/u,
    );
  });

  it('supports the maximum bulk selection through D1 in request order', async () => {
    const access = await eventAccess();
    const seeded = await seedStoredMedia(access, range(MANAGER_BULK_SELECTION_MAX + 1));
    const selectedIds = seeded
      .slice(0, MANAGER_BULK_SELECTION_MAX)
      .map(({ id }) => id)
      .reverse();
    const untouched = seeded[MANAGER_BULK_SELECTION_MAX]!;

    const response = await createApp().request(`/api/manage/events/${access.event.id}/media/bulk`, {
      method: 'POST',
      headers: writeHeaders(access.manager),
      body: JSON.stringify({
        ids: selectedIds,
        action: 'publish',
        expectedStatus: 'unpublished',
      }),
    }, testEnv);

    expect(response.status).toBe(200);
    expect((await response.json<any>()).data.changed.map((item: any) => item.id)).toEqual(selectedIds);
    const rows = await env.DB.prepare(`
      SELECT id, publication_status
      FROM media
      WHERE event_id = ?
    `).bind(access.event.id).all<{ id: string; publication_status: string }>();
    const states = new Map(rows.results.map((row) => [row.id, row.publication_status]));
    expect(selectedIds.every((id) => states.get(id) === 'published')).toBe(true);
    expect([...states.values()].filter((status) => status === 'published')).toHaveLength(
      MANAGER_BULK_SELECTION_MAX,
    );
    expect(states.get(untouched.id)).toBe('unpublished');
  });

  it('uses unique IDs for duplicate album pick validation at the repository boundary', async () => {
    const access = await eventAccess();
    const [seeded] = await seedStoredMedia(access, [77]);
    if (!seeded) throw new Error('Expected an album-pick fixture.');
    const repository = new MediaRepository(env.DB);

    const changed = await repository.setFavoriteBulk(
      access.event.id,
      Array.from({ length: ALBUM_MAX_ENTRIES + 1 }, () => seeded.id),
      '2026-08-23T12:00:00.000Z',
    );

    expect(changed.map(({ id }) => id)).toEqual([seeded.id]);
    expect(await repository.getById(seeded.id)).toMatchObject({
      id: seeded.id,
      favoritedAt: '2026-08-23T12:00:00.000Z',
    });
  });

  it('leaves every selected row unchanged when a later bulk id conflicts', async () => {
    const access = await eventAccess();
    const first = await uploadPending(access, 'bulk-conflict-first');
    const second = await uploadPending(access, 'bulk-conflict-second');
    await new MediaRepository(env.DB).setPublication(
      second.id,
      'unpublished',
      'published',
      '2026-07-27T12:00:00.000Z',
    );

    const response = await createApp().request(`/api/manage/events/${access.event.id}/media/bulk`, {
      method: 'POST',
      headers: writeHeaders(access.manager),
      body: JSON.stringify({
        ids: [first.id, second.id],
        action: 'publish',
        expectedStatus: 'unpublished',
      }),
    }, testEnv);

    expect(response.status).toBe(409);
    expect((await response.json<any>()).code).toBe('MEDIA_STATE_CONFLICT');
    const rows = await env.DB.prepare('SELECT id, publication_status FROM media WHERE id IN (?, ?)')
      .bind(first.id, second.id)
      .all<{ id: string; publication_status: string }>();
    expect(Object.fromEntries(rows.results.map((row) => [row.id, row.publication_status]))).toEqual({
      [first.id]: 'unpublished',
      [second.id]: 'published',
    });
  });

  it('does not reveal or partially apply ineligible bulk ids', async () => {
    const access = await eventAccess();
    const other = await eventAccess('Rowan & Sky');
    const foreign = await uploadPending(other, 'bulk-foreign');
    const deleted = await uploadPending(access, 'bulk-deleted');
    await new MediaRepository(env.DB).delete(deleted.id, '2026-07-27T12:01:00.000Z');
    const reservedResponse = await createApp().request(`/api/event/${access.event.slug}/uploads`, {
      method: 'POST',
      headers: writeHeaders(access.guest),
      body: JSON.stringify({
        filename: 'reserved.png',
        mimeType: 'image/png',
        byteSize: 128,
        idempotencyKey: 'bulk-reserved',
        guestName: 'Avery',
      }),
    }, testEnv);
    const reserved = (await reservedResponse.json<any>()).data.media as { id: string };
    const cases = [
      ['missing', '11111111-1111-4111-8111-111111111111'],
      ['foreign', foreign.id],
      ['deleted', deleted.id],
      ['reserved', reserved.id],
    ] as const;

    for (const [label, ineligibleId] of cases) {
      const local = await uploadPending(access, `bulk-local-${label}`);
      const response = await createApp().request(`/api/manage/events/${access.event.id}/media/bulk`, {
        method: 'POST',
        headers: writeHeaders(access.manager),
        body: JSON.stringify({
          ids: [local.id, ineligibleId],
          action: 'publish',
          expectedStatus: 'unpublished',
        }),
      }, testEnv);

      expect([label, response.status]).toEqual([label, 409]);
      expect((await response.json<any>()).code).toBe('MEDIA_STATE_CONFLICT');
      expect(await env.DB.prepare('SELECT publication_status FROM media WHERE id = ?')
        .bind(local.id)
        .first<{ publication_status: string }>()).toEqual({ publication_status: 'unpublished' });
    }
  });

  it('rejects empty, duplicate, oversized, and malformed bulk selections consistently', async () => {
    const access = await eventAccess();
    const id = crypto.randomUUID();
    const payloads = [
      { ids: [], action: 'publish', expectedStatus: 'unpublished' },
      { ids: [id, id], action: 'publish', expectedStatus: 'unpublished' },
      {
        ids: Array.from({ length: 51 }, () => crypto.randomUUID()),
        action: 'hide',
        expectedStatus: 'published',
      },
      { ids: ['not-a-uuid'], action: 'publish', expectedStatus: 'unpublished' },
    ];

    for (const body of payloads) {
      const response = await createApp().request(`/api/manage/events/${access.event.id}/media/bulk`, {
        method: 'POST',
        headers: writeHeaders(access.manager),
        body: JSON.stringify(body),
      }, testEnv);
      expect(response.status).toBe(422);
      expect((await response.json<any>()).code).toBe('VALIDATION_FAILED');
    }
  });

  it('durably schedules original/final/preview deletion when R2 cleanup fails', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'delete-preview');
    const previewObjectKey = `events/${access.event.id}/previews/${media.id}.webp`;
    await testEnv.MEDIA_BUCKET.put(previewObjectKey, new Uint8Array([1, 2, 3]));
    // Model a pointer admitted by an old Worker immediately before the
    // canonical-generation guard became visible. New code cannot persist it.
    await testEnv.DB.exec('DROP TRIGGER media_object_write_tombstone_guard_update;');
    await testEnv.DB.prepare('UPDATE media SET preview_object_key = ? WHERE id = ?')
      .bind(previewObjectKey, media.id).run();

    const deleted = await createApp().request(`/api/manage/events/${access.event.id}/media/${media.id}`, {
      method: 'PATCH', headers: writeHeaders(access.manager),
      body: JSON.stringify({ action: 'delete', expectedStatus: 'unpublished' }),
    }, testEnv);

    expect(deleted.status).toBe(200);
    expect(await testEnv.CANONICAL_MEDIA_BUCKET.head(media.objectKey)).not.toBeNull();
    expect(await testEnv.MEDIA_BUCKET.head(previewObjectKey)).not.toBeNull();
    expect(await new MediaRepository(env.DB).getPromotion(media.id)).not.toBeNull();
    await promoteLegacyStoredMedia(testEnv, new Date('2099-08-13T10:21:00.000Z'));
    expect(await new MediaRepository(env.DB).getPromotion(media.id)).toBeNull();

    const deleteSpy = vi.spyOn(testEnv.CANONICAL_MEDIA_BUCKET, 'delete')
      .mockRejectedValueOnce(new Error('R2 unavailable'));
    await cleanupMediaObjectWriteTombstones(
      testEnv,
      new Date('2099-08-13T10:22:00.000Z'),
    );
    deleteSpy.mockRestore();
    expect(await testEnv.CANONICAL_MEDIA_BUCKET.head(media.objectKey)).not.toBeNull();

    await cleanupMediaObjectWriteTombstones(
      testEnv,
      new Date('2099-08-13T11:23:00.000Z'),
    );
    expect(await testEnv.CANONICAL_MEDIA_BUCKET.head(media.objectKey)).toBeNull();
    expect(await testEnv.MEDIA_BUCKET.head(previewObjectKey)).toBeNull();
  });

  it('preserves target-verified proof until manager deletion is handed to permanent suppression', async () => {
    const access = await eventAccess();
    const uploaded = await uploadPending(access, 'manager-delete-target-verified');
    const canonicalKey = uploaded.objectKey;
    const canonical = await testEnv.CANONICAL_MEDIA_BUCKET.get(canonicalKey);
    if (!canonical?.body) throw new Error('Expected canonical fixture bytes.');
    const legacyKey = `events/${access.event.id}/media/${uploaded.id}`;
    await testEnv.MEDIA_BUCKET.put(legacyKey, canonical.body, {
      httpMetadata: { contentType: uploaded.mimeType },
    });
    await testEnv.DB.prepare('DELETE FROM media_object_promotions WHERE media_id = ?')
      .bind(uploaded.id).run();
    await testEnv.DB.exec('DROP TRIGGER IF EXISTS media_stored_legacy_guard_update;');
    await testEnv.DB.prepare(`
      UPDATE media SET object_key = ?, object_bucket_generation = 'legacy',
        reservation_expires_at = ? WHERE id = ?
    `).bind(legacyKey, '2026-08-13T09:59:00.000Z', uploaded.id).run();
    await testEnv.CANONICAL_MEDIA_BUCKET.delete(canonicalKey);

    globalThis.__CANDIDARY_TEST_MEDIA_UPLOAD_RELEASE_OVERRIDE__ = 'copy-only';
    await promoteLegacyStoredMedia(testEnv, new Date('2026-08-13T10:00:00.000Z'));
    const repository = new MediaRepository(env.DB);
    const proof = await repository.getPromotion(uploaded.id);
    expect(proof).toMatchObject({ state: 'target_verified', finalObjectKey: canonicalKey });

    const deleted = await createApp().request(
      `/api/manage/events/${access.event.id}/media/${uploaded.id}`,
      {
        method: 'PATCH',
        headers: writeHeaders(access.manager),
        body: JSON.stringify({ action: 'delete', expectedStatus: 'unpublished' }),
      },
      testEnv,
    );

    expect(deleted.status).toBe(200);
    expect(await repository.getById(uploaded.id)).toMatchObject({
      uploadState: 'deleted', deletedAt: expect.any(String),
    });
    expect(await repository.getPromotion(uploaded.id)).toEqual(proof);
    expect(await testEnv.MEDIA_BUCKET.head(legacyKey)).not.toBeNull();
    expect(await testEnv.CANONICAL_MEDIA_BUCKET.head(canonicalKey)).not.toBeNull();

    delete globalThis.__CANDIDARY_TEST_MEDIA_UPLOAD_RELEASE_OVERRIDE__;
    const handedOffAt = new Date('2099-08-13T10:21:00.000Z');
    await promoteLegacyStoredMedia(testEnv, handedOffAt);
    expect(await repository.getPromotion(uploaded.id)).toBeNull();
    await cleanupMediaObjectWriteTombstones(testEnv, handedOffAt, 100);
    expect(await testEnv.MEDIA_BUCKET.head(legacyKey)).toBeNull();
    expect(await testEnv.CANONICAL_MEDIA_BUCKET.head(canonicalKey)).toBeNull();
    const tombstones = new MediaObjectWriteTombstoneRepository(testEnv.DB);
    expect(await tombstones.get(legacyKey, 'legacy')).toMatchObject({
      suppressionStartedAt: expect.any(String),
    });
    expect(await tombstones.get(canonicalKey, 'canonical')).toMatchObject({
      suppressionStartedAt: expect.any(String),
    });
  });

  it('uses a domain refusal when a photo belongs to another event', async () => {
    const first = await eventAccess();
    const second = await eventAccess();
    const media = await uploadPending(second, 'foreign-photo');

    const response = await createApp().request(
      `/api/manage/events/${first.event.id}/media/${media.id}`,
      {
        method: 'PATCH',
        headers: writeHeaders(first.manager),
        body: JSON.stringify({ action: 'delete', expectedStatus: 'unpublished' }),
      },
      testEnv,
    );

    expect(response.status).toBe(403);
    expect((await response.json<any>()).code).toBe('RESOURCE_FORBIDDEN');
  });
});

describe('access link rotation', () => {
  it('redisplays the printed event entry without exposing it to guests', async () => {
    const access = await eventAccess();
    const response = await createApp().request(`/api/manage/events/${access.event.id}/entry`, {
      headers: { cookie: access.manager.cookie },
    }, testEnv);
    expect(response.status).toBe(200);
    expect((await response.json<any>()).data).toEqual({
      eventLink: access.eventLink,
      disabledAt: null,
    });

    const denied = await createApp().request(`/api/manage/events/${access.event.id}/entry`, {
      headers: { cookie: access.guest.cookie },
    }, testEnv);
    expect(denied.status).toBe(403);
  });

  it('keeps the printed entry recoverable even with no active internal grant', async () => {
    const access = await eventAccess();
    await env.DB.prepare(`
      UPDATE event_access_tokens SET revoked_at = ?
      WHERE event_id = ? AND role = 'guest' AND revoked_at IS NULL
    `).bind(new Date().toISOString(), access.event.id).run();

    const response = await createApp().request(`/api/manage/events/${access.event.id}/entry`, {
      headers: { cookie: access.manager.cookie },
    }, testEnv);

    // The two credentials are independent: whatever happens to the rotatable
    // grant, the host can still read back what is printed on the invitations.
    expect(response.status).toBe(200);
    expect((await response.json<any>()).data.eventLink).toBe(access.eventLink);
  });

  it('rotates the internal grant and invalidates every old guest session immediately', async () => {
    const access = await eventAccess();
    const rotated = await createApp().request(
      `/api/manage/events/${access.event.id}/guest-sessions/rotate`,
      {
        method: 'POST',
        headers: writeHeaders(access.manager),
        body: JSON.stringify({ confirmName: access.event.name }),
      },
      testEnv,
    );
    const body = await rotated.json<any>();
    expect(body.data.eventLink).toBe(access.eventLink);

    const oldShell = await createApp().request(`/api/event/${access.event.slug}`, {
      headers: { cookie: access.guest.cookie },
    }, testEnv);
    expect((await oldShell.json<any>()).code).toBe('TOKEN_REVOKED');

    const replacement = await secondGuest(body.data.eventLink);
    const newShell = await createApp().request(`/api/event/${access.event.slug}`, {
      headers: { cookie: replacement.cookie },
    }, testEnv);
    expect(newShell.status).toBe(200);
  });

  it('returns a one-time replacement management link and revokes the current manager session', async () => {
    const access = await eventAccess();
    await env.DB.prepare(`
      INSERT INTO host_accounts (id, email, password_hash, created_at)
      VALUES ('owner-rotation', 'owner-rotation@example.com', 'password-hash', '2026-07-28T00:00:00.000Z')
    `).run();
    await env.DB.prepare(`
      INSERT INTO event_hosts (event_id, account_id, role, created_at)
      VALUES (?, 'owner-rotation', 'owner', '2026-07-28T00:00:00.000Z')
    `).bind(access.event.id).run();
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

  it('keeps a live creator recovery path intact instead of rotating its manager link', async () => {
    const access = await eventAccess();

    const blocked = await createApp().request(`/api/manage/events/${access.event.id}/links/manager/rotate`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);

    expect(blocked.status).toBe(409);
    expect((await blocked.json<any>()).code).toBe('OWNER_CLAIM_REQUIRED');

    const originalSession = await createApp().request(`/api/manage/events/${access.event.id}`, {
      headers: { cookie: access.manager.cookie },
    }, testEnv);
    expect(originalSession.status).toBe(200);

    const exchanged = await createApp().request(new URL(access.managementLink).pathname, {
      redirect: 'manual',
    }, testEnv);
    const exchangedSession = await createApp().request(`/api/manage/events/${access.event.id}`, {
      headers: { cookie: cookiesFrom(exchanged).cookie },
    }, testEnv);
    expect(exchangedSession.status).toBe(200);
  });

  it('allows rotation after the creator session expires and no legacy claim remains', async () => {
    const access = await eventAccess();
    await env.DB.prepare(`
      UPDATE event_sessions SET expires_at = ?
      WHERE event_id = ? AND role = 'manager' AND can_claim_owner = 1
    `).bind(new Date(Date.now() - 1_000).toISOString(), access.event.id).run();
    await env.DB.prepare('UPDATE events SET legacy_owner_claim_open = 0 WHERE id = ?')
      .bind(access.event.id).run();

    const exchanged = await createApp().request(new URL(access.managementLink).pathname, {
      redirect: 'manual',
    }, testEnv);
    const freshManager = cookiesFrom(exchanged);
    const rotated = await createApp().request(`/api/manage/events/${access.event.id}/links/manager/rotate`, {
      method: 'POST', headers: writeHeaders(freshManager), body: '{}',
    }, testEnv);

    expect(rotated.status).toBe(200);
    expect((await rotated.json<any>()).data.managementLink).not.toBe(access.managementLink);
  });

  it('continues rotating an event that already has a durable owner', async () => {
    const access = await eventAccess();
    await env.DB.prepare(`
      INSERT INTO host_accounts (id, email, password_hash, created_at)
      VALUES ('owner-a', 'owner@example.com', 'password-hash', '2026-07-28T00:00:00.000Z')
    `).run();
    await env.DB.prepare(`
      INSERT INTO event_hosts (event_id, account_id, role, created_at)
      VALUES (?, 'owner-a', 'owner', '2026-07-28T00:00:00.000Z')
    `).bind(access.event.id).run();

    const rotated = await createApp().request(`/api/manage/events/${access.event.id}/links/manager/rotate`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);

    expect(rotated.status).toBe(200);
  });

  it('keeps legacy ownerless events recoverable instead of rotating their manager links', async () => {
    const access = await eventAccess();
    await env.DB.prepare(`
      UPDATE event_sessions SET expires_at = ?
      WHERE event_id = ? AND role = 'manager' AND can_claim_owner = 1
    `).bind(new Date(Date.now() - 1_000).toISOString(), access.event.id).run();
    await env.DB.prepare('UPDATE events SET legacy_owner_claim_open = 1 WHERE id = ?')
      .bind(access.event.id).run();
    const exchanged = await createApp().request(new URL(access.managementLink).pathname, {
      redirect: 'manual',
    }, testEnv);
    const freshManager = cookiesFrom(exchanged);
    const freshSessionId = /candidary_session=([^;]+)/u.exec(freshManager.cookie)?.[1]?.split('.')[0];
    if (!freshSessionId) throw new Error('Expected a fresh manager session.');
    expect(await env.DB.prepare(`
      SELECT can_claim_owner FROM event_sessions WHERE id = ?
    `).bind(freshSessionId).first('can_claim_owner')).toBe(0);
    expect(await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM event_sessions
      WHERE event_id = ? AND can_claim_owner = 1
        AND revoked_at IS NULL AND expires_at > ?
    `).bind(access.event.id, new Date().toISOString()).first('count')).toBe(0);

    const blocked = await createApp().request(`/api/manage/events/${access.event.id}/links/manager/rotate`, {
      method: 'POST', headers: writeHeaders(freshManager), body: '{}',
    }, testEnv);

    expect(blocked.status).toBe(409);
    expect((await blocked.json<any>()).code).toBe('OWNER_CLAIM_REQUIRED');
  });

  it('does not treat a cohost as durable ownership while creator recovery remains live', async () => {
    const access = await eventAccess();
    await env.DB.prepare(`
      INSERT INTO host_accounts (id, email, password_hash, created_at)
      VALUES ('cohost-a', 'cohost@example.com', 'password-hash', '2026-07-28T00:00:00.000Z')
    `).run();
    await env.DB.prepare(`
      INSERT INTO event_hosts (event_id, account_id, role, created_at)
      VALUES (?, 'cohost-a', 'cohost', '2026-07-28T00:00:00.000Z')
    `).bind(access.event.id).run();

    const blocked = await createApp().request(`/api/manage/events/${access.event.id}/links/manager/rotate`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);

    expect(blocked.status).toBe(409);
    expect((await blocked.json<any>()).code).toBe('OWNER_CLAIM_REQUIRED');

    const originalSession = await createApp().request(`/api/manage/events/${access.event.id}`, {
      headers: { cookie: access.manager.cookie },
    }, testEnv);
    expect(originalSession.status).toBe(200);
    const exchanged = await createApp().request(new URL(access.managementLink).pathname, {
      redirect: 'manual',
    }, testEnv);
    const exchangedSession = await createApp().request(`/api/manage/events/${access.event.id}`, {
      headers: { cookie: cookiesFrom(exchanged).cookie },
    }, testEnv);
    expect(exchangedSession.status).toBe(200);
  });
});

describe('host-initiated event deletion', () => {
  it('soft-deletes and revokes without sweeping either bucket in Candidate A', async () => {
    globalThis.__CANDIDARY_TEST_MEDIA_UPLOAD_RELEASE_OVERRIDE__ = false;
    const access = await eventAccess();
    const legacyKey = `events/${access.event.id}/uploads/candidate-a-late`;
    const canonicalKey = `events/${access.event.id}/media/final/candidate-a-final`;
    await testEnv.MEDIA_BUCKET.put(legacyKey, png());
    await testEnv.CANONICAL_MEDIA_BUCKET.put(canonicalKey, png());

    const response = await createApp().request(`/api/manage/events/${access.event.id}`, {
      method: 'DELETE',
      headers: writeHeaders(access.manager),
      body: JSON.stringify({ confirmation: access.event.name }),
    }, testEnv);

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      data: { deletionScheduled: true },
      requestId: expect.any(String),
    });
    expect(await testEnv.DB.prepare('SELECT deleted_at FROM events WHERE id = ?')
      .bind(access.event.id).first()).toMatchObject({ deleted_at: expect.any(String) });
    expect(await testEnv.MEDIA_BUCKET.head(legacyKey)).not.toBeNull();
    expect(await testEnv.CANONICAL_MEDIA_BUCKET.head(canonicalKey)).not.toBeNull();
    expect(await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM event_access_tokens
      WHERE event_id = ? AND revoked_at IS NULL
    `).bind(access.event.id).first<number>('count')).toBe(0);
  });

  it('returns the exact scheduled-deletion contract while a fence remains parked', async () => {
    const access = await eventAccess();
    const graph = await seedEventCoverGraph(testEnv.DB, access.event.id);
    const claimedAt = new Date().toISOString();
    await testEnv.DB.prepare(`
      UPDATE event_cover_publish_receipts
      SET status = 'queued', dispatch_state = 'creating', last_dispatch_at = ?, updated_at = ?
      WHERE event_id = ? AND operation_id = ?
    `).bind(claimedAt, claimedAt, access.event.id, graph.operationId).run();
    await testEnv.MEDIA_BUCKET.put(`events/${access.event.id}/cover/held.webp`, png());

    const response = await createApp().request(`/api/manage/events/${access.event.id}`, {
      method: 'DELETE',
      headers: writeHeaders(access.manager),
      body: JSON.stringify({ confirmation: access.event.name }),
    }, testEnv);

    expect(response.status).toBe(202);
    const body = await response.json<Record<string, unknown>>();
    expect(body).toEqual({
      data: { deletionScheduled: true },
      requestId: expect.any(String),
    });
    expect(await testEnv.DB.prepare('SELECT deleted_at FROM events WHERE id = ?')
      .bind(access.event.id).first()).toMatchObject({ deleted_at: expect.any(String) });
    expect((await testEnv.MEDIA_BUCKET.list({ prefix: `events/${access.event.id}/` })).objects.length)
      .toBeGreaterThan(0);
  });

  it('needs the exact event name and leaves nothing of the event behind', async () => {
    const access = await eventAccess();
    await uploadPending(access, 'keeper');
    await testEnv.MEDIA_BUCKET.put(`events/${access.event.id}/media/extra`, png());

    const refused = await createApp().request(`/api/manage/events/${access.event.id}`, {
      method: 'DELETE',
      headers: writeHeaders(access.manager),
      body: JSON.stringify({ confirmation: 'maya & theo' }),
    }, testEnv);
    expect(refused.status).toBe(422);
    expect(await testEnv.DB.prepare('SELECT id FROM events WHERE id = ?')
      .bind(access.event.id).first()).not.toBeNull();

    const deleted = await createApp().request(`/api/manage/events/${access.event.id}`, {
      method: 'DELETE',
      headers: writeHeaders(access.manager),
      body: JSON.stringify({ confirmation: access.event.name }),
    }, testEnv);
    expect(deleted.status).toBe(202);
    expect(await deleted.json()).toEqual({
      data: { deletionScheduled: true },
      requestId: expect.any(String),
    });

    await promoteLegacyStoredMedia(testEnv, new Date('2099-08-13T10:21:00.000Z'));
    expect(await deleteEventData(
      testEnv,
      access.event.id,
      new Date('2099-08-13T10:22:00.000Z'),
    )).toMatchObject({ phase: 'complete', remainder: false });

    // The row is gone rather than soft-deleted, so a purge that already ran does
    // not leave the event waiting for a later scheduled pass.
    expect(await testEnv.DB.prepare('SELECT id FROM events WHERE id = ?')
      .bind(access.event.id).first()).toBeNull();
    expect((await testEnv.MEDIA_BUCKET.list({ prefix: `events/${access.event.id}/` })).objects)
      .toHaveLength(0);
    expect((await testEnv.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);

    // The manager's own session cascaded away with the event, so the credential
    // is refused rather than answering that this particular event once existed.
    const reread = await createApp().request(`/api/manage/events/${access.event.id}`, {
      headers: { cookie: access.manager.cookie },
    }, testEnv);
    expect(reread.status).toBe(401);
  });
});

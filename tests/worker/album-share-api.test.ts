import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AlbumShareView, PublicAlbumView } from '../../shared/contracts';
import { createApp } from '../../worker/app';
import {
  eventAccess,
  origin,
  resetDatabase,
  testEnv,
  uploadPending,
  withRecordingImages,
  writeHeaders,
} from './helpers';

beforeEach(resetDatabase);

type Access = Awaited<ReturnType<typeof eventAccess>>;
type ShareEnvelope = { data: { share: AlbumShareView | null }; requestId: string };
type AlbumEnvelope = { data: { album: PublicAlbumView }; requestId: string };

const NOW = '2026-08-23T12:00:00.000Z';

interface SeedPhotoOptions {
  caption?: string | null;
  favorited?: boolean;
  publicationStatus?: 'unpublished' | 'published' | 'hidden';
}

async function seedPhoto(access: Access, options: SeedPhotoOptions = {}) {
  const key = `album-share-${crypto.randomUUID()}`;
  const media = await uploadPending(
    access,
    key,
    options.caption ?? 'First dance',
    'Private Contributor',
  );
  await env.DB.prepare(`
    UPDATE media
    SET publication_status = ?, favorited_at = ?, timeline_at = ?
    WHERE id = ?
  `).bind(
    options.publicationStatus ?? 'unpublished',
    options.favorited === false ? null : NOW,
    NOW,
    media.id,
  ).run();
  return media.id;
}

async function saveAlbum(
  access: Access,
  photoIds: readonly string[],
  options: { title?: string; description?: string; coverMediaId?: string | null } = {},
) {
  const entries = [
    ...(photoIds.length > 1 ? [{ kind: 'section', id: 'ceremony', heading: 'Ceremony' }] : []),
    ...photoIds.map((mediaId) => ({ kind: 'photo', mediaId })),
  ];
  await env.DB.prepare(`
    INSERT INTO event_albums (
      event_id, entries, saved_at, revision, title, description, cover_media_id,
      created_at, updated_at
    ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
  `).bind(
    access.event.id,
    JSON.stringify(entries),
    NOW,
    options.title ?? 'The evening',
    options.description ?? 'The photographs we kept together.',
    options.coverMediaId ?? photoIds[0] ?? null,
    NOW,
    NOW,
  ).run();
}

async function shareableAlbum(access: Access, count = 1) {
  const photoIds: string[] = [];
  for (let index = 0; index < count; index += 1) {
    photoIds.push(await seedPhoto(access, {
      caption: index === 0 ? 'First dance' : 'After dinner',
      publicationStatus: index === 0 ? 'unpublished' : 'published',
    }));
  }
  await saveAlbum(access, photoIds, { coverMediaId: photoIds.at(-1) ?? null });
  return photoIds;
}

function managerShare(access: Access, method: 'GET' | 'POST' | 'DELETE' = 'POST') {
  return createApp().request(`/api/manage/events/${access.event.id}/album/share`, {
    method,
    headers: method === 'GET'
      ? { cookie: access.manager.cookie }
      : writeHeaders(access.manager),
  }, testEnv);
}

function fragment(url: string): string {
  return new URL(url).hash.slice(1);
}

function exchange(token: string, requestOrigin: string = origin) {
  return createApp().request('/api/album-share/exchange', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: requestOrigin },
    body: JSON.stringify({ token }),
  }, testEnv);
}

function albumCookie(response: Response): { cookie: string; token: string; setCookie: string } {
  const setCookie = response.headers.get('set-cookie') ?? '';
  const token = /candidary_album=([^;,]+)/u.exec(setCookie)?.[1];
  if (!token) throw new Error(`Expected the narrow album cookie, received: ${setCookie}`);
  return { cookie: `candidary_album=${token}`, token, setCookie };
}

function publicAlbum(cookie: string) {
  return createApp().request('/api/album-share', { headers: { cookie } }, testEnv);
}

async function enabledShare(access: Access): Promise<AlbumShareView> {
  const response = await managerShare(access);
  expect(response.status).toBe(200);
  const body = await response.json<ShareEnvelope>();
  if (!body.data.share) throw new Error('Expected sharing to be enabled.');
  return body.data.share;
}

async function unavailableShape(response: Response) {
  const body = await response.json<{ code: string; message: string }>();
  return {
    status: response.status,
    code: body.code,
    message: body.message,
    cacheControl: response.headers.get('cache-control'),
  };
}

describe('manager album sharing', () => {
  it('requires manager authority, event ownership, Origin, and the accepted manager CSRF pair', async () => {
    const access = await eventAccess();
    const other = await eventAccess('Other event');
    await shareableAlbum(access);

    const missing = await createApp().request(
      `/api/manage/events/${access.event.id}/album/share`,
      {},
      testEnv,
    );
    expect(missing.status).toBe(401);

    const noCsrf = await createApp().request(
      `/api/manage/events/${access.event.id}/album/share`,
      { method: 'POST', headers: { cookie: access.manager.cookie } },
      testEnv,
    );
    expect(noCsrf.status).toBe(403);

    const foreign = await createApp().request(
      `/api/manage/events/${access.event.id}/album/share`,
      { headers: { cookie: other.manager.cookie } },
      testEnv,
    );
    expect(foreign.status).toBe(403);

    expect((await managerShare(access)).status).toBe(200);
  });

  it('refuses both an unsaved album and a saved album with no live photos', async () => {
    const unsaved = await eventAccess('Unsaved album');
    await seedPhoto(unsaved);
    expect((await managerShare(unsaved)).status).toBe(409);

    const empty = await eventAccess('Empty album');
    await saveAlbum(empty, []);
    expect((await managerShare(empty)).status).toBe(409);
  });

  it('enables idempotently and recovers one stable fragment link without storing its raw secret', async () => {
    const access = await eventAccess();
    const [photoId] = await shareableAlbum(access);

    const first = await enabledShare(access);
    const second = await enabledShare(access);
    const recoveredResponse = await managerShare(access, 'GET');
    const recovered = (await recoveredResponse.json<ShareEnvelope>()).data.share;

    expect(second).toEqual(first);
    expect(recovered).toEqual(first);
    expect(first.active).toBe(true);
    expect(new URL(first.url)).toMatchObject({
      origin,
      pathname: '/album',
      search: '',
    });
    expect(fragment(first.url)).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);

    const [id, rawSecret] = fragment(first.url).split('.');
    const row = await env.DB.prepare(`
      SELECT id, event_id, secret_digest, secret_ciphertext FROM event_album_shares
      WHERE event_id = ?
    `).bind(access.event.id).first<{
      id: string;
      event_id: string;
      secret_digest: string;
      secret_ciphertext: string;
    }>();
    expect(row).toMatchObject({ id, event_id: access.event.id });
    expect(row?.secret_digest).not.toBe(rawSecret);
    expect(row?.secret_ciphertext).not.toContain(rawSecret);
    expect(JSON.stringify(row)).not.toContain(fragment(first.url));
    expect(await env.DB.prepare('SELECT publication_status FROM media WHERE id = ?')
      .bind(photoId).first<string>('publication_status')).toBe('unpublished');
  });

  it('stops immediately, cascades live sessions, and rotates both id and secret when shared again', async () => {
    const access = await eventAccess();
    const [photoId] = await shareableAlbum(access);
    const first = await enabledShare(access);
    const exchanged = await exchange(fragment(first.url));
    const session = albumCookie(exchanged);
    expect((await publicAlbum(session.cookie)).status).toBe(200);

    const stopped = await managerShare(access, 'DELETE');
    expect(stopped.status).toBe(200);
    expect((await stopped.json<ShareEnvelope>()).data.share).toBeNull();
    expect(await env.DB.prepare('SELECT count(*) AS count FROM event_album_shares')
      .first<number>('count')).toBe(0);
    expect(await env.DB.prepare('SELECT count(*) AS count FROM event_album_share_sessions')
      .first<number>('count')).toBe(0);
    expect((await publicAlbum(session.cookie)).status).toBe(410);
    expect((await exchange(fragment(first.url))).status).toBe(410);

    const second = await enabledShare(access);
    expect(fragment(second.url)).not.toBe(fragment(first.url));
    expect(fragment(second.url).split('.')[0]).not.toBe(fragment(first.url).split('.')[0]);
    expect(await env.DB.prepare('SELECT favorited_at FROM media WHERE id = ?')
      .bind(photoId).first<string>('favorited_at')).toBe(NOW);
    expect(await env.DB.prepare('SELECT publication_status FROM media WHERE id = ?')
      .bind(photoId).first<string>('publication_status')).toBe('unpublished');
  });
});

describe('public album exchange and projection', () => {
  it('rejects exchange from a foreign Origin before minting any session', async () => {
    const access = await eventAccess();
    await shareableAlbum(access);
    const share = await enabledShare(access);

    const refused = await exchange(fragment(share.url), 'https://evil.test');

    expect(refused.status).toBe(403);
    expect(await env.DB.prepare('SELECT count(*) AS count FROM event_album_share_sessions')
      .first<number>('count')).toBe(0);
  });

  it('makes malformed, wrong, revoked, deleted-event, and purged credentials indistinguishable', async () => {
    const active = await eventAccess('Active share');
    const other = await eventAccess('Other secret');
    const revoked = await eventAccess('Revoked share');
    const deleted = await eventAccess('Deleted share');
    const purged = await eventAccess('Purged share');
    for (const access of [active, other, revoked, deleted, purged]) await shareableAlbum(access);
    const activeShare = await enabledShare(active);
    const otherShare = await enabledShare(other);
    const revokedShare = await enabledShare(revoked);
    const deletedShare = await enabledShare(deleted);
    const purgedShare = await enabledShare(purged);
    await managerShare(revoked, 'DELETE');
    await env.DB.prepare('UPDATE events SET deleted_at = ? WHERE id = ?')
      .bind(NOW, deleted.event.id).run();
    await env.DB.prepare('UPDATE events SET purge_after = ? WHERE id = ?')
      .bind('2020-01-01T00:00:00.000Z', purged.event.id).run();

    const [activeId] = fragment(activeShare.url).split('.');
    const wrongSecret = fragment(otherShare.url).split('.')[1];
    const cases = [
      exchange('not-a-token'),
      exchange(`${activeId}.${wrongSecret}`),
      exchange(fragment(revokedShare.url)),
      exchange(fragment(deletedShare.url)),
      exchange(fragment(purgedShare.url)),
    ];
    const shapes = await Promise.all((await Promise.all(cases)).map(unavailableShape));

    expect(new Set(shapes.map((shape) => JSON.stringify(shape)))).toHaveLength(1);
    expect(shapes[0]).toEqual({
      status: 410,
      code: 'ALBUM_SHARE_UNAVAILABLE',
      message: 'This album is not available.',
      cacheControl: 'private, no-store',
    });
  });

  it('returns only the allowlisted live album and puts the session in one narrow cookie', async () => {
    const access = await eventAccess();
    const photoIds = await shareableAlbum(access, 2);
    const share = await enabledShare(access);
    const response = await exchange(fragment(share.url));
    const body = await response.json<AlbumEnvelope>();
    const session = albumCookie(response);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(session.setCookie).toMatch(/Path=\/api\/album-share/iu);
    expect(session.setCookie).toMatch(/HttpOnly/iu);
    expect(session.setCookie).toMatch(/Secure/iu);
    expect(session.setCookie).toMatch(/SameSite=Strict/iu);
    expect(Object.keys(body.data.album).sort()).toEqual([
      'coverMediaId', 'description', 'entries', 'photoCount', 'title',
    ]);
    expect(body.data.album).toEqual({
      title: 'The evening',
      description: 'The photographs we kept together.',
      coverMediaId: photoIds[1],
      photoCount: 2,
      entries: [
        { kind: 'section', id: 'ceremony', heading: 'Ceremony' },
        { kind: 'photo', photo: { id: photoIds[0], caption: 'First dance', previewAvailable: true } },
        { kind: 'photo', photo: { id: photoIds[1], caption: 'After dinner', previewAvailable: true } },
      ],
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(fragment(share.url));
    expect(serialized).not.toContain(session.token);
    expect(serialized).not.toMatch(/album-share-|Private Contributor|publication|favorite|revision|object_key|timeline/iu);

    const reloaded = await publicAlbum(session.cookie);
    expect(reloaded.status).toBe(200);
    expect(reloaded.headers.get('cache-control')).toBe('private, no-store');
    expect((await reloaded.json<AlbumEnvelope>()).data.album).toEqual(body.data.album);
    expect(await env.DB.prepare(`
      SELECT publication_status FROM media WHERE id IN (?, ?) ORDER BY id
    `).bind(...photoIds).all()).toMatchObject({
      results: expect.arrayContaining([
        { publication_status: 'unpublished' },
        { publication_status: 'published' },
      ]),
    });
  });

  it('stores only a session digest and expires it no later than seven days', async () => {
    const access = await eventAccess();
    await shareableAlbum(access);
    const share = await enabledShare(access);
    const before = Date.now();
    const response = await exchange(fragment(share.url));
    const after = Date.now();
    const session = albumCookie(response);
    const [sessionId, rawSecret] = session.token.split('.');
    const row = await env.DB.prepare(`
      SELECT id, secret_digest, expires_at FROM event_album_share_sessions WHERE id = ?
    `).bind(sessionId).first<{ id: string; secret_digest: string; expires_at: string }>();

    expect(row?.secret_digest).not.toBe(rawSecret);
    expect(JSON.stringify(row)).not.toContain(session.token);
    expect(Date.parse(row!.expires_at)).toBeGreaterThanOrEqual(before + (7 * 24 * 60 * 60 * 1000));
    expect(Date.parse(row!.expires_at)).toBeLessThanOrEqual(after + (7 * 24 * 60 * 60 * 1000));
  });

  it('caps a new session at the event purge boundary when it comes first', async () => {
    const access = await eventAccess();
    await shareableAlbum(access);
    const share = await enabledShare(access);
    const purgeAt = new Date(Date.now() + (2 * 24 * 60 * 60 * 1000)).toISOString();
    await env.DB.prepare('UPDATE events SET purge_after = ? WHERE id = ?')
      .bind(purgeAt, access.event.id).run();

    const response = await exchange(fragment(share.url));
    const [sessionId] = albumCookie(response).token.split('.');
    expect(await env.DB.prepare(`
      SELECT expires_at FROM event_album_share_sessions WHERE id = ?
    `).bind(sessionId).first<string>('expires_at')).toBe(purgeAt);
  });
});

describe('public album preview authorization', () => {
  it('serves only the preview representation with private no-store image headers', async () => {
    const access = await eventAccess();
    const [photoId] = await shareableAlbum(access);
    const share = await enabledShare(access);
    const session = albumCookie(await exchange(fragment(share.url)));
    const { env: previewEnv } = withRecordingImages({
      encode: () => ({
        bytes: new Uint8Array([9, 8, 7]),
        width: 800,
        height: 600,
        contentType: 'image/webp',
      }),
    });

    const response = await createApp().request(
      `/api/album-share/media/${photoId}/preview`,
      { headers: { cookie: session.cookie } },
      previewEnv,
    );

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]));
    expect(response.headers.get('content-type')).toBe('image/webp');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(response.headers.get('content-disposition')).toBeNull();
  });

  it('removes an unpicked or deleted photo from both JSON and preview access immediately', async () => {
    const access = await eventAccess();
    const photoIds = await shareableAlbum(access, 2);
    const share = await enabledShare(access);
    const session = albumCookie(await exchange(fragment(share.url)));

    await env.DB.prepare('UPDATE media SET favorited_at = NULL WHERE id = ?')
      .bind(photoIds[0]).run();
    const afterUnpick = await publicAlbum(session.cookie);
    const unpickedAlbum = (await afterUnpick.json<AlbumEnvelope>()).data.album;
    expect(unpickedAlbum.entries).toEqual([
      { kind: 'section', id: 'ceremony', heading: 'Ceremony' },
      { kind: 'photo', photo: { id: photoIds[1], caption: 'After dinner', previewAvailable: true } },
    ]);
    expect(unpickedAlbum.coverMediaId).toBe(photoIds[1]);
    expect((await createApp().request(
      `/api/album-share/media/${photoIds[0]}/preview`,
      { headers: { cookie: session.cookie } },
      testEnv,
    )).status).toBe(410);

    await env.DB.prepare(`
      UPDATE media SET upload_state = 'deleted', deleted_at = ? WHERE id = ?
    `).bind(NOW, photoIds[1]).run();
    const afterDelete = await publicAlbum(session.cookie);
    expect((await afterDelete.json<AlbumEnvelope>()).data.album).toMatchObject({
      coverMediaId: null,
      photoCount: 0,
      entries: [{ kind: 'section', id: 'ceremony', heading: 'Ceremony' }],
    });
    expect((await createApp().request(
      `/api/album-share/media/${photoIds[1]}/preview`,
      { headers: { cookie: session.cookie } },
      testEnv,
    )).status).toBe(410);
  });

  it('gives the same refusal for guessed, unpicked, and foreign photos and exposes no original route', async () => {
    const access = await eventAccess();
    const foreign = await eventAccess('Foreign photos');
    await shareableAlbum(access);
    const unpicked = await seedPhoto(access, { favorited: false });
    const foreignPhoto = await seedPhoto(foreign);
    const share = await enabledShare(access);
    const session = albumCookie(await exchange(fragment(share.url)));
    const preview = (id: string) => createApp().request(
      `/api/album-share/media/${id}/preview`,
      { headers: { cookie: session.cookie } },
      testEnv,
    );
    const responses = await Promise.all([
      preview(crypto.randomUUID()),
      preview(unpicked),
      preview(foreignPhoto),
    ]);
    const shapes = await Promise.all(responses.map(unavailableShape));

    expect(new Set(shapes.map((shape) => JSON.stringify(shape)))).toHaveLength(1);
    expect(shapes[0]?.code).toBe('ALBUM_SHARE_UNAVAILABLE');

    const original = await createApp().request(
      `/api/album-share/media/${unpicked}/original`,
      { headers: { cookie: session.cookie } },
      testEnv,
    );
    expect(original.status).toBe(404);
    expect(original.headers.get('content-disposition')).toBeNull();
  });
});

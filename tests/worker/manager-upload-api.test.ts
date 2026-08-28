import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../worker/app';
import { AccountsRepository } from '../../worker/db/accounts';
import { EventsRepository } from '../../worker/db/events';
import { MediaRepository } from '../../worker/db/media';
import { LinkService } from '../../worker/services/links';
import { receiveMediaUpload } from '../../worker/storage/media';
import { finalizedMediaObjectKey } from '../../worker/storage/media-keys';
import { MANAGER_UPLOAD_RESOURCE_FORBIDDEN_ERROR } from '../fixtures/manager-upload-errors';
import {
  cookiesFrom,
  eventAccess,
  hostAccess,
  hostWriteHeaders,
  origin,
  png,
  resetDatabase,
  testEnv,
  writeHeaders,
} from './helpers';

type EventAccess = Awaited<ReturnType<typeof eventAccess>>;
type Credential = { cookie: string; csrf: string };

const uploadFile = {
  filename: 'manager-photo.png',
  mimeType: 'image/png',
  byteSize: 64,
  idempotencyKey: 'manager-photo',
  caption: 'From the host table',
};

beforeEach(resetDatabase);
afterEach(() => vi.restoreAllMocks());

function expectPrivate(response: Response) {
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('vary')).toBe('Cookie');
}

function keysOf(value: unknown) {
  return Object.keys(value as object).sort();
}

function actorRows(eventId: string) {
  return env.DB.prepare(`
    SELECT id, manager_upload_account_id
    FROM event_sessions
    WHERE event_id = ? AND manager_upload_account_id IS NOT NULL
    ORDER BY manager_upload_account_id
  `).bind(eventId).all<{ id: string; manager_upload_account_id: string }>();
}

function mediaRow(mediaId: string) {
  return env.DB.prepare('SELECT * FROM media WHERE id = ?')
    .bind(mediaId).first<Record<string, unknown>>();
}

function uploadCounters(eventId: string) {
  return env.DB.prepare(`
    SELECT reserved_media_count, reserved_bytes, stored_media_count, stored_bytes
    FROM events WHERE id = ?
  `).bind(eventId).first<Record<string, number>>();
}

function managerBatch(
  eventId: string,
  headers: Record<string, string>,
  body: unknown = { files: [uploadFile] },
) {
  return createApp().request(`/api/manage/events/${eventId}/uploads/batch`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }, testEnv);
}

async function reserveManager(
  access: EventAccess,
  headers: Record<string, string> = writeHeaders(access.manager),
  key = 'manager-photo',
) {
  const response = await managerBatch(access.event.id, headers, {
    files: [{ ...uploadFile, idempotencyKey: key }],
  });
  const body = await response.json<any>();
  if (response.status !== 201) {
    throw new Error(`Manager reservation failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return { response, body, item: body.data.items[0] as any };
}

function managerContent(
  access: EventAccess,
  mediaId: string,
  headers: Record<string, string> = writeHeaders(access.manager),
  bytes = png(),
  appEnv = testEnv,
) {
  return createApp().request(
    `/api/manage/events/${access.event.id}/uploads/${mediaId}/content`,
    {
      method: 'PUT',
      headers: {
        ...headers,
        'content-type': 'image/png',
        'content-length': String(bytes.byteLength),
      },
      body: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
    },
    appEnv,
  );
}

async function exchangeManagerLink(managementLink: string): Promise<Credential> {
  const exchanged = await createApp().request(new URL(managementLink).pathname, {
    headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' },
  }, testEnv);
  if (exchanged.status !== 302) {
    throw new Error(`Manager link exchange failed: ${exchanged.status} ${await exchanged.text()}`);
  }
  return cookiesFrom(exchanged);
}

async function addCohost(access: EventAccess) {
  const host = await hostAccess();
  await new AccountsRepository(env.DB).addEventHost(
    access.event.id,
    host.account.id,
    'cohost',
    new Date().toISOString(),
  );
  return host;
}

describe('Manager upload route contract', () => {
  it('reserves through a current link, account owner, account cohost, and account-precedence cookies', async () => {
    const access = await eventAccess();
    const owner = await hostAccess([access]);
    const cohost = await addCohost(access);
    const cases = [
      { label: 'link', headers: writeHeaders(access.manager), accountId: null },
      { label: 'owner', headers: hostWriteHeaders(owner), accountId: owner.account.id },
      { label: 'cohost', headers: hostWriteHeaders(cohost), accountId: cohost.account.id },
      {
        label: 'both-cookie-owner',
        headers: hostWriteHeaders(owner, access.manager.cookie),
        accountId: owner.account.id,
      },
    ];

    for (const testCase of cases) {
      const { response, item } = await reserveManager(
        access,
        testCase.headers,
        `accepted-${testCase.label}`,
      );
      expect([testCase.label, response.status]).toEqual([testCase.label, 201]);
      expectPrivate(response);
      expect(keysOf(item)).toEqual([
        'alreadyDelivered',
        'idempotencyKey',
        'media',
        'status',
        'uploadUrl',
        'uploadUrlExpiresAt',
      ]);
      expect(keysOf(item.media)).toEqual(['id', 'mimeType', 'uploadState']);
      expect(item.uploadUrl).toBe(
        `/api/manage/events/${access.event.id}/uploads/${item.media.id}/content`,
      );
      expect(await mediaRow(item.media.id)).toMatchObject({
        event_id: access.event.id,
        guest_name: 'Host',
        caption: uploadFile.caption,
        upload_state: 'reserved',
      });
      const persisted = await mediaRow(item.media.id);
      if (testCase.accountId === null) {
        expect((await env.DB.prepare(`
          SELECT manager_upload_account_id FROM event_sessions WHERE id = ?
        `).bind(persisted?.uploader_session_id).first('manager_upload_account_id')))
          .toBeNull();
      } else {
        expect((await env.DB.prepare(`
          SELECT manager_upload_account_id FROM event_sessions WHERE id = ?
        `).bind(persisted?.uploader_session_id).first('manager_upload_account_id')))
          .toBe(testCase.accountId);
      }
    }

    expect((await actorRows(access.event.id)).results.map((row) => row.manager_upload_account_id))
      .toEqual([owner.account.id, cohost.account.id].sort());
  });

  it('lets an account owner deliver and finalize while a cohost cancels their own reservation', async () => {
    const access = await eventAccess();
    const owner = await hostAccess([access]);
    const cohost = await addCohost(access);
    const ownerHeaders = hostWriteHeaders(owner);
    const cohostHeaders = hostWriteHeaders(cohost);
    const delivered = await reserveManager(access, ownerHeaders, 'owner-later-phase');
    const content = await managerContent(
      access,
      delivered.item.media.id,
      ownerHeaders,
    );
    const finalized = await createApp().request(
      `/api/manage/events/${access.event.id}/uploads/${delivered.item.media.id}/finalize`,
      { method: 'POST', headers: ownerHeaders, body: '{}' },
      testEnv,
    );
    const abandoned = await reserveManager(access, cohostHeaders, 'cohost-cancel');
    const canceled = await createApp().request(
      `/api/manage/events/${access.event.id}/uploads/${abandoned.item.media.id}`,
      { method: 'DELETE', headers: cohostHeaders, body: '{}' },
      testEnv,
    );

    for (const response of [
      delivered.response,
      content,
      finalized,
      abandoned.response,
      canceled,
    ]) {
      expectPrivate(response);
    }
    expect([content.status, finalized.status, canceled.status]).toEqual([200, 200, 200]);
    expect((await finalized.json<any>()).data.media).toEqual({
      id: delivered.item.media.id,
      mimeType: 'image/png',
      uploadState: 'stored',
    });
    expect((await canceled.json<any>()).data.media).toEqual({
      id: abandoned.item.media.id,
      mimeType: 'image/png',
      uploadState: 'deleted',
    });
    expect(await mediaRow(delivered.item.media.id)).toMatchObject({
      guest_name: 'Host',
      upload_state: 'stored',
      deleted_at: null,
    });
    expect(await mediaRow(abandoned.item.media.id)).toMatchObject({
      guest_name: 'Host',
      upload_state: 'deleted',
    });
    expect(await uploadCounters(access.event.id)).toEqual({
      reserved_media_count: 0,
      reserved_bytes: 0,
      stored_media_count: 1,
      stored_bytes: 64,
    });
    expect((await actorRows(access.event.id)).results.map((row) => row.manager_upload_account_id))
      .toEqual([owner.account.id, cohost.account.id].sort());
  });

  it.each([
    ['outer', 'guestName'],
    ['outer', 'accountId'],
    ['outer', 'actorId'],
    ['outer', 'eventId'],
    ['outer', 'uploadUrl'],
    ['outer', 'objectKey'],
    ['nested', 'guestName'],
    ['nested', 'accountId'],
    ['nested', 'actorId'],
    ['nested', 'eventId'],
    ['nested', 'uploadUrl'],
    ['nested', 'objectKey'],
  ] as const)('rejects an unknown %s %s field before creating an account actor', async (level, field) => {
    const access = await eventAccess();
    const owner = await hostAccess([access]);
    const body = level === 'outer'
      ? { files: [uploadFile], [field]: 'client-controlled' }
      : { files: [{ ...uploadFile, [field]: 'client-controlled' }] };

    const response = await managerBatch(access.event.id, hostWriteHeaders(owner), body);

    expect(response.status).toBe(422);
    expectPrivate(response);
    expect(await response.json<any>()).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await actorRows(access.event.id)).results).toEqual([]);
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM media')
      .first<{ count: number }>())?.count).toBe(0);
  });

  it('authenticates and checks the accepted credential scope before parsing a batch body', async () => {
    const access = await eventAccess();
    const owner = await hostAccess([access]);
    const cases: Array<{ label: string; headers: Record<string, string> }> = [
      {
        label: 'missing link CSRF',
        headers: { cookie: access.manager.cookie, origin, 'content-type': 'application/json' },
      },
      {
        label: 'invalid link CSRF',
        headers: { ...writeHeaders(access.manager), 'x-candidary-csrf': 'wrong' },
      },
      {
        label: 'wrong host scope for a link',
        headers: {
          cookie: access.manager.cookie,
          origin,
          'content-type': 'application/json',
          'x-candidary-host-csrf': access.manager.csrf,
        },
      },
      {
        label: 'wrong event scope for an account',
        headers: {
          cookie: owner.cookie,
          origin,
          'content-type': 'application/json',
          'x-candidary-csrf': owner.csrf,
        },
      },
    ];

    for (const testCase of cases) {
      const response = await managerBatch(access.event.id, testCase.headers, {
        files: 'not-an-array',
      });
      expect([testCase.label, response.status]).toEqual([testCase.label, 403]);
      expectPrivate(response);
      expect(await response.json<any>()).toMatchObject({ code: 'CSRF_INVALID' });
    }
    expect((await actorRows(access.event.id)).results).toEqual([]);
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM media')
      .first<{ count: number }>())?.count).toBe(0);
  });

  it('returns only the upload allowlist across reserve, content, finalize, cancel, and replay', async () => {
    const access = await eventAccess();
    const delivered = await reserveManager(access, undefined, 'route-delivered');
    const content = await managerContent(access, delivered.item.media.id);
    const contentBody = await content.json<any>();
    const finalized = await createApp().request(
      `/api/manage/events/${access.event.id}/uploads/${delivered.item.media.id}/finalize`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      testEnv,
    );
    const finalizedBody = await finalized.json<any>();
    const abandoned = await reserveManager(access, undefined, 'route-canceled');
    const cancelPath = `/api/manage/events/${access.event.id}/uploads/${abandoned.item.media.id}`;
    const canceled = await createApp().request(
      cancelPath,
      { method: 'DELETE', headers: writeHeaders(access.manager), body: '{}' },
      testEnv,
    );
    const canceledBody = await canceled.json<any>();
    const replay = await createApp().request(
      cancelPath,
      { method: 'DELETE', headers: writeHeaders(access.manager), body: '{}' },
      testEnv,
    );
    const replayBody = await replay.json<any>();

    expectPrivate(delivered.response);
    expectPrivate(abandoned.response);
    for (const [phase, response] of [
      ['content', content],
      ['finalize', finalized],
      ['cancel', canceled],
      ['cancel replay', replay],
    ] as const) {
      expect([phase, response.status]).toEqual([phase, 200]);
      expectPrivate(response);
    }
    for (const body of [contentBody, finalizedBody, canceledBody, replayBody]) {
      expect(keysOf(body.data.media)).toEqual(['id', 'mimeType', 'uploadState']);
      for (const forbidden of [
        'uploaderSessionId',
        'objectKey',
        'objectBucketGeneration',
        'accessTokenId',
        'accountId',
        'reservationExpiresAt',
      ]) {
        expect(JSON.stringify(body)).not.toContain(`"${forbidden}"`);
      }
    }
    expect(contentBody.data.media).toMatchObject({ uploadState: 'stored' });
    expect(finalizedBody.data.media).toEqual(contentBody.data.media);
    expect(canceledBody.data.media).toMatchObject({ uploadState: 'deleted' });
    expect(replayBody.data.media).toEqual(canceledBody.data.media);
    expect(await mediaRow(delivered.item.media.id)).toMatchObject({ guest_name: 'Host' });
    expect(await mediaRow(abandoned.item.media.id)).toMatchObject({ guest_name: 'Host' });
  });
});

describe('Manager upload authorization matrix', () => {
  it('refuses an event credential on a different event path without creating upload state', async () => {
    const source = await eventAccess('Source event');
    const target = await eventAccess('Target event');
    const before = await uploadCounters(target.event.id);

    const response = await managerBatch(
      target.event.id,
      writeHeaders(source.manager),
    );

    expect(response.status).toBe(403);
    expectPrivate(response);
    expect(await response.json<any>()).toMatchObject({ code: 'ROLE_FORBIDDEN' });
    expect((await actorRows(source.event.id)).results).toEqual([]);
    expect((await actorRows(target.event.id)).results).toEqual([]);
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM media')
      .first<{ count: number }>())?.count).toBe(0);
    expect(await uploadCounters(target.event.id)).toEqual(before);
  });

  it('uses generic RESOURCE_FORBIDDEN for guest, another account, and cross-event reservations', async () => {
    const access = await eventAccess();
    const otherEvent = await eventAccess('Other event');
    const firstAccount = await hostAccess([access]);
    const secondAccount = await addCohost(access);
    const firstReservation = await reserveManager(
      access,
      hostWriteHeaders(firstAccount),
      'first-account-row',
    );
    await reserveManager(access, hostWriteHeaders(secondAccount), 'second-account-actor');
    const guestReservation = await createApp().request(
      `/api/event/${access.event.slug}/uploads`,
      {
        method: 'POST',
        headers: writeHeaders(access.guest),
        body: JSON.stringify({ ...uploadFile, guestName: 'Avery', idempotencyKey: 'guest-row' }),
      },
      testEnv,
    );
    const guestMedia = (await guestReservation.json<any>()).data.media;
    const otherReservation = await reserveManager(otherEvent, undefined, 'cross-event-row');
    const probes = [
      {
        label: 'guest reservation',
        mediaId: guestMedia.id,
        headers: writeHeaders(access.manager),
      },
      {
        label: 'another account actor',
        mediaId: firstReservation.item.media.id,
        headers: hostWriteHeaders(secondAccount),
      },
      {
        label: 'cross-event reservation',
        mediaId: otherReservation.item.media.id,
        headers: writeHeaders(access.manager),
      },
    ];

    for (const probe of probes) {
      for (const method of ['PUT', 'POST', 'DELETE'] as const) {
        const suffix = method === 'PUT' ? '/content' : method === 'POST' ? '/finalize' : '';
        const response = await createApp().request(
          `/api/manage/events/${access.event.id}/uploads/${probe.mediaId}${suffix}`,
          {
            method,
            headers: method === 'PUT'
              ? { ...probe.headers, 'content-type': 'image/png', 'content-length': '64' }
              : probe.headers,
            ...(method === 'PUT'
              ? { body: png().buffer }
              : { body: '{}' }),
          },
          testEnv,
        );
        expect([probe.label, method, response.status]).toEqual([probe.label, method, 403]);
        expectPrivate(response);
        expect(await response.json<any>()).toMatchObject({ code: 'RESOURCE_FORBIDDEN' });
      }
    }
    expect(await mediaRow(guestMedia.id)).toMatchObject({ upload_state: 'reserved' });
    expect(await mediaRow(firstReservation.item.media.id)).toMatchObject({ upload_state: 'reserved' });
    expect(await mediaRow(otherReservation.item.media.id)).toMatchObject({ upload_state: 'reserved' });
  });

  it('rotation cancels a link reservation, rebinds an account actor, and preserves its delivery', async () => {
    const access = await eventAccess();
    const owner = await hostAccess([access]);
    const oldReservation = await reserveManager(access, undefined, 'old-link-row');
    const accountReservation = await reserveManager(
      access,
      hostWriteHeaders(owner),
      'account-survives-rotation',
    );
    const accountActorId = (await mediaRow(accountReservation.item.media.id))!
      .uploader_session_id as string;
    const predecessorId = await env.DB.prepare(`
      SELECT access_token_id FROM event_sessions WHERE id = ?
    `).bind(accountActorId).first<string>('access_token_id');
    const event = await new EventsRepository(env.DB).getById(access.event.id);
    if (!event) throw new Error('Expected event fixture.');
    const replacement = await new LinkService(testEnv, origin).rotateManagementLink(event, 0);
    const newManager = await exchangeManagerLink(replacement.managementLink);

    const response = await createApp().request(
      `/api/manage/events/${access.event.id}/uploads/${oldReservation.item.media.id}`,
      { method: 'DELETE', headers: writeHeaders(newManager), body: '{}' },
      testEnv,
    );

    expect(response.status).toBe(403);
    expectPrivate(response);
    expect(await response.json<any>()).toMatchObject({ code: 'RESOURCE_FORBIDDEN' });
    expect(await mediaRow(oldReservation.item.media.id)).toMatchObject({
      upload_state: 'deleted',
      deleted_at: expect.any(String),
    });
    expect(await mediaRow(accountReservation.item.media.id)).toMatchObject({
      upload_state: 'reserved',
      deleted_at: null,
    });
    expect(await uploadCounters(access.event.id)).toEqual({
      reserved_media_count: 1,
      reserved_bytes: 64,
      stored_media_count: 0,
      stored_bytes: 0,
    });
    const replacementId = await env.DB.prepare(`
      SELECT access_token_id FROM event_sessions WHERE id = ?
    `).bind(accountActorId).first<string>('access_token_id');
    expect(replacementId).not.toBe(predecessorId);
    expect(replacement.managerLinkRevision).toBe(1);

    const delivered = await managerContent(
      access,
      accountReservation.item.media.id,
      hostWriteHeaders(owner),
    );
    expect(delivered.status).toBe(200);
    expect(await mediaRow(accountReservation.item.media.id)).toMatchObject({
      upload_state: 'stored',
      uploader_session_id: accountActorId,
    });
  });

  it('lookup-only content, finalize, and cancel probes never create an account actor', async () => {
    const access = await eventAccess();
    const owner = await hostAccess([access]);
    const path = `/api/manage/events/${access.event.id}/uploads/not-a-real-media-id`;

    for (const [method, suffix] of [
      ['PUT', '/content'],
      ['POST', '/finalize'],
      ['DELETE', ''],
    ] as const) {
      const response = await createApp().request(`${path}${suffix}`, {
        method,
        headers: method === 'PUT'
          ? { ...hostWriteHeaders(owner), 'content-type': 'image/png', 'content-length': '64' }
          : hostWriteHeaders(owner),
        body: method === 'PUT' ? png().buffer : '{}',
      }, testEnv);
      expect([method, response.status]).toEqual([method, 403]);
      expectPrivate(response);
      expect(await response.json<any>()).toMatchObject({ code: 'RESOURCE_FORBIDDEN' });
    }
    expect((await actorRows(access.event.id)).results).toEqual([]);
  });

  it('refuses expired/deleted events, expired links, disabled accounts, and removed membership without writes', async () => {
    const cases: Array<{
      label: string;
      expectedCode: string;
      setup(access: EventAccess): Promise<Record<string, string>>;
      mutate(access: EventAccess): Promise<void>;
    }> = [
      {
        label: 'expired link',
        expectedCode: 'SESSION_EXPIRED',
        setup: async (access) => writeHeaders(access.manager),
        mutate: async (access) => {
          const sessionId = /candidary_session=([^.;]+)/u.exec(access.manager.cookie)?.[1];
          await env.DB.prepare('UPDATE event_sessions SET expires_at = ? WHERE id = ?')
            .bind('2020-01-01T00:00:00.000Z', sessionId).run();
        },
      },
      {
        label: 'expired event',
        expectedCode: 'EVENT_EXPIRED',
        setup: async (access) => writeHeaders(access.manager),
        mutate: async (access) => {
          await env.DB.prepare('UPDATE events SET management_access_expires_at = ? WHERE id = ?')
            .bind('2020-01-01T00:00:00.000Z', access.event.id).run();
        },
      },
      {
        label: 'deleted event',
        expectedCode: 'EVENT_DELETED',
        setup: async (access) => writeHeaders(access.manager),
        mutate: async (access) => {
          await env.DB.prepare('UPDATE events SET deleted_at = ? WHERE id = ?')
            .bind(new Date().toISOString(), access.event.id).run();
        },
      },
      {
        label: 'disabled account',
        expectedCode: 'ACCOUNT_DISABLED',
        setup: async (access) => hostWriteHeaders(await hostAccess([access])),
        mutate: async () => {
          await env.DB.prepare('UPDATE host_accounts SET disabled_at = ?')
            .bind(new Date().toISOString()).run();
        },
      },
      {
        label: 'removed membership',
        expectedCode: 'ROLE_FORBIDDEN',
        setup: async (access) => hostWriteHeaders(await hostAccess([access])),
        mutate: async (access) => {
          await env.DB.prepare('DELETE FROM event_hosts WHERE event_id = ?')
            .bind(access.event.id).run();
        },
      },
    ];

    for (const testCase of cases) {
      await resetDatabase();
      const access = await eventAccess(testCase.label);
      const headers = await testCase.setup(access);
      await testCase.mutate(access);
      const response = await managerBatch(access.event.id, headers);
      expect([testCase.label, response.status]).toEqual([
        testCase.label,
        testCase.expectedCode === 'SESSION_EXPIRED' ? 401
          : testCase.expectedCode === 'EVENT_EXPIRED' || testCase.expectedCode === 'EVENT_DELETED'
            ? 410
            : 403,
      ]);
      expectPrivate(response);
      expect(await response.json<any>()).toMatchObject({ code: testCase.expectedCode });
      expect((await actorRows(access.event.id)).results).toEqual([]);
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM media')
        .first<{ count: number }>())?.count).toBe(0);
    }
  });
});

describe('Manager upload ingress ordering and one-shot cancellation', () => {
  it('rejects bad Origin and missing CSRF before buffering an oversize content body', async () => {
    const access = await eventAccess();
    const reserved = await reserveManager(access, undefined, 'ingress-order');
    const mediaId = reserved.item.media.id;
    const oversize = new Uint8Array(20 * 1024 * 1024 + 1);
    const cases = [
      {
        label: 'bad Origin',
        headers: { ...writeHeaders(access.manager), origin: 'https://evil.example' },
        code: 'ORIGIN_FORBIDDEN',
      },
      {
        label: 'missing CSRF',
        headers: {
          cookie: access.manager.cookie,
          origin,
          'content-type': 'application/json',
        },
        code: 'CSRF_INVALID',
      },
    ];

    for (const testCase of cases) {
      const response = await managerContent(
        access,
        mediaId,
        testCase.headers,
        oversize,
      );
      expect([testCase.label, response.status]).toEqual([testCase.label, 403]);
      expectPrivate(response);
      expect(await response.json<any>()).toMatchObject({ code: testCase.code });
      expect(await mediaRow(mediaId)).toMatchObject({ upload_state: 'reserved' });
      expect(await new MediaRepository(env.DB).getPromotion(mediaId))
        .toMatchObject({ state: 'pending' });
      expect(await testEnv.CANONICAL_MEDIA_BUCKET.head(
        finalizedMediaObjectKey(access.event.id, mediaId),
      )).toBeNull();
    }
  });

  it('lets finalization win between route authorization and cancel without deleting stored bytes', async () => {
    const access = await eventAccess();
    const reserved = await reserveManager(access, undefined, 'cancel-finalize-race');
    const mediaId = reserved.item.media.id;
    const row = await new MediaRepository(env.DB).getById(mediaId);
    if (!row) throw new Error('Expected reserved Manager media.');
    const original = MediaRepository.prototype.cancelReservation;
    vi.spyOn(MediaRepository.prototype, 'cancelReservation').mockImplementationOnce(async function (
      id,
      authority,
      canceledAt,
    ) {
      await receiveMediaUpload(
        testEnv.CANONICAL_MEDIA_BUCKET,
        new MediaRepository(env.DB),
        row,
        {
          eventStartAt: access.event.eventStartAt,
          eventTimezone: access.event.eventTimezone,
        },
        authority,
        png().buffer,
        'image/png',
      );
      return original.call(this, id, authority, canceledAt);
    });

    const response = await createApp().request(
      `/api/manage/events/${access.event.id}/uploads/${mediaId}`,
      { method: 'DELETE', headers: writeHeaders(access.manager), body: '{}' },
      testEnv,
    );

    expect(response.status).toBe(409);
    expectPrivate(response);
    expect(await response.json<any>()).toMatchObject({ code: 'UPLOAD_FINALIZE_CONFLICT' });
    const persisted = await mediaRow(mediaId);
    expect(persisted).toMatchObject({
      upload_state: 'stored',
      deleted_at: null,
      trashed_at: null,
    });
    expect(await testEnv.CANONICAL_MEDIA_BUCKET.head(
      finalizedMediaObjectKey(access.event.id, mediaId),
    )).not.toBeNull();
    expect(await uploadCounters(access.event.id)).toMatchObject({
      reserved_media_count: 0,
      stored_media_count: 1,
      stored_bytes: 64,
    });
  });

  it('refuses cancellation after Recently deleted and preserves its recovery pair', async () => {
    const access = await eventAccess();
    const reserved = await reserveManager(access, undefined, 'cancel-trashed');
    const delivered = await managerContent(access, reserved.item.media.id);
    expect(delivered.status).toBe(200);
    expectPrivate(delivered);
    const repository = new MediaRepository(env.DB);
    await repository.trashStored(
      access.event.id,
      reserved.item.media.id,
      new Date().toISOString(),
    );
    const before = await mediaRow(reserved.item.media.id);

    const response = await createApp().request(
      `/api/manage/events/${access.event.id}/uploads/${reserved.item.media.id}`,
      { method: 'DELETE', headers: writeHeaders(access.manager), body: '{}' },
      testEnv,
    );

    expect(response.status).toBe(409);
    expectPrivate(response);
    expect(await response.json<any>()).toMatchObject({ code: 'UPLOAD_FINALIZE_CONFLICT' });
    expect(await mediaRow(reserved.item.media.id)).toEqual(before);
  });

  it('refuses when its own authority dies after route authorization and does not retry the cancel', async () => {
    const access = await eventAccess();
    const reserved = await reserveManager(access, undefined, 'cancel-dead-authority');
    const mediaId = reserved.item.media.id;
    const original = MediaRepository.prototype.cancelReservation;
    const cancel = vi.spyOn(MediaRepository.prototype, 'cancelReservation')
      .mockImplementationOnce(async function (id, authority, canceledAt) {
        await env.DB.prepare('UPDATE event_sessions SET revoked_at = ? WHERE id = ?')
          .bind(new Date().toISOString(), authority.actorSessionId).run();
        return original.call(this, id, authority, canceledAt);
      });

    const response = await createApp().request(
      `/api/manage/events/${access.event.id}/uploads/${mediaId}`,
      { method: 'DELETE', headers: writeHeaders(access.manager), body: '{}' },
      testEnv,
    );

    expect(response.status).toBe(403);
    expectPrivate(response);
    expect(await response.json<any>()).toMatchObject({
      code: MANAGER_UPLOAD_RESOURCE_FORBIDDEN_ERROR.code,
      message: MANAGER_UPLOAD_RESOURCE_FORBIDDEN_ERROR.message,
      requestId: expect.any(String),
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(await mediaRow(mediaId)).toMatchObject({ upload_state: 'reserved', deleted_at: null });
    expect(await uploadCounters(access.event.id)).toMatchObject({ reserved_media_count: 1 });
  });

  it('keeps legacy cleanup guest-only and never changes a Manager reservation or finalize winner', async () => {
    const access = await eventAccess();
    const managerReservation = await reserveManager(access, undefined, 'legacy-manager-probe');
    const guestReservation = await createApp().request(
      `/api/event/${access.event.slug}/uploads`,
      {
        method: 'POST',
        headers: writeHeaders(access.guest),
        body: JSON.stringify({
          ...uploadFile,
          idempotencyKey: 'legacy-guest-row',
          guestName: 'Avery',
        }),
      },
      testEnv,
    );
    const guestMedia = (await guestReservation.json<any>()).data.media;
    const deliveredGuest = await createApp().request(
      `/api/event/${access.event.slug}/uploads`,
      {
        method: 'POST',
        headers: writeHeaders(access.guest),
        body: JSON.stringify({
          ...uploadFile,
          idempotencyKey: 'legacy-guest-delivered',
          guestName: 'Avery',
        }),
      },
      testEnv,
    );
    const deliveredMedia = (await deliveredGuest.json<any>()).data.media;
    const delivered = await createApp().request(
      `/api/event/${access.event.slug}/uploads/${deliveredMedia.id}/content`,
      {
        method: 'PUT',
        headers: {
          ...writeHeaders(access.guest),
          'content-type': 'image/png',
          'content-length': '64',
        },
        body: png().buffer,
      },
      testEnv,
    );
    expect(delivered.status).toBe(200);
    expectPrivate(delivered);

    const managerProbe = await createApp().request(
      `/api/manage/events/${access.event.id}/media/${managerReservation.item.media.id}/cancel-reservation`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      testEnv,
    );
    const guestCancel = await createApp().request(
      `/api/manage/events/${access.event.id}/media/${guestMedia.id}/cancel-reservation`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      testEnv,
    );
    const deliveredProbe = await createApp().request(
      `/api/manage/events/${access.event.id}/media/${deliveredMedia.id}/cancel-reservation`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      testEnv,
    );

    expect([managerProbe.status, guestCancel.status, deliveredProbe.status]).toEqual([403, 200, 409]);
    expectPrivate(managerProbe);
    expectPrivate(guestCancel);
    expectPrivate(deliveredProbe);
    expect(await managerProbe.json<any>()).toMatchObject({ code: 'RESOURCE_FORBIDDEN' });
    expect((await guestCancel.json<any>()).data.media).toEqual({
      id: guestMedia.id,
      mimeType: 'image/png',
      uploadState: 'deleted',
    });
    expect(await deliveredProbe.json<any>()).toMatchObject({ code: 'MEDIA_STATE_CONFLICT' });
    expect(await mediaRow(managerReservation.item.media.id)).toMatchObject({
      upload_state: 'reserved', deleted_at: null,
    });
    expect(await mediaRow(guestMedia.id)).toMatchObject({ upload_state: 'deleted' });
    expect(await mediaRow(deliveredMedia.id)).toMatchObject({
      upload_state: 'stored', deleted_at: null,
    });
  });
});

import { beforeEach, describe, expect, it } from 'vitest';

import { MAX_EVENT_BYTES, MAX_IMAGE_BYTES } from '../../shared/constants';
import { EVENT_START_MIGRATION_SENTINEL, resolveGuestEventPhase } from '../../shared/rsvp';
import { createApp } from '../../worker/app';
import type { ManagerAuth } from '../../worker/auth/manager';
import { EventsRepository } from '../../worker/db/events';
import { MediaRepository } from '../../worker/db/media';
import { HostSessionsRepository, SessionsRepository } from '../../worker/db/sessions';
import type { EventRecord } from '../../worker/db/types';
import { ManagerUploadActorService } from '../../worker/services/manager-upload-actor';
import type { UploadAuthority } from '../../worker/services/upload-authority';
import { UploadService } from '../../worker/services/uploads';
import { receiveMediaUpload } from '../../worker/storage/media';
import { finalizedMediaObjectKey } from '../../worker/storage/media-keys';
import {
  applySettings,
  eventAccess,
  hostAccess,
  png,
  resetDatabase,
  testEnv,
  writeHeaders,
} from './helpers';

type Access = Awaited<ReturnType<typeof eventAccess>>;
type PhotoIntakeAction = 'open_early' | 'return_to_schedule' | 'pause' | 'reopen';
type PhotoIntakeState = 'scheduled' | 'open-early' | 'open' | 'paused';

const STALE = 'Photo delivery has moved on since this page loaded. Reload and try again.';

function act(access: Access, action: PhotoIntakeAction) {
  return createApp().request(`/api/manage/events/${access.event.id}/photo-intake`, {
    method: 'POST',
    headers: writeHeaders(access.manager),
    body: JSON.stringify({ action }),
  }, testEnv);
}

// The two columns the whole feature turns on: capability, and the host's
// early-open stamp. Every claim about a transition is made against these rather
// than against the derived view, because the derived view cannot tell a cleared
// stamp from a withdrawn capability.
function intakeColumns(eventId: string) {
  return testEnv.DB.prepare(
    'SELECT uploads_enabled, photos_open_from FROM events WHERE id = ?',
  ).bind(eventId).first<{ uploads_enabled: number; photos_open_from: string | null }>();
}

/**
 * Moves the event's own start behind the server clock.
 *
 * Which transition is legal is decided against one server-owned instant, so the
 * only way to test the far side of it is to move it. Nothing else about the row
 * changes, so a refusal can only be coming from the start.
 */
async function startTheEvent(access: Access) {
  await testEnv.DB.prepare('UPDATE events SET event_start_at = ? WHERE id = ?')
    .bind('2020-01-01T00:00:00.000Z', access.event.id).run();
}

async function reach(state: PhotoIntakeState): Promise<Access> {
  const access = await eventAccess('Maya & Theo', state === 'open-early');
  if (state === 'scheduled' || state === 'open-early') return access;
  await startTheEvent(access);
  if (state === 'open') return access;
  const paused = await act(access, 'pause');
  if (paused.status !== 200) {
    throw new Error(`Paused fixture did not reach its state: ${await paused.text()}`);
  }
  return access;
}

function sessionId(cookie: string, name = 'candidary_session'): string {
  const token = new RegExp(`${name}=([^;]+)`, 'u').exec(cookie)?.[1];
  if (!token) throw new Error(`Expected ${name} in test credential.`);
  return token.split('.')[0]!;
}

function guestAuthority(access: Access): UploadAuthority {
  const id = sessionId(access.guest.cookie);
  return { kind: 'guest', actorSessionId: id, eventSessionId: id };
}

function managerLinkAuthority(access: Access): UploadAuthority {
  const id = sessionId(access.manager.cookie);
  return { kind: 'manager-link', actorSessionId: id, eventSessionId: id };
}

async function eventRecord(access: Access): Promise<EventRecord> {
  const event = await new EventsRepository(testEnv.DB).getById(access.event.id);
  if (!event) throw new Error('Expected event fixture.');
  return event;
}

function uploadInput(key: string, patch: Record<string, unknown> = {}) {
  return {
    filename: `${key}.png`, mimeType: 'image/png', byteSize: 64,
    idempotencyKey: key, guestName: 'Avery', ...patch,
  };
}

async function accountAuthority(access: Access): Promise<UploadAuthority> {
  const host = await hostAccess([access]);
  const event = await eventRecord(access);
  const auth: ManagerAuth = {
    event,
    sessionId: sessionId(host.cookie, 'candidary_host'),
    csrfDigest: 'not-used-at-the-service-seam',
    scope: 'host',
    via: 'account',
    accountId: host.account.id,
  };
  return new ManagerUploadActorService(testEnv).ensureForReservation(auth);
}

beforeEach(resetDatabase);

describe('guest read surfaces', () => {
  const NOW = new Date('2026-09-19T20:00:00.000Z');
  const scheduled = {
    uploadsEnabled: true,
    rsvpEnabled: false,
    rsvpDeadlineAt: '2026-09-19T20:30:00.000Z',
    rsvpConfigured: true,
    eventStartAt: '2026-09-19T21:00:00.000Z',
    photosOpenFrom: null,
  };

  it.each([
    ['scheduled pre-boundary, unpaused', scheduled, 'before-start', false],
    ['scheduled pre-boundary, paused', { ...scheduled, uploadsEnabled: false }, 'before-start', false],
    [
      'scheduled early-open, unpaused',
      { ...scheduled, photosOpenFrom: '2026-09-19T19:00:00.000Z' },
      'photos-primary',
      true,
    ],
    [
      'scheduled early-open, paused',
      { ...scheduled, uploadsEnabled: false, photosOpenFrom: '2026-09-19T19:00:00.000Z' },
      'before-start',
      true,
    ],
    [
      'scheduled post-start, unpaused',
      { ...scheduled, eventStartAt: '2026-09-19T19:00:00.000Z' },
      'photos-primary',
      true,
    ],
    [
      'scheduled post-start, paused',
      { ...scheduled, uploadsEnabled: false, eventStartAt: '2026-09-19T19:00:00.000Z' },
      'waiting',
      true,
    ],
    [
      'legacy RSVP-primary',
      { ...scheduled, uploadsEnabled: false, rsvpEnabled: true, eventStartAt: EVENT_START_MIGRATION_SENTINEL },
      'rsvp-primary',
      false,
    ],
    [
      'legacy waiting',
      { ...scheduled, uploadsEnabled: false, eventStartAt: EVENT_START_MIGRATION_SENTINEL },
      'waiting',
      true,
    ],
    [
      'legacy photos-primary',
      { ...scheduled, eventStartAt: EVENT_START_MIGRATION_SENTINEL },
      'photos-primary',
      true,
    ],
  ] as const)('projects %s independently from the upload phase', (
    _label,
    input,
    phase,
    available,
  ) => {
    expect(resolveGuestEventPhase(input, NOW)).toMatchObject({
      phase,
      guestReadSurfaces: available
        ? { available: true, reason: null }
        : { available: false, reason: 'before-photo-open' },
    });
  });
});

describe('scheduled photo delivery', () => {
  it('creates an event permitted to deliver photos and waiting on its own start', async () => {
    const access = await eventAccess('Scheduled', false);

    expect(await intakeColumns(access.event.id))
      .toEqual({ uploads_enabled: 1, photos_open_from: null });
    expect(access.event).toMatchObject({
      uploadsEnabled: true,
      photosOpen: false,
      photoIntakeState: 'scheduled',
    });
    expect(access.event.photoIntakeRecheckAfterMs).toBeGreaterThan(0);
  });

  it('opens photo delivery early on the server clock', async () => {
    const access = await eventAccess('Early', false);
    const before = Date.now();

    const response = await act(access, 'open_early');
    const event = (await response.json<any>()).data.event;
    const columns = await intakeColumns(access.event.id);

    expect(response.status).toBe(200);
    expect(event).toMatchObject({
      uploadsEnabled: true,
      photosOpen: true,
      photoIntakeState: 'open-early',
    });
    expect(columns?.uploads_enabled).toBe(1);
    // No client timestamp is accepted anywhere on this path.
    expect(Date.parse(columns!.photos_open_from!)).toBeGreaterThanOrEqual(before);
  });

  it('clears the early opening on a pre-start pause and keeps capability', async () => {
    const access = await reach('open-early');

    const response = await act(access, 'return_to_schedule');
    const event = (await response.json<any>()).data.event;

    expect(response.status).toBe(200);
    expect(event).toMatchObject({
      uploadsEnabled: true,
      photosOpen: false,
      photoIntakeState: 'scheduled',
    });
    // The load-bearing rule of the whole feature. Withdrawing capability here
    // would silently cancel the scheduled opening, and a host who opened photos
    // early and then thought better of it would sit on `waiting` through their
    // own reception.
    expect(await intakeColumns(access.event.id))
      .toEqual({ uploads_enabled: 1, photos_open_from: null });
  });

  it('pauses and reopens photo delivery once the event has started', async () => {
    const access = await reach('open');

    const paused = await act(access, 'pause');
    const pausedEvent = (await paused.json<any>()).data.event;
    const pausedColumns = await intakeColumns(access.event.id);
    const reopened = await act(access, 'reopen');
    const reopenedEvent = (await reopened.json<any>()).data.event;

    expect([paused.status, reopened.status]).toEqual([200, 200]);
    expect(pausedEvent).toMatchObject({
      uploadsEnabled: false,
      photosOpen: false,
      photoIntakeState: 'paused',
    });
    // After the start the pause is the one control that does withdraw
    // capability, because its effect is visible to the host who chose it.
    expect(pausedColumns).toEqual({ uploads_enabled: 0, photos_open_from: null });
    expect(reopenedEvent).toMatchObject({
      uploadsEnabled: true,
      photosOpen: true,
      photoIntakeState: 'open',
      // Both boundaries are behind this event now, so there is nothing left to
      // wake the manager page up for.
      photoIntakeRecheckAfterMs: null,
    });
  });

  it('returns a paused event to its schedule when the start moves back into the future', async () => {
    const access = await reach('paused');

    const response = await applySettings(access, { eventStartTime: '17:30' });
    const event = (await response.json<any>()).data.event;

    expect(response.status).toBe(200);
    expect(event).toMatchObject({
      eventStartAt: '2026-09-19T22:30:00.000Z',
      uploadsEnabled: true,
      photosOpen: false,
      photoIntakeState: 'scheduled',
    });
    expect(await intakeColumns(access.event.id))
      .toEqual({ uploads_enabled: 1, photos_open_from: null });
  });
});

describe('illegal and stale photo delivery transitions', () => {
  it.each<[PhotoIntakeState, PhotoIntakeAction]>([
    ['scheduled', 'return_to_schedule'],
    ['scheduled', 'pause'],
    ['scheduled', 'reopen'],
    ['open-early', 'open_early'],
    ['open-early', 'pause'],
    ['open-early', 'reopen'],
    ['open', 'open_early'],
    ['open', 'return_to_schedule'],
    ['open', 'reopen'],
    ['paused', 'open_early'],
    ['paused', 'return_to_schedule'],
    ['paused', 'pause'],
  ])('refuses a %s event the %s action and changes nothing', async (state, action) => {
    const access = await reach(state);
    const before = await intakeColumns(access.event.id);

    const response = await act(access, action);

    expect(response.status).toBe(409);
    expect((await response.json<any>()).code).toBe('VALIDATION_FAILED');
    expect(await intakeColumns(access.event.id)).toEqual(before);
  });

  it('refuses a pre-start action from a page that loaded before the start', async () => {
    const access = await eventAccess('Stale page', false);
    // The host's page rendered `Open photo delivery now` while the event was
    // still ahead of its own start, and the event begins before they tap it.
    await startTheEvent(access);

    const response = await act(access, 'open_early');

    expect(response.status).toBe(409);
    expect(await response.json<any>()).toMatchObject({
      code: 'VALIDATION_FAILED',
      message: STALE,
    });
    expect(await intakeColumns(access.event.id))
      .toEqual({ uploads_enabled: 1, photos_open_from: null });
  });
});

describe('upload authority pause scope', () => {
  it('keeps a paused guest reserve on the existing UPLOADS_DISABLED wire answer', async () => {
    const access = await reach('paused');
    const response = await createApp().request(`/api/event/${access.event.slug}/uploads`, {
      method: 'POST', headers: writeHeaders(access.guest),
      body: JSON.stringify(uploadInput('paused-guest')),
    }, testEnv);

    expect(response.status).toBe(409);
    expect(await response.json<any>()).toMatchObject({
      code: 'UPLOADS_DISABLED',
      message: 'Photo uploads are paused for this event.',
    });
  });

  it('admits a Manager reserve while the guest intake control is paused', async () => {
    const access = await reach('paused');
    const authority = managerLinkAuthority(access);

    const result = await new UploadService(testEnv).initiate(
      authority,
      await eventRecord(access),
      uploadInput('paused-manager'),
      new Date(),
    );

    expect(result).toMatchObject({
      alreadyDelivered: false,
      media: { uploadState: 'reserved' },
      uploadUrl: `/api/manage/events/${access.event.id}/uploads/${result.media.id}/content`,
    });
    expect(await new MediaRepository(testEnv.DB).getById(result.media.id)).toMatchObject({
      uploaderSessionId: authority.actorSessionId,
      guestName: 'Host',
    });
  });

  it('keeps a scheduled guest closed while admitting a Manager before the event start', async () => {
    const access = await reach('scheduled');
    const guest = await createApp().request(`/api/event/${access.event.slug}/uploads`, {
      method: 'POST', headers: writeHeaders(access.guest),
      body: JSON.stringify(uploadInput('scheduled-guest')),
    }, testEnv);
    const manager = await new UploadService(testEnv).initiate(
      managerLinkAuthority(access),
      await eventRecord(access),
      uploadInput('scheduled-manager'),
      new Date(),
    );

    expect(guest.status).toBe(409);
    expect((await guest.json<any>()).code).toBe('UPLOADS_DISABLED');
    expect(manager.media.uploadState).toBe('reserved');
  });

  it('keeps the management expiry as the Manager lifecycle boundary', async () => {
    const access = await reach('paused');
    const authority = managerLinkAuthority(access);
    const expiresAt = '2026-08-27T12:00:00.000Z';
    await testEnv.DB.prepare('UPDATE events SET management_access_expires_at = ? WHERE id = ?')
      .bind(expiresAt, access.event.id).run();

    await expect(new UploadService(testEnv).initiate(
      authority,
      await eventRecord(access),
      uploadInput('expired-manager'),
      new Date(expiresAt),
    )).rejects.toMatchObject({
      code: 'EVENT_EXPIRED', status: 410, message: 'This event access has expired.',
    });
  });

  it.each([
    {
      fence: 'media cap',
      expected: 'EVENT_MEDIA_LIMIT',
      prepare: (eventId: string) => testEnv.DB.prepare(
        'UPDATE events SET stored_media_count = 10000 WHERE id = ?',
      ).bind(eventId).run(),
      input: {},
    },
    {
      fence: 'storage cap',
      expected: 'EVENT_STORAGE_LIMIT',
      prepare: (eventId: string) => testEnv.DB.prepare(
        'UPDATE events SET stored_bytes = ? WHERE id = ?',
      ).bind(MAX_EVENT_BYTES, eventId).run(),
      input: {},
    },
    {
      fence: 'unsupported type',
      expected: 'FILE_TYPE_UNSUPPORTED',
      prepare: () => Promise.resolve(),
      input: { filename: 'manager.gif', mimeType: 'image/gif' },
    },
    {
      fence: 'oversize',
      expected: 'FILE_TOO_LARGE',
      prepare: () => Promise.resolve(),
      input: { byteSize: MAX_IMAGE_BYTES + 1 },
    },
  ])('retains the $fence fence for a Manager reservation', async ({ expected, prepare, input }) => {
    const access = await reach('paused');
    await prepare(access.event.id);

    await expect(new UploadService(testEnv).initiate(
      managerLinkAuthority(access),
      await eventRecord(access),
      uploadInput(`manager-${expected}`, input),
      new Date(),
    )).rejects.toMatchObject({ code: expected });
  });

  it('retains the disabled Worker ingress fence for a Manager reservation', async () => {
    const access = await reach('paused');
    globalThis.__CANDIDARY_TEST_MEDIA_UPLOAD_RELEASE_OVERRIDE__ = false;
    try {
      await expect(new UploadService(testEnv).initiate(
        managerLinkAuthority(access),
        await eventRecord(access),
        uploadInput('manager-disabled-ingress'),
        new Date(),
      )).rejects.toThrow('Worker ingress media upload release is disabled.');
    } finally {
      delete globalThis.__CANDIDARY_TEST_MEDIA_UPLOAD_RELEASE_OVERRIDE__;
    }
  });

  it('lets a paused Manager use the shared buffer, R2, and promotion commit pipeline', async () => {
    const access = await reach('paused');
    const authority = managerLinkAuthority(access);
    const event = await eventRecord(access);
    const bytes = png(800, 600);
    const initiated = await new UploadService(testEnv).initiate(
      authority, event, uploadInput('paused-manager-content'), new Date(),
    );
    const repository = new MediaRepository(testEnv.DB);
    const reserved = await repository.getById(initiated.media.id);
    if (!reserved) throw new Error('Expected Manager reservation.');

    const stored = await receiveMediaUpload(
      testEnv.CANONICAL_MEDIA_BUCKET,
      repository,
      reserved,
      { eventStartAt: event.eventStartAt, eventTimezone: event.eventTimezone },
      authority,
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      'image/png',
      new Date(),
    );

    expect(stored).toMatchObject({
      uploadState: 'stored', objectBucketGeneration: 'canonical',
      objectKey: finalizedMediaObjectKey(event.id, initiated.media.id),
    });
  });

  it('re-enters the same paused Manager row on an idempotent replay', async () => {
    const access = await reach('paused');
    const authority = managerLinkAuthority(access);
    const event = await eventRecord(access);
    const input = uploadInput('paused-manager-replay');

    const first = await new UploadService(testEnv).initiate(authority, event, input, new Date());
    const replay = await new UploadService(testEnv).initiate(authority, event, input, new Date());

    expect(replay.media.id).toBe(first.media.id);
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM media WHERE event_id = ?')
      .bind(event.id).first<{ count: number }>())?.count).toBe(1);
  });

  it('returns only Manager content paths for a Manager batch reservation', async () => {
    const access = await reach('paused');
    const authority = managerLinkAuthority(access);
    const event = await eventRecord(access);

    const result = await new UploadService(testEnv).initiateBatch(authority, event, {
      files: [{
        filename: 'manager-batch.png', mimeType: 'image/png', byteSize: 64,
        idempotencyKey: 'manager-batch-path',
      }],
    }, new Date());

    expect(result.items[0]).toMatchObject({
      status: 'accepted',
      uploadUrl: `/api/manage/events/${event.id}/uploads/${result.items[0]!.media!.id}/content`,
    });
  });
});

describe('route-authorized reservation windows', () => {
  it.each(['guest', 'manager-link', 'manager-account'] as const)(
    'refuses a revoked %s authority at both single and batch reservation seams',
    async (kind) => {
      const access = await eventAccess(`Revoked ${kind}`);
      const authority = kind === 'guest'
        ? guestAuthority(access)
        : kind === 'manager-link'
          ? managerLinkAuthority(access)
          : await accountAuthority(access);
      if (authority.kind === 'manager-account') {
        await new HostSessionsRepository(testEnv.DB).revoke(
          authority.hostSessionId,
          new Date().toISOString(),
        );
      } else {
        await new SessionsRepository(testEnv.DB).revoke(
          authority.eventSessionId,
          new Date().toISOString(),
        );
      }
      const event = await eventRecord(access);
      const service = new UploadService(testEnv);
      const file = uploadInput(`revoked-${kind}`);

      await expect(service.initiate(authority, event, file, new Date()))
        .rejects.toMatchObject({ code: 'RESOURCE_FORBIDDEN', status: 403 });
      await expect(service.initiateBatch(authority, event, {
        guestName: file.guestName,
        files: [{
          filename: file.filename,
          mimeType: file.mimeType,
          byteSize: file.byteSize,
          idempotencyKey: `${file.idempotencyKey}-batch`,
        }],
      }, new Date())).rejects.toMatchObject({ code: 'RESOURCE_FORBIDDEN', status: 403 });
      expect((await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM media WHERE event_id = ?')
        .bind(event.id).first<{ count: number }>())?.count).toBe(0);
      expect(await new EventsRepository(testEnv.DB).getById(event.id)).toMatchObject({
        reservedMediaCount: 0, reservedBytes: 0,
      });
    },
  );
});

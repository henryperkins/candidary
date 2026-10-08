import { beforeEach, describe, expect, it } from 'vitest';

import { EVENT_START_MIGRATION_SENTINEL } from '../../shared/rsvp';
import { createApp } from '../../worker/app';
import { EventsRepository } from '../../worker/db/events';
import { eventAccess, hostAccess, resetDatabase, testEnv } from './helpers';

const NOW = new Date('2027-01-01T12:00:00.000Z');
const DEADLINE = '2027-01-01T13:00:00.000Z';
const START = '2027-01-01T14:00:00.000Z';

function privateResponse(response: Response) {
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('vary')).toBe('Cookie');
}

async function project(patch = {}, now = NOW, entryDisabledAt: string | null = null) {
  const access = await eventAccess('Lifecycle', false);
  const event = await new EventsRepository(testEnv.DB).getById(access.event.id);
  if (!event) throw new Error('Expected fixture event');
  const { selectHostEventLifecycle } = await import('../../worker/http/host-event-lifecycle');
  return selectHostEventLifecycle({
    ...event, eventStartAt: START, rsvpDeadlineAt: DEADLINE,
    rsvpEnabled: true, rsvpRosterVersion: 1,
    guestAccessExpiresAt: '2027-01-02T00:00:00.000Z',
    managementAccessExpiresAt: '2027-01-03T00:00:00.000Z', ...patch,
  }, now, entryDisabledAt);
}

beforeEach(resetDatabase);

describe('manager lifecycle projection', () => {
  it('allows link and account managers and exposes only lifecycle fields', async () => {
    const access = await eventAccess();
    const host = await hostAccess([access]);
    for (const cookie of [access.manager.cookie, host.cookie]) {
      const response = await createApp().request(`/api/manage/events/${access.event.id}/lifecycle`, {
        headers: { cookie },
      }, testEnv);
      expect(response.status).toBe(200);
      privateResponse(response);
      expect((await response.json<any>()).data).toEqual({
        phase: 'photos-primary', rsvpState: 'paused', photoIntakeState: 'open-early',
        guestAccessEnded: false, entryDisabled: false, lifecycleRecheckAfterMs: expect.any(Number),
      });
    }
  });

  it('refuses guests, unrelated-event managers and anonymous reads privately', async () => {
    const access = await eventAccess();
    const other = await eventAccess('Other');
    const otherHost = await hostAccess([other]);
    for (const cookie of [access.guest.cookie, other.manager.cookie, otherHost.cookie, '']) {
      const response = await createApp().request(`/api/manage/events/${access.event.id}/lifecycle`, {
        headers: { cookie },
      }, testEnv);
      expect(response.status).toBe(cookie ? 403 : 401);
      privateResponse(response);
    }
  });

  it('uses the entry repository tombstone without exposing its credential', async () => {
    const access = await eventAccess();
    await testEnv.DB.prepare('UPDATE event_entry_credentials SET disabled_at = ? WHERE event_id = ?')
      .bind(NOW.toISOString(), access.event.id).run();
    const response = await createApp().request(`/api/manage/events/${access.event.id}/lifecycle`, {
      headers: { cookie: access.manager.cookie },
    }, testEnv);
    expect(response.status).toBe(200);
    privateResponse(response);
    const data = (await response.json<any>()).data;
    expect(data.entryDisabled).toBe(true);
    expect(data.photoIntakeState).toBe('open-early');
    expect(Object.keys(data).sort()).toEqual(['entryDisabled', 'guestAccessEnded', 'lifecycleRecheckAfterMs', 'phase', 'photoIntakeState', 'rsvpState']);
  });

  it('retains manager access after guest expiry and refuses management expiry privately', async () => {
    const access = await eventAccess();
    const host = await hostAccess([access]);
    await testEnv.DB.prepare('UPDATE events SET guest_access_expires_at = ? WHERE id = ?')
      .bind('2020-01-01T00:00:00.000Z', access.event.id).run();
    const path = `/api/manage/events/${access.event.id}/lifecycle`;
    const response = await createApp().request(path, { headers: { cookie: host.cookie } }, testEnv);
    expect(response.status).toBe(200);
    expect((await response.json<any>()).data.guestAccessEnded).toBe(true);
    await testEnv.DB.prepare('UPDATE events SET management_access_expires_at = ? WHERE id = ?')
      .bind('2020-01-01T00:00:00.000Z', access.event.id).run();
    const expired = await createApp().request(path, { headers: { cookie: host.cookie } }, testEnv);
    expect(expired.status).toBe(410);
    privateResponse(expired);
  });

  it('keeps RSVP open at its deadline and schedules the first closed millisecond', async () => {
    expect(await project({}, new Date(DEADLINE))).toMatchObject({
      phase: 'rsvp-primary', rsvpState: 'open', lifecycleRecheckAfterMs: 1,
    });
    expect(await project({}, new Date(Date.parse(DEADLINE) + 1))).toMatchObject({
      phase: 'before-start', rsvpState: 'closed', lifecycleRecheckAfterMs: 3_599_999,
    });
  });

  it('opens photos exactly at start and retains a paused waiting phase', async () => {
    expect(await project({}, new Date(START))).toMatchObject({ phase: 'photos-primary', photoIntakeState: 'open' });
    expect(await project({ uploadsEnabled: false }, new Date(START))).toMatchObject({ phase: 'waiting', photoIntakeState: 'paused' });
  });

  it('handles early photo opening without losing the RSVP refresh boundary', async () => {
    expect(await project({ photosOpenFrom: NOW.toISOString() })).toMatchObject({
      phase: 'photos-primary', photoIntakeState: 'open-early', lifecycleRecheckAfterMs: 3_600_001,
    });
  });

  it('preserves legacy boolean photo and RSVP behavior', async () => {
    expect(await project({ eventStartAt: EVENT_START_MIGRATION_SENTINEL })).toMatchObject({ phase: 'photos-primary', photoIntakeState: 'open' });
    expect(await project({ eventStartAt: EVENT_START_MIGRATION_SENTINEL, uploadsEnabled: false })).toMatchObject({ phase: 'rsvp-primary', photoIntakeState: 'paused' });
  });

  it('refreshes at the earliest positive access expiry and marks guest expiry at equality', async () => {
    const expiry = '2027-01-01T12:00:05.000Z';
    expect(await project({ guestAccessExpiresAt: expiry })).toMatchObject({ guestAccessEnded: false, lifecycleRecheckAfterMs: 5000 });
    expect(await project({ guestAccessExpiresAt: expiry }, new Date(expiry))).toMatchObject({ guestAccessEnded: true, lifecycleRecheckAfterMs: 3_595_001 });
    expect(await project({ managementAccessExpiresAt: expiry })).toMatchObject({ lifecycleRecheckAfterMs: 5000 });
  });

  it('returns null when no future boundary remains and projects disabled entry independently', async () => {
    expect(await project({}, new Date('2028-01-01T00:00:00.000Z'), NOW.toISOString())).toMatchObject({
      guestAccessEnded: true, entryDisabled: true, lifecycleRecheckAfterMs: null,
    });
  });
});

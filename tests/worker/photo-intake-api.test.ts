import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../worker/app';
import { applySettings, eventAccess, resetDatabase, testEnv, writeHeaders } from './helpers';

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

beforeEach(resetDatabase);

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

import { strFromU8, unzipSync } from 'fflate';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../worker/app';
import { ExportsRepository } from '../../worker/db/exports';
import { processExport } from '../../worker/workflows/export';
import { DEFAULT_EVENT_THEME_CONFIG } from '../../shared/event-theme';
import { guestEventView } from '../../worker/http/event-view';
import {
  applySettings,
  cookiesFrom,
  eventAccess,
  origin,
  resetDatabase,
  testEnv,
  uploadPending,
  writeHeaders,
} from './helpers';

describe('complete private event journey', () => {
  beforeEach(resetDatabase);

  it('creates, privately collects, optionally publishes, and exports originals', async () => {
    const access = await eventAccess('Maya & Theo');
    expect(await testEnv.DB.prepare('SELECT theme_config FROM events WHERE id = ?')
      .bind(access.event.id).first('theme_config'))
      .toBe('{"version":1,"presetId":"candidary-default","overrides":{}}');
    expect(access.event.theme.config).toEqual({
      version: 1,
      presetId: 'candidary-default',
      overrides: {},
    });
    expect(access.event).not.toHaveProperty('themeConfig');
    const media = await uploadPending(access, 'first-look', 'The first look');
    await createApp().request(`/api/manage/events/${access.event.id}/settings`, {
      method: 'PATCH', headers: writeHeaders(access.manager),
      body: JSON.stringify({
        galleryVisible: true, moderationRequired: true,
        eventTimezone: 'America/Chicago', eventStartTime: '00:00',
        rsvpDeadlineDate: '2026-09-05', rsvpEnabled: false, rsvpRosterVersion: 0,
      }),
    }, testEnv);
    const published = await createApp().request(`/api/manage/events/${access.event.id}/media/${media.id}`, {
      method: 'PATCH', headers: writeHeaders(access.manager),
      body: JSON.stringify({ action: 'publish', expectedStatus: 'unpublished' }),
    }, testEnv);
    expect(published.status).toBe(200);

    const gallery = await createApp().request(`/api/event/${access.event.slug}/gallery`, {
      headers: { cookie: access.guest.cookie },
    }, testEnv);
    expect((await gallery.json<any>()).data.media.map((item: any) => item.id)).toEqual([media.id]);

    const requested = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const job = (await requested.json<any>()).data.export;
    await processExport(testEnv, job.id);
    const repository = new ExportsRepository(testEnv.DB);
    const ready = await repository.getById(job.id);
    const parts = await repository.listParts(job.id);
    expect(ready).toMatchObject({ state: 'ready', partCount: 1 });
    const object = await testEnv.MEDIA_BUCKET.get(parts[0]!.objectKey);
    const archive = unzipSync(new Uint8Array(await object!.arrayBuffer()));
    expect(Object.keys(archive)).toEqual(['photos/001-first-look.png', 'media.csv']);
    expect(strFromU8(archive['media.csv']!)).toContain('The first look');
    expect(await testEnv.MEDIA_BUCKET.head(ready!.manifestObjectKey!)).not.toBeNull();
  });
});

describe('server-owned event configuration and phase', () => {
  beforeEach(resetDatabase);

  function create(patch: Record<string, unknown> = {}) {
    return createApp().request('/api/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({
        name: 'Maya & Theo',
        eventDate: '2026-09-19',
        welcomeMessage: 'Welcome.',
        eventTimezone: 'America/Chicago',
        rsvpDeadlineDate: '2026-09-05',
        ...patch,
      }),
    }, testEnv);
  }

  it('stores the chosen deadline as the last millisecond of that local day', async () => {
    const created = await create();
    const body = await created.json<any>();

    expect(created.status).toBe(201);
    expect(body.data.event).toMatchObject({
      eventTimezone: 'America/Chicago',
      // 2026-09-05 is CDT, so the day ends at 05:00Z the next morning.
      rsvpDeadlineAt: '2026-09-06T04:59:59.999Z',
      rsvpDeadlineDate: '2026-09-05',
      rsvpEnabled: false,
      rsvpRosterVersion: 0,
      // Photo delivery is permitted from the start, and the schedule decides
      // when it opens. This event has not reached its own start yet.
      uploadsEnabled: true,
      photosOpen: false,
      photoIntakeState: 'scheduled',
    });
  });

  it('resolves an omitted start time as local midnight on the event date', async () => {
    const body = await (await create()).json<any>();

    expect(body.data.event).toMatchObject({
      eventStartAt: '2026-09-19T05:00:00.000Z',
      eventStartTime: '00:00',
    });
  });

  it('resolves the host start time through the event zone, never a browser offset', async () => {
    const body = await (await create({
      eventStartTime: '17:30',
      // Ignored: only the date, the local time, and the zone are inputs.
      eventStartAt: '1999-01-01T00:00:00.000Z',
    })).json<any>();

    expect(body.data.event).toMatchObject({
      eventStartAt: '2026-09-19T22:30:00.000Z',
      eventStartTime: '17:30',
    });
  });

  it('canonicalizes a hand-typed time zone', async () => {
    const body = await (await create({ eventTimezone: 'america/chicago' })).json<any>();
    expect(body.data.event.eventTimezone).toBe('America/Chicago');
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['an invented zone', { eventTimezone: 'Central Wedding Time' }, 'eventTimezone'],
    ['a fixed offset', { eventTimezone: '-05:00' }, 'eventTimezone'],
    ['an impossible event date', { eventDate: '2026-02-30' }, 'eventDate'],
    ['an impossible date', { rsvpDeadlineDate: '2026-02-30' }, 'rsvpDeadlineDate'],
    ['a malformed date', { rsvpDeadlineDate: '2026-9-5' }, 'rsvpDeadlineDate'],
    ['a deadline after the event', { rsvpDeadlineDate: '2026-09-20' }, 'rsvpDeadlineDate'],
    // The deadline is the last millisecond of its local day, so no start time on
    // the event date can be later than a deadline on that same date.
    ['a deadline on the event date', { rsvpDeadlineDate: '2026-09-19' }, 'rsvpDeadlineDate'],
    [
      'a deadline on the event date under the latest start',
      { rsvpDeadlineDate: '2026-09-19', eventStartTime: '23:59' },
      'rsvpDeadlineDate',
    ],
    ['a malformed start time', { eventStartTime: '24:00' }, 'eventStartTime'],
    // 2027-03-14 is the spring-forward Sunday in Chicago: 02:30 never happens.
    [
      'a start time the zone skips',
      { eventDate: '2027-03-14', eventStartTime: '02:30' },
      'eventStartTime',
    ],
  ])('refuses %s against its own field', async (_label, patch, field) => {
    const response = await create(patch);
    expect(response.status).toBe(422);
    const body = await response.json<any>();
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.fieldErrors).toHaveProperty(field);
  });

  it('gives a guest the host time zone deadline, not their own', async () => {
    const access = await eventAccess();
    const shell = await createApp().request(`/api/event/${access.event.slug}`, {
      headers: { cookie: access.guest.cookie },
    }, testEnv);
    const event = (await shell.json<any>()).data.event;

    // A guest in Auckland reads the same calendar date the host picked.
    expect(event.rsvpDeadlineDate).toBe('2026-09-05');
    expect(event.eventTimezone).toBe('America/Chicago');
    expect(event.rsvpDeadlineAt).toBe('2026-09-06T04:59:59.999Z');
    // The guest view never carries manager configuration.
    expect(event).not.toHaveProperty('rsvpEnabled');
    expect(event).not.toHaveProperty('rsvpRosterVersion');
  });

  it('changes phase at the exact server deadline, not a millisecond earlier', async () => {
    const record = {
      uploadsEnabled: true,
      rsvpEnabled: true,
      rsvpDeadlineAt: '2026-09-06T04:59:59.999Z',
      rsvpRosterVersion: 1,
      eventStartAt: '2026-09-19T05:00:00.000Z',
      photosOpenFrom: null,
      eventTimezone: 'America/Chicago',
      themeConfig: DEFAULT_EVENT_THEME_CONFIG,
    } as never;

    expect(guestEventView(record, new Date('2026-09-06T04:59:59.999Z')))
      .toMatchObject({ phase: 'rsvp-primary', rsvpState: 'open', rsvpAccess: 'editable' });
    // A shut RSVP before the start is its own surface now, not the leftover the
    // old two-boolean model called `waiting`.
    expect(guestEventView(record, new Date('2026-09-06T05:00:00.000Z')))
      .toMatchObject({ phase: 'before-start', rsvpState: 'closed', rsvpAccess: 'read-only' });
  });

  it('opens photo delivery at the start with no host action, and closes RSVP there', async () => {
    const record = {
      uploadsEnabled: true,
      rsvpEnabled: true,
      rsvpDeadlineAt: '2026-09-06T04:59:59.999Z',
      rsvpRosterVersion: 1,
      eventStartAt: '2026-09-19T05:00:00.000Z',
      photosOpenFrom: null,
      eventTimezone: 'America/Chicago',
      themeConfig: DEFAULT_EVENT_THEME_CONFIG,
    } as never;

    expect(guestEventView(record, new Date('2026-09-19T04:59:59.999Z')))
      .toMatchObject({ phase: 'before-start', rsvpAccess: 'read-only' });
    expect(guestEventView(record, new Date('2026-09-19T05:00:00.000Z')))
      .toMatchObject({ phase: 'photos-primary', rsvpAccess: 'unavailable' });
  });

  it('keeps valid-deadline RSVP unavailable until a roster is configured', () => {
    const record = {
      uploadsEnabled: true,
      rsvpEnabled: false,
      rsvpDeadlineAt: '2026-09-06T04:59:59.999Z',
      rsvpRosterVersion: 0,
      eventStartAt: '2026-09-19T05:00:00.000Z',
      photosOpenFrom: null,
      eventTimezone: 'America/Chicago',
      themeConfig: DEFAULT_EVENT_THEME_CONFIG,
    };

    const unconfigured = guestEventView(
      record as never,
      new Date('2026-09-05T12:00:00.000Z'),
    );
    expect(unconfigured).toMatchObject({
      phase: 'before-start',
      rsvpState: 'paused',
      rsvpAccess: 'unavailable',
    });
    expect(unconfigured).not.toHaveProperty('rsvpConfigured');

    expect(guestEventView(
      { ...record, rsvpRosterVersion: 1 } as never,
      new Date('2026-09-05T12:00:00.000Z'),
    )).toMatchObject({
      phase: 'before-start',
      rsvpState: 'paused',
      rsvpAccess: 'read-only',
    });
  });

  it('refuses to open RSVP with no guest list, and leaves the event untouched', async () => {
    const access = await eventAccess();
    const response = await applySettings(access, { rsvpEnabled: true });

    expect(response.status).toBe(409);
    expect((await response.json<any>()).code).toBe('RSVP_ROSTER_INVALID');
    expect(await testEnv.DB.prepare('SELECT rsvp_enabled FROM events WHERE id = ?')
      .bind(access.event.id).first('rsvp_enabled')).toBe(0);
  });

  it('opens photo delivery early without opening RSVP', async () => {
    const access = await eventAccess('Photos Only');

    expect(access.event).toMatchObject({
      uploadsEnabled: true,
      photosOpen: true,
      photoIntakeState: 'open-early',
      rsvpEnabled: false,
    });
  });

  it('refuses a settings write from a stale roster view', async () => {
    const access = await eventAccess();
    const response = await applySettings(access, { rsvpRosterVersion: 7 });

    expect(response.status).toBe(409);
    expect((await response.json<any>()).code).toBe('RSVP_ROSTER_INVALID');
  });

  it('moves a deadline without trusting any timestamp from the browser', async () => {
    const access = await eventAccess();
    const response = await applySettings(access, {
      rsvpDeadlineDate: '2026-09-10',
      // Ignored: only the date and the zone are inputs.
      rsvpDeadlineAt: '1999-01-01T00:00:00.000Z',
    });
    const event = (await response.json<any>()).data.event;

    expect(response.status).toBe(200);
    expect(event.rsvpDeadlineAt).toBe('2026-09-11T04:59:59.999Z');
    expect(event.rsvpDeadlineDate).toBe('2026-09-10');
  });

  it('recomputes both instants together when the time zone moves', async () => {
    const access = await eventAccess();
    const response = await applySettings(access, { eventTimezone: 'America/New_York' });
    expect(response.status).toBe(200);

    // One guarded write carries both. Recomputing the deadline on its own could
    // push it past a start the same edit was meant to move with it.
    expect(await testEnv.DB.prepare(
      'SELECT event_start_at, rsvp_deadline_at FROM events WHERE id = ?',
    ).bind(access.event.id).first()).toEqual({
      event_start_at: '2026-09-19T04:00:00.000Z',
      rsvp_deadline_at: '2026-09-06T03:59:59.999Z',
    });
  });

  it('retimes the start without disturbing the deadline', async () => {
    const access = await eventAccess();
    const response = await applySettings(access, { eventStartTime: '17:30' });
    const event = (await response.json<any>()).data.event;

    expect(response.status).toBe(200);
    expect(event).toMatchObject({
      eventStartAt: '2026-09-19T22:30:00.000Z',
      eventStartTime: '17:30',
      rsvpDeadlineAt: '2026-09-06T04:59:59.999Z',
    });
  });

  it('preserves the existing wall-clock start for a stale settings payload', async () => {
    const created = await create({ eventStartTime: '17:30' });
    const body = await created.json<any>();
    const manager = { ...cookiesFrom(created), csrf: body.data.csrfToken as string };

    const response = await createApp().request(`/api/manage/events/${body.data.event.id}/settings`, {
      method: 'PATCH',
      headers: writeHeaders(manager),
      body: JSON.stringify({
        galleryVisible: body.data.event.galleryVisible,
        moderationRequired: body.data.event.moderationRequired,
        eventTimezone: 'America/New_York',
        rsvpDeadlineDate: body.data.event.rsvpDeadlineDate,
        rsvpEnabled: body.data.event.rsvpEnabled,
        rsvpRosterVersion: body.data.event.rsvpRosterVersion,
        // A pre-release client sends this obsolete field and has no start-time field.
        uploadsEnabled: false,
      }),
    }, testEnv);
    const updated = await response.json<any>();

    expect(response.status).toBe(200);
    expect(updated.data.event).toMatchObject({
      eventTimezone: 'America/New_York',
      eventStartTime: '17:30',
      eventStartAt: '2026-09-19T21:30:00.000Z',
    });
  });

  it.each<[string, string]>([
    ['on the event date', '2026-09-19'],
    ['after the event', '2026-09-20'],
  ])('refuses a settings deadline %s and stores nothing', async (_label, rsvpDeadlineDate) => {
    const access = await eventAccess();
    const response = await applySettings(access, { rsvpDeadlineDate });

    expect(response.status).toBe(422);
    expect((await response.json<any>()).fieldErrors).toMatchObject({
      rsvpDeadlineDate: 'The RSVP deadline must be before the event starts.',
    });
    expect(await testEnv.DB.prepare('SELECT rsvp_deadline_at FROM events WHERE id = ?')
      .bind(access.event.id).first('rsvp_deadline_at')).toBe('2026-09-06T04:59:59.999Z');
  });

  it('refuses a settings start time the zone skips and stores nothing', async () => {
    // 2027-03-14 is the spring-forward Sunday in Chicago, and the host retimes
    // the event onto the hour that does not happen on it.
    const created = await create({ eventDate: '2027-03-14', eventStartTime: '01:00' });
    const body = await created.json<any>();
    const access = {
      event: body.data.event,
      manager: { ...cookiesFrom(created), csrf: body.data.csrfToken as string },
    };

    const response = await applySettings(access, { eventStartTime: '02:30' });

    expect(response.status).toBe(422);
    expect((await response.json<any>()).fieldErrors).toMatchObject({
      eventStartTime: 'Choose a start time that exists on the event date.',
    });
    expect(await testEnv.DB.prepare('SELECT event_start_at FROM events WHERE id = ?')
      .bind(access.event.id).first('event_start_at')).toBe('2027-03-14T07:00:00.000Z');
  });

  it('attributes an impossible stored event date to the date field', async () => {
    const access = await eventAccess();
    await testEnv.DB.prepare('UPDATE events SET event_date = ? WHERE id = ?')
      .bind('2026-02-30', access.event.id).run();

    const response = await applySettings(access);
    const body = await response.json<any>();

    expect(response.status).toBe(422);
    expect(body.fieldErrors).toMatchObject({
      eventDate: 'Choose a valid event date.',
    });
    expect(body.fieldErrors).not.toHaveProperty('eventStartTime');
  });
});

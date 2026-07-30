import { strFromU8, unzipSync } from 'fflate';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../worker/app';
import { ExportsRepository } from '../../worker/db/exports';
import { processExport } from '../../worker/workflows/export';
import { DEFAULT_EVENT_THEME_CONFIG } from '../../shared/event-theme';
import { guestEventView } from '../../worker/http/event-view';
import {
  applySettings,
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
        galleryVisible: true, uploadsEnabled: true, moderationRequired: true,
        eventTimezone: 'America/Chicago', rsvpDeadlineDate: '2026-09-05',
        rsvpEnabled: false, rsvpRosterVersion: 0,
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
      // A new event opens nothing until the host decides.
      uploadsEnabled: false,
    });
  });

  it('canonicalizes a hand-typed time zone', async () => {
    const body = await (await create({ eventTimezone: 'america/chicago' })).json<any>();
    expect(body.data.event.eventTimezone).toBe('America/Chicago');
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['an invented zone', { eventTimezone: 'Central Wedding Time' }, 'eventTimezone'],
    ['a fixed offset', { eventTimezone: '-05:00' }, 'eventTimezone'],
    ['an impossible date', { rsvpDeadlineDate: '2026-02-30' }, 'rsvpDeadlineDate'],
    ['a malformed date', { rsvpDeadlineDate: '2026-9-5' }, 'rsvpDeadlineDate'],
    ['a deadline after the event', { rsvpDeadlineDate: '2026-09-20' }, 'rsvpDeadlineDate'],
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
      uploadsEnabled: false,
      rsvpEnabled: true,
      rsvpDeadlineAt: '2026-09-06T04:59:59.999Z',
      eventTimezone: 'America/Chicago',
      themeConfig: DEFAULT_EVENT_THEME_CONFIG,
    } as never;

    expect(guestEventView(record, new Date('2026-09-06T04:59:59.999Z')))
      .toMatchObject({ phase: 'rsvp-primary', rsvpState: 'open' });
    expect(guestEventView(record, new Date('2026-09-06T05:00:00.000Z')))
      .toMatchObject({ phase: 'waiting', rsvpState: 'closed' });
  });

  it('refuses to open RSVP with no guest list, and leaves the event untouched', async () => {
    const access = await eventAccess();
    const response = await applySettings(access, { rsvpEnabled: true });

    expect(response.status).toBe(409);
    expect((await response.json<any>()).code).toBe('RSVP_ROSTER_INVALID');
    expect(await testEnv.DB.prepare('SELECT rsvp_enabled FROM events WHERE id = ?')
      .bind(access.event.id).first('rsvp_enabled')).toBe(0);
  });

  it('lets photo intake open independently of RSVP', async () => {
    const access = await eventAccess('Photos Only');
    const response = await applySettings(access, { uploadsEnabled: true, rsvpEnabled: false });
    const event = (await response.json<any>()).data.event;

    expect(response.status).toBe(200);
    expect(event).toMatchObject({ uploadsEnabled: true, rsvpEnabled: false });
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
});

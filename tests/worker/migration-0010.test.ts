import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { EVENT_START_MIGRATION_SENTINEL } from '../../shared/rsvp';
import { createApp } from '../../worker/app';
import type { AppEnv } from '../../worker/env';
import {
  eventAccess,
  importRoster,
  openRsvp,
  origin,
  testEnv,
  writeHeaders,
} from './helpers';

interface Migration { name: string; queries: string[] }

const migrationEnv = env as AppEnv & { TEST_MIGRATIONS: string };
const migrations = JSON.parse(migrationEnv.TEST_MIGRATIONS) as Migration[];
const now = '2026-07-21T12:00:00.000Z';
const ISO_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function upTo(name: string): Migration[] {
  const index = migrations.findIndex((migration) => migration.name.startsWith(name));
  if (index === -1) throw new Error(`No migration named ${name}.`);
  return migrations.slice(0, index);
}

function only(name: string): Migration {
  const found = migrations.find((migration) => migration.name.startsWith(name));
  if (!found) throw new Error(`No migration named ${name}.`);
  return found;
}

async function seedEvent(
  id: string,
  slug: string,
  eventDate: string,
  uploadsEnabled: number,
): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO events (id, slug, name, event_date, welcome_message, uploads_enabled,
      guest_access_expires_at, management_access_expires_at, purge_after, created_at)
    VALUES (?, ?, 'Maya & Theo', ?, 'Welcome.', ?, ?, ?, ?, ?)
  `).bind(id, slug, eventDate, uploadsEnabled, now, now, now, now).run();
}

function schedule() {
  return env.DB.prepare(`
    SELECT id, uploads_enabled, event_start_at, photos_open_from FROM events ORDER BY id
  `).all<{
    id: string;
    uploads_enabled: number;
    event_start_at: string;
    photos_open_from: string | null;
  }>();
}

beforeEach(reset);

describe('migration 0010', () => {
  it('backfills a start from each event date and stamps only permitted intake', async () => {
    await applyD1Migrations(env.DB, upTo('0010'));
    await seedEvent('event-a', 'maya-theo', '2026-09-19', 1);
    await seedEvent('event-b', 'other-event', '2027-01-02', 1);
    await seedEvent('event-c', 'quiet-event', '2026-11-30', 0);

    await applyD1Migrations(env.DB, [only('0010')]);
    const backfilled = (await schedule()).results;

    expect(backfilled.map((row) => [row.id, row.event_start_at])).toEqual([
      // UTC midnight, not local midnight. SQLite has no IANA database, so this
      // is an approximation the release gate corrects before the new Worker is
      // deployed — see docs/deployment.md.
      ['event-a', '2026-09-19T00:00:00.000Z'],
      ['event-b', '2027-01-02T00:00:00.000Z'],
      ['event-c', '2026-11-30T00:00:00.000Z'],
    ]);
    // The stamp preserves every event currently showing `photos-primary`, and
    // reaches no event whose capability was withheld.
    expect(backfilled.map((row) => [row.id, row.photos_open_from === null])).toEqual([
      ['event-a', false],
      ['event-b', false],
      ['event-c', true],
    ]);
    for (const row of backfilled.filter((candidate) => candidate.photos_open_from !== null)) {
      // `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` has to reproduce the form
      // `toISOString()` writes everywhere else in this schema.
      expect(row.photos_open_from).toMatch(ISO_MILLISECONDS);
    }
  });

  it('holds the start column non-null and leaves the sentinel for a deploy-gap row', async () => {
    await applyD1Migrations(env.DB, upTo('0010'));
    await seedEvent('event-a', 'maya-theo', '2026-09-19', 1);
    await applyD1Migrations(env.DB, [only('0010')]);

    // NOT NULL with a constant default is available on ADD COLUMN, so the
    // column is genuinely non-nullable rather than policed by a trigger.
    await expect(env.DB.prepare('UPDATE events SET event_start_at = NULL WHERE id = ?')
      .bind('event-a').run()).rejects.toThrow();

    // The one row the backfill cannot reach: an event the *old* Worker creates
    // after the migration is applied. It takes the untouched default.
    await seedEvent('event-gap', 'gap-event', '2026-12-05', 1);
    const gap = (await schedule()).results.find((row) => row.id === 'event-gap');

    expect(gap?.event_start_at).toBe(EVENT_START_MIGRATION_SENTINEL);
    expect(gap?.event_start_at).toBe('1970-01-01T00:00:00.000Z');
    // The stamp was a one-time backfill, not a rule about new rows.
    expect(gap?.photos_open_from).toBeNull();
  });

  it('keeps a sentinel row on the pre-0010 lifecycle with its guest RSVP intact', async () => {
    await applyD1Migrations(env.DB, migrations);
    const access = await eventAccess('Deploy gap', false);
    await importRoster(
      access,
      'household_key,household_label,invitee_name,plus_one_slots\nperkins,Perkins household,Henry Perkins,0',
    );
    await openRsvp(access);
    // What a deploy-gap row looks like: the old Worker's booleans, and a start
    // instant it never really had. Post-0010 rules would read the epoch as long
    // past and refuse every guest RSVP route at a time up to fourteen hours
    // from the truth.
    await env.DB.prepare(
      'UPDATE events SET event_start_at = ?, uploads_enabled = 0 WHERE id = ?',
    ).bind(EVENT_START_MIGRATION_SENTINEL, access.event.id).run();

    const shell = await createApp().request(`/api/event/${access.event.slug}`, {
      headers: { cookie: access.guest.cookie },
    }, testEnv);
    const matched = await createApp().request(`/api/event/${access.event.slug}/rsvp/lookup`, {
      method: 'POST',
      headers: { ...writeHeaders(access.guest), 'cf-connecting-ip': '203.0.113.10' },
      body: JSON.stringify({ firstName: 'Henry Perkins' }),
    }, testEnv);
    const cookies = matched.headers.get('set-cookie') ?? '';
    const household = (await matched.json<any>()).data.household;
    const rsvpCookie = [
      `candidary_rsvp=${/candidary_rsvp=([^;,]+)/u.exec(cookies)![1]}`,
      `candidary_rsvp_csrf=${/candidary_rsvp_csrf=([^;,]+)/u.exec(cookies)![1]}`,
    ].join('; ');
    const written = await createApp().request(`/api/event/${access.event.slug}/rsvp/household`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        cookie: rsvpCookie,
        origin,
        'x-candidary-rsvp-csrf': /candidary_rsvp_csrf=([^;,]+)/u.exec(cookies)![1]!,
      },
      body: JSON.stringify({
        version: household.version,
        idempotencyKey: 'deploy-gap',
        invitees: household.invitees.map((invitee: { id: string }) => ({
          id: invitee.id, attendance: 'attending', displayName: null,
        })),
      }),
    }, testEnv);

    // The old boolean/deadline rules, unchanged: RSVP is primary because photo
    // delivery is off, not because a start instant was compared to anything.
    expect((await shell.json<any>()).data.event).toMatchObject({
      phase: 'rsvp-primary',
      rsvpState: 'open',
      rsvpAccess: 'editable',
    });
    expect(household.editable).toBe(true);
    expect(written.status).toBe(200);
    // The guarded write names the sentinel too, so the household commits rather
    // than being refused by a start the row does not really have.
    expect((await written.json<any>()).data.committedVersion).toBe(2);
  });
});

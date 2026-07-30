import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AppEnv } from '../../worker/env';

interface Migration { name: string; queries: string[] }

const testEnv = env as AppEnv & { TEST_MIGRATIONS: string };
const migrations = JSON.parse(testEnv.TEST_MIGRATIONS) as Migration[];
const now = '2026-07-21T12:00:00.000Z';
const deadline = '2026-08-31T04:59:59.999Z';

async function seedEvent(id: string, slug: string): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO events (id, slug, name, event_date, welcome_message,
      guest_access_expires_at, management_access_expires_at, purge_after, created_at)
    VALUES (?, ?, 'Maya & Theo', '2026-09-19', 'Welcome.', ?, ?, ?, ?)
  `).bind(id, slug, now, now, now, now).run();
}

async function seedHousehold(
  eventId: string,
  householdId: string,
  householdKey: string,
): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO rsvp_households (id, event_id, household_key, label, created_at, updated_at)
    VALUES (?, ?, ?, 'Perkins household', ?, ?)
  `).bind(householdId, eventId, householdKey, now, now).run();
}

async function count(table: string, where: string, ...bindings: string[]): Promise<number> {
  return await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`)
    .bind(...bindings).first<number>('count') ?? -1;
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, migrations);
});

describe('migration 0008', () => {
  it('adds RSVP configuration to events without disturbing existing defaults', async () => {
    await seedEvent('event-a', 'maya-theo');

    expect(await env.DB.prepare(`
      SELECT event_timezone, rsvp_enabled, rsvp_deadline_at, rsvp_roster_version,
             uploads_enabled
      FROM events WHERE id = 'event-a'
    `).first()).toEqual({
      event_timezone: 'UTC',
      rsvp_enabled: 0,
      rsvp_deadline_at: null,
      rsvp_roster_version: 0,
      uploads_enabled: 1,
    });
  });

  it('refuses to open RSVP without a deadline, on insert and on update', async () => {
    await expect(env.DB.prepare(`
      INSERT INTO events (id, slug, name, event_date, welcome_message,
        guest_access_expires_at, management_access_expires_at, purge_after, created_at,
        rsvp_enabled)
      VALUES ('event-bad', 'bad', 'Maya & Theo', '2026-09-19', 'Welcome.', ?, ?, ?, ?, 1)
    `).bind(now, now, now, now).run()).rejects.toThrow();

    await seedEvent('event-a', 'maya-theo');
    await expect(env.DB.prepare(
      "UPDATE events SET rsvp_enabled = 1 WHERE id = 'event-a'",
    ).run()).rejects.toThrow();

    // Clearing the deadline while RSVP is open is the same mistake in reverse.
    await env.DB.prepare(
      "UPDATE events SET rsvp_deadline_at = ?, rsvp_enabled = 1 WHERE id = 'event-a'",
    ).bind(deadline).run();
    expect(await env.DB.prepare("SELECT rsvp_enabled FROM events WHERE id = 'event-a'")
      .first('rsvp_enabled')).toBe(1);
    await expect(env.DB.prepare(
      "UPDATE events SET rsvp_deadline_at = NULL WHERE id = 'event-a'",
    ).run()).rejects.toThrow();
  });

  it('permits at most one entry credential per event', async () => {
    await seedEvent('event-a', 'maya-theo');
    await seedEvent('event-b', 'other-event');
    const insert = (id: string, eventId: string) => env.DB.prepare(`
      INSERT INTO event_entry_credentials (id, event_id, secret_digest, secret_ciphertext, created_at)
      VALUES (?, ?, 'digest', 'cipher', ?)
    `).bind(id, eventId, now).run();

    await insert('entry-a', 'event-a');
    await insert('entry-b', 'event-b');

    await expect(insert('entry-a2', 'event-a')).rejects.toThrow();
  });

  it('scopes household keys to their event', async () => {
    await seedEvent('event-a', 'maya-theo');
    await seedEvent('event-b', 'other-event');

    await seedHousehold('event-a', 'household-a', 'perkins');
    await seedHousehold('event-b', 'household-b', 'perkins');

    await expect(seedHousehold('event-a', 'household-c', 'perkins')).rejects.toThrow();
  });

  it('refuses a session that pairs one event with another event household', async () => {
    await seedEvent('event-a', 'maya-theo');
    await seedEvent('event-b', 'other-event');
    await seedHousehold('event-a', 'household-a', 'perkins');

    const insertSession = (eventId: string) => env.DB.prepare(`
      INSERT INTO rsvp_sessions (id, secret_digest, csrf_digest, event_id, household_id,
        write_authority_deadline, expires_at, created_at)
      VALUES ('session-1', 'digest', 'csrf', ?, 'household-a', ?, ?, ?)
    `).bind(eventId, deadline, deadline, now).run();

    await expect(insertSession('event-b')).rejects.toThrow();
    await expect(insertSession('event-a')).resolves.toBeDefined();
  });

  it('requires a name and a lookup digest for every named invitee', async () => {
    await seedEvent('event-a', 'maya-theo');
    await seedHousehold('event-a', 'household-a', 'perkins');
    const insertNamed = (
      id: string,
      displayName: string | null,
      lookupDigest: string | null,
      order: number,
    ) => env.DB.prepare(`
      INSERT INTO rsvp_invitees (id, event_id, household_id, kind, display_name,
        lookup_digest, sort_order, created_at, updated_at)
      VALUES (?, 'event-a', 'household-a', 'named', ?, ?, ?, ?, ?)
    `).bind(id, displayName, lookupDigest, order, now, now).run();

    await expect(insertNamed('invitee-nameless', null, 'digest', 0)).rejects.toThrow();
    await expect(insertNamed('invitee-undigested', 'Henry Perkins', null, 1)).rejects.toThrow();
    await expect(insertNamed('invitee-ok', 'Henry Perkins', 'digest', 2)).resolves.toBeDefined();
  });

  it('keeps plus-one slots out of lookup and nameless until they attend', async () => {
    await seedEvent('event-a', 'maya-theo');
    await seedHousehold('event-a', 'household-a', 'perkins');
    const insertSlot = (
      id: string,
      attendance: string,
      displayName: string | null,
      lookupDigest: string | null,
      order: number,
    ) => env.DB.prepare(`
      INSERT INTO rsvp_invitees (id, event_id, household_id, kind, display_name,
        lookup_digest, attendance, sort_order, created_at, updated_at)
      VALUES (?, 'event-a', 'household-a', 'plus_one', ?, ?, ?, ?, ?, ?)
    `).bind(id, displayName, lookupDigest, attendance, order, now, now).run();

    // A plus-one is never searchable by name, however it answers.
    await expect(insertSlot('slot-digested', 'pending', null, 'digest', 0)).rejects.toThrow();
    // Pending and declined slots hold no name at all.
    await expect(insertSlot('slot-named-pending', 'pending', 'Guest', null, 1)).rejects.toThrow();
    await expect(insertSlot('slot-named-declined', 'declined', 'Guest', null, 2)).rejects.toThrow();
    // Attending slots must say who is coming.
    await expect(insertSlot('slot-nameless-attending', 'attending', null, null, 3)).rejects.toThrow();

    await expect(insertSlot('slot-pending', 'pending', null, null, 4)).resolves.toBeDefined();
    await expect(insertSlot('slot-attending', 'attending', 'Sam Rivera', null, 5)).resolves.toBeDefined();
  });

  it('keeps sort order unique inside a household', async () => {
    await seedEvent('event-a', 'maya-theo');
    await seedHousehold('event-a', 'household-a', 'perkins');
    const insert = (id: string, order: number) => env.DB.prepare(`
      INSERT INTO rsvp_invitees (id, event_id, household_id, kind, display_name,
        lookup_digest, sort_order, created_at, updated_at)
      VALUES (?, 'event-a', 'household-a', 'named', 'Henry Perkins', ?, ?, ?, ?)
    `).bind(id, `digest-${id}`, order, now, now).run();

    await insert('invitee-a', 0);
    await expect(insert('invitee-b', 0)).rejects.toThrow();
  });

  it('records a submission receipt once per household and key', async () => {
    await seedEvent('event-a', 'maya-theo');
    await seedHousehold('event-a', 'household-a', 'perkins');
    await seedHousehold('event-a', 'household-b', 'rivera');
    const insert = (householdId: string, key: string) => env.DB.prepare(`
      INSERT INTO rsvp_submission_receipts (event_id, household_id, idempotency_key,
        request_digest, result_version, created_at)
      VALUES ('event-a', ?, ?, 'request-digest', 2, ?)
    `).bind(householdId, key, now).run();

    await insert('household-a', 'key-1');
    // The same client key in a different household is a different submission.
    await insert('household-b', 'key-1');

    await expect(insert('household-a', 'key-1')).rejects.toThrow();
  });

  it('ties a household response summary together or leaves it entirely absent', async () => {
    await seedEvent('event-a', 'maya-theo');
    await seedHousehold('event-a', 'household-a', 'perkins');

    await expect(env.DB.prepare(`
      UPDATE rsvp_households SET last_submission_key = 'key-1' WHERE id = 'household-a'
    `).run()).rejects.toThrow();

    await expect(env.DB.prepare(`
      UPDATE rsvp_households
      SET last_submission_key = 'key-1',
          last_submission_digest = 'digest',
          last_submission_result_version = 2
      WHERE id = 'household-a'
    `).run()).resolves.toBeDefined();
  });

  it('does not enforce the one-named-invitee rule in SQL', async () => {
    // A plus-one-only household is refused by import, manual editing, and RSVP
    // activation, not by a constraint. This pins that the guarantee lives in
    // those services, so nobody deletes the check believing SQL has it covered.
    await seedEvent('event-a', 'maya-theo');
    await seedHousehold('event-a', 'household-a', 'perkins');

    await expect(env.DB.prepare(`
      INSERT INTO rsvp_invitees (id, event_id, household_id, kind, display_name,
        lookup_digest, sort_order, created_at, updated_at)
      VALUES ('slot-only', 'event-a', 'household-a', 'plus_one', NULL, NULL, 0, ?, ?)
    `).bind(now, now).run()).resolves.toBeDefined();
  });

  it('purges every RSVP row when its event is deleted', async () => {
    await seedEvent('event-a', 'maya-theo');
    await seedEvent('event-b', 'other-event');
    await seedHousehold('event-a', 'household-a', 'perkins');
    await seedHousehold('event-b', 'household-b', 'rivera');

    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO event_entry_credentials (id, event_id, secret_digest, secret_ciphertext, created_at)
        VALUES ('entry-a', 'event-a', 'digest', 'cipher', ?)
      `).bind(now),
      env.DB.prepare(`
        INSERT INTO rsvp_invitees (id, event_id, household_id, kind, display_name,
          lookup_digest, sort_order, created_at, updated_at)
        VALUES ('invitee-a', 'event-a', 'household-a', 'named', 'Henry Perkins', 'digest', 0, ?, ?)
      `).bind(now, now),
      env.DB.prepare(`
        INSERT INTO rsvp_sessions (id, secret_digest, csrf_digest, event_id, household_id,
          write_authority_deadline, expires_at, created_at)
        VALUES ('session-a', 'digest', 'csrf', 'event-a', 'household-a', ?, ?, ?)
      `).bind(deadline, deadline, now),
      env.DB.prepare(`
        INSERT INTO rsvp_submission_receipts (event_id, household_id, idempotency_key,
          request_digest, result_version, created_at)
        VALUES ('event-a', 'household-a', 'key-1', 'request-digest', 2, ?)
      `).bind(now),
      env.DB.prepare(`
        INSERT INTO rsvp_lookup_rate_limits (event_id, action, scope_digest,
          window_started_at, attempts)
        VALUES ('event-a', 'lookup_ip', 'scope-digest', ?, 1)
      `).bind(now),
    ]);

    await env.DB.prepare("DELETE FROM events WHERE id = 'event-a'").run();

    expect(await count('event_entry_credentials', 'event_id = ?', 'event-a')).toBe(0);
    expect(await count('rsvp_households', 'event_id = ?', 'event-a')).toBe(0);
    expect(await count('rsvp_invitees', 'event_id = ?', 'event-a')).toBe(0);
    expect(await count('rsvp_sessions', 'event_id = ?', 'event-a')).toBe(0);
    expect(await count('rsvp_submission_receipts', 'event_id = ?', 'event-a')).toBe(0);
    expect(await count('rsvp_lookup_rate_limits', 'event_id = ?', 'event-a')).toBe(0);
    // The neighbouring event is untouched.
    expect(await count('rsvp_households', 'event_id = ?', 'event-b')).toBe(1);
  });

  it('cascades invitees, sessions, and receipts when one household is deleted', async () => {
    await seedEvent('event-a', 'maya-theo');
    await seedHousehold('event-a', 'household-a', 'perkins');
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO rsvp_invitees (id, event_id, household_id, kind, display_name,
          lookup_digest, sort_order, created_at, updated_at)
        VALUES ('invitee-a', 'event-a', 'household-a', 'named', 'Henry Perkins', 'digest', 0, ?, ?)
      `).bind(now, now),
      env.DB.prepare(`
        INSERT INTO rsvp_sessions (id, secret_digest, csrf_digest, event_id, household_id,
          write_authority_deadline, expires_at, created_at)
        VALUES ('session-a', 'digest', 'csrf', 'event-a', 'household-a', ?, ?, ?)
      `).bind(deadline, deadline, now),
      env.DB.prepare(`
        INSERT INTO rsvp_submission_receipts (event_id, household_id, idempotency_key,
          request_digest, result_version, created_at)
        VALUES ('event-a', 'household-a', 'key-1', 'request-digest', 2, ?)
      `).bind(now),
    ]);

    await env.DB.prepare("DELETE FROM rsvp_households WHERE id = 'household-a'").run();

    expect(await count('rsvp_invitees', 'household_id = ?', 'household-a')).toBe(0);
    expect(await count('rsvp_sessions', 'household_id = ?', 'household-a')).toBe(0);
    expect(await count('rsvp_submission_receipts', 'household_id = ?', 'household-a')).toBe(0);
  });

  it('leaves no orphaned RSVP rows behind after a purge', async () => {
    await seedEvent('event-a', 'maya-theo');
    await seedHousehold('event-a', 'household-a', 'perkins');
    await env.DB.prepare(`
      INSERT INTO rsvp_invitees (id, event_id, household_id, kind, display_name,
        lookup_digest, sort_order, created_at, updated_at)
      VALUES ('invitee-a', 'event-a', 'household-a', 'named', 'Henry Perkins', 'digest', 0, ?, ?)
    `).bind(now, now).run();
    await env.DB.prepare("DELETE FROM events WHERE id = 'event-a'").run();

    const orphans = await env.DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM rsvp_invitees i
          WHERE NOT EXISTS (
            SELECT 1 FROM rsvp_households h
            WHERE h.id = i.household_id AND h.event_id = i.event_id
          )) AS orphan_invitees,
        (SELECT COUNT(*) FROM rsvp_households h
          WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.id = h.event_id)) AS orphan_households,
        (SELECT COUNT(*) FROM rsvp_sessions s
          WHERE NOT EXISTS (
            SELECT 1 FROM rsvp_households h
            WHERE h.id = s.household_id AND h.event_id = s.event_id
          )) AS orphan_sessions,
        (SELECT COUNT(*) FROM event_entry_credentials c
          WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.id = c.event_id)) AS orphan_entries
    `).first();
    expect(orphans).toEqual({
      orphan_invitees: 0,
      orphan_households: 0,
      orphan_sessions: 0,
      orphan_entries: 0,
    });
  });
});

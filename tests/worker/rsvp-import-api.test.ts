import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../worker/app';
import { buildRosterStatements, MAX_D1_BINDINGS } from '../../worker/db/rsvp';
import { eventAccess, resetDatabase, testEnv, writeHeaders } from './helpers';

type Access = Awaited<ReturnType<typeof eventAccess>>;

const HEADER = 'household_key,household_label,invitee_name,plus_one_slots';

const SAMPLE = [
  HEADER,
  'perkins,Perkins household,Henry Perkins,1',
  'perkins,Perkins household,Jordan Perkins,1',
  'rivera,Rivera household,Avery Rivera,0',
].join('\n');

function preview(access: Access, csv: string) {
  return createApp().request(
    `/api/manage/events/${access.event.id}/rsvp/import/preview`,
    { method: 'POST', headers: writeHeaders(access.manager), body: JSON.stringify({ csv }) },
    testEnv,
  );
}

function commit(access: Access, body: Record<string, unknown>) {
  return createApp().request(
    `/api/manage/events/${access.event.id}/rsvp/import/commit`,
    { method: 'POST', headers: writeHeaders(access.manager), body: JSON.stringify(body) },
    testEnv,
  );
}

async function previewed(access: Access, csv: string) {
  const response = await preview(access, csv);
  expect(response.status).toBe(200);
  return (await response.json<any>()).data;
}

async function countRows(table: string): Promise<number> {
  return await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<number>('count') ?? -1;
}

function roster(households: number, plusOnesOnFirst = 0): string {
  return [
    HEADER,
    ...Array.from(
      { length: households },
      (_unused, index) => `h${index},Household ${index},Guest Number ${index},${index === 0 ? plusOnesOnFirst : 0}`,
    ),
  ].join('\n');
}

beforeEach(resetDatabase);

describe('RSVP roster import preview', () => {
  it('reports counts and a source digest without writing a row', async () => {
    const access = await eventAccess();
    const data = await previewed(access, SAMPLE);

    expect(data.issues).toEqual([]);
    expect(data.totals).toEqual({
      households: 2,
      namedInvitees: 3,
      plusOneCapacity: 1,
      invitedCapacity: 4,
    });
    expect(data.sourceDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(data.rosterVersion).toBe(0);
    expect(await countRows('rsvp_households')).toBe(0);
    expect(await countRows('rsvp_invitees')).toBe(0);
  });

  it('accepts a BOM and quoted fields', async () => {
    const access = await eventAccess();
    const data = await previewed(
      access,
      `${String.fromCharCode(0xfeff)}${HEADER}\r\n"rivera","Rivera, Sanchez & co.","Avery ""AJ"" Rivera",0\r\n`,
    );

    expect(data.issues).toEqual([]);
    expect(data.totals.households).toBe(1);
  });

  it.each<[string, string, string]>([
    ['a wrong header', 'a,b,c,d\nperkins,Perkins,Henry Perkins,0', 'header_invalid'],
    ['malformed quoting', `${HEADER}\nperkins,"Perkins,Henry Perkins,0`, 'row_malformed'],
    ['an invalid household key', `${HEADER}\nPerkins,Perkins,Henry Perkins,0`, 'household_key_invalid'],
    ['a missing name', `${HEADER}\nperkins,Perkins,,0`, 'invitee_name_invalid'],
    ['a bad plus-one count', `${HEADER}\nperkins,Perkins,Henry Perkins,eleven`, 'plus_one_slots_invalid'],
    [
      'an inconsistent repeated label',
      `${HEADER}\nperkins,Perkins household,Henry Perkins,0\nperkins,Perkins family,Jordan Perkins,0`,
      'household_label_inconsistent',
    ],
    [
      'an inconsistent repeated plus-one count',
      `${HEADER}\nperkins,Perkins household,Henry Perkins,0\nperkins,Perkins household,Jordan Perkins,2`,
      'household_plus_one_inconsistent',
    ],
    [
      'a repeated name inside one household',
      `${HEADER}\nperkins,Perkins household,Henry Perkins,0\nperkins,Perkins household,  henry  perkins ,0`,
      'household_duplicate_name',
    ],
    [
      'two households an exact search cannot separate',
      `${HEADER}\nlee-a,Lee household,Alex Lee,0\nlee-b,Lee household,Alex Lee,0`,
      'household_lookup_unresolvable',
    ],
  ])('answers 200 and blocks on %s', async (_label, csv, code) => {
    const access = await eventAccess();
    const data = await previewed(access, csv);

    // The issues are the preview result, so this is a successful preview of an
    // unusable file rather than a failed request.
    expect(data.issues.map((issue: { code: string }) => issue.code)).toContain(code);
    expect(data.issues.every((issue: { blocking: boolean }) => issue.blocking)).toBe(true);
    expect(data.totals).toEqual({
      households: 0, namedInvitees: 0, plusOneCapacity: 0, invitedCapacity: 0,
    });
    expect(await countRows('rsvp_households')).toBe(0);
    expect(await countRows('rsvp_invitees')).toBe(0);
  });

  it('treats a household with only plus-one slots as a missing name', async () => {
    const access = await eventAccess();
    // The format has no way to express a household nobody is named in, and the
    // parser refuses the attempt rather than inventing an empty household.
    const data = await previewed(access, `${HEADER}\nperkins,Perkins household,,2`);
    expect(data.issues.map((issue: { code: string }) => issue.code)).toEqual(['invitee_name_invalid']);
  });

  it('allows a shared name when a second household member resolves it', async () => {
    const access = await eventAccess();
    const data = await previewed(access, [
      HEADER,
      'lee-a,Lee household,Alex Lee,0',
      'lee-a,Lee household,Sam Lee,0',
      'lee-b,Lee household,Alex Lee,0',
      'lee-b,Lee household,Pat Lee,0',
    ].join('\n'));

    expect(data.issues).toEqual([]);
    expect(data.totals.households).toBe(2);
  });

  it('changes the source digest when a single byte changes', async () => {
    const access = await eventAccess();
    const first = await previewed(access, SAMPLE);
    const second = await previewed(access, SAMPLE.replace('Avery Rivera', 'Avery Riveras'));

    expect(second.sourceDigest).not.toBe(first.sourceDigest);
  });

  it('refuses a file over the published byte limit', async () => {
    const access = await eventAccess();
    const data = await previewed(
      access,
      `${HEADER}\nperkins,${'a'.repeat(300 * 1024)},Henry Perkins,0`,
    );

    expect(data.issues.map((issue: { code: string }) => issue.code)).toEqual(['file_too_large']);
  });

  it('is manager-only', async () => {
    const access = await eventAccess();
    const denied = await createApp().request(
      `/api/manage/events/${access.event.id}/rsvp/import/preview`,
      {
        method: 'POST',
        headers: { ...writeHeaders(access.guest), 'x-candidary-csrf': access.guest.csrf },
        body: JSON.stringify({ csv: SAMPLE }),
      },
      testEnv,
    );
    expect(denied.status).toBe(403);
  });
});

describe('RSVP roster import commit', () => {
  it('commits the previewed roster once and advances the roster version', async () => {
    const access = await eventAccess();
    const { sourceDigest, rosterVersion } = await previewed(access, SAMPLE);

    const response = await commit(access, { csv: SAMPLE, sourceDigest, expectedRosterVersion: rosterVersion });
    const data = (await response.json<any>()).data;

    expect(response.status).toBe(201);
    expect(data.totals.invitedCapacity).toBe(4);
    expect(data.rosterVersion).toBe(1);
    expect(await countRows('rsvp_households')).toBe(2);
    // Two named guests plus one slot each in the Perkins household, one named
    // guest and no slots in the Rivera household.
    expect(await countRows('rsvp_invitees')).toBe(4);

    const stored = await env.DB.prepare(`
      SELECT kind, display_name, lookup_digest, attendance, sort_order
      FROM rsvp_invitees
      WHERE household_id = (SELECT id FROM rsvp_households WHERE household_key = 'perkins')
      ORDER BY sort_order
    `).all<any>();
    expect(stored.results.map((row) => [row.kind, row.display_name, row.attendance])).toEqual([
      ['named', 'Henry Perkins', 'pending'],
      ['named', 'Jordan Perkins', 'pending'],
      ['plus_one', null, 'pending'],
    ]);
    // Named guests are searchable; the slot is not, and no digest is the raw name.
    expect(stored.results[0].lookup_digest).toEqual(expect.any(String));
    expect(stored.results[0].lookup_digest).not.toContain('Henry');
    expect(stored.results[2].lookup_digest).toBeNull();
  });

  it('refuses a commit whose file no longer matches the preview', async () => {
    const access = await eventAccess();
    const { rosterVersion } = await previewed(access, SAMPLE);

    const response = await commit(access, {
      csv: SAMPLE,
      sourceDigest: 'a'.repeat(64),
      expectedRosterVersion: rosterVersion,
    });

    expect(response.status).toBe(409);
    expect((await response.json<any>()).code).toBe('RSVP_IMPORT_CONFLICT');
    expect(await countRows('rsvp_households')).toBe(0);
  });

  it('reparses server-side rather than trusting the preview', async () => {
    const access = await eventAccess();
    const broken = `${HEADER}\nlee-a,Lee household,Alex Lee,0\nlee-b,Lee household,Alex Lee,0`;
    const { sourceDigest, rosterVersion } = await previewed(access, broken);

    const response = await commit(access, { csv: broken, sourceDigest, expectedRosterVersion: rosterVersion });

    expect(response.status).toBe(409);
    expect((await response.json<any>()).code).toBe('RSVP_IMPORT_CONFLICT');
    expect(await countRows('rsvp_households')).toBe(0);
  });

  it('refuses a second import once any household exists', async () => {
    const access = await eventAccess();
    const first = await previewed(access, SAMPLE);
    await commit(access, {
      csv: SAMPLE, sourceDigest: first.sourceDigest, expectedRosterVersion: first.rosterVersion,
    });

    const second = await previewed(access, SAMPLE);
    const response = await commit(access, {
      csv: SAMPLE, sourceDigest: second.sourceDigest, expectedRosterVersion: second.rosterVersion,
    });

    expect(response.status).toBe(409);
    expect((await response.json<any>()).code).toBe('RSVP_IMPORT_CONFLICT');
    // The first roster is intact: a refused second import changes nothing.
    expect(await countRows('rsvp_households')).toBe(2);
    expect(await countRows('rsvp_invitees')).toBe(4);
  });

  it('refuses an import once an archived household exists', async () => {
    const access = await eventAccess();
    const first = await previewed(access, SAMPLE);
    await commit(access, {
      csv: SAMPLE, sourceDigest: first.sourceDigest, expectedRosterVersion: first.rosterVersion,
    });
    await env.DB.prepare('UPDATE rsvp_households SET archived_at = ?')
      .bind('2026-07-21T12:00:00.000Z').run();
    await env.DB.prepare('DELETE FROM rsvp_invitees').run();

    const again = await previewed(access, SAMPLE);
    const response = await commit(access, {
      csv: SAMPLE, sourceDigest: again.sourceDigest, expectedRosterVersion: again.rosterVersion,
    });

    expect(response.status).toBe(409);
  });

  it('refuses a stale expected roster version', async () => {
    const access = await eventAccess();
    const { sourceDigest } = await previewed(access, SAMPLE);

    const response = await commit(access, { csv: SAMPLE, sourceDigest, expectedRosterVersion: 9 });

    expect(response.status).toBe(409);
    expect(await countRows('rsvp_households')).toBe(0);
  });

  it('refuses an import while RSVP is already open', async () => {
    const access = await eventAccess();
    const first = await previewed(access, SAMPLE);
    await commit(access, {
      csv: SAMPLE, sourceDigest: first.sourceDigest, expectedRosterVersion: first.rosterVersion,
    });
    // Open RSVP, then wipe the roster so only the enabled flag stands in the way.
    await env.DB.prepare('UPDATE events SET rsvp_enabled = 1 WHERE id = ?').bind(access.event.id).run();
    await env.DB.prepare('DELETE FROM rsvp_invitees').run();
    await env.DB.prepare('DELETE FROM rsvp_households').run();

    const again = await previewed(access, SAMPLE);
    const response = await commit(access, {
      csv: SAMPLE, sourceDigest: again.sourceDigest, expectedRosterVersion: again.rosterVersion,
    });

    expect(response.status).toBe(409);
    expect(await countRows('rsvp_households')).toBe(0);
  });

  it('commits a full five-hundred-person roster atomically', async () => {
    const access = await eventAccess();
    const csv = roster(500);
    const { sourceDigest, rosterVersion } = await previewed(access, csv);

    const response = await commit(access, { csv, sourceDigest, expectedRosterVersion: rosterVersion });

    expect(response.status).toBe(201);
    expect((await response.json<any>()).data.totals.invitedCapacity).toBe(500);
    expect(await countRows('rsvp_households')).toBe(500);
    expect(await countRows('rsvp_invitees')).toBe(500);
  });

  it('refuses a roster one person over the event capacity', async () => {
    const access = await eventAccess();
    const data = await previewed(access, roster(500, 1));
    expect(data.issues.map((issue: { code: string }) => issue.code)).toEqual(['event_capacity_limit']);
  });

  it('keeps every generated statement inside D1 parameter limits', () => {
    const plans = buildRosterStatements({
      eventId: 'event-a',
      createdAt: '2026-07-21T12:00:00.000Z',
      households: Array.from({ length: 500 }, (_unused, index) => ({
        id: `household-${index}`, householdKey: `h${index}`, label: `Household ${index}`,
      })),
      invitees: Array.from({ length: 500 }, (_unused, index) => ({
        id: `invitee-${index}`,
        householdId: `household-${index}`,
        kind: 'named' as const,
        displayName: `Guest Number ${index}`,
        lookupDigest: `digest-${index}`,
        sortOrder: 0,
      })),
    });

    for (const plan of plans) {
      expect(plan.bindings.length).toBeLessThanOrEqual(MAX_D1_BINDINGS);
    }
  });

  it('never records a guest name or the file itself in an error body', async () => {
    const access = await eventAccess();
    const csv = `${HEADER}\nperkins,Perkins household,Henrietta Vandersloot,eleven`;
    const data = await previewed(access, csv);

    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain('Henrietta');
    expect(serialized).not.toContain('Vandersloot');
    expect(serialized).not.toContain('household_key,household_label');
  });
});

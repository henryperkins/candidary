import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildBackfillArtifacts,
  parseInventoryPayload,
  verifyBackfillPlan,
  type BackfillPlan,
  type InventoryRow,
} from '../../scripts/event-start-backfill';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'candidary-event-start-'));
  temporaryDirectories.push(directory);
  return directory;
}

function chicagoRow(overrides: Partial<InventoryRow> = {}): InventoryRow {
  return {
    id: 'chicago-event',
    slug: 'chicago-event',
    event_date: '2026-09-19',
    event_timezone: 'America/Chicago',
    rsvp_deadline_at: '2026-09-18T23:59:59.999Z',
    inventory_at: '2026-08-03T12:00:00.000Z',
    uploads_enabled: 1,
    entry_enabled: 1,
    deleted_at: null,
    ...overrides,
  };
}

function postChicagoRow(overrides: Partial<InventoryRow> = {}): InventoryRow {
  return {
    id: 'chicago-event',
    event_date: '2026-09-19',
    event_timezone: 'America/Chicago',
    rsvp_deadline_at: '2026-09-18T23:59:59.999Z',
    event_start_at: '2026-09-19T05:00:00.000Z',
    uploads_enabled: 1,
    photos_open_from: '2026-08-02T12:00:00.000Z',
    entry_enabled: 1,
    deleted_at: null,
    ...overrides,
  };
}

function exactPlan(): BackfillPlan {
  return buildBackfillArtifacts([
    chicagoRow(),
    {
      id: "o'hare",
      slug: 'kolkata-event',
      event_date: '2026-07-30',
      event_timezone: 'Asia/Kolkata',
      rsvp_deadline_at: null,
      inventory_at: '2026-08-03T12:00:00.000Z',
      uploads_enabled: 1,
      entry_enabled: 1,
      deleted_at: null,
    },
  ]).plan;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('event-start backfill planning', () => {
  it('parses plain rows and Wrangler d1 JSON envelopes', () => {
    const rows = [chicagoRow()];

    expect(parseInventoryPayload(rows)).toEqual(rows);
    expect(parseInventoryPayload([
      {
        results: rows,
        success: true,
        meta: { duration: 0.12, changes: 0 },
      },
    ])).toEqual(rows);
  });

  it('derives deterministic IANA-aware starts and SQL with escaped IDs', () => {
    const { plan, planJson, sql } = buildBackfillArtifacts([
      {
        id: "o'hare",
        slug: 'kolkata-event',
        event_date: '2026-07-30',
        event_timezone: 'Asia/Kolkata',
        rsvp_deadline_at: null,
        inventory_at: '2026-08-03T12:00:00.000Z',
        uploads_enabled: 1,
        entry_enabled: 1,
        deleted_at: null,
      },
      chicagoRow(),
    ]);

    expect(plan).toEqual({
      kind: 'candidary-event-start-backfill',
      version: 3,
      events: [
        {
          id: 'chicago-event',
          eventDate: '2026-09-19',
          eventTimezone: 'America/Chicago',
          rsvpDeadlineAt: '2026-09-18T23:59:59.999Z',
          inventoryAt: '2026-08-03T12:00:00.000Z',
          uploadsEnabled: true,
          entryEnabled: true,
          photoDisposition: 'preserve-open',
          expectedEventStartAt: '2026-09-19T05:00:00.000Z',
        },
        {
          id: "o'hare",
          eventDate: '2026-07-30',
          eventTimezone: 'Asia/Kolkata',
          rsvpDeadlineAt: null,
          inventoryAt: '2026-08-03T12:00:00.000Z',
          uploadsEnabled: true,
          entryEnabled: true,
          photoDisposition: 'preserve-open',
          expectedEventStartAt: '2026-07-29T18:30:00.000Z',
        },
      ],
    });
    expect(planJson).toBe(`${JSON.stringify(plan, null, 2)}\n`);
    expect(sql).toContain(
      "UPDATE events SET event_start_at = '2026-07-29T18:30:00.000Z', photos_open_from = COALESCE(photos_open_from, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) WHERE id = 'o''hare' AND deleted_at IS NULL AND event_date = '2026-07-30' AND event_timezone = 'Asia/Kolkata' AND rsvp_deadline_at IS NULL AND uploads_enabled = 1 AND event_start_at IN ('1970-01-01T00:00:00.000Z', '2026-07-30T00:00:00.000Z');",
    );
    expect(sql).toContain(
      "WHERE id = 'chicago-event' AND deleted_at IS NULL AND event_date = '2026-09-19' AND event_timezone = 'America/Chicago' AND rsvp_deadline_at = '2026-09-18T23:59:59.999Z' AND uploads_enabled = 1 AND event_start_at IN",
    );
    expect(sql.indexOf("id = 'chicago-event'")).toBeLessThan(sql.indexOf("id = 'o''hare'"));
  });

  it('blocks a row whose RSVP deadline is not strictly before local midnight', () => {
    expect(() => buildBackfillArtifacts([
      chicagoRow({ rsvp_deadline_at: '2026-09-19T05:00:00.000Z' }),
    ])).toThrow(/chicago-event.*strictly before.*2026-09-19T05:00:00\.000Z/iu);
  });

  it('preserves photo delivery that the old Worker still considers open', () => {
    const { sql } = buildBackfillArtifacts([chicagoRow({
      uploads_enabled: 1,
      event_start_at: '1970-01-01T00:00:00.000Z',
      photos_open_from: null,
    })]);
    const database = new DatabaseSync(':memory:');
    try {
      database.exec(`
        CREATE TABLE events (
          id TEXT PRIMARY KEY,
          event_date TEXT NOT NULL,
          event_timezone TEXT NOT NULL,
          rsvp_deadline_at TEXT,
          event_start_at TEXT NOT NULL,
          photos_open_from TEXT,
          uploads_enabled INTEGER NOT NULL,
          deleted_at TEXT
        );
        INSERT INTO events VALUES (
          'chicago-event', '2026-09-19', 'America/Chicago',
          '2026-09-18T23:59:59.999Z', '1970-01-01T00:00:00.000Z', NULL, 1, NULL
        );
      `);

      database.exec(sql);
      const stored = database.prepare(`
        SELECT event_start_at, photos_open_from FROM events WHERE id = 'chicago-event'
      `).get() as { event_start_at: string; photos_open_from: string | null };

      expect(stored.event_start_at).toBe('2026-09-19T05:00:00.000Z');
      expect(stored.photos_open_from).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
    } finally {
      database.close();
    }
  });

  it('restores scheduled capability for a legacy uploads-off event that has not started', () => {
    const { plan, sql, postDeploySql } = buildBackfillArtifacts([chicagoRow({
      inventory_at: '2026-08-03T12:00:00.000Z',
      uploads_enabled: 0,
      event_start_at: '1970-01-01T00:00:00.000Z',
      photos_open_from: null,
    })]);
    const database = new DatabaseSync(':memory:');
    try {
      database.exec(`
        CREATE TABLE events (
          id TEXT PRIMARY KEY,
          event_date TEXT NOT NULL,
          event_timezone TEXT NOT NULL,
          rsvp_deadline_at TEXT,
          event_start_at TEXT NOT NULL,
          photos_open_from TEXT,
          uploads_enabled INTEGER NOT NULL,
          deleted_at TEXT
        );
        CREATE TABLE event_entry_credentials (
          event_id TEXT PRIMARY KEY,
          disabled_at TEXT
        );
        INSERT INTO events VALUES (
          'chicago-event', '2026-09-19', 'America/Chicago',
          '2026-09-18T23:59:59.999Z', '1970-01-01T00:00:00.000Z', NULL, 0, NULL
        );
        INSERT INTO event_entry_credentials VALUES ('chicago-event', NULL);
      `);

      database.exec(sql);
      expect(database.prepare(`
        SELECT event_start_at, photos_open_from, uploads_enabled
        FROM events WHERE id = 'chicago-event'
      `).get()).toEqual({
        event_start_at: '2026-09-19T05:00:00.000Z',
        photos_open_from: null,
        uploads_enabled: 0,
      });

      database.exec(postDeploySql);
      expect(database.prepare(`
        SELECT event_start_at, photos_open_from, uploads_enabled
        FROM events WHERE id = 'chicago-event'
      `).get()).toEqual({
        event_start_at: '2026-09-19T05:00:00.000Z',
        photos_open_from: null,
        uploads_enabled: 1,
      });
      expect(plan.events[0]).toMatchObject({ photoDisposition: 'restore-scheduled' });
    } finally {
      database.close();
    }
  });

  it('keeps an already-started legacy uploads-off event paused', () => {
    const { plan, sql } = buildBackfillArtifacts([chicagoRow({
      inventory_at: '2026-10-03T12:00:00.000Z',
      uploads_enabled: 0,
      event_start_at: '1970-01-01T00:00:00.000Z',
      photos_open_from: null,
    })]);
    const database = new DatabaseSync(':memory:');
    try {
      database.exec(`
        CREATE TABLE events (
          id TEXT PRIMARY KEY,
          event_date TEXT NOT NULL,
          event_timezone TEXT NOT NULL,
          rsvp_deadline_at TEXT,
          event_start_at TEXT NOT NULL,
          photos_open_from TEXT,
          uploads_enabled INTEGER NOT NULL,
          deleted_at TEXT
        );
        INSERT INTO events VALUES (
          'chicago-event', '2026-09-19', 'America/Chicago',
          '2026-09-18T23:59:59.999Z', '1970-01-01T00:00:00.000Z', NULL, 0, NULL
        );
      `);

      database.exec(sql);
      expect(database.prepare(`
        SELECT event_start_at, photos_open_from, uploads_enabled
        FROM events WHERE id = 'chicago-event'
      `).get()).toEqual({
        event_start_at: '2026-09-19T05:00:00.000Z',
        photos_open_from: null,
        uploads_enabled: 0,
      });
      expect(plan.events[0]).toMatchObject({ photoDisposition: 'remain-paused' });
    } finally {
      database.close();
    }
  });

  it('preserves an irreversible disabled-entry tombstone for a future event', () => {
    const { plan, postDeploySql } = buildBackfillArtifacts([chicagoRow({
      uploads_enabled: 0,
      entry_enabled: 0,
    })]);

    expect(plan.events[0]).toMatchObject({
      entryEnabled: false,
      photoDisposition: 'remain-paused',
    });
    expect(postDeploySql).not.toContain("WHERE id = 'chicago-event'");
  });
});

describe('event-start backfill verification', () => {
  it('reports missing, UTC-approximation, epoch-sentinel, and other mismatches', () => {
    const plan = buildBackfillArtifacts([
      chicagoRow(),
      chicagoRow({ id: 'missing-event', slug: 'missing-event' }),
      chicagoRow({ id: 'sentinel-event', slug: 'sentinel-event' }),
      chicagoRow({ id: 'wrong-event', slug: 'wrong-event' }),
    ]).plan;

    expect(verifyBackfillPlan(plan, [
      postChicagoRow({ event_start_at: '2026-09-19T00:00:00.000Z' }),
      postChicagoRow({ id: 'sentinel-event', event_start_at: '1970-01-01T00:00:00.000Z' }),
      postChicagoRow({ id: 'wrong-event', event_start_at: '2026-09-19T06:00:00.000Z' }),
    ])).toEqual({
      ok: false,
      verifiedCount: 0,
      issues: [
        {
          id: 'chicago-event',
          kind: 'utc-midnight-approximation',
          expected: '2026-09-19T05:00:00.000Z',
          actual: '2026-09-19T00:00:00.000Z',
        },
        {
          id: 'missing-event',
          kind: 'missing',
          expected: '2026-09-19T05:00:00.000Z',
          actual: null,
        },
        {
          id: 'sentinel-event',
          kind: 'epoch-sentinel',
          expected: '2026-09-19T05:00:00.000Z',
          actual: '1970-01-01T00:00:00.000Z',
        },
        {
          id: 'wrong-event',
          kind: 'mismatch',
          expected: '2026-09-19T05:00:00.000Z',
          actual: '2026-09-19T06:00:00.000Z',
        },
      ],
    });
  });

  it('verifies every planned ID at the exact expected instant', () => {
    const plan = exactPlan();

    expect(verifyBackfillPlan(plan, [
      {
        id: "o'hare",
        event_date: '2026-07-30',
        event_timezone: 'Asia/Kolkata',
        rsvp_deadline_at: null,
        event_start_at: '2026-07-29T18:30:00.000Z',
        uploads_enabled: 1,
        photos_open_from: '2026-08-02T12:00:00.000Z',
        entry_enabled: 1,
        deleted_at: null,
      },
      postChicagoRow(),
    ])).toEqual({ ok: true, verifiedCount: 2, issues: [] });
  });

  it('blocks inventoried source drift even when the stored start still matches', () => {
    const plan = buildBackfillArtifacts([chicagoRow()]).plan;

    expect(verifyBackfillPlan(plan, [postChicagoRow({
      event_date: '2026-09-20',
      event_timezone: 'America/Denver',
      rsvp_deadline_at: null,
    })])).toEqual({
      ok: false,
      verifiedCount: 0,
      issues: [
        {
          id: 'chicago-event',
          kind: 'source-mismatch',
          field: 'event_date',
          expected: '2026-09-19',
          actual: '2026-09-20',
        },
        {
          id: 'chicago-event',
          kind: 'source-mismatch',
          field: 'event_timezone',
          expected: 'America/Chicago',
          actual: 'America/Denver',
        },
        {
          id: 'chicago-event',
          kind: 'source-mismatch',
          field: 'rsvp_deadline_at',
          expected: '2026-09-18T23:59:59.999Z',
          actual: null,
        },
      ],
    });
  });

  it('blocks an upload-capability change after planning', () => {
    const plan = buildBackfillArtifacts([chicagoRow({ uploads_enabled: 1 })]).plan;

    expect(verifyBackfillPlan(plan, [postChicagoRow({ uploads_enabled: 0 })])).toEqual({
      ok: false,
      verifiedCount: 0,
      issues: [{
        id: 'chicago-event',
        kind: 'capability-mismatch',
        field: 'uploads_enabled',
        expected: 1,
        actual: 0,
      }],
    });
  });

  it('requires post-apply proof that previously open photo delivery stayed open', () => {
    const plan = buildBackfillArtifacts([chicagoRow({ uploads_enabled: 1 })]).plan;

    expect(verifyBackfillPlan(plan, [postChicagoRow({ photos_open_from: null })])).toEqual({
      ok: false,
      verifiedCount: 0,
      issues: [{
        id: 'chicago-event',
        kind: 'photo-open-not-preserved',
        expected: 'UTC ISO instant',
        actual: null,
      }],
    });
  });

  it('keeps legacy scheduled capability off until post-deploy finalization', () => {
    const plan = buildBackfillArtifacts([chicagoRow({ uploads_enabled: 0 })]).plan;
    const staged = postChicagoRow({
      uploads_enabled: 0,
      photos_open_from: null,
    });

    expect(verifyBackfillPlan(plan, [staged], { stage: 'predeploy' }))
      .toEqual({ ok: true, verifiedCount: 1, issues: [] });
    expect(verifyBackfillPlan(plan, [staged])).toMatchObject({
      ok: false,
      verifiedCount: 0,
      issues: [{
        id: 'chicago-event',
        kind: 'capability-mismatch',
        field: 'uploads_enabled',
        expected: 1,
        actual: 0,
      }],
    });
    expect(verifyBackfillPlan(plan, [postChicagoRow({ photos_open_from: null })]))
      .toEqual({ ok: true, verifiedCount: 1, issues: [] });
  });

  it('optionally blocks an epoch sentinel whose ID is not in the plan', () => {
    const plan = buildBackfillArtifacts([chicagoRow()]).plan;
    const postRows: InventoryRow[] = [
      postChicagoRow(),
      postChicagoRow({ id: 'deploy-gap-event', event_start_at: '1970-01-01T00:00:00.000Z' }),
    ];

    expect(verifyBackfillPlan(plan, postRows)).toEqual({
      ok: true,
      verifiedCount: 1,
      issues: [],
    });
    expect(verifyBackfillPlan(plan, postRows, { requireNoSentinel: true })).toEqual({
      ok: false,
      verifiedCount: 1,
      issues: [{
        id: 'deploy-gap-event',
        kind: 'epoch-sentinel',
        expected: null,
        actual: '1970-01-01T00:00:00.000Z',
      }],
    });
  });

  it('pre-deploy completeness rejects unplanned approximations but allows gap sentinels', () => {
    const plan = buildBackfillArtifacts([chicagoRow()]).plan;
    const deployGap = postChicagoRow({
      id: 'after-migration',
      event_start_at: '1970-01-01T00:00:00.000Z',
    });

    expect(verifyBackfillPlan(plan, [postChicagoRow(), deployGap], {
      requirePredeployCompleteness: true,
    })).toEqual({ ok: true, verifiedCount: 1, issues: [] });

    expect(verifyBackfillPlan(plan, [
      postChicagoRow(),
      deployGap,
      postChicagoRow({
        id: 'before-migration',
        event_start_at: '2026-09-19T00:00:00.000Z',
      }),
    ], { requirePredeployCompleteness: true })).toEqual({
      ok: false,
      verifiedCount: 1,
      issues: [{
        id: 'before-migration',
        kind: 'unplanned-non-sentinel',
        expected: null,
        actual: '2026-09-19T00:00:00.000Z',
      }],
    });
  });
});

describe('event-start release schedule freeze', () => {
  it('closes the old-Worker edit window without blocking unchanged settings or gap creates', () => {
    const directory = temporaryDirectory();
    const installPath = join(directory, 'install-freeze.sql');
    const removePath = join(directory, 'remove-freeze.sql');
    const secondInstallPath = join(directory, 'install-freeze-second.sql');
    const secondRemovePath = join(directory, 'remove-freeze-second.sql');
    const scriptPath = resolve('scripts/event-start-backfill.ts');
    const generate = (install: string, remove: string) => spawnSync(process.execPath, [
      '--experimental-strip-types',
      scriptPath,
      'freeze',
      '--install', install,
      '--remove', remove,
    ], { cwd: process.cwd(), encoding: 'utf8' });

    const firstGeneration = generate(installPath, removePath);
    expect(firstGeneration.status, firstGeneration.stderr).toBe(0);
    const secondGeneration = generate(secondInstallPath, secondRemovePath);
    expect(secondGeneration.status, secondGeneration.stderr).toBe(0);
    expect(readFileSync(secondInstallPath, 'utf8')).toBe(readFileSync(installPath, 'utf8'));
    expect(readFileSync(secondRemovePath, 'utf8')).toBe(readFileSync(removePath, 'utf8'));

    const database = new DatabaseSync(':memory:');
    try {
      database.exec(`
        CREATE TABLE events (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          event_date TEXT NOT NULL,
          event_timezone TEXT NOT NULL,
          rsvp_deadline_at TEXT,
          event_start_at TEXT NOT NULL,
          photos_open_from TEXT,
          uploads_enabled INTEGER NOT NULL,
          deleted_at TEXT
        );
        INSERT INTO events VALUES (
          'chicago-event', 'Original', '2026-09-19', 'America/Chicago',
          '2026-09-18T23:59:59.999Z', '2026-09-19T05:00:00.000Z',
          '2026-08-02T12:00:00.000Z', 1, NULL
        );
      `);
      const plan = buildBackfillArtifacts([chicagoRow()]).plan;
      const inventory = () => database.prepare(`
        SELECT id, event_date, event_timezone, rsvp_deadline_at,
          event_start_at, photos_open_from, uploads_enabled, 1 AS entry_enabled, deleted_at
        FROM events ORDER BY id
      `).all() as unknown as InventoryRow[];

      expect(verifyBackfillPlan(plan, inventory(), {
        requirePredeployCompleteness: true,
      })).toEqual({ ok: true, verifiedCount: 1, issues: [] });

      database.exec(readFileSync(installPath, 'utf8'));
      expect(database.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'trigger' AND name = 'candidary_event_start_schedule_freeze'
      `).get()).toEqual({ name: 'candidary_event_start_schedule_freeze' });

      expect(() => database.exec(`
        UPDATE events SET
          name = 'Renamed',
          event_timezone = 'America/Chicago',
          rsvp_deadline_at = '2026-09-18T23:59:59.999Z'
        WHERE id = 'chicago-event';
      `)).not.toThrow();
      expect(() => database.exec(`
        UPDATE events SET event_date = '2026-09-20' WHERE id = 'chicago-event';
      `)).toThrow(/CANDIDARY_EVENT_START_RELEASE_SCHEDULE_FROZEN/u);
      expect(() => database.exec(`
        UPDATE events SET event_timezone = 'America/Denver' WHERE id = 'chicago-event';
      `)).toThrow(/CANDIDARY_EVENT_START_RELEASE_SCHEDULE_FROZEN/u);
      expect(() => database.exec(`
        UPDATE events SET rsvp_deadline_at = NULL WHERE id = 'chicago-event';
      `)).toThrow(/CANDIDARY_EVENT_START_RELEASE_SCHEDULE_FROZEN/u);
      expect(() => database.exec(`
        UPDATE events SET uploads_enabled = 0 WHERE id = 'chicago-event';
      `)).not.toThrow();
      expect(verifyBackfillPlan(plan, inventory()).issues).toContainEqual({
        id: 'chicago-event',
        kind: 'capability-mismatch',
        field: 'uploads_enabled',
        expected: 1,
        actual: 0,
      });
      database.exec("UPDATE events SET uploads_enabled = 1 WHERE id = 'chicago-event';");

      expect(() => database.exec(`
        INSERT INTO events VALUES (
          'deploy-gap-event', 'Gap', '2026-10-03', 'America/Chicago', NULL,
          '1970-01-01T00:00:00.000Z', NULL, 1, NULL
        );
      `)).not.toThrow();
      expect(verifyBackfillPlan(plan, inventory(), {
        requirePredeployCompleteness: true,
      })).toEqual({ ok: true, verifiedCount: 1, issues: [] });

      // This is the required post-deploy original-plan recheck, still under
      // the freeze. The attempted stale old-Worker edits could not invalidate it.
      expect(verifyBackfillPlan(plan, inventory())).toEqual({
        ok: true,
        verifiedCount: 1,
        issues: [],
      });

      database.exec(readFileSync(removePath, 'utf8'));
      expect(database.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'trigger' AND name = 'candidary_event_start_schedule_freeze'
      `).get()).toBeUndefined();
      expect(() => database.exec(`
        UPDATE events SET event_timezone = 'America/Denver' WHERE id = 'chicago-event';
      `)).not.toThrow();
      expect(verifyBackfillPlan(plan, inventory()).issues).toContainEqual({
        id: 'chicago-event',
        kind: 'source-mismatch',
        field: 'event_timezone',
        expected: 'America/Chicago',
        actual: 'America/Denver',
      });
    } finally {
      database.close();
    }
  });

  it('verifies the exact trigger definition when installed and absence after cleanup', () => {
    const directory = temporaryDirectory();
    const installPath = join(directory, 'install-freeze.sql');
    const removePath = join(directory, 'remove-freeze.sql');
    const statePath = join(directory, 'freeze-state.json');
    const scriptPath = resolve('scripts/event-start-backfill.ts');
    const generation = spawnSync(process.execPath, [
      '--experimental-strip-types', scriptPath, 'freeze',
      '--install', installPath, '--remove', removePath,
    ], { cwd: process.cwd(), encoding: 'utf8' });
    expect(generation.status, generation.stderr).toBe(0);

    const database = new DatabaseSync(':memory:');
    try {
      database.exec(`
        CREATE TABLE events (
          id TEXT PRIMARY KEY,
          event_date TEXT NOT NULL,
          event_timezone TEXT NOT NULL,
          rsvp_deadline_at TEXT
        );
      `);
      database.exec(readFileSync(installPath, 'utf8'));
      const writeState = () => writeFileSync(statePath, JSON.stringify([{
        results: database.prepare(`
          SELECT name, sql FROM sqlite_master
          WHERE type = 'trigger' AND name = 'candidary_event_start_schedule_freeze'
        `).all(),
        success: true,
        meta: {},
      }]));
      const verifyState = (expected: 'installed' | 'absent') => spawnSync(process.execPath, [
        '--experimental-strip-types', scriptPath, 'verify-freeze',
        '--input', statePath, '--expect', expected,
      ], { cwd: process.cwd(), encoding: 'utf8' });

      writeState();
      const installed = verifyState('installed');
      expect(installed.status, installed.stderr).toBe(0);
      const prematureAbsence = verifyState('absent');
      expect(prematureAbsence.status).toBe(1);

      writeFileSync(statePath, JSON.stringify([{
        results: [{
          name: 'candidary_event_start_schedule_freeze',
          sql: 'CREATE TRIGGER candidary_event_start_schedule_freeze AFTER UPDATE ON events BEGIN SELECT 1; END',
        }],
        success: true,
        meta: {},
      }]));
      const wrongDefinition = verifyState('installed');
      expect(wrongDefinition.status).toBe(1);
      expect(wrongDefinition.stderr).toContain('definition does not match');

      database.exec(readFileSync(removePath, 'utf8'));
      writeState();
      const absent = verifyState('absent');
      expect(absent.status, absent.stderr).toBe(0);
      const missingInstall = verifyState('installed');
      expect(missingInstall.status).toBe(1);
    } finally {
      database.close();
    }
  });
});

describe('event-start backfill CLI', () => {
  it('writes dry-run artifacts and verifies a post-migration inventory without Wrangler', () => {
    const directory = temporaryDirectory();
    const inventoryPath = join(directory, 'inventory.json');
    const planPath = join(directory, 'plan.json');
    const sqlPath = join(directory, 'backfill.sql');
    const postDeploySqlPath = join(directory, 'post-deploy.sql');
    const postInventoryPath = join(directory, 'post-inventory.json');
    const scriptPath = resolve('scripts/event-start-backfill.ts');
    const rows = [chicagoRow()];

    writeFileSync(inventoryPath, JSON.stringify([{ results: rows, success: true, meta: {} }]));
    const planResult = spawnSync(process.execPath, [
      '--experimental-strip-types',
      scriptPath,
      'plan',
      '--input', inventoryPath,
      '--plan', planPath,
      '--sql', sqlPath,
      '--post-deploy-sql', postDeploySqlPath,
    ], { cwd: process.cwd(), encoding: 'utf8' });

    expect(planResult.status, planResult.stderr).toBe(0);
    expect(JSON.parse(readFileSync(planPath, 'utf8'))).toEqual(buildBackfillArtifacts(rows).plan);
    expect(readFileSync(sqlPath, 'utf8')).toContain('UPDATE events SET event_start_at');
    expect(readFileSync(postDeploySqlPath, 'utf8')).toContain('post-deploy photo-capability');
    expect(planResult.stdout).toContain('Planned 1 event start');

    writeFileSync(postInventoryPath, JSON.stringify([postChicagoRow()]));
    const verifyResult = spawnSync(process.execPath, [
      '--experimental-strip-types',
      scriptPath,
      'verify',
      '--plan', planPath,
      '--input', postInventoryPath,
    ], { cwd: process.cwd(), encoding: 'utf8' });

    expect(verifyResult.status, verifyResult.stderr).toBe(0);
    expect(verifyResult.stdout).toContain('Verified 1 planned event start exactly');

    writeFileSync(postInventoryPath, JSON.stringify([
      postChicagoRow(),
      postChicagoRow({
        id: 'before-migration',
        event_start_at: '2026-09-19T00:00:00.000Z',
      }),
      postChicagoRow({
        id: 'after-migration',
        event_start_at: '1970-01-01T00:00:00.000Z',
      }),
    ]));
    const predeployGateResult = spawnSync(process.execPath, [
      '--experimental-strip-types',
      scriptPath,
      'verify',
      '--plan', planPath,
      '--input', postInventoryPath,
      '--require-predeploy-completeness',
    ], { cwd: process.cwd(), encoding: 'utf8' });

    expect(predeployGateResult.status).toBe(1);
    expect(predeployGateResult.stderr).toContain('before-migration');
    expect(predeployGateResult.stderr).not.toContain('after-migration');

    writeFileSync(postInventoryPath, JSON.stringify([
      postChicagoRow(),
      postChicagoRow({ id: 'deploy-gap-event', event_start_at: '1970-01-01T00:00:00.000Z' }),
    ]));
    const finalGateResult = spawnSync(process.execPath, [
      '--experimental-strip-types',
      scriptPath,
      'verify',
      '--plan', planPath,
      '--input', postInventoryPath,
      '--require-no-sentinel',
    ], { cwd: process.cwd(), encoding: 'utf8' });

    expect(finalGateResult.status).toBe(1);
    expect(finalGateResult.stderr).toContain('deploy-gap-event');
    expect(finalGateResult.stderr).toContain('epoch deploy-gap sentinel');
  });
});

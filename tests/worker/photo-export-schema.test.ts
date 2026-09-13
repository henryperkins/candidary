/// <reference types="vite/client" />

import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrationOnly, migrationsUpTo, orderedMigrations } from './helpers';
import { FROZEN_0019_CLAIM_RUNNING_SQL, FROZEN_0019_MARK_FAILED_SQL } from './fixtures/export-worker-0019';
import { ExportsRepository } from '../../worker/db/exports';
import verifierSource from '../../scripts/verify-fresh-d1.ts?raw';

const now = '2026-09-12T12:00:00.000Z';
const later = '2026-09-12T13:00:00.000Z';
const uuid = '123e4567-e89b-42d3-a456-426614174000';
const db = env.DB;
async function event(id = 'event') {
  await db.prepare(`INSERT INTO events (id, slug, name, event_date, welcome_message,
    guest_access_expires_at, management_access_expires_at, purge_after, created_at)
    VALUES (?, ?, 'Event', '2026-09-19', 'Welcome', ?, ?, ?, ?)`).bind(id, id, later, later, later, now).run();
}
async function legacy(id: string, kind: 'complete' | 'album', state = 'failed') {
  await db.prepare(`INSERT INTO export_jobs (id, event_id, kind, album_entries_json, state,
    snapshot_at, media_count, total_bytes, created_at, guestbook_entry_count)
    VALUES (?, 'event', ?, ?, ?, ?, 1, 12, ?, ?)`).bind(id, kind, kind === 'album' ? '[]' : null, state, now, now, kind === 'complete' ? 1 : null).run();
}
async function entry(id: string) {
  await db.prepare(`INSERT INTO export_media_entries (export_job_id, media_id, object_key,
    object_bucket_generation, original_filename, mime_type, declared_byte_size, byte_size,
    guest_name, publication_status, created_at, album_tail_position)
    VALUES (?, ?, 'original', 'canonical', 'photo.jpg', 'image/jpeg', 12, 12, 'Guest', 'unpublished', ?, 1)`).bind(id, uuid, now).run();
}
async function tombstone() {
  await db.prepare(`INSERT INTO media_object_write_tombstones (bucket_generation, object_key,
    event_id, media_id, object_kind, created_at, next_check_at, updated_at) VALUES ('canonical', 'original', 'event', ?, 'final', ?, ?, ?)`).bind(uuid, now, now, now).run();
}
async function open() {
  await db.prepare(`UPDATE export_protocol_admission SET state='closed', closed_at=?`).bind(now).run();
  await db.prepare(`UPDATE export_protocol_admission SET state='open', worker_version_id=?, admitted_at=?`).bind(uuid, now).run();
  await db.prepare(`UPDATE photo_export_admission SET enabled=1, worker_version_id=?, admitted_at=?`).bind(uuid, now).run();
}
function selection(id = 'selection', destination = 'device') {
  return db.prepare(`INSERT INTO export_jobs (id, event_id, kind, destination, state, snapshot_at,
    media_count, total_bytes, created_at, execution_protocol, source_json, request_digest,
    idempotency_key, initiating_principal, hold_expires_at, absolute_expires_at)
    VALUES (?, 'event', 'selection', ?, 'queued', ?, 1, 12, ?, 'selection-v1', ?, ?, ?, 'host:owner', ?, ?)`)
    .bind(id, destination, now, now, JSON.stringify({ version: 1, source: { mode: 'ids', scope: 'library', mediaIds: [uuid] } }), 'a'.repeat(64), id, later, later).run();
}
async function claim(id = 'selection') {
  await db.prepare(`UPDATE export_jobs SET state='running', confirmed_at=?, execution_transition=1,
    execution_started_at=?, processed_media_count=0, processed_bytes=0, progress_updated_at=? WHERE id=?`).bind(now, now, now, id).run();
}
beforeEach(async () => { await reset(); });

describe('photo export forward schema', () => {
  it('captures the actual migrated D1 schema for independent verifier fixtures', async () => {
    await applyD1Migrations(db, orderedMigrations);
    const schema = (await db.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND (name LIKE 'photo_export_%' OR name LIKE 'export_%') ORDER BY name").all()).results;
    const columns = (await db.prepare("SELECT * FROM pragma_table_info('export_jobs')").all()).results;
    const admission = (await db.prepare('SELECT * FROM photo_export_admission').all()).results;
    expect(columns).toHaveLength(45);
    expect(admission).toEqual([{ singleton: 1, enabled: 0, worker_version_id: null, admitted_at: null }]);
    expect(schema.filter(row => row.type === 'table').map(row => row.name)).toContain('photo_export_deliveries');
    expect(schema.find(row => row.name === 'photo_export_deliveries')?.sql).toContain('REFERENCES export_media_entries(export_job_id, media_id)');
    // Execute the verifier's actual read-only query on D1, including unrelated
    // invariants; never synthesize successful CHECK rows from verifier pins.
    const arrayNames = (name: string) => [...verifierSource.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\] as const;`, 'u'))![1]!.matchAll(/'([^']+)'/gu)].map(match => match[1]!);
    const guestbook = arrayNames('GUESTBOOK_SCHEMA_TABLES');
    const list = (names: string[]) => names.map(name => `'${name}'`).join(',');
    const substitutions: Record<string, string> = {
      COVER_TABLES: verifierSource.match(/const COVER_TABLES = String.raw`([^`]+)`/u)![1]!,
      GUESTBOOK_SCHEMA_TABLE_LIST: list(guestbook),
      GUESTBOOK_COLUMN_TABLE_LIST: list([...guestbook, 'export_jobs', 'media']),
      GUESTBOOK_INDEX_TABLE_LIST: list([...guestbook, 'export_jobs', 'guest_messages']),
      GUESTBOOK_CHECK_TABLE_LIST: list([...guestbook, 'events', 'export_jobs', 'media']),
      ALBUM_SCHEMA_TABLE_LIST: list(arrayNames('ALBUM_SCHEMA_TABLES')),
    };
    const capturedQuery = verifierSource.match(/export const READ_ONLY_INVARIANT_QUERY = `([\s\S]*?)`;/u)?.[1];
    if (capturedQuery === undefined || capturedQuery.trim().length === 0) {
      throw new Error('The verifier must expose a nonempty READ_ONLY_INVARIANT_QUERY SQL capture.');
    }
    const query = capturedQuery.replace(/\$\{([A-Z_]+)\}/gu, (_, name: string) => substitutions[name]!);
    expect(query).toBeDefined();
    const results = await db.batch<Record<string, unknown>>(query.split(';').filter(sql => sql.trim()).map(sql => db.prepare(sql)));
    expect(results).toHaveLength(31);
    for (const result of results) {
      for (const row of result.results) {
        if (typeof row.checks === 'string' && row.checks.length) expect(row.checks).toMatch(/^1(?:\|1)*$/u);
      }
    }
    expect(results[30]?.results).toHaveLength(5);
    expect(results[1]?.results).toEqual([]);
    expect(results[15]?.results.filter(row => row.tbl === 'export_jobs').map(row => row.idx)).toEqual([
      'export_jobs_expiry', 'export_jobs_one_active_per_event', 'photo_export_idempotency', 'sqlite_autoindex_export_jobs_1',
    ]);
  });
  it('starts disabled and preserves every legacy inventory with foreign keys enabled', async () => {
    await applyD1Migrations(db, migrationsUpTo('0023'));
    await event();
    for (const kind of ['complete', 'album'] as const) {
      await legacy(kind, kind);
      await entry(kind);
      await db.prepare(`INSERT INTO export_parts VALUES (?, ?, 1, 'zip', 1, 12, ?)`).bind(kind, kind, now).run();
    }
    await db.prepare(`INSERT INTO export_guestbook_entries VALUES ('complete', 'guest_note', 'note', 0,
      'Guest', 'Message', ?, 'approved', 'shared', 1, NULL, NULL)`).bind(now).run();
    const tables = ['export_jobs', 'export_media_entries', 'export_parts', 'export_guestbook_entries'];
    const before = await Promise.all(tables.map(async table => (await db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results));
    await applyD1Migrations(db, [migrationOnly('0023')]);
    for (const [index, table] of tables.entries()) {
      const after = (await db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results;
      if (table === 'export_jobs') {
        expect(after.map(row => Object.fromEntries(Object.keys(before[index]![0]!).map(key => [key, row[key]])))).toEqual(before[index]);
        expect(after.every(row => row.destination === 'archive' && row.source_json === null)).toBe(true);
      } else expect(after).toEqual(before[index]);
    }
    expect(await db.prepare('PRAGMA foreign_keys').first('foreign_keys')).toBe(1);
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    expect((await db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%0023_backup'").all()).results).toEqual([]);
    expect(await db.prepare('SELECT enabled FROM photo_export_admission WHERE singleton=1').first('enabled')).toBe(0);
    await expect(selection()).rejects.toThrow();
    await legacy('old-worker', 'album', 'queued');
    await entry('old-worker');
    await tombstone();
    await db.prepare(FROZEN_0019_CLAIM_RUNNING_SQL).bind(now, 'old-worker').run();
    await db.prepare(FROZEN_0019_MARK_FAILED_SQL).bind('EXPORT_FAILED', 'old-worker').run();
    expect(await db.prepare("SELECT state FROM export_jobs WHERE id='old-worker'").first('state')).toBe('failed');
    await legacy('old-complete', 'complete', 'queued');
    await entry('old-complete');
    await db.prepare(FROZEN_0019_CLAIM_RUNNING_SQL).bind(now, 'old-complete').run();
    await db.prepare(FROZEN_0019_MARK_FAILED_SQL).bind('EXPORT_FAILED', 'old-complete').run();
  });
  it('requires installed identity and both admission gates; cloud admission stays closed', async () => {
    await applyD1Migrations(db, orderedMigrations); await event();
    await expect(db.prepare('UPDATE photo_export_admission SET enabled=1').run()).rejects.toThrow();
    await expect(db.prepare('DELETE FROM photo_export_admission').run()).rejects.toThrow();
    await expect(selection()).rejects.toThrow();
    await open();
    await expect(selection('cloud', 'google-photos')).rejects.toThrow();
    await selection();
    await expect(selection('another')).rejects.toThrow();
    expect(await new ExportsRepository(db).listLatestForManager('event')).toEqual([]);
    expect(await new ExportsRepository(db).getById('selection')).toMatchObject({
      kind: 'selection', destination: 'device', initiatingPrincipal: 'host:owner',
      sourceJson: JSON.stringify({ version: 1, source: { mode: 'ids', scope: 'library', mediaIds: [uuid] } }),
    });
  });
  it('admits the current photo Worker after upgrading an already-open historical protocol gate', async () => {
    const photoWorker = '123e4567-e89b-42d3-a456-426614174001';
    await applyD1Migrations(db, migrationsUpTo('0023'));
    await event();
    await db.prepare(`UPDATE export_protocol_admission SET state='closed', closed_at=?`).bind(now).run();
    await db.prepare(`UPDATE export_protocol_admission SET state='open', worker_version_id=?, admitted_at=?`).bind(uuid, now).run();
    const historicalGate = await db.prepare('SELECT * FROM export_protocol_admission').first();
    await applyD1Migrations(db, [migrationOnly('0023')]);
    await db.prepare(`UPDATE photo_export_admission SET enabled=1, worker_version_id=?, admitted_at=?`).bind(photoWorker, later).run();
    expect(await db.prepare('SELECT * FROM photo_export_admission').first()).toEqual({
      singleton: 1, enabled: 1, worker_version_id: photoWorker, admitted_at: later,
    });
    expect(await db.prepare('SELECT * FROM export_protocol_admission').first()).toEqual(historicalGate);
    await expect(db.prepare(`UPDATE export_protocol_admission SET worker_version_id=?`).bind(photoWorker).run()).rejects.toThrow();
    await selection();
  });
  it('requires intact inventory and freezes identity against old or unfenced callbacks', async () => {
    await applyD1Migrations(db, orderedMigrations); await event(); await open(); await selection();
    await expect(claim()).rejects.toThrow();
    await entry('selection'); await tombstone(); await claim();
    for (const update of ["execution_protocol='legacy'", "execution_protocol='attempt-v2'", 'media_count=2',
      'total_bytes=13', "source_json='{}'", "initiating_principal='host:other'", "destination='archive'",
      "state='ready', execution_transition=2", "state='delivered', execution_transition=2", "state='handed-off', execution_transition=2"]) {
      await expect(db.prepare(`UPDATE export_jobs SET ${update} WHERE id='selection'`).run()).rejects.toThrow();
    }
    await expect(db.prepare(FROZEN_0019_MARK_FAILED_SQL).bind('EXPORT_FAILED', 'selection').run()).rejects.toThrow();
    await expect(db.prepare(`UPDATE media_object_write_tombstones SET suppression_started_at=? WHERE object_key='original'`).bind(now).run()).rejects.toThrow();
    await expect(db.prepare(`INSERT INTO export_guestbook_entries VALUES ('selection', 'guest_note', 'note', 0, NULL, 'Message', ?, 'approved', 'shared', 1, NULL, NULL)`).bind(now).run()).rejects.toThrow();
  });
  it('keeps cancelled source holds until reads drain and prevents new leases', async () => {
    await applyD1Migrations(db, orderedMigrations); await event(); await open(); await selection(); await entry('selection'); await tombstone(); await claim();
    await db.prepare(`INSERT INTO photo_export_deliveries (export_job_id, media_id, state, attempt)
      VALUES ('selection', ?, 'pending', 1)`).bind(uuid).run();
    await db.prepare(`UPDATE photo_export_deliveries SET read_lease_token='lease', read_lease_expires_at=?`).bind('2099-01-01T00:00:00.000Z').run();
    await expect(db.prepare(`DELETE FROM photo_export_deliveries`).run()).rejects.toThrow();
    await expect(db.prepare(`UPDATE photo_export_deliveries SET read_lease_token='replaced'`).run()).rejects.toThrow();
    await db.prepare(`UPDATE export_jobs SET cancel_requested_at=? WHERE id='selection'`).bind(now).run();
    await expect(db.prepare(`UPDATE photo_export_deliveries SET read_lease_token='new-lease'`).run()).rejects.toThrow();
    await expect(db.prepare(`UPDATE export_jobs SET state='cancelled', execution_transition=2 WHERE id='selection'`).run()).rejects.toThrow();
    await db.prepare(`UPDATE photo_export_deliveries SET read_lease_token=NULL, read_lease_expires_at=NULL`).run();
    await db.prepare(`UPDATE photo_export_admission SET enabled=0, worker_version_id=NULL, admitted_at=NULL`).run();
    await db.prepare(`UPDATE export_jobs SET state='cancelled', execution_transition=2 WHERE id='selection'`).run();
    await expect(db.prepare(`UPDATE export_jobs SET state='queued', attempt=2, execution_transition=3,
      confirmed_at=NULL, cancel_requested_at=NULL, execution_started_at=NULL, processed_media_count=NULL,
      processed_bytes=NULL, progress_updated_at=NULL WHERE id='selection'`).run()).rejects.toThrow(/selection execution transition is invalid/iu);
    await db.prepare(`UPDATE media_object_write_tombstones SET suppression_started_at=? WHERE object_key='original'`).bind(now).run();
    expect(await db.prepare("SELECT state FROM export_jobs WHERE id='selection'").first('state')).toBe('cancelled');
  });
  it('permits only complete destination progress and monotone same-attempt milestones', async () => {
    await applyD1Migrations(db, orderedMigrations); await event(); await open(); await selection(); await entry('selection'); await tombstone(); await claim();
    await db.prepare(`INSERT INTO photo_export_deliveries (export_job_id, media_id, state, attempt, prepared_at, acknowledged_at)
      VALUES ('selection', ?, 'acknowledged', 1, ?, ?)`).bind(uuid, now, now).run();
    await db.prepare(`UPDATE export_jobs SET processed_media_count=1, processed_bytes=12 WHERE id='selection'`).run();
    await expect(db.prepare(`UPDATE export_jobs SET processed_media_count=0, processed_bytes=0 WHERE id='selection'`).run()).rejects.toThrow();
    await db.prepare(`UPDATE export_jobs SET state='handed-off', execution_transition=2, completed_at=? WHERE id='selection'`).bind(now).run();
    expect(await db.prepare("SELECT state FROM export_jobs WHERE id='selection'").first('state')).toBe('handed-off');
  });
  it('rejects an all-NULL running milestone and the subsequent same-attempt reset', async () => {
    await applyD1Migrations(db, orderedMigrations); await event(); await open(); await selection(); await entry('selection'); await tombstone(); await claim();
    await db.prepare(`UPDATE export_jobs SET processed_media_count=1, processed_bytes=12 WHERE id='selection'`).run();
    await expect.soft(db.prepare(`UPDATE export_jobs SET processed_media_count=NULL, processed_bytes=NULL,
      progress_updated_at=NULL WHERE id='selection'`).run()).rejects.toThrow(/selection execution transition is invalid/iu);
    await expect.soft(db.prepare(`UPDATE export_jobs SET processed_media_count=0, processed_bytes=0,
      progress_updated_at=? WHERE id='selection'`).bind(now).run()).rejects.toThrow(/selection execution transition is invalid/iu);
    expect(await db.prepare(`SELECT processed_media_count, processed_bytes, progress_updated_at,
      attempt, execution_transition, execution_started_at FROM export_jobs WHERE id='selection'`).first()).toEqual({
      processed_media_count: 1, processed_bytes: 12, progress_updated_at: now,
      attempt: 1, execution_transition: 1, execution_started_at: now,
    });
  });
  it('fences selection retry source reacquisition and permits photo-only archive completion', async () => {
    await applyD1Migrations(db, orderedMigrations); await event(); await open();
    await selection('retry', 'archive'); await entry('retry'); await tombstone(); await claim('retry');
    await db.prepare(`UPDATE export_jobs SET state='failed', execution_transition=2 WHERE id='retry'`).run();
    // A tombstone proves object retention, but Retry also requires its exact live/recoverable owner.
    await expect(db.prepare(`UPDATE export_jobs SET state='queued', attempt=2, execution_transition=3,
      confirmed_at=NULL, execution_started_at=NULL, processed_media_count=NULL, processed_bytes=NULL, progress_updated_at=NULL
      WHERE id='retry'`).run()).rejects.toThrow(/source hold cannot be reacquired/iu);
    await selection('archive', 'archive'); await entry('archive'); await claim('archive');
    await db.prepare(`UPDATE export_jobs SET state='ready', execution_transition=2,
      processed_media_count=1, processed_bytes=12, completed_at=? WHERE id='archive'`).bind(now).run();
    expect(await db.prepare("SELECT state FROM export_jobs WHERE id='archive'").first('state')).toBe('ready');
  });
  it.each(['failed', 'expired'] as const)('retries a %s archive as unconfirmed with a fresh shorter hold', async state => {
    const retryAt = '2026-09-12T12:05:00.000Z';
    const retryHold = '2026-09-12T12:35:00.000Z';
    await applyD1Migrations(db, orderedMigrations); await event(); await open();
    await db.prepare(`INSERT INTO event_access_tokens (id, event_id, role, secret_digest, secret_ciphertext, expires_at, created_at)
      VALUES ('token', 'event', 'guest', 'digest', 'test-ciphertext', ?, ?)`).bind(later, now).run();
    await db.prepare(`INSERT INTO event_sessions (id, secret_digest, event_id, access_token_id, role,
      csrf_digest, expires_at, created_at) VALUES ('guest', 'digest', 'event', 'token', 'guest', 'csrf', ?, ?)`).bind(later, now).run();
    await db.prepare(`INSERT INTO media (id, event_id, uploader_session_id, object_key, object_bucket_generation,
      original_filename, mime_type, declared_byte_size, byte_size, guest_name, upload_state, publication_status,
      idempotency_key, reservation_expires_at, created_at)
      VALUES (?, 'event', 'guest', 'original', 'canonical', 'photo.jpg', 'image/jpeg', 12, 12, 'Guest', 'stored',
      'unpublished', 'media-key', ?, ?)`).bind(uuid, later, now).run();
    await selection('archive', 'archive'); await entry('archive'); await claim('archive');
    await db.prepare(`UPDATE export_jobs SET processed_media_count=1, processed_bytes=12 WHERE id='archive'`).run();
    await db.prepare(`UPDATE export_jobs SET cancel_requested_at=? WHERE id='archive'`).bind(retryAt).run();
    await db.prepare(`UPDATE export_jobs SET state=?, execution_transition=2 WHERE id='archive'`).bind(state).run();
    const frozen = await db.prepare(`SELECT source_json, initiating_principal, media_count, total_bytes,
      absolute_expires_at FROM export_jobs WHERE id='archive'`).first();
    for (const mutation of ["initiating_principal='other'", "source_json='{}'", 'media_count=2', 'total_bytes=13',
      "absolute_expires_at='2026-09-12T14:00:00.000Z'"]) {
      await expect(db.prepare(`UPDATE export_jobs SET state='queued', attempt=2, execution_transition=3,
        confirmed_at=NULL, cancel_requested_at=NULL, hold_expires_at=?, execution_started_at=NULL,
        processed_media_count=NULL, processed_bytes=NULL, progress_updated_at=NULL, ${mutation}
        WHERE id='archive'`).bind(retryHold).run()).rejects.toThrow();
    }
    await db.prepare(`UPDATE export_jobs SET state='queued', attempt=2, execution_transition=3,
      confirmed_at=NULL, cancel_requested_at=NULL, hold_expires_at=?, execution_started_at=NULL,
      processed_media_count=NULL, processed_bytes=NULL, progress_updated_at=NULL WHERE id='archive'`).bind(retryHold).run();
    expect(await db.prepare(`SELECT state, attempt, execution_transition, confirmed_at, cancel_requested_at,
      hold_expires_at FROM export_jobs WHERE id='archive'`).first()).toEqual({ state: 'queued', attempt: 2,
      execution_transition: 3, confirmed_at: null, cancel_requested_at: null, hold_expires_at: retryHold });
    expect(await db.prepare(`SELECT source_json, initiating_principal, media_count, total_bytes,
      absolute_expires_at FROM export_jobs WHERE id='archive'`).first()).toEqual(frozen);
    await expect(db.prepare(`UPDATE export_jobs SET hold_expires_at=? WHERE id='archive'`).bind(retryAt).run()).rejects.toThrow();
  });
  it('preserves the existing attempt-v2 zero-photo archive execution protocol', async () => {
    await applyD1Migrations(db, orderedMigrations); await event(); await open();
    await db.prepare(`INSERT INTO export_jobs (id, event_id, kind, album_entries_json, state, snapshot_at,
      media_count, total_bytes, created_at, execution_protocol)
      VALUES ('v2', 'event', 'album', '[]', 'queued', ?, 0, 0, ?, 'attempt-v2')`).bind(now, now).run();
    await db.prepare(`UPDATE export_jobs SET state='running', execution_transition=1,
      execution_started_at=?, processed_media_count=0, processed_bytes=0, progress_updated_at=? WHERE id='v2'`).bind(now, now).run();
    await expect(db.prepare(FROZEN_0019_MARK_FAILED_SQL).bind('EXPORT_FAILED', 'v2').run()).rejects.toThrow();
    await db.prepare(`UPDATE export_jobs SET state='ready', execution_transition=2 WHERE id='v2'`).run();
    expect(await db.prepare("SELECT state FROM export_jobs WHERE id='v2'").first('state')).toBe('ready');
  });
});

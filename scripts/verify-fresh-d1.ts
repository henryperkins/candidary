import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  canonicalJson,
  collectMigrationManifest,
  sha256,
  type MigrationVerification,
} from './migration-manifest.ts';

// `String.raw` so the SQL keeps its literal backslashes: `\_` is a literal
// underscore to SQLite's LIKE, and an ordinary escape sequence to JavaScript.
const COVER_TABLES = String.raw`name LIKE 'event\_cover\_%' ESCAPE '\'`;
const GUESTBOOK_SCHEMA_TABLES = [
  'export_guestbook_entries',
  'export_media_entries',
  'guest_message_purge_receipts',
  'guest_message_rate_events',
  'legacy_media_scan_quarantine',
  'legacy_media_scan_state',
  'media_object_promotions',
  'media_object_write_tombstones',
] as const;
const GUESTBOOK_SCHEMA_TABLE_LIST = GUESTBOOK_SCHEMA_TABLES
  .map((name) => `'${name}'`).join(',');
const GUESTBOOK_COLUMN_TABLE_LIST = [...GUESTBOOK_SCHEMA_TABLES, 'export_jobs', 'media']
  .map((name) => `'${name}'`).join(',');
const GUESTBOOK_INDEX_TABLE_LIST = [
  ...GUESTBOOK_SCHEMA_TABLES,
  'export_jobs',
  'guest_messages',
].map((name) => `'${name}'`).join(',');
const GUESTBOOK_CHECK_TABLE_LIST = [
  ...GUESTBOOK_SCHEMA_TABLES,
  'events',
  'export_jobs',
  'media',
].map((name) => `'${name}'`).join(',');
const ALBUM_SCHEMA_TABLES = [
  'event_album_share_sessions',
  'event_album_shares',
  'event_albums',
] as const;
const ALBUM_SCHEMA_TABLE_LIST = ALBUM_SCHEMA_TABLES
  .map((name) => `'${name}'`).join(',');

/**
 * Read-only, and appended to rather than reordered.
 *
 * The six original statements keep their positions because the unit fixture
 * patches `events` rows by ordinal index, and this string is compared
 * byte-for-byte in three places. Every later schema family appends statements
 * at the end so existing result ordinals remain stable.
 *
 * The six cover statements use joined table-valued pragmas rather than one
 * pragma per table. That is not a shortcut: a joined pragma also proves no
 * *unexpected* column, foreign key, or index exists, which twelve separate
 * `pragma_table_info` calls cannot. `PRAGMA foreign_key_check` is deliberately
 * not the RESTRICT proof — it reports only that no violating row exists today
 * and would pass unchanged on a schema that had silently reverted to CASCADE.
 */
export const READ_ONLY_INVARIANT_QUERY = `SELECT id, name FROM d1_migrations ORDER BY id;
PRAGMA foreign_key_check;
PRAGMA quick_check;
SELECT cid, name, type, "notnull", dflt_value, pk
  FROM pragma_table_info('events') ORDER BY cid;
SELECT cid, name, type, "notnull", dflt_value, pk
  FROM pragma_table_info('rsvp_roster_batch_receipts') ORDER BY cid;
SELECT cid, name, type, "notnull", dflt_value, pk
  FROM pragma_table_info('release_certifications') ORDER BY cid;
SELECT name FROM sqlite_master WHERE type = 'table' AND ${COVER_TABLES} ORDER BY name;
SELECT m.name AS tbl, p.name AS col
  FROM sqlite_master m JOIN pragma_table_info(m.name) p
  WHERE m.type = 'table' AND m.${COVER_TABLES} ORDER BY m.name, p.cid;
SELECT m.name AS tbl, f."table" AS parent, f."from" AS col, f.on_delete AS on_delete
  FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f
  WHERE m.type = 'table' AND m.${COVER_TABLES} ORDER BY m.name, f."from";
SELECT m.name AS tbl, i.name AS idx, i."unique" AS uniq, i.partial AS partial
  FROM sqlite_master m JOIN pragma_index_list(m.name) i
  WHERE m.type = 'table' AND m.${COVER_TABLES} ORDER BY m.name, i.name;
SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name IN (
  'event_cover_receipts_one_preparing_per_event',
  'event_cover_render_sets_one_active_per_event'
) ORDER BY name;
SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name;
SELECT name FROM sqlite_master
  WHERE type = 'table' AND name IN (${GUESTBOOK_SCHEMA_TABLE_LIST}) ORDER BY name;
SELECT m.name AS tbl, p.cid, p.name AS col
  FROM sqlite_master m JOIN pragma_table_info(m.name) p
  WHERE m.type = 'table' AND m.name IN (${GUESTBOOK_COLUMN_TABLE_LIST}) ORDER BY m.name, p.cid;
SELECT m.name AS tbl, f."table" AS parent, f."from" AS col, f.on_delete AS on_delete
  FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f
  WHERE m.type = 'table' AND m.name IN (${GUESTBOOK_SCHEMA_TABLE_LIST}) ORDER BY m.name, f."from";
SELECT m.name AS tbl, i.name AS idx, i."unique" AS uniq, i.partial AS partial
  FROM sqlite_master m JOIN pragma_index_list(m.name) i
  WHERE m.type = 'table' AND m.name IN (${GUESTBOOK_INDEX_TABLE_LIST}) ORDER BY m.name, i.name;
SELECT name,
  CASE name
    WHEN 'events' THEN
      (instr(sql, 'length(trim(guestbook_prompt)) BETWEEN 1 AND 160') > 0) || ''
    WHEN 'export_guestbook_entries' THEN
      (instr(sql, 'source IN (''guest_note'', ''photo_caption'')') > 0) || '|' ||
      (instr(sql, 'source_rank IN (0, 1)') > 0) || '|' ||
      (instr(sql, '(source = ''guest_note'' AND source_state IN (''pending'', ''approved'', ''rejected''))') > 0) || '|' ||
      (instr(sql, '(source = ''photo_caption'' AND source_state IN (''unpublished'', ''published'', ''hidden''))') > 0) || '|' ||
      (instr(sql, 'guest_visibility IN (''shared'', ''author_only'')') > 0) || '|' ||
      (instr(sql, 'included_in_keepsake IN (0, 1)') > 0) || '|' ||
      (instr(sql, '(source = ''guest_note'' AND source_rank = 0 AND media_id IS NULL AND original_filename IS NULL)') > 0) || '|' ||
      (instr(sql, '(source = ''photo_caption'' AND source_rank = 1 AND media_id = source_id)') > 0)
    WHEN 'export_jobs' THEN
      (instr(sql, 'guestbook_html_bytes IS NULL OR guestbook_html_bytes >= 0') > 0) || '|' ||
      (instr(sql, 'guestbook_csv_bytes IS NULL OR guestbook_csv_bytes >= 0') > 0) || '|' ||
      (instr(sql, 'guestbook_entry_count IS NULL OR guestbook_entry_count >= 0') > 0) || '|' ||
      (instr(sql, 'guestbook_shared_count >= 0 AND guestbook_shared_count <= guestbook_entry_count') > 0) || '|' ||
      (instr(sql, 'guestbook_prompt IS NULL OR length(trim(guestbook_prompt)) BETWEEN 1 AND 160') > 0) || '|' ||
      (instr(sql, 'guestbook_gallery_visible IS NULL OR guestbook_gallery_visible IN (0, 1)') > 0) || '|' ||
      (instr(sql, 'kind IN (''complete'', ''album'')') > 0) || '|' ||
      (instr(sql, '(kind = ''complete'' AND album_entries_json IS NULL)') > 0) || '|' ||
      (instr(sql, '(kind = ''album'' AND album_entries_json IS NOT NULL') > 0) || '|' ||
      (instr(sql, 'json_valid(album_entries_json)') > 0) || '|' ||
      (instr(sql, 'json_type(album_entries_json) = ''array''') > 0) || '|' ||
      (instr(sql, 'processed_media_count IS NULL OR processed_media_count >= 0') > 0) || '|' ||
      (instr(sql, 'processed_bytes IS NULL OR processed_bytes >= 0') > 0) || '|' ||
      (instr(sql, 'execution_protocol IN (''legacy'', ''attempt-v2'')') > 0) || '|' ||
      (instr(sql, 'execution_transition >= 0') > 0)
    WHEN 'export_media_entries' THEN
      (instr(sql, 'object_bucket_generation IN (''legacy'', ''canonical'')') > 0) || '|' ||
      (instr(sql, 'declared_byte_size >= 0') > 0) || '|' ||
      (instr(sql, 'byte_size IS NULL OR byte_size >= 0') > 0) || '|' ||
      (instr(sql, 'width IS NULL OR width > 0') > 0) || '|' ||
      (instr(sql, 'height IS NULL OR height > 0') > 0) || '|' ||
      (instr(sql, 'publication_status IN (''unpublished'', ''published'', ''hidden'')') > 0) || '|' ||
      (instr(sql, 'album_tail_position IS NULL OR album_tail_position >= 1') > 0)
    WHEN 'guest_message_purge_receipts' THEN
      (instr(sql, 'length(idempotency_key) BETWEEN 1 AND 128') > 0) || ''
    WHEN 'legacy_media_scan_quarantine' THEN
      (instr(sql, 'length(object_key) > 0') > 0) || '|' ||
      (instr(sql, 'observation_count > 0') > 0)
    WHEN 'legacy_media_scan_state' THEN
      (instr(sql, 'singleton = 1') > 0) || '|' ||
      (instr(sql, 'epoch >= 0') > 0) || '|' ||
      (instr(sql, 'epoch_discovered_count >= 0') > 0) || '|' ||
      (instr(sql, 'epoch_error_count >= 0') > 0) || '|' ||
      (instr(sql, 'epoch_max_hourly_growth >= 0') > 0) || '|' ||
      (instr(sql, 'last_observed_inventory_count >= 0') > 0) || '|' ||
      (instr(sql, 'last_completed_discovered_count IS NULL OR last_completed_discovered_count >= 0') > 0) || '|' ||
      (instr(sql, 'last_completed_error_count IS NULL OR last_completed_error_count >= 0') > 0) || '|' ||
      (instr(sql, 'last_completed_max_hourly_growth IS NULL OR last_completed_max_hourly_growth >= 0') > 0)
    WHEN 'media' THEN
      (instr(sql, 'object_bucket_generation IN (''legacy'', ''canonical'')') > 0) || ''
    WHEN 'media_object_promotions' THEN
      (instr(sql, 'source_bucket_generation = ''legacy''') > 0) || '|' ||
      (instr(sql, 'final_bucket_generation = ''canonical''') > 0) || '|' ||
      (instr(sql, 'source_byte_size IS NULL OR source_byte_size > 0') > 0) || '|' ||
      (instr(sql, 'source_sha256 IS NULL OR length(source_sha256) = 64') > 0) || '|' ||
      (instr(sql, 'source_width IS NULL OR source_width > 0') > 0) || '|' ||
      (instr(sql, 'source_height IS NULL OR source_height > 0') > 0) || '|' ||
      (instr(sql, 'state IN (''pending'', ''copying'', ''target_verified'', ''cleanup_pending'')') > 0) || '|' ||
      (instr(sql, 'final_pointer_committed IN (0, 1)') > 0) || '|' ||
      (instr(sql, 'source_absent_since IS NULL OR state = ''cleanup_pending''') > 0) || '|' ||
      (instr(sql, '(state = ''pending''') > 0) || '|' ||
      (instr(sql, 'claim_token IS NULL AND lease_expires_at IS NULL') > 0) || '|' ||
      (instr(sql, 'source_etag IS NULL AND source_mime_type IS NULL') > 0) || '|' ||
      (instr(sql, 'source_byte_size IS NULL AND source_sha256 IS NULL') > 0) || '|' ||
      (instr(sql, 'source_width IS NULL AND source_height IS NULL') > 0) || '|' ||
      (instr(sql, 'final_etag IS NULL AND target_verified_at IS NULL') > 0) || '|' ||
      (instr(sql, 'OR (state = ''copying''') > 0) || '|' ||
      (instr(sql, 'claim_token IS NOT NULL AND lease_expires_at IS NOT NULL') > 0) || '|' ||
      (instr(sql, 'OR (state = ''target_verified''') > 0) || '|' ||
      (instr(sql, 'final_etag IS NOT NULL AND target_verified_at IS NOT NULL') > 0) || '|' ||
      (instr(sql, 'OR (state = ''cleanup_pending''') > 0) || '|' ||
      (instr(sql, 'claim_token IS NOT NULL AND lease_expires_at IS NULL') > 0) || '|' ||
      (instr(sql, '(final_pointer_committed = 1') > 0) || '|' ||
      (instr(sql, '(final_pointer_committed = 0') > 0)
    WHEN 'media_object_write_tombstones' THEN
      (instr(sql, 'bucket_generation IN (''legacy'', ''canonical'')') > 0) || '|' ||
      (instr(sql, 'length(object_key) > 0') > 0) || '|' ||
      (instr(sql, 'object_kind IN (''source'', ''final'', ''preview'', ''export'', ''cover'')') > 0) || '|' ||
      (instr(sql, 'last_observed_present IS NULL OR last_observed_present IN (0, 1)') > 0) || '|' ||
      (instr(sql, 'last_observed_at IS NULL AND last_observed_present IS NULL') > 0) || '|' ||
      (instr(sql, 'last_observed_at IS NOT NULL') > 0) || '|' ||
      (instr(sql, 'suppression_started_at IS NOT NULL') > 0)
    ELSE ''
  END AS checks
FROM sqlite_master
WHERE type = 'table' AND name IN (${GUESTBOOK_CHECK_TABLE_LIST})
ORDER BY name;
SELECT name, sql FROM sqlite_master
  WHERE type = 'table' AND name = 'media_object_promotions';
SELECT name FROM sqlite_master
  WHERE type = 'table' AND name IN (${ALBUM_SCHEMA_TABLE_LIST}) ORDER BY name;
SELECT 'event_album_share_sessions' AS tbl, p.cid, p.name AS col, p.type,
       p."notnull" AS "notnull", p.dflt_value, p.pk
  FROM pragma_table_info('event_album_share_sessions') p
UNION ALL
SELECT 'event_album_shares' AS tbl, p.cid, p.name AS col, p.type,
       p."notnull" AS "notnull", p.dflt_value, p.pk
  FROM pragma_table_info('event_album_shares') p
UNION ALL
SELECT 'event_albums' AS tbl, p.cid, p.name AS col, p.type,
       p."notnull" AS "notnull", p.dflt_value, p.pk
  FROM pragma_table_info('event_albums') p
UNION ALL
SELECT 'export_jobs' AS tbl, p.cid, p.name AS col, p.type,
       p."notnull" AS "notnull", p.dflt_value, p.pk
  FROM pragma_table_info('export_jobs') p
  WHERE p.name IN ('kind', 'album_entries_json')
UNION ALL
SELECT 'export_media_entries' AS tbl, p.cid, p.name AS col, p.type,
       p."notnull" AS "notnull", p.dflt_value, p.pk
  FROM pragma_table_info('export_media_entries') p
  WHERE p.name = 'album_tail_position'
ORDER BY tbl, cid;
SELECT m.name AS tbl, f."table" AS parent, f."from" AS col, f.on_delete AS on_delete
  FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f
  WHERE m.type = 'table' AND m.name IN (${ALBUM_SCHEMA_TABLE_LIST})
  ORDER BY m.name, f."from";
SELECT 'event_album_share_sessions' AS tbl, i.name AS idx, i."unique" AS uniq,
       i.partial AS partial, x.sql AS sql
  FROM pragma_index_list('event_album_share_sessions') i
  LEFT JOIN sqlite_master x ON x.type = 'index' AND x.name = i.name
UNION ALL
SELECT 'event_album_shares' AS tbl, i.name AS idx, i."unique" AS uniq,
       i.partial AS partial, x.sql AS sql
  FROM pragma_index_list('event_album_shares') i
  LEFT JOIN sqlite_master x ON x.type = 'index' AND x.name = i.name
UNION ALL
SELECT 'event_albums' AS tbl, i.name AS idx, i."unique" AS uniq,
       i.partial AS partial, x.sql AS sql
  FROM pragma_index_list('event_albums') i
  LEFT JOIN sqlite_master x ON x.type = 'index' AND x.name = i.name
UNION ALL
SELECT 'export_media_entries' AS tbl, i.name AS idx, i."unique" AS uniq,
       i.partial AS partial, x.sql AS sql
  FROM pragma_index_list('export_media_entries') i
  LEFT JOIN sqlite_master x ON x.type = 'index' AND x.name = i.name
  WHERE i.name = 'export_album_media_position'
ORDER BY tbl, idx;
SELECT name,
  CASE name
    WHEN 'event_albums' THEN
      (instr(sql, 'length(trim(title)) BETWEEN 1 AND 120') > 0) || '|' ||
      (instr(sql, 'length(description) <= 1000') > 0)
    WHEN 'export_jobs' THEN
      (instr(sql, 'kind IN (''complete'', ''album'')') > 0) || '|' ||
      (instr(sql, '(kind = ''complete'' AND album_entries_json IS NULL)') > 0) || '|' ||
      (instr(sql, '(kind = ''album'' AND album_entries_json IS NOT NULL') > 0) || '|' ||
      (instr(sql, 'json_valid(album_entries_json)') > 0) || '|' ||
      (instr(sql, 'json_type(album_entries_json) = ''array''') > 0) || '|' ||
      (instr(sql, 'processed_media_count IS NULL OR processed_media_count >= 0') > 0) || '|' ||
      (instr(sql, 'processed_bytes IS NULL OR processed_bytes >= 0') > 0) || '|' ||
      (instr(sql, 'execution_protocol IN (''legacy'', ''attempt-v2'')') > 0) || '|' ||
      (instr(sql, 'execution_transition >= 0') > 0)
    WHEN 'export_media_entries' THEN
      (instr(sql, 'album_tail_position IS NULL OR album_tail_position >= 1') > 0) || ''
    ELSE ''
  END AS checks
FROM sqlite_master
WHERE type = 'table' AND name IN ('event_albums', 'export_jobs', 'export_media_entries')
ORDER BY name;
SELECT 'events' AS tbl, p.cid, p.name AS col, p.type,
       p."notnull" AS "notnull", p.dflt_value, p.pk
  FROM pragma_table_info('events') p
  WHERE p.name IN ('recoverable_media_count', 'recoverable_bytes')
UNION ALL
SELECT 'media' AS tbl, p.cid, p.name AS col, p.type,
       p."notnull" AS "notnull", p.dflt_value, p.pk
  FROM pragma_table_info('media') p
  WHERE p.name IN ('trashed_at', 'restore_until')
ORDER BY tbl, cid;
SELECT name, sql FROM sqlite_master
  WHERE type = 'index' AND name IN (
    'export_media_entries_source_hold',
    'media_recently_deleted_page',
    'media_recovery_expiry'
  )
ORDER BY name;
SELECT p.cid, p.name, p.type, p."notnull", p.dflt_value, p.pk,
       m.sql AS table_sql
  FROM pragma_table_info('export_jobs') AS p
  CROSS JOIN (
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'export_jobs'
  ) AS m
  WHERE name IN (
    'processed_media_count',
    'processed_bytes',
    'progress_updated_at',
    'execution_protocol',
    'execution_transition',
    'execution_started_at'
  )
ORDER BY cid;
SELECT p.cid, p.name, p.type, p."notnull", p.dflt_value, p.pk,
       m.sql AS table_sql, admission.singleton, admission.state,
       admission.closed_at, admission.worker_version_id, admission.admitted_at
  FROM pragma_table_info('export_protocol_admission') AS p
  CROSS JOIN (
    SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name = 'export_protocol_admission'
  ) AS m
  CROSS JOIN export_protocol_admission AS admission
ORDER BY p.cid;
SELECT 'event_sessions' AS tbl, p.cid, p.name AS col, p.type,
       p."notnull" AS "notnull", p.dflt_value, p.pk, '' AS checks
  FROM pragma_table_info('event_sessions') AS p
  WHERE p.name = 'manager_upload_account_id'
UNION ALL
SELECT 'events' AS tbl, p.cid, p.name AS col, p.type,
       p."notnull" AS "notnull", p.dflt_value, p.pk,
       CASE p.name
         WHEN 'album_pick_generation' THEN
           (instr(m.sql, 'album_pick_generation >= 0') > 0) || ''
         WHEN 'manager_link_revision' THEN
           (instr(m.sql, 'manager_link_revision >= 0') > 0) || ''
         ELSE ''
       END AS checks
  FROM pragma_table_info('events') AS p
  CROSS JOIN sqlite_master AS m
  WHERE m.type = 'table' AND m.name = 'events'
    AND p.name IN ('album_pick_generation', 'manager_link_revision')
UNION ALL
SELECT 'media' AS tbl, p.cid, p.name AS col, p.type,
       p."notnull" AS "notnull", p.dflt_value, p.pk,
       (instr(m.sql, 'album_pick_version IS NULL OR album_pick_version = 1') > 0) || '' AS checks
  FROM pragma_table_info('media') AS p
  CROSS JOIN sqlite_master AS m
  WHERE m.type = 'table' AND m.name = 'media'
    AND p.name = 'album_pick_version'
ORDER BY tbl, cid;
SELECT 'event_sessions' AS tbl, f."table" AS parent,
       f."from" AS col, f."to" AS parent_col, f.on_delete AS on_delete
  FROM pragma_foreign_key_list('event_sessions') AS f
  WHERE f."from" = 'manager_upload_account_id';
SELECT i.name AS name, i."unique" AS uniq, i.partial AS partial, x.sql AS sql
  FROM pragma_index_list('event_access_tokens') AS i
  JOIN sqlite_master AS x ON x.type = 'index' AND x.name = i.name
  WHERE i.name = 'event_access_tokens_one_live_manager'
UNION ALL
SELECT i.name AS name, i."unique" AS uniq, i.partial AS partial, x.sql AS sql
  FROM pragma_index_list('event_sessions') AS i
  JOIN sqlite_master AS x ON x.type = 'index' AND x.name = i.name
  WHERE i.name = 'event_sessions_manager_upload_actor'
ORDER BY name;`;

const INVARIANT_STATEMENT_COUNT = 30;

/**
 * Pinned, not derived.
 *
 * The ledger comparison alone cannot prove a phase-3 migration is absent: it
 * derives its expectation from `collectMigrationManifest(candidateRoot)`, so a
 * file that is not checked in is never seen, and a correctly numbered extra file
 * that *is* checked in would simply be accepted as the next entry.
 *
 * Eighteen after the Album end-to-end landing: `0016_host_private_gallery.sql`
 * establishes the favorite set, `0017_event_album.sql` stores its curated
 * order and share capability, and `0018_album_end_to_end.sql` adds album export
 * snapshots. Nineteen with `0019_media_recovery.sql`, which makes host deletion
 * recoverable and turns an accepted export's frozen entries into a source hold.
 * Twenty with `0020_export_progress.sql`, which adds durable progress and an
 * attempt-owned execution ledger without reinterpreting existing jobs.
 * Twenty-one with `0021_manager_upload_and_album_era.sql`, which adds the
 * account upload actor and database-owned Album-era generation.
 * Twenty-two with `0022_event_cover_preset_asset_v2.sql`, which admits only
 * immutable preset asset versions 1 and 2 without widening other cover guards.
 * Count and terminal schema assertions move together here.
 */
const EXPECTED_MIGRATION_COUNT = 22;

/**
 * Exact normalized sqlite_master trigger SQL, pinned as SHA-256 so the twelve
 * existing invariant bodies, all fifteen 0015 bodies, the twelve 0019 recovery
 * and source-hold bodies, the nine 0020 execution/progress/admission bodies,
 * the eight 0021 actor/Album bodies, and the two 0022 cover bodies cannot drift
 * behind a name-only check.
 *
 * Two of these names are older than their bodies: 0019 replaces
 * `media_object_write_tombstone_guard_update` and `media_stored_legacy_guard_update`
 * to admit one exact recovery exception each, so their digests moved with it.
 * Normalization collapses whitespace and nothing else.
 */
const EXPECTED_TRIGGER_SQL_SHA256: Record<string, string> = {
  event_cover_master_live_reference_delete: 'd5069b47f707cc6628854205e6c2083d272327af23e7d0682d129a58073b1870',
  event_cover_render_object_manifest_delete: '92c9e535278587b8fe8c93226b82e2e7fec555cfe82f2d56e00260b051840764',
  event_cover_render_object_manifest_insert: '11faa6b24659b53d19246edfe146b70ccb3c830330f7f01b35b1eb0cd32806e4',
  event_cover_render_object_manifest_update: 'b4f22ff8987597674bb8d54c1a90d1d92802363529f0b596dd9dddc214cabd04',
  event_cover_render_set_live_reference_delete: '43562a5276ac0183b67e68c0872e5dda3facb5639a4242b40759a3bf599479b0',
  event_cover_render_set_manifest_insert: 'df734d0e6c3695c545043c6dec35fc7752982df931df8bae7d7e740747771cf8',
  event_cover_render_set_manifest_update: '90ce5414d984e4adeeefa901a20d2e169ff0a5f80f943d922bc0e95081ab4815',
  event_cover_source_pointer_insert: '270ca07efe6ff0a16bef909c30eff4bc656629c1a2ae6ef4624ada45bc4b8a5e',
  event_cover_source_pointer_update: 'd8ab96cbd3e926853bd02dbaf34ac77ae356e1ba9d4813b958997faccfa882f7',
  event_hosts_revoke_manager_upload_actor: '20b22dfbccc7c6c0c855f8acaf52432c0fc06a70c97efbcd3fd442bdbe3e3cea',
  event_sessions_manager_upload_actor_insert: 'b53da7fb6734359b954bc62d7c82fb1da46526c51a528eff9f82c1ce3a3f3db3',
  event_sessions_manager_upload_actor_update: '6c6407acf6e08f6e17e87fb2c78ba9d4749d41f491d528d0de101aaf8740f6ee',
  events_media_capacity_guard_insert: '74a027aa4d29f775158cdbc4df807381af20836259ac5b9711e8f1f827469f4a',
  events_media_capacity_guard_update: '2567b5a50e1878ca9089234914d774f2e38d2460c22aeb7c1aa313bb8a48f9fe',
  events_rsvp_deadline_insert: 'b96be8b8983ad7ed6d354e1bb3da6959cca61c89c09d83d796d22649d079b110',
  events_rsvp_deadline_update: '9154c51a32504396624c7d36205c11a573e53847e7a944cc2062e627ada682d5',
  export_jobs_entryless_queued_insert: 'db6c8bfcc96c38495a512099c951055edde34a21804d3034c048ac43b310a965',
  export_jobs_execution_insert: 'bac6ebfd3fc557bd1ba22c9caab7377e42158605edcba7cd699cb4704ef74765',
  export_jobs_execution_update: '8d460c89a2f9f6d9af28d39d200a67ac00a83c03fd43d392754a8bf6f37ada97',
  export_jobs_progress_insert: '19cb1439bf8e779be4ec89209b3156e7534c39d5253dfbcab3c73f886c38dc21',
  export_jobs_progress_update: '699fbe58e3797ec7e161363adc31bd029dae3ebe0133ceb72124c3146dd2d187',
  export_jobs_protocol_admission_insert: 'c3ab52e3135af073784434b39c6515b92a14dafc1a2b7e2bb4133e39f80efdf3',
  export_jobs_protocol_admission_update: '77ad4f4c61686a92a95c9e5239e589dad55e8b42f2e6a92474bb1db9cd79449b',
  export_jobs_retry_source_fence: '21a9d82803679053a9c192e256c6c52166aaf128917179ad092bbe132d55a633',
  export_jobs_running_source_fence: 'aefa6ab749858b23d03dd9b0b4a5864b46d98e41f405762471e9fd678cd8be9d',
  export_media_entry_suppressed_source_insert: 'c14114f4af846a5423c1d44f3e7d0c960f38558750908ba9ccc4d69076a7bdcc',
  export_protocol_admission_no_delete: '270cdaa568501c06d2022499fe0c7826322a02c47b25bf7bd82782a89736c6a3',
  export_protocol_admission_no_insert: 'e643ec41e0dc6c029d67cfcb89c51c544f842a92615573d0a0946f1f24aed7ed',
  export_protocol_admission_transition: '33a3f139239e88541dc149c719896f17517c50b7a26ff93875bed8de7a4a9cc2',
  export_source_hold_tombstone_insert: '98076937572545de2484496c323405c35f676749027d2a402df8bf0fc573211a',
  export_source_hold_tombstone_suppress: '5ab86ae27655c8763e897ad894f91c1516c035c955f306d5e3979ca0d52a3880',
  legacy_media_scan_quarantine_permanent: '0b5ca1981e323706e28954b7197abe32276afcff737edae1484087f1058cb7aa',
  legacy_media_scan_state_permanent: '1665fa34a1ed318164fc0e7e29c2b50aa5550837b4a0249ee173b289ecc2a8b3',
  media_album_pick_generation_delete: '94e89b975815988f619b6fa433cf96c3d5239454e2703932c71a7031f6728c50',
  media_album_pick_generation_update: 'e3b8fc4739bb20b2301ff25011dbd7ac5fffaa37e9da2ed60a1d1a776cef4d11',
  media_album_pick_pair_guard: '3b5f330cba957d70996fab01ec7c5a2a036d187d763b272cbc5c47537398ba99',
  media_album_pick_version_on_legacy_pick: '56a71f0e73e766ef0849252f57602d6bd138560e73550e9b2f92fde17aaf02f9',
  media_album_pick_version_on_legacy_unpick: '6828c1b9287e68d1571dafd500f3793dadb5d322b174d791d78d53b0b8dfd6e4',
  media_object_promotion_inventory_insert: 'ec75363b45f7be245506e400dca3329e06abe7f388334a6c13b01d64d237579e',
  media_object_promotion_inventory_update: '3523593400afa87a2ba6ac0432deee1686d944cfd4b2aa6a35fba2e5cbb69ea6',
  media_object_promotion_reservation_capability_guard: 'f7473c9ffeee90d78349f46bf91bc20e70da52bc7bb49f41f176ba0ce1f3848a',
  media_object_promotion_verified_delete_guard: 'a79214e3498655ddfb022849cea069eea5f2921caab045e7fab2151d10d60246',
  media_object_promotion_verified_proof_immutable: '9f5ca9c55883615e9456ba100488a7ad412f611ed3fad6bac14c8c987936f026',
  media_object_write_tombstone_guard_insert: '04b87d3211dbe8be03775cc8d7d9a41c64729191b01bfbc9846e5fc1c74f1072',
  media_object_write_tombstone_guard_update: '7bf72b57df964e037fc2b71ed0dc2390d802d978484bd5497e6fb891b7a7171d',
  media_object_write_tombstone_immutable: '7d193fa0096335ef5fd436ddfbeface89161b1495adfc3ac2a9207d711570c2d',
  media_object_write_tombstone_inventory_insert: '2abaf6e5fde190f5a4d229494f06c3fcde4fbf4b5e9d8098e5df3e56f056fc7c',
  media_object_write_tombstone_inventory_update: 'a48894d8a612135cd7669ed54fb2b064b88244e2dc0daec29c8d1ec782612187',
  media_object_write_tombstone_permanent: '22bf8b47ebd7e82a8799c230b0c710d77fd1463814bb7c220410a653c226d2db',
  media_recoverable_owner_tombstone_insert: 'c6d054fd31c5209d3bd26df3a496fedf281e6c221fbdeb6271f322944b64acba',
  media_recoverable_owner_tombstone_suppress: '84d241d44248618a48da155121226a077f4101560a0cb8c0deda5dad52c6e7f1',
  media_stamp_stored_at_compat: '921740a4d74caa9802c6d862070ca3fa52f2765a5fc845adcf848c5bb0ee44c4',
  media_stored_legacy_guard_insert: '0ee130fcf9ac0a1d86d7c3ccf0a5de60218e3df16ced25b12882d913fa76939c',
  media_stored_legacy_guard_update: '1894aac1a305d5c42f633d676cccb75bf6aaec48dc433fb34c1b800240fb5c16',
  media_trash_pair_insert: 'c8fa277cd7f21221d9e9b7e0e090957173cf2280c2f6fc2ebf1e61bc0754a2b3',
  media_trash_pair_update: '934c187edbcb7df13af7c4a0b1e9c6249f65ad056dccb080da9fe9ad4f703bd2',
};

const EXPECTED_COVER_TABLES = [
  'event_cover_backfill_jobs',
  'event_cover_backfill_runs',
  'event_cover_draft_previews',
  'event_cover_drafts',
  'event_cover_masters',
  'event_cover_publish_receipts',
  'event_cover_purge_progress',
  'event_cover_rate_events',
  'event_cover_render_objects',
  'event_cover_render_sets',
  'event_cover_retired_legacy_objects',
  'event_cover_workflow_fences',
];

const EXPECTED_COVER_COLUMNS: Record<string, readonly string[]> = {
  event_cover_backfill_jobs: ['id', 'run_id', 'event_id', 'expected_revision', 'legacy_key_fingerprint', 'master_id', 'render_set_id', 'workflow_instance_id', 'dispatch_state', 'dispatch_generation', 'status', 'dependency_versions_json', 'manifest_json', 'manifest_sha256', 'failure_code', 'retryable', 'terminal_at', 'reference_release_at', 'expires_at', 'created_at', 'updated_at'],
  event_cover_backfill_runs: ['id', 'mode', 'cursor', 'inventory_sha256', 'total_count', 'queued_count', 'applied_count', 'skipped_count', 'resolved_count', 'failed_count', 'needs_replacement_count', 'status', 'created_at', 'updated_at', 'verified_at', 'expires_at'],
  event_cover_draft_previews: ['id', 'draft_id', 'event_id', 'effect_id', 'recipe_version', 'state', 'object_key', 'mime_type', 'byte_size', 'width', 'height', 'ladder_rung', 'sha256', 'failure_code', 'retryable', 'created_at', 'updated_at'],
  event_cover_drafts: ['id', 'event_id', 'source', 'state', 'draft_intent_id', 'request_sha256', 'draft_revision', 'raw_object_key', 'declared_filename', 'declared_mime_type', 'declared_byte_size', 'verified_raw_byte_size', 'raw_etag', 'master_id', 'focus_x', 'focus_y', 'composition_model_version', 'inspection_json', 'failure_code', 'created_at', 'updated_at', 'reservation_expires_at', 'expires_at'],
  event_cover_masters: ['id', 'event_id', 'object_key', 'mime_type', 'byte_size', 'width', 'height', 'sha256', 'normalization_version', 'normalization_rung', 'auto_focus_x', 'auto_focus_y', 'composition_model_version', 'created_at', 'cleanup_after'],
  event_cover_publish_receipts: ['event_id', 'operation_id', 'draft_id', 'render_set_id', 'request_sha256', 'action', 'expected_revision', 'status', 'workflow_instance_id', 'dependency_versions_json', 'completed_profiles', 'required_profiles', 'applied_revision', 'result_cover_json', 'failure_code', 'retryable', 'dispatch_state', 'dispatch_generation', 'last_dispatch_at', 'created_at', 'updated_at', 'expires_at'],
  event_cover_purge_progress: ['event_id', 'phase', 'workflow_binding', 'workflow_instance_id', 'fences_resolved', 'platform_mutations', 'created_at', 'updated_at'],
  event_cover_rate_events: ['id', 'event_id', 'action', 'replay_key', 'request_sha256', 'window_start', 'created_at', 'expires_at'],
  event_cover_render_objects: ['id', 'render_set_id', 'event_id', 'profile_id', 'density', 'format', 'object_key', 'content_type', 'byte_size', 'width', 'height', 'quality_rung', 'sha256', 'created_at'],
  event_cover_render_sets: ['id', 'event_id', 'master_id', 'draft_id', 'recipe_json', 'recipe_sha256', 'state', 'required_slots', 'manifest_sha256', 'published_revision', 'created_at', 'ready_at', 'published_at', 'retired_at', 'abandoned_reason', 'abandoned_at', 'cleanup_after'],
  event_cover_retired_legacy_objects: ['id', 'event_id', 'object_key', 'key_fingerprint', 'reason', 'retired_at', 'cleanup_after', 'deleted_at'],
  event_cover_workflow_fences: ['workflow_binding', 'workflow_instance_id', 'event_id', 'dispatch_generation', 'state', 'created_at', 'updated_at', 'expires_at'],
};

/**
 * Twenty foreign keys, every one `RESTRICT`.
 *
 * This is the assertion the whole cover cleanup contract rests on: an inventory
 * row is the only record that an R2 object exists, so a cascade would delete the
 * record while the bytes remained. Note the absence of any row for
 * `event_cover_workflow_fences` — it deliberately has no foreign key at all,
 * because a fence must outlive the event it protected.
 */
const EXPECTED_COVER_FOREIGN_KEYS = [
  'event_cover_backfill_jobs.event_id -> events RESTRICT',
  'event_cover_backfill_jobs.master_id -> event_cover_masters RESTRICT',
  'event_cover_backfill_jobs.render_set_id -> event_cover_render_sets RESTRICT',
  'event_cover_backfill_jobs.run_id -> event_cover_backfill_runs RESTRICT',
  'event_cover_draft_previews.draft_id -> event_cover_drafts RESTRICT',
  'event_cover_draft_previews.event_id -> events RESTRICT',
  'event_cover_drafts.event_id -> events RESTRICT',
  'event_cover_drafts.master_id -> event_cover_masters RESTRICT',
  'event_cover_masters.event_id -> events RESTRICT',
  'event_cover_publish_receipts.draft_id -> event_cover_drafts RESTRICT',
  'event_cover_publish_receipts.event_id -> events RESTRICT',
  'event_cover_publish_receipts.render_set_id -> event_cover_render_sets RESTRICT',
  'event_cover_purge_progress.event_id -> events RESTRICT',
  'event_cover_rate_events.event_id -> events RESTRICT',
  'event_cover_render_objects.event_id -> events RESTRICT',
  'event_cover_render_objects.render_set_id -> event_cover_render_sets RESTRICT',
  'event_cover_render_sets.draft_id -> event_cover_drafts RESTRICT',
  'event_cover_render_sets.event_id -> events RESTRICT',
  'event_cover_render_sets.master_id -> event_cover_masters RESTRICT',
  'event_cover_retired_legacy_objects.event_id -> events RESTRICT',
];

/** Explicit and implicit indexes, rendered as `table.name unique=n partial=n`. */
const EXPECTED_COVER_INDEXES = [
  'event_cover_backfill_jobs.event_cover_backfill_jobs_by_event unique=0 partial=0',
  'event_cover_backfill_jobs.event_cover_backfill_jobs_run_event unique=1 partial=0',
  'event_cover_backfill_jobs.event_cover_backfill_jobs_status unique=0 partial=0',
  'event_cover_backfill_jobs.sqlite_autoindex_event_cover_backfill_jobs_1 unique=1 partial=0',
  'event_cover_backfill_jobs.sqlite_autoindex_event_cover_backfill_jobs_2 unique=1 partial=0',
  'event_cover_backfill_runs.sqlite_autoindex_event_cover_backfill_runs_1 unique=1 partial=0',
  'event_cover_draft_previews.event_cover_draft_previews_by_event unique=0 partial=0',
  'event_cover_draft_previews.event_cover_draft_previews_tuple unique=1 partial=0',
  'event_cover_draft_previews.sqlite_autoindex_event_cover_draft_previews_1 unique=1 partial=0',
  'event_cover_draft_previews.sqlite_autoindex_event_cover_draft_previews_2 unique=1 partial=0',
  'event_cover_drafts.event_cover_drafts_by_event_state unique=0 partial=0',
  'event_cover_drafts.event_cover_drafts_expiry unique=0 partial=0',
  'event_cover_drafts.event_cover_drafts_intent unique=1 partial=0',
  'event_cover_drafts.event_cover_drafts_master unique=0 partial=1',
  'event_cover_drafts.sqlite_autoindex_event_cover_drafts_1 unique=1 partial=0',
  'event_cover_drafts.sqlite_autoindex_event_cover_drafts_2 unique=1 partial=0',
  'event_cover_masters.event_cover_masters_by_event unique=0 partial=0',
  'event_cover_masters.event_cover_masters_cleanup unique=0 partial=1',
  'event_cover_masters.sqlite_autoindex_event_cover_masters_1 unique=1 partial=0',
  'event_cover_masters.sqlite_autoindex_event_cover_masters_2 unique=1 partial=0',
  'event_cover_publish_receipts.event_cover_receipts_by_draft unique=0 partial=1',
  'event_cover_publish_receipts.event_cover_receipts_expiry unique=0 partial=0',
  'event_cover_publish_receipts.event_cover_receipts_one_preparing_per_event unique=1 partial=1',
  'event_cover_publish_receipts.sqlite_autoindex_event_cover_publish_receipts_1 unique=1 partial=0',
  'event_cover_publish_receipts.sqlite_autoindex_event_cover_publish_receipts_2 unique=1 partial=0',
  'event_cover_purge_progress.sqlite_autoindex_event_cover_purge_progress_1 unique=1 partial=0',
  'event_cover_rate_events.event_cover_rate_events_expiry unique=0 partial=0',
  'event_cover_rate_events.event_cover_rate_events_replay unique=1 partial=0',
  'event_cover_rate_events.event_cover_rate_events_window unique=0 partial=0',
  'event_cover_rate_events.sqlite_autoindex_event_cover_rate_events_1 unique=1 partial=0',
  'event_cover_render_objects.event_cover_render_objects_by_event unique=0 partial=0',
  'event_cover_render_objects.event_cover_render_objects_slot unique=1 partial=0',
  'event_cover_render_objects.sqlite_autoindex_event_cover_render_objects_1 unique=1 partial=0',
  'event_cover_render_objects.sqlite_autoindex_event_cover_render_objects_2 unique=1 partial=0',
  'event_cover_render_sets.event_cover_render_sets_by_event_state unique=0 partial=0',
  'event_cover_render_sets.event_cover_render_sets_cleanup unique=0 partial=1',
  'event_cover_render_sets.event_cover_render_sets_one_active_per_event unique=1 partial=1',
  'event_cover_render_sets.sqlite_autoindex_event_cover_render_sets_1 unique=1 partial=0',
  'event_cover_retired_legacy_objects.event_cover_retired_legacy_objects_by_event unique=0 partial=0',
  'event_cover_retired_legacy_objects.event_cover_retired_legacy_objects_cleanup unique=0 partial=1',
  'event_cover_retired_legacy_objects.sqlite_autoindex_event_cover_retired_legacy_objects_1 unique=1 partial=0',
  'event_cover_retired_legacy_objects.sqlite_autoindex_event_cover_retired_legacy_objects_2 unique=1 partial=0',
  'event_cover_workflow_fences.event_cover_workflow_fences_by_event unique=0 partial=0',
  'event_cover_workflow_fences.event_cover_workflow_fences_expiry unique=0 partial=0',
  'event_cover_workflow_fences.sqlite_autoindex_event_cover_workflow_fences_1 unique=1 partial=0',
];

/**
 * `PRAGMA index_list` reports the `unique` and `partial` flags but not the
 * predicate, so a partial unique index whose `WHERE` had drifted would still
 * read as unique-and-partial. These are the exact predicates, compared with
 * whitespace collapsed so reformatting the migration is not a failure but
 * dropping `OR (status = 'failed' AND retryable = 1)` is.
 */
const EXPECTED_PARTIAL_UNIQUE_SQL: Record<string, string> = {
  event_cover_receipts_one_preparing_per_event:
    'CREATE UNIQUE INDEX event_cover_receipts_one_preparing_per_event'
    + ' ON event_cover_publish_receipts (event_id)'
    + " WHERE status IN ('queued', 'rendering', 'finalizing')"
    + " OR (status = 'failed' AND retryable = 1)",
  event_cover_render_sets_one_active_per_event:
    'CREATE UNIQUE INDEX event_cover_render_sets_one_active_per_event'
    + ' ON event_cover_render_sets (event_id)'
    + " WHERE state = 'active'",
};

const EXPECTED_GUESTBOOK_TABLES = [...GUESTBOOK_SCHEMA_TABLES].sort();

const EXPECTED_GUESTBOOK_COLUMNS: Record<string, readonly string[]> = {
  export_guestbook_entries: [
    'export_job_id', 'source', 'source_id', 'source_rank', 'guest_name', 'body', 'created_at',
    'source_state', 'guest_visibility', 'included_in_keepsake', 'media_id', 'original_filename',
  ],
  export_jobs: [
    'id', 'event_id', 'state', 'snapshot_at', 'object_key', 'media_count', 'total_bytes', 'attempt',
    'error_code', 'created_at', 'started_at', 'completed_at', 'expires_at', 'manifest_object_key',
    'part_count', 'guestbook_html_object_key', 'guestbook_html_bytes', 'guestbook_html_sha256',
    'guestbook_csv_object_key', 'guestbook_csv_bytes', 'guestbook_csv_sha256', 'guestbook_entry_count',
    'guestbook_shared_count', 'guestbook_event_name', 'guestbook_event_date', 'guestbook_event_timezone',
    'guestbook_prompt', 'guestbook_gallery_visible',
    // 0018, appended so every earlier ordinal is unmoved.
    'kind', 'album_entries_json',
    // 0020, appended so every earlier ordinal is unmoved.
    'processed_media_count', 'processed_bytes', 'progress_updated_at',
    'execution_protocol', 'execution_transition', 'execution_started_at',
  ],
  export_media_entries: [
    'export_job_id', 'media_id', 'object_key', 'object_bucket_generation', 'original_filename',
    'mime_type', 'declared_byte_size', 'byte_size', 'width', 'height', 'guest_name', 'caption',
    'publication_status', 'created_at', 'published_at',
    // 0018, appended so every earlier ordinal is unmoved.
    'album_tail_position',
  ],
  guest_message_purge_receipts: [
    'event_id', 'guest_session_id', 'idempotency_key', 'request_hmac', 'purged_at',
  ],
  guest_message_rate_events: [
    'id', 'event_id', 'session_scope_digest', 'ip_scope_digest', 'window_started_at', 'created_at',
  ],
  legacy_media_scan_quarantine: [
    'object_key', 'first_observed_at', 'last_observed_at', 'observation_count',
  ],
  legacy_media_scan_state: [
    'singleton', 'cursor', 'epoch', 'epoch_started_at', 'epoch_discovered_count',
    'epoch_error_count', 'epoch_max_hourly_growth', 'last_observed_at',
    'last_observed_inventory_count', 'last_error_at', 'last_completed_at',
    'last_completed_started_at', 'last_completed_discovered_count',
    'last_completed_error_count', 'last_completed_max_hourly_growth', 'updated_at',
  ],
  media: [
    'id', 'event_id', 'uploader_session_id', 'object_key', 'original_filename', 'mime_type',
    'declared_byte_size', 'byte_size', 'width', 'height', 'guest_name', 'caption', 'upload_state',
    'publication_status', 'idempotency_key', 'reservation_expires_at', 'created_at', 'published_at',
    'preview_object_key', 'deleted_at', 'stored_at', 'object_bucket_generation',
    // 0016, appended so every earlier ordinal is unmoved.
    'captured_at', 'timeline_at', 'favorited_at',
    // 0019, appended so every earlier ordinal is unmoved.
    'trashed_at', 'restore_until',
    // 0021, appended so every earlier ordinal is unmoved.
    'album_pick_version',
  ],
  media_object_promotions: [
    'media_id', 'event_id', 'source_bucket_generation', 'source_object_key',
    'final_bucket_generation', 'final_object_key', 'source_etag', 'source_mime_type',
    'source_byte_size', 'source_sha256', 'source_width', 'source_height', 'final_etag',
    'target_verified_at', 'source_writable_until', 'state', 'final_pointer_committed',
    'claim_token', 'lease_expires_at', 'source_absent_since', 'created_at', 'updated_at',
  ],
  media_object_write_tombstones: [
    'bucket_generation', 'object_key', 'event_id', 'media_id', 'object_kind',
    'suppression_started_at', 'last_observed_at', 'last_observed_present', 'next_check_at',
    'created_at', 'updated_at',
  ],
};

const EXPECTED_GUESTBOOK_FOREIGN_KEYS = [
  'export_guestbook_entries.export_job_id -> export_jobs CASCADE',
  'export_media_entries.export_job_id -> export_jobs CASCADE',
  'guest_message_purge_receipts.event_id -> events CASCADE',
  'guest_message_rate_events.event_id -> events CASCADE',
  'media_object_promotions.event_id -> events RESTRICT',
  'media_object_promotions.media_id -> media RESTRICT',
];

const EXPECTED_GUESTBOOK_INDEXES = [
  'export_guestbook_entries.guestbook_export_render_order unique=0 partial=0',
  'export_guestbook_entries.sqlite_autoindex_export_guestbook_entries_1 unique=1 partial=0',
  'export_jobs.export_jobs_expiry unique=0 partial=0',
  'export_jobs.export_jobs_one_active_per_event unique=1 partial=1',
  'export_jobs.sqlite_autoindex_export_jobs_1 unique=1 partial=0',
  'export_media_entries.export_album_media_position unique=1 partial=1',
  'export_media_entries.export_media_entries_order unique=0 partial=0',
  'export_media_entries.export_media_entries_source_hold unique=0 partial=0',
  'export_media_entries.sqlite_autoindex_export_media_entries_1 unique=1 partial=0',
  'guest_message_purge_receipts.sqlite_autoindex_guest_message_purge_receipts_1 unique=1 partial=0',
  'guest_message_rate_events.guestbook_rate_event_ip_window unique=0 partial=0',
  'guest_message_rate_events.guestbook_rate_event_session_window unique=0 partial=0',
  'guest_message_rate_events.sqlite_autoindex_guest_message_rate_events_1 unique=1 partial=0',
  'guest_messages.guest_messages_event_status unique=0 partial=0',
  'guest_messages.guest_messages_session_idempotency unique=1 partial=0',
  'guest_messages.guestbook_notes_event_feed unique=0 partial=0',
  'guest_messages.guestbook_notes_event_owner unique=0 partial=0',
  'guest_messages.sqlite_autoindex_guest_messages_1 unique=1 partial=0',
  'legacy_media_scan_quarantine.sqlite_autoindex_legacy_media_scan_quarantine_1 unique=1 partial=0',
  'media_object_promotions.media_object_promotions_event_state unique=0 partial=0',
  'media_object_promotions.media_object_promotions_schedule unique=0 partial=0',
  'media_object_promotions.sqlite_autoindex_media_object_promotions_1 unique=1 partial=0',
  'media_object_promotions.sqlite_autoindex_media_object_promotions_2 unique=1 partial=0',
  'media_object_write_tombstones.media_object_write_tombstones_event unique=0 partial=0',
  'media_object_write_tombstones.media_object_write_tombstones_schedule unique=0 partial=0',
  'media_object_write_tombstones.sqlite_autoindex_media_object_write_tombstones_1 unique=1 partial=0',
];

const EXPECTED_GUESTBOOK_CHECKS: Record<string, string> = {
  events: '1',
  export_guestbook_entries: '1|1|1|1|1|1|1|1',
  export_jobs: '1|1|1|1|1|1|1|1|1|1|1|1|1|1|1',
  export_media_entries: '1|1|1|1|1|1|1',
  guest_message_purge_receipts: '1',
  guest_message_rate_events: '',
  legacy_media_scan_quarantine: '1|1',
  legacy_media_scan_state: '1|1|1|1|1|1|1|1|1',
  media: '1',
  media_object_promotions: '1|1|1|1|1|1|1|1|1|1|1|1|1|1|1|1|1|1|1|1|1|1|1',
  media_object_write_tombstones: '1|1|1|1|1|1|1',
};

const EXPECTED_ALBUM_TABLES = [...ALBUM_SCHEMA_TABLES];

const EXPECTED_ALBUM_COLUMNS = [
  'event_album_share_sessions.0 id TEXT notnull=0 default=NULL pk=1',
  'event_album_share_sessions.1 share_id TEXT notnull=1 default=NULL pk=0',
  'event_album_share_sessions.2 event_id TEXT notnull=1 default=NULL pk=0',
  'event_album_share_sessions.3 secret_digest TEXT notnull=1 default=NULL pk=0',
  'event_album_share_sessions.4 expires_at TEXT notnull=1 default=NULL pk=0',
  'event_album_share_sessions.5 created_at TEXT notnull=1 default=NULL pk=0',
  'event_album_shares.0 id TEXT notnull=0 default=NULL pk=1',
  'event_album_shares.1 event_id TEXT notnull=1 default=NULL pk=0',
  'event_album_shares.2 secret_digest TEXT notnull=1 default=NULL pk=0',
  'event_album_shares.3 secret_ciphertext TEXT notnull=1 default=NULL pk=0',
  'event_album_shares.4 shared_at TEXT notnull=1 default=NULL pk=0',
  'event_album_shares.5 created_at TEXT notnull=1 default=NULL pk=0',
  'event_albums.0 event_id TEXT notnull=0 default=NULL pk=1',
  "event_albums.1 entries TEXT notnull=1 default='[]' pk=0",
  'event_albums.2 saved_at TEXT notnull=0 default=NULL pk=0',
  'event_albums.3 revision INTEGER notnull=1 default=0 pk=0',
  'event_albums.4 created_at TEXT notnull=1 default=NULL pk=0',
  'event_albums.5 updated_at TEXT notnull=1 default=NULL pk=0',
  "event_albums.6 title TEXT notnull=1 default='Album' pk=0",
  "event_albums.7 description TEXT notnull=1 default='' pk=0",
  'event_albums.8 cover_media_id TEXT notnull=0 default=NULL pk=0',
  "export_jobs.28 kind TEXT notnull=1 default='complete' pk=0",
  'export_jobs.29 album_entries_json TEXT notnull=0 default=NULL pk=0',
  'export_media_entries.15 album_tail_position INTEGER notnull=0 default=NULL pk=0',
];

const EXPECTED_ALBUM_FOREIGN_KEYS = [
  'event_album_share_sessions.event_id -> events CASCADE',
  'event_album_share_sessions.share_id -> event_album_shares CASCADE',
  'event_album_shares.event_id -> events CASCADE',
  'event_albums.event_id -> events CASCADE',
];

const EXPECTED_ALBUM_INDEXES = [
  'event_album_share_sessions.event_album_share_sessions_expiry unique=0 partial=0'
    + ' sql=CREATE INDEX event_album_share_sessions_expiry'
    + ' ON event_album_share_sessions(expires_at, id)',
  'event_album_share_sessions.event_album_share_sessions_share_expiry unique=0 partial=0'
    + ' sql=CREATE INDEX event_album_share_sessions_share_expiry'
    + ' ON event_album_share_sessions(share_id, expires_at, id)',
  'event_album_share_sessions.sqlite_autoindex_event_album_share_sessions_1'
    + ' unique=1 partial=0 sql=NULL',
  'event_album_shares.sqlite_autoindex_event_album_shares_1 unique=1 partial=0 sql=NULL',
  'event_album_shares.sqlite_autoindex_event_album_shares_2 unique=1 partial=0 sql=NULL',
  'event_albums.sqlite_autoindex_event_albums_1 unique=1 partial=0 sql=NULL',
  'export_media_entries.export_album_media_position unique=1 partial=1'
    + ' sql=CREATE UNIQUE INDEX export_album_media_position'
    + ' ON export_media_entries(export_job_id, album_tail_position)'
    + ' WHERE album_tail_position IS NOT NULL',
];

const EXPECTED_ALBUM_CHECKS: Record<string, string> = {
  event_albums: '1|1',
  export_jobs: '1|1|1|1|1|1|1|1|1',
  export_media_entries: '1',
};

const EXPECTED_RECOVERY_COLUMNS = [
  'events.30 recoverable_media_count INTEGER notnull=1 default=0 pk=0',
  'events.31 recoverable_bytes INTEGER notnull=1 default=0 pk=0',
  'media.25 trashed_at TEXT notnull=0 default=NULL pk=0',
  'media.26 restore_until TEXT notnull=0 default=NULL pk=0',
];

const EXPECTED_RECOVERY_INDEX_SQL: Record<string, string> = {
  export_media_entries_source_hold:
    'CREATE INDEX export_media_entries_source_hold'
    + ' ON export_media_entries(media_id, object_bucket_generation, object_key, export_job_id)',
  media_recently_deleted_page:
    'CREATE INDEX media_recently_deleted_page'
    + ' ON media(event_id, trashed_at DESC, id DESC) WHERE trashed_at IS NOT NULL',
  media_recovery_expiry:
    'CREATE INDEX media_recovery_expiry'
    + ' ON media(restore_until, id) WHERE trashed_at IS NOT NULL',
};

const EXPECTED_EXPORT_PROGRESS_COLUMNS = [
  '30 processed_media_count INTEGER notnull=0 default=NULL pk=0',
  '31 processed_bytes INTEGER notnull=0 default=NULL pk=0',
  '32 progress_updated_at TEXT notnull=0 default=NULL pk=0',
  "33 execution_protocol TEXT notnull=1 default='legacy' pk=0",
  '34 execution_transition INTEGER notnull=1 default=0 pk=0',
  '35 execution_started_at TEXT notnull=0 default=NULL pk=0',
];

// Exact normalized sqlite_master SQL after 0001-0020. Column pragmas prove
// types/defaults; this digest additionally refuses weakened or extra CHECK
// expressions that would retain every required substring.
const EXPECTED_EXPORT_JOBS_TABLE_SQL_SHA256 =
  '925d170970a421f21205b5cda86ff15d4da9fb1c63ac2934f041273ce39c2c30';

const EXPECTED_EXPORT_PROTOCOL_ADMISSION_COLUMNS = [
  '0 singleton INTEGER notnull=0 default=NULL pk=1',
  '1 state TEXT notnull=1 default=NULL pk=0',
  '2 closed_at TEXT notnull=0 default=NULL pk=0',
  '3 worker_version_id TEXT notnull=0 default=NULL pk=0',
  '4 admitted_at TEXT notnull=0 default=NULL pk=0',
];

const EXPECTED_EXPORT_PROTOCOL_ADMISSION_SQL_SHA256 =
  '679de6b5cbbccf1ca778796696d6c0aa7256cee74d9f7fdec34f6a81bf2e2882';

const EXPECTED_MANAGER_UPLOAD_ALBUM_ERA_COLUMNS = [
  'event_sessions.10 manager_upload_account_id TEXT notnull=0 default=NULL pk=0 checks=',
  'events.32 album_pick_generation INTEGER notnull=1 default=0 pk=0 checks=1',
  'events.33 manager_link_revision INTEGER notnull=1 default=0 pk=0 checks=1',
  'media.27 album_pick_version INTEGER notnull=0 default=NULL pk=0 checks=1',
];

const EXPECTED_MANAGER_UPLOAD_ALBUM_ERA_FOREIGN_KEYS = [
  'event_sessions.manager_upload_account_id -> host_accounts.id NO ACTION',
];

const EXPECTED_MANAGER_UPLOAD_ALBUM_ERA_INDEX_SQL: Record<string, string> = {
  event_access_tokens_one_live_manager:
    "CREATE UNIQUE INDEX event_access_tokens_one_live_manager"
    + " ON event_access_tokens(event_id) WHERE role = 'manager' AND revoked_at IS NULL",
  event_sessions_manager_upload_actor:
    'CREATE UNIQUE INDEX event_sessions_manager_upload_actor'
    + ' ON event_sessions(event_id, manager_upload_account_id)'
    + ' WHERE manager_upload_account_id IS NOT NULL AND revoked_at IS NULL',
};

const EXPECTED_MEDIA_OBJECT_PROMOTIONS_SQL = `
CREATE TABLE media_object_promotions (
  media_id TEXT PRIMARY KEY REFERENCES media(id) ON DELETE RESTRICT,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  source_bucket_generation TEXT NOT NULL DEFAULT 'legacy'
    CHECK (source_bucket_generation = 'legacy'),
  source_object_key TEXT NOT NULL,
  final_bucket_generation TEXT NOT NULL DEFAULT 'canonical'
    CHECK (final_bucket_generation = 'canonical'),
  final_object_key TEXT NOT NULL UNIQUE,
  source_etag TEXT,
  source_mime_type TEXT,
  source_byte_size INTEGER CHECK (source_byte_size IS NULL OR source_byte_size > 0),
  source_sha256 TEXT CHECK (source_sha256 IS NULL OR length(source_sha256) = 64),
  source_width INTEGER CHECK (source_width IS NULL OR source_width > 0),
  source_height INTEGER CHECK (source_height IS NULL OR source_height > 0),
  final_etag TEXT,
  target_verified_at TEXT,
  source_writable_until TEXT NOT NULL,
  state TEXT NOT NULL
    CHECK (state IN ('pending', 'copying', 'target_verified', 'cleanup_pending')),
  final_pointer_committed INTEGER NOT NULL DEFAULT 0
    CHECK (final_pointer_committed IN (0, 1)),
  claim_token TEXT,
  lease_expires_at TEXT,
  source_absent_since TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (source_absent_since IS NULL OR state = 'cleanup_pending'),
  CHECK (
    (state = 'pending'
      AND final_pointer_committed = 0
      AND claim_token IS NULL AND lease_expires_at IS NULL
      AND source_absent_since IS NULL
      AND source_etag IS NULL AND source_mime_type IS NULL
      AND source_byte_size IS NULL AND source_sha256 IS NULL
      AND source_width IS NULL AND source_height IS NULL
      AND final_etag IS NULL AND target_verified_at IS NULL)
    OR (state = 'copying'
      AND final_pointer_committed = 0
      AND claim_token IS NOT NULL AND lease_expires_at IS NOT NULL
      AND source_absent_since IS NULL
      AND final_etag IS NULL AND target_verified_at IS NULL
      AND (
        (source_etag IS NULL AND source_mime_type IS NULL
          AND source_byte_size IS NULL AND source_sha256 IS NULL
          AND source_width IS NULL AND source_height IS NULL)
        OR (source_etag IS NOT NULL AND source_mime_type IS NOT NULL
          AND source_byte_size IS NOT NULL AND source_sha256 IS NOT NULL
          AND source_width IS NOT NULL AND source_height IS NOT NULL)
      ))
    OR (state = 'target_verified'
      AND final_pointer_committed = 0
      AND claim_token IS NOT NULL AND lease_expires_at IS NULL
      AND source_absent_since IS NULL
      AND source_etag IS NOT NULL AND source_mime_type IS NOT NULL
      AND source_byte_size IS NOT NULL AND source_sha256 IS NOT NULL
      AND source_width IS NOT NULL AND source_height IS NOT NULL
      AND final_etag IS NOT NULL AND target_verified_at IS NOT NULL)
    OR (state = 'cleanup_pending'
      AND claim_token IS NOT NULL AND lease_expires_at IS NULL
      AND (
        (final_pointer_committed = 1
          AND source_etag IS NOT NULL AND source_mime_type IS NOT NULL
          AND source_byte_size IS NOT NULL AND source_sha256 IS NOT NULL
          AND source_width IS NOT NULL AND source_height IS NOT NULL
          AND final_etag IS NOT NULL AND target_verified_at IS NOT NULL)
        OR (final_pointer_committed = 0
          AND (
            (source_etag IS NULL AND source_mime_type IS NULL
              AND source_byte_size IS NULL AND source_sha256 IS NULL
              AND source_width IS NULL AND source_height IS NULL
              AND final_etag IS NULL AND target_verified_at IS NULL)
            OR (source_etag IS NOT NULL AND source_mime_type IS NOT NULL
              AND source_byte_size IS NOT NULL AND source_sha256 IS NOT NULL
              AND source_width IS NOT NULL AND source_height IS NOT NULL
              AND final_etag IS NOT NULL AND target_verified_at IS NOT NULL)
          ))
      ))
  )
)
`.replace(/\s+/gu, ' ').trim();

const EXPECTED_COLUMN_NAMES = {
  events: [
    'id', 'slug', 'name', 'event_date', 'welcome_message', 'cover_object_key',
    'uploads_enabled', 'gallery_visible', 'moderation_required',
    'reserved_media_count', 'stored_media_count', 'reserved_bytes', 'stored_bytes',
    'guest_access_expires_at', 'management_access_expires_at', 'purge_after',
    'created_at', 'deleted_at', 'legacy_owner_claim_open', 'theme_config',
    'event_timezone', 'rsvp_enabled', 'rsvp_deadline_at', 'rsvp_roster_version',
    'event_start_at', 'photos_open_from',
    // 0012, appended so every earlier ordinal is unmoved.
    'cover_config', 'cover_revision', 'cover_render_set_id',
    // 0015, appended without relabeling the historical Phase-3 schema.
    'guestbook_prompt',
    // 0019. Recently deleted holds capacity, so its counters live beside the
    // delivered ones rather than being derived from a scan.
    'recoverable_media_count', 'recoverable_bytes',
    // 0021. Album eligibility and Manager-link rotation each own an event-local
    // monotonic revision; neither exposes credential identity.
    'album_pick_generation', 'manager_link_revision',
  ],
  rsvpRosterBatchReceipts: [
    'event_id', 'idempotency_key', 'request_digest', 'receipt_json', 'created_at',
  ],
  releaseCertifications: [
    'worker_version_id', 'build_sha', 'guest_journey_version',
    'migration_manifest_sha256', 'evidence_manifest_sha256',
    'physical_evidence_refs_json', 'certified_at',
  ],
} as const;

interface ExpectedTerminalColumn {
  name: string;
  type: string;
  notnull: 0 | 1;
  dflt_value: string | null;
  pk: number;
}

const EXPECTED_TERMINAL_COLUMNS: Record<keyof typeof EXPECTED_COLUMN_NAMES, ExpectedTerminalColumn[]> = {
  events: [
    { name: 'legacy_owner_claim_open', type: 'INTEGER', notnull: 1, dflt_value: '0', pk: 0 },
    {
      name: 'event_start_at',
      type: 'TEXT',
      notnull: 1,
      dflt_value: "'1970-01-01T00:00:00.000Z'",
      pk: 0,
    },
    { name: 'photos_open_from', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    // Captured from a real applied database, including the embedded double
    // quotes SQLite renders around the stored literal. It is byte-identical to
    // what `canonicalCoverConfig` emits for the `none` config.
    {
      name: 'cover_config',
      type: 'TEXT',
      notnull: 1,
      dflt_value: '\'{"version":1,"source":{"kind":"none"}}\'',
      pk: 0,
    },
    { name: 'cover_revision', type: 'INTEGER', notnull: 1, dflt_value: '0', pk: 0 },
    { name: 'cover_render_set_id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    {
      name: 'guestbook_prompt',
      type: 'TEXT',
      notnull: 1,
      dflt_value: "'Share a wish, memory, or moment from the day.'",
      pk: 0,
    },
    { name: 'recoverable_media_count', type: 'INTEGER', notnull: 1, dflt_value: '0', pk: 0 },
    { name: 'recoverable_bytes', type: 'INTEGER', notnull: 1, dflt_value: '0', pk: 0 },
    { name: 'album_pick_generation', type: 'INTEGER', notnull: 1, dflt_value: '0', pk: 0 },
    { name: 'manager_link_revision', type: 'INTEGER', notnull: 1, dflt_value: '0', pk: 0 },
  ],
  rsvpRosterBatchReceipts: [
    { name: 'event_id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 1 },
    { name: 'idempotency_key', type: 'TEXT', notnull: 1, dflt_value: null, pk: 2 },
    { name: 'request_digest', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    { name: 'receipt_json', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    { name: 'created_at', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
  ],
  releaseCertifications: [
    { name: 'worker_version_id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 1 },
    { name: 'build_sha', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    { name: 'guest_journey_version', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
    { name: 'migration_manifest_sha256', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    { name: 'evidence_manifest_sha256', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    { name: 'physical_evidence_refs_json', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    { name: 'certified_at', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
  ],
};

export type FreshD1CommandId = 'apply' | 'invariants';

export interface FreshD1Command {
  id: FreshD1CommandId;
  executable: string;
  args: string[];
  cwd: string;
  shell: false;
  captureStdout: boolean;
  env: { CI: '1' };
}

export interface FreshD1CommandPlanInput {
  candidateRoot: string;
  freshD1: string;
  nodeExecPath: string;
  wranglerCliPath: string;
}

export interface FreshD1Arguments {
  runRoot: string;
  reportFile: string;
}

export interface FreshD1Request extends FreshD1Arguments {
  candidateRoot: string;
}

export interface FreshD1CommandResult {
  exitCode: number;
  stdout: string;
}

export interface FreshD1Adapters {
  nodeExecPath: string;
  run(command: FreshD1Command): FreshD1CommandResult;
  checkFullIntegrity(freshD1: string): string;
}

function exactArguments(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function buildFreshD1CommandPlan(input: FreshD1CommandPlanInput): FreshD1Command[] {
  return [
    {
      id: 'apply',
      executable: input.nodeExecPath,
      args: [
        input.wranglerCliPath,
        'd1',
        'migrations',
        'apply',
        'DB',
        '--config',
        'wrangler.jsonc',
        '--local',
        '--persist-to',
        input.freshD1,
      ],
      cwd: input.candidateRoot,
      shell: false,
      captureStdout: false,
      env: { CI: '1' },
    },
    {
      id: 'invariants',
      executable: input.nodeExecPath,
      args: [
        input.wranglerCliPath,
        'd1',
        'execute',
        'DB',
        '--config',
        'wrangler.jsonc',
        '--local',
        '--persist-to',
        input.freshD1,
        '--json',
        '--command',
        READ_ONLY_INVARIANT_QUERY,
      ],
      cwd: input.candidateRoot,
      shell: false,
      captureStdout: true,
      env: { CI: '1' },
    },
  ];
}

export function assertFreshD1CommandPlan(
  plan: readonly FreshD1Command[],
  input: FreshD1CommandPlanInput,
): void {
  const expectedIds: FreshD1CommandId[] = ['apply', 'invariants'];
  const expectedArgs = [
    [
      input.wranglerCliPath,
      'd1',
      'migrations',
      'apply',
      'DB',
      '--config',
      'wrangler.jsonc',
      '--local',
      '--persist-to',
      input.freshD1,
    ],
    [
      input.wranglerCliPath,
      'd1',
      'execute',
      'DB',
      '--config',
      'wrangler.jsonc',
      '--local',
      '--persist-to',
      input.freshD1,
      '--json',
      '--command',
      READ_ONLY_INVARIANT_QUERY,
    ],
  ];
  if (plan.length !== expectedIds.length) throw new Error('Fresh-D1 command plan has the wrong length.');
  for (const [index, command] of plan.entries()) {
    if (command.id !== expectedIds[index]
      || command.executable !== input.nodeExecPath
      || command.cwd !== input.candidateRoot
      || command.shell !== false
      || command.captureStdout !== (index === 1)
      || command.env.CI !== '1'
      || Object.keys(command.env).length !== 1
      || !exactArguments(command.args, expectedArgs[index]!)) {
      throw new Error(`Fresh-D1 command ${index + 1} does not match the local-only plan.`);
    }
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function within(container: string, target: string): boolean {
  const path = relative(container, target);
  return path !== '' && !path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path);
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function assertRealDirectory(path: string, label: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory.`);
  }
}

function assertDirectoryChainHasNoLinks(container: string, target: string): void {
  assertRealDirectory(container, 'OS temporary root');
  const path = relative(container, target);
  let current = container;
  for (const component of path.split(/[\\/]/u).filter(Boolean)) {
    current = join(current, component);
    assertRealDirectory(current, 'Run root');
  }
}

function validateFreshD1Paths(runRootInput: string, reportFileInput: string): FreshD1Arguments {
  if (!isAbsolute(runRootInput) || !isAbsolute(reportFileInput)) {
    throw new Error('Fresh-D1 paths must be absolute.');
  }
  const runRoot = resolve(runRootInput);
  const reportFile = resolve(reportFileInput);
  if (!samePath(runRoot, runRootInput) || !samePath(reportFile, reportFileInput)) {
    throw new Error('Fresh-D1 paths must not contain traversal or normalization aliases.');
  }
  const temporaryRoot = resolve(tmpdir());
  if (!within(temporaryRoot, runRoot)
    || !basename(runRoot).startsWith('candidary-release-')
    || basename(runRoot).length === 'candidary-release-'.length) {
    throw new Error('Run root must be one prefixed child beneath the OS temporary root.');
  }
  assertDirectoryChainHasNoLinks(temporaryRoot, runRoot);
  if (!samePath(realpathSync(runRoot), runRoot)) {
    throw new Error('Run root must not traverse a reparse point.');
  }
  const expectedReport = join(runRoot, 'migration-verification.json');
  if (!samePath(reportFile, expectedReport)) {
    throw new Error('Report file must be the exact direct migration-verification.json child.');
  }
  if (pathExists(reportFile)) throw new Error('Migration verification report must not already exist.');
  if (pathExists(join(runRoot, 'fresh-d1'))) throw new Error('fresh-d1 must not already exist.');
  return { runRoot, reportFile };
}

export function parseFreshD1Args(
  args: readonly string[],
): FreshD1Arguments {
  let runRoot: string | undefined;
  let reportFile: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${flag ?? 'argument'}.`);
    if (flag === '--run-root' && runRoot === undefined) runRoot = value;
    else if (flag === '--report-file' && reportFile === undefined) reportFile = value;
    else throw new Error(`Unknown or duplicate Fresh-D1 argument ${flag}.`);
  }
  if (!runRoot || !reportFile) throw new Error('--run-root and --report-file are required.');
  return validateFreshD1Paths(runRoot, reportFile);
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (!exactArguments(actual, expected)) throw new TypeError(`${label} has unexpected fields.`);
  return record;
}

function parseEnvelope(value: unknown, index: number): unknown[] {
  const envelope = exactRecord(value, ['results', 'success', 'meta'], `Wrangler result ${index + 1}`);
  if (envelope.success !== true || !Array.isArray(envelope.results)) {
    throw new TypeError(`Wrangler result ${index + 1} was not successful.`);
  }
  const meta = exactRecord(envelope.meta, ['duration'], `Wrangler result ${index + 1} metadata`);
  if (typeof meta.duration !== 'number' || !Number.isFinite(meta.duration) || meta.duration < 0) {
    throw new TypeError(`Wrangler result ${index + 1} duration is invalid.`);
  }
  return envelope.results;
}

interface ColumnRow {
  cid: number;
  name: string;
  type: string;
  notnull: 0 | 1;
  dflt_value: string | null;
  pk: number;
}

function parseColumnRow(value: unknown, label: string): ColumnRow {
  const row = exactRecord(value, ['cid', 'name', 'type', 'notnull', 'dflt_value', 'pk'], label);
  if (!Number.isSafeInteger(row.cid) || (row.cid as number) < 0
    || typeof row.name !== 'string' || typeof row.type !== 'string'
    || (row.notnull !== 0 && row.notnull !== 1)
    || (row.dflt_value !== null && typeof row.dflt_value !== 'string')
    || !Number.isSafeInteger(row.pk) || (row.pk as number) < 0) {
    throw new TypeError(`${label} contains an invalid SQLite column value.`);
  }
  return row as unknown as ColumnRow;
}

function assertTerminalTable(
  values: unknown[],
  table: keyof typeof EXPECTED_COLUMN_NAMES,
): void {
  const expectedNames = EXPECTED_COLUMN_NAMES[table];
  if (values.length !== expectedNames.length) throw new Error(`${table} column count is invalid.`);
  const rows = values.map((value, index) => parseColumnRow(value, `${table} column ${index + 1}`));
  for (const [index, row] of rows.entries()) {
    if (row.cid !== index || row.name !== expectedNames[index]) {
      throw new Error(`${table} column sequence is invalid.`);
    }
  }
  for (const expected of EXPECTED_TERMINAL_COLUMNS[table]) {
    const row = rows.find((candidate) => candidate.name === expected.name);
    if (!row
      || row.type !== expected.type
      || row.notnull !== expected.notnull
      || row.dflt_value !== expected.dflt_value
      || row.pk !== expected.pk) {
      throw new Error(`${table}.${expected.name} terminal definition is invalid.`);
    }
  }
}

function textField(value: unknown, keys: readonly string[], label: string): Record<string, string> {
  const row = exactRecord(value, keys, label);
  const out: Record<string, string> = {};
  for (const key of keys) {
    const cell = row[key];
    if (typeof cell !== 'string') throw new TypeError(`${label}.${key} is not text.`);
    out[key] = cell;
  }
  return out;
}

function assertExactList(actual: readonly string[], expected: readonly string[], label: string): void {
  if (!exactArguments([...actual], [...expected])) throw new Error(`${label} is invalid.`);
}

function assertCoverTables(values: unknown[]): void {
  assertExactList(
    values.map((value, index) => textField(value, ['name'], `Cover table ${index + 1}`).name!),
    EXPECTED_COVER_TABLES,
    'Cover table set',
  );
}

function assertCoverColumns(values: unknown[]): void {
  const seen = new Map<string, string[]>();
  for (const [index, value] of values.entries()) {
    const row = textField(value, ['tbl', 'col'], `Cover column ${index + 1}`);
    const list = seen.get(row.tbl!) ?? [];
    list.push(row.col!);
    seen.set(row.tbl!, list);
  }
  assertExactList([...seen.keys()].sort(), EXPECTED_COVER_TABLES, 'Cover column table set');
  for (const [table, columns] of seen) {
    assertExactList(columns, EXPECTED_COVER_COLUMNS[table]!, `${table} column sequence`);
  }
}

function assertCoverForeignKeys(values: unknown[]): void {
  assertExactList(
    values.map((value, index) => {
      const row = textField(value, ['tbl', 'parent', 'col', 'on_delete'], `Cover foreign key ${index + 1}`);
      return `${row.tbl}.${row.col} -> ${row.parent} ${row.on_delete}`;
    }),
    EXPECTED_COVER_FOREIGN_KEYS,
    'Cover foreign-key set',
  );
}

function assertCoverIndexes(values: unknown[]): void {
  assertExactList(
    values.map((value, index) => {
      const row = exactRecord(value, ['tbl', 'idx', 'uniq', 'partial'], `Cover index ${index + 1}`);
      if (typeof row.tbl !== 'string' || typeof row.idx !== 'string'
        || (row.uniq !== 0 && row.uniq !== 1) || (row.partial !== 0 && row.partial !== 1)) {
        throw new TypeError(`Cover index ${index + 1} contains an invalid value.`);
      }
      return `${row.tbl}.${row.idx} unique=${row.uniq} partial=${row.partial}`;
    }),
    EXPECTED_COVER_INDEXES,
    'Cover index set',
  );
}

function assertPartialUniquePredicates(values: unknown[]): void {
  const expectedNames = Object.keys(EXPECTED_PARTIAL_UNIQUE_SQL).sort();
  const rows = values.map((value, index) => textField(value, ['name', 'sql'], `Partial unique index ${index + 1}`));
  assertExactList(rows.map((row) => row.name!), expectedNames, 'Partial unique index set');
  for (const row of rows) {
    if (row.sql!.replace(/\s+/gu, ' ').trim() !== EXPECTED_PARTIAL_UNIQUE_SQL[row.name!]) {
      throw new Error(`${row.name} predicate has drifted.`);
    }
  }
}

function assertGuestbookTables(values: unknown[]): void {
  assertExactList(
    values.map((value, index) => textField(value, ['name'], `Guestbook table ${index + 1}`).name!),
    EXPECTED_GUESTBOOK_TABLES,
    'Guestbook table set',
  );
}

function assertGuestbookColumns(values: unknown[]): void {
  const seen = new Map<string, string[]>();
  for (const [index, value] of values.entries()) {
    const row = exactRecord(value, ['tbl', 'cid', 'col'], `Guestbook column ${index + 1}`);
    if (typeof row.tbl !== 'string' || typeof row.col !== 'string'
      || !Number.isSafeInteger(row.cid) || row.cid !== (seen.get(row.tbl)?.length ?? 0)) {
      throw new TypeError(`Guestbook column ${index + 1} contains an invalid value.`);
    }
    const list = seen.get(row.tbl) ?? [];
    list.push(row.col);
    seen.set(row.tbl, list);
  }
  assertExactList([...seen.keys()].sort(), Object.keys(EXPECTED_GUESTBOOK_COLUMNS).sort(), 'Guestbook column table set');
  for (const [table, columns] of seen) {
    assertExactList(columns, EXPECTED_GUESTBOOK_COLUMNS[table]!, `${table} column sequence`);
  }
}

function assertGuestbookForeignKeys(values: unknown[]): void {
  assertExactList(
    values.map((value, index) => {
      const row = textField(value, ['tbl', 'parent', 'col', 'on_delete'], `Guestbook foreign key ${index + 1}`);
      return `${row.tbl}.${row.col} -> ${row.parent} ${row.on_delete}`;
    }),
    EXPECTED_GUESTBOOK_FOREIGN_KEYS,
    'Guestbook foreign-key set',
  );
}

function assertGuestbookIndexes(values: unknown[]): void {
  assertExactList(
    values.map((value, index) => {
      const row = exactRecord(value, ['tbl', 'idx', 'uniq', 'partial'], `Guestbook index ${index + 1}`);
      if (typeof row.tbl !== 'string' || typeof row.idx !== 'string'
        || (row.uniq !== 0 && row.uniq !== 1) || (row.partial !== 0 && row.partial !== 1)) {
        throw new TypeError(`Guestbook index ${index + 1} contains an invalid value.`);
      }
      return `${row.tbl}.${row.idx} unique=${row.uniq} partial=${row.partial}`;
    }),
    EXPECTED_GUESTBOOK_INDEXES,
    'Guestbook index set',
  );
}

function assertGuestbookChecks(values: unknown[]): void {
  const expectedNames = Object.keys(EXPECTED_GUESTBOOK_CHECKS).sort();
  const rows = values.map((value, index) => textField(value, ['name', 'checks'], `Guestbook checks ${index + 1}`));
  assertExactList(rows.map((row) => row.name!), expectedNames, 'Guestbook check table set');
  for (const row of rows) {
    if (row.checks !== EXPECTED_GUESTBOOK_CHECKS[row.name!]) {
      throw new Error(`${row.name} CHECK inventory has drifted.`);
    }
  }
}

function assertMediaObjectPromotionsSql(values: unknown[]): void {
  if (values.length !== 1) {
    throw new Error('media_object_promotions table SQL returned the wrong row count.');
  }
  const row = textField(values[0], ['name', 'sql'], 'media_object_promotions table SQL');
  if (row.name !== 'media_object_promotions'
    || row.sql!.replace(/\s+/gu, ' ').trim() !== EXPECTED_MEDIA_OBJECT_PROMOTIONS_SQL) {
    throw new Error('media_object_promotions normalized table SQL has drifted.');
  }
}

function assertAlbumTables(values: unknown[]): void {
  assertExactList(
    values.map((value, index) => textField(value, ['name'], `Album table ${index + 1}`).name!),
    EXPECTED_ALBUM_TABLES,
    'Album table set',
  );
}

function assertAlbumColumns(values: unknown[]): void {
  assertExactList(
    values.map((value, index) => {
      const row = exactRecord(
        value,
        ['tbl', 'cid', 'col', 'type', 'notnull', 'dflt_value', 'pk'],
        `Album column ${index + 1}`,
      );
      if (typeof row.tbl !== 'string' || typeof row.col !== 'string'
        || typeof row.type !== 'string'
        || !Number.isSafeInteger(row.cid) || (row.cid as number) < 0
        || (row.notnull !== 0 && row.notnull !== 1)
        || (row.dflt_value !== null && typeof row.dflt_value !== 'string')
        || !Number.isSafeInteger(row.pk) || (row.pk as number) < 0) {
        throw new TypeError(`Album column ${index + 1} contains an invalid value.`);
      }
      return `${row.tbl}.${row.cid} ${row.col} ${row.type} notnull=${row.notnull}`
        + ` default=${row.dflt_value ?? 'NULL'} pk=${row.pk}`;
    }),
    EXPECTED_ALBUM_COLUMNS,
    'Album column definitions',
  );
}

function assertAlbumForeignKeys(values: unknown[]): void {
  assertExactList(
    values.map((value, index) => {
      const row = textField(value, ['tbl', 'parent', 'col', 'on_delete'], `Album foreign key ${index + 1}`);
      return `${row.tbl}.${row.col} -> ${row.parent} ${row.on_delete}`;
    }),
    EXPECTED_ALBUM_FOREIGN_KEYS,
    'Album foreign-key set',
  );
}

function assertAlbumIndexes(values: unknown[]): void {
  assertExactList(
    values.map((value, index) => {
      const row = exactRecord(value, ['tbl', 'idx', 'uniq', 'partial', 'sql'], `Album index ${index + 1}`);
      if (typeof row.tbl !== 'string' || typeof row.idx !== 'string'
        || (row.uniq !== 0 && row.uniq !== 1) || (row.partial !== 0 && row.partial !== 1)
        || (row.sql !== null && typeof row.sql !== 'string')) {
        throw new TypeError(`Album index ${index + 1} contains an invalid value.`);
      }
      const normalizedSql = typeof row.sql === 'string'
        ? row.sql.replace(/\s+/gu, ' ').trim()
        : 'NULL';
      return `${row.tbl}.${row.idx} unique=${row.uniq} partial=${row.partial} sql=${normalizedSql}`;
    }),
    EXPECTED_ALBUM_INDEXES,
    'Album index set',
  );
}

function assertAlbumChecks(values: unknown[]): void {
  const expectedNames = Object.keys(EXPECTED_ALBUM_CHECKS).sort();
  const rows = values.map((value, index) => textField(value, ['name', 'checks'], `Album checks ${index + 1}`));
  assertExactList(rows.map((row) => row.name!), expectedNames, 'Album check table set');
  for (const row of rows) {
    if (row.checks !== EXPECTED_ALBUM_CHECKS[row.name!]) {
      throw new Error(`${row.name} album CHECK inventory has drifted.`);
    }
  }
}

function assertRecoveryColumns(values: unknown[]): void {
  assertExactList(
    values.map((value, index) => {
      const row = exactRecord(
        value,
        ['tbl', 'cid', 'col', 'type', 'notnull', 'dflt_value', 'pk'],
        `Recovery column ${index + 1}`,
      );
      if (typeof row.tbl !== 'string' || typeof row.col !== 'string'
        || typeof row.type !== 'string'
        || !Number.isSafeInteger(row.cid) || (row.cid as number) < 0
        || (row.notnull !== 0 && row.notnull !== 1)
        || (row.dflt_value !== null && typeof row.dflt_value !== 'string')
        || !Number.isSafeInteger(row.pk) || (row.pk as number) < 0) {
        throw new TypeError(`Recovery column ${index + 1} contains an invalid value.`);
      }
      return `${row.tbl}.${row.cid} ${row.col} ${row.type} notnull=${row.notnull}`
        + ` default=${row.dflt_value ?? 'NULL'} pk=${row.pk}`;
    }),
    EXPECTED_RECOVERY_COLUMNS,
    'Recovery column definitions',
  );
}

function assertRecoveryIndexes(values: unknown[]): void {
  const rows = values.map((value, index) => textField(
    value,
    ['name', 'sql'],
    `Recovery index ${index + 1}`,
  ));
  const expectedNames = Object.keys(EXPECTED_RECOVERY_INDEX_SQL).sort();
  assertExactList(rows.map((row) => row.name!), expectedNames, 'Recovery index set');
  for (const row of rows) {
    const normalized = row.sql!.replace(/\s+/gu, ' ').trim();
    if (normalized !== EXPECTED_RECOVERY_INDEX_SQL[row.name!]) {
      throw new Error(`${row.name} recovery index SQL has drifted.`);
    }
  }
}

function assertExportProgressColumns(values: unknown[]): void {
  const tableSql = new Set<string>();
  assertExactList(
    values.map((value, index) => {
      const row = exactRecord(
        value,
        ['cid', 'name', 'type', 'notnull', 'dflt_value', 'pk', 'table_sql'],
        `Export progress column ${index + 1}`,
      );
      if (typeof row.name !== 'string' || typeof row.type !== 'string'
        || typeof row.table_sql !== 'string'
        || !Number.isSafeInteger(row.cid) || (row.cid as number) < 0
        || (row.notnull !== 0 && row.notnull !== 1)
        || (row.dflt_value !== null && typeof row.dflt_value !== 'string')
        || !Number.isSafeInteger(row.pk) || (row.pk as number) < 0) {
        throw new TypeError(`Export progress column ${index + 1} contains an invalid value.`);
      }
      tableSql.add(row.table_sql);
      return `${row.cid} ${row.name} ${row.type} notnull=${row.notnull}`
        + ` default=${row.dflt_value ?? 'NULL'} pk=${row.pk}`;
    }),
    EXPECTED_EXPORT_PROGRESS_COLUMNS,
    'Export progress column definitions',
  );
  if (tableSql.size !== 1) throw new Error('export_jobs table SQL is inconsistent.');
  const normalized = [...tableSql][0]!.replace(/\s+/gu, ' ').trim();
  if (sha256(normalized) !== EXPECTED_EXPORT_JOBS_TABLE_SQL_SHA256) {
    throw new Error('export_jobs table SQL has drifted.');
  }
}

function assertExportProtocolAdmission(values: unknown[]): void {
  const tableSql = new Set<string>();
  assertExactList(
    values.map((value, index) => {
      const row = exactRecord(
        value,
        [
          'cid', 'name', 'type', 'notnull', 'dflt_value', 'pk', 'table_sql',
          'singleton', 'state', 'closed_at', 'worker_version_id', 'admitted_at',
        ],
        `Export protocol admission column ${index + 1}`,
      );
      if (typeof row.name !== 'string' || typeof row.type !== 'string'
        || typeof row.table_sql !== 'string'
        || !Number.isSafeInteger(row.cid) || (row.cid as number) < 0
        || (row.notnull !== 0 && row.notnull !== 1)
        || (row.dflt_value !== null && typeof row.dflt_value !== 'string')
        || !Number.isSafeInteger(row.pk) || (row.pk as number) < 0
        || row.singleton !== 1 || row.state !== 'legacy-open'
        || row.closed_at !== null
        || row.worker_version_id !== null || row.admitted_at !== null) {
        throw new TypeError(`Export protocol admission column ${index + 1} is invalid.`);
      }
      tableSql.add(row.table_sql);
      return `${row.cid} ${row.name} ${row.type} notnull=${row.notnull}`
        + ` default=${row.dflt_value ?? 'NULL'} pk=${row.pk}`;
    }),
    EXPECTED_EXPORT_PROTOCOL_ADMISSION_COLUMNS,
    'Export protocol admission column definitions',
  );
  if (tableSql.size !== 1) {
    throw new Error('Export protocol admission table SQL is inconsistent.');
  }
  const normalized = [...tableSql][0]!.replace(/\s+/gu, ' ').trim();
  if (sha256(normalized) !== EXPECTED_EXPORT_PROTOCOL_ADMISSION_SQL_SHA256) {
    throw new Error('Export protocol admission table SQL has drifted.');
  }
}

function assertManagerUploadAlbumEraColumns(values: unknown[]): void {
  assertExactList(
    values.map((value, index) => {
      const row = exactRecord(
        value,
        ['tbl', 'cid', 'col', 'type', 'notnull', 'dflt_value', 'pk', 'checks'],
        `Manager upload and Album-era column ${index + 1}`,
      );
      if (typeof row.tbl !== 'string' || typeof row.col !== 'string'
        || typeof row.type !== 'string' || typeof row.checks !== 'string'
        || !Number.isSafeInteger(row.cid) || (row.cid as number) < 0
        || (row.notnull !== 0 && row.notnull !== 1)
        || (row.dflt_value !== null && typeof row.dflt_value !== 'string')
        || !Number.isSafeInteger(row.pk) || (row.pk as number) < 0) {
        throw new TypeError(
          `Manager upload and Album-era column ${index + 1} contains an invalid value.`,
        );
      }
      return `${row.tbl}.${row.cid} ${row.col} ${row.type} notnull=${row.notnull}`
        + ` default=${row.dflt_value ?? 'NULL'} pk=${row.pk} checks=${row.checks}`;
    }),
    EXPECTED_MANAGER_UPLOAD_ALBUM_ERA_COLUMNS,
    'Manager upload and Album-era column definitions',
  );
}

function assertManagerUploadAlbumEraForeignKeys(values: unknown[]): void {
  assertExactList(
    values.map((value, index) => {
      const row = textField(
        value,
        ['tbl', 'parent', 'col', 'parent_col', 'on_delete'],
        `Manager upload foreign key ${index + 1}`,
      );
      return `${row.tbl}.${row.col} -> ${row.parent}.${row.parent_col} ${row.on_delete}`;
    }),
    EXPECTED_MANAGER_UPLOAD_ALBUM_ERA_FOREIGN_KEYS,
    'Manager upload foreign keys',
  );
}

function assertManagerUploadAlbumEraIndexes(values: unknown[]): void {
  const rows = values.map((value, index) => {
    const row = exactRecord(
      value,
      ['name', 'uniq', 'partial', 'sql'],
      `Manager upload index ${index + 1}`,
    );
    if (typeof row.name !== 'string' || typeof row.sql !== 'string'
      || row.uniq !== 1 || row.partial !== 1) {
      throw new TypeError(`Manager upload index ${index + 1} is invalid.`);
    }
    return row as { name: string; sql: string };
  });
  const expectedNames = Object.keys(EXPECTED_MANAGER_UPLOAD_ALBUM_ERA_INDEX_SQL);
  assertExactList(rows.map((row) => row.name), expectedNames, 'Manager upload index set');
  for (const row of rows) {
    const normalized = row.sql.replace(/\s+/gu, ' ').trim();
    if (normalized !== EXPECTED_MANAGER_UPLOAD_ALBUM_ERA_INDEX_SQL[row.name]) {
      throw new Error(`${row.name} Manager upload index SQL has drifted.`);
    }
  }
}

function assertTriggers(values: unknown[]): void {
  const rows = values.map((value, index) => textField(value, ['name', 'sql'], `Trigger ${index + 1}`));
  assertExactList(rows.map((row) => row.name!), Object.keys(EXPECTED_TRIGGER_SQL_SHA256), 'Trigger set');
  for (const row of rows) {
    const normalized = row.sql!.replace(/\s+/gu, ' ').trim();
    if (sha256(normalized) !== EXPECTED_TRIGGER_SQL_SHA256[row.name!]) {
      throw new Error(`${row.name} trigger body SQL has drifted.`);
    }
  }
}

export function parseWranglerInvariantOutput(
  stdout: string,
  expectedLedgerNames: readonly string[],
): MigrationVerification {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    throw new TypeError('Wrangler invariant output is not JSON.');
  }
  if (!Array.isArray(parsed) || parsed.length !== INVARIANT_STATEMENT_COUNT) {
    throw new TypeError(`Wrangler invariant output must contain ${INVARIANT_STATEMENT_COUNT} exact results.`);
  }
  if (expectedLedgerNames.length === 0
    || expectedLedgerNames.some((name) => !/^\d{4}_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/u.test(name))) {
    throw new TypeError('Expected migration ledger is invalid.');
  }
  if (expectedLedgerNames.length !== EXPECTED_MIGRATION_COUNT) {
    throw new Error(`This candidate must contain exactly ${EXPECTED_MIGRATION_COUNT} migrations.`);
  }
  const results = parsed.map(parseEnvelope);
  const ledger = results[0]!;
  if (ledger.length !== expectedLedgerNames.length) throw new Error('Migration ledger length is invalid.');
  for (const [index, value] of ledger.entries()) {
    const row = exactRecord(value, ['id', 'name'], `Migration ledger row ${index + 1}`);
    if (row.id !== index + 1 || row.name !== expectedLedgerNames[index]) {
      throw new Error('Migration ledger does not exactly match checked-in migrations.');
    }
  }
  if (results[1]!.length !== 0) throw new Error('Foreign-key verification returned violations.');
  if (results[2]!.length !== 1) throw new Error('Integrity verification returned the wrong row count.');
  const integrity = exactRecord(results[2]![0], ['quick_check'], 'Integrity row');
  if (integrity.quick_check !== 'ok') throw new Error('SQLite quick integrity verification failed.');
  assertTerminalTable(results[3]!, 'events');
  assertTerminalTable(results[4]!, 'rsvpRosterBatchReceipts');
  assertTerminalTable(results[5]!, 'releaseCertifications');
  assertCoverTables(results[6]!);
  assertCoverColumns(results[7]!);
  assertCoverForeignKeys(results[8]!);
  assertCoverIndexes(results[9]!);
  assertPartialUniquePredicates(results[10]!);
  assertTriggers(results[11]!);
  assertGuestbookTables(results[12]!);
  assertGuestbookColumns(results[13]!);
  assertGuestbookForeignKeys(results[14]!);
  assertGuestbookIndexes(results[15]!);
  assertGuestbookChecks(results[16]!);
  assertMediaObjectPromotionsSql(results[17]!);
  assertAlbumTables(results[18]!);
  assertAlbumColumns(results[19]!);
  assertAlbumForeignKeys(results[20]!);
  assertAlbumIndexes(results[21]!);
  assertAlbumChecks(results[22]!);
  assertRecoveryColumns(results[23]!);
  assertRecoveryIndexes(results[24]!);
  assertExportProgressColumns(results[25]!);
  assertExportProtocolAdmission(results[26]!);
  assertManagerUploadAlbumEraColumns(results[27]!);
  assertManagerUploadAlbumEraForeignKeys(results[28]!);
  assertManagerUploadAlbumEraIndexes(results[29]!);

  // `terminalSchema` deliberately keeps its three keys. `exactRecord` rejects
  // unknown fields, the literal recurs in four test files, and
  // `CANDIDATE_MANIFEST_SCHEMA_VERSION` is 1 — so the cover assertions above stay
  // internal to the verifier and throw rather than widening the reported shape.
  return {
    migrationCount: expectedLedgerNames.length,
    ledgerSha256: sha256(canonicalJson(expectedLedgerNames)),
    foreignKeyRows: 0,
    integrity: 'ok',
    terminalSchema: {
      events: true,
      rosterBatchReceipts: true,
      releaseCertifications: true,
    },
  };
}

function validatedWranglerCli(candidateRoot: string): string {
  const expected = resolve(candidateRoot, 'node_modules/wrangler/bin/wrangler.js');
  const stat = lstatSync(expected);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Candidate-local Wrangler CLI must be one regular file.');
  }
  const cli = realpathSync(expected);
  const root = realpathSync(candidateRoot);
  const path = relative(root, cli);
  if (path.startsWith(`..${sep}`) || path === '..' || isAbsolute(path)) {
    throw new Error('Wrangler CLI must remain inside the candidate checkout.');
  }
  return cli;
}

function checkFreshD1Integrity(freshD1: string): string {
  const databaseRoot = resolve(freshD1, 'v3/d1/miniflare-D1DatabaseObject');
  assertDirectoryChainHasNoLinks(freshD1, databaseRoot);
  const candidates = readdirSync(databaseRoot, { withFileTypes: true })
    .filter((entry) => /^[0-9a-f]{64}\.sqlite$/u.test(entry.name));
  if (candidates.length !== 1 || !candidates[0]!.isFile() || candidates[0]!.isSymbolicLink()) {
    throw new Error('Fresh-D1 persistence must contain one exact candidate database file.');
  }
  const databaseFile = resolve(databaseRoot, candidates[0]!.name);
  const stat = lstatSync(databaseFile);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Fresh-D1 candidate database must be one regular file.');
  }
  const realDatabaseFile = realpathSync(databaseFile);
  if (!within(realpathSync(freshD1), realDatabaseFile)) {
    throw new Error('Fresh-D1 candidate database escaped its persistence root.');
  }
  const database = new DatabaseSync(realDatabaseFile, { readOnly: true });
  try {
    const rows = database.prepare('PRAGMA integrity_check;').all();
    if (rows.length !== 1) throw new Error('Full SQLite integrity check returned the wrong row count.');
    const row = exactRecord(rows[0], ['integrity_check'], 'Full SQLite integrity row');
    if (row.integrity_check !== 'ok') throw new Error('Full SQLite integrity check failed.');
    return 'ok';
  } finally {
    database.close();
  }
}

function publishReport(reportFile: string, report: MigrationVerification): void {
  const temporaryFile = join(dirname(reportFile), `.migration-verification.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  let temporaryExists = false;
  try {
    descriptor = openSync(temporaryFile, 'wx', 0o600);
    temporaryExists = true;
    writeFileSync(descriptor, `${canonicalJson(report)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    if (pathExists(reportFile)) throw new Error('Migration verification report appeared before publication.');
    renameSync(temporaryFile, reportFile);
    temporaryExists = false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (temporaryExists) {
      try {
        unlinkSync(temporaryFile);
      } catch {
        // Best-effort cleanup cannot replace the original verification failure.
      }
    }
  }
}

const FRESH_D1_ENVIRONMENT_NAMES = new Set([
  'ALLUSERSPROFILE', 'APPDATA', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)',
  'COMMONPROGRAMW6432', 'COMPUTERNAME', 'COMSPEC', 'HOMEDRIVE', 'HOMEPATH',
  'HOME', 'LANG', 'LANGUAGE', 'LOCALAPPDATA', 'LOGNAME', 'NODE_EXTRA_CA_CERTS',
  'NO_PROXY', 'NUMBER_OF_PROCESSORS', 'NPM_CONFIG_CACHE', 'OPENSSL_CONF', 'OS',
  'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'PROGRAMDATA', 'PROGRAMFILES',
  'PROGRAMFILES(X86)', 'PROGRAMW6432', 'PUBLIC', 'SHELL', 'SSL_CERT_DIR',
  'SSL_CERT_FILE', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TERM', 'TMP', 'TMPDIR',
  'TZ', 'USER', 'USERNAME', 'USERPROFILE', 'WINDIR', 'XDG_CACHE_HOME',
]);

export function freshD1ProcessEnvironment(
  source: NodeJS.ProcessEnv,
  commandEnvironment: FreshD1Command['env'],
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    const upper = name.toUpperCase();
    if (value !== undefined && (
      FRESH_D1_ENVIRONMENT_NAMES.has(upper)
      || upper.startsWith('LC_')
      || upper === 'HTTP_PROXY'
      || upper === 'HTTPS_PROXY'
      || upper === 'ALL_PROXY'
    )) {
      environment[name] = value;
    }
  }
  environment.WRANGLER_SEND_METRICS = 'false';
  return { ...environment, ...commandEnvironment };
}

const defaultAdapters: FreshD1Adapters = {
  nodeExecPath: process.execPath,
  run(command) {
    const result = spawnSync(command.executable, command.args, {
      cwd: command.cwd,
      encoding: command.captureStdout ? 'utf8' : undefined,
      env: freshD1ProcessEnvironment(process.env, command.env),
      shell: command.shell,
      stdio: command.captureStdout ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    });
    if (result.error) throw result.error;
    return {
      exitCode: result.status ?? -1,
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
    };
  },
  checkFullIntegrity: checkFreshD1Integrity,
};

function runCommand(command: FreshD1Command, adapters: FreshD1Adapters): string {
  const result = adapters.run(command);
  if (!Number.isSafeInteger(result.exitCode) || result.exitCode !== 0) {
    throw new Error(`Fresh-D1 ${command.id} command failed.`);
  }
  return result.stdout;
}

export function runFreshD1Verification(
  request: FreshD1Request,
  adapters: FreshD1Adapters = defaultAdapters,
): MigrationVerification {
  const { runRoot, reportFile } = validateFreshD1Paths(request.runRoot, request.reportFile);
  const candidateRoot = resolve(request.candidateRoot);
  assertRealDirectory(candidateRoot, 'Candidate root');
  if (!isAbsolute(adapters.nodeExecPath)) throw new Error('Node executable path must be absolute.');
  const migrations = collectMigrationManifest(candidateRoot);
  const ledgerNames = migrations.files.map((file) => basename(file.path));
  const wranglerCliPath = validatedWranglerCli(candidateRoot);
  const freshD1 = join(runRoot, 'fresh-d1');
  mkdirSync(freshD1, { recursive: false });
  const input = {
    candidateRoot,
    freshD1,
    nodeExecPath: adapters.nodeExecPath,
    wranglerCliPath,
  };
  const plan = buildFreshD1CommandPlan(input);
  assertFreshD1CommandPlan(plan, input);
  runCommand(plan[0]!, adapters);
  const stdout = runCommand(plan[1]!, adapters);
  const report = parseWranglerInvariantOutput(stdout, ledgerNames);
  if (adapters.checkFullIntegrity(freshD1) !== 'ok') {
    throw new Error('Full SQLite integrity verification failed.');
  }
  publishReport(reportFile, report);
  return report;
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  try {
    const candidateRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const request = parseFreshD1Args(process.argv.slice(2));
    runFreshD1Verification({ candidateRoot, ...request });
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Fresh local D1 verification failed.');
    process.exitCode = 1;
  }
}

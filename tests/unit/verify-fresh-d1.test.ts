import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import {
  canonicalJson,
  collectMigrationManifest,
  sha256,
  type MigrationVerification,
} from '../../scripts/migration-manifest';
import {
  READ_ONLY_INVARIANT_QUERY,
  assertFreshD1CommandPlan,
  buildFreshD1CommandPlan,
  freshD1ProcessEnvironment,
  parseFreshD1Args,
  parseWranglerInvariantOutput,
  runFreshD1Verification,
  type FreshD1Adapters,
  type FreshD1Command,
} from '../../scripts/verify-fresh-d1';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function put(root: string, path: string, content = ''): Promise<string> {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
  return target;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

const eventColumnNames = [
  'id', 'slug', 'name', 'event_date', 'welcome_message', 'cover_object_key',
  'uploads_enabled', 'gallery_visible', 'moderation_required',
  'reserved_media_count', 'stored_media_count', 'reserved_bytes', 'stored_bytes',
  'guest_access_expires_at', 'management_access_expires_at', 'purge_after',
  'created_at', 'deleted_at', 'legacy_owner_claim_open', 'theme_config',
  'event_timezone', 'rsvp_enabled', 'rsvp_deadline_at', 'rsvp_roster_version',
  'event_start_at', 'photos_open_from',
  'cover_config', 'cover_revision', 'cover_render_set_id',
  'guestbook_prompt',
];

// Every checked-in migration, in order. Pinned rather than globbed: the
// post-cutover verifier refuses a candidate whose ledger is not exactly fifteen.
const migrationFileNames = [
  '0001_core.sql', '0002_wedding_photo_drop.sql', '0003_partitioned_exports.sql',
  '0004_manager_media_pagination.sql', '0005_media_stored_at.sql', '0006_host_accounts.sql',
  '0007_event_theme.sql', '0008_event_rsvp.sql', '0009_rsvp_roster_batches.sql',
  '0010_event_start.sql', '0011_release_certifications.sql', '0012_event_cover_storage.sql',
  '0013_guest_message_hardening.sql', '0014_event_cover_invariants.sql',
  '0015_curated_private_guestbook.sql',
];

// Exactly how SQLite renders the stored `cover_config` default, quotes and all.
// Assembled rather than escaped inline so the embedded double quotes are legible.
const coverConfigDefault = `'${'{"version":1,"source":{"kind":"none"}}'}'`;

// Captured from a real applied database rather than restated from the verifier's
// own constants, so the fixture is evidence and not a tautology.
const coverTableRows = [{"name":"event_cover_backfill_jobs"},{"name":"event_cover_backfill_runs"},{"name":"event_cover_draft_previews"},{"name":"event_cover_drafts"},{"name":"event_cover_masters"},{"name":"event_cover_publish_receipts"},{"name":"event_cover_purge_progress"},{"name":"event_cover_rate_events"},{"name":"event_cover_render_objects"},{"name":"event_cover_render_sets"},{"name":"event_cover_retired_legacy_objects"},{"name":"event_cover_workflow_fences"}];

const coverColumnRows = [{"tbl":"event_cover_backfill_jobs","col":"id"},{"tbl":"event_cover_backfill_jobs","col":"run_id"},{"tbl":"event_cover_backfill_jobs","col":"event_id"},{"tbl":"event_cover_backfill_jobs","col":"expected_revision"},{"tbl":"event_cover_backfill_jobs","col":"legacy_key_fingerprint"},{"tbl":"event_cover_backfill_jobs","col":"master_id"},{"tbl":"event_cover_backfill_jobs","col":"render_set_id"},{"tbl":"event_cover_backfill_jobs","col":"workflow_instance_id"},{"tbl":"event_cover_backfill_jobs","col":"dispatch_state"},{"tbl":"event_cover_backfill_jobs","col":"dispatch_generation"},{"tbl":"event_cover_backfill_jobs","col":"status"},{"tbl":"event_cover_backfill_jobs","col":"dependency_versions_json"},{"tbl":"event_cover_backfill_jobs","col":"manifest_json"},{"tbl":"event_cover_backfill_jobs","col":"manifest_sha256"},{"tbl":"event_cover_backfill_jobs","col":"failure_code"},{"tbl":"event_cover_backfill_jobs","col":"retryable"},{"tbl":"event_cover_backfill_jobs","col":"terminal_at"},{"tbl":"event_cover_backfill_jobs","col":"reference_release_at"},{"tbl":"event_cover_backfill_jobs","col":"expires_at"},{"tbl":"event_cover_backfill_jobs","col":"created_at"},{"tbl":"event_cover_backfill_jobs","col":"updated_at"},{"tbl":"event_cover_backfill_runs","col":"id"},{"tbl":"event_cover_backfill_runs","col":"mode"},{"tbl":"event_cover_backfill_runs","col":"cursor"},{"tbl":"event_cover_backfill_runs","col":"inventory_sha256"},{"tbl":"event_cover_backfill_runs","col":"total_count"},{"tbl":"event_cover_backfill_runs","col":"queued_count"},{"tbl":"event_cover_backfill_runs","col":"applied_count"},{"tbl":"event_cover_backfill_runs","col":"skipped_count"},{"tbl":"event_cover_backfill_runs","col":"resolved_count"},{"tbl":"event_cover_backfill_runs","col":"failed_count"},{"tbl":"event_cover_backfill_runs","col":"needs_replacement_count"},{"tbl":"event_cover_backfill_runs","col":"status"},{"tbl":"event_cover_backfill_runs","col":"created_at"},{"tbl":"event_cover_backfill_runs","col":"updated_at"},{"tbl":"event_cover_backfill_runs","col":"verified_at"},{"tbl":"event_cover_backfill_runs","col":"expires_at"},{"tbl":"event_cover_draft_previews","col":"id"},{"tbl":"event_cover_draft_previews","col":"draft_id"},{"tbl":"event_cover_draft_previews","col":"event_id"},{"tbl":"event_cover_draft_previews","col":"effect_id"},{"tbl":"event_cover_draft_previews","col":"recipe_version"},{"tbl":"event_cover_draft_previews","col":"state"},{"tbl":"event_cover_draft_previews","col":"object_key"},{"tbl":"event_cover_draft_previews","col":"mime_type"},{"tbl":"event_cover_draft_previews","col":"byte_size"},{"tbl":"event_cover_draft_previews","col":"width"},{"tbl":"event_cover_draft_previews","col":"height"},{"tbl":"event_cover_draft_previews","col":"ladder_rung"},{"tbl":"event_cover_draft_previews","col":"sha256"},{"tbl":"event_cover_draft_previews","col":"failure_code"},{"tbl":"event_cover_draft_previews","col":"retryable"},{"tbl":"event_cover_draft_previews","col":"created_at"},{"tbl":"event_cover_draft_previews","col":"updated_at"},{"tbl":"event_cover_drafts","col":"id"},{"tbl":"event_cover_drafts","col":"event_id"},{"tbl":"event_cover_drafts","col":"source"},{"tbl":"event_cover_drafts","col":"state"},{"tbl":"event_cover_drafts","col":"draft_intent_id"},{"tbl":"event_cover_drafts","col":"request_sha256"},{"tbl":"event_cover_drafts","col":"draft_revision"},{"tbl":"event_cover_drafts","col":"raw_object_key"},{"tbl":"event_cover_drafts","col":"declared_filename"},{"tbl":"event_cover_drafts","col":"declared_mime_type"},{"tbl":"event_cover_drafts","col":"declared_byte_size"},{"tbl":"event_cover_drafts","col":"verified_raw_byte_size"},{"tbl":"event_cover_drafts","col":"raw_etag"},{"tbl":"event_cover_drafts","col":"master_id"},{"tbl":"event_cover_drafts","col":"focus_x"},{"tbl":"event_cover_drafts","col":"focus_y"},{"tbl":"event_cover_drafts","col":"composition_model_version"},{"tbl":"event_cover_drafts","col":"inspection_json"},{"tbl":"event_cover_drafts","col":"failure_code"},{"tbl":"event_cover_drafts","col":"created_at"},{"tbl":"event_cover_drafts","col":"updated_at"},{"tbl":"event_cover_drafts","col":"reservation_expires_at"},{"tbl":"event_cover_drafts","col":"expires_at"},{"tbl":"event_cover_masters","col":"id"},{"tbl":"event_cover_masters","col":"event_id"},{"tbl":"event_cover_masters","col":"object_key"},{"tbl":"event_cover_masters","col":"mime_type"},{"tbl":"event_cover_masters","col":"byte_size"},{"tbl":"event_cover_masters","col":"width"},{"tbl":"event_cover_masters","col":"height"},{"tbl":"event_cover_masters","col":"sha256"},{"tbl":"event_cover_masters","col":"normalization_version"},{"tbl":"event_cover_masters","col":"normalization_rung"},{"tbl":"event_cover_masters","col":"auto_focus_x"},{"tbl":"event_cover_masters","col":"auto_focus_y"},{"tbl":"event_cover_masters","col":"composition_model_version"},{"tbl":"event_cover_masters","col":"created_at"},{"tbl":"event_cover_masters","col":"cleanup_after"},{"tbl":"event_cover_publish_receipts","col":"event_id"},{"tbl":"event_cover_publish_receipts","col":"operation_id"},{"tbl":"event_cover_publish_receipts","col":"draft_id"},{"tbl":"event_cover_publish_receipts","col":"render_set_id"},{"tbl":"event_cover_publish_receipts","col":"request_sha256"},{"tbl":"event_cover_publish_receipts","col":"action"},{"tbl":"event_cover_publish_receipts","col":"expected_revision"},{"tbl":"event_cover_publish_receipts","col":"status"},{"tbl":"event_cover_publish_receipts","col":"workflow_instance_id"},{"tbl":"event_cover_publish_receipts","col":"dependency_versions_json"},{"tbl":"event_cover_publish_receipts","col":"completed_profiles"},{"tbl":"event_cover_publish_receipts","col":"required_profiles"},{"tbl":"event_cover_publish_receipts","col":"applied_revision"},{"tbl":"event_cover_publish_receipts","col":"result_cover_json"},{"tbl":"event_cover_publish_receipts","col":"failure_code"},{"tbl":"event_cover_publish_receipts","col":"retryable"},{"tbl":"event_cover_publish_receipts","col":"dispatch_state"},{"tbl":"event_cover_publish_receipts","col":"dispatch_generation"},{"tbl":"event_cover_publish_receipts","col":"last_dispatch_at"},{"tbl":"event_cover_publish_receipts","col":"created_at"},{"tbl":"event_cover_publish_receipts","col":"updated_at"},{"tbl":"event_cover_publish_receipts","col":"expires_at"},{"tbl":"event_cover_purge_progress","col":"event_id"},{"tbl":"event_cover_purge_progress","col":"phase"},{"tbl":"event_cover_purge_progress","col":"workflow_binding"},{"tbl":"event_cover_purge_progress","col":"workflow_instance_id"},{"tbl":"event_cover_purge_progress","col":"fences_resolved"},{"tbl":"event_cover_purge_progress","col":"platform_mutations"},{"tbl":"event_cover_purge_progress","col":"created_at"},{"tbl":"event_cover_purge_progress","col":"updated_at"},{"tbl":"event_cover_rate_events","col":"id"},{"tbl":"event_cover_rate_events","col":"event_id"},{"tbl":"event_cover_rate_events","col":"action"},{"tbl":"event_cover_rate_events","col":"replay_key"},{"tbl":"event_cover_rate_events","col":"request_sha256"},{"tbl":"event_cover_rate_events","col":"window_start"},{"tbl":"event_cover_rate_events","col":"created_at"},{"tbl":"event_cover_rate_events","col":"expires_at"},{"tbl":"event_cover_render_objects","col":"id"},{"tbl":"event_cover_render_objects","col":"render_set_id"},{"tbl":"event_cover_render_objects","col":"event_id"},{"tbl":"event_cover_render_objects","col":"profile_id"},{"tbl":"event_cover_render_objects","col":"density"},{"tbl":"event_cover_render_objects","col":"format"},{"tbl":"event_cover_render_objects","col":"object_key"},{"tbl":"event_cover_render_objects","col":"content_type"},{"tbl":"event_cover_render_objects","col":"byte_size"},{"tbl":"event_cover_render_objects","col":"width"},{"tbl":"event_cover_render_objects","col":"height"},{"tbl":"event_cover_render_objects","col":"quality_rung"},{"tbl":"event_cover_render_objects","col":"sha256"},{"tbl":"event_cover_render_objects","col":"created_at"},{"tbl":"event_cover_render_sets","col":"id"},{"tbl":"event_cover_render_sets","col":"event_id"},{"tbl":"event_cover_render_sets","col":"master_id"},{"tbl":"event_cover_render_sets","col":"draft_id"},{"tbl":"event_cover_render_sets","col":"recipe_json"},{"tbl":"event_cover_render_sets","col":"recipe_sha256"},{"tbl":"event_cover_render_sets","col":"state"},{"tbl":"event_cover_render_sets","col":"required_slots"},{"tbl":"event_cover_render_sets","col":"manifest_sha256"},{"tbl":"event_cover_render_sets","col":"published_revision"},{"tbl":"event_cover_render_sets","col":"created_at"},{"tbl":"event_cover_render_sets","col":"ready_at"},{"tbl":"event_cover_render_sets","col":"published_at"},{"tbl":"event_cover_render_sets","col":"retired_at"},{"tbl":"event_cover_render_sets","col":"abandoned_reason"},{"tbl":"event_cover_render_sets","col":"abandoned_at"},{"tbl":"event_cover_render_sets","col":"cleanup_after"},{"tbl":"event_cover_retired_legacy_objects","col":"id"},{"tbl":"event_cover_retired_legacy_objects","col":"event_id"},{"tbl":"event_cover_retired_legacy_objects","col":"object_key"},{"tbl":"event_cover_retired_legacy_objects","col":"key_fingerprint"},{"tbl":"event_cover_retired_legacy_objects","col":"reason"},{"tbl":"event_cover_retired_legacy_objects","col":"retired_at"},{"tbl":"event_cover_retired_legacy_objects","col":"cleanup_after"},{"tbl":"event_cover_retired_legacy_objects","col":"deleted_at"},{"tbl":"event_cover_workflow_fences","col":"workflow_binding"},{"tbl":"event_cover_workflow_fences","col":"workflow_instance_id"},{"tbl":"event_cover_workflow_fences","col":"event_id"},{"tbl":"event_cover_workflow_fences","col":"dispatch_generation"},{"tbl":"event_cover_workflow_fences","col":"state"},{"tbl":"event_cover_workflow_fences","col":"created_at"},{"tbl":"event_cover_workflow_fences","col":"updated_at"},{"tbl":"event_cover_workflow_fences","col":"expires_at"}];

const coverForeignKeyRows = [{"tbl":"event_cover_backfill_jobs","parent":"events","col":"event_id","on_delete":"RESTRICT"},{"tbl":"event_cover_backfill_jobs","parent":"event_cover_masters","col":"master_id","on_delete":"RESTRICT"},{"tbl":"event_cover_backfill_jobs","parent":"event_cover_render_sets","col":"render_set_id","on_delete":"RESTRICT"},{"tbl":"event_cover_backfill_jobs","parent":"event_cover_backfill_runs","col":"run_id","on_delete":"RESTRICT"},{"tbl":"event_cover_draft_previews","parent":"event_cover_drafts","col":"draft_id","on_delete":"RESTRICT"},{"tbl":"event_cover_draft_previews","parent":"events","col":"event_id","on_delete":"RESTRICT"},{"tbl":"event_cover_drafts","parent":"events","col":"event_id","on_delete":"RESTRICT"},{"tbl":"event_cover_drafts","parent":"event_cover_masters","col":"master_id","on_delete":"RESTRICT"},{"tbl":"event_cover_masters","parent":"events","col":"event_id","on_delete":"RESTRICT"},{"tbl":"event_cover_publish_receipts","parent":"event_cover_drafts","col":"draft_id","on_delete":"RESTRICT"},{"tbl":"event_cover_publish_receipts","parent":"events","col":"event_id","on_delete":"RESTRICT"},{"tbl":"event_cover_publish_receipts","parent":"event_cover_render_sets","col":"render_set_id","on_delete":"RESTRICT"},{"tbl":"event_cover_purge_progress","parent":"events","col":"event_id","on_delete":"RESTRICT"},{"tbl":"event_cover_rate_events","parent":"events","col":"event_id","on_delete":"RESTRICT"},{"tbl":"event_cover_render_objects","parent":"events","col":"event_id","on_delete":"RESTRICT"},{"tbl":"event_cover_render_objects","parent":"event_cover_render_sets","col":"render_set_id","on_delete":"RESTRICT"},{"tbl":"event_cover_render_sets","parent":"event_cover_drafts","col":"draft_id","on_delete":"RESTRICT"},{"tbl":"event_cover_render_sets","parent":"events","col":"event_id","on_delete":"RESTRICT"},{"tbl":"event_cover_render_sets","parent":"event_cover_masters","col":"master_id","on_delete":"RESTRICT"},{"tbl":"event_cover_retired_legacy_objects","parent":"events","col":"event_id","on_delete":"RESTRICT"}];

const coverIndexRows = [{"tbl":"event_cover_backfill_jobs","idx":"event_cover_backfill_jobs_by_event","uniq":0,"partial":0},{"tbl":"event_cover_backfill_jobs","idx":"event_cover_backfill_jobs_run_event","uniq":1,"partial":0},{"tbl":"event_cover_backfill_jobs","idx":"event_cover_backfill_jobs_status","uniq":0,"partial":0},{"tbl":"event_cover_backfill_jobs","idx":"sqlite_autoindex_event_cover_backfill_jobs_1","uniq":1,"partial":0},{"tbl":"event_cover_backfill_jobs","idx":"sqlite_autoindex_event_cover_backfill_jobs_2","uniq":1,"partial":0},{"tbl":"event_cover_backfill_runs","idx":"sqlite_autoindex_event_cover_backfill_runs_1","uniq":1,"partial":0},{"tbl":"event_cover_draft_previews","idx":"event_cover_draft_previews_by_event","uniq":0,"partial":0},{"tbl":"event_cover_draft_previews","idx":"event_cover_draft_previews_tuple","uniq":1,"partial":0},{"tbl":"event_cover_draft_previews","idx":"sqlite_autoindex_event_cover_draft_previews_1","uniq":1,"partial":0},{"tbl":"event_cover_draft_previews","idx":"sqlite_autoindex_event_cover_draft_previews_2","uniq":1,"partial":0},{"tbl":"event_cover_drafts","idx":"event_cover_drafts_by_event_state","uniq":0,"partial":0},{"tbl":"event_cover_drafts","idx":"event_cover_drafts_expiry","uniq":0,"partial":0},{"tbl":"event_cover_drafts","idx":"event_cover_drafts_intent","uniq":1,"partial":0},{"tbl":"event_cover_drafts","idx":"event_cover_drafts_master","uniq":0,"partial":1},{"tbl":"event_cover_drafts","idx":"sqlite_autoindex_event_cover_drafts_1","uniq":1,"partial":0},{"tbl":"event_cover_drafts","idx":"sqlite_autoindex_event_cover_drafts_2","uniq":1,"partial":0},{"tbl":"event_cover_masters","idx":"event_cover_masters_by_event","uniq":0,"partial":0},{"tbl":"event_cover_masters","idx":"event_cover_masters_cleanup","uniq":0,"partial":1},{"tbl":"event_cover_masters","idx":"sqlite_autoindex_event_cover_masters_1","uniq":1,"partial":0},{"tbl":"event_cover_masters","idx":"sqlite_autoindex_event_cover_masters_2","uniq":1,"partial":0},{"tbl":"event_cover_publish_receipts","idx":"event_cover_receipts_by_draft","uniq":0,"partial":1},{"tbl":"event_cover_publish_receipts","idx":"event_cover_receipts_expiry","uniq":0,"partial":0},{"tbl":"event_cover_publish_receipts","idx":"event_cover_receipts_one_preparing_per_event","uniq":1,"partial":1},{"tbl":"event_cover_publish_receipts","idx":"sqlite_autoindex_event_cover_publish_receipts_1","uniq":1,"partial":0},{"tbl":"event_cover_publish_receipts","idx":"sqlite_autoindex_event_cover_publish_receipts_2","uniq":1,"partial":0},{"tbl":"event_cover_purge_progress","idx":"sqlite_autoindex_event_cover_purge_progress_1","uniq":1,"partial":0},{"tbl":"event_cover_rate_events","idx":"event_cover_rate_events_expiry","uniq":0,"partial":0},{"tbl":"event_cover_rate_events","idx":"event_cover_rate_events_replay","uniq":1,"partial":0},{"tbl":"event_cover_rate_events","idx":"event_cover_rate_events_window","uniq":0,"partial":0},{"tbl":"event_cover_rate_events","idx":"sqlite_autoindex_event_cover_rate_events_1","uniq":1,"partial":0},{"tbl":"event_cover_render_objects","idx":"event_cover_render_objects_by_event","uniq":0,"partial":0},{"tbl":"event_cover_render_objects","idx":"event_cover_render_objects_slot","uniq":1,"partial":0},{"tbl":"event_cover_render_objects","idx":"sqlite_autoindex_event_cover_render_objects_1","uniq":1,"partial":0},{"tbl":"event_cover_render_objects","idx":"sqlite_autoindex_event_cover_render_objects_2","uniq":1,"partial":0},{"tbl":"event_cover_render_sets","idx":"event_cover_render_sets_by_event_state","uniq":0,"partial":0},{"tbl":"event_cover_render_sets","idx":"event_cover_render_sets_cleanup","uniq":0,"partial":1},{"tbl":"event_cover_render_sets","idx":"event_cover_render_sets_one_active_per_event","uniq":1,"partial":1},{"tbl":"event_cover_render_sets","idx":"sqlite_autoindex_event_cover_render_sets_1","uniq":1,"partial":0},{"tbl":"event_cover_retired_legacy_objects","idx":"event_cover_retired_legacy_objects_by_event","uniq":0,"partial":0},{"tbl":"event_cover_retired_legacy_objects","idx":"event_cover_retired_legacy_objects_cleanup","uniq":0,"partial":1},{"tbl":"event_cover_retired_legacy_objects","idx":"sqlite_autoindex_event_cover_retired_legacy_objects_1","uniq":1,"partial":0},{"tbl":"event_cover_retired_legacy_objects","idx":"sqlite_autoindex_event_cover_retired_legacy_objects_2","uniq":1,"partial":0},{"tbl":"event_cover_workflow_fences","idx":"event_cover_workflow_fences_by_event","uniq":0,"partial":0},{"tbl":"event_cover_workflow_fences","idx":"event_cover_workflow_fences_expiry","uniq":0,"partial":0},{"tbl":"event_cover_workflow_fences","idx":"sqlite_autoindex_event_cover_workflow_fences_1","uniq":1,"partial":0}];

const partialUniqueRows = [{"name":"event_cover_receipts_one_preparing_per_event","sql":"CREATE UNIQUE INDEX event_cover_receipts_one_preparing_per_event\n  ON event_cover_publish_receipts (event_id)\n  WHERE status IN ('queued', 'rendering', 'finalizing')\n     OR (status = 'failed' AND retryable = 1)"},{"name":"event_cover_render_sets_one_active_per_event","sql":"CREATE UNIQUE INDEX event_cover_render_sets_one_active_per_event\n  ON event_cover_render_sets (event_id)\n  WHERE state = 'active'"}];

const triggerRows = migrationFileNames.flatMap((name) => {
  const source = readFileSync(join(process.cwd(), 'migrations', name), 'utf8');
  return [...source.matchAll(/CREATE TRIGGER\s+([a-z0-9_]+)[\s\S]*?\nEND;/gu)].map((match) => ({
    name: match[1]!,
    // sqlite_master keeps the CREATE statement but omits the trailing semicolon.
    sql: match[0].slice(0, -1),
  }));
}).sort((left, right) => left.name.localeCompare(right.name));

const promotionMigrationSql = readFileSync(
  join(process.cwd(), 'migrations', '0015_curated_private_guestbook.sql'),
  'utf8',
);
const promotionTableMatch = promotionMigrationSql.match(
  /CREATE TABLE media_object_promotions \([\s\S]*?\n\);/u,
);
if (promotionTableMatch === null) throw new Error('Fixture is missing media_object_promotions SQL.');
const promotionTableRows = [{
  name: 'media_object_promotions',
  // sqlite_master keeps the CREATE statement but omits the trailing semicolon.
  sql: promotionTableMatch[0].slice(0, -1),
}];


const rosterColumnNames = [
  'event_id', 'idempotency_key', 'request_digest', 'receipt_json', 'created_at',
];

const certificationColumnNames = [
  'worker_version_id', 'build_sha', 'guest_journey_version',
  'migration_manifest_sha256', 'evidence_manifest_sha256',
  'physical_evidence_refs_json', 'certified_at',
];

const guestbookTableRows = [
  { name: 'export_guestbook_entries' },
  { name: 'export_media_entries' },
  { name: 'guest_message_purge_receipts' },
  { name: 'guest_message_rate_events' },
  { name: 'legacy_media_scan_quarantine' },
  { name: 'legacy_media_scan_state' },
  { name: 'media_object_promotions' },
  { name: 'media_object_write_tombstones' },
];

const guestbookColumns: Record<string, string[]> = {
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
  ],
  export_media_entries: [
    'export_job_id', 'media_id', 'object_key', 'object_bucket_generation', 'original_filename',
    'mime_type', 'declared_byte_size', 'byte_size', 'width', 'height', 'guest_name', 'caption',
    'publication_status', 'created_at', 'published_at',
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

const guestbookColumnRows = Object.entries(guestbookColumns).flatMap(([tbl, names]) =>
  names.map((col, cid) => ({ tbl, cid, col })),
);

const guestbookForeignKeyRows = [
  { tbl: 'export_guestbook_entries', parent: 'export_jobs', col: 'export_job_id', on_delete: 'CASCADE' },
  { tbl: 'export_media_entries', parent: 'export_jobs', col: 'export_job_id', on_delete: 'CASCADE' },
  { tbl: 'guest_message_purge_receipts', parent: 'events', col: 'event_id', on_delete: 'CASCADE' },
  { tbl: 'guest_message_rate_events', parent: 'events', col: 'event_id', on_delete: 'CASCADE' },
  { tbl: 'media_object_promotions', parent: 'events', col: 'event_id', on_delete: 'RESTRICT' },
  { tbl: 'media_object_promotions', parent: 'media', col: 'media_id', on_delete: 'RESTRICT' },
];

const guestbookIndexRows = [
  { tbl: 'export_guestbook_entries', idx: 'guestbook_export_render_order', uniq: 0, partial: 0 },
  { tbl: 'export_guestbook_entries', idx: 'sqlite_autoindex_export_guestbook_entries_1', uniq: 1, partial: 0 },
  { tbl: 'export_jobs', idx: 'export_jobs_expiry', uniq: 0, partial: 0 },
  { tbl: 'export_jobs', idx: 'export_jobs_one_active_per_event', uniq: 1, partial: 1 },
  { tbl: 'export_jobs', idx: 'sqlite_autoindex_export_jobs_1', uniq: 1, partial: 0 },
  { tbl: 'export_media_entries', idx: 'export_media_entries_order', uniq: 0, partial: 0 },
  { tbl: 'export_media_entries', idx: 'sqlite_autoindex_export_media_entries_1', uniq: 1, partial: 0 },
  { tbl: 'guest_message_purge_receipts', idx: 'sqlite_autoindex_guest_message_purge_receipts_1', uniq: 1, partial: 0 },
  { tbl: 'guest_message_rate_events', idx: 'guestbook_rate_event_ip_window', uniq: 0, partial: 0 },
  { tbl: 'guest_message_rate_events', idx: 'guestbook_rate_event_session_window', uniq: 0, partial: 0 },
  { tbl: 'guest_message_rate_events', idx: 'sqlite_autoindex_guest_message_rate_events_1', uniq: 1, partial: 0 },
  { tbl: 'guest_messages', idx: 'guest_messages_event_status', uniq: 0, partial: 0 },
  { tbl: 'guest_messages', idx: 'guest_messages_session_idempotency', uniq: 1, partial: 0 },
  { tbl: 'guest_messages', idx: 'guestbook_notes_event_feed', uniq: 0, partial: 0 },
  { tbl: 'guest_messages', idx: 'guestbook_notes_event_owner', uniq: 0, partial: 0 },
  { tbl: 'guest_messages', idx: 'sqlite_autoindex_guest_messages_1', uniq: 1, partial: 0 },
  { tbl: 'legacy_media_scan_quarantine', idx: 'sqlite_autoindex_legacy_media_scan_quarantine_1', uniq: 1, partial: 0 },
  { tbl: 'media_object_promotions', idx: 'media_object_promotions_event_state', uniq: 0, partial: 0 },
  { tbl: 'media_object_promotions', idx: 'media_object_promotions_schedule', uniq: 0, partial: 0 },
  { tbl: 'media_object_promotions', idx: 'sqlite_autoindex_media_object_promotions_1', uniq: 1, partial: 0 },
  { tbl: 'media_object_promotions', idx: 'sqlite_autoindex_media_object_promotions_2', uniq: 1, partial: 0 },
  { tbl: 'media_object_write_tombstones', idx: 'media_object_write_tombstones_event', uniq: 0, partial: 0 },
  { tbl: 'media_object_write_tombstones', idx: 'media_object_write_tombstones_schedule', uniq: 0, partial: 0 },
  { tbl: 'media_object_write_tombstones', idx: 'sqlite_autoindex_media_object_write_tombstones_1', uniq: 1, partial: 0 },
];

const guestbookSchemaRows = [
  { name: 'events', checks: '1' },
  { name: 'export_guestbook_entries', checks: '1|1|1|1|1|1|1|1' },
  { name: 'export_jobs', checks: '1|1|1|1|1|1' },
  { name: 'export_media_entries', checks: '1|1|1|1|1|1' },
  { name: 'guest_message_purge_receipts', checks: '1' },
  { name: 'guest_message_rate_events', checks: '' },
  { name: 'legacy_media_scan_quarantine', checks: '1|1' },
  { name: 'legacy_media_scan_state', checks: '1|1|1|1|1|1|1|1|1' },
  { name: 'media', checks: '1' },
  { name: 'media_object_promotions', checks: '1|1|1|1|1|1|1|1|1|1|1|1|1|1|1|1|1|1|1|1|1|1|1' },
  { name: 'media_object_write_tombstones', checks: '1|1|1|1|1|1|1' },
];

type ColumnRow = {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

function columns(names: string[]): ColumnRow[] {
  return names.map((name, cid) => ({
    cid,
    name,
    type: 'TEXT',
    notnull: 0,
    dflt_value: null,
    pk: 0,
  }));
}

function terminalRows() {
  const events = columns(eventColumnNames);
  Object.assign(events[18]!, { type: 'INTEGER', notnull: 1, dflt_value: '0', pk: 0 });
  Object.assign(events[24]!, {
    type: 'TEXT', notnull: 1, dflt_value: "'1970-01-01T00:00:00.000Z'", pk: 0,
  });
  Object.assign(events[25]!, { type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 });
  Object.assign(events[26]!, {
    type: 'TEXT', notnull: 1, dflt_value: coverConfigDefault, pk: 0,
  });
  Object.assign(events[27]!, { type: 'INTEGER', notnull: 1, dflt_value: '0', pk: 0 });
  Object.assign(events[28]!, { type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 });
  Object.assign(events[29]!, {
    type: 'TEXT', notnull: 1,
    dflt_value: "'Share a wish, memory, or moment from the day.'", pk: 0,
  });

  const roster = columns(rosterColumnNames);
  Object.assign(roster[0]!, { type: 'TEXT', notnull: 1, dflt_value: null, pk: 1 });
  Object.assign(roster[1]!, { type: 'TEXT', notnull: 1, dflt_value: null, pk: 2 });
  for (const row of roster.slice(2)) Object.assign(row, { type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 });

  const certifications = columns(certificationColumnNames);
  for (const row of certifications) Object.assign(row, { notnull: 1, dflt_value: null, pk: 0 });
  Object.assign(certifications[0]!, { type: 'TEXT', pk: 1 });
  Object.assign(certifications[2]!, { type: 'INTEGER' });
  return { events, roster, certifications };
}

function resultEnvelope(results: unknown[]) {
  return { results, success: true, meta: { duration: 0.01 } };
}

function invariantOutput(ledgerNames: string[]): unknown[] {
  const terminal = terminalRows();
  return [
    resultEnvelope(ledgerNames.map((name, index) => ({ id: index + 1, name }))),
    resultEnvelope([]),
    resultEnvelope([{ quick_check: 'ok' }]),
    resultEnvelope(terminal.events),
    resultEnvelope(terminal.roster),
    resultEnvelope(terminal.certifications),
    resultEnvelope(structuredClone(coverTableRows)),
    resultEnvelope(structuredClone(coverColumnRows)),
    resultEnvelope(structuredClone(coverForeignKeyRows)),
    resultEnvelope(structuredClone(coverIndexRows)),
    resultEnvelope(structuredClone(partialUniqueRows)),
    resultEnvelope(structuredClone(triggerRows)),
    resultEnvelope(structuredClone(guestbookTableRows)),
    resultEnvelope(structuredClone(guestbookColumnRows)),
    resultEnvelope(structuredClone(guestbookForeignKeyRows)),
    resultEnvelope(structuredClone(guestbookIndexRows)),
    resultEnvelope(structuredClone(guestbookSchemaRows)),
    resultEnvelope(structuredClone(promotionTableRows)),
  ];
}

interface Fixture {
  candidateRoot: string;
  runRoot: string;
  reportFile: string;
  wranglerCliPath: string;
  ledgerNames: string[];
  output: string;
}

async function fixture(): Promise<Fixture> {
  const candidateRoot = await temporaryDirectory('candidary-candidate-test-');
  for (const [index, name] of migrationFileNames.entries()) {
    await put(candidateRoot, `migrations/${name}`, `select ${index + 1};\n`);
  }
  const wranglerCliPath = await put(candidateRoot, 'node_modules/wrangler/bin/wrangler.js');
  const runRoot = await temporaryDirectory('candidary-release-');
  const reportFile = join(runRoot, 'migration-verification.json');
  const ledgerNames = collectMigrationManifest(candidateRoot).files.map((file) => file.path.split('/').at(-1)!);
  return {
    candidateRoot,
    runRoot,
    reportFile,
    wranglerCliPath,
    ledgerNames,
    output: JSON.stringify(invariantOutput(ledgerNames)),
  };
}

function successfulAdapters(output: string) {
  const commands: FreshD1Command[] = [];
  const integrityPaths: string[] = [];
  const adapters: FreshD1Adapters = {
    nodeExecPath: process.execPath,
    run(command) {
      commands.push(command);
      return { exitCode: 0, stdout: command.id === 'invariants' ? output : '' };
    },
    checkFullIntegrity(freshD1) {
      integrityPaths.push(freshD1);
      return 'ok';
    },
  };
  return { adapters, commands, integrityPaths };
}

describe('fresh local D1 verification', () => {
  it('withholds deployment credentials from standalone local Wrangler commands', () => {
    const environment = freshD1ProcessEnvironment({
      PATH: 'tools',
      TEMP: 'temp',
      CLOUDFLARE_API_TOKEN: 'remote-token',
      CLOUDFLARE_ACCOUNT_ID: 'remote-account',
      R2_SECRET_ACCESS_KEY: 'r2-secret',
      CANDIDARY_UNRELATED: 'drop-me',
    }, { CI: '1' });

    expect(environment).toMatchObject({
      PATH: 'tools',
      TEMP: 'temp',
      CI: '1',
      WRANGLER_SEND_METRICS: 'false',
    });
    expect(environment).not.toHaveProperty('CLOUDFLARE_API_TOKEN');
    expect(environment).not.toHaveProperty('CLOUDFLARE_ACCOUNT_ID');
    expect(environment).not.toHaveProperty('R2_SECRET_ACCESS_KEY');
    expect(environment).not.toHaveProperty('CANDIDARY_UNRELATED');
  });

  it('accepts only an exact absent report under a real prefixed OS-temp root', async () => {
    const valid = await fixture();
    expect(parseFreshD1Args([
      '--run-root', valid.runRoot, '--report-file', valid.reportFile,
    ])).toEqual({ runRoot: valid.runRoot, reportFile: valid.reportFile });

    expect(() => parseFreshD1Args([])).toThrow();
    expect(() => parseFreshD1Args([
      '--run-root', 'relative', '--report-file', 'migration-verification.json',
    ])).toThrow();
    expect(() => parseFreshD1Args([
      '--run-root', process.cwd(),
      '--report-file', join(process.cwd(), 'migration-verification.json'),
    ])).toThrow();
    const missing = join(tmpdir(), `candidary-release-missing-${randomUUID()}`);
    expect(() => parseFreshD1Args([
      '--run-root', missing, '--report-file', join(missing, 'migration-verification.json'),
    ])).toThrow();

    const wrongPrefix = await temporaryDirectory('another-release-');
    expect(() => parseFreshD1Args([
      '--run-root', wrongPrefix, '--report-file', join(wrongPrefix, 'migration-verification.json'),
    ])).toThrow();

    expect(() => parseFreshD1Args([
      '--run-root', valid.runRoot, '--report-file', join(valid.runRoot, 'other.json'),
    ])).toThrow();
    expect(() => parseFreshD1Args([
      '--run-root', valid.runRoot, '--report-file', join(valid.runRoot, 'nested', 'migration-verification.json'),
    ])).toThrow();

    await writeFile(valid.reportFile, '{}\n', 'utf8');
    expect(() => parseFreshD1Args([
      '--run-root', valid.runRoot, '--report-file', valid.reportFile,
    ])).toThrow();
  });

  it('rejects linked roots and a pre-existing fresh-d1 child', async () => {
    const target = await temporaryDirectory('candidary-release-target-');
    const linkedRoot = join(tmpdir(), `candidary-release-link-${randomUUID()}`);
    roots.push(linkedRoot);
    await symlink(target, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => parseFreshD1Args([
      '--run-root', linkedRoot,
      '--report-file', join(linkedRoot, 'migration-verification.json'),
    ])).toThrow();

    const existing = await fixture();
    await mkdir(join(existing.runRoot, 'fresh-d1'));
    const run = successfulAdapters(existing.output);
    expect(() => runFreshD1Verification(existing, run.adapters)).toThrow();
    expect(run.commands).toHaveLength(0);
    await expect(lstat(existing.reportFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('constructs and defends the exact local-only Wrangler command plan', async () => {
    const candidate = await fixture();
    const freshD1 = join(candidate.runRoot, 'fresh-d1');
    const input = {
      candidateRoot: candidate.candidateRoot,
      freshD1,
      nodeExecPath: process.execPath,
      wranglerCliPath: candidate.wranglerCliPath,
    };
    const plan = buildFreshD1CommandPlan(input);
    expect(() => assertFreshD1CommandPlan(plan, input)).not.toThrow();
    expect(plan).toEqual([
      {
        id: 'apply', executable: process.execPath, cwd: candidate.candidateRoot, shell: false,
        captureStdout: false, env: { CI: '1' },
        args: [candidate.wranglerCliPath, 'd1', 'migrations', 'apply', 'DB', '--config',
          'wrangler.jsonc', '--local', '--persist-to', freshD1],
      },
      {
        id: 'invariants', executable: process.execPath, cwd: candidate.candidateRoot, shell: false,
        captureStdout: true, env: { CI: '1' },
        args: [candidate.wranglerCliPath, 'd1', 'execute', 'DB', '--config', 'wrangler.jsonc',
          '--local', '--persist-to', freshD1, '--json', '--command', READ_ONLY_INVARIANT_QUERY],
      },
    ]);
    expect(JSON.stringify(plan)).not.toMatch(/\.cmd|\bnpx\b|--remote/iu);
    expect(READ_ONLY_INVARIANT_QUERY).toContain('PRAGMA quick_check;');
    expect(READ_ONLY_INVARIANT_QUERY).not.toContain('PRAGMA integrity_check;');

    const mutations = [
      (value: FreshD1Command[]) => value[0]!.args.splice(value[0]!.args.indexOf('--local'), 1),
      (value: FreshD1Command[]) => value[1]!.args.push('--remote'),
      (value: FreshD1Command[]) => { value[1]!.args[value[1]!.args.length - 1] = 'DELETE FROM events;'; },
      (value: FreshD1Command[]) => { value[1]!.args[3] = 'OTHER'; },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(plan);
      mutate(changed);
      expect(() => assertFreshD1CommandPlan(changed, input)).toThrow();
    }
  });

  it('parses one deterministic Wrangler envelope and hashes only the ordered ledger names', async () => {
    const candidate = await fixture();
    const parsed = parseWranglerInvariantOutput(candidate.output, candidate.ledgerNames);
    const expected: MigrationVerification = {
      migrationCount: migrationFileNames.length,
      ledgerSha256: sha256(canonicalJson(candidate.ledgerNames)),
      foreignKeyRows: 0,
      integrity: 'ok',
      terminalSchema: {
        events: true,
        rosterBatchReceipts: true,
        releaseCertifications: true,
      },
    };
    expect(parsed).toEqual(expected);
    expect(parsed.ledgerSha256).not.toBe(collectMigrationManifest(candidate.candidateRoot).sha256);

    expect(() => parseWranglerInvariantOutput('{', candidate.ledgerNames)).toThrow();
    expect(() => parseWranglerInvariantOutput('{}', candidate.ledgerNames)).toThrow();
    const unsuccessful = invariantOutput(candidate.ledgerNames);
    (unsuccessful[0] as { success: boolean }).success = false;
    expect(() => parseWranglerInvariantOutput(JSON.stringify(unsuccessful), candidate.ledgerNames)).toThrow();
  });

  it('fails closed on ledger, foreign-key, integrity, or terminal-schema drift', async () => {
    const candidate = await fixture();
    const mutations: Array<(output: unknown[]) => void> = [
      (output) => { (output[0] as { results: Array<{ name: string }> }).results[1]!.name = '0003_wrong.sql'; },
      (output) => { (output[0] as { results: Array<{ id: number }> }).results[0]!.id = 7; },
      (output) => { (output[1] as { results: unknown[] }).results.push({ table: 'events' }); },
      (output) => { (output[2] as { results: Array<{ quick_check: string }> }).results[0]!.quick_check = 'corrupt'; },
      (output) => { (output[3] as { results: ColumnRow[] }).results.pop(); },
      (output) => { (output[3] as { results: ColumnRow[] }).results[24]!.notnull = 0; },
      (output) => { (output[4] as { results: ColumnRow[] }).results[1]!.pk = 0; },
      (output) => { (output[5] as { results: ColumnRow[] }).results[2]!.type = 'TEXT'; },
      (output) => { (output[5] as { results: ColumnRow[] }).results.push({
        cid: 7, name: 'unexpected', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0,
      }); },
      // The stored `none` literal drifting is a silent data-shape change: every
      // row created afterwards would read as an unparseable cover config.
      (output) => { (output[3] as { results: ColumnRow[] }).results[26]!.dflt_value = "'{}'"; },
      // The Guestbook prompt is persisted event metadata and must retain its
      // non-null approved default on a fresh post-cutover database.
      (output) => { (output[3] as { results: ColumnRow[] }).results[29]!.dflt_value = "'Changed'"; },
      // A cover table missing, and one that should not exist.
      (output) => { (output[6] as { results: unknown[] }).results.pop(); },
      (output) => { (output[6] as { results: unknown[] }).results.push({ name: 'event_cover_extra' }); },
      // A column dropped from a cover table.
      (output) => { (output[7] as { results: unknown[] }).results.pop(); },
      // The RESTRICT inversion reverting. `PRAGMA foreign_key_check` would still
      // pass here; only reading the clause itself catches it.
      (output) => {
        (output[8] as { results: Array<{ on_delete: string }> }).results[0]!.on_delete = 'CASCADE';
      },
      // A partial unique index silently dropped by a hand-edited migration.
      (output) => {
        const results = (output[9] as { results: Array<{ idx: string }> }).results;
        const index = results.findIndex((row) => row.idx === 'event_cover_render_sets_one_active_per_event');
        results.splice(index, 1);
      },
      // The predicate drifting rather than the index disappearing: dropping the
      // retryable arm reopens duplicate preparing receipts, and `index_list`
      // still reports unique=1 partial=1.
      (output) => {
        const results = (output[10] as { results: Array<{ name: string; sql: string }> }).results;
        const row = results.find((entry) => entry.name === 'event_cover_receipts_one_preparing_per_event')!;
        row.sql = row.sql.replace("\n     OR (status = 'failed' AND retryable = 1)", '');
      },
      // A trigger body drift is rejected even when its name remains exact.
      (output) => {
        const results = (output[11] as { results: Array<{ name: string; sql: string }> }).results;
        results[0]!.sql = results[0]!.sql.replace('BEFORE DELETE', 'AFTER DELETE');
      },
    ];
    for (const mutate of mutations) {
      const output = structuredClone(invariantOutput(candidate.ledgerNames));
      mutate(output);
      expect(() => parseWranglerInvariantOutput(JSON.stringify(output), candidate.ledgerNames)).toThrow();
    }
  });

  it('refuses a candidate whose ledger is not exactly fifteen migrations', async () => {
    const candidate = await fixture();
    const fourteen = candidate.ledgerNames.slice(0, -1);
    const output = invariantOutput(candidate.ledgerNames) as Array<{ results: unknown[] }>;
    output[0]!.results = fourteen.map((name, index) => ({ id: index + 1, name }));
    expect(() => parseWranglerInvariantOutput(JSON.stringify(output), fourteen)).toThrow();
  });

  it('fails closed on any post-cutover Guestbook schema inventory drift', async () => {
    const candidate = await fixture();
    const mutations: Array<(output: unknown[]) => void> = [
      (output) => { (output[12] as { results: unknown[] }).results.pop(); },
      (output) => {
        const rows = (output[13] as { results: Array<{ tbl: string; col: string }> }).results;
        rows.splice(rows.findIndex((row) => row.tbl === 'export_jobs' && row.col === 'guestbook_prompt'), 1);
      },
      (output) => {
        const rows = (output[13] as { results: Array<{ tbl: string; col: string }> }).results;
        rows.find((row) => row.tbl === 'export_media_entries' && row.col === 'publication_status')!.col = 'status';
      },
      (output) => {
        const rows = (output[14] as { results: Array<{ on_delete: string }> }).results;
        rows[0]!.on_delete = 'RESTRICT';
      },
      (output) => {
        const rows = (output[15] as { results: Array<{ idx: string }> }).results;
        rows.splice(rows.findIndex((row) => row.idx === 'guestbook_notes_event_feed'), 1);
      },
      (output) => {
        const rows = (output[16] as { results: Array<{ name: string; checks: string }> }).results;
        const row = rows.find((entry) => entry.name === 'export_jobs')!;
        row.checks = row.checks.replace('1|1|1', '1|0|1');
      },
      (output) => {
        const rows = (output[13] as { results: Array<{ tbl: string; col: string }> }).results;
        rows.splice(rows.findIndex((row) => row.tbl === 'media_object_promotions'
          && row.col === 'source_writable_until'), 1);
      },
      (output) => {
        const rows = (output[14] as { results: Array<{ tbl: string; col: string; on_delete: string }> }).results;
        rows.find((row) => row.tbl === 'media_object_promotions' && row.col === 'media_id')!
          .on_delete = 'CASCADE';
      },
      (output) => {
        const rows = (output[15] as { results: Array<{ idx: string }> }).results;
        rows.splice(rows.findIndex((row) => row.idx === 'media_object_promotions_schedule'), 1);
      },
      (output) => {
        const rows = (output[16] as { results: Array<{ name: string; checks: string }> }).results;
        rows.find((row) => row.name === 'media_object_promotions')!.checks =
          '1|1|1|1|1|1|1|1|1|1|1|1|1|1|0';
      },
      (output) => {
        const rows = (output[17] as { results: Array<{ sql: string }> }).results;
        rows[0]!.sql = rows[0]!.sql.replace(
          'source_writable_until TEXT NOT NULL',
          'source_writable_until TEXT',
        );
      },
    ];
    for (const mutate of mutations) {
      const output = structuredClone(invariantOutput(candidate.ledgerNames));
      mutate(output);
      expect(() => parseWranglerInvariantOutput(JSON.stringify(output), candidate.ledgerNames)).toThrow();
    }
  });

  it('fails closed when the 0015 events Guestbook prompt CHECK expression drifts', async () => {
    const candidate = await fixture();
    const output = structuredClone(invariantOutput(candidate.ledgerNames));
    const rows = (output[16] as { results: Array<{ name: string; checks: string }> }).results;
    const events = rows.find((row) => row.name === 'events')!;

    expect(() => parseWranglerInvariantOutput(
      JSON.stringify(output),
      candidate.ledgerNames,
    )).not.toThrow();

    events.checks = '0';
    expect(() => parseWranglerInvariantOutput(
      JSON.stringify(output),
      candidate.ledgerNames,
    )).toThrow(/events CHECK inventory has drifted/u);
  });

  it('pins both migration-window promotion trigger bodies by digest', async () => {
    const candidate = await fixture();
    for (const name of [
      'media_object_promotion_inventory_insert',
      'media_object_promotion_inventory_update',
    ]) {
      const output = structuredClone(invariantOutput(candidate.ledgerNames));
      const rows = (output[11] as { results: Array<{ name: string; sql: string }> }).results;
      const trigger = rows.find((row) => row.name === name)!;
      trigger.sql = trigger.sql.replace(
        'updated_at = excluded.updated_at',
        'updated_at = excluded.created_at',
      );
      expect(() => parseWranglerInvariantOutput(
        JSON.stringify(output),
        candidate.ledgerNames,
      )).toThrow(/trigger body/iu);
    }
  });

  it('keeps the reported terminal schema at exactly three keys', async () => {
    const candidate = await fixture();
    const parsed = parseWranglerInvariantOutput(candidate.output, candidate.ledgerNames);
    // The cover assertions are internal and throw; widening this shape would
    // move `CANDIDATE_MANIFEST_SCHEMA_VERSION` and break four other suites.
    expect(Object.keys(parsed.terminalSchema).sort())
      .toEqual(['events', 'releaseCertifications', 'rosterBatchReceipts']);
  });

  it('writes one canonical schema-valid report only after both commands pass', async () => {
    const candidate = await fixture();
    const run = successfulAdapters(candidate.output);
    const report = runFreshD1Verification(candidate, run.adapters);

    expect(run.commands.map((command) => command.id)).toEqual(['apply', 'invariants']);
    expect(run.commands.every((command) => command.executable === process.execPath
      && command.cwd === candidate.candidateRoot && command.shell === false
      && command.env.CI === '1')).toBe(true);
    expect(run.integrityPaths).toEqual([join(candidate.runRoot, 'fresh-d1')]);
    expect(await readFile(candidate.reportFile, 'utf8')).toBe(`${canonicalJson(report)}\n`);
    expect(report).toEqual(parseWranglerInvariantOutput(candidate.output, candidate.ledgerNames));
    expect((await readdir(candidate.runRoot)).sort()).toEqual(['fresh-d1', 'migration-verification.json']);
  });

  it('leaves the final report absent after any command, parser, or invariant failure', async () => {
    for (const failure of ['apply', 'json', 'invariant', 'full-integrity'] as const) {
      const candidate = await fixture();
      const commands: FreshD1Command[] = [];
      const adapters: FreshD1Adapters = {
        nodeExecPath: process.execPath,
        run(command) {
          commands.push(command);
          if (failure === 'apply' && command.id === 'apply') return { exitCode: 1, stdout: '' };
          if (command.id === 'invariants') {
            if (failure === 'json') return { exitCode: 0, stdout: '{' };
            if (failure === 'invariant') {
              const output = invariantOutput(candidate.ledgerNames);
              (output[1] as { results: unknown[] }).results.push({ table: 'events' });
              return { exitCode: 0, stdout: JSON.stringify(output) };
            }
          }
          return { exitCode: 0, stdout: '' };
        },
        checkFullIntegrity() {
          return failure === 'full-integrity' ? 'corrupt' : 'ok';
        },
      };
      expect(() => runFreshD1Verification(candidate, adapters)).toThrow();
      await expect(lstat(candidate.reportFile)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(commands.map((command) => command.id)).toEqual(
        failure === 'apply' ? ['apply'] : ['apply', 'invariants'],
      );
    }
  });
});

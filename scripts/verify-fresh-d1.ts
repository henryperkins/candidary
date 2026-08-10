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

import type * as ReleaseEvidenceModule from './release-evidence';
import type { MigrationVerification } from './release-evidence';

const releaseEvidenceModulePath = './release-evidence.ts';
const releaseEvidence: typeof ReleaseEvidenceModule = await import(releaseEvidenceModulePath);
const { canonicalJson, collectMigrationManifest, sha256 } = releaseEvidence;

// `String.raw` so the SQL keeps its literal backslashes: `\_` is a literal
// underscore to SQLite's LIKE, and an ordinary escape sequence to JavaScript.
const COVER_TABLES = String.raw`name LIKE 'event\_cover\_%' ESCAPE '\'`;

/**
 * Read-only, and appended to rather than reordered.
 *
 * The six original statements keep their positions because the unit fixture
 * patches `events` rows by ordinal index, and this string is compared
 * byte-for-byte in three places. Everything the cover schema adds is a new
 * statement at the end.
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
SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name;`;

const INVARIANT_STATEMENT_COUNT = 12;

/**
 * Pinned, not derived.
 *
 * The ledger comparison alone cannot prove a phase-3 migration is absent: it
 * derives its expectation from `collectMigrationManifest(candidateRoot)`, so a
 * file that is not checked in is never seen, and a correctly numbered extra file
 * that *is* checked in would simply be accepted as the next entry.
 *
 * Thirteen since `main` merged into the cover line: `0013_guest_message_hardening.sql`
 * is a guest-message column and index, unrelated to covers. It is deliberately
 * **not** the phase-3 invariants migration, which is now `0014`. Raising this
 * number does not disarm the phase-3 tripwire, because `EXPECTED_TRIGGERS` below
 * is what actually distinguishes that state and `0013` adds no trigger. The
 * phase-3 candidate updates this number and the trigger set together; one
 * candidate never claims both states.
 */
const EXPECTED_MIGRATION_COUNT = 13;

/** Exactly the triggers that existed before 0012. 0013's are not among them. */
const EXPECTED_TRIGGERS = [
  'events_rsvp_deadline_insert',
  'events_rsvp_deadline_update',
  'media_stamp_stored_at_compat',
];

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

function assertTriggers(values: unknown[]): void {
  assertExactList(
    values.map((value, index) => textField(value, ['name'], `Trigger ${index + 1}`).name!),
    EXPECTED_TRIGGERS,
    'Trigger set',
  );
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

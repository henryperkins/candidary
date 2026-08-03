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

export const READ_ONLY_INVARIANT_QUERY = `SELECT id, name FROM d1_migrations ORDER BY id;
PRAGMA foreign_key_check;
PRAGMA quick_check;
SELECT cid, name, type, "notnull", dflt_value, pk
  FROM pragma_table_info('events') ORDER BY cid;
SELECT cid, name, type, "notnull", dflt_value, pk
  FROM pragma_table_info('rsvp_roster_batch_receipts') ORDER BY cid;
SELECT cid, name, type, "notnull", dflt_value, pk
  FROM pragma_table_info('release_certifications') ORDER BY cid;`;

const EXPECTED_COLUMN_NAMES = {
  events: [
    'id', 'slug', 'name', 'event_date', 'welcome_message', 'cover_object_key',
    'uploads_enabled', 'gallery_visible', 'moderation_required',
    'reserved_media_count', 'stored_media_count', 'reserved_bytes', 'stored_bytes',
    'guest_access_expires_at', 'management_access_expires_at', 'purge_after',
    'created_at', 'deleted_at', 'legacy_owner_claim_open', 'theme_config',
    'event_timezone', 'rsvp_enabled', 'rsvp_deadline_at', 'rsvp_roster_version',
    'event_start_at', 'photos_open_from',
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
  if (!Array.isArray(parsed) || parsed.length !== 6) {
    throw new TypeError('Wrangler invariant output must contain six exact results.');
  }
  if (expectedLedgerNames.length === 0
    || expectedLedgerNames.some((name) => !/^\d{4}_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/u.test(name))) {
    throw new TypeError('Expected migration ledger is invalid.');
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

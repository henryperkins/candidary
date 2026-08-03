import { randomUUID } from 'node:crypto';
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
} from '../../scripts/release-evidence';
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
];

const rosterColumnNames = [
  'event_id', 'idempotency_key', 'request_digest', 'receipt_json', 'created_at',
];

const certificationColumnNames = [
  'worker_version_id', 'build_sha', 'guest_journey_version',
  'migration_manifest_sha256', 'evidence_manifest_sha256',
  'physical_evidence_refs_json', 'certified_at',
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
  await put(candidateRoot, 'migrations/0001_core.sql', 'select 1;\n');
  await put(candidateRoot, 'migrations/0002_added.sql', 'select 2;\n');
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
      migrationCount: 2,
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
    ];
    for (const mutate of mutations) {
      const output = structuredClone(invariantOutput(candidate.ledgerNames));
      mutate(output);
      expect(() => parseWranglerInvariantOutput(JSON.stringify(output), candidate.ledgerNames)).toThrow();
    }
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

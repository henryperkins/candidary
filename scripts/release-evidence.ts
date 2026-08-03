import { createHash } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

export interface HashedFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface MigrationManifest {
  files: HashedFile[];
  sha256: string;
}

export interface MigrationVerification {
  migrationCount: number;
  ledgerSha256: string;
  foreignKeyRows: 0;
  integrity: 'ok';
  terminalSchema: {
    events: true;
    rosterBatchReceipts: true;
    releaseCertifications: true;
  };
}

export interface TestCounts {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
}

export interface BindingTopology {
  compatibilityDate: string;
  compatibilityFlags: string[];
  workersDev: boolean;
  assets: {
    binding: string;
    notFoundHandling: string;
    runWorkerFirst: string[];
  };
  bindings: {
    d1: string[];
    r2: string[];
    images: string[];
    sendEmail: string[];
    versionMetadata: string | null;
  };
  requiredSecrets: string[];
  variableNames: string[];
  workflows: Array<{ binding: string; className: string }>;
  rateLimits: Array<{ name: string; limit: number; period: number }>;
  crons: string[];
  migrationDirectories: string[];
  observabilityEnabled: boolean;
}

export interface ToolVersions {
  node: string | null;
  npm: string | null;
  git: string | null;
  typescript: string | null;
  eslint: string | null;
  vite: string | null;
  vitest: string | null;
  playwright: string | null;
  wrangler: string | null;
}

export type ReleaseCommandId =
  | 'npm-ci'
  | 'verify-bindings'
  | 'typecheck'
  | 'typecheck-e2e'
  | 'lint'
  | 'unit-ui'
  | 'worker'
  | 'build'
  | 'pwa-before-e2e'
  | 'playwright'
  | 'pwa-after-e2e'
  | 'wrangler-dry-run'
  | 'fresh-d1'
  | 'diff-check';

export type ReleaseFailureCode =
  | 'precondition_failed'
  | `command_failed:${ReleaseCommandId}`
  | 'evidence_invalid'
  | 'artifact_drift'
  | 'binding_drift'
  | 'status_drift'
  | 'cleanup_failed';

export type EvidenceFailureObservation =
  | 'unit_report_missing_or_invalid'
  | 'worker_report_missing_or_invalid'
  | 'playwright_report_missing_or_invalid'
  | 'worker_identity_literal_missing'
  | 'worker_identity_global_unreplaced'
  | 'client_identity_leak'
  | 'forbidden_secret_file'
  | 'artifact_collection_invalid'
  | 'binding_collection_invalid'
  | 'migration_verification_invalid'
  | 'tool_version_invalid';

export type PreconditionFailureObservation =
  | 'candidate_identity_unavailable'
  | 'initial_head_not_detached'
  | 'initial_head_sha_mismatch'
  | 'initial_head_tree_mismatch'
  | 'initial_status_not_clean';

export interface CommandResult<Id extends ReleaseCommandId> {
  id: Id;
  status: 'passed' | 'failed' | 'not_run';
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  exitCode: number | null;
}

export interface CandidateManifest {
  kind: 'candidary.release-candidate';
  schemaVersion: 1;
  status: 'passed' | 'failed';
  failureCode: ReleaseFailureCode | null;
  failureObservation: EvidenceFailureObservation | null;
  preconditionObservation: PreconditionFailureObservation | null;
  runId: string;
  candidate: {
    gitSha: string;
    approvedBaseSha: string;
    gitTree: string;
    guestJourneyVersion: number;
    migrationManifestSha256: string;
    packageLockSha256: string;
    sourceWranglerConfigSha256: string;
  } | null;
  execution: {
    startedAt: string;
    finishedAt: string;
    platform: string;
    arch: string;
    initialDetachedHead: boolean | null;
    initialHeadSha: string | null;
    initialHeadTree: string | null;
    initialStatusSha256: string | null;
    finalDetachedHead: boolean | null;
    finalHeadSha: string | null;
    finalHeadTree: string | null;
    finalStatusSha256: string | null;
    cleanupSucceeded: boolean | null;
    tools: ToolVersions;
  };
  commands: [
    CommandResult<'npm-ci'>,
    CommandResult<'verify-bindings'>,
    CommandResult<'typecheck'>,
    CommandResult<'typecheck-e2e'>,
    CommandResult<'lint'>,
    CommandResult<'unit-ui'>,
    CommandResult<'worker'>,
    CommandResult<'build'>,
    CommandResult<'pwa-before-e2e'>,
    CommandResult<'playwright'>,
    CommandResult<'pwa-after-e2e'>,
    CommandResult<'wrangler-dry-run'>,
    CommandResult<'fresh-d1'>,
    CommandResult<'diff-check'>,
  ];
  tests: {
    unitUi: TestCounts | null;
    worker: TestCounts | null;
    playwright: TestCounts | null;
  };
  migrations: {
    manifest: HashedFile[];
    verification: MigrationVerification;
  } | null;
  bindings: {
    topology: BindingTopology;
    sourceTopologySha256: string;
    firstBuildTopologySha256: string | null;
    secondBuildTopologySha256: string | null;
    generatedTypesSha256: string;
  } | null;
  artifacts: {
    worker: HashedFile;
    client: HashedFile[];
    firstTreeSha256: string;
    secondTreeSha256: string | null;
    dryRunWorkerSha256: string | null;
  } | null;
  claims: {
    localAutomated: 'passed' | 'failed';
    remoteMigration: 'not_run';
    deployment: 'not_run';
    physicalDevices: 'not_run';
    runtimeCertification: 'not_run';
  };
}

const releaseCommandIds = [
  'npm-ci',
  'verify-bindings',
  'typecheck',
  'typecheck-e2e',
  'lint',
  'unit-ui',
  'worker',
  'build',
  'pwa-before-e2e',
  'playwright',
  'pwa-after-e2e',
  'wrangler-dry-run',
  'fresh-d1',
  'diff-check',
] as const satisfies readonly ReleaseCommandId[];

const evidenceObservations = [
  'unit_report_missing_or_invalid',
  'worker_report_missing_or_invalid',
  'playwright_report_missing_or_invalid',
  'worker_identity_literal_missing',
  'worker_identity_global_unreplaced',
  'client_identity_leak',
  'forbidden_secret_file',
  'artifact_collection_invalid',
  'binding_collection_invalid',
  'migration_verification_invalid',
  'tool_version_invalid',
] as const satisfies readonly EvidenceFailureObservation[];

const preconditionObservations = [
  'candidate_identity_unavailable',
  'initial_head_not_detached',
  'initial_head_sha_mismatch',
  'initial_head_tree_mismatch',
  'initial_status_not_clean',
] as const satisfies readonly PreconditionFailureObservation[];

const toolVersionKeys = [
  'node',
  'npm',
  'git',
  'typescript',
  'eslint',
  'vite',
  'vitest',
  'playwright',
  'wrangler',
] as const satisfies readonly (keyof ToolVersions)[];

const installedToolVersionKeys = [
  'typescript', 'eslint', 'vite', 'vitest', 'playwright', 'wrangler',
] as const satisfies readonly (keyof ToolVersions)[];

const platforms = ['aix', 'android', 'darwin', 'freebsd', 'linux', 'openbsd', 'sunos', 'win32'] as const;
const architectures = ['arm', 'arm64', 'ia32', 'loong64', 'mips', 'mipsel', 'ppc', 'ppc64', 'riscv64', 's390', 's390x', 'x64'] as const;

const approvedBaseSha = '0b92387d2e237d568d2514373dcc3044e7960d4b';
const emptyStatusSha256 = createHash('sha256').update('').digest('hex');
const lexicalCompare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

function canonicalValue(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON requires finite numbers');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') throw new TypeError('canonical JSON requires JSON values');
  if (ancestors.has(value)) throw new TypeError('canonical JSON cannot contain cycles');

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
        throw new TypeError('canonical JSON requires dense arrays without extra keys');
      }
      if (Object.getPrototypeOf(value) !== Array.prototype
        || Object.getOwnPropertySymbols(value).length > 0
        || Reflect.ownKeys(value).length !== value.length + 1) {
        throw new TypeError('canonical JSON requires plain arrays');
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const items = keys.map((key) => {
        const descriptor = descriptors[key];
        if (!descriptor || descriptor.get || descriptor.set) {
          throw new TypeError('canonical JSON does not invoke array accessors');
        }
        return canonicalValue(descriptor.value, ancestors);
      });
      return `[${items.join(',')}]`;
    }

    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError('canonical JSON requires plain objects');
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError('canonical JSON does not accept symbol keys');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(value).sort(lexicalCompare);
    if (keys.length !== Reflect.ownKeys(value).length) {
      throw new TypeError('canonical JSON requires enumerable string keys');
    }
    const fields = keys.map((key) => {
      const descriptor = descriptors[key];
      if (!descriptor || descriptor.get || descriptor.set) {
        throw new TypeError('canonical JSON does not invoke accessors');
      }
      return `${JSON.stringify(key)}:${canonicalValue(descriptor.value, ancestors)}`;
    });
    return `{${fields.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return canonicalValue(value, new Set<object>());
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function portableAbsolute(path: string): boolean {
  return isAbsolute(path) || /^[A-Za-z]:/u.test(path) || path.startsWith('/') || path.startsWith('\\');
}

function configPath(path: unknown, field: string): string {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0') || portableAbsolute(path)) {
    throw new TypeError(`${field} must be a non-absolute path`);
  }
  return path.replace(/[\\/]+/gu, sep);
}

function within(container: string, target: string): boolean {
  const path = relative(container, target);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function assertRealContainment(container: string, target: string, field: string): void {
  const realContainer = realpathSync(container);
  const realTarget = realpathSync(target);
  if (!within(realContainer, realTarget)) throw new Error(`${field} escapes its approved root`);
}

export function sameFileIdentity(
  left: { dev: bigint; ino: bigint },
  right: { dev: bigint; ino: bigint },
): boolean {
  return left.ino !== 0n && left.dev === right.dev && left.ino === right.ino;
}

function sameFile(left: string, right: string): boolean {
  const leftReal = realpathSync(left);
  const rightReal = realpathSync(right);
  const normalizeCase = (path: string): string => sep === '\\' ? path.toLowerCase() : path;
  if (normalizeCase(leftReal) === normalizeCase(rightReal)) return true;
  return sameFileIdentity(
    statSync(left, { bigint: true }),
    statSync(right, { bigint: true }),
  );
}

function assertDirectoryChainHasNoLinks(base: string, target: string, field: string): void {
  const path = relative(resolve(base), resolve(target));
  if (path === '' || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error(`${field} is not a child directory`);
  }
  let current = resolve(base);
  for (const component of path.split(sep)) {
    current = join(current, component);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`${field} contains a linked or non-directory component`);
    }
  }
}

function logicalPath(root: string, target: string): string {
  const path = relative(resolve(root), resolve(target)).replaceAll('\\', '/');
  return relativeEvidencePath(path, 'artifact path');
}

function hashedFile(root: string, target: string): HashedFile {
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('evidence files must be regular files');
  const bytes = readFileSync(target);
  return { path: logicalPath(root, target), bytes: bytes.byteLength, sha256: sha256(bytes) };
}

export function collectMigrationManifest(root: string): MigrationManifest {
  const resolvedRoot = resolve(root);
  const migrationRoot = resolve(resolvedRoot, 'migrations');
  assertDirectoryChainHasNoLinks(resolvedRoot, migrationRoot, 'migration directory');
  assertRealContainment(resolvedRoot, migrationRoot, 'migration directory');
  const entries = readdirSync(migrationRoot, { withFileTypes: true });
  if (entries.length === 0) throw new Error('migration inventory is empty');

  const discovered = entries.map((entry) => {
    const match = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/u.exec(entry.name);
    if (!entry.isFile() || entry.isSymbolicLink() || !match) {
      throw new Error(`invalid migration entry: ${entry.name}`);
    }
    return { entry, number: Number.parseInt(match[1]!, 10) };
  }).sort((left, right) => left.number - right.number || lexicalCompare(left.entry.name, right.entry.name));

  for (const [index, item] of discovered.entries()) {
    if (item.number !== index + 1) throw new Error('migration sequence must begin at 0001 and be gap-free');
  }

  const files = discovered.map(({ entry }) => {
    const target = resolve(migrationRoot, entry.name);
    assertRealContainment(migrationRoot, target, 'migration');
    return hashedFile(resolvedRoot, target);
  });
  return {
    files,
    sha256: sha256(canonicalJson(files.map(({ path, sha256: digest }) => ({ path, sha256: digest })))),
  };
}

function forbiddenSecretName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith('.env') || lower.startsWith('.dev.vars');
}

function scanNoSecretsOrLinks(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (forbiddenSecretName(entry.name)) throw new Error('forbidden secret file in build output');
    const target = join(root, entry.name);
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error('build output cannot contain symbolic links');
    if (stat.isDirectory()) scanNoSecretsOrLinks(target);
  }
}

function collectRegularFiles(root: string, repositoryRoot: string): HashedFile[] {
  const files: HashedFile[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (forbiddenSecretName(entry.name)) throw new Error('forbidden secret file in build output');
      const target = join(directory, entry.name);
      const stat = lstatSync(target);
      if (stat.isSymbolicLink()) throw new Error('build output cannot contain symbolic links');
      if (stat.isDirectory()) visit(target);
      else if (stat.isFile()) files.push(hashedFile(repositoryRoot, target));
      else throw new Error('build output contains a non-regular entry');
    }
  };
  visit(root);
  return files.sort((left, right) => lexicalCompare(left.path, right.path));
}

export function collectDeployableArtifacts(root: string): {
  worker: HashedFile;
  client: HashedFile[];
  treeSha256: string;
} {
  const resolvedRoot = resolve(root);
  const workerRoot = resolve(resolvedRoot, 'dist/candidary');
  const clientRoot = resolve(resolvedRoot, 'dist/client');
  const generatedConfig = resolve(workerRoot, 'wrangler.json');
  assertDirectoryChainHasNoLinks(resolvedRoot, workerRoot, 'Worker build root');
  assertDirectoryChainHasNoLinks(resolvedRoot, clientRoot, 'client build root');
  assertRealContainment(resolvedRoot, workerRoot, 'Worker build root');
  assertRealContainment(resolvedRoot, clientRoot, 'client build root');
  assertRealContainment(workerRoot, generatedConfig, 'generated Wrangler config');

  const parsed: unknown = JSON.parse(readFileSync(generatedConfig, 'utf8'));
  const record = requireRecord(parsed, 'generated Wrangler config');
  const assets = requireRecord(record.assets, 'generated Wrangler assets');
  const workerTarget = resolve(dirname(generatedConfig), configPath(record.main, 'main'));
  const assetsTarget = resolve(dirname(generatedConfig), configPath(assets.directory, 'assets.directory'));
  if (!within(workerRoot, workerTarget)) throw new Error('Worker main escapes dist/candidary');
  if (!within(clientRoot, assetsTarget)) throw new Error('client assets escape dist/client');
  if (sameFile(workerTarget, generatedConfig)) throw new Error('generated Wrangler JSON is not a deployable artifact');
  assertRealContainment(workerRoot, workerTarget, 'Worker main');
  assertRealContainment(clientRoot, assetsTarget, 'client assets');
  scanNoSecretsOrLinks(workerRoot);
  scanNoSecretsOrLinks(clientRoot);

  const worker = hashedFile(resolvedRoot, workerTarget);
  const client = collectRegularFiles(assetsTarget, resolvedRoot);
  if (client.length === 0) throw new Error('client artifact inventory is empty');
  const treeSha256 = sha256(canonicalJson({ worker, client }));
  return { worker, client, treeSha256 };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be an object`);
  }
  const keys = Object.keys(value);
  if (Reflect.ownKeys(value).length !== keys.length) {
    throw new TypeError(`${label} must contain only enumerable string keys`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.some((key) => {
    const descriptor = descriptors[key];
    return !descriptor || descriptor.get !== undefined || descriptor.set !== undefined || descriptor.enumerable !== true;
  })) {
    throw new TypeError(`${label} must contain only data properties`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new TypeError(`${label} must be a nonempty string`);
  }
  return value;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean`);
  return value;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${label} must be a nonnegative safe integer`);
  return value as number;
}

function nonnegativeFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a nonnegative finite number`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  const result = nonnegativeInteger(value, label);
  if (result === 0) throw new TypeError(`${label} must be positive`);
  return result;
}

function optionalArray(value: unknown, label: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort(lexicalCompare);
}

function bindingNames(value: unknown, label: string, key = 'binding'): string[] {
  return optionalArray(value, label).map((item, index) => {
    const record = requireRecord(item, `${label}[${index}]`);
    return safeName(record[key], `${label}[${index}].${key}`);
  });
}

function normalizedMigrationDirectory(value: unknown): string {
  const path = requiredString(value, 'migrations_dir');
  if (portableAbsolute(path)) throw new TypeError('migrations_dir must be relative');
  const rawParts = path.replaceAll('\\', '/').split('/').filter((part) => part !== '' && part !== '.');
  const parts = rawParts[0] === '..'
    ? rawParts[1] === '..' && rawParts[2] !== '..' ? rawParts.slice(2) : []
    : rawParts;
  if (parts.length === 0 || parts.some((part) => part === '..')) {
    throw new TypeError('migrations_dir must be source-relative or exactly two levels above generated config');
  }
  return relativeEvidencePath(parts.join('/'), 'migrations_dir');
}

function objectTupleSort<T>(values: T[]): T[] {
  const byCanonical = new Map(values.map((value) => [canonicalJson(value), value]));
  return [...byCanonical.entries()].sort(([left], [right]) => lexicalCompare(left, right)).map(([, value]) => value);
}

export function normalizedBindingTopology(config: unknown): BindingTopology {
  const record = requireRecord(config, 'Wrangler config');
  const assets = requireRecord(record.assets, 'assets');
  const d1 = optionalArray(record.d1_databases, 'd1_databases');
  const r2 = optionalArray(record.r2_buckets, 'r2_buckets');
  const imageRecords = record.images === undefined ? [] : Array.isArray(record.images) ? record.images : [record.images];
  const sendEmail = optionalArray(record.send_email, 'send_email');
  const workflows = optionalArray(record.workflows, 'workflows').map((item, index) => {
    const workflow = requireRecord(item, `workflows[${index}]`);
    return {
      binding: safeName(workflow.binding, `workflows[${index}].binding`),
      className: safeName(workflow.class_name, `workflows[${index}].class_name`),
    };
  });
  const rateLimits = optionalArray(record.ratelimits, 'ratelimits').map((item, index) => {
    const rate = requireRecord(item, `ratelimits[${index}]`);
    const simple = requireRecord(rate.simple, `ratelimits[${index}].simple`);
    return {
      name: safeName(rate.name, `ratelimits[${index}].name`),
      limit: nonnegativeInteger(simple.limit, `ratelimits[${index}].simple.limit`),
      period: nonnegativeInteger(simple.period, `ratelimits[${index}].simple.period`),
    };
  });
  const requiredSecrets = record.secrets === undefined
    ? []
    : optionalArray(requireRecord(record.secrets, 'secrets').required, 'secrets.required').map((value, index) =>
      environmentName(value, `secrets.required[${index}]`));
  const variableNames = record.vars === undefined
    ? []
    : Object.keys(requireRecord(record.vars, 'vars')).map((name) => environmentName(name, 'vars key'));
  const versionMetadata = record.version_metadata === undefined
    ? null
    : safeName(requireRecord(record.version_metadata, 'version_metadata').binding, 'version_metadata.binding');
  const triggers = record.triggers === undefined ? {} : requireRecord(record.triggers, 'triggers');
  const observability = record.observability === undefined ? {} : requireRecord(record.observability, 'observability');

  return {
    compatibilityDate: calendarDate(record.compatibility_date, 'compatibility_date'),
    compatibilityFlags: sortedUnique(optionalArray(record.compatibility_flags, 'compatibility_flags').map((value, index) =>
      compatibilityFlag(value, `compatibility_flags[${index}]`))),
    workersDev: requiredBoolean(record.workers_dev, 'workers_dev'),
    assets: {
      binding: safeName(assets.binding, 'assets.binding'),
      notFoundHandling: wranglerNotFoundHandling(assets.not_found_handling, 'assets.not_found_handling'),
      runWorkerFirst: sortedUnique(optionalArray(assets.run_worker_first, 'assets.run_worker_first').map((value, index) =>
        routeString(value, `assets.run_worker_first[${index}]`))),
    },
    bindings: {
      d1: sortedUnique(bindingNames(d1, 'd1_databases')),
      r2: sortedUnique(bindingNames(r2, 'r2_buckets')),
      images: sortedUnique(bindingNames(imageRecords, 'images')),
      sendEmail: sortedUnique(bindingNames(sendEmail, 'send_email', 'name')),
      versionMetadata,
    },
    requiredSecrets: sortedUnique(requiredSecrets),
    variableNames: sortedUnique(variableNames),
    workflows: objectTupleSort(workflows),
    rateLimits: objectTupleSort(rateLimits),
    crons: sortedUnique(optionalArray(triggers.crons, 'triggers.crons').map((value, index) =>
      cronExpression(value, `triggers.crons[${index}]`))),
    migrationDirectories: sortedUnique(d1.map((item, index) =>
      normalizedMigrationDirectory(requireRecord(item, `d1_databases[${index}]`).migrations_dir))),
    observabilityEnabled: observability.enabled === undefined
      ? false
      : requiredBoolean(observability.enabled, 'observability.enabled'),
  };
}

export function releaseBuildSha(headSha: unknown, porcelainStatus: string): string {
  return typeof headSha === 'string' && /^[0-9a-f]{40}$/u.test(headSha) && porcelainStatus === '' ? headSha : '';
}

function reportCount(value: unknown, label: string): number {
  return nonnegativeInteger(value, label);
}

function safeCountSum(values: readonly number[], label: string): number {
  const result = values.reduce((total, value) => total + value, 0);
  if (!Number.isSafeInteger(result)) throw new TypeError(`${label} exceeds the safe integer range`);
  return result;
}

function vitestAssertions(report: Record<string, unknown>, filter?: RegExp): TestCounts {
  if (!Array.isArray(report.testResults)) throw new TypeError('Vitest report testResults must be an array');
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const [fileIndex, item] of report.testResults.entries()) {
    const file = requireRecord(item, `testResults[${fileIndex}]`);
    const name = requiredString(file.name, `testResults[${fileIndex}].name`).replaceAll('\\', '/');
    if (filter) {
      filter.lastIndex = 0;
      if (!filter.test(name)) continue;
    }
    if (!Array.isArray(file.assertionResults)) throw new TypeError('Vitest assertionResults must be an array');
    for (const [assertionIndex, assertionValue] of file.assertionResults.entries()) {
      const assertion = requireRecord(assertionValue, `assertionResults[${assertionIndex}]`);
      const status = requiredString(assertion.status, 'Vitest assertion status');
      if (status === 'passed') passed += 1;
      else if (status === 'failed') failed += 1;
      else if (status === 'skipped' || status === 'pending' || status === 'todo' || status === 'disabled') skipped += 1;
      else throw new TypeError(`unknown Vitest assertion status: ${status}`);
    }
  }
  return { total: passed + failed + skipped, passed, failed, skipped, flaky: 0 };
}

export function parseVitestReport(report: unknown, filePattern?: RegExp): TestCounts {
  const record = requireRecord(report, 'Vitest report');
  const aggregate = {
    total: reportCount(record.numTotalTests, 'numTotalTests'),
    passed: reportCount(record.numPassedTests, 'numPassedTests'),
    failed: reportCount(record.numFailedTests, 'numFailedTests'),
    pending: reportCount(record.numPendingTests, 'numPendingTests'),
    todo: reportCount(record.numTodoTests, 'numTodoTests'),
  };
  const suites = {
    total: reportCount(record.numTotalTestSuites, 'numTotalTestSuites'),
    passed: reportCount(record.numPassedTestSuites, 'numPassedTestSuites'),
    failed: reportCount(record.numFailedTestSuites, 'numFailedTestSuites'),
    pending: reportCount(record.numPendingTestSuites, 'numPendingTestSuites'),
  };
  if (typeof record.success !== 'boolean') throw new TypeError('Vitest success must be a boolean');
  if (!Array.isArray(record.testResults)
    || suites.total !== safeCountSum([suites.passed, suites.failed, suites.pending], 'Vitest suite total')
    || (suites.failed > 0 && aggregate.failed === 0)
    || record.success !== (aggregate.failed === 0 && suites.failed === 0)) {
    throw new TypeError('Vitest suite envelope is inconsistent or unrepresentable');
  }
  const recounted = vitestAssertions(record);
  const skipped = safeCountSum([aggregate.pending, aggregate.todo], 'Vitest skipped total');
  const expected = {
    total: safeCountSum([aggregate.passed, aggregate.failed, skipped], 'Vitest test total'),
    passed: aggregate.passed,
    failed: aggregate.failed,
    skipped,
    flaky: 0,
  };
  if (aggregate.total !== expected.total || canonicalJson(recounted) !== canonicalJson(expected)) {
    throw new TypeError('Vitest aggregate counts are inconsistent');
  }
  return filePattern ? vitestAssertions(record, filePattern) : expected;
}

export function parsePlaywrightReport(report: unknown): TestCounts {
  const record = requireRecord(report, 'Playwright report');
  requireRecord(record.config, 'Playwright config');
  if (!Array.isArray(record.suites) || !Array.isArray(record.errors) || record.errors.length > 0) {
    throw new TypeError('Playwright report envelope is truncated or has collection errors');
  }
  const stats = requireRecord(record.stats, 'Playwright stats');
  utcInstant(stats.startTime, 'stats.startTime');
  nonnegativeFiniteNumber(stats.duration, 'stats.duration');
  const expected = reportCount(stats.expected, 'stats.expected');
  const unexpected = reportCount(stats.unexpected, 'stats.unexpected');
  const flaky = reportCount(stats.flaky, 'stats.flaky');
  const skipped = reportCount(stats.skipped, 'stats.skipped');
  const passed = safeCountSum([expected, flaky], 'Playwright passed total');
  return {
    total: safeCountSum([passed, unexpected, skipped], 'Playwright test total'),
    passed,
    failed: unexpected,
    skipped,
    flaky,
  };
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const record = requireRecord(value, label);
  const actual = Object.keys(record).sort(lexicalCompare);
  const expected = [...keys].sort(lexicalCompare);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has unknown or missing keys`);
  }
  return record;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new TypeError(`${label} is invalid`);
  return value as T;
}

function nullable<T>(value: unknown, validate: (candidate: unknown) => T): T | null {
  return value === null ? null : validate(value);
}

function sha40(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/u.test(value)) throw new TypeError(`${label} must be a lowercase SHA-1`);
  return value;
}

function sha256Value(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) throw new TypeError(`${label} must be a lowercase SHA-256`);
  return value;
}

function utcInstant(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    throw new TypeError(`${label} must be a canonical UTC instant`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.valueOf()) || date.toISOString() !== value) throw new TypeError(`${label} must be a valid UTC instant`);
  return value;
}

function calendarDate(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new TypeError(`${label} must be a calendar date`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TypeError(`${label} must be a valid calendar date`);
  }
  return value;
}

function uuidV4(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) {
    throw new TypeError(`${label} must be a lowercase UUID v4`);
  }
  return value;
}

function compatibilityFlag(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,127}$/u.test(value) || credentialLike(value)) {
    throw new TypeError(`${label} must be a compatibility-flag name`);
  }
  return value;
}

function credentialLike(value: string): boolean {
  return /(?:^|[/_.-])(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}/iu.test(value)
    || /(?:^|[/_.-])sk_(?:live|test)_[A-Za-z0-9]{8,}/iu.test(value)
    || /bearer[ _-]+[A-Za-z0-9_-]{8,}/iu.test(value);
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function versionToken(value: unknown, label: string): string {
  if (typeof value !== 'string'
    || !/^v?\d+(?:\.(?:\d+|[A-Za-z][A-Za-z0-9-]*)){1,7}(?:[-+][0-9A-Za-z.-]+)?$/u.test(value)
    || credentialLike(value)) {
    throw new TypeError(`${label} must be a parsed version token`);
  }
  return value;
}

function safeName(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/u.test(value) || credentialLike(value)) {
    throw new TypeError(`${label} must be an allowlisted name`);
  }
  return value;
}

function environmentName(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(value) || credentialLike(value)) {
    throw new TypeError(`${label} must be an uppercase environment name`);
  }
  return value;
}

function relativeEvidencePath(value: unknown, label: string): string {
  const path = requiredString(value, label);
  if (portableAbsolute(path) || path.includes('\\') || path.includes('@') || /:\/\//u.test(path)
    || hasControlCharacter(path) || credentialLike(path)) {
    throw new TypeError(`${label} must be a redacted repository-relative path`);
  }
  const parts = path.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..' || forbiddenSecretName(part))) {
    throw new TypeError(`${label} is not canonical`);
  }
  return path;
}

function exactSortedUnique(values: string[], label: string): void {
  if (values.some((value, index) => index > 0 && lexicalCompare(values[index - 1]!, value) >= 0)) {
    throw new TypeError(`${label} must be sorted and unique`);
  }
}

function parseHashedFile(value: unknown, label: string): HashedFile {
  const record = exactRecord(value, ['path', 'bytes', 'sha256'], label);
  return {
    path: relativeEvidencePath(record.path, `${label}.path`),
    bytes: nonnegativeInteger(record.bytes, `${label}.bytes`),
    sha256: sha256Value(record.sha256, `${label}.sha256`),
  };
}

function parseTestCounts(value: unknown, label: string): TestCounts {
  const record = exactRecord(value, ['total', 'passed', 'failed', 'skipped', 'flaky'], label);
  const counts = {
    total: nonnegativeInteger(record.total, `${label}.total`),
    passed: nonnegativeInteger(record.passed, `${label}.passed`),
    failed: nonnegativeInteger(record.failed, `${label}.failed`),
    skipped: nonnegativeInteger(record.skipped, `${label}.skipped`),
    flaky: nonnegativeInteger(record.flaky, `${label}.flaky`),
  };
  if (counts.total !== counts.passed + counts.failed + counts.skipped || counts.flaky > counts.passed) {
    throw new TypeError(`${label} counts are inconsistent`);
  }
  return counts;
}

function stringArray(value: unknown, label: string, validate: (candidate: unknown, label: string) => string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const result = value.map((item, index) => validate(item, `${label}[${index}]`));
  exactSortedUnique(result, label);
  return result;
}

function routeString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\/[A-Za-z0-9*._~!$&'()+,;=:%/-]*$/u.test(value)
    || value.includes('..') || value.includes('://') || credentialLike(value)) {
    throw new TypeError(`${label} must be a route pattern`);
  }
  return value;
}

function wranglerNotFoundHandling(value: unknown, label: string): string {
  return oneOf(value, ['404-page', 'none', 'single-page-application'] as const, label);
}

function cronExpression(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 128 || credentialLike(value)) {
    throw new TypeError(`${label} must be a five-field cron expression`);
  }
  const fields = value.split(' ');
  if (fields.length !== 5) throw new TypeError(`${label} must be a five-field cron expression`);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  const replaceAliases = (field: string, aliases: readonly string[]): string => {
    let normalized = field.toUpperCase();
    for (const alias of aliases) normalized = normalized.replaceAll(alias, '1');
    return normalized;
  };
  const monthSyntax = replaceAliases(month!, [
    'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
  ]);
  const daySyntax = replaceAliases(dayOfWeek!, ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']);
  if (!/^[-0-9*/,]+$/u.test(minute!)
    || !/^[-0-9*/,]+$/u.test(hour!)
    || !/^[-0-9*?/,LW]+$/u.test(dayOfMonth!.toUpperCase())
    || !/^[-0-9*?/,]+$/u.test(monthSyntax)
    || !/^[-0-9*?/,#L]+$/u.test(daySyntax)) {
    throw new TypeError(`${label} must use cron field syntax`);
  }
  return value;
}

function validateTopology(value: unknown): BindingTopology {
  const record = exactRecord(value, [
    'compatibilityDate', 'compatibilityFlags', 'workersDev', 'assets', 'bindings', 'requiredSecrets',
    'variableNames', 'workflows', 'rateLimits', 'crons', 'migrationDirectories', 'observabilityEnabled',
  ], 'binding topology');
  const assets = exactRecord(record.assets, ['binding', 'notFoundHandling', 'runWorkerFirst'], 'binding topology assets');
  const bindings = exactRecord(record.bindings, ['d1', 'r2', 'images', 'sendEmail', 'versionMetadata'], 'binding topology bindings');
  if (!Array.isArray(record.workflows) || !Array.isArray(record.rateLimits)) throw new TypeError('binding topology tuples must be arrays');
  const workflows = record.workflows.map((item, index) => {
    const workflow = exactRecord(item, ['binding', 'className'], `workflows[${index}]`);
    return { binding: safeName(workflow.binding, 'workflow binding'), className: safeName(workflow.className, 'workflow class') };
  });
  const rateLimits = record.rateLimits.map((item, index) => {
    const rate = exactRecord(item, ['name', 'limit', 'period'], `rateLimits[${index}]`);
    return {
      name: safeName(rate.name, 'rate limit name'),
      limit: nonnegativeInteger(rate.limit, 'rate limit'),
      period: nonnegativeInteger(rate.period, 'rate period'),
    };
  });
  const workflowCanonicals = workflows.map(canonicalJson);
  exactSortedUnique(workflowCanonicals, 'workflows');
  const rateCanonicals = rateLimits.map(canonicalJson);
  exactSortedUnique(rateCanonicals, 'rateLimits');
  const compatibilityDate = calendarDate(record.compatibilityDate, 'compatibilityDate');
  return {
    compatibilityDate,
    compatibilityFlags: stringArray(record.compatibilityFlags, 'compatibilityFlags', compatibilityFlag),
    workersDev: requiredBoolean(record.workersDev, 'workersDev'),
    assets: {
      binding: safeName(assets.binding, 'asset binding'),
      notFoundHandling: wranglerNotFoundHandling(assets.notFoundHandling, 'asset not-found handling'),
      runWorkerFirst: stringArray(assets.runWorkerFirst, 'runWorkerFirst', routeString),
    },
    bindings: {
      d1: stringArray(bindings.d1, 'D1 bindings', safeName),
      r2: stringArray(bindings.r2, 'R2 bindings', safeName),
      images: stringArray(bindings.images, 'Images bindings', safeName),
      sendEmail: stringArray(bindings.sendEmail, 'email bindings', safeName),
      versionMetadata: nullable(bindings.versionMetadata, (item) => safeName(item, 'version metadata binding')),
    },
    requiredSecrets: stringArray(record.requiredSecrets, 'requiredSecrets', environmentName),
    variableNames: stringArray(record.variableNames, 'variableNames', environmentName),
    workflows,
    rateLimits,
    crons: stringArray(record.crons, 'crons', cronExpression),
    migrationDirectories: stringArray(record.migrationDirectories, 'migrationDirectories', relativeEvidencePath),
    observabilityEnabled: requiredBoolean(record.observabilityEnabled, 'observabilityEnabled'),
  };
}

function validateCandidate(value: unknown): NonNullable<CandidateManifest['candidate']> {
  const record = exactRecord(value, [
    'gitSha', 'approvedBaseSha', 'gitTree', 'guestJourneyVersion', 'migrationManifestSha256',
    'packageLockSha256', 'sourceWranglerConfigSha256',
  ], 'candidate');
  const base = sha40(record.approvedBaseSha, 'approvedBaseSha');
  if (base !== approvedBaseSha) throw new TypeError('approvedBaseSha is not approved');
  return {
    gitSha: sha40(record.gitSha, 'gitSha'),
    approvedBaseSha: base,
    gitTree: sha40(record.gitTree, 'gitTree'),
    guestJourneyVersion: positiveInteger(record.guestJourneyVersion, 'guestJourneyVersion'),
    migrationManifestSha256: sha256Value(record.migrationManifestSha256, 'migrationManifestSha256'),
    packageLockSha256: sha256Value(record.packageLockSha256, 'packageLockSha256'),
    sourceWranglerConfigSha256: sha256Value(record.sourceWranglerConfigSha256, 'sourceWranglerConfigSha256'),
  };
}

function validateTools(value: unknown): ToolVersions {
  const record = exactRecord(value, toolVersionKeys, 'tool versions');
  const version = (key: keyof ToolVersions): string | null =>
    nullable(record[key], (item) => versionToken(item, `tools.${key}`));
  return {
    node: version('node'),
    npm: version('npm'),
    git: version('git'),
    typescript: version('typescript'),
    eslint: version('eslint'),
    vite: version('vite'),
    vitest: version('vitest'),
    playwright: version('playwright'),
    wrangler: version('wrangler'),
  };
}

function validateExecution(value: unknown): CandidateManifest['execution'] {
  const record = exactRecord(value, [
    'startedAt', 'finishedAt', 'platform', 'arch', 'initialDetachedHead', 'initialHeadSha', 'initialHeadTree',
    'initialStatusSha256', 'finalDetachedHead', 'finalHeadSha', 'finalHeadTree', 'finalStatusSha256',
    'cleanupSucceeded', 'tools',
  ], 'execution');
  const startedAt = utcInstant(record.startedAt, 'execution.startedAt');
  const finishedAt = utcInstant(record.finishedAt, 'execution.finishedAt');
  if (finishedAt < startedAt) throw new TypeError('execution finishes before it starts');
  const nullableBoolean = (item: unknown): boolean => requiredBoolean(item, 'nullable boolean');
  return {
    startedAt,
    finishedAt,
    platform: oneOf(record.platform, platforms, 'platform'),
    arch: oneOf(record.arch, architectures, 'arch'),
    initialDetachedHead: nullable(record.initialDetachedHead, nullableBoolean),
    initialHeadSha: nullable(record.initialHeadSha, (item) => sha40(item, 'initialHeadSha')),
    initialHeadTree: nullable(record.initialHeadTree, (item) => sha40(item, 'initialHeadTree')),
    initialStatusSha256: nullable(record.initialStatusSha256, (item) => sha256Value(item, 'initialStatusSha256')),
    finalDetachedHead: nullable(record.finalDetachedHead, nullableBoolean),
    finalHeadSha: nullable(record.finalHeadSha, (item) => sha40(item, 'finalHeadSha')),
    finalHeadTree: nullable(record.finalHeadTree, (item) => sha40(item, 'finalHeadTree')),
    finalStatusSha256: nullable(record.finalStatusSha256, (item) => sha256Value(item, 'finalStatusSha256')),
    cleanupSucceeded: nullable(record.cleanupSucceeded, nullableBoolean),
    tools: validateTools(record.tools),
  };
}

function validateCommand(value: unknown, expectedId: ReleaseCommandId): CommandResult<ReleaseCommandId> {
  const record = exactRecord(value, ['id', 'status', 'startedAt', 'finishedAt', 'durationMs', 'exitCode'], `command ${expectedId}`);
  const id = oneOf(record.id, releaseCommandIds, 'command id');
  if (id !== expectedId) throw new TypeError('command tuple order is invalid');
  const status = oneOf(record.status, ['passed', 'failed', 'not_run'] as const, 'command status');
  if (status === 'not_run') {
    if (record.startedAt !== null || record.finishedAt !== null || record.durationMs !== null || record.exitCode !== null) {
      throw new TypeError('not_run command contains execution data');
    }
    return { id, status, startedAt: null, finishedAt: null, durationMs: null, exitCode: null };
  }
  const startedAt = utcInstant(record.startedAt, 'command.startedAt');
  const finishedAt = utcInstant(record.finishedAt, 'command.finishedAt');
  if (finishedAt < startedAt) throw new TypeError('command finishes before it starts');
  const durationMs = nonnegativeFiniteNumber(record.durationMs, 'command.durationMs');
  if (status === 'passed') {
    if (record.exitCode !== 0) throw new TypeError('passed command must exit zero');
    return { id, status, startedAt, finishedAt, durationMs, exitCode: 0 };
  }
  if (record.exitCode !== null && (!Number.isSafeInteger(record.exitCode) || record.exitCode === 0)) {
    throw new TypeError('failed command exit code is invalid');
  }
  return { id, status, startedAt, finishedAt, durationMs, exitCode: record.exitCode as number | null };
}

function validateCommands(value: unknown): CandidateManifest['commands'] {
  if (!Array.isArray(value) || value.length !== releaseCommandIds.length) throw new TypeError('commands must be the exact tuple');
  const commands = value.map((command, index) => validateCommand(command, releaseCommandIds[index]!));
  let phase: 'passed' | 'failed' | 'not_run' = 'passed';
  let failures = 0;
  for (const command of commands) {
    if (command.status === 'passed') {
      if (phase !== 'passed') throw new TypeError('command tuple is not a passed prefix');
    } else if (command.status === 'failed') {
      if (phase !== 'passed') throw new TypeError('command tuple has multiple or misplaced failures');
      phase = 'failed';
      failures += 1;
    } else {
      phase = 'not_run';
    }
  }
  if (failures > 1) throw new TypeError('command tuple has multiple failures');
  return commands as CandidateManifest['commands'];
}

function validateMigrations(value: unknown): NonNullable<CandidateManifest['migrations']> {
  const record = exactRecord(value, ['manifest', 'verification'], 'migrations');
  if (!Array.isArray(record.manifest) || record.manifest.length === 0) throw new TypeError('migration manifest must be nonempty');
  const manifest = record.manifest.map((file, index) => parseHashedFile(file, `migration manifest[${index}]`));
  exactSortedUnique(manifest.map((file) => file.path), 'migration manifest paths');
  for (const [index, file] of manifest.entries()) {
    const match = /^migrations\/(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/u.exec(file.path);
    if (!match || Number.parseInt(match[1]!, 10) !== index + 1) throw new TypeError('migration manifest is not gap-free');
  }
  const verification = parseMigrationVerification(record.verification);
  return { manifest, verification };
}

export function parseMigrationVerification(value: unknown): MigrationVerification {
  const verification = exactRecord(value, [
    'migrationCount', 'ledgerSha256', 'foreignKeyRows', 'integrity', 'terminalSchema',
  ], 'migration verification');
  const terminal = exactRecord(verification.terminalSchema, [
    'events', 'rosterBatchReceipts', 'releaseCertifications',
  ], 'terminal schema');
  if (verification.foreignKeyRows !== 0 || verification.integrity !== 'ok'
    || terminal.events !== true || terminal.rosterBatchReceipts !== true || terminal.releaseCertifications !== true) {
    throw new TypeError('migration verification literals are invalid');
  }
  return {
    migrationCount: nonnegativeInteger(verification.migrationCount, 'migrationCount'),
    ledgerSha256: sha256Value(verification.ledgerSha256, 'ledgerSha256'),
    foreignKeyRows: 0,
    integrity: 'ok',
    terminalSchema: { events: true, rosterBatchReceipts: true, releaseCertifications: true },
  };
}

function validateBindings(value: unknown): NonNullable<CandidateManifest['bindings']> {
  const record = exactRecord(value, [
    'topology', 'sourceTopologySha256', 'firstBuildTopologySha256', 'secondBuildTopologySha256', 'generatedTypesSha256',
  ], 'bindings');
  return {
    topology: validateTopology(record.topology),
    sourceTopologySha256: sha256Value(record.sourceTopologySha256, 'sourceTopologySha256'),
    firstBuildTopologySha256: nullable(record.firstBuildTopologySha256, (item) => sha256Value(item, 'firstBuildTopologySha256')),
    secondBuildTopologySha256: nullable(record.secondBuildTopologySha256, (item) => sha256Value(item, 'secondBuildTopologySha256')),
    generatedTypesSha256: sha256Value(record.generatedTypesSha256, 'generatedTypesSha256'),
  };
}

function validateArtifacts(value: unknown): NonNullable<CandidateManifest['artifacts']> {
  const record = exactRecord(value, [
    'worker', 'client', 'firstTreeSha256', 'secondTreeSha256', 'dryRunWorkerSha256',
  ], 'artifacts');
  if (!Array.isArray(record.client) || record.client.length === 0) throw new TypeError('client artifacts must be nonempty');
  const client = record.client.map((file, index) => parseHashedFile(file, `client artifact[${index}]`));
  exactSortedUnique(client.map((file) => file.path), 'client artifact paths');
  if (client.some((file) => !file.path.startsWith('dist/client/'))) {
    throw new TypeError('client artifacts must remain under dist/client');
  }
  const worker = parseHashedFile(record.worker, 'Worker artifact');
  if (!worker.path.startsWith('dist/candidary/')
    || worker.path.toLowerCase() === 'dist/candidary/wrangler.json') {
    throw new TypeError('Worker artifact must remain under dist/candidary and exclude generated config');
  }
  return {
    worker,
    client,
    firstTreeSha256: sha256Value(record.firstTreeSha256, 'firstTreeSha256'),
    secondTreeSha256: nullable(record.secondTreeSha256, (item) => sha256Value(item, 'secondTreeSha256')),
    dryRunWorkerSha256: nullable(record.dryRunWorkerSha256, (item) => sha256Value(item, 'dryRunWorkerSha256')),
  };
}

function validateClaims(value: unknown): CandidateManifest['claims'] {
  const record = exactRecord(value, [
    'localAutomated', 'remoteMigration', 'deployment', 'physicalDevices', 'runtimeCertification',
  ], 'claims');
  if (record.remoteMigration !== 'not_run' || record.deployment !== 'not_run'
    || record.physicalDevices !== 'not_run' || record.runtimeCertification !== 'not_run') {
    throw new TypeError('nonlocal claims must remain not_run');
  }
  return {
    localAutomated: oneOf(record.localAutomated, ['passed', 'failed'] as const, 'localAutomated'),
    remoteMigration: 'not_run',
    deployment: 'not_run',
    physicalDevices: 'not_run',
    runtimeCertification: 'not_run',
  };
}

function failureCode(value: unknown): ReleaseFailureCode | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new TypeError('failureCode is invalid');
  if (['precondition_failed', 'evidence_invalid', 'artifact_drift', 'binding_drift', 'status_drift', 'cleanup_failed'].includes(value)) {
    return value as ReleaseFailureCode;
  }
  const match = /^command_failed:(.+)$/u.exec(value);
  if (match && releaseCommandIds.includes(match[1] as ReleaseCommandId)) return value as ReleaseFailureCode;
  throw new TypeError('failureCode is not allowlisted');
}

function commandById(
  commands: CandidateManifest['commands'],
  id: ReleaseCommandId,
): CommandResult<ReleaseCommandId> {
  return commands[releaseCommandIds.indexOf(id)]!;
}

function assertStoppedAfter(commands: CandidateManifest['commands'], id: ReleaseCommandId): void {
  const index = releaseCommandIds.indexOf(id);
  if (commands[index]!.status !== 'passed'
    || commands.slice(index + 1).some((command) => command.status !== 'not_run')) {
    throw new TypeError(`evidence failure did not stop after ${id}`);
  }
}

function evidenceStage(
  observation: EvidenceFailureObservation,
  manifest: Pick<CandidateManifest, 'tests' | 'migrations' | 'bindings' | 'artifacts' | 'execution' | 'commands'>,
): ReleaseCommandId {
  if (observation === 'unit_report_missing_or_invalid') {
    if (manifest.tests.unitUi !== null) throw new TypeError('unit report observation has counts');
    return 'unit-ui';
  }
  if (observation === 'worker_report_missing_or_invalid') {
    if (manifest.tests.worker !== null) throw new TypeError('Worker report observation has counts');
    return 'worker';
  }
  if (observation === 'playwright_report_missing_or_invalid') {
    if (manifest.tests.playwright !== null) throw new TypeError('Playwright report observation has counts');
    return 'playwright';
  }
  if (observation === 'tool_version_invalid') {
    if (!toolVersionKeys.some((key) => manifest.execution.tools[key] === null)) {
      throw new TypeError('tool-version observation has no missing version');
    }
    return 'npm-ci';
  }
  if (observation === 'migration_verification_invalid') {
    if (manifest.migrations !== null) throw new TypeError('migration-verification observation has evidence');
    return 'fresh-d1';
  }
  if (observation === 'artifact_collection_invalid') {
    if (manifest.artifacts === null) return 'build';
    if (manifest.artifacts.secondTreeSha256 === null) return 'playwright';
    if (manifest.artifacts.dryRunWorkerSha256 === null) return 'wrangler-dry-run';
    throw new TypeError('artifact-collection observation has no missing aggregate');
  }
  if (observation === 'binding_collection_invalid') {
    if (manifest.bindings === null || manifest.bindings.firstBuildTopologySha256 === null) return 'build';
    if (manifest.bindings.secondBuildTopologySha256 === null) return 'playwright';
    throw new TypeError('binding-collection observation has no missing aggregate');
  }

  const lastPassed = [...manifest.commands].reverse().find((command) => command.status === 'passed')?.id;
  const permitted = observation === 'client_identity_leak'
    ? ['build', 'playwright']
    : ['build', 'playwright', 'wrangler-dry-run'];
  if (!lastPassed || !permitted.includes(lastPassed)) {
    throw new TypeError('identity or secret observation has no completed artifact stage');
  }
  return lastPassed;
}

function enforceStageEvidence(
  code: ReleaseFailureCode | null,
  observation: EvidenceFailureObservation | null,
  manifest: Pick<CandidateManifest, 'tests' | 'migrations' | 'bindings' | 'artifacts' | 'execution' | 'commands'>,
): void {
  const observationStage = code === 'evidence_invalid' && observation !== null
    ? evidenceStage(observation, manifest)
    : null;
  if (observationStage) assertStoppedAfter(manifest.commands, observationStage);

  const reports: Array<{
    id: 'unit-ui' | 'worker' | 'playwright';
    counts: TestCounts | null;
    observation: EvidenceFailureObservation;
  }> = [
    { id: 'unit-ui', counts: manifest.tests.unitUi, observation: 'unit_report_missing_or_invalid' },
    { id: 'worker', counts: manifest.tests.worker, observation: 'worker_report_missing_or_invalid' },
    { id: 'playwright', counts: manifest.tests.playwright, observation: 'playwright_report_missing_or_invalid' },
  ];
  for (const report of reports) {
    const command = commandById(manifest.commands, report.id);
    const matchingFailure = code === 'evidence_invalid' && observation === report.observation;
    if (command.status === 'passed') {
      if (report.counts === null && !matchingFailure) {
        throw new TypeError(`${report.id} passed without report evidence`);
      }
      if (report.counts !== null && report.counts.failed !== 0) {
        throw new TypeError(`${report.id} exited zero with failed test counts`);
      }
    } else if (report.counts !== null) {
      throw new TypeError(`${report.id} did not pass but has report evidence`);
    }
    if (matchingFailure && (command.status !== 'passed' || report.counts !== null)) {
      throw new TypeError(`${report.id} report failure does not match its command`);
    }
  }

  const npmPassed = commandById(manifest.commands, 'npm-ci').status === 'passed';
  const missingTool = toolVersionKeys.some((key) => manifest.execution.tools[key] === null);
  const toolFailure = code === 'evidence_invalid' && observation === 'tool_version_invalid';
  if (!npmPassed && installedToolVersionKeys.some((key) => manifest.execution.tools[key] !== null)) {
    throw new TypeError('dependency tool evidence exists before npm-ci succeeded');
  }
  if (npmPassed && missingTool && !toolFailure) {
    throw new TypeError('installed tool version evidence is missing');
  }
  if (toolFailure && (!npmPassed || !missingTool)) throw new TypeError('tool failure does not match npm-ci');

  const buildStatus = commandById(manifest.commands, 'build').status;
  const missingArtifactsAllowed = code === 'evidence_invalid'
    && (observation === 'artifact_collection_invalid' || observation === 'forbidden_secret_file');
  const missingBindingsAllowed = code === 'evidence_invalid'
    && (observation === 'artifact_collection_invalid' || observation === 'binding_collection_invalid'
      || observation === 'forbidden_secret_file');
  if (buildStatus !== 'passed') {
    if (manifest.artifacts !== null || manifest.bindings !== null) {
      throw new TypeError('pre-build manifest contains build evidence');
    }
  } else {
    if (manifest.artifacts === null && !missingArtifactsAllowed) throw new TypeError('build passed without artifact evidence');
    if (manifest.bindings === null && !missingBindingsAllowed) throw new TypeError('build passed without binding evidence');
    if (manifest.bindings !== null && manifest.bindings.firstBuildTopologySha256 === null
      && !missingBindingsAllowed) {
      throw new TypeError('build passed without first topology evidence');
    }
  }

  const playwrightPassed = commandById(manifest.commands, 'playwright').status === 'passed';
  const missingSecondAllowed = observationStage === 'playwright';
  if (!playwrightPassed) {
    if (manifest.artifacts?.secondTreeSha256 !== null && manifest.artifacts !== null) {
      throw new TypeError('pre-Playwright manifest contains second artifact evidence');
    }
    if (manifest.bindings?.secondBuildTopologySha256 !== null && manifest.bindings !== null) {
      throw new TypeError('pre-Playwright manifest contains second topology evidence');
    }
  } else {
    if (manifest.artifacts !== null && manifest.artifacts.secondTreeSha256 === null && !missingSecondAllowed) {
      throw new TypeError('Playwright passed without second artifact evidence');
    }
    if (manifest.bindings !== null && manifest.bindings.secondBuildTopologySha256 === null && !missingSecondAllowed) {
      throw new TypeError('Playwright passed without second topology evidence');
    }
  }

  const dryRunPassed = commandById(manifest.commands, 'wrangler-dry-run').status === 'passed';
  const missingDryRunAllowed = observationStage === 'wrangler-dry-run';
  if (!dryRunPassed) {
    if (manifest.artifacts?.dryRunWorkerSha256 !== null && manifest.artifacts !== null) {
      throw new TypeError('pre-dry-run manifest contains dry-run evidence');
    }
  } else if (manifest.artifacts !== null && manifest.artifacts.dryRunWorkerSha256 === null && !missingDryRunAllowed) {
    throw new TypeError('dry run passed without Worker evidence');
  }

  const freshD1Passed = commandById(manifest.commands, 'fresh-d1').status === 'passed';
  const migrationFailure = code === 'evidence_invalid' && observation === 'migration_verification_invalid';
  if (!freshD1Passed) {
    if (manifest.migrations !== null) throw new TypeError('pre-fresh-D1 manifest contains migration verification');
  } else if (manifest.migrations === null && !migrationFailure) {
    throw new TypeError('fresh D1 passed without migration verification');
  }
}

export function assertRedactedCandidateManifest(value: unknown): asserts value is CandidateManifest {
  const root = exactRecord(value, [
    'kind', 'schemaVersion', 'status', 'failureCode', 'failureObservation', 'preconditionObservation', 'runId',
    'candidate', 'execution', 'commands', 'tests', 'migrations', 'bindings', 'artifacts', 'claims',
  ], 'candidate manifest');
  if (root.kind !== 'candidary.release-candidate' || root.schemaVersion !== 1) throw new TypeError('manifest identity is invalid');
  const status = oneOf(root.status, ['passed', 'failed'] as const, 'manifest status');
  const code = failureCode(root.failureCode);
  const observation = nullable(root.failureObservation, (item) => oneOf(item, evidenceObservations, 'failureObservation'));
  const precondition = nullable(root.preconditionObservation, (item) => oneOf(item, preconditionObservations, 'preconditionObservation'));
  uuidV4(root.runId, 'runId');
  const candidate = nullable(root.candidate, validateCandidate);
  const execution = validateExecution(root.execution);
  const commands = validateCommands(root.commands);
  const testsRecord = exactRecord(root.tests, ['unitUi', 'worker', 'playwright'], 'tests');
  const tests = {
    unitUi: nullable(testsRecord.unitUi, (item) => parseTestCounts(item, 'unitUi tests')),
    worker: nullable(testsRecord.worker, (item) => parseTestCounts(item, 'worker tests')),
    playwright: nullable(testsRecord.playwright, (item) => parseTestCounts(item, 'playwright tests')),
  };
  const migrations = nullable(root.migrations, validateMigrations);
  const bindings = nullable(root.bindings, validateBindings);
  const artifacts = nullable(root.artifacts, validateArtifacts);
  const claims = validateClaims(root.claims);

  if (migrations) {
    if (!candidate) throw new TypeError('migration evidence requires candidate identity');
    const manifestDigest = sha256(canonicalJson(migrations.manifest.map(({ path, sha256: digest }) => ({ path, sha256: digest }))));
    const ledgerDigest = sha256(canonicalJson(migrations.manifest.map((file) => basename(file.path))));
    if (candidate.migrationManifestSha256 !== manifestDigest
      || migrations.verification.migrationCount !== migrations.manifest.length
      || migrations.verification.ledgerSha256 !== ledgerDigest) {
      throw new TypeError('migration evidence aggregate is invalid');
    }
  }
  if (bindings && bindings.sourceTopologySha256 !== sha256(canonicalJson(bindings.topology))) {
    throw new TypeError('binding topology aggregate is invalid');
  }
  if (artifacts && artifacts.firstTreeSha256 !== sha256(canonicalJson({ worker: artifacts.worker, client: artifacts.client }))) {
    throw new TypeError('artifact tree aggregate is invalid');
  }

  enforceStageEvidence(code, observation, { tests, migrations, bindings, artifacts, execution, commands });

  const failedCommands = commands.filter((command) => command.status === 'failed');
  const failedCommand = failedCommands[0] ?? null;
  if (status === 'passed') {
    if (code !== null || observation !== null || precondition !== null || !candidate || claims.localAutomated !== 'passed') {
      throw new TypeError('passed manifest has failure state');
    }
    if (commands.some((command) => command.status !== 'passed')) throw new TypeError('passed manifest has incomplete commands');
    if (!tests.unitUi || !tests.worker || !tests.playwright || !migrations || !bindings || !artifacts) {
      throw new TypeError('passed manifest has missing evidence');
    }
    if (tests.unitUi.failed !== 0 || tests.worker.failed !== 0 || tests.playwright.failed !== 0) {
      throw new TypeError('passed manifest has failing tests');
    }
    if (toolVersionKeys.some((key) => execution.tools[key] === null)) throw new TypeError('passed manifest has missing tool versions');
    if (execution.initialDetachedHead !== true || execution.finalDetachedHead !== true
      || execution.initialHeadSha !== candidate.gitSha || execution.finalHeadSha !== candidate.gitSha
      || execution.initialHeadTree !== candidate.gitTree || execution.finalHeadTree !== candidate.gitTree
      || execution.initialStatusSha256 !== emptyStatusSha256 || execution.finalStatusSha256 !== emptyStatusSha256
      || execution.cleanupSucceeded !== true) {
      throw new TypeError('passed manifest Git or cleanup evidence is invalid');
    }
    if (bindings.firstBuildTopologySha256 !== bindings.sourceTopologySha256
      || bindings.secondBuildTopologySha256 !== bindings.sourceTopologySha256
      || artifacts.secondTreeSha256 !== artifacts.firstTreeSha256
      || artifacts.dryRunWorkerSha256 !== artifacts.worker.sha256) {
      throw new TypeError('passed manifest has build drift');
    }
    return;
  }

  if (code === null || claims.localAutomated !== 'failed') throw new TypeError('failed manifest has no closed failure code');
  if (execution.cleanupSucceeded === null) throw new TypeError('failed manifest has no cleanup result');
  if (code === 'precondition_failed') {
    if (precondition === null || observation !== null) throw new TypeError('precondition failure observation is invalid');
  } else if (code === 'evidence_invalid') {
    if (observation === null || precondition !== null) throw new TypeError('evidence failure observation is invalid');
  } else if (observation !== null || precondition !== null) {
    throw new TypeError('failure observations are not valid for this failure code');
  }

  if (code === 'precondition_failed') {
    if ((precondition === 'candidate_identity_unavailable') !== (candidate === null)) {
      throw new TypeError('candidate identity availability does not match the precondition observation');
    }
  } else if (code !== 'cleanup_failed') {
    if (!candidate || execution.initialDetachedHead !== true
      || execution.initialHeadSha !== candidate.gitSha
      || execution.initialHeadTree !== candidate.gitTree
      || execution.initialStatusSha256 !== emptyStatusSha256) {
      throw new TypeError('post-precondition failure has invalid initial identity evidence');
    }
  }

  if (code === 'cleanup_failed') {
    if (execution.cleanupSucceeded !== false) throw new TypeError('cleanup failure has no failed cleanup');
  } else {
    if (execution.cleanupSucceeded !== true) throw new TypeError('failure code requires successful cleanup');
    if (failedCommand) {
      if (code !== `command_failed:${failedCommand.id}`) throw new TypeError('failed command was relabeled');
    } else if (code.startsWith('command_failed:')) {
      throw new TypeError('command failure has no failed command');
    }
  }
  if (code.startsWith('command_failed:') && (!failedCommand || code !== `command_failed:${failedCommand.id}`)) {
    throw new TypeError('command failure does not match tuple');
  }
  if (code !== 'cleanup_failed' && !code.startsWith('command_failed:') && failedCommand) {
    throw new TypeError('non-command failure cannot contain a failed command');
  }

  if (code === 'precondition_failed') {
    const witnessed = precondition === 'candidate_identity_unavailable' ? candidate === null
      : precondition === 'initial_head_not_detached' ? execution.initialDetachedHead !== true
      : precondition === 'initial_head_sha_mismatch' ? candidate !== null && execution.initialHeadSha !== candidate.gitSha
      : precondition === 'initial_head_tree_mismatch' ? candidate !== null && execution.initialHeadTree !== candidate.gitTree
      : precondition === 'initial_status_not_clean' ? execution.initialStatusSha256 !== emptyStatusSha256
      : false;
    if (!witnessed) throw new TypeError('precondition observation has no matching witness');
  }
  if (code === 'artifact_drift') {
    const witnessed = artifacts !== null && (
      (artifacts.secondTreeSha256 !== null && artifacts.secondTreeSha256 !== artifacts.firstTreeSha256)
      || (artifacts.dryRunWorkerSha256 !== null && artifacts.dryRunWorkerSha256 !== artifacts.worker.sha256)
    );
    if (!witnessed) throw new TypeError('artifact drift has no aggregate witness');
  }
  if (code === 'binding_drift') {
    const digests = bindings === null ? [] : [
      bindings.sourceTopologySha256,
      bindings.firstBuildTopologySha256,
      bindings.secondBuildTopologySha256,
    ].filter((digest): digest is string => digest !== null);
    if (digests.length < 2 || new Set(digests).size < 2) throw new TypeError('binding drift has no aggregate witness');
  }
  if (code === 'status_drift') {
    const witnessed = candidate !== null && (
      execution.finalDetachedHead !== true
      || execution.finalHeadSha !== candidate.gitSha
      || execution.finalHeadTree !== candidate.gitTree
      || execution.finalStatusSha256 !== emptyStatusSha256
    );
    if (!witnessed) throw new TypeError('status drift has no final-state witness');
  }
}

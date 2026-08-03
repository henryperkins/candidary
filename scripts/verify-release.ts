import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import type * as ReleaseEvidenceModule from './release-evidence';
import type {
  CandidateManifest,
  CommandResult,
  EvidenceFailureObservation,
  PreconditionFailureObservation,
  ReleaseCommandId,
  ReleaseFailureCode,
  ToolVersions,
} from './release-evidence';

const releaseEvidenceModulePath = './release-evidence.ts';
const releaseEvidence: typeof ReleaseEvidenceModule = await import(releaseEvidenceModulePath);
const assertRedactedCandidateManifest: typeof ReleaseEvidenceModule.assertRedactedCandidateManifest =
  releaseEvidence.assertRedactedCandidateManifest;
const {
  canonicalJson,
  collectDeployableArtifacts,
  collectMigrationManifest,
  normalizedBindingTopology,
  parseMigrationVerification,
  parsePlaywrightReport,
  parseVitestReport,
  sha256,
} = releaseEvidence;

export const APPROVED_RELEASE_BASE_SHA = '0b92387d2e237d568d2514373dcc3044e7960d4b';

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface ReleaseRunRequest {
  callerRoot: string;
  candidateRoot: string;
  runRoot: string;
  runId: string;
  candidateSha: string;
  approvedBaseSha: string;
}

export interface CandidateManifestDraft {
  manifest: CandidateManifest;
}

export interface ReleaseAdapters {
  run(input: {
    executable: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
  }): Promise<{ exitCode: number }>;
  git(args: string[], cwd: string): Promise<{ exitCode: number; stdout: string }>;
  now(): string;
  randomUUID(): string;
}

export interface CandidateReleaseModule {
  runCandidate(request: ReleaseRunRequest): Promise<CandidateManifestDraft>;
  finalizeCandidateManifest(
    draft: CandidateManifestDraft,
    cleanupSucceeded: boolean,
  ): CandidateManifest;
}

export interface ReleaseBootstrapAdapters {
  randomUUID(): string;
  git(args: string[], cwd: string): Promise<{ exitCode: number; stdout: string }>;
  importCandidate(url: string): Promise<CandidateReleaseModule>;
  writeStatus(status: 'bootstrap_failed' | 'bootstrap_cleanup_failed'): void;
  removeRunRoot?(runRoot: string): Promise<void>;
}

export interface ReleaseArguments {
  candidateSha: string;
  approvedBaseSha: string;
}

export interface ReleaseBootstrapResult {
  runRoot: string;
  runId: string;
  outputDirectory: string;
  request: ReleaseRunRequest;
  draft: CandidateManifestDraft;
  candidateModule: CandidateReleaseModule;
}

export interface CandidateEvidenceWriteResult {
  manifestPath: string;
  sidecarPath: string;
  digest: string;
}

export interface ReleaseExecutionResult extends CandidateEvidenceWriteResult {
  outputDirectory: string;
  runRoot: string;
  manifest: CandidateManifest;
}

interface PlannedCommand {
  id: ReleaseCommandId;
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

interface CommandPlanInput {
  candidateSha: string;
  approvedBaseSha: string;
  candidateRoot: string;
  runRoot: string;
  npmCliPath: string;
  wranglerCliPath: string;
  gitExecutable: string;
  env: NodeJS.ProcessEnv;
}

export function parseReleaseArgs(args: readonly string[]): ReleaseArguments {
  let candidateSha: string | undefined;
  let approvedBaseSha: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${flag ?? 'argument'}.`);
    if (flag === '--sha' && candidateSha === undefined) candidateSha = value;
    else if (flag === '--base-sha' && approvedBaseSha === undefined) approvedBaseSha = value;
    else throw new Error(`Unknown or duplicate release argument ${flag}.`);
  }
  if (!candidateSha || !SHA_PATTERN.test(candidateSha)) {
    throw new Error('--sha must be one full lowercase commit SHA.');
  }
  if (!approvedBaseSha || !SHA_PATTERN.test(approvedBaseSha)) {
    throw new Error('--base-sha must be one full lowercase commit SHA.');
  }
  if (approvedBaseSha !== APPROVED_RELEASE_BASE_SHA) {
    throw new Error('--base-sha is not the approved Increment 1 base.');
  }
  return { candidateSha, approvedBaseSha };
}

function forbiddenEnvironmentName(name: string, requiredSecrets: ReadonlySet<string>): boolean {
  const upper = name.toUpperCase();
  return upper.startsWith('VITE_')
    || upper.startsWith('CLOUDFLARE_')
    || upper.startsWith('CF_')
    || upper === 'PLAYWRIGHT_JSON_OUTPUT_FILE'
    || requiredSecrets.has(upper)
    || /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|COOKIE|AUTHORIZATION)(?:_|$)/u.test(upper);
}

const ESSENTIAL_ENVIRONMENT_NAMES = new Set([
  'ALLUSERSPROFILE', 'APPDATA', 'CHROME_BIN', 'COLORTERM', 'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432', 'COMPUTERNAME', 'COMSPEC',
  'HOMEDRIVE', 'HOMEPATH', 'HOME', 'LANG', 'LANGUAGE', 'LOCALAPPDATA', 'LOGNAME',
  'NODE_EXTRA_CA_CERTS', 'NO_PROXY', 'NUMBER_OF_PROCESSORS',
  'NPM_CONFIG_CACHE', 'OPENSSL_CONF', 'OS', 'PATH', 'PATHEXT',
  'PLAYWRIGHT_BROWSERS_PATH', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'PROGRAMDATA', 'PROGRAMFILES',
  'PROGRAMFILES(X86)', 'PROGRAMW6432', 'PUBLIC', 'SHELL', 'SSL_CERT_DIR',
  'SSL_CERT_FILE', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TERM', 'TMP', 'TMPDIR',
  'TZ', 'USER', 'USERNAME', 'USERPROFILE', 'WINDIR', 'XDG_CACHE_HOME',
]);

function essentialEnvironmentName(name: string): boolean {
  const upper = name.toUpperCase();
  return ESSENTIAL_ENVIRONMENT_NAMES.has(upper)
    || upper.startsWith('LC_')
    || upper === 'HTTP_PROXY'
    || upper === 'HTTPS_PROXY'
    || upper === 'ALL_PROXY';
}

function sanitizedEnvironment(
  source: NodeJS.ProcessEnv,
  requiredSecretNames: readonly string[],
): NodeJS.ProcessEnv {
  const requiredSecrets = new Set(requiredSecretNames.map((name) => name.toUpperCase()));
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined
      && essentialEnvironmentName(name)
      && !forbiddenEnvironmentName(name, requiredSecrets)) {
      env[name] = value;
    }
  }
  env.CI = '1';
  env.WRANGLER_SEND_METRICS = 'false';
  env.CLOUDFLARE_VITE_FORCE_LOCAL = 'true';
  return env;
}

function buildCommandPlan(input: CommandPlanInput): PlannedCommand[] {
  const unitReport = resolve(input.runRoot, 'unit-report.json');
  const workerReport = resolve(input.runRoot, 'worker-report.json');
  const playwrightReport = resolve(input.runRoot, 'playwright-report.json');
  const migrationReport = resolve(input.runRoot, 'migration-verification.json');
  const dryRunRoot = resolve(input.runRoot, 'wrangler-dry-run');
  const npm = (id: ReleaseCommandId, args: string[], env = input.env): PlannedCommand => ({
    id,
    executable: process.execPath,
    args: [input.npmCliPath, ...args],
    env,
  });
  return [
    npm('npm-ci', ['ci']),
    npm('verify-bindings', ['run', 'verify:bindings']),
    npm('typecheck', ['run', 'typecheck']),
    npm('typecheck-e2e', ['run', 'typecheck:e2e']),
    npm('lint', ['run', 'lint']),
    npm('unit-ui', ['run', 'test:unit', '--', '--reporter=default', '--reporter=json', `--outputFile.json=${unitReport}`]),
    npm('worker', ['run', 'test:worker', '--', '--reporter=default', '--reporter=json', `--outputFile.json=${workerReport}`]),
    npm('build', ['run', 'build']),
    npm('pwa-before-e2e', ['run', 'verify:pwa-build']),
    npm('playwright', ['run', 'test:e2e', '--', '--reporter=list,json'], {
      ...input.env,
      PLAYWRIGHT_JSON_OUTPUT_FILE: playwrightReport,
    }),
    npm('pwa-after-e2e', ['run', 'verify:pwa-build']),
    {
      id: 'wrangler-dry-run',
      executable: process.execPath,
      args: [
        input.wranglerCliPath,
        'deploy',
        '--config',
        'dist/candidary/wrangler.json',
        '--dry-run',
        '--strict',
        '--tag',
        input.candidateSha,
        '--outdir',
        dryRunRoot,
      ],
      env: input.env,
    },
    npm('fresh-d1', [
      'run',
      'verify:fresh-d1',
      '--',
      '--run-root',
      input.runRoot,
      '--report-file',
      migrationReport,
    ]),
    {
      id: 'diff-check',
      executable: input.gitExecutable,
      args: ['diff', '--check', `${input.approvedBaseSha}..${input.candidateSha}`],
      env: input.env,
    },
  ];
}

async function existingModulePath(importer: string, specifier: string): Promise<string> {
  const unresolved = resolve(dirname(importer), specifier);
  const candidates = extname(unresolved) === ''
    ? [`${unresolved}.ts`, `${unresolved}.json`, join(unresolved, 'index.ts')]
    : [unresolved];
  for (const candidate of candidates) {
    try {
      return await realpath(candidate);
    } catch {
      // Try the next dependency-free candidate-module spelling.
    }
  }
  throw new Error(`Bootstrap import ${JSON.stringify(specifier)} from ${importer} does not exist.`);
}

function runtimeSpecifiers(source: string): string[] {
  const withoutTypeImports = source.replace(/^\s*import\s+type\b[^;]*;?/gmu, '');
  const stringConstants = new Map(
    [...withoutTypeImports.matchAll(
      /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(['"])([^'"]+)\2\s*;/gu,
    )].map((match) => [match[1]!, match[3]!] as const),
  );
  for (const match of withoutTypeImports.matchAll(/\bimport\s*\(([^)]*)\)/gu)) {
    const expression = match[1]!.trim();
    const literal = /^(['"])([^'"]+)\1$/u.exec(expression);
    if (literal) continue;
    if (/^[A-Za-z_$][\w$]*$/u.test(expression) && stringConstants.has(expression)) continue;
    if (expression === 'candidateModuleUrl') continue;
    throw new Error('Bootstrap graph contains an unresolved dynamic bootstrap import.');
  }
  const matches = [
    ...withoutTypeImports.matchAll(/\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gu),
    ...withoutTypeImports.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/gu),
  ];
  const computed = [...withoutTypeImports.matchAll(
    /\bimport\(\s*([A-Za-z_$][\w$]*)\s*\)/gu,
  )].map((match) => stringConstants.get(match[1]!)).filter((value): value is string => value !== undefined);
  return [...matches.map((match) => match[1]!), ...computed]
    .filter((value, index, all) => all.indexOf(value) === index);
}

export async function assertDependencyFreeBootstrapGraph(entryPath: string): Promise<string[]> {
  const entry = await realpath(resolve(entryPath));
  const graphRoot = await realpath(resolve(dirname(entry), '..'));
  const visited = new Set<string>();
  const visit = async (modulePath: string): Promise<void> => {
    const path = relative(graphRoot, modulePath);
    if (path.startsWith(`..${sep}`) || path === '..' || isAbsolute(path)) {
      throw new Error('Bootstrap dependency escaped the candidate root.');
    }
    if (visited.has(modulePath)) return;
    visited.add(modulePath);
    if (modulePath.endsWith('.json')) return;
    const source = await readFile(modulePath, 'utf8');
    for (const specifier of runtimeSpecifiers(source)) {
      if (specifier.startsWith('node:')) continue;
      if (!specifier.startsWith('.')) {
        throw new Error(`Bootstrap graph contains bare-package import ${JSON.stringify(specifier)}.`);
      }
      await visit(await existingModulePath(modulePath, specifier));
    }
  };
  await visit(entry);
  return [...visited].sort();
}

function pathWithin(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function missingPath(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function validateCallerOutputChain(callerRoot: string, candidateSha: string): Promise<void> {
  const logicalRoot = resolve(callerRoot);
  const realRoot = await exactDirectory(logicalRoot, 'caller repository root');
  const chain = [
    resolve(logicalRoot, 'output'),
    resolve(logicalRoot, 'output/release'),
    resolve(logicalRoot, 'output/release', candidateSha),
  ];
  for (const [index, directory] of chain.entries()) {
    try {
      const realDirectory = await exactDirectory(directory, 'release output directory');
      if (!pathWithin(realRoot, realDirectory)) {
        throw new Error('Release output chain escapes the caller repository.');
      }
    } catch (error) {
      if (missingPath(error)) {
        if (index < chain.length - 1) {
          for (const child of chain.slice(index + 1)) {
            try {
              await lstat(child);
              throw new Error('Release output chain is discontinuous.', { cause: error });
            } catch (childError) {
              if (!missingPath(childError)) throw childError;
            }
          }
        }
        return;
      }
      throw new Error('Release output chain contains a linked, reparse, or non-directory entry.', {
        cause: error,
      });
    }
  }
}

async function createSafeOutputDirectory(
  callerRoot: string,
  candidateSha: string,
  runId: string,
): Promise<string> {
  await validateCallerOutputChain(callerRoot, candidateSha);
  const realCallerRoot = await exactDirectory(resolve(callerRoot), 'caller repository root');
  const parents = [
    resolve(callerRoot, 'output'),
    resolve(callerRoot, 'output/release'),
    resolve(callerRoot, 'output/release', candidateSha),
  ];
  for (const directory of parents) {
    try {
      await mkdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const realDirectory = await exactDirectory(directory, 'release output directory');
    if (!pathWithin(realCallerRoot, realDirectory)) {
      throw new Error('Release output directory resolves outside the caller repository.');
    }
  }
  const outputDirectory = resolve(parents[2]!, runId);
  try {
    await mkdir(outputDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('Release output UUID directory already exists.', { cause: error });
    }
    throw error;
  }
  const realOutputDirectory = await exactDirectory(outputDirectory, 'release output UUID directory');
  if (!pathWithin(realCallerRoot, realOutputDirectory)
    || basename(realOutputDirectory) !== runId
    || basename(dirname(realOutputDirectory)) !== candidateSha) {
    throw new Error('Release output UUID directory is not the exact reserved path.');
  }
  return outputDirectory;
}

function normalizedWorktreePath(path: string): string {
  const normalized = resolve(path).replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function registryContainsWorktree(stdout: string, candidateRoot: string): boolean {
  const expected = normalizedWorktreePath(candidateRoot);
  return stdout.split(/\r?\n/u)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => normalizedWorktreePath(line.slice('worktree '.length)))
    .includes(expected);
}

async function pathIsAbsent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    return missingPath(error);
  }
}

async function removeValidatedRunRoot(
  runRoot: string,
  candidateRoot: string,
  adapters: ReleaseBootstrapAdapters,
): Promise<boolean> {
  try {
    const realTemp = await realpath(tmpdir());
    const realRun = await exactDirectory(runRoot, 'release run root');
    const runRelative = relative(realTemp, realRun);
    if (runRelative.includes(sep) || !basename(realRun).startsWith('candidary-release-')
      || !await pathIsAbsent(candidateRoot)) {
      return false;
    }
    if (adapters.removeRunRoot) await adapters.removeRunRoot(runRoot);
    else await rm(runRoot, { recursive: true, force: true });
    return await pathIsAbsent(runRoot);
  } catch {
    return false;
  }
}

async function cleanupRegisteredWorktree(
  callerRoot: string,
  runRoot: string,
  candidateRoot: string,
  adapters: ReleaseBootstrapAdapters,
): Promise<boolean> {
  try {
    const removal = await adapters.git(['worktree', 'remove', '--force', candidateRoot], callerRoot);
    if (removal.exitCode !== 0) return false;
    const registry = await adapters.git(['worktree', 'list', '--porcelain'], callerRoot);
    if (registry.exitCode !== 0 || registryContainsWorktree(registry.stdout, candidateRoot)
      || !await pathIsAbsent(candidateRoot)) {
      return false;
    }
    return removeValidatedRunRoot(runRoot, candidateRoot, adapters);
  } catch {
    return false;
  }
}

export async function bootstrapRelease(
  args: readonly string[],
  callerRootInput: string,
  adapters: ReleaseBootstrapAdapters,
): Promise<ReleaseBootstrapResult> {
  const { candidateSha, approvedBaseSha } = parseReleaseArgs(args);
  const callerRoot = resolve(callerRootInput);
  await validateCallerOutputChain(callerRoot, candidateSha);
  const exactObject = async (sha: string): Promise<void> => {
    const result = await adapters.git(['rev-parse', '--verify', `${sha}^{commit}`], callerRoot);
    if (result.exitCode !== 0 || result.stdout !== `${sha}\n`) {
      throw new Error(`${sha} is not one exact commit object.`);
    }
  };
  await exactObject(candidateSha);
  await exactObject(approvedBaseSha);
  const ancestry = await adapters.git(
    ['merge-base', '--is-ancestor', approvedBaseSha, candidateSha],
    callerRoot,
  );
  if (ancestry.exitCode !== 0) throw new Error('Approved base is not an ancestor of the candidate.');

  const runId = adapters.randomUUID();
  if (!UUID_V4_PATTERN.test(runId)) throw new Error('Release run ID must be one lowercase UUID v4.');
  const runRoot = await mkdtemp(join(tmpdir(), 'candidary-release-'));
  const candidateRoot = resolve(runRoot, 'worktree');
  let outputDirectory = resolve(callerRoot, 'output/release', candidateSha, runId);
  let registered = false;
  let outputCreated = false;
  try {
    const add = await adapters.git(
      ['worktree', 'add', '--detach', candidateRoot, candidateSha],
      callerRoot,
    );
    if (add.exitCode !== 0) throw new Error('Could not register detached candidate worktree.');
    registered = true;
    const candidateEntry = resolve(candidateRoot, 'scripts/verify-release.ts');
    const exactCandidateEntry = await exactContainedRegularFile(
      candidateRoot,
      candidateEntry,
      'candidate release module',
    );
    await assertDependencyFreeBootstrapGraph(exactCandidateEntry);
    const candidateModule = await adapters.importCandidate(pathToFileURL(exactCandidateEntry).href);
    if (typeof candidateModule.runCandidate !== 'function'
      || typeof candidateModule.finalizeCandidateManifest !== 'function') {
      throw new Error('Candidate release module exports are incomplete.');
    }
    outputDirectory = await createSafeOutputDirectory(callerRoot, candidateSha, runId);
    outputCreated = true;
    const request: ReleaseRunRequest = {
      callerRoot,
      candidateRoot,
      runRoot,
      runId,
      candidateSha,
      approvedBaseSha,
    };
    const draft = await candidateModule.runCandidate(request);
    if (draft.manifest.runId !== runId) throw new Error('Candidate draft run ID differs from reserved run ID.');
    return { runRoot, runId, outputDirectory, request, draft, candidateModule };
  } catch (error) {
    let outputCleanupSucceeded = true;
    if (outputCreated) {
      try {
        await exactDirectory(outputDirectory, 'release output UUID directory');
        await rmdir(outputDirectory);
      } catch {
        outputCleanupSucceeded = false;
      }
    }
    const cleanupSucceeded = outputCleanupSucceeded && (registered
      ? await cleanupRegisteredWorktree(callerRoot, runRoot, candidateRoot, adapters)
      : await removeValidatedRunRoot(runRoot, candidateRoot, adapters));
    if (cleanupSucceeded) {
      adapters.writeStatus('bootstrap_failed');
      throw new Error('bootstrap_failed', { cause: error });
    }
    adapters.writeStatus('bootstrap_cleanup_failed');
    throw new Error('bootstrap_cleanup_failed', { cause: error });
  }
}

function notRun<Id extends ReleaseCommandId>(id: Id): CommandResult<Id> {
  return { id, status: 'not_run', startedAt: null, finishedAt: null, durationMs: null, exitCode: null };
}

function emptyCommands(): CandidateManifest['commands'] {
  return [
    notRun('npm-ci'),
    notRun('verify-bindings'),
    notRun('typecheck'),
    notRun('typecheck-e2e'),
    notRun('lint'),
    notRun('unit-ui'),
    notRun('worker'),
    notRun('build'),
    notRun('pwa-before-e2e'),
    notRun('playwright'),
    notRun('pwa-after-e2e'),
    notRun('wrangler-dry-run'),
    notRun('fresh-d1'),
    notRun('diff-check'),
  ];
}

function exactShaOutput(result: { exitCode: number; stdout: string }): string | null {
  const match = /^([0-9a-f]{40})\r?\n$/u.exec(result.stdout);
  return result.exitCode === 0 && match ? match[1]! : null;
}

interface GitState {
  detached: boolean | null;
  head: string | null;
  tree: string | null;
  status: string | null;
}

async function currentGitState(adapters: ReleaseAdapters, candidateRoot: string): Promise<GitState> {
  const symbolic = await adapters.git(['symbolic-ref', '-q', 'HEAD'], candidateRoot);
  const head = await adapters.git(['rev-parse', '--verify', 'HEAD^{commit}'], candidateRoot);
  const tree = await adapters.git(['rev-parse', '--verify', 'HEAD^{tree}'], candidateRoot);
  const status = await adapters.git(
    ['status', '--porcelain=v1', '--untracked-files=all'],
    candidateRoot,
  );
  return {
    detached: symbolic.exitCode === 1 ? true : symbolic.exitCode === 0 ? false : null,
    head: exactShaOutput(head),
    tree: exactShaOutput(tree),
    status: status.exitCode === 0 ? status.stdout : null,
  };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

async function readJson(path: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(await exactRegularFile(path, label), 'utf8')) as unknown;
  } catch (error) {
    throw new TypeError(`${label} is missing or invalid.`, { cause: error });
  }
}

async function exactRegularFile(path: string, label: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error(`${label} path must be absolute.`);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be one regular file.`);
  return realpath(path);
}

async function exactDirectory(path: string, label: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error(`${label} path must be absolute.`);
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be one real directory.`);
  return realpath(path);
}

async function exactContainedRegularFile(
  root: string,
  path: string,
  label: string,
): Promise<string> {
  const logicalRoot = resolve(root);
  const logicalPath = resolve(path);
  const logicalRelative = relative(logicalRoot, logicalPath);
  if (logicalRelative === '' || logicalRelative === '..'
    || logicalRelative.startsWith(`..${sep}`) || isAbsolute(logicalRelative)) {
    throw new Error(`${label} must be contained by its expected root.`);
  }
  let current = logicalRoot;
  for (const component of dirname(logicalRelative).split(sep).filter(Boolean)) {
    current = resolve(current, component);
    await exactDirectory(current, `${label} parent`);
  }
  const realRoot = await exactDirectory(logicalRoot, `${label} root`);
  const realFile = await exactRegularFile(logicalPath, label);
  const realRelative = relative(realRoot, realFile);
  if (realRelative === '' || realRelative === '..'
    || realRelative.startsWith(`..${sep}`) || isAbsolute(realRelative)) {
    throw new Error(`${label} resolves outside its expected root.`);
  }
  return realFile;
}

async function resolveNpmCli(): Promise<string> {
  const candidates = [
    isAbsolute(process.env.npm_execpath ?? '') ? process.env.npm_execpath : undefined,
    resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
  ].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);
  for (const candidate of candidates) {
    try {
      const cli = await exactRegularFile(candidate, 'npm CLI');
      if (basename(cli).toLowerCase() === 'npm-cli.js') return cli;
    } catch {
      // Continue through the fixed Node-install locations.
    }
  }
  throw new Error('A validated absolute npm-cli.js could not be resolved.');
}

function parsedVersion(value: unknown): string | null {
  return typeof value === 'string'
    && /^v?\d+(?:\.(?:\d+|[A-Za-z][A-Za-z0-9-]*)){1,7}(?:[-+][0-9A-Za-z.-]+)?$/u.test(value)
    ? value
    : null;
}

async function packageVersion(packageJson: string): Promise<string | null> {
  try {
    const record = asRecord(await readJson(packageJson, 'package metadata'), 'package metadata');
    return parsedVersion(record.version);
  } catch {
    return null;
  }
}

async function initialToolVersions(
  npmCliPath: string,
  adapters: ReleaseAdapters,
  candidateRoot: string,
): Promise<ToolVersions> {
  const npmRoot = resolve(dirname(npmCliPath), '..');
  const gitResult = await adapters.git(['--version'], candidateRoot);
  const gitMatch = gitResult.exitCode === 0
    ? /^git version ([^\s]+)\r?\n$/u.exec(gitResult.stdout)
    : null;
  return {
    node: parsedVersion(process.version),
    npm: await packageVersion(resolve(npmRoot, 'package.json')),
    git: parsedVersion(gitMatch?.[1]),
    typescript: null,
    eslint: null,
    vite: null,
    vitest: null,
    playwright: null,
    wrangler: null,
  };
}

async function collectInstalledToolVersions(
  candidateRoot: string,
  current: ToolVersions,
): Promise<ToolVersions> {
  const packageNames: Array<[keyof ToolVersions, string]> = [
    ['typescript', 'typescript'],
    ['eslint', 'eslint'],
    ['vite', 'vite'],
    ['vitest', 'vitest'],
    ['playwright', '@playwright/test'],
    ['wrangler', 'wrangler'],
  ];
  const result = { ...current };
  for (const [key, packageName] of packageNames) {
    const packageJson = resolve(candidateRoot, 'node_modules', packageName, 'package.json');
    try {
      result[key] = await packageVersion(await exactContainedRegularFile(
        candidateRoot,
        packageJson,
        `${packageName} package metadata`,
      ));
    } catch {
      result[key] = null;
    }
  }
  return result;
}

function statusDigest(status: string | null): string | null {
  return status === null ? null : sha256(status);
}

async function forbiddenSecretFile(root: string): Promise<boolean> {
  const visit = async (directory: string): Promise<boolean> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const lower = entry.name.toLowerCase();
      if (lower.startsWith('.env') || lower.startsWith('.dev.vars')) return true;
      const target = resolve(directory, entry.name);
      const stat = await lstat(target);
      if (stat.isSymbolicLink()) throw new Error('Evidence output contains a symbolic link.');
      if (stat.isDirectory() && await visit(target)) return true;
      if (!stat.isDirectory() && !stat.isFile()) throw new Error('Evidence output contains a non-regular entry.');
    }
    return false;
  };
  return visit(await exactDirectory(root, 'evidence output root'));
}

async function clientIdentityLeak(
  clientRoot: string,
  literals: readonly string[],
): Promise<boolean> {
  const visit = async (directory: string): Promise<boolean> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (await visit(target)) return true;
      } else if (/\.(?:c?m?js|html)$/iu.test(entry.name)) {
        const contents = await readFile(await exactRegularFile(target, 'client artifact'), 'utf8');
        if (literals.some((literal) => contents.includes(literal))) return true;
      }
    }
    return false;
  };
  return visit(clientRoot);
}

async function workerIdentityObservation(
  workerPath: string,
  candidateSha: string,
  migrationDigest: string,
): Promise<EvidenceFailureObservation | null> {
  const contents = await readFile(await exactRegularFile(workerPath, 'Worker artifact'), 'utf8');
  if (!contents.includes(candidateSha) || !contents.includes(migrationDigest)) {
    return 'worker_identity_literal_missing';
  }
  if (contents.includes('__CANDIDARY_BUILD_SHA__')
    || contents.includes('__CANDIDARY_MIGRATION_MANIFEST_SHA256__')) {
    return 'worker_identity_global_unreplaced';
  }
  return null;
}

async function dryRunWorkerSha(root: string): Promise<string> {
  const exactRoot = await exactDirectory(root, 'Wrangler dry-run output');
  const entries = await readdir(exactRoot, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  if (names.length !== 2 || names[0] !== 'README.md' || names[1] !== 'index.js'
    || entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    throw new Error('Wrangler dry-run output contains unexpected files.');
  }
  const readme = await readFile(
    await exactContainedRegularFile(exactRoot, resolve(exactRoot, 'README.md'), 'Wrangler dry-run README'),
    'utf8',
  );
  if (!/^This folder contains the built output assets for the worker "candidary" generated at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\.$/u.test(readme)) {
    throw new Error('Wrangler dry-run README is not the timestamped metadata file.');
  }
  return sha256(await readFile(
    await exactContainedRegularFile(exactRoot, resolve(exactRoot, 'index.js'), 'Wrangler dry-run Worker'),
  ));
}

async function generatedBindingTopology(candidateRoot: string): Promise<{
  topology: ReturnType<typeof normalizedBindingTopology>;
  sha256: string;
}> {
  const config = await readJson(
    resolve(candidateRoot, 'dist/candidary/wrangler.json'),
    'generated Wrangler config',
  );
  const topology = normalizedBindingTopology(config);
  return { topology, sha256: sha256(canonicalJson(topology)) };
}

async function buildPolicyObservation(
  candidateRoot: string,
  candidateSha: string,
  migrationDigest: string,
): Promise<EvidenceFailureObservation | null> {
  const workerRoot = resolve(candidateRoot, 'dist/candidary');
  const clientRoot = resolve(candidateRoot, 'dist/client');
  if (await forbiddenSecretFile(workerRoot) || await forbiddenSecretFile(clientRoot)) {
    return 'forbidden_secret_file';
  }
  const workerObservation = await workerIdentityObservation(
    resolve(workerRoot, 'index.js'),
    candidateSha,
    migrationDigest,
  );
  if (workerObservation !== null) return workerObservation;
  return await clientIdentityLeak(clientRoot, [
    candidateSha,
    migrationDigest,
    '__CANDIDARY_BUILD_SHA__',
    '__CANDIDARY_MIGRATION_MANIFEST_SHA256__',
  ])
    ? 'client_identity_leak'
    : null;
}

function commandRecord(
  id: ReleaseCommandId,
  status: 'passed' | 'failed',
  startedAt: string,
  finishedAt: string,
  exitCode: number | null,
): CommandResult<ReleaseCommandId> {
  const durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
  return { id, status, startedAt, finishedAt, durationMs, exitCode };
}

function applyCommand(
  commands: CandidateManifest['commands'],
  index: number,
  record: CommandResult<ReleaseCommandId>,
): void {
  Object.assign(commands[index]!, record);
}

function setFailure(
  manifest: CandidateManifest,
  code: ReleaseFailureCode,
  observation: EvidenceFailureObservation | null = null,
  precondition: PreconditionFailureObservation | null = null,
): void {
  manifest.status = 'failed';
  manifest.failureCode = code;
  manifest.failureObservation = observation;
  manifest.preconditionObservation = precondition;
  manifest.claims.localAutomated = 'failed';
}

async function assertRequestLayout(request: ReleaseRunRequest): Promise<void> {
  if (!SHA_PATTERN.test(request.candidateSha)) throw new Error('Candidate SHA must be one full lowercase commit ID.');
  if (request.approvedBaseSha !== APPROVED_RELEASE_BASE_SHA) throw new Error('Approved base SHA is not approved.');
  if (!UUID_V4_PATTERN.test(request.runId)) throw new Error('Run ID must be one lowercase UUID v4.');
  const realTemp = await realpath(tmpdir());
  const realRun = await exactDirectory(request.runRoot, 'run root');
  const runRelative = relative(realTemp, realRun);
  if (runRelative.includes(sep) || !basename(realRun).startsWith('candidary-release-')) {
    throw new Error('Run root must be one direct candidary-release OS-temporary directory.');
  }
  const expectedCandidate = resolve(request.runRoot, 'worktree');
  if (resolve(request.candidateRoot) !== expectedCandidate) {
    throw new Error('Candidate root must be the exact worktree child of run root.');
  }
  const realCandidate = await exactDirectory(request.candidateRoot, 'candidate root');
  if (realCandidate !== await realpath(resolve(realRun, 'worktree'))) {
    throw new Error('Candidate root must be the exact worktree child of run root.');
  }
}

async function assertEvidenceTargetsAbsent(runRoot: string): Promise<void> {
  for (const target of [
    'unit-report.json',
    'worker-report.json',
    'playwright-report.json',
    'migration-verification.json',
    'wrangler-dry-run',
  ]) {
    try {
      await lstat(resolve(runRoot, target));
      throw new Error(`Release evidence target ${target} already exists.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

export async function runCandidate(
  request: ReleaseRunRequest,
  adapters: ReleaseAdapters = defaultReleaseAdapters,
): Promise<CandidateManifestDraft> {
  await assertRequestLayout(request);
  await assertEvidenceTargetsAbsent(request.runRoot);
  const startedAt = adapters.now();
  const manifest: CandidateManifest = {
    kind: 'candidary.release-candidate',
    schemaVersion: 1,
    status: 'failed',
    failureCode: null,
    failureObservation: null,
    preconditionObservation: null,
    runId: request.runId,
    candidate: null,
    execution: {
      startedAt,
      finishedAt: startedAt,
      platform: process.platform,
      arch: process.arch,
      initialDetachedHead: null,
      initialHeadSha: null,
      initialHeadTree: null,
      initialStatusSha256: null,
      finalDetachedHead: null,
      finalHeadSha: null,
      finalHeadTree: null,
      finalStatusSha256: null,
      cleanupSucceeded: null,
      tools: {
        node: null,
        npm: null,
        git: null,
        typescript: null,
        eslint: null,
        vite: null,
        vitest: null,
        playwright: null,
        wrangler: null,
      },
    },
    commands: emptyCommands(),
    tests: { unitUi: null, worker: null, playwright: null },
    migrations: null,
    bindings: null,
    artifacts: null,
    claims: {
      localAutomated: 'failed',
      remoteMigration: 'not_run',
      deployment: 'not_run',
      physicalDevices: 'not_run',
      runtimeCertification: 'not_run',
    },
  };

  let candidateTree: string;
  let migrations: ReturnType<typeof collectMigrationManifest>;
  let sourceTopology: ReturnType<typeof normalizedBindingTopology>;
  let sourceTopologySha256: string;
  let npmCliPath: string;
  let initial: GitState;
  try {
    const candidateObject = exactShaOutput(await adapters.git(
      ['rev-parse', '--verify', `${request.candidateSha}^{commit}`],
      request.candidateRoot,
    ));
    const baseObject = exactShaOutput(await adapters.git(
      ['rev-parse', '--verify', `${request.approvedBaseSha}^{commit}`],
      request.candidateRoot,
    ));
    const candidateTreeValue = exactShaOutput(await adapters.git(
      ['rev-parse', '--verify', `${request.candidateSha}^{tree}`],
      request.candidateRoot,
    ));
    const ancestry = await adapters.git(
      ['merge-base', '--is-ancestor', request.approvedBaseSha, request.candidateSha],
      request.candidateRoot,
    );
    if (candidateObject !== request.candidateSha || baseObject !== request.approvedBaseSha
      || candidateTreeValue === null || ancestry.exitCode !== 0) {
      throw new Error('Candidate or approved-base commit identity is invalid.');
    }
    candidateTree = candidateTreeValue;

    migrations = collectMigrationManifest(request.candidateRoot);
    const packageLock = await readFile(await exactContainedRegularFile(
      request.candidateRoot,
      resolve(request.candidateRoot, 'package-lock.json'),
      'package lock',
    ));
    const sourceWranglerBytes = await readFile(await exactContainedRegularFile(
      request.candidateRoot,
      resolve(request.candidateRoot, 'wrangler.jsonc'),
      'source Wrangler config',
    ));
    const sourceWrangler = JSON.parse(sourceWranglerBytes.toString('utf8')) as unknown;
    sourceTopology = normalizedBindingTopology(sourceWrangler);
    sourceTopologySha256 = sha256(canonicalJson(sourceTopology));
    const releaseConfig = asRecord(
      await readJson(
        await exactContainedRegularFile(
          request.candidateRoot,
          resolve(request.candidateRoot, 'config/release.json'),
          'release config',
        ),
        'release config',
      ),
      'release config',
    );
    if (!Number.isSafeInteger(releaseConfig.guestJourneyVersion)
      || (releaseConfig.guestJourneyVersion as number) <= 0) {
      throw new Error('Release config guestJourneyVersion must be a positive integer.');
    }
    manifest.candidate = {
      gitSha: request.candidateSha,
      approvedBaseSha: request.approvedBaseSha,
      gitTree: candidateTree,
      guestJourneyVersion: releaseConfig.guestJourneyVersion as number,
      migrationManifestSha256: migrations.sha256,
      packageLockSha256: sha256(packageLock),
      sourceWranglerConfigSha256: sha256(sourceWranglerBytes),
    };
    npmCliPath = await resolveNpmCli();
    manifest.execution.tools = await initialToolVersions(
      npmCliPath,
      adapters,
      request.candidateRoot,
    );
    initial = await currentGitState(adapters, request.candidateRoot);
    manifest.execution.initialDetachedHead = initial.detached;
    manifest.execution.initialHeadSha = initial.head;
    manifest.execution.initialHeadTree = initial.tree;
    manifest.execution.initialStatusSha256 = statusDigest(initial.status);
  } catch {
    manifest.candidate = null;
    manifest.execution.initialDetachedHead = null;
    manifest.execution.initialHeadSha = null;
    manifest.execution.initialHeadTree = null;
    manifest.execution.initialStatusSha256 = null;
    setFailure(manifest, 'precondition_failed', null, 'candidate_identity_unavailable');
    manifest.execution.finishedAt = adapters.now();
    return { manifest };
  }

  const precondition = initial.detached !== true ? 'initial_head_not_detached'
    : initial.head !== request.candidateSha ? 'initial_head_sha_mismatch'
    : initial.tree !== candidateTree ? 'initial_head_tree_mismatch'
    : initial.status !== '' ? 'initial_status_not_clean'
    : null;
  if (precondition !== null) {
    setFailure(manifest, 'precondition_failed', null, precondition);
    manifest.execution.finishedAt = adapters.now();
    return { manifest };
  }

  const env = sanitizedEnvironment(process.env, sourceTopology.requiredSecrets);
  const wranglerCliPath = resolve(
    request.candidateRoot,
    'node_modules/wrangler/bin/wrangler.js',
  );
  const plan = buildCommandPlan({
    candidateSha: request.candidateSha,
    approvedBaseSha: request.approvedBaseSha,
    candidateRoot: request.candidateRoot,
    runRoot: request.runRoot,
    npmCliPath,
    wranglerCliPath,
    gitExecutable: process.platform === 'win32' ? 'git.exe' : 'git',
    env,
  });
  let generatedTypesSha256: string | null = null;

  for (const [index, command] of plan.entries()) {
    const commandStartedAt = adapters.now();
    let exitCode: number | null;
    try {
      const result = await adapters.run({
        executable: command.executable,
        args: [...command.args],
        cwd: request.candidateRoot,
        env: { ...command.env },
      });
      exitCode = Number.isSafeInteger(result.exitCode) ? result.exitCode : null;
    } catch {
      exitCode = null;
    }
    const commandFinishedAt = adapters.now();
    if (exitCode !== 0) {
      applyCommand(
        manifest.commands,
        index,
        commandRecord(command.id, 'failed', commandStartedAt, commandFinishedAt, exitCode),
      );
      setFailure(manifest, `command_failed:${command.id}`);
      break;
    }
    applyCommand(
      manifest.commands,
      index,
      commandRecord(command.id, 'passed', commandStartedAt, commandFinishedAt, 0),
    );

    if (command.id === 'npm-ci') {
      try {
        await exactContainedRegularFile(
          request.candidateRoot,
          wranglerCliPath,
          'candidate-local Wrangler CLI',
        );
        manifest.execution.tools = await collectInstalledToolVersions(
          request.candidateRoot,
          manifest.execution.tools,
        );
      } catch {
        // Missing package metadata is represented by the null fixed-key inventory below.
      }
      if (Object.values(manifest.execution.tools).some((version) => version === null)) {
        setFailure(manifest, 'evidence_invalid', 'tool_version_invalid');
        break;
      }
    } else if (command.id === 'verify-bindings') {
      try {
        generatedTypesSha256 = sha256(
          await readFile(await exactContainedRegularFile(
            request.candidateRoot,
            resolve(request.candidateRoot, 'worker-configuration.d.ts'),
            'generated binding types',
          )),
        );
      } catch {
        generatedTypesSha256 = null;
      }
    } else if (command.id === 'unit-ui' || command.id === 'worker') {
      const reportPath = resolve(
        request.runRoot,
        command.id === 'unit-ui' ? 'unit-report.json' : 'worker-report.json',
      );
      try {
        const counts = parseVitestReport(await readJson(
          await exactContainedRegularFile(request.runRoot, reportPath, `${command.id} report`),
          `${command.id} report`,
        ));
        if (command.id === 'unit-ui') manifest.tests.unitUi = counts;
        else manifest.tests.worker = counts;
      } catch {
        setFailure(
          manifest,
          'evidence_invalid',
          command.id === 'unit-ui'
            ? 'unit_report_missing_or_invalid'
            : 'worker_report_missing_or_invalid',
        );
        break;
      }
    } else if (command.id === 'build') {
      if (generatedTypesSha256 === null) {
        setFailure(manifest, 'evidence_invalid', 'binding_collection_invalid');
        break;
      }
      try {
        if (await forbiddenSecretFile(resolve(request.candidateRoot, 'dist/candidary'))
          || await forbiddenSecretFile(resolve(request.candidateRoot, 'dist/client'))) {
          setFailure(manifest, 'evidence_invalid', 'forbidden_secret_file');
          break;
        }
      } catch {
        setFailure(manifest, 'evidence_invalid', 'artifact_collection_invalid');
        break;
      }
      try {
        const first = collectDeployableArtifacts(request.candidateRoot);
        manifest.artifacts = {
          worker: first.worker,
          client: first.client,
          firstTreeSha256: first.treeSha256,
          secondTreeSha256: null,
          dryRunWorkerSha256: null,
        };
      } catch {
        setFailure(manifest, 'evidence_invalid', 'artifact_collection_invalid');
        break;
      }
      try {
        const generated = await generatedBindingTopology(request.candidateRoot);
        manifest.bindings = {
          topology: sourceTopology,
          sourceTopologySha256,
          firstBuildTopologySha256: generated.sha256,
          secondBuildTopologySha256: null,
          generatedTypesSha256,
        };
      } catch {
        setFailure(manifest, 'evidence_invalid', 'binding_collection_invalid');
        break;
      }
      try {
        const observation = await buildPolicyObservation(
          request.candidateRoot,
          request.candidateSha,
          migrations.sha256,
        );
        if (observation !== null) {
          setFailure(manifest, 'evidence_invalid', observation);
          break;
        }
      } catch {
        setFailure(manifest, 'evidence_invalid', 'artifact_collection_invalid');
        break;
      }
      if (manifest.bindings.firstBuildTopologySha256 !== sourceTopologySha256) {
        setFailure(manifest, 'binding_drift');
        break;
      }
    } else if (command.id === 'playwright') {
      try {
        const reportPath = resolve(request.runRoot, 'playwright-report.json');
        manifest.tests.playwright = parsePlaywrightReport(await readJson(
          await exactContainedRegularFile(request.runRoot, reportPath, 'Playwright report'),
          'Playwright report',
        ));
      } catch {
        setFailure(manifest, 'evidence_invalid', 'playwright_report_missing_or_invalid');
        break;
      }
      try {
        if (await forbiddenSecretFile(resolve(request.candidateRoot, 'dist/candidary'))
          || await forbiddenSecretFile(resolve(request.candidateRoot, 'dist/client'))) {
          setFailure(manifest, 'evidence_invalid', 'forbidden_secret_file');
          break;
        }
      } catch {
        setFailure(manifest, 'evidence_invalid', 'artifact_collection_invalid');
        break;
      }
      if (manifest.artifacts === null || manifest.bindings === null) {
        setFailure(manifest, 'evidence_invalid', 'artifact_collection_invalid');
        break;
      }
      try {
        const second = collectDeployableArtifacts(request.candidateRoot);
        manifest.artifacts.secondTreeSha256 = second.treeSha256;
      } catch {
        setFailure(manifest, 'evidence_invalid', 'artifact_collection_invalid');
        break;
      }
      try {
        const generated = await generatedBindingTopology(request.candidateRoot);
        manifest.bindings.secondBuildTopologySha256 = generated.sha256;
      } catch {
        setFailure(manifest, 'evidence_invalid', 'binding_collection_invalid');
        break;
      }
      try {
        const observation = await buildPolicyObservation(
          request.candidateRoot,
          request.candidateSha,
          migrations.sha256,
        );
        if (observation !== null) {
          setFailure(manifest, 'evidence_invalid', observation);
          break;
        }
      } catch {
        setFailure(manifest, 'evidence_invalid', 'artifact_collection_invalid');
        break;
      }
      if (manifest.artifacts.secondTreeSha256 !== manifest.artifacts.firstTreeSha256) {
        setFailure(manifest, 'artifact_drift');
        break;
      }
      if (manifest.bindings.secondBuildTopologySha256 !== sourceTopologySha256) {
        setFailure(manifest, 'binding_drift');
        break;
      }
    } else if (command.id === 'wrangler-dry-run') {
      if (manifest.artifacts === null) {
        setFailure(manifest, 'evidence_invalid', 'artifact_collection_invalid');
        break;
      }
      const dryRunRoot = resolve(request.runRoot, 'wrangler-dry-run');
      try {
        if (await forbiddenSecretFile(dryRunRoot)) {
          setFailure(manifest, 'evidence_invalid', 'forbidden_secret_file');
          break;
        }
        manifest.artifacts.dryRunWorkerSha256 = await dryRunWorkerSha(dryRunRoot);
      } catch {
        setFailure(manifest, 'evidence_invalid', 'artifact_collection_invalid');
        break;
      }
      if (manifest.artifacts.dryRunWorkerSha256 !== manifest.artifacts.worker.sha256) {
        setFailure(manifest, 'artifact_drift');
        break;
      }
    } else if (command.id === 'fresh-d1') {
      try {
        const reportPath = resolve(request.runRoot, 'migration-verification.json');
        const verification = parseMigrationVerification(await readJson(
          await exactContainedRegularFile(request.runRoot, reportPath, 'migration verification report'),
          'migration verification report',
        ));
        const expectedLedgerSha256 = sha256(canonicalJson(
          migrations.files.map((file) => basename(file.path)),
        ));
        if (verification.migrationCount !== migrations.files.length
          || verification.ledgerSha256 !== expectedLedgerSha256) {
          throw new TypeError('Migration verification does not match the checked-in ledger.');
        }
        manifest.migrations = { manifest: migrations.files, verification };
      } catch {
        manifest.migrations = null;
        setFailure(manifest, 'evidence_invalid', 'migration_verification_invalid');
        break;
      }
    }
  }

  if (manifest.failureCode === null
    && manifest.commands.every((command) => command.status === 'passed')) {
    try {
      const final = await currentGitState(adapters, request.candidateRoot);
      manifest.execution.finalDetachedHead = final.detached;
      manifest.execution.finalHeadSha = final.head;
      manifest.execution.finalHeadTree = final.tree;
      manifest.execution.finalStatusSha256 = statusDigest(final.status);
      if (final.detached !== true
        || final.head !== request.candidateSha
        || final.tree !== candidateTree
        || final.status !== '') {
        setFailure(manifest, 'status_drift');
      } else {
        manifest.status = 'passed';
        manifest.failureCode = null;
        manifest.failureObservation = null;
        manifest.preconditionObservation = null;
        manifest.claims.localAutomated = 'passed';
      }
    } catch {
      setFailure(manifest, 'status_drift');
    }
  }

  manifest.execution.finishedAt = adapters.now();
  return { manifest };
}

export function finalizeCandidateManifest(
  draft: CandidateManifestDraft,
  cleanupSucceeded: boolean,
): CandidateManifest {
  if (draft.manifest.execution.cleanupSucceeded !== null) {
    throw new Error('Candidate manifest was already finalized.');
  }
  const manifest = structuredClone(draft.manifest);
  manifest.execution.cleanupSucceeded = cleanupSucceeded;
  if (!cleanupSucceeded) {
    manifest.status = 'failed';
    manifest.failureCode = 'cleanup_failed';
    manifest.failureObservation = null;
    manifest.preconditionObservation = null;
    manifest.claims.localAutomated = 'failed';
  }
  assertRedactedCandidateManifest(manifest);
  return manifest;
}

async function assertEvidenceOutputTargetsAbsent(paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    try {
      await lstat(path);
      throw new Error(`Release evidence target ${basename(path)} already exists.`);
    } catch (error) {
      if (!missingPath(error)) throw error;
    }
  }
}

async function writeExclusiveTemporaryFile(path: string, contents: string): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeCandidateEvidence(
  outputDirectoryInput: string,
  manifest: CandidateManifest,
): Promise<CandidateEvidenceWriteResult> {
  assertRedactedCandidateManifest(manifest);
  const outputDirectory = resolve(outputDirectoryInput);
  const candidateOutputDirectory = dirname(outputDirectory);
  const releaseOutputDirectory = dirname(candidateOutputDirectory);
  const outputRoot = dirname(releaseOutputDirectory);
  const callerRoot = dirname(outputRoot);
  const outputSha = basename(candidateOutputDirectory);
  if (basename(outputRoot) !== 'output' || basename(releaseOutputDirectory) !== 'release'
    || basename(outputDirectory) !== manifest.runId || !SHA_PATTERN.test(outputSha)
    || (manifest.candidate !== null && manifest.candidate.gitSha !== outputSha)) {
    throw new Error('Release evidence output directory does not match the manifest identity.');
  }
  await validateCallerOutputChain(callerRoot, outputSha);
  const realOutputDirectory = await exactDirectory(outputDirectory, 'release evidence output directory');
  const realCandidateOutputDirectory = await exactDirectory(
    candidateOutputDirectory,
    'candidate release output directory',
  );
  if (dirname(realOutputDirectory) !== realCandidateOutputDirectory) {
    throw new Error('Release evidence output directory does not match the manifest identity.');
  }

  const manifestPath = resolve(outputDirectory, 'candidate-manifest.json');
  const sidecarPath = `${manifestPath}.sha256`;
  const manifestTemporaryPath = resolve(
    outputDirectory,
    `.${manifest.runId}.candidate-manifest.json.tmp`,
  );
  const sidecarTemporaryPath = resolve(
    outputDirectory,
    `.${manifest.runId}.candidate-manifest.json.sha256.tmp`,
  );
  await assertEvidenceOutputTargetsAbsent([
    manifestPath,
    sidecarPath,
    manifestTemporaryPath,
    sidecarTemporaryPath,
  ]);
  if ((await readdir(outputDirectory)).length !== 0) {
    throw new Error('Release evidence output directory must be empty before publication.');
  }

  const manifestBytes = `${canonicalJson(manifest)}\n`;
  const digest = sha256(manifestBytes);
  const sidecarBytes = `${digest}  candidate-manifest.json\n`;
  try {
    await writeExclusiveTemporaryFile(manifestTemporaryPath, manifestBytes);
    await writeExclusiveTemporaryFile(sidecarTemporaryPath, sidecarBytes);
    await assertEvidenceOutputTargetsAbsent([manifestPath, sidecarPath]);
    await rename(sidecarTemporaryPath, sidecarPath);
    await rename(manifestTemporaryPath, manifestPath);
  } catch (error) {
    await Promise.all([
      rm(manifestTemporaryPath, { force: true }),
      rm(sidecarTemporaryPath, { force: true }),
    ]);
    throw error;
  }

  await exactContainedRegularFile(outputDirectory, manifestPath, 'candidate manifest');
  await exactContainedRegularFile(outputDirectory, sidecarPath, 'candidate manifest sidecar');
  if (await readFile(manifestPath, 'utf8') !== manifestBytes
    || await readFile(sidecarPath, 'utf8') !== sidecarBytes) {
    throw new Error('Published candidate evidence bytes do not match their canonical values.');
  }
  return { manifestPath, sidecarPath, digest };
}

export async function executeRelease(
  args: readonly string[],
  callerRoot = process.cwd(),
  adapters: ReleaseBootstrapAdapters = defaultBootstrapAdapters,
): Promise<ReleaseExecutionResult> {
  const bootstrap = await bootstrapRelease(args, callerRoot, adapters);
  const cleanupSucceeded = await cleanupRegisteredWorktree(
    bootstrap.request.callerRoot,
    bootstrap.runRoot,
    bootstrap.request.candidateRoot,
    adapters,
  );
  const manifest = bootstrap.candidateModule.finalizeCandidateManifest(
    bootstrap.draft,
    cleanupSucceeded,
  );
  const evidence = await writeCandidateEvidence(bootstrap.outputDirectory, manifest);
  return {
    ...evidence,
    outputDirectory: bootstrap.outputDirectory,
    runRoot: bootstrap.runRoot,
    manifest,
  };
}

const defaultReleaseAdapters: ReleaseAdapters = {
  async run(input) {
    return new Promise((resolveResult, reject) => {
      const child = spawn(input.executable, input.args, {
        cwd: input.cwd,
        env: input.env,
        shell: false,
        stdio: 'inherit',
      });
      child.once('error', reject);
      child.once('close', (code) => resolveResult({ exitCode: code ?? -1 }));
    });
  },
  async git(args, cwd) {
    return new Promise((resolveResult, reject) => {
      const child = spawn('git', args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'inherit'] });
      let stdout = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { stdout += chunk; });
      child.once('error', reject);
      child.once('close', (code) => resolveResult({ exitCode: code ?? -1, stdout }));
    });
  },
  now: () => new Date().toISOString(),
  randomUUID,
};

const defaultBootstrapAdapters: ReleaseBootstrapAdapters = {
  randomUUID,
  git: defaultReleaseAdapters.git,
  async importCandidate(candidateModuleUrl) {
    return await import(candidateModuleUrl) as CandidateReleaseModule;
  },
  writeStatus(status) {
    process.stderr.write(`${status}\n`);
  },
  async removeRunRoot(runRoot) {
    await rm(runRoot, { recursive: true, force: true });
  },
};

async function runReleaseCli(): Promise<void> {
  try {
    const result = await executeRelease(process.argv.slice(2));
    process.stdout.write(`candidate_manifest=${result.manifestPath}\n`);
    process.stdout.write(`candidate_manifest_sha256=${result.digest}\n`);
    if (!result.manifest.execution.cleanupSucceeded) {
      process.stderr.write(`cleanup_failed ${result.runRoot}\n`);
    } else if (result.manifest.status === 'failed') {
      process.stderr.write(`${result.manifest.failureCode}\n`);
    }
    if (result.manifest.status !== 'passed') process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message !== 'bootstrap_failed' && message !== 'bootstrap_cleanup_failed') {
      process.stderr.write('release_failed\n');
    }
    process.exitCode = 1;
  }
}

if (process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await runReleaseCli();
}

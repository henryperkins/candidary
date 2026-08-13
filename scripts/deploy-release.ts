import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';

import type * as ReleaseEvidenceModule from './release-evidence';
import {
  verifyExactReleaseCandidate,
  type ReleaseCandidateObservationAdapter,
} from './release-candidate';

const releaseEvidenceModulePath = './release-evidence.ts';
const releaseEvidence: typeof ReleaseEvidenceModule = await import(releaseEvidenceModulePath);
const {
  collectDeployableArtifacts,
  deployWranglerConfigBytes,
  sha256,
} = releaseEvidence;

const APPROVED_BASE_SHA = '0b92387d2e237d568d2514373dcc3044e7960d4b';
const SHA_PATTERN = /^[0-9a-f]{40}$/u;

export type DeployCommandId = 'npm-ci' | 'build' | 'verify-pwa-build' | 'deploy';

export interface DeployCommand {
  id: DeployCommandId;
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
}

export interface DeploymentCommandPlanInput {
  candidateRoot: string;
  deployRoot: string;
  sha: string;
  nodeExecPath: string;
  npmCliPath: string;
  wranglerCliPath: string;
  prerequisiteEnv: NodeJS.ProcessEnv;
  deployEnv: NodeJS.ProcessEnv;
}

export interface DeployReleaseRequest {
  candidateRoot: string;
  sha: string;
  manifestPath: string;
}

export interface DeployReleaseAdapters {
  nodeExecPath: string;
  npmExecPath: string | undefined;
  environment: NodeJS.ProcessEnv;
  git(args: string[], cwd: string): string;
  run(command: DeployCommand): number;
}

export interface DeployReleaseArguments {
  sha: string;
  manifestPath: string;
}

function exactArguments(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function forbiddenEnvironmentName(name: string, requiredSecrets: ReadonlySet<string>): boolean {
  const upper = name.toUpperCase();
  return upper.startsWith('VITE_')
    || upper.startsWith('CLOUDFLARE_')
    || upper.startsWith('CF_')
    || requiredSecrets.has(upper)
    || /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|COOKIE|AUTHORIZATION)(?:_|$)/u.test(upper);
}

const ESSENTIAL_ENVIRONMENT_NAMES = new Set([
  'ALLUSERSPROFILE', 'APPDATA', 'COLORTERM', 'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432', 'COMPUTERNAME', 'COMSPEC',
  'HOMEDRIVE', 'HOMEPATH', 'HOME', 'LANG', 'LANGUAGE', 'LOCALAPPDATA', 'LOGNAME',
  'NODE_EXTRA_CA_CERTS', 'NO_PROXY', 'NUMBER_OF_PROCESSORS',
  'NPM_CONFIG_CACHE', 'OPENSSL_CONF', 'OS', 'PATH', 'PATHEXT',
  'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL',
  'PROCESSOR_REVISION', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
  'PROGRAMW6432', 'PUBLIC', 'SHELL', 'SSL_CERT_DIR', 'SSL_CERT_FILE',
  'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TERM', 'TMP', 'TMPDIR', 'TZ', 'USER',
  'USERNAME', 'USERPROFILE', 'WINDIR', 'XDG_CACHE_HOME',
]);

function essentialEnvironmentName(name: string): boolean {
  const upper = name.toUpperCase();
  return ESSENTIAL_ENVIRONMENT_NAMES.has(upper)
    || upper.startsWith('LC_')
    || upper === 'HTTP_PROXY'
    || upper === 'HTTPS_PROXY'
    || upper === 'ALL_PROXY';
}

function sanitizedPrerequisiteEnvironment(
  source: NodeJS.ProcessEnv,
  requiredSecretNames: readonly string[],
): NodeJS.ProcessEnv {
  const requiredSecrets = new Set(requiredSecretNames.map((name) => name.toUpperCase()));
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined
      && essentialEnvironmentName(name)
      && !forbiddenEnvironmentName(name, requiredSecrets)) {
      environment[name] = value;
    }
  }
  environment.CI = '1';
  environment.WRANGLER_SEND_METRICS = 'false';
  environment.CLOUDFLARE_VITE_FORCE_LOCAL = 'true';
  return environment;
}

export function buildDeploymentCommandPlan(input: DeploymentCommandPlanInput): DeployCommand[] {
  return [
    {
      id: 'npm-ci',
      executable: input.nodeExecPath,
      args: [input.npmCliPath, 'ci'],
      cwd: input.candidateRoot,
      env: input.prerequisiteEnv,
      shell: false,
    },
    {
      id: 'build',
      executable: input.nodeExecPath,
      args: [input.npmCliPath, 'run', 'build'],
      cwd: input.candidateRoot,
      env: input.prerequisiteEnv,
      shell: false,
    },
    {
      id: 'verify-pwa-build',
      executable: input.nodeExecPath,
      args: [input.npmCliPath, 'run', 'verify:pwa-build'],
      cwd: input.candidateRoot,
      env: input.prerequisiteEnv,
      shell: false,
    },
    {
      id: 'deploy',
      executable: input.nodeExecPath,
      args: [
        input.wranglerCliPath,
        'deploy',
        '--config',
        'dist/candidary/wrangler.json',
        '--strict',
        '--tag',
        input.sha,
      ],
      cwd: input.deployRoot,
      env: input.deployEnv,
      shell: false,
    },
  ];
}

export function assertDeploymentCommandPlan(
  plan: readonly DeployCommand[],
  input: DeploymentCommandPlanInput,
): void {
  const expectedArgs = [
    [input.npmCliPath, 'ci'],
    [input.npmCliPath, 'run', 'build'],
    [input.npmCliPath, 'run', 'verify:pwa-build'],
    [
      input.wranglerCliPath,
      'deploy',
      '--config',
      'dist/candidary/wrangler.json',
      '--strict',
      '--tag',
      input.sha,
    ],
  ];
  const expectedIds: DeployCommandId[] = ['npm-ci', 'build', 'verify-pwa-build', 'deploy'];
  if (plan.length !== expectedIds.length) throw new Error('Deployment command plan has the wrong length.');
  for (const [index, command] of plan.entries()) {
    if (command.id !== expectedIds[index]
      || command.executable !== input.nodeExecPath
      || command.cwd !== (index === expectedIds.length - 1 ? input.deployRoot : input.candidateRoot)
      || command.env !== (index === expectedIds.length - 1
        ? input.deployEnv
        : input.prerequisiteEnv)
      || command.shell !== false
      || !exactArguments(command.args, expectedArgs[index]!)) {
      throw new Error(`Deployment command ${index + 1} does not match the guarded plan.`);
    }
  }
}

function existingRegularFile(path: string, label: string): string {
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be one exact regular file.`);
  return absolute;
}

export function parseDeployReleaseArgs(
  args: readonly string[],
  cwd = process.cwd(),
): DeployReleaseArguments {
  let sha: string | undefined;
  let manifest: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${flag ?? 'argument'}.`);
    if (flag === '--sha' && sha === undefined) sha = value;
    else if (flag === '--manifest' && manifest === undefined) manifest = value;
    else throw new Error(`Unknown or duplicate deploy argument ${flag}.`);
  }
  if (!sha || !SHA_PATTERN.test(sha)) throw new Error('--sha must be one full lowercase commit SHA.');
  if (!manifest) throw new Error('--manifest is required.');
  const manifestPath = existingRegularFile(resolve(cwd, manifest), 'Candidate manifest');
  if (basename(manifestPath) !== 'candidate-manifest.json') {
    throw new Error('Candidate manifest filename must be candidate-manifest.json.');
  }
  return { sha, manifestPath };
}

function within(container: string, target: string): boolean {
  const path = relative(container, target);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function validatedCliFile(path: string, filename: string, label: string): string {
  if (!isAbsolute(path) || basename(path).toLowerCase() !== filename.toLowerCase()) {
    throw new Error(`${label} must be an absolute ${filename} path.`);
  }
  return realpathSync(existingRegularFile(path, label));
}

function resolveNpmCliPath(npmExecPath: string | undefined, nodeExecPath: string): string {
  const candidates = [
    npmExecPath,
    resolve(dirname(nodeExecPath), 'node_modules/npm/bin/npm-cli.js'),
    resolve(dirname(nodeExecPath), '../lib/node_modules/npm/bin/npm-cli.js'),
  ].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);
  for (const candidate of candidates) {
    try {
      return validatedCliFile(candidate, 'npm-cli.js', 'npm CLI');
    } catch {
      // Try only the fixed Node-installation locations above; never fall back to npx or a shell shim.
    }
  }
  throw new Error('A validated npm-cli.js could not be resolved.');
}

function resolveWranglerCliPath(candidateRoot: string): string {
  const expected = resolve(candidateRoot, 'node_modules/wrangler/bin/wrangler.js');
  const cli = validatedCliFile(expected, 'wrangler.js', 'Wrangler CLI');
  const realRoot = realpathSync(candidateRoot);
  if (!within(realRoot, cli)) throw new Error('Wrangler CLI must remain inside the candidate checkout.');
  return cli;
}

function releaseCandidateAdapters(adapters: DeployReleaseAdapters): ReleaseCandidateObservationAdapter {
  return {
    resolveCommit(candidateRoot, sha) {
      return adapters.git(['rev-parse', '--verify', `${sha}^{commit}`], candidateRoot);
    },
    head(candidateRoot) {
      return adapters.git(['rev-parse', '--verify', 'HEAD^{commit}'], candidateRoot);
    },
    tree(candidateRoot) {
      return adapters.git(['rev-parse', '--verify', 'HEAD^{tree}'], candidateRoot);
    },
    status(candidateRoot) {
      return adapters.git(['status', '--porcelain=v1', '--untracked-files=all'], candidateRoot);
    },
  };
}

function runCommand(command: DeployCommand, adapters: DeployReleaseAdapters): void {
  const exitCode = adapters.run(command);
  if (!Number.isInteger(exitCode) || exitCode !== 0) {
    throw new Error(`Deployment prerequisite ${command.id} failed.`);
  }
}

function removeDeploySnapshot(snapshotRoot: string): void {
  const resolvedRoot = resolve(snapshotRoot);
  if (!basename(resolvedRoot).startsWith('candidary-deploy-')
    || realpathSync(dirname(resolvedRoot)) !== realpathSync(tmpdir())) {
    throw new Error('Refusing to remove an unexpected deploy snapshot path.');
  }
  rmSync(resolvedRoot, { force: true, recursive: true });
}

function createVerifiedDeploySnapshot(
  candidateRoot: string,
  artifacts: ReturnType<typeof collectDeployableArtifacts>,
): string {
  const snapshotRoot = mkdtempSync(resolve(tmpdir(), 'candidary-deploy-'));
  try {
    const configSource = resolve(candidateRoot, artifacts.deployWranglerConfig.path);
    const configTarget = resolve(snapshotRoot, artifacts.deployWranglerConfig.path);
    existingRegularFile(configSource, 'Deploy Wrangler config source');
    const configBytes = deployWranglerConfigBytes(
      JSON.parse(readFileSync(configSource, 'utf8')) as unknown,
    );
    if (configBytes.byteLength !== artifacts.deployWranglerConfig.bytes
      || sha256(configBytes) !== artifacts.deployWranglerConfig.sha256) {
      throw new Error('Deploy Wrangler config changed after verification.');
    }
    mkdirSync(dirname(configTarget), { recursive: true });
    writeFileSync(configTarget, configBytes);

    const files = [artifacts.worker, ...artifacts.client];
    for (const file of files) {
      const source = resolve(candidateRoot, file.path);
      const target = resolve(snapshotRoot, file.path);
      if (!within(candidateRoot, source) || !within(snapshotRoot, target)) {
        throw new Error('Deploy snapshot file escaped its approved root.');
      }
      existingRegularFile(source, 'Deploy snapshot source');
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
    }
    const copied = collectDeployableArtifacts(snapshotRoot);
    if (copied.treeSha256 !== artifacts.treeSha256) {
      throw new Error('Deploy snapshot does not match the verified artifact bytes.');
    }
    return snapshotRoot;
  } catch (error) {
    removeDeploySnapshot(snapshotRoot);
    throw error;
  }
}

const defaultAdapters: DeployReleaseAdapters = {
  nodeExecPath: process.execPath,
  npmExecPath: process.env.npm_execpath,
  environment: process.env,
  git(args, cwd) {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    });
  },
  run(command) {
    const result = spawnSync(command.executable, command.args, {
      cwd: command.cwd,
      env: command.env,
      shell: command.shell,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    return result.status ?? -1;
  },
};

export function runDeployRelease(
  request: DeployReleaseRequest,
  adapters: DeployReleaseAdapters = defaultAdapters,
): void {
  if (!SHA_PATTERN.test(request.sha)) throw new Error('Reviewed SHA is invalid.');
  const candidateRoot = resolve(request.candidateRoot);
  const rootStat = lstatSync(candidateRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Candidate root must be one exact directory.');
  }
  const declaredManifest: unknown = JSON.parse(readFileSync(request.manifestPath, 'utf8'));
  releaseEvidence.assertRedactedCandidateManifest(declaredManifest);
  if (declaredManifest.status !== 'passed' || declaredManifest.candidate === null
    || declaredManifest.migrations === null || declaredManifest.bindings === null
    || declaredManifest.artifacts === null) {
    throw new Error('Only one complete passed candidate manifest is eligible.');
  }
  const declaredMigrationCount = declaredManifest.migrations.verification.migrationCount;
  if (declaredMigrationCount !== 14 && declaredMigrationCount !== 15) {
    throw new Error('Deployment candidate is not at a supported historical or post-cutover boundary.');
  }
  const initialCandidate = verifyExactReleaseCandidate({
    candidateRoot,
    sha: request.sha,
    manifestPath: request.manifestPath,
    approvedBaseSha: APPROVED_BASE_SHA,
    expectedMigrationCount: declaredMigrationCount,
  }, releaseCandidateAdapters(adapters));
  const manifest = initialCandidate.manifest;
  if (manifest.bindings === null || manifest.artifacts === null) {
    throw new Error('Verified candidate is missing deployment evidence.');
  }

  if (!isAbsolute(adapters.nodeExecPath)) throw new Error('Node executable path must be absolute.');
  const npmCliPath = resolveNpmCliPath(adapters.npmExecPath, adapters.nodeExecPath);
  const expectedWranglerPath = resolve(candidateRoot, 'node_modules/wrangler/bin/wrangler.js');
  const prerequisiteEnv = sanitizedPrerequisiteEnvironment(
    adapters.environment,
    manifest.bindings.topology.requiredSecrets,
  );
  const deployEnv = adapters.environment;
  let plan = buildDeploymentCommandPlan({
    candidateRoot,
    deployRoot: candidateRoot,
    sha: request.sha,
    nodeExecPath: adapters.nodeExecPath,
    npmCliPath,
    wranglerCliPath: expectedWranglerPath,
    prerequisiteEnv,
    deployEnv,
  });
  assertDeploymentCommandPlan(plan, {
    candidateRoot,
    deployRoot: candidateRoot,
    sha: request.sha,
    nodeExecPath: adapters.nodeExecPath,
    npmCliPath,
    wranglerCliPath: expectedWranglerPath,
    prerequisiteEnv,
    deployEnv,
  });
  runCommand(plan[0]!, adapters);

  const wranglerCliPath = resolveWranglerCliPath(candidateRoot);
  plan = buildDeploymentCommandPlan({
    candidateRoot,
    deployRoot: candidateRoot,
    sha: request.sha,
    nodeExecPath: adapters.nodeExecPath,
    npmCliPath,
    wranglerCliPath,
    prerequisiteEnv,
    deployEnv,
  });
  assertDeploymentCommandPlan(plan, {
    candidateRoot,
    deployRoot: candidateRoot,
    sha: request.sha,
    nodeExecPath: adapters.nodeExecPath,
    npmCliPath,
    wranglerCliPath,
    prerequisiteEnv,
    deployEnv,
  });
  runCommand(plan[1]!, adapters);
  runCommand(plan[2]!, adapters);

  verifyExactReleaseCandidate({
    candidateRoot,
    sha: request.sha,
    manifestPath: request.manifestPath,
    approvedBaseSha: APPROVED_BASE_SHA,
    expectedMigrationCount: declaredMigrationCount,
  }, releaseCandidateAdapters(adapters));
  const rebuilt = collectDeployableArtifacts(candidateRoot);

  const deployRoot = createVerifiedDeploySnapshot(candidateRoot, rebuilt);
  try {
    plan = buildDeploymentCommandPlan({
      candidateRoot,
      deployRoot,
      sha: request.sha,
      nodeExecPath: adapters.nodeExecPath,
      npmCliPath,
      wranglerCliPath,
      prerequisiteEnv,
      deployEnv,
    });
    assertDeploymentCommandPlan(plan, {
      candidateRoot,
      deployRoot,
      sha: request.sha,
      nodeExecPath: adapters.nodeExecPath,
      npmCliPath,
      wranglerCliPath,
      prerequisiteEnv,
      deployEnv,
    });
    runCommand(plan[3]!, adapters);
  } finally {
    removeDeploySnapshot(deployRoot);
  }
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
    const request = parseDeployReleaseArgs(process.argv.slice(2));
    runDeployRelease({ candidateRoot, ...request });
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Guarded deployment failed.');
    process.exitCode = 1;
  }
}

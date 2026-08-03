import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
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
import type { CandidateManifest } from './release-evidence';

const releaseEvidenceModulePath = './release-evidence.ts';
const releaseEvidence: typeof ReleaseEvidenceModule = await import(releaseEvidenceModulePath);
const assertRedactedCandidateManifest: typeof ReleaseEvidenceModule.assertRedactedCandidateManifest =
  releaseEvidence.assertRedactedCandidateManifest;
const {
  canonicalJson,
  collectDeployableArtifacts,
  collectMigrationManifest,
  normalizedBindingTopology,
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
  shell: false;
}

export interface DeploymentCommandPlanInput {
  candidateRoot: string;
  sha: string;
  nodeExecPath: string;
  npmCliPath: string;
  wranglerCliPath: string;
}

export interface DeployReleaseRequest {
  candidateRoot: string;
  sha: string;
  manifestPath: string;
}

export interface DeployReleaseAdapters {
  nodeExecPath: string;
  npmExecPath: string | undefined;
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

export function buildDeploymentCommandPlan(input: DeploymentCommandPlanInput): DeployCommand[] {
  return [
    {
      id: 'npm-ci',
      executable: input.nodeExecPath,
      args: [input.npmCliPath, 'ci'],
      cwd: input.candidateRoot,
      shell: false,
    },
    {
      id: 'build',
      executable: input.nodeExecPath,
      args: [input.npmCliPath, 'run', 'build'],
      cwd: input.candidateRoot,
      shell: false,
    },
    {
      id: 'verify-pwa-build',
      executable: input.nodeExecPath,
      args: [input.npmCliPath, 'run', 'verify:pwa-build'],
      cwd: input.candidateRoot,
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
      cwd: input.candidateRoot,
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
      || command.cwd !== input.candidateRoot
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

function exactGitObject(value: string, label: string): string {
  const match = /^([0-9a-f]{40})(?:\r?\n)?$/u.exec(value);
  if (!match) throw new Error(`${label} was not one exact lowercase Git object ID.`);
  return match[1]!;
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

function readGuestJourneyVersion(candidateRoot: string): number {
  const value = JSON.parse(readFileSync(resolve(candidateRoot, 'config/release.json'), 'utf8')) as unknown;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Release config must be an object.');
  }
  const version = (value as Record<string, unknown>).guestJourneyVersion;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version <= 0) {
    throw new Error('Checked-in guest journey version is invalid.');
  }
  return version;
}

function loadCandidateManifest(manifestPath: string): CandidateManifest {
  const exactManifestPath = existingRegularFile(manifestPath, 'Candidate manifest');
  if (basename(exactManifestPath) !== 'candidate-manifest.json') {
    throw new Error('Candidate manifest filename must be candidate-manifest.json.');
  }
  const sidecarPath = existingRegularFile(`${exactManifestPath}.sha256`, 'Candidate manifest sidecar');
  const bytes = readFileSync(exactManifestPath);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const sidecar = readFileSync(sidecarPath, 'utf8');
  if (sidecar !== `${digest}  candidate-manifest.json\n`) {
    throw new Error('Candidate manifest sidecar does not match the exact manifest bytes.');
  }
  const value = JSON.parse(bytes.toString('utf8')) as unknown;
  assertRedactedCandidateManifest(value);
  return value;
}

function currentGitState(adapters: DeployReleaseAdapters, candidateRoot: string): {
  head: string;
  tree: string;
  status: string;
} {
  return {
    head: exactGitObject(
      adapters.git(['rev-parse', '--verify', 'HEAD^{commit}'], candidateRoot),
      'HEAD commit',
    ),
    tree: exactGitObject(
      adapters.git(['rev-parse', '--verify', 'HEAD^{tree}'], candidateRoot),
      'HEAD tree',
    ),
    status: adapters.git(['status', '--porcelain=v1', '--untracked-files=all'], candidateRoot),
  };
}

function runCommand(command: DeployCommand, adapters: DeployReleaseAdapters): void {
  const exitCode = adapters.run(command);
  if (!Number.isInteger(exitCode) || exitCode !== 0) {
    throw new Error(`Deployment prerequisite ${command.id} failed.`);
  }
}

const defaultAdapters: DeployReleaseAdapters = {
  nodeExecPath: process.execPath,
  npmExecPath: process.env.npm_execpath,
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
      env: process.env,
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
  const manifest = loadCandidateManifest(request.manifestPath);
  if (manifest.status !== 'passed' || manifest.candidate === null
    || manifest.artifacts === null || manifest.bindings === null) {
    throw new Error('Only a complete passed candidate manifest may deploy.');
  }
  if (manifest.candidate.approvedBaseSha !== APPROVED_BASE_SHA
    || manifest.candidate.gitSha !== request.sha) {
    throw new Error('Candidate manifest identity does not match the reviewed release.');
  }

  const resolvedCommit = exactGitObject(
    adapters.git(['rev-parse', '--verify', `${request.sha}^{commit}`], candidateRoot),
    'Reviewed commit',
  );
  if (resolvedCommit !== request.sha) throw new Error('Reviewed SHA did not resolve to itself as a commit.');
  const initial = currentGitState(adapters, candidateRoot);
  if (initial.head !== request.sha
    || initial.tree !== manifest.candidate.gitTree
    || initial.status !== '') {
    throw new Error('Candidate checkout is not the exact reviewed clean Git state.');
  }
  const guestJourneyVersion = readGuestJourneyVersion(candidateRoot);
  const migrations = collectMigrationManifest(candidateRoot);
  if (manifest.candidate.guestJourneyVersion !== guestJourneyVersion
    || manifest.candidate.migrationManifestSha256 !== migrations.sha256) {
    throw new Error('Candidate journey or migration identity does not match the checkout.');
  }

  if (!isAbsolute(adapters.nodeExecPath)) throw new Error('Node executable path must be absolute.');
  const npmCliPath = resolveNpmCliPath(adapters.npmExecPath, adapters.nodeExecPath);
  const expectedWranglerPath = resolve(candidateRoot, 'node_modules/wrangler/bin/wrangler.js');
  let plan = buildDeploymentCommandPlan({
    candidateRoot,
    sha: request.sha,
    nodeExecPath: adapters.nodeExecPath,
    npmCliPath,
    wranglerCliPath: expectedWranglerPath,
  });
  assertDeploymentCommandPlan(plan, {
    candidateRoot,
    sha: request.sha,
    nodeExecPath: adapters.nodeExecPath,
    npmCliPath,
    wranglerCliPath: expectedWranglerPath,
  });
  runCommand(plan[0]!, adapters);

  const wranglerCliPath = resolveWranglerCliPath(candidateRoot);
  plan = buildDeploymentCommandPlan({
    candidateRoot,
    sha: request.sha,
    nodeExecPath: adapters.nodeExecPath,
    npmCliPath,
    wranglerCliPath,
  });
  assertDeploymentCommandPlan(plan, {
    candidateRoot,
    sha: request.sha,
    nodeExecPath: adapters.nodeExecPath,
    npmCliPath,
    wranglerCliPath,
  });
  runCommand(plan[1]!, adapters);
  runCommand(plan[2]!, adapters);

  const rebuilt = collectDeployableArtifacts(candidateRoot);
  if (rebuilt.treeSha256 !== manifest.artifacts.firstTreeSha256) {
    throw new Error('Rebuilt deployable artifacts do not match candidate evidence.');
  }
  const generatedConfig = JSON.parse(
    readFileSync(resolve(candidateRoot, 'dist/candidary/wrangler.json'), 'utf8'),
  ) as unknown;
  const rebuiltTopologySha = sha256(canonicalJson(normalizedBindingTopology(generatedConfig)));
  if (rebuiltTopologySha !== manifest.bindings.sourceTopologySha256) {
    throw new Error('Rebuilt binding topology does not match candidate evidence.');
  }

  const final = currentGitState(adapters, candidateRoot);
  if (final.head !== request.sha
    || final.tree !== manifest.candidate.gitTree
    || final.status !== '') {
    throw new Error('Candidate Git state drifted during deployment preparation.');
  }
  runCommand(plan[3]!, adapters);
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

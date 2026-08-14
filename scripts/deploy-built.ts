import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const PREVIEW_WORKER_NAME = 'candidary-preview';
const MAX_WORKERS_DEV_LABEL_LENGTH = 63;

export type DeploymentTarget = 'production' | 'preview';

export interface DeployCommand {
  id: 'deploy';
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
}

export interface DeploymentCommandPlanInput {
  repositoryRoot: string;
  target: DeploymentTarget;
  sha: string;
  branch?: string;
  nodeExecPath: string;
  wranglerCliPath: string;
  environment: NodeJS.ProcessEnv;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deploymentTargetMatches(config: Record<string, unknown>, target: DeploymentTarget): boolean {
  const d1 = Array.isArray(config.d1_databases) ? config.d1_databases : [];
  const r2 = Array.isArray(config.r2_buckets) ? config.r2_buckets : [];
  const email = Array.isArray(config.send_email) ? config.send_email : [];
  const triggers = isRecord(config.triggers) ? config.triggers : {};
  const crons = Array.isArray(triggers.crons) ? triggers.crons : [];
  const databaseIds = d1
    .filter(isRecord)
    .filter((binding) => binding.binding === 'DB')
    .map((binding) => binding.database_id);
  const bucketNames = r2.filter(isRecord).map((binding) => binding.bucket_name);

  if (target === 'preview') {
    return config.name === 'candidary-preview'
      && config.targetEnvironment === 'preview'
      && config.workers_dev === true
      && config.preview_urls === true
      && crons.length === 0
      && email.length === 0
      && databaseIds.length === 1
      && databaseIds[0] === 'bd816308-0c4c-48de-9ece-8d030360fb73'
      && bucketNames.length === 2
      && bucketNames[0] === 'candidary-preview-media'
      && bucketNames[1] === 'candidary-preview-media-canonical';
  }

  return config.name === 'candidary'
    && config.targetEnvironment !== 'preview'
    && config.workers_dev === false
    && config.preview_urls === false
    && databaseIds.length === 1
    && databaseIds[0] === '60bec5de-c8c7-41b5-a26b-2d3f7d184c71'
    && bucketNames.length === 2
    && bucketNames[0] === 'candidary-media'
    && bucketNames[1] === 'candidary-media-canonical-v2'
    && email.some((binding) => isRecord(binding) && binding.name === 'EMAIL');
}

export function assertGeneratedDeploymentTarget(
  value: unknown,
  target: DeploymentTarget,
): asserts value is Record<string, unknown> {
  if (!isRecord(value) || !deploymentTargetMatches(value, target)) {
    throw new Error(`Built Wrangler config does not match the requested ${target} target.`);
  }
}

function assertFullSha(sha: string): string {
  if (!SHA_PATTERN.test(sha)) {
    throw new Error('Deployment SHA must be one full lowercase commit SHA.');
  }
  return sha;
}

export function previewAlias(branch: string | undefined, sha: string): string {
  assertFullSha(sha);
  const fallback = `preview-${sha.slice(0, 8)}`;
  const normalized = (branch ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '');
  const startsWithLetter = /^[a-z]/u.test(normalized);
  const candidate = normalized
    ? `${startsWithLetter ? '' : 'branch-'}${normalized}`
    : fallback;
  const maximumAliasLength = MAX_WORKERS_DEV_LABEL_LENGTH - PREVIEW_WORKER_NAME.length - 1;
  const alias = candidate.slice(0, maximumAliasLength).replace(/-$/u, '');
  return alias || fallback;
}

export function buildDeploymentCommandPlan(input: DeploymentCommandPlanInput): [DeployCommand] {
  const sha = assertFullSha(input.sha);
  if (input.target === 'production' && input.branch && input.branch !== 'main') {
    throw new Error('A production deployment requires the main branch.');
  }
  const config = 'dist/candidary/wrangler.json';
  const operation = input.target === 'production'
    ? ['deploy']
    : ['versions', 'upload'];
  const previewArguments = input.target === 'preview'
    ? ['--preview-alias', previewAlias(input.branch, sha)]
    : [];

  return [{
    id: 'deploy',
    executable: input.nodeExecPath,
    args: [
      input.wranglerCliPath,
      ...operation,
      '--config',
      config,
      '--strict',
      '--tag',
      sha,
      ...previewArguments,
    ],
    cwd: input.repositoryRoot,
    env: input.environment,
    shell: false,
  }];
}

function assertBuiltConfig(repositoryRoot: string, target: DeploymentTarget): void {
  const relativePath = 'dist/candidary/wrangler.json';
  const path = resolve(repositoryRoot, relativePath);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Built Wrangler config must be a regular file: ${relativePath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    throw new Error(`Built Wrangler config must contain valid JSON: ${relativePath}`);
  }
  assertGeneratedDeploymentTarget(parsed, target);
}

function resolveSha(repositoryRoot: string, environment: NodeJS.ProcessEnv): string {
  const configured = environment.WORKERS_CI_COMMIT_SHA?.trim();
  if (configured) return assertFullSha(configured);
  const sha = execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();
  return assertFullSha(sha);
}

export function runBuiltDeployment(
  target: DeploymentTarget,
  repositoryRoot = process.cwd(),
  environment: NodeJS.ProcessEnv = process.env,
): void {
  assertBuiltConfig(repositoryRoot, target);
  const sha = resolveSha(repositoryRoot, environment);
  const wranglerCliPath = resolve(repositoryRoot, 'node_modules/wrangler/bin/wrangler.js');
  const deployEnvironment = {
    ...environment,
    WRANGLER_SEND_METRICS: 'false',
  };
  const [command] = buildDeploymentCommandPlan({
    repositoryRoot,
    target,
    sha,
    branch: environment.WORKERS_CI_BRANCH,
    nodeExecPath: process.execPath,
    wranglerCliPath,
    environment: deployEnvironment,
  });
  const result = spawnSync(command.executable, command.args, {
    cwd: command.cwd,
    env: command.env,
    shell: command.shell,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Wrangler deployment failed with exit code ${String(result.status)}.`);
  }
}

function parseTarget(value: string | undefined): DeploymentTarget {
  if (value === 'production' || value === 'preview') return value;
  throw new Error('Usage: deploy-built.ts <production|preview>');
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  runBuiltDeployment(parseTarget(process.argv[2]));
}

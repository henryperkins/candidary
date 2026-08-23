import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
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

function configuredBranch(environment: NodeJS.ProcessEnv): string {
  return environment.WORKERS_CI_BRANCH?.trim()
    || environment.GITHUB_HEAD_REF?.trim()
    || environment.GITHUB_REF_NAME?.trim()
    || '';
}

export function resolveDeploymentBranch(
  environment: NodeJS.ProcessEnv,
  checkedOutBranch: string,
): string {
  const configured = configuredBranch(environment);
  const checkedOut = checkedOutBranch.trim();
  if (configured && checkedOut && configured !== checkedOut) {
    throw new Error(`Configured branch ${configured} does not match checked-out branch ${checkedOut}.`);
  }
  const branch = configured || checkedOut;
  if (!branch) {
    throw new Error('Deployment requires a trustworthy branch identity.');
  }
  return branch;
}

export function resolveDeploymentSha(
  environment: NodeJS.ProcessEnv,
  checkedOutHead: string,
): string {
  const head = assertFullSha(checkedOutHead.trim());
  const configured = environment.WORKERS_CI_COMMIT_SHA?.trim();
  if (configured && assertFullSha(configured) !== head) {
    throw new Error('Configured deployment SHA does not match checked-out HEAD.');
  }
  return configured || head;
}

export function assertProductionDeploymentTreeClean(
  target: DeploymentTarget,
  branch: string,
  status: string,
): void {
  if (target === 'production' && branch === 'main' && status.trim()) {
    throw new Error('A production deployment requires a clean working tree.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const REQUIRED_SECRETS = [
  'TOKEN_HMAC_KEY',
  'SESSION_HMAC_KEY',
  'GUEST_TOKEN_ENCRYPTION_KEY',
  'LOGIN_HMAC_KEY',
  'ENTRY_HMAC_KEY',
  'ENTRY_ENCRYPTION_KEY',
  'RSVP_LOOKUP_HMAC_KEY',
  'GUEST_MESSAGE_HMAC_KEY',
  'ALBUM_SHARE_HMAC_KEY',
  'ALBUM_SHARE_ENCRYPTION_KEY',
];

const COMMON_EXPECTED_TOPOLOGY = {
  images: { binding: 'IMAGES' },
  secrets: { required: REQUIRED_SECRETS },
  version_metadata: { binding: 'CF_VERSION_METADATA' },
};

const EXPECTED_TOPOLOGY = {
  production: {
    ...COMMON_EXPECTED_TOPOLOGY,
    name: 'candidary',
    targetEnvironment: undefined,
    workers_dev: false,
    preview_urls: false,
    d1_databases: [{
      binding: 'DB',
      database_name: 'candidary-core',
      database_id: '60bec5de-c8c7-41b5-a26b-2d3f7d184c71',
    }],
    r2_buckets: [
      { binding: 'MEDIA_BUCKET', bucket_name: 'candidary-media' },
      { binding: 'CANONICAL_MEDIA_BUCKET', bucket_name: 'candidary-media-canonical-v2' },
    ],
    send_email: [{ name: 'EMAIL' }],
    ratelimits: [
      { name: 'HOST_AUTH_RATE_LIMIT', namespace_id: '1001', simple: { limit: 20, period: 60 } },
      { name: 'RSVP_LOOKUP_RATE_LIMIT', namespace_id: '1002', simple: { limit: 30, period: 60 } },
      { name: 'GUEST_MESSAGE_RATE_LIMIT', namespace_id: '1003', simple: { limit: 120, period: 60 } },
    ],
    workflows: [
      { name: 'candidary-export', binding: 'EXPORT_WORKFLOW', class_name: 'ExportWorkflow' },
      {
        name: 'candidary-cover-render',
        binding: 'COVER_RENDER_WORKFLOW',
        class_name: 'CoverRenderWorkflow',
      },
      {
        name: 'candidary-cover-backfill',
        binding: 'COVER_BACKFILL_WORKFLOW',
        class_name: 'CoverBackfillWorkflow',
      },
    ],
    crons: ['17 3 * * *', '47 * * * *'],
    vars: {
      APP_ORIGIN: 'https://candidary.app',
      ALTERNATE_ORIGINS: 'https://candidary.online',
      EMAIL_FROM: 'hello@candidary.app',
    },
  },
  preview: {
    ...COMMON_EXPECTED_TOPOLOGY,
    name: 'candidary-preview',
    targetEnvironment: 'preview',
    workers_dev: true,
    preview_urls: true,
    d1_databases: [{
      binding: 'DB',
      database_name: 'candidary-preview-core',
      database_id: 'bd816308-0c4c-48de-9ece-8d030360fb73',
    }],
    r2_buckets: [
      { binding: 'MEDIA_BUCKET', bucket_name: 'candidary-preview-media' },
      { binding: 'CANONICAL_MEDIA_BUCKET', bucket_name: 'candidary-preview-media-canonical' },
    ],
    send_email: [],
    ratelimits: [
      { name: 'HOST_AUTH_RATE_LIMIT', namespace_id: '2001', simple: { limit: 20, period: 60 } },
      { name: 'RSVP_LOOKUP_RATE_LIMIT', namespace_id: '2002', simple: { limit: 30, period: 60 } },
      { name: 'GUEST_MESSAGE_RATE_LIMIT', namespace_id: '2003', simple: { limit: 120, period: 60 } },
    ],
    workflows: [
      { name: 'candidary-preview-export', binding: 'EXPORT_WORKFLOW', class_name: 'ExportWorkflow' },
      {
        name: 'candidary-preview-cover-render',
        binding: 'COVER_RENDER_WORKFLOW',
        class_name: 'CoverRenderWorkflow',
      },
      {
        name: 'candidary-preview-cover-backfill',
        binding: 'COVER_BACKFILL_WORKFLOW',
        class_name: 'CoverBackfillWorkflow',
      },
    ],
    crons: [],
    vars: {
      APP_ORIGIN: 'https://candidary-preview.lfd.workers.dev',
      ALTERNATE_ORIGINS: '',
      EMAIL_FROM: 'hello@candidary.app',
    },
  },
} as const;

function projectRecords(value: unknown, keys: readonly string[]): unknown[] | null {
  if (!Array.isArray(value)) return null;
  const projected: unknown[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    projected.push(Object.fromEntries(keys.map((key) => [key, item[key]])));
  }
  return projected;
}

function deploymentTargetMatches(config: Record<string, unknown>, target: DeploymentTarget): boolean {
  const expected = EXPECTED_TOPOLOGY[target];
  const triggers = isRecord(config.triggers) ? config.triggers : null;
  return config.name === expected.name
    && config.targetEnvironment === expected.targetEnvironment
    && config.workers_dev === expected.workers_dev
    && config.preview_urls === expected.preview_urls
    && isDeepStrictEqual(
      projectRecords(config.d1_databases, ['binding', 'database_name', 'database_id']),
      expected.d1_databases,
    )
    && isDeepStrictEqual(
      projectRecords(config.r2_buckets, ['binding', 'bucket_name']),
      expected.r2_buckets,
    )
    && isDeepStrictEqual(config.images, expected.images)
    && isDeepStrictEqual(projectRecords(config.send_email, ['name']), expected.send_email)
    && isDeepStrictEqual(config.ratelimits, expected.ratelimits)
    && isDeepStrictEqual(config.workflows, expected.workflows)
    && isDeepStrictEqual(triggers?.crons, expected.crons)
    && isDeepStrictEqual(config.vars, expected.vars)
    && isDeepStrictEqual(config.secrets, expected.secrets)
    && isDeepStrictEqual(config.version_metadata, expected.version_metadata);
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
  const branch = input.branch?.trim();
  if (!branch) {
    throw new Error('Deployment requires a trustworthy branch identity.');
  }
  if (input.target === 'production' && branch !== 'main') {
    throw new Error('A production deployment requires the main branch.');
  }
  const config = 'dist/candidary/wrangler.json';
  const operation = input.target === 'production'
    ? ['deploy']
    : ['versions', 'upload'];
  const previewArguments = input.target === 'preview'
    ? ['--preview-alias', previewAlias(branch, sha)]
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

function gitOutput(repositoryRoot: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();
}

export function runBuiltDeployment(
  target: DeploymentTarget,
  repositoryRoot = process.cwd(),
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const branch = resolveDeploymentBranch(
    environment,
    gitOutput(repositoryRoot, ['branch', '--show-current']),
  );
  const sha = resolveDeploymentSha(
    environment,
    gitOutput(repositoryRoot, ['rev-parse', '--verify', 'HEAD^{commit}']),
  );
  const status = target === 'production'
    ? gitOutput(repositoryRoot, ['status', '--porcelain', '--untracked-files=all'])
    : '';
  assertProductionDeploymentTreeClean(target, branch, status);
  const wranglerCliPath = resolve(repositoryRoot, 'node_modules/wrangler/bin/wrangler.js');
  const deployEnvironment = {
    ...environment,
    WRANGLER_SEND_METRICS: 'false',
  };
  const [command] = buildDeploymentCommandPlan({
    repositoryRoot,
    target,
    sha,
    branch,
    nodeExecPath: process.execPath,
    wranglerCliPath,
    environment: deployEnvironment,
  });
  assertBuiltConfig(repositoryRoot, target);
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

import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BuildCommand {
  id: 'typecheck' | 'vite-build';
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
}

export interface BuildCloudflareCommandPlanInput {
  repositoryRoot: string;
  branch?: string;
  nodeExecPath: string;
  tscCliPath: string;
  viteCliPath: string;
  environment: NodeJS.ProcessEnv;
}

function configuredBranch(environment: NodeJS.ProcessEnv): string {
  return environment.WORKERS_CI_BRANCH?.trim()
    || environment.GITHUB_HEAD_REF?.trim()
    || environment.GITHUB_REF_NAME?.trim()
    || '';
}

export function resolveBuildBranch(
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
    throw new Error('Cloudflare build requires a trustworthy branch identity.');
  }
  return branch;
}

export function assertProductionBuildTreeClean(branch: string, status: string): void {
  if (branch === 'main' && status.trim()) {
    throw new Error('A production build requires a clean working tree.');
  }
}

export function buildCloudflareCommandPlan(
  input: BuildCloudflareCommandPlanInput,
): BuildCommand[] {
  const branch = input.branch?.trim();
  if (!branch) {
    throw new Error('Cloudflare build requires a trustworthy branch identity.');
  }
  const buildEnvironment = { ...input.environment };
  if (branch !== 'main') {
    buildEnvironment.CLOUDFLARE_ENV = 'preview';
  } else {
    delete buildEnvironment.CLOUDFLARE_ENV;
  }
  buildEnvironment.WRANGLER_SEND_METRICS = 'false';

  return [
    {
      id: 'typecheck',
      executable: input.nodeExecPath,
      args: [input.tscCliPath, '-b', '--pretty', 'false'],
      cwd: input.repositoryRoot,
      env: buildEnvironment,
      shell: false,
    },
    {
      id: 'vite-build',
      executable: input.nodeExecPath,
      args: [input.viteCliPath, 'build'],
      cwd: input.repositoryRoot,
      env: buildEnvironment,
      shell: false,
    },
  ];
}

export function runCloudflareBuild(
  repositoryRoot = process.cwd(),
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const checkedOutBranch = execFileSync('git', ['branch', '--show-current'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const branch = resolveBuildBranch(environment, checkedOutBranch);
  const status = branch === 'main'
    ? execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
      })
    : '';
  assertProductionBuildTreeClean(branch, status);
  const plan = buildCloudflareCommandPlan({
    repositoryRoot,
    branch,
    nodeExecPath: process.execPath,
    tscCliPath: resolve(repositoryRoot, 'node_modules/typescript/bin/tsc'),
    viteCliPath: resolve(repositoryRoot, 'node_modules/vite/bin/vite.js'),
    environment,
  });

  for (const command of plan) {
    const result = spawnSync(command.executable, command.args, {
      cwd: command.cwd,
      env: command.env,
      shell: command.shell,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`${command.id} failed with exit code ${String(result.status)}.`);
    }
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  runCloudflareBuild();
}

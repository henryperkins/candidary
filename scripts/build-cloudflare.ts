import { spawnSync } from 'node:child_process';
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

export function buildCloudflareCommandPlan(
  input: BuildCloudflareCommandPlanInput,
): BuildCommand[] {
  const buildEnvironment = { ...input.environment };
  if (input.branch && input.branch !== 'main') {
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
  const plan = buildCloudflareCommandPlan({
    repositoryRoot,
    branch: environment.WORKERS_CI_BRANCH,
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

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
type LaneStatus = 'PASS' | 'FAIL' | 'SKIPPED (Build failed)' | 'SKIPPED (run invalidated)';

export interface CiLocalDependencies {
  git(args: readonly string[]): string;
  run(command: string, args: readonly string[], environment?: NodeJS.ProcessEnv): {
    error?: Error;
    signal?: NodeJS.Signals | null;
    status: number | null;
  };
  write(line: string): void;
}

export interface CiLocalOptions {
  base?: string;
  head?: string;
}

const npm = 'npm';
const npx = 'npx';
const lanes = [
  { name: 'Quality', commands: [
    [npm, ['audit', '--omit=dev']],
    [npm, ['run', 'verify:bindings']],
    [npm, ['run', 'typecheck:e2e']],
    [npm, ['run', 'lint']],
  ] },
  { name: 'Unit and UI', commands: [[npm, ['run', 'test:unit']]] },
  { name: 'Worker', commands: [[npm, ['run', 'test:worker']]] },
  { name: 'Build', commands: [
    [npm, ['run', 'build:cloudflare']],
    [npm, ['run', 'verify:pwa-build']],
    [npx, ['wrangler', 'deploy', '--dry-run', '--strict', '--config', 'dist/candidary/wrangler.json', '--outdir', 'output/wrangler-dry-run']],
  ] },
  { name: 'Smoke', commands: [[npm, ['run', 'test:smoke']]] },
  { name: 'Migration safety', commands: [[npm, ['run', 'ci:migrations']]] },
] as const;

const realDependencies: CiLocalDependencies = {
  git(args) {
    return execFileSync('git', [...args], {
      cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  },
  run(command, args, environment) {
    return runChildCommand(command, args, environment);
  },
  write(line) {
    console.log(line);
  },
};

export function runChildCommand(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
) {
  if (process.platform === 'win32' && (command === 'npm' || command === 'npx')) {
    let npmEntrypoint = environment.npm_execpath;
    if (!npmEntrypoint) {
      try {
        const commandShim = execFileSync('where.exe', ['npm.cmd'], { encoding: 'utf8' })
          .split(/\r?\n/u).find(Boolean);
        if (commandShim) npmEntrypoint = resolve(dirname(commandShim), 'node_modules/npm/bin/npm-cli.js');
      } catch {
        // Report the missing executable through the normal command failure result below.
      }
    }
    const entrypoint = npmEntrypoint
      ? command === 'npm' ? npmEntrypoint : resolve(dirname(npmEntrypoint), 'npx-cli.js')
      : undefined;
    if (!entrypoint || !existsSync(entrypoint)) {
      return { status: null, error: new Error(`Unable to locate the ${command} CLI entrypoint.`) };
    }
    return spawnSync(process.execPath, [entrypoint, ...args], {
      cwd: process.cwd(), env: environment, shell: false, stdio: 'inherit',
    });
  }
  return spawnSync(command, [...args], {
    cwd: process.cwd(), env: environment, shell: false, stdio: 'inherit',
  });
}

function exactSha(dependencies: CiLocalDependencies, revision: string, label: string): string {
  let sha: string;
  try {
    sha = dependencies.git(['rev-parse', '--verify', `${revision}^{commit}`]).trim();
  } catch {
    throw new Error(`${label} ${revision} cannot be resolved; pass an explicit --base when origin/main is unavailable.`);
  }
  if (!SHA_PATTERN.test(sha)) throw new Error(`${label} must resolve to one full lowercase commit SHA.`);
  return sha;
}

export function runCiLocal(
  options: CiLocalOptions = {},
  dependencies: CiLocalDependencies = realDependencies,
): number {
  const statuses = new Map<string, LaneStatus>();
  let invalidated = false;

  try {
    const baseSha = exactSha(dependencies, options.base ?? 'origin/main', 'Base');
    const expectedHead = dependencies.git(['rev-parse', 'HEAD']).trim();
    if (!SHA_PATTERN.test(expectedHead)) throw new Error('Checked-out HEAD is not one full lowercase commit SHA.');
    if (options.head && options.head !== expectedHead) {
      throw new Error(`Requested head ${options.head} does not equal checked-out HEAD ${expectedHead}.`);
    }
    if (dependencies.git(['status', '--porcelain', '--untracked-files=no']).trim()) {
      throw new Error('Tracked files must be clean before local CI starts.');
    }

    dependencies.write(`Base SHA: ${baseSha}`);
    dependencies.write(`Head SHA: ${expectedHead}`);

    for (const lane of lanes) {
      if (invalidated) {
        statuses.set(lane.name, 'SKIPPED (run invalidated)');
        continue;
      }
      if (lane.name === 'Smoke' && statuses.get('Build') !== 'PASS') {
        statuses.set(lane.name, 'SKIPPED (Build failed)');
        continue;
      }

      let passed = true;
      for (const [command, args] of lane.commands) {
        const environment = lane.name === 'Migration safety'
          ? { ...process.env, CI_BASE_SHA: baseSha, CI_HEAD_SHA: expectedHead }
          : process.env;
        const result = dependencies.run(command, args, environment);
        if (result.error || result.signal || result.status !== 0) passed = false;

        const currentHead = dependencies.git(['rev-parse', 'HEAD']).trim();
        const trackedChanges = dependencies.git(['status', '--porcelain', '--untracked-files=no']).trim();
        if (currentHead !== expectedHead || trackedChanges) {
          passed = false;
          invalidated = true;
          dependencies.write('ERROR: Run invalidated because HEAD or tracked files changed.');
          break;
        }
        if (!passed) break;
      }
      statuses.set(lane.name, passed ? 'PASS' : 'FAIL');
    }

    const failed = invalidated || [...statuses.values()].some((status) => status === 'FAIL');
    for (const lane of lanes) dependencies.write(`${lane.name}: ${statuses.get(lane.name)}`);
    dependencies.write(`Overall exit code: ${failed ? 1 : 0}`);
    return failed ? 1 : 0;
  } catch (error) {
    dependencies.write(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function parseArguments(args: readonly string[]): CiLocalOptions {
  const options: CiLocalOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name !== '--base' && name !== '--head') throw new Error(`Unknown argument: ${name}`);
    const value = args[index + 1];
    if (!value) throw new Error(`${name} requires a revision.`);
    if (name === '--base') options.base = value;
    else options.head = value;
    index += 1;
  }
  return options;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runCiLocal(parseArguments(process.argv.slice(2)));
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

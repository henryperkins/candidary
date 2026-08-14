import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const MIGRATION_SAFETY_PATHS = new Set([
  'wrangler.jsonc',
  'scripts/verify-fresh-d1.ts',
  'scripts/migration-manifest.ts',
]);

export function requiresMigrationCheck(paths: readonly string[]): boolean {
  return paths.some((path) => {
    const normalized = path.replaceAll('\\', '/');
    return normalized.startsWith('migrations/') || MIGRATION_SAFETY_PATHS.has(normalized);
  });
}

function requiredSha(value: string | undefined, name: string): string {
  const sha = value?.trim();
  if (!sha || !SHA_PATTERN.test(sha)) {
    throw new Error(`${name} must be one full lowercase commit SHA.`);
  }
  return sha;
}

export function runConditionalMigrationCheck(
  repositoryRoot = process.cwd(),
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const baseSha = requiredSha(environment.CI_BASE_SHA, 'CI_BASE_SHA');
  const headSha = requiredSha(environment.CI_HEAD_SHA, 'CI_HEAD_SHA');
  const changedFiles = execFileSync(
    'git',
    ['diff', '--name-only', '--diff-filter=ACMRD', baseSha, headSha],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  ).split(/\r?\n/gu).filter(Boolean);

  if (!requiresMigrationCheck(changedFiles)) {
    console.log('Migration safety unchanged; fresh D1 verification skipped.');
    return;
  }

  const runRoot = mkdtempSync(join(tmpdir(), 'candidary-migration-ci-'));
  try {
    const result = spawnSync(process.execPath, [
      '--experimental-strip-types',
      resolve(repositoryRoot, 'scripts/verify-fresh-d1.ts'),
      '--run-root',
      runRoot,
      '--report-file',
      join(runRoot, 'migration-verification.json'),
    ], {
      cwd: repositoryRoot,
      env: environment,
      shell: false,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`Fresh D1 verification failed with exit code ${String(result.status)}.`);
    }
  } finally {
    rmSync(runRoot, { force: true, recursive: true });
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  runConditionalMigrationCheck();
}

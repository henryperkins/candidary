import { cloudflare } from '@cloudflare/vite-plugin';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

import { collectMigrationManifest, releaseBuildSha } from './scripts/release-evidence';

interface BuildCandidate {
  buildSha: string;
  migrationManifestSha256: string;
}

type ViteCommand = 'build' | 'serve';

export function resolveBuildCandidate(repositoryRoot: string): BuildCandidate {
  const headSha = execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
  const porcelainStatus = execFileSync(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    { cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const migrations = collectMigrationManifest(repositoryRoot);
  return {
    buildSha: releaseBuildSha(headSha, porcelainStatus),
    migrationManifestSha256: migrations.sha256,
  };
}

export function resolveConfigBuildCandidate(
  repositoryRoot: string,
  command: ViteCommand,
  warn: (message: string) => void = console.warn,
): BuildCandidate {
  if (command === 'build') return resolveBuildCandidate(repositoryRoot);
  try {
    return resolveBuildCandidate(repositoryRoot);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    warn(`[candidary] release identity unavailable for local serving: ${detail}`);
    return { buildSha: '', migrationManifestSha256: '' };
  }
}

export function omitLocalDevVars(bundle: Record<string, unknown>): void {
  delete bundle['.dev.vars'];
}

function omitLocalDevVarsPlugin(): Plugin {
  return {
    name: 'candidary-omit-local-dev-vars',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      omitLocalDevVars(bundle);
    },
  };
}

const repositoryRoot = dirname(fileURLToPath(import.meta.url));
export default defineConfig(({ command }) => {
  const buildCandidate = resolveConfigBuildCandidate(repositoryRoot, command);
  return {
    plugins: [react(), cloudflare(), omitLocalDevVarsPlugin()],
    // The first Web Worker in this application. The composition model runs off
    // the main thread on the authorized natural preview, so choosing a cover
    // never blocks the manager's own scrolling or typing. ES output because the
    // worker imports the shared saliency module rather than inlining it.
    worker: {
      format: 'es',
    },
    build: {
      assetsInlineLimit: 0,
    },
    environments: {
      candidary: {
        define: {
          __CANDIDARY_BUILD_SHA__: JSON.stringify(buildCandidate.buildSha),
          __CANDIDARY_MIGRATION_MANIFEST_SHA256__: JSON.stringify(
            buildCandidate.migrationManifestSha256,
          ),
          __CANDIDARY_TEST_LEGACY_R2_SIGNING__: 'false',
        },
      },
    },
  };
});


import { cloudflare } from '@cloudflare/vite-plugin';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

import { collectMigrationManifest, releaseBuildSha } from './scripts/release-evidence';

interface BuildCandidate {
  buildSha: string;
  migrationManifestSha256: string;
}

export function resolveBuildCandidate(repositoryRoot: string): BuildCandidate {
  const headSha = execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  }).trimEnd();
  const porcelainStatus = execFileSync(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );
  const migrations = collectMigrationManifest(repositoryRoot);
  return {
    buildSha: releaseBuildSha(headSha, porcelainStatus),
    migrationManifestSha256: migrations.sha256,
  };
}

const repositoryRoot = dirname(fileURLToPath(import.meta.url));
const buildCandidate = resolveBuildCandidate(repositoryRoot);

export default defineConfig({
  plugins: [react(), cloudflare()],
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
      },
    },
  },
});


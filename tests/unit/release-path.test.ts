import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SMOKE_SERVER_COMMAND } from '../../playwright.smoke.config';

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>;
};
const ciWorkflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');

describe('routine release path', () => {
  it('smoke-tests the downloaded client artifact without rebuilding or loading Cloudflare config', () => {
    expect(SMOKE_SERVER_COMMAND).toContain('--config vite.smoke.config.ts');
    expect(SMOKE_SERVER_COMMAND).toContain('--outDir dist/client');
    expect(SMOKE_SERVER_COMMAND).not.toMatch(/\bbuild\b/u);
  });

  it('has no legacy evidence, candidate, bridge, migration, or staging commands', () => {
    expect(packageJson.scripts).not.toHaveProperty('verify:release');
    expect(packageJson.scripts).not.toHaveProperty('release:bridge');
    expect(packageJson.scripts).not.toHaveProperty('release:staging');
    expect(packageJson.scripts).not.toHaveProperty('release:staging:task11');
    expect(packageJson.scripts).not.toHaveProperty('release:migrate');
  });

  it('keeps optional manual CI on the selected branch with full history and exact revisions', () => {
    expect(ciWorkflow).toContain('workflow_dispatch:');
    expect(ciWorkflow).toContain('WORKERS_CI_BRANCH: ${{ github.ref_name }}');
    expect(ciWorkflow).toContain('fetch-depth: 0');
    expect(ciWorkflow).toContain('CI_LOCAL_BASE: ${{ inputs.base }}');
    expect(ciWorkflow).toContain('npm run ci:local -- --base "$CI_LOCAL_BASE" --head "$CI_LOCAL_HEAD"');
  });

  it('does not run automatically for pull requests or pushes', () => {
    expect(ciWorkflow).not.toMatch(/^\s*pull_request:/mu);
    expect(ciWorkflow).not.toMatch(/^\s*push:/mu);
  });

  it.each([
    'scripts/verify-release.ts',
    'scripts/release-evidence.ts',
    'scripts/release-candidate.ts',
    'scripts/deploy-release.ts',
    'scripts/migrate-release.ts',
    'scripts/bridge-release.ts',
    'scripts/staging-release.ts',
    'worker/staging-conformance.ts',
    'worker/workflows/staging-conformance-fault.ts',
    'shared/staging-conformance.ts',
  ])('removes obsolete release machinery: %s', (path) => {
    expect(existsSync(resolve(root, path))).toBe(false);
  });
});

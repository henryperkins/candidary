import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SMOKE_SERVER_COMMAND } from '../../playwright.smoke.config';

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>;
};

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

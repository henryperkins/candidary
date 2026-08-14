import { describe, expect, it } from 'vitest';

import {
  assertProductionBuildTreeClean,
  buildCloudflareCommandPlan,
  resolveBuildBranch,
} from '../../scripts/build-cloudflare';

describe('Cloudflare build selection', () => {
  it('builds main once with the production configuration', () => {
    expect(buildCloudflareCommandPlan({
      repositoryRoot: 'C:/repo',
      branch: 'main',
      nodeExecPath: 'node',
      tscCliPath: 'tsc.js',
      viteCliPath: 'vite.js',
      environment: { CI: '1' },
    })).toEqual([
      expect.objectContaining({ args: ['tsc.js', '-b', '--pretty', 'false'] }),
      expect.objectContaining({
        args: ['vite.js', 'build'],
        env: expect.not.objectContaining({ CLOUDFLARE_ENV: 'preview' }),
      }),
    ]);
  });

  it('builds a branch once with the preview configuration', () => {
    expect(buildCloudflareCommandPlan({
      repositoryRoot: 'C:/repo',
      branch: 'feature/preview-me',
      nodeExecPath: 'node',
      tscCliPath: 'tsc.js',
      viteCliPath: 'vite.js',
      environment: { CI: '1' },
    })).toEqual([
      expect.objectContaining({ args: ['tsc.js', '-b', '--pretty', 'false'] }),
      expect.objectContaining({
        args: ['vite.js', 'build'],
        env: expect.objectContaining({ CLOUDFLARE_ENV: 'preview' }),
      }),
    ]);
  });

  it('resolves the checked-out branch when hosted build metadata is absent', () => {
    expect(resolveBuildBranch({}, 'feature/local-preview')).toBe('feature/local-preview');
  });

  it('refuses missing or contradictory branch identity', () => {
    expect(() => resolveBuildBranch({}, '')).toThrow(/branch identity/iu);
    expect(() => resolveBuildBranch({ WORKERS_CI_BRANCH: 'main' }, 'feature/not-main'))
      .toThrow(/does not match/iu);
    expect(() => buildCloudflareCommandPlan({
      repositoryRoot: 'C:/repo',
      nodeExecPath: 'node',
      tscCliPath: 'tsc.js',
      viteCliPath: 'vite.js',
      environment: {},
    })).toThrow(/branch identity/iu);
  });

  it('refuses to label dirty main-branch bytes as a production build', () => {
    expect(() => assertProductionBuildTreeClean('main', ' M src/App.tsx'))
      .toThrow(/clean working tree/iu);
    expect(() => assertProductionBuildTreeClean('feature/preview', ' M src/App.tsx'))
      .not.toThrow();
    expect(() => assertProductionBuildTreeClean('main', '')).not.toThrow();
  });
});

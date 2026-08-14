import { describe, expect, it } from 'vitest';

import { buildCloudflareCommandPlan } from '../../scripts/build-cloudflare';

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
});

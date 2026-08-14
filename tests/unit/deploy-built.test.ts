import { describe, expect, it } from 'vitest';

import {
  assertGeneratedDeploymentTarget,
  buildDeploymentCommandPlan,
  previewAlias,
} from '../../scripts/deploy-built';

describe('built-artifact deployment', () => {
  it('deploys the existing production artifact with one Wrangler command', () => {
    const plan = buildDeploymentCommandPlan({
      repositoryRoot: 'C:/repo',
      target: 'production',
      sha: 'a'.repeat(40),
      nodeExecPath: 'node',
      wranglerCliPath: 'wrangler.js',
      environment: { CLOUDFLARE_API_TOKEN: 'configured' },
    });

    expect(plan).toEqual([
      expect.objectContaining({
        id: 'deploy',
        executable: 'node',
        args: [
          'wrangler.js',
          'deploy',
          '--config',
          'dist/candidary/wrangler.json',
          '--strict',
          '--tag',
          'a'.repeat(40),
        ],
        cwd: 'C:/repo',
        shell: false,
      }),
    ]);
  });

  it('refuses to deploy a non-main Workers build to production', () => {
    expect(() => buildDeploymentCommandPlan({
      repositoryRoot: 'C:/repo',
      target: 'production',
      branch: 'feature/simpler-release',
      sha: 'b'.repeat(40),
      nodeExecPath: 'node',
      wranglerCliPath: 'wrangler.js',
      environment: {},
    })).toThrow(/production deployment requires the main branch/iu);
  });

  it('uploads an isolated preview version with a safe branch alias', () => {
    const plan = buildDeploymentCommandPlan({
      repositoryRoot: 'C:/repo',
      target: 'preview',
      branch: '123/This Is A Very Long Branch Name With Punctuation!!!',
      sha: 'c'.repeat(40),
      nodeExecPath: 'node',
      wranglerCliPath: 'wrangler.js',
      environment: {},
    });

    expect(plan[0]?.args).toEqual([
      'wrangler.js',
      'versions',
      'upload',
      '--config',
      'dist/candidary/wrangler.json',
      '--strict',
      '--tag',
      'c'.repeat(40),
      '--preview-alias',
      previewAlias('123/This Is A Very Long Branch Name With Punctuation!!!', 'c'.repeat(40)),
    ]);
    expect(plan[0]?.args.at(-1)).toMatch(/^[a-z][a-z0-9-]{0,44}$/u);
  });

  it('refuses a production artifact when a preview deploy was requested', () => {
    expect(() => assertGeneratedDeploymentTarget({
      name: 'candidary',
      workers_dev: false,
      preview_urls: false,
      d1_databases: [{ binding: 'DB', database_id: 'production-database' }],
      send_email: [{ name: 'EMAIL' }],
    }, 'preview')).toThrow(/does not match the requested preview target/iu);
  });

  it('accepts the generated isolated preview topology', () => {
    expect(() => assertGeneratedDeploymentTarget({
      name: 'candidary-preview',
      targetEnvironment: 'preview',
      workers_dev: true,
      preview_urls: true,
      d1_databases: [{
        binding: 'DB',
        database_id: 'bd816308-0c4c-48de-9ece-8d030360fb73',
      }],
      r2_buckets: [
        { binding: 'MEDIA_BUCKET', bucket_name: 'candidary-preview-media' },
        { binding: 'CANONICAL_MEDIA_BUCKET', bucket_name: 'candidary-preview-media-canonical' },
      ],
      send_email: [],
      triggers: { crons: [] },
    }, 'preview')).not.toThrow();
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertGeneratedDeploymentTarget,
  assertProductionDeploymentTreeClean,
  buildCronOnlyWranglerConfig,
  buildDeploymentCommandPlan,
  buildWorkflowOnlyWranglerConfig,
  previewAlias,
  resolveDeploymentBranch,
  resolveDeploymentSha,
} from '../../scripts/deploy-built';

const REQUIRED_SECRETS = [
  'TOKEN_HMAC_KEY',
  'SESSION_HMAC_KEY',
  'GUEST_TOKEN_ENCRYPTION_KEY',
  'LOGIN_HMAC_KEY',
  'ENTRY_HMAC_KEY',
  'ENTRY_ENCRYPTION_KEY',
  'RSVP_LOOKUP_HMAC_KEY',
  'GUEST_MESSAGE_HMAC_KEY',
  'ALBUM_SHARE_HMAC_KEY',
  'ALBUM_SHARE_ENCRYPTION_KEY',
];

function productionTopology(): Record<string, unknown> {
  return {
    name: 'candidary',
    workers_dev: false,
    preview_urls: false,
    d1_databases: [{
      binding: 'DB',
      database_name: 'candidary-core',
      database_id: '60bec5de-c8c7-41b5-a26b-2d3f7d184c71',
    }],
    r2_buckets: [
      { binding: 'MEDIA_BUCKET', bucket_name: 'candidary-media' },
      { binding: 'CANONICAL_MEDIA_BUCKET', bucket_name: 'candidary-media-canonical-v2' },
    ],
    images: { binding: 'IMAGES' },
    send_email: [{ name: 'EMAIL' }],
    ratelimits: [
      { name: 'HOST_AUTH_RATE_LIMIT', namespace_id: '1001', simple: { limit: 20, period: 60 } },
      { name: 'RSVP_LOOKUP_RATE_LIMIT', namespace_id: '1002', simple: { limit: 30, period: 60 } },
      { name: 'GUEST_MESSAGE_RATE_LIMIT', namespace_id: '1003', simple: { limit: 120, period: 60 } },
    ],
    workflows: [
      { name: 'candidary-export', binding: 'EXPORT_WORKFLOW', class_name: 'ExportWorkflow' },
      {
        name: 'candidary-cover-render',
        binding: 'COVER_RENDER_WORKFLOW',
        class_name: 'CoverRenderWorkflow',
      },
      {
        name: 'candidary-cover-backfill',
        binding: 'COVER_BACKFILL_WORKFLOW',
        class_name: 'CoverBackfillWorkflow',
      },
    ],
    triggers: { crons: ['17 3 * * *', '47 * * * *'] },
    vars: {
      APP_ORIGIN: 'https://candidary.app',
      ALTERNATE_ORIGINS: 'https://candidary.online',
      EMAIL_FROM: 'hello@candidary.app',
    },
    secrets: { required: REQUIRED_SECRETS },
    version_metadata: { binding: 'CF_VERSION_METADATA' },
  };
}

function previewTopology(): Record<string, unknown> {
  return {
    ...productionTopology(),
    name: 'candidary-preview',
    targetEnvironment: 'preview',
    workers_dev: true,
    preview_urls: true,
    d1_databases: [{
      binding: 'DB',
      database_name: 'candidary-preview-core',
      database_id: 'bd816308-0c4c-48de-9ece-8d030360fb73',
    }],
    r2_buckets: [
      { binding: 'MEDIA_BUCKET', bucket_name: 'candidary-preview-media' },
      { binding: 'CANONICAL_MEDIA_BUCKET', bucket_name: 'candidary-preview-media-canonical' },
    ],
    send_email: [],
    ratelimits: [
      { name: 'HOST_AUTH_RATE_LIMIT', namespace_id: '2001', simple: { limit: 20, period: 60 } },
      { name: 'RSVP_LOOKUP_RATE_LIMIT', namespace_id: '2002', simple: { limit: 30, period: 60 } },
      { name: 'GUEST_MESSAGE_RATE_LIMIT', namespace_id: '2003', simple: { limit: 120, period: 60 } },
    ],
    workflows: [
      { name: 'candidary-preview-export', binding: 'EXPORT_WORKFLOW', class_name: 'ExportWorkflow' },
      {
        name: 'candidary-preview-cover-render',
        binding: 'COVER_RENDER_WORKFLOW',
        class_name: 'CoverRenderWorkflow',
      },
      {
        name: 'candidary-preview-cover-backfill',
        binding: 'COVER_BACKFILL_WORKFLOW',
        class_name: 'CoverBackfillWorkflow',
      },
    ],
    triggers: { crons: [] },
    vars: {
      APP_ORIGIN: 'https://candidary-preview.lfd.workers.dev',
      ALTERNATE_ORIGINS: '',
      EMAIL_FROM: 'hello@candidary.app',
    },
  };
}

describe('built-artifact deployment', () => {
  it('exposes the upload-only production mode through the existing release script', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.['upload:production-version:built'])
      .toBe('node --experimental-strip-types scripts/deploy-built.ts production-upload');
    expect(packageJson.scripts?.['prepare:production-control-plane-configs:built'])
      .toBe('node --experimental-strip-types scripts/deploy-built.ts production-control-plane-configs');
  });

  it('projects a Cron-only config that cannot deploy Workflows or any other trigger class', () => {
    const production = {
      ...productionTopology(),
      compatibility_date: '2026-08-01',
      account_id: 'account-a',
      routes: [{ pattern: 'candidary.app/*', custom_domain: true }],
      queues: { consumers: [{ queue: 'must-not-deploy' }] },
      triggers: {
        crons: ['17 3 * * *', '47 * * * *'],
        events: [{ type: 'webhook', targets: [] }],
      },
    };

    expect(buildCronOnlyWranglerConfig(production)).toEqual({
      name: 'candidary',
      account_id: 'account-a',
      compatibility_date: '2026-08-01',
      workers_dev: false,
      preview_urls: false,
    });
    expect(JSON.stringify(buildCronOnlyWranglerConfig(production))).not.toMatch(
      /workflow|queue|route|trigger|schedule/iu,
    );
  });

  it('refuses to project a Cron config from anything except the validated production target', () => {
    expect(() => buildCronOnlyWranglerConfig(previewTopology()))
      .toThrow(/production target/iu);
    expect(() => buildCronOnlyWranglerConfig({ name: 'candidary' }))
      .toThrow(/production target/iu);
  });

  it('projects a Workflow-only config that cannot mutate Cron or any other trigger class', () => {
    const production = {
      ...productionTopology(),
      compatibility_date: '2026-08-01',
      account_id: 'account-a',
      routes: [{ pattern: 'candidary.app/*', custom_domain: true }],
      queues: { consumers: [{ queue: 'must-not-deploy' }] },
      triggers: {
        crons: ['17 3 * * *', '47 * * * *'],
        events: [{ type: 'webhook', targets: [] }],
      },
    };

    expect(buildWorkflowOnlyWranglerConfig(production)).toEqual({
      name: 'candidary',
      account_id: 'account-a',
      compatibility_date: '2026-08-01',
      workers_dev: false,
      preview_urls: false,
      workflows: productionTopology().workflows,
    });
    expect(JSON.stringify(buildWorkflowOnlyWranglerConfig(production))).not.toMatch(
      /queue|route|trigger|schedule/iu,
    );
  });

  it('refuses to project a Workflow config from anything except the validated production target', () => {
    expect(() => buildWorkflowOnlyWranglerConfig(previewTopology()))
      .toThrow(/production target/iu);
    expect(() => buildWorkflowOnlyWranglerConfig({ name: 'candidary' }))
      .toThrow(/production target/iu);
  });

  it('deploys the existing production artifact with one Wrangler command', () => {
    const plan = buildDeploymentCommandPlan({
      repositoryRoot: 'C:/repo',
      target: 'production',
      branch: 'main',
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

  it('uploads the validated production artifact as one inert version without deployment mutation', () => {
    const plan = buildDeploymentCommandPlan({
      repositoryRoot: 'C:/repo',
      target: 'production',
      uploadOnly: true,
      branch: 'main',
      sha: 'd'.repeat(40),
      nodeExecPath: 'node',
      wranglerCliPath: 'wrangler.js',
      environment: { CLOUDFLARE_API_TOKEN: 'configured' },
    });

    expect(plan).toEqual([
      expect.objectContaining({
        id: 'upload',
        executable: 'node',
        args: [
          'wrangler.js',
          'versions',
          'upload',
          '--config',
          'dist/candidary/wrangler.json',
          '--strict',
          '--tag',
          'd'.repeat(40),
        ],
        cwd: 'C:/repo',
        shell: false,
      }),
    ]);
    expect(plan[0]?.args).not.toContain('deploy');
    expect(plan[0]?.args).not.toContain('triggers');
    expect(plan[0]?.args).not.toContain('--preview-alias');
    expect(JSON.stringify(plan)).not.toContain('deploy');
  });

  it('refuses a non-main Workers build for both production operations', () => {
    for (const uploadOnly of [false, true]) {
      expect(() => buildDeploymentCommandPlan({
        repositoryRoot: 'C:/repo',
        target: 'production',
        uploadOnly,
        branch: 'feature/simpler-release',
        sha: 'b'.repeat(40),
        nodeExecPath: 'node',
        wranglerCliPath: 'wrangler.js',
        environment: {},
      })).toThrow(/production deployment requires the main branch/iu);
    }
  });

  it('refuses both production operations without a trustworthy branch identity', () => {
    for (const uploadOnly of [false, true]) {
      expect(() => buildDeploymentCommandPlan({
        repositoryRoot: 'C:/repo',
        target: 'production',
        uploadOnly,
        sha: 'b'.repeat(40),
        nodeExecPath: 'node',
        wranglerCliPath: 'wrangler.js',
        environment: {},
      })).toThrow(/branch identity/iu);
    }
    expect(() => resolveDeploymentBranch({ WORKERS_CI_BRANCH: 'main' }, 'feature/not-main'))
      .toThrow(/does not match/iu);
  });

  it('requires the deployment tag to match the checked-out commit', () => {
    expect(resolveDeploymentSha({}, 'a'.repeat(40))).toBe('a'.repeat(40));
    expect(() => resolveDeploymentSha(
      { WORKERS_CI_COMMIT_SHA: 'a'.repeat(40) },
      'b'.repeat(40),
    )).toThrow(/does not match checked-out HEAD/iu);
  });

  it('refuses to deploy dirty main-branch bytes as a clean commit', () => {
    expect(() => assertProductionDeploymentTreeClean(
      'production',
      'main',
      '?? src/uncommitted.ts',
    )).toThrow(/clean working tree/iu);
    expect(() => assertProductionDeploymentTreeClean(
      'preview',
      'feature/preview',
      '?? src/uncommitted.ts',
    )).not.toThrow();
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

  it('does not let upload-only production mode acquire preview behavior', () => {
    expect(() => buildDeploymentCommandPlan({
      repositoryRoot: 'C:/repo',
      target: 'preview',
      uploadOnly: true,
      branch: 'feature/preview',
      sha: 'c'.repeat(40),
      nodeExecPath: 'node',
      wranglerCliPath: 'wrangler.js',
      environment: {},
    })).toThrow(/restricted to the production target/iu);
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
    const preview = previewTopology();
    expect(() => assertGeneratedDeploymentTarget(preview, 'preview')).not.toThrow();
    expect(() => assertGeneratedDeploymentTarget({
      ...preview,
      send_email: [{ name: 'EMAIL' }],
    }, 'preview')).toThrow(/does not match the requested preview target/iu);
  });

  it('accepts the complete production topology and rejects safety-relevant drift', () => {
    const production = productionTopology();
    expect(() => assertGeneratedDeploymentTarget(production, 'production')).not.toThrow();

    const invalid = [
      { ...production, targetEnvironment: 'staging' },
      { ...production, images: { binding: 'WRONG_IMAGES' } },
      { ...production, triggers: { crons: [] } },
      { ...production, send_email: [] },
      { ...production, workflows: previewTopology().workflows },
      { ...production, vars: previewTopology().vars },
      { ...production, ratelimits: previewTopology().ratelimits },
      { ...production, secrets: { required: REQUIRED_SECRETS.slice(1) } },
    ];
    for (const topology of invalid) {
      expect(() => assertGeneratedDeploymentTarget(topology, 'production'))
        .toThrow(/does not match the requested production target/iu);
    }
  });
});

import { describe, expect, it } from 'vitest';

import {
  assertSafeCloudflareCommand,
  buildCloudflareCommand,
} from '../../scripts/staging-release-cloudflare';

const root = 'C:/owned/task-11';
const wrangler = 'C:/candidate/node_modules/wrangler/bin/wrangler.js';
const config = 'C:/owned/task-11/deploy-root/dist/candidary/wrangler.staging.json';

describe('Task 11 pinned Cloudflare command plan', () => {
  it('pins remote D1 mutation to one staging config and manifest-bound file', () => {
    const command = buildCloudflareCommand({
      id: 'd1-execute', root, wrangler, config,
      inputPath: 'C:/owned/task-11/operations/01-seed.sql',
    });
    expect(command.executable).toBe(process.execPath);
    expect(command.args).toEqual([
      wrangler, 'd1', 'execute', 'candidary-core-staging', '--remote',
      '--config', config, '--json', '--file', 'C:/owned/task-11/operations/01-seed.sql',
    ]);
    expect(assertSafeCloudflareCommand(command, root)).toEqual(command);
  });

  it('uses read-only command execution when the caller needs returned D1 rows', () => {
    const sql = 'SELECT count(*) AS observed_count FROM events;';
    const command = buildCloudflareCommand({
      id: 'd1-observe', root, wrangler, config, sql,
    });
    expect(command.args).toEqual([
      wrangler, 'd1', 'execute', 'candidary-core-staging', '--remote',
      '--config', config, '--json', '--command', sql,
    ]);
    expect(assertSafeCloudflareCommand(command, root)).toEqual(command);
    expect(() => buildCloudflareCommand({
      id: 'd1-observe', root, wrangler, config, sql: 'DELETE FROM events;',
    })).toThrow(/read-only/u);
  });

  it('builds only pinned deploy, R2, Worker, Workflow, and inventory operations', () => {
    for (const input of [
      { id: 'deploy' as const, root, wrangler, config, candidateSha: '1'.repeat(40) },
      { id: 'r2-put' as const, root, wrangler, config, objectSuffix: 'conformance/run/fixture', inputPath: 'C:/owned/task-11/fixture.jpg' },
      { id: 'r2-get' as const, root, wrangler, config, objectSuffix: 'conformance/run/fixture', outputPath: 'C:/owned/task-11/output.jpg' },
      { id: 'worker-delete' as const, root, wrangler, config },
      { id: 'workflow-delete' as const, root, wrangler, config, workflowName: 'candidary-staging-cover-backfill' },
      { id: 'd1-delete' as const, root, wrangler, config },
      { id: 'r2-delete' as const, root, wrangler, config },
      { id: 'deployments-status' as const, root, wrangler, config },
      { id: 'versions-list' as const, root, wrangler, config },
    ]) {
      expect(() => assertSafeCloudflareCommand(buildCloudflareCommand(input), root)).not.toThrow();
    }
  });

  it('rejects npx, production identities, migrations apply, path escape, and shell execution', () => {
    const base = buildCloudflareCommand({
      id: 'deploy', root, wrangler, config, candidateSha: '1'.repeat(40),
    });
    expect(() => assertSafeCloudflareCommand({ ...base, executable: 'npx' }, root)).toThrow(/pinned Node/u);
    expect(() => assertSafeCloudflareCommand({ ...base, args: [...base.args, 'candidary-core'] }, root)).toThrow(/production/u);
    expect(() => assertSafeCloudflareCommand({ ...base, args: [wrangler, 'd1', 'migrations', 'apply'] }, root)).toThrow(/migrations apply/u);
    expect(() => assertSafeCloudflareCommand({ ...base, cwd: 'C:/foreign' }, root)).toThrow(/owned root/u);
    expect(() => assertSafeCloudflareCommand({ ...base, shell: true } as never, root)).toThrow(/shell/u);
  });
});

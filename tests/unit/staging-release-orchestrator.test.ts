import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { STAGING_TARGET } from '../../scripts/staging-release-contract';
import {
  runStagingReleasePhase,
  type StagingReleasePhaseAdapters,
} from '../../scripts/staging-release';

const SHA = '1'.repeat(40);
const TREE = '2'.repeat(40);
const RUN_ID = '12345678-1234-4123-8123-123456789abc';
const TARGET_PATH = 'output/staging-input/task-11-target.json';

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'candidary-task-11-state-'));
  const directory = join(root, 'output', 'staging-input');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(root, ...TARGET_PATH.split('/')), `${JSON.stringify({
    schemaVersion: 1,
    authorization: 'approved',
    accountId: 'a'.repeat(32),
    databaseId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    hostAuthRateLimitNamespaceId: '2001',
    rsvpRateLimitNamespaceId: '2002',
    target: STAGING_TARGET,
  })}\n`);
  return root;
}

function adapters(): StagingReleasePhaseAdapters {
  return {
    now: vi.fn(() => '2026-08-11T03:00:00.000Z'),
    verifyCandidate: vi.fn(() => ({
      sha: SHA,
      tree: TREE,
      manifestSha256: '3'.repeat(64),
      migrationManifestSha256: '4'.repeat(64),
      approvedBaseSha: '0b92387d2e237d568d2514373dcc3044e7960d4b',
      integratedMainSha: 'b5339a0cb211b933366059af8fa3f89488bb4e20',
    } as const)),
    probe: vi.fn(async () => ({
      status: 'passed' as const,
      recovery: 'idempotent-create-batch' as const,
      discriminator: null,
      observationCode: 'no-distinct-workflow-missing-discriminator' as const,
      probeAbsent: true as const,
    })),
    deploy: vi.fn(async () => ({
      status: 'passed' as const,
      versionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      trafficPercent: 100 as const,
      sourceDigest: '5'.repeat(64),
      migrationCount: 13 as const,
      migrationLedgerSha256: '6'.repeat(64),
    })),
    conform: vi.fn(async () => ({
      status: 'passed' as const,
      runtime: {
        versionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        versionTag: SHA,
        versionTimestamp: '2026-08-11T03:00:00.000Z',
      },
      fixtureManifestSha256: '7'.repeat(64),
      images: [{ caseId: 'all-images', status: 'passed' as const, observationCode: 'matrix-complete' }],
      workflows: [{ caseId: 'all-workflows', status: 'passed' as const, observationCode: 'matrix-complete' }],
      zeroProof: {
        legacyRows: 0,
        blockingJobs: 0,
        incompleteActiveSets: 0,
        uploadsWithoutActiveSet: 0,
      } as const,
      verifiedAt: '2026-08-11T03:00:00.000Z',
    })),
    cleanup: vi.fn(async () => ({
      fixturesAbsent: true,
      workerAbsent: true,
      databaseAbsent: true,
      bucketAbsent: true,
      workflowsAbsent: true,
      callersAbsent: true,
      probeAbsent: true,
    })),
  };
}

function request(root: string, mode: 'probe' | 'deploy' | 'conform' | 'cleanup' | 'finalize' | 'verify') {
  return { projectRoot: root, mode, candidateSha: SHA, runId: RUN_ID, targetPath: TARGET_PATH } as const;
}

describe('Task 11 six-mode orchestrator', () => {
  it('allows only probe, deploy, conform, cleanup, finalize, verify and chains every receipt', async () => {
    const root = project();
    const api = adapters();
    for (const mode of ['probe', 'deploy', 'conform', 'cleanup', 'finalize', 'verify'] as const) {
      await runStagingReleasePhase(request(root, mode), api);
    }

    const runRoot = join(root, 'output', 'operations', 'event-cover', SHA, 'task-11', RUN_ID);
    for (const filename of [
      '01-probe.json', '02-deploy.json', '03-conform.json', '04-cleanup.json',
      '05-finalize.json', '06-verify.json', 'staging-conformance.json',
    ]) {
      expect(readFileSync(join(runRoot, filename), 'utf8')).toMatch(/\n$/u);
      expect(readFileSync(join(runRoot, `${filename}.sha256`), 'utf8')).toMatch(/^[0-9a-f]{64} {2}/u);
    }
    const artifact = JSON.parse(readFileSync(join(runRoot, 'staging-conformance.json'), 'utf8')) as {
      status: string; candidateSha: string; runId: string;
    };
    expect(artifact).toMatchObject({ status: 'passed', candidateSha: SHA, runId: RUN_ID });
  });

  it('fails before remote calls when a phase is skipped or a receipt drifts', async () => {
    const root = project();
    const api = adapters();
    await expect(runStagingReleasePhase(request(root, 'deploy'), api)).rejects.toThrow(/predecessor/u);
    expect(api.deploy).not.toHaveBeenCalled();

    await runStagingReleasePhase(request(root, 'probe'), api);
    const receipt = join(root, 'output', 'operations', 'event-cover', SHA, 'task-11', RUN_ID, '01-probe.json');
    writeFileSync(receipt, readFileSync(receipt, 'utf8').replace('passed', 'failed'));
    await expect(runStagingReleasePhase(request(root, 'deploy'), api)).rejects.toThrow(/sidecar/u);
    expect(api.deploy).not.toHaveBeenCalled();
  });
});

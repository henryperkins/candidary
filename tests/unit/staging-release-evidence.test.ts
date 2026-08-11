// @vitest-environment node

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { canonicalJson, sha256 } from '../../scripts/release-evidence';
import {
  STAGING_BROWSER_CASE_IDS,
  STAGING_IMAGES_CASE_IDS,
  STAGING_ROUTE_CASE_IDS,
  STAGING_WORKFLOW_CASE_IDS,
  assertStagingConformanceArtifact,
  assertCompleteCleanup,
  makePhaseReceipt,
  task11Root,
  verifyReceipt,
  verifyReceiptFile,
  writeExclusiveCanonical,
  writeFinalArtifact,
  writePhaseReceipt,
  writeStagingConformanceArtifact,
  verifyStagingConformanceArtifactFile,
  type StagingConformanceArtifactV1,
} from '../../scripts/staging-release-evidence';

const CANDIDATE_SHA = 'a'.repeat(40);
const RUN_ID = '1000000a-0000-4000-8000-000000000001';
const RECORDED_AT = '2026-08-10T12:00:00.000Z';
const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true });
  roots.clear();
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'candidary-staging-evidence-'));
  roots.add(root);
  return root;
}

describe('Task 11 evidence', () => {
  it('derives the run root beneath ignored operations output', () => {
    const root = temporaryRoot();
    expect(task11Root(root, CANDIDATE_SHA, RUN_ID)).toBe(join(
      root,
      'output',
      'operations',
      'event-cover',
      CANDIDATE_SHA,
      'task-11',
      RUN_ID,
    ));
  });

  it('chains every receipt to the exact canonical predecessor digest', () => {
    const probe = makePhaseReceipt({
      phase: 'probe', candidateSha: CANDIDATE_SHA, runId: RUN_ID,
      predecessorSha256: null, recordedAt: RECORDED_AT,
      result: { outcome: 'complete', discriminator: 'code-10091' },
    });
    const probeSha = sha256(`${canonicalJson(probe)}\n`);
    const deploy = makePhaseReceipt({
      phase: 'deploy', candidateSha: CANDIDATE_SHA, runId: RUN_ID,
      predecessorSha256: probeSha, recordedAt: RECORDED_AT,
      result: { outcome: 'complete', migrationCount: 13 },
    });

    expect(verifyReceipt(probe, null).sha256).toBe(probeSha);
    expect(verifyReceipt(deploy, probeSha).receipt.phase).toBe('deploy');
    expect(() => verifyReceipt(deploy, '0'.repeat(64))).toThrow(/predecessor/u);
  });

  it('writes canonical bytes and a matching sidecar exclusively', () => {
    const root = temporaryRoot();
    const path = join(root, 'artifact.json');
    const value = { status: 'partial', candidateSha: CANDIDATE_SHA };
    const digest = writeExclusiveCanonical(path, value);

    const bytes = readFileSync(path, 'utf8');
    expect(bytes).toBe(`${canonicalJson(value)}\n`);
    expect(digest).toBe(sha256(bytes));
    expect(readFileSync(`${path}.sha256`, 'utf8')).toBe(`${digest}  artifact.json\n`);
    expect(() => writeExclusiveCanonical(path, { status: 'failed' })).toThrow(/exists/u);
    expect(readFileSync(path, 'utf8')).toBe(bytes);
  });

  it('writes numbered phase receipts and verifies their files from disk', () => {
    const root = temporaryRoot();
    const receipt = makePhaseReceipt({
      phase: 'probe', candidateSha: CANDIDATE_SHA, runId: RUN_ID,
      predecessorSha256: null, recordedAt: RECORDED_AT,
      result: { outcome: 'complete' },
    });
    const written = writePhaseReceipt(root, 1, receipt);
    expect(written.path).toBe(join(root, '01-probe.json'));
    expect(verifyReceiptFile(written.path, null).sha256).toBe(written.sha256);

    writeFileSync(written.path, '{}\n', 'utf8');
    expect(() => verifyReceiptFile(written.path, null)).toThrow(/sidecar|schema|candidate/u);
  });

  it('rejects private fields and values before creating any file', () => {
    const root = temporaryRoot();
    const path = join(root, 'bad.json');
    expect(() => writeExclusiveCanonical(path, { objectKey: 'events/private/file.webp' }))
      .toThrow(/forbidden evidence field/u);
    expect(() => writeExclusiveCanonical(path, { result: 'https://example.invalid/private' }))
      .toThrow(/URL/u);
    expect(() => writeExclusiveCanonical(path, { result: 'token=private' }))
      .toThrow(/secret-shaped/u);
    expect(() => readFileSync(path)).toThrow();
  });

  it('refuses a passing final artifact until every cleanup observation is true', () => {
    const completeCleanup = {
      fixturesAbsent: true,
      workerAbsent: true,
      databaseAbsent: true,
      bucketAbsent: true,
      workflowsAbsent: true,
      callersAbsent: true,
      probeAbsent: true,
    } as const;
    expect(assertCompleteCleanup(completeCleanup)).toEqual(completeCleanup);
    expect(() => assertCompleteCleanup({ ...completeCleanup, bucketAbsent: false }))
      .toThrow(/bucketAbsent/u);

    const root = temporaryRoot();
    const path = join(root, 'staging-conformance.json');
    const artifact = {
      schemaVersion: 1,
      status: 'passed',
      candidateSha: CANDIDATE_SHA,
      runId: RUN_ID,
      cleanup: completeCleanup,
      receiptSha256: 'b'.repeat(64),
    } as const;
    const written = writeFinalArtifact(path, artifact);
    expect(written.sha256).toBe(sha256(readFileSync(path)));
    expect(() => writeFinalArtifact(join(root, 'second.json'), {
      ...artifact,
      cleanup: { ...completeCleanup, workerAbsent: false },
    })).toThrow(/workerAbsent/u);
  });
});

const PHASE_2_SHA = 'c'.repeat(40);

function passedMatrix(caseIds: readonly string[]) {
  return caseIds.map((caseId) => ({ caseId, status: 'passed' as const, observationCode: 'verified' }));
}

function destroyed() {
  return {
    fixturesAbsent: true,
    workerAbsent: true,
    databaseAbsent: true,
    r2Absent: true,
    imagesAbsent: true,
    emailAbsent: true,
    rateLimitsAbsent: true,
    workflowsAbsent: true,
    assetsAbsent: true,
  } as const;
}

function stagingArtifact(): StagingConformanceArtifactV1 {
  return {
    kind: 'candidary.staging-conformance', schemaVersion: 1, status: 'passed',
    candidateSha: CANDIDATE_SHA, runId: RUN_ID, approvedMainSha: 'd'.repeat(40),
    sources: {
      phase2: {
        sha: PHASE_2_SHA, manifestSha256: '1'.repeat(64), migrationManifestSha256: '2'.repeat(64),
      },
      phase3: {
        sha: CANDIDATE_SHA, manifestSha256: '3'.repeat(64), migrationManifestSha256: '4'.repeat(64),
      },
    },
    authorizations: { reviewSha256: '5'.repeat(64), stagingSha256: '6'.repeat(64) },
    targets: { workflowConformanceSha256: '7'.repeat(64), cutoverSha256: '8'.repeat(64) },
    migrations: {
      phase2Ledger: [
        '0001_core.sql', '0002_wedding_photo_drop.sql', '0003_partitioned_exports.sql',
        '0004_manager_media_pagination.sql', '0005_media_stored_at.sql', '0006_host_accounts.sql',
        '0007_event_theme.sql', '0008_event_rsvp.sql', '0009_rsvp_roster_batches.sql',
        '0010_event_start.sql', '0011_release_certifications.sql',
        '0012_event_cover_storage.sql', '0013_guest_message_hardening.sql',
      ],
      phase3Ledger: [
        '0001_core.sql', '0002_wedding_photo_drop.sql', '0003_partitioned_exports.sql',
        '0004_manager_media_pagination.sql', '0005_media_stored_at.sql', '0006_host_accounts.sql',
        '0007_event_theme.sql', '0008_event_rsvp.sql', '0009_rsvp_roster_batches.sql',
        '0010_event_start.sql', '0011_release_certifications.sql',
        '0012_event_cover_storage.sql', '0013_guest_message_hardening.sql',
        '0014_event_cover_invariants.sql',
      ],
      bootstrapSha256: '9'.repeat(64), phase3MigrationSha256: 'a'.repeat(64),
      phase3BundleSha256: 'b'.repeat(64),
      triggerNames: [
        'event_cover_master_live_reference_delete',
        'event_cover_render_object_manifest_delete',
        'event_cover_render_object_manifest_insert',
        'event_cover_render_object_manifest_update',
        'event_cover_render_set_live_reference_delete',
        'event_cover_render_set_manifest_insert',
        'event_cover_render_set_manifest_update',
        'event_cover_source_pointer_insert',
        'event_cover_source_pointer_update',
      ],
      zeroCounts: {
        legacyRows: 0, blockingJobs: 0, incompleteActiveSets: 0, uploadsWithoutActiveSet: 0,
      },
      integrity: 'ok', foreignKeyRows: 0,
    },
    deployments: {
      workflowConformance: {
        versionId: '1000000a-0000-4000-8000-000000000011', tagSha: CANDIDATE_SHA,
        metadataSha: CANDIDATE_SHA, trafficPercent: 100,
      },
      phase2Cutover: {
        versionId: '1000000a-0000-4000-8000-000000000012', tagSha: PHASE_2_SHA,
        metadataSha: PHASE_2_SHA, trafficPercent: 100,
      },
      phase3Cutover: {
        versionId: '1000000a-0000-4000-8000-000000000013', tagSha: CANDIDATE_SHA,
        metadataSha: CANDIDATE_SHA, trafficPercent: 100,
      },
    },
    matrices: {
      images: passedMatrix(STAGING_IMAGES_CASE_IDS),
      backfillWorkflow: passedMatrix(STAGING_WORKFLOW_CASE_IDS),
      renderWorkflow: passedMatrix(STAGING_WORKFLOW_CASE_IDS),
      routes: passedMatrix(STAGING_ROUTE_CASE_IDS),
      browser: passedMatrix(STAGING_BROWSER_CASE_IDS),
    },
    cleanup: { workflowConformance: destroyed(), cutover: destroyed() },
    startedAt: '2026-08-10T12:00:00.000Z', finishedAt: '2026-08-10T14:00:00.000Z',
  };
}

function expectedArtifactBindings(artifact: StagingConformanceArtifactV1) {
  return {
    candidateSha: artifact.candidateSha,
    phase2Sha: artifact.sources.phase2.sha,
    approvedMainSha: artifact.approvedMainSha,
    phase2ManifestSha256: artifact.sources.phase2.manifestSha256,
    candidateManifestSha256: artifact.sources.phase3.manifestSha256,
    phase2MigrationManifestSha256: artifact.sources.phase2.migrationManifestSha256,
    phase3MigrationManifestSha256: artifact.sources.phase3.migrationManifestSha256,
    reviewAuthorizationSha256: artifact.authorizations.reviewSha256,
    stagingAuthorizationSha256: artifact.authorizations.stagingSha256,
    workflowTargetSha256: artifact.targets.workflowConformanceSha256,
    cutoverTargetSha256: artifact.targets.cutoverSha256,
    bootstrapSha256: artifact.migrations.bootstrapSha256,
    phase3MigrationSha256: artifact.migrations.phase3MigrationSha256,
    phase3BundleSha256: artifact.migrations.phase3BundleSha256,
  };
}

describe('Task 12 immutable staging conformance artifact', () => {
  it('writes canonical bytes exclusively and independently rebinds every source digest', () => {
    const root = temporaryRoot();
    const artifact = stagingArtifact();
    expect(assertStagingConformanceArtifact(artifact)).toEqual(artifact);
    const path = join(root, 'staging-conformance.json');
    const written = writeStagingConformanceArtifact(path, artifact);
    expect(readFileSync(path, 'utf8')).toBe(`${canonicalJson(artifact)}\n`);
    expect(verifyStagingConformanceArtifactFile(path, expectedArtifactBindings(artifact)))
      .toMatchObject({ sha256: written.sha256, artifact });
    expect(() => writeStagingConformanceArtifact(path, artifact)).toThrow(/exists/u);
  });

  it('rejects incomplete ledgers, matrices, traffic, cleanup, status, bindings, and unsafe evidence', () => {
    const mutations: Array<(artifact: StagingConformanceArtifactV1) => void> = [
      (artifact) => { artifact.status = 'incomplete' as 'passed'; },
      (artifact) => { artifact.migrations.phase2Ledger.pop(); },
      (artifact) => { artifact.migrations.phase3Ledger.pop(); },
      (artifact) => { artifact.migrations.triggerNames.pop(); },
      (artifact) => { artifact.matrices.images.pop(); },
      (artifact) => { artifact.matrices.backfillWorkflow[0]!.status = 'failed' as 'passed'; },
      (artifact) => { artifact.deployments.phase3Cutover.trafficPercent = 99; },
      (artifact) => { artifact.cleanup.workflowConformance.workerAbsent = false; },
      (artifact) => { (artifact as unknown as Record<string, unknown>).privateUrl = 'https://private.invalid'; },
    ];
    for (const mutate of mutations) {
      const artifact = stagingArtifact();
      mutate(artifact);
      expect(() => assertStagingConformanceArtifact(artifact)).toThrow();
    }
  });

  it('rejects noncanonical bytes, sidecar drift, and any independently supplied digest mismatch', () => {
    const root = temporaryRoot();
    const artifact = stagingArtifact();
    const path = join(root, 'staging-conformance.json');
    writeStagingConformanceArtifact(path, artifact);
    const expected = expectedArtifactBindings(artifact);
    expect(() => verifyStagingConformanceArtifactFile(path, {
      ...expected, candidateManifestSha256: '0'.repeat(64),
    })).toThrow(/bind|digest|manifest/u);
    writeFileSync(`${path}.sha256`, `${'0'.repeat(64)}  staging-conformance.json\n`);
    expect(() => verifyStagingConformanceArtifactFile(path, expected)).toThrow(/sidecar|digest/u);

    const noncanonicalPath = join(root, 'noncanonical.json');
    const bytes = `${JSON.stringify(artifact, null, 2)}\n`;
    writeFileSync(noncanonicalPath, bytes);
    writeFileSync(`${noncanonicalPath}.sha256`, `${sha256(bytes)}  noncanonical.json\n`);
    expect(() => verifyStagingConformanceArtifactFile(noncanonicalPath, expected)).toThrow(/canonical/u);
  });
});

// @vitest-environment node

import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  canonicalJson,
  normalizedBindingTopology,
  sha256,
  type CandidateManifest,
} from '../../scripts/release-evidence';
import type { VerifiedReleaseCandidate } from '../../scripts/release-candidate';
import {
  BRIDGE_CAPABILITIES,
  BRIDGE_SOURCE_MAIN_SHA,
  bridgeExportCanaryRequest,
  bridgeVersionTrafficPercent,
  bridgeVersionUploadMessage,
  buildBridgeVersionCommandPlan,
  bridgeProductionIdentity,
  observeBridgeUploadedVersionFromWrangler,
  parseBridgeWranglerUploadOutput,
  parseBridgeWranglerVersionList,
  parseBridgeReleaseArgs,
  runBridgeRelease,
  scanBridgeSignerSurface,
  verifyMediaWriteBridgeDeploymentEvidence,
  type BridgeReleaseAdapters,
  type MediaWriteBridgeAuthorizationV1,
} from '../../scripts/bridge-release';
import {
  CANONICAL_MEDIA_BINDING,
  CANONICAL_MEDIA_BUCKET_NAME,
  LEGACY_MEDIA_BINDING,
  LEGACY_MEDIA_BUCKET_NAME,
  type CanonicalMediaBucketProvisioningEvidenceV1,
} from '../../scripts/media-cutover-release-contract';

const SHA = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const BASE = '0b92387d2e237d568d2514373dcc3044e7960d4b';
const ACCOUNT = 'f'.repeat(32);
const MANIFEST_SHA = '1'.repeat(64);
const ARTIFACT_TREE_SHA = '2'.repeat(64);
const TOPOLOGY_SHA = '3'.repeat(64);
const WORKER_SHA = '4'.repeat(64);
const REMOTE_BINDINGS_SHA = '5'.repeat(64);
const REMOTE_RUNTIME_SHA = '6'.repeat(64);
const RUN_ID = '1000000a-0000-4000-8000-000000000001';
const VERSION_ID = '1000000a-0000-4000-8000-000000000099';
const TOKEN_ID = 'c580e42d532fea4f8cf3897a9c637346';
const NOW = '2026-08-13T12:00:00.000Z';
const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true });
  roots.clear();
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'candidary-bridge-release-'));
  roots.add(root);
  return root;
}

function put(root: string, path: string, contents: string): string {
  const target = join(root, ...path.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, 'utf8');
  return target;
}

function writeCanonicalInput(path: string, value: unknown): string {
  const bytes = `${canonicalJson(value)}\n`;
  put(dirname(path), basename(path), bytes);
  const digest = sha256(bytes);
  put(dirname(path), `${basename(path)}.sha256`, `${digest}  ${basename(path)}\n`);
  return digest;
}

function bucketEvidence(): CanonicalMediaBucketProvisioningEvidenceV1 {
  return {
    kind: 'candidary.canonical-media-bucket-provisioning-evidence',
    schemaVersion: 1,
    status: 'ready',
    runId: RUN_ID,
    provider: 'cloudflare-r2',
    accountId: ACCOUNT,
    legacyBucket: {
      binding: LEGACY_MEDIA_BINDING,
      bucketName: LEGACY_MEDIA_BUCKET_NAME,
      r2SigningTokenId: TOKEN_ID,
    },
    canonicalBucket: {
      binding: CANONICAL_MEDIA_BINDING,
      bucketName: CANONICAL_MEDIA_BUCKET_NAME,
    },
    providerResponses: {
      bucketCreateReceiptSha256: '4'.repeat(64),
      bucketStatusObservationSha256: '5'.repeat(64),
      corsPolicyObservationSha256: '6'.repeat(64),
      publicAccessObservationSha256: '7'.repeat(64),
      initialEmptyBucketObservationSha256: '8'.repeat(64),
    },
    canonicalAccess: {
      publicAccess: 'disabled', developmentUrl: 'disabled', cors: 'none',
    },
    createdAt: '2026-08-13T11:00:00.000Z',
    observedAt: '2026-08-13T11:10:00.000Z',
    operator: 'storage-owner',
  };
}

function fixture() {
  const root = temporaryRoot();
  const manifestPath = put(root, 'candidate-manifest.json', '{}\n');
  const runtime = {
    kind: 'candidary.media-upload-release' as const,
    schemaVersion: 1 as const,
    mode: 'bridge-disabled' as const,
    capabilities: { ...BRIDGE_CAPABILITIES },
  };
  const runtimePath = put(root, 'config/media-upload-release.json', `${canonicalJson(runtime)}\n`);
  const canonicalEvidencePath = resolve(root, 'canonical-media-bucket-provisioning-evidence.json');
  const canonicalEvidenceSha256 = writeCanonicalInput(canonicalEvidencePath, bucketEvidence());
  const authorization: MediaWriteBridgeAuthorizationV1 = {
    kind: 'candidary.media-write-bridge-authorization', schemaVersion: 1, runId: RUN_ID,
    approvedMainSha: BRIDGE_SOURCE_MAIN_SHA, bridgeSha: SHA,
    bridgeManifestSha256: MANIFEST_SHA,
    bridgeArtifactTreeSha256: ARTIFACT_TREE_SHA, productionTopologySha256: TOPOLOGY_SHA,
    runtimeContractSha256: sha256(readFileSync(runtimePath)),
    canonicalBucketProvisioningEvidenceSha256: canonicalEvidenceSha256,
    accountId: ACCOUNT, workerName: 'candidary', r2SigningTokenId: TOKEN_ID,
    authorizedAt: '2026-08-13T11:55:00.000Z', expiresAt: '2026-08-13T13:00:00.000Z',
    operator: 'release-owner',
  };
  const authorizationPath = resolve(root, 'media-write-bridge-authorization.json');
  writeCanonicalInput(authorizationPath, authorization);
  const candidate = {
    candidateRoot: root, sha: SHA, tree: TREE, approvedBaseSha: BASE,
    manifestPath, manifestSha256: MANIFEST_SHA,
    manifest: { bindings: { sourceTopologySha256: '9'.repeat(64) }, artifacts: {} } as CandidateManifest,
    migrations: Array.from({ length: 14 }, (_value, index) => ({
      path: `migrations/${String(index + 1).padStart(4, '0')}_fixture.sql`,
      bytes: 1,
      sha256: String((index + 1) % 10).repeat(64),
    })),
    migrationCount: 14, artifactTreeSha256: ARTIFACT_TREE_SHA,
    wranglerVersion: '4.113.0', wranglerCliPath: resolve(root, 'node_modules/wrangler/bin/wrangler.js'),
  } satisfies VerifiedReleaseCandidate;
  const evidencePath = resolve(root, 'output/production-bridge', SHA, RUN_ID,
    'media-write-bridge-deployment-evidence.json');
  return {
    root, manifestPath, runtime, runtimePath, candidate, authorization, authorizationPath,
    canonicalEvidencePath, evidencePath,
  };
}

function adapters(source: ReturnType<typeof fixture>) {
  const uploadMessage = bridgeVersionUploadMessage({
    runId: RUN_ID,
    manifestSha256: MANIFEST_SHA,
    artifactTreeSha256: ARTIFACT_TREE_SHA,
  });
  const state: {
    uploads: number;
    deploys: number;
    observations: number;
    uploaded: boolean;
    trafficPercent: number;
    ancestryChecks: number;
    adapter: BridgeReleaseAdapters;
  } = {
    uploads: 0,
    deploys: 0,
    observations: 0,
    uploaded: false,
    trafficPercent: 0,
    ancestryChecks: 0,
    adapter: {
      now: () => NOW,
      verifyCandidate() { return source.candidate; },
      isAncestor(_candidateRoot, baseSha, candidateSha) {
        expect(baseSha).toBe(BRIDGE_SOURCE_MAIN_SHA);
        expect(candidateSha).toBe(SHA);
        state.ancestryChecks += 1;
        return true;
      },
      productionIdentity() {
        return {
          accountId: ACCOUNT, workerName: 'candidary' as const,
          topologySha256: TOPOLOGY_SHA,
          workerSha256: WORKER_SHA,
          allowedRemoteBindingsSha256: [REMOTE_BINDINGS_SHA, '7'.repeat(64)],
          remoteRuntimeSha256: REMOTE_RUNTIME_SHA,
          requiredSecretNames: [
            'ENTRY_ENCRYPTION_KEY', 'ENTRY_HMAC_KEY', 'GUEST_TOKEN_ENCRYPTION_KEY',
            'LOGIN_HMAC_KEY', 'RSVP_LOOKUP_HMAC_KEY', 'SESSION_HMAC_KEY', 'TOKEN_HMAC_KEY',
          ],
        };
      },
      withVerifiedSnapshot(_request, action) {
        return action(source.candidate, source.root);
      },
      snapshotArtifactIdentity() {
        return { treeSha256: ARTIFACT_TREE_SHA, workerSha256: WORKER_SHA };
      },
      observeWranglerAccount() {
        return { accountIds: [ACCOUNT] };
      },
      listVersions() {
        return state.uploaded ? [{
          versionId: VERSION_ID,
          workerName: 'candidary',
          tagSha: SHA,
          uploadMessage,
        }] : [];
      },
      uploadVersion() {
        state.uploads += 1;
        state.uploaded = true;
        return { versionId: VERSION_ID, workerName: 'candidary', tagSha: SHA };
      },
      observeUploadedVersion() {
        return {
          accountId: ACCOUNT,
          workerName: 'candidary',
          versionId: VERSION_ID,
          tagSha: SHA,
          uploadMessage,
          trafficPercent: state.trafficPercent,
          providerScriptEtag: '8'.repeat(64),
          localWorkerSha256: WORKER_SHA,
          bindingsSha256: REMOTE_BINDINGS_SHA,
          runtimeSha256: REMOTE_RUNTIME_SHA,
          observedAt: '2026-08-13T11:58:00.000Z',
        };
      },
      deployVersion(_candidate, _deployRoot, _accountId, versionId) {
        expect(versionId).toBe(VERSION_ID);
        state.deploys += 1;
        state.trafficPercent = 100;
      },
      observeDeployment() {
        state.observations += 1;
        return { versionId: VERSION_ID, tagSha: SHA, trafficPercent: state.trafficPercent };
      },
      scanSignerSurface() {
        return { xAmzUrlCount: 0, r2SignerReferenceCount: 0 };
      },
      observeExportDownloadCanary() {
        return {
          status: 'passed' as const,
          httpStatus: 200 as const,
          method: 'GET' as const,
          artifactUrlSha256: '6'.repeat(64),
          expectedArtifactSha256: '4'.repeat(64),
          responseSha256: '4'.repeat(64),
          expectedByteLength: 128,
          responseByteLength: 128,
          sameOrigin: true as const,
          redirected: false as const,
          cacheControl: 'private, no-store' as const,
          contentDisposition: 'attachment' as const,
          contentType: 'application/zip' as const,
          xContentTypeOptions: 'nosniff' as const,
          observedAt: '2026-08-13T11:59:00.000Z',
        };
      },
    } as BridgeReleaseAdapters,
  };
  return state;
}

function bridgeProductionConfig(): Record<string, unknown> {
  return {
    configPath: 'C:/candidate/wrangler.jsonc',
    userConfigPath: 'C:/candidate/wrangler.jsonc',
    topLevelName: 'candidary',
    definedEnvironments: [],
    name: 'candidary', main: 'index.js', workers_dev: false, preview_urls: false,
    compatibility_date: '2026-07-21', compatibility_flags: ['nodejs_compat'],
    jsx_factory: 'React.createElement', jsx_fragment: 'React.Fragment',
    rules: [{ type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] }],
    assets: {
      binding: 'ASSETS', directory: '../client', not_found_handling: 'single-page-application',
      run_worker_first: [
        '/api/*', '/join', '/join/*', '/manage/*', '/create', '/event/*',
        '/recover/manage', '/recover/event-entry', '/host/unsubscribe/*', '/host/login',
        '/host/register', '/host/events', '/host/verify', '/privacy', '/terms',
      ],
    },
    version_metadata: { binding: 'CF_VERSION_METADATA' },
    d1_databases: [{
      binding: 'DB', database_name: 'candidary-core',
      database_id: '60bec5de-c8c7-41b5-a26b-2d3f7d184c71', migrations_dir: '../../migrations',
    }],
    r2_buckets: [{ binding: 'MEDIA_BUCKET', bucket_name: 'candidary-media' }],
    images: { binding: 'IMAGES' }, send_email: [{ name: 'EMAIL' }],
    ratelimits: [
      { name: 'HOST_AUTH_RATE_LIMIT', namespace_id: '1001', simple: { limit: 20, period: 60 } },
      { name: 'RSVP_LOOKUP_RATE_LIMIT', namespace_id: '1002', simple: { limit: 30, period: 60 } },
    ],
    workflows: [
      { name: 'candidary-export', binding: 'EXPORT_WORKFLOW', class_name: 'ExportWorkflow' },
      { name: 'candidary-cover-render', binding: 'COVER_RENDER_WORKFLOW', class_name: 'CoverRenderWorkflow' },
      { name: 'candidary-cover-backfill', binding: 'COVER_BACKFILL_WORKFLOW', class_name: 'CoverBackfillWorkflow' },
    ],
    triggers: { crons: ['17 3 * * *', '47 * * * *'] },
    vars: {
      APP_ORIGIN: 'https://candidary.app', ALTERNATE_ORIGINS: 'https://candidary.online',
      R2_ACCOUNT_ID: ACCOUNT, R2_BUCKET_NAME: 'candidary-media', EMAIL_FROM: 'hello@candidary.app',
    },
    secrets: { required: [
      'TOKEN_HMAC_KEY', 'SESSION_HMAC_KEY', 'GUEST_TOKEN_ENCRYPTION_KEY', 'LOGIN_HMAC_KEY',
      'ENTRY_HMAC_KEY', 'ENTRY_ENCRYPTION_KEY', 'RSVP_LOOKUP_HMAC_KEY',
    ] },
    durable_objects: { bindings: [] }, migrations: [], exports: {}, kv_namespaces: [],
    cloudchamber: {}, queues: { producers: [], consumers: [] }, vectorize: [],
    ai_search_namespaces: [], ai_search: [], agent_memory: [], hyperdrive: [], services: [],
    analytics_engine_datasets: [], dispatch_namespaces: [], mtls_certificates: [],
    pipelines: [], secrets_store_secrets: [], artifacts: [], unsafe_hello_world: [],
    flagship: [], worker_loaders: [], vpc_services: [], vpc_networks: [],
    logfwdr: { bindings: [] }, python_modules: { exclude: ['**/*.pyc'] },
    dev: {
      ip: '127.0.0.1', local_protocol: 'http', upstream_protocol: 'http',
      enable_containers: true, generate_types: false,
    },
    observability: { enabled: true }, placement: { mode: 'smart' }, no_bundle: true,
  };
}

describe('guarded schema-14 bridge deployment', () => {
  it('parses the exact native Wrangler upload receipt and tolerates unrelated untagged versions', () => {
    const session = {
      type: 'wrangler-session', version: 1, wrangler_version: '4.113.0',
      command_line_args: ['versions', 'upload'], log_file_path: 'wrangler.log',
    };
    const upload = {
      type: 'version-upload', version: 1, worker_name: 'candidary', worker_tag: SHA,
      version_id: VERSION_ID, preview_url: null, preview_alias_url: null,
      wrangler_environment: null, worker_name_overridden: false,
    };
    expect(parseBridgeWranglerUploadOutput(
      `${JSON.stringify(session)}\n${JSON.stringify(upload)}\n`,
    )).toEqual({ versionId: VERSION_ID, workerName: 'candidary', tagSha: SHA });
    expect(() => parseBridgeWranglerUploadOutput('{}\n{}\n')).toThrow(/receipt|number|output/iu);
    expect(parseBridgeWranglerVersionList([{
      id: VERSION_ID,
      annotations: { 'workers/tag': '', 'workers/message': '' },
    }])).toEqual([{
      versionId: VERSION_ID, workerName: 'candidary', tagSha: null, uploadMessage: null,
    }]);
  });

  it('keeps the provider script content ETag distinct from the verified local Worker SHA', () => {
    const observation = observeBridgeUploadedVersionFromWrangler({
      accountId: ACCOUNT,
      versionId: VERSION_ID,
      localWorkerSha256: WORKER_SHA,
      observedAt: NOW,
      version: {
        id: VERSION_ID,
        annotations: { 'workers/tag': SHA, 'workers/message': 'exact-message' },
        resources: {
          script: { etag: '8'.repeat(64), handlers: ['scheduled', 'fetch'] },
          script_runtime: {
            compatibility_date: '2026-07-21', compatibility_flags: ['nodejs_compat'],
          },
          bindings: [{ name: 'ASSETS', type: 'assets' }],
        },
      },
      deploymentStatus: { versions: [] },
    });
    expect(observation).toMatchObject({
      trafficPercent: 0,
      providerScriptEtag: '8'.repeat(64),
      localWorkerSha256: WORKER_SHA,
    });
    expect(observation.providerScriptEtag).not.toBe(observation.localWorkerSha256);
  });

  it('uploads one exact zero-traffic version before deploying that ID at 100 percent', () => {
    const message = bridgeVersionUploadMessage({
      runId: RUN_ID,
      manifestSha256: MANIFEST_SHA,
      artifactTreeSha256: ARTIFACT_TREE_SHA,
    });
    const plan = buildBridgeVersionCommandPlan({
      nodeExecPath: process.execPath,
      wranglerCliPath: 'C:/candidate/node_modules/wrangler/bin/wrangler.js',
      deployRoot: 'C:/snapshot',
      accountId: ACCOUNT,
      sha: SHA,
      uploadMessage: message,
      versionId: VERSION_ID,
      outputPath: 'C:/snapshot/wrangler-output.ndjson',
      environment: { PATH: process.env.PATH },
    });
    expect(plan.map((command) => command.id)).toEqual(['upload-version', 'deploy-version']);
    expect(plan[0]!.args).toEqual([
      'C:/candidate/node_modules/wrangler/bin/wrangler.js',
      'versions', 'upload', '--config', 'dist/candidary/wrangler.json',
      '--name', 'candidary', '--tag', SHA, '--message', message, '--strict',
    ]);
    expect(plan[1]!.args).toEqual([
      'C:/candidate/node_modules/wrangler/bin/wrangler.js',
      'versions', 'deploy', `${VERSION_ID}@100%`, '--config', 'dist/candidary/wrangler.json',
      '--name', 'candidary', '--message', message, '--yes',
    ]);
    expect(plan[0]!.env).toMatchObject({
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      WRANGLER_OUTPUT_FILE_PATH: 'C:/snapshot/wrangler-output.ndjson',
    });
  });

  it('does not misclassify an uploaded version hidden inside split traffic as zero traffic', () => {
    const otherVersionId = '1000000a-0000-4000-8000-000000000098';
    expect(bridgeVersionTrafficPercent({ versions: [
      { version_id: otherVersionId, percentage: 99 },
      { version_id: VERSION_ID, percentage: 1 },
    ] }, VERSION_ID)).toBe(1);
    expect(bridgeVersionTrafficPercent({ versions: [
      { version_id: otherVersionId, percentage: 100 },
    ] }, VERSION_ID)).toBe(0);
    expect(() => bridgeVersionTrafficPercent({ versions: [
      { version_id: VERSION_ID, percentage: 1 },
      { version_id: VERSION_ID, percentage: 99 },
    ] }, VERSION_ID)).toThrow(/duplicate|traffic/iu);
  });

  it('targets only the canonical positive-part export artifact with an authenticated GET', () => {
    const eventId = '1000000a-0000-4000-8000-000000000010';
    const jobId = '1000000a-0000-4000-8000-000000000011';
    const artifactUrl = `https://candidary.app/api/manage/events/${eventId}`
      + `/exports/${jobId}/artifacts/parts/1`;
    expect(bridgeExportCanaryRequest(artifactUrl)).toEqual({
      url: artifactUrl,
      method: 'GET',
      accept: 'application/zip',
    });
    for (const invalid of [
      `https://candidary.app/api/manage/events/${eventId}/exports/${jobId}/download`,
      `https://candidary.app/api/manage/events/${eventId}/exports/${jobId}/artifacts/parts/0`,
      `https://candidary.app/api/manage/events/${eventId}/exports/${jobId}/artifacts/parts/01`,
      `${artifactUrl}?download=1`,
    ]) {
      expect(() => bridgeExportCanaryRequest(invalid)).toThrow(/artifact|part|same-origin|route/iu);
    }
  });

  it('preserves the historical manifest base and separately proves current schema-14 main ancestry', () => {
    const source = fixture();
    const run = adapters(source);
    let observedBase = '';
    run.adapter.verifyCandidate = (request) => {
      observedBase = request.approvedBaseSha;
      return source.candidate;
    };
    runBridgeRelease({
      candidateRoot: source.root, sha: SHA, manifestPath: source.manifestPath,
      authorizationPath: source.authorizationPath,
      canonicalBucketEvidencePath: source.canonicalEvidencePath,
    }, run.adapter);
    expect(observedBase).toBe(BASE);
    expect(run.ancestryChecks).toBe(1);
  });

  it('rejects a candidate that is not descended from the exact schema-14 source main', () => {
    const source = fixture();
    const run = adapters(source);
    run.adapter.isAncestor = () => false;
    expect(() => runBridgeRelease({
      candidateRoot: source.root, sha: SHA, manifestPath: source.manifestPath,
      authorizationPath: source.authorizationPath,
      canonicalBucketEvidencePath: source.canonicalEvidencePath,
    }, run.adapter)).toThrow(/ancestor|source main|schema-14/iu);
    expect(run.uploads).toBe(0);
  });

  it('classifies only the exact historical one-bucket bridge topology', () => {
    const source = fixture();
    const config = bridgeProductionConfig();
    put(source.root, 'dist/candidary/wrangler.json', `${canonicalJson(config)}\n`);
    put(source.root, 'dist/candidary/index.js', 'export default {};\n');
    const topology = normalizedBindingTopology(config);
    source.candidate.manifest.bindings = {
      topology,
      sourceTopologySha256: sha256(canonicalJson(topology)),
      firstBuildTopologySha256: sha256(canonicalJson(topology)),
      secondBuildTopologySha256: sha256(canonicalJson(topology)),
      generatedTypesSha256: '9'.repeat(64),
    };
    expect(bridgeProductionIdentity(source.candidate)).toMatchObject({
      accountId: ACCOUNT,
      workerName: 'candidary',
      requiredSecretNames: expect.not.arrayContaining(['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']),
    });

    for (const mutate of [
      (value: Record<string, unknown>) => {
        (value.r2_buckets as Array<Record<string, unknown>>)[0]!.bucket_name =
          CANONICAL_MEDIA_BUCKET_NAME;
      },
      (value: Record<string, unknown>) => { value.kv_namespaces = [{ binding: 'UNCLASSIFIED' }]; },
      (value: Record<string, unknown>) => {
        (value.vars as Record<string, unknown>).R2_BUCKET_NAME = CANONICAL_MEDIA_BUCKET_NAME;
      },
    ]) {
      const changed = structuredClone(config);
      mutate(changed);
      put(source.root, 'dist/candidary/wrangler.json', `${canonicalJson(changed)}\n`);
      expect(() => bridgeProductionIdentity(source.candidate)).toThrow(/topology|canonical/iu);
    }
  });

  it('fails closed when the exact production bundle retains any signer implementation', () => {
    const source = fixture();
    put(source.root, 'dist/candidary/index.js', 'const safe = true;\n');
    expect(scanBridgeSignerSurface(source.candidate)).toEqual({
      xAmzUrlCount: 0,
      r2SignerReferenceCount: 0,
    });
    for (const signerSurface of [
      'X-Amz-Credential', 'X-Amz-Expires', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY',
      'presignUpload', 'presignDownload', 'presignLegacyTestUpload', 'aws4fetch',
    ]) {
      put(source.root, 'dist/candidary/index.js', `const retained = ${JSON.stringify(signerSurface)};\n`);
      expect(scanBridgeSignerSurface(source.candidate)).not.toEqual({
        xAmzUrlCount: 0,
        r2SignerReferenceCount: 0,
      });
    }
  });

  it('deploys only the exact signer-free eight-capability bridge at 100 percent', () => {
    const source = fixture();
    const run = adapters(source);
    const result = runBridgeRelease({
      candidateRoot: source.root,
      sha: SHA,
      manifestPath: source.manifestPath,
      authorizationPath: source.authorizationPath,
      canonicalBucketEvidencePath: source.canonicalEvidencePath,
    }, run.adapter);
    expect(run.deploys).toBe(1);
    expect(run.uploads).toBe(1);
    expect(run.observations).toBe(2);
    expect(result).toMatchObject({ bridgeSha: SHA, versionId: VERSION_ID });
    const evidence = verifyMediaWriteBridgeDeploymentEvidence(source.evidencePath).artifact;
    expect(evidence).toMatchObject({
      runtimeContract: { capabilities: { ...BRIDGE_CAPABILITIES } },
      upload: {
        versionId: VERSION_ID,
        tagSha: SHA,
        trafficPercent: 0,
        localWorkerSha256: WORKER_SHA,
        providerScriptEtag: '8'.repeat(64),
        bindingsSha256: REMOTE_BINDINGS_SHA,
        runtimeSha256: REMOTE_RUNTIME_SHA,
      },
      deployment: {
        versionId: VERSION_ID, tagSha: SHA, trafficPercent: 100, disposition: 'deployed',
      },
      canonicalBucketProvisioningEvidenceSha256:
        source.authorization.canonicalBucketProvisioningEvidenceSha256,
      signerFree: {
        artifactScan: { xAmzUrlCount: 0, r2SignerReferenceCount: 0 },
        exportDownloadCanary: {
          status: 'passed', expectedArtifactSha256: '4'.repeat(64),
          responseSha256: '4'.repeat(64), sameOrigin: true, redirected: false,
        },
      },
    });
  });

  it('rechecks authorization after prerequisites immediately before the first provider mutation', () => {
    const source = fixture();
    const run = adapters(source);
    const instants = [NOW, source.authorization.expiresAt];
    run.adapter.now = () => instants.shift() ?? source.authorization.expiresAt;

    expect(() => runBridgeRelease({
      candidateRoot: source.root,
      sha: SHA,
      manifestPath: source.manifestPath,
      authorizationPath: source.authorizationPath,
      canonicalBucketEvidencePath: source.canonicalEvidencePath,
    }, run.adapter)).toThrow(/authorization|expired|upload|time window/iu);

    expect(run.uploads).toBe(0);
    expect(run.deploys).toBe(0);
    expect(() => readFileSync(source.evidencePath)).toThrow();
  });

  it('rechecks authorization immediately before deploying the exact uploaded version', () => {
    const source = fixture();
    const run = adapters(source);
    const instants = [NOW, NOW, source.authorization.expiresAt];
    run.adapter.now = () => instants.shift() ?? source.authorization.expiresAt;

    expect(() => runBridgeRelease({
      candidateRoot: source.root,
      sha: SHA,
      manifestPath: source.manifestPath,
      authorizationPath: source.authorizationPath,
      canonicalBucketEvidencePath: source.canonicalEvidencePath,
    }, run.adapter)).toThrow(/authorization|expired|deploy|time window/iu);

    expect(run.uploads).toBe(1);
    expect(run.deploys).toBe(0);
    expect(() => readFileSync(source.evidencePath)).toThrow();
  });

  it('withholds expired evidence after exact deploy and recovers under refreshed authorization', () => {
    const source = fixture();
    const run = adapters(source);
    let instants = [NOW, NOW, NOW, source.authorization.expiresAt];
    run.adapter.now = () => instants.shift() ?? source.authorization.expiresAt;

    expect(() => runBridgeRelease({
      candidateRoot: source.root,
      sha: SHA,
      manifestPath: source.manifestPath,
      authorizationPath: source.authorizationPath,
      canonicalBucketEvidencePath: source.canonicalEvidencePath,
    }, run.adapter)).toThrow(/authorization|expired|evidence|time window/iu);

    expect(run.uploads).toBe(1);
    expect(run.deploys).toBe(1);
    expect(run.trafficPercent).toBe(100);
    expect(() => readFileSync(source.evidencePath)).toThrow();

    source.authorization.authorizedAt = '2026-08-13T13:01:00.000Z';
    source.authorization.expiresAt = '2026-08-13T14:00:00.000Z';
    writeCanonicalInput(source.authorizationPath, source.authorization);
    instants = ['2026-08-13T13:02:00.000Z', '2026-08-13T13:03:00.000Z'];

    const result = runBridgeRelease({
      candidateRoot: source.root,
      sha: SHA,
      manifestPath: source.manifestPath,
      authorizationPath: source.authorizationPath,
      canonicalBucketEvidencePath: source.canonicalEvidencePath,
    }, run.adapter);

    expect(result.versionId).toBe(VERSION_ID);
    expect(run.uploads).toBe(1);
    expect(run.deploys).toBe(1);
    expect(verifyMediaWriteBridgeDeploymentEvidence(source.evidencePath).artifact)
      .toMatchObject({
        authorizationSha256: sha256(readFileSync(source.authorizationPath)),
        deployment: { disposition: 'adopted' },
        observedAt: '2026-08-13T13:03:00.000Z',
      });
  });

  it('rechecks the sealed runtime contract after the mutable source config is removed', () => {
    const source = fixture();
    const run = adapters(source);
    const withVerifiedSnapshot = run.adapter.withVerifiedSnapshot;
    run.adapter.withVerifiedSnapshot = (request, action) =>
      withVerifiedSnapshot(request, (candidate, deployRoot) => {
        rmSync(source.runtimePath);
        return action(candidate, deployRoot);
      });

    const result = runBridgeRelease({
      candidateRoot: source.root,
      sha: SHA,
      manifestPath: source.manifestPath,
      authorizationPath: source.authorizationPath,
      canonicalBucketEvidencePath: source.canonicalEvidencePath,
    }, run.adapter);

    expect(result.versionId).toBe(VERSION_ID);
    expect(verifyMediaWriteBridgeDeploymentEvidence(source.evidencePath).artifact)
      .toMatchObject({
        runtimeContract: {
          ...source.runtime,
          sha256: source.authorization.runtimeContractSha256,
        },
      });
  });

  it('fails before deployment on config, bucket, signer, secret, or authorization drift', () => {
    const cases: Array<(source: ReturnType<typeof fixture>, run: ReturnType<typeof adapters>) => void> = [
      (source) => {
        source.runtime.capabilities.authenticatedWorkerIngress = true as false;
        put(source.root, 'config/media-upload-release.json', `${canonicalJson(source.runtime)}\n`);
        source.authorization.runtimeContractSha256 = sha256(
          readFileSync(resolve(source.root, 'config/media-upload-release.json')),
        );
        writeCanonicalInput(source.authorizationPath, source.authorization);
      },
      (source) => {
        source.authorization.canonicalBucketProvisioningEvidenceSha256 = '0'.repeat(64);
        writeCanonicalInput(source.authorizationPath, source.authorization);
      },
      (_source, run) => { run.adapter.productionIdentity = () => ({
        accountId: ACCOUNT, workerName: 'candidary', topologySha256: TOPOLOGY_SHA,
        workerSha256: WORKER_SHA,
        allowedRemoteBindingsSha256: [REMOTE_BINDINGS_SHA, '7'.repeat(64)],
        remoteRuntimeSha256: REMOTE_RUNTIME_SHA,
        requiredSecretNames: [42 as unknown as string],
      }); },
      (_source, run) => { run.adapter.scanSignerSurface = () => ({
        xAmzUrlCount: 1, r2SignerReferenceCount: 0,
      }); },
    ];
    for (const mutate of cases) {
      const source = fixture();
      const run = adapters(source);
      mutate(source, run);
      expect(() => runBridgeRelease({
        candidateRoot: source.root, sha: SHA, manifestPath: source.manifestPath,
        authorizationPath: source.authorizationPath,
        canonicalBucketEvidencePath: source.canonicalEvidencePath,
      }, run.adapter)).toThrow(/bridge|capabilit|bucket|signer|secret|export|runtime/iu);
      expect(run.uploads).toBe(0);
      expect(run.deploys).toBe(0);
      expect(run.observations).toBe(0);
    }
  });

  it('deploys but withholds evidence when the authenticated export canary is not exact', () => {
    const mutations = [
      (value: ReturnType<BridgeReleaseAdapters['observeExportDownloadCanary']>) => ({
        ...value, responseSha256: '5'.repeat(64),
      }),
      (value: ReturnType<BridgeReleaseAdapters['observeExportDownloadCanary']>) => ({
        ...value, sameOrigin: false as true,
      }),
    ];
    for (const mutate of mutations) {
      const source = fixture();
      const run = adapters(source);
      const valid = run.adapter.observeExportDownloadCanary;
      run.adapter.observeExportDownloadCanary = (candidate, deployment) =>
        mutate(valid(candidate, deployment));
      expect(() => runBridgeRelease({
        candidateRoot: source.root, sha: SHA, manifestPath: source.manifestPath,
        authorizationPath: source.authorizationPath,
        canonicalBucketEvidencePath: source.canonicalEvidencePath,
      }, run.adapter)).toThrow(/canary|exact|same-origin|export/iu);
      expect(run.deploys).toBe(1);
      expect(() => readFileSync(source.evidencePath)).toThrow();
    }
  });

  it('withholds evidence unless exact tagged version owns all traffic', () => {
    for (const observation of [
      { versionId: VERSION_ID, tagSha: 'c'.repeat(40), trafficPercent: 100 },
      { versionId: VERSION_ID, tagSha: SHA, trafficPercent: 99 },
    ]) {
      const source = fixture();
      const run = adapters(source);
      run.adapter.observeDeployment = () => observation;
      expect(() => runBridgeRelease({
        candidateRoot: source.root, sha: SHA, manifestPath: source.manifestPath,
        authorizationPath: source.authorizationPath,
        canonicalBucketEvidencePath: source.canonicalEvidencePath,
      }, run.adapter)).toThrow(/traffic|tag|deployment/iu);
      expect(run.deploys).toBe(1);
      expect(() => readFileSync(source.evidencePath)).toThrow();
    }
  });

  it('adopts one exact zero-traffic version after an ambiguous upload response', () => {
    const source = fixture();
    const run = adapters(source);
    run.adapter.uploadVersion = () => {
      run.uploads += 1;
      run.uploaded = true;
      throw new Error('connection closed after request');
    };

    const result = runBridgeRelease({
      candidateRoot: source.root, sha: SHA, manifestPath: source.manifestPath,
      authorizationPath: source.authorizationPath,
      canonicalBucketEvidencePath: source.canonicalEvidencePath,
    }, run.adapter);

    expect(result.versionId).toBe(VERSION_ID);
    expect(run.uploads).toBe(1);
    expect(run.deploys).toBe(1);
  });

  it('recovers exact evidence when a prior run committed 100 percent before losing its canary response', () => {
    const source = fixture();
    const run = adapters(source);
    const validCanary = run.adapter.observeExportDownloadCanary;
    run.adapter.observeExportDownloadCanary = () => {
      throw new Error('connection closed after exact version reached 100 percent');
    };
    expect(() => runBridgeRelease({
      candidateRoot: source.root, sha: SHA, manifestPath: source.manifestPath,
      authorizationPath: source.authorizationPath,
      canonicalBucketEvidencePath: source.canonicalEvidencePath,
    }, run.adapter)).toThrow(/connection closed/iu);
    expect(run.deploys).toBe(1);
    expect(run.trafficPercent).toBe(100);
    expect(() => readFileSync(source.evidencePath)).toThrow();

    run.adapter.observeExportDownloadCanary = validCanary;
    const result = runBridgeRelease({
      candidateRoot: source.root, sha: SHA, manifestPath: source.manifestPath,
      authorizationPath: source.authorizationPath,
      canonicalBucketEvidencePath: source.canonicalEvidencePath,
    }, run.adapter);

    expect(result.versionId).toBe(VERSION_ID);
    expect(run.uploads).toBe(1);
    expect(run.deploys).toBe(1);
    expect(verifyMediaWriteBridgeDeploymentEvidence(source.evidencePath).artifact)
      .toMatchObject({
        upload: { trafficPercent: 100 },
        deployment: { disposition: 'adopted' },
      });
  });

  it('fails closed before deployment on ambiguous version identity, account, topology, or traffic', () => {
    const cases: Array<(run: ReturnType<typeof adapters>) => void> = [
      (run) => {
        run.uploaded = true;
        const valid = run.adapter.listVersions;
        run.adapter.listVersions = (...args) => {
          const versions = valid(...args) as unknown[];
          return [...versions, ...versions];
        };
      },
      (run) => { run.adapter.observeWranglerAccount = () => ({ accountIds: ['0'.repeat(32)] }); },
      (run) => {
        const valid = run.adapter.observeUploadedVersion;
        run.adapter.observeUploadedVersion = (...args) => ({
          ...valid(...args) as Record<string, unknown>, bindingsSha256: '0'.repeat(64),
        });
      },
      (run) => {
        const valid = run.adapter.observeUploadedVersion;
        run.adapter.observeUploadedVersion = (...args) => ({
          ...valid(...args) as Record<string, unknown>, trafficPercent: 1,
        });
      },
    ];
    for (const mutate of cases) {
      const source = fixture();
      const run = adapters(source);
      mutate(run);
      expect(() => runBridgeRelease({
        candidateRoot: source.root, sha: SHA, manifestPath: source.manifestPath,
        authorizationPath: source.authorizationPath,
        canonicalBucketEvidencePath: source.canonicalEvidencePath,
      }, run.adapter)).toThrow(/account|binding|remote|topology|traffic|version|unique/iu);
      expect(run.deploys).toBe(0);
      expect(() => readFileSync(source.evidencePath)).toThrow();
    }
  });
});

describe('bridge CLI', () => {
  it('requires explicit candidate, manifest, authorization, and canonical bucket evidence', () => {
    const source = fixture();
    expect(parseBridgeReleaseArgs([
      '--candidate-root', source.root, '--sha', SHA, '--manifest', source.manifestPath,
      '--authorization', source.authorizationPath,
      '--canonical-bucket-evidence', source.canonicalEvidencePath,
    ], source.root)).toMatchObject({ candidateRoot: source.root, sha: SHA });
    expect(() => parseBridgeReleaseArgs(['--sha', SHA], source.root)).toThrow(/required|missing/iu);
  });

  it('reaches bridge argument validation under native Node ESM resolution', () => {
    const result = spawnSync(process.execPath, [
      '--experimental-strip-types', resolve(process.cwd(), 'scripts/bridge-release.ts'), '--help',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
      shell: false,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(output).toContain('Unknown or duplicate bridge release argument --help.');
    expect(output).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find module/iu);
  });
});

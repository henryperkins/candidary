export * from './task11-staging-release.ts';

import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  constants as fsConstants,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertRedactedCandidateManifest,
  canonicalJson,
  deployWranglerConfigBytes,
  sha256,
  type CandidateManifest,
  type HashedFile,
} from './release-evidence.ts';
import {
  PHASE_2_MIGRATION,
  PHASE_3_MIGRATION,
  POST_CUTOVER_MIGRATION,
  buildAtomicMigrationBundle,
  buildPhase2BootstrapBundle,
  buildPostCutoverMigrationBundle,
  verifyExactReleaseCandidate,
  type ReleaseCandidateVerificationRequest,
  type VerifiedReleaseCandidate,
} from './release-candidate.ts';
import {
  POST_CUTOVER_PRODUCTION_TRIGGER_NAMES,
  PRODUCTION_TRIGGER_NAMES,
  type ZeroLegacyObservation,
} from './migrate-release.ts';
import {
  MEDIA_CUTOVER_READINESS_QUERY,
  assertStagingConformanceArtifact,
  verifyStagingConformanceArtifactFile,
  writeStagingConformanceArtifact,
  type AnyStagingArtifactBindings,
  type StagingConformanceArtifact,
} from './staging-release-evidence.ts';

export { MEDIA_CUTOVER_READINESS_QUERY } from './staging-release-evidence.ts';

const APPROVED_BASE_SHA = '0b92387d2e237d568d2514373dcc3044e7960d4b';
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const D1_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ACCOUNT_PATTERN = /^[0-9a-f]{32}$/u;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export const REQUIRED_STAGING_SECRET_NAMES = [
  'ENTRY_ENCRYPTION_KEY',
  'ENTRY_HMAC_KEY',
  'GUEST_TOKEN_ENCRYPTION_KEY',
  'LOGIN_HMAC_KEY',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'RSVP_LOOKUP_HMAC_KEY',
  'SESSION_HMAC_KEY',
  'TOKEN_HMAC_KEY',
] as const;

export const POST_CUTOVER_REQUIRED_STAGING_SECRET_NAMES = [
  ...REQUIRED_STAGING_SECRET_NAMES,
  'GUEST_MESSAGE_HMAC_KEY',
] as const;

export type StagingPurpose = 'workflow-conformance' | 'cutover';
export type StagingRemoteMode = 'initialize' | 'deploy' | 'migrate';
export type StagingMode = StagingRemoteMode | 'finalize' | 'verify';

interface EnabledIdentity {
  binding: string;
  enabled: boolean;
}

export interface StagingTargetDescriptorV1 {
  kind: 'candidary.staging-target';
  schemaVersion: 1 | 2;
  purpose: StagingPurpose;
  accountId: string;
  worker: {
    name: string;
    routes: string[];
    workersDev: boolean;
    previewUrls: boolean;
  };
  d1: {
    binding: 'DB';
    databaseName: string;
    databaseId: string;
  };
  r2: EnabledIdentity & {
    binding: 'MEDIA_BUCKET';
    bucketName: string;
  };
  images: EnabledIdentity & {
    binding: 'IMAGES';
    identity: string;
  };
  assets: EnabledIdentity & {
    binding: 'ASSETS';
    identity: string;
  };
  email: EnabledIdentity & {
    binding: 'EMAIL';
    destinationAddress: string;
  };
  rateLimits: {
    hostAuth: EnabledIdentity & {
      binding: 'HOST_AUTH_RATE_LIMIT';
      namespaceId: string;
      limit: 20;
      period: 60;
    };
    rsvpLookup: EnabledIdentity & {
      binding: 'RSVP_LOOKUP_RATE_LIMIT';
      namespaceId: string;
      limit: 30;
      period: 60;
    };
    guestMessage?: EnabledIdentity & {
      binding: 'GUEST_MESSAGE_RATE_LIMIT';
      namespaceId: string;
      limit: 120;
      period: 60;
    };
  };
  workflows: {
    export: EnabledIdentity & {
      binding: 'EXPORT_WORKFLOW';
      name: string;
      className: 'ExportWorkflow';
    };
    render: EnabledIdentity & {
      binding: 'COVER_RENDER_WORKFLOW';
      name: string;
      className: 'CoverRenderWorkflow';
    };
    backfill: EnabledIdentity & {
      binding: 'COVER_BACKFILL_WORKFLOW';
      name: string;
      className: 'CoverBackfillWorkflow';
    };
  };
  crons: string[];
  vars: {
    APP_ORIGIN: string;
    ALTERNATE_ORIGINS: string;
    R2_ACCOUNT_ID: string;
    R2_BUCKET_NAME: string;
    EMAIL_FROM: string;
  };
  requiredSecretNames: string[];
  observability: { enabled: boolean };
  placement: { mode: 'smart' };
  expiresAt: string;
  cleanupOwner: string;
}

export interface ReviewAuthorizationV1 {
  kind: 'candidary.phase-3-review-authorization';
  schemaVersion: 1;
  approvedMainSha: string;
  phase2Sha: string;
  phase2ManifestSha256: string;
  candidateSha: string;
  candidateManifestSha256: string;
  reviewer: string;
  issuedAt: string;
  expiresAt: string;
}

export interface ReviewAuthorizationV2 {
  kind: 'candidary.post-cutover-review-authorization';
  schemaVersion: 2;
  approvedMainSha: string;
  phase2Sha: string;
  phase2ManifestSha256: string;
  candidateSha: string;
  candidateManifestSha256: string;
  reviewer: string;
  issuedAt: string;
  expiresAt: string;
}

export type ReviewAuthorization = ReviewAuthorizationV1 | ReviewAuthorizationV2;

export interface StagingAuthorizationV1 {
  kind: 'candidary.staging-authorization';
  schemaVersion: 1;
  runId: string;
  reviewAuthorizationSha256: string;
  allowedCandidateShas: string[];
  targetSha256s: {
    workflowConformance: string;
    cutover: string;
  };
  allowedModes: StagingMode[];
  cutoverCrons: string[];
  expectedSchemaSha256s: {
    workflowConformancePhase2: string;
    cutoverPhase2: string;
    cutoverPhase3: string;
  };
  issuedAt: string;
  expiresAt: string;
  cleanupOwner: string;
}

export interface StagingAuthorizationV2 extends Omit<StagingAuthorizationV1, 'schemaVersion' | 'expectedSchemaSha256s'> {
  schemaVersion: 2;
  expectedSchemaSha256s: {
    workflowConformancePhase2: string;
    cutoverPhase2: string;
    cutoverPostCutover: string;
  };
}

export type StagingAuthorization = StagingAuthorizationV1 | StagingAuthorizationV2;

export interface StagingDatabaseObservation {
  empty: boolean;
  applicationObjectCount: number;
  ledger: string[];
  schemaSha256: string;
  integrity: 'ok';
  foreignKeyRows: 0;
  triggerNames: string[];
  zeroCounts: ZeroLegacyObservation;
}

export interface StagingDeploymentObservation {
  versionId: string;
  tagSha: string;
  metadataSha: string;
  trafficPercent: number;
  topologySha256: string;
}

export interface StagingCommand {
  id: StagingRemoteMode;
  executable: string;
  args: string[];
  cwd: string;
  shell: false;
  inputPath: string;
}

export interface StagingObservationContext {
  candidate: VerifiedReleaseCandidate;
  target: StagingTargetDescriptorV1;
  authorization: StagingAuthorization;
  ownedRoot: string;
}

export interface StagingReleaseAdapters {
  now(): string;
  verifyCandidate(request: ReleaseCandidateVerificationRequest): VerifiedReleaseCandidate;
  prepareCandidate(candidate: VerifiedReleaseCandidate): void;
  listSecretNames(context: StagingObservationContext): string[];
  observeDatabase(context: StagingObservationContext): StagingDatabaseObservation;
  observeDeployment(context: StagingObservationContext): StagingDeploymentObservation;
  hashFile(path: string): string;
  run(command: StagingCommand): number;
}

export interface StagingRemoteRequest {
  mode: StagingRemoteMode;
  candidateRoot: string;
  sha: string;
  manifestPath: string;
  targetPath: string;
  reviewAuthorizationPath: string;
  authorizationPath: string;
  runId: string;
  through?: typeof PHASE_2_MIGRATION;
}

export interface StagingRemoteResult {
  mode: StagingRemoteMode;
  candidateSha: string;
  purpose: StagingPurpose;
  targetSha256: string;
  ledger?: string[];
  bundleSha256?: string;
  versionId?: string;
  trafficPercent?: number;
}

export interface OwnedStagingDeployRoot {
  root: string;
  configPath: string;
  sourceDigest: string;
  configSha256: string;
  targetSha256: string;
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has an unknown or missing field.`);
  }
  return value as Record<string, unknown>;
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function textValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new Error(`${label} must be a nonempty string.`);
  }
  return value;
}

function patternValue(value: unknown, pattern: RegExp, label: string): string {
  const result = textValue(value, label);
  if (!pattern.test(result)) throw new Error(`${label} has an invalid format.`);
  return result;
}

function isoInstant(value: unknown, label: string): string {
  const result = patternValue(value, ISO_PATTERN, label);
  if (new Date(result).toISOString() !== result) throw new Error(`${label} is not a canonical UTC instant.`);
  return result;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean.`);
  return value;
}

function exactStrings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} must be a string array.`);
  }
  return [...value];
}

function exactNumber(value: unknown, expected: number, label: string): number {
  if (value !== expected) throw new Error(`${label} must be ${expected}.`);
  return expected;
}

function owner(value: unknown, label: string): string {
  return patternValue(value, /^[a-z][a-z0-9._-]{2,63}$/u, label);
}

function exactKeysObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  return exactRecord(value, keys, label);
}

function binding(
  value: unknown,
  expectedBinding: string,
  extraKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  const result = exactKeysObject(value, ['binding', 'enabled', ...extraKeys], label);
  if (result.binding !== expectedBinding) throw new Error(`${label} binding is invalid.`);
  booleanValue(result.enabled, `${label}.enabled`);
  return result;
}

const PRODUCTION_IDENTITIES = new Set([
  'candidary',
  'candidary-core',
  'candidary-media',
  'candidary-export',
  'candidary-cover-render',
  'candidary-cover-backfill',
  '1001',
  '1002',
  '1003',
  'hello@candidary.app',
  'https://candidary.app',
  'https://candidary.online',
]);

function stagingIdentity(value: unknown, label: string): string {
  const result = textValue(value, label);
  if (PRODUCTION_IDENTITIES.has(result)) throw new Error(`${label} reuses a production identity.`);
  if (/(?:token|password|secret)\s*[:=]/iu.test(result)
    || /-----BEGIN [A-Z ]+PRIVATE KEY-----/u.test(result)) {
    throw new Error(`${label} contains a secret-shaped value.`);
  }
  return result;
}

function parseRate<
  Binding extends 'HOST_AUTH_RATE_LIMIT' | 'RSVP_LOOKUP_RATE_LIMIT' | 'GUEST_MESSAGE_RATE_LIMIT',
  Limit extends 20 | 30 | 120,
>(
  value: unknown,
  bindingName: Binding,
  expectedLimit: Limit,
  label: string,
): EnabledIdentity & {
  binding: Binding;
  namespaceId: string;
  limit: Limit;
  period: 60;
} {
  const item = binding(value, bindingName, ['namespaceId', 'limit', 'period'], label);
  const namespaceId = stagingIdentity(item.namespaceId, `${label}.namespaceId`);
  exactNumber(item.limit, expectedLimit, `${label}.limit`);
  exactNumber(item.period, 60, `${label}.period`);
  return {
    binding: bindingName,
    enabled: item.enabled as boolean,
    namespaceId,
    limit: expectedLimit,
    period: 60,
  };
}

function parseWorkflow(
  value: unknown,
  expectedBinding: string,
  expectedClass: string,
  label: string,
): EnabledIdentity & { binding: string; name: string; className: string } {
  const item = binding(value, expectedBinding, ['name', 'className'], label);
  if (item.className !== expectedClass) throw new Error(`${label} class is invalid.`);
  return {
    binding: expectedBinding,
    enabled: item.enabled as boolean,
    name: stagingIdentity(item.name, `${label}.name`),
    className: expectedClass,
  };
}

export function parseStagingTargetDescriptor(
  value: unknown,
  now = new Date().toISOString(),
): StagingTargetDescriptorV1 {
  const item = exactRecord(value, [
    'kind', 'schemaVersion', 'purpose', 'accountId', 'worker', 'd1', 'r2', 'images',
    'assets', 'email', 'rateLimits', 'workflows', 'crons', 'vars', 'requiredSecretNames',
    'observability', 'placement', 'expiresAt', 'cleanupOwner',
  ], 'Staging target descriptor');
  if (item.kind !== 'candidary.staging-target'
    || (item.schemaVersion !== 1 && item.schemaVersion !== 2)
    || (item.purpose !== 'workflow-conformance' && item.purpose !== 'cutover')) {
    throw new Error('Staging target identity or purpose is invalid.');
  }
  const purpose = item.purpose;
  const worker = exactRecord(item.worker, ['name', 'routes', 'workersDev', 'previewUrls'], 'Staging Worker');
  const d1 = exactRecord(item.d1, ['binding', 'databaseName', 'databaseId'], 'Staging D1');
  const r2 = binding(item.r2, 'MEDIA_BUCKET', ['bucketName'], 'Staging R2');
  const images = binding(item.images, 'IMAGES', ['identity'], 'Staging Images');
  const assets = binding(item.assets, 'ASSETS', ['identity'], 'Staging assets');
  const email = binding(item.email, 'EMAIL', ['destinationAddress'], 'Staging Email');
  const rateLimits = exactRecord(
    item.rateLimits,
    item.schemaVersion === 2 ? ['hostAuth', 'rsvpLookup', 'guestMessage'] : ['hostAuth', 'rsvpLookup'],
    'Staging rate limits',
  );
  const workflows = exactRecord(item.workflows, ['export', 'render', 'backfill'], 'Staging Workflows');
  const variables = exactRecord(item.vars, [
    'APP_ORIGIN', 'ALTERNATE_ORIGINS', 'R2_ACCOUNT_ID', 'R2_BUCKET_NAME', 'EMAIL_FROM',
  ], 'Staging variables');
  const observability = exactRecord(item.observability, ['enabled'], 'Staging observability');
  const placement = exactRecord(item.placement, ['mode'], 'Staging placement');
  const routes = exactStrings(worker.routes, 'Staging routes');
  const crons = exactStrings(item.crons, 'Staging crons');
  const workersDev = booleanValue(worker.workersDev, 'Staging workersDev');
  const previewUrls = booleanValue(worker.previewUrls, 'Staging previewUrls');
  const requiredSecretNames = exactStrings(item.requiredSecretNames, 'Staging required secret names').sort();
  const expectedSecrets = item.schemaVersion === 2
    ? POST_CUTOVER_REQUIRED_STAGING_SECRET_NAMES
    : REQUIRED_STAGING_SECRET_NAMES;
  if (canonicalJson(requiredSecretNames) !== canonicalJson([...expectedSecrets].sort())) {
    throw new Error('Staging required secret-name set is incomplete or foreign.');
  }
  if (d1.binding !== 'DB') throw new Error('Staging D1 binding is invalid.');
  if (placement.mode !== 'smart') throw new Error('Staging placement must remain smart.');
  const expiresAt = isoInstant(item.expiresAt, 'Staging target expiresAt');
  if (expiresAt <= now) throw new Error('Staging target is expired.');

  const parsed: StagingTargetDescriptorV1 = {
    kind: 'candidary.staging-target', schemaVersion: item.schemaVersion, purpose,
    accountId: patternValue(item.accountId, ACCOUNT_PATTERN, 'Staging accountId'),
    worker: {
      name: stagingIdentity(worker.name, 'Staging Worker name'), routes,
      workersDev, previewUrls,
    },
    d1: {
      binding: 'DB',
      databaseName: stagingIdentity(d1.databaseName, 'Staging database name'),
      databaseId: patternValue(d1.databaseId, D1_ID_PATTERN, 'Staging database ID'),
    },
    r2: {
      binding: 'MEDIA_BUCKET', enabled: r2.enabled as boolean,
      bucketName: stagingIdentity(r2.bucketName, 'Staging bucket name'),
    },
    images: {
      binding: 'IMAGES', enabled: images.enabled as boolean,
      identity: stagingIdentity(images.identity, 'Staging Images identity'),
    },
    assets: {
      binding: 'ASSETS', enabled: assets.enabled as boolean,
      identity: stagingIdentity(assets.identity, 'Staging assets identity'),
    },
    email: {
      binding: 'EMAIL', enabled: email.enabled as boolean,
      destinationAddress: stagingIdentity(email.destinationAddress, 'Staging Email destination'),
    },
    rateLimits: {
      hostAuth: parseRate(rateLimits.hostAuth, 'HOST_AUTH_RATE_LIMIT', 20, 'hostAuth rate limit'),
      rsvpLookup: parseRate(rateLimits.rsvpLookup, 'RSVP_LOOKUP_RATE_LIMIT', 30, 'RSVP rate limit'),
      ...(item.schemaVersion === 2 ? {
        guestMessage: parseRate(
          rateLimits.guestMessage,
          'GUEST_MESSAGE_RATE_LIMIT',
          120,
          'Guestbook message rate limit',
        ),
      } : {}),
    },
    workflows: {
      export: parseWorkflow(workflows.export, 'EXPORT_WORKFLOW', 'ExportWorkflow', 'export Workflow') as StagingTargetDescriptorV1['workflows']['export'],
      render: parseWorkflow(workflows.render, 'COVER_RENDER_WORKFLOW', 'CoverRenderWorkflow', 'render Workflow') as StagingTargetDescriptorV1['workflows']['render'],
      backfill: parseWorkflow(workflows.backfill, 'COVER_BACKFILL_WORKFLOW', 'CoverBackfillWorkflow', 'backfill Workflow') as StagingTargetDescriptorV1['workflows']['backfill'],
    },
    crons,
    vars: {
      APP_ORIGIN: stagingIdentity(variables.APP_ORIGIN, 'Staging APP_ORIGIN'),
      ALTERNATE_ORIGINS: variables.ALTERNATE_ORIGINS === ''
        ? ''
        : stagingIdentity(variables.ALTERNATE_ORIGINS, 'Staging ALTERNATE_ORIGINS'),
      R2_ACCOUNT_ID: patternValue(variables.R2_ACCOUNT_ID, ACCOUNT_PATTERN, 'Staging R2_ACCOUNT_ID'),
      R2_BUCKET_NAME: stagingIdentity(variables.R2_BUCKET_NAME, 'Staging R2_BUCKET_NAME'),
      EMAIL_FROM: stagingIdentity(variables.EMAIL_FROM, 'Staging EMAIL_FROM'),
    },
    requiredSecretNames,
    observability: { enabled: booleanValue(observability.enabled, 'observability.enabled') },
    placement: { mode: 'smart' }, expiresAt,
    cleanupOwner: owner(item.cleanupOwner, 'Staging cleanupOwner'),
  };
  if (parsed.vars.R2_ACCOUNT_ID !== parsed.accountId
    || parsed.vars.R2_BUCKET_NAME !== parsed.r2.bucketName) {
    throw new Error('Staging vars do not bind the descriptor account and R2 identity.');
  }
  if (purpose === 'workflow-conformance') {
    if (routes.length !== 0 || workersDev || previewUrls) {
      throw new Error('Workflow-conformance target cannot expose routes, workers.dev, or preview URLs.');
    }
    if (crons.length !== 0) throw new Error('Workflow-conformance target cannot enable cron triggers.');
    if (parsed.assets.enabled || parsed.email.enabled
      || parsed.rateLimits.hostAuth.enabled || parsed.rateLimits.rsvpLookup.enabled
      || parsed.rateLimits.guestMessage?.enabled) {
      throw new Error('Workflow-conformance public assets, Email, and rate limits must be explicitly disabled.');
    }
  }
  if (!parsed.d1.databaseName || !parsed.r2.enabled || !parsed.images.enabled
    || !parsed.workflows.export.enabled || !parsed.workflows.render.enabled
    || !parsed.workflows.backfill.enabled) {
    throw new Error('Staging D1, R2, Images, and all Workflow identities must be isolated and enabled.');
  }
  return parsed;
}

export function stagingTargetSha256(value: StagingTargetDescriptorV1): string {
  return sha256(`${canonicalJson(parseStagingTargetDescriptor(value, '1970-01-01T00:00:00.000Z'))}\n`);
}

function parseReviewAuthorization(value: unknown, now: string): ReviewAuthorization {
  const item = exactRecord(value, [
    'kind', 'schemaVersion', 'approvedMainSha', 'phase2Sha', 'phase2ManifestSha256',
    'candidateSha', 'candidateManifestSha256', 'reviewer', 'issuedAt', 'expiresAt',
  ], 'Review authorization');
  const historical = item.kind === 'candidary.phase-3-review-authorization' && item.schemaVersion === 1;
  const postCutover = item.kind === 'candidary.post-cutover-review-authorization' && item.schemaVersion === 2;
  if (!historical && !postCutover) {
    throw new Error('Review authorization identity is invalid.');
  }
  const issuedAt = isoInstant(item.issuedAt, 'Review authorization issuedAt');
  const expiresAt = isoInstant(item.expiresAt, 'Review authorization expiresAt');
  if (issuedAt > now || now >= expiresAt) throw new Error('Review authorization is not currently valid.');
  return {
    kind: historical
      ? 'candidary.phase-3-review-authorization'
      : 'candidary.post-cutover-review-authorization',
    schemaVersion: historical ? 1 : 2,
    approvedMainSha: patternValue(item.approvedMainSha, SHA_PATTERN, 'approvedMainSha'),
    phase2Sha: patternValue(item.phase2Sha, SHA_PATTERN, 'phase2Sha'),
    phase2ManifestSha256: patternValue(item.phase2ManifestSha256, SHA256_PATTERN, 'phase2ManifestSha256'),
    candidateSha: patternValue(item.candidateSha, SHA_PATTERN, 'candidateSha'),
    candidateManifestSha256: patternValue(item.candidateManifestSha256, SHA256_PATTERN, 'candidateManifestSha256'),
    reviewer: owner(item.reviewer, 'reviewer'), issuedAt, expiresAt,
  } as ReviewAuthorization;
}

function parseStagingAuthorization(value: unknown, now: string): StagingAuthorization {
  const item = exactRecord(value, [
    'kind', 'schemaVersion', 'runId', 'reviewAuthorizationSha256', 'allowedCandidateShas',
    'targetSha256s', 'allowedModes', 'cutoverCrons', 'expectedSchemaSha256s',
    'issuedAt', 'expiresAt', 'cleanupOwner',
  ], 'Staging authorization');
  if (item.kind !== 'candidary.staging-authorization'
    || (item.schemaVersion !== 1 && item.schemaVersion !== 2)) {
    throw new Error('Staging authorization identity is invalid.');
  }
  const targets = exactRecord(item.targetSha256s, ['workflowConformance', 'cutover'], 'Authorized targets');
  const schemas = exactRecord(item.expectedSchemaSha256s, item.schemaVersion === 2
    ? ['workflowConformancePhase2', 'cutoverPhase2', 'cutoverPostCutover']
    : ['workflowConformancePhase2', 'cutoverPhase2', 'cutoverPhase3'], 'Authorized staging schemas');
  const issuedAt = isoInstant(item.issuedAt, 'Staging authorization issuedAt');
  const expiresAt = isoInstant(item.expiresAt, 'Staging authorization expiresAt');
  if (issuedAt > now || now >= expiresAt) throw new Error('Staging authorization is not currently valid.');
  const modes = exactStrings(item.allowedModes, 'allowedModes');
  const allowedModeSet: StagingMode[] = ['initialize', 'deploy', 'migrate', 'finalize', 'verify'];
  if (canonicalJson([...modes].sort()) !== canonicalJson([...allowedModeSet].sort())) {
    throw new Error('Staging authorization modes are incomplete or unknown.');
  }
  return {
    kind: 'candidary.staging-authorization', schemaVersion: item.schemaVersion,
    runId: patternValue(item.runId, UUID_PATTERN, 'Staging runId'),
    reviewAuthorizationSha256: patternValue(item.reviewAuthorizationSha256, SHA256_PATTERN, 'review digest'),
    allowedCandidateShas: exactStrings(item.allowedCandidateShas, 'allowed candidate SHAs')
      .map((sha) => patternValue(sha, SHA_PATTERN, 'allowed candidate SHA')),
    targetSha256s: {
      workflowConformance: patternValue(targets.workflowConformance, SHA256_PATTERN, 'workflow target digest'),
      cutover: patternValue(targets.cutover, SHA256_PATTERN, 'cutover target digest'),
    },
    allowedModes: modes as StagingMode[],
    cutoverCrons: exactStrings(item.cutoverCrons, 'authorized cutover crons'),
    expectedSchemaSha256s: item.schemaVersion === 2 ? {
      workflowConformancePhase2: patternValue(schemas.workflowConformancePhase2, SHA256_PATTERN, 'workflow schema digest'),
      cutoverPhase2: patternValue(schemas.cutoverPhase2, SHA256_PATTERN, 'cutover Phase-2 schema digest'),
      cutoverPostCutover: patternValue(schemas.cutoverPostCutover, SHA256_PATTERN, 'cutover post-cutover schema digest'),
    } : {
      workflowConformancePhase2: patternValue(schemas.workflowConformancePhase2, SHA256_PATTERN, 'workflow schema digest'),
      cutoverPhase2: patternValue(schemas.cutoverPhase2, SHA256_PATTERN, 'cutover Phase-2 schema digest'),
      cutoverPhase3: patternValue(schemas.cutoverPhase3, SHA256_PATTERN, 'cutover Phase-3 schema digest'),
    },
    issuedAt, expiresAt, cleanupOwner: owner(item.cleanupOwner, 'Staging authorization cleanupOwner'),
  } as StagingAuthorization;
}

function exactRegularFile(path: string, label: string): string {
  try {
    const absolute = resolve(path);
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
    return absolute;
  } catch (error) {
    throw new Error(`${label} must be one exact regular nonsymlinked file.`, { cause: error });
  }
}

function within(container: string, target: string): boolean {
  const path = relative(container, target);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

interface CanonicalInput<T> {
  value: T;
  digest: string;
  path: string;
}

function readCanonicalExternal<T>(path: string, label: string): CanonicalInput<T> {
  const inputPath = exactRegularFile(path, label);
  const bytes = readFileSync(inputPath, 'utf8');
  const digest = sha256(bytes);
  const sidecar = readFileSync(exactRegularFile(`${inputPath}.sha256`, `${label} sidecar`), 'utf8');
  if (sidecar !== `${digest}  ${basename(inputPath)}\n`) throw new Error(`${label} sidecar digest does not match.`);
  let value: unknown;
  try {
    value = JSON.parse(bytes) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON.`, { cause: error });
  }
  if (bytes !== `${canonicalJson(value)}\n`) throw new Error(`${label} must use canonical JSON bytes.`);
  return { value: value as T, digest, path: inputPath };
}

function readCanonicalInput<T>(candidateRoot: string, path: string, label: string): CanonicalInput<T> {
  const input = readCanonicalExternal<T>(path, label);
  const approvedRoot = resolve(candidateRoot, 'output/staging-input');
  if (!within(approvedRoot, input.path)) throw new Error(`${label} must remain beneath output/staging-input.`);
  return input;
}

export interface StagingOverlay {
  config: Record<string, unknown>;
  configSha256: string;
  targetSha256: string;
}

const GENERATED_CONFIG_KEYS = new Set([
  'agent_memory', 'ai_search', 'ai_search_namespaces', 'analytics_engine_datasets',
  'artifacts', 'assets', 'cloudchamber', 'compatibility_date', 'compatibility_flags',
  'configPath', 'd1_databases', 'definedEnvironments', 'dev', 'dispatch_namespaces',
  'durable_objects', 'exports', 'flagship', 'hyperdrive', 'images', 'jsx_factory',
  'jsx_fragment', 'kv_namespaces', 'logfwdr', 'main', 'migrations', 'mtls_certificates',
  'name', 'no_bundle', 'observability', 'pipelines', 'placement', 'preview_urls',
  'python_modules', 'queues', 'r2_buckets', 'ratelimits', 'route', 'routes', 'rules',
  'secrets', 'secrets_store_secrets', 'send_email', 'services', 'topLevelName',
  'triggers', 'unsafe_hello_world', 'userConfigPath', 'vars', 'vectorize',
  'version_metadata', 'vpc_networks', 'vpc_services', 'worker_loaders', 'workers_dev',
  'workflows',
]);

const UNCLASSIFIED_BINDING_FIELDS = [
  'agent_memory', 'ai_search', 'ai_search_namespaces', 'analytics_engine_datasets',
  'artifacts', 'cloudchamber', 'dispatch_namespaces', 'durable_objects', 'flagship',
  'hyperdrive', 'kv_namespaces', 'migrations', 'mtls_certificates', 'pipelines',
  'queues', 'secrets_store_secrets', 'services', 'vectorize', 'vpc_networks',
  'vpc_services', 'worker_loaders',
] as const;

function containsConfiguredValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.some(containsConfiguredValue);
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>)
    .some(containsConfiguredValue);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return String(value).length > 0;
}

function assertClosedGeneratedConfig(source: Record<string, unknown>): void {
  const unknown = Object.keys(source).filter((key) => !GENERATED_CONFIG_KEYS.has(key));
  if (unknown.length > 0) {
    throw new Error(`Generated config contains an unclassified field: ${unknown.sort().join(', ')}.`);
  }
  for (const field of UNCLASSIFIED_BINDING_FIELDS) {
    if (containsConfiguredValue(source[field])) {
      throw new Error(`Generated config contains an unclassified ${field} binding surface.`);
    }
  }
}

export function buildStagingOverlay(
  generatedConfigValue: unknown,
  descriptorValue: StagingTargetDescriptorV1,
  authorizedCutoverCrons: readonly string[],
): StagingOverlay {
  const target = parseStagingTargetDescriptor(descriptorValue, '1970-01-01T00:00:00.000Z');
  if (target.purpose === 'cutover'
    && canonicalJson(target.crons) !== canonicalJson(authorizedCutoverCrons)) {
    throw new Error('Cutover cron topology is not explicitly authorized.');
  }
  const generated = plainObject(generatedConfigValue, 'Generated Wrangler config');
  assertClosedGeneratedConfig(generated);
  const generatedVersionMetadata = plainObject(generated.version_metadata, 'Version metadata');
  if (generated.main !== 'index.js' || generatedVersionMetadata.binding !== 'CF_VERSION_METADATA') {
    throw new Error('Generated config has an unexpected Worker entry point or version metadata binding.');
  }
  if (typeof generated.compatibility_date !== 'string'
    || !Array.isArray(generated.compatibility_flags)
    || generated.compatibility_flags.some((flag) => typeof flag !== 'string')) {
    throw new Error('Generated config compatibility settings are invalid.');
  }
  const source: Record<string, unknown> = {
    name: target.worker.name,
    main: 'index.js',
    compatibility_date: generated.compatibility_date,
    compatibility_flags: [...generated.compatibility_flags],
    workers_dev: target.worker.workersDev,
    preview_urls: target.worker.previewUrls,
    version_metadata: { binding: 'CF_VERSION_METADATA' },
    no_bundle: true,
  };
  source.d1_databases = [{
    binding: target.d1.binding,
    database_name: target.d1.databaseName,
    database_id: target.d1.databaseId,
    migrations_dir: '../../migrations',
  }];
  if (target.worker.routes.length > 0) source.routes = [...target.worker.routes];
  if (target.r2.enabled) source.r2_buckets = [{ binding: target.r2.binding, bucket_name: target.r2.bucketName }];
  if (target.images.enabled) source.images = { binding: target.images.binding };
  if (target.assets.enabled) {
    const originalAssets = plainObject((generatedConfigValue as Record<string, unknown>).assets, 'Generated assets');
    source.assets = {
      binding: target.assets.binding,
      directory: '../client',
      not_found_handling: originalAssets.not_found_handling,
      run_worker_first: originalAssets.run_worker_first,
    };
  }
  if (target.email.enabled) {
    source.send_email = [{ name: target.email.binding, destination_address: target.email.destinationAddress }];
  }
  source.ratelimits = [
    target.rateLimits.hostAuth,
    target.rateLimits.rsvpLookup,
    ...(target.rateLimits.guestMessage ? [target.rateLimits.guestMessage] : []),
  ]
    .filter((rate) => rate.enabled)
    .map((rate) => ({
      name: rate.binding,
      namespace_id: rate.namespaceId,
      simple: { limit: rate.limit, period: rate.period },
    }));
  if ((source.ratelimits as unknown[]).length === 0) delete source.ratelimits;
  source.workflows = Object.values(target.workflows)
    .filter((workflow) => workflow.enabled)
    .map((workflow) => ({
      name: workflow.name, binding: workflow.binding, class_name: workflow.className,
    }));
  if (target.crons.length > 0) source.triggers = { crons: [...target.crons] };
  source.vars = structuredClone(target.vars);
  source.secrets = { required: [...target.requiredSecretNames] };
  source.observability = structuredClone(target.observability);
  source.placement = structuredClone(target.placement);
  const bytes = `${canonicalJson(source)}\n`;
  return {
    config: source,
    configSha256: sha256(bytes),
    targetSha256: stagingTargetSha256(target),
  };
}

function copyHashedFile(
  candidateRoot: string,
  destinationRoot: string,
  file: HashedFile,
  deployConfig = false,
): void {
  const source = exactRegularFile(resolve(candidateRoot, file.path), `Source ${file.path}`);
  const sourceBytes = deployConfig
    ? deployWranglerConfigBytes(JSON.parse(readFileSync(source, 'utf8')) as unknown)
    : readFileSync(source);
  if (sourceBytes.byteLength !== file.bytes || sha256(sourceBytes) !== file.sha256) {
    throw new Error(`Source ${file.path} drifted from candidate evidence.`);
  }
  const destination = resolve(destinationRoot, ...file.path.split('/'));
  if (!within(destinationRoot, destination)) throw new Error('Owned staging file escaped its deploy root.');
  mkdirSync(dirname(destination), { recursive: true });
  if (deployConfig) writeFileSync(destination, sourceBytes, { flag: 'wx' });
  else copyFileSync(source, destination, fsConstants.COPYFILE_EXCL);
  if (sha256(readFileSync(destination)) !== file.sha256) {
    throw new Error(`Copied staging file ${file.path} failed rehashing.`);
  }
}

export function createOwnedStagingDeployRoot(
  candidate: VerifiedReleaseCandidate,
  descriptorValue: StagingTargetDescriptorV1,
  runRootInput: string,
  authorizedCutoverCrons: readonly string[],
): OwnedStagingDeployRoot {
  const runRoot = resolve(runRootInput);
  if (!within(candidate.candidateRoot, runRoot)) {
    throw new Error('Owned staging run root must remain inside the candidate checkout.');
  }
  const root = resolve(runRoot, 'deploy-root');
  if (!within(runRoot, root) || existsSync(root)) {
    throw new Error('Owned staging deploy root already exists or escapes its run root.');
  }
  const artifacts = candidate.manifest.artifacts;
  if (!artifacts) throw new Error('Verified candidate is missing deploy artifacts.');
  mkdirSync(runRoot, { recursive: true });
  mkdirSync(root, { recursive: false });
  try {
    copyHashedFile(candidate.candidateRoot, root, artifacts.deployWranglerConfig, true);
    copyHashedFile(candidate.candidateRoot, root, artifacts.worker);
    for (const file of artifacts.client) copyHashedFile(candidate.candidateRoot, root, file);
    for (const file of candidate.migrations) copyHashedFile(candidate.candidateRoot, root, file);
    const configPath = resolve(root, 'dist/candidary/wrangler.json');
    const original = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
    const overlay = buildStagingOverlay(original, descriptorValue, authorizedCutoverCrons);
    writeFileSync(configPath, `${canonicalJson(overlay.config)}\n`, 'utf8');
    if (sha256(readFileSync(configPath)) !== overlay.configSha256) {
      throw new Error('Owned staging config failed its post-write hash check.');
    }
    const sourceDigest = sha256(canonicalJson({
      candidateSha: candidate.sha,
      artifactTreeSha256: candidate.artifactTreeSha256,
      migrations: candidate.migrations,
      configSha256: overlay.configSha256,
      targetSha256: overlay.targetSha256,
    }));
    return {
      root,
      configPath,
      sourceDigest,
      configSha256: overlay.configSha256,
      targetSha256: overlay.targetSha256,
    };
  } catch (error) {
    rmSync(root, { force: true, recursive: true });
    throw error;
  }
}

function removeOwnedRoot(candidateRoot: string, root: string): void {
  const exact = resolve(root);
  if (basename(exact) !== 'deploy-root' || !within(resolve(candidateRoot, 'output/staging'), exact)) {
    throw new Error('Refusing to remove an unexpected staging deploy root.');
  }
  rmSync(exact, { force: true, recursive: true });
}

function zeroCounts(value: unknown): ZeroLegacyObservation {
  const counts = exactRecord(value, [
    'legacyRows', 'blockingJobs', 'incompleteActiveSets', 'uploadsWithoutActiveSet',
  ], 'Staging zero counts');
  for (const [name, count] of Object.entries(counts)) {
    if (count !== 0) throw new Error(`Staging zero count ${name} must be exactly zero.`);
  }
  return value as ZeroLegacyObservation;
}

function databaseObservation(value: unknown): StagingDatabaseObservation {
  const item = exactRecord(value, [
    'empty', 'applicationObjectCount', 'ledger', 'schemaSha256', 'integrity',
    'foreignKeyRows', 'triggerNames', 'zeroCounts',
  ], 'Staging database observation');
  if (typeof item.empty !== 'boolean'
    || !Number.isSafeInteger(item.applicationObjectCount) || (item.applicationObjectCount as number) < 0
    || item.integrity !== 'ok' || item.foreignKeyRows !== 0) {
    throw new Error('Staging database inventory or integrity is invalid.');
  }
  return {
    empty: item.empty,
    applicationObjectCount: item.applicationObjectCount as number,
    ledger: exactStrings(item.ledger, 'Staging ledger'),
    schemaSha256: patternValue(item.schemaSha256, SHA256_PATTERN, 'Staging schema digest'),
    integrity: 'ok', foreignKeyRows: 0,
    triggerNames: exactStrings(item.triggerNames, 'Staging trigger names'),
    zeroCounts: zeroCounts(item.zeroCounts),
  };
}

function deploymentObservation(value: unknown): StagingDeploymentObservation {
  const item = exactRecord(value, [
    'versionId', 'tagSha', 'metadataSha', 'trafficPercent', 'topologySha256',
  ], 'Staging deployment observation');
  if (!Number.isFinite(item.trafficPercent) || (item.trafficPercent as number) < 0
    || (item.trafficPercent as number) > 100) {
    throw new Error('Staging deployment traffic percentage is invalid.');
  }
  return {
    versionId: patternValue(item.versionId, D1_ID_PATTERN, 'Staging versionId'),
    tagSha: patternValue(item.tagSha, SHA_PATTERN, 'Staging version tag'),
    metadataSha: patternValue(item.metadataSha, SHA_PATTERN, 'Staging version metadata'),
    trafficPercent: item.trafficPercent as number,
    topologySha256: patternValue(item.topologySha256, SHA256_PATTERN, 'Staging topology digest'),
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function migrationNames(candidate: VerifiedReleaseCandidate, count = candidate.migrationCount): string[] {
  return candidate.migrations.slice(0, count).map((file) => basename(file.path));
}

function expectedPhase2Schema(
  target: StagingTargetDescriptorV1,
  authorization: StagingAuthorization,
): string {
  return target.purpose === 'workflow-conformance'
    ? authorization.expectedSchemaSha256s.workflowConformancePhase2
    : authorization.expectedSchemaSha256s.cutoverPhase2;
}

function assertPhase2State(
  observation: StagingDatabaseObservation,
  candidate: VerifiedReleaseCandidate,
  target: StagingTargetDescriptorV1,
  authorization: StagingAuthorization,
): void {
  const names = migrationNames(candidate, 13);
  if (names.at(-1) !== PHASE_2_MIGRATION || !sameStrings(observation.ledger, names)) {
    throw new Error('Staging ledger is not exactly at the Phase-2 boundary.');
  }
  if (observation.schemaSha256 !== expectedPhase2Schema(target, authorization)) {
    throw new Error('Staging Phase-2 schema fingerprint does not match authorization.');
  }
}

function assertPhase3State(
  observation: StagingDatabaseObservation,
  candidate: VerifiedReleaseCandidate,
  authorization: StagingAuthorizationV1,
): void {
  if (!sameStrings(observation.ledger, migrationNames(candidate, 14))) {
    throw new Error('Staging Phase-3 ledger is incomplete or out of order.');
  }
  if (observation.schemaSha256 !== authorization.expectedSchemaSha256s.cutoverPhase3) {
    throw new Error('Staging Phase-3 schema fingerprint does not match authorization.');
  }
  if (!sameStrings(observation.triggerNames, [...PRODUCTION_TRIGGER_NAMES])) {
    throw new Error('Staging Phase-3 trigger set is incomplete or unexpected.');
  }
}

function assertPostCutoverState(
  observation: StagingDatabaseObservation,
  candidate: VerifiedReleaseCandidate,
  authorization: StagingAuthorizationV2,
): void {
  if (!sameStrings(observation.ledger, migrationNames(candidate, 15))
    || observation.ledger.at(-1) !== POST_CUTOVER_MIGRATION) {
    throw new Error('Staging post-cutover ledger is incomplete or out of order.');
  }
  if (observation.schemaSha256 !== authorization.expectedSchemaSha256s.cutoverPostCutover) {
    throw new Error('Staging post-cutover schema fingerprint does not match authorization.');
  }
  if (!sameStrings(observation.triggerNames, [...POST_CUTOVER_PRODUCTION_TRIGGER_NAMES])) {
    throw new Error('Staging post-cutover trigger set is incomplete or unexpected.');
  }
}

function sameDatabase(left: StagingDatabaseObservation, right: StagingDatabaseObservation): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function validateCandidateBinding(
  candidate: VerifiedReleaseCandidate,
  review: ReviewAuthorization,
): void {
  if (review.approvedMainSha !== APPROVED_BASE_SHA) {
    throw new Error('Review authorization approved main is not the pinned integration base.');
  }
  if (candidate.migrationCount === 13) {
    if (candidate.sha !== review.phase2Sha || candidate.manifestSha256 !== review.phase2ManifestSha256) {
      throw new Error('Review authorization does not bind the exact Phase-2 proof candidate.');
    }
  } else if ((review.schemaVersion === 1 && candidate.migrationCount === 14)
    || (review.schemaVersion === 2 && candidate.migrationCount === 15)) {
    if (candidate.sha !== review.candidateSha
      || candidate.manifestSha256 !== review.candidateManifestSha256) {
      throw new Error('Review authorization does not bind the exact final candidate.');
    }
  } else {
    throw new Error(review.schemaVersion === 2
      ? 'Post-cutover staging candidate must contain exactly fifteen migrations.'
      : 'Historical staging candidate must contain exactly thirteen or fourteen migrations.');
  }
}

interface ValidatedInputs {
  candidate: VerifiedReleaseCandidate;
  target: StagingTargetDescriptorV1;
  targetSha256: string;
  review: ReviewAuthorization;
  authorization: StagingAuthorization;
  verificationRequest: ReleaseCandidateVerificationRequest;
}

function validateInputs(
  request: StagingRemoteRequest,
  adapters: StagingReleaseAdapters,
): ValidatedInputs {
  if (!UUID_PATTERN.test(request.runId)) throw new Error('Staging run ID is invalid.');
  const now = adapters.now();
  const targetInput = readCanonicalInput<unknown>(request.candidateRoot, request.targetPath, 'Staging target');
  const target = parseStagingTargetDescriptor(targetInput.value, now);
  const reviewInput = readCanonicalInput<unknown>(request.candidateRoot, request.reviewAuthorizationPath, 'Review authorization');
  const review = parseReviewAuthorization(reviewInput.value, now);
  const authorizationInput = readCanonicalInput<unknown>(request.candidateRoot, request.authorizationPath, 'Staging authorization');
  const authorization = parseStagingAuthorization(authorizationInput.value, now);
  if (target.schemaVersion !== review.schemaVersion || target.schemaVersion !== authorization.schemaVersion) {
    throw new Error('Staging target, review, and authorization schema versions must match.');
  }
  const targetSha = stagingTargetSha256(target);
  const authorizedTargetSha = target.purpose === 'workflow-conformance'
    ? authorization.targetSha256s.workflowConformance
    : authorization.targetSha256s.cutover;
  if (authorization.reviewAuthorizationSha256 !== reviewInput.digest
    || authorization.runId !== request.runId
    || !authorization.allowedModes.includes(request.mode)
    || !authorization.allowedCandidateShas.includes(request.sha)
    || authorizedTargetSha !== targetSha
    || targetInput.digest !== targetSha
    || target.cleanupOwner !== authorization.cleanupOwner) {
    throw new Error('Staging authorization does not bind this review, candidate, target, mode, and cleanup owner.');
  }
  const expectedCount = request.sha === review.phase2Sha
    ? 13
    : request.sha === review.candidateSha
      ? (review.schemaVersion === 2 ? 15 : 14)
      : null;
  if (expectedCount === null) throw new Error('Requested staging SHA is not named by review authorization.');
  const verificationRequest: ReleaseCandidateVerificationRequest = {
    candidateRoot: request.candidateRoot,
    sha: request.sha,
    manifestPath: request.manifestPath,
    approvedBaseSha: APPROVED_BASE_SHA,
    expectedMigrationCount: expectedCount,
  };
  const candidate = adapters.verifyCandidate(verificationRequest);
  validateCandidateBinding(candidate, review);
  if (candidate.sha !== request.sha) throw new Error('Verified staging candidate SHA is wrong.');
  return { candidate, target, targetSha256: targetSha, review, authorization, verificationRequest };
}

function reprepareAndVerify(
  inputs: ValidatedInputs,
  adapters: StagingReleaseAdapters,
): VerifiedReleaseCandidate {
  adapters.prepareCandidate(inputs.candidate);
  const rechecked = adapters.verifyCandidate(inputs.verificationRequest);
  if (rechecked.sha !== inputs.candidate.sha || rechecked.tree !== inputs.candidate.tree
    || rechecked.manifestSha256 !== inputs.candidate.manifestSha256
    || rechecked.artifactTreeSha256 !== inputs.candidate.artifactTreeSha256
    || rechecked.migrationCount !== inputs.candidate.migrationCount
    || rechecked.wranglerCliPath !== inputs.candidate.wranglerCliPath) {
    throw new Error('Staging candidate identity or artifacts drifted during preparation.');
  }
  return rechecked;
}

function command(
  id: StagingRemoteMode,
  candidate: VerifiedReleaseCandidate,
  owned: OwnedStagingDeployRoot,
  inputPath: string,
): StagingCommand {
  const args = id === 'deploy'
    ? [
      candidate.wranglerCliPath, 'deploy', '--config', 'dist/candidary/wrangler.json',
      '--strict', '--tag', candidate.sha,
    ]
    : [
      candidate.wranglerCliPath, 'd1', 'execute', 'DB', '--remote',
      '--config', 'dist/candidary/wrangler.json', '--file', inputPath,
    ];
  return { id, executable: process.execPath, args, cwd: owned.root, shell: false, inputPath };
}

function verifySecrets(actual: readonly string[], expected: readonly string[]): void {
  const normalize = (values: readonly string[]) => [...values].sort();
  if (canonicalJson(normalize(actual)) !== canonicalJson(normalize(expected))) {
    throw new Error('Staging Worker secret-name set does not match the target descriptor.');
  }
}

export function runStagingRelease(
  request: StagingRemoteRequest,
  adapters: StagingReleaseAdapters = defaultAdapters,
): StagingRemoteResult {
  const inputs = validateInputs(request, adapters);
  if (request.mode === 'initialize' && request.through !== PHASE_2_MIGRATION) {
    throw new Error(`Staging initialization must stop exactly through ${PHASE_2_MIGRATION}.`);
  }
  if (request.mode !== 'initialize' && request.through !== undefined) {
    throw new Error('--through is valid only for staging initialization.');
  }
  if (request.mode === 'initialize'
    && inputs.candidate.migrationCount !== 13) {
    throw new Error('Staging initialization requires the exact authorized candidate boundary.');
  }
  if (request.mode === 'migrate'
    && (inputs.target.purpose !== 'cutover'
      || inputs.candidate.migrationCount !== (inputs.target.schemaVersion === 2 ? 15 : 14))) {
    throw new Error('Staging migration requires the cutover target and exact authorized final candidate.');
  }
  if (request.mode === 'deploy' && inputs.target.purpose === 'workflow-conformance'
    && inputs.candidate.migrationCount !== (inputs.target.schemaVersion === 2 ? 15 : 14)) {
    throw new Error('Workflow-conformance deployment requires the exact authorized final candidate.');
  }

  const candidate = reprepareAndVerify(inputs, adapters);
  const runRoot = resolve(candidate.candidateRoot, 'output/staging', candidate.sha, request.runId);
  const owned = createOwnedStagingDeployRoot(
    candidate,
    inputs.target,
    runRoot,
    inputs.authorization.cutoverCrons,
  );
  const context: StagingObservationContext = {
    candidate, target: inputs.target, authorization: inputs.authorization, ownedRoot: owned.root,
  };
  try {
    if (request.mode === 'initialize') {
      const before = databaseObservation(adapters.observeDatabase(context));
      if (!before.empty || before.applicationObjectCount !== 0 || before.ledger.length !== 0) {
        throw new Error('Staging initialization requires a provably empty D1 with no ledger or application object.');
      }
      const ownedCandidate = { ...candidate, candidateRoot: owned.root };
      const bundle = buildPhase2BootstrapBundle({
        verifiedPhase2Candidate: ownedCandidate,
        through: PHASE_2_MIGRATION,
        outputPath: resolve(owned.root, 'phase2-bootstrap.sql'),
      });
      if (adapters.hashFile(bundle.outputPath) !== bundle.sha256) {
        throw new Error('Staging bootstrap bundle drifted before invocation.');
      }
      const exitCode = adapters.run(command('initialize', candidate, owned, bundle.outputPath));
      if (exitCode !== 0) {
        const failed = databaseObservation(adapters.observeDatabase(context));
        if (!sameDatabase(failed, before)) throw new Error('Failed staging bootstrap left residual state.');
        throw new Error('Atomic staging bootstrap failed; empty-state rollback was verified.');
      }
      const after = databaseObservation(adapters.observeDatabase(context));
      assertPhase2State(after, candidate, inputs.target, inputs.authorization);
      return {
        mode: 'initialize', candidateSha: candidate.sha, purpose: inputs.target.purpose,
        targetSha256: inputs.targetSha256, ledger: after.ledger, bundleSha256: bundle.sha256,
      };
    }

    if (request.mode === 'migrate') {
      const before = databaseObservation(adapters.observeDatabase(context));
      assertPhase2State(before, candidate, inputs.target, inputs.authorization);
      const ownedCandidate = { ...candidate, candidateRoot: owned.root };
      const bundle = inputs.target.schemaVersion === 2
        ? buildPostCutoverMigrationBundle({
          verifiedCandidate: ownedCandidate,
          expectedLedger: before.ledger,
          outputPath: resolve(owned.root, 'post-cutover-migrations.sql'),
        })
        : buildAtomicMigrationBundle({
          verifiedCandidate: ownedCandidate,
          expectedLedger: before.ledger,
          migration: PHASE_3_MIGRATION,
          outputPath: resolve(owned.root, 'phase3-migration.sql'),
        });
      if (adapters.hashFile(bundle.outputPath) !== bundle.sha256) {
        throw new Error('Staging Phase-3 bundle drifted before invocation.');
      }
      const exitCode = adapters.run(command('migrate', candidate, owned, bundle.outputPath));
      if (exitCode !== 0) {
        const failed = databaseObservation(adapters.observeDatabase(context));
        if (!sameDatabase(failed, before)) throw new Error('Failed staging migration left residual state.');
        throw new Error('Atomic staging migration failed; rollback was verified.');
      }
      const after = databaseObservation(adapters.observeDatabase(context));
      if (inputs.authorization.schemaVersion === 2) {
        assertPostCutoverState(after, candidate, inputs.authorization);
      } else {
        assertPhase3State(after, candidate, inputs.authorization);
      }
      return {
        mode: 'migrate', candidateSha: candidate.sha, purpose: inputs.target.purpose,
        targetSha256: inputs.targetSha256, ledger: after.ledger, bundleSha256: bundle.sha256,
      };
    }

    const deploymentDatabase = databaseObservation(adapters.observeDatabase(context));
    if (candidate.migrationCount === 13) {
      assertPhase2State(deploymentDatabase, candidate, inputs.target, inputs.authorization);
    } else if (inputs.authorization.schemaVersion === 2) {
      assertPostCutoverState(deploymentDatabase, candidate, inputs.authorization);
    } else {
      assertPhase3State(deploymentDatabase, candidate, inputs.authorization);
    }
    verifySecrets(adapters.listSecretNames(context), inputs.target.requiredSecretNames);
    const exitCode = adapters.run(command('deploy', candidate, owned, owned.configPath));
    if (exitCode !== 0) throw new Error('Exact staging Worker deployment failed.');
    const deployment = deploymentObservation(adapters.observeDeployment(context));
    if (deployment.tagSha !== candidate.sha || deployment.metadataSha !== candidate.sha
      || deployment.topologySha256 !== inputs.targetSha256 || deployment.trafficPercent !== 100) {
      throw new Error('Staging deployment version, tag, metadata, topology, or traffic did not close.');
    }
    return {
      mode: 'deploy', candidateSha: candidate.sha, purpose: inputs.target.purpose,
      targetSha256: inputs.targetSha256, versionId: deployment.versionId,
      trafficPercent: deployment.trafficPercent,
    };
  } finally {
    removeOwnedRoot(candidate.candidateRoot, owned.root);
  }
}

export interface StagingFinalizeRequest {
  sha: string;
  manifestPath: string;
  phase2ManifestPath: string;
  workflowTargetPath: string;
  cutoverTargetPath: string;
  reviewAuthorizationPath: string;
  authorizationPath: string;
  evidenceInputPath: string;
  runId: string;
}

export interface StagingVerifyRequest {
  artifactPath: string;
  sidecarPath: string;
  manifestPath: string;
  phase2ManifestPath: string;
  reviewAuthorizationPath: string;
  authorizationPath: string;
}

export interface StagingLocalEvidenceAdapters {
  verifyCandidate(request: ReleaseCandidateVerificationRequest): VerifiedReleaseCandidate;
}

interface LoadedCandidateManifest {
  path: string;
  root: string;
  digest: string;
  manifest: CandidateManifest;
  migrationCount: 13 | 14 | 15;
}

function loadCandidateManifestInput(path: string): LoadedCandidateManifest {
  const inputPath = exactRegularFile(path, 'Candidate manifest');
  if (basename(inputPath) !== 'candidate-manifest.json') {
    throw new Error('Candidate manifest filename is invalid.');
  }
  const bytes = readFileSync(inputPath, 'utf8');
  const digest = sha256(bytes);
  const sidecar = readFileSync(exactRegularFile(`${inputPath}.sha256`, 'Candidate manifest sidecar'), 'utf8');
  if (sidecar !== `${digest}  candidate-manifest.json\n`) {
    throw new Error('Candidate manifest sidecar digest does not match.');
  }
  const parsed = JSON.parse(bytes) as unknown;
  assertRedactedCandidateManifest(parsed);
  if (bytes !== `${canonicalJson(parsed)}\n` || parsed.status !== 'passed'
    || parsed.candidate === null || parsed.migrations === null) {
    throw new Error('Candidate manifest is not one canonical complete passed artifact.');
  }
  const migrationCount = parsed.migrations.verification.migrationCount;
  if (migrationCount !== 13 && migrationCount !== 14 && migrationCount !== 15) {
    throw new Error('Candidate manifest is not at a supported release boundary.');
  }
  const runDirectory = dirname(inputPath);
  const shaDirectory = dirname(runDirectory);
  const releaseDirectory = dirname(shaDirectory);
  const outputDirectory = dirname(releaseDirectory);
  const root = dirname(outputDirectory);
  if (basename(runDirectory) !== parsed.runId
    || basename(shaDirectory) !== parsed.candidate.gitSha
    || basename(releaseDirectory) !== 'release'
    || basename(outputDirectory) !== 'output') {
    throw new Error('Candidate manifest path does not match its recorded identity.');
  }
  return { path: inputPath, root, digest, manifest: parsed, migrationCount };
}

function verifyLoadedCandidate(
  loaded: LoadedCandidateManifest,
  adapters: StagingLocalEvidenceAdapters,
): VerifiedReleaseCandidate {
  return adapters.verifyCandidate({
    candidateRoot: loaded.root,
    sha: loaded.manifest.candidate!.gitSha,
    manifestPath: loaded.path,
    approvedBaseSha: APPROVED_BASE_SHA,
    expectedMigrationCount: loaded.migrationCount,
  });
}

function deriveBundleBindings(
  phase2: VerifiedReleaseCandidate,
  finalCandidate: VerifiedReleaseCandidate,
  runId: string,
): { bootstrapSha256: string; finalMigrationsSha256: string; finalBundleSha256: string } {
  const phase2Path = resolve(
    phase2.candidateRoot,
    'output/staging', phase2.sha, runId, '.derived-phase2-bootstrap.sql',
  );
  const phase3Path = resolve(
    finalCandidate.candidateRoot,
    'output/staging', finalCandidate.sha, runId, '.derived-final-migrations.sql',
  );
  let phase2Created = false;
  let phase3Created = false;
  try {
    const bootstrap = buildPhase2BootstrapBundle({
      verifiedPhase2Candidate: phase2,
      through: PHASE_2_MIGRATION,
      outputPath: phase2Path,
    });
    phase2Created = true;
    const migration = finalCandidate.migrationCount === 15
      ? buildPostCutoverMigrationBundle({
        verifiedCandidate: finalCandidate,
        expectedLedger: phase2.migrations.map((file) => basename(file.path)),
        outputPath: phase3Path,
      })
      : buildAtomicMigrationBundle({
        verifiedCandidate: finalCandidate,
        expectedLedger: phase2.migrations.map((file) => basename(file.path)),
        migration: PHASE_3_MIGRATION,
        outputPath: phase3Path,
      });
    phase3Created = true;
    return {
      bootstrapSha256: bootstrap.sha256,
      finalMigrationsSha256: ('migrationHash' in migration
        ? migration.migrationHash
        : migration.migrationsHash)!,
      finalBundleSha256: migration.sha256,
    };
  } finally {
    if (phase2Created) rmSync(phase2Path, { force: true });
    if (phase3Created) rmSync(phase3Path, { force: true });
  }
}

function stagingBindings(
  phase2: VerifiedReleaseCandidate,
  finalCandidate: VerifiedReleaseCandidate,
  review: ReviewAuthorization,
  reviewDigest: string,
  authorization: StagingAuthorization,
  authorizationDigest: string,
  derived: ReturnType<typeof deriveBundleBindings>,
): AnyStagingArtifactBindings {
  const common = {
    candidateSha: finalCandidate.sha,
    phase2Sha: phase2.sha,
    approvedMainSha: review.approvedMainSha,
    phase2ManifestSha256: phase2.manifestSha256,
    candidateManifestSha256: finalCandidate.manifestSha256,
    phase2MigrationManifestSha256: phase2.manifest.candidate!.migrationManifestSha256,
    reviewAuthorizationSha256: reviewDigest,
    stagingAuthorizationSha256: authorizationDigest,
    workflowTargetSha256: authorization.targetSha256s.workflowConformance,
    cutoverTargetSha256: authorization.targetSha256s.cutover,
    bootstrapSha256: derived.bootstrapSha256,
  };
  return authorization.schemaVersion === 2 ? {
    ...common, schemaVersion: 2,
    postCutoverMigrationManifestSha256: finalCandidate.manifest.candidate!.migrationManifestSha256,
    postCutoverMigrationsSha256: derived.finalMigrationsSha256,
    postCutoverBundleSha256: derived.finalBundleSha256,
  } : {
    ...common,
    phase3MigrationManifestSha256: finalCandidate.manifest.candidate!.migrationManifestSha256,
    phase3MigrationSha256: derived.finalMigrationsSha256,
    phase3BundleSha256: derived.finalBundleSha256,
  };
}

function validateLocalEvidenceInputs(
  phase2: VerifiedReleaseCandidate,
  finalCandidate: VerifiedReleaseCandidate,
  reviewInput: CanonicalInput<unknown>,
  authorizationInput: CanonicalInput<unknown>,
  now: string,
): { review: ReviewAuthorization; authorization: StagingAuthorization } {
  const review = parseReviewAuthorization(reviewInput.value, now);
  const authorization = parseStagingAuthorization(authorizationInput.value, now);
  validateCandidateBinding(phase2, review);
  validateCandidateBinding(finalCandidate, review);
  if (review.schemaVersion !== authorization.schemaVersion
    || (review.schemaVersion === 1 && finalCandidate.migrationCount !== 14)
    || (review.schemaVersion === 2 && finalCandidate.migrationCount !== 15)) {
    throw new Error('Staging evidence schema version does not match its final candidate boundary.');
  }
  if (reviewInput.digest !== authorization.reviewAuthorizationSha256
    || !authorization.allowedCandidateShas.includes(phase2.sha)
    || !authorization.allowedCandidateShas.includes(finalCandidate.sha)) {
    throw new Error('Staging evidence authorization does not bind both exact source candidates.');
  }
  return { review, authorization };
}

function actualArtifactBindings(artifact: StagingConformanceArtifact): AnyStagingArtifactBindings {
  return artifact.schemaVersion === 2 ? {
    schemaVersion: 2,
    candidateSha: artifact.candidateSha,
    phase2Sha: artifact.sources.phase2.sha,
    approvedMainSha: artifact.approvedMainSha,
    phase2ManifestSha256: artifact.sources.phase2.manifestSha256,
    candidateManifestSha256: artifact.sources.postCutover.manifestSha256,
    phase2MigrationManifestSha256: artifact.sources.phase2.migrationManifestSha256,
    postCutoverMigrationManifestSha256: artifact.sources.postCutover.migrationManifestSha256,
    reviewAuthorizationSha256: artifact.authorizations.reviewSha256,
    stagingAuthorizationSha256: artifact.authorizations.stagingSha256,
    workflowTargetSha256: artifact.targets.workflowConformanceSha256,
    cutoverTargetSha256: artifact.targets.cutoverSha256,
    bootstrapSha256: artifact.migrations.bootstrapSha256,
    postCutoverMigrationsSha256: artifact.migrations.postCutoverMigrationsSha256,
    postCutoverBundleSha256: artifact.migrations.postCutoverBundleSha256,
  } : {
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

const localEvidenceAdapters: StagingLocalEvidenceAdapters = {
  verifyCandidate(request) {
    return defaultAdapters.verifyCandidate(request);
  },
};

export function finalizeStagingRelease(
  request: StagingFinalizeRequest,
  adapters: StagingLocalEvidenceAdapters = localEvidenceAdapters,
): { path: string; sha256: string } {
  if (!SHA_PATTERN.test(request.sha) || !UUID_PATTERN.test(request.runId)) {
    throw new Error('Staging finalization SHA or run ID is invalid.');
  }
  const phase2Loaded = loadCandidateManifestInput(request.phase2ManifestPath);
  const phase3Loaded = loadCandidateManifestInput(request.manifestPath);
  if (phase2Loaded.migrationCount !== 13
    || (phase3Loaded.migrationCount !== 14 && phase3Loaded.migrationCount !== 15)
    || phase3Loaded.manifest.candidate!.gitSha !== request.sha) {
    throw new Error('Staging finalization source manifests are at the wrong release boundaries.');
  }
  const phase2 = verifyLoadedCandidate(phase2Loaded, adapters);
  const phase3 = verifyLoadedCandidate(phase3Loaded, adapters);
  const reviewInput = readCanonicalExternal<unknown>(request.reviewAuthorizationPath, 'Review authorization');
  const authorizationInput = readCanonicalExternal<unknown>(request.authorizationPath, 'Staging authorization');
  const { review, authorization } = validateLocalEvidenceInputs(
    phase2, phase3, reviewInput, authorizationInput, new Date().toISOString(),
  );
  if (authorization.runId !== request.runId || !authorization.allowedModes.includes('finalize')) {
    throw new Error('Staging authorization does not permit this finalization run.');
  }
  const workflowInput = readCanonicalExternal<unknown>(request.workflowTargetPath, 'Workflow target');
  const cutoverInput = readCanonicalExternal<unknown>(request.cutoverTargetPath, 'Cutover target');
  const workflow = parseStagingTargetDescriptor(workflowInput.value);
  const cutover = parseStagingTargetDescriptor(cutoverInput.value);
  if (workflow.purpose !== 'workflow-conformance' || cutover.purpose !== 'cutover'
    || workflow.schemaVersion !== authorization.schemaVersion
    || cutover.schemaVersion !== authorization.schemaVersion
    || workflowInput.digest !== authorization.targetSha256s.workflowConformance
    || cutoverInput.digest !== authorization.targetSha256s.cutover) {
    throw new Error('Staging finalization target descriptors do not match authorization.');
  }
  const derived = deriveBundleBindings(phase2, phase3, request.runId);
  const expected = stagingBindings(
    phase2, phase3, review, reviewInput.digest,
    authorization, authorizationInput.digest, derived,
  );
  const evidenceInput = readCanonicalExternal<unknown>(request.evidenceInputPath, 'Sanitized staging evidence input');
  const artifact = assertStagingConformanceArtifact(evidenceInput.value);
  if (artifact.runId !== request.runId
    || canonicalJson(actualArtifactBindings(artifact)) !== canonicalJson(expected)) {
    throw new Error('Sanitized staging evidence input does not bind the exact verified sources.');
  }
  const path = resolve(
    phase3.candidateRoot,
    'output/staging', phase3.sha, request.runId, 'staging-conformance.json',
  );
  return writeStagingConformanceArtifact(path, artifact);
}

export function verifyFinalStagingRelease(
  request: StagingVerifyRequest,
  adapters: StagingLocalEvidenceAdapters = localEvidenceAdapters,
): { artifact: StagingConformanceArtifact; sha256: string } {
  const artifactPath = exactRegularFile(request.artifactPath, 'Staging conformance artifact');
  const sidecarPath = exactRegularFile(request.sidecarPath, 'Staging conformance sidecar');
  if (realpathSync(sidecarPath) !== realpathSync(`${artifactPath}.sha256`)) {
    throw new Error('Staging artifact sidecar path does not match the artifact.');
  }
  const phase2Loaded = loadCandidateManifestInput(request.phase2ManifestPath);
  const phase3Loaded = loadCandidateManifestInput(request.manifestPath);
  if (phase2Loaded.migrationCount !== 13
    || (phase3Loaded.migrationCount !== 14 && phase3Loaded.migrationCount !== 15)) {
    throw new Error('Staging verification source manifests are at the wrong release boundaries.');
  }
  const phase2 = verifyLoadedCandidate(phase2Loaded, adapters);
  const phase3 = verifyLoadedCandidate(phase3Loaded, adapters);
  const reviewInput = readCanonicalExternal<unknown>(request.reviewAuthorizationPath, 'Review authorization');
  const authorizationInput = readCanonicalExternal<unknown>(request.authorizationPath, 'Staging authorization');
  const { review, authorization } = validateLocalEvidenceInputs(
    phase2, phase3, reviewInput, authorizationInput, new Date().toISOString(),
  );
  if (!authorization.allowedModes.includes('verify')) {
    throw new Error('Staging authorization does not permit verification.');
  }
  const derived = deriveBundleBindings(phase2, phase3, authorization.runId);
  const expected = stagingBindings(
    phase2, phase3, review, reviewInput.digest,
    authorization, authorizationInput.digest, derived,
  );
  const verified = verifyStagingConformanceArtifactFile(artifactPath, expected);
  if (verified.artifact.runId !== authorization.runId) {
    throw new Error('Staging artifact run ID does not match authorization.');
  }
  return verified;
}

type ParsedRemoteArgs = StagingRemoteRequest;
export type ParsedStagingCliArgs =
  | ParsedRemoteArgs
  | ({ mode: 'finalize' } & StagingFinalizeRequest)
  | ({ mode: 'verify' } & StagingVerifyRequest);

function parseFlagValues(
  args: readonly string[],
  accepted: ReadonlySet<string>,
): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag || !accepted.has(flag) || values.has(flag)) {
      throw new Error(`Staging CLI received an unknown or duplicate argument ${String(flag)}.`);
    }
    if (!value) throw new Error(`Staging CLI argument ${flag} is missing or empty.`);
    values.set(flag, value);
  }
  for (const flag of accepted) {
    if (!values.has(flag)) throw new Error(`Staging CLI argument ${flag} is required.`);
  }
  return values;
}

export function parseStagingReleaseArgsV1(
  args: readonly string[],
  cwd = process.cwd(),
): ParsedStagingCliArgs {
  const mode = args[0];
  if (mode === 'finalize') {
    const accepted = new Set([
      '--sha', '--manifest', '--phase2-manifest', '--workflow-target', '--cutover-target',
      '--review-authorization', '--authorization', '--evidence-input', '--run-id',
    ]);
    const values = parseFlagValues(args, accepted);
    return {
      mode,
      sha: patternValue(values.get('--sha'), SHA_PATTERN, '--sha'),
      manifestPath: exactRegularFile(resolve(cwd, values.get('--manifest')!), 'Candidate manifest'),
      phase2ManifestPath: exactRegularFile(resolve(cwd, values.get('--phase2-manifest')!), 'Phase-2 manifest'),
      workflowTargetPath: exactRegularFile(resolve(cwd, values.get('--workflow-target')!), 'Workflow target'),
      cutoverTargetPath: exactRegularFile(resolve(cwd, values.get('--cutover-target')!), 'Cutover target'),
      reviewAuthorizationPath: exactRegularFile(resolve(cwd, values.get('--review-authorization')!), 'Review authorization'),
      authorizationPath: exactRegularFile(resolve(cwd, values.get('--authorization')!), 'Staging authorization'),
      evidenceInputPath: exactRegularFile(resolve(cwd, values.get('--evidence-input')!), 'Sanitized evidence input'),
      runId: patternValue(values.get('--run-id'), UUID_PATTERN, '--run-id'),
    };
  }
  if (mode === 'verify') {
    const accepted = new Set([
      '--artifact', '--sidecar', '--manifest', '--phase2-manifest',
      '--review-authorization', '--authorization',
    ]);
    const values = parseFlagValues(args, accepted);
    return {
      mode,
      artifactPath: exactRegularFile(resolve(cwd, values.get('--artifact')!), 'Staging artifact'),
      sidecarPath: exactRegularFile(resolve(cwd, values.get('--sidecar')!), 'Staging artifact sidecar'),
      manifestPath: exactRegularFile(resolve(cwd, values.get('--manifest')!), 'Candidate manifest'),
      phase2ManifestPath: exactRegularFile(resolve(cwd, values.get('--phase2-manifest')!), 'Phase-2 manifest'),
      reviewAuthorizationPath: exactRegularFile(resolve(cwd, values.get('--review-authorization')!), 'Review authorization'),
      authorizationPath: exactRegularFile(resolve(cwd, values.get('--authorization')!), 'Staging authorization'),
    };
  }
  if (mode !== 'initialize' && mode !== 'deploy' && mode !== 'migrate') {
    throw new Error('Staging CLI mode is missing or unknown for this command parser.');
  }
  const accepted = new Set([
    '--candidate-root', '--sha', '--manifest', '--target', '--review-authorization',
    '--authorization', '--run-id', ...(mode === 'initialize' ? ['--through'] : []),
  ]);
  const values = parseFlagValues(args, accepted);
  const candidateRoot = resolve(cwd, values.get('--candidate-root')!);
  const through = values.get('--through');
  if (mode === 'initialize' && through !== PHASE_2_MIGRATION) {
    throw new Error(`--through must be exactly ${PHASE_2_MIGRATION}.`);
  }
  return {
    mode,
    candidateRoot,
    sha: patternValue(values.get('--sha'), SHA_PATTERN, '--sha'),
    manifestPath: exactRegularFile(resolve(cwd, values.get('--manifest')!), 'Candidate manifest'),
    targetPath: exactRegularFile(resolve(cwd, values.get('--target')!), 'Staging target'),
    reviewAuthorizationPath: exactRegularFile(resolve(cwd, values.get('--review-authorization')!), 'Review authorization'),
    authorizationPath: exactRegularFile(resolve(cwd, values.get('--authorization')!), 'Staging authorization'),
    runId: patternValue(values.get('--run-id'), UUID_PATTERN, '--run-id'),
    ...(mode === 'initialize' ? { through: PHASE_2_MIGRATION } : {}),
  };
}

function gitValue(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

function resolveNpmCli(): string {
  const candidates = [
    process.env.npm_execpath,
    resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return exactRegularFile(candidate, 'npm CLI');
    } catch {
      // Only fixed Node/npm installation paths are eligible.
    }
  }
  throw new Error('A regular npm-cli.js could not be resolved.');
}

function wranglerJson(context: StagingObservationContext, args: string[]): unknown {
  const output = execFileSync(process.execPath, [context.candidate.wranglerCliPath, ...args, '--json'], {
    cwd: context.ownedRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return JSON.parse(output) as unknown;
}

function d1Rows(context: StagingObservationContext, sql: string): Array<Record<string, unknown>> {
  const parsed = wranglerJson(context, [
    'd1', 'execute', 'DB', '--remote', '--config', 'dist/candidary/wrangler.json', '--command', sql,
  ]);
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error('Wrangler returned unexpected D1 JSON.');
  const result = plainObject(parsed[0], 'D1 result');
  if (!Array.isArray(result.results)) throw new Error('Wrangler D1 result rows are missing.');
  return result.results.map((row) => plainObject(row, 'D1 row'));
}

function numeric(row: Record<string, unknown>, field: string): number {
  const value = row[field];
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`D1 ${field} is invalid.`);
  return value as number;
}

export interface MediaCutoverReadinessObservation {
  liveLegacyCount: number;
  unverifiedLiveLegacyCount: number;
}

export function parseMediaCutoverReadinessRows(
  value: unknown,
): MediaCutoverReadinessObservation {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error('Media cutover readiness must contain one primary D1 row.');
  }
  const row = exactRecord(value[0], [
    'live_legacy_count', 'unverified_live_legacy_count',
  ], 'Media cutover readiness row');
  return {
    liveLegacyCount: numeric(row, 'live_legacy_count'),
    unverifiedLiveLegacyCount: numeric(row, 'unverified_live_legacy_count'),
  };
}

export function observeMediaCutoverReadiness(
  context: StagingObservationContext,
): MediaCutoverReadinessObservation {
  return parseMediaCutoverReadinessRows(d1Rows(context, MEDIA_CUTOVER_READINESS_QUERY));
}

function observeStagingDatabase(context: StagingObservationContext): StagingDatabaseObservation {
  const tables = d1Rows(context, "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name;");
  const hasLedger = tables.some((row) => row.type === 'table' && row.name === 'd1_migrations');
  const ledger = hasLedger
    ? d1Rows(context, 'SELECT name FROM d1_migrations ORDER BY id;').map((row) => textValue(row.name, 'migration name'))
    : [];
  const integrityRows = d1Rows(context, 'PRAGMA integrity_check;');
  const foreignKeyRows = d1Rows(context, 'PRAGMA foreign_key_check;').length;
  const eventsPresent = tables.some((row) => row.type === 'table' && row.name === 'events');
  const counts = eventsPresent ? d1Rows(context, [
    'SELECT',
    "(SELECT count(*) FROM events e WHERE e.deleted_at IS NULL AND e.cover_object_key IS NOT NULL AND e.cover_render_set_id IS NULL) AS legacyRows,",
    "(SELECT count(*) FROM event_cover_backfill_jobs j JOIN events e ON e.id = j.event_id WHERE j.status IN ('needs_replacement','failed') AND e.deleted_at IS NULL AND e.cover_object_key IS NOT NULL AND e.cover_render_set_id IS NULL) AS blockingJobs,",
    "(SELECT count(*) FROM event_cover_render_sets s WHERE s.state = 'active' AND (s.manifest_sha256 IS NULL OR s.required_slots <> (SELECT count(*) FROM event_cover_render_objects o WHERE o.render_set_id = s.id))) AS incompleteActiveSets,",
    "(SELECT count(*) FROM events e WHERE e.deleted_at IS NULL AND json_extract(e.cover_config, '$.source.kind') = 'upload' AND (e.cover_object_key IS NULL OR e.cover_render_set_id IS NULL)) AS uploadsWithoutActiveSet;",
  ].join(' '))[0] : null;
  return {
    empty: tables.length === 0,
    applicationObjectCount: tables.filter((row) => row.name !== 'd1_migrations').length,
    ledger,
    schemaSha256: sha256(canonicalJson(tables)),
    integrity: integrityRows.length === 1 && integrityRows[0]?.integrity_check === 'ok' ? 'ok' : 'failed' as 'ok',
    foreignKeyRows: foreignKeyRows as 0,
    triggerNames: tables.filter((row) => row.type === 'trigger')
      .map((row) => textValue(row.name, 'trigger name'))
      .sort(),
    zeroCounts: counts ? {
      legacyRows: numeric(counts, 'legacyRows'),
      blockingJobs: numeric(counts, 'blockingJobs'),
      incompleteActiveSets: numeric(counts, 'incompleteActiveSets'),
      uploadsWithoutActiveSet: numeric(counts, 'uploadsWithoutActiveSet'),
    } : { legacyRows: 0, blockingJobs: 0, incompleteActiveSets: 0, uploadsWithoutActiveSet: 0 },
  };
}

const defaultAdapters: StagingReleaseAdapters = {
  now: () => new Date().toISOString(),
  verifyCandidate(request) {
    return verifyExactReleaseCandidate(request, {
      resolveCommit: (root, sha) => gitValue(['rev-parse', '--verify', `${sha}^{commit}`], root),
      head: (root) => gitValue(['rev-parse', '--verify', 'HEAD^{commit}'], root),
      tree: (root) => gitValue(['rev-parse', '--verify', 'HEAD^{tree}'], root),
      status: (root) => gitValue(['status', '--porcelain=v1', '--untracked-files=all'], root),
    });
  },
  prepareCandidate(candidate) {
    const npmCli = resolveNpmCli();
    for (const args of [[npmCli, 'ci'], [npmCli, 'run', 'build'], [npmCli, 'run', 'verify:pwa-build']]) {
      const result = spawnSync(process.execPath, args, {
        cwd: candidate.candidateRoot,
        shell: false,
        stdio: 'inherit',
        env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
      });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error('Staging candidate preparation failed.');
    }
  },
  listSecretNames(context) {
    const parsed = wranglerJson(context, ['secret', 'list', '--name', context.target.worker.name]);
    if (!Array.isArray(parsed)) throw new Error('Wrangler secret list returned unexpected JSON.');
    return parsed.map((item) => textValue(plainObject(item, 'secret list row').name, 'secret name'));
  },
  observeDatabase: observeStagingDatabase,
  observeDeployment(context) {
    const parsed = wranglerJson(context, ['deployments', 'status', '--name', context.target.worker.name]);
    const result = plainObject(parsed, 'deployment status');
    return deploymentObservation(result);
  },
  hashFile: (path) => sha256(readFileSync(path)),
  run(stagingCommand) {
    const result = spawnSync(stagingCommand.executable, stagingCommand.args, {
      cwd: stagingCommand.cwd,
      shell: stagingCommand.shell,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    return result.status ?? -1;
  },
};

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  try {
    const args = parseStagingReleaseArgsV1(process.argv.slice(2));
    const result = args.mode === 'finalize'
      ? finalizeStagingRelease(args)
      : args.mode === 'verify'
        ? verifyFinalStagingRelease(args)
        : runStagingRelease(args);
    console.log(canonicalJson(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Guarded staging release failed.');
    process.exitCode = 1;
  }
}

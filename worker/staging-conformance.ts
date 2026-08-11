import { WorkerEntrypoint } from 'cloudflare:workers';

import {
  EVENT_COVER_EFFECTS,
  EVENT_COVER_PROFILES,
  MAX_COVER_UPLOAD_BYTES,
  MAX_COVER_MANUAL_ZOOM,
  type CoverFocusPoint,
  type EventCoverDensity,
  type EventCoverEffectId,
  type EventCoverFormat,
  type EventCoverProfileId,
} from '../shared/event-cover';
import { ApiError } from '../shared/errors';
import {
  STAGING_ORIGIN,
  assertConformanceCaseId,
  assertConformanceRunId,
  conformanceBackfillIdentity,
  conformanceUuid,
  physicalConformancePrefix,
} from '../shared/staging-conformance';
import type { AppEnv } from './env';
import { resolveRuntimeReleaseIdentity } from './release-identity';
import { coverMasterKey } from './storage/event-cover-keys';
import {
  normalizeCoverMaster,
  readCoverSourceInfo,
  renderCoverPreview,
  renderCoverProfileObject,
  type CoverMasterResult,
  type CoverPreviewResult,
  type CoverRenderObjectResult,
  type CoverSourceInfo,
} from './storage/event-cover-images';
import { proveZeroLegacyCovers } from './workflows/cover-backfill';
import { scheduledCleanup } from './workflows/cleanup';
import {
  classifyWorkflowLookupError,
  defaultCoverBackfillWorkflowAccessor,
  dispositionForLookup,
  type CoverBackfillWorkflowAccessor,
  type CoverWorkflowLookup,
} from './workflows/cover-platform';

const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
]);
const PROFILE_IDS = new Set(EVENT_COVER_PROFILES.map((profile) => profile.id));
const EFFECT_IDS = new Set(EVENT_COVER_EFFECTS);
const DENSITIES = new Set<EventCoverDensity>(['1x', '2x']);
const FORMATS = new Set<EventCoverFormat>(['webp', 'jpeg']);

export interface StagingRuntimeRequest { readonly runId: string }
export interface StagingCaseRequest extends StagingRuntimeRequest { readonly caseId: string }

export interface StagingNormalizeRequest extends StagingCaseRequest {
  readonly declaredMimeType: string;
}

export interface StagingPreviewRequest extends StagingCaseRequest {
  readonly effect: EventCoverEffectId;
}

export interface StagingProfileRequest extends StagingCaseRequest {
  readonly effect: EventCoverEffectId;
  readonly profile: EventCoverProfileId;
  readonly density: EventCoverDensity;
  readonly format: EventCoverFormat;
  readonly focus: CoverFocusPoint;
  readonly master: { readonly width: number; readonly height: number };
}

export interface StagingBatchRequest extends StagingCaseRequest { readonly count: number }
export interface StagingCleanupRequest extends StagingRuntimeRequest { readonly now: string }
export interface StagingWorkflowControlRequest extends StagingRuntimeRequest {
  readonly control: 'status-unknown' | 'failed-lookup';
}

export interface SanitizedImageResult {
  readonly caseId: string;
  readonly outcome: 'accepted' | 'rejected';
  readonly resultCode: string | null;
  readonly detectedType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic' | null;
  readonly format: 'webp' | 'jpeg' | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly byteSize: number | null;
  readonly sha256: string | null;
  readonly qualityRung: number | null;
  readonly adopted: boolean;
}

export interface ConformanceSummary {
  readonly legacyRows: number;
  readonly blockingJobs: number;
  readonly incompleteActiveSets: number;
  readonly uploadsWithoutActiveSet: number;
  readonly verifiedAt: string | null;
  readonly purgeRows: number;
}

export interface StagingConformanceDependencies {
  readonly readSourceInfo: (env: AppEnv, bytes: ArrayBuffer) => Promise<CoverSourceInfo>;
  readonly normalizeMaster: typeof normalizeCoverMaster;
  readonly renderPreview: typeof renderCoverPreview;
  readonly renderProfile: typeof renderCoverProfileObject;
  readonly backfillWorkflow: (env: AppEnv) => CoverBackfillWorkflowAccessor;
  readonly pauseBackfill: (env: AppEnv, instanceId: string) => Promise<void>;
  readonly scheduledCleanup: (env: AppEnv, now: Date) => Promise<void>;
  readonly readSummary: (env: AppEnv, runId: string) => Promise<ConformanceSummary>;
}

function assertCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 25) {
    throw new Error('STAGING_CONFORMANCE_INPUT_INVALID');
  }
  return value as number;
}

function assertInstant(value: unknown): Date {
  if (typeof value !== 'string' || !ISO_INSTANT_PATTERN.test(value)) {
    throw new Error('STAGING_CONFORMANCE_INPUT_INVALID');
  }
  const date = new Date(value);
  if (date.toISOString() !== value) throw new Error('STAGING_CONFORMANCE_INPUT_INVALID');
  return date;
}

function assertPositiveDimension(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 20_000) {
    throw new Error('STAGING_CONFORMANCE_INPUT_INVALID');
  }
  return value as number;
}

function assertFocus(value: unknown): CoverFocusPoint {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('STAGING_CONFORMANCE_INPUT_INVALID');
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 3
    || typeof record.x !== 'number' || !Number.isFinite(record.x) || record.x < 0 || record.x > 1
    || typeof record.y !== 'number' || !Number.isFinite(record.y) || record.y < 0 || record.y > 1
    || typeof record.zoom !== 'number' || !Number.isFinite(record.zoom)
    || record.zoom < 1 || record.zoom > MAX_COVER_MANUAL_ZOOM) {
    throw new Error('STAGING_CONFORMANCE_INPUT_INVALID');
  }
  return { x: record.x, y: record.y, zoom: record.zoom };
}

function logicalR2Key(value: string): string {
  if (value.length === 0 || value.length > 512 || value.startsWith('/') || value.endsWith('/')
    || value.includes('\\') || value.split('/').some((segment) => segment === '' || segment === '..' || segment === '.')) {
    throw new Error('STAGING_CONFORMANCE_R2_SCOPE_INVALID');
  }
  return value;
}

function logicalR2Prefix(value: string): string {
  const withoutTrailingSlash = value.endsWith('/') ? value.slice(0, -1) : value;
  logicalR2Key(withoutTrailingSlash);
  return value;
}

function scopedObject<T extends R2Object>(object: T, prefix: string): T {
  return new Proxy(object, {
    get(target, property) {
      if (property === 'key') {
        if (!target.key.startsWith(prefix)) throw new Error('STAGING_CONFORMANCE_R2_SCOPE_INVALID');
        return target.key.slice(prefix.length);
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) as unknown : value;
    },
  });
}

export function scopedConformanceBucket(bucket: R2Bucket, runId: string): R2Bucket {
  const prefix = physicalConformancePrefix(runId);
  const key = (value: string): string => `${prefix}${logicalR2Key(value)}`;
  const get: R2Bucket['get'] = ((value: string, options?: R2GetOptions) => (
    bucket.get(key(value), options)
  )) as R2Bucket['get'];
  const put: R2Bucket['put'] = ((value: string, body: Parameters<R2Bucket['put']>[1], options?: R2PutOptions) => (
    bucket.put(key(value), body, options)
  )) as R2Bucket['put'];
  return {
    async head(value) {
      const object = await bucket.head(key(value));
      return object ? scopedObject(object, prefix) : null;
    },
    get,
    put,
    createMultipartUpload() {
      throw new Error('STAGING_CONFORMANCE_R2_METHOD_DISABLED');
    },
    resumeMultipartUpload() {
      throw new Error('STAGING_CONFORMANCE_R2_METHOD_DISABLED');
    },
    async delete(value) {
      await bucket.delete(Array.isArray(value) ? value.map(key) : key(value));
    },
    async list(options = {}) {
      const result = await bucket.list({
        ...options,
        prefix: `${prefix}${options.prefix ? logicalR2Prefix(options.prefix) : ''}`,
        ...(options.startAfter ? { startAfter: key(options.startAfter) } : {}),
      });
      const objects = result.objects.map((object) => scopedObject(object, prefix));
      const delimitedPrefixes = result.delimitedPrefixes.map((value) => {
        if (!value.startsWith(prefix)) throw new Error('STAGING_CONFORMANCE_R2_SCOPE_INVALID');
        return value.slice(prefix.length);
      });
      return result.truncated
        ? { objects, delimitedPrefixes, truncated: true, cursor: result.cursor }
        : { objects, delimitedPrefixes, truncated: false };
    },
  };
}

function scopedEnv(env: AppEnv, runId: string): AppEnv {
  const bucket = scopedConformanceBucket(env.MEDIA_BUCKET, runId);
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === 'MEDIA_BUCKET') return bucket;
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

function scope(env: AppEnv, input: StagingCaseRequest | StagingRuntimeRequest): {
  readonly runId: string;
  readonly caseId: string | null;
  readonly env: AppEnv;
} {
  if (String(env.APP_ORIGIN) !== STAGING_ORIGIN) throw new Error('STAGING_CONFORMANCE_DISABLED');
  let runId: string;
  let caseId: string | null = null;
  try {
    runId = assertConformanceRunId(input.runId);
    if ('caseId' in input) caseId = assertConformanceCaseId(input.caseId);
  } catch {
    throw new Error('STAGING_CONFORMANCE_INPUT_INVALID');
  }
  return { runId, caseId, env: scopedEnv(env, runId) };
}

async function digest(bytes: ArrayBuffer): Promise<string> {
  const value = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function detectedType(value: string): SanitizedImageResult['detectedType'] {
  const normalized = value === 'jpeg' ? 'image/jpeg'
    : value === 'png' ? 'image/png'
      : value === 'webp' ? 'image/webp'
        : value === 'heic' ? 'image/heic'
          : value;
  return normalized === 'image/jpeg' || normalized === 'image/png'
    || normalized === 'image/webp' || normalized === 'image/heic'
    ? normalized
    : null;
}

function imageResult(
  caseId: string,
  value: CoverMasterResult | CoverPreviewResult | CoverRenderObjectResult,
  format: 'webp' | 'jpeg',
  adopted: boolean,
): SanitizedImageResult {
  return {
    caseId,
    outcome: 'accepted',
    resultCode: null,
    detectedType: null,
    format,
    width: value.width,
    height: value.height,
    byteSize: value.byteSize,
    sha256: value.sha256,
    qualityRung: value.rung,
    adopted,
  };
}

const EXPECTED_IMAGE_RESULT_CODES = new Set([
  'COVER_MASTER_BUDGET_EXHAUSTED',
  'COVER_OUTPUT_BUDGET_EXHAUSTED',
  'COVER_PREVIEW_BUDGET_EXHAUSTED',
  'COVER_RENDER_UNAVAILABLE',
  'COVER_SOURCE_TOO_SMALL',
  'COVER_SOURCE_UNSUPPORTED',
  'UPLOAD_OBJECT_MISSING',
]);

function rejectedImageResult(caseId: string, error: unknown): SanitizedImageResult {
  if (error === null || typeof error !== 'object') {
    throw new Error('STAGING_CONFORMANCE_CASE_FAILED');
  }
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  const code = descriptor && 'value' in descriptor ? descriptor.value : null;
  if (typeof code !== 'string' || !EXPECTED_IMAGE_RESULT_CODES.has(code)) {
    throw new Error('STAGING_CONFORMANCE_CASE_FAILED');
  }
  return {
    caseId,
    outcome: 'rejected',
    resultCode: code,
    detectedType: null,
    format: null,
    width: null,
    height: null,
    byteSize: null,
    sha256: null,
    qualityRung: null,
    adopted: false,
  };
}

function workflowStatus(lookup: CoverWorkflowLookup): string {
  if (lookup.kind === 'missing') return 'missing';
  if (lookup.kind === 'unknown') return 'lookup-unknown';
  switch (lookup.status) {
    case 'queued':
    case 'running':
    case 'paused':
    case 'errored':
    case 'terminated':
    case 'complete':
    case 'waiting':
    case 'waitingForPause':
    case 'unknown':
      return lookup.status;
    default:
      return 'unmapped';
  }
}

async function count(env: AppEnv, sql: string, ...values: unknown[]): Promise<number> {
  const result = await env.DB.prepare(sql).bind(...values).first<{ count: number }>();
  if (!result || !Number.isSafeInteger(result.count) || result.count < 0) {
    throw new Error('STAGING_CONFORMANCE_SUMMARY_INVALID');
  }
  return result.count;
}

async function readDefaultSummary(env: AppEnv, runId: string): Promise<ConformanceSummary> {
  const proof = await proveZeroLegacyCovers(env);
  const run = await env.DB.prepare(`
    SELECT verified_at FROM event_cover_backfill_runs WHERE id = ?
  `).bind(runId).first<{ verified_at: string | null }>();
  return {
    legacyRows: proof.legacyRows,
    blockingJobs: proof.blockingJobs,
    incompleteActiveSets: proof.incompleteActiveSets,
    uploadsWithoutActiveSet: proof.uploadsWithoutActiveSet,
    verifiedAt: run?.verified_at ?? null,
    purgeRows: await count(env, `
      SELECT COUNT(*) AS count FROM event_cover_purge_progress
    `),
  };
}

const DEFAULT_DEPENDENCIES: StagingConformanceDependencies = {
  readSourceInfo: readCoverSourceInfo,
  normalizeMaster: normalizeCoverMaster,
  renderPreview: renderCoverPreview,
  renderProfile: renderCoverProfileObject,
  backfillWorkflow: defaultCoverBackfillWorkflowAccessor,
  async pauseBackfill(env, instanceId) {
    await (await env.COVER_BACKFILL_WORKFLOW.get(instanceId)).pause();
  },
  scheduledCleanup,
  readSummary: readDefaultSummary,
};

export class StagingConformanceService {
  constructor(
    private readonly env: AppEnv,
    private readonly dependencies: StagingConformanceDependencies = DEFAULT_DEPENDENCIES,
  ) {}

  runtimeIdentity(input: StagingRuntimeRequest) {
    scope(this.env, input);
    const identity = resolveRuntimeReleaseIdentity(this.env);
    const metadata = this.env.CF_VERSION_METADATA;
    if (!identity || metadata.tag !== identity.buildSha || !ISO_INSTANT_PATTERN.test(metadata.timestamp)
      || new Date(metadata.timestamp).toISOString() !== metadata.timestamp) {
      throw new Error('STAGING_CONFORMANCE_RUNTIME_IDENTITY_INVALID');
    }
    return {
      versionId: metadata.id,
      versionTag: metadata.tag,
      versionTimestamp: metadata.timestamp,
    };
  }

  async inspectImageCase(input: StagingCaseRequest): Promise<SanitizedImageResult> {
    const scoped = scope(this.env, input);
    try {
      const object = await scoped.env.MEDIA_BUCKET.get(`fixtures/${scoped.caseId!}`);
      if (!object?.body) throw new Error('STAGING_CONFORMANCE_FIXTURE_MISSING');
      const bytes = await object.arrayBuffer();
      if (bytes.byteLength > MAX_COVER_UPLOAD_BYTES) {
        throw new ApiError('COVER_SOURCE_UNSUPPORTED', 'Task 11 source exceeds the product byte ceiling.', 422);
      }
      const info = await this.dependencies.readSourceInfo(scoped.env, bytes);
      const type = detectedType(info.format);
      if (type === null) {
        throw new ApiError('COVER_SOURCE_UNSUPPORTED', 'Task 11 source is outside the product type contract.', 422);
      }
      return {
        caseId: scoped.caseId!, outcome: 'accepted', resultCode: null,
        detectedType: type, format: null,
        width: info.width, height: info.height, byteSize: bytes.byteLength,
        sha256: await digest(bytes), qualityRung: null, adopted: false,
      };
    } catch (error) {
      return rejectedImageResult(scoped.caseId!, error);
    }
  }

  async normalizeImageCase(input: StagingNormalizeRequest): Promise<SanitizedImageResult> {
    const scoped = scope(this.env, input);
    if (!ALLOWED_MIME_TYPES.has(input.declaredMimeType)) {
      throw new Error('STAGING_CONFORMANCE_INPUT_INVALID');
    }
    const eventId = await conformanceUuid(scoped.runId, scoped.caseId!, 'event');
    const masterId = await conformanceUuid(scoped.runId, scoped.caseId!, 'master');
    try {
      const value = await this.dependencies.normalizeMaster(scoped.env, {
        eventId,
        masterId,
        rawKey: `fixtures/${scoped.caseId!}`,
        declaredMimeType: input.declaredMimeType,
      });
      return imageResult(scoped.caseId!, value, 'webp', false);
    } catch (error) {
      return rejectedImageResult(scoped.caseId!, error);
    }
  }

  async renderPreviewCase(input: StagingPreviewRequest): Promise<SanitizedImageResult> {
    const scoped = scope(this.env, input);
    if (!EFFECT_IDS.has(input.effect)) throw new Error('STAGING_CONFORMANCE_INPUT_INVALID');
    const eventId = await conformanceUuid(scoped.runId, scoped.caseId!, 'event');
    const masterId = await conformanceUuid(scoped.runId, scoped.caseId!, 'master');
    const draftId = await conformanceUuid(scoped.runId, scoped.caseId!, 'draft');
    try {
      const value = await this.dependencies.renderPreview(scoped.env, {
        eventId,
        draftId,
        masterKey: coverMasterKey(eventId, masterId),
        effect: input.effect,
      });
      return imageResult(scoped.caseId!, value, 'webp', false);
    } catch (error) {
      return rejectedImageResult(scoped.caseId!, error);
    }
  }

  async renderProfileCase(input: StagingProfileRequest): Promise<SanitizedImageResult> {
    const scoped = scope(this.env, input);
    if (!EFFECT_IDS.has(input.effect) || !PROFILE_IDS.has(input.profile)
      || !DENSITIES.has(input.density) || !FORMATS.has(input.format)) {
      throw new Error('STAGING_CONFORMANCE_INPUT_INVALID');
    }
    const focus = assertFocus(input.focus);
    const master = {
      width: assertPositiveDimension(input.master?.width),
      height: assertPositiveDimension(input.master?.height),
    };
    const eventId = await conformanceUuid(scoped.runId, scoped.caseId!, 'event');
    const masterId = await conformanceUuid(scoped.runId, scoped.caseId!, 'master');
    const renderSetId = await conformanceUuid(scoped.runId, scoped.caseId!, 'render-set');
    try {
      const value = await this.dependencies.renderProfile(scoped.env, {
        eventId,
        renderSetId,
        masterKey: coverMasterKey(eventId, masterId),
        master,
        focus,
        effect: input.effect,
        profile: input.profile,
        density: input.density,
        format: input.format,
      });
      return imageResult(scoped.caseId!, value, input.format, value.adopted);
    } catch (error) {
      return rejectedImageResult(scoped.caseId!, error);
    }
  }

  async workflowLookup(input: StagingCaseRequest) {
    const scoped = scope(this.env, input);
    const identity = await conformanceBackfillIdentity(scoped.runId, scoped.caseId!);
    const lookup = await this.dependencies.backfillWorkflow(scoped.env).lookup(identity.instanceId);
    return { caseId: scoped.caseId!, status: workflowStatus(lookup) };
  }

  workflowControl(input: StagingWorkflowControlRequest) {
    scope(this.env, input);
    const lookup = input.control === 'status-unknown'
      ? { kind: 'status' as const, status: 'unknown' }
      : input.control === 'failed-lookup'
        ? classifyWorkflowLookupError(new Error('staging control'))
        : null;
    if (lookup === null) throw new Error('STAGING_CONFORMANCE_INPUT_INVALID');
    const disposition = dispositionForLookup(lookup);
    return {
      control: input.control,
      disposition: disposition.kind,
      recovery: disposition.recovery,
      mutates: disposition.mutates,
    };
  }

  async createBackfillBatch(input: StagingBatchRequest) {
    const scoped = scope(this.env, input);
    const size = assertCount(input.count);
    const batch = await Promise.all(Array.from({ length: size }, async (_, index) => {
      const identity = await conformanceBackfillIdentity(scoped.runId, scoped.caseId!, index);
      return {
        id: identity.instanceId,
        params: { runId: identity.runId, jobId: identity.jobId, eventId: identity.eventId },
      };
    }));
    await this.dependencies.backfillWorkflow(scoped.env).createBatch(batch);
    return { caseId: scoped.caseId!, outcome: 'accepted' as const, count: size };
  }

  private async lifecycle(input: StagingCaseRequest, method: 'resume' | 'restart' | 'terminate') {
    const scoped = scope(this.env, input);
    const identity = await conformanceBackfillIdentity(scoped.runId, scoped.caseId!);
    await this.dependencies.backfillWorkflow(scoped.env)[method](identity.instanceId);
    return { caseId: scoped.caseId!, outcome: 'accepted' as const };
  }

  resumeBackfill(input: StagingCaseRequest) { return this.lifecycle(input, 'resume'); }
  restartBackfill(input: StagingCaseRequest) { return this.lifecycle(input, 'restart'); }
  terminateBackfill(input: StagingCaseRequest) { return this.lifecycle(input, 'terminate'); }

  async pauseBackfill(input: StagingCaseRequest) {
    const scoped = scope(this.env, input);
    const identity = await conformanceBackfillIdentity(scoped.runId, scoped.caseId!);
    await this.dependencies.pauseBackfill(scoped.env, identity.instanceId);
    return { caseId: scoped.caseId!, outcome: 'accepted' as const };
  }

  async runScheduledCleanup(input: StagingCleanupRequest): Promise<ConformanceSummary> {
    const scoped = scope(this.env, input);
    // The conformance target owns a fresh, dedicated staging D1 and R2 bucket.
    // Product Workflows write their ordinary `events/{eventId}/...` keys through
    // the unwrapped binding, so the production cleanup coordinator must observe
    // that same binding. The route-less staging sentinel and target digest are
    // the destructive boundary; the logical-prefix proxy remains for the image
    // RPCs that deliberately share one bucket across cases.
    await this.dependencies.scheduledCleanup(this.env, assertInstant(input.now));
    return this.dependencies.readSummary(this.env, scoped.runId);
  }

  async emptyStagingBucket(input: StagingRuntimeRequest) {
    scope(this.env, input);
    let deletedObjects = 0;
    for (;;) {
      const listed = await this.env.MEDIA_BUCKET.list({ limit: 1_000 });
      if (listed.objects.length === 0) {
        return { deletedObjects, remainingObjects: 0 as const };
      }
      await this.env.MEDIA_BUCKET.delete(listed.objects.map((object) => object.key));
      deletedObjects += listed.objects.length;
    }
  }

  async readConformanceSummary(input: StagingRuntimeRequest): Promise<ConformanceSummary> {
    const scoped = scope(this.env, input);
    return this.dependencies.readSummary(scoped.env, scoped.runId);
  }
}

export class StagingConformanceEntrypoint extends WorkerEntrypoint<AppEnv> {
  runtimeIdentity(input: StagingRuntimeRequest) {
    return new StagingConformanceService(this.env).runtimeIdentity(input);
  }
  inspectImageCase(input: StagingCaseRequest) {
    return new StagingConformanceService(this.env).inspectImageCase(input);
  }
  normalizeImageCase(input: StagingNormalizeRequest) {
    return new StagingConformanceService(this.env).normalizeImageCase(input);
  }
  renderPreviewCase(input: StagingPreviewRequest) {
    return new StagingConformanceService(this.env).renderPreviewCase(input);
  }
  renderProfileCase(input: StagingProfileRequest) {
    return new StagingConformanceService(this.env).renderProfileCase(input);
  }
  workflowLookup(input: StagingCaseRequest) {
    return new StagingConformanceService(this.env).workflowLookup(input);
  }
  workflowControl(input: StagingWorkflowControlRequest) {
    return new StagingConformanceService(this.env).workflowControl(input);
  }
  createBackfillBatch(input: StagingBatchRequest) {
    return new StagingConformanceService(this.env).createBackfillBatch(input);
  }
  resumeBackfill(input: StagingCaseRequest) {
    return new StagingConformanceService(this.env).resumeBackfill(input);
  }
  pauseBackfill(input: StagingCaseRequest) {
    return new StagingConformanceService(this.env).pauseBackfill(input);
  }
  restartBackfill(input: StagingCaseRequest) {
    return new StagingConformanceService(this.env).restartBackfill(input);
  }
  terminateBackfill(input: StagingCaseRequest) {
    return new StagingConformanceService(this.env).terminateBackfill(input);
  }
  runScheduledCleanup(input: StagingCleanupRequest) {
    return new StagingConformanceService(this.env).runScheduledCleanup(input);
  }
  emptyStagingBucket(input: StagingRuntimeRequest) {
    return new StagingConformanceService(this.env).emptyStagingBucket(input);
  }
  readConformanceSummary(input: StagingRuntimeRequest) {
    return new StagingConformanceService(this.env).readConformanceSummary(input);
  }
}

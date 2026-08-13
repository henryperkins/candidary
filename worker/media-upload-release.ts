import releaseConfig from '../config/media-upload-release.json';

declare const __CANDIDARY_TEST_MEDIA_UPLOAD_RELEASE__: boolean;

declare global {
  // The compile-time switch is present only in vitest.worker.config.ts. Tests
  // may force Candidate A semantics for one case; production cannot enable a
  // capability through a request, binding, or global value because its build
  // does not define the outer compile-time guard.
  var __CANDIDARY_TEST_MEDIA_UPLOAD_RELEASE_OVERRIDE__:
    | boolean
    | 'copy-only'
    | undefined;
}

const ROOT_KEYS = ['capabilities', 'kind', 'mode', 'schemaVersion'] as const;
const CAPABILITY_KEYS = [
  'authenticatedWorkerIngress',
  'batchInitiationPresign',
  'eventRelationalPurge',
  'exportDownloadPresign',
  'legacyMediaCopy',
  'legacyPointerCutover',
  'reservedFinalize',
  'singleInitiationPresign',
  'storedReplayPresign',
] as const;

function hasExactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function validatedReleaseConfig() {
  const candidate: unknown = releaseConfig;
  if (!hasExactKeys(candidate, ROOT_KEYS)
    || candidate.kind !== 'candidary.media-upload-release'
    || candidate.schemaVersion !== 2
    || ![
      'canonical-cutover-disabled',
      'canonical-copy-only',
      'canonical-live',
    ].includes(String(candidate.mode))
    || !hasExactKeys(candidate.capabilities, CAPABILITY_KEYS)
    || candidate.capabilities.singleInitiationPresign !== false
    || candidate.capabilities.batchInitiationPresign !== false
    || candidate.capabilities.storedReplayPresign !== false
    || candidate.capabilities.reservedFinalize !== false
    || candidate.capabilities.exportDownloadPresign !== false) {
    throw new Error('Invalid schema 15 media upload release contract.');
  }
  const copy = candidate.mode === 'canonical-copy-only'
    || candidate.mode === 'canonical-live';
  const live = candidate.mode === 'canonical-live';
  if (candidate.capabilities.authenticatedWorkerIngress !== live
    || candidate.capabilities.legacyMediaCopy !== copy
    || candidate.capabilities.legacyPointerCutover !== live
    || candidate.capabilities.eventRelationalPurge !== live) {
    throw new Error('Media upload release mode and capabilities disagree.');
  }
  return {
    kind: candidate.kind,
    schemaVersion: candidate.schemaVersion,
    mode: candidate.mode as
      | 'canonical-cutover-disabled'
      | 'canonical-copy-only'
      | 'canonical-live',
    capabilities: {
      singleInitiationPresign: false,
      batchInitiationPresign: false,
      storedReplayPresign: false,
      reservedFinalize: false,
      authenticatedWorkerIngress: live,
      legacyMediaCopy: copy,
      legacyPointerCutover: live,
      eventRelationalPurge: live,
      exportDownloadPresign: false,
    },
  } as const;
}

export const mediaUploadRelease = validatedReleaseConfig();

type DynamicMode = 'disabled' | 'copy-only' | 'live';

function testOnlyModeOverride(): DynamicMode | null {
  if (typeof __CANDIDARY_TEST_MEDIA_UPLOAD_RELEASE__ === 'undefined'
    || !__CANDIDARY_TEST_MEDIA_UPLOAD_RELEASE__) return null;
  if (globalThis.__CANDIDARY_TEST_MEDIA_UPLOAD_RELEASE_OVERRIDE__ === false) {
    return 'disabled';
  }
  if (globalThis.__CANDIDARY_TEST_MEDIA_UPLOAD_RELEASE_OVERRIDE__ === 'copy-only') {
    return 'copy-only';
  }
  return 'live';
}

export function workerIngressEnabled(): boolean {
  const override = testOnlyModeOverride();
  return override === null
    ? mediaUploadRelease.capabilities.authenticatedWorkerIngress
    : override === 'live';
}

export function legacyMediaCopyEnabled(): boolean {
  const override = testOnlyModeOverride();
  return override === null
    ? mediaUploadRelease.capabilities.legacyMediaCopy
    : override === 'copy-only' || override === 'live';
}

export function legacyPointerCutoverEnabled(): boolean {
  const override = testOnlyModeOverride();
  return override === null
    ? mediaUploadRelease.capabilities.legacyPointerCutover
    : override === 'live';
}

export function eventRelationalPurgeEnabled(): boolean {
  const override = testOnlyModeOverride();
  return override === null
    ? mediaUploadRelease.capabilities.eventRelationalPurge
    : override === 'live';
}

function requireEnabled(enabled: boolean, message: string): void {
  if (!enabled) throw new Error(message);
}

export function assertWorkerIngressEnabled(): void {
  requireEnabled(
    workerIngressEnabled(),
    'Worker ingress media upload release is disabled.',
  );
}

export function assertLegacyMediaCopyEnabled(): void {
  requireEnabled(
    legacyMediaCopyEnabled(),
    'Legacy media copy is disabled.',
  );
}

export function assertLegacyPointerCutoverEnabled(): void {
  requireEnabled(
    legacyPointerCutoverEnabled(),
    'Legacy media pointer cutover is disabled.',
  );
}

export function assertEventRelationalPurgeEnabled(): void {
  requireEnabled(
    eventRelationalPurgeEnabled(),
    'Event relational purge is disabled by the media upload release contract.',
  );
}

import checkedInConfig from '../config/media-upload-release.json';

const RELEASE_KEYS = ['kind', 'schemaVersion', 'mode', 'capabilities'] as const;
const CAPABILITY_KEYS = [
  'singleInitiationPresign',
  'batchInitiationPresign',
  'storedReplayPresign',
  'reservedFinalize',
  'exportDownloadPresign',
  'authenticatedWorkerIngress',
  'legacyPromotion',
  'eventRelationalPurge',
] as const;

export interface MediaUploadReleaseConfig {
  kind: 'candidary.media-upload-release';
  schemaVersion: 1 | 2;
  mode: 'bridge-disabled' | 'worker-ingress';
  capabilities: Record<(typeof CAPABILITY_KEYS)[number], boolean>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && [...expected].sort().every((key, index) => actual[index] === key);
}

export function parseMediaUploadReleaseConfig(value: unknown): MediaUploadReleaseConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Media upload release config must be an object.');
  }
  const record = value as Record<string, unknown>;
  const capabilities = record.capabilities;
  if (!exactKeys(record, RELEASE_KEYS)
    || record.kind !== 'candidary.media-upload-release'
    || (record.schemaVersion !== 1 && record.schemaVersion !== 2)
    || (record.mode !== 'bridge-disabled' && record.mode !== 'worker-ingress')
    || !capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)
    || !exactKeys(capabilities as Record<string, unknown>, CAPABILITY_KEYS)
    || CAPABILITY_KEYS.some((key) => typeof (capabilities as Record<string, unknown>)[key] !== 'boolean')) {
    throw new Error('Media upload release config is invalid or contains unexpected fields.');
  }
  const parsed = record as unknown as MediaUploadReleaseConfig;
  if (parsed.schemaVersion === 1) {
    if (parsed.mode !== 'bridge-disabled'
      || CAPABILITY_KEYS.some((key) => parsed.capabilities[key] !== false)) {
      throw new Error('Schema-1 media upload release must be the fully disabled bridge.');
    }
  } else if (parsed.mode !== 'worker-ingress'
    || parsed.capabilities.singleInitiationPresign
    || parsed.capabilities.batchInitiationPresign
    || parsed.capabilities.storedReplayPresign
    || parsed.capabilities.reservedFinalize
    || parsed.capabilities.exportDownloadPresign
    || !parsed.capabilities.authenticatedWorkerIngress
    || !parsed.capabilities.legacyPromotion
    || !parsed.capabilities.eventRelationalPurge) {
    throw new Error('Schema-2 media upload release must use Worker ingress and permit guarded purge.');
  }
  return parsed;
}

export const checkedInMediaUploadRelease = parseMediaUploadReleaseConfig(checkedInConfig);

type TestReleaseEnv = {
  APP_ORIGIN: string;
  R2_ACCOUNT_ID: string;
  TEST_MEDIA_UPLOAD_RELEASE_MODE?: string;
};

/**
 * Production always consumes the checked-in, evidence-bound file. The only
 * override keeps the existing schema-14 test corpus meaningful while the
 * bridge candidate is exercised separately; both local sentinels are absent
 * from the production topology and prevent a deploy-time variable override.
 */
export function mediaUploadReleaseForEnv(env: TestReleaseEnv): MediaUploadReleaseConfig {
  if (env.APP_ORIGIN === 'http://localhost'
    && env.R2_ACCOUNT_ID === 'local'
    && env.TEST_MEDIA_UPLOAD_RELEASE_MODE === 'worker-ingress') {
    return parseMediaUploadReleaseConfig({
      kind: 'candidary.media-upload-release',
      schemaVersion: 2,
      mode: 'worker-ingress',
      capabilities: {
        singleInitiationPresign: false,
        batchInitiationPresign: false,
        storedReplayPresign: false,
        reservedFinalize: false,
        exportDownloadPresign: false,
        authenticatedWorkerIngress: true,
        legacyPromotion: true,
        eventRelationalPurge: true,
      },
    });
  }
  return checkedInMediaUploadRelease;
}

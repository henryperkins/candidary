import {
  parseRuntimeReleaseIdentity,
  type RuntimeReleaseIdentity,
} from '../shared/release';

declare const __CANDIDARY_BUILD_SHA__: string;
declare const __CANDIDARY_MIGRATION_MANIFEST_SHA256__: string;

export function resolveRuntimeReleaseIdentity(
  env: { CF_VERSION_METADATA?: WorkerVersionMetadata },
): RuntimeReleaseIdentity | null {
  const metadata = env.CF_VERSION_METADATA;
  return parseRuntimeReleaseIdentity({
    buildSha: typeof __CANDIDARY_BUILD_SHA__ === 'string'
      ? __CANDIDARY_BUILD_SHA__
      : undefined,
    workerVersionId: metadata?.id,
    workerVersionTag: metadata?.tag,
    migrationManifestSha256:
      typeof __CANDIDARY_MIGRATION_MANIFEST_SHA256__ === 'string'
        ? __CANDIDARY_MIGRATION_MANIFEST_SHA256__
        : undefined,
  });
}

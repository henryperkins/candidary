import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { prepareBaselineApp } from './scripts/build-mobile-image-migration.mjs';
import { prepareMobileReleaseTest } from './scripts/prepare-mobile-release-test.mjs';
import { nativeBridge, nativeBridgeEnabled } from './scripts/mobile-image-native-bridge.mjs';

await prepareBaselineApp();
await prepareMobileReleaseTest();

const migrations = await readD1Migrations(
  fileURLToPath(new URL('./migrations', import.meta.url)),
);
const migrationQueries = migrations.flatMap((migration) => migration.queries);
const testBuildSha = '0123456789abcdef0123456789abcdef01234567';
const testMigrationManifestSha256 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

export default defineConfig({
  define: {
    __CANDIDARY_BUILD_SHA__: JSON.stringify(testBuildSha),
    __CANDIDARY_MIGRATION_MANIFEST_SHA256__: JSON.stringify(testMigrationManifestSha256),
    __CANDIDARY_TEST_MEDIA_UPLOAD_RELEASE__: 'true',
    __CANDIDARY_TEST_MOBILE_IMAGE_RELEASE__: 'true',
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: JSON.stringify(migrations),
          TEST_MIGRATION_QUERIES: JSON.stringify(migrationQueries),
          // `http://localhost` because that is the origin Hono's test client
          // actually gives a request made with a bare pathname, which is how most
          // of this suite calls the Worker. Naming any other host as canonical
          // would leave the fixture disagreeing with itself: links are built from
          // the origin a request arrives on, so they would come out on one host
          // while `origin` in `helpers.ts` claimed another.
          APP_ORIGIN: 'http://localhost',
          // Extra front doors, so the suite exercises the multi-origin path
          // rather than a deployment that happens to have exactly one.
          // `tests/worker/origins.test.ts` uses a hostname deliberately absent
          // from both settings to prove the exchange guard still fires.
          ALTERNATE_ORIGINS: 'http://127.0.0.1:4173, https://candidary.test',
          TOKEN_HMAC_KEY: 'test-token-hmac-key-with-at-least-32-bytes',
          SESSION_HMAC_KEY: 'test-session-hmac-key-with-at-least-32-bytes',
          GUEST_TOKEN_ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY',
          LOGIN_HMAC_KEY: 'test-login-hmac-key-with-at-least-32-bytes',
          ENTRY_HMAC_KEY: 'test-entry-hmac-key-with-at-least-32-bytes',
          ENTRY_ENCRYPTION_KEY: 'ZmVkY2JhOTg3NjU0MzIxMGZlZGNiYTk4NzY1NDMyMTA',
          RSVP_LOOKUP_HMAC_KEY: 'test-rsvp-lookup-hmac-key-with-at-least-32-bytes',
          GUEST_MESSAGE_HMAC_KEY: 'test-guest-message-hmac-key-with-at-least-32-bytes',
          ALBUM_SHARE_HMAC_KEY: 'test-album-share-hmac-key-with-at-least-32-bytes',
          ALBUM_SHARE_ENCRYPTION_KEY: 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU',
          EMAIL_FROM: 'hello@candidary.test',
          // '1' only for an explicitly named disposable native container with both
          // ignored real originals present; otherwise that local-integration suite skips.
          MOBILE_IMAGE_NATIVE_BRIDGE_ENABLED: nativeBridgeEnabled() ? '1' : '',
        },
        d1Databases: ['DB'],
        r2Buckets: ['MEDIA_BUCKET', 'CANONICAL_MEDIA_BUCKET'],
        // The main app never starts the private Container worker in its tests.
        // The bridge is a Node test service; it returns 503 unless a disposable local
        // native container is named, and never becomes the app's IMAGE_DECODER binding.
        serviceBindings: { IMAGE_DECODER: async () => new Response(null, { status: 503 }), MOBILE_IMAGE_NATIVE_BRIDGE: nativeBridge },
      },
    }),
  ],
  test: {
    include: ['tests/worker/**/*.test.ts'],
    // Keep workerd, D1, and R2 integration pools within the memory budget used
    // by the local and CI gate runners. Higher concurrency can cancel healthy
    // requests while several isolated runtimes initialize at once.
    maxWorkers: 2,
    // Password hashing is deliberately expensive, and a test that registers and
    // signs in several times spends real time in scrypt rather than waiting on IO.
    testTimeout: 20_000,
  },
});

import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

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
          EMAIL_FROM: 'hello@candidary.test',
        },
        d1Databases: ['DB'],
        r2Buckets: ['MEDIA_BUCKET', 'CANONICAL_MEDIA_BUCKET'],
      },
    }),
  ],
  test: {
    include: ['tests/worker/**/*.test.ts'],
    // Password hashing is deliberately expensive, and a test that registers and
    // signs in several times spends real time in scrypt rather than waiting on IO.
    testTimeout: 20_000,
  },
});

import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const migrations = await readD1Migrations(
  fileURLToPath(new URL('./migrations', import.meta.url)),
);
const migrationQueries = migrations.flatMap((migration) => migration.queries);

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          TEST_MIGRATION_QUERIES: JSON.stringify(migrationQueries),
          APP_ORIGIN: 'http://127.0.0.1:5173',
          TOKEN_HMAC_KEY: 'test-token-hmac-key-with-at-least-32-bytes',
          SESSION_HMAC_KEY: 'test-session-hmac-key-with-at-least-32-bytes',
          GUEST_TOKEN_ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY',
          R2_ACCOUNT_ID: 'local',
          R2_ACCESS_KEY_ID: 'test-r2-access-key',
          R2_SECRET_ACCESS_KEY: 'test-r2-secret-key',
          R2_BUCKET_NAME: 'candidary-media',
        },
        d1Databases: ['DB'],
        r2Buckets: ['MEDIA_BUCKET'],
      },
    }),
  ],
  test: {
    include: ['tests/worker/**/*.test.ts'],
  },
});

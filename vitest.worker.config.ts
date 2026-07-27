import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const migrationSql = [
  './migrations/0001_core.sql',
  './migrations/0002_wedding_photo_drop.sql',
  './migrations/0003_partitioned_exports.sql',
  './migrations/0004_manager_media_pagination.sql',
].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8')).join(';\n');
const migrationQueries = migrationSql
  .split(';')
  .map((query) => query.trim())
  .filter(Boolean);

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

import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const migrationSql = readFileSync(new URL('./migrations/0001_core.sql', import.meta.url), 'utf8');
const migrationQueries = migrationSql
  .split(';')
  .map((query) => query.trim())
  .filter(Boolean);

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: { TEST_MIGRATION_QUERIES: JSON.stringify(migrationQueries) },
        d1Databases: ['DB'],
        r2Buckets: ['MEDIA_BUCKET'],
      },
    }),
  ],
  test: {
    include: ['tests/worker/**/*.test.ts'],
  },
});

import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        d1Databases: ['DB'],
        r2Buckets: ['MEDIA_BUCKET'],
      },
    }),
  ],
  test: {
    include: ['tests/worker/**/*.test.ts'],
  },
});

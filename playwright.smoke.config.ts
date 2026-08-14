import { defineConfig, devices } from '@playwright/test';

export const SMOKE_SERVER_COMMAND = [
  'npx vite preview',
  '--config vite.smoke.config.ts',
  '--outDir dist/client',
  '--host 127.0.0.1',
  '--port 4173',
].join(' ');

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'smoke.spec.ts',
  outputDir: './output/playwright/smoke-results',
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: SMOKE_SERVER_COMMAND,
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});

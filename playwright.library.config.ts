import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: ['library-consolidation.spec.ts', 'manager-navigation-intents.spec.ts', 'manager-mobile-navigation*.spec.ts'],
  outputDir: './output/playwright/library-consolidation/results',
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:4173', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: {
    command: 'npx vite --config vite.library.config.ts --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173', reuseExistingServer: false, timeout: 60000,
  },
});

import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir:'./tests/e2e',testMatch:['mobile-images.spec.ts'],workers:2,
  outputDir:'./output/playwright/mobile-images/results',reporter:[['list']],
  use:{baseURL:'http://127.0.0.1:4173',trace:'retain-on-failure',screenshot:'only-on-failure'},
  projects:['chromium','webkit','firefox'].map(browserName => ({name:browserName,use:{browserName:browserName as 'chromium'|'webkit'|'firefox'}})),
  webServer:{command:'npx vite --config vite.mobile-images.config.ts --host 127.0.0.1 --port 4173 --strictPort',url:'http://127.0.0.1:4173',reuseExistingServer:false,timeout:60_000},
});

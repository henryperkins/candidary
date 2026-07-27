import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './output/playwright/results',
  reporter: [['list'], ['html', { outputFolder: 'output/playwright/report', open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  expect: {
    // Baselines are tracked evidence, so they are compared as captured: no pixel budget, animations
    // stilled, caret hidden, and CSS pixels rather than device pixels so the image belongs to the
    // viewport the test pinned. Snapshot paths keep Playwright's default naming, which carries both
    // the project and the platform — a Linux run reports a missing baseline rather than quietly
    // diffing Windows font rasterisation against it.
    toHaveScreenshot: { animations: 'disabled', caret: 'hide', scale: 'css', maxDiffPixels: 0 },
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } },
      // Every tracked baseline pins its own viewport at 844 px or narrower and is phone or tablet
      // evidence. Running them a second time without touch or mobile viewport emulation would add a
      // second image of a state no visitor is in — and a desktop scrollbar that eats 15 of the 320.
      testIgnore: /visual-qa\.spec\.ts/,
    },
    { name: 'mobile', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: {
    command: 'npm run build && npx vite preview --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});

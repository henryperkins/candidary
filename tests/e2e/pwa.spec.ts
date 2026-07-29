import { expect, test } from '@playwright/test';

import { stubManagerRoutes } from './fixtures/routes';

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose: string;
}

interface WebAppManifest {
  icons: ManifestIcon[];
  start_url?: string;
  id?: string;
}

test('serves the route-preserving manifest and every declared icon with explicit MIME types', async ({ request }) => {
  const response = await request.get('/manifest.webmanifest');

  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('application/manifest+json');

  const manifest = await response.json() as WebAppManifest;
  expect(manifest).not.toHaveProperty('start_url');
  expect(manifest).not.toHaveProperty('id');

  for (const icon of manifest.icons) {
    const iconResponse = await request.get(icon.src);
    expect(iconResponse.status(), icon.src).toBe(200);
    expect(iconResponse.headers()['content-type'], icon.src).toContain('image/png');
  }
});

test('manager documents expose iOS metadata without a prompt or service worker', async ({ page }) => {
  await stubManagerRoutes(page, {
    mediaPages: { first: { media: [], nextCursor: null } },
  });
  await page.goto('/manage/event/event-a');
  await expect(page.getByRole('heading', { name: 'Live intake' })).toBeVisible();

  await expect(page.locator('head link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
  await expect(page.locator('head link[rel="manifest"]')).not.toHaveAttribute('crossorigin', /.+/u);
  await expect(page.locator('head link[rel="apple-touch-icon"]')).toHaveAttribute('href', '/icons/candidary-180.png');
  await expect(page.locator('head link[rel="apple-touch-icon"]')).toHaveAttribute('sizes', '180x180');

  const registrations = await page.evaluate(async () => (
    'serviceWorker' in navigator ? (await navigator.serviceWorker.getRegistrations()).length : 0
  ));
  expect(registrations).toBe(0);
  await expect(page.getByText(/add to home screen/iu)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /add to home screen/iu })).toHaveCount(0);
});

import { expect, test } from '@playwright/test';

test('serves the built application and its install manifest', async ({ page, request }) => {
  await page.goto('/');

  await expect(page).toHaveTitle('Candidary');
  await expect(page.getByRole('heading', {
    name: 'Gather the moments you didn’t see.',
  })).toBeVisible();

  const manifest = await request.get('/manifest.webmanifest');
  expect(manifest.status()).toBe(200);
  await expect(manifest.json()).resolves.toMatchObject({
    name: 'Candidary',
    display: 'standalone',
  });
});

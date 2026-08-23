import { expect, test } from '@playwright/test';

test('serves the robots policy as plain text instead of the SPA shell', async ({ request }) => {
  const response = await request.get('/robots.txt');

  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toMatch(/^text\/plain(?:;|$)/iu);
  const robots = await response.text();
  expect(robots).toContain('Sitemap: https://candidary.app/sitemap.xml');
  expect(robots).toMatch(/^Disallow: \/album$/mu);
});

test('marks the private album document noindex', async ({ page }) => {
  await page.route('**/api/album-share', (route) => route.fulfill({
    status: 410,
    headers: { 'cache-control': 'private, no-store' },
    json: {
      code: 'ALBUM_SHARE_UNAVAILABLE',
      message: 'This album is not available.',
      requestId: 'request-a',
    },
  }));

  await page.goto('/album');

  await expect(page.locator('head meta[name="robots"]'))
    .toHaveAttribute('content', 'noindex, nofollow');
});

test('serves the canonical public-page sitemap as XML instead of the SPA shell', async ({ request }) => {
  const response = await request.get('/sitemap.xml');

  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toMatch(/^application\/xml(?:;|$)/iu);
  expect([...((await response.text()).matchAll(/<loc>([^<]+)<\/loc>/gu))]
    .map((match) => match[1])).toEqual([
    'https://candidary.app/',
    'https://candidary.app/create',
    'https://candidary.app/privacy',
    'https://candidary.app/terms',
  ]);
});

test('negotiates markdown for trailing-slash public page URLs', async ({ request }) => {
  const pages = [
    ['/create/', '# A private home for every point of view.'],
    ['/privacy/', '# Privacy'],
    ['/terms/', '# Terms'],
  ] as const;

  for (const [path, heading] of pages) {
    const response = await request.get(path, {
      headers: { Accept: 'text/markdown' },
    });

    expect(response.status(), `${path} status`).toBe(200);
    expect(response.headers()['content-type'], `${path} content type`)
      .toBe('text/markdown; charset=utf-8');
    expect((await response.text()).startsWith(`${heading}\n`), `${path} heading`).toBe(true);
  }
});

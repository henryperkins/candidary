import { expect, test } from '@playwright/test';

test('serves the robots policy as plain text instead of the SPA shell', async ({ request }) => {
  const response = await request.get('/robots.txt');

  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toMatch(/^text\/plain(?:;|$)/iu);
  expect(await response.text()).toContain('Sitemap: https://candidary.app/sitemap.xml');
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

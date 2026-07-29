import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { createApp } from '../../worker/app';
import type { AppEnv } from '../../worker/env';

const EXPECTED_HSTS = 'max-age=31536000; includeSubDomains';

function testEnv(): AppEnv {
  const assets = {
    fetch: () => Promise.resolve(
      new Response('<div id="root"></div>', { headers: { 'content-type': 'text/html' } }),
    ),
  } as unknown as Fetcher;
  return { ...env, ASSETS: assets } as AppEnv;
}

describe('security header middleware', () => {
  it('sends Strict-Transport-Security over HTTPS', async () => {
    const response = await createApp().request('https://candidary.online/api/does-not-exist', {}, testEnv());
    expect(response.headers.get('strict-transport-security')).toBe(EXPECTED_HSTS);
  });

  it('omits Strict-Transport-Security over plain HTTP', async () => {
    const response = await createApp().request('http://127.0.0.1:5173/api/does-not-exist', {}, testEnv());
    expect(response.headers.get('strict-transport-security')).toBeNull();
  });

  it('sends the header on the SPA fallback served through the ASSETS binding', async () => {
    const response = await createApp().request('https://candidary.online/create', {}, testEnv());
    expect(response.status).toBe(200);
    expect(response.headers.get('strict-transport-security')).toBe(EXPECTED_HSTS);
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
  });

  it('keeps the rest of the header set on every response', async () => {
    const response = await createApp().request('http://127.0.0.1:5173/api/does-not-exist', {}, testEnv());
    expect(response.headers.get('content-security-policy')).toContain(
      "connect-src 'self' https://*.r2.cloudflarestorage.com",
    );
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('permissions-policy')).toBe('camera=(), microphone=(), geolocation=()');
    expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
  });
});

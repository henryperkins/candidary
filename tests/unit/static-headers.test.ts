import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const headersPath = resolve(process.cwd(), 'public/_headers');
const headers = existsSync(headersPath) ? readFileSync(headersPath, 'utf8') : '';
const wranglerConfig = JSON.parse(readFileSync(resolve(process.cwd(), 'wrangler.jsonc'), 'utf8')) as {
  assets?: { run_worker_first?: string[] };
};

describe('static asset security headers', () => {
  it('ships a Cloudflare static asset header manifest', () => {
    expect(existsSync(headersPath)).toBe(true);
  });

  it('matches the Worker security header policy', () => {
    expect(headers).toContain("Content-Security-Policy: default-src 'self'");
    expect(headers).toContain("connect-src 'self' https://*.r2.cloudflarestorage.com");
    expect(headers).toContain('Referrer-Policy: no-referrer');
    expect(headers).toContain('X-Content-Type-Options: nosniff');
    expect(headers).toContain('Permissions-Policy: camera=(), microphone=(), geolocation=()');
    expect(headers).toContain('Cross-Origin-Opener-Policy: same-origin');
  });

  it('routes every clean SPA path through the Worker security middleware', () => {
    const patterns = wranglerConfig.assets?.run_worker_first ?? [];
    expect(patterns).toEqual(expect.arrayContaining(['/create', '/event/*', '/manage/*']));
    expect(patterns).not.toContain('!/manage/event/*');
  });
});

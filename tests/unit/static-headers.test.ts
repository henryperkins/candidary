import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const headersPath = resolve(process.cwd(), 'public/_headers');
const headers = existsSync(headersPath) ? readFileSync(headersPath, 'utf8') : '';
const manifestContentTypeRule =
  /^\/manifest\.webmanifest[ \t]*\r?\n[ \t]+Content-Type: application\/manifest\+json[ \t]*\r?$/mu;
// Parsed as strict JSON on purpose: `wrangler.jsonc` may legally carry comments, but
// this manifest is read by tooling that does not strip them, so it is kept comment-free
// and that is asserted by this file failing loudly if it ever is not.
const wranglerConfig = JSON.parse(readFileSync(resolve(process.cwd(), 'wrangler.jsonc'), 'utf8')) as {
  assets?: { run_worker_first?: string[] };
};

describe('static asset security headers', () => {
  it('ships a Cloudflare static asset header manifest', () => {
    expect(existsSync(headersPath)).toBe(true);
  });

  it('matches the Worker security header policy', () => {
    expect(headers).toContain("Content-Security-Policy: default-src 'self'");
    expect(headers).toContain("script-src 'self'");
    expect(headers).toContain("connect-src 'self' https://*.r2.cloudflarestorage.com");
    expect(headers).toContain('Referrer-Policy: no-referrer');
    expect(headers).toContain('X-Content-Type-Options: nosniff');
    expect(headers).toContain('Permissions-Policy: camera=(), microphone=(), geolocation=()');
    expect(headers).toContain('Cross-Origin-Opener-Policy: same-origin');
    expect(headers).toContain('Strict-Transport-Security: max-age=31536000; includeSubDomains');
  });

  it('serves the manifest with an explicit content type under nosniff', () => {
    expect(headers).toMatch(manifestContentTypeRule);
  });

  it('does not borrow the manifest content type from beyond its header block', () => {
    expect('/manifest.webmanifest\n\n  Content-Type: application/manifest+json')
      .not.toMatch(manifestContentTypeRule);
  });

  it('routes every clean SPA path through the Worker security middleware', () => {
    const patterns = wranglerConfig.assets?.run_worker_first ?? [];
    expect(patterns).toEqual(expect.arrayContaining(['/create', '/event/*', '/manage/*']));
    expect(patterns).toContain('/recover/manage');
    expect(patterns).not.toContain('!/manage/event/*');
  });

  // Every one of these is deep-linkable by definition: recovery email links and every
  // `hostSignInHref` point straight at them, so a host reaches them cold rather than by
  // navigating within an already-loaded SPA. Without an entry here the Worker never
  // runs and `ASSETS.fetch` serves the shell with none of the security headers on it.
  it('routes the host account entry points through it too', () => {
    const patterns = wranglerConfig.assets?.run_worker_first ?? [];
    expect(patterns).toEqual(expect.arrayContaining([
      '/host/login', '/host/register', '/host/events', '/host/verify',
    ]));
  });

  // The site footer links to both from every public page, and a legal page is the kind of URL that
  // gets shared and bookmarked, so both are reached cold rather than from an already-loaded shell.
  it('routes the footer legal pages through it too', () => {
    const patterns = wranglerConfig.assets?.run_worker_first ?? [];
    expect(patterns).toEqual(expect.arrayContaining(['/privacy', '/terms']));
  });
});

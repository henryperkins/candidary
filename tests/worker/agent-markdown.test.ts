import { describe, expect, it } from 'vitest';

import { MAX_EVENT_MEDIA } from '../../shared/constants';
import {
  CREATE_INTRO,
  LANDING_HERO,
  LANDING_QUESTIONS,
  LEGAL_PENDING_NOTE,
  PRIVACY_PAGE,
  SITE_BLURB,
  TERMS_PAGE,
} from '../../shared/site-content';
import { createApp } from '../../worker/app';
import { MARKDOWN_PAGE_PATHS, prefersMarkdown } from '../../worker/http/agent-markdown';
import type { AppEnv } from '../../worker/env';
import { testEnv } from './helpers';

// What Chrome actually sends for a navigation: `text/html` first and a catch-all
// last. That catch-all is the reason a wildcard may never select markdown.
const BROWSER_ACCEPT =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8';
const SHELL = '<!doctype html><html lang="en"><body><div id="root"></div></body></html>';

/**
 * The Worker's asset fallback, stubbed and counted. `ASSETS` is not bound in this
 * pool, and counting it is the point: a page that answered in markdown must never
 * have reached the SPA shell, and a page that answered in HTML must have.
 */
function harness() {
  let shellRequests = 0;
  const env: AppEnv = {
    ...testEnv,
    ASSETS: {
      fetch: async () => {
        shellRequests += 1;
        return new Response(SHELL, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      },
    } as unknown as Fetcher,
  };
  return {
    shellRequests: () => shellRequests,
    request: (path: string, accept: string, method = 'GET') => createApp().request(
      path,
      { method, headers: { Accept: accept } },
      env,
    ),
  };
}

describe('markdown content negotiation', () => {
  it('negotiates exactly the four public pages named in the sitemap', () => {
    expect(MARKDOWN_PAGE_PATHS).toEqual(['/', '/create', '/privacy', '/terms']);
  });

  it('answers the home page in markdown built from the copy the page renders', async () => {
    const harnessed = harness();
    const response = await harnessed.request('/', 'text/markdown');

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
    expect(response.headers.get('Vary')).toBe('Accept');
    expect(Number(response.headers.get('X-Markdown-Tokens'))).toBeGreaterThan(0);
    expect(response.headers.get('Link')).toBe('<https://candidary.app/>; rel="canonical"');
    expect(harnessed.shellRequests()).toBe(0);

    const body = await response.text();
    expect(body.startsWith('# Candidary\n')).toBe(true);
    expect(body).toContain(SITE_BLURB);
    expect(body).toContain(`## ${LANDING_HERO.headline.join(' ')}`);
    expect(body).toContain(LANDING_HERO.lede);
    for (const { question, answer } of LANDING_QUESTIONS) {
      expect(body).toContain(`### ${question}`);
      expect(body).toContain(answer);
    }
  });

  it('answers the create page with the ceilings the upload routes enforce', async () => {
    const response = await harness().request('/create', 'text/markdown');
    const body = await response.text();

    expect(body.startsWith(`# ${CREATE_INTRO.title}\n`)).toBe(true);
    expect(body).toContain(CREATE_INTRO.lede);
    expect(body).toContain(`Up to ${MAX_EVENT_MEDIA.toLocaleString('en-US')} photos or 100 GiB per event`);
    expect(body).toContain('Up to 20 MB per photo');
    expect(body).toContain('image/heic');
    // The cover ceiling is decimal and the media ceilings are binary; the markdown
    // must not quietly convert one into the other.
    expect(body).toContain('An optional cover photo up to 19 MB');
  });

  it.each([
    ['/privacy', PRIVACY_PAGE],
    ['/terms', TERMS_PAGE],
  ] as const)('answers %s with the same commitments the page lists', async (path, page) => {
    const response = await harness().request(path, 'text/markdown');
    const body = await response.text();

    expect(body.startsWith(`# ${page.title}\n`)).toBe(true);
    expect(body).toContain(page.lede);
    for (const fact of page.facts) expect(body).toContain(`- ${fact}`);
    expect(body).toContain(LEGAL_PENDING_NOTE);
  });

  it('keeps the security headers on a negotiated markdown answer', async () => {
    const response = await harness().request('/privacy', 'text/markdown');

    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
  });

  it('returns the negotiated headers without a body for HEAD', async () => {
    const response = await harness().request('/terms', 'text/markdown', 'HEAD');

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
    expect(await response.text()).toBe('');
  });

  it('serves a browser the SPA shell and tells caches the answer varies', async () => {
    const harnessed = harness();
    const response = await harnessed.request('/', BROWSER_ACCEPT);

    expect(await response.text()).toBe(SHELL);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('Vary')?.toLowerCase()).toContain('accept');
    expect(harnessed.shellRequests()).toBe(1);
  });

  it('never negotiates a page outside the public four', async () => {
    for (const path of ['/event/summer-party', '/manage/event/evt_1', '/host/login', '/join']) {
      const response = await harness().request(path, 'text/markdown');
      expect(response.headers.get('Content-Type')).not.toContain('text/markdown');
    }
  });

  it('leaves methods other than GET and HEAD alone', async () => {
    const harnessed = harness();
    const response = await harnessed.request('/create', 'text/markdown', 'POST');

    expect(response.headers.get('Content-Type')).not.toContain('text/markdown');
    expect(harnessed.shellRequests()).toBe(1);
  });

  it('resolves a trailing slash to the same page', async () => {
    const response = await harness().request('/privacy/', 'text/markdown');

    expect(response.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
    expect((await response.text()).startsWith('# Privacy\n')).toBe(true);
  });
});

describe('prefersMarkdown', () => {
  it('requires the client to name markdown itself', () => {
    expect(prefersMarkdown('text/markdown')).toBe(true);
    expect(prefersMarkdown('text/markdown; charset=utf-8')).toBe(true);
    expect(prefersMarkdown('text/x-markdown')).toBe(true);
    expect(prefersMarkdown('TEXT/MARKDOWN')).toBe(true);
    expect(prefersMarkdown('application/json, text/markdown;q=0.9')).toBe(true);
  });

  it('never reads a wildcard, an absent header, or q=0 as consent', () => {
    expect(prefersMarkdown('*/*')).toBe(false);
    expect(prefersMarkdown('text/*')).toBe(false);
    expect(prefersMarkdown(BROWSER_ACCEPT)).toBe(false);
    expect(prefersMarkdown(undefined)).toBe(false);
    expect(prefersMarkdown('')).toBe(false);
    expect(prefersMarkdown('text/markdown;q=0')).toBe(false);
  });

  it('honours the ranking when the client asks for both', () => {
    expect(prefersMarkdown('text/html;q=0.9, text/markdown')).toBe(true);
    expect(prefersMarkdown('text/html, text/markdown;q=0.9')).toBe(false);
    expect(prefersMarkdown('text/html;q=0.8, text/markdown;q=0.8')).toBe(true);
  });
});

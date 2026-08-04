import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { createApp } from '../../worker/app';
import type { AppEnv } from '../../worker/env';
import worker, { CoverBackfillWorkflow, CoverRenderWorkflow, ExportWorkflow } from '../../worker/index';

describe('Worker entrypoint', () => {
  it('exports the fetch handler and every workflow class', () => {
    expect(worker.fetch).toBeTypeOf('function');
    expect(ExportWorkflow).toBeTypeOf('function');
    // A wrangler entry whose class is not exported fails at the build stage, and
    // `cf-typegen` resolves each binding type by the class's exact exported name.
    expect(CoverRenderWorkflow).toBeTypeOf('function');
    expect(CoverBackfillWorkflow).toBeTypeOf('function');
  });

  it('binds both cover workflows', () => {
    expect(env.COVER_RENDER_WORKFLOW).toBeDefined();
    expect(env.COVER_BACKFILL_WORKFLOW).toBeDefined();
  });

  it('serves the SPA for clean manager routes after token exchange', async () => {
    const assets = { fetch: () => Promise.resolve(new Response('<div id="root"></div>', { headers: { 'content-type': 'text/html' } })) } as unknown as Fetcher;
    const response = await createApp().request('/manage/event/event-a', {}, { ...env, ASSETS: assets } as AppEnv);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('<div id="root"></div>');
  });

  it('serves the token-free management recovery shell through Worker security middleware', async () => {
    const assets = { fetch: () => Promise.resolve(new Response('<div id="root"></div>', { headers: { 'content-type': 'text/html' } })) } as unknown as Fetcher;
    const response = await createApp().request('/recover/manage', {}, { ...env, ASSETS: assets } as AppEnv);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await response.text()).toContain('<div id="root"></div>');
  });
});

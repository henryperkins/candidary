import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { createApp } from '../../worker/app';
import type { AppEnv } from '../../worker/env';
import worker, { ExportWorkflow } from '../../worker/index';

describe('Worker entrypoint', () => {
  it('exports the fetch handler and export workflow', () => {
    expect(worker.fetch).toBeTypeOf('function');
    expect(ExportWorkflow).toBeTypeOf('function');
  });

  it('serves the SPA for clean manager routes after token exchange', async () => {
    const assets = { fetch: () => Promise.resolve(new Response('<div id="root"></div>', { headers: { 'content-type': 'text/html' } })) } as unknown as Fetcher;
    const response = await createApp().request('/manage/event/event-a', {}, { ...env, ASSETS: assets } as AppEnv);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('<div id="root"></div>');
  });
});

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act, cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildDeploymentCommandPlan } from '../../scripts/deploy-built';
import { createAppRouter } from '../../src/app/router';

const root = process.cwd();
const fromRoot = (path: string) => resolve(root, path);
const readText = (path: string) => existsSync(fromRoot(path))
  ? readFileSync(fromRoot(path), 'utf8')
  : '';

const expectedManifest = {
  name: 'Candidary',
  short_name: 'Candidary',
  description: 'A private place for guests to deliver event photos.',
  display: 'standalone',
  scope: '/',
  theme_color: '#31170c',
  background_color: '#f7f1e7',
  icons: [
    {
      src: '/icons/candidary-192.png',
      sizes: '192x192',
      type: 'image/png',
      purpose: 'any',
    },
    {
      src: '/icons/candidary-512.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'any',
    },
    {
      src: '/icons/candidary-maskable-512.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'maskable',
    },
  ],
};

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  window.history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('iOS web app metadata', () => {
  it('publishes the exact standalone and Apple document metadata without credential mode', () => {
    const document = new DOMParser().parseFromString(readText('index.html'), 'text/html');

    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#31170c');
    expect(document.querySelector('meta[name="mobile-web-app-capable"]')?.getAttribute('content')).toBe('yes');
    expect(document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.getAttribute('content')).toBe('yes');
    expect(document.querySelector('meta[name="apple-mobile-web-app-title"]')?.getAttribute('content')).toBe('Candidary');
    expect(document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.getAttribute('content')).toBe('default');

    const touchIcon = document.querySelector('link[rel="apple-touch-icon"]');
    expect(touchIcon?.getAttribute('sizes')).toBe('180x180');
    expect(touchIcon?.getAttribute('href')).toBe('/icons/candidary-180.png');

    const manifestLink = document.querySelector('link[rel="manifest"]');
    expect(manifestLink?.getAttribute('href')).toBe('/manifest.webmanifest');
    expect(manifestLink?.hasAttribute('crossorigin')).toBe(false);
  });

  it('keeps the installing route and installation identity implicit in the exact root-scoped manifest', () => {
    const manifestPath = fromRoot('public/manifest.webmanifest');
    expect(existsSync(manifestPath)).toBe(true);

    const manifest = existsSync(manifestPath)
      ? JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
      : {};
    expect(manifest).toEqual(expectedManifest);
    expect(manifest).not.toHaveProperty('start_url');
    expect(manifest).not.toHaveProperty('id');
  });

  it.each([
    ['public/icons/candidary-180.png', 180],
    ['public/icons/candidary-192.png', 192],
    ['public/icons/candidary-512.png', 512],
    ['public/icons/candidary-maskable-512.png', 512],
  ] as const)('checks in a valid opaque-source PNG at %s', (path, size) => {
    const iconPath = fromRoot(path);
    expect(existsSync(iconPath)).toBe(true);

    const icon = existsSync(iconPath) ? readFileSync(iconPath) : Buffer.alloc(24);
    expect([...icon.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(icon.readUInt32BE(16)).toBe(size);
    expect(icon.readUInt32BE(20)).toBe(size);
  });

  it('checks in the reviewed source and repeatable generation and build-verification scripts', () => {
    expect(existsSync(fromRoot('design/assets/candidary-app-icon.svg'))).toBe(true);
    expect(existsSync(fromRoot('scripts/generate-app-icons.mjs'))).toBe(true);
    expect(existsSync(fromRoot('scripts/verify-pwa-build.mjs'))).toBe(true);
    const iconSource = readText('design/assets/candidary-app-icon.svg');
    expect(iconSource).toContain('#4a2415');
    expect(iconSource).toContain('#3f6d95');
    expect(iconSource).not.toMatch(/#42103b|#f3a578/iu);
  });

  it('builds once locally and deploys only the resulting artifact', () => {
    const packageJson = JSON.parse(readText('package.json')) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.deploy)
      .toBe('npm run build:cloudflare && npm run deploy:built');

    const plan = buildDeploymentCommandPlan({
      repositoryRoot: root,
      target: 'production',
      sha: 'a'.repeat(40),
      nodeExecPath: process.execPath,
      wranglerCliPath: fromRoot('node_modules/wrangler/bin/wrangler.js'),
      environment: {},
    });
    expect(plan.map((command) => command.id)).toEqual(['deploy']);
  });
});

describe('installation remains user-initiated and online-only', () => {
  it('loads the application entry without registering a service worker or promoting installation', async () => {
    const register = vi.fn();
    vi.stubGlobal('navigator', { serviceWorker: { register } });
    document.body.innerHTML = '<div id="root"></div>';

    await act(async () => {
      await import('../../src/main');
    });

    expect(register).not.toHaveBeenCalled();
    expect(screen.queryByText(/add to home screen/iu)).not.toBeInTheDocument();
  });

  it('does not add an Add to Home Screen control to the manager surface', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      code: 'SESSION_EXPIRED',
      message: 'Your manager session has expired.',
      requestId: 'request-pwa',
    }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }))));

    render(createElement(RouterProvider, {
      router: createAppRouter(['/manage/event/event-a']),
    }));

    expect(await screen.findByText('Your manager session has expired.')).toBeVisible();
    expect(screen.queryByText(/add to home screen/iu)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add to home screen/iu })).not.toBeInTheDocument();
  });
});

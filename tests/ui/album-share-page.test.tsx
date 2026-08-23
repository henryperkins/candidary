import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import type { PublicAlbumView } from '../../shared/contracts';
import { createAppRouter } from '../../src/app/router';

const TOKEN = 'share-id.share-secret-that-must-not-enter-the-dom';
const SECOND_TOKEN = 'second-share-id.second-share-secret-that-must-not-enter-the-dom';

const album: PublicAlbumView = {
  title: 'The evening',
  description: 'The photographs we kept together.',
  coverMediaId: 'photo-2',
  photoCount: 2,
  entries: [
    { kind: 'section', id: 'ceremony', heading: 'Ceremony' },
    { kind: 'photo', photo: { id: 'photo-1', caption: 'First dance', previewAvailable: true } },
    { kind: 'photo', photo: { id: 'photo-2', caption: null, previewAvailable: true } },
  ],
};

type ReplaceState = (data: unknown, unused: string, url?: string | URL | null) => void;

let replaceState: MockInstance<ReplaceState>;

function success(publicAlbum: PublicAlbumView = album) {
  return Promise.resolve(new Response(
    JSON.stringify({ data: { album: publicAlbum }, requestId: 'request-a' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ));
}

function unavailable() {
  return Promise.resolve(new Response(JSON.stringify({
    code: 'ALBUM_SHARE_UNAVAILABLE',
    message: 'This album is not available.',
    requestId: 'request-a',
  }), { status: 410, headers: { 'content-type': 'application/json' } }));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function renderAlbumRoute() {
  const router = createAppRouter(['/album']);
  return { router, ...render(<RouterProvider router={router} />) };
}

beforeEach(() => {
  window.history.replaceState(null, '', '/album');
  replaceState = vi.spyOn(window.history, 'replaceState');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('public album page', () => {
  it('erases the fragment before exchanging it and never renders the credential', async () => {
    window.location.hash = `#${TOKEN}`;
    const historyState = window.history.state;
    let hashWhenFetched = 'not-called';
    const fetchMock = vi.fn<(path: string, init: RequestInit) => Promise<Response>>(
      () => {
        hashWhenFetched = window.location.hash;
        return success();
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    const view = renderAlbumRoute();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const [path, init] = fetchMock.mock.calls[0]!;
    expect(replaceState).toHaveBeenCalledWith(historyState, '', '/album');
    expect(hashWhenFetched).toBe('');
    expect(path).toBe('/api/album-share/exchange');
    expect(path).not.toContain(TOKEN);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ token: TOKEN });
    expect(view.container.innerHTML).not.toContain('share-secret');
    expect(window.location.hash).toBe('');
  });

  it('reuses the narrow cookie on reload and renders only narrow preview URLs', async () => {
    const fetchMock = vi.fn<(path: string, init: RequestInit) => Promise<Response>>(
      () => success(),
    );
    vi.stubGlobal('fetch', fetchMock);
    const historyState = window.history.state;

    renderAlbumRoute();

    expect(await screen.findByRole('heading', { name: 'The evening' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Ceremony' })).toBeInTheDocument();
    expect(screen.getByText('The photographs we kept together.')).toBeInTheDocument();
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe('/api/album-share');
    expect(init.method).toBeUndefined();
    expect(init.credentials).toBe('same-origin');
    expect(replaceState).toHaveBeenCalledWith(historyState, '', '/album');

    const sources = screen.getAllByRole('img').map((image) => image.getAttribute('src'));
    expect(sources).toEqual([
      '/api/album-share/media/photo-2/preview',
      '/api/album-share/media/photo-1/preview',
      '/api/album-share/media/photo-2/preview',
    ]);
    expect(sources.join(' ')).not.toContain('/api/media/');
  });

  it('marks the album document noindex only while the private route is mounted', async () => {
    vi.stubGlobal('fetch', vi.fn(() => success()));
    const { router } = renderAlbumRoute();

    expect(document.head.querySelector('meta[name="robots"]'))
      .toHaveAttribute('content', 'noindex, nofollow');

    await act(async () => router.navigate('/'));
    expect(document.head.querySelector('meta[name="robots"]')).toBeNull();
  });

  it('consumes and clears a share fragment added after the album route is already mounted', async () => {
    const fetchMock = vi.fn<(path: string, init: RequestInit) => Promise<Response>>()
      .mockImplementationOnce(() => unavailable())
      .mockImplementationOnce(() => success());
    vi.stubGlobal('fetch', fetchMock);
    const { router } = renderAlbumRoute();
    await screen.findByRole('heading', { name: 'This album is not available.' });

    await act(async () => router.navigate(`/album#${TOKEN}`));

    expect(await screen.findByRole('heading', { name: 'The evening' })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [path, init] = fetchMock.mock.calls[1]!;
    expect(path).toBe('/api/album-share/exchange');
    expect(JSON.parse(String(init.body))).toEqual({ token: TOKEN });
    expect(window.location.hash).toBe('');
    expect(document.documentElement.innerHTML).not.toContain(TOKEN);
  });

  it('keeps a newer fragment result when an older exchange settles last', async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const fetchMock = vi.fn<(path: string, init: RequestInit) => Promise<Response>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    vi.stubGlobal('fetch', fetchMock);
    window.location.hash = `#${TOKEN}`;
    const { router } = renderAlbumRoute();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await act(async () => router.navigate(`/album#${SECOND_TOKEN}`));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const newerAlbum = { ...album, title: 'The newer evening' };
    second.resolve(await success(newerAlbum));
    expect(await screen.findByRole('heading', { name: newerAlbum.title })).toBeInTheDocument();

    await act(async () => {
      first.resolve(await success({ ...album, title: 'The stale evening' }));
      await first.promise;
    });
    expect(screen.getByRole('heading', { name: newerAlbum.title })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'The stale evening' })).not.toBeInTheDocument();
  });

  it('replays an erased fragment exchange during StrictMode effect verification', async () => {
    const firstExchange = deferred<Response>();
    let exchangeCalls = 0;
    const fetchMock = vi.fn<(path: string, init: RequestInit) => Promise<Response>>(
      (path) => {
        if (path !== '/api/album-share/exchange') return unavailable();
        exchangeCalls += 1;
        return exchangeCalls === 1 ? firstExchange.promise : success();
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    window.location.hash = `#${TOKEN}`;
    const router = createAppRouter(['/album']);

    render(<StrictMode><RouterProvider router={router} /></StrictMode>);

    expect(await screen.findByRole('heading', { name: album.title })).toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/album-share/exchange',
      '/api/album-share/exchange',
    ]);
  });

  it('announces the ready album through the live region that existed while loading', async () => {
    const pending = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => pending.promise));
    renderAlbumRoute();

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveAttribute('aria-atomic', 'true');

    pending.resolve(await success());
    await screen.findByRole('heading', { name: album.title });
    expect(screen.getByRole('status')).toBe(status);
    expect(status).toHaveTextContent(`${album.title} is ready. 2 photos.`);
  });

  it('announces an exchange refusal through the live region that existed while loading', async () => {
    const pending = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => pending.promise));
    window.location.hash = `#${TOKEN}`;
    renderAlbumRoute();

    const status = screen.getByRole('status');
    pending.resolve(await unavailable());
    await screen.findByRole('heading', { name: 'This album is not available.' });

    expect(screen.getByRole('status')).toBe(status);
    expect(status).toHaveTextContent('This album is not available.');
  });

  it('keeps accessible image identity for initial and failed preview fallbacks', async () => {
    vi.stubGlobal('fetch', vi.fn(() => success({
      ...album,
      entries: album.entries.map((entry) => entry.kind === 'photo' && entry.photo.id === 'photo-2'
        ? { ...entry, photo: { ...entry.photo, previewAvailable: false } }
        : entry),
    })));
    renderAlbumRoute();
    await screen.findByRole('heading', { name: 'The evening' });
    const cover = screen.getByRole('img', { name: 'Cover for The evening' });
    const captionedPhoto = screen.getByRole('img', { name: 'First dance' });

    fireEvent.error(cover);
    fireEvent.error(captionedPhoto);

    expect(screen.getByRole('img', { name: 'Cover for The evening' }).tagName).toBe('DIV');
    expect(screen.getByRole('img', { name: 'First dance' }).tagName).toBe('DIV');
    expect(screen.getByRole('img', { name: 'Album photo 2' }).tagName).toBe('DIV');
    expect(screen.getAllByText('Preview unavailable')).toHaveLength(3);
  });

  it('uses the stable photo position for a loaded preview with an empty caption', async () => {
    vi.stubGlobal('fetch', vi.fn(() => success({
      ...album,
      entries: album.entries.map((entry) => entry.kind === 'photo' && entry.photo.id === 'photo-1'
        ? { ...entry, photo: { ...entry.photo, caption: '' } }
        : entry),
    })));

    renderAlbumRoute();

    expect(await screen.findByRole('img', { name: 'Album photo 1' })).toHaveAttribute(
      'src',
      '/api/album-share/media/photo-1/preview',
    );
  });

  it('uses stable photo positions for unavailable and failed previews with whitespace captions', async () => {
    vi.stubGlobal('fetch', vi.fn(() => success({
      ...album,
      entries: album.entries.map((entry) => entry.kind === 'photo'
        ? {
            ...entry,
            photo: {
              ...entry.photo,
              caption: entry.photo.id === 'photo-1' ? '   ' : '\t',
              previewAvailable: entry.photo.id === 'photo-1',
            },
          }
        : entry),
    })));
    renderAlbumRoute();
    await screen.findByRole('heading', { name: 'The evening' });
    const loadedPhoto = document.querySelector<HTMLImageElement>(
      'img[src="/api/album-share/media/photo-1/preview"]',
    );
    expect(loadedPhoto).not.toBeNull();

    fireEvent.error(loadedPhoto!);

    expect(screen.getByRole('img', { name: 'Album photo 1' }).tagName).toBe('DIV');
    expect(screen.getByRole('img', { name: 'Album photo 2' }).tagName).toBe('DIV');
  });

  it('shows one non-enumerating unavailable state for an exchange refusal', async () => {
    window.location.hash = `#${TOKEN}`;
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      code: 'ALBUM_SHARE_UNAVAILABLE',
      message: 'This album is not available.',
      requestId: 'request-a',
    }), { status: 410, headers: { 'content-type': 'application/json' } }))));

    renderAlbumRoute();

    expect(await screen.findByRole('heading', { name: 'This album is not available.' }))
      .toBeInTheDocument();
    expect(document.body.textContent).toMatch(/ask the host for a new link/iu);
    expect(document.body.textContent).not.toMatch(/invalid|expired|revoked|deleted|secret/iu);
  });
});

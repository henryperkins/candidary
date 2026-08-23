import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import type { PublicAlbumView } from '../../shared/contracts';
import { createAppRouter } from '../../src/app/router';

const TOKEN = 'share-id.share-secret-that-must-not-enter-the-dom';

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

function renderAlbumRoute() {
  return render(<RouterProvider router={createAppRouter(['/album'])} />);
}

beforeEach(() => {
  window.location.hash = '';
  replaceState = vi.spyOn(window.history, 'replaceState').mockImplementation(
    (_data, _title, url) => {
      if (!String(url ?? '').includes('#')) window.location.hash = '';
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('public album page', () => {
  it('erases the fragment before exchanging it and never renders the credential', async () => {
    window.location.hash = `#${TOKEN}`;
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
    expect(replaceState).toHaveBeenCalledWith(null, '', '/album');
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

    renderAlbumRoute();

    expect(await screen.findByRole('heading', { name: 'The evening' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Ceremony' })).toBeInTheDocument();
    expect(screen.getByText('The photographs we kept together.')).toBeInTheDocument();
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe('/api/album-share');
    expect(init.method).toBeUndefined();
    expect(init.credentials).toBe('same-origin');
    expect(replaceState).toHaveBeenCalledWith(null, '', '/album');

    const sources = screen.getAllByRole('img').map((image) => image.getAttribute('src'));
    expect(sources).toEqual([
      '/api/album-share/media/photo-2/preview',
      '/api/album-share/media/photo-1/preview',
      '/api/album-share/media/photo-2/preview',
    ]);
    expect(sources.join(' ')).not.toContain('/api/media/');
  });

  it('keeps a failed preview local to that photo', async () => {
    vi.stubGlobal('fetch', vi.fn(() => success()));
    renderAlbumRoute();
    await screen.findByRole('heading', { name: 'The evening' });
    const images = screen.getAllByRole('img');

    fireEvent.error(images[1]!);

    expect(screen.getByText('Preview unavailable')).toBeInTheDocument();
    expect(screen.getAllByRole('img')).toHaveLength(2);
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

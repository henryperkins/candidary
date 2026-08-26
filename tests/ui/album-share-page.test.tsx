import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import type { PublicAlbumView } from '../../shared/contracts';
import { createAppRouter } from '../../src/app/router';
import { AlbumPreview } from '../../src/features/gallery/AlbumPreview';
import { publicAlbumPreview } from '../../src/features/gallery/album-share-api';
import { PublicAlbum } from '../../src/features/gallery/PublicAlbum';

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

describe('shared public album renderer', () => {
  it('uses page and embedded landmarks and heading depths for the same album', () => {
    const page = render(
      <PublicAlbum album={album} imageSource={publicAlbumPreview} variant="page" />,
    );
    const embedded = render(
      <PublicAlbum album={album} imageSource={publicAlbumPreview} variant="embedded" />,
    );

    expect(page.container.querySelector('main.public-album > header h1'))
      .toHaveTextContent('The evening');
    expect(page.container.querySelector('main.public-album h2'))
      .toHaveTextContent('Ceremony');
    expect(embedded.container.querySelector('section.public-album > header h3'))
      .toHaveTextContent('The evening');
    expect(embedded.container.querySelector('section.public-album h4'))
      .toHaveTextContent('Ceremony');
  });

  it('keeps cover, copy, count, photo order, captions, and fallback labels identical', () => {
    const projection: PublicAlbumView = {
      ...album,
      entries: album.entries.map((entry) => entry.kind === 'photo' && entry.photo.id === 'photo-2'
        ? { ...entry, photo: { ...entry.photo, previewAvailable: false } }
        : entry),
    };
    const imageSource = (mediaId: string) => `/authorized-album/${mediaId}`;
    const page = render(
      <PublicAlbum album={projection} imageSource={imageSource} variant="page" />,
    );
    const embedded = render(
      <PublicAlbum album={projection} imageSource={imageSource} variant="embedded" />,
    );

    for (const view of [page, embedded]) {
      const albumView = within(view.container);
      expect(albumView.getByRole('img', { name: 'Cover for The evening' }))
        .toHaveAttribute('src', '/authorized-album/photo-2');
      expect(albumView.getByText('The photographs we kept together.')).toBeInTheDocument();
      expect(albumView.getByText('2 photos')).toBeInTheDocument();
      const photos = within(view.container.querySelector('.public-album__photos')!);
      expect(photos.getAllByRole('img').map((image) => (
        image.getAttribute('alt') ?? image.getAttribute('aria-label')
      ))).toEqual(['First dance', 'Album photo 2']);
      expect(Array.from(view.container.querySelectorAll('figcaption'), ({ textContent }) => textContent))
        .toEqual(['First dance']);
      expect(photos.getByRole('img', { name: 'Album photo 2' }).tagName).toBe('DIV');

      fireEvent.error(photos.getByRole('img', { name: 'First dance' }));
      expect(photos.getByRole('img', { name: 'First dance' }).tagName).toBe('DIV');
      expect(photos.getAllByText('Preview unavailable')).toHaveLength(2);
    }
  });

  it('omits leading, adjacent, and trailing empty section headings in both variants', () => {
    const projection: PublicAlbumView = {
      ...album,
      entries: [
        { kind: 'section', id: 'leading-empty', heading: 'Leading empty' },
        { kind: 'section', id: 'ceremony', heading: 'Ceremony' },
        { kind: 'photo', photo: { id: 'photo-1', caption: 'First dance', previewAvailable: true } },
        { kind: 'section', id: 'adjacent-empty', heading: 'Adjacent empty' },
        { kind: 'section', id: 'portraits', heading: 'Portraits' },
        { kind: 'photo', photo: { id: 'photo-2', caption: null, previewAvailable: true } },
        { kind: 'section', id: 'trailing-empty', heading: 'Trailing empty' },
      ],
    };
    const page = render(
      <PublicAlbum album={projection} imageSource={publicAlbumPreview} variant="page" />,
    );
    const embedded = render(
      <PublicAlbum album={projection} imageSource={publicAlbumPreview} variant="embedded" />,
    );

    for (const view of [page, embedded]) {
      expect(Array.from(
        view.container.querySelectorAll('.public-album__section'),
        ({ textContent }) => textContent,
      )).toEqual(['Ceremony', 'Portraits']);
      expect(within(view.container).queryByText('Leading empty')).not.toBeInTheDocument();
      expect(within(view.container).queryByText('Adjacent empty')).not.toBeInTheDocument();
      expect(within(view.container).queryByText('Trailing empty')).not.toBeInTheDocument();
    }
  });

  it('keeps title, description, zero count, and the intentional empty state in both variants', () => {
    const projection: PublicAlbumView = {
      title: 'Nothing yet',
      description: 'Photos are on their way.',
      coverMediaId: null,
      photoCount: 0,
      entries: [],
    };
    const page = render(
      <PublicAlbum album={projection} imageSource={publicAlbumPreview} variant="page" />,
    );
    const embedded = render(
      <PublicAlbum album={projection} imageSource={publicAlbumPreview} variant="embedded" />,
    );

    expect(within(page.container).getByRole('heading', { level: 1, name: 'Nothing yet' }))
      .toBeInTheDocument();
    expect(within(embedded.container).getByRole('heading', { level: 3, name: 'Nothing yet' }))
      .toBeInTheDocument();
    for (const view of [page, embedded]) {
      const albumView = within(view.container);
      expect(albumView.getByText('Photos are on their way.')).toBeInTheDocument();
      expect(albumView.getByText('0 photos')).toBeInTheDocument();
      expect(albumView.getByText('No photos in this Album yet.')).toBeInTheDocument();
    }
  });
});

describe('public album page', () => {
  it('erases the fragment before exchanging it and never renders the credential', async () => {
    window.history.pushState(null, '', '/album?source=email');
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
    expect(replaceState).toHaveBeenCalledWith(historyState, '', '/album?source=email');
    expect(hashWhenFetched).toBe('');
    expect(path).toBe('/api/album-share/exchange');
    expect(path).not.toContain(TOKEN);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ token: TOKEN });
    expect(view.container.innerHTML).not.toContain('share-secret');
    expect(window.location.hash).toBe('');
    expect(window.location.search).toBe('?source=email');
  });

  it('reuses the narrow cookie on reload and renders only narrow preview URLs', async () => {
    window.history.pushState(null, '', '/album?source=email');
    replaceState.mockClear();
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
    expect(replaceState).not.toHaveBeenCalled();
    expect(window.location.search).toBe('?source=email');

    const sources = screen.getAllByRole('img').map((image) => image.getAttribute('src'));
    expect(sources).toEqual([
      '/api/album-share/media/photo-2/preview',
      '/api/album-share/media/photo-1/preview',
      '/api/album-share/media/photo-2/preview',
    ]);
    expect(sources.join(' ')).not.toContain('/api/media/');
    expect(sources.join(' ')).not.toContain('/api/manage/');
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

  it('resets a failed cover when the album chooses a different cover photo', () => {
    const view = render(
      <PublicAlbum album={album} imageSource={publicAlbumPreview} variant="page" />,
    );
    fireEvent.error(screen.getByRole('img', { name: 'Cover for The evening' }));
    expect(screen.getByRole('img', { name: 'Cover for The evening' }).tagName).toBe('DIV');

    view.rerender(
      <PublicAlbum
        album={{ ...album, coverMediaId: 'photo-1' }}
        imageSource={publicAlbumPreview}
        variant="page"
      />,
    );

    const replacement = screen.getByRole('img', { name: 'Cover for The evening' });
    expect(replacement.tagName).toBe('IMG');
    expect(replacement).toHaveAttribute('src', '/api/album-share/media/photo-1/preview');
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

describe('manager album preview', () => {
  const EVENT_ID = 'event-1';

  function renderPreview() {
    return render(<AlbumPreview eventId={EVENT_ID} />);
  }

  it('reads the manager projection and never the recipient credential routes', async () => {
    const fetchMock = vi.fn<(path: string, init: RequestInit) => Promise<Response>>(
      () => success(),
    );
    vi.stubGlobal('fetch', fetchMock);

    renderPreview();

    expect(await screen.findByRole('heading', { name: 'The evening' })).toBeInTheDocument();
    expect(screen.getByText('What people with the Album link see')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Ceremony' })).toBeInTheDocument();

    const paths = fetchMock.mock.calls.map(([path]) => path);
    expect(paths).toEqual([`/api/manage/events/${EVENT_ID}/album/preview`]);
    expect(paths.join(' ')).not.toContain('/api/album-share');
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.method).toBeUndefined();
    expect(init.credentials).toBe('same-origin');

    const sources = screen.getAllByRole('img').map((image) => image.getAttribute('src'));
    expect(sources).toEqual([
      `/api/manage/events/${EVENT_ID}/album/media/photo-2/preview`,
      `/api/manage/events/${EVENT_ID}/album/media/photo-1/preview`,
      `/api/manage/events/${EVENT_ID}/album/media/photo-2/preview`,
    ]);
    expect(sources.join(' ')).not.toContain('/api/album-share');
    expect(document.body.innerHTML).not.toContain('/api/album-share');
    expect(document.body.textContent).not.toMatch(/copy album link|stop sharing/iu);
  });

  it('keeps the manager landmark single and stays out of the page heading level', async () => {
    vi.stubGlobal('fetch', vi.fn(() => success()));
    const { container } = renderPreview();

    await screen.findByRole('heading', { name: 'The evening' });
    expect(container.querySelector('main')).toBeNull();
    expect(container.querySelector('section.public-album > header h3'))
      .toHaveTextContent('The evening');
    expect(container.querySelector('section.public-album h4')).toHaveTextContent('Ceremony');
  });

  it('shows an intentional empty state for a zero-photo album rather than a failure', async () => {
    const fetchMock = vi.fn<(path: string, init: RequestInit) => Promise<Response>>(
      () => success({
        title: 'Nothing yet',
        description: 'Photos are on their way.',
        coverMediaId: null,
        photoCount: 0,
        entries: [],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const announcements: string[] = [];

    render(<AlbumPreview
      eventId={EVENT_ID}
      onAnnouncement={(message) => announcements.push(message)}
    />);

    expect(await screen.findByRole('heading', { level: 3, name: 'Nothing yet' }))
      .toBeInTheDocument();
    expect(screen.getByText('Photos are on their way.')).toBeInTheDocument();
    expect(screen.getByText('0 photos')).toBeInTheDocument();
    expect(screen.getByText('No photos in this Album yet.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(announcements).toEqual(['Album preview ready. No photos are In Album yet.']);
    expect(fetchMock.mock.calls.map(([path]) => path))
      .toEqual([`/api/manage/events/${EVENT_ID}/album/preview`]);
  });

  it('opens before sharing was ever enabled and after sharing was stopped', async () => {
    const fetchMock = vi.fn<(path: string, init: RequestInit) => Promise<Response>>(
      () => success(),
    );
    vi.stubGlobal('fetch', fetchMock);

    const first = renderPreview();
    await screen.findByRole('heading', { name: 'The evening' });
    first.unmount();

    renderPreview();
    await screen.findByRole('heading', { name: 'The evening' });

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      `/api/manage/events/${EVENT_ID}/album/preview`,
      `/api/manage/events/${EVENT_ID}/album/preview`,
    ]);
    expect(fetchMock.mock.calls.some(([path]) => path.includes('/share'))).toBe(false);
  });

  it('offers one retry for a retryable preview failure and adopts the album it returns', async () => {
    const fetchMock = vi.fn<(path: string, init: RequestInit) => Promise<Response>>()
      .mockImplementationOnce(() => Promise.resolve(new Response(JSON.stringify({
        code: 'INTERNAL_ERROR',
        message: 'The Album preview could not be loaded.',
        requestId: 'request-a',
      }), { status: 500, headers: { 'content-type': 'application/json' } })))
      .mockImplementationOnce(() => success());
    vi.stubGlobal('fetch', fetchMock);

    renderPreview();

    expect(await screen.findByRole('alert'))
      .toHaveTextContent('The Album preview could not be loaded.');

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('heading', { name: 'The evening' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('adopts one preview and announces once through StrictMode effect verification', async () => {
    const fetchMock = vi.fn<(path: string, init: RequestInit) => Promise<Response>>(
      () => success(),
    );
    vi.stubGlobal('fetch', fetchMock);
    const announcements: string[] = [];

    render(<StrictMode>
      <AlbumPreview
        eventId={EVENT_ID}
        onAnnouncement={(message) => announcements.push(message)}
      />
    </StrictMode>);

    expect(await screen.findByRole('heading', { name: 'The evening' })).toBeInTheDocument();
    expect(announcements).toEqual(['Album preview ready. 2 photos.']);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      `/api/manage/events/${EVENT_ID}/album/preview`,
      `/api/manage/events/${EVENT_ID}/album/preview`,
    ]);
  });

  it('reports the preview through the manager announcement channel it was given', async () => {
    vi.stubGlobal('fetch', vi.fn(() => success()));
    const announcements: string[] = [];

    render(<AlbumPreview
      eventId={EVENT_ID}
      onAnnouncement={(message) => announcements.push(message)}
    />);

    await screen.findByRole('heading', { name: 'The evening' });
    expect(announcements).toEqual(['Album preview ready. 2 photos.']);
    expect(document.querySelectorAll('[role="status"]')).toHaveLength(0);
  });
});

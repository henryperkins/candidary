import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCallback, useLayoutEffect, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';

import type { EventView, ManagerGalleryMediaView } from '../../shared/contracts';
import { DEFAULT_GUESTBOOK_PROMPT } from '../../shared/constants';
import { resolveEventTheme } from '../../shared/event-theme';
import {
  ManagerGalleryWorkspace,
  type GalleryAudienceAuthority,
} from '../../src/features/gallery/ManagerGalleryWorkspace';
import type { ExportCurrentSource } from '../../src/features/gallery/export-control-status';
import type { ExportDownloadView, ExportView, MediaView } from '../../src/app/types';
import {
  ManagerUndoBar,
  ManagerUndoProvider,
} from '../../src/features/gallery/undo';

function success(data: unknown) {
  return Promise.resolve(new Response(JSON.stringify({ data, requestId: 'request-a' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
}

function failure(code = 'INTERNAL_ERROR', message = 'The manager action could not be completed.', status = 503) {
  return Promise.resolve(new Response(JSON.stringify({ code, message, requestId: 'request-a' }), {
    status,
    headers: { 'content-type': 'application/json' },
  }));
}

const event: EventView = {
  id: 'event-a',
  slug: 'maya-theo',
  name: 'Maya & Theo',
  eventDate: '2026-09-19',
  welcomeMessage: 'Welcome.',
  guestbookPrompt: DEFAULT_GUESTBOOK_PROMPT,
  cover: {
    config: { version: 1, source: { kind: 'none' } },
    revision: 0,
    hasCover: false,
    available2xProfiles: [],
    surfaceTreatment: 'none',
    preparation: null,
  },
  uploadsEnabled: true,
  galleryVisible: true,
  moderationRequired: true,
  reservedMediaCount: 0,
  storedMediaCount: 842,
  reservedBytes: 0,
  storedBytes: 1024, recoverableMediaCount: 0, recoverableBytes: 0,
  guestAccessExpiresAt: '2026-10-19T00:00:00Z',
  managementAccessExpiresAt: '2026-12-18T00:00:00Z',
  purgeAfter: '2027-01-17T00:00:00Z',
  createdAt: '2026-08-01T00:00:00Z',
  deletedAt: null,
  eventTimezone: 'America/Chicago',
  eventStartAt: '2026-09-19T22:00:00.000Z',
  eventStartTime: '17:00',
  photosOpen: true,
  photoIntakeState: 'open',
  photoIntakeRecheckAfterMs: null,
  rsvpEnabled: false,
  rsvpDeadlineAt: null,
  rsvpDeadlineDate: null,
  rsvpRosterVersion: 0,
  theme: resolveEventTheme({ version: 1, presetId: 'candidary-default', overrides: {} }),
};

function photo(id: string, timelineAt: string, overrides: Partial<ManagerGalleryMediaView> = {}): ManagerGalleryMediaView {
  return {
    id,
    originalFilename: `${id}.jpg`,
    guestName: 'Jose',
    caption: null,
    publicationStatus: 'unpublished',
    previewAvailable: true,
    width: null,
    height: null,
    receivedAt: timelineAt,
    timelineAt,
    timelineSource: 'received',
    isFavorite: false,
    ...overrides,
  };
}

const rows: ManagerGalleryMediaView[] = [
  photo('p1', '2026-08-15T22:42:00.000Z', { caption: 'First dance' }),
  photo('p2', '2026-08-15T23:18:00.000Z'),
  photo('p3', '2026-08-16T04:48:00.000Z', { guestName: 'Maya' }),
  photo('p4', '2026-08-16T05:24:00.000Z', { isFavorite: true }),
];

function gallerySummary(galleryRows: ManagerGalleryMediaView[] = rows, guestGalleryVisible = true) {
  return success({
    summary: {
      albumPhotoCount: galleryRows.filter((item) => item.isFavorite).length,
      albumEntryCount: galleryRows.filter((item) => item.isFavorite).length,
      albumLink: { active: false, sharedAt: null },
      guestGalleryVisible,
      guestGalleryPublishedCount: galleryRows.filter((item) => item.publicationStatus === 'published').length,
    },
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function managerFetch(overrides: {
  galleryRows?: ManagerGalleryMediaView[];
  favoriteFails?: boolean;
  nextCursor?: string | null;
  guestGalleryVisible?: boolean;
} = {}) {
  const galleryRows = overrides.galleryRows ?? rows.map((item) => ({ ...item }));
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'https://candidary.test');
    const method = init?.method ?? 'GET';
    if (url.pathname === '/api/manage/events/event-a/gallery' && method === 'GET') {
      const query = url.searchParams.get('query');
      const favorites = url.searchParams.get('favorites') === '1';
      let result = galleryRows;
      if (query) result = result.filter((item) => (
        item.guestName.toLowerCase().includes(query.toLowerCase())
        || (item.caption ?? '').toLowerCase().includes(query.toLowerCase())
        || item.originalFilename.toLowerCase().includes(query.toLowerCase())
      ));
      if (favorites) result = result.filter((item) => item.isFavorite);
      return success({ media: result, nextCursor: overrides.nextCursor ?? null });
    }
    if (url.pathname === '/api/manage/events/event-a/gallery/summary' && method === 'GET') {
      return gallerySummary(galleryRows, overrides.guestGalleryVisible);
    }
    if (url.pathname === '/api/manage/events/event-a/album' && method === 'GET') {
      const picked = galleryRows.filter((item) => item.isFavorite);
      return success({
        album: {
          revision: 0,
          saved: picked.length === 0,
          entries: picked.map((photo) => ({ kind: 'photo', photo })),
          photoCount: picked.length,
          sectionCount: 0,
        },
      });
    }
    if (url.pathname === '/api/manage/events/event-a/album/picks' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { mediaIds: string[]; picked: boolean };
      const changed = galleryRows.filter((item) => (
        body.mediaIds.includes(item.id) && item.isFavorite !== body.picked
      ));
      for (const item of changed) item.isFavorite = body.picked;
      return success({ changed: changed.map((item) => ({ ...item })) });
    }
    if (url.pathname.endsWith('/favorite') && method === 'PUT') {
      if (overrides.favoriteFails) return failure();
      const id = url.pathname.split('/').at(-2);
      const item = galleryRows.find((candidate) => candidate.id === id);
      const body = JSON.parse(String(init?.body)) as { favorite: boolean };
      if (item) item.isFavorite = body.favorite;
      return success({ media: { ...item, isFavorite: body.favorite } });
    }
    throw new Error(`Unexpected request ${method} ${url.pathname}${url.search}`);
  });
}

const noop = () => Promise.resolve();

function audienceAuthority(
  galleryRows: ManagerGalleryMediaView[] = rows,
  guestGalleryVisible = true,
): GalleryAudienceAuthority {
  return {
    summary: {
      albumPhotoCount: galleryRows.filter((item) => item.isFavorite).length,
      albumEntryCount: galleryRows.filter((item) => item.isFavorite).length,
      albumLink: { active: false, sharedAt: null },
      guestGalleryVisible,
      guestGalleryPublishedCount: galleryRows.filter((item) => item.publicationStatus === 'published').length,
    },
    freshness: 'fresh',
    failure: null,
    reload: noop,
    invalidate: vi.fn(),
  };
}

interface GalleryRenderOverrides {
  galleryRows?: ManagerGalleryMediaView[];
  nextCursor?: string | null;
  favoriteFails?: boolean;
  exportJob?: ExportView;
  exportDownload?: ExportDownloadView;
  currentSource?: ExportCurrentSource;
  onPrepare?: () => Promise<void>;
  status?: 'all' | 'unpublished' | 'published' | 'hidden';
  onGalleryInvalidated?: () => void;
  audience?: GalleryAudienceAuthority;
}

function renderGalleryWithFetch(
  fetchMock: ReturnType<typeof vi.fn>,
  overrides: GalleryRenderOverrides = {},
) {
  const implementation = fetchMock.getMockImplementation();
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'https://candidary.test');
    const method = init?.method ?? 'GET';
    if (url.pathname === '/api/manage/events/event-a/gallery/summary' && method === 'GET') {
      return gallerySummary(overrides.galleryRows);
    }
    if (!implementation) throw new Error(`Unexpected request ${method} ${url.pathname}${url.search}`);
    return (implementation as (request: RequestInfo | URL, options?: RequestInit) => unknown)(input, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  const onPrepare = overrides.onPrepare ?? vi.fn(noop);
  const onStatusChange = vi.fn();
  const onGalleryInvalidated = overrides.onGalleryInvalidated ?? vi.fn();
  const authority = overrides.audience ?? audienceAuthority(overrides.galleryRows);
  function TestGalleryOwner({ workspaceMounted }: { workspaceMounted: boolean }) {
    const [announcement, setAnnouncement] = useState('');
    const [galleryMutationEpoch, setGalleryMutationEpoch] = useState(0);
    const invalidateGalleryAfterMutation = useCallback(() => {
      onGalleryInvalidated();
      setGalleryMutationEpoch((current) => current + 1);
    }, []);
    const [liveHost] = useState(() => {
      const element = document.createElement('div');
      element.dataset.galleryLiveHost = 'true';
      return element;
    });
    useLayoutEffect(() => {
      document.body.append(liveHost);
      return () => { liveHost.remove(); };
    }, [liveHost]);
    return <>
      {createPortal(
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>,
        liveHost,
      )}
      {workspaceMounted && <ManagerGalleryWorkspace
        event={event}
        eventId="event-a"
        galleryMutationEpoch={galleryMutationEpoch}
        invalidateGalleryAfterMutation={invalidateGalleryAfterMutation}
        audience={authority}
        onAnnouncement={setAnnouncement}
        shared={{
          media: [],
          status: overrides.status ?? 'unpublished',
          selected: [],
          selectionAtLimit: false,
          onStatusChange,
          onSelectedChange: vi.fn(),
          onBulk: noop,
          onChangePublication: noop,
          onOpenSettings: vi.fn(),
          settingsBlocked: false,
          loadingMore: false,
          hasMore: false,
          onLoadMore: noop,
        }}
        exports={{
          job: overrides.exportJob,
          download: overrides.exportDownload,
          onPrepare,
          onDownload: noop,
          onRetry: noop,
          currentSource: overrides.currentSource
            ?? { count: event.storedMediaCount, freshness: 'fresh' },
        }}
      />}
    </>;
  }
  function TestGalleryHarness({ workspaceMounted }: { workspaceMounted: boolean }) {
    return <ManagerUndoProvider eventId="event-a">
      <TestGalleryOwner workspaceMounted={workspaceMounted} />
      <ManagerUndoBar />
    </ManagerUndoProvider>;
  }
  const rendered = render(<TestGalleryHarness workspaceMounted />);
  return {
    fetchMock,
    onPrepare,
    onStatusChange,
    onGalleryInvalidated,
    setWorkspaceMounted(workspaceMounted: boolean) {
      rendered.rerender(<TestGalleryHarness workspaceMounted={workspaceMounted} />);
    },
  };
}

function renderGallery(overrides: GalleryRenderOverrides = {}) {
  return renderGalleryWithFetch(managerFetch(overrides), overrides);
}

function renderWorkspaceWithUndo(workspace: ReactElement) {
  return render(<ManagerUndoProvider eventId="event-a">
    {workspace}
    <ManagerUndoBar />
  </ManagerUndoProvider>);
}

/** Mosaic photographs are decorative (`alt=""`), so they carry no role to query by. */
function mosaicImages(): HTMLImageElement[] {
  return Array.from(document.querySelectorAll<HTMLImageElement>('.gallery-mosaic__item img'));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('host private gallery', () => {
  it('opens the private timeline with moments, the event total, and no moderation controls', async () => {
    const { fetchMock } = renderGallery();

    expect(await screen.findByRole('heading', { name: 'Gallery' })).toBeVisible();
    expect(screen.getByText('842 delivered photos')).toBeVisible();
    expect(await screen.findByText('Saturday, August 15 · 5:42–6:18 PM')).toBeVisible();
    expect(await screen.findByText('Saturday, August 15, 11:48 PM–Sunday, August 16, 12:24 AM')).toBeVisible();
    expect(screen.queryByRole('button', { name: /publish selected/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();

    const galleryCalls = fetchMock.mock.calls.map(([input]) => new URL(String(input), 'https://candidary.test'));
    expect(galleryCalls.filter(({ pathname }) => pathname.endsWith('/gallery'))).toHaveLength(1);
  });

  it('renders the delivered photographs themselves rather than a placeholder grid', async () => {
    renderGallery();
    await screen.findByRole('heading', { name: 'Gallery' });

    await waitFor(() => expect(mosaicImages()).toHaveLength(4));
    expect(mosaicImages().map((image) => image.getAttribute('src')))
      .toEqual(rows.map((item) => `/api/media/${item.id}/preview`));
    expect(screen.queryByText('Preview unavailable')).not.toBeInTheDocument();
  });

  it('shows one Album membership state and one noninteractive Guest-gallery state per Library card', async () => {
    renderGallery({
      galleryRows: [
        photo('p1', '2026-08-15T22:42:00.000Z', {
          caption: 'First dance',
          isFavorite: true,
          publicationStatus: 'published',
        }),
        photo('p2', '2026-08-15T23:18:00.000Z', {
          publicationStatus: 'hidden',
        }),
      ],
    });
    await screen.findByText('First dance');

    const [picked, unpicked] = Array.from(document.querySelectorAll<HTMLElement>('.gallery-mosaic__item'));
    expect(within(picked!).getByRole('button', { name: 'Remove First dance from Album' }))
      .toHaveTextContent('In Album');
    expect(within(picked!).queryByText('Pick')).not.toBeInTheDocument();
    expect(within(picked!).getByText('Guest gallery · Published')).toBeVisible();
    expect(within(picked!).queryByRole('button', { name: /Guest gallery/u })).not.toBeInTheDocument();

    expect(within(unpicked!).getByRole('button', { name: 'Pick p2.jpg for the Album' }))
      .toHaveTextContent('Pick');
    expect(within(unpicked!).queryByText('In Album')).not.toBeInTheDocument();
    expect(within(unpicked!).getByText('Guest gallery · Hidden')).toBeVisible();
  });

  it('names each tile once, on the control that opens it', async () => {
    renderGallery();
    await screen.findByRole('heading', { name: 'Gallery' });

    // The photograph is decorative and the visible caption is its echo; announcing
    // the same title three times per tile is 48 tiles' worth of noise per page.
    expect(screen.getByRole('button', { name: 'Open First dance, from Jose' })).toBeVisible();
    for (const image of mosaicImages()) expect(image).toHaveAttribute('alt', '');
    expect(screen.queryAllByRole('img')).toHaveLength(0);
  });

  it('names an unavailable preview in text and keeps the neighbouring photographs', async () => {
    renderGallery({
      galleryRows: rows.map((item, index) => (
        index === 1 ? { ...item, previewAvailable: false } : { ...item }
      )),
    });
    await screen.findByRole('heading', { name: 'Gallery' });

    expect(await screen.findByText('Preview unavailable')).toBeVisible();
    expect(mosaicImages()).toHaveLength(3);
    // The tile stays openable: its name, contributor, and time are still the host's record.
    expect(screen.getByRole('button', { name: 'Open p2.jpg, from Jose' })).toBeVisible();
  });

  it('falls back to the named unavailable state when a preview fails to load', async () => {
    renderGallery();
    await screen.findByRole('heading', { name: 'Gallery' });

    await waitFor(() => expect(mosaicImages()).toHaveLength(4));
    fireEvent.error(mosaicImages()[0]!);

    expect(await screen.findByText('Preview unavailable')).toBeVisible();
    expect(mosaicImages()).toHaveLength(3);
  });

  it('opens newest-first and refetches the stream when the host changes the order', async () => {
    const { fetchMock } = renderGallery();
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Gallery' });

    const galleryOrders = () => fetchMock.mock.calls
      .map(([input]) => new URL(String(input), 'https://candidary.test'))
      .filter(({ pathname }) => pathname.endsWith('/gallery'))
      .map((url) => url.searchParams.get('order'));

    // The order is always explicit on the wire: a cursor is cut for one direction and
    // the server refuses to replay it against the other.
    expect(galleryOrders()).toEqual(['newest']);
    expect(screen.getByRole('button', { name: 'Newest first' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Earliest first' })).toHaveAttribute('aria-pressed', 'false');

    await user.click(screen.getByRole('button', { name: 'Earliest first' }));
    await waitFor(() => expect(galleryOrders()).toEqual(['newest', 'earliest']));
    expect(screen.getByRole('button', { name: 'Earliest first' })).toHaveAttribute('aria-pressed', 'true');

    // Choosing the order already in force must not spend a request.
    await user.click(screen.getByRole('button', { name: 'Earliest first' }));
    expect(galleryOrders()).toEqual(['newest', 'earliest']);
  });

  it('searches, clears, and shows the no-match state without losing the active query', async () => {
    renderGallery();
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Gallery' });

    await user.type(screen.getByLabelText('Find photos'), 'Maya');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('From Maya')).toBeVisible();
    expect(screen.queryByText('From Jose')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('heading', { name: /Saturday, August 15 · 11:48 PM/ })).toHaveFocus());

    await user.clear(screen.getByLabelText('Find photos'));
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect((await screen.findAllByText('From Jose'))[0]).toBeVisible();

    await user.type(screen.getByLabelText('Find photos'), 'missing-person');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByRole('heading', { name: 'No photos match this search.' })).toBeVisible();
    expect(await screen.findByRole('button', { name: 'Clear search' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'No photos match this search.' })).toHaveFocus();
  });

  it('keeps an abandoned continuation page out of a replacement search', async () => {
    const continuation = deferred<Response>();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://candidary.test');
      const method = init?.method ?? 'GET';
      if (url.pathname === '/api/manage/events/event-a/gallery' && method === 'GET') {
        if (url.searchParams.get('cursor') === 'older-page') return continuation.promise;
        if (url.searchParams.get('query') === 'Maya') {
          return success({ media: [rows[2]], nextCursor: null });
        }
        return success({ media: [rows[0]], nextCursor: 'older-page' });
      }
      throw new Error(`Unexpected request ${method} ${url.pathname}${url.search}`);
    });
    renderGalleryWithFetch(fetchMock);
    const user = userEvent.setup();

    await screen.findByText('First dance');
    await user.click(screen.getByRole('button', { name: 'Load more photos' }));
    await user.type(screen.getByLabelText('Find photos'), 'Maya');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('From Maya')).toBeVisible();

    await act(async () => {
      continuation.resolve(await success({ media: [rows[1]], nextCursor: null }));
      await continuation.promise;
    });
    expect(screen.queryByText('p2.jpg')).not.toBeInTheDocument();
    expect(screen.getByText('From Maya')).toBeVisible();
  });

  it('keeps the confirmed timeline and retries the exact replacement after a later search failure', async () => {
    let searchAttempts = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://candidary.test');
      const method = init?.method ?? 'GET';
      if (url.pathname === '/api/manage/events/event-a/gallery' && method === 'GET') {
        if (url.searchParams.get('query') === 'Maya') {
          searchAttempts += 1;
          return searchAttempts === 1
            ? failure('INTERNAL_ERROR', 'Search is temporarily unavailable.')
            : success({ media: [rows[2]], nextCursor: null });
        }
        return success({ media: [rows[0]], nextCursor: null });
      }
      throw new Error(`Unexpected request ${method} ${url.pathname}${url.search}`);
    });
    renderGalleryWithFetch(fetchMock);
    const user = userEvent.setup();

    await screen.findByText('First dance');
    await user.type(screen.getByLabelText('Find photos'), 'Maya');
    await user.click(screen.getByRole('button', { name: 'Search' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Search is temporarily unavailable.');
    expect(screen.getByText('First dance')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('From Maya')).toBeVisible();
    expect(searchAttempts).toBe(2);
  });

  it('keeps the confirmed timeline and retries the exact continuation after a later page failure', async () => {
    let continuationAttempts = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://candidary.test');
      const method = init?.method ?? 'GET';
      if (url.pathname === '/api/manage/events/event-a/gallery' && method === 'GET') {
        if (url.searchParams.get('cursor') === 'next-page') {
          continuationAttempts += 1;
          return continuationAttempts === 1
            ? failure('INTERNAL_ERROR', 'The next page is temporarily unavailable.')
            : success({ media: [rows[1]], nextCursor: null });
        }
        return success({ media: [rows[0]], nextCursor: 'next-page' });
      }
      throw new Error(`Unexpected request ${method} ${url.pathname}${url.search}`);
    });
    renderGalleryWithFetch(fetchMock);
    const user = userEvent.setup();

    await screen.findByText('First dance');
    await user.click(screen.getByRole('button', { name: 'Load more photos' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The next page is temporarily unavailable.');
    expect(screen.getByText('First dance')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    // Named through the control rather than a visible caption: only the hero tile carries one.
    expect(await screen.findByRole('button', { name: 'Open p2.jpg, from Jose' })).toBeVisible();
    expect(continuationAttempts).toBe(2);
  });

  it('announces the exact In Album result and patches a picked tile without a refetch', async () => {
    const { fetchMock } = renderGallery();
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Gallery' });

    const galleryGets = () => fetchMock.mock.calls
      .filter(([input, init]) => {
        const url = new URL(String(input), 'https://candidary.test');
        return url.pathname.endsWith('/gallery') && (init?.method ?? 'GET') === 'GET';
      });
    const before = galleryGets().length;

    const favoriteTile = await screen.findByRole('button', { name: 'Pick First dance for the Album' });
    await user.click(favoriteTile);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove First dance from Album' }))
      .toHaveAttribute('aria-pressed', 'true'));
    await waitFor(() => expect(document.querySelector('[data-gallery-live-host] [role="status"]'))
      .toHaveTextContent('First dance is now In Album. This does not publish it.'));
    expect(galleryGets().length).toBe(before);

    await user.click(screen.getByRole('button', { name: /^Album picks/ }));
    expect(await screen.findByText('First dance')).toBeVisible();
    expect(screen.getByTitle('p4.jpg')).toBeVisible();
  });

  it('refetches the current query and invalidates audience after a confirmed card write crosses replacement', async () => {
    const favoriteWrite = deferred<Response>();
    const galleryRows = [
      photo('p1', '2026-08-15T22:42:00.000Z', { caption: 'First dance' }),
      photo('p2', '2026-08-16T04:48:00.000Z', { guestName: 'Maya' }),
    ];
    let mayaReads = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://candidary.test');
      const method = init?.method ?? 'GET';
      if (url.pathname === '/api/manage/events/event-a/gallery' && method === 'GET') {
        if (url.searchParams.get('query') === 'Maya') {
          mayaReads += 1;
          return success({ media: [{ ...galleryRows[1]! }], nextCursor: null });
        }
        return success({ media: [{ ...galleryRows[0]! }], nextCursor: null });
      }
      if (url.pathname.endsWith('/media/p1/favorite') && method === 'PUT') {
        return favoriteWrite.promise;
      }
      throw new Error(`Unexpected request ${method} ${url.pathname}${url.search}`);
    });
    const authority = audienceAuthority(galleryRows);
    renderGalleryWithFetch(fetchMock, { galleryRows, audience: authority });
    const user = userEvent.setup();

    await screen.findByText('First dance');
    await user.click(screen.getByRole('button', { name: 'Pick First dance for the Album' }));
    await user.type(screen.getByLabelText('Find photos'), 'Maya');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('From Maya')).toBeVisible();
    expect(mayaReads).toBe(1);

    galleryRows[0]!.isFavorite = true;
    favoriteWrite.resolve(await success({ media: { ...galleryRows[0]! } }));

    await waitFor(() => expect(mayaReads).toBe(2));
    expect(authority.invalidate).toHaveBeenCalledOnce();
    expect(screen.getByText('From Maya')).toBeVisible();
  });

  it('refetches the current Album-picks query after a confirmed bulk write crosses replacement', async () => {
    const bulkWrite = deferred<Response>();
    const galleryRows = [photo('p1', '2026-08-15T22:42:00.000Z')];
    let favoritesReads = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://candidary.test');
      const method = init?.method ?? 'GET';
      if (url.pathname === '/api/manage/events/event-a/gallery' && method === 'GET') {
        if (url.searchParams.get('favorites') === '1') {
          favoritesReads += 1;
          return success({
            media: galleryRows.filter((item) => item.isFavorite).map((item) => ({ ...item })),
            nextCursor: null,
          });
        }
        return success({ media: galleryRows.map((item) => ({ ...item })), nextCursor: null });
      }
      if (url.pathname.endsWith('/album/picks') && method === 'POST') return bulkWrite.promise;
      throw new Error(`Unexpected request ${method} ${url.pathname}${url.search}`);
    });
    const authority = audienceAuthority(galleryRows);
    renderGalleryWithFetch(fetchMock, { galleryRows, audience: authority });
    const user = userEvent.setup();

    await screen.findByText('p1.jpg');
    await user.click(screen.getByRole('button', { name: 'Select photos' }));
    await user.click(screen.getByRole('button', { name: 'Select p1.jpg, from Jose' }));
    await user.click(screen.getByRole('button', { name: 'Pick for Album (1)' }));
    await user.click(screen.getByRole('button', { name: /^Album picks/ }));
    expect(await screen.findByRole('heading', { name: 'No photos are In Album yet.' })).toBeVisible();
    expect(favoritesReads).toBe(1);

    galleryRows[0]!.isFavorite = true;
    bulkWrite.resolve(await success({ changed: [{ ...galleryRows[0]! }] }));

    await waitFor(() => expect(favoritesReads).toBe(2));
    expect(authority.invalidate).toHaveBeenCalledOnce();
    expect(await screen.findByText('p1.jpg')).toBeVisible();
  });

  it('restores the confirmed favorite state and shows a notice when a favorite write fails', async () => {
    renderGallery({ favoriteFails: true });
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Gallery' });

    await user.click(await screen.findByRole('button', { name: 'Pick First dance for the Album' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('manager action');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Pick First dance for the Album' }))
      .toHaveAttribute('aria-pressed', 'false'));
  });

  it('keeps one persistent Undo bar and retries the exact API-only inverse after Gallery unmounts', async () => {
    const galleryRows = [
      photo('p1', '2026-08-15T22:42:00.000Z'),
      photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true }),
    ];
    const baseFetch = managerFetch({ galleryRows });
    const implementation = baseFetch.getMockImplementation()!;
    let pickRequest = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://candidary.test');
      if (url.pathname.endsWith('/album/picks') && (init?.method ?? 'GET') === 'POST') {
        pickRequest += 1;
        if (pickRequest === 2) return failure('INTERNAL_ERROR', 'Undo request failed.');
      }
      return implementation(input, init);
    });
    const onGalleryInvalidated = vi.fn();
    const rendered = renderGalleryWithFetch(fetchMock, { galleryRows, onGalleryInvalidated });
    const user = userEvent.setup();

    await screen.findByText('p1.jpg');
    await user.click(screen.getByRole('button', { name: 'Select photos' }));
    await user.click(screen.getByRole('button', { name: 'Select p1.jpg, from Jose' }));
    await user.click(screen.getByRole('button', { name: 'Select p2.jpg, from Jose' }));
    await user.click(screen.getByRole('button', { name: 'Pick for Album (2)' }));

    expect(await screen.findByText('1 photo picked for Album. Nothing was published.')).toBeVisible();
    expect(document.querySelectorAll('.album-undo')).toHaveLength(1);
    rendered.setWorkspaceMounted(false);
    expect(screen.queryByRole('heading', { name: 'Gallery' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByText(/Undo could not be completed/u)).toBeVisible();
    expect(onGalleryInvalidated).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument());
    expect(onGalleryInvalidated).toHaveBeenCalledTimes(2);

    const writes = fetchMock.mock.calls
      .filter(([input, init]) => (
        new URL(String(input), 'https://candidary.test').pathname.endsWith('/album/picks')
        && (init?.method ?? 'GET') === 'POST'
      ))
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(writes).toEqual([
      { mediaIds: ['p1', 'p2'], picked: true },
      { mediaIds: ['p1'], picked: false },
      { mediaIds: ['p1'], picked: false },
    ]);
  });

  it('restores an exact bulk removal through the persistent API-only inverse after Gallery unmounts', async () => {
    const galleryRows = [
      photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true }),
      photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true }),
    ];
    const fetchMock = managerFetch({ galleryRows });
    const onGalleryInvalidated = vi.fn();
    const rendered = renderGalleryWithFetch(fetchMock, { galleryRows, onGalleryInvalidated });
    const user = userEvent.setup();

    await screen.findByText('p1.jpg');
    await user.click(screen.getByRole('button', { name: 'Select photos' }));
    await user.click(screen.getByRole('button', { name: 'Select p1.jpg, from Jose' }));
    await user.click(screen.getByRole('button', { name: 'Remove from Album (1)' }));

    expect(await screen.findByText('1 photo removed from Album. The delivered photos remain.')).toBeVisible();
    rendered.setWorkspaceMounted(false);
    expect(screen.queryByRole('heading', { name: 'Gallery' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Undo' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument());
    expect(onGalleryInvalidated).toHaveBeenCalledOnce();
    const writes = fetchMock.mock.calls
      .filter(([input, init]) => (
        new URL(String(input), 'https://candidary.test').pathname.endsWith('/album/picks')
        && (init?.method ?? 'GET') === 'POST'
      ))
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(writes).toEqual([
      { mediaIds: ['p1'], picked: false },
      { mediaIds: ['p1'], picked: true },
    ]);
  });

  it('does not create an Undo offer when the canonical bulk result changed nothing', async () => {
    renderGallery({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true })],
    });
    const user = userEvent.setup();

    await screen.findByText('p1.jpg');
    await user.click(screen.getByRole('button', { name: 'Select photos' }));
    await user.click(screen.getByRole('button', { name: 'Select p1.jpg, from Jose' }));
    await user.click(screen.getByRole('button', { name: 'Pick for Album (1)' }));

    await waitFor(() => expect(document.querySelector('[data-gallery-live-host] [role="status"]'))
      .toHaveTextContent('Nothing changed'));
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('retires an older offer before a deferred bulk forward can confirm its replacement', async () => {
    const galleryRows = [
      photo('p1', '2026-08-15T22:42:00.000Z'),
      photo('p2', '2026-08-15T23:18:00.000Z'),
    ];
    const secondForward = deferred<Response>();
    const baseFetch = managerFetch({ galleryRows });
    const implementation = baseFetch.getMockImplementation()!;
    let pickRequest = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://candidary.test');
      if (url.pathname.endsWith('/album/picks') && (init?.method ?? 'GET') === 'POST') {
        pickRequest += 1;
        if (pickRequest === 2) return secondForward.promise;
      }
      return implementation(input, init);
    });
    const rendered = renderGalleryWithFetch(fetchMock, { galleryRows });
    const user = userEvent.setup();

    await screen.findByText('p1.jpg');
    await user.click(screen.getByRole('button', { name: 'Select photos' }));
    await user.click(screen.getByRole('button', { name: 'Select p1.jpg, from Jose' }));
    await user.click(screen.getByRole('button', { name: 'Pick for Album (1)' }));
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Select photos' }));
    await user.click(screen.getByRole('button', { name: 'Select p2.jpg, from Jose' }));
    await user.click(screen.getByRole('button', { name: 'Pick for Album (1)' }));
    await waitFor(() => expect(pickRequest).toBe(2));

    // Once the newer forward owns the mutation boundary, the older inverse must
    // not be runnable into its in-flight response and lock out the replacement.
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();

    galleryRows[1]!.isFavorite = true;
    secondForward.resolve(await success({ changed: [{ ...galleryRows[1]! }] }));
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeVisible();

    rendered.setWorkspaceMounted(false);
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument());

    const writes = fetchMock.mock.calls
      .filter(([input, init]) => (
        new URL(String(input), 'https://candidary.test').pathname.endsWith('/album/picks')
        && (init?.method ?? 'GET') === 'POST'
      ))
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(writes).toEqual([
      { mediaIds: ['p1'], picked: true },
      { mediaIds: ['p2'], picked: true },
      { mediaIds: ['p2'], picked: false },
    ]);
  });

  it.each([
    {
      name: 'next card',
      ids: ['p1', 'p2', 'p3'],
      removeId: 'p1',
      expected: { role: 'button' as const, name: 'Open p2.jpg, from Jose' },
    },
    {
      name: 'previous card',
      ids: ['p1', 'p2', 'p3'],
      removeId: 'p3',
      expected: { role: 'button' as const, name: 'Open p2.jpg, from Jose' },
    },
    {
      name: 'Gallery heading',
      ids: ['p1'],
      removeId: 'p1',
      expected: { role: 'heading' as const, name: 'Gallery' },
    },
  ])('establishes the filtered-Library $name fallback before pointer Undo presentation', async ({
    ids,
    removeId,
    expected,
  }) => {
    renderGallery({
      galleryRows: ids.map((id, index) => photo(
        id,
        new Date(Date.parse('2026-08-15T22:42:00.000Z') + index * 60_000).toISOString(),
        { isFavorite: true },
      )),
    });
    const user = userEvent.setup();

    await screen.findByText('p1.jpg');
    await user.click(screen.getByRole('button', { name: /^Album picks/ }));
    await user.click(screen.getByRole('button', { name: 'Select photos' }));
    await user.click(screen.getByRole('button', { name: `Select ${removeId}.jpg, from Jose` }));
    await user.click(screen.getByRole('button', { name: 'Remove from Album (1)' }));

    await waitFor(() => expect(screen.getByRole(expected.role, { name: expected.name })).toHaveFocus());
    expect(screen.getByRole('button', { name: 'Undo' })).not.toHaveFocus();
  });

  it('focuses Undo for a keyboard-confirmed filtered removal after establishing its fallback', async () => {
    renderGallery({
      galleryRows: [
        photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true }),
        photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true }),
      ],
    });
    const user = userEvent.setup();

    await screen.findByText('p1.jpg');
    await user.click(screen.getByRole('button', { name: /^Album picks/ }));
    await user.click(screen.getByRole('button', { name: 'Select photos' }));
    await user.click(screen.getByRole('button', { name: 'Select p1.jpg, from Jose' }));
    const remove = screen.getByRole('button', { name: 'Remove from Album (1)' });
    remove.focus();
    await user.keyboard('{Enter}');

    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toHaveFocus());
  });

  it.each(['pointer', 'keyboard'] as const)(
    'preserves focus moved outside the disappearing tray before a deferred %s removal confirms',
    async (input) => {
      const galleryRows = [
        photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true }),
        photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true }),
      ];
      const forward = deferred<Response>();
      const baseFetch = managerFetch({ galleryRows });
      const implementation = baseFetch.getMockImplementation()!;
      const fetchMock = vi.fn((request: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(request), 'https://candidary.test');
        if (url.pathname.endsWith('/album/picks') && (init?.method ?? 'GET') === 'POST') {
          return forward.promise;
        }
        return implementation(request, init);
      });
      renderGalleryWithFetch(fetchMock, { galleryRows });
      const user = userEvent.setup();

      await screen.findByText('p1.jpg');
      await user.click(screen.getByRole('button', { name: /^Album picks/ }));
      await user.click(screen.getByRole('button', { name: 'Select photos' }));
      await user.click(screen.getByRole('button', { name: 'Select p1.jpg, from Jose' }));
      const remove = screen.getByRole('button', { name: 'Remove from Album (1)' });
      if (input === 'keyboard') {
        remove.focus();
        await user.keyboard('{Enter}');
      } else {
        await user.click(remove);
      }
      const search = screen.getByRole('textbox', { name: 'Find photos' });
      search.focus();
      expect(search).toHaveFocus();

      galleryRows[0]!.isFavorite = false;
      forward.resolve(await success({ changed: [{ ...galleryRows[0]! }] }));

      await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toBeVisible());
      expect(search).toHaveFocus();
      expect(screen.getByRole('button', { name: 'Undo' })).not.toHaveFocus();
      expect(document.querySelector('.album-undo [role="status"]'))
        .toHaveTextContent('1 photo removed from Album. The delivered photos remain. Undo is available for nine seconds.');
    },
  );

  it('locks Pick and Remove while Undo runs but leaves Clear available', async () => {
    const galleryRows = [
      photo('p1', '2026-08-15T22:42:00.000Z'),
      photo('p2', '2026-08-15T23:18:00.000Z'),
    ];
    const inverse = deferred<Response>();
    const baseFetch = managerFetch({ galleryRows });
    const implementation = baseFetch.getMockImplementation()!;
    let pickRequest = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://candidary.test');
      if (url.pathname.endsWith('/album/picks') && (init?.method ?? 'GET') === 'POST') {
        pickRequest += 1;
        if (pickRequest === 2) return inverse.promise;
      }
      return implementation(input, init);
    });
    renderGalleryWithFetch(fetchMock, { galleryRows });
    const user = userEvent.setup();

    await screen.findByText('p1.jpg');
    await user.click(screen.getByRole('button', { name: 'Select photos' }));
    await user.click(screen.getByRole('button', { name: 'Select p1.jpg, from Jose' }));
    await user.click(screen.getByRole('button', { name: 'Pick for Album (1)' }));
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(await screen.findByRole('button', { name: 'Undoing…' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Select photos' }));
    await user.click(screen.getByRole('button', { name: 'Select p2.jpg, from Jose' }));
    const tray = screen.getByRole('region', { name: 'Album' });
    expect(within(tray).getByRole('button', { name: 'Pick for Album (1)' })).toBeDisabled();
    expect(within(tray).getByRole('button', { name: 'Remove from Album (1)' })).toBeDisabled();
    expect(within(tray).getByRole('button', { name: 'Clear selection' })).toBeEnabled();
    await user.click(within(tray).getByRole('button', { name: 'Clear selection' }));
    expect(screen.queryByRole('region', { name: 'Album' })).not.toBeInTheDocument();
    expect(pickRequest).toBe(2);

    inverse.resolve(await success({ changed: [{ ...galleryRows[0], isFavorite: false }] }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Undoing…' })).not.toBeInTheDocument());
  });

  it('opens the immersive viewer, navigates, and restores focus on close', async () => {
    renderGallery();
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Gallery' });

    const origin = await screen.findByRole('button', { name: /open first dance/i });
    await user.click(origin);
    const dialog = await screen.findByRole('dialog', { name: 'First dance' });
    expect(within(dialog).getByText('First dance')).toBeVisible();
    expect(within(dialog).getByText('From Jose')).toBeVisible();
    // The viewer walks the loaded result set, and the header above it counts the whole event, so the
    // position says which of the two it is talking about rather than contradicting the total.
    expect(within(dialog).getByText('Photo 1 of 4')).toBeVisible();

    await user.keyboard('{ArrowRight}');
    expect(within(dialog).queryByText('First dance')).not.toBeInTheDocument();
    expect(within(dialog).getAllByText(/p2\.jpg/).length).toBeGreaterThan(0);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open p2/i })).toHaveFocus();
  });

  it('names the viewer position as loaded while chronological pages remain', async () => {
    renderGallery({ nextCursor: 'cursor-b' });
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Gallery' });

    await user.click(await screen.findByRole('button', { name: /open first dance/i }));
    const dialog = await screen.findByRole('dialog', { name: 'First dance' });
    // 4 of 842 stored photos are loaded. A bare "of 4" beside the header's event total would read as
    // a second, smaller collection instead of one page of the first.
    expect(within(dialog).getByText('Photo 1 of 4 loaded')).toBeVisible();
    expect(screen.getByText('842 delivered photos')).toBeVisible();
  });

  it('switches to the shared workspace on unpublished and back to the preserved private state', async () => {
    const { fetchMock, onStatusChange } = renderGallery();
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Gallery' });

    await user.type(screen.getByLabelText('Find photos'), 'Maya');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('From Maya')).toBeVisible();
    const galleryGetsBeforeSwitch = fetchMock.mock.calls.filter(([input, init]) => {
      const url = new URL(String(input), 'https://candidary.test');
      return url.pathname.endsWith('/gallery') && (init?.method ?? 'GET') === 'GET';
    }).length;

    await user.click(screen.getByRole('button', { name: 'Guest gallery' }));
    expect(screen.getByRole('heading', { name: 'Gallery' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Guest gallery' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /publish selected/i })).toBeVisible();
    expect(onStatusChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /^Album picks/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Library' }));
    expect(screen.getByRole('heading', { name: 'Gallery' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Library' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Find photos')).toHaveValue('Maya');
    expect(screen.getByText('From Maya')).toBeVisible();
    expect(screen.queryByText('From Jose')).not.toBeInTheDocument();
    const galleryGetsAfterSwitch = fetchMock.mock.calls.filter(([input, init]) => {
      const url = new URL(String(input), 'https://candidary.test');
      return url.pathname.endsWith('/gallery') && (init?.method ?? 'GET') === 'GET';
    }).length;
    expect(galleryGetsAfterSwitch).toBe(galleryGetsBeforeSwitch);
  });

  it('focuses the nearest current tile when an open favorite is removed after pagination', async () => {
    const continuation = deferred<Response>();
    const favoriteWrite = deferred<Response>();
    const favoriteRows = [
      photo('p1', '2026-08-15T22:42:00.000Z', { caption: 'First dance', isFavorite: true }),
      photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true }),
    ];
    const laterFavorite = photo('p3', '2026-08-16T04:48:00.000Z', { guestName: 'Maya', isFavorite: true });
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://candidary.test');
      const method = init?.method ?? 'GET';
      if (url.pathname === '/api/manage/events/event-a/gallery' && method === 'GET') {
        if (url.searchParams.get('cursor') === 'later-favorites') return continuation.promise;
        return success({
          media: favoriteRows,
          nextCursor: url.searchParams.get('favorites') === '1' ? 'later-favorites' : null,
        });
      }
      if (url.pathname.endsWith('/media/p2/favorite') && method === 'PUT') return favoriteWrite.promise;
      throw new Error(`Unexpected request ${method} ${url.pathname}${url.search}`);
    });
    renderGalleryWithFetch(fetchMock);
    const user = userEvent.setup();

    await screen.findByText('First dance');
    await user.click(screen.getByRole('button', { name: /^Album picks/ }));
    await screen.findByRole('button', { name: 'Load more photos' });
    await user.click(screen.getByRole('button', { name: 'Load more photos' }));
    await user.click(screen.getByRole('button', { name: /open p2/i }));
    const dialog = await screen.findByRole('dialog', { name: 'p2.jpg' });
    const viewerFavorite = within(dialog).getByRole('button', { name: 'Remove p2.jpg from Album' });
    expect(within(dialog).queryByText('In the album')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Not in the album')).not.toBeInTheDocument();
    await user.click(viewerFavorite);
    expect(viewerFavorite).toBeDisabled();

    continuation.resolve(await success({ media: [laterFavorite], nextCursor: null }));
    await screen.findByRole('button', { name: /open p3/i });
    favoriteWrite.resolve(await success({ media: { ...favoriteRows[1], isFavorite: false } }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: /open p3/i })).toHaveFocus());
  });

  it('starts the complete export from the one Download all action', async () => {
    const { onPrepare } = renderGallery();
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Gallery' });

    expect(screen.getByText(/Every delivered photo, the photo manifest, and the printable and private guestbook files/)).toBeVisible();
    expect(screen.getByText(/Search and Album picks do not change this/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Download all' }));
    expect(onPrepare).toHaveBeenCalledTimes(1);
    expect(onPrepare).toHaveBeenCalledWith();
  });

  it('keeps the ready frozen export and a separate current-source action', async () => {
    renderGallery({
      exportJob: {
        id: 'export-a',
        kind: 'complete',
        state: 'ready',
        snapshotAt: '2026-09-19T00:00:00Z',
        createdAt: '2026-09-19T00:00:01Z',
        startedAt: '2026-09-19T00:00:02Z',
        completedAt: '2026-09-19T00:00:03Z',
        mediaCount: 842,
        totalBytes: 1024,
        processedMediaCount: 842,
        processedBytes: 1024,
        progressUpdatedAt: '2026-09-19T00:00:02Z',
        attempt: 1,
        partCount: 1,
        expiresAt: null,
        guestbookEntryCount: 3,
        guestbookSharedCount: 1,
        guestbookEventName: null,
        guestbookEventDate: null,
        guestbookEventTimezone: null,
        guestbookPrompt: null,
        guestbookGalleryVisible: null,
        errorCode: null,
      },
    });
    await screen.findByRole('heading', { name: 'Gallery' });

    expect(screen.getByText('Ready')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Get download links' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Download all' })).not.toBeInTheDocument();
    expect(document.querySelector('.export-state__prepared'))
      .toHaveTextContent('Prepared September 18, 2026 at 7:00 PM CDT · 842 photos · Ready');
    expect(screen.getByText('Frozen size: 1 KB · 3 guestbook entries.')).toBeVisible();
    expect(screen.getByText('Ready to download. Download links last 24 hours.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Prepare current collection' })).toBeVisible();
    expect(document.querySelectorAll('[data-gallery-live-host] [role="status"]')).toHaveLength(1);
    expect(screen.queryByText(/attempt/i)).not.toBeInTheDocument();
  });

  it('uses a fresh authoritative zero to disable complete preparation with local guidance', async () => {
    const onPrepare = vi.fn(noop);
    renderGallery({
      currentSource: { count: 0, freshness: 'fresh' },
      onPrepare,
    });
    await screen.findByRole('heading', { name: 'Gallery' });

    expect(screen.getByRole('button', { name: 'Download all' })).toBeDisabled();
    expect(screen.getByText('Deliver a photo before preparing the current collection.')).toBeVisible();
    expect(onPrepare).not.toHaveBeenCalled();
  });

  it('names a failed export and keeps the retry action', async () => {
    renderGallery({
      exportJob: {
        id: 'export-a',
        kind: 'complete',
        state: 'failed',
        snapshotAt: '2026-09-19T00:00:00Z',
        createdAt: '2026-09-19T00:00:01Z',
        startedAt: '2026-09-19T00:00:02Z',
        completedAt: '2026-09-19T00:00:03Z',
        mediaCount: 842,
        totalBytes: 1024,
        processedMediaCount: 420,
        processedBytes: 512,
        progressUpdatedAt: '2026-09-19T00:00:02Z',
        attempt: 2,
        partCount: 1,
        expiresAt: null,
        guestbookEntryCount: 3,
        guestbookSharedCount: 1,
        guestbookEventName: null,
        guestbookEventDate: null,
        guestbookEventTimezone: null,
        guestbookPrompt: null,
        guestbookGalleryVisible: null,
        errorCode: 'EXPORT_FAILED',
      },
    });
    await screen.findByRole('heading', { name: 'Gallery' });

    expect(screen.getByText('Failed')).toBeVisible();
    expect(screen.getByText(/This prepared export did not finish\./u)).toBeVisible();
    expect(screen.getByText('Progress: 420 of 842 photos · 1 KB of 1 KB.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Retry this prepared export' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Prepare current collection' })).toBeVisible();
  });

  it('redacts an arbitrary export failure but prepares the current collection when its frozen source is gone', async () => {
    const onPrepare = vi.fn(() => Promise.resolve());
    renderGallery({
      exportJob: {
        id: 'export-removed',
        kind: 'complete',
        state: 'failed',
        snapshotAt: '2026-09-19T00:00:00Z',
        createdAt: '2026-09-19T00:00:01Z',
        startedAt: '2026-09-19T00:00:02Z',
        completedAt: '2026-09-19T00:00:03Z',
        mediaCount: 842,
        totalBytes: 1024,
        processedMediaCount: 420,
        processedBytes: 512,
        progressUpdatedAt: '2026-09-19T00:00:02Z',
        attempt: 2,
        partCount: 1,
        expiresAt: null,
        errorCode: 'EXPORT_SOURCE_REMOVED',
        guestbookEntryCount: 3,
        guestbookSharedCount: 1,
        guestbookEventName: null,
        guestbookEventDate: null,
        guestbookEventTimezone: null,
        guestbookPrompt: null,
        guestbookGalleryVisible: null,
      },
      onPrepare,
    });

    await screen.findByRole('heading', { name: 'Gallery' });
    expect(screen.getByText(/A photo in this prepared export is no longer available\. Prepare the current collection\./, {
      selector: 'span',
    })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Retry this prepared export' })).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Prepare current collection' }));
    expect(onPrepare).toHaveBeenCalledOnce();
  });

  it('names every download part with its size and says when it is a desktop task', async () => {
    const part = (partNumber: number, mediaCount: number, sourceBytes: number) => ({
      partNumber,
      mediaCount,
      sourceBytes,
      url: `https://example.test/part-${partNumber}`,
      expiresAt: '2026-09-20T00:00:00Z',
      filename: `part-${partNumber}.zip`,
    });
    renderGallery({
      exportJob: {
        id: 'export-a',
        kind: 'complete',
        state: 'ready',
        snapshotAt: '2026-09-19T00:00:00Z',
        createdAt: '2026-09-19T00:00:01Z',
        startedAt: '2026-09-19T00:00:02Z',
        completedAt: '2026-09-19T00:00:03Z',
        mediaCount: 4812,
        totalBytes: 3 * 1024 ** 3,
        processedMediaCount: 4812,
        processedBytes: 3 * 1024 ** 3,
        progressUpdatedAt: '2026-09-19T00:00:02Z',
        attempt: 1,
        partCount: 2,
        expiresAt: '2026-09-20T00:00:00Z',
        guestbookEntryCount: 12,
        guestbookSharedCount: 4,
        guestbookEventName: null,
        guestbookEventDate: null,
        guestbookEventTimezone: null,
        guestbookPrompt: null,
        guestbookGalleryVisible: null,
        errorCode: null,
      },
      exportDownload: {
        manifest: { url: 'https://example.test/manifest', expiresAt: '2026-09-20T00:00:00Z', filename: 'manifest.csv' },
        parts: [part(1, 2400, 2 * 1024 ** 3), part(2, 2412, 1024 ** 3)],
        printableGuestbook: null,
        privateGuestbook: null,
      },
    });
    await screen.findByRole('heading', { name: 'Gallery' });

    // A host planning a multi-gigabyte download needs the size before they start.
    expect(screen.getByText('Frozen size: 3.0 GB · 12 guestbook entries.')).toBeVisible();
    expect(screen.getByRole('link', { name: /Photo part 1 of 2/ })).toBeVisible();
    expect(screen.getByText('2,400 photos · 2.0 GB')).toBeVisible();
    expect(screen.getByText('2,412 photos · 1.0 GB')).toBeVisible();
    expect(screen.getByText(/Collect every one/)).toBeVisible();
    expect(screen.getByText(/easier to finish on a computer than on a phone/)).toBeVisible();
  });

  it('uses titled publication filters and labeled hide actions in the shared workspace', async () => {
    const onOpenSettings = vi.fn();
    vi.stubGlobal('fetch', managerFetch({ guestGalleryVisible: false }));
    renderWorkspaceWithUndo(<ManagerGalleryWorkspace
      event={{ ...event, galleryVisible: false }}
      eventId="event-a"
      galleryMutationEpoch={0}
      invalidateGalleryAfterMutation={vi.fn()}
      audience={audienceAuthority(rows, false)}
      onAnnouncement={vi.fn()}
      shared={{
        media: [{
          id: 'p1',
          originalFilename: 'toast.jpg',
          guestName: 'Jose',
          caption: null,
          publicationStatus: 'unpublished',
          uploadState: 'stored',
        } satisfies MediaView],
        status: 'unpublished',
        selected: [],
        selectionAtLimit: false,
        onStatusChange: vi.fn(),
        onSelectedChange: vi.fn(),
        onBulk: noop,
        onChangePublication: noop,
        onOpenSettings,
        settingsBlocked: false,
        loadingMore: false,
        hasMore: false,
        onLoadMore: noop,
      }}
      exports={{
        onPrepare: noop,
        onDownload: noop,
        onRetry: noop,
        currentSource: { count: event.storedMediaCount, freshness: 'fresh' },
      }}
    />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Guest gallery' }));

    const filters = screen.getByRole('group', { name: 'Publication status' });
    expect(within(filters).getByRole('button', { name: 'Unpublished' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(filters).getByRole('button', { name: 'Published' })).toHaveAttribute('aria-pressed', 'false');
    expect(within(filters).getByRole('button', { name: 'Hidden' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Publish toast.jpg' }))
      .toHaveClass('button--approve');
    expect(screen.getByRole('button', { name: 'Hide toast.jpg' }))
      .toHaveClass('button--secondary');
    expect(screen.getByRole('button', { name: 'Hide selected' })).toBeDisabled();
    expect(screen.getByText('Publication choices are saved, but the Guest gallery is off.')).toBeVisible();
    expect(screen.getByText('Publish and Hide change what event guests see. They do not change Album membership or the Album link.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Open settings' }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('explains an empty published filter without promising new deliveries', async () => {
    renderGallery({ status: 'published' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Guest gallery' }));

    expect(screen.getByRole('heading', { name: 'No published photos.' })).toBeVisible();
    expect(screen.getByText('Publish a photo to show it in the Guest gallery.')).toBeVisible();
    expect(screen.queryByText(/new delivered photos/i)).not.toBeInTheDocument();
  });

  it('uses Delivered photos and In Album vocabulary for empty Library states', async () => {
    renderGallery({ galleryRows: [] });
    const user = userEvent.setup();

    expect(await screen.findByText(
      'New delivered photos appear in Live intake as event guests send them.',
    )).toBeVisible();
    expect(document.body).not.toHaveTextContent(/private gallery|private deliveries/iu);
    await user.click(await screen.findByRole('button', { name: /^Album picks/ }));

    expect(await screen.findByRole('heading', { name: 'No photos are In Album yet.' })).toBeVisible();
    expect(screen.getByText(/makes it In Album for every host on this event/)).toBeVisible();
  });

  it('explains an empty hidden filter as hide, not as unpublished privacy', async () => {
    renderGallery({ status: 'hidden' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Guest gallery' }));

    expect(screen.getByRole('heading', { name: 'No hidden photos.' })).toBeVisible();
    expect(screen.getByText('Photos Hidden from event guests appear here.')).toBeVisible();
    expect(screen.queryByText(/keep private/i)).not.toBeInTheDocument();
  });

  it('does not describe an unfiltered empty shared list as unpublished', async () => {
    renderGallery({ status: 'all' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Guest gallery' }));

    expect(screen.getByRole('heading', { name: 'No photos.' })).toBeVisible();
    expect(screen.getByText('New delivered photos appear here.')).toBeVisible();
    expect(document.body).not.toHaveTextContent(/private deliveries/iu);
    expect(screen.queryByRole('heading', { name: 'No unpublished photos.' })).not.toBeInTheDocument();
  });

  // Spec 6.4 allows the moment heading or the expansion control. The control is what the host
  // pressed and it outlives the collapse, so focus stays there rather than jumping back above the
  // mosaic and making them tab through every remaining tile to reach it again.
  it('keeps focus on the expansion control after collapsing extra photos', async () => {
    const crowded = Array.from({ length: 9 }, (_, index) => (
      photo(`p${index + 1}`, `2026-08-15T22:${String(42 + index).padStart(2, '0')}:00.000Z`)
    ));
    renderGallery({ galleryRows: crowded });
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Gallery' });

    await user.click(screen.getByRole('button', { name: 'Show more photos' }));
    expect(screen.getByRole('button', { name: /open p9/i })).toBeVisible();

    const collapse = screen.getByRole('button', { name: 'Show fewer photos' });
    await user.click(collapse);
    const toggle = screen.getByRole('button', { name: 'Show more photos' });
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: /open p9/i })).not.toBeInTheDocument();
  });

  it('names Select all from the complete loaded photo count', async () => {
    const loaded = Array.from({ length: 48 }, (_, index) => (
      photo(`p${index + 1}`, `2026-08-15T22:${String(index).padStart(2, '0')}:00.000Z`)
    ));
    renderGallery({ galleryRows: loaded });
    const user = userEvent.setup();
    await screen.findByText('p1.jpg');

    await user.click(screen.getByRole('button', { name: 'Select photos' }));
    expect(screen.getByRole('button', { name: 'Select all 48 loaded photos' })).toBeVisible();
  });

  it('withdraws the shared settings escape while a guest-list commit holds the destinations', async () => {
    const onOpenSettings = vi.fn();
    vi.stubGlobal('fetch', managerFetch({ guestGalleryVisible: false }));
    renderWorkspaceWithUndo(<ManagerGalleryWorkspace
      event={{ ...event, galleryVisible: false }}
      eventId="event-a"
      galleryMutationEpoch={0}
      invalidateGalleryAfterMutation={vi.fn()}
      audience={audienceAuthority(rows, false)}
      onAnnouncement={vi.fn()}
      shared={{
        media: [],
        status: 'unpublished',
        selected: [],
        selectionAtLimit: false,
        onStatusChange: vi.fn(),
        onSelectedChange: vi.fn(),
        onBulk: noop,
        onChangePublication: noop,
        onOpenSettings,
        settingsBlocked: true,
        loadingMore: false,
        hasMore: false,
        onLoadMore: noop,
      }}
      exports={{
        onPrepare: noop,
        onDownload: noop,
        onRetry: noop,
        currentSource: { count: event.storedMediaCount, freshness: 'fresh' },
      }}
    />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Guest gallery' }));

    const escape = screen.getByRole('button', { name: 'Open settings' });
    expect(escape).toBeDisabled();
    await user.click(escape);
    expect(onOpenSettings).not.toHaveBeenCalled();
  });
});

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EventView, ManagerGalleryMediaView } from '../../shared/contracts';
import { DEFAULT_GUESTBOOK_PROMPT } from '../../shared/constants';
import { resolveEventTheme } from '../../shared/event-theme';
import { ManagerGalleryWorkspace } from '../../src/features/gallery/ManagerGalleryWorkspace';
import type { ExportDownloadView, ExportView } from '../../src/app/types';

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
  storedBytes: 1024,
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
    previewAvailable: false,
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

function managerFetch(overrides: {
  galleryRows?: ManagerGalleryMediaView[];
  favoriteFails?: boolean;
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
      return success({ media: result, nextCursor: null });
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

function renderGallery(overrides: {
  galleryRows?: ManagerGalleryMediaView[];
  favoriteFails?: boolean;
  exportJob?: ExportView;
  exportDownload?: ExportDownloadView;
  status?: 'all' | 'unpublished' | 'published' | 'hidden';
} = {}) {
  const fetchMock = managerFetch(overrides);
  vi.stubGlobal('fetch', fetchMock);
  const onPrepare = vi.fn(noop);
  const onStatusChange = vi.fn();
  render(<ManagerGalleryWorkspace
    event={event}
    eventId="event-a"
    shared={{
      media: [],
      status: overrides.status ?? 'unpublished',
      selected: [],
      selectionAtLimit: false,
      onStatusChange,
      onSelectedChange: vi.fn(),
      onBulk: noop,
      onChangePublication: noop,
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
    }}
  />);
  return { fetchMock, onPrepare, onStatusChange };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('host private gallery', () => {
  it('opens the private timeline with moments, the event total, and no moderation controls', async () => {
    const { fetchMock } = renderGallery();

    expect(await screen.findByRole('heading', { name: 'Private gallery' })).toBeVisible();
    expect(screen.getByText('842 photos')).toBeVisible();
    expect(await screen.findByText('Saturday, August 15 · 5:42–6:18 PM')).toBeVisible();
    expect(await screen.findByText('Saturday, August 15, 11:48 PM–Sunday, August 16, 12:24 AM')).toBeVisible();
    expect(screen.queryByRole('button', { name: /publish selected/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();

    const galleryCalls = fetchMock.mock.calls.map(([input]) => new URL(String(input), 'https://candidary.test'));
    expect(galleryCalls.filter(({ pathname }) => pathname.endsWith('/gallery'))).toHaveLength(1);
  });

  it('searches, clears, and shows the no-match state without losing the active query', async () => {
    renderGallery();
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Private gallery' });

    await user.type(screen.getByLabelText('Find photos'), 'Maya');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('From Maya')).toBeVisible();
    expect(screen.queryByText('From Jose')).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Find photos'), 'missing-person');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByRole('heading', { name: 'No photos match this search.' })).toBeVisible();
    expect(await screen.findByRole('button', { name: 'Clear search' })).toBeVisible();
  });

  it('filters to favorites and patches a favorited tile in place without a refetch', async () => {
    const { fetchMock } = renderGallery();
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Private gallery' });

    const galleryGets = () => fetchMock.mock.calls
      .filter(([input, init]) => {
        const url = new URL(String(input), 'https://candidary.test');
        return url.pathname.endsWith('/gallery') && (init?.method ?? 'GET') === 'GET';
      });
    const before = galleryGets().length;

    const favoriteTile = await screen.findByRole('button', { name: /favorite p1/i });
    await user.click(favoriteTile);
    await waitFor(() => expect(screen.getByRole('button', { name: /favorite p1/i })).toHaveAttribute('aria-pressed', 'true'));
    expect(galleryGets().length).toBe(before);

    await user.click(screen.getByRole('button', { name: 'Favorites' }));
    expect(await screen.findByText('First dance')).toBeVisible();
    expect(screen.getByText(/p4\.jpg/)).toBeVisible();
  });

  it('restores the confirmed favorite state and shows a notice when a favorite write fails', async () => {
    renderGallery({ favoriteFails: true });
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Private gallery' });

    await user.click(await screen.findByRole('button', { name: /favorite p1/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('manager action');
    await waitFor(() => expect(screen.getByRole('button', { name: /favorite p1/i }))
      .toHaveAttribute('aria-pressed', 'false'));
  });

  it('opens the immersive viewer, navigates, and restores focus on close', async () => {
    renderGallery();
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Private gallery' });

    const origin = await screen.findByRole('button', { name: /open p1/i });
    await user.click(origin);
    const dialog = await screen.findByRole('dialog', { name: /p1\.jpg/ });
    expect(within(dialog).getByText('First dance')).toBeVisible();
    expect(within(dialog).getByText('From Jose')).toBeVisible();

    await user.keyboard('{ArrowRight}');
    expect(within(dialog).queryByText('First dance')).not.toBeInTheDocument();
    expect(within(dialog).getAllByText(/p2\.jpg/).length).toBeGreaterThan(0);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open p2/i })).toHaveFocus();
  });

  it('switches to the shared workspace on unpublished and back to a preserved private view', async () => {
    const { onStatusChange } = renderGallery();
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Private gallery' });

    await user.click(screen.getByRole('button', { name: 'Shared gallery' }));
    expect(await screen.findByRole('heading', { name: 'Shared gallery' })).toBeVisible();
    expect(screen.getByRole('button', { name: /publish selected/i })).toBeVisible();
    expect(onStatusChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Favorites' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Private gallery' }));
    expect(await screen.findByRole('heading', { name: 'Private gallery' })).toBeVisible();
    expect(screen.getByText('Saturday, August 15 · 5:42–6:18 PM')).toBeVisible();
  });

  it('starts the complete export from the one Download all action', async () => {
    const { onPrepare } = renderGallery();
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Private gallery' });

    await user.click(screen.getByRole('button', { name: 'Download all' }));
    expect(onPrepare).toHaveBeenCalledTimes(1);
  });

  it('shows the ready export job with its named contents instead of a second entry point', async () => {
    renderGallery({
      exportJob: {
        id: 'export-a',
        state: 'ready',
        snapshotAt: '2026-09-19T00:00:00Z',
        mediaCount: 842,
        totalBytes: 1024,
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
      },
    });
    await screen.findByRole('heading', { name: 'Private gallery' });

    expect(screen.getByRole('button', { name: 'Get download links' })).toBeVisible();
    expect(screen.getByText(/842 photos · 3 guestbook entries/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Download all' })).not.toBeInTheDocument();
  });
});

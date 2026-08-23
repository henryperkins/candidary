import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_GUESTBOOK_PROMPT } from '../../shared/constants';
import type { AlbumEntryView, EventView, ManagerGalleryMediaView } from '../../shared/contracts';
import { resolveEventTheme } from '../../shared/event-theme';
import { ManagerGalleryWorkspace } from '../../src/features/gallery/ManagerGalleryWorkspace';

afterEach(cleanup);

function success(data: unknown) {
  return Promise.resolve(new Response(JSON.stringify({ data, requestId: 'request-a' }), {
    status: 200,
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
  storedMediaCount: 4,
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

interface AlbumState {
  revision: number;
  saved: boolean;
  entries: AlbumEntryView[];
}

interface Harness {
  galleryRows: ManagerGalleryMediaView[];
  album: AlbumState;
  orderWrites: AlbumEntryView[][];
  pickWrites: { mediaIds: string[]; picked: boolean }[];
  startWrites: string[];
}

/**
 * A stand-in for the album endpoints that keeps the one invariant the real ones do:
 * membership lives in the pick bit, and the album is the picked set read in a stored
 * order. A stub that let the two drift would pass tests the product could not.
 */
function harness(overrides: Partial<Harness> = {}) {
  const state: Harness = {
    galleryRows: overrides.galleryRows ?? [
      photo('p1', '2026-08-15T22:42:00.000Z', { caption: 'First dance' }),
      photo('p2', '2026-08-15T23:18:00.000Z'),
      photo('p3', '2026-08-16T04:48:00.000Z', { guestName: 'Maya' }),
    ],
    album: overrides.album ?? { revision: 0, saved: true, entries: [] },
    orderWrites: [],
    pickWrites: [],
    startWrites: [],
  };

  function resolvedAlbum() {
    const picked = state.galleryRows.filter((item) => item.isFavorite);
    const placed = new Set<string>();
    const entries: AlbumEntryView[] = [];
    for (const entry of state.album.entries) {
      if (entry.kind === 'section') { entries.push(entry); continue; }
      const live = picked.find((item) => item.id === entry.photo.id);
      if (!live || placed.has(live.id)) continue;
      placed.add(live.id);
      entries.push({ kind: 'photo', photo: live });
    }
    for (const item of picked) {
      if (!placed.has(item.id)) entries.push({ kind: 'photo', photo: item });
    }
    return {
      revision: state.album.revision,
      saved: state.album.saved,
      entries,
      photoCount: entries.filter((entry) => entry.kind === 'photo').length,
      sectionCount: entries.filter((entry) => entry.kind === 'section').length,
    };
  }

  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'https://candidary.test');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;

    if (url.pathname.endsWith('/gallery') && method === 'GET') {
      const favorites = url.searchParams.get('favorites') === '1';
      const result = favorites
        ? state.galleryRows.filter((item) => item.isFavorite)
        : state.galleryRows;
      return success({ media: result, nextCursor: null });
    }
    if (url.pathname.endsWith('/album') && method === 'GET') {
      return success({ album: resolvedAlbum() });
    }
    if (url.pathname.endsWith('/album') && method === 'PUT') {
      const entries = (body.entries as { kind: string; mediaId?: string; id?: string; heading?: string }[])
        .map((entry): AlbumEntryView => (entry.kind === 'section'
          ? { kind: 'section', id: entry.id!, heading: entry.heading! }
          : { kind: 'photo', photo: state.galleryRows.find((item) => item.id === entry.mediaId)! }));
      state.orderWrites.push(entries);
      state.album = { revision: state.album.revision + 1, saved: true, entries };
      return success({ album: resolvedAlbum() });
    }
    if (url.pathname.endsWith('/album/picks') && method === 'POST') {
      state.pickWrites.push(body);
      const changed: ManagerGalleryMediaView[] = [];
      for (const id of body.mediaIds as string[]) {
        const item = state.galleryRows.find((candidate) => candidate.id === id);
        if (!item || item.isFavorite === body.picked) continue;
        item.isFavorite = body.picked;
        changed.push({ ...item });
      }
      return success({ changed });
    }
    if (url.pathname.endsWith('/album/start') && method === 'POST') {
      state.startWrites.push(body.start);
      let cleared: string[] = [];
      if (body.start === 'empty') {
        cleared = state.galleryRows.filter((item) => item.isFavorite).map((item) => item.id);
        for (const item of state.galleryRows) item.isFavorite = false;
      }
      state.album = { ...state.album, saved: true };
      return success({ album: resolvedAlbum(), cleared });
    }
    throw new Error(`Unexpected request ${method} ${url.pathname}${url.search}`);
  });

  return { state, fetchMock };
}

const noop = () => Promise.resolve();

function renderWorkspace(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('fetch', fetchMock);
  render(<ManagerGalleryWorkspace
    event={event}
    eventId="event-a"
    shared={{
      media: [],
      status: 'unpublished',
      selected: [],
      selectionAtLimit: false,
      onStatusChange: vi.fn(),
      onSelectedChange: vi.fn(),
      onBulk: noop,
      onChangePublication: noop,
      onOpenSettings: vi.fn(),
      settingsBlocked: false,
      loadingMore: false,
      hasMore: false,
      onLoadMore: noop,
    }}
    exports={{ onPrepare: noop, onDownload: noop, onRetry: noop }}
  />);
}

describe('gallery modes', () => {
  it('offers Library, Album and Shared, and says which one guests can see', async () => {
    const { fetchMock } = harness();
    renderWorkspace(fetchMock);
    await screen.findByRole('heading', { name: 'Gallery' });

    const modes = screen.getByRole('group', { name: 'Gallery mode' });
    expect(within(modes).getAllByRole('button')).toHaveLength(3);
    expect(screen.getByText('Every photo guests have delivered. Private to hosts.')).toBeVisible();

    await userEvent.setup().click(within(modes).getByRole('button', { name: /^Album/ }));
    expect(await screen.findByText(/picking a photo never publishes it/)).toBeVisible();
  });
});

describe('selecting photos into the album', () => {
  it('shows the tray only while a selection exists and adds the selection', async () => {
    const { state, fetchMock } = harness();
    renderWorkspace(fetchMock);
    const user = userEvent.setup();
    await screen.findByText('First dance');

    expect(screen.queryByRole('group', { name: 'Selected photos' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Select photos/ }));
    await user.click(await screen.findByRole('button', { name: /^Select First dance/ }));

    const tray = await screen.findByRole('group', { name: 'Selected photos' });
    expect(within(tray).getByText('1 photo selected')).toBeVisible();
    expect(within(tray).getByText(/never publishes anything to guests/)).toBeVisible();

    await user.click(within(tray).getByRole('button', { name: 'Add 1 to album' }));
    await waitFor(() => expect(state.pickWrites).toEqual([{ mediaIds: ['p1'], picked: true }]));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Selected photos' })).not.toBeInTheDocument());
  });

  it('offers an undo that names what survived, and reverses only what changed', async () => {
    const { state, fetchMock } = harness({
      galleryRows: [
        photo('p1', '2026-08-15T22:42:00.000Z', { caption: 'First dance' }),
        photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true }),
      ],
    });
    renderWorkspace(fetchMock);
    const user = userEvent.setup();
    await screen.findByText('First dance');

    await user.click(screen.getByRole('button', { name: /Select photos/ }));
    await user.click(await screen.findByRole('button', { name: /^Select First dance/ }));
    await user.click(await screen.findByRole('button', { name: /^Select p2\.jpg/ }));
    await user.click(await screen.findByRole('button', { name: 'Add 2 to album' }));

    // p2 was already in the album, so only p1 changed and only p1 comes back out.
    expect(await screen.findByText('1 photo added to the album. Nothing was published.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(state.pickWrites.at(-1)).toEqual({ mediaIds: ['p1'], picked: false }));
    expect(state.galleryRows.find((item) => item.id === 'p2')?.isFavorite).toBe(true);
  });
});

describe('the album', () => {
  it('asks once before adopting favorites that predate albums', async () => {
    const { state, fetchMock } = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true })],
      album: { revision: 0, saved: false, entries: [] },
    });
    renderWorkspace(fetchMock);
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Gallery' });
    await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: /^Album/ }));

    expect(await screen.findByRole('heading', { name: 'Start your album' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Start from these 1' }));
    await waitFor(() => expect(state.startWrites).toEqual(['from-picks']));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Start your album' })).not.toBeInTheDocument());
  });

  it('reorders with buttons and saves the arrangement it is showing', async () => {
    const { state, fetchMock } = harness({
      galleryRows: [
        photo('p1', '2026-08-15T22:42:00.000Z', { caption: 'First dance', isFavorite: true }),
        photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true }),
      ],
    });
    renderWorkspace(fetchMock);
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Gallery' });
    await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: /^Album/ }));

    await screen.findByRole('button', { name: /^Move First dance down/ });
    await user.click(screen.getByRole('button', { name: /^Move First dance down/ }));

    await waitFor(() => expect(state.orderWrites.at(-1)?.map((entry) => (
      entry.kind === 'photo' ? entry.photo.id : entry.id
    ))).toEqual(['p2', 'p1']));
  });

  it('adds a host-authored section rather than guessing one', async () => {
    const { state, fetchMock } = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true })],
    });
    renderWorkspace(fetchMock);
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Gallery' });
    await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: /^Album/ }));

    await user.click(await screen.findByRole('button', { name: 'Add section' }));
    await waitFor(() => expect(state.orderWrites.at(-1)?.some((entry) => entry.kind === 'section')).toBe(true));
    expect(screen.getByLabelText('Section name')).toHaveValue('New section');
  });

  it('names the delivered original when a photo leaves the album', async () => {
    const { fetchMock } = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { caption: 'First dance', isFavorite: true })],
    });
    renderWorkspace(fetchMock);
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Gallery' });
    await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: /^Album/ }));

    await user.click(await screen.findByRole('button', { name: 'Remove First dance from the album' }));
    expect(await screen.findByText('1 photo removed from the album. The original is still delivered.')).toBeVisible();
  });

  it('explains an empty album without promising publication', async () => {
    const { fetchMock } = harness({ galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z')] });
    renderWorkspace(fetchMock);
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Gallery' });
    await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: /^Album/ }));

    expect(await screen.findByRole('heading', { name: 'Your album is empty.' })).toBeVisible();
    expect(screen.getByText(/the shared gallery stays exactly as you left it/)).toBeVisible();
  });
});

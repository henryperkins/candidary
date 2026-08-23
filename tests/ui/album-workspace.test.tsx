import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_GUESTBOOK_PROMPT } from '../../shared/constants';
import type { AlbumEntryView, EventView, ExportKind, ManagerGalleryMediaView } from '../../shared/contracts';
import { resolveEventTheme } from '../../shared/event-theme';
import { ManagerGalleryWorkspace } from '../../src/features/gallery/ManagerGalleryWorkspace';
import type { ExportDownloadView, ExportView } from '../../src/app/types';

afterEach(cleanup);

function success(data: unknown) {
  return Promise.resolve(new Response(JSON.stringify({ data, requestId: 'request-a' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
}

function failure(message: string, status = 500) {
  return Promise.resolve(new Response(JSON.stringify({
    code: 'INTERNAL_ERROR', message, requestId: 'request-a',
  }), {
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
  albumReads: number;
  albumReadGates: Array<Promise<void> | undefined>;
  albumReadErrors: Array<string | undefined>;
  orderWrites: AlbumEntryView[][];
  orderRevisions: number[];
  orderGates: Promise<void>[];
  orderErrors: Array<string | undefined>;
  bytesById: Record<string, number>;
  pickWrites: { mediaIds: string[]; picked: boolean }[];
  startWrites: string[];
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
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
    albumReads: 0,
    albumReadGates: overrides.albumReadGates ?? [],
    albumReadErrors: overrides.albumReadErrors ?? [],
    orderWrites: [],
    orderRevisions: [],
    orderGates: overrides.orderGates ?? [],
    orderErrors: overrides.orderErrors ?? [],
    bytesById: overrides.bytesById ?? {},
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
      totalBytes: entries.reduce((sum, entry) => (
        entry.kind === 'photo' ? sum + (state.bytesById[entry.photo.id] ?? 64) : sum
      ), 0),
    };
  }

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
      const read = state.albumReads++;
      await state.albumReadGates[read];
      const readError = state.albumReadErrors[read];
      if (readError) return failure(readError);
      return success({ album: resolvedAlbum() });
    }
    if (url.pathname.endsWith('/album') && method === 'PUT') {
      const entries = (body.entries as { kind: string; mediaId?: string; id?: string; heading?: string }[])
        .map((entry): AlbumEntryView => (entry.kind === 'section'
          ? { kind: 'section', id: entry.id!, heading: entry.heading! }
          : { kind: 'photo', photo: state.galleryRows.find((item) => item.id === entry.mediaId)! }));
      state.orderWrites.push(entries);
      state.orderRevisions.push(body.revision as number);
      const write = state.orderWrites.length - 1;
      await state.orderGates[write];
      const writeError = state.orderErrors[write];
      if (writeError) return failure(writeError, 409);
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

function renderWorkspace(fetchMock: ReturnType<typeof vi.fn>, exportOverrides: {
  job?: ExportView;
  albumJob?: ExportView;
  activeJob?: ExportView;
  download?: ExportDownloadView;
  albumDownload?: ExportDownloadView;
  onPrepare?: (kind?: ExportKind) => Promise<void>;
} = {}) {
  vi.stubGlobal('fetch', fetchMock);
  const onPrepare = exportOverrides.onPrepare ?? vi.fn(noop);
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
    exports={{
      ...exportOverrides,
      onPrepare,
      onDownload: noop,
      onRetry: noop,
    }}
  />);
  return { onPrepare };
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
  it('starts an album-only export with the exact kind selector and disables an empty album', async () => {
    const pickedHarness = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true })],
    });
    const onPrepare = vi.fn(noop);
    renderWorkspace(pickedHarness.fetchMock, { onPrepare });
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Gallery' });
    await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: /^Album/ }));

    await user.click(await screen.findByRole('button', { name: 'Download album photos' }));
    expect(onPrepare).toHaveBeenCalledOnce();
    expect(onPrepare).toHaveBeenCalledWith('album');

    cleanup();
    const emptyHarness = harness();
    renderWorkspace(emptyHarness.fetchMock);
    await screen.findByRole('heading', { name: 'Gallery' });
    await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: /^Album/ }));
    expect(await screen.findByRole('button', { name: 'Download album photos' })).toBeDisabled();
  });

  it('drains the current and coalesced successor order saves before creating an album export', async () => {
    const firstSave = deferred();
    const successorSave = deferred();
    const controlled = harness({
      galleryRows: [
        photo('p1', '2026-08-15T22:42:00.000Z', { caption: 'First dance', isFavorite: true }),
        photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true }),
        photo('p3', '2026-08-16T04:48:00.000Z', { isFavorite: true }),
      ],
      orderGates: [firstSave.promise, successorSave.promise],
    });
    const onPrepare = vi.fn(noop);
    renderWorkspace(controlled.fetchMock, { onPrepare });
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Gallery' });
    await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: /^Album/ }));

    await user.click(await screen.findByRole('button', { name: /^Move First dance down/ }));
    await waitFor(() => expect(controlled.state.orderWrites).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: /^Move First dance down/ }));
    await user.click(screen.getByRole('button', { name: 'Download album photos' }));
    expect(onPrepare).not.toHaveBeenCalled();

    await act(async () => { firstSave.resolve(); });
    await waitFor(() => expect(controlled.state.orderWrites).toHaveLength(2));
    expect(onPrepare).not.toHaveBeenCalled();

    await act(async () => { successorSave.resolve(); });
    await waitFor(() => expect(onPrepare).toHaveBeenCalledWith('album'));
    expect(controlled.state.orderWrites[1]?.map((entry) => (
      entry.kind === 'photo' ? entry.photo.id : entry.id
    ))).toEqual(['p2', 'p3', 'p1']);
  });

  it('keeps export preparation behind the canonical reload after an order save fails', async () => {
    const save = deferred();
    const reload = deferred();
    const controlled = harness({
      galleryRows: [
        photo('p1', '2026-08-15T22:42:00.000Z', { caption: 'First dance', isFavorite: true }),
        photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true }),
      ],
      orderGates: [save.promise],
      orderErrors: ['That album changed before this order was saved.'],
    });
    const onPrepare = vi.fn(noop);
    renderWorkspace(controlled.fetchMock, { onPrepare });
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Gallery' });
    await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: /^Album/ }));

    await screen.findByRole('button', { name: /^Move First dance down/ });
    const recoveryRead = controlled.state.albumReads;
    controlled.state.albumReadGates[recoveryRead] = reload.promise;
    await user.click(screen.getByRole('button', { name: /^Move First dance down/ }));
    await user.click(screen.getByRole('button', { name: 'Download album photos' }));
    await act(async () => { save.resolve(); });
    await waitFor(() => expect(controlled.state.albumReads).toBe(recoveryRead + 1));

    const prepare = screen.getByRole('button', { name: 'Preparing album download…' });
    expect(prepare).toBeDisabled();
    await user.click(prepare);
    expect(onPrepare).not.toHaveBeenCalled();

    await act(async () => { reload.resolve(); });
    await waitFor(() => expect(prepare).toBeEnabled());
    expect(onPrepare).not.toHaveBeenCalled();
    await user.click(prepare);
    expect(onPrepare).toHaveBeenCalledOnce();
  });

  it('does not prepare from an untrusted order when canonical reload fails and retries the reload', async () => {
    const save = deferred();
    const failedReload = deferred();
    const retryReload = deferred();
    const controlled = harness({
      galleryRows: [
        photo('p1', '2026-08-15T22:42:00.000Z', { caption: 'First dance', isFavorite: true }),
        photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true }),
      ],
      orderGates: [save.promise],
      orderErrors: ['That album changed before this order was saved.'],
    });
    const onPrepare = vi.fn(noop);
    renderWorkspace(controlled.fetchMock, { onPrepare });
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Gallery' });
    await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: /^Album/ }));

    await screen.findByRole('button', { name: /^Move First dance down/ });
    const recoveryRead = controlled.state.albumReads;
    controlled.state.albumReadGates[recoveryRead] = failedReload.promise;
    controlled.state.albumReadErrors[recoveryRead] = 'The canonical album could not be reloaded.';
    controlled.state.albumReadGates[recoveryRead + 1] = retryReload.promise;
    await user.click(screen.getByRole('button', { name: /^Move First dance down/ }));
    await user.click(screen.getByRole('button', { name: 'Download album photos' }));
    await act(async () => { save.resolve(); });
    await waitFor(() => expect(controlled.state.albumReads).toBe(recoveryRead + 1));
    expect(screen.getByRole('button', { name: 'Preparing album download…' })).toBeDisabled();
    expect(onPrepare).not.toHaveBeenCalled();
    await act(async () => { failedReload.resolve(); });

    expect(await screen.findByText('The canonical album could not be reloaded.')).toBeVisible();
    expect(onPrepare).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(controlled.state.albumReads).toBe(recoveryRead + 2));
    expect(onPrepare).not.toHaveBeenCalled();

    await act(async () => { retryReload.resolve(); });
    await screen.findByRole('button', { name: 'Download album photos' });
    await user.click(screen.getByRole('button', { name: 'Download album photos' }));
    expect(onPrepare).toHaveBeenCalledOnce();
  });

  it('disables complete prepare and retry for an active album while keeping ready downloads usable', async () => {
    const activeAlbum: ExportView = {
      id: 'album-active', kind: 'album', state: 'running', attempt: 1,
      snapshotAt: '2026-08-23T12:00:00.000Z', mediaCount: 1, totalBytes: 64,
      partCount: 0, expiresAt: null, guestbookEntryCount: null, guestbookSharedCount: null,
      guestbookEventName: null, guestbookEventDate: null, guestbookEventTimezone: null,
      guestbookPrompt: null, guestbookGalleryVisible: null,
    };
    const completeJob = (state: 'failed' | 'ready'): ExportView => ({
      id: `complete-${state}`, kind: 'complete', state, attempt: 1,
      snapshotAt: '2026-08-22T12:00:00.000Z', mediaCount: 2, totalBytes: 128,
      partCount: state === 'ready' ? 1 : 0,
      expiresAt: state === 'ready' ? '2026-08-24T12:00:00.000Z' : null,
      guestbookEntryCount: 0, guestbookSharedCount: 0, guestbookEventName: 'Maya & Theo',
      guestbookEventDate: '2026-09-19', guestbookEventTimezone: 'America/Chicago',
      guestbookPrompt: DEFAULT_GUESTBOOK_PROMPT, guestbookGalleryVisible: true,
    });

    renderWorkspace(harness().fetchMock, { activeJob: activeAlbum });
    expect(await screen.findByRole('button', { name: 'Download all' })).toBeDisabled();

    cleanup();
    renderWorkspace(harness().fetchMock, { job: completeJob('failed'), activeJob: activeAlbum });
    expect(await screen.findByRole('button', { name: 'Retry export' })).toBeDisabled();

    cleanup();
    renderWorkspace(harness().fetchMock, { job: completeJob('ready'), activeJob: activeAlbum });
    expect(await screen.findByRole('button', { name: 'Get download links' })).toBeEnabled();
  });

  it('renders ordered album part links and never offers Guestbook artifacts', async () => {
    const pickedHarness = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true })],
    });
    const albumJob: ExportView = {
      id: 'album-export', kind: 'album', state: 'ready',
      snapshotAt: '2026-08-23T12:00:00.000Z', mediaCount: 2, totalBytes: 128,
      attempt: 1, partCount: 2, expiresAt: '2026-08-24T12:00:00.000Z',
      guestbookEntryCount: null, guestbookSharedCount: null, guestbookEventName: null,
      guestbookEventDate: null, guestbookEventTimezone: null, guestbookPrompt: null,
      guestbookGalleryVisible: null,
    };
    const albumDownload: ExportDownloadView = {
      manifest: { url: '/manifest', expiresAt: albumJob.expiresAt!, filename: 'manifest.csv' },
      parts: [
        { partNumber: 1, mediaCount: 1, sourceBytes: 64, url: '/part-1', expiresAt: albumJob.expiresAt!, filename: 'part-1.zip' },
        { partNumber: 2, mediaCount: 1, sourceBytes: 64, url: '/part-2', expiresAt: albumJob.expiresAt!, filename: 'part-2.zip' },
      ],
      printableGuestbook: { url: '/must-not-render.html', expiresAt: albumJob.expiresAt!, filename: 'guestbook.html' },
      privateGuestbook: { url: '/must-not-render.csv', expiresAt: albumJob.expiresAt!, filename: 'guestbook.csv' },
    };
    renderWorkspace(pickedHarness.fetchMock, { albumJob, albumDownload });
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Gallery' });
    await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: /^Album/ }));

    expect(await screen.findByRole('link', { name: /Photo part 1 of 2/ })).toHaveAttribute('href', '/part-1');
    expect(screen.getByRole('link', { name: /Photo part 2 of 2/ })).toHaveAttribute('href', '/part-2');
    expect(screen.getByRole('link', { name: 'Photo manifest' })).toHaveAttribute('href', '/manifest');
    expect(screen.queryByRole('link', { name: /guestbook/i })).not.toBeInTheDocument();
  });

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

  it('adopts the exact remaining byte total after a photo leaves the album', async () => {
    const { fetchMock } = harness({
      galleryRows: [
        photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true }),
        photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true }),
      ],
      bytesById: { p1: 1024, p2: 2048 },
    });
    renderWorkspace(fetchMock);
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Gallery' });
    await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: /^Album/ }));
    expect(await screen.findByText(/2 photos · 3 KB/)).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Remove p2.jpg from the album' }));

    expect(await screen.findByText(/1 photos · 1 KB/)).toBeVisible();
  });

  it('keeps successful removal undoable when the authoritative refresh fails', async () => {
    const { state, fetchMock } = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true })],
    });
    renderWorkspace(fetchMock);
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Gallery' });
    await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: /^Album/ }));

    await screen.findByRole('button', { name: 'Remove p1.jpg from the album' });
    state.albumReadErrors[state.albumReads] = 'The updated album could not be refreshed.';
    await user.click(screen.getByRole('button', { name: 'Remove p1.jpg from the album' }));

    expect(state.pickWrites).toEqual([{ mediaIds: ['p1'], picked: false }]);
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeEnabled();
    expect(screen.getByRole('alert')).toHaveTextContent('removed');
    expect(screen.getByRole('alert')).toHaveTextContent('could not be refreshed');
    expect(screen.getByRole('alert')).not.toHaveTextContent('could not be removed');
  });

  it('adopts a concurrent repick from the authoritative removal refresh with exact totals', async () => {
    const refresh = deferred();
    const controlled = harness({
      galleryRows: [
        photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true }),
        photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true }),
      ],
      bytesById: { p1: 1024, p2: 2048 },
    });
    renderWorkspace(controlled.fetchMock);
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Gallery' });
    await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: /^Album/ }));

    await screen.findByRole('button', { name: 'Remove p2.jpg from the album' });
    const authoritativeRead = controlled.state.albumReads;
    controlled.state.albumReadGates[authoritativeRead] = refresh.promise;
    await user.click(screen.getByRole('button', { name: 'Remove p2.jpg from the album' }));
    await waitFor(() => expect(controlled.state.albumReads).toBe(authoritativeRead + 1));
    controlled.state.galleryRows.find(({ id }) => id === 'p2')!.isFavorite = true;
    await act(async () => { refresh.resolve(); });

    expect(await screen.findByRole('button', { name: 'Remove p2.jpg from the album' })).toBeEnabled();
    expect(screen.getByText(/2 photos · 3 KB/)).toBeVisible();
  });

  it('reconciles a committed removal after the active and coalesced order saves', async () => {
    const firstSave = deferred();
    const successorSave = deferred();
    const refresh = deferred();
    const controlled = harness({
      galleryRows: [
        photo('p1', '2026-08-15T22:42:00.000Z', { caption: 'First dance', isFavorite: true }),
        photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true }),
        photo('p3', '2026-08-16T04:48:00.000Z', { isFavorite: true }),
      ],
      bytesById: { p1: 1024, p2: 2048, p3: 3072 },
      orderGates: [firstSave.promise, successorSave.promise],
    });
    renderWorkspace(controlled.fetchMock);
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Gallery' });
    await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: /^Album/ }));

    await user.click(await screen.findByRole('button', { name: /^Move First dance down/ }));
    await waitFor(() => expect(controlled.state.orderWrites).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: /^Move First dance down/ }));

    const authoritativeRead = controlled.state.albumReads;
    controlled.state.albumReadGates[authoritativeRead] = refresh.promise;
    await user.click(screen.getByRole('button', { name: 'Remove p2.jpg from the album' }));
    await waitFor(() => expect(controlled.state.pickWrites).toEqual([
      { mediaIds: ['p2'], picked: false },
    ]));
    expect(controlled.state.albumReads).toBe(authoritativeRead);
    expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled();

    // Another manager repicks p2 while both older order writes are unresolved.
    controlled.state.galleryRows.find(({ id }) => id === 'p2')!.isFavorite = true;
    await act(async () => { firstSave.resolve(); });
    await waitFor(() => expect(controlled.state.orderWrites).toHaveLength(2));
    expect(controlled.state.albumReads).toBe(authoritativeRead);

    await act(async () => { successorSave.resolve(); });
    await waitFor(() => expect(controlled.state.albumReads).toBe(authoritativeRead + 1));
    controlled.state.album.revision = 41;
    await act(async () => { refresh.resolve(); });

    expect(await screen.findByRole('button', { name: 'Remove p2.jpg from the album' })).toBeEnabled();
    expect(screen.getByText(/3 photos · 6 KB/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: /^Move First dance up/ }));
    await waitFor(() => expect(controlled.state.orderWrites).toHaveLength(3));
    expect(controlled.state.orderRevisions[2]).toBe(41);
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

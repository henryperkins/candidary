import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_GUESTBOOK_PROMPT } from '../../shared/constants';
import type {
  AlbumEntryView,
  AlbumMetadataInput,
  AlbumShareStatus,
  AlbumShareView,
  EventView,
  ExportKind,
  ManagerGalleryMediaView,
} from '../../shared/contracts';
import { resolveEventTheme } from '../../shared/event-theme';
import { ManagerGalleryWorkspace } from '../../src/features/gallery/ManagerGalleryWorkspace';
import type { LoadFailure } from '../../src/components/States';
import type { ExportDownloadView, ExportView } from '../../src/app/types';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function success(data: unknown) {
  return Promise.resolve(new Response(JSON.stringify({ data, requestId: 'request-a' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
}

function failure(message: string, status = 500, code = 'INTERNAL_ERROR') {
  return Promise.resolve(new Response(JSON.stringify({
    code, message, requestId: 'request-a',
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
  title?: string;
  description?: string;
  coverMediaId?: string | null;
}

interface Harness {
  galleryRows: ManagerGalleryMediaView[];
  album: AlbumState;
  albumReads: number;
  albumReadGates: Array<Promise<void> | undefined>;
  albumReadErrors: Array<string | undefined>;
  albumReadErrorCodes: Array<string | undefined>;
  orderWrites: AlbumEntryView[][];
  orderPaths: string[];
  orderRevisions: number[];
  metadataWrites: AlbumMetadataInput[];
  orderGates: Promise<void>[];
  orderErrors: Array<string | undefined>;
  orderErrorCodes: Array<string | undefined>;
  bytesById: Record<string, number>;
  pickWrites: { mediaIds: string[]; picked: boolean }[];
  pickGates: Array<Promise<void> | undefined>;
  pickErrors: Array<string | undefined>;
  startWrites: string[];
  share: AlbumShareStatus;
  shareWrites: Array<'share' | 'stop'>;
  shareGates: Array<Promise<void> | undefined>;
  shareReadGates: Array<Promise<void> | undefined>;
  shareReads: number;
  shareResults: AlbumShareView[];
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
    albumReadErrorCodes: overrides.albumReadErrorCodes ?? [],
    orderWrites: [],
    orderPaths: [],
    orderRevisions: [],
    metadataWrites: [],
    orderGates: overrides.orderGates ?? [],
    orderErrors: overrides.orderErrors ?? [],
    orderErrorCodes: overrides.orderErrorCodes ?? [],
    bytesById: overrides.bytesById ?? {},
    pickWrites: [],
    pickGates: overrides.pickGates ?? [],
    pickErrors: overrides.pickErrors ?? [],
    startWrites: [],
    share: overrides.share ?? null,
    shareWrites: [],
    shareGates: overrides.shareGates ?? [],
    shareReadGates: overrides.shareReadGates ?? [],
    shareReads: 0,
    shareResults: overrides.shareResults ?? [],
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
    const explicitCover = state.album.coverMediaId ?? null;
    const liveIds = new Set(entries.flatMap((entry) => (
      entry.kind === 'photo' ? [entry.photo.id] : []
    )));
    const coverMediaId = explicitCover && liveIds.has(explicitCover) ? explicitCover : null;
    const firstPhoto = entries.find((entry) => entry.kind === 'photo');
    return {
      revision: state.album.revision,
      saved: state.album.saved,
      title: state.album.title ?? 'Album',
      description: state.album.description ?? '',
      coverMediaId,
      effectiveCoverMediaId: coverMediaId
        ?? (firstPhoto?.kind === 'photo' ? firstPhoto.photo.id : null),
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
      if (readError) return failure(readError, 401, state.albumReadErrorCodes[read]);
      return success({ album: resolvedAlbum() });
    }
    if (url.pathname.endsWith('/album') && method === 'PUT') {
      const entries = (body.entries as { kind: string; mediaId?: string; id?: string; heading?: string }[])
        .map((entry): AlbumEntryView => (entry.kind === 'section'
          ? { kind: 'section', id: entry.id!, heading: entry.heading! }
          : { kind: 'photo', photo: state.galleryRows.find((item) => item.id === entry.mediaId)! }));
      state.orderWrites.push(entries);
      state.orderPaths.push(url.pathname);
      state.orderRevisions.push(body.revision as number);
      state.metadataWrites.push(body.metadata as AlbumMetadataInput);
      const write = state.orderWrites.length - 1;
      await state.orderGates[write];
      const writeError = state.orderErrors[write];
      if (writeError) return failure(writeError, 409, state.orderErrorCodes[write]);
      state.album = {
        revision: state.album.revision + 1,
        saved: true,
        entries,
        ...(body.metadata as AlbumMetadataInput),
      };
      return success({ album: resolvedAlbum() });
    }
    if (url.pathname.endsWith('/album/picks') && method === 'POST') {
      state.pickWrites.push(body);
      const write = state.pickWrites.length - 1;
      await state.pickGates[write];
      const writeError = state.pickErrors[write];
      if (writeError) return failure(writeError, 503);
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
    if (url.pathname.endsWith('/album/share') && method === 'GET') {
      const read = state.shareReads++;
      const share = state.share;
      await state.shareReadGates[read];
      return success({ share });
    }
    if (url.pathname.endsWith('/album/share') && method === 'POST') {
      const creation = state.shareWrites.filter((write) => write === 'share').length;
      state.shareWrites.push('share');
      await state.shareGates[state.shareWrites.length - 1];
      state.share = state.shareResults[creation] ?? {
        active: true,
        url: 'https://candidary.test/album#share-id.share-secret',
        sharedAt: '2026-08-23T12:00:00.000Z',
      };
      return success({ share: state.share });
    }
    if (url.pathname.endsWith('/album/share') && method === 'DELETE') {
      state.shareWrites.push('stop');
      await state.shareGates[state.shareWrites.length - 1];
      state.share = null;
      return success({ share: null });
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
} = {}, workspaceOverrides: {
  eventId?: string;
  onAlbumAccessFailure?: (failure: LoadFailure | null) => void;
} = {}) {
  vi.stubGlobal('fetch', fetchMock);
  const onPrepare = exportOverrides.onPrepare ?? vi.fn(noop);
  const props = (eventId: string) => <ManagerGalleryWorkspace
    event={event}
    eventId={eventId}
    onAlbumAccessFailure={workspaceOverrides.onAlbumAccessFailure}
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
  />;
  const rendered = render(props(workspaceOverrides.eventId ?? 'event-a'));
  return {
    onPrepare,
    rerenderForEvent(eventId: string) { rendered.rerender(props(eventId)); },
  };
}

async function openAlbum(user = userEvent.setup()) {
  await screen.findByRole('heading', { name: 'Gallery' });
  await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
    .getByRole('button', { name: /^Album/ }));
  return user;
}

describe('gallery modes', () => {
  it('offers Library, Album and Shared, and says which one guests can see', async () => {
    const { fetchMock } = harness();
    renderWorkspace(fetchMock);
    await screen.findByRole('heading', { name: 'Gallery' });

    const modes = screen.getByRole('group', { name: 'Gallery mode' });
    expect(within(modes).getAllByRole('button')).toHaveLength(3);
    expect(screen.getByText('Everything delivered privately, newest first. Picking a photo adds it to the album for every host on this event — it does not publish it.')).toBeVisible();

    await userEvent.setup().click(within(modes).getByRole('button', { name: /^Album/ }));
    expect(await screen.findByText('One album per event. Its order and sections are yours; the delivered originals stay exactly where they are.')).toBeVisible();
  });

  it('stacks the three-mode switch throughout the narrow layout range', () => {
    const styles = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');
    expect(styles).toMatch(/@media \(max-width: 760px\) \{\s*\.gallery-mode-switch--three \{ grid-template-columns: 1fr; \}/u);
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
  it('shows the exact one-time reconciliation state without save or exit controls', async () => {
    const { fetchMock } = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true })],
      album: { revision: 0, saved: false, entries: [] },
    });
    renderWorkspace(fetchMock);
    await openAlbum();

    expect(await screen.findByText('Not started yet')).toBeVisible();
    expect(screen.getByText('Before albums, there were favorites')).toBeVisible();
    expect(screen.getByRole('heading', {
      name: '1 photo was favorited before this album existed.',
    })).toBeVisible();
    expect(screen.getByText(/Album picks are the same hearts you already used/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Start the album from it' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Start empty' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Preview album' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Share album' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download album photos' })).not.toBeInTheDocument();
  });

  it('debounces one complete metadata draft for 600ms and composes overlapping edits against the returned revision', async () => {
    const firstSave = deferred();
    const { state, fetchMock } = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true })],
      album: {
        revision: 7,
        saved: true,
        entries: [],
        title: 'Album',
        description: '',
        coverMediaId: null,
      },
      orderGates: [firstSave.promise],
    });
    renderWorkspace(fetchMock);
    await openAlbum();
    const title = await screen.findByLabelText('Album title');
    const description = screen.getByLabelText('Description');

    vi.useFakeTimers();
    fireEvent.change(title, { target: { value: 'The evening' } });
    act(() => { vi.advanceTimersByTime(599); });
    expect(state.orderWrites).toHaveLength(0);
    act(() => { vi.advanceTimersByTime(1); });
    expect(state.orderWrites).toHaveLength(1);
    expect(state.orderRevisions).toEqual([7]);
    expect(state.metadataWrites[0]).toEqual({
      title: 'The evening',
      description: '',
      coverMediaId: null,
    });

    fireEvent.change(description, { target: { value: 'The photographs we kept together.' } });
    fireEvent.change(title, { target: { value: 'After party' } });
    act(() => { vi.advanceTimersByTime(600); });
    expect(state.orderWrites).toHaveLength(1);
    vi.useRealTimers();

    await act(async () => { firstSave.resolve(); });
    await waitFor(() => expect(state.orderWrites).toHaveLength(2));
    expect(state.orderRevisions).toEqual([7, 8]);
    expect(state.metadataWrites[1]).toEqual({
      title: 'After party',
      description: 'The photographs we kept together.',
      coverMediaId: null,
    });
  });

  it('keeps a blank title local, blocks preview and mode exit, and focuses the title recovery', async () => {
    const { state, fetchMock } = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true })],
    });
    renderWorkspace(fetchMock);
    const user = await openAlbum();
    const title = await screen.findByLabelText('Album title');

    await user.clear(title);
    expect(screen.getByText('Give this album a title.')).toBeVisible();
    expect(title).toHaveAttribute('aria-invalid', 'true');
    await user.click(screen.getByRole('button', { name: 'Preview album' }));
    expect(screen.queryByText('What a guest opening the link sees')).not.toBeInTheDocument();
    expect(title).toHaveFocus();

    await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: 'Library' }));
    expect(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: /^Album/ })).toHaveAttribute('aria-pressed', 'true');
    expect(title).toHaveFocus();
    expect(state.orderWrites).toHaveLength(0);
  });

  it('renders explicit and fallback covers, photo-only numbers, and independent failed preview tiles', async () => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', {
      caption: 'First dance',
      isFavorite: true,
    });
    const p2 = photo('p2', '2026-08-15T23:18:00.000Z', {
      isFavorite: true,
      previewAvailable: false,
    });
    const { fetchMock } = harness({
      galleryRows: [p1, p2],
      album: {
        revision: 3,
        saved: true,
        entries: [
          { kind: 'section', id: 's1', heading: 'Dancing' },
          { kind: 'photo', photo: p1 },
          { kind: 'photo', photo: p2 },
        ],
        coverMediaId: 'p2',
      },
    });
    renderWorkspace(fetchMock);
    const user = await openAlbum();

    expect(await screen.findByText('Cover · p2.jpg')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Use the first photo instead' })).toBeEnabled();
    const grid = document.querySelector('.album-review-grid');
    expect(grid).not.toBeNull();
    expect(within(grid as HTMLElement).getAllByTestId('album-photo-position').map((pill) => pill.textContent))
      .toEqual(['1', '2']);
    expect(within(grid as HTMLElement).getByRole('img', { name: 'p2.jpg, from Jose' }))
      .toHaveTextContent('Preview unavailable');
    expect(within(grid as HTMLElement).getByText('Cover')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Use the first photo instead' }));
    expect(screen.getByText(/Cover · first photo, until you star another · First dance/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'First dance is the album cover' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('moves entries with earlier/later controls and equivalent native drag/drop', async () => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { caption: 'First dance', isFavorite: true });
    const p2 = photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true });
    const { fetchMock } = harness({
      galleryRows: [p1, p2],
      album: {
        revision: 1,
        saved: true,
        entries: [
          { kind: 'photo', photo: p1 },
          { kind: 'section', id: 's1', heading: 'Reception' },
          { kind: 'photo', photo: p2 },
        ],
      },
    });
    renderWorkspace(fetchMock);
    const user = await openAlbum();

    await user.click(await screen.findByRole('button', { name: 'Move First dance later' }));
    expect(screen.getAllByRole('status').some((status) => (
      status.textContent?.includes('Moved to position 2 of 3.')
    ))).toBe(true);

    const firstDance = document.querySelector('[data-entry-key="photo:p1"]');
    const p2Card = document.querySelector('[data-entry-key="photo:p2"]');
    expect(firstDance).not.toBeNull();
    expect(p2Card).not.toBeNull();
    fireEvent.dragStart(firstDance as Element);
    const over = new Event('dragover', { bubbles: true, cancelable: true });
    p2Card!.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    fireEvent.drop(p2Card as Element);

    expect(screen.getAllByRole('status').some((status) => (
      status.textContent?.includes('Moved to position 3 of 3.')
    ))).toBe(true);
    expect(Array.from(document.querySelectorAll('.album-review-grid > li')).map((item) => (
      item.getAttribute('data-entry-key')
    ))).toEqual(['section:s1', 'photo:p2', 'photo:p1']);
  });

  it('trims section names and keeps section removal undoable for nine seconds while focus is inside', async () => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const { state, fetchMock } = harness({
      galleryRows: [p1],
      album: {
        revision: 2,
        saved: true,
        entries: [
          { kind: 'section', id: 's1', heading: 'Reception' },
          { kind: 'photo', photo: p1 },
        ],
      },
    });
    renderWorkspace(fetchMock);
    await openAlbum();

    const sectionName = await screen.findByLabelText('Section name');
    vi.useFakeTimers();
    fireEvent.change(sectionName, { target: { value: '  Speeches  ' } });
    fireEvent.blur(sectionName);
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(state.orderWrites.at(-1)?.[0]).toMatchObject({ kind: 'section', heading: 'Speeches' });

    fireEvent.click(screen.getByRole('button', { name: 'Remove section Speeches' }));
    expect(screen.getAllByText('Section removed.')
      .some((node) => node.classList.contains('album-undo__message'))).toBe(true);
    const undoButton = screen.getByRole('button', { name: 'Undo' });
    undoButton.focus();
    await act(async () => { await vi.advanceTimersByTimeAsync(9_000); });
    expect(undoButton).toBeVisible();

    await act(async () => {
      fireEvent.click(undoButton);
      await Promise.resolve();
    });
    expect(screen.getByDisplayValue('Speeches')).toBeVisible();
    vi.useRealTimers();
  });

  it('resets to timeline order without sections and restores the whole draft with Undo', async () => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { caption: 'First dance', isFavorite: true });
    const p2 = photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true });
    const { fetchMock } = harness({
      galleryRows: [p2, p1],
      album: {
        revision: 5,
        saved: true,
        title: 'The evening',
        description: 'In our order.',
        entries: [
          { kind: 'photo', photo: p2 },
          { kind: 'section', id: 's1', heading: 'Reception' },
          { kind: 'photo', photo: p1 },
        ],
        coverMediaId: 'p2',
      },
    });
    renderWorkspace(fetchMock);
    const user = await openAlbum();

    await user.click(await screen.findByRole('button', { name: 'Reset to timeline order' }));
    expect(screen.queryByLabelText('Section name')).not.toBeInTheDocument();
    expect(Array.from(document.querySelectorAll('.album-review-grid > li')).map((item) => (
      item.getAttribute('data-entry-key')
    ))).toEqual(['photo:p1', 'photo:p2']);
    expect(screen.getAllByText('Album order reset to the timeline. Sections were removed.')
      .some((node) => node.classList.contains('album-undo__message'))).toBe(true);
    expect(screen.getByText('Cover · p2.jpg')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByDisplayValue('Reception')).toBeVisible();
    expect(Array.from(document.querySelectorAll('.album-review-grid > li')).map((item) => (
      item.getAttribute('data-entry-key')
    ))).toEqual(['photo:p2', 'section:s1', 'photo:p1']);
    expect(screen.getByLabelText('Album title')).toHaveValue('The evening');
    expect(screen.getByLabelText('Description')).toHaveValue('In our order.');
    expect(screen.getByText('Cover · p2.jpg')).toBeVisible();
  });

  it('keeps a removed cover photo undoable with its original position and explicit cover', async () => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const p2 = photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true });
    const { fetchMock } = harness({
      galleryRows: [p1, p2],
      album: {
        revision: 2,
        saved: true,
        entries: [{ kind: 'photo', photo: p1 }, { kind: 'photo', photo: p2 }],
        coverMediaId: 'p2',
      },
    });
    renderWorkspace(fetchMock);
    const user = await openAlbum();

    await user.click(await screen.findByRole('button', { name: 'Remove p2.jpg from the album' }));
    expect((await screen.findAllByText('1 photo removed from the album. The original is still delivered.'))
      .some((node) => node.classList.contains('album-undo__message'))).toBe(true);
    expect(screen.getByText(/Cover · first photo, until you star another · p1.jpg/)).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByRole('button', { name: 'Remove p2.jpg from the album' })).toBeEnabled();
    expect(screen.getByText('Cover · p2.jpg')).toBeVisible();
    expect(Array.from(document.querySelectorAll('.album-review-grid > li')).map((item) => (
      item.getAttribute('data-entry-key')
    ))).toEqual(['photo:p1', 'photo:p2']);
  });

  it('does not restore a removed explicit cover after the host chooses and then clears a newer cover', async () => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const p2 = photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true });
    const p3 = photo('p3', '2026-08-16T04:48:00.000Z', { isFavorite: true });
    const { state, fetchMock } = harness({
      galleryRows: [p1, p2, p3],
      album: {
        revision: 2,
        saved: true,
        entries: [
          { kind: 'photo', photo: p1 },
          { kind: 'photo', photo: p2 },
          { kind: 'photo', photo: p3 },
        ],
        coverMediaId: 'p2',
      },
    });
    renderWorkspace(fetchMock);
    const user = await openAlbum();

    await user.click(await screen.findByRole('button', { name: 'Remove p2.jpg from the album' }));
    await screen.findByRole('button', { name: 'Undo' });
    await user.click(screen.getByRole('button', { name: 'Use p3.jpg as the album cover' }));
    await user.click(screen.getByRole('button', { name: 'Use the first photo instead' }));
    await user.click(screen.getByRole('button', { name: 'Undo' }));

    await screen.findByRole('button', { name: 'Remove p2.jpg from the album' });
    await waitFor(() => expect(state.metadataWrites.at(-1)?.coverMediaId).toBeNull());
    expect(screen.getByText(/Cover · first photo, until you star another · p1.jpg/)).toBeVisible();
  });

  it('replaces editing with an inline grouped preview and keeps failed photos named', async () => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { caption: 'First dance', isFavorite: true });
    const p2 = photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true, previewAvailable: false });
    const { fetchMock } = harness({
      galleryRows: [p1, p2],
      album: {
        revision: 2,
        saved: true,
        title: 'The evening',
        description: 'The photographs we kept together.',
        entries: [
          { kind: 'photo', photo: p1 },
          { kind: 'section', id: 's1', heading: 'Reception' },
          { kind: 'photo', photo: p2 },
        ],
      },
    });
    renderWorkspace(fetchMock);
    const user = await openAlbum();

    await user.click(await screen.findByRole('button', { name: 'Preview album' }));
    expect(await screen.findByText('What a guest opening the link sees')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'The evening' })).toBeVisible();
    expect(screen.getByText('The photographs we kept together.')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Reception' })).toBeVisible();
    expect(screen.getByRole('img', { name: 'p2.jpg, from Jose' })).toHaveTextContent('Preview unavailable');
    expect(screen.queryByLabelText('Album title')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to editing' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Back to editing' }));
    expect(await screen.findByLabelText('Album title')).toHaveValue('The evening');
  });

  it('shares, copies for 2.2 seconds, and stops the album without changing publication', async () => {
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    const { state, fetchMock } = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true })],
    });
    renderWorkspace(fetchMock);
    const user = await openAlbum();

    await user.click(await screen.findByRole('button', { name: 'Share album' }));
    expect(await screen.findByText('Anyone holding this link can see the album. It does not change what the shared gallery shows.')).toBeVisible();
    expect(state.shareWrites).toEqual(['share']);
    expect(screen.getByText('https://candidary.test/album#share-id.share-secret')).toBeVisible();

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Copy album link' }));
    await act(async () => { await Promise.resolve(); });
    expect(writeText).toHaveBeenCalledWith('https://candidary.test/album#share-id.share-secret');
    expect(screen.getByRole('button', { name: 'Copied' })).toBeVisible();
    act(() => { vi.advanceTimersByTime(2_199); });
    expect(screen.getByRole('button', { name: 'Copied' })).toBeVisible();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.getByRole('button', { name: 'Copy album link' })).toBeVisible();
    vi.useRealTimers();

    await user.click(screen.getByRole('button', { name: 'Stop sharing album' }));
    await waitFor(() => expect(state.shareWrites).toEqual(['share', 'stop']));
    expect(screen.queryByText('https://candidary.test/album#share-id.share-secret')).not.toBeInTheDocument();
    expect(state.galleryRows[0]?.publicationStatus).toBe('unpublished');
  });

  it('waits for the newest complete draft before creating a share credential', async () => {
    const save = deferred();
    const { state, fetchMock } = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true })],
      orderGates: [save.promise],
    });
    renderWorkspace(fetchMock);
    const user = await openAlbum();

    fireEvent.change(await screen.findByLabelText('Album title'), { target: { value: 'Ready to share' } });
    await user.click(screen.getByRole('button', { name: 'Share album' }));
    expect(state.metadataWrites.at(-1)?.title).toBe('Ready to share');
    expect(state.shareWrites).toEqual([]);

    await act(async () => { save.resolve(); });
    await waitFor(() => expect(state.shareWrites).toEqual(['share']));
  });

  it('flushes the latest draft before preview and before leaving Album', async () => {
    const save = deferred();
    const { state, fetchMock } = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true })],
      orderGates: [save.promise],
    });
    renderWorkspace(fetchMock);
    const user = await openAlbum();

    fireEvent.change(await screen.findByLabelText('Album title'), { target: { value: 'Latest draft' } });
    await user.click(screen.getByRole('button', { name: 'Preview album' }));
    expect(state.metadataWrites.at(-1)?.title).toBe('Latest draft');
    expect(screen.queryByText('What a guest opening the link sees')).not.toBeInTheDocument();
    await act(async () => { save.resolve(); });
    expect(await screen.findByText('What a guest opening the link sees')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Back to editing' }));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Still saving.' } });
    await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: 'Library' }));
    await waitFor(() => expect(state.metadataWrites.at(-1)?.description).toBe('Still saving.'));
    expect(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: 'Library' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('reloads and keeps Album active when a flushed draft loses the revision race', async () => {
    const { fetchMock } = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true })],
      album: { revision: 9, saved: true, entries: [], title: 'Canonical', description: '' },
      orderErrors: ['This album changed while you were arranging it. Reopen Album to see the current order.'],
      orderErrorCodes: ['REVISION_CONFLICT'],
    });
    renderWorkspace(fetchMock);
    const user = await openAlbum();

    fireEvent.change(await screen.findByLabelText('Album title'), { target: { value: 'Losing draft' } });
    await user.click(screen.getByRole('button', { name: 'Preview album' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('This album changed while you were arranging it.');
    expect(screen.getByLabelText('Album title')).toHaveValue('Canonical');
    expect(screen.queryByText('What a guest opening the link sees')).not.toBeInTheDocument();
  });

  it('keeps Album active and focuses recovery when a flushed save and its canonical reload fail', async () => {
    const controlled = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true })],
      orderErrors: ['That album changed before this draft was saved.'],
      orderErrorCodes: ['REVISION_CONFLICT'],
    });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();

    const recoveryRead = controlled.state.albumReads;
    controlled.state.albumReadErrors[recoveryRead] = 'The canonical album could not be reloaded.';
    fireEvent.change(await screen.findByLabelText('Album title'), { target: { value: 'Unsaved title' } });
    await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: 'Library' }));

    const retry = await screen.findByRole('button', { name: 'Try again' });
    expect(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: /^Album/ })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(retry).toHaveFocus());
  });

  it('navigates an empty album back to Library', async () => {
    const { fetchMock } = harness();
    renderWorkspace(fetchMock);
    const user = await openAlbum();

    expect(await screen.findByRole('heading', { name: 'The album is empty.' })).toBeVisible();
    expect(screen.getByText('Pick photos in Library. A pick adds the photo to this album for every host on this event. It does not publish it.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Go to Library' }));
    expect(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: 'Library' })).toHaveAttribute('aria-pressed', 'true');
  });

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

    await user.click(await screen.findByRole('button', { name: /^Move First dance later/ }));
    await waitFor(() => expect(controlled.state.orderWrites).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: /^Move First dance later/ }));
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
      orderErrorCodes: ['REVISION_CONFLICT'],
    });
    const onPrepare = vi.fn(noop);
    renderWorkspace(controlled.fetchMock, { onPrepare });
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Gallery' });
    await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: /^Album/ }));

    await screen.findByRole('button', { name: /^Move First dance later/ });
    const recoveryRead = controlled.state.albumReads;
    controlled.state.albumReadGates[recoveryRead] = reload.promise;
    await user.click(screen.getByRole('button', { name: /^Move First dance later/ }));
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
      orderErrorCodes: ['REVISION_CONFLICT'],
    });
    const onPrepare = vi.fn(noop);
    renderWorkspace(controlled.fetchMock, { onPrepare });
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Gallery' });
    await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: /^Album/ }));

    await screen.findByRole('button', { name: /^Move First dance later/ });
    const recoveryRead = controlled.state.albumReads;
    controlled.state.albumReadGates[recoveryRead] = failedReload.promise;
    controlled.state.albumReadErrors[recoveryRead] = 'The canonical album could not be reloaded.';
    controlled.state.albumReadGates[recoveryRead + 1] = retryReload.promise;
    await user.click(screen.getByRole('button', { name: /^Move First dance later/ }));
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

    expect(await screen.findByRole('heading', { name: '1 photo was favorited before this album existed.' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Start the album from it' }));
    await waitFor(() => expect(state.startWrites).toEqual(['from-picks']));
    await waitFor(() => expect(screen.queryByRole('heading', { name: '1 photo was favorited before this album existed.' })).not.toBeInTheDocument());
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

    await screen.findByRole('button', { name: /^Move First dance later/ });
    await user.click(screen.getByRole('button', { name: /^Move First dance later/ }));

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

    await user.click(await screen.findByRole('button', { name: 'Add a section' }));
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
    expect((await screen.findAllByText('1 photo removed from the album. The original is still delivered.'))
      .some((node) => node.classList.contains('album-undo__message'))).toBe(true);
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
    const refreshAlert = await screen.findByRole('alert');
    expect(refreshAlert).toHaveTextContent('removed');
    expect(refreshAlert).toHaveTextContent('could not be refreshed');
    expect(refreshAlert).not.toHaveTextContent('could not be removed');
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

    await user.click(await screen.findByRole('button', { name: /^Move First dance later/ }));
    await waitFor(() => expect(controlled.state.orderWrites).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: /^Move First dance later/ }));

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

    await user.click(screen.getByRole('button', { name: /^Move First dance earlier/ }));
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

    expect(await screen.findByRole('heading', { name: 'The album is empty.' })).toBeVisible();
    expect(screen.getByText('Pick photos in Library. A pick adds the photo to this album for every host on this event. It does not publish it.')).toBeVisible();
  });
});

describe('album review regressions', () => {
  it('revokes an active share immediately even when the empty draft is invalid', async () => {
    const activeShare = {
      active: true as const,
      url: 'https://candidary.test/album#active.share',
      sharedAt: '2026-08-23T12:00:00.000Z',
    };
    const { state, fetchMock } = harness({ share: activeShare });
    renderWorkspace(fetchMock);
    const user = await openAlbum();
    await user.clear(await screen.findByLabelText('Album title'));

    await user.click(screen.getByRole('button', { name: 'Stop sharing album' }));

    await waitFor(() => expect(state.shareWrites).toEqual(['stop']));
    expect(state.orderWrites).toHaveLength(0);
  });

  it('adopts the complete final save response after a coalesced edit, including live membership', async () => {
    const firstSave = deferred();
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const p2 = photo('p2', '2026-08-15T23:18:00.000Z');
    const controlled = harness({ galleryRows: [p1, p2], orderGates: [firstSave.promise] });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();

    fireEvent.change(await screen.findByLabelText('Album title'), { target: { value: 'Visible title' } });
    await user.click(screen.getByRole('button', { name: 'Preview album' }));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Newest intent' } });
    controlled.state.galleryRows[1]!.isFavorite = true;
    await act(async () => { firstSave.resolve(); });

    expect(await screen.findByText('What a guest opening the link sees')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Back to editing' }));
    expect(await screen.findByRole('button', { name: 'Remove p2.jpg from the album' })).toBeEnabled();
    expect(screen.getByLabelText('Description')).toHaveValue('Newest intent');
  });

  it('composes removal against the latest draft and never lets its refresh cancel newer intent', async () => {
    const unpick = deferred();
    const refresh = deferred();
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const p2 = photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true });
    const controlled = harness({
      galleryRows: [p1, p2],
      pickGates: [unpick.promise],
    });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();
    const read = controlled.state.albumReads;
    controlled.state.albumReadGates[read] = refresh.promise;

    await user.click(await screen.findByRole('button', { name: 'Remove p1.jpg from the album' }));
    fireEvent.change(screen.getByLabelText('Album title'), { target: { value: 'Kept during removal' } });
    await user.click(screen.getByRole('button', { name: 'Use p2.jpg as the album cover' }));
    await act(async () => { unpick.resolve(); });
    await waitFor(() => expect(controlled.state.albumReads).toBe(read + 1));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Kept during refresh' } });
    await act(async () => { refresh.resolve(); });

    expect(screen.getByLabelText('Album title')).toHaveValue('Kept during removal');
    expect(screen.getByLabelText('Description')).toHaveValue('Kept during refresh');
    expect(await screen.findByText('Cover · p2.jpg')).toBeVisible();
  });

  it('keeps Album mounted until membership and its authoritative reconciliation both settle', async () => {
    const unpick = deferred();
    const refresh = deferred();
    const controlled = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true })],
      pickGates: [unpick.promise],
    });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();
    const read = controlled.state.albumReads;
    controlled.state.albumReadGates[read] = refresh.promise;

    await user.click(await screen.findByRole('button', { name: 'Remove p1.jpg from the album' }));
    await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: 'Library' }));
    expect(screen.getByLabelText('Album title')).toBeVisible();
    await act(async () => { unpick.resolve(); });
    await waitFor(() => expect(controlled.state.albumReads).toBe(read + 1));
    expect(screen.getByLabelText('Album title')).toBeVisible();
    await act(async () => { refresh.resolve(); });
    await waitFor(() => expect(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: 'Library' })).toHaveAttribute('aria-pressed', 'true'));
  });

  it('undoes only a removed section so later metadata, cover, and reorder intent survives', async () => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const p2 = photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true });
    const { fetchMock } = harness({
      galleryRows: [p1, p2],
      album: {
        revision: 4,
        saved: true,
        entries: [
          { kind: 'section', id: 's1', heading: 'Reception' },
          { kind: 'photo', photo: p1 },
          { kind: 'photo', photo: p2 },
        ],
      },
    });
    renderWorkspace(fetchMock);
    const user = await openAlbum();

    await user.click(await screen.findByRole('button', { name: 'Remove section Reception' }));
    fireEvent.change(screen.getByLabelText('Album title'), { target: { value: 'Later title' } });
    await user.click(screen.getByRole('button', { name: 'Use p2.jpg as the album cover' }));
    await user.click(screen.getByRole('button', { name: 'Move p2.jpg earlier' }));
    await user.click(screen.getByRole('button', { name: 'Undo' }));

    expect(screen.getByLabelText('Album title')).toHaveValue('Later title');
    expect(screen.getByText('Cover · p2.jpg')).toBeVisible();
    expect(Array.from(document.querySelectorAll('.album-review-grid > li')).map((item) => (
      item.getAttribute('data-entry-key')
    ))).toEqual(['photo:p2', 'section:s1', 'photo:p1']);
  });

  it('keeps a rejected photo undo retryable and holds expiry until both pointer and focus leave', async () => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const controlled = harness({ galleryRows: [p1], pickErrors: [undefined, 'Could not restore the photo.'] });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();
    await user.click(await screen.findByRole('button', { name: 'Remove p1.jpg from the album' }));
    const undoButton = await screen.findByRole('button', { name: 'Undo' });

    vi.useFakeTimers();
    const bar = undoButton.closest('.album-undo__bar')!;
    fireEvent.pointerEnter(bar);
    undoButton.focus();
    fireEvent.pointerLeave(bar);
    await act(async () => { await vi.advanceTimersByTimeAsync(9_000); });
    expect(undoButton).toBeVisible();
    vi.useRealTimers();

    await user.click(undoButton);
    expect(await screen.findByText('Could not restore the photo.', { selector: '.album-undo__error' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByRole('button', { name: 'Remove p1.jpg from the album' })).toBeEnabled();
  });

  it.each([
    [40, 'An album holds up to 40 sections.'],
    [500, 'An album holds up to 500 photos and sections.'],
  ] as const)('enforces the local album bound at %i entries', async (count, message) => {
    const entries = Array.from({ length: count }, (_, index): AlbumEntryView => ({
      kind: 'section', id: `s${index}`, heading: `Section ${index + 1}`,
    }));
    const { state, fetchMock } = harness({ album: { revision: 2, saved: true, entries } });
    renderWorkspace(fetchMock);
    const user = await openAlbum();
    await user.click(await screen.findByRole('button', { name: 'Add a section' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(state.orderWrites).toHaveLength(0);
  });

  it('reloads only REVISION_CONFLICT and leaves ALBUM_FULL as a retryable save failure', async () => {
    const controlled = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true })],
      orderErrors: ['The album reached its entry limit.'],
      orderErrorCodes: ['ALBUM_FULL'],
    });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();
    const reads = controlled.state.albumReads;
    fireEvent.change(await screen.findByLabelText('Album title'), { target: { value: 'At the limit' } });
    await user.click(screen.getByRole('button', { name: 'Preview album' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The album reached its entry limit.');
    expect(controlled.state.albumReads).toBe(reads);
    expect(screen.getByRole('button', { name: 'Retry album' })).toBeEnabled();
  });

  it('keeps every exit behind a failed membership refresh until canonical retry succeeds', async () => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const p2 = photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true });
    const controlled = harness({
      galleryRows: [p1, p2],
      albumReadErrors: [undefined, undefined, 'The trusted album could not be refreshed.'],
    });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();
    await user.click(await screen.findByRole('button', { name: 'Remove p1.jpg from the album' }));
    const refreshAlert = await screen.findByRole('alert');
    expect(refreshAlert).toHaveTextContent('The photo was removed, but the album could not be refreshed.');
    await user.click(within(refreshAlert).getByRole('button', { name: 'Dismiss error' }));
    expect(screen.queryByRole('button', { name: 'Retry album refresh' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Preview album' }));
    expect(screen.queryByText('What a guest opening the link sees')).not.toBeInTheDocument();
    const retry = await screen.findByRole('button', { name: 'Retry album refresh' });
    expect(retry).toHaveFocus();

    const readsBeforeRetry = controlled.state.albumReads;
    await user.click(retry);
    await waitFor(() => expect(controlled.state.albumReads).toBeGreaterThan(readsBeforeRetry));
    await user.click(screen.getByRole('button', { name: 'Preview album' }));
    expect(await screen.findByText('What a guest opening the link sees')).toBeVisible();
  });

  it('rebases an edit made while a conflict canonical GET is pending', async () => {
    const conflictRead = deferred();
    const controlled = harness({
      albumReadGates: [undefined, undefined, conflictRead.promise],
      orderErrors: ['A co-host saved a newer album.'],
      orderErrorCodes: ['REVISION_CONFLICT'],
    });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();
    fireEvent.change(await screen.findByLabelText('Album title'), { target: { value: 'Losing edit' } });
    await user.click(screen.getByRole('button', { name: 'Preview album' }));
    await waitFor(() => expect(controlled.state.albumReads).toBe(3));

    fireEvent.change(screen.getByLabelText('Album title'), { target: { value: 'Edit made during reload' } });
    conflictRead.resolve();

    await waitFor(() => expect(controlled.state.metadataWrites.at(-1)?.title).toBe('Edit made during reload'));
    expect(screen.getByLabelText('Album title')).toHaveValue('Edit made during reload');
    expect(screen.queryByText('What a guest opening the link sees')).not.toBeInTheDocument();
  });

  it('rebases only edits made after a rejected snapshot onto the co-host canonical draft', async () => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const p2 = photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true });
    const conflictRead = deferred();
    const controlled = harness({
      galleryRows: [p1, p2],
      album: {
        revision: 4,
        saved: true,
        title: 'Before either host',
        description: 'Before either host.',
        entries: [{ kind: 'photo', photo: p1 }, { kind: 'photo', photo: p2 }],
      },
      albumReadGates: [undefined, undefined, conflictRead.promise],
      orderErrors: ['A co-host saved a newer album.'],
      orderErrorCodes: ['REVISION_CONFLICT'],
    });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();

    fireEvent.change(await screen.findByLabelText('Album title'), { target: { value: 'Losing title' } });
    await user.click(screen.getByRole('button', { name: 'Move p1.jpg later' }));
    await user.click(screen.getByRole('button', { name: 'Preview album' }));
    await waitFor(() => expect(controlled.state.albumReads).toBe(3));

    controlled.state.album = {
      revision: 5,
      saved: true,
      title: 'Co-host title',
      description: 'Co-host description.',
      entries: [{ kind: 'photo', photo: p1 }, { kind: 'photo', photo: p2 }],
      coverMediaId: null,
    };
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Only this edit is newer.' } });
    conflictRead.resolve();

    await waitFor(() => expect(controlled.state.orderWrites).toHaveLength(2));
    expect(controlled.state.metadataWrites[1]).toEqual({
      title: 'Co-host title',
      description: 'Only this edit is newer.',
      coverMediaId: null,
    });
    expect(controlled.state.orderWrites[1]?.map((entry) => (
      entry.kind === 'photo' ? `photo:${entry.photo.id}` : `section:${entry.id}`
    )))
      .toEqual(['photo:p1', 'photo:p2']);
    expect(screen.getByLabelText('Album title')).toHaveValue('Co-host title');
  });

  it('replays the actual moved key over canonical order instead of inferring an LCS move', async () => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const p2 = photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true });
    const p3 = photo('p3', '2026-08-16T04:48:00.000Z', { isFavorite: true });
    const conflictRead = deferred();
    const controlled = harness({
      galleryRows: [p1, p2, p3],
      album: {
        revision: 4,
        saved: true,
        entries: [
          { kind: 'photo', photo: p1 },
          { kind: 'photo', photo: p2 },
          { kind: 'photo', photo: p3 },
        ],
      },
      albumReadGates: [undefined, undefined, conflictRead.promise],
      orderErrors: ['A co-host saved a newer album.'],
      orderErrorCodes: ['REVISION_CONFLICT'],
    });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();

    fireEvent.change(await screen.findByLabelText('Album title'), { target: { value: 'Losing edit' } });
    await user.click(screen.getByRole('button', { name: 'Preview album' }));
    await waitFor(() => expect(controlled.state.albumReads).toBe(3));

    controlled.state.album = {
      revision: 5,
      saved: true,
      entries: [
        { kind: 'photo', photo: p1 },
        { kind: 'photo', photo: p3 },
        { kind: 'photo', photo: p2 },
      ],
    };
    await user.click(screen.getByRole('button', { name: 'Move p1.jpg later' }));
    conflictRead.resolve();

    await waitFor(() => expect(controlled.state.orderWrites).toHaveLength(2));
    expect(controlled.state.orderWrites[1]?.map((entry) => (
      entry.kind === 'photo' ? entry.photo.id : entry.id
    ))).toEqual(['p3', 'p2', 'p1']);
  });

  it('replays a post-rejection section insert, rename, and anchor removal in action order', async () => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const conflictRead = deferred();
    const controlled = harness({
      galleryRows: [p1],
      album: {
        revision: 4,
        saved: true,
        entries: [
          { kind: 'photo', photo: p1 },
          { kind: 'section', id: 'keep', heading: 'Keep' },
          { kind: 'section', id: 'anchor', heading: 'Remove me' },
        ],
      },
      albumReadGates: [undefined, undefined, conflictRead.promise],
      orderErrors: ['A co-host saved a newer album.'],
      orderErrorCodes: ['REVISION_CONFLICT'],
    });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();

    fireEvent.change(await screen.findByLabelText('Album title'), { target: { value: 'Losing edit' } });
    await user.click(screen.getByRole('button', { name: 'Preview album' }));
    await waitFor(() => expect(controlled.state.albumReads).toBe(3));

    controlled.state.album = {
      revision: 5,
      saved: true,
      entries: [
        { kind: 'section', id: 'anchor', heading: 'Remove me' },
        { kind: 'photo', photo: p1 },
        { kind: 'section', id: 'keep', heading: 'Keep' },
      ],
    };
    await user.click(screen.getByRole('button', { name: 'Add a section' }));
    const inserted = screen.getAllByLabelText('Section name').at(-1)!;
    await user.clear(inserted);
    await user.type(inserted, 'After party');
    fireEvent.blur(inserted);
    await user.click(screen.getByRole('button', { name: 'Remove section Remove me' }));
    conflictRead.resolve();

    await waitFor(() => expect(controlled.state.orderWrites).toHaveLength(2));
    expect(controlled.state.orderWrites[1]?.map((entry) => (
      entry.kind === 'photo' ? entry.photo.id : entry.heading
    ))).toEqual(['After party', 'p1', 'Keep']);
  });

  it('restores a section renamed after rejection when the canonical album removed it', async () => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const p2 = photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true });
    const p3 = photo('p3', '2026-08-16T04:48:00.000Z', { isFavorite: true });
    const conflictRead = deferred();
    const controlled = harness({
      galleryRows: [p1, p2, p3],
      album: {
        revision: 4,
        saved: true,
        entries: [
          { kind: 'photo', photo: p1 },
          { kind: 'section', id: 'renamed', heading: 'Original section' },
          { kind: 'photo', photo: p2 },
        ],
      },
      albumReadGates: [undefined, undefined, conflictRead.promise],
      orderErrors: ['A co-host saved a newer album.'],
      orderErrorCodes: ['REVISION_CONFLICT'],
    });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();

    fireEvent.change(await screen.findByLabelText('Album title'), { target: { value: 'Losing edit' } });
    await user.click(screen.getByRole('button', { name: 'Preview album' }));
    await waitFor(() => expect(controlled.state.albumReads).toBe(3));

    controlled.state.album = {
      revision: 5,
      saved: true,
      entries: [
        { kind: 'photo', photo: p3 },
        { kind: 'photo', photo: p1 },
        { kind: 'photo', photo: p2 },
      ],
    };
    const sectionName = screen.getByLabelText('Section name');
    fireEvent.change(sectionName, { target: { value: '  Renamed section  ' } });
    fireEvent.blur(sectionName);
    conflictRead.resolve();

    await waitFor(() => expect(controlled.state.orderWrites).toHaveLength(2));
    expect(controlled.state.orderWrites[1]?.map((entry) => (
      entry.kind === 'photo' ? entry.photo.id : entry.heading
    ))).toEqual(['p3', 'p1', 'Renamed section', 'p2']);
    expect(controlled.state.orderWrites[1]?.filter((entry) => (
      entry.kind === 'section' && entry.id === 'renamed'
    ))).toHaveLength(1);
  });

  it('keeps a scalar changed away and back while the conflict GET is pending', async () => {
    const conflictRead = deferred();
    const controlled = harness({
      album: {
        revision: 4,
        saved: true,
        title: 'Before either host',
        entries: [],
      },
      albumReadGates: [undefined, undefined, conflictRead.promise],
      orderErrors: ['A co-host saved a newer album.'],
      orderErrorCodes: ['REVISION_CONFLICT'],
    });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();
    const title = await screen.findByLabelText('Album title');

    fireEvent.change(title, { target: { value: 'Losing edit' } });
    await user.click(screen.getByRole('button', { name: 'Preview album' }));
    await waitFor(() => expect(controlled.state.albumReads).toBe(3));

    controlled.state.album = {
      revision: 5,
      saved: true,
      title: 'Co-host title',
      entries: [],
    };
    fireEvent.change(title, { target: { value: 'Temporary edit' } });
    fireEvent.change(title, { target: { value: 'Losing edit' } });
    conflictRead.resolve();

    await waitFor(() => expect(controlled.state.orderWrites).toHaveLength(2));
    expect(controlled.state.metadataWrites[1]?.title).toBe('Losing edit');
    expect(screen.getByLabelText('Album title')).toHaveValue('Losing edit');
  });

  it('escalates a non-retryable Album load and keeps one persistent Gallery live region', async () => {
    const onAlbumAccessFailure = vi.fn();
    const failed = harness({
      albumReadErrors: [undefined, 'This session has expired.'],
      albumReadErrorCodes: [undefined, 'SESSION_EXPIRED'],
    });
    renderWorkspace(failed.fetchMock, {}, { onAlbumAccessFailure });
    await openAlbum();
    await waitFor(() => expect(onAlbumAccessFailure).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'latest-link',
      retryable: false,
    })));

    cleanup();
    const loadingAlbum = deferred();
    const ready = harness({ albumReadGates: [undefined, loadingAlbum.promise] });
    renderWorkspace(ready.fetchMock);
    await openAlbum();
    await waitFor(() => expect(ready.state.albumReads).toBe(2));
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status').closest('[data-gallery-live-host]')).toBeInTheDocument();

    loadingAlbum.resolve();
    await screen.findByLabelText('Album title');
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('resets for a new event and sends its recreated queue only to that event', async () => {
    const controlled = harness();
    const rendered = renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();
    await screen.findByLabelText('Album title');

    rendered.rerenderForEvent('event-b');
    await waitFor(() => expect(within(screen.getByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: 'Library' })).toHaveAttribute('aria-pressed', 'true'));
    await openAlbum(user);
    fireEvent.change(await screen.findByLabelText('Album title'), { target: { value: 'Event B album' } });
    fireEvent.blur(screen.getByLabelText('Album title'));

    await waitFor(() => expect(controlled.state.orderPaths.at(-1)).toBe('/api/manage/events/event-b/album'));
  });

  it('clamps metadata and section headings by Unicode code point', async () => {
    const { fetchMock } = harness();
    renderWorkspace(fetchMock);
    const user = await openAlbum();
    const emoji = '💍';
    const title = await screen.findByLabelText('Album title');
    expect(title).not.toHaveAttribute('maxlength');
    fireEvent.change(title, { target: { value: emoji.repeat(121) } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: emoji.repeat(1_001) } });
    await user.click(screen.getByRole('button', { name: 'Add a section' }));
    fireEvent.change(screen.getByLabelText('Section name'), { target: { value: emoji.repeat(81) } });

    expect(Array.from((title as HTMLInputElement).value)).toHaveLength(120);
    expect(Array.from((screen.getByLabelText('Description') as HTMLTextAreaElement).value)).toHaveLength(1_000);
    expect(Array.from((screen.getByLabelText('Section name') as HTMLInputElement).value)).toHaveLength(80);
  });

  it('guards an in-flight copy and gives native drag complete transfer cleanup', async () => {
    const copy = deferred();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockReturnValue(copy.promise);
    const activeShare = {
      active: true as const,
      url: 'https://candidary.test/album#active.share',
      sharedAt: '2026-08-23T12:00:00.000Z',
    };
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const p2 = photo('p2', '2026-08-15T23:18:00.000Z', { isFavorite: true });
    const { fetchMock } = harness({ galleryRows: [p1, p2], share: activeShare });
    renderWorkspace(fetchMock);
    await openAlbum();

    const copyButton = await screen.findByRole('button', { name: 'Copy album link' });
    fireEvent.click(copyButton);
    fireEvent.click(copyButton);
    expect(writeText).toHaveBeenCalledTimes(1);
    await act(async () => { copy.resolve(); });

    const transfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), clearData: vi.fn() };
    const first = document.querySelector('[data-entry-key="photo:p1"]')!;
    fireEvent.dragStart(first, { dataTransfer: transfer });
    expect(transfer.effectAllowed).toBe('move');
    expect(transfer.setData).toHaveBeenCalled();
    fireEvent.dragEnd(first, { dataTransfer: transfer });
    expect(transfer.clearData).toHaveBeenCalled();
  });

  it('keeps section undo offered until both the removal and restoration are persisted', async () => {
    const removal = deferred();
    const restoration = deferred();
    const controlled = harness({
      album: {
        revision: 2,
        saved: true,
        entries: [{ kind: 'section', id: 's1', heading: 'Reception' }],
      },
      orderGates: [removal.promise, restoration.promise],
    });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();
    await user.click(await screen.findByRole('button', { name: 'Remove section Reception' }));
    await waitFor(() => expect(controlled.state.orderWrites).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: 'Undo' }));

    expect(screen.getByRole('button', { name: 'Undoing…' })).toBeDisabled();
    removal.resolve();
    await waitFor(() => expect(controlled.state.orderWrites).toHaveLength(2));
    expect(screen.getByRole('button', { name: 'Undoing…' })).toBeDisabled();
    restoration.resolve();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument());
  });

  it('keeps reset undo offered until the in-flight reset and restoring save both confirm', async () => {
    const reset = deferred();
    const restoration = deferred();
    const p1 = photo('p1', '2026-08-15T23:00:00.000Z', { isFavorite: true });
    const p2 = photo('p2', '2026-08-15T22:00:00.000Z', { isFavorite: true });
    const controlled = harness({
      galleryRows: [p1, p2],
      album: {
        revision: 4,
        saved: true,
        entries: [
          { kind: 'photo', photo: p1 },
          { kind: 'section', id: 's1', heading: 'Reception' },
          { kind: 'photo', photo: p2 },
        ],
      },
      orderGates: [reset.promise, restoration.promise],
    });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();
    await user.click(await screen.findByRole('button', { name: 'Reset to timeline order' }));
    await waitFor(() => expect(controlled.state.orderWrites).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: 'Undo' }));

    expect(screen.getByRole('button', { name: 'Undoing…' })).toBeDisabled();
    reset.resolve();
    await waitFor(() => expect(controlled.state.orderWrites).toHaveLength(2));
    restoration.resolve();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument());
  });

  it('keeps photo undo retryable when its authoritative refresh fails', async () => {
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const controlled = harness({ galleryRows: [p1] });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();
    await user.click(await screen.findByRole('button', { name: 'Remove p1.jpg from the album' }));
    const undo = await screen.findByRole('button', { name: 'Undo' });
    controlled.state.albumReadErrors[controlled.state.albumReads] = 'The restored album could not be refreshed.';
    await user.click(undo);

    expect(await screen.findByText(/could not be refreshed/i, { selector: '.album-undo__error' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled();
  });

  it('scopes a rejected undo and its holds to the offer that started them', async () => {
    const restore = deferred();
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const controlled = harness({
      galleryRows: [p1],
      album: {
        revision: 3,
        saved: true,
        entries: [
          { kind: 'photo', photo: p1 },
          { kind: 'section', id: 's1', heading: 'Dinner' },
          { kind: 'section', id: 's2', heading: 'Dancing' },
        ],
      },
      pickGates: [undefined, restore.promise],
      pickErrors: [undefined, 'Old photo undo failed.'],
    });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();
    await user.click(await screen.findByRole('button', { name: 'Remove p1.jpg from the album' }));
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await user.click(screen.getByRole('button', { name: 'Remove section Dinner' }));
    restore.resolve();

    expect(await screen.findByText('Section removed.', { selector: '.album-undo__message' })).toBeVisible();
    await waitFor(() => expect(screen.queryByText('Old photo undo failed.', { selector: '.album-undo__error' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled();
  });

  it('clears pointer and focus holds when a replacement undo offer is presented', async () => {
    const controlled = harness({
      album: {
        revision: 3,
        saved: true,
        entries: [
          { kind: 'section', id: 's1', heading: 'Dinner' },
          { kind: 'section', id: 's2', heading: 'Dancing' },
        ],
      },
    });
    renderWorkspace(controlled.fetchMock);
    await openAlbum();
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Remove section Dinner' }));
    fireEvent.pointerEnter(screen.getByRole('button', { name: 'Undo' }).closest('.album-undo__bar')!);
    fireEvent.click(screen.getByRole('button', { name: 'Remove section Dancing' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(9_000); });

    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('does not let clipboard completion for link A mark replacement link B copied', async () => {
    const copyA = deferred();
    vi.spyOn(navigator.clipboard, 'writeText').mockReturnValue(copyA.promise);
    const activeShare = {
      active: true as const,
      url: 'https://candidary.test/album#link-a.secret-a',
      sharedAt: '2026-08-23T12:00:00.000Z',
    };
    const replacementShare = {
      active: true as const,
      url: 'https://candidary.test/album#link-b.secret-b',
      sharedAt: '2026-08-23T12:05:00.000Z',
    };
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const controlled = harness({ galleryRows: [p1], share: activeShare, shareResults: [replacementShare] });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();
    await user.click(await screen.findByRole('button', { name: 'Copy album link' }));
    await user.click(screen.getByRole('button', { name: 'Stop sharing album' }));
    await user.click(await screen.findByRole('button', { name: 'Share album' }));
    expect(await screen.findByText(replacementShare.url)).toBeVisible();
    copyA.resolve();
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByRole('button', { name: 'Copy album link' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Copied' })).not.toBeInTheDocument();
  });

  it('resolves a native drag source by stable key after membership changes the list', async () => {
    const p1 = photo('p1', '2026-08-15T21:00:00.000Z', { isFavorite: true });
    const p2 = photo('p2', '2026-08-15T22:00:00.000Z', { isFavorite: true });
    const p3 = photo('p3', '2026-08-15T23:00:00.000Z', { isFavorite: true });
    const controlled = harness({ galleryRows: [p1, p2, p3] });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();
    const transfer = { effectAllowed: '', setData: vi.fn(), clearData: vi.fn() };
    fireEvent.dragStart(document.querySelector('[data-entry-key="photo:p2"]')!, { dataTransfer: transfer });
    await user.click(screen.getByRole('button', { name: 'Remove p1.jpg from the album' }));
    await waitFor(() => expect(document.querySelector('[data-entry-key="photo:p1"]')).not.toBeInTheDocument());
    fireEvent.drop(document.querySelector('[data-entry-key="photo:p3"]')!, { dataTransfer: transfer });

    expect(Array.from(document.querySelectorAll('.album-review-grid > li')).map((item) => (
      item.getAttribute('data-entry-key')
    ))).toEqual(['photo:p3', 'photo:p2']);
  });

  it('keeps the sole Gallery live region outside viewer inerting and updates it on movement', async () => {
    const controlled = harness();
    renderWorkspace(controlled.fetchMock);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /open first dance/i }));
    await screen.findByRole('dialog', { name: 'First dance' });
    const statuses = document.querySelectorAll('[role="status"]');
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.closest('[data-gallery-live-host]')).not.toHaveAttribute('inert');

    await user.keyboard('{ArrowRight}');
    expect(statuses[0]).toHaveTextContent('Photo 2 of 3. p2.jpg, from Jose.');
    cleanup();
    expect(document.querySelector('[data-gallery-live-host]')).not.toBeInTheDocument();
  });

  it('blocks single and bulk Library picks when sections already fill the combined entry cap', async () => {
    const entries = Array.from({ length: 500 }, (_, index): AlbumEntryView => ({
      kind: 'section', id: `s${index}`, heading: `Section ${index + 1}`,
    }));
    const controlled = harness({
      galleryRows: [photo('p1', '2026-08-15T22:42:00.000Z', { caption: 'First dance' })],
      album: { revision: 2, saved: true, entries },
    });
    renderWorkspace(controlled.fetchMock);
    const user = userEvent.setup();
    await screen.findByText('First dance');
    await user.click(screen.getByRole('button', { name: /not in the album: first dance/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('500 photos and sections');
    expect(controlled.state.pickWrites).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: /Select photos/ }));
    await user.click(screen.getByRole('button', { name: /^Select First dance/ }));
    await user.click(screen.getByRole('button', { name: 'Add 1 to album' }));
    expect(controlled.state.pickWrites).toHaveLength(0);
  });

  it('does not let a delayed initial share read overwrite a newer share mutation', async () => {
    const initialRead = deferred();
    const p1 = photo('p1', '2026-08-15T22:42:00.000Z', { isFavorite: true });
    const controlled = harness({ galleryRows: [p1], shareReadGates: [initialRead.promise] });
    renderWorkspace(controlled.fetchMock);
    const user = await openAlbum();
    await user.click(await screen.findByRole('button', { name: 'Share album' }));
    const link = await screen.findByText('https://candidary.test/album#share-id.share-secret');
    initialRead.resolve();
    await act(async () => { await Promise.resolve(); });

    expect(link).toBeVisible();
    expect(screen.getByRole('button', { name: 'Stop sharing album' })).toBeVisible();
  });
});

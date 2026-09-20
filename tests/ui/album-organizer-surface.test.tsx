import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AlbumEntryView, AlbumView, ManagerGalleryMediaView } from '../../shared/contracts';
import { ManagerAlbum } from '../../src/features/gallery/ManagerAlbum';
import { AlbumDelivery } from '../../src/features/gallery/AlbumDelivery';
import { ManagerUndoProvider } from '../../src/features/gallery/undo';

function success(data: unknown): Response {
  return new Response(JSON.stringify({ data, requestId: 'album-organizer-test' }), {
    headers: { 'content-type': 'application/json' },
  });
}

function photo(
  id: string,
  caption: string,
  guestName: string,
  timelineAt: string,
): ManagerGalleryMediaView {
  return {
    id,
    originalFilename: `${id}.jpg`,
    guestName,
    caption,
    publicationStatus: 'unpublished',
    previewAvailable: true,
    width: null,
    height: null,
    receivedAt: timelineAt,
    timelineAt,
    timelineSource: 'received',
    isFavorite: true,
  };
}

function albumFixture(): AlbumView {
  const first = photo('first', 'First dance', 'Jordan Evans', '2026-09-12T20:10:00.000Z');
  const later = photo('later', 'Late toast', 'Taylor Kim', '2026-09-12T22:10:00.000Z');
  const entries: AlbumEntryView[] = [
    { kind: 'photo', photo: first },
    { kind: 'photo', photo: later },
  ];
  return {
    revision: 1,
    saved: true,
    pickGeneration: 2,
    reconciliation: null,
    title: 'Avery & Jordan',
    description: '',
    coverMediaId: first.id,
    effectiveCoverMediaId: first.id,
    coverRetained: null,
    entries,
    photoCount: 2,
    retainedCount: 0,
    sectionCount: 0,
    totalBytes: 2048,
  };
}

function renderAlbumOrganizer() {
  let album = albumFixture();
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'https://candidary.test');
    const method = init?.method ?? 'GET';
    if (url.pathname.endsWith('/album/share') && method === 'GET') return success({ share: null });
    if (url.pathname.endsWith('/album') && method === 'GET') return success({ album });
    if (url.pathname.endsWith('/album') && method === 'PUT') {
      const body = JSON.parse(String(init?.body)) as {
        entries: Array<{ kind: 'photo'; mediaId: string } | { kind: 'section'; id: string; heading: string }>;
      };
      const currentPhotos = new Map(album.entries
        .filter((entry): entry is Extract<AlbumEntryView, { kind: 'photo' }> => entry.kind === 'photo')
        .map((entry) => [entry.photo.id, entry.photo]));
      album = {
        ...album,
        revision: album.revision + 1,
        entries: body.entries.map((entry) => entry.kind === 'section'
          ? entry
          : { kind: 'photo' as const, photo: currentPhotos.get(entry.mediaId)! }),
      };
      return success({ album });
    }
    throw new Error(`Unexpected request ${method} ${url.pathname}`);
  });
  vi.stubGlobal('fetch', fetchMock);

  render(<ManagerUndoProvider eventId="event-a">
    <ManagerAlbum
      eventId="event-a"
      eventName="Avery & Jordan"
      active
      eventTimezone="America/Chicago"
      onGoToLibrary={vi.fn()}
      onPicksChanged={vi.fn()}
      invalidateGalleryAfterMutation={vi.fn()}
      exportSource={{ count: 2, freshness: 'fresh' }}
      onPrepareExport={async () => {}}
      onDownloadExport={async () => {}}
      onRetryExport={async () => {}}
      actionDock={null}
    />
  </ManagerUndoProvider>);

  return { fetchMock };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Album organizer surface', () => {
  it('keeps filtering separate from saved order and marks future connections honestly', async () => {
    const { fetchMock } = renderAlbumOrganizer();
    const user = userEvent.setup();

    await screen.findByRole('heading', { name: 'Album' });

    const filter = screen.getByRole('searchbox', { name: 'Filter Album photos' });
    await user.type(filter, 'Taylor');
    expect(document.querySelector('[data-entry-key="photo:later"]')).toBeInTheDocument();
    expect(document.querySelector('[data-entry-key="photo:first"]')).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);

    await user.clear(filter);
    const order = screen.getByRole('combobox', { name: 'Sort Album order' });
    await user.selectOptions(order, 'newest');
    await waitFor(() => expect([...document.querySelectorAll<HTMLElement>('[data-entry-key^="photo:"]')]
      .map((entry) => entry.dataset.entryKey)).toEqual(['photo:later', 'photo:first']));

    await user.click(screen.getByRole('button', { name: 'Export' }));
    for (const destination of ['OneDrive', 'Google Photos', 'iCloud']) {
      expect(screen.getByRole('button', { name: `${destination} Coming soon` })).toBeDisabled();
    }
    expect(screen.queryByText(/Connected/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download Album' })).toBeVisible();

    await user.selectOptions(order, 'manual');
    await user.click(screen.getByRole('button', { name: 'Move Late toast later' }));
    await waitFor(() => expect([...document.querySelectorAll<HTMLElement>('[data-entry-key^="photo:"]')]
      .map(entry => entry.dataset.entryKey)).toEqual(['photo:first', 'photo:later']));

    expect(screen.queryByRole('textbox', { name: 'Album title' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Album settings' }));
    expect(screen.getByRole('textbox', { name: 'Album title' })).toBeVisible();
  });

  it('guards a pending download and makes preparation failures recoverable', async () => {
    const user = userEvent.setup();
    let rejectPreparation!: (error: Error) => void;
    const onPrepare = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectPreparation = reject; }));
    render(<AlbumDelivery heading={<h3>Album</h3>} eventTimezone="America/Chicago"
      currentSource={{ count: 2, freshness: 'fresh' }} onPrepare={onPrepare}
      onDownload={async () => {}} onRetry={async () => {}} />);

    await user.click(screen.getByRole('button', { name: 'Download Album' }));
    expect(screen.getByRole('button', { name: 'Preparing…' })).toBeDisabled();
    expect(onPrepare).toHaveBeenCalledTimes(1);
    await act(async () => rejectPreparation(new Error('Check your connection and try again.')));
    expect(await screen.findByRole('alert')).toHaveTextContent('Check your connection and try again.');
    expect(screen.getByRole('button', { name: 'Download Album' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Close album download' }));
    expect(screen.getByRole('button', { name: 'Download Album' })).toHaveFocus();
  });

  it('disables the download for an empty album and preserves an active export block', () => {
    const onPrepare = vi.fn(async () => {});
    const props = { heading: <h3>Album</h3>, eventTimezone: 'America/Chicago', onPrepare,
      onDownload: async () => {}, onRetry: async () => {} };
    const mounted = render(<AlbumDelivery {...props} currentSource={{ count: 0, freshness: 'fresh' }} />);
    expect(screen.getByRole('button', { name: 'Download Album' })).toBeDisabled();
    expect(screen.getByText('Add photos from Library to download your album.')).toBeVisible();
    mounted.rerender(<AlbumDelivery {...props} currentSource={{ count: 2, freshness: 'fresh' }}
      blockedReason="Another export is still running." />);
    expect(screen.getByRole('button', { name: 'Download Album' })).toBeDisabled();
    expect(screen.getByText('Another export is still running.')).toBeVisible();
    expect(onPrepare).not.toHaveBeenCalled();
  });
});

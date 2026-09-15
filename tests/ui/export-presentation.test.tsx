import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExportDownloadView, ExportView } from '../../src/app/types';
import { AlbumDelivery } from '../../src/features/gallery/AlbumDelivery';
import { GalleryExportControl } from '../../src/features/gallery/GalleryExportControl';

const expiresAt = '2026-09-20T00:00:00.000Z';
const managementExpiresAt = '2026-12-19T01:00:00.000Z';
const job: ExportView = {
  id: 'export-a', kind: 'complete', state: 'ready', snapshotAt: '2026-09-19T00:00:00.000Z',
  createdAt: '2026-09-19T00:00:00.000Z', startedAt: '2026-09-19T00:00:01.000Z',
  completedAt: '2026-09-19T00:00:02.000Z', mediaCount: 2, totalBytes: 128,
  processedMediaCount: 2, processedBytes: 128, progressUpdatedAt: null,
  attempt: 1, partCount: 1, expiresAt, errorCode: null,
  guestbookEntryCount: 0, guestbookSharedCount: 0, guestbookEventName: null,
  guestbookEventDate: null, guestbookEventTimezone: null, guestbookPrompt: null, guestbookGalleryVisible: null,
};
const download: ExportDownloadView = {
  manifest: { url: '/manifest', filename: 'manifest.csv', expiresAt },
  parts: [{ partNumber: 1, mediaCount: 2, sourceBytes: 128, url: '/photos', filename: 'photos.zip', expiresAt }],
  printableGuestbook: null, privateGuestbook: null,
};
const noop = async () => {};

function show(surface: 'Library' | 'Album', state: ExportView['state'] = 'ready') {
  const props = {
    eventTimezone: 'America/Chicago', managementExpiresAt,
    currentSource: { count: 2, freshness: 'fresh' as const },
    job: { ...job, state, kind: surface === 'Album' ? 'album' as const : 'complete' as const },
    download, onPrepare: noop, onDownload: noop, onRetry: vi.fn(noop),
  };
  render(surface === 'Album'
    ? <AlbumDelivery {...props} heading={<h3>Album</h3>} />
    : <GalleryExportControl {...props} resourceStatus="ready" />);
  if (surface === 'Album') fireEvent.click(screen.getByRole('button', {
    name: state === 'ready' ? 'Your prepared download is ready' : 'View previous download',
  }));
  return props;
}

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('export presentation', () => {
  it.each(['Library', 'Album'] as const)('withdraws cached %s links when their deadline passes while open', async (surface) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-19T23:59:59.000Z'));
    const props = show(surface);
    expect(screen.getByRole('link', { name: /Photo manifest/ })).toBeVisible();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(screen.getByText('Expired', { exact: true })).toBeVisible();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(screen.getByText(/download links expired September 19, 2026 at 7:00 PM CDT/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Retry this prepared export' }));
    await act(async () => {});
    expect(props.onRetry).toHaveBeenCalledWith(expect.objectContaining({ id: job.id, state: 'expired' }));
  });

  it.each(['ready', 'failed', 'expired'] as const)('shows the event-zone management deadline in terminal %s downloads', (state) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-19T23:00:00.000Z'));
    show('Album', state);
    const deadline = screen.getByText(/Management and exports end/);
    expect(deadline).toHaveTextContent('Management and exports end December 18, 2026 at 7:00 PM CST.');
    expect(deadline.querySelector('time')).toHaveAttribute('dateTime', managementExpiresAt);
  });

  it('shows the management deadline in the Library export control', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-19T23:00:00.000Z'));
    show('Library');
    expect(screen.getByText(/Management and exports end/))
      .toHaveTextContent('December 18, 2026 at 7:00 PM CST');
  });
});

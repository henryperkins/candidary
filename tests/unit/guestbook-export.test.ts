import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createElement, createRef } from 'react';

import type { ExportView } from '../../src/app/types';
import { AlbumExportControl } from '../../src/features/gallery/AlbumExportControl';
import {
  EXPORT_STATE_LABELS,
  coarseExportElapsed,
} from '../../src/features/gallery/export-control-status';
import {
  GalleryExportControl,
  type GalleryExportControlHandle,
} from '../../src/features/gallery/GalleryExportControl';
import type { ExportGuestbookEntryRecord } from '../../worker/db/types';
import { buildGuestbookPrivateCsv } from '../../worker/export/guestbook-csv';
import { buildGuestbookHtml } from '../../worker/export/guestbook-html';

const snapshot = {
  eventName: 'Maya & Ren <script src="https://evil.test/x.js"></script>',
  eventDate: '2026-11-01',
  eventTimezone: 'America/Chicago',
  prompt: 'Tell us <iframe src="https://evil.test"></iframe> "everything".',
  snapshotAt: '2026-11-01T07:30:00.000Z',
};

const EXPORT_STATES = ['queued', 'running', 'ready', 'failed', 'expired'] as const;

afterEach(() => cleanup());

function exportView(
  state: ExportView['state'],
  kind: ExportView['kind'],
  overrides: Partial<ExportView> = {},
): ExportView {
  return {
    id: `${kind}-${state}`,
    kind,
    state,
    snapshotAt: '2026-11-01T07:30:00.000Z',
    createdAt: '2026-11-01T07:31:00.000Z',
    startedAt: state === 'queued' ? null : '2026-11-01T07:32:00.000Z',
    completedAt: ['ready', 'failed', 'expired'].includes(state)
      ? '2026-11-01T07:34:00.000Z'
      : null,
    mediaCount: 2,
    totalBytes: 1_024,
    processedMediaCount: state === 'queued' ? null : 2,
    processedBytes: state === 'queued' ? null : 1_024,
    progressUpdatedAt: state === 'queued' ? null : '2026-11-01T07:33:00.000Z',
    attempt: 2,
    partCount: 1,
    expiresAt: '2026-11-02T07:30:00.000Z',
    guestbookEntryCount: kind === 'complete' ? 2 : null,
    guestbookSharedCount: kind === 'complete' ? 1 : null,
    guestbookEventName: kind === 'complete' ? 'Maya & Ren' : null,
    guestbookEventDate: kind === 'complete' ? '2026-11-01' : null,
    guestbookEventTimezone: kind === 'complete' ? 'America/Chicago' : null,
    guestbookPrompt: kind === 'complete' ? 'Share a memory' : null,
    guestbookGalleryVisible: kind === 'complete' ? true : null,
    errorCode: state === 'failed' ? 'EXPORT_FAILED' : null,
    ...overrides,
  };
}

const CONTROL_CONTEXT = {
  eventTimezone: 'America/Chicago',
  currentSource: { count: 2, freshness: 'fresh' as const },
  now: Date.parse('2026-11-01T07:34:30.000Z'),
  resourceStatus: 'ready' as const,
};

function legacyCompleteExport(state: ExportView['state']) {
  const { kind, ...legacy } = exportView(state, 'complete');
  if (kind !== 'complete') throw new Error('Expected a complete export fixture.');
  return legacy;
}

function entry(
  overrides: Partial<ExportGuestbookEntryRecord> = {},
): ExportGuestbookEntryRecord {
  return {
    exportJobId: 'export-a',
    source: 'guest_note',
    sourceId: 'note-a',
    sourceRank: 0,
    guestName: 'Avery <img src=x onerror=alert(1)>',
    body: 'A toast & a wish <script>alert(1)</script> https://evil.test/pixel',
    createdAt: '2026-11-01T06:30:00.000Z',
    sourceState: 'approved',
    guestVisibility: 'shared',
    includedInKeepsake: true,
    mediaId: null,
    originalFilename: null,
    ...overrides,
  };
}

describe('Guestbook export renderers', () => {
  it('builds a self-contained, escaped, semantic keepsake in event-local oldest-first order', () => {
    const html = buildGuestbookHtml({
      ...snapshot,
      entries: [
        entry({ sourceId: 'later', guestName: null, body: 'Later', createdAt: '2026-11-01T08:30:00.000Z' }),
        entry(),
        entry({
          source: 'photo_caption', sourceId: 'media-a', sourceRank: 1,
          guestName: 'Zoë', body: 'Photo <b>caption</b>', createdAt: '2026-11-01T07:00:00.000Z',
          sourceState: 'published', mediaId: 'media-a', originalFilename: 'dance.jpg',
        }),
        entry({ sourceId: 'private', sourceState: 'pending', guestVisibility: 'author_only', includedInKeepsake: false }),
      ],
      photoArchiveByMediaId: new Map([['media-a', { partNumber: 2, path: 'photos/001-dance.jpg' }]]),
    });

    expect(html).toContain('<style>');
    expect(html).toContain('@media print');
    expect(html.match(/<article dir="auto">/gu)).toHaveLength(3);
    expect(html).toContain('Maya &amp; Ren &lt;script src=&quot;https://evil.test/x.js&quot;&gt;');
    expect(html).toContain('Tell us &lt;iframe src=&quot;https://evil.test&quot;&gt;');
    expect(html).toContain('Avery &lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('Photo caption');
    expect(html).toContain('photos-002.zip');
    expect(html).toContain('photos/001-dance.jpg');
    expect(html).toContain('Unsigned');
    expect(html).not.toContain('private');
    expect(html.indexOf('A toast')).toBeLessThan(html.indexOf('Photo &lt;b&gt;caption'));
    expect(html.indexOf('Photo &lt;b&gt;caption')).toBeLessThan(html.indexOf('Later'));
    expect(html).toMatch(/Nov(?:ember)? 1, 2026/u);
    expect(html).not.toMatch(/<(?:script|iframe|form|img|link)\b/iu);
    expect(html).not.toMatch(/(?:url\(|@import)/iu);
    const document = new DOMParser().parseFromString(html, 'text/html');
    expect(document.querySelector('[src], [href]')).toBeNull();
  });

  it('renders explicit copy when no snapshot row was shared', () => {
    const html = buildGuestbookHtml({
      ...snapshot,
      entries: [entry({ sourceState: 'rejected', guestVisibility: 'author_only', includedInKeepsake: false })],
      photoArchiveByMediaId: new Map(),
    });
    expect(html).toContain('No guestbook entries were shared at this snapshot.');
    expect(html).not.toContain('A toast &amp; a wish');
  });

  it('emits exact private columns with Unicode, CSV quoting, source state, visibility, and formula hardening', () => {
    const csv = buildGuestbookPrivateCsv([
      entry({
        sourceId: '=note-a', guestName: '+Zoë', body: '@first line, "quoted"\nsecond line',
        sourceState: 'rejected', guestVisibility: 'author_only', includedInKeepsake: false,
      }),
      entry({
        source: 'photo_caption', sourceId: '-media-a', sourceRank: 1, guestName: null,
        body: 'Published caption', sourceState: 'published', guestVisibility: 'shared',
        mediaId: '-media-a', originalFilename: 'photo.jpg',
      }),
    ], new Map([['-media-a', { partNumber: 3, path: '@photos/001-photo.jpg' }]]));

    expect(csv).toBe([
      'entry_type,entry_id,guest_name,body,created_at,source_status,guest_visibility,media_id,photo_archive_part,photo_archive_path',
      "guest_note,'=note-a,'+Zoë,\"'@first line, \"\"quoted\"\"\nsecond line\",2026-11-01T06:30:00.000Z,rejected,author_only,,,",
      "photo_caption,'-media-a,,Published caption,2026-11-01T06:30:00.000Z,published,shared,'-media-a,3,'@photos/001-photo.jpg",
      '',
    ].join('\r\n'));
  });

  it('retains a frozen caption media ID while leaving archive columns empty when the current photo plan lacks it', () => {
    const csv = buildGuestbookPrivateCsv([
      entry({
        source: 'photo_caption', sourceId: 'missing-media', sourceRank: 1,
        sourceState: 'hidden', guestVisibility: 'author_only', includedInKeepsake: false,
        mediaId: 'missing-media', originalFilename: 'gone.jpg',
      }),
    ], new Map());
    expect(csv).toContain('photo_caption,missing-media,Avery <img src=x onerror=alert(1)>,');
    expect(csv).toContain(',hidden,author_only,missing-media,,\r\n');
  });
});

describe('Manager Guestbook export downloads', () => {
  it('advances semantic complete export focus only after loading becomes ready', () => {
    const ref = createRef<GalleryExportControlHandle>();
    const callbacks = {
      onPrepare: async () => undefined,
      onDownload: async () => undefined,
      onRetry: async () => undefined,
    };
    const view = render(createElement(GalleryExportControl, {
      ...CONTROL_CONTEXT,
      ...callbacks,
      resourceStatus: 'loading',
      ref,
    }));

    act(() => ref.current?.focusIntendedAction());
    expect(screen.getByRole('region', { name: 'Complete export' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Download all' })).not.toHaveFocus();

    view.rerender(createElement(GalleryExportControl, {
      ...CONTROL_CONTEXT,
      ...callbacks,
      resourceStatus: 'ready',
      ref,
    }));
    expect(screen.getByRole('button', { name: 'Download all' })).toHaveFocus();
  });

  it('prioritizes a resolved semantic download over terminal retry and prepare actions', () => {
    const ref = createRef<GalleryExportControlHandle>();
    render(createElement(GalleryExportControl, {
      ...CONTROL_CONTEXT,
      job: exportView('expired', 'complete'),
      download: {
        manifest: { url: 'https://signed.test/manifest', expiresAt: 'later', filename: 'manifest.csv' },
        parts: [{
          partNumber: 1,
          url: 'https://signed.test/photos-1',
          expiresAt: 'later',
          filename: 'photos-1.zip',
          mediaCount: 2,
          sourceBytes: 1_024,
        }],
        printableGuestbook: { url: 'https://signed.test/print', expiresAt: 'later', filename: 'guestbook.html' },
        privateGuestbook: null,
      },
      onPrepare: async () => undefined,
      onDownload: async () => undefined,
      onRetry: async () => undefined,
      ref,
    }));

    act(() => ref.current?.focusIntendedAction());

    expect(screen.getByRole('link', { name: 'Photo manifest' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Retry this prepared export' })).not.toHaveFocus();
    expect(screen.getByRole('button', { name: 'Prepare current collection' })).not.toHaveFocus();
  });

  it('separates printable and private downloads while conditionally omitting absent photo artifacts', () => {
    render(createElement(GalleryExportControl, {
      ...CONTROL_CONTEXT,
      job: {
        id: 'export-a', state: 'ready', snapshotAt: '2026-11-01T07:30:00.000Z',
        createdAt: '2026-11-01T07:31:00.000Z', startedAt: '2026-11-01T07:32:00.000Z',
        completedAt: '2026-11-01T07:34:00.000Z',
        mediaCount: 0, totalBytes: 0, attempt: 1, partCount: 0, expiresAt: '2026-11-02T07:30:00.000Z',
        processedMediaCount: 0, processedBytes: 0, progressUpdatedAt: '2026-11-01T07:33:00.000Z',
        guestbookEntryCount: 2, guestbookSharedCount: 1, guestbookEventName: 'Maya & Ren',
        guestbookEventDate: '2026-11-01', guestbookEventTimezone: 'America/Chicago',
        guestbookPrompt: 'Share a memory', guestbookGalleryVisible: true,
        errorCode: null,
      },
      download: {
        manifest: null,
        parts: [],
        printableGuestbook: { url: 'https://signed.test/print', expiresAt: 'later', filename: 'guestbook.html' },
        privateGuestbook: { url: 'https://signed.test/private', expiresAt: 'later', filename: 'guestbook-private.csv' },
      },
      onPrepare: async () => undefined,
      onDownload: async () => undefined,
      onRetry: async () => undefined,
    }));
    expect(screen.queryByRole('link', { name: /photo manifest/iu })).toBeNull();
    expect(screen.queryByRole('link', { name: /photo part/iu })).toBeNull();
    expect(screen.getByRole('link', { name: 'Printable guestbook' })).toHaveAttribute('href', 'https://signed.test/print');
    expect(screen.getByRole('link', { name: /Private entry archive.*Contains entries guests cannot see/iu }))
      .toHaveAttribute('href', 'https://signed.test/private');
  });

  it.each(EXPORT_STATES)('uses the shared %s state label for complete and album exports', (state) => {
    const callbacks = {
      onPrepare: async () => undefined,
      onDownload: async () => undefined,
      onRetry: async () => undefined,
    };
    const complete = render(createElement(GalleryExportControl, {
      ...callbacks,
      ...CONTROL_CONTEXT,
      job: exportView(state, 'complete'),
    }));
    expect(complete.container.querySelector('.export-state strong'))
      .toHaveTextContent(EXPORT_STATE_LABELS[state]);
    complete.unmount();

    const albumExport = render(createElement(AlbumExportControl, {
      ...callbacks,
      ...CONTROL_CONTEXT,
      job: exportView(state, 'album'),
    }));
    expect(albumExport.container.querySelector('.export-state strong'))
      .toHaveTextContent(EXPORT_STATE_LABELS[state]);
  });

  it('forwards status changes without creating competing live-region nodes', async () => {
    const onAnnouncement = vi.fn();
    const callbacks = {
      onPrepare: async () => undefined,
      onDownload: async () => undefined,
      onRetry: async () => undefined,
      onAnnouncement,
    };
    const complete = render(createElement(GalleryExportControl, {
      ...callbacks,
      ...CONTROL_CONTEXT,
    }));
    complete.rerender(createElement(GalleryExportControl, {
      ...callbacks,
      ...CONTROL_CONTEXT,
      job: exportView('queued', 'complete'),
    }));
    expect(complete.container.querySelector('[role="status"]')).toBeNull();
    expect(onAnnouncement).toHaveBeenLastCalledWith(expect.stringContaining('Queued'));
    complete.unmount();

    const albumExport = render(createElement(AlbumExportControl, {
      ...callbacks,
      ...CONTROL_CONTEXT,
    }));
    albumExport.rerender(createElement(AlbumExportControl, {
      ...callbacks,
      ...CONTROL_CONTEXT,
      job: exportView('queued', 'album'),
    }));
    expect(albumExport.container.querySelector('[role="status"]')).toBeNull();
    expect(onAnnouncement).toHaveBeenLastCalledWith(expect.stringContaining('Queued'));
  });

  it('normalizes legacy complete jobs before download and retry callbacks', async () => {
    const onDownload = vi.fn(async () => undefined);
    const onRetry = vi.fn(async () => undefined);
    const callbacks = {
      onPrepare: async () => undefined,
      onDownload,
      onRetry,
    };
    const ready = legacyCompleteExport('ready');
    const view = render(createElement(GalleryExportControl, {
      ...callbacks,
      ...CONTROL_CONTEXT,
      job: ready,
    }));

    fireEvent.click(within(view.container).getByRole('button', { name: 'Get download links' }));
    expect(onDownload).toHaveBeenCalledWith({ ...ready, kind: 'complete' });
    await waitFor(() => expect(within(view.container)
      .getByRole('button', { name: 'Get download links' })).toBeEnabled());

    const failed = legacyCompleteExport('failed');
    view.rerender(createElement(GalleryExportControl, {
      ...callbacks,
      ...CONTROL_CONTEXT,
      job: failed,
    }));
    fireEvent.click(within(view.container).getByRole('button', { name: 'Retry this prepared export' }));
    expect(onRetry).toHaveBeenCalledWith({ ...failed, kind: 'complete' });
  });

  it.each([
    ['queued', 'Queued'],
    ['running', 'Running'],
  ] as const)('distinguishes the %s state and retains progress detail', (state, label) => {
    render(createElement(GalleryExportControl, {
      ...CONTROL_CONTEXT,
      job: exportView(state, 'complete', {
        processedMediaCount: state === 'queued' ? null : 1,
        processedBytes: state === 'queued' ? null : 256 * 1_024,
        totalBytes: 1_024 ** 2,
      }),
      onPrepare: async () => undefined,
      onDownload: async () => undefined,
      onRetry: async () => undefined,
    }));

    expect(screen.getByText(label, { selector: 'strong' })).toBeVisible();
    if (state === 'running') {
      expect(screen.getByText('2 minutes elapsed.')).toBeVisible();
      expect(screen.getByText('Progress: 1 of 2 photos · 256 KB of 1.0 MB.')).toBeVisible();
    }
  });

  it('formats coarse elapsed time without creating a per-card timer', () => {
    const now = Date.parse('2026-11-01T08:00:00.000Z');
    expect(coarseExportElapsed('2026-11-01T07:59:31.000Z', now)).toBe('less than a minute elapsed.');
    expect(coarseExportElapsed('2026-11-01T07:58:31.000Z', now)).toBe('1 minute elapsed.');
    expect(coarseExportElapsed('2026-11-01T05:30:00.000Z', now)).toBe('2 hours elapsed.');
  });

  it.each([
    ['ready', null, false],
    ['failed', 'EXPORT_FAILED', true],
    ['expired', null, true],
  ] as const)('renders the exact complete terminal action matrix for %s', (state, errorCode, retry) => {
    const view = render(createElement(GalleryExportControl, {
      ...CONTROL_CONTEXT,
      job: exportView(state, 'complete', { errorCode }),
      onPrepare: async () => undefined,
      onDownload: async () => undefined,
      onRetry: async () => undefined,
    }));

    expect(view.container.querySelector('.export-state__prepared'))
      .toHaveTextContent(`Prepared November 1, 2026 at 1:30 AM CST · 2 photos · ${EXPORT_STATE_LABELS[state]}`);
    expect(view.container.querySelector('.export-state__prepared time'))
      .toHaveAttribute('dateTime', '2026-11-01T07:30:00.000Z');
    expect(screen.getByRole('button', { name: 'Prepare current collection' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Retry this prepared export' }) !== null).toBe(retry);
    if (state === 'ready') expect(screen.getByRole('button', { name: 'Get download links' })).toBeEnabled();
  });

  it.each(['retry', 'prepare'] as const)(
    'locks every complete-export terminal action while %s is unsettled',
    (firstAction) => {
      const pending = new Promise<void>(() => {});
      const onPrepare = vi.fn(() => firstAction === 'prepare' ? pending : Promise.resolve());
      const onRetry = vi.fn(() => firstAction === 'retry' ? pending : Promise.resolve());
      render(createElement(GalleryExportControl, {
        ...CONTROL_CONTEXT,
        job: exportView('failed', 'complete'),
        onPrepare,
        onDownload: async () => undefined,
        onRetry,
      }));
      const retry = screen.getByRole('button', { name: 'Retry this prepared export' });
      const prepare = screen.getByRole('button', { name: 'Prepare current collection' });

      fireEvent.click(firstAction === 'retry' ? retry : prepare);

      expect(retry).toBeDisabled();
      expect(prepare).toBeDisabled();
      fireEvent.click(firstAction === 'retry' ? prepare : retry);
      expect(onRetry).toHaveBeenCalledTimes(firstAction === 'retry' ? 1 : 0);
      expect(onPrepare).toHaveBeenCalledTimes(firstAction === 'prepare' ? 1 : 0);
    },
  );

  it.each([
    ['ready', null, false],
    ['failed', 'EXPORT_FAILED', true],
    ['expired', null, true],
  ] as const)('renders the exact Album terminal action matrix for %s', (state, errorCode, retry) => {
    const view = render(createElement(AlbumExportControl, {
      ...CONTROL_CONTEXT,
      job: exportView(state, 'album', { errorCode }),
      onPrepare: async () => undefined,
      onDownload: async () => undefined,
      onRetry: async () => undefined,
    }));

    expect(view.container.querySelector('.export-state__prepared'))
      .toHaveTextContent(`Prepared November 1, 2026 at 1:30 AM CST · 2 photos · ${EXPORT_STATE_LABELS[state]}`);
    expect(view.container.querySelector('.export-state__prepared time'))
      .toHaveAttribute('dateTime', '2026-11-01T07:30:00.000Z');
    expect(screen.getByRole('button', { name: 'Prepare current Album' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Retry this prepared export' }) !== null).toBe(retry);
    if (state === 'ready') expect(screen.getByRole('button', { name: 'Get download links' })).toBeEnabled();
  });

  it.each(['complete', 'album'] as const)('omits Retry for source-removed %s exports', (kind) => {
    const Control = kind === 'complete' ? GalleryExportControl : AlbumExportControl;
    render(createElement(Control, {
      ...CONTROL_CONTEXT,
      job: exportView('failed', kind, { errorCode: 'EXPORT_SOURCE_REMOVED' }),
      onPrepare: async () => undefined,
      onDownload: async () => undefined,
      onRetry: async () => undefined,
    }));

    expect(screen.queryByRole('button', { name: 'Retry this prepared export' })).toBeNull();
    expect(screen.getByRole('button', {
      name: kind === 'complete' ? 'Prepare current collection' : 'Prepare current Album',
    })).toBeEnabled();
  });

  it.each([
    ['EXPORT_SOURCE_MISSING', 'A source photo could not be read.'],
    ['EXPORT_SOURCE_REMOVED', 'A photo in this prepared export is no longer available.'],
    ['EXPORT_EVENT_DELETED', 'This event became unavailable while the export was being prepared.'],
    ['EXPORT_GUESTBOOK_SNAPSHOT_INVALID', 'The prepared guestbook snapshot could not be completed.'],
    ['EXPORT_SNAPSHOT_CHANGED', 'The prepared photo snapshot changed unexpectedly.'],
    ['EXPORT_WORKFLOW_DISPATCH_FAILED', 'Export preparation could not start.'],
    ['EXPORT_FAILED', 'This prepared export did not finish.'],
  ] as const)('maps %s to safe recovery copy', (errorCode, expected) => {
    const { unmount } = render(createElement(GalleryExportControl, {
      ...CONTROL_CONTEXT,
      job: exportView('failed', 'complete', { errorCode }),
      onPrepare: async () => undefined,
      onDownload: async () => undefined,
      onRetry: async () => undefined,
    }));
    expect(screen.getByText(new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))).toBeVisible();
    unmount();
  });

  it('uses generic safe recovery copy for an unknown failure while retaining partial progress', () => {
    render(createElement(GalleryExportControl, {
      ...CONTROL_CONTEXT,
      job: exportView('failed', 'complete', {
        errorCode: 'INTERNAL_BUCKET_PATH' as ExportView['errorCode'],
        processedMediaCount: 1,
        processedBytes: 256 * 1_024,
        totalBytes: 1_024 ** 2,
      }),
      onPrepare: async () => undefined,
      onDownload: async () => undefined,
      onRetry: async () => undefined,
    }));
    expect(screen.getByText(/This prepared export did not finish\./u)).toBeVisible();
    expect(screen.getByText('Progress: 1 of 2 photos · 256 KB of 1.0 MB.')).toBeVisible();
    expect(screen.queryByText(/INTERNAL_BUCKET_PATH/u)).toBeNull();
  });

  it('names the other active kind, blocks only Prepare and Retry, and keeps a ready download usable', () => {
    const activeAlbum = exportView('running', 'album');
    const callbacks = {
      onPrepare: async () => undefined,
      onDownload: async () => undefined,
      onRetry: async () => undefined,
    };
    const ready = render(createElement(GalleryExportControl, {
      ...callbacks,
      ...CONTROL_CONTEXT,
      job: exportView('ready', 'complete'),
      activeJob: activeAlbum,
    }));
    expect(screen.getByText('Album export is Running. Prepare and retry actions will be available when it finishes.'))
      .toBeVisible();
    expect(screen.getByRole('button', { name: 'Get download links' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Prepare current collection' })).toBeDisabled();

    ready.rerender(createElement(GalleryExportControl, {
      ...callbacks,
      ...CONTROL_CONTEXT,
      job: exportView('failed', 'complete'),
    }));
    expect(screen.getByRole('button', { name: 'Retry this prepared export' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Prepare current collection' })).toBeEnabled();
  });

  it('names a complete export while Album actions wait', () => {
    render(createElement(AlbumExportControl, {
      ...CONTROL_CONTEXT,
      job: exportView('failed', 'album'),
      activeJob: exportView('queued', 'complete'),
      onPrepare: async () => undefined,
      onDownload: async () => undefined,
      onRetry: async () => undefined,
    }));
    expect(screen.getByText('Complete collection export is Queued. Prepare and retry actions will be available when it finishes.'))
      .toBeVisible();
    expect(screen.getByRole('button', { name: 'Retry this prepared export' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Prepare current Album' })).toBeDisabled();
  });

  it.each([
    [{ count: 5, freshness: 'fresh' as const }, 'Current collection: 5 photos (+3 photos).'],
    [{ count: 1, freshness: 'fresh' as const }, 'Current collection: 1 photo (-1 photo).'],
    [{ count: 2, freshness: 'fresh' as const }, 'Current collection: 2 photos.'],
    [{ count: 5, freshness: 'stale' as const, refreshing: true }, 'Last known current collection: 5 photos. Refreshing the current count.'],
    [{ count: 5, freshness: 'stale' as const, refreshing: false }, 'Last known current collection: 5 photos. Current collection count unavailable.'],
    [{ count: null, freshness: 'unavailable' as const }, 'Current collection count unavailable.'],
  ])('describes live source authority without claiming snapshot identity: %o', (currentSource, expected) => {
    const { unmount } = render(createElement(GalleryExportControl, {
      ...CONTROL_CONTEXT,
      currentSource,
      job: exportView('ready', 'complete'),
      onPrepare: async () => undefined,
      onDownload: async () => undefined,
      onRetry: async () => undefined,
    }));
    expect(screen.getByText(expected)).toBeVisible();
    expect(screen.queryByText(/matches current|same (?:photos|collection)/iu)).toBeNull();
    if (currentSource.freshness !== 'fresh') {
      expect(screen.queryByText(/\([+-]\d+ photos?\)/u)).toBeNull();
    }
    unmount();
  });

  it.each([
    [GalleryExportControl, 'Prepare current collection', 'Deliver a photo before preparing the current collection.'],
    [AlbumExportControl, 'Prepare current Album', 'Add a photo to the Album before preparing it.'],
  ] as const)('locally disables a current export only for a trusted zero count', (Control, label, reason) => {
    render(createElement(Control, {
      ...CONTROL_CONTEXT,
      currentSource: { count: 0, freshness: 'fresh' },
      job: exportView('ready', Control === GalleryExportControl ? 'complete' : 'album'),
      onPrepare: async () => undefined,
      onDownload: async () => undefined,
      onRetry: async () => undefined,
    }));
    expect(screen.getByRole('button', { name: label })).toBeDisabled();
    expect(screen.getByText(reason)).toBeVisible();
  });

  it.each([
    [GalleryExportControl, 'Download all'],
    [AlbumExportControl, 'Download album photos'],
  ] as const)('uses the authoritative current source for the initial %s action', (Control, label) => {
    const callbacks = {
      onPrepare: async () => undefined,
      onDownload: async () => undefined,
      onRetry: async () => undefined,
    };
    const view = render(createElement(Control, {
      ...callbacks,
      ...CONTROL_CONTEXT,
      currentSource: { count: 0, freshness: 'fresh' },
    }));
    expect(screen.getByRole('button', { name: label })).toBeDisabled();

    view.rerender(createElement(Control, {
      ...callbacks,
      ...CONTROL_CONTEXT,
      currentSource: { count: 2, freshness: 'stale' },
    }));
    expect(screen.getByRole('button', { name: label })).toBeEnabled();
  });
});

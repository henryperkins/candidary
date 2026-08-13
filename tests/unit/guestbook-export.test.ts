import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ManagerExportPanel } from '../../src/components/ManagerExportPanel';
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
  it('separates printable and private downloads while conditionally omitting absent photo artifacts', () => {
    render(ManagerExportPanel({
      job: {
        id: 'export-a', state: 'ready', snapshotAt: '2026-11-01T07:30:00.000Z',
        mediaCount: 0, totalBytes: 0, attempt: 1, partCount: 0, expiresAt: '2026-11-02T07:30:00.000Z',
        guestbookEntryCount: 2, guestbookSharedCount: 1, guestbookEventName: 'Maya & Ren',
        guestbookEventDate: '2026-11-01', guestbookEventTimezone: 'America/Chicago',
        guestbookPrompt: 'Share a memory', guestbookGalleryVisible: true,
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
});

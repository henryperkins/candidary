import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn(() => Promise.resolve('data:image/png;base64,x')) },
}));

import type { EventView } from '../../shared/contracts';
import { DEFAULT_GUESTBOOK_PROMPT } from '../../shared/constants';
import { resolveEventTheme } from '../../shared/event-theme';
import { createAppRouter } from '../../src/app/router';
import { ManagerGuestbookPanel } from '../../src/features/guestbook/ManagerGuestbookPanel';
import type { GuestbookSummary } from '../../src/features/guestbook/manager-guestbook-state';

function success(data: unknown) {
  return Promise.resolve(new Response(JSON.stringify({ data, requestId: 'request-a' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
}

function failure(code = 'INTERNAL_ERROR', message = 'Guestbook unavailable.', status = 503) {
  return Promise.resolve(new Response(JSON.stringify({ code, message, requestId: 'request-a' }), {
    status,
    headers: { 'content-type': 'application/json' },
  }));
}

const emptySummary: GuestbookSummary = {
  needsReviewCount: 0,
  sharedCount: 0,
  hiddenCount: 0,
  deletedCount: 0,
  galleryVisible: true,
};

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
  storedMediaCount: 0,
  reservedBytes: 0,
  storedBytes: 0,
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

function managerFetch(summary = {
  needsReviewCount: 3,
  sharedCount: 7,
  hiddenCount: 2,
  deletedCount: 1,
  galleryVisible: true,
}) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = new URL(String(input), 'https://candidary.test');
    if (url.pathname === '/api/manage/events/event-a') return success({ event });
    if (url.pathname.endsWith('/guestbook/summary')) return success({ summary });
    if (url.pathname.endsWith('/guestbook')) return success({ items: [], nextCursor: null, summary });
    if (url.pathname.endsWith('/media')) return success({ media: [], nextCursor: null });
    if (url.pathname.endsWith('/messages')) return success({ messages: [] });
    if (url.pathname.endsWith('/exports')) return success({ exports: [] });
    if (url.pathname.endsWith('/entry')) {
      return success({ eventLink: 'https://candidary.test/join#entry-secret', disabledAt: null });
    }
    throw new Error(`Unexpected request ${url.pathname}${url.search}`);
  });
}

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Manager Guestbook', () => {
  it('loads only the summary initially and badges only entries that need review', async () => {
    const fetchMock = managerFetch();
    vi.stubGlobal('fetch', fetchMock);

    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);

    const navigation = await screen.findByRole('navigation', { name: 'Manager sections' });
    const guestbook = within(navigation).getByRole('button', { name: 'Guestbook 3' });
    expect(guestbook).toBeVisible();

    const requested = fetchMock.mock.calls.map(([input]) => new URL(String(input), 'https://candidary.test'));
    expect(requested.filter(({ pathname }) => pathname.endsWith('/guestbook/summary'))).toHaveLength(1);
    expect(requested.filter(({ pathname }) => pathname.endsWith('/messages'))).toHaveLength(0);
    expect(requested.filter(({ pathname }) => pathname.endsWith('/guestbook'))).toHaveLength(0);
  });

  it('completes its initial list load under React StrictMode', async () => {
    const listResolvers: Array<(response: Response) => void> = [];
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => {
      listResolvers.push(resolve);
    })));

    render(<StrictMode>
      <ManagerGuestbookPanel
        eventId="event-a"
        eventTimezone="America/Chicago"
        summary={emptySummary}
        onSummaryRefresh={vi.fn(async () => undefined)}
        onOpenSettings={vi.fn()}
      />
    </StrictMode>);
    await waitFor(() => expect(listResolvers).toHaveLength(2));

    for (const resolve of listResolvers) {
      resolve(await success({
        items: [{
          id: 'strict-row', source: 'guest_note', guestName: 'Avery', body: 'Loaded in StrictMode.',
          createdAt: '2026-09-19T22:00:00.000Z', state: 'approved', visibility: 'shared',
        }],
        nextCursor: null,
        summary: { ...emptySummary, sharedCount: 1 },
      }));
    }

    expect(await screen.findByText('Loaded in StrictMode.')).toBeVisible();
    expect(screen.queryByText('Loading Guestbook entries…')).not.toBeInTheDocument();
  });

  it('renders an on-demand thumbnail when a photo caption has no stored preview', async () => {
    vi.stubGlobal('fetch', vi.fn(() => success({
      items: [{
        id: 'on-demand-preview', source: 'photo_caption', mediaId: 'on-demand-preview',
        guestName: 'Avery', body: 'Generated on demand.', createdAt: '2026-09-19T22:00:00.000Z',
        state: 'unpublished', visibility: 'author_only', previewAvailable: false,
      }],
      nextCursor: null,
      summary: { ...emptySummary, needsReviewCount: 1 },
    })));

    render(<ManagerGuestbookPanel
      eventId="event-a"
      eventTimezone="America/Chicago"
      summary={{ ...emptySummary, needsReviewCount: 1 }}
      onSummaryRefresh={vi.fn(async () => undefined)}
      onOpenSettings={vi.fn()}
    />);

    const row = (await screen.findByText('Generated on demand.')).closest('li');
    expect(row?.querySelector('img')).toHaveAttribute('src', '/api/media/on-demand-preview/preview');
  });

  it('chooses Needs review, lazily appends opaque cursor pages, and resets rows for every view or source', async () => {
    const requested: URL[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://candidary.test');
      requested.push(url);
      if (url.searchParams.get('cursor') === 'earlier-page') return success({
        items: [{
          id: 'note-earlier', source: 'guest_note', guestName: null, body: 'An earlier memory.',
          createdAt: '2026-09-19T21:00:00.000Z', state: 'pending', visibility: 'author_only',
        }],
        nextCursor: null,
        summary: { ...emptySummary, needsReviewCount: 2 },
      });
      return success({
        items: url.searchParams.get('view') === 'needs-review' && url.searchParams.get('source') === 'all'
          ? [{
            id: 'note-newest', source: 'guest_note', guestName: 'Avery', body: 'The newest memory.',
            createdAt: '2026-09-19T22:00:00.000Z', state: 'pending', visibility: 'author_only',
          }]
          : [],
        nextCursor: url.searchParams.get('view') === 'needs-review' && url.searchParams.get('source') === 'all'
          ? 'earlier-page'
          : null,
        summary: { ...emptySummary, needsReviewCount: 2 },
      });
    }));

    const user = userEvent.setup();
    render(<ManagerGuestbookPanel
      eventId="event-a"
      eventTimezone="America/Chicago"
      summary={{ ...emptySummary, needsReviewCount: 2 }}
      onSummaryRefresh={vi.fn(async () => undefined)}
      onOpenSettings={vi.fn()}
    />);

    expect(screen.getByRole('heading', { name: 'Guestbook from the day' })).toBeVisible();
    expect(await screen.findByText('The newest memory.')).toBeVisible();
    expect(requested[0]?.search).toBe('?view=needs-review&source=all&limit=25');
    for (const name of ['Needs review', 'Shared', 'Hidden', 'Deleted']) {
      expect(screen.getByRole('button', { name: new RegExp(name, 'i') })).toBeVisible();
    }
    for (const name of ['All entries', 'Notes', 'Photo captions']) {
      expect(screen.getByRole('button', { name })).toBeVisible();
    }

    await user.click(screen.getByRole('button', { name: 'Show earlier' }));
    expect(await screen.findByText('An earlier memory.')).toBeVisible();
    expect(screen.getByText('The newest memory.')).toBeVisible();
    expect(requested.at(-1)?.searchParams.get('cursor')).toBe('earlier-page');

    await user.click(screen.getByRole('button', { name: /Shared/i }));
    await waitFor(() => expect(requested.at(-1)?.searchParams.get('view')).toBe('shared'));
    expect(screen.queryByText('The newest memory.')).not.toBeInTheDocument();
    expect(screen.queryByText('An earlier memory.')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Photo captions' }));
    await waitFor(() => expect(requested.at(-1)?.searchParams.get('source')).toBe('photo_caption'));
    expect(requested.at(-1)?.searchParams.has('cursor')).toBe(false);
  });

  it('uses exact note and caption action routes with row-only busy state and summary-only reconciliation', async () => {
    let resolveShare!: (response: Response) => void;
    const shareResponse = new Promise<Response>((resolve) => { resolveShare = resolve; });
    let resolvePublish!: (response: Response) => void;
    const publishResponse = new Promise<Response>((resolve) => { resolvePublish = resolve; });
    const requests: Array<{ url: URL; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://candidary.test');
      requests.push({ url, init });
      if (init?.method === 'PATCH' && url.pathname.endsWith('/messages/note-a')) return shareResponse;
      if (init?.method === 'PATCH' && url.pathname.endsWith('/media/media-a')) return publishResponse;
      return success({
        items: [{
          id: 'note-a', source: 'guest_note', guestName: 'Avery', body: 'A perfect evening.',
          createdAt: '2026-09-19T22:00:00.000Z', state: 'pending', visibility: 'author_only',
        }, {
          id: 'media-a', source: 'photo_caption', mediaId: 'media-a', guestName: 'Morgan', body: 'The speech.',
          createdAt: '2026-09-19T22:05:00.000Z', state: 'unpublished', visibility: 'author_only', previewAvailable: true,
        }],
        nextCursor: null,
        summary: { ...emptySummary, needsReviewCount: 2 },
      });
    }));
    const onSummaryRefresh = vi.fn(async () => undefined);
    const user = userEvent.setup();
    render(<ManagerGuestbookPanel
      eventId="event-a"
      eventTimezone="America/Chicago"
      summary={{ ...emptySummary, needsReviewCount: 2 }}
      onSummaryRefresh={onSummaryRefresh}
      onOpenSettings={vi.fn()}
    />);

    const noteRow = await screen.findByRole('listitem', { name: /Avery guest note/i });
    expect(within(noteRow).getByRole('button', { name: 'Share' })).toBeVisible();
    expect(within(noteRow).getByRole('button', { name: 'Keep private' })).toBeVisible();
    expect(within(noteRow).getByRole('button', { name: 'Delete' })).toBeVisible();
    const captionRow = screen.getByRole('listitem', { name: /Morgan photo caption/i });
    expect(within(captionRow).getByRole('button', { name: 'Publish photo & caption' })).toBeVisible();
    expect(within(captionRow).getByRole('button', { name: 'Hide photo & caption' })).toBeVisible();

    await user.click(within(noteRow).getByRole('button', { name: 'Share' }));
    expect(within(noteRow).getByRole('button', { name: 'Sharing…' })).toBeDisabled();
    const publish = within(captionRow).getByRole('button', { name: 'Publish photo & caption' });
    expect(publish).toBeEnabled();
    await user.click(publish);
    expect(within(captionRow).getByRole('button', { name: 'Publishing…' })).toBeDisabled();
    expect(requests.filter(({ init }) => init?.method === 'PATCH')).toHaveLength(2);

    resolvePublish(await success({
      media: {
        id: 'media-a', originalFilename: 'speech.jpg', guestName: 'Morgan', caption: 'The speech.',
        publicationStatus: 'published', uploadState: 'stored', previewAvailable: true,
        width: 1200, height: 800, createdAt: '2026-09-19T22:05:00.000Z',
      },
      item: {
        id: 'media-a', source: 'photo_caption', mediaId: 'media-a', guestName: 'Morgan', body: 'The speech.',
        createdAt: '2026-09-19T22:05:00.000Z', state: 'published', visibility: 'shared', previewAvailable: true,
      },
    }));
    resolveShare(await success({ item: {
      id: 'note-a', source: 'guest_note', guestName: 'Avery', body: 'A perfect evening.',
      createdAt: '2026-09-19T22:00:00.000Z', state: 'approved', visibility: 'shared',
    } }));
    await waitFor(() => expect(screen.queryByText('A perfect evening.')).not.toBeInTheDocument());
    await waitFor(() => expect(onSummaryRefresh).toHaveBeenCalledTimes(2));
    const notePatch = requests.find(({ url, init }) => init?.method === 'PATCH' && url.pathname.includes('/messages/'))!;
    expect(JSON.parse(String(notePatch.init?.body))).toEqual({ action: 'approve', expectedState: 'pending' });

    const captionPatch = requests.find(({ url, init }) => init?.method === 'PATCH' && url.pathname.includes('/media/'))!;
    expect(captionPatch.url.pathname).toBe('/api/manage/events/event-a/media/media-a');
    expect(JSON.parse(String(captionPatch.init?.body))).toEqual({ action: 'publish', expectedStatus: 'unpublished' });
    expect(requests.some(({ url, init }) => init?.method === 'PATCH' && url.pathname.includes('/messages/media-a'))).toBe(false);
  });

  it('refetches only the summary after a Manager row action and never starts a whole-page refresh', async () => {
    const requested: Array<{ path: string; method: string }> = [];
    let summaryReads = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://candidary.test');
      const method = init?.method ?? 'GET';
      requested.push({ path: `${url.pathname}${url.search}`, method });
      if (url.pathname === '/api/manage/events/event-a') return success({ event });
      if (url.pathname.endsWith('/guestbook/summary')) {
        summaryReads += 1;
        return success({ summary: { ...emptySummary, needsReviewCount: summaryReads === 1 ? 1 : 0, sharedCount: summaryReads === 1 ? 0 : 1 } });
      }
      if (url.pathname.endsWith('/guestbook')) return success({ items: [{
        id: 'note-a', source: 'guest_note', guestName: 'Avery', body: 'Manager action.',
        createdAt: '2026-09-19T22:00:00Z', state: 'pending', visibility: 'author_only',
      }], nextCursor: null, summary: { ...emptySummary, needsReviewCount: 1 } });
      if (url.pathname.endsWith('/media')) return success({ media: [], nextCursor: null });
      if (url.pathname.endsWith('/exports')) return success({ exports: [] });
      if (url.pathname.endsWith('/entry')) return success({ eventLink: 'https://candidary.test/join#credential', disabledAt: null });
      if (method === 'PATCH' && url.pathname.endsWith('/messages/note-a')) return success({ item: {
        id: 'note-a', source: 'guest_note', guestName: 'Avery', body: 'Manager action.',
        createdAt: '2026-09-19T22:00:00Z', state: 'approved', visibility: 'shared',
      } });
      throw new Error(`Unexpected request ${method} ${url.pathname}${url.search}`);
    }));
    const user = userEvent.setup();
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    const navigation = await screen.findByRole('navigation', { name: 'Manager sections' });
    await user.click(within(navigation).getByRole('button', { name: 'Guestbook 1' }));
    const row = await screen.findByRole('listitem', { name: /Avery guest note/i });
    const beforeAction = requested.length;
    await user.click(within(row).getByRole('button', { name: 'Share' }));
    await waitFor(() => expect(summaryReads).toBe(2));
    expect(requested.slice(beforeAction)).toEqual([
      { path: '/api/manage/events/event-a/messages/note-a', method: 'PATCH' },
      { path: '/api/manage/events/event-a/guestbook/summary', method: 'GET' },
    ]);
  });

  it('keeps stale rows after Refresh entries fails and replaces accumulated rows only after success', async () => {
    let refreshFails = false;
    let firstLoads = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://candidary.test');
      if (url.searchParams.has('cursor')) return success({
        items: [{ id: 'old-b', source: 'guest_note', guestName: null, body: 'Older row.', createdAt: '2026-09-19T20:00:00Z', state: 'approved', visibility: 'shared' }],
        nextCursor: null, summary: { ...emptySummary, sharedCount: 2 },
      });
      firstLoads += 1;
      if (firstLoads > 1 && refreshFails) return failure();
      return success({
        items: [{ id: firstLoads > 2 ? 'fresh' : 'old-a', source: 'guest_note', guestName: null, body: firstLoads > 2 ? 'Fresh row.' : 'Original row.', createdAt: '2026-09-19T21:00:00Z', state: 'approved', visibility: 'shared' }],
        nextCursor: firstLoads > 2 ? null : 'earlier', summary: { ...emptySummary, sharedCount: 2 },
      });
    }));
    const user = userEvent.setup();
    render(<ManagerGuestbookPanel eventId="event-a" eventTimezone="America/Chicago" summary={emptySummary} onSummaryRefresh={vi.fn(async () => undefined)} onOpenSettings={vi.fn()} />);
    expect(await screen.findByText('Original row.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Show earlier' }));
    expect(await screen.findByText('Older row.')).toBeVisible();

    refreshFails = true;
    const refresh = screen.getByRole('button', { name: 'Refresh entries' });
    refresh.focus();
    await user.click(refresh);
    expect(await screen.findByRole('alert')).toHaveTextContent('Guestbook unavailable.');
    expect(screen.getByText('Original row.')).toBeVisible();
    expect(screen.getByText('Older row.')).toBeVisible();
    expect(refresh).toHaveFocus();

    refreshFails = false;
    await user.click(refresh);
    expect(await screen.findByText('Fresh row.')).toBeVisible();
    expect(screen.queryByText('Original row.')).not.toBeInTheDocument();
    expect(screen.queryByText('Older row.')).not.toBeInTheDocument();
    expect(refresh).toHaveFocus();
  });

  it('polls only the visible active Guestbook summary and never refreshes rows', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    const fetchMock = managerFetch({ ...emptySummary, needsReviewCount: 1 });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    const navigation = await screen.findByRole('navigation', { name: 'Manager sections' });
    await user.click(within(navigation).getByRole('button', { name: 'Guestbook 1' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => new URL(String(input), 'https://candidary.test').pathname.endsWith('/guestbook'))).toBe(true));
    const listCount = () => fetchMock.mock.calls.filter(([input]) => new URL(String(input), 'https://candidary.test').pathname.endsWith('/guestbook')).length;
    const summaryCount = () => fetchMock.mock.calls.filter(([input]) => new URL(String(input), 'https://candidary.test').pathname.endsWith('/guestbook/summary')).length;
    const listsBefore = listCount();
    const summariesBefore = summaryCount();
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(summaryCount()).toBe(summariesBefore + 1);
    expect(listCount()).toBe(listsBefore);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => { window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(15_000); });
    expect(summaryCount()).toBe(summariesBefore + 1);
  });

  it('polls on visible focus only while Guestbook is active and removes the lifecycle when leaving', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    const fetchMock = managerFetch({ ...emptySummary, needsReviewCount: 1 });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    const navigation = await screen.findByRole('navigation', { name: 'Manager sections' });
    const summaryCount = () => fetchMock.mock.calls.filter(([input]) => new URL(String(input), 'https://candidary.test').pathname.endsWith('/guestbook/summary')).length;

    const initial = summaryCount();
    window.dispatchEvent(new Event('focus'));
    await Promise.resolve();
    expect(summaryCount()).toBe(initial);

    await user.click(within(navigation).getByRole('button', { name: 'Guestbook 1' }));
    const active = summaryCount();
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(summaryCount()).toBe(active + 1));

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    window.dispatchEvent(new Event('focus'));
    await Promise.resolve();
    expect(summaryCount()).toBe(active + 1);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await user.click(within(navigation).getByRole('button', { name: /^Gallery$/i }));
    const afterLeaving = summaryCount();
    window.dispatchEvent(new Event('focus'));
    await Promise.resolve();
    expect(summaryCount()).toBe(afterLeaving);
  });

  it('shows the exact action matrix for every server-owned note and caption state', async () => {
    const pages: Record<string, unknown[]> = {
      'needs-review': [
        { id: 'pending', source: 'guest_note', guestName: 'Pending', body: 'Pending.', createdAt: '2026-09-19T22:00:00Z', state: 'pending', visibility: 'author_only' },
        { id: 'unpublished', source: 'photo_caption', mediaId: 'unpublished', guestName: 'Unpublished', body: 'Unpublished.', createdAt: '2026-09-19T22:01:00Z', state: 'unpublished', visibility: 'author_only', previewAvailable: false },
      ],
      shared: [
        { id: 'approved', source: 'guest_note', guestName: 'Approved', body: 'Approved.', createdAt: '2026-09-19T22:02:00Z', state: 'approved', visibility: 'shared' },
        { id: 'published', source: 'photo_caption', mediaId: 'published', guestName: 'Published', body: 'Published.', createdAt: '2026-09-19T22:03:00Z', state: 'published', visibility: 'shared', previewAvailable: false },
      ],
      hidden: [
        { id: 'rejected', source: 'guest_note', guestName: 'Rejected', body: 'Rejected.', createdAt: '2026-09-19T22:04:00Z', state: 'rejected', visibility: 'author_only' },
        { id: 'hidden', source: 'photo_caption', mediaId: 'hidden', guestName: 'Hidden caption', body: 'Hidden.', createdAt: '2026-09-19T22:05:00Z', state: 'hidden', visibility: 'author_only', previewAvailable: false },
      ],
      deleted: [
        { id: 'deleted', source: 'guest_note', guestName: 'Deleted', body: 'Deleted.', createdAt: '2026-09-19T22:06:00Z', state: 'deleted', visibility: 'host_only' },
      ],
    };
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://candidary.test');
      return success({ items: pages[url.searchParams.get('view') ?? 'shared'], nextCursor: null, summary: emptySummary });
    }));
    const user = userEvent.setup();
    render(<ManagerGuestbookPanel eventId="event-a" eventTimezone="America/Chicago" summary={emptySummary} onSummaryRefresh={vi.fn(async () => undefined)} onOpenSettings={vi.fn()} />);

    const actions = (name: string) => within(screen.getByRole('listitem', { name: new RegExp(name, 'i') }))
      .getAllByRole('button').map((button) => button.textContent);
    await screen.findByRole('listitem', { name: /Approved guest note/i });
    expect(actions('Approved guest note')).toEqual(['Keep private', 'Delete']);
    expect(actions('Published photo caption')).toEqual(['Hide photo & caption']);
    await user.click(screen.getByRole('button', { name: /Needs review/i }));
    await screen.findByRole('listitem', { name: /Pending guest note/i });
    expect(actions('Pending guest note')).toEqual(['Share', 'Keep private', 'Delete']);
    expect(actions('Unpublished photo caption')).toEqual(['Publish photo & caption', 'Hide photo & caption']);
    await user.click(screen.getByRole('button', { name: /Hidden/i }));
    await screen.findByRole('listitem', { name: /Rejected guest note/i });
    expect(actions('Rejected guest note')).toEqual(['Share', 'Delete']);
    expect(actions('Hidden caption photo caption')).toEqual(['Publish photo & caption']);
    await user.click(screen.getByRole('button', { name: /Deleted/i }));
    await screen.findByRole('listitem', { name: /Deleted guest note/i });
    expect(actions('Deleted guest note')).toEqual(['Restore', 'Permanently delete']);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('offers immediate Undo after soft delete and restores the note to Hidden', async () => {
    const requests: Array<{ url: URL; body?: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://candidary.test');
      requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (init?.method === 'PATCH') {
        const request = JSON.parse(String(init.body));
        return request.action === 'delete'
          ? success({ item: { id: 'note-a', source: 'guest_note', guestName: 'Avery', body: 'Delete me.', createdAt: '2026-09-19T22:00:00Z', state: 'deleted', visibility: 'host_only' } })
          : success({ item: { id: 'note-a', source: 'guest_note', guestName: 'Avery', body: 'Delete me.', createdAt: '2026-09-19T22:00:00Z', state: 'rejected', visibility: 'author_only' } });
      }
      return success({ items: [{ id: 'note-a', source: 'guest_note', guestName: 'Avery', body: 'Delete me.', createdAt: '2026-09-19T22:00:00Z', state: 'approved', visibility: 'shared' }], nextCursor: null, summary: { ...emptySummary, sharedCount: 1 } });
    }));
    const user = userEvent.setup();
    render(<ManagerGuestbookPanel eventId="event-a" eventTimezone="America/Chicago" summary={{ ...emptySummary, sharedCount: 1 }} onSummaryRefresh={vi.fn(async () => undefined)} onOpenSettings={vi.fn()} />);
    const row = await screen.findByRole('listitem', { name: /Avery guest note/i });
    await user.click(within(row).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeVisible();
    expect(screen.queryByText('Delete me.')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument());
    expect(requests.filter(({ body }) => body).map(({ body }) => body)).toEqual([
      { action: 'delete', expectedState: 'approved' },
      { action: 'restore', expectedState: 'deleted' },
    ]);
  });

  it('names the capacity consequence before purge and retains a failed row with row-local Retry', async () => {
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    let purgeCalls = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        purgeCalls += 1;
        return failure('INTERNAL_ERROR', 'Permanent deletion failed.', 503);
      }
      return success({ items: [{ id: 'deleted', source: 'guest_note', guestName: null, body: 'Keep until confirmed.', createdAt: '2026-09-19T22:00:00Z', state: 'deleted', visibility: 'host_only' }], nextCursor: null, summary: { ...emptySummary, deletedCount: 1 } });
    }));
    const user = userEvent.setup();
    render(<ManagerGuestbookPanel eventId="event-a" eventTimezone="America/Chicago" summary={{ ...emptySummary, deletedCount: 1 }} onSummaryRefresh={vi.fn(async () => undefined)} onOpenSettings={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Deleted/i }));
    const row = await screen.findByRole('listitem', { name: /Unsigned guest note/i });
    const purge = within(row).getByRole('button', { name: 'Permanently delete' });
    await user.click(purge);
    expect(purgeCalls).toBe(0);
    expect(window.confirm).toHaveBeenLastCalledWith(expect.stringMatching(/cannot be undone.*releases one retained-note capacity slot/i));
    await user.click(purge);
    expect(await within(row).findByRole('alert')).toHaveTextContent('Permanent deletion failed.');
    expect(within(row).getByText('Keep until confirmed.')).toBeVisible();
    expect(within(row).getByRole('button', { name: 'Retry' })).toBeVisible();
  });

  it('recovers stale conflicts by reloading the active page without replaying the action', async () => {
    let listReads = 0;
    let patches = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        patches += 1;
        return failure('MESSAGE_STATE_CONFLICT', 'The note changed.', 409);
      }
      listReads += 1;
      return success({ items: [{ id: 'note-a', source: 'guest_note', guestName: 'Avery', body: listReads > 1 ? 'Server row.' : 'Stale row.', createdAt: '2026-09-19T22:00:00Z', state: listReads > 1 ? 'rejected' : 'approved', visibility: listReads > 1 ? 'author_only' : 'shared' }], nextCursor: null, summary: emptySummary });
    }));
    const user = userEvent.setup();
    render(<ManagerGuestbookPanel eventId="event-a" eventTimezone="America/Chicago" summary={emptySummary} onSummaryRefresh={vi.fn(async () => undefined)} onOpenSettings={vi.fn()} />);
    const row = await screen.findByRole('listitem', { name: /Avery guest note/i });
    await user.click(within(row).getByRole('button', { name: 'Keep private' }));
    expect(await within(row).findByRole('alert')).toHaveTextContent('This entry changed.');
    await user.click(within(row).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Server row.')).toBeVisible();
    const refreshedRow = screen.getByRole('listitem', { name: /Avery guest note/i });
    expect(within(refreshedRow).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(refreshedRow).queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(patches).toBe(1);
    expect(listReads).toBe(2);
  });

  it('preserves scroll and returns focus meaningfully when a confirmed action removes its row', async () => {
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 640 });
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') return success({ item: { id: 'first', source: 'guest_note', guestName: 'First', body: 'First row.', createdAt: '2026-09-19T22:00:00Z', state: 'approved', visibility: 'shared' } });
      return success({ items: [
        { id: 'first', source: 'guest_note', guestName: 'First', body: 'First row.', createdAt: '2026-09-19T22:00:00Z', state: 'pending', visibility: 'author_only' },
        { id: 'second', source: 'guest_note', guestName: 'Second', body: 'Second row.', createdAt: '2026-09-19T21:00:00Z', state: 'pending', visibility: 'author_only' },
      ], nextCursor: null, summary: { ...emptySummary, needsReviewCount: 2 } });
    }));
    const user = userEvent.setup();
    render(<ManagerGuestbookPanel eventId="event-a" eventTimezone="America/Chicago" summary={{ ...emptySummary, needsReviewCount: 2 }} onSummaryRefresh={vi.fn(async () => undefined)} onOpenSettings={vi.fn()} />);
    const first = await screen.findByRole('listitem', { name: /First guest note/i });
    await user.click(within(first).getByRole('button', { name: 'Share' }));
    await waitFor(() => expect(screen.queryByText('First row.')).not.toBeInTheDocument());
    await waitFor(() => expect(within(screen.getByRole('listitem', { name: /Second guest note/i })).getByRole('button', { name: 'Share' })).toHaveFocus());
    expect(window.scrollY).toBe(640);
  });

  it('explains gallery-off Shared captions, opens Settings, and labels suppressed published captions exactly', async () => {
    const onOpenSettings = vi.fn();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://candidary.test');
      return success({ items: url.searchParams.get('view') === 'hidden' ? [{ id: 'caption', source: 'photo_caption', mediaId: 'caption', guestName: null, body: 'Suppressed caption.', createdAt: '2026-09-19T22:00:00Z', state: 'published', visibility: 'author_only', previewAvailable: true }] : [], nextCursor: null, summary: { ...emptySummary, galleryVisible: false, hiddenCount: 1 } });
    }));
    const user = userEvent.setup();
    render(<ManagerGuestbookPanel eventId="event-a" eventTimezone="America/Chicago" summary={{ ...emptySummary, galleryVisible: false, hiddenCount: 1 }} onSummaryRefresh={vi.fn(async () => undefined)} onOpenSettings={onOpenSettings} />);
    expect(await screen.findByText('Photo captions are not visible to guests while the gallery is off.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Open Settings' }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: /Hidden/i }));
    expect(await screen.findByText('Published · gallery off')).toBeVisible();
    expect(screen.getByText('Private to contributor')).toBeVisible();
    expect(screen.getByText('Sep 19, 2026, 5:00 PM CDT')).toBeVisible();
    const preview = screen.getByRole('presentation');
    expect(preview).toHaveAttribute('src', '/api/media/caption/preview');
    expect(document.body.textContent).not.toMatch(/objectKey|sessionId|entry-secret/u);
  });
});

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MANAGER_MEDIA_PAGE_SIZE } from '../../shared/constants';
import { mediaPreview } from '../../src/app/api';
import { createAppRouter } from '../../src/app/router';
import { makeMedia } from '../e2e/fixtures/ui-data';

function json(data: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify({ data, requestId: 'request-a' }), {
    status, headers: { 'content-type': 'application/json' },
  }));
}

// Failures arrive as a bare envelope, not wrapped in `data`.
function errorJson(body: Record<string, unknown>, status: number) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  }));
}

const CREATED = {
  event: { id: 'event-a', name: 'Maya & Theo', slug: 'maya-theo' },
  guestLink: 'https://example.test/join/guest-secret',
  managementLink: 'https://example.test/manage/manager-secret',
  csrfToken: 'csrf-a',
};

async function createEvent(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Event name'), 'Maya & Theo');
  await user.type(screen.getByLabelText('Event date'), '2026-09-19');
  await user.type(screen.getByLabelText('Welcome message'), 'Come share the moments you caught.');
  await user.click(screen.getByRole('button', { name: 'Create private event' }));
  await screen.findByRole('heading', { name: 'Your event is ready.' });
}

afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('public Candidary experience', () => {
  it('presents the approved value proposition and workflow', () => {
    render(<RouterProvider router={createAppRouter(['/'])} />);
    expect(screen.getByRole('heading', { name: 'Gather the moments you didn’t see.' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Create your event' })).toHaveAttribute('href', '/create');
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('creates an event and clearly returns both access links', async () => {
    vi.stubGlobal('fetch', vi.fn(() => json(CREATED, 201)));
    render(<RouterProvider router={createAppRouter(['/create'])} />);
    await createEvent(userEvent.setup());
    expect(screen.getByRole('heading', { name: 'Your event is ready.' })).toBeVisible();
    expect(screen.getByText('Guest link')).toBeVisible();
    expect(screen.getByText('Management link')).toBeVisible();
    expect(screen.getByText(/cannot be recovered/i)).toBeVisible();
  });

  it('associates create errors with their fields and focuses the first invalid one', async () => {
    vi.stubGlobal('fetch', vi.fn(() => errorJson({
      code: 'VALIDATION_FAILED',
      message: 'Check the event details.',
      fieldErrors: {
        name: 'Enter an event name.',
        eventDate: 'Choose an event date.',
        welcomeMessage: 'Write a welcome message.',
      },
      requestId: 'request-a',
    }, 422)));
    render(<RouterProvider router={createAppRouter(['/create'])} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Create private event' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Check the event details.');

    const associations = [
      { label: 'Event name', id: 'name-error', message: 'Enter an event name.' },
      { label: 'Event date', id: 'eventDate-error', message: 'Choose an event date.' },
      { label: 'Welcome message', id: 'welcomeMessage-error', message: 'Write a welcome message.' },
    ];
    for (const { label, id, message } of associations) {
      // An exact label query must keep working while the field is in error: the name identifies the
      // field, the error is a description. If the error leaks into the name this lookup throws.
      const control = screen.getByLabelText(label);
      expect(control, `${id} control is invalid`).toHaveAttribute('aria-invalid', 'true');
      expect(control, `${id} control is described`).toHaveAttribute('aria-describedby', id);
      // The relation only helps if it resolves to something the user can actually perceive.
      const description = document.getElementById(id);
      expect(description, `${id} is rendered`).not.toBeNull();
      expect(description).toBeVisible();
      expect(description).toHaveTextContent(message);
      // The computed name stays the stable field label; the error arrives only as the description.
      expect(control, `${id} keeps its name`).toHaveAccessibleName(label);
      expect(control, `${id} carries the error as its description`).toHaveAccessibleDescription(message);
    }

    await waitFor(() => expect(screen.getByLabelText('Event name')).toHaveFocus());
  });

  it('focuses the first invalid field in form order, not the order the server replied in', async () => {
    vi.stubGlobal('fetch', vi.fn(() => errorJson({
      code: 'VALIDATION_FAILED',
      message: 'Check the event details.',
      fieldErrors: {
        welcomeMessage: 'Write a welcome message.',
        eventDate: 'Choose an event date.',
      },
      requestId: 'request-a',
    }, 422)));
    render(<RouterProvider router={createAppRouter(['/create'])} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Event name'), 'Maya & Theo');
    await user.click(screen.getByRole('button', { name: 'Create private event' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Check the event details.');

    await waitFor(() => expect(screen.getByLabelText('Event date')).toHaveFocus());
    expect(screen.getByLabelText('Event name')).not.toHaveAttribute('aria-invalid', 'true');
  });

  it('announces a copied link only after the clipboard write succeeds', async () => {
    let resolveCopy!: () => void;
    vi.stubGlobal('fetch', vi.fn(() => json(CREATED, 201)));
    render(<RouterProvider router={createAppRouter(['/create'])} />);
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(
      () => new Promise<void>((resolve) => { resolveCopy = resolve; }),
    );
    await createEvent(user);

    await user.click(screen.getByRole('button', { name: 'Copy guest link' }));
    expect(writeText).toHaveBeenCalledWith('https://example.test/join/guest-secret');
    expect(screen.queryByText('Copied')).not.toBeInTheDocument();

    await act(async () => { resolveCopy(); });
    expect(await screen.findByText('Copied')).toBeVisible();
  });

  it('lets the host reveal and hide the full private link on demand', async () => {
    vi.stubGlobal('fetch', vi.fn(() => json(CREATED, 201)));
    render(<RouterProvider router={createAppRouter(['/create'])} />);
    const user = userEvent.setup();
    await createEvent(user);

    const reveal = screen.getByRole('button', { name: 'Show full guest link' });
    expect(reveal).toHaveAttribute('aria-expanded', 'false');
    await user.click(reveal);

    const hide = screen.getByRole('button', { name: 'Hide full guest link' });
    expect(hide).toHaveAttribute('aria-expanded', 'true');
    // The control must point at the link it reveals, and that link must be selectable.
    const revealed = document.getElementById(hide.getAttribute('aria-controls') ?? '');
    expect(revealed, 'aria-controls resolves').not.toBeNull();
    expect(revealed).toBeVisible();
    expect(revealed).toHaveTextContent('https://example.test/join/guest-secret');
    expect(revealed).toHaveAttribute('tabindex', '0');
    // The management link keeps its own independent control.
    expect(screen.getByRole('button', { name: 'Show full management link' })).toHaveAttribute('aria-expanded', 'false');

    await user.click(hide);
    expect(screen.getByRole('button', { name: 'Show full guest link' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('reports unavailable clipboard writes without claiming success, and reveals the link instead', async () => {
    vi.stubGlobal('fetch', vi.fn(() => json(CREATED, 201)));
    render(<RouterProvider router={createAppRouter(['/create'])} />);
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('Permission denied'));
    await createEvent(user);
    expect(screen.getByRole('button', { name: 'Show full guest link' })).toHaveAttribute('aria-expanded', 'false');

    await user.click(screen.getByRole('button', { name: 'Copy guest link' }));
    expect(await screen.findByText('Copy unavailable. Select the link instead.')).toBeVisible();
    expect(screen.queryByText('Copied')).not.toBeInTheDocument();

    const hide = screen.getByRole('button', { name: 'Hide full guest link' });
    expect(hide).toHaveAttribute('aria-expanded', 'true');
    const revealed = document.getElementById(hide.getAttribute('aria-controls') ?? '');
    expect(revealed, 'aria-controls resolves').not.toBeNull();
    expect(revealed).toBeVisible();
    expect(revealed).toHaveTextContent('https://example.test/join/guest-secret');
  });
});

describe('guest event experience', () => {
  it('loads the private photo drop first and keeps the gallery and notes secondary', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/event/maya-theo')) return json({ event: {
        id: 'event-a', slug: 'maya-theo', name: 'Maya & Theo', eventDate: '2026-09-19',
        welcomeMessage: 'We would love to see the day through your eyes.', uploadsEnabled: true,
        galleryVisible: true, moderationRequired: true,
      }, role: 'guest' });
      if (url.endsWith('/gallery')) return json({ media: [{
        id: 'media-a', originalFilename: 'toast.png', guestName: 'Avery', caption: 'Golden hour',
        publicationStatus: 'published', uploadState: 'stored', width: 800, height: 600,
      }] });
      if (url.endsWith('/contributions')) return json({ media: [] });
      if (url.endsWith('/messages')) return json({ items: [{ id: 'note-a', kind: 'message', guestName: 'Sam', body: 'To many happy years.', createdAt: '2026-09-19T20:00:00Z', moderationStatus: 'approved' }] });
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<RouterProvider router={createAppRouter(['/event/maya-theo'])} />);
    expect(await screen.findByRole('heading', { name: 'We would love to see the day through your eyes.' })).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Maya & Theo/, { selector: '.photo-drop__event' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Take a photo' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Choose recent photos' })).toBeVisible();
    const user = userEvent.setup();
    await user.click(screen.getByText(/Shared gallery/, { selector: 'span' }));
    expect(await screen.findByAltText('Golden hour')).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await user.click(screen.getByText(/Leave a note/, { selector: 'span' }));
    expect(screen.getByText('To many happy years.')).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

const MANAGED_EVENT = {
  id: 'event-a', slug: 'maya-theo', name: 'Maya & Theo', eventDate: '2026-09-19',
  welcomeMessage: 'Welcome.', uploadsEnabled: true, galleryVisible: true, moderationRequired: true,
  storedMediaCount: 3, storedBytes: 128,
  guestAccessExpiresAt: '2026-10-19T00:00:00Z', purgeAfter: '2026-12-19T00:00:00Z',
};

interface MediaPage { media: unknown[]; nextCursor: string | null }

// Answers every manager GET, resolving `/media` from a cursor-keyed page map that the test may mutate
// between requests. A request that carries no `cursor` parameter is the first page: the server rejects
// `cursor=` as malformed, so the client has to omit the parameter rather than send an empty one.
function managerFetch(pages: Record<string, MediaPage>, mediaRequests: string[] = []) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/api/manage/events/event-a')) return json({ event: MANAGED_EVENT });
    if (url.includes('/media')) {
      mediaRequests.push(url);
      const cursor = new URL(url, 'https://candidary.test').searchParams.get('cursor') ?? 'first';
      return json(pages[cursor] ?? { media: [], nextCursor: null });
    }
    if (url.includes('/messages')) return json({ messages: [] });
    if (url.endsWith('/exports')) return json({ exports: [] });
    if (url.endsWith('/links')) return json({ guestLink: 'https://example.test/join/guest' });
    throw new Error(`Unexpected request ${url}`);
  });
}

function previewSources() {
  return Array.from(document.querySelectorAll('.moderation-grid img'), (image) => image.getAttribute('src'));
}

describe('manager experience', () => {
  it('appends the next media page and keeps every row unique', async () => {
    const rows = makeMedia(MANAGER_MEDIA_PAGE_SIZE + 1);
    const mediaRequests: string[] = [];
    vi.stubGlobal('fetch', managerFetch({
      first: { media: rows.slice(0, MANAGER_MEDIA_PAGE_SIZE), nextCursor: 'page-two' },
      // The oldest row of page one shifted onto page two; appending it twice would be a visible bug.
      'page-two': { media: [rows[MANAGER_MEDIA_PAGE_SIZE - 1], rows[MANAGER_MEDIA_PAGE_SIZE]], nextCursor: null },
    }, mediaRequests));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    expect(await screen.findByRole('heading', { name: 'Live intake' })).toBeVisible();
    await waitFor(() => expect(document.querySelectorAll('.moderation-grid img')).toHaveLength(MANAGER_MEDIA_PAGE_SIZE));
    expect(mediaRequests[0], 'an empty cursor is a 422, so the first page omits it').not.toContain('cursor');

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Load more photos' }));
    await waitFor(() => expect(document.querySelectorAll('.moderation-grid img')).toHaveLength(MANAGER_MEDIA_PAGE_SIZE + 1));
    expect(mediaRequests.at(-1)).toContain('cursor=page-two');
    expect(new Set(previewSources()).size).toBe(MANAGER_MEDIA_PAGE_SIZE + 1);
    expect(screen.queryByRole('button', { name: 'Load more photos' })).not.toBeInTheDocument();
  });

  it('manager previews use lazy loading and asynchronous decoding', async () => {
    vi.stubGlobal('fetch', managerFetch({ first: { media: makeMedia(3), nextCursor: null } }));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    expect(await screen.findByRole('heading', { name: 'Live intake' })).toBeVisible();
    await waitFor(() => expect(document.querySelectorAll('.moderation-grid img')).toHaveLength(3));

    for (const image of document.querySelectorAll('.moderation-grid img')) {
      expect(image).toHaveAttribute('loading', 'lazy');
      expect(image).toHaveAttribute('decoding', 'async');
    }
  });

  it('merges the polled first page ahead of retained pages without dropping or duplicating rows', async () => {
    // `Moment 2` … `Moment 8`; small pages keep the merge arithmetic legible.
    const rows = makeMedia(8).slice(1);
    const pages: Record<string, MediaPage> = {
      first: { media: rows.slice(0, 3), nextCursor: 'page-two' },
      'page-two': { media: rows.slice(3, 5), nextCursor: 'page-three' },
      'page-three': { media: rows.slice(5, 6), nextCursor: null },
    };
    const mediaRequests: string[] = [];
    const interval = vi.spyOn(window, 'setInterval');
    vi.stubGlobal('fetch', managerFetch(pages, mediaRequests));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    expect(await screen.findByRole('heading', { name: 'Live intake' })).toBeVisible();
    await waitFor(() => expect(document.querySelectorAll('.moderation-grid img')).toHaveLength(3));

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Load more photos' }));
    await waitFor(() => expect(document.querySelectorAll('.moderation-grid img')).toHaveLength(5));

    // A new delivery lands, pushing `Moment 4` off the refreshed first page. The retained second page
    // is untouched, and `Moment 2`/`Moment 3` are now in both the refreshed page and the retained list.
    pages.first = { media: [rows[6], rows[0], rows[1]], nextCursor: 'page-two' };
    const poll = interval.mock.calls.filter(([, delay]) => delay === 5_000).at(-1)?.[0];
    expect(poll).toBeTypeOf('function');
    await act(async () => { (poll as () => void)(); });

    await waitFor(() => expect(document.querySelectorAll('.moderation-grid img')).toHaveLength(6));
    expect(mediaRequests.at(-1), 'the poll asks for the first page only').not.toContain('cursor');
    expect(previewSources()[0], 'refreshed rows lead the retained ones').toBe(mediaPreview(rows[6]!.id));
    expect(screen.getByAltText('Moment 8'), 'the polled arrival merges ahead').toBeVisible();
    expect(screen.getByAltText('Moment 4'), 'a row pushed off the first page is retained').toBeVisible();
    expect(screen.getByAltText('Moment 6'), 'the retained second page survives the poll').toBeVisible();
    expect(new Set(previewSources()).size).toBe(6);

    // The poll must not rewind the continuation cursor to the first page's own `nextCursor`.
    await user.click(screen.getByRole('button', { name: 'Load more photos' }));
    await waitFor(() => expect(document.querySelectorAll('.moderation-grid img')).toHaveLength(7));
    expect(mediaRequests.at(-1)).toContain('cursor=page-three');
  });

  it('keeps an appended page when a poll resolves before that append has committed', async () => {
    const rows = makeMedia(6).slice(1);
    const mediaRequests: string[] = [];
    let releaseLoadMore!: () => void;
    let releasePoll!: () => void;
    const interval = vi.spyOn(window, 'setInterval');
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/manage/events/event-a')) return json({ event: MANAGED_EVENT });
      if (url.includes('/media')) {
        mediaRequests.push(url);
        if (url.includes('cursor=page-two')) {
          return new Promise<Response>((resolve) => {
            releaseLoadMore = () => resolve(json({ media: rows.slice(2, 4), nextCursor: 'page-three' }));
          });
        }
        if (url.includes('cursor=page-three')) return json({ media: rows.slice(4), nextCursor: null });
        const firstPage = { media: rows.slice(0, 2), nextCursor: 'page-two' };
        // The second cursor-less request is the poll's; hold it so it can be interleaved with the append.
        if (mediaRequests.filter((request) => !request.includes('cursor')).length === 2) {
          return new Promise<Response>((resolve) => { releasePoll = () => resolve(json(firstPage)); });
        }
        return json(firstPage);
      }
      if (url.includes('/messages')) return json({ messages: [] });
      if (url.endsWith('/exports')) return json({ exports: [] });
      if (url.endsWith('/links')) return json({ guestLink: 'https://example.test/join/guest' });
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    expect(await screen.findByRole('heading', { name: 'Live intake' })).toBeVisible();
    await waitFor(() => expect(document.querySelectorAll('.moderation-grid img')).toHaveLength(2));

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Load more photos' }));
    const poll = interval.mock.calls.filter(([, delay]) => delay === 5_000).at(-1)?.[0];
    await act(async () => { (poll as () => void)(); });

    // Both answers land in one microtask drain, so React has not committed the append — let alone run a
    // passive effect — by the time the poll decides what the list contains.
    await act(async () => { releaseLoadMore(); releasePoll(); });

    await waitFor(() => expect(document.querySelectorAll('.moderation-grid img')).toHaveLength(4));
    expect(screen.getByAltText('Moment 4'), 'the appended page survives the poll').toBeVisible();
    expect(screen.getByAltText('Moment 5')).toBeVisible();

    // The cursor still follows the rows on screen, so nothing has been left behind it.
    await user.click(screen.getByRole('button', { name: 'Load more photos' }));
    await waitFor(() => expect(document.querySelectorAll('.moderation-grid img')).toHaveLength(5));
    expect(mediaRequests.at(-1)).toContain('cursor=page-three');
  });

  it('drops an in-flight page onto a list the poll has already restarted', async () => {
    const rows = makeMedia(8).slice(1);
    const mediaRequests: string[] = [];
    let releaseLoadMore!: () => void;
    const interval = vi.spyOn(window, 'setInterval');
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/manage/events/event-a')) return json({ event: MANAGED_EVENT });
      if (url.includes('/media')) {
        mediaRequests.push(url);
        if (url.includes('cursor=page-two')) {
          return new Promise<Response>((resolve) => {
            releaseLoadMore = () => resolve(json({ media: rows.slice(2, 4), nextCursor: 'page-three' }));
          });
        }
        if (url.includes('cursor=page-four')) return json({ media: rows.slice(6), nextCursor: null });
        // The poll's first page is a burst that shares nothing with the rows on screen.
        return mediaRequests.filter((request) => !request.includes('cursor')).length === 2
          ? json({ media: rows.slice(4, 6), nextCursor: 'page-four' })
          : json({ media: rows.slice(0, 2), nextCursor: 'page-two' });
      }
      if (url.includes('/messages')) return json({ messages: [] });
      if (url.endsWith('/exports')) return json({ exports: [] });
      if (url.endsWith('/links')) return json({ guestLink: 'https://example.test/join/guest' });
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    expect(await screen.findByRole('heading', { name: 'Live intake' })).toBeVisible();
    await waitFor(() => expect(document.querySelectorAll('.moderation-grid img')).toHaveLength(2));

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Load more photos' }));
    const poll = interval.mock.calls.filter(([, delay]) => delay === 5_000).at(-1)?.[0];
    await act(async () => { (poll as () => void)(); });
    await waitFor(() => expect(screen.getByAltText('Moment 6')).toBeVisible());

    await act(async () => { releaseLoadMore(); });
    // The page in flight continues the keyset the restart abandoned, so appending it would splice rows
    // from the old ordering into the new one and hand the cursor back to the list nobody can reach.
    expect(document.querySelectorAll('.moderation-grid img')).toHaveLength(2);
    for (const caption of ['Moment 2', 'Moment 3', 'Moment 4', 'Moment 5']) {
      expect(screen.queryByAltText(caption), caption).not.toBeInTheDocument();
    }

    await user.click(screen.getByRole('button', { name: 'Load more photos' }));
    await waitFor(() => expect(document.querySelectorAll('.moderation-grid img')).toHaveLength(3));
    expect(mediaRequests.at(-1)).toContain('cursor=page-four');
  });

  it('never lets a superseded load reinstate its rows or its cursor', async () => {
    const rows = makeMedia(4).slice(1);
    let releaseFiltered!: () => void;
    let mediaRequests = 0;
    const interval = vi.spyOn(window, 'setInterval');
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/manage/events/event-a')) return json({ event: MANAGED_EVENT });
      if (url.includes('/media')) {
        mediaRequests += 1;
        // Hold the filtered load so it lands after the host has already cleared the filter.
        if (url.includes('guestName=')) {
          return new Promise<Response>((resolve) => {
            releaseFiltered = () => resolve(json({ media: rows.slice(2), nextCursor: 'stale-page' }));
          });
        }
        return json({ media: rows.slice(0, 2), nextCursor: null });
      }
      if (url.includes('/messages')) return json({ messages: [] });
      if (url.endsWith('/exports')) return json({ exports: [] });
      if (url.endsWith('/links')) return json({ guestLink: 'https://example.test/join/guest' });
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    expect(await screen.findByRole('heading', { name: 'Live intake' })).toBeVisible();
    expect(await screen.findByAltText('Moment 2')).toBeVisible();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Filter by guest name'), 'Avery');
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(mediaRequests).toBe(3));

    await act(async () => { releaseFiltered(); });
    // `refresh` replaces rather than merges, so before polling merged this was self-correcting. It is
    // not any more: a stale list installed here sits behind every later poll for the rest of the session.
    expect(screen.queryByAltText('Moment 4'), 'filtered rows do not return').not.toBeInTheDocument();
    expect(document.querySelectorAll('.moderation-grid img')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Load more photos' }), 'no stale cursor').not.toBeInTheDocument();

    const poll = interval.mock.calls.filter(([, delay]) => delay === 5_000).at(-1)?.[0];
    await act(async () => { (poll as () => void)(); });
    expect(screen.queryByAltText('Moment 4'), 'and the poll cannot retain them').not.toBeInTheDocument();
    expect(document.querySelectorAll('.moderation-grid img')).toHaveLength(2);
  });

  it('restarts from the polled first page when the keyset moved past everything on screen', async () => {
    // Pages of two keep the burst arithmetic small: the host holds four rows, then six newer photos
    // land inside one interval, so the refreshed first page shares no id with anything on screen.
    const rows = makeMedia(8).slice(1);
    const mediaRequests: string[] = [];
    const pages: Record<string, MediaPage> = {
      first: { media: rows.slice(0, 2), nextCursor: 'page-two' },
      'page-two': { media: rows.slice(2, 4), nextCursor: 'page-three' },
      'page-four': { media: rows.slice(6), nextCursor: null },
    };
    const interval = vi.spyOn(window, 'setInterval');
    vi.stubGlobal('fetch', managerFetch(pages, mediaRequests));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    expect(await screen.findByRole('heading', { name: 'Live intake' })).toBeVisible();
    await waitFor(() => expect(document.querySelectorAll('.moderation-grid img')).toHaveLength(2));

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Load more photos' }));
    await waitFor(() => expect(document.querySelectorAll('.moderation-grid img')).toHaveLength(4));

    pages.first = { media: rows.slice(4, 6), nextCursor: 'page-four' };
    const poll = interval.mock.calls.filter(([, delay]) => delay === 5_000).at(-1)?.[0];
    await act(async () => { (poll as () => void)(); });

    // Merging would leave Moment 2 … Moment 5 on screen with the photos between them unreachable by
    // any cursor. The discontinuity is provable, so the list restarts from the page the host can see.
    await waitFor(() => expect(document.querySelectorAll('.moderation-grid img')).toHaveLength(2));
    expect(screen.getByAltText('Moment 6')).toBeVisible();
    expect(screen.getByAltText('Moment 7')).toBeVisible();
    for (const caption of ['Moment 2', 'Moment 3', 'Moment 4', 'Moment 5']) {
      expect(screen.queryByAltText(caption), caption).not.toBeInTheDocument();
    }

    // The restart adopts the new cursor rather than keeping one that points into the abandoned keyset.
    await user.click(screen.getByRole('button', { name: 'Load more photos' }));
    await waitFor(() => expect(document.querySelectorAll('.moderation-grid img')).toHaveLength(3));
    expect(mediaRequests.at(-1)).toContain('cursor=page-four');
    expect(screen.getByAltText('Moment 8')).toBeVisible();
  });

  it('retires the continuation cursor the moment the guest filter changes', async () => {
    const rows = makeMedia(4).slice(1);
    let releaseFiltered!: () => void;
    let mediaRequests = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/manage/events/event-a')) return json({ event: MANAGED_EVENT });
      if (url.includes('/media')) {
        mediaRequests += 1;
        // Hold the filtered load open: this is the window in which the old cursor is still spendable.
        if (url.includes('guestName=')) {
          return new Promise<Response>((resolve) => {
            releaseFiltered = () => resolve(json({ media: rows.slice(2), nextCursor: null }));
          });
        }
        return json({ media: rows.slice(0, 2), nextCursor: 'page-two' });
      }
      if (url.includes('/messages')) return json({ messages: [] });
      if (url.endsWith('/exports')) return json({ exports: [] });
      if (url.endsWith('/links')) return json({ guestLink: 'https://example.test/join/guest' });
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    expect(await screen.findByRole('heading', { name: 'Live intake' })).toBeVisible();
    expect(await screen.findByRole('button', { name: 'Load more photos' })).toBeVisible();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Filter by guest name'), 'Avery');
    await user.click(screen.getByRole('button', { name: 'Filter' }));

    // The filtered rows have not arrived yet, so the old grid is still on screen — but the cursor it
    // was paged with belongs to the unfiltered keyset and must no longer be spendable.
    expect(document.querySelectorAll('.moderation-grid img')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Load more photos' })).not.toBeInTheDocument();
    expect(mediaRequests).toBe(2);

    await act(async () => { releaseFiltered(); });
    expect(await screen.findByAltText('Moment 4')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Load more photos' })).not.toBeInTheDocument();
  });

  it('discards media pages that resolve after the guest filter narrowed the list', async () => {
    const rows = makeMedia(7).slice(1);
    const held: Array<() => void> = [];
    let mediaRequests = 0;
    const interval = vi.spyOn(window, 'setInterval');
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/manage/events/event-a')) return json({ event: MANAGED_EVENT });
      if (url.includes('/media')) {
        mediaRequests += 1;
        // Requests two and three are the load-more page and the poll. Hold both open until the host
        // has already refiltered, then answer them with rows that belong to the unfiltered query.
        if (mediaRequests === 2 || mediaRequests === 3) {
          const stale = mediaRequests === 2
            ? { media: rows.slice(2, 4), nextCursor: null }
            : { media: [rows[4], rows[0], rows[1]], nextCursor: 'page-two' };
          return new Promise<Response>((resolve) => { held.push(() => resolve(json(stale))); });
        }
        return json(url.includes('guestName=')
          ? { media: rows.slice(5), nextCursor: null }
          : { media: rows.slice(0, 2), nextCursor: 'page-two' });
      }
      if (url.includes('/messages')) return json({ messages: [] });
      if (url.endsWith('/exports')) return json({ exports: [] });
      if (url.endsWith('/links')) return json({ guestLink: 'https://example.test/join/guest' });
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    expect(await screen.findByRole('heading', { name: 'Live intake' })).toBeVisible();
    expect(await screen.findByAltText('Moment 2')).toBeVisible();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Load more photos' }));
    const poll = interval.mock.calls.filter(([, delay]) => delay === 5_000).at(-1)?.[0];
    await act(async () => { (poll as () => void)(); });
    expect(held).toHaveLength(2);

    await user.type(screen.getByLabelText('Filter by guest name'), 'Avery');
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    expect(await screen.findByAltText('Moment 7')).toBeVisible();

    await act(async () => { for (const release of held) release(); });
    // Both answers belong to the unfiltered query. Appending or merging either would resurrect rows the
    // host just filtered away, and the poll's cursor would reopen paging over the wrong list.
    for (const caption of ['Moment 2', 'Moment 3', 'Moment 4', 'Moment 5', 'Moment 6']) {
      expect(screen.queryByAltText(caption), caption).not.toBeInTheDocument();
    }
    expect(screen.getByAltText('Moment 7')).toBeVisible();
    expect(document.querySelectorAll('.moderation-grid img')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Load more photos' })).not.toBeInTheDocument();
  });

  it('keeps the manager view in place when a bulk publish, delete, or export fails', async () => {
    const rows = makeMedia(3).slice(1);
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? 'GET').toUpperCase() !== 'GET') {
        return errorJson({ code: 'CONFLICT', message: 'That photo changed before your update.', requestId: 'request-a' }, 409);
      }
      if (url.endsWith('/api/manage/events/event-a')) return json({ event: MANAGED_EVENT });
      if (url.includes('/media')) return json({ media: rows, nextCursor: null });
      if (url.includes('/messages')) return json({ messages: [] });
      if (url.endsWith('/exports')) return json({ exports: [] });
      if (url.endsWith('/links')) return json({ guestLink: 'https://example.test/join/guest' });
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    expect(await screen.findByRole('heading', { name: 'Live intake' })).toBeVisible();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /gallery/i }));
    await waitFor(() => expect(document.querySelectorAll('.moderation-grid article')).toHaveLength(2));

    async function expectRecoverableFailure(label: string, act_: () => Promise<void>) {
      await act_();
      expect(await screen.findByRole('alert'), label).toHaveTextContent('That photo changed before your update.');
      expect(screen.getByRole('heading', { name: 'Gallery publishing' }), label).toBeVisible();
      expect(document.querySelectorAll('.moderation-grid article'), label).toHaveLength(2);
    }

    await user.click(screen.getByRole('checkbox', { name: 'Select moment-2.jpg' }));
    await expectRecoverableFailure('bulk publish', () => user.click(screen.getByRole('button', { name: 'Publish selected' })));
    await expectRecoverableFailure('delete', () => user.click(screen.getByRole('button', { name: 'Delete moment-2.jpg' })));
    await expectRecoverableFailure('export', () => user.click(screen.getByRole('button', { name: 'Prepare download' })));

    await user.click(screen.getByRole('button', { name: 'Dismiss error' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Gallery publishing' })).toBeVisible();
  });

  it('polls live intake so a new private delivery appears without navigation', async () => {
    let mediaRequests = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/manage/events/event-a')) return json({ event: {
        id: 'event-a', slug: 'maya-theo', name: 'Maya & Theo', eventDate: '2026-09-19',
        welcomeMessage: 'Welcome.', uploadsEnabled: true, galleryVisible: false,
        moderationRequired: true, storedMediaCount: mediaRequests > 0 ? 1 : 0, storedBytes: 128,
        guestAccessExpiresAt: '2026-10-19T00:00:00Z', purgeAfter: '2026-12-19T00:00:00Z',
      } });
      if (url.includes('/media')) {
        mediaRequests += 1;
        return json({ media: mediaRequests > 1 ? [{
          id: 'media-new', originalFilename: 'new-arrival.png', guestName: 'Avery',
          publicationStatus: 'unpublished', uploadState: 'stored',
        }] : [] });
      }
      if (url.includes('/messages')) return json({ messages: [] });
      if (url.endsWith('/exports')) return json({ exports: [] });
      if (url.endsWith('/links')) return json({ guestLink: '' });
      throw new Error(`Unexpected request ${url}`);
    });
    const interval = vi.spyOn(window, 'setInterval');
    vi.stubGlobal('fetch', fetchMock);
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    expect(await screen.findByRole('heading', { name: 'Live intake' })).toBeVisible();
    expect(screen.queryByText('From Avery')).not.toBeInTheDocument();

    const poll = interval.mock.calls.find(([, delay]) => delay === 5_000)?.[0];
    expect(poll).toBeTypeOf('function');
    await act(async () => { (poll as () => void)(); });

    expect(await screen.findByText('From Avery')).toBeVisible();
  });

  it('opens on live intake, filters by guest name, and keeps gallery publishing secondary', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/manage/events/event-a')) return json({ event: {
        id: 'event-a', slug: 'maya-theo', name: 'Maya & Theo', eventDate: '2026-09-19',
        welcomeMessage: 'Welcome.', uploadsEnabled: true, galleryVisible: false,
        moderationRequired: true, storedMediaCount: 2, storedBytes: 128,
        guestAccessExpiresAt: '2026-10-19T00:00:00Z', purgeAfter: '2026-12-19T00:00:00Z',
      } });
      if (url.includes('/media')) {
        if (init?.method === 'POST') return json({ changed: ['media-a'] });
        return json({ media: [
          { id: 'media-a', originalFilename: 'toast.png', guestName: 'Avery', caption: 'The toast', publicationStatus: 'unpublished', uploadState: 'stored' },
          { id: 'media-b', originalFilename: 'dance.png', guestName: 'Jamie', caption: 'First dance', publicationStatus: 'unpublished', uploadState: 'stored' },
        ] });
      }
      if (url.includes('/messages')) return json({ messages: [] });
      if (url.endsWith('/exports')) return json({ exports: [] });
      if (url.endsWith('/links')) return json({ guestLink: 'https://example.test/join/guest' });
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    expect(await screen.findByRole('heading', { name: 'Maya & Theo' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Live intake' })).toBeVisible();
    expect(screen.getByText('From Avery')).toBeVisible();
    expect(screen.getByRole('link', { name: /download original toast.png/i })).toHaveAttribute('href', '/api/media/media-a/original');
    const intakeNavigation = screen.getByRole('button', { name: /intake/i });
    const galleryNavigation = screen.getByRole('button', { name: /gallery/i });
    expect(intakeNavigation).toHaveAttribute('aria-pressed', 'true');
    expect(galleryNavigation).toHaveAttribute('aria-pressed', 'false');
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Filter by guest name'), 'Avery');
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('guestName=Avery'),
      expect.anything(),
    ));

    await user.click(galleryNavigation);
    expect(intakeNavigation).toHaveAttribute('aria-pressed', 'false');
    expect(galleryNavigation).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('heading', { name: 'Gallery publishing' })).toBeVisible();
    await user.click(screen.getByRole('checkbox', { name: /toast.png/i }));
    await user.click(screen.getByRole('button', { name: 'Publish selected' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/manage/events/event-a/media/bulk',
      expect.objectContaining({ body: expect.stringContaining('media-a') }),
    ));
    const bulkCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/media/bulk'));
    expect(bulkCall?.[1]?.body).not.toContain('media-b');
  });
});

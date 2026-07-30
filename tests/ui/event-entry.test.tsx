import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { EventEntryPage } from '../../src/pages/EventEntryPage';
import { EventEntryUnavailablePage } from '../../src/pages/EventEntryUnavailablePage';

const TOKEN = 'entry-id.entry-secret-that-must-never-be-logged';
const UNAVAILABLE = '/recover/event-entry?kind=unavailable';

type ReplaceState = (data: unknown, unused: string, url?: string | URL | null) => void;

let replace: Mock<(url: string) => void>;
let replaceState: Mock<ReplaceState>;

function arriveWith(hash: string): void {
  window.location.hash = hash;
}

beforeEach(() => {
  replace = vi.fn();
  // Mirrors the browser: replacing the URL with a fragment-free one clears
  // `location.hash`. A stub that only recorded the call would let the
  // erase-before-fetch assertion pass without the page erasing anything.
  replaceState = vi.fn<ReplaceState>((_state, _title, url) => {
    if (!String(url ?? '').includes('#')) window.location.hash = '';
  });
  vi.spyOn(window.history, 'replaceState').mockImplementation(replaceState);
  // jsdom refuses to let `location` be reassigned, so only the pieces this page
  // touches are stubbed.
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, hash: '', replace },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('event entry shell', () => {
  it('erases the fragment before it makes any request', async () => {
    arriveWith(`#${TOKEN}`);
    let hashWhenFetched = 'not-called';
    const fetchMock = vi.fn(() => {
      hashWhenFetched = window.location.hash;
      return Promise.resolve(new Response(
        JSON.stringify({ data: { location: '/event/maya-theo' }, requestId: 'r' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<MemoryRouter><EventEntryPage /></MemoryRouter>);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(replaceState).toHaveBeenCalledWith(null, '', '/join');
    expect(hashWhenFetched).toBe('');
  });

  it('sends the credential only in the request body', async () => {
    arriveWith(`#${TOKEN}`);
    // Typed through the generic rather than by naming parameters the body does
    // not use, so `mock.calls` is inspectable without tripping unused-args.
    const fetchMock = vi.fn<(path: string, init: RequestInit) => Promise<Response>>(
      () => Promise.resolve(new Response(
        JSON.stringify({ data: { location: '/event/maya-theo' }, requestId: 'r' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<MemoryRouter><EventEntryPage /></MemoryRouter>);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe('/api/entry/exchange');
    expect(path).not.toContain(TOKEN);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ token: TOKEN });
  });

  it('replaces the entry URL with the clean event page on success', async () => {
    arriveWith(`#${TOKEN}`);
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(
      JSON.stringify({ data: { location: '/event/maya-theo' }, requestId: 'r' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))));

    render(<MemoryRouter><EventEntryPage /></MemoryRouter>);

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/event/maya-theo'));
  });

  it('never renders or navigates to anything containing the credential', async () => {
    arriveWith(`#${TOKEN}`);
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(
      JSON.stringify({ data: { location: '/event/maya-theo' }, requestId: 'r' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))));

    const { container } = render(<MemoryRouter><EventEntryPage /></MemoryRouter>);
    await waitFor(() => expect(replace).toHaveBeenCalled());

    expect(container.innerHTML).not.toContain('entry-secret');
    expect(String(replace.mock.calls[0]?.[0])).not.toContain('entry-secret');
  });

  it('sends a missing fragment straight to the unavailable page without a request', async () => {
    arriveWith('');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(<MemoryRouter><EventEntryPage /></MemoryRouter>);

    await waitFor(() => expect(replace).toHaveBeenCalledWith(UNAVAILABLE));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends a refused credential to the same unavailable page', async () => {
    arriveWith(`#${TOKEN}`);
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(
      JSON.stringify({
        code: 'EVENT_ENTRY_UNAVAILABLE',
        message: 'This event entry is no longer available.',
        requestId: 'r',
      }),
      { status: 410, headers: { 'content-type': 'application/json' } },
    ))));

    render(<MemoryRouter><EventEntryPage /></MemoryRouter>);

    await waitFor(() => expect(replace).toHaveBeenCalledWith(UNAVAILABLE));
  });

  it('exchanges exactly once even when the effect runs twice', async () => {
    arriveWith(`#${TOKEN}`);
    const fetchMock = vi.fn(() => Promise.resolve(new Response(
      JSON.stringify({ data: { location: '/event/maya-theo' }, requestId: 'r' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));
    vi.stubGlobal('fetch', fetchMock);

    const view = render(<MemoryRouter><EventEntryPage /></MemoryRouter>);
    view.rerender(<MemoryRouter><EventEntryPage /></MemoryRouter>);

    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('event entry unavailable page', () => {
  it('says the same thing for every reason a scan can fail', () => {
    render(<MemoryRouter><EventEntryUnavailablePage /></MemoryRouter>);

    expect(screen.getByRole('heading', { name: /not available/iu })).toBeInTheDocument();
    expect(screen.getByText(/ask your host/iu)).toBeInTheDocument();
    // Nothing here may hint at which of missing, malformed, unknown, or
    // disabled actually happened.
    expect(document.body.textContent).not.toMatch(/disabled|expired|revoked|invalid/iu);
  });
});

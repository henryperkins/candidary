import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(() => Promise.resolve('data:image/png;base64,x')) } }));

import { resolveEventTheme } from '../../shared/event-theme';
import { createAppRouter } from '../../src/app/router';

function json(data: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify({ data, requestId: 'request-a' }), {
    status, headers: { 'content-type': 'application/json' },
  }));
}

function errorJson(body: Record<string, unknown>, status: number) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  }));
}

const MANAGED_EVENT = {
  id: 'event-a', slug: 'maya-theo', name: 'Maya & Theo', eventDate: '2026-09-19',
  welcomeMessage: 'Welcome.', coverObjectKey: null,
  uploadsEnabled: true, galleryVisible: true, moderationRequired: true,
  storedMediaCount: 3, storedBytes: 128,
  guestAccessExpiresAt: '2026-10-19T00:00:00Z', purgeAfter: '2026-12-19T00:00:00Z',
  eventTimezone: 'America/Chicago', rsvpEnabled: false,
  rsvpDeadlineAt: '2026-09-05T04:59:59.999Z', rsvpDeadlineDate: '2026-09-04',
  rsvpRosterVersion: 7,
  theme: resolveEventTheme({ version: 1, presetId: 'candidary-default', overrides: {} }),
};

interface MediaPage { media: unknown[]; nextCursor: string | null }

function managerFetch(pages: Record<string, MediaPage>) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/api/manage/events/event-a')) return json({ event: MANAGED_EVENT });
    if (url.includes('/media')) {
      const cursor = new URL(url, 'https://candidary.test').searchParams.get('cursor') ?? 'first';
      return json(pages[cursor] ?? { media: [], nextCursor: null });
    }
    if (url.includes('/messages')) return json({ messages: [] });
    if (url.endsWith('/exports')) return json({ exports: [] });
    if (url.endsWith('/entry')) return json({ eventLink: 'https://example.test/join#entry-id.entry-secret', disabledAt: null });
    if (url.includes('/rsvp/summary')) return json({});
    if (url.includes('/rsvp/households')) return json({ households: [], nextCursor: null });
    throw new Error(`Unexpected request ${url}`);
  });
}

async function openSettings(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('heading', { name: 'Live intake' });
  await user.click(within(screen.getByRole('navigation', { name: 'Manager sections' }))
    .getByRole('button', { name: /settings/i }));
}

function typist() {
  return userEvent.setup();
}

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('manager settings autosave guards', () => {
  it('flushes a scheduled edit when the host leaves Settings', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = managerFetch({ first: { media: [], nextCursor: null } });
    const writes: string[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/settings') && String(init?.method).toUpperCase() === 'PATCH') {
        writes.push(String(init?.body));
        return json({ event: { ...MANAGED_EVENT, name: 'Reception' } });
      }
      return fetchMock(input);
    }));
    const user = typist();
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await openSettings(user);

    const name = screen.getByLabelText('Event name');
    await user.clear(name);
    await user.type(name, 'Reception');
    expect(writes).toHaveLength(0);

    await user.click(within(screen.getByRole('navigation', { name: 'Manager sections' }))
      .getByRole('button', { name: /gallery/i }));

    // The debounce clock has not advanced. Only the destination-boundary
    // flush can have started this request.
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!).name).toBe('Reception');
  });

  it('blocks a client route while a save is in flight and proceeds once it confirms', async () => {
    let release: (() => void) | null = null;
    const fetchMock = managerFetch({ first: { media: [], nextCursor: null } });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/settings') && String(init?.method).toUpperCase() === 'PATCH') {
        await new Promise<void>((resolve) => { release = resolve; });
        return json({ event: { ...MANAGED_EVENT, moderationRequired: false } });
      }
      return fetchMock(input);
    }));
    const user = typist();
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await openSettings(user);

    await user.click(screen.getByLabelText('Review notes before sharing'));
    await user.click(screen.getByRole('link', { name: 'Candidary home' }));

    const prompt = await screen.findByRole('alertdialog');
    expect(within(prompt).getByRole('button', { name: 'Leave now' })).toBeVisible();
    expect(within(prompt).queryByRole('button', { name: 'Stay and fix settings' })).not.toBeInTheDocument();
    expect(prompt).toHaveFocus();

    expect(release).not.toBeNull();
    release!();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByRole('navigation', { name: 'Manager sections' })).not.toBeInTheDocument());
  });

  it('always offers Leave now, so a stalled network cannot trap the host', async () => {
    const fetchMock = managerFetch({ first: { media: [], nextCursor: null } });
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/settings') && String(init?.method).toUpperCase() === 'PATCH') {
        return new Promise<Response>(() => { /* never settles */ });
      }
      return fetchMock(input);
    }));
    const user = typist();
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await openSettings(user);

    await user.click(screen.getByLabelText('Review notes before sharing'));
    await user.click(screen.getByRole('link', { name: 'Candidary home' }));
    const prompt = await screen.findByRole('alertdialog');
    expect(within(prompt).getByText(/may still finish saving after you leave/u)).toBeVisible();

    await user.click(within(prompt).getByRole('button', { name: 'Leave now' }));
    await waitFor(() => expect(screen.queryByRole('navigation', { name: 'Manager sections' })).not.toBeInTheDocument());
  });

  it('offers a way back to Settings when the draft cannot be saved', async () => {
    vi.stubGlobal('fetch', managerFetch({ first: { media: [], nextCursor: null } }));
    const user = typist();
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await openSettings(user);

    await user.clear(screen.getByLabelText('Event name'));
    await user.click(screen.getByRole('link', { name: 'Candidary home' }));

    const prompt = await screen.findByRole('alertdialog');
    await user.click(within(prompt).getByRole('button', { name: 'Stay and fix settings' }));

    expect(screen.getByRole('textbox', { name: /Event name/u })).toBeVisible();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('raises a manager notice when a hidden Settings draft cannot save, and routes back', async () => {
    vi.stubGlobal('fetch', managerFetch({ first: { media: [], nextCursor: null } }));
    const user = typist();
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await openSettings(user);

    await user.clear(screen.getByLabelText('Event name'));
    await user.click(within(screen.getByRole('navigation', { name: 'Manager sections' }))
      .getByRole('button', { name: /gallery/i }));

    const notice = await screen.findByRole('region', { name: 'Unsaved settings' });
    expect(within(notice).getByRole('alert')).toHaveTextContent(
      'Event settings has a change that cannot be saved yet.',
    );
    await user.click(within(notice).getByRole('button', { name: 'Open settings' }));
    expect(screen.getByRole('textbox', { name: /Event name/u })).toBeVisible();
  });

  it('keeps autosave access recovery visible when opening Settings and clears it on recovery', async () => {
    const fetchMock = managerFetch({ first: { media: [], nextCursor: null } });
    let releaseFailure: (() => void) | null = null;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/settings') && String(init?.method).toUpperCase() === 'PATCH') {
        await new Promise<void>((resolve) => { releaseFailure = resolve; });
        return errorJson({
          code: 'SESSION_EXPIRED', message: 'This session has expired.', requestId: 'request-a',
        }, 401);
      }
      return fetchMock(input);
    }));
    const user = typist();
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await openSettings(user);

    await user.click(screen.getByLabelText('Review notes before sharing'));
    await waitFor(() => expect(releaseFailure).not.toBeNull());
    await user.click(within(screen.getByRole('navigation', { name: 'Manager sections' }))
      .getByRole('button', { name: /gallery/i }));
    releaseFailure!();

    const autosaveNotice = await screen.findByRole('region', { name: 'Unsaved settings' });
    expect(await screen.findByRole('region', { name: 'Manager notice' }))
      .toHaveTextContent('This session has expired.');
    expect(screen.getByRole('region', { name: 'Recover manager access' })).toBeVisible();

    await user.click(within(autosaveNotice).getByRole('button', { name: 'Open settings' }));

    expect(screen.getByRole('region', { name: 'Manager notice' }))
      .toHaveTextContent('This session has expired.');
    expect(screen.getByRole('region', { name: 'Recover manager access' })).toBeVisible();

    // Returning to the confirmed value resolves the failed domain without a
    // request. Recovery—not section navigation—is what retires the notice.
    await user.click(screen.getByLabelText('Review notes before sharing'));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Manager notice' }))
      .not.toBeInTheDocument());
  });

  it('registers beforeunload only while something is unconfirmed', async () => {
    const fetchMock = managerFetch({ first: { media: [], nextCursor: null } });
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/settings') && String(init?.method).toUpperCase() === 'PATCH') {
        return json({ event: { ...MANAGED_EVENT, moderationRequired: false } });
      }
      return fetchMock(input);
    }));
    const added = vi.spyOn(window, 'addEventListener');
    const removed = vi.spyOn(window, 'removeEventListener');
    const user = typist();
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await openSettings(user);
    expect(added.mock.calls.filter(([type]) => type === 'beforeunload')).toHaveLength(0);

    await user.click(screen.getByLabelText('Review notes before sharing'));
    await waitFor(() => expect(added.mock.calls.filter(([type]) => type === 'beforeunload').length)
      .toBeGreaterThan(0));
    await waitFor(() => expect(removed.mock.calls.filter(([type]) => type === 'beforeunload').length)
      .toBeGreaterThan(0));
  });

  it('does not let an intake read opened before an RSVP write restore an older event', async () => {
    const staleEvent = { ...MANAGED_EVENT, name: 'Stale intake event', rsvpRosterVersion: 7 };
    const freshEvent = { ...MANAGED_EVENT, name: 'Fresh RSVP event', rsvpRosterVersion: 8 };
    const fetchMock = managerFetch({ first: { media: [], nextCursor: null } });
    let eventReads = 0;
    let releaseStaleRead: (() => void) | null = null;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/api/manage/events/event-a') && method === 'GET') {
        eventReads += 1;
        if (eventReads === 1) return json({ event: MANAGED_EVENT });
        if (eventReads === 2) {
          return new Promise<Response>((resolve) => {
            releaseStaleRead = () => resolve(new Response(JSON.stringify({
              data: { event: staleEvent }, requestId: 'request-a',
            }), { headers: { 'content-type': 'application/json' } }));
          });
        }
        return json({ event: freshEvent });
      }
      if (url.endsWith('/rsvp/households') && method === 'POST') {
        return json({ household: { label: 'The Morgan household' }, rosterVersion: 8 }, 201);
      }
      return fetchMock(input);
    }));
    const user = typist();
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await screen.findByRole('heading', { name: 'Live intake' });

    await user.type(screen.getByLabelText('Filter by guest name'), 'Morgan');
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    await waitFor(() => expect(releaseStaleRead).not.toBeNull());

    await user.click(within(screen.getByRole('navigation', { name: 'Manager sections' }))
      .getByRole('button', { name: 'RSVP' }));
    await user.click(await screen.findByRole('button', { name: 'Add household' }));
    await user.type(screen.getByLabelText('Household key'), 'morgan');
    await user.type(screen.getByLabelText('Household label'), 'The Morgan household');
    await user.type(screen.getByLabelText('Named guests'), 'Taylor Morgan');
    await user.click(screen.getByRole('button', { name: 'Create household' }));
    await waitFor(() => expect(eventReads).toBe(3));

    releaseStaleRead!();
    await user.click(within(screen.getByRole('navigation', { name: 'Manager sections' }))
      .getByRole('button', { name: /settings/i }));
    await waitFor(() => expect(screen.getByLabelText('Event name')).toHaveValue('Fresh RSVP event'));
  });

  it('keeps three deferred mutation responses from restoring each other’s stale state', async () => {
    const gardenTheme = resolveEventTheme({ version: 1, presetId: 'garden-party', overrides: {} });
    const releases: Array<() => void> = [];
    const hold = () => new Promise<void>((resolve) => { releases.push(resolve); });
    const fetchMock = managerFetch({ first: { media: [], nextCursor: null } });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/settings') && method === 'PATCH') {
        await hold();
        // Built from a row read before the theme changed.
        return json({ event: { ...MANAGED_EVENT, moderationRequired: false, theme: MANAGED_EVENT.theme } });
      }
      if (url.endsWith('/theme') && method === 'PUT') {
        await hold();
        // Built from a row read before the moderation switch changed.
        return json({ event: { ...MANAGED_EVENT, theme: gardenTheme } });
      }
      return fetchMock(input);
    }));
    const user = typist();
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await openSettings(user);

    await user.click(screen.getByLabelText('Review notes before sharing'));
    await user.click(screen.getByRole('radio', { name: 'Garden Party' }));
    await waitFor(() => expect(releases).toHaveLength(2));

    // Settle the theme first, then the older settings response.
    releases[1]!();
    releases[0]!();

    await waitFor(() => expect(screen.getByLabelText('Review notes before sharing')).not.toBeChecked());
    // The settings response carried the pre-change theme; it must not travel.
    expect(screen.getByTestId('event-appearance-preview')).toHaveStyle({ '--event-primary': '#245c46' });
    // And the theme response carried the pre-change switch; that must not travel either.
    expect(screen.getByLabelText('Review notes before sharing')).not.toBeChecked();
  });

  it('keeps intake paused when a settings response arrives after entry disable', async () => {
    const disabledAt = '2026-08-01T15:00:00.000Z';
    const disabledEvent = { ...MANAGED_EVENT, uploadsEnabled: false, rsvpEnabled: false };
    const fetchMock = managerFetch({ first: { media: [], nextCursor: null } });
    let eventReads = 0;
    let entryReads = 0;
    let releaseSettings: (() => void) | null = null;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/api/manage/events/event-a') && method === 'GET') {
        eventReads += 1;
        return json({ event: eventReads === 1 ? MANAGED_EVENT : disabledEvent });
      }
      if (url.endsWith('/entry') && method === 'GET') {
        entryReads += 1;
        return json(entryReads === 1
          ? { eventLink: 'https://example.test/join#entry-id.entry-secret', disabledAt: null }
          : { eventLink: null, disabledAt });
      }
      if (url.endsWith('/entry/disable') && method === 'POST') return json({ disabledAt });
      if (url.endsWith('/settings') && method === 'PATCH') {
        await new Promise<void>((resolve) => { releaseSettings = resolve; });
        // This row was read before disable committed and still says uploads are open.
        return json({ event: { ...MANAGED_EVENT, moderationRequired: false } });
      }
      return fetchMock(input);
    }));
    const user = typist();
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await openSettings(user);

    await user.click(screen.getByLabelText('Review notes before sharing'));
    await waitFor(() => expect(releaseSettings).not.toBeNull());
    await user.click(within(screen.getByRole('navigation', { name: 'Manager sections' }))
      .getByRole('button', { name: 'Share' }));
    await user.click(screen.getByRole('button', { name: 'Disable printed event QR' }));
    const confirmation = screen.getByRole('group', { name: 'Disable printed event QR' });
    await user.type(within(confirmation).getByLabelText('Confirm event name'), MANAGED_EVENT.name);
    await user.click(within(confirmation).getByRole('button', {
      name: `Disable printed event QR for ${MANAGED_EVENT.name}`,
    }));

    await waitFor(() => expect(screen.getByText('Guest uploads paused')).toBeVisible());
    releaseSettings!();
    await waitFor(() => expect(screen.getByText('Event settings saved')).toBeInTheDocument());

    expect(screen.getByText('Guest uploads paused')).toBeVisible();
    await user.click(within(screen.getByRole('navigation', { name: 'Manager sections' }))
      .getByRole('button', { name: /settings/i }));
    expect(screen.getByLabelText('Accept private photo deliveries')).not.toBeChecked();
  });

  it('keeps a deferred cover response from restoring stale settings or theme', async () => {
    const gardenTheme = resolveEventTheme({ version: 1, presetId: 'garden-party', overrides: {} });
    let releaseCover: (() => void) | null = null;
    const fetchMock = managerFetch({ first: { media: [], nextCursor: null } });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/cover') && method === 'POST') {
        return json({ objectKey: 'events/event-a/cover/new.jpg', url: 'https://r2.test/put' }, 201);
      }
      if (url === 'https://r2.test/put') return Promise.resolve(new Response(null, { status: 200 }));
      if (url.endsWith('/cover/finalize') && method === 'POST') {
        await new Promise<void>((resolve) => { releaseCover = resolve; });
        // Built from a row read before either later write.
        return json({
          event: {
            ...MANAGED_EVENT,
            coverObjectKey: 'events/event-a/cover/new.jpg',
            moderationRequired: true,
            theme: MANAGED_EVENT.theme,
          },
        });
      }
      if (url.endsWith('/settings') && method === 'PATCH') {
        return json({ event: { ...MANAGED_EVENT, moderationRequired: false } });
      }
      if (url.endsWith('/theme') && method === 'PUT') {
        return json({ event: { ...MANAGED_EVENT, theme: gardenTheme } });
      }
      return fetchMock(input);
    }));
    const user = typist();
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await openSettings(user);

    const file = new File([new Uint8Array([1, 2, 3])], 'cover.png', { type: 'image/png' });
    await user.upload(document.querySelector<HTMLInputElement>('.cover-field__input')!, file);
    await waitFor(() => expect(releaseCover).not.toBeNull());

    await user.click(screen.getByLabelText('Review notes before sharing'));
    await user.click(screen.getByRole('radio', { name: 'Garden Party' }));
    await waitFor(() => expect(screen.getByLabelText('Review notes before sharing')).not.toBeChecked());

    releaseCover!();

    // The cover response owns the cover and nothing else.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove cover' })).toBeVisible());
    expect(screen.getByLabelText('Review notes before sharing')).not.toBeChecked();
    expect(screen.getByTestId('event-appearance-preview')).toHaveStyle({ '--event-primary': '#245c46' });
  });
});

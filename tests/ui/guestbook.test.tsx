import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';

import type { GuestEventView, GuestGuestbookItem } from '../../shared/contracts';
import { resolveEventTheme } from '../../shared/event-theme';
import { Guestbook } from '../../src/features/guestbook/Guestbook';
import { EventPage } from '../../src/pages/EventPage';

const EVENT: GuestEventView = {
  id: 'event-a',
  slug: 'maya-theo',
  name: 'Maya & Theo',
  eventDate: '2026-09-19',
  welcomeMessage: 'We would love to see the day through your eyes.',
  guestbookPrompt: 'Tell us what made you smile today.',
  cover: { revision: 0, hasCover: false, available2xProfiles: [], surfaceTreatment: 'none' },
  uploadsEnabled: true,
  galleryVisible: true,
  moderationRequired: true,
  eventTimezone: 'America/Chicago',
  eventStartAt: '2026-09-19T22:00:00.000Z',
  rsvpDeadlineAt: null,
  rsvpDeadlineDate: null,
  phase: 'photos-primary',
  rsvpState: 'disabled',
  rsvpAccess: 'unavailable',
  lifecycleRecheckAfterMs: null,
  theme: resolveEventTheme({ version: 1, presetId: 'candidary-default', overrides: {} }),
};

const PRIVATE_NOTE: GuestGuestbookItem = {
  id: 'private-note', source: 'guest_note', guestName: 'Taylor', body: 'A private memory.',
  createdAt: '2026-09-19T20:00:00.000Z', state: 'pending', visibility: 'author_only',
  isOwn: true, kind: 'message', moderationStatus: 'pending', mediaId: null,
};

const SHARED_CAPTION: GuestGuestbookItem = {
  id: 'shared-caption', source: 'photo_caption', mediaId: 'shared-caption', guestName: 'Avery',
  body: 'Golden hour.', createdAt: '2026-09-19T21:00:00.000Z', state: 'published',
  visibility: 'shared', previewAvailable: true, isOwn: false, kind: 'caption',
  moderationStatus: 'approved',
};

const EVENT_B: GuestEventView = {
  ...EVENT,
  id: 'event-b',
  slug: 'june-ravi',
  name: 'June & Ravi',
  guestbookPrompt: 'Leave June and Ravi a note.',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function success(data: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify({ data, requestId: 'request-a' }), {
    status,
    headers: { 'content-type': 'application/json' },
  }));
}

function renderEvent(event = EVENT) {
  return render(<MemoryRouter initialEntries={[`/event/${event.slug}`]}>
    <Routes><Route path="/event/:slug" element={<EventPage />} /></Routes>
  </MemoryRouter>);
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('guest-facing Guestbook', () => {
  it('lazily discloses the host prompt, signature choice, private entries, and shared book', async () => {
    localStorage.setItem('candidary_guest_name', 'Taylor');
    const requested: string[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      requested.push(path);
      if (path.endsWith('/api/event/maya-theo')) return success({ event: EVENT, role: 'guest' });
      if (path.endsWith('/messages?contract=2')) return success({
        items: [SHARED_CAPTION], nextCursor: 'shared-next', ownUnshared: [PRIVATE_NOTE],
        ownUnsharedCount: 1, ownUnsharedNextCursor: 'private-next',
      });
      throw new Error(`Unexpected request ${path}`);
    }));

    renderEvent();
    expect(await screen.findByRole('button', { name: 'Take a photo' })).toBeVisible();
    expect(requested).not.toContain('/api/event/maya-theo/messages?contract=2');

    await userEvent.setup().click(screen.getByText(/Guestbook/, { selector: 'span' }));

    expect(await screen.findByText('Tell us what made you smile today.')).toHaveAttribute('dir', 'auto');
    expect(screen.getByText((_, node) => node?.tagName === 'SPAN' && node.textContent === 'Signed as Taylor')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Change' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Leave unsigned' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Your private entries' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Shared guestbook' })).toBeVisible();
    expect(screen.getByText('A private memory.')).toHaveAttribute('dir', 'auto');
    expect(screen.getByText('Golden hour.')).toHaveAttribute('dir', 'auto');
    expect(screen.getByText('Your entry')).toBeVisible();
    expect(screen.getByText((_, node) => node?.tagName === 'SMALL' && node.textContent?.includes('Photo caption') === true)).toBeVisible();
    expect(requested).toContain('/api/event/maya-theo/messages?contract=2');
  });

  it('keeps the composer usable when the feed fails and leaves an unsigned draft local', async () => {
    localStorage.setItem('candidary_guest_name', 'Taylor');
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/api/event/maya-theo')) return success({ event: EVENT, role: 'guest' });
      if (path.endsWith('/messages?contract=2')) return Promise.reject(new TypeError('offline'));
      throw new Error(`Unexpected request ${path}`);
    }));
    const user = userEvent.setup();

    renderEvent();
    await user.click(await screen.findByText(/Guestbook/, { selector: 'span' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be loaded/i);
    await user.click(screen.getByRole('button', { name: 'Leave unsigned' }));

    expect(screen.getByText('Unsigned')).toBeVisible();
    expect(localStorage.getItem('candidary_guest_name')).toBe('Taylor');
    expect(screen.getByRole('textbox', { name: 'Your note for Maya & Theo' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Send note' })).toBeEnabled();
  });

  it('renders the book read-only outside photos-primary', async () => {
    const waiting = { ...EVENT, phase: 'waiting' as const, uploadsEnabled: false };
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/api/event/maya-theo')) return success({ event: waiting, role: 'guest' });
      if (path.endsWith('/messages?contract=2')) return success({
        items: [SHARED_CAPTION], nextCursor: null, ownUnshared: [], ownUnsharedCount: 0,
        ownUnsharedNextCursor: null,
      });
      throw new Error(`Unexpected request ${path}`);
    }));

    renderEvent(waiting);
    await userEvent.setup().click(await screen.findByText(/Guestbook/, { selector: 'span' }));

    expect(await screen.findByText('Golden hour.')).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'Your note for Maya & Theo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send note' })).not.toBeInTheDocument();
  });

  it('advances shared and private cursors independently without replacing retained rows', async () => {
    const paths: string[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      paths.push(path);
      if (path.endsWith('/api/event/maya-theo')) return success({ event: EVENT, role: 'guest' });
      if (path.endsWith('/messages?contract=2')) return success({
        items: [SHARED_CAPTION], nextCursor: 'shared-next', ownUnshared: [PRIVATE_NOTE],
        ownUnsharedCount: 2, ownUnsharedNextCursor: 'private-next',
      });
      if (path.endsWith('/messages?contract=2&cursor=shared-next')) return success({
        items: [{ ...SHARED_CAPTION, id: 'older-shared', mediaId: 'older-shared', body: 'Earlier shared.' }],
        nextCursor: null, ownUnshared: [], ownUnsharedCount: 2, ownUnsharedNextCursor: null,
      });
      if (path.endsWith('/messages?contract=2&ownCursor=private-next')) return success({
        items: [], nextCursor: null,
        ownUnshared: [{ ...PRIVATE_NOTE, id: 'older-private', body: 'Earlier private.' }],
        ownUnsharedCount: 2, ownUnsharedNextCursor: null,
      });
      throw new Error(`Unexpected request ${path}`);
    }));
    const user = userEvent.setup();

    renderEvent();
    await user.click(await screen.findByText(/Guestbook/, { selector: 'span' }));
    await user.click(await screen.findByRole('button', { name: 'Show earlier shared entries' }));
    expect(await screen.findByText('Earlier shared.')).toBeVisible();
    expect(screen.getByText('A private memory.')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Show earlier private entries' }));
    expect(await screen.findByText('Earlier private.')).toBeVisible();
    expect(screen.getByText('Golden hour.')).toBeVisible();
    expect(paths).toContain('/api/event/maya-theo/messages?contract=2&cursor=shared-next');
    expect(paths).toContain('/api/event/maya-theo/messages?contract=2&ownCursor=private-next');
  });

  it('derives private-section presence from ownUnsharedCount rather than array membership', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/api/event/maya-theo')) return success({ event: EVENT, role: 'guest' });
      if (path.endsWith('/messages?contract=2')) return success({
        items: [], nextCursor: null, ownUnshared: [PRIVATE_NOTE], ownUnsharedCount: 0,
        ownUnsharedNextCursor: null,
      });
      throw new Error(`Unexpected request ${path}`);
    }));

    renderEvent();
    await userEvent.setup().click(await screen.findByText(/Guestbook/, { selector: 'span' }));
    await screen.findByRole('heading', { name: 'Shared guestbook' });

    expect(screen.queryByRole('heading', { name: 'Your private entries' })).not.toBeInTheDocument();
  });

  it('requires confirmation, preserves an ambiguous draft and key for Retry, then dedupes the replay', async () => {
    localStorage.setItem('candidary_guest_name', 'Taylor');
    const attempts: Array<{ body: string; guestName: string | null; idempotencyKey: string }> = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith('/api/event/maya-theo')) return success({ event: EVENT, role: 'guest' });
      if (path.endsWith('/messages?contract=2')) return success({
        items: [], nextCursor: null, ownUnshared: [], ownUnsharedCount: 0,
        ownUnsharedNextCursor: null,
      });
      if (path.endsWith('/messages') && init?.method === 'POST') {
        attempts.push(JSON.parse(String(init.body)) as typeof attempts[number]);
        if (attempts.length === 1) return Promise.reject(new TypeError('connection dropped'));
        return success({ item: PRIVATE_NOTE, message: PRIVATE_NOTE, replayed: true });
      }
      throw new Error(`Unexpected request ${path}`);
    }));
    const user = userEvent.setup();

    renderEvent();
    await user.click(await screen.findByText(/Guestbook/, { selector: 'span' }));
    const note = await screen.findByRole('textbox', { name: 'Your note for Maya & Theo' });
    await user.type(note, 'A private memory.');
    await user.click(screen.getByRole('button', { name: 'Send note' }));
    expect(attempts).toHaveLength(0);
    expect(screen.getByRole('group', { name: 'Confirm guestbook note' })).toHaveTextContent('Send this note signed as Taylor?');
    await user.click(screen.getByRole('button', { name: 'Confirm and send' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/not sent/i);
    expect(note).toHaveValue('A private memory.');
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Safely sent to Maya & Theo.');
    expect(note).toHaveValue('');
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(screen.getAllByText('A private memory.')).toHaveLength(1);
  });

  it('rotates a failed draft key after body or signature edits and preserves the remembered name when unsigned', async () => {
    localStorage.setItem('candidary_guest_name', 'Taylor');
    const attempts: Array<{ body: string; guestName: string | null; idempotencyKey: string }> = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith('/api/event/maya-theo')) return success({ event: EVENT, role: 'guest' });
      if (path.endsWith('/messages?contract=2')) return success({
        items: [], nextCursor: null, ownUnshared: [], ownUnsharedCount: 0,
        ownUnsharedNextCursor: null,
      });
      if (path.endsWith('/messages') && init?.method === 'POST') {
        attempts.push(JSON.parse(String(init.body)) as typeof attempts[number]);
        return Promise.reject(new TypeError('offline'));
      }
      throw new Error(`Unexpected request ${path}`);
    }));
    const user = userEvent.setup();

    renderEvent();
    await user.click(await screen.findByText(/Guestbook/, { selector: 'span' }));
    const note = await screen.findByRole('textbox', { name: 'Your note for Maya & Theo' });
    await user.type(note, 'First draft');
    await user.click(screen.getByRole('button', { name: 'Send note' }));
    await user.click(screen.getByRole('button', { name: 'Confirm and send' }));
    await screen.findByRole('alert');

    await user.type(note, ' changed');
    await user.click(screen.getByRole('button', { name: 'Leave unsigned' }));
    expect(localStorage.getItem('candidary_guest_name')).toBe('Taylor');
    await user.click(screen.getByRole('button', { name: 'Send note' }));
    expect(screen.getByText('Send this note unsigned?')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Confirm and send' }));
    await waitFor(() => expect(attempts).toHaveLength(2));

    expect(attempts[0]?.idempotencyKey).not.toBe(attempts[1]?.idempotencyKey);
    expect(attempts[1]).toMatchObject({ body: 'First draft changed', guestName: null });
  });

  it('resets every private Guestbook surface at the event identity boundary and ignores a late prior-event page', async () => {
    localStorage.setItem('candidary_guest_name', 'Taylor');
    const lateApage = deferred<Response>();
    const pendingBfeed = deferred<Response>();
    const attempts: Array<{ event: string; body: string; idempotencyKey: string }> = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith('/api/event/maya-theo')) return success({ event: EVENT, role: 'guest' });
      if (path.endsWith('/api/event/june-ravi')) return success({ event: EVENT_B, role: 'guest' });
      if (path.endsWith('/api/event/maya-theo/messages?contract=2')) return success({
        items: [SHARED_CAPTION], nextCursor: 'late-a', ownUnshared: [PRIVATE_NOTE],
        ownUnsharedCount: 1, ownUnsharedNextCursor: null,
      });
      if (path.endsWith('/api/event/maya-theo/messages?contract=2&cursor=late-a')) return lateApage.promise;
      if (path.endsWith('/api/event/june-ravi/messages?contract=2')) return pendingBfeed.promise;
      if (path.endsWith('/messages') && init?.method === 'POST') {
        const payload = JSON.parse(String(init.body)) as { body: string; idempotencyKey: string };
        attempts.push({ event: path, ...payload });
        return Promise.reject(new TypeError('connection dropped'));
      }
      throw new Error(`Unexpected request ${path}`);
    }));
    const user = userEvent.setup();

    render(<MemoryRouter initialEntries={['/event/maya-theo']}>
      <Link to="/event/june-ravi">Open June and Ravi</Link>
      <Routes><Route path="/event/:slug" element={<EventPage />} /></Routes>
    </MemoryRouter>);
    await user.click(await screen.findByText(/Guestbook/, { selector: 'span' }));
    expect(await screen.findByText('A private memory.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Show earlier shared entries' }));
    const noteA = screen.getByRole('textbox', { name: 'Your note for Maya & Theo' });
    await user.type(noteA, 'Only for Maya and Theo');
    await user.click(screen.getByRole('button', { name: 'Send note' }));
    await user.click(screen.getByRole('button', { name: 'Confirm and send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/not sent/i);
    expect(attempts).toHaveLength(1);

    await user.click(screen.getByRole('link', { name: 'Open June and Ravi' }));
    await screen.findByText(/June & Ravi/, { selector: '.photo-drop__event' });
    expect(screen.queryByText('A private memory.')).not.toBeInTheDocument();
    expect(screen.queryByText('Golden hour.')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('Only for Maya and Theo')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Confirm guestbook note' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    const guestbookSummary = screen.getByText(/Guestbook/, { selector: 'span' });
    if (!guestbookSummary.closest('details')?.open) await user.click(guestbookSummary);
    expect(screen.getByRole('heading', { name: 'Leave a note for June & Ravi' })).toBeVisible();

    lateApage.resolve(new Response(JSON.stringify({
      data: {
        items: [{ ...SHARED_CAPTION, id: 'late-a-row', mediaId: 'late-a-row', body: 'Late A row.' }],
        nextCursor: null, ownUnshared: [], ownUnsharedCount: 1, ownUnsharedNextCursor: null,
      },
      requestId: 'late-a-request',
    }), { headers: { 'content-type': 'application/json' } }));
    await Promise.resolve();
    expect(screen.queryByText('Late A row.')).not.toBeInTheDocument();

    const noteB = screen.getByRole('textbox', { name: 'Your note for June & Ravi' });
    await user.type(noteB, 'Only for June and Ravi');
    await user.click(screen.getByRole('button', { name: 'Send note' }));
    await user.click(screen.getByRole('button', { name: 'Confirm and send' }));
    await waitFor(() => expect(attempts).toHaveLength(2));
    expect(attempts[1]?.event).toContain('/api/event/june-ravi/messages');
    expect(attempts[1]?.idempotencyKey).not.toBe(attempts[0]?.idempotencyKey);

    pendingBfeed.resolve(new Response(JSON.stringify({
      data: { items: [], nextCursor: null, ownUnshared: [], ownUnsharedCount: 0, ownUnsharedNextCursor: null },
      requestId: 'request-b',
    }), { headers: { 'content-type': 'application/json' } }));
  });

  it('keys failed intent to the effective prop-driven signature while preserving exact unsigned retries', async () => {
    const attempts: Array<{ body: string; guestName: string | null; idempotencyKey: string }> = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith('/messages?contract=2')) return success({
        items: [], nextCursor: null, ownUnshared: [], ownUnsharedCount: 0,
        ownUnsharedNextCursor: null,
      });
      if (path.endsWith('/messages') && init?.method === 'POST') {
        attempts.push(JSON.parse(String(init.body)) as typeof attempts[number]);
        return Promise.reject(new TypeError('connection dropped'));
      }
      throw new Error(`Unexpected request ${path}`);
    }));
    const user = userEvent.setup();
    const onGuestNameChange = vi.fn();
    const view = render(<Guestbook
      event={EVENT}
      contributionEnabled
      guestName="Taylor"
      onGuestNameChange={onGuestNameChange}
      openRequest={0}
    />);
    await user.click(screen.getByText(/Guestbook/, { selector: 'span' }));
    const note = screen.getByRole('textbox', { name: 'Your note for Maya & Theo' });
    await user.type(note, 'Keep the intent exact');
    await user.click(screen.getByRole('button', { name: 'Send note' }));
    await user.click(screen.getByRole('button', { name: 'Confirm and send' }));
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(attempts).toHaveLength(2));
    expect(attempts[1]).toEqual(attempts[0]);

    view.rerender(<Guestbook
      event={EVENT}
      contributionEnabled
      guestName="Morgan"
      onGuestNameChange={onGuestNameChange}
      openRequest={0}
    />);
    await user.click(screen.getByRole('button', { name: 'Send note' }));
    expect(screen.getByRole('group', { name: 'Confirm guestbook note' })).toHaveTextContent('signed as Morgan');
    await user.click(screen.getByRole('button', { name: 'Confirm and send' }));
    await waitFor(() => expect(attempts).toHaveLength(3));
    expect(attempts[2]?.guestName).toBe('Morgan');
    expect(attempts[2]?.idempotencyKey).not.toBe(attempts[1]?.idempotencyKey);

    await user.click(screen.getByRole('button', { name: 'Leave unsigned' }));
    await user.click(screen.getByRole('button', { name: 'Send note' }));
    await user.click(screen.getByRole('button', { name: 'Confirm and send' }));
    await waitFor(() => expect(attempts).toHaveLength(4));
    expect(attempts[3]?.guestName).toBeNull();
    view.rerender(<Guestbook
      event={EVENT}
      contributionEnabled
      guestName="Jordan"
      onGuestNameChange={onGuestNameChange}
      openRequest={0}
    />);
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(attempts).toHaveLength(5));
    expect(attempts[4]).toEqual(attempts[3]);
  });

  it('moves a newly shared private row into the shared book while retaining Your entry', async () => {
    let reads = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/api/event/maya-theo')) return success({ event: EVENT, role: 'guest' });
      if (path.endsWith('/messages?contract=2')) {
        reads += 1;
        return reads === 1
          ? success({ items: [], nextCursor: null, ownUnshared: [PRIVATE_NOTE], ownUnsharedCount: 1, ownUnsharedNextCursor: null })
          : success({ items: [{ ...PRIVATE_NOTE, state: 'approved', visibility: 'shared', moderationStatus: 'approved' }], nextCursor: null, ownUnshared: [], ownUnsharedCount: 0, ownUnsharedNextCursor: null });
      }
      throw new Error(`Unexpected request ${path}`);
    }));
    const user = userEvent.setup();

    renderEvent();
    const summary = await screen.findByText(/Guestbook/, { selector: 'span' });
    await user.click(summary);
    expect(await screen.findByRole('heading', { name: 'Your private entries' })).toBeVisible();
    await user.click(summary);
    await user.click(summary);

    expect(await screen.findByRole('heading', { name: 'Shared guestbook' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Your private entries' })).not.toBeInTheDocument();
    expect(screen.getByText('Your entry')).toBeVisible();
    expect(reads).toBe(2);
  });

  it('propagates a changed Guestbook signature immediately back to photo delivery', async () => {
    localStorage.setItem('candidary_guest_name', 'Taylor');
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/api/event/maya-theo')) return success({ event: EVENT, role: 'guest' });
      if (path.endsWith('/messages?contract=2')) return success({
        items: [], nextCursor: null, ownUnshared: [], ownUnsharedCount: 0,
        ownUnsharedNextCursor: null,
      });
      throw new Error(`Unexpected request ${path}`);
    }));
    const user = userEvent.setup();

    renderEvent();
    expect(await screen.findByText('Sending as Taylor')).toBeVisible();
    await user.click(screen.getByText(/Guestbook/, { selector: 'span' }));
    await user.click(screen.getByRole('button', { name: 'Change' }));
    const signature = screen.getByRole('textbox', { name: 'Name for this and future contributions' });
    await user.clear(signature);
    await user.type(signature, 'Morgan');

    expect(localStorage.getItem('candidary_guest_name')).toBe('Morgan');
    expect(screen.getByText('Sending as Morgan')).toBeVisible();
  });
});

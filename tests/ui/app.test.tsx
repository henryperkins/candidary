import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as ManagementLinkModule from '../../src/app/management-link';

const { replaceManagementLocation } = vi.hoisted(() => ({
  replaceManagementLocation: vi.fn(),
}));
const { qrToDataURL } = vi.hoisted(() => ({
  qrToDataURL: vi.fn(),
}));

vi.mock('../../src/app/management-link', async (importOriginal) => ({
  ...await importOriginal<typeof ManagementLinkModule>(),
  replaceManagementLocation,
}));
vi.mock('qrcode', () => ({ default: { toDataURL: qrToDataURL } }));

import { MANAGER_BULK_SELECTION_MAX, MANAGER_MEDIA_PAGE_SIZE } from '../../shared/constants';
import { resolveEventTheme } from '../../shared/event-theme';
import { mediaPreview } from '../../src/app/api';
import { hostSignInHref } from '../../src/app/recovery';
import { createAppRouter } from '../../src/app/router';
import { EventAccountCard } from '../../src/components/EventAccountCard';
import { ManagementLinkRecovery } from '../../src/components/ManagementLinkRecovery';
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
const RECOVERY_EVENT_ID = '11111111-2222-4333-8444-555555555555';
const QR_DATA_URL = 'data:image/png;base64,candidary-test';

qrToDataURL.mockResolvedValue(QR_DATA_URL);

async function createEvent(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Event name'), 'Maya & Theo');
  await user.type(screen.getByLabelText('Event date'), '2026-09-19');
  await user.type(screen.getByLabelText('Welcome message'), 'Come share the moments you caught.');
  await user.click(screen.getByRole('button', { name: 'Create private event' }));
  await screen.findByRole('heading', { name: 'Your event is ready.' });
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  qrToDataURL.mockReset();
  qrToDataURL.mockResolvedValue(QR_DATA_URL);
});

describe('management link recovery', () => {
  it('marks an invalid management link and returns focus to it', async () => {
    render(<ManagementLinkRecovery />);
    const user = userEvent.setup();

    expect(screen.getByLabelText('Management link')).toHaveAttribute('autocomplete', 'off');
    expect(screen.getByLabelText('Management link')).toHaveAttribute('spellcheck', 'false');
    expect(screen.getByRole('button', { name: 'Open event manager' })).toBeVisible();

    await user.type(screen.getByLabelText('Management link'), '/manage/event');
    await user.click(screen.getByRole('button', { name: 'Open event manager' }));

    expect(screen.getByLabelText('Management link')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Enter a Candidary management link from this site.')).toBeVisible();
    expect(screen.getByLabelText('Management link')).toHaveFocus();
  });

  it('replaces location with only the parsed pathname from a valid management link', async () => {
    const token = 'Abc_123.Xyz-789';
    replaceManagementLocation.mockClear();
    render(<ManagementLinkRecovery />);
    const user = userEvent.setup();

    await user.type(
      screen.getByLabelText('Management link'),
      `${window.location.origin}/manage/${token}?from=mail#saved`,
    );
    await user.click(screen.getByRole('button', { name: 'Open event manager' }));

    expect(replaceManagementLocation).toHaveBeenCalledOnce();
    expect(replaceManagementLocation).toHaveBeenCalledWith(`/manage/${token}`);
  });
});

describe('recover event manager page', () => {
  it.each(['latest-link', 'sign-in', 'retry'] as const)(
    'offers account and management-link recovery for %s',
    (kind) => {
      render(<RouterProvider router={createAppRouter([`/recover/manage?kind=${kind}`])} />);

      expect(screen.getByRole('heading', { level: 1, name: 'Recover event manager' })).toBeVisible();
      expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/host/login');
      expect(screen.getByLabelText('Management link')).toBeVisible();
      expect(screen.queryByRole('link', { name: 'Create account' })).not.toBeInTheDocument();
    },
  );

  it.each(['/recover/manage', '/recover/manage?kind=unknown'])(
    'falls back to recoverable latest-link guidance for %s',
    (entry) => {
      render(<RouterProvider router={createAppRouter([entry])} />);

      expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/host/login');
      expect(screen.getByLabelText('Management link')).toBeVisible();
    },
  );

  it('shows terminal guidance without recovery actions for ended events', () => {
    render(<RouterProvider router={createAppRouter(['/recover/manage?kind=ended-event'])} />);

    expect(screen.getByRole('heading', { level: 1, name: 'This event can no longer be managed' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Sign in' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Management link')).not.toBeInTheDocument();
  });
});

describe('public Candidary experience', () => {
  it('presents the approved value proposition and workflow', () => {
    render(<RouterProvider router={createAppRouter(['/'])} />);
    expect(screen.getByRole('heading', { name: 'Gather the moments you didn’t see.' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Create your event' })).toHaveAttribute('href', '/create');
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('creates an event and clearly returns both access links', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => json(CREATED, 201));
    vi.stubGlobal('fetch', fetchMock);
    render(<RouterProvider router={createAppRouter(['/create'])} />);
    await createEvent(userEvent.setup());
    expect(screen.getByRole('heading', { name: 'Your event is ready.' })).toBeVisible();
    expect(screen.getByText('Guest link')).toBeVisible();
    expect(screen.getByText('Management link')).toBeVisible();
    expect(screen.getByRole('link', { name: /open event manager/i }))
      .toHaveAttribute('href', `/manage/event/${CREATED.event.id}`);
    expect(screen.getByText(CREATED.managementLink)).toBeInTheDocument();
    expect(screen.getByText(/cannot be recovered/i)).toBeVisible();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, request] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(request?.body))).toMatchObject({
      theme: { version: 1, presetId: 'candidary-default', overrides: {} },
    });
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

  it('names the note field after the event rather than leaving it to a placeholder', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/event/maya-theo')) return json({ event: {
        id: 'event-a', slug: 'maya-theo', name: 'Maya & Theo', eventDate: '2026-09-19',
        welcomeMessage: 'We would love to see the day through your eyes.', uploadsEnabled: true,
        galleryVisible: false, moderationRequired: true,
      }, role: 'guest' });
      if (url.endsWith('/messages')) return json({ items: [] });
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<RouterProvider router={createAppRouter(['/event/maya-theo'])} />);
    expect(await screen.findByRole('heading', { name: 'We would love to see the day through your eyes.' })).toBeVisible();

    await userEvent.setup().click(screen.getByText(/Leave a note/, { selector: 'span' }));
    // A placeholder is not a name: it disappears on the first keystroke and is not announced as one.
    const note = await screen.findByRole('textbox', { name: 'Note for Maya & Theo' });
    expect(note).toBeVisible();
    // Exactly the field's own name — no placeholder, no submit label, nothing else swept in with it.
    expect(note).toHaveAccessibleName('Note for Maya & Theo');
    expect(note).toHaveAttribute('name', 'body');
  });
});

const MANAGED_EVENT = {
  id: 'event-a', slug: 'maya-theo', name: 'Maya & Theo', eventDate: '2026-09-19',
  welcomeMessage: 'Welcome.', coverObjectKey: null,
  uploadsEnabled: true, galleryVisible: true, moderationRequired: true,
  storedMediaCount: 3, storedBytes: 128,
  guestAccessExpiresAt: '2026-10-19T00:00:00Z', purgeAfter: '2026-12-19T00:00:00Z',
  theme: resolveEventTheme({ version: 1, presetId: 'candidary-default', overrides: {} }),
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
  it.each([
    ['SESSION_EXPIRED', 'This session has expired.', true, true],
    ['HOST_SESSION_REQUIRED', 'Your sign-in has expired.', true, true],
    ['ACCOUNT_DISABLED', 'This account is no longer active.', false, true],
    ['EVENT_EXPIRED', 'This event access has expired.', false, false],
    ['INTERNAL_ERROR', 'The event manager could not be loaded.', false, false],
  ] as const)(
    'renders the correct full-page manager recovery for %s',
    async (code, message, offerSignIn, offerManagementLink) => {
      vi.stubGlobal('fetch', vi.fn(() => errorJson({ code, message, requestId: 'request-a' }, 401)));
      render(<RouterProvider router={createAppRouter([`/manage/event/${RECOVERY_EVENT_ID}`])} />);

      expect(await screen.findByText(message)).toBeVisible();
      if (offerSignIn) {
        expect(screen.getByRole('link', { name: 'Sign in' }))
          .toHaveAttribute('href', hostSignInHref(RECOVERY_EVENT_ID));
      } else {
        expect(screen.queryByRole('link', { name: 'Sign in' })).not.toBeInTheDocument();
      }
      if (offerManagementLink) {
        expect(screen.getByLabelText('Management link')).toBeVisible();
      } else {
        expect(screen.queryByLabelText('Management link')).not.toBeInTheDocument();
      }
      expect(screen.queryByRole('link', { name: 'Create account' })).not.toBeInTheDocument();
    },
  );

  it('keeps appearance inside Settings between its form and account controls', async () => {
    vi.stubGlobal('fetch', managerFetch({ first: { media: [], nextCursor: null } }));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await screen.findByRole('heading', { name: 'Live intake' });

    const navigation = screen.getByRole('navigation', { name: 'Manager sections' });
    expect(within(navigation).getAllByRole('button')).toHaveLength(5);
    await userEvent.setup().click(within(navigation).getByRole('button', { name: /settings/i }));

    const settingsForm = screen.getByRole('button', { name: 'Save settings' }).closest('form');
    const editor = screen.getByRole('region', { name: 'Event appearance editor' });
    const account = document.querySelector('.account-card');
    const danger = document.querySelector('.danger-zone');
    expect(settingsForm?.contains(editor)).toBe(false);
    expect(settingsForm!.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(editor.compareDocumentPosition(account!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(editor.compareDocumentPosition(danger!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

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

  it('keeps an exhausted continuation cursor exhausted after an answered poll', async () => {
    const rows = makeMedia(7).slice(1);
    const mediaRequests: string[] = [];
    const interval = vi.spyOn(window, 'setInterval');
    vi.stubGlobal('fetch', managerFetch({
      first: { media: rows.slice(0, 2), nextCursor: 'page-two' },
      'page-two': { media: rows.slice(2, 4), nextCursor: 'page-three' },
      'page-three': { media: rows.slice(4), nextCursor: null },
    }, mediaRequests));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    expect(await screen.findByRole('heading', { name: 'Live intake' })).toBeVisible();

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Load more photos' }));
    await waitFor(() => expect(document.querySelectorAll('.moderation-grid img')).toHaveLength(4));
    await user.click(screen.getByRole('button', { name: 'Load more photos' }));
    await waitFor(() => expect(document.querySelectorAll('.moderation-grid img')).toHaveLength(6));
    expect(screen.queryByRole('button', { name: 'Load more photos' })).not.toBeInTheDocument();

    const poll = interval.mock.calls.filter(([, delay]) => delay === 5_000).at(-1)?.[0];
    expect(poll).toBeTypeOf('function');
    await act(async () => { (poll as () => void)(); });
    await waitFor(() => expect(mediaRequests.filter((request) => !request.includes('cursor'))).toHaveLength(2));

    expect(document.querySelectorAll('.moderation-grid img')).toHaveLength(6);
    expect(screen.queryByRole('button', { name: 'Load more photos' })).not.toBeInTheDocument();
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

  it('scopes load-more ownership to the query that started the request', async () => {
    const rows = makeMedia(9).slice(1);
    let oldSignal: AbortSignal | undefined;
    let releaseOldPage!: () => void;
    const mediaRequests: string[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/manage/events/event-a')) return json({ event: MANAGED_EVENT });
      if (url.includes('/media')) {
        mediaRequests.push(url);
        if (url.includes('cursor=old-page-two')) {
          oldSignal = init?.signal ?? undefined;
          return new Promise<Response>((resolve) => {
            // Deliberately resolve even after abort. Ownership, not a cooperative fake, must keep this
            // stale answer from changing rows, cursor, loading state, or error state.
            releaseOldPage = () => {
              void json({
                media: rows.slice(2, 4),
                nextCursor: 'stale-page-three',
              }).then(resolve);
            };
          });
        }
        if (url.includes('guestName=Avery') && url.includes('cursor=filtered-page-two')) {
          return json({ media: rows.slice(6, 7), nextCursor: null });
        }
        if (url.includes('guestName=Avery')) {
          return json({ media: rows.slice(4, 6), nextCursor: 'filtered-page-two' });
        }
        return json({ media: rows.slice(0, 2), nextCursor: 'old-page-two' });
      }
      if (url.includes('/messages')) return json({ messages: [] });
      if (url.endsWith('/exports')) return json({ exports: [] });
      if (url.endsWith('/links')) return json({ guestLink: 'https://example.test/join/guest' });
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    expect(await screen.findByRole('heading', { name: 'Live intake' })).toBeVisible();

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Load more photos' }));
    await waitFor(() => expect(oldSignal).toBeDefined());

    await user.type(screen.getByLabelText('Filter by guest name'), 'Avery');
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    expect(await screen.findByAltText('Moment 6')).toBeVisible();
    const filteredMore = await screen.findByRole('button', { name: 'Load more photos' });
    expect(oldSignal?.aborted, 'the superseded request receives an abort').toBe(true);
    expect(filteredMore, 'the old request no longer owns the loading state').toBeEnabled();

    await user.click(filteredMore);
    expect(await screen.findByAltText('Moment 8')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Load more photos' })).not.toBeInTheDocument();
    const filteredSources = previewSources();

    await act(async () => { releaseOldPage(); });
    expect(previewSources()).toEqual(filteredSources);
    expect(screen.queryByAltText('Moment 4')).not.toBeInTheDocument();
    expect(screen.queryByAltText('Moment 5')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more photos' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(mediaRequests.at(-1)).toContain('cursor=filtered-page-two');
  });

  it('aborts the active load-more request when the manager unmounts', async () => {
    const rows = makeMedia(3).slice(1);
    let pageSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/manage/events/event-a')) return json({ event: MANAGED_EVENT });
      if (url.includes('/media')) {
        if (url.includes('cursor=page-two')) {
          pageSignal = init?.signal ?? undefined;
          return new Promise<Response>(() => undefined);
        }
        return json({ media: rows.slice(0, 1), nextCursor: 'page-two' });
      }
      if (url.includes('/messages')) return json({ messages: [] });
      if (url.endsWith('/exports')) return json({ exports: [] });
      if (url.endsWith('/links')) return json({ guestLink: 'https://example.test/join/guest' });
      throw new Error(`Unexpected request ${url}`);
    }));
    const view = render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    expect(await screen.findByRole('heading', { name: 'Live intake' })).toBeVisible();

    await userEvent.setup().click(await screen.findByRole('button', { name: 'Load more photos' }));
    await waitFor(() => expect(pageSignal).toBeDefined());
    view.unmount();

    expect(pageSignal?.aborted).toBe(true);
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
        return errorJson({ code: 'MEDIA_STATE_CONFLICT', message: 'That photo changed before your update.', requestId: 'request-a' }, 409);
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

  it('caps cross-page bulk selection at 50 and submits only the selected ids', async () => {
    const rows = makeMedia(MANAGER_BULK_SELECTION_MAX + 1, 'unpublished');
    const bulkBodies: Array<{ ids: string[] }> = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'POST' && url.endsWith('/media/bulk')) {
        const body = JSON.parse(String(init?.body)) as { ids: string[] };
        bulkBodies.push(body);
        return json({ changed: body.ids });
      }
      if (url.endsWith('/api/manage/events/event-a')) return json({ event: MANAGED_EVENT });
      if (url.includes('/media')) {
        const cursor = new URL(url, 'https://candidary.test').searchParams.get('cursor');
        return cursor === 'page-two'
          ? json({ media: rows.slice(MANAGER_BULK_SELECTION_MAX), nextCursor: null })
          : json({ media: rows.slice(0, MANAGER_BULK_SELECTION_MAX), nextCursor: 'page-two' });
      }
      if (url.includes('/messages')) return json({ messages: [] });
      if (url.endsWith('/exports')) return json({ exports: [] });
      if (url.endsWith('/links')) return json({ guestLink: 'https://example.test/join/guest' });
      throw new Error(`Unexpected request ${method} ${url}`);
    }));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    expect(await screen.findByRole('heading', { name: 'Live intake' })).toBeVisible();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Gallery' }));
    expect(await screen.findByRole('heading', { name: 'Gallery publishing' })).toBeVisible();
    await user.click(await screen.findByRole('button', { name: 'Load more photos' }));
    const choices = await screen.findAllByRole('checkbox', { name: /^Select /u });
    expect(choices).toHaveLength(MANAGER_BULK_SELECTION_MAX + 1);

    for (const choice of choices.slice(0, MANAGER_BULK_SELECTION_MAX)) fireEvent.click(choice);
    const extra = choices[MANAGER_BULK_SELECTION_MAX]!;
    expect(screen.getByRole('status')).toHaveTextContent(
      `${MANAGER_BULK_SELECTION_MAX} of ${MANAGER_BULK_SELECTION_MAX} photos selected. Remove one to choose another.`,
    );
    expect(extra).toBeDisabled();
    await user.click(extra);
    expect(extra).not.toBeChecked();
    expect(screen.getByRole('status')).toHaveTextContent('50 of 50 photos selected');

    await user.click(choices[0]!);
    expect(extra, 'unchecking remains available as the recovery').toBeEnabled();
    await user.click(choices[0]!);
    expect(extra).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Publish selected' }));
    await waitFor(() => expect(bulkBodies).toHaveLength(1));
    expect(bulkBodies[0]!.ids).toEqual(rows.slice(0, MANAGER_BULK_SELECTION_MAX).map(({ id }) => id));
    expect(bulkBodies[0]!.ids).not.toContain(rows[MANAGER_BULK_SELECTION_MAX]!.id);
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

  it('keeps the last usable intake on screen when a poll fails', async () => {
    let mediaRequests = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/manage/events/event-a')) return json({ event: MANAGED_EVENT });
      if (url.includes('/media')) {
        mediaRequests += 1;
        return mediaRequests > 1
          ? errorJson({ code: 'INTERNAL_ERROR', message: 'The event manager could not be loaded.', requestId: 'request-a' }, 500)
          : json({ media: makeMedia(2).slice(1), nextCursor: null });
      }
      if (url.includes('/messages')) return json({ messages: [] });
      if (url.endsWith('/exports')) return json({ exports: [] });
      if (url.endsWith('/links')) return json({ guestLink: 'https://example.test/join/guest' });
      throw new Error(`Unexpected request ${url}`);
    }));
    const interval = vi.spyOn(window, 'setInterval');
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    expect(await screen.findByRole('heading', { name: 'Live intake' })).toBeVisible();
    expect(await screen.findByAltText('Moment 2')).toBeVisible();

    const poll = interval.mock.calls.filter(([, delay]) => delay === 5_000).at(-1)?.[0];
    expect(poll).toBeTypeOf('function');
    await act(async () => { (poll as () => void)(); });

    // Reception drops for one interval at the venue. The host keeps the intake already on screen
    // rather than being thrown back to a whole-page dead end they never asked to leave for.
    expect(screen.getByAltText('Moment 2')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Live intake' })).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('keeps the last usable intake and offers both recovery routes when polling loses credentials', async () => {
    let mediaRequests = 0;
    const event = { ...MANAGED_EVENT, id: RECOVERY_EVENT_ID };
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(`/api/manage/events/${RECOVERY_EVENT_ID}`)) return json({ event });
      if (url.includes('/media')) {
        mediaRequests += 1;
        return mediaRequests > 1
          ? errorJson({ code: 'SESSION_EXPIRED', message: 'This session has expired.', requestId: 'request-a' }, 401)
          : json({ media: makeMedia(2).slice(1), nextCursor: null });
      }
      if (url.includes('/messages')) return json({ messages: [] });
      if (url.endsWith('/exports')) return json({ exports: [] });
      if (url.endsWith('/links')) return json({ guestLink: 'https://example.test/join/guest' });
      throw new Error(`Unexpected request ${url}`);
    }));
    const interval = vi.spyOn(window, 'setInterval');
    render(<RouterProvider router={createAppRouter([`/manage/event/${RECOVERY_EVENT_ID}`])} />);
    expect(await screen.findByRole('heading', { name: 'Live intake' })).toBeVisible();
    expect(await screen.findByAltText('Moment 2')).toBeVisible();

    const poll = interval.mock.calls.filter(([, delay]) => delay === 5_000).at(-1)?.[0];
    expect(poll).toBeTypeOf('function');
    await act(async () => { (poll as () => void)(); });

    const notice = await screen.findByRole('alert');
    expect(notice).toHaveTextContent('This session has expired.');
    expect(screen.getByRole('heading', { name: 'Live intake' })).toBeVisible();
    expect(screen.getByAltText('Moment 2')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Sign in' }))
      .toHaveAttribute('href', hostSignInHref(RECOVERY_EVENT_ID));
    expect(screen.getByLabelText('Management link')).toBeVisible();
  });

  it('names the way out when a load fails after the manager has already rendered', async () => {
    let mediaRequests = 0;
    const event = { ...MANAGED_EVENT, id: RECOVERY_EVENT_ID };
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(`/api/manage/events/${RECOVERY_EVENT_ID}`)) return json({ event });
      if (url.includes('/media')) {
        mediaRequests += 1;
        // A manager session lasts twelve hours. The one that expires overnight expires against a page
        // that has been rendered for hours, so the failure lands on the `loadedOnce` path.
        return mediaRequests > 1
          ? errorJson({ code: 'SESSION_EXPIRED', message: 'This session has expired.', requestId: 'request-a' }, 401)
          : json({ media: makeMedia(2).slice(1), nextCursor: null });
      }
      if (url.includes('/messages')) return json({ messages: [] });
      if (url.endsWith('/exports')) return json({ exports: [] });
      if (url.endsWith('/links')) return json({ guestLink: 'https://example.test/join/guest' });
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<RouterProvider router={createAppRouter([`/manage/event/${RECOVERY_EVENT_ID}`])} />);
    expect(await screen.findByRole('heading', { name: 'Live intake' })).toBeVisible();
    expect(await screen.findByAltText('Moment 2')).toBeVisible();

    // Any host action that reloads the manager will do; filtering is the one that needs no write.
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Filter by guest name'), 'Avery');
    await user.click(screen.getByRole('button', { name: 'Filter' }));

    // Pressing a button cannot mint a session, so the notice has to name the management link. A bare
    // "This session has expired." leaves the host with no stated way back into their own event.
    const notice = await screen.findByRole('alert');
    expect(notice).toHaveTextContent('This session has expired.');
    expect(notice).toHaveTextContent('Open the latest management link you saved to start again.');
    // Still the inline, dismissible notice: the manager the host was working in survives.
    expect(screen.getByRole('heading', { name: 'Live intake' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Sign in' }))
      .toHaveAttribute('href', hostSignInHref(RECOVERY_EVENT_ID));
    expect(screen.getByLabelText('Management link')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Create account' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Dismiss error' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('surfaces a rejected write without inventing a recovery instruction for it', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? 'GET').toUpperCase() !== 'GET') {
        return errorJson({ code: 'RESOURCE_FORBIDDEN', message: 'This photo belongs to a different event.', requestId: 'request-a' }, 403);
      }
      if (url.endsWith('/api/manage/events/event-a')) return json({ event: MANAGED_EVENT });
      if (url.includes('/media')) return json({ media: makeMedia(2).slice(1), nextCursor: null });
      if (url.includes('/messages')) return json({ messages: [] });
      if (url.endsWith('/exports')) return json({ exports: [] });
      if (url.endsWith('/links')) return json({ guestLink: 'https://example.test/join/guest' });
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    expect(await screen.findByRole('heading', { name: 'Live intake' })).toBeVisible();
    expect(await screen.findByAltText('Moment 2')).toBeVisible();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Delete moment-2.jpg' }));

    // A refused write is retryable by definition — the control is still under the host's thumb — so
    // the notice carries the failure and nothing else. The recovery line belongs to load failures.
    const notice = await screen.findByRole('alert');
    expect(notice).toHaveTextContent('This photo belongs to a different event.');
    expect(notice.querySelector('.manager-action-error__recovery')).toBeNull();
    expect(screen.queryByLabelText('Management link')).not.toBeInTheDocument();
  });

  it('does not mistake an unavailable guest link for lost manager access', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    let guestLinkUnavailable = true;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (
        (init?.method ?? 'GET').toUpperCase() === 'POST'
        && url.endsWith('/links/guest/rotate')
      ) {
        guestLinkUnavailable = false;
        return json({ guestLink: 'https://example.test/join/replacement' });
      }
      if (url.endsWith('/api/manage/events/event-a')) return json({ event: MANAGED_EVENT });
      if (url.includes('/media')) return json({ media: makeMedia(2).slice(1), nextCursor: null });
      if (url.includes('/messages')) return json({ messages: [] });
      if (url.endsWith('/exports')) return json({ exports: [] });
      if (url.endsWith('/links')) {
        return guestLinkUnavailable
          ? errorJson({
            code: 'GUEST_LINK_UNAVAILABLE',
            message: 'The guest link is unavailable. Rotate it to create a replacement.',
            requestId: 'request-a',
          }, 410)
          : json({ guestLink: 'https://example.test/join/replacement' });
      }
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);

    expect(await screen.findByRole('heading', { name: 'Live intake' })).toBeVisible();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The guest link is unavailable. Rotate it to create a replacement.',
    );
    expect(screen.queryByRole('link', { name: 'Sign in' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Management link')).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Share' }));
    expect(screen.queryByRole('button', { name: 'Show full guest link' })).not.toBeInTheDocument();
    for (const copy of screen.getAllByRole('button', { name: 'Copy guest link' })) {
      expect(copy).toBeDisabled();
    }
    expect(screen.queryByAltText('Guest event QR code')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Rotate guest link' }));

    expect(await screen.findByText('https://example.test/join/replacement')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Show full guest link' })).toBeEnabled();
    for (const copy of screen.getAllByRole('button', { name: 'Copy guest link' })) {
      expect(copy).toBeEnabled();
    }
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('retires rendered and in-flight guest QR codes when the link becomes unavailable', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    let linkUnavailable = false;
    let resolveSecondQr!: (value: string) => void;
    qrToDataURL
      .mockResolvedValueOnce('data:image/png;base64,first-link')
      .mockImplementationOnce(() => new Promise<string>((resolve) => {
        resolveSecondQr = resolve;
      }));
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (
        (init?.method ?? 'GET').toUpperCase() === 'POST'
        && url.endsWith('/links/guest/rotate')
      ) {
        linkUnavailable = true;
        return json({ guestLink: 'https://example.test/join/second-link' });
      }
      if (url.endsWith('/api/manage/events/event-a')) return json({ event: MANAGED_EVENT });
      if (url.includes('/media')) return json({ media: makeMedia(2).slice(1), nextCursor: null });
      if (url.includes('/messages')) return json({ messages: [] });
      if (url.endsWith('/exports')) return json({ exports: [] });
      if (url.endsWith('/links')) {
        return linkUnavailable
          ? errorJson({
            code: 'GUEST_LINK_UNAVAILABLE',
            message: 'The guest link is unavailable. Rotate it to create a replacement.',
            requestId: 'request-a',
          }, 410)
          : json({ guestLink: 'https://example.test/join/first-link' });
      }
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);

    expect(await screen.findByRole('heading', { name: 'Live intake' })).toBeVisible();
    expect(await screen.findAllByAltText('Guest event QR code')).not.toHaveLength(0);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Share' }));
    await user.click(screen.getByRole('button', { name: 'Rotate guest link' }));
    await waitFor(() => expect(qrToDataURL).toHaveBeenCalledTimes(2));

    await user.click(screen.getByRole('button', { name: /^Intake/u }));
    await user.type(screen.getByLabelText('Filter by guest name'), 'Avery');
    await user.click(screen.getByRole('button', { name: 'Filter' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The guest link is unavailable. Rotate it to create a replacement.',
    );
    expect(screen.queryByAltText('Guest event QR code')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show full guest link' })).not.toBeInTheDocument();
    for (const copy of screen.getAllByRole('button', { name: 'Copy guest link' })) {
      expect(copy).toBeDisabled();
    }

    await act(async () => {
      resolveSecondQr('data:image/png;base64,stale-second-link');
      await Promise.resolve();
    });
    expect(screen.queryByAltText('Guest event QR code')).not.toBeInTheDocument();
  });

  it('keeps the readable guest link usable when QR generation rejects', async () => {
    qrToDataURL.mockRejectedValueOnce(new Error('QR generation failed'));
    vi.stubGlobal('fetch', managerFetch({
      first: { media: makeMedia(2).slice(1), nextCursor: null },
    }));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);

    expect(await screen.findByRole('heading', { name: 'Live intake' })).toBeVisible();
    await waitFor(() => expect(qrToDataURL).toHaveBeenCalledTimes(1));
    expect(screen.queryByAltText('Guest event QR code')).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Share' }));
    expect(screen.getByText('https://example.test/join/guest')).toBeVisible();
    for (const copy of screen.getAllByRole('button', { name: 'Copy guest link' })) {
      expect(copy).toBeEnabled();
    }
  });

  it('keeps creator-session recovery out of a refused manager-link rotation', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (
        (init?.method ?? 'GET').toUpperCase() === 'POST'
        && url.endsWith('/links/manager/rotate')
      ) {
        return errorJson({
          code: 'OWNER_CLAIM_REQUIRED',
          message: 'Save this event from its original creator session before rotating its management link.',
          requestId: 'request-a',
        }, 409);
      }
      if (url.endsWith('/api/manage/events/event-a')) return json({ event: MANAGED_EVENT });
      if (url.includes('/media')) return json({ media: makeMedia(2).slice(1), nextCursor: null });
      if (url.includes('/messages')) return json({ messages: [] });
      if (url.endsWith('/exports')) return json({ exports: [] });
      if (url.endsWith('/links')) return json({ guestLink: 'https://example.test/join/guest' });
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    expect(await screen.findByRole('heading', { name: 'Live intake' })).toBeVisible();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Share' }));
    await user.click(screen.getByRole('button', { name: 'Rotate manager link' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Save this event from its original creator session before rotating its management link.',
    );
    expect(screen.getByRole('heading', { name: 'Share the photo drop' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Sign in' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Management link')).not.toBeInTheDocument();
  });

  it('preserves loaded media and offers access recovery when pagination loses the manager credential', async () => {
    const event = { ...MANAGED_EVENT, id: RECOVERY_EVENT_ID };
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(`/api/manage/events/${RECOVERY_EVENT_ID}`)) return json({ event });
      if (url.includes('/media')) {
        return url.includes('cursor=page-two')
          ? errorJson({ code: 'SESSION_EXPIRED', message: 'This session has expired.', requestId: 'request-a' }, 401)
          : json({ media: makeMedia(2).slice(1), nextCursor: 'page-two' });
      }
      if (url.includes('/messages')) return json({ messages: [] });
      if (url.endsWith('/exports')) return json({ exports: [] });
      if (url.endsWith('/links')) return json({ guestLink: 'https://example.test/join/guest' });
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<RouterProvider router={createAppRouter([`/manage/event/${RECOVERY_EVENT_ID}`])} />);
    expect(await screen.findByAltText('Moment 2')).toBeVisible();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Load more photos' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('This session has expired.');
    expect(screen.getByAltText('Moment 2')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Sign in' }))
      .toHaveAttribute('href', hostSignInHref(RECOVERY_EVENT_ID));
    expect(screen.getByLabelText('Management link')).toBeVisible();
  });

  it('turns manager-action credential loss into access recovery without discarding usable state', async () => {
    const event = { ...MANAGED_EVENT, id: RECOVERY_EVENT_ID };
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? 'GET').toUpperCase() !== 'GET') {
        return errorJson({ code: 'TOKEN_REVOKED', message: 'This link was replaced with a new one.', requestId: 'request-a' }, 403);
      }
      if (url.endsWith(`/api/manage/events/${RECOVERY_EVENT_ID}`)) return json({ event });
      if (url.includes('/media')) return json({ media: makeMedia(2).slice(1), nextCursor: null });
      if (url.includes('/messages')) return json({ messages: [] });
      if (url.endsWith('/exports')) return json({ exports: [] });
      if (url.endsWith('/links')) return json({ guestLink: 'https://example.test/join/guest' });
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<RouterProvider router={createAppRouter([`/manage/event/${RECOVERY_EVENT_ID}`])} />);
    expect(await screen.findByAltText('Moment 2')).toBeVisible();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Delete moment-2.jpg' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('This link was replaced with a new one.');
    expect(screen.getByAltText('Moment 2')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Sign in' }))
      .toHaveAttribute('href', hostSignInHref(RECOVERY_EVENT_ID));
    expect(screen.getByLabelText('Management link')).toBeVisible();
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

describe('host account attachment and recovery', () => {
  // Routes the create call, then every host-account call, from one stub so a test
  // can assert which endpoint the panel actually chose.
  function stubHostFlow(overrides: Record<string, unknown> = {}) {
    const fetchMock = vi.fn((url: string) => {
      const path = String(url);
      if (path === '/api/events') return json({
        ...CREATED,
        event: { ...CREATED.event, id: RECOVERY_EVENT_ID },
        savedToAccount: false,
        ...overrides.create as object,
      }, 201);
      if (path === '/api/host/register') return json({ registrationPending: true }, 202);
      if (path === '/api/host/register/resend') return json({ registrationPending: true }, 202);
      if (path === '/api/host/register/complete') {
        return json({ registered: true, boundEvent: overrides.boundEvent ?? true });
      }
      return json({}, 200);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock as unknown as ReturnType<typeof vi.fn> & { mock: { calls: [string, RequestInit?][] } };
  }

  async function registerFromCreate(user: ReturnType<typeof userEvent.setup>) {
    await createEvent(user);
    await user.type(screen.getByLabelText('Email address'), 'host@example.com');
    await user.type(screen.getByLabelText('Password'), 'a-sufficiently-long-password');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    await screen.findByRole('heading', { name: 'Check your email.' });
  }

  it('keeps the lost-link warning while registration is only pending', async () => {
    stubHostFlow();
    render(<RouterProvider router={createAppRouter(['/create'])} />);
    await registerFromCreate(userEvent.setup());

    // Requesting a code is not proof of anything yet, so nothing may imply the
    // event has become recoverable.
    expect(screen.getByText(/still depends on its management link/i)).toBeVisible();
    expect(screen.queryByText(/already saved to this account/i)).not.toBeInTheDocument();
  });

  it('does not claim a registration email was sent before delivery is known', async () => {
    stubHostFlow();
    render(<RouterProvider router={createAppRouter(['/create'])} />);
    await registerFromCreate(userEvent.setup());

    expect(screen.getByText(/enter the six-digit code if one arrives/i)).toBeVisible();
    expect(screen.queryByText(/we sent/i)).not.toBeInTheDocument();
  });

  it('relaxes the warning only once completion reports a bound event', async () => {
    stubHostFlow({ boundEvent: true });
    const user = userEvent.setup();
    const router = createAppRouter(['/create']);
    render(<RouterProvider router={router} />);
    await registerFromCreate(user);

    // Asserted before as well as after: a panel that relaxes the warning when the
    // code is merely requested would otherwise satisfy the post-condition alone.
    expect(screen.getByText(/still depends on its management link/i)).toBeVisible();

    await user.type(screen.getByLabelText('Confirmation code'), '424242');
    await user.click(screen.getByRole('button', { name: 'Confirm my email' }));

    await waitFor(() => expect(router.state.location.pathname).toBe(`/manage/event/${RECOVERY_EVENT_ID}`));
  });

  it('says the event is still link-only when completion binds nothing', async () => {
    stubHostFlow({ boundEvent: false });
    const user = userEvent.setup();
    render(<RouterProvider router={createAppRouter(['/create'])} />);
    await registerFromCreate(user);

    await user.type(screen.getByLabelText('Confirmation code'), '424242');
    await user.click(screen.getByRole('button', { name: 'Confirm my email' }));

    // The account exists, but this event did not attach. Saying "saved" here is the
    // exact false promise the warning exists to prevent.
    await screen.findByText(/still depends on its management link/i);
    expect(screen.queryByText(/reach this event any time/i)).not.toBeInTheDocument();
  });

  it('completes and resends a pending registration through the registration endpoints', async () => {
    const fetchMock = stubHostFlow();
    const user = userEvent.setup();
    render(<RouterProvider router={createAppRouter(['/create'])} />);
    await registerFromCreate(user);

    await user.click(screen.getByRole('button', { name: 'Send another code' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === '/api/host/register/resend')).toBe(true));

    await user.type(screen.getByLabelText('Confirmation code'), '424242');
    await user.click(screen.getByRole('button', { name: 'Confirm my email' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === '/api/host/register/complete')).toBe(true));

    // The host-session verification endpoints belong to the standalone account
    // page; a browser with no account yet has no session to present to them.
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/host/verify'))).toBe(false);
  });

  it('skips registration entirely when creation already saved the event', async () => {
    stubHostFlow({ create: { savedToAccount: true } });
    render(<RouterProvider router={createAppRouter(['/create'])} />);
    await createEvent(userEvent.setup());

    expect(screen.getByText(/Anyone who has it can manage this event/i)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Create account' })).not.toBeInTheDocument();
  });

  it('moves create-success registration into the addressable pending route', async () => {
    const eventId = '11111111-2222-4333-8444-555555555555';
    const fetchMock = stubHostFlow({ create: { event: { ...CREATED.event, id: eventId } } });
    const router = createAppRouter(['/create']);
    const user = userEvent.setup();
    render(<RouterProvider router={router} />);
    await createEvent(user);
    await user.type(screen.getByLabelText('Email address'), 'host@example.com');
    await user.type(screen.getByLabelText('Password'), 'a-sufficiently-long-password');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/host/register'));
    expect(router.state.location.search).toBe(`?returnTo=%2Fmanage%2Fevent%2F${eventId}&adopt=${eventId}&pending=1`);
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/host/register')).toBe(true);
  });
});

describe('host recovery from a dead credential', () => {
  it('carries the event and a same-origin return path into the manager sign-in link', async () => {
    vi.stubGlobal('fetch', vi.fn(() => errorJson(
      { code: 'HOST_SESSION_REQUIRED', message: 'Your sign-in has expired.', requestId: 'r' }, 401,
    )));
    render(<RouterProvider router={createAppRouter(['/manage/event/11111111-2222-4333-8444-555555555555'])} />);

    const signIn = await screen.findByRole('link', { name: 'Sign in' });
    // Both halves matter: the return path is what brings the host back, and `adopt`
    // is what makes the trip worth taking.
    expect(signIn).toHaveAttribute('href', '/host/login?returnTo=%2Fmanage%2Fevent%2F11111111-2222-4333-8444-555555555555&adopt=11111111-2222-4333-8444-555555555555');
  });

  it('offers sign-in when a manager route has no usable credential', async () => {
    vi.stubGlobal('fetch', vi.fn(() => errorJson(
      { code: 'HOST_SESSION_REQUIRED', message: 'Your sign-in has expired.', requestId: 'r' }, 401,
    )));
    render(<RouterProvider router={createAppRouter(['/manage/event/11111111-2222-4333-8444-555555555555'])} />);

    await screen.findByText('Your sign-in has expired.');
    expect(await screen.findByRole('link', { name: 'Sign in' }))
      .toHaveAttribute('href', expect.stringContaining('/host/login'));
  });

  it('adopts the returned event after signing in, before navigating away', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      seen.push(String(url));
      if (String(url) === '/api/host/session') return json({ account: { id: 'a', email: 'h@e.com', displayName: null, emailVerified: true, notificationsEnabled: true }, events: [] });
      return json({}, 200);
    }));
    const user = userEvent.setup();
    render(<RouterProvider router={createAppRouter([
      '/host/login?returnTo=%2Fmanage%2Fevent%2F11111111-2222-4333-8444-555555555555&adopt=11111111-2222-4333-8444-555555555555',
    ])} />);

    await user.type(screen.getByLabelText('Email address'), 'host@example.com');
    await user.type(screen.getByLabelText('Password'), 'a-sufficiently-long-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    // The management-link cookie is still in the browser at this instant and is the
    // only thing that authorizes the claim, so adoption cannot wait until after the
    // navigation that discards this page.
    await waitFor(() => expect(seen).toContain('/api/host/events/11111111-2222-4333-8444-555555555555/adopt'));
    expect(seen.indexOf('/api/host/events/11111111-2222-4333-8444-555555555555/adopt')).toBeGreaterThan(seen.indexOf('/api/host/login'));
  });

  it('offers manager registration beside sign-in with the same recovery context', async () => {
    const eventId = '11111111-2222-4333-8444-555555555555';
    vi.stubGlobal('fetch', vi.fn(() => errorJson(
      { code: 'HOST_SESSION_REQUIRED', message: 'Sign in required.', requestId: 'r' }, 401,
    )));
    render(<MemoryRouter><EventAccountCard eventId={eventId} /></MemoryRouter>);

    const signIn = await screen.findByRole('link', { name: 'Sign in' });
    const register = screen.getByRole('link', { name: 'Create account' });
    expect(signIn).toHaveAttribute('href', `/host/login?returnTo=%2Fmanage%2Fevent%2F${eventId}&adopt=${eventId}`);
    expect(register).toHaveAttribute('href', `/host/register?returnTo=%2Fmanage%2Fevent%2F${eventId}&adopt=${eventId}`);
  });

  it('preserves validated recovery context while switching between sign-in and registration', async () => {
    const eventId = '11111111-2222-4333-8444-555555555555';
    const context = `?returnTo=%2Fmanage%2Fevent%2F${eventId}&adopt=${eventId}`;
    const router = createAppRouter([`/host/login${context}`]);
    const user = userEvent.setup();
    render(<RouterProvider router={router} />);

    await user.click(screen.getByRole('link', { name: 'Create account' }));
    await screen.findByRole('heading', { name: 'Save this event to your email' });
    expect(router.state.location.search).toBe(context);
    await user.click(screen.getByRole('link', { name: 'Sign in' }));
    await screen.findByRole('heading', { name: 'Sign in to your events' });
    expect(router.state.location.search).toBe(context);
  });

  it('resumes registration from the pending URL and lets the host start over durably', async () => {
    const eventId = '11111111-2222-4333-8444-555555555555';
    const pending = `/host/register?returnTo=%2Fmanage%2Fevent%2F${eventId}&adopt=${eventId}&pending=1`;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      void init;
      if (String(url) === '/api/host/register') return json({ registrationPending: true }, 202);
      return json({}, 200);
    });
    vi.stubGlobal('fetch', fetchMock);
    const router = createAppRouter([`/host/register?returnTo=%2Fmanage%2Fevent%2F${eventId}&adopt=${eventId}`]);
    const user = userEvent.setup();
    render(<RouterProvider router={router} />);

    await user.type(screen.getByLabelText('Email address'), 'host@example.com');
    await user.type(screen.getByLabelText('Password'), 'a-sufficiently-long-password');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    await screen.findByRole('heading', { name: 'Check your email.' });
    await waitFor(() => expect(router.state.location.pathname + router.state.location.search).toBe(pending));

    const registerCall = fetchMock.mock.calls.find(([url]) => url === '/api/host/register');
    expect(JSON.parse(String(registerCall?.[1]?.body))).toMatchObject({ bindEventId: eventId });

    cleanup();
    const resumed = createAppRouter([pending]);
    render(<RouterProvider router={resumed} />);
    expect(screen.getByRole('heading', { name: 'Check your email.' })).toBeVisible();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Start over' }));
    await screen.findByRole('heading', { name: 'Save this event to your email' });
    expect(resumed.state.location.search).toBe(`?returnTo=%2Fmanage%2Fevent%2F${eventId}&adopt=${eventId}`);

    cleanup();
    render(<RouterProvider router={createAppRouter([resumed.state.location.pathname + resumed.state.location.search])} />);
    expect(screen.getByRole('heading', { name: 'Save this event to your email' })).toBeVisible();
  });

  it('states the 12-hour creator ownership window on registration and creation success', async () => {
    render(<RouterProvider router={createAppRouter(['/host/register'])} />);
    expect(screen.getByText(/earlier of the management deadline and 12 hours after creation/i)).toBeVisible();

    cleanup();
    vi.stubGlobal('fetch', vi.fn(() => json(CREATED, 201)));
    render(<RouterProvider router={createAppRouter(['/create'])} />);
    await createEvent(userEvent.setup());
    expect(screen.getByText(/earlier of the management deadline and 12 hours after creation/i)).toBeVisible();
  });
});

describe('host account preferences and sign out', () => {
  const SESSION = {
    account: { id: 'a', email: 'host@example.com', displayName: null, emailVerified: true, notificationsEnabled: true },
    events: [],
  };

  it('keeps the host on the page when sign out is refused', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (String(url) === '/api/host/session') return json(SESSION);
      return errorJson({ code: 'INTERNAL_ERROR', message: 'Sign out failed.', requestId: 'r' }, 500);
    }));
    const user = userEvent.setup();
    render(<RouterProvider router={createAppRouter(['/host/events'])} />);
    await screen.findByRole('heading', { name: 'Your events' });

    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    // Navigating anyway would show a signed-out page while the server still holds a
    // live session — the opposite of what the host was told happened.
    await screen.findByText('Sign out failed.');
    expect(screen.getByRole('heading', { name: 'Your events' })).toBeVisible();
  });

  it('turns lifecycle email off and back on from the account page', async () => {
    let enabled = true;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (String(url) === '/api/host/session') {
        return json({ ...SESSION, account: { ...SESSION.account, notificationsEnabled: enabled } });
      }
      if (String(url) === '/api/host/preferences') {
        enabled = JSON.parse(String(init?.body ?? '{}')).notificationsEnabled;
        return json({ account: { ...SESSION.account, notificationsEnabled: enabled } });
      }
      return json({}, 200);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<RouterProvider router={createAppRouter(['/host/events'])} />);

    const toggle = await screen.findByRole('checkbox', { name: /event emails/i });
    expect(toggle).toBeChecked();

    await user.click(toggle);
    await waitFor(() => expect(enabled).toBe(false));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /event emails/i })).not.toBeChecked());
  });
});

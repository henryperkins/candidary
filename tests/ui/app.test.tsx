import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, RouterProvider, Routes } from 'react-router-dom';
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
import type { GuestEventView } from '../../shared/contracts';
import { resolveEventTheme } from '../../shared/event-theme';
import { mediaPreview } from '../../src/app/api';
import { hostSignInHref } from '../../src/app/recovery';
import { createAppRouter } from '../../src/app/router';
import { EventAccountCard } from '../../src/components/EventAccountCard';
import { ManagementLinkRecovery } from '../../src/components/ManagementLinkRecovery';
import { EventPage } from '../../src/pages/EventPage';
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
  // The Worker resolved the instant from the date, the local start time, and the
  // zone; the receipt reads that back rather than restating what was typed.
  event: {
    id: 'event-a', name: 'Maya & Theo', slug: 'maya-theo', eventDate: '2026-09-19',
    eventStartAt: '2026-09-19T05:00:00.000Z', eventStartTime: '00:00',
    eventTimezone: 'America/Chicago',
  },
  eventLink: 'https://example.test/join#entry-id.entry-secret',
  managementLink: 'https://example.test/manage/manager-secret',
  csrfToken: 'csrf-a',
};
const RECOVERY_EVENT_ID = '11111111-2222-4333-8444-555555555555';
const QR_DATA_URL = 'data:image/png;base64,candidary-test';

qrToDataURL.mockResolvedValue(QR_DATA_URL);

// What `GET /api/manage/events/:id` answers to the management cookie the host is still
// holding when they arrive at the sign-in panel. The return note reads its name and
// date from here, by id — never from the query string.
const EVENT_SUMMARY = {
  id: RECOVERY_EVENT_ID,
  slug: 'maya-theo',
  name: 'Maya & Theo',
  eventDate: '2026-09-19',
  welcomeMessage: '',
  uploadsEnabled: true,
  galleryVisible: true,
  moderationRequired: false,
};

async function createEvent(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Event name'), 'Maya & Theo');
  await user.type(screen.getByLabelText('Event date'), '2026-09-19');
  await user.type(screen.getByLabelText('Welcome message'), 'Come share the moments you caught.');
  await user.click(screen.getByRole('button', { name: 'Create private event' }));
  await screen.findByRole('heading', { name: 'Your event is ready.' });
}

afterEach(() => {
  // Lifecycle boundaries are driven with fake timers, and a suite that left them
  // installed would hang the next test that waits on a real one.
  vi.useRealTimers();
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
    expect(screen.getByText('Enter a Candidary management link.')).toBeVisible();
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
    // Scoped to the workflow list: the footer's own link groups are list items too.
    const workflow = screen.getByRole('heading', { name: 'One place. Every perspective.' }).closest('section');
    expect(within(workflow as HTMLElement).getAllByRole('listitem')).toHaveLength(3);
    expect(within(workflow as HTMLElement).getByText('No app, no account')).toBeVisible();
  });

  // Six disclosures, closed on arrival, each answering with a limit the product actually enforces.
  it('answers the common questions without opening any of them first', async () => {
    render(<RouterProvider router={createAppRouter(['/'])} />);
    const faq = screen.getByRole('heading', { name: 'The short answers.' }).closest('section') as HTMLElement;
    const questions = within(faq).getAllByRole('group');
    expect(questions).toHaveLength(6);
    for (const question of questions) expect(question).not.toHaveAttribute('open');

    await userEvent.setup().click(within(faq).getByText('What can guests send?'));
    expect(questions[0]).not.toHaveAttribute('open');
    expect(within(faq).getByText(/up to 20 MB per image/)).toBeVisible();
  });

  it('carries a footer with both account doors and the retention fact', () => {
    render(<RouterProvider router={createAppRouter(['/'])} />);
    const footer = screen.getByRole('contentinfo');
    expect(within(footer).getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/host/login');
    expect(within(footer).getByRole('link', { name: 'Create an account' })).toHaveAttribute('href', '/host/register');
    expect(within(footer).getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy');
    expect(within(footer).getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms');
    expect(within(footer).getByText('Guest access ends 30 days after your event. Files delete at 120.')).toBeVisible();
  });

  // The footer links are live routes, so neither can land on the catch-all.
  it.each([
    ['/privacy', 'Privacy'],
    ['/terms', 'Terms'],
  ])('serves %s as its own page', (path, heading) => {
    render(<RouterProvider router={createAppRouter([path])} />);
    expect(screen.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    expect(screen.queryByText('That page wandered off.')).not.toBeInTheDocument();
  });

  it('creates an event and clearly returns both access links', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => json(CREATED, 201));
    vi.stubGlobal('fetch', fetchMock);
    render(<RouterProvider router={createAppRouter(['/create'])} />);
    await createEvent(userEvent.setup());
    expect(screen.getByRole('heading', { name: 'Your event is ready.' })).toBeVisible();
    expect(screen.getByText('Event link')).toBeVisible();
    expect(screen.getByText('Management link')).toBeVisible();
    expect(screen.getByRole('link', { name: /open event manager/i }))
      .toHaveAttribute('href', `/manage/event/${CREATED.event.id}`);
    // A new event is paused by default, so the receipt names the next real step.
    expect(screen.getByRole('link', { name: 'Set up guest list' }))
      .toHaveAttribute('href', `/manage/event/${CREATED.event.id}?section=rsvp`);
    expect(screen.getByText(CREATED.managementLink)).toBeInTheDocument();
    expect(screen.getByText(/cannot be recovered/i)).toBeVisible();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, request] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(request?.body))).toMatchObject({
      theme: { version: 1, presetId: 'candidary-default', overrides: {} },
    });
  });

  it('offers a visible midnight start time and reads the resolved start back in the event zone', async () => {
    // The host is creating an event in another zone, which is the case that says
    // whether the receipt reports the start they chose or the one this laptop shows.
    const created = {
      ...CREATED,
      event: { ...CREATED.event, eventTimezone: 'Europe/London', eventStartAt: '2026-09-18T23:00:00.000Z' },
    };
    const fetchMock = vi.fn<typeof fetch>(() => json(created, 201));
    vi.stubGlobal('fetch', fetchMock);
    render(<RouterProvider router={createAppRouter(['/create'])} />);
    const user = userEvent.setup();

    // Prefilled, so a start time is not a new completion hurdle, and visible, so
    // it is never an invisible server assumption either.
    expect(screen.getByLabelText('Event start time')).toBeVisible();
    expect(screen.getByLabelText('Event start time')).toHaveValue('00:00');

    await user.clear(screen.getByLabelText('Event time zone'));
    await user.type(screen.getByLabelText('Event time zone'), 'Europe/London');
    await createEvent(user);

    const [, request] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(request?.body))).toMatchObject({
      eventStartTime: '00:00', eventTimezone: 'Europe/London',
    });
    expect(screen.getByText('Maya & Theo begins September 19, 2026 at 12:00 AM (Europe/London).')).toBeVisible();
    expect(screen.getByText('RSVP is paused until you add and validate the guest list. Photo delivery opens by itself when the event starts.')).toBeVisible();
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

  it('walks focus through the RSVP fields in the order the form presents them', async () => {
    vi.stubGlobal('fetch', vi.fn(() => errorJson({
      code: 'VALIDATION_FAILED',
      message: 'Check the event details.',
      fieldErrors: {
        // Answered out of order on purpose: the host is taken to the first
        // problem they would have reached, not the first the server listed.
        welcomeMessage: 'Write a welcome message.',
        rsvpDeadlineDate: 'Choose a valid RSVP deadline.',
        eventTimezone: 'Choose a valid time zone.',
      },
      requestId: 'request-a',
    }, 422)));
    render(<RouterProvider router={createAppRouter(['/create'])} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Create private event' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Check the event details.');

    await waitFor(() => expect(screen.getByLabelText('Event time zone')).toHaveFocus());
    expect(screen.getByLabelText('Event time zone'))
      .toHaveAccessibleDescription('Choose a valid time zone.');
    expect(screen.getByLabelText('RSVP deadline'))
      .toHaveAccessibleDescription('Choose a valid RSVP deadline.');
  });

  it('defaults the time zone to the host browser and offers it for editing', async () => {
    render(<RouterProvider router={createAppRouter(['/create'])} />);

    const zone = screen.getByLabelText('Event time zone');
    expect(zone).toHaveValue(Intl.DateTimeFormat().resolvedOptions().timeZone);
    // Typed, not chosen from a fixed list: a browser without
    // `Intl.supportedValuesOf` still lets a host name any zone the server knows.
    const user = userEvent.setup();
    await user.clear(zone);
    await user.type(zone, 'Pacific/Auckland');
    expect(zone).toHaveValue('Pacific/Auckland');
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

    await user.click(screen.getByRole('button', { name: 'Copy event link' }));
    expect(writeText).toHaveBeenCalledWith('https://example.test/join#entry-id.entry-secret');
    expect(screen.queryByText('Copied')).not.toBeInTheDocument();

    await act(async () => { resolveCopy(); });
    expect(await screen.findByText('Copied')).toBeVisible();
  });

  it('lets the host reveal and hide the full private link on demand', async () => {
    vi.stubGlobal('fetch', vi.fn(() => json(CREATED, 201)));
    render(<RouterProvider router={createAppRouter(['/create'])} />);
    const user = userEvent.setup();
    await createEvent(user);

    const reveal = screen.getByRole('button', { name: 'Show full event link' });
    expect(reveal).toHaveAttribute('aria-expanded', 'false');
    await user.click(reveal);

    const hide = screen.getByRole('button', { name: 'Hide full event link' });
    expect(hide).toHaveAttribute('aria-expanded', 'true');
    // The control must point at the link it reveals, and that link must be selectable.
    const revealed = document.getElementById(hide.getAttribute('aria-controls') ?? '');
    expect(revealed, 'aria-controls resolves').not.toBeNull();
    expect(revealed).toBeVisible();
    expect(revealed).toHaveTextContent('https://example.test/join#entry-id.entry-secret');
    expect(revealed).toHaveAttribute('tabindex', '0');
    // The management link keeps its own independent control.
    expect(screen.getByRole('button', { name: 'Show full management link' })).toHaveAttribute('aria-expanded', 'false');

    await user.click(hide);
    expect(screen.getByRole('button', { name: 'Show full event link' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('reports unavailable clipboard writes without claiming success, and reveals the link instead', async () => {
    vi.stubGlobal('fetch', vi.fn(() => json(CREATED, 201)));
    render(<RouterProvider router={createAppRouter(['/create'])} />);
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('Permission denied'));
    await createEvent(user);
    expect(screen.getByRole('button', { name: 'Show full event link' })).toHaveAttribute('aria-expanded', 'false');

    await user.click(screen.getByRole('button', { name: 'Copy event link' }));
    expect(await screen.findByText('Copy unavailable. Select the link instead.')).toBeVisible();
    expect(screen.queryByText('Copied')).not.toBeInTheDocument();

    const hide = screen.getByRole('button', { name: 'Hide full event link' });
    expect(hide).toHaveAttribute('aria-expanded', 'true');
    const revealed = document.getElementById(hide.getAttribute('aria-controls') ?? '');
    expect(revealed, 'aria-controls resolves').not.toBeNull();
    expect(revealed).toBeVisible();
    expect(revealed).toHaveTextContent('https://example.test/join#entry-id.entry-secret');
  });
});

// The photo-drop phase with nothing else switched on, so a note test exercises the
// notes disclosure rather than the gallery or the household one beside it.
const GUEST_EVENT = {
  id: 'event-a', slug: 'maya-theo', name: 'Maya & Theo', eventDate: '2026-09-19',
  welcomeMessage: 'We would love to see the day through your eyes.', uploadsEnabled: true,
  cover: { revision: 0, hasCover: false, available2xProfiles: [], surfaceTreatment: 'none' },
  galleryVisible: false, moderationRequired: true, phase: 'photos-primary',
  rsvpState: 'disabled', rsvpAccess: 'unavailable', rsvpDeadlineAt: null, rsvpDeadlineDate: null,
  eventTimezone: 'America/Chicago', eventStartAt: '2026-09-19T22:00:00.000Z',
  lifecycleRecheckAfterMs: null,
};

describe('guest event experience', () => {
  it('loads the private photo drop first and keeps the gallery and notes secondary', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/event/maya-theo')) return json({ event: { ...GUEST_EVENT, galleryVisible: true }, role: 'guest' });
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
    await user.click(screen.getByText(/Guest notes/, { selector: 'span' }));
    expect(screen.getByText('To many happy years.')).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('names the note field after the event rather than leaving it to a placeholder', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/event/maya-theo')) return json({ event: GUEST_EVENT, role: 'guest' });
      if (url.endsWith('/messages')) return json({ items: [] });
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<RouterProvider router={createAppRouter(['/event/maya-theo'])} />);
    expect(await screen.findByRole('heading', { name: 'We would love to see the day through your eyes.' })).toBeVisible();

    await userEvent.setup().click(screen.getByText(/Guest notes/, { selector: 'span' }));
    // A placeholder is not a name: it disappears on the first keystroke and is not announced as one.
    const note = await screen.findByRole('textbox', { name: 'Your note for Maya & Theo' });
    expect(note).toBeVisible();
    // Exactly the field's own name — no placeholder, no submit label, nothing else swept in with it.
    expect(note).toHaveAccessibleName('Your note for Maya & Theo');
    expect(note).toHaveAttribute('name', 'body');
    expect(note).toHaveAttribute('placeholder', 'Share a wish or memory…');
    fireEvent.change(note, { target: { value: 'x'.repeat(499) } });
    expect(screen.getByText('1 character left')).toBeVisible();
  });

  it('holds one note submission, confirms it, and labels its private moderation state', async () => {
    let resolvePost!: (response: Response) => void;
    const pendingPost = new Promise<Response>((resolve) => { resolvePost = resolve; });
    let postCount = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/event/maya-theo')) return json({ event: GUEST_EVENT, role: 'guest' });
      if (url.endsWith('/messages') && init?.method === 'POST') {
        postCount += 1;
        return pendingPost;
      }
      if (url.endsWith('/messages')) return json({ items: [], nextCursor: null });
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<RouterProvider router={createAppRouter(['/event/maya-theo'])} />);
    expect(await screen.findByRole('heading', { name: 'We would love to see the day through your eyes.' })).toBeVisible();

    const user = userEvent.setup();
    await user.click(screen.getByText(/Guest notes/, { selector: 'span' }));
    const note = await screen.findByRole('textbox', { name: 'Your note for Maya & Theo' });
    await user.type(note, 'What a perfect evening.');
    const send = screen.getByRole('button', { name: 'Send note' });
    await user.click(send);
    expect(send).toBeDisabled();
    await user.click(send);
    expect(postCount).toBe(1);

    resolvePost(await json({
      message: {
        id: 'message-a',
        kind: 'message',
        guestName: 'Avery',
        body: 'What a perfect evening.',
        moderationStatus: 'pending',
        createdAt: '2026-09-19T20:00:00.000Z',
        mediaId: null,
      },
      replayed: false,
    }, 201));
    expect(await screen.findByText(
      'Your note was sent to the host for review. Only you can see it here for now.',
    )).toBeVisible();
    expect(note).toHaveValue('');
    expect(screen.getByText('What a perfect evening.')).toBeVisible();
    expect(screen.getByText('Awaiting host review')).toBeVisible();
    expect(screen.getByText('Only you can see this until the host shares it.')).toBeVisible();
  });

  it('preserves a failed draft and reuses its idempotency key on retry', async () => {
    const attempts: Array<{ idempotencyKey: string; body: string }> = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/event/maya-theo')) return json({ event: GUEST_EVENT, role: 'guest' });
      if (url.endsWith('/messages') && init?.method === 'POST') {
        attempts.push(JSON.parse(String(init.body)) as { idempotencyKey: string; body: string });
        if (attempts.length === 1) return Promise.reject(new TypeError('network dropped'));
        return json({
          message: {
            id: 'message-a',
            kind: 'message',
            guestName: null,
            body: 'Keep these words.',
            moderationStatus: 'pending',
            createdAt: '2026-09-19T20:00:00.000Z',
            mediaId: null,
          },
          replayed: true,
        });
      }
      if (url.endsWith('/messages')) return json({ items: [], nextCursor: null });
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<RouterProvider router={createAppRouter(['/event/maya-theo'])} />);
    expect(await screen.findByRole('heading', { name: 'We would love to see the day through your eyes.' })).toBeVisible();

    const user = userEvent.setup();
    await user.click(screen.getByText(/Guest notes/, { selector: 'span' }));
    const note = await screen.findByRole('textbox', { name: 'Your note for Maya & Theo' });
    await user.type(note, 'Keep these words.');
    await user.click(screen.getByRole('button', { name: 'Send note' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('was not sent');
    expect(note).toHaveValue('Keep these words.');
    await user.click(screen.getByRole('button', { name: 'Send note again' }));
    expect(await screen.findByText(
      'Your note was sent to the host for review. Only you can see it here for now.',
    )).toBeVisible();
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.idempotencyKey).toBe(attempts[1]?.idempotencyKey);
  });

  it('explains a changed-send conflict and uses a fresh key for the next attempt', async () => {
    const keys: string[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/event/maya-theo')) return json({ event: GUEST_EVENT, role: 'guest' });
      if (url.endsWith('/messages') && init?.method === 'POST') {
        keys.push((JSON.parse(String(init.body)) as { idempotencyKey: string }).idempotencyKey);
        if (keys.length === 1) {
          return errorJson({
            code: 'MESSAGE_SUBMISSION_CONFLICT',
            message: 'This note changed after an earlier send attempt. Send it again.',
            requestId: 'r',
          }, 409);
        }
        return json({
          message: {
            id: 'message-a',
            kind: 'message',
            guestName: null,
            body: 'The final words.',
            moderationStatus: 'pending',
            createdAt: '2026-09-19T20:00:00.000Z',
            mediaId: null,
          },
          replayed: false,
        }, 201);
      }
      if (url.endsWith('/messages')) return json({ items: [], nextCursor: null });
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<RouterProvider router={createAppRouter(['/event/maya-theo'])} />);
    expect(await screen.findByRole('heading', { name: 'We would love to see the day through your eyes.' })).toBeVisible();

    const user = userEvent.setup();
    await user.click(screen.getByText(/Guest notes/, { selector: 'span' }));
    await user.type(
      await screen.findByRole('textbox', { name: 'Your note for Maya & Theo' }),
      'The final words.',
    );
    await user.click(screen.getByRole('button', { name: 'Send note' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('changed after an earlier send attempt');
    await user.click(screen.getByRole('button', { name: 'Send note again' }));
    expect(await screen.findByText(
      'Your note was sent to the host for review. Only you can see it here for now.',
    )).toBeVisible();
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('keeps a note draft when its disclosure is closed and reopened', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/event/maya-theo')) return json({ event: GUEST_EVENT, role: 'guest' });
      if (url.endsWith('/messages')) return json({ items: [], nextCursor: null });
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<RouterProvider router={createAppRouter(['/event/maya-theo'])} />);
    expect(await screen.findByRole('heading', { name: 'We would love to see the day through your eyes.' })).toBeVisible();

    const user = userEvent.setup();
    const summary = screen.getByText(/Guest notes/, { selector: 'span' });
    await user.click(summary);
    await user.type(await screen.findByRole('textbox', { name: 'Your note for Maya & Theo' }), 'Still here.');
    await user.click(summary);
    expect(screen.queryByRole('textbox', { name: 'Your note for Maya & Theo' })).not.toBeInTheDocument();
    await user.click(summary);
    expect(await screen.findByRole('textbox', { name: 'Your note for Maya & Theo' })).toHaveValue('Still here.');
  });

  it('distinguishes a failed notes read from a confirmed empty feed and retries in place', async () => {
    let reads = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/event/maya-theo')) return json({ event: GUEST_EVENT, role: 'guest' });
      if (url.endsWith('/messages')) {
        reads += 1;
        return reads === 1
          ? errorJson({ code: 'INTERNAL_ERROR', message: 'Notes are unavailable.', requestId: 'r' }, 503)
          : json({ items: [], nextCursor: null });
      }
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<RouterProvider router={createAppRouter(['/event/maya-theo'])} />);
    expect(await screen.findByRole('heading', { name: 'We would love to see the day through your eyes.' })).toBeVisible();

    const user = userEvent.setup();
    await user.click(screen.getByText(/Guest notes/, { selector: 'span' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Notes are unavailable.');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No notes or photo captions have been shared yet.')).toBeVisible();
    expect(reads).toBe(2);
  });
});

const MANAGED_EVENT = {
  id: 'event-a', slug: 'maya-theo', name: 'Maya & Theo', eventDate: '2026-09-19',
  welcomeMessage: 'Welcome.',
  cover: {
    config: { version: 1, source: { kind: 'none' } }, revision: 0, hasCover: false,
    available2xProfiles: [], surfaceTreatment: 'none', preparation: null,
  },
  uploadsEnabled: true, galleryVisible: true, moderationRequired: true,
  storedMediaCount: 3, storedBytes: 128,
  guestAccessExpiresAt: '2026-10-19T00:00:00Z', purgeAfter: '2026-12-19T00:00:00Z',
  eventTimezone: 'America/Chicago',
  eventStartAt: '2026-09-19T22:00:00.000Z', eventStartTime: '17:00',
  photosOpen: true, photoIntakeState: 'open', photoIntakeRecheckAfterMs: null,
  rsvpEnabled: false,
  rsvpDeadlineAt: '2026-09-05T04:59:59.999Z', rsvpDeadlineDate: '2026-09-04',
  rsvpRosterVersion: 7,
  theme: resolveEventTheme({ version: 1, presetId: 'candidary-default', overrides: {} }),
};

const RSVP_SUMMARY = {
  invitedCapacity: 8, namedInvitees: 6, plusOneCapacity: 2,
  attending: 3, declined: 2, awaitingResponse: 3,
  householdsResponded: 1, householdsAwaitingResponse: 2,
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
    if (url.endsWith('/entry')) return json({ eventLink: 'https://example.test/join#entry-id.entry-secret', disabledAt: null });
    // The RSVP panel is mounted only from its own destination, so these answer
    // nothing until the host navigates there.
    if (url.includes('/rsvp/summary')) return json(RSVP_SUMMARY);
    if (url.includes('/rsvp/households')) return json({ households: [], nextCursor: null });
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
    expect(within(navigation).getAllByRole('button')).toHaveLength(6);
    await userEvent.setup().click(within(navigation).getByRole('button', { name: /settings/i }));

    const settingsForm = document.querySelector('form.settings-form');
    const editor = screen.getByRole('region', { name: 'Event appearance editor' });
    const account = document.querySelector('.account-card');
    const danger = document.querySelector('.danger-zone');
    expect(settingsForm?.contains(editor)).toBe(false);
    expect(settingsForm!.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(editor.compareDocumentPosition(account!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(editor.compareDocumentPosition(danger!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps an unsaved Settings edit while the host visits another destination', async () => {
    vi.stubGlobal('fetch', managerFetch({ first: { media: [], nextCursor: null } }));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await screen.findByRole('heading', { name: 'Live intake' });
    const user = userEvent.setup();
    const navigation = screen.getByRole('navigation', { name: 'Manager sections' });

    await user.click(within(navigation).getByRole('button', { name: /settings/i }));
    const name = screen.getByLabelText('Event name');
    await user.clear(name);
    await user.type(name, 'Maya & Theo — Reception');

    await user.click(within(navigation).getByRole('button', { name: /gallery/i }));
    // Mounted but out of the way. `getByLabelText` deliberately still finds a
    // hidden control, so this has to assert visibility rather than presence.
    expect(screen.getByLabelText('Event name')).not.toBeVisible();
    expect(document.querySelector('.manager-panel[hidden]')).toHaveAttribute('inert');

    await user.click(within(navigation).getByRole('button', { name: /settings/i }));
    expect(screen.getByLabelText('Event name')).toHaveValue('Maya & Theo — Reception');
  });

  it('adopts the settings response without refreshing the whole manager', async () => {
    const fetchMock = managerFetch({ first: { media: [], nextCursor: null } });
    const settingsResponse = {
      ...MANAGED_EVENT,
      name: 'Renamed',
      rsvpRosterVersion: 8,
      // A settings response is built from whatever the row said when it committed,
      // so it may carry a theme older than the one already on screen.
      theme: resolveEventTheme({ version: 1, presetId: 'garden-party', overrides: {} }),
    };
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/settings') && String(init?.method).toUpperCase() === 'PATCH') {
        return json({ event: settingsResponse });
      }
      return fetchMock(input);
    }));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await screen.findByRole('heading', { name: 'Live intake' });
    const user = userEvent.setup();
    await user.click(within(screen.getByRole('navigation', { name: 'Manager sections' }))
      .getByRole('button', { name: /settings/i }));

    const before = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    await user.click(screen.getByLabelText('Show the optional shared gallery'));

    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Renamed'));
    const after = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    // One PATCH, and no five-request manager refresh behind it.
    expect(after - before).toBe(1);
    // The stale theme in that response must not travel with the settings it owns.
    expect(screen.getByTestId('event-appearance-preview')).toHaveStyle({ '--event-primary': '#4a2415' });
  });

  it('drops a whole-event read that a later write overtook', async () => {
    const gardenTheme = resolveEventTheme({ version: 1, presetId: 'garden-party', overrides: {} });
    let releaseRead: (() => void) | null = null;
    let reads = 0;
    const fetchMock = managerFetch({ first: { media: makeMedia(1), nextCursor: null } });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/api/manage/events/event-a') && method === 'GET') {
        reads += 1;
        // Hold the read that a manager action opened, so a theme write can
        // commit underneath it. It answers with the pre-write row.
        if (reads === 2) await new Promise<void>((resolve) => { releaseRead = resolve; });
        return json({ event: MANAGED_EVENT });
      }
      if (url.includes('/media/') && method === 'PATCH') return json({ media: {} });
      if (url.endsWith('/theme') && method === 'PUT') {
        return json({ event: { ...MANAGED_EVENT, theme: gardenTheme } });
      }
      return fetchMock(input);
    }));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await screen.findByRole('heading', { name: 'Live intake' });
    const user = userEvent.setup();
    const navigation = screen.getByRole('navigation', { name: 'Manager sections' });

    await user.click(within(navigation).getByRole('button', { name: /gallery/i }));
    await user.click(await screen.findByRole('button', { name: /^Publish / }));
    await waitFor(() => expect(reads).toBe(2));

    await user.click(within(navigation).getByRole('button', { name: /settings/i }));
    await user.click(screen.getByRole('radio', { name: 'Garden Party' }));
    await waitFor(() => expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some(([input, init]) => (
      String(input).endsWith('/theme') && String(init?.method).toUpperCase() === 'PUT'
    ))).toBe(true));
    await waitFor(() => expect(screen.getByTestId('event-appearance-preview'))
      .toHaveStyle({ '--event-primary': '#245c46' }));

    releaseRead!();
    // The overtaken read carries the pre-write theme. Adopting it would put the
    // old appearance back and then feed it into the next complete write.
    await waitFor(() => expect(screen.getByTestId('event-appearance-preview'))
      .toHaveStyle({ '--event-primary': '#245c46' }));
    expect(screen.getByTestId('event-appearance-preview')).toHaveStyle({ '--event-primary': '#245c46' });
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
      if (url.endsWith('/entry')) return json({ eventLink: 'https://example.test/join#entry-id.entry-secret', disabledAt: null });
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
      if (url.endsWith('/entry')) return json({ eventLink: 'https://example.test/join#entry-id.entry-secret', disabledAt: null });
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
      if (url.endsWith('/entry')) return json({ eventLink: 'https://example.test/join#entry-id.entry-secret', disabledAt: null });
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
      if (url.endsWith('/entry')) return json({ eventLink: 'https://example.test/join#entry-id.entry-secret', disabledAt: null });
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
      if (url.endsWith('/entry')) return json({ eventLink: 'https://example.test/join#entry-id.entry-secret', disabledAt: null });
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
      if (url.endsWith('/entry')) return json({ eventLink: 'https://example.test/join#entry-id.entry-secret', disabledAt: null });
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
      if (url.endsWith('/entry')) return json({ eventLink: 'https://example.test/join#entry-id.entry-secret', disabledAt: null });
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
      if (url.endsWith('/entry')) return json({ eventLink: 'https://example.test/join#entry-id.entry-secret', disabledAt: null });
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
      if (url.endsWith('/entry')) return json({ eventLink: 'https://example.test/join#entry-id.entry-secret', disabledAt: null });
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
  }, 10_000);

  it('polls live intake so a new private delivery appears without navigation', async () => {
    let mediaRequests = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/manage/events/event-a')) return json({ event: {
        id: 'event-a', slug: 'maya-theo', name: 'Maya & Theo', eventDate: '2026-09-19',
        welcomeMessage: 'Welcome.', uploadsEnabled: true, galleryVisible: false,
        moderationRequired: true, photoIntakeState: 'open',
        storedMediaCount: mediaRequests > 0 ? 1 : 0, storedBytes: 128,
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
      if (url.endsWith('/entry')) return json({ eventLink: null, disabledAt: null });
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
      if (url.endsWith('/entry')) return json({ eventLink: 'https://example.test/join#entry-id.entry-secret', disabledAt: null });
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
      if (url.endsWith('/entry')) return json({ eventLink: 'https://example.test/join#entry-id.entry-secret', disabledAt: null });
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
      if (url.endsWith('/entry')) return json({ eventLink: 'https://example.test/join#entry-id.entry-secret', disabledAt: null });
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
      if (url.endsWith('/entry')) return json({ eventLink: 'https://example.test/join#entry-id.entry-secret', disabledAt: null });
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

  it('does not mistake a disabled event entry for lost manager access', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/manage/events/event-a')) return json({ event: MANAGED_EVENT });
      if (url.includes('/media')) return json({ media: makeMedia(2).slice(1), nextCursor: null });
      if (url.includes('/messages')) return json({ messages: [] });
      if (url.endsWith('/exports')) return json({ exports: [] });
      if (url.endsWith('/entry')) {
        return json({ eventLink: null, disabledAt: '2026-07-21T12:00:00.000Z' });
      }
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);

    expect(await screen.findByRole('heading', { name: 'Live intake' })).toBeVisible();
    // A disabled entry is a permanent event state, not a credential problem, so
    // it must not offer sign-in or link recovery.
    expect(screen.queryByRole('link', { name: 'Sign in' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Management link')).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Share' }));
    expect(screen.getByText(/cannot be replaced/iu)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Show full event link' })).not.toBeInTheDocument();
    for (const copy of screen.getAllByRole('button', { name: 'Copy event link' })) {
      expect(copy).toBeDisabled();
    }
    expect(screen.queryByAltText('Event QR code')).not.toBeInTheDocument();
    // There is deliberately no way to mint a replacement.
    expect(screen.queryByRole('button', { name: /rotate (guest|event) link/iu }))
      .not.toBeInTheDocument();
  });

  it('retires rendered and in-flight event QR codes once the entry is disabled', async () => {
    let disabled = false;
    let resolveFirstQr!: (value: string) => void;
    qrToDataURL.mockImplementationOnce(() => new Promise<string>((resolve) => {
      resolveFirstQr = resolve;
    }));
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/manage/events/event-a')) return json({ event: MANAGED_EVENT });
      if (url.includes('/media')) return json({ media: makeMedia(2).slice(1), nextCursor: null });
      if (url.includes('/messages')) return json({ messages: [] });
      if (url.endsWith('/exports')) return json({ exports: [] });
      if (url.endsWith('/entry')) {
        const answer = disabled
          ? { eventLink: null, disabledAt: '2026-07-21T12:00:00.000Z' }
          : { eventLink: 'https://example.test/join#entry-id.entry-secret', disabledAt: null };
        disabled = true;
        return json(answer);
      }
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);

    expect(await screen.findByRole('heading', { name: 'Live intake' })).toBeVisible();
    const user = userEvent.setup();
    // Any refresh re-reads the entry; this one comes back disabled.
    await user.type(screen.getByLabelText('Filter by guest name'), 'Avery');
    await user.click(screen.getByRole('button', { name: 'Filter' }));

    await user.click(screen.getByRole('button', { name: 'Share' }));
    expect(await screen.findByText(/cannot be replaced/iu)).toBeVisible();

    // The QR render that was already in flight when the entry died must not
    // paint a scannable code afterwards.
    await act(async () => {
      resolveFirstQr('data:image/png;base64,stale-entry');
      await Promise.resolve();
    });
    expect(screen.queryByAltText('Event QR code')).not.toBeInTheDocument();
  });

  it('keeps the readable event link usable when QR generation rejects', async () => {
    qrToDataURL.mockRejectedValueOnce(new Error('QR generation failed'));
    vi.stubGlobal('fetch', managerFetch({
      first: { media: makeMedia(2).slice(1), nextCursor: null },
    }));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);

    expect(await screen.findByRole('heading', { name: 'Live intake' })).toBeVisible();
    await waitFor(() => expect(qrToDataURL).toHaveBeenCalledTimes(1));
    expect(screen.queryByAltText('Event QR code')).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Share' }));
    expect(screen.getByText('https://example.test/join#entry-id.entry-secret')).toBeVisible();
    for (const copy of screen.getAllByRole('button', { name: 'Copy event link' })) {
      expect(copy).toBeEnabled();
    }
  });

  it('keeps the RSVP destination out of the initial manager load', async () => {
    const fetchMock = managerFetch({ first: { media: [], nextCursor: null } });
    vi.stubGlobal('fetch', fetchMock);
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    expect(await screen.findByRole('heading', { name: 'Live intake' })).toBeVisible();

    // Guest-list data is its own destination: it must not join the initial
    // `Promise.all` that every manager arrival pays for.
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/rsvp/'))).toBe(false);

    await userEvent.setup().click(screen.getByRole('button', { name: 'RSVP' }));
    expect(await screen.findByRole('heading', { name: 'Guest list and RSVPs' })).toBeVisible();
    await waitFor(() => expect(screen.getByRole('group', { name: 'Invited capacity' }))
      .toHaveTextContent('8'));
  });

  it('opens the guest list directly from the create receipt destination', async () => {
    vi.stubGlobal('fetch', managerFetch({ first: { media: [], nextCursor: null } }));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a?section=rsvp'])} />);

    expect(await screen.findByRole('heading', { name: 'Guest list and RSVPs' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Live intake' })).not.toBeInTheDocument();
  });

  it('signs guest devices out without changing the printed event link', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/guest-sessions/rotate')) {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return json({ rotated: true, eventLink: 'https://example.test/join#entry-id.entry-secret' });
      }
      if (url.endsWith('/api/manage/events/event-a')) return json({ event: MANAGED_EVENT });
      if (url.includes('/media')) return json({ media: [], nextCursor: null });
      if (url.includes('/messages')) return json({ messages: [] });
      if (url.endsWith('/exports')) return json({ exports: [] });
      if (url.endsWith('/entry')) return json({ eventLink: 'https://example.test/join#entry-id.entry-secret', disabledAt: null });
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    expect(await screen.findByRole('heading', { name: 'Live intake' })).toBeVisible();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Share' }));
    // The old rotatable guest link is gone; the printed credential is permanent.
    expect(screen.queryByRole('button', { name: /rotate guest link/iu })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Sign out guest devices' }));
    const confirmation = screen.getByRole('group', { name: 'Sign out guest devices' });
    expect(confirmation).toHaveTextContent('every printed QR code stays the same');
    const confirm = within(confirmation)
      .getByRole('button', { name: 'Sign out guest devices for Maya & Theo' });
    expect(confirm).toBeDisabled();
    await user.type(within(confirmation).getByLabelText('Confirm event name'), 'Maya & Theo');
    await user.click(confirm);

    await waitFor(() => expect(bodies).toEqual([{ confirmName: 'Maya & Theo' }]));
    expect(screen.getByText('https://example.test/join#entry-id.entry-secret')).toBeVisible();
    // Byte-identical QR input before and after: the printed artefact never moves.
    expect(new Set(qrToDataURL.mock.calls.map(([value]: unknown[]) => value)))
      .toEqual(new Set(['https://example.test/join#entry-id.entry-secret']));
  });

  it('requires the exact event name to disable the printed QR and warns it is permanent', async () => {
    let disabled = false;
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/entry/disable')) {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        disabled = true;
        return json({ disabledAt: '2026-07-31T12:00:00.000Z' });
      }
      if (url.endsWith('/api/manage/events/event-a')) return json({ event: MANAGED_EVENT });
      if (url.includes('/media')) return json({ media: [], nextCursor: null });
      if (url.includes('/messages')) return json({ messages: [] });
      if (url.endsWith('/exports')) return json({ exports: [] });
      if (url.endsWith('/entry')) {
        return json(disabled
          ? { eventLink: null, disabledAt: '2026-07-31T12:00:00.000Z' }
          : { eventLink: 'https://example.test/join#entry-id.entry-secret', disabledAt: null });
      }
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    expect(await screen.findByRole('heading', { name: 'Live intake' })).toBeVisible();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Share' }));
    await user.click(screen.getByRole('button', { name: 'Disable printed event QR' }));

    const confirmation = screen.getByRole('group', { name: 'Disable printed event QR' });
    expect(confirmation).toHaveTextContent('every invitation and sign using this QR stop working');
    expect(confirmation).toHaveTextContent('cannot be undone');
    const confirm = within(confirmation)
      .getByRole('button', { name: 'Disable printed event QR for Maya & Theo' });
    expect(confirm).toBeDisabled();
    await user.type(within(confirmation).getByLabelText('Confirm event name'), 'Maya & Theo');
    await user.click(confirm);

    await waitFor(() => expect(bodies).toEqual([{ confirmName: 'Maya & Theo' }]));
    expect(await screen.findByText(/cannot be replaced/iu)).toBeVisible();
    expect(screen.queryByAltText('Event QR code')).not.toBeInTheDocument();
    // There is no replacement to offer, so the action itself retires.
    expect(screen.queryByRole('button', { name: 'Disable printed event QR' }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign out guest devices' }))
      .not.toBeInTheDocument();
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
      if (url.endsWith('/entry')) return json({ eventLink: 'https://example.test/join#entry-id.entry-secret', disabledAt: null });
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    expect(await screen.findByRole('heading', { name: 'Live intake' })).toBeVisible();

    const user = userEvent.setup();
    // Rotating the manager credential is a Settings concern; Share now carries only
    // the printed event entry.
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.click(screen.getByRole('button', { name: 'Rotate manager link' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Save this event from its original creator session before rotating its management link.',
    );
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeVisible();
    // The refusal is an ordinary rejected write. Settings keeps its own account
    // card, so the proof is that the notice itself offers no credential recovery.
    const notice = screen.getByRole('region', { name: 'Manager notice' });
    expect(within(notice).queryByRole('link', { name: 'Sign in' })).not.toBeInTheDocument();
    expect(within(notice).queryByLabelText('Management link')).not.toBeInTheDocument();
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
      if (url.endsWith('/entry')) return json({ eventLink: 'https://example.test/join#entry-id.entry-secret', disabledAt: null });
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
      if (url.endsWith('/entry')) return json({ eventLink: 'https://example.test/join#entry-id.entry-secret', disabledAt: null });
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
        moderationRequired: true, photoIntakeState: 'open', storedMediaCount: 2, storedBytes: 128,
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
      if (url.endsWith('/entry')) return json({ eventLink: 'https://example.test/join#entry-id.entry-secret', disabledAt: null });
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
    vi.stubGlobal('fetch', vi.fn(() => json({ event: EVENT_SUMMARY })));
    const router = createAppRouter([`/host/login${context}`]);
    const user = userEvent.setup();
    render(<RouterProvider router={router} />);

    // The two doors are tabs of one panel now, but they are still routes: the hrefs
    // are what keep both deep-linkable and carry the recovery context across.
    const register = screen.getByRole('tab', { name: 'Create account' });
    expect(register).toHaveAttribute('href', `/host/register${context}`);
    await user.click(register);
    await screen.findByRole('heading', { name: 'Save this event to your email' });
    expect(router.state.location.search).toBe(context);

    const signIn = screen.getByRole('tab', { name: 'Sign in' });
    expect(signIn).toHaveAttribute('href', `/host/login${context}`);
    await user.click(signIn);
    await screen.findByRole('heading', { name: 'Sign in to your events' });
    expect(router.state.location.search).toBe(context);
  });

  it('puts only the selected door in the tab order and reaches the other by arrow key', async () => {
    const eventId = '11111111-2222-4333-8444-555555555555';
    const context = `?returnTo=%2Fmanage%2Fevent%2F${eventId}&adopt=${eventId}`;
    vi.stubGlobal('fetch', vi.fn(() => json({ event: EVENT_SUMMARY })));
    const router = createAppRouter([`/host/login${context}`]);
    const user = userEvent.setup();
    render(<RouterProvider router={router} />);

    const signIn = screen.getByRole('tab', { name: 'Sign in' });
    expect(signIn).toHaveAttribute('aria-selected', 'true');
    expect(signIn).toHaveAttribute('tabindex', '0');
    // The unselected tab is out of the tab order, so the arrow keys are the only
    // keyboard route to the other door — without them it is unreachable.
    expect(screen.getByRole('tab', { name: 'Create account' })).toHaveAttribute('tabindex', '-1');

    signIn.focus();
    await user.keyboard('{ArrowRight}');
    await waitFor(() => expect(router.state.location.pathname).toBe('/host/register'));
    expect(router.state.location.search).toBe(context);
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Create account' })).toHaveFocus());
  });

  it('names the event the host came from and what signing in will do about it', async () => {
    const eventId = '11111111-2222-4333-8444-555555555555';
    const fetchMock = vi.fn(() => json({ event: EVENT_SUMMARY }));
    vi.stubGlobal('fetch', fetchMock);
    render(<RouterProvider router={createAppRouter([
      `/host/login?returnTo=%2Fmanage%2Fevent%2F${eventId}&adopt=${eventId}`,
    ])} />);

    // Resolved from the API by id — never rendered out of the query string, which is
    // validated for navigation and is not a source of display data.
    expect(await screen.findByText('Maya & Theo')).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(`/api/manage/events/${eventId}`, expect.anything());
    expect(screen.getByText('You will come back here, and this event will be added to your account.'))
      .toBeVisible();
  });

  it('drops the attachment promise when the URL carries no adopt', async () => {
    const eventId = '11111111-2222-4333-8444-555555555555';
    vi.stubGlobal('fetch', vi.fn(() => json({ event: EVENT_SUMMARY })));
    render(<RouterProvider router={createAppRouter([
      `/host/login?returnTo=%2Fmanage%2Fevent%2F${eventId}`,
    ])} />);

    expect(await screen.findByText('You will come back here when you are done.')).toBeVisible();
    expect(screen.queryByText(/added to your account/u)).not.toBeInTheDocument();
  });

  it('keeps the return note when the management link it arrived with has already expired', async () => {
    const eventId = '11111111-2222-4333-8444-555555555555';
    // The dead-end path: the cookie that authorizes the lookup is the thing that
    // expired. The note loses the name and keeps the promise rather than erroring.
    vi.stubGlobal('fetch', vi.fn(() => errorJson(
      { code: 'SESSION_EXPIRED', message: 'That link has expired.', requestId: 'r' }, 401,
    )));
    render(<RouterProvider router={createAppRouter([
      `/host/login?returnTo=%2Fmanage%2Fevent%2F${eventId}&adopt=${eventId}`,
    ])} />);

    expect(await screen.findByText('You will come back here, and this event will be added to your account.'))
      .toBeVisible();
    expect(screen.queryByText('That link has expired.')).not.toBeInTheDocument();
  });

  it('asks for the six-digit code in one field, never six', async () => {
    vi.stubGlobal('fetch', vi.fn(() => json({}, 200)));
    render(<RouterProvider router={createAppRouter(['/host/register?pending=1'])} />);

    const code = screen.getByLabelText('Confirmation code');
    // `autocomplete="one-time-code"` only resolves on a single field; six inputs also
    // break paste and the value a screen reader reads back.
    expect(code).toHaveAttribute('autocomplete', 'one-time-code');
    expect(code).toHaveAttribute('inputmode', 'numeric');
    expect(code).toHaveAttribute('maxlength', '6');
    expect(screen.getAllByLabelText('Confirmation code')).toHaveLength(1);
    expect(document.querySelectorAll('input[autocomplete="one-time-code"]')).toHaveLength(1);
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

  it('states the 12-hour ownership window wherever an event is being claimed', async () => {
    const eventId = '11111111-2222-4333-8444-555555555555';
    const window = /until its management deadline, or 12 hours after it was created/i;
    vi.stubGlobal('fetch', vi.fn(() => json({ event: EVENT_SUMMARY })));
    render(<RouterProvider router={createAppRouter([
      `/host/register?returnTo=%2Fmanage%2Fevent%2F${eventId}&adopt=${eventId}`,
    ])} />);
    expect(await screen.findByText(window)).toBeVisible();

    cleanup();
    vi.stubGlobal('fetch', vi.fn(() => json(CREATED, 201)));
    render(<RouterProvider router={createAppRouter(['/create'])} />);
    await createEvent(userEvent.setup());
    expect(screen.getByText(window)).toBeVisible();
  });

  // The window is a fact about an event, and the panel's own title is about an
  // event. A registration carrying neither must say neither, or the page promises
  // to save something the host has not got.
  it('says nothing about an event when registration carries none', () => {
    render(<RouterProvider router={createAppRouter(['/host/register'])} />);

    expect(screen.getByRole('heading', { name: 'Create your account' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Save this event to your email' })).not.toBeInTheDocument();
    expect(screen.queryByText(/12 hours after it was created/i)).not.toBeInTheDocument();
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

describe('guest event phase composition', () => {
  const SAVED_HOUSEHOLD = {
    id: 'household-a', label: 'The Morgan household', version: 4, editable: false, renewalRequired: false,
    deadlineAt: '2026-09-05T23:59:59.999Z', invitees: [], firstRespondedAt: '2026-08-01T12:00:00.000Z',
    latestRespondedAt: '2026-08-01T12:00:00.000Z', latestActor: 'household' as const,
  };
  const guestEvent: GuestEventView = {
    id: 'event-a',
    slug: 'maya-theo',
    name: 'Maya & Theo',
    eventDate: '2026-09-19',
    welcomeMessage: 'Come celebrate with us.',
    cover: { revision: 0, hasCover: false, available2xProfiles: [], surfaceTreatment: 'none' },
    uploadsEnabled: true,
    galleryVisible: false,
    moderationRequired: true,
    eventTimezone: 'America/Chicago',
    eventStartAt: '2026-09-19T22:00:00.000Z',
    rsvpDeadlineAt: '2026-09-05T23:59:59.999Z',
    rsvpDeadlineDate: '2026-09-05',
    rsvpState: 'open',
    phase: 'photos-primary',
    // Photos opened before the event did, so the household disclosure survives
    // into that early window. Everything about it is decided here, by the server.
    rsvpAccess: 'editable',
    lifecycleRecheckAfterMs: null,
    theme: resolveEventTheme({ version: 1, presetId: 'candidary-default', overrides: {} }),
  };

  function renderEvent(event = guestEvent) {
    return render(<MemoryRouter initialEntries={[`/event/${event.slug}`]}>
      <Routes><Route path="/event/:slug" element={<EventPage />} /></Routes>
    </MemoryRouter>);
  }

  it('puts RSVP first for the rsvp-primary phase without mounting photo controls', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/api/event/maya-theo')) return json({ event: { ...guestEvent, uploadsEnabled: false, phase: 'rsvp-primary' }, role: 'guest' });
      if (path.endsWith('/rsvp/household')) return errorJson({ code: 'RSVP_SESSION_REQUIRED', message: 'Find your invitation.', requestId: 'r' }, 401);
      throw new Error(`Unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderEvent({ ...guestEvent, uploadsEnabled: false, phase: 'rsvp-primary' });
    await screen.findByRole('button', { name: 'Find my invitation' });
    expect(screen.queryByRole('button', { name: 'Take a photo' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Your name')).not.toBeInTheDocument();
  });

  it('keeps photos first and does not request a household until the open RSVP disclosure is opened', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/api/event/maya-theo')) return json({ event: guestEvent, role: 'guest' });
      if (path.endsWith('/rsvp/household')) return errorJson({ code: 'RSVP_SESSION_REQUIRED', message: 'Find your invitation.', requestId: 'r' }, 401);
      throw new Error(`Unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderEvent();
    await screen.findByRole('button', { name: 'Take a photo' });
    expect(screen.queryByRole('button', { name: 'Find my invitation' })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([input]) => String(input))).not.toContain('/api/event/maya-theo/rsvp/household');

    await user.click(screen.getByText('View or change RSVP'));
    await screen.findByRole('button', { name: 'Find my invitation' });
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toContain('/api/event/maya-theo/rsvp/household');
  });

  it.each(['closed', 'paused'] as const)('offers a secondary saved-response view for %s RSVP without delaying photo controls', async (rsvpState) => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/api/event/maya-theo')) return json({ event: { ...guestEvent, rsvpState, rsvpAccess: 'read-only' }, role: 'guest' });
      if (path.endsWith('/rsvp/household')) return json({ household: SAVED_HOUSEHOLD });
      throw new Error(`Unexpected request ${path}`);
    }));
    const user = userEvent.setup();

    renderEvent({ ...guestEvent, rsvpState, rsvpAccess: 'read-only' });
    await screen.findByRole('button', { name: 'Take a photo' });
    await user.click(screen.getByText('View RSVP'));
    await screen.findByRole('heading', { name: 'Your RSVP' });
    expect(screen.getByRole('button', { name: 'Take a photo' })).toBeVisible();
  });

  /* Photos can open before the event does, so the disclosure survives that early window and
     disappears at the start. The server says which it is; nothing here compares a date. */
  it('keeps the household disclosure through an early opening and drops it at the start', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const earlyOpen = { ...guestEvent, rsvpState: 'closed' as const, rsvpAccess: 'read-only' as const, lifecycleRecheckAfterMs: 60_000 };
    const started = { ...earlyOpen, rsvpAccess: 'unavailable' as const, lifecycleRecheckAfterMs: null };
    let eventReads = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/api/event/maya-theo')) {
        eventReads += 1;
        return json({ event: eventReads === 1 ? earlyOpen : started, role: 'guest' });
      }
      if (path.endsWith('/rsvp/household')) return json({ household: SAVED_HOUSEHOLD });
      throw new Error(`Unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const rsvpRequests = () => fetchMock.mock.calls
      .map(([input]) => String(input))
      .filter((path) => path.includes('/rsvp/'));
    const user = userEvent.setup();

    renderEvent(earlyOpen);
    await screen.findByRole('button', { name: 'Take a photo' });
    await user.click(screen.getByText('View RSVP'));
    await screen.findByRole('heading', { name: 'Your RSVP' });
    const readBeforeStart = rsvpRequests().length;
    expect(readBeforeStart).toBeGreaterThan(0);

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

    // The guest touched nothing. The disclosure is gone with the household window
    // it belonged to, and nothing asked the server for one afterwards.
    expect(screen.queryByText('View RSVP')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Take a photo' })).toBeVisible();
    expect(rsvpRequests()).toHaveLength(readBeforeStart);
  });

  it('ends a guest no-op boundary without entering a retry poll', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const beforeStart = {
      ...guestEvent,
      rsvpState: 'disabled' as const,
      rsvpAccess: 'unavailable' as const,
      lifecycleRecheckAfterMs: 1_000,
    };
    const afterStart = { ...beforeStart, lifecycleRecheckAfterMs: null };
    let eventReads = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/api/event/maya-theo')) {
        eventReads += 1;
        return json({ event: eventReads === 1 ? beforeStart : afterStart, role: 'guest' });
      }
      throw new Error(`Unexpected request ${path}`);
    }));

    renderEvent(beforeStart);
    await screen.findByRole('button', { name: 'Take a photo' });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

    expect(eventReads).toBe(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
    expect(eventReads).toBe(2);
  });

  it('keeps the guest anti-spin floor when wake responses only shorten the relative delay', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const initial = {
      ...guestEvent,
      rsvpState: 'closed' as const,
      rsvpAccess: 'unavailable' as const,
      lifecycleRecheckAfterMs: 60_000,
    };
    let eventReads = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/api/event/maya-theo')) {
        eventReads += 1;
        return json({
          event: eventReads === 1
            ? initial
            : { ...initial, lifecycleRecheckAfterMs: 50_000 },
          role: 'guest',
        });
      }
      throw new Error(`Unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderEvent(initial);
    await screen.findByRole('button', { name: 'Take a photo' });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });

    await act(async () => {
      window.dispatchEvent(new Event('pageshow'));
    });
    await waitFor(() => expect(eventReads).toBe(2));
    // Let the response commit and any delay-keyed effect replacement attach
    // its own wake listeners before the second event.
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    await act(async () => {
      window.dispatchEvent(new Event('pageshow'));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(eventReads).toBe(2);
    expect(screen.getByRole('button', { name: 'Take a photo' })).toBeVisible();
  });

  it('installs a moved guest start boundary when its replacement delay is numerically equal', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const beforeStart = {
      ...guestEvent,
      phase: 'before-start' as const,
      rsvpState: 'closed' as const,
      rsvpAccess: 'unavailable' as const,
      lifecycleRecheckAfterMs: 60_000,
    };
    const movedStart = {
      ...beforeStart,
      eventStartAt: '2026-09-19T23:00:00.000Z',
      lifecycleRecheckAfterMs: 60_000,
    };
    const started = {
      ...movedStart,
      phase: 'photos-primary' as const,
      lifecycleRecheckAfterMs: null,
    };
    let eventReads = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/api/event/maya-theo')) {
        const replies = [beforeStart, movedStart, started] as const;
        const event = replies[Math.min(eventReads, replies.length - 1)]!;
        eventReads += 1;
        return json({ event, role: 'guest' });
      }
      throw new Error(`Unexpected request ${path}`);
    }));
    renderEvent(beforeStart);
    await screen.findByText('Maya & Theo begins September 19, 2026 at 5:00 PM.');
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });

    await act(async () => { window.dispatchEvent(new Event('pageshow')); });

    expect(await screen.findByText('Maya & Theo begins September 19, 2026 at 6:00 PM.')).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(screen.getByRole('button', { name: 'Take a photo' })).toBeVisible();
    expect(eventReads).toBe(3);
  });

  it('installs a moved RSVP deadline boundary and arms its replacement timer', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const rsvpOpen = {
      ...guestEvent,
      uploadsEnabled: false,
      phase: 'rsvp-primary' as const,
      rsvpState: 'open' as const,
      rsvpAccess: 'editable' as const,
      lifecycleRecheckAfterMs: 60_000,
    };
    const movedDeadline = {
      ...rsvpOpen,
      rsvpDeadlineAt: '2026-09-07T04:59:59.999Z',
      rsvpDeadlineDate: '2026-09-06',
      lifecycleRecheckAfterMs: 1_000,
    };
    const closed = {
      ...movedDeadline,
      phase: 'before-start' as const,
      rsvpState: 'closed' as const,
      rsvpAccess: 'read-only' as const,
      lifecycleRecheckAfterMs: null,
    };
    let eventReads = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/api/event/maya-theo')) {
        const replies = [rsvpOpen, movedDeadline, closed] as const;
        const event = replies[Math.min(eventReads, replies.length - 1)]!;
        eventReads += 1;
        return json({ event, role: 'guest' });
      }
      if (path.endsWith('/rsvp/household')) {
        return errorJson({ code: 'RSVP_SESSION_REQUIRED', message: 'Find your invitation.', requestId: 'r' }, 401);
      }
      throw new Error(`Unexpected request ${path}`);
    }));
    renderEvent(rsvpOpen);
    await screen.findByText('Please RSVP by Sep 5, 2026.');
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });

    await act(async () => { window.dispatchEvent(new Event('pageshow')); });

    expect(await screen.findByText('Please RSVP by Sep 6, 2026.')).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.getByRole('heading', { name: "The event hasn't started yet" })).toBeVisible();
    expect(eventReads).toBe(3);
  });

  it('says only that photo delivery is paused once the event has started', async () => {
    const waiting = {
      ...guestEvent,
      uploadsEnabled: false,
      phase: 'waiting' as const,
      rsvpState: 'closed' as const,
      rsvpAccess: 'unavailable' as const,
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/api/event/maya-theo')) return json({ event: waiting, role: 'guest' });
      throw new Error(`Unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderEvent(waiting);
    expect(await screen.findByRole('heading', { level: 1, name: 'Photo delivery is paused' })).toBeVisible();
    expect(screen.getByText('The host has paused photo delivery for now. Please try again later.')).toBeVisible();
    // The hero still names the event, so a guest who rechecked across the start
    // lands on the same product rather than on a different page.
    expect(screen.getByText(/Maya & Theo/, { selector: '.photo-drop__event' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Take a photo' })).not.toBeInTheDocument();
    // RSVP has left the guest experience entirely, so none of it mounts or asks.
    expect(screen.queryByRole('heading', { name: 'Your RSVP' })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([input]) => String(input)).filter((path) => path.includes('/rsvp/'))).toEqual([]);
  });

  it('hides an already-mounted RSVP section with every secondary section after photo delivery', async () => {
    class SuccessfulXmlHttpRequest {
      status = 200;
      upload = new EventTarget();
      private readonly events = new EventTarget();

      open() {}
      setRequestHeader() {}
      addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        this.events.addEventListener(type, listener);
      }
      send() {
        queueMicrotask(() => this.events.dispatchEvent(new Event('load')));
      }
      abort() {
        this.events.dispatchEvent(new Event('abort'));
      }
    }
    vi.stubGlobal('XMLHttpRequest', SuccessfulXmlHttpRequest);
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith('/api/event/maya-theo')) return json({ event: guestEvent, role: 'guest' });
      if (path.endsWith('/rsvp/household')) return errorJson({ code: 'RSVP_SESSION_REQUIRED', message: 'Find your invitation.', requestId: 'r' }, 401);
      if (path.endsWith('/uploads/batch')) {
        const payload = JSON.parse(String(init?.body)) as { files: Array<{ idempotencyKey: string; mimeType: string }> };
        return json({ items: payload.files.map((file) => ({
          idempotencyKey: file.idempotencyKey,
          status: 'accepted',
          media: { id: `media-${file.idempotencyKey}`, mimeType: file.mimeType },
          uploadUrl: `/direct-upload/${file.idempotencyKey}`,
        })) }, 201);
      }
      if (path.includes('/uploads/') && path.endsWith('/finalize')) return json({ media: { uploadState: 'stored' } });
      throw new Error(`Unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderEvent();
    await screen.findByRole('button', { name: 'Take a photo' });
    await user.click(screen.getByText('View or change RSVP'));
    await screen.findByRole('button', { name: 'Find my invitation' });
    await user.type(screen.getByLabelText('Your name'), 'Taylor Morgan');
    fireEvent.change(screen.getByLabelText('Choose recent photos from your library'), {
      target: { files: [new File(['keeper'], 'keeper.jpg', { type: 'image/jpeg' })] },
    });
    await user.click(await screen.findByRole('button', { name: 'Send 1 photo' }));

    await screen.findByRole('heading', { name: 'Your 1 photo was sent.' });
    expect(screen.queryByText('View or change RSVP')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Find my invitation' })).not.toBeInTheDocument();
    expect(screen.queryByText('More from the event')).not.toBeInTheDocument();
  });
});

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode, startTransition, useLayoutEffect, useState } from 'react';
import { createMemoryRouter, MemoryRouter, Route, RouterProvider, Routes, useNavigate, useParams } from 'react-router-dom';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import type * as ManagementLinkModule from '../../src/app/management-link';
import type { ExportView, MediaView } from '../../src/app/types';

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

import {
  DEFAULT_GUESTBOOK_PROMPT,
  MANAGER_BULK_SELECTION_MAX,
  MANAGER_MEDIA_PAGE_SIZE,
  MAX_EVENT_MEDIA,
} from '../../shared/constants';
import type { EventView, GalleryAudienceSummaryView, GuestEventView } from '../../shared/contracts';
import { resolveEventTheme } from '../../shared/event-theme';
import { mediaPreview } from '../../src/app/api';
import { hostSignInHref } from '../../src/app/recovery';
import { createAppRouter } from '../../src/app/router';
import type {
  GalleryAnchor,
  ManagerNavigationIntent,
  RouterHistoryState,
} from '../../src/app/manager-history-state';
import { EventAccountCard } from '../../src/components/EventAccountCard';
import { ManagementLinkRecovery } from '../../src/components/ManagementLinkRecovery';
import { EventPage } from '../../src/pages/EventPage';
import { ManagerPage } from '../../src/pages/ManagerPage';
import {
  ManagerGalleryWorkspace,
  type GalleryAudienceAuthority,
  type ManagerGalleryWorkspaceProps,
} from '../../src/features/gallery/ManagerGalleryWorkspace';
import { ManagerUndoProvider } from '../../src/features/gallery/undo';
import { useManagerResource } from '../../src/features/manager/resources';
import { AUTOSAVE_DEBOUNCE_MS } from '../../src/features/settings/autosave-queue';
import type { GalleryMode } from '../../src/app/manager-location';
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

function ResourceCaptureHarness({ onResult }: { onResult(current: boolean, retired: boolean): void }) {
  const resource = useManagerResource<number>({
    eventId: 'event-a',
    queryKey: 'capture',
    enabled: false,
    fallbackMessage: 'Capture failed.',
    onEscalate: () => {},
    load: async () => 0,
  });
  return <>
    <button type="button" onClick={() => {
      const current = resource.capture();
      const accepted = resource.updateIfCurrent(current, (value) => (value ?? 0) + 1);
      const retired = resource.capture();
      resource.update((value) => (value ?? 0) + 1);
      onResult(accepted, resource.updateIfCurrent(retired, (value) => (value ?? 0) + 1));
    }}>Exercise capture</button>
    <output aria-label="Captured value">{resource.state.value ?? 0}</output>
  </>;
}

function DeferredResourceCaptureHarness() {
  const resource = useManagerResource<number>({
    eventId: 'event-a',
    queryKey: 'capture',
    enabled: false,
    fallbackMessage: 'Capture failed.',
    onEscalate: () => {},
    load: async () => 0,
  });
  return <>
    <button type="button" onClick={() => {
      const capture = resource.capture();
      // This is deliberately deferred. The newer update enters React's queue
      // before React evaluates this functional updater, so accepted work must
      // compose in queue order rather than consult a later ref generation.
      startTransition(() => {
        resource.updateIfCurrent(capture, (value) => (value ?? 0) + 1);
      });
      resource.update((value) => (value ?? 0) + 1);
    }}>Compose deferred capture</button>
    <output aria-label="Deferred captured value">{resource.state.value ?? 0}</output>
  </>;
}

function LayoutReleaseManagerRoute({ onEventBLayout }: { onEventBLayout(): void }) {
  const { eventId } = useParams();
  const navigate = useNavigate();
  useLayoutEffect(() => {
    if (eventId === 'event-b') onEventBLayout();
  }, [eventId, onEventBLayout]);
  return <>
    <button type="button" onClick={() => { void navigate('/manage/event/event-b'); }}>Route to event B</button>
    <ManagerPage />
  </>;
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

  it('creates an event with its Event link readable and its Management link masked', async () => {
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
    expect(screen.getByText(CREATED.eventLink)).toBeInTheDocument();
    expect(screen.queryByText(CREATED.managementLink)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reveal management link' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Copy management link' })).toBeVisible();
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
    // The management credential keeps its own independent, hidden-by-default control.
    expect(document.body.innerHTML).not.toContain(CREATED.managementLink);
    expect(screen.queryByDisplayValue(CREATED.managementLink)).not.toBeInTheDocument();
    expect(screen.getByText('••••••••••••')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('button', { name: 'Reveal management link' }))
      .toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: 'Copy management link' })).toBeVisible();

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
  welcomeMessage: 'We would love to see the day through your eyes.',
  guestbookPrompt: DEFAULT_GUESTBOOK_PROMPT, uploadsEnabled: true,
  cover: { revision: 0, hasCover: false, available2xProfiles: [], surfaceTreatment: 'none' },
  galleryVisible: false, moderationRequired: true, phase: 'photos-primary',
  rsvpState: 'disabled', rsvpAccess: 'unavailable', rsvpDeadlineAt: null, rsvpDeadlineDate: null,
  eventTimezone: 'America/Chicago', eventStartAt: '2026-09-19T22:00:00.000Z',
  lifecycleRecheckAfterMs: null, guestReadSurfaces: { available: true, reason: null },
};
const EMPTY_GUESTBOOK = {
  items: [], nextCursor: null, ownUnshared: [], ownUnsharedCount: 0, ownUnsharedNextCursor: null,
};

describe('guest read surfaces fullscreen and main-page matrix', () => {
  const unavailable = { available: false, reason: 'before-photo-open' } as const;
  const available = { available: true, reason: null } as const;

  it.each([
    ['scheduled pre-boundary unpaused', 'before-start', true, unavailable, false],
    ['scheduled pre-boundary paused', 'before-start', false, unavailable, false],
    ['scheduled early-open unpaused', 'photos-primary', true, available, true],
    ['scheduled early-open paused', 'before-start', false, available, false],
    ['scheduled post-start unpaused', 'photos-primary', true, available, true],
    ['scheduled post-start paused', 'waiting', false, available, false],
    ['legacy RSVP-primary', 'rsvp-primary', false, unavailable, false],
    ['legacy waiting', 'waiting', false, available, false],
    ['legacy photos-primary', 'photos-primary', true, available, true],
  ] as const)(
    'keeps the composer and read panels independent for %s (fullscreen parity matrix)',
    async (_label, phase, uploadsEnabled, guestReadSurfaces, composerVisible) => {
      const event = {
        ...GUEST_EVENT,
        phase,
        uploadsEnabled,
        guestReadSurfaces,
        rsvpState: phase === 'rsvp-primary' ? 'open' as const : 'disabled' as const,
        rsvpAccess: phase === 'rsvp-primary' ? 'editable' as const : 'unavailable' as const,
      };
      vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/api/event/maya-theo')) return json({ event, role: 'guest' });
        if (url.endsWith('/rsvp/household')) {
          return errorJson({
            code: 'RSVP_SESSION_REQUIRED', message: 'Find your invitation.', requestId: 'rsvp-a',
          }, 401);
        }
        throw new Error(`Unexpected request ${url}`);
      }));

      render(<RouterProvider router={createAppRouter(['/event/maya-theo'])} />);
      await waitFor(() => expect(document.querySelector('.guest-shell')).not.toBeNull());

      expect(screen.queryByRole('button', { name: 'Take a photo' }) !== null)
        .toBe(composerVisible);
      expect(screen.queryByText(/Guestbook/, { selector: 'span' }) !== null)
        .toBe(guestReadSurfaces.available);
      expect(screen.queryByText(/My deliveries/, { selector: 'span' }) !== null)
        .toBe(guestReadSurfaces.available);
      expect(screen.queryByText(/Shared gallery/, { selector: 'span' }) !== null)
        .toBe(guestReadSurfaces.available);

      if (phase === 'waiting') {
        expect(screen.getByRole('heading', { name: 'New guest uploads are paused' })).toBeVisible();
        expect(screen.getByText(/new guest uploads for now/i)).toBeVisible();
        expect(document.body.textContent).not.toMatch(/(?:event|gallery|guestbook).*(?:closed|offline)/iu);
      }
    },
  );

  it('keeps the fullscreen shell but makes no Gallery request before read surfaces open', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith('/api/event/maya-theo')) return json({
        event: { ...GUEST_EVENT, galleryVisible: true, guestReadSurfaces: unavailable },
        role: 'guest',
      });
      throw new Error(`Unexpected request ${url}`);
    }));

    render(<RouterProvider router={createAppRouter(['/event/maya-theo/fullscreen'])} />);

    expect(await screen.findByRole('heading', { name: 'Shared gallery · Maya & Theo' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Close full-screen gallery' })).toBeVisible();
    expect(screen.getByText(
      'Shared photos and Guestbook become available when photo sharing opens.',
    )).toBeVisible();
    expect(screen.queryByText('No shared photos yet.')).not.toBeInTheDocument();
    expect(screen.queryByText(/Guestbook/, { selector: 'span' })).not.toBeInTheDocument();
    expect(screen.queryByText(/My deliveries/, { selector: 'span' })).not.toBeInTheDocument();
    expect(requests).toEqual(['/api/event/maya-theo']);
  });

  it('keeps fullscreen Gallery visibility independent after read surfaces open', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith('/api/event/maya-theo')) return json({
        event: { ...GUEST_EVENT, galleryVisible: false, guestReadSurfaces: available },
        role: 'guest',
      });
      throw new Error(`Unexpected request ${url}`);
    }));

    render(<RouterProvider router={createAppRouter(['/event/maya-theo/fullscreen'])} />);

    expect(await screen.findByRole('heading', { name: 'Shared gallery · Maya & Theo' })).toBeVisible();
    expect(screen.getByText('The host is keeping the gallery private.')).toBeVisible();
    expect(screen.queryByText('No shared photos yet.')).not.toBeInTheDocument();
    expect(requests).toEqual(['/api/event/maya-theo']);
  });

  it('uses the fullscreen empty state only after an available Gallery request', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith('/api/event/maya-theo')) return json({
        event: { ...GUEST_EVENT, galleryVisible: true, guestReadSurfaces: available },
        role: 'guest',
      });
      if (url.endsWith('/gallery')) return json({ media: [] });
      throw new Error(`Unexpected request ${url}`);
    }));

    render(<RouterProvider router={createAppRouter(['/event/maya-theo/fullscreen'])} />);

    expect(await screen.findByText('No shared photos yet.')).toBeVisible();
    expect(requests).toEqual(['/api/event/maya-theo', '/api/event/maya-theo/gallery']);
  });

  it('renders fullscreen Gallery items in the same order without duplicating main-page panels', async () => {
    const media = [
      { id: 'media-a', guestName: 'Avery', caption: 'Golden hour', previewAvailable: true },
      { id: 'media-b', guestName: 'Rowan', caption: null, previewAvailable: true },
    ];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/event/maya-theo')) return json({
        event: { ...GUEST_EVENT, galleryVisible: true, guestReadSurfaces: available },
        role: 'guest',
      });
      if (url.endsWith('/gallery')) return json({ media });
      throw new Error(`Unexpected request ${url}`);
    }));

    render(<RouterProvider router={createAppRouter(['/event/maya-theo'])} />);
    await userEvent.setup().click(await screen.findByText(/Shared gallery/, { selector: 'span' }));
    await screen.findByAltText('Golden hour');
    const mainOrder = Array.from(document.querySelectorAll('.photo-grid figcaption span'))
      .map((node) => node.textContent);
    cleanup();

    render(<RouterProvider router={createAppRouter(['/event/maya-theo/fullscreen'])} />);
    await screen.findByAltText('Golden hour');
    const fullscreenOrder = Array.from(document.querySelectorAll('.fullscreen__grid figcaption'))
      .map((node) => node.textContent);
    expect(fullscreenOrder).toEqual(mainOrder);
    expect(fullscreenOrder).toEqual(['Golden hour', 'Shared photo']);
    expect(screen.queryByText(/Guestbook/, { selector: 'span' })).not.toBeInTheDocument();
    expect(screen.queryByText(/My deliveries/, { selector: 'span' })).not.toBeInTheDocument();
  });
});

describe('guest event experience', () => {
  it('uses the canonical event zone calendar date in the upload review header', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/event/maya-theo')) {
        return json({ event: GUEST_EVENT, role: 'guest' });
      }
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<RouterProvider router={createAppRouter(['/event/maya-theo'])} />);
    await screen.findByRole('heading', { name: 'We would love to see the day through your eyes.' });

    await userEvent.setup().type(screen.getByLabelText('Your name'), 'Avery');
    fireEvent.change(screen.getByLabelText('Choose recent photos from your library'), {
      target: { files: [new File(['photo'], 'toast.jpg', { type: 'image/jpeg' })] },
    });

    expect(await screen.findByRole('heading', { name: 'Ready to send' })).toBeVisible();
    expect(screen.getByText(/Maya & Theo/, { selector: '.review-heading p' }))
      .toHaveTextContent('Maya & Theo · Sep 19');
  });

  it('loads the private photo drop first and keeps the gallery and notes secondary', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/event/maya-theo')) return json({ event: { ...GUEST_EVENT, galleryVisible: true }, role: 'guest' });
      // Exactly `GuestGalleryMediaView`. The guest gallery answer carries no original filename,
      // publication status, or storage metadata at all, so the fixture must not either.
      if (url.endsWith('/gallery')) return json({ media: [
        { id: 'media-a', guestName: 'Avery', caption: 'Golden hour', previewAvailable: true },
        { id: 'media-b', guestName: 'Rowan', caption: null, previewAvailable: true },
      ] });
      if (url.endsWith('/contributions')) return json({ media: [] });
      if (url.endsWith('/messages?contract=2')) return json({ ...EMPTY_GUESTBOOK, items: [{
        id: 'note-a', source: 'guest_note', kind: 'message', guestName: 'Sam',
        body: 'To many happy years.', createdAt: '2026-09-19T20:00:00Z', state: 'approved',
        visibility: 'shared', isOwn: false, moderationStatus: 'approved', mediaId: null,
      }] });
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
    /* A photo whose uploader wrote no caption is named for what it is. It used to borrow the
       uploader's device filename — announced to every other guest as the image's alternative text —
       and that filename no longer crosses the boundary at all. */
    expect(screen.getByAltText('Shared photo')).toBeVisible();
    expect(screen.getByText('Shared photo', { selector: 'figcaption span' })).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await user.click(screen.getByText(/Guestbook/, { selector: 'span' }));
    expect(screen.getByText('To many happy years.')).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  /* The other half of the boundary. A filename is the uploader's device talking, so it does not
     reach the shared gallery — but a guest looking at their *own* deliveries is the one person it
     belongs to, and it is how they recognize the photo they just sent. `GuestContributionMediaView`
     carries it, and nothing about storage, bucket, size, or moderation comes with it. */
  it('still shows a guest their own filenames and transfer state under My deliveries', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/event/maya-theo')) return json({ event: GUEST_EVENT, role: 'guest' });
      if (url.endsWith('/contributions')) return json({ media: [
        {
          id: 'mine-a', originalFilename: 'first-dance.jpg', caption: 'First dance',
          uploadState: 'stored', previewAvailable: true, createdAt: '2026-09-19T21:00:00Z',
        },
        {
          id: 'mine-b', originalFilename: 'IMG_4471.HEIC', caption: null,
          uploadState: 'reserved', previewAvailable: false, createdAt: '2026-09-19T21:05:00Z',
        },
      ] });
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<RouterProvider router={createAppRouter(['/event/maya-theo'])} />);
    expect(await screen.findByRole('heading', { name: 'We would love to see the day through your eyes.' })).toBeVisible();

    await userEvent.setup().click(screen.getByText(/My deliveries/, { selector: 'span' }));
    const rows = await screen.findAllByRole('listitem');
    expect(rows.map((row) => row.querySelector('span')?.textContent))
      .toEqual(['first-dance.jpg', 'IMG_4471.HEIC']);
    expect(within(rows[0]!).getByText('Delivered')).toBeVisible();
    expect(within(rows[1]!).getByText('Not delivered')).toBeVisible();
    // The count is the received ones, not everything this device ever started.
    expect(screen.getByText('1 received')).toBeVisible();
    expect(fetchMock.mock.calls.map(([input]) => String(input)))
      .toEqual(['/api/event/maya-theo', '/api/event/maya-theo/contributions']);
  });

  it('names the note field after the event rather than leaving it to a placeholder', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/event/maya-theo')) return json({ event: GUEST_EVENT, role: 'guest' });
      if (url.endsWith('/messages?contract=2')) return json(EMPTY_GUESTBOOK);
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<RouterProvider router={createAppRouter(['/event/maya-theo'])} />);
    expect(await screen.findByRole('heading', { name: 'We would love to see the day through your eyes.' })).toBeVisible();

    await userEvent.setup().click(screen.getByText(/Guestbook/, { selector: 'span' }));
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
      if (url.endsWith('/messages?contract=2')) return json(EMPTY_GUESTBOOK);
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<RouterProvider router={createAppRouter(['/event/maya-theo'])} />);
    expect(await screen.findByRole('heading', { name: 'We would love to see the day through your eyes.' })).toBeVisible();

    const user = userEvent.setup();
    await user.click(screen.getByText(/Guestbook/, { selector: 'span' }));
    const note = await screen.findByRole('textbox', { name: 'Your note for Maya & Theo' });
    await user.type(note, 'What a perfect evening.');
    const send = screen.getByRole('button', { name: 'Send note' });
    await user.click(send);
    const confirm = screen.getByRole('button', { name: 'Confirm and send' });
    await user.click(confirm);
    expect(postCount).toBe(1);

    resolvePost(await json({
      item: {
        id: 'message-a',
        source: 'guest_note',
        kind: 'message',
        guestName: 'Avery',
        body: 'What a perfect evening.',
        state: 'pending',
        visibility: 'author_only',
        isOwn: true,
        moderationStatus: 'pending',
        createdAt: '2026-09-19T20:00:00.000Z',
        mediaId: null,
      },
      replayed: false,
    }, 201));
    expect(await screen.findByText(
      'Safely sent to Maya & Theo.',
    )).toBeVisible();
    expect(note).toHaveValue('');
    expect(screen.getByText('What a perfect evening.')).toBeVisible();
    expect(screen.getByText('Awaiting host review')).toBeVisible();
    expect(screen.getByText('Only this guest session and the hosts can see it until it is shared.')).toBeVisible();
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
          item: {
            id: 'message-a',
            source: 'guest_note',
            kind: 'message',
            guestName: null,
            body: 'Keep these words.',
            state: 'pending',
            visibility: 'author_only',
            isOwn: true,
            moderationStatus: 'pending',
            createdAt: '2026-09-19T20:00:00.000Z',
            mediaId: null,
          },
          replayed: true,
        });
      }
      if (url.endsWith('/messages?contract=2')) return json(EMPTY_GUESTBOOK);
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<RouterProvider router={createAppRouter(['/event/maya-theo'])} />);
    expect(await screen.findByRole('heading', { name: 'We would love to see the day through your eyes.' })).toBeVisible();

    const user = userEvent.setup();
    await user.click(screen.getByText(/Guestbook/, { selector: 'span' }));
    const note = await screen.findByRole('textbox', { name: 'Your note for Maya & Theo' });
    await user.type(note, 'Keep these words.');
    await user.click(screen.getByRole('button', { name: 'Send note' }));
    await user.click(screen.getByRole('button', { name: 'Confirm and send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('was not sent');
    expect(note).toHaveValue('Keep these words.');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(
      'Safely sent to Maya & Theo.',
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
          item: {
            id: 'message-a',
            source: 'guest_note',
            kind: 'message',
            guestName: null,
            body: 'The final words.',
            state: 'pending',
            visibility: 'author_only',
            isOwn: true,
            moderationStatus: 'pending',
            createdAt: '2026-09-19T20:00:00.000Z',
            mediaId: null,
          },
          replayed: false,
        }, 201);
      }
      if (url.endsWith('/messages?contract=2')) return json(EMPTY_GUESTBOOK);
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<RouterProvider router={createAppRouter(['/event/maya-theo'])} />);
    expect(await screen.findByRole('heading', { name: 'We would love to see the day through your eyes.' })).toBeVisible();

    const user = userEvent.setup();
    await user.click(screen.getByText(/Guestbook/, { selector: 'span' }));
    await user.type(
      await screen.findByRole('textbox', { name: 'Your note for Maya & Theo' }),
      'The final words.',
    );
    await user.click(screen.getByRole('button', { name: 'Send note' }));
    await user.click(screen.getByRole('button', { name: 'Confirm and send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('changed after an earlier send attempt');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(
      'Safely sent to Maya & Theo.',
    )).toBeVisible();
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('keeps a note draft when its disclosure is closed and reopened', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/event/maya-theo')) return json({ event: GUEST_EVENT, role: 'guest' });
      if (url.endsWith('/messages?contract=2')) return json(EMPTY_GUESTBOOK);
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<RouterProvider router={createAppRouter(['/event/maya-theo'])} />);
    expect(await screen.findByRole('heading', { name: 'We would love to see the day through your eyes.' })).toBeVisible();

    const user = userEvent.setup();
    const summary = screen.getByText(/Guestbook/, { selector: 'span' });
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
      if (url.endsWith('/messages?contract=2')) {
        reads += 1;
        return reads === 1
          ? errorJson({ code: 'INTERNAL_ERROR', message: 'Notes are unavailable.', requestId: 'r' }, 503)
          : json(EMPTY_GUESTBOOK);
      }
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<RouterProvider router={createAppRouter(['/event/maya-theo'])} />);
    expect(await screen.findByRole('heading', { name: 'We would love to see the day through your eyes.' })).toBeVisible();

    const user = userEvent.setup();
    await user.click(screen.getByText(/Guestbook/, { selector: 'span' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Notes are unavailable.');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No entries have been shared yet.')).toBeVisible();
    expect(reads).toBe(2);
  });
});

const MANAGED_EVENT = {
  id: 'event-a', slug: 'maya-theo', name: 'Maya & Theo', eventDate: '2026-09-19',
  welcomeMessage: 'Welcome.', guestbookPrompt: DEFAULT_GUESTBOOK_PROMPT,
  cover: {
    config: { version: 1, source: { kind: 'none' } }, revision: 0, hasCover: false,
    available2xProfiles: [], surfaceTreatment: 'none', preparation: null,
  },
  uploadsEnabled: true, galleryVisible: true, moderationRequired: true,
  reservedMediaCount: 0, storedMediaCount: 3, reservedBytes: 0, storedBytes: 128,
  recoverableMediaCount: 0, recoverableBytes: 0,
  hostUploadAvailability: { enabled: true, reason: null },
  guestAccessExpiresAt: '2026-10-19T00:00:00Z', managementAccessExpiresAt: '2026-10-19T00:00:00Z',
  managerLinkRevision: 0,
  managerLinkRotationAvailability: { enabled: true, reason: null },
  purgeAfter: '2026-12-19T00:00:00Z', createdAt: '2026-07-29T00:00:00Z', deletedAt: null,
  eventTimezone: 'America/Chicago',
  eventStartAt: '2026-09-19T22:00:00.000Z', eventStartTime: '17:00',
  photosOpen: true, photoIntakeState: 'open', photoIntakeRecheckAfterMs: null,
  rsvpEnabled: false,
  rsvpDeadlineAt: '2026-09-05T04:59:59.999Z', rsvpDeadlineDate: '2026-09-04',
  rsvpRosterVersion: 7,
  theme: resolveEventTheme({ version: 1, presetId: 'candidary-default', overrides: {} }),
} satisfies EventView;

// All ten ladder actions stay named here so a later edit cannot silently drop a
// rung. The non-App rows reuse the focused owning tests named here.
const SAFETY_LADDER_ROWS = [
  { rung: 'reversible', action: 'Pick / unpick a photo', assertedBy: 'tests/ui/album-workspace.test.tsx', status: 'present' },
  { rung: 'reversible', action: 'Publish / hide a photo', assertedBy: 'tests/ui/album-workspace.test.tsx', status: 'present' },
  { rung: 'reversible', action: 'Remove from Album with Undo', assertedBy: 'tests/ui/album-workspace.test.tsx', status: 'present' },
  { rung: 'reversible', action: 'Pause / Resume guest uploads', assertedBy: 'tests/ui/app.test.tsx', status: 'present' },
  { rung: 'consequential', action: 'Stop the Album link', assertedBy: 'tests/ui/album-workspace.test.tsx', status: 'present' },
  { rung: 'consequential', action: 'Rotate the Manager link', assertedBy: 'tests/ui/app.test.tsx', status: 'present' },
  { rung: 'consequential', action: 'Move an original to Recently deleted', assertedBy: 'tests/ui/manager-recovery.test.tsx', status: 'present' },
  { rung: 'broad or catastrophic', action: 'Disable the printed entry', assertedBy: 'tests/ui/app.test.tsx', status: 'present' },
  { rung: 'broad or catastrophic', action: 'Sign out all guest devices', assertedBy: 'tests/ui/app.test.tsx', status: 'present' },
  { rung: 'broad or catastrophic', action: 'Delete event', assertedBy: 'tests/ui/app.test.tsx', status: 'present' },
] as const;

type SafetyLadderAction = (typeof SAFETY_LADDER_ROWS)[number]['action'];

const BROAD_SAFETY_ACTION_UI: Partial<Record<SafetyLadderAction, {
  section: 'Share' | 'Settings';
  trigger: string;
  confirmation: string;
  method: 'POST' | 'DELETE';
  path: string;
  bodyKey: 'confirmName' | 'confirmation';
}>> = {
  'Disable the printed entry': {
    section: 'Share',
    trigger: 'Disable printed event QR',
    confirmation: 'Disable printed event QR',
    method: 'POST',
    path: '/api/manage/events/event-a/entry/disable',
    bodyKey: 'confirmName',
  },
  'Sign out all guest devices': {
    section: 'Share',
    trigger: 'Sign out guest devices',
    confirmation: 'Sign out guest devices',
    method: 'POST',
    path: '/api/manage/events/event-a/guest-sessions/rotate',
    bodyKey: 'confirmName',
  },
  'Delete event': {
    section: 'Settings',
    trigger: 'Delete event',
    confirmation: 'Delete event',
    method: 'DELETE',
    path: '/api/manage/events/event-a',
    bodyKey: 'confirmation',
  },
};

const EMPTY_GALLERY_AUDIENCE_SUMMARY = {
  albumPhotoCount: 0,
  albumEntryCount: 0,
  albumLink: { active: false, sharedAt: null },
  guestGalleryVisible: true,
  guestGalleryPublishedCount: 0,
} satisfies GalleryAudienceSummaryView;

function galleryAudienceSummaryJson() {
  return json({ summary: EMPTY_GALLERY_AUDIENCE_SUMMARY });
}

function directGalleryAudienceAuthority(): GalleryAudienceAuthority {
  return {
    summary: EMPTY_GALLERY_AUDIENCE_SUMMARY,
    freshness: 'fresh',
    failure: null,
    reload: async () => {},
    invalidate: () => {},
  };
}

function ManagerGalleryWorkspaceWithUndo(
  props: Omit<ManagerGalleryWorkspaceProps, 'mode' | 'onModeChange'>,
) {
  const [mode, setMode] = useState<GalleryMode>('library');
  return <ManagerUndoProvider eventId={props.eventId}>
    <ManagerGalleryWorkspace {...props} mode={mode} onModeChange={setMode} />
  </ManagerUndoProvider>;
}

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
    if (url.endsWith('/guestbook/summary')) return json({ summary: {
      needsReviewCount: 0, sharedCount: 0, hiddenCount: 0, deletedCount: 0, galleryVisible: true,
    } });
    if (url.endsWith('/gallery/summary')) return galleryAudienceSummaryJson();
    if (url.includes('/media')) {
      mediaRequests.push(url);
      const cursor = new URL(url, 'https://candidary.test').searchParams.get('cursor') ?? 'first';
      return json(pages[cursor] ?? { media: [], nextCursor: null });
    }
    if (url.includes('/gallery')) return json({ media: [], nextCursor: null });
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

const ROTATED_MANAGEMENT_LINK = 'https://example.test/manage/replacement-id.replacement-secret';

interface RotationRequestRecord {
  method: string;
  path: string;
  body: string | null;
}

function managerRotationFetch(options: {
  event?: EventView;
  hostSession?: 'saved' | 'none';
  eventForRead?: (read: number) => EventView;
  rotate?: (request: number, body: Record<string, unknown>) => Promise<Response>;
  gallerySummary?: (read: number) => Promise<Response>;
} = {}) {
  const event = options.event ?? MANAGED_EVENT;
  const calls: RotationRequestRecord[] = [];
  let eventReads = 0;
  let rotationRequests = 0;
  let gallerySummaryReads = 0;
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = String(init?.method ?? 'GET').toUpperCase();
    calls.push({ method, path: `${url.pathname}${url.search}`, body: init?.body ? String(init.body) : null });

    if (url.pathname === '/api/manage/events/event-a/links/manager/rotate' && method === 'POST') {
      rotationRequests += 1;
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return options.rotate?.(rotationRequests, body) ?? json({
        managementLink: ROTATED_MANAGEMENT_LINK,
        managerLinkRevision: 1,
      });
    }
    if (url.pathname === '/api/manage/events/event-a' && method === 'GET') {
      eventReads += 1;
      return json({ event: options.eventForRead?.(eventReads) ?? event });
    }
    if (url.pathname === '/api/manage/events/event-a/gallery/summary') {
      gallerySummaryReads += 1;
      return options.gallerySummary?.(gallerySummaryReads) ?? galleryAudienceSummaryJson();
    }
    if (url.pathname === '/api/manage/events/event-a/media') {
      return json({ media: makeMedia(2).slice(1), nextCursor: null });
    }
    if (url.pathname === '/api/manage/events/event-a/guestbook/summary') {
      return json({ summary: {
        needsReviewCount: 0,
        sharedCount: 0,
        hiddenCount: 0,
        deletedCount: 0,
        galleryVisible: true,
      } });
    }
    if (url.pathname === '/api/manage/events/event-a/exports') return json({ exports: [] });
    if (url.pathname === '/api/manage/events/event-a/entry') {
      return json({ eventLink: 'https://example.test/join#entry-id.entry-secret', disabledAt: null });
    }
    if (url.pathname === '/api/host/session') {
      return options.hostSession === 'none'
        ? errorJson({ code: 'AUTH_REQUIRED', message: 'Sign in required.', requestId: 'request-host' }, 401)
        : json({
            account: { id: 'account-a', email: 'host@example.test' },
            events: [{ id: 'event-a' }],
          });
    }
    throw new Error(`Unexpected request ${method} ${url.pathname}${url.search}`);
  });
  return { calls, fetchMock };
}

function managerLocationFetch() {
  const base = managerFetch({ first: { media: [], nextCursor: null } });
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.endsWith('/album/share') && method === 'GET') return json({ share: null });
    if (url.endsWith('/album') && method === 'GET') return json({ album: {
      revision: 0,
      saved: true,
      title: 'Album',
      description: '',
      coverMediaId: null,
      effectiveCoverMediaId: null,
      entries: [],
      photoCount: 0,
      sectionCount: 0,
      totalBytes: 0,
    } });
    return base(input);
  });
}

function managerHistoryFetch(
  library: MediaView[],
  guestGallery: MediaView[],
  galleryRequests: string[] = [],
) {
  const base = managerLocationFetch();
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET' && url.includes('/gallery?')) {
      galleryRequests.push(url);
      return json({ media: library, nextCursor: null });
    }
    if (method === 'GET' && url.includes('/media?')) {
      return json({ media: guestGallery, nextCursor: null });
    }
    return base(input, init);
  });
}

function historyMedia(ids: string[], publicationStatus: MediaView['publicationStatus'] = 'published') {
  return makeMedia(ids.length, publicationStatus).map((item, index) => ({
    ...item,
    id: ids[index]!,
    previewAvailable: true,
    receivedAt: item.createdAt,
    timelineAt: item.createdAt,
    timelineSource: 'received' as const,
    isFavorite: false,
  }));
}

function guestGallerySettingsFetch(options: { deferSettings?: boolean } = {}) {
  const event = { ...MANAGED_EVENT, galleryVisible: false };
  const hiddenRow = historyMedia(['guest-settings-hidden'], 'hidden')[0]!;
  const base = managerLocationFetch();
  let releaseGate!: () => void;
  const settingsGate = new Promise<void>((resolve) => { releaseGate = resolve; });
  let markSettingsStarted!: () => void;
  const settingsStarted = new Promise<void>((resolve) => { markSettingsStarted = resolve; });
  let started = false;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'https://candidary.test');
    const method = String(init?.method ?? 'GET').toUpperCase();
    if (url.pathname === `/api/manage/events/${MANAGED_EVENT.id}` && method === 'GET') {
      return json({ event });
    }
    if (url.pathname === `/api/manage/events/${MANAGED_EVENT.id}/gallery/summary` && method === 'GET') {
      return json({ summary: {
        ...EMPTY_GALLERY_AUDIENCE_SUMMARY,
        guestGalleryVisible: false,
      } });
    }
    if (url.pathname === `/api/manage/events/${MANAGED_EVENT.id}/media` && method === 'GET') {
      const requestedStatus = url.searchParams.get('status');
      return json({
        media: requestedStatus === null || requestedStatus === 'hidden' ? [hiddenRow] : [],
        nextCursor: null,
      });
    }
    if (url.pathname === `/api/manage/events/${MANAGED_EVENT.id}/settings` && method === 'PATCH') {
      if (!started) {
        started = true;
        markSettingsStarted();
      }
      if (options.deferSettings) await settingsGate;
      const payload = JSON.parse(String(init?.body)) as Partial<EventView>;
      return json({ event: { ...event, ...payload } });
    }
    return base(input, init);
  });
  return {
    fetchMock,
    hiddenRow,
    settingsStarted,
    releaseSettings: releaseGate,
  };
}

function historyRect(top: number, height = 40): DOMRect {
  return {
    top,
    bottom: top + height,
    left: 0,
    right: 0,
    width: 0,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}

function trackWindowScroll(setScrollY: (top: number) => void) {
  function implementation(options?: ScrollToOptions): void;
  function implementation(x: number, y: number): void;
  function implementation(optionsOrX?: ScrollToOptions | number, y?: number) {
    const top = typeof optionsOrX === 'number' ? y : optionsOrX?.top;
    if (top !== undefined) setScrollY(top);
  }
  return vi.spyOn(window, 'scrollTo').mockImplementation(implementation);
}

function installHistoryAnchorRects(
  rootSelector: string,
  documentTops: Record<string, number>,
  readScrollY: () => number,
) {
  const root = document.querySelector<HTMLElement>(rootSelector)!;
  for (const [id, documentTop] of Object.entries(documentTops)) {
    const item = root.querySelector<HTMLElement>(`[data-gallery-anchor-id="${id}"]`)!;
    vi.spyOn(item, 'getBoundingClientRect').mockImplementation(() => (
      historyRect(documentTop - readScrollY())
    ));
  }
}

function managerHistoryState(anchor: GalleryAnchor, mode: GalleryMode): RouterHistoryState {
  return {
    __candidaryManager: {
      version: 1,
      eventId: MANAGED_EVENT.id,
      anchors: { [mode]: anchor },
    },
  };
}

function managerIntentState(
  intent: ManagerNavigationIntent,
  eventId = MANAGED_EVENT.id,
): RouterHistoryState {
  return {
    source: 'task-4-test',
    __candidaryManager: { version: 1, eventId, intent },
  };
}

function exportJobFixture(
  kind: ExportView['kind'],
  state: ExportView['state'],
): ExportView {
  const terminal = state === 'ready' || state === 'failed' || state === 'expired';
  return {
    id: `${kind}-${state}`,
    kind,
    state,
    snapshotAt: '2026-09-20T00:00:00.000Z',
    createdAt: '2026-09-20T00:00:01.000Z',
    startedAt: state === 'queued' ? null : '2026-09-20T00:00:02.000Z',
    completedAt: terminal ? '2026-09-20T00:00:03.000Z' : null,
    mediaCount: 3,
    totalBytes: 1_024,
    processedMediaCount: state === 'queued' ? null : state === 'running' ? 1 : 3,
    processedBytes: state === 'queued' ? null : state === 'running' ? 256 : 1_024,
    progressUpdatedAt: state === 'queued' ? null : '2026-09-20T00:00:02.500Z',
    attempt: 1,
    partCount: state === 'ready' ? 1 : 0,
    expiresAt: state === 'ready' ? '2026-09-21T00:00:03.000Z' : null,
    guestbookEntryCount: kind === 'complete' ? 0 : null,
    guestbookSharedCount: kind === 'complete' ? 0 : null,
    guestbookEventName: kind === 'complete' ? 'Maya & Theo' : null,
    guestbookEventDate: kind === 'complete' ? '2026-09-19' : null,
    guestbookEventTimezone: kind === 'complete' ? 'America/Chicago' : null,
    guestbookPrompt: kind === 'complete' ? DEFAULT_GUESTBOOK_PROMPT : null,
    guestbookGalleryVisible: kind === 'complete' ? true : null,
    errorCode: state === 'failed' ? 'EXPORT_FAILED' : null,
  };
}

function deferredAlbumSaveFetch() {
  const base = managerLocationFetch();
  let release: (() => void) | null = null;
  let revision = 0;
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.endsWith('/album') && method === 'PUT') {
      const body = JSON.parse(String(init?.body));
      return new Promise<Response>((resolve) => {
        release = () => {
          revision += 1;
          void json({ album: {
            revision,
            saved: true,
            ...body.metadata,
            effectiveCoverMediaId: null,
            entries: [],
            photoCount: 0,
            sectionCount: 0,
            totalBytes: 0,
          } }).then(resolve);
        };
      });
    }
    return base(input, init);
  });
  return {
    fetchMock,
    hasPendingSave: () => release !== null,
    releaseSave: () => {
      if (!release) throw new Error('Album save has not started.');
      const current = release;
      release = null;
      current();
    },
  };
}

describe('canonical Manager location ownership', () => {
  it.each([
    [`/manage/event/${MANAGED_EVENT.id}`, 'Intake', null, ''],
    [`/manage/event/${MANAGED_EVENT.id}?section=intake`, 'Intake', null, ''],
    [`/manage/event/${MANAGED_EVENT.id}?section=rsvp`, 'RSVP', null, '?section=rsvp'],
    [`/manage/event/${MANAGED_EVENT.id}?section=gallery`, 'Gallery', 'Library', '?section=gallery'],
    [`/manage/event/${MANAGED_EVENT.id}?section=gallery&mode=album`, 'Gallery', 'Album', '?section=gallery&mode=album'],
    [`/manage/event/${MANAGED_EVENT.id}?section=gallery&mode=guest-gallery`, 'Gallery', 'Guest gallery', '?section=gallery&mode=guest-gallery'],
    [`/manage/event/${MANAGED_EVENT.id}?section=guestbook`, 'Guestbook', null, '?section=guestbook'],
    [`/manage/event/${MANAGED_EVENT.id}?section=share`, 'Share', null, '?section=share'],
    [`/manage/event/${MANAGED_EVENT.id}?section=settings`, 'Settings', null, '?section=settings'],
  ] as const)(
    'renders the canonical Manager location %s as %s / %s',
    async (entry, sectionLabel, modeLabel, canonicalSearch) => {
      vi.stubGlobal('fetch', managerLocationFetch());
      const router = createAppRouter([entry]);
      render(<RouterProvider router={router} />);

      const managerNavigation = await screen.findByRole('navigation', { name: 'Manager sections' });
      expect(within(managerNavigation).getByText(sectionLabel).closest('button'))
        .toHaveAttribute('aria-pressed', 'true');
      if (modeLabel) {
        expect(within(await screen.findByRole('group', { name: 'Gallery mode' }))
          .getByRole('button', { name: modeLabel }))
          .toHaveAttribute('aria-pressed', 'true');
      }
      await waitFor(() => expect(router.state.location.search).toBe(canonicalSearch));
    },
  );

  it.each([
    [`/manage/event/${MANAGED_EVENT.id}?section=gallery&section=share`, 'Intake', null, ''],
    [`/manage/event/${MANAGED_EVENT.id}?section=rsvp&mode=album`, 'RSVP', null, '?section=rsvp'],
    [`/manage/event/${MANAGED_EVENT.id}?section=gallery&mode=shared`, 'Gallery', 'Guest gallery', '?section=gallery&mode=guest-gallery'],
    [`/manage/event/${MANAGED_EVENT.id}?section=share&unknown=value`, 'Share', null, '?section=share'],
  ] as const)(
    'replaces malformed canonical Manager location %s with %s / %s',
    async (entry, sectionLabel, modeLabel, canonicalSearch) => {
      vi.stubGlobal('fetch', managerLocationFetch());
      const router = createAppRouter([entry]);
      render(<RouterProvider router={router} />);

      const managerNavigation = await screen.findByRole('navigation', { name: 'Manager sections' });
      expect(within(managerNavigation).getByText(sectionLabel).closest('button'))
        .toHaveAttribute('aria-pressed', 'true');
      if (modeLabel) {
        expect(within(await screen.findByRole('group', { name: 'Gallery mode' }))
          .getByRole('button', { name: modeLabel }))
          .toHaveAttribute('aria-pressed', 'true');
      }
      await waitFor(() => expect(router.state.location.search).toBe(canonicalSearch));
    },
  );

  it('preserves pathname, hash, and Router state while replacing a canonical Manager location', async () => {
    const state = { source: 'canonical-location-test' };
    vi.stubGlobal('fetch', managerLocationFetch());
    const router = createAppRouter([{
      pathname: `/manage/event/${MANAGED_EVENT.id}`,
      search: '?section=intake',
      hash: '#retained-fragment',
      state,
    }]);
    render(<RouterProvider router={router} />);
    await screen.findByRole('navigation', { name: 'Manager sections' });

    await waitFor(() => expect(router.state.location.search).toBe(''));
    expect(router.state.location.pathname).toBe(`/manage/event/${MANAGED_EVENT.id}`);
    expect(router.state.location.hash).toBe('#retained-fragment');
    expect(router.state.location.state).toEqual(state);
  });

  it('traverses Manager work in history through Album, Library, and Intake', async () => {
    vi.stubGlobal('fetch', managerLocationFetch());
    const router = createAppRouter([`/manage/event/${MANAGED_EVENT.id}`]);
    render(<RouterProvider router={router} />);
    const user = userEvent.setup();
    const managerNavigation = await screen.findByRole('navigation', { name: 'Manager sections' });

    await user.click(within(managerNavigation).getByText('Gallery').closest('button')!);
    await waitFor(() => expect(router.state.location.search).toBe('?section=gallery'));
    await user.click(within(await screen.findByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: 'Album' }));
    await waitFor(() => expect(router.state.location.search).toBe('?section=gallery&mode=album'));

    await router.navigate(-1);
    await waitFor(() => expect(router.state.location.search).toBe('?section=gallery'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Library' }))
      .toHaveAttribute('aria-pressed', 'true'));
    await router.navigate(-1);
    await waitFor(() => expect(router.state.location.search).toBe(''));
    await waitFor(() => expect(within(managerNavigation).getByText('Intake').closest('button'))
      .toHaveAttribute('aria-pressed', 'true'));
  });

  it.each([
    ['Gallery mode', '?section=gallery', 'Library'],
    ['Manager section', '?section=share', 'Share your event'],
    ['browser Back', '?section=gallery', 'Library'],
  ] as const)(
    'keeps Album rendered until URL settlement for a %s request',
    async (requestSource, expectedSearch, expectedContent) => {
      const deferred = deferredAlbumSaveFetch();
      vi.stubGlobal('fetch', deferred.fetchMock);
      const albumEntry = `/manage/event/${MANAGED_EVENT.id}?section=gallery&mode=album`;
      const router = createAppRouter(requestSource === 'browser Back'
        ? [`/manage/event/${MANAGED_EVENT.id}?section=gallery`, albumEntry]
        : [albumEntry]);
      render(<RouterProvider router={router} />);
      const user = userEvent.setup();
      const managerNavigation = await screen.findByRole('navigation', { name: 'Manager sections' });
      const title = await screen.findByLabelText('Album title');

      fireEvent.change(title, { target: { value: `Leaving by ${requestSource}` } });
      if (requestSource === 'Gallery mode') {
        await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
          .getByRole('button', { name: 'Library' }));
      } else if (requestSource === 'Manager section') {
        await user.click(within(managerNavigation).getByText('Share').closest('button')!);
      } else {
        void router.navigate(-1);
      }

      await waitFor(() => expect(deferred.hasPendingSave()).toBe(true));
      expect(router.state.location.search).toBe('?section=gallery&mode=album');
      expect(screen.getByLabelText('Album title')).toBeVisible();
      expect(screen.getByRole('button', { name: 'Album' })).toHaveAttribute('aria-pressed', 'true');

      await act(async () => { deferred.releaseSave(); });
      await waitFor(() => expect(router.state.location.search).toBe(expectedSearch));
      if (requestSource === 'Manager section') {
        expect(await screen.findByRole('heading', { name: expectedContent })).toBeVisible();
      } else {
        expect(screen.getByRole('button', { name: expectedContent }))
          .toHaveAttribute('aria-pressed', 'true');
      }

      if (requestSource !== 'browser Back') {
        await router.navigate(-1);
        await waitFor(() => expect(router.state.location.search)
          .toBe('?section=gallery&mode=album'));
        expect(await screen.findByLabelText('Album title')).toBeVisible();
      }
    },
  );

  it('keeps Album rendered until URL settlement for a clean browser Back check', async () => {
    vi.stubGlobal('fetch', managerLocationFetch());
    const router = createAppRouter([
      `/manage/event/${MANAGED_EVENT.id}?section=gallery`,
      `/manage/event/${MANAGED_EVENT.id}?section=gallery&mode=album`,
    ]);
    render(<RouterProvider router={router} />);
    await screen.findByLabelText('Album title');

    const navigation = router.navigate(-1);
    expect(router.state.location.search).toBe('?section=gallery&mode=album');
    expect(screen.getByRole('button', { name: 'Album' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('region', { name: 'Album changes are not saved yet' }))
      .not.toBeInTheDocument();

    await navigation;
    await waitFor(() => expect(router.state.location.search).toBe('?section=gallery'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Library' }))
      .toHaveAttribute('aria-pressed', 'true'));
  });

  it('captures a Library anchor before Guest gallery and restores it after Back', async () => {
    const library = historyMedia(Array.from({ length: 30 }, (_, index) => `p${index + 1}`));
    vi.stubGlobal('fetch', managerHistoryFetch(library, historyMedia(['guest-1'], 'unpublished')));
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));
    let scrollY = 600;
    vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => scrollY);
    trackWindowScroll((top) => { scrollY = top; });
    const router = createAppRouter([`/manage/event/${MANAGED_EVENT.id}?section=gallery`]);
    render(<RouterProvider router={router} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Show more photos' }));
    await waitFor(() => expect(document.querySelectorAll('.gallery-private [data-gallery-anchor-id]'))
      .toHaveLength(library.length));
    vi.spyOn(document.querySelector<HTMLElement>('.manager-nav')!, 'getBoundingClientRect')
      .mockReturnValue(historyRect(0, 100));
    const documentTops = Object.fromEntries(library.map(({ id }, index) => [
      id,
      index < 20 ? 400 + index * 4 : 780 + (index - 20) * 40,
    ]));
    installHistoryAnchorRects('.gallery-private', documentTops, () => scrollY);
    const tile = document.querySelector<HTMLElement>('[data-photo-id="p21"]')!;
    const effectiveTop = () => Math.max(
      0,
      document.querySelector<HTMLElement>('.manager-nav')!.getBoundingClientRect().bottom,
    );
    const before = tile.getBoundingClientRect().top - effectiveTop();

    await user.click(screen.getByRole('button', { name: 'Guest gallery' }));
    await waitFor(() => expect(router.state.location.search)
      .toBe('?section=gallery&mode=guest-gallery'));
    expect((router.state.location.state as RouterHistoryState)
      .__candidaryManager?.anchors?.library).toMatchObject({ kind: 'media', mediaId: 'p21' });
    await waitFor(() => expect(frames.length).toBeGreaterThan(0));
    act(() => { frames.shift()?.(0); });
    expect(scrollY).toBe(0);

    await router.navigate(-1);
    await waitFor(() => expect(router.state.location.search).toBe('?section=gallery'));
    await waitFor(() => expect(frames.length).toBeGreaterThan(0));
    act(() => { frames.shift()?.(0); });
    expect(tile.getBoundingClientRect().top - effectiveTop()).toBe(before);
  });

  it('waits for a delayed Library return before restoring a cross-section Back anchor', async () => {
    const library = historyMedia(['library-return']);
    let releaseLibrary!: () => void;
    const libraryGate = new Promise<void>((resolve) => { releaseLibrary = resolve; });
    let libraryGets = 0;
    const base = managerLocationFetch();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (method === 'GET' && url.includes('/gallery?')) {
        libraryGets += 1;
        await libraryGate;
        return json({ media: library, nextCursor: null });
      }
      return base(input, init);
    }));
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));
    let scrollY = 400;
    vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => scrollY);
    const scrollTo = trackWindowScroll((top) => { scrollY = top; });
    const anchor: GalleryAnchor = {
      kind: 'media',
      mediaId: 'library-return',
      viewportOffset: 30,
      fallbackScrollY: 700,
      before: [],
      after: [],
    };
    const router = createAppRouter([{
      pathname: `/manage/event/${MANAGED_EVENT.id}`,
      search: '?section=gallery',
      state: managerHistoryState(anchor, 'library'),
    }, `/manage/event/${MANAGED_EVENT.id}?section=share`]);
    render(<RouterProvider router={router} />);
    await screen.findByRole('heading', { name: 'Share your event' });

    await router.navigate(-1);
    await waitFor(() => expect(router.state.location.search).toBe('?section=gallery'));
    await waitFor(() => expect(frames.length).toBeGreaterThan(0));
    act(() => { frames.shift()?.(0); });
    expect(scrollTo).not.toHaveBeenCalled();
    expect(libraryGets).toBe(1);

    await act(async () => { releaseLibrary(); });
    await waitFor(() => expect(document.querySelectorAll('.gallery-private [data-gallery-anchor-id]'))
      .toHaveLength(1));
    vi.spyOn(document.querySelector<HTMLElement>('.manager-nav')!, 'getBoundingClientRect')
      .mockReturnValue(historyRect(0, 100));
    installHistoryAnchorRects('.gallery-private', { 'library-return': 700 }, () => scrollY);
    await waitFor(() => expect(frames.length).toBeGreaterThan(0));
    act(() => { frames.shift()?.(0); });

    expect(scrollTo).toHaveBeenLastCalledWith({ top: 570, behavior: 'instant' });
    expect(libraryGets).toBe(1);
  });

  it('waits for a delayed Album return before restoring its Back anchor', async () => {
    const albumPhoto = historyMedia(['album-return'])[0]!;
    let releaseAlbum!: () => void;
    const albumGate = new Promise<void>((resolve) => { releaseAlbum = resolve; });
    let albumGets = 0;
    const base = managerLocationFetch();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/album') && method === 'GET') {
        albumGets += 1;
        await albumGate;
        return json({ album: {
          revision: 1,
          saved: true,
          title: 'Album',
          description: '',
          coverMediaId: null,
          effectiveCoverMediaId: null,
          entries: [{ kind: 'photo', photo: albumPhoto }],
          photoCount: 1,
          sectionCount: 0,
          totalBytes: 0,
        } });
      }
      return base(input, init);
    }));
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));
    let scrollY = 450;
    vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => scrollY);
    const scrollTo = trackWindowScroll((top) => { scrollY = top; });
    const anchor: GalleryAnchor = {
      kind: 'album-entry',
      entryId: 'photo:album-return',
      viewportOffset: 40,
      fallbackScrollY: 760,
      before: [],
      after: [],
    };
    const router = createAppRouter([{
      pathname: `/manage/event/${MANAGED_EVENT.id}`,
      search: '?section=gallery&mode=album',
      state: managerHistoryState(anchor, 'album'),
    }, `/manage/event/${MANAGED_EVENT.id}?section=share`]);
    render(<RouterProvider router={router} />);
    await screen.findByRole('heading', { name: 'Share your event' });

    await router.navigate(-1);
    await waitFor(() => expect(router.state.location.search).toBe('?section=gallery&mode=album'));
    await waitFor(() => expect(frames.length).toBeGreaterThan(0));
    act(() => { frames.shift()?.(0); });
    expect(scrollTo).not.toHaveBeenCalled();
    expect(albumGets).toBe(1);

    await act(async () => { releaseAlbum(); });
    await waitFor(() => expect(document.querySelector(
      '[data-gallery-anchor-id="photo:album-return"]',
    )).not.toBeNull());
    const row = document.querySelector<HTMLElement>(
      '[data-gallery-anchor-id="photo:album-return"]',
    )!;
    vi.spyOn(document.querySelector<HTMLElement>('.manager-nav')!, 'getBoundingClientRect')
      .mockReturnValue(historyRect(0, 100));
    vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => historyRect(820 - scrollY));
    await waitFor(() => expect(frames.length).toBeGreaterThan(0));
    act(() => { frames.shift()?.(0); });

    expect(scrollTo).toHaveBeenLastCalledWith({ top: 680, behavior: 'instant' });
    expect(albumGets).toBe(1);
  });

  it('clears a pending delayed restoration before a later ready signal', async () => {
    const library = historyMedia(['stale-library']);
    const guest = historyMedia(['guest-current'], 'unpublished');
    let releaseLibrary!: () => void;
    const libraryGate = new Promise<void>((resolve) => { releaseLibrary = resolve; });
    let libraryGets = 0;
    const base = managerHistoryFetch([], guest);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (method === 'GET' && url.includes('/gallery?')) {
        libraryGets += 1;
        await libraryGate;
        return json({ media: library, nextCursor: null });
      }
      return base(input, init);
    }));
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));
    let scrollY = 400;
    vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => scrollY);
    const scrollTo = trackWindowScroll((top) => { scrollY = top; });
    const anchor: GalleryAnchor = {
      kind: 'media',
      mediaId: 'stale-library',
      viewportOffset: 20,
      fallbackScrollY: 700,
      before: [],
      after: [],
    };
    const guestPath = `/manage/event/${MANAGED_EVENT.id}?section=gallery&mode=guest-gallery`;
    const router = createAppRouter([{
      pathname: `/manage/event/${MANAGED_EVENT.id}`,
      search: '?section=gallery',
      state: managerHistoryState(anchor, 'library'),
    }, guestPath]);
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(document.querySelectorAll('.gallery-shared [data-gallery-anchor-id]'))
      .toHaveLength(1));
    await waitFor(() => expect(libraryGets).toBe(1));

    await router.navigate(-1);
    await waitFor(() => expect(router.state.location.search).toBe('?section=gallery'));
    await waitFor(() => expect(frames.length).toBeGreaterThan(0));
    act(() => { frames.shift()?.(0); });
    expect(scrollTo).not.toHaveBeenCalled();

    await router.navigate(1);
    await waitFor(() => expect(router.state.location.search)
      .toBe('?section=gallery&mode=guest-gallery'));
    await waitFor(() => expect(frames.length).toBeGreaterThan(0));
    scrollY = 0;
    act(() => { frames.shift()?.(0); });
    expect(frames).toHaveLength(0);

    await act(async () => { releaseLibrary(); });
    await waitFor(() => expect(document.querySelectorAll('.gallery-private [data-gallery-anchor-id]'))
      .toHaveLength(1));
    expect(frames).toHaveLength(0);

    await router.navigate(-1);
    await waitFor(() => expect(router.state.location.search).toBe('?section=gallery'));
    await waitFor(() => expect(frames.length).toBeGreaterThan(0));
    expect(frames).toHaveLength(1);
    act(() => { frames.shift()?.(0); });

    expect(scrollTo).not.toHaveBeenCalled();
    expect(libraryGets).toBe(1);
  });

  it('uses nearby rendered IDs then clamped scroll without fetching', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));
    let scrollY = 300;
    vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => scrollY);
    const scrollTo = trackWindowScroll((top) => { scrollY = top; });
    vi.spyOn(document.documentElement, 'scrollHeight', 'get').mockReturnValue(900);
    vi.spyOn(document.body, 'scrollHeight', 'get').mockReturnValue(800);
    vi.stubGlobal('innerHeight', 300);

    const candidateAnchor: GalleryAnchor = {
      kind: 'media', mediaId: 'missing', viewportOffset: 25, fallbackScrollY: 1200,
      before: ['before-first', 'before-second'], after: ['after-missing', 'after-second'],
    };
    const candidateRequests: string[] = [];
    vi.stubGlobal('fetch', managerHistoryFetch(
      historyMedia(['before-first', 'after-second']),
      [],
      candidateRequests,
    ));
    const guestPath = `/manage/event/${MANAGED_EVENT.id}?section=gallery&mode=guest-gallery`;
    const candidateRouter = createAppRouter([{
      pathname: `/manage/event/${MANAGED_EVENT.id}`,
      search: '?section=gallery',
      state: managerHistoryState(candidateAnchor, 'library'),
    }, guestPath]);
    const candidateView = render(<RouterProvider router={candidateRouter} />);
    await waitFor(() => expect(document.querySelectorAll('.gallery-private [data-gallery-anchor-id]'))
      .toHaveLength(2));
    vi.spyOn(document.querySelector<HTMLElement>('.manager-nav')!, 'getBoundingClientRect')
      .mockReturnValue(historyRect(0, 100));
    installHistoryAnchorRects('.gallery-private', {
      'before-first': 725,
      'after-second': 1_000,
    }, () => scrollY);
    await candidateRouter.navigate(-1);
    await waitFor(() => expect(candidateRouter.state.location.search).toBe('?section=gallery'));
    await waitFor(() => expect(frames.length).toBeGreaterThan(0));
    const candidateRequestCount = candidateRequests.length;
    act(() => { frames.shift()?.(0); });
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 600, behavior: 'instant' });
    expect(candidateRequests).toHaveLength(candidateRequestCount);

    candidateView.unmount();
    frames.length = 0;
    scrollTo.mockClear();
    scrollY = 300;
    const fallbackAnchor: GalleryAnchor = {
      kind: 'media', mediaId: 'gone', viewportOffset: 0, fallbackScrollY: 1200,
      before: ['also-gone'], after: ['still-gone'],
    };
    const fallbackRequests: string[] = [];
    vi.stubGlobal('fetch', managerHistoryFetch(historyMedia(['other']), [], fallbackRequests));
    const fallbackRouter = createAppRouter([{
      pathname: `/manage/event/${MANAGED_EVENT.id}`,
      search: '?section=gallery',
      state: managerHistoryState(fallbackAnchor, 'library'),
    }, guestPath]);
    render(<RouterProvider router={fallbackRouter} />);
    await waitFor(() => expect(document.querySelectorAll('.gallery-private [data-gallery-anchor-id]'))
      .toHaveLength(1));
    vi.spyOn(document.querySelector<HTMLElement>('.manager-nav')!, 'getBoundingClientRect')
      .mockReturnValue(historyRect(0, 100));
    installHistoryAnchorRects('.gallery-private', { other: 500 }, () => scrollY);
    await fallbackRouter.navigate(-1);
    await waitFor(() => expect(fallbackRouter.state.location.search).toBe('?section=gallery'));
    await waitFor(() => expect(frames.length).toBeGreaterThan(0));
    const fallbackRequestCount = fallbackRequests.length;
    act(() => { frames.shift()?.(0); });
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 600, behavior: 'instant' });
    expect(fallbackRequests).toHaveLength(fallbackRequestCount);
  });

  it('leaves the browser history wrapper untouched for a blocked memory-router departure', async () => {
    vi.stubGlobal('fetch', managerHistoryFetch(historyMedia(['library-1']), []));
    const originalHistoryState = window.history.state;
    const originalHref = window.location.href;
    const browserWrapper = {
      usr: { outsideRouter: 'untouched' },
      key: 'default',
      idx: 41,
      foreignSentinel: 'memory-router-does-not-own-this',
    };
    window.history.replaceState(browserWrapper, '', window.location.href);
    onTestFinished(() => {
      window.history.replaceState(originalHistoryState, '', originalHref);
    });
    const router = createAppRouter([`/manage/event/${MANAGED_EVENT.id}?section=gallery`]);
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(document.querySelectorAll('.gallery-private [data-gallery-anchor-id]'))
      .toHaveLength(1));

    await router.navigate('/terms');
    await waitFor(() => expect(router.state.location.pathname).toBe('/terms'));

    expect(window.history.state).toEqual(browserWrapper);
  });

  it('leaves the browser history wrapper untouched for a blocked in-app Manager target', async () => {
    let releaseSettings!: () => void;
    const settingsGate = new Promise<void>((resolve) => { releaseSettings = resolve; });
    let settingsStarted = false;
    const base = managerLocationFetch();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/settings') && method === 'PATCH') {
        settingsStarted = true;
        await settingsGate;
        return json({ event: { ...MANAGED_EVENT, galleryVisible: false } });
      }
      return base(input, init);
    }));
    const originalHistoryState = window.history.state;
    const originalHref = window.location.href;
    const browserWrapper = {
      usr: { outsideRouter: 'untouched' },
      key: 'default',
      idx: 23,
      foreignSentinel: 'in-app-navigation-does-not-own-this',
    };
    window.history.replaceState(browserWrapper, '', window.location.href);
    onTestFinished(() => {
      releaseSettings();
      window.history.replaceState(originalHistoryState, '', originalHref);
    });
    const router = createAppRouter([`/manage/event/${MANAGED_EVENT.id}?section=settings`]);
    render(<RouterProvider router={router} />);
    const user = userEvent.setup();
    const navigation = await screen.findByRole('navigation', { name: 'Manager sections' });
    await user.click(screen.getByLabelText('Show the optional shared gallery'));
    await waitFor(() => expect(settingsStarted).toBe(true));

    await user.click(within(navigation).getByRole('button', { name: /gallery/i }));
    const prompt = await screen.findByRole('region', { name: /not saved yet/i });
    await user.click(within(prompt).getByRole('button', { name: 'Leave now' }));
    await waitFor(() => expect(router.state.location.search).toBe('?section=gallery'));

    expect(window.history.state).toEqual(browserWrapper);
  });

  it('captures Library and Guest-gallery anchors before Back or Forward adopts another location', async () => {
    vi.stubGlobal('fetch', managerHistoryFetch(
      historyMedia(['library-1', 'library-2']),
      historyMedia(['guest-1', 'guest-2'], 'unpublished'),
    ));
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));
    let scrollY = 500;
    vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => scrollY);
    trackWindowScroll((top) => { scrollY = top; });
    const libraryPath = `/manage/event/${MANAGED_EVENT.id}?section=gallery`;
    const guestPath = `/manage/event/${MANAGED_EVENT.id}?section=gallery&mode=guest-gallery`;
    const originalHistoryState = window.history.state;
    const originalHref = window.location.href;
    const libraryWrapper = {
      usr: null,
      key: 'library-entry',
      idx: 0,
      foreignSentinel: 'keep-library-wrapper',
    };
    const guestWrapper = {
      usr: null,
      key: 'guest-entry',
      idx: 1,
      foreignSentinel: 'keep-guest-wrapper',
    };
    window.history.replaceState(libraryWrapper, '', libraryPath);
    window.history.pushState(guestWrapper, '', guestPath);
    const replaceState = vi.spyOn(window.history, 'replaceState');
    const router = createAppRouter();
    onTestFinished(() => {
      router.dispose();
      window.history.replaceState(originalHistoryState, '', originalHref);
    });
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(document.querySelectorAll('[data-gallery-anchor-id]')).toHaveLength(4));
    vi.spyOn(document.querySelector<HTMLElement>('.manager-nav')!, 'getBoundingClientRect')
      .mockReturnValue(historyRect(0, 100));
    installHistoryAnchorRects('.gallery-private', {
      'library-1': 450,
      'library-2': 680,
    }, () => scrollY);
    installHistoryAnchorRects('.gallery-shared', {
      'guest-1': 450,
      'guest-2': 700,
    }, () => scrollY);

    await router.navigate(-1);
    await waitFor(() => expect(router.state.location.search).toBe('?section=gallery'));
    const capturedGuestWrite = replaceState.mock.calls.find(([next]) => {
      const wrapper = next as Record<string, unknown>;
      const usr = wrapper.usr as RouterHistoryState | undefined;
      return wrapper.foreignSentinel === guestWrapper.foreignSentinel
        && usr?.__candidaryManager?.anchors?.['guest-gallery'] !== undefined;
    })?.[0] as Record<string, unknown> | undefined;
    expect(capturedGuestWrite).toEqual({
      ...guestWrapper,
      usr: expect.objectContaining({
        __candidaryManager: expect.objectContaining({
          anchors: expect.objectContaining({
            'guest-gallery': expect.objectContaining({ kind: 'media' }),
          }),
        }),
      }),
    });
    await waitFor(() => expect(frames.length).toBeGreaterThan(0));
    act(() => { frames.shift()?.(0); });
    scrollY = 500;
    await router.navigate(1);
    await waitFor(() => expect(router.state.location.search)
      .toBe('?section=gallery&mode=guest-gallery'));
    const capturedLibraryWrite = replaceState.mock.calls.find(([next]) => {
      const wrapper = next as Record<string, unknown>;
      const usr = wrapper.usr as RouterHistoryState | undefined;
      return wrapper.foreignSentinel === libraryWrapper.foreignSentinel
        && usr?.__candidaryManager?.anchors?.library !== undefined;
    })?.[0] as Record<string, unknown> | undefined;
    expect(capturedLibraryWrite).toEqual({
      ...libraryWrapper,
      usr: expect.objectContaining({
        __candidaryManager: expect.objectContaining({
          anchors: expect.objectContaining({
            library: expect.objectContaining({ kind: 'media' }),
          }),
        }),
      }),
    });
  });

  it('captures and consumes a distinct same-href browser POP exactly once', async () => {
    vi.stubGlobal('fetch', managerHistoryFetch(historyMedia(['same-href-row']), []));
    let scrollY = 500;
    vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => scrollY);
    trackWindowScroll((top) => { scrollY = top; });
    const managerPath = `/manage/event/${MANAGED_EVENT.id}?section=gallery`;
    const originalHistoryState = window.history.state;
    const originalHref = window.location.href;
    const targetWrapper = {
      usr: managerIntentState({ kind: 'focus-complete-export' }),
      key: 'same-href-target',
      idx: 0,
      foreignSentinel: 'keep-target-wrapper',
    };
    const currentWrapper = {
      usr: { currentEntry: 'preserve' },
      key: 'same-href-current',
      idx: 1,
      foreignSentinel: 'keep-current-wrapper',
    };
    window.history.replaceState(targetWrapper, '', managerPath);
    window.history.pushState(currentWrapper, '', managerPath);
    const replaceState = vi.spyOn(window.history, 'replaceState');
    const router = createAppRouter();
    onTestFinished(() => {
      router.dispose();
      window.history.replaceState(originalHistoryState, '', originalHref);
    });
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(document.querySelectorAll('.gallery-private [data-gallery-anchor-id]'))
      .toHaveLength(1));
    vi.spyOn(document.querySelector<HTMLElement>('.manager-nav')!, 'getBoundingClientRect')
      .mockReturnValue(historyRect(0, 100));
    installHistoryAnchorRects('.gallery-private', { 'same-href-row': 700 }, () => scrollY);

    window.history.back();
    const download = await screen.findByRole('button', { name: 'Download all' });
    await waitFor(() => expect(download).toHaveFocus());
    await waitFor(() => expect(router.state.location.state).toEqual({ source: 'task-4-test' }));
    const capturedCurrentWrite = replaceState.mock.calls.find(([next]) => {
      const wrapper = next as Record<string, unknown>;
      const usr = wrapper.usr as RouterHistoryState | undefined;
      return wrapper.foreignSentinel === currentWrapper.foreignSentinel
        && usr?.__candidaryManager?.anchors?.library !== undefined;
    })?.[0] as Record<string, unknown> | undefined;
    expect(capturedCurrentWrite).toEqual({
      ...currentWrapper,
      usr: expect.objectContaining({
        currentEntry: 'preserve',
        __candidaryManager: expect.objectContaining({
          anchors: expect.objectContaining({
            library: expect.objectContaining({ kind: 'media' }),
          }),
        }),
      }),
    });

    window.history.forward();
    await waitFor(() => expect(window.history.state?.foreignSentinel)
      .toBe(currentWrapper.foreignSentinel));
    await waitFor(() => expect(router.state.location.state).toEqual({ currentEntry: 'preserve' }));
    const library = screen.getByRole('button', { name: 'Library' });
    library.focus();
    window.history.back();
    await waitFor(() => expect(router.state.location.state).toEqual({ source: 'task-4-test' }));
    expect(download).not.toHaveFocus();
  });

  it('captures a keyless default entry before a distinct same-href Forward exactly once', async () => {
    vi.stubGlobal('fetch', managerHistoryFetch(historyMedia(['keyless-forward-row']), []));
    let scrollY = 500;
    vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => scrollY);
    trackWindowScroll((top) => { scrollY = top; });
    const managerPath = `/manage/event/${MANAGED_EVENT.id}?section=gallery`;
    const originalHistoryState = window.history.state;
    const originalHref = window.location.href;
    const initialWrapper = {
      usr: { initialEntry: 'preserve' },
      idx: 0,
      foreignSentinel: 'keep-keyless-initial-wrapper',
    };
    const forwardWrapper = {
      usr: managerIntentState({ kind: 'focus-complete-export' }),
      key: 'same-href-forward-target',
      idx: 1,
      foreignSentinel: 'keep-forward-wrapper',
    };
    window.history.replaceState(initialWrapper, '', managerPath);
    window.history.pushState(forwardWrapper, '', managerPath);
    const returnedToInitial = new Promise<void>((resolve) => {
      window.addEventListener('popstate', () => resolve(), { once: true });
    });
    window.history.back();
    await returnedToInitial;
    expect(window.history.state).toEqual(initialWrapper);
    const replaceState = vi.spyOn(window.history, 'replaceState');
    const router = createAppRouter();
    onTestFinished(() => {
      router.dispose();
      window.history.replaceState(originalHistoryState, '', originalHref);
    });
    expect(router.state.location.key).toBe('default');
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(document.querySelectorAll('.gallery-private [data-gallery-anchor-id]'))
      .toHaveLength(1));
    vi.spyOn(document.querySelector<HTMLElement>('.manager-nav')!, 'getBoundingClientRect')
      .mockReturnValue(historyRect(0, 100));
    installHistoryAnchorRects('.gallery-private', { 'keyless-forward-row': 700 }, () => scrollY);

    window.history.forward();
    const download = await screen.findByRole('button', { name: 'Download all' });
    await waitFor(() => expect(download).toHaveFocus());
    await waitFor(() => expect(router.state.location.state).toEqual({ source: 'task-4-test' }));
    const capturedInitialWrite = replaceState.mock.calls.find(([next]) => {
      const wrapper = next as Record<string, unknown>;
      const usr = wrapper.usr as RouterHistoryState | undefined;
      return wrapper.foreignSentinel === initialWrapper.foreignSentinel
        && usr?.__candidaryManager?.anchors?.library !== undefined;
    })?.[0] as Record<string, unknown> | undefined;
    expect(capturedInitialWrite).toEqual({
      ...initialWrapper,
      usr: expect.objectContaining({
        initialEntry: 'preserve',
        __candidaryManager: expect.objectContaining({
          anchors: expect.objectContaining({
            library: expect.objectContaining({ kind: 'media' }),
          }),
        }),
      }),
    });

    window.history.back();
    await waitFor(() => expect(router.state.location.state).toEqual({ initialEntry: 'preserve' }));
    screen.getByRole('button', { name: 'Library' }).focus();
    window.history.forward();
    await waitFor(() => expect(router.state.location.state).toEqual({ source: 'task-4-test' }));
    expect(download).not.toHaveFocus();
  });

  it('cancels queued Gallery restoration after a newer adoption', async () => {
    const returningAnchor: GalleryAnchor = {
      kind: 'media', mediaId: 'library-1', viewportOffset: 30, fallbackScrollY: 700,
      before: [], after: [],
    };
    vi.stubGlobal('fetch', managerHistoryFetch(
      historyMedia(['library-1']),
      historyMedia(['guest-1'], 'unpublished'),
    ));
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));
    const scrollY = 400;
    vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => scrollY);
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    const guestPath = `/manage/event/${MANAGED_EVENT.id}?section=gallery&mode=guest-gallery`;
    const router = createAppRouter([{
      pathname: `/manage/event/${MANAGED_EVENT.id}`,
      search: '?section=gallery',
      state: managerHistoryState(returningAnchor, 'library'),
    }, guestPath]);
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(document.querySelectorAll('[data-gallery-anchor-id]')).toHaveLength(2));
    vi.spyOn(document.querySelector<HTMLElement>('.manager-nav')!, 'getBoundingClientRect')
      .mockReturnValue(historyRect(0, 100));
    installHistoryAnchorRects('.gallery-private', { 'library-1': 700 }, () => scrollY);
    installHistoryAnchorRects('.gallery-shared', { 'guest-1': 720 }, () => scrollY);

    await router.navigate(-1);
    await waitFor(() => expect(router.state.location.search).toBe('?section=gallery'));
    await waitFor(() => expect(frames.length).toBeGreaterThan(0));
    const staleRestoration = frames.shift();
    expect(staleRestoration).toBeTypeOf('function');
    await router.navigate(1);
    await waitFor(() => expect(router.state.location.search)
      .toBe('?section=gallery&mode=guest-gallery'));
    act(() => { staleRestoration?.(0); });
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('keeps a complete export intent on the labelled region while export status is loading', async () => {
    let releaseExports!: () => void;
    const exportsGate = new Promise<void>((resolve) => { releaseExports = resolve; });
    onTestFinished(releaseExports);
    const base = managerHistoryFetch([], []);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/exports')) {
        await exportsGate;
        return json({ exports: [] });
      }
      return base(input, init);
    }));
    const router = createAppRouter([{
      pathname: `/manage/event/${MANAGED_EVENT.id}`,
      search: '?section=gallery',
      state: managerIntentState({ kind: 'focus-complete-export' }),
    }]);
    render(<RouterProvider router={router} />);

    await screen.findByRole('heading', { name: 'Gallery' });
    expect(await screen.findByRole('region', { name: 'Complete export' })).toHaveFocus();
  });

  it('retires a loading complete export focus request when Library is no longer active', async () => {
    let releaseExports!: () => void;
    const exportsGate = new Promise<void>((resolve) => { releaseExports = resolve; });
    onTestFinished(releaseExports);
    const base = managerHistoryFetch([], []);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/exports')) {
        await exportsGate;
        return json({ exports: [] });
      }
      return base(input, init);
    }));
    const router = createAppRouter([{
      pathname: `/manage/event/${MANAGED_EVENT.id}`,
      search: '?section=gallery',
      state: managerIntentState({ kind: 'focus-complete-export' }),
    }]);
    render(<RouterProvider router={router} />);

    expect(await screen.findByRole('region', { name: 'Complete export' })).toHaveFocus();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Guest gallery' }));
    const published = await screen.findByRole('button', { name: 'Published' });
    published.focus();

    await act(async () => { releaseExports(); });
    expect(published).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Library' }));
    expect(await screen.findByRole('button', { name: 'Download all' })).not.toHaveFocus();
  });

  it('keeps a complete export intent on the labelled region when export status fails', async () => {
    const base = managerHistoryFetch([], []);
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => (
      String(input).endsWith('/exports')
        ? errorJson({ code: 'INTERNAL_ERROR', message: 'Export status unavailable.', requestId: 'r' }, 503)
        : base(input, init)
    )));
    const router = createAppRouter([{
      pathname: `/manage/event/${MANAGED_EVENT.id}`,
      search: '?section=gallery',
      state: managerIntentState({ kind: 'focus-complete-export' }),
    }]);
    render(<RouterProvider router={router} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Export status unavailable.');
    expect(screen.getByRole('region', { name: 'Complete export' })).toHaveFocus();
  });

  it('keeps a complete export intent on the labelled region for a trusted empty collection', async () => {
    const base = managerHistoryFetch([], []);
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => (
      String(input).endsWith(`/api/manage/events/${MANAGED_EVENT.id}`)
        ? json({ event: { ...MANAGED_EVENT, storedMediaCount: 0, storedBytes: 0 } })
        : base(input, init)
    )));
    const router = createAppRouter([{
      pathname: `/manage/event/${MANAGED_EVENT.id}`,
      search: '?section=gallery',
      state: managerIntentState({ kind: 'focus-complete-export' }),
    }]);
    render(<RouterProvider router={router} />);

    await screen.findByText('Deliver a photo before preparing the current collection.');
    expect(screen.getByRole('region', { name: 'Complete export' })).toHaveFocus();
  });

  it('keeps a complete export intent on the labelled region while another job is active', async () => {
    const base = managerHistoryFetch([], []);
    const activeAlbum = exportJobFixture('album', 'running');
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => (
      String(input).endsWith('/exports')
        ? json({ exports: [activeAlbum] })
        : base(input, init)
    )));
    const router = createAppRouter([{
      pathname: `/manage/event/${MANAGED_EVENT.id}`,
      search: '?section=gallery',
      state: managerIntentState({ kind: 'focus-complete-export' }),
    }]);
    render(<RouterProvider router={router} />);

    await screen.findByText('Album export is Running. Prepare and retry actions will be available when it finishes.');
    expect(screen.getByRole('region', { name: 'Complete export' })).toHaveFocus();
  });

  it('uses a Share complete export intent once, focuses its enabled action, and preserves foreign state', async () => {
    vi.stubGlobal('fetch', managerHistoryFetch([], []));
    const shareEntry = {
      pathname: `/manage/event/${MANAGED_EVENT.id}`,
      search: '?section=share',
      state: { source: 'share-entry' },
    };
    const router = createAppRouter([shareEntry]);
    const view = render(<RouterProvider router={router} />);
    const user = userEvent.setup();
    const share = await screen.findByRole('heading', { name: 'Share your event' });

    await user.click(within(share.closest('section')!).getByRole('button', { name: 'Open Gallery' }));

    const action = await screen.findByRole('button', { name: 'Download all' });
    expect(action).toHaveFocus();
    await waitFor(() => expect(router.state.location.state).toEqual({ source: 'share-entry' }));

    screen.getByRole('button', { name: 'Guest gallery' }).focus();
    await router.navigate(-1);
    await screen.findByRole('heading', { name: 'Share your event' });
    await router.navigate(1);
    const returnedAction = await screen.findByRole('button', { name: 'Download all' });
    expect(returnedAction).not.toHaveFocus();

    view.unmount();
    const reload = createAppRouter([`/manage/event/${MANAGED_EVENT.id}?section=gallery`]);
    render(<RouterProvider router={reload} />);
    expect(await screen.findByRole('button', { name: 'Download all' })).not.toHaveFocus();
  });

  it('commits one canonical clean entry before a complete export intent focuses under StrictMode', async () => {
    vi.stubGlobal('fetch', managerHistoryFetch([], []));
    const router = createAppRouter([`/manage/event/${MANAGED_EVENT.id}?section=share`]);
    const focusSnapshots: Array<{ search: string; state: unknown }> = [];
    const recordFocus = (event: FocusEvent) => {
      if ((event.target as HTMLElement | null)?.textContent?.includes('Download all')) {
        focusSnapshots.push({
          search: router.state.location.search,
          state: router.state.location.state,
        });
      }
    };
    document.addEventListener('focusin', recordFocus);
    onTestFinished(() => document.removeEventListener('focusin', recordFocus));
    render(<StrictMode><RouterProvider router={router} /></StrictMode>);
    await screen.findByRole('heading', { name: 'Share your event' });

    await router.navigate({
      pathname: `/manage/event/${MANAGED_EVENT.id}`,
      search: '?section=gallery&mode=library&unknown=discard-me',
    }, {
      state: managerIntentState({ kind: 'focus-complete-export' }),
    });

    await waitFor(() => expect(focusSnapshots).toHaveLength(1));
    expect(focusSnapshots[0]).toEqual({
      search: '?section=gallery',
      state: { source: 'task-4-test' },
    });
    expect(router.state.location.search).toBe('?section=gallery');
    expect(router.state.location.state).toEqual({ source: 'task-4-test' });
  });

  it('retires a superseded cleanup before adopting a different same-target REPLACE', async () => {
    vi.stubGlobal('fetch', managerHistoryFetch([], []));
    const router = createAppRouter([{
      pathname: `/manage/event/${MANAGED_EVENT.id}`,
      search: '?section=gallery&mode=library&unknown=old-entry',
      state: managerIntentState({ kind: 'focus-complete-export' }),
    }]);
    const originalNavigate = router.navigate.bind(router);
    let releaseCleanup!: () => void;
    const cleanupStarted = new Promise<void>((resolveStarted) => {
      vi.spyOn(router, 'navigate').mockImplementation((to, options) => {
        if (options?.replace && releaseCleanup === undefined) {
          return new Promise<void>((resolveCleanup) => {
            releaseCleanup = resolveCleanup;
            resolveStarted();
          });
        }
        return originalNavigate(to, options);
      });
    });
    render(<StrictMode><RouterProvider router={router} /></StrictMode>);
    await cleanupStarted;

    await originalNavigate({
      pathname: `/manage/event/${MANAGED_EVENT.id}`,
      search: '?section=gallery',
    }, { replace: true, state: { source: 'newer-same-target-entry' } });
    await waitFor(() => expect(router.state.location.state)
      .toEqual({ source: 'newer-same-target-entry' }));
    await act(async () => { releaseCleanup(); });

    const action = await screen.findByRole('button', { name: 'Download all' });
    expect(action).not.toHaveFocus();
    expect(router.state.location.search).toBe('?section=gallery');
    expect(router.state.location.state).toEqual({ source: 'newer-same-target-entry' });
  });

  it('retries one rejected cleanup and focuses only after the exact clean successor commits', async () => {
    vi.stubGlobal('fetch', managerHistoryFetch([], []));
    const router = createAppRouter([{
      pathname: `/manage/event/${MANAGED_EVENT.id}`,
      search: '?section=gallery&mode=library&unknown=retry-once',
      state: managerIntentState({ kind: 'focus-complete-export' }),
    }]);
    const originalNavigate = router.navigate.bind(router);
    let cleanupCalls = 0;
    const cleanupStates: unknown[] = [];
    vi.spyOn(router, 'navigate').mockImplementation((to, options) => {
      if (options?.replace) {
        cleanupCalls += 1;
        cleanupStates.push(options.state);
        if (cleanupCalls === 1) return Promise.reject(new Error('cleanup rejected once'));
      }
      return originalNavigate(to, options);
    });
    const focusSnapshots: Array<{ search: string; state: unknown }> = [];
    const recordFocus = (event: FocusEvent) => {
      if ((event.target as HTMLElement | null)?.textContent?.includes('Download all')) {
        focusSnapshots.push({
          search: router.state.location.search,
          state: router.state.location.state,
        });
      }
    };
    document.addEventListener('focusin', recordFocus);
    onTestFinished(() => document.removeEventListener('focusin', recordFocus));
    render(<StrictMode><RouterProvider router={router} /></StrictMode>);

    await waitFor(() => expect(focusSnapshots).toHaveLength(1));
    expect(cleanupCalls).toBe(2);
    expect(cleanupStates[1]).not.toBe(cleanupStates[0]);
    expect(focusSnapshots[0]).toEqual({
      search: '?section=gallery',
      state: { source: 'task-4-test' },
    });
    await act(async () => { await Promise.resolve(); });
    expect(cleanupCalls).toBe(2);
  });

  it('does not assign an equal-state independent REPLACE to a held cleanup invocation', async () => {
    vi.stubGlobal('fetch', managerHistoryFetch([], []));
    let getterReads = 0;
    const makeForeignState = () => {
      const value: Record<string, unknown> = {};
      Object.defineProperty(value, 'stable', {
        configurable: true,
        enumerable: true,
        get() {
          getterReads += 1;
          return 'preserved';
        },
      });
      return value;
    };
    const makeCyclicState = () => {
      const value: Record<string, unknown> = {};
      value.self = value;
      return value;
    };
    const initialCyclic = makeCyclicState();
    const router = createAppRouter([{
      pathname: `/manage/event/${MANAGED_EVENT.id}`,
      search: '?section=gallery&mode=library&unknown=held-cleanup',
      state: managerIntentState({ kind: 'focus-complete-export' }),
    }]);
    // Memory history stringifies initial entry objects while validating their
    // pathname. Add valid foreign values to the already-created entry so the
    // assertion measures Manager ownership rather than that harness detail.
    Object.assign(router.state.location.state as RouterHistoryState, {
      foreign: makeForeignState(),
      cyclic: initialCyclic,
    });
    const originalNavigate = router.navigate.bind(router);
    let releaseCleanup!: () => void;
    const cleanupStarted = new Promise<void>((resolveStarted) => {
      vi.spyOn(router, 'navigate').mockImplementation((to, options) => {
        if (options?.replace && releaseCleanup === undefined) {
          return new Promise<void>((resolveCleanup) => {
            releaseCleanup = resolveCleanup;
            resolveStarted();
          });
        }
        return originalNavigate(to, options);
      });
    });
    render(<StrictMode><RouterProvider router={router} /></StrictMode>);
    await cleanupStarted;

    const winnerCyclic = makeCyclicState();
    await originalNavigate({
      pathname: `/manage/event/${MANAGED_EVENT.id}`,
      search: '?section=gallery',
    }, {
      replace: true,
      state: {
        source: 'task-4-test',
        foreign: makeForeignState(),
        cyclic: winnerCyclic,
      },
    });
    await act(async () => { releaseCleanup(); });

    const action = await screen.findByRole('button', { name: 'Download all' });
    expect(action).not.toHaveFocus();
    expect(router.state.location.state).toMatchObject({ source: 'task-4-test' });
    expect((router.state.location.state as RouterHistoryState).cyclic).toBe(winnerCyclic);
    expect(getterReads).toBe(0);
  });

  it('retires a held cleanup before a late rejection after unmount', async () => {
    vi.stubGlobal('fetch', managerHistoryFetch([], []));
    const router = createAppRouter([{
      pathname: `/manage/event/${MANAGED_EVENT.id}`,
      search: '?section=gallery&mode=library&unknown=late-rejection',
      state: managerIntentState({ kind: 'focus-complete-export' }),
    }]);
    const originalNavigate = router.navigate.bind(router);
    let rejectCleanup!: (reason: Error) => void;
    let cleanupCalls = 0;
    const cleanupStarted = new Promise<void>((resolveStarted) => {
      vi.spyOn(router, 'navigate').mockImplementation((to, options) => {
        if (options?.replace) {
          cleanupCalls += 1;
          if (cleanupCalls === 1) {
            return new Promise<void>((_resolve, reject) => {
              rejectCleanup = reject;
              resolveStarted();
            });
          }
          return Promise.resolve();
        }
        return originalNavigate(to, options);
      });
    });
    const view = render(<StrictMode><RouterProvider router={router} /></StrictMode>);
    await cleanupStarted;

    view.unmount();
    await originalNavigate('/terms');
    await act(async () => {
      rejectCleanup(new Error('late cleanup rejection'));
      await Promise.resolve();
    });

    expect(cleanupCalls).toBe(1);
    expect(router.state.location.pathname).toBe('/terms');
  });

  it('allows a later genuine traversal after both cleanup attempts reject', async () => {
    vi.stubGlobal('fetch', managerHistoryFetch([], []));
    const router = createAppRouter([{
      pathname: `/manage/event/${MANAGED_EVENT.id}`,
      search: '?section=gallery&mode=library&unknown=two-rejections',
      state: managerIntentState({ kind: 'focus-complete-export' }),
    }]);
    const originalNavigate = router.navigate.bind(router);
    let cleanupCalls = 0;
    vi.spyOn(router, 'navigate').mockImplementation((to, options) => {
      if (options?.replace) {
        cleanupCalls += 1;
        if (cleanupCalls <= 2) return Promise.reject(new Error(`cleanup rejected ${cleanupCalls}`));
      }
      return originalNavigate(to, options);
    });
    const focusSnapshots: Array<{ search: string; state: unknown }> = [];
    const recordFocus = (event: FocusEvent) => {
      if ((event.target as HTMLElement | null)?.textContent?.includes('Download all')) {
        focusSnapshots.push({
          search: router.state.location.search,
          state: router.state.location.state,
        });
      }
    };
    document.addEventListener('focusin', recordFocus);
    onTestFinished(() => document.removeEventListener('focusin', recordFocus));
    render(<StrictMode><RouterProvider router={router} /></StrictMode>);
    await waitFor(() => expect(cleanupCalls).toBe(2));

    await originalNavigate(`/manage/event/${MANAGED_EVENT.id}?section=share`);
    await screen.findByRole('heading', { name: 'Share your event' });
    await originalNavigate(-1);

    await waitFor(() => expect(focusSnapshots).toHaveLength(1));
    expect(cleanupCalls).toBe(3);
    expect(focusSnapshots[0]).toEqual({
      search: '?section=gallery',
      state: { source: 'task-4-test' },
    });
    await act(async () => { await Promise.resolve(); });
    expect(cleanupCalls).toBe(3);
  });

  it('keeps an anchor capture distinct from a cleanup awaiting completion', async () => {
    const library = historyMedia(Array.from({ length: 30 }, (_, index) => `p${index + 1}`));
    vi.stubGlobal('fetch', managerHistoryFetch(library, historyMedia(['guest-1'], 'unpublished')));
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));
    let scrollY = 600;
    vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => scrollY);
    trackWindowScroll((top) => { scrollY = top; });
    const router = createAppRouter([{
      pathname: `/manage/event/${MANAGED_EVENT.id}`,
      search: '?section=gallery&mode=library&unknown=held-completion',
      state: managerIntentState({ kind: 'focus-complete-export' }),
    }]);
    const originalNavigate = router.navigate.bind(router);
    let releaseCleanup!: () => void;
    const cleanupCompletion = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    let cleanupCommitted!: () => void;
    const committed = new Promise<void>((resolve) => { cleanupCommitted = resolve; });
    let heldCleanup = false;
    vi.spyOn(router, 'navigate').mockImplementation((to, options) => {
      if (options?.replace && !heldCleanup) {
        heldCleanup = true;
        return originalNavigate(to, options).then(() => {
          cleanupCommitted();
          return cleanupCompletion;
        });
      }
      return originalNavigate(to, options);
    });
    render(<StrictMode><RouterProvider router={router} /></StrictMode>);
    const user = userEvent.setup();
    await committed;
    await user.click(await screen.findByRole('button', { name: 'Show more photos' }));
    await waitFor(() => expect(document.querySelectorAll('.gallery-private [data-gallery-anchor-id]'))
      .toHaveLength(library.length));
    vi.spyOn(document.querySelector<HTMLElement>('.manager-nav')!, 'getBoundingClientRect')
      .mockReturnValue(historyRect(0, 100));
    const documentTops = Object.fromEntries(library.map(({ id }, index) => [
      id,
      index < 20 ? 400 + index * 4 : 780 + (index - 20) * 40,
    ]));
    installHistoryAnchorRects('.gallery-private', documentTops, () => scrollY);
    const tile = document.querySelector<HTMLElement>('[data-photo-id="p21"]')!;
    const effectiveTop = () => Math.max(
      0,
      document.querySelector<HTMLElement>('.manager-nav')!.getBoundingClientRect().bottom,
    );
    const before = tile.getBoundingClientRect().top - effectiveTop();

    await user.click(screen.getByRole('button', { name: 'Guest gallery' }));
    await waitFor(() => expect(router.state.location.search)
      .toBe('?section=gallery&mode=guest-gallery'));
    await act(async () => { releaseCleanup(); });
    await waitFor(() => expect(frames.length).toBeGreaterThan(0));
    act(() => {
      while (frames.length > 0) frames.shift()?.(0);
    });
    expect(scrollY).toBe(0);

    await router.navigate(-1);
    await waitFor(() => expect(router.state.location.search).toBe('?section=gallery'));
    await waitFor(() => expect(frames.length).toBeGreaterThan(0));
    act(() => {
      while (frames.length > 0) frames.shift()?.(0);
    });
    expect(tile.getBoundingClientRect().top - effectiveTop()).toBe(before);
  });

  it('cancels a successful held anchor capture after its Manager owner unmounts', async () => {
    vi.stubGlobal('fetch', managerHistoryFetch(historyMedia(['capture-owner']), []));
    const router = createAppRouter([`/manage/event/${MANAGED_EVENT.id}?section=gallery`]);
    const originalNavigate = router.navigate.bind(router);
    let releaseCapture!: () => void;
    const captureGate = new Promise<void>((resolve) => { releaseCapture = resolve; });
    onTestFinished(() => releaseCapture());
    let markCaptureCommitted!: () => void;
    const captureCommitted = new Promise<void>((resolve) => { markCaptureCommitted = resolve; });
    const destinationTargets: string[] = [];
    let heldCapture = false;
    vi.spyOn(router, 'navigate').mockImplementation((to, options) => {
      if (!options?.replace) {
        destinationTargets.push(typeof to === 'string' ? to : String(to));
      }
      if (options?.replace && !heldCapture) {
        heldCapture = true;
        return originalNavigate(to, options).then(async () => {
          markCaptureCommitted();
          await captureGate;
        });
      }
      return originalNavigate(to, options);
    });
    const view = render(<StrictMode><RouterProvider router={router} /></StrictMode>);

    fireEvent.click(await screen.findByRole('button', { name: 'Guest gallery' }));
    await captureCommitted;
    view.unmount();
    await originalNavigate('/terms');
    render(<RouterProvider router={router} />);
    const winner = await screen.findByRole('heading', { name: 'Terms' });
    winner.tabIndex = -1;
    winner.focus();

    await act(async () => {
      releaseCapture();
      await Promise.resolve();
    });

    expect(router.state.location.pathname).toBe('/terms');
    expect(router.state.location.search).toBe('');
    expect(destinationTargets).not.toContain(
      `/manage/event/${MANAGED_EVENT.id}?section=gallery&mode=guest-gallery`,
    );
    expect(winner).toHaveFocus();
  });

  it('cancels a held anchor capture when a newer same-event destination wins', async () => {
    vi.stubGlobal('fetch', managerHistoryFetch(historyMedia(['capture-winner']), []));
    const router = createAppRouter([`/manage/event/${MANAGED_EVENT.id}?section=gallery`]);
    const originalNavigate = router.navigate.bind(router);
    let releaseCapture!: () => void;
    const captureGate = new Promise<void>((resolve) => { releaseCapture = resolve; });
    onTestFinished(() => releaseCapture());
    let markCaptureCommitted!: () => void;
    const captureCommitted = new Promise<void>((resolve) => { markCaptureCommitted = resolve; });
    const destinationTargets: string[] = [];
    let heldCapture = false;
    vi.spyOn(router, 'navigate').mockImplementation((to, options) => {
      if (!options?.replace) {
        destinationTargets.push(typeof to === 'string' ? to : String(to));
      }
      if (options?.replace && !heldCapture) {
        heldCapture = true;
        return originalNavigate(to, options).then(async () => {
          markCaptureCommitted();
          await captureGate;
        });
      }
      return originalNavigate(to, options);
    });
    render(<StrictMode><RouterProvider router={router} /></StrictMode>);

    fireEvent.click(await screen.findByRole('button', { name: 'Guest gallery' }));
    await captureCommitted;
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    const winner = await screen.findByRole('heading', { name: 'Share your event' });
    await waitFor(() => expect(router.state.location.search).toBe('?section=share'));
    winner.tabIndex = -1;
    winner.focus();

    await act(async () => {
      releaseCapture();
      await Promise.resolve();
    });

    expect(router.state.location.search).toBe('?section=share');
    expect(destinationTargets).not.toContain(
      `/manage/event/${MANAGED_EVENT.id}?section=gallery&mode=guest-gallery`,
    );
    expect(winner).toHaveFocus();
  });

  it('uses a retained marker intent once, focuses its first-page Restore, and does not replay on Back or reload', async () => {
    const retainedId = 'retained-first-page';
    const retainedRow = {
      id: retainedId,
      originalFilename: 'retained-photo.jpg',
      guestName: 'Avery',
      caption: 'Held moment',
      trashedAt: '2026-09-20T01:00:00.000Z',
      restoreUntil: '2099-10-19T00:00:00.000Z',
    };
    let trashGets = 0;
    const base = managerLocationFetch();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (url.endsWith(`/api/manage/events/${MANAGED_EVENT.id}`)) {
        return json({ event: { ...MANAGED_EVENT, recoverableMediaCount: 1 } });
      }
      if (url.endsWith('/media/trash') && method === 'GET') {
        trashGets += 1;
        return json({ media: [retainedRow], nextCursor: null });
      }
      if (url.endsWith('/album') && method === 'GET') return json({ album: {
        revision: 1,
        saved: true,
        title: 'Album',
        description: '',
        coverMediaId: null,
        effectiveCoverMediaId: null,
        coverRetained: null,
        entries: [{
          kind: 'photo-retained',
          slot: { mediaId: retainedId, restoreUntil: retainedRow.restoreUntil, state: 'recoverable' },
        }],
        photoCount: 0,
        retainedCount: 1,
        sectionCount: 0,
        totalBytes: 0,
      } });
      return base(input, init);
    }));
    const router = createAppRouter([{
      pathname: `/manage/event/${MANAGED_EVENT.id}`,
      search: '?section=gallery&mode=album',
      state: { source: 'album-entry' },
    }]);
    const view = render(<RouterProvider router={router} />);

    await userEvent.setup().click(await screen.findByRole('button', {
      name: 'Restore in Recently deleted',
    }));

    const restore = await screen.findByRole('button', { name: 'Restore retained-photo.jpg' });
    expect(restore).toHaveFocus();
    expect(trashGets).toBe(1);
    await waitFor(() => expect(router.state.location.state).toEqual({ source: 'album-entry' }));

    screen.getByRole('button', { name: /^Recently deleted/ }).focus();
    await router.navigate(-1);
    await screen.findByLabelText('Album title');
    await router.navigate(1);
    expect(await screen.findByRole('button', { name: 'Restore retained-photo.jpg' })).not.toHaveFocus();
    expect(trashGets).toBe(1);

    view.unmount();
    const reload = createAppRouter([`/manage/event/${MANAGED_EVENT.id}`]);
    render(<RouterProvider router={reload} />);
    await userEvent.setup().click(await screen.findByRole('button', { name: /^Recently deleted/ }));
    expect(await screen.findByRole('button', { name: 'Restore retained-photo.jpg' })).not.toHaveFocus();
  });

  it('clears settled retained guidance when the host exhausts Load more', async () => {
    const requested: string[] = [];
    const base = managerLocationFetch();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/media/trash')) {
        requested.push(url);
        return url.includes('cursor=')
          ? json({ media: [], nextCursor: null })
          : json({ media: [{
              id: 'unrelated-first-page',
              originalFilename: 'unrelated-first-page.jpg',
              guestName: 'Avery',
              caption: 'Another retained photo',
              trashedAt: '2026-09-20T01:00:00.000Z',
              restoreUntil: '2099-10-19T00:00:00.000Z',
            }], nextCursor: 'later-trash-page' });
      }
      return base(input, init);
    }));
    const router = createAppRouter([{
      pathname: `/manage/event/${MANAGED_EVENT.id}`,
      state: managerIntentState({
        kind: 'open-recently-deleted',
        focusMediaId: 'retained-on-later-page',
      }),
    }]);
    render(<RouterProvider router={router} />);

    const heading = await screen.findByRole('heading', { name: 'Recently deleted' });
    await screen.findByText(/may be under Load more/u);
    expect(heading).toHaveFocus();
    expect(requested).toHaveLength(1);
    expect(requested[0]).not.toContain('cursor=');

    await userEvent.setup().click(screen.getByRole('button', { name: 'Load more' }));

    await waitFor(() => expect(requested).toHaveLength(2));
    expect(requested[1]).toContain('cursor=later-trash-page');
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    expect(screen.queryByText(/may be under Load more/u)).not.toBeInTheDocument();
  });

  it('keeps a preloaded page-2 retained target outside the bounded intent search', async () => {
    const retainedId = 'retained-only-on-page-2';
    const restoreUntil = '2099-10-19T00:00:00.000Z';
    const requested: string[] = [];
    const base = managerLocationFetch();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (url.endsWith(`/api/manage/events/${MANAGED_EVENT.id}`)) {
        return json({ event: { ...MANAGED_EVENT, recoverableMediaCount: 2 } });
      }
      if (url.includes('/media/trash') && method === 'GET') {
        requested.push(url);
        if (!url.includes('cursor=')) return json({ media: [{
          id: 'first-page-trash', originalFilename: 'first-page.jpg', guestName: 'Avery',
          caption: 'First page', trashedAt: '2026-09-20T01:00:00.000Z', restoreUntil,
        }], nextCursor: 'trash-page-2' });
        return json({ media: [{
          id: retainedId, originalFilename: 'page-two.jpg', guestName: 'Jamie',
          caption: 'Second page', trashedAt: '2026-09-20T02:00:00.000Z', restoreUntil,
        }], nextCursor: 'trash-page-3' });
      }
      if (url.endsWith('/album') && method === 'GET') return json({ album: {
        revision: 1, saved: true, title: 'Album', description: '', coverMediaId: null,
        effectiveCoverMediaId: null, coverRetained: null,
        entries: [{ kind: 'photo-retained', slot: {
          mediaId: retainedId, restoreUntil, state: 'recoverable',
        } }],
        photoCount: 0, retainedCount: 1, sectionCount: 0, totalBytes: 0,
      } });
      return base(input, init);
    }));
    const router = createAppRouter([`/manage/event/${MANAGED_EVENT.id}`]);
    render(<RouterProvider router={router} />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /^Recently deleted/ }));
    await screen.findByRole('button', { name: 'Restore first-page.jpg' });
    await user.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('button', { name: 'Restore page-two.jpg' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Gallery' }));
    await user.click(await screen.findByRole('button', { name: 'Album' }));
    await user.click(await screen.findByRole('button', { name: 'Restore in Recently deleted' }));

    const heading = await screen.findByRole('heading', { name: 'Recently deleted' });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByText(/may be under Load more/u)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Restore page-two.jpg' })).not.toHaveFocus();
    expect(requested).toHaveLength(2);
    expect(requested[0]).not.toContain('cursor=');
    expect(requested[1]).toContain('cursor=trash-page-2');
  });

  it('omits retained Load-more guidance after the host exhausts the continuation', async () => {
    const retainedId = 'retained-on-exhausted-page-2';
    const restoreUntil = '2099-10-19T00:00:00.000Z';
    const requested: string[] = [];
    const base = managerLocationFetch();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (url.endsWith(`/api/manage/events/${MANAGED_EVENT.id}`)) {
        return json({ event: { ...MANAGED_EVENT, recoverableMediaCount: 2 } });
      }
      if (url.includes('/media/trash') && method === 'GET') {
        requested.push(url);
        if (!url.includes('cursor=')) return json({ media: [{
          id: 'exhausted-first-page', originalFilename: 'exhausted-first.jpg', guestName: 'Avery',
          caption: 'First page', trashedAt: '2026-09-20T01:00:00.000Z', restoreUntil,
        }], nextCursor: 'exhausted-page-2' });
        return json({ media: [{
          id: retainedId, originalFilename: 'exhausted-second.jpg', guestName: 'Jamie',
          caption: 'Last page', trashedAt: '2026-09-20T02:00:00.000Z', restoreUntil,
        }], nextCursor: null });
      }
      if (url.endsWith('/album') && method === 'GET') return json({ album: {
        revision: 1, saved: true, title: 'Album', description: '', coverMediaId: null,
        effectiveCoverMediaId: null, coverRetained: null,
        entries: [{ kind: 'photo-retained', slot: {
          mediaId: retainedId, restoreUntil, state: 'recoverable',
        } }],
        photoCount: 0, retainedCount: 1, sectionCount: 0, totalBytes: 0,
      } });
      return base(input, init);
    }));
    const router = createAppRouter([`/manage/event/${MANAGED_EVENT.id}`]);
    render(<RouterProvider router={router} />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /^Recently deleted/ }));
    await screen.findByRole('button', { name: 'Restore exhausted-first.jpg' });
    await user.click(await screen.findByRole('button', { name: 'Load more' }));
    const secondPageRestore = await screen.findByRole('button', {
      name: 'Restore exhausted-second.jpg',
    });
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Gallery' }));
    await user.click(await screen.findByRole('button', { name: 'Album' }));
    await user.click(await screen.findByRole('button', { name: 'Restore in Recently deleted' }));

    const heading = await screen.findByRole('heading', { name: 'Recently deleted' });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(secondPageRestore).not.toHaveFocus();
    expect(screen.queryByText(/may be under Load more/u)).not.toBeInTheDocument();
    expect(requested).toHaveLength(2);
    expect(requested[0]).not.toContain('cursor=');
    expect(requested[1]).toContain('cursor=exhausted-page-2');
  });

  it('abandons a delayed retained intent when the host manually returns to Live intake', async () => {
    const retainedId = 'delayed-retained-row';
    const restoreUntil = '2099-10-19T00:00:00.000Z';
    let releaseFirstTrash!: () => void;
    let trashGets = 0;
    const base = managerLocationFetch();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/media/trash')) {
        trashGets += 1;
        if (trashGets === 1) {
          return new Promise<Response>((resolve) => {
            releaseFirstTrash = () => void json({ media: [{
              id: retainedId, originalFilename: 'delayed.jpg', guestName: 'Avery',
              caption: 'Delayed row', trashedAt: '2026-09-20T01:00:00.000Z', restoreUntil,
            }], nextCursor: 'never-requested' }).then(resolve);
          });
        }
        return json({ media: [{
          id: retainedId, originalFilename: 'delayed.jpg', guestName: 'Avery',
          caption: 'Delayed row', trashedAt: '2026-09-20T01:00:00.000Z', restoreUntil,
        }], nextCursor: 'still-not-requested' });
      }
      return base(input, init);
    }));
    const router = createAppRouter([{
      pathname: `/manage/event/${MANAGED_EVENT.id}`,
      state: managerIntentState({ kind: 'open-recently-deleted', focusMediaId: retainedId }),
    }]);
    render(<RouterProvider router={router} />);
    const user = userEvent.setup();
    await waitFor(() => expect(releaseFirstTrash).toBeTypeOf('function'));

    await user.click(screen.getByRole('button', { name: 'Live intake' }));
    await screen.findByRole('heading', { name: 'Live intake' });
    await act(async () => { releaseFirstTrash(); });
    await user.click(screen.getByRole('button', { name: 'Recently deleted' }));

    const restore = await screen.findByRole('button', { name: 'Restore delayed.jpg' });
    expect(restore).not.toHaveFocus();
    expect(screen.queryByText(/may be under Load more/u)).not.toBeInTheDocument();
    expect(trashGets).toBe(2);
  });

  it('Guest gallery Settings round trip cleans each intent, waits for save, and restores Hidden focus once', async () => {
    const fixture = guestGallerySettingsFetch({ deferSettings: true });
    onTestFinished(fixture.releaseSettings);
    vi.stubGlobal('fetch', fixture.fetchMock);
    const router = createAppRouter([{
      pathname: `/manage/event/${MANAGED_EVENT.id}`,
      search: '?section=gallery&mode=guest-gallery',
      state: { source: 'guest-settings-entry' },
    }]);
    const view = render(<RouterProvider router={router} />);
    const user = userEvent.setup();

    const filters = await screen.findByRole('group', { name: 'Publication status' });
    await user.click(within(filters).getByRole('button', { name: 'Hidden' }));
    const selected = await screen.findByRole('checkbox', { name: /Select /u });
    await user.click(selected);
    expect(selected).toBeChecked();

    await user.click(screen.getByRole('button', { name: 'Open settings' }));

    const availability = await screen.findByLabelText('Show the optional shared gallery');
    const returnAction = await screen.findByRole('button', { name: 'Return to Guest gallery' });
    expect(availability).toHaveFocus();
    await waitFor(() => expect(
      (router.state.location.state as RouterHistoryState | null)
        ?.__candidaryManager?.intent,
    ).toBeUndefined());
    expect(router.state.location.state).toMatchObject({ source: 'guest-settings-entry' });
    expect(router.state.location.state).not.toHaveProperty('selection');
    expect((router.state.location.state as RouterHistoryState)
      .__candidaryManager ?? {}).not.toHaveProperty('selection');

    await user.click(screen.getByLabelText('Review guestbook notes before sharing'));
    await fixture.settingsStarted;
    await user.click(returnAction);

    expect(router.state.location.search).toBe('?section=settings');
    expect(returnAction).toBeVisible();

    await act(async () => {
      fixture.releaseSettings();
      await Promise.resolve();
    });

    await waitFor(() => expect(router.state.location.search)
      .toBe('?section=gallery&mode=guest-gallery'));
    const restoredFilters = await screen.findByRole('group', { name: 'Publication status' });
    expect(within(restoredFilters).getByRole('button', { name: 'Hidden' }))
      .toHaveAttribute('aria-pressed', 'true');
    const openSettings = screen.getByRole('button', { name: 'Open settings' });
    await waitFor(() => expect(openSettings).toHaveFocus());
    expect(screen.getByText('Selection cleared.')).toBeInTheDocument();
    expect(screen.getByText(`0 of ${MANAGER_BULK_SELECTION_MAX} selected`)).toBeVisible();
    expect((router.state.location.state as RouterHistoryState)
      .__candidaryManager?.intent).toBeUndefined();
    expect(router.state.location.state).toMatchObject({ source: 'guest-settings-entry' });
    expect(router.state.location.state).not.toHaveProperty('selection');

    await router.navigate(-1);
    await screen.findByRole('heading', { name: 'Settings' });
    expect(screen.queryByRole('button', { name: 'Return to Guest gallery' }))
      .not.toBeInTheDocument();
    expect(screen.getByLabelText('Show the optional shared gallery')).not.toHaveFocus();

    await router.navigate(1);
    await waitFor(() => expect(router.state.location.search)
      .toBe('?section=gallery&mode=guest-gallery'));
    expect(await screen.findByRole('button', { name: 'Open settings' })).not.toHaveFocus();

    await router.navigate(-1);
    await screen.findByRole('heading', { name: 'Settings' });
    const reloadTarget = router.state.location.pathname + router.state.location.search;
    view.unmount();
    const reloaded = createAppRouter([reloadTarget]);
    render(<RouterProvider router={reloaded} />);

    await screen.findByRole('heading', { name: 'Settings' });
    expect(screen.queryByRole('button', { name: 'Return to Guest gallery' }))
      .not.toBeInTheDocument();
    expect(screen.getByLabelText('Show the optional shared gallery')).not.toHaveFocus();
  });

  it('retires a live Guest gallery Return token before a newer same-Settings cleanup settles', async () => {
    const fixture = guestGallerySettingsFetch();
    vi.stubGlobal('fetch', fixture.fetchMock);
    const router = createAppRouter([{
      pathname: `/manage/event/${MANAGED_EVENT.id}`,
      search: '?section=gallery&mode=guest-gallery',
    }]);
    const originalNavigate = router.navigate.bind(router);
    let holdNewerCleanup = false;
    let cleanupCalls = 0;
    let rejectFirstCleanup!: (reason: Error) => void;
    let rejectSecondCleanup!: (reason: Error) => void;
    let markFirstCleanupStarted!: () => void;
    let markSecondCleanupStarted!: () => void;
    const firstCleanupStarted = new Promise<void>((resolve) => {
      markFirstCleanupStarted = resolve;
    });
    const secondCleanupStarted = new Promise<void>((resolve) => {
      markSecondCleanupStarted = resolve;
    });
    vi.spyOn(router, 'navigate').mockImplementation((to, options) => {
      if (holdNewerCleanup && options?.replace) {
        cleanupCalls += 1;
        return new Promise<void>((_resolve, reject) => {
          if (cleanupCalls === 1) {
            rejectFirstCleanup = reject;
            markFirstCleanupStarted();
          } else {
            rejectSecondCleanup = reject;
            markSecondCleanupStarted();
          }
        });
      }
      return originalNavigate(to, options);
    });
    render(<RouterProvider router={router} />);
    const user = userEvent.setup();

    const filters = await screen.findByRole('group', { name: 'Publication status' });
    await user.click(within(filters).getByRole('button', { name: 'Hidden' }));
    await user.click(screen.getByRole('button', { name: 'Open settings' }));
    const oldReturn = await screen.findByRole('button', { name: 'Return to Guest gallery' });
    holdNewerCleanup = true;

    act(() => {
      void originalNavigate({
        pathname: `/manage/event/${MANAGED_EVENT.id}`,
        search: '?section=settings',
      }, {
        state: managerIntentState({
          kind: 'edit-guest-gallery-availability',
          returnTo: {
            section: 'gallery',
            mode: 'guest-gallery',
            publicationFilter: 'published',
          },
        }),
      });
    });
    await firstCleanupStarted;

    expect(screen.queryByRole('button', { name: 'Return to Guest gallery' }))
      .not.toBeInTheDocument();
    expect(oldReturn.isConnected).toBe(false);
    expect(router.state.location.search).toBe('?section=settings');
    expect((router.state.location.state as RouterHistoryState)
      .__candidaryManager?.intent).toMatchObject({
        kind: 'edit-guest-gallery-availability',
        returnTo: { publicationFilter: 'published' },
      });

    await act(async () => {
      rejectFirstCleanup(new Error('newer Settings cleanup rejected once'));
      await secondCleanupStarted;
    });
    expect(cleanupCalls).toBe(2);
    expect(screen.queryByRole('button', { name: 'Return to Guest gallery' }))
      .not.toBeInTheDocument();

    await act(async () => {
      rejectSecondCleanup(new Error('newer Settings cleanup rejected twice'));
      await Promise.resolve();
    });
    expect(router.state.location.search).toBe('?section=settings');
    expect(screen.queryByRole('button', { name: 'Return to Guest gallery' }))
      .not.toBeInTheDocument();
  });

  it('keeps the Guest gallery Return token when Stay and fix settings cancels an invalid return', async () => {
    const fixture = guestGallerySettingsFetch();
    vi.stubGlobal('fetch', fixture.fetchMock);
    const router = createAppRouter([{
      pathname: `/manage/event/${MANAGED_EVENT.id}`,
      search: '?section=gallery&mode=guest-gallery',
    }]);
    render(<RouterProvider router={router} />);
    const user = userEvent.setup();

    const filters = await screen.findByRole('group', { name: 'Publication status' });
    await user.click(within(filters).getByRole('button', { name: 'Hidden' }));
    await user.click(screen.getByRole('button', { name: 'Open settings' }));
    const returnAction = await screen.findByRole('button', { name: 'Return to Guest gallery' });
    const name = screen.getByLabelText('Event name');
    await user.clear(name);
    fireEvent.blur(name);
    expect(name).toHaveAttribute('aria-invalid', 'true');

    await user.click(returnAction);
    const prompt = await screen.findByRole('region', { name: /not saved yet/iu });
    expect(router.state.location.search).toBe('?section=settings');
    expect(fixture.fetchMock.mock.calls.filter(([input, init]) => (
      new URL(String(input), 'https://candidary.test').pathname.endsWith('/settings')
      && String(init?.method ?? 'GET').toUpperCase() === 'PATCH'
    ))).toHaveLength(0);

    await user.click(within(prompt).getByRole('button', { name: 'Stay and fix settings' }));

    expect(await screen.findByRole('button', { name: 'Return to Guest gallery' })).toBeVisible();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Settings' })).toHaveFocus());
    expect(router.state.location.search).toBe('?section=settings');
    expect(fixture.fetchMock.mock.calls.filter(([input, init]) => (
      new URL(String(input), 'https://candidary.test').pathname.endsWith('/settings')
      && String(init?.method ?? 'GET').toUpperCase() === 'PATCH'
    ))).toHaveLength(0);

    await user.type(name, 'Maya & Theo repaired');
    fireEvent.blur(name);
    await waitFor(() => expect(fixture.fetchMock.mock.calls.filter(([input, init]) => (
      new URL(String(input), 'https://candidary.test').pathname.endsWith('/settings')
      && String(init?.method ?? 'GET').toUpperCase() === 'PATCH'
    ))).toHaveLength(1));
    await waitFor(() => expect(name).not.toHaveAttribute('aria-invalid', 'true'));

    let openSettingsFocusCount = 0;
    const recordOpenSettingsFocus = (event: FocusEvent) => {
      if ((event.target as HTMLElement | null)?.textContent === 'Open settings') {
        openSettingsFocusCount += 1;
      }
    };
    document.addEventListener('focusin', recordOpenSettingsFocus);
    onTestFinished(() => document.removeEventListener('focusin', recordOpenSettingsFocus));
    await user.click(screen.getByRole('button', { name: 'Return to Guest gallery' }));

    await waitFor(() => expect(router.state.location.search)
      .toBe('?section=gallery&mode=guest-gallery'));
    const restoredFilters = await screen.findByRole('group', { name: 'Publication status' });
    expect(within(restoredFilters).getByRole('button', { name: 'Hidden' }))
      .toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open settings' }))
      .toHaveFocus());
    expect(openSettingsFocusCount).toBe(1);
  });

  it('Guest gallery Settings drops its return token after unrelated navigation', async () => {
    const fixture = guestGallerySettingsFetch();
    vi.stubGlobal('fetch', fixture.fetchMock);
    const router = createAppRouter([
      `/manage/event/${MANAGED_EVENT.id}?section=gallery&mode=guest-gallery`,
    ]);
    render(<RouterProvider router={router} />);
    const user = userEvent.setup();

    const filters = await screen.findByRole('group', { name: 'Publication status' });
    await user.click(within(filters).getByRole('button', { name: 'Hidden' }));
    await user.click(screen.getByRole('button', { name: 'Open settings' }));
    expect(await screen.findByRole('button', { name: 'Return to Guest gallery' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Share' }));
    await screen.findByRole('heading', { name: 'Share your event' });
    await router.navigate(-1);

    await screen.findByRole('heading', { name: 'Settings' });
    expect(screen.queryByRole('button', { name: 'Return to Guest gallery' }))
      .not.toBeInTheDocument();
    expect(screen.getByLabelText('Show the optional shared gallery')).not.toHaveFocus();
  });

  it.each([
    ['malformed', {
      source: 'malformed-settings-intent',
      __candidaryManager: {
        version: 1,
        eventId: MANAGED_EVENT.id,
        intent: {
          kind: 'edit-guest-gallery-availability',
          returnTo: { section: 'gallery', mode: 'guest-gallery', publicationFilter: 'future' },
        },
      },
    }],
    ['cross-event', managerIntentState({
      kind: 'edit-guest-gallery-availability',
      returnTo: { section: 'gallery', mode: 'guest-gallery', publicationFilter: 'hidden' },
    }, 'event-b')],
  ] as const)(
    'Guest gallery Settings rejects a %s return token without availability focus',
    async (_kind, state) => {
      const fixture = guestGallerySettingsFetch();
      vi.stubGlobal('fetch', fixture.fetchMock);
      const router = createAppRouter([{
        pathname: `/manage/event/${MANAGED_EVENT.id}`,
        search: '?section=settings',
        state,
      }]);
      render(<RouterProvider router={router} />);

      await screen.findByRole('heading', { name: 'Settings' });
      expect(screen.queryByRole('button', { name: 'Return to Guest gallery' }))
        .not.toBeInTheDocument();
      expect(screen.getByLabelText('Show the optional shared gallery')).not.toHaveFocus();
      await waitFor(() => expect(router.state.location.state).toEqual({ source: state.source }));
    },
  );

  it.each([
    ['malformed', {
      source: 'malformed',
      __candidaryManager: {
        version: 1,
        eventId: MANAGED_EVENT.id,
        intent: { kind: 'open-recently-deleted', focusMediaId: '' },
      },
    }],
    ['cross-event', managerIntentState(
      { kind: 'open-recently-deleted', focusMediaId: 'retained-first-page' },
      'event-b',
    )],
  ] as const)(
    'sanitizes a %s retained marker intent without focus side effects',
    async (_kind, state) => {
      vi.stubGlobal('fetch', managerLocationFetch());
      const router = createAppRouter([{
        pathname: `/manage/event/${MANAGED_EVENT.id}`,
        state,
      }]);
      render(<RouterProvider router={router} />);

      const heading = await screen.findByRole('heading', { name: 'Live intake' });
      expect(heading).not.toHaveFocus();
      expect(screen.queryByText(/may be under Load more/u)).not.toBeInTheDocument();
      await waitFor(() => expect(router.state.location.state).toEqual({ source: state.source }));
    },
  );
});

describe('manager resource ownership', () => {
  it('returns synchronous ownership for a current capture and rejects a retired one', async () => {
    const onResult = vi.fn();
    render(<ResourceCaptureHarness onResult={onResult} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Exercise capture' }));
    expect(onResult).toHaveBeenCalledWith(true, false);
    expect(screen.getByLabelText('Captured value')).toHaveTextContent('2');
  });

  it('composes a current deferred capture with a newer queued projection', async () => {
    render(<DeferredResourceCaptureHarness />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Compose deferred capture' }));
    expect(screen.getByLabelText('Deferred captured value')).toHaveTextContent('2');
  });
});

function previewSources() {
  return Array.from(document.querySelectorAll('.moderation-grid img'), (image) => image.getAttribute('src'));
}

describe('manager experience', () => {
  it('uses the event zone formatter for the Manager header, retention, and Intake schedule', async () => {
    const boundaryEvent: EventView = {
      ...MANAGED_EVENT,
      eventDate: '2026-03-07',
      eventStartAt: '2026-03-08T05:30:00.000Z',
      purgeAfter: '2026-11-01T04:30:00.000Z',
    };
    const base = managerFetch({ first: { media: [], nextCursor: null } });
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => (
      String(input).endsWith('/api/manage/events/event-a')
        ? json({ event: boundaryEvent })
        : base(input)
    )));

    const original = process.env.TZ;
    try {
      process.env.TZ = 'UTC';
      render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
      await screen.findByRole('heading', { name: 'Live intake' });

      expect(document.querySelector('.manager-title p')).toHaveTextContent('March 7, 2026');
      expect(screen.getByText(/Files delete/)).toHaveTextContent(
        'Files delete October 31, 2026 at 11:30 PM CDT',
      );

      await userEvent.setup().click(within(screen.getByRole('navigation', { name: 'Manager sections' }))
        .getByRole('button', { name: /settings/i }));
      const schedule = screen.getByText(/Event start:/u);
      expect(schedule).toHaveTextContent(
        'Event start: March 7, 2026 at 11:30 PM CST (America/Chicago).',
      );
      expect(schedule).not.toHaveTextContent('–');
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it('renders unavailable literals for invalid event zone values instead of normalizing them', async () => {
    const invalidEvent: EventView = {
      ...MANAGED_EVENT,
      eventDate: '2026-02-30',
      eventStartAt: '2026-09-19T05:00:00',
      purgeAfter: '2026-02-30T05:00:00Z',
    };
    const base = managerFetch({ first: { media: [], nextCursor: null } });
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => (
      String(input).endsWith('/api/manage/events/event-a')
        ? json({ event: invalidEvent })
        : base(input)
    )));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await screen.findByRole('heading', { name: 'Live intake' });

    expect(document.querySelector('.manager-title p')).toHaveTextContent('Date unavailable');
    expect(screen.getByText(/Files delete/)).toHaveTextContent('Files delete Time unavailable');

    await userEvent.setup().click(within(screen.getByRole('navigation', { name: 'Manager sections' }))
      .getByRole('button', { name: /settings/i }));
    expect(screen.getByText(/Event start:/u)).toHaveTextContent(
      'Event start: Time unavailable (America/Chicago).',
    );
  });

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

  it('owns one audience summary before Gallery opens without duplicating it across section remounts', async () => {
    const fetchMock = managerFetch({ first: { media: [], nextCursor: null } });
    vi.stubGlobal('fetch', fetchMock);

    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);

    const navigation = await screen.findByRole('navigation', { name: 'Manager sections' });
    expect(within(navigation).getByRole('button', { name: 'Guestbook' })).toBeVisible();
    const requested = () => fetchMock.mock.calls.map(([input]) => String(input));
    expect(requested().filter((url) => url.endsWith('/guestbook/summary'))).toHaveLength(1);
    expect(requested().filter((url) => url.endsWith('/gallery/summary'))).toHaveLength(1);
    expect(requested().some((url) => url.endsWith('/messages'))).toBe(false);
    expect(requested().some((url) => /\/guestbook(?:\?|$)/u.test(url))).toBe(false);

    const user = userEvent.setup();
    await user.click(within(navigation).getByRole('button', { name: 'Gallery' }));
    expect(await screen.findByText('Album: 0 photos · Link: Off · Guest gallery: On, 0 published'))
      .toBeVisible();
    await user.click(within(navigation).getByRole('button', { name: 'Share' }));
    await user.click(within(navigation).getByRole('button', { name: 'Gallery' }));
    expect(await screen.findByText('Album: 0 photos · Link: Off · Guest gallery: On, 0 published'))
      .toBeVisible();
    expect(requested().filter((url) => url.endsWith('/gallery/summary'))).toHaveLength(1);
  });

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
    const prompt = await screen.findByRole('region', { name: /not saved yet/i });
    await user.click(within(prompt).getByRole('button', { name: 'Leave now' }));
    // Mounted but out of the way. `getByLabelText` deliberately still finds a
    // hidden control, so this has to assert visibility rather than presence.
    await waitFor(() => expect(screen.getByLabelText('Event name')).not.toBeVisible());
    expect(document.querySelector('.manager-panel[hidden]')).toHaveAttribute('inert');
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
    expect(screen.getByTestId('event-appearance-canvas')).toHaveStyle({ '--event-primary': '#4a2415' });
  });

  it('reconciles a confirmed galleryVisible change into an already-open Gallery summary', async () => {
    let releaseSettings!: () => void;
    const settingsGate = new Promise<void>((resolve) => { releaseSettings = resolve; });
    let settingsStarted = false;
    let summaryVisible = true;
    let summaryReads = 0;
    const base = managerFetch({ first: { media: [], nextCursor: null } });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/settings') && method === 'PATCH') {
        settingsStarted = true;
        await settingsGate;
        return json({ event: { ...MANAGED_EVENT, galleryVisible: false } });
      }
      if (url.endsWith('/gallery/summary')) {
        summaryReads += 1;
        return json({ summary: {
          albumPhotoCount: 0,
          albumEntryCount: 0,
          albumLink: { active: false, sharedAt: null },
          guestGalleryVisible: summaryVisible,
          guestGalleryPublishedCount: 0,
        } });
      }
      return base(input);
    }));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    const user = userEvent.setup();
    const navigation = await screen.findByRole('navigation', { name: 'Manager sections' });
    await user.click(within(navigation).getByRole('button', { name: /settings/i }));
    await user.click(screen.getByLabelText('Show the optional shared gallery'));
    await waitFor(() => expect(settingsStarted).toBe(true));

    await user.click(within(navigation).getByRole('button', { name: /gallery/i }));
    const prompt = await screen.findByRole('region', { name: /not saved yet/i });
    await user.click(within(prompt).getByRole('button', { name: 'Leave now' }));
    expect(await screen.findByText(
      'Album: 0 photos · Link: Off · Guest gallery: On, 0 published',
    )).toBeVisible();
    expect(summaryReads).toBe(1);
    summaryVisible = false;
    releaseSettings();

    expect(await screen.findByText(
      'Album: 0 photos · Link: Off · Guest gallery: Off, 0 published',
    )).toBeVisible();
    expect(summaryReads).toBe(2);
  });

  it('does not invalidate the Gallery summary when confirmed settings preserve galleryVisible', async () => {
    let releaseSettings!: () => void;
    const settingsGate = new Promise<void>((resolve) => { releaseSettings = resolve; });
    let settingsStarted = false;
    let summaryReads = 0;
    const base = managerFetch({ first: { media: [], nextCursor: null } });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/settings') && method === 'PATCH') {
        settingsStarted = true;
        await settingsGate;
        return json({ event: { ...MANAGED_EVENT, name: 'Renamed' } });
      }
      if (url.endsWith('/gallery/summary')) {
        summaryReads += 1;
        return json({ summary: {
          albumPhotoCount: 0,
          albumEntryCount: 0,
          albumLink: { active: false, sharedAt: null },
          guestGalleryVisible: true,
          guestGalleryPublishedCount: 0,
        } });
      }
      return base(input);
    }));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    const user = userEvent.setup();
    const navigation = await screen.findByRole('navigation', { name: 'Manager sections' });
    await user.click(within(navigation).getByRole('button', { name: /settings/i }));
    fireEvent.change(screen.getByLabelText('Event name'), { target: { value: 'Renamed' } });
    fireEvent.blur(screen.getByLabelText('Event name'));
    await waitFor(() => expect(settingsStarted).toBe(true));

    await user.click(within(navigation).getByRole('button', { name: /gallery/i }));
    const prompt = await screen.findByRole('region', { name: /not saved yet/i });
    await user.click(within(prompt).getByRole('button', { name: 'Leave now' }));
    await screen.findByText('Album: 0 photos · Link: Off · Guest gallery: On, 0 published');
    releaseSettings();
    await screen.findByRole('heading', { level: 1, name: 'Renamed' });

    expect(summaryReads).toBe(1);
  });

  it('invalidates an already-open Gallery summary only after parent trash succeeds', async () => {
    const row: MediaView = {
      id: 'trash-summary-row',
      originalFilename: 'trash-summary-row.jpg',
      guestName: 'Avery',
      caption: 'Audience boundary',
      publicationStatus: 'published',
      uploadState: 'stored',
    };
    let releaseTrash!: () => void;
    const trashGate = new Promise<void>((resolve) => { releaseTrash = resolve; });
    let trashStarted = false;
    let summaryReads = 0;
    const base = managerFetch({ first: { media: [row], nextCursor: null } });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/media/trash-summary-row/trash') && method === 'POST') {
        trashStarted = true;
        await trashGate;
        return json({ media: {
          ...row,
          trashedAt: '2026-09-20T01:00:00.000Z',
          restoreUntil: '2026-10-19T00:00:00.000Z',
        } });
      }
      if (url.endsWith('/gallery/summary')) {
        summaryReads += 1;
        return json({ summary: {
          albumPhotoCount: 1,
          albumEntryCount: 1,
          albumLink: { active: false, sharedAt: null },
          guestGalleryVisible: true,
          guestGalleryPublishedCount: 1,
        } });
      }
      return base(input);
    }));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    const user = userEvent.setup();
    const navigation = await screen.findByRole('navigation', { name: 'Manager sections' });
    await user.click(await screen.findByRole('button', {
      name: 'Move trash-summary-row.jpg to Recently deleted',
    }));
    await user.click(within(await screen.findByRole('dialog'))
      .getByRole('button', { name: 'Move to Recently deleted' }));
    await waitFor(() => expect(trashStarted).toBe(true));

    fireEvent.click(within(navigation).getByRole('button', { name: /gallery/i }));
    await waitFor(() => expect(summaryReads).toBe(1));
    releaseTrash();

    await waitFor(() => expect(summaryReads).toBe(2));
  });

  it('invalidates an already-open Gallery summary only after parent Restore succeeds', async () => {
    const row = {
      id: 'restore-summary-row',
      originalFilename: 'restore-summary-row.jpg',
      guestName: 'Avery',
      caption: 'Restored audience',
      trashedAt: '2026-09-20T01:00:00.000Z',
      restoreUntil: '2099-10-19T00:00:00.000Z',
    };
    let releaseRestore!: () => void;
    const restoreGate = new Promise<void>((resolve) => { releaseRestore = resolve; });
    let restoreStarted = false;
    let summaryReads = 0;
    const base = managerFetch({ first: { media: [], nextCursor: null } });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/api/manage/events/event-a')) {
        return json({ event: { ...MANAGED_EVENT, recoverableMediaCount: 1 } });
      }
      if (url.endsWith('/media/trash') && method === 'GET') {
        return json({ media: [row], nextCursor: null });
      }
      if (url.endsWith('/media/restore-summary-row/restore') && method === 'POST') {
        restoreStarted = true;
        await restoreGate;
        return json({ media: { ...row, trashedAt: null, restoreUntil: null } });
      }
      if (url.endsWith('/gallery/summary')) {
        summaryReads += 1;
        return json({ summary: {
          albumPhotoCount: 0,
          albumEntryCount: 0,
          albumLink: { active: false, sharedAt: null },
          guestGalleryVisible: true,
          guestGalleryPublishedCount: 0,
        } });
      }
      return base(input);
    }));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    const user = userEvent.setup();
    const navigation = await screen.findByRole('navigation', { name: 'Manager sections' });
    await user.click(await screen.findByRole('button', { name: /Recently deleted/ }));
    await user.click(await screen.findByRole('button', {
      name: 'Restore restore-summary-row.jpg',
    }));
    await waitFor(() => expect(restoreStarted).toBe(true));

    fireEvent.click(within(navigation).getByRole('button', { name: /gallery/i }));
    await waitFor(() => expect(summaryReads).toBe(1));
    releaseRestore();

    await waitFor(() => expect(summaryReads).toBe(2));
  });

  it('drops a whole-event read that a later write overtook', async () => {
    const gardenTheme = resolveEventTheme({ version: 1, presetId: 'garden-party', overrides: {} });
    let releaseRead: (() => void) | null = null;
    let reads = 0;
    const interval = vi.spyOn(window, 'setInterval');
    const fetchMock = managerFetch({ first: { media: makeMedia(1), nextCursor: null } });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/api/manage/events/event-a') && method === 'GET') {
        reads += 1;
    // Hold the read that the Intake poll opened, so a theme write can
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

    const poll = interval.mock.calls.filter(([, delay]) => delay === 5_000).at(-1)?.[0] as (() => void) | undefined;
    poll?.();
    await waitFor(() => expect(reads).toBe(2));

    await user.click(within(navigation).getByRole('button', { name: /settings/i }));
    await user.click(screen.getByRole('radio', { name: 'Garden Party' }));
    await waitFor(() => expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some(([input, init]) => (
      String(input).endsWith('/theme') && String(init?.method).toUpperCase() === 'PUT'
    ))).toBe(true));
    await waitFor(() => expect(screen.getByTestId('event-appearance-canvas'))
      .toHaveStyle({ '--event-primary': '#245c46' }));

    releaseRead!();
    // The overtaken read carries the pre-write theme. Adopting it would put the
    // old appearance back and then feed it into the next complete write.
    await waitFor(() => expect(screen.getByTestId('event-appearance-canvas'))
      .toHaveStyle({ '--event-primary': '#245c46' }));
    expect(screen.getByTestId('event-appearance-canvas')).toHaveStyle({ '--event-primary': '#245c46' });
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

    // Query ownership clears old rows and its cursor immediately. Rendering
    // unfiltered cards while the new question is pending would make its cursor
    // spendable against the wrong filter.
    expect(document.querySelectorAll('.moderation-grid img')).toHaveLength(0);
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

  it('silently drops a retired Intake continuation failure after a confirmed mutation', async () => {
    const row: MediaView = {
      id: 'intake-retire-row', originalFilename: 'intake-retire-row.jpg', guestName: 'Avery',
      caption: 'Retire Intake', publicationStatus: 'unpublished', uploadState: 'stored',
    };
    let releaseStalePage!: () => void;
    let trashed = false;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.includes('cursor=intake-retire-cursor')) {
        return new Promise<Response>((resolve) => {
          releaseStalePage = () => void errorJson({
            code: 'INTERNAL_ERROR', message: 'Stale Intake continuation failed.', requestId: 'request-stale-intake',
          }, 500).then(resolve);
        });
      }
      if (url.endsWith('/media/intake-retire-row/trash') && method === 'POST') {
        trashed = true;
        return json({ media: {
          ...row,
          trashedAt: '2026-09-20T01:00:00.000Z',
          restoreUntil: '2026-10-19T00:00:00.000Z',
        } });
      }
      if (url.endsWith('/api/manage/events/event-a')) return json({ event: MANAGED_EVENT });
      if (url.endsWith('/guestbook/summary')) return json({ summary: {
        needsReviewCount: 0, sharedCount: 0, hiddenCount: 0, deletedCount: 0, galleryVisible: true,
      } });
      if (url.includes('/media')) return json({
        media: trashed ? [] : [row],
        nextCursor: trashed ? null : 'intake-retire-cursor',
      });
      if (url.includes('/gallery')) return json({ media: [], nextCursor: null });
      if (url.includes('/messages')) return json({ messages: [] });
      if (url.endsWith('/exports')) return json({ exports: [] });
      if (url.endsWith('/entry')) return json({ eventLink: null, disabledAt: null });
      throw new Error(`Unexpected request ${method} ${url}`);
    }));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Live intake' });
    await user.click(await screen.findByRole('button', { name: 'Load more photos' }));
    await waitFor(() => expect(releaseStalePage).toBeTypeOf('function'));

    // A confirmed Intake mutation retires the page capture while the older
    // continuation is still held. Its retryable answer must then be silent.
    await user.click(screen.getByRole('button', { name: 'Move intake-retire-row.jpg to Recently deleted' }));
    await user.click(within(await screen.findByRole('dialog'))
      .getByRole('button', { name: 'Move to Recently deleted' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Move intake-retire-row.jpg to Recently deleted' }))
      .not.toBeInTheDocument());
    await act(async () => { releaseStalePage(); });

    expect(screen.queryByText('Stale Intake continuation failed.')).not.toBeInTheDocument();
    expect(screen.queryByText('Retire Intake')).not.toBeInTheDocument();
  });

  it('keeps newer Intake feedback when a retired continuation succeeds', async () => {
    const row: MediaView = {
      id: 'intake-success-row', originalFilename: 'intake-success-row.jpg', guestName: 'Avery',
      caption: 'Retire Intake success', publicationStatus: 'unpublished', uploadState: 'stored',
    };
    let releaseStalePage!: () => void;
    let trashed = false;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.includes('cursor=intake-success-cursor')) {
        return new Promise<Response>((resolve) => {
          releaseStalePage = () => void json({ media: [], nextCursor: null }).then(resolve);
        });
      }
      if (url.endsWith('/media/intake-success-row/trash') && method === 'POST') {
        trashed = true;
        return json({ media: {
          ...row,
          trashedAt: '2026-09-20T01:00:00.000Z',
          restoreUntil: '2026-10-19T00:00:00.000Z',
        } });
      }
      if (url.endsWith('/api/manage/events/event-a')) return json({ event: MANAGED_EVENT });
      if (url.endsWith('/guestbook/summary')) return json({ summary: {
        needsReviewCount: 0, sharedCount: 0, hiddenCount: 0, deletedCount: 0, galleryVisible: true,
      } });
      if (url.includes('/media')) return json({
        media: trashed ? [] : [row],
        nextCursor: trashed ? null : 'intake-success-cursor',
      });
      if (url.includes('/gallery')) return json({ media: [], nextCursor: null });
      if (url.includes('/messages')) return json({ messages: [] });
      if (url.endsWith('/exports')) return json({ exports: [] });
      if (url.endsWith('/entry')) {
        return json({ eventLink: 'https://example.test/join#entry-id.entry-secret', disabledAt: null });
      }
      throw new Error(`Unexpected request ${method} ${url}`);
    }));
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('Clipboard rejected'));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Live intake' });
    await user.click(await screen.findByRole('button', { name: 'Load more photos' }));
    await waitFor(() => expect(releaseStalePage).toBeTypeOf('function'));

    await user.click(screen.getByRole('button', { name: 'Move intake-success-row.jpg to Recently deleted' }));
    await user.click(within(await screen.findByRole('dialog'))
      .getByRole('button', { name: 'Move to Recently deleted' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Move intake-success-row.jpg to Recently deleted' }))
      .not.toBeInTheDocument());

    await user.click(screen.getAllByRole('button', { name: 'Copy event link' })[0]!);
    expect(await screen.findByRole('alert')).toHaveTextContent('The event link could not be copied.');
    await act(async () => { releaseStalePage(); });

    // The page is retired by the trash projection, so its success cannot clear
    // an unrelated action that happened after that mutation.
    expect(screen.getByRole('alert')).toHaveTextContent('The event link could not be copied.');
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

  it('keeps the manager view in place when a bulk publish, hide, or export fails', async () => {
    const rows = makeMedia(3).slice(1);
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? 'GET').toUpperCase() !== 'GET') {
        return errorJson({ code: 'MEDIA_STATE_CONFLICT', message: 'That photo changed before your update.', requestId: 'request-a' }, 409);
      }
      if (url.endsWith('/api/manage/events/event-a')) return json({ event: MANAGED_EVENT });
      if (url.includes('/media')) return json({ media: rows, nextCursor: null });
      if (url.endsWith('/gallery/summary')) return galleryAudienceSummaryJson();
      if (url.includes('/gallery')) return json({ media: [], nextCursor: null });
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
    await user.click(await screen.findByRole('button', { name: 'Guest gallery' }));
    await waitFor(() => expect(document.querySelectorAll('.moderation-grid article')).toHaveLength(2));

    async function expectRecoverableFailure(label: string, act_: () => Promise<void>, heading: string) {
      await act_();
      expect(await screen.findByRole('alert'), label).toHaveTextContent('That photo changed before your update.');
      expect(screen.getByRole('heading', { name: heading }), label).toBeVisible();
      expect(document.querySelectorAll('.moderation-grid article'), label).toHaveLength(2);
    }

    await user.click(screen.getByRole('checkbox', { name: 'Select Moment 2' }));
    await expectRecoverableFailure(
      'bulk publish',
      () => user.click(screen.getByRole('button', { name: 'Publish selected' })),
      'Gallery',
    );
    await expectRecoverableFailure(
      'hide',
      () => user.click(screen.getByRole('button', { name: 'Hide selected' })),
      'Gallery',
    );
    await user.click(screen.getByRole('button', { name: 'Library' }));
    await user.click(await screen.findByRole('button', { name: 'Download all' }));
    expect(await screen.findByRole('alert'), 'export').toHaveTextContent('That photo changed before your update.');
    expect(screen.getByRole('heading', { name: 'Gallery' }), 'export').toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Dismiss error' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Gallery' })).toBeVisible();
  });

  /**
   * The export card is the one place a host waits on work they cannot see, and its poll
   * only lives while the job is queued or running. Both ways of losing that poll are
   * silent by construction, so both are pinned here.
   */
  it('keeps one export poll and live owner running outside Gallery until the job is terminal', async () => {
    const exportJob = (state: 'queued' | 'running' | 'ready'): ExportView => ({
      id: 'export-global',
      kind: 'complete',
      state,
      snapshotAt: '2026-09-20T00:00:00.000Z',
      createdAt: '2026-09-20T00:00:01.000Z',
      startedAt: state === 'queued' ? null : '2026-09-20T00:00:02.000Z',
      completedAt: state === 'ready' ? '2026-09-20T00:00:03.000Z' : null,
      mediaCount: 3,
      totalBytes: 1_024,
      processedMediaCount: state === 'queued' ? null : state === 'running' ? 1 : 3,
      processedBytes: state === 'queued' ? null : state === 'running' ? 256 : 1_024,
      progressUpdatedAt: state === 'queued' ? null : '2026-09-20T00:00:02.500Z',
      attempt: 1,
      partCount: state === 'ready' ? 1 : 0,
      expiresAt: state === 'ready' ? '2026-09-21T00:00:03.000Z' : null,
      guestbookEntryCount: 0,
      guestbookSharedCount: 0,
      guestbookEventName: 'Maya & Theo',
      guestbookEventDate: '2026-09-19',
      guestbookEventTimezone: 'America/Chicago',
      guestbookPrompt: DEFAULT_GUESTBOOK_PROMPT,
      guestbookGalleryVisible: true,
      errorCode: null,
    });
    let exportReads = 0;
    const base = managerFetch({ first: { media: [], nextCursor: null } });
    const interval = vi.spyOn(window, 'setInterval');
    const clearInterval = vi.spyOn(window, 'clearInterval');
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/exports')) {
        exportReads += 1;
        return json({ exports: [exportJob(exportReads === 1 ? 'queued' : exportReads === 2 ? 'running' : 'ready')] });
      }
      return base(input);
    }));

    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    expect(await screen.findByRole('heading', { name: 'Live intake' })).toBeVisible();
    const compact = await screen.findByRole('region', { name: 'Export progress' });
    expect(within(compact).getByText('Complete export · Queued')).toBeVisible();
    const liveHost = document.querySelector('[data-gallery-live-host]');
    expect(liveHost).not.toBeNull();
    expect(liveHost?.querySelectorAll('[role="status"]')).toHaveLength(1);

    const scheduled = await waitFor(() => {
      const index = interval.mock.calls.findLastIndex(([, delay]) => delay === 10_000);
      const call = interval.mock.calls[index];
      if (!call) throw new Error('the global export poll was never scheduled');
      return { handler: call[0] as () => void, id: interval.mock.results[index]?.value };
    });
    await act(async () => { scheduled.handler(); });
    expect(await screen.findByText('Complete export · Running')).toBeVisible();
    expect(document.querySelector('[data-gallery-live-host]')).toBe(liveHost);

    await act(async () => { scheduled.handler(); });
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Export progress' }))
      .not.toBeInTheDocument());
    expect(clearInterval).toHaveBeenCalledWith(scheduled.id);
    expect(exportReads).toBe(3);
  });

  it.each(['prepare', 'retry'] as const)(
    'adopts an accepted %s response before a failed reconciliation read',
    async (action) => {
      const failed: ExportView = {
        id: 'export-accepted', kind: 'complete', state: 'failed',
        snapshotAt: '2026-09-20T00:00:00.000Z', createdAt: '2026-09-20T00:00:01.000Z',
        startedAt: '2026-09-20T00:00:02.000Z', completedAt: '2026-09-20T00:00:03.000Z',
        mediaCount: 3, totalBytes: 1_024, processedMediaCount: 1, processedBytes: 256,
        progressUpdatedAt: '2026-09-20T00:00:02.500Z', attempt: 1, partCount: 0,
        expiresAt: null, guestbookEntryCount: 0, guestbookSharedCount: 0,
        guestbookEventName: 'Maya & Theo', guestbookEventDate: '2026-09-19',
        guestbookEventTimezone: 'America/Chicago', guestbookPrompt: DEFAULT_GUESTBOOK_PROMPT,
        guestbookGalleryVisible: true, errorCode: 'EXPORT_FAILED',
      };
      const accepted: ExportView = {
        ...failed,
        state: 'queued',
        startedAt: null,
        completedAt: null,
        processedMediaCount: null,
        processedBytes: null,
        progressUpdatedAt: null,
        attempt: action === 'retry' ? 2 : 1,
        errorCode: null,
      };
      let acceptedByServer = false;
      let exportReads = 0;
      const interval = vi.spyOn(window, 'setInterval');
      const base = managerFetch({ first: { media: [], nextCursor: null } });
      const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? 'GET').toUpperCase();
        const isPrepare = url.endsWith('/exports') && method === 'POST';
        const isRetry = url.endsWith('/exports/export-accepted/retry') && method === 'POST';
        if (isPrepare || isRetry) {
          acceptedByServer = true;
          return json({ export: accepted }, 202);
        }
        if (url.endsWith('/exports') && method === 'GET') {
          exportReads += 1;
          return acceptedByServer
            ? errorJson({
                code: 'INTERNAL_ERROR',
                message: 'Export reconciliation is temporarily unavailable.',
                requestId: 'request-reconcile',
              }, 503)
            : json({ exports: action === 'retry' ? [failed] : [] });
        }
        if (url.endsWith('/gallery/summary')) return json({ summary: {
          ...EMPTY_GALLERY_AUDIENCE_SUMMARY,
          albumPhotoCount: 1,
          albumEntryCount: 1,
        } });
        if (url.endsWith('/album') && method === 'GET') return json({ album: {
          revision: 1, saved: true, title: 'Album', description: '', coverMediaId: null,
          effectiveCoverMediaId: null, entries: [], photoCount: 0, sectionCount: 0, totalBytes: 0,
        } });
        return base(input);
      });
      vi.stubGlobal('fetch', fetchMock);

      render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
      await screen.findByRole('heading', { name: 'Live intake' });
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Gallery' }));
      await user.click(await screen.findByRole('button', { name: 'Library' }));
      await user.click(screen.getByRole('button', {
        name: action === 'retry' ? 'Retry this prepared export' : 'Download all',
      }));

      expect(await screen.findByText('Queued', { selector: '.export-state strong' })).toBeVisible();
      expect(exportReads).toBe(2);
      await waitFor(() => expect(interval.mock.calls.some(([, delay]) => delay === 10_000)).toBe(true));

      await user.click(within(screen.getByRole('group', { name: 'Gallery mode' }))
        .getByRole('button', { name: /^Album/ }));
      expect(await screen.findByRole('button', { name: 'Download album photos' })).toBeDisabled();
      expect(screen.getByText(
        'Complete collection export is Queued. Prepare and retry actions will be available when it finishes.',
      )).toBeVisible();

      await user.click(within(screen.getByRole('navigation', { name: 'Manager sections' }))
        .getByRole('button', { name: /^Intake/ }));
      expect(within(await screen.findByRole('region', { name: 'Export progress' }))
        .getByText('Complete export · Queued')).toBeVisible();
    },
  );

  it('announces the terminal result of the job it was tracking across kinds', async () => {
    const complete = (state: 'running' | 'failed'): ExportView => ({
      id: 'complete-retry', kind: 'complete', state,
      snapshotAt: '2026-09-20T00:00:00.000Z', createdAt: '2026-09-20T00:00:01.000Z',
      startedAt: '2026-09-20T00:10:00.000Z', completedAt: state === 'failed'
        ? '2026-09-20T00:11:00.000Z' : null,
      mediaCount: 3, totalBytes: 1_024, processedMediaCount: 1, processedBytes: 256,
      progressUpdatedAt: '2026-09-20T00:10:30.000Z', attempt: 2, partCount: 0,
      expiresAt: null, guestbookEntryCount: 0, guestbookSharedCount: 0,
      guestbookEventName: 'Maya & Theo', guestbookEventDate: '2026-09-19',
      guestbookEventTimezone: 'America/Chicago', guestbookPrompt: DEFAULT_GUESTBOOK_PROMPT,
      guestbookGalleryVisible: true, errorCode: state === 'failed' ? 'EXPORT_FAILED' : null,
    });
    const newerAlbum: ExportView = {
      id: 'album-older-terminal', kind: 'album', state: 'ready',
      snapshotAt: '2026-09-20T00:05:00.000Z', createdAt: '2026-09-20T00:05:01.000Z',
      startedAt: '2026-09-20T00:05:02.000Z', completedAt: '2026-09-20T00:06:00.000Z',
      mediaCount: 1, totalBytes: 64, processedMediaCount: 1, processedBytes: 64,
      progressUpdatedAt: '2026-09-20T00:05:30.000Z', attempt: 1, partCount: 1,
      expiresAt: '2026-09-21T00:06:00.000Z', guestbookEntryCount: null,
      guestbookSharedCount: null, guestbookEventName: null, guestbookEventDate: null,
      guestbookEventTimezone: null, guestbookPrompt: null, guestbookGalleryVisible: null,
      errorCode: null,
    };
    let exportReads = 0;
    const interval = vi.spyOn(window, 'setInterval');
    const base = managerFetch({ first: { media: [], nextCursor: null } });
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      if (String(input).endsWith('/exports')) {
        exportReads += 1;
        return json({ exports: exportReads === 1
          ? [complete('running'), newerAlbum]
          : [complete('failed'), newerAlbum] });
      }
      return base(input);
    }));

    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    expect(within(await screen.findByRole('region', { name: 'Export progress' }))
      .getByText('Complete export · Running')).toBeVisible();
    const poll = await waitFor(() => {
      const scheduled = interval.mock.calls.filter(([, delay]) => delay === 10_000).at(-1)?.[0];
      if (!scheduled) throw new Error('the tracked export poll was never scheduled');
      return scheduled as () => void;
    });

    await act(async () => { poll(); });

    const status = document.querySelector<HTMLElement>('[data-gallery-live-host] [role="status"]');
    await waitFor(() => expect(status).toHaveTextContent(
      'Complete export. Failed This prepared export did not finish.',
    ));
    expect(status).not.toHaveTextContent('Album export. Ready');
    expect(exportReads).toBe(2);
  });

  it('tracks an accepted retry even when its response is already terminal', async () => {
    const failedComplete: ExportView = {
      id: 'complete-dispatch', kind: 'complete', state: 'failed',
      snapshotAt: '2026-09-20T00:00:00.000Z', createdAt: '2026-09-20T00:00:01.000Z',
      startedAt: '2026-09-20T00:00:02.000Z', completedAt: '2026-09-20T00:00:03.000Z',
      mediaCount: 3, totalBytes: 1_024, processedMediaCount: 1, processedBytes: 256,
      progressUpdatedAt: '2026-09-20T00:00:02.500Z', attempt: 1, partCount: 0,
      expiresAt: null, guestbookEntryCount: 0, guestbookSharedCount: 0,
      guestbookEventName: 'Maya & Theo', guestbookEventDate: '2026-09-19',
      guestbookEventTimezone: 'America/Chicago', guestbookPrompt: DEFAULT_GUESTBOOK_PROMPT,
      guestbookGalleryVisible: true, errorCode: 'EXPORT_FAILED',
    };
    const dispatchFailed: ExportView = {
      ...failedComplete,
      attempt: 2,
      completedAt: '2026-09-20T00:12:00.000Z',
      processedMediaCount: null,
      processedBytes: null,
      progressUpdatedAt: null,
      errorCode: 'EXPORT_WORKFLOW_DISPATCH_FAILED',
    };
    const newerAlbum: ExportView = {
      id: 'album-newer-created', kind: 'album', state: 'ready',
      snapshotAt: '2026-09-20T00:05:00.000Z', createdAt: '2026-09-20T00:05:01.000Z',
      startedAt: '2026-09-20T00:05:02.000Z', completedAt: '2026-09-20T00:06:00.000Z',
      mediaCount: 1, totalBytes: 64, processedMediaCount: 1, processedBytes: 64,
      progressUpdatedAt: '2026-09-20T00:05:30.000Z', attempt: 1, partCount: 1,
      expiresAt: '2026-09-21T00:06:00.000Z', guestbookEntryCount: null,
      guestbookSharedCount: null, guestbookEventName: null, guestbookEventDate: null,
      guestbookEventTimezone: null, guestbookPrompt: null, guestbookGalleryVisible: null,
      errorCode: null,
    };
    let retried = false;
    const base = managerFetch({ first: { media: [], nextCursor: null } });
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/exports/complete-dispatch/retry') && method === 'POST') {
        retried = true;
        return json({ export: dispatchFailed }, 202);
      }
      if (url.endsWith('/exports') && method === 'GET') {
        return json({ exports: [retried ? dispatchFailed : failedComplete, newerAlbum] });
      }
      return base(input);
    }));

    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await screen.findByRole('heading', { name: 'Live intake' });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Gallery' }));
    await user.click(await screen.findByRole('button', { name: 'Library' }));
    await user.click(screen.getByRole('button', { name: 'Retry this prepared export' }));

    const status = document.querySelector<HTMLElement>('[data-gallery-live-host] [role="status"]');
    await waitFor(() => expect(status).toHaveTextContent(
      'Complete export. Failed Export preparation could not start.',
    ));
    expect(status).not.toHaveTextContent('Album export. Ready');
  });

  it('reconciles another tab\'s active export after a stale Prepare conflict', async () => {
    const activeAlbum: ExportView = {
      id: 'album-other-tab', kind: 'album', state: 'running',
      snapshotAt: '2026-09-20T00:05:00.000Z', createdAt: '2026-09-20T00:05:01.000Z',
      startedAt: '2026-09-20T00:05:02.000Z', completedAt: null,
      mediaCount: 1, totalBytes: 64, processedMediaCount: 0, processedBytes: 0,
      progressUpdatedAt: '2026-09-20T00:05:02.000Z', attempt: 1, partCount: 0,
      expiresAt: null, guestbookEntryCount: null, guestbookSharedCount: null,
      guestbookEventName: null, guestbookEventDate: null, guestbookEventTimezone: null,
      guestbookPrompt: null, guestbookGalleryVisible: null, errorCode: null,
    };
    let conflict = false;
    let exportReads = 0;
    const interval = vi.spyOn(window, 'setInterval');
    const base = managerFetch({ first: { media: [], nextCursor: null } });
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/exports') && method === 'POST') {
        conflict = true;
        return errorJson({
          code: 'EXPORT_ALREADY_ACTIVE',
          message: 'Another export is already being prepared.',
          requestId: 'request-other-tab',
        }, 409);
      }
      if (url.endsWith('/exports') && method === 'GET') {
        exportReads += 1;
        return json({ exports: conflict ? [activeAlbum] : [] });
      }
      return base(input);
    }));

    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await screen.findByRole('heading', { name: 'Live intake' });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Gallery' }));
    await user.click(await screen.findByRole('button', { name: 'Library' }));
    await user.click(screen.getByRole('button', { name: 'Download all' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Another export is already being prepared.');
    expect(screen.getByRole('button', { name: 'Download all' })).toBeDisabled();
    expect(screen.getByText(
      'Album export is Running. Prepare and retry actions will be available when it finishes.',
    )).toBeVisible();
    expect(exportReads).toBe(2);
    await waitFor(() => expect(interval.mock.calls.some(([, delay]) => delay === 10_000)).toBe(true));
    expect(document.querySelector('[data-gallery-live-host] [role="status"]'))
      .toHaveTextContent('Album export. Running');

    await user.click(within(screen.getByRole('navigation', { name: 'Manager sections' }))
      .getByRole('button', { name: /^Intake/ }));
    expect(within(await screen.findByRole('region', { name: 'Export progress' }))
      .getByText('Album export · Running')).toBeVisible();
  });

  it('surfaces a credential failure from the export poll instead of waiting on Preparing forever', async () => {
    const queued = {
      id: 'export-a', kind: 'complete', state: 'queued', attempt: 1, mediaCount: 6, totalBytes: 1024,
      guestbookEntryCount: 0, errorCode: null, snapshotAt: '2026-09-20T00:00:00.000Z',
    };
    // Armed immediately before the poll tick, so the refusal belongs to the poll and not to a
    // whole-page load whose own catch would have reported it anyway.
    let failNextExportRead = false;
    const interval = vi.spyOn(window, 'setInterval');
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/exports')) {
        if (failNextExportRead) {
          failNextExportRead = false;
          // The way a rotated management link fails: not a dropped venue packet, and identical
          // on every following tick.
          return errorJson({ code: 'TOKEN_REVOKED', message: 'This link is no longer valid.', requestId: 'request-a' }, 401);
        }
        return json({ exports: [queued] });
      }
      if (url.endsWith('/api/manage/events/event-a')) return json({ event: MANAGED_EVENT });
      if (url.endsWith('/guestbook/summary')) return json({ summary: {
        needsReviewCount: 0, sharedCount: 0, hiddenCount: 0, deletedCount: 0, galleryVisible: true,
      } });
      if (url.endsWith('/gallery/summary')) return galleryAudienceSummaryJson();
      if (url.includes('/gallery')) return json({ media: [], nextCursor: null });
      if (url.includes('/media')) return json({ media: [], nextCursor: null });
      if (url.includes('/messages')) return json({ messages: [] });
      if (url.endsWith('/entry')) return json({ eventLink: 'https://example.test/join#entry-id.entry-secret', disabledAt: null });
      if (url.includes('/rsvp/summary')) return json(RSVP_SUMMARY);
      if (url.includes('/rsvp/households')) return json({ households: [], nextCursor: null });
      throw new Error(`Unexpected request ${url}`);
    }));

    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await screen.findByRole('heading', { name: 'Live intake' });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Gallery' }));
    expect(await screen.findByRole('heading', { name: 'Gallery' })).toBeVisible();

    const poll = await waitFor(() => {
      const scheduled = interval.mock.calls.filter(([, delay]) => delay === 10_000).at(-1)?.[0];
      if (!scheduled) throw new Error('the export poll was never scheduled');
      return scheduled as () => void;
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    failNextExportRead = true;
    await act(async () => { poll(); });

    expect(await screen.findByRole('alert')).toHaveTextContent('This link is no longer valid.');
    expect(screen.getByLabelText('Management link'), 'the notice carries a route back in').toBeVisible();
  });

  it('does not let a stale export answer put back a state the poll has already passed', async () => {
    const job = (state: string) => ({
      id: 'export-a', kind: 'complete', state, attempt: 1, mediaCount: 6, totalBytes: 1024,
      guestbookEntryCount: 0, errorCode: null, snapshotAt: '2026-09-20T00:00:00.000Z',
    });
    // Armed immediately before the first poll tick, so the held answer is that tick's and not
    // one of the reads the initial load and the section navigation happen to make.
    let holdNextExportRead = false;
    let ready = false;
    let releaseStale!: () => void;
    const interval = vi.spyOn(window, 'setInterval');
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/exports')) {
        if (holdNextExportRead) {
          holdNextExportRead = false;
          ready = true;
          return new Promise<Response>((resolve) => {
            releaseStale = () => void json({ exports: [job('queued')] }).then(resolve);
          });
        }
        return json({ exports: [job(ready ? 'ready' : 'queued')] });
      }
      if (url.endsWith('/api/manage/events/event-a')) return json({ event: MANAGED_EVENT });
      if (url.endsWith('/guestbook/summary')) return json({ summary: {
        needsReviewCount: 0, sharedCount: 0, hiddenCount: 0, deletedCount: 0, galleryVisible: true,
      } });
      if (url.endsWith('/gallery/summary')) return galleryAudienceSummaryJson();
      if (url.includes('/gallery')) return json({ media: [], nextCursor: null });
      if (url.includes('/media')) return json({ media: [], nextCursor: null });
      if (url.includes('/messages')) return json({ messages: [] });
      if (url.endsWith('/entry')) return json({ eventLink: 'https://example.test/join#entry-id.entry-secret', disabledAt: null });
      if (url.includes('/rsvp/summary')) return json(RSVP_SUMMARY);
      if (url.includes('/rsvp/households')) return json({ households: [], nextCursor: null });
      throw new Error(`Unexpected request ${url}`);
    }));

    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await screen.findByRole('heading', { name: 'Live intake' });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Gallery' }));
    await user.click(await screen.findByRole('button', { name: 'Library' }));

    const poll = await waitFor(() => {
      const scheduled = interval.mock.calls.filter(([, delay]) => delay === 10_000).at(-1)?.[0];
      if (!scheduled) throw new Error('the export poll was never scheduled');
      return scheduled as () => void;
    });
    const shownState = () => document.querySelector('.export-state strong')?.textContent;
    expect(shownState()).toBe('Queued');
    holdNextExportRead = true;
    // The first tick is held open; the second answers first, with the state the job has reached.
    await act(async () => { poll(); });
    await act(async () => { poll(); });
    await waitFor(() => expect(shownState()).toBe('Ready'));

    // Ready is terminal, so the poll has stopped. An older answer landing now would put the
    // job back to Queued with nothing left running to correct it.
    await act(async () => { releaseStale(); });
    expect(shownState()).toBe('Ready');
  });

  it('adopts the newer export after a stale retry refusal without hiding the action error', async () => {
    const exportJob = (
      id: string,
      state: 'failed' | 'ready',
      mediaCount: number,
    ): ExportView => ({
      id,
      kind: 'complete',
      state,
      snapshotAt: state === 'failed'
        ? '2026-09-20T00:00:00.000Z'
        : '2026-09-20T01:00:00.000Z',
      createdAt: state === 'failed'
        ? '2026-09-20T00:01:00.000Z'
        : '2026-09-20T01:01:00.000Z',
      startedAt: '2026-09-20T01:02:00.000Z',
      completedAt: '2026-09-20T01:03:00.000Z',
      mediaCount,
      totalBytes: mediaCount * 1_024,
      processedMediaCount: mediaCount,
      processedBytes: mediaCount * 1_024,
      progressUpdatedAt: '2026-09-20T01:03:00.000Z',
      attempt: 1,
      partCount: state === 'ready' ? 1 : 0,
      expiresAt: state === 'ready' ? '2099-09-21T00:00:00.000Z' : null,
      guestbookEntryCount: 0,
      guestbookSharedCount: 0,
      guestbookEventName: 'Maya & Theo',
      guestbookEventDate: '2026-09-19',
      guestbookEventTimezone: 'America/Chicago',
      guestbookPrompt: DEFAULT_GUESTBOOK_PROMPT,
      guestbookGalleryVisible: true,
      errorCode: state === 'failed' ? 'EXPORT_FAILED' : null,
    });
    const older = exportJob('older-failed', 'failed', 1);
    const newer = exportJob('newer-ready', 'ready', 7);
    let retryRefused = false;
    let exportReads = 0;
    const base = managerFetch({ first: { media: [], nextCursor: null } });
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/exports/older-failed/retry') && method === 'POST') {
        retryRefused = true;
        return errorJson({
          code: 'EXPORT_ALREADY_ACTIVE',
          message: 'A newer prepared export is available. Refresh before retrying.',
          requestId: 'request-stale-retry',
        }, 409);
      }
      if (url.endsWith('/exports') && method === 'GET') {
        exportReads += 1;
        return json({ exports: [retryRefused ? newer : older] });
      }
      return base(input);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await screen.findByRole('heading', { name: 'Live intake' });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Gallery' }));
    await user.click(await screen.findByRole('button', { name: 'Library' }));
    expect(await screen.findByText(/1 photo · Failed/, { selector: 'span' })).toBeVisible();
    expect(screen.getByText('Frozen size: 1 KB · 0 guestbook entries.')).toBeVisible();
    const readsBeforeRetry = exportReads;

    await user.click(screen.getByRole('button', { name: 'Retry this prepared export' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A newer prepared export is available. Refresh before retrying.',
    );
    expect(await screen.findByText(/7 photos · Ready/, { selector: 'span' })).toBeVisible();
    expect(screen.getByText('Frozen size: 7 KB · 0 guestbook entries.')).toBeVisible();
    expect(screen.getByText('Ready')).toBeVisible();
    expect(exportReads).toBeGreaterThan(readsBeforeRetry);
    expect(fetchMock.mock.calls.filter(([input, init]) => (
      String(input).endsWith('/exports/older-failed/retry')
        && (init?.method ?? 'GET').toUpperCase() === 'POST'
    ))).toHaveLength(1);
  });

  it('keeps the latest complete and album exports on their independent Gallery surfaces', async () => {
    const exportJob = (kind: 'complete' | 'album', state: 'ready' | 'failed', id: string) => ({
      id, kind, state, attempt: state === 'failed' ? 2 : 1,
      mediaCount: kind === 'complete' ? 9 : 2,
      totalBytes: kind === 'complete' ? 1024 : 2048,
      partCount: 1, expiresAt: '2026-09-21T00:00:00.000Z',
      snapshotAt: '2026-09-20T00:00:00.000Z',
      guestbookEntryCount: kind === 'complete' ? 3 : null,
      guestbookSharedCount: kind === 'complete' ? 1 : null,
      guestbookEventName: null, guestbookEventDate: null, guestbookEventTimezone: null,
      guestbookPrompt: null, guestbookGalleryVisible: null,
    });
    const albumPhoto = {
      id: 'album-photo', originalFilename: 'album-photo.png', guestName: 'Avery', caption: null,
      publicationStatus: 'unpublished', previewAvailable: true, width: 800, height: 600,
      receivedAt: '2026-09-20T00:00:00.000Z', timelineAt: '2026-09-20T00:00:00.000Z',
      timelineSource: 'received', isFavorite: true,
    };
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/api/manage/events/event-a')) return json({ event: MANAGED_EVENT });
      if (url.endsWith('/guestbook/summary')) return json({ summary: {
        needsReviewCount: 0, sharedCount: 0, hiddenCount: 0, deletedCount: 0, galleryVisible: true,
      } });
      if (url.endsWith('/exports')) {
        return json({ exports: [
          exportJob('album', 'failed', 'album-latest'),
          exportJob('complete', 'ready', 'complete-latest'),
        ] });
      }
      if (url.endsWith('/album') && method === 'GET') return json({ album: {
        revision: 1, saved: true, title: 'Album', description: '', coverMediaId: null,
        effectiveCoverMediaId: albumPhoto.id, entries: [{ kind: 'photo', photo: albumPhoto }],
        photoCount: 1, sectionCount: 0, totalBytes: 200,
      } });
      if (url.endsWith('/gallery/summary')) return galleryAudienceSummaryJson();
      if (url.includes('/gallery')) return json({ media: [albumPhoto], nextCursor: null });
      if (url.includes('/media')) return json({ media: [], nextCursor: null });
      if (url.endsWith('/entry')) return json({ eventLink: 'https://example.test/join#entry.secret', disabledAt: null });
      throw new Error(`Unexpected request ${method} ${url}`);
    }));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await screen.findByRole('heading', { name: 'Live intake' });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Gallery' }));

    expect((await screen.findAllByText(/9 photos · Ready/, { selector: 'span' }))[0]).toBeVisible();
    expect(screen.getByText('Frozen size: 1 KB · 3 guestbook entries.')).toBeVisible();
    expect(screen.getByText('Ready')).toBeVisible();
    await user.click(within(screen.getByRole('group', { name: 'Gallery mode' })).getByRole('button', { name: /^Album/ }));
    expect((await screen.findAllByText(/2 photos · Failed/, { selector: 'span' }))[0]).toBeVisible();
    expect(screen.getByText('Frozen size: 2 KB.')).toBeVisible();
    expect(screen.getByText('Failed')).toBeVisible();
  });

  it('posts the exact album kind selector from Download album photos', async () => {
    const exportBodies: string[] = [];
    const albumPhoto = {
      id: 'album-photo', originalFilename: 'album-photo.png', guestName: 'Avery', caption: null,
      publicationStatus: 'unpublished', previewAvailable: true, width: 800, height: 600,
      receivedAt: '2026-09-20T00:00:00.000Z', timelineAt: '2026-09-20T00:00:00.000Z',
      timelineSource: 'received', isFavorite: true,
    };
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'POST' && url.endsWith('/exports')) {
        exportBodies.push(String(init?.body));
        return json({ export: {
          id: 'album-new', kind: 'album', state: 'queued', attempt: 1,
          mediaCount: 1, totalBytes: 64, partCount: 0, expiresAt: null,
          snapshotAt: '2026-09-20T00:00:00.000Z', guestbookEntryCount: null,
          guestbookSharedCount: null, guestbookEventName: null, guestbookEventDate: null,
          guestbookEventTimezone: null, guestbookPrompt: null, guestbookGalleryVisible: null,
        } }, 202);
      }
      if (url.endsWith('/api/manage/events/event-a')) return json({ event: MANAGED_EVENT });
      if (url.endsWith('/guestbook/summary')) return json({ summary: {
        needsReviewCount: 0, sharedCount: 0, hiddenCount: 0, deletedCount: 0, galleryVisible: true,
      } });
      if (url.endsWith('/exports')) return json({ exports: [] });
      if (url.endsWith('/album') && method === 'GET') return json({ album: {
        revision: 1, saved: true, title: 'Album', description: '', coverMediaId: null,
        effectiveCoverMediaId: albumPhoto.id, entries: [{ kind: 'photo', photo: albumPhoto }],
        photoCount: 1, sectionCount: 0, totalBytes: 64,
      } });
      if (url.endsWith('/gallery/summary')) return json({ summary: {
        ...EMPTY_GALLERY_AUDIENCE_SUMMARY,
        albumPhotoCount: 1,
        albumEntryCount: 1,
      } });
      if (url.includes('/gallery')) return json({ media: [albumPhoto], nextCursor: null });
      if (url.includes('/media')) return json({ media: [], nextCursor: null });
      if (url.endsWith('/entry')) return json({ eventLink: 'https://example.test/join#entry.secret', disabledAt: null });
      throw new Error(`Unexpected request ${method} ${url}`);
    }));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await screen.findByRole('heading', { name: 'Live intake' });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Gallery' }));
    await user.click(within(await screen.findByRole('group', { name: 'Gallery mode' })).getByRole('button', { name: /^Album/ }));
    await user.click(await screen.findByRole('button', { name: 'Download album photos' }));

    await waitFor(() => expect(exportBodies).toEqual([JSON.stringify({ kind: 'album' })]));
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
      if (url.endsWith('/gallery/summary')) return galleryAudienceSummaryJson();
      if (url.includes('/gallery')) return json({ media: [], nextCursor: null });
      if (url.includes('/messages')) return json({ messages: [] });
      if (url.endsWith('/exports')) return json({ exports: [] });
      if (url.endsWith('/entry')) return json({ eventLink: 'https://example.test/join#entry-id.entry-secret', disabledAt: null });
      throw new Error(`Unexpected request ${method} ${url}`);
    }));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    expect(await screen.findByRole('heading', { name: 'Live intake' })).toBeVisible();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Gallery' }));
    await user.click(await screen.findByRole('button', { name: 'Guest gallery' }));
    expect(await screen.findByRole('heading', { name: 'Gallery' })).toBeVisible();
    await user.click(await screen.findByRole('button', { name: 'Load more photos' }));
    const choices = await screen.findAllByRole('checkbox', { name: /^Select /u });
    expect(choices).toHaveLength(MANAGER_BULK_SELECTION_MAX + 1);

    for (const choice of choices.slice(0, MANAGER_BULK_SELECTION_MAX)) fireEvent.click(choice);
    const extra = choices[MANAGER_BULK_SELECTION_MAX]!;
    const capacity = screen.getByText('50 of 50 selected. Remove one to choose another.');
    expect(capacity).toBeVisible();
    expect(extra).toBeDisabled();
    await user.click(extra);
    expect(extra).not.toBeChecked();
    expect(capacity).toBeVisible();

    await user.click(choices[0]!);
    expect(extra, 'unchecking remains available as the recovery').toBeEnabled();
    await user.click(choices[0]!);
    expect(extra).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Publish selected' }));
    await waitFor(() => expect(bulkBodies).toHaveLength(1));
    expect(bulkBodies[0]!.ids).toEqual(rows.slice(0, MANAGER_BULK_SELECTION_MAX).map(({ id }) => id));
    expect(bulkBodies[0]!.ids).not.toContain(rows[MANAGER_BULK_SELECTION_MAX]!.id);
  }, 20_000);

  it('polls live intake so a new private delivery appears without navigation', async () => {
    let mediaRequests = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/manage/events/event-a')) return json({ event: {
        ...MANAGED_EVENT,
        storedMediaCount: mediaRequests > 0 ? 1 : 0, storedBytes: 128, recoverableMediaCount: 0, recoverableBytes: 0,
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

  it('keeps an older held Intake poll from overwriting the newer same-query poll', async () => {
    const oldRow = {
      id: 'poll-old', originalFilename: 'old.jpg', guestName: 'Avery', caption: 'Older poll',
      publicationStatus: 'unpublished', uploadState: 'stored',
    };
    const newRow = {
      id: 'poll-new', originalFilename: 'new.jpg', guestName: 'Jamie', caption: 'Newer poll',
      publicationStatus: 'unpublished', uploadState: 'stored',
    };
    const releases: Array<() => void> = [];
    let mediaReads = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/manage/events/event-a')) return json({ event: MANAGED_EVENT });
      if (url.includes('/media')) {
        mediaReads += 1;
        if (mediaReads === 1) return json({ media: makeMedia(2).slice(1), nextCursor: null });
        const row = mediaReads === 2 ? oldRow : newRow;
        return new Promise<Response>((resolve) => { releases.push(() => void json({ media: [row], nextCursor: null }).then(resolve)); });
      }
      if (url.includes('/messages')) return json({ messages: [] });
      if (url.endsWith('/exports')) return json({ exports: [] });
      if (url.endsWith('/entry')) return json({ eventLink: null, disabledAt: null });
      throw new Error(`Unexpected request ${url}`);
    }));
    const interval = vi.spyOn(window, 'setInterval');
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    expect(await screen.findByAltText('Moment 2')).toBeVisible();
    const poll = interval.mock.calls.filter(([, delay]) => delay === 5_000).at(-1)?.[0] as () => void;

    await act(async () => { poll(); });
    await act(async () => { poll(); });
    expect(releases).toHaveLength(2);
    await act(async () => { releases[1]!(); });
    expect(await screen.findByAltText('Newer poll')).toBeVisible();
    await act(async () => { releases[0]!(); });

    expect(screen.getByAltText('Newer poll')).toBeVisible();
    expect(screen.queryByAltText('Older poll')).not.toBeInTheDocument();
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

  it('locks the Intake interval after a terminal poll failure even when its notice is dismissed', async () => {
    let mediaReads = 0;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/manage/events/event-a')) return json({ event: MANAGED_EVENT });
      if (url.includes('/media')) {
        mediaReads += 1;
        return mediaReads === 1
          ? json({ media: makeMedia(2).slice(1), nextCursor: null })
          : errorJson({ code: 'SESSION_EXPIRED', message: 'This session has expired.', requestId: 'request-a' }, 401);
      }
      if (url.includes('/messages')) return json({ messages: [] });
      if (url.endsWith('/exports')) return json({ exports: [] });
      if (url.endsWith('/entry')) return json({ eventLink: null, disabledAt: null });
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    expect(await screen.findByAltText('Moment 2')).toBeVisible();

    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(await screen.findByRole('alert')).toHaveTextContent('This session has expired.');
    expect(mediaReads).toBe(2);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss error' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(mediaReads).toBe(2);
  });

  it('does not resurface a dismissed terminal notice when a second Intake poll sibling settles', async () => {
    let eventReads = 0;
    let mediaReads = 0;
    let releaseEventFailure!: () => void;
    let releaseMediaFailure!: () => void;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/manage/events/event-a')) {
        eventReads += 1;
        if (eventReads === 1) return json({ event: MANAGED_EVENT });
        return new Promise<Response>((resolve) => {
          releaseEventFailure = () => void errorJson({
            code: 'SESSION_EXPIRED', message: 'The event poll lost access.', requestId: 'request-event',
          }, 401).then(resolve);
        });
      }
      if (url.includes('/media')) {
        mediaReads += 1;
        if (mediaReads === 1) return json({ media: makeMedia(2).slice(1), nextCursor: null });
        return new Promise<Response>((resolve) => {
          releaseMediaFailure = () => void errorJson({
            code: 'SESSION_EXPIRED', message: 'The intake poll lost access.', requestId: 'request-media',
          }, 401).then(resolve);
        });
      }
      if (url.includes('/messages')) return json({ messages: [] });
      if (url.endsWith('/exports')) return json({ exports: [] });
      if (url.endsWith('/entry')) return json({ eventLink: null, disabledAt: null });
      throw new Error(`Unexpected request ${url}`);
    }));
    const interval = vi.spyOn(window, 'setInterval');
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    expect(await screen.findByAltText('Moment 2')).toBeVisible();

    const poll = interval.mock.calls.filter(([, delay]) => delay === 5_000).at(-1)?.[0] as () => void;
    await act(async () => { poll(); });
    await waitFor(() => {
      expect(releaseEventFailure).toBeTypeOf('function');
      expect(releaseMediaFailure).toBeTypeOf('function');
    });
    await act(async () => { releaseEventFailure(); });
    expect(await screen.findByRole('alert')).toHaveTextContent('The event poll lost access.');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss error' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await act(async () => { releaseMediaFailure(); });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByAltText('Moment 2')).toBeVisible();
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
    await user.click(screen.getByRole('button', { name: 'Move moment-2.jpg to Recently deleted' }));
    await user.click(within(await screen.findByRole('dialog'))
      .getByRole('button', { name: 'Move to Recently deleted' }));

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

  it('does not reload the event entry when an Intake query changes', async () => {
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
    // Intake has its own query owner; filtering must not re-read entry or
    // replace the independent QR input.
    await user.type(screen.getByLabelText('Filter by guest name'), 'Avery');
    await user.click(screen.getByRole('button', { name: 'Filter' }));

    await user.click(screen.getByRole('button', { name: 'Share' }));
    expect(screen.getByText('https://example.test/join#entry-id.entry-secret')).toBeVisible();
    expect(qrToDataURL).toHaveBeenCalledTimes(1);

    // The in-flight render still belongs to the unchanged entry.
    await act(async () => {
      resolveFirstQr('data:image/png;base64,stale-entry');
      await Promise.resolve();
    });
    for (const qr of screen.getAllByAltText('Event QR code')) {
      expect(qr).toHaveAttribute('src', 'data:image/png;base64,stale-entry');
    }
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

  describe('safety ladder', () => {
    const broadRows = SAFETY_LADDER_ROWS.filter(
      (row) => row.rung === 'broad or catastrophic',
    );

    it('keeps Pause / Resume guest uploads reversible with one immediate request and no confirmation', async () => {
      expect(SAFETY_LADDER_ROWS).toHaveLength(10);
      expect(new Set(SAFETY_LADDER_ROWS.map(({ action }) => action)).size).toBe(10);
      expect(SAFETY_LADDER_ROWS.map(({ status }) => status)).not.toContain('deferred');

      const base = managerRotationFetch().fetchMock.getMockImplementation()!;
      const writes: Array<{ action: string }> = [];
      const resolvers = new Map<string, (response: Response) => void>();
      vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'https://candidary.test');
        const method = String(init?.method ?? 'GET').toUpperCase();
        if (url.pathname === '/api/manage/events/event-a/photo-intake' && method === 'POST') {
          const body = JSON.parse(String(init?.body)) as { action: string };
          writes.push(body);
          return new Promise<Response>((resolve) => { resolvers.set(body.action, resolve); });
        }
        return base(input, init);
      }));
      render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
      const user = userEvent.setup();
      expect(await screen.findByRole('heading', { name: 'Live intake' })).toBeVisible();
      await user.click(screen.getByRole('button', { name: 'Settings' }));

      await user.click(screen.getByRole('button', { name: 'Pause guest uploads' }));
      expect(writes).toEqual([{ action: 'pause' }]);
      expect(screen.getByText('Saving guest uploads…')).toHaveAttribute('role', 'status');
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Confirm event name')).not.toBeInTheDocument();

      await act(async () => {
        resolvers.get('pause')!(await json({
          event: {
            ...MANAGED_EVENT,
            uploadsEnabled: false,
            photosOpen: false,
            photoIntakeState: 'paused',
          },
        }));
      });
      expect(await screen.findByText(
        'New guest uploads are paused. Event access, Guestbook, the Guest gallery setting, and Manager uploads are unchanged.',
      )).toHaveAttribute('role', 'status');

      await user.click(screen.getByRole('button', { name: 'Resume guest uploads' }));
      expect(writes).toEqual([{ action: 'pause' }, { action: 'reopen' }]);
      expect(screen.getByText('Saving guest uploads…')).toHaveAttribute('role', 'status');
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Confirm event name')).not.toBeInTheDocument();

      await act(async () => {
        resolvers.get('reopen')!(await json({ event: MANAGED_EVENT }));
      });
      expect(await screen.findByText('Guest uploads are open.')).toHaveAttribute('role', 'status');
      expect(writes).toHaveLength(2);
    });

    it.each(broadRows)(
      'gives broad action $action typed validation, safe focus, cancellation, and one request',
      async (row) => {
        const ui = BROAD_SAFETY_ACTION_UI[row.action];
        if (!ui) throw new Error(`Missing App harness for ${row.action}`);
        const base = managerRotationFetch().fetchMock.getMockImplementation()!;
        const writes: Array<Record<string, unknown>> = [];
        const heldResponse = new Promise<Response>(() => {});
        const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(String(input), 'https://candidary.test');
          const method = String(init?.method ?? 'GET').toUpperCase();
          if (url.pathname === ui.path && method === ui.method) {
            writes.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
            return heldResponse;
          }
          return base(input, init);
        });
        vi.stubGlobal('fetch', fetchMock);
        render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
        const user = userEvent.setup();
        expect(await screen.findByRole('heading', { name: 'Live intake' })).toBeVisible();
        await user.click(screen.getByRole('button', { name: ui.section }));
        const trigger = screen.getByRole('button', { name: ui.trigger });

        await user.click(trigger);
        let dialog = await screen.findByRole('dialog');
        let confirmation = within(dialog).getByRole('group', { name: ui.confirmation });
        let cancel = within(confirmation).getByRole('button', { name: 'Cancel' });
        await waitFor(() => expect(cancel).toHaveFocus());
        expect(writes).toEqual([]);

        const input = within(confirmation).getByLabelText('Confirm event name');
        await user.type(input, `${MANAGED_EVENT.name}!`);
        const confirm = within(confirmation).getByRole('button', {
          name: `${ui.confirmation} for ${MANAGED_EVENT.name}`,
        });
        expect(confirm).toBeDisabled();
        fireEvent.click(confirm);
        expect(writes).toEqual([]);

        await user.keyboard('{Escape}');
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        expect(trigger).toHaveFocus();
        expect(writes).toEqual([]);

        await user.click(trigger);
        dialog = await screen.findByRole('dialog');
        confirmation = within(dialog).getByRole('group', { name: ui.confirmation });
        cancel = within(confirmation).getByRole('button', { name: 'Cancel' });
        await user.click(cancel);
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        expect(trigger).toHaveFocus();
        expect(writes).toEqual([]);

        await user.click(trigger);
        dialog = await screen.findByRole('dialog');
        confirmation = within(dialog).getByRole('group', { name: ui.confirmation });
        await user.type(
          within(confirmation).getByLabelText('Confirm event name'),
          MANAGED_EVENT.name,
        );
        const accepted = within(confirmation).getByRole('button', {
          name: `${ui.confirmation} for ${MANAGED_EVENT.name}`,
        });
        fireEvent.click(accepted);
        fireEvent.click(accepted);
        await waitFor(() => expect(writes).toEqual([{
          [ui.bodyKey]: MANAGED_EVENT.name,
        }]));
      },
    );

    it('broad action settled lifecycle: keeps pending sign-out focus inside the modal and suppresses duplicate activation', async () => {
      let settle!: (response: Response) => void;
      const settledResponse = new Promise<Response>((resolve) => { settle = resolve; });
      const base = managerRotationFetch().fetchMock.getMockImplementation()!;
      let requests = 0;
      vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'https://candidary.test');
        const method = String(init?.method ?? 'GET').toUpperCase();
        if (url.pathname.endsWith('/guest-sessions/rotate') && method === 'POST') {
          requests += 1;
          return settledResponse;
        }
        return base(input, init);
      }));
      render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
      const user = userEvent.setup();
      expect(await screen.findByRole('heading', { name: 'Live intake' })).toBeVisible();
      await user.click(screen.getByRole('button', { name: 'Share' }));
      const trigger = screen.getByRole('button', { name: 'Sign out guest devices' });
      await user.click(trigger);
      const dialog = await screen.findByRole('dialog');
      const confirmation = within(dialog).getByRole('group', { name: 'Sign out guest devices' });
      await user.type(within(confirmation).getByLabelText('Confirm event name'), MANAGED_EVENT.name);
      const confirm = within(confirmation).getByRole('button', {
        name: `Sign out guest devices for ${MANAGED_EVENT.name}`,
      });

      fireEvent.click(confirm);
      fireEvent.click(confirm);
      await waitFor(() => expect(requests).toBe(1));

      try {
        const pending = within(dialog).getByRole('status');
        expect(pending).toHaveFocus();
        expect(pending).toHaveAttribute('tabindex', '0');
        expect(dialog).toContainElement(document.activeElement as HTMLElement);
        expect(requests).toBe(1);
      } finally {
        await act(async () => {
          settle(await json({
            rotated: true,
            eventLink: 'https://example.test/join#entry-id.entry-secret',
          }));
        });
      }

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(trigger).toHaveFocus();
      expect(requests).toBe(1);
    });

    it('broad action settled lifecycle: exposes rejected disable recovery outside inert content and focuses it', async () => {
      const base = managerRotationFetch().fetchMock.getMockImplementation()!;
      let requests = 0;
      vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'https://candidary.test');
        const method = String(init?.method ?? 'GET').toUpperCase();
        if (url.pathname.endsWith('/entry/disable') && method === 'POST') {
          requests += 1;
          return errorJson({
            code: 'SESSION_EXPIRED',
            message: 'This session expired before the printed entry was disabled.',
            requestId: 'request-entry-disable',
          }, 401);
        }
        return base(input, init);
      }));
      render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
      const user = userEvent.setup();
      expect(await screen.findByRole('heading', { name: 'Live intake' })).toBeVisible();
      await user.click(screen.getByRole('button', { name: 'Share' }));
      await user.click(screen.getByRole('button', { name: 'Disable printed event QR' }));
      const confirmation = within(await screen.findByRole('dialog'))
        .getByRole('group', { name: 'Disable printed event QR' });
      await user.type(within(confirmation).getByLabelText('Confirm event name'), MANAGED_EVENT.name);
      await user.click(within(confirmation).getByRole('button', {
        name: `Disable printed event QR for ${MANAGED_EVENT.name}`,
      }));

      const notice = await screen.findByRole('region', { name: 'Manager notice' });
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(notice).toHaveFocus();
      expect(notice.closest('[inert]')).toBeNull();
      expect(notice).toHaveTextContent('This session expired before the printed entry was disabled.');
      expect(notice).toHaveTextContent('Open the latest management link you saved to start again.');
      expect(within(notice).getByRole('region', { name: 'Recover manager access' })).toBeVisible();
      expect(within(notice).getByRole('link', { name: 'Sign in' })).toBeVisible();
      expect(screen.getByRole('button', { name: 'Disable printed event QR' })).toBeVisible();
      expect(requests).toBe(1);
    });

    it('broad action settled lifecycle: focuses a connected result after successful printed-entry disable removes its trigger', async () => {
      const base = managerRotationFetch().fetchMock.getMockImplementation()!;
      let requests = 0;
      vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'https://candidary.test');
        const method = String(init?.method ?? 'GET').toUpperCase();
        if (url.pathname.endsWith('/entry/disable') && method === 'POST') {
          requests += 1;
          return json({ disabledAt: '2026-07-31T12:00:00.000Z' });
        }
        return base(input, init);
      }));
      render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
      const user = userEvent.setup();
      expect(await screen.findByRole('heading', { name: 'Live intake' })).toBeVisible();
      await user.click(screen.getByRole('button', { name: 'Share' }));
      await user.click(screen.getByRole('button', { name: 'Disable printed event QR' }));
      const confirmation = within(await screen.findByRole('dialog'))
        .getByRole('group', { name: 'Disable printed event QR' });
      await user.type(within(confirmation).getByLabelText('Confirm event name'), MANAGED_EVENT.name);
      await user.click(within(confirmation).getByRole('button', {
        name: `Disable printed event QR for ${MANAGED_EVENT.name}`,
      }));

      const result = await screen.findByText('This event QR was disabled and cannot be replaced.');
      await waitFor(() => expect(result).toHaveFocus());
      expect(result).toHaveAttribute('tabindex', '-1');
      expect(result.isConnected).toBe(true);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Disable printed event QR' }))
        .not.toBeInTheDocument();
      expect(document.activeElement).not.toBe(document.body);
      expect(requests).toBe(1);
    });
  });

  it('keeps a stale-enabled, link-only rotate action focusable but unavailable', async () => {
    const event = {
      ...MANAGED_EVENT,
      managerLinkRevision: null,
      // The null revision must win even if an older projection retained an enabled flag.
      managerLinkRotationAvailability: { enabled: true, reason: null },
    } satisfies EventView;
    const { calls, fetchMock } = managerRotationFetch({ event, hostSession: 'none' });
    vi.stubGlobal('fetch', fetchMock);
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    const user = userEvent.setup();
    expect(await screen.findByRole('heading', { name: 'Live intake' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Settings' }));
    const rotate = screen.getByRole('button', { name: 'Rotate manager link' });
    expect(rotate).toHaveAttribute('aria-disabled', 'true');
    expect(rotate).not.toBeDisabled();
    rotate.focus();
    expect(rotate).toHaveFocus();
    expect(screen.getByText(
      'Sign in to an account that owns or cohosts this event to rotate its link',
    )).toBeVisible();
    expect(screen.getByRole('link', { name: 'Sign in' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Create account' })).toBeVisible();

    await user.click(rotate);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(calls.filter(({ path }) => path.endsWith('/links/manager/rotate'))).toHaveLength(0);
  });

  it('safety ladder consequential: cancels rotate confirmation by Keep, Escape, or backdrop without a request', async () => {
    const { calls, fetchMock } = managerRotationFetch();
    vi.stubGlobal('fetch', fetchMock);
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    const user = userEvent.setup();
    expect(await screen.findByRole('heading', { name: 'Live intake' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    const trigger = screen.getByRole('button', { name: 'Rotate manager link' });

    for (const cancel of ['keep', 'escape', 'backdrop'] as const) {
      await user.click(trigger);
      const dialog = await screen.findByRole('dialog');
      expect(dialog).toHaveTextContent('The current management link will stop working immediately.');
      expect(dialog).toHaveTextContent('You must save the replacement before continuing.');
      const keep = within(dialog).getByRole('button', { name: 'Keep current link' });
      await waitFor(() => expect(keep).toHaveFocus());
      expect(within(dialog).getByRole('button', { name: 'Rotate link' }))
        .toHaveAttribute('type', 'button');

      if (cancel === 'keep') await user.click(keep);
      else if (cancel === 'escape') await user.keyboard('{Escape}');
      else fireEvent.mouseDown(dialog);

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(trigger).toHaveFocus();
    }

    expect(calls.filter(({ path }) => path.endsWith('/links/manager/rotate'))).toHaveLength(0);
  });

  it('holds the rotate result behind copy, navigation, reload, and retired-resource gates', async () => {
    let releaseOldSummary!: (response: Response) => void;
    const oldSummary = new Promise<Response>((resolve) => { releaseOldSummary = resolve; });
    const { calls, fetchMock } = managerRotationFetch({
      gallerySummary: (read) => read === 1 ? oldSummary : galleryAudienceSummaryJson(),
    });
    vi.stubGlobal('fetch', fetchMock);
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    const router = createAppRouter(['/host/events', '/manage/event/event-a']);
    render(<RouterProvider router={router} />);
    const user = userEvent.setup();
    expect(await screen.findByRole('heading', { name: 'Live intake' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    const trigger = screen.getByRole('button', { name: 'Rotate manager link' });
    await user.click(trigger);
    await user.click(within(await screen.findByRole('dialog'))
      .getByRole('button', { name: 'Rotate link' }));

    const result = await screen.findByRole('dialog');
    expect(result).toHaveTextContent('The prior management link is no longer valid.');
    const copy = within(result).getByRole('button', { name: 'Copy management link' });
    await waitFor(() => expect(copy).toHaveFocus());
    const continueButton = within(result).getByRole('button', { name: 'Continue managing' });
    expect(continueButton).toBeDisabled();
    expect(router.state.location.pathname).toBe('/manage/event/event-a');

    await router.navigate('/privacy');
    await waitFor(() => expect(router.state.location.pathname).toBe('/manage/event/event-a'));
    await router.navigate(-1);
    await waitFor(() => expect(router.state.location.pathname).toBe('/manage/event/event-a'));
    await user.keyboard('{Escape}');
    fireEvent.mouseDown(result);
    expect(screen.getByRole('dialog')).toBe(result);
    const blockedUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(blockedUnload);
    expect(blockedUnload.defaultPrevented).toBe(true);

    releaseOldSummary(await errorJson({
      code: 'TOKEN_REVOKED',
      message: 'The retired link was revoked.',
      requestId: 'request-old',
    }, 403));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole('dialog')).toBe(result);
    expect(screen.queryByText('The retired link was revoked.')).not.toBeInTheDocument();

    await user.click(copy);
    expect(writeText).toHaveBeenCalledWith(ROTATED_MANAGEMENT_LINK);
    await waitFor(() => {
      expect(continueButton).toBeEnabled();
      expect(continueButton).toHaveFocus();
    });
    const releasedUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(releasedUnload);
    expect(releasedUnload.defaultPrevented).toBe(false);
    await user.click(continueButton);

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    expect(router.state.location.pathname).toBe('/manage/event/event-a');
    expect(calls.filter(({ path, method }) => (
      method === 'POST' && path.endsWith('/links/manager/rotate')
    )).map(({ body }) => JSON.parse(body!))).toEqual([{ expectedManagerLinkRevision: 0 }]);
    for (const path of [
      '/api/manage/events/event-a',
      '/api/manage/events/event-a/media',
      '/api/manage/events/event-a/gallery/summary',
      '/api/manage/events/event-a/exports',
      '/api/manage/events/event-a/entry',
      '/api/manage/events/event-a/guestbook/summary',
    ]) {
      await waitFor(() => expect(calls.filter((call) => call.method === 'GET' && call.path === path).length)
        .toBeGreaterThanOrEqual(2));
    }
  });

  it('rotation pause suspends scheduled autosaves and retires an in-flight autosave until resume', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let releaseFirstSettings!: (response: Response) => void;
    const firstSettings = new Promise<Response>((resolve) => { releaseFirstSettings = resolve; });
    const settingsBodies: Array<Record<string, unknown>> = [];
    const themeBodies: Array<Record<string, unknown>> = [];
    const base = managerRotationFetch();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (url.pathname.endsWith('/settings') && method === 'PATCH') {
        settingsBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (settingsBodies.length === 1) return firstSettings;
        return json({ event: { ...MANAGED_EVENT, name: 'Reception' } });
      }
      if (url.pathname.endsWith('/theme') && method === 'PUT') {
        themeBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return json({ event: {
          ...MANAGED_EVENT,
          name: 'Reception',
          theme: resolveEventTheme({
            version: 1,
            presetId: 'candidary-default',
            overrides: { primaryColor: '#234567' },
          }),
        } });
      }
      return base.fetchMock(input, init);
    }));
    vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    expect(await screen.findByRole('heading', { name: 'Live intake' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Settings' }));

    const name = screen.getByLabelText('Event name');
    fireEvent.change(name, { target: { value: 'Reception' } });
    fireEvent.blur(name);
    await waitFor(() => expect(settingsBodies).toHaveLength(1));
    fireEvent.change(screen.getByRole('textbox', { name: 'Primary color' }), {
      target: { value: '#234567' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Rotate manager link' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Rotate link' }));
    await screen.findByText('The prior management link is no longer valid.');
    const result = screen.getByRole('dialog');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 2);
    });
    expect(themeBodies).toHaveLength(0);
    expect(screen.queryByText('Event appearance could not save a change.')).not.toBeInTheDocument();

    await act(async () => {
      releaseFirstSettings(await json({ event: { ...MANAGED_EVENT, name: 'Retired server name' } }));
      await Promise.resolve();
    });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Maya & Theo');
    expect(screen.queryByText('Event settings could not save a change.')).not.toBeInTheDocument();

    await user.click(within(result).getByRole('button', { name: 'Copy management link' }));
    const continueButton = within(result).getByRole('button', { name: 'Continue managing' });
    await waitFor(() => expect(continueButton).toBeEnabled());
    await user.click(continueButton);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => {
      expect(settingsBodies).toHaveLength(2);
      expect(themeBodies).toHaveLength(1);
    });
    expect(settingsBodies[1]).toMatchObject({ name: 'Reception' });
    expect(themeBodies[0]).toMatchObject({ overrides: { primaryColor: '#234567' } });
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Reception'));
  });

  it('rotation pause defers a running Undo reconciliation until resources resume', async () => {
    const row = makeMedia(2).slice(1)[0]!;
    const trashed = {
      ...row,
      deletedAt: '2026-08-28T01:00:00.000Z',
      restoreUntil: '2026-09-01T01:00:00.000Z',
    };
    let releaseRestore!: (response: Response) => void;
    const restore = new Promise<Response>((resolve) => { releaseRestore = resolve; });
    let restoreStarted = false;
    const base = managerRotationFetch();
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (url.pathname.endsWith(`/media/${row.id}/trash`) && method === 'POST') {
        return json({ media: trashed });
      }
      if (url.pathname.endsWith(`/media/${row.id}/restore`) && method === 'POST') {
        restoreStarted = true;
        return restore;
      }
      return base.fetchMock(input, init);
    }));
    vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    expect(await screen.findByAltText(row.caption || row.originalFilename)).toBeVisible();

    await user.click(screen.getByRole('button', {
      name: `Move ${row.originalFilename} to Recently deleted`,
    }));
    await user.click(within(await screen.findByRole('dialog'))
      .getByRole('button', { name: 'Move to Recently deleted' }));
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(restoreStarted).toBe(true));

    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.click(screen.getByRole('button', { name: 'Rotate manager link' }));
    await user.click(within(await screen.findByRole('dialog'))
      .getByRole('button', { name: 'Rotate link' }));
    await screen.findByText('The prior management link is no longer valid.');
    const result = screen.getByRole('dialog');
    const reconciledPaths = [
      '/api/manage/events/event-a',
      '/api/manage/events/event-a/media',
      '/api/manage/events/event-a/gallery/summary',
      '/api/manage/events/event-a/guestbook/summary',
    ];
    const readsWhilePaused = new Map(reconciledPaths.map((path) => [
      path,
      base.calls.filter((call) => call.method === 'GET' && call.path === path).length,
    ]));

    await act(async () => {
      releaseRestore(await json({ media: row }));
      await Promise.resolve();
    });
    for (const path of reconciledPaths) {
      expect(base.calls.filter((call) => call.method === 'GET' && call.path === path))
        .toHaveLength(readsWhilePaused.get(path) ?? 0);
    }

    await user.click(within(result).getByRole('button', { name: 'Copy management link' }));
    await user.click(within(result).getByRole('button', { name: 'Continue managing' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    for (const path of reconciledPaths) {
      await waitFor(() => expect(base.calls.filter((call) => call.method === 'GET' && call.path === path))
        .toHaveLength((readsWhilePaused.get(path) ?? 0) + 1));
    }
  });

  it('distinguishes a rejected rotate from an ambiguous one and rerotates from the refreshed revision', async () => {
    let unknownCommitted = false;
    const bodies: Array<Record<string, unknown>> = [];
    const { calls, fetchMock } = managerRotationFetch({
      eventForRead: () => ({
        ...MANAGED_EVENT,
        managerLinkRevision: unknownCommitted ? 1 : 0,
      }),
      rotate: (request, body) => {
        bodies.push(body);
        if (request === 1) return errorJson({
          code: 'OWNER_CLAIM_REQUIRED',
          message: 'Save this event before rotating.',
          requestId: 'request-clear',
        }, 409);
        if (request === 2) {
          unknownCommitted = true;
          return Promise.reject(new TypeError('Connection closed after send'));
        }
        return json({ managementLink: ROTATED_MANAGEMENT_LINK, managerLinkRevision: 2 });
      },
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    const user = userEvent.setup();
    expect(await screen.findByRole('heading', { name: 'Live intake' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    const trigger = screen.getByRole('button', { name: 'Rotate manager link' });

    await user.click(trigger);
    await user.click(within(await screen.findByRole('dialog'))
      .getByRole('button', { name: 'Rotate link' }));
    const clearFailure = await screen.findByRole('alert');
    expect(clearFailure).toHaveTextContent('The current management link was not changed.');
    expect(clearFailure).toHaveTextContent('Save this event before rotating.');
    expect(within(screen.getByRole('dialog')).queryByLabelText('Management link'))
      .not.toBeInTheDocument();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(trigger).toHaveFocus());
    await waitFor(() => expect(calls.filter(({ path }) => path === '/api/manage/events/event-a').length)
      .toBeGreaterThanOrEqual(2));

    const readsBeforeAmbiguous = new Map<string, number>();
    for (const { method, path } of calls) {
      if (method === 'GET') readsBeforeAmbiguous.set(path, (readsBeforeAmbiguous.get(path) ?? 0) + 1);
    }
    await user.click(trigger);
    await user.click(within(await screen.findByRole('dialog'))
      .getByRole('button', { name: 'Rotate link' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't confirm whether the link changed. Rotate again to create a link you can save.",
    );
    await waitFor(() => expect(within(screen.getByRole('dialog'))
      .getByRole('button', { name: 'Rotate again' })).toBeEnabled());
    expect(bodies).toEqual([
      { expectedManagerLinkRevision: 0 },
      { expectedManagerLinkRevision: 0 },
    ]);
    for (const path of [
      '/api/manage/events/event-a/media',
      '/api/manage/events/event-a/gallery/summary',
      '/api/manage/events/event-a/exports',
      '/api/manage/events/event-a/entry',
      '/api/manage/events/event-a/guestbook/summary',
    ]) {
      expect(calls.filter((call) => call.method === 'GET' && call.path === path)).toHaveLength(
        readsBeforeAmbiguous.get(path) ?? 0,
      );
    }

    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Rotate again' }));
    const reconfirm = screen.getByRole('dialog');
    await waitFor(() => expect(within(reconfirm).getByRole('button', { name: 'Keep current link' }))
      .toHaveFocus());
    await user.click(within(reconfirm).getByRole('button', { name: 'Rotate link' }));
    expect(await screen.findByRole('button', { name: 'Copy management link' })).toHaveFocus();
    expect(bodies).toEqual([
      { expectedManagerLinkRevision: 0 },
      { expectedManagerLinkRevision: 0 },
      { expectedManagerLinkRevision: 1 },
    ]);
  });

  it('requires explicit rotate fallback acknowledgement before continuing', async () => {
    const { fetchMock } = managerRotationFetch();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('Clipboard unavailable'));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    const user = userEvent.setup();
    expect(await screen.findByRole('heading', { name: 'Live intake' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    const trigger = screen.getByRole('button', { name: 'Rotate manager link' });
    await user.click(trigger);
    await user.click(within(await screen.findByRole('dialog'))
      .getByRole('button', { name: 'Rotate link' }));
    await user.click(await screen.findByRole('button', { name: 'Copy management link' }));

    const fallback = await screen.findByRole('textbox', { name: 'Management link' });
    expect(fallback).toHaveValue(ROTATED_MANAGEMENT_LINK);
    await waitFor(() => expect(fallback).toHaveFocus());
    expect(fallback).toHaveProperty('selectionStart', 0);
    expect(fallback).toHaveProperty('selectionEnd', ROTATED_MANAGEMENT_LINK.length);
    expect(screen.getByRole('button', { name: 'Continue managing' })).toBeDisabled();
    const acknowledge = screen.getByRole('button', { name: "I've saved this link — continue" });
    expect(acknowledge).toBeEnabled();

    const blockedUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(blockedUnload);
    expect(blockedUnload.defaultPrevented).toBe(true);
    await user.click(acknowledge);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    const releasedUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(releasedUnload);
    expect(releasedUnload.defaultPrevented).toBe(false);
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

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Move moment-2.jpg to Recently deleted' }));
    await user.click(within(await screen.findByRole('dialog'))
      .getByRole('button', { name: 'Move to Recently deleted' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('This link was replaced with a new one.');
    expect(screen.getByAltText('Moment 2')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Sign in' }))
      .toHaveAttribute('href', hostSignInHref(RECOVERY_EVENT_ID));
    expect(screen.getByLabelText('Management link')).toBeVisible();
  });

  it.each([
    ['manager action', 'trash'],
    ['trash', 'manager action'],
  ] as const)('does not re-escalate dismissed terminal recovery when %s settles before %s', async (first, second) => {
    const row: MediaView = {
      id: 'terminal-row', originalFilename: 'terminal-row.jpg', guestName: 'Avery', caption: 'Terminal row',
      publicationStatus: 'unpublished', uploadState: 'stored',
    };
    let exportWrites = 0;
    let trashWrites = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/exports') && method === 'POST') {
        exportWrites += 1;
        return errorJson({
          code: 'TOKEN_REVOKED', message: 'Export access was revoked.', requestId: 'request-export',
        }, 403);
      }
      if (url.endsWith('/media/terminal-row/trash') && method === 'POST') {
        trashWrites += 1;
        return errorJson({
          code: 'SESSION_EXPIRED', message: 'Trash access expired.', requestId: 'request-trash',
        }, 401);
      }
      if (url.endsWith('/api/manage/events/event-a')) return json({ event: MANAGED_EVENT });
      if (url.endsWith('/guestbook/summary')) return json({ summary: {
        needsReviewCount: 0, sharedCount: 0, hiddenCount: 0, deletedCount: 0, galleryVisible: true,
      } });
      if (url.endsWith('/api/manage/events/event-a/media')) return json({ media: [row], nextCursor: null });
      if (url.endsWith('/gallery/summary')) return galleryAudienceSummaryJson();
      if (url.includes('/gallery')) return json({ media: [], nextCursor: null });
      if (url.includes('/messages')) return json({ messages: [] });
      if (url.endsWith('/exports')) return json({ exports: [] });
      if (url.endsWith('/entry')) return json({ eventLink: null, disabledAt: null });
      if (url.endsWith('/album')) return json({ album: {
        revision: 0, saved: true, title: 'Album', description: '', coverMediaId: null,
        effectiveCoverMediaId: null, entries: [], photoCount: 0, sectionCount: 0, totalBytes: 0,
      } });
      throw new Error(`Unexpected request ${method} ${url}`);
    }));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Live intake' });

    const trigger = async (source: 'manager action' | 'trash') => {
      if (source === 'manager action') {
        await user.click(screen.getByRole('button', { name: 'Gallery' }));
        await user.click(await screen.findByRole('button', { name: 'Download all' }));
        await waitFor(() => expect(exportWrites).toBeGreaterThan(0));
        return;
      }
      await user.click(screen.getByRole('button', { name: /^Intake/ }));
      await user.click(await screen.findByRole('button', { name: 'Move terminal-row.jpg to Recently deleted' }));
      await user.click(within(await screen.findByRole('dialog'))
        .getByRole('button', { name: 'Move to Recently deleted' }));
      await waitFor(() => expect(trashWrites).toBeGreaterThan(0));
    };

    await trigger(first);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      first === 'manager action' ? 'Export access was revoked.' : 'Trash access expired.',
    );
    await user.click(screen.getByRole('button', { name: 'Dismiss error' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());

    await trigger(second);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(exportWrites).toBe(1);
    expect(trashWrites).toBe(1);
  });

  it('drops a held event-A Shared mutation after routing to event B', async () => {
    const eventA = { ...MANAGED_EVENT, id: 'event-a', name: 'Event A' };
    const eventB = { ...MANAGED_EVENT, id: 'event-b', name: 'Event B' };
    const aRow = {
      id: 'a-row', originalFilename: 'a-row.jpg', guestName: 'Avery', caption: 'Only event A',
      publicationStatus: 'unpublished', uploadState: 'stored',
    };
    let releaseAWrite!: () => void;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const event = url.includes('/event-b') ? eventB : eventA;
      if (url.endsWith('/media/a-row') && method === 'PATCH') {
        return new Promise<Response>((resolve) => {
          releaseAWrite = () => void errorJson({
            code: 'SESSION_EXPIRED', message: 'Event A access expired.', requestId: 'request-a',
          }, 401).then(resolve);
        });
      }
      if (url.endsWith(`/api/manage/events/${event.id}`)) return json({ event });
      if (url.includes('/guestbook/summary')) return json({ summary: {
        needsReviewCount: 0, sharedCount: 0, hiddenCount: 0, deletedCount: 0, galleryVisible: true,
      } });
      if (url.includes('/media')) return json({ media: event.id === 'event-a' ? [aRow] : [], nextCursor: null });
      if (url.endsWith('/gallery/summary')) return galleryAudienceSummaryJson();
      if (url.includes('/gallery')) return json({ media: [], nextCursor: null });
      if (url.includes('/messages')) return json({ messages: [] });
      if (url.endsWith('/exports')) return json({ exports: [] });
      if (url.endsWith('/entry')) return json({ eventLink: null, disabledAt: null });
      if (url.endsWith('/album')) return json({ album: {
        revision: 0, saved: true, title: 'Album', description: '', coverMediaId: null,
        effectiveCoverMediaId: null, entries: [], photoCount: 0, sectionCount: 0, totalBytes: 0,
      } });
      throw new Error(`Unexpected request ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const router = createAppRouter(['/manage/event/event-a']);
    render(<RouterProvider router={router} />);
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Live intake' });
    await user.click(screen.getByRole('button', { name: 'Gallery' }));
    await user.click(await screen.findByRole('button', { name: 'Guest gallery' }));
    await user.click(await screen.findByRole('button', { name: 'Publish a-row.jpg' }));
    await waitFor(() => expect(releaseAWrite).toBeTypeOf('function'));

    await router.navigate('/manage/event/event-b');
    expect(await screen.findByRole('heading', { name: 'Live intake' })).toBeVisible();
    expect(screen.getByRole('heading', { level: 1, name: 'Event B' })).toBeVisible();
    await act(async () => { releaseAWrite(); });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Only event A')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Event B' })).toBeVisible();
  });

  it('does not let an event-A Undo settlement reconcile or announce inside event B', async () => {
    const eventA = { ...MANAGED_EVENT, id: 'event-a', name: 'Event A' };
    const eventB = { ...MANAGED_EVENT, id: 'event-b', name: 'Event B', storedMediaCount: 0 };
    const aRow: MediaView = {
      id: 'stale-undo', originalFilename: 'stale-undo.jpg', guestName: 'Avery',
      caption: 'Event A undo', publicationStatus: 'unpublished', uploadState: 'stored',
    };
    let aRowActive = true;
    let releaseRestore!: () => void;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const event = url.includes('/event-b') ? eventB : eventA;
      if (url.endsWith('/media/stale-undo/trash') && method === 'POST') {
        aRowActive = false;
        return json({ media: {
          ...aRow,
          trashedAt: '2026-09-20T01:00:00.000Z',
          restoreUntil: '2099-10-19T00:00:00.000Z',
        } });
      }
      if (url.endsWith('/media/stale-undo/restore') && method === 'POST') {
        return new Promise<Response>((resolve) => {
          releaseRestore = () => {
            aRowActive = true;
            void json({ media: aRow }).then(resolve);
          };
        });
      }
      if (url.endsWith(`/api/manage/events/${event.id}`)) return json({ event });
      if (url.endsWith('/guestbook/summary')) return json({ summary: {
        needsReviewCount: 0, sharedCount: 0, hiddenCount: 0, deletedCount: 0, galleryVisible: true,
      } });
      if (url.endsWith('/gallery/summary')) return galleryAudienceSummaryJson();
      if (url.includes('/media')) {
        return json({ media: event.id === 'event-a' && aRowActive ? [aRow] : [], nextCursor: null });
      }
      if (url.includes('/gallery')) return json({ media: [], nextCursor: null });
      if (url.includes('/messages')) return json({ messages: [] });
      if (url.endsWith('/exports')) return json({ exports: [] });
      if (url.endsWith('/entry')) return json({ eventLink: null, disabledAt: null });
      throw new Error(`Unexpected request ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const router = createAppRouter(['/manage/event/event-a']);
    render(<RouterProvider router={router} />);
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Live intake' });
    await user.click(await screen.findByRole('button', {
      name: 'Move stale-undo.jpg to Recently deleted',
    }));
    await user.click(within(await screen.findByRole('dialog'))
      .getByRole('button', { name: 'Move to Recently deleted' }));
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(releaseRestore).toBeTypeOf('function'));

    await router.navigate('/manage/event/event-b');
    expect(await screen.findByRole('heading', { level: 1, name: 'Event B' })).toBeVisible();
    const eventAReads = () => fetchMock.mock.calls.filter(([input, request]) => (
      String(input).includes('/api/manage/events/event-a')
      && ((request as RequestInit | undefined)?.method ?? 'GET').toUpperCase() === 'GET'
    ));
    const readsBeforeSettlement = eventAReads().length;
    await act(async () => {
      releaseRestore();
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
    });

    expect(eventAReads()).toHaveLength(readsBeforeSettlement);
    expect(screen.queryByText('Change undone.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Event B' })).toBeVisible();
  });

  it('does not start an event-A export reload after its Manager unmounts for event B', async () => {
    const eventA = { ...MANAGED_EVENT, id: 'event-a', name: 'Event A' };
    const eventB = { ...MANAGED_EVENT, id: 'event-b', name: 'Event B' };
    let releaseAExport!: () => void;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const event = url.includes('/event-b') ? eventB : eventA;
      if (url.endsWith('/exports') && method === 'POST') {
        return new Promise<Response>((resolve) => {
          releaseAExport = () => void json({ accepted: true }).then(resolve);
        });
      }
      if (url.endsWith(`/api/manage/events/${event.id}`)) return json({ event });
      if (url.endsWith('/guestbook/summary')) return json({ summary: {
        needsReviewCount: 0, sharedCount: 0, hiddenCount: 0, deletedCount: 0, galleryVisible: true,
      } });
      if (url.includes('/media')) return json({ media: [], nextCursor: null });
      if (url.endsWith('/gallery/summary')) return galleryAudienceSummaryJson();
      if (url.includes('/gallery')) return json({ media: [], nextCursor: null });
      if (url.includes('/messages')) return json({ messages: [] });
      if (url.endsWith('/exports')) return json({ exports: [] });
      if (url.endsWith('/entry')) return json({ eventLink: null, disabledAt: null });
      if (url.endsWith('/album')) return json({ album: {
        revision: 0, saved: true, title: 'Album', description: '', coverMediaId: null,
        effectiveCoverMediaId: null, entries: [], photoCount: 0, sectionCount: 0, totalBytes: 0,
      } });
      throw new Error(`Unexpected request ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const router = createAppRouter(['/manage/event/event-a']);
    render(<RouterProvider router={router} />);
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Live intake' });
    await user.click(screen.getByRole('button', { name: 'Gallery' }));
    await user.click(screen.getByRole('button', { name: 'Download all' }));
    await waitFor(() => expect(releaseAExport).toBeTypeOf('function'));

    await router.navigate('/manage/event/event-b');
    expect(await screen.findByRole('heading', { name: 'Live intake' })).toBeVisible();
    expect(screen.getByRole('heading', { level: 1, name: 'Event B' })).toBeVisible();
    const eventAExportReads = () => fetchMock.mock.calls.filter(([requested, request]) => (
      String(requested).endsWith('/api/manage/events/event-a/exports')
        && ((request as RequestInit | undefined)?.method ?? 'GET').toUpperCase() === 'GET'
    ));
    const readsBeforeRelease = eventAExportReads().length;

    await act(async () => {
      releaseAExport();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(eventAExportReads()).toHaveLength(readsBeforeRelease);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Event B' })).toBeVisible();
  });

  it('retires event-A export work before event B layout effects can release it', async () => {
    const eventA = { ...MANAGED_EVENT, id: 'event-a', name: 'Event A' };
    const eventB = { ...MANAGED_EVENT, id: 'event-b', name: 'Event B' };
    let releaseAExport!: () => void;
    let resolveBLayout!: () => void;
    const bLayout = new Promise<void>((resolve) => { resolveBLayout = resolve; });
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const event = url.includes('/event-b') ? eventB : eventA;
      if (url.endsWith('/exports') && method === 'POST') {
        return new Promise<Response>((resolve) => {
          releaseAExport = () => void json({ accepted: true }).then(resolve);
        });
      }
      if (url.endsWith(`/api/manage/events/${event.id}`)) return json({ event });
      if (url.endsWith('/guestbook/summary')) return json({ summary: {
        needsReviewCount: 0, sharedCount: 0, hiddenCount: 0, deletedCount: 0, galleryVisible: true,
      } });
      if (url.includes('/media')) return json({ media: [], nextCursor: null });
      if (url.endsWith('/gallery/summary')) return galleryAudienceSummaryJson();
      if (url.includes('/gallery')) return json({ media: [], nextCursor: null });
      if (url.includes('/messages')) return json({ messages: [] });
      if (url.endsWith('/exports')) return json({ exports: [] });
      if (url.endsWith('/entry')) return json({ eventLink: null, disabledAt: null });
      if (url.endsWith('/album')) return json({ album: {
        revision: 0, saved: true, title: 'Album', description: '', coverMediaId: null,
        effectiveCoverMediaId: null, entries: [], photoCount: 0, sectionCount: 0, totalBytes: 0,
      } });
      throw new Error(`Unexpected request ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const router = createMemoryRouter([{
      path: '/manage/event/:eventId',
      element: <LayoutReleaseManagerRoute onEventBLayout={() => {
        releaseAExport();
        resolveBLayout();
      }} />,
    }], { initialEntries: ['/manage/event/event-a'] });
    render(<RouterProvider router={router} />);
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Live intake' });
    await user.click(screen.getByRole('button', { name: 'Gallery' }));
    await user.click(screen.getByRole('button', { name: 'Download all' }));
    await waitFor(() => expect(releaseAExport).toBeTypeOf('function'));

    const eventAExportReads = () => fetchMock.mock.calls.filter(([requested, request]) => (
      String(requested).endsWith('/api/manage/events/event-a/exports')
        && ((request as RequestInit | undefined)?.method ?? 'GET').toUpperCase() === 'GET'
    ));
    const readsBeforeRoute = eventAExportReads().length;
    void router.navigate('/manage/event/event-b');
    await bLayout;
    // The held response crosses `api()`'s envelope parse before the export
    // continuation asks for its follow-up read. Stay in the microtask queue:
    // React's passive unmount cleanup is intentionally not allowed to run here.
    await new Promise<void>((resolve) => {
      let remaining = 20;
      const drain = () => {
        remaining -= 1;
        if (remaining === 0) resolve();
        else queueMicrotask(drain);
      };
      queueMicrotask(drain);
    });

    expect(eventAExportReads()).toHaveLength(readsBeforeRoute);
    expect(await screen.findByRole('heading', { level: 1, name: 'Event B' })).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('opens on live intake, filters by guest name, and keeps the shared gallery secondary', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/manage/events/event-a')) return json({ event: {
        ...MANAGED_EVENT,
        storedMediaCount: 2,
      } });
      if (url.includes('/media')) {
        if (init?.method === 'POST') return json({ changed: ['media-a'] });
        return json({ media: [
          { id: 'media-a', originalFilename: 'toast.png', guestName: 'Avery', caption: 'The toast', publicationStatus: 'unpublished', uploadState: 'stored' },
          { id: 'media-b', originalFilename: 'dance.png', guestName: 'Jamie', caption: 'First dance', publicationStatus: 'unpublished', uploadState: 'stored' },
        ] });
      }
      if (url.endsWith('/gallery/summary')) return galleryAudienceSummaryJson();
      if (url.includes('/gallery')) return json({ media: [], nextCursor: null });
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
    const managerNavigation = screen.getByRole('navigation', { name: 'Manager sections' });
    const intakeNavigation = within(managerNavigation).getByRole('button', { name: /intake/i });
    const galleryNavigation = within(managerNavigation).getByRole('button', { name: /gallery/i });
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
    expect(screen.getByRole('heading', { name: 'Gallery' })).toBeVisible();
    await user.click(await screen.findByRole('button', { name: 'Guest gallery' }));
    await user.click(await screen.findByRole('checkbox', { name: /The toast/i }));
    await user.click(screen.getByRole('button', { name: 'Publish selected' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/manage/events/event-a/media/bulk',
      expect.objectContaining({ body: expect.stringContaining('media-a') }),
    ));
    const bulkCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/media/bulk'));
    expect(bulkCall?.[1]?.body).not.toContain('media-b');
  });

  it('keeps Shared publication separate, clears filters, and scopes its busy and preview states', async () => {
    const rows: MediaView[] = [
      {
        id: 'media-a', originalFilename: 'private-camera-a.jpg', guestName: 'Avery',
        caption: 'The toast', publicationStatus: 'unpublished', uploadState: 'stored',
      },
      {
        id: 'media-b', originalFilename: 'private-camera-b.jpg', guestName: 'Jamie',
        caption: 'First dance', publicationStatus: 'unpublished', uploadState: 'stored',
      },
    ];
    let releaseBulk!: () => void;
    const bulkGate = new Promise<void>((resolve) => { releaseBulk = resolve; });
    let failBulk = false;
    let failIndividual = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/media/media-b') && method === 'PATCH') {
        if (failIndividual) return errorJson({
          code: 'INTERNAL_ERROR', message: 'The photo could not be published.', requestId: 'request-a',
        }, 500);
        rows[1]!.publicationStatus = 'published';
        return json({ media: rows[1] });
      }
      if (url.endsWith('/media/bulk') && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { ids: string[]; action: 'publish' | 'hide' };
        await bulkGate;
        if (failBulk) {
          return errorJson({
            code: 'INTERNAL_ERROR', message: 'The selected photos could not be published.', requestId: 'request-a',
          }, 500);
        }
        for (const row of rows) {
          if (body.ids.includes(row.id)) row.publicationStatus = body.action === 'publish' ? 'published' : 'hidden';
        }
        return json({ changed: rows.filter((row) => body.ids.includes(row.id)) });
      }
      if (url.endsWith('/api/manage/events/event-a')) {
        return json({ event: { ...MANAGED_EVENT, storedMediaCount: rows.length } });
      }
      if (url.endsWith('/guestbook/summary')) return json({ summary: {
        needsReviewCount: 0, sharedCount: 0, hiddenCount: 0, deletedCount: 0, galleryVisible: true,
      } });
      if (url.includes('/media')) {
        const status = new URL(url, window.location.origin).searchParams.get('status');
        return json({
          media: status ? rows.filter((row) => row.publicationStatus === status) : rows,
          nextCursor: null,
        });
      }
      if (url.endsWith('/gallery/summary')) return galleryAudienceSummaryJson();
      if (url.includes('/gallery')) return json({ media: [], nextCursor: null });
      if (url.endsWith('/album')) return json({ album: {
        revision: 0, saved: true, title: 'Album', description: '', coverMediaId: null,
        effectiveCoverMediaId: null, entries: [], photoCount: 0, sectionCount: 0, totalBytes: 0,
      } });
      if (url.includes('/messages')) return json({ messages: [] });
      if (url.endsWith('/exports')) return json({ exports: [] });
      if (url.endsWith('/entry')) {
        return json({ eventLink: 'https://example.test/join#entry-id.entry-secret', disabledAt: null });
      }
      throw new Error(`Unexpected request ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Live intake' });
    await user.click(screen.getByRole('button', { name: 'Gallery' }));
    await user.click(await screen.findByRole('button', { name: 'Guest gallery' }));

    await waitFor(() => expect(screen.getByText('Published photos are visible to event guests.'))
      .toBeVisible());
    const shared = document.querySelector('.gallery-shared') as HTMLElement;
    await waitFor(() => expect(shared.querySelectorAll('.intake-photo img')).toHaveLength(2));
    const images = shared.querySelectorAll<HTMLImageElement>('.intake-photo img');
    fireEvent.error(images[0]!);
    expect(within(shared).getByText('Preview unavailable')).toBeVisible();
    expect(images[1]).toBeVisible();

    const toast = within(shared).getByRole('checkbox', { name: 'Select The toast' });
    await user.click(toast);
    expect(toast).toBeChecked();
    await user.click(within(shared).getByRole('button', { name: 'Published' }));
    // A status change is a new Shared question. The old status's rows and
    // selection do not remain mounted while its cursor is being replaced.
    expect(await within(shared).findByText('No published photos.')).toBeVisible();
    expect(within(shared).queryByRole('checkbox', { name: 'Select The toast' })).not.toBeInTheDocument();
    expect(within(shared).getByRole('button', { name: 'Publish selected' })).toBeDisabled();
    expect(within(shared).getByRole('button', { name: 'Hide selected' })).toBeDisabled();

    await user.click(within(shared).getByRole('button', { name: 'Unpublished' }));
    // The individual card intentionally uses a fire-and-forget handler. A
    // rejected write stays panel-local instead of becoming an unhandled click
    // promise, and leaves the trusted row selectable for later work.
    failIndividual = true;
    await user.click(await within(shared).findByRole('button', { name: 'Publish private-camera-b.jpg' }));
    expect(await screen.findByText('The photo could not be published.')).toBeVisible();
    expect(within(shared).getByText('First dance')).toBeVisible();
    await user.click(await within(shared).findByRole('checkbox', { name: 'Select The toast' }));
    await user.click(within(shared).getByRole('button', { name: 'Publish selected' }));
    const publishing = within(shared).getByRole('button', { name: 'Publishing…' });
    expect(publishing).toBeDisabled();
    expect(publishing).toHaveAttribute('aria-busy', 'true');
    expect(within(shared).getByRole('button', { name: 'Hide selected' })).toBeDisabled();
    expect(within(shared).queryByRole('button', { name: 'Hiding…' })).not.toBeInTheDocument();
    expect(within(shared).getByText('1 of 50 selected').closest('.bulk-bar')).toHaveAttribute('aria-busy', 'true');
    expect(document.querySelectorAll('[data-gallery-live-host] [role="status"]')).toHaveLength(1);
    expect(shared.querySelector('[role="status"]')).toBeNull();

    releaseBulk();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/manage/events/event-a/media/bulk',
      expect.objectContaining({ body: expect.stringContaining('media-a') }),
    ));

    failBulk = true;
    const firstDance = await within(shared).findByRole('checkbox', { name: 'Select First dance' });
    await user.click(firstDance);
    await user.click(within(shared).getByRole('button', { name: 'Publish selected' }));
    await screen.findByText('The selected photos could not be published.');
    const liveStatus = document.querySelector<HTMLElement>('[data-gallery-live-host] [role="status"]');
    expect(liveStatus).toHaveTextContent('Publishing could not be completed.');
    expect(liveStatus).not.toHaveTextContent('Publishing finished.');

    // The card handler is intentionally fire-and-forget. Its controller owns
    // the rejection and the recovery repeats this exact write rather than
    // merely dismissing the panel notice.
    failBulk = false;
    const failedBulk = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/media/bulk'));
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/media/bulk')))
      .toHaveLength(failedBulk.length + 1));
    const retriedBulk = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/media/bulk'));
    expect(retriedBulk.at(-1)?.[1]?.body).toBe(failedBulk.at(-1)?.[1]?.body);
  });

  it('keeps confirmed Shared rows and retries only its failed continuation', async () => {
    let rejectContinuation = true;
    const first = { id: 'shared-first', originalFilename: 'first.jpg', guestName: 'Avery', caption: 'Confirmed shared row', publicationStatus: 'unpublished', uploadState: 'stored' };
    const next = { id: 'shared-next', originalFilename: 'next.jpg', guestName: 'Jamie', caption: 'Retried shared row', publicationStatus: 'unpublished', uploadState: 'stored' };
    const base = managerFetch({
      first: { media: [first], nextCursor: 'shared-next' },
      'shared-next': { media: [next], nextCursor: null },
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('cursor=shared-next') && rejectContinuation) {
        return errorJson({ code: 'INTERNAL_ERROR', message: 'Shared continuation unavailable.', requestId: 'request-a' }, 500);
      }
      return base(input);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Live intake' });
    await user.click(screen.getByRole('button', { name: 'Gallery' }));
    await user.click(await screen.findByRole('button', { name: 'Guest gallery' }));
    const shared = document.querySelector('.gallery-shared') as HTMLElement;
    expect(await within(shared).findByText('Confirmed shared row')).toBeVisible();

    await user.click(within(shared).getByRole('button', { name: 'Load more photos' }));
    expect(await screen.findByText('Shared continuation unavailable.')).toBeVisible();
    expect(within(shared).getByText('Confirmed shared row')).toBeVisible();

    rejectContinuation = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await within(shared).findByText('Retried shared row')).toBeVisible();
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('cursor=shared-next'))).toHaveLength(2);
  });

  it.each([
    ['row write'],
    ['bulk write'],
    ['continuation'],
  ] as const)('clears the obsolete Shared %s retry after its retry escalates terminally', async (operation) => {
    const row: MediaView = {
      id: 'shared-terminal-row', originalFilename: 'shared-terminal-row.jpg', guestName: 'Avery',
      caption: 'Shared terminal row', publicationStatus: 'unpublished', uploadState: 'stored',
    };
    const retryMessage = `Retryable Shared ${operation} failure.`;
    const terminalMessage = `Terminal Shared ${operation} failure.`;
    let attempts = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const isOperation = operation === 'row write'
        ? url.endsWith('/media/shared-terminal-row') && method === 'PATCH'
        : operation === 'bulk write'
          ? url.endsWith('/media/bulk') && method === 'POST'
          : url.includes('cursor=shared-terminal-next') && method === 'GET';
      if (isOperation) {
        attempts += 1;
        return attempts === 1
          ? errorJson({ code: 'INTERNAL_ERROR', message: retryMessage, requestId: 'request-retry' }, 500)
          : errorJson({ code: 'TOKEN_REVOKED', message: terminalMessage, requestId: 'request-terminal' }, 403);
      }
      if (url.endsWith('/api/manage/events/event-a')) return json({ event: MANAGED_EVENT });
      if (url.endsWith('/guestbook/summary')) return json({ summary: {
        needsReviewCount: 0, sharedCount: 0, hiddenCount: 0, deletedCount: 0, galleryVisible: true,
      } });
      if (url.includes('/api/manage/events/event-a/media')) return json({
        media: [row], nextCursor: operation === 'continuation' ? 'shared-terminal-next' : null,
      });
      if (url.endsWith('/gallery/summary')) return galleryAudienceSummaryJson();
      if (url.includes('/gallery')) return json({ media: [], nextCursor: null });
      if (url.includes('/messages')) return json({ messages: [] });
      if (url.endsWith('/exports')) return json({ exports: [] });
      if (url.endsWith('/entry')) return json({ eventLink: null, disabledAt: null });
      if (url.endsWith('/album')) return json({ album: {
        revision: 0, saved: true, title: 'Album', description: '', coverMediaId: null,
        effectiveCoverMediaId: null, entries: [], photoCount: 0, sectionCount: 0, totalBytes: 0,
      } });
      throw new Error(`Unexpected request ${method} ${url}`);
    }));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Live intake' });
    await user.click(screen.getByRole('button', { name: 'Gallery' }));
    await user.click(await screen.findByRole('button', { name: 'Guest gallery' }));
    const shared = document.querySelector('.gallery-shared') as HTMLElement;
    await within(shared).findByText('Shared terminal row');

    if (operation === 'row write') {
      await user.click(within(shared).getByRole('button', { name: 'Publish shared-terminal-row.jpg' }));
    } else if (operation === 'bulk write') {
      await user.click(within(shared).getByRole('checkbox', { name: 'Select Shared terminal row' }));
      await user.click(within(shared).getByRole('button', { name: 'Publish selected' }));
    } else {
      await user.click(within(shared).getByRole('button', { name: 'Load more photos' }));
    }
    expect(await screen.findByText(retryMessage)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(attempts).toBe(2));
    expect(await screen.findByText(terminalMessage)).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Dismiss error' }));
    expect(screen.queryByText(retryMessage)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    if (operation === 'continuation') {
      // Dismissing recovery does not make a confirmed credential answer
      // retryable. The retained page can still show its cursor, but it must
      // not keep issuing that terminal continuation on every click.
      await user.click(within(shared).getByRole('button', { name: 'Load more photos' }));
      expect(attempts).toBe(2);
    }
  });

  it('preserves the selected Gallery mode while a Manager epoch remounts Library and reloads Shared', async () => {
    let libraryReads = 0;
    let sharedReads = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/gallery?')) {
        libraryReads += 1;
        return json({ media: [], nextCursor: null });
      }
      if (url.includes('/media')) {
        sharedReads += 1;
        return json({ media: [], nextCursor: null });
      }
      throw new Error(`Unexpected request ${url}`);
    }));
    const workspace = (galleryMutationEpoch: number) => <ManagerGalleryWorkspaceWithUndo
        event={MANAGED_EVENT as unknown as EventView}
        eventId="event-a"
        galleryMutationEpoch={galleryMutationEpoch}
        invalidateGalleryAfterMutation={() => {}}
        audience={directGalleryAudienceAuthority()}
        onAnnouncement={vi.fn()}
        shared={{
          onPublicationChanged: () => {},
          onOpenSettings: () => {},
          settingsBlocked: false,
        }}
        exports={{
          status: 'ready',
          onPrepare: async () => {},
          onDownload: async () => {},
          onRetry: async () => {},
          currentSource: { count: MANAGED_EVENT.storedMediaCount, freshness: 'fresh' },
        }}
      />;
    const view = render(workspace(0));
    const user = userEvent.setup();
    await waitFor(() => expect(libraryReads).toBe(1));
    await user.click(screen.getByRole('button', { name: 'Guest gallery' }));
    await waitFor(() => expect(sharedReads).toBe(1));

    view.rerender(workspace(1));

    expect(screen.getByRole('button', { name: 'Guest gallery' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => {
      expect(libraryReads).toBe(2);
      expect(sharedReads).toBe(2);
    });
  });

  it('adopts each confirmed mixed-status Shared bulk group and retries only the failed group', async () => {
    const unpublished: MediaView = {
      id: 'mixed-unpublished', originalFilename: 'unpublished.jpg', guestName: 'Avery',
      caption: 'Unpublished mixed', publicationStatus: 'unpublished', uploadState: 'stored',
    };
    const published: MediaView = {
      id: 'mixed-published', originalFilename: 'published.jpg', guestName: 'Jamie',
      caption: 'Published mixed', publicationStatus: 'published', uploadState: 'stored',
    };
    const publishedUnpublished = { ...unpublished, publicationStatus: 'published' as const };
    const bulkBodies: Array<{ ids: string[]; action: string; expectedStatus: string }> = [];
    let failPublishedGroup = true;
    const onPublicationChanged = vi.fn();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/media/bulk') && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { ids: string[]; action: string; expectedStatus: string };
        bulkBodies.push(body);
        if (body.expectedStatus === 'published' && failPublishedGroup) {
          return errorJson({ code: 'INTERNAL_ERROR', message: 'Published group unavailable.', requestId: 'request-published' }, 500);
        }
        return json({ changed: body.expectedStatus === 'unpublished' ? [publishedUnpublished] : [published] });
      }
      if (url.endsWith('/api/manage/events/event-a/media')) {
        return json({ media: [unpublished, published], nextCursor: null });
      }
      if (url.endsWith('/gallery/summary')) return galleryAudienceSummaryJson();
      if (url.includes('/gallery')) return json({ media: [], nextCursor: null });
      if (url.endsWith('/album')) return json({ album: {
        revision: 0, saved: true, title: 'Album', description: '', coverMediaId: null,
        effectiveCoverMediaId: null, entries: [], photoCount: 0, sectionCount: 0, totalBytes: 0,
      } });
      throw new Error(`Unexpected request ${method} ${url}`);
    }));
    render(<ManagerGalleryWorkspaceWithUndo
      event={MANAGED_EVENT as unknown as EventView}
      eventId="event-a"
      galleryMutationEpoch={0}
      invalidateGalleryAfterMutation={() => {}}
      audience={directGalleryAudienceAuthority()}
      onAnnouncement={vi.fn()}
      shared={{
        status: 'all',
        onPublicationChanged,
        onOpenSettings: () => {},
        settingsBlocked: false,
      }}
      exports={{
        status: 'ready',
        onPrepare: async () => {},
        onDownload: async () => {},
        onRetry: async () => {},
        currentSource: { count: MANAGED_EVENT.storedMediaCount, freshness: 'fresh' },
      }}
    />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Guest gallery' }));
    const shared = document.querySelector('.gallery-shared') as HTMLElement;
    expect(await within(shared).findByText('Unpublished mixed')).toBeVisible();
    await user.click(within(shared).getByRole('checkbox', { name: 'Select Unpublished mixed' }));
    await user.click(within(shared).getByRole('checkbox', { name: 'Select Published mixed' }));
    await user.click(within(shared).getByRole('button', { name: 'Publish selected' }));

    expect(await screen.findByText('Published group unavailable.')).toBeVisible();
    expect(bulkBodies).toEqual([
      { ids: ['mixed-unpublished'], action: 'publish', expectedStatus: 'unpublished' },
      { ids: ['mixed-published'], action: 'publish', expectedStatus: 'published' },
    ]);
    expect(onPublicationChanged).toHaveBeenCalledWith([publishedUnpublished]);
    expect(within(shared).getByText('1 of 50 selected')).toBeVisible();

    failPublishedGroup = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(bulkBodies).toHaveLength(3));
    expect(bulkBodies[2]).toEqual({
      ids: ['mixed-published'], action: 'publish', expectedStatus: 'published',
    });
    expect(onPublicationChanged).toHaveBeenLastCalledWith([published]);
  });

  it('composes two held same-query Shared row projections in their settlement order', async () => {
    const first: MediaView = {
      id: 'row-first', originalFilename: 'first.jpg', guestName: 'Avery',
      caption: 'First held row', publicationStatus: 'unpublished', uploadState: 'stored',
    };
    const second: MediaView = {
      id: 'row-second', originalFilename: 'second.jpg', guestName: 'Jamie',
      caption: 'Second held row', publicationStatus: 'unpublished', uploadState: 'stored',
    };
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const onPublicationChanged = vi.fn();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/media/row-first') && method === 'PATCH') {
        return new Promise<Response>((resolve) => {
          releaseFirst = () => void json({ media: { ...first, publicationStatus: 'published' } }).then(resolve);
        });
      }
      if (url.endsWith('/media/row-second') && method === 'PATCH') {
        return new Promise<Response>((resolve) => {
          releaseSecond = () => void json({ media: { ...second, publicationStatus: 'published' } }).then(resolve);
        });
      }
      if (url.includes('/api/manage/events/event-a/media') && method === 'GET') {
        return json({ media: [first, second], nextCursor: null });
      }
      if (url.endsWith('/gallery/summary')) return galleryAudienceSummaryJson();
      if (url.includes('/gallery')) return json({ media: [], nextCursor: null });
      if (url.endsWith('/album')) return json({ album: {
        revision: 0, saved: true, title: 'Album', description: '', coverMediaId: null,
        effectiveCoverMediaId: null, entries: [], photoCount: 0, sectionCount: 0, totalBytes: 0,
      } });
      throw new Error(`Unexpected request ${method} ${url}`);
    }));
    render(<ManagerGalleryWorkspaceWithUndo
      event={MANAGED_EVENT as unknown as EventView}
      eventId="event-a"
      galleryMutationEpoch={0}
      invalidateGalleryAfterMutation={() => {}}
      audience={directGalleryAudienceAuthority()}
      onAnnouncement={vi.fn()}
      shared={{
        onPublicationChanged,
        onOpenSettings: () => {},
        settingsBlocked: false,
      }}
      exports={{
        status: 'ready',
        onPrepare: async () => {},
        onDownload: async () => {},
        onRetry: async () => {},
        currentSource: { count: MANAGED_EVENT.storedMediaCount, freshness: 'fresh' },
      }}
    />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Guest gallery' }));
    const shared = document.querySelector('.gallery-shared') as HTMLElement;
    expect(await within(shared).findByText('First held row')).toBeVisible();
    await user.click(within(shared).getByRole('button', { name: 'Publish first.jpg' }));
    await user.click(within(shared).getByRole('button', { name: 'Publish second.jpg' }));
    await waitFor(() => {
      expect(releaseFirst).toBeTypeOf('function');
      expect(releaseSecond).toBeTypeOf('function');
    });

    await act(async () => { releaseSecond(); });
    await act(async () => { releaseFirst(); });

    expect(await within(shared).findByText('No unpublished photos.')).toBeVisible();
    expect(onPublicationChanged).toHaveBeenCalledWith([{ ...second, publicationStatus: 'published' }]);
    expect(onPublicationChanged).toHaveBeenCalledWith([{ ...first, publicationStatus: 'published' }]);
  });

  it('keeps a Shared write failure until that write, rather than a sibling, succeeds', async () => {
    const first: MediaView = {
      id: 'failure-first', originalFilename: 'first-failure.jpg', guestName: 'Avery',
      caption: 'Successful sibling', publicationStatus: 'unpublished', uploadState: 'stored',
    };
    const second: MediaView = {
      id: 'failure-second', originalFilename: 'second-failure.jpg', guestName: 'Jamie',
      caption: 'Failed write', publicationStatus: 'unpublished', uploadState: 'stored',
    };
    let releaseFirst!: () => void;
    let releaseSecondFailure!: () => void;
    let secondWrites = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/media/failure-first') && method === 'PATCH') {
        return new Promise<Response>((resolve) => {
          releaseFirst = () => void json({ media: { ...first, publicationStatus: 'published' } }).then(resolve);
        });
      }
      if (url.endsWith('/media/failure-second') && method === 'PATCH') {
        secondWrites += 1;
        if (secondWrites === 1) {
          return new Promise<Response>((resolve) => {
            releaseSecondFailure = () => void errorJson({
              code: 'INTERNAL_ERROR', message: 'The failed row is unavailable.', requestId: 'request-failed-row',
            }, 500).then(resolve);
          });
        }
        return json({ media: { ...second, publicationStatus: 'published' } });
      }
      if (url.includes('/api/manage/events/event-a/media') && method === 'GET') {
        return json({ media: [first, second], nextCursor: null });
      }
      if (url.endsWith('/gallery/summary')) return galleryAudienceSummaryJson();
      if (url.includes('/gallery')) return json({ media: [], nextCursor: null });
      if (url.endsWith('/album')) return json({ album: {
        revision: 0, saved: true, title: 'Album', description: '', coverMediaId: null,
        effectiveCoverMediaId: null, entries: [], photoCount: 0, sectionCount: 0, totalBytes: 0,
      } });
      throw new Error(`Unexpected request ${method} ${url}`);
    }));
    render(<ManagerGalleryWorkspaceWithUndo
      event={MANAGED_EVENT as unknown as EventView}
      eventId="event-a"
      galleryMutationEpoch={0}
      invalidateGalleryAfterMutation={() => {}}
      audience={directGalleryAudienceAuthority()}
      onAnnouncement={vi.fn()}
      shared={{
        onPublicationChanged: () => {},
        onOpenSettings: () => {},
        settingsBlocked: false,
      }}
      exports={{
        status: 'ready',
        onPrepare: async () => {},
        onDownload: async () => {},
        onRetry: async () => {},
        currentSource: { count: MANAGED_EVENT.storedMediaCount, freshness: 'fresh' },
      }}
    />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Guest gallery' }));
    const shared = document.querySelector('.gallery-shared') as HTMLElement;
    expect(await within(shared).findByText('Successful sibling')).toBeVisible();
    await user.click(within(shared).getByRole('button', { name: 'Publish first-failure.jpg' }));
    await user.click(within(shared).getByRole('button', { name: 'Publish second-failure.jpg' }));
    await waitFor(() => {
      expect(releaseFirst).toBeTypeOf('function');
      expect(releaseSecondFailure).toBeTypeOf('function');
    });

    await act(async () => { releaseSecondFailure(); });
    expect(await screen.findByText('The failed row is unavailable.')).toBeVisible();
    await act(async () => { releaseFirst(); });
    expect(screen.getByText('The failed row is unavailable.')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(secondWrites).toBe(2));
    expect(screen.queryByText('The failed row is unavailable.')).not.toBeInTheDocument();
  });

  it('drops a held Shared continuation failure when its status query changes', async () => {
    let releaseOldContinuation!: () => void;
    const unpublished = {
      id: 'unpublished-row', originalFilename: 'unpublished.jpg', guestName: 'Avery', caption: 'Unpublished row',
      publicationStatus: 'unpublished', uploadState: 'stored',
    };
    const published = {
      id: 'published-row', originalFilename: 'published.jpg', guestName: 'Jamie', caption: 'Published row',
      publicationStatus: 'published', uploadState: 'stored',
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/manage/events/event-a')) return json({ event: MANAGED_EVENT });
      if (url.includes('status=unpublished') && url.includes('cursor=old-shared')) {
        return new Promise<Response>((resolve) => {
          releaseOldContinuation = () => void errorJson({
            code: 'INTERNAL_ERROR', message: 'Old shared continuation failed.', requestId: 'request-a',
          }, 500).then(resolve);
        });
      }
      if (url.includes('status=unpublished')) return json({ media: [unpublished], nextCursor: 'old-shared' });
      if (url.includes('status=published')) return json({ media: [published], nextCursor: null });
      if (url.includes('/media')) return json({ media: [unpublished], nextCursor: null });
      if (url.includes('/guestbook/summary')) return json({ summary: {
        needsReviewCount: 0, sharedCount: 0, hiddenCount: 0, deletedCount: 0, galleryVisible: true,
      } });
      if (url.endsWith('/gallery/summary')) return galleryAudienceSummaryJson();
      if (url.includes('/gallery')) return json({ media: [], nextCursor: null });
      if (url.includes('/messages')) return json({ messages: [] });
      if (url.endsWith('/exports')) return json({ exports: [] });
      if (url.endsWith('/entry')) return json({ eventLink: null, disabledAt: null });
      if (url.endsWith('/album')) return json({ album: {
        revision: 0, saved: true, title: 'Album', description: '', coverMediaId: null,
        effectiveCoverMediaId: null, entries: [], photoCount: 0, sectionCount: 0, totalBytes: 0,
      } });
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Live intake' });
    await user.click(screen.getByRole('button', { name: 'Gallery' }));
    await user.click(await screen.findByRole('button', { name: 'Guest gallery' }));
    const shared = document.querySelector('.gallery-shared') as HTMLElement;
    expect(await within(shared).findByText('Unpublished row')).toBeVisible();
    await user.click(within(shared).getByRole('button', { name: 'Load more photos' }));
    await waitFor(() => expect(releaseOldContinuation).toBeTypeOf('function'));

    await user.click(within(shared).getByRole('button', { name: 'Published' }));
    expect(await within(shared).findByText('Published row')).toBeVisible();
    await act(async () => { releaseOldContinuation(); });

    expect(screen.queryByText('Old shared continuation failed.')).not.toBeInTheDocument();
    expect(within(shared).getByText('Published row')).toBeVisible();
  });

  it('silently drops a retired Shared continuation failure after a confirmed row projection', async () => {
    const row: MediaView = {
      id: 'shared-retire-row', originalFilename: 'shared-retire-row.jpg', guestName: 'Avery',
      caption: 'Retire Shared', publicationStatus: 'unpublished', uploadState: 'stored',
    };
    let releaseStalePage!: () => void;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.includes('cursor=shared-retire-cursor')) {
        return new Promise<Response>((resolve) => {
          releaseStalePage = () => void errorJson({
            code: 'INTERNAL_ERROR', message: 'Stale Shared continuation failed.', requestId: 'request-stale-shared',
          }, 500).then(resolve);
        });
      }
      if (url.endsWith('/media/shared-retire-row') && method === 'PATCH') {
        return json({ media: { ...row, publicationStatus: 'published' } });
      }
      if (url.includes('/api/manage/events/event-a/media')) {
        return json({ media: [row], nextCursor: 'shared-retire-cursor' });
      }
      if (url.endsWith('/gallery/summary')) return galleryAudienceSummaryJson();
      if (url.includes('/gallery')) return json({ media: [], nextCursor: null });
      if (url.endsWith('/album')) return json({ album: {
        revision: 0, saved: true, title: 'Album', description: '', coverMediaId: null,
        effectiveCoverMediaId: null, entries: [], photoCount: 0, sectionCount: 0, totalBytes: 0,
      } });
      throw new Error(`Unexpected request ${method} ${url}`);
    }));
    render(<ManagerGalleryWorkspaceWithUndo
      event={MANAGED_EVENT as unknown as EventView}
      eventId="event-a"
      galleryMutationEpoch={0}
      invalidateGalleryAfterMutation={() => {}}
      audience={directGalleryAudienceAuthority()}
      onAnnouncement={vi.fn()}
      shared={{
        onPublicationChanged: () => {},
        onOpenSettings: () => {},
        settingsBlocked: false,
      }}
      exports={{
        status: 'ready',
        onPrepare: async () => {},
        onDownload: async () => {},
        onRetry: async () => {},
        currentSource: { count: MANAGED_EVENT.storedMediaCount, freshness: 'fresh' },
      }}
    />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Guest gallery' }));
    const shared = document.querySelector('.gallery-shared') as HTMLElement;
    expect(await within(shared).findByText('Retire Shared')).toBeVisible();
    await user.click(within(shared).getByRole('button', { name: 'Load more photos' }));
    await waitFor(() => expect(releaseStalePage).toBeTypeOf('function'));

    await user.click(within(shared).getByRole('button', { name: 'Publish shared-retire-row.jpg' }));
    expect(await within(shared).findByText('No unpublished photos.')).toBeVisible();
    await act(async () => { releaseStalePage(); });

    expect(screen.queryByText('Stale Shared continuation failed.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('drains Album work before a manager-section change and a router unmount', async () => {
    let resolveFirstSave!: () => void;
    let resolveSecondSave!: () => void;
    const firstSave = new Promise<void>((resolve) => { resolveFirstSave = resolve; });
    const secondSave = new Promise<void>((resolve) => { resolveSecondSave = resolve; });
    const saveGates = [firstSave, secondSave];
    let revision = 0;
    const base = managerFetch({ first: { media: [], nextCursor: null } });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/album/share') && method === 'GET') return json({ share: null });
      if (url.endsWith('/album') && method === 'GET') return json({ album: {
        revision,
        saved: true,
        title: 'Album',
        description: '',
        coverMediaId: null,
        effectiveCoverMediaId: null,
        entries: [],
        photoCount: 0,
        sectionCount: 0,
        totalBytes: 0,
      } });
      if (url.endsWith('/album') && method === 'PUT') {
        const write = revision;
        await saveGates[write];
        const body = JSON.parse(String(init?.body));
        revision += 1;
        return json({ album: {
          revision,
          saved: true,
          ...body.metadata,
          effectiveCoverMediaId: null,
          entries: [],
          photoCount: 0,
          sectionCount: 0,
          totalBytes: 0,
        } });
      }
      return base(input);
    });
    vi.stubGlobal('fetch', fetchMock);
    const router = createAppRouter(['/manage/event/event-a']);
    render(<RouterProvider router={router} />);
    const user = userEvent.setup();
    const managerNavigation = await screen.findByRole('navigation', { name: 'Manager sections' });

    await user.click(within(managerNavigation).getByRole('button', { name: /gallery/i }));
    await user.click(within(await screen.findByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: /^Album/ }));
    fireEvent.change(await screen.findByLabelText('Album title'), { target: { value: 'Before Intake' } });
    await user.click(within(managerNavigation).getByRole('button', { name: /intake/i }));
    expect(screen.getByLabelText('Album title')).toBeVisible();
    const sectionPrompt = await screen.findByRole('region', {
      name: 'Album changes are not saved yet',
    });
    expect(sectionPrompt).toHaveFocus();
    expect(within(sectionPrompt).getByRole('button', {
      name: 'Discard unsent Album changes and leave',
    })).toBeDisabled();
    expect(sectionPrompt).toHaveTextContent('A change already sent may still finish saving');
    await act(async () => { resolveFirstSave(); });
    expect(await screen.findByRole('heading', { name: 'Live intake' })).toBeVisible();

    await user.click(within(managerNavigation).getByRole('button', { name: /gallery/i }));
    await user.click(within(await screen.findByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: /^Album/ }));
    fireEvent.change(await screen.findByLabelText('Album title'), { target: { value: 'Before route leave' } });
    const navigation = router.navigate('/privacy');
    await waitFor(() => expect(fetchMock.mock.calls.some(([request, requestInit]) => (
      String(request).endsWith('/album') && requestInit?.method === 'PUT'
    ))).toBe(true));
    expect(screen.getByLabelText('Album title')).toBeVisible();
    expect(await screen.findByRole('region', {
      name: 'Album changes are not saved yet',
    })).toHaveTextContent('Finishing Album checks');
    await act(async () => { resolveSecondSave(); });
    await navigation;
    expect(await screen.findByRole('heading', { name: 'Privacy' })).toBeVisible();
  });

  it('offers the Album recovery actions for an invalid manager-section destination', async () => {
    const base = managerFetch({ first: { media: [], nextCursor: null } });
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/album/share') && method === 'GET') return json({ share: null });
      if (url.endsWith('/album') && method === 'GET') return json({ album: {
        revision: 0,
        saved: true,
        title: 'Album',
        description: '',
        coverMediaId: null,
        effectiveCoverMediaId: null,
        entries: [],
        photoCount: 0,
        sectionCount: 0,
        totalBytes: 0,
      } });
      return base(input);
    }));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    const user = userEvent.setup();
    const managerNavigation = await screen.findByRole('navigation', { name: 'Manager sections' });
    await user.click(within(managerNavigation).getByRole('button', { name: /gallery/i }));
    await user.click(within(await screen.findByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: /^Album/ }));
    await user.clear(await screen.findByLabelText('Album title'));

    await user.click(within(managerNavigation).getByRole('button', { name: 'Share' }));
    const prompt = await screen.findByRole('region', {
      name: 'Album changes are not saved yet',
    });
    expect(prompt).toHaveFocus();
    expect(within(managerNavigation).getByRole('button', { name: /gallery/i }))
      .toHaveAttribute('aria-pressed', 'true');
    expect(within(prompt).getByRole('button', { name: 'Retry' })).toBeEnabled();
    expect(within(prompt).getByRole('button', { name: 'Stay in Album' })).toBeEnabled();

    await user.click(within(prompt).getByRole('button', {
      name: 'Discard unsent Album changes and leave',
    }));
    expect(await screen.findByRole('heading', { name: 'Share your event' })).toBeVisible();
    await user.click(screen.getByRole('link', { name: 'Candidary home' }));
    await waitFor(() => expect(screen.queryByRole('navigation', { name: 'Manager sections' }))
      .not.toBeInTheDocument());
    expect(screen.queryByRole('region', { name: /not saved yet/i })).not.toBeInTheDocument();
  });

  it('restarts Album preparation when a blocked router destination changes', async () => {
    let resolveSave!: () => void;
    const saveGate = new Promise<void>((resolve) => { resolveSave = resolve; });
    let writes = 0;
    const base = managerFetch({ first: { media: [], nextCursor: null } });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/album/share') && method === 'GET') return json({ share: null });
      if (url.endsWith('/album') && method === 'GET') return json({ album: {
        revision: writes,
        saved: true,
        title: writes === 0 ? 'Album' : 'Destination winner',
        description: '',
        coverMediaId: null,
        effectiveCoverMediaId: null,
        entries: [],
        photoCount: 0,
        sectionCount: 0,
        totalBytes: 0,
      } });
      if (url.endsWith('/album') && method === 'PUT') {
        writes += 1;
        await saveGate;
        const body = JSON.parse(String(init?.body));
        return json({ album: {
          revision: writes,
          saved: true,
          ...body.metadata,
          effectiveCoverMediaId: null,
          entries: [],
          photoCount: 0,
          sectionCount: 0,
          totalBytes: 0,
        } });
      }
      return base(input);
    });
    vi.stubGlobal('fetch', fetchMock);
    const router = createAppRouter(['/manage/event/event-a']);
    render(<RouterProvider router={router} />);
    const user = userEvent.setup();
    const managerNavigation = await screen.findByRole('navigation', { name: 'Manager sections' });
    await user.click(within(managerNavigation).getByRole('button', { name: /gallery/i }));
    await user.click(within(await screen.findByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: /^Album/ }));
    fireEvent.change(await screen.findByLabelText('Album title'), {
      target: { value: 'Destination winner' },
    });

    void router.navigate('/privacy');
    await waitFor(() => expect(writes).toBe(1));
    expect(router.state.location.pathname).toBe('/manage/event/event-a');
    expect(screen.queryByRole('heading', { name: 'Privacy' })).not.toBeInTheDocument();

    void router.navigate('/terms');
    await act(async () => { await Promise.resolve(); });
    expect(router.state.location.pathname).toBe('/manage/event/event-a');
    expect(screen.queryByRole('heading', { name: 'Terms' })).not.toBeInTheDocument();

    await act(async () => { resolveSave(); });

    expect(await screen.findByRole('heading', { name: 'Terms' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Privacy' })).not.toBeInTheDocument();
  });

  it('offers recovery and discards only to the exact current Router destination after an Album conflict', async () => {
    let albumReads = 0;
    let albumWrites = 0;
    let resolveReplacementSave!: () => void;
    const replacementSave = new Promise<void>((resolve) => { resolveReplacementSave = resolve; });
    const base = managerFetch({ first: { media: [], nextCursor: null } });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/album/share') && method === 'GET') return json({ share: null });
      if (url.endsWith('/album') && method === 'GET') {
        albumReads += 1;
        return json({ album: {
          revision: 3,
          saved: true,
          title: 'Canonical album',
          description: '',
          coverMediaId: null,
          effectiveCoverMediaId: null,
          entries: [],
          photoCount: 0,
          sectionCount: 0,
          totalBytes: 0,
        } });
      }
      if (url.endsWith('/album') && method === 'PUT') {
        albumWrites += 1;
        if (albumWrites === 2) await replacementSave;
        return errorJson({
          code: 'REVISION_CONFLICT',
          message: 'A co-host saved a newer album.',
          requestId: 'request-conflict',
        }, 409);
      }
      return base(input);
    });
    vi.stubGlobal('fetch', fetchMock);
    const router = createAppRouter(['/manage/event/event-a']);
    render(<RouterProvider router={router} />);
    const user = userEvent.setup();
    const managerNavigation = await screen.findByRole('navigation', { name: 'Manager sections' });
    await user.click(within(managerNavigation).getByRole('button', { name: /gallery/i }));
    await user.click(within(await screen.findByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: /^Album/ }));
    fireEvent.change(await screen.findByLabelText('Album title'), { target: { value: 'Losing edit' } });

    void router.navigate('/privacy');
    await waitFor(() => expect(albumReads).toBeGreaterThanOrEqual(2));
    const prompt = await screen.findByRole('region', {
      name: 'Album changes are not saved yet',
    });
    expect(prompt).toHaveFocus();
    expect(prompt).toHaveTextContent('A change already sent may still finish saving');
    expect(prompt).toHaveTextContent('The Album changed while leaving was being prepared. Try again.');
    expect(within(prompt).getByRole('button', { name: 'Retry' })).toBeEnabled();
    expect(within(prompt).getByRole('button', { name: 'Stay in Album' })).toBeEnabled();
    expect(within(prompt).getByRole('button', {
      name: 'Discard unsent Album changes and leave',
    })).toBeEnabled();
    const modes = within(screen.getByRole('group', { name: 'Gallery mode' }));
    expect(modes.getByRole('button', { name: 'Library' })).toBeDisabled();
    expect(modes.getByRole('button', { name: 'Guest gallery' })).toBeDisabled();

    await user.click(within(prompt).getByRole('button', { name: 'Stay in Album' }));
    expect(router.state.location.pathname).toBe('/manage/event/event-a');
    const title = screen.getByLabelText('Album title');
    expect(screen.getByRole('heading', { name: 'Album' })).toHaveFocus();
    expect(modes.getByRole('button', { name: 'Library' })).toBeEnabled();

    fireEvent.change(title, { target: { value: 'Second losing edit' } });
    void router.navigate('/privacy');
    await waitFor(() => expect(albumWrites).toBe(2));
    const waitingPrompt = await screen.findByRole('region', {
      name: 'Album changes are not saved yet',
    });
    expect(within(waitingPrompt).getByRole('button', {
      name: 'Discard unsent Album changes and leave',
    })).toBeDisabled();
    void router.navigate('/terms');
    await act(async () => { resolveReplacementSave(); });
    await waitFor(() => expect(within(screen.getByRole('region', {
      name: 'Album changes are not saved yet',
    })).getByRole('button', { name: 'Discard unsent Album changes and leave' })).toBeEnabled());
    const replacement = screen.getByRole('region', {
      name: 'Album changes are not saved yet',
    });
    await user.click(within(replacement).getByRole('button', {
      name: 'Discard unsent Album changes and leave',
    }));
    expect(await screen.findByRole('heading', { name: 'Terms' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Privacy' })).not.toBeInTheDocument();
  });

  it('hoists a non-retryable Album load into focused manager access recovery', async () => {
    const base = managerFetch({ first: { media: [], nextCursor: null } });
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/album/share')) return json({ share: null });
      if (url.endsWith('/album')) return errorJson({
        code: 'SESSION_EXPIRED',
        message: 'This session has expired.',
        requestId: 'request-album',
      }, 401);
      return base(input);
    }));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    const user = userEvent.setup();
    const managerNavigation = await screen.findByRole('navigation', { name: 'Manager sections' });
    await user.click(within(managerNavigation).getByRole('button', { name: /gallery/i }));
    await user.click(within(await screen.findByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: /^Album/ }));

    const notice = await screen.findByLabelText('Manager notice');
    expect(notice).toHaveTextContent('This session has expired.');
    expect(notice).toHaveFocus();
    expect(within(notice).getByRole('link', { name: 'Sign in' })).toBeVisible();
    expect(within(notice).getByLabelText('Management link')).toBeVisible();

    await user.click(within(notice).getByRole('button', { name: 'Dismiss error' }));
    expect(screen.queryByLabelText('Manager notice')).not.toBeInTheDocument();
    await user.click(within(managerNavigation).getByRole('button', { name: /intake/i }));
    const restored = await screen.findByLabelText('Manager notice');
    expect(restored).toHaveTextContent('This session has expired.');
    expect(restored).toHaveFocus();
    expect(within(managerNavigation).getByRole('button', { name: /gallery/i }))
      .toHaveAttribute('aria-pressed', 'true');
  });

  it('focuses and re-escalates a dismissed non-retryable Album save recovery on exit', async () => {
    const base = managerFetch({ first: { media: [], nextCursor: null } });
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/album/share') && method === 'GET') return json({ share: null });
      if (url.endsWith('/album') && method === 'GET') return json({ album: {
        revision: 0,
        saved: true,
        title: 'Album',
        description: '',
        coverMediaId: null,
        effectiveCoverMediaId: null,
        entries: [],
        photoCount: 0,
        sectionCount: 0,
        totalBytes: 0,
      } });
      if (url.endsWith('/album') && method === 'PUT') return errorJson({
        code: 'SESSION_EXPIRED',
        message: 'This management session has expired.',
        requestId: 'request-save-expired',
      }, 401);
      return base(input);
    }));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    const user = userEvent.setup();
    const managerNavigation = await screen.findByRole('navigation', { name: 'Manager sections' });
    await user.click(within(managerNavigation).getByRole('button', { name: /gallery/i }));
    await user.click(within(await screen.findByRole('group', { name: 'Gallery mode' }))
      .getByRole('button', { name: /^Album/ }));
    fireEvent.change(await screen.findByLabelText('Album title'), { target: { value: 'Cannot save' } });
    await user.click(screen.getByRole('button', { name: 'Preview album' }));

    const notice = await screen.findByLabelText('Manager notice');
    expect(notice).toHaveTextContent('This management session has expired.');
    expect(notice).toHaveFocus();
    await user.click(within(notice).getByRole('button', { name: 'Dismiss error' }));
    expect(screen.queryByLabelText('Manager notice')).not.toBeInTheDocument();

    await user.click(within(managerNavigation).getByRole('button', { name: /intake/i }));
    const restored = await screen.findByLabelText('Manager notice');
    expect(restored).toHaveTextContent('This management session has expired.');
    expect(restored).toHaveFocus();
  });
});

describe('Manager Intake empty states', () => {
  class SuccessfulEmptyStateUploadRequest {
    status = 204;
    responseText = '';
    withCredentials = false;
    readonly upload = new EventTarget();
    private readonly events = new EventTarget();

    open() {}
    setRequestHeader() {}
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      this.events.addEventListener(type, listener);
    }
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      this.events.removeEventListener(type, listener);
    }
    send() {
      queueMicrotask(() => this.events.dispatchEvent(new Event('load')));
    }
    abort() {
      this.events.dispatchEvent(new Event('abort'));
    }
  }

  it('Intake true empty keeps the printable QR and opens the existing Share surface', async () => {
    vi.stubGlobal('fetch', managerFetch({ first: { media: [], nextCursor: null } }));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    const user = userEvent.setup();

    const emptyHeading = await screen.findByRole('heading', { name: 'No photos yet' });
    const emptyState = emptyHeading.closest('.empty-state') as HTMLElement;
    expect(within(emptyState).getByText("Guests' photos arrive privately here.")).toBeVisible();
    expect(await screen.findAllByRole('img', { name: 'Event QR code' })).toHaveLength(1);

    const share = within(emptyState).getByRole('button', { name: 'Share event' });
    const addPhotos = within(emptyState).getByRole('button', { name: 'Add photos' });
    expect(share).toHaveClass('button--primary');
    expect(addPhotos).toHaveClass('button--secondary');

    await user.click(screen.getByRole('button', { name: 'Recently deleted' }));
    expect(await screen.findByRole('heading', { name: 'Nothing in Recently deleted.' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'No photos yet' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Live intake' }));
    const restoredEmpty = (await screen.findByRole('heading', { name: 'No photos yet' }))
      .closest('.empty-state') as HTMLElement;
    await user.click(within(restoredEmpty).getByRole('button', { name: 'Share event' }));
    expect(await screen.findByRole('heading', { name: 'Share your event' })).toBeVisible();
    expect(screen.getAllByRole('img', { name: 'Event QR code' })).toHaveLength(2);
  });

  it('Intake true empty returns Add photos focus to the actual toolbar or secondary invoker', async () => {
    vi.stubGlobal('fetch', managerFetch({ first: { media: [], nextCursor: null } }));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    const user = userEvent.setup();

    const emptyState = (await screen.findByRole('heading', { name: 'No photos yet' }))
      .closest('.empty-state') as HTMLElement;
    const secondaryInvoker = within(emptyState).getByRole('button', { name: 'Add photos' });
    await user.click(secondaryInvoker);
    await user.click(within(screen.getByRole('dialog', { name: 'Add photos' }))
      .getByRole('button', { name: 'Close Add photos' }));
    await waitFor(() => expect(secondaryInvoker).toHaveFocus());

    const toolbar = document.querySelector('.intake-upload-action') as HTMLElement;
    const toolbarInvoker = within(toolbar).getByRole('button', { name: 'Add photos' });
    await user.click(toolbarInvoker);
    await user.click(within(screen.getByRole('dialog', { name: 'Add photos' }))
      .getByRole('button', { name: 'Close Add photos' }));
    await waitFor(() => expect(toolbarInvoker).toHaveFocus());
  });

  it.each([
    ['with upload availability remaining', false],
    ['after filling the last slot', true],
  ] as const)('Intake true empty returns receipt focus to the connected toolbar %s', async (
    _label,
    fillsLastSlot,
  ) => {
    vi.stubGlobal('XMLHttpRequest', SuccessfulEmptyStateUploadRequest);
    const initialEvent: EventView = {
      ...MANAGED_EVENT,
      storedMediaCount: fillsLastSlot ? MAX_EVENT_MEDIA - 1 : 0,
      hostUploadAvailability: { enabled: true, reason: null },
    };
    const refreshedEvent: EventView = {
      ...initialEvent,
      storedMediaCount: initialEvent.storedMediaCount + 1,
      hostUploadAvailability: fillsLastSlot
        ? { enabled: false, reason: 'media-cap' }
        : { enabled: true, reason: null },
    };
    const uploaded: MediaView = {
      id: 'media-first-host', originalFilename: 'first-host.jpg', guestName: 'Host',
      caption: '', publicationStatus: 'unpublished', uploadState: 'stored',
    };
    const base = managerFetch({ first: { media: [], nextCursor: null } });
    let eventReads = 0;
    let mediaReads = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.pathname === '/api/manage/events/event-a' && method === 'GET') {
        const event = eventReads === 0 ? initialEvent : refreshedEvent;
        eventReads += 1;
        return json({ event });
      }
      if (url.pathname === '/api/manage/events/event-a/media' && method === 'GET') {
        const media = mediaReads === 0 ? [] : [uploaded];
        mediaReads += 1;
        return json({ media, nextCursor: null });
      }
      if (url.pathname === '/api/manage/events/event-a/uploads/batch' && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as {
          files: Array<{ idempotencyKey: string; mimeType: string }>;
        };
        return json({ items: body.files.map((file) => ({
          idempotencyKey: file.idempotencyKey,
          status: 'accepted',
          media: { id: uploaded.id, mimeType: file.mimeType, uploadState: 'reserved' },
          uploadUrl: `/api/manage/events/event-a/uploads/${uploaded.id}/content`,
        })) }, 201);
      }
      if (
        url.pathname === `/api/manage/events/event-a/uploads/${uploaded.id}/finalize`
        && method === 'POST'
      ) return json({ media: uploaded });
      return base(input);
    }));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    const user = userEvent.setup();

    const emptyState = (await screen.findByRole('heading', { name: 'No photos yet' }))
      .closest('.empty-state') as HTMLElement;
    const emptyInvoker = within(emptyState).getByRole('button', { name: 'Add photos' });
    const toolbar = document.querySelector('.intake-upload-action') as HTMLElement;
    const toolbarInvoker = within(toolbar).getByRole('button', { name: 'Add photos' });
    await user.click(emptyInvoker);
    const dialog = screen.getByRole('dialog', { name: 'Add photos' });
    fireEvent.change(within(dialog).getByLabelText('Choose recent photos from your library'), {
      target: { files: [new File(['photo'], 'first-host.jpg', { type: 'image/jpeg' })] },
    });
    await user.click(await within(dialog).findByRole('button', { name: 'Send 1 photo' }));
    expect(await within(dialog).findByRole('heading', { name: '1 photo was added.' })).toBeVisible();

    await waitFor(() => expect(emptyInvoker).not.toBeInTheDocument());
    expect(toolbarInvoker).toBeInTheDocument();
    if (fillsLastSlot) {
      await waitFor(() => expect(toolbarInvoker).toHaveAttribute('aria-disabled', 'true'));
      expect(toolbarInvoker).toHaveAccessibleDescription('This event has reached its photo limit.');
    } else {
      expect(toolbarInvoker).not.toHaveAttribute('aria-disabled', 'true');
    }

    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(toolbarInvoker).toHaveFocus());
  });

  it('Intake true empty keeps finalized receipt focus on the toolbar while Intake refresh is pending', async () => {
    vi.stubGlobal('XMLHttpRequest', SuccessfulEmptyStateUploadRequest);
    const initialEvent: EventView = {
      ...MANAGED_EVENT,
      storedMediaCount: MAX_EVENT_MEDIA - 1,
      hostUploadAvailability: { enabled: true, reason: null },
    };
    const refreshedEvent: EventView = {
      ...initialEvent,
      storedMediaCount: MAX_EVENT_MEDIA,
      hostUploadAvailability: { enabled: false, reason: 'media-cap' },
    };
    const uploaded: MediaView = {
      id: 'media-held-host', originalFilename: 'held-host.jpg', guestName: 'Host',
      caption: '', publicationStatus: 'unpublished', uploadState: 'stored',
    };
    let releaseIntakeRefresh = () => {};
    const intakeRefreshGate = new Promise<void>((resolve) => {
      let released = false;
      releaseIntakeRefresh = () => {
        if (released) return;
        released = true;
        resolve();
      };
    });
    onTestFinished(releaseIntakeRefresh);
    const base = managerFetch({ first: { media: [], nextCursor: null } });
    let eventReads = 0;
    let mediaReads = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.pathname === '/api/manage/events/event-a' && method === 'GET') {
        const event = eventReads === 0 ? initialEvent : refreshedEvent;
        eventReads += 1;
        return json({ event });
      }
      if (url.pathname === '/api/manage/events/event-a/media' && method === 'GET') {
        mediaReads += 1;
        if (mediaReads === 1) return json({ media: [], nextCursor: null });
        return intakeRefreshGate.then(() => json({ media: [uploaded], nextCursor: null }));
      }
      if (url.pathname === '/api/manage/events/event-a/uploads/batch' && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as {
          files: Array<{ idempotencyKey: string; mimeType: string }>;
        };
        return json({ items: body.files.map((file) => ({
          idempotencyKey: file.idempotencyKey,
          status: 'accepted',
          media: { id: uploaded.id, mimeType: file.mimeType, uploadState: 'reserved' },
          uploadUrl: `/api/manage/events/event-a/uploads/${uploaded.id}/content`,
        })) }, 201);
      }
      if (
        url.pathname === `/api/manage/events/event-a/uploads/${uploaded.id}/finalize`
        && method === 'POST'
      ) return json({ media: uploaded });
      return base(input);
    }));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    const user = userEvent.setup();

    const emptyState = (await screen.findByRole('heading', { name: 'No photos yet' }))
      .closest('.empty-state') as HTMLElement;
    const emptyInvoker = within(emptyState).getByRole('button', { name: 'Add photos' });
    const toolbar = document.querySelector('.intake-upload-action') as HTMLElement;
    const toolbarInvoker = within(toolbar).getByRole('button', { name: 'Add photos' });
    await user.click(emptyInvoker);
    const dialog = screen.getByRole('dialog', { name: 'Add photos' });
    fireEvent.change(within(dialog).getByLabelText('Choose recent photos from your library'), {
      target: { files: [new File(['photo'], 'held-host.jpg', { type: 'image/jpeg' })] },
    });
    await user.click(await within(dialog).findByRole('button', { name: 'Send 1 photo' }));
    expect(await within(dialog).findByRole('heading', { name: '1 photo was added.' })).toBeVisible();

    await waitFor(() => expect(mediaReads).toBe(2));
    expect(emptyInvoker).toBeInTheDocument();
    await waitFor(() => expect(toolbarInvoker).toHaveAttribute('aria-disabled', 'true'));
    expect(toolbarInvoker).toHaveAccessibleDescription('This event has reached its photo limit.');

    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    try {
      expect(toolbarInvoker).toHaveFocus();
    } finally {
      await act(async () => {
        releaseIntakeRefresh();
        await intakeRefreshGate;
      });
    }
    await waitFor(() => expect(emptyInvoker).not.toBeInTheDocument());
    expect(toolbarInvoker).toHaveFocus();
  });

  it('Intake true empty keeps both unavailable Add photos invokers focusable with one resolved reason', async () => {
    const unavailable: EventView = {
      ...MANAGED_EVENT,
      hostUploadAvailability: { enabled: false, reason: 'storage-cap' },
    };
    const base = managerFetch({ first: { media: [], nextCursor: null } });
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => (
      String(input).endsWith('/api/manage/events/event-a')
        ? json({ event: unavailable })
        : base(input)
    )));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    const user = userEvent.setup();

    await screen.findByRole('heading', { name: 'No photos yet' });
    const invokers = screen.getAllByRole('button', { name: 'Add photos' });
    expect(invokers).toHaveLength(2);
    for (const invoker of invokers) {
      invoker.focus();
      expect(invoker).toHaveFocus();
      expect(invoker).toHaveAttribute('aria-disabled', 'true');
      expect(invoker).toHaveAccessibleDescription('This event has reached its storage limit.');
      await user.click(invoker);
      expect(screen.queryByRole('dialog', { name: 'Add photos' })).not.toBeInTheDocument();
    }
  });

  it('Intake filtered empty clears the contributor filter and reloads an unfiltered first page', async () => {
    const row: MediaView = {
      id: 'media-a', originalFilename: 'toast.jpg', guestName: 'Avery',
      caption: 'The toast', publicationStatus: 'unpublished', uploadState: 'stored',
    };
    const mediaRequests: string[] = [];
    const base = managerFetch({ first: { media: [row], nextCursor: null } });
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === '/api/manage/events/event-a/media') {
        mediaRequests.push(`${url.pathname}${url.search}`);
        return json({
          media: url.searchParams.has('guestName') ? [] : [row],
          nextCursor: null,
        });
      }
      return base(input);
    }));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    const user = userEvent.setup();

    expect(await screen.findByText('The toast')).toBeVisible();
    await user.type(screen.getByLabelText('Filter by guest name'), 'Nobody');
    await user.click(screen.getByRole('button', { name: 'Filter' }));

    const emptyState = (await screen.findByRole('heading', { name: 'No matching photos' }))
      .closest('.empty-state') as HTMLElement;
    expect(within(emptyState).queryByRole('button', { name: 'Share event' })).not.toBeInTheDocument();
    await user.click(within(emptyState).getByRole('button', { name: 'Clear filters' }));

    expect(await screen.findByText('The toast')).toBeVisible();
    expect(screen.getByLabelText('Filter by guest name')).toHaveValue('');
    expect(mediaRequests).toEqual([
      '/api/manage/events/event-a/media',
      '/api/manage/events/event-a/media?guestName=Nobody',
      '/api/manage/events/event-a/media',
    ]);
  });
});

describe('Manager Add photos integration', () => {
  function toolbarAddPhotos(): HTMLButtonElement {
    const toolbar = document.querySelector('.intake-upload-action') as HTMLElement;
    return within(toolbar).getByRole('button', { name: 'Add photos' });
  }

  class SuccessfulManagerUploadRequest {
    status = 204;
    responseText = '';
    withCredentials = false;
    readonly upload = new EventTarget();
    private readonly events = new EventTarget();

    open() {}
    setRequestHeader() {}
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      this.events.addEventListener(type, listener);
    }
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      this.events.removeEventListener(type, listener);
    }
    send() {
      queueMicrotask(() => this.events.dispatchEvent(new Event('load')));
    }
    abort() {
      this.events.dispatchEvent(new Event('abort'));
    }
  }

  it('keeps Add photos usable while guest intake is paused and refreshes the last slot', async () => {
    // Mutations caught: consulting uploadsEnabled, omitting a finalized-item refresh,
    // losing focus when the refreshed event reaches capacity, or leaving export count stale.
    vi.stubGlobal('XMLHttpRequest', SuccessfulManagerUploadRequest);
    const initialEvent: EventView = {
      ...MANAGED_EVENT,
      uploadsEnabled: false,
      storedMediaCount: MAX_EVENT_MEDIA - 1,
      hostUploadAvailability: { enabled: true, reason: null },
    };
    const fullEvent: EventView = {
      ...initialEvent,
      storedMediaCount: MAX_EVENT_MEDIA,
      hostUploadAvailability: { enabled: false, reason: 'media-cap' },
    };
    const prepared = {
      ...exportJobFixture('complete', 'ready'),
      mediaCount: MAX_EVENT_MEDIA - 1,
    };
    const calls: string[] = [];
    let eventReads = 0;
    const base = managerFetch({ first: { media: [], nextCursor: null } });
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push(`${method} ${path}`);
      if (path.endsWith('/api/manage/events/event-a') && method === 'GET') {
        const event = eventReads === 0 ? initialEvent : fullEvent;
        eventReads += 1;
        return json({ event });
      }
      if (path.endsWith('/uploads/batch') && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as {
          files: Array<{ idempotencyKey: string; mimeType: string }>;
        };
        return json({ items: body.files.map((file) => ({
          idempotencyKey: file.idempotencyKey,
          status: 'accepted',
          media: { id: 'media-host-last-slot', mimeType: file.mimeType, uploadState: 'reserved' },
          uploadUrl: '/api/manage/events/event-a/uploads/media-host-last-slot/content',
        })) }, 201);
      }
      if (path.endsWith('/uploads/media-host-last-slot/finalize') && method === 'POST') {
        return json({ media: { id: 'media-host-last-slot', uploadState: 'stored' } });
      }
      if (path.endsWith('/exports')) return json({ exports: [prepared] });
      return base(input);
    });
    vi.stubGlobal('fetch', fetchMock);
    const router = createAppRouter(['/manage/event/event-a']);
    render(<RouterProvider router={router} />);
    const user = userEvent.setup();

    await screen.findByRole('heading', { name: 'Live intake' });
    const trigger = toolbarAddPhotos();
    expect(trigger).not.toHaveAttribute('aria-disabled', 'true');
    await user.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Add photos' });
    expect(within(dialog).getByRole('button', { name: 'Choose recent photos' })).toBeEnabled();
    expect(within(dialog).queryByText(/paused photo delivery/iu)).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Choose recent photos from your library'), {
      target: { files: [new File(['photo'], 'last-slot.jpg', { type: 'image/jpeg' })] },
    });
    await user.click(await within(dialog).findByRole('button', { name: 'Send 1 photo' }));
    expect(await within(dialog).findByRole('heading', { name: '1 photo was added.' })).toBeVisible();
    await waitFor(() => expect(eventReads).toBe(2));
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));

    await waitFor(() => expect(trigger).toHaveAttribute('aria-disabled', 'true'));
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAccessibleDescription('This event has reached its photo limit.');

    await user.click(within(screen.getByRole('navigation', { name: 'Manager sections' }))
      .getByRole('button', { name: /Gallery/ }));
    expect(await screen.findByText('Current collection: 10,000 photos (+1 photo).')).toBeVisible();

    const count = (suffix: string) => calls.filter((call) => call.endsWith(suffix)).length;
    expect(count('/api/manage/events/event-a')).toBe(2);
    expect(count('/guestbook/summary')).toBe(2);
    expect(calls.filter((call) => call.includes('/media') && !call.includes('/uploads/'))).toHaveLength(2);
    expect(count('/gallery/summary')).toBe(1);
    expect(count('/exports')).toBe(1);
    expect(count('/entry')).toBe(1);
  });

  it('keeps an unavailable Add photos action focusable beside its resolved reason', async () => {
    const unavailable: EventView = {
      ...MANAGED_EVENT,
      hostUploadAvailability: { enabled: false, reason: 'storage-cap' },
    };
    const base = managerFetch({ first: { media: [], nextCursor: null } });
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => (
      String(input).endsWith('/api/manage/events/event-a')
        ? json({ event: unavailable })
        : base(input)
    )));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    const user = userEvent.setup();

    await screen.findByRole('heading', { name: 'Live intake' });
    const trigger = toolbarAddPhotos();
    trigger.focus();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-disabled', 'true');
    expect(trigger).toHaveAccessibleDescription('This event has reached its storage limit.');
    await user.click(trigger);
    expect(screen.queryByRole('dialog', { name: 'Add photos' })).not.toBeInTheDocument();
  });

  it.each([
    ['EVENT_EXPIRED', 410, true, 'This event is no longer available for uploads.'],
    ['INTERNAL_ERROR', 503, false, null],
  ] as const)('resolves Add photos after a stale %s event read', async (
    code,
    status,
    disabled,
    description,
  ) => {
    // Mutations caught: reading the stale projection without the shared lifecycle
    // selector, or treating a retryable outage as proof that the event ended.
    const intervals = vi.spyOn(window, 'setInterval');
    const base = managerFetch({ first: { media: [], nextCursor: null } });
    let eventReads = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/api/manage/events/event-a')) {
        eventReads += 1;
        return eventReads === 1
          ? json({ event: MANAGED_EVENT })
          : errorJson({ code, message: code === 'EVENT_EXPIRED'
            ? 'This event has ended.'
            : 'The event could not be refreshed.', requestId: 'stale-read' }, status);
      }
      return base(input);
    }));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Live intake' });
    const trigger = toolbarAddPhotos();
    const intakePoll = intervals.mock.calls.find(([, delay]) => delay === 5_000)?.[0];
    expect(intakePoll).toBeTypeOf('function');

    await act(async () => { (intakePoll as () => void)(); });
    await waitFor(() => expect(eventReads).toBe(2));

    expect(screen.getByRole('heading', { name: 'Live intake' })).toBeVisible();
    if (disabled) {
      expect(await screen.findByRole('alert')).toHaveTextContent('This event has ended.');
      expect(trigger).toHaveAttribute('aria-disabled', 'true');
      expect(trigger).toHaveAccessibleDescription(description);
      await user.click(screen.getByRole('button', { name: 'Dismiss error' }));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(trigger).toHaveAttribute('aria-disabled', 'true');
      expect(trigger).toHaveAccessibleDescription(description);
      await user.click(trigger);
      expect(screen.queryByRole('dialog', { name: 'Add photos' })).not.toBeInTheDocument();
    } else {
      expect(trigger).not.toHaveAttribute('aria-disabled', 'true');
      expect(screen.queryByText('This event is no longer available for uploads.')).not.toBeInTheDocument();
    }
  });

  it('deduplicates Add photos invalidation by finalized media ID without refreshing the shell', async () => {
    // Mutations caught: deduplicating by queue item, refreshing only at receipt,
    // or widening a partial success into audience/export/entry/trash invalidation.
    const calls: string[] = [];
    let eventReads = 0;
    let libraryReads = 0;
    const uploadedLibraryRow = {
      ...historyMedia(['media-b'])[0]!,
      originalFilename: 'host-library-b.jpg',
      caption: 'Host Library B',
      guestName: 'Host',
    };
    const base = managerFetch({ first: { media: [], nextCursor: null } });
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push(`${method} ${path}`);
      if (path.endsWith('/api/manage/events/event-a') && method === 'GET') {
        eventReads += 1;
        return json({ event: { ...MANAGED_EVENT, storedMediaCount: Math.min(5, 2 + eventReads) } });
      }
      if (path.endsWith('/uploads/batch') && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as {
          files: Array<{ idempotencyKey: string; mimeType: string }>;
        };
        const mediaIds = ['media-a', null, 'media-b', 'media-a'] as const;
        return json({ items: body.files.map((file, index) => mediaIds[index] === null
          ? {
              idempotencyKey: file.idempotencyKey,
              status: 'rejected',
              error: { code: 'FILE_TYPE_UNSUPPORTED', message: 'This file was rejected.' },
            }
          : {
              idempotencyKey: file.idempotencyKey,
              status: 'accepted',
              alreadyDelivered: true,
              media: { id: mediaIds[index], mimeType: file.mimeType, uploadState: 'stored' },
            }) }, 201);
      }
      if (path.includes('/gallery?') && method === 'GET') {
        libraryReads += 1;
        return json({
          media: libraryReads === 1 ? [] : [uploadedLibraryRow],
          nextCursor: null,
        });
      }
      return base(input);
    }));
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Live intake' });
    await user.click(toolbarAddPhotos());
    const dialog = screen.getByRole('dialog', { name: 'Add photos' });
    fireEvent.change(within(dialog).getByLabelText('Choose recent photos from your library'), {
      target: { files: ['a.jpg', 'rejected.jpg', 'b.jpg', 'a-again.jpg'].map((name) => (
        new File(['photo'], name, { type: 'image/jpeg' })
      )) },
    });
    await user.click(await within(dialog).findByRole('button', { name: 'Send 4 photos' }));

    const count = (part: string) => calls.filter((call) => call.includes(part)).length;
    await waitFor(() => {
      expect(calls.filter((call) => call.endsWith('/api/manage/events/event-a'))).toHaveLength(3);
      expect(count('/guestbook/summary')).toBe(3);
      expect(calls.filter((call) => call.includes('/media') && !call.includes('/uploads/'))).toHaveLength(3);
    });
    expect(count('/gallery/summary')).toBe(1);
    expect(count('/exports')).toBe(1);
    expect(count('/entry')).toBe(1);
    expect(calls.some((call) => call.includes('/media/trash'))).toBe(false);
    expect(calls.some((call) => call.includes('mode=guest-gallery'))).toBe(false);

    await user.click(within(dialog).getByRole('button', { name: 'Close Add photos' }));
    await user.click(within(screen.getByRole('navigation', { name: 'Manager sections' }))
      .getByRole('button', { name: /Gallery/ }));
    expect(await screen.findByRole('button', { name: 'Open Host Library B, from Host' })).toBeVisible();
    expect(libraryReads).toBe(2);
  });

  it('uses the sole Manager blocker while Add photos owns exit and resumes afterward', async () => {
    let releaseUpload: (() => void) | null = null;
    class ReleasableManagerUploadRequest {
      status = 204;
      responseText = '';
      withCredentials = false;
      readonly upload = new EventTarget();
      readonly events = new EventTarget();
      open() {}
      setRequestHeader() {}
      addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        this.events.addEventListener(type, listener);
      }
      removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        this.events.removeEventListener(type, listener);
      }
      send() {
        releaseUpload = () => this.events.dispatchEvent(new Event('load'));
      }
      abort() {
        this.events.dispatchEvent(new Event('abort'));
      }
    }
    vi.stubGlobal('XMLHttpRequest', ReleasableManagerUploadRequest);
    const base = managerFetch({ first: { media: [], nextCursor: null } });
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (path.endsWith('/uploads/batch') && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as {
          files: Array<{ idempotencyKey: string; mimeType: string }>;
        };
        return json({ items: body.files.map((file) => ({
          idempotencyKey: file.idempotencyKey,
          status: 'accepted',
          media: { id: 'media-held', mimeType: file.mimeType, uploadState: 'reserved' },
          uploadUrl: '/api/manage/events/event-a/uploads/media-held/content',
        })) }, 201);
      }
      if (path.endsWith('/uploads/media-held/finalize') && method === 'POST') {
        return json({ media: { id: 'media-held', uploadState: 'stored' } });
      }
      return base(input);
    }));
    const router = createAppRouter(['/manage/event/event-a']);
    render(<RouterProvider router={router} />);
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Live intake' });
    await user.click(toolbarAddPhotos());
    const dialog = screen.getByRole('dialog', { name: 'Add photos' });
    fireEvent.change(within(dialog).getByLabelText('Choose recent photos from your library'), {
      target: { files: [new File(['photo'], 'held.jpg', { type: 'image/jpeg' })] },
    });
    await user.click(await within(dialog).findByRole('button', { name: 'Send 1 photo' }));
    await waitFor(() => expect(releaseUpload).toBeTypeOf('function'));

    const blockedUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(blockedUnload);
    expect(blockedUnload.defaultPrevented).toBe(true);
    void router.navigate('/privacy');
    await waitFor(() => expect(router.state.location.pathname).toBe('/manage/event/event-a'));

    await act(async () => { releaseUpload?.(); });
    expect(await screen.findByRole('heading', { name: 'Privacy' })).toBeVisible();
    const releasedUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(releasedUnload);
    expect(releasedUnload.defaultPrevented).toBe(false);
  });
});

describe('host account attachment and recovery', () => {
  const REGISTRATION_EXPIRY = '2099-01-01T00:15:00.000Z';
  const RESEND_EXPIRY = '2099-01-01T00:30:00.000Z';

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
      if (path === '/api/host/register') {
        return json({ registrationPending: true, resumeExpiresAt: REGISTRATION_EXPIRY }, 202);
      }
      if (path === '/api/host/register/resend') {
        return json({ registrationPending: true, resumeExpiresAt: RESEND_EXPIRY }, 202);
      }
      if (path === '/api/host/register/complete') {
        return json({ registered: true, boundEvent: overrides.boundEvent ?? true });
      }
      if (path === '/api/host/session') {
        return json({
          account: {
            id: 'account-a',
            email: 'host@example.com',
            displayName: null,
            emailVerified: true,
            notificationsEnabled: true,
          },
          events: [],
        });
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
    const router = createAppRouter(['/create']);
    render(<RouterProvider router={router} />);
    await registerFromCreate(user);

    await waitFor(() => expect(router.state.location.pathname).toBe('/host/register'));
    expect(new URLSearchParams(router.state.location.search).get('pending')).toBe('1');
    const resend = screen.getByRole('button', { name: 'Send another code' });
    await waitFor(() => expect(resend).toBeEnabled());
    await user.click(resend);
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === '/api/host/register/resend')).toBe(true));

    await user.type(screen.getByLabelText('Confirmation code'), '424242');
    await user.click(screen.getByRole('button', { name: 'Confirm my email' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === '/api/host/register/complete')).toBe(true));

    // The host-session verification endpoints belong to the standalone account
    // page; a browser with no account yet has no session to present to them.
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/host/verify'))).toBe(false);
  });

  it('persists the CreatePage registration resend without recovering the raw email', async () => {
    stubHostFlow();
    const router = createAppRouter(['/create']);
    const user = userEvent.setup();
    render(<RouterProvider router={router} />);

    await registerFromCreate(user);
    await waitFor(() => expect(router.state.location.pathname).toBe('/host/register'));
    const started = JSON.parse(localStorage.getItem('candidary.pending-registration.v1')!) as {
      emailDigest: string;
      expiresAt: string;
    };
    expect(started).toEqual(expect.objectContaining({
      emailDigest: '61c0ee79db216f84107d8d2d7bfb35266f66b06773a99a0786e3a173ffe920ee',
      expiresAt: REGISTRATION_EXPIRY,
    }));
    expect(JSON.stringify(Object.fromEntries(
      Array.from({ length: localStorage.length }, (_, index) => {
        const key = localStorage.key(index)!;
        return [key, localStorage.getItem(key)];
      }),
    ))).not.toContain('host@example.com');

    await user.click(screen.getByRole('button', { name: 'Send another code' }));
    await screen.findByText('A new code is on its way.');
    expect(JSON.parse(localStorage.getItem('candidary.pending-registration.v1')!)).toEqual(
      expect.objectContaining({
        emailDigest: started.emailDigest,
        expiresAt: RESEND_EXPIRY,
      }),
    );
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

  describe('registration confirmation', () => {
    const pendingKey = 'candidary.pending-registration.v1';
    const eventId = '11111111-2222-4333-8444-555555555555';

    function pendingRoute(returnTo?: string, adoptEventId = eventId): string {
      const search = new URLSearchParams({ pending: '1' });
      if (returnTo) {
        search.set('returnTo', returnTo);
        search.set('adopt', adoptEventId);
      }
      return `/host/register?${search.toString()}`;
    }

    function seedPendingMarker(): void {
      localStorage.setItem(pendingKey, JSON.stringify({
        version: 1,
        emailDigest: '61c0ee79db216f84107d8d2d7bfb35266f66b06773a99a0786e3a173ffe920ee',
        expiresAt: REGISTRATION_EXPIRY,
      }));
    }

    async function confirmRegistration(
      route: string,
      boundEvent: boolean,
    ): Promise<{
      fetchMock: ReturnType<typeof stubHostFlow>;
      router: ReturnType<typeof createAppRouter>;
    }> {
      seedPendingMarker();
      const fetchMock = stubHostFlow({ boundEvent });
      const router = createAppRouter([route]);
      render(<RouterProvider router={router} />);
      const user = userEvent.setup();

      await user.type(screen.getByLabelText('Confirmation code'), '424242');
      await user.click(screen.getByRole('button', { name: 'Confirm my email' }));

      return { fetchMock, router };
    }

    it.each([
      {
        case: 'resumes the exact canonical destination for a bound event',
        route: pendingRoute(`/manage/event/${eventId}?section=gallery&mode=album`),
        boundEvent: true,
        expectedPathname: `/manage/event/${eventId}`,
        expectedSearch: '?section=gallery&mode=album',
      },
      {
        case: 'falls back from a noncanonical return to Host Events',
        route: pendingRoute(`/manage/event/${eventId}?section=gallery&mode=album&extra=1`),
        boundEvent: true,
        expectedPathname: '/host/events',
        expectedSearch: '',
      },
      {
        case: 'falls back from a mismatched adoption to Host Events',
        route: pendingRoute(
          `/manage/event/${eventId}?section=gallery&mode=album`,
          '99999999-2222-4333-8444-555555555555',
        ),
        boundEvent: true,
        expectedPathname: '/host/events',
        expectedSearch: '',
      },
      {
        case: 'sends a standalone pending registration to Host Events',
        route: pendingRoute(),
        boundEvent: false,
        expectedPathname: '/host/events',
        expectedSearch: '',
      },
    ])('$case after registration confirmation', async ({
      route,
      boundEvent,
      expectedPathname,
      expectedSearch,
    }) => {
      const { fetchMock, router } = await confirmRegistration(route, boundEvent);

      await waitFor(() => expect(router.state.location.pathname).toBe(expectedPathname));
      expect(router.state.location.search).toBe(expectedSearch);
      expect(localStorage.getItem(pendingKey)).toBeNull();
      expect(fetchMock.mock.calls.filter(([url]) => url === '/api/host/register/complete'))
        .toHaveLength(1);
    });

    it('keeps a truthful failed-bind result with one Host Events continuation after registration confirmation', async () => {
      const returnTo = `/manage/event/${eventId}?section=gallery&mode=album`;
      const { fetchMock, router } = await confirmRegistration(pendingRoute(returnTo), false);

      expect(await screen.findByRole('heading', { name: 'Your email is confirmed.' })).toBeVisible();
      expect(screen.getByText(/account is ready, but this event still depends on its management link/i))
        .toBeVisible();
      expect(screen.queryByText(/this event will be added to your account/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/then you can get back without the management link/i)).not.toBeInTheDocument();
      const continueToEvents = screen.getByRole('link', { name: 'Continue to Host Events' });
      expect(localStorage.getItem(pendingKey)).toBeNull();
      expect(new URLSearchParams(router.state.location.search).has('pending')).toBe(false);
      expect(screen.queryByLabelText('Confirmation code')).not.toBeInTheDocument();
      expect(fetchMock.mock.calls.filter(([url]) => url === '/api/host/register/complete'))
        .toHaveLength(1);

      await userEvent.setup().click(continueToEvents);
      await waitFor(() => expect(router.state.location.pathname).toBe('/host/events'));
      expect(fetchMock.mock.calls.filter(([url]) => url === '/api/host/register/complete'))
        .toHaveLength(1);
    });
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

  it('keeps the return note for a query-bearing Manager destination when the management link it arrived with has already expired', async () => {
    const eventId = '11111111-2222-4333-8444-555555555555';
    // The dead-end path: the cookie that authorizes the lookup is the thing that
    // expired. The note loses the name and keeps the promise rather than erroring.
    vi.stubGlobal('fetch', vi.fn(() => errorJson(
      { code: 'SESSION_EXPIRED', message: 'That link has expired.', requestId: 'r' }, 401,
    )));
    render(<RouterProvider router={createAppRouter([
      `/host/login?returnTo=%2Fmanage%2Fevent%2F${eventId}%3Fsection%3Dgallery%26mode%3Dalbum&adopt=${eventId}`,
    ])} />);

    expect(await screen.findByText('You will come back here, and this event will be added to your account.'))
      .toBeVisible();
    expect(fetch).toHaveBeenCalledWith(`/api/manage/events/${eventId}`, expect.anything());
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
      if (String(url) === '/api/host/register') {
        return json({
          registrationPending: true,
          resumeExpiresAt: '2099-01-01T00:15:00.000Z',
        }, 202);
      }
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
    guestbookPrompt: DEFAULT_GUESTBOOK_PROMPT,
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
    guestReadSurfaces: { available: true, reason: null },
    theme: resolveEventTheme({ version: 1, presetId: 'candidary-default', overrides: {} }),
  };

  function renderEvent(event = guestEvent) {
    return render(<MemoryRouter initialEntries={[`/event/${event.slug}`]}>
      <Routes><Route path="/event/:slug" element={<EventPage />} /></Routes>
    </MemoryRouter>);
  }

  it('puts RSVP first for the rsvp-primary phase without mounting photo controls', async () => {
    class TestResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element) {
        this.callback([{
          target,
          contentRect: { width: 360 } as DOMRectReadOnly,
        } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      disconnect() {}
      unobserve() {}
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    window.innerWidth = 360;
    window.innerHeight = 600;
    const lookupEvent = {
      ...guestEvent,
      uploadsEnabled: false,
      phase: 'rsvp-primary' as const,
      guestReadSurfaces: { available: false, reason: 'before-photo-open' } as const,
      cover: { ...guestEvent.cover, revision: 7, hasCover: true },
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/api/event/maya-theo')) return json({ event: lookupEvent, role: 'guest' });
      if (path.endsWith('/rsvp/household')) return errorJson({ code: 'RSVP_SESSION_REQUIRED', message: 'Find your invitation.', requestId: 'r' }, 401);
      throw new Error(`Unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { container } = renderEvent(lookupEvent);
    await screen.findByRole('button', { name: 'Find my invitation' });
    await waitFor(() => expect(container.querySelector('.responsive-cover'))
      .toHaveAttribute('data-cover-profile', 'short-lookup'));
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

  it('installs a cover-only ticketed refresh after final guest delivery failure', async () => {
    class TestResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element) {
        this.callback([{
          target,
          contentRect: { width: 390 } as DOMRectReadOnly,
        } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      disconnect() {}
      unobserve() {}
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    window.innerWidth = 390;
    window.innerHeight = 844;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const initial = {
      ...guestEvent,
      cover: { ...guestEvent.cover, revision: 41, hasCover: true },
    };
    const refreshed = {
      ...initial,
      cover: { ...initial.cover, revision: 42 },
    };
    let eventReads = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/api/event/maya-theo')) {
        eventReads += 1;
        return json({ event: eventReads === 1 ? initial : refreshed, role: 'guest' });
      }
      throw new Error(`Unexpected request ${path}`);
    }));

    const { container } = renderEvent(initial);
    await waitFor(() => expect(container.querySelector('.responsive-cover__image')).not.toBeNull());
    const first = container.querySelector<HTMLImageElement>('.responsive-cover__image')!;
    expect(first.getAttribute('src')).toContain('/41/compact-default/');

    fireEvent.error(first);
    fireEvent.error(container.querySelector<HTMLImageElement>('.responsive-cover__image')!);

    await waitFor(() => expect(
      container.querySelector<HTMLImageElement>('.responsive-cover__image')?.getAttribute('src'),
    ).toContain('/42/compact-default/'));
    expect(eventReads).toBe(2);
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
      guestReadSurfaces: { available: false, reason: 'before-photo-open' } as const,
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
      guestReadSurfaces: { available: false, reason: 'before-photo-open' } as const,
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

  it('names only new guest uploads as paused once the event has started', async () => {
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
    expect(await screen.findByRole('heading', { level: 1, name: 'New guest uploads are paused' })).toBeVisible();
    expect(screen.getByText(/The host has paused new guest uploads for now/)).toBeVisible();
    // The hero still names the event, so a guest who rechecked across the start
    // lands on the same product rather than on a different page.
    expect(screen.getByText(/Maya & Theo/, { selector: '.photo-drop__event' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Take a photo' })).not.toBeInTheDocument();
    // RSVP has left the guest experience entirely, so none of it mounts or asks.
    expect(screen.queryByRole('heading', { name: 'Your RSVP' })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([input]) => String(input)).filter((path) => path.includes('/rsvp/'))).toEqual([]);
  });

  it('retains a terminal receipt across a paused refetch and keeps read surfaces available', async () => {
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
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: true,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    let projectedEvent = guestEvent;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith('/api/event/maya-theo')) return json({ event: projectedEvent, role: 'guest' });
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
      if (path.endsWith('/gallery')) return json({
        media: [{
          id: 'shared-after-pause', guestName: 'Avery', caption: 'Still shared', previewAvailable: true,
        }],
      });
      if (path.endsWith('/messages?contract=2')) {
        return errorJson({ code: 'INTERNAL_ERROR', message: 'The book is resting. Try again.', requestId: 'guestbook-r' }, 503);
      }
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
    expect(screen.getByText('More from the event')).toBeInTheDocument();
    expect(screen.getByText('Shared gallery')).toBeVisible();
    expect(screen.getByText('My deliveries')).toBeVisible();
    expect(screen.getAllByRole('button', { name: 'Leave a guestbook note' })).toHaveLength(1);

    projectedEvent = {
      ...guestEvent,
      uploadsEnabled: false,
      galleryVisible: true,
      phase: 'waiting',
      rsvpState: 'closed',
      rsvpAccess: 'unavailable',
    };
    window.dispatchEvent(new Event('focus'));

    await screen.findByText('Available');
    expect(screen.getByRole('heading', { name: 'Your 1 photo was sent.' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'New guest uploads are paused' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Take a photo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Choose recent photos' })).not.toBeInTheDocument();
    expect(screen.getByText('My deliveries')).toBeVisible();
    expect(screen.getAllByRole('button', { name: 'Leave a guestbook note' })).toHaveLength(1);

    await user.click(screen.getByText(/Shared gallery/, { selector: 'span' }));
    expect(await screen.findByAltText('Still shared')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Leave a guestbook note' }));

    const heading = await screen.findByRole('heading', { name: 'Leave a note for Maya & Theo' });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' });
    expect(await screen.findByRole('alert')).toHaveTextContent('The book is resting. Try again.');
    expect(screen.getByRole('textbox', { name: 'Your note for Maya & Theo' })).toBeEnabled();
  });
});

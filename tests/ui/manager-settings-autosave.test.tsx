import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(() => Promise.resolve('data:image/png;base64,x')) } }));

import { resolveEventTheme } from '../../shared/event-theme';
import { DEFAULT_GUESTBOOK_PROMPT } from '../../shared/constants';
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
  welcomeMessage: 'Welcome.', guestbookPrompt: DEFAULT_GUESTBOOK_PROMPT,
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

interface MediaPage { media: unknown[]; nextCursor: string | null }

function managerFetch(pages: Record<string, MediaPage>, event: Record<string, unknown> = MANAGED_EVENT) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/api/manage/events/event-a')) return json({ event });
    if (url.includes('/media')) {
      const cursor = new URL(url, 'https://candidary.test').searchParams.get('cursor') ?? 'first';
      return json(pages[cursor] ?? { media: [], nextCursor: null });
    }
    if (url.includes('/gallery')) return json({ media: [], nextCursor: null });
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
  it('reconciles schedule-derived photo intake through one fresh read without carrying settings fields', async () => {
    const scheduled = {
      ...MANAGED_EVENT,
      photosOpen: false,
      photoIntakeState: 'scheduled' as const,
      photoIntakeRecheckAfterMs: 60_000,
    };
    const settingsResponse = {
      ...scheduled,
      name: 'Confirmed schedule',
      eventStartAt: '2026-09-19T23:00:00.000Z',
      eventStartTime: '18:00',
    };
    const refreshed = {
      ...settingsResponse,
      // A whole read is permitted to carry every field, but this reconciliation
      // owns intake only; a later settings value must stay put.
      name: 'Stale read name',
      photosOpen: true,
      photoIntakeState: 'open' as const,
      photoIntakeRecheckAfterMs: null,
    };
    const fallback = managerFetch({ first: { media: [], nextCursor: null } });
    let eventReads = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/api/manage/events/event-a') && method === 'GET') {
        eventReads += 1;
        return json({ event: eventReads === 1 ? scheduled : refreshed });
      }
      if (url.endsWith('/settings') && method === 'PATCH') return json({ event: settingsResponse });
      return fallback(input);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = typist();
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await openSettings(user);

    expect(screen.getByText('Photo delivery opens when the event starts.')).toBeVisible();
    fireEvent.change(screen.getByLabelText('Event start time'), { target: { value: '18:00' } });

    await waitFor(() => expect(eventReads).toBe(2));
    expect(screen.getByRole('heading', { name: 'Confirmed schedule' })).toBeVisible();
    expect(screen.getByText('Photo delivery is open.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Pause photo delivery' })).toBeVisible();
  });

  it('keeps the working manager surface when schedule reconciliation cannot read', async () => {
    const scheduled = {
      ...MANAGED_EVENT,
      photosOpen: false,
      photoIntakeState: 'scheduled' as const,
      photoIntakeRecheckAfterMs: 60_000,
    };
    const fallback = managerFetch({ first: { media: [], nextCursor: null } });
    let eventReads = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/api/manage/events/event-a') && method === 'GET') {
        eventReads += 1;
        return eventReads === 1
          ? json({ event: scheduled })
          : errorJson({ code: 'INTERNAL_ERROR', message: 'Quiet read failed.', requestId: 'request-a' }, 500);
      }
      if (url.endsWith('/settings') && method === 'PATCH') {
        return json({ event: { ...scheduled, eventStartTime: '18:00' } });
      }
      return fallback(input);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = typist();
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await openSettings(user);

    fireEvent.change(screen.getByLabelText('Event start time'), { target: { value: '18:00' } });

    await waitFor(() => expect(eventReads).toBe(2));
    expect(screen.getByText('Event settings saved')).toBeInTheDocument();
    expect(screen.getByText('Photo delivery opens when the event starts.')).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps an explicit photo action newer than a delayed schedule save and its reconciliation', async () => {
    const scheduled = {
      ...MANAGED_EVENT,
      photosOpen: false,
      photoIntakeState: 'scheduled' as const,
      photoIntakeRecheckAfterMs: 60_000,
    };
    const openEarly = {
      ...scheduled,
      photosOpen: true,
      photoIntakeState: 'open-early' as const,
      photoIntakeRecheckAfterMs: 45_000,
    };
    const fallback = managerFetch({ first: { media: [], nextCursor: null } });
    let eventReads = 0;
    let releaseSettings: (() => void) | null = null;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/api/manage/events/event-a') && method === 'GET') {
        eventReads += 1;
        return json({ event: eventReads === 1 ? scheduled : openEarly });
      }
      if (url.endsWith('/settings') && method === 'PATCH') {
        return new Promise<Response>((resolve) => {
          releaseSettings = () => resolve(new Response(JSON.stringify({
            data: { event: { ...scheduled, eventStartTime: '18:00' } },
            requestId: 'request-a',
          }), { status: 200, headers: { 'content-type': 'application/json' } }));
        });
      }
      if (url.endsWith('/photo-intake') && method === 'POST') return json({ event: openEarly });
      return fallback(input);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = typist();
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await openSettings(user);

    fireEvent.change(screen.getByLabelText('Event start time'), { target: { value: '18:00' } });
    await waitFor(() => expect(releaseSettings).not.toBeNull());
    await user.click(screen.getByRole('button', { name: 'Open photo delivery now' }));
    await screen.findByText('Photo delivery is open early.');

    releaseSettings!();

    await waitFor(() => expect(eventReads).toBe(2));
    expect(screen.getByText('Photo delivery is open early.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Pause until the event starts' })).toBeVisible();
  });

  it('keeps schedule reconciliation newer when an older photo action response arrives last', async () => {
    const scheduled = {
      ...MANAGED_EVENT,
      photosOpen: false,
      photoIntakeState: 'scheduled' as const,
      photoIntakeRecheckAfterMs: 60_000,
    };
    const openEarly = {
      ...scheduled,
      photosOpen: true,
      photoIntakeState: 'open-early' as const,
      photoIntakeRecheckAfterMs: 45_000,
    };
    const openAfterSchedule = {
      ...openEarly,
      name: 'Schedule after action',
      eventStartAt: '2026-09-19T21:00:00.000Z',
      eventStartTime: '16:00',
      photoIntakeState: 'open' as const,
      photoIntakeRecheckAfterMs: null,
    };
    const fallback = managerFetch({ first: { media: [], nextCursor: null } });
    let eventReads = 0;
    let releasePhoto: (() => void) | null = null;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/api/manage/events/event-a') && method === 'GET') {
        eventReads += 1;
        return json({ event: eventReads === 1 ? scheduled : openAfterSchedule });
      }
      if (url.endsWith('/photo-intake') && method === 'POST') {
        // The action has committed on the server, but its older response is
        // deliberately held past the later schedule write.
        return new Promise<Response>((resolve) => {
          releasePhoto = () => resolve(new Response(JSON.stringify({
            data: { event: openEarly }, requestId: 'request-a',
          }), { status: 200, headers: { 'content-type': 'application/json' } }));
        });
      }
      if (url.endsWith('/settings') && method === 'PATCH') {
        return json({ event: openAfterSchedule });
      }
      return fallback(input);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = typist();
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await openSettings(user);

    await user.click(screen.getByRole('button', { name: 'Open photo delivery now' }));
    await waitFor(() => expect(releasePhoto).not.toBeNull());
    fireEvent.change(screen.getByLabelText('Event start time'), { target: { value: '16:00' } });
    await screen.findByRole('heading', { name: 'Schedule after action' });
    await Promise.resolve();
    await Promise.resolve();
    const readStartedBeforePhotoSettled = eventReads > 1;

    releasePhoto!();

    await waitFor(() => expect(eventReads).toBe(2));
    await waitFor(() => expect(screen.getByText('Photo delivery is open.')).toBeVisible());
    expect(readStartedBeforePhotoSettled).toBe(false);
    expect(screen.queryByText('Photo delivery is open early.')).not.toBeInTheDocument();
  });

  it('keeps a guest draft through a combined internal-destination prompt until the host discards it', async () => {
    vi.stubGlobal('fetch', managerFetch({ first: { media: [], nextCursor: null } }));
    const user = typist();
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await screen.findByRole('heading', { name: 'Live intake' });

    const nav = within(screen.getByRole('navigation', { name: 'Manager sections' }));
    await user.click(nav.getByRole('button', { name: 'RSVP' }));
    await user.click(await screen.findByRole('button', { name: 'Add guests' }));
    await user.type(screen.getByLabelText('Guest names or spreadsheet data'), 'Taylor Morgan');
    await user.click(nav.getByRole('button', { name: 'Gallery' }));

    const prompt = await screen.findByRole('region', { name: 'Your pending work is not saved' });
    expect(prompt).toHaveFocus();
    await user.click(within(prompt).getByRole('button', { name: 'Stay' }));
    expect(screen.getByRole('heading', { name: 'Add guests' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Gallery' })).not.toBeInTheDocument();

    await user.click(nav.getByRole('button', { name: 'Gallery' }));
    await user.click(within(await screen.findByRole('region', { name: 'Your pending work is not saved' }))
      .getByRole('button', { name: 'Discard draft' }));
    expect(await screen.findByRole('heading', { name: 'Gallery' })).toBeVisible();
    await user.click(await screen.findByRole('button', { name: 'Shared' }));
    expect(within(screen.getByRole('group', { name: 'Publication status' }))
      .getByRole('button', { name: 'Unpublished' })).toHaveClass('active');
  });

  it('keeps manager destinations unavailable while a guest-list commit is in flight', async () => {
    let resolveCommit: ((response: Response) => void) | null = null;
    const fallback = managerFetch({ first: { media: [], nextCursor: null } });
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/rsvp/roster/preview')) {
        const body = JSON.parse(String(init?.body));
        return json({
          canonicalBatch: body.batch,
          rosterVersion: 7,
          targetVersions: [],
          totals: { householdsCreated: 1, householdsUpdated: 0, namedInviteesAdded: 1, plusOneCapacityAdded: 0, invitedCapacityAdded: 1, resultingHouseholds: 1, resultingInvitedCapacity: 1 },
          issues: [],
          previewDigest: 'pending-commit-preview',
          canCommit: true,
        });
      }
      if (url.endsWith('/rsvp/roster/commit')) {
        return new Promise<Response>((resolve) => { resolveCommit = resolve; });
      }
      return fallback(input);
    }));

    const user = typist();
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await screen.findByRole('heading', { name: 'Live intake' });
    const nav = within(screen.getByRole('navigation', { name: 'Manager sections' }));
    await user.click(nav.getByRole('button', { name: 'RSVP' }));
    await user.click(await screen.findByRole('button', { name: 'Add guests' }));
    await user.type(screen.getByLabelText('Guest names or spreadsheet data'), 'Taylor Morgan');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Continue to details' }));
    await user.click(screen.getByRole('button', { name: 'Review guests' }));
    await user.click(await screen.findByRole('button', { name: 'Add 1 guest across 1 household' }));
    await waitFor(() => expect(resolveCommit).not.toBeNull());

    expect(nav.getByRole('button', { name: 'Gallery' })).toBeDisabled();
    expect(screen.queryByRole('region', { name: 'Your pending work is not saved' })).not.toBeInTheDocument();

    resolveCommit!(await json({
      createdHouseholds: [],
      updatedHouseholds: [],
      totals: { householdsCreated: 1, householdsUpdated: 0, namedInviteesAdded: 1, plusOneCapacityAdded: 0, invitedCapacityAdded: 1, resultingHouseholds: 1, resultingInvitedCapacity: 1 },
      committedRosterVersion: 8,
      currentRosterVersion: 8,
      replayed: false,
    }, 201));
    expect(await screen.findByRole('heading', { name: 'Guests added' })).toBeVisible();
  });

  it('does not auto-proceed a blocked route when Settings saves but a guest draft remains dirty', async () => {
    let releaseSettings: (() => void) | null = null;
    const fetchMock = managerFetch({ first: { media: [], nextCursor: null } });
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/settings') && String(init?.method).toUpperCase() === 'PATCH') {
        return new Promise<Response>((resolve) => {
          releaseSettings = () => resolve(json({ event: { ...MANAGED_EVENT, moderationRequired: false } }));
        });
      }
      return fetchMock(input);
    }));
    const user = typist();
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await openSettings(user);
    await user.click(screen.getByLabelText('Review guestbook notes before sharing'));
    await waitFor(() => expect(releaseSettings).not.toBeNull());

    const nav = within(screen.getByRole('navigation', { name: 'Manager sections' }));
    await user.click(nav.getByRole('button', { name: 'RSVP' }));
    await user.click(await screen.findByRole('button', { name: 'Add guests' }));
    await user.type(screen.getByLabelText('Guest names or spreadsheet data'), 'Taylor Morgan');
    await user.click(screen.getByRole('link', { name: 'Candidary home' }));

    const prompt = await screen.findByRole('region', { name: 'Your pending work is not saved' });
    expect(within(prompt).getByText(/Settings or appearance changes are also unconfirmed/u)).toBeVisible();
    releaseSettings!();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Add guests' })).toBeVisible());
    expect(screen.getByRole('region', { name: 'Your pending work is not saved' })).toBeVisible();
  });

  it('guards Settings repair behind guest-draft discard and clears the repair intent on Stay', async () => {
    vi.stubGlobal('fetch', managerFetch({ first: { media: [], nextCursor: null } }));
    const user = typist();
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await openSettings(user);
    await user.clear(screen.getByLabelText('Event name'));

    const nav = within(screen.getByRole('navigation', { name: 'Manager sections' }));
    await user.click(nav.getByRole('button', { name: 'RSVP' }));
    const notice = await screen.findByRole('region', { name: 'Unsaved settings' });
    await user.click(await screen.findByRole('button', { name: 'Add guests' }));
    await user.type(screen.getByLabelText('Guest names or spreadsheet data'), 'Taylor Morgan');

    await user.click(within(notice).getByRole('button', { name: 'Open settings' }));
    let prompt = await screen.findByRole('region', { name: 'Your pending work is not saved' });
    expect(within(prompt).getByText(/unsent or invalid changes will be left behind/u)).toBeVisible();
    await user.click(within(prompt).getByRole('button', { name: 'Stay' }));
    expect(screen.getByRole('heading', { name: 'Add guests' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Unsaved settings' })).toBeVisible();

    await user.click(within(screen.getByRole('region', { name: 'Unsaved settings' }))
      .getByRole('button', { name: 'Open settings' }));
    prompt = await screen.findByRole('region', { name: 'Your pending work is not saved' });
    await user.click(within(prompt).getByRole('button', { name: 'Discard draft' }));
    expect(await screen.findByRole('heading', { name: 'Settings' })).toHaveFocus();
    const settingsNotice = screen.getByRole('region', { name: 'Unsaved settings' });
    expect(settingsNotice).toBeVisible();
    expect(within(settingsNotice).queryByRole('button', { name: 'Open settings' })).not.toBeInTheDocument();
  });

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

    await user.click(screen.getByLabelText('Review guestbook notes before sharing'));
    await user.click(screen.getByRole('link', { name: 'Candidary home' }));

    const prompt = await screen.findByRole('region', { name: /not saved yet/i });
    expect(within(prompt).getByRole('button', { name: 'Leave now' })).toBeVisible();
    expect(within(prompt).queryByRole('button', { name: 'Stay and fix settings' })).not.toBeInTheDocument();
    expect(prompt).toHaveFocus();

    expect(release).not.toBeNull();
    release!();
    await waitFor(() => expect(screen.queryByRole('region', { name: /not saved yet/i })).not.toBeInTheDocument());
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

    await user.click(screen.getByLabelText('Review guestbook notes before sharing'));
    await user.click(screen.getByRole('link', { name: 'Candidary home' }));
    const prompt = await screen.findByRole('region', { name: /not saved yet/i });
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

    const prompt = await screen.findByRole('region', { name: /not saved yet/i });
    await user.click(within(prompt).getByRole('button', { name: 'Stay and fix settings' }));

    expect(screen.getByRole('heading', { name: 'Settings' })).toHaveFocus();
    expect(screen.getByRole('textbox', { name: /Event name/u })).toBeVisible();
    expect(screen.queryByRole('region', { name: /not saved yet/i })).not.toBeInTheDocument();
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
    expect(screen.getByRole('heading', { name: 'Settings' })).toHaveFocus();
    expect(screen.getByRole('textbox', { name: /Event name/u })).toBeVisible();

    const managerNav = within(screen.getByRole('navigation', { name: 'Manager sections' }));
    await user.click(managerNav.getByRole('button', { name: /gallery/i }));
    const settingsButton = managerNav.getByRole('button', { name: /settings/i });
    await user.click(settingsButton);
    // The repair transfer is one-shot. Ordinary section navigation keeps
    // focus on the navigation control the host used.
    expect(settingsButton).toHaveFocus();
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

    await user.click(screen.getByLabelText('Review guestbook notes before sharing'));
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
    await user.click(screen.getByLabelText('Review guestbook notes before sharing'));
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

    await user.click(screen.getByLabelText('Review guestbook notes before sharing'));
    await waitFor(() => expect(added.mock.calls.filter(([type]) => type === 'beforeunload').length)
      .toBeGreaterThan(0));
    await waitFor(() => expect(removed.mock.calls.filter(([type]) => type === 'beforeunload').length)
      .toBeGreaterThan(0));
  });

  it('registers and removes beforeunload for a browser-only guest-list draft', async () => {
    vi.stubGlobal('fetch', managerFetch({ first: { media: [], nextCursor: null } }));
    const added = vi.spyOn(window, 'addEventListener');
    const removed = vi.spyOn(window, 'removeEventListener');
    const user = typist();
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await screen.findByRole('heading', { name: 'Live intake' });

    const nav = within(screen.getByRole('navigation', { name: 'Manager sections' }));
    await user.click(nav.getByRole('button', { name: 'RSVP' }));
    await user.click(await screen.findByRole('button', { name: 'Add guests' }));
    await user.type(screen.getByLabelText('Guest names or spreadsheet data'), 'Taylor Morgan');
    await waitFor(() => expect(added.mock.calls.filter(([type]) => type === 'beforeunload').length)
      .toBeGreaterThan(0));

    await user.click(nav.getByRole('button', { name: 'Gallery' }));
    await user.click(within(await screen.findByRole('region', { name: 'Your pending work is not saved' }))
      .getByRole('button', { name: 'Discard draft' }));
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
      if (url.endsWith('/rsvp/roster/preview') && method === 'POST') {
        const body = JSON.parse(String(init?.body));
        return json({
          canonicalBatch: body.batch, rosterVersion: 7, targetVersions: [],
          totals: { householdsCreated: 1, householdsUpdated: 0, namedInviteesAdded: 1, plusOneCapacityAdded: 0, invitedCapacityAdded: 1, resultingHouseholds: 1, resultingInvitedCapacity: 1 },
          issues: [], previewDigest: 'preview', canCommit: true,
        });
      }
      if (url.endsWith('/rsvp/roster/commit') && method === 'POST') {
        return json({
          createdHouseholds: [], updatedHouseholds: [],
          totals: { householdsCreated: 1, householdsUpdated: 0, namedInviteesAdded: 1, plusOneCapacityAdded: 0, invitedCapacityAdded: 1, resultingHouseholds: 1, resultingInvitedCapacity: 1 },
          committedRosterVersion: 8, currentRosterVersion: 8, replayed: false,
        }, 201);
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
    await user.click(await screen.findByRole('button', { name: 'Add guests' }));
    await screen.findByRole('heading', { name: 'Add guests' });
    await user.type(screen.getByLabelText('Guest names or spreadsheet data'), 'Taylor Morgan');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Continue to details' }));
    await user.click(screen.getByRole('button', { name: 'Review guests' }));
    await user.click(await screen.findByRole('button', { name: 'Add 1 guest across 1 household' }));
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

    await user.click(screen.getByLabelText('Review guestbook notes before sharing'));
    await user.click(screen.getByRole('radio', { name: 'Garden Party' }));
    await waitFor(() => expect(releases).toHaveLength(2));

    // Settle the theme first, then the older settings response.
    releases[1]!();
    releases[0]!();

    await waitFor(() => expect(screen.getByLabelText('Review guestbook notes before sharing')).not.toBeChecked());
    // The settings response carried the pre-change theme; it must not travel.
    expect(screen.getByTestId('event-appearance-canvas')).toHaveStyle({ '--event-primary': '#245c46' });
    // And the theme response carried the pre-change switch; that must not travel either.
    expect(screen.getByLabelText('Review guestbook notes before sharing')).not.toBeChecked();
  });

  it('keeps intake paused when a settings response arrives after entry disable', async () => {
    const disabledAt = '2026-08-01T15:00:00.000Z';
    const disabledEvent = {
      ...MANAGED_EVENT,
      uploadsEnabled: false, photosOpen: false, photoIntakeState: 'paused', rsvpEnabled: false,
    };
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

    await user.click(screen.getByLabelText('Review guestbook notes before sharing'));
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
    // The stop is irreversible, so the panel explains it rather than offering a
    // reopen the server would refuse anyway.
    expect(screen.getByText('Photo delivery is paused.')).toBeVisible();
    expect(screen.getByText('The printed event QR was disabled, so photo delivery cannot be reopened.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Reopen photo delivery' })).not.toBeInTheDocument();
  });

  it('keeps a deferred cover response from restoring stale settings or theme', async () => {
    const gardenTheme = resolveEventTheme({ version: 1, presetId: 'garden-party', overrides: {} });
    // Removal is the one cover write that applies synchronously and answers with
    // a whole event, so it is what can carry stale neighbours back.
    const covered = {
      ...MANAGED_EVENT,
      cover: {
        config: {
          version: 1,
          source: { kind: 'preset', presetId: 'warm-linen', assetVersion: 1 },
          effect: 'natural',
        },
        revision: 1,
        hasCover: true,
        available2xProfiles: [],
        surfaceTreatment: 'none',
        preparation: null,
      },
    };
    let releaseCover: (() => void) | null = null;
    const fetchMock = managerFetch({ first: { media: [], nextCursor: null } }, covered);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/cover/publications') && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { operationId: string };
        await new Promise<void>((resolve) => { releaseCover = resolve; });
        // Built from a row read before either later write.
        return json({
          applied: true,
          appliedRevision: 2,
          operation: {
            operationId: body.operationId,
            status: 'applied',
            completedSteps: 0,
            requiredSteps: 0,
            retryable: false,
            safeFailureCode: null,
            updatedAt: '2026-08-10T00:00:00.000Z',
          },
          event: {
            ...covered,
            cover: {
              config: { version: 1, source: { kind: 'none' } },
              revision: 2,
              hasCover: false,
              available2xProfiles: [],
              surfaceTreatment: 'none',
              preparation: null,
            },
            moderationRequired: true,
            theme: MANAGED_EVENT.theme,
          },
        });
      }
      if (url.endsWith('/settings') && method === 'PATCH') {
        return json({ event: { ...covered, moderationRequired: false } });
      }
      if (url.endsWith('/theme') && method === 'PUT') {
        return json({ event: { ...covered, theme: gardenTheme } });
      }
      return fetchMock(input);
    }));
    const user = typist();
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await openSettings(user);

    await user.click(screen.getByRole('button', { name: 'Change cover' }));
    await user.click(screen.getByRole('button', { name: 'Remove cover' }));
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(releaseCover).not.toBeNull());

    await user.click(screen.getByLabelText('Review guestbook notes before sharing'));
    await user.click(screen.getByRole('radio', { name: 'Garden Party' }));
    await waitFor(() => expect(screen.getByLabelText('Review guestbook notes before sharing')).not.toBeChecked());

    releaseCover!();

    // The cover response owns the cover and nothing else.
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Cover Studio' })).not.toBeInTheDocument());
    expect(screen.getByText(/No cover is currently shown/u)).toBeVisible();
    expect(screen.getByLabelText('Review guestbook notes before sharing')).not.toBeChecked();
    expect(screen.getByTestId('event-appearance-canvas')).toHaveStyle({ '--event-primary': '#245c46' });
  });
});

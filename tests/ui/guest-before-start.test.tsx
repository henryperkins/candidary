import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GuestEventView, RsvpHouseholdView } from '../../shared/contracts';
import { DEFAULT_GUESTBOOK_PROMPT } from '../../shared/constants';
import { GuestBeforeStart } from '../../src/features/guest/GuestBeforeStart';

/* The event's zone is deliberately not the one this suite runs in, and not UTC
   either: 6:00 PM in London is 12:00 PM in Chicago and 5:00 PM in UTC. The exact
   rendered start is therefore evidence that the event's own zone formatted it. */
const event: GuestEventView = {
  id: 'event-a',
  slug: 'maya-theo',
  name: 'Maya & Theo',
  eventDate: '2026-09-19',
  welcomeMessage: 'We cannot wait to celebrate with you.',
  guestbookPrompt: DEFAULT_GUESTBOOK_PROMPT,
  cover: { revision: 0, hasCover: false, available2xProfiles: [], surfaceTreatment: 'none' },
  uploadsEnabled: true,
  galleryVisible: false,
  moderationRequired: true,
  eventTimezone: 'Europe/London',
  eventStartAt: '2026-09-19T17:00:00.000Z',
  rsvpDeadlineAt: '2026-09-04T22:59:59.999Z',
  rsvpDeadlineDate: '2026-09-04',
  phase: 'before-start',
  rsvpState: 'closed',
  rsvpAccess: 'read-only',
  lifecycleRecheckAfterMs: null,
  guestReadSurfaces: { available: false, reason: 'before-photo-open' },
  theme: { tokens: {} } as GuestEventView['theme'],
};

const household: RsvpHouseholdView = {
  id: 'household-a',
  label: 'The Morgan household',
  version: 4,
  editable: false,
  renewalRequired: false,
  deadlineAt: '2026-09-04T22:59:59.999Z',
  invitees: [
    { id: '11111111-1111-4111-8111-111111111111', kind: 'named', displayName: 'Taylor Morgan', attendance: 'pending', order: 0 },
    { id: '22222222-2222-4222-8222-222222222222', kind: 'named', displayName: 'Alex Morgan', attendance: 'pending', order: 1 },
  ],
  firstRespondedAt: null,
  latestRespondedAt: null,
  latestActor: null,
};

const responded: RsvpHouseholdView = {
  ...household,
  invitees: household.invitees.map((invitee) => ({ ...invitee, attendance: 'attending' as const })),
  firstRespondedAt: '2026-08-01T12:00:00.000Z',
  latestRespondedAt: '2026-08-01T12:00:00.000Z',
  latestActor: 'household',
};

function success(data: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify({ data, requestId: 'request-a' }), {
    status,
    headers: { 'content-type': 'application/json' },
  }));
}

function failure(code: string, message: string, status: number) {
  return Promise.resolve(new Response(JSON.stringify({ code, message, requestId: 'request-a' }), {
    status,
    headers: { 'content-type': 'application/json' },
  }));
}

// Every RSVP request this surface could make, so a test can assert on the ones
// that were issued as well as on the ones that were not.
function rsvpFetch(readHousehold: () => Promise<Response>) {
  return vi.fn((input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith('/rsvp/household')) return readHousehold();
    throw new Error(`Unexpected request ${path}`);
  });
}

function rsvpRequests(fetchMock: ReturnType<typeof vi.fn>) {
  return (fetchMock.mock.calls as Array<[RequestInfo | URL]>)
    .map(([input]) => String(input))
    .filter((path) => path.includes('/rsvp/'));
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('guest before-start surface', () => {
  it('names when the event begins in its own zone and says photos follow it', async () => {
    vi.stubGlobal('fetch', rsvpFetch(() => success({ household: responded })));
    render(<GuestBeforeStart event={event} />);

    expect(screen.getByRole('heading', { level: 1, name: "The event hasn't started yet" })).toBeVisible();
    expect(screen.getByText('Maya & Theo begins September 19, 2026 at 6:00 PM.')).toBeVisible();
    expect(screen.getByText('Come back when the event begins to take or add photos.')).toBeVisible();
    await screen.findByRole('heading', { name: 'Your RSVP' });
  });

  it('thanks a household that responded and shows what it sent', async () => {
    vi.stubGlobal('fetch', rsvpFetch(() => success({ household: responded })));
    render(<GuestBeforeStart event={event} />);

    await screen.findByRole('heading', { name: 'Your RSVP' });
    expect(screen.getByText('We appreciate your RSVP. Your saved household response is below.')).toBeVisible();
    expect(screen.getByText('2 attending · 0 not attending')).toBeVisible();
    expect(screen.getByText('Taylor Morgan')).toBeVisible();
    // The deadline is already behind this household, and repeating it is exactly
    // the dead end this surface replaces.
    expect(screen.queryByText(/^Changes close/)).not.toBeInTheDocument();
  });

  it('states plainly that a located household has no saved response, without thanks and without reproach', async () => {
    vi.stubGlobal('fetch', rsvpFetch(() => success({ household })));
    render(<GuestBeforeStart event={event} />);

    await screen.findByRole('heading', { name: 'Your RSVP' });
    expect(screen.getByText("There isn't a saved RSVP for this household.")).toBeVisible();
    expect(screen.queryByText(/We appreciate your RSVP/)).not.toBeInTheDocument();
    expect(screen.queryByText(/deadline/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit RSVP' })).not.toBeInTheDocument();
  });

  it('offers a lookup to a device that never held a household session', async () => {
    vi.stubGlobal('fetch', rsvpFetch(() => failure('RSVP_SESSION_REQUIRED', 'Find your invitation to continue.', 401)));
    render(<GuestBeforeStart event={event} />);

    expect(await screen.findByRole('heading', { name: 'Find your household to view a saved response.' })).toBeVisible();
    expect(screen.getByLabelText('Full name')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Find my invitation' })).toBeVisible();
    // An instruction to answer by a date nobody can act on is the dead end again.
    expect(screen.queryByText(/^Please RSVP by/)).not.toBeInTheDocument();
  });

  it('issues no household or lookup request at all when access is unavailable', async () => {
    const fetchMock = rsvpFetch(() => success({ household: responded }));
    vi.stubGlobal('fetch', fetchMock);
    render(<GuestBeforeStart event={{ ...event, rsvpAccess: 'unavailable' }} />);

    expect(screen.getByRole('heading', { level: 1, name: "The event hasn't started yet" })).toBeVisible();
    expect(screen.getByText('Maya & Theo begins September 19, 2026 at 6:00 PM.')).toBeVisible();
    // An event that never adopted RSVP must not advertise a lookup that can only
    // miss, and must not ask on the guest's behalf either.
    expect(rsvpRequests(fetchMock)).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Find my invitation' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Your RSVP' })).not.toBeInTheDocument();
  });

  it('keeps one level-one heading and puts the embedded household content beneath it', async () => {
    vi.stubGlobal('fetch', rsvpFetch(() => success({ household: responded })));
    const view = render(<GuestBeforeStart event={event} />);

    const receipt = await screen.findByRole('heading', { name: 'Your RSVP' });
    expect(screen.getAllByRole('heading', { level: 1 }).map((heading) => heading.textContent))
      .toEqual(["The event hasn't started yet"]);
    expect(receipt.tagName).toBe('H2');
    // The page already drew the hero, so the embedded flow may not draw a second one.
    expect(view.container.querySelectorAll('.photo-drop__hero')).toHaveLength(1);

    view.unmount();
    vi.stubGlobal('fetch', rsvpFetch(() => failure('RSVP_SESSION_REQUIRED', 'Find your invitation to continue.', 401)));
    render(<GuestBeforeStart event={event} />);

    const lookup = await screen.findByRole('heading', { name: 'Find your household to view a saved response.' });
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(lookup.tagName).toBe('H2');
  });
});

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GuestEventView, RsvpHouseholdView } from '../../shared/contracts';
import { GuestRsvpFlow } from '../../src/features/rsvp/GuestRsvpFlow';

const event: GuestEventView = {
  id: 'event-a',
  slug: 'maya-theo',
  name: 'Maya & Theo',
  eventDate: '2026-09-19',
  welcomeMessage: 'We cannot wait to celebrate with you.',
  coverObjectKey: null,
  uploadsEnabled: false,
  galleryVisible: false,
  moderationRequired: true,
  eventTimezone: 'America/Chicago',
  rsvpDeadlineAt: '2026-09-05T23:59:59.999Z',
  rsvpDeadlineDate: '2026-09-05',
  phase: 'rsvp-primary',
  rsvpState: 'open',
  theme: { tokens: {} } as GuestEventView['theme'],
};

const household: RsvpHouseholdView = {
  id: 'household-a',
  label: 'The Morgan household',
  version: 4,
  editable: true,
  renewalRequired: false,
  deadlineAt: '2026-09-05T23:59:59.999Z',
  invitees: [
    { id: '11111111-1111-4111-8111-111111111111', kind: 'named', displayName: 'Taylor Morgan', attendance: 'pending', order: 0 },
    { id: '22222222-2222-4222-8222-222222222222', kind: 'named', displayName: 'Alex Morgan', attendance: 'pending', order: 1 },
    { id: '33333333-3333-4333-8333-333333333333', kind: 'plus_one', displayName: null, attendance: 'pending', order: 2 },
  ],
  firstRespondedAt: null,
  latestRespondedAt: null,
  latestActor: null,
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

function requestPath(input: RequestInfo | URL) {
  return String(input);
}

function sessionRequired() {
  return failure('RSVP_SESSION_REQUIRED', 'Find your invitation to continue.', 401);
}

async function openInvitation(user: ReturnType<typeof userEvent.setup>, name = 'Taylor Morgan') {
  await user.type(await screen.findByLabelText('Full name'), name);
  await user.click(screen.getByRole('button', { name: 'Find my invitation' }));
}

async function selectAllAttendance(user: ReturnType<typeof userEvent.setup>, attendance: 'Attending' | 'Not attending') {
  for (const group of screen.getAllByRole('group')) {
    await user.click(within(group).getByRole('radio', { name: attendance }));
  }
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('household RSVP guest flow', () => {
  it('performs only an explicit exact-name lookup and never treats a remembered upload name as RSVP authority', async () => {
    localStorage.setItem('candidary_guest_name', 'Taylor Upload');
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      if (path.endsWith('/rsvp/household')) return sessionRequired();
      if (path.endsWith('/rsvp/lookup')) return success({ status: 'matched', household });
      throw new Error(`Unexpected request ${path} ${init?.method ?? 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<GuestRsvpFlow event={event} presentation="primary" />);
    const firstName = await screen.findByLabelText('Full name');
    expect(firstName).toHaveAttribute('autocomplete', 'name');
    expect(firstName).toHaveValue('');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    await user.type(firstName, 'Taylor Morgan');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('candidary_guest_name')).toBe('Taylor Upload');

    await user.click(screen.getByRole('button', { name: 'Find my invitation' }));
    await screen.findByRole('heading', { name: 'Your household RSVP' });
    expect(localStorage.getItem('candidary_guest_name')).toBe('Taylor Morgan');
  });

  it('keeps no-match generic and moves ambiguity to a second exact-name field without roster choices', async () => {
    let lookupCount = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = requestPath(input);
      if (path.endsWith('/rsvp/household')) return sessionRequired();
      if (path.endsWith('/rsvp/lookup')) {
        lookupCount += 1;
        return lookupCount === 1
          ? success({ status: 'not_available', message: 'We could not open an invitation with those details.' })
          : success({ status: 'second_name_required' });
      }
      throw new Error(`Unexpected request ${path}`);
    }));
    const user = userEvent.setup();
    render(<GuestRsvpFlow event={event} presentation="primary" />);

    await openInvitation(user, 'Not Listed');
    expect(await screen.findByText('We could not open an invitation with those details.')).toBeVisible();
    expect(screen.queryByText('Taylor Morgan')).not.toBeInTheDocument();

    await openInvitation(user, 'Taylor Morgan');
    const secondName = await screen.findByLabelText('Another full name');
    expect(secondName).toHaveFocus();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
  });

  it('opens the matched household after two exact names and restores a returning session without a lookup', async () => {
    let householdGets = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      if (path.endsWith('/rsvp/household')) {
        householdGets += 1;
        return householdGets === 1 ? sessionRequired() : success({ household });
      }
      if (path.endsWith('/rsvp/lookup')) {
        return success(init?.body && JSON.parse(String(init.body)).secondName
          ? { status: 'matched', household }
          : { status: 'second_name_required' });
      }
      throw new Error(`Unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    const view = render(<GuestRsvpFlow event={event} presentation="primary" />);

    await openInvitation(user, 'Taylor Morgan');
    await user.type(await screen.findByLabelText('Another full name'), 'Alex Morgan');
    await user.click(screen.getByRole('button', { name: 'Find my invitation' }));
    await screen.findByRole('heading', { name: 'Your household RSVP' });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    view.unmount();
    render(<GuestRsvpFlow event={event} presentation="primary" />);
    await screen.findByRole('heading', { name: 'Your household RSVP' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('uses labelled native attendance radios, validates the first incomplete row, and reports only household counts', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      if (requestPath(input).endsWith('/rsvp/household')) return success({ household });
      throw new Error(`Unexpected request ${requestPath(input)}`);
    }));
    const user = userEvent.setup();
    render(<GuestRsvpFlow event={event} presentation="primary" />);
    await screen.findByRole('heading', { name: 'Your household RSVP' });

    const taylor = screen.getByRole('group', { name: 'Taylor Morgan' });
    expect(within(taylor).getByRole('radio', { name: 'Attending' })).toHaveAttribute('type', 'radio');
    expect(within(taylor).getByRole('radio', { name: 'Not attending' })).toHaveAttribute('type', 'radio');
    expect(screen.getByRole('group', { name: 'Plus one 1' })).toBeVisible();
    expect(screen.getByText('0 attending · 0 not attending · 3 to answer')).toBeVisible();
    expect(screen.queryByText(/households responded/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Submit RSVP' }));
    const error = await within(taylor).findByText('Choose attending or not attending.');
    expect(within(taylor).getByRole('radio', { name: 'Attending' })).toHaveFocus();
    expect(within(taylor).getByRole('radio', { name: 'Attending' })).toHaveAttribute('aria-describedby');
    expect(error).toBeVisible();
  });

  it.each([
    ['all attending', ['Attending', 'Attending', 'Attending'], '3 attending · 0 not attending · 0 to answer'],
    ['all declining', ['Not attending', 'Not attending', 'Not attending'], '0 attending · 3 not attending · 0 to answer'],
    ['a mixed response', ['Attending', 'Not attending', 'Attending'], '2 attending · 1 not attending · 0 to answer'],
  ] as const)('keeps live household-only counts for %s', async (_label, choices, expected) => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      if (requestPath(input).endsWith('/rsvp/household')) return success({ household });
      throw new Error(`Unexpected request ${requestPath(input)}`);
    }));
    const user = userEvent.setup();
    render(<GuestRsvpFlow event={event} presentation="primary" />);
    await screen.findByRole('heading', { name: 'Your household RSVP' });

    const groups = screen.getAllByRole('group');
    for (const [index, choice] of choices.entries()) {
      await user.click(within(groups[index]!).getByRole('radio', { name: choice }));
    }

    expect(screen.getByText(expected)).toBeVisible();
    expect(screen.queryByText(/households responded/i)).not.toBeInTheDocument();
  });

  it('requires and focuses the attending plus-one name without losing the attendance draft', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      if (requestPath(input).endsWith('/rsvp/household')) return success({ household });
      throw new Error(`Unexpected request ${requestPath(input)}`);
    }));
    const user = userEvent.setup();
    render(<GuestRsvpFlow event={event} presentation="primary" />);
    await screen.findByRole('heading', { name: 'Your household RSVP' });
    await selectAllAttendance(user, 'Attending');

    await user.click(screen.getByRole('button', { name: 'Submit RSVP' }));

    const plusOneName = screen.getByLabelText('Plus one 1 name');
    expect(plusOneName).toHaveFocus();
    expect(plusOneName).toHaveAttribute('aria-describedby');
    expect(screen.getByText('Enter this guest’s name.')).toBeVisible();
    expect(within(screen.getByRole('group', { name: 'Plus one 1' })).getByRole('radio', { name: 'Attending' })).toBeChecked();
  });

  it('sends every row only after explicit submit and clears a declined plus-one name from its payload', async () => {
    const writes: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      if (path.endsWith('/rsvp/household') && init?.method === 'PUT') {
        writes.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return success({ household: { ...household, version: 5, invitees: household.invitees.map((invitee) => ({
          ...invitee,
          attendance: invitee.id === household.invitees[2]!.id ? 'declined' : 'attending',
        })) }, committedVersion: 5, replayed: false });
      }
      if (path.endsWith('/rsvp/household')) return success({ household });
      throw new Error(`Unexpected request ${path}`);
    }));
    const user = userEvent.setup();
    render(<GuestRsvpFlow event={event} presentation="primary" />);
    await screen.findByRole('heading', { name: 'Your household RSVP' });

    await user.click(within(screen.getByRole('group', { name: 'Taylor Morgan' })).getByRole('radio', { name: 'Attending' }));
    await user.click(within(screen.getByRole('group', { name: 'Alex Morgan' })).getByRole('radio', { name: 'Attending' }));
    const plusOne = screen.getByRole('group', { name: 'Plus one 1' });
    await user.click(within(plusOne).getByRole('radio', { name: 'Attending' }));
    await user.type(screen.getByLabelText('Plus one 1 name'), 'Jordan Lee');
    await user.click(within(plusOne).getByRole('radio', { name: 'Not attending' }));
    expect(writes).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Submit RSVP' }));
    await screen.findByRole('heading', { name: "You're all set" });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      version: 4,
      invitees: expect.arrayContaining([
        expect.objectContaining({ id: '33333333-3333-4333-8333-333333333333', attendance: 'declined', displayName: null }),
      ]),
    });
  });

  it('preserves an interrupted draft and its idempotency key for retry, then offers Change RSVP after success', async () => {
    const attempts: Array<Record<string, unknown>> = [];
    let submitCount = 0;
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'stable-rsvp-key') });
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      if (path.endsWith('/rsvp/household') && init?.method === 'PUT') {
        submitCount += 1;
        attempts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return submitCount === 1
          ? Promise.reject(new TypeError('network dropped'))
          : success({ household: { ...household, version: 5 }, committedVersion: 5, replayed: false });
      }
      if (path.endsWith('/rsvp/household')) return success({ household });
      throw new Error(`Unexpected request ${path}`);
    }));
    const user = userEvent.setup();
    render(<GuestRsvpFlow event={event} presentation="primary" />);
    await screen.findByRole('heading', { name: 'Your household RSVP' });
    await selectAllAttendance(user, 'Attending');
    await user.type(screen.getByLabelText('Plus one 1 name'), 'Jordan Lee');
    await user.click(screen.getByRole('button', { name: 'Submit RSVP' }));
    expect(await screen.findByText('We could not save your RSVP. Your answers are still here.')).toBeVisible();
    expect(screen.getByLabelText('Plus one 1 name')).toHaveValue('Jordan Lee');

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('heading', { name: "You're all set" });
    expect(attempts.map(({ idempotencyKey }) => idempotencyKey)).toEqual(['stable-rsvp-key', 'stable-rsvp-key']);
    await user.click(screen.getByRole('button', { name: 'Change RSVP' }));
    await screen.findByRole('heading', { name: 'Your household RSVP' });
  });

  it('starts a new submission intent when answers change after an interrupted save', async () => {
    const attempts: string[] = [];
    let submitCount = 0;
    vi.stubGlobal('crypto', {
      randomUUID: vi.fn()
        .mockReturnValueOnce('first-rsvp-key')
        .mockReturnValueOnce('changed-rsvp-key'),
    });
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      if (path.endsWith('/rsvp/household') && init?.method === 'PUT') {
        submitCount += 1;
        const body = JSON.parse(String(init.body)) as { idempotencyKey: string };
        attempts.push(body.idempotencyKey);
        return submitCount === 1
          ? Promise.reject(new TypeError('network dropped'))
          : success({ household: { ...household, version: 5 }, committedVersion: 5, replayed: false });
      }
      if (path.endsWith('/rsvp/household')) return success({ household });
      throw new Error(`Unexpected request ${path}`);
    }));
    const user = userEvent.setup();
    render(<GuestRsvpFlow event={event} presentation="primary" />);
    await screen.findByRole('heading', { name: 'Your household RSVP' });
    await selectAllAttendance(user, 'Not attending');
    await user.click(screen.getByRole('button', { name: 'Submit RSVP' }));
    await screen.findByText('We could not save your RSVP. Your answers are still here.');

    await user.click(within(screen.getByRole('group', { name: 'Taylor Morgan' }))
      .getByRole('radio', { name: 'Attending' }));
    await user.click(screen.getByRole('button', { name: 'Submit RSVP' }));
    await screen.findByRole('heading', { name: "You're all set" });
    expect(attempts).toEqual(['first-rsvp-key', 'changed-rsvp-key']);
  });

  it('keeps the household editor compact when RSVP is opened as a secondary action', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      if (requestPath(input).endsWith('/rsvp/household')) return success({ household });
      throw new Error(`Unexpected request ${requestPath(input)}`);
    }));

    render(<GuestRsvpFlow event={event} presentation="secondary" />);
    await screen.findByRole('heading', { name: 'Your household RSVP' });
    expect(screen.getByRole('heading', { name: 'Your household RSVP' }).closest('.rsvp-flow'))
      .toHaveClass('rsvp-flow--secondary');
  });

  it('refetches the current household after a stale version and focuses review without overwriting it', async () => {
    const current = {
      ...household,
      version: 6,
      invitees: household.invitees.slice(0, 2).map((invitee) => ({ ...invitee, attendance: 'declined' as const })),
    };
    let householdReads = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      if (path.endsWith('/rsvp/household') && init?.method === 'PUT') {
        return failure('RSVP_HOUSEHOLD_CONFLICT', 'This invitation changed since you opened it. Review it and send again.', 409);
      }
      if (path.endsWith('/rsvp/household')) {
        householdReads += 1;
        return success({ household: householdReads === 1 ? household : current });
      }
      throw new Error(`Unexpected request ${path}`);
    }));
    const user = userEvent.setup();
    render(<GuestRsvpFlow event={event} presentation="primary" />);
    await screen.findByRole('heading', { name: 'Your household RSVP' });
    await selectAllAttendance(user, 'Attending');
    await user.type(screen.getByLabelText('Plus one 1 name'), 'Jordan Lee');
    await user.click(screen.getByRole('button', { name: 'Submit RSVP' }));

    const review = await screen.findByRole('heading', { name: 'Review updated household' });
    expect(review).toHaveFocus();
    expect(screen.queryByRole('group', { name: 'Plus one 1' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Taylor Morgan' })).getByRole('radio', { name: 'Not attending' })).toBeChecked();
  });

  // The server has no separate closed/paused refusal on the write path: a deadline
  // that passes mid-edit fails the guarded write and arrives as a conflict. The
  // refetched household is the only thing that says the window shut, so the flow
  // has to read it rather than reopening a form that can never be submitted.
  it('lands read-only when the household it refetches after a conflict can no longer be written', async () => {
    const closed = {
      ...household,
      version: 7,
      editable: false,
      firstRespondedAt: '2026-08-01T12:00:00.000Z',
      latestRespondedAt: '2026-08-01T12:00:00.000Z',
      latestActor: 'household' as const,
      invitees: household.invitees.map((invitee) => ({ ...invitee, attendance: 'attending' as const })),
    };
    let householdReads = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      if (path.endsWith('/rsvp/household') && init?.method === 'PUT') {
        return failure('RSVP_HOUSEHOLD_CONFLICT', 'This invitation changed since you opened it. Review it and send again.', 409);
      }
      if (path.endsWith('/rsvp/household')) {
        householdReads += 1;
        return success({ household: householdReads === 1 ? household : closed });
      }
      throw new Error(`Unexpected request ${path}`);
    }));
    const user = userEvent.setup();
    render(<GuestRsvpFlow event={event} presentation="primary" />);
    await screen.findByRole('heading', { name: 'Your household RSVP' });
    await selectAllAttendance(user, 'Attending');
    await user.type(screen.getByLabelText('Plus one 1 name'), 'Jordan Lee');
    await user.click(screen.getByRole('button', { name: 'Submit RSVP' }));

    expect(await screen.findByRole('heading', { name: 'Your RSVP' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Submit RSVP' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Review updated household' })).not.toBeInTheDocument();
  });

  // A conflict whose roster is unchanged — a host correcting attendance, or a
  // transient fault dressed as a conflict — must not throw away answers the guest
  // already typed. Only a roster whose people changed invalidates them.
  it('keeps the answers already typed when a conflict leaves the roster unchanged', async () => {
    let householdReads = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      if (path.endsWith('/rsvp/household') && init?.method === 'PUT') {
        return failure('RSVP_HOUSEHOLD_CONFLICT', 'This invitation changed since you opened it. Review it and send again.', 409);
      }
      if (path.endsWith('/rsvp/household')) {
        householdReads += 1;
        return success({ household: householdReads === 1 ? household : { ...household, version: 9 } });
      }
      throw new Error(`Unexpected request ${path}`);
    }));
    const user = userEvent.setup();
    render(<GuestRsvpFlow event={event} presentation="primary" />);
    await screen.findByRole('heading', { name: 'Your household RSVP' });
    await selectAllAttendance(user, 'Attending');
    await user.type(screen.getByLabelText('Plus one 1 name'), 'Jordan Lee');
    await user.click(screen.getByRole('button', { name: 'Submit RSVP' }));

    await screen.findByRole('heading', { name: 'Review updated household' });
    expect(within(screen.getByRole('group', { name: 'Taylor Morgan' })).getByRole('radio', { name: 'Attending' })).toBeChecked();
    expect(screen.getByLabelText('Plus one 1 name')).toHaveValue('Jordan Lee');
  });

  it('shows saved read-only responses after a deadline, requires renewed lookup after an extension, and retains a paused response', async () => {
    const saved = {
      ...household,
      editable: false,
      invitees: household.invitees.map((invitee) => ({ ...invitee, attendance: 'attending' as const, displayName: invitee.kind === 'plus_one' ? 'Jordan Lee' : invitee.displayName })),
      firstRespondedAt: '2026-08-01T12:00:00.000Z',
      latestRespondedAt: '2026-08-01T12:00:00.000Z',
      latestActor: 'household' as const,
    };
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = requestPath(input);
      if (path.endsWith('/rsvp/household')) return success({ household: saved });
      if (path.endsWith('/rsvp/lookup')) return success({ status: 'matched', household });
      throw new Error(`Unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const closedEvent = { ...event, rsvpState: 'closed' as const, phase: 'waiting' as const };
    const view = render(<GuestRsvpFlow event={closedEvent} presentation="read-only" />);
    await screen.findByRole('heading', { name: 'Your RSVP' });
    expect(screen.getByText('RSVP is closed. Your saved response is shown below.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Change RSVP' })).not.toBeInTheDocument();

    view.rerender(<GuestRsvpFlow event={{ ...event, rsvpState: 'open' }} presentation="secondary" />);
    expect(await screen.findByRole('button', { name: 'Find my invitation again' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Find my invitation again' }));
    await user.type(await screen.findByLabelText('Full name'), 'Taylor Morgan');
    await user.click(screen.getByRole('button', { name: 'Find my invitation' }));
    await screen.findByRole('heading', { name: 'Your household RSVP' });

    view.rerender(<GuestRsvpFlow event={{ ...event, rsvpState: 'paused' }} presentation="read-only" />);
    expect(await screen.findByText('RSVP is paused. Your saved response is still here.')).toBeVisible();
  });
});

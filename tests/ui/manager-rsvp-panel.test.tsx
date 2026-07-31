import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  EventView,
  RsvpHouseholdDetail,
  RsvpHouseholdListPage,
  RsvpImportIssue,
  RsvpSummary,
} from '../../shared/contracts';
import { resolveEventTheme } from '../../shared/event-theme';
import { ManagerRsvpPanel } from '../../src/components/ManagerRsvpPanel';

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

const event: EventView = {
  id: 'event-a',
  slug: 'maya-theo',
  name: 'Maya & Theo',
  eventDate: '2026-09-19',
  welcomeMessage: 'Welcome.',
  coverObjectKey: null,
  uploadsEnabled: false,
  galleryVisible: false,
  moderationRequired: true,
  reservedMediaCount: 0,
  storedMediaCount: 0,
  reservedBytes: 0,
  storedBytes: 0,
  guestAccessExpiresAt: '2026-10-19T00:00:00Z',
  managementAccessExpiresAt: '2026-10-20T00:00:00Z',
  purgeAfter: '2026-12-19T00:00:00Z',
  createdAt: '2026-07-30T00:00:00Z',
  deletedAt: null,
  eventTimezone: 'America/Chicago',
  rsvpEnabled: false,
  rsvpDeadlineAt: '2026-09-05T04:59:59.999Z',
  rsvpDeadlineDate: '2026-09-04',
  rsvpRosterVersion: 7,
  theme: resolveEventTheme({ version: 1, presetId: 'candidary-default', overrides: {} }),
};

const summary: RsvpSummary = {
  invitedCapacity: 8,
  namedInvitees: 6,
  plusOneCapacity: 2,
  attending: 3,
  declined: 2,
  awaitingResponse: 3,
  householdsResponded: 1,
  householdsAwaitingResponse: 2,
};

const household: RsvpHouseholdDetail = {
  id: '11111111-1111-4111-8111-111111111111',
  householdKey: 'morgan',
  label: 'The Morgan household',
  plusOneSlots: 1,
  version: 4,
  archivedAt: null,
  invitees: [
    {
      id: '22222222-2222-4222-8222-222222222222',
      kind: 'named',
      displayName: 'Taylor Morgan',
      attendance: 'attending',
      order: 0,
    },
    {
      id: '33333333-3333-4333-8333-333333333333',
      kind: 'named',
      displayName: 'Alex Morgan',
      attendance: 'declined',
      order: 1,
    },
    {
      id: '44444444-4444-4444-8444-444444444444',
      kind: 'plus_one',
      displayName: 'Jamie',
      attendance: 'attending',
      order: 2,
    },
  ],
  firstRespondedAt: '2026-08-01T00:00:00Z',
  latestRespondedAt: '2026-08-02T00:00:00Z',
  latestActor: 'household',
  updatedAt: '2026-08-02T00:00:00Z',
};

function listPage(
  label = household.label,
  nextCursor: string | null = null,
): RsvpHouseholdListPage {
  return {
    households: [{
      id: household.id,
      householdKey: household.householdKey,
      label,
      version: household.version,
      archivedAt: null,
      attending: 2,
      declined: 1,
      awaitingResponse: 0,
      invitedCapacity: 3,
      firstRespondedAt: household.firstRespondedAt,
      latestRespondedAt: household.latestRespondedAt,
      latestActor: household.latestActor,
      updatedAt: household.updatedAt,
    }],
    nextCursor,
  };
}

function route(input: RequestInfo | URL) {
  return new URL(String(input), 'https://candidary.test');
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('manager RSVP panel', () => {
  it('uses all eight server totals and server-side query, state, and cursor pages', async () => {
    const requested: string[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = route(input);
      requested.push(`${url.pathname}${url.search}`);
      if (url.pathname.endsWith('/summary')) return success(summary);
      if (url.pathname.endsWith('/households')) {
        if (url.searchParams.get('cursor') === 'next-page') {
          return success(listPage('The Rivera household'));
        }
        if (url.searchParams.get('query') === 'rivera') {
          return success(listPage('The Rivera household'));
        }
        return success(listPage(household.label, 'next-page'));
      }
      throw new Error(`Unexpected request ${url}`);
    }));

    render(<ManagerRsvpPanel event={event} onEventChanged={vi.fn()} />);

    expect(await screen.findByRole('heading', { name: 'Guest list and RSVPs' })).toBeVisible();
    for (const [name, value] of [
      ['Invited capacity', 8],
      ['Named invitees', 6],
      ['Plus-one capacity', 2],
      ['Attending', 3],
      ['Declined', 2],
      ['Awaiting response', 3],
      ['Households responded', 1],
      ['Households awaiting response', 2],
    ] as const) {
      expect(screen.getByRole('group', { name })).toHaveTextContent(String(value));
    }
    expect(screen.getByRole('button', { name: /The Morgan household/ })).toBeVisible();

    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Response status'), 'awaiting');
    await waitFor(() => expect(requested.some((path) => path.includes('state=awaiting'))).toBe(true));

    await user.type(screen.getByLabelText('Search guest list'), 'rivera');
    await waitFor(
      () => expect(requested.some((path) => path.includes('query=rivera'))).toBe(true),
      { timeout: 1_000 },
    );
    expect(await screen.findByRole('button', { name: /The Rivera household/ })).toBeVisible();

    await user.clear(screen.getByLabelText('Search guest list'));
    await user.selectOptions(screen.getByLabelText('Response status'), 'all');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load more households' })).toBeVisible());
    await user.click(screen.getByRole('button', { name: 'Load more households' }));
    await waitFor(() => expect(requested.some((path) => path.includes('cursor=next-page'))).toBe(true));
  });

  it('reads the original CSV, previews counts and issues, and commits only explicitly', async () => {
    const csv = 'household_key,household_label,invitee_name,plus_one_slots\r\nmorgan,The Morgans,Taylor Morgan,1\r\n';
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = route(input);
      if (url.pathname.endsWith('/summary')) return success(summary);
      if (url.pathname.endsWith('/households')) return success({ households: [], nextCursor: null });
      if (url.pathname.endsWith('/import/preview')) {
        bodies.push(JSON.parse(String(init?.body)));
        return success({
          issues: [],
          totals: { households: 1, namedInvitees: 1, plusOneCapacity: 1, invitedCapacity: 2 },
          sourceDigest: 'a'.repeat(64),
          rosterVersion: 7,
        });
      }
      if (url.pathname.endsWith('/import/commit')) {
        bodies.push(JSON.parse(String(init?.body)));
        return success({
          totals: { households: 1, namedInvitees: 1, plusOneCapacity: 1, invitedCapacity: 2 },
          rosterVersion: 8,
        }, 201);
      }
      throw new Error(`Unexpected request ${url}`);
    }));

    render(<ManagerRsvpPanel event={event} onEventChanged={vi.fn()} />);
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Guest list and RSVPs' });
    await user.upload(screen.getByLabelText('Guest list CSV'), new File([csv], 'guests.csv', { type: 'text/csv' }));

    expect(await screen.findByText('1 household')).toBeVisible();
    expect(screen.getByText('2 invited')).toBeVisible();
    expect(screen.getByText('No blocking issues found.')).toBeVisible();
    expect(bodies).toEqual([{ csv }]);

    await user.click(screen.getByRole('button', { name: 'Commit guest list' }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toEqual({
      csv,
      sourceDigest: 'a'.repeat(64),
      expectedRosterVersion: 7,
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Guest list committed.');
  });

  it('withholds commit for blocking issues and renders issue text with its row and field', async () => {
    const issue: RsvpImportIssue = {
      row: 3,
      field: 'invitee_name',
      code: 'invitee_name_invalid',
      message: '<script>Choose a valid guest name.</script>',
      blocking: true,
    };
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = route(input);
      if (url.pathname.endsWith('/summary')) return success(summary);
      if (url.pathname.endsWith('/households')) return success({ households: [], nextCursor: null });
      if (url.pathname.endsWith('/import/preview')) {
        return success({
          issues: [issue],
          totals: { households: 0, namedInvitees: 0, plusOneCapacity: 0, invitedCapacity: 0 },
          sourceDigest: 'b'.repeat(64),
          rosterVersion: 7,
        });
      }
      throw new Error(`Unexpected request ${url}`);
    }));

    render(<ManagerRsvpPanel event={event} onEventChanged={vi.fn()} />);
    await userEvent.setup().upload(
      await screen.findByLabelText('Guest list CSV'),
      new File(['bad'], 'bad.csv', { type: 'text/csv' }),
    );

    const issues = await screen.findByRole('region', { name: 'CSV issues' });
    expect(issues).toHaveTextContent('Row 3');
    expect(issues).toHaveTextContent('invitee name');
    expect(issues).toHaveTextContent('<script>Choose a valid guest name.</script>');
    expect(issues.querySelector('script')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Commit guest list' })).not.toBeInTheDocument();
  });

  it('keeps a selected CSV available when its preview becomes stale', async () => {
    let commitAttempts = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = route(input);
      if (url.pathname.endsWith('/summary')) return success(summary);
      if (url.pathname.endsWith('/households')) return success({ households: [], nextCursor: null });
      if (url.pathname.endsWith('/import/preview')) {
        return success({
          issues: [],
          totals: { households: 1, namedInvitees: 1, plusOneCapacity: 0, invitedCapacity: 1 },
          sourceDigest: 'c'.repeat(64),
          rosterVersion: 7,
        });
      }
      if (url.pathname.endsWith('/import/commit')) {
        commitAttempts += 1;
        return failure('RSVP_IMPORT_CONFLICT', 'Preview the file again before committing it.', 409);
      }
      throw new Error(`Unexpected request ${url}`);
    }));

    render(<ManagerRsvpPanel event={event} onEventChanged={vi.fn()} />);
    const user = userEvent.setup();
    const input = await screen.findByLabelText('Guest list CSV');
    await user.upload(input, new File(['one'], 'keep-me.csv', { type: 'text/csv' }));
    await user.click(await screen.findByRole('button', { name: 'Commit guest list' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Preview the file again');
    // The chosen file survives the refused commit: only the server's verdict about
    // it expired, so the host re-previews rather than re-picking the file.
    expect((input as HTMLInputElement).value).toContain('keep-me.csv');
    expect(screen.getByText('keep-me.csv')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Preview again' })).toBeVisible();
    expect(commitAttempts).toBe(1);
  });

  it('creates a household with the loaded roster version and announces the result', async () => {
    let createdBody: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = route(input);
      if (url.pathname.endsWith('/summary')) return success(summary);
      if (url.pathname.endsWith('/households') && (init?.method ?? 'GET') === 'GET') {
        return success({ households: [], nextCursor: null });
      }
      if (url.pathname.endsWith('/households') && init?.method === 'POST') {
        createdBody = JSON.parse(String(init.body));
        return success({ household, rosterVersion: 8 }, 201);
      }
      throw new Error(`Unexpected request ${url}`);
    }));

    render(<ManagerRsvpPanel event={event} onEventChanged={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add household' }));
    await user.type(screen.getByLabelText('Household key'), 'morgan');
    await user.type(screen.getByLabelText('Household label'), 'The Morgan household');
    await user.type(screen.getByLabelText('Named guests'), 'Taylor Morgan\nAlex Morgan');
    await user.clear(screen.getByLabelText('Plus-one slots'));
    await user.type(screen.getByLabelText('Plus-one slots'), '1');
    await user.click(screen.getByRole('button', { name: 'Create household' }));

    await waitFor(() => expect(createdBody).toEqual({
      householdKey: 'morgan',
      label: 'The Morgan household',
      plusOneSlots: 1,
      namedInvitees: ['Taylor Morgan', 'Alex Morgan'],
      expectedRosterVersion: 7,
    }));
    expect(await screen.findByRole('status')).toHaveTextContent('The Morgan household created.');
  });

  it('refreshes a household conflict and focuses the winning editor heading', async () => {
    let detailLoads = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = route(input);
      if (url.pathname.endsWith('/summary')) return success(summary);
      if (url.pathname.endsWith('/households')) return success(listPage());
      if (url.pathname.endsWith(`/${household.id}`) && (init?.method ?? 'GET') === 'GET') {
        detailLoads += 1;
        return success(detailLoads === 1 ? household : { ...household, label: 'Morgan household — refreshed', version: 5 });
      }
      if (url.pathname.endsWith(`/${household.id}`) && init?.method === 'PUT') {
        return failure('RSVP_HOUSEHOLD_CONFLICT', 'Another person changed this household.', 409);
      }
      throw new Error(`Unexpected request ${url}`);
    }));

    render(<ManagerRsvpPanel event={event} onEventChanged={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /The Morgan household/ }));
    await user.clear(await screen.findByLabelText('Household label'));
    await user.type(screen.getByLabelText('Household label'), 'Edited label');
    await user.click(screen.getByRole('button', { name: 'Save household' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Another person changed this household');
    const heading = await screen.findByRole('heading', { name: 'Morgan household — refreshed' });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(detailLoads).toBe(2);
  });

  it('corrects responses after the deadline, then requires named archive confirmation', async () => {
    const requests: Array<{ path: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = route(input);
      if (url.pathname.endsWith('/summary')) return success(summary);
      if (url.pathname.endsWith('/households')) return success(listPage());
      if (url.pathname.endsWith(`/${household.id}`) && (init?.method ?? 'GET') === 'GET') {
        return success(household);
      }
      if (url.pathname.endsWith('/response') && init?.method === 'PUT') {
        requests.push({ path: url.pathname, body: JSON.parse(String(init.body)) });
        return success({
          household: { ...household, version: 5, latestActor: 'host' },
          rosterVersion: 8,
        });
      }
      if (url.pathname.endsWith('/archive') && init?.method === 'POST') {
        requests.push({ path: url.pathname, body: JSON.parse(String(init.body)) });
        return success({
          household: { ...household, version: 6, archivedAt: '2026-08-03T00:00:00Z' },
          rosterVersion: 9,
        });
      }
      throw new Error(`Unexpected request ${url}`);
    }));

    render(<ManagerRsvpPanel event={event} onEventChanged={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /The Morgan household/ }));

    const taylor = screen.getByRole('group', { name: 'Taylor Morgan' });
    await user.click(within(taylor).getByRole('radio', { name: 'Not attending' }));
    await user.click(screen.getByRole('button', { name: 'Save response correction' }));
    await waitFor(() => expect(requests[0]?.path).toMatch(/\/response$/));
    expect(requests[0]?.body).toMatchObject({ expectedVersion: 4, expectedRosterVersion: 7 });
    expect(await screen.findByRole('status')).toHaveTextContent('Response correction saved.');

    await user.click(screen.getByRole('button', { name: 'Archive household' }));
    const confirmation = screen.getByRole('group', { name: 'Archive The Morgan household' });
    expect(confirmation).toHaveTextContent('lookup and signed-in guest devices stop');
    expect(confirmation).toHaveTextContent('export keeps');
    expect(within(confirmation).getByRole('button', { name: 'Archive The Morgan household' })).toBeDisabled();
    await user.type(within(confirmation).getByLabelText('Type household name'), household.label);
    await user.click(within(confirmation).getByRole('button', { name: 'Archive The Morgan household' }));
    await waitFor(() => expect(requests[1]?.path).toMatch(/\/archive$/));
    expect(await screen.findByText('Archived')).toBeVisible();
  });

  // The create form is the one mutation that does not run through the shared
  // household-write path, so its conflict recovery has to be proved separately:
  // without a resync the host retries the same stale version forever.
  it('resyncs the roster version after a refused create so the retry can succeed', async () => {
    const sent: Array<Record<string, unknown>> = [];
    let attempts = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = route(input);
      if (url.pathname.endsWith('/rsvp/summary')) return success(summary);
      if (url.pathname.endsWith('/rsvp/households') && (init?.method ?? 'GET') === 'GET') {
        return success({ households: [], nextCursor: null });
      }
      if (url.pathname.endsWith('/rsvp/households') && init?.method === 'POST') {
        sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        attempts += 1;
        return attempts === 1
          ? failure('RSVP_HOUSEHOLD_CONFLICT', 'This household changed since you opened it.', 409)
          : success({ household, rosterVersion: 12 }, 201);
      }
      // The refused create re-reads the event, which is where the current roster
      // version comes from.
      if (url.pathname.endsWith('/events/event-a')) {
        return success({ event: { ...event, rsvpRosterVersion: 11 } });
      }
      throw new Error(`Unexpected request ${url}`);
    }));

    const onEventChanged = vi.fn();
    const { rerender } = render(<ManagerRsvpPanel event={event} onEventChanged={onEventChanged} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add household' }));
    await user.type(screen.getByLabelText('Household key'), 'morgan');
    await user.type(screen.getByLabelText('Household label'), 'The Morgan household');
    await user.type(screen.getByLabelText('Named guests'), 'Taylor Morgan');
    await user.click(screen.getByRole('button', { name: 'Create household' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('changed since you opened it');
    expect(sent[0]).toMatchObject({ expectedRosterVersion: 7 });
    // The form survives so the host retries their typed household, not a blank one.
    expect(screen.getByLabelText('Household key')).toHaveValue('morgan');

    // The shell reloads the event on the failure path, exactly as it does after a
    // successful write, so the retry carries the version the server now holds.
    expect(onEventChanged).toHaveBeenCalled();
    rerender(<ManagerRsvpPanel
      event={{ ...event, rsvpRosterVersion: 11 }}
      onEventChanged={onEventChanged}
    />);
    await user.click(screen.getByRole('button', { name: 'Create household' }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toMatchObject({ expectedRosterVersion: 11 });
  });

  // A committed edit followed by a failed refresh is still a committed edit. It
  // must not be announced as a refusal, or a host undoes work that landed.
  it('does not report a committed edit as refused when only the refresh fails', async () => {
    let refreshes = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = route(input);
      if (url.pathname.endsWith('/rsvp/summary')) {
        refreshes += 1;
        return refreshes > 1
          ? failure('INTERNAL_ERROR', 'The guest list totals could not be loaded.', 503)
          : success(summary);
      }
      if (url.pathname.endsWith('/rsvp/households')) return success(listPage());
      if (url.pathname.endsWith(`/${household.id}`) && (init?.method ?? 'GET') === 'GET') {
        return success(household);
      }
      if (url.pathname.endsWith(`/${household.id}`) && init?.method === 'PUT') {
        return success({ household: { ...household, version: 5 }, rosterVersion: 8 });
      }
      throw new Error(`Unexpected request ${url}`);
    }));

    render(<ManagerRsvpPanel event={event} onEventChanged={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /The Morgan household/ }));
    await user.clear(await screen.findByLabelText('Household label'));
    await user.type(screen.getByLabelText('Household label'), 'Edited label');
    await user.click(screen.getByRole('button', { name: 'Save household' }));

    const announced = await screen.findByRole('status');
    expect(announced).toHaveTextContent('saved');
    // A stale total is worth saying; it is not a failed write, so it does not
    // get the alert that a refused one does.
    expect(announced).toHaveTextContent('could not be refreshed');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('offers the current server CSV export', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = route(input);
      if (url.pathname.endsWith('/summary')) return success(summary);
      if (url.pathname.endsWith('/households')) return success({ households: [], nextCursor: null });
      throw new Error(`Unexpected request ${url}`);
    }));

    render(<ManagerRsvpPanel event={event} onEventChanged={vi.fn()} />);
    expect(await screen.findByRole('link', { name: 'Download current CSV' }))
      .toHaveAttribute('href', '/api/manage/events/event-a/rsvp/export.csv');
  });
});

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  EventView,
  RsvpHouseholdDetail,
  RsvpHouseholdListPage,
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
  cover: {
    config: { version: 1, source: { kind: 'none' } }, revision: 0, hasCover: false,
    available2xProfiles: [], surfaceTreatment: 'none', preparation: null,
  },
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
  eventStartAt: '2026-09-19T22:00:00.000Z',
  eventStartTime: '17:00',
  photosOpen: false,
  photoIntakeState: 'paused',
  photoIntakeRecheckAfterMs: null,
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

const emptySummary: RsvpSummary = {
  invitedCapacity: 0,
  namedInvitees: 0,
  plusOneCapacity: 0,
  attending: 0,
  declined: 0,
  awaitingResponse: 0,
  householdsResponded: 0,
  householdsAwaitingResponse: 0,
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
  it('waits for the roster probes before choosing setup or dashboard UI', async () => {
    let resolveSummary: ((response: Response) => void) | null = null;
    let resolveActive: ((response: Response) => void) | null = null;
    let resolveHistory: ((response: Response) => void) | null = null;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = route(input);
      if (url.pathname.endsWith('/summary')) {
        return new Promise<Response>((resolve) => { resolveSummary = resolve; });
      }
      if (url.pathname.endsWith('/households') && url.searchParams.get('state') === 'archived') {
        return new Promise<Response>((resolve) => { resolveHistory = resolve; });
      }
      if (url.pathname.endsWith('/households')) {
        return new Promise<Response>((resolve) => { resolveActive = resolve; });
      }
      throw new Error(`Unexpected request ${url}`);
    }));

    render(<ManagerRsvpPanel event={event} onEventChanged={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Add guests' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Invited capacity' })).not.toBeInTheDocument();

    await waitFor(() => {
      expect(resolveSummary).not.toBeNull();
      expect(resolveActive).not.toBeNull();
      expect(resolveHistory).not.toBeNull();
    });
    resolveSummary!(await success(emptySummary));
    resolveActive!(await success({ households: [], nextCursor: null }));
    resolveHistory!(await success({ households: [], nextCursor: null }));
    expect(await screen.findByRole('heading', { name: 'Start your guest list' })).toBeVisible();
  });

  it('replaces dashboard totals only after active and archived roster checks confirm a pristine event', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = route(input);
      if (url.pathname.endsWith('/summary')) return success(emptySummary);
      if (url.pathname.endsWith('/households')) return success({ households: [], nextCursor: null });
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<ManagerRsvpPanel event={event} onEventChanged={vi.fn()} />);

    expect(await screen.findByRole('heading', { name: 'Start your guest list' })).toBeVisible();
    expect(screen.queryByRole('group', { name: 'Invited capacity' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add guests' })).toBeVisible();
  });

  it('keeps the normal dashboard and launcher for archived-only or history-unavailable rosters', async () => {
    let historyFails = false;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = route(input);
      if (url.pathname.endsWith('/summary')) return success(emptySummary);
      if (url.pathname.endsWith('/households') && url.searchParams.get('state') === 'archived') {
        return historyFails
          ? failure('INTERNAL_ERROR', 'History unavailable.', 503)
          : success(listPage('Archived Morgan'));
      }
      if (url.pathname.endsWith('/households')) return success({ households: [], nextCursor: null });
      throw new Error(`Unexpected request ${url}`);
    }));
    const { unmount } = render(<ManagerRsvpPanel event={event} onEventChanged={vi.fn()} />);
    expect(await screen.findByRole('group', { name: 'Invited capacity' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add guests' })).toBeVisible();
    unmount();

    historyFails = true;
    render(<ManagerRsvpPanel event={event} onEventChanged={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('history could not be checked');
    expect(screen.getByRole('group', { name: 'Invited capacity' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add guests' })).toBeVisible();
  });

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

  it('stages plain names, groups explicitly, previews, and commits the canonical batch', async () => {
    const calls: Array<{ path: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = route(input);
      if (url.pathname.endsWith('/summary')) return success(summary);
      if (url.pathname.endsWith('/households')) return success({ households: [], nextCursor: null });
      if (url.pathname.endsWith('/roster/preview')) {
        const body = JSON.parse(String(init?.body));
        calls.push({ path: url.pathname, body });
        return success({ canonicalBatch: body.batch, rosterVersion: 7, targetVersions: [], totals: { householdsCreated: 1, householdsUpdated: 0, namedInviteesAdded: 2, plusOneCapacityAdded: 0, invitedCapacityAdded: 2, resultingHouseholds: 1, resultingInvitedCapacity: 2 }, issues: [], previewDigest: 'digest', canCommit: true });
      }
      if (url.pathname.endsWith('/roster/commit')) {
        const body = JSON.parse(String(init?.body));
        calls.push({ path: url.pathname, body });
        return success({ createdHouseholds: [], updatedHouseholds: [], totals: { householdsCreated: 1, householdsUpdated: 0, namedInviteesAdded: 2, plusOneCapacityAdded: 0, invitedCapacityAdded: 2, resultingHouseholds: 1, resultingInvitedCapacity: 2 }, committedRosterVersion: 8, currentRosterVersion: 8, replayed: false });
      }
      throw new Error(`Unexpected request ${url}`);
    }));
    const onWrite = vi.fn((request: () => Promise<unknown>) => request()) as <T,>(request: () => Promise<T>) => Promise<T>;
    const observed = vi.fn();
    render(<ManagerRsvpPanel event={event} onEventChanged={vi.fn()} onEventWrite={onWrite} onRosterVersionObserved={observed} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add guests' }));
    await user.type(screen.getByLabelText('Guest names or spreadsheet data'), 'Taylor Morgan\nAlex Morgan');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByLabelText('Taylor Morgan'));
    await user.click(screen.getByLabelText('Alex Morgan'));
    await user.click(screen.getByRole('button', { name: 'Group as one invitation' }));
    await user.click(screen.getByRole('button', { name: 'Continue to details' }));
    await user.click(screen.getByRole('button', { name: 'Review guests' }));
    await user.click(await screen.findByRole('button', { name: 'Add 2 guests across 1 household' }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0]?.body).toMatchObject({ expectedRosterVersion: 7 });
    expect(calls[1]?.body).toMatchObject({ previewDigest: 'digest', expectedRosterVersion: 7 });
    expect(onWrite).toHaveBeenCalledTimes(1);
    expect(observed).toHaveBeenCalledWith(8);
    expect(await screen.findByRole('status')).toHaveTextContent('Guest list updated');
  });

  it('keeps the dashboard mounted while a later roster filter request is pending', async () => {
    let resolveFiltered: ((response: Response) => void) | null = null;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = route(input);
      if (url.pathname.endsWith('/summary')) return success(summary);
      if (url.pathname.endsWith('/households') && url.searchParams.get('query') === 'rivera') {
        return new Promise<Response>((resolve) => { resolveFiltered = resolve; });
      }
      if (url.pathname.endsWith('/households')) return success(listPage());
      throw new Error(`Unexpected request ${url}`);
    }));

    render(<ManagerRsvpPanel event={event} onEventChanged={vi.fn()} />);
    const user = userEvent.setup();
    expect(await screen.findByRole('group', { name: 'Invited capacity' })).toBeVisible();
    await user.type(screen.getByLabelText('Search guest list'), 'rivera');
    await waitFor(() => expect(resolveFiltered).not.toBeNull());

    expect(screen.getByRole('group', { name: 'Invited capacity' })).toBeVisible();
    expect(screen.getByLabelText('Search guest list')).toHaveValue('rivera');

    resolveFiltered!(await success(listPage('The Rivera household')));
    expect(await screen.findByRole('button', { name: /The Rivera household/ })).toBeVisible();
  });

  it('does not let a superseded preview replace a newer invitation edit', async () => {
    let resolvePreview: ((response: Response) => void) | null = null;
    let previewBatch: any;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = route(input);
      if (url.pathname.endsWith('/summary')) return success(summary);
      if (url.pathname.endsWith('/households')) return success({ households: [], nextCursor: null });
      if (url.pathname.endsWith('/roster/preview')) {
        previewBatch = JSON.parse(String(init?.body)).batch;
        return new Promise<Response>((resolve) => { resolvePreview = resolve; });
      }
      throw new Error(`Unexpected request ${url}`);
    }));

    render(<ManagerRsvpPanel event={event} onEventChanged={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add guests' }));
    await user.type(screen.getByLabelText('Guest names or spreadsheet data'), 'Taylor Morgan');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Continue to details' }));
    await user.click(screen.getByRole('button', { name: 'Review guests' }));
    await waitFor(() => expect(resolvePreview).not.toBeNull());

    const name = screen.getByLabelText('Guest name');
    await user.clear(name);
    await user.type(name, 'Taylor Rose');
    resolvePreview!(new Response(JSON.stringify({
      data: {
        canonicalBatch: previewBatch,
        rosterVersion: 7,
        targetVersions: [],
        totals: { householdsCreated: 1, householdsUpdated: 0, namedInviteesAdded: 1, plusOneCapacityAdded: 0, invitedCapacityAdded: 1, resultingHouseholds: 1, resultingInvitedCapacity: 1 },
        issues: [],
        previewDigest: 'stale-preview',
        canCommit: true,
      },
      requestId: 'request-a',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await waitFor(() => expect(screen.queryByRole('button', { name: /Add 1 guest across 1 household/ })).not.toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Invitation details' })).toBeVisible();
    expect(screen.getByLabelText('Guest name')).toHaveValue('Taylor Rose');
  });

  it('preserves invitation detail edits across backward navigation until organization changes', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = route(input);
      if (url.pathname.endsWith('/summary')) return success(summary);
      if (url.pathname.endsWith('/households')) return success({ households: [], nextCursor: null });
      throw new Error(`Unexpected request ${url}`);
    }));

    render(<ManagerRsvpPanel event={event} onEventChanged={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add guests' }));
    await user.type(screen.getByLabelText('Guest names or spreadsheet data'), 'Taylor Morgan\nAlex Morgan\nJamie Lee');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Continue to details' }));

    const labels = screen.getAllByLabelText('Invitation label');
    const names = screen.getAllByLabelText('Guest name');
    const slots = screen.getAllByLabelText('Plus-one slots');
    await user.clear(labels[0]!);
    await user.type(labels[0]!, 'Taylor and guests');
    await user.clear(names[0]!);
    await user.type(names[0]!, 'Taylor Rose');
    await user.clear(slots[0]!);
    await user.type(slots[0]!, '2');

    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Continue to details' }));
    expect(screen.getAllByLabelText('Invitation label')[0]).toHaveValue('Taylor and guests');
    expect(screen.getAllByLabelText('Guest name')[0]).toHaveValue('Taylor Rose');
    expect(screen.getAllByLabelText('Plus-one slots')[0]).toHaveValue(2);

    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByLabelText('Alex Morgan'));
    await user.click(screen.getByLabelText('Jamie Lee'));
    await user.click(screen.getByRole('button', { name: 'Group as one invitation' }));
    await user.click(screen.getByRole('button', { name: 'Continue to details' }));
    expect(screen.getAllByLabelText('Invitation label')).toHaveLength(2);
    expect(screen.getAllByLabelText('Invitation label').map((input) => (input as HTMLInputElement).value))
      .toContain('Taylor and guests');
    expect(screen.getAllByLabelText('Guest name').map((input) => (input as HTMLInputElement).value))
      .toContain('Taylor Rose');
    const preserved = screen.getByDisplayValue('Taylor and guests').closest('section');
    expect(preserved).not.toBeNull();
    expect(within(preserved!).getByLabelText('Plus-one slots')).toHaveValue(2);
  });

  it('exposes the input format choices as one keyboard radio group', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = route(input);
      if (url.pathname.endsWith('/summary')) return success(summary);
      if (url.pathname.endsWith('/households')) return success({ households: [], nextCursor: null });
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<ManagerRsvpPanel event={event} onEventChanged={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add guests' }));

    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios).toHaveLength(2);
    expect(radios[0]?.name).not.toBe('');
    expect(radios[1]?.name).toBe(radios[0]?.name);
  });

  it('keeps affected-household receipt links after adopting the committed roster version', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = route(input);
      if (url.pathname.endsWith('/summary')) return success(summary);
      if (url.pathname.endsWith('/households')) return success({ households: [], nextCursor: null });
      if (url.pathname.endsWith('/roster/preview')) {
        const body = JSON.parse(String(init?.body));
        return success({
          canonicalBatch: body.batch,
          rosterVersion: 7,
          targetVersions: [],
          totals: { householdsCreated: 1, householdsUpdated: 0, namedInviteesAdded: 1, plusOneCapacityAdded: 0, invitedCapacityAdded: 1, resultingHouseholds: 1, resultingInvitedCapacity: 1 },
          issues: [],
          previewDigest: 'receipt-link-preview',
          canCommit: true,
        });
      }
      if (url.pathname.endsWith('/roster/commit')) {
        const body = JSON.parse(String(init?.body));
        const created = body.canonicalBatch.creates[0];
        return success({
          createdHouseholds: [{ clientHouseholdId: created.clientHouseholdId, householdId: household.id }],
          updatedHouseholds: [],
          totals: { householdsCreated: 1, householdsUpdated: 0, namedInviteesAdded: 1, plusOneCapacityAdded: 0, invitedCapacityAdded: 1, resultingHouseholds: 1, resultingInvitedCapacity: 1 },
          committedRosterVersion: 8,
          currentRosterVersion: 8,
          replayed: false,
        }, 201);
      }
      throw new Error(`Unexpected request ${url}`);
    }));

    render(<ManagerRsvpPanel event={event} onEventChanged={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add guests' }));
    await user.type(screen.getByLabelText('Guest names or spreadsheet data'), 'Taylor Morgan');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Continue to details' }));
    await user.click(screen.getByRole('button', { name: 'Review guests' }));
    await user.click(await screen.findByRole('button', { name: 'Add 1 guest across 1 household' }));

    expect(await screen.findByRole('heading', { name: 'Guests added' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Open Taylor Morgan' })).toBeVisible();
  });

  it('keeps the former strict CSV path as a batch preview and commit, without sending raw source rows', async () => {
    const requests: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = route(input);
      if (url.pathname.endsWith('/summary')) return success(summary);
      if (url.pathname.endsWith('/households')) return success({ households: [], nextCursor: null });
      if (url.pathname.endsWith('/roster/preview')) {
        const body = JSON.parse(String(init?.body));
        requests.push(body);
        return success({
          canonicalBatch: body.batch, rosterVersion: 7, targetVersions: [],
          totals: { householdsCreated: 1, householdsUpdated: 0, namedInviteesAdded: 1, plusOneCapacityAdded: 1, invitedCapacityAdded: 2, resultingHouseholds: 1, resultingInvitedCapacity: 2 },
          issues: [], previewDigest: 'strict-preview', canCommit: true,
        });
      }
      if (url.pathname.endsWith('/roster/commit')) {
        requests.push(JSON.parse(String(init?.body)));
        return success({
          createdHouseholds: [], updatedHouseholds: [],
          totals: { householdsCreated: 1, householdsUpdated: 0, namedInviteesAdded: 1, plusOneCapacityAdded: 1, invitedCapacityAdded: 2, resultingHouseholds: 1, resultingInvitedCapacity: 2 },
          committedRosterVersion: 8, currentRosterVersion: 8, replayed: false,
        }, 201);
      }
      throw new Error(`Unexpected request ${url}`);
    }));

    render(<ManagerRsvpPanel event={event} onEventChanged={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add guests' }));
    await user.type(screen.getByLabelText('Guest names or spreadsheet data'), 'household_key,household_label,invitee_name,plus_one_slots\nmorgan,The Morgans,Taylor Morgan,1');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(await screen.findByRole('button', { name: 'Review guests' }));
    await user.click(await screen.findByRole('button', { name: 'Add 2 guests across 1 household' }));

    expect(requests[0]).toMatchObject({
      expectedRosterVersion: 7,
      batch: {
        creates: [expect.objectContaining({
          label: 'The Morgans',
          namedInvitees: [expect.objectContaining({ displayName: 'Taylor Morgan' })],
          plusOneSlots: 1,
        })],
      },
    });
    expect(requests[0]).not.toHaveProperty('csv');
    expect(requests[1]).toMatchObject({ previewDigest: 'strict-preview', expectedRosterVersion: 7 });
  });

  it('adds named guests and stable responded plus-one rows only to an explicitly selected household', async () => {
    let previewBody: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = route(input);
      if (url.pathname.endsWith('/summary')) return success(summary);
      if (url.pathname.endsWith('/households')) return success(listPage());
      if (url.pathname.endsWith(`/${household.id}`) && (init?.method ?? 'GET') === 'GET') return success(household);
      if (url.pathname.endsWith('/roster/preview')) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        previewBody = body;
        return success({
          canonicalBatch: body.batch, rosterVersion: 7, targetVersions: [],
          totals: { householdsCreated: 0, householdsUpdated: 1, namedInviteesAdded: 1, plusOneCapacityAdded: 1, invitedCapacityAdded: 2, resultingHouseholds: 1, resultingInvitedCapacity: 5 },
          issues: [], previewDigest: 'append-preview', canCommit: true,
        });
      }
      throw new Error(`Unexpected request ${url}`);
    }));

    render(<ManagerRsvpPanel event={event} onEventChanged={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add guests' }));
    await user.type(screen.getByLabelText('Guest names or spreadsheet data'), 'Jordan Morgan');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(screen.getByLabelText('Search households'), 'Morgan');
    const target = await screen.findByLabelText('Existing household target');
    await screen.findByRole('option', { name: /The Morgan household/ });
    await user.selectOptions(target, household.id);
    await waitFor(() => expect(target).toHaveValue(household.id));
    expect(screen.getByLabelText('Search households')).toBeVisible();
    expect(screen.queryByText(/Will become individual invitations:/u)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue to details' }));
    await user.selectOptions(screen.getByLabelText('Attendance for Jordan Morgan'), 'attending');
    const slots = screen.getByLabelText('Additional plus-one slots');
    await user.clear(slots);
    await user.type(slots, '1');
    await user.selectOptions(await screen.findByLabelText('Attendance for new plus-one 1'), 'attending');
    await user.type(screen.getByLabelText('Name for attending plus-one 1'), 'Casey Morgan');
    await user.click(screen.getByRole('button', { name: 'Review guests' }));
    expect(screen.queryByText(/Automatic individual invitations:/u)).not.toBeInTheDocument();

    await waitFor(() => expect(previewBody).toBeDefined());
    expect(previewBody).toMatchObject({
      batch: {
        creates: [],
        appends: [expect.objectContaining({
          householdId: household.id,
          expectedHouseholdVersion: household.version,
          namedInvitees: [expect.objectContaining({ displayName: 'Jordan Morgan', attendance: 'attending' })],
          plusOneSlotsToAdd: 1,
          newPlusOneResponses: [expect.objectContaining({
            attendance: 'attending',
            displayName: 'Casey Morgan',
            clientInviteeId: expect.stringMatching(/^[0-9a-f-]{36}$/iu),
          })],
        })],
      },
    });
  });

  it('drops append-only attendance when a responded-household addition becomes a new invitation', async () => {
    let previewBody: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = route(input);
      if (url.pathname.endsWith('/summary')) return success(summary);
      if (url.pathname.endsWith('/households')) return success(listPage());
      if (url.pathname.endsWith(`/${household.id}`) && (init?.method ?? 'GET') === 'GET') return success(household);
      if (url.pathname.endsWith('/roster/preview')) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        previewBody = body;
        return success({
          canonicalBatch: body.batch, rosterVersion: 7, targetVersions: [],
          totals: { householdsCreated: 1, householdsUpdated: 0, namedInviteesAdded: 1, plusOneCapacityAdded: 0, invitedCapacityAdded: 1, resultingHouseholds: 2, resultingInvitedCapacity: 4 },
          issues: [], previewDigest: 'converted-create-preview', canCommit: true,
        });
      }
      throw new Error(`Unexpected request ${url}`);
    }));

    render(<ManagerRsvpPanel event={event} onEventChanged={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add guests' }));
    await user.type(screen.getByLabelText('Guest names or spreadsheet data'), 'Jordan Morgan');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(screen.getByLabelText('Search households'), 'Morgan');
    const target = await screen.findByLabelText('Existing household target');
    await screen.findByRole('option', { name: /The Morgan household/ });
    await user.selectOptions(target, household.id);
    await waitFor(() => expect(target).toHaveValue(household.id));
    await user.click(screen.getByRole('button', { name: 'Continue to details' }));
    await user.selectOptions(screen.getByLabelText('Attendance for Jordan Morgan'), 'attending');

    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.selectOptions(screen.getByLabelText('Existing household target'), '');
    await user.click(screen.getByRole('button', { name: 'Continue to details' }));
    await user.click(screen.getByRole('button', { name: 'Review guests' }));

    await waitFor(() => expect(previewBody).toBeDefined());
    const body = previewBody as {
      batch: { creates: Array<{ namedInvitees: Array<Record<string, unknown>> }> };
    };
    expect(body.batch.creates[0]?.namedInvitees[0]).toMatchObject({ displayName: 'Jordan Morgan' });
    expect(body.batch.creates[0]?.namedInvitees[0]).not.toHaveProperty('attendance');
  });

  it('does not materialize an append while the selected household detail is still loading', async () => {
    let resolveDetail: ((response: Response) => void) | undefined;
    const delayedDetail = new Promise<Response>((resolve) => { resolveDetail = resolve; });
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = route(input);
      if (url.pathname.endsWith('/summary')) return success(summary);
      if (url.pathname.endsWith('/households')) return success(listPage());
      if (url.pathname.endsWith(`/${household.id}`) && (init?.method ?? 'GET') === 'GET') {
        return delayedDetail;
      }
      throw new Error(`Unexpected request ${url}`);
    }));

    render(<ManagerRsvpPanel event={event} onEventChanged={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add guests' }));
    await user.type(screen.getByLabelText('Guest names or spreadsheet data'), 'Jordan Morgan');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(screen.getByLabelText('Search households'), 'Morgan');
    const target = await screen.findByLabelText('Existing household target');
    await screen.findByRole('option', { name: /The Morgan household/ });
    await user.selectOptions(target, household.id);

    const continueToDetails = screen.getByRole('button', { name: 'Continue to details' });
    expect(continueToDetails).toBeDisabled();
    resolveDetail?.(await success(household));
    await waitFor(() => expect(target).toHaveValue(household.id));
    expect(continueToDetails).toBeEnabled();
    await user.click(continueToDetails);
    expect(await screen.findByRole('heading', { name: 'Add to The Morgan household' })).toBeVisible();
  });

  it('adds plus-one capacity to an explicitly selected household without a dummy guest name', async () => {
    let previewBody: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = route(input);
      if (url.pathname.endsWith('/summary')) return success(summary);
      if (url.pathname.endsWith('/households')) return success(listPage());
      if (url.pathname.endsWith(`/${household.id}`) && (init?.method ?? 'GET') === 'GET') {
        return success(household);
      }
      if (url.pathname.endsWith('/roster/preview')) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        previewBody = body;
        return success({
          canonicalBatch: body.batch,
          rosterVersion: 7,
          targetVersions: [],
          totals: {
            householdsCreated: 0,
            householdsUpdated: 1,
            namedInviteesAdded: 0,
            plusOneCapacityAdded: 1,
            invitedCapacityAdded: 1,
            resultingHouseholds: 1,
            resultingInvitedCapacity: 4,
          },
          issues: [],
          previewDigest: 'plus-one-only',
          canCommit: true,
        });
      }
      throw new Error(`Unexpected request ${url}`);
    }));

    render(<ManagerRsvpPanel event={event} onEventChanged={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add guests' }));
    await user.type(screen.getByLabelText('Search households'), 'Morgan');
    const target = await screen.findByLabelText('Existing household target');
    await screen.findByRole('option', { name: /The Morgan household/ });
    await user.selectOptions(target, household.id);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Continue to details' }));
    await user.clear(screen.getByLabelText('Additional plus-one slots'));
    await user.type(screen.getByLabelText('Additional plus-one slots'), '1');
    await user.selectOptions(await screen.findByLabelText('Attendance for new plus-one 1'), 'declined');
    await user.click(screen.getByRole('button', { name: 'Review guests' }));

    await waitFor(() => expect(previewBody).toBeDefined());
    expect(previewBody).toMatchObject({
      batch: {
        creates: [],
        appends: [expect.objectContaining({
          householdId: household.id,
          namedInvitees: [],
          plusOneSlotsToAdd: 1,
          newPlusOneResponses: [expect.objectContaining({
            attendance: 'declined',
            displayName: null,
          })],
        })],
      },
    });
  });

  it('links a blocking batch issue back to its staged invitation and focuses it', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = route(input);
      if (url.pathname.endsWith('/summary')) return success(summary);
      if (url.pathname.endsWith('/households')) return success({ households: [], nextCursor: null });
      if (url.pathname.endsWith('/roster/preview')) {
        const body = JSON.parse(String(init?.body));
        const create = body.batch.creates[0];
        const invitee = create.namedInvitees[0];
        return success({
          canonicalBatch: body.batch, rosterVersion: 7, targetVersions: [],
          totals: { householdsCreated: 1, householdsUpdated: 0, namedInviteesAdded: 1, plusOneCapacityAdded: 0, invitedCapacityAdded: 1, resultingHouseholds: 1, resultingInvitedCapacity: 1 },
          issues: [{
            clientHouseholdId: create.clientHouseholdId,
            clientInviteeId: invitee.clientInviteeId,
            field: 'namedInvitees.displayName',
            code: 'invitee_name_invalid',
            message: '<script>Choose a valid guest name.</script>',
            severity: 'blocking',
          }],
          previewDigest: 'bad-preview', canCommit: false,
        });
      }
      throw new Error(`Unexpected request ${url}`);
    }));

    render(<ManagerRsvpPanel event={event} onEventChanged={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add guests' }));
    await user.type(screen.getByLabelText('Guest names or spreadsheet data'), 'Taylor Morgan');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Continue to details' }));
    await user.click(screen.getByRole('button', { name: 'Review guests' }));

    const issue = await screen.findByRole('link', { name: /Choose a valid guest name/ });
    expect(issue).toHaveFocus();
    expect(issue.querySelector('script')).toBeNull();
    await user.click(issue);
    const field = await screen.findByLabelText('Guest name');
    await waitFor(() => expect(field.closest('label')).toHaveFocus());
    expect(screen.getByRole('region', { name: 'Guest list review issues' })).toBeVisible();
    expect(screen.getByRole('link', { name: /Choose a valid guest name/ })).toBeVisible();
    await user.clear(field);
    await user.type(field, 'Taylor M. Morgan');
    expect(field).toHaveValue('Taylor M. Morgan');
  });

  it('returns supplied-key issues to the structured mapping control that can remove the key', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = route(input);
      if (url.pathname.endsWith('/summary')) return success(summary);
      if (url.pathname.endsWith('/households')) return success({ households: [], nextCursor: null });
      if (url.pathname.endsWith('/roster/preview')) {
        const body = JSON.parse(String(init?.body));
        return success({
          canonicalBatch: body.batch,
          rosterVersion: 7,
          targetVersions: [],
          totals: { householdsCreated: 1, householdsUpdated: 0, namedInviteesAdded: 1, plusOneCapacityAdded: 0, invitedCapacityAdded: 1, resultingHouseholds: 1, resultingInvitedCapacity: 1 },
          issues: [{
            severity: 'blocking',
            clientHouseholdId: body.batch.creates[0].clientHouseholdId,
            field: 'householdKey.value',
            code: 'household_key_invalid',
            message: 'That household key is not valid.',
          }],
          previewDigest: 'key-issue-preview',
          canCommit: false,
        });
      }
      throw new Error(`Unexpected request ${url}`);
    }));

    render(<ManagerRsvpPanel event={event} onEventChanged={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add guests' }));
    await user.type(
      screen.getByLabelText('Guest names or spreadsheet data'),
      'Guest,Household,Key\nAlex Lee,Lee household,INVALID KEY',
    );
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.selectOptions(screen.getByLabelText(/Guest name \(required\)/), '0');
    await user.selectOptions(screen.getByLabelText('Household'), '1');
    await user.selectOptions(screen.getByLabelText('Household key (advanced)'), '2');
    await user.click(screen.getByRole('button', { name: 'Continue to details' }));
    await user.click(screen.getByRole('button', { name: 'Review guests' }));
    await user.click(await screen.findByRole('link', { name: /household key is not valid/i }));

    expect(screen.getByRole('heading', { name: 'Organize invitations' })).toBeVisible();
    await waitFor(() => expect(screen.getByLabelText('Household key (advanced)')).toHaveFocus());
  });

  it('keeps an uncertain batch key for an unchanged retry instead of duplicating additions', async () => {
    const keys: string[] = [];
    let commits = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = route(input);
      if (url.pathname.endsWith('/summary')) return success(summary);
      if (url.pathname.endsWith('/households')) return success({ households: [], nextCursor: null });
      if (url.pathname.endsWith('/roster/preview')) {
        const body = JSON.parse(String(init?.body));
        return success({
          canonicalBatch: body.batch, rosterVersion: 7, targetVersions: [],
          totals: { householdsCreated: 1, householdsUpdated: 0, namedInviteesAdded: 1, plusOneCapacityAdded: 0, invitedCapacityAdded: 1, resultingHouseholds: 1, resultingInvitedCapacity: 1 },
          issues: [], previewDigest: 'retry-preview', canCommit: true,
        });
      }
      if (url.pathname.endsWith('/roster/commit')) {
        const body = JSON.parse(String(init?.body));
        keys.push(body.idempotencyKey);
        commits += 1;
        if (commits === 1) return Promise.reject(new TypeError('network lost'));
        return success({
          createdHouseholds: [], updatedHouseholds: [],
          totals: { householdsCreated: 1, householdsUpdated: 0, namedInviteesAdded: 1, plusOneCapacityAdded: 0, invitedCapacityAdded: 1, resultingHouseholds: 1, resultingInvitedCapacity: 1 },
          committedRosterVersion: 8, currentRosterVersion: 8, replayed: true,
        });
      }
      throw new Error(`Unexpected request ${url}`);
    }));

    render(<ManagerRsvpPanel event={event} onEventChanged={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add guests' }));
    await user.type(screen.getByLabelText('Guest names or spreadsheet data'), 'Taylor Morgan');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Continue to details' }));
    await user.click(screen.getByRole('button', { name: 'Review guests' }));
    const commit = await screen.findByRole('button', { name: 'Add 1 guest across 1 household' });
    await user.click(commit);
    expect(await screen.findByRole('alert')).toHaveTextContent('Completion could not be confirmed');
    await user.click(screen.getByRole('button', { name: 'Back to details' }));
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Continue to details' }));
    await user.click(screen.getByRole('button', { name: 'Review guests' }));
    await user.click(await screen.findByRole('button', { name: 'Add 1 guest across 1 household' }));
    await screen.findByText('Guest list updated (retry confirmed).');
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  it('blocks closing or editing the reviewed draft while its commit is in flight', async () => {
    let resolveCommit: ((response: Response) => void) | null = null;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = route(input);
      if (url.pathname.endsWith('/summary')) return success(summary);
      if (url.pathname.endsWith('/households')) return success({ households: [], nextCursor: null });
      if (url.pathname.endsWith('/roster/preview')) {
        const body = JSON.parse(String(init?.body));
        return success({
          canonicalBatch: body.batch, rosterVersion: 7, targetVersions: [],
          totals: { householdsCreated: 1, householdsUpdated: 0, namedInviteesAdded: 1, plusOneCapacityAdded: 0, invitedCapacityAdded: 1, resultingHouseholds: 1, resultingInvitedCapacity: 1 },
          issues: [], previewDigest: 'commit-pending-preview', canCommit: true,
        });
      }
      if (url.pathname.endsWith('/roster/commit')) {
        return new Promise<Response>((resolve) => { resolveCommit = resolve; });
      }
      throw new Error(`Unexpected request ${url}`);
    }));

    render(<ManagerRsvpPanel event={event} onEventChanged={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add guests' }));
    await user.type(screen.getByLabelText('Guest names or spreadsheet data'), 'Taylor Morgan');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Continue to details' }));
    await user.click(screen.getByRole('button', { name: 'Review guests' }));
    await user.click(await screen.findByRole('button', { name: 'Add 1 guest across 1 household' }));
    await waitFor(() => expect(resolveCommit).not.toBeNull());

    expect(screen.getByRole('button', { name: 'Back to details' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();

    resolveCommit!(await success({
      createdHouseholds: [], updatedHouseholds: [],
      totals: { householdsCreated: 1, householdsUpdated: 0, namedInviteesAdded: 1, plusOneCapacityAdded: 0, invitedCapacityAdded: 1, resultingHouseholds: 1, resultingInvitedCapacity: 1 },
      committedRosterVersion: 8, currentRosterVersion: 8, replayed: false,
    }, 201));
    expect(await screen.findByRole('heading', { name: 'Guests added' })).toBeVisible();
  });

  it('adopts a refused batch roster version and re-previews staged additions instead of looping stale', async () => {
    const versions: number[] = [];
    let previewCount = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = route(input);
      if (url.pathname.endsWith('/summary')) return success(summary);
      if (url.pathname.endsWith('/households')) return success({ households: [], nextCursor: null });
      if (url.pathname.endsWith('/roster/preview')) {
        const body = JSON.parse(String(init?.body));
        versions.push(body.expectedRosterVersion);
        previewCount += 1;
        return success({
          canonicalBatch: body.batch, rosterVersion: body.expectedRosterVersion, targetVersions: [],
          totals: { householdsCreated: 1, householdsUpdated: 0, namedInviteesAdded: 1, plusOneCapacityAdded: 0, invitedCapacityAdded: 1, resultingHouseholds: 1, resultingInvitedCapacity: 1 },
          issues: [], previewDigest: `preview-${previewCount}`, canCommit: true,
        });
      }
      if (url.pathname.endsWith('/roster/commit')) {
        return Promise.resolve(new Response(JSON.stringify({
          code: 'RSVP_ROSTER_BATCH_CONFLICT',
          message: 'The roster changed while this batch was open.',
          details: { currentRosterVersion: 9, targets: [] },
          requestId: 'request-a',
        }), { status: 409, headers: { 'content-type': 'application/json' } }));
      }
      throw new Error(`Unexpected request ${url}`);
    }));

    render(<ManagerRsvpPanel event={event} onEventChanged={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add guests' }));
    await user.type(screen.getByLabelText('Guest names or spreadsheet data'), 'Taylor Morgan');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Continue to details' }));
    await user.click(screen.getByRole('button', { name: 'Review guests' }));
    await user.click(await screen.findByRole('button', { name: 'Add 1 guest across 1 household' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('roster changed');
    await user.click(screen.getByRole('button', { name: 'Review guests' }));
    await waitFor(() => expect(versions).toEqual([7, 9]));
  });

  it('adopts an authoritative preview roster version before asking for another preview', async () => {
    const versions: number[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = route(input);
      if (url.pathname.endsWith('/summary')) return success(summary);
      if (url.pathname.endsWith('/households')) return success({ households: [], nextCursor: null });
      if (url.pathname.endsWith('/roster/preview')) {
        const body = JSON.parse(String(init?.body));
        versions.push(body.expectedRosterVersion);
        return success({
          canonicalBatch: body.batch,
          rosterVersion: versions.length === 1 ? 8 : body.expectedRosterVersion,
          targetVersions: [],
          totals: { householdsCreated: 1, householdsUpdated: 0, namedInviteesAdded: 1, plusOneCapacityAdded: 0, invitedCapacityAdded: 1, resultingHouseholds: 1, resultingInvitedCapacity: 1 },
          issues: versions.length === 1 ? [{
            severity: 'blocking',
            field: 'expectedRosterVersion',
            code: 'target_household_version_changed',
            message: 'The guest list changed since this batch was started.',
          }] : [],
          previewDigest: `preview-${versions.length}`,
          canCommit: versions.length > 1,
        });
      }
      throw new Error(`Unexpected request ${url}`);
    }));

    render(<ManagerRsvpPanel event={event} onEventChanged={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add guests' }));
    await user.type(screen.getByLabelText('Guest names or spreadsheet data'), 'Taylor Morgan');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Continue to details' }));
    await user.click(screen.getByRole('button', { name: 'Review guests' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('guest list changed');
    expect(screen.getByRole('heading', { name: 'Invitation details' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Review guests' }));
    await waitFor(() => expect(versions).toEqual([7, 8]));
  });

  it('refreshes an authoritative preview target version before re-previewing an append', async () => {
    const rosterVersions: number[] = [];
    const householdVersions: number[] = [];
    let previewCount = 0;
    let detailLoads = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = route(input);
      if (url.pathname.endsWith('/summary')) return success(summary);
      if (url.pathname.endsWith('/households')) return success(listPage());
      if (url.pathname.endsWith(`/${household.id}`) && (init?.method ?? 'GET') === 'GET') {
        detailLoads += 1;
        return success(detailLoads === 1 ? household : { ...household, version: 5 });
      }
      if (url.pathname.endsWith('/roster/preview')) {
        const body = JSON.parse(String(init?.body));
        const append = body.batch.appends[0];
        rosterVersions.push(body.expectedRosterVersion);
        householdVersions.push(append.expectedHouseholdVersion);
        previewCount += 1;
        return success({
          canonicalBatch: body.batch,
          rosterVersion: 8,
          targetVersions: [{
            clientHouseholdId: append.clientHouseholdId,
            householdId: household.id,
            version: 5,
          }],
          totals: { householdsCreated: 0, householdsUpdated: 1, namedInviteesAdded: 1, plusOneCapacityAdded: 0, invitedCapacityAdded: 1, resultingHouseholds: 1, resultingInvitedCapacity: 4 },
          issues: previewCount === 1 ? [{
            severity: 'blocking',
            clientHouseholdId: append.clientHouseholdId,
            field: 'expectedHouseholdVersion',
            code: 'target_household_version_changed',
            message: 'This household changed since it was selected.',
          }] : [],
          previewDigest: `target-preview-${previewCount}`,
          canCommit: previewCount > 1,
        });
      }
      throw new Error(`Unexpected request ${url}`);
    }));

    render(<ManagerRsvpPanel event={event} onEventChanged={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add guests' }));
    await user.type(screen.getByLabelText('Search households'), 'Morgan');
    await screen.findByRole('option', { name: /The Morgan household/ });
    await user.selectOptions(screen.getByLabelText('Existing household target'), household.id);
    await user.type(screen.getByLabelText('Guest names or spreadsheet data'), 'Added Guest');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Continue to details' }));
    await user.selectOptions(screen.getByLabelText('Attendance for Added Guest'), 'declined');
    await user.click(screen.getByRole('button', { name: 'Review guests' }));

    expect(await screen.findByText(/A selected household changed/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Accept current household and review again' }));
    await user.click(screen.getByRole('button', { name: 'Review guests' }));
    await waitFor(() => {
      expect(rosterVersions).toEqual([7, 8]);
      expect(householdVersions).toEqual([4, 5]);
    });
  });

  it('does not adopt a stale conflict refresh after the staged invitation changes', async () => {
    let detailLoads = 0;
    let resolveConflictTarget: ((response: Response) => void) | null = null;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = route(input);
      if (url.pathname.endsWith('/summary')) return success(summary);
      if (url.pathname.endsWith('/households')) return success(listPage());
      if (url.pathname.endsWith(`/${household.id}`) && (init?.method ?? 'GET') === 'GET') {
        detailLoads += 1;
        if (detailLoads === 1) return success(household);
        return new Promise<Response>((resolve) => { resolveConflictTarget = resolve; });
      }
      if (url.pathname.endsWith('/roster/preview')) {
        const body = JSON.parse(String(init?.body));
        const append = body.batch.appends[0];
        return success({
          canonicalBatch: body.batch,
          rosterVersion: 8,
          targetVersions: [{
            clientHouseholdId: append.clientHouseholdId,
            householdId: household.id,
            version: 5,
          }],
          totals: { householdsCreated: 0, householdsUpdated: 1, namedInviteesAdded: 1, plusOneCapacityAdded: 0, invitedCapacityAdded: 1, resultingHouseholds: 1, resultingInvitedCapacity: 4 },
          issues: [{
            severity: 'blocking',
            clientHouseholdId: append.clientHouseholdId,
            field: 'expectedHouseholdVersion',
            code: 'target_household_version_changed',
            message: 'This household changed since it was selected.',
          }],
          previewDigest: 'stale-target-preview',
          canCommit: false,
        });
      }
      throw new Error(`Unexpected request ${url}`);
    }));

    render(<ManagerRsvpPanel event={event} onEventChanged={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add guests' }));
    await user.type(screen.getByLabelText('Search households'), 'Morgan');
    await screen.findByRole('option', { name: /The Morgan household/ });
    await user.selectOptions(screen.getByLabelText('Existing household target'), household.id);
    await user.type(screen.getByLabelText('Guest names or spreadsheet data'), 'Added Guest');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Continue to details' }));
    await user.selectOptions(screen.getByLabelText('Attendance for Added Guest'), 'declined');
    await user.click(screen.getByRole('button', { name: 'Review guests' }));
    await waitFor(() => expect(resolveConflictTarget).not.toBeNull());

    const guestName = screen.getByLabelText('Guest name');
    await user.clear(guestName);
    await user.type(guestName, 'Newer Guest');
    resolveConflictTarget!(await success({
      ...household,
      label: 'Stale refreshed household',
      version: 5,
    }));

    await waitFor(() => expect(guestName).toHaveValue('Newer Guest'));
    expect(screen.getByRole('heading', { name: 'Add to The Morgan household' })).toBeVisible();
    expect(screen.queryByText('Stale refreshed household')).not.toBeInTheDocument();
  });

  it('adds required plus-one attendance rows when a conflict refresh finds that the target responded', async () => {
    const awaitingTarget: RsvpHouseholdDetail = {
      ...household,
      invitees: household.invitees.map((invitee) => ({ ...invitee, attendance: 'pending' as const })),
      firstRespondedAt: null,
      latestRespondedAt: null,
      latestActor: null,
    };
    let detailLoads = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = route(input);
      if (url.pathname.endsWith('/summary')) return success(summary);
      if (url.pathname.endsWith('/households')) return success(listPage());
      if (url.pathname.endsWith(`/${household.id}`) && (init?.method ?? 'GET') === 'GET') {
        detailLoads += 1;
        return success(detailLoads === 1 ? awaitingTarget : { ...household, version: 5 });
      }
      if (url.pathname.endsWith('/roster/preview')) {
        const body = JSON.parse(String(init?.body));
        return success({
          canonicalBatch: body.batch,
          rosterVersion: 7,
          targetVersions: [{ clientHouseholdId: body.batch.appends[0].clientHouseholdId, householdId: household.id, version: 4 }],
          totals: { householdsCreated: 0, householdsUpdated: 1, namedInviteesAdded: 0, plusOneCapacityAdded: 1, invitedCapacityAdded: 1, resultingHouseholds: 1, resultingInvitedCapacity: 4 },
          issues: [],
          previewDigest: 'newly-responded-preview',
          canCommit: true,
        });
      }
      if (url.pathname.endsWith('/roster/commit')) {
        const body = JSON.parse(String(init?.body));
        return Promise.resolve(new Response(JSON.stringify({
          code: 'RSVP_ROSTER_BATCH_CONFLICT',
          message: 'The selected household changed.',
          details: {
            currentRosterVersion: 8,
            targets: [{
              clientHouseholdId: body.canonicalBatch.appends[0].clientHouseholdId,
              householdId: household.id,
              currentHouseholdVersion: 5,
              state: 'changed',
            }],
          },
          requestId: 'request-a',
        }), { status: 409, headers: { 'content-type': 'application/json' } }));
      }
      throw new Error(`Unexpected request ${url}`);
    }));

    render(<ManagerRsvpPanel event={event} onEventChanged={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add guests' }));
    await user.type(screen.getByLabelText('Search households'), 'Morgan');
    const target = await screen.findByLabelText('Existing household target');
    await screen.findByRole('option', { name: /The Morgan household/ });
    await user.selectOptions(target, household.id);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Continue to details' }));
    await user.clear(screen.getByLabelText('Additional plus-one slots'));
    await user.type(screen.getByLabelText('Additional plus-one slots'), '1');
    await user.click(screen.getByRole('button', { name: 'Review guests' }));
    await user.click(await screen.findByRole('button', { name: 'Add 1 guest across 1 household' }));

    expect(await screen.findByText(/selected household changed/u)).toBeVisible();
    expect(await screen.findByLabelText('Attendance for new plus-one 1')).toBeVisible();
  });

  it('preserves readable malformed file source and accepts the same file name after correction', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = route(input);
      if (url.pathname.endsWith('/summary')) return success(summary);
      if (url.pathname.endsWith('/households')) return success({ households: [], nextCursor: null });
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<ManagerRsvpPanel event={event} onEventChanged={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add guests' }));
    const file = screen.getByLabelText('Choose guest-list file');
    await user.upload(file, new File(['Name\n"Taylor'], 'guests.csv', { type: 'text/csv' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('unclosed quoted value');
    expect(screen.getByLabelText('Guest names or spreadsheet data')).toHaveValue('Name\n"Taylor');

    await user.upload(file, new File(['Taylor Morgan'], 'guests.csv', { type: 'text/csv' }));
    await waitFor(() => expect(screen.queryByText(/unclosed quoted value/u)).not.toBeInTheDocument());
    expect(screen.getByLabelText('Guest names or spreadsheet data')).toHaveValue('Taylor Morgan');
  });

  it('accepts a dropped TSV source through the same capture parser', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = route(input);
      if (url.pathname.endsWith('/summary')) return success(summary);
      if (url.pathname.endsWith('/households')) return success({ households: [], nextCursor: null });
      throw new Error(`Unexpected request ${url}`);
    }));

    render(<ManagerRsvpPanel event={event} onEventChanged={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add guests' }));
    fireEvent.drop(screen.getByRole('group', { name: 'Guest-list file drop zone' }), {
      dataTransfer: {
        files: [new File(['Guest\tHousehold\nTaylor Morgan\tMorgan'], 'guests.tsv', {
          type: 'text/tab-separated-values',
        })],
      },
    });

    await waitFor(() => expect(screen.getByLabelText('Guest names or spreadsheet data'))
      .toHaveValue('Guest\tHousehold\nTaylor Morgan\tMorgan'));
    expect(screen.getByText(/Detected:/)).toHaveTextContent('structured data');
  });

  it('clears the advanced key mapping when Household is unmapped', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = route(input);
      if (url.pathname.endsWith('/summary')) return success(summary);
      if (url.pathname.endsWith('/households')) return success({ households: [], nextCursor: null });
      throw new Error(`Unexpected request ${url}`);
    }));

    render(<ManagerRsvpPanel event={event} onEventChanged={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add guests' }));
    await user.type(
      screen.getByLabelText('Guest names or spreadsheet data'),
      'Guest,Household,Key\nAlex Lee,Lee household,lee-family',
    );
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(screen.getByLabelText('Household key (advanced)')).toHaveValue('2');
    await user.selectOptions(screen.getByLabelText('Household'), '');
    expect(screen.getByLabelText('Household key (advanced)')).toHaveValue('');
    expect(screen.getByLabelText('Household key (advanced)')).toBeDisabled();
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

  it('keeps archived history instead of restoring pristine setup after the last active household is archived', async () => {
    let archived = false;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = route(input);
      if (url.pathname.endsWith('/summary')) return success(archived ? emptySummary : summary);
      if (url.pathname.endsWith('/households') && url.searchParams.get('state') === 'archived') {
        return success({ households: [], nextCursor: null });
      }
      if (url.pathname.endsWith('/households')) {
        return success(archived ? { households: [], nextCursor: null } : listPage());
      }
      if (url.pathname.endsWith(`/${household.id}`) && (init?.method ?? 'GET') === 'GET') {
        return success(household);
      }
      if (url.pathname.endsWith('/archive') && init?.method === 'POST') {
        archived = true;
        return success({
          household: { ...household, version: 5, archivedAt: '2026-08-03T00:00:00Z' },
          rosterVersion: 8,
        });
      }
      throw new Error(`Unexpected request ${url}`);
    }));

    render(<ManagerRsvpPanel event={event} onEventChanged={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /The Morgan household/ }));
    await user.click(screen.getByRole('button', { name: 'Archive household' }));
    const confirmation = screen.getByRole('group', { name: 'Archive The Morgan household' });
    await user.type(within(confirmation).getByLabelText('Type household name'), household.label);
    await user.click(within(confirmation).getByRole('button', { name: 'Archive The Morgan household' }));

    expect(await screen.findByText('Archived')).toBeVisible();
    await waitFor(() => expect(screen.queryByRole('button', { name: /The Morgan household/ })).not.toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: 'Start your guest list' })).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Invited capacity' })).toBeVisible();
  });

  // The create form is the one mutation that does not run through the shared
  // household-write path, so its conflict recovery has to be proved separately:
  // without a resync the host retries the same stale version forever.
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

  // These retain the former setup-path regression cases at the public panel
  // boundary. The unified launcher replaces the retired manual/CSV controls.
  it('reads a guest-list source only after the host opens the launcher', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = route(input);
      if (url.pathname.endsWith('/summary')) return success(summary);
      if (url.pathname.endsWith('/households')) return success({ households: [], nextCursor: null });
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<ManagerRsvpPanel event={event} onEventChanged={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Add guests' })).toBeVisible();
    expect(screen.queryByLabelText('Guest names or spreadsheet data')).not.toBeInTheDocument();
  });

  it('withholds review until an ambiguous source format is chosen', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = route(input);
      if (url.pathname.endsWith('/summary')) return success(summary);
      if (url.pathname.endsWith('/households')) return success({ households: [], nextCursor: null });
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<ManagerRsvpPanel event={event} onEventChanged={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add guests' }));
    await user.type(screen.getByLabelText('Guest names or spreadsheet data'), 'Taylor\nA,B');
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  it('keeps the universal add-guests action after a roster exists', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = route(input);
      if (url.pathname.endsWith('/summary')) return success(summary);
      if (url.pathname.endsWith('/households')) return success(listPage());
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<ManagerRsvpPanel event={event} onEventChanged={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Add guests' })).toBeVisible();
  });

  it('does not expose retired manual household setup controls', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = route(input);
      if (url.pathname.endsWith('/summary')) return success(summary);
      if (url.pathname.endsWith('/households')) return success({ households: [], nextCursor: null });
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<ManagerRsvpPanel event={event} onEventChanged={vi.fn()} />);
    await screen.findByRole('heading', { name: 'Guest list and RSVPs' });
    expect(screen.queryByRole('button', { name: 'Add household' })).not.toBeInTheDocument();
  });

  it('keeps roster corrections separate from staged additions', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = route(input);
      if (url.pathname.endsWith('/summary')) return success(summary);
      if (url.pathname.endsWith('/households')) return success(listPage());
      if (url.pathname.endsWith(`/${household.id}`)) return success(household);
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<ManagerRsvpPanel event={event} onEventChanged={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /The Morgan household/ }));
    expect(await screen.findByRole('button', { name: 'Save household' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Create household' })).not.toBeInTheDocument();
  });
});

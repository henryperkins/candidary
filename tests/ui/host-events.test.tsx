import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAppRouter } from '../../src/app/router';

interface EventFixture {
  id: string;
  name: string;
  slug: string;
  eventDate: string;
  eventTimezone: string;
  storedMediaCount: number;
  managementAccessExpiresAt: string;
}

const EVENTS: EventFixture[] = [
  {
    id: 'event-later',
    name: 'River Dinner',
    slug: 'river-dinner',
    eventDate: '2027-01-02',
    eventTimezone: 'Pacific/Auckland',
    storedMediaCount: 40,
    managementAccessExpiresAt: '2027-01-03T10:30:00.000Z',
  },
  {
    id: 'event-tie-first',
    name: 'LUCIA Reception',
    slug: 'lucia-reception',
    eventDate: '2026-09-19',
    eventTimezone: 'America/Los_Angeles',
    storedMediaCount: 12,
    managementAccessExpiresAt: '2026-09-20T00:30:00.000Z',
  },
  {
    id: 'event-tie-second',
    name: 'Maya & Theo',
    slug: 'maya-theo',
    eventDate: '2026-09-19',
    eventTimezone: 'Asia/Kolkata',
    storedMediaCount: 8,
    managementAccessExpiresAt: '2026-09-20T00:30:00.000Z',
  },
  {
    id: 'event-earlier',
    name: 'Garden Lunch',
    slug: 'garden-lunch',
    eventDate: '2025-06-01',
    eventTimezone: 'Europe/London',
    storedMediaCount: 3,
    managementAccessExpiresAt: '2025-06-01T23:30:00.000Z',
  },
];

function json(data: unknown): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify({ data, requestId: 'request-events' }), {
    headers: { 'content-type': 'application/json' },
  }));
}

function session(events: EventFixture[] = EVENTS) {
  return {
    account: {
      id: 'account-a',
      email: 'host@example.com',
      displayName: null,
      emailVerified: true,
      notificationsEnabled: true,
    },
    events,
  };
}

function eventNames(): string[] {
  return screen.getAllByRole('listitem').map((item) => within(item).getByRole('link').textContent ?? '');
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Host Events dashboard', () => {
  it('uses the date-only formatter and each event zone for its management-expiry instant', async () => {
    const chicagoBoundary = {
      ...EVENTS[1]!,
      eventDate: '2026-03-07',
      eventTimezone: 'America/Chicago',
      managementAccessExpiresAt: '2026-03-08T05:30:00.000Z',
    };
    vi.stubGlobal('fetch', vi.fn(() => json(session([chicagoBoundary]))));

    render(<RouterProvider router={createAppRouter(['/host/events'])} />);

    expect(await screen.findByText('March 7, 2026')).toBeVisible();
    expect(screen.getByText(/Manage and export until/)).toHaveTextContent(
      'Manage and export until March 7, 2026 at 11:30 PM CST',
    );
    // The former hard-coded UTC formatter said the next day instead.
    expect(screen.queryByText(/March 8, 2026 at 5:30 AM UTC/)).not.toBeInTheDocument();
  });

  it('searches loaded names case-insensitively and announces the local result count', async () => {
    const fetchMock = vi.fn(() => json(session()));
    vi.stubGlobal('fetch', fetchMock);
    render(<RouterProvider router={createAppRouter(['/host/events'])} />);
    const user = userEvent.setup();

    await screen.findByRole('heading', { name: 'Your events' });
    expect(screen.getByRole('status')).toHaveTextContent('4 events');

    await user.type(screen.getByRole('searchbox', { name: 'Search events' }), 'lucia');

    expect(screen.getByRole('status')).toHaveTextContent('1 event');
    expect(eventNames()).toEqual([expect.stringContaining('LUCIA Reception')]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('round-trips newest and oldest while preserving loaded order for equal dates', async () => {
    vi.stubGlobal('fetch', vi.fn(() => json(session())));
    render(<RouterProvider router={createAppRouter(['/host/events'])} />);
    const user = userEvent.setup();
    const expectedNewest = ['River Dinner', 'LUCIA Reception', 'Maya & Theo', 'Garden Lunch'];
    const expectedOldest = ['Garden Lunch', 'LUCIA Reception', 'Maya & Theo', 'River Dinner'];

    await screen.findByRole('heading', { name: 'Your events' });
    expect(eventNames()).toEqual(expectedNewest.map((name) => expect.stringContaining(name)));

    await user.selectOptions(screen.getByRole('combobox', { name: 'Sort events' }), 'oldest');
    expect(eventNames()).toEqual(expectedOldest.map((name) => expect.stringContaining(name)));

    await user.selectOptions(screen.getByRole('combobox', { name: 'Sort events' }), 'newest');
    expect(eventNames()).toEqual(expectedNewest.map((name) => expect.stringContaining(name)));
  });

  it('makes Create event a primary keyboard-reachable link', async () => {
    vi.stubGlobal('fetch', vi.fn(() => json(session([]))));
    const router = createAppRouter(['/host/events']);
    render(<RouterProvider router={router} />);
    const user = userEvent.setup();

    await screen.findByRole('heading', { name: 'Your events' });
    const create = screen.getByRole('link', { name: 'Create event' });
    expect(create).toHaveClass('button--primary');

    await user.tab();
    expect(screen.getByRole('link', { name: 'Candidary home' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Sign out' })).toHaveFocus();
    await user.tab();
    expect(create).toHaveFocus();
    await user.keyboard('{Enter}');

    await waitFor(() => expect(router.state.location.pathname).toBe('/create'));
  });
});

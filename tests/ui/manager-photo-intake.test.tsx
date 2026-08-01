import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(() => Promise.resolve('data:image/png;base64,x')) } }));

import type { EventView } from '../../shared/contracts';
import { resolveEventTheme } from '../../shared/event-theme';
import { createAppRouter } from '../../src/app/router';

function json(data: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify({ data, requestId: 'request-a' }), {
    status, headers: { 'content-type': 'application/json' },
  }));
}

// Permitted, and still short of its opening: the state the schedule moves out of
// on its own, with no host action on the day of the event.
const SCHEDULED: EventView = {
  id: 'event-a', slug: 'maya-theo', name: 'Maya & Theo', eventDate: '2026-09-19',
  welcomeMessage: 'Welcome.', coverObjectKey: null,
  uploadsEnabled: true, galleryVisible: true, moderationRequired: true,
  reservedMediaCount: 0, storedMediaCount: 3, reservedBytes: 0, storedBytes: 128,
  guestAccessExpiresAt: '2026-10-19T00:00:00Z', managementAccessExpiresAt: '2026-10-19T00:00:00Z',
  purgeAfter: '2026-12-19T00:00:00Z', createdAt: '2026-07-29T00:00:00Z', deletedAt: null,
  eventTimezone: 'America/Chicago',
  eventStartAt: '2026-09-19T22:00:00.000Z', eventStartTime: '17:00',
  photosOpen: false, photoIntakeState: 'scheduled', photoIntakeRecheckAfterMs: 60_000,
  rsvpEnabled: false,
  rsvpDeadlineAt: '2026-09-05T04:59:59.999Z', rsvpDeadlineDate: '2026-09-04',
  rsvpRosterVersion: 7,
  theme: resolveEventTheme({ version: 1, presetId: 'candidary-default', overrides: {} }),
};

// The same row after its own start, with no boundary left to wake for.
const OPEN: EventView = {
  ...SCHEDULED,
  photosOpen: true, photoIntakeState: 'open', photoIntakeRecheckAfterMs: null,
};

function managerFetch(events: readonly EventView[]) {
  let eventReads = 0;
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/api/manage/events/event-a')) {
      const answered = events[Math.min(eventReads, events.length - 1)]!;
      eventReads += 1;
      return json({ event: answered });
    }
    if (url.includes('/media')) return json({ media: [], nextCursor: null });
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

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('manager photo delivery', () => {
  /* The manager page is left open across the event's own start. Nothing here compares a
     clock: the server sent the delay with the view it resolved, and the refetch it arms is
     the only thing that moves the status and the action the host is offered. */
  it('moves its status and its action across the start from the server-sent delay alone', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = managerFetch([SCHEDULED, OPEN]);
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await openSettings(user);

    expect(screen.getByText('Guest uploads scheduled')).toBeVisible();
    expect(screen.getByText('Photo delivery opens when the event starts.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Open photo delivery now' })).toBeVisible();
    const readsBeforeStart = fetchMock.mock.calls
      .filter(([input]) => String(input).endsWith('/api/manage/events/event-a')).length;

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

    // The host touched nothing between these two states.
    expect(screen.getByText('Guest uploads open')).toBeVisible();
    expect(screen.getByText('Photo delivery is open.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Pause photo delivery' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Open photo delivery now' })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls
      .filter(([input]) => String(input).endsWith('/api/manage/events/event-a')))
      .toHaveLength(readsBeforeStart + 1);
  });
});

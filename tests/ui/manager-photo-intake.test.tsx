import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(() => Promise.resolve('data:image/png;base64,x')) } }));

import type { EventView } from '../../shared/contracts';
import { resolveEventTheme } from '../../shared/event-theme';
import { createAppRouter } from '../../src/app/router';
import type { LifecycleRecheckOutcome } from '../../src/features/guest/useLifecycleRecheck';
import { useLifecycleRecheck } from '../../src/features/guest/useLifecycleRecheck';

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

function LifecycleHarness({
  onRecheck,
}: {
  onRecheck: () => Promise<LifecycleRecheckOutcome>;
}) {
  useLifecycleRecheck(10_000, onRecheck);
  return null;
}

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('manager photo delivery', () => {
  it('cancels both the original boundary and a wake retry when it unmounts', async () => {
    vi.useFakeTimers();
    const onRecheck = vi.fn(async (): Promise<LifecycleRecheckOutcome> => 'unchanged');
    const view = render(<LifecycleHarness onRecheck={onRecheck} />);

    await act(async () => {
      window.dispatchEvent(new Event('pageshow'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onRecheck).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(2);

    view.unmount();

    expect(vi.getTimerCount()).toBe(0);
  });

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

  it('keeps the anti-spin floor when wake responses only shorten the relative delay', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = managerFetch([
      SCHEDULED,
      { ...SCHEDULED, photoIntakeRecheckAfterMs: 50_000 },
    ]);
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await openSettings(user);

    await act(async () => {
      window.dispatchEvent(new Event('pageshow'));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      window.dispatchEvent(new Event('pageshow'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock.mock.calls
      .filter(([input]) => String(input).endsWith('/api/manage/events/event-a')))
      .toHaveLength(2);
    expect(screen.getByText('Photo delivery opens when the event starts.')).toBeVisible();
  });

  it('installs a moved absolute start and its new timer while intake state is unchanged', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const movedStart = {
      ...SCHEDULED,
      eventStartAt: '2026-09-19T23:00:00.000Z',
      eventStartTime: '18:00',
      photoIntakeRecheckAfterMs: 1_000,
    };
    const openAtMovedStart = {
      ...movedStart,
      photosOpen: true,
      photoIntakeState: 'open' as const,
      photoIntakeRecheckAfterMs: null,
    };
    const fetchMock = managerFetch([SCHEDULED, movedStart, openAtMovedStart]);
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await openSettings(user);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });

    expect(screen.getByText(/Photo delivery opens September 19, 2026 at 5:00 PM/u)).toBeVisible();
    await act(async () => { window.dispatchEvent(new Event('pageshow')); });

    expect(await screen.findByText(/Photo delivery opens September 19, 2026 at 6:00 PM/u)).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

    expect(screen.getByText('Photo delivery is open.')).toBeVisible();
    expect(fetchMock.mock.calls
      .filter(([input]) => String(input).endsWith('/api/manage/events/event-a')))
      .toHaveLength(3);
  });

  it("keeps a second manager's schedule through lifecycle rebase and a later name save", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const remotelyMoved: EventView = {
      ...SCHEDULED,
      name: 'Remote rename outside lifecycle ownership',
      welcomeMessage: 'Remote welcome outside lifecycle ownership.',
      eventTimezone: 'America/Los_Angeles',
      eventStartAt: '2026-09-20T01:30:00.000Z',
      eventStartTime: '18:30',
      rsvpDeadlineAt: '2026-09-06T06:59:59.999Z',
      rsvpDeadlineDate: '2026-09-05',
      // The absolute boundary changed, but an equal numeric delay is possible
      // and must still replace the timer retired by the lifecycle wake.
      photoIntakeRecheckAfterMs: 60_000,
    };
    const openedAtMovedSchedule: EventView = {
      ...remotelyMoved,
      name: 'Local reception',
      welcomeMessage: SCHEDULED.welcomeMessage,
      photosOpen: true,
      photoIntakeState: 'open',
      photoIntakeRecheckAfterMs: null,
    };
    const fallback = managerFetch([SCHEDULED]);
    const settingsWrites: Array<Record<string, unknown>> = [];
    let eventReads = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/api/manage/events/event-a') && method === 'GET') {
        const replies = [SCHEDULED, remotelyMoved, openedAtMovedSchedule] as const;
        const event = replies[Math.min(eventReads, replies.length - 1)]!;
        eventReads += 1;
        return json({ event });
      }
      if (url.endsWith('/settings') && method === 'PATCH') {
        const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
        settingsWrites.push(payload);
        return json({
          event: {
            ...remotelyMoved,
            ...payload,
            eventStartAt: remotelyMoved.eventStartAt,
            rsvpDeadlineAt: remotelyMoved.rsvpDeadlineAt,
          },
        });
      }
      return fallback(input);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await openSettings(user);

    expect(screen.getByText(/Photo delivery opens September 19, 2026 at 5:00 PM/u)).toBeVisible();
    await act(async () => { window.dispatchEvent(new Event('pageshow')); });

    expect(await screen.findByText(/Photo delivery opens September 19, 2026 at 6:30 PM/u)).toBeVisible();
    expect(screen.getByLabelText('Event name')).toHaveValue('Maya & Theo');
    expect(screen.getByLabelText('Event time zone')).toHaveValue('America/Los_Angeles');
    expect(screen.getByLabelText('Event start time')).toHaveValue('18:30');
    expect(screen.getByLabelText('RSVP deadline')).toHaveValue('2026-09-05');

    const name = screen.getByLabelText('Event name');
    fireEvent.change(name, { target: { value: 'Local reception' } });
    fireEvent.blur(name);

    await waitFor(() => expect(settingsWrites).toHaveLength(1));
    expect(settingsWrites[0]).toMatchObject({
      name: 'Local reception',
      eventTimezone: 'America/Los_Angeles',
      eventStartTime: '18:30',
      rsvpDeadlineDate: '2026-09-05',
    });
    expect(await screen.findByText('Event settings saved')).toBeVisible();
    expect(screen.getByText(/Photo delivery opens September 19, 2026 at 6:30 PM/u)).toBeVisible();

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

    expect(screen.getByText('Photo delivery is open.')).toBeVisible();
    expect(eventReads).toBe(3);
  });

  it('lets the original boundary fire on time after a just-before-boundary wake no-op', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const nearBoundary = { ...SCHEDULED, photoIntakeRecheckAfterMs: 10_000 };
    const fetchMock = managerFetch([
      nearBoundary,
      { ...nearBoundary, photoIntakeRecheckAfterMs: 1_000 },
      OPEN,
    ]);
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await openSettings(user);
    const eventReads = () => fetchMock.mock.calls
      .filter(([input]) => String(input).endsWith('/api/manage/events/event-a')).length;

    await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
    await act(async () => {
      window.dispatchEvent(new Event('pageshow'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(eventReads()).toBe(2);
    expect(screen.getByText('Photo delivery opens when the event starts.')).toBeVisible();

    // The unchanged wake establishes the 30-second floor, but that floor is
    // for repeat wakes/retries. It must not suppress the timer that was already
    // armed from the server's initial boundary delay.
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });

    expect(eventReads()).toBe(3);
    expect(screen.getByText('Photo delivery is open.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Pause photo delivery' })).toBeVisible();
  });

  it('retires a pending boundary when the in-flight wake already installs the changed state', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const nearBoundary = { ...SCHEDULED, photoIntakeRecheckAfterMs: 10_000 };
    const fallback = managerFetch([nearBoundary]);
    let eventReads = 0;
    let releaseWake: (() => void) | null = null;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/manage/events/event-a')) {
        eventReads += 1;
        if (eventReads === 1) return json({ event: nearBoundary });
        if (eventReads === 2) {
          return new Promise<Response>((resolve) => {
            releaseWake = () => resolve(new Response(JSON.stringify({
              data: { event: OPEN }, requestId: 'request-a',
            }), { status: 200, headers: { 'content-type': 'application/json' } }));
          });
        }
        return json({ event: OPEN });
      }
      return fallback(input);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await openSettings(user);

    await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
    await act(async () => { window.dispatchEvent(new Event('pageshow')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(eventReads).toBe(2);

    releaseWake!();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText('Photo delivery is open.')).toBeVisible();
    expect(eventReads).toBe(2);
  });
});

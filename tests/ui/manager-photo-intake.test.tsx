import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(() => Promise.resolve('data:image/png;base64,x')) } }));

import type { EventView } from '../../shared/contracts';
import { DEFAULT_GUESTBOOK_PROMPT } from '../../shared/constants';
import { resolveEventTheme } from '../../shared/event-theme';
import { createAppRouter } from '../../src/app/router';
import { ManagerPhotoIntakePanel } from '../../src/components/ManagerPhotoIntakePanel';
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
  welcomeMessage: 'Welcome.',
  guestbookPrompt: DEFAULT_GUESTBOOK_PROMPT,
  cover: {
    config: { version: 1, source: { kind: 'none' } }, revision: 0, hasCover: false,
    available2xProfiles: [], surfaceTreatment: 'none', preparation: null,
  },
  uploadsEnabled: true, galleryVisible: true, moderationRequired: true,
  reservedMediaCount: 0, storedMediaCount: 3, reservedBytes: 0, storedBytes: 128, recoverableMediaCount: 0, recoverableBytes: 0,
  hostUploadAvailability: { enabled: true, reason: null },
  guestAccessExpiresAt: '2026-10-19T00:00:00Z', managementAccessExpiresAt: '2026-10-19T00:00:00Z',
  managerLinkRevision: 0,
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
  delayMs = 10_000,
}: {
  onRecheck: () => Promise<LifecycleRecheckOutcome>;
  delayMs?: number | null;
}) {
  useLifecycleRecheck(delayMs, onRecheck);
  return null;
}

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('manager guest uploads', () => {
  it('renders Guest uploads terminology in the Manager state chip for all four states', async () => {
    const cases: Array<{ event: EventView; label: string }> = [
      { event: SCHEDULED, label: 'Guest uploads scheduled' },
      {
        event: {
          ...SCHEDULED,
          photosOpen: true,
          photoIntakeState: 'open-early',
        },
        label: 'Guest uploads open early',
      },
      { event: OPEN, label: 'Guest uploads open' },
      {
        event: {
          ...OPEN,
          uploadsEnabled: false,
          photosOpen: false,
          photoIntakeState: 'paused',
        },
        label: 'Guest uploads paused',
      },
    ];

    for (const { event, label } of cases) {
      vi.stubGlobal('fetch', managerFetch([event]));
      const view = render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
      const heading = await screen.findByRole('heading', { level: 1, name: event.name });
      const header = heading.closest('header');

      expect(header).not.toBeNull();
      expect(within(header!).getByText(label, { exact: true })).toBeVisible();
      expect(header).not.toHaveTextContent(/photo delivery/iu);

      view.unmount();
      vi.unstubAllGlobals();
    }
  });

  it('uses guest-upload copy in every state with exact Pause guest uploads and Resume guest uploads names', () => {
    const cases = [
      {
        state: 'scheduled' as const,
        status: 'Guest uploads open when the event starts.',
        label: 'Open guest uploads now',
      },
      {
        state: 'open-early' as const,
        status: 'Guest uploads are open early.',
        label: 'Return guest uploads to schedule',
      },
      {
        state: 'open' as const,
        status: 'Guest uploads are open.',
        label: 'Pause guest uploads',
      },
      {
        state: 'paused' as const,
        status: 'New guest uploads are paused. Event access, Guestbook, the Guest gallery setting, and Manager uploads are unchanged.',
        label: 'Resume guest uploads',
      },
    ];

    for (const { state, status, label } of cases) {
      const view = render(<ManagerPhotoIntakePanel
        event={{
          ...SCHEDULED,
          uploadsEnabled: state !== 'paused',
          photosOpen: state === 'open' || state === 'open-early',
          photoIntakeState: state,
          photoIntakeRecheckAfterMs: null,
        }}
        entryDisabled={false}
        pending={false}
        onAction={vi.fn()}
      />);
      const panel = screen.getByRole('region', { name: 'Guest uploads' });

      expect(within(panel).getByRole('status')).toHaveTextContent(status);
      expect(within(panel).getByRole('button', { name: label, exact: true })).toBeVisible();
      expect(panel).not.toHaveTextContent(/photo delivery|reopen/iu);

      view.unmount();
    }
  });

  it('rechecks a boundary-free page on every browser wake source without polling', async () => {
    vi.useFakeTimers();
    const onRecheck = vi.fn(async (): Promise<LifecycleRecheckOutcome> => 'unchanged');
    render(<LifecycleHarness delayMs={null} onRecheck={onRecheck} />);

    for (const [target, event] of [
      [document, new Event('visibilitychange')],
      [window, new Event('pageshow')],
      [window, new Event('online')],
      [window, new Event('focus')],
    ] as const) {
      await act(async () => {
        target.dispatchEvent(event);
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    expect(onRecheck).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

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
  it('uses Guest uploads and Delivered photos as a scheduled event opens', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = managerFetch([SCHEDULED, OPEN]);
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    const intakeHeading = await screen.findByRole('heading', { name: 'Live intake' });
    const intakeSection = intakeHeading.closest('section');
    expect(intakeSection).toHaveTextContent('Delivered photos');
    expect(intakeSection).not.toHaveTextContent('Private collection');
    await openSettings(user);

    expect(screen.getByText('Guest uploads scheduled')).toBeVisible();
    expect(screen.getByText('Guest uploads open when the event starts.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Open guest uploads now' })).toBeVisible();
    expect(document.querySelector('.lifecycle')).toHaveTextContent('3 delivered photos');
    const capacity = screen.getByText('Event capacity').closest('section');
    expect(capacity).toHaveTextContent('Delivered photos');
    expect(capacity).not.toHaveTextContent('photos stored');
    const readsBeforeStart = fetchMock.mock.calls
      .filter(([input]) => String(input).endsWith('/api/manage/events/event-a')).length;

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

    // The host touched nothing between these two states.
    expect(screen.getByText('Guest uploads open')).toBeVisible();
    expect(screen.getByText('Guest uploads are open.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Pause guest uploads' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Open guest uploads now' })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls
      .filter(([input]) => String(input).endsWith('/api/manage/events/event-a')))
      .toHaveLength(readsBeforeStart + 1);
  });

  it('ends a paused no-op boundary without entering a retry poll', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const paused = {
      ...SCHEDULED,
      uploadsEnabled: false,
      photoIntakeState: 'paused' as const,
      photoIntakeRecheckAfterMs: 1_000,
    };
    const startedPaused = { ...paused, photoIntakeRecheckAfterMs: null };
    const fetchMock = managerFetch([paused, startedPaused]);
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await openSettings(user);
    const eventReads = () => fetchMock.mock.calls
      .filter(([input]) => String(input).endsWith('/api/manage/events/event-a')).length;

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

    expect(screen.getByRole('button', { name: 'Resume guest uploads' })).toBeVisible();
    expect(eventReads()).toBe(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
    expect(eventReads()).toBe(2);
  });


  it('admits only one explicit transition while its request is pending', async () => {
    const fallback = managerFetch([SCHEDULED]);
    let photoIntakeRequests = 0;
    let finishPhotoIntake!: (response: Response) => void;
    const pendingPhotoIntake = new Promise<Response>((resolve) => {
      finishPhotoIntake = resolve;
    });
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/photo-intake') && init?.method === 'POST') {
        photoIntakeRequests += 1;
        return pendingPhotoIntake;
      }
      return fallback(input);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<RouterProvider router={createAppRouter(['/manage/event/event-a'])} />);
    await openSettings(user);

    const action = screen.getByRole('button', { name: 'Open guest uploads now' });
    fireEvent.click(action);
    fireEvent.click(action);

    expect(photoIntakeRequests).toBe(1);
    expect(action).toBeDisabled();
    expect(screen.getByText('Saving guest uploads…')).toHaveAttribute('role', 'status');

    finishPhotoIntake(await json({
      event: {
        ...SCHEDULED,
        photosOpen: true,
        photoIntakeState: 'open-early',
      },
    }));
    expect(await screen.findByRole('button', { name: 'Return guest uploads to schedule' })).toBeVisible();
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
    expect(screen.getByText('Guest uploads open when the event starts.')).toBeVisible();
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

    expect(screen.getByText(/Event start: September 19, 2026 at 5:00 PM/u)).toBeVisible();
    await act(async () => { window.dispatchEvent(new Event('pageshow')); });

    expect(await screen.findByText(/Event start: September 19, 2026 at 6:00 PM/u)).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

    expect(screen.getByText('Guest uploads are open.')).toBeVisible();
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

    expect(screen.getByText(/Event start: September 19, 2026 at 5:00 PM/u)).toBeVisible();
    await act(async () => { window.dispatchEvent(new Event('pageshow')); });

    expect(await screen.findByText(/Event start: September 19, 2026 at 6:30 PM/u)).toBeVisible();
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
    expect(screen.getByText(/Event start: September 19, 2026 at 6:30 PM/u)).toBeVisible();

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

    expect(screen.getByText('Guest uploads are open.')).toBeVisible();
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
    expect(screen.getByText('Guest uploads open when the event starts.')).toBeVisible();

    // The unchanged wake establishes the 30-second floor, but that floor is
    // for repeat wakes/retries. It must not suppress the timer that was already
    // armed from the server's initial boundary delay.
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });

    expect(eventReads()).toBe(3);
    expect(screen.getByText('Guest uploads are open.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Pause guest uploads' })).toBeVisible();
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

    expect(screen.getByText('Guest uploads are open.')).toBeVisible();
    expect(eventReads).toBe(2);
  });
});

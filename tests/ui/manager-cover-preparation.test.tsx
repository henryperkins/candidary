import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EventCoverPreparationView } from '../../shared/event-cover';
import { ManagerCoverPreparationStatus } from '../../src/components/ManagerCoverPreparationStatus';

function json(data: unknown) {
  return Promise.resolve(new Response(JSON.stringify({ data, requestId: 'request-a' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
}

function preparation(patch: Partial<EventCoverPreparationView> = {}): EventCoverPreparationView {
  return {
    operationId: 'operation-a',
    status: 'preparing',
    completedSteps: 1,
    requiredSteps: 6,
    retryable: false,
    safeFailureCode: null,
    updatedAt: '2026-08-04T00:00:00.000Z',
    ...patch,
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('manager cover preparation status', () => {
  it('renders durable step progress as product copy', () => {
    vi.stubGlobal('fetch', vi.fn());
    render(<ManagerCoverPreparationStatus
      eventId="event-a"
      preparation={preparation({ completedSteps: 1 })}
      onResolved={vi.fn()}
    />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Preparing cover 2 of 6. Your current cover is still live.');
    // `profile` is the implementation's word for a step, and never the host's.
    expect(status.textContent).not.toMatch(/profile/iu);
  });

  it('replaces the copy after sixty seconds without a terminal result', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => json({ operation: preparation() })));
    render(<ManagerCoverPreparationStatus
      eventId="event-a"
      preparation={preparation()}
      onResolved={vi.fn()}
    />);
    expect(screen.getByRole('status')).toHaveTextContent('Preparing cover 2 of 6');

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    // Elapsed time changes the copy and nothing else. It never becomes failure.
    expect(screen.getByRole('status')).toHaveTextContent(
      'Still preparing. Your current cover is safe, and you can close this window.',
    );
  });

  it('resumes from the server-selected operation with no local state', async () => {
    sessionStorage.clear();
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => json({ operation: preparation({ completedSteps: 4 }) }));
    vi.stubGlobal('fetch', fetchMock);
    // Exactly what a reload gives the component: the Manager event read carries
    // the receipt, so nothing depends on session storage having survived.
    render(<ManagerCoverPreparationStatus
      eventId="event-a"
      preparation={preparation({ completedSteps: 2 })}
      onResolved={vi.fn()}
    />);
    expect(screen.getByRole('status')).toHaveTextContent('Preparing cover 3 of 6');

    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    const polled = fetchMock.mock.calls as unknown as Array<[string]>;
    expect(String(polled[0]?.[0]))
      .toBe('/api/manage/events/event-a/cover/publications/operation-a');
    expect(screen.getByRole('status')).toHaveTextContent('Preparing cover 5 of 6');
  });

  it('announces an applied outcome once and asks for a fresh event read', async () => {
    vi.useFakeTimers();
    const onResolved = vi.fn();
    vi.stubGlobal('fetch', vi.fn(() => json({
      operation: preparation({ status: 'applied', completedSteps: 6 }),
    })));
    render(<ManagerCoverPreparationStatus
      eventId="event-a"
      preparation={preparation()}
      onResolved={onResolved}
    />);

    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent('Your new cover is live.');

    // Terminal: polling stops rather than continuing against a settled receipt.
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(onResolved).toHaveBeenCalledTimes(1);
  });

  it('retries with only the operation ID', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(() => json({ operation: preparation({ completedSteps: 0 }) }));
    vi.stubGlobal('fetch', fetchMock);
    render(<ManagerCoverPreparationStatus
      eventId="event-a"
      preparation={preparation({ status: 'retryable-failed', retryable: true, safeFailureCode: 'COVER_RENDER_UNAVAILABLE' })}
      onResolved={vi.fn()}
    />);
    expect(screen.getByRole('status'))
      .toHaveTextContent('That cover could not be prepared. Your current cover is still live.');

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(path))
      .toBe('/api/manage/events/event-a/cover/publications/operation-a/restart');
    // The recipe is pinned on the receipt. Anything else in this body would mean
    // the client had reconstructed it, which a reload makes impossible.
    expect(JSON.parse(String(init.body))).toEqual({});
  });

  it('offers no retry for a permanent failure and can be dismissed', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn());
    render(<ManagerCoverPreparationStatus
      eventId="event-a"
      preparation={preparation({ status: 'permanent-failed', retryable: false, safeFailureCode: 'COVER_OUTPUT_BUDGET_EXHAUSTED' })}
      onResolved={vi.fn()}
    />);
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('choose the photo again');

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('settles a terminal receipt that was already terminal at mount', async () => {
    sessionStorage.setItem('candidary.cover.operation.event-a', 'operation-a');
    const onResolved = vi.fn();
    vi.stubGlobal('fetch', vi.fn());
    render(<ManagerCoverPreparationStatus
      eventId="event-a"
      preparation={preparation({ status: 'applied', completedSteps: 6 })}
      onResolved={onResolved}
    />);

    // A reload during preparation lands here: the receipt is already terminal,
    // so no poll ever runs. The operation must still be released, or the next
    // cover change reuses its ID with different bytes and 409s forever.
    await waitFor(() => expect(sessionStorage.getItem('candidary.cover.operation.event-a')).toBeNull());
    expect(onResolved).toHaveBeenCalledTimes(1);
  });

  it('releases a conflict and a permanent failure seen at mount', async () => {
    for (const status of ['conflict', 'permanent-failed'] as const) {
      sessionStorage.setItem('candidary.cover.operation.event-a', 'operation-a');
      vi.stubGlobal('fetch', vi.fn());
      render(<ManagerCoverPreparationStatus
        eventId="event-a"
        preparation={preparation({ status, retryable: false })}
        onResolved={vi.fn()}
      />);
      await waitFor(() => expect(sessionStorage.getItem('candidary.cover.operation.event-a')).toBeNull());
      cleanup();
    }
  });

  it('keeps a retryable receipt operation, because the same one restarts', async () => {
    sessionStorage.setItem('candidary.cover.operation.event-a', 'operation-a');
    vi.stubGlobal('fetch', vi.fn());
    render(<ManagerCoverPreparationStatus
      eventId="event-a"
      preparation={preparation({ status: 'retryable-failed', retryable: true })}
      onResolved={vi.fn()}
    />);
    expect(sessionStorage.getItem('candidary.cover.operation.event-a')).toBe('operation-a');
  });

  it('shows nothing when there is no receipt', () => {
    vi.stubGlobal('fetch', vi.fn());
    const { container } = render(<ManagerCoverPreparationStatus
      eventId="event-a"
      preparation={null}
      onResolved={vi.fn()}
    />);
    expect(container).toBeEmptyDOMElement();
  });
});

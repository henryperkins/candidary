import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EventCoverPreparationView } from '../../shared/event-cover';
import { ManagerCoverPreparationStatus } from '../../src/components/ManagerCoverPreparationStatus';
import type { CoverOperationReconciler } from '../../src/features/cover/use-cover-operation-reconciler';

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

function reconciler(
  view: EventCoverPreparationView | null,
  { slow = false, retry = vi.fn(async () => undefined) }: {
    slow?: boolean;
    retry?: () => Promise<void>;
  } = {},
): CoverOperationReconciler {
  return {
    controller: {} as CoverOperationReconciler['controller'],
    operation: view,
    operationState: {
      phase: view?.status === 'preparing' ? 'preparing' : view?.status ?? 'idle',
      operationId: view?.operationId ?? null,
      view,
      answer: null,
      receiptPath: null,
      retryAfterMs: null,
      dispatched: Boolean(view),
      slow,
    },
    accessFailure: null,
    beginDispatch: vi.fn(),
    dispatchSettled: vi.fn(),
    dispatchFailed: vi.fn(),
    rejectBeforeDispatch: vi.fn(),
    retry,
    recoverAccess: vi.fn(),
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('manager cover preparation status', () => {
  it('renders durable progress without owning requests or timers', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { rerender } = render(<ManagerCoverPreparationStatus
      reconciler={reconciler(preparation({ completedSteps: 1 }))}
    />);
    expect(screen.getByRole('status'))
      .toHaveTextContent('Preparing cover 2 of 6. Your current cover is still live.');
    expect(screen.getByRole('status').textContent).not.toMatch(/profile/iu);

    rerender(<ManagerCoverPreparationStatus
      reconciler={reconciler(preparation({ completedSteps: 4 }))}
    />);
    expect(screen.getByRole('status')).toHaveTextContent('Preparing cover 5 of 6');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the controller-owned sixty-second copy without scheduling itself', () => {
    render(<ManagerCoverPreparationStatus reconciler={reconciler(preparation(), { slow: true })} />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Still preparing. Your current cover is safe, and you can close this window.',
    );
  });

  it('announces applied and conflicting outcomes', () => {
    const { rerender } = render(<ManagerCoverPreparationStatus
      reconciler={reconciler(preparation({ status: 'applied', completedSteps: 6 }))}
    />);
    expect(screen.getByRole('status')).toHaveTextContent('Your new cover is live.');

    rerender(<ManagerCoverPreparationStatus
      reconciler={reconciler(preparation({ status: 'conflict' }))}
    />);
    expect(screen.getByRole('status')).toHaveTextContent('changed somewhere else');
  });

  it('retries through the existing reconciler only', async () => {
    const user = userEvent.setup();
    const retry = vi.fn(async () => undefined);
    render(<ManagerCoverPreparationStatus reconciler={reconciler(preparation({
      status: 'retryable-failed',
      retryable: true,
      safeFailureCode: 'COVER_RENDER_UNAVAILABLE',
    }), { retry })} />);

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('offers no retry for a permanent failure and can be dismissed', async () => {
    const user = userEvent.setup();
    render(<ManagerCoverPreparationStatus reconciler={reconciler(preparation({
      status: 'permanent-failed',
      retryable: false,
      safeFailureCode: 'COVER_OUTPUT_BUDGET_EXHAUSTED',
    }))} />);
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('choose the photo again');

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows nothing when there is no receipt', () => {
    const { container } = render(<ManagerCoverPreparationStatus reconciler={reconciler(null)} />);
    expect(container).toBeEmptyDOMElement();
  });
});

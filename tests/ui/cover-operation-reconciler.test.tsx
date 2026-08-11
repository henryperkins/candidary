import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EventCoverPreparationView } from '../../shared/event-cover';
import type { EventView } from '../../shared/contracts';
import { ClientApiError } from '../../src/app/api';
import { coverOperationKey } from '../../src/features/cover/cover-draft-client';
import { useCoverOperationReconciler } from '../../src/features/cover/use-cover-operation-reconciler';

const OPERATION = 'd2f3b2a0-885c-4380-bf20-8d44e9712176';

function preparation(patch: Partial<EventCoverPreparationView> = {}): EventCoverPreparationView {
  return {
    operationId: OPERATION,
    status: 'preparing',
    completedSteps: 1,
    requiredSteps: 6,
    retryable: false,
    safeFailureCode: null,
    updatedAt: '2026-08-10T00:00:00.000Z',
    ...patch,
  };
}

function event(revision = 4, preparationView: EventCoverPreparationView | null = null): EventView {
  return {
    id: 'event-a',
    cover: {
      config: { version: 1, source: { kind: 'none' } },
      revision,
      hasCover: false,
      available2xProfiles: [],
      surfaceTreatment: 'none',
      preparation: preparationView,
    },
  } as unknown as EventView;
}

function envelope(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ data, requestId: 'request-a' }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

afterEach(() => {
  sessionStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useCoverOperationReconciler', () => {
  it('owns one controller across rerenders and resumes the server-selected receipt', () => {
    const onCoverEvent = vi.fn();
    const onFreshEventRequired = vi.fn();
    const { result, rerender } = renderHook(
      ({ view }: { view: EventCoverPreparationView | null }) => useCoverOperationReconciler({
        eventId: 'event-a',
        preparation: view,
        onCoverEvent,
        onFreshEventRequired,
      }),
      { initialProps: { view: preparation() as EventCoverPreparationView | null } },
    );
    const controller = result.current.controller;
    expect(result.current.operationState.operationId).toBe(OPERATION);
    expect(sessionStorage.getItem(coverOperationKey('event-a'))).toBe(OPERATION);

    rerender({ view: preparation({ completedSteps: 2 }) });
    expect(result.current.controller).toBe(controller);
    expect(result.current.operationState.view?.completedSteps).toBe(2);
  });

  it('adopts an applied event and clears persistence only after cover handoff', async () => {
    vi.useFakeTimers();
    const applied = event(4);
    const onCoverEvent = vi.fn();
    const onFreshEventRequired = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => envelope({
      operation: preparation({ status: 'applied', completedSteps: 6 }),
      appliedRevision: 4,
      event: applied,
    })));
    renderHook(() => useCoverOperationReconciler({
      eventId: 'event-a',
      preparation: preparation(),
      onCoverEvent,
      onFreshEventRequired,
    }));
    expect(sessionStorage.getItem(coverOperationKey('event-a'))).toBe(OPERATION);

    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(onCoverEvent).toHaveBeenCalledWith(applied);
    expect(onFreshEventRequired).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(coverOperationKey('event-a'))).toBeNull();
  });

  it('does not repersist a terminal projection after its event handoff', async () => {
    const terminal = preparation({ status: 'applied', completedSteps: 6 });
    const applied = event(4, terminal);
    const onCoverEvent = vi.fn();
    const { result, rerender } = renderHook(
      ({ view }: { view: EventCoverPreparationView | null }) => useCoverOperationReconciler({
        eventId: 'event-a',
        preparation: view,
        onCoverEvent,
        onFreshEventRequired: vi.fn(),
      }),
      { initialProps: { view: preparation() as EventCoverPreparationView | null } },
    );

    act(() => result.current.dispatchSettled({
      status: 200,
      operation: terminal,
      event: applied,
      appliedRevision: 4,
      receiptPath: `/api/manage/events/event-a/cover/publications/${OPERATION}`,
      retryAfterMs: null,
    }));
    await waitFor(() => expect(sessionStorage.getItem(coverOperationKey('event-a'))).toBeNull());
    rerender({ view: terminal });
    expect(sessionStorage.getItem(coverOperationKey('event-a'))).toBeNull();
  });

  it('requests one guarded fresh event for a terminal answer without an event', async () => {
    let release!: (value: EventView) => void;
    const fresh = new Promise<EventView>((resolve) => { release = resolve; });
    const current = event(5);
    const onCoverEvent = vi.fn();
    const onFreshEventRequired = vi.fn(() => fresh);
    const { rerender } = renderHook(
      ({ view }: { view: EventCoverPreparationView | null }) => useCoverOperationReconciler({
        eventId: 'event-a',
        preparation: view,
        onCoverEvent,
        onFreshEventRequired,
      }),
      { initialProps: { view: preparation({ status: 'conflict' }) } },
    );
    expect(sessionStorage.getItem(coverOperationKey('event-a'))).toBe(OPERATION);
    rerender({ view: preparation({ status: 'conflict' }) });
    expect(onFreshEventRequired).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(coverOperationKey('event-a'))).toBe(OPERATION);

    release(current);
    await waitFor(() => expect(onCoverEvent).toHaveBeenCalledWith(current));
    expect(sessionStorage.getItem(coverOperationKey('event-a'))).toBeNull();
  });

  it('retains retryable and ambiguous operations', () => {
    const { result, rerender } = renderHook(
      ({ view }: { view: EventCoverPreparationView | null }) => useCoverOperationReconciler({
        eventId: 'event-a',
        preparation: view,
        onCoverEvent: vi.fn(),
        onFreshEventRequired: vi.fn(),
      }),
      {
        initialProps: {
          view: preparation({
            status: 'retryable-failed',
            retryable: true,
          }) as EventCoverPreparationView | null,
        },
      },
    );
    expect(sessionStorage.getItem(coverOperationKey('event-a'))).toBe(OPERATION);

    act(() => {
      result.current.beginDispatch(OPERATION);
      result.current.dispatchSettled(null);
    });
    rerender({ view: null });
    expect(result.current.operationState.phase).toBe('preparing');
    expect(sessionStorage.getItem(coverOperationKey('event-a'))).toBe(OPERATION);
  });

  it('discriminates access failure before and after dispatch without republishing', () => {
    const { result } = renderHook(() => useCoverOperationReconciler({
      eventId: 'event-a',
      preparation: null,
      onCoverEvent: vi.fn(),
      onFreshEventRequired: vi.fn(),
    }));
    const denied = new ClientApiError('SESSION_REQUIRED', 'Sign in again.');
    act(() => result.current.rejectBeforeDispatch(denied));
    expect(result.current.accessFailure).toEqual({ phase: 'before_dispatch', error: denied });
    expect(result.current.operationState.dispatched).toBe(false);

    act(() => {
      result.current.beginDispatch(OPERATION);
      result.current.dispatchFailed(denied);
    });
    expect(result.current.accessFailure).toEqual({ phase: 'after_dispatch', error: denied });
    expect(result.current.operationState.dispatched).toBe(true);
    expect(sessionStorage.getItem(coverOperationKey('event-a'))).toBe(OPERATION);
  });

  it('pauses receipt reads after Manager access fails', async () => {
    vi.useFakeTimers();
    const denied = new ClientApiError('SESSION_REQUIRED', 'Sign in again.');
    const fetchMock = vi.fn(async () => { throw denied; });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useCoverOperationReconciler({
      eventId: 'event-a',
      preparation: preparation(),
      onCoverEvent: vi.fn(),
      onFreshEventRequired: vi.fn(),
    }));

    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(result.current.accessFailure).toEqual({ phase: 'after_dispatch', error: denied });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

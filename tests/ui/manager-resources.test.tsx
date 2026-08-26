import { act, cleanup, renderHook } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ClientApiError } from '../../src/app/api';
import {
  useManagerResource,
  type ResourceState,
} from '../../src/features/manager/resources';

afterEach(cleanup);

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function useNumberResource(load: (signal: AbortSignal) => Promise<number>) {
  return useManagerResource<number>({
    eventId: 'event-a',
    queryKey: 'first-page',
    enabled: false,
    fallbackMessage: 'Could not load the page.',
    onEscalate: vi.fn(),
    load,
  });
}

describe('manager resource capture ownership', () => {
  it('retires a continuation captured during a reload when that reload settles terminal', async () => {
    const pending = deferred<number>();
    const { result } = renderHook(() => useNumberResource(() => pending.promise));

    act(() => { result.current.adopt(7); });

    let reload!: Promise<void>;
    act(() => { reload = result.current.reload(); });
    const continuation = result.current.capture();

    await act(async () => {
      pending.reject(new ClientApiError('SESSION_EXPIRED', 'This session has expired.', undefined, undefined, 401));
      await reload;
    });

    expect(result.current.state).toMatchObject({ value: 7, status: 'failed', terminal: true });
    expect(result.current.isCaptureCurrent(continuation)).toBe(false);
    expect(result.current.isCaptureCurrent(result.current.capture())).toBe(false);
    let accepted!: boolean;
    act(() => {
      accepted = result.current.updateIfCurrent(continuation, () => 8);
    });
    expect(accepted).toBe(false);
    expect(result.current.state).toMatchObject({ value: 7, status: 'failed', terminal: true });
    expect(result.current.isTerminal()).toBe(true);
  });

  it('retires a continuation captured during a successful authoritative reload', async () => {
    const pending = deferred<number>();
    const { result } = renderHook(() => useNumberResource(() => pending.promise));

    act(() => { result.current.adopt(7); });

    let reload!: Promise<void>;
    act(() => { reload = result.current.reload(); });
    const continuation = result.current.capture();

    await act(async () => {
      pending.resolve(11);
      await reload;
    });

    expect(result.current.state).toMatchObject({ value: 11, status: 'ready', terminal: false });
    expect(result.current.isCaptureCurrent(continuation)).toBe(false);
    let accepted!: boolean;
    act(() => {
      accepted = result.current.updateIfCurrent(continuation, () => 12);
    });
    expect(accepted).toBe(false);
    expect(result.current.state.value).toBe(11);
  });

  it('exposes a nonmutating capture ownership check', () => {
    const { result } = renderHook(() => useNumberResource(async () => 0));
    const current = result.current.capture();
    const stateBeforeCheck = result.current.state;

    expect(result.current.isCaptureCurrent(current)).toBe(true);
    expect(result.current.isCaptureCurrent(current)).toBe(true);
    expect(result.current.state).toBe(stateBeforeCheck);

    act(() => { result.current.update((value) => value); });
    expect(result.current.isCaptureCurrent(current)).toBe(false);
  });
});

interface LayoutObservation<T> {
  committedEventId: string;
  committedQueryKey: string;
  state: ResourceState<T>;
}

function useObservedResource(
  eventId: string,
  queryKey: string,
  observe: (observation: LayoutObservation<number>) => void,
) {
  const resource = useManagerResource<number>({
    eventId,
    queryKey,
    enabled: false,
    fallbackMessage: 'Could not load the page.',
    onEscalate: () => {},
    load: async () => 0,
  });
  useLayoutEffect(() => {
    observe({ committedEventId: eventId, committedQueryKey: queryKey, state: resource.state });
  }, [eventId, observe, queryKey, resource.state]);
  return resource;
}

describe('manager resource committed identity', () => {
  it.each([
    ['event', { eventId: 'event-b', queryKey: 'first-page' }],
    ['query', { eventId: 'event-a', queryKey: 'filtered-page' }],
  ] as const)('never exposes identity A during the committed %s B layout', (_kind, nextIdentity) => {
    const observations: LayoutObservation<number>[] = [];
    const observe = (observation: LayoutObservation<number>) => { observations.push(observation); };
    const { result, rerender } = renderHook(
      ({ eventId, queryKey }) => useObservedResource(eventId, queryKey, observe),
      { initialProps: { eventId: 'event-a', queryKey: 'first-page' } },
    );

    act(() => { result.current.adopt(41); });
    observations.length = 0;
    rerender(nextIdentity);

    const committedB = observations.filter((observation) => (
      observation.committedEventId === nextIdentity.eventId
        && observation.committedQueryKey === nextIdentity.queryKey
    ));
    expect(committedB.length).toBeGreaterThan(0);
    expect(committedB.every((observation) => (
      observation.state.eventId === nextIdentity.eventId
        && observation.state.queryKey === nextIdentity.queryKey
        && observation.state.value === null
        && observation.state.status === 'idle'
    ))).toBe(true);
  });
});

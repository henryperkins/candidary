import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostTourStateView } from '../../shared/contracts';

type Outcome = 'dismissed' | 'completed';
type Hook = typeof import('../../src/features/manager/use-host-welcome-tour').useHostWelcomeTour;
let useHostWelcomeTour: Hook;
let accountId: string;
let serverStatus: HostTourStateView['status'];
let patch: (owner: string, status: Outcome) => Promise<Response>;
const writes: { accountId: string; status: Outcome }[] = [];
const state = (owner = accountId, status = serverStatus): HostTourStateView => ({ accountId: owner, status, version: 1, tourKey: 'host-event-welcome' });
const response = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status });
function deferred() {
  let resolve!: (value: Response) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const mount = (eventId = 'event-a', eligible = true) => renderHook(() => useHostWelcomeTour({ eventId, eligible }));
const exit = (view: { result: { current: ReturnType<Hook> } }, status: Outcome) => act(() => { view.result.current.start(); view.result.current.close(status); });

beforeEach(async () => {
  vi.resetModules();
  ({ useHostWelcomeTour } = await import('../../src/features/manager/use-host-welcome-tour'));
  sessionStorage.clear(); writes.length = 0; accountId = 'account-a'; serverStatus = 'unseen';
  patch = async (owner, status) => response(state(owner, status));
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method !== 'PATCH') return response(state());
    const owner = new Headers(init.headers).get('x-candidary-tour-account-id')!;
    const { status } = JSON.parse(init.body as string) as { status: Outcome };
    writes.push({ accountId: owner, status });
    return patch(owner, status);
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('recoverable welcome preferences', () => {
  it.each(['dismissed', 'completed'] as const)('restores failed %s after document reload for an authenticated retry', async status => {
    patch = async () => { throw new Error('offline'); };
    const first = mount();
    await waitFor(() => expect(first.result.current.open).toBe(true));
    exit(first, status);
    await waitFor(() => expect(first.result.current.saveFailed).toBe(true));
    first.unmount();
    // Reload the hook module as well as the UI: recovery must come from storage.
    vi.resetModules();
    ({ useHostWelcomeTour } = await import('../../src/features/manager/use-host-welcome-tour'));
    const second = mount('event-b');
    await waitFor(() => expect(second.result.current.saveFailed).toBe(true));
    expect(second.result.current.open).toBe(false);
    patch = async (owner, outcome) => response(state(owner, outcome));
    act(() => second.result.current.retrySave());
    await waitFor(() => expect(writes).toEqual([{ accountId: 'account-a', status }, { accountId: 'account-a', status }]));
    await waitFor(() => expect(second.result.current.saveFailed).toBe(false));
    second.unmount();
    const third = mount('event-c');
    await act(async () => {});
    expect(third.result.current.saveFailed).toBe(false);
    exit(third, 'dismissed');
    expect(writes).toHaveLength(2);
  });

  it.each(['dismissed', 'completed'] as const)('retries a failed %s on manual replay exit without downgrading completion', async status => {
    patch = async () => { throw new Error('offline'); };
    const first = mount();
    await waitFor(() => expect(first.result.current.open).toBe(true));
    exit(first, status);
    await waitFor(() => expect(first.result.current.saveFailed).toBe(true));
    first.unmount();
    patch = async (owner, outcome) => response(state(owner, outcome));
    const second = mount('event-b');
    await act(async () => {});
    exit(second, 'dismissed');
    await waitFor(() => expect(writes).toEqual([{ accountId: 'account-a', status }, { accountId: 'account-a', status }]));
    await waitFor(() => expect(second.result.current.saveFailed).toBe(false));
  });

  it('suppresses automatic remount replay when storage reads work but writes are blocked', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError'); });
    const first = mount();
    await waitFor(() => expect(first.result.current.open).toBe(true));
    first.unmount();
    const second = mount('event-b');
    await act(async () => {});
    expect(second.result.current.open).toBe(false);
  });

  it.each(['writes', 'all'] as const)('recovers pending completion with %s storage blocked', async mode => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage blocked'); });
    if (mode === 'all') vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage blocked'); });
    patch = async () => { throw new Error('offline'); };
    const first = mount();
    await waitFor(() => expect(first.result.current.open).toBe(true));
    exit(first, 'completed');
    await waitFor(() => expect(first.result.current.saveFailed).toBe(true));
    first.unmount();
    const second = mount('event-b');
    await waitFor(() => expect(second.result.current.saveFailed).toBe(true));
    expect(second.result.current.open).toBe(false);
    patch = async (owner, status) => response(state(owner, status));
    exit(second, 'dismissed');
    await waitFor(() => expect(writes).toEqual([{ accountId: 'account-a', status: 'completed' }, { accountId: 'account-a', status: 'completed' }]));
    await waitFor(() => expect(second.result.current.saveFailed).toBe(false));
  });

  it('recovers only after the same account is authenticated and keeps another account isolated', async () => {
    patch = async () => { throw new Error('offline'); };
    const first = mount();
    await waitFor(() => expect(first.result.current.open).toBe(true));
    exit(first, 'completed');
    await waitFor(() => expect(first.result.current.saveFailed).toBe(true));
    first.unmount();
    accountId = 'account-b';
    const second = mount('event-b');
    await waitFor(() => expect(second.result.current.open).toBe(true));
    expect(second.result.current.saveFailed).toBe(false);
    act(() => second.result.current.retrySave());
    expect(writes).toHaveLength(1);
    second.unmount();
    accountId = 'account-a';
    const third = mount('event-c');
    await waitFor(() => expect(third.result.current.saveFailed).toBe(true));
    expect(third.result.current.open).toBe(false);
  });

  it.each([401, 503])('does not recover or send an account preference after a %s identity lookup', async status => {
    patch = async () => { throw new Error('offline'); };
    const first = mount();
    await waitFor(() => expect(first.result.current.open).toBe(true));
    exit(first, 'completed');
    await waitFor(() => expect(first.result.current.saveFailed).toBe(true));
    first.unmount();
    vi.mocked(fetch).mockImplementation(async () => response(null, status));
    const manual = mount('event-b');
    await act(async () => {});
    expect(manual.result.current.saveFailed).toBe(false);
    exit(manual, 'dismissed');
    act(() => manual.result.current.retrySave());
    expect(manual.result.current.open).toBe(false);
    expect(writes).toHaveLength(1);
  });

  it('retires a pending preference already satisfied by server completion', async () => {
    patch = async () => { throw new Error('offline'); };
    const first = mount();
    await waitFor(() => expect(first.result.current.open).toBe(true));
    exit(first, 'completed');
    await waitFor(() => expect(first.result.current.saveFailed).toBe(true));
    first.unmount();
    serverStatus = 'completed';
    const second = mount('event-b');
    await act(async () => {});
    expect(second.result.current.saveFailed).toBe(false);
    exit(second, 'dismissed');
    act(() => second.result.current.retrySave());
    expect(writes).toHaveLength(1);
    second.unmount();
    serverStatus = 'unseen';
    const third = mount('event-c');
    await act(async () => {});
    expect(third.result.current.saveFailed).toBe(false);
    exit(third, 'dismissed');
    expect(writes).toHaveLength(1);
  });

  it('lets the remounted same-account hook observe failure of an in-flight save without duplicate writes', async () => {
    const pending = deferred(); patch = () => pending.promise;
    const first = mount();
    await waitFor(() => expect(first.result.current.open).toBe(true));
    exit(first, 'completed');
    first.unmount();
    const second = mount('event-b');
    await act(async () => {});
    expect(second.result.current.open).toBe(false);
    exit(second, 'dismissed');
    expect(writes).toEqual([{ accountId: 'account-a', status: 'completed' }]);
    await act(async () => pending.reject(new Error('offline')));
    await waitFor(() => expect(second.result.current.saveFailed).toBe(true));
    patch = async (owner, status) => response(state(owner, status));
    act(() => second.result.current.retrySave());
    await waitFor(() => expect(writes).toEqual([{ accountId: 'account-a', status: 'completed' }, { accountId: 'account-a', status: 'completed' }]));
  });

  it('serializes a stronger completion behind dismissal and retains completion if its save fails', async () => {
    const dismissal = deferred();
    patch = (_owner, status) => status === 'dismissed' ? dismissal.promise : Promise.reject(new Error('offline'));
    const view = mount();
    await waitFor(() => expect(view.result.current.open).toBe(true));
    exit(view, 'dismissed'); exit(view, 'completed');
    expect(writes).toEqual([{ accountId: 'account-a', status: 'dismissed' }]);
    await act(async () => dismissal.resolve(response(state('account-a', 'dismissed'))));
    await waitFor(() => expect(view.result.current.saveFailed).toBe(true));
    expect(writes).toEqual([{ accountId: 'account-a', status: 'dismissed' }, { accountId: 'account-a', status: 'completed' }]);
    patch = async (owner, status) => response(state(owner, status));
    exit(view, 'dismissed');
    await waitFor(() => expect(writes.at(-1)).toEqual({ accountId: 'account-a', status: 'completed' }));
    await waitFor(() => expect(view.result.current.saveFailed).toBe(false));
    expect(writes).toHaveLength(3);
  });

  it('never sends dismissal while completion is in flight or downgrades its failed retry', async () => {
    const completion = deferred(); patch = () => completion.promise;
    const view = mount();
    await waitFor(() => expect(view.result.current.open).toBe(true));
    exit(view, 'completed'); exit(view, 'dismissed');
    expect(writes).toEqual([{ accountId: 'account-a', status: 'completed' }]);
    await act(async () => completion.reject(new Error('offline')));
    await waitFor(() => expect(view.result.current.saveFailed).toBe(true));
    patch = async (owner, status) => response(state(owner, status));
    act(() => view.result.current.retrySave());
    await waitFor(() => expect(writes).toEqual([{ accountId: 'account-a', status: 'completed' }, { accountId: 'account-a', status: 'completed' }]));
  });

  it('keeps a stale account write from changing the current account retry state', async () => {
    const old = deferred();
    patch = owner => owner === 'account-a' ? old.promise : Promise.reject(new Error('offline'));
    const view = renderHook(({ eventId }) => useHostWelcomeTour({ eventId, eligible: true }), { initialProps: { eventId: 'event-a' } });
    await waitFor(() => expect(view.result.current.open).toBe(true));
    exit(view, 'completed');
    accountId = 'account-b'; view.rerender({ eventId: 'event-b' });
    await waitFor(() => expect(view.result.current.open).toBe(true));
    exit(view, 'dismissed');
    await waitFor(() => expect(view.result.current.saveFailed).toBe(true));
    await act(async () => old.resolve(response(state('account-a', 'completed'))));
    expect(view.result.current.saveFailed).toBe(true);
    patch = async (owner, status) => response(state(owner, status));
    act(() => view.result.current.retrySave());
    await waitFor(() => expect(writes.at(-1)).toEqual({ accountId: 'account-b', status: 'dismissed' }));
    await waitFor(() => expect(view.result.current.saveFailed).toBe(false));
  });
});

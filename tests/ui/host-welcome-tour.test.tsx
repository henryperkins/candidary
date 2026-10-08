import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHostWelcomeTour } from '../../src/features/manager/use-host-welcome-tour';
import { HostWelcomeTour } from '../../src/features/manager/HostWelcomeTour';

const state = (accountId = 'account-a', status = 'unseen') => ({ accountId, status, version: 1, tourKey: 'host-event-welcome' });
function response(data: unknown, status = 200) { return new Response(JSON.stringify({ data }), { status }); }
beforeEach(() => { sessionStorage.clear(); vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }); vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => response(state()))); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('welcome account state', () => {
  it('launches on the first authorized Overview visit, persists dismissal bound to account, and replay does not reset it', async () => {
    const { result } = renderHook(() => useHostWelcomeTour({ eventId: 'a', eligible: true }));
    await waitFor(() => expect(result.current.open).toBe(true));
    act(() => result.current.close('dismissed'));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const init = vi.mocked(fetch).mock.calls[1]![1]!;
    expect(new Headers(init.headers).get('x-candidary-tour-account-id')).toBe('account-a');
    expect(JSON.parse(init.body as string)).toEqual({ status: 'dismissed' });
    act(() => result.current.start());
    expect(result.current.open).toBe(true);
    act(() => result.current.close('dismissed'));
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('keeps deep routes and link-only hosts manual, and suppresses failed lookups', async () => {
    const { result, rerender } = renderHook(({ eligible }) => useHostWelcomeTour({ eventId: 'a', eligible }), { initialProps: { eligible: false } });
    await act(async () => {});
    expect(result.current.open).toBe(false);
    vi.mocked(fetch).mockResolvedValue(response(null, 401));
    rerender({ eligible: true });
    await act(async () => {});
    expect(result.current.open).toBe(true); // authenticated lookup was already confirmed
    cleanup();
    const manual = renderHook(() => useHostWelcomeTour({ eventId: 'b', eligible: true }));
    await act(async () => {});
    expect(manual.result.current.open).toBe(false);
    act(() => manual.result.current.start());
    expect(manual.result.current.open).toBe(true);
    act(() => manual.result.current.close('dismissed'));
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(0);
  });
  it('ignores stale event lookup and preserves exit when a write fails, with explicit retry', async () => {
    let resolve!: (value: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const { result, rerender } = renderHook(({ eventId }) => useHostWelcomeTour({ eventId, eligible: eventId === 'a' }), { initialProps: { eventId: 'a' } });
    vi.mocked(fetch).mockResolvedValue(response(state('account-b')));
    rerender({ eventId: 'b' });
    await act(async () => {});
    await act(async () => resolve(response(state())));
    expect(result.current.open).toBe(false);
    act(() => result.current.start());
    vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'));
    act(() => result.current.close('completed'));
    await waitFor(() => expect(result.current.saveFailed).toBe(true));
    expect(result.current.open).toBe(false);
    act(() => result.current.retrySave());
    await waitFor(() => expect(result.current.saveFailed).toBe(false));
    const last = vi.mocked(fetch).mock.calls.at(-1)![1]!;
    expect(new Headers(last.headers).get('x-candidary-tour-account-id')).toBe('account-b');
  });
  it('suppresses automatic launch after a failed lookup and after an account was already seen in this session', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));
    const first = renderHook(() => useHostWelcomeTour({ eventId: 'a', eligible: true }));
    await act(async () => {});
    expect(first.result.current.open).toBe(false);
    first.unmount();
    vi.mocked(fetch).mockResolvedValue(response(state()));
    const second = renderHook(() => useHostWelcomeTour({ eventId: 'b', eligible: true }));
    await waitFor(() => expect(second.result.current.open).toBe(true));
    second.unmount();
    const third = renderHook(() => useHostWelcomeTour({ eventId: 'c', eligible: true }));
    await act(async () => {});
    expect(third.result.current.open).toBe(false);
  });
});

function anchors() {
  for (const name of ['overview-task', 'rsvp', 'share-qr', 'library', 'exports', 'settings']) {
    const el = document.createElement('div'); el.dataset.hostTourAnchor = name;
    el.getBoundingClientRect = () => ({ x: 100, y: 100, top: 100, left: 100, right: 300, bottom: 180, width: 200, height: 80, toJSON() {} });
    el.scrollIntoView = vi.fn(); document.body.append(el);
  }
}
afterEach(() => document.querySelectorAll('[data-host-tour-anchor]').forEach(el => el.remove()));
describe('tour flow', () => {
  it('waits for committed navigation, refuses repeated Next, and restores the current step after refusal', async () => {
    anchors(); const user = userEvent.setup(); const navigate = vi.fn(); const close = vi.fn();
    const props = { location: 'overview', blocked: false, onNavigate: navigate, onClose: close };
    const view = render(<HostWelcomeTour {...props} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(navigate).toHaveBeenCalledWith('rsvp');
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
    view.rerender(<HostWelcomeTour {...props} blocked />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    view.rerender(<HostWelcomeTour {...props} />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Your next task' })).toHaveFocus(), { timeout: 2500 });
    await user.keyboard('{Escape}'); expect(close).toHaveBeenCalledWith('dismissed');
  });
  it('shows retry and exit for missing anchors and yields to another dialog', async () => {
    const user = userEvent.setup();
    render(<HostWelcomeTour location="overview" blocked={false} onNavigate={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/This part of the page is not available/)).toBeVisible(), { timeout: 2500 });
    expect(screen.getByRole('button', { name: 'Retry step' })).toBeVisible();
    const other = document.createElement('div'); other.setAttribute('role', 'dialog'); document.body.append(other);
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Your next task' })).not.toBeInTheDocument());
    other.remove();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Skip tour' })).toBeVisible());
    await user.click(screen.getByRole('button', { name: 'Skip tour' }));
  });
});

it('completes all six committed steps and focuses Overview without activating its action', async () => {
  anchors(); const user = userEvent.setup(); const navigate = vi.fn(); const close = vi.fn();
  const action = document.createElement('button'); action.dataset.hostTourRecommendedAction = ''; document.body.append(action);
  const activate = vi.fn(); action.onclick = activate;
  const view = render(<HostWelcomeTour location="overview" blocked={false} onNavigate={navigate} onClose={close} />);
  for (const destination of ['rsvp', 'share', 'library', 'library', 'settings']) {
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Next' }));
    view.rerender(<HostWelcomeTour location={destination} blocked={false} onNavigate={navigate} onClose={close} />);
  }
  await waitFor(() => expect(screen.getByRole('button', { name: 'Finish' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Finish' }));
  view.rerender(<HostWelcomeTour location="overview" blocked={false} onNavigate={navigate} onClose={close} />);
  await waitFor(() => expect(close).toHaveBeenCalledWith('completed'));
  view.unmount();
  await waitFor(() => expect(action).toHaveFocus());
  expect(activate).not.toHaveBeenCalled(); action.remove();
});


it.each(['dismissed', 'completed'] as const)('persists a manual %s after a slow authenticated lookup without reopening', async status => {
  let resolve!: (value: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const { result } = renderHook(() => useHostWelcomeTour({ eventId: 'slow', eligible: true }));
  act(() => result.current.start());
  act(() => result.current.close(status));
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => resolve(response(state())));
  expect(result.current.open).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(2);
  const patch = vi.mocked(fetch).mock.calls[1]![1]!;
  expect(patch.method).toBe('PATCH');
  expect(new Headers(patch.headers).get('x-candidary-tour-account-id')).toBe('account-a');
  expect(JSON.parse(patch.body as string)).toEqual({ status });
});

it('keeps completion over dismissal while manual replay is waiting for account identity', async () => {
  let resolve!: (value: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const { result } = renderHook(() => useHostWelcomeTour({ eventId: 'slow', eligible: true }));
  for (const status of ['dismissed', 'completed', 'dismissed'] as const) {
    act(() => result.current.start());
    act(() => result.current.close(status));
  }
  await act(async () => resolve(response(state())));
  expect(result.current.open).toBe(false);
  const patches = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'PATCH');
  expect(patches).toHaveLength(1);
  expect(JSON.parse(patches[0]![1]!.body as string)).toEqual({ status: 'completed' });
});

it('retires a queued outcome when its event lookup becomes stale', async () => {
  let resolveOld!: (value: Response) => void;
  let resolveNew!: (value: Response) => void;
  vi.mocked(fetch)
    .mockImplementationOnce(() => new Promise(r => { resolveOld = r; }))
    .mockImplementationOnce(() => new Promise(r => { resolveNew = r; }));
  const { result, rerender } = renderHook(({ eventId }) => useHostWelcomeTour({ eventId, eligible: false }), { initialProps: { eventId: 'old' } });
  act(() => result.current.start());
  act(() => result.current.close('completed'));
  rerender({ eventId: 'new' });
  await act(async () => resolveNew(response(state('account-b'))));
  await act(async () => resolveOld(response(state('account-a'))));
  expect(result.current.open).toBe(false);
  expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(0);
});

it.each([401, 503])('retires queued manual outcomes after a %s account lookup without a PATCH', async status => {
  let resolve!: (value: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const { result } = renderHook(() => useHostWelcomeTour({ eventId: 'slow', eligible: true }));
  act(() => result.current.start());
  act(() => result.current.close('completed'));
  await act(async () => resolve(response(null, status)));
  act(() => result.current.start());
  act(() => result.current.close('dismissed'));
  expect(result.current.open).toBe(false);
  expect(result.current.saveFailed).toBe(false);
  expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(0);
});

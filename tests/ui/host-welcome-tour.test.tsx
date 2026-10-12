import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHostWelcomeTour } from '../../src/features/manager/use-host-welcome-tour';
import type { HostWelcomeContext } from '../../src/features/manager/host-welcome-content';
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
    const view = render(<HostWelcomeTour mode="tools" context={introContext} {...props} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(navigate).toHaveBeenCalledWith('rsvp');
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
    view.rerender(<HostWelcomeTour mode="tools" context={introContext} {...props} blocked />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    view.rerender(<HostWelcomeTour mode="tools" context={introContext} {...props} />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Your next task' })).toHaveFocus(), { timeout: 2500 });
    await user.keyboard('{Escape}'); expect(close).toHaveBeenCalledWith('dismissed');
  });
  it('shows retry and exit for missing anchors and yields to another dialog', async () => {
    const user = userEvent.setup();
    render(<HostWelcomeTour mode="tools" context={introContext} location="overview" blocked={false} onNavigate={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/This part of the page is not available/)).toBeVisible(), { timeout: 2500 });
    expect(screen.getByRole('button', { name: 'Retry step' })).toBeVisible();
    const other = document.createElement('div'); other.setAttribute('role', 'dialog'); document.body.append(other);
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Your next task' })).not.toBeInTheDocument());
    other.remove();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Skip tour' })).toBeVisible());
    await user.click(screen.getByRole('button', { name: 'Skip tour' }));
  });
  it('keeps recovery announcements in a persistent polite live region while a target disappears and recovers', async () => {
    anchors();
    const user = userEvent.setup();
    render(<HostWelcomeTour mode="tools" context={introContext} location="overview" blocked={false} onNavigate={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
    // AT must know the live region before recovery text is added to it.
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(/^$/);
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveAttribute('aria-atomic', 'true');
    const message = status.firstElementChild;
    expect(message).not.toBeNull();
    const target = document.querySelector<HTMLElement>('[data-host-tour-anchor="overview-task"]')!;
    act(() => target.remove());
    await waitFor(() => expect(status).toHaveTextContent('This part of the page is not available yet.'), { timeout: 2500 });
    expect(screen.getByRole('status')).toBe(status);
    expect(status.firstElementChild).toBe(message);
    expect(screen.getByRole('heading', { name: 'Your next task' })).toHaveFocus();
    act(() => document.body.append(target));
    await user.click(screen.getByRole('button', { name: 'Retry step' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
    expect(screen.getByRole('status')).toBe(status);
    expect(status.firstElementChild).toBe(message);
    expect(status).toHaveTextContent(/^$/);
    expect(screen.getByRole('heading', { name: 'Your next task' })).toHaveFocus();
  });
});

it('completes all six committed steps and focuses Overview without activating its action', async () => {
  anchors(); const user = userEvent.setup(); const navigate = vi.fn(); const close = vi.fn();
  const action = document.createElement('button'); action.dataset.hostTourRecommendedAction = '';
  action.getBoundingClientRect = document.querySelector<HTMLElement>('[data-host-tour-anchor="overview-task"]')!.getBoundingClientRect;
  action.scrollIntoView = vi.fn(); document.body.append(action);
  const activate = vi.fn(); action.onclick = activate;
  const view = render(<HostWelcomeTour mode="tools" context={introContext} location="overview" blocked={false} onNavigate={navigate} onClose={close} />);
  for (const destination of ['rsvp', 'share', 'library', 'library', 'settings']) {
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Next' }));
    view.rerender(<HostWelcomeTour mode="tools" context={introContext} location={destination} blocked={false} onNavigate={navigate} onClose={close} />);
  }
  await waitFor(() => expect(screen.getByRole('button', { name: 'Finish' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Finish' }));
  view.rerender(<HostWelcomeTour mode="tools" context={introContext} location="overview" blocked={false} onNavigate={navigate} onClose={close} />);
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


it.each(['Escape', 'Skip tour', 'Close tour'])('restores current destination focus on later-step %s when the invoker has gone', async control => {
  anchors(); const user = userEvent.setup(); const navigate = vi.fn();
  const invoker = document.createElement('button'); document.body.append(invoker); invoker.focus();
  const close = vi.fn(() => view.unmount());
  const view = render(<HostWelcomeTour mode="tools" context={introContext} location="overview" blocked={false} onNavigate={navigate} onClose={close} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Next' }));
  invoker.remove();
  const destination = document.querySelector<HTMLElement>('[data-host-tour-anchor="rsvp"]')!;
  destination.tabIndex = -1;
  view.rerender(<HostWelcomeTour mode="tools" context={introContext} location="rsvp" blocked={false} onNavigate={navigate} onClose={close} />);
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Your guest list' })).toHaveFocus());
  if (control === 'Escape') await user.keyboard('{Escape}');
  else await user.click(screen.getByRole('button', { name: control }));
  expect(close).toHaveBeenCalledWith('dismissed');
  await waitFor(() => expect(destination).toHaveFocus());
});

it.each([false, true])('dismisses a pending tour when another destination commits (blocked=%s)', async blocked => {
  anchors(); const user = userEvent.setup(); const navigate = vi.fn(); const close = vi.fn(() => view.unmount());
  const props = { blocked: false, onNavigate: navigate, onClose: close };
  const view = render(<HostWelcomeTour mode="tools" context={introContext} {...props} location="overview" />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Next' }));
  expect(navigate).toHaveBeenCalledWith('rsvp');
  view.rerender(<HostWelcomeTour mode="tools" context={introContext} {...props} blocked={blocked} location="share" />);
  await waitFor(() => expect(close).toHaveBeenCalledWith('dismissed'));
  expect(navigate).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(document.querySelector('[data-host-tour-anchor="share-qr"]')).toHaveFocus());
});


it('restores the visible Exports control when exiting its later Library step', async () => {
  anchors(); const user = userEvent.setup(); const navigate = vi.fn();
  const close = vi.fn(() => view.unmount());
  const view = render(<HostWelcomeTour mode="tools" context={introContext} location="overview" blocked={false} onNavigate={navigate} onClose={close} />);
  for (const destination of ['rsvp', 'share', 'library', 'library']) {
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Next' }));
    view.rerender(<HostWelcomeTour mode="tools" context={introContext} location={destination} blocked={false} onNavigate={navigate} onClose={close} />);
  }
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Keep your originals' })).toHaveFocus());
  await user.keyboard('{Escape}');
  await waitFor(() => expect(document.querySelector('[data-host-tour-anchor="exports"]')).toHaveFocus());
});


it('keeps a lost target unavailable until Retry, then recovers without navigating or activating it', async () => {
  anchors(); const user = userEvent.setup(); const navigate = vi.fn(); const close = vi.fn();
  render(<HostWelcomeTour mode="tools" context={introContext} location="overview" blocked={false} onNavigate={navigate} onClose={close} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
  const anchor = document.querySelector<HTMLElement>('[data-host-tour-anchor="overview-task"]')!;
  anchor.hidden = true;
  await waitFor(() => expect(screen.getByRole('button', { name: 'Retry step' })).toBeVisible());
  anchor.hidden = false;
  await act(async () => {});
  expect(screen.getByRole('button', { name: 'Retry step' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Retry step' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
  expect(navigate).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
});


it.each(['Escape', 'Skip tour', 'Close tour'])('visibly restores a connected offscreen invoker on %s without activating it', async control => {
  anchors(); const user = userEvent.setup(); const navigate = vi.fn();
  const invoker = document.createElement('button'); document.body.append(invoker);
  invoker.getBoundingClientRect = () => ({ x: 100, y: 1500, top: 1500, left: 100, right: 300, bottom: 1548, width: 200, height: 48, toJSON() {} });
  invoker.scrollIntoView = vi.fn(); const activate = vi.fn(); invoker.onclick = activate; invoker.focus();
  const close = vi.fn(() => view.unmount());
  const view = render(<HostWelcomeTour mode="tools" context={introContext} location="overview" blocked={false} onNavigate={navigate} onClose={close} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
  if (control === 'Escape') await user.keyboard('{Escape}');
  else await user.click(screen.getByRole('button', { name: control }));
  await waitFor(() => expect(invoker).toHaveFocus());
  expect(invoker.scrollIntoView).toHaveBeenCalled();
  expect(activate).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled(); invoker.remove();
});


it.each(['Escape', 'Skip tour', 'Close tour'])('uses the Overview action when automatic launch has BODY as its invoker on %s', async control => {
  anchors(); const user = userEvent.setup();
  const action = document.createElement('button'); action.dataset.hostTourRecommendedAction = '';
  action.getBoundingClientRect = document.querySelector<HTMLElement>('[data-host-tour-anchor="overview-task"]')!.getBoundingClientRect;
  action.scrollIntoView = vi.fn(); document.body.append(action);
  const navigationControl = document.createElement('button');
  navigationControl.getBoundingClientRect = action.getBoundingClientRect; navigationControl.scrollIntoView = vi.fn();
  document.body.prepend(navigationControl); document.body.focus();
  const bodyRect = vi.spyOn(document.body, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 1024, bottom: 2000, width: 1024, height: 2000, toJSON() {} });
  const close = vi.fn(() => view.unmount());
  const view = render(<HostWelcomeTour mode="tools" context={introContext} location="overview" blocked={false} onNavigate={vi.fn()} onClose={close} />);
  try {
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
    if (control === 'Escape') await user.keyboard('{Escape}');
    else await user.click(screen.getByRole('button', { name: control }));
    await waitFor(() => expect(action).toHaveFocus());
  } finally { bodyRect.mockRestore(); document.body.removeAttribute('tabindex'); navigationControl.remove(); action.remove(); }
});

it('automatically chooses intro and explicit replay selects tools without resetting terminal preference', async () => {
  const { result } = renderHook(() => useHostWelcomeTour({ eventId: 'mode-event', eligible: true }));
  await waitFor(() => expect(result.current.open).toBe(true));
  expect(result.current.mode).toBe('intro');
  act(() => result.current.close('completed'));
  await waitFor(() => expect(result.current.saveFailed).toBe(false));
  act(() => result.current.start('tools'));
  expect(result.current.mode).toBe('tools');
  act(() => result.current.close('dismissed'));
  act(() => result.current.start());
  expect(result.current.mode).toBe('intro');
});

const introContext: HostWelcomeContext = {
  lifecycle: { phase: 'photos-primary', rsvpState: 'disabled', photoIntakeState: 'open', guestAccessEnded: false, entryDisabled: false, lifecycleRecheckAfterMs: null },
  phaseLabel: 'Photo delivery is open', recommendation: { label: 'Open Library', destination: 'library', reason: 'Photo delivery is open.' },
  eventStartLabel: 'September 19 at 5 PM CDT', namedGuests: null, photos: 2, entryAvailability: 'available',
};
it('keeps an introduction and draft when guarded handoff refuses', async () => {
  anchors(); const user = userEvent.setup(); const navigate = vi.fn(); const close = vi.fn();
  const draft = document.createElement('input'); draft.value = 'Unsaved name'; document.body.append(draft);
  const view = render(<HostWelcomeTour mode="intro" context={introContext} location="overview" blocked={false} onNavigate={vi.fn()} onNavigateTask={navigate} onClose={close} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Go to Library' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Go to Library' }));
  expect(navigate).toHaveBeenCalledWith('library');
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Collect photos privately' })).toBeVisible(), { timeout: 2500 });
  expect(close).not.toHaveBeenCalled(); expect(draft.value).toBe('Unsaved name');
  view.unmount(); draft.remove();
});
it('revalidates a stale intro destination and waits for a useful committed target', async () => {
  anchors(); const user = userEvent.setup(); const close = vi.fn(); const navigate = vi.fn();
  const props = { blocked: false, onNavigate: vi.fn(), onNavigateTask: navigate, onClose: close };
  const view = render(<HostWelcomeTour mode="intro" context={introContext} location="overview" {...props} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Go to Library' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Go to Library' }));
  const ended: HostWelcomeContext = { ...introContext, lifecycle: { ...introContext.lifecycle!, guestAccessEnded: true }, recommendation: { label: 'Retrieve originals', reason: 'Guest access has ended.', destination: 'originals' } };
  view.rerender(<HostWelcomeTour mode="intro" context={ended} location="library" {...props} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Go to Exports' })).toBeVisible());
  expect(close).not.toHaveBeenCalled(); expect(navigate).toHaveBeenCalledTimes(1);
});


it('describes the one-screen introduction with the confirmed task and gives its focused heading progress only', () => {
  anchors();
  render(<HostWelcomeTour mode="intro" context={introContext} location="overview" blocked={false} onNavigate={vi.fn()} onClose={vi.fn()} />);
  const dialog = screen.getByRole('dialog', { name: 'Collect photos privately' });
  expect(dialog).toHaveAccessibleDescription(/^Introduction .*Photo delivery is open\. Open Library: Photo delivery is open\./);
  expect(dialog).toHaveAttribute('aria-modal', 'true');
  const heading = screen.getByRole('heading', { name: 'Collect photos privately' });
  expect(heading).toHaveFocus();
  expect(heading).toHaveAccessibleDescription('Introduction');
  expect(screen.queryByText(/Step \d of/)).not.toBeInTheDocument();
});

it('updates the tools description on committed Next and Back while containing keyboard focus', async () => {
  anchors(); const user = userEvent.setup(); const navigate = vi.fn();
  const props = { mode: 'tools' as const, context: introContext, blocked: false, onNavigate: navigate, onClose: vi.fn() };
  const view = render(<HostWelcomeTour {...props} location="overview" />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
  expect(screen.getByRole('dialog')).toHaveAccessibleDescription(/^Step 1 of 6 Photo delivery is open\./);
  expect(screen.getByRole('heading', { name: 'Your next task' })).toHaveAccessibleDescription('Step 1 of 6');
  await user.tab({ shift: true });
  expect(screen.getByRole('button', { name: 'Next' })).toHaveFocus();
  await user.tab(); expect(screen.getByRole('button', { name: 'Close tour' })).toHaveFocus();
  await user.click(screen.getByRole('button', { name: 'Next' }));
  view.rerender(<HostWelcomeTour {...props} location="rsvp" />);
  const title = await screen.findByRole('heading', { name: 'Your guest list' });
  await waitFor(() => expect(title).toHaveFocus());
  expect(screen.getByRole('dialog')).toHaveAccessibleDescription(/^Step 2 of 6 Review your guest list/);
  expect(title).toHaveAccessibleDescription('Step 2 of 6');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Back' }));
  view.rerender(<HostWelcomeTour {...props} location="overview" />);
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Your next task' })).toHaveFocus());
  expect(screen.getByRole('dialog')).toHaveAccessibleDescription(/^Step 1 of 6 Photo delivery is open\./);
  expect(screen.getByRole('heading', { name: 'Your next task' })).toHaveAccessibleDescription('Step 1 of 6');
});

it('keeps missing-target and failed-preference recovery in one status inside the active dialog', async () => {
  const user = userEvent.setup(); const retrySave = vi.fn();
  render(<HostWelcomeTour mode="tools" context={introContext} location="overview" blocked={false} saveFailed onRetrySave={retrySave} onNavigate={vi.fn()} onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Retry step' })).toBeVisible(), { timeout: 2500 });
  const dialog = screen.getByRole('dialog');
  const status = screen.getByRole('status');
  expect(dialog).toContainElement(status);
  expect(status).toHaveTextContent('This part of the page is not available yet.');
  expect(status).toHaveTextContent('Your tour preference could not be saved.');
  expect(screen.getByRole('heading', { name: 'Your next task' })).toHaveFocus();
  await user.click(screen.getByRole('button', { name: 'Retry saving tour preference' }));
  expect(retrySave).toHaveBeenCalledOnce();
});

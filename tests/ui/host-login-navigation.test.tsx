import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HostSessionEventView, HostSessionResponse } from '../../shared/contracts';
import { HostEventsPage } from '../../src/pages/HostEventsPage';
import { HostLoginPage } from '../../src/pages/HostLoginPage';

const EVENT_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_EVENT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const MANAGER = `/manage/event/${EVENT_ID}`;
const ACCOUNT: HostSessionResponse['account'] = {
  id: 'account-a', email: 'host@example.com', displayName: null,
  emailVerified: true, notificationsEnabled: true,
};
const EVENT: HostSessionEventView = {
  id: EVENT_ID, name: 'Maya & Theo', slug: 'maya-theo', eventDate: '2026-09-19',
  eventTimezone: 'America/Chicago', storedMediaCount: 3,
  managementAccessExpiresAt: '2026-10-19T00:00:00.000Z',
};

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(status >= 400
    ? { ...(data as object), requestId: 'auth-landing' }
    : { data, requestId: 'auth-landing' }), {
    status, headers: { 'content-type': 'application/json' },
  });
}

function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function setup(options: {
  path?: string;
  events?: HostSessionEventView[];
  account?: HostSessionResponse['account'];
  login?: () => Promise<Response>;
  session?: () => Promise<Response>;
  adopt?: () => Promise<Response>;
} = {}) {
  const requests: Array<{ path: string; method: string; body: unknown }> = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    requests.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
    if (path === '/api/host/login') return options.login?.() ?? Promise.resolve(response({ account: ACCOUNT }));
    if (path === '/api/host/password/forgot') return Promise.resolve(response({ requested: true }));
    // The reset endpoint confirms the session but does not return an account ID.
    if (path === '/api/host/password/reset') return Promise.resolve(response({ reset: true }));
    if (path === '/api/host/session') return options.session?.() ?? Promise.resolve(response({
      account: options.account ?? ACCOUNT, events: options.events ?? [EVENT],
    } satisfies HostSessionResponse));
    if (path === `/api/host/events/${EVENT_ID}/adopt`) return options.adopt?.() ?? Promise.resolve(response({ adopted: true }));
    if (path === `/api/manage/events/${EVENT_ID}`) return Promise.resolve(response({ event: EVENT }));
    if (path === '/api/host/preferences') return Promise.resolve(response({ notificationsEnabled: false }));
    throw new Error('Unexpected request ' + path);
  });
  vi.stubGlobal('fetch', fetchMock);
  const router = createMemoryRouter([
    { path: '/host/login', element: <HostLoginPage /> },
    { path: '/host/events', element: <HostEventsPage /> },
    // These destinations expose the real pages' navigation without unrelated
    // Manager resource requests or tour behavior in this focused routing suite.
    { path: '/manage/event/:eventId', element: <main><h1>Event manager</h1></main> },
    { path: '/create', element: <main><h1>Create an event</h1></main> },
    { path: '/', element: <main><h1>Home</h1></main> },
  ], { initialEntries: [options.path ?? '/host/login'] });
  const historyStates: unknown[] = [];
  const unsubscribe = router.subscribe((state) => { historyStates.push(state.location.state); });
  render(<RouterProvider router={router} />);
  return { router, requests, fetchMock, historyStates, unsubscribe };
}

async function signIn() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Email address'), ACCOUNT.email);
  await user.type(screen.getByLabelText('Password'), 'a-sufficiently-long-password');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  return user;
}

async function resetPassword(email = ACCOUNT.email) {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Forgotten your password?' }));
  await user.type(screen.getByLabelText('Email address'), email);
  await user.click(screen.getByRole('button', { name: 'Send reset code' }));
  await screen.findByRole('heading', { name: 'Choose a new password' });
  await user.type(screen.getByLabelText('Confirmation code'), '424242');
  await user.type(screen.getByLabelText('New password'), 'a-sufficiently-new-password');
  await user.click(screen.getByRole('button', { name: 'Set new password' }));
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('authenticated host landing', () => {
  it('opens a solitary saved event at Overview after ordinary sign-in with one session lookup', async () => {
    const { router, requests, historyStates } = setup();
    await signIn();

    await screen.findByRole('heading', { name: 'Event manager' });
    expect(router.state.location.pathname + router.state.location.search).toBe(`${MANAGER}?section=overview`);
    expect(requests.filter(({ path }) => path === '/api/host/session')).toHaveLength(1);
    expect(requests.filter(({ method }) => method !== 'GET').map(({ path }) => path)).toEqual(['/api/host/login']);
    expect(JSON.stringify(historyStates)).not.toContain(ACCOUNT.email);
    expect(router.state.location.state).toBeNull();
  });

  it('uses the same single-event landing after password reset without retaining the email in history', async () => {
    const { router, requests, historyStates } = setup();
    await resetPassword('HOST@EXAMPLE.COM');

    await screen.findByRole('heading', { name: 'Event manager' });
    expect(router.state.location.pathname + router.state.location.search).toBe(`${MANAGER}?section=overview`);
    expect(requests.filter(({ path }) => path === '/api/host/session')).toHaveLength(1);
    expect(requests.find(({ path }) => path === '/api/host/password/reset')?.body).toEqual({
      email: 'HOST@EXAMPLE.COM', code: '424242', password: 'a-sufficiently-new-password',
    });
    expect(JSON.stringify(historyStates)).not.toMatch(/host@example\.com/i);
    expect(router.state.location.state).toBeNull();
  });

  it.each([
    ['no saved events', []],
    ['multiple saved events', [EVENT, { ...EVENT, id: OTHER_EVENT_ID, name: 'Second event' }]],
  ] as const)('keeps the event dashboard after sign-in with %s', async (_case, events) => {
    const { router, requests } = setup({ events: [...events] });
    await signIn();
    expect(await screen.findByRole('heading', { name: 'Your events' })).toBeVisible();
    expect(router.state.location.pathname).toBe('/host/events');
    expect(router.state.location.state).toBeNull();
    expect(requests.filter(({ path }) => path === '/api/host/session')).toHaveLength(1);
  });

  it.each(['signin', 'reset'] as const)('preserves an explicit Host Events return after %s for a single-event account', async mode => {
    const { router } = setup({ path: '/host/login?returnTo=%2Fhost%2Fevents' });
    if (mode === 'signin') await signIn(); else await resetPassword();
    expect(await screen.findByRole('heading', { name: 'Your events' })).toBeVisible();
    expect(router.state.location.pathname).toBe('/host/events');
    expect(screen.getByRole('checkbox', { name: 'Send me event emails' })).toBeEnabled();
  });

  it.each(['signin', 'reset'] as const)('preserves a validated Manager deep link after %s', async mode => {
    const destination = `${MANAGER}?section=gallery&mode=guest-gallery`;
    const { router, requests } = setup({ path: '/host/login?returnTo=' + encodeURIComponent(destination) });
    if (mode === 'signin') await signIn(); else await resetPassword();
    await screen.findByRole('heading', { name: 'Event manager' });
    expect(router.state.location.pathname + router.state.location.search).toBe(destination);
    expect(requests.some(({ path }) => path === '/api/host/session')).toBe(false);
  });

  it('ignores an invalid explicit return and uses the authenticated single-event destination', async () => {
    const { router } = setup({ path: '/host/login?returnTo=https%3A%2F%2Felsewhere.example%2Fmanage' });
    await signIn();
    await screen.findByRole('heading', { name: 'Event manager' });
    expect(router.state.location.pathname + router.state.location.search).toBe(`${MANAGER}?section=overview`);
  });

  it('waits for event adoption before following a validated return', async () => {
    const adopt = deferred();
    const { router, requests } = setup({
      path: `/host/login?returnTo=${encodeURIComponent(MANAGER + '?section=share')}&adopt=${EVENT_ID}`,
      adopt: () => adopt.promise,
    });
    await signIn();
    await waitFor(() => expect(requests.some(({ path }) => path.endsWith('/adopt'))).toBe(true));
    expect(router.state.location.pathname).toBe('/host/login');
    expect(screen.getByRole('button', { name: 'Working…' })).toBeDisabled();
    await act(async () => { adopt.resolve(response({ adopted: true })); });
    await screen.findByRole('heading', { name: 'Event manager' });
    expect(router.state.location.search).toBe('?section=share');
    expect(requests.some(({ path }) => path === '/api/host/session')).toBe(false);
  });

  it.each(['signin', 'reset'] as const)('keeps an adoption failure visible after %s without navigating', async mode => {
    const { router, requests } = setup({
      path: `/host/login?returnTo=${encodeURIComponent(MANAGER)}&adopt=${EVENT_ID}`,
      adopt: () => Promise.resolve(response({ code: 'FORBIDDEN', message: 'This event cannot be added.' }, 403)),
    });
    if (mode === 'signin') await signIn(); else await resetPassword();
    expect(await screen.findByRole('alert')).toHaveTextContent(/signed in, but this event was not added.*cannot be added/i);
    expect(router.state.location.pathname).toBe('/host/login');
    expect(requests.some(({ path }) => path === '/api/host/session')).toBe(false);
  });

  it('retains session lookup failure and retries without repeating authentication', async () => {
    let reads = 0;
    const { router, requests } = setup({ session: () => Promise.resolve(++reads === 1
      ? response({ code: 'INTERNAL_ERROR', message: 'Your account could not be loaded.' }, 503)
      : response({ account: ACCOUNT, events: [EVENT] })) });
    const user = await signIn();
    expect(await screen.findByRole('alert')).toHaveTextContent('Your account could not be loaded.');
    expect(router.state.location.pathname).toBe('/host/events');
    expect(router.state.location.state).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('heading', { name: 'Event manager' });
    expect(router.state.location.search).toBe('?section=overview');
    expect(requests.filter(({ path }) => path === '/api/host/login')).toHaveLength(1);
    expect(requests.filter(({ path }) => path === '/api/host/session')).toHaveLength(2);
  });

  it.each(['signin', 'reset'] as const)('shows the authenticated dashboard instead of redirecting a mismatched %s identity', async mode => {
    const { router } = setup({ account: { ...ACCOUNT, id: 'account-b', email: 'other@example.com' } });
    if (mode === 'signin') await signIn(); else await resetPassword();
    expect(await screen.findByRole('heading', { name: 'Your events' })).toBeVisible();
    expect(screen.getByText('other@example.com')).toBeVisible();
    expect(router.state.location.pathname).toBe('/host/events');
    expect(router.state.location.state).toBeNull();
  });

  it('keeps the normal dashboard if the password reset identity digest cannot be computed', async () => {
    const { router } = setup();
    vi.stubGlobal('crypto', { subtle: { digest: vi.fn().mockRejectedValue(new Error('Digest unavailable')) } });
    await resetPassword();
    expect(await screen.findByRole('heading', { name: 'Your events' })).toBeVisible();
    expect(router.state.location.pathname).toBe('/host/events');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps direct Host Events usable for account settings with a single saved event', async () => {
    const { router } = setup({ path: '/host/events' });
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Your events' });
    await user.click(screen.getByRole('checkbox', { name: 'Send me event emails' }));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Send me event emails' })).not.toBeChecked());
    expect(router.state.location.pathname).toBe('/host/events');
  });

  it('preserves direct Host Events as the return destination when its session requires sign-in', async () => {
    let reads = 0;
    const { router } = setup({
      path: '/host/events', session: () => Promise.resolve(++reads === 1
        ? response({ code: 'HOST_SESSION_REQUIRED', message: 'Sign in required.' }, 401)
        : response({ account: ACCOUNT, events: [EVENT] })),
    });
    await screen.findByRole('heading', { name: 'Sign in to your events' });
    expect(new URLSearchParams(router.state.location.search).get('returnTo')).toBe('/host/events');
    await signIn();
    expect(await screen.findByRole('heading', { name: 'Your events' })).toBeVisible();
    expect(router.state.location.pathname).toBe('/host/events');
  });

  it('does not replace navigation away when a pending session lookup resolves', async () => {
    const session = deferred();
    const { router, requests } = setup({ session: () => session.promise });
    await signIn();
    await waitFor(() => expect(requests.some(({ path }) => path === '/api/host/session')).toBe(true));
    await act(async () => { await router.navigate('/create'); });
    await act(async () => { session.resolve(response({ account: ACCOUNT, events: [EVENT] })); });
    expect(screen.getByRole('heading', { name: 'Create an event' })).toBeVisible();
    expect(router.state.location.pathname).toBe('/create');
  });

  it('retires a pending implicit landing when the user navigates directly to Host Events', async () => {
    const stale = deferred();
    let reads = 0;
    const { router, requests } = setup({ session: () => ++reads === 1
      ? stale.promise : Promise.resolve(response({ account: ACCOUNT, events: [EVENT] })) });
    await signIn();
    await waitFor(() => expect(requests.some(({ path }) => path === '/api/host/session')).toBe(true));
    await act(async () => { await router.navigate('/host/events'); });
    expect(await screen.findByRole('heading', { name: 'Your events' })).toBeVisible();
    await act(async () => { stale.resolve(response({ account: ACCOUNT, events: [EVENT] })); });
    expect(router.state.location.pathname).toBe('/host/events');
    expect(router.state.location.state).toBeNull();
  });

  it('does not replay a consumed implicit landing when returning after leaving a pending lookup', async () => {
    const stale = deferred();
    let reads = 0;
    const { router, requests } = setup({ session: () => ++reads === 1
      ? stale.promise : Promise.resolve(response({ account: ACCOUNT, events: [EVENT] })) });
    await signIn();
    await waitFor(() => expect(requests.some(({ path }) => path === '/api/host/session')).toBe(true));
    await act(async () => { await router.navigate('/create'); });
    await act(async () => { await router.navigate(-1); });
    expect(await screen.findByRole('heading', { name: 'Your events' })).toBeVisible();
    await act(async () => { stale.resolve(response({ account: ACCOUNT, events: [EVENT] })); });
    expect(router.state.location.pathname).toBe('/host/events');
  });

  it('does not replace a newer navigation when sign-in finishes after the user leaves', async () => {
    const login = deferred();
    const { router, requests } = setup({ login: () => login.promise });
    const user = await signIn();
    await user.click(screen.getByRole('link', { name: 'Create a new event' }));
    await act(async () => { login.resolve(response({ account: ACCOUNT })); });
    expect(screen.getByRole('heading', { name: 'Create an event' })).toBeVisible();
    expect(router.state.location.pathname).toBe('/create');
    expect(requests.some(({ path }) => path === '/api/host/session')).toBe(false);
  });

  it('does not follow a stale return if the login URL changes while sign-in is pending', async () => {
    const login = deferred();
    const { router, requests } = setup({ login: () => login.promise });
    await signIn();
    await act(async () => { await router.navigate('/host/login?returnTo=%2Fhost%2Fevents'); });
    await act(async () => { login.resolve(response({ account: ACCOUNT })); });
    expect(screen.getByRole('heading', { name: 'Sign in to your events' })).toBeVisible();
    expect(router.state.location.pathname).toBe('/host/login');
    expect(router.state.location.search).toBe('?returnTo=%2Fhost%2Fevents');
    expect(requests.some(({ path }) => path === '/api/host/session')).toBe(false);
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });
});

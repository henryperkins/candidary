import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAppRouter } from '../../src/app/router';
import { HostAccountPanel } from '../../src/components/HostAccountPanel';

const PENDING_REGISTRATION_KEY = 'candidary.pending-registration.v1';
const EMAIL_DIGEST = '61c0ee79db216f84107d8d2d7bfb35266f66b06773a99a0786e3a173ffe920ee';
const FIRST_EXPIRY = '2099-01-01T00:15:00.000Z';
const SECOND_EXPIRY = '2099-01-01T00:30:00.000Z';

function json(data: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify({ data, requestId: 'request-auth' }), {
    status,
    headers: { 'content-type': 'application/json' },
  }));
}

function errorJson(message: string, status = 502): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify({
    code: 'LOGIN_EMAIL_UNDELIVERABLE',
    message,
    requestId: 'request-auth',
  }), {
    status,
    headers: { 'content-type': 'application/json' },
  }));
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function seedPendingMarker(expiresAt = FIRST_EXPIRY): void {
  localStorage.setItem(PENDING_REGISTRATION_KEY, JSON.stringify({
    version: 1,
    emailDigest: EMAIL_DIGEST,
    expiresAt,
  }));
}

function wholeLocalStoragePayload(): string {
  return JSON.stringify(Object.fromEntries(
    Array.from({ length: localStorage.length }, (_, index) => {
      const key = localStorage.key(index)!;
      return [key, localStorage.getItem(key)];
    }),
  ));
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.cookie = 'candidary_registration=; Max-Age=0; Path=/';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('pending registration pages', () => {
  it('stores none of the five forbidden secrets through full registration and sign-in submits', async () => {
    const rawEmail = 'Host@Example.com';
    const registrationPassword = 'registration-password-distinctive';
    const confirmationCode = '482951';
    const challengeId = 'challenge-id-distinctive-193';
    const browserSecret = 'browser-secret-distinctive-719';
    const loginEmail = 'signed-in@example.com';
    const loginPassword = 'login-password-distinctive';
    document.cookie = `candidary_registration=${challengeId}.${browserSecret}; Path=/`;
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      const path = String(url);
      requests.push(path);
      if (path === '/api/host/register') {
        return json({ registrationPending: true, resumeExpiresAt: FIRST_EXPIRY }, 202);
      }
      if (path === '/api/host/register/complete') {
        return json({ registered: true, boundEvent: false });
      }
      if (path === '/api/host/login') return json({ account: { id: 'account-a' } });
      if (path === '/api/host/session') {
        return json({
          account: {
            id: 'account-a',
            email: loginEmail,
            displayName: null,
            emailVerified: true,
            notificationsEnabled: true,
          },
          events: [],
        });
      }
      return json({});
    }));
    const router = createAppRouter(['/host/register']);
    render(<RouterProvider router={router} />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Email address'), rawEmail);
    await user.type(screen.getByLabelText('Password'), registrationPassword);
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    await screen.findByRole('heading', { name: 'Check your email.' });
    await user.type(screen.getByLabelText('Confirmation code'), confirmationCode);

    expect(JSON.parse(localStorage.getItem(PENDING_REGISTRATION_KEY)!)).toMatchObject({
      emailDigest: EMAIL_DIGEST,
      expiresAt: FIRST_EXPIRY,
    });
    let stored = wholeLocalStoragePayload();
    expect(stored).not.toContain(rawEmail);
    expect(stored).not.toContain(registrationPassword);
    expect(stored).not.toContain(confirmationCode);
    expect(stored).not.toContain(browserSecret);
    expect(stored).not.toContain(challengeId);

    await user.click(screen.getByRole('button', { name: 'Confirm my email' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/host/events'));
    expect(localStorage.getItem(PENDING_REGISTRATION_KEY)).toBeNull();
    expect(requests.filter((path) => path === '/api/host/register/complete')).toHaveLength(1);

    cleanup();
    const loginRouter = createAppRouter(['/host/login']);
    render(<RouterProvider router={loginRouter} />);
    const loginUser = userEvent.setup();
    await loginUser.type(screen.getByLabelText('Email address'), loginEmail);
    await loginUser.type(screen.getByLabelText('Password'), loginPassword);
    await loginUser.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(requests).toContain('/api/host/login'));
    expect(requests.filter((path) => path === '/api/host/register/complete')).toHaveLength(1);

    stored = wholeLocalStoragePayload();
    expect(stored).not.toContain(loginEmail);
    expect(stored).not.toContain(loginPassword);
    expect(stored).not.toContain(confirmationCode);
    expect(stored).not.toContain(browserSecret);
    expect(stored).not.toContain(challengeId);
  });

  it('intercepts a matching password submit across mounts, reloads pending, and clears on Start over', async () => {
    seedPendingMarker();
    const requests: Array<{ path: string; body: BodyInit | null | undefined }> = [];
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      const path = String(url);
      requests.push({ path, body: init?.body });
      if (path === '/api/host/register/pending') {
        return json({ pending: true, expiresAt: FIRST_EXPIRY });
      }
      if (path === '/api/host/login') throw new Error('Password request must not be issued.');
      return json({});
    }));
    const router = createAppRouter(['/host/login']);
    render(<RouterProvider router={router} />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Email address'), ' HOST@example.com ');
    await user.type(screen.getByLabelText('Password'), 'never-send-this-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/host/register'));
    expect(router.state.location.search).toBe('?pending=1');
    expect(requests.filter(({ path }) => path === '/api/host/register/pending')).toEqual([
      { path: '/api/host/register/pending', body: undefined },
    ]);
    expect(requests.some(({ path }) => path === '/api/host/login')).toBe(false);

    cleanup();
    const reloaded = createAppRouter(['/host/register?pending=1']);
    render(<RouterProvider router={reloaded} />);
    expect(screen.getByRole('heading', { name: 'Check your email.' })).toBeVisible();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Start over' }));
    await screen.findByRole('heading', { name: 'Create your account' });
    expect(localStorage.getItem(PENDING_REGISTRATION_KEY)).toBeNull();
  });

  it.each([
    ['server reports false', FIRST_EXPIRY, 1],
    ['local marker is expired', '2000-01-01T00:00:00.000Z', 0],
  ])('clears when %s and issues exactly one ordinary sign-in', async (
    _case,
    expiresAt,
    expectedPendingRequests,
  ) => {
    seedPendingMarker(expiresAt);
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      const path = String(url);
      requests.push(path);
      if (path === '/api/host/register/pending') {
        return json({ pending: false, expiresAt: null });
      }
      if (path === '/api/host/login') return json({ account: { id: 'account-a' } });
      if (path === '/api/host/session') {
        return json({
          account: {
            id: 'account-a', email: 'host@example.com', displayName: null,
            emailVerified: true, notificationsEnabled: true,
          },
          events: [],
        });
      }
      return json({});
    }));
    const router = createAppRouter(['/host/login']);
    render(<RouterProvider router={router} />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Email address'), 'host@example.com');
    await user.type(screen.getByLabelText('Password'), 'ordinary-sign-in-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(requests.filter((path) => path === '/api/host/login')).toHaveLength(1));
    expect(requests.filter((path) => path === '/api/host/register/pending'))
      .toHaveLength(expectedPendingRequests);
    expect(localStorage.getItem(PENDING_REGISTRATION_KEY)).toBeNull();
  });

  it('clears a pending registration marker when registration is explicitly restarted', async () => {
    seedPendingMarker();

    render(<RouterProvider router={createAppRouter(['/host/register'])} />);

    await waitFor(() => expect(localStorage.getItem(PENDING_REGISTRATION_KEY)).toBeNull());
    expect(screen.getByText(/account is created only after you confirm/i)).toBeVisible();
  });

  it('invokes start and resend persistence callbacks only after each API resolution', async () => {
    const start = deferredResponse();
    const resend = deferredResponse();
    let request = 0;
    vi.stubGlobal('fetch', vi.fn(() => {
      request += 1;
      if (request === 1) return start.promise;
      if (request === 2) return resend.promise;
      return errorJson('That code could not be sent.');
    }));
    const onRegistrationPending = vi.fn();
    const onRegistrationResent = vi.fn();
    const onStarted = vi.fn();
    render(<HostAccountPanel
      onRegistrationPending={onRegistrationPending}
      onRegistrationResent={onRegistrationResent}
      onStarted={onStarted}
    />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Email address'), ' Host@Example.com ');
    await user.type(screen.getByLabelText('Password'), 'callback-order-password');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(onRegistrationPending).not.toHaveBeenCalled();
    expect(onStarted).not.toHaveBeenCalled();

    start.resolve(new Response(JSON.stringify({
      data: { registrationPending: true, resumeExpiresAt: FIRST_EXPIRY },
      requestId: 'request-start',
    }), { status: 202, headers: { 'content-type': 'application/json' } }));
    await waitFor(() => expect(onRegistrationPending).toHaveBeenCalledWith({
      email: 'host@example.com',
      resumeExpiresAt: FIRST_EXPIRY,
    }));
    expect(onStarted).toHaveBeenCalledOnce();
    expect(onRegistrationResent).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Send another code' }));
    expect(onRegistrationResent).not.toHaveBeenCalled();
    resend.resolve(new Response(JSON.stringify({
      data: { registrationPending: true, resumeExpiresAt: SECOND_EXPIRY },
      requestId: 'request-resend',
    }), { status: 202, headers: { 'content-type': 'application/json' } }));
    await waitFor(() => expect(onRegistrationResent).toHaveBeenCalledWith({
      resumeExpiresAt: SECOND_EXPIRY,
    }));

    await user.click(screen.getByRole('button', { name: 'Send another code' }));
    await screen.findByText('That code could not be sent.');
    expect(onRegistrationResent).toHaveBeenCalledTimes(1);
    expect(onRegistrationPending).toHaveBeenCalledTimes(1);
  });

  it('preserves the digest on a reload resend and leaves every byte stable on failure', async () => {
    seedPendingMarker();
    let resend = 0;
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (String(url) !== '/api/host/register/resend') return json({});
      resend += 1;
      return resend === 1
        ? json({ registrationPending: true, resumeExpiresAt: SECOND_EXPIRY }, 202)
        : errorJson('That code could not be sent.');
    }));
    render(<RouterProvider router={createAppRouter(['/host/register?pending=1'])} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Send another code' }));
    await screen.findByText('A new code is on its way.');
    expect(JSON.parse(localStorage.getItem(PENDING_REGISTRATION_KEY)!)).toMatchObject({
      emailDigest: EMAIL_DIGEST,
      expiresAt: SECOND_EXPIRY,
    });
    const beforeFailure = localStorage.getItem(PENDING_REGISTRATION_KEY);

    await user.click(screen.getByRole('button', { name: 'Send another code' }));
    await screen.findByText('That code could not be sent.');
    expect(localStorage.getItem(PENDING_REGISTRATION_KEY)).toBe(beforeFailure);
  });
});

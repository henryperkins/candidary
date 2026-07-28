import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

import type { SecretToken } from '../security/crypto';
import type { AppBindings } from '../env';

// The two credentials are held side by side rather than in one slot. A host who is
// signed in and then opens a management link — their own, or one a couple handed
// them — must not be silently signed out of their account, and the reverse flow
// has to keep working for a planner who has no account at all.
export type CookieScope = 'event' | 'host';
const REGISTRATION_COOKIE = 'candidary_registration';

const COOKIE_NAMES = {
  event: { session: 'candidary_session', csrf: 'candidary_csrf' },
  host: { session: 'candidary_host', csrf: 'candidary_host_csrf' },
} as const satisfies Record<CookieScope, { session: string; csrf: string }>;

export function setSessionCookies(
  context: Context<AppBindings>,
  scope: CookieScope,
  session: SecretToken,
  csrfToken: string,
  maxAgeSeconds: number,
): void {
  const names = COOKIE_NAMES[scope];
  setCookie(context, names.session, session.token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: maxAgeSeconds,
  });
  setCookie(context, names.csrf, csrfToken, {
    httpOnly: false,
    secure: true,
    sameSite: 'Strict',
    path: '/',
    maxAge: maxAgeSeconds,
  });
}

export function clearSessionCookies(context: Context<AppBindings>, scope: CookieScope): void {
  const names = COOKIE_NAMES[scope];
  deleteCookie(context, names.session, { path: '/', secure: true });
  deleteCookie(context, names.csrf, { path: '/', secure: true });
}

export function getSessionCookie(
  context: Context<AppBindings>,
  scope: CookieScope = 'event',
): string | undefined {
  return getCookie(context, COOKIE_NAMES[scope].session);
}

export function getCsrfCookie(
  context: Context<AppBindings>,
  scope: CookieScope = 'event',
): string | undefined {
  return getCookie(context, COOKIE_NAMES[scope].csrf);
}

export function setRegistrationCookie(
  context: Context<AppBindings>,
  registration: SecretToken,
  maxAgeSeconds = 15 * 60,
): void {
  setCookie(context, REGISTRATION_COOKIE, registration.token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: maxAgeSeconds,
  });
}

export function getRegistrationCookie(context: Context<AppBindings>): string | undefined {
  return getCookie(context, REGISTRATION_COOKIE);
}

export function clearRegistrationCookie(context: Context<AppBindings>): void {
  deleteCookie(context, REGISTRATION_COOKIE, {
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'Lax',
  });
}

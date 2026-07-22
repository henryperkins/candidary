import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';

import type { SecretToken } from '../security/crypto';
import type { AppBindings } from '../env';

const SESSION_COOKIE = 'candidary_session';
const CSRF_COOKIE = 'candidary_csrf';

export function setSessionCookies(
  context: Context<AppBindings>,
  session: SecretToken,
  csrfToken: string,
  maxAgeSeconds: number,
): void {
  setCookie(context, SESSION_COOKIE, session.token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: maxAgeSeconds,
  });
  setCookie(context, CSRF_COOKIE, csrfToken, {
    httpOnly: false,
    secure: true,
    sameSite: 'Strict',
    path: '/',
    maxAge: maxAgeSeconds,
  });
}

export function getSessionCookie(context: Context<AppBindings>): string | undefined {
  return getCookie(context, SESSION_COOKIE);
}

export function getCsrfCookie(context: Context<AppBindings>): string | undefined {
  return getCookie(context, CSRF_COOKIE);
}


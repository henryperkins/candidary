import { Hono, type Context } from 'hono';

import type { Role } from '../../shared/contracts';
import { failureDecisionForCode } from '../../shared/load-failure';
import { ApiError } from '../../shared/errors';
import type { AppBindings } from '../env';
import { canonicalOrigin, isApplicationOrigin, requestOrigin } from '../origins';
import { setSessionCookies } from '../http/cookies';
import { AuthService } from '../auth/service';
import { EventEntryService } from '../services/event-entry';

export const exchangeRoutes = new Hono<AppBindings>();

/**
 * Refuses a credential exchange on a hostname this deployment does not answer
 * on, before the credential is read.
 *
 * These two routes are the only places a bearer credential becomes a session
 * through a `GET`, and a `GET` navigation carries no `Origin` header — so
 * `assertRequestOrigin` cannot cover them, and every other guard in the app runs
 * after the session already exists. Without this the Worker mints a real session
 * on any hostname routed to it: `workers_dev` is on, per-version preview URLs
 * are public, and both are bound to the production database. Writes from there
 * would fail `ORIGIN_FORBIDDEN`, but the session still reads, and a manager
 * session reads event data and re-displays the printed entry credential.
 *
 * Sends the browser to the canonical origin's own recovery page and drops the
 * credential rather than forwarding it. No printed credential names a hostname
 * outside the allow-list, so there is nothing legitimate to carry over, and
 * carrying it would put the secret in a second host's request line to reach a
 * session it should not have started. The holder lands on the real site and can
 * paste their link there.
 */
function refuseExchangeOffApplicationHost(
  context: Context<AppBindings>,
  recoveryPath: string,
): Response | null {
  if (isApplicationOrigin(context.env, new URL(context.req.url).origin)) return null;
  return context.redirect(`${canonicalOrigin(context.env)}${recoveryPath}`, 302);
}

export function isDocumentNavigation(request: Request): boolean {
  return request.headers.get('sec-fetch-mode') === 'navigate'
    || (request.headers.get('accept') ?? '').toLowerCase().includes('text/html');
}

export function classifyExchangeFailure(
  error: unknown,
): 'latest-link' | 'ended-event' | 'retry' {
  if (!(error instanceof ApiError)) return 'retry';
  const kind = failureDecisionForCode(error.code).kind;
  if (kind === 'latest-link' || kind === 'ended-event') return kind;
  return 'retry';
}

async function exchange(context: Context<AppBindings>, role: Role) {
  const exchanged = await new AuthService(context.env).exchange(context.req.param('token') ?? '', role);
  const maxAge = Math.max(1, Math.floor((Date.parse(exchanged.session.expiresAt) - Date.now()) / 1000));
  setSessionCookies(context, 'event', exchanged.sessionToken, exchanged.csrfToken, maxAge);
  const location = role === 'guest'
    ? `/event/${exchanged.event.slug}`
    : `/manage/event/${exchanged.event.id}`;
  return context.redirect(location, 302);
}

/**
 * The path form printed on invitations before 0008.
 *
 * Guest entry moved to `/join#<credential>` because a fragment never reaches a
 * request line, a `Referer`, or an access log. This path does, which is the
 * reason it is not how anything is issued any more — but a QR already printed on
 * a sign cannot be recalled, so it keeps resolving for the events that carry it.
 *
 * It is not a second authority. The token is adopted as the event's entry
 * credential on first use and then verified through the same `exchangeEntry` as
 * the fragment form, so disabling the entry stops it and signing guest devices
 * out does not. Every failure lands on the same token-free page, and nothing
 * here logs the credential it was handed.
 */
exchangeRoutes.get('/join/:token', async (context) => {
  const raw = context.req.param('token') ?? '';
  context.header('Cache-Control', 'no-store');
  const offHost = refuseExchangeOffApplicationHost(context, '/recover/event-entry?kind=unavailable');
  if (offHost) return offHost;
  try {
    const entries = new EventEntryService(context.env, requestOrigin(context));
    await entries.adoptPrintedToken(raw);
    // A credential issued after 0008 is a fragment credential and is refused
    // here even when it is otherwise valid, so this path cannot become a second,
    // leakier way to use the codes printed since.
    if (!await entries.isPrintedPathCredential(raw)) {
      return context.redirect('/recover/event-entry?kind=unavailable', 302);
    }
    const exchanged = await new AuthService(context.env).exchangeEntry(raw);
    const maxAge = Math.max(
      1,
      Math.floor((Date.parse(exchanged.session.expiresAt) - Date.now()) / 1000),
    );
    setSessionCookies(context, 'event', exchanged.sessionToken, exchanged.csrfToken, maxAge);
    return context.redirect(`/event/${exchanged.event.slug}`, 302);
  } catch {
    return context.redirect('/recover/event-entry?kind=unavailable', 302);
  }
});
exchangeRoutes.get('/manage/:token', async (context) => {
  // Ahead of the try, so a refused host is never classified as an exchange
  // failure the holder could be told to retry.
  const offHost = refuseExchangeOffApplicationHost(context, '/recover/manage?kind=latest-link');
  if (offHost) return offHost;
  try {
    return await exchange(context, 'manager');
  } catch (error) {
    if (!isDocumentNavigation(context.req.raw)) throw error;
    if (!(error instanceof ApiError)) {
      // Preserve token-free document recovery without logging the bearer token or
      // an exception message that may contain request data.
      console.error(JSON.stringify({
        event: 'manager_exchange_failed',
        requestId: context.get('requestId'),
        errorName: error instanceof Error ? error.name : 'UnknownError',
      }));
    }
    return context.redirect(`/recover/manage?kind=${classifyExchangeFailure(error)}`, 302);
  }
});

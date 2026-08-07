import type { Context } from 'hono';

import { normalizeOrigin, parseOriginList } from '../shared/origins';
import type { AppBindings, AppEnv } from './env';

/**
 * The one origin every mailed link is built from.
 *
 * Mail is the reason this stays a single value rather than "whichever host the
 * request arrived on". A notification is composed by the hourly Cron, where there
 * is no request at all, and a `From` domain that differs from the domain of the
 * links inside the message reads as a phishing attempt to the host being asked to
 * click a login code — nothing fails loudly, so the drift is only visible to the
 * person deciding whether to trust it.
 */
export function canonicalOrigin(env: AppEnv): string {
  return normalizeOrigin(env.APP_ORIGIN) ?? env.APP_ORIGIN.replace(/\/$/u, '');
}

/**
 * Every origin this deployment answers on, canonical first.
 *
 * Deduped, because naming the canonical origin again in `ALTERNATE_ORIGINS` is a
 * harmless thing to do to a config file and must not double a comparison.
 */
export function applicationOrigins(env: AppEnv): string[] {
  return [...new Set([canonicalOrigin(env), ...parseOriginList(env.ALTERNATE_ORIGINS)])];
}

export function isApplicationOrigin(env: AppEnv, value: string | undefined | null): boolean {
  const origin = normalizeOrigin(value);
  return origin !== null && applicationOrigins(env).includes(origin);
}

/**
 * The origin to build a link on while answering this request.
 *
 * Read from the request URL rather than the `Origin` header, because a `GET`
 * navigation carries no `Origin` and the host a request actually arrived on is
 * the one whose page, cookies, and QR the guest or host is looking at. A host
 * who works on one origin gets links on it, instead of a management link that
 * bounces their browser to the other domain mid-session.
 *
 * An unrecognized host falls back to the canonical origin rather than echoing
 * itself. The committed configuration disables public Workers development
 * routes because uploaded versions use the production bindings, but this check
 * remains the safe boundary if a dashboard change or another upload ever routes
 * an extra hostname here. Echoing one back would put that hostname into a
 * printed QR or a management link a host then saves.
 */
export function requestOrigin(context: Context<AppBindings>): string {
  const origin = new URL(context.req.url).origin;
  return isApplicationOrigin(context.env, origin) ? origin : canonicalOrigin(context.env);
}

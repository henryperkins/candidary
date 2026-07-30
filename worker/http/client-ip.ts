import type { Context } from 'hono';

import type { AppBindings } from '../env';

/**
 * The only accepted source of a caller's address.
 *
 * `CF-Connecting-IP` is set by Cloudflare on the way in and cannot be forged by
 * the client. `X-Forwarded-For` and `Forwarded` can be, so they are ignored
 * outright: honouring them would let one visitor spend somebody else's abuse
 * budget, or spread their own across an unlimited number of invented addresses.
 *
 * A request that arrives without the header — a local run, or an unexpected
 * path into the Worker — is charged to the single literal `unknown`. Sharing
 * one bucket is deliberate: it fails toward refusing too much rather than
 * handing out an unlimited number of fresh budgets.
 */
export function clientIp(context: Context<AppBindings>): string {
  return context.req.header('CF-Connecting-IP')?.trim() || 'unknown';
}

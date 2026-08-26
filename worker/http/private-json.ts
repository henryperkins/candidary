import type { MiddlewareHandler } from 'hono';

import type { AppBindings } from '../env';

/**
 * A JSON response that belongs to exactly one signed-in reader.
 *
 * Set before the handler runs rather than after, so the headers are already
 * pending on the context when `app.onError` builds a failure body — an error
 * naming a photo, a guest, or a deadline is no more cacheable than the success
 * it replaced. `Vary: Cookie` is the other half: these bodies differ per
 * session, and a shared cache keyed on the URL alone would be free to hand one
 * guest's contributions to the next.
 */
export const privateJson: MiddlewareHandler<AppBindings> = async (context, next) => {
  context.header('Cache-Control', 'private, no-store');
  context.header('Vary', 'Cookie');
  await next();
};

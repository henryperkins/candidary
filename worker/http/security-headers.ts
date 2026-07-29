import type { MiddlewareHandler } from 'hono';

import type { AppBindings } from '../env';

// One year, subdomains included. `preload` is deliberately absent: the browser
// preload list is not practically reversible, so joining it is its own decision.
// Named rather than inlined so a max-age ramp stays a one-line change.
const STRICT_TRANSPORT_SECURITY = 'max-age=31536000; includeSubDomains';

export const securityHeaders: MiddlewareHandler<AppBindings> = async (context, next) => {
  await next();
  context.header(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' blob: data:; connect-src 'self' https://*.r2.cloudflarestorage.com; style-src 'self' 'unsafe-inline'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  context.header('Referrer-Policy', 'no-referrer');
  context.header('X-Content-Type-Options', 'nosniff');
  context.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  context.header('Cross-Origin-Opener-Policy', 'same-origin');
  // RFC 6797 section 7.2 forbids sending this over non-secure transport, and
  // `npm run dev` serves the SPA over http://localhost.
  if (new URL(context.req.url).protocol === 'https:') {
    context.header('Strict-Transport-Security', STRICT_TRANSPORT_SECURITY);
  }
};

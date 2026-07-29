import type { MiddlewareHandler } from 'hono';

import type { AppBindings } from '../env';

export const securityHeaders: MiddlewareHandler<AppBindings> = async (context, next) => {
  await next();
  context.header(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; img-src 'self' blob: data:; connect-src 'self' https://*.r2.cloudflarestorage.com; style-src 'self' 'unsafe-inline'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  context.header('Referrer-Policy', 'no-referrer');
  context.header('X-Content-Type-Options', 'nosniff');
  context.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  context.header('Cross-Origin-Opener-Policy', 'same-origin');
};


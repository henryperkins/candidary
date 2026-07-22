import { Hono } from 'hono';

import { toErrorResponse } from '../shared/errors';
import type { AppBindings } from './env';
import { securityHeaders } from './http/security-headers';
import { eventRoutes } from './routes/event';
import { exchangeRoutes } from './routes/exchange';
import { publicRoutes } from './routes/public';

export function createApp() {
  const app = new Hono<AppBindings>();

  app.use('*', async (context, next) => {
    context.set('requestId', crypto.randomUUID());
    await next();
  });
  app.use('*', securityHeaders);
  app.route('/api', publicRoutes);
  app.route('/', exchangeRoutes);
  app.route('/api', eventRoutes);

  app.notFound((context) => context.json({
    code: 'EVENT_NOT_FOUND',
    message: 'This page could not be found.',
    requestId: context.get('requestId'),
  }, 404));

  app.onError((error, context) => {
    const response = toErrorResponse(error, context.get('requestId'));
    return context.json(response.body, response.status as 400);
  });

  return app;
}

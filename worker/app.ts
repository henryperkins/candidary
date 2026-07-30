import { Hono } from 'hono';

import { toErrorResponse } from '../shared/errors';
import type { AppBindings } from './env';
import { securityHeaders } from './http/security-headers';
import { entryRoutes } from './routes/entry';
import { eventRoutes } from './routes/event';
import { exportRoutes } from './routes/exports';
import { exchangeRoutes } from './routes/exchange';
import { contentRoutes } from './routes/content';
import { galleryRoutes } from './routes/gallery';
import { hostAuthRoutes } from './routes/host-auth';
import { hostPublicRoutes } from './routes/host-public';
import { manageRoutes } from './routes/manage';
import { manageRsvpRoutes } from './routes/manage-rsvp';
import { messageRoutes } from './routes/messages';
import { publicRoutes } from './routes/public';
import { uploadRoutes } from './routes/uploads';

export function createApp() {
  const app = new Hono<AppBindings>();

  app.use('*', async (context, next) => {
    context.set('requestId', crypto.randomUUID());
    await next();
  });
  app.use('*', securityHeaders);
  app.route('/api', publicRoutes);
  app.route('/api', entryRoutes);
  app.route('/', exchangeRoutes);
  app.route('/', hostPublicRoutes);
  app.route('/api', hostAuthRoutes);
  app.route('/api', eventRoutes);
  app.route('/api', exportRoutes);
  app.route('/api', uploadRoutes);
  app.route('/api', contentRoutes);
  app.route('/api', galleryRoutes);
  app.route('/api', manageRoutes);
  app.route('/api', manageRsvpRoutes);
  app.route('/api', messageRoutes);

  app.notFound((context) => {
    if (!new URL(context.req.url).pathname.startsWith('/api/')) {
      return context.env.ASSETS.fetch(context.req.raw);
    }
    return context.json({
      code: 'EVENT_NOT_FOUND',
      message: 'This page could not be found.',
      requestId: context.get('requestId'),
    }, 404);
  });

  app.onError((error, context) => {
    const response = toErrorResponse(error, context.get('requestId'));
    return context.json(response.body, response.status as 400);
  });

  return app;
}

import { Hono } from 'hono';

import type { Role } from '../../shared/contracts';
import type { AppBindings } from '../env';
import { setSessionCookies } from '../http/cookies';
import { AuthService } from '../auth/service';

export const exchangeRoutes = new Hono<AppBindings>();

function registerExchange(path: string, role: Role) {
  exchangeRoutes.get(path, async (context) => {
    const exchanged = await new AuthService(context.env).exchange(context.req.param('token') ?? '', role);
    const maxAge = Math.max(1, Math.floor((Date.parse(exchanged.session.expiresAt) - Date.now()) / 1000));
    setSessionCookies(context, exchanged.sessionToken, exchanged.csrfToken, maxAge);
    const location = role === 'guest'
      ? `/event/${exchanged.event.slug}`
      : `/manage/event/${exchanged.event.id}`;
    return context.redirect(location, 302);
  });
}

registerExchange('/join/:token', 'guest');
registerExchange('/manage/:token', 'manager');

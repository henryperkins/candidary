import { Hono } from 'hono';
import { z } from 'zod';

import { ApiError } from '../../shared/errors';
import {
  DEFAULT_EVENT_THEME_CONFIG,
  eventThemeConfigSchema,
  EventThemeResolutionError,
  resolveEventTheme,
} from '../../shared/event-theme';
import { AuthService } from '../auth/service';
import type { AppBindings } from '../env';
import { getSessionCookie, setSessionCookies } from '../http/cookies';
import { assertRequestOrigin } from '../http/csrf';
import { eventView } from '../http/event-view';
import { fieldErrors } from '../http/validation';
import { EventService } from '../services/events';

const eventSchema = z.object({
  name: z.string().trim().min(1, 'Enter an event name.').max(80, 'Use 80 characters or fewer.'),
  eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'Choose a valid event date.')
    .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)), 'Choose a valid event date.'),
  welcomeMessage: z.string().trim().min(1, 'Add a welcome message.').max(500, 'Use 500 characters or fewer.'),
  theme: eventThemeConfigSchema.default(DEFAULT_EVENT_THEME_CONFIG),
});

export const publicRoutes = new Hono<AppBindings>();

publicRoutes.post('/events', async (context) => {
  assertRequestOrigin(context);
  const parsed = eventSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError('VALIDATION_FAILED', 'Check the highlighted event details.', 422, fieldErrors(parsed.error));
  }
  // Creation stays open to anyone, so the account cookie is strictly optional here.
  // A host who is signed in gets the event attached in the same transaction; a
  // stale or revoked cookie falls through to the ordinary link-only path rather
  // than failing a creation that never needed an account.
  const hostCookie = getSessionCookie(context, 'host');
  const accountId = hostCookie
    ? await new AuthService(context.env).resolveHostSession(hostCookie)
      .then((principal) => principal.account.id)
      .catch(() => null)
    : null;

  let theme;
  try {
    theme = resolveEventTheme(parsed.data.theme).config;
  } catch (error) {
    if (!(error instanceof EventThemeResolutionError)) throw error;
    throw new ApiError(
      'VALIDATION_FAILED',
      'Check the highlighted event details.',
      422,
      { [`theme.${error.field}`]: error.message },
    );
  }
  const created = await new EventService(context.env).create({ ...parsed.data, theme }, accountId);
  const maxAge = Math.max(1, Math.floor((Date.parse(created.sessionExpiresAt) - Date.now()) / 1000));
  setSessionCookies(context, 'event', created.managementSession, created.csrfToken, maxAge);
  return context.json({
    data: {
      event: eventView(created.event),
      guestLink: created.guestLink,
      managementLink: created.managementLink,
      csrfToken: created.csrfToken,
      savedToAccount: created.savedToAccount,
    },
    requestId: context.get('requestId'),
  }, 201);
});


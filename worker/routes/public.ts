import { Hono } from 'hono';
import { z } from 'zod';

import { ApiError } from '../../shared/errors';
import { DEFAULT_GUESTBOOK_PROMPT } from '../../shared/constants';
import { canonicalTimeZone, isCalendarDate, isIanaTimeZone } from '../../shared/event-time';
import {
  assertOverridesLegible,
  DEFAULT_EVENT_THEME_CONFIG,
  eventThemeConfigSchema,
  EventThemeResolutionError,
  resolveEventTheme,
} from '../../shared/event-theme';
import { AuthService } from '../auth/service';
import type { AppBindings } from '../env';
import { getSessionCookie, setSessionCookies } from '../http/cookies';
import { assertRequestOrigin } from '../http/csrf';
import { DEFAULT_EVENT_START_TIME, resolveEventSchedule } from '../http/event-schedule';
import { selectManagerEventView } from '../http/event-view';
import { fieldErrors } from '../http/validation';
import { requestOrigin } from '../origins';
import { EventService } from '../services/events';

const eventSchema = z.object({
  name: z.string().trim().min(1, 'Enter an event name.').max(80, 'Use 80 characters or fewer.'),
  eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'Choose a valid event date.')
    .refine(isCalendarDate, 'Choose a valid event date.'),
  welcomeMessage: z.string().trim().min(1, 'Add a welcome message.').max(500, 'Use 500 characters or fewer.'),
  guestbookPrompt: z.literal(DEFAULT_GUESTBOOK_PROMPT).default(DEFAULT_GUESTBOOK_PROMPT),
  eventTimezone: z.string().min(1).max(64)
    .refine(isIanaTimeZone, 'Choose a valid time zone.'),
  // Local wall clock, never an instant. Optional for rollout compatibility;
  // the create form always sends it, prefilled to midnight.
  eventStartTime: z.string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/u, 'Choose a valid start time.')
    .default(DEFAULT_EVENT_START_TIME),
  rsvpDeadlineDate: z.string()
    .regex(/^\d{4}-\d{2}-\d{2}$/u, 'Choose a valid RSVP deadline.'),
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
    const resolved = resolveEventTheme(parsed.data.theme);
    assertOverridesLegible(resolved);
    theme = resolved.config;
  } catch (error) {
    if (!(error instanceof EventThemeResolutionError)) throw error;
    throw new ApiError(
      'VALIDATION_FAILED',
      'Check the highlighted event details.',
      422,
      { [`theme.${error.field}`]: error.message },
    );
  }
  // Stored canonically, so "america/chicago" and "America/Chicago" are one zone
  // in every later export and view.
  const eventTimezone = canonicalTimeZone(parsed.data.eventTimezone) ?? parsed.data.eventTimezone;
  const schedule = resolveEventSchedule(
    { ...parsed.data, eventTimezone },
    'Check the highlighted event details.',
  );
  const created = await new EventService(context.env, requestOrigin(context)).create(
    { ...parsed.data, theme, eventTimezone, ...schedule },
    accountId,
  );
  const maxAge = Math.max(1, Math.floor((Date.parse(created.sessionExpiresAt) - Date.now()) / 1000));
  setSessionCookies(context, 'event', created.managementSession, created.csrfToken, maxAge);
  return context.json({
    data: {
      event: await selectManagerEventView(context.env, created.event),
      eventLink: created.eventLink,
      managementLink: created.managementLink,
      csrfToken: created.csrfToken,
      savedToAccount: created.savedToAccount,
    },
    requestId: context.get('requestId'),
  }, 201);
});


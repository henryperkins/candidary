import { Hono } from 'hono';
import { z } from 'zod';

import { ApiError } from '../../shared/errors';
import type { AppBindings } from '../env';
import { setSessionCookies } from '../http/cookies';
import { assertRequestOrigin } from '../http/csrf';
import { EventService } from '../services/events';

const eventSchema = z.object({
  name: z.string().trim().min(1, 'Enter an event name.').max(80, 'Use 80 characters or fewer.'),
  eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'Choose a valid event date.')
    .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)), 'Choose a valid event date.'),
  welcomeMessage: z.string().trim().min(1, 'Add a welcome message.').max(500, 'Use 500 characters or fewer.'),
});

function fieldErrors(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? 'form');
    fields[field] ??= issue.message;
  }
  return fields;
}

export const publicRoutes = new Hono<AppBindings>();

publicRoutes.post('/events', async (context) => {
  assertRequestOrigin(context);
  const parsed = eventSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError('VALIDATION_FAILED', 'Check the highlighted event details.', 422, fieldErrors(parsed.error));
  }
  const created = await new EventService(context.env).create(parsed.data);
  const maxAge = Math.max(1, Math.floor((Date.parse(created.sessionExpiresAt) - Date.now()) / 1000));
  setSessionCookies(context, created.managementSession, created.csrfToken, maxAge);
  return context.json({
    data: {
      event: created.event,
      guestLink: created.guestLink,
      managementLink: created.managementLink,
      csrfToken: created.csrfToken,
    },
    requestId: context.get('requestId'),
  }, 201);
});


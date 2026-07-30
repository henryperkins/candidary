import { Hono, type Context } from 'hono';
import { z } from 'zod';

import { MAX_HOUSEHOLD_CAPACITY, MAX_RSVP_TEXT_LENGTH } from '../../shared/constants';
import { ApiError } from '../../shared/errors';
import { RsvpAuthService } from '../auth/rsvp';
import { AuthService } from '../auth/service';
import { RsvpRepository } from '../db/rsvp';
import { RSVP_LOOKUP_RATE_WINDOW_MS } from '../db/rsvp-rate-limits';
import type { AppBindings } from '../env';
import { clientIp } from '../http/client-ip';
import { getSessionCookie, setSessionCookies } from '../http/cookies';
import { assertCsrf } from '../http/csrf';
import { digestSecret } from '../security/crypto';
import { RsvpService } from '../services/rsvp';

const lookupSchema = z.object({
  firstName: z.string().trim().min(1).max(MAX_RSVP_TEXT_LENGTH),
  secondName: z.string().trim().min(1).max(MAX_RSVP_TEXT_LENGTH).optional(),
});

const EDGE_RETRY_AFTER_SECONDS = '60';
const DURABLE_RETRY_AFTER_SECONDS = String(RSVP_LOOKUP_RATE_WINDOW_MS / 1000);

export const rsvpRoutes = new Hono<AppBindings>();

/**
 * The event guest session, exactly as the upload routes require it.
 *
 * Defined here rather than shared so no future change to the RSVP surface can
 * accidentally let a household cookie satisfy it. An RSVP session speaks for one
 * household; it is not a way into the event.
 */
async function eventGuestForSlug(context: Context<AppBindings>, write: boolean) {
  const auth = await new AuthService(context.env).resolveEventSession(getSessionCookie(context));
  if (auth.session.role !== 'guest' || auth.event.slug !== context.req.param('slug')) {
    throw new ApiError('ROLE_FORBIDDEN', 'This session belongs to a different event.', 403);
  }
  if (write) await assertCsrf(context, 'event', auth.session.csrfDigest);
  return auth;
}

/**
 * The edge budget, spent before this Worker parses a body or touches D1.
 *
 * Its whole value is being cheap: a flood of guesses should cost a key derivation
 * and nothing else. The durable per-name and per-address budgets behind it are
 * what actually protect the roster.
 */
async function assertLookupEdgeBoundary(context: Context<AppBindings>): Promise<void> {
  const key = await digestSecret(
    `rsvp-edge:v1:lookup:ip:${clientIp(context)}`,
    context.env.RSVP_LOOKUP_HMAC_KEY,
  );
  if (!(await context.env.RSVP_LOOKUP_RATE_LIMIT.limit({ key })).success) {
    context.header('Retry-After', EDGE_RETRY_AFTER_SECONDS);
    throw new ApiError('RATE_LIMITED', 'Too many attempts. Try again in a minute.', 429);
  }
}

rsvpRoutes.post('/event/:slug/rsvp/lookup', async (context) => {
  // Order is normative. Refusing at the edge first means an abusive caller
  // never reaches the JSON parser, the session read, or the roster.
  await assertLookupEdgeBoundary(context);
  const eventAuth = await eventGuestForSlug(context, true);
  const parsed = lookupSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError('VALIDATION_FAILED', 'Enter the full name on the invitation.', 422);
  }

  const rsvp = new RsvpService(context.env);
  const names = [parsed.data.firstName, parsed.data.secondName]
    .filter((name): name is string => typeof name === 'string');
  try {
    await rsvp.reserveLookupAttempts(eventAuth.event, clientIp(context), names);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'RATE_LIMITED') {
      context.header('Retry-After', DURABLE_RETRY_AFTER_SECONDS);
    }
    throw error;
  }

  const result = await rsvp.lookup(eventAuth.event, parsed.data);
  if (result.status !== 'matched') {
    return context.json({ data: result, requestId: context.get('requestId') });
  }

  const created = await new RsvpAuthService(context.env)
    .create(eventAuth.event, result.household);
  const maxAge = Math.max(
    1,
    Math.floor((Date.parse(created.session.expiresAt) - Date.now()) / 1000),
  );
  setSessionCookies(context, 'rsvp', created.sessionToken, created.csrfToken, maxAge);

  const invitees = await new RsvpRepository(context.env.DB)
    .listInvitees(eventAuth.event.id, result.household.id);
  return context.json({
    data: {
      status: 'matched',
      household: rsvp.householdView(
        eventAuth.event,
        result.household,
        invitees,
        created.session,
      ),
    },
    requestId: context.get('requestId'),
  });
});

const submissionSchema = z.object({
  version: z.number().int().min(1),
  idempotencyKey: z.string().min(1).max(128),
  invitees: z.array(z.object({
    id: z.uuid(),
    attendance: z.enum(['attending', 'declined']),
    displayName: z.string().max(MAX_RSVP_TEXT_LENGTH).nullable(),
  })).min(1).max(MAX_HOUSEHOLD_CAPACITY),
});

async function householdForSlug(context: Context<AppBindings>, write: boolean) {
  const auth = await new RsvpAuthService(context.env)
    .resolve(getSessionCookie(context, 'rsvp'));
  if (auth.event.slug !== context.req.param('slug')) {
    throw new ApiError('ROLE_FORBIDDEN', 'This invitation belongs to a different event.', 403);
  }
  if (write) await assertCsrf(context, 'rsvp', auth.session.csrfDigest);
  return auth;
}

rsvpRoutes.put('/event/:slug/rsvp/household', async (context) => {
  const auth = await householdForSlug(context, true);
  const parsed = submissionSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError(
      'VALIDATION_FAILED',
      'Choose attending or not attending for everyone in the household.',
      422,
    );
  }

  const committed = await new RsvpService(context.env).submitHousehold(auth, parsed.data);
  return context.json({ data: committed, requestId: context.get('requestId') });
});

// A returning device reads its own household back. Resolves only the RSVP
// cookie: the event guest session cannot stand in for it.
rsvpRoutes.get('/event/:slug/rsvp/household', async (context) => {
  const auth = await householdForSlug(context, false);

  const invitees = await new RsvpRepository(context.env.DB)
    .listInvitees(auth.event.id, auth.household.id);
  return context.json({
    data: {
      household: new RsvpService(context.env)
        .householdView(auth.event, auth.household, invitees, auth.session),
    },
    requestId: context.get('requestId'),
  });
});

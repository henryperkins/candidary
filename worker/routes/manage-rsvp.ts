import { Hono } from 'hono';
import { z } from 'zod';

import {
  MAX_HOUSEHOLD_CAPACITY,
  MAX_NAMED_INVITEES_PER_HOUSEHOLD,
  MAX_PLUS_ONES_PER_HOUSEHOLD,
  MAX_RSVP_CSV_BYTES,
  MAX_RSVP_TEXT_LENGTH,
} from '../../shared/constants';
import { ApiError } from '../../shared/errors';
import { RSVP_HOUSEHOLD_KEY_PATTERN } from '../../shared/rsvp';
import { requireManager } from '../auth/manager';
import type { AppBindings } from '../env';
import { decodeRsvpCursor } from '../http/rsvp-cursor';
import { RsvpService } from '../services/rsvp';

// Defence in depth ahead of the parser's own byte limit. Deliberately generous:
// an ordinary oversized file should reach the parser and come back as a
// `file_too_large` issue the host can read, not as a bare validation refusal.
const csvField = z.string().max(MAX_RSVP_CSV_BYTES * 2);

const previewSchema = z.object({ csv: csvField });

const commitSchema = z.object({
  csv: csvField,
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  expectedRosterVersion: z.number().int().min(0),
});

const expectedVersions = {
  expectedVersion: z.number().int().min(1),
  expectedRosterVersion: z.number().int().min(0),
};

const attendanceSchema = z.enum(['attending', 'declined']);
const personTextSchema = z.string().max(MAX_RSVP_TEXT_LENGTH);

const createHouseholdSchema = z.object({
  householdKey: z.string().regex(RSVP_HOUSEHOLD_KEY_PATTERN),
  label: personTextSchema,
  plusOneSlots: z.number().int().min(0).max(MAX_PLUS_ONES_PER_HOUSEHOLD),
  namedInvitees: z.array(personTextSchema)
    .min(1)
    .max(MAX_NAMED_INVITEES_PER_HOUSEHOLD),
  expectedRosterVersion: z.number().int().min(0),
});

const updateHouseholdSchema = z.object({
  label: personTextSchema,
  plusOneSlots: z.number().int().min(0).max(MAX_PLUS_ONES_PER_HOUSEHOLD),
  namedInvitees: z.array(z.object({
    id: z.uuid().nullable(),
    displayName: personTextSchema,
    attendance: attendanceSchema.optional(),
  })).max(MAX_NAMED_INVITEES_PER_HOUSEHOLD),
  newPlusOneResponses: z.array(z.object({
    attendance: attendanceSchema,
    displayName: personTextSchema.nullable(),
  })).max(MAX_PLUS_ONES_PER_HOUSEHOLD).optional(),
  ...expectedVersions,
});

const responseSchema = z.object({
  invitees: z.array(z.object({
    id: z.uuid(),
    attendance: attendanceSchema,
    displayName: personTextSchema.nullable(),
  })).min(1).max(MAX_HOUSEHOLD_CAPACITY),
  ...expectedVersions,
});

const versionSchema = z.object(expectedVersions);
const listStateSchema = z.enum(['all', 'responded', 'awaiting', 'archived']);
const querySchema = z.string().max(MAX_RSVP_TEXT_LENGTH).optional();

export const manageRsvpRoutes = new Hono<AppBindings>();

// Neither route reports anything but counts, issue codes, and digests. A parse
// failure must never echo a row, and no log line may carry the file.
function invalidBody(): ApiError {
  return new ApiError('VALIDATION_FAILED', 'Upload a guest list file to continue.', 422);
}

function invalidHouseholdBody(): ApiError {
  return new ApiError('VALIDATION_FAILED', 'Check the household guest list and try again.', 422);
}

manageRsvpRoutes.post('/manage/events/:eventId/rsvp/import/preview', async (context) => {
  const auth = await requireManager(context, { write: true });
  const parsed = previewSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) throw invalidBody();

  const preview = await new RsvpService(context.env).previewImport(auth.event, parsed.data.csv);
  return context.json({ data: preview, requestId: context.get('requestId') });
});

manageRsvpRoutes.post('/manage/events/:eventId/rsvp/import/commit', async (context) => {
  const auth = await requireManager(context, { write: true });
  const parsed = commitSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) throw invalidBody();

  const committed = await new RsvpService(context.env)
    .commitInitialImport(auth.event, parsed.data);
  return context.json({ data: committed, requestId: context.get('requestId') }, 201);
});

manageRsvpRoutes.get('/manage/events/:eventId/rsvp/summary', async (context) => {
  const auth = await requireManager(context);
  const summary = await new RsvpService(context.env).summary(auth.event.id);
  return context.json({ data: summary, requestId: context.get('requestId') });
});

manageRsvpRoutes.get('/manage/events/:eventId/rsvp/households', async (context) => {
  const auth = await requireManager(context);
  const state = listStateSchema.safeParse(context.req.query('state') ?? 'all');
  const query = querySchema.safeParse(context.req.query('query'));
  if (!state.success || !query.success) {
    throw new ApiError('VALIDATION_FAILED', 'Check the guest list filters.', 422);
  }
  const rawCursor = context.req.query('cursor');
  const page = await new RsvpService(context.env).listManagerHouseholds({
    eventId: auth.event.id,
    state: state.data,
    ...(query.data === undefined ? {} : { query: query.data }),
    ...(rawCursor === undefined ? {} : { cursor: decodeRsvpCursor(rawCursor) }),
  });
  return context.json({ data: page, requestId: context.get('requestId') });
});

manageRsvpRoutes.get(
  '/manage/events/:eventId/rsvp/households/:householdId',
  async (context) => {
    const auth = await requireManager(context);
    const household = await new RsvpService(context.env)
      .managerHousehold(auth.event.id, context.req.param('householdId'));
    return context.json({ data: household, requestId: context.get('requestId') });
  },
);

manageRsvpRoutes.post('/manage/events/:eventId/rsvp/households', async (context) => {
  const auth = await requireManager(context, { write: true });
  const parsed = createHouseholdSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) throw invalidHouseholdBody();
  const created = await new RsvpService(context.env)
    .createManagerHousehold(auth.event, parsed.data);
  return context.json({ data: created, requestId: context.get('requestId') }, 201);
});

manageRsvpRoutes.put(
  '/manage/events/:eventId/rsvp/households/:householdId',
  async (context) => {
    const auth = await requireManager(context, { write: true });
    const parsed = updateHouseholdSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) throw invalidHouseholdBody();
    const updated = await new RsvpService(context.env).updateManagerHousehold(
      auth.event,
      context.req.param('householdId'),
      parsed.data,
    );
    return context.json({ data: updated, requestId: context.get('requestId') });
  },
);

manageRsvpRoutes.put(
  '/manage/events/:eventId/rsvp/households/:householdId/response',
  async (context) => {
    const auth = await requireManager(context, { write: true });
    const parsed = responseSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) throw invalidHouseholdBody();
    const corrected = await new RsvpService(context.env).correctManagerHousehold(
      auth.event,
      context.req.param('householdId'),
      parsed.data,
    );
    return context.json({ data: corrected, requestId: context.get('requestId') });
  },
);

manageRsvpRoutes.post(
  '/manage/events/:eventId/rsvp/households/:householdId/archive',
  async (context) => {
    const auth = await requireManager(context, { write: true });
    const parsed = versionSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) throw invalidHouseholdBody();
    const archived = await new RsvpService(context.env).archiveManagerHousehold(
      auth.event,
      context.req.param('householdId'),
      parsed.data,
    );
    return context.json({ data: archived, requestId: context.get('requestId') });
  },
);

manageRsvpRoutes.get('/manage/events/:eventId/rsvp/export.csv', async (context) => {
  const auth = await requireManager(context);
  const exported = await new RsvpService(context.env).exportCsv(auth.event);
  context.header('Content-Type', 'text/csv; charset=utf-8');
  context.header('Content-Disposition', `attachment; filename="${exported.filename}"`);
  return context.body(exported.csv);
});

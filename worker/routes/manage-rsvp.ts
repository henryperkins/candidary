import { Hono } from 'hono';
import { z } from 'zod';

import {
  MAX_HOUSEHOLD_CAPACITY,
  MAX_NAMED_INVITEES_PER_HOUSEHOLD,
  MAX_PLUS_ONES_PER_HOUSEHOLD,
  MAX_RSVP_BATCH_BYTES,
  MAX_RSVP_CSV_BYTES,
  MAX_RSVP_TEXT_LENGTH,
} from '../../shared/constants';
import type {
  RsvpRosterBatchCommitRequest,
  RsvpRosterBatchPreviewRequest,
} from '../../shared/contracts';
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

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

const rosterTextSchema = z.string()
  .max(MAX_RSVP_TEXT_LENGTH)
  .refine(isWellFormedUnicode);
const rosterUuidSchema = z.uuid();
const rosterKeySchema = z.string()
  .max(64)
  .regex(RSVP_HOUSEHOLD_KEY_PATTERN);
const rosterPreviewKeySchema = z.string().max(128);
const rosterAttendanceSchema = z.enum(['attending', 'declined']);
const rosterKeyDraftSchema = z.object({
  value: rosterPreviewKeySchema,
  provenance: z.literal('supplied'),
}).strict();
const rosterKeyCanonicalSchema = z.object({
  value: rosterKeySchema,
  provenance: z.enum(['supplied', 'generated']),
}).strict();
const rosterCreateInviteeSchema = z.object({
  clientInviteeId: rosterUuidSchema,
  displayName: rosterTextSchema,
}).strict();
const rosterAppendInviteeSchema = rosterCreateInviteeSchema.extend({
  attendance: rosterAttendanceSchema.optional(),
}).strict();
const rosterPlusOneResponseSchema = z.object({
  clientInviteeId: rosterUuidSchema,
  attendance: rosterAttendanceSchema,
  displayName: rosterTextSchema.nullable(),
}).strict();

function batchWithUniqueClientIds<T extends {
  creates: Array<{
    clientHouseholdId: string;
    namedInvitees: Array<{ clientInviteeId: string }>;
    plusOneSlots: number;
  }>;
  appends: Array<{
    clientHouseholdId: string;
    namedInvitees: Array<{ clientInviteeId: string }>;
    plusOneSlotsToAdd: number;
    newPlusOneResponses?: Array<{ clientInviteeId: string }>;
  }>;
}>(schema: z.ZodType<T>) {
  return schema.superRefine((batch, context) => {
    const householdIds = new Set<string>();
    const inviteeIds = new Set<string>();
    const check = (id: string, path: (string | number)[]) => {
      if (inviteeIds.has(id)) {
        context.addIssue({ code: 'custom', path, message: 'Duplicate client invitee ID.' });
      }
      inviteeIds.add(id);
    };
    const checkHousehold = (id: string, path: (string | number)[]) => {
      if (householdIds.has(id)) {
        context.addIssue({ code: 'custom', path, message: 'Duplicate client household ID.' });
      }
      householdIds.add(id);
    };
    let additions = 0;
    batch.creates.forEach((create, householdIndex) => {
      checkHousehold(create.clientHouseholdId, ['creates', householdIndex, 'clientHouseholdId']);
      additions += create.namedInvitees.length + create.plusOneSlots;
      create.namedInvitees.forEach((invitee, inviteeIndex) => {
        check(invitee.clientInviteeId, [
          'creates', householdIndex, 'namedInvitees', inviteeIndex, 'clientInviteeId',
        ]);
      });
    });
    batch.appends.forEach((append, householdIndex) => {
      checkHousehold(append.clientHouseholdId, ['appends', householdIndex, 'clientHouseholdId']);
      additions += append.namedInvitees.length + append.plusOneSlotsToAdd;
      append.namedInvitees.forEach((invitee, inviteeIndex) => {
        check(invitee.clientInviteeId, [
          'appends', householdIndex, 'namedInvitees', inviteeIndex, 'clientInviteeId',
        ]);
      });
      append.newPlusOneResponses?.forEach((invitee, inviteeIndex) => {
        check(invitee.clientInviteeId, [
          'appends', householdIndex, 'newPlusOneResponses', inviteeIndex, 'clientInviteeId',
        ]);
      });
    });
    if (batch.creates.length === 0 && batch.appends.length === 0) {
      context.addIssue({ code: 'custom', path: [], message: 'Add a household or append guests.' });
    }
    if (batch.creates.length + batch.appends.length > 500 || additions > 500) {
      context.addIssue({ code: 'custom', path: [], message: 'This batch is too large.' });
    }
  });
}

const rosterCreateDraftSchema = z.object({
  clientHouseholdId: rosterUuidSchema,
  householdKey: rosterKeyDraftSchema.optional(),
  label: rosterTextSchema,
  namedInvitees: z.array(rosterCreateInviteeSchema).max(500),
  plusOneSlots: z.number().int().min(0).max(500),
}).strict();
const rosterCreateCanonicalSchema = z.object({
  clientHouseholdId: rosterUuidSchema,
  householdKey: rosterKeyCanonicalSchema,
  label: rosterTextSchema,
  namedInvitees: z.array(rosterCreateInviteeSchema).max(500),
  plusOneSlots: z.number().int().min(0).max(500),
}).strict();
const rosterAppendSchema = z.object({
  clientHouseholdId: rosterUuidSchema,
  householdId: rosterUuidSchema,
  expectedHouseholdVersion: z.number().int().min(1),
  namedInvitees: z.array(rosterAppendInviteeSchema).max(500),
  plusOneSlotsToAdd: z.number().int().min(0).max(500),
  newPlusOneResponses: z.array(rosterPlusOneResponseSchema).max(500).optional(),
}).strict();
const rosterDraftSchema = batchWithUniqueClientIds(z.object({
  creates: z.array(rosterCreateDraftSchema).max(500),
  appends: z.array(rosterAppendSchema).max(500),
}).strict());
const rosterCanonicalSchema = batchWithUniqueClientIds(z.object({
  creates: z.array(rosterCreateCanonicalSchema).max(500),
  appends: z.array(rosterAppendSchema).max(500),
}).strict());
const rosterPreviewSchema = z.object({
  batch: rosterDraftSchema,
  expectedRosterVersion: z.number().int().min(0),
}).strict();
const rosterCommitSchema = z.object({
  canonicalBatch: rosterCanonicalSchema,
  previewDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  expectedRosterVersion: z.number().int().min(0),
  idempotencyKey: z.string().min(1).max(128),
}).strict();

export const manageRsvpRoutes = new Hono<AppBindings>();

// Neither route reports anything but counts, issue codes, and digests. A parse
// failure must never echo a row, and no log line may carry the file.
function invalidBody(): ApiError {
  return new ApiError('VALIDATION_FAILED', 'Upload a guest list file to continue.', 422);
}

function invalidHouseholdBody(): ApiError {
  return new ApiError('VALIDATION_FAILED', 'Check the household guest list and try again.', 422);
}

function invalidRosterBody(): ApiError {
  return new ApiError('VALIDATION_FAILED', 'Check the guest list batch and try again.', 422);
}

async function rosterRequestBody(context: { req: { raw: Request } }): Promise<unknown> {
  const reader = context.req.raw.body?.getReader();
  if (!reader) throw invalidRosterBody();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytesRead += next.value.byteLength;
      if (bytesRead > MAX_RSVP_BATCH_BYTES) {
        await reader.cancel();
        throw new ApiError(
          'RSVP_ROSTER_BATCH_TOO_LARGE',
          'This guest list batch is too large. Split it into smaller batches and try again.',
          413,
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(body);
    return JSON.parse(source);
  } catch {
    throw invalidRosterBody();
  }
}

manageRsvpRoutes.post('/manage/events/:eventId/rsvp/import/preview', async (context) => {
  const auth = await requireManager(context, { write: true });
  const parsed = previewSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) throw invalidBody();

  const preview = await new RsvpService(context.env).previewImport(auth.event, parsed.data.csv);
  return context.json({ data: preview, requestId: context.get('requestId') });
});

manageRsvpRoutes.post('/manage/events/:eventId/rsvp/roster/preview', async (context) => {
  const auth = await requireManager(context);
  const parsed = rosterPreviewSchema.safeParse(await rosterRequestBody(context));
  if (!parsed.success) throw invalidRosterBody();
  const preview = await new RsvpService(context.env).previewRosterBatch(
    auth.event,
    parsed.data as RsvpRosterBatchPreviewRequest,
  );
  return context.json({ data: preview, requestId: context.get('requestId') });
});

manageRsvpRoutes.post('/manage/events/:eventId/rsvp/roster/commit', async (context) => {
  const auth = await requireManager(context, { write: true });
  const parsed = rosterCommitSchema.safeParse(await rosterRequestBody(context));
  if (!parsed.success) throw invalidRosterBody();
  const committed = await new RsvpService(context.env).commitRosterBatch(
    auth.event,
    parsed.data as RsvpRosterBatchCommitRequest,
  );
  return context.json(
    { data: committed, requestId: context.get('requestId') },
    committed.replayed ? 200 : 201,
  );
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

import { Hono, type Context } from 'hono';
import { z } from 'zod';

import type { PublicationStatus } from '../../shared/contracts';
import { ApiError } from '../../shared/errors';
import {
  assertOverridesLegible,
  eventThemeConfigSchema,
  EventThemeResolutionError,
  resolveEventTheme,
  serializeEventThemeConfig,
} from '../../shared/event-theme';
import { requireManager } from '../auth/manager';
import { AccountsRepository } from '../db/accounts';
import { EventsRepository } from '../db/events';
import { MediaRepository } from '../db/media';
import type { AppBindings } from '../env';
import { canonicalTimeZone, endOfLocalDate, isIanaTimeZone } from '../../shared/event-time';
import { EventEntryService } from '../services/event-entry';
import { LinkService } from '../services/links';
import { RsvpService } from '../services/rsvp';
import {
  MANAGER_BULK_SELECTION_MAX,
  MANAGER_MEDIA_MAX_PAGE_SIZE,
  MANAGER_MEDIA_PAGE_SIZE,
  MAX_IMAGE_BYTES,
  SUPPORTED_IMAGE_TYPES,
} from '../../shared/constants';
import { decodeMediaCursor, encodeMediaCursor } from '../http/media-cursor';
import { eventView } from '../http/event-view';
import { fieldErrors } from '../http/validation';
import { sanitizeFilename } from '../security/filenames';
import { inspectImageHeader } from '../security/image-metadata';
import { presignUpload } from '../storage/presign';
import { deleteEventData } from '../workflows/cleanup';

const confirmNameSchema = z.object({ confirmName: z.string().max(80) });

const settingsSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  welcomeMessage: z.string().trim().min(1).max(500).optional(),
  uploadsEnabled: z.boolean(),
  galleryVisible: z.boolean(),
  moderationRequired: z.boolean(),
  eventTimezone: z.string().min(1).max(64).refine(isIanaTimeZone, 'Choose a valid time zone.'),
  rsvpDeadlineDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'Choose a valid RSVP deadline.'),
  rsvpEnabled: z.boolean(),
  // Only an early stale-view signal. The write is guarded on the version the
  // server itself read while validating, never on this number.
  rsvpRosterVersion: z.number().int().min(0),
});
const actionSchema = z.object({
  action: z.enum(['publish', 'hide', 'delete']),
  expectedStatus: z.enum(['unpublished', 'published', 'hidden']).default('unpublished'),
});
const bulkActionSchema = z.object({
  ids: z.array(z.uuid())
    .min(1)
    .max(MANAGER_BULK_SELECTION_MAX)
    .refine((ids) => new Set(ids).size === ids.length),
  action: z.enum(['publish', 'hide']),
  expectedStatus: z.enum(['unpublished', 'published', 'hidden']).default('unpublished'),
});
const deleteSchema = z.object({ confirmation: z.string() });
const mediaLimitSchema = z.coerce.number().int().min(1).max(MANAGER_MEDIA_MAX_PAGE_SIZE)
  .default(MANAGER_MEDIA_PAGE_SIZE);
const coverSchema = z.object({
  filename: z.string().min(1).max(255), mimeType: z.enum(SUPPORTED_IMAGE_TYPES),
  byteSize: z.number().int().positive().max(MAX_IMAGE_BYTES),
});

function managerForEvent(context: Context<AppBindings>, write = false) {
  return requireManager(context, { write });
}

// Both durable-entry actions are irreversible for guests, so neither may happen
// on a single tap. The host retypes the event name exactly as it is stored.
async function assertEventNameConfirmed(
  context: Context<AppBindings>,
  eventName: string,
): Promise<void> {
  const parsed = confirmNameSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success || parsed.data.confirmName.trim() !== eventName) {
    throw new ApiError(
      'VALIDATION_FAILED',
      'Type the event name exactly as it appears to confirm.',
      422,
      { confirmName: 'This does not match the event name.' },
    );
  }
}

function publicationTarget(action: 'publish' | 'hide'): PublicationStatus {
  return action === 'publish' ? 'published' : 'hidden';
}

export const manageRoutes = new Hono<AppBindings>();

// Re-displays the printed credential for a host who lost the card. There is no
// replacement action beside it on purpose: a new link would not be on the signs
// already standing at the venue.
manageRoutes.get('/manage/events/:eventId/entry', async (context) => {
  const auth = await managerForEvent(context);
  const entry = await new EventEntryService(context.env).recover(auth.event.id);
  // This body contains the printed credential in full.
  context.header('Cache-Control', 'no-store');
  return context.json({ data: entry, requestId: context.get('requestId') });
});

// Signs guest devices out without touching the printed QR. Named for what it
// does to guests rather than what it does to a token, because that is the part
// a host is deciding about.
manageRoutes.post('/manage/events/:eventId/guest-sessions/rotate', async (context) => {
  const auth = await managerForEvent(context, true);
  await assertEventNameConfirmed(context, auth.event.name);
  const result = await new EventEntryService(context.env).rotateInternalGuestGrant(auth.event);
  return context.json({ data: result, requestId: context.get('requestId') });
});

manageRoutes.post('/manage/events/:eventId/entry/disable', async (context) => {
  const auth = await managerForEvent(context, true);
  await assertEventNameConfirmed(context, auth.event.name);
  const result = await new EventEntryService(context.env).disable(auth.event);
  return context.json({ data: result, requestId: context.get('requestId') });
});

manageRoutes.post('/manage/events/:eventId/cover', async (context) => {
  const auth = await managerForEvent(context, true);
  const parsed = coverSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) throw new ApiError('VALIDATION_FAILED', 'Choose a JPG, PNG, WebP, HEIC, or HEIF image up to 20 MB.', 422);
  const objectKey = `events/${auth.event.id}/cover/${crypto.randomUUID()}-${sanitizeFilename(parsed.data.filename)}`;
  const signed = await presignUpload(context.env, objectKey, parsed.data.mimeType);
  return context.json({ data: { objectKey, ...signed }, requestId: context.get('requestId') }, 201);
});

manageRoutes.post('/manage/events/:eventId/cover/finalize', async (context) => {
  const auth = await managerForEvent(context, true);
  const parsed = z.object({ objectKey: z.string(), mimeType: z.enum(SUPPORTED_IMAGE_TYPES) }).safeParse(await context.req.json().catch(() => null));
  if (!parsed.success || !parsed.data.objectKey.startsWith(`events/${auth.event.id}/cover/`)) {
    throw new ApiError('RESOURCE_FORBIDDEN', 'This cover belongs to a different event.', 403);
  }
  const object = await context.env.MEDIA_BUCKET.get(parsed.data.objectKey);
  if (!object || object.size > MAX_IMAGE_BYTES || object.httpMetadata?.contentType !== parsed.data.mimeType) {
    await context.env.MEDIA_BUCKET.delete(parsed.data.objectKey);
    throw new ApiError('UPLOAD_OBJECT_MISSING', 'The cover upload could not be verified.', 409);
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  let metadata;
  try { metadata = inspectImageHeader(bytes); } catch {
    await context.env.MEDIA_BUCKET.delete(parsed.data.objectKey);
    throw new ApiError('FILE_TYPE_UNSUPPORTED', 'The cover is not a supported image.', 415);
  }
  if (metadata.mimeType !== parsed.data.mimeType) {
    await context.env.MEDIA_BUCKET.delete(parsed.data.objectKey);
    throw new ApiError('FILE_TYPE_UNSUPPORTED', 'The cover type does not match its content.', 415);
  }
  const previousKey = auth.event.coverObjectKey;
  const event = await new EventsRepository(context.env.DB).setCover(auth.event.id, parsed.data.objectKey);
  if (previousKey && previousKey !== parsed.data.objectKey) await context.env.MEDIA_BUCKET.delete(previousKey);
  return context.json({ data: { event: eventView(event) }, requestId: context.get('requestId') });
});

manageRoutes.delete('/manage/events/:eventId/cover', async (context) => {
  const auth = await managerForEvent(context, true);
  const previousKey = auth.event.coverObjectKey;
  const event = await new EventsRepository(context.env.DB).setCover(auth.event.id, null);
  if (previousKey) await context.env.MEDIA_BUCKET.delete(previousKey);
  return context.json({ data: { event: eventView(event) }, requestId: context.get('requestId') });
});

manageRoutes.put('/manage/events/:eventId/theme', async (context) => {
  const auth = await requireManager(context, { write: true });
  const parsed = eventThemeConfigSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError(
      'VALIDATION_FAILED',
      'Check the highlighted theme details.',
      422,
      fieldErrors(parsed.error),
    );
  }

  let resolved;
  try {
    resolved = resolveEventTheme(parsed.data);
    assertOverridesLegible(resolved);
  } catch (error) {
    if (!(error instanceof EventThemeResolutionError)) throw error;
    throw new ApiError(
      'VALIDATION_FAILED',
      'Check the highlighted theme details.',
      422,
      { [error.field]: error.message },
    );
  }

  const updated = await new EventsRepository(context.env.DB).updateTheme(
    auth.event.id,
    serializeEventThemeConfig(resolved.config),
  );
  return context.json({
    data: { event: eventView(updated) },
    requestId: context.get('requestId'),
  });
});

manageRoutes.delete('/manage/events/:eventId', async (context) => {
  const auth = await managerForEvent(context, true);
  const parsed = deleteSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success || parsed.data.confirmation !== auth.event.name) {
    throw new ApiError('VALIDATION_FAILED', 'Type the event name exactly to delete it.', 422, { confirmation: 'Event name does not match.' });
  }
  await deleteEventData(context.env, auth.event.id);
  return context.json({ data: { deleted: true }, requestId: context.get('requestId') });
});

manageRoutes.patch('/manage/events/:eventId/settings', async (context) => {
  const auth = await managerForEvent(context, true);
  const parsed = settingsSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError(
      'VALIDATION_FAILED',
      'Check the event settings.',
      422,
      fieldErrors(parsed.error),
    );
  }
  // Reopening either intake after the printed entry was disabled would leave
  // guests with an event that accepts submissions and no working way in.
  // Manager authority does not outrank the irreversible stop.
  if (parsed.data.uploadsEnabled || parsed.data.rsvpEnabled) {
    await new EventEntryService(context.env).requireOpenEntry(auth.event.id);
  }

  const eventTimezone = canonicalTimeZone(parsed.data.eventTimezone) ?? parsed.data.eventTimezone;
  if (parsed.data.rsvpDeadlineDate > auth.event.eventDate) {
    throw new ApiError('VALIDATION_FAILED', 'Check the event settings.', 422, {
      rsvpDeadlineDate: 'The RSVP deadline must be on or before the event date.',
    });
  }
  let rsvpDeadlineAt: string;
  try {
    rsvpDeadlineAt = endOfLocalDate(parsed.data.rsvpDeadlineDate, eventTimezone);
  } catch {
    throw new ApiError('VALIDATION_FAILED', 'Check the event settings.', 422, {
      rsvpDeadlineDate: 'Choose a valid RSVP deadline.',
    });
  }

  // Cheap refusal before doing the validation work, so an obviously stale host
  // page is told to reload rather than racing.
  if (parsed.data.rsvpRosterVersion !== auth.event.rsvpRosterVersion) {
    throw new ApiError(
      'RSVP_ROSTER_INVALID',
      'The guest list changed since this page loaded. Reload and try again.',
      409,
      { rsvpEnabled: 'The guest list changed since this page loaded.' },
    );
  }

  // A roster is only validated when RSVP is being turned on. Turning it off, or
  // leaving it off, must never be blocked by a list that has a problem.
  const rosterVersion = parsed.data.rsvpEnabled
    ? (await new RsvpService(context.env).assertRosterCanOpen(auth.event.id)).rosterVersion
    : auth.event.rsvpRosterVersion;

  const event = await new EventsRepository(context.env.DB).updateSettings(
    context.req.param('eventId'),
    { ...parsed.data, eventTimezone, rsvpDeadlineAt, expectedRosterVersion: rosterVersion },
  );
  if (!event) {
    throw new ApiError(
      'RSVP_ROSTER_INVALID',
      'The guest list changed while these settings were saving. Review it and try again.',
      409,
      { rsvpEnabled: 'The guest list changed while these settings were saving.' },
    );
  }
  return context.json({ data: { event: eventView(event) }, requestId: context.get('requestId') });
});

manageRoutes.get('/manage/events/:eventId/media', async (context) => {
  await managerForEvent(context);
  const rawStatus = context.req.query('status');
  const status = rawStatus && ['unpublished', 'published', 'hidden'].includes(rawStatus)
    ? rawStatus as PublicationStatus
    : undefined;
  const guestName = context.req.query('guestName');
  const limit = mediaLimitSchema.safeParse(context.req.query('limit'));
  if (!limit.success) {
    throw new ApiError('VALIDATION_FAILED', `Ask for between 1 and ${MANAGER_MEDIA_MAX_PAGE_SIZE} photos per page.`, 422);
  }
  const rawCursor = context.req.query('cursor');
  const cursor = rawCursor === undefined ? undefined : decodeMediaCursor(rawCursor);
  const page = await new MediaRepository(context.env.DB).listForManager(context.req.param('eventId'), {
    status, guestName, cursor, limit: limit.data,
  });
  return context.json({
    data: {
      media: page.media,
      nextCursor: page.nextCursor ? encodeMediaCursor(page.nextCursor) : null,
    },
    requestId: context.get('requestId'),
  });
});

manageRoutes.patch('/manage/events/:eventId/media/:mediaId', async (context) => {
  await managerForEvent(context, true);
  const parsed = actionSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) throw new ApiError('VALIDATION_FAILED', 'Choose a valid moderation action.', 422);
  const repository = new MediaRepository(context.env.DB);
  const media = await repository.getById(context.req.param('mediaId'));
  if (!media || media.eventId !== context.req.param('eventId')) {
    throw new ApiError('RESOURCE_FORBIDDEN', 'This photo belongs to a different event.', 403);
  }
  const changedAt = new Date().toISOString();
  const result = parsed.data.action === 'delete'
    ? await repository.delete(media.id, changedAt)
    : await repository.setPublication(media.id, parsed.data.expectedStatus, publicationTarget(parsed.data.action), changedAt);
  if (parsed.data.action === 'delete') {
    await context.env.MEDIA_BUCKET.delete([
      media.objectKey,
      ...(media.previewObjectKey ? [media.previewObjectKey] : []),
    ]);
  }
  return context.json({ data: { media: result }, requestId: context.get('requestId') });
});

manageRoutes.post('/manage/events/:eventId/media/bulk', async (context) => {
  await managerForEvent(context, true);
  const parsed = bulkActionSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) throw new ApiError('VALIDATION_FAILED', 'Select valid photos to moderate.', 422);
  const repository = new MediaRepository(context.env.DB);
  const changed = await repository.setPublicationBulk(
    context.req.param('eventId'),
    parsed.data.ids,
    parsed.data.expectedStatus,
    publicationTarget(parsed.data.action),
    new Date().toISOString(),
  );
  return context.json({ data: { changed }, requestId: context.get('requestId') });
});

// Only the management link rotates as a link now. The guest side is reached
// through the permanent printed entry, so its replacement lives at
// `/guest-sessions/rotate` and deliberately produces no new URL.
manageRoutes.post('/manage/events/:eventId/links/manager/rotate', async (context) => {
  const auth = await managerForEvent(context, true);
  const ownership = await new AccountsRepository(context.env.DB)
    .getEventOwnershipState(auth.event.id, new Date().toISOString());
  if (ownership && !ownership.hasOwner && ownership.claimStillPossible) {
    throw new ApiError(
      'OWNER_CLAIM_REQUIRED',
      'Save this event from its original creator session before rotating its management link.',
      409,
    );
  }
  const result = await new LinkService(context.env).rotateManagementLink(auth.event);
  return context.json({ data: result, requestId: context.get('requestId') });
});

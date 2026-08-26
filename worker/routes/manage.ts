import { Hono, type Context } from 'hono';
import { z } from 'zod';

import type { GalleryAudienceSummaryView, PublicationStatus } from '../../shared/contracts';
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
import {
  managerGalleryMediaView,
  managerMediaView,
  managerTrashedMediaView,
  MediaRepository,
  uploadMediaView,
} from '../db/media';
import { AlbumRepository } from '../db/album';
import { AlbumSharesRepository } from '../db/album-shares';
import { GuestbookRepository } from '../db/guestbook';
import type { AppBindings } from '../env';
import { requestOrigin } from '../origins';
import { canonicalTimeZone, isIanaTimeZone } from '../../shared/event-time';
import { EventEntryService } from '../services/event-entry';
import { LinkService } from '../services/links';
import { RsvpService } from '../services/rsvp';
import {
  ALBUM_DESCRIPTION_MAX_LENGTH,
  ALBUM_MAX_ENTRIES,
  ALBUM_MAX_SECTIONS,
  ALBUM_SECTION_HEADING_MAX_LENGTH,
  ALBUM_TITLE_MAX_LENGTH,
  DEFAULT_GALLERY_TIMELINE_ORDER,
  GALLERY_TIMELINE_ORDERS,
  type GalleryTimelineOrder,
  MANAGER_BULK_SELECTION_MAX,
  MANAGER_MEDIA_MAX_PAGE_SIZE,
  MANAGER_MEDIA_PAGE_SIZE,
  MAX_GUESTBOOK_PROMPT_LENGTH,
  MIN_EVENT_CALENDAR_YEAR,
  PRIVATE_GALLERY_PAGE_SIZE,
} from '../../shared/constants';
import { decodeGalleryCursor, encodeGalleryCursor } from '../http/gallery-cursor';
import { decodeMediaCursor, encodeMediaCursor } from '../http/media-cursor';
import { decodeTrashCursor, encodeTrashCursor } from '../http/trash-cursor';
import { resolveEventSchedule } from '../http/event-schedule';
import { eventStartTime, selectManagerEventView } from '../http/event-view';
import { fieldErrors } from '../http/validation';
import { deleteEventData } from '../workflows/cleanup';
import { privateJson } from '../http/private-json';
import { retireMediaObjects } from '../storage/media';

const confirmNameSchema = z.object({ confirmName: z.string().max(80) });

// `uploadsEnabled` is deliberately absent. Photo delivery now depends on the
// server clock, and a stale autosave draft could send `uploadsEnabled: false`
// meaning "pause until the start" and instead destroy capability for the whole
// event. It follows the precedent of `Sign out guest devices` and `Disable
// printed event QR`: an explicit action, not a settings field.
const settingsSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  welcomeMessage: z.string().trim().min(1).max(500).optional(),
  guestbookPrompt: z.string().trim().min(1).max(MAX_GUESTBOOK_PROMPT_LENGTH),
  galleryVisible: z.boolean(),
  moderationRequired: z.boolean(),
  eventTimezone: z.string().min(1).max(64).refine(isIanaTimeZone, 'Choose a valid time zone.'),
  eventStartTime: z.string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/u, 'Choose a valid start time.')
    .optional(),
  rsvpDeadlineDate: z.string()
    .regex(/^\d{4}-\d{2}-\d{2}$/u, 'Choose a valid RSVP deadline.')
    .refine(
      (value) => Number(value.slice(0, 4)) >= MIN_EVENT_CALENDAR_YEAR,
      'Choose a valid RSVP deadline.',
    ),
  rsvpEnabled: z.boolean(),
  // Only an early stale-view signal. The write is guarded on the version the
  // server itself read while validating, never on this number.
  rsvpRosterVersion: z.number().int().min(0),
});

const photoIntakeSchema = z.object({
  action: z.enum(['open_early', 'return_to_schedule', 'pause', 'reopen']),
});
// Publication only. Removing a delivered photo is its own explicit, confirmed
// transition with its own recovery contract — it stopped being a third value in
// a moderation enum the moment it stopped being irreversible.
const actionSchema = z.object({
  action: z.enum(['publish', 'hide']),
  expectedStatus: z.enum(['unpublished', 'published', 'hidden']).default('unpublished'),
});
const emptyBodySchema = z.object({}).strict();
const trashLimitSchema = z.coerce.number().int().min(1).max(MANAGER_MEDIA_MAX_PAGE_SIZE)
  .default(MANAGER_MEDIA_PAGE_SIZE);
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
const galleryLimitSchema = z.coerce.number().int().min(1).max(PRIVATE_GALLERY_PAGE_SIZE)
  .default(PRIVATE_GALLERY_PAGE_SIZE);
const favoriteSchema = z.object({ favorite: z.boolean() }).strict();
const GALLERY_SEARCH_MAX_CODE_POINTS = 120;

// Album. `strict()` throughout: an unknown key here is a client composing against a
// contract this Worker does not implement, and silently dropping it would store an
// order the host cannot see.
const albumEntrySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('photo'), mediaId: z.string().min(1).max(64) }).strict(),
  z.object({
    kind: z.literal('section'),
    id: z.string().min(1).max(64),
    // Trimmed, then required: a heading of spaces is a divider with no name, and the
    // review grid has nowhere to put one.
    heading: z.string()
      .trim()
      .min(1)
      .refine((heading) => [...heading].length <= ALBUM_SECTION_HEADING_MAX_LENGTH),
  }).strict(),
]);
const albumMetadataSchema = z.object({
  title: z.string()
    .trim()
    .min(1)
    .refine((title) => [...title].length <= ALBUM_TITLE_MAX_LENGTH),
  description: z.string()
    .refine((description) => [...description].length <= ALBUM_DESCRIPTION_MAX_LENGTH),
  coverMediaId: z.string().min(1).max(64).nullable(),
}).strict();
const albumSaveSchema = z.object({
  revision: z.number().int().min(0),
  entries: z.array(albumEntrySchema).max(ALBUM_MAX_ENTRIES),
  metadata: albumMetadataSchema.optional(),
}).strict();
const albumPicksSchema = z.object({
  // The album cap, not the selection cap: the tray never sends more than a host can
  // select, but undoing `Start empty` restores a whole album in one request.
  mediaIds: z.array(z.string().min(1).max(64)).min(1).max(ALBUM_MAX_ENTRIES),
  picked: z.boolean(),
}).strict();
const albumStartSchema = z.object({ start: z.enum(['from-picks', 'empty']) }).strict();

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

/**
 * A destructive transition whose only inputs are its path.
 *
 * An absent or whitespace body counts as `{}`; anything with a key in it is a
 * client sending a parameter this route does not have, which is worth failing on
 * rather than ignoring.
 */
async function assertEmptyBody(context: Context<AppBindings>): Promise<void> {
  const raw = (await context.req.text().catch(() => '')).trim();
  let body: unknown = {};
  if (raw.length > 0) {
    try {
      body = JSON.parse(raw);
    } catch {
      throw new ApiError('VALIDATION_FAILED', 'This action takes no options.', 422);
    }
  }
  if (!emptyBodySchema.safeParse(body).success) {
    throw new ApiError('VALIDATION_FAILED', 'This action takes no options.', 422);
  }
}

export const manageRoutes = new Hono<AppBindings>();

// Recovery bodies name a photograph, its guest, and a deadline. None of that is
// shared, and none of it may sit in a cache keyed on the URL alone.
manageRoutes.use('/manage/events/:eventId/media/trash', privateJson);
manageRoutes.use('/manage/events/:eventId/media/:mediaId/trash', privateJson);
manageRoutes.use('/manage/events/:eventId/media/:mediaId/restore', privateJson);
manageRoutes.use('/manage/events/:eventId/media/:mediaId/cancel-reservation', privateJson);
manageRoutes.use('/manage/events/:eventId/gallery/summary', privateJson);

// Re-displays the printed credential for a host who lost the card. There is no
// replacement action beside it on purpose: a new link would not be on the signs
// already standing at the venue.
manageRoutes.get('/manage/events/:eventId/entry', async (context) => {
  const auth = await managerForEvent(context);
  const entry = await new EventEntryService(context.env, requestOrigin(context)).recover(auth.event.id);
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
  const result = await new EventEntryService(context.env, requestOrigin(context)).rotateInternalGuestGrant(auth.event);
  return context.json({ data: result, requestId: context.get('requestId') });
});

manageRoutes.post('/manage/events/:eventId/entry/disable', async (context) => {
  const auth = await managerForEvent(context, true);
  await assertEventNameConfirmed(context, auth.event.name);
  const result = await new EventEntryService(context.env, requestOrigin(context)).disable(auth.event);
  return context.json({ data: result, requestId: context.get('requestId') });
});

// The cover mutation surface lives in `routes/event-cover.ts`. The presigned
// trio that stood here let a client name its own object key, PUT unbounded
// bytes straight to R2, and eagerly deleted the displaced original with no
// inventory row behind it — none of which survives §9.5. Removing it also
// closes the dead path where `image/heic-sequence` and `image/heif-sequence`
// could be reserved but could never finalize, because cover finalize never
// applied the aliasing `finalizeStoredMedia` applies.

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
    data: { event: await selectManagerEventView(context.env, updated) },
    requestId: context.get('requestId'),
  });
});

manageRoutes.delete('/manage/events/:eventId', async (context) => {
  const auth = await managerForEvent(context, true);
  const parsed = deleteSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success || parsed.data.confirmation !== auth.event.name) {
    throw new ApiError('VALIDATION_FAILED', 'Type the event name exactly to delete it.', 422, { confirmation: 'Event name does not match.' });
  }
  const summary = await deleteEventData(context.env, auth.event.id);
  const requestId = context.get('requestId');
  return summary.remainder
    ? context.json({ data: { deletionScheduled: true }, requestId }, 202)
    : context.json({ data: { deleted: true }, requestId });
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
  // Reopening RSVP after the printed entry was disabled would leave guests with
  // an event that accepts submissions and no working way in. Manager authority
  // does not outrank the irreversible stop.
  if (parsed.data.rsvpEnabled) {
    await new EventEntryService(context.env, requestOrigin(context)).requireOpenEntry(auth.event.id);
  }

  const eventTimezone = canonicalTimeZone(parsed.data.eventTimezone) ?? parsed.data.eventTimezone;
  // A pre-release settings bundle does not send eventStartTime. Preserve the
  // host's existing wall-clock choice, including across a time-zone edit,
  // instead of interpreting omission as a destructive reset to midnight.
  const resolvedEventStartTime = parsed.data.eventStartTime ?? eventStartTime(auth.event);
  // Any edit to the start time, the deadline date, or the zone recomputes both
  // absolute instants from the same tuple, and they are written together below.
  const schedule = resolveEventSchedule(
    {
      ...parsed.data,
      eventDate: auth.event.eventDate,
      eventTimezone,
      eventStartTime: resolvedEventStartTime,
    },
    'Check the event settings.',
  );

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
    { ...parsed.data, eventTimezone, ...schedule, expectedRosterVersion: rosterVersion },
  );
  if (!event) {
    // The update now refuses an RSVP reopen itself, so a lost row is no longer
    // proof of a roster race. Re-read the entry before naming the reason: the
    // irreversible stop and a moving guest list are different problems with
    // different ways out.
    if (parsed.data.rsvpEnabled) {
      await new EventEntryService(context.env, requestOrigin(context)).requireOpenEntry(auth.event.id);
    }
    throw new ApiError(
      'RSVP_ROSTER_INVALID',
      'The guest list changed while these settings were saving. Review it and try again.',
      409,
      { rsvpEnabled: 'The guest list changed while these settings were saving.' },
    );
  }
  return context.json({
    data: { event: await selectManagerEventView(context.env, event) },
    requestId: context.get('requestId'),
  });
});

/**
 * The four photo-delivery transitions, and never a client timestamp.
 *
 * Which one is legal is decided from the row as it stands, inside the guarded
 * write. A manager page that loaded before the event started therefore cannot
 * send a pre-start action after it: the statement matches nothing and the host
 * is told to reload.
 *
 * A stale or illegal transition is a 409 in the existing `VALIDATION_FAILED`
 * envelope rather than a new error code — there is no new failure kind here,
 * only a view that has fallen behind the clock.
 */
manageRoutes.post('/manage/events/:eventId/photo-intake', async (context) => {
  const auth = await managerForEvent(context, true);
  const parsed = photoIntakeSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError('VALIDATION_FAILED', 'Choose a valid photo delivery action.', 422);
  }
  // Cheap, honest refusal ahead of the write for the one case the host cannot
  // resolve by reloading. The statement refuses it as well.
  if (parsed.data.action === 'reopen') {
    await new EventEntryService(context.env, requestOrigin(context)).requireOpenEntry(auth.event.id);
  }
  const event = await new EventsRepository(context.env.DB)
    .applyPhotoIntake(auth.event.id, parsed.data.action);
  if (!event) {
    throw new ApiError(
      'VALIDATION_FAILED',
      'Photo delivery has moved on since this page loaded. Reload and try again.',
      409,
    );
  }
  return context.json({
    data: { event: await selectManagerEventView(context.env, event) },
    requestId: context.get('requestId'),
  });
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

manageRoutes.get('/manage/events/:eventId/gallery', async (context) => {
  await managerForEvent(context);
  const eventId = context.req.param('eventId');

  const rawQuery = context.req.query('query');
  let query: string | undefined;
  if (rawQuery !== undefined) {
    const trimmed = rawQuery.trim();
    const codePoints = [...trimmed].length;
    if (codePoints < 1 || codePoints > GALLERY_SEARCH_MAX_CODE_POINTS) {
      throw new ApiError(
        'VALIDATION_FAILED',
        `Search must contain between 1 and ${GALLERY_SEARCH_MAX_CODE_POINTS} characters.`,
        422,
      );
    }
    query = trimmed;
  }
  const rawFavorites = context.req.query('favorites');
  if (rawFavorites !== undefined && rawFavorites !== '1') {
    throw new ApiError('VALIDATION_FAILED', 'The favorites filter is invalid.', 422);
  }
  const limit = galleryLimitSchema.safeParse(context.req.query('limit'));
  if (!limit.success) {
    throw new ApiError(
      'VALIDATION_FAILED',
      `Ask for between 1 and ${PRIVATE_GALLERY_PAGE_SIZE} photos per page.`,
      422,
    );
  }
  const rawOrder = context.req.query('order');
  if (rawOrder !== undefined && !(GALLERY_TIMELINE_ORDERS as readonly string[]).includes(rawOrder)) {
    throw new ApiError('VALIDATION_FAILED', 'The gallery order is invalid.', 422);
  }
  const order = (rawOrder ?? DEFAULT_GALLERY_TIMELINE_ORDER) as GalleryTimelineOrder;
  const rawCursor = context.req.query('cursor');
  const cursor = rawCursor === undefined ? undefined : decodeGalleryCursor(rawCursor, order);
  const mediaRepository = new MediaRepository(context.env.DB);
  if (await mediaRepository.countStoredTimelineSentinels(eventId) > 0) {
    throw new ApiError(
      'MEDIA_STATE_CONFLICT',
      'The private gallery is still preparing. Try again shortly.',
      409,
    );
  }
  const page = await mediaRepository.listGalleryTimeline(
    eventId,
    {
      query,
      favorites: rawFavorites === '1',
      cursor,
      limit: limit.data,
      order,
    },
  );
  return context.json({
    data: {
      media: page.media,
      nextCursor: page.nextCursor ? encodeGalleryCursor(page.nextCursor, order) : null,
    },
    requestId: context.get('requestId'),
  });
});

manageRoutes.put('/manage/events/:eventId/media/:mediaId/favorite', async (context) => {
  await managerForEvent(context, true);
  const parsed = favoriteSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError('VALIDATION_FAILED', 'Choose whether to favorite this photo.', 422);
  }
  const eventId = context.req.param('eventId');
  const mediaId = context.req.param('mediaId');
  const requestId = context.get('requestId');
  const mediaRepository = new MediaRepository(context.env.DB);
  try {
    const media = await mediaRepository.setFavorite(
      eventId,
      mediaId,
      parsed.data.favorite ? new Date().toISOString() : null,
    );
    console.info(JSON.stringify({
      event: 'manager_gallery_favorite_write',
      eventId,
      mediaId,
      favorite: parsed.data.favorite,
      result: 'succeeded',
      requestId,
    }));
    return context.json({
      data: { media: managerGalleryMediaView(media) },
      requestId,
    });
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'manager_gallery_favorite_write',
      eventId,
      mediaId,
      favorite: parsed.data.favorite,
      result: error instanceof ApiError ? 'refused' : 'failed',
      errorCode: error instanceof ApiError ? error.code : 'INTERNAL_ERROR',
      requestId,
    }));
    throw error;
  }
});

manageRoutes.get('/manage/events/:eventId/album', async (context) => {
  await managerForEvent(context);
  const album = await new AlbumRepository(context.env.DB).get(context.req.param('eventId'));
  return context.json({ data: { album }, requestId: context.get('requestId') });
});

manageRoutes.get('/manage/events/:eventId/gallery/summary', async (context) => {
  const auth = await requireManager(context);
  const [album, albumLink, guestGalleryPublishedCount] = await Promise.all([
    new AlbumRepository(context.env.DB).get(auth.event.id),
    new AlbumSharesRepository(context.env.DB).audienceStatus(auth.event.id),
    new MediaRepository(context.env.DB).countPublishedForGallerySummary(auth.event.id),
  ]);
  const summary: GalleryAudienceSummaryView = {
    albumPhotoCount: album.photoCount,
    albumEntryCount: album.entries.length,
    albumLink,
    guestGalleryVisible: auth.event.galleryVisible,
    guestGalleryPublishedCount,
  };
  return context.json({ data: { summary }, requestId: context.get('requestId') });
});

/**
 * Replaces the album's order. Reorder, add a section, rename one, and remove one are all
 * this request — the client composes the list it wants and sends it whole, so there is no
 * per-operation endpoint whose failure could leave the order half-applied.
 *
 * Membership is not settable here. A photo id the host has not picked is dropped on read
 * rather than refused, because the two writes race by design: a co-host unpicking a photo
 * while this host drags it must not fail the drag.
 */
manageRoutes.put('/manage/events/:eventId/album', async (context) => {
  await managerForEvent(context, true);
  const parsed = albumSaveSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) {
    const sections = fieldErrors(parsed.error);
    throw new ApiError(
      'VALIDATION_FAILED',
      `An album holds up to ${ALBUM_MAX_ENTRIES} entries and ${ALBUM_MAX_SECTIONS} sections. Titles hold ${ALBUM_TITLE_MAX_LENGTH} characters, descriptions hold ${ALBUM_DESCRIPTION_MAX_LENGTH}, and section names hold ${ALBUM_SECTION_HEADING_MAX_LENGTH}.`,
      422,
      sections,
    );
  }
  const album = await new AlbumRepository(context.env.DB).replace(
    context.req.param('eventId'),
    parsed.data.revision,
    parsed.data.entries,
    parsed.data.metadata,
    new Date().toISOString(),
  );
  return context.json({ data: { album }, requestId: context.get('requestId') });
});

/**
 * Bulk album picks — the selection tray, and the undo that reverses it.
 *
 * `changed` is the write's own account of what it altered, not an echo of the request:
 * undo re-applies exactly that, so reversing `Add 12 to album` over a page where four
 * were already picked restores those four to picked rather than removing them.
 */
manageRoutes.post('/manage/events/:eventId/album/picks', async (context) => {
  await managerForEvent(context, true);
  const parsed = albumPicksSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError(
      'VALIDATION_FAILED',
      `Choose between 1 and ${ALBUM_MAX_ENTRIES} photos.`,
      422,
    );
  }
  const eventId = context.req.param('eventId');
  const requestId = context.get('requestId');
  const media = new MediaRepository(context.env.DB);

  const changed = await media.setFavoriteBulk(
    eventId,
    parsed.data.mediaIds,
    parsed.data.picked ? new Date().toISOString() : null,
  );
  console.info(JSON.stringify({
    event: 'manager_album_picks_write',
    eventId,
    requested: parsed.data.mediaIds.length,
    changed: changed.length,
    picked: parsed.data.picked,
    result: 'succeeded',
    requestId,
  }));
  return context.json({ data: { changed }, requestId });
});

/**
 * Answers the reconciliation prompt once, for an event whose hosts used the heart before
 * the album existed. `from-picks` keeps those photos and commits; `empty` clears them and
 * commits. Both mark the album saved, so the prompt never returns — including for the
 * co-host who was mid-scroll when it was answered.
 */
manageRoutes.post('/manage/events/:eventId/album/start', async (context) => {
  await managerForEvent(context, true);
  const parsed = albumStartSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) throw new ApiError('VALIDATION_FAILED', 'Choose how to start this album.', 422);
  const eventId = context.req.param('eventId');
  const { album, started, cleared } = await new AlbumRepository(context.env.DB).start(
    eventId,
    parsed.data.start,
    new Date().toISOString(),
  );
  return context.json({ data: { album, started, cleared }, requestId: context.get('requestId') });
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
  const result = await repository.setPublication(
    media.id,
    parsed.data.expectedStatus,
    publicationTarget(parsed.data.action),
    new Date().toISOString(),
  );
  const item = await new GuestbookRepository(context.env.DB).captionItemById(result.id);
  return context.json({
    data: { media: managerMediaView(result), item },
    requestId: context.get('requestId'),
  });
});

/**
 * Move one delivered photo to Recently deleted.
 *
 * The body is strictly empty. Everything that decides the outcome — which photo,
 * which event, and how long recovery lasts — is either in the path or computed
 * by the server from the event's own expiry values, so there is nothing a client
 * could usefully send and nothing it could get wrong.
 */
manageRoutes.post('/manage/events/:eventId/media/:mediaId/trash', async (context) => {
  await managerForEvent(context, true);
  await assertEmptyBody(context);
  const media = await new MediaRepository(context.env.DB).trashStored(
    context.req.param('eventId'),
    context.req.param('mediaId'),
    new Date().toISOString(),
  );
  return context.json({
    data: { media: managerTrashedMediaView(media) },
    requestId: context.get('requestId'),
  });
});

manageRoutes.post('/manage/events/:eventId/media/:mediaId/restore', async (context) => {
  await managerForEvent(context, true);
  await assertEmptyBody(context);
  const media = await new MediaRepository(context.env.DB).restoreTrashed(
    context.req.param('eventId'),
    context.req.param('mediaId'),
    new Date().toISOString(),
  );
  return context.json({
    data: { media: managerMediaView(media) },
    requestId: context.get('requestId'),
  });
});

manageRoutes.get('/manage/events/:eventId/media/trash', async (context) => {
  await managerForEvent(context);
  const limit = trashLimitSchema.safeParse(context.req.query('limit'));
  if (!limit.success) {
    throw new ApiError(
      'VALIDATION_FAILED',
      `Ask for between 1 and ${MANAGER_MEDIA_MAX_PAGE_SIZE} photos per page.`,
      422,
    );
  }
  const rawCursor = context.req.query('cursor');
  const page = await new MediaRepository(context.env.DB).listTrashed(context.req.param('eventId'), {
    cursor: rawCursor === undefined ? undefined : decodeTrashCursor(rawCursor),
    limit: limit.data,
  });
  return context.json({
    data: {
      media: page.media,
      nextCursor: page.nextCursor ? encodeTrashCursor(page.nextCursor) : null,
    },
    requestId: context.get('requestId'),
  });
});

/**
 * Cancel one reservation that never became a photograph.
 *
 * Recovery is for delivered originals. A reserved or failed row has no bytes a
 * host could want back, so this is permanent — and it is a separate route rather
 * than a value in the publication enum, so nothing can reach it by sending the
 * wrong word to the wrong photo.
 */
manageRoutes.post('/manage/events/:eventId/media/:mediaId/cancel-reservation', async (context) => {
  await managerForEvent(context, true);
  await assertEmptyBody(context);
  const repository = new MediaRepository(context.env.DB);
  const media = await repository.getById(context.req.param('mediaId'));
  if (!media || media.eventId !== context.req.param('eventId')) {
    throw new ApiError('RESOURCE_FORBIDDEN', 'This photo belongs to a different event.', 403);
  }
  if (media.uploadState === 'stored') {
    throw new ApiError(
      'MEDIA_STATE_CONFLICT',
      'This photo was delivered. Move it to Recently deleted instead.',
      409,
    );
  }
  const cancelledAt = new Date().toISOString();
  const cancelled = await repository.delete(media.id, cancelledAt);
  await retireMediaObjects(
    context.env.MEDIA_BUCKET,
    context.env.CANONICAL_MEDIA_BUCKET,
    repository,
    media,
    cancelledAt,
  ).catch(() => undefined);
  return context.json({
    data: { media: uploadMediaView(cancelled) },
    requestId: context.get('requestId'),
  });
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
  return context.json({
    data: { changed: changed.map(managerMediaView) },
    requestId: context.get('requestId'),
  });
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
  const result = await new LinkService(context.env, requestOrigin(context)).rotateManagementLink(auth.event);
  return context.json({ data: result, requestId: context.get('requestId') });
});

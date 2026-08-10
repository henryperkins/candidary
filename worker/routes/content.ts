import { Hono, type Context } from 'hono';

import { presetCoverAssetPath } from '../../shared/event-cover-assets';
import {
  EVENT_COVER_EFFECTS,
  EVENT_COVER_PRESET_IDS,
  EVENT_COVER_PROFILES,
  parseStoredCoverConfig,
  type EventCoverDensity,
  type EventCoverFormat,
  type EventCoverProfileId,
} from '../../shared/event-cover';
import { ApiError } from '../../shared/errors';
import { requireManager, resolveManager } from '../auth/manager';
import { AuthService } from '../auth/service';
import { MediaRepository } from '../db/media';
import type { EventRecord } from '../db/types';
import type { AppBindings } from '../env';
import { getSessionCookie } from '../http/cookies';
import { getOrCreatePreview } from '../storage/previews';
import { isEventCoverKey } from '../storage/event-cover-keys';

export const contentRoutes = new Hono<AppBindings>();

const COVER_PROFILE_IDS = new Set<string>(EVENT_COVER_PROFILES.map(({ id }) => id));
const COVER_PRESET_IDS = new Set<string>(EVENT_COVER_PRESET_IDS);
const COVER_EFFECT_IDS = new Set<string>(EVENT_COVER_EFFECTS);
const COVER_DENSITIES = new Set<string>(['1x', '2x'] satisfies EventCoverDensity[]);
const COVER_FORMATS = new Set<string>(['webp', 'jpeg'] satisfies EventCoverFormat[]);

interface CoverDeliverySlot {
  revision: number;
  profile: EventCoverProfileId;
  density: EventCoverDensity;
  format: EventCoverFormat;
}

function coverNotFound(): ApiError {
  return new ApiError('EVENT_NOT_FOUND', 'This event does not have that cover image.', 404);
}

function coverObjectMissing(): ApiError {
  return new ApiError('UPLOAD_OBJECT_MISSING', 'The cover is temporarily unavailable.', 404);
}

function deliverySlot(context: Context<AppBindings>): CoverDeliverySlot {
  const revisionValue = context.req.param('revision') ?? '';
  const profile = context.req.param('profile') ?? '';
  const encodedSlot = context.req.param('slot') ?? '';
  const slotMatch = /^([^.]+)\.([^.]+)$/u.exec(encodedSlot);
  const density = slotMatch?.[1] ?? '';
  const format = slotMatch?.[2] ?? '';
  if (!/^(?:0|[1-9][0-9]*)$/u.test(revisionValue)
    || !COVER_PROFILE_IDS.has(profile)
    || !COVER_DENSITIES.has(density)
    || !COVER_FORMATS.has(format)) {
    throw coverNotFound();
  }
  const revision = Number(revisionValue);
  if (!Number.isSafeInteger(revision)) throw coverNotFound();
  return {
    revision,
    profile: profile as EventCoverProfileId,
    density: density as EventCoverDensity,
    format: format as EventCoverFormat,
  };
}

function storedDeliveryConfig(event: EventRecord) {
  let value: unknown;
  try {
    value = JSON.parse(event.coverConfig);
  } catch {
    throw new Error('Stored event cover config is invalid.');
  }
  const config = parseStoredCoverConfig(value);
  if (!config) throw new Error('Stored event cover config is invalid.');
  return config;
}

async function revisionedCoverResponse(
  context: Context<AppBindings>,
  event: EventRecord,
): Promise<Response> {
  const slot = deliverySlot(context);
  if (slot.revision !== event.coverRevision) throw coverNotFound();

  const config = storedDeliveryConfig(event);
  if (config.source.kind === 'none') throw coverNotFound();
  if (!('effect' in config)) throw coverNotFound();
  if (config.source.kind === 'preset') {
    // The strict stored parser already constrains these values. The explicit
    // registry membership checks keep this delivery boundary fail-closed if a
    // future parser version ever becomes more permissive.
    if (!COVER_PRESET_IDS.has(config.source.presetId) || !COVER_EFFECT_IDS.has(config.effect)) {
      throw coverNotFound();
    }
    const location = presetCoverAssetPath(
      config.source.assetVersion,
      config.source.presetId,
      config.effect,
      slot.profile,
      slot.density,
      slot.format,
    );
    return new Response(null, {
      status: 307,
      headers: {
        Location: location,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  if (!event.coverRenderSetId || !event.coverObjectKey) throw coverObjectMissing();
  const objectRow = await context.env.DB.prepare(`
    SELECT o.object_key, o.content_type
    FROM event_cover_render_objects o
    JOIN event_cover_render_sets s
      ON s.id = o.render_set_id AND s.event_id = o.event_id
    WHERE o.render_set_id = ? AND o.event_id = ?
      AND o.profile_id = ? AND o.density = ? AND o.format = ?
      AND s.state = 'active' AND s.published_revision = ?
    LIMIT 1
  `).bind(
    event.coverRenderSetId,
    event.id,
    slot.profile,
    slot.density,
    slot.format,
    event.coverRevision,
  ).first<{ object_key: string; content_type: string }>();
  const expectedContentType = slot.format === 'webp' ? 'image/webp' : 'image/jpeg';
  if (!objectRow
    || objectRow.content_type !== expectedContentType
    || !isEventCoverKey(event.id, objectRow.object_key)) {
    throw coverObjectMissing();
  }

  const object = await context.env.MEDIA_BUCKET.get(objectRow.object_key);
  if (!object?.body) throw coverObjectMissing();
  return new Response(object.body, {
    headers: {
      'Content-Type': expectedContentType,
      'Content-Length': String(object.size),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/**
 * The compatibility reader.
 *
 * Three branches, and the third is the one the specification leaves open. §9.5
 * names only the active-render-set case and the legacy null-set case, but §8's
 * invariants also allow `none` and `preset` rows whose render-set pointer is
 * null and whose `cover_object_key` is null — those are the existing 404.
 *
 * Branch 1 is why this landed before the routes. Once a publication repoints
 * `cover_object_key` at the normalized WebP master, streaming that column
 * verbatim would hand guests the private high-resolution master. Serving the
 * active set's `wide-expanded` 1x JPEG instead is what keeps the current URL
 * shape honest until the responsive routes exist.
 */
async function coverResponse(context: Context<AppBindings>, event: EventRecord) {
  const objectKey = await deliverableCoverKey(context, event);
  if (!objectKey) {
    throw new ApiError('EVENT_NOT_FOUND', 'This event does not have a cover image.', 404);
  }
  const object = await context.env.MEDIA_BUCKET.get(objectKey.key);
  if (!object?.body) throw new ApiError('UPLOAD_OBJECT_MISSING', 'The cover is temporarily unavailable.', 404);
  return new Response(object.body, { headers: {
    // A derivative's content type is server-owned; a legacy original's comes
    // from its stored R2 metadata, exactly as it did before.
    'Content-Type': objectKey.contentType ?? object.httpMetadata?.contentType ?? 'application/octet-stream',
    'Content-Length': String(object.size), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
  } });
}

async function deliverableCoverKey(
  context: Context<AppBindings>,
  event: EventRecord,
): Promise<{ key: string; contentType: string | null } | null> {
  if (event.coverRenderSetId) {
    const derivative = await context.env.DB.prepare(`
      SELECT o.object_key AS key FROM event_cover_render_objects o
      JOIN event_cover_render_sets s ON s.id = o.render_set_id
      WHERE o.render_set_id = ? AND o.event_id = ? AND s.state = 'active'
        AND o.profile_id = 'wide-expanded' AND o.density = '1x' AND o.format = 'jpeg'
    `).bind(event.coverRenderSetId, event.id).first<{ key: string }>();
    // Never falls back to a prior set, a master, the object key, or an
    // on-demand transform. Delivery is read-only.
    if (!derivative) {
      throw new ApiError('UPLOAD_OBJECT_MISSING', 'The cover is temporarily unavailable.', 404);
    }
    return { key: derivative.key, contentType: 'image/jpeg' };
  }
  // A legacy null-set row keeps the current original response for the length of
  // the phase-1/phase-2 compatibility window, and no longer.
  return event.coverObjectKey ? { key: event.coverObjectKey, contentType: null } : null;
}

contentRoutes.get('/event/:slug/cover/:revision/:profile/:slot', async (context) => {
  const auth = await new AuthService(context.env).resolveEventSession(getSessionCookie(context));
  if (auth.event.slug !== context.req.param('slug')) throw coverNotFound();
  return revisionedCoverResponse(context, auth.event);
});

contentRoutes.get('/manage/events/:eventId/cover/:revision/:profile/:slot', async (context) => {
  const auth = await requireManager(context);
  return revisionedCoverResponse(context, auth.event);
});

contentRoutes.get('/event/:slug/cover', async (context) => {
  const auth = await new AuthService(context.env).resolveEventSession(getSessionCookie(context));
  if (auth.event.slug !== context.req.param('slug')) {
    throw new ApiError('EVENT_NOT_FOUND', 'This event does not have a cover image.', 404);
  }
  return coverResponse(context, auth.event);
});

contentRoutes.get('/manage/events/:eventId/cover', async (context) => {
  const auth = await requireManager(context);
  return coverResponse(context, auth.event);
});

async function previewResponse(context: Context<AppBindings>) {
  const repository = new MediaRepository(context.env.DB);
  const media = await repository.getById(context.req.param('mediaId')!);
  if (!media || media.uploadState !== 'stored' || media.deletedAt) {
    throw new ApiError('ROLE_FORBIDDEN', 'This photo is not available.', 403);
  }
  // The event comes from the row here, not the path, so authorization is asked per
  // photo: hosting the event by either credential is enough, and anyone else falls
  // back to the guest rules for their own upload or a published one.
  if (!await resolveManager(context, media.eventId)) {
    const auth = await new AuthService(context.env).resolveEventSession(getSessionCookie(context));
    const guestCanRead = auth.event.id === media.eventId
      && (media.uploaderSessionId === auth.session.id
        || (media.publicationStatus === 'published' && auth.event.galleryVisible));
    if (!guestCanRead) throw new ApiError('ROLE_FORBIDDEN', 'This photo is not available.', 403);
  }

  const object = await getOrCreatePreview(context.env, media, repository);
  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType ?? 'image/webp',
      'Content-Length': String(object.size),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

contentRoutes.get('/media/:mediaId/preview', previewResponse);
contentRoutes.get('/media/:mediaId/content', previewResponse);

contentRoutes.get('/media/:mediaId/original', async (context) => {
  const media = await new MediaRepository(context.env.DB).getById(context.req.param('mediaId'));
  if (!media || media.uploadState !== 'stored' || media.deletedAt) {
    throw new ApiError('ROLE_FORBIDDEN', 'This photo is not available.', 403);
  }
  await requireManager(context, {
    eventId: media.eventId,
    deniedMessage: 'Only the event host can download original photos.',
  });
  const object = await context.env.MEDIA_BUCKET.get(media.objectKey);
  if (!object?.body) throw new ApiError('UPLOAD_OBJECT_MISSING', 'This original photo is temporarily unavailable.', 404);
  const filename = encodeURIComponent(media.originalFilename);
  return new Response(object.body, {
    headers: {
      'Content-Type': media.mimeType,
      'Content-Length': String(object.size),
      'Content-Disposition': `attachment; filename*=UTF-8''${filename}`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

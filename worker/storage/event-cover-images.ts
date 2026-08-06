import {
  COVER_PAPER_MATTE,
  MAX_COVER_MASTER_BYTES,
  MAX_COVER_PREVIEW_BYTES,
  MIN_COVER_SOURCE_HEIGHT,
  MIN_COVER_SOURCE_WIDTH,
} from '../../shared/constants';
import {
  COVER_MASTER_LADDER,
  COVER_PIPELINE_VERSIONS,
  COVER_PREVIEW_LADDER,
  type CoverFocusPoint,
  type EventCoverDensity,
  type EventCoverEffectId,
  type EventCoverFormat,
  type EventCoverProfileId,
  coverByteCeiling,
  coverOutputQualities,
  coverProfile,
  coverProfileCrop,
  coverTrimRectangle,
} from '../../shared/event-cover';
import { ApiError } from '../../shared/errors';
import type { AppEnv } from '../env';
import { coverMasterKey, coverPreviewKey, coverRenderKey } from './event-cover-keys';

/**
 * Every Images call the cover pipeline makes, and the only module allowed to
 * name a transformation parameter.
 *
 * Two platform facts are load-bearing and were read off the generated binding
 * types rather than assumed:
 *
 *  - `ImageTransform` has no `metadata` option. The binding does not accept a
 *    metadata directive at all — stripping is its behaviour, not a request — so
 *    §10.1's `metadata: none` is satisfied by using the binding rather than by
 *    passing a flag. Nothing local proves the bytes are actually clean; that is
 *    a deployed-conformance claim and stays one.
 *  - `gravity`'s coordinate form requires `mode`. A focal recipe that omits it
 *    does not typecheck, which is the only reason this is worth saying.
 *
 * The fixed `#fffaf3` paper matte is composited on every transform and every
 * output, so a transparent PNG or WebP cannot produce edges that differ between
 * the WebP and JPEG members of the same slot.
 */

/** Pixels only, for the geometry that does not care what decoded them. */
export interface CoverPixelBounds {
  width: number;
  height: number;
}

export interface CoverSourceInfo extends CoverPixelBounds {
  /** What the decoder actually found, which the declaration must match. */
  format: string;
}

export interface CoverMasterResult {
  objectKey: string;
  byteSize: number;
  width: number;
  height: number;
  sha256: string;
  rung: number;
  normalizationVersion: number;
}

export interface CoverPreviewResult {
  objectKey: string;
  byteSize: number;
  width: number;
  height: number;
  sha256: string;
  rung: number;
  recipeVersion: number;
}

export interface CoverRenderObjectResult {
  objectKey: string;
  profile: EventCoverProfileId;
  density: EventCoverDensity;
  format: EventCoverFormat;
  contentType: string;
  byteSize: number;
  width: number;
  height: number;
  sha256: string;
  rung: number;
  adopted: boolean;
}

export interface CoverManifestVerdict {
  complete: boolean;
  missing: string[];
  mismatched: string[];
}

/**
 * The five fixed tonal recipes.
 *
 * Implementation constants built only from allowlisted operations. A host never
 * submits a numeric value, and `film` carries only its tonal half — the grain is
 * one versioned tileable asset layered at runtime, so it never multiplies the
 * rendered matrix and a reduced-motion or contrast change does not re-render.
 */
const EFFECT_RECIPES: Record<EventCoverEffectId, Record<string, number>> = {
  natural: { sharpen: 1 },
  warm: { gamma: 1.05, saturation: 1.08, contrast: 0.96, sharpen: 1 },
  film: { contrast: 1.12, saturation: 0.88, sharpen: 1 },
  soft: { brightness: 1.06, contrast: 0.9, sharpen: 0.6 },
  monochrome: { saturation: 0, contrast: 1.05, sharpen: 1 },
};

const OUTPUT_CONTENT_TYPE: Record<EventCoverFormat, 'image/webp' | 'image/jpeg'> = {
  webp: 'image/webp',
  jpeg: 'image/jpeg',
};

function requireImages(env: AppEnv): ImagesBinding {
  // `env.IMAGES` is typed non-optional but the preview path guards it, so the
  // binding really can be absent at runtime. Cover work gets a code whose name
  // matches its meaning rather than reusing FILE_TYPE_UNSUPPORTED.
  if (!env.IMAGES) {
    throw new ApiError(
      'COVER_RENDER_UNAVAILABLE',
      'Cover images cannot be prepared right now. Try again shortly.',
      503,
    );
  }
  return env.IMAGES;
}

async function sourceBytes(env: AppEnv, key: string): Promise<ArrayBuffer> {
  const object = await env.MEDIA_BUCKET.get(key);
  if (!object?.body) {
    throw new ApiError('UPLOAD_OBJECT_MISSING', 'That photo is no longer available.', 404);
  }
  return object.arrayBuffer();
}

async function hexDigest(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function readCoverSourceInfo(env: AppEnv, bytes: ArrayBuffer): Promise<CoverSourceInfo> {
  const info = await requireImages(env).info(new Response(bytes).body!);
  const width = 'width' in info ? info.width : 0;
  const height = 'height' in info ? info.height : 0;
  const format = 'format' in info ? String(info.format) : '';
  if (!width || !height) {
    throw new ApiError(
      'COVER_SOURCE_UNSUPPORTED',
      'That file could not be read as a photo. Choose a JPEG, PNG, WebP, or HEIC image.',
      422,
    );
  }
  return { width, height, format };
}

/**
 * The dimensions a rung produces for this source, never upscaling.
 *
 * Both the long-edge and the area cap are applied here rather than left to
 * `fit: 'scale-down'`, because scale-down bounds the longest edge only and a
 * panoramic source can sit inside the edge cap while blowing the area budget.
 */
function rungTarget(
  source: CoverPixelBounds,
  rung: { longEdge: number; area?: number },
): CoverPixelBounds {
  const longEdge = Math.max(source.width, source.height);
  const edgeScale = Math.min(1, rung.longEdge / longEdge);
  const areaScale = rung.area
    ? Math.min(1, Math.sqrt(rung.area / (source.width * source.height)))
    : 1;
  const scale = Math.min(edgeScale, areaScale);
  return {
    width: Math.max(1, Math.floor(source.width * scale)),
    height: Math.max(1, Math.floor(source.height * scale)),
  };
}

/**
 * Normalizes one raw upload into the canonical still WebP master.
 *
 * Five rungs, in order; the first result satisfying codec, dimensions, and the
 * byte ceiling wins. A rung that would take the master below the 1x minimum is
 * skipped rather than attempted, so a marginal source is not rejected by a rung
 * it never needed. Neither the raw nor the master is ever a delivery source.
 */
export async function normalizeCoverMaster(
  env: AppEnv,
  input: {
    eventId: string;
    masterId: string;
    rawKey: string;
    /** What the reservation declared, rechecked against the decoded bytes. */
    declaredMimeType?: string | null;
  },
): Promise<CoverMasterResult> {
  const images = requireImages(env);
  const raw = await sourceBytes(env, input.rawKey);
  const source = await readCoverSourceInfo(env, raw);

  // §10.1: inspection rechecks the detected type before passing bytes to
  // Images. A declaration is a claim; this is the only place the file itself
  // gets to contradict it.
  if (input.declaredMimeType && source.format && source.format !== input.declaredMimeType) {
    throw new ApiError(
      'COVER_SOURCE_UNSUPPORTED',
      'That file is not the kind of photo it claimed to be. Choose it again.',
      415,
    );
  }

  if (source.width < MIN_COVER_SOURCE_WIDTH || source.height < MIN_COVER_SOURCE_HEIGHT) {
    throw new ApiError(
      'COVER_SOURCE_TOO_SMALL',
      `Cover photos need to be at least ${MIN_COVER_SOURCE_WIDTH} by ${MIN_COVER_SOURCE_HEIGHT} pixels. Choose a larger photo.`,
      422,
    );
  }

  for (const [index, rung] of COVER_MASTER_LADDER.entries()) {
    const target = rungTarget(source, rung);
    if (target.width < MIN_COVER_SOURCE_WIDTH || target.height < MIN_COVER_SOURCE_HEIGHT) continue;

    const result = await images
      .input(new Response(raw).body!)
      .transform({
        width: target.width,
        height: target.height,
        fit: 'scale-down',
        background: COVER_PAPER_MATTE,
      })
      .output({
        format: 'image/webp',
        quality: rung.quality,
        background: COVER_PAPER_MATTE,
        anim: false,
      });
    const bytes = await new Response(result.image()).arrayBuffer();
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_COVER_MASTER_BYTES) continue;

    const objectKey = coverMasterKey(input.eventId, input.masterId);
    const sha256 = await hexDigest(bytes);
    await env.MEDIA_BUCKET.put(objectKey, bytes, {
      sha256,
      httpMetadata: { contentType: 'image/webp' },
      customMetadata: {
        width: String(target.width),
        height: String(target.height),
        rung: String(index + 1),
        normalizationVersion: String(COVER_PIPELINE_VERSIONS.normalizationLadder),
      },
    });
    // Reread before the raw is ever deleted: the row must describe an object
    // that is actually there.
    const stored = await env.MEDIA_BUCKET.head(objectKey);
    if (!stored) throw new Error('Normalized cover master could not be read back.');

    return {
      objectKey,
      byteSize: bytes.byteLength,
      width: target.width,
      height: target.height,
      sha256,
      rung: index + 1,
      normalizationVersion: COVER_PIPELINE_VERSIONS.normalizationLadder,
    };
  }

  throw new ApiError(
    'COVER_MASTER_BUDGET_EXHAUSTED',
    'That photo is too large or too panoramic to prepare. Choose a smaller or less wide photo.',
    422,
  );
}

/**
 * One uncropped, metadata-free preview of the master under one effect.
 *
 * Uncropped on purpose: the browser applies focus, zoom, and the measured canvas
 * crop to this single file locally, so dragging the crop performs no network
 * transform and one draft can never produce more than five preview files.
 */
export async function renderCoverPreview(
  env: AppEnv,
  input: {
    eventId: string;
    draftId: string;
    masterKey: string;
    effect: EventCoverEffectId;
  },
): Promise<CoverPreviewResult> {
  const images = requireImages(env);
  const master = await sourceBytes(env, input.masterKey);
  const source = await readCoverSourceInfo(env, master);

  for (const [index, rung] of COVER_PREVIEW_LADDER.entries()) {
    const target = rungTarget(source, rung);
    const result = await images
      .input(new Response(master).body!)
      .transform({
        width: target.width,
        height: target.height,
        fit: 'scale-down',
        background: COVER_PAPER_MATTE,
      })
      .transform(EFFECT_RECIPES[input.effect])
      .output({
        format: 'image/webp',
        quality: rung.quality,
        background: COVER_PAPER_MATTE,
        anim: false,
      });
    const bytes = await new Response(result.image()).arrayBuffer();
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_COVER_PREVIEW_BYTES) continue;

    const objectKey = coverPreviewKey(
      input.eventId,
      input.draftId,
      input.effect,
      COVER_PIPELINE_VERSIONS.previewRecipe,
    );
    const sha256 = await hexDigest(bytes);
    await env.MEDIA_BUCKET.put(objectKey, bytes, {
      sha256,
      httpMetadata: { contentType: 'image/webp' },
    });
    return {
      objectKey,
      byteSize: bytes.byteLength,
      width: target.width,
      height: target.height,
      sha256,
      rung: index + 1,
      recipeVersion: COVER_PIPELINE_VERSIONS.previewRecipe,
    };
  }

  throw new ApiError(
    'COVER_PREVIEW_BUDGET_EXHAUSTED',
    'That style could not be prepared for this photo. Choose another style or another photo.',
    422,
  );
}

/**
 * One profile/density/format slot, created or verified.
 *
 * Idempotent at the application level rather than by leasing: the key is
 * deterministic and the write is an immutable conditional create, so a replayed
 * Workflow step that finds the object already there reads and verifies it
 * instead of re-encoding and overwriting active bytes.
 */
export async function renderCoverProfileObject(
  env: AppEnv,
  input: {
    eventId: string;
    renderSetId: string;
    masterKey: string;
    master: CoverPixelBounds;
    focus: CoverFocusPoint;
    effect: EventCoverEffectId;
    profile: EventCoverProfileId;
    density: EventCoverDensity;
    format: EventCoverFormat;
  },
): Promise<CoverRenderObjectResult> {
  const objectKey = coverRenderKey(
    input.eventId,
    input.renderSetId,
    input.profile,
    input.density,
    input.format,
  );
  const existing = await env.MEDIA_BUCKET.get(objectKey);
  if (existing?.body) {
    const bytes = await existing.arrayBuffer();
    return {
      objectKey,
      profile: input.profile,
      density: input.density,
      format: input.format,
      contentType: OUTPUT_CONTENT_TYPE[input.format],
      byteSize: bytes.byteLength,
      width: Number(existing.customMetadata?.width ?? 0),
      height: Number(existing.customMetadata?.height ?? 0),
      sha256: await hexDigest(bytes),
      rung: Number(existing.customMetadata?.rung ?? 0),
      adopted: true,
    };
  }

  const profile = coverProfile(input.profile);
  const trim = coverTrimRectangle(input.master, input.focus);
  const crop = coverProfileCrop(trim, profile, input.density);
  if (!crop) {
    throw new ApiError(
      'COVER_OUTPUT_BUDGET_EXHAUSTED',
      'That photo cannot fill every layout at this crop. Zoom out a little and try again.',
      422,
    );
  }

  const scale = input.density === '2x' ? 2 : 1;
  const targetWidth = profile.width * scale;
  const targetHeight = profile.height * scale;
  // The focal point expressed inside the trim, so the aspect crop protects the
  // same subject at every profile rather than re-centring per aspect ratio.
  const gravity = {
    x: clamp01((input.focus.x * input.master.width - trim.left) / trim.width),
    y: clamp01((input.focus.y * input.master.height - trim.top) / trim.height),
    mode: 'box-center' as const,
  };

  const master = await sourceBytes(env, input.masterKey);
  const images = requireImages(env);
  const ceiling = coverByteCeiling(profile, input.density, input.format);

  for (const [index, quality] of coverOutputQualities(input.format).entries()) {
    const result = await images
      .input(new Response(master).body!)
      .transform({
        trim: { left: trim.left, top: trim.top, width: trim.width, height: trim.height },
        background: COVER_PAPER_MATTE,
      })
      .transform({
        width: targetWidth,
        height: targetHeight,
        // `cover` with upscaling disallowed by the geometry above: the crop was
        // already proven producible from this trim without enlargement.
        fit: 'cover',
        gravity,
        background: COVER_PAPER_MATTE,
      })
      .transform(EFFECT_RECIPES[input.effect])
      .output({
        format: OUTPUT_CONTENT_TYPE[input.format],
        quality,
        background: COVER_PAPER_MATTE,
        anim: false,
      });
    const bytes = await new Response(result.image()).arrayBuffer();
    if (bytes.byteLength === 0 || bytes.byteLength > ceiling) continue;

    const sha256 = await hexDigest(bytes);
    const written = await env.MEDIA_BUCKET.put(objectKey, bytes, {
      // Create-if-absent. A concurrent replay that lost the race gets null back
      // and adopts the winner rather than replacing bytes that may already be
      // part of an active manifest.
      onlyIf: { etagDoesNotMatch: '*' },
      sha256,
      httpMetadata: { contentType: OUTPUT_CONTENT_TYPE[input.format] },
      customMetadata: {
        width: String(targetWidth),
        height: String(targetHeight),
        rung: String(index + 1),
      },
    });
    if (!written) {
      return renderCoverProfileObject(env, input);
    }
    return {
      objectKey,
      profile: input.profile,
      density: input.density,
      format: input.format,
      contentType: OUTPUT_CONTENT_TYPE[input.format],
      byteSize: bytes.byteLength,
      width: targetWidth,
      height: targetHeight,
      sha256,
      rung: index + 1,
      adopted: false,
    };
  }

  throw new ApiError(
    'COVER_OUTPUT_BUDGET_EXHAUSTED',
    'That photo could not be prepared small enough for every screen. Choose another photo.',
    422,
  );
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Proves a set's inventory and its objects agree, before anything activates.
 *
 * Existence alone is not enough: a slot whose stored bytes drifted from the row
 * would activate a cover whose manifest lies, so dimensions, MIME, checksum,
 * rung, and the profile's byte ceiling are all re-read from R2.
 */
export async function verifyCoverManifest(
  env: AppEnv,
  renderSetId: string,
): Promise<CoverManifestVerdict> {
  const set = await env.DB.prepare(
    'SELECT required_slots FROM event_cover_render_sets WHERE id = ?',
  ).bind(renderSetId).first<{ required_slots: number }>();
  const { results } = await env.DB.prepare(`
    SELECT profile_id, density, format, object_key, content_type, byte_size, width, height,
           quality_rung, sha256
    FROM event_cover_render_objects WHERE render_set_id = ?
    ORDER BY profile_id, density, format
  `).bind(renderSetId).all<{
    profile_id: EventCoverProfileId;
    density: EventCoverDensity;
    format: EventCoverFormat;
    object_key: string;
    content_type: string;
    byte_size: number;
    width: number;
    height: number;
    quality_rung: number;
    sha256: string;
  }>();

  const missing: string[] = [];
  const mismatched: string[] = [];
  for (const row of results) {
    const slot = `${row.profile_id}/${row.density}/${row.format}`;
    const object = await env.MEDIA_BUCKET.get(row.object_key);
    if (!object?.body) {
      missing.push(slot);
      continue;
    }
    const bytes = await object.arrayBuffer();
    const profile = coverProfile(row.profile_id);
    const scale = row.density === '2x' ? 2 : 1;
    if (bytes.byteLength !== row.byte_size
      || bytes.byteLength > coverByteCeiling(profile, row.density, row.format)
      || row.content_type !== OUTPUT_CONTENT_TYPE[row.format]
      || row.width !== profile.width * scale
      || row.height !== profile.height * scale
      || row.quality_rung < 1 || row.quality_rung > 4
      || await hexDigest(bytes) !== row.sha256) {
      mismatched.push(slot);
    }
  }

  return {
    complete: missing.length === 0
      && mismatched.length === 0
      && results.length === (set?.required_slots ?? -1),
    missing,
    mismatched,
  };
}

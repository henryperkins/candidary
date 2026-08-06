import { z } from 'zod';

import {
  COVER_UPLOAD_MIME_TYPES,
  MAX_COVER_MANUAL_ZOOM,
  MAX_COVER_UPLOAD_BYTES,
  MIN_COVER_SOURCE_HEIGHT,
  MIN_COVER_SOURCE_WIDTH,
} from './constants';

// Re-exported so the cover domain reads as one module, on the same terms as
// `shared/rsvp.ts`. `shared/constants.ts` remains the only place these numbers
// are allowed to change.
export {
  COVER_UPLOAD_MIME_TYPES,
  MAX_COVER_MANUAL_ZOOM,
  MAX_COVER_UPLOAD_BYTES,
  MIN_COVER_SOURCE_HEIGHT,
  MIN_COVER_SOURCE_WIDTH,
};

/* ------------------------------------------------------------------ *
 * Identifiers
 * ------------------------------------------------------------------ */

export type EventCoverPresetId =
  | 'warm-linen'
  | 'botanical-shadow'
  | 'pressed-paper'
  | 'candlelit-grain'
  | 'coastal-haze'
  | 'midnight-wash';

export type EventCoverEffectId =
  | 'natural'
  | 'warm'
  | 'film'
  | 'soft'
  | 'monochrome';

/**
 * The six layout profiles, named.
 *
 * The specification references this union twice but never declares it; its
 * members are only inferable from the §10.2 registry table. It is authored here
 * because every one of these strings becomes a durable render-object row and an
 * R2 key segment the moment `0012` ships, so a naming mistake is not
 * correctable later.
 */
export type EventCoverProfileId =
  | 'short-lookup'
  | 'compact-default'
  | 'standard-default'
  | 'framed-default'
  | 'compact-expanded'
  | 'wide-expanded';

export type EventCoverDensity = '1x' | '2x';
export type EventCoverFormat = 'webp' | 'jpeg';

export type EventCoverSurfaceTreatmentId = 'none' | 'film-grain-v1';

/* ------------------------------------------------------------------ *
 * Version axes
 * ------------------------------------------------------------------ */

/**
 * Every independently versioned resolver in the cover pipeline.
 *
 * The specification requires these to be pinned but names none of them and
 * gives no values. One is baked into an R2 key template
 * (`{effect}-{recipeVersion}.webp`) and another into a published preset config,
 * so both become persisted data as soon as a cover is published. The registry
 * is append-only from `0012` onward: a version may be added, and a value may
 * move forward, but a name may never be reused for a different axis.
 */
export const COVER_PIPELINE_VERSIONS = {
  compositionModel: 1,
  inspectionRecipe: 1,
  /** The `{recipeVersion}` segment of a draft preview object key. */
  previewRecipe: 1,
  normalizationLadder: 1,
  imagesParameterRecipe: 1,
  matte: 1,
  metadataPolicy: 1,
  cropProfileRegistry: 1,
  tonalEffect: 1,
  sharpening: 1,
  outputQualityLadder: 1,
  /** The `assetVersion` pinned into a published preset config. */
  presetAsset: 1,
} as const;

export type CoverPipelineVersionAxis = keyof typeof COVER_PIPELINE_VERSIONS;

/* ------------------------------------------------------------------ *
 * Semantic persisted shape
 * ------------------------------------------------------------------ */

export type EventCoverFocusV1 =
  | { mode: 'auto' }
  | { mode: 'manual'; x: number; y: number; zoom: number };

/**
 * What the event row stores.
 *
 * Deliberately excludes object keys, draft IDs, and render-set IDs: those are
 * server-only pointers on their own columns, and a recipe write never carries
 * one. The automatic focal point lives on the master rather than here, so a
 * later edit can always reset from manual back to the original composition —
 * which is why an `auto` upload records only `mode: 'auto'`.
 */
export type StoredEventCoverConfigV1 =
  | { version: 1; source: { kind: 'none' } }
  | {
      version: 1;
      source: {
        kind: 'preset';
        presetId: EventCoverPresetId;
        assetVersion: 1;
      };
      effect: EventCoverEffectId;
    }
  | {
      version: 1;
      source: { kind: 'upload' };
      focus: EventCoverFocusV1;
      effect: EventCoverEffectId;
    };

export const CANONICAL_NONE_COVER_CONFIG: StoredEventCoverConfigV1 = {
  version: 1,
  source: { kind: 'none' },
};

/* ------------------------------------------------------------------ *
 * Safe projections
 * ------------------------------------------------------------------ */

export interface EventCoverPreparationView {
  operationId: string;
  status:
    | 'preparing'
    | 'applied'
    | 'retryable-failed'
    | 'permanent-failed'
    | 'conflict';
  completedSteps: number;
  requiredSteps: number;
  retryable: boolean;
  safeFailureCode: string | null;
  updatedAt: string;
}

export interface EventCoverView {
  config: StoredEventCoverConfigV1;
  revision: number;
  hasCover: boolean;
  available2xProfiles: readonly EventCoverProfileId[];
  surfaceTreatment: EventCoverSurfaceTreatmentId;
  preparation: EventCoverPreparationView | null;
}

export interface GuestEventCoverView {
  revision: number;
  hasCover: boolean;
  available2xProfiles: readonly EventCoverProfileId[];
  surfaceTreatment: EventCoverSurfaceTreatmentId;
}

/* ------------------------------------------------------------------ *
 * Request envelopes
 * ------------------------------------------------------------------ */

export type EventCoverPublishRequestV1 = {
  operationId: string;
  expectedRevision: number;
} & (
  | { source: { kind: 'none' } }
  | {
      source: { kind: 'preset'; presetId: EventCoverPresetId };
      effect: EventCoverEffectId;
    }
  | {
      source: { kind: 'upload'; draftId: string };
      focus:
        | { mode: 'auto' }
        | { mode: 'manual'; x: number; y: number; zoom: number };
      effect: EventCoverEffectId;
    }
);

export type EventCoverDraftCreateRequestV1 =
  | {
      draftIntentId: string;
      source: { kind: 'new-upload' };
      filename: string;
      mimeType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic';
      byteSize: number;
    }
  | {
      draftIntentId: string;
      source: { kind: 'existing-upload' };
      expectedCoverRevision: number;
    };

export interface EventCoverCompositionRequestV1 {
  expectedDraftRevision: number;
  modelVersion: number;
  x: number;
  y: number;
}

/* ------------------------------------------------------------------ *
 * Registries
 * ------------------------------------------------------------------ */

export interface EventCoverPreset {
  id: EventCoverPresetId;
  name: string;
}

/** Six global choices across Candidary, not six per theme. */
export const EVENT_COVER_PRESETS: readonly EventCoverPreset[] = [
  { id: 'warm-linen', name: 'Warm Linen' },
  { id: 'botanical-shadow', name: 'Botanical Shadow' },
  { id: 'pressed-paper', name: 'Pressed Paper' },
  { id: 'candlelit-grain', name: 'Candlelit Grain' },
  { id: 'coastal-haze', name: 'Coastal Haze' },
  { id: 'midnight-wash', name: 'Midnight Wash' },
];

export const EVENT_COVER_PRESET_IDS = [
  'warm-linen',
  'botanical-shadow',
  'pressed-paper',
  'candlelit-grain',
  'coastal-haze',
  'midnight-wash',
] as const satisfies readonly EventCoverPresetId[];

export const EVENT_COVER_EFFECTS = [
  'natural',
  'warm',
  'film',
  'soft',
  'monochrome',
] as const satisfies readonly EventCoverEffectId[];

export interface EventCoverProfile {
  id: EventCoverProfileId;
  width: number;
  height: number;
  /** Four ceilings per profile: one per density, per format. */
  webpByteCeiling: Record<EventCoverDensity, number>;
  jpegByteCeiling: Record<EventCoverDensity, number>;
}

const KIB = 1024;

/**
 * The registry, in layout order — the order the §10.2 table presents and the
 * order `CoverRenderWorkflow` steps through. Only `qualifiedCover2xProfiles`
 * sorts, and it sorts differently on purpose.
 */
export const EVENT_COVER_PROFILES: readonly EventCoverProfile[] = [
  {
    id: 'short-lookup',
    width: 360,
    height: 168,
    webpByteCeiling: { '1x': 60 * KIB, '2x': 120 * KIB },
    jpegByteCeiling: { '1x': 90 * KIB, '2x': 180 * KIB },
  },
  {
    id: 'compact-default',
    width: 390,
    height: 205,
    webpByteCeiling: { '1x': 70 * KIB, '2x': 140 * KIB },
    jpegByteCeiling: { '1x': 100 * KIB, '2x': 200 * KIB },
  },
  {
    id: 'standard-default',
    width: 620,
    height: 218,
    webpByteCeiling: { '1x': 120 * KIB, '2x': 250 * KIB },
    jpegByteCeiling: { '1x': 180 * KIB, '2x': 360 * KIB },
  },
  {
    id: 'framed-default',
    width: 620,
    height: 265,
    webpByteCeiling: { '1x': 140 * KIB, '2x': 300 * KIB },
    jpegByteCeiling: { '1x': 210 * KIB, '2x': 440 * KIB },
  },
  {
    id: 'compact-expanded',
    width: 390,
    height: 420,
    webpByteCeiling: { '1x': 130 * KIB, '2x': 280 * KIB },
    jpegByteCeiling: { '1x': 190 * KIB, '2x': 410 * KIB },
  },
  {
    id: 'wide-expanded',
    width: 620,
    height: 420,
    webpByteCeiling: { '1x': 220 * KIB, '2x': 480 * KIB },
    jpegByteCeiling: { '1x': 330 * KIB, '2x': 700 * KIB },
  },
];

const PROFILES_BY_ID = new Map<EventCoverProfileId, EventCoverProfile>(
  EVENT_COVER_PROFILES.map((profile) => [profile.id, profile]),
);

export function coverProfile(id: EventCoverProfileId): EventCoverProfile {
  return PROFILES_BY_ID.get(id)!;
}

/**
 * Spec gap: "sorted" with no stated sort key. Pinned to ASCII-lexical, the only
 * unambiguous reading, and deliberately different from the registry's layout
 * order so nobody can confuse the projection with the render sequence.
 */
const ASCII_LEXICAL_PROFILE_IDS: readonly EventCoverProfileId[] = EVENT_COVER_PROFILES
  .map((profile) => profile.id)
  .sort();

/** Five rungs. The first result satisfying codec, dimensions, and bytes wins. */
export const COVER_MASTER_LADDER: readonly { longEdge: number; area: number; quality: number }[] = [
  { longEdge: 4096, area: 16_000_000, quality: 88 },
  { longEdge: 4096, area: 16_000_000, quality: 84 },
  { longEdge: 3600, area: 12_000_000, quality: 84 },
  { longEdge: 3600, area: 12_000_000, quality: 80 },
  { longEdge: 3200, area: 10_000_000, quality: 80 },
];

/** Four rungs, uncropped, never upscaled. Used for natural and effect previews. */
export const COVER_PREVIEW_LADDER: readonly { longEdge: number; quality: number }[] = [
  { longEdge: 1280, quality: 82 },
  { longEdge: 1280, quality: 76 },
  { longEdge: 1120, quality: 76 },
  { longEdge: 960, quality: 72 },
];

export const COVER_OUTPUT_WEBP_QUALITIES: readonly [82, 78, 74, 70] = [82, 78, 74, 70];
export const COVER_OUTPUT_JPEG_QUALITIES: readonly [84, 80, 76, 72] = [84, 80, 76, 72];

export function coverOutputQualities(format: EventCoverFormat): readonly number[] {
  return format === 'webp' ? COVER_OUTPUT_WEBP_QUALITIES : COVER_OUTPUT_JPEG_QUALITIES;
}

export function coverByteCeiling(
  profile: EventCoverProfile,
  density: EventCoverDensity,
  format: EventCoverFormat,
): number {
  return format === 'webp' ? profile.webpByteCeiling[density] : profile.jpegByteCeiling[density];
}

/* ------------------------------------------------------------------ *
 * Profile resolution
 * ------------------------------------------------------------------ */

export interface CoverProfileInput {
  containerWidth: number;
  viewportWidth: number;
  viewportHeight: number;
  welcomeExpanded: boolean;
  lookup: boolean;
}

/**
 * The total priority-ordered mapping from §10.2.
 *
 * Written as an ordered cascade whose last arm is unconditional, so there is no
 * tuple of inputs this function fails to map. Request query strings and user
 * agents never reach it; only a measured container and viewport do.
 */
export function resolveCoverProfile(input: CoverProfileInput): EventCoverProfileId {
  if (input.lookup && input.containerWidth <= 360 && input.viewportHeight <= 600) {
    return 'short-lookup';
  }
  if (input.welcomeExpanded) {
    return input.containerWidth <= 390 ? 'compact-expanded' : 'wide-expanded';
  }
  if (input.viewportWidth >= 700 && input.viewportHeight >= 760) {
    return 'framed-default';
  }
  return input.containerWidth <= 390 ? 'compact-default' : 'standard-default';
}

/* ------------------------------------------------------------------ *
 * Deterministic geometry
 * ------------------------------------------------------------------ */

export interface CoverPixelSize {
  width: number;
  height: number;
}

export interface CoverFocusPoint {
  x: number;
  y: number;
  zoom: number;
}

export interface CoverTrimRectangle {
  left: number;
  top: number;
  width: number;
  height: number;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/**
 * The source window a zoom selects, clamped inside the master.
 *
 * For zoom `z` the window is `width / z` by `height / z` around the focal point.
 * An edge subject clamps rather than reading outside the image, so the trim is
 * always a real rectangle of the master and every profile crops the same one.
 */
export function coverTrimRectangle(master: CoverPixelSize, focus: CoverFocusPoint): CoverTrimRectangle {
  const zoom = clamp(focus.zoom, 1, MAX_COVER_MANUAL_ZOOM);
  const width = Math.max(1, Math.min(master.width, Math.floor(master.width / zoom)));
  const height = Math.max(1, Math.min(master.height, Math.floor(master.height / zoom)));
  return {
    left: clamp(Math.round(focus.x * master.width - width / 2), 0, master.width - width),
    top: clamp(Math.round(focus.y * master.height - height / 2), 0, master.height - height),
    width,
    height,
  };
}

/**
 * The largest rectangle of the profile's aspect that fits inside the trim, or
 * null when producing it would need upscaling.
 *
 * Producible is exactly `trim.width >= target.width && trim.height >=
 * target.height`: whichever edge governs the fit, the other is satisfied by the
 * shared aspect. Both sides multiply before dividing, so the exactly-fitting
 * 620x420 case cannot fall a ten-thousandth short and round the wrong way.
 */
export function coverProfileCrop(
  trim: CoverPixelSize,
  profile: EventCoverProfile,
  density: EventCoverDensity,
): CoverPixelSize | null {
  const scale = density === '2x' ? 2 : 1;
  const targetWidth = profile.width * scale;
  const targetHeight = profile.height * scale;
  if (trim.width < targetWidth || trim.height < targetHeight) return null;
  return trim.width * targetHeight >= trim.height * targetWidth
    ? { width: Math.floor((trim.height * targetWidth) / targetHeight), height: trim.height }
    : { width: trim.width, height: Math.floor((trim.width * targetHeight) / targetWidth) };
}

/**
 * The highest zoom this master may offer without invalidating a 1x profile.
 *
 * Increasing zoom shrinks the window in both dimensions, so the binding
 * constraint is the widest and tallest 1x target. Floored to the 5% step the
 * Compose range actually offers, and never above the absolute v1 ceiling.
 */
export function safeCoverZoomMaximum(master: CoverPixelSize): number {
  let bound = MAX_COVER_MANUAL_ZOOM;
  for (const profile of EVENT_COVER_PROFILES) {
    bound = Math.min(bound, master.width / profile.width, master.height / profile.height);
  }
  return clamp(Math.floor(bound * 20) / 20, 1, MAX_COVER_MANUAL_ZOOM);
}

/**
 * The 2x profiles this source and focus can produce without upscaling.
 *
 * A sorted allowlisted delivery capability, not client-authored geometry.
 * Every 1x profile stays producible for any master at or above 620x420, which
 * is why only the optional density is filtered here.
 */
export function qualifiedCover2xProfiles(
  master: CoverPixelSize,
  focus: CoverFocusPoint,
): readonly EventCoverProfileId[] {
  const trim = coverTrimRectangle(master, focus);
  return ASCII_LEXICAL_PROFILE_IDS.filter((id) => coverProfileCrop(trim, coverProfile(id), '2x') !== null);
}

/** All six, ASCII-lexical: a preset ships its complete matrix. */
export function allCover2xProfiles(): readonly EventCoverProfileId[] {
  return ASCII_LEXICAL_PROFILE_IDS;
}

export function resolvedCoverFocusPoint(
  focus: EventCoverFocusV1,
  automatic: { x: number; y: number } | null,
): CoverFocusPoint {
  if (focus.mode === 'manual') return { x: focus.x, y: focus.y, zoom: focus.zoom };
  return { x: automatic?.x ?? 0.5, y: automatic?.y ?? 0.5, zoom: 1 };
}

/* ------------------------------------------------------------------ *
 * Strict schemas
 * ------------------------------------------------------------------ */

// A client-generated opaque UUID. Zod has no `discriminatedUnion` precedent in
// this repository, and `EventCoverPublishRequestV1` discriminates on the nested
// key `source.kind`, which `z.discriminatedUnion` cannot address — so every
// envelope below is a `z.union` of fully strict object schemas.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const opaqueId = () => z.string().regex(UUID_PATTERN);
const revision = () => z.number().int().min(0);
const normalizedCoordinate = () => z.number().min(0).max(1);

const autoFocusSchema = z.strictObject({ mode: z.literal('auto') });
const manualFocusSchema = z.strictObject({
  mode: z.literal('manual'),
  x: normalizedCoordinate(),
  y: normalizedCoordinate(),
  zoom: z.number().min(1).max(MAX_COVER_MANUAL_ZOOM),
});
const focusSchema = z.union([autoFocusSchema, manualFocusSchema]);

const effectSchema = z.enum(EVENT_COVER_EFFECTS);
const presetIdSchema = z.enum(EVENT_COVER_PRESET_IDS);

export const eventCoverPublishSchema: z.ZodType<EventCoverPublishRequestV1> = z.union([
  z.strictObject({
    operationId: opaqueId(),
    expectedRevision: revision(),
    source: z.strictObject({ kind: z.literal('none') }),
  }),
  z.strictObject({
    operationId: opaqueId(),
    expectedRevision: revision(),
    source: z.strictObject({ kind: z.literal('preset'), presetId: presetIdSchema }),
    effect: effectSchema,
  }),
  z.strictObject({
    operationId: opaqueId(),
    expectedRevision: revision(),
    source: z.strictObject({ kind: z.literal('upload'), draftId: opaqueId() }),
    focus: focusSchema,
    effect: effectSchema,
  }),
]);

export const eventCoverDraftCreateSchema: z.ZodType<EventCoverDraftCreateRequestV1> = z.union([
  z.strictObject({
    draftIntentId: opaqueId(),
    source: z.strictObject({ kind: z.literal('new-upload') }),
    filename: z.string().min(1).max(255),
    mimeType: z.enum(COVER_UPLOAD_MIME_TYPES),
    byteSize: z.number().int().positive().max(MAX_COVER_UPLOAD_BYTES),
  }),
  z.strictObject({
    draftIntentId: opaqueId(),
    source: z.strictObject({ kind: z.literal('existing-upload') }),
    expectedCoverRevision: revision(),
  }),
]);

export const eventCoverCompositionSchema: z.ZodType<EventCoverCompositionRequestV1> = z.strictObject({
  expectedDraftRevision: revision(),
  // Pinned, not chosen: a client running an older composition worker must be
  // refused rather than have its coordinates silently reinterpreted.
  modelVersion: z.literal(COVER_PIPELINE_VERSIONS.compositionModel),
  x: normalizedCoordinate(),
  y: normalizedCoordinate(),
});

const storedCoverConfigSchema: z.ZodType<StoredEventCoverConfigV1> = z.union([
  z.strictObject({
    version: z.literal(1),
    source: z.strictObject({ kind: z.literal('none') }),
  }),
  z.strictObject({
    version: z.literal(1),
    source: z.strictObject({
      kind: z.literal('preset'),
      presetId: presetIdSchema,
      assetVersion: z.literal(1),
    }),
    effect: effectSchema,
  }),
  z.strictObject({
    version: z.literal(1),
    source: z.strictObject({ kind: z.literal('upload') }),
    focus: focusSchema,
    effect: effectSchema,
  }),
]);

/**
 * Reads a stored row, or refuses it.
 *
 * Null rather than a repaired default: silently reverting an unreadable cover
 * to `none` would take a host's published cover away without a `Done` and
 * without a revision increment, which is the one thing §2's sixth principle
 * forbids. The caller decides what an unreadable row means.
 */
export function parseStoredCoverConfig(value: unknown): StoredEventCoverConfigV1 | null {
  const parsed = storedCoverConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/* ------------------------------------------------------------------ *
 * Canonical serialization
 * ------------------------------------------------------------------ */

function canonicalFocus(focus: EventCoverFocusV1): Record<string, unknown> {
  return focus.mode === 'manual'
    ? { mode: 'manual', x: focus.x, y: focus.y, zoom: focus.zoom }
    : { mode: 'auto' };
}

/**
 * One byte-stable string per semantic config, whatever order the keys arrived
 * in. This is what a request digest is taken over, so two spellings of the same
 * intent must never produce two digests — a replay would otherwise look like a
 * collision and take a `409` no host action caused.
 */
export function canonicalCoverConfig(config: StoredEventCoverConfigV1): string {
  if (!('effect' in config)) {
    return JSON.stringify({ version: 1, source: { kind: 'none' } });
  }
  if ('focus' in config) {
    return JSON.stringify({
      version: 1,
      source: { kind: 'upload' },
      focus: canonicalFocus(config.focus),
      effect: config.effect,
    });
  }
  return JSON.stringify({
    version: 1,
    source: {
      kind: 'preset',
      presetId: config.source.presetId,
      assetVersion: config.source.assetVersion,
    },
    effect: config.effect,
  });
}

export function canonicalCoverRequest(request: EventCoverPublishRequestV1): string {
  const { operationId, expectedRevision } = request;
  if (!('effect' in request)) {
    return JSON.stringify({ operationId, expectedRevision, source: { kind: 'none' } });
  }
  if ('focus' in request) {
    return JSON.stringify({
      operationId,
      expectedRevision,
      source: { kind: 'upload', draftId: request.source.draftId },
      focus: canonicalFocus(request.focus),
      effect: request.effect,
    });
  }
  return JSON.stringify({
    operationId,
    expectedRevision,
    source: { kind: 'preset', presetId: request.source.presetId },
    effect: request.effect,
  });
}

// `source.kind` is a nested discriminant, which narrows `request.source` but
// not `request`; `in` narrows the outer union, so the branch fields resolve.
export function canonicalCoverDraftCreate(request: EventCoverDraftCreateRequestV1): string {
  return 'filename' in request
    ? JSON.stringify({
        draftIntentId: request.draftIntentId,
        source: { kind: 'new-upload' },
        filename: request.filename,
        mimeType: request.mimeType,
        byteSize: request.byteSize,
      })
    : JSON.stringify({
        draftIntentId: request.draftIntentId,
        source: { kind: 'existing-upload' },
        expectedCoverRevision: request.expectedCoverRevision,
      });
}

/* ------------------------------------------------------------------ *
 * Derived presentation
 * ------------------------------------------------------------------ */

/**
 * The runtime overlay a published effect resolves to.
 *
 * Server-resolved so a guest cannot invent a presentation value, and separate
 * from the effect itself because the grain is one versioned tileable asset
 * layered at runtime rather than baked into every rendered output.
 */
export function coverSurfaceTreatment(config: StoredEventCoverConfigV1): EventCoverSurfaceTreatmentId {
  if (!('effect' in config)) return 'none';
  return config.effect === 'film' ? 'film-grain-v1' : 'none';
}

export function coverHasSource(config: StoredEventCoverConfigV1): boolean {
  return config.source.kind !== 'none';
}

/* ------------------------------------------------------------------ *
 * Deterministic contrast compositor
 * ------------------------------------------------------------------ */

/**
 * The runtime layer stack over a cover, as arithmetic.
 *
 * `ResponsiveEventCover` and `.photo-drop__hero--cover` compose the same four
 * layers in the same order — image, grain, theme overlay, text scrim — and put
 * white copy on top. Because none of them is ever baked into a rendered
 * derivative, the legibility of a cover is a property of these numbers rather
 * than of any file, and it can be proven without rendering anything.
 *
 * Everything here composites in sRGB, not linear light: CSS `background` alpha
 * compositing is defined that way, so linearizing first would model a browser
 * that does not exist. Relative luminance is the WCAG definition and is applied
 * only at the end, to the composited channels.
 */

export interface CoverRgb {
  r: number;
  g: number;
  b: number;
}

export interface CoverRgba extends CoverRgb {
  /** 0 through 1. */
  a: number;
}

/** Accepts `#rrggbb` and the `rgb(R G B / P%)` form the theme tokens use. */
export function parseCoverLayerColor(value: string): CoverRgba {
  const hex = /^#([0-9a-f]{6})$/iu.exec(value.trim());
  if (hex) {
    const packed = Number.parseInt(hex[1]!, 16);
    return { r: (packed >> 16) & 0xff, g: (packed >> 8) & 0xff, b: packed & 0xff, a: 1 };
  }
  const parts = value.match(/[\d.]+/gu);
  if (!parts || parts.length < 3) throw new Error(`Unreadable layer color: ${value}`);
  const [r, g, b, alpha] = parts.map(Number) as [number, number, number, number?];
  return {
    r: r!,
    g: g!,
    b: b!,
    // `rgb(R G B / 62%)` carries a percentage; a bare fourth value is already 0-1.
    a: alpha === undefined ? 1 : (value.includes('%') ? alpha / 100 : alpha),
  };
}

/** One `source-over` composite in sRGB. */
export function coverSourceOver(base: CoverRgb, layer: CoverRgba): CoverRgb {
  return {
    r: layer.r * layer.a + base.r * (1 - layer.a),
    g: layer.g * layer.a + base.g * (1 - layer.a),
    b: layer.b * layer.a + base.b * (1 - layer.a),
  };
}

function linearChannel(channel: number): number {
  const ratio = channel / 255;
  return ratio <= 0.04045 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
}

export function coverRelativeLuminance(color: CoverRgb): number {
  return 0.2126 * linearChannel(color.r)
    + 0.7152 * linearChannel(color.g)
    + 0.0722 * linearChannel(color.b);
}

export function coverContrastRatio(first: CoverRgb, second: CoverRgb): number {
  const a = coverRelativeLuminance(first);
  const b = coverRelativeLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * Where the scrimmed copy box starts, as a fraction of the frame height.
 *
 * The guest hero justifies its content to the flex end, so the copy box always
 * sits against the bottom. This band is a deliberate over-approximation of it:
 * a taller band can only admit *brighter* pixels and a lower overlay alpha, so
 * every figure derived from it is a lower bound on the real contrast.
 */
export const COVER_COPY_BAND_TOP = 0.4;

/** The `film-grain-v1` tile's maximum texel alpha, before its layer opacity. */
export const COVER_GRAIN_TEXEL_ALPHA = 96 / 255;
export const COVER_GRAIN_LAYER_OPACITY = 0.18;

export interface CoverContrastInput {
  /** The worst-case source pixel for this region, straight out of the output. */
  source: CoverRgb;
  /** True only for `film`, whose surface treatment is the grain tile. */
  grain: boolean;
  overlayTop: string;
  overlayBottom: string;
  /** Null models a region with no scrim behind it. */
  scrim: string | null;
  foreground: string;
  /** 0 at the top of the frame, 1 at the bottom. */
  position: number;
}

/**
 * The contrast the copy actually gets over a cover, given its worst pixel.
 *
 * The grain is modelled at its lightest texel rather than its average, because
 * white copy is hardest to read over the brightest thing beneath it. That is
 * also why a black texel is never the worst case here and why the proof only
 * has to bound one direction — a premise the accompanying test checks rather
 * than assumes, by asserting every theme's cover foreground is white.
 */
export function coverTextContrast(input: CoverContrastInput): number {
  let composited: CoverRgb = input.source;

  if (input.grain) {
    composited = coverSourceOver(composited, {
      r: 255,
      g: 255,
      b: 255,
      a: COVER_GRAIN_TEXEL_ALPHA * COVER_GRAIN_LAYER_OPACITY,
    });
  }

  // A CSS gradient between two stops of the same colour is that colour with a
  // linearly interpolated alpha, so the overlay reduces to one composite.
  const top = parseCoverLayerColor(input.overlayTop);
  const bottom = parseCoverLayerColor(input.overlayBottom);
  composited = coverSourceOver(composited, {
    r: top.r,
    g: top.g,
    b: top.b,
    a: top.a + (bottom.a - top.a) * Math.min(1, Math.max(0, input.position)),
  });

  if (input.scrim) composited = coverSourceOver(composited, parseCoverLayerColor(input.scrim));

  const foreground = parseCoverLayerColor(input.foreground);
  return coverContrastRatio(composited, foreground);
}

import { describe, expect, it } from 'vitest';

import {
  COVER_CLEANUP_ROWS_PER_CLASS,
  COVER_PAPER_MATTE,
  COVER_UPLOAD_MIME_TYPES,
  MAX_COVER_BACKFILL_CREATE_BATCH,
  MAX_COVER_BACKFILL_CREATIONS_PER_MINUTE,
  MAX_COVER_BACKFILL_IN_FLIGHT,
  MAX_COVER_BACKFILL_PAGE_SIZE,
  MAX_COVER_INSPECTIONS_PER_HOUR,
  MAX_COVER_MANUAL_ZOOM,
  MAX_COVER_MASTER_BYTES,
  MAX_COVER_PREVIEWS_PER_HOUR,
  MAX_COVER_PREVIEW_BYTES,
  MAX_COVER_PREVIEW_BYTES_PER_DRAFT,
  MAX_COVER_PREVIEW_FILES_PER_DRAFT,
  MAX_COVER_PUBLICATIONS_PER_HOUR,
  MAX_COVER_PURGE_FENCES_PER_PASS,
  MAX_COVER_PURGE_PLATFORM_MUTATIONS_PER_PASS,
  MAX_COVER_RESERVATIONS_PER_HOUR,
  MAX_COVER_UPLOAD_BYTES,
  MAX_IMAGE_BYTES,
  MAX_LIVE_COVER_DRAFTS_PER_EVENT,
  MAX_LIVE_COVER_RAW_BYTES_PER_EVENT,
  MAX_NONACTIVE_COVER_RENDER_SETS_PER_EVENT,
  MAX_PREPARING_COVER_PUBLICATIONS_PER_EVENT,
  MAX_RETAINED_COVER_RECEIPTS_PER_EVENT,
  MIN_COVER_SOURCE_HEIGHT,
  MIN_COVER_SOURCE_WIDTH,
  SUPPORTED_IMAGE_TYPES,
} from '../../shared/constants';
import {
  COVER_MASTER_LADDER,
  COVER_OUTPUT_JPEG_QUALITIES,
  COVER_OUTPUT_WEBP_QUALITIES,
  COVER_PIPELINE_VERSIONS,
  COVER_PREVIEW_LADDER,
  EVENT_COVER_EFFECTS,
  EVENT_COVER_PRESETS,
  EVENT_COVER_PROFILES,
  canonicalCoverConfig,
  canonicalCoverRequest,
  coverProfileCrop,
  coverSurfaceTreatment,
  coverTrimRectangle,
  eventCoverCompositionSchema,
  eventCoverDraftCreateSchema,
  eventCoverPublishSchema,
  parseStoredCoverConfig,
  qualifiedCover2xProfiles,
  resolveCoverProfile,
  safeCoverZoomMaximum,
} from '../../shared/event-cover';
import type { EventCoverProfileId, StoredEventCoverConfigV1 } from '../../shared/event-cover';
import { EVENT_THEME_PRESET_IDS } from '../../shared/event-theme';
import { classifyApiErrorCode } from '../../shared/load-failure';

const KiB = 1024;
const OPERATION_ID = '5f3a2b18-6c2d-4f0e-9a71-0c2d1e8b4a55';
const DRAFT_ID = 'b2b0a2d0-8d1e-4d0a-8f1a-9a7c3e5b1d22';
const INTENT_ID = 'c9f4d1a2-3e5b-4c7d-8a90-1b2c3d4e5f60';

function publishBody(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operationId: OPERATION_ID,
    expectedRevision: 0,
    source: { kind: 'upload', draftId: DRAFT_ID },
    focus: { mode: 'auto' },
    effect: 'natural',
    ...patch,
  };
}

describe('cover constants', () => {
  it('pins every limit as the exact decimal the pipeline was sized for', () => {
    expect(MAX_COVER_UPLOAD_BYTES).toBe(19_000_000);
    expect(MAX_COVER_MASTER_BYTES).toBe(9_000_000);
    expect(MIN_COVER_SOURCE_WIDTH).toBe(620);
    expect(MIN_COVER_SOURCE_HEIGHT).toBe(420);
    expect(MAX_COVER_MANUAL_ZOOM).toBe(2.0);
    expect(COVER_PAPER_MATTE).toBe('#fffaf3');
    expect(MAX_LIVE_COVER_DRAFTS_PER_EVENT).toBe(3);
    expect(MAX_LIVE_COVER_RAW_BYTES_PER_EVENT).toBe(57_000_000);
    expect(MAX_COVER_PREVIEW_FILES_PER_DRAFT).toBe(5);
    expect(MAX_COVER_PREVIEW_BYTES).toBe(660_000);
    expect(MAX_COVER_PREVIEW_BYTES_PER_DRAFT).toBe(3_300_000);
    expect(MAX_PREPARING_COVER_PUBLICATIONS_PER_EVENT).toBe(1);
    expect(MAX_NONACTIVE_COVER_RENDER_SETS_PER_EVENT).toBe(32);
    expect(MAX_RETAINED_COVER_RECEIPTS_PER_EVENT).toBe(1_024);
    expect(MAX_COVER_RESERVATIONS_PER_HOUR).toBe(12);
    expect(MAX_COVER_INSPECTIONS_PER_HOUR).toBe(12);
    expect(MAX_COVER_PREVIEWS_PER_HOUR).toBe(30);
    expect(MAX_COVER_PUBLICATIONS_PER_HOUR).toBe(6);
    expect(MAX_COVER_BACKFILL_PAGE_SIZE).toBe(100);
    expect(MAX_COVER_BACKFILL_CREATE_BATCH).toBe(25);
    expect(MAX_COVER_BACKFILL_IN_FLIGHT).toBe(25);
    expect(MAX_COVER_BACKFILL_CREATIONS_PER_MINUTE).toBe(25);
    expect(MAX_COVER_PURGE_FENCES_PER_PASS).toBe(10);
    expect(MAX_COVER_PURGE_PLATFORM_MUTATIONS_PER_PASS).toBe(5);
    expect(COVER_CLEANUP_ROWS_PER_CLASS).toBe(100);
  });

  // The whole reason `MAX_COVER_UPLOAD_BYTES` exists: the binary guest-media
  // ceiling is 20,971,520, which exceeds the Images binding's 20 MB `.input()`
  // limit and would fail at the transform rather than at reservation.
  it('never reuses the binary guest-media ceiling for a cover', () => {
    expect(MAX_IMAGE_BYTES).toBe(20_971_520);
    expect(MAX_COVER_UPLOAD_BYTES).toBeLessThan(MAX_IMAGE_BYTES);
    expect(MAX_COVER_MASTER_BYTES).toBeLessThan(MAX_COVER_UPLOAD_BYTES);
  });

  it('accepts exactly JPEG, PNG, WebP, and HEIC as an independent tuple', () => {
    expect([...COVER_UPLOAD_MIME_TYPES]).toEqual([
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/heic',
    ]);
    for (const rejected of ['image/heif', 'image/heic-sequence', 'image/heif-sequence']) {
      expect(COVER_UPLOAD_MIME_TYPES as readonly string[]).not.toContain(rejected);
      // Still a legal guest-media type: the two lists are independent, so a
      // future guest format cannot widen cover intake by inheritance.
      expect(SUPPORTED_IMAGE_TYPES as readonly string[]).toContain(rejected);
    }
  });
});

describe('cover registries', () => {
  it('offers exactly six presets, independent of the four event themes', () => {
    expect(EVENT_COVER_PRESETS).toHaveLength(6);
    expect(EVENT_COVER_PRESETS.map((preset) => preset.id)).toEqual([
      'warm-linen',
      'botanical-shadow',
      'pressed-paper',
      'candlelit-grain',
      'coastal-haze',
      'midnight-wash',
    ]);
    expect(EVENT_COVER_PRESETS.map((preset) => preset.name)).toEqual([
      'Warm Linen',
      'Botanical Shadow',
      'Pressed Paper',
      'Candlelit Grain',
      'Coastal Haze',
      'Midnight Wash',
    ]);
    // Six global choices, not six per theme.
    expect(EVENT_THEME_PRESET_IDS).toHaveLength(4);
    for (const themeId of EVENT_THEME_PRESET_IDS) {
      expect(EVENT_COVER_PRESETS.map((preset) => preset.id) as readonly string[]).not.toContain(themeId);
    }
  });

  it('offers exactly five effects', () => {
    expect([...EVENT_COVER_EFFECTS]).toEqual(['natural', 'warm', 'film', 'soft', 'monochrome']);
  });

  it('keeps the profile registry in layout order with four byte ceilings each', () => {
    expect(EVENT_COVER_PROFILES.map((profile) => profile.id)).toEqual([
      'short-lookup',
      'compact-default',
      'standard-default',
      'framed-default',
      'compact-expanded',
      'wide-expanded',
    ]);

    const byId = new Map(EVENT_COVER_PROFILES.map((profile) => [profile.id, profile]));
    const expected: Record<EventCoverProfileId, [number, number, number, number, number, number]> = {
      // width, height, webp 1x, webp 2x, jpeg 1x, jpeg 2x
      'short-lookup': [360, 168, 60, 120, 90, 180],
      'compact-default': [390, 205, 70, 140, 100, 200],
      'standard-default': [620, 218, 78, 250, 120, 360],
      'framed-default': [620, 265, 140, 300, 210, 440],
      'compact-expanded': [390, 420, 130, 280, 190, 410],
      'wide-expanded': [620, 420, 220, 480, 330, 700],
    };

    for (const [id, [width, height, webp1x, webp2x, jpeg1x, jpeg2x]] of Object.entries(expected)) {
      const profile = byId.get(id as EventCoverProfileId)!;
      expect(profile.width).toBe(width);
      expect(profile.height).toBe(height);
      expect(profile.webpByteCeiling['1x']).toBe(webp1x * KiB);
      expect(profile.webpByteCeiling['2x']).toBe(webp2x * KiB);
      expect(profile.jpegByteCeiling['1x']).toBe(jpeg1x * KiB);
      expect(profile.jpegByteCeiling['2x']).toBe(jpeg2x * KiB);
    }
  });

  it('pins every version axis at 1', () => {
    expect(COVER_PIPELINE_VERSIONS).toEqual({
      compositionModel: 1,
      inspectionRecipe: 1,
      previewRecipe: 1,
      normalizationLadder: 1,
      imagesParameterRecipe: 1,
      matte: 1,
      metadataPolicy: 1,
      cropProfileRegistry: 1,
      tonalEffect: 1,
      sharpening: 1,
      outputQualityLadder: 1,
      presetAsset: 1,
    });
    expect(Object.values(COVER_PIPELINE_VERSIONS).every((value) => value === 1)).toBe(true);
  });

  it('pins the master, preview, and output ladders in order', () => {
    expect([...COVER_MASTER_LADDER]).toEqual([
      { longEdge: 4096, area: 16_000_000, quality: 88 },
      { longEdge: 4096, area: 16_000_000, quality: 84 },
      { longEdge: 3600, area: 12_000_000, quality: 84 },
      { longEdge: 3600, area: 12_000_000, quality: 80 },
      { longEdge: 3200, area: 10_000_000, quality: 80 },
    ]);
    expect([...COVER_PREVIEW_LADDER]).toEqual([
      { longEdge: 1280, quality: 82 },
      { longEdge: 1280, quality: 76 },
      { longEdge: 1120, quality: 76 },
      { longEdge: 960, quality: 72 },
    ]);
    expect([...COVER_OUTPUT_WEBP_QUALITIES]).toEqual([82, 78, 74, 70]);
    expect([...COVER_OUTPUT_JPEG_QUALITIES]).toEqual([84, 80, 76, 72]);
  });
});

describe('resolveCoverProfile', () => {
  const base = {
    containerWidth: 390,
    viewportWidth: 390,
    viewportHeight: 844,
    welcomeExpanded: false,
    lookup: false,
  };

  it('resolves the short lookup hero only inside both of its bounds', () => {
    expect(resolveCoverProfile({ ...base, lookup: true, containerWidth: 360, viewportWidth: 360, viewportHeight: 600 }))
      .toBe('short-lookup');
    expect(resolveCoverProfile({ ...base, lookup: true, containerWidth: 360, viewportWidth: 360, viewportHeight: 599 }))
      .toBe('short-lookup');
    // 361 leaves the container bound; 601 leaves the height bound. Both fall
    // through to the ordinary non-expanded cascade, which is still ≤390 here.
    expect(resolveCoverProfile({ ...base, lookup: true, containerWidth: 361, viewportWidth: 361, viewportHeight: 600 }))
      .toBe('compact-default');
    expect(resolveCoverProfile({ ...base, lookup: true, containerWidth: 391, viewportWidth: 391, viewportHeight: 600 }))
      .toBe('standard-default');
    expect(resolveCoverProfile({ ...base, lookup: true, containerWidth: 360, viewportWidth: 360, viewportHeight: 601 }))
      .toBe('compact-default');
    // Lookup is required: the same geometry without it is an ordinary hero.
    expect(resolveCoverProfile({ ...base, lookup: false, containerWidth: 360, viewportWidth: 360, viewportHeight: 600 }))
      .toBe('compact-default');
  });

  it('splits the expanded welcome at 390/391 and ignores the framed branch', () => {
    expect(resolveCoverProfile({ ...base, welcomeExpanded: true, containerWidth: 390 })).toBe('compact-expanded');
    expect(resolveCoverProfile({ ...base, welcomeExpanded: true, containerWidth: 391 })).toBe('wide-expanded');
    // An expanded welcome outranks the framed-desktop branch entirely.
    expect(resolveCoverProfile({
      ...base, welcomeExpanded: true, containerWidth: 620, viewportWidth: 1280, viewportHeight: 900,
    })).toBe('wide-expanded');
    // Expanded plus lookup still never reaches short-lookup above 360.
    expect(resolveCoverProfile({
      ...base, welcomeExpanded: true, lookup: true, containerWidth: 390, viewportHeight: 600,
    })).toBe('compact-expanded');
  });

  it('splits the framed desktop hero at 699/700 wide and 759/760 high', () => {
    const framed = { ...base, containerWidth: 620 };
    expect(resolveCoverProfile({ ...framed, viewportWidth: 700, viewportHeight: 760 })).toBe('framed-default');
    expect(resolveCoverProfile({ ...framed, viewportWidth: 699, viewportHeight: 760 })).toBe('standard-default');
    expect(resolveCoverProfile({ ...framed, viewportWidth: 700, viewportHeight: 759 })).toBe('standard-default');
    // The framed branch outranks the ≤390 container branch.
    expect(resolveCoverProfile({
      ...base, containerWidth: 390, viewportWidth: 700, viewportHeight: 760,
    })).toBe('framed-default');
  });

  it('splits the unframed default hero at 390/391', () => {
    expect(resolveCoverProfile({ ...base, containerWidth: 390 })).toBe('compact-default');
    expect(resolveCoverProfile({ ...base, containerWidth: 391, viewportWidth: 391 })).toBe('standard-default');
    expect(resolveCoverProfile({ ...base, containerWidth: 620, viewportWidth: 699, viewportHeight: 900 }))
      .toBe('standard-default');
  });

  it('maps every tuple in the boundary grid to an allowlisted profile', () => {
    const ids = new Set<string>(EVENT_COVER_PROFILES.map((profile) => profile.id));
    for (const containerWidth of [320, 360, 361, 390, 391, 620, 699, 700]) {
      for (const viewportWidth of [320, 360, 361, 390, 391, 699, 700, 1280]) {
        for (const viewportHeight of [180, 420, 599, 600, 601, 759, 760, 844]) {
          for (const welcomeExpanded of [false, true]) {
            for (const lookup of [false, true]) {
              const resolved = resolveCoverProfile({
                containerWidth, viewportWidth, viewportHeight, welcomeExpanded, lookup,
              });
              expect(ids.has(resolved)).toBe(true);
            }
          }
        }
      }
    }
  });
});

describe('cover geometry', () => {
  it('computes a zoomed trim window that stays inside the master', () => {
    expect(coverTrimRectangle({ width: 2000, height: 1000 }, { x: 0.5, y: 0.5, zoom: 1 }))
      .toEqual({ left: 0, top: 0, width: 2000, height: 1000 });
    expect(coverTrimRectangle({ width: 2000, height: 1000 }, { x: 0.5, y: 0.5, zoom: 2 }))
      .toEqual({ left: 500, top: 250, width: 1000, height: 500 });
    // An edge subject clamps rather than reading outside the master.
    expect(coverTrimRectangle({ width: 2000, height: 1000 }, { x: 0, y: 0, zoom: 2 }))
      .toEqual({ left: 0, top: 0, width: 1000, height: 500 });
    expect(coverTrimRectangle({ width: 2000, height: 1000 }, { x: 1, y: 1, zoom: 2 }))
      .toEqual({ left: 1000, top: 500, width: 1000, height: 500 });
  });

  it('produces a profile crop only when it needs no upscaling', () => {
    const wide = EVENT_COVER_PROFILES.find((profile) => profile.id === 'wide-expanded')!;
    expect(coverProfileCrop({ width: 620, height: 420 }, wide, '1x')).toEqual({ width: 620, height: 420 });
    expect(coverProfileCrop({ width: 620, height: 420 }, wide, '2x')).toBeNull();
    expect(coverProfileCrop({ width: 1240, height: 840 }, wide, '2x')).toEqual({ width: 1240, height: 840 });
    // A panoramic trim is limited by its short edge, not by its area.
    expect(coverProfileCrop({ width: 4000, height: 419 }, wide, '1x')).toBeNull();
    const lookup = EVENT_COVER_PROFILES.find((profile) => profile.id === 'short-lookup')!;
    expect(coverProfileCrop({ width: 4000, height: 419 }, lookup, '1x')).toEqual({ width: 897, height: 419 });
  });

  it('keeps every 1x profile producible for any master at or above the 620x420 floor', () => {
    for (const master of [
      { width: 620, height: 420 },
      { width: 621, height: 421 },
      { width: 4000, height: 500 },
      { width: 700, height: 3000 },
      { width: 4096, height: 2731 },
    ]) {
      const trim = coverTrimRectangle(master, { x: 0.5, y: 0.5, zoom: 1 });
      for (const profile of EVENT_COVER_PROFILES) {
        expect(coverProfileCrop(trim, profile, '1x')).not.toBeNull();
      }
    }
  });

  it('caps the safe zoom at 2.0 and never lets it invalidate a 1x profile', () => {
    expect(safeCoverZoomMaximum({ width: 620, height: 420 })).toBe(1);
    expect(safeCoverZoomMaximum({ width: 1240, height: 840 })).toBe(2);
    expect(safeCoverZoomMaximum({ width: 6000, height: 4000 })).toBe(MAX_COVER_MANUAL_ZOOM);
    // Short edge governs: 840/420 = 2 but 900/620 = 1.45, floored to the 5% step.
    expect(safeCoverZoomMaximum({ width: 900, height: 840 })).toBe(1.45);

    for (const master of [
      { width: 620, height: 420 },
      { width: 900, height: 840 },
      { width: 1240, height: 840 },
      { width: 3000, height: 2000 },
    ]) {
      const zoom = safeCoverZoomMaximum(master);
      expect(zoom).toBeGreaterThanOrEqual(1);
      expect(zoom).toBeLessThanOrEqual(MAX_COVER_MANUAL_ZOOM);
      const trim = coverTrimRectangle(master, { x: 0.5, y: 0.5, zoom });
      for (const profile of EVENT_COVER_PROFILES) {
        expect(coverProfileCrop(trim, profile, '1x')).not.toBeNull();
      }
    }
  });

  it('advertises 2x profiles in ASCII-lexical order and only when producible', () => {
    const centre = { x: 0.5, y: 0.5, zoom: 1 };
    expect(qualifiedCover2xProfiles({ width: 620, height: 420 }, centre)).toEqual([]);
    expect(qualifiedCover2xProfiles({ width: 1240, height: 840 }, centre)).toEqual([
      'compact-default',
      'compact-expanded',
      'framed-default',
      'short-lookup',
      'standard-default',
      'wide-expanded',
    ]);
    // 1240x600 clears every 2x width but not the 840-pixel expanded heights.
    expect(qualifiedCover2xProfiles({ width: 1240, height: 600 }, centre)).toEqual([
      'compact-default',
      'framed-default',
      'short-lookup',
      'standard-default',
    ]);
    // Manual zoom shrinks the window and can remove 2x profiles it once had.
    expect(qualifiedCover2xProfiles({ width: 1240, height: 840 }, { x: 0.5, y: 0.5, zoom: 2 })).toEqual([]);
  });
});

describe('canonical cover serialization', () => {
  it('is stable under key reordering', () => {
    const a = { version: 1, source: { kind: 'upload' }, focus: { mode: 'auto' }, effect: 'film' };
    const b = { effect: 'film', focus: { mode: 'auto' }, source: { kind: 'upload' }, version: 1 };
    expect(canonicalCoverConfig(parseStoredCoverConfig(a)!)).toBe(canonicalCoverConfig(parseStoredCoverConfig(b)!));

    const manual = {
      version: 1,
      source: { kind: 'upload' },
      focus: { mode: 'manual', zoom: 1.5, y: 0.25, x: 0.75 },
      effect: 'warm',
    };
    expect(canonicalCoverConfig(parseStoredCoverConfig(manual)!))
      .toBe('{"version":1,"source":{"kind":"upload"},"focus":{"mode":"manual","x":0.75,"y":0.25,"zoom":1.5},"effect":"warm"}');
  });

  it('serializes the canonical none config exactly as the column default', () => {
    expect(canonicalCoverConfig({ version: 1, source: { kind: 'none' } }))
      .toBe('{"version":1,"source":{"kind":"none"}}');
  });

  it('is stable for a publish request under key reordering', () => {
    const first = eventCoverPublishSchema.parse(publishBody());
    const second = eventCoverPublishSchema.parse({
      effect: 'natural',
      focus: { mode: 'auto' },
      source: { draftId: DRAFT_ID, kind: 'upload' },
      expectedRevision: 0,
      operationId: OPERATION_ID,
    });
    expect(canonicalCoverRequest(first)).toBe(canonicalCoverRequest(second));
  });

  it('resolves the surface treatment from the published effect only', () => {
    expect(coverSurfaceTreatment({ version: 1, source: { kind: 'none' } })).toBe('none');
    expect(coverSurfaceTreatment({
      version: 1, source: { kind: 'upload' }, focus: { mode: 'auto' }, effect: 'film',
    })).toBe('film-grain-v1');
    expect(coverSurfaceTreatment({
      version: 1, source: { kind: 'preset', presetId: 'warm-linen', assetVersion: 1 }, effect: 'film',
    })).toBe('film-grain-v1');
    for (const effect of ['natural', 'warm', 'soft', 'monochrome'] as const) {
      expect(coverSurfaceTreatment({
        version: 1, source: { kind: 'upload' }, focus: { mode: 'auto' }, effect,
      })).toBe('none');
    }
  });
});

describe('parseStoredCoverConfig', () => {
  it('accepts the three canonical shapes', () => {
    const none: StoredEventCoverConfigV1 = { version: 1, source: { kind: 'none' } };
    expect(parseStoredCoverConfig(none)).toEqual(none);
    expect(parseStoredCoverConfig({
      version: 1, source: { kind: 'preset', presetId: 'coastal-haze', assetVersion: 1 }, effect: 'soft',
    })).toEqual({
      version: 1, source: { kind: 'preset', presetId: 'coastal-haze', assetVersion: 1 }, effect: 'soft',
    });
    expect(parseStoredCoverConfig({
      version: 1,
      source: { kind: 'upload' },
      focus: { mode: 'manual', x: 0.25, y: 0.75, zoom: 1.25 },
      effect: 'monochrome',
    })).not.toBeNull();
  });

  it('returns null rather than repairing an unreadable row', () => {
    for (const invalid of [
      null,
      'string',
      { version: 2, source: { kind: 'none' } },
      { version: 1, source: { kind: 'none' }, effect: 'natural' },
      { version: 1, source: { kind: 'upload' }, focus: { mode: 'auto' } },
      { version: 1, source: { kind: 'preset', presetId: 'warm-linen', assetVersion: 2 }, effect: 'natural' },
      { version: 1, source: { kind: 'upload', objectKey: 'events/e/cover/x' }, focus: { mode: 'auto' }, effect: 'natural' },
    ]) {
      expect(parseStoredCoverConfig(invalid)).toBeNull();
    }
  });
});

describe('strict cover request schemas', () => {
  it('accepts the three publish branches', () => {
    expect(eventCoverPublishSchema.safeParse({
      operationId: OPERATION_ID, expectedRevision: 3, source: { kind: 'none' },
    }).success).toBe(true);
    expect(eventCoverPublishSchema.safeParse({
      operationId: OPERATION_ID,
      expectedRevision: 0,
      source: { kind: 'preset', presetId: 'pressed-paper' },
      effect: 'film',
    }).success).toBe(true);
    expect(eventCoverPublishSchema.safeParse(publishBody({
      focus: { mode: 'manual', x: 0, y: 1, zoom: 2 },
    })).success).toBe(true);
  });

  it('rejects unknown keys at every nesting level', () => {
    expect(eventCoverPublishSchema.safeParse(publishBody({ coverObjectKey: 'events/e/cover/x' })).success).toBe(false);
    expect(eventCoverPublishSchema.safeParse(publishBody({
      source: { kind: 'upload', draftId: DRAFT_ID, objectKey: 'events/e/cover/x' },
    })).success).toBe(false);
    expect(eventCoverPublishSchema.safeParse(publishBody({
      focus: { mode: 'auto', zoom: 1.5 },
    })).success).toBe(false);
    expect(eventCoverPublishSchema.safeParse({
      operationId: OPERATION_ID, expectedRevision: 0, source: { kind: 'none' }, effect: 'natural',
    }).success).toBe(false);
  });

  it('rejects arbitrary preset, effect, and source names', () => {
    expect(eventCoverPublishSchema.safeParse({
      operationId: OPERATION_ID,
      expectedRevision: 0,
      source: { kind: 'preset', presetId: 'garden-party' },
      effect: 'natural',
    }).success).toBe(false);
    expect(eventCoverPublishSchema.safeParse(publishBody({ effect: 'vivid' })).success).toBe(false);
    expect(eventCoverPublishSchema.safeParse(publishBody({
      source: { kind: 'legacy', draftId: DRAFT_ID },
    })).success).toBe(false);
  });

  it('rejects out-of-range focus and zoom', () => {
    for (const focus of [
      { mode: 'manual', x: -0.01, y: 0.5, zoom: 1 },
      { mode: 'manual', x: 1.01, y: 0.5, zoom: 1 },
      { mode: 'manual', x: 0.5, y: -0.01, zoom: 1 },
      { mode: 'manual', x: 0.5, y: 1.01, zoom: 1 },
      { mode: 'manual', x: 0.5, y: 0.5, zoom: 0.99 },
      { mode: 'manual', x: 0.5, y: 0.5, zoom: 2.01 },
      { mode: 'manual', x: Number.NaN, y: 0.5, zoom: 1 },
      { mode: 'manual', x: Number.POSITIVE_INFINITY, y: 0.5, zoom: 1 },
    ]) {
      expect(eventCoverPublishSchema.safeParse(publishBody({ focus })).success).toBe(false);
    }
  });

  it('rejects URLs, CSS, and transform parameters anywhere in the envelope', () => {
    for (const patch of [
      { url: 'https://example.invalid/cover.jpg' },
      { css: 'background-image:url(x)' },
      { width: 1240 },
      { quality: 82 },
      { gravity: { x: 0.5, y: 0.5 } },
      { operationId: 'https://example.invalid/x' },
      { expectedRevision: -1 },
      { expectedRevision: 1.5 },
    ]) {
      expect(eventCoverPublishSchema.safeParse(publishBody(patch)).success).toBe(false);
    }
  });

  it('accepts only the two draft-create branches', () => {
    expect(eventCoverDraftCreateSchema.safeParse({
      draftIntentId: INTENT_ID,
      source: { kind: 'new-upload' },
      filename: 'porch.heic',
      mimeType: 'image/heic',
      byteSize: MAX_COVER_UPLOAD_BYTES,
    }).success).toBe(true);
    expect(eventCoverDraftCreateSchema.safeParse({
      draftIntentId: INTENT_ID, source: { kind: 'existing-upload' }, expectedCoverRevision: 4,
    }).success).toBe(true);

    // The four-member MIME guard, and the sequence types it must refuse.
    for (const mimeType of ['image/heif', 'image/heic-sequence', 'image/heif-sequence', 'image/gif']) {
      expect(eventCoverDraftCreateSchema.safeParse({
        draftIntentId: INTENT_ID,
        source: { kind: 'new-upload' },
        filename: 'porch.img',
        mimeType,
        byteSize: 1_000,
      }).success).toBe(false);
    }
    for (const byteSize of [0, -1, 1.5, MAX_COVER_UPLOAD_BYTES + 1]) {
      expect(eventCoverDraftCreateSchema.safeParse({
        draftIntentId: INTENT_ID,
        source: { kind: 'new-upload' },
        filename: 'porch.jpg',
        mimeType: 'image/jpeg',
        byteSize,
      }).success).toBe(false);
    }
    // Neither branch accepts a key, and neither accepts the other's fields.
    expect(eventCoverDraftCreateSchema.safeParse({
      draftIntentId: INTENT_ID, source: { kind: 'new-upload' }, filename: 'a.jpg',
      mimeType: 'image/jpeg', byteSize: 10, objectKey: 'events/e/cover/raw/x',
    }).success).toBe(false);
    expect(eventCoverDraftCreateSchema.safeParse({
      draftIntentId: INTENT_ID, source: { kind: 'existing-upload' }, expectedCoverRevision: 4,
      filename: 'a.jpg',
    }).success).toBe(false);
  });

  it('requires a pinned model version and bounded coordinates for a composition', () => {
    expect(eventCoverCompositionSchema.safeParse({
      expectedDraftRevision: 1, modelVersion: COVER_PIPELINE_VERSIONS.compositionModel, x: 0.5, y: 0.5,
    }).success).toBe(true);
    for (const invalid of [
      { expectedDraftRevision: 1, modelVersion: 2, x: 0.5, y: 0.5 },
      { expectedDraftRevision: 1, modelVersion: 1, x: 1.5, y: 0.5 },
      { expectedDraftRevision: 1, modelVersion: 1, x: 0.5, y: -0.5 },
      { expectedDraftRevision: -1, modelVersion: 1, x: 0.5, y: 0.5 },
      { expectedDraftRevision: 1, modelVersion: 1, x: 0.5, y: 0.5, confidence: 0.9 },
      { expectedDraftRevision: 1, modelVersion: 1, x: 0.5, y: 0.5, zoom: 1.5 },
    ]) {
      expect(eventCoverCompositionSchema.safeParse(invalid).success).toBe(false);
    }
  });
});

// The union itself is a pure type with no runtime members to count. This is the
// runtime half of the proof that all ten codes were added: `load-failure`'s
// exhaustive `satisfies` is the compile-time half.
describe('cover error-code classification', () => {
  it('classifies every cover code as retry, because none is reachable from a guest load', () => {
    for (const code of [
      'COVER_SOURCE_UNSUPPORTED',
      'COVER_SOURCE_TOO_SMALL',
      'COVER_MASTER_BUDGET_EXHAUSTED',
      'COVER_PREVIEW_BUDGET_EXHAUSTED',
      'COVER_OUTPUT_BUDGET_EXHAUSTED',
      'COVER_DRAFT_LIMIT',
      'COVER_RAW_STORAGE_LIMIT',
      'COVER_DRAFT_STATE_CONFLICT',
      'COVER_PUBLICATION_CONFLICT',
      'COVER_RENDER_UNAVAILABLE',
    ] as const) {
      expect(classifyApiErrorCode(code)).toBe('retry');
    }
  });
});

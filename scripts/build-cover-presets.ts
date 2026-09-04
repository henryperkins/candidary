import { realpathSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { presetCoverAssetPath } from '../shared/event-cover-assets.ts';

/**
 * Generates the complete bounded preset matrix: six art-directed masters, five
 * tonal effects, six layout profiles, two densities, two formats — 720 versioned
 * static files — plus the one version-matched Film grain tile they share.
 *
 * Three things about this file are deliberate.
 *
 * **It restates the registry instead of importing `shared/event-cover.ts`.**
 * Node's type stripping cannot resolve that module: it imports `./constants`
 * without an extension, which is legal under `moduleResolution: Bundler` and
 * unresolvable at runtime. Rather than weaken the shared compiler configuration
 * for a build script, the tables are restated here and `tests/unit/cover-presets.test.ts`
 * asserts — against the shared registry itself, and against the emitted manifest —
 * that the two agree. A drift is a failing test, not a silently wrong asset.
 *
 * **The browser half is injected as source.** `tsconfig.scripts.json` includes
 * no DOM lib, on purpose. The rendering runs in headless Chromium, so its code
 * is carried as a string and evaluated there; the Node half only ever sees the
 * JSON that comes back. This extends `scripts/generate-app-icons.mjs`, which
 * already rasterizes a checked-in SVG through the same browser.
 *
 * **The effects are the runtime recipes, not new ones.** The calibrated table in
 * `worker/storage/event-cover-effects.ts` is what an uploaded cover is rendered
 * with; the canvas filters below are that table expressed in the one vocabulary
 * a browser has. `natural` carries no sharpening because the source is vector
 * art downscaled by the browser's own resampler, and there is nothing an
 * unsharp mask would recover.
 */

/* ------------------------------------------------------------------ *
 * The restated registry
 * ------------------------------------------------------------------ */

export const PRESET_ASSET_VERSION = 2;

export const COVER_PRESET_IDS = [
  'warm-linen',
  'botanical-shadow',
  'pressed-paper',
  'candlelit-grain',
  'coastal-haze',
  'midnight-wash',
] as const;
export type CoverPresetId = (typeof COVER_PRESET_IDS)[number];

export const COVER_EFFECT_IDS = [
  'natural',
  'warm',
  'film',
  'soft',
  'monochrome',
] as const;
export type CoverEffectId = (typeof COVER_EFFECT_IDS)[number];

export const COVER_DENSITIES = ['1x', '2x'] as const;
export type CoverDensity = (typeof COVER_DENSITIES)[number];

export const COVER_FORMATS = ['webp', 'jpeg'] as const;
export type CoverFormat = (typeof COVER_FORMATS)[number];

export type CoverProfileId =
  | 'short-lookup'
  | 'compact-default'
  | 'standard-default'
  | 'framed-default'
  | 'compact-expanded'
  | 'wide-expanded';

const KIB = 1024;

export interface CoverPresetProfile {
  id: CoverProfileId;
  width: number;
  height: number;
  webpByteCeiling: Record<CoverDensity, number>;
  jpegByteCeiling: Record<CoverDensity, number>;
}

/** Layout order, matching the shared registry and the Workflow's step order. */
export const COVER_PRESET_PROFILES: readonly CoverPresetProfile[] = [
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
    webpByteCeiling: { '1x': 78 * KIB, '2x': 250 * KIB },
    jpegByteCeiling: { '1x': 120 * KIB, '2x': 360 * KIB },
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

export const COVER_OUTPUT_QUALITIES: Record<CoverFormat, readonly number[]> = {
  webp: [82, 78, 74, 70],
  jpeg: [84, 80, 76, 72],
};

export const COVER_OUTPUT_MIME: Record<CoverFormat, string> = {
  webp: 'image/webp',
  jpeg: 'image/jpeg',
};

/** The fixed server-owned paper matte. Never follows an event theme. */
export const COVER_PAPER_MATTE = '#fffaf3';

/**
 * `EFFECT_RECIPES` from the rendering service, in the vocabulary a canvas has.
 *
 * Images' `gamma` above 1 lifts exposure, which `brightness` is the browser's
 * name for; `saturation` and `contrast` map directly. `sharpen` has no canvas
 * equivalent and is omitted rather than approximated.
 */
export const COVER_EFFECT_CANVAS_FILTERS: Record<CoverEffectId, string> = {
  natural: 'none',
  warm: 'saturate(1.04) contrast(0.99)',
  film: 'contrast(0.95) saturate(0.8)',
  soft: 'saturate(0.96) contrast(0.92)',
  monochrome: 'grayscale(1) contrast(1.02)',
};

export const COVER_WARM_WASH = {
  color: '#e7b78d',
  opacity: 0.05,
  composite: 'source-over',
} as const;

/**
 * Every master is authored at this size, and every profile takes a centred crop
 * of it. The tallest profile (390x420 at 2x) needs 1486x1600 of a 2400x1600
 * master and the widest (360x168 at 2x) needs 2400x1120, so a centred
 * composition produces all twelve slots without upscaling — which is what lets
 * a preset advertise every 2x profile while an upload has to qualify for them.
 */
export const COVER_PRESET_MASTER = { width: 2400, height: 1600 } as const;
export const COVER_PRESET_COMPOSITION = 'center';

export const COVER_SURFACE_TREATMENT_ID = 'film-grain-v2';
export const COVER_GRAIN_TILE = {
  width: 128,
  height: 128,
  seed: 0x9e3779b9,
  /** The tile's maximum texel alpha. `COVER_GRAIN_TEXEL_ALPHA` is this over 255. */
  maxAlpha: 96,
} as const;

/**
 * Where the scrimmed copy band starts, as a fraction of frame height.
 *
 * Restated from `COVER_COPY_BAND_TOP` in `shared/event-cover.ts` for the same
 * reason as the rest of this file's registry, and pinned against it by
 * `tests/unit/cover-contrast.test.ts`. Measuring a band the compositor does not
 * believe in would produce contrast figures about nothing.
 */
export const COVER_COPY_BAND_TOP = 0.4;

export const COVER_PRESET_MANIFEST_KIND = 'candidary-cover-preset-manifest';

/* ------------------------------------------------------------------ *
 * Paths and slots
 * ------------------------------------------------------------------ */

export function presetGrainTilePath(assetVersion: number): string {
  return `/assets/event-covers/v${assetVersion}/film-grain-v${assetVersion}.png`;
}

export function presetManifestPath(assetVersion: number): string {
  return `/assets/event-covers/v${assetVersion}/manifest.json`;
}

export interface CoverPresetSlot {
  path: string;
  presetId: CoverPresetId;
  effect: CoverEffectId;
  profile: CoverProfileId;
  density: CoverDensity;
  format: CoverFormat;
  width: number;
  height: number;
  byteCeiling: number;
}

/**
 * The complete cross-product, in a fixed order: preset, then effect, then
 * profile in layout order, then density, then format. The manifest is written
 * in this order so two builds of the same art produce the same file.
 */
export function coverPresetSlots(): CoverPresetSlot[] {
  const slots: CoverPresetSlot[] = [];
  for (const presetId of COVER_PRESET_IDS) {
    for (const effect of COVER_EFFECT_IDS) {
      for (const profile of COVER_PRESET_PROFILES) {
        for (const density of COVER_DENSITIES) {
          const scale = density === '2x' ? 2 : 1;
          for (const format of COVER_FORMATS) {
            slots.push({
              path: presetCoverAssetPath(PRESET_ASSET_VERSION, presetId, effect, profile.id, density, format),
              presetId,
              effect,
              profile: profile.id,
              density,
              format,
              width: profile.width * scale,
              height: profile.height * scale,
              byteCeiling: format === 'webp'
                ? profile.webpByteCeiling[density]
                : profile.jpegByteCeiling[density],
            });
          }
        }
      }
    }
  }
  return slots;
}

export interface CoverCropRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The largest centred rectangle of the target's aspect inside the master.
 *
 * Integer-floored so the region is a real pixel rectangle, and both sides
 * multiply before dividing so an exactly-matching aspect cannot fall a
 * ten-thousandth short and round a pixel off the frame.
 */
export function centerCropRegion(
  master: { width: number; height: number },
  target: { width: number; height: number },
): CoverCropRegion {
  const wide = master.width * target.height >= master.height * target.width;
  const width = wide
    ? Math.floor((master.height * target.width) / target.height)
    : master.width;
  const height = wide
    ? master.height
    : Math.floor((master.width * target.height) / target.width);
  return {
    left: Math.floor((master.width - width) / 2),
    top: Math.floor((master.height - height) / 2),
    width,
    height,
  };
}

/* ------------------------------------------------------------------ *
 * Manifest
 * ------------------------------------------------------------------ */

export interface CoverPresetManifestFile {
  path: string;
  presetId: CoverPresetId;
  effect: CoverEffectId;
  profile: string;
  density: CoverDensity;
  format: CoverFormat;
  width: number;
  height: number;
  byteSize: number;
  /** 1-4, the winning rung of the format's output quality ladder. */
  rung: number;
  sha256: string;
}

export interface CoverPresetManifestTreatment {
  id: string;
  path: string;
  width: number;
  height: number;
  byteSize: number;
  sha256: string;
}

export interface CoverSamplePixel {
  r: number;
  g: number;
  b: number;
  luminance: number;
}

/**
 * The worst pixel each rendered profile offers white copy.
 *
 * One row per preset, effect, and profile — 180 of them — measured off the toned
 * canvas at 1x. The runtime layers are identical at 2x, so a second density
 * would restate the same figure at a different resolution.
 */
export interface CoverPresetRegionSample {
  presetId: CoverPresetId;
  effect: CoverEffectId;
  profile: string;
  /** Brightest pixel inside the scrimmed copy band. */
  copy: CoverSamplePixel;
  /** Brightest pixel anywhere in the frame. */
  frame: CoverSamplePixel;
}

export interface CoverPresetManifest {
  kind: typeof COVER_PRESET_MANIFEST_KIND;
  assetVersion: number;
  composition: string;
  master: { width: number; height: number };
  versions: {
    cropProfileRegistry: number;
    tonalEffect: number;
    outputQualityLadder: number;
    presetAsset: number;
  };
  copyBandTop: number;
  surfaceTreatment: CoverPresetManifestTreatment;
  files: CoverPresetManifestFile[];
  regions: CoverPresetRegionSample[];
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The WCAG relative luminance of an sRGB pixel.
 *
 * Restated here so the verifier can re-derive a recorded sample's luminance from
 * its own channels without reaching into `shared/`, which it cannot load. The
 * unit test pins it against `coverRelativeLuminance`.
 */
export function relativeLuminance(pixel: { r: number; g: number; b: number }): number {
  const channel = (value: number) => {
    const ratio = value / 255;
    return ratio <= 0.04045 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(pixel.r) + 0.7152 * channel(pixel.g) + 0.0722 * channel(pixel.b);
}

/* ------------------------------------------------------------------ *
 * The browser half
 * ------------------------------------------------------------------ */

/**
 * Injected into the page as source, because this project has no DOM lib.
 *
 * `prepare` rasterizes the master once and derives one base canvas per
 * profile/density by progressive halving, so the twelve resamples happen once
 * per preset rather than once per preset and effect. `encode` then draws a base
 * one-to-one under a canvas filter — a pure per-pixel colour transform, which is
 * exactly what a tonal recipe is — and walks the quality ladder, accepting the
 * first encode inside the slot's byte ceiling.
 */
const BROWSER_RENDERER_SOURCE = String.raw`
window.__candidaryCoverPresets = (function () {
  var bases = new Map();
  var matte = ${JSON.stringify(COVER_PAPER_MATTE)};

  function canvasOf(width, height) {
    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    var context = canvas.getContext('2d', { alpha: false, willReadFrequently: false });
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    return { canvas: canvas, context: context };
  }

  function prepare(request) {
    bases.clear();
    var image = document.getElementById('master');
    var master = canvasOf(request.master.width, request.master.height);
    master.context.fillStyle = matte;
    master.context.fillRect(0, 0, request.master.width, request.master.height);
    master.context.drawImage(image, 0, 0, request.master.width, request.master.height);

    for (var index = 0; index < request.bases.length; index += 1) {
      var spec = request.bases[index];
      var region = spec.region;
      var current = canvasOf(region.width, region.height);
      current.context.drawImage(
        master.canvas,
        region.left, region.top, region.width, region.height,
        0, 0, region.width, region.height,
      );
      var currentWidth = region.width;
      var currentHeight = region.height;
      while (currentWidth > spec.width * 2 && currentHeight > spec.height * 2) {
        var nextWidth = Math.max(spec.width, Math.round(currentWidth / 2));
        var nextHeight = Math.max(spec.height, Math.round(currentHeight / 2));
        var next = canvasOf(nextWidth, nextHeight);
        next.context.drawImage(current.canvas, 0, 0, currentWidth, currentHeight, 0, 0, nextWidth, nextHeight);
        current = next;
        currentWidth = nextWidth;
        currentHeight = nextHeight;
      }
      var base = canvasOf(spec.width, spec.height);
      base.context.drawImage(current.canvas, 0, 0, currentWidth, currentHeight, 0, 0, spec.width, spec.height);
      bases.set(spec.key, base.canvas);
    }
    return bases.size;
  }

  function linearChannel(channel) {
    var ratio = channel / 255;
    return ratio <= 0.04045 ? ratio / 12.92 : Math.pow((ratio + 0.055) / 1.055, 2.4);
  }

  function relativeLuminance(red, green, blue) {
    return 0.2126 * linearChannel(red) + 0.7152 * linearChannel(green) + 0.0722 * linearChannel(blue);
  }

  /**
   * The brightest pixel of the whole frame and of the scrimmed copy band.
   *
   * Brightest rather than average, because white copy is hardest to read over
   * the lightest thing beneath it — so this is the only pixel the contrast proof
   * needs from each region.
   */
  function worstPixels(context, width, height, bandTop) {
    var pixels = context.getImageData(0, 0, width, height).data;
    var bandStart = Math.floor(height * bandTop);
    var frame = null;
    var copy = null;
    for (var y = 0; y < height; y += 1) {
      for (var x = 0; x < width; x += 1) {
        var offset = (y * width + x) * 4;
        var red = pixels[offset];
        var green = pixels[offset + 1];
        var blue = pixels[offset + 2];
        var luminance = relativeLuminance(red, green, blue);
        if (!frame || luminance > frame.luminance) {
          frame = { r: red, g: green, b: blue, luminance: luminance };
        }
        if (y >= bandStart && (!copy || luminance > copy.luminance)) {
          copy = { r: red, g: green, b: blue, luminance: luminance };
        }
      }
    }
    return { frame: frame, copy: copy || frame };
  }

  function encode(request) {
    var results = [];
    for (var index = 0; index < request.slots.length; index += 1) {
      var slot = request.slots[index];
      var source = bases.get(slot.key);
      var toned = canvasOf(slot.width, slot.height);
      toned.context.fillStyle = matte;
      toned.context.fillRect(0, 0, slot.width, slot.height);
      toned.context.filter = request.filter;
      toned.context.drawImage(source, 0, 0);
      toned.context.filter = 'none';
      if (request.warmWash) {
        toned.context.globalCompositeOperation = request.warmWash.composite;
        toned.context.globalAlpha = request.warmWash.opacity;
        toned.context.fillStyle = request.warmWash.color;
        toned.context.fillRect(0, 0, slot.width, slot.height);
        toned.context.globalAlpha = 1;
        toned.context.globalCompositeOperation = 'source-over';
      }

      var chosen = null;
      for (var rung = 0; rung < slot.qualities.length; rung += 1) {
        var url = toned.canvas.toDataURL(slot.mime, slot.qualities[rung] / 100);
        var base64 = url.slice(url.indexOf(',') + 1);
        var byteSize = Math.floor(base64.length / 4) * 3
          - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
        if (byteSize > slot.byteCeiling) continue;
        chosen = { path: slot.path, rung: rung + 1, base64: base64 };
        break;
      }
      if (!chosen) {
        throw new Error('Output quality ladder exhausted for ' + slot.path + '.');
      }
      // Measured once per profile, off the toned canvas rather than a decoded
      // file: this is the exact surface the runtime layers composite over.
      if (slot.sample) {
        var worst = worstPixels(toned.context, slot.width, slot.height, request.bandTop);
        chosen.sample = { profile: slot.profile, copy: worst.copy, frame: worst.frame };
      }
      results.push(chosen);
    }
    return results;
  }

  function grain(request) {
    var canvas = document.createElement('canvas');
    canvas.width = request.width;
    canvas.height = request.height;
    var context = canvas.getContext('2d');
    var image = context.createImageData(request.width, request.height);
    // mulberry32, so a rebuild reproduces the tile byte for byte.
    var state = request.seed >>> 0;
    for (var pixel = 0; pixel < image.data.length; pixel += 4) {
      state = (state + 0x6d2b79f5) >>> 0;
      var t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      var value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      var signed = (value - 0.5) * 2;
      var level = signed < 0 ? 0 : 255;
      image.data[pixel] = level;
      image.data[pixel + 1] = level;
      image.data[pixel + 2] = level;
      image.data[pixel + 3] = Math.round(Math.abs(signed) * request.alpha);
    }
    context.putImageData(image, 0, 0);
    var url = canvas.toDataURL('image/png');
    return url.slice(url.indexOf(',') + 1);
  }

  return { prepare: prepare, encode: encode, grain: grain };
})();
`;

/* ------------------------------------------------------------------ *
 * Build
 * ------------------------------------------------------------------ */

interface EncodedSlot {
  path: string;
  rung: number;
  base64: string;
  sample?: { profile: string; copy: CoverSamplePixel; frame: CoverSamplePixel };
}

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function baseKey(profile: string, density: CoverDensity): string {
  return `${profile}-${density}`;
}

export interface BuildCoverPresetsResult {
  manifest: CoverPresetManifest;
  totalBytes: number;
}

export async function buildCoverPresets(options: {
  projectRoot?: string;
  log?: (message: string) => void;
} = {}): Promise<BuildCoverPresetsResult> {
  const projectRoot = options.projectRoot ?? PROJECT_ROOT;
  const log = options.log ?? ((message: string) => { console.log(message); });
  const outputRoot = resolve(projectRoot, 'public/assets/event-covers', `v${PRESET_ASSET_VERSION}`);

  // Playwright is loaded here rather than at module scope so importing this
  // module for its tables — which the unit test does — costs nothing.
  const { chromium } = await import('@playwright/test');

  const slots = coverPresetSlots();
  const bases = COVER_PRESET_PROFILES.flatMap((profile) => COVER_DENSITIES.map((density) => {
    const scale = density === '2x' ? 2 : 1;
    const width = profile.width * scale;
    const height = profile.height * scale;
    return {
      key: baseKey(profile.id, density),
      width,
      height,
      region: centerCropRegion(COVER_PRESET_MASTER, { width, height }),
    };
  }));

  await rm(outputRoot, { recursive: true, force: true });

  const files: CoverPresetManifestFile[] = [];
  const regions: CoverPresetRegionSample[] = [];
  let totalBytes = 0;
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: 64, height: 64 } });
    const page = await context.newPage();

    for (const presetId of COVER_PRESET_IDS) {
      const source = await readFile(resolve(projectRoot, 'design/cover-presets', `${presetId}.svg`), 'utf8');
      const sourceUrl = `data:image/svg+xml;base64,${Buffer.from(source).toString('base64')}`;
      await page.setContent(`<!doctype html><html><head><style>html,body{margin:0;background:${COVER_PAPER_MATTE};}`
        + `img{position:absolute;left:-10000px;width:${COVER_PRESET_MASTER.width}px;height:${COVER_PRESET_MASTER.height}px;}`
        + `</style></head><body><img id="master" alt="" src="${sourceUrl}" /></body></html>`);
      await page.addScriptTag({ content: BROWSER_RENDERER_SOURCE });
      await page.locator('#master').evaluate((image) => (image as unknown as { decode(): Promise<void> }).decode());
      await page.evaluate<number>(
        `window.__candidaryCoverPresets.prepare(${JSON.stringify({ master: COVER_PRESET_MASTER, bases })})`,
      );

      for (const effect of COVER_EFFECT_IDS) {
        const request = {
          filter: COVER_EFFECT_CANVAS_FILTERS[effect],
          warmWash: effect === 'warm' ? COVER_WARM_WASH : null,
          bandTop: COVER_COPY_BAND_TOP,
          slots: slots
            .filter((slot) => slot.presetId === presetId && slot.effect === effect)
            .map((slot) => ({
              key: baseKey(slot.profile, slot.density),
              path: slot.path,
              profile: slot.profile,
              width: slot.width,
              height: slot.height,
              mime: COVER_OUTPUT_MIME[slot.format],
              qualities: COVER_OUTPUT_QUALITIES[slot.format],
              byteCeiling: slot.byteCeiling,
              // One measurement per profile, off the 1x canvas the WebP slot
              // tones first. Every other slot of that profile is the same
              // surface at another resolution or in another codec.
              sample: slot.density === '1x' && slot.format === 'webp',
            })),
        };
        const encoded = await page.evaluate<EncodedSlot[]>(
          `window.__candidaryCoverPresets.encode(${JSON.stringify(request)})`,
        );

        for (const result of encoded) {
          const slot = slots.find((candidate) => candidate.path === result.path)!;
          if (result.sample) {
            regions.push({
              presetId,
              effect,
              profile: result.sample.profile,
              copy: result.sample.copy,
              frame: result.sample.frame,
            });
          }
          const bytes = Buffer.from(result.base64, 'base64');
          if (bytes.byteLength > slot.byteCeiling) {
            throw new Error(`${slot.path} is ${bytes.byteLength} bytes, above its ${slot.byteCeiling}-byte ceiling.`);
          }
          const filePath = resolve(projectRoot, `public${slot.path}`);
          await mkdir(dirname(filePath), { recursive: true });
          await writeFile(filePath, bytes);
          totalBytes += bytes.byteLength;
          files.push({
            path: slot.path,
            presetId: slot.presetId,
            effect: slot.effect,
            profile: slot.profile,
            density: slot.density,
            format: slot.format,
            width: slot.width,
            height: slot.height,
            byteSize: bytes.byteLength,
            rung: result.rung,
            sha256: sha256Hex(bytes),
          });
        }
      }
      log(`Rendered ${presetId}: ${files.length} of ${slots.length} files.`);
    }

    const grainBase64 = await page.evaluate<string>(
      `window.__candidaryCoverPresets.grain(${JSON.stringify({
        width: COVER_GRAIN_TILE.width,
        height: COVER_GRAIN_TILE.height,
        seed: COVER_GRAIN_TILE.seed,
        alpha: 96,
      })})`,
    );
    const grainBytes = Buffer.from(grainBase64, 'base64');
    const grainPath = resolve(projectRoot, `public${presetGrainTilePath(PRESET_ASSET_VERSION)}`);
    await mkdir(dirname(grainPath), { recursive: true });
    await writeFile(grainPath, grainBytes);
    totalBytes += grainBytes.byteLength;

    const manifest: CoverPresetManifest = {
      kind: COVER_PRESET_MANIFEST_KIND,
      assetVersion: PRESET_ASSET_VERSION,
      composition: COVER_PRESET_COMPOSITION,
      master: { width: COVER_PRESET_MASTER.width, height: COVER_PRESET_MASTER.height },
      versions: {
        cropProfileRegistry: 1,
        tonalEffect: 2,
        outputQualityLadder: 1,
        presetAsset: PRESET_ASSET_VERSION,
      },
      copyBandTop: COVER_COPY_BAND_TOP,
      surfaceTreatment: {
        id: COVER_SURFACE_TREATMENT_ID,
        path: presetGrainTilePath(PRESET_ASSET_VERSION),
        width: COVER_GRAIN_TILE.width,
        height: COVER_GRAIN_TILE.height,
        byteSize: grainBytes.byteLength,
        sha256: sha256Hex(grainBytes),
      },
      files,
      regions,
    };
    await writeFile(
      resolve(projectRoot, `public${presetManifestPath(PRESET_ASSET_VERSION)}`),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    log(`Wrote ${files.length} preset files and the ${COVER_SURFACE_TREATMENT_ID} tile `
      + `(${(totalBytes / 1_000_000).toFixed(1)} MB) to ${outputRoot}.`);
    return { manifest, totalBytes };
  } finally {
    await browser.close();
  }
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  try {
    await buildCoverPresets();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Cover preset generation failed.');
    process.exitCode = 1;
  }
}

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  COVER_COPY_BAND_TOP,
  COVER_GRAIN_LAYER_OPACITY,
  COVER_GRAIN_LAYER_OPACITY_V1,
  COVER_GRAIN_TEXEL_ALPHA,
  type CoverRgb,
  coverContrastRatio,
  coverRelativeLuminance,
  coverSourceOver,
  coverTextContrast,
  parseCoverLayerColor,
} from '../../shared/event-cover';
import { EVENT_THEME_PRESETS } from '../../shared/event-theme';
import {
  COVER_COPY_BAND_TOP as SCRIPT_COPY_BAND_TOP,
  COVER_EFFECT_IDS,
  COVER_GRAIN_TILE,
  COVER_PRESET_IDS,
  COVER_PRESET_PROFILES,
  PRESET_ASSET_VERSION,
  presetManifestPath,
  relativeLuminance as scriptRelativeLuminance,
} from '../../scripts/build-cover-presets';
import type { CoverPresetManifest } from '../../scripts/build-cover-presets';

/**
 * The contrast evidence for every cover Candidary can show.
 *
 * Axe is not used for this and cannot be: it reads declared colours, and a cover
 * is a photograph under three translucent layers. Nor are 720 screenshots — that
 * would be slow, flaky, and would still only cover the presets. Instead the
 * layer stack is arithmetic (`coverTextContrast`), the worst pixel of each
 * rendered profile is measured once at build time into the manifest, and this
 * suite runs the arithmetic exhaustively over both.
 *
 * Two claims are made here, and they are different in kind. The first is
 * empirical: all 6 x 5 x 4 x 6 = 720 preset/effect/theme/profile contexts clear
 * WCAG AA. The second is a proof: *any* image a host could upload clears it too,
 * because the composite is monotonic in the source channels and the all-white
 * source is therefore the worst one that exists.
 */

const AA_NORMAL_TEXT = 4.5;

const manifest = JSON.parse(
  readFileSync(resolve(process.cwd(), `public${presetManifestPath(PRESET_ASSET_VERSION)}`), 'utf8'),
) as CoverPresetManifest;

const themes = EVENT_THEME_PRESETS;
const WHITE: CoverRgb = { r: 255, g: 255, b: 255 };
const BLACK: CoverRgb = { r: 0, g: 0, b: 0 };

/** A deterministic lattice, dense enough to catch a non-monotonic composite. */
const LATTICE = [0, 37, 96, 151, 203, 255];

function contrastFor(options: {
  source: CoverRgb;
  effect: string;
  theme: (typeof themes)[number];
  scrimmed: boolean;
  position?: number;
}): number {
  return coverTextContrast({
    source: options.source,
    grain: options.effect === 'film',
    overlayTop: options.theme.tokens.coverOverlayTop,
    overlayBottom: options.theme.tokens.coverOverlayBottom,
    scrim: options.scrimmed ? options.theme.tokens.coverTextScrim : null,
    foreground: options.theme.tokens.fullscreenForeground,
    // The top of the copy band is where the overlay is thinnest, so it is the
    // worst position inside the region the copy actually occupies.
    position: options.position ?? COVER_COPY_BAND_TOP,
  });
}

describe('the compositor models the layers the runtime actually paints', () => {
  it('reads both token forms the theme contract uses', () => {
    expect(parseCoverLayerColor('#ffffff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseCoverLayerColor('rgb(31 15 9 / 62%)')).toEqual({ r: 31, g: 15, b: 9, a: 0.62 });
  });

  it('composites source-over in sRGB', () => {
    expect(coverSourceOver(WHITE, { ...BLACK, a: 0 })).toEqual(WHITE);
    expect(coverSourceOver(WHITE, { ...BLACK, a: 1 })).toEqual(BLACK);
    expect(coverSourceOver(WHITE, { ...BLACK, a: 0.5 })).toEqual({ r: 127.5, g: 127.5, b: 127.5 });
  });

  it('agrees with WCAG at both ends of the range', () => {
    expect(coverContrastRatio(WHITE, WHITE)).toBeCloseTo(1, 10);
    expect(coverContrastRatio(WHITE, BLACK)).toBeCloseTo(21, 10);
  });

  it('is the same luminance function the build script records with', () => {
    for (const red of LATTICE) {
      for (const green of LATTICE) {
        const pixel = { r: red, g: green, b: (red + green) % 256 };
        expect(scriptRelativeLuminance(pixel)).toBeCloseTo(coverRelativeLuminance(pixel), 12);
      }
    }
  });

  it('measures the band the compositor reasons about', () => {
    expect(SCRIPT_COPY_BAND_TOP).toBe(COVER_COPY_BAND_TOP);
    expect(manifest.copyBandTop).toBe(COVER_COPY_BAND_TOP);
    expect(COVER_GRAIN_TILE.maxAlpha / 255).toBeCloseTo(COVER_GRAIN_TEXEL_ALPHA, 12);
  });
});

describe('every theme puts white copy on its covers', () => {
  /**
   * The premise the whole proof rests on, checked rather than assumed.
   *
   * White copy is hardest to read over the *brightest* background, which is why
   * only the maximum-luminance pixel is measured and why the all-white source is
   * the worst case. A theme that used dark cover copy would invert that and make
   * every figure below meaningless.
   */
  it.each(themes.map((theme) => [theme.id, theme] as const))('%s', (_id, theme) => {
    expect(theme.tokens.fullscreenForeground).toBe('#ffffff');
    expect(parseCoverLayerColor(theme.tokens.coverTextScrim).a).toBeGreaterThan(0.5);
    // The overlay only ever darkens, so it can never work against white copy.
    const overlay = parseCoverLayerColor(theme.tokens.coverOverlayBottom);
    expect(coverRelativeLuminance(overlay)).toBeLessThan(0.05);
  });
});

describe('all 720 preset, effect, theme, and profile contexts clear WCAG AA', () => {
  it('measured one region per preset, effect, and profile', () => {
    expect(manifest.regions).toHaveLength(
      COVER_PRESET_IDS.length * COVER_EFFECT_IDS.length * COVER_PRESET_PROFILES.length,
    );
    expect(manifest.regions).toHaveLength(180);
  });

  it('composites every context and finds none below 4.5:1', () => {
    const failures: string[] = [];
    let worst = { context: '', ratio: Number.POSITIVE_INFINITY };
    let contexts = 0;

    for (const region of manifest.regions) {
      for (const theme of themes) {
        contexts += 1;
        const ratio = contrastFor({
          source: region.copy,
          effect: region.effect,
          theme,
          scrimmed: true,
        });
        const context = `${region.presetId}/${region.effect}/${theme.id}/${region.profile}`;
        if (ratio < worst.ratio) worst = { context, ratio };
        if (ratio < AA_NORMAL_TEXT) failures.push(`${context} at ${ratio.toFixed(2)}:1`);
      }
    }

    expect(contexts).toBe(720);
    expect(failures).toEqual([]);
    expect(worst.ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it('shows the scrim is load-bearing rather than decorative', () => {
    // The same contexts without the scrim: at least one must fail, or the scrim
    // is not doing the work this design says it does and the whole layer could
    // be deleted without anyone noticing.
    const unscrimmed = manifest.regions.flatMap((region) => themes.map((theme) => contrastFor({
      source: region.frame,
      effect: region.effect,
      theme,
      scrimmed: false,
      position: 0,
    })));
    expect(Math.min(...unscrimmed)).toBeLessThan(AA_NORMAL_TEXT);
  });
});

describe('the fixed scrim protects an arbitrary uploaded photo', () => {
  /**
   * Monotonicity is the whole proof.
   *
   * `coverSourceOver` is `layer * a + base * (1 - a)` with `a` in [0, 1], so it
   * is non-decreasing in every source channel; WCAG relative luminance is
   * non-decreasing in every channel; and white-text contrast is decreasing in
   * luminance. Composing those three gives: contrast is minimized by the
   * brightest possible source. Checking it on a lattice is what turns that
   * argument into something a future edit cannot quietly break.
   */
  it('never composites a brighter source to a darker result', () => {
    for (const red of LATTICE) {
      for (const green of LATTICE) {
        for (const blue of LATTICE) {
          const base = { r: red, g: green, b: blue };
          for (const channel of ['r', 'g', 'b'] as const) {
            if (base[channel] === 255) continue;
            const brighter = { ...base, [channel]: base[channel] + 1 };
            for (const theme of themes) {
              const from = contrastFor({ source: base, effect: 'film', theme, scrimmed: true });
              const to = contrastFor({ source: brighter, effect: 'film', theme, scrimmed: true });
              expect(to).toBeLessThanOrEqual(from + 1e-12);
            }
          }
        }
      }
    }
  });

  it('clears 4.5:1 for a pure white source under the lightest grain texel', () => {
    for (const theme of themes) {
      // White is the supremum of every uploaded image, and the lightest grain
      // texel composited over white is still white — so this single figure
      // bounds every photo, every effect, and every texel at once.
      const ratio = contrastFor({ source: WHITE, effect: 'film', theme, scrimmed: true });
      expect(ratio, `${theme.id} worst possible cover`).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      expect(contrastFor({ source: WHITE, effect: 'natural', theme, scrimmed: true }))
        .toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    }
  });

  it('keeps the darkest grain texel on the safe side of that bound', () => {
    // A black texel can only lower the composite, and lower luminance can only
    // raise white-text contrast — so grain never has to be bounded downward.
    for (const theme of themes) {
      const withGrain = contrastFor({ source: BLACK, effect: 'film', theme, scrimmed: true });
      const withoutGrain = contrastFor({ source: BLACK, effect: 'natural', theme, scrimmed: true });
      expect(withGrain).toBeLessThanOrEqual(withoutGrain + 1e-12);
      expect(withGrain).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    }
  });

  it('is worst at the top of the copy band, where the overlay is thinnest', () => {
    for (const theme of themes) {
      const top = contrastFor({ source: WHITE, effect: 'film', theme, scrimmed: true, position: COVER_COPY_BAND_TOP });
      const bottom = contrastFor({ source: WHITE, effect: 'film', theme, scrimmed: true, position: 1 });
      expect(bottom).toBeGreaterThan(top);
      expect(top).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    }
  });

  it('holds the grain constants the shipped tile was generated with', () => {
    expect(COVER_GRAIN_LAYER_OPACITY).toBe(0.10);
    expect(COVER_GRAIN_LAYER_OPACITY_V1).toBe(0.18);
    const stylesheet = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');
    // The opacity the proof assumes is the opacity the stylesheet applies.
    expect(stylesheet).toMatch(/responsive-cover--film-grain-v1[^}]*opacity: \.18/u);
    expect(stylesheet).toMatch(/responsive-cover--film-grain-v2[^}]*opacity: \.10/u);
    expect(existsSync(resolve(process.cwd(), `public${manifest.surfaceTreatment.path}`))).toBe(true);
    expect(existsSync(resolve(process.cwd(), 'public/assets/event-covers/v1/manifest.json'))).toBe(true);
    expect(existsSync(resolve(process.cwd(), 'public/assets/event-covers/v1/film-grain-v1.png'))).toBe(true);
  });
});

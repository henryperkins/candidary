import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  COVER_OUTPUT_JPEG_QUALITIES,
  COVER_OUTPUT_WEBP_QUALITIES,
  EVENT_COVER_EFFECTS,
  EVENT_COVER_PRESET_IDS,
  EVENT_COVER_PROFILES,
  coverByteCeiling,
} from '../../shared/event-cover';
import {
  COVER_EFFECT_IDS,
  COVER_OUTPUT_QUALITIES,
  COVER_PRESET_IDS,
  COVER_PRESET_MASTER,
  COVER_PRESET_PROFILES,
  PRESET_ASSET_VERSION,
  centerCropRegion,
  coverPresetSlots,
  presetAssetPath,
  presetGrainTilePath,
  presetManifestPath,
  sha256Hex,
} from '../../scripts/build-cover-presets';
import type { CoverPresetManifest } from '../../scripts/build-cover-presets';
import { readImageDimensions, readPngHeader, verifyCoverPresets } from '../../scripts/verify-cover-presets';

const root = process.cwd();
const fromRoot = (path: string) => resolve(root, path);
const readText = (path: string) => (existsSync(fromRoot(path)) ? readFileSync(fromRoot(path), 'utf8') : '');

const manifest = (): CoverPresetManifest => JSON.parse(
  readText(`public${presetManifestPath(PRESET_ASSET_VERSION)}`) || '{"files":[]}',
) as CoverPresetManifest;

/**
 * The generator restates the registry because Node's type stripping cannot
 * resolve `shared/event-cover.ts` at runtime — it imports `./constants` without
 * an extension. This suite is the gate that makes the restatement safe: it is
 * the only place both copies are in scope at once, and a build that drifts from
 * the contract the Worker renders and delivers against fails here rather than
 * shipping 720 immutable files describing a geometry nothing else believes in.
 */
describe('the preset generator and the shared cover registry agree', () => {
  it('restates the same six presets, five effects, and six profiles', () => {
    expect([...COVER_PRESET_IDS]).toEqual([...EVENT_COVER_PRESET_IDS]);
    expect([...COVER_EFFECT_IDS]).toEqual([...EVENT_COVER_EFFECTS]);
    expect(COVER_PRESET_PROFILES.map((profile) => profile.id))
      .toEqual(EVENT_COVER_PROFILES.map((profile) => profile.id));
  });

  it('restates every profile dimension and all four byte ceilings', () => {
    for (const shared of EVENT_COVER_PROFILES) {
      const restated = COVER_PRESET_PROFILES.find((profile) => profile.id === shared.id);
      expect(restated).toBeDefined();
      expect(restated!.width).toBe(shared.width);
      expect(restated!.height).toBe(shared.height);
      for (const density of ['1x', '2x'] as const) {
        expect(restated!.webpByteCeiling[density]).toBe(coverByteCeiling(shared, density, 'webp'));
        expect(restated!.jpegByteCeiling[density]).toBe(coverByteCeiling(shared, density, 'jpeg'));
      }
    }
  });

  it('restates both output quality ladders in order', () => {
    expect(COVER_OUTPUT_QUALITIES.webp).toEqual([...COVER_OUTPUT_WEBP_QUALITIES]);
    expect(COVER_OUTPUT_QUALITIES.jpeg).toEqual([...COVER_OUTPUT_JPEG_QUALITIES]);
  });

  it('builds the same asset path the Worker resolves a published preset to', () => {
    // The identical literal is pinned against the Worker's own copy in
    // tests/worker/event-cover-storage.test.ts. Neither may move alone.
    expect(presetAssetPath(1, 'warm-linen', 'natural', 'short-lookup', '1x', 'webp'))
      .toBe('/assets/event-covers/v1/warm-linen/natural/short-lookup-1x.webp');
    expect(presetGrainTilePath(1)).toBe('/assets/event-covers/v1/film-grain-v1.png');
    expect(presetManifestPath(1)).toBe('/assets/event-covers/v1/manifest.json');
  });
});

describe('the authored masters can produce every slot without upscaling', () => {
  it('enumerates exactly the 720-file cross-product once each', () => {
    const slots = coverPresetSlots();
    expect(slots).toHaveLength(720);
    expect(new Set(slots.map((slot) => slot.path)).size).toBe(720);
    expect(slots.filter((slot) => slot.presetId === 'warm-linen')).toHaveLength(120);
    expect(slots.filter((slot) => slot.effect === 'film')).toHaveLength(144);
    expect(slots.filter((slot) => slot.density === '2x')).toHaveLength(360);
    expect(slots.filter((slot) => slot.format === 'jpeg')).toHaveLength(360);
  });

  it('takes a centred crop that contains every profile at 2x', () => {
    for (const profile of COVER_PRESET_PROFILES) {
      const target = { width: profile.width * 2, height: profile.height * 2 };
      const region = centerCropRegion(COVER_PRESET_MASTER, target);
      expect(region.width).toBeGreaterThanOrEqual(target.width);
      expect(region.height).toBeGreaterThanOrEqual(target.height);
      expect(region.left + region.width).toBeLessThanOrEqual(COVER_PRESET_MASTER.width);
      expect(region.top + region.height).toBeLessThanOrEqual(COVER_PRESET_MASTER.height);
      // Centred to within the pixel the floor gives up.
      expect(Math.abs((region.left + region.width / 2) - COVER_PRESET_MASTER.width / 2))
        .toBeLessThanOrEqual(1);
      expect(Math.abs((region.top + region.height / 2) - COVER_PRESET_MASTER.height / 2))
        .toBeLessThanOrEqual(1);
    }
  });

  it('checks in one reviewed vector master per preset', () => {
    for (const presetId of COVER_PRESET_IDS) {
      const source = readText(`design/cover-presets/${presetId}.svg`);
      expect(source, `design/cover-presets/${presetId}.svg`).toContain('<svg');
      expect(source).toContain(`width="${COVER_PRESET_MASTER.width}"`);
      expect(source).toContain(`height="${COVER_PRESET_MASTER.height}"`);
      // Every generated frame must be reproducible, so no filter may rely on an
      // unseeded turbulence and none may inherit the linearRGB default.
      expect(source).not.toMatch(/<feTurbulence(?![^>]*\bseed=)/u);
      expect(source).not.toMatch(/<filter(?![^>]*color-interpolation-filters="sRGB")/u);
    }
  });
});

describe('the checked-in preset matrix', () => {
  it('publishes a manifest describing all 720 files and the grain tile', () => {
    const current = manifest();
    expect(current.kind).toBe('candidary-cover-preset-manifest');
    expect(current.assetVersion).toBe(1);
    expect(current.composition).toBe('center');
    expect(current.master).toEqual({ width: 2400, height: 1600 });
    expect(current.files).toHaveLength(720);
    expect(current.surfaceTreatment.id).toBe('film-grain-v1');
    // The contrast evidence's input: one measured region per preset, effect, and
    // profile. `tests/unit/cover-contrast.test.ts` composites them.
    expect(current.regions).toHaveLength(180);
    expect(current.copyBandTop).toBe(0.4);
  });

  /**
   * Explicit timeout because this is genuinely bulk I/O, not a slow assertion.
   *
   * It reads all 720 files — 11.6 MB — and SHA-256s every one. That fits inside
   * the jsdom project's 5-second default on a warm working copy and does not on
   * the cold detached worktree `verify:release` builds, where several suites are
   * also competing for the disk. Raising it here is honest about the cost;
   * sampling a subset instead would quietly stop checking most of the matrix.
   */
  it('matches every checked-in file to its manifest row, ceiling, and decoded size', () => {
    const current = manifest();
    const rows = new Map(current.files.map((file) => [file.path, file]));
    const failures: string[] = [];

    for (const slot of coverPresetSlots()) {
      const row = rows.get(slot.path);
      if (!row) {
        failures.push(`no manifest row for ${slot.path}`);
        continue;
      }
      const filePath = fromRoot(`public${slot.path}`);
      if (!existsSync(filePath)) {
        failures.push(`missing file ${slot.path}`);
        continue;
      }
      const bytes = readFileSync(filePath);
      if (bytes.byteLength !== row.byteSize) failures.push(`${slot.path} byte size`);
      if (bytes.byteLength > slot.byteCeiling) failures.push(`${slot.path} over ceiling`);
      if (sha256Hex(bytes) !== row.sha256) failures.push(`${slot.path} checksum`);
      if (row.rung < 1 || row.rung > COVER_OUTPUT_QUALITIES[slot.format].length) {
        failures.push(`${slot.path} rung`);
      }
      const dimensions = readImageDimensions(slot.format, bytes);
      if (!dimensions || dimensions.width !== slot.width || dimensions.height !== slot.height) {
        failures.push(`${slot.path} decoded size`);
      }
    }

    expect(failures).toEqual([]);
  }, 60_000);

  it('ships the grain tile as an RGBA PNG matching its manifest row', () => {
    const treatment = manifest().surfaceTreatment;
    const tile = readFileSync(fromRoot(`public${treatment.path}`));
    const header = readPngHeader(tile);
    expect(header).not.toBeNull();
    expect(header!.colorType).toBe(6);
    expect(header!.width).toBe(treatment.width);
    expect(header!.height).toBe(treatment.height);
    expect(tile.byteLength).toBe(treatment.byteSize);
    expect(sha256Hex(tile)).toBe(treatment.sha256);
  });

  it('passes the release verifier the deployment gate runs', async () => {
    const result = await verifyCoverPresets({ projectRoot: root });
    expect(result.fileCount).toBe(720);
    expect(result.worstCeilingUse.ratio).toBeLessThanOrEqual(1);
    // The same bulk-I/O reason as above: the verifier re-reads all 720 files and
    // walks the versioned directory to prove nothing unregistered is in it.
  }, 60_000);
});

describe('the preset assets are reachable as versioned static files', () => {
  it('scopes a cache rule to the versioned prefix without relaxing any other header', () => {
    const headers = readText('public/_headers');
    expect(headers).toContain('/assets/event-covers/*');
    expect(headers).toMatch(
      /^\/assets\/event-covers\/\*[ \t]*\r?\n[ \t]+Cache-Control: public, max-age=31536000, immutable[ \t]*\r?$/mu,
    );
    // The block verify:pwa-build asserts must survive the addition.
    expect(headers).toMatch(
      /^\/manifest\.webmanifest[ \t]*\r?\n[ \t]+Content-Type: application\/manifest\+json[ \t]*\r?$/mu,
    );
    expect(headers).not.toMatch(/^\/api\//mu);
  });

  it('exposes repeatable generation and verification commands', () => {
    const packageJson = JSON.parse(readText('package.json')) as { scripts?: Record<string, string> };
    expect(packageJson.scripts?.['build:cover-presets'])
      .toBe('node --experimental-strip-types scripts/build-cover-presets.ts');
    expect(packageJson.scripts?.['verify:cover-presets'])
      .toBe('node --experimental-strip-types scripts/verify-cover-presets.ts');
  });
});

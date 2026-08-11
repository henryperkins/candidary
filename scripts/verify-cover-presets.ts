import { realpathSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type * as BuildCoverPresetsModule from './build-cover-presets';

/**
 * Proves the checked-in preset matrix is the one the registry describes.
 *
 * Deliberately stronger than "the manifest agrees with itself": every claim is
 * re-derived from the checked-in bytes. The byte size, the SHA-256, and the
 * pixel dimensions are read out of each file rather than trusted from the row,
 * because the failure this guards against is an asset that was regenerated,
 * hand-edited, or partially committed while its manifest entry stayed put — and
 * a preset is immutable release data, so that divergence would ship.
 *
 * The directory listing is compared both ways. A missing slot is obvious; an
 * extra file is not, and an extra file under a versioned immutable prefix is
 * exactly how a stale asset from an abandoned recipe survives a rebuild.
 */

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Node's type stripping resolves an explicit `.ts` specifier but performs no
// extension search, which is why this is a dynamic import of the exact file.
const buildModulePath = './build-cover-presets.ts';
const build = await import(buildModulePath) as typeof BuildCoverPresetsModule;

export interface ImageDimensions {
  width: number;
  height: number;
}

/** PNG: IHDR is fixed at byte 16, and colour type 6 is the RGBA the grain needs. */
export function readPngHeader(bytes: Uint8Array): (ImageDimensions & { colorType: number }) | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 26 || signature.some((byte, index) => bytes[index] !== byte)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20), colorType: bytes[25]! };
}

/**
 * WebP: a RIFF container whose first chunk names the codec.
 *
 * All three forms are read because the encoder chooses: an opaque canvas
 * produces a bare `VP8 ` frame, alpha or metadata promotes it to `VP8X`, and a
 * flat region can come back `VP8L`. Reading only the lossy form would pass by
 * accident today and fail silently the first time one of the six masters
 * encodes differently.
 */
export function readWebpDimensions(bytes: Uint8Array): ImageDimensions | null {
  const text = (start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length));
  if (bytes.length < 30 || text(0, 4) !== 'RIFF' || text(8, 4) !== 'WEBP') return null;
  const chunk = text(12, 4);
  if (chunk === 'VP8X') {
    const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
    const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
    return { width, height };
  }
  if (chunk === 'VP8 ') {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return {
      width: (bytes[26]! | (bytes[27]! << 8)) & 0x3fff,
      height: (bytes[28]! | (bytes[29]! << 8)) & 0x3fff,
    };
  }
  if (chunk === 'VP8L') {
    if (bytes[20] !== 0x2f) return null;
    const packed = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
    return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

/** JPEG: walk the marker chain to the frame header rather than assuming an offset. */
export function readJpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = view.getUint16(offset + 2);
    const isFrame = marker >= 0xc0 && marker <= 0xcf
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
    }
    if (marker === 0xda) return null;
    offset += 2 + length;
  }
  return null;
}

export function readImageDimensions(format: string, bytes: Uint8Array): ImageDimensions | null {
  if (format === 'webp') return readWebpDimensions(bytes);
  if (format === 'jpeg') return readJpegDimensions(bytes);
  return readPngHeader(bytes);
}

async function listFiles(root: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = prefix ? posix.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) found.push(...await listFiles(resolve(root, entry.name), relative));
    else found.push(relative);
  }
  return found;
}

export interface CoverPresetVerification {
  assetVersion: number;
  fileCount: number;
  totalBytes: number;
  worstCeilingUse: { path: string; ratio: number };
}

export async function verifyCoverPresets(options: {
  projectRoot?: string;
} = {}): Promise<CoverPresetVerification> {
  const projectRoot = options.projectRoot ?? PROJECT_ROOT;
  const versionRoot = resolve(projectRoot, 'public/assets/event-covers', `v${build.PRESET_ASSET_VERSION}`);
  const failures: string[] = [];

  const manifestPath = resolve(projectRoot, `public${build.presetManifestPath(build.PRESET_ASSET_VERSION)}`);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as BuildCoverPresetsModule.CoverPresetManifest;

  if (manifest.kind !== build.COVER_PRESET_MANIFEST_KIND) {
    failures.push(`Manifest kind is ${manifest.kind}.`);
  }
  if (manifest.assetVersion !== build.PRESET_ASSET_VERSION) {
    failures.push(`Manifest asset version is ${manifest.assetVersion}.`);
  }
  if (manifest.composition !== build.COVER_PRESET_COMPOSITION) {
    failures.push(`Manifest composition is ${manifest.composition}.`);
  }
  if (manifest.master.width !== build.COVER_PRESET_MASTER.width
    || manifest.master.height !== build.COVER_PRESET_MASTER.height) {
    failures.push('Manifest master size does not match the authored masters.');
  }

  const slots = build.coverPresetSlots();
  const claimed = new Map(manifest.files.map((file) => [file.path, file]));
  if (claimed.size !== manifest.files.length) failures.push('Manifest lists a path twice.');
  if (manifest.files.length !== slots.length) {
    failures.push(`Manifest lists ${manifest.files.length} files; the registry requires ${slots.length}.`);
  }

  let totalBytes = 0;
  let worstCeilingUse = { path: '', ratio: 0 };
  for (const slot of slots) {
    const file = claimed.get(slot.path);
    if (!file) {
      failures.push(`Missing manifest entry for ${slot.path}.`);
      continue;
    }
    claimed.delete(slot.path);

    let bytes: Uint8Array;
    try {
      bytes = await readFile(resolve(projectRoot, `public${slot.path}`));
    } catch {
      failures.push(`Missing file for ${slot.path}.`);
      continue;
    }
    totalBytes += bytes.byteLength;

    if (bytes.byteLength !== file.byteSize) {
      failures.push(`${slot.path} is ${bytes.byteLength} bytes; the manifest claims ${file.byteSize}.`);
    }
    if (bytes.byteLength > slot.byteCeiling) {
      failures.push(`${slot.path} is ${bytes.byteLength} bytes, above its ${slot.byteCeiling}-byte ceiling.`);
    }
    if (build.sha256Hex(bytes) !== file.sha256) {
      failures.push(`${slot.path} does not match its manifest checksum.`);
    }
    const ladder = build.COVER_OUTPUT_QUALITIES[slot.format];
    if (!Number.isInteger(file.rung) || file.rung < 1 || file.rung > ladder.length) {
      failures.push(`${slot.path} records quality rung ${file.rung}.`);
    }
    if (file.width !== slot.width || file.height !== slot.height
      || file.presetId !== slot.presetId || file.effect !== slot.effect
      || file.profile !== slot.profile || file.density !== slot.density
      || file.format !== slot.format) {
      failures.push(`${slot.path} has a manifest entry describing a different slot.`);
    }
    const dimensions = readImageDimensions(slot.format, bytes);
    if (!dimensions) {
      failures.push(`${slot.path} is not a readable ${slot.format} file.`);
    } else if (dimensions.width !== slot.width || dimensions.height !== slot.height) {
      failures.push(
        `${slot.path} decodes to ${dimensions.width}x${dimensions.height}, not ${slot.width}x${slot.height}.`,
      );
    }

    const ratio = bytes.byteLength / slot.byteCeiling;
    if (ratio > worstCeilingUse.ratio) worstCeilingUse = { path: slot.path, ratio };
  }
  for (const extra of claimed.keys()) failures.push(`Manifest lists an unregistered path ${extra}.`);

  // The region samples are the input to the contrast proof, so they are checked
  // for internal consistency here rather than trusted: a luminance that does not
  // follow from its own channels would make every derived figure a fiction, and
  // a band brighter than the frame that contains it is arithmetically impossible.
  if (manifest.copyBandTop !== build.COVER_COPY_BAND_TOP) {
    failures.push(`Manifest copy band starts at ${manifest.copyBandTop}.`);
  }
  const expectedRegions = build.COVER_PRESET_IDS.length
    * build.COVER_EFFECT_IDS.length
    * build.COVER_PRESET_PROFILES.length;
  if (manifest.regions.length !== expectedRegions) {
    failures.push(`Manifest has ${manifest.regions.length} region samples; ${expectedRegions} are required.`);
  }
  const sampled = new Set<string>();
  for (const region of manifest.regions) {
    const key = `${region.presetId}/${region.effect}/${region.profile}`;
    if (sampled.has(key)) failures.push(`Duplicate region sample for ${key}.`);
    sampled.add(key);
    for (const [name, pixel] of [['copy', region.copy], ['frame', region.frame]] as const) {
      const channels = [pixel.r, pixel.g, pixel.b];
      if (channels.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)) {
        failures.push(`${key} ${name} sample has an out-of-range channel.`);
        continue;
      }
      const derived = build.relativeLuminance(pixel);
      if (Math.abs(derived - pixel.luminance) > 1e-9) {
        failures.push(`${key} ${name} sample luminance does not follow from its channels.`);
      }
    }
    if (region.copy.luminance > region.frame.luminance + 1e-9) {
      failures.push(`${key} copy band is brighter than the frame containing it.`);
    }
  }
  for (const presetId of build.COVER_PRESET_IDS) {
    for (const effect of build.COVER_EFFECT_IDS) {
      for (const profile of build.COVER_PRESET_PROFILES) {
        const key = `${presetId}/${effect}/${profile.id}`;
        if (!sampled.has(key)) failures.push(`Missing region sample for ${key}.`);
      }
    }
  }

  const treatment = manifest.surfaceTreatment;
  if (treatment.id !== build.COVER_SURFACE_TREATMENT_ID
    || treatment.path !== build.presetGrainTilePath(build.PRESET_ASSET_VERSION)) {
    failures.push('The surface treatment entry does not name the versioned grain tile.');
  } else {
    const grain = await readFile(resolve(projectRoot, `public${treatment.path}`));
    totalBytes += grain.byteLength;
    const header = readPngHeader(grain);
    if (!header) failures.push('The grain tile is not a PNG.');
    else if (header.colorType !== 6) failures.push('The grain tile carries no alpha channel.');
    else if (header.width !== treatment.width || header.height !== treatment.height) {
      failures.push('The grain tile does not match its manifest dimensions.');
    }
    if (grain.byteLength !== treatment.byteSize || build.sha256Hex(grain) !== treatment.sha256) {
      failures.push('The grain tile does not match its manifest checksum.');
    }
  }

  const expected = new Set([
    ...slots.map((slot) => slot.path),
    build.presetGrainTilePath(build.PRESET_ASSET_VERSION),
    build.presetManifestPath(build.PRESET_ASSET_VERSION),
  ]);
  const prefix = `/assets/event-covers/v${build.PRESET_ASSET_VERSION}`;
  for (const relative of await listFiles(versionRoot)) {
    const path = `${prefix}/${relative}`;
    if (!expected.has(path)) failures.push(`Unregistered file under the versioned prefix: ${path}.`);
  }

  if (failures.length > 0) {
    throw new Error(`Cover preset verification failed:\n  ${failures.slice(0, 20).join('\n  ')}`
      + (failures.length > 20 ? `\n  ...and ${failures.length - 20} more.` : ''));
  }

  return {
    assetVersion: build.PRESET_ASSET_VERSION,
    fileCount: slots.length,
    totalBytes,
    worstCeilingUse,
  };
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
    const result = await verifyCoverPresets();
    console.log(
      `Verified ${result.fileCount} cover preset files and the grain tile `
      + `(${(result.totalBytes / 1_000_000).toFixed(1)} MB). `
      + `Tightest slot: ${result.worstCeilingUse.path} at `
      + `${(result.worstCeilingUse.ratio * 100).toFixed(0)}% of its ceiling.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Cover preset verification failed.');
    process.exitCode = 1;
  }
}

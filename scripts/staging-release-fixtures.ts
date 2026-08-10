import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import sharp from 'sharp';

import { sha256 } from './release-evidence.ts';

export const REQUIRED_FIXTURE_CAPABILITIES = [
  'jpeg',
  'opaque-png',
  'transparent-png',
  'webp',
  'iphone-heic',
  'rejected-heif',
  'rejected-sequence',
  'size-19000000',
  'size-19000001',
  'exif-orientation',
  'gps-metadata',
  'metadata-removal',
  'master-rung-1',
  'master-rung-2',
  'master-rung-3',
  'master-rung-4',
  'master-rung-5',
  'preview-rung-1',
  'preview-rung-2',
  'preview-rung-3',
  'preview-rung-4',
  'profile-webp-rung-1',
  'profile-webp-rung-2',
  'profile-webp-rung-3',
  'profile-webp-rung-4',
  'profile-jpeg-rung-1',
  'profile-jpeg-rung-2',
  'profile-jpeg-rung-3',
  'profile-jpeg-rung-4',
  'complete-2x',
  'partial-2x',
  'no-upscale',
  'transparent-matte',
  'deterministic-trim',
  'focal-crop',
] as const;

export type FixtureCapability = typeof REQUIRED_FIXTURE_CAPABILITIES[number];

interface FixturePlanBase {
  caseId: string;
  declaredMimeType: string;
  capabilities: readonly FixtureCapability[];
}

export interface GeneratedFixturePlan extends FixturePlanBase {
  source: 'generated';
  recipe: GeneratedFixtureRecipe;
}

export interface ExternalFixturePlan extends FixturePlanBase {
  source: 'external';
  sourceUrl: string;
  sourceRevision: string;
  license: 'CC-BY-SA-4.0';
  expectedSha256: string;
  expectedBytes: number;
}

export type Task11FixturePlanEntry = GeneratedFixturePlan | ExternalFixturePlan;

export type GeneratedFixtureRecipe =
  | 'jpeg-base'
  | 'opaque-png'
  | 'transparent-png'
  | 'webp-base'
  | 'oriented-gps-jpeg'
  | 'exact-19000000-jpeg'
  | 'over-19000001-jpeg'
  | `dense-master-${1 | 2 | 3 | 4 | 5}`
  | `dense-preview-${1 | 2 | 3 | 4}`
  | `dense-profile-${1 | 2 | 3 | 4}`
  | 'geometry-complete-2x'
  | 'geometry-partial-2x'
  | 'geometry-no-upscale';

export interface Task11FixtureManifestEntry {
  caseId: string;
  path: string;
  bytes: number;
  sha256: string;
  declaredMimeType: string;
  capabilities: readonly FixtureCapability[];
  provenance:
    | { kind: 'generated'; recipe: GeneratedFixtureRecipe }
    | {
        kind: 'external';
        sourceRevision: string;
        license: 'CC-BY-SA-4.0';
        sourceSha256: string;
      };
}

export interface Task11FixtureManifest {
  kind: 'candidary.task-11-fixtures';
  schemaVersion: 1;
  fixtures: Task11FixtureManifestEntry[];
}

const IANARE_REVISION = '5332a9cf0220e9c6c93f88a187daa90808051e10';
const IANARE_RAW_ROOT = `https://raw.githubusercontent.com/ianare/exif-samples/${IANARE_REVISION}`;

const FIXTURE_PLAN: readonly Task11FixturePlanEntry[] = [
  {
    caseId: 'accepted-jpeg', source: 'generated', recipe: 'jpeg-base',
    declaredMimeType: 'image/jpeg',
    capabilities: ['jpeg', 'metadata-removal'],
  },
  {
    caseId: 'opaque-png', source: 'generated', recipe: 'opaque-png',
    declaredMimeType: 'image/png', capabilities: ['opaque-png'],
  },
  {
    caseId: 'transparent-png', source: 'generated', recipe: 'transparent-png',
    declaredMimeType: 'image/png', capabilities: ['transparent-png', 'transparent-matte'],
  },
  {
    caseId: 'accepted-webp', source: 'generated', recipe: 'webp-base',
    declaredMimeType: 'image/webp', capabilities: ['webp'],
  },
  {
    caseId: 'iphone-heic', source: 'external',
    sourceUrl: `${IANARE_RAW_ROOT}/heic/mobile/iphone_13_pro_max.HEIC`,
    sourceRevision: IANARE_REVISION, license: 'CC-BY-SA-4.0',
    expectedSha256: 'e760c80eed310e4f27c092d5487693ca8e104e7cc01d25ba4828deb28f679676',
    expectedBytes: 2_182_707, declaredMimeType: 'image/heic', capabilities: ['iphone-heic'],
  },
  {
    caseId: 'rejected-heif', source: 'external',
    sourceUrl: `${IANARE_RAW_ROOT}/heic/samplefilehub.heif`,
    sourceRevision: IANARE_REVISION, license: 'CC-BY-SA-4.0',
    expectedSha256: 'f86ec0d3a6c82e31657bb1886e1ec95579329fa98d8be511ac1e8497c778e07f',
    expectedBytes: 29_208, declaredMimeType: 'image/heif', capabilities: ['rejected-heif'],
  },
  {
    caseId: 'rejected-sequence', source: 'external',
    sourceUrl: `${IANARE_RAW_ROOT}/heic/samplefilehub.heif`,
    sourceRevision: IANARE_REVISION, license: 'CC-BY-SA-4.0',
    expectedSha256: 'f86ec0d3a6c82e31657bb1886e1ec95579329fa98d8be511ac1e8497c778e07f',
    expectedBytes: 29_208, declaredMimeType: 'image/heif-sequence', capabilities: ['rejected-sequence'],
  },
  {
    caseId: 'oriented-gps-jpeg', source: 'generated', recipe: 'oriented-gps-jpeg',
    declaredMimeType: 'image/jpeg', capabilities: ['exif-orientation', 'gps-metadata'],
  },
  {
    caseId: 'exact-19000000', source: 'generated', recipe: 'exact-19000000-jpeg',
    declaredMimeType: 'image/jpeg', capabilities: ['size-19000000'],
  },
  {
    caseId: 'over-19000001', source: 'generated', recipe: 'over-19000001-jpeg',
    declaredMimeType: 'image/jpeg', capabilities: ['size-19000001'],
  },
  ...([1, 2, 3, 4, 5] as const).map((rung) => ({
    caseId: `master-rung-${rung}`,
    source: 'generated' as const,
    recipe: `dense-master-${rung}` as const,
    declaredMimeType: 'image/jpeg',
    capabilities: [`master-rung-${rung}` as const],
  })),
  ...([1, 2, 3, 4] as const).map((rung) => ({
    caseId: `preview-rung-${rung}`,
    source: 'generated' as const,
    recipe: `dense-preview-${rung}` as const,
    declaredMimeType: 'image/jpeg',
    capabilities: [`preview-rung-${rung}` as const],
  })),
  ...([1, 2, 3, 4] as const).map((rung) => ({
    caseId: `profile-rung-${rung}`,
    source: 'generated' as const,
    recipe: `dense-profile-${rung}` as const,
    declaredMimeType: 'image/jpeg',
    capabilities: [
      `profile-webp-rung-${rung}` as const,
      `profile-jpeg-rung-${rung}` as const,
    ],
  })),
  {
    caseId: 'geometry-complete-2x', source: 'generated', recipe: 'geometry-complete-2x',
    declaredMimeType: 'image/jpeg',
    capabilities: ['complete-2x', 'deterministic-trim', 'focal-crop'],
  },
  {
    caseId: 'geometry-partial-2x', source: 'generated', recipe: 'geometry-partial-2x',
    declaredMimeType: 'image/jpeg', capabilities: ['partial-2x'],
  },
  {
    caseId: 'geometry-no-upscale', source: 'generated', recipe: 'geometry-no-upscale',
    declaredMimeType: 'image/jpeg', capabilities: ['no-upscale'],
  },
];

function fail(reason: string): never {
  throw new Error(`Task 11 fixture ${reason}.`);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertSafeRelativePath(root: string, path: string): string {
  if (
    path.length === 0
    || isAbsolute(path)
    || path.includes('\\')
    || path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) fail('path is not canonical');
  const absoluteRoot = realpathSync(root);
  const absolute = resolve(absoluteRoot, ...path.split('/'));
  const fromRoot = relative(absoluteRoot, absolute);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    fail('path escapes the fixture root');
  }
  let cursor = absolute;
  while (cursor !== absoluteRoot) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) fail('path traverses a symbolic link');
    cursor = dirname(cursor);
  }
  return absolute;
}

export function task11FixturePlan(): Task11FixturePlanEntry[] {
  return FIXTURE_PLAN.map((entry) => ({ ...entry, capabilities: [...entry.capabilities] }));
}

export function assertCompleteFixturePlan<T extends readonly Task11FixturePlanEntry[]>(plan: T): T {
  if (!Array.isArray(plan) || plan.length === 0) fail('plan is empty');
  const caseIds = new Set<string>();
  const capabilities = new Set<string>();
  for (const entry of plan) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(entry.caseId)) fail('case ID is not canonical');
    if (caseIds.has(entry.caseId)) fail(`plan has duplicate case ID ${entry.caseId}`);
    caseIds.add(entry.caseId);
    if (!Array.isArray(entry.capabilities) || entry.capabilities.length === 0) {
      fail(`plan case ${entry.caseId} has no capability`);
    }
    for (const capability of entry.capabilities) {
      if (!REQUIRED_FIXTURE_CAPABILITIES.includes(capability)) fail(`plan has unknown capability ${capability}`);
      capabilities.add(capability);
    }
    if (entry.source === 'external') {
      const url = new URL(entry.sourceUrl);
      if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') fail('external source is unsafe');
      if (!/^[0-9a-f]{64}$/u.test(entry.expectedSha256) || entry.expectedBytes <= 0) {
        fail('external provenance is invalid');
      }
    }
  }
  for (const capability of REQUIRED_FIXTURE_CAPABILITIES) {
    if (!capabilities.has(capability)) fail(`plan is missing capability ${capability}`);
  }
  return plan;
}

export function assertFixtureManifest(root: string, value: unknown): Task11FixtureManifest {
  if (!isPlainRecord(value) || value.kind !== 'candidary.task-11-fixtures' || value.schemaVersion !== 1) {
    fail('manifest envelope is invalid');
  }
  if (!Array.isArray(value.fixtures)) fail('manifest fixtures are invalid');
  if (!existsSync(root) || !lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) {
    fail('manifest root is invalid');
  }
  const expectedPlan = new Map(assertCompleteFixturePlan(task11FixturePlan()).map((entry) => [entry.caseId, entry]));
  const seen = new Set<string>();
  const capabilities = new Set<string>();
  for (const candidate of value.fixtures) {
    if (!isPlainRecord(candidate) || typeof candidate.caseId !== 'string') fail('manifest entry is invalid');
    if (seen.has(candidate.caseId)) fail(`manifest has duplicate case ID ${candidate.caseId}`);
    seen.add(candidate.caseId);
    const expected = expectedPlan.get(candidate.caseId);
    if (!expected) fail(`manifest case ${candidate.caseId} is not planned`);
    if (
      typeof candidate.path !== 'string'
      || typeof candidate.bytes !== 'number'
      || !Number.isSafeInteger(candidate.bytes)
      || candidate.bytes <= 0
      || typeof candidate.sha256 !== 'string'
      || !/^[0-9a-f]{64}$/u.test(candidate.sha256)
      || candidate.declaredMimeType !== expected.declaredMimeType
      || !Array.isArray(candidate.capabilities)
      || !sameStrings(candidate.capabilities as string[], expected.capabilities)
    ) fail(`manifest case ${candidate.caseId} is invalid`);
    const absolute = assertSafeRelativePath(root, candidate.path);
    if (!existsSync(absolute) || !lstatSync(absolute).isFile() || lstatSync(absolute).isSymbolicLink()) {
      fail(`manifest path for ${candidate.caseId} is not a regular file`);
    }
    const bytes = readFileSync(absolute);
    if (bytes.length !== candidate.bytes || sha256(bytes) !== candidate.sha256) {
      fail(`manifest bytes for ${candidate.caseId} do not match`);
    }
    if (!isPlainRecord(candidate.provenance) || candidate.provenance.kind !== expected.source) {
      fail(`manifest provenance for ${candidate.caseId} is invalid`);
    }
    if (expected.source === 'generated') {
      if (candidate.provenance.recipe !== expected.recipe || Object.keys(candidate.provenance).length !== 2) {
        fail(`manifest generated provenance for ${candidate.caseId} is invalid`);
      }
    } else if (
      candidate.provenance.sourceRevision !== expected.sourceRevision
      || candidate.provenance.license !== expected.license
      || candidate.provenance.sourceSha256 !== expected.expectedSha256
      || Object.keys(candidate.provenance).length !== 4
    ) {
      fail(`manifest external provenance for ${candidate.caseId} is invalid`);
    }
    for (const capability of candidate.capabilities as string[]) capabilities.add(capability);
  }
  if (seen.size !== expectedPlan.size) fail('manifest is missing a planned capability fixture');
  for (const capability of REQUIRED_FIXTURE_CAPABILITIES) {
    if (!capabilities.has(capability)) fail(`manifest is missing capability ${capability}`);
  }
  return value as unknown as Task11FixtureManifest;
}

function deterministicPixels(width: number, height: number, channels: 3 | 4, seed: number): Buffer {
  const pixels = Buffer.allocUnsafe(width * height * channels);
  let state = seed >>> 0;
  for (let index = 0; index < pixels.length; index += channels) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const x = (index / channels) % width;
    const y = Math.floor(index / channels / width);
    pixels[index] = (state + x * 17 + y * 3) & 0xff;
    pixels[index + 1] = ((state >>> 8) + x * 5 + y * 11) & 0xff;
    pixels[index + 2] = ((state >>> 16) + x * 13 + y * 7) & 0xff;
    if (channels === 4) pixels[index + 3] = (x + y) % 7 === 0 ? 0 : 128 + ((x * 3 + y) & 0x7f);
  }
  return pixels;
}

async function raster(
  width: number,
  height: number,
  format: 'jpeg' | 'png' | 'webp',
  seed: number,
  alpha = false,
): Promise<Buffer> {
  const channels = alpha ? 4 : 3;
  const input = deterministicPixels(width, height, channels, seed);
  const pipeline = sharp(input, { raw: { width, height, channels } });
  if (format === 'png') return pipeline.png({ compressionLevel: 9 }).toBuffer();
  if (format === 'webp') return pipeline.webp({ quality: 90 }).toBuffer();
  return pipeline.jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer();
}

async function generatedFixture(recipe: GeneratedFixtureRecipe): Promise<Buffer> {
  if (recipe === 'opaque-png') return raster(1200, 900, 'png', 0x0a11ce);
  if (recipe === 'transparent-png') return raster(1200, 900, 'png', 0x7a11ce, true);
  if (recipe === 'webp-base') return raster(1800, 1200, 'webp', 0x0eb001);
  if (recipe === 'oriented-gps-jpeg') {
    const base = deterministicPixels(1600, 1000, 3, 0xe71f00);
    return sharp(base, { raw: { width: 1600, height: 1000, channels: 3 } })
      .withMetadata({ orientation: 6 })
      .withExif({
        IFD0: { Artist: 'Candidary Task 11 synthetic fixture' },
        IFD3: { GPSLatitudeRef: 'N', GPSLongitudeRef: 'W' },
      })
      .jpeg({ quality: 90 })
      .toBuffer();
  }
  if (recipe === 'exact-19000000-jpeg' || recipe === 'over-19000001-jpeg') {
    const target = recipe === 'exact-19000000-jpeg' ? 19_000_000 : 19_000_001;
    const base = await raster(1600, 1000, 'jpeg', 0x190000);
    if (base.length >= target) fail(`boundary base unexpectedly exceeds ${target} bytes`);
    return Buffer.concat([base, Buffer.alloc(target - base.length)]);
  }
  const master = /^dense-master-([1-5])$/u.exec(recipe);
  if (master) return raster(4800, 3600, 'jpeg', 0x100000 + Number(master[1]) * 0x10101);
  const preview = /^dense-preview-([1-4])$/u.exec(recipe);
  if (preview) return raster(2400, 1800, 'jpeg', 0x200000 + Number(preview[1]) * 0x20202);
  const profile = /^dense-profile-([1-4])$/u.exec(recipe);
  if (profile) return raster(1800, 1260, 'jpeg', 0x300000 + Number(profile[1]) * 0x30303);
  if (recipe === 'geometry-complete-2x') return raster(2400, 1800, 'jpeg', 0xc02000);
  if (recipe === 'geometry-partial-2x') return raster(1100, 850, 'jpeg', 0xa11200);
  if (recipe === 'geometry-no-upscale') return raster(500, 300, 'jpeg', 0x000500);
  return raster(1800, 1200, 'jpeg', 0x0ace11);
}

function extensionFor(entry: Task11FixturePlanEntry): string {
  if (entry.caseId === 'iphone-heic') return '.heic';
  if (entry.caseId === 'rejected-heif' || entry.caseId === 'rejected-sequence') return '.heif';
  if (entry.declaredMimeType === 'image/png') return '.png';
  if (entry.declaredMimeType === 'image/webp') return '.webp';
  return '.jpg';
}

async function acquireExternal(
  entry: ExternalFixturePlan,
  fetchImpl: typeof fetch,
): Promise<Buffer> {
  const response = await fetchImpl(entry.sourceUrl, { redirect: 'error' });
  if (!response.ok) fail(`external acquisition failed with HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== entry.expectedBytes || sha256(bytes) !== entry.expectedSha256) {
    fail(`external acquisition digest for ${entry.caseId} does not match`);
  }
  return bytes;
}

export async function materializeTask11Fixtures(
  root: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Task11FixtureManifest> {
  const plan = assertCompleteFixturePlan(task11FixturePlan());
  mkdirSync(root, { recursive: true });
  if (lstatSync(root).isSymbolicLink()) fail('materialization root is a symbolic link');
  const filesRoot = join(realpathSync(root), 'files');
  mkdirSync(filesRoot, { recursive: true });
  const fixtures: Task11FixtureManifestEntry[] = [];
  for (const entry of plan) {
    const bytes = entry.source === 'generated'
      ? await generatedFixture(entry.recipe)
      : await acquireExternal(entry, fetchImpl);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const path = `files/${entry.caseId}-${digest}${extensionFor(entry)}`;
    const absolute = assertSafeRelativePath(root, path);
    const temporary = `${absolute}.partial`;
    rmSync(temporary, { force: true });
    writeFileSync(temporary, bytes, { flag: 'wx' });
    if (sha256(readFileSync(temporary)) !== digest) fail(`temporary bytes for ${entry.caseId} drifted`);
    if (existsSync(absolute)) {
      if (sha256(readFileSync(absolute)) !== digest) fail(`existing bytes for ${entry.caseId} drifted`);
      rmSync(temporary);
    } else {
      renameSync(temporary, absolute);
    }
    fixtures.push({
      caseId: entry.caseId,
      path,
      bytes: bytes.length,
      sha256: digest,
      declaredMimeType: entry.declaredMimeType,
      capabilities: [...entry.capabilities],
      provenance: entry.source === 'generated'
        ? { kind: 'generated', recipe: entry.recipe }
        : {
            kind: 'external',
            sourceRevision: entry.sourceRevision,
            license: entry.license,
            sourceSha256: entry.expectedSha256,
          },
    });
  }
  const manifest: Task11FixtureManifest = {
    kind: 'candidary.task-11-fixtures',
    schemaVersion: 1,
    fixtures,
  };
  return assertFixtureManifest(root, manifest);
}

export function fixtureManifestSha256(manifest: Task11FixtureManifest): string {
  return sha256(`${JSON.stringify(manifest)}\n`);
}

export function fixtureExtension(path: string): string {
  return extname(path).toLowerCase();
}

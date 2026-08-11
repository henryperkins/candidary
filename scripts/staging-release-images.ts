import type {
  EventCoverDensity,
  EventCoverEffectId,
  EventCoverFormat,
  EventCoverProfileId,
} from '../shared/event-cover.ts';

import {
  assertCompleteFixturePlan,
  type Task11FixturePlanEntry,
} from './staging-release-fixtures.ts';

// Keep the operator CLI importable by plain Node. The app's shared modules use
// bundler-style extensionless imports, so runtime-importing them here would make
// `node --experimental-strip-types` fail before any preflight check runs. A unit
// test binds these closed registries back to `shared/event-cover.ts`.
export const TASK11_IMAGE_EFFECTS = [
  'natural', 'warm', 'film', 'soft', 'monochrome',
] as const satisfies readonly EventCoverEffectId[];

export const TASK11_IMAGE_PROFILES = [
  'short-lookup', 'compact-default', 'standard-default', 'framed-default',
  'compact-expanded', 'wide-expanded',
] as const satisfies readonly EventCoverProfileId[];

type ImageOperation = 'inspect' | 'normalize' | 'preview' | 'profile' | 'inventory';

type ImageCoverage =
  | 'boundary-accepted'
  | 'boundary-rejected'
  | 'declared-detected-type'
  | 'excluded-type'
  | 'metadata-removal'
  | 'transparent-matte'
  | 'deterministic-trim'
  | 'focal-crop'
  | 'no-upscale'
  | 'partial-2x'
  | 'complete-2x'
  | 'adoption'
  | 'mime'
  | 'dimensions'
  | 'byte-ceiling'
  | 'checksum'
  | 'inventory'
  | `master-rung-${1 | 2 | 3 | 4 | 5}`
  | `preview-rung-${1 | 2 | 3 | 4}`
  | `profile-${EventCoverFormat}-rung-${1 | 2 | 3 | 4}`
  | `effect-${EventCoverEffectId}`
  | `profile-${EventCoverProfileId}`
  | `density-${EventCoverDensity}`
  | `format-${EventCoverFormat}`;

export interface Task11ImageMatrixCase {
  caseId: string;
  fixtureCaseId: string;
  operation: ImageOperation;
  coverage: readonly ImageCoverage[];
  expectedResult: 'accepted' | 'rejected' | 'materialized' | 'adopted' | 'not-eligible';
  expectedRung?: 1 | 2 | 3 | 4 | 5;
  effect?: EventCoverEffectId;
  profile?: EventCoverProfileId;
  density?: EventCoverDensity;
  format?: EventCoverFormat;
}

export interface Task11ImageMatrixSummary {
  masterRungs: number[];
  previewRungs: number[];
  profileQualityRungs: { webp: number[]; jpeg: number[] };
  effects: string[];
  formats: string[];
  profiles: string[];
  densities: string[];
  provesBoundaries: true;
  provesMetadataRemoval: true;
  provesTransparentMatte: true;
  provesNoUpscaling: true;
  provesPartial2x: true;
  provesAdoption: true;
}

const REQUIRED_SCALAR_COVERAGE: readonly ImageCoverage[] = [
  'boundary-accepted', 'boundary-rejected', 'declared-detected-type', 'excluded-type',
  'metadata-removal', 'transparent-matte', 'deterministic-trim', 'focal-crop',
  'no-upscale', 'partial-2x', 'complete-2x', 'adoption', 'mime', 'dimensions',
  'byte-ceiling', 'checksum', 'inventory',
];

function matrixFail(reason: string): never {
  throw new Error(`Task 11 image matrix ${reason}.`);
}

function caseFor(
  caseId: string,
  fixtureCaseId: string,
  operation: ImageOperation,
  expectedResult: Task11ImageMatrixCase['expectedResult'],
  coverage: readonly ImageCoverage[],
  extra: Partial<Omit<Task11ImageMatrixCase, 'caseId' | 'fixtureCaseId' | 'operation' | 'expectedResult' | 'coverage'>> = {},
): Task11ImageMatrixCase {
  return { caseId, fixtureCaseId, operation, expectedResult, coverage, ...extra };
}

export function buildImageMatrix(
  fixturePlan: readonly Task11FixturePlanEntry[],
): Task11ImageMatrixCase[] {
  assertCompleteFixturePlan(fixturePlan);
  const cases: Task11ImageMatrixCase[] = [
    caseFor('boundary-exactly-19000000', 'exact-19000000', 'inspect', 'accepted', [
      'boundary-accepted', 'declared-detected-type',
    ]),
    caseFor('boundary-over-19000001', 'over-19000001', 'inspect', 'rejected', ['boundary-rejected']),
    caseFor('reject-heif', 'rejected-heif', 'inspect', 'rejected', ['excluded-type']),
    caseFor('reject-sequence', 'rejected-sequence', 'inspect', 'rejected', ['excluded-type']),
    caseFor('strip-orientation-gps', 'oriented-gps-jpeg', 'normalize', 'materialized', [
      'metadata-removal', 'mime', 'dimensions', 'checksum', 'inventory',
    ]),
    caseFor('transparent-matte-parity', 'transparent-png', 'normalize', 'materialized', [
      'transparent-matte', 'mime', 'dimensions', 'checksum',
    ]),
    caseFor('deterministic-trim-focus', 'geometry-complete-2x', 'profile', 'materialized', [
      'deterministic-trim', 'focal-crop', 'complete-2x', 'dimensions',
    ]),
    caseFor('partial-two-x', 'geometry-partial-2x', 'profile', 'materialized', ['partial-2x']),
    caseFor('no-upscale', 'geometry-no-upscale', 'profile', 'not-eligible', ['no-upscale']),
    caseFor('conditional-create-adoption', 'accepted-jpeg', 'inventory', 'adopted', [
      'adoption', 'byte-ceiling', 'checksum', 'inventory',
    ]),
  ];

  for (const rung of [1, 2, 3, 4, 5] as const) {
    cases.push(caseFor(
      `master-ladder-rung-${rung}`,
      `master-rung-${rung}`,
      'normalize',
      'materialized',
      [`master-rung-${rung}`, 'mime', 'dimensions', 'byte-ceiling', 'checksum', 'inventory'],
      { expectedRung: rung },
    ));
  }
  for (const rung of [1, 2, 3, 4] as const) {
    cases.push(caseFor(
      `preview-ladder-rung-${rung}`,
      `preview-rung-${rung}`,
      'preview',
      'materialized',
      [`preview-rung-${rung}`, 'mime', 'dimensions', 'byte-ceiling', 'checksum', 'inventory'],
      { expectedRung: rung },
    ));
    for (const format of ['webp', 'jpeg'] as const) {
      cases.push(caseFor(
        `profile-${format}-ladder-rung-${rung}`,
        `profile-${format}-rung-${rung}`,
        'profile',
        'materialized',
        [`profile-${format}-rung-${rung}`, `format-${format}`, 'mime', 'dimensions', 'byte-ceiling', 'checksum', 'inventory'],
        { expectedRung: rung, format },
      ));
    }
  }
  for (const effect of TASK11_IMAGE_EFFECTS) {
    cases.push(caseFor(
      `effect-${effect}`,
      'accepted-jpeg',
      'preview',
      'materialized',
      [`effect-${effect}`],
      { effect },
    ));
  }
  for (const profile of TASK11_IMAGE_PROFILES) {
    cases.push(caseFor(
      `profile-${profile}`,
      'geometry-complete-2x',
      'profile',
      'materialized',
      [`profile-${profile}`],
      { profile },
    ));
  }
  for (const density of ['1x', '2x'] as const) {
    cases.push(caseFor(
      `density-${density}`,
      'geometry-complete-2x',
      'profile',
      'materialized',
      [`density-${density}`],
      { density },
    ));
  }
  return cases;
}

function sortedNumbers(coverage: Set<string>, pattern: RegExp): number[] {
  return [...coverage]
    .map((value) => pattern.exec(value))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]))
    .sort((left, right) => left - right);
}

function sortedSuffixes(coverage: Set<string>, prefix: string): string[] {
  return [...coverage]
    .filter((value) => value.startsWith(prefix))
    .map((value) => value.slice(prefix.length))
    .sort();
}

function equal(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function assertCompleteImageMatrix(
  matrix: readonly Task11ImageMatrixCase[],
): Task11ImageMatrixSummary {
  if (!Array.isArray(matrix) || matrix.length === 0) matrixFail('is empty');
  const caseIds = new Set<string>();
  const coverage = new Set<string>();
  for (const item of matrix) {
    if (caseIds.has(item.caseId)) matrixFail(`has duplicate case ID ${item.caseId}`);
    caseIds.add(item.caseId);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(item.caseId) || item.coverage.length === 0) {
      matrixFail(`case ${item.caseId} is invalid`);
    }
    for (const entry of item.coverage) coverage.add(entry);
  }
  for (const required of REQUIRED_SCALAR_COVERAGE) {
    if (!coverage.has(required)) matrixFail(`is missing ${required}`);
  }
  const masterRungs = sortedNumbers(coverage, /^master-rung-([1-5])$/u);
  const previewRungs = sortedNumbers(coverage, /^preview-rung-([1-4])$/u);
  const webpRungs = sortedNumbers(coverage, /^profile-webp-rung-([1-4])$/u);
  const jpegRungs = sortedNumbers(coverage, /^profile-jpeg-rung-([1-4])$/u);
  const effects = sortedSuffixes(coverage, 'effect-');
  const formats = sortedSuffixes(coverage, 'format-');
  const profiles = sortedSuffixes(coverage, 'profile-')
    .filter((value) => !/^(?:webp|jpeg)-rung-/u.test(value));
  const densities = sortedSuffixes(coverage, 'density-');
  if (
    !equal(masterRungs, [1, 2, 3, 4, 5])
    || !equal(previewRungs, [1, 2, 3, 4])
    || !equal(webpRungs, [1, 2, 3, 4])
    || !equal(jpegRungs, [1, 2, 3, 4])
    || !equal(effects, [...TASK11_IMAGE_EFFECTS].sort())
    || !equal(formats, ['jpeg', 'webp'])
    || !equal(profiles, [...TASK11_IMAGE_PROFILES].sort())
    || !equal(densities, ['1x', '2x'])
  ) matrixFail('does not cover the closed product registry');
  return {
    masterRungs,
    previewRungs,
    profileQualityRungs: { webp: webpRungs, jpeg: jpegRungs },
    effects,
    formats,
    profiles,
    densities,
    provesBoundaries: true,
    provesMetadataRemoval: true,
    provesTransparentMatte: true,
    provesNoUpscaling: true,
    provesPartial2x: true,
    provesAdoption: true,
  };
}

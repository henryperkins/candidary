// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  TASK11_IMAGE_EFFECTS,
  TASK11_IMAGE_PROFILES,
  assertCompleteImageMatrix,
  buildImageMatrix,
} from '../../scripts/staging-release-images';
import { task11FixturePlan } from '../../scripts/staging-release-fixtures';
import { EVENT_COVER_EFFECTS, EVENT_COVER_PROFILES } from '../../shared/event-cover';

describe('Task 11 Images matrix', () => {
  it('binds the operator-safe registries to the candidate product registries', () => {
    expect(TASK11_IMAGE_EFFECTS).toEqual(EVENT_COVER_EFFECTS);
    expect(TASK11_IMAGE_PROFILES).toEqual(EVENT_COVER_PROFILES.map((profile) => profile.id));
  });

  it('covers every ladder, quality, effect, format, metadata, and geometry assertion', () => {
    const matrix = buildImageMatrix(task11FixturePlan());
    expect(assertCompleteImageMatrix(matrix)).toEqual({
      masterRungs: [1, 2, 3, 4, 5],
      previewRungs: [1, 2, 3, 4],
      profileQualityRungs: {
        webp: [1, 2, 3, 4],
        jpeg: [1, 2, 3, 4],
      },
      effects: ['film', 'monochrome', 'natural', 'soft', 'warm'],
      formats: ['jpeg', 'webp'],
      profiles: [
        'compact-default', 'compact-expanded', 'framed-default',
        'short-lookup', 'standard-default', 'wide-expanded',
      ],
      densities: ['1x', '2x'],
      provesBoundaries: true,
      provesMetadataRemoval: true,
      provesTransparentMatte: true,
      provesNoUpscaling: true,
      provesPartial2x: true,
      provesAdoption: true,
    });
    for (const rung of [1, 2, 3, 4] as const) {
      for (const format of ['webp', 'jpeg'] as const) {
        expect(matrix.find((entry) => entry.caseId === `profile-${format}-ladder-rung-${rung}`))
          .toMatchObject({ fixtureCaseId: `profile-${format}-rung-${rung}` });
      }
    }
  });

  it('fails when any mandatory matrix case is absent or duplicated', () => {
    const matrix = buildImageMatrix(task11FixturePlan());
    expect(() => assertCompleteImageMatrix(matrix.slice(1))).toThrow(/matrix/u);
    expect(() => assertCompleteImageMatrix([...matrix, matrix[0]!])).toThrow(/duplicate/u);
  });
});

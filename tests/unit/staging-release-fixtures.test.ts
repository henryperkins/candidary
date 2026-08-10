// @vitest-environment node

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { sha256 } from '../../scripts/release-evidence';
import {
  REQUIRED_FIXTURE_CAPABILITIES,
  assertCompleteFixturePlan,
  assertFixtureManifest,
  task11FixturePlan,
  type Task11FixtureManifest,
} from '../../scripts/staging-release-fixtures';

const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true });
  roots.clear();
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'candidary-staging-fixtures-'));
  roots.add(root);
  return root;
}

describe('Task 11 fixture corpus', () => {
  it('plans every required format, boundary, metadata, ladder, and geometry capability', () => {
    const plan = task11FixturePlan();
    expect(assertCompleteFixturePlan(plan)).toBe(plan);
    const capabilities = new Set(plan.flatMap((fixture) => fixture.capabilities));
    for (const capability of REQUIRED_FIXTURE_CAPABILITIES) {
      expect(capabilities.has(capability), capability).toBe(true);
    }
    expect(plan.find((fixture) => fixture.caseId === 'iphone-heic')).toMatchObject({
      source: 'external',
      expectedSha256: 'e760c80eed310e4f27c092d5487693ca8e104e7cc01d25ba4828deb28f679676',
      expectedBytes: 2_182_707,
      sourceRevision: '5332a9cf0220e9c6c93f88a187daa90808051e10',
      license: 'CC-BY-SA-4.0',
    });
  });

  it('verifies every fixture byte and refuses incomplete, duplicate, or escaping manifests', () => {
    const root = temporaryRoot();
    const fixtures = task11FixturePlan().map((fixture, index) => {
      const path = `files/${fixture.caseId}.bin`;
      const bytes = Buffer.from(`fixture-${index}`);
      const absolute = join(root, ...path.split('/'));
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, bytes);
      return {
        caseId: fixture.caseId,
        path,
        bytes: bytes.length,
        sha256: sha256(bytes),
        declaredMimeType: fixture.declaredMimeType,
        capabilities: fixture.capabilities,
        provenance: fixture.source === 'generated'
          ? { kind: 'generated' as const, recipe: fixture.recipe }
          : {
            kind: 'external' as const,
            sourceRevision: fixture.sourceRevision,
            license: fixture.license,
            sourceSha256: fixture.expectedSha256,
          },
      };
    });
    const manifest: Task11FixtureManifest = {
      kind: 'candidary.task-11-fixtures', schemaVersion: 1, fixtures,
    };
    expect(assertFixtureManifest(root, manifest).fixtures).toHaveLength(fixtures.length);

    expect(() => assertFixtureManifest(root, {
      ...manifest, fixtures: manifest.fixtures.slice(1),
    })).toThrow(/capability/u);
    expect(() => assertFixtureManifest(root, {
      ...manifest, fixtures: [...manifest.fixtures, manifest.fixtures[0]!],
    })).toThrow(/duplicate/u);
    expect(() => assertFixtureManifest(root, {
      ...manifest,
      fixtures: [{ ...manifest.fixtures[0]!, path: '../private.heic' }, ...manifest.fixtures.slice(1)],
    })).toThrow(/path/u);
  });
});

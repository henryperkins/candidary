import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@cloudflare/vite-plugin', () => ({ cloudflare: () => ({ name: 'cloudflare-test-stub' }) }));
vi.mock('@vitejs/plugin-react', () => ({ default: () => ({ name: 'react-test-stub' }) }));

import {
  GUEST_JOURNEY_VERSION,
  RELEASE_EVIDENCE_SCHEMA_VERSION,
  parseReleaseCertification,
  parseRuntimeReleaseIdentity,
  releaseCertificationMatches,
  type ReleaseCertification,
  type RuntimeReleaseIdentity,
} from '../../shared/release';
import { resolveBuildCandidate } from '../../vite.config';

const BUILD_SHA = '0123456789abcdef0123456789abcdef01234567';
const MIGRATION_SHA = 'a'.repeat(64);
const EVIDENCE_SHA = 'b'.repeat(64);
const PHYSICAL_SHA = 'c'.repeat(64);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function releaseCandidateRepository(): Promise<{ root: string; sha: string }> {
  const root = await mkdtemp(join(tmpdir(), 'candidary-release-build-'));
  temporaryRoots.push(root);
  await mkdir(join(root, 'migrations'), { recursive: true });
  await writeFile(join(root, '.gitignore'), 'node_modules/\ndist/\n.wrangler/\noutput/\n', 'utf8');
  await writeFile(join(root, 'migrations', '0001_initial.sql'), 'select 1;\n', 'utf8');
  await writeFile(join(root, 'tracked.txt'), 'clean\n', 'utf8');
  git(root, 'init', '--quiet');
  git(root, 'config', 'user.name', 'Candidary Tests');
  git(root, 'config', 'user.email', 'tests@candidary.invalid');
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'fixture');
  return { root, sha: git(root, 'rev-parse', 'HEAD') };
}

const CERTIFICATION: ReleaseCertification = {
  buildSha: BUILD_SHA,
  workerVersionId: 'candidary-worker-v1',
  guestJourneyVersion: 1,
  migrationManifestSha256: MIGRATION_SHA,
  evidenceManifestSha256: EVIDENCE_SHA,
  physicalEvidenceRefs: [{
    category: 'printed-entry-ios',
    evidenceId: '11111111-1111-4111-8111-111111111111',
    manifestSha256: PHYSICAL_SHA,
    capturedAt: '2026-08-02T12:34:56.789Z',
  }],
  certifiedAt: '2026-08-02T13:00:00.000Z',
};

function runtimeInput(overrides: Record<string, unknown> = {}) {
  return {
    buildSha: BUILD_SHA,
    workerVersionId: 'candidary-worker-v1',
    workerVersionTag: BUILD_SHA,
    migrationManifestSha256: MIGRATION_SHA,
    ...overrides,
  };
}

function certificationInput(overrides: Record<string, unknown> = {}) {
  return {
    ...CERTIFICATION,
    ...overrides,
  };
}

describe('release contract', () => {
  // Production break caught: a clean commit is not injected exactly, or source dirt is mislabeled as that commit.
  it('resolves the exact clean build candidate and rejects tracked or untracked dirt', async () => {
    const clean = await releaseCandidateRepository();
    expect(resolveBuildCandidate(clean.root).buildSha).toBe(clean.sha);

    const tracked = await releaseCandidateRepository();
    await writeFile(join(tracked.root, 'tracked.txt'), 'dirty\n', 'utf8');
    expect(resolveBuildCandidate(tracked.root).buildSha).toBe('');

    const untracked = await releaseCandidateRepository();
    await writeFile(join(untracked.root, 'notes.txt'), 'untracked\n', 'utf8');
    expect(resolveBuildCandidate(untracked.root).buildSha).toBe('');
  });

  // Production break caught: ordinary ignored dependency/build/tool output prevents a clean candidate identity.
  it('does not count ignored dependency, build, Wrangler, or release output', async () => {
    const candidate = await releaseCandidateRepository();
    for (const path of [
      'node_modules/example/index.js',
      'dist/client/index.html',
      '.wrangler/state.json',
      'output/release/result.json',
    ]) {
      const target = join(candidate.root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, 'ignored\n', 'utf8');
    }

    expect(resolveBuildCandidate(candidate.root).buildSha).toBe(candidate.sha);
  });

  // Production break caught: either checked-in version source drifts from the first contract version.
  it('exports the checked-in evidence and guest journey versions', () => {
    expect(RELEASE_EVIDENCE_SCHEMA_VERSION).toBe(1);
    expect(GUEST_JOURNEY_VERSION).toBe(1);
  });

  // Production break caught: a complete runtime identity is rejected or normalized instead of copied exactly.
  it('parses a complete runtime identity', () => {
    expect(parseRuntimeReleaseIdentity(runtimeInput())).toEqual({
      buildSha: BUILD_SHA,
      workerVersionId: 'candidary-worker-v1',
      guestJourneyVersion: 1,
      migrationManifestSha256: MIGRATION_SHA,
    });
  });

  // Production break caught: missing or non-canonical Git SHAs are accepted into the runtime identity.
  it.each([
    ['missing', undefined],
    ['short', '0123456789abcdef'],
    ['uppercase', '0123456789ABCDEF0123456789ABCDEF01234567'],
    ['left-padded', ` ${BUILD_SHA}`],
    ['right-padded', `${BUILD_SHA} `],
  ])('rejects a %s runtime build SHA', (_label, buildSha) => {
    expect(parseRuntimeReleaseIdentity(runtimeInput({ buildSha, workerVersionTag: buildSha }))).toBeNull();
  });

  // Production break caught: missing, blank, padded, or oversized Worker version IDs are normalized into validity.
  it.each([
    ['missing', undefined],
    ['blank', ''],
    ['whitespace', '   '],
    ['left-padded', ' worker-version'],
    ['right-padded', 'worker-version '],
    ['oversized', 'v'.repeat(129)],
  ])('rejects a %s Worker version ID', (_label, workerVersionId) => {
    expect(parseRuntimeReleaseIdentity(runtimeInput({ workerVersionId }))).toBeNull();
  });

  // Production break caught: an absent or mismatched deployment tag can attest a different build SHA.
  it.each([
    ['missing', undefined],
    ['mismatched', 'fedcba9876543210fedcba9876543210fedcba98'],
  ])('rejects a %s Worker version tag', (_label, workerVersionTag) => {
    expect(parseRuntimeReleaseIdentity(runtimeInput({ workerVersionTag }))).toBeNull();
  });

  // Production break caught: malformed or padded migration digests are accepted as release identity.
  it.each([
    ['missing', undefined],
    ['short', 'a'.repeat(63)],
    ['uppercase', 'A'.repeat(64)],
    ['padded', ` ${MIGRATION_SHA}`],
  ])('rejects a %s migration digest', (_label, migrationManifestSha256) => {
    expect(parseRuntimeReleaseIdentity(runtimeInput({ migrationManifestSha256 }))).toBeNull();
  });

  // Production break caught: runtime metadata outside the four-value boundary is silently retained or accepted.
  it('rejects extra runtime identity keys', () => {
    expect(parseRuntimeReleaseIdentity(runtimeInput({ environment: 'production' }))).toBeNull();
  });

  // Production break caught: a complete strict certification cannot round-trip through the parser.
  it('parses a complete release certification', () => {
    expect(parseReleaseCertification(certificationInput())).toEqual(certificationInput());
  });

  // Production break caught: non-positive, fractional, unsafe, or coerced journey versions enter certification storage.
  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1],
    ['string', '1'],
  ])('rejects a %s guest journey version', (_label, guestJourneyVersion) => {
    expect(parseReleaseCertification(certificationInput({ guestJourneyVersion }))).toBeNull();
  });

  // Production break caught: malformed build, migration, or evidence hashes enter a stored certification.
  it.each([
    ['build', { buildSha: 'A'.repeat(40) }],
    ['migration', { migrationManifestSha256: 'a'.repeat(63) }],
    ['evidence', { evidenceManifestSha256: `${EVIDENCE_SHA} ` }],
  ])('rejects a malformed %s hash', (_label, override) => {
    expect(parseReleaseCertification(certificationInput(override))).toBeNull();
  });

  // Production break caught: missing physical proof is represented as a certifiable release.
  it('rejects an empty physical evidence reference array', () => {
    expect(parseReleaseCertification(certificationInput({ physicalEvidenceRefs: [] }))).toBeNull();
  });

  // Production break caught: one evidence category can be counted twice in a certification.
  it('rejects duplicate physical evidence categories', () => {
    const duplicate = {
      category: 'printed-entry-ios',
      evidenceId: '22222222-2222-4222-8222-222222222222',
      manifestSha256: 'd'.repeat(64),
      capturedAt: '2026-08-02T12:35:56.789Z',
    };

    expect(parseReleaseCertification(certificationInput({
      physicalEvidenceRefs: [certificationInput().physicalEvidenceRefs[0], duplicate],
    }))).toBeNull();
  });

  // Production break caught: an unversioned free-form category expands the redacted evidence vocabulary.
  it('rejects an unknown physical evidence category', () => {
    expect(parseReleaseCertification(certificationInput({
      physicalEvidenceRefs: [{
        ...certificationInput().physicalEvidenceRefs[0],
        category: 'informal-device-check',
      }],
    }))).toBeNull();
  });

  // Production break caught: sensitive or free-form fields leak into the intentionally redacted reference object.
  it.each([
    ['extra key', { unexpected: true }],
    ['note', { note: 'Observed on a personal device' }],
    ['URL', { url: 'https://evidence.invalid/run/1' }],
    ['filename', { filename: 'private-recording.mov' }],
    ['device', { device: 'Personal phone' }],
  ])('rejects a physical evidence reference with a %s', (_label, extra) => {
    expect(parseReleaseCertification(certificationInput({
      physicalEvidenceRefs: [{ ...certificationInput().physicalEvidenceRefs[0], ...extra }],
    }))).toBeNull();
  });

  // Production break caught: invalid UUIDs or physical-reference digests are accepted as durable evidence pointers.
  it.each([
    ['evidence ID', { evidenceId: 'not-a-uuid' }],
    ['evidence ID version', { evidenceId: '11111111-1111-0111-8111-111111111111' }],
    ['evidence ID variant', { evidenceId: '11111111-1111-4111-1111-111111111111' }],
    ['manifest digest', { manifestSha256: 'C'.repeat(64) }],
  ])('rejects an invalid physical %s', (_label, override) => {
    expect(parseReleaseCertification(certificationInput({
      physicalEvidenceRefs: [{ ...certificationInput().physicalEvidenceRefs[0], ...override }],
    }))).toBeNull();
  });

  // Production break caught: non-UTC, impossible, or non-canonical physical capture instants are accepted.
  it.each([
    ['offset', '2026-08-02T07:34:56.789-05:00'],
    ['impossible', '2026-02-30T12:34:56.789Z'],
    ['missing milliseconds', '2026-08-02T12:34:56Z'],
  ])('rejects a %s physical capture timestamp', (_label, capturedAt) => {
    expect(parseReleaseCertification(certificationInput({
      physicalEvidenceRefs: [{ ...certificationInput().physicalEvidenceRefs[0], capturedAt }],
    }))).toBeNull();
  });

  // Production break caught: non-UTC, impossible, or non-canonical certification instants are accepted.
  it.each([
    ['offset', '2026-08-02T08:00:00.000-05:00'],
    ['impossible', '2026-02-30T13:00:00.000Z'],
    ['padded', ' 2026-08-02T13:00:00.000Z'],
  ])('rejects a %s certification timestamp', (_label, certifiedAt) => {
    expect(parseReleaseCertification(certificationInput({ certifiedAt }))).toBeNull();
  });

  // Production break caught: unredacted top-level metadata survives strict certification parsing.
  it('rejects extra certification keys', () => {
    expect(parseReleaseCertification(certificationInput({ notes: 'release ready' }))).toBeNull();
  });
});

describe('release certification matching', () => {
  const identity: RuntimeReleaseIdentity = {
    buildSha: BUILD_SHA,
    workerVersionId: 'candidary-worker-v1',
    guestJourneyVersion: 1,
    migrationManifestSha256: MIGRATION_SHA,
  };
  const certification = CERTIFICATION;

  // Production break caught: missing runtime or certification data is treated as a match.
  it.each([
    ['runtime', null, certification],
    ['certification', identity, null],
    ['both', null, null],
  ] as const)('returns false when %s input is null', (_label, runtime, certified) => {
    expect(releaseCertificationMatches(runtime, certified)).toBe(false);
  });

  // Production break caught: one mismatched runtime dimension is ignored during exact matching.
  it.each([
    ['build SHA', { buildSha: 'fedcba9876543210fedcba9876543210fedcba98' }],
    ['Worker version ID', { workerVersionId: 'different-worker-version' }],
    ['guest journey version', { guestJourneyVersion: 2 }],
    ['migration digest', { migrationManifestSha256: 'd'.repeat(64) }],
  ])('returns false for a mismatched %s', (_label, override) => {
    expect(releaseCertificationMatches(identity, { ...certification, ...override })).toBe(false);
  });

  // Production break caught: an exact four-dimensional release identity cannot find its certification.
  it('returns true for an exact runtime identity match', () => {
    expect(releaseCertificationMatches(identity, certification)).toBe(true);
  });
});

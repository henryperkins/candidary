import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';

import {
  assertRedactedCandidateManifest,
  canonicalJson,
  collectDeployableArtifacts,
  collectMigrationManifest,
  normalizedBindingTopology,
  sha256,
  type CandidateManifest,
  type HashedFile,
} from './release-evidence.ts';
import {
  MEDIA_UPLOAD_RELEASE_CONFIG_PATH,
  verifyMediaUploadReleaseContract,
  type MediaUploadReleaseContractV2,
  type VerifiedCanonicalArtifact,
} from './media-cutover-release-contract.ts';

export const PINNED_WRANGLER_VERSION = '4.113.0' as const;
export const PHASE_2_MIGRATION = '0013_guest_message_hardening.sql' as const;
export const PHASE_3_MIGRATION = '0014_event_cover_invariants.sql' as const;
export const POST_CUTOVER_MIGRATION = '0015_curated_private_guestbook.sql' as const;

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const MIGRATION_NAME_PATTERN = /^\d{4}_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/u;

export interface ReleaseCandidateVerificationRequest {
  candidateRoot: string;
  sha: string;
  manifestPath: string;
  approvedBaseSha: string;
  expectedMigrationCount: 13 | 14 | 15;
}

export interface ReleaseCandidateObservationAdapter {
  resolveCommit(candidateRoot: string, sha: string): string;
  head(candidateRoot: string): string;
  tree(candidateRoot: string): string;
  status(candidateRoot: string): string;
}

export interface VerifiedReleaseCandidate {
  candidateRoot: string;
  sha: string;
  tree: string;
  approvedBaseSha: string;
  manifestPath: string;
  manifestSha256: string;
  manifest: CandidateManifest;
  migrations: HashedFile[];
  migrationCount: 13 | 14 | 15;
  artifactTreeSha256: string;
  wranglerVersion: typeof PINNED_WRANGLER_VERSION;
  wranglerCliPath: string;
}

export interface MigrationBundle {
  outputPath: string;
  sha256: string;
  migrations: string[];
  migrationHash?: string;
}

function exactRegularFile(path: string, label: string): string {
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be one exact regular file, not a symlink.`);
  }
  return absolute;
}

function exactDirectory(path: string, label: string): string {
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be one exact directory, not a symlink.`);
  }
  return absolute;
}

function within(container: string, target: string): boolean {
  const path = relative(container, target);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function exactSha(value: string, label: string): string {
  if (!SHA_PATTERN.test(value)) throw new Error(`${label} must be one full lowercase commit SHA.`);
  return value;
}

function exactObject(value: string, label: string): string {
  const match = /^([0-9a-f]{40})(?:\r?\n)?$/u.exec(value);
  if (!match) throw new Error(`${label} was not one exact lowercase Git object ID.`);
  return match[1]!;
}

function readJson(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(exactRegularFile(path, label), 'utf8')) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON.`, { cause: error });
    throw error;
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function equalEvidence(left: unknown, right: unknown, label: string): void {
  if (canonicalJson(left) !== canonicalJson(right)) throw new Error(`${label} drifted from candidate evidence.`);
}

function loadManifest(path: string): {
  manifest: CandidateManifest;
  path: string;
  digest: string;
} {
  const manifestPath = exactRegularFile(path, 'Candidate manifest');
  if (basename(manifestPath) !== 'candidate-manifest.json') {
    throw new Error('Candidate manifest must use the exact candidate-manifest.json filename.');
  }
  const bytes = readFileSync(manifestPath);
  const digest = sha256(bytes);
  const sidecar = readFileSync(
    exactRegularFile(`${manifestPath}.sha256`, 'Candidate manifest sidecar'),
    'utf8',
  );
  if (sidecar !== `${digest}  candidate-manifest.json\n`) {
    throw new Error('Candidate manifest sidecar does not match the exact manifest bytes.');
  }
  const value = JSON.parse(bytes.toString('utf8')) as unknown;
  assertRedactedCandidateManifest(value);
  return { manifest: value, path: manifestPath, digest };
}

function checkedWrangler(candidateRoot: string): {
  version: typeof PINNED_WRANGLER_VERSION;
  cliPath: string;
} {
  const packageJson = record(readJson(resolve(candidateRoot, 'package.json'), 'package.json'), 'package.json');
  const devDependencies = record(packageJson.devDependencies, 'package.json devDependencies');
  if (devDependencies.wrangler !== PINNED_WRANGLER_VERSION) {
    throw new Error(`package.json must pin Wrangler exactly to ${PINNED_WRANGLER_VERSION}.`);
  }

  const lock = record(readJson(resolve(candidateRoot, 'package-lock.json'), 'package-lock.json'), 'package-lock.json');
  const packages = record(lock.packages, 'package-lock.json packages');
  const lockedWrangler = record(packages['node_modules/wrangler'], 'locked Wrangler package');
  if (lockedWrangler.version !== PINNED_WRANGLER_VERSION) {
    throw new Error(`package-lock.json must resolve Wrangler ${PINNED_WRANGLER_VERSION}.`);
  }

  const installed = record(
    readJson(resolve(candidateRoot, 'node_modules/wrangler/package.json'), 'installed Wrangler package'),
    'installed Wrangler package',
  );
  if (installed.version !== PINNED_WRANGLER_VERSION) {
    throw new Error(`Installed Wrangler must be ${PINNED_WRANGLER_VERSION}.`);
  }
  const cliPath = exactRegularFile(
    resolve(candidateRoot, 'node_modules/wrangler/bin/wrangler.js'),
    'Wrangler CLI',
  );
  if (!within(realpathSync(candidateRoot), realpathSync(cliPath))) {
    throw new Error('Wrangler CLI must remain inside the exact candidate checkout.');
  }
  return { version: PINNED_WRANGLER_VERSION, cliPath };
}

function readGuestJourneyVersion(candidateRoot: string): number {
  const release = record(
    readJson(resolve(candidateRoot, 'config/release.json'), 'release config'),
    'release config',
  );
  const version = release.guestJourneyVersion;
  if (!Number.isSafeInteger(version) || (version as number) <= 0) {
    throw new Error('Release config guest journey version is invalid.');
  }
  return version as number;
}

export function verifyExactReleaseCandidate(
  request: ReleaseCandidateVerificationRequest,
  adapters: ReleaseCandidateObservationAdapter,
): VerifiedReleaseCandidate {
  const sha = exactSha(request.sha, 'Candidate SHA');
  const approvedBaseSha = exactSha(request.approvedBaseSha, 'Approved base SHA');
  const candidateRoot = exactDirectory(request.candidateRoot, 'Candidate root');
  const loaded = loadManifest(request.manifestPath);
  if (!within(candidateRoot, loaded.path)) {
    throw new Error('Candidate manifest must remain inside the candidate checkout.');
  }
  const manifest = loaded.manifest;
  if (manifest.status !== 'passed' || manifest.candidate === null
    || manifest.migrations === null || manifest.bindings === null || manifest.artifacts === null) {
    throw new Error('Only one complete passed candidate manifest is eligible.');
  }
  const expectedManifestDirectory = resolve(
    candidateRoot,
    'output/release',
    sha,
    manifest.runId,
  );
  if (realpathSync(dirname(loaded.path)) !== realpathSync(expectedManifestDirectory)) {
    throw new Error('Candidate manifest path does not match its SHA and run identity.');
  }
  if (manifest.candidate.gitSha !== sha) throw new Error('Candidate manifest commit does not match the approved SHA.');
  if (manifest.candidate.approvedBaseSha !== approvedBaseSha) {
    throw new Error('Candidate manifest approved base does not match the authorization.');
  }

  const resolvedCommit = exactObject(adapters.resolveCommit(candidateRoot, sha), 'Resolved commit');
  const head = exactObject(adapters.head(candidateRoot), 'Candidate HEAD');
  const tree = exactObject(adapters.tree(candidateRoot), 'Candidate tree');
  if (resolvedCommit !== sha) throw new Error('Candidate commit did not resolve to itself.');
  if (head !== sha) throw new Error('Candidate HEAD is not the exact approved SHA.');
  if (tree !== manifest.candidate.gitTree) throw new Error('Candidate tree does not match the manifest.');
  if (adapters.status(candidateRoot) !== '') throw new Error('Candidate checkout must be exactly clean.');

  const migrationInventory = collectMigrationManifest(candidateRoot);
  if (migrationInventory.files.length !== request.expectedMigrationCount
    || manifest.migrations.verification.migrationCount !== request.expectedMigrationCount) {
    throw new Error('Candidate migration count does not match the required release phase.');
  }
  const requiredLastMigration = request.expectedMigrationCount === 13
    ? PHASE_2_MIGRATION
    : request.expectedMigrationCount === 14
      ? PHASE_3_MIGRATION
      : POST_CUTOVER_MIGRATION;
  if (basename(migrationInventory.files.at(-1)?.path ?? '') !== requiredLastMigration) {
    throw new Error('Candidate migration boundary does not match the required release phase.');
  }
  if (migrationInventory.sha256 !== manifest.candidate.migrationManifestSha256) {
    throw new Error('Candidate migration aggregate drifted from the manifest.');
  }
  equalEvidence(migrationInventory.files, manifest.migrations.manifest, 'Candidate migration inventory');

  const packageLock = readFileSync(exactRegularFile(resolve(candidateRoot, 'package-lock.json'), 'package-lock.json'));
  const sourceConfigBytes = readFileSync(exactRegularFile(resolve(candidateRoot, 'wrangler.jsonc'), 'source Wrangler config'));
  if (sha256(packageLock) !== manifest.candidate.packageLockSha256) {
    throw new Error('Candidate package lock drifted from the manifest.');
  }
  if (sha256(sourceConfigBytes) !== manifest.candidate.sourceWranglerConfigSha256) {
    throw new Error('Candidate source Wrangler config drifted from the manifest.');
  }
  if (readGuestJourneyVersion(candidateRoot) !== manifest.candidate.guestJourneyVersion) {
    throw new Error('Candidate guest journey version drifted from the manifest.');
  }

  const sourceConfig = JSON.parse(sourceConfigBytes.toString('utf8')) as unknown;
  const sourceTopology = normalizedBindingTopology(sourceConfig);
  equalEvidence(sourceTopology, manifest.bindings.topology, 'Candidate source binding topology');
  if (sha256(canonicalJson(sourceTopology)) !== manifest.bindings.sourceTopologySha256) {
    throw new Error('Candidate source binding topology digest drifted from the manifest.');
  }

  const artifacts = collectDeployableArtifacts(candidateRoot);
  equalEvidence(artifacts.deployWranglerConfig, manifest.artifacts.deployWranglerConfig, 'Deploy config artifact');
  equalEvidence(artifacts.worker, manifest.artifacts.worker, 'Worker artifact');
  equalEvidence(artifacts.client, manifest.artifacts.client, 'Client artifacts');
  if (artifacts.treeSha256 !== manifest.artifacts.firstTreeSha256
    || manifest.artifacts.secondTreeSha256 !== artifacts.treeSha256
    || manifest.artifacts.dryRunWorkerSha256 !== artifacts.worker.sha256) {
    throw new Error('Deploy artifact tree drifted from candidate evidence.');
  }
  const generatedConfig = readJson(
    resolve(candidateRoot, manifest.artifacts.deployWranglerConfig.path),
    'generated Wrangler config',
  );
  const generatedTopologySha = sha256(canonicalJson(normalizedBindingTopology(generatedConfig)));
  if (generatedTopologySha !== manifest.bindings.sourceTopologySha256
    || manifest.bindings.firstBuildTopologySha256 !== generatedTopologySha
    || manifest.bindings.secondBuildTopologySha256 !== generatedTopologySha) {
    throw new Error('Generated binding topology drifted from candidate evidence.');
  }

  const wrangler = checkedWrangler(candidateRoot);
  if (manifest.execution.tools.wrangler !== PINNED_WRANGLER_VERSION) {
    throw new Error('Candidate manifest did not record the pinned Wrangler version.');
  }
  return {
    candidateRoot,
    sha,
    tree,
    approvedBaseSha,
    manifestPath: loaded.path,
    manifestSha256: loaded.digest,
    manifest,
    migrations: migrationInventory.files,
    migrationCount: request.expectedMigrationCount,
    artifactTreeSha256: artifacts.treeSha256,
    wranglerVersion: wrangler.version,
    wranglerCliPath: wrangler.cliPath,
  };
}

function canonicalMigrationBytes(candidate: VerifiedReleaseCandidate, migration: HashedFile): Buffer {
  const path = exactRegularFile(resolve(candidate.candidateRoot, migration.path), 'Migration source');
  if (!within(candidate.candidateRoot, path)) throw new Error('Migration source escaped the candidate root.');
  const source = readFileSync(path);
  const canonical = Buffer.from(source.toString('utf8').replaceAll('\r\n', '\n'), 'utf8');
  if (sha256(canonical) !== migration.sha256 || canonical.byteLength !== migration.bytes) {
    throw new Error(`Migration source ${basename(migration.path)} drifted after candidate verification.`);
  }
  return canonical;
}

function writeExclusiveBundle(
  candidateRoot: string,
  outputPath: string,
  chunks: Array<string | Uint8Array>,
): { outputPath: string; sha256: string } {
  const target = resolve(outputPath);
  if (!within(candidateRoot, target)) throw new Error('Migration bundle output must remain inside the candidate root.');
  mkdirSync(dirname(target), { recursive: true });
  if (!within(realpathSync(candidateRoot), realpathSync(dirname(target)))) {
    throw new Error('Migration bundle output directory escaped the candidate root.');
  }
  const bytes = Buffer.concat(chunks.map((chunk) => typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk)));
  writeFileSync(target, bytes, { flag: 'wx' });
  return { outputPath: target, sha256: sha256(bytes) };
}

function appendMigration(chunks: Array<string | Uint8Array>, bytes: Buffer, name: string): void {
  chunks.push(bytes);
  if (bytes.length === 0 || bytes.at(-1) !== 0x0a) chunks.push('\n');
  chunks.push(`INSERT INTO "d1_migrations" (name) VALUES ('${name}');\n`);
}

export function buildPhase2BootstrapBundle(input: {
  verifiedPhase2Candidate: VerifiedReleaseCandidate;
  through: typeof PHASE_2_MIGRATION;
  outputPath: string;
}): MigrationBundle {
  if ((input.verifiedPhase2Candidate.migrationCount !== 13
    && input.verifiedPhase2Candidate.migrationCount !== 15)
    || input.through !== PHASE_2_MIGRATION) {
    throw new Error(`Phase-2 bootstrap must run through ${PHASE_2_MIGRATION}.`);
  }
  const migrations = input.verifiedPhase2Candidate.migrations.slice(0, 13).map((file) => basename(file.path));
  if (migrations.length !== 13 || migrations.at(-1) !== PHASE_2_MIGRATION) {
    throw new Error('Phase-2 bootstrap candidate has the wrong migration boundary.');
  }
  const chunks: Array<string | Uint8Array> = [
    'CREATE TABLE IF NOT EXISTS "d1_migrations"(\n',
    '        id INTEGER PRIMARY KEY AUTOINCREMENT,\n',
    '        name TEXT UNIQUE,\n',
    '        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL\n',
    ');\n',
  ];
  for (const [index, name] of migrations.entries()) {
    appendMigration(
      chunks,
      canonicalMigrationBytes(input.verifiedPhase2Candidate, input.verifiedPhase2Candidate.migrations[index]!),
      name,
    );
  }
  return {
    ...writeExclusiveBundle(
      input.verifiedPhase2Candidate.candidateRoot,
      input.outputPath,
      chunks,
    ),
    migrations,
  };
}

export function verifyMediaCutoverReleaseCandidateContract(
  candidate: VerifiedReleaseCandidate,
  expectedMode: MediaUploadReleaseContractV2['mode'],
): VerifiedCanonicalArtifact<MediaUploadReleaseContractV2> {
  if (candidate.migrationCount !== 15) {
    throw new Error('Media cutover runtime contracts require the exact 15-migration candidate boundary.');
  }
  const verified = verifyMediaUploadReleaseContract(
    resolve(candidate.candidateRoot, MEDIA_UPLOAD_RELEASE_CONFIG_PATH),
    expectedMode,
  );
  if (!within(realpathSync(candidate.candidateRoot), realpathSync(verified.path))) {
    throw new Error('Media cutover runtime contract escaped the exact candidate checkout.');
  }
  return verified;
}

export function buildPostCutoverMigrationBundle(input: {
  verifiedCandidate: VerifiedReleaseCandidate;
  expectedLedger: readonly string[];
  outputPath: string;
}): MigrationBundle & { migrationsHash: string } {
  if (input.verifiedCandidate.migrationCount !== 15) {
    throw new Error(`Post-cutover bundle must end at ${POST_CUTOVER_MIGRATION}.`);
  }
  const expected = input.verifiedCandidate.migrations.slice(0, 13).map((file) => basename(file.path));
  if (canonicalJson(input.expectedLedger) !== canonicalJson(expected)) {
    throw new Error('Expected staging ledger does not match the historical Phase-2 boundary.');
  }
  const files = input.verifiedCandidate.migrations.slice(13);
  const names = files.map((file) => basename(file.path));
  if (canonicalJson(names) !== canonicalJson([PHASE_3_MIGRATION, POST_CUTOVER_MIGRATION])) {
    throw new Error('Post-cutover candidate does not contain the exact 0014/0015 suffix.');
  }
  const chunks: Array<string | Uint8Array> = [];
  for (const [index, file] of files.entries()) {
    appendMigration(chunks, canonicalMigrationBytes(input.verifiedCandidate, file), names[index]!);
  }
  return {
    ...writeExclusiveBundle(input.verifiedCandidate.candidateRoot, input.outputPath, chunks),
    migrations: names,
    migrationsHash: sha256(canonicalJson(files)),
  };
}

export function buildAtomicMigrationBundle(input: {
  verifiedCandidate: VerifiedReleaseCandidate;
  expectedLedger: readonly string[];
  migration: typeof PHASE_3_MIGRATION;
  outputPath: string;
}): MigrationBundle & { migrationHash: string } {
  if (input.verifiedCandidate.migrationCount !== 14 || input.migration !== PHASE_3_MIGRATION) {
    throw new Error(`Atomic cutover bundle must contain only ${PHASE_3_MIGRATION}.`);
  }
  const expected = input.verifiedCandidate.migrations.slice(0, -1).map((file) => basename(file.path));
  if (canonicalJson(input.expectedLedger) !== canonicalJson(expected)) {
    throw new Error('Expected production ledger does not match the candidate Phase-2 ledger.');
  }
  const migration = input.verifiedCandidate.migrations.at(-1)!;
  if (!MIGRATION_NAME_PATTERN.test(basename(migration.path))
    || basename(migration.path) !== PHASE_3_MIGRATION) {
    throw new Error('Candidate does not contain the sole expected Phase-3 migration.');
  }
  const chunks: Array<string | Uint8Array> = [];
  appendMigration(
    chunks,
    canonicalMigrationBytes(input.verifiedCandidate, migration),
    PHASE_3_MIGRATION,
  );
  return {
    ...writeExclusiveBundle(input.verifiedCandidate.candidateRoot, input.outputPath, chunks),
    migrations: [PHASE_3_MIGRATION],
    migrationHash: migration.sha256,
  };
}

export function buildPostCutoverAtomicMigrationBundle(input: {
  verifiedCandidate: VerifiedReleaseCandidate;
  expectedLedger: readonly string[];
  migration: typeof POST_CUTOVER_MIGRATION;
  outputPath: string;
}): MigrationBundle & { migrationHash: string } {
  if (input.verifiedCandidate.migrationCount !== 15
    || input.migration !== POST_CUTOVER_MIGRATION) {
    throw new Error(`Post-cutover production bundle must contain only ${POST_CUTOVER_MIGRATION}.`);
  }
  const expected = input.verifiedCandidate.migrations.slice(0, -1)
    .map((file) => basename(file.path));
  if (canonicalJson(input.expectedLedger) !== canonicalJson(expected)
    || expected.at(-1) !== PHASE_3_MIGRATION) {
    throw new Error('Expected production ledger does not match the historical Phase-3 boundary.');
  }
  const migration = input.verifiedCandidate.migrations.at(-1)!;
  if (!MIGRATION_NAME_PATTERN.test(basename(migration.path))
    || basename(migration.path) !== POST_CUTOVER_MIGRATION) {
    throw new Error('Candidate does not contain the sole expected post-cutover migration.');
  }
  const chunks: Array<string | Uint8Array> = [];
  appendMigration(
    chunks,
    canonicalMigrationBytes(input.verifiedCandidate, migration),
    POST_CUTOVER_MIGRATION,
  );
  return {
    ...writeExclusiveBundle(input.verifiedCandidate.candidateRoot, input.outputPath, chunks),
    migrations: [POST_CUTOVER_MIGRATION],
    migrationHash: migration.sha256,
  };
}

/* global console, process */
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, realpath, lstat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const TASK_FILES = {
  C20b: ['tests/worker/upload-api.test.ts'],
  C20a: ['tests/worker/mobile-image-admission.test.ts'],
  C20: ['config/image-decoder-release.json', 'config/mobile-image-release.json',
    'services/image-decoder/worker/wrangler.jsonc', 'tests/unit/mobile-image-release.test.ts'],
  C19: ['tests/fixtures/mobile-images/manifest.json'],
  C18: ['scripts/mobile-image-live-workflow.mjs', 'tests/unit/mobile-image-live-workflow.test.ts'],
  C16: ['.gitignore', 'scripts/capture-mobile-image-task.mjs', 'docs/verification/mobile-image-preview-release.md',
    'docs/verification/mobile-image-compatibility.md', 'docs/verification/2026-09-26-mobile-image-handoff.md',
    'docs/superpowers/plans/2026-09-23-mobile-image-compatibility.md', 'docs/deployment.md'],
  B12h: ['services/image-decoder/native/verify_service.py', 'scripts/mobile-image-native-bridge.mjs'],
  B12: ['shared/image-decoder-contract.ts', 'services/image-decoder/native/server.py',
    'services/image-decoder/native/test_boundary.py', 'scripts/mobile-image-schema.sql',
    'migrations/0026_mobile_image_compatibility.sql', 'tests/worker/image-decoder.test.ts',
    'tests/worker/mobile-image-preview.test.ts', 'tests/fixtures/mobile-images/manifest.json',
    'tests/fixtures/mobile-images/README.md', 'docs/verification/mobile-image-compatibility.md',
    'docs/verification/mobile-image-load-rehearsal.md', 'docs/verification/mobile-image-preview-release.md',
    'docs/verification/2026-09-26-mobile-image-handoff.md', 'docs/deployment.md',
    'docs/superpowers/specs/2026-09-23-mobile-image-compatibility-design.md',
    'docs/superpowers/plans/2026-09-23-mobile-image-compatibility.md',
    'docs/superpowers/plans/2026-09-23-mobile-image-b-decoder-service.md'],
  B10: ['scripts/fetch-mobile-image-fixtures.py', 'tests/scripts/test_mobile_image_references.py',
    'tests/fixtures/mobile-images/manifest.json', 'tests/fixtures/mobile-images/sources.json',
    'tests/fixtures/mobile-images/licenses/raw-pixls-phone-records.json', 'tests/fixtures/mobile-images/README.md',
    'docs/verification/mobile-image-compatibility.md', 'docs/verification/mobile-image-load-rehearsal.md',
    'docs/verification/mobile-image-preview-release.md', 'docs/superpowers/plans/2026-09-23-mobile-image-compatibility.md'],
  C14: ['scripts/build-mobile-image-migration.mjs', 'scripts/capture-mobile-image-task.mjs',
    'scripts/lock-image-decoder.mjs', 'scripts/mobile-image-native-bridge.mjs', 'scripts/prepare-mobile-release-test.mjs',
    'scripts/record-mobile-device-evidence.mjs', 'scripts/verify-mobile-image-corpus.mjs', 'scripts/verify-mobile-image-release.mjs',
    'docs/verification/mobile-image-compatibility.md', 'docs/verification/mobile-image-preview-release.md'],
  B9: ['docs/verification/mobile-image-load-rehearsal.md', 'docs/verification/mobile-image-compatibility.md',
    'docs/verification/mobile-image-load-sources.json'],
  C13: ['docs/verification/mobile-image-preview-release.md'],
  C12:['.gitattributes', 'docs/verification/mobile-image-compatibility.md', 'docs/superpowers/plans/2026-09-23-mobile-image-compatibility.md',
    'docs/verification/mobile-image-load-rehearsal.md', 'docs/verification/mobile-image-preview-release.md', 'scripts/record-mobile-device-evidence.mjs',
    'tests/unit/mobile-device-evidence.test.ts', 'tests/unit/mobile-image-release.test.ts'],
  C11:['scripts/verify-mobile-image-release.mjs', 'tests/unit/mobile-image-release.test.ts'],
  C10:['docs/verification/mobile-image-compatibility.md', 'docs/superpowers/plans/2026-09-23-mobile-image-compatibility.md', 'docs/deployment.md',
    'tests/fixtures/mobile-images/README.md', 'docs/verification/mobile-image-preview-release.md', 'docs/verification/mobile-image-load-rehearsal.md'],
  B8e: ['tests/fixtures/mobile-images/manifest.json'],
  B8b:['services/image-decoder/native/server.py', 'services/image-decoder/native/test_boundary.py', 'services/image-decoder/native/verify_service.py',
    'services/image-decoder/native/policy.xml'],
  B8g:['.gitattributes'],
  B8:['scripts/fetch-mobile-image-fixtures.py', 'tests/fixtures/mobile-images/manifest.json', 'tests/fixtures/mobile-images/sources.json',
    'tests/fixtures/mobile-images/README.md'],
  B8a: ['tests/fixtures/mobile-images/licenses/wikimedia-commons-records.json', 'tests/fixtures/mobile-images/licenses/zenodo-records.json',
    'tests/fixtures/mobile-images/licenses/linku-avif-sample-images-LICENSE.txt', 'tests/fixtures/mobile-images/licenses/linku-avif-sample-images-README.md',
    'tests/fixtures/mobile-images/licenses/lots-of-sample-files-avif-LICENSE.2.txt', 'tests/fixtures/mobile-images/licenses/lots-of-sample-files-avif-README.md'],
  C8:['docs/verification/mobile-image-preview-release.md'],
  C9: ['scripts/verify-mobile-image-corpus.mjs', 'tests/unit/mobile-image-corpus.test.ts', 'scripts/record-mobile-device-evidence.mjs',
    'tests/unit/mobile-device-evidence.test.ts', 'docs/verification/mobile-image-device-protocol.md'],
  C6d: ['tests/worker/mobile-image-real-original.test.ts', 'tests/worker/fixtures/upload-transfer.ts', 'tests/worker/fixtures/native-decoder-bridge.ts',
    'scripts/mobile-image-native-bridge.mjs', 'scripts/mobile-image-native-bridge.d.mts', 'tests/unit/mobile-image-native-bridge.test.ts',
    'vitest.worker.config.ts', 'scripts/image-decoder-linux.ps1', 'tests/worker/mobile-image-originals.test.ts'],
  B6a: ['scripts/mobile-image-load-harness.mjs', 'scripts/mobile-image-load-adapter.mjs', 'scripts/mobile-image-load-instrumentation.mjs',
    'scripts/mobile-image-load-report.mjs', 'tests/unit/mobile-image-load-plan.test.ts', 'tests/unit/mobile-image-load-adapter.test.ts',
    'tests/unit/mobile-image-load-instrumentation.test.ts', 'scripts/verify-mobile-image-release.mjs', 'tests/unit/mobile-image-release.test.ts',
    'services/image-decoder/native/server.py', 'services/image-decoder/native/test_boundary.py', 'services/image-decoder/worker/pool.ts',
    'services/image-decoder/worker/index.ts', 'services/image-decoder/worker/wrangler.jsonc', 'services/image-decoder/worker/worker-configuration.d.ts',
    'services/image-decoder/worker/tests/pool.test.ts', 'services/image-decoder/worker/tests/topology.test.ts', 'worker/observability/image-metrics.ts',
    'worker/storage/image-source.ts', 'worker/storage/previews.ts', 'worker/routes/content.ts', 'wrangler.jsonc', 'worker-configuration.d.ts',
    'tests/unit/wrangler-environments.test.ts', 'tests/worker/mobile-image-preview.test.ts', 'tests/worker/image-metrics.test.ts',
    'config/mobile-image-load-authorization.example.json', 'docs/verification/mobile-image-load-rehearsal.md'],
  B6a2: ['worker/workflows/upload-completion.ts', 'worker/workflows/image-preview.ts', 'worker/workflows/export.ts', 'worker/routes/photo-exports.ts'],
  B4canvas: ['services/image-decoder/native/server.py', 'services/image-decoder/native/test_boundary.py', 'docs/verification/mobile-image-compatibility.md'],
  B4hdr: ['scripts/fetch-mobile-image-fixtures.py', 'tests/fixtures/mobile-images/manifest.json', 'tests/fixtures/mobile-images/sources.json', 'tests/fixtures/mobile-images/README.md', 'docs/verification/mobile-image-compatibility.md'],
  B4ar: ['services/image-decoder/native/inspect_png.py', 'services/image-decoder/native/server.py', 'services/image-decoder/native/test_boundary.py', 'services/image-decoder/native/Dockerfile', 'services/image-decoder/native/Dockerfile.dockerignore', 'services/image-decoder/native/verify_service.py', 'tests/fixtures/mobile-images/manifest.json', 'tests/fixtures/mobile-images/sources.json', 'tests/fixtures/mobile-images/README.md', 'docs/verification/mobile-image-compatibility.md'],
  B3: ['services/image-decoder/native/patch_dng.py', 'services/image-decoder/native/Dockerfile', 'services/image-decoder/native/Dockerfile.dockerignore', 'services/image-decoder/native/dependencies.lock.json', 'services/image-decoder/native/build.py', 'services/image-decoder/native/CMakeLists.txt', 'services/image-decoder/native/decode_raw.cpp', 'services/image-decoder/native/server.py', 'services/image-decoder/native/test_boundary.py', 'services/image-decoder/native/policy.xml', 'scripts/fetch-mobile-image-fixtures.py', 'tests/fixtures/mobile-images/manifest.json', 'tests/fixtures/mobile-images/sources.json', 'tests/fixtures/mobile-images/README.md', 'docs/verification/mobile-image-compatibility.md'],
  B2ce: ['scripts/verify-mobile-image-corpus.mjs', 'tests/unit/mobile-image-corpus.test.ts'],
  B2c: ['services/image-decoder/native/Dockerfile', 'services/image-decoder/native/Dockerfile.dockerignore', 'services/image-decoder/native/dependencies.lock.json', 'services/image-decoder/native/build.py', 'services/image-decoder/native/server.py', 'services/image-decoder/native/test_boundary.py', 'services/image-decoder/native/verify_service.py', 'services/image-decoder/native/policy.xml', 'scripts/lock-image-decoder.mjs', 'scripts/fetch-mobile-image-fixtures.py', 'tests/fixtures/mobile-images/manifest.json', 'tests/fixtures/mobile-images/sources.json', 'tests/fixtures/mobile-images/README.md', 'docs/verification/mobile-image-compatibility.md'],
  B2af: ['tests/fixtures/mobile-images/manifest.json', 'tests/fixtures/mobile-images/sources.json', 'tests/fixtures/mobile-images/README.md', 'scripts/fetch-mobile-image-fixtures.py', 'services/image-decoder/native/verify_service.py', 'docs/verification/mobile-image-compatibility.md'],
  B2b: ['services/image-decoder/native/Dockerfile', 'services/image-decoder/native/Dockerfile.dockerignore', 'services/image-decoder/native/dependencies.lock.json', 'services/image-decoder/native/build.py', 'services/image-decoder/native/server.py', 'services/image-decoder/native/inspect_heif.py', 'services/image-decoder/native/test_boundary.py', 'services/image-decoder/native/policy.xml', 'scripts/lock-image-decoder.mjs', 'tests/fixtures/mobile-images/manifest.json', 'tests/fixtures/mobile-images/sources.json'],
  B2al: ['scripts/image-decoder-linux.ps1', 'docs/verification/mobile-image-compatibility.md', 'services/image-decoder/native/Dockerfile', 'services/image-decoder/native/build.py', 'services/image-decoder/native/server.py', 'services/image-decoder/native/policy.xml', 'services/image-decoder/native/dependencies.lock.json', 'services/image-decoder/native/test_boundary.py', 'services/image-decoder/native/verify_service.py'],
  B4o: ['services/image-decoder/native/.gitignore','services/image-decoder/native/Dockerfile.dockerignore'],
  C7o: ['docs/operations.md'],
  B7r: ['worker/services/image-decoder.ts','tests/worker/image-decoder.test.ts','services/image-decoder/worker/pool.ts','services/image-decoder/worker/tests/pool.test.ts'],
  C7r: ['worker/workflows/upload-completion.ts','tests/worker/upload-completion.test.ts'],
  B4: ['services/image-decoder/native/server.py','services/image-decoder/native/policy.xml','services/image-decoder/native/verify_service.py','services/image-decoder/native/test_boundary.py'],
  B6: ['scripts/mobile-image-load-harness.mjs','tests/unit/mobile-image-load-plan.test.ts'],
  C7a: ['scripts/verify-mobile-image-corpus.mjs','tests/unit/mobile-image-corpus.test.ts','vite.config.ts'],
  C7: ['scripts/deploy-built.ts','tests/unit/deploy-built.test.ts','tests/unit/wrangler-environments.test.ts','wrangler.jsonc','worker-configuration.d.ts','vitest.worker.config.ts','tsconfig.e2e.json','vite.mobile-images.config.ts','playwright.mobile-images.config.ts','tests/e2e/mobile-images.spec.ts','docs/verification/mobile-image-compatibility.md','scripts/verify-mobile-image-release.mjs','tests/unit/mobile-image-release.test.ts'],
  C6c: ['worker/http/agent-markdown.ts','shared/site-content.ts','shared/errors.ts','shared/load-failure.ts','shared/mobile-image-contract.ts','src/features/uploads/manager-upload-terminal-codes.ts','src/features/uploads/resumable-upload-transport.ts','src/features/uploads/use-guest-upload-session.ts','src/features/uploads/use-manager-upload-session.ts','src/features/uploads/GuestUploadFlow.tsx','worker/services/upload-transfers.ts','tests/worker/upload-transfer-api.test.ts','tests/worker/agent-markdown.test.ts','tests/unit/mobile-image-copy.test.ts','docs/operations.md','docs/deployment.md','CLAUDE.md'],
  C6ac: ['src/features/uploads/use-upload-capabilities.ts','src/features/uploads/upload-selection.ts','tests/ui/guest-upload-flow.test.tsx'],
  C6b: ['shared/image-formats.ts','worker/workflows/export.ts','worker/routes/photo-exports.ts','worker/export/paths.ts','src/features/gallery/photo-export-device.ts','src/features/gallery/PhotoExportChooser.tsx','shared/photo-exports.ts','tests/worker/mobile-image-originals.test.ts','tests/worker/photo-export-api.test.ts','tests/worker/photo-export-archive.test.ts','tests/unit/photo-export-device.test.ts','tests/ui/photo-export-chooser.test.tsx','tests/fixtures/mobile-image-original.ts'],
  C6ab: ['worker/services/uploads.ts', 'tests/worker/mobile-image-admission.test.ts', 'src/features/uploads/upload-resume-hints.ts', 'tests/unit/upload-resume-hints.test.ts'],
  C6a: ['src/features/uploads/resumable-upload-transport.ts', 'tests/unit/resumable-upload-transport.test.ts', 'src/features/uploads/upload-selection.ts', 'src/features/uploads/upload-queue.ts', 'src/features/uploads/browser-upload-transport.ts', 'src/features/uploads/GuestUploadFlow.tsx', 'src/features/uploads/ManagerUploadDialog.tsx', 'src/features/uploads/use-guest-upload-session.ts', 'src/features/uploads/use-manager-upload-session.ts', 'src/features/uploads/use-upload-capabilities.ts', 'tests/unit/upload-selection.test.ts', 'tests/unit/upload-queue.test.ts', 'tests/unit/browser-upload-transport.test.ts', 'tests/ui/guest-upload-flow.test.tsx', 'tests/ui/manager-upload-dialog.test.tsx', 'worker/services/upload-transfers.ts', 'worker/db/upload-transfers.ts', 'worker/routes/uploads.ts', 'worker/routes/manage.ts', 'tests/worker/upload-transfer-api.test.ts', 'shared/mobile-image-contract.ts'],
  C5a: ['worker/mobile-image-release.ts'],
  C5: ['worker/storage/previews.ts', 'worker/routes/content.ts', 'worker/routes/album-preview.ts', 'worker/routes/album-share.ts', 'worker/db/media.ts', 'worker/db/image-previews.ts', 'worker/db/media-write-tombstones.ts', 'worker/workflows/image-preview.ts', 'tests/worker/mobile-image-preview.test.ts', 'worker/index.ts', 'wrangler.jsonc', 'worker-configuration.d.ts', 'worker/workflows/cleanup.ts', 'worker/workflows/upload-transfer-cleanup.ts', 'vitest.worker.config.ts', 'migrations/0026_mobile_image_compatibility.sql', 'scripts/mobile-image-schema.sql', 'tests/worker/migration-0026.test.ts', 'tests/worker/fixtures/upload-transfer.ts', 'shared/errors.ts', 'shared/load-failure.ts', 'src/features/uploads/manager-upload-terminal-codes.ts'],
  C4b: ['migrations/0026_mobile_image_compatibility.sql', 'scripts/build-mobile-image-migration.mjs', 'tests/worker/migration-0026.test.ts'],
  C4a: ['tests/worker/upload-transfer-cleanup.test.ts', 'worker/media-timeline.ts', 'worker/security/exif-capture-time.ts', 'tests/worker/media-timeline.test.ts'],
  C4: ['worker/workflows/upload-completion.ts', 'tests/worker/upload-completion.test.ts', 'tests/worker/fixtures/upload-transfer.ts', 'worker/index.ts', 'wrangler.jsonc', 'worker-configuration.d.ts', 'vitest.worker.config.ts', 'worker/db/media.ts', 'worker/db/upload-transfers.ts', 'worker/db/media-processing.ts', 'worker/db/image-previews.ts', 'worker/storage/media.ts', 'worker/storage/image-source.ts', 'worker/storage/previews.ts', 'worker/workflows/cleanup.ts', 'worker/workflows/upload-transfer-cleanup.ts', 'worker/services/upload-transfers.ts', 'worker/routes/uploads.ts', 'worker/routes/manage.ts', 'worker/mobile-image-release.ts', 'tests/unit/image-containers.test.ts', 'tests/worker/cleanup.test.ts', 'tests/worker/media-recovery-api.test.ts'],
  C3a: ['tests/worker/upload-transfer-repository.test.ts'],
  C3: ['worker/services/upload-transfers.ts', 'worker/storage/upload-parts.ts', 'worker/workflows/upload-transfer-cleanup.ts', 'tests/worker/upload-transfer-api.test.ts', 'tests/worker/upload-transfer-cleanup.test.ts', 'tests/worker/fixtures/upload-transfer.ts', 'worker/db/upload-transfers.ts', 'worker/routes/uploads.ts', 'worker/routes/manage.ts', 'worker/workflows/cleanup.ts', 'worker/db/media.ts'],
  C2: ['shared/mobile-image-contract.ts', 'config/mobile-image-release.json', 'worker/mobile-image-release.ts', 'tests/worker/mobile-image-admission.test.ts', 'worker/services/uploads.ts', 'worker/http/upload-schemas.ts', 'worker/routes/uploads.ts', 'worker/routes/manage.ts', 'worker/storage/media.ts', 'worker/db/media.ts', 'worker/db/upload-transfers.ts', 'shared/image-formats.ts', 'shared/constants.ts', 'shared/contracts.ts', 'shared/errors.ts', 'shared/load-failure.ts', 'src/features/uploads/manager-upload-terminal-codes.ts', 'vitest.worker.config.ts', 'wrangler.jsonc', 'worker-configuration.d.ts', 'services/image-decoder/worker/index.ts', 'services/image-decoder/worker/tests/topology.test.ts'],
  C1: ['migrations/0026_mobile_image_compatibility.sql', 'scripts/build-mobile-image-migration.mjs', 'scripts/mobile-image-schema.sql', 'worker/db/upload-transfers.ts', 'worker/db/media-processing.ts', 'worker/db/image-previews.ts', 'worker/db/types.ts', 'worker/db/media.ts', 'tests/worker/migration-0026.test.ts', 'tests/worker/upload-transfer-repository.test.ts', 'tests/worker/fixtures/mobile-image-db.ts', 'vitest.worker.config.ts', 'tests/worker/baseline-app.d.ts'],
  B5: ['services/image-decoder/worker/package.json', 'services/image-decoder/worker/package-lock.json', 'services/image-decoder/worker/tsconfig.json', 'services/image-decoder/worker/vitest.config.ts', 'services/image-decoder/worker/wrangler.jsonc', 'services/image-decoder/worker/index.ts', 'services/image-decoder/worker/pool.ts', 'services/image-decoder/worker/worker-configuration.d.ts', 'services/image-decoder/worker/tests/pool.test.ts', 'services/image-decoder/worker/tests/topology.test.ts', 'shared/image-decoder-release.ts'],
  B2a: ['shared/image-decoder-contract.ts', 'shared/mobile-image-cases.json', 'services/image-decoder/native/Dockerfile', 'services/image-decoder/native/dependencies.lock.json', 'services/image-decoder/native/policy.xml', 'services/image-decoder/native/server.py', 'services/image-decoder/native/build.py', 'services/image-decoder/native/verify_service.py', 'scripts/lock-image-decoder.mjs', 'config/image-decoder-release.json', 'tests/fixtures/mobile-images/manifest.json', 'scripts/verify-mobile-image-corpus.mjs', 'tests/unit/mobile-image-corpus.test.ts'],
  B1: ['shared/image-decoder-contract.ts', 'worker/services/image-decoder.ts', 'tests/unit/image-decoder-contract.test.ts', 'tests/worker/image-decoder.test.ts', 'tests/worker/fixtures/image-decoder.ts'],
  A1: ['shared/image-formats.ts', 'tests/unit/image-formats.test.ts', 'scripts/capture-mobile-image-task.mjs', 'tests/scripts/capture-mobile-image-task.test.mjs', 'shared/constants.ts', 'worker/services/uploads.ts', 'src/features/uploads/upload-selection.ts', 'tests/worker/upload-api.test.ts', 'tests/worker/agent-markdown.test.ts'],
  A2: ["worker/security/image-reader-core.ts", "worker/security/image-raster.ts", "tests/fixtures/raster-builders.ts", "tests/worker/helpers.ts", "tests/worker/upload-api.test.ts", "shared/errors.ts", "src/features/uploads/browser-upload-transport.ts", "src/features/uploads/manager-upload-terminal-codes.ts", "scripts/capture-mobile-image-task.mjs", 'worker/security/image-range-reader.ts', 'worker/storage/image-source.ts', 'tests/unit/image-range-reader.test.ts', 'tests/worker/image-source.test.ts', 'worker/security/image-metadata.ts', 'worker/security/exif-capture-time.ts', 'worker/media-timeline.ts', 'worker/storage/media.ts', 'worker/workflows/cleanup.ts', 'tests/unit/image-metadata.test.ts', 'tests/worker/exif-capture-time.test.ts', 'tests/worker/media-timeline.test.ts'],
  A3: ['worker/security/image-containers.ts', 'worker/security/image-range-reader.ts', 'worker/security/image-metadata.ts', 'worker/storage/media.ts', 'tests/unit/image-containers.test.ts', 'tests/unit/image-metadata.test.ts', 'tests/worker/upload-api.test.ts', 'tests/fixtures/image-container-builders.ts'],
  A4: ["shared/load-failure.ts", "worker/security/image-reader-core.ts", "tests/fixtures/raster-builders.ts", "tests/fixtures/image-container-builders.ts", "tests/worker/image-source.test.ts", 'src/features/uploads/upload-selection.ts', 'src/features/uploads/GuestUploadFlow.tsx', 'src/features/uploads/ManagerUploadDialog.tsx', 'src/features/uploads/use-guest-upload-session.ts', 'src/features/uploads/use-manager-upload-session.ts', 'tests/unit/upload-selection.test.ts', 'tests/unit/upload-queue.test.ts', 'tests/ui/guest-upload-flow.test.tsx', 'tests/ui/manager-upload-dialog.test.tsx', 'docs/operations.md', 'CLAUDE.md'],
};

TASK_FILES.C2.push('scripts/build-mobile-image-migration.d.mts', 'scripts/prepare-mobile-release-test.mjs', 'scripts/prepare-mobile-release-test.d.mts', 'tests/worker/mobile-image-production.d.ts');

function within(root, path) {
  const part = relative(root, path);
  if (part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) throw new Error('Snapshot path is outside the repository.');
  return path;
}

async function safePath(root, path) {
  const candidate = within(root, resolve(root, path));
  let ancestor = candidate;
  while (true) {
    try { within(root, await realpath(ancestor)); break; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      ancestor = dirname(ancestor);
    }
  }
  return candidate;
}

export async function captureSnapshot({ root = process.cwd(), plan, task, phase }) {
  if (!['A', 'B', 'C'].includes(plan) || !task.startsWith(plan) || !Object.hasOwn(TASK_FILES, task)) throw new Error('Unknown plan/task allowlist.');
  if (!['before', 'after'].includes(phase)) throw new Error('Unknown snapshot phase.');
  root = await realpath(root);
  const gitRoot = await realpath(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' }).trim());
  if (root !== gitRoot) throw new Error('Snapshot root must be the repository root.');
  const listed = new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0'));
  const parent = await safePath(root, join('output', 'verification', 'mobile-image-tasks', plan, task));
  const target = await safePath(root, join(parent, phase));
  const previous = phase === 'after' ? JSON.parse(await readFile(join(parent, 'before', 'manifest.json'), 'utf8')) : null;
  if (previous && (previous.plan !== plan || previous.task !== task || previous.phase !== 'before')) throw new Error('Snapshot identity mismatch.');
  await mkdir(parent, { recursive: true });
  await mkdir(target); // Evidence is immutable; never replace an earlier capture.
  const files = [];
  for (const path of TASK_FILES[task]) {
    const source = await safePath(root, path);
    let bytes;
    try {
      const stat = await lstat(source);
      if (!stat.isFile()) throw new Error('Only ordinary repository files may be captured.');
      if (listed.has(path)) bytes = await readFile(source);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const entry = { path, exists: bytes !== undefined };
    if (bytes) {
      entry.sha256 = createHash('sha256').update(bytes).digest('hex');
      const copy = join(target, 'files', path);
      await mkdir(dirname(copy), { recursive: true });
      await writeFile(copy, bytes);
    }
    files.push(entry);
  }
  await writeFile(join(target, 'manifest.json'), JSON.stringify({ plan, task, phase, files }, null, 2) + '\n');
  if (previous) {
    const patches = [];
    for (const entry of files) {
      const before = previous.files.find((item) => item.path === entry.path);
      if (before?.sha256 === entry.sha256 && before?.exists === entry.exists) continue;
      const oldPath = before?.exists ? join(parent, 'before', 'files', entry.path) : '/dev/null';
      const newPath = entry.exists ? join(target, 'files', entry.path) : '/dev/null';
      const diff = spawnSync('git', ['diff', '--no-index', '--binary', '--no-ext-diff', '--', oldPath, newPath], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      if (diff.error) throw diff.error;
      if (diff.status !== 0 && diff.status !== 1) throw new Error(diff.stderr || 'Snapshot diff failed.');
      patches.push(diff.stdout);
    }
    await writeFile(join(target, 'delta.patch'), patches.join(''));
  }
  return target;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const get = (name) => args[args.indexOf(`--${name}`) + 1];
  const path = await captureSnapshot({ plan: get('plan'), task: get('task'), phase: get('phase') });
  console.log(path);
}

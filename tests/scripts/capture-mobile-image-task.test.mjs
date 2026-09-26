import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, relative, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { captureSnapshot } from '../../scripts/capture-mobile-image-task.mjs';

test('captures tracked and untracked deltas without staging or including ignored secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'candidary-image-snapshot-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  try {
    git('init', '-q');
    await mkdir(join(root, 'shared'));
    await writeFile(join(root, 'shared/constants.ts'), 'before\n');
    await writeFile(join(root, '.gitignore'), '.dev.vars\noutput/\n');
    await writeFile(join(root, '.dev.vars'), 'not for evidence');
    git('add', '--', 'shared/constants.ts', '.gitignore');
    const indexBefore = git('ls-files', '--stage');
    await captureSnapshot({ root, plan: 'A', task: 'A1', phase: 'before' });
    await writeFile(join(root, 'shared/constants.ts'), 'after\n');
    await writeFile(join(root, 'shared/image-formats.ts'), 'new file\n');
    const result = await captureSnapshot({ root, plan: 'A', task: 'A1', phase: 'after' });
    assert.ok(result, 'snapshot is returned');
    const manifest = JSON.parse(await readFile(join(result, 'manifest.json'), 'utf8'));
    assert.equal(manifest.files.find((entry) => entry.path === 'shared/image-formats.ts').exists, true);
    assert.equal(manifest.files.some((entry) => entry.path === '.dev.vars'), false);
    const diff = await readFile(join(result, 'delta.patch'), 'utf8');
    assert.match(diff, /-before/);
    assert.match(diff, /\+after/);
    assert.match(diff, /\+new file/);
    assert.equal(git('ls-files', '--stage'), indexBefore);
    await assert.rejects(captureSnapshot({ root, plan: 'A', task: '../../escape', phase: 'before' }), /task|plan/i);
  } finally {
    const withinTemp = relative(resolve(tmpdir()), resolve(root));
    assert.ok(!withinTemp.startsWith(`..${sep}`) && !withinTemp.includes(sep) && withinTemp.startsWith('candidary-image-snapshot-'));
    await rm(root, { recursive: true, force: true });
  }
});

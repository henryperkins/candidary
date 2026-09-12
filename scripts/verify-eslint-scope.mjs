import assert from 'node:assert/strict';
import console from 'node:console';
import process from 'node:process';
import { ESLint } from 'eslint';

const eslint = new ESLint({ cwd: process.cwd() });

for (const filePath of [
  '.worktrees/example/src/nested.ts',
  '.superpowers/example/task.ts',
  '.grok/example/task.ts',
  '.impeccable/example/task.ts',
  '.playwright-mcp/example/task.ts',
]) {
  assert.equal(await eslint.isPathIgnored(filePath), true, `${filePath} should be ignored`);
}

for (const filePath of [
  'src/App.tsx',
  'scripts/build-cloudflare.ts',
  'tests/e2e/smoke.spec.ts',
]) {
  assert.equal(await eslint.isPathIgnored(filePath), false, `${filePath} should remain linted`);
}

console.log('ESLint scope ignores local tool directories and keeps project paths linted.');

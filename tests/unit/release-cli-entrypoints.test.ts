import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

describe('native release CLI entrypoints', () => {
  it.each([
    {
      name: 'deploy',
      nodeFlag: '--experimental-strip-types',
      script: 'scripts/deploy-release.ts',
      expected: 'Missing value for --help.',
    },
    {
      name: 'production bridge',
      nodeFlag: '--experimental-strip-types',
      script: 'scripts/bridge-release.ts',
      expected: 'Unknown or duplicate bridge release argument --help.',
    },
    {
      name: 'production migration',
      nodeFlag: '--experimental-strip-types',
      script: 'scripts/migrate-release.ts',
      expected: 'Unknown or duplicate production migration argument --help.',
    },
    {
      name: 'staging release',
      nodeFlag: '--experimental-transform-types',
      script: 'scripts/staging-release.ts',
      expected: 'Staging CLI mode is missing or unknown for this command parser.',
    },
  ])('$name reaches its argument validator under native Node ESM', ({ nodeFlag, script, expected }) => {
    const result = spawnSync(process.execPath, [
      nodeFlag,
      resolve(ROOT, script),
      '--help',
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
      shell: false,
    });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(output).toContain(expected);
    expect(output).not.toContain('ERR_MODULE_NOT_FOUND');
    expect(output).not.toContain('Cannot find module');
  });
});

import { describe, expect, it } from 'vitest';

import { runCiLocal, type CiLocalDependencies } from '../../scripts/ci-local';

const BASE = '1111111111111111111111111111111111111111';
const HEAD = '2222222222222222222222222222222222222222';

function harness(options: {
  failures?: ReadonlySet<string>;
  headValues?: string[];
  statusValues?: string[];
} = {}) {
  const commands: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const output: string[] = [];
  const headValues = [...(options.headValues ?? [HEAD])];
  const statusValues = [...(options.statusValues ?? [''])];
  const dependencies: CiLocalDependencies = {
    git(args) {
      if (args[0] === 'rev-parse' && args[1] === '--verify') return BASE;
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return headValues.shift() ?? HEAD;
      if (args[0] === 'status') return statusValues.shift() ?? '';
      throw new Error(`Unexpected git call: ${args.join(' ')}`);
    },
    run(command, args, environment) {
      commands.push({ command, args: [...args], env: environment });
      const key = [command, ...args].join(' ');
      return { status: options.failures?.has(key) ? 1 : 0 };
    },
    write(line) {
      output.push(line);
    },
  };
  return { commands, dependencies, output };
}

describe('local release checks', () => {
  it('runs every command once and reports all six passing lanes', () => {
    const { commands, dependencies, output } = harness();

    const result = runCiLocal({ base: 'origin/main', head: HEAD }, dependencies);

    expect(result).toBe(0);
    expect(commands.map(({ command, args }) => [command, ...args].join(' '))).toEqual([
      'npm audit --omit=dev',
      'npm run verify:bindings',
      'npm run typecheck:e2e',
      'npm run lint',
      'npm run test:unit',
      'npm run test:worker',
      'npm run build:cloudflare',
      'npm run verify:pwa-build',
      'npx wrangler deploy --dry-run --strict --config dist/candidary/wrangler.json --outdir output/wrangler-dry-run',
      'npm run test:smoke',
      'npm run ci:migrations',
    ]);
    expect(output).toContain(`Base SHA: ${BASE}`);
    expect(output).toContain(`Head SHA: ${HEAD}`);
    expect(output.slice(-7)).toEqual([
      'Quality: PASS', 'Unit and UI: PASS', 'Worker: PASS', 'Build: PASS',
      'Smoke: PASS', 'Migration safety: PASS', 'Overall exit code: 0',
    ]);
  });

  it('cannot turn a failed command into a successful lane or overall result', () => {
    const { dependencies, output } = harness({ failures: new Set(['npm run lint']) });

    expect(runCiLocal({ base: BASE, head: HEAD }, dependencies)).toBe(1);
    expect(output).toContain('Quality: FAIL');
    expect(output).toContain('Overall exit code: 1');
  });

  it('skips Smoke when Build fails but continues Migration safety', () => {
    const { commands, dependencies, output } = harness({
      failures: new Set(['npm run verify:pwa-build']),
    });

    expect(runCiLocal({ base: BASE, head: HEAD }, dependencies)).toBe(1);
    expect(commands.some(({ args }) => args.includes('test:smoke'))).toBe(false);
    expect(commands.some(({ args }) => args.includes('ci:migrations'))).toBe(true);
    expect(output).toContain('Smoke: SKIPPED (Build failed)');
  });

  it('passes the resolved exact SHAs to Migration safety', () => {
    const { commands, dependencies } = harness();

    runCiLocal({ base: 'origin/main', head: HEAD }, dependencies);

    const migration = commands.find(({ args }) => args.includes('ci:migrations'));
    expect(migration?.env?.CI_BASE_SHA).toBe(BASE);
    expect(migration?.env?.CI_HEAD_SHA).toBe(HEAD);
  });

  it('rejects a requested head that is not checked out', () => {
    const { commands, dependencies, output } = harness();

    expect(runCiLocal({ base: BASE, head: BASE }, dependencies)).toBe(1);
    expect(commands).toHaveLength(0);
    expect(output.at(-1)).toBe(`ERROR: Requested head ${BASE} does not equal checked-out HEAD ${HEAD}.`);
  });

  it('rejects tracked edits before running commands', () => {
    const { commands, dependencies, output } = harness({ statusValues: [' M package.json'] });

    expect(runCiLocal({ base: BASE, head: HEAD }, dependencies)).toBe(1);
    expect(commands).toHaveLength(0);
    expect(output.at(-1)).toBe('ERROR: Tracked files must be clean before local CI starts.');
  });

  it('invalidates the run when tracked files change after a command', () => {
    const { commands, dependencies, output } = harness({ statusValues: ['', ' M src/App.tsx'] });

    expect(runCiLocal({ base: BASE, head: HEAD }, dependencies)).toBe(1);
    expect(commands).toHaveLength(1);
    expect(output).toContain('Quality: FAIL');
    expect(output).toContain('Overall exit code: 1');
  });
});

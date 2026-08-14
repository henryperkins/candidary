import { describe, expect, it } from 'vitest';

import {
  FRESH_D1_RUN_PREFIX,
  requiresMigrationCheck,
} from '../../scripts/ci-migration-check';

describe('conditional migration verification', () => {
  it('uses the safe run-root prefix accepted by the retained Fresh-D1 verifier', () => {
    expect(FRESH_D1_RUN_PREFIX).toMatch(/^candidary-release-.+/u);
  });

  it('skips ordinary application and documentation changes', () => {
    expect(requiresMigrationCheck([
      'src/app/router.tsx',
      'src/styles.css',
      'README.md',
      'tests/ui/app.test.tsx',
    ])).toBe(false);
  });

  it.each([
    'migrations/0016_example.sql',
    'wrangler.jsonc',
    'scripts/verify-fresh-d1.ts',
    'scripts/migration-manifest.ts',
  ])('runs when migration safety can change: %s', (path) => {
    expect(requiresMigrationCheck([path])).toBe(true);
  });

  it('normalizes Windows separators from local CI reproduction', () => {
    expect(requiresMigrationCheck(['migrations\\0016_example.sql'])).toBe(true);
  });
});

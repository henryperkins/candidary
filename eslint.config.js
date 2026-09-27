import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      '.wrangler/**',
      'output/**',
      'worker-configuration.d.ts',
      'services/image-decoder/worker/worker-configuration.d.ts',
      '.worktrees/**',
      '.superpowers/**',
      '.grok/**',
      '.impeccable/**',
      '.playwright-mcp/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'off'
    },
  },
  {
    files: ['tests/worker/baseline-app.d.ts', 'tests/worker/mobile-image-production.d.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { disallowTypeAnnotations: false }],
    },
  },
);

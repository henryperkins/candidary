import { defineConfig } from 'vitest/config';

// No Workers test pool or Container runtime. Pure routing tests inject fake stubs.
export default defineConfig({ test: { environment: 'node', include: ['tests/**/*.test.ts'], maxWorkers: 2 } });

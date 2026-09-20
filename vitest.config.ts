import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['tests/unit/**/*.test.ts', 'tests/ui/**/*.test.ts?(x)'],
    restoreMocks: true,
    // The App and Album UI files render large React trees. Keeping two files in
    // flight preserves parallelism without starving navigation effects in
    // smaller jsdom suites on shared CI hosts.
    maxWorkers: 2,
  },
});


import '@testing-library/jest-dom/vitest';
import { beforeEach, vi } from 'vitest';

// The shared UI fixtures describe a September 2026 event. Keep the test clock
// before that event so lifecycle and export assertions do not change with the
// wall clock. Individual tests can still move the clock to a boundary they own.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-08-20T12:00:00.000Z'));
});


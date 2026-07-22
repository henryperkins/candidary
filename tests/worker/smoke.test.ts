import { describe, expect, it } from 'vitest';

import worker, { ExportWorkflow } from '../../worker/index';

describe('Worker entrypoint', () => {
  it('exports the fetch handler and export workflow', () => {
    expect(worker.fetch).toBeTypeOf('function');
    expect(ExportWorkflow).toBeTypeOf('function');
  });
});


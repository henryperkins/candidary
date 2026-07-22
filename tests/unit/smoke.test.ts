import { describe, expect, it } from 'vitest';

import { createAppRouter } from '../../src/app/router';

describe('application entrypoints', () => {
  it('creates the React router', () => {
    expect(createAppRouter(['/'])).toBeDefined();
  });
});

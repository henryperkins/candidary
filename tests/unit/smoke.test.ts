import { describe, expect, it } from 'vitest';

import { createAppRouter } from '../../src/app/router';
import { createApp } from '../../worker/app';

describe('application entrypoints', () => {
  it('creates the React router', () => {
    expect(createAppRouter(['/'])).toBeDefined();
  });

  it('creates the Worker app', () => {
    expect(createApp()).toBeDefined();
  });
});


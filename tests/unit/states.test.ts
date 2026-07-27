import { describe, expect, it } from 'vitest';

import { classifyApiErrorCode } from '../../src/components/States';

describe('load failure classification', () => {
  it.each([
    ['SESSION_REQUIRED', 'latest-link'],
    ['ROLE_FORBIDDEN', 'latest-link'],
    ['EVENT_NOT_FOUND', 'ended-event'],
    ['EVENT_EXPIRED', 'ended-event'],
    ['UPLOADS_DISABLED', 'retry'],
    ['VALIDATION_FAILED', 'retry'],
    ['INTERNAL_ERROR', 'retry'],
  ] as const)('classifies %s as %s', (code, expected) => {
    expect(classifyApiErrorCode(code)).toBe(expected);
  });
});

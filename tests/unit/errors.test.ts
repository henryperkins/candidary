import { describe, expect, it } from 'vitest';

import { ApiError, toErrorResponse } from '../../shared/errors';

describe('stable API errors', () => {
  it('serializes known errors without leaking internal data', () => {
    const error = new ApiError('FILE_TOO_LARGE', 'Choose an image smaller than 10 MB.', 413, {
      file: 'Too large',
    });

    expect(toErrorResponse(error, 'req_123')).toEqual({
      status: 413,
      body: {
        code: 'FILE_TOO_LARGE',
        message: 'Choose an image smaller than 10 MB.',
        fieldErrors: { file: 'Too large' },
        requestId: 'req_123',
      },
    });
  });

  it('maps unknown errors to a safe retry response', () => {
    expect(toErrorResponse(new Error('database password leaked'), 'req_456')).toEqual({
      status: 500,
      body: {
        code: 'INTERNAL_ERROR',
        message: 'Something went wrong. Try again and keep this request ID if the problem continues.',
        requestId: 'req_456',
      },
    });
  });
});


import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  type RsvpRosterBatchConflictDetails,
  toErrorResponse,
} from '../../shared/errors';
import { api, ClientApiError } from '../../src/app/api';

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  describe('client API errors', () => {
    it('carries roster conflict details through the browser transport', async () => {
      const details: RsvpRosterBatchConflictDetails = {
        currentRosterVersion: 13,
        targets: [{
          clientHouseholdId: '4bca1477-d727-4af0-a719-46493d2d5479',
          householdId: 'b8b0cf5b-a2cd-4d03-a9fa-63a4c34a1585',
          currentHouseholdVersion: 4,
          state: 'changed',
        }],
      };
      vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({
        code: 'RSVP_ROSTER_BATCH_CONFLICT',
        message: 'The guest list changed.',
        details,
        requestId: 'req_client',
      }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      }))));

      const caught = await api('/api/manage/events/event-a/rsvp/roster/commit')
        .catch((error: unknown) => error);
      expect(caught).toBeInstanceOf(ClientApiError);
      expect(caught).toMatchObject({
        code: 'RSVP_ROSTER_BATCH_CONFLICT',
        message: 'The guest list changed.',
        details,
      });
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

  it('preserves typed roster batch conflict details', () => {
    const details: RsvpRosterBatchConflictDetails = {
      currentRosterVersion: 12,
      targets: [{
        clientHouseholdId: '4bca1477-d727-4af0-a719-46493d2d5479',
        householdId: 'b8b0cf5b-a2cd-4d03-a9fa-63a4c34a1585',
        currentHouseholdVersion: null,
        state: 'archived',
      }],
    };

    expect(toErrorResponse(new ApiError(
      'RSVP_ROSTER_BATCH_CONFLICT',
      'The guest list changed. Review the affected invitations and preview again.',
      409,
      undefined,
      details,
    ), 'req_conflict')).toEqual({
      status: 409,
      body: {
        code: 'RSVP_ROSTER_BATCH_CONFLICT',
        message: 'The guest list changed. Review the affected invitations and preview again.',
        details,
        requestId: 'req_conflict',
      },
    });
  });
});

import { describe, expect, it } from 'vitest';

import type { EventView } from '../../shared/contracts';
import type { ApiErrorCode } from '../../shared/errors';
import { classifyApiErrorCode } from '../../shared/load-failure';
import type { LoadFailure } from '../../src/components/States';
import { resolveHostUploadAvailability } from '../../src/features/uploads/host-upload-availability';

type Availability = EventView['hostUploadAvailability'];

function failureFor(code: ApiErrorCode): LoadFailure {
  const kind = classifyApiErrorCode(code);
  return {
    kind,
    message: code,
    recoveryHint: 'Recover.',
    retryable: kind === 'retry',
    offerSignIn: false,
  };
}

describe('resolveHostUploadAvailability', () => {
  it.each([
    { enabled: true, reason: null },
    { enabled: false, reason: 'media-cap' },
    { enabled: false, reason: 'storage-cap' },
  ] as const)('passes through the projected $reason availability without a failure', (projected) => {
    expect(resolveHostUploadAvailability(projected, null)).toBe(projected);
  });

  it('turns an expired stale-tab projection into event-unavailable', () => {
    expect(resolveHostUploadAvailability(
      { enabled: true, reason: null },
      failureFor('EVENT_EXPIRED'),
    )).toEqual({ enabled: false, reason: 'event-unavailable' });
  });

  it.each(['EVENT_DELETED', 'EVENT_NOT_FOUND'] as const)(
    'uses the shared classification for %s',
    (code) => {
      expect(resolveHostUploadAvailability(
        { enabled: true, reason: null },
        failureFor(code),
      )).toEqual({ enabled: false, reason: 'event-unavailable' });
    },
  );

  it('lets an ended-event failure outrank the projected media cap', () => {
    expect(resolveHostUploadAvailability(
      { enabled: false, reason: 'media-cap' },
      failureFor('EVENT_EXPIRED'),
    )).toEqual({ enabled: false, reason: 'event-unavailable' });
  });

  it.each(['INTERNAL_ERROR', 'HOST_SESSION_REQUIRED', 'SESSION_EXPIRED'] as const)(
    'leaves the last-read projection unchanged for %s',
    (code) => {
      const projected: Availability = { enabled: true, reason: null };
      expect(resolveHostUploadAvailability(projected, failureFor(code))).toBe(projected);
    },
  );

  it('is deterministic and does not mutate the projection', () => {
    const projected = Object.freeze<Availability>({ enabled: false, reason: 'storage-cap' });
    const failure = failureFor('EVENT_DELETED');

    expect(resolveHostUploadAvailability(projected, failure)).toEqual(
      resolveHostUploadAvailability(projected, failure),
    );
    expect(projected).toEqual({ enabled: false, reason: 'storage-cap' });
  });
});

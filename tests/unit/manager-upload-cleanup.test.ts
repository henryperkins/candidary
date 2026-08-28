import { describe, expect, it, vi } from 'vitest';

import { UPLOAD_BATCH_SIZE } from '../../shared/constants';
import { ClientApiError } from '../../src/app/api';
import {
  createManagerUploadCleanup,
  type CleanupDeps,
  type CleanupItem,
  type ReservationDisposition,
} from '../../src/features/uploads/manager-upload-cleanup';
import type {
  ReservationResult,
  UploadFailure,
  UploadQueueItem,
  UploadReservation,
} from '../../src/features/uploads/upload-queue';
import { MANAGER_UPLOAD_RESOURCE_FORBIDDEN_ERROR } from '../fixtures/manager-upload-errors';

const reservation: UploadReservation = {
  mediaId: 'media-a',
  uploadUrl: '/api/manage/events/event-a/uploads/media-a/content',
  mimeType: 'image/jpeg',
};

function queueItem(id: string, failure?: UploadFailure): UploadQueueItem {
  return {
    id,
    file: new File(['photo'], `${id}.jpg`, { type: 'image/jpeg' }),
    state: failure ? 'failed' : 'selected',
    progress: 0,
    isNewCapture: false,
    ...(failure ? { error: 'This upload is no longer available.', failure } : {}),
  };
}

function cleanupItem(
  id: string,
  disposition: ReservationDisposition,
  options: { reservation?: UploadReservation | null; failure?: UploadFailure } = {},
): CleanupItem {
  return {
    itemId: id,
    idempotencyKey: `key-${id}`,
    queueItem: queueItem(id, options.failure),
    reservation: options.reservation === undefined
      ? (disposition === 'reserved' || disposition === 'delivered' ? reservation : null)
      : options.reservation,
    disposition,
  };
}

function apiError(code: ConstructorParameters<typeof ClientApiError>[0], status = 403) {
  return new ClientApiError(code, 'This upload is no longer available.', undefined, undefined, status, 'request-a');
}

function deps(overrides: Partial<CleanupDeps> = {}): CleanupDeps {
  return {
    reserve: vi.fn(async (item): Promise<ReservationResult> => ({
      id: item.idempotencyKey,
      status: 'accepted',
      reservation,
    })),
    cancel: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('Manager upload cleanup', () => {
  it('ignores non-actionable and stored items, and cancels only a reserved item', async () => {
    const operations = deps();
    const result = await createManagerUploadCleanup(operations).run([
      cleanupItem('unattempted', 'unattempted'),
      cleanupItem('known-absent', 'known-absent'),
      cleanupItem('delivered', 'delivered', {
        reservation: { ...reservation, mediaId: 'media-delivered' },
      }),
      cleanupItem('canceled', 'canceled'),
      cleanupItem('reserved', 'reserved'),
    ]);

    expect(result).toEqual({ kind: 'settled', deliveredIds: ['media-delivered'] });
    expect(operations.reserve).not.toHaveBeenCalled();
    expect(operations.cancel).toHaveBeenCalledTimes(1);
    expect(operations.cancel).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: 'reserved' }),
      reservation,
    );
  });

  it('replays ambiguous reservations and settles delivered, canceled, and fresh reserved answers', async () => {
    const results: ReservationResult[] = [
      { id: 'key-delivered', status: 'delivered', mediaId: 'media-delivered' },
      { id: 'key-canceled', status: 'canceled' },
      { id: 'key-reserved', status: 'accepted', reservation: { ...reservation, mediaId: 'media-fresh' } },
    ];
    const operations = deps({ reserve: vi.fn(async () => results.shift()!) });

    const result = await createManagerUploadCleanup(operations).run([
      cleanupItem('delivered', 'ambiguous'),
      cleanupItem('canceled', 'ambiguous'),
      cleanupItem('reserved', 'ambiguous'),
    ]);

    expect(result).toEqual({ kind: 'settled', deliveredIds: ['media-delivered'] });
    expect(operations.reserve).toHaveBeenCalledTimes(3);
    expect(operations.cancel).toHaveBeenCalledOnce();
    expect(operations.cancel).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: 'reserved' }),
      expect.objectContaining({ mediaId: 'media-fresh' }),
    );
  });

  it('settles a nonterminal rejected replay because it proves an ambiguous item absent', async () => {
    const operations = deps({
      reserve: vi.fn(async (item) => ({
        id: item.idempotencyKey,
        status: 'rejected',
        error: 'The event has reached its photo limit.',
        failure: { code: 'EVENT_MEDIA_LIMIT', status: 409, stage: 'reserve' },
      })),
    });

    const result = await createManagerUploadCleanup(operations)
      .run([cleanupItem('known-absent-after-replay', 'ambiguous')]);

    expect(result).toEqual({ kind: 'settled', deliveredIds: [] });
    expect(operations.reserve).toHaveBeenCalledOnce();
    expect(operations.cancel).not.toHaveBeenCalled();
  });

  it('replays after a finalize conflict and records the finalize winner', async () => {
    const order: string[] = [];
    const operations = deps({
      cancel: vi.fn(async () => {
        order.push('cancel');
        throw apiError('UPLOAD_FINALIZE_CONFLICT', 409);
      }),
      reserve: vi.fn(async (item) => {
        order.push('reserve');
        return { id: item.idempotencyKey, status: 'delivered', mediaId: 'media-winner' };
      }),
    });

    const result = await createManagerUploadCleanup(operations)
      .run([cleanupItem('race', 'reserved')]);

    expect(result).toEqual({ kind: 'settled', deliveredIds: ['media-winner'] });
    expect(order).toEqual(['cancel', 'reserve']);
  });

  it('settles a lost DELETE response when replay says the reservation is canceled', async () => {
    const operations = deps({
      cancel: vi.fn(async () => {
        throw new Error('Reception dropped out.');
      }),
      reserve: vi.fn(async (item) => ({ id: item.idempotencyKey, status: 'canceled' })),
    });

    const result = await createManagerUploadCleanup(operations)
      .run([cleanupItem('lost-delete', 'reserved')]);

    expect(result).toEqual({ kind: 'settled', deliveredIds: [] });
    expect(operations.cancel).toHaveBeenCalledOnce();
    expect(operations.reserve).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: 'still reserved',
      replay: { id: 'key-race', status: 'accepted', reservation } as ReservationResult,
    },
    {
      label: 'failed refresh',
      replay: {
        id: 'key-race',
        status: 'rejected',
        error: 'This photo could not be refreshed.',
      } as ReservationResult,
    },
  ])('retries cancel once when a lost DELETE replay is $label', async ({ replay }) => {
    const cancel = vi.fn()
      .mockRejectedValueOnce(new Error('Reception dropped out.'))
      .mockResolvedValueOnce(undefined);
    const operations = deps({ cancel, reserve: vi.fn(async () => replay) });

    const result = await createManagerUploadCleanup(operations)
      .run([cleanupItem('race', 'reserved')]);

    expect(result).toEqual({ kind: 'settled', deliveredIds: [] });
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it('aggregates retryable failures and delivered IDs with an exact unresolved count', async () => {
    const operations = deps({
      reserve: vi.fn(async () => {
        throw new Error('Reception dropped out.');
      }),
    });

    const result = await createManagerUploadCleanup(operations).run([
      cleanupItem('delivered', 'delivered', {
        reservation: { ...reservation, mediaId: 'media-delivered' },
      }),
      cleanupItem('ambiguous-a', 'ambiguous'),
      cleanupItem('ambiguous-b', 'ambiguous'),
    ]);

    expect(result).toEqual({
      kind: 'retry',
      unresolvedCount: 2,
      deliveredIds: ['media-delivered'],
    });
  });

  it.each([
    ['TOKEN_REVOKED', 'authorization'],
    ['ACCOUNT_DISABLED', 'authorization'],
    ['ROLE_FORBIDDEN', 'authorization'],
    ['RESOURCE_FORBIDDEN', 'authorization'],
    ['EVENT_EXPIRED', 'lifecycle'],
    ['EVENT_DELETED', 'lifecycle'],
  ] as const)('classifies %s as a terminal %s failure and stops work', async (code, reason) => {
    const operations = deps();
    const result = await createManagerUploadCleanup(operations).run([
      cleanupItem('terminal', 'reserved', {
        failure: { code, status: code.startsWith('EVENT_') ? 410 : 403, stage: 'upload' },
      }),
      cleanupItem('later', 'reserved'),
    ]);

    expect(result).toEqual({
      kind: 'terminal',
      reason,
      unresolvedCount: 2,
      deliveredIds: [],
    });
    expect(operations.reserve).not.toHaveBeenCalled();
    expect(operations.cancel).not.toHaveBeenCalled();
  });

  it('distinguishes the shared typed authority refusal from identical untyped copy', async () => {
    const typed = deps({
      reserve: vi.fn(async () => {
        throw new ClientApiError(
          MANAGER_UPLOAD_RESOURCE_FORBIDDEN_ERROR.code,
          MANAGER_UPLOAD_RESOURCE_FORBIDDEN_ERROR.message,
          undefined,
          undefined,
          403,
          MANAGER_UPLOAD_RESOURCE_FORBIDDEN_ERROR.requestId,
        );
      }),
    });
    const untyped = deps({
      reserve: vi.fn(async () => {
        throw new Error(MANAGER_UPLOAD_RESOURCE_FORBIDDEN_ERROR.message);
      }),
    });

    await expect(createManagerUploadCleanup(typed).run([cleanupItem('typed', 'ambiguous')]))
      .resolves.toEqual({
        kind: 'terminal',
        reason: 'authorization',
        unresolvedCount: 1,
        deliveredIds: [],
      });
    await expect(createManagerUploadCleanup(untyped).run([cleanupItem('untyped', 'ambiguous')]))
      .resolves.toEqual({ kind: 'retry', unresolvedCount: 1, deliveredIds: [] });
  });

  it('preflights terminal failure and all delivered IDs before issuing cleanup work', async () => {
    const operations = deps();
    const result = await createManagerUploadCleanup(operations).run([
      cleanupItem('actionable-before-terminal', 'reserved'),
      cleanupItem('terminal', 'ambiguous', {
        failure: { code: 'RESOURCE_FORBIDDEN', status: 403, stage: 'reserve' },
      }),
      cleanupItem('delivered-after-terminal', 'delivered', {
        reservation: { ...reservation, mediaId: 'media-already-delivered' },
      }),
    ]);

    expect(result).toEqual({
      kind: 'terminal',
      reason: 'authorization',
      unresolvedCount: 2,
      deliveredIds: ['media-already-delivered'],
    });
    expect(operations.reserve).not.toHaveBeenCalled();
    expect(operations.cancel).not.toHaveBeenCalled();
  });

  it('stops issuing requests after abort and reports only remaining attempted work', async () => {
    const controller = new AbortController();
    const operations = deps({
      cancel: vi.fn(async () => {
        controller.abort();
      }),
    });

    const result = await createManagerUploadCleanup(operations).run([
      cleanupItem('first', 'reserved'),
      cleanupItem('second', 'reserved'),
    ], controller.signal);

    expect(result).toEqual({ kind: 'retry', unresolvedCount: 1, deliveredIds: [] });
    expect(operations.cancel).toHaveBeenCalledOnce();
  });

  it('cleans completed chunks, replays every attempted ambiguous item, and ignores undispatched items', async () => {
    const firstChunk = Array.from(
      { length: UPLOAD_BATCH_SIZE },
      (_, index) => cleanupItem(`reserved-${index}`, 'reserved'),
    );
    const attemptedSecondChunk = Array.from(
      { length: UPLOAD_BATCH_SIZE },
      (_, index) => cleanupItem(`ambiguous-${index}`, 'ambiguous'),
    );
    const undispatched = Array.from(
      { length: 3 },
      (_, index) => cleanupItem(`unattempted-${index}`, 'unattempted'),
    );
    const operations = deps({
      reserve: vi.fn(async (item) => ({ id: item.idempotencyKey, status: 'canceled' })),
    });

    const result = await createManagerUploadCleanup(operations)
      .run([...firstChunk, ...attemptedSecondChunk, ...undispatched]);

    expect(result).toEqual({ kind: 'settled', deliveredIds: [] });
    expect(operations.cancel).toHaveBeenCalledTimes(UPLOAD_BATCH_SIZE);
    expect(operations.reserve).toHaveBeenCalledTimes(UPLOAD_BATCH_SIZE);
  });

  it('lets terminal win over earlier retry work and retains delivered IDs observed first', async () => {
    const reserve = vi.fn()
      .mockRejectedValueOnce(new Error('Reception dropped out.'))
      .mockResolvedValueOnce({ id: 'key-delivered', status: 'delivered', mediaId: 'media-delivered' });
    const cancel = vi.fn(async () => {
      throw apiError('RESOURCE_FORBIDDEN');
    });
    const operations = deps({ reserve, cancel });

    const result = await createManagerUploadCleanup(operations).run([
      cleanupItem('retry', 'ambiguous'),
      cleanupItem('delivered', 'ambiguous'),
      cleanupItem('terminal', 'reserved'),
      cleanupItem('never-started', 'reserved'),
    ]);

    expect(result).toEqual({
      kind: 'terminal',
      reason: 'authorization',
      unresolvedCount: 3,
      deliveredIds: ['media-delivered'],
    });
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledOnce();
  });
});

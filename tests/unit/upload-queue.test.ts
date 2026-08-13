import { describe, expect, it, vi } from 'vitest';

import {
  getReceiptCount,
  removeQueueItem,
  runUploadQueue,
  type UploadQueueItem,
  type UploadTransport,
} from '../../src/features/uploads/upload-queue';

function item(id: string): UploadQueueItem {
  return {
    id,
    file: new File([id], `${id}.jpg`, { type: 'image/jpeg' }),
    state: 'selected',
    progress: 0,
    isNewCapture: false,
  };
}

const CANCELLED = 'Sending was cancelled. Retry when you are ready.';

function untilAborted(signal?: AbortSignal): Promise<void> {
  return new Promise<void>((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new DOMException('Sending was cancelled.', 'AbortError')), { once: true });
  });
}

function acceptingTransport(overrides: Partial<UploadTransport> = {}): UploadTransport {
  return {
    reserve: async (items) => items.map(({ id }) => ({
      id,
      status: 'accepted' as const,
      reservation: { mediaId: `media-${id}`, uploadUrl: `https://upload.test/${id}`, mimeType: 'image/jpeg' },
    })),
    upload: async (_item, _reservation, progress) => progress(100),
    finalize: async () => undefined,
    ...overrides,
  };
}

describe('photo upload queue', () => {
  it('transfers at most two photos concurrently and reports every lifecycle state', async () => {
    let active = 0;
    let maximum = 0;
    const seenStates = new Set<string>();
    const transport = acceptingTransport({
      upload: async (_item, _reservation, progress) => {
        active += 1;
        maximum = Math.max(maximum, active);
        progress(50);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
      },
    });

    const result = await runUploadQueue(
      [item('a'), item('b'), item('c'), item('d')],
      transport,
      { concurrency: 2, onChange: (items) => items.forEach(({ state }) => seenStates.add(state)) },
    );

    expect(maximum).toBe(2);
    expect(result.map(({ state }) => state)).toEqual(['delivered', 'delivered', 'delivered', 'delivered']);
    expect(seenStates).toEqual(new Set(['reserving', 'queued', 'uploading', 'finalizing', 'delivered']));
    expect(getReceiptCount(result)).toBe(4);
  });

  it('keeps accepted siblings delivered while a rejected photo remains removable', async () => {
    const transport = acceptingTransport({
      reserve: async (items) => items.map(({ id }, index) => index === 0
        ? { id, status: 'accepted' as const, reservation: { mediaId: 'media-a', uploadUrl: 'https://upload.test/a', mimeType: 'image/jpeg' } }
        : { id, status: 'rejected' as const, error: 'The event has reached its photo limit.' }),
    });

    const result = await runUploadQueue([item('a'), item('b')], transport);
    expect(result.map(({ state }) => state)).toEqual(['delivered', 'failed']);
    expect(getReceiptCount(result)).toBeNull();

    const resolved = removeQueueItem(result, 'b');
    expect(getReceiptCount(resolved)).toBe(1);
  });

  it('marks an idempotently replayed stored reservation delivered without uploading or finalizing it again', async () => {
    const transport = acceptingTransport({
      reserve: async ([queued]) => [{ id: queued!.id, status: 'delivered' as const }],
    });
    const upload = vi.spyOn(transport, 'upload');
    const finalize = vi.spyOn(transport, 'finalize');

    const result = await runUploadQueue([item('already-stored')], transport);

    expect(result[0]).toMatchObject({ state: 'delivered', progress: 100 });
    expect(upload).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
  });

  it('counts delivered photos when validation failures remain', () => {
    const delivered = { ...item('sent'), state: 'delivered' as const };
    const invalid = {
      ...item('invalid'),
      state: 'failed' as const,
      validationError: true,
      error: 'Choose a supported photo.',
    };
    expect(getReceiptCount([delivered, invalid])).toBe(1);
    expect(getReceiptCount([invalid])).toBeNull();
  });

  it('keeps a transfer failure from producing a receipt', () => {
    const delivered = { ...item('sent'), state: 'delivered' as const };
    const failed = { ...item('failed'), state: 'failed' as const, error: 'Reception dropped out.' };
    expect(getReceiptCount([delivered, failed])).toBeNull();
  });

  it('retries only the failed photo with the same stable id', async () => {
    let attempts = 0;
    const transport = acceptingTransport({
      upload: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('Reception dropped out.');
      },
    });
    const failed = await runUploadQueue([item('same-id')], transport);
    expect(failed[0]).toMatchObject({ id: 'same-id', state: 'failed', error: 'Reception dropped out.' });

    const delivered = await runUploadQueue(failed, transport);
    expect(delivered[0]).toMatchObject({ id: 'same-id', state: 'delivered' });
    expect(attempts).toBe(2);
  });

  it('retries a failed finalization without uploading the original again', async () => {
    let finalizeAttempts = 0;
    const queueTransport = acceptingTransport({
      finalize: async () => {
        finalizeAttempts += 1;
        if (finalizeAttempts === 1) throw new Error('Confirmation timed out.');
      },
    });
    const reserve = vi.spyOn(queueTransport, 'reserve');
    const upload = vi.spyOn(queueTransport, 'upload');

    const failed = await runUploadQueue([item('confirm-once')], queueTransport);
    expect(failed[0]).toMatchObject({ state: 'failed', retryStage: 'finalize' });
    const delivered = await runUploadQueue(failed, queueTransport);

    expect(delivered[0]).toMatchObject({ state: 'delivered' });
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(finalizeAttempts).toBe(2);
  });

  it('never creates a receipt when every photo is removed before delivery', () => {
    expect(getReceiptCount(removeQueueItem([item('a')], 'a'))).toBeNull();
  });

  it('cancels undelivered photos into recoverable failures', async () => {
    const controller = new AbortController();
    const transport = acceptingTransport({ upload: (_item, _reservation, _progress, signal) => untilAborted(signal) });

    const promise = runUploadQueue([item('a'), item('b')], transport, {
      concurrency: 2,
      signal: controller.signal,
    });
    controller.abort();
    const result = await promise;

    expect(result.filter(({ state }) => state === 'delivered')).toHaveLength(0);
    expect(result.every(({ state }) => state === 'failed')).toBe(true);
    expect(result.every(({ error }) => error === CANCELLED)).toBe(true);
    expect(result.every(({ retryStage }) => retryStage === undefined)).toBe(true);
    expect(getReceiptCount(result)).toBeNull();
  });

  it('leaves a failure that happened before the cancellation with its own reason', async () => {
    const controller = new AbortController();
    const transport = acceptingTransport({
      reserve: async (items) => items.map(({ id }) => id === 'rejected'
        ? { id, status: 'rejected' as const, error: 'The event has reached its photo limit.' }
        : { id, status: 'accepted' as const, reservation: { mediaId: `media-${id}`, uploadUrl: `https://upload.test/${id}`, mimeType: 'image/jpeg' } }),
      upload: async (uploadItem, _reservation, _progress, signal) => {
        if (uploadItem.id === 'dropped') throw new Error('Reception dropped out. Try this photo again.');
        return untilAborted(signal);
      },
    });

    const result = await runUploadQueue([item('rejected'), item('dropped'), item('slow')], transport, {
      concurrency: 2,
      signal: controller.signal,
      onChange: (items) => {
        if (items.some(({ id, state }) => id === 'dropped' && state === 'failed')) controller.abort();
      },
    });

    expect(result.find(({ id }) => id === 'rejected')).toMatchObject({
      state: 'failed',
      error: 'The event has reached its photo limit.',
    });
    expect(result.find(({ id }) => id === 'dropped')).toMatchObject({
      state: 'failed',
      error: 'Reception dropped out. Try this photo again.',
    });
    expect(result.find(({ id }) => id === 'slow')).toMatchObject({ state: 'failed', error: CANCELLED });
  });

  it('reports the cancellation when the reservation request itself is aborted', async () => {
    const controller = new AbortController();
    const transport = acceptingTransport({
      reserve: async (_items, signal) => {
        const aborted = untilAborted(signal);
        controller.abort();
        await aborted;
        return [];
      },
    });

    const result = await runUploadQueue([item('a')], transport, { signal: controller.signal });

    expect(result[0]).toMatchObject({ state: 'failed', error: CANCELLED, retryStage: undefined });
  });

  it('keeps a photo delivered before the cancellation and never starts the waiting ones', async () => {
    const controller = new AbortController();
    const transport = acceptingTransport({
      upload: async (uploadItem, _reservation, progress, signal) => {
        if (uploadItem.id === 'fast') return progress(100);
        return untilAborted(signal);
      },
    });
    const upload = vi.spyOn(transport, 'upload');

    const result = await runUploadQueue([item('fast'), item('slow'), item('waiting')], transport, {
      concurrency: 2,
      signal: controller.signal,
      onChange: (items) => {
        if (items.some(({ id, state }) => id === 'fast' && state === 'delivered')) controller.abort();
      },
    });

    expect(result.find(({ id }) => id === 'fast')).toMatchObject({ state: 'delivered', error: undefined });
    expect(result.find(({ id }) => id === 'slow')).toMatchObject({ state: 'failed', error: CANCELLED });
    expect(result.find(({ id }) => id === 'waiting')).toMatchObject({ state: 'failed', error: CANCELLED });
    expect(upload).toHaveBeenCalledTimes(2);
    expect(getReceiptCount(result)).toBeNull();
  });
});

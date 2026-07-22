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
      2,
      (items) => items.forEach(({ state }) => seenStates.add(state)),
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
});

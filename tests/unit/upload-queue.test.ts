import { describe, expect, it, vi } from 'vitest';

import { UPLOAD_BATCH_SIZE } from '../../shared/constants';
import { ClientApiError } from '../../src/app/api';
import {
  getReceiptCount,
  removeQueueItem,
  runUploadQueue,
  type UploadQueueItem,
  type UploadReservation,
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

  /* The server's answer about a reserved photo is three fields and a place to put the bytes. The
     photo itself never came back from it: the queue sends the exact `File` the guest chose, which it
     has held since the moment it was selected, so a reservation carrying storage detail, byte sizes,
     or dimensions was telling the browser things it already knew about its own file. */
  it('sends the file the guest chose and asks the reservation only where to put it', async () => {
    const seen: Array<{ file: File; reservation: UploadReservation }> = [];
    const transport = acceptingTransport({
      upload: async (queued, reservation, progress) => {
        seen.push({ file: queued.file, reservation });
        progress(100);
      },
    });
    const selected = item('a');

    const result = await runUploadQueue([selected], transport);

    expect(result[0]).toMatchObject({ state: 'delivered', progress: 100 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.file).toBe(selected.file);
    expect(Object.keys(seen[0]!.reservation).sort()).toEqual(['mediaId', 'mimeType', 'uploadUrl']);
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
      reserve: async ([queued]) => [{
        id: queued!.id,
        status: 'delivered' as const,
        mediaId: 'media-already-stored',
      }],
    });
    const upload = vi.spyOn(transport, 'upload');
    const finalize = vi.spyOn(transport, 'finalize');
    const onFinalized = vi.fn();

    const result = await runUploadQueue([item('already-stored')], transport, { onFinalized });

    expect(result[0]).toMatchObject({ state: 'delivered', progress: 100 });
    expect(upload).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
    expect(onFinalized).toHaveBeenCalledOnce();
    expect(onFinalized).toHaveBeenCalledWith({
      itemId: 'already-stored',
      mediaId: 'media-already-stored',
    });
  });

  it('signals each straightforward durable finalization once with its media id', async () => {
    const onFinalized = vi.fn();

    const result = await runUploadQueue([item('a')], acceptingTransport(), { onFinalized });

    expect(result[0]).toMatchObject({ state: 'delivered', progress: 100 });
    expect(onFinalized).toHaveBeenCalledOnce();
    expect(onFinalized).toHaveBeenCalledWith({ itemId: 'a', mediaId: 'media-a' });
  });

  it('drops an already-canceled reservation quietly without transferring, retrying, or receipting it', async () => {
    const transport = acceptingTransport({
      reserve: async ([queued]) => [{ id: queued!.id, status: 'canceled' as const }],
    });
    const reserve = vi.spyOn(transport, 'reserve');
    const upload = vi.spyOn(transport, 'upload');
    const finalize = vi.spyOn(transport, 'finalize');
    const onFinalized = vi.fn();

    const canceled = await runUploadQueue([item('gone')], transport, { onFinalized });
    const unchanged = await runUploadQueue(canceled, transport, { onFinalized });

    expect(canceled).toEqual([]);
    expect(unchanged).toEqual([]);
    expect(reserve).toHaveBeenCalledOnce();
    expect(upload).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
    expect(onFinalized).not.toHaveBeenCalled();
    expect(getReceiptCount(canceled)).toBeNull();
  });

  it('keeps a reserve rejection failure beside its unchanged human-facing error', async () => {
    const failure = { code: 'RESOURCE_FORBIDDEN' as const, status: 403, stage: 'reserve' as const };
    const transport = acceptingTransport({
      reserve: async ([queued]) => [{
        id: queued!.id,
        status: 'rejected' as const,
        error: 'This photo could not be reserved.',
        failure,
      }],
    });

    const result = await runUploadQueue([item('refused')], transport);

    expect(result[0]).toMatchObject({
      state: 'failed',
      error: 'This photo could not be reserved.',
      failure,
    });
  });

  it('records typed upload and finalize failures at the stage that failed', async () => {
    const transport = acceptingTransport({
      upload: async (queued) => {
        if (queued.id === 'upload-refused') {
          throw new ClientApiError(
            'RESOURCE_FORBIDDEN',
            'This upload is no longer authorized.',
            undefined,
            undefined,
            403,
          );
        }
      },
      finalize: async (queued) => {
        if (queued.id === 'finalize-conflict') {
          throw new ClientApiError(
            'UPLOAD_FINALIZE_CONFLICT',
            'This photo could not be confirmed.',
            undefined,
            undefined,
            409,
          );
        }
      },
    });

    const result = await runUploadQueue(
      [item('upload-refused'), item('finalize-conflict')],
      transport,
      { concurrency: 1 },
    );

    expect(result.find(({ id }) => id === 'upload-refused')).toMatchObject({
      state: 'failed',
      error: 'This upload is no longer authorized.',
      failure: { code: 'RESOURCE_FORBIDDEN', status: 403, stage: 'upload' },
    });
    expect(result.find(({ id }) => id === 'finalize-conflict')).toMatchObject({
      state: 'failed',
      error: 'This photo could not be confirmed.',
      failure: { code: 'UPLOAD_FINALIZE_CONFLICT', status: 409, stage: 'finalize' },
    });
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
    expect(failed[0]).toMatchObject({
      id: 'same-id',
      state: 'failed',
      error: 'Reception dropped out.',
      failure: undefined,
    });

    const delivered = await runUploadQueue(failed, transport);
    expect(delivered[0]).toMatchObject({
      id: 'same-id',
      state: 'delivered',
      error: undefined,
      failure: undefined,
    });
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
    const onFinalized = vi.fn();

    const failed = await runUploadQueue([item('confirm-once')], queueTransport, { onFinalized });
    expect(failed[0]).toMatchObject({ state: 'failed', retryStage: 'finalize' });
    const delivered = await runUploadQueue(failed, queueTransport, { onFinalized });

    expect(delivered[0]).toMatchObject({ state: 'delivered' });
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(finalizeAttempts).toBe(2);
    expect(onFinalized).toHaveBeenCalledOnce();
    expect(onFinalized).toHaveBeenCalledWith({
      itemId: 'confirm-once',
      mediaId: 'media-confirm-once',
    });
  });

  it('keeps completed chunks, marks the attempted lost chunk, and leaves later chunks unattempted', async () => {
    const selected = Array.from(
      { length: 2 * UPLOAD_BATCH_SIZE + 3 },
      (_, index) => item(`photo-${index}`),
    );
    let latest = selected;
    let reservationCalls = 0;
    const transport = acceptingTransport({
      reserve: async (chunk) => {
        reservationCalls += 1;
        if (reservationCalls === 1) {
          expect(chunk).toHaveLength(UPLOAD_BATCH_SIZE);
          expect(latest.slice(0, UPLOAD_BATCH_SIZE).every(({ state }) => state === 'reserving')).toBe(true);
          expect(latest.slice(UPLOAD_BATCH_SIZE).every(({ state }) => state === 'selected')).toBe(true);
          return chunk.map(({ id }) => ({ id, status: 'delivered' as const, mediaId: `media-${id}` }));
        }
        expect(chunk).toHaveLength(UPLOAD_BATCH_SIZE);
        expect(latest.slice(0, UPLOAD_BATCH_SIZE).every(({ state }) => state === 'delivered')).toBe(true);
        expect(latest.slice(UPLOAD_BATCH_SIZE, 2 * UPLOAD_BATCH_SIZE)
          .every(({ state }) => state === 'reserving')).toBe(true);
        expect(latest.slice(2 * UPLOAD_BATCH_SIZE).every(({ state }) => state === 'selected')).toBe(true);
        throw new Error('The reservation answer was lost.');
      },
    });

    const result = await runUploadQueue(selected, transport, {
      onChange: (items) => { latest = items; },
    });

    expect(reservationCalls).toBe(2);
    expect(result.slice(0, UPLOAD_BATCH_SIZE).every(({ state }) => state === 'delivered')).toBe(true);
    expect(result.slice(UPLOAD_BATCH_SIZE, 2 * UPLOAD_BATCH_SIZE)).toEqual(
      expect.arrayContaining(Array.from({ length: UPLOAD_BATCH_SIZE }, () => expect.objectContaining({
        state: 'failed',
        error: 'The reservation answer was lost.',
      }))),
    );
    expect(result.slice(2 * UPLOAD_BATCH_SIZE).every(({ state }) => state === 'selected')).toBe(true);
  });

  it('suppresses late progress, finalize, delivery, and callbacks after a sibling terminal failure aborts', async () => {
    const controller = new AbortController();
    let releaseSlow!: () => void;
    const slow = new Promise<void>((resolve) => { releaseSlow = resolve; });
    const onFinalized = vi.fn();
    const snapshots: UploadQueueItem[][] = [];
    const transport = acceptingTransport({
      upload: async (queued, _reservation, progress) => {
        if (queued.id === 'terminal') {
          throw new ClientApiError(
            'RESOURCE_FORBIDDEN',
            'This upload is no longer authorized.',
            undefined,
            undefined,
            403,
          );
        }
        await slow;
        progress(75);
      },
    });
    const finalize = vi.spyOn(transport, 'finalize');

    const pending = runUploadQueue([item('terminal'), item('slow')], transport, {
      concurrency: 2,
      signal: controller.signal,
      onFinalized,
      onChange: (items) => {
        snapshots.push(items);
        if (items.some(({ failure }) => failure?.code === 'RESOURCE_FORBIDDEN')) controller.abort();
      },
    });
    await vi.waitFor(() => expect(controller.signal.aborted).toBe(true));
    releaseSlow();
    const result = await pending;

    expect(result.find(({ id }) => id === 'terminal')).toMatchObject({
      state: 'failed',
      failure: { code: 'RESOURCE_FORBIDDEN', status: 403, stage: 'upload' },
    });
    expect(result.find(({ id }) => id === 'slow')).toMatchObject({
      state: 'failed',
      progress: 0,
      error: CANCELLED,
    });
    expect(finalize).not.toHaveBeenCalled();
    expect(onFinalized).not.toHaveBeenCalled();
    expect(snapshots.some((snapshot) => snapshot.some(({ id, progress }) => id === 'slow' && progress === 75)))
      .toBe(false);
  });

  it('does not publish delivery or finalization after finalize aborts before resolving', async () => {
    const controller = new AbortController();
    const onFinalized = vi.fn();
    const transport = acceptingTransport({
      finalize: async () => { controller.abort(); },
    });

    const result = await runUploadQueue([item('late-finalize')], transport, {
      signal: controller.signal,
      onFinalized,
    });

    expect(result[0]).toMatchObject({ state: 'failed', error: CANCELLED });
    expect(onFinalized).not.toHaveBeenCalled();
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

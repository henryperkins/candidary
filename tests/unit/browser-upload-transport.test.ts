import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UPLOAD_BATCH_SIZE } from '../../shared/constants';
import { ClientApiError } from '../../src/app/api';
import {
  createBrowserTransport,
  xhrUpload,
} from '../../src/features/uploads/browser-upload-transport';
import { createManagerUploadCleanup } from '../../src/features/uploads/manager-upload-cleanup';
import type {
  UploadQueueItem,
  UploadReservation,
} from '../../src/features/uploads/upload-queue';
import { MANAGER_UPLOAD_RESOURCE_FORBIDDEN_ERROR } from '../fixtures/manager-upload-errors';

type Listener = EventListenerOrEventListenerObject;

class ControlledXMLHttpRequest {
  static instances: ControlledXMLHttpRequest[] = [];

  status = 0;
  responseText = '';
  withCredentials = false;
  readonly upload = { addEventListener: vi.fn() };
  readonly open = vi.fn();
  readonly setRequestHeader = vi.fn();
  readonly send = vi.fn();
  readonly abort = vi.fn(() => this.dispatch('abort'));
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor() {
    ControlledXMLHttpRequest.instances.push(this);
  }

  addEventListener(type: string, listener: Listener | null) {
    if (!listener) return;
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener | null) {
    if (listener) this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string) {
    const event = new Event(type);
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === 'function') listener.call(this, event);
      else listener.handleEvent(event);
    }
  }
}

class RepeatableAbortSignal {
  aborted = false;
  readonly addEventListener = vi.fn((_type: string, listener: EventListenerOrEventListenerObject) => {
    this.listeners.add(listener);
  });
  readonly removeEventListener = vi.fn((_type: string, listener: EventListenerOrEventListenerObject) => {
    this.listeners.delete(listener);
  });
  private readonly listeners = new Set<EventListenerOrEventListenerObject>();

  abort() {
    this.aborted = true;
    this.dispatchAbort();
  }

  dispatchAbort() {
    const event = new Event('abort');
    for (const listener of [...this.listeners]) {
      if (typeof listener === 'function') listener.call(this, event);
      else listener.handleEvent(event);
    }
  }
}

const reservation: UploadReservation = {
  mediaId: 'media-a',
  uploadUrl: 'https://upload.test/media-a',
  mimeType: 'image/jpeg',
};

function item(id = 'item-a'): UploadQueueItem {
  return {
    id,
    file: new File(['photo'], `${id}.jpg`, { type: 'image/jpeg' }),
    state: 'selected',
    progress: 0,
    isNewCapture: false,
  };
}

function response(data: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(
    status >= 400 ? data : { data, requestId: 'request-a' },
  ), {
    status,
    headers: { 'content-type': 'application/json' },
  }));
}

beforeEach(() => {
  ControlledXMLHttpRequest.instances = [];
  vi.stubGlobal('XMLHttpRequest', ControlledXMLHttpRequest as unknown as typeof XMLHttpRequest);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('browser upload transport cancellation', () => {
  it('sends same-origin ingress with both event and host credential pairs', async () => {
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      value: 'candidary_csrf=event-token; candidary_host_csrf=host-token',
    });
    const sameOrigin = {
      ...reservation,
      uploadUrl: `${window.location.origin}/api/event/alex-jordan/uploads/media-a/content`,
    };
    const upload = xhrUpload(item().file, sameOrigin, vi.fn());
    const request = ControlledXMLHttpRequest.instances[0]!;
    request.status = 200;
    request.dispatch('load');
    await upload;

    expect(request.withCredentials).toBe(true);
    expect(request.setRequestHeader).toHaveBeenCalledWith('x-candidary-csrf', 'event-token');
    expect(request.setRequestHeader).toHaveBeenCalledWith('x-candidary-host-csrf', 'host-token');
    expect(request.setRequestHeader).toHaveBeenCalledWith('Content-Type', reservation.mimeType);
  });

  it.each([
    [403, MANAGER_UPLOAD_RESOURCE_FORBIDDEN_ERROR],
    [409, {
      code: 'UPLOAD_FINALIZE_CONFLICT',
      message: 'This upload can no longer receive bytes.',
      requestId: 'request-finalize-conflict',
    }],
  ] as const)('preserves a flat API error body from a %i content response', async (status, body) => {
    const upload = xhrUpload(item().file, {
      ...reservation,
      uploadUrl: `${window.location.origin}/api/manage/events/event-a/uploads/media-a/content`,
    }, vi.fn());
    const request = ControlledXMLHttpRequest.instances[0]!;
    request.status = status;
    request.responseText = JSON.stringify(body);
    request.dispatch('load');

    const error = await upload.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ClientApiError);
    expect(error).toMatchObject({
      code: body.code,
      message: body.message,
      status,
      requestId: body.requestId,
    });
  });

  it.each([
    ['nested batch error', JSON.stringify({ error: MANAGER_UPLOAD_RESOURCE_FORBIDDEN_ERROR })],
    ['empty body', ''],
    ['non-JSON body', '<html>upstream error</html>'],
  ])('keeps the exact interrupted-transfer fallback for a %s', async (_label, responseText) => {
    const upload = xhrUpload(item().file, reservation, vi.fn());
    const request = ControlledXMLHttpRequest.instances[0]!;
    request.status = 403;
    request.responseText = responseText;
    request.dispatch('load');

    const error = await upload.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ClientApiError);
    expect(error).toMatchObject({
      message: 'The transfer was interrupted. Try this photo again.',
    });
  });

  it('keeps the exact network-error fallback', async () => {
    const upload = xhrUpload(item().file, reservation, vi.fn());
    ControlledXMLHttpRequest.instances[0]!.dispatch('error');

    await expect(upload).rejects.toMatchObject({
      message: 'Reception dropped out. Try this photo again.',
    });
  });

  it('maps a stored idempotent batch replay to an already-delivered queue result', async () => {
    vi.stubGlobal('fetch', vi.fn(() => response({
      items: [{
        idempotencyKey: 'item-a',
        status: 'accepted',
        alreadyDelivered: true,
        media: { id: reservation.mediaId, mimeType: reservation.mimeType, uploadState: 'stored' },
      }],
    })));

    const results = await createBrowserTransport({
      kind: 'guest',
      slug: 'alex-jordan',
      guestName: 'Taylor',
    }).reserve([item()]);

    expect(results).toEqual([{
      id: 'item-a',
      status: 'delivered',
      mediaId: reservation.mediaId,
    }]);
    expect(ControlledXMLHttpRequest.instances).toHaveLength(0);
  });

  it('sends exactly the reservation items it receives without a nested chunk loop', async () => {
    const selected = Array.from(
      { length: UPLOAD_BATCH_SIZE + 3 },
      (_, index) => item(`item-${index}`),
    );
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { files: Array<{ idempotencyKey: string }> };
      return response({
        items: body.files.map(({ idempotencyKey }) => ({
          idempotencyKey,
          status: 'rejected',
          error: { code: 'EVENT_MEDIA_LIMIT', message: 'The event has reached its photo limit.' },
        })),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const results = await createBrowserTransport({
      kind: 'guest',
      slug: 'alex-jordan',
      guestName: 'Taylor',
    }).reserve(selected);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(String(init?.body)) as { guestName: string; files: Array<{ idempotencyKey: string }> };
    expect(body.guestName).toBe('Taylor');
    expect(body.files.map(({ idempotencyKey }) => idempotencyKey))
      .toEqual(selected.map(({ id }) => id));
    expect(results).toHaveLength(selected.length);
  });

  /* The reservation answer is an allowlist: three fields about the media row and a relative
     same-origin place to put the bytes. Everything the response used to carry — the object key, the
     byte size, the decoded dimensions, the guest name, the publication status, the reservation
     expiry — was either storage detail the browser had no business reading or the guest's own file
     being read back to it, and the queue drives the transfer from the file it already holds. */
  it('reserves from the allowlisted media view and nothing else', async () => {
    const media = { id: 'media-a', mimeType: 'image/jpeg', uploadState: 'reserved' };
    expect(Object.keys(media).sort()).toEqual(['id', 'mimeType', 'uploadState']);
    vi.stubGlobal('fetch', vi.fn(() => response({
      items: [{
        idempotencyKey: 'item-a',
        status: 'accepted',
        alreadyDelivered: false,
        media,
        uploadUrl: '/api/event/alex-jordan/uploads/media-a/content',
        uploadUrlExpiresAt: '2026-09-14T00:10:00.000Z',
      }],
    })));

    const results = await createBrowserTransport({
      kind: 'guest',
      slug: 'alex-jordan',
      guestName: 'Taylor',
    }).reserve([item()]);

    expect(results).toEqual([{
      id: 'item-a',
      status: 'accepted',
      reservation: {
        mediaId: 'media-a',
        uploadUrl: '/api/event/alex-jordan/uploads/media-a/content',
        mimeType: 'image/jpeg',
      },
    }]);
  });

  it('carries a rejection message through and refuses to send a reservation it cannot address', async () => {
    vi.stubGlobal('fetch', vi.fn(() => response({
      items: [
        {
          idempotencyKey: 'refused',
          status: 'rejected',
          error: { code: 'EVENT_PHOTO_LIMIT', message: 'The event has reached its photo limit.' },
        },
        {
          // Accepted, not already delivered, and with nowhere to put the bytes. It cannot be sent,
          // so it must not be reported as sent.
          idempotencyKey: 'unaddressable',
          status: 'accepted',
          alreadyDelivered: false,
          media: { id: 'media-b', mimeType: 'image/jpeg', uploadState: 'reserved' },
        },
      ],
    })));

    const results = await createBrowserTransport({
      kind: 'guest',
      slug: 'alex-jordan',
      guestName: 'Taylor',
    })
      .reserve([item('refused'), item('unaddressable')]);

    expect(results).toEqual([
      { id: 'refused', status: 'rejected', error: 'The event has reached its photo limit.' },
      { id: 'unaddressable', status: 'rejected', error: 'This photo could not be reserved.' },
    ]);
    expect(ControlledXMLHttpRequest.instances).toHaveLength(0);
  });

  it('rejects a pre-aborted XHR without constructing a request', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(xhrUpload(item().file, reservation, vi.fn(), controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(ControlledXMLHttpRequest.instances).toHaveLength(0);
  });

  it('aborts an active XHR once and removes its signal listener on settlement', async () => {
    const signal = new RepeatableAbortSignal();
    let rejectionCount = 0;
    const upload = xhrUpload(item().file, reservation, vi.fn(), signal as unknown as AbortSignal)
      .catch((error: unknown) => {
        rejectionCount += 1;
        throw error;
      });
    const request = ControlledXMLHttpRequest.instances[0]!;

    signal.abort();

    await expect(upload).rejects.toMatchObject({ name: 'AbortError' });
    expect(request.abort).toHaveBeenCalledTimes(1);
    expect(rejectionCount).toBe(1);
    expect(signal.removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function));

    signal.dispatchAbort();
    expect(request.abort).toHaveBeenCalledTimes(1);
    expect(rejectionCount).toBe(1);
  });

  it('aborts retry backoff without issuing another finalize request', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => response({
      code: 'INTERNAL_ERROR',
      message: 'Reception dropped out.',
      requestId: 'request-a',
    }, 500));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const finalize = createBrowserTransport({
      kind: 'guest',
      slug: 'alex-jordan',
      guestName: 'Taylor',
    })
      .finalize(item(), reservation, controller.signal);

    // Spin until the backoff timer is armed. The number of microtask turns the
    // failing finalize takes is not fixed: `Response.json()` alone costs eight
    // on some Node/undici builds and fewer on others, so a tight budget passes
    // on one machine and fails on the next. The loop still exits on the first
    // turn that arms the timer, so the bound only has to be safely generous.
    for (let turn = 0; turn < 100 && vi.getTimerCount() === 0; turn += 1) {
      await Promise.resolve();
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    controller.abort();

    await expect(finalize).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('forwards one signal through reserve, XHR upload, and finalize', async () => {
    const fetchSignals: Array<AbortSignal | null | undefined> = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      fetchSignals.push(init?.signal);
      return String(input).endsWith('/uploads/batch')
        ? response({
          items: [{
            idempotencyKey: 'item-a',
            status: 'accepted',
            alreadyDelivered: false,
            media: {
              id: reservation.mediaId,
              mimeType: reservation.mimeType,
              uploadState: 'reserved',
            },
            uploadUrl: reservation.uploadUrl,
          }],
        })
        : response({});
    }));
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, 'addEventListener');
    const transport = createBrowserTransport({
      kind: 'guest',
      slug: 'alex-jordan',
      guestName: 'Taylor',
    });

    const reserved = await transport.reserve([item()], controller.signal);
    expect(reserved[0]?.status).toBe('accepted');
    const upload = transport.upload(item(), reservation, vi.fn(), controller.signal);
    const request = ControlledXMLHttpRequest.instances[0]!;
    request.status = 200;
    request.dispatch('load');
    await upload;
    await transport.finalize(item(), reservation, controller.signal);

    expect(fetchSignals).toEqual([controller.signal, controller.signal]);
    expect(addListener).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
  });

  it('uses exact Manager paths and bodies, maps canceled replay, and alone exposes cancel', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/uploads/batch')) {
        return response({
          items: [{
            idempotencyKey: 'item-a',
            status: 'rejected',
            error: {
              code: 'UPLOAD_RESERVATION_CANCELED',
              message: 'This upload reservation was canceled.',
            },
          }],
        });
      }
      return response({ media: { id: 'media-a', mimeType: 'image/jpeg', uploadState: 'deleted' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const manager = createBrowserTransport({ kind: 'manager', eventId: 'event-a' });
    const guest = createBrowserTransport({
      kind: 'guest',
      slug: 'alex-jordan',
      guestName: 'Taylor',
    });

    await expect(manager.reserve([item()])).resolves.toEqual([{
      id: 'item-a',
      status: 'canceled',
    }]);
    await manager.finalize(item(), reservation);
    expect(manager.cancelReservation).toBeTypeOf('function');
    await manager.cancelReservation!(item(), reservation);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/manage/events/event-a/uploads/batch',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          files: [{
            filename: 'item-a.jpg',
            mimeType: 'image/jpeg',
            byteSize: 5,
            idempotencyKey: 'item-a',
            caption: null,
          }],
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/manage/events/event-a/uploads/media-a/finalize',
      expect.objectContaining({ method: 'POST', body: '{}' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      '/api/manage/events/event-a/uploads/media-a',
      expect.objectContaining({ method: 'DELETE', body: '{}' }),
    );
    expect(guest.cancelReservation).toBeUndefined();
  });

  it('carries a nested Manager authority refusal through reserve into terminal cleanup', async () => {
    vi.stubGlobal('fetch', vi.fn(() => response({
      items: [{
        idempotencyKey: 'item-a',
        status: 'rejected',
        error: {
          code: MANAGER_UPLOAD_RESOURCE_FORBIDDEN_ERROR.code,
          message: MANAGER_UPLOAD_RESOURCE_FORBIDDEN_ERROR.message,
        },
      }],
    })));
    const queueItem = item();
    const transport = createBrowserTransport({ kind: 'manager', eventId: 'event-a' });
    const replay = await transport.reserve([queueItem]);
    const cleanup = createManagerUploadCleanup({
      reserve: vi.fn(async () => replay[0]!),
      cancel: vi.fn(async () => undefined),
    });

    expect(replay).toEqual([{
      id: 'item-a',
      status: 'rejected',
      error: MANAGER_UPLOAD_RESOURCE_FORBIDDEN_ERROR.message,
      failure: { code: 'RESOURCE_FORBIDDEN', status: 403, stage: 'reserve' },
    }]);
    await expect(cleanup.run([{
      itemId: queueItem.id,
      idempotencyKey: queueItem.id,
      queueItem,
      reservation: null,
      disposition: 'ambiguous',
    }])).resolves.toEqual({
      kind: 'terminal',
      reason: 'authorization',
      unresolvedCount: 1,
      deliveredIds: [],
    });
  });

  it('keeps the exact guest reservation path and guestName body', async () => {
    const fetchMock = vi.fn(() => response({
      items: [{
        idempotencyKey: 'item-a',
        status: 'rejected',
        error: { code: 'EVENT_MEDIA_LIMIT', message: 'The event is full.' },
      }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    await createBrowserTransport({
      kind: 'guest',
      slug: 'alex-jordan',
      guestName: 'Taylor',
    }).reserve([item()]);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/event/alex-jordan/uploads/batch',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          guestName: 'Taylor',
          files: [{
            filename: 'item-a.jpg',
            mimeType: 'image/jpeg',
            byteSize: 5,
            idempotencyKey: 'item-a',
            caption: null,
          }],
        }),
      }),
    );
  });
});

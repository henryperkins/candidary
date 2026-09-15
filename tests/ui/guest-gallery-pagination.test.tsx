import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useGuestGallery } from '../../src/features/gallery/useGuestGallery';

const photo = (id: string) => ({ id, caption: id, guestName: 'Avery', previewAvailable: true });
const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('guest gallery continuation', () => {
  it('loads only on demand, locks concurrent reads and merges repeated photo IDs', async () => {
    const next = deferred<Response>();
    const fetcher = vi.fn((path: string) => path.includes('?') ? next.promise : Promise.resolve(ok({ media: [photo('first')], nextCursor: 'page+two/=' })));
    vi.stubGlobal('fetch', fetcher);
    const { result } = renderHook(() => useGuestGallery('event-a', true));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.current.hasMore).toBe(true);
    let settled!: Promise<string | null>;
    act(() => { settled = result.current.loadMore(); void result.current.loadMore(); });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]![0]).toBe('/api/event/event-a/gallery?cursor=page%2Btwo%2F%3D');
    expect(result.current.media).toHaveLength(1);
    await act(async () => next.resolve(ok({ media: [photo('first'), photo('second')], nextCursor: null })));
    expect(await settled).toBe('second');
    expect(result.current.media.map(item => item.id)).toEqual(['first', 'second']);
    expect(result.current.hasMore).toBe(false);
  });

  it('keeps loaded photos after a continuation failure and retries the same cursor', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(ok({ media: [photo('first')], nextCursor: 'next' }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'INTERNAL_ERROR', message: 'More photos could not be loaded.' }), { status: 503 }))
      .mockResolvedValueOnce(ok({ media: [photo('second')], nextCursor: null }));
    vi.stubGlobal('fetch', fetcher);
    const { result } = renderHook(() => useGuestGallery('event-a', true));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await act(async () => { await result.current.loadMore(); });
    expect(result.current.media.map(item => item.id)).toEqual(['first']);
    expect(result.current.moreFailure?.retryable).toBe(true);
    expect(result.current.failure).toBeNull();
    await act(async () => { await result.current.loadMore(); });
    expect(fetcher.mock.calls[2]![0]).toBe(fetcher.mock.calls[1]![0]);
    expect(result.current.media).toHaveLength(2);
    expect(result.current.moreFailure).toBeNull();
  });

  it('retires an old continuation when a different event opens', async () => {
    const pending = deferred<Response>();
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((path: string, init: RequestInit) => {
      if (path.includes('?')) { signal = init.signal!; return pending.promise; }
      return Promise.resolve(ok({ media: [photo(path.includes('event-b') ? 'new-event' : 'first')], nextCursor: 'next' }));
    }));
    const { result, rerender } = renderHook(({ slug }) => useGuestGallery(slug, true), { initialProps: { slug: 'event-a' } });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => { void result.current.loadMore(); });
    rerender({ slug: 'event-b' });
    await waitFor(() => expect(result.current.media[0]?.id).toBe('new-event'));
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve(ok({ media: [photo('old-event')], nextCursor: null })));
    expect(result.current.media.map(item => item.id)).toEqual(['new-event']);
  });

  it('keeps terminal access recovery when the gallery is closed and reopened', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(ok({ media: [photo('first')], nextCursor: 'next' }))
      .mockResolvedValue(new Response(JSON.stringify({ code: 'SESSION_EXPIRED', message: 'Your guest session has expired.' }), { status: 403 }));
    vi.stubGlobal('fetch', fetcher);
    const { result, rerender } = renderHook(({ enabled }) => useGuestGallery('event-a', enabled), { initialProps: { enabled: true } });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await act(async () => { await result.current.loadMore(); });
    expect(result.current.moreFailure?.retryable).toBe(false);
    rerender({ enabled: false });
    rerender({ enabled: true });
    expect(result.current.moreFailure?.retryable).toBe(false);
    await act(async () => { await result.current.loadMore(); });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

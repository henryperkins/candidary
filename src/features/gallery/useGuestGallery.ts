import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../../app/api';
import type { GuestGalleryMediaView } from '../../app/types';
import type { GuestGalleryPage } from '../../../shared/contracts';
import { describeLoadFailure, type LoadFailure } from '../../components/States';

interface GuestGalleryState {
  slug: string;
  status: 'loading' | 'ready' | 'failed';
  media: GuestGalleryMediaView[];
  failure: LoadFailure | null;
  nextCursor: string | null;
  loadingMore: boolean;
  moreFailure: LoadFailure | null;
}

/** Gallery recovery stays local to this optional guest surface. */
export function useGuestGallery(slug: string, enabled: boolean) {
  const [state, setState] = useState<GuestGalleryState | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const settled = useRef<GuestGalleryState | null>(null);
  const continuation = useRef<AbortController | null>(null);

  useEffect(() => {
    continuation.current?.abort();
    continuation.current = null;
    if (!enabled) return;
    if (settled.current?.slug === slug) {
      setState(settled.current);
      return () => { continuation.current?.abort(); continuation.current = null; };
    }
    settled.current = null;
    const controller = new AbortController();
    const initial: GuestGalleryState = { slug, status: 'loading', media: [], failure: null, nextCursor: null, loadingMore: false, moreFailure: null };
    setState(initial);
    void api<GuestGalleryPage>(`/api/event/${slug}/gallery`, { signal: controller.signal })
      .then(({ media, nextCursor }) => {
        // Some transports can still settle after abort. Neither a closed
        // disclosure nor a different event may adopt that old answer.
        if (controller.signal.aborted) return;
        // An older Worker can still answer without the additive page cursor.
        const ready: GuestGalleryState = { ...initial, status: 'ready', media, nextCursor: nextCursor ?? null };
        settled.current = ready;
        setState(ready);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setState({ ...initial, status: 'failed', failure: describeLoadFailure(caught, 'guest', 'Shared photos could not be loaded.') });
      });
    return () => {
      controller.abort();
      continuation.current?.abort();
      continuation.current = null;
    };
  }, [enabled, retryKey, slug]);

  const loadMore = useCallback(async (): Promise<string | null> => {
    const previous = settled.current;
    if (!enabled || previous?.slug !== slug || !previous.nextCursor || continuation.current) return null;
    if (previous.moreFailure && !previous.moreFailure.retryable) return null;
    const controller = new AbortController();
    continuation.current = controller;
    setState({ ...previous, loadingMore: true, moreFailure: null });
    try {
      const page = await api<GuestGalleryPage>(`/api/event/${slug}/gallery?cursor=${encodeURIComponent(previous.nextCursor)}`, { signal: controller.signal });
      if (controller.signal.aborted) return null;
      const byId = new Map(previous.media.map(photo => [photo.id, photo]));
      const firstAdded = page.media.find(photo => !byId.has(photo.id))?.id ?? null;
      // A photo can be republished while paging. Keep one copy without losing
      // any already-loaded photos or moving the guest back to the first page.
      for (const photo of page.media) byId.set(photo.id, photo);
      const ready: GuestGalleryState = { ...previous, media: [...byId.values()], nextCursor: page.nextCursor ?? null, loadingMore: false, moreFailure: null };
      settled.current = ready;
      setState(ready);
      return firstAdded;
    } catch (caught) {
      if (!controller.signal.aborted) {
        const failed = { ...previous, moreFailure: describeLoadFailure(caught, 'guest', 'More shared photos could not be loaded.') };
        settled.current = failed;
        setState(failed);
      }
      return null;
    } finally {
      if (continuation.current === controller) continuation.current = null;
    }
  }, [enabled, slug]);

  const current = enabled && state?.slug === slug ? state : null;
  const retry = useCallback(() => setRetryKey((key) => key + 1), []);
  return {
    media: current?.media ?? [],
    loading: enabled && (current === null || current.status === 'loading'),
    loaded: current?.status === 'ready',
    failure: current?.failure ?? null,
    hasMore: Boolean(current?.nextCursor),
    loadingMore: current?.loadingMore ?? false,
    moreFailure: current?.moreFailure ?? null,
    loadMore,
    retry,
  };
}

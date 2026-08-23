import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';

import type { PublicAlbumView } from '../../shared/contracts';
import { PageHeader } from '../components/Brand';
import {
  exchangeAlbumShare,
  fetchPublicAlbum,
} from '../features/gallery/album-share-api';
import { PublicAlbum } from '../features/gallery/PublicAlbum';

type PageState =
  | { status: 'loading' }
  | { status: 'unavailable' }
  | { status: 'ready'; album: PublicAlbumView };

export function AlbumSharePage() {
  const location = useLocation();
  const [state, setState] = useState<PageState>({ status: 'loading' });
  const pendingToken = useRef<string | null>(null);
  const requestVersion = useRef(0);
  const requestController = useRef<AbortController | null>(null);

  useEffect(() => {
    const existing = document.head.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const robots = existing ?? document.createElement('meta');
    const previousContent = existing?.getAttribute('content') ?? null;
    if (!existing) {
      robots.name = 'robots';
      document.head.append(robots);
    }
    robots.content = 'noindex, nofollow';

    return () => {
      if (!existing) {
        robots.remove();
      } else if (previousContent === null) {
        robots.removeAttribute('content');
      } else {
        robots.content = previousContent;
      }
    };
  }, []);

  useEffect(() => {
    const loadAlbum = (token: string | null, includeExistingSession: boolean) => {
      if (!token && !includeExistingSession) return;

      if (token) pendingToken.current = token;
      if (token && window.location.hash.slice(1)) {
        window.history.replaceState(
          window.history.state,
          '',
          `${window.location.pathname}${window.location.search}`,
        );
      }
      requestVersion.current += 1;
      const version = requestVersion.current;
      requestController.current?.abort();
      const controller = new AbortController();
      requestController.current = controller;
      setState({ status: 'loading' });

      const request = token
        ? exchangeAlbumShare(token, controller.signal)
        : fetchPublicAlbum(controller.signal);
      void request.then(
        ({ album }) => {
          if (version !== requestVersion.current) return;
          pendingToken.current = null;
          setState({ status: 'ready', album });
        },
        () => {
          if (version !== requestVersion.current) return;
          pendingToken.current = null;
          setState({ status: 'unavailable' });
        },
      );
    };

    const consumeNewFragment = () => {
      const token = window.location.hash.slice(1);
      if (token) loadAlbum(token, false);
    };
    window.addEventListener('hashchange', consumeNewFragment);
    const routeToken = location.hash.slice(1)
      || window.location.hash.slice(1)
      || pendingToken.current;
    loadAlbum(routeToken, true);

    return () => {
      window.removeEventListener('hashchange', consumeNewFragment);
      requestVersion.current += 1;
      requestController.current?.abort();
    };
  }, [location.hash, location.key]);

  const announcement = state.status === 'loading'
    ? 'Opening the album.'
    : state.status === 'unavailable'
      ? 'This album is not available.'
      : `${state.album.title} is ready. ${state.album.photoCount} ${state.album.photoCount === 1 ? 'photo' : 'photos'}.`;

  return <div className="public-shell public-album-shell">
    <PageHeader />
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {announcement}
    </p>
    {state.status === 'loading'
      ? <main className="centered-state">
          <h1>Opening the album…</h1>
          <p>One moment while we prepare the photographs.</p>
        </main>
      : state.status === 'unavailable'
        ? <main className="centered-state">
            <h1>This album is not available.</h1>
            <p>Ask the host for a new link, and they can share the album with you.</p>
          </main>
        : <PublicAlbum album={state.album} />}
  </div>;
}

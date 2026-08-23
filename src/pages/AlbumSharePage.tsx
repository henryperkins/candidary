import { useEffect, useRef, useState } from 'react';

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
  const started = useRef(false);
  const [state, setState] = useState<PageState>({ status: 'loading' });

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const token = window.location.hash.slice(1);
    window.history.replaceState(null, '', '/album');
    const request = token ? exchangeAlbumShare(token) : fetchPublicAlbum();
    void request.then(
      ({ album }) => setState({ status: 'ready', album }),
      () => setState({ status: 'unavailable' }),
    );
  }, []);

  if (state.status === 'loading') {
    return <div className="public-shell public-album-shell"><PageHeader />
      <main className="centered-state">
        <h1>Opening the album…</h1>
        <p aria-live="polite">One moment while we prepare the photographs.</p>
      </main>
    </div>;
  }

  if (state.status === 'unavailable') {
    return <div className="public-shell public-album-shell"><PageHeader />
      <main className="centered-state">
        <h1>This album is not available.</h1>
        <p>Ask the host for a new link, and they can share the album with you.</p>
      </main>
    </div>;
  }

  return <div className="public-shell public-album-shell">
    <PageHeader />
    <PublicAlbum album={state.album} />
  </div>;
}

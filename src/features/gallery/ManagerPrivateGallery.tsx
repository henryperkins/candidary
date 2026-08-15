import { Search, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { api, ClientApiError } from '../../app/api';
import { ErrorState, LoadingState } from '../../components/States';
import type { EventView, ManagerGalleryMediaView } from '../../../shared/contracts';
import { GalleryTimeline } from './GalleryTimeline';
import { GalleryViewer } from './GalleryViewer';

const SEARCH_MAX_CODE_POINTS = 120;

interface ManagerPrivateGalleryProps {
  event: EventView;
  eventId: string;
}

interface GalleryPage {
  media: ManagerGalleryMediaView[];
  nextCursor: string | null;
}

export function ManagerPrivateGallery({ event, eventId }: ManagerPrivateGalleryProps) {
  const [queryInput, setQueryInput] = useState('');
  const [query, setQuery] = useState('');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [rows, setRows] = useState<ManagerGalleryMediaView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [retryEpoch, setRetryEpoch] = useState(0);
  const [loadFailure, setLoadFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const loadGeneration = useRef(0);
  const loadMoreGeneration = useRef(0);
  const focusResults = useRef(false);
  const viewerOrigin = useRef<HTMLElement | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const emptyRef = useRef<HTMLHeadingElement>(null);

  const galleryPath = useCallback((
    nextQuery: string,
    nextFavorites: boolean,
    nextCursor?: string,
  ) => {
    const params = new URLSearchParams();
    if (nextQuery) params.set('query', nextQuery);
    if (nextFavorites) params.set('favorites', '1');
    if (nextCursor) params.set('cursor', nextCursor);
    const search = params.toString();
    return `/api/manage/events/${eventId}/gallery${search ? `?${search}` : ''}`;
  }, [eventId]);

  useEffect(() => {
    const generation = ++loadGeneration.current;
    const controller = new AbortController();
    setLoading(true);
    setLoadFailure(null);
    setRows([]);
    setCursor(null);
    setViewerIndex(null);
    api<GalleryPage>(galleryPath(query, favoritesOnly), { signal: controller.signal })
      .then((page) => {
        if (generation !== loadGeneration.current) return;
        setRows(page.media);
        setCursor(page.nextCursor);
        if (focusResults.current) {
          focusResults.current = false;
          if (page.media.length > 0) {
            resultsRef.current?.querySelector<HTMLElement>('h3')?.focus();
          } else {
            emptyRef.current?.focus();
          }
        }
      })
      .catch((caught) => {
        if (generation !== loadGeneration.current) return;
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setLoadFailure(caught instanceof ClientApiError
          ? caught.message
          : 'The private gallery could not be loaded.');
      })
      .finally(() => {
        if (generation === loadGeneration.current) setLoading(false);
      });
    return () => controller.abort();
  }, [eventId, favoritesOnly, galleryPath, query, retryEpoch]);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    const requested = cursor;
    const generation = ++loadMoreGeneration.current;
    setLoadingMore(true);
    try {
      const page = await api<GalleryPage>(galleryPath(query, favoritesOnly, requested));
      if (generation !== loadMoreGeneration.current) return;
      setRows((current) => {
        const known = new Set(current.map((item) => item.id));
        return [...current, ...page.media.filter((item) => !known.has(item.id))];
      });
      setCursor(page.nextCursor);
      setNotice(null);
    } catch (caught) {
      if (generation !== loadMoreGeneration.current) return;
      setNotice(caught instanceof ClientApiError
        ? caught.message
        : 'The next page of photos could not be loaded.');
    } finally {
      if (generation === loadMoreGeneration.current) setLoadingMore(false);
    }
  }

  function tileFor(photo: ManagerGalleryMediaView): HTMLElement | null {
    return resultsRef.current
      ?.querySelector<HTMLElement>(`[data-photo-id="${photo.id}"] .gallery-mosaic__open`) ?? null;
  }

  function openViewer(photo: ManagerGalleryMediaView, origin: HTMLElement) {
    const index = rows.findIndex((item) => item.id === photo.id);
    if (index === -1) return;
    viewerOrigin.current = origin;
    setViewerIndex(index);
  }

  function changeViewerIndex(index: number) {
    setViewerIndex(index);
    const nextPhoto = rows[index];
    if (nextPhoto) viewerOrigin.current = tileFor(nextPhoto);
  }

  function closeViewer() {
    setViewerIndex(null);
    viewerOrigin.current?.focus();
    viewerOrigin.current = null;
  }

  async function toggleFavorite(photo: ManagerGalleryMediaView) {
    const next = !photo.isFavorite;
    const confirmed = photo.isFavorite;
    setRows((current) => current.map((item) => (
      item.id === photo.id ? { ...item, isFavorite: next } : item
    )));
    try {
      const result = await api<{ media: ManagerGalleryMediaView }>(
        `/api/manage/events/${eventId}/media/${photo.id}/favorite`,
        { method: 'PUT', body: JSON.stringify({ favorite: next }) },
      );
      setNotice(null);
      if (favoritesOnly && !next) {
        const removedIndex = rows.findIndex((item) => item.id === photo.id);
        setRows((current) => current.filter((item) => item.id !== photo.id));
        if (viewerIndex !== null && rows[viewerIndex]?.id === photo.id) {
          setViewerIndex(null);
          const nextRows = rows.filter((item) => item.id !== photo.id);
          const target = nextRows[Math.min(removedIndex, nextRows.length - 1)];
          if (target) (tileFor(target) ?? resultsRef.current?.querySelector<HTMLElement>('h3'))?.focus();
          else emptyRef.current?.focus();
        }
      } else {
        setRows((current) => current.map((item) => (
          item.id === photo.id ? result.media : item
        )));
      }
    } catch (caught) {
      setRows((current) => current.map((item) => (
        item.id === photo.id ? { ...item, isFavorite: confirmed } : item
      )));
      setNotice(caught instanceof ClientApiError
        ? caught.message
        : 'The manager action could not be completed.');
    }
  }

  function submitSearch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = queryInput.trim();
    if ([...trimmed].length < 1 || [...trimmed].length > SEARCH_MAX_CODE_POINTS) {
      setNotice(`Search must contain between 1 and ${SEARCH_MAX_CODE_POINTS} characters.`);
      return;
    }
    focusResults.current = true;
    setQuery(trimmed);
  }

  function clearSearch() {
    setQueryInput('');
    focusResults.current = true;
    setQuery('');
  }

  function toggleFavorites() {
    focusResults.current = true;
    setFavoritesOnly((current) => !current);
  }

  let content;
  if (loading) {
    content = <LoadingState label="Opening the private gallery…" />;
  } else if (loadFailure) {
    content = <ErrorState
      message={loadFailure}
      recoveryHint="Reload the manager to try again."
      onRetry={() => {
        setLoadFailure(null);
        setRetryEpoch((current) => current + 1);
      }}
    />;
  } else if (rows.length === 0) {
    if (query) {
      content = <div className="empty-state">
        <Search aria-hidden="true" />
        <h3 ref={emptyRef} tabIndex={-1}>No photos match this search.</h3>
        <p>The search for "{query}" found nothing in this event.</p>
        <button type="button" className="button button--secondary" onClick={clearSearch}>Clear search</button>
      </div>;
    } else if (favoritesOnly) {
      content = <div className="empty-state">
        <h3 ref={emptyRef} tabIndex={-1}>No favorites yet.</h3>
        <p>The heart on any photo adds it to this shared event list.</p>
        <button type="button" className="button button--secondary" onClick={toggleFavorites}>Show every photo</button>
      </div>;
    } else {
      content = <div className="empty-state">
        <h3 ref={emptyRef} tabIndex={-1}>No photos have been delivered yet.</h3>
        <p>New private deliveries appear in Live Intake as guests send them.</p>
      </div>;
    }
  } else {
    content = <div ref={resultsRef}>
      <GalleryTimeline
        photos={rows}
        timeZone={event.eventTimezone}
        hasMore={cursor !== null}
        loadingMore={loadingMore}
        onLoadMore={() => void loadMore()}
        onOpen={openViewer}
        onFavorite={(photo) => void toggleFavorite(photo)}
      />
    </div>;
  }

  return <div className="gallery-private">
    <form className="gallery-search" role="search" onSubmit={submitSearch}>
      <label htmlFor="gallery-search-input">Find photos</label>
      <input
        id="gallery-search-input"
        value={queryInput}
        placeholder="Contributor, caption, or filename"
        onChange={(change) => setQueryInput(change.target.value)}
      />
      <button type="submit" className="button button--secondary">Search</button>
      {query && <button type="button" className="text-button" onClick={clearSearch}>Clear</button>}
      <button
        type="button"
        className={`button ${favoritesOnly ? 'button--approve' : 'button--secondary'}`}
        aria-pressed={favoritesOnly}
        onClick={toggleFavorites}
      >Favorites</button>
    </form>
    {notice && <div className="manager-action-error" role="alert">
      <div className="manager-action-error__summary">
        <div className="manager-action-error__alert">{notice}</div>
        <button
          type="button"
          className="manager-action-error__dismiss"
          aria-label="Dismiss error"
          onClick={() => setNotice(null)}
        ><X aria-hidden="true" /></button>
      </div>
    </div>}
    {content}
    {viewerIndex !== null && <GalleryViewer
      photos={rows}
      index={viewerIndex}
      timeZone={event.eventTimezone}
      onIndexChange={changeViewerIndex}
      onClose={closeViewer}
      onFavorite={(photo) => void toggleFavorite(photo)}
    />}
  </div>;
}

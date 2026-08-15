import { Search, X } from 'lucide-react';
import { useCallback, useEffect, useReducer, useRef, useState, type FormEvent } from 'react';

import { api, ClientApiError } from '../../app/api';
import { ErrorState, LoadingState } from '../../components/States';
import type { EventView, ManagerGalleryMediaView } from '../../../shared/contracts';
import { GalleryTimeline } from './GalleryTimeline';
import { GalleryViewer } from './GalleryViewer';

const SEARCH_MAX_CODE_POINTS = 120;

interface ManagerPrivateGalleryProps {
  event: EventView;
  eventId: string;
  active?: boolean;
}

interface GalleryPage {
  media: ManagerGalleryMediaView[];
  nextCursor: string | null;
}

interface FocusRequest {
  sequence: number;
  targetId: string | null;
}

interface GalleryRowsState {
  rows: ManagerGalleryMediaView[];
  focusRequest: FocusRequest | null;
  focusSequence: number;
}

type GalleryRowsAction =
  | { type: 'replace'; rows: ManagerGalleryMediaView[] }
  | { type: 'append'; rows: ManagerGalleryMediaView[] }
  | { type: 'favorite'; id: string; favorite: boolean }
  | { type: 'confirm'; photo: ManagerGalleryMediaView }
  | { type: 'remove'; id: string; requestFocus: boolean }
  | { type: 'focus-complete'; sequence: number };

interface GalleryNotice {
  message: string;
  retry: 'replace' | 'append' | null;
}

function galleryRowsReducer(state: GalleryRowsState, action: GalleryRowsAction): GalleryRowsState {
  switch (action.type) {
    case 'replace':
      return { ...state, rows: action.rows, focusRequest: null };
    case 'append': {
      const known = new Set(state.rows.map((item) => item.id));
      return { ...state, rows: [...state.rows, ...action.rows.filter((item) => !known.has(item.id))] };
    }
    case 'favorite':
      return {
        ...state,
        rows: state.rows.map((item) => (
          item.id === action.id ? { ...item, isFavorite: action.favorite } : item
        )),
      };
    case 'confirm':
      return {
        ...state,
        rows: state.rows.map((item) => item.id === action.photo.id ? action.photo : item),
      };
    case 'remove': {
      const removedIndex = state.rows.findIndex((item) => item.id === action.id);
      if (removedIndex === -1) return state;
      const nextRows = state.rows.filter((item) => item.id !== action.id);
      if (!action.requestFocus) return { ...state, rows: nextRows };
      const focusSequence = state.focusSequence + 1;
      return {
        rows: nextRows,
        focusSequence,
        focusRequest: {
          sequence: focusSequence,
          targetId: nextRows[Math.min(removedIndex, nextRows.length - 1)]?.id ?? null,
        },
      };
    }
    case 'focus-complete':
      return state.focusRequest?.sequence === action.sequence
        ? { ...state, focusRequest: null }
        : state;
  }
}

function errorMessage(caught: unknown, fallback: string): string {
  return caught instanceof ClientApiError ? caught.message : fallback;
}

export function ManagerPrivateGallery({ event, eventId, active = true }: ManagerPrivateGalleryProps) {
  const [queryInput, setQueryInput] = useState('');
  const [query, setQuery] = useState('');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [rowState, dispatchRows] = useReducer(galleryRowsReducer, {
    rows: [],
    focusRequest: null,
    focusSequence: 0,
  });
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [retryEpoch, setRetryEpoch] = useState(0);
  const [loadFailure, setLoadFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<GalleryNotice | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [viewerPhotoId, setViewerPhotoId] = useState<string | null>(null);
  const [resultsFocusEpoch, setResultsFocusEpoch] = useState(0);
  const [favoritePendingIds, setFavoritePendingIds] = useState<ReadonlySet<string>>(() => new Set());
  const loadGeneration = useRef(0);
  const loadMoreGeneration = useRef(0);
  const loadController = useRef<AbortController | null>(null);
  const loadMoreController = useRef<AbortController | null>(null);
  const confirmedEventId = useRef<string | null>(null);
  const hasConfirmedPage = useRef(false);
  const focusResults = useRef(false);
  const favoriteRequests = useRef(new Set<string>());
  const viewerOrigin = useRef<HTMLElement | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const emptyRef = useRef<HTMLHeadingElement>(null);
  const rows = rowState.rows;

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

  const cancelContinuation = useCallback(() => {
    loadMoreGeneration.current += 1;
    loadMoreController.current?.abort();
    loadMoreController.current = null;
    setLoadingMore(false);
  }, []);

  const beginReplacement = useCallback(() => {
    loadGeneration.current += 1;
    loadController.current?.abort();
    loadController.current = null;
    cancelContinuation();
  }, [cancelContinuation]);

  useEffect(() => {
    const generation = ++loadGeneration.current;
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    cancelContinuation();

    const hadConfirmedPage = confirmedEventId.current === eventId && hasConfirmedPage.current;
    if (confirmedEventId.current !== eventId) {
      confirmedEventId.current = eventId;
      hasConfirmedPage.current = false;
      dispatchRows({ type: 'replace', rows: [] });
    }

    setLoading(true);
    setLoadFailure(null);
    setNotice(null);
    setCursor(null);
    setViewerPhotoId(null);
    viewerOrigin.current = null;

    api<GalleryPage>(galleryPath(query, favoritesOnly), { signal: controller.signal })
      .then((page) => {
        if (generation !== loadGeneration.current) return;
        confirmedEventId.current = eventId;
        hasConfirmedPage.current = true;
        dispatchRows({ type: 'replace', rows: page.media });
        setCursor(page.nextCursor);
        if (focusResults.current) {
          focusResults.current = false;
          setResultsFocusEpoch((current) => current + 1);
        }
      })
      .catch((caught) => {
        if (generation !== loadGeneration.current) return;
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        const message = errorMessage(caught, 'The private gallery could not be loaded.');
        if (hadConfirmedPage) {
          setNotice({ message, retry: 'replace' });
        } else {
          setLoadFailure(message);
        }
      })
      .finally(() => {
        if (generation === loadGeneration.current) {
          setLoading(false);
          loadController.current = null;
        }
      });

    return () => controller.abort();
  }, [cancelContinuation, eventId, favoritesOnly, galleryPath, query, retryEpoch]);

  useEffect(() => {
    if (resultsFocusEpoch === 0) return;
    if (rows.length > 0) {
      resultsRef.current?.querySelector<HTMLElement>('h3')?.focus();
    } else {
      emptyRef.current?.focus();
    }
  }, [resultsFocusEpoch, rows.length]);

  useEffect(() => {
    const request = rowState.focusRequest;
    if (!request) return;
    const target = request.targetId
      ? resultsRef.current?.querySelector<HTMLElement>(
          `[data-photo-id="${request.targetId}"] .gallery-mosaic__open`,
        )
      : emptyRef.current;
    (target ?? resultsRef.current?.querySelector<HTMLElement>('h3'))?.focus();
    dispatchRows({ type: 'focus-complete', sequence: request.sequence });
  }, [rowState.focusRequest]);

  useEffect(() => {
    if (active || viewerPhotoId === null) return;
    setViewerPhotoId(null);
    viewerOrigin.current = null;
  }, [active, viewerPhotoId]);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    const requested = cursor;
    const generation = ++loadMoreGeneration.current;
    const controller = new AbortController();
    loadMoreController.current?.abort();
    loadMoreController.current = controller;
    setLoadingMore(true);
    setNotice((current) => current?.retry === 'append' ? null : current);
    try {
      const page = await api<GalleryPage>(galleryPath(query, favoritesOnly, requested), {
        signal: controller.signal,
      });
      if (generation !== loadMoreGeneration.current) return;
      dispatchRows({ type: 'append', rows: page.media });
      setCursor(page.nextCursor);
    } catch (caught) {
      if (generation !== loadMoreGeneration.current) return;
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      setNotice({
        message: errorMessage(caught, 'The next page of photos could not be loaded.'),
        retry: 'append',
      });
    } finally {
      if (generation === loadMoreGeneration.current) {
        setLoadingMore(false);
        loadMoreController.current = null;
      }
    }
  }

  function tileForId(photoId: string): HTMLElement | null {
    return resultsRef.current
      ?.querySelector<HTMLElement>(`[data-photo-id="${photoId}"] .gallery-mosaic__open`) ?? null;
  }

  function openViewer(photo: ManagerGalleryMediaView, origin: HTMLElement) {
    if (!rows.some((item) => item.id === photo.id)) return;
    viewerOrigin.current = origin;
    setViewerPhotoId(photo.id);
  }

  function changeViewerIndex(index: number) {
    const nextPhoto = rows[index];
    if (!nextPhoto) return;
    setViewerPhotoId(nextPhoto.id);
    viewerOrigin.current = tileForId(nextPhoto.id);
  }

  function closeViewer() {
    setViewerPhotoId(null);
    if (active) viewerOrigin.current?.focus();
    viewerOrigin.current = null;
  }

  async function toggleFavorite(photo: ManagerGalleryMediaView) {
    if (favoriteRequests.current.has(photo.id)) return;
    favoriteRequests.current.add(photo.id);
    setFavoritePendingIds(new Set(favoriteRequests.current));

    const requestGeneration = loadGeneration.current;
    const next = !photo.isFavorite;
    const confirmed = photo.isFavorite;
    dispatchRows({ type: 'favorite', id: photo.id, favorite: next });
    try {
      const result = await api<{ media: ManagerGalleryMediaView }>(
        `/api/manage/events/${eventId}/media/${photo.id}/favorite`,
        { method: 'PUT', body: JSON.stringify({ favorite: next }) },
      );
      if (requestGeneration !== loadGeneration.current) return;
      if (favoritesOnly && !next) {
        const requestFocus = viewerPhotoId === photo.id;
        dispatchRows({ type: 'remove', id: photo.id, requestFocus });
        if (requestFocus) {
          setViewerPhotoId(null);
          viewerOrigin.current = null;
        }
      } else {
        dispatchRows({ type: 'confirm', photo: result.media });
      }
      setAnnouncement(`${photo.originalFilename} ${next ? 'added to' : 'removed from'} favorites.`);
    } catch (caught) {
      if (requestGeneration !== loadGeneration.current) return;
      dispatchRows({ type: 'favorite', id: photo.id, favorite: confirmed });
      setNotice({
        message: errorMessage(caught, 'The manager action could not be completed.'),
        retry: null,
      });
    } finally {
      favoriteRequests.current.delete(photo.id);
      setFavoritePendingIds(new Set(favoriteRequests.current));
    }
  }

  function requestReplacement() {
    focusResults.current = true;
    beginReplacement();
    setNotice(null);
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = queryInput.trim();
    if ([...trimmed].length === 0) {
      if (query) {
        requestReplacement();
        setQuery('');
      } else {
        setNotice({
          message: `Search must contain between 1 and ${SEARCH_MAX_CODE_POINTS} characters.`,
          retry: null,
        });
      }
      return;
    }
    if ([...trimmed].length > SEARCH_MAX_CODE_POINTS) {
      setNotice({
        message: `Search must contain between 1 and ${SEARCH_MAX_CODE_POINTS} characters.`,
        retry: null,
      });
      return;
    }
    requestReplacement();
    setQuery(trimmed);
    if (trimmed === query) setRetryEpoch((current) => current + 1);
  }

  function clearSearch() {
    setQueryInput('');
    if (!query) {
      setNotice(null);
      return;
    }
    requestReplacement();
    setQuery('');
  }

  function toggleFavorites() {
    requestReplacement();
    setFavoritesOnly((current) => !current);
  }

  function retryNotice() {
    if (!notice?.retry) return;
    if (notice.retry === 'append') {
      void loadMore();
      return;
    }
    requestReplacement();
    setRetryEpoch((current) => current + 1);
  }

  let content;
  if (loading && !hasConfirmedPage.current) {
    content = <LoadingState label="Opening the private gallery…" />;
  } else if (loadFailure) {
    content = <ErrorState
      message={loadFailure}
      recoveryHint="Reload the manager to try again."
      onRetry={() => {
        setLoadFailure(null);
        beginReplacement();
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
        key={`${query}\u0000${favoritesOnly ? 'favorites' : 'all'}`}
        photos={rows}
        timeZone={event.eventTimezone}
        hasMore={cursor !== null}
        loadingMore={loadingMore}
        favoritePendingIds={favoritePendingIds}
        onLoadMore={() => void loadMore()}
        onOpen={openViewer}
        onFavorite={(photo) => void toggleFavorite(photo)}
      />
    </div>;
  }

  const viewerIndex = viewerPhotoId === null
    ? null
    : rows.findIndex((photo) => photo.id === viewerPhotoId);

  return <div className="gallery-private" aria-busy={loading || loadingMore}>
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
    {loading && hasConfirmedPage.current && <p className="sr-only" role="status">Updating photos…</p>}
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
    {notice && <div className="manager-action-error" role="alert">
      <div className="manager-action-error__summary">
        <div className="manager-action-error__alert">
          {notice.message}
          {notice.retry && <button
            type="button"
            className="text-button manager-action-error__retry"
            onClick={retryNotice}
          >Try again</button>}
        </div>
        <button
          type="button"
          className="manager-action-error__dismiss"
          aria-label="Dismiss error"
          onClick={() => setNotice(null)}
        ><X aria-hidden="true" /></button>
      </div>
    </div>}
    {content}
    {viewerIndex !== null && viewerIndex >= 0 && <GalleryViewer
      photos={rows}
      index={viewerIndex}
      timeZone={event.eventTimezone}
      favoritePendingIds={favoritePendingIds}
      onIndexChange={changeViewerIndex}
      onClose={closeViewer}
      onFavorite={(photo) => void toggleFavorite(photo)}
    />}
  </div>;
}

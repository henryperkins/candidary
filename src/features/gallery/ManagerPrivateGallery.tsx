import { Check, ListChecks, Search, X } from 'lucide-react';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useReducer, useRef, useState, type FormEvent } from 'react';
import { flushSync } from 'react-dom';

import { api, ClientApiError } from '../../app/api';
import { ErrorState, LoadingState } from '../../components/States';
import {
  DEFAULT_GALLERY_TIMELINE_ORDER,
  ALBUM_MAX_ENTRIES,
  type GalleryTimelineOrder,
} from '../../../shared/constants';
import type { EventView, ManagerGalleryMediaView } from '../../../shared/contracts';
import { galleryPhotoTitle } from './gallery-timeline';
import { GalleryTimeline } from './GalleryTimeline';
import { GalleryViewer, type ViewerContinuationOutcome } from './GalleryViewer';
import { setAlbumPicks } from './album-api';
import {
  transitionSelection,
  type GallerySelectionAction,
} from './selection-state';
import { SelectionTray, type SelectionTrayInput } from './SelectionTray';
import { UNDO_WINDOW_MS, useManagerUndo } from './undo';
import type { GalleryAnchor } from '../../app/manager-history-state';
import {
  captureRenderedGalleryAnchor,
  restoreRenderedGalleryAnchor,
  type GalleryAnchorRestoreOutcome,
} from './gallery-anchor';

const SEARCH_MAX_CODE_POINTS = 120;

interface ManagerPrivateGalleryProps {
  event: EventView;
  eventId: string;
  active?: boolean;
  /** Album membership, for the filter's own label. Owned by the workspace so Album and Library agree. */
  pickCount: number;
  /** Photos and sections share the same persisted album ceiling. */
  albumEntryCount: number;
  onPicksChanged(): void;
  /** Stable Manager boundary used by mount-independent inverse commands. */
  invalidateGalleryAfterMutation(): void;
  live?: boolean;
  onAnnouncement?(message: string): void;
  onAnchorReady?(): void;
}

export interface ManagerPrivateGalleryHandle {
  captureAnchor(effectiveVisibleTop: number): GalleryAnchor | null;
  restoreAnchor(anchor: GalleryAnchor, effectiveVisibleTop: number): GalleryAnchorRestoreOutcome;
}

interface GalleryPage {
  media: ManagerGalleryMediaView[];
  nextCursor: string | null;
}

type NextPageResult =
  | { status: 'appended'; page: GalleryPage; rows: ManagerGalleryMediaView[] }
  | { status: 'unavailable' }
  | { status: 'failed'; caught: unknown }
  | { status: 'retired' };

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

function createAlbumPicksInverse(
  eventId: string,
  changedIds: readonly string[],
  restorePicked: boolean,
  invalidateGalleryAfterMutation: () => void,
): () => Promise<void> {
  const frozenChangedIds = Object.freeze([...changedIds]);
  if (restorePicked) {
    return async () => {
      try {
        await setAlbumPicks(eventId, frozenChangedIds, true);
      } finally {
        invalidateGalleryAfterMutation();
      }
    };
  }
  return async () => {
    try {
      await setAlbumPicks(eventId, frozenChangedIds, false);
    } finally {
      invalidateGalleryAfterMutation();
    }
  };
}

function focusPresentationFallback(target: HTMLElement | null): HTMLElement | null {
  if (target === null) return null;
  if (!target.matches('button, a[href], input, select, textarea, [tabindex]')) target.tabIndex = -1;
  target.focus({ preventScroll: true });
  return target;
}

function connectedPresentationFallback(target: HTMLElement | null): HTMLElement | null {
  return target?.isConnected ? target : null;
}

export const ManagerPrivateGallery = forwardRef<ManagerPrivateGalleryHandle, ManagerPrivateGalleryProps>(function ManagerPrivateGallery({
  event,
  eventId,
  active = true,
  pickCount,
  albumEntryCount,
  onPicksChanged,
  invalidateGalleryAfterMutation,
  live = true,
  onAnnouncement,
  onAnchorReady,
}, ref) {
  const [queryInput, setQueryInput] = useState('');
  const [query, setQuery] = useState('');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [order, setOrder] = useState<GalleryTimelineOrder>(DEFAULT_GALLERY_TIMELINE_ORDER);
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
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const selectedIdsRef = useRef<ReadonlySet<string>>(selectedIds);
  const [bulkBusy, setBulkBusy] = useState(false);
  const undo = useManagerUndo();
  const loadGeneration = useRef(0);
  const loadMoreGeneration = useRef(0);
  const loadController = useRef<AbortController | null>(null);
  const loadMoreController = useRef<AbortController | null>(null);
  const nextPageRequest = useRef<Promise<NextPageResult> | null>(null);
  const rowsRef = useRef<ManagerGalleryMediaView[]>([]);
  const cursorRef = useRef<string | null>(null);
  const confirmedEventId = useRef<string | null>(null);
  const hasConfirmedPage = useRef(false);
  const focusResults = useRef(false);
  const handledResultsFocusEpoch = useRef(0);
  const favoriteRequests = useRef(new Set<string>());
  const viewerOrigin = useRef<HTMLElement | null>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const selectToggleRef = useRef<HTMLButtonElement>(null);
  const restoreSelectionFocus = useRef(false);
  const resultsRef = useRef<HTMLDivElement>(null);
  const emptyRef = useRef<HTMLHeadingElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const rows = rowState.rows;

  const commitRows = useCallback((
    action: GalleryRowsAction,
    synchronizedRows?: ManagerGalleryMediaView[],
  ) => {
    rowsRef.current = synchronizedRows ?? galleryRowsReducer({
      rows: rowsRef.current,
      focusRequest: null,
      focusSequence: 0,
    }, action).rows;
    dispatchRows(action);
  }, []);

  useImperativeHandle(ref, () => ({
    captureAnchor: (effectiveVisibleTop) => rootRef.current
      ? captureRenderedGalleryAnchor(rootRef.current, 'media', effectiveVisibleTop)
      : null,
    restoreAnchor: (anchor, effectiveVisibleTop) => {
      const root = rootRef.current;
      if ((loading && !hasConfirmedPage.current) || root === null) return 'pending';
      return restoreRenderedGalleryAnchor(root, anchor, effectiveVisibleTop);
    },
  }), [loading]);

  useLayoutEffect(() => {
    if (!active || loading || rootRef.current === null) return;
    onAnchorReady?.();
  }, [active, loading, onAnchorReady]);

  useEffect(() => {
    if (!live && announcement) onAnnouncement?.(announcement);
  }, [announcement, live, onAnnouncement]);

  const galleryPath = useCallback((
    nextQuery: string,
    nextFavorites: boolean,
    nextOrder: GalleryTimelineOrder,
    nextCursor?: string,
  ) => {
    const params = new URLSearchParams();
    if (nextQuery) params.set('query', nextQuery);
    if (nextFavorites) params.set('favorites', '1');
    // Always explicit: a cursor is cut for one direction and the server refuses to
    // replay it against the other, so the order can never be left to a default drift.
    params.set('order', nextOrder);
    if (nextCursor) params.set('cursor', nextCursor);
    const search = params.toString();
    return `/api/manage/events/${eventId}/gallery${search ? `?${search}` : ''}`;
  }, [eventId]);

  const retireContinuation = useCallback(() => {
    loadMoreGeneration.current += 1;
    loadMoreController.current?.abort();
    loadMoreController.current = null;
    nextPageRequest.current = null;
  }, []);

  const cancelContinuation = useCallback(() => {
    retireContinuation();
    setLoadingMore(false);
  }, [retireContinuation]);

  useEffect(() => () => {
    // Owner teardown must fence even an abort-insensitive response. Do not call
    // cancelContinuation here: its loading-state write would target an unmounted owner.
    retireContinuation();
  }, [retireContinuation]);

  const beginReplacement = useCallback(() => {
    loadGeneration.current += 1;
    loadController.current?.abort();
    loadController.current = null;
    cancelContinuation();
    // A continuation can be requested before the replacement effect runs. Retire the
    // previous query's cursor synchronously so it cannot append into the new query, but
    // retain the confirmed rows that stay rendered if this same-event replacement fails.
    cursorRef.current = null;
  }, [cancelContinuation]);

  useEffect(() => {
    const generation = ++loadGeneration.current;
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    cancelContinuation();
    cursorRef.current = null;

    const hadConfirmedPage = confirmedEventId.current === eventId && hasConfirmedPage.current;
    if (confirmedEventId.current !== eventId) {
      confirmedEventId.current = eventId;
      hasConfirmedPage.current = false;
      commitRows({ type: 'replace', rows: [] }, []);
    }

    setLoading(true);
    setLoadFailure(null);
    setNotice(null);
    setCursor(null);
    setViewerPhotoId(null);
    viewerOrigin.current = null;

    api<GalleryPage>(galleryPath(query, favoritesOnly, order), { signal: controller.signal })
      .then((page) => {
        if (generation !== loadGeneration.current) return;
        confirmedEventId.current = eventId;
        hasConfirmedPage.current = true;
        cursorRef.current = page.nextCursor;
        commitRows({ type: 'replace', rows: page.media }, page.media);
        setCursor(page.nextCursor);
        if (focusResults.current) {
          focusResults.current = false;
          setResultsFocusEpoch((current) => current + 1);
        }
      })
      .catch((caught) => {
        if (generation !== loadGeneration.current) return;
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        const message = errorMessage(caught, 'Library could not be loaded.');
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
  }, [cancelContinuation, commitRows, eventId, favoritesOnly, galleryPath, order, query, retryEpoch]);

  useEffect(() => {
    if (
      resultsFocusEpoch === 0
      || handledResultsFocusEpoch.current === resultsFocusEpoch
    ) return;
    handledResultsFocusEpoch.current = resultsFocusEpoch;
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
    if (active) return;
    if (selectedIdsRef.current.size > 0) clearSelection();
    if (viewerPhotoId !== null) {
      setViewerPhotoId(null);
      viewerOrigin.current = null;
    }
  }, [active, selectedIds.size, viewerPhotoId]);

  /**
   * The viewer inerts the rest of the document while it is open, and an inert element
   * cannot take focus. Restoring inside the close handler ran before React had torn the
   * dialog down, so `focus()` was a silent no-op and the host was left on `<body>` with
   * their place in the mosaic gone. A passive effect runs after the viewer's own layout
   * cleanup has removed `inert`, which is the first moment the tile can accept focus.
   * jsdom does not implement inert focus semantics, so only a real browser sees this.
   */
  useEffect(() => {
    if (viewerPhotoId !== null) return;
    const target = restoreFocus.current;
    restoreFocus.current = null;
    target?.focus();
  }, [viewerPhotoId]);

  /**
   * Owns exactly one continuation request and commits its merged page before either
   * presentation path observes it. Both the mosaic and viewer consume this result;
   * only their wrappers choose where (or whether) to show a failure.
   */
  function appendNextPage(): Promise<NextPageResult> {
    if (nextPageRequest.current) return nextPageRequest.current;
    const requested = cursorRef.current;
    if (requested === null) return Promise.resolve({ status: 'unavailable' });

    const generation = ++loadMoreGeneration.current;
    const controller = new AbortController();
    loadMoreController.current = controller;
    setLoadingMore(true);
    const request = (async () => {
      try {
        const page = await api<GalleryPage>(galleryPath(query, favoritesOnly, order, requested), {
          signal: controller.signal,
        });
        if (generation !== loadMoreGeneration.current) return { status: 'retired' };
        const known = new Set(rowsRef.current.map(({ id }) => id));
        const merged = [
          ...rowsRef.current,
          ...page.media.filter(({ id }) => !known.has(id)),
        ];
        // Keep the continuation source of truth ahead of React's asynchronous dispatch.
        cursorRef.current = page.nextCursor;
        commitRows({ type: 'append', rows: page.media }, merged);
        setCursor(page.nextCursor);
        return { status: 'appended', page, rows: merged };
      } catch (caught) {
        if (
          generation !== loadMoreGeneration.current
          || (caught instanceof DOMException && caught.name === 'AbortError')
        ) return { status: 'retired' };
        return { status: 'failed', caught };
      } finally {
        if (generation === loadMoreGeneration.current) {
          setLoadingMore(false);
          loadMoreController.current = null;
        }
      }
    })();
    nextPageRequest.current = request;
    void request.then(
      () => {
        if (nextPageRequest.current === request) nextPageRequest.current = null;
      },
      () => {
        if (nextPageRequest.current === request) nextPageRequest.current = null;
      },
    );
    return request;
  }

  async function loadMore() {
    if (cursorRef.current === null && nextPageRequest.current === null) return;
    setNotice((current) => current?.retry === 'append' ? null : current);
    const result = await appendNextPage();
    if (result.status !== 'failed') return;
    setNotice({
      message: errorMessage(result.caught, 'The next page of photos could not be loaded.'),
      retry: 'append',
    });
  }

  async function loadNextAfter(photoId: string): Promise<ViewerContinuationOutcome> {
    const result = await appendNextPage();
    if (result.status === 'appended') {
      const currentIndex = result.rows.findIndex(({ id }) => id === photoId);
      const successor = currentIndex >= 0 ? result.rows[currentIndex + 1] : undefined;
      if (successor) return { status: 'advanced', nextPhotoId: successor.id };
      return result.page.nextCursor === null ? { status: 'exhausted' } : { status: 'failed' };
    }
    if (result.status === 'unavailable') return { status: 'exhausted' };
    return { status: 'failed' };
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

  function changeViewerPhoto(photoId: string) {
    if (!rowsRef.current.some((photo) => photo.id === photoId)) return;
    setViewerPhotoId(photoId);
  }

  function closeViewer() {
    if (active) restoreFocus.current = viewerOrigin.current;
    setViewerPhotoId(null);
    viewerOrigin.current = null;
  }

  async function toggleFavorite(photo: ManagerGalleryMediaView) {
    if (favoriteRequests.current.has(photo.id)) return;
    const next = !photo.isFavorite;
    if (next && albumEntryCount >= ALBUM_MAX_ENTRIES) {
      setNotice({
        message: `An album holds up to ${ALBUM_MAX_ENTRIES} photos and sections. Remove an entry before adding more.`,
        retry: null,
      });
      return;
    }
    favoriteRequests.current.add(photo.id);
    setFavoritePendingIds(new Set(favoriteRequests.current));

    const requestGeneration = loadGeneration.current;
    const confirmed = photo.isFavorite;
    commitRows({ type: 'favorite', id: photo.id, favorite: next });
    try {
      const result = await api<{ media: ManagerGalleryMediaView }>(
        `/api/manage/events/${eventId}/media/${photo.id}/favorite`,
        { method: 'PUT', body: JSON.stringify({ favorite: next }) },
      );
      if (requestGeneration !== loadGeneration.current) {
        // The write is authoritative even when its optimistic row belonged to a query
        // that has since been replaced. Do not project that old row into the new query;
        // invalidate the shared audience summary and refetch the query on screen.
        onPicksChanged();
        setAnnouncement(next
          ? `${galleryPhotoTitle(photo)} is now In Album. This does not publish it.`
          : `${galleryPhotoTitle(photo)} was removed from Album. The delivered photo remains.`);
        beginReplacement();
        setNotice(null);
        setRetryEpoch((current) => current + 1);
        return;
      }
      if (favoritesOnly && !next) {
        const requestFocus = viewerPhotoId === photo.id;
        commitRows({ type: 'remove', id: photo.id, requestFocus });
        if (requestFocus) {
          setViewerPhotoId(null);
          viewerOrigin.current = null;
        }
      } else {
        commitRows({ type: 'confirm', photo: result.media });
      }
      onPicksChanged();
      setAnnouncement(next
        ? `${galleryPhotoTitle(photo)} is now In Album. This does not publish it.`
        : `${galleryPhotoTitle(photo)} was removed from Album. The delivered photo remains.`);
    } catch (caught) {
      if (requestGeneration !== loadGeneration.current) return;
      commitRows({ type: 'favorite', id: photo.id, favorite: confirmed });
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
    // The selection described the previous result set. Carrying it across a search or a
    // filter change would leave a bulk Album action pointed at photos no longer on screen.
    clearSelection();
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

  function commitSelection(action: GallerySelectionAction) {
    const transition = transitionSelection(selectedIdsRef.current, action);
    selectedIdsRef.current = transition.next;
    setSelectedIds(transition.next);
    if (transition.message !== null) setAnnouncement(transition.message);
  }

  function clearSelection(announce = true, restoreControl = true) {
    if (
      restoreControl
      && document.activeElement instanceof HTMLElement
      && document.activeElement.closest('.selection-tray')
    ) {
      restoreSelectionFocus.current = true;
    } else if (!restoreControl) {
      restoreSelectionFocus.current = false;
    }
    commitSelection({ type: 'clear', announce });
  }

  const restoreSelectionControlFocus = useCallback(() => {
    selectToggleRef.current?.focus();
  }, []);

  useEffect(() => {
    if (selectedIds.size !== 0 || !restoreSelectionFocus.current) return;
    restoreSelectionFocus.current = false;
    restoreSelectionControlFocus();
  }, [restoreSelectionControlFocus, selectedIds.size]);

  function toggleSelecting() {
    if (selecting) clearSelection();
    setSelecting(!selecting);
  }

  function toggleSelected(photo: ManagerGalleryMediaView) {
    commitSelection({
      type: 'toggle',
      id: photo.id,
      label: galleryPhotoTitle(photo),
    });
  }

  /**
   * Adds a whole run, not the eight tiles a collapsed moment happens to be drawing, and
   * stops at the bulk ceiling rather than silently taking a prefix — a host who asked for
   * sixty and got fifty needs to be told which fifty they have.
   */
  function selectMany(photos: readonly ManagerGalleryMediaView[], label: string) {
    commitSelection({
      type: 'select-many',
      ids: photos.map(({ id }) => id),
      label,
    });
  }

  /**
   * Moment selection is a toggle across the whole run, including photos hidden behind
   * the compact eight-tile view. Clearing is checked before the cap, so a full fifty-photo
   * selection can always be backed out of in one action.
   */
  function toggleMoment(photos: readonly ManagerGalleryMediaView[]) {
    commitSelection({
      type: 'toggle-moment',
      ids: photos.map(({ id }) => id),
    });
  }

  function filteredRemovalFallbackId(changedIds: readonly string[]): string | null {
    const removed = new Set(changedIds);
    const firstRemovedIndex = rows.findIndex(({ id }) => removed.has(id));
    if (firstRemovedIndex >= 0) {
      const next = rows.slice(firstRemovedIndex + 1).find(({ id }) => !removed.has(id));
      if (next) return next.id;
      const previous = rows.slice(0, firstRemovedIndex).reverse().find(({ id }) => !removed.has(id));
      if (previous) return previous.id;
    }
    return null;
  }

  function filteredRemovalFallback(targetId: string | null): HTMLElement | null {
    if (targetId !== null) {
      const target = tileForId(targetId);
      if (target !== null) return target;
    }
    return rootRef.current
      ?.closest<HTMLElement>('.manager-gallery')
      ?.querySelector<HTMLElement>('#gallery-workspace-title, h2') ?? null;
  }

  /**
   * The tray's two verbs. The write reports which photos it actually changed, and undo
   * reverses exactly that — so undoing a bulk Pick over a page where four were
   * already in leaves those four in, which is the only reading of undo that is not a
   * second destructive act.
   */
  async function applyPicks(picked: boolean, input: SelectionTrayInput) {
    const ids = [...selectedIdsRef.current];
    if (ids.length === 0 || bulkBusy || !undo.canPresent) return;
    const newPicks = ids.filter((id) => !rows.find((row) => row.id === id)?.isFavorite).length;
    if (picked && albumEntryCount + newPicks > ALBUM_MAX_ENTRIES) {
      setNotice({
        message: `An album holds up to ${ALBUM_MAX_ENTRIES} photos and sections. Remove an entry before adding more.`,
        retry: null,
      });
      return;
    }
    // This accepted forward now owns the Manager's single recovery slot. Retire
    // the older idle/failed offer before the request can yield, so it cannot
    // start running and make the confirmed replacement unpresentable.
    undo.dismiss();
    setBulkBusy(true);
    const requestGeneration = loadGeneration.current;
    try {
      const result = await setAlbumPicks(eventId, ids, picked);
      const changed = result.changed.map((item) => item.id);
      const filteredRemoval = favoritesOnly && !picked;
      const filteredFallbackId = filteredRemoval && changed.length > 0
        ? filteredRemovalFallbackId(changed)
        : null;
      const resultAnnouncement = changed.length === 0
        ? picked
          ? 'Nothing changed — every selected photo was already In Album.'
          : 'Nothing changed — no selected photo was In Album.'
        : `${changed.length} photo${changed.length === 1 ? '' : 's'} ${picked ? 'picked for Album' : 'removed from Album'}.`;
      if (requestGeneration !== loadGeneration.current) {
        // A replacement query now owns the rendered rows and focus. Preserve the
        // confirmed inverse, but reconcile that current query instead of applying a
        // projection calculated from the obsolete result set.
        onPicksChanged();
        setAnnouncement(resultAnnouncement);
        const fallback = connectedPresentationFallback(selectToggleRef.current)
          ?? filteredRemovalFallback(null);
        if (changed.length > 0) {
          undo.present({
            eventId,
            message: picked
              ? `${changed.length} photo${changed.length === 1 ? '' : 's'} picked for Album. Nothing was published.`
              : `${changed.length} photo${changed.length === 1 ? '' : 's'} removed from Album. The delivered photos remain.`,
            durationMs: UNDO_WINDOW_MS,
            input,
            run: createAlbumPicksInverse(
              eventId,
              changed,
              !picked,
              invalidateGalleryAfterMutation,
            ),
          }, { fallback });
        }
        beginReplacement();
        setNotice(null);
        setRetryEpoch((current) => current + 1);
        return;
      }
      const activeBeforeCommit = document.activeElement;
      const establishFallbackFocus = activeBeforeCommit === document.body
        || (activeBeforeCommit instanceof HTMLElement
          && activeBeforeCommit.closest('.selection-tray') !== null);
      // The selected card can be the key of its rendered moment. Commit the canonical
      // removal before resolving focus so React cannot replace the focused survivor in
      // the same turn and leave focus on <body>.
      flushSync(() => {
        for (const id of changed) {
          commitRows(filteredRemoval
            ? { type: 'remove', id, requestFocus: false }
            : { type: 'favorite', id, favorite: picked });
        }
        clearSelection(false, false);
        setSelecting(false);
        setAnnouncement(resultAnnouncement);
      });
      const fallback = connectedPresentationFallback(filteredRemoval && changed.length > 0
        ? filteredRemovalFallback(filteredFallbackId)
        : selectToggleRef.current);
      if (establishFallbackFocus) focusPresentationFallback(fallback);
      onPicksChanged();
      if (changed.length > 0) {
        const run = createAlbumPicksInverse(
          eventId,
          changed,
          !picked,
          invalidateGalleryAfterMutation,
        );
        undo.present({
          eventId,
          message: picked
            ? `${changed.length} photo${changed.length === 1 ? '' : 's'} picked for Album. Nothing was published.`
            : `${changed.length} photo${changed.length === 1 ? '' : 's'} removed from Album. The delivered photos remain.`,
          durationMs: UNDO_WINDOW_MS,
          input,
          run,
        }, { fallback });
      }
      // The Album picks filter is showing a set the write just changed; refetch rather
      // than leaving rows on screen that no longer match their own filter.
      if (filteredRemoval && changed.length > 0) {
        beginReplacement();
        setNotice(null);
        setRetryEpoch((current) => current + 1);
      }
    } catch (caught) {
      setNotice({
        message: errorMessage(caught, 'Those photos could not be changed.'),
        retry: null,
      });
    } finally {
      setBulkBusy(false);
    }
  }

  function chooseOrder(next: GalleryTimelineOrder) {
    if (next === order) return;
    requestReplacement();
    setOrder(next);
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
    content = <LoadingState label="Opening Library…" live={false} />;
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
        <h3 ref={emptyRef} tabIndex={-1}>No photos are In Album yet.</h3>
        <p>
          Choosing <strong>Pick</strong> on a photo makes it In Album for every host on this event.
          It does not publish to the Guest gallery.
        </p>
        <button type="button" className="button button--secondary" onClick={toggleFavorites}>Show every photo</button>
      </div>;
    } else {
      content = <div className="empty-state">
        <h3 ref={emptyRef} tabIndex={-1}>No photos have been delivered yet.</h3>
        <p>New delivered photos appear in Live intake as event guests send them.</p>
      </div>;
    }
  } else {
    content = <div ref={resultsRef}>
      <GalleryTimeline
        key={`${query}\u0000${favoritesOnly ? 'favorites' : 'all'}\u0000${order}`}
        photos={rows}
        timeZone={event.eventTimezone}
        hasMore={cursor !== null}
        loadingMore={loadingMore}
        favoritePendingIds={favoritePendingIds}
        selecting={selecting}
        selectedIds={selectedIds}
        onLoadMore={() => void loadMore()}
        onOpen={openViewer}
        onFavorite={(photo) => void toggleFavorite(photo)}
        onToggleSelected={toggleSelected}
        onSelectMoment={toggleMoment}
      />
    </div>;
  }

  const viewerIndex = viewerPhotoId === null
    ? null
    : rows.findIndex((photo) => photo.id === viewerPhotoId);

  return <div ref={rootRef} className="gallery-private">
    <form className="gallery-search" role="search" onSubmit={submitSearch}>
      <label htmlFor="gallery-search-input">Find photos</label>
      <input
        id="gallery-search-input"
        value={queryInput}
        placeholder="Contributor, caption, or filename"
        onChange={(change) => setQueryInput(change.target.value)}
      />
      <div className="gallery-search__actions">
        <button type="submit" className="button button--secondary">Search</button>
        {query && <button type="button" className="text-button" onClick={clearSearch}>Clear</button>}
        {/* The count lives here rather than in the tray. In the flow it covers nothing, and
            it is the one place a host can see how big the album has grown without leaving
            the photographs they are picking from. */}
        <button
          type="button"
          className="button button--secondary gallery-search__favorites"
          aria-pressed={favoritesOnly}
          onClick={toggleFavorites}
        ><Check aria-hidden="true" /> Album picks{pickCount > 0 ? ` (${pickCount})` : ''}</button>
      </div>
    </form>
    {/* Named for the photograph the host lands on, not for the sort key. "Newest first"
        opens on the last dance; "Earliest first" opens on the empty room. */}
    <div className="gallery-order" role="group" aria-label="Photo order">
      <button
        type="button"
        aria-pressed={order === 'newest'}
        className={order === 'newest' ? 'active' : ''}
        onClick={() => chooseOrder('newest')}
      >Newest first</button>
      <button
        type="button"
        aria-pressed={order === 'earliest'}
        className={order === 'earliest' ? 'active' : ''}
        onClick={() => chooseOrder('earliest')}
      >Earliest first</button>
    </div>
    <div className="gallery-selection-controls">
      <button
        type="button"
        ref={selectToggleRef}
        className="button button--secondary gallery-select-toggle"
        aria-pressed={selecting}
        onClick={toggleSelecting}
      ><ListChecks aria-hidden="true" /> {selecting ? 'Done selecting' : 'Select photos'}</button>
      {selecting && rows.length > 0 && <button
        type="button"
        className="text-button"
        onClick={() => selectMany(rows, 'these results')}
      >Select all {rows.length} loaded photo{rows.length === 1 ? '' : 's'}</button>}
    </div>
    {loading && hasConfirmedPage.current && <p className="sr-only" role={live ? 'status' : undefined}>Updating photos…</p>}
    <p
      className="sr-only"
      role={live ? 'status' : undefined}
      aria-live={live ? 'polite' : undefined}
      aria-atomic={live ? 'true' : undefined}
    >{announcement}</p>
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
    {/* Busy scopes the results, not the surface: on the container it swept in the search
        field, so a host's own input sat inside a busy region during every load. */}
    <div aria-busy={loading || loadingMore}>{content}</div>
    {selectedIds.size > 0 && <SelectionTray
      count={selectedIds.size}
      busy={bulkBusy}
      mutationLocked={!undo.canPresent}
      onAdd={(input) => void applyPicks(true, input)}
      onRemove={(input) => void applyPicks(false, input)}
      onClear={clearSelection}
    />}
    {viewerPhotoId !== null && viewerIndex !== null && viewerIndex >= 0 && <GalleryViewer
      photos={rows}
      photoId={viewerPhotoId}
      timeZone={event.eventTimezone}
      hasMore={cursor !== null}
      favoritePendingIds={favoritePendingIds}
      onPhotoChange={changeViewerPhoto}
      loadNextAfter={loadNextAfter}
      onClose={closeViewer}
      onFavorite={(photo) => void toggleFavorite(photo)}
      live={live}
      onAnnouncement={onAnnouncement}
    />}
  </div>;
});

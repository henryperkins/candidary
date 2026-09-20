import { Minus, Plus, Search, SquareDashedMousePointer, X } from 'lucide-react';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useReducer, useRef, useState, type FormEvent } from 'react';
import { flushSync } from 'react-dom';

import { api, ClientApiError } from '../../app/api';
import { describeLoadFailure, type LoadFailure, ErrorState, LoadingState } from '../../components/States';
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
import type { PhotoExportSource } from '../../../shared/photo-exports';
import { emptySelection, selectAll, togglePhoto, isPhotoSelected, editingIds, selectionLabel, toPhotoExportSource } from './photo-export-selection';
import { UNDO_WINDOW_MS, useManagerUndo } from './undo';
import type { GalleryAnchor } from '../../app/manager-history-state';
import {
  captureRenderedGalleryAnchor,
  galleryEffectiveVisibleTop,
  restoreRenderedGalleryAnchor,
  type GalleryAnchorRestoreOutcome,
} from './gallery-anchor';
import type { LibraryPage } from '../../../shared/library-arrivals';
import type { LibraryChange, LibraryFileActions } from './library-file-actions';
import { readLibraryWindow, type LibraryArrivalExpectation } from './library-arrivals';
import { useLibraryArrivals } from './use-library-arrivals';
import './library-photo-wall.css';

const SEARCH_MAX_CODE_POINTS = 120;

interface ManagerPrivateGalleryProps {
  event: EventView;
  eventId: string;
  active?: boolean;
  suspended?: boolean;
  readsPaused?: boolean;
  libraryChange?: LibraryChange;
  fileActions?: LibraryFileActions;
  reconciliationVersion?: string;
  deliveryVersion?: number;
  onEscalate?(failure: LoadFailure): void;
  onArrivalsAccepted?(): void;
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
  photoExportEnabled?: boolean;
  onPhotoExport?(source: PhotoExportSource, origin: HTMLElement): void;
  onPhotoExportSourceChange?(): void;
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
  retry: 'replace' | 'append' | 'reconcile' | { photo: ManagerGalleryMediaView } | null;
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
  suspended = false,
  readsPaused = false,
  libraryChange,
  fileActions,
  reconciliationVersion = '',
  deliveryVersion = 0,
  onEscalate,
  onArrivalsAccepted,
  pickCount,
  albumEntryCount,
  onPicksChanged,
  invalidateGalleryAfterMutation,
  live = true,
  onAnnouncement,
  onAnchorReady,
  photoExportEnabled = false,
  onPhotoExport,
  onPhotoExportSourceChange,
}, ref) {
  const [queryInput, setQueryInput] = useState('');
  const [query, setQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
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
  const [photoSelection, setPhotoSelection] = useState(() => emptySelection('library'));
  const photoSelectionRef = useRef(photoSelection);
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
  const confirmedRequest = useRef<string | null>(null);
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
  const [snapshotSequence, setSnapshotSequence] = useState<number | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [arrivalError, setArrivalError] = useState(false);
  const [reconciliationRetryEpoch, setReconciliationRetryEpoch] = useState(0);
  const failedReconciliation = useRef<string | null>(null);
  const [readsBlocked, setReadsBlocked] = useState(false);
  const stagedController = useRef<AbortController | null>(null);
  const mutationGeneration = useRef(0);
  const arrivalButton = useRef<HTMLButtonElement>(null);
  const currentViewer = useRef(viewerPhotoId); currentViewer.current = viewerPhotoId;
  const viewerTrash = useRef<{ id: string; owner: string; before: string[]; confirmed: boolean } | null>(null);
  const ownerKey = JSON.stringify([eventId, query, favoritesOnly, order]);
  useLayoutEffect(() => { setArrivalError(false); }, [ownerKey, snapshotSequence]);
  const currentOwner = useRef(ownerKey); currentOwner.current = ownerKey;
  const visibleOwner = useRef(false); visibleOwner.current = active && !suspended && !readsPaused && !readsBlocked;
  const retireStaging = useCallback(() => {
    mutationGeneration.current++;
    stagedController.current?.abort(); stagedController.current = null;
    setAccepting(false);
  }, []);
  const escalate = useCallback((failure: LoadFailure) => {
    setReadsBlocked(true); retireStaging(); onEscalate?.(failure);
  }, [onEscalate, retireStaging]);
  const arrivals = useLibraryArrivals({ eventId, query, favorites: favoritesOnly, order,
    snapshotSequence, active: active && !suspended,
    paused: readsPaused || readsBlocked || loading || accepting,
    onEscalate: escalate });
  useEffect(() => {
    if (arrivals.count > 0) setAnnouncement(`${arrivals.count} new ${arrivals.count === 1 ? 'photo' : 'photos'} available.`);
  }, [arrivals.count]);
  useLayoutEffect(() => {
    retireStaging();
    return () => { mutationGeneration.current++; stagedController.current?.abort(); };
  }, [ownerKey, active, suspended, readsPaused, retireStaging]);

  const commitRows = useCallback((
    action: GalleryRowsAction,
    synchronizedRows?: ManagerGalleryMediaView[],
  ) => {
    if (action.type === 'favorite' || action.type === 'confirm' || action.type === 'remove') retireStaging();
    rowsRef.current = synchronizedRows ?? galleryRowsReducer({
      rows: rowsRef.current,
      focusRequest: null,
      focusSequence: 0,
    }, action).rows;
    dispatchRows(action);
  }, [retireStaging]);

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
    snapshot?: number,
  ) => {
    const params = new URLSearchParams({ live: '1' });
    if (snapshot !== undefined) params.set('snapshot', String(snapshot));
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

  useEffect(() => { if (suspended || readsPaused || readsBlocked) cancelContinuation(); }, [suspended, readsPaused, readsBlocked, cancelContinuation]);

  const beginReplacement = useCallback(() => {
    retireStaging();
    loadGeneration.current += 1;
    loadController.current?.abort();
    loadController.current = null;
    cancelContinuation();
    // A continuation can be requested before the replacement effect runs. Retire the
    // previous query's cursor synchronously so it cannot append into the new query, but
    // retain the confirmed rows that stay rendered if this same-event replacement fails.
    cursorRef.current = null;
    // A remembered successful query is not reusable after its cursor/sequence
    // ownership has been retired, even if another query fails back to its rows.
    confirmedRequest.current = null;
  }, [cancelContinuation, retireStaging]);

  useEffect(() => {
    if (readsPaused || suspended || readsBlocked) return;
    const requestKey = JSON.stringify([eventId, query, favoritesOnly, order, retryEpoch]);
    if (confirmedRequest.current === requestKey) return;
    confirmedRequest.current = null;
    const generation = ++loadGeneration.current;
    setSnapshotSequence(null);
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

    api<LibraryPage>(galleryPath(query, favoritesOnly, order), { signal: controller.signal })
      .then((page) => {
        if (generation !== loadGeneration.current) return;
        confirmedEventId.current = eventId;
        confirmedRequest.current = requestKey;
        hasConfirmedPage.current = true;
        setSnapshotSequence(page.snapshotSequence ?? null);
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
        const failure = describeLoadFailure(caught, 'manager', 'Library could not be loaded.');
        if (!failure.retryable) escalate(failure);
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

    return () => { controller.abort(); loadGeneration.current++; };
  }, [cancelContinuation, commitRows, eventId, favoritesOnly, galleryPath, order, query, retryEpoch, readsPaused, suspended, readsBlocked, escalate]);

  useEffect(() => {
    if (
      resultsFocusEpoch === 0
      || handledResultsFocusEpoch.current === resultsFocusEpoch
    ) return;
    handledResultsFocusEpoch.current = resultsFocusEpoch;
    if (rows.length > 0) {
      resultsRef.current?.querySelector<HTMLElement>('.gallery-mosaic__open, h3')?.focus();
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
    (target ?? resultsRef.current?.querySelector<HTMLElement>('.gallery-mosaic__open, h3'))?.focus();
    dispatchRows({ type: 'focus-complete', sequence: request.sequence });
  }, [rowState.focusRequest]);

  useEffect(() => {
    if (active) return;
    if (selectedIdsRef.current.size > 0 || photoSelectionRef.current.mode === 'all' || (photoSelectionRef.current.mode === 'ids' && photoSelectionRef.current.mediaIds.length > 0)) clearSelection(false, false);
    if (viewerPhotoId !== null) {
      setViewerPhotoId(null);
      viewerOrigin.current = null;
    }
  }, [active, selectedIds.size, viewerPhotoId]);

  useLayoutEffect(() => {
    if (!suspended || viewerPhotoId === null) return;
    setViewerPhotoId(null);
    viewerOrigin.current = null;
    viewerTrash.current = null;
  }, [suspended, viewerPhotoId]);

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
    retireStaging();
    if (nextPageRequest.current) return nextPageRequest.current;
    const requested = cursorRef.current;
    if (requested === null) return Promise.resolve({ status: 'unavailable' });

    const generation = ++loadMoreGeneration.current;
    const controller = new AbortController();
    loadMoreController.current = controller;
    setLoadingMore(true);
    const request: Promise<NextPageResult> = (async () => {
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
    if (viewerTrash.current?.id === photoId && viewerTrash.current.confirmed
      && !rowsRef.current.some(photo => photo.id === photoId)) return continueAfterTrash();
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

  async function reconcileWindow(sequence: number, deliberate: boolean, changeToConsume?: string, expectedArrivals?: LibraryArrivalExpectation) {
    if (!visibleOwner.current || loading || nextPageRequest.current) return;
    retireStaging();
    const generation = mutationGeneration.current;
    const owner = currentOwner.current;
    const controller = new AbortController(); stagedController.current = controller;
    const boundary = rowsRef.current.at(-1) ?? null;
    setAccepting(true); setArrivalError(false);
    try {
      const page = await readLibraryWindow({ snapshotSequence: sequence, boundary, order, signal: controller.signal,
        arrivals: expectedArrivals,
        fetchPage: request => api<LibraryPage>(galleryPath(query, favoritesOnly, order, request.cursor, request.snapshotSequence), { signal: request.signal }) });
      if (controller.signal.aborted || generation !== mutationGeneration.current || owner !== currentOwner.current || !visibleOwner.current) return;
      // Re-read interaction state at adoption. Selection refs stay owned by their existing
      // controllers; neither explicit off-page IDs nor all-matching exclusions are rewritten.
      const viewer = currentViewer.current;
      const root = rootRef.current;
      const top = galleryEffectiveVisibleTop();
      const anchor = root ? captureRenderedGalleryAnchor(root, 'media', top) : null;
      const focused = document.activeElement;
      const focusWasArrival = focused === arrivalButton.current;
      if (changeToConsume !== undefined && preparedChangeKey.current === changeToConsume) {
        // Adoption, rather than dispatch, fulfills a confirmed mutation. Aborted
        // windows leave this obligation pending for the next usable activation.
        consumedChange.current = changeToConsume;
        failedReconciliation.current = null;
      }
      flushSync(() => {
        commitRows({ type: 'replace', rows: page.media }, page.media);
        cursorRef.current = page.nextCursor; setCursor(page.nextCursor);
        setSnapshotSequence(page.snapshotSequence);
        if (viewer !== null && !page.media.some(photo => photo.id === viewer)) {
          setViewerPhotoId(null); viewerOrigin.current = null;
        }
      });
      if (root && anchor) restoreRenderedGalleryAnchor(root, anchor, top);
      if (focusWasArrival || (focused instanceof HTMLElement && !focused.isConnected)) {
        const anchorId = anchor?.kind === 'media' ? anchor.mediaId : viewer;
        focusPresentationFallback((anchorId ? tileForId(anchorId) : null)
          ?? resultsRef.current?.querySelector<HTMLElement>('.gallery-mosaic__open')
          ?? root?.closest('.manager-gallery')?.querySelector<HTMLElement>('#gallery-workspace-title')
          ?? root);
      }
      if (deliberate) onArrivalsAccepted?.();
    } catch (caught) {
      if (controller.signal.aborted || generation !== mutationGeneration.current || owner !== currentOwner.current) return;
      const failure = describeLoadFailure(caught, 'manager', 'Could not load new photos. Try again.');
      if (!failure.retryable) escalate(failure);
      else if (deliberate) setArrivalError(true);
      else {
        // Keep the obligation, but wait for the explicit retry control after a
        // failure. The accepting-state transition must not create a retry loop.
        failedReconciliation.current = changeToConsume ?? null;
        setNotice({ message: failure.message, retry: 'reconcile' });
      }
    } finally {
      if (stagedController.current === controller) { stagedController.current = null; setAccepting(false); }
    }
  }
  const reconcileCurrent = useRef(reconcileWindow); reconcileCurrent.current = reconcileWindow;
  const consumedChange = useRef<string | null>(null);
  const consumedChangeOwner = useRef(ownerKey);
  const preparedChangeKey = useRef<string | null>(null);
  const lastLibrarySignal = useRef<string | null>(null);
  const pendingChangeKind = useRef<LibraryChange['kind']>('metadata');
  const changeKey = JSON.stringify([ownerKey, reconciliationVersion, libraryChange?.eventId, libraryChange?.version]);
  useLayoutEffect(() => {
    const signal = libraryChange?.eventId === eventId ? `${eventId}:${libraryChange.version}` : null;
    if (consumedChangeOwner.current !== ownerKey) {
      // The normal query loader owns replacements, including their failure retention.
      consumedChangeOwner.current = ownerKey;
      consumedChange.current = changeKey;
      preparedChangeKey.current = changeKey;
      lastLibrarySignal.current = signal;
      return;
    }
    if (preparedChangeKey.current === changeKey) return;
    const first = preparedChangeKey.current === null;
    preparedChangeKey.current = changeKey;
    pendingChangeKind.current = signal !== null && signal !== lastLibrarySignal.current
      ? libraryChange!.kind : 'metadata';
    lastLibrarySignal.current = signal;
    retireStaging();
    if (pendingChangeKind.current === 'delivered') return;
    // Matching manager signals must not cancel the viewer's post-write continuation.
    if (pendingChangeKind.current === 'trashed' && libraryChange?.mediaIds.length === 1
      && viewerTrash.current?.id === libraryChange.mediaIds[0]
      && viewerTrash.current.owner === currentOwner.current) return;
    cancelContinuation();
    if (!first && loading && loadController.current) {
      beginReplacement(); setRetryEpoch(current => current + 1);
    }
    if (pendingChangeKind.current === 'trashed' && libraryChange) {
      const removed = new Set(libraryChange.mediaIds);
      const old = rowsRef.current;
      const index = old.findIndex(photo => photo.id === currentViewer.current);
      const kept = old.filter(photo => !removed.has(photo.id));
      commitRows({ type: 'replace', rows: kept }, kept);
      const selection = photoSelectionRef.current;
      if (onPhotoExport && selection.mode === 'ids') {
        commitPhotoSelection({ ...selection, mediaIds: selection.mediaIds.filter(id => !removed.has(id)) });
      } else if (!onPhotoExport) {
        const retained = new Set([...selectedIdsRef.current].filter(id => !removed.has(id)));
        selectedIdsRef.current = retained; setSelectedIds(retained);
      }
      if (currentViewer.current && removed.has(currentViewer.current)) {
        const successor = old.slice(index + 1).find(photo => !removed.has(photo.id))
          ?? old.slice(0, index).reverse().find(photo => !removed.has(photo.id));
        setViewerPhotoId(successor?.id ?? null);
        viewerOrigin.current = successor ? tileForId(successor.id) : null;
        if (!successor) restoreFocus.current = rootRef.current;
      }
      onPhotoExportSourceChange?.();
    }
  }, [changeKey, ownerKey, eventId, libraryChange, loading, commitRows, retireStaging, cancelContinuation, beginReplacement, onPhotoExport, onPhotoExportSourceChange]);
  useEffect(() => {
    if (consumedChange.current === changeKey || snapshotSequence === null || !visibleOwner.current || loading) return;
    const initial = consumedChange.current === null;
    if (initial || pendingChangeKind.current === 'trashed' || pendingChangeKind.current === 'delivered') {
      consumedChange.current = changeKey;
      if (!initial && pendingChangeKind.current === 'delivered') void arrivals.checkNow();
      return;
    }
    if (accepting || loadingMore || nextPageRequest.current || failedReconciliation.current === changeKey) return;
    onPhotoExportSourceChange?.();
    void reconcileCurrent.current(snapshotSequence, false, changeKey);
  }, [changeKey, snapshotSequence, active, suspended, readsPaused, loading, accepting, loadingMore, reconciliationRetryEpoch, eventId, libraryChange, arrivals.checkNow, onPhotoExportSourceChange]);
  useEffect(() => { if (deliveryVersion > 0) void arrivals.checkNow(); }, [deliveryVersion, arrivals.checkNow]);

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
    if (active) {
      const origin = viewerOrigin.current;
      const originPhotoId = origin?.closest<HTMLElement>('[data-photo-id]')?.dataset.photoId;
      const connectedOrigin = origin?.isConnected
        && originPhotoId !== undefined
        && rowsRef.current.some(photo => photo.id === originPhotoId)
        ? origin : null;
      restoreFocus.current = connectedOrigin ?? (rowsRef.current.length === 0 ? rootRef.current
        : (currentViewer.current && rowsRef.current.some(photo => photo.id === currentViewer.current)
          ? tileForId(currentViewer.current) : tileForId(rowsRef.current[0]!.id)) ?? rootRef.current);
    }
    setViewerPhotoId(null);
    viewerOrigin.current = null;
    viewerTrash.current = null;
  }

  async function continueAfterTrash(): Promise<ViewerContinuationOutcome> {
    const transaction = viewerTrash.current;
    if (!transaction || transaction.owner !== currentOwner.current) return { status: 'exhausted' };
    const known = new Set(rowsRef.current.map(photo => photo.id));
    while (cursorRef.current !== null) {
      const result = await appendNextPage();
      if (viewerTrash.current !== transaction || transaction.owner !== currentOwner.current) return { status: 'exhausted' };
      if (result.status === 'failed' || result.status === 'retired') return { status: 'failed' };
      if (result.status !== 'appended') break;
      const next = result.rows.find(photo => !known.has(photo.id));
      if (next) return { status: 'advanced', nextPhotoId: next.id };
    }
    const index = transaction.before.indexOf(transaction.id);
    const previous = transaction.before.slice(0, index).reverse()
      .find(id => rowsRef.current.some(photo => photo.id === id));
    return previous ? { status: 'advanced', nextPhotoId: previous } : { status: 'exhausted' };
  }

  async function confirmViewerRemoval(photoId: string): Promise<ViewerContinuationOutcome> {
    const transaction = viewerTrash.current;
    if (!transaction || transaction.id !== photoId || transaction.owner !== currentOwner.current) return { status: 'exhausted' };
    transaction.confirmed = true;
    const kept = rowsRef.current.filter(photo => photo.id !== photoId);
    commitRows({ type: 'replace', rows: kept }, kept);
    const selection = photoSelectionRef.current;
    if (onPhotoExport && selection.mode === 'ids') {
      commitPhotoSelection({ ...selection, mediaIds: selection.mediaIds.filter(id => id !== photoId) });
    } else if (!onPhotoExport) {
      const retained = new Set([...selectedIdsRef.current].filter(id => id !== photoId));
      selectedIdsRef.current = retained; setSelectedIds(retained);
    }
    onPhotoExportSourceChange?.();
    const index = transaction.before.indexOf(photoId);
    const next = transaction.before.slice(index + 1).find(id => kept.some(photo => photo.id === id));
    return next ? { status: 'advanced', nextPhotoId: next } : continueAfterTrash();
  }

  const viewerFileActions: LibraryFileActions | undefined = fileActions && {
    canTrash: fileActions.canTrash,
    async trash(photo, activation) {
      retireStaging(); cancelContinuation();
      const transaction = { id: photo.id, owner: currentOwner.current,
        before: rowsRef.current.map(row => row.id), confirmed: false };
      viewerTrash.current = transaction;
      try {
        const result = await fileActions.trash(photo, activation);
        if (transaction.owner !== currentOwner.current || viewerTrash.current !== transaction) return { status: 'retired' };
        if (result.status === 'retired') viewerTrash.current = null;
        return result;
      } catch (caught) {
        if (viewerTrash.current === transaction) viewerTrash.current = null;
        throw caught;
      }
    },
  };

  async function toggleFavorite(photo: ManagerGalleryMediaView, origin?: HTMLElement, input: 'keyboard' | 'pointer' = 'pointer') {
    if (favoriteRequests.current.has(photo.id) || !undo.canPresent) return;
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
    undo.dismiss();
    setNotice(null);

    const requestGeneration = loadGeneration.current;
    const confirmed = photo.isFavorite;
    try {
      const result = await api<{ media: ManagerGalleryMediaView }>(
        `/api/manage/events/${eventId}/media/${photo.id}/favorite`,
        { method: 'PUT', body: JSON.stringify({ favorite: next }) },
      );
      if (result.media.isFavorite !== confirmed) {
        undo.present({
          eventId,
          message: next ? 'Added to album.' : 'Removed from album.',
          durationMs: UNDO_WINDOW_MS,
          input,
          run: createAlbumPicksInverse(eventId, [photo.id], confirmed, invalidateGalleryAfterMutation),
        }, { fallback: origin ?? rootRef.current });
      }
      if (requestGeneration !== loadGeneration.current) {
        // The write is authoritative even when its original row belonged to a query
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
        retry: { photo: { ...photo, isFavorite: confirmed } },
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
    if (onPhotoExport) {
      let next = photoSelectionRef.current;
      try {
        if (action.type === 'clear') next = emptySelection('library');
        else if (action.type === 'toggle') next = togglePhoto(next, action.id);
        else {
          const remove = action.type === 'toggle-moment' && action.ids.every(id => isPhotoSelected(next, id));
          for (const id of action.ids) if (isPhotoSelected(next, id) === remove) next = togglePhoto(next, id);
        }
        commitPhotoSelection(next);
      } catch (error) { setAnnouncement(errorMessage(error, 'Selection could not be updated.')); }
      return;
    }
    const transition = transitionSelection(selectedIdsRef.current, action);
    selectedIdsRef.current = transition.next;
    setSelectedIds(transition.next);
    if (transition.message !== null) setAnnouncement(transition.message);
  }

  function commitPhotoSelection(next: PhotoExportSource) {
    photoSelectionRef.current = next; setPhotoSelection(next);
    // The established reducer remains the only author of the editing selection.
    const ids = editingIds(next);
    const editing = transitionSelection(new Set(), { type: 'select-many', ids: ids ?? [], label: 'these results' }).next;
    selectedIdsRef.current = editing; setSelectedIds(editing);
    setAnnouncement(selectionLabel(next)); onPhotoExportSourceChange?.();
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

  // Export-only selections can leave the editing projection empty throughout.
  // Restore after the actual selection clears, including all-results and >50 IDs.
  const selectionEmpty = onPhotoExport
    ? photoSelection.mode === 'ids' && photoSelection.mediaIds.length === 0
    : selectedIds.size === 0;
  useEffect(() => {
    if (!selectionEmpty || !restoreSelectionFocus.current) return;
    restoreSelectionFocus.current = false;
    restoreSelectionControlFocus();
  }, [restoreSelectionControlFocus, selectionEmpty]);

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
    if (onPhotoExport && editingIds(photoSelectionRef.current) === null) return;
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
    if (typeof notice.retry === 'object') {
      void toggleFavorite(notice.retry.photo);
      return;
    }
    if (notice.retry === 'reconcile') {
      failedReconciliation.current = null;
      setNotice(null);
      setReconciliationRetryEpoch(current => current + 1);
      return;
    }
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
        <h3 ref={emptyRef} tabIndex={-1}>Your album is waiting for its first photo.</h3>
        <p>
          Choose <strong>Add to album</strong> on a photo to start.
          It does not publish to the Guest gallery.
        </p>
        <button type="button" className="button button--secondary" onClick={toggleFavorites}>Show every photo</button>
      </div>;
    } else {
      content = <div className="empty-state">
        <h3 ref={emptyRef} tabIndex={-1}>No photos have been delivered yet.</h3>
        <p>Photos added by you or your guests appear here.</p>
      </div>;
    }
  } else {
    content = <div ref={resultsRef}>
      <GalleryTimeline
        wall
        key={`${query}\u0000${favoritesOnly ? 'favorites' : 'all'}\u0000${order}`}
        photos={rows}
        timeZone={event.eventTimezone}
        hasMore={cursor !== null}
        loadingMore={loadingMore}
        favoritePendingIds={favoritePendingIds}
        mutationLocked={!undo.canPresent}
        selecting={selecting}
        selectedIds={onPhotoExport ? new Set(rows.filter(photo => isPhotoSelected(photoSelection, photo.id)).map(photo => photo.id)) : selectedIds}
        onLoadMore={() => void loadMore()}
        onOpen={openViewer}
        onFavorite={(photo, origin, input) => void toggleFavorite(photo, origin, input)}
        onToggleSelected={toggleSelected}
        onSelectMoment={toggleMoment}
      />
    </div>;
  }

  return <div ref={rootRef} tabIndex={-1} className="gallery-private gallery-private--wall">
    <form className="gallery-search" role="search" onSubmit={submitSearch}>
      <label className="sr-only" htmlFor="gallery-search-input">Find photos</label>
      <div className="gallery-search__field">
        <input
          id="gallery-search-input"
          ref={searchInputRef}
          value={queryInput}
          placeholder="Search photos"
          aria-describedby="library-search-hint"
          enterKeyHint="search"
          onChange={(change) => setQueryInput(change.target.value)}
        />
        <button
          type="submit"
          className="button button--secondary gallery-search__submit"
          aria-label="Search"
        >
          <Search aria-hidden="true" />
          <span className="gallery-search__submit-label">Search</span>
        </button>
      </div>
      <span id="library-search-hint" className="sr-only">Search by contributor, caption, or filename.</span>
      {query && rows.length > 0 && <button type="button" className="text-button library-search-clear" onClick={clearSearch}>Clear search</button>}
    </form>
    <div className="library-toolbar">
      <label className="library-filter">
        <span className="sr-only">Photos shown</span>
        <select value={favoritesOnly ? 'album' : 'all'} onChange={() => toggleFavorites()}>
          <option value="all">All photos</option>
          <option value="album">In album ({pickCount})</option>
        </select>
      </label>
      <label className="library-sort">
        <span className="sr-only">Photo order</span>
        <select value={order} onChange={event => chooseOrder(event.target.value as GalleryTimelineOrder)}>
          <option value="newest">Newest first</option>
          <option value="earliest">Earliest first</option>
        </select>
      </label>
      <button
        type="button"
        ref={selectToggleRef}
        className="button button--secondary gallery-select-toggle"
        aria-pressed={selecting}
        aria-label={selecting ? 'Done selecting' : 'Select photos'}
        onClick={toggleSelecting}
      ><SquareDashedMousePointer aria-hidden="true" /><span className="sr-only">{selecting ? 'Done selecting' : 'Select photos'}</span></button>
    </div>
    <div className="library-arrivals">
      {arrivals.count > 0 && <button type="button" ref={arrivalButton}
        className="text-button library-arrivals__accept" disabled={accepting}
        onClick={() => {
          if (snapshotSequence !== null && arrivals.latestSnapshotSequence !== null) {
            void reconcileWindow(arrivals.latestSnapshotSequence, true, undefined, { afterSequence: snapshotSequence, count: arrivals.count });
          }
        }}
      >{accepting ? 'Loading new photos…' : `${arrivals.count} new ${arrivals.count === 1 ? 'photo' : 'photos'}`}</button>}
      {arrivalError && arrivals.count > 0 && <span role="alert">Could not load new photos. Try again.</span>}
    </div>
    {/* Under the row, not in it. `Select all n loaded photos` appears only while a selection runs
        and it is a sentence with no short form: in the row it took the phone's four controls from
        195px to 371px against a 265px box at 320, wrapping the row to two lines every time a host
        started selecting. */}
    {selecting && rows.length > 0 && <div className="gallery-selection-controls">
      <button
        type="button"
        className="text-button"
        onClick={() => onPhotoExport
          ? commitPhotoSelection(selectAll({ scope: 'library', filter: { order: order === 'earliest' ? 'oldest' : 'newest', ...(query ? { query } : {}), ...(favoritesOnly ? { favorites: true } : {}) } }))
          : selectMany(rows, 'these results')}
      >{onPhotoExport ? 'Select all matching photos' : `Select all ${rows.length} loaded photo${rows.length === 1 ? '' : 's'}`}</button>
    </div>}
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
    {(onPhotoExport ? photoSelection.mode === 'all' || photoSelection.mediaIds.length > 0 : selectedIds.size > 0) && <SelectionTray
      count={onPhotoExport && photoSelection.mode === 'ids' ? photoSelection.mediaIds.length : selectedIds.size}
      countLabel={onPhotoExport ? selectionLabel(photoSelection) : undefined}
      editingDisabledReason={onPhotoExport && editingIds(photoSelection) === null ? 'Pick and Remove require an explicit selection of 50 photos or fewer.' : undefined}
      exportAction={onPhotoExport && <button type="button" className="button button--primary" disabled={!photoExportEnabled || bulkBusy} onClick={event => onPhotoExport(toPhotoExportSource(photoSelection), event.currentTarget)}>Save / Share photos</button>}
      busy={bulkBusy}
      mutationLocked={!undo.canPresent}
      primary={{
        label: bulkBusy ? 'Working…' : `Pick for Album (${selectedIds.size})`,
        icon: <Plus aria-hidden="true" />,
        onClick: (input) => void applyPicks(true, input),
      }}
      secondary={{
        label: bulkBusy ? 'Working…' : `Remove from Album (${selectedIds.size})`,
        icon: <Minus aria-hidden="true" />,
        onClick: (input) => void applyPicks(false, input),
      }}
      onClear={clearSelection}
    />}
    {viewerPhotoId !== null && !suspended && <GalleryViewer
      photos={rows}
      photoId={viewerPhotoId}
      timeZone={event.eventTimezone}
      hasMore={cursor !== null}
      favoritePendingIds={favoritePendingIds}
      onPhotoChange={changeViewerPhoto}
      loadNextAfter={loadNextAfter}
      onClose={closeViewer}
      onFavorite={(photo) => void toggleFavorite(photo)}
      fileActions={viewerFileActions}
      onTrashConfirmed={confirmViewerRemoval}
      live={live}
      onAnnouncement={onAnnouncement}
    />}
  </div>;
});

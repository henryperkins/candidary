import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import type { ExportDownloadView, ExportView, MediaView } from '../../app/types';
import { api } from '../../app/api';
import type { GalleryMode } from '../../app/manager-location';
import type { ManagerMediaPage } from '../../app/types';
import { describeLoadFailure, ErrorState } from '../../components/States';
import { useManagerResource } from '../manager/resources';
import type { EventView, ExportKind, GalleryAudienceSummaryView } from '../../../shared/contracts';
import { MANAGER_BULK_SELECTION_MAX } from '../../../shared/constants';
import type { LoadFailure } from '../../components/States';
import type { DomainAutosaveState } from '../settings/autosave-queue';
import {
  GalleryExportControl,
  type GalleryExportControlHandle,
} from './GalleryExportControl';
import { galleryPhotoTitle } from './gallery-timeline';
import {
  ManagerAlbum,
  type AlbumLeavePreparation,
  type ManagerAlbumHandle,
} from './ManagerAlbum';
import { ManagerPrivateGallery, type ManagerPrivateGalleryHandle } from './ManagerPrivateGallery';
import { ManagerSharedGallery, type GallerySharedStatus, type ManagerSharedGalleryHandle } from './ManagerSharedGallery';
import type { Dispatch, SetStateAction } from 'react';
import type { ExportCurrentSource } from './export-control-status';
import type { GalleryAnchor, PublicationFilter } from '../../app/manager-history-state';
import type { GalleryAnchorRestoreOutcome } from './gallery-anchor';

/**
 * Keyed by the mode union rather than matched with a fallback, so a fourth mode is a
 * compile error here instead of an unlabelled tab.
 */
const MODE_LABELS: Record<GalleryMode, string> = {
  library: 'Library',
  album: 'Album',
  'guest-gallery': 'Guest gallery',
};

/**
 * What each mode holds, said once, where a host chooses between them. Three modes is one
 * more than most people will read a label for, and the difference that matters — which of
 * these is visible to guests — is not inferable from the names.
 */
const MODE_NOTES: Record<GalleryMode, string> = {
  library: 'Delivered photos stay private to hosts. Picking changes Album membership and a live Album link; it never publishes to the Guest gallery.',
  album: 'One Album per event. Its order and sections are yours; the delivered photos stay exactly where they are.',
  'guest-gallery': 'Publish and Hide change what event guests see. They do not change Album membership or the Album link.',
};

const ignoreLoadFailure: (failure: LoadFailure) => void = () => {};

function publicationResultAnnouncement(
  subject: string,
  action: 'publish' | 'hide',
  guestGalleryVisible: boolean,
  plural = false,
): string {
  const state = action === 'publish' ? 'Published' : 'Hidden';
  const reversal = action === 'publish'
    ? `${plural ? 'Hide them' : 'Hide it'} to reverse this.`
    : `${plural ? 'Publish them' : 'Publish it'} to reverse this.`;
  if (!guestGalleryVisible) {
    return `${subject} ${plural ? 'are' : 'is'} ${state} in the Guest gallery. The Guest gallery is off, so event guests cannot see this choice yet. ${reversal}`;
  }
  return action === 'publish'
    ? `${subject} ${plural ? 'are' : 'is'} Published in the Guest gallery for event guests. ${reversal}`
    : `${subject} ${plural ? 'are' : 'is'} Hidden from event guests in the Guest gallery. ${reversal}`;
}

export interface GalleryAudienceAuthority {
  summary: GalleryAudienceSummaryView | null;
  freshness: 'fresh' | 'stale' | 'unavailable';
  /** True only while a retained summary has an active replacement read. */
  refreshing?: boolean;
  failure: LoadFailure | null;
  reload(): Promise<void>;
  invalidate(): void;
}

export interface ManagerGalleryWorkspaceProps {
  event: EventView;
  eventId: string;
  mode: GalleryMode;
  onModeChange(mode: GalleryMode): void;
  /** Manager-owned generation for every Gallery data owner after a mutation. */
  galleryMutationEpoch: number;
  /** The sole cross-resource mutation invalidator retained by inverse commands. */
  invalidateGalleryAfterMutation(): void;
  audience: GalleryAudienceAuthority;
  shared: {
    /** @deprecated Shared owns its rows, status, selection, and cursor now. */
    media?: MediaView[];
    /** @deprecated Shared owns its rows, status, selection, and cursor now. */
    status?: GallerySharedStatus;
    /** @deprecated Shared owns its rows, status, selection, and cursor now. */
    selected?: string[];
    /** @deprecated Shared owns its rows, status, selection, and cursor now. */
    selectionAtLimit?: boolean;
    /** @deprecated Shared owns its rows, status, selection, and cursor now. */
    onStatusChange?(status: GallerySharedStatus): void;
    /** @deprecated Shared owns its rows, status, selection, and cursor now. */
    onSelectedChange?: Dispatch<SetStateAction<string[]>>;
    /** @deprecated Publication writes happen in Shared's controller now. */
    onBulk?(action: 'publish' | 'hide'): Promise<void>;
    /** @deprecated Publication writes happen in Shared's controller now. */
    onChangePublication?(item: MediaView, action: 'publish' | 'hide'): Promise<void>;
    loadingMore?: boolean;
    hasMore?: boolean;
    onLoadMore?(): Promise<void>;
    /** Reflect a server-returned publication projection into the active Intake page. */
    onPublicationChanged?(changed: MediaView[]): void;
    /** Recently deleted remains Intake-owned, even when Album renders its retained marker. */
    onOpenRecentlyDeleted?(mediaId: string): void;
    onOpenSettings(status: PublicationFilter): void;
    settingsBlocked: boolean;
  };
  exports: {
    job?: ExportView;
    albumJob?: ExportView;
    activeJob?: ExportView;
    download?: ExportDownloadView;
    albumDownload?: ExportDownloadView;
    status: 'idle' | 'loading' | 'ready' | 'failed';
    onPrepare(kind?: ExportKind): Promise<void>;
    onDownload(job: ExportView): Promise<void>;
    onRetry(job: ExportView): Promise<void>;
    failure?: LoadFailure | null;
    onRetryLoad?(): void;
    currentSource: ExportCurrentSource;
  };
  onAnnouncement(message: string): void;
  onAlbumAutosaveStateChange?(state: DomainAutosaveState): void;
  onAlbumAccessFailure?(failure: LoadFailure | null): void;
  onResourceEscalate?(failure: LoadFailure): void;
  onAnchorReady?(mode: GalleryMode): void;
}

export interface ManagerGalleryWorkspaceHandle {
  requiresAlbumLeavePreparation(): boolean;
  prepareToLeave(): Promise<AlbumLeavePreparation>;
  retryPendingAlbumChanges(): Promise<AlbumLeavePreparation>;
  discardPendingAlbumChanges(): void;
  retireAlbumLeavePreparation(): void;
  restoreAlbumLeaveFocus(outcome: AlbumLeavePreparation): void;
  focusCompleteExport(): void;
  retireCompleteExportFocus(): void;
  focusGuestGallerySettingsAction(): void;
  retireGuestGallerySettingsFocus(): void;
  setGuestGalleryFilter(filter: PublicationFilter): void;
  captureAnchor(mode: GalleryMode): GalleryAnchor | null;
  restoreAnchor(mode: GalleryMode, anchor: GalleryAnchor): GalleryAnchorRestoreOutcome;
}

interface GuestGallerySettingsRequest {
  filter: PublicationFilter;
  focus: boolean;
}

/**
 * The one Gallery destination. Library is every private submission, Album is the host's
 * curated artifact, Shared is the publication workspace — and the complete export stays on
 * Library, because `Download all` is whole-event and independent of search, picks and
 * arrangement.
 *
 * Manager owns the audience summary and passes one authority here because all three modes
 * need the same trusted answer. The owner therefore survives leaving Gallery; this workspace
 * only delegates invalidation after confirmed Library, Album, and Shared mutations.
 */
export const ManagerGalleryWorkspace = forwardRef<
ManagerGalleryWorkspaceHandle,
ManagerGalleryWorkspaceProps
>(function ManagerGalleryWorkspace({
  event,
  eventId,
  mode,
  onModeChange,
  galleryMutationEpoch,
  invalidateGalleryAfterMutation,
  shared,
  exports,
  audience,
  onAnnouncement: setAnnouncement,
  onAlbumAutosaveStateChange,
  onAlbumAccessFailure,
  onResourceEscalate,
  onAnchorReady,
}, ref) {
  // Ordinary publication writes still own a narrow, workspace-local Library
  // refresh. The Manager epoch is additive: inverse commands use it to retire
  // every Gallery data owner plus Manager's affected sibling resources.
  const [libraryEpoch, setLibraryEpoch] = useState(0);
  const invalidateLibrary = useCallback(() => {
    setLibraryEpoch((current) => current + 1);
  }, []);
  const [guestGalleryVisible, setGuestGalleryVisible] = useState(event.galleryVisible);
  const guestGalleryVisibleRef = useRef(event.galleryVisible);
  const visibilityEventId = useRef(eventId);
  const adoptedAudienceSummary = useRef<GalleryAudienceSummaryView | null>(null);
  // Shared is an independent question from Intake: it has its own status filter,
  // continuation cursor, and selected set.  Keeping these here prevents a guest
  // name typed in Intake from ever becoming a Gallery URL (or its cursor from
  // being spent there).
  // Standalone workspace consumers in older tests can still provide an initial
  // snapshot. Manager itself never does: it supplies `onPublicationChanged`,
  // which selects the resource-backed path below.
  const legacySharedSnapshot = shared.onPublicationChanged === undefined;
  const [sharedStatus, setSharedStatus] = useState<GallerySharedStatus>(shared.status ?? 'unpublished');
  const [sharedSelected, setSharedSelected] = useState<string[]>(shared.selected ?? []);
  const [sharedLoadingMore, setSharedLoadingMore] = useState(false);
  // Publication writes and continuations are independent operations. Their
  // failures must not clear or retry one another.
  const [sharedWriteFailure, setSharedWriteFailure] = useState<LoadFailure | null>(null);
  const [sharedContinuationFailure, setSharedContinuationFailure] = useState<LoadFailure | null>(null);
  // Functions are kept as values (rather than state updaters) by the extra closure.
  const [retrySharedWrite, setRetrySharedWrite] = useState<(() => void) | null>(null);
  const [retrySharedContinuation, setRetrySharedContinuation] = useState<(() => void) | null>(null);
  const sharedLoadMore = useRef<AbortController | null>(null);
  const sharedActive = useRef(true);
  const currentWorkspaceEvent = useRef(eventId);
  const currentPublicationProjection = useRef(shared.onPublicationChanged);
  const currentSharedSelectionChange = useRef(shared.onSelectedChange);
  const currentSharedInvalidate = useRef<() => void>(() => {});
  // A success may only dismiss the failure raised by that exact operation. Two
  // row PATCHes can settle in either order, and a successful sibling must not
  // erase the failed row's exact retry closure.
  const sharedWriteOperation = useRef(0);
  const sharedWriteFailureOwner = useRef<number | null>(null);
  const sharedContinuationOperation = useRef(0);
  const sharedContinuationFailureOwner = useRef<number | null>(null);
  const albumRef = useRef<ManagerAlbumHandle>(null);
  const completeExportRef = useRef<GalleryExportControlHandle>(null);
  const privateGalleryRef = useRef<ManagerPrivateGalleryHandle>(null);
  const sharedGalleryRef = useRef<ManagerSharedGalleryHandle>(null);
  const guestGallerySettingsRequest = useRef<GuestGallerySettingsRequest | null>(null);
  const [externalLeaveActive, setExternalLeaveActive] = useState(false);

  // A confirmed local Event/Settings projection wins synchronously over a retained
  // summary generation. A later summary settlement may become the new authority.
  useLayoutEffect(() => {
    currentWorkspaceEvent.current = eventId;
    if (visibilityEventId.current !== eventId) {
      visibilityEventId.current = eventId;
      adoptedAudienceSummary.current = null;
    }
    guestGalleryVisibleRef.current = event.galleryVisible;
    setGuestGalleryVisible(event.galleryVisible);
  }, [event.galleryVisible, eventId]);
  useLayoutEffect(() => {
    currentPublicationProjection.current = shared.onPublicationChanged;
  }, [shared.onPublicationChanged]);
  useLayoutEffect(() => {
    currentSharedSelectionChange.current = shared.onSelectedChange;
  }, [shared.onSelectedChange]);

  const sharedQueryKey = `shared:${sharedStatus}:gallery:${galleryMutationEpoch}`;
  const currentSharedQuery = useRef(sharedQueryKey);
  const settledSharedQuery = useRef(sharedQueryKey);
  const settledSharedEvent = useRef(eventId);
  // Imperative callbacks can outlive a render. Commit the owner here rather
  // than mutating it during render, so an abandoned status render cannot make a
  // settled continuation look stale (or accept a new one too soon).
  useLayoutEffect(() => {
    currentSharedQuery.current = sharedQueryKey;
  }, [sharedQueryKey]);
  const sharedPath = useCallback((cursor?: string) => {
    const params = new URLSearchParams();
    if (sharedStatus !== 'all') params.set('status', sharedStatus);
    if (cursor) params.set('cursor', cursor);
    const query = params.toString();
    return `/api/manage/events/${eventId}/media${query ? `?${query}` : ''}`;
  }, [eventId, sharedStatus]);
  const sharedResource = useManagerResource<ManagerMediaPage>({
    eventId,
    queryKey: sharedQueryKey,
    enabled: mode === 'guest-gallery' && !legacySharedSnapshot,
    fallbackMessage: 'The Guest gallery could not be loaded.',
    onEscalate: onResourceEscalate ?? ignoreLoadFailure,
    load: useCallback((signal: AbortSignal) => api<ManagerMediaPage>(sharedPath(), { signal }), [sharedPath]),
  });
  const sharedPage = sharedResource.state.value ?? (legacySharedSnapshot
    ? { media: shared.media ?? [], nextCursor: shared.hasMore ? 'legacy-cursor' : null }
    : null);
  const sharedAnchorPending = !legacySharedSnapshot
    && sharedResource.state.value === null
    && sharedResource.state.failure === null
    && !sharedResource.state.terminal;
  const reportAnchorReady = useCallback((readyMode: GalleryMode) => {
    if (mode === readyMode) onAnchorReady?.(readyMode);
  }, [mode, onAnchorReady]);
  const reportLibraryAnchorReady = useCallback(() => {
    reportAnchorReady('library');
  }, [reportAnchorReady]);
  const reportAlbumAnchorReady = useCallback(() => {
    reportAnchorReady('album');
  }, [reportAnchorReady]);
  useLayoutEffect(() => {
    if (mode !== 'guest-gallery' || sharedAnchorPending || sharedGalleryRef.current === null) return;
    reportAnchorReady('guest-gallery');
  }, [mode, reportAnchorReady, sharedAnchorPending, sharedResource.state.generation]);
  const audienceSummary = audience.summary;
  const invalidateAudienceSummary = audience.invalidate;
  const pickCount = audienceSummary?.albumPhotoCount ?? 0;
  const albumEntryCount = audienceSummary?.albumEntryCount ?? 0;

  useLayoutEffect(() => {
    currentSharedInvalidate.current = sharedResource.invalidate;
  }, [sharedResource.invalidate]);
  useLayoutEffect(() => {
    if (audience.freshness !== 'fresh' || audienceSummary === null) return;
    if (adoptedAudienceSummary.current === audienceSummary) return;
    adoptedAudienceSummary.current = audienceSummary;
    guestGalleryVisibleRef.current = audienceSummary.guestGalleryVisible;
    setGuestGalleryVisible(audienceSummary.guestGalleryVisible);
  }, [audience.freshness, audienceSummary]);

  useEffect(() => {
    const changed = settledSharedQuery.current !== sharedQueryKey;
    settledSharedQuery.current = sharedQueryKey;
    sharedLoadMore.current?.abort();
    sharedLoadMore.current = null;
    setSharedLoadingMore(false);
    if (!changed) return;
    setSharedSelected([]);
    sharedContinuationFailureOwner.current = null;
    setSharedContinuationFailure(null);
    setRetrySharedContinuation(null);
  }, [sharedQueryKey]);
  useEffect(() => {
    const changed = settledSharedEvent.current !== eventId;
    settledSharedEvent.current = eventId;
    if (!changed) return;
    sharedWriteFailureOwner.current = null;
    sharedContinuationFailureOwner.current = null;
    setSharedWriteFailure(null);
    setSharedContinuationFailure(null);
    setRetrySharedWrite(null);
    setRetrySharedContinuation(null);
    setSharedSelected([]);
  }, [eventId]);
  useEffect(() => {
    sharedActive.current = true;
    return () => {
      sharedActive.current = false;
      sharedLoadMore.current?.abort();
      sharedLoadMore.current = null;
    };
  }, []);

  const ownsSharedQuery = useCallback((queryKey: string) => (
    sharedActive.current && currentSharedQuery.current === queryKey
  ), []);
  const ownsSharedWorkspace = useCallback((requestedEventId: string) => (
    sharedActive.current && currentWorkspaceEvent.current === requestedEventId
  ), []);

  const clearSharedWriteFailure = useCallback((owner: number) => {
    if (sharedWriteFailureOwner.current !== owner) return;
    sharedWriteFailureOwner.current = null;
    setSharedWriteFailure(null);
    setRetrySharedWrite(null);
  }, []);

  const clearSharedContinuationFailure = useCallback((owner: number) => {
    if (sharedContinuationFailureOwner.current !== owner) return;
    sharedContinuationFailureOwner.current = null;
    setSharedContinuationFailure(null);
    setRetrySharedContinuation(null);
  }, []);

  const updateCapturedSharedPage = useCallback((
    changed: MediaView[],
    queryKey: string,
    requestedEventId: string,
  ) => {
    if (!ownsSharedWorkspace(requestedEventId) || !ownsSharedQuery(queryKey)) return false;
    const changedById = new Map(changed.map((item) => [item.id, item]));
    // PATCH responses are confirmed, same-query local writes. They compose in
    // React's functional update queue; using a read capture here would make the
    // first settled row retire a concurrent row's equally-valid projection.
    // `update` still retires in-flight reads, while the committed query check
    // above keeps an old status/event closure out of the new collection.
    sharedResource.update((current) => current && {
      ...current,
      media: current.media
        .map((item) => changedById.get(item.id) ?? item)
        .filter((item) => sharedStatus === 'all' || item.publicationStatus === sharedStatus),
    });
    return true;
  }, [ownsSharedQuery, ownsSharedWorkspace, sharedResource, sharedStatus]);

  // Card handlers intentionally use `void`; this boundary classifies and
  // absorbs their failure instead of allowing an unhandled rejection.
  const changeSharedPublication = useCallback(async (
    item: MediaView,
    action: 'publish' | 'hide',
    retryOwner?: number,
    retryEventId?: string,
    retryQueryKey?: string,
  ) => {
    const owner = retryOwner ?? ++sharedWriteOperation.current;
    const requestedEventId = retryEventId ?? eventId;
    const queryKey = retryQueryKey ?? sharedQueryKey;
    if (!ownsSharedWorkspace(requestedEventId)) return;
    const title = galleryPhotoTitle(item);
    const progressive = action === 'publish' ? 'Publishing' : 'Hiding';
    setAnnouncement(`${progressive} ${title}…`);
    try {
      const changed = await api<{ media: MediaView }>(`/api/manage/events/${requestedEventId}/media/${item.id}`, {
        method: 'PATCH', body: JSON.stringify({ action, expectedStatus: item.publicationStatus }),
      });
      if (!ownsSharedWorkspace(requestedEventId)) return;
      currentPublicationProjection.current?.([changed.media]);
      const updatedCapturedPage = updateCapturedSharedPage([changed.media], queryKey, requestedEventId);
      if (!updatedCapturedPage && currentSharedQuery.current !== queryKey) {
        currentSharedInvalidate.current();
      }
      invalidateAudienceSummary();
      invalidateLibrary();
      setAnnouncement(publicationResultAnnouncement(
        galleryPhotoTitle(changed.media),
        action,
        guestGalleryVisibleRef.current,
      ));
      clearSharedWriteFailure(owner);
    } catch (caught) {
      if (!ownsSharedWorkspace(requestedEventId)) return;
      const failure = describeLoadFailure(caught, 'manager', 'The publication change could not be completed.');
      setAnnouncement(`${progressive} ${title} could not be completed.`);
      if (failure.kind === 'retry') {
        sharedWriteFailureOwner.current = owner;
        setSharedWriteFailure(failure);
        setRetrySharedWrite(() => () => {
          void changeSharedPublication(item, action, owner, requestedEventId, queryKey);
        });
      } else {
        // This can be a retry of the operation that installed the local
        // failure. Its old retry closure is no longer honest once access has
        // become terminal, so remove only that owner's panel state before the
        // session-level recovery takes over.
        clearSharedWriteFailure(owner);
        onResourceEscalate?.(failure);
      }
    }
  }, [clearSharedWriteFailure, eventId, invalidateAudienceSummary, invalidateLibrary, onResourceEscalate, ownsSharedWorkspace, sharedQueryKey, updateCapturedSharedPage]);

  const bulkSharedPublication = useCallback(async (
    action: 'publish' | 'hide',
    retryGroups?: Array<{ expectedStatus: MediaView['publicationStatus']; ids: string[] }>,
    retryQueryKey?: string,
    retryOwner?: number,
    retryEventId?: string,
  ) => {
    const owner = retryOwner ?? ++sharedWriteOperation.current;
    const queryKey = retryQueryKey ?? sharedQueryKey;
    const requestedEventId = retryEventId ?? eventId;
    if (!ownsSharedWorkspace(requestedEventId)) return;
    const groups = retryGroups ?? (() => {
      const grouped = new Map<MediaView['publicationStatus'], string[]>();
      for (const item of (sharedPage?.media ?? []).filter(({ id }) => sharedSelected.includes(id))) {
        grouped.set(item.publicationStatus, [...(grouped.get(item.publicationStatus) ?? []), item.id]);
      }
      return [...grouped].map(([expectedStatus, ids]) => ({ expectedStatus, ids }));
    })();
    let confirmedAnyGroup = false;
    let confirmedCount = 0;
    let needsCurrentReconcile = false;
    try {
      for (let index = 0; index < groups.length; index += 1) {
        if (!ownsSharedWorkspace(requestedEventId)) return;
        const group = groups[index]!;
        try {
          const result = await api<{ changed: MediaView[] }>(`/api/manage/events/${requestedEventId}/media/bulk`, {
            method: 'POST', body: JSON.stringify({ ids: group.ids, action, expectedStatus: group.expectedStatus }),
          });
          if (!ownsSharedWorkspace(requestedEventId)) return;
          // Each status group is an independent confirmed projection. Apply and
          // unselect it before the next group can fail, but refresh the summary
          // once for the enclosing user attempt.
          currentPublicationProjection.current?.(result.changed);
          if (!updateCapturedSharedPage(result.changed, queryKey, requestedEventId)) {
            needsCurrentReconcile = true;
          }
          if (!confirmedAnyGroup) {
            invalidateAudienceSummary();
            invalidateLibrary();
          }
          confirmedAnyGroup = true;
          confirmedCount += result.changed.length;
          if (ownsSharedQuery(queryKey)) {
            setSharedSelected((current) => current.filter((id) => !group.ids.includes(id)));
          }
        } catch (caught) {
          if (!ownsSharedWorkspace(requestedEventId)) return;
          const failure = describeLoadFailure(caught, 'manager', 'The publication change could not be completed.');
          const remaining = groups.slice(index);
          const remainingCount = remaining.reduce((count, pending) => count + pending.ids.length, 0);
          if (failure.kind === 'retry') {
            sharedWriteFailureOwner.current = owner;
            setSharedWriteFailure(failure);
            setRetrySharedWrite(() => () => {
              void bulkSharedPublication(action, remaining, queryKey, owner, requestedEventId).catch(() => {});
            });
          } else {
            clearSharedWriteFailure(owner);
            onResourceEscalate?.(failure);
          }
          if (confirmedCount > 0) {
            const remainingSubject = `${remainingCount} remaining photo${remainingCount === 1 ? '' : 's'}`;
            setAnnouncement(`${publicationResultAnnouncement(
              `${confirmedCount} photo${confirmedCount === 1 ? '' : 's'}`,
              action,
              guestGalleryVisibleRef.current,
              confirmedCount !== 1,
            )} ${remainingSubject} could not be ${action === 'publish' ? 'published' : 'hidden'}.${failure.kind === 'retry' ? ' Try again to continue.' : ''}`);
          } else {
            setAnnouncement(`${action === 'publish' ? 'Publishing' : 'Hiding'} could not be completed.`);
          }
          // Retain rejection only so the child can close its busy state at its
          // awaited boundary; this workspace has already announced the outcome.
          throw caught;
        }
      }
      if (!ownsSharedWorkspace(requestedEventId)) return;
      clearSharedWriteFailure(owner);
      if (confirmedCount > 0) {
        setAnnouncement(publicationResultAnnouncement(
          `${confirmedCount} photo${confirmedCount === 1 ? '' : 's'}`,
          action,
          guestGalleryVisibleRef.current,
          confirmedCount !== 1,
        ));
      }
    } finally {
      if (confirmedAnyGroup && ownsSharedWorkspace(requestedEventId)) {
        if (needsCurrentReconcile || currentSharedQuery.current !== queryKey) {
          currentSharedInvalidate.current();
        }
      }
    }
  }, [clearSharedWriteFailure, eventId, invalidateAudienceSummary, invalidateLibrary, onResourceEscalate, ownsSharedQuery, ownsSharedWorkspace, sharedPage?.media, sharedQueryKey, sharedSelected, updateCapturedSharedPage]);

  const loadMoreShared = useCallback(async (
    retryCursor?: string,
    retryQueryKey?: string,
    retryOwner?: number,
  ) => {
    const owner = retryOwner ?? ++sharedContinuationOperation.current;
    const queryKey = retryQueryKey ?? sharedQueryKey;
    const cursor = retryCursor ?? sharedPage?.nextCursor;
    // A terminal continuation has established an identity-scoped access fact.
    // Dismissing the Manager notice never makes its retained cursor honest to
    // spend again; only a new Shared query/event may create a new resource.
    if (!cursor || sharedLoadingMore || sharedResource.isTerminal() || !ownsSharedQuery(queryKey)) return;
    sharedLoadMore.current?.abort();
    const controller = new AbortController();
    sharedLoadMore.current = controller;
    setSharedLoadingMore(true);
    const capture = sharedResource.capture();
    try {
      const page = await api<ManagerMediaPage>(sharedPath(cursor), { signal: controller.signal });
      if (sharedLoadMore.current !== controller || !ownsSharedQuery(queryKey)) return;
      const adopted = sharedResource.updateIfCurrent(capture, (current) => {
        if (!current || current.nextCursor !== cursor) return current;
        const known = new Set(current.media.map(({ id }) => id));
        return { media: [...current.media, ...page.media.filter(({ id }) => !known.has(id))], nextCursor: page.nextCursor ?? null };
      });
      // A newer shared projection/status owns its continuation feedback. Do
      // not let a declined old success erase that newer operation's retry.
      if (!adopted) return;
      clearSharedContinuationFailure(owner);
    } catch (caught) {
      if (sharedLoadMore.current !== controller || !ownsSharedQuery(queryKey)) return;
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      // A mutation or resource reload retired this cursor while it was in
      // flight. Its retryable failure cannot honestly retry the current page.
      if (!sharedResource.isCaptureCurrent(capture)) return;
      const failure = describeLoadFailure(caught, 'manager', 'The next page of shared photos could not be loaded.');
      if (failure.kind === 'retry') {
        sharedContinuationFailureOwner.current = owner;
        setSharedContinuationFailure(failure);
        setRetrySharedContinuation(() => () => { void loadMoreShared(cursor, queryKey, owner); });
      } else {
        clearSharedContinuationFailure(owner);
        // This is a resource answer, not just a panel error. Lock and
        // escalate it through the controller so a dismissed recovery cannot
        // leave this retained cursor repeatedly reissuing a known-terminal
        // request.
        sharedResource.reportTerminalIfCurrent(capture, caught);
      }
    } finally {
      if (sharedLoadMore.current === controller) {
        sharedLoadMore.current = null;
        setSharedLoadingMore(false);
      }
    }
  }, [clearSharedContinuationFailure, ownsSharedQuery, sharedLoadingMore, sharedPage?.nextCursor, sharedPath, sharedQueryKey, sharedResource]);

  const setExternalLeaveOwner = useCallback((active: boolean) => {
    setExternalLeaveActive(active);
  }, []);

  const prepareCurrentAlbumToLeave = useCallback(async () => {
    if (mode !== 'album') return { status: 'ready' } as const;
    return albumRef.current?.prepareToLeave() ?? { status: 'ready' } as const;
  }, [mode]);

  const retryCurrentAlbumChanges = useCallback(async () => {
    if (mode !== 'album') return { status: 'ready' } as const;
    return albumRef.current?.retryPendingAlbumChanges()
      ?? { status: 'ready' } as const;
  }, [mode]);

  const prepareToLeave = useCallback(() => {
    setExternalLeaveOwner(true);
    return prepareCurrentAlbumToLeave();
  }, [prepareCurrentAlbumToLeave, setExternalLeaveOwner]);

  const retryPendingAlbumChanges = useCallback(() => {
    setExternalLeaveOwner(true);
    return retryCurrentAlbumChanges();
  }, [retryCurrentAlbumChanges, setExternalLeaveOwner]);

  const reportAlbumDiscarded = useCallback(() => {
    // The coordinator is about to unmount Album, so its passive state-forwarder
    // will not get another turn. Clear Manager's navigation domain now; an
    // already-sent request is still allowed to finish exactly as the prompt says.
    onAlbumAutosaveStateChange?.({
      domain: 'album',
      label: 'Album',
      status: 'saved',
      failure: null,
      blockingField: null,
    });
  }, [onAlbumAutosaveStateChange]);

  const discardCurrentAlbumChanges = useCallback(() => {
    albumRef.current?.discardPendingAlbumChanges();
  }, []);

  const discardPendingAlbumChanges = useCallback(() => {
    setExternalLeaveOwner(false);
    discardCurrentAlbumChanges();
    reportAlbumDiscarded();
  }, [discardCurrentAlbumChanges, reportAlbumDiscarded, setExternalLeaveOwner]);

  const retireAlbumLeavePreparation = useCallback(() => {
    setExternalLeaveOwner(false);
  }, [setExternalLeaveOwner]);

  const restoreAlbumLeaveFocus = useCallback((outcome: AlbumLeavePreparation) => {
    setExternalLeaveOwner(false);
    albumRef.current?.restoreLeaveFocus(outcome);
  }, [setExternalLeaveOwner]);

  useImperativeHandle(
    ref,
    () => ({
      requiresAlbumLeavePreparation: () => mode === 'album',
      prepareToLeave,
      retryPendingAlbumChanges,
      discardPendingAlbumChanges,
      retireAlbumLeavePreparation,
      restoreAlbumLeaveFocus,
      focusCompleteExport: () => completeExportRef.current?.focusIntendedAction(),
      retireCompleteExportFocus: () => completeExportRef.current?.cancelIntendedAction(),
      setGuestGalleryFilter: (filter) => {
        const request: GuestGallerySettingsRequest = { filter, focus: false };
        guestGallerySettingsRequest.current = request;
        setSharedStatus((current) => (
          guestGallerySettingsRequest.current === request ? filter : current
        ));
      },
      focusGuestGallerySettingsAction: () => {
        const request = guestGallerySettingsRequest.current
          ?? { filter: sharedStatus, focus: false };
        request.focus = true;
        guestGallerySettingsRequest.current = request;
        if (mode === 'guest-gallery' && sharedStatus === request.filter) {
          guestGallerySettingsRequest.current = null;
          sharedGalleryRef.current?.focusSettingsAction();
        }
      },
      retireGuestGallerySettingsFocus: () => {
        guestGallerySettingsRequest.current = null;
      },
      captureAnchor: (requestedMode) => {
        const effectiveVisibleTop = Math.max(
          0,
          document.querySelector<HTMLElement>('.manager-nav')?.getBoundingClientRect().bottom ?? 0,
        );
        switch (requestedMode) {
          case 'library': return privateGalleryRef.current?.captureAnchor(effectiveVisibleTop) ?? null;
          case 'album': return albumRef.current?.captureAnchor(effectiveVisibleTop) ?? null;
          case 'guest-gallery': return sharedGalleryRef.current?.captureAnchor(effectiveVisibleTop) ?? null;
        }
      },
      restoreAnchor: (requestedMode, anchor) => {
        const effectiveVisibleTop = Math.max(
          0,
          document.querySelector<HTMLElement>('.manager-nav')?.getBoundingClientRect().bottom ?? 0,
        );
        switch (requestedMode) {
          case 'library': return privateGalleryRef.current?.restoreAnchor(anchor, effectiveVisibleTop)
            ?? 'pending';
          case 'album': return albumRef.current?.restoreAnchor(anchor, effectiveVisibleTop)
            ?? 'pending';
          case 'guest-gallery': {
            if (sharedAnchorPending) return 'pending';
            return sharedGalleryRef.current?.restoreAnchor(anchor, effectiveVisibleTop) ?? 'pending';
          }
        }
      },
    }),
    [
      discardPendingAlbumChanges,
      prepareToLeave,
      mode,
      retireAlbumLeavePreparation,
      restoreAlbumLeaveFocus,
      retryPendingAlbumChanges,
      sharedAnchorPending,
      sharedStatus,
    ],
  );

  useLayoutEffect(() => {
    const request = guestGallerySettingsRequest.current;
    if (
      request === null
      || !request.focus
      || mode !== 'guest-gallery'
      || request.filter !== sharedStatus
    ) return;
    guestGallerySettingsRequest.current = null;
    sharedGalleryRef.current?.focusSettingsAction();
  }, [mode, sharedStatus]);

  useLayoutEffect(() => () => {
    guestGallerySettingsRequest.current = null;
  }, []);

  useLayoutEffect(() => {
    if (mode !== 'library') completeExportRef.current?.cancelIntendedAction();
    if (mode !== 'guest-gallery') {
      guestGallerySettingsRequest.current = null;
    }
  }, [mode]);

  const adoptedMode = useRef(mode);
  useEffect(() => {
    const previousMode = adoptedMode.current;
    adoptedMode.current = mode;
    if (previousMode !== 'guest-gallery' || mode === 'guest-gallery') return;
    if (sharedSelected.length > 0) {
      setSharedSelected([]);
    }
    currentSharedSelectionChange.current?.([]);
  }, [mode, sharedSelected.length]);

  return <section className="manager-gallery" aria-labelledby="gallery-workspace-title">
    <div className="workspace-heading">
      <h2 id="gallery-workspace-title">Gallery</h2>
      <div className="gallery-mode-switch gallery-mode-switch--three" role="group" aria-label="Gallery mode">
        {(['library', 'album', 'guest-gallery'] as const).map((value) => (
          <button
            type="button"
            key={value}
            disabled={externalLeaveActive && value !== mode}
            aria-pressed={mode === value}
            className={mode === value ? 'active' : ''}
            onClick={() => onModeChange(value)}
          >{MODE_LABELS[value]}{value === 'album' && pickCount > 0 ? ` (${pickCount})` : ''}</button>
        ))}
      </div>
      <p className="gallery-mode-note">{MODE_NOTES[mode]}</p>
      {audienceSummary && <p className="gallery-audience-summary">
        Album: {audienceSummary.albumPhotoCount} {audienceSummary.albumPhotoCount === 1 ? 'photo' : 'photos'}
        {' · '}Link: {audienceSummary.albumLink.active ? 'Live' : 'Off'}
        {' · '}Guest gallery: {guestGalleryVisible ? 'On' : 'Off'}, {audienceSummary.guestGalleryPublishedCount} published
      </p>}
      {!audienceSummary && !audience.failure && (
        <p className="gallery-audience-summary">Loading audience status…</p>
      )}
      {audience.failure && <ErrorState
        message={audience.failure.message}
        recoveryHint={audience.failure.recoveryHint}
        onRetry={() => void audience.reload()}
      />}
      {audienceSummary?.albumLink.active && (mode === 'library' || mode === 'album') && (
        <p>Album link live—later saved membership, metadata, sections, and order changes affect what people with the Album link see when they request it.</p>
      )}
    </div>

    <div className="gallery-private-mode" hidden={mode !== 'library'}>
      <div className="gallery-header">
        <p className="gallery-total">{event.storedMediaCount.toLocaleString()} delivered photos</p>
        {exports.failure && <ErrorState
          message={exports.failure.message}
          recoveryHint={exports.failure.recoveryHint}
          onRetry={exports.onRetryLoad}
        />}
        <GalleryExportControl
          ref={completeExportRef}
          job={exports.job}
          activeJob={exports.activeJob}
          download={exports.download}
          resourceStatus={exports.status}
          eventTimezone={event.eventTimezone}
          currentSource={exports.currentSource}
          onPrepare={exports.onPrepare}
          onDownload={exports.onDownload}
          onRetry={exports.onRetry}
          live={false}
        />
      </div>
      <ManagerPrivateGallery
        ref={privateGalleryRef}
        key={`library:${galleryMutationEpoch}:${libraryEpoch}`}
        event={event}
        eventId={eventId}
        active={mode === 'library'}
        pickCount={pickCount}
        albumEntryCount={albumEntryCount}
        invalidateGalleryAfterMutation={invalidateGalleryAfterMutation}
        onPicksChanged={invalidateAudienceSummary}
        live={false}
        onAnnouncement={setAnnouncement}
        onAnchorReady={reportLibraryAnchorReady}
      />
    </div>

    {/* Mounted only while chosen, unlike the other two. Album owns the active editor and
        leave preparation; the Manager-owned Undo remains visible outside this child. */}
    {mode === 'album' && <div className="gallery-album-mode">
      <ManagerAlbum
        key={`${eventId}:${galleryMutationEpoch}`}
        ref={albumRef}
        eventId={eventId}
        active={mode === 'album'}
        eventTimezone={event.eventTimezone}
        onGoToLibrary={() => onModeChange('library')}
        onOpenRecentlyDeleted={shared.onOpenRecentlyDeleted}
        invalidateGalleryAfterMutation={invalidateGalleryAfterMutation}
        onPicksChanged={invalidateLibrary}
        onAudienceChanged={invalidateAudienceSummary}
        exportJob={exports.albumJob}
        exportSource={{
          count: audienceSummary?.albumPhotoCount ?? null,
          freshness: audience.freshness,
          refreshing: audience.refreshing === true,
        }}
        activeExport={exports.activeJob}
        exportDownload={exports.albumDownload}
        onPrepareExport={() => exports.onPrepare('album')}
        onDownloadExport={exports.onDownload}
        onRetryExport={exports.onRetry}
        onAutosaveStateChange={onAlbumAutosaveStateChange}
        onAccessFailure={onAlbumAccessFailure}
        onAnnouncement={setAnnouncement}
        onAnchorReady={reportAlbumAnchorReady}
      />
    </div>}

    <div className="gallery-shared-mode" hidden={mode !== 'guest-gallery'}>
      {sharedWriteFailure && <ErrorState
        message={sharedWriteFailure.message}
        recoveryHint={sharedWriteFailure.recoveryHint}
        onRetry={retrySharedWrite ?? undefined}
      />}
      {sharedContinuationFailure && <ErrorState
        message={sharedContinuationFailure.message}
        recoveryHint={sharedContinuationFailure.recoveryHint}
        onRetry={retrySharedContinuation ?? undefined}
      />}
      {sharedResource.state.failure && <ErrorState
        message={sharedResource.state.failure.message}
        recoveryHint={sharedResource.state.failure.recoveryHint}
        onRetry={() => void sharedResource.reload()}
      />}
      <ManagerSharedGallery
        ref={sharedGalleryRef}
        guestGalleryVisible={guestGalleryVisible}
        media={sharedPage?.media ?? []}
        status={sharedStatus}
        selected={sharedSelected}
        selectionAtLimit={sharedSelected.length >= MANAGER_BULK_SELECTION_MAX}
        onStatusChange={(nextStatus) => {
          guestGallerySettingsRequest.current = null;
          setSharedStatus(nextStatus);
        }}
        onSelectedChange={setSharedSelected}
        onBulk={legacySharedSnapshot && shared.onBulk
          ? async (action) => {
              try {
                await shared.onBulk!(action);
                invalidateAudienceSummary();
                const count = sharedSelected.length;
                if (count > 0) {
                  setAnnouncement(publicationResultAnnouncement(
                    `${count} photo${count === 1 ? '' : 's'}`,
                    action,
                    guestGalleryVisibleRef.current,
                    count !== 1,
                  ));
                }
              } catch (caught) {
                setAnnouncement(`${action === 'publish' ? 'Publishing' : 'Hiding'} could not be completed.`);
                throw caught;
              }
            }
          : bulkSharedPublication}
        onChangePublication={async (item, action) => {
          const write = legacySharedSnapshot && shared.onChangePublication
            ? shared.onChangePublication
            : changeSharedPublication;
          // Individual card handlers are intentionally fire-and-forget. Bulk
          // is awaited so the child can close its busy state.
          if (legacySharedSnapshot) {
            const progressive = action === 'publish' ? 'Publishing' : 'Hiding';
            setAnnouncement(`${progressive} ${galleryPhotoTitle(item)}…`);
          }
          try {
            await write(item, action);
            if (legacySharedSnapshot) {
              invalidateAudienceSummary();
              invalidateLibrary();
              setAnnouncement(publicationResultAnnouncement(
                galleryPhotoTitle(item),
                action,
                guestGalleryVisibleRef.current,
              ));
            }
          } catch {
            if (legacySharedSnapshot) {
              setAnnouncement(`${action === 'publish' ? 'Publishing' : 'Hiding'} ${galleryPhotoTitle(item)} could not be completed.`);
            }
          }
        }}
        loadingMore={legacySharedSnapshot ? Boolean(shared.loadingMore) : sharedLoadingMore}
        hasMore={Boolean(sharedPage?.nextCursor)}
        onLoadMore={loadMoreShared}
        onOpenSettings={shared.onOpenSettings}
        settingsBlocked={shared.settingsBlocked}
        onAnnouncement={setAnnouncement}
      />
    </div>
    </section>;
});

import { Check, ClipboardCheck, Copy, Download, Eye, EyeOff, Image as ImageIcon, Inbox, Link as LinkIcon, MessageCircle, QrCode, RotateCcw, Search, Settings, Trash2, X } from 'lucide-react';
import QRCode from 'qrcode';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  useBlocker,
  useLocation,
  useNavigate,
  useNavigationType,
  useParams,
} from 'react-router-dom';

import { api, ClientApiError, mediaOriginal, mediaPreview } from '../app/api';
import {
  managerHref,
  parseManagerLocation,
  type GalleryMode,
  type ManagerLocation,
} from '../app/manager-location';
import {
  consumeManagerIntent,
  sanitizeManagerHistoryState,
  withGalleryAnchor,
  withManagerIntent,
  type GalleryAnchor,
  type ManagerNavigationIntent,
  type PublicationFilter,
  type RouterHistoryState,
} from '../app/manager-history-state';
import {
  DATE_UNAVAILABLE,
  TIME_UNAVAILABLE,
  formatEventDate,
  formatRetentionDate,
} from '../app/event-date-time';
import { useDeadlineClock } from '../app/use-deadline-clock';
import { formatBytes } from '../app/format';
import { hostSignInHref } from '../app/recovery';
import {
  MANAGER_BULK_SELECTION_MAX,
  MAX_EVENT_BYTES,
  MAX_EVENT_MEDIA,
} from '../../shared/constants';
import type { ExportKind, GalleryAudienceSummaryView, PhotoIntakeState } from '../../shared/contracts';
import type {
  EventView,
  ExportDownloadView,
  ExportView,
  ManagerMediaPage,
  ManagerTrashPage,
  MediaView,
  TrashedMediaView,
} from '../app/types';
import { Brand } from '../components/Brand';
import { CopyableLinkCard } from '../components/CopyableLinkCard';
import { EventAccountCard } from '../components/EventAccountCard';
import { EventAppearanceEditor } from '../components/EventAppearanceEditor';
import { EventSettingsEditor } from '../components/EventSettingsEditor';
import { ManagementLinkRecovery } from '../components/ManagementLinkRecovery';
import { ManagerPhotoIntakePanel } from '../components/ManagerPhotoIntakePanel';
import { ModalSurface } from '../components/ModalSurface';
import type { PhotoIntakeAction } from '../components/ManagerPhotoIntakePanel';
import { ManagerRsvpPanel } from '../components/ManagerRsvpPanel';
import { describeLoadFailure, ErrorState, LoadingState } from '../components/States';
import { UnsavedSettingsPrompt } from '../components/UnsavedSettingsPrompt';
import type { LoadFailure } from '../components/States';
import { useLifecycleRecheck } from '../features/guest/useLifecycleRecheck';
import type { LifecycleRecheckOutcome } from '../features/guest/useLifecycleRecheck';
import { ManagerGuestbookPanel } from '../features/guestbook/ManagerGuestbookPanel';
import type { GuestbookSummary } from '../features/guestbook/manager-guestbook-state';
import {
  ManagerGalleryWorkspace,
  type GalleryAudienceAuthority,
  type ManagerGalleryWorkspaceHandle,
} from '../features/gallery/ManagerGalleryWorkspace';
import {
  EXPORT_STATE_LABELS,
  exportAnnouncementMessage,
} from '../features/gallery/export-control-status';
import type { AlbumLeavePreparation } from '../features/gallery/ManagerAlbum';
import {
  mergeCoverResponse,
  mergePhotoIntakeResponse,
  mergeSettingsResponse,
  mergeThemeResponse,
} from '../features/settings/event-merge';
import { createEventReadGuard } from '../features/settings/event-read-guard';
import { useManagerResource } from '../features/manager/resources';
import {
  ManagerUndoBar,
  ManagerUndoProvider,
  TRASH_UNDO_WINDOW_MS,
  useManagerUndo,
} from '../features/gallery/undo';
import type { AutosaveHandle, DomainAutosaveState } from '../features/settings/autosave-queue';
import { ManagerUploadDialog } from '../features/uploads/ManagerUploadDialog';
import { resolveHostUploadAvailability } from '../features/uploads/host-upload-availability';
import type { UploadExitState } from '../features/uploads/use-manager-upload-session';

type Section = 'intake' | 'rsvp' | 'gallery' | 'guestbook' | 'share' | 'settings';
type MediaStatus = 'all' | MediaView['publicationStatus'];
/**
 * Intake asks one of two questions, never a blend of them.
 *
 * `active` is the live collection, with its contributor filter and its status.
 * `trash` is Recently deleted, which has neither — it is a different endpoint, a
 * different ordering, and a different cursor. Making the mode part of the query
 * identity is what stops a filter typed in one from paging the other.
 */
type IntakeMode = 'active' | 'trash';

const HOST_UPLOAD_UNAVAILABLE_MESSAGE = {
  'media-cap': 'This event has reached its photo limit.',
  'storage-cap': 'This event has reached its storage limit.',
  'event-unavailable': 'This event is no longer available for uploads.',
} as const;

type ManagerSectionDestination =
  | { kind: 'section'; section: Section }
  | { kind: 'complete-export' }
  | { kind: 'recently-deleted'; focusMediaId: string }
  | { kind: 'settings-repair' }
  | { kind: 'guest-gallery-settings'; publicationFilter: PublicationFilter }
  | { kind: 'guest-gallery-return'; publicationFilter: PublicationFilter };

type GuestGalleryReturn = Extract<
ManagerNavigationIntent,
{ kind: 'edit-guest-gallery-availability' }
>['returnTo'];

type ManagerLeaveDestination =
  | { kind: 'router'; locationKey: string }
  | { kind: 'gallery-mode'; mode: GalleryMode }
  | ManagerSectionDestination;

type ManagerLeaveAttempt = {
  destination: ManagerLeaveDestination;
  generation: number;
  outcome: AlbumLeavePreparation;
};

type PendingManagerAdoption = {
  destination: Exclude<ManagerLeaveDestination, { kind: 'router' }>;
  target: string;
  state: RouterHistoryState;
};

type PendingManagerStateCleanup = {
  generation: number;
  ownerEventId: string;
  ownerEventGeneration: number;
  sourceIdentity: string;
  sourceKey: string;
  sourceTarget: string;
  target: string;
  cleanupLocation: { pathname: string; search: string; hash: string };
  cleanupState: RouterHistoryState;
  initial: boolean;
  anchor: GalleryAnchor | null;
  intent: ManagerNavigationIntent | null;
  destination: Exclude<ManagerLeaveDestination, { kind: 'router' }> | null;
};

type PendingGalleryAnchorCapture = {
  ownerEventId: string;
  ownerEventGeneration: number;
  sourceKey: string;
  sourceTarget: string;
  state: RouterHistoryState;
  outcome: 'pending' | 'committed' | 'retired';
};

type BrowserPopObservation = {
  currentTarget: string;
  nextTarget: string;
  nextKey: string | null;
};

type PendingGalleryRestoration = {
  generation: number;
  mode: GalleryMode;
  anchor: GalleryAnchor;
  frameScheduled: boolean;
};

function sameManagerDestination(
  left: ManagerLeaveDestination,
  right: ManagerLeaveDestination,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'router' && right.kind === 'router') {
    return left.locationKey === right.locationKey;
  }
  if (left.kind === 'gallery-mode' && right.kind === 'gallery-mode') {
    return left.mode === right.mode;
  }
  if (left.kind === 'section' && right.kind === 'section') {
    return left.section === right.section;
  }
  if (left.kind === 'recently-deleted' && right.kind === 'recently-deleted') {
    return left.focusMediaId === right.focusMediaId;
  }
  if (
    (left.kind === 'guest-gallery-settings' || left.kind === 'guest-gallery-return')
    && (right.kind === 'guest-gallery-settings' || right.kind === 'guest-gallery-return')
  ) {
    return left.publicationFilter === right.publicationFilter;
  }
  return true;
}

function locationTarget(location: { pathname: string; search: string; hash: string }) {
  return `${location.pathname}${location.search}${location.hash}`;
}

function managerLifecycleKey(event: EventView): string {
  return JSON.stringify([
    event.photoIntakeState,
    event.eventTimezone,
    event.eventStartAt,
    event.eventStartTime,
    event.rsvpDeadlineAt,
    event.rsvpDeadlineDate,
    event.photoIntakeRecheckAfterMs !== null,
  ]);
}

// One confirmation is open at a time, so the exact-name field they share cannot
// be ambiguous about which irreversible thing it is confirming.
type EntryAction = 'rotate' | 'disable' | 'delete';

const ENTRY_ACTION_DETAILS: Record<EntryAction, {
  verb: string;
  warning: string;
  danger: boolean;
}> = {
  rotate: {
    verb: 'Sign out guest devices',
    warning: 'Guests must scan again to get back in. The event link and every printed QR code stays the same.',
    danger: false,
  },
  disable: {
    verb: 'Disable printed event QR',
    warning: 'This immediately signs out guests, pauses RSVP and photo delivery, and makes every invitation and sign using this QR stop working. It cannot be undone, and there is no replacement.',
    danger: true,
  },
  delete: {
    verb: 'Delete event',
    warning: 'This immediately revokes access and schedules every private file for permanent deletion. It cannot be undone.',
    danger: true,
  },
};

type ManagerLinkRotationState =
  | { phase: 'confirmation' }
  | { phase: 'pending'; expectedRevision: number }
  | {
      phase: 'success';
      managementLink: string;
      managerLinkRevision: number;
      saveStatus: 'required' | 'copied' | 'unavailable';
    }
  | { phase: 'failure'; message: string }
  | {
      phase: 'ambiguous';
      refreshStatus: 'refreshing' | 'ready' | 'failed';
      refreshError?: string;
    };

const AMBIGUOUS_MANAGER_LINK_ROTATION =
  "Couldn't confirm whether the link changed. Rotate again to create a link you can save.";

// The rows and the cursor that continues them are one value. Polling has to compare an incoming first
// page against the rows on screen and decide the cursor from that same verdict, and React only
// guarantees an accurate `current` inside a functional updater — so both live in one state, and any
// write derived from what is already there has to be an updater. Anything held outside the update
// queue, a ref included, lags the committed list by at least a scheduler turn, which is long enough
// for a poll to overwrite a page just appended.
//
// The one absolute write is the whole-page replacement in `refresh`. It derives from nothing on
// screen: its rows and its cursor arrive in the same response and are consistent by construction, and
// `latestMediaPath` is what keeps it off a query it no longer belongs to. Read the rule as "reads then
// writes must be updaters", not "no absolute writes" — a partial replacement is never safe absolutely.
/**
 * One page of whichever list Intake is showing, tagged with which list that is.
 *
 * The tag is not redundant with the mode toggle: a response that arrives during
 * a mode change would otherwise be rendered as the wrong kind of row for exactly
 * one commit, and a Recently deleted row has no preview, no publication status,
 * and no original to download.
 */
type IntakePageState =
  | {
      mode: 'active'; rows: MediaView[]; cursor: string | null;
      firstPageIds: ReadonlySet<string>;
    }
  | {
      mode: 'trash'; rows: TrashedMediaView[]; cursor: string | null;
      firstPageIds: ReadonlySet<string>;
    };

interface EventEntryLoad {
  // Null once the printed entry has been disabled. There is no replacement to
  // offer, so the share surface stops showing a link rather than a stale one.
  eventLink: string | null;
  disabledAt: string | null;
}

// Keeping load failures discriminated prevents a normal refused write from accidentally acquiring
// credential-recovery UI just because it also has a message.
type ManagerNotice =
  | { type: 'action'; message: string; recoveryHint?: string }
  | { type: 'load'; failure: LoadFailure };

function managerNoticeFor(caught: unknown, fallback: string): ManagerNotice {
  const failure = describeLoadFailure(caught, 'manager', fallback);
  return failure.kind === 'retry'
    ? { type: 'action', message: failure.message }
    : { type: 'load', failure };
}

function offersAccessRecovery(failure: LoadFailure) {
  return failure.kind === 'latest-link' || failure.kind === 'sign-in';
}

function ManagerAccessRecovery({
  failure,
  eventId,
  returnTo,
}: {
  failure: LoadFailure;
  eventId: string;
  returnTo: string;
}) {
  if (!offersAccessRecovery(failure)) return null;
  return <section className="manager-access-recovery" aria-label="Recover manager access">
    {failure.offerSignIn && (
      <a className="button button--secondary" href={hostSignInHref(eventId, returnTo)}>Sign in</a>
    )}
    <ManagementLinkRecovery />
  </section>;
}

const PHOTO_CAP = MAX_EVENT_MEDIA.toLocaleString();
const STORAGE_CAP = `${Math.round(MAX_EVENT_BYTES / 1024 ** 3)} GB`;

// The chip reads the server-derived intake state rather than `uploadsEnabled`,
// which now only says delivery is permitted. A permitted event that has not
// reached its opening is scheduled, and no browser clock decides which.
const UPLOAD_CHIP: Record<PhotoIntakeState, { tone: 'approved' | 'pending'; label: string }> = {
  scheduled: { tone: 'pending', label: 'Guest uploads scheduled' },
  'open-early': { tone: 'approved', label: 'Guest uploads open early' },
  open: { tone: 'approved', label: 'Guest uploads open' },
  paused: { tone: 'pending', label: 'Guest uploads paused' },
};

export function ManagerPage() {
  const { eventId = '' } = useParams();
  // A route event is a distinct manager session, not a new revision of the
  // previous session. Remounting drops every local callback, pending mutation,
  // QR continuation, and Gallery controller before event B starts.
  return <ManagerUndoProvider eventId={eventId}>
    <ManagerEventPage key={eventId} eventId={eventId} />
  </ManagerUndoProvider>;
}

function ManagerEventPage({ eventId }: { eventId: string }) {
  const routerLocation = useLocation();
  const navigate = useNavigate();
  const navigationType = useNavigationType();
  const parsedLocation = parseManagerLocation(routerLocation.search);
  const section = parsedLocation.location.section;
  const galleryMode = parsedLocation.location.section === 'gallery'
    ? parsedLocation.location.mode
    : 'library';
  const canonicalManagerHref = managerHref(eventId, parsedLocation.location);
  const recoveryReturnTo = routerLocation.pathname + parsedLocation.canonicalSearch;
  // A route can change while a confirmation, Undo, or write from the previous
  // event is still settling.  Resource controllers reject that stale work; this
  // scope does the same for Manager-local UI state and imperative workspace refs.
  const eventScope = useRef({ eventId, generation: 0 });
  if (eventScope.current.eventId !== eventId) {
    eventScope.current = { eventId, generation: eventScope.current.generation + 1 };
  }
  const managerMounted = useRef(true);
  const managerAdoptionGeneration = useRef(0);
  const pendingManagerStateCleanup = useRef<PendingManagerStateCleanup | null>(null);
  const suspendedManagerStateCleanup = useRef<PendingManagerStateCleanup | null>(null);
  const managerCleanupInvocation = useRef<PendingManagerStateCleanup | null>(null);
  const pendingGalleryAnchorCapture = useRef<PendingGalleryAnchorCapture | null>(null);
  const activeGalleryAnchorCapture = useRef<PendingGalleryAnchorCapture | null>(null);
  const galleryAnchorCaptureInvocation = useRef<PendingGalleryAnchorCapture | null>(null);
  const [managerAdoptionEpoch, setManagerAdoptionEpoch] = useState(0);

  function retireGalleryAnchorCapture(capture: PendingGalleryAnchorCapture) {
    capture.outcome = 'retired';
    if (pendingGalleryAnchorCapture.current === capture) {
      pendingGalleryAnchorCapture.current = null;
    }
    if (activeGalleryAnchorCapture.current === capture) {
      activeGalleryAnchorCapture.current = null;
    }
    if (galleryAnchorCaptureInvocation.current === capture) {
      galleryAnchorCaptureInvocation.current = null;
    }
  }
  // Every Manager resource is loaded by its own controller below. The event is
  // the only shell-critical one: it decides identity and lifecycle, and there is
  // no Manager to render without it. Intake, exports, the printed credential, and
  // the Guestbook summary each answer for themselves, so one of them failing
  // leaves the other three — and the header, the nav, and Settings — on screen.
  const [escalatedFailure, setEscalatedFailure] = useState<LoadFailure | null>(null);
  const [hostUploadLifecycleFailure, setHostUploadLifecycleFailure] = useState<{
    eventId: string;
    eventGeneration: number;
    failure: LoadFailure;
  } | null>(null);
  // A dismissal acknowledges this event session's terminal access fact; it
  // does not make a second resource's copy of that same fact actionable again.
  // The keyed ManagerEventPage creates a fresh ref for the next event session.
  const escalationLocked = useRef(false);
  /**
   * A credential, role, account, or lifecycle failure is never one panel's
   * problem, wherever it surfaced — so it leaves the panel and reaches the
   * recovery surface instead of masquerading as a retryable outage.
   *
   * Recording it is all this does. *Which* recovery surface it becomes is
   * derived at render from whether there is an event to render around: no event
   * means there is no Manager to keep, so it takes the page; an event that has
   * loaded keeps its Manager and the failure becomes the inline notice, which
   * carries the same management-link and sign-in routes and leaves every working
   * panel, filter, and unsaved draft where the host left them. Deriving rather
   * than deciding here is what makes the answer independent of which sibling
   * read happened to resolve first.
   *
   * The first one wins: a second report is the same fact arriving again.
   */
  const escalate = useCallback((failure: LoadFailure) => {
    if (failure.kind === 'ended-event') {
      const eventGeneration = eventScope.current.generation;
      setHostUploadLifecycleFailure((current) => (
        current?.eventId === eventId && current.eventGeneration === eventGeneration
          ? current
          : { eventId, eventGeneration, failure }
      ));
    }
    if (escalationLocked.current) return;
    escalationLocked.current = true;
    setEscalatedFailure(failure);
  }, [eventId]);
  const [intakeMode, setIntakeMode] = useState<IntakeMode>('active');
  const [exportDownloads, setExportDownloads] = useState<Record<string, ExportDownloadView>>({});
  // Updated synchronously when disable confirms so an already-resolving
  // settings response cannot slip through before React commits the new entry
  // state. The full refresh later supplies the server's canonical timestamp.
  const entryDisabled = useRef(false);
  const [photoIntakePending, setPhotoIntakePending] = useState(false);
  const photoIntakePendingRef = useRef(false);
  const [qr, setQr] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  // Settings stays mounted after its first visit so a debounce timer, an
  // in-flight write, and an unsaved draft all survive a destination change.
  const [settingsMounted, setSettingsMounted] = useState(section === 'settings');
  const [settingsFocusEpoch, setSettingsFocusEpoch] = useState(0);
  const [galleryVisibilityFocusEpoch, setGalleryVisibilityFocusEpoch] = useState(0);
  const [guestGallerySettingsReturn, setGuestGallerySettingsReturn] = useState<
    GuestGalleryReturn | null
  >(null);
  const settingsFocusRequested = useRef(false);
  const guestGallerySettingsFocusRequested = useRef<PublicationFilter | null>(null);
  const settingsHeading = useRef<HTMLHeadingElement>(null);
  const [entryAction, setEntryAction] = useState<EntryAction | null>(null);
  const [entryConfirm, setEntryConfirm] = useState('');
  const [entryActionPending, setEntryActionPending] = useState(false);
  const entryActionPendingRef = useRef(false);
  const entryActionOrigin = useRef<HTMLElement | null>(null);
  const entryActionCancel = useRef<HTMLButtonElement>(null);
  const entryActionPendingStatus = useRef<HTMLParagraphElement>(null);
  const entryActionNoticeFocusRequested = useRef(false);
  const entryActionDisabledFocusRequested = useRef(false);
  const entryDisabledResult = useRef<HTMLParagraphElement>(null);
  const [status, setStatus] = useState<MediaStatus>('all');
  const [searchInput, setSearchInput] = useState('');
  const [guestFilter, setGuestFilter] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  // Recently deleted, and the confirmation that leads to it.
  const [trashCandidate, setTrashCandidate] = useState<MediaView | null>(null);
  const [trashPending, setTrashPending] = useState(false);
  const trashDialog = useRef<HTMLDivElement>(null);
  const trashKeepButton = useRef<HTMLButtonElement>(null);
  const trashOrigin = useRef<HTMLElement | null>(null);
  const intakeHeading = useRef<HTMLHeadingElement>(null);
  const trashHeading = useRef<HTMLParagraphElement>(null);
  const trashRestoreButtons = useRef(new Map<string, HTMLButtonElement>());
  const [recoveryAnnouncement, setRecoveryAnnouncement] = useState('');
  const managerUndo = useManagerUndo();
  const completeExportFocusRequested = useRef(false);
  const recentlyDeletedFocusRequested = useRef<string | null>(null);
  const [recentlyDeletedIntentGuidance, setRecentlyDeletedIntentGuidance] = useState(false);
  const [actionError, setActionError] = useState<ManagerNotice | null>(null);
  const [coverAccessFailure, setCoverAccessFailure] = useState<LoadFailure | null>(null);
  const [albumAccessFailure, setAlbumAccessFailure] = useState<LoadFailure | null>(null);
  const [autosaveRecovery, setAutosaveRecovery] = useState<{
    domain: DomainAutosaveState['domain'];
    failure: LoadFailure;
  } | null>(null);
  const [autosaveStates, setAutosaveStates] = useState<Partial<Record<
    DomainAutosaveState['domain'], DomainAutosaveState
  >>>({});
  // The roster intake is intentionally browser-only. It participates in this
  // shell's one pending-work boundary, but is never an autosave domain.
  const [rsvpDraftDirty, setRsvpDraftDirty] = useState(false);
  const [rsvpCommitPending, setRsvpCommitPending] = useState(false);
  const [rsvpDiscardEpoch, setRsvpDiscardEpoch] = useState(0);
  const [pendingSection, setPendingSection] = useState<ManagerSectionDestination | null>(null);
  const [pendingRsvpClose, setPendingRsvpClose] = useState(false);
  const pendingWorkPrompt = useRef<HTMLElement>(null);
  const managerNotice = useRef<HTMLElement>(null);
  const galleryWorkspace = useRef<ManagerGalleryWorkspaceHandle>(null);
  const addPhotosTrigger = useRef<HTMLButtonElement>(null);
  const managerUploadReturnFocus = useRef<HTMLElement | null>(null);
  const managerLinkRotationTrigger = useRef<HTMLButtonElement>(null);
  const managerLinkRotationKeep = useRef<HTMLButtonElement>(null);
  const managerLinkRotationCopy = useRef<HTMLButtonElement>(null);
  const managerLinkRotationContinue = useRef<HTMLButtonElement>(null);
  const managerLinkRotationOutcome = useRef<HTMLButtonElement>(null);
  const [managerLinkRotation, setManagerLinkRotation] = useState<ManagerLinkRotationState | null>(null);
  const [rotationResourcesPaused, setRotationResourcesPaused] = useState(false);
  const rotationResourcesPausedRef = useRef(false);
  const deferredGalleryReconciliation = useRef(false);
  const rotationRequestPending = useRef(false);
  const rotationRequestGeneration = useRef(0);
  const [managerUploadOpen, setManagerUploadOpen] = useState(false);
  const [uploadExitState, setUploadExitState] = useState<UploadExitState>({
    ownsBlock: false,
    warnBeforeUnload: false,
  });
  const managerUploadOwner = useRef<{
    eventId: string;
    eventGeneration: number;
    finalizedMediaIds: Set<string>;
  } | null>(null);
  const [managerUploadLibrarySignal, setManagerUploadLibrarySignal] = useState(() => ({
    eventId,
    eventGeneration: eventScope.current.generation,
    version: 0,
  }));
  const galleryRestorationGeneration = useRef(0);
  const pendingGalleryRestoration = useRef<PendingGalleryRestoration | null>(null);
  const [galleryMutationEpoch, setGalleryMutationEpoch] = useState(0);
  const [galleryAnnouncement, setGalleryAnnouncement] = useState('');
  const [galleryLiveHost] = useState(() => {
    const element = document.createElement('div');
    element.dataset.galleryLiveHost = 'true';
    return element;
  });
  const galleryLiveHostRef = useRef<HTMLElement | null>(galleryLiveHost);
  // GalleryViewer makes the application shell inert. Manager owns one sibling
  // body host so export progress remains live across destinations and viewer
  // movement never needs a competing status node inside the inert shell.
  useLayoutEffect(() => {
    document.body.append(galleryLiveHost);
    return () => { galleryLiveHost.remove(); };
  }, [galleryLiveHost]);
  useLayoutEffect(() => {
    setGalleryAnnouncement('');
  }, [eventId]);
  // The whole-page loaded-once latch, the Guestbook summary generation, and the
  // exports generation all moved into the resource controllers: each one now owns
  // its own generation, and "has this ever loaded" is a property of that
  // controller's value rather than of the page.
  const loadMoreOwner = useRef<AbortController | null>(null);
  // The five-second reader has an owner too: an older tick is abandoned when
  // the next one starts, even if a mock/network ignores abort delivery.
  const intakePollOwner = useRef<AbortController | null>(null);
  // Reads and writes of the event row overlap once autosave can be running
  // behind another destination. Every write brackets itself here, and every
  // whole-event read checks whether it was overtaken before it is adopted.
  const eventReads = useRef(createEventReadGuard());
  const eventWrite = useCallback(async <T,>(request: () => Promise<T>): Promise<T> => {
    if (rotationResourcesPausedRef.current) {
      throw new DOMException('Manager writes are paused during link rotation.', 'AbortError');
    }
    eventReads.current.beginWrite();
    try {
      return await request();
    } finally {
      eventReads.current.endWrite();
    }
  }, []);
  const eventRead = useCallback(<T,>(request: () => Promise<T>): Promise<T> => {
    if (rotationResourcesPausedRef.current) {
      return Promise.reject(new DOMException(
        'Manager reads are paused during link rotation.',
        'AbortError',
      ));
    }
    return eventReads.current.readFresh(() => {
      if (rotationResourcesPausedRef.current) {
        return Promise.reject(new DOMException(
          'Manager reads are paused during link rotation.',
          'AbortError',
        ));
      }
      return request();
    });
  }, []);
  // `ManagerPage` keys this state owner by event id, so a route transition
  // unmounts the old session rather than letting it render into the new one.
  // Retire its imperative owners too: a held write can otherwise resume after
  // unmount and start an event-A reconciliation read even though B is visible.
  useLayoutEffect(() => {
    managerMounted.current = true;
    const suspendedCleanup = suspendedManagerStateCleanup.current;
    suspendedManagerStateCleanup.current = null;
    if (suspendedCleanup && suspendedCleanup.ownerEventId === eventId) {
      suspendedCleanup.ownerEventGeneration = eventScope.current.generation;
      pendingManagerStateCleanup.current = suspendedCleanup;
    }
    return () => {
      managerMounted.current = false;
      eventScope.current.generation += 1;
      suspendedManagerStateCleanup.current = pendingManagerStateCleanup.current;
      pendingManagerStateCleanup.current = null;
      managerCleanupInvocation.current = null;
      const pendingCapture = pendingGalleryAnchorCapture.current;
      const activeCapture = activeGalleryAnchorCapture.current;
      if (pendingCapture) retireGalleryAnchorCapture(pendingCapture);
      if (activeCapture && activeCapture !== pendingCapture) {
        retireGalleryAnchorCapture(activeCapture);
      }
      const more = loadMoreOwner.current;
      loadMoreOwner.current = null;
      more?.abort();
      const poll = intakePollOwner.current;
      intakePollOwner.current = null;
      poll?.abort();
    };
  }, []);
  // Leaving Settings flushes a valid scheduled write without waiting for its
  // response. The subtree remains mounted, so an in-flight request finishes.
  const settingsAutosave = useRef<AutosaveHandle>(null);
  // Appearance becomes an autosave domain in the next task; keeping its handle
  // alongside Settings makes the destination boundary one place.
  const appearanceAutosave = useRef<AutosaveHandle>(null);
  const recordAutosaveState = useCallback((next: DomainAutosaveState) => {
    setAutosaveStates((current) => {
      const previous = current[next.domain];
      if (
        previous?.status === next.status
        && previous?.failure === next.failure
        && previous?.blockingField?.label === next.blockingField?.label
        && previous?.blockingField?.message === next.blockingField?.message
      ) return current;
      return { ...current, [next.domain]: next };
    });
    // A credential or lifecycle failure is the manager's existing recovery
    // problem, not a local Retry the host could ever win.
    if (next.failure?.escalation) {
      setAutosaveRecovery({
        domain: next.domain,
        failure: next.failure.escalation,
      });
      setActionError(null);
    } else if (next.status === 'saved') {
      setAutosaveRecovery((current) => current?.domain === next.domain ? null : current);
    }
  }, []);
  const recordCoverAccessFailure = useCallback((next: LoadFailure | null) => {
    setCoverAccessFailure(next);
  }, []);
  const unconfirmedDomains = Object.values(autosaveStates)
    .filter((domain): domain is DomainAutosaveState => Boolean(domain) && domain.status !== 'saved');
  const stuckDomains = unconfirmedDomains.filter(
    ({ status }) => status === 'invalid' || status === 'failed',
  );
  const rotationSaveGate = managerLinkRotation?.phase === 'success'
    && managerLinkRotation.saveStatus !== 'copied';
  const shouldBlockNavigation = unconfirmedDomains.length > 0
    || rsvpDraftDirty
    || rsvpCommitPending
    || uploadExitState.ownsBlock
    || rotationSaveGate;
  const authorizedAlbumTarget = useRef<string | null>(null);
  const authorizedGalleryTarget = useRef<string | null>(null);
  const blockedGalleryCaptureKey = useRef<string | null>(null);
  const pendingManagerAdoption = useRef<PendingManagerAdoption | null>(null);
  const browserPopObservation = useRef<BrowserPopObservation | null>(null);
  const routerLocationRef = useRef(routerLocation);
  useLayoutEffect(() => {
    routerLocationRef.current = routerLocation;
  }, [routerLocation]);
  useLayoutEffect(() => {
    const observeBrowserPop = (event: PopStateEvent) => {
      const currentTarget = locationTarget(routerLocationRef.current);
      const nextTarget = locationTarget(window.location);
      const eventState = event.state;
      const nextKey = eventState !== null
        && typeof eventState === 'object'
        && !Array.isArray(eventState)
        && typeof (eventState as Record<string, unknown>).key === 'string'
        ? (eventState as Record<string, unknown>).key as string
        : null;
      // React Router reverses a blocked POP before it publishes the blocker.
      // A same-target event is the original request when it names a different
      // entry key; the compensating return names the committed current key.
      const committedKey = routerLocationRef.current.key;
      const namesCommittedEntry = nextKey === committedKey
        || (committedKey === 'default' && nextKey === null);
      if (nextTarget === currentTarget && namesCommittedEntry) return;
      browserPopObservation.current = { currentTarget, nextTarget, nextKey };
    };
    window.addEventListener('popstate', observeBrowserPop, { capture: true });
    return () => {
      window.removeEventListener('popstate', observeBrowserPop, { capture: true });
    };
  }, []);
  function managerOwnerIsLive(owner: {
    ownerEventId: string;
    ownerEventGeneration: number;
  }): boolean {
    return managerMounted.current
      && eventScope.current.eventId === owner.ownerEventId
      && eventScope.current.generation === owner.ownerEventGeneration;
  }

  const blocker = useBlocker(({ currentLocation, nextLocation, historyAction }) => {
    const currentManagerLocation = parseManagerLocation(currentLocation.search);
    const currentIsCanonicalGallery = currentLocation.pathname === `/manage/event/${eventId}`
      && !currentManagerLocation.needsReplace
      && currentManagerLocation.location.section === 'gallery';
    const currentTarget = locationTarget(currentLocation);
    const nextTarget = locationTarget(nextLocation);
    const cleanupInvocation = managerCleanupInvocation.current;
    if (
      historyAction === 'REPLACE'
      && cleanupInvocation
      && managerOwnerIsLive(cleanupInvocation)
      && currentLocation.key === cleanupInvocation.sourceKey
      && currentTarget === cleanupInvocation.sourceTarget
      && nextTarget === cleanupInvocation.target
      && nextLocation.state === cleanupInvocation.cleanupState
    ) {
      return false;
    }
    const anchorInvocation = galleryAnchorCaptureInvocation.current;
    if (
      historyAction === 'REPLACE'
      && anchorInvocation
      && managerOwnerIsLive(anchorInvocation)
      && currentLocation.key === anchorInvocation.sourceKey
      && currentTarget === anchorInvocation.sourceTarget
      && nextTarget === anchorInvocation.sourceTarget
      && nextLocation.state === anchorInvocation.state
    ) {
      return false;
    }
    if (shouldBlockNavigation) return true;
    if (!currentIsCanonicalGallery) return false;
    if (nextTarget === currentTarget) return true;
    return authorizedGalleryTarget.current !== nextTarget
      && authorizedAlbumTarget.current !== nextTarget;
  });
  const blockedNavigationKey = blocker.state === 'blocked'
    ? blocker.location.key
    : null;
  const blockedNavigationTarget = blocker.state === 'blocked'
    ? locationTarget(blocker.location)
    : null;
  const blockerStateRef = useRef(blocker.state);
  useLayoutEffect(() => {
    blockerStateRef.current = blocker.state;
  }, [blocker.state]);
  const [albumLeaveAttempt, setAlbumLeaveAttempt] = useState<ManagerLeaveAttempt | null>(null);
  const albumLeaveAttemptRef = useRef<ManagerLeaveAttempt | null>(null);
  const albumLeaveGeneration = useRef(0);

  function publishAlbumLeaveAttempt(attempt: ManagerLeaveAttempt | null) {
    albumLeaveAttemptRef.current = attempt;
    setAlbumLeaveAttempt(attempt);
  }

  function clearPendingManagerAdoption() {
    authorizedAlbumTarget.current = null;
    authorizedGalleryTarget.current = null;
    pendingManagerAdoption.current = null;
  }

  function retireAlbumLeaveAttempt() {
    albumLeaveGeneration.current += 1;
    publishAlbumLeaveAttempt(null);
    galleryWorkspace.current?.retireAlbumLeavePreparation();
    clearPendingManagerAdoption();
  }

  function finishAlbumLeavePreparation() {
    albumLeaveGeneration.current += 1;
    publishAlbumLeaveAttempt(null);
    galleryWorkspace.current?.retireAlbumLeavePreparation();
  }

  function cancelBlockedNavigation() {
    if (blocker.state === 'blocked') blocker.reset();
    blockerStateRef.current = 'unblocked';
    blockedGalleryCaptureKey.current = null;
    browserPopObservation.current = null;
    retireAlbumLeaveAttempt();
  }

  async function beginAlbumLeave(
    destination: ManagerLeaveDestination,
    retry = false,
  ) {
    const generation = ++albumLeaveGeneration.current;
    const waiting: ManagerLeaveAttempt = {
      destination,
      generation,
      outcome: { status: 'waiting' },
    };
    publishAlbumLeaveAttempt(waiting);
    const outcome = retry
      ? await galleryWorkspace.current?.retryPendingAlbumChanges() ?? { status: 'ready' } as const
      : await galleryWorkspace.current?.prepareToLeave() ?? { status: 'ready' } as const;
    const current = albumLeaveAttemptRef.current;
    if (
      !current
      || current.generation !== generation
      || !sameManagerDestination(current.destination, destination)
    ) return;
    const settled = { destination, generation, outcome };
    publishAlbumLeaveAttempt(settled);
    if (outcome.status !== 'ready' || destination.kind === 'router') return;
    // A Router request that arrived while a section was settling owns the page.
    if (blockerStateRef.current === 'blocked') return;
    finishAlbumLeavePreparation();
    await commitManagerLeaveDestination(destination);
  }

  // Values below belong to one event, not to a revision of the next one.  Clear
  // them together on route change so an Undo, selected card, recovery message,
  // or old failure cannot describe (or operate on) the new event.
  useEffect(() => {
    setEscalatedFailure(null);
    setExportDownloads({});
    entryDisabled.current = false;
    setPhotoIntakePending(false);
    photoIntakePendingRef.current = false;
    setQr('');
    setSelected([]);
    setEntryAction(null);
    setEntryConfirm('');
    setEntryActionPending(false);
    entryActionPendingRef.current = false;
    entryActionOrigin.current = null;
    entryActionNoticeFocusRequested.current = false;
    entryActionDisabledFocusRequested.current = false;
    setStatus('all');
    setSearchInput('');
    setGuestFilter('');
    setLoadingMore(false);
    setTrashCandidate(null);
    setTrashPending(false);
    trashOrigin.current = null;
    setRecoveryAnnouncement('');
    setActionError(null);
    setCoverAccessFailure(null);
    setAlbumAccessFailure(null);
    setAutosaveRecovery(null);
    setAutosaveStates({});
    setRsvpDraftDirty(false);
    setRsvpCommitPending(false);
    setRsvpDiscardEpoch(0);
    setPendingSection(null);
    setPendingRsvpClose(false);
    setGuestGallerySettingsReturn(null);
    rotationResourcesPausedRef.current = false;
    deferredGalleryReconciliation.current = false;
    rotationRequestPending.current = false;
    rotationRequestGeneration.current += 1;
    setRotationResourcesPaused(false);
    setManagerLinkRotation(null);
    setManagerUploadOpen(false);
    setUploadExitState({ ownsBlock: false, warnBeforeUnload: false });
    managerUploadOwner.current = null;
    managerUploadReturnFocus.current = null;
    guestGallerySettingsFocusRequested.current = null;
    retireAlbumLeaveAttempt();
  }, [eventId]);

  useEffect(() => {
    if (blockedNavigationKey === null) {
      blockedGalleryCaptureKey.current = null;
      browserPopObservation.current = null;
      if (albumLeaveAttemptRef.current?.destination.kind === 'router') {
        retireAlbumLeaveAttempt();
      }
      return;
    }
    if (rotationSaveGate) {
      if (blocker.state === 'blocked') blocker.reset();
      blockerStateRef.current = 'unblocked';
      blockedGalleryCaptureKey.current = null;
      browserPopObservation.current = null;
      return;
    }
    if (uploadExitState.ownsBlock) return;
    settingsAutosave.current?.flush();
    appearanceAutosave.current?.flush();
    if (authorizedAlbumTarget.current === blockedNavigationTarget) return;
    authorizedAlbumTarget.current = null;
    if (pendingManagerAdoption.current?.target !== blockedNavigationTarget) {
      pendingManagerAdoption.current = null;
    }
    void beginAlbumLeave({ kind: 'router', locationKey: blockedNavigationKey });
  }, [blockedNavigationKey, blockedNavigationTarget, blocker, rotationSaveGate, uploadExitState.ownsBlock]);
  useEffect(() => {
    // The requested navigation happens by itself the moment both domains
    // confirm; the host never has to answer the prompt twice.
    if (
      blocker.state === 'blocked'
      && (
        authorizedAlbumTarget.current === blockedNavigationTarget
        || (
          albumLeaveAttempt?.destination.kind === 'router'
          && albumLeaveAttempt.destination.locationKey === blockedNavigationKey
          && albumLeaveAttempt.outcome.status === 'ready'
        )
      )
      && !uploadExitState.ownsBlock
      && !rotationSaveGate
      && unconfirmedDomains.length === 0
      && !rsvpDraftDirty
      && !rsvpCommitPending
    ) void proceedBlockedNavigation();
  }, [albumLeaveAttempt, blockedNavigationKey, blockedNavigationTarget, blocker, rotationSaveGate, rsvpCommitPending, rsvpDraftDirty, unconfirmedDomains.length, uploadExitState.ownsBlock]);
  useEffect(() => {
    if (
      unconfirmedDomains.length === 0
      && !rsvpDraftDirty
      && !rsvpCommitPending
      && !uploadExitState.warnBeforeUnload
      && !rotationSaveGate
    ) return;
    // A browser may cancel background requests during unload, so this warns
    // rather than pretending a last-millisecond save is guaranteed.
    const warn = (unloadEvent: BeforeUnloadEvent) => { unloadEvent.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => { window.removeEventListener('beforeunload', warn); };
  }, [rotationSaveGate, rsvpCommitPending, rsvpDraftDirty, unconfirmedDomains.length, uploadExitState.warnBeforeUnload]);
  useEffect(() => {
    if (!albumAccessFailure && autosaveRecovery?.domain !== 'album') return;
    managerNotice.current?.focus();
  }, [albumAccessFailure, autosaveRecovery]);
  useLayoutEffect(() => {
    if (!entryActionPending) return;
    entryActionPendingStatus.current?.focus();
  }, [entryActionPending]);
  useLayoutEffect(() => {
    if (
      entryAction !== null
      || !entryActionNoticeFocusRequested.current
      || (!actionError && !escalatedFailure)
    ) return;
    entryActionNoticeFocusRequested.current = false;
    managerNotice.current?.focus();
  }, [actionError, entryAction, escalatedFailure]);
  useEffect(() => {
    if (rsvpDraftDirty && (blocker.state === 'blocked' || pendingSection !== null || pendingRsvpClose)) {
      pendingWorkPrompt.current?.focus();
    }
  }, [blocker.state, pendingRsvpClose, pendingSection, rsvpDraftDirty]);
  useEffect(() => {
    if (managerLinkRotation?.phase === 'success' && managerLinkRotation.saveStatus === 'copied') {
      managerLinkRotationContinue.current?.focus();
    }
  }, [managerLinkRotation]);

  /**
   * The Intake query, as one identity.
   *
   * Mode leads, because Recently deleted and the live collection are different
   * endpoints with different orderings and different cursors. The contributor
   * filter and the publication status belong to `active` alone and are dropped
   * from the trash key entirely, so switching modes cannot carry one list's
   * filters into the other's request — and neither mode's URL can ever contain
   * the other's cursor.
   */
  const intakeQueryKey = intakeMode === 'trash'
    ? 'trash'
    : `active:${status}:${guestFilter}`;

  const intakePath = useCallback((cursor?: string) => {
    const base = intakeMode === 'trash'
      ? `/api/manage/events/${eventId}/media/trash`
      : `/api/manage/events/${eventId}/media`;
    const params = new URLSearchParams();
    if (intakeMode === 'active') {
      if (status !== 'all') params.set('status', status);
      if (guestFilter) params.set('guestName', guestFilter);
    }
    // The cursor is opaque and `cursor=` is a validation failure, so an absent cursor stays absent.
    if (cursor) params.set('cursor', cursor);
    const query = params.toString();
    return `${base}${query ? `?${query}` : ''}`;
  }, [eventId, guestFilter, intakeMode, status]);

  const eventResource = useManagerResource<EventView>({
    eventId,
    queryKey: 'event',
    fallbackMessage: 'The event manager could not be loaded.',
    onEscalate: escalate,
    enabled: !rotationResourcesPaused,
    load: useCallback(async (signal: AbortSignal) => {
      const readToken = eventReads.current.openRead();
      const loaded = await api<{ event: EventView }>(`/api/manage/events/${eventId}`, { signal });
      // A settings or theme write that landed while this read was open owns the
      // row now. Dropping the read costs one interval; adopting it silently
      // rewrites the host's settings.
      if (!eventReads.current.adopt(readToken)) throw new DOMException('stale', 'AbortError');
      return loaded.event;
    }, [eventId]),
  });
  const event = eventResource.state.value;
  // Quiet lifecycle reads resolve asynchronously; compare their semantic
  // answer with what is actually on screen, not the render that started them.
  const shownEvent = useRef<EventView | null>(null);
  // Lifecycle continuations read this after an await. Commit it in a layout
  // effect so an abandoned render cannot make an older, committed event look
  // like it has already advanced.
  useLayoutEffect(() => {
    shownEvent.current = event;
  }, [event]);

  const intakeResource = useManagerResource<IntakePageState>({
    eventId,
    queryKey: intakeQueryKey,
    fallbackMessage: intakeMode === 'trash'
      ? 'Recently deleted could not be loaded.'
      : 'The live intake could not be loaded.',
    onEscalate: escalate,
    enabled: !rotationResourcesPaused,
    load: useCallback(async (signal: AbortSignal) => {
      if (intakeMode === 'trash') {
        const page = await api<ManagerTrashPage>(intakePath(), { signal });
        return {
          mode: 'trash' as const,
          rows: page.media,
          cursor: page.nextCursor ?? null,
          firstPageIds: new Set(page.media.map(({ id }) => id)),
        };
      }
      const page = await api<ManagerMediaPage>(intakePath(), { signal });
      return {
        mode: 'active' as const,
        rows: page.media,
        cursor: page.nextCursor ?? null,
        firstPageIds: new Set(page.media.map(({ id }) => id)),
      };
    }, [intakeMode, intakePath]),
  });
  const intakePage = intakeResource.state.value;
  // Tagged rather than inferred from `intakeMode`: the tag travels with the rows,
  // so a page loaded under the previous mode can never be rendered as the other
  // list in the render that runs before its controller catches up.
  const media = intakePage?.mode === 'active' ? intakePage.rows : [];
  const trashRows = intakePage?.mode === 'trash' ? intakePage.rows : [];
  const nextMediaCursor = intakePage?.cursor ?? null;
  const showRecentlyDeletedIntentGuidance = recentlyDeletedIntentGuidance
    && intakePage?.mode === 'trash'
    && intakePage.cursor !== null;
  // Recently deleted does not need a poll just to cross a known server deadline.
  // The shared hook caps long waits at the browser timer maximum and re-evaluates,
  // so a 30-day recovery window cannot turn into an immediate-loop timeout.
  const trashNow = useDeadlineClock(trashRows.map(({ restoreUntil }) => restoreUntil));

  const exportsResource = useManagerResource<ExportView[]>({
    eventId,
    queryKey: 'exports',
    fallbackMessage: 'The export status could not be loaded.',
    onEscalate: escalate,
    enabled: !rotationResourcesPaused,
    load: useCallback(async (signal: AbortSignal) => (
      (await api<{ exports: ExportView[] }>(`/api/manage/events/${eventId}/exports`, { signal })).exports
    ), [eventId]),
  });
  const exports = exportsResource.state.eventId === eventId
    ? exportsResource.state.value ?? []
    : [];

  const audienceResource = useManagerResource<GalleryAudienceSummaryView>({
    eventId,
    queryKey: 'gallery-audience-summary',
    fallbackMessage: 'The Gallery audience status could not be loaded.',
    onEscalate: escalate,
    enabled: !rotationResourcesPaused,
    load: useCallback(async (signal: AbortSignal) => (
      await api<{ summary: GalleryAudienceSummaryView }>(
        `/api/manage/events/${eventId}/gallery/summary`,
        { signal },
      )
    ).summary, [eventId]),
  });
  const audienceAuthority = useMemo<GalleryAudienceAuthority>(() => {
    const summary = audienceResource.state.value;
    return {
      summary,
      freshness: audienceResource.state.status === 'ready' && summary !== null
        ? 'fresh'
        : summary !== null ? 'stale' : 'unavailable',
      refreshing: summary !== null && audienceResource.state.status === 'loading',
      failure: audienceResource.state.failure,
      reload: audienceResource.reload,
      invalidate: audienceResource.invalidate,
    };
  }, [
    audienceResource.invalidate,
    audienceResource.reload,
    audienceResource.state.failure,
    audienceResource.state.status,
    audienceResource.state.value,
  ]);

  const entryResource = useManagerResource<EventEntryLoad>({
    eventId,
    queryKey: 'entry',
    fallbackMessage: 'The printed event credential could not be loaded.',
    onEscalate: escalate,
    enabled: !rotationResourcesPaused,
    load: useCallback(async (signal: AbortSignal) => {
      try {
        return await api<EventEntryLoad>(`/api/manage/events/${eventId}/entry`, { signal });
      } catch (caught) {
        // A disabled entry is a permanent event state, not lost manager access,
        // so it must not take this panel — or the shell — down with it.
        if (caught instanceof ClientApiError && caught.code === 'EVENT_ENTRY_UNAVAILABLE') {
          return { eventLink: null, disabledAt: null };
        }
        throw caught;
      }
    }, [eventId]),
  });
  const eventLink = entryResource.state.value?.eventLink ?? '';
  const entryDisabledAt = entryResource.state.value?.disabledAt ?? null;
  useEffect(() => {
    if (entryResource.state.value) entryDisabled.current = entryResource.state.value.disabledAt !== null;
  }, [entryResource.state.value]);
  useLayoutEffect(() => {
    if (
      !entryActionDisabledFocusRequested.current
      || entryAction !== null
      || entryResource.state.value?.eventLink !== null
    ) return;
    const result = entryDisabledResult.current;
    if (!result?.isConnected) return;
    entryActionDisabledFocusRequested.current = false;
    result.focus();
  }, [entryAction, entryResource.state.value?.eventLink]);

  const guestbookResource = useManagerResource<GuestbookSummary>({
    eventId,
    queryKey: 'guestbook-summary',
    fallbackMessage: 'The Guestbook summary could not be loaded.',
    onEscalate: escalate,
    enabled: !rotationResourcesPaused,
    load: useCallback(async (signal: AbortSignal) => (
      (await api<{ summary: GuestbookSummary }>(
        `/api/manage/events/${eventId}/guestbook/summary`,
        { signal },
      )).summary
    ), [eventId]),
  });
  const guestbookSummary = guestbookResource.state.value;
  const guestbookSummaryFailure = guestbookResource.state.failure?.message ?? null;
  const refreshGuestbookSummary = guestbookResource.reload;

  function retireManagerResourcesForRotation() {
    rotationResourcesPausedRef.current = true;
    setRotationResourcesPaused(true);
    // These editors stay mounted outside their visible destination. Retire the
    // adoption right of a sent save and keep the newest unsent intent queued;
    // otherwise its debounce would hit the write guard and become a false
    // failure while the credential transition is deliberately paused.
    settingsAutosave.current?.pause();
    appearanceAutosave.current?.pause();
    // Move the row-read epoch as well as each controller generation. A quiet
    // lifecycle read that ignores AbortSignal cannot adopt or retry after the
    // rotation boundary.
    eventReads.current.beginWrite();
    eventReads.current.endWrite();
    const more = loadMoreOwner.current;
    loadMoreOwner.current = null;
    more?.abort();
    const intakePoll = intakePollOwner.current;
    intakePollOwner.current = null;
    intakePoll?.abort();
    eventResource.update((current) => current);
    intakeResource.update((current) => current);
    exportsResource.update((current) => current);
    audienceResource.update((current) => current);
    entryResource.update((current) => current);
    guestbookResource.update((current) => current);
  }

  function resumeManagerResourcesAfterRotation() {
    if (!rotationResourcesPausedRef.current) return;
    rotationResourcesPausedRef.current = false;
    setRotationResourcesPaused(false);
    settingsAutosave.current?.resume();
    appearanceAutosave.current?.resume();
    // Every controller restarts when `enabled` becomes true. Carry only the
    // local Gallery epoch across the pause; issuing the four invalidators here
    // as well would duplicate those canonical resume reads.
    if (deferredGalleryReconciliation.current) {
      deferredGalleryReconciliation.current = false;
      setGalleryMutationEpoch((current) => current + 1);
    }
  }

  // Every mutation that changes Gallery membership crosses this one boundary.
  // The ref follows the currently committed Intake query while the callback
  // itself stays stable for the event session, so inverse commands can retain
  // it without retaining a child workspace or a stale filtered page.
  const galleryResourceInvalidators = useRef({
    audience: audienceResource.invalidate,
    event: eventResource.invalidate,
    intake: intakeResource.invalidate,
    guestbook: guestbookResource.invalidate,
  });
  useLayoutEffect(() => {
    galleryResourceInvalidators.current = {
      audience: audienceResource.invalidate,
      event: eventResource.invalidate,
      intake: intakeResource.invalidate,
      guestbook: guestbookResource.invalidate,
    };
  }, [
    audienceResource.invalidate,
    eventResource.invalidate,
    guestbookResource.invalidate,
    intakeResource.invalidate,
  ]);
  const galleryMutationOwner = useRef(eventScope.current.generation);
  const invalidateGalleryAfterMutation = useCallback(() => {
    // A retained inverse may settle after this event session unmounts. Its API
    // response belongs to that old event, but it must not start reconciliation
    // reads or bump the epoch of the Manager now on screen.
    if (eventScope.current.generation !== galleryMutationOwner.current) return;
    if (rotationResourcesPausedRef.current) {
      deferredGalleryReconciliation.current = true;
      return;
    }
    setGalleryMutationEpoch((current) => current + 1);
    const owners = galleryResourceInvalidators.current;
    void owners.audience();
    void owners.event();
    void owners.intake();
    void owners.guestbook();
  }, []);

  const invalidateAfterManagerUpload = useCallback(() => {
    const owner = managerUploadOwner.current;
    if (
      owner === null
      || owner.eventId !== eventId
      || owner.eventGeneration !== eventScope.current.generation
    ) return;
    if (rotationResourcesPausedRef.current) {
      deferredGalleryReconciliation.current = true;
      return;
    }
    void eventResource.invalidate();
    if (intakeMode === 'active') void intakeResource.invalidate();
    void guestbookResource.invalidate();
  }, [eventId, eventResource.invalidate, guestbookResource.invalidate, intakeMode, intakeResource.invalidate]);

  const handleManagerUploadFinalized = useCallback(({ mediaId }: { mediaId: string }) => {
    const owner = managerUploadOwner.current;
    if (
      owner === null
      || owner.eventId !== eventId
      || owner.eventGeneration !== eventScope.current.generation
      || owner.finalizedMediaIds.has(mediaId)
    ) return;
    owner.finalizedMediaIds.add(mediaId);
    setManagerUploadLibrarySignal((current) => ({
      eventId: owner.eventId,
      eventGeneration: owner.eventGeneration,
      version: current.eventId === owner.eventId
        && current.eventGeneration === owner.eventGeneration
        ? current.version + 1
        : 1,
    }));
    invalidateAfterManagerUpload();
  }, [eventId, invalidateAfterManagerUpload]);

  const handleManagerUploadExitGate = useCallback((next: UploadExitState) => {
    setUploadExitState((current) => (
      current.ownsBlock === next.ownsBlock
      && current.warnBeforeUnload === next.warnBeforeUnload
        ? current
        : next
    ));
  }, []);

  const closeManagerUpload = useCallback(() => {
    const owner = managerUploadOwner.current;
    const hasFinalizedMediaForCurrentEvent = owner !== null
      && owner.eventId === eventId
      && owner.eventGeneration === eventScope.current.generation
      && owner.finalizedMediaIds.size > 0;
    if (
      hasFinalizedMediaForCurrentEvent
      || (managerUploadReturnFocus.current && !managerUploadReturnFocus.current.isConnected)
    ) {
      const toolbarTrigger = addPhotosTrigger.current;
      managerUploadReturnFocus.current = toolbarTrigger?.isConnected ? toolbarTrigger : null;
    }
    managerUploadOwner.current = null;
    setManagerUploadOpen(false);
  }, [eventId]);

  /**
   * Only the event can empty the Manager.
   *
   * Before it has ever loaded there is nothing to render around a failure, so a
   * retryable event failure takes the whole page. After that — and for every
   * other resource, always — the shell stays and the panel carries its own
   * notice. Escalated failures are separate again and are never retryable.
   */
  const failure = eventResource.state.value === null
    ? escalatedFailure ?? eventResource.state.failure
    : null;
  const refresh = useCallback(async () => {
    // This is the explicit whole-session retry from the full-page recovery
    // surface. Dismissing an inline notice deliberately does not reset it.
    escalationLocked.current = false;
    setEscalatedFailure(null);
    await Promise.all([
      audienceResource.reload(),
      eventResource.reload(),
      intakeResource.reload(),
      exportsResource.reload(),
      entryResource.reload(),
      guestbookResource.reload(),
    ]);
  }, [audienceResource, entryResource, eventResource, exportsResource, guestbookResource, intakeResource]);

  const refreshExports = exportsResource.reload;

  /**
   * The five-second Intake poll.
   *
   * It merges rather than replaces, because the host may already have paged past
   * the first screen and a replacement would throw those pages away. Recently
   * deleted does not poll: its rows change only when this host acts on them.
   */
  const refreshIntake = useCallback(async () => {
    if (
      rotationResourcesPausedRef.current
      || intakeMode !== 'active'
      || intakeResource.state.terminal
      || eventResource.state.terminal
      || intakeResource.isTerminal()
      || eventResource.isTerminal()
    ) return;
    const scope = eventScope.current.generation;
    const previous = intakePollOwner.current;
    previous?.abort();
    const controller = new AbortController();
    intakePollOwner.current = controller;
    const eventCapture = eventResource.capture();
    const intakeCapture = intakeResource.capture();
    const ownsPoll = () => (
      intakePollOwner.current === controller
      && eventScope.current.generation === scope
    );
    const eventReadToken = eventReads.current.openRead();

    // These two reads deliberately settle independently. A transient media
    // outage must not discard a fresh event meter, and a terminal event answer
    // must not make a good first page disappear.
    const eventReadTask = api<{ event: EventView }>(`/api/manage/events/${eventId}`, {
      signal: controller.signal,
    }).then((eventData) => {
      if (!ownsPoll() || !eventReads.current.adopt(eventReadToken)) return;
      eventResource.adoptIfCurrent(eventCapture, eventData.event);
    }).catch((caught) => {
      if (!ownsPoll() || (caught instanceof DOMException && caught.name === 'AbortError')) return;
      eventResource.reportTerminalIfCurrent(eventCapture, caught);
    });
    const intakeReadTask = api<ManagerMediaPage>(intakePath(), {
      signal: controller.signal,
    }).then((firstPage) => {
      if (!ownsPoll()) return;
      intakeResource.updateIfCurrent(intakeCapture, (current) => {
        const fresh = {
          mode: 'active' as const,
          rows: firstPage.media,
          cursor: firstPage.nextCursor ?? null,
          firstPageIds: new Set(firstPage.media.map(({ id }) => id)),
        };
        if (!current || current.mode !== 'active') return fresh;
        const refreshedIds = new Set(firstPage.media.map(({ id }) => id));
        const retained = current.rows.filter(({ id }) => !refreshedIds.has(id));
        if (current.rows.length === 0 || retained.length === current.rows.length) return fresh;
        return {
          mode: 'active',
          rows: [...firstPage.media, ...retained],
          cursor: current.cursor,
          firstPageIds: fresh.firstPageIds,
        };
      });
    }).catch((caught) => {
      if (!ownsPoll() || (caught instanceof DOMException && caught.name === 'AbortError')) return;
      // Venue-network failures remain quiet and retain the confirmed Intake.
      // Credential/lifecycle failures lock this resource and escalate once.
      intakeResource.reportTerminalIfCurrent(intakeCapture, caught);
    });
    await Promise.all([eventReadTask, intakeReadTask]);
    if (intakePollOwner.current === controller) intakePollOwner.current = null;
  }, [eventId, eventResource, intakeMode, intakePath, intakeResource]);

  const loadMoreMedia = useCallback(async () => {
    if (!nextMediaCursor || loadingMore) return;
    const scope = eventScope.current.generation;
    const requested = nextMediaCursor;
    const controller = new AbortController();
    loadMoreOwner.current = controller;
    const resourceCapture = intakeResource.capture();
    setLoadingMore(true);
    try {
      const page = await api<ManagerMediaPage | ManagerTrashPage>(
        intakePath(requested),
        { signal: controller.signal },
      );
      if (eventScope.current.generation !== scope) return;
      if (loadMoreOwner.current !== controller) return;
      // The cursor was issued for the exact resource generation that was
      // current when the host asked for more. A poll/reload/mutation can
      // replace it without this old continuation getting to retire it.
      const adopted = intakeResource.updateIfCurrent(resourceCapture, (current) => {
        if (!current) return current;
        // A poll may have restarted the list while this page was in flight. It continues a keyset the
        // list no longer follows, so appending it would splice in rows from an abandoned ordering.
        if (current.cursor !== requested) return current;
        const known = new Set(current.rows.map(({ id }) => id));
        const appended = page.media.filter(({ id }) => !known.has(id));
        return current.mode === 'trash'
          ? {
              mode: 'trash',
              rows: [...current.rows, ...(appended as TrashedMediaView[])],
              cursor: page.nextCursor ?? null,
              firstPageIds: current.firstPageIds,
            }
          : {
              mode: 'active',
              rows: [...current.rows, ...(appended as MediaView[])],
              cursor: page.nextCursor ?? null,
              firstPageIds: current.firstPageIds,
            };
      });
      // A newer query, poll, or confirmed mutation owns any panel notice it
      // installed. An old successful page must not erase that newer feedback
      // when its projection was correctly declined.
      if (!adopted) return;
      setActionError(null);
    } catch (caught) {
      if (eventScope.current.generation !== scope) return;
      if (loadMoreOwner.current !== controller) return;
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      // This continuation no longer answers the current Intake resource. Its
      // retryable outage is historical, not a panel failure the host can act on.
      if (!intakeResource.isCaptureCurrent(resourceCapture)) return;
      if (intakeResource.reportTerminalIfCurrent(resourceCapture, caught)) return;
      setActionError(managerNoticeFor(caught, 'The next page of photos could not be loaded.'));
    } finally {
      if (eventScope.current.generation === scope && loadMoreOwner.current === controller) {
        loadMoreOwner.current = null;
        setLoadingMore(false);
      }
    }
  }, [intakePath, intakeResource, loadingMore, nextMediaCursor]);

  // A query change retires `Load more` immediately, so the host cannot spend the
  // previous query's cursor against the new one.
  useEffect(() => {
    const superseded = loadMoreOwner.current;
    loadMoreOwner.current = null;
    superseded?.abort();
    setLoadingMore(false);
  }, [eventId, intakeQueryKey]);
  useEffect(() => {
    const superseded = intakePollOwner.current;
    intakePollOwner.current = null;
    superseded?.abort();
  }, [eventId, intakeQueryKey]);
  useEffect(() => () => {
    const active = loadMoreOwner.current;
    loadMoreOwner.current = null;
    active?.abort();
  }, []);
  useEffect(() => () => {
    const active = intakePollOwner.current;
    intakePollOwner.current = null;
    active?.abort();
  }, []);

  // iOS Safari refuses `writeText` outside a permitted gesture and rejects rather than resolving, and
  // the API is absent entirely in any non-secure context. Left unhandled that is a silent no-op the
  // host reads as a copied link, so the refusal is reported and the readable link stays on screen.
  async function copyEventLink() {
    if (!eventLink) return;
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(eventLink);
      setActionError(null);
    } catch {
      setActionError({ type: 'action', message: 'The event link could not be copied.', recoveryHint: eventLink });
    }
  }

  function reportManagerActionFailure(caught: unknown, fallback: string, scope: number) {
    if (eventScope.current.generation !== scope) return;
    const notice = managerNoticeFor(caught, fallback);
    if (notice.type === 'load') {
      // Credential and lifecycle answers share the session-level escalation
      // lock with resource reads. A mutation is not allowed to bypass that
      // boundary and re-open a fact the host has already dismissed.
      escalate(notice.failure);
      return;
    }
    setActionError(notice);
  }

  // Every host mutation reports through here, so a rejected write leaves the current cards, filters,
  // and section exactly where they were and only adds a dismissible notice.
  async function runManagerAction(action: () => Promise<void>, rethrow = false) {
    if (rotationResourcesPausedRef.current) return;
    const scope = eventScope.current.generation;
    setActionError(null);
    try {
      await action();
    } catch (caught) {
      reportManagerActionFailure(caught, 'The manager action could not be completed.', scope);
      if (rethrow) throw caught;
    }
  }

  // No mount load here any more. Each controller starts its own read when its
  // event or its query changes, which is what lets Intake reload on a filter
  // change without the event, the exports, and the credential being refetched
  // beside it.
  useEffect(() => {
    if (
      rotationResourcesPaused
      || section !== 'intake'
      || intakeMode !== 'active'
      || intakeResource.state.terminal
      || eventResource.state.terminal
    ) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshIntake();
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [eventResource.state.terminal, intakeMode, intakeResource.state.terminal, refreshIntake, rotationResourcesPaused, section]);
  /**
   * An export is the terminal act of the whole product and it runs in a Workflow, so its
   * card is the one place the host waits on work they cannot see. Nothing polled it: the
   * state was written once by `refresh` and then sat on "Preparing" until a reload or some
   * unrelated manager action happened to run a full refresh. Ten seconds while a job is
   * actually in flight, on the same visibility guard intake uses, and never otherwise.
   */
  const completeExport = exports.find((job) => job.kind === 'complete');
  const albumExport = exports.find((job) => job.kind === 'album');
  const activeExport = exports.find((job) => job.state === 'queued' || job.state === 'running');
  const activeExportState = activeExport?.state;
  const lastActiveExport = useRef<{ eventId: string; id: string | null }>({ eventId, id: null });
  useLayoutEffect(() => {
    if (lastActiveExport.current.eventId !== eventId) {
      lastActiveExport.current = { eventId, id: activeExport?.id ?? null };
      return;
    }
    if (activeExport) lastActiveExport.current = { eventId, id: activeExport.id };
  }, [activeExport, eventId]);
  useEffect(() => {
    if (rotationResourcesPaused) return;
    if (exportsResource.state.terminal || eventResource.state.terminal) return;
    if (activeExportState !== 'queued' && activeExportState !== 'running') return;
    const refreshVisibleExports = () => {
      if (document.visibilityState === 'visible') void refreshExports();
    };
    const interval = window.setInterval(refreshVisibleExports, 10_000);
    window.addEventListener('focus', refreshVisibleExports);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refreshVisibleExports);
    };
  }, [activeExportState, eventResource.state.terminal, exportsResource.state.terminal, refreshExports, rotationResourcesPaused]);
  // A retry keeps its original createdAt. Once that tracked job terminalizes,
  // a cross-kind createdAt sort can otherwise switch the announcement to an
  // older terminal result and never announce the job the host was waiting on.
  const trackedExport = lastActiveExport.current.eventId === eventId
    ? exports.find((job) => job.id === lastActiveExport.current.id)
    : undefined;
  const newestExport = activeExport ?? trackedExport ?? exports.reduce<ExportView | undefined>((latest, candidate) => {
    if (!latest) return candidate;
    const byCreatedAt = (candidate.createdAt ?? candidate.snapshotAt)
      .localeCompare(latest.createdAt ?? latest.snapshotAt);
    return byCreatedAt > 0 || (byCreatedAt === 0 && candidate.id.localeCompare(latest.id) > 0)
      ? candidate
      : latest;
  }, undefined);
  const announcedExportKey = useRef('');
  useEffect(() => {
    if (!newestExport) return;
    const key = [
      eventId,
      newestExport.id,
      newestExport.state,
      newestExport.processedMediaCount,
      newestExport.processedBytes,
      newestExport.progressUpdatedAt,
      newestExport.errorCode,
    ].join('\u0000');
    if (announcedExportKey.current === key) return;
    announcedExportKey.current = key;
    setGalleryAnnouncement(`${newestExport.kind === 'album' ? 'Album' : 'Complete'} export. ${
      exportAnnouncementMessage(
        newestExport,
        newestExport.kind === 'album' ? 'Album' : 'collection',
        Date.now(),
      )
    }`);
  });
  useEffect(() => {
    if (rotationResourcesPaused) return;
    if (section !== 'guestbook') return;
    const refreshVisibleSummary = () => {
      if (document.visibilityState === 'visible') void refreshGuestbookSummary();
    };
    const interval = window.setInterval(refreshVisibleSummary, 15_000);
    window.addEventListener('focus', refreshVisibleSummary);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refreshVisibleSummary);
    };
  }, [refreshGuestbookSummary, rotationResourcesPaused, section]);
  useEffect(() => {
    let current = true;
    // The event link never changes, so this renders once. It is still cleared
    // first, so a disabled entry cannot leave a scannable code on screen.
    setQr('');
    if (eventLink) {
      void QRCode.toDataURL(eventLink, {
        width: 220,
        margin: 2,
        color: { dark: '#4a2415', light: '#fffaf3' },
      }).then((nextQr) => {
        if (current) setQr(nextQr);
      }).catch(() => {
        // The readable link remains available; a failed render must not create an
        // unhandled rejection or revive a previous QR.
      });
    }
    return () => { current = false; };
  }, [eventLink]);

  function currentGalleryStateWithAnchor(): RouterHistoryState {
    const currentLocation = parsedLocation.location;
    const clean = sanitizeManagerHistoryState(routerLocation.state, eventId, currentLocation).state;
    if (currentLocation.section !== 'gallery') return clean;
    const anchor = galleryWorkspace.current?.captureAnchor(currentLocation.mode) ?? null;
    return withGalleryAnchor(clean, eventId, currentLocation.mode, anchor);
  }

  async function replaceCurrentGalleryEntryWithAnchor(): Promise<RouterHistoryState | null> {
    const state = currentGalleryStateWithAnchor();
    if (parsedLocation.location.section !== 'gallery') return state;
    const currentTarget = locationTarget(routerLocation);
    const previousActiveCapture = activeGalleryAnchorCapture.current;
    const previousPendingCapture = pendingGalleryAnchorCapture.current;
    if (previousActiveCapture) retireGalleryAnchorCapture(previousActiveCapture);
    if (previousPendingCapture && previousPendingCapture !== previousActiveCapture) {
      retireGalleryAnchorCapture(previousPendingCapture);
    }
    const capture: PendingGalleryAnchorCapture = {
      ownerEventId: eventId,
      ownerEventGeneration: eventScope.current.generation,
      sourceKey: routerLocation.key,
      sourceTarget: currentTarget,
      state,
      outcome: 'pending',
    };
    pendingGalleryAnchorCapture.current = capture;
    activeGalleryAnchorCapture.current = capture;
    galleryAnchorCaptureInvocation.current = capture;
    let navigation: void | Promise<void>;
    try {
      navigation = navigate({
        pathname: routerLocation.pathname,
        search: routerLocation.search,
        hash: routerLocation.hash,
      }, { replace: true, state });
    } finally {
      if (galleryAnchorCaptureInvocation.current === capture) {
        galleryAnchorCaptureInvocation.current = null;
      }
    }
    try {
      await navigation;
    } catch {
      retireGalleryAnchorCapture(capture);
      return null;
    }
    const mayContinue = managerOwnerIsLive(capture)
      && activeGalleryAnchorCapture.current === capture
      && (
        capture.outcome === 'committed'
        || (
          capture.outcome === 'pending'
          && pendingGalleryAnchorCapture.current === capture
        )
      );
    if (activeGalleryAnchorCapture.current === capture) {
      activeGalleryAnchorCapture.current = null;
    }
    if (!mayContinue) {
      retireGalleryAnchorCapture(capture);
      return null;
    }
    return state;
  }

  function prepareAdoptedManagerState(consumeGalleryAnchor = true): {
    anchor: GalleryAnchor | null;
    intent: ManagerNavigationIntent | null;
    state: RouterHistoryState;
    needsReplace: boolean;
  } {
    const clean = sanitizeManagerHistoryState(
      routerLocation.state,
      eventId,
      parsedLocation.location,
    );
    const anchor = consumeGalleryAnchor && parsedLocation.location.section === 'gallery'
      ? clean.envelope?.anchors?.[parsedLocation.location.mode] ?? null
      : null;
    const stateWithoutAnchor = anchor && parsedLocation.location.section === 'gallery'
      ? withGalleryAnchor(clean.state, eventId, parsedLocation.location.mode, null)
      : clean.state;
    const consumed = consumeManagerIntent(
      stateWithoutAnchor,
      eventId,
      parsedLocation.location,
    );
    return {
      anchor,
      intent: consumed.intent,
      state: consumed.state,
      needsReplace: parsedLocation.needsReplace
        || anchor !== null
        || clean.needsReplace
        || consumed.intent !== null,
    };
  }

  async function proceedBlockedNavigation() {
    if (blocker.state !== 'blocked') return;
    const navigationKey = blocker.location.key;
    if (blockedGalleryCaptureKey.current === navigationKey) return;
    blockedGalleryCaptureKey.current = navigationKey;
    const target = locationTarget(blocker.location);
    let proceeded = false;
    try {
      const state = currentGalleryStateWithAnchor();
      authorizedGalleryTarget.current = target;
      authorizedAlbumTarget.current = target;
      const observation = browserPopObservation.current;
      const targetKeyMatches = observation?.nextKey === navigationKey
        || (navigationKey === 'default' && observation?.nextKey === null);
      const isObservedBrowserPop = pendingManagerAdoption.current?.target !== target
        && observation?.currentTarget === locationTarget(routerLocation)
        && observation.nextTarget === target
        && targetKeyMatches;
      const rawHistoryState = window.history.state;
      const historyState = rawHistoryState !== null
        && typeof rawHistoryState === 'object'
        && !Array.isArray(rawHistoryState)
        ? rawHistoryState as Record<string, unknown>
        : null;
      const historyKey = historyState?.key;
      const ownsCurrentBrowserEntry = historyState !== null
        && typeof historyState.idx === 'number'
        && Number.isFinite(historyState.idx)
        && (
          historyKey === routerLocation.key
          || (
            routerLocation.key === 'default'
            && historyKey === undefined
            && historyState.idx === 0
          )
        );
      if (
        isObservedBrowserPop
        && locationTarget(window.location) === locationTarget(routerLocation)
        && ownsCurrentBrowserEntry
      ) {
        window.history.replaceState({ ...historyState, usr: state }, '');
      }
      browserPopObservation.current = null;
      blocker.proceed();
      proceeded = true;
    } finally {
      if (!proceeded && blockedGalleryCaptureKey.current === navigationKey) {
        blockedGalleryCaptureKey.current = null;
      }
    }
  }

  function managerLocationForDestination(
    destination: Exclude<ManagerLeaveDestination, { kind: 'router' }>,
  ): ManagerLocation {
    if (destination.kind === 'gallery-mode') {
      return { section: 'gallery', mode: destination.mode };
    }
    if (destination.kind === 'settings-repair') return { section: 'settings' };
    if (destination.kind === 'guest-gallery-settings') return { section: 'settings' };
    if (destination.kind === 'guest-gallery-return') {
      return { section: 'gallery', mode: 'guest-gallery' };
    }
    if (destination.kind === 'recently-deleted') return { section: 'intake' };
    if (destination.kind === 'complete-export') return { section: 'gallery', mode: 'library' };
    return destination.section === 'gallery'
      ? { section: 'gallery', mode: 'library' }
      : { section: destination.section };
  }

  async function commitManagerLeaveDestination(
    destination: Exclude<ManagerLeaveDestination, { kind: 'router' }>,
  ) {
    const departureState = parsedLocation.location.section === 'gallery'
      ? await replaceCurrentGalleryEntryWithAnchor()
      : currentGalleryStateWithAnchor();
    if (departureState === null) return;
    const target = managerHref(eventId, managerLocationForDestination(destination));
    const cleanTargetState = sanitizeManagerHistoryState(
      departureState,
      eventId,
      managerLocationForDestination(destination),
    ).state;
    const targetState = destination.kind === 'complete-export'
      ? withManagerIntent(cleanTargetState, eventId, { kind: 'focus-complete-export' })
      : destination.kind === 'recently-deleted'
        ? withManagerIntent(cleanTargetState, eventId, {
            kind: 'open-recently-deleted',
            focusMediaId: destination.focusMediaId,
          })
        : destination.kind === 'guest-gallery-settings'
          || destination.kind === 'guest-gallery-return'
          ? withManagerIntent(cleanTargetState, eventId, {
              kind: 'edit-guest-gallery-availability',
              returnTo: {
                section: 'gallery',
                mode: 'guest-gallery',
                publicationFilter: destination.publicationFilter,
              },
            })
        : cleanTargetState;
    pendingManagerAdoption.current = { destination, target, state: targetState };
    authorizedAlbumTarget.current = target;
    authorizedGalleryTarget.current = target;
    await navigate(target, { state: targetState });
  }

  function adoptManagerDestination(
    destination: Exclude<ManagerLeaveDestination, { kind: 'router' }>,
  ) {
    if (destination.kind === 'settings-repair') {
      settingsFocusRequested.current = true;
      setSettingsFocusEpoch((current) => current + 1);
    }
  }

  function adoptManagerIntent(intent: ManagerNavigationIntent | null) {
    if (intent?.kind === 'edit-guest-gallery-availability') {
      if (section === 'settings') {
        setGuestGallerySettingsReturn({ ...intent.returnTo });
        setGalleryVisibilityFocusEpoch((current) => current + 1);
        return;
      }
      if (section === 'gallery' && galleryMode === 'guest-gallery') {
        guestGallerySettingsFocusRequested.current = intent.returnTo.publicationFilter;
        settleGuestGallerySettingsIntentFocus();
      }
      return;
    }
    if (intent?.kind === 'focus-complete-export') {
      completeExportFocusRequested.current = true;
      if (
        section === 'gallery'
        && galleryMode === 'library'
        && galleryWorkspace.current !== null
      ) {
        completeExportFocusRequested.current = false;
        galleryWorkspace.current.focusCompleteExport();
      }
      return;
    }
    if (intent?.kind === 'open-recently-deleted') {
      recentlyDeletedFocusRequested.current = intent.focusMediaId;
      setIntakeMode('trash');
      settleRecentlyDeletedIntentFocus();
    }
  }

  function settleGuestGallerySettingsIntentFocus(): boolean {
    const requestedFilter = guestGallerySettingsFocusRequested.current;
    if (
      requestedFilter === null
      || section !== 'gallery'
      || galleryMode !== 'guest-gallery'
      || galleryWorkspace.current === null
    ) return false;
    galleryWorkspace.current.setGuestGalleryFilter(requestedFilter);
    galleryWorkspace.current.focusGuestGallerySettingsAction();
    guestGallerySettingsFocusRequested.current = null;
    return true;
  }

  function retireRetainedIntentFocus() {
    recentlyDeletedFocusRequested.current = null;
    setRecentlyDeletedIntentGuidance(false);
  }

  function retireManagerIntentFocus() {
    completeExportFocusRequested.current = false;
    galleryWorkspace.current?.retireCompleteExportFocus();
    guestGallerySettingsFocusRequested.current = null;
    galleryWorkspace.current?.retireGuestGallerySettingsFocus();
    retireRetainedIntentFocus();
  }

  function chooseIntakeMode(mode: IntakeMode) {
    retireRetainedIntentFocus();
    setIntakeMode(mode);
  }

  const scheduleGalleryAnchorRestoration = useCallback((generation: number) => {
    const requested = pendingGalleryRestoration.current;
    if (requested?.generation !== generation || requested.frameScheduled) return;
    requested.frameScheduled = true;
    requestAnimationFrame(() => {
      const pending = pendingGalleryRestoration.current;
      if (
        generation !== galleryRestorationGeneration.current
        || pending?.generation !== generation
      ) return;
      pending.frameScheduled = false;
      const outcome = galleryWorkspace.current?.restoreAnchor(pending.mode, pending.anchor)
        ?? 'pending';
      if (outcome !== 'pending') pendingGalleryRestoration.current = null;
    });
  }, []);

  function cleanUpAdoptedManagerLocation(anchor: GalleryAnchor | null) {
    if (section === 'settings') setSettingsMounted(true);
    setGuestGallerySettingsReturn(null);
    setSelected([]);
    setActionError(null);
    setEntryAction(null);
    setEntryConfirm('');
    retireManagerIntentFocus();
    if (section === 'intake') setStatus('all');
    // Deep in a 120-photo intake grid, the new section would otherwise open somewhere in its middle —
    // or under the sticky header. Restore the top once the new section has actually been laid out, and
    // only when there is something to restore. `instant` rather than `auto`, because the document
    // carries `scroll-behavior: smooth` and `auto` would defer to it.
    const generation = ++galleryRestorationGeneration.current;
    pendingGalleryRestoration.current = null;
    if (anchor && parsedLocation.location.section === 'gallery') {
      pendingGalleryRestoration.current = {
        generation,
        mode: parsedLocation.location.mode,
        anchor,
        frameScheduled: false,
      };
      scheduleGalleryAnchorRestoration(generation);
      return;
    }
    requestAnimationFrame(() => {
      if (generation !== galleryRestorationGeneration.current) return;
      if (window.scrollY > 0) window.scrollTo({ top: 0, behavior: 'instant' });
    });
  }

  const handleGalleryAnchorReady = useCallback((mode: GalleryMode) => {
    const pending = pendingGalleryRestoration.current;
    if (pending?.mode !== mode) return;
    scheduleGalleryAnchorRestoration(pending.generation);
  }, [scheduleGalleryAnchorRestoration]);

  const managerEntryIdentity = `${routerLocation.key}\u0000${canonicalManagerHref}`;
  const adoptedManagerEntry = useRef<string | null>(null);
  const initialManagerAdoptionPending = useRef(true);

  function finishCommittedManagerAdoption(adopted: PendingManagerStateCleanup) {
    if (!adopted.initial) {
      if (adopted.destination) adoptManagerDestination(adopted.destination);
      finishAlbumLeavePreparation();
      cleanUpAdoptedManagerLocation(adopted.anchor);
    }
    adoptManagerIntent(adopted.intent);
  }

  function managerIdentityFor(location: typeof routerLocation): string {
    const parsed = parseManagerLocation(location.search);
    return `${location.key}\u0000${managerHref(eventId, parsed.location)}`;
  }

  function clearPendingManagerCleanup(staged: PendingManagerStateCleanup) {
    if (pendingManagerStateCleanup.current === staged) {
      pendingManagerStateCleanup.current = null;
    }
    if (managerCleanupInvocation.current === staged) {
      managerCleanupInvocation.current = null;
    }
  }

  function committedLocationMatchesCleanup(staged: PendingManagerStateCleanup): boolean {
    const committed = routerLocationRef.current;
    return managerOwnerIsLive(staged)
      && staged.generation === managerAdoptionGeneration.current
      && committed.key !== staged.sourceKey
      && locationTarget(committed) === staged.target
      && committed.state === staged.cleanupState;
  }

  function finishExactManagerCleanup(staged: PendingManagerStateCleanup) {
    if (!committedLocationMatchesCleanup(staged)) return;
    const committed = routerLocationRef.current;
    clearPendingManagerCleanup(staged);
    adoptedManagerEntry.current = managerIdentityFor(committed);
    finishCommittedManagerAdoption(staged);
  }

  function runManagerCleanup(staged: PendingManagerStateCleanup, attempt = 0) {
    if (
      !managerOwnerIsLive(staged)
      || managerIdentityFor(routerLocationRef.current) !== staged.sourceIdentity
    ) return;
    if (attempt > 0) {
      // A rejected attempt retires its state-object capability. The one
      // bounded retry gets a distinct object so a late attempt-0 commit cannot
      // be mistaken for the retry's exact successor.
      staged.cleanupState = { ...staged.cleanupState };
    }
    pendingManagerStateCleanup.current = staged;
    managerCleanupInvocation.current = staged;
    let navigation: void | Promise<void>;
    try {
      navigation = navigate(staged.cleanupLocation, {
        replace: true,
        state: staged.cleanupState,
      });
    } catch {
      navigation = Promise.reject(new Error('Manager cleanup navigation failed.'));
    } finally {
      if (managerCleanupInvocation.current === staged) {
        managerCleanupInvocation.current = null;
      }
    }
    void Promise.resolve(navigation).then(() => {
      if (pendingManagerStateCleanup.current !== staged || !managerOwnerIsLive(staged)) return;
      if (committedLocationMatchesCleanup(staged)) {
        finishExactManagerCleanup(staged);
        return;
      }
      // Router navigation completion can precede the React commit that
      // publishes its location. Keep the exact cleanup pending while the
      // source entry is still what this component has committed; the location
      // effect below will finish only the matching successor.
      if (managerIdentityFor(routerLocationRef.current) !== staged.sourceIdentity) {
        clearPendingManagerCleanup(staged);
        adoptedManagerEntry.current = null;
        setManagerAdoptionEpoch((current) => current + 1);
      }
    }).catch(() => {
      if (pendingManagerStateCleanup.current !== staged || !managerOwnerIsLive(staged)) return;
      clearPendingManagerCleanup(staged);
      adoptedManagerEntry.current = null;
      if (
        attempt === 0
        && managerIdentityFor(routerLocationRef.current) === staged.sourceIdentity
      ) runManagerCleanup(staged, 1);
    });
  }

  useLayoutEffect(() => {
    if (adoptedManagerEntry.current === managerEntryIdentity) return;

    const pendingCleanup = pendingManagerStateCleanup.current;
    if (pendingCleanup) {
      const isExactCleanupSuccessor = managerOwnerIsLive(pendingCleanup)
        && pendingCleanup.generation === managerAdoptionGeneration.current
        && navigationType === 'REPLACE'
        && routerLocation.key !== pendingCleanup.sourceKey
        && locationTarget(routerLocation) === pendingCleanup.target
        && routerLocation.state === pendingCleanup.cleanupState;
      // The exact state object is created for one cleanup call and retained by
      // Router on its committed Location. Equal foreign state from a different
      // REPLACE cannot claim the cleanup's intent or anchor side effects.
      if (isExactCleanupSuccessor) {
        finishExactManagerCleanup(pendingCleanup);
        return;
      }
      clearPendingManagerCleanup(pendingCleanup);
      adoptedManagerEntry.current = null;
    }

    const pendingAnchorCapture = pendingGalleryAnchorCapture.current;
    if (pendingAnchorCapture) {
      const isExactAnchorCapture = managerOwnerIsLive(pendingAnchorCapture)
        && navigationType === 'REPLACE'
        && routerLocation.key !== pendingAnchorCapture.sourceKey
        && locationTarget(routerLocation) === pendingAnchorCapture.sourceTarget
        && routerLocation.state === pendingAnchorCapture.state;
      if (isExactAnchorCapture) {
        // Capturing the departing Gallery anchor replaces this same browser
        // entry before the actual navigation. Leave the stored anchor for the
        // later POP that returns to this exact entry.
        pendingAnchorCapture.outcome = 'committed';
        pendingGalleryAnchorCapture.current = null;
        adoptedManagerEntry.current = managerEntryIdentity;
        return;
      }
      retireGalleryAnchorCapture(pendingAnchorCapture);
    }

    // Exact commit classification clears the pending slot before the Router
    // Promise necessarily settles. A newer entry must still retire that
    // committed capture's awaiting destination continuation.
    const activeAnchorCapture = activeGalleryAnchorCapture.current;
    if (activeAnchorCapture) {
      retireGalleryAnchorCapture(activeAnchorCapture);
    }

    // Any entry other than the staged REPLACE successor is a newer adoption.
    // Retire the old task before decoding the new one so late resources cannot
    // focus hidden/abandoned work.
    const generation = ++managerAdoptionGeneration.current;
    adoptedManagerEntry.current = managerEntryIdentity;
    browserPopObservation.current = null;
    retireManagerIntentFocus();
    setGuestGallerySettingsReturn(null);
    const initial = initialManagerAdoptionPending.current;
    initialManagerAdoptionPending.current = false;
    const adopted = prepareAdoptedManagerState(!initial);
    const pending = pendingManagerAdoption.current?.target === canonicalManagerHref
      && pendingManagerAdoption.current.state === routerLocation.state
      ? pendingManagerAdoption.current.destination
      : null;
    clearPendingManagerAdoption();
    const sourceTarget = locationTarget(routerLocation);
    const cleanupLocation = {
      pathname: routerLocation.pathname,
      search: parsedLocation.canonicalSearch,
      hash: routerLocation.hash,
    };
    const target = locationTarget(cleanupLocation);
    const staged: PendingManagerStateCleanup = {
      generation,
      ownerEventId: eventId,
      ownerEventGeneration: eventScope.current.generation,
      sourceIdentity: managerEntryIdentity,
      sourceKey: routerLocation.key,
      sourceTarget,
      target,
      cleanupLocation,
      cleanupState: adopted.state,
      initial,
      anchor: adopted.anchor,
      intent: adopted.intent,
      destination: pending,
    };
    if (!adopted.needsReplace) {
      finishCommittedManagerAdoption(staged);
      return;
    }

    runManagerCleanup(staged);
  }, [managerAdoptionEpoch, managerEntryIdentity, navigationType]);

  function requestGalleryMode(mode: GalleryMode) {
    if (mode === galleryMode) return;
    if (mode !== 'library') galleryWorkspace.current?.retireCompleteExportFocus();
    if (galleryWorkspace.current?.requiresAlbumLeavePreparation() !== true) {
      clearPendingManagerAdoption();
      void commitManagerLeaveDestination({ kind: 'gallery-mode', mode });
      return;
    }
    clearPendingManagerAdoption();
    void beginAlbumLeave({ kind: 'gallery-mode', mode });
  }

  function requestSectionDestination(destination: ManagerSectionDestination) {
    const next = destination.kind === 'section'
      ? destination.section
      : destination.kind === 'recently-deleted'
        ? 'intake'
        : destination.kind === 'complete-export'
          || destination.kind === 'guest-gallery-return'
          ? 'gallery'
          : 'settings';
    if (section === 'settings' && next !== 'settings') {
      // Leaving flushes the newest valid drafts. It deliberately does not wait
      // for their responses: the subtree stays mounted, so they finish anyway.
      settingsAutosave.current?.flush();
      appearanceAutosave.current?.flush();
    }
    if (next === section) {
      if (destination.kind === 'recently-deleted') {
        recentlyDeletedFocusRequested.current = destination.focusMediaId;
        setRecentlyDeletedIntentGuidance(false);
        setIntakeMode('trash');
      } else if (destination.kind === 'complete-export') {
        completeExportFocusRequested.current = true;
        galleryWorkspace.current?.focusCompleteExport();
        completeExportFocusRequested.current = false;
      } else if (destination.kind === 'settings-repair') {
        setGuestGallerySettingsReturn(null);
        settingsFocusRequested.current = true;
        setSettingsFocusEpoch((current) => current + 1);
      }
      return;
    }
    if (blocker.state === 'blocked') {
      // A new in-app destination is an explicit replacement for the pending
      // Router destination. Reset only that exact blocker before installing the
      // new section generation; its old Album result is retired below.
      cancelBlockedNavigation();
    }
    if (rsvpCommitPending && next !== 'rsvp') return;
    if (rsvpDraftDirty && next !== 'rsvp') {
      setPendingSection(destination);
      return;
    }
    if (section === 'gallery') {
      if (galleryWorkspace.current?.requiresAlbumLeavePreparation() !== true) {
        clearPendingManagerAdoption();
        void commitManagerLeaveDestination(destination);
        return;
      }
      clearPendingManagerAdoption();
      void beginAlbumLeave(destination);
      return;
    }
    clearPendingManagerAdoption();
    void commitManagerLeaveDestination(destination);
  }

  function openSection(next: Section) {
    requestSectionDestination({ kind: 'section', section: next });
  }

  function openCompleteExport() {
    requestSectionDestination({ kind: 'complete-export' });
  }

  function openRecentlyDeleted(mediaId: string) {
    requestSectionDestination({ kind: 'recently-deleted', focusMediaId: mediaId });
  }

  function openSettingsForRepair() {
    if (rsvpCommitPending) return;
    if (rsvpDraftDirty) {
      setPendingSection({ kind: 'settings-repair' });
      return;
    }
    requestSectionDestination({ kind: 'settings-repair' });
  }

  function openGuestGallerySettings(publicationFilter: PublicationFilter) {
    requestSectionDestination({ kind: 'guest-gallery-settings', publicationFilter });
  }

  function returnToGuestGallery() {
    if (section !== 'settings' || guestGallerySettingsReturn === null) return;
    requestSectionDestination({
      kind: 'guest-gallery-return',
      publicationFilter: guestGallerySettingsReturn.publicationFilter,
    });
  }

  function retryAlbumLeave() {
    const attempt = albumLeaveAttemptRef.current;
    if (!attempt || attempt.outcome.status === 'waiting') return;
    void beginAlbumLeave(attempt.destination, true);
  }

  function stayWithAlbum() {
    const attempt = albumLeaveAttemptRef.current;
    if (!attempt) return;
    const { destination, outcome } = attempt;
    retireAlbumLeaveAttempt();
    if (
      destination.kind === 'router'
      && blocker.state === 'blocked'
      && blocker.location.key === destination.locationKey
    ) blocker.reset();
    galleryWorkspace.current?.restoreAlbumLeaveFocus(outcome);
  }

  function discardAlbumAndLeave() {
    const attempt = albumLeaveAttemptRef.current;
    if (!attempt || attempt.outcome.status === 'waiting') return;
    galleryWorkspace.current?.discardPendingAlbumChanges();
    if (albumLeaveAttemptRef.current !== attempt) return;
    const { destination } = attempt;
    if (destination.kind === 'router') {
      if (
        blocker.state !== 'blocked'
        || blocker.location.key !== destination.locationKey
      ) {
        retireAlbumLeaveAttempt();
        return;
      }
      retireAlbumLeaveAttempt();
      void proceedBlockedNavigation();
      return;
    }
    if (blockerStateRef.current === 'blocked') return;
    retireAlbumLeaveAttempt();
    void commitManagerLeaveDestination(destination);
  }

  // Initial focus is Keep photo, every time the dialog opens.
  useEffect(() => {
    if (trashCandidate) trashKeepButton.current?.focus();
  }, [trashCandidate]);

  useEffect(() => {
    if (!settingsFocusRequested.current || section !== 'settings') return;
    settingsFocusRequested.current = false;
    settingsHeading.current?.focus();
  }, [section, settingsFocusEpoch]);
  useLayoutEffect(() => {
    settleGuestGallerySettingsIntentFocus();
  }, [event, galleryMode, section]);
  useLayoutEffect(() => {
    if (
      !completeExportFocusRequested.current
      || section !== 'gallery'
      || galleryMode !== 'library'
      || galleryWorkspace.current === null
    ) return;
    completeExportFocusRequested.current = false;
    galleryWorkspace.current.focusCompleteExport();
  }, [event, galleryMode, section]);
  function settleRecentlyDeletedIntentFocus(): boolean {
    const requestedId = recentlyDeletedFocusRequested.current;
    if (
      !requestedId
      || section !== 'intake'
      || intakeMode !== 'trash'
      || intakePage?.mode !== 'trash'
      || intakeResource.state.status !== 'ready'
    ) return false;
    const restore = intakePage.firstPageIds.has(requestedId)
      ? trashRestoreButtons.current.get(requestedId) ?? null
      : null;
    recentlyDeletedFocusRequested.current = null;
    if (restore) {
      setRecentlyDeletedIntentGuidance(false);
      restore.focus();
      return true;
    }
    setRecentlyDeletedIntentGuidance(intakePage.cursor !== null);
    intakeHeading.current?.focus();
    return true;
  }

  useLayoutEffect(() => {
    settleRecentlyDeletedIntentFocus();
  }, [intakeMode, intakePage, intakeResource.state.status, nextMediaCursor, section]);

  function adoptPublicationRows(changed: MediaView[]) {
    const changedById = new Map(changed.map((item) => [item.id, item]));
    intakeResource.update((current) => {
      if (!current || current.mode !== 'active') return current;
      return {
        ...current,
        rows: current.rows
          .map((item) => changedById.get(item.id) ?? item)
          .filter((item) => status === 'all' || item.publicationStatus === status),
      };
    });
  }

  async function changePublication(item: MediaView, action: 'publish' | 'hide' | 'delete') {
    const scope = eventScope.current.generation;
    const result = await eventWrite(() => api<{ media: MediaView }>(`/api/manage/events/${eventId}/media/${item.id}`, {
      method: 'PATCH', body: JSON.stringify({ action, expectedStatus: item.publicationStatus }),
    }));
    if (eventScope.current.generation !== scope) return result.media;
    adoptPublicationRows([result.media]);
    return result.media;
  }

  /**
   * Where focus goes after a photo leaves Intake.
   *
   * Next card, previous card, then the heading — resolved *before* the row is
   * removed, because after the removal the element the host was on is gone and
   * the browser has already dropped focus to `<body>`. The resolved element is
   * also the Undo bar's return origin, so closing the offer puts the host back
   * exactly where they were rather than at the top of the page.
   */
  function resolveIntakeFallback(mediaId: string): HTMLElement | null {
    const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-intake-card]'));
    const index = cards.findIndex((card) => card.dataset.intakeCard === mediaId);
    if (index === -1) return intakeHeading.current;
    const next = cards[index + 1] ?? cards[index - 1] ?? null;
    const focusable = next?.querySelector<HTMLElement>('button, a[href]') ?? next;
    return focusable ?? intakeHeading.current;
  }

  function openTrashConfirmation(item: MediaView, origin: HTMLElement | null) {
    trashOrigin.current = origin;
    setTrashCandidate(item);
  }

  function closeTrashConfirmation() {
    setTrashCandidate(null);
    // Cancelling sent no request, so the host is returned to the control they
    // opened it from rather than to wherever the dialog happened to leave focus.
    const origin = trashOrigin.current;
    trashOrigin.current = null;
    origin?.focus();
  }

  /**
   * Move one photo to Recently deleted.
   *
   * Exactly one request, and only after the confirmation is explicitly
   * activated. The deadline in the announcement and in the Undo cap is the
   * server's `restoreUntil` — it does not exist until this transition is
   * accepted, so nothing here predicts it.
   */
  async function confirmTrash(item: MediaView, activation: 'keyboard' | 'pointer') {
    if (trashPending || !managerUndo.canPresent) return;
    const scope = eventScope.current.generation;
    // A confirmed trash transition supersedes the idle/failed recovery offer.
    // Retire it before this request yields so it cannot begin running and lock
    // out the new restore offer after the server accepts the trash.
    managerUndo.dismiss();
    setTrashPending(true);
    const fallback = resolveIntakeFallback(item.id);
    try {
      const { media: trashed } = await eventWrite(() => api<{ media: TrashedMediaView }>(
        `/api/manage/events/${eventId}/media/${item.id}/trash`,
        { method: 'POST', body: '{}' },
      ));
      if (eventScope.current.generation !== scope) return;
      setTrashCandidate(null);
      trashOrigin.current = null;
      // Remove the card here rather than reloading the page: the host is looking
      // at the grid, and a reload would move everything under them.
      intakeResource.update((current) => (current && current.mode === 'active'
        ? { ...current, rows: current.rows.filter(({ id }) => id !== item.id) }
        : current));
      // Trash changed stored counts and bytes, Gallery membership, the current
      // Intake question, and what the Guestbook feed shows. Manager owns all
      // four reads and retires them together; no child ref participates.
      invalidateGalleryAfterMutation();
      fallback?.focus();
      const deadline = formatRetentionDate(trashed.restoreUntil, event?.eventTimezone ?? 'UTC')
        ?? TIME_UNAVAILABLE;
      const name = trashed.caption || trashed.originalFilename;
      setRecoveryAnnouncement(
        `${name} moved to Recently deleted. Restore is available until ${deadline}.`,
      );
      const inverseEventId = eventId;
      const inverseMediaId = trashed.id;
      managerUndo.present({
        eventId: inverseEventId,
        message: `${name} moved to Recently deleted. The original is retained until ${deadline}.`,
        durationMs: TRASH_UNDO_WINDOW_MS,
        absoluteDeadline: trashed.restoreUntil,
        input: activation,
        run: async () => {
          try {
            await api(
              `/api/manage/events/${inverseEventId}/media/${inverseMediaId}/restore`,
              { method: 'POST', body: '{}' },
            );
          } finally {
            // A lost response or deadline race is uncertain too. Reconcile the
            // same canonical owners before the provider exposes Retry.
            invalidateGalleryAfterMutation();
          }
        },
      }, { fallback });
    } catch (caught) {
      if (eventScope.current.generation === scope) {
        reportManagerActionFailure(caught, 'This photo could not be moved to Recently deleted.', scope);
        setTrashCandidate(null);
        trashOrigin.current?.focus();
        trashOrigin.current = null;
      }
    } finally {
      if (eventScope.current.generation === scope) setTrashPending(false);
    }
  }

  async function restoreFromTrashRow(row: TrashedMediaView) {
    const scope = eventScope.current.generation;
    const name = row.caption || row.originalFilename;
    const fallback = resolveIntakeFallback(row.id) ?? trashHeading.current;
    await runManagerAction(async () => {
      await eventWrite(() => api(
        `/api/manage/events/${eventId}/media/${row.id}/restore`,
        { method: 'POST', body: '{}' },
      ));
      if (eventScope.current.generation !== scope) return;
      intakeResource.update((current) => (current && current.mode === 'trash'
        ? { ...current, rows: current.rows.filter(({ id }) => id !== row.id) }
        : current));
      setRecoveryAnnouncement(`${name} is back in Live intake.`);
      invalidateGalleryAfterMutation();
      fallback?.focus();
    });
  }

  function adoptAcceptedExport(job: ExportView) {
    // A dispatch failure (or exceptionally fast Workflow) can make the POST's
    // first projection terminal, so there may be no queued/running render from
    // which the liveness tracker could learn this accepted job.
    lastActiveExport.current = { eventId, id: job.id };
    exportsResource.update((current) => [
      job,
      ...(current ?? []).filter((candidate) => (
        candidate.kind !== job.kind
        // The repository admits only one active export across both kinds. If
        // this POST succeeded, an active job retained for the other kind is a
        // stale projection and must not compete with the accepted owner.
        && candidate.state !== 'queued'
        && candidate.state !== 'running'
      )),
    ]);
  }

  async function reconcileActiveExportConflict(caught: unknown, scope: number) {
    if (!(caught instanceof ClientApiError)
      || caught.code !== 'EXPORT_ALREADY_ACTIVE'
      || caught.status !== 409
      || eventScope.current.generation !== scope) return;
    // Another tab may have won either kind. Reconcile the server-selected
    // latest jobs so its active owner starts this tab's lock, poll, and status;
    // the original action error is still rethrown and remains visible.
    await exportsResource.reload().catch(() => undefined);
  }

  async function prepareExport(kind: ExportKind = 'complete') {
    const scope = eventScope.current.generation;
    const body = kind === 'album' ? JSON.stringify({ kind: 'album' }) : '{}';
    let result: { export: ExportView };
    try {
      result = await eventWrite(() => api<{ export: ExportView }>(
        `/api/manage/events/${eventId}/exports`,
        { method: 'POST', body },
      ));
    } catch (caught) {
      await reconcileActiveExportConflict(caught, scope);
      throw caught;
    }
    if (eventScope.current.generation !== scope) return;
    // The mutation response is the first authoritative projection of the job
    // the server accepted. Adopt it before the reconciliation GET so a slow or
    // retryable failed read cannot leave both kinds enabled with no global poll.
    adoptAcceptedExport(result.export);
    await exportsResource.reload();
  }
  async function downloadExport(job: ExportView) {
    const scope = eventScope.current.generation;
    const result = await eventWrite(() => api<ExportDownloadView>(`/api/manage/events/${eventId}/exports/${job.id}/download`, { method: 'POST', body: '{}' }));
    if (eventScope.current.generation !== scope) return;
    setExportDownloads((current) => ({ ...current, [job.id]: result }));
  }
  async function retryExport(job: ExportView) {
    const scope = eventScope.current.generation;
    let result: { export: ExportView };
    try {
      result = await eventWrite(() => api<{ export: ExportView }>(
        `/api/manage/events/${eventId}/exports/${job.id}/retry`,
        { method: 'POST', body: '{}' },
      ));
    } catch (caught) {
      await reconcileActiveExportConflict(caught, scope);
      throw caught;
    }
    if (eventScope.current.generation !== scope) return;
    adoptAcceptedExport(result.export);
    await exportsResource.reload();
  }
  function managerLinkRotationIsAvailable(
    candidate: EventView | null,
  ): candidate is EventView & { managerLinkRevision: number } {
    return candidate !== null
      && candidate.managerLinkRevision !== null
      && candidate.managerLinkRotationAvailability?.enabled === true;
  }

  function openManagerLinkRotation() {
    if (managerLinkRotation !== null || !managerLinkRotationIsAvailable(event)) return;
    setActionError(null);
    setManagerLinkRotation({ phase: 'confirmation' });
  }

  function closeManagerLinkRotation() {
    if (
      managerLinkRotation?.phase === 'pending'
      || (
        managerLinkRotation?.phase === 'success'
        && managerLinkRotation.saveStatus !== 'copied'
      )
    ) return;
    rotationRequestGeneration.current += 1;
    rotationRequestPending.current = false;
    resumeManagerResourcesAfterRotation();
    setManagerLinkRotation(null);
  }

  async function refreshManagerLinkRevisionAfterAmbiguous(requestGeneration: number) {
    try {
      const loaded = await api<{ event: EventView }>(`/api/manage/events/${eventId}`);
      if (
        requestGeneration !== rotationRequestGeneration.current
        || !managerMounted.current
        || eventScope.current.eventId !== eventId
      ) return;
      if (!managerLinkRotationIsAvailable(loaded.event)) {
        setManagerLinkRotation({
          phase: 'ambiguous',
          refreshStatus: 'failed',
          refreshError: 'Account access could not be confirmed. Try refreshing again.',
        });
        return;
      }
      eventResource.adopt(loaded.event);
      setManagerLinkRotation({ phase: 'ambiguous', refreshStatus: 'ready' });
    } catch (caught) {
      if (requestGeneration !== rotationRequestGeneration.current) return;
      setManagerLinkRotation({
        phase: 'ambiguous',
        refreshStatus: 'failed',
        refreshError: caught instanceof ClientApiError
          ? caught.message
          : 'Account access could not be refreshed. Try again.',
      });
    }
  }

  function retryAmbiguousManagerLinkRefresh() {
    if (managerLinkRotation?.phase !== 'ambiguous' || managerLinkRotation.refreshStatus !== 'failed') return;
    const requestGeneration = rotationRequestGeneration.current;
    setManagerLinkRotation({ phase: 'ambiguous', refreshStatus: 'refreshing' });
    void refreshManagerLinkRevisionAfterAmbiguous(requestGeneration);
  }

  async function confirmManagerLinkRotation() {
    if (rotationRequestPending.current || managerLinkRotation?.phase !== 'confirmation') return;
    const authorizedEvent = shownEvent.current;
    if (!managerLinkRotationIsAvailable(authorizedEvent)) return;
    const expectedRevision = authorizedEvent.managerLinkRevision;
    const requestGeneration = ++rotationRequestGeneration.current;
    rotationRequestPending.current = true;
    retireManagerResourcesForRotation();
    setManagerLinkRotation({ phase: 'pending', expectedRevision });
    try {
      const rotated = await api<{
        managementLink: string;
        managerLinkRevision: number;
      }>(`/api/manage/events/${eventId}/links/manager/rotate`, {
        method: 'POST',
        body: JSON.stringify({ expectedManagerLinkRevision: expectedRevision }),
      });
      if (requestGeneration !== rotationRequestGeneration.current || !managerMounted.current) return;
      eventResource.update((current) => current
        ? { ...current, managerLinkRevision: rotated.managerLinkRevision }
        : current);
      setManagerLinkRotation({
        phase: 'success',
        managementLink: rotated.managementLink,
        managerLinkRevision: rotated.managerLinkRevision,
        saveStatus: 'required',
      });
    } catch (caught) {
      if (requestGeneration !== rotationRequestGeneration.current || !managerMounted.current) return;
      if (caught instanceof ClientApiError) {
        resumeManagerResourcesAfterRotation();
        setManagerLinkRotation({
          phase: 'failure',
          message: `The current management link was not changed. ${caught.message}`,
        });
      } else {
        setManagerLinkRotation({ phase: 'ambiguous', refreshStatus: 'refreshing' });
        await refreshManagerLinkRevisionAfterAmbiguous(requestGeneration);
      }
    } finally {
      if (requestGeneration === rotationRequestGeneration.current) {
        rotationRequestPending.current = false;
      }
    }
  }

  function recordManagerLinkCopyOutcome(outcome: 'copied' | 'unavailable') {
    setManagerLinkRotation((current) => current?.phase === 'success'
      ? { ...current, saveStatus: outcome === 'copied' ? 'copied' : 'unavailable' }
      : current);
  }

  function acknowledgeSavedManagerLink() {
    if (managerLinkRotation?.phase !== 'success' || managerLinkRotation.saveStatus !== 'unavailable') return;
    resumeManagerResourcesAfterRotation();
    setManagerLinkRotation(null);
  }
  function openEntryAction(action: EntryAction, origin: HTMLElement) {
    if (entryActionPendingRef.current) return;
    entryActionNoticeFocusRequested.current = false;
    entryActionOrigin.current = origin;
    setEntryConfirm('');
    setEntryAction(action);
  }

  function cancelEntryAction() {
    if (entryActionPendingRef.current) return;
    setEntryAction(null);
    setEntryConfirm('');
  }

  // The broad actions share exact-name validation and one in-flight owner. The
  // client guard is repeated here, immediately beside request creation, so a
  // stale or synthetic activation cannot bypass the disabled button.
  async function runEntryAction(action: EntryAction) {
    if (
      entryActionPendingRef.current
      || entryAction !== action
      || entryConfirm.trim() !== event.name
    ) return;
    const scope = eventScope.current.generation;
    entryActionPendingRef.current = true;
    setEntryActionPending(true);
    try {
      if (action === 'delete') {
        await api(`/api/manage/events/${eventId}`, {
          method: 'DELETE',
          body: JSON.stringify({ confirmation: entryConfirm.trim() }),
        });
        if (eventScope.current.generation === scope) window.location.assign('/');
        return;
      }

      const path = action === 'rotate' ? 'guest-sessions/rotate' : 'entry/disable';
      const result = await eventWrite(() => api<{ disabledAt?: string }>(`/api/manage/events/${eventId}/${path}`, {
        method: 'POST',
        body: JSON.stringify({ confirmName: entryConfirm.trim() }),
      }));
      if (eventScope.current.generation !== scope) return;
      if (action === 'disable') {
        entryActionDisabledFocusRequested.current = true;
        entryDisabled.current = true;
        entryResource.update(() => ({
          eventLink: null,
          disabledAt: result.disabledAt ?? null,
        }));
        eventResource.update((current: EventView | null) => current
          ? { ...current, uploadsEnabled: false, photosOpen: false, photoIntakeState: 'paused', rsvpEnabled: false }
          : current);
      }
      setEntryAction(null);
      setEntryConfirm('');
      if (action === 'rotate') await entryResource.reload();
    } catch (caught) {
      if (eventScope.current.generation === scope) {
        entryActionNoticeFocusRequested.current = true;
        setEntryAction(null);
        setEntryConfirm('');
      }
      throw caught;
    } finally {
      if (eventScope.current.generation === scope) {
        entryActionPendingRef.current = false;
        setEntryActionPending(false);
      }
    }
  }
  // Roster and activation changes land on the event record, not on the media the
  // whole manager refresh pays for.
  async function refreshEvent() {
    const scope = eventScope.current.generation;
    const readToken = eventReads.current.openRead();
    const loaded = await api<{ event: EventView }>(`/api/manage/events/${eventId}`);
    if (eventScope.current.generation === scope && eventReads.current.adopt(readToken)) eventResource.adopt(loaded.event);
  }
  // Photo delivery is an explicit action rather than an autosaved setting, and
  // only the server decides which transition is legal from the row as it stands.
  // A page that loaded before the start therefore cannot send a pre-start action
  // after it: the refusal arrives as an ordinary manager notice telling the host
  // to reload.
  async function applyPhotoIntake(action: PhotoIntakeAction) {
    if (photoIntakePendingRef.current) return;
    const scope = eventScope.current.generation;
    photoIntakePendingRef.current = true;
    setPhotoIntakePending(true);
    try {
      const result = await eventWrite(() => api<{ event: EventView }>(`/api/manage/events/${eventId}/photo-intake`, {
        method: 'POST', body: JSON.stringify({ action }),
      }));
      if (eventScope.current.generation !== scope) return;
      eventResource.update((current: EventView | null) => current
        ? mergePhotoIntakeResponse(current, result.event, { entryDisabled: entryDisabled.current })
        : result.event);
    } finally {
      if (eventScope.current.generation === scope) {
        photoIntakePendingRef.current = false;
        setPhotoIntakePending(false);
      }
    }
  }
  async function reconcilePhotoIntakeAfterScheduleSave() {
    const scope = eventScope.current.generation;
    try {
      const loaded = await eventRead(() => api<{ event: EventView }>(`/api/manage/events/${eventId}`));
      if (eventScope.current.generation !== scope) return;
      eventResource.update((current: EventView | null) => current
        ? mergePhotoIntakeResponse(current, loaded.event, { entryDisabled: entryDisabled.current })
        : loaded.event);
    } catch {
      // This is a quiet reconciliation of derived state. The confirmed
      // settings response remains usable, and the lifecycle hook or a later
      // wake can reconcile intake without replacing the manager with an error.
    }
  }
  // The quiet boundary refetch, so a manager page left open across the scheduled
  // opening updates its status and its action without consulting this browser's
  // clock. It reports `changed` only when the server actually moved, and it
  // deliberately stays off the manager notice: a background refresh that fails
  // must leave the working page exactly as it is, and the hook backs off instead.
  async function recheckPhotoIntake(): Promise<LifecycleRecheckOutcome> {
    if (rotationResourcesPausedRef.current) return 'unchanged';
    const scope = eventScope.current.generation;
    const loaded = await eventRead(() => api<{ event: EventView }>(`/api/manage/events/${eventId}`));
    if (eventScope.current.generation !== scope) return 'unchanged';
    const shown = shownEvent.current;
    const moved = shown === null
      || managerLifecycleKey(shown) !== managerLifecycleKey(loaded.event);
    // A shorter relative delay is not a manager-visible transition. Leaving
    // the current event object alone preserves the hook's armed boundary and
    // the anti-spin floor established by this recheck.
    if (!moved) return 'unchanged';
    eventResource.update((current: EventView | null) => current
      ? mergePhotoIntakeResponse(current, loaded.event, {
          entryDisabled: entryDisabled.current,
          ownsSchedule: true,
        })
      : loaded.event);
    return 'changed';
  }
  useLifecycleRecheck(
    event?.photoIntakeRecheckAfterMs ?? null,
    recheckPhotoIntake,
    event ? managerLifecycleKey(event) : null,
  );
  const selectionAtLimit = selected.length >= MANAGER_BULK_SELECTION_MAX;
  const activeAlbumLeaveAttempt = albumLeaveAttempt && (
    albumLeaveAttempt.destination.kind !== 'router'
    || (
      blocker.state === 'blocked'
      && albumLeaveAttempt.destination.locationKey === blockedNavigationKey
    )
  ) ? albumLeaveAttempt : null;
  const albumPromptOutcome = activeAlbumLeaveAttempt?.outcome.status === 'ready'
    ? null
    : activeAlbumLeaveAttempt?.outcome ?? null;

  /**
   * Recently deleted.
   *
   * A retained photo is not shown as a photograph: there is no preview, no
   * original download, and no publication control, because the host asked for it
   * to stop being delivered. What is left is enough to recognize it — its name,
   * its guest, its caption — and the server's answer about how long Restore lasts.
   */
  function renderTrashList() {
    if (!intakePage && (
      intakeResource.state.status === 'idle'
      || intakeResource.state.status === 'loading'
    )) {
      return <LoadingState label="Opening Recently deleted…" />;
    }
    if (intakeResource.state.status === 'failed' && !intakePage) return null;
    if (!trashRows.length) {
      return <div className="empty-state">
        <Trash2 aria-hidden="true" />
        <h3>Nothing in Recently deleted.</h3>
        <p>Photos you remove stay here, and keep using this event's capacity, until you restore them or their recovery ends.</p>
      </div>;
    }
    const zone = event?.eventTimezone ?? 'UTC';
    return <>
      <ul className="trash-list">{trashRows.map((row) => {
        const deadline = formatRetentionDate(row.restoreUntil, zone);
        const expired = Date.parse(row.restoreUntil) <= trashNow;
        const name = row.caption || row.originalFilename;
        return <li key={row.id} data-intake-card={row.id}>
          <div>
            <strong title={name}>{name}</strong>
            <small>From {row.guestName}</small>
            {expired
              ? <small className="trash-list__state">Recovery expired · cleanup pending</small>
              : <small className="trash-list__state">Restore until {deadline === null
                  ? TIME_UNAVAILABLE
                  : <time dateTime={row.restoreUntil}>{deadline}</time>}</small>}
          </div>
          {/* No Restore past the deadline. An accepted export may still be holding
              the bytes, which is why the row is here at all, but recovery is over. */}
          {!expired && <button
            ref={(button) => {
              if (button) trashRestoreButtons.current.set(row.id, button);
              else trashRestoreButtons.current.delete(row.id);
            }}
            type="button"
            className="button button--secondary"
            aria-label={`Restore ${row.originalFilename}`}
            data-restore-media-id={row.id}
            onClick={() => void restoreFromTrashRow(row)}
          ><RotateCcw aria-hidden="true" /> Restore</button>}
        </li>;
      })}</ul>
      {nextMediaCursor && <div className="media-more">
        <button type="button" className="button button--secondary" disabled={loadingMore} onClick={() => void loadMoreMedia()}>Load more</button>
      </div>}
    </>;
  }

  function renderMediaGrid(publicationControls: boolean) {
    if (!intakePage && (
      intakeResource.state.status === 'idle'
      || intakeResource.state.status === 'loading'
    )) {
      return <LoadingState label="Opening the live intake…" />;
    }
    // A failed new query has no authoritative answer. The recovery panel above
    // explains the failure; calling an unanswered query empty would be false.
    if (intakeResource.state.status === 'failed' && !intakePage) return null;
    if (!media.length) {
      if (status !== 'all' || guestFilter) {
        return <div className="empty-state">
          <ImageIcon aria-hidden="true" />
          <h3>No matching photos</h3>
          <p>No delivered photos match the active filters.</p>
          <button
            type="button"
            className="button button--secondary"
            onClick={() => {
              setStatus('all');
              setSearchInput('');
              setGuestFilter('');
            }}
          >Clear filters</button>
        </div>;
      }
      return <div className="empty-state">
        <ImageIcon aria-hidden="true" />
        <h3>No photos yet</h3>
        <p>Guests&apos; photos arrive privately here.</p>
        <div className="button-row">
          <button
            type="button"
            className="button button--primary"
            onClick={() => { void openSection('share'); }}
          >Share event</button>
          <button
            type="button"
            className="button button--secondary"
            aria-disabled={!hostUploadAvailability.enabled}
            aria-describedby={hostUploadUnavailableMessage === null
              ? undefined
              : 'empty-host-upload-unavailable-reason'}
            onClick={(click) => openManagerUpload(click.currentTarget)}
          >Add photos</button>
        </div>
        {hostUploadUnavailableMessage !== null && <p
          id="empty-host-upload-unavailable-reason"
          className="intake-note"
        >{hostUploadUnavailableMessage}</p>}
      </div>;
    }
    return <>
      <div className="moderation-grid intake-grid">{media.map((item) => {
        const isSelected = selected.includes(item.id);
        const selectionUnavailable = !isSelected && selectionAtLimit;
        return <article className={isSelected ? 'selected' : ''} key={item.id} data-intake-card={item.id}>
          <div className="intake-photo">
            {publicationControls && <label className="intake-select"><input
              type="checkbox"
              aria-label={`Select ${item.originalFilename}`}
              aria-describedby={selectionUnavailable ? 'bulk-selection-status' : undefined}
              checked={isSelected}
              disabled={selectionUnavailable}
              onChange={(change) => setSelected((current) => {
                if (!change.target.checked) return current.filter((id) => id !== item.id);
                if (current.includes(item.id) || current.length >= MANAGER_BULK_SELECTION_MAX) return current;
                return [...current, item.id];
              })}
            /></label>}
            <img src={mediaPreview(item.id)} alt={item.caption || item.originalFilename} loading="lazy" decoding="async" />
          </div>
          <div>
            <span className={`publication publication--${item.publicationStatus}`}>{item.publicationStatus}</span>
            <strong title={item.caption || item.originalFilename}>{item.caption || item.originalFilename}</strong>
            <small>From {item.guestName}</small>
            <div className="intake-card-actions">
              <a href={mediaOriginal(item.id)} download aria-label={`Download original ${item.originalFilename}`}><Download aria-hidden="true" /></a>
              {publicationControls && item.publicationStatus !== 'published' && <button aria-label={`Publish ${item.originalFilename}`} onClick={() => void runManagerAction(async () => { await changePublication(item, 'publish'); })}><Eye aria-hidden="true" /></button>}
              {publicationControls && item.publicationStatus !== 'hidden' && <button aria-label={`Hide ${item.originalFilename}`} onClick={() => void runManagerAction(async () => { await changePublication(item, 'hide'); })}><EyeOff aria-hidden="true" /></button>}
              {/* Opens the confirmation. No request is sent from here: the exact
                  recovery deadline does not exist until the server accepts the
                  transition, so nothing may be started before the host agrees. */}
              <button
                aria-label={`Move ${item.originalFilename} to Recently deleted`}
                disabled={!managerUndo.canPresent}
                onClick={(click) => openTrashConfirmation(item, click.currentTarget)}
              ><Trash2 aria-hidden="true" /></button>
            </div>
          </div>
        </article>;
      })}</div>
      {nextMediaCursor && <div className="media-more">
        <button type="button" className="button button--secondary" disabled={loadingMore} onClick={() => void loadMoreMedia()}>Load more photos</button>
      </div>}
    </>;
  }

  // Offered for the plain no-credential state as well as a dead account session: a
  // bare manager URL cannot prove whether it arrived from the account page or from a
  // copied management link, and signing in is safe either way.
  if (failure) return <main className="centered-state"><Brand /><div className="manager-load-failure">
    <h1 className="sr-only">Event manager unavailable</h1>
    <ErrorState
      message={failure.message}
      recoveryHint={failure.recoveryHint}
      onRetry={failure.retryable ? () => void refresh() : undefined}
    />
    <ManagerAccessRecovery failure={failure} eventId={eventId} returnTo={recoveryReturnTo} />
  </div></main>;
  if (!event) return <main className="centered-state"><Brand /><LoadingState label="Opening the event manager…" /></main>;

  const photoCount = event.storedMediaCount ?? 0;
  // Retained photos are not delivered any more, but they have not released their
  // slot or their bytes either — a Restore has to have somewhere to land. The
  // meter therefore measures what the event is actually holding, and says so.
  const recoverableCount = event.recoverableMediaCount ?? 0;
  const heldCount = photoCount + recoverableCount;
  const heldBytes = (event.storedBytes ?? 0) + (event.recoverableBytes ?? 0);
  const managerEventDate = formatEventDate(event.eventDate) ?? DATE_UNAVAILABLE;
  const purgeAfterDisplay = formatRetentionDate(event.purgeAfter, event.eventTimezone);
  const uploadChip = UPLOAD_CHIP[event.photoIntakeState];
  const entryActionDetails = entryAction === null ? null : ENTRY_ACTION_DETAILS[entryAction];

  const visibleNotice: ManagerNotice | null = autosaveRecovery
    ? { type: 'load', failure: autosaveRecovery.failure }
    : coverAccessFailure
      ? { type: 'load', failure: coverAccessFailure }
      : albumAccessFailure
        ? { type: 'load', failure: albumAccessFailure }
        // An escalated failure that arrived while the Manager was on screen. It
        // leads the ordinary action notices: a revoked credential explains every
        // one of them, and offering Try again for it would only fail again.
      : escalatedFailure
          ? { type: 'load', failure: escalatedFailure }
          : actionError;
  const durableHostUploadLifecycleFailure = hostUploadLifecycleFailure?.eventId === eventId
    && hostUploadLifecycleFailure.eventGeneration === eventScope.current.generation
    ? hostUploadLifecycleFailure.failure
    : null;
  const hostUploadAvailability = resolveHostUploadAvailability(
    event.hostUploadAvailability,
    durableHostUploadLifecycleFailure ?? escalatedFailure,
  );
  const hostUploadUnavailableMessage = hostUploadAvailability.reason === null
    ? null
    : HOST_UPLOAD_UNAVAILABLE_MESSAGE[hostUploadAvailability.reason];
  function openManagerUpload(invoker: HTMLElement) {
    if (!hostUploadAvailability.enabled || managerUploadOpen) return;
    managerUploadReturnFocus.current = invoker;
    managerUploadOwner.current = {
      eventId,
      eventGeneration: eventScope.current.generation,
      finalizedMediaIds: new Set(),
    };
    setManagerUploadOpen(true);
  }
  const managerLinkRotationInitialFocus = managerLinkRotation?.phase === 'success'
    ? managerLinkRotationCopy
    : managerLinkRotation?.phase === 'confirmation' || managerLinkRotation?.phase === 'pending'
      ? managerLinkRotationKeep
      : managerLinkRotationOutcome;
  const managerLinkRotationCanClose = managerLinkRotation?.phase === 'confirmation'
    || managerLinkRotation?.phase === 'failure'
    || managerLinkRotation?.phase === 'ambiguous'
    || (
      managerLinkRotation?.phase === 'success'
      && managerLinkRotation.saveStatus === 'copied'
    );
  return <>
    {createPortal(
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{galleryAnnouncement}</p>,
      galleryLiveHost,
    )}
    <div className="manager-shell manager-shell--intake">
    {/* The brand and the section navigation, which is a banner rather than complementary content. As
        an `aside` this announced a second unnamed complementary landmark beside the utility rail —
        `landmark-unique` — and as a plain `div` the brand fell outside every landmark — `region`. */}
    <header className="manager-nav"><Brand compact /><nav aria-label="Manager sections">
      <button disabled={rsvpCommitPending && section === 'rsvp'} aria-pressed={section === 'intake'} className={section === 'intake' ? 'active' : ''} onClick={() => { void openSection('intake'); }}><Inbox aria-hidden="true" /><span className="manager-nav__label">Intake</span>{photoCount > 0 && <span className="manager-nav__count">{photoCount}</span>}</button>
      <button aria-pressed={section === 'rsvp'} className={section === 'rsvp' ? 'active' : ''} onClick={() => { void openSection('rsvp'); }}><ClipboardCheck aria-hidden="true" /><span className="manager-nav__label">RSVP</span></button>
      <button disabled={rsvpCommitPending && section === 'rsvp'} aria-pressed={section === 'gallery'} className={section === 'gallery' ? 'active' : ''} onClick={() => { void openSection('gallery'); }}><ImageIcon aria-hidden="true" /><span className="manager-nav__label">Gallery</span></button>
      <button aria-label={guestbookSummary?.needsReviewCount ? `Guestbook ${guestbookSummary.needsReviewCount}` : 'Guestbook'} disabled={rsvpCommitPending && section === 'rsvp'} aria-pressed={section === 'guestbook'} className={section === 'guestbook' ? 'active' : ''} onClick={() => { void openSection('guestbook'); }}><MessageCircle aria-hidden="true" /><span className="manager-nav__label">Guestbook</span>{Boolean(guestbookSummary?.needsReviewCount) && <span className="manager-nav__count" aria-hidden="true">{guestbookSummary?.needsReviewCount}</span>}</button>
      <button disabled={rsvpCommitPending && section === 'rsvp'} aria-pressed={section === 'share'} className={section === 'share' ? 'active' : ''} onClick={() => { void openSection('share'); }}><LinkIcon aria-hidden="true" /><span className="manager-nav__label">Share</span></button>
      <button disabled={rsvpCommitPending && section === 'rsvp'} aria-pressed={section === 'settings'} className={section === 'settings' ? 'active' : ''} onClick={() => { void openSection('settings'); }}><Settings aria-hidden="true" /><span className="manager-nav__label">Settings</span></button>
    </nav></header>

    <main className="manager-main">
      <header className="manager-title"><div><p>{managerEventDate}</p><h1>{event.name}</h1></div><span className={`status status--${uploadChip.tone}`}>{uploadChip.tone === 'approved' ? <Check aria-hidden="true" /> : <EyeOff aria-hidden="true" />} {uploadChip.label}</span></header>
      {eventResource.state.failure && <ErrorState
        message={eventResource.state.failure.message}
        recoveryHint={eventResource.state.failure.recoveryHint}
        onRetry={() => void eventResource.reload()}
      />}
      <div className="lifecycle"><p><strong>{photoCount}</strong> delivered photos</p><p><strong>{formatBytes(event.storedBytes)}</strong> of {STORAGE_CAP} used</p><p>Files delete <strong>{purgeAfterDisplay === null
        ? TIME_UNAVAILABLE
        : <time dateTime={event.purgeAfter}>{purgeAfterDisplay}</time>}</strong></p></div>

      {visibleNotice && <section
        className="manager-action-error"
        aria-label="Manager notice"
        tabIndex={-1}
        ref={managerNotice}
      >
        <div className="manager-action-error__summary">
          <div className="manager-action-error__alert" role="alert">
            {visibleNotice.type === 'load'
              ? <span>{visibleNotice.failure.message}<span className="manager-action-error__recovery">{visibleNotice.failure.recoveryHint}</span></span>
              : <span>{visibleNotice.message}{visibleNotice.recoveryHint && <span className="manager-action-error__recovery">{visibleNotice.recoveryHint}</span>}</span>}
          </div>
          <button
            type="button"
            className="manager-action-error__dismiss"
            aria-label="Dismiss error"
            onClick={() => {
              if (autosaveRecovery) {
                // Album reports one access problem through both its domain state and
                // its access callback. Dismiss those together; a blocked exit can
                // raise the still-unresolved recovery again.
                if (autosaveRecovery.domain === 'album') setAlbumAccessFailure(null);
                setAutosaveRecovery(null);
              }
              else if (coverAccessFailure) setCoverAccessFailure(null);
              else if (albumAccessFailure) setAlbumAccessFailure(null);
              else if (escalatedFailure) setEscalatedFailure(null);
              else setActionError(null);
            }}
          ><X aria-hidden="true" /></button>
        </div>
        {visibleNotice.type === 'load' && (
          <ManagerAccessRecovery
            failure={visibleNotice.failure}
            eventId={eventId}
            returnTo={recoveryReturnTo}
          />
        )}
      </section>}

      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {recoveryAnnouncement}
      </p>
      <ManagerUndoBar />

      {section !== 'gallery' && activeExport && (
        <section className="manager-export-compact export-state" role="region" aria-label="Export progress">
          <p>{activeExport.kind === 'album' ? 'Album export' : 'Complete export'} · {EXPORT_STATE_LABELS[activeExport.state]}</p>
          {typeof activeExport.processedMediaCount === 'number' && (
            <span>
              {activeExport.processedMediaCount.toLocaleString()} of {activeExport.mediaCount.toLocaleString()} photos processed
            </span>
          )}
          <button
            type="button"
            className="button button--secondary"
            disabled={rsvpCommitPending}
            onClick={() => { void openSection('gallery'); }}
          >Open Gallery</button>
        </section>
      )}

      {stuckDomains.length > 0 && (
        <section className="manager-autosave-notice" aria-label="Unsaved settings">
          <p role="alert">{stuckDomains.map((domain) => domain.status === 'invalid'
            ? `${domain.label} has a change that cannot be saved yet.`
            : `${domain.label} could not save a change.`).join(' ')}</p>
          {section !== 'settings' && (
            <button type="button" className="button button--secondary" disabled={rsvpCommitPending} onClick={openSettingsForRepair}>
              Open settings
            </button>
          )}
        </section>
      )}

      {section === 'intake' && <section aria-labelledby="intake-title">
        <div className="workspace-heading"><div>
          <p className="section-label">Delivered photos</p>
          <h2 id="intake-title" tabIndex={-1} ref={intakeHeading}>
            {intakeMode === 'trash' ? 'Recently deleted' : 'Live intake'}
          </h2>
        </div>{intakeMode === 'active' && <div className="intake-upload-action">
          <button
            ref={addPhotosTrigger}
            type="button"
            className="button button--primary"
            aria-disabled={!hostUploadAvailability.enabled}
            aria-describedby={hostUploadUnavailableMessage === null
              ? undefined
              : 'host-upload-unavailable-reason'}
            onClick={(click) => openManagerUpload(click.currentTarget)}
          >Add photos</button>
          {hostUploadUnavailableMessage !== null && <p
            id="host-upload-unavailable-reason"
            className="intake-note"
          >{hostUploadUnavailableMessage}</p>}
        </div>}</div>
        {/* A filter over Intake, not a destination of its own: Recently deleted is
            the same collection seen from the other side, and it keeps its own
            rows, its own cursor, and none of the live list's filters. */}
        <div className="intake-modes" role="group" aria-label="Which photos to show">
          <button
            type="button"
            aria-pressed={intakeMode === 'active'}
            className={intakeMode === 'active' ? 'active' : ''}
            onClick={() => chooseIntakeMode('active')}
          >Live intake</button>
          <button
            type="button"
            aria-pressed={intakeMode === 'trash'}
            className={intakeMode === 'trash' ? 'active' : ''}
            onClick={() => chooseIntakeMode('trash')}
          >Recently deleted{event.recoverableMediaCount > 0 ? ` (${event.recoverableMediaCount})` : ''}</button>
        </div>
        {intakeMode === 'trash'
          ? <>
              <p className="intake-note" ref={trashHeading} tabIndex={-1}>
                These photos still use this event's capacity until they are restored or their
                recovery ends.
              </p>
              {showRecentlyDeletedIntentGuidance && <p className="intake-note">
                The retained photo may be under Load more.
              </p>}
              {intakeResource.state.failure && <ErrorState
                message={intakeResource.state.failure.message}
                recoveryHint={intakeResource.state.failure.recoveryHint}
                onRetry={() => void intakeResource.reload()}
              />}
              {renderTrashList()}
            </>
          : <>
              <form className="intake-search" onSubmit={(formEvent) => { formEvent.preventDefault(); setGuestFilter(searchInput.trim()); }}>
                <label><span className="sr-only">Filter by guest name</span><Search aria-hidden="true" /><input aria-label="Filter by guest name" value={searchInput} onChange={(change) => setSearchInput(change.target.value)} placeholder="Find a guest by name" /></label>
                <button className="button button--secondary">Filter</button>
                {guestFilter && <button type="button" className="text-button" onClick={() => { setStatus('all'); setSearchInput(''); setGuestFilter(''); }}>Clear</button>}
              </form>
              {intakeResource.state.failure && <ErrorState
                message={intakeResource.state.failure.message}
                recoveryHint={intakeResource.state.failure.recoveryHint}
                onRetry={() => void intakeResource.reload()}
              />}
              {renderMediaGrid(false)}
            </>}
      </section>}

      {/* Mounted only from its own destination, so the CSV, household, and totals
          requests never join the manager's initial load. */}
      {section === 'rsvp' && <ManagerRsvpPanel
        event={event}
        onEventWrite={eventWrite}
        onEventChanged={() => void runManagerAction(refreshEvent)}
        onRosterVersionObserved={(currentRosterVersion) => eventResource.update((current: EventView | null) => current
          ? { ...current, rsvpRosterVersion: Math.max(current.rsvpRosterVersion, currentRosterVersion) }
          : current)}
        onDraftDirtyChange={setRsvpDraftDirty}
        onDraftCloseRequested={() => setPendingRsvpClose(true)}
        onDraftCommitPendingChange={setRsvpCommitPending}
        discardDraftEpoch={rsvpDiscardEpoch}
      />}

      {section === 'gallery' && <ManagerGalleryWorkspace
        key={eventId}
        ref={galleryWorkspace}
        event={event}
        eventId={eventId}
        mode={galleryMode}
        onModeChange={requestGalleryMode}
        galleryMutationEpoch={galleryMutationEpoch}
        libraryInvalidationVersion={managerUploadLibrarySignal.eventId === eventId
          && managerUploadLibrarySignal.eventGeneration === eventScope.current.generation
          ? managerUploadLibrarySignal.version
          : 0}
        invalidateGalleryAfterMutation={invalidateGalleryAfterMutation}
        audience={audienceAuthority}
        onAnnouncement={setGalleryAnnouncement}
        shared={{
          onPublicationChanged: adoptPublicationRows,
          onOpenRecentlyDeleted: openRecentlyDeleted,
          // The filter travels through Manager's one-use Settings intent after
          // the same guest-list, autosave, Album, and anchor settlement gates.
          onOpenSettings: openGuestGallerySettings,
          settingsBlocked: rsvpCommitPending,
        }}
        onResourceEscalate={escalate}
        exports={{
          job: completeExport,
          albumJob: albumExport,
          activeJob: activeExport,
          download: completeExport ? exportDownloads[completeExport.id] : undefined,
          albumDownload: albumExport ? exportDownloads[albumExport.id] : undefined,
          status: exportsResource.state.status,
          onPrepare: (kind = 'complete') => runManagerAction(() => prepareExport(kind)),
          onDownload: (job) => runManagerAction(() => downloadExport(job)),
          onRetry: (job) => runManagerAction(() => retryExport(job)),
          failure: exportsResource.state.failure,
          onRetryLoad: () => void exportsResource.reload(),
          currentSource: {
            count: event.storedMediaCount,
            freshness: eventResource.state.status === 'ready' ? 'fresh' : 'stale',
            refreshing: eventResource.state.status === 'loading',
          },
        }}
        onAlbumAutosaveStateChange={recordAutosaveState}
        onAlbumAccessFailure={setAlbumAccessFailure}
        onAnchorReady={handleGalleryAnchorReady}
      />}

      {section === 'share' && <section className="manager-panel">
        <p className="section-label">Invite your guests</p>
        <h2>Share your event</h2>
        {entryResource.state.failure && <ErrorState
          message={entryResource.state.failure.message}
          recoveryHint={entryResource.state.failure.recoveryHint}
          onRetry={() => void entryResource.reload()}
        />}
        <div className="share-layout">
          <div>{eventLink
            ? <CopyableLinkCard label="Event link" value={eventLink} />
            : <p ref={entryDisabledResult} className="manager-notice" tabIndex={-1}>{entryDisabledAt
              ? 'This event QR was disabled and cannot be replaced.'
              : 'This event has no printed entry.'}</p>}
            <p className="form-note">One code for RSVPs now and event photos later. Print it once.</p>
          </div>
          {qr && <div className="manager-qr"><img src={qr} alt="Event QR code" /><a className="button button--secondary" href={qr} download="candidary-event-qr.png"><QrCode aria-hidden="true" /> Download QR</a></div>}
        </div>
        {eventLink && <section className="entry-controls" aria-labelledby="entry-controls-title">
          <h3 id="entry-controls-title">Event entry controls</h3>
          <div className="entry-controls__choices">
            <div>
              <p>Guests must scan again to get back in. The event link and every printed QR code stays the same.</p>
              <button type="button" className="button button--secondary" onClick={(click) => openEntryAction('rotate', click.currentTarget)}>Sign out guest devices</button>
            </div>
            <div className="entry-controls__danger">
              <p>This immediately signs out guests, pauses RSVP and photo delivery, and makes every invitation and sign using this QR stop working. It cannot be undone.</p>
              <button type="button" className="button button--danger-outline" onClick={(click) => openEntryAction('disable', click.currentTarget)}>Disable printed event QR</button>
            </div>
          </div>
        </section>}
        <section className="manager-export-route">
          <p>Prepare or retrieve the complete collection from the Gallery.</p>
          <button type="button" className="button button--secondary" onClick={openCompleteExport}>Open Gallery</button>
        </section>
      </section>}

      {section === 'guestbook' && <ManagerGuestbookPanel
        eventId={eventId}
        eventTimezone={event.eventTimezone}
        summary={guestbookSummary}
        summaryFailure={guestbookSummaryFailure}
        onSummaryRefresh={refreshGuestbookSummary}
        onSummaryObserved={guestbookResource.adopt}
        onOpenSettings={openSettingsForRepair}
        settingsBlocked={rsvpCommitPending}
      />}

      {settingsMounted && <section className="manager-panel" hidden={section !== 'settings'} inert={section !== 'settings'}>
        <p className="section-label">Event controls</p>
        <h2 ref={settingsHeading} tabIndex={-1}>Settings</h2>
        {guestGallerySettingsReturn && (
          <button
            type="button"
            className="button button--secondary"
            onClick={returnToGuestGallery}
          >Return to Guest gallery</button>
        )}
        <EventSettingsEditor
          key={'settings-' + event.id}
          ref={settingsAutosave}
          event={event}
          galleryVisibilityFocusEpoch={galleryVisibilityFocusEpoch}
          onEventWrite={eventWrite}
          onEventRead={eventRead}
          onSettingsSaved={(updated, { scheduleChanged }) => {
            const galleryVisibilityChanged = shownEvent.current !== null
              && shownEvent.current.galleryVisible !== updated.galleryVisible;
            eventResource.update((current: EventView | null) => current
              ? mergeSettingsResponse(current, updated, { entryDisabled: entryDisabled.current })
              : updated);
            if (galleryVisibilityChanged) {
              audienceResource.invalidate();
            }
            if (scheduleChanged) void reconcilePhotoIntakeAfterScheduleSave();
          }}
          onAutosaveStateChange={recordAutosaveState}
        />
        <ManagerPhotoIntakePanel
          event={event}
          entryDisabled={entryDisabledAt !== null}
          pending={photoIntakePending}
          onAction={(action) => void runManagerAction(() => applyPhotoIntake(action))}
        />
        <EventAppearanceEditor
          key={'appearance-' + event.id}
          ref={appearanceAutosave}
          event={event}
          onEventWrite={eventWrite}
          onEventRead={eventRead}
          onThemeSaved={(updated) => eventResource.update((current: EventView | null) => current ? mergeThemeResponse(current, updated) : updated)}
          onCoverSaved={(updated) => eventResource.update((current: EventView | null) => current ? mergeCoverResponse(current, updated) : updated)}
          onCoverAccessFailure={recordCoverAccessFailure}
          onAutosaveStateChange={recordAutosaveState}
        />
        <EventAccountCard eventId={event.id} />
        <section className="manager-credential" aria-labelledby="manager-credential-title">
          <h3 id="manager-credential-title">Manager access</h3>
          <p>Rotating issues a new management link and stops this one immediately. It does not change the printed event QR.</p>
          <button
            ref={managerLinkRotationTrigger}
            type="button"
            className="button button--secondary"
            aria-disabled={!managerLinkRotationIsAvailable(event)}
            aria-describedby={managerLinkRotationIsAvailable(event)
              ? undefined
              : 'manager-link-rotation-unavailable'}
            onClick={openManagerLinkRotation}
          >Rotate manager link</button>
          {!managerLinkRotationIsAvailable(event) && <p id="manager-link-rotation-unavailable">
            Sign in to an account that owns or cohosts this event to rotate its link
          </p>}
        </section>
        <div className="danger-zone">
          <h3>Delete this event</h3>
          <p>Type <strong>{event.name}</strong> to revoke access immediately and schedule every private file for permanent deletion.</p>
          <button
            type="button"
            className="button button--danger-outline"
            onClick={(click) => openEntryAction('delete', click.currentTarget)}
          ><Trash2 aria-hidden="true" /> Delete event</button>
        </div>
      </section>}

      {rsvpCommitPending && blocker.state === 'blocked' && <section
        className="unsaved-settings-prompt"
        role="region"
        aria-labelledby="saving-guest-list-title"
        tabIndex={-1}
        ref={pendingWorkPrompt}
      >
        <h2 id="saving-guest-list-title">Your guest list is being saved</h2>
        <p>Stay on this page until Candidary confirms whether the guest-list changes were saved.</p>
        <button type="button" className="button button--primary" onClick={cancelBlockedNavigation}>Stay</button>
      </section>}
      {!rsvpCommitPending && rsvpDraftDirty && (blocker.state === 'blocked' || pendingSection !== null || pendingRsvpClose) && <section
        className="unsaved-settings-prompt"
        role="region"
        aria-labelledby="unsaved-guest-list-title"
        tabIndex={-1}
        ref={pendingWorkPrompt}
      >
        <h2 id="unsaved-guest-list-title">Your pending work is not saved</h2>
        <p>Your guest-list draft will be discarded and cannot be recovered. {unconfirmedDomains.length > 0
          ? 'Settings or appearance changes are also unconfirmed. Requests already sent may still finish saving after you leave; unsent or invalid changes will be left behind.'
          : 'No guest-list changes have been sent yet.'}</p>
        <div className="button-row">
          <button type="button" className="button button--secondary" onClick={() => {
            setRsvpDraftDirty(false);
            setRsvpDiscardEpoch((current) => current + 1);
            if (blocker.state === 'blocked') {
              void proceedBlockedNavigation();
            } else if (pendingSection) {
              const destination = pendingSection;
              setPendingSection(null);
              setPendingRsvpClose(false);
              clearPendingManagerAdoption();
              void commitManagerLeaveDestination(destination);
            } else {
              setPendingRsvpClose(false);
            }
          }}>Discard draft</button>
          <button type="button" className="button button--primary" onClick={() => {
            setPendingSection(null);
            setPendingRsvpClose(false);
            if (blocker.state === 'blocked') cancelBlockedNavigation();
          }}>Stay</button>
        </div>
      </section>}
      {!rsvpDraftDirty
        && (blocker.state === 'blocked' || (
          activeAlbumLeaveAttempt !== null
          && activeAlbumLeaveAttempt.destination.kind !== 'router'
        ))
        && (
          unconfirmedDomains.length > 0
          || albumPromptOutcome?.status === 'invalid'
          || albumPromptOutcome?.status === 'failed'
        )
        && <UnsavedSettingsPrompt
        domains={unconfirmedDomains}
        albumOutcome={albumPromptOutcome}
        focusKey={activeAlbumLeaveAttempt
          ? activeAlbumLeaveAttempt.destination.kind === 'router'
            ? `router:${activeAlbumLeaveAttempt.destination.locationKey}`
            : activeAlbumLeaveAttempt.destination.kind === 'section'
              ? `section:${activeAlbumLeaveAttempt.destination.section}`
              : activeAlbumLeaveAttempt.destination.kind
          : blockedNavigationKey ? `router:${blockedNavigationKey}` : undefined}
        leaveDisabled={albumPromptOutcome === null
          && blocker.state === 'blocked'
          && authorizedAlbumTarget.current !== blockedNavigationTarget
          && (
          activeAlbumLeaveAttempt?.destination.kind !== 'router'
          || activeAlbumLeaveAttempt.destination.locationKey !== blockedNavigationKey
          || activeAlbumLeaveAttempt.outcome.status !== 'ready'
          )}
        onLeave={() => {
          if (
            blocker.state === 'blocked'
            && (
              authorizedAlbumTarget.current === blockedNavigationTarget
              || (
                activeAlbumLeaveAttempt?.destination.kind === 'router'
                && activeAlbumLeaveAttempt.destination.locationKey === blockedNavigationKey
                && activeAlbumLeaveAttempt.outcome.status === 'ready'
              )
            )
          ) void proceedBlockedNavigation();
        }}
        onRetryAlbum={retryAlbumLeave}
        onDiscardAlbum={discardAlbumAndLeave}
        onStay={albumPromptOutcome
          ? stayWithAlbum
          : stuckDomains.length > 0
          ? () => {
              const pending = pendingManagerAdoption.current;
              if (
                blocker.state === 'blocked'
                && pending?.destination.kind === 'guest-gallery-return'
                && pending.target === blockedNavigationTarget
              ) {
                cancelBlockedNavigation();
                settingsFocusRequested.current = true;
                setSettingsFocusEpoch((current) => current + 1);
                return;
              }
              if (
                blocker.state === 'blocked'
                && (
                  pending?.destination.kind === 'settings-repair'
                  || pending?.destination.kind === 'guest-gallery-settings'
                )
                && pending.target === blockedNavigationTarget
              ) {
                void proceedBlockedNavigation();
                return;
              }
              if (blocker.state === 'blocked') cancelBlockedNavigation();
              openSettingsForRepair();
            }
          : undefined}
      />}
    </main>

    {managerUploadOpen && <ManagerUploadDialog
      eventId={eventId}
      event={event}
      availability={hostUploadAvailability}
      returnFocusRef={managerUploadReturnFocus}
      inertExceptionRef={galleryLiveHostRef}
      hasUsableAccountCredential={event.managerLinkRevision !== null}
      onClose={closeManagerUpload}
      onExitGateChange={handleManagerUploadExitGate}
      onEscalate={escalate}
      onFinalized={handleManagerUploadFinalized}
      onRefreshAfterTerminal={invalidateAfterManagerUpload}
    />}

    {managerLinkRotation && <ModalSurface
      labelledBy="manager-link-rotation-title"
      initialFocusRef={managerLinkRotationInitialFocus}
      returnFocusRef={managerLinkRotationTrigger}
      onRequestClose={closeManagerLinkRotation}
      closePolicy={{
        escape: managerLinkRotationCanClose,
        backdrop: managerLinkRotationCanClose,
      }}
    >
      <div className="modal-backdrop">
        <div className="modal-card">
          {(managerLinkRotation.phase === 'confirmation' || managerLinkRotation.phase === 'pending') && <>
            <h2 id="manager-link-rotation-title">Rotate management link?</h2>
            <p>The current management link will stop working immediately.</p>
            <p>You must save the replacement before continuing.</p>
            <div className="button-row">
              <button
                ref={managerLinkRotationKeep}
                type="button"
                className="button button--secondary"
                disabled={managerLinkRotation.phase === 'pending'}
                onClick={closeManagerLinkRotation}
              >Keep current link</button>
              <button
                type="button"
                className="button button--danger-outline"
                disabled={managerLinkRotation.phase === 'pending'}
                onClick={() => { void confirmManagerLinkRotation(); }}
              >{managerLinkRotation.phase === 'pending' ? 'Rotating…' : 'Rotate link'}</button>
            </div>
          </>}

          {managerLinkRotation.phase === 'failure' && <>
            <h2 id="manager-link-rotation-title">The link was not rotated</h2>
            <p role="alert">{managerLinkRotation.message}</p>
            <button
              ref={managerLinkRotationOutcome}
              type="button"
              className="button button--primary"
              onClick={closeManagerLinkRotation}
            >Close</button>
          </>}

          {managerLinkRotation.phase === 'ambiguous' && <>
            <h2 id="manager-link-rotation-title">Confirm the replacement</h2>
            <p role="alert">{AMBIGUOUS_MANAGER_LINK_ROTATION}</p>
            {managerLinkRotation.refreshError && <p className="form-error">
              {managerLinkRotation.refreshError}
            </p>}
            <div className="button-row">
              {managerLinkRotation.refreshStatus === 'ready' && <button
                ref={managerLinkRotationOutcome}
                type="button"
                className="button button--primary"
                onClick={() => { setManagerLinkRotation({ phase: 'confirmation' }); }}
              >Rotate again</button>}
              {managerLinkRotation.refreshStatus === 'failed' && <button
                ref={managerLinkRotationOutcome}
                type="button"
                className="button button--primary"
                onClick={retryAmbiguousManagerLinkRefresh}
              >Refresh account access</button>}
              {managerLinkRotation.refreshStatus === 'refreshing' && <button
                ref={managerLinkRotationOutcome}
                type="button"
                className="button button--primary"
                disabled
              >Refreshing account access…</button>}
              <button
                type="button"
                className="button button--secondary"
                onClick={closeManagerLinkRotation}
              >Close</button>
            </div>
          </>}

          {managerLinkRotation.phase === 'success' && <>
            <h2 id="manager-link-rotation-title">Save your new management link</h2>
            <p>The prior management link is no longer valid.</p>
            <CopyableLinkCard
              ref={managerLinkRotationCopy}
              label="Management link"
              value={managerLinkRotation.managementLink}
              sensitive
              onCopyOutcome={recordManagerLinkCopyOutcome}
            />
            <div className="button-row">
              <button
                ref={managerLinkRotationContinue}
                type="button"
                className="button button--primary"
                disabled={managerLinkRotation.saveStatus !== 'copied'}
                onClick={closeManagerLinkRotation}
              >Continue managing</button>
              {managerLinkRotation.saveStatus === 'unavailable' && <button
                type="button"
                className="button button--secondary"
                onClick={acknowledgeSavedManagerLink}
              >I've saved this link — continue</button>}
            </div>
          </>}
        </div>
      </div>
    </ModalSurface>}

    {entryAction && entryActionDetails && <ModalSurface
      labelledBy="entry-action-confirmation-title"
      initialFocusRef={entryActionCancel}
      returnFocusRef={entryActionOrigin}
      onRequestClose={cancelEntryAction}
      closePolicy={{
        escape: !entryActionPending,
        backdrop: !entryActionPending,
      }}
    >
      <div className="modal-backdrop">
        <div className="modal-card">
          <h2 id="entry-action-confirmation-title">{entryActionDetails.verb}?</h2>
          <fieldset className={entryActionDetails.danger
            ? 'entry-confirm entry-confirm--danger'
            : 'entry-confirm'}>
            <legend>{entryActionDetails.verb}</legend>
            <p>{entryActionDetails.warning}</p>
            <p>Type <strong>{event.name}</strong> to confirm.</p>
            {entryActionPending && <p
              ref={entryActionPendingStatus}
              role="status"
              tabIndex={0}
            >{entryActionDetails.verb} is in progress. Wait for it to finish.</p>}
            <label htmlFor="entry-confirm-name">Confirm event name</label>
            <input
              id="entry-confirm-name"
              value={entryConfirm}
              autoComplete="off"
              spellCheck={false}
              disabled={entryActionPending}
              onChange={(change) => setEntryConfirm(change.target.value)}
            />
            <div className="button-row">
              <button
                ref={entryActionCancel}
                type="button"
                className="button button--secondary"
                disabled={entryActionPending}
                onClick={cancelEntryAction}
              >Cancel</button>
              <button
                type="button"
                className={entryActionDetails.danger
                  ? 'button button--danger-outline'
                  : 'button button--secondary'}
                disabled={entryActionPending || entryConfirm.trim() !== event.name}
                onClick={() => void runManagerAction(() => runEntryAction(entryAction))}
              >{entryActionPending ? `${entryActionDetails.verb}…` : `${entryActionDetails.verb} for ${event.name}`}</button>
            </div>
          </fieldset>
        </div>
      </div>
    </ModalSurface>}


    {/*
      The confirmation that stands in front of every host deletion.

      Everything it promises is stated before the request exists: what stops
      showing the photo, what cannot be recalled, how long recovery lasts and
      what shortens it, that the retained photo keeps spending capacity, and that
      an export already prepared keeps its own copy. The exact deadline is
      deliberately absent — it does not exist until the server accepts this.
    */}
    {trashCandidate && <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(press) => { if (press.target === press.currentTarget) closeTrashConfirmation(); }}
    >
      <div
        ref={trashDialog}
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="trash-confirm-title"
        aria-describedby="trash-confirm-body"
        onKeyDown={(key) => {
          if (key.key === 'Escape') {
            key.stopPropagation();
            closeTrashConfirmation();
            return;
          }
          if (key.key !== 'Tab') return;
          const focusable = Array.from(
            trashDialog.current?.querySelectorAll<HTMLElement>('button') ?? [],
          );
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (!first || !last) return;
          if (key.shiftKey && document.activeElement === first) {
            key.preventDefault();
            last.focus();
          } else if (!key.shiftKey && document.activeElement === last) {
            key.preventDefault();
            first.focus();
          }
        }}
      >
        <h2 id="trash-confirm-title">Move this photo to Recently deleted?</h2>
        <div id="trash-confirm-body">
          <p><strong>{trashCandidate.caption || trashCandidate.originalFilename}</strong> from {trashCandidate.guestName}.</p>
          <p>
            From now on it is removed from Library, Album, the Guest gallery, and a live Album
            link. Pages already open, and copies anyone has already downloaded, cannot be recalled.
          </p>
          <p>
            You can restore it for up to 30 days — never past your management access or the event's
            deletion date, whichever comes first. Until then the photo keeps using this event's
            photo and storage capacity.
          </p>
          <p>
            An export you have already prepared keeps its own copy of this photo. Removing it here
            does not change a ZIP that is already made.
          </p>
        </div>
        <div className="modal-actions">
          {/* Initial focus, and never the destructive one. */}
          <button
            type="button"
            ref={trashKeepButton}
            className="button button--secondary"
            disabled={trashPending}
            onClick={closeTrashConfirmation}
          >Keep photo</button>
          <button
            type="button"
            className="button button--danger"
            disabled={trashPending || !managerUndo.canPresent}
            onClick={(click) => {
              // Pointer activation leaves focus where the host put it; keyboard
              // activation has just removed a control from under them, so the
              // Undo offer becomes where focus belongs.
              const activation = click.detail === 0 ? 'keyboard' : 'pointer';
              void confirmTrash(trashCandidate, activation);
            }}
          >{trashPending ? 'Moving…' : 'Move to Recently deleted'}</button>
        </div>
      </div>
    </div>}

    <aside className="manager-utility">
      <section className="manager-utility__guest-entry"><p className="section-label">Event entry</p><h2>Scan to join</h2>{qr && <img className="intake-qr" src={qr} alt="Event QR code" />}<button type="button" className="button button--secondary button--wide" disabled={!eventLink} onClick={() => void copyEventLink()}><Copy aria-hidden="true" /> Copy event link</button></section>
      <section className="manager-utility__capacity"><p className="section-label">Event capacity</p><div className="stat"><strong>{photoCount}</strong><span>Delivered photos</span></div><div className="meter"><span style={{ width: `${Math.min(100, (heldCount / MAX_EVENT_MEDIA) * 100)}%` }} /></div><small>{heldCount.toLocaleString()} of {PHOTO_CAP} · {formatBytes(heldBytes)} of {STORAGE_CAP}</small>{recoverableCount > 0 && <small className="manager-utility__recoverable">Includes {recoverableCount.toLocaleString()} in Recently deleted, held until restored or cleaned up</small>}</section>
    </aside>
    </div>
  </>;
}

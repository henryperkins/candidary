import { Check, ClipboardCheck, Copy, Download, Eye, EyeOff, Image as ImageIcon, Inbox, Link as LinkIcon, MessageCircle, QrCode, Search, Settings, Trash2, X } from 'lucide-react';
import QRCode from 'qrcode';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useBlocker, useParams, useSearchParams } from 'react-router-dom';

import { api, ClientApiError, mediaOriginal, mediaPreview } from '../app/api';
import { formatBytes } from '../app/format';
import { hostSignInHref } from '../app/recovery';
import {
  MANAGER_BULK_SELECTION_MAX,
  MAX_EVENT_BYTES,
  MAX_EVENT_MEDIA,
} from '../../shared/constants';
import type { ExportKind, PhotoIntakeState } from '../../shared/contracts';
import type { EventView, ExportDownloadView, ExportView, ManagerMediaPage, MediaView } from '../app/types';
import { Brand } from '../components/Brand';
import { CopyableLinkCard } from '../components/CopyableLinkCard';
import { EventAccountCard } from '../components/EventAccountCard';
import { EventAppearanceEditor } from '../components/EventAppearanceEditor';
import { EventSettingsEditor } from '../components/EventSettingsEditor';
import { ManagementLinkRecovery } from '../components/ManagementLinkRecovery';
import { ManagerPhotoIntakePanel } from '../components/ManagerPhotoIntakePanel';
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
  type ManagerGalleryWorkspaceHandle,
} from '../features/gallery/ManagerGalleryWorkspace';
import {
  mergeCoverResponse,
  mergePhotoIntakeResponse,
  mergeSettingsResponse,
  mergeThemeResponse,
} from '../features/settings/event-merge';
import { createEventReadGuard } from '../features/settings/event-read-guard';
import type { AutosaveHandle, DomainAutosaveState } from '../features/settings/autosave-queue';

type Section = 'intake' | 'rsvp' | 'gallery' | 'guestbook' | 'share' | 'settings';
type MediaStatus = 'all' | MediaView['publicationStatus'];

// The only destination a link may open directly. The create receipt sends a brand
// new event here, because a paused event's next real step is its guest list.
function initialSection(requested: string | null): Section {
  return requested === 'rsvp' ? 'rsvp' : 'intake';
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
type EntryAction = 'rotate' | 'disable';

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
interface MediaPageState {
  rows: MediaView[];
  cursor: string | null;
}

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
}: {
  failure: LoadFailure;
  eventId: string;
}) {
  if (!offersAccessRecovery(failure)) return null;
  return <section className="manager-access-recovery" aria-label="Recover manager access">
    {failure.offerSignIn && (
      <a className="button button--secondary" href={hostSignInHref(eventId)}>Sign in</a>
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
  'open-early': { tone: 'approved', label: 'Guest uploads open' },
  open: { tone: 'approved', label: 'Guest uploads open' },
  paused: { tone: 'pending', label: 'Guest uploads paused' },
};

export function ManagerPage() {
  const { eventId = '' } = useParams();
  const [searchParams] = useSearchParams();
  const [event, setEvent] = useState<EventView | null>(null);
  // Quiet lifecycle reads resolve asynchronously; compare their semantic
  // answer with what is actually on screen, not the render that started them.
  const shownEvent = useRef<EventView | null>(null);
  shownEvent.current = event;
  const [mediaPage, setMediaPage] = useState<MediaPageState>({ rows: [], cursor: null });
  const { rows: media, cursor: nextMediaCursor } = mediaPage;
  const [guestbookSummary, setGuestbookSummary] = useState<GuestbookSummary | null>(null);
  const [guestbookSummaryFailure, setGuestbookSummaryFailure] = useState<string | null>(null);
  const [exports, setExports] = useState<ExportView[]>([]);
  const [exportDownloads, setExportDownloads] = useState<Record<string, ExportDownloadView>>({});
  const [eventLink, setEventLink] = useState('');
  const [entryDisabledAt, setEntryDisabledAt] = useState<string | null>(null);
  // Updated synchronously when disable confirms so an already-resolving
  // settings response cannot slip through before React commits the new entry
  // state. The full refresh later supplies the server's canonical timestamp.
  const entryDisabled = useRef(false);
  const [photoIntakePending, setPhotoIntakePending] = useState(false);
  const photoIntakePendingRef = useRef(false);
  const [qr, setQr] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [section, setSection] = useState<Section>(() => initialSection(searchParams.get('section')));
  // Settings stays mounted after its first visit so a debounce timer, an
  // in-flight write, and an unsaved draft all survive a destination change.
  const [settingsMounted, setSettingsMounted] = useState(false);
  const [settingsFocusEpoch, setSettingsFocusEpoch] = useState(0);
  const settingsFocusRequested = useRef(false);
  const settingsHeading = useRef<HTMLHeadingElement>(null);
  const [entryAction, setEntryAction] = useState<EntryAction | null>(null);
  const [entryConfirm, setEntryConfirm] = useState('');
  const [status, setStatus] = useState<MediaStatus>('all');
  const [searchInput, setSearchInput] = useState('');
  const [guestFilter, setGuestFilter] = useState('');
  const [failure, setFailure] = useState<LoadFailure | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
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
  const [pendingSection, setPendingSection] = useState<Section | null>(null);
  const [pendingRsvpClose, setPendingRsvpClose] = useState(false);
  const [pendingSettingsRepair, setPendingSettingsRepair] = useState(false);
  const pendingWorkPrompt = useRef<HTMLElement>(null);
  const managerNotice = useRef<HTMLElement>(null);
  const galleryWorkspace = useRef<ManagerGalleryWorkspaceHandle>(null);
  const sectionTransitionPending = useRef(false);
  // Once the manager has rendered, a later load failure must not throw the host back to a bare error
  // page: it becomes the same inline, recoverable notice a failed mutation uses — carrying the
  // recovery hint with it, because the inline notice offers no `Try again` of its own either.
  const loadedOnce = useRef(false);
  const guestbookSummaryRequest = useRef(0);
  // Both the whole-page load and the export poll write `exports`; the later request wins.
  const exportsRead = useRef(0);
  const loadMoreOwner = useRef<AbortController | null>(null);
  // Reads and writes of the event row overlap once autosave can be running
  // behind another destination. Every write brackets itself here, and every
  // whole-event read checks whether it was overtaken before it is adopted.
  const eventReads = useRef(createEventReadGuard());
  const eventWrite = useCallback(async <T,>(request: () => Promise<T>): Promise<T> => {
    eventReads.current.beginWrite();
    try {
      return await request();
    } finally {
      eventReads.current.endWrite();
    }
  }, []);
  const eventRead = useCallback(<T,>(request: () => Promise<T>): Promise<T> => (
    eventReads.current.readFresh(request)
  ), []);
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
  const shouldBlockNavigation = unconfirmedDomains.length > 0
    || rsvpDraftDirty
    || rsvpCommitPending;
  const blocker = useBlocker(shouldBlockNavigation);
  const blockedNavigationKey = blocker.state === 'blocked'
    ? blocker.location.key
    : null;
  const [albumPrepareResult, setAlbumPrepareResult] = useState<{
    navigationKey: string;
    ready: boolean;
  } | null>(null);
  const albumPrepareGeneration = useRef(0);

  useEffect(() => {
    const generation = ++albumPrepareGeneration.current;
    if (blocker.state !== 'blocked') {
      setAlbumPrepareResult(null);
      return;
    }
    const navigationKey = blocker.location.key;
    settingsAutosave.current?.flush();
    appearanceAutosave.current?.flush();
    void (async () => {
      const ready = await galleryWorkspace.current?.prepareToLeave() ?? true;
      if (generation !== albumPrepareGeneration.current) return;
      setAlbumPrepareResult({ navigationKey, ready });
    })();
  }, [blocker.state]);
  useEffect(() => {
    // The requested navigation happens by itself the moment both domains
    // confirm; the host never has to answer the prompt twice.
    if (
      blocker.state === 'blocked'
      && albumPrepareResult?.navigationKey === blockedNavigationKey
      && albumPrepareResult.ready
      && unconfirmedDomains.length === 0
      && !rsvpDraftDirty
      && !rsvpCommitPending
    ) blocker.proceed();
  }, [albumPrepareResult, blockedNavigationKey, blocker, rsvpCommitPending, rsvpDraftDirty, unconfirmedDomains.length]);
  useEffect(() => {
    if (unconfirmedDomains.length === 0 && !rsvpDraftDirty && !rsvpCommitPending) return;
    // A browser may cancel background requests during unload, so this warns
    // rather than pretending a last-millisecond save is guaranteed.
    const warn = (unloadEvent: BeforeUnloadEvent) => { unloadEvent.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => { window.removeEventListener('beforeunload', warn); };
  }, [rsvpCommitPending, rsvpDraftDirty, unconfirmedDomains.length]);
  useEffect(() => {
    if (!albumAccessFailure && autosaveRecovery?.domain !== 'album') return;
    managerNotice.current?.focus();
  }, [albumAccessFailure, autosaveRecovery]);
  useEffect(() => {
    if (rsvpDraftDirty && (blocker.state === 'blocked' || pendingSection !== null || pendingRsvpClose)) {
      pendingWorkPrompt.current?.focus();
    }
  }, [blocker.state, pendingRsvpClose, pendingSection, rsvpDraftDirty]);

  const mediaPath = useCallback((cursor?: string) => {
    const params = new URLSearchParams();
    if (status !== 'all') params.set('status', status);
    if (guestFilter) params.set('guestName', guestFilter);
    // The cursor is opaque and `cursor=` is a validation failure, so an absent cursor stays absent.
    if (cursor) params.set('cursor', cursor);
    const query = params.toString();
    return `/api/manage/events/${eventId}/media${query ? `?${query}` : ''}`;
  }, [eventId, guestFilter, status]);

  // Media and the continuation cursor belong to the current query. This tracks which one that is, so a
  // request still open across a status or guest-filter change can tell that its answer is now stale.
  // Dropping the cursor here rather than waiting for the response also retires `Load more photos`
  // immediately, so the host cannot spend the previous query's cursor against the new one.
  const latestMediaPath = useRef(mediaPath);
  useEffect(() => {
    const superseded = loadMoreOwner.current;
    loadMoreOwner.current = null;
    superseded?.abort();
    setLoadingMore(false);
    latestMediaPath.current = mediaPath;
    setMediaPage((current) => current.cursor === null ? current : { ...current, cursor: null });
  }, [mediaPath]);
  useEffect(() => () => {
    const active = loadMoreOwner.current;
    loadMoreOwner.current = null;
    active?.abort();
  }, []);

  const refreshGuestbookSummary = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    const request = ++guestbookSummaryRequest.current;
    try {
      const loaded = await api<{ summary: GuestbookSummary }>(
        `/api/manage/events/${eventId}/guestbook/summary`,
      );
      if (request !== guestbookSummaryRequest.current) return false;
      setGuestbookSummary(loaded.summary);
      setGuestbookSummaryFailure(null);
      return true;
    } catch (caught) {
      if (request !== guestbookSummaryRequest.current) return false;
      if (!silent) {
        setGuestbookSummaryFailure(caught instanceof ClientApiError
          ? caught.message
          : 'The Guestbook summary could not be loaded.');
      }
      return false;
    }
  }, [eventId]);
  useEffect(() => () => {
    // Retire a completion owned by the prior event or an unmounted Manager.
    guestbookSummaryRequest.current += 1;
  }, [eventId]);

  // Reused verbatim behind Try again, so the prior failure clears the moment the attempt starts and
  // the host watches this load rather than the dead end the last one left.
  const refresh = useCallback(async () => {
    setFailure(null);
    try {
      // A disabled entry is a permanent event state, not lost manager access, so
      // it must not take the whole manager down with it.
      const entryLoad: Promise<EventEntryLoad> = api<EventEntryLoad>(`/api/manage/events/${eventId}/entry`)
        .catch((caught: unknown): EventEntryLoad => {
          if (caught instanceof ClientApiError && caught.code === 'EVENT_ENTRY_UNAVAILABLE') {
            return { eventLink: null, disabledAt: null };
          }
          throw caught;
        });
      const readToken = eventReads.current.openRead();
      const exportsGeneration = ++exportsRead.current;
      const [eventData, mediaData, exportData, linkData] = await Promise.all([
        api<{ event: EventView }>(`/api/manage/events/${eventId}`),
        api<ManagerMediaPage>(mediaPath()),
        api<{ exports: ExportView[] }>(`/api/manage/events/${eventId}/exports`),
        entryLoad,
        refreshGuestbookSummary(),
      ]);
      // Media, the Guestbook summary, exports, and the link are unaffected by a settings or
      // theme write, so only the event itself is at risk of being put back.
      if (eventReads.current.adopt(readToken)) setEvent(eventData.event);
      // A load opened under the previous query must not reinstate its rows or its cursor. Polling
      // merges rather than replaces, so a stale list here would sit behind every later poll forever.
      // Only the media half is query-scoped; exports and links are the same either way.
      if (latestMediaPath.current === mediaPath) {
        setMediaPage({ rows: mediaData.media, cursor: mediaData.nextCursor ?? null });
      }
      if (exportsGeneration === exportsRead.current) setExports(exportData.exports);
      setEventLink(linkData.eventLink ?? '');
      entryDisabled.current = linkData.disabledAt !== null;
      setEntryDisabledAt(linkData.disabledAt);
      loadedOnce.current = true;
    } catch (caught) {
      const loadFailure = describeLoadFailure(caught, 'manager', 'The event manager could not be loaded.');
      if (loadedOnce.current) {
        setActionError(loadFailure.kind === 'retry'
          ? { type: 'action', message: loadFailure.message }
          : { type: 'load', failure: loadFailure });
      } else {
        setFailure(loadFailure);
      }
    }
  }, [eventId, mediaPath, refreshGuestbookSummary]);

  // Exports only. The full `refresh` would also put back the event and the media page,
  // which a poll running behind a host's own edit has no business doing.
  const refreshExports = useCallback(async () => {
    const generation = ++exportsRead.current;
    try {
      const exportData = await api<{ exports: ExportView[] }>(`/api/manage/events/${eventId}/exports`);
      // The poll only lives while the job is queued or running, so an answer that arrives
      // behind a newer one can put a terminal state back and stop the poll on a job that
      // has since moved. Last read issued is the only one allowed to write.
      if (generation === exportsRead.current) setExports(exportData.exports);
    } catch (caught) {
      // Same rule the intake poll follows: a missed tick over a venue network is not worth a
      // notice, but a rotated link or an ended lifecycle will fail every following tick too,
      // and the host would otherwise watch "Preparing" forever with nothing telling them why.
      const notice = managerNoticeFor(caught, 'The export status could not be refreshed.');
      if (notice.type === 'load') setActionError(notice);
    }
  }, [eventId]);

  const refreshIntake = useCallback(async () => {
    try {
      const readToken = eventReads.current.openRead();
      const [eventData, firstPage] = await Promise.all([
        api<{ event: EventView }>(`/api/manage/events/${eventId}`),
        api<ManagerMediaPage>(mediaPath()),
      ]);
      if (eventReads.current.adopt(readToken)) setEvent(eventData.event);
      // A poll opened under the previous filter must not merge its rows back over the narrowed list.
      if (latestMediaPath.current !== mediaPath) return;
      setMediaPage((current) => {
        const refreshedIds = new Set(firstPage.media.map(({ id }) => id));
        const retained = current.rows.filter(({ id }) => !refreshedIds.has(id));
        // A poll can win the race with the initial whole-page load. With no established list or
        // continuation state, its page is the query state and its cursor is safe to adopt.
        if (current.rows.length === 0) {
          return { rows: firstPage.media, cursor: firstPage.nextCursor ?? null };
        }
        // Sharing no id at all with the rows on screen means the keyset moved by more than a page inside
        // one interval — or emptied. Either way the rows between the new first page and the retained
        // ones are in no list and behind no cursor, so trust the page we can actually see and start
        // again from its cursor rather than stitch together a list with an invisible hole in it.
        if (current.rows.length > 0 && retained.length === current.rows.length) {
          return { rows: firstPage.media, cursor: firstPage.nextCursor ?? null };
        }
        // Otherwise the poll refreshes only the newest page: its rows lead, every page the host already
        // pulled in stays behind them, and an id carried by both sides appears once. Never rewind a live
        // continuation cursor. `null` is an established exhausted state here, not permission to adopt
        // the first page's cursor again.
        return {
          rows: [...firstPage.media, ...retained],
          cursor: current.cursor,
        };
      });
    } catch (caught) {
      // Keep transient venue-network failures silent, but do not swallow a credential or lifecycle
      // change that will repeat forever without a different route back in.
      const notice = managerNoticeFor(caught, 'The live intake could not be refreshed.');
      if (notice.type === 'load') setActionError(notice);
    }
  }, [eventId, mediaPath]);

  const loadMoreMedia = useCallback(async () => {
    if (!nextMediaCursor || loadingMore) return;
    const requested = nextMediaCursor;
    const controller = new AbortController();
    loadMoreOwner.current = controller;
    setLoadingMore(true);
    try {
      const page = await api<ManagerMediaPage>(mediaPath(requested), { signal: controller.signal });
      if (loadMoreOwner.current !== controller) return;
      // The cursor was issued for the query that was current when the host asked for more.
      if (latestMediaPath.current !== mediaPath) return;
      setMediaPage((current) => {
        // A poll may have restarted the list while this page was in flight. It continues a keyset the
        // list no longer follows, so appending it would splice in rows from an abandoned ordering.
        if (current.cursor !== requested) return current;
        const known = new Set(current.rows.map(({ id }) => id));
        return {
          rows: [...current.rows, ...page.media.filter(({ id }) => !known.has(id))],
          cursor: page.nextCursor ?? null,
        };
      });
      setActionError(null);
    } catch (caught) {
      if (loadMoreOwner.current !== controller) return;
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      setActionError(managerNoticeFor(caught, 'The next page of photos could not be loaded.'));
    } finally {
      if (loadMoreOwner.current === controller) {
        loadMoreOwner.current = null;
        setLoadingMore(false);
      }
    }
  }, [loadingMore, mediaPath, nextMediaCursor]);

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

  // Every host mutation reports through here, so a rejected write leaves the current cards, filters,
  // and section exactly where they were and only adds a dismissible notice.
  async function runManagerAction(action: () => Promise<void>, rethrow = false) {
    setActionError(null);
    try {
      await action();
    } catch (caught) {
      setActionError(managerNoticeFor(caught, 'The manager action could not be completed.'));
      if (rethrow) throw caught;
    }
  }

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (section !== 'intake') return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshIntake();
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [refreshIntake, section]);
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
  useEffect(() => {
    if (section !== 'gallery') return;
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
  }, [activeExportState, refreshExports, section]);
  useEffect(() => {
    if (section !== 'guestbook') return;
    const refreshVisibleSummary = () => {
      if (document.visibilityState === 'visible') void refreshGuestbookSummary({ silent: true });
    };
    const interval = window.setInterval(refreshVisibleSummary, 15_000);
    window.addEventListener('focus', refreshVisibleSummary);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refreshVisibleSummary);
    };
  }, [refreshGuestbookSummary, section]);
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

  function transitionToSection(next: Section) {
    if (section === 'settings' && next !== 'settings') {
      // Leaving flushes the newest valid drafts. It deliberately does not wait
      // for their responses: the subtree stays mounted, so they finish anyway.
      settingsAutosave.current?.flush();
      appearanceAutosave.current?.flush();
    }
    setSection(next);
    if (next === 'settings') setSettingsMounted(true);
    setSelected([]);
    setActionError(null);
    setEntryAction(null);
    setEntryConfirm('');
    if (next === 'intake') setStatus('all');
    if (next === 'gallery' && status === 'all') setStatus('unpublished');
    // Deep in a 120-photo intake grid, the new section would otherwise open somewhere in its middle —
    // or under the sticky header. Restore the top once the new section has actually been laid out, and
    // only when there is something to restore. `instant` rather than `auto`, because the document
    // carries `scroll-behavior: smooth` and `auto` would defer to it.
    requestAnimationFrame(() => {
      if (window.scrollY > 0) window.scrollTo({ top: 0, behavior: 'instant' });
    });
  }

  async function openSection(next: Section) {
    if (next === section || sectionTransitionPending.current) return;
    if (rsvpCommitPending && next !== 'rsvp') return;
    if (rsvpDraftDirty && next !== 'rsvp') {
      setPendingSection(next);
      return;
    }
    if (section === 'gallery') {
      sectionTransitionPending.current = true;
      try {
        if (await galleryWorkspace.current?.prepareToLeave() === false) return;
      } finally {
        sectionTransitionPending.current = false;
      }
    }
    transitionToSection(next);
  }

  function openSettingsForRepair() {
    if (rsvpCommitPending) return;
    if (rsvpDraftDirty) {
      setPendingSection('settings');
      setPendingSettingsRepair(true);
      return;
    }
    settingsFocusRequested.current = true;
    setSettingsFocusEpoch((current) => current + 1);
    void openSection('settings');
  }

  useEffect(() => {
    if (!settingsFocusRequested.current || section !== 'settings') return;
    settingsFocusRequested.current = false;
    settingsHeading.current?.focus();
  }, [section, settingsFocusEpoch]);

  async function bulk(action: 'publish' | 'hide') {
    const groups = new Map<MediaView['publicationStatus'], string[]>();
    for (const item of media.filter(({ id }) => selected.includes(id))) {
      groups.set(item.publicationStatus, [...(groups.get(item.publicationStatus) ?? []), item.id]);
    }
    for (const [expectedStatus, ids] of groups) {
      await eventWrite(() => api(`/api/manage/events/${eventId}/media/bulk`, {
        method: 'POST', body: JSON.stringify({ ids, action, expectedStatus }),
      }));
    }
    setSelected([]);
    await refresh();
  }

  async function changePublication(item: MediaView, action: 'publish' | 'hide' | 'delete') {
    await eventWrite(() => api(`/api/manage/events/${eventId}/media/${item.id}`, {
      method: 'PATCH', body: JSON.stringify({ action, expectedStatus: item.publicationStatus }),
    }));
    await refresh();
  }

  async function prepareExport(kind: ExportKind = 'complete') {
    const body = kind === 'album' ? JSON.stringify({ kind: 'album' }) : '{}';
    await eventWrite(() => api(`/api/manage/events/${eventId}/exports`, { method: 'POST', body }));
    await refresh();
  }
  async function downloadExport(job: ExportView) {
    const result = await eventWrite(() => api<ExportDownloadView>(`/api/manage/events/${eventId}/exports/${job.id}/download`, { method: 'POST', body: '{}' }));
    setExportDownloads((current) => ({ ...current, [job.id]: result }));
  }
  async function retryExport(job: ExportView) {
    await eventWrite(() => api(`/api/manage/events/${eventId}/exports/${job.id}/retry`, { method: 'POST', body: '{}' }));
    await refresh();
  }
  async function rotateManagerLink() {
    if (!window.confirm('Rotate the management link? This session will stop working immediately.')) return;
    const rotated = await api<{ managementLink: string }>(`/api/manage/events/${eventId}/links/manager/rotate`, { method: 'POST', body: '{}' });
    window.location.assign(rotated.managementLink);
  }
  // Two irreversible-feeling entry actions, both confirmed by the exact event
  // name. Only one touches the printed credential; the copy has to keep them
  // apart, because a host cannot undo the second one.
  async function runEntryAction(action: EntryAction) {
    const path = action === 'rotate' ? 'guest-sessions/rotate' : 'entry/disable';
    const result = await eventWrite(() => api<{ disabledAt?: string }>(`/api/manage/events/${eventId}/${path}`, {
      method: 'POST',
      body: JSON.stringify({ confirmName: entryConfirm.trim() }),
    }));
    if (action === 'disable') {
      entryDisabled.current = true;
      setEntryDisabledAt(result.disabledAt ?? null);
      setEvent((current) => current
        ? { ...current, uploadsEnabled: false, photosOpen: false, photoIntakeState: 'paused', rsvpEnabled: false }
        : current);
    }
    setEntryAction(null);
    setEntryConfirm('');
    await refresh();
  }
  // Roster and activation changes land on the event record, not on the media the
  // whole manager refresh pays for.
  async function refreshEvent() {
    const readToken = eventReads.current.openRead();
    const loaded = await api<{ event: EventView }>(`/api/manage/events/${eventId}`);
    if (eventReads.current.adopt(readToken)) setEvent(loaded.event);
  }
  // Photo delivery is an explicit action rather than an autosaved setting, and
  // only the server decides which transition is legal from the row as it stands.
  // A page that loaded before the start therefore cannot send a pre-start action
  // after it: the refusal arrives as an ordinary manager notice telling the host
  // to reload.
  async function applyPhotoIntake(action: PhotoIntakeAction) {
    if (photoIntakePendingRef.current) return;
    photoIntakePendingRef.current = true;
    setPhotoIntakePending(true);
    try {
      const result = await eventWrite(() => api<{ event: EventView }>(`/api/manage/events/${eventId}/photo-intake`, {
        method: 'POST', body: JSON.stringify({ action }),
      }));
      setEvent((current) => current
        ? mergePhotoIntakeResponse(current, result.event, { entryDisabled: entryDisabled.current })
        : result.event);
    } finally {
      photoIntakePendingRef.current = false;
      setPhotoIntakePending(false);
    }
  }
  async function reconcilePhotoIntakeAfterScheduleSave() {
    try {
      const loaded = await eventRead(() => api<{ event: EventView }>(`/api/manage/events/${eventId}`));
      setEvent((current) => current
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
    const loaded = await eventRead(() => api<{ event: EventView }>(`/api/manage/events/${eventId}`));
    const shown = shownEvent.current;
    const moved = shown === null
      || managerLifecycleKey(shown) !== managerLifecycleKey(loaded.event);
    // A shorter relative delay is not a manager-visible transition. Leaving
    // the current event object alone preserves the hook's armed boundary and
    // the anti-spin floor established by this recheck.
    if (!moved) return 'unchanged';
    setEvent((current) => current
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
  async function deleteEvent(element: HTMLFormElement) {
    const form = new FormData(element);
    await api(`/api/manage/events/${eventId}`, { method: 'DELETE', body: JSON.stringify({ confirmation: form.get('confirmation') }) });
    window.location.assign('/');
  }

  const selectionAtLimit = selected.length >= MANAGER_BULK_SELECTION_MAX;

  function renderMediaGrid(publicationControls: boolean) {
    if (!media.length) return <div className="empty-state"><ImageIcon aria-hidden="true" /><h3>No matching photos.</h3><p>New private deliveries will appear here immediately.</p></div>;
    return <>
      <div className="moderation-grid intake-grid">{media.map((item) => {
        const isSelected = selected.includes(item.id);
        const selectionUnavailable = !isSelected && selectionAtLimit;
        return <article className={isSelected ? 'selected' : ''} key={item.id}>
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
              {publicationControls && item.publicationStatus !== 'published' && <button aria-label={`Publish ${item.originalFilename}`} onClick={() => void runManagerAction(() => changePublication(item, 'publish'))}><Eye aria-hidden="true" /></button>}
              {publicationControls && item.publicationStatus !== 'hidden' && <button aria-label={`Hide ${item.originalFilename}`} onClick={() => void runManagerAction(() => changePublication(item, 'hide'))}><EyeOff aria-hidden="true" /></button>}
              <button aria-label={`Delete ${item.originalFilename}`} onClick={() => void runManagerAction(() => changePublication(item, 'delete'))}><Trash2 aria-hidden="true" /></button>
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
    <ManagerAccessRecovery failure={failure} eventId={eventId} />
  </div></main>;
  if (!event) return <main className="centered-state"><Brand /><LoadingState label="Opening the event manager…" /></main>;

  const photoCount = event.storedMediaCount ?? 0;
  const uploadChip = UPLOAD_CHIP[event.photoIntakeState];
  // Both entry actions are confirmed the same way, and both name the event so the
  // host cannot mistake which one they are typing into.
  const entryConfirmationForm = (action: EntryAction, verb: string, warning: string) => <fieldset
    className={action === 'disable' ? 'entry-confirm entry-confirm--danger' : 'entry-confirm'}
  >
    <legend>{verb}</legend>
    <p>{warning}</p>
    <label htmlFor="entry-confirm-name">Confirm event name</label>
    <input
      id="entry-confirm-name"
      value={entryConfirm}
      autoComplete="off"
      spellCheck={false}
      onChange={(change) => setEntryConfirm(change.target.value)}
    />
    <div className="button-row">
      <button
        type="button"
        className={action === 'disable' ? 'button button--danger-outline' : 'button button--secondary'}
        disabled={entryConfirm.trim() !== event.name}
        onClick={() => void runManagerAction(() => runEntryAction(action))}
      >{verb} for {event.name}</button>
      <button type="button" className="text-button" onClick={() => { setEntryAction(null); setEntryConfirm(''); }}>Cancel</button>
    </div>
  </fieldset>;

  const visibleNotice: ManagerNotice | null = autosaveRecovery
    ? { type: 'load', failure: autosaveRecovery.failure }
    : coverAccessFailure
      ? { type: 'load', failure: coverAccessFailure }
      : albumAccessFailure
        ? { type: 'load', failure: albumAccessFailure }
    : actionError;
  return <div className="manager-shell manager-shell--intake">
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
      <header className="manager-title"><div><p>{new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(`${event.eventDate}T12:00:00`))}</p><h1>{event.name}</h1></div><span className={`status status--${uploadChip.tone}`}>{uploadChip.tone === 'approved' ? <Check aria-hidden="true" /> : <EyeOff aria-hidden="true" />} {uploadChip.label}</span></header>
      <div className="lifecycle"><p><strong>{photoCount}</strong> private deliveries</p><p><strong>{formatBytes(event.storedBytes)}</strong> of {STORAGE_CAP} used</p><p>Files delete <strong>{event.purgeAfter ? new Date(event.purgeAfter).toLocaleDateString() : 'on schedule'}</strong></p></div>

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
              else setActionError(null);
            }}
          ><X aria-hidden="true" /></button>
        </div>
        {visibleNotice.type === 'load' && (
          <ManagerAccessRecovery failure={visibleNotice.failure} eventId={eventId} />
        )}
      </section>}

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
        <div className="workspace-heading"><div><p className="section-label">Private collection</p><h2 id="intake-title">Live intake</h2></div></div>
        <form className="intake-search" onSubmit={(formEvent) => { formEvent.preventDefault(); setGuestFilter(searchInput.trim()); }}>
          <label><span className="sr-only">Filter by guest name</span><Search aria-hidden="true" /><input aria-label="Filter by guest name" value={searchInput} onChange={(change) => setSearchInput(change.target.value)} placeholder="Find a guest by name" /></label>
          <button className="button button--secondary">Filter</button>
          {guestFilter && <button type="button" className="text-button" onClick={() => { setSearchInput(''); setGuestFilter(''); }}>Clear</button>}
        </form>
        {renderMediaGrid(false)}
      </section>}

      {/* Mounted only from its own destination, so the CSV, household, and totals
          requests never join the manager's initial load. */}
      {section === 'rsvp' && <ManagerRsvpPanel
        event={event}
        onEventWrite={eventWrite}
        onEventChanged={() => void runManagerAction(refreshEvent)}
        onRosterVersionObserved={(currentRosterVersion) => setEvent((current) => current
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
        shared={{
          media,
          status,
          selected,
          selectionAtLimit,
          onStatusChange: (next) => {
            setStatus(next);
            setSelected([]);
          },
          onSelectedChange: setSelected,
          onBulk: (action) => runManagerAction(() => bulk(action), true),
          onChangePublication: (item, action) => runManagerAction(() => changePublication(item, action)),
          loadingMore,
          hasMore: Boolean(nextMediaCursor),
          onLoadMore: loadMoreMedia,
          // Same route the stuck-autosave notice takes: it honours the guest-list guards and puts
          // focus on the Settings heading, so the host does not land on `body` when the notice they
          // pressed unmounts with the Gallery.
          onOpenSettings: openSettingsForRepair,
          settingsBlocked: rsvpCommitPending,
        }}
        exports={{
          job: completeExport,
          albumJob: albumExport,
          activeJob: activeExport,
          download: completeExport ? exportDownloads[completeExport.id] : undefined,
          albumDownload: albumExport ? exportDownloads[albumExport.id] : undefined,
          onPrepare: (kind = 'complete') => runManagerAction(() => prepareExport(kind)),
          onDownload: (job) => runManagerAction(() => downloadExport(job)),
          onRetry: (job) => runManagerAction(() => retryExport(job)),
        }}
        onAlbumAutosaveStateChange={recordAutosaveState}
        onAlbumAccessFailure={setAlbumAccessFailure}
      />}

      {section === 'share' && <section className="manager-panel">
        <p className="section-label">Invite your guests</p>
        <h2>Share your event</h2>
        <div className="share-layout">
          <div>{eventLink
            ? <CopyableLinkCard label="Event link" value={eventLink} />
            : <p className="manager-notice">{entryDisabledAt
              ? 'This event QR was disabled and cannot be replaced.'
              : 'This event has no printed entry.'}</p>}
            <p className="form-note">One code for RSVPs now and event photos later. Print it once.</p>
          </div>
          {qr && <div className="manager-qr"><img src={qr} alt="Event QR code" /><a className="button button--secondary" href={qr} download="candidary-event-qr.png"><QrCode aria-hidden="true" /> Download QR</a></div>}
        </div>
        {eventLink && <section className="entry-controls" aria-labelledby="entry-controls-title">
          <h3 id="entry-controls-title">Event entry controls</h3>
          {entryAction === null && <div className="entry-controls__choices">
            <div>
              <p>Guests must scan again to get back in. The event link and every printed QR code stays the same.</p>
              <button type="button" className="button button--secondary" onClick={() => { setEntryAction('rotate'); setEntryConfirm(''); }}>Sign out guest devices</button>
            </div>
            <div className="entry-controls__danger">
              <p>This immediately signs out guests, pauses RSVP and photo intake, and makes every invitation and sign using this QR stop working. It cannot be undone.</p>
              <button type="button" className="button button--danger-outline" onClick={() => { setEntryAction('disable'); setEntryConfirm(''); }}>Disable printed event QR</button>
            </div>
          </div>}
          {entryAction === 'rotate' && entryConfirmationForm(
            'rotate',
            'Sign out guest devices',
            'Guests must scan again to get back in. The event link and every printed QR code stays the same.',
          )}
          {entryAction === 'disable' && entryConfirmationForm(
            'disable',
            'Disable printed event QR',
            'This immediately signs out guests, pauses RSVP and photo intake, and makes every invitation and sign using this QR stop working. It cannot be undone, and there is no replacement.',
          )}
        </section>}
        <section className="manager-export-route">
          <p>Prepare or retrieve the complete collection from the Gallery.</p>
          <button type="button" className="button button--secondary" onClick={() => { void openSection('gallery'); }}>Open Gallery</button>
        </section>
      </section>}

      {section === 'guestbook' && <ManagerGuestbookPanel
        eventId={eventId}
        eventTimezone={event.eventTimezone}
        summary={guestbookSummary}
        summaryFailure={guestbookSummaryFailure}
        onSummaryRefresh={refreshGuestbookSummary}
        onSummaryObserved={setGuestbookSummary}
        onOpenSettings={openSettingsForRepair}
        settingsBlocked={rsvpCommitPending}
      />}

      {settingsMounted && <section className="manager-panel" hidden={section !== 'settings'} inert={section !== 'settings'}>
        <p className="section-label">Event controls</p>
        <h2 ref={settingsHeading} tabIndex={-1}>Settings</h2>
        <EventSettingsEditor
          key={'settings-' + event.id}
          ref={settingsAutosave}
          event={event}
          onEventWrite={eventWrite}
          onEventRead={eventRead}
          onSettingsSaved={(updated, { scheduleChanged }) => {
            setEvent((current) => current
              ? mergeSettingsResponse(current, updated, { entryDisabled: entryDisabled.current })
              : updated);
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
          onThemeSaved={(updated) => setEvent((current) => current ? mergeThemeResponse(current, updated) : updated)}
          onCoverSaved={(updated) => setEvent((current) => current ? mergeCoverResponse(current, updated) : updated)}
          onCoverAccessFailure={recordCoverAccessFailure}
          onAutosaveStateChange={recordAutosaveState}
        />
        <EventAccountCard eventId={event.id} />
        <section className="manager-credential" aria-labelledby="manager-credential-title">
          <h3 id="manager-credential-title">Manager access</h3>
          <p>Rotating issues a new management link and stops this one immediately. It does not change the printed event QR.</p>
          <button type="button" className="button button--secondary" onClick={() => void runManagerAction(rotateManagerLink)}>Rotate manager link</button>
        </section>
        <div className="danger-zone">
          <h3>Delete this event</h3>
          <p>Type <strong>{event.name}</strong> to revoke access immediately and schedule every private file for permanent deletion.</p>
          <form onSubmit={(formEvent) => {
            formEvent.preventDefault();
            const element = formEvent.currentTarget;
            void runManagerAction(() => deleteEvent(element));
          }}>
            <input name="confirmation" aria-label="Confirm event name" autoComplete="off" />
            <button className="button button--danger-outline"><Trash2 aria-hidden="true" /> Delete event</button>
          </form>
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
        <button type="button" className="button button--primary" onClick={() => blocker.reset()}>Stay</button>
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
              blocker.proceed();
            } else if (pendingSection) {
              const next = pendingSection;
              setPendingSection(null);
              setPendingRsvpClose(false);
              if (next === 'settings' && pendingSettingsRepair) {
                settingsFocusRequested.current = true;
                setSettingsFocusEpoch((current) => current + 1);
              }
              setPendingSettingsRepair(false);
              transitionToSection(next);
            } else {
              setPendingRsvpClose(false);
              setPendingSettingsRepair(false);
            }
          }}>Discard draft</button>
          <button type="button" className="button button--primary" onClick={() => {
            setPendingSection(null);
            setPendingRsvpClose(false);
            setPendingSettingsRepair(false);
            if (blocker.state === 'blocked') blocker.reset();
          }}>Stay</button>
        </div>
      </section>}
      {!rsvpDraftDirty && blocker.state === 'blocked' && <UnsavedSettingsPrompt
        domains={unconfirmedDomains}
        leaveDisabled={albumPrepareResult?.navigationKey !== blockedNavigationKey
          || albumPrepareResult.ready !== true}
        onLeave={() => {
          if (albumPrepareResult?.navigationKey === blockedNavigationKey
            && albumPrepareResult.ready) blocker.proceed();
        }}
        onStay={stuckDomains.length > 0
          ? () => {
              blocker.reset();
              if (stuckDomains.some(({ domain }) => domain === 'album')) {
                void galleryWorkspace.current?.prepareToLeave();
              } else {
                openSettingsForRepair();
              }
            }
          : undefined}
      />}
    </main>

    <aside className="manager-utility">
      <section className="manager-utility__guest-entry"><p className="section-label">Event entry</p><h2>Scan to join</h2>{qr && <img className="intake-qr" src={qr} alt="Event QR code" />}<button type="button" className="button button--secondary button--wide" disabled={!eventLink} onClick={() => void copyEventLink()}><Copy aria-hidden="true" /> Copy event link</button></section>
      <section className="manager-utility__capacity"><p className="section-label">Event capacity</p><div className="stat"><strong>{photoCount}</strong><span>photos stored</span></div><div className="meter"><span style={{ width: `${Math.min(100, (photoCount / MAX_EVENT_MEDIA) * 100)}%` }} /></div><small>{photoCount.toLocaleString()} of {PHOTO_CAP} · {formatBytes(event.storedBytes)} of {STORAGE_CAP}</small></section>
    </aside>
  </div>;
}

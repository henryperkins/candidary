import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  EventView,
  RsvpHouseholdDetail,
  RsvpHouseholdFilter,
  RsvpHouseholdListItem,
  RsvpHouseholdListPage,
  RsvpHouseholdUpdateRequest,
  RsvpSubmissionInvitee,
  RsvpSummary,
} from '../../shared/contracts';
import { api, ClientApiError } from '../app/api';
import { ManagerRsvpHouseholdEditor } from '../features/rsvp/ManagerRsvpHouseholdEditor';
import { ManagerRsvpDashboard } from '../features/rsvp/ManagerRsvpDashboard';
import { GuestListIntakeLauncher } from '../features/rsvp/GuestListIntakeLauncher';
import { GuestListStagingWorkspace } from '../features/rsvp/GuestListStagingWorkspace';

interface HouseholdPage {
  households: RsvpHouseholdListItem[];
  nextCursor: string | null;
}

interface ManagerMutation {
  household: RsvpHouseholdDetail;
  rosterVersion: number;
}

interface DetailOwner {
  generation: number;
  eventId: string;
  householdId: string;
}

type EventWrite = <T>(request: () => Promise<T>) => Promise<T>;

const passthroughEventWrite: EventWrite = <T,>(request: () => Promise<T>) => request();

// Long enough that a host typing a household name issues one query rather than
// one per keystroke, short enough that the list still feels answered.
const QUERY_DEBOUNCE_MS = 250;

function failureMessage(caught: unknown, fallback: string): string {
  return caught instanceof Error && caught.message ? caught.message : fallback;
}

function householdRowId(householdId: string): string {
  return `rsvp-household-row-${householdId}`;
}

export function ManagerRsvpPanel({
  event,
  onEventChanged,
  onEventWrite = passthroughEventWrite,
  onRosterVersionObserved,
  onDraftDirtyChange,
  onDraftCloseRequested,
  onDraftCommitPendingChange,
  discardDraftEpoch = 0,
}: {
  event: EventView;
  onEventChanged: () => void;
  // ManagerPage brackets writes so an intake read that began earlier cannot
  // restore the event row after this RSVP mutation commits.
  onEventWrite?: EventWrite;
  onRosterVersionObserved?: (currentRosterVersion: number) => void;
  onDraftDirtyChange?: (dirty: boolean) => void;
  onDraftCloseRequested?: () => void;
  onDraftCommitPendingChange?: (pending: boolean) => void;
  discardDraftEpoch?: number;
}) {
  const eventId = event.id;
  const [summary, setSummary] = useState<RsvpSummary | null>(null);
  const [summaryState, setSummaryState] = useState<'loading' | 'known' | 'failed'>('loading');
  const [page, setPage] = useState<HouseholdPage>({ households: [], nextCursor: null });
  const [hasHistoricalHouseholds, setHasHistoricalHouseholds] = useState(false);
  const [historicalRosterState, setHistoricalRosterState] = useState<'loading' | 'known' | 'failed'>('loading');
  const [activeRosterState, setActiveRosterState] = useState<'loading' | 'known' | 'failed'>('loading');
  const [queryInput, setQueryInput] = useState('');
  const [query, setQuery] = useState('');
  const [state, setState] = useState<RsvpHouseholdFilter>('all');
  const [listing, setListing] = useState(true);
  const [detail, setDetail] = useState<RsvpHouseholdDetail | null>(null);
  const [selectedHouseholdId, setSelectedHouseholdId] = useState<string | null>(null);
  const [detailReadState, setDetailReadState] = useState<'idle' | 'loading' | 'failed'>('idle');
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [notice, setNotice] = useState('');
  const [focusHeading, setFocusHeading] = useState(false);
  // The roster version the next write is guarded on. It starts from the event the
  // manager loaded and then follows whatever the server actually committed.
  const [rosterVersion, setRosterVersion] = useState(event.rsvpRosterVersion);
  const [intakeOpen, setIntakeOpen] = useState(false);
  const [intakeDirty, setIntakeDirty] = useState(false);
  const handledDiscardEpoch = useRef(0);
  const detailGeneration = useRef(0);
  const activeDetailOwner = useRef<DetailOwner | null>(null);
  const mountedEvent = useRef<string | null>(eventId);
  const detailOrigin = useRef<HTMLButtonElement | null>(null);
  const pendingWrites = useRef(new Set<DetailOwner>());
  const dashboardHeading = useRef<HTMLHeadingElement>(null);
  // Pages, filters, and refreshes all write the same list. Only the newest
  // intent may land, or a slow earlier answer would replace a narrower one.
  const listTicket = useRef(0);

  function ownsDetail(owner: DetailOwner): boolean {
    return mountedEvent.current === owner.eventId
      && activeDetailOwner.current === owner
      && detailGeneration.current === owner.generation;
  }

  useEffect(() => { setRosterVersion((current) => Math.max(current, event.rsvpRosterVersion)); }, [event.rsvpRosterVersion]);
  useEffect(() => {
    mountedEvent.current = eventId;
    activeDetailOwner.current = null;
    detailOrigin.current = null;
    setSelectedHouseholdId(null);
    setDetail(null);
    setDetailReadState('idle');
    setBusy(false);
    setFocusHeading(false);
    setNotice('');
    setAnnouncement('');
    return () => {
      mountedEvent.current = null;
      activeDetailOwner.current = null;
      detailGeneration.current += 1;
    };
  }, [eventId]);
  useEffect(() => {
    if (!discardDraftEpoch || handledDiscardEpoch.current === discardDraftEpoch) return;
    handledDiscardEpoch.current = discardDraftEpoch;
    setIntakeDirty(false);
    setIntakeOpen(false);
    onDraftDirtyChange?.(false);
  }, [discardDraftEpoch, onDraftDirtyChange]);

  const basePath = `/api/manage/events/${eventId}/rsvp`;

  const listPath = useCallback((cursor?: string) => {
    const params = new URLSearchParams();
    if (state !== 'all') params.set('state', state);
    if (query) params.set('query', query);
    // The cursor is opaque and `cursor=` is a validation failure, so an absent
    // cursor stays absent.
    if (cursor) params.set('cursor', cursor);
    const search = params.toString();
    return `/api/manage/events/${eventId}/rsvp/households${search ? `?${search}` : ''}`;
  }, [eventId, query, state]);

  const loadSummary = useCallback(async () => {
    try {
      setSummary(await api<RsvpSummary>(`/api/manage/events/${eventId}/rsvp/summary`));
      setSummaryState('known');
    } catch (caught) {
      setSummaryState('failed');
      throw caught;
    }
  }, [eventId]);

  const loadList = useCallback(async () => {
    const ticket = listTicket.current + 1;
    listTicket.current = ticket;
    setListing(true);
    try {
      const data = await api<RsvpHouseholdListPage>(listPath());
      if (listTicket.current !== ticket) return;
      setPage({ households: data.households, nextCursor: data.nextCursor });
      if (state === 'all' && !query) setActiveRosterState('known');
    } catch (caught) {
      if (state === 'all' && !query) setActiveRosterState('failed');
      throw caught;
    } finally {
      if (listTicket.current === ticket) setListing(false);
    }
  }, [listPath]);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(queryInput.trim()), QUERY_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [queryInput]);

  useEffect(() => {
    void loadSummary().catch((caught: unknown) => {
      setNotice(failureMessage(caught, 'The guest list totals could not be loaded.'));
    });
  }, [loadSummary]);

  useEffect(() => {
    void loadList().catch((caught: unknown) => {
      setNotice(failureMessage(caught, 'The guest list could not be loaded.'));
    });
  }, [loadList]);

  // The normal "all" roster deliberately excludes archived households. A
  // single archived page is enough to distinguish a genuinely new roster from
  // one whose only invitations were archived.
  useEffect(() => {
    void api<RsvpHouseholdListPage>(`/api/manage/events/${eventId}/rsvp/households?state=archived`)
      .then((archived) => {
        setHasHistoricalHouseholds(archived.households.length > 0);
        setHistoricalRosterState('known');
      })
      .catch(() => setHistoricalRosterState('failed'));
  }, [eventId]);

  async function loadMore() {
    const cursor = page.nextCursor;
    if (!cursor || listing) return;
    const ticket = listTicket.current + 1;
    listTicket.current = ticket;
    setListing(true);
    try {
      const data = await api<RsvpHouseholdListPage>(listPath(cursor));
      if (listTicket.current !== ticket) return;
      setPage((current) => {
        const known = new Set(current.households.map(({ id }) => id));
        return {
          households: [
            ...current.households,
            ...data.households.filter(({ id }) => !known.has(id)),
          ],
          nextCursor: data.nextCursor,
        };
      });
    } catch (caught) {
      setNotice(failureMessage(caught, 'The next page of households could not be loaded.'));
    } finally {
      if (listTicket.current === ticket) setListing(false);
    }
  }

  // Runs only after a write has already committed, so a failure here is a stale
  // total rather than a refused change. Saying so in the same status line keeps
  // a host from undoing work that actually landed.
  async function refreshRoster(expectedEventId = eventId) {
    try {
      await Promise.all([loadSummary(), loadList()]);
    } catch {
      if (mountedEvent.current !== expectedEventId) return;
      setAnnouncement((current) => (current
        ? `${current} The totals could not be refreshed — reload to see them.`
        : 'The totals could not be refreshed — reload to see them.'));
    }
  }

  // A refused write means someone else's version won. Replace the view with the
  // winner and send the host back to the top of it before they edit again.
  async function refreshAfterConflict(owner: DetailOwner, message: string) {
    const current = await api<RsvpHouseholdDetail>(`${basePath}/households/${owner.householdId}`);
    if (!ownsDetail(owner)) return;
    setDetail(current);
    setAnnouncement(message);
    setNotice('');
    setFocusHeading(true);
    onEventChanged();
  }

  async function runHouseholdWrite(
    householdId: string,
    write: () => Promise<ManagerMutation>,
    message: (result: ManagerMutation) => string,
    onCommitted?: (result: ManagerMutation) => void,
  ): Promise<number | undefined> {
    const owner = activeDetailOwner.current;
    if (!owner || owner.householdId !== householdId || selectedHouseholdId !== householdId) return;
    if (pendingWrites.current.has(owner)) return;
    pendingWrites.current.add(owner);
    setBusy(true);
    setFocusHeading(false);
    setNotice('');
    try {
      const result = await write();
      if (mountedEvent.current !== owner.eventId) return result.rosterVersion;

      setRosterVersion((current) => Math.max(current, result.rosterVersion));
      onRosterVersionObserved?.(result.rosterVersion);
      onCommitted?.(result);
      // Roster version and RSVP activation live on the event, so the shell reloads
      // it rather than guessing what changed.
      onEventChanged();

      if (ownsDetail(owner)) {
        setDetail(result.household);
        setAnnouncement(message(result));
        setFocusHeading(false);
        setNotice('');
      }
      await refreshRoster(owner.eventId);
      return result.rosterVersion;
    } catch (caught) {
      if (caught instanceof ClientApiError && caught.code === 'RSVP_HOUSEHOLD_CONFLICT') {
        if (!ownsDetail(owner)) return;
        try {
          await refreshAfterConflict(owner, caught.message);
          return;
        } catch (refreshFailure) {
          if (ownsDetail(owner)) {
            setNotice(failureMessage(refreshFailure, 'The household changed, but could not be reloaded.'));
          }
          return;
        }
      }
      if (ownsDetail(owner)) setNotice(failureMessage(caught, 'That change could not be saved.'));
    } finally {
      pendingWrites.current.delete(owner);
      if (ownsDetail(owner)) setBusy(false);
    }
  }

  async function openHousehold(householdId: string, origin?: HTMLButtonElement) {
    const owner: DetailOwner = {
      generation: ++detailGeneration.current,
      eventId,
      householdId,
    };
    activeDetailOwner.current = owner;
    detailOrigin.current = origin ?? null;
    setSelectedHouseholdId(householdId);
    setDetail(null);
    setDetailReadState('loading');
    setFocusHeading(false);
    setNotice('');
    setBusy(true);
    try {
      const next = await api<RsvpHouseholdDetail>(`${basePath}/households/${householdId}`);
      if (!ownsDetail(owner)) return;
      setDetail(next);
      setDetailReadState('idle');
      setFocusHeading(true);
    } catch (caught) {
      if (ownsDetail(owner)) {
        setDetailReadState('failed');
        setNotice(failureMessage(caught, 'That household could not be opened.'));
      }
    } finally {
      if (ownsDetail(owner)) setBusy(false);
    }
  }

  function closeHousehold() {
    const householdId = selectedHouseholdId;
    const closingEventId = eventId;
    const origin = detailOrigin.current;
    detailGeneration.current += 1;
    const closeGeneration = detailGeneration.current;
    activeDetailOwner.current = null;
    detailOrigin.current = null;
    setSelectedHouseholdId(null);
    setDetail(null);
    setDetailReadState('idle');
    setFocusHeading(false);
    setBusy(false);
    setNotice('');

    window.requestAnimationFrame(() => {
      if (mountedEvent.current !== closingEventId
        || detailGeneration.current !== closeGeneration
        || activeDetailOwner.current !== null) return;
      const currentRow = householdId
        ? document.getElementById(householdRowId(householdId)) as HTMLButtonElement | null
        : null;
      const target = origin?.isConnected ? origin : currentRow ?? dashboardHeading.current;
      target?.focus({ preventScroll: true });
    });
  }

  async function saveRoster(
    input: Omit<RsvpHouseholdUpdateRequest, 'expectedVersion' | 'expectedRosterVersion'>,
  ) {
    const current = detail;
    if (!current) return;
    await runHouseholdWrite(current.id, () => onEventWrite(() => api<ManagerMutation>(`${basePath}/households/${current.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          ...input,
          expectedVersion: current.version,
          expectedRosterVersion: rosterVersion,
        }),
      })), (result) => `${result.household.label} saved.`);
  }

  async function saveCorrection(invitees: RsvpSubmissionInvitee[]) {
    const current = detail;
    if (!current) return;
    await runHouseholdWrite(current.id, () => onEventWrite(() => api<ManagerMutation>(`${basePath}/households/${current.id}/response`, {
        method: 'PUT',
        body: JSON.stringify({
          invitees,
          expectedVersion: current.version,
          expectedRosterVersion: rosterVersion,
        }),
      })), () => 'Response correction saved.');
  }

  async function archiveHousehold() {
    const current = detail;
    if (!current) return;
    await runHouseholdWrite(current.id, () => onEventWrite(() => api<ManagerMutation>(`${basePath}/households/${current.id}/archive`, {
        method: 'POST',
        body: JSON.stringify({
          expectedVersion: current.version,
          expectedRosterVersion: rosterVersion,
        }),
      })), (result) => `${result.household.label} archived.`, () => setHasHistoricalHouseholds(true));
  }

  const pristine = activeRosterState === 'known'
    && historicalRosterState === 'known'
    && page.households.length === 0
    && page.nextCursor === null
    && !hasHistoricalHouseholds
    && summary !== null
    && summary.namedInvitees === 0
    && !listing;
  const rosterProbesComplete = activeRosterState !== 'loading'
    && historicalRosterState !== 'loading'
    && summaryState !== 'loading';

  return <section className="rsvp-manager" aria-labelledby="rsvp-manager-title">
    <p className="section-label">Guest list</p>
    <h2 id="rsvp-manager-title" ref={dashboardHeading} tabIndex={-1}>Guest list and RSVPs</h2>

    {announcement && <p className="rsvp-manager__status" role="status">{announcement}</p>}
    {notice && <p className="rsvp-manager__notice" role="alert">{notice}</p>}
    {historicalRosterState === 'failed' && <p className="rsvp-manager__notice" role="alert">Guest-list history could not be checked. The existing guest list remains available.</p>}

    {!intakeOpen && rosterProbesComplete && <GuestListIntakeLauncher
      // A zero-capacity summary can also mean every historical household was
      // archived. The loaded all-households page is the available manager data
      // that keeps that roster out of the introductory state.
      pristine={pristine}
      onOpen={() => setIntakeOpen(true)}
    />}

    {intakeOpen && <GuestListStagingWorkspace
      eventId={eventId}
      rosterVersion={rosterVersion}
      hasHouseholds={page.households.length > 0 || (summary?.namedInvitees ?? 0) > 0}
      discardEpoch={discardDraftEpoch}
      onEventWrite={onEventWrite}
      onDirtyChange={(dirty) => { setIntakeDirty(dirty); onDraftDirtyChange?.(dirty); }}
      onClose={() => {
        if (intakeDirty) onDraftCloseRequested?.();
        else { setIntakeOpen(false); onDraftDirtyChange?.(false); }
      }}
      onCommitted={() => {
        setIntakeDirty(false);
        onDraftDirtyChange?.(false);
        // The version transfer above is authoritative; this is only a
        // best-effort refresh of the rest of the event after the local receipt.
        onEventChanged();
        void refreshRoster();
      }}
      onOpenHousehold={(householdId) => {
        setIntakeOpen(false);
        setIntakeDirty(false);
        onDraftDirtyChange?.(false);
        void openHousehold(householdId);
      }}
      onRosterVersionObserved={(currentRosterVersion) => {
        setRosterVersion((current) => Math.max(current, currentRosterVersion));
        onRosterVersionObserved?.(currentRosterVersion);
      }}
      onCommitPendingChange={onDraftCommitPendingChange}
    />}

    {!intakeOpen && rosterProbesComplete && !pristine && <ManagerRsvpDashboard
      summary={summary}
      households={page.households}
      nextCursor={page.nextCursor}
      loading={listing}
      query={queryInput}
      state={state}
      selectedId={selectedHouseholdId}
      exportHref={`${basePath}/export.csv`}
      onQueryChange={setQueryInput}
      onStateChange={(next) => {
        setState(next);
        setPage({ households: [], nextCursor: null });
      }}
      onOpenHousehold={(householdId, origin) => void openHousehold(householdId, origin)}
      onLoadMore={() => void loadMore()}
    />}

    <ManagerRsvpHouseholdEditor
      detail={detail}
      creating={false}
      allowCreate={false}
      loading={detailReadState === 'loading'}
      selectionFailed={detailReadState === 'failed'}
      busy={busy}
      autoFocusHeading={focusHeading}
      onStartCreate={() => undefined}
      onCancelCreate={() => undefined}
      onCreate={() => undefined}
      onSaveRoster={(input) => void saveRoster(input)}
      onSaveCorrection={(invitees) => void saveCorrection(invitees)}
      onArchive={() => void archiveHousehold()}
      onCloseDetail={closeHousehold}
    />

  </section>;
}

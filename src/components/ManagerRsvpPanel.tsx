import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  EventView,
  RsvpHouseholdDetail,
  RsvpHouseholdFilter,
  RsvpHouseholdListItem,
  RsvpHouseholdListPage,
  RsvpHouseholdUpdateRequest,
  RsvpImportCommitResponse,
  RsvpImportPreview,
  RsvpSubmissionInvitee,
  RsvpSummary,
} from '../../shared/contracts';
import { api, ClientApiError } from '../app/api';
import {
  ManagerRsvpHouseholdEditor,
  type ManagerRsvpCreateInput,
} from '../features/rsvp/ManagerRsvpHouseholdEditor';
import { ManagerRsvpDashboard } from '../features/rsvp/ManagerRsvpDashboard';
import { ManagerRsvpImport } from '../features/rsvp/ManagerRsvpImport';

interface HouseholdPage {
  households: RsvpHouseholdListItem[];
  nextCursor: string | null;
}

interface ManagerMutation {
  household: RsvpHouseholdDetail;
  rosterVersion: number;
}

type EventWrite = <T>(request: () => Promise<T>) => Promise<T>;

const passthroughEventWrite: EventWrite = <T,>(request: () => Promise<T>) => request();

// Long enough that a host typing a household name issues one query rather than
// one per keystroke, short enough that the list still feels answered.
const QUERY_DEBOUNCE_MS = 250;

function failureMessage(caught: unknown, fallback: string): string {
  return caught instanceof Error && caught.message ? caught.message : fallback;
}

export function ManagerRsvpPanel({
  event,
  onEventChanged,
  onEventWrite = passthroughEventWrite,
}: {
  event: EventView;
  onEventChanged: () => void;
  // ManagerPage brackets writes so an intake read that began earlier cannot
  // restore the event row after this RSVP mutation commits.
  onEventWrite?: EventWrite;
}) {
  const eventId = event.id;
  const [summary, setSummary] = useState<RsvpSummary | null>(null);
  const [page, setPage] = useState<HouseholdPage>({ households: [], nextCursor: null });
  const [queryInput, setQueryInput] = useState('');
  const [query, setQuery] = useState('');
  const [state, setState] = useState<RsvpHouseholdFilter>('all');
  const [listing, setListing] = useState(true);
  const [detail, setDetail] = useState<RsvpHouseholdDetail | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [notice, setNotice] = useState('');
  const [conflictRefreshed, setConflictRefreshed] = useState(false);
  // The roster version the next write is guarded on. It starts from the event the
  // manager loaded and then follows whatever the server actually committed.
  const [rosterVersion, setRosterVersion] = useState(event.rsvpRosterVersion);
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<RsvpImportPreview | null>(null);
  const [importError, setImportError] = useState('');
  const [importStale, setImportStale] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  // Pages, filters, and refreshes all write the same list. Only the newest
  // intent may land, or a slow earlier answer would replace a narrower one.
  const listTicket = useRef(0);

  useEffect(() => { setRosterVersion(event.rsvpRosterVersion); }, [event.rsvpRosterVersion]);

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
    setSummary(await api<RsvpSummary>(`/api/manage/events/${eventId}/rsvp/summary`));
  }, [eventId]);

  const loadList = useCallback(async () => {
    const ticket = listTicket.current + 1;
    listTicket.current = ticket;
    setListing(true);
    try {
      const data = await api<RsvpHouseholdListPage>(listPath());
      if (listTicket.current !== ticket) return;
      setPage({ households: data.households, nextCursor: data.nextCursor });
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
  async function refreshRoster() {
    try {
      await Promise.all([loadSummary(), loadList()]);
    } catch {
      setAnnouncement((current) => (current
        ? `${current} The totals could not be refreshed — reload to see them.`
        : 'The totals could not be refreshed — reload to see them.'));
    }
  }

  function applyMutation(result: ManagerMutation, message: string) {
    setDetail(result.household);
    setRosterVersion(result.rosterVersion);
    setAnnouncement(message);
    setConflictRefreshed(false);
    setNotice('');
    // Roster version and RSVP activation live on the event, so the shell reloads
    // it rather than guessing what changed.
    onEventChanged();
  }

  // A refused write means someone else's version won. Replace the view with the
  // winner and send the host back to the top of it before they edit again.
  async function refreshAfterConflict(householdId: string, message: string) {
    const current = await api<RsvpHouseholdDetail>(`${basePath}/households/${householdId}`);
    setDetail(current);
    setAnnouncement(message);
    setConflictRefreshed(true);
    onEventChanged();
  }

  async function runHouseholdWrite(
    householdId: string,
    write: () => Promise<void>,
  ) {
    setBusy(true);
    setNotice('');
    try {
      await write();
    } catch (caught) {
      if (caught instanceof ClientApiError && caught.code === 'RSVP_HOUSEHOLD_CONFLICT') {
        try {
          await refreshAfterConflict(householdId, caught.message);
          return;
        } catch (refreshFailure) {
          setNotice(failureMessage(refreshFailure, 'The household changed, but could not be reloaded.'));
          return;
        }
      }
      setNotice(failureMessage(caught, 'That change could not be saved.'));
    } finally {
      setBusy(false);
    }
  }

  async function openHousehold(householdId: string) {
    setCreating(false);
    setConflictRefreshed(false);
    setNotice('');
    setBusy(true);
    try {
      setDetail(await api<RsvpHouseholdDetail>(`${basePath}/households/${householdId}`));
    } catch (caught) {
      setNotice(failureMessage(caught, 'That household could not be opened.'));
    } finally {
      setBusy(false);
    }
  }

  async function createHousehold(input: ManagerRsvpCreateInput) {
    setBusy(true);
    setNotice('');
    try {
      const result = await onEventWrite(() => api<ManagerMutation>(`${basePath}/households`, {
        method: 'POST',
        body: JSON.stringify({ ...input, expectedRosterVersion: rosterVersion }),
      }));
      setCreating(false);
      setRosterVersion(result.rosterVersion);
      setAnnouncement(`${result.household.label} created.`);
      onEventChanged();
      await refreshRoster();
    } catch (caught) {
      setNotice(failureMessage(caught, 'That household could not be created.'));
      // Creation is the one mutation guarded on the roster version alone, so a
      // refusal has to reload the event that carries it. Without this the typed
      // household is retried against the same stale version forever.
      if (caught instanceof ClientApiError && caught.code === 'RSVP_HOUSEHOLD_CONFLICT') {
        onEventChanged();
      }
    } finally {
      setBusy(false);
    }
  }

  async function saveRoster(
    input: Omit<RsvpHouseholdUpdateRequest, 'expectedVersion' | 'expectedRosterVersion'>,
  ) {
    const current = detail;
    if (!current) return;
    await runHouseholdWrite(current.id, async () => {
      const result = await onEventWrite(() => api<ManagerMutation>(`${basePath}/households/${current.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          ...input,
          expectedVersion: current.version,
          expectedRosterVersion: rosterVersion,
        }),
      }));
      applyMutation(result, `${result.household.label} saved.`);
      await refreshRoster();
    });
  }

  async function saveCorrection(invitees: RsvpSubmissionInvitee[]) {
    const current = detail;
    if (!current) return;
    await runHouseholdWrite(current.id, async () => {
      const result = await onEventWrite(() => api<ManagerMutation>(`${basePath}/households/${current.id}/response`, {
        method: 'PUT',
        body: JSON.stringify({
          invitees,
          expectedVersion: current.version,
          expectedRosterVersion: rosterVersion,
        }),
      }));
      applyMutation(result, 'Response correction saved.');
      await refreshRoster();
    });
  }

  async function archiveHousehold() {
    const current = detail;
    if (!current) return;
    await runHouseholdWrite(current.id, async () => {
      const result = await onEventWrite(() => api<ManagerMutation>(`${basePath}/households/${current.id}/archive`, {
        method: 'POST',
        body: JSON.stringify({
          expectedVersion: current.version,
          expectedRosterVersion: rosterVersion,
        }),
      }));
      applyMutation(result, `${result.household.label} archived.`);
      await refreshRoster();
    });
  }

  async function previewCsv(source: string) {
    setImportBusy(true);
    setImportError('');
    setImportStale(false);
    try {
      setPreview(await api<RsvpImportPreview>(`${basePath}/import/preview`, {
        method: 'POST',
        body: JSON.stringify({ csv: source }),
      }));
    } catch (caught) {
      setPreview(null);
      setImportError(failureMessage(caught, 'That guest list file could not be checked.'));
    } finally {
      setImportBusy(false);
    }
  }

  async function commitCsv() {
    if (!preview || preview.issues.length > 0) return;
    setImportBusy(true);
    setImportError('');
    try {
      const result = await onEventWrite(() => api<RsvpImportCommitResponse>(`${basePath}/import/commit`, {
        method: 'POST',
        body: JSON.stringify({
          csv,
          sourceDigest: preview.sourceDigest,
          expectedRosterVersion: preview.rosterVersion,
        }),
      }));
      setRosterVersion(result.rosterVersion);
      setPreview(null);
      setAnnouncement('Guest list committed.');
      onEventChanged();
      await refreshRoster();
    } catch (caught) {
      // The chosen file is still the right file. Only the server's verdict about
      // it expired, so the preview is discarded and the file is kept.
      setPreview(null);
      setImportStale(true);
      setImportError(failureMessage(caught, 'That guest list could not be imported.'));
    } finally {
      setImportBusy(false);
    }
  }

  function chooseFile(file: File) {
    setFileName(file.name);
    void file.text().then((text) => {
      setCsv(text);
      return previewCsv(text);
    }).catch(() => {
      setImportError('That file could not be read.');
    });
  }

  return <section className="rsvp-manager" aria-labelledby="rsvp-manager-title">
    <p className="section-label">Guest list</p>
    <h2 id="rsvp-manager-title">Guest list and RSVPs</h2>

    {announcement && <p className="rsvp-manager__status" role="status">{announcement}</p>}
    {notice && <p className="rsvp-manager__notice" role="alert">{notice}</p>}

    <ManagerRsvpDashboard
      summary={summary}
      households={page.households}
      nextCursor={page.nextCursor}
      loading={listing}
      query={queryInput}
      state={state}
      selectedId={detail?.id ?? null}
      exportHref={`${basePath}/export.csv`}
      onQueryChange={setQueryInput}
      onStateChange={(next) => {
        setState(next);
        setPage({ households: [], nextCursor: null });
      }}
      onOpenHousehold={(householdId) => void openHousehold(householdId)}
      onLoadMore={() => void loadMore()}
    />

    <ManagerRsvpHouseholdEditor
      detail={detail}
      creating={creating}
      busy={busy}
      autoFocusHeading={conflictRefreshed}
      onStartCreate={() => {
        setCreating(true);
        setDetail(null);
        setConflictRefreshed(false);
      }}
      onCancelCreate={() => setCreating(false)}
      onCreate={(input) => void createHousehold(input)}
      onSaveRoster={(input) => void saveRoster(input)}
      onSaveCorrection={(invitees) => void saveCorrection(invitees)}
      onArchive={() => void archiveHousehold()}
      onCloseDetail={() => {
        setDetail(null);
        setConflictRefreshed(false);
      }}
    />

    <ManagerRsvpImport
      fileName={fileName}
      preview={preview}
      busy={importBusy}
      error={importError}
      stale={importStale}
      disabled={busy}
      onFileChosen={chooseFile}
      onPreviewAgain={() => void previewCsv(csv)}
      onCommit={() => void commitCsv()}
    />
  </section>;
}

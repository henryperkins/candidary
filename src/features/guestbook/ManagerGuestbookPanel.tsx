import { Camera, MessageCircle } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { ManagerGuestbookItem } from '../../../shared/contracts';
import { api, ClientApiError, mediaPreview } from '../../app/api';
import {
  guestbookActions,
  guestbookItemBelongsToView,
  guestbookItemKey,
  guestbookItemMatchesSource,
  guestbookSourceLabel,
  guestbookStateLabel,
  guestbookVisibilityLabel,
  initialGuestbookView,
  type GuestbookManagerSource,
  type GuestbookManagerView,
  type GuestbookRowAction,
  type GuestbookSummary,
  type ManagerGuestbookPage,
} from './manager-guestbook-state';

const VIEWS: ReadonlyArray<{ value: GuestbookManagerView; label: string; count: keyof GuestbookSummary }> = [
  { value: 'needs-review', label: 'Needs review', count: 'needsReviewCount' },
  { value: 'shared', label: 'Shared', count: 'sharedCount' },
  { value: 'hidden', label: 'Hidden', count: 'hiddenCount' },
  { value: 'deleted', label: 'Deleted', count: 'deletedCount' },
];

const SOURCES: ReadonlyArray<{ value: GuestbookManagerSource; label: string }> = [
  { value: 'all', label: 'All entries' },
  { value: 'guest_note', label: 'Notes' },
  { value: 'photo_caption', label: 'Photo captions' },
];

function formatContributedAt(createdAt: string, eventTimezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: eventTimezone,
      timeZoneName: 'short',
    }).format(new Date(createdAt));
  } catch {
    return 'Time unavailable';
  }
}

function actionFailureMessage(error: unknown): string {
  if (error instanceof ClientApiError) return error.message;
  return 'This entry could not be updated. Try again.';
}

interface ManagerGuestbookPanelProps {
  eventId: string;
  eventTimezone: string;
  summary: GuestbookSummary | null;
  summaryFailure?: string | null;
  onSummaryRefresh: (options?: { silent?: boolean }) => Promise<unknown>;
  onSummaryObserved?: (summary: GuestbookSummary) => void;
  onOpenSettings: () => void;
  /** True while a guest-list commit holds every destination, matching the Manager's own guard. */
  settingsBlocked: boolean;
}

interface RowFailure {
  message: string;
  retry: () => void;
}

interface FocusRestoreRequest {
  currentKey: string;
  nextKey: string | null;
  scrollY: number;
}

export function ManagerGuestbookPanel({
  eventId,
  eventTimezone,
  summary,
  summaryFailure = null,
  onSummaryRefresh,
  onSummaryObserved,
  onOpenSettings,
  settingsBlocked,
}: ManagerGuestbookPanelProps) {
  const [view, setView] = useState<GuestbookManagerView>(() => initialGuestbookView(summary));
  const [source, setSource] = useState<GuestbookManagerSource>('all');
  const [rows, setRows] = useState<ManagerGuestbookItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [loadFailure, setLoadFailure] = useState<string | null>(null);
  const [busyRows, setBusyRows] = useState<Record<string, GuestbookRowAction>>({});
  const [rowFailures, setRowFailures] = useState<Record<string, RowFailure>>({});
  const [undoItem, setUndoItem] = useState<ManagerGuestbookItem | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [focusRestore, setFocusRestore] = useState<FocusRestoreRequest | null>(null);
  const requestGeneration = useRef(0);
  const rowElements = useRef(new Map<string, HTMLLIElement>());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestGeneration.current += 1;
    };
  }, []);

  useLayoutEffect(() => {
    if (!focusRestore) return;
    const target = rowElements.current.get(focusRestore.currentKey)
      ?? (focusRestore.nextKey ? rowElements.current.get(focusRestore.nextKey) : null);
    const control = target?.querySelector<HTMLButtonElement>('button:not(:disabled)')
      ?? document.querySelector<HTMLButtonElement>('.manager-guestbook__refresh');
    control?.focus({ preventScroll: true });
    window.scrollTo(0, focusRestore.scrollY);
    setFocusRestore(null);
  }, [focusRestore]);

  const listPath = useCallback((cursor?: string) => {
    const params = new URLSearchParams({ view, source, limit: '25' });
    if (cursor) params.set('cursor', cursor);
    return `/api/manage/events/${encodeURIComponent(eventId)}/guestbook?${params.toString()}`;
  }, [eventId, source, view]);

  const loadEntries = useCallback(async (mode: 'replace' | 'append') => {
    const requestedCursor = mode === 'append' ? nextCursor : null;
    if (mode === 'append' && !requestedCursor) return false;
    const generation = ++requestGeneration.current;
    if (mode === 'append') setLoadingEarlier(true);
    else setLoading(true);
    setLoadFailure(null);
    try {
      const page = await api<ManagerGuestbookPage>(listPath(requestedCursor ?? undefined));
      if (!mounted.current || generation !== requestGeneration.current) return false;
      if (mode === 'replace') setRowFailures({});
      setRows((current) => mode === 'append' ? [...current, ...page.items] : page.items);
      setNextCursor(page.nextCursor);
      onSummaryObserved?.(page.summary);
      return true;
    } catch (error) {
      if (!mounted.current || generation !== requestGeneration.current) return false;
      setLoadFailure(error instanceof ClientApiError ? error.message : 'Guestbook entries could not be loaded.');
      return false;
    } finally {
      if (mounted.current && generation === requestGeneration.current) {
        setLoading(false);
        setLoadingEarlier(false);
      }
    }
  }, [listPath, nextCursor, onSummaryObserved]);

  useEffect(() => {
    setRows([]);
    setNextCursor(null);
    setLoadFailure(null);
    void loadEntries('replace');
  }, [eventId, source, view]); // loadEntries intentionally changes with nextCursor.

  const chooseView = (next: GuestbookManagerView) => {
    if (next === view) return;
    requestGeneration.current += 1;
    setRows([]);
    setNextCursor(null);
    setView(next);
  };

  const chooseSource = (next: GuestbookManagerSource) => {
    if (next === source) return;
    requestGeneration.current += 1;
    setRows([]);
    setNextCursor(null);
    setSource(next);
  };

  const restoreFocus = (currentKey: string, nextKey: string | null, scrollY: number) => {
    setFocusRestore({ currentKey, nextKey, scrollY });
  };

  const runAction = async (item: ManagerGuestbookItem, action: GuestbookRowAction) => {
    const key = guestbookItemKey(item);
    if (busyRows[key]) return;
    if (action === 'purge' && !window.confirm(
      'Permanently delete this note? This cannot be undone and releases one retained-note capacity slot.',
    )) return;
    const rowIndex = rows.findIndex((candidate) => guestbookItemKey(candidate) === key);
    const nextKey = rowIndex >= 0 && rowIndex + 1 < rows.length ? guestbookItemKey(rows[rowIndex + 1]!) : null;
    setBusyRows((current) => ({ ...current, [key]: action }));
    setRowFailures((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    try {
      let confirmed: ManagerGuestbookItem | null = null;
      let purged = false;
      if (item.source === 'guest_note') {
        if (action === 'publish' || action === 'hide') throw new Error('Invalid note action.');
        const response = await api<{ item?: ManagerGuestbookItem; purged?: { source: 'guest_note'; id: string } }>(
          `/api/manage/events/${encodeURIComponent(eventId)}/messages/${encodeURIComponent(item.id)}`,
          { method: 'PATCH', body: JSON.stringify({ action, expectedState: item.state }) },
        );
        confirmed = response.item ?? null;
        purged = Boolean(response.purged);
      } else {
        if (action !== 'publish' && action !== 'hide') throw new Error('Invalid caption action.');
        const response = await api<{ item: ManagerGuestbookItem | null }>(
          `/api/manage/events/${encodeURIComponent(eventId)}/media/${encodeURIComponent(item.mediaId)}`,
          { method: 'PATCH', body: JSON.stringify({ action, expectedStatus: item.state }) },
        );
        confirmed = response.item;
      }
      if (!mounted.current) return;
      const confirmedScrollY = window.scrollY;
      setRows((current) => {
        const without = current.filter((candidate) => guestbookItemKey(candidate) !== key);
        if (
          !purged
          && confirmed
          && guestbookItemBelongsToView(confirmed, view, summary?.galleryVisible ?? true)
          && guestbookItemMatchesSource(confirmed, source)
        ) {
          const insertion = rowIndex < 0 ? without.length : Math.min(rowIndex, without.length);
          return [...without.slice(0, insertion), confirmed, ...without.slice(insertion)];
        }
        return without;
      });
      if (action === 'delete' && confirmed?.source === 'guest_note' && confirmed.state === 'deleted') {
        setUndoItem(confirmed);
        setAnnouncement('Note deleted. Undo is available.');
      } else {
        if (undoItem && undoItem.id === item.id) setUndoItem(null);
        setAnnouncement(purged ? 'Note permanently deleted.' : 'Guestbook entry updated.');
      }
      void onSummaryRefresh({ silent: true });
      restoreFocus(confirmed ? guestbookItemKey(confirmed) : key, nextKey, confirmedScrollY);
    } catch (error) {
      if (!mounted.current) return;
      const conflict = error instanceof ClientApiError
        && (error.code === 'MESSAGE_STATE_CONFLICT' || error.code === 'MEDIA_STATE_CONFLICT');
      const retry = conflict
        ? () => { void loadEntries('replace'); }
        : () => { void runAction(item, action); };
      const failureScrollY = window.scrollY;
      setRowFailures((current) => ({ ...current, [key]: {
        message: conflict ? 'This entry changed. Reload it before choosing another action.' : actionFailureMessage(error),
        retry,
      } }));
      setAnnouncement(conflict ? 'This entry changed. Reload is available.' : 'Guestbook entry update failed.');
      restoreFocus(key, null, failureScrollY);
    } finally {
      if (mounted.current) {
        setBusyRows((current) => {
          const next = { ...current };
          delete next[key];
          return next;
        });
      }
    }
  };

  const refreshEntries = async () => {
    await loadEntries('replace');
  };

  const galleryVisible = summary?.galleryVisible ?? true;
  return <section className="manager-panel manager-guestbook" aria-labelledby="manager-guestbook-title">
    <div className="manager-guestbook__heading">
      <div>
        <h2 id="manager-guestbook-title">Guestbook from the day</h2>
        <p>Review notes and photo captions without changing the private originals.</p>
      </div>
      <button type="button" className="button button--secondary manager-guestbook__refresh" disabled={loading} onClick={() => void refreshEntries()}>
        {loading && rows.length > 0 ? 'Refreshing entries…' : 'Refresh entries'}
      </button>
    </div>

    {summaryFailure && <div className="manager-guestbook__notice" role="alert">
      <span>{summaryFailure}</span>
      <button type="button" className="text-button" onClick={() => void onSummaryRefresh()}>Retry summary</button>
    </div>}

    <div className="manager-guestbook__views" role="group" aria-label="Guestbook view">
      {VIEWS.map((option) => <button
        type="button"
        key={option.value}
        aria-pressed={view === option.value}
        className={view === option.value ? 'active' : ''}
        onClick={() => chooseView(option.value)}
      >{option.label}{summary && typeof summary[option.count] === 'number' ? ` ${summary[option.count]}` : ''}</button>)}
    </div>

    <div className="manager-guestbook__sources" role="group" aria-label="Entry source">
      {SOURCES.map((option) => <button
        type="button"
        key={option.value}
        aria-pressed={source === option.value}
        className={source === option.value ? 'active' : ''}
        onClick={() => chooseSource(option.value)}
      >{option.label}</button>)}
    </div>

    {view === 'shared' && !galleryVisible && <div className="manager-guestbook__notice">
      <span>Photo captions are not visible to guests while the gallery is off.</span>
      <button
        type="button"
        className="text-button"
        disabled={settingsBlocked}
        onClick={onOpenSettings}
      >Open settings</button>
    </div>}

    {loadFailure && <div className="manager-guestbook__error" role="alert">
      <span>{loadFailure}</span>
      <button type="button" className="text-button" onClick={() => void refreshEntries()}>Retry</button>
    </div>}

    {loading && rows.length === 0 ? <p role="status">Loading Guestbook entries…</p> : rows.length > 0 ? (
      <ul className="manager-guestbook__list">
        {rows.map((item) => {
          const key = guestbookItemKey(item);
          const busyAction = busyRows[key];
          const rowBusy = Boolean(busyAction);
          const actions = guestbookActions(item);
          const failure = rowFailures[key];
          const busy = rowBusy ? actions.find(({ action }) => action === busyAction) : null;
          return <li
            key={key}
            ref={(node) => { if (node) rowElements.current.set(key, node); else rowElements.current.delete(key); }}
            aria-label={`${item.guestName || 'Unsigned'} ${guestbookSourceLabel(item)}`}
            aria-busy={rowBusy || undefined}
          >
            {item.source === 'photo_caption' && <img
              className="manager-guestbook__preview"
              src={mediaPreview(item.mediaId)}
              alt=""
              loading="lazy"
              decoding="async"
            />}
            <div className="manager-guestbook__entry">
              <div className="manager-guestbook__meta">
                <span>{item.source === 'guest_note' ? <MessageCircle aria-hidden="true" /> : <Camera aria-hidden="true" />}{guestbookSourceLabel(item)}</span>
                <time dateTime={item.createdAt}>{formatContributedAt(item.createdAt, eventTimezone)}</time>
              </div>
              <h3 dir="auto"><bdi>{item.guestName || 'Unsigned'}</bdi></h3>
              <p dir="auto">{item.body}</p>
              <div className="manager-guestbook__states">
                <span>{guestbookStateLabel(item, galleryVisible)}</span>
                <span>{guestbookVisibilityLabel(item)}</span>
              </div>
              <div className="button-row">
                {actions.map((entry) => <button
                  type="button"
                  key={entry.action}
                  className={entry.tone === 'primary'
                    ? 'button button--approve'
                    : entry.tone === 'danger'
                      ? 'button button--danger-outline'
                      : 'button button--secondary'}
                  disabled={rowBusy}
                  onClick={() => void runAction(item, entry.action)}
                >{rowBusy && busy?.action === entry.action ? entry.busyLabel : entry.label}</button>)}
              </div>
              {failure && <div className="manager-guestbook__row-error" role="alert">
                <span>{failure.message}</span>
                <button type="button" className="text-button" onClick={failure.retry}>Retry</button>
              </div>}
            </div>
          </li>;
        })}
      </ul>
    ) : !loadFailure && <div className="empty-state">
      <MessageCircle aria-hidden="true" />
      <h3>No entries in this view.</h3>
      <p>New Guestbook entries will appear here when they match this view.</p>
    </div>}

    {nextCursor && <div className="manager-guestbook__earlier">
      <button type="button" className="button button--secondary" disabled={loadingEarlier} onClick={() => void loadEntries('append')}>
        {loadingEarlier ? 'Loading earlier entries…' : 'Show earlier'}
      </button>
    </div>}

    {undoItem && <div className="manager-guestbook__undo" role="status" aria-live="polite" aria-atomic="true">
      <span>Note deleted.</span>
      <button type="button" className="button button--secondary" disabled={Boolean(busyRows[guestbookItemKey(undoItem)])} onClick={() => void runAction(undoItem, 'restore')}>Undo</button>
    </div>}
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
  </section>;
}

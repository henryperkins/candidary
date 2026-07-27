import { Check, Copy, Download, Eye, EyeOff, Image as ImageIcon, Inbox, Link as LinkIcon, MessageCircle, QrCode, Search, Settings, Trash2, X } from 'lucide-react';
import QRCode from 'qrcode';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';

import { api, mediaOriginal, mediaPreview } from '../app/api';
import {
  MANAGER_BULK_SELECTION_MAX,
  MAX_EVENT_BYTES,
  MAX_EVENT_MEDIA,
} from '../../shared/constants';
import type { EventView, ExportDownloadView, ExportView, ManagerMediaPage, MediaView, MessageView } from '../app/types';
import { Brand } from '../components/Brand';
import { CopyableLinkCard } from '../components/CopyableLinkCard';
import { ManagerExportPanel } from '../components/ManagerExportPanel';
import { describeLoadFailure, ErrorState, LoadingState } from '../components/States';
import type { LoadFailure } from '../components/States';

type Section = 'intake' | 'gallery' | 'messages' | 'share' | 'settings';
type MediaStatus = 'all' | MediaView['publicationStatus'];

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

// A dismissible notice, and the way out of it when there is one to state. A refused write is retryable
// by definition — the control that failed is still under the host's thumb — but a load failure can be
// a dead session or an ended event, where `describeLoadFailure` holds the only instruction that
// recovers it. Dropping that hint here would leave the host reading "This session has expired." with
// no mention of the management link, which is the whole point of computing it.
interface ManagerNotice {
  message: string;
  recoveryHint?: string;
}

function formatBytes(bytes = 0) {
  if (bytes < 1024 ** 2) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

const PHOTO_CAP = MAX_EVENT_MEDIA.toLocaleString();
const STORAGE_CAP = `${Math.round(MAX_EVENT_BYTES / 1024 ** 3)} GB`;

export function ManagerPage() {
  const { eventId = '' } = useParams();
  const [event, setEvent] = useState<EventView | null>(null);
  const [mediaPage, setMediaPage] = useState<MediaPageState>({ rows: [], cursor: null });
  const { rows: media, cursor: nextMediaCursor } = mediaPage;
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [exports, setExports] = useState<ExportView[]>([]);
  const [exportDownloads, setExportDownloads] = useState<Record<string, ExportDownloadView>>({});
  const [guestLink, setGuestLink] = useState('');
  const [qr, setQr] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [section, setSection] = useState<Section>('intake');
  const [status, setStatus] = useState<MediaStatus>('all');
  const [searchInput, setSearchInput] = useState('');
  const [guestFilter, setGuestFilter] = useState('');
  const [failure, setFailure] = useState<LoadFailure | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [actionError, setActionError] = useState<ManagerNotice | null>(null);
  // Once the manager has rendered, a later load failure must not throw the host back to a bare error
  // page: it becomes the same inline, recoverable notice a failed mutation uses — carrying the
  // recovery hint with it, because the inline notice offers no `Try again` of its own either.
  const loadedOnce = useRef(false);
  const loadMoreOwner = useRef<AbortController | null>(null);

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

  // Reused verbatim behind Try again, so the prior failure clears the moment the attempt starts and
  // the host watches this load rather than the dead end the last one left.
  const refresh = useCallback(async () => {
    setFailure(null);
    try {
      const [eventData, mediaData, messageData, exportData, linkData] = await Promise.all([
        api<{ event: EventView }>(`/api/manage/events/${eventId}`),
        api<ManagerMediaPage>(mediaPath()),
        api<{ messages: MessageView[] }>(`/api/manage/events/${eventId}/messages`),
        api<{ exports: ExportView[] }>(`/api/manage/events/${eventId}/exports`),
        api<{ guestLink: string }>(`/api/manage/events/${eventId}/links`),
      ]);
      setEvent(eventData.event);
      // A load opened under the previous query must not reinstate its rows or its cursor. Polling
      // merges rather than replaces, so a stale list here would sit behind every later poll forever.
      // Only the media half is query-scoped; notes, exports, and links are the same either way.
      if (latestMediaPath.current === mediaPath) {
        setMediaPage({ rows: mediaData.media, cursor: mediaData.nextCursor ?? null });
      }
      setMessages(messageData.messages);
      setExports(exportData.exports);
      setGuestLink(linkData.guestLink);
      loadedOnce.current = true;
    } catch (caught) {
      const loadFailure = describeLoadFailure(caught, 'manager', 'The event manager could not be loaded.');
      if (loadedOnce.current) setActionError(loadFailure); else setFailure(loadFailure);
    }
  }, [eventId, mediaPath]);

  const refreshIntake = useCallback(async () => {
    try {
      const [eventData, firstPage] = await Promise.all([
        api<{ event: EventView }>(`/api/manage/events/${eventId}`),
        api<ManagerMediaPage>(mediaPath()),
      ]);
      setEvent(eventData.event);
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
    } catch {
      // Keep the last usable intake visible; the next poll or a host action retries.
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
      setActionError({ message: caught instanceof Error ? caught.message : 'The next page of photos could not be loaded.' });
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
  async function copyGuestLink() {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(guestLink);
      setActionError(null);
    } catch {
      setActionError({ message: 'The guest link could not be copied.', recoveryHint: guestLink });
    }
  }

  // Every host mutation reports through here, so a rejected write leaves the current cards, filters,
  // and section exactly where they were and only adds a dismissible notice.
  async function runManagerAction(action: () => Promise<void>) {
    setActionError(null);
    try {
      await action();
    } catch (caught) {
      setActionError({ message: caught instanceof Error ? caught.message : 'The manager action could not be completed.' });
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
  useEffect(() => {
    if (guestLink) void QRCode.toDataURL(guestLink, { width: 220, margin: 2, color: { dark: '#42103b', light: '#fffaf3' } }).then(setQr);
  }, [guestLink]);

  function openSection(next: Section) {
    setSection(next);
    setSelected([]);
    setActionError(null);
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

  async function bulk(action: 'publish' | 'hide') {
    const groups = new Map<MediaView['publicationStatus'], string[]>();
    for (const item of media.filter(({ id }) => selected.includes(id))) {
      groups.set(item.publicationStatus, [...(groups.get(item.publicationStatus) ?? []), item.id]);
    }
    for (const [expectedStatus, ids] of groups) {
      await api(`/api/manage/events/${eventId}/media/bulk`, {
        method: 'POST', body: JSON.stringify({ ids, action, expectedStatus }),
      });
    }
    setSelected([]);
    await refresh();
  }

  async function changePublication(item: MediaView, action: 'publish' | 'hide' | 'delete') {
    await api(`/api/manage/events/${eventId}/media/${item.id}`, {
      method: 'PATCH', body: JSON.stringify({ action, expectedStatus: item.publicationStatus }),
    });
    await refresh();
  }

  async function saveSettings(element: HTMLFormElement) {
    const form = new FormData(element);
    await api(`/api/manage/events/${eventId}/settings`, { method: 'PATCH', body: JSON.stringify({
      name: form.get('name'),
      welcomeMessage: form.get('welcomeMessage'),
      uploadsEnabled: form.get('uploadsEnabled') === 'on',
      galleryVisible: form.get('galleryVisible') === 'on',
      moderationRequired: form.get('moderationRequired') === 'on',
    }) });
    await refresh();
  }

  async function prepareExport() {
    await api(`/api/manage/events/${eventId}/exports`, { method: 'POST', body: '{}' });
    await refresh();
  }
  async function downloadExport(job: ExportView) {
    const result = await api<ExportDownloadView>(`/api/manage/events/${eventId}/exports/${job.id}/download`, { method: 'POST', body: '{}' });
    setExportDownloads((current) => ({ ...current, [job.id]: result }));
  }
  async function retryExport(job: ExportView) {
    await api(`/api/manage/events/${eventId}/exports/${job.id}/retry`, { method: 'POST', body: '{}' });
    await refresh();
  }
  async function moderateMessage(message: MessageView, action: 'approve' | 'reject' | 'delete') {
    await api(`/api/manage/events/${eventId}/messages/${message.id}`, { method: 'PATCH', body: JSON.stringify({ action, expectedStatus: message.moderationStatus }) });
    await refresh();
  }
  async function rotateGuestLink() {
    if (!window.confirm('Rotate the guest link? Every old guest link and session will stop working immediately.')) return;
    const rotated = await api<{ guestLink: string }>(`/api/manage/events/${eventId}/links/guest/rotate`, { method: 'POST', body: '{}' });
    setGuestLink(rotated.guestLink);
  }
  async function rotateManagerLink() {
    if (!window.confirm('Rotate the management link? This session will stop working immediately.')) return;
    const rotated = await api<{ managementLink: string }>(`/api/manage/events/${eventId}/links/manager/rotate`, { method: 'POST', body: '{}' });
    window.location.assign(rotated.managementLink);
  }
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

  if (failure) return <main className="centered-state"><Brand /><ErrorState
    message={failure.message}
    recoveryHint={failure.recoveryHint}
    onRetry={failure.retryable ? () => void refresh() : undefined}
  /></main>;
  if (!event) return <main className="centered-state"><Brand /><LoadingState label="Opening the event manager…" /></main>;

  const photoCount = event.storedMediaCount ?? 0;
  const activeExport = exports[0];
  // One panel, two placements: the wide utility rail and the narrow Share section. The stylesheet
  // reveals exactly one of them, so the host never sees the same export control twice.
  const exportPanel = (variant: 'share' | 'utility') => <ManagerExportPanel
    className={`manager-export-panel--${variant}`}
    job={activeExport}
    download={activeExport ? exportDownloads[activeExport.id] : undefined}
    onPrepare={() => runManagerAction(prepareExport)}
    onDownload={(job) => runManagerAction(() => downloadExport(job))}
    onRetry={(job) => runManagerAction(() => retryExport(job))}
  />;
  return <div className="manager-shell manager-shell--intake">
    {/* The brand and the section navigation, which is a banner rather than complementary content. As
        an `aside` this announced a second unnamed complementary landmark beside the utility rail —
        `landmark-unique` — and as a plain `div` the brand fell outside every landmark — `region`. */}
    <header className="manager-nav"><Brand compact /><nav aria-label="Manager sections">
      <button aria-pressed={section === 'intake'} className={section === 'intake' ? 'active' : ''} onClick={() => openSection('intake')}><Inbox aria-hidden="true" /><span className="manager-nav__label">Intake</span>{photoCount > 0 && <span className="manager-nav__count">{photoCount}</span>}</button>
      <button aria-pressed={section === 'gallery'} className={section === 'gallery' ? 'active' : ''} onClick={() => openSection('gallery')}><ImageIcon aria-hidden="true" /><span className="manager-nav__label">Gallery</span></button>
      <button aria-pressed={section === 'messages'} className={section === 'messages' ? 'active' : ''} onClick={() => openSection('messages')}><MessageCircle aria-hidden="true" /><span className="manager-nav__label">Notes</span>{messages.length > 0 && <span className="manager-nav__count">{messages.length}</span>}</button>
      <button aria-pressed={section === 'share'} className={section === 'share' ? 'active' : ''} onClick={() => openSection('share')}><LinkIcon aria-hidden="true" /><span className="manager-nav__label">Share</span></button>
      <button aria-pressed={section === 'settings'} className={section === 'settings' ? 'active' : ''} onClick={() => openSection('settings')}><Settings aria-hidden="true" /><span className="manager-nav__label">Settings</span></button>
    </nav></header>

    <main className="manager-main">
      <header className="manager-title"><div><p>{new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(`${event.eventDate}T12:00:00`))}</p><h1>{event.name}</h1></div><span className={`status status--${event.uploadsEnabled ? 'approved' : 'pending'}`}>{event.uploadsEnabled ? <Check aria-hidden="true" /> : <EyeOff aria-hidden="true" />} Guest uploads {event.uploadsEnabled ? 'open' : 'paused'}</span></header>
      <div className="lifecycle"><p><strong>{photoCount}</strong> private deliveries</p><p><strong>{formatBytes(event.storedBytes)}</strong> of {STORAGE_CAP} used</p><p>Files delete <strong>{event.purgeAfter ? new Date(event.purgeAfter).toLocaleDateString() : 'on schedule'}</strong></p></div>

      {/* One live region carrying both lines, for the same reason `ErrorState` does: a region that
          announces only what broke never mentions the one thing that recovers it. */}
      {actionError && <p className="manager-action-error" role="alert">
        <span>{actionError.message}{actionError.recoveryHint && <span className="manager-action-error__recovery">{actionError.recoveryHint}</span>}</span>
        <button type="button" className="manager-action-error__dismiss" aria-label="Dismiss error" onClick={() => setActionError(null)}><X aria-hidden="true" /></button>
      </p>}

      {section === 'intake' && <section aria-labelledby="intake-title">
        <div className="workspace-heading"><div><p className="section-label">Private collection</p><h2 id="intake-title">Live intake</h2></div></div>
        <form className="intake-search" onSubmit={(formEvent) => { formEvent.preventDefault(); setGuestFilter(searchInput.trim()); }}>
          <label><span className="sr-only">Filter by guest name</span><Search aria-hidden="true" /><input aria-label="Filter by guest name" value={searchInput} onChange={(change) => setSearchInput(change.target.value)} placeholder="Find a guest by name" /></label>
          <button className="button button--secondary">Filter</button>
          {guestFilter && <button type="button" className="text-button" onClick={() => { setSearchInput(''); setGuestFilter(''); }}>Clear</button>}
        </form>
        {renderMediaGrid(false)}
      </section>}

      {section === 'gallery' && <section aria-labelledby="gallery-publishing-title">
        <div className="workspace-heading"><div><p className="section-label">Optional shared view</p><h2 id="gallery-publishing-title">Gallery publishing</h2></div><div className="filter-tabs" role="group" aria-label="Publication status">{(['unpublished', 'published', 'hidden'] as const).map((value) => <button className={status === value ? 'active' : ''} onClick={() => { setStatus(value); setSelected([]); }} key={value}>{value}</button>)}</div></div>
        {!event.galleryVisible && <p className="manager-notice">The guest gallery is off. Publishing choices are saved for whenever you enable it.</p>}
        <div className="bulk-bar"><span id="bulk-selection-status" role="status" aria-live="polite">{selectionAtLimit
          ? `${MANAGER_BULK_SELECTION_MAX} of ${MANAGER_BULK_SELECTION_MAX} photos selected. Remove one to choose another.`
          : selected.length
            ? `${selected.length} selected`
            : 'Select photos to update the optional gallery'}</span><button className="button button--approve" disabled={!selected.length} onClick={() => void runManagerAction(() => bulk('publish'))}><Eye aria-hidden="true" /> Publish selected</button><button className="button button--danger-outline" disabled={!selected.length} onClick={() => void runManagerAction(() => bulk('hide'))}><EyeOff aria-hidden="true" /> Hide selected</button></div>
        {renderMediaGrid(true)}
      </section>}

      {section === 'share' && <section className="manager-panel"><p className="section-label">Invite your guests</p><h2>Share the photo drop</h2><div className="share-layout"><div><CopyableLinkCard label="Guest link" value={guestLink} /><div className="button-row"><button className="button button--secondary" onClick={() => void runManagerAction(rotateGuestLink)}>Rotate guest link</button><button className="button button--secondary" onClick={() => void runManagerAction(rotateManagerLink)}>Rotate manager link</button></div></div>{qr && <div className="manager-qr"><img src={qr} alt="Guest event QR code" /><a className="button button--secondary" href={qr} download="candidary-guest-qr.png"><QrCode aria-hidden="true" /> Download QR</a></div>}</div>{exportPanel('share')}</section>}

      {section === 'messages' && <section className="manager-panel"><p className="section-label">Guest notes</p><h2>Notes from the day</h2>{messages.length ? <ul className="manager-messages">{messages.map((message) => <li key={message.id}><p>{message.body}</p><small>{message.guestName || 'A guest'} · {message.moderationStatus}</small><div className="button-row"><button className="button button--approve" onClick={() => void runManagerAction(() => moderateMessage(message, 'approve'))}><Check aria-hidden="true" /> Approve</button><button className="button button--danger-outline" onClick={() => void runManagerAction(() => moderateMessage(message, 'reject'))}><EyeOff aria-hidden="true" /> Hide</button><button className="button button--danger-outline" onClick={() => void runManagerAction(() => moderateMessage(message, 'delete'))}><Trash2 aria-hidden="true" /> Delete</button></div></li>)}</ul> : <div className="empty-state"><MessageCircle aria-hidden="true" /><h3>No notes yet.</h3><p>Optional guest messages will appear here.</p></div>}</section>}

      {section === 'settings' && <section className="manager-panel"><p className="section-label">Event controls</p><h2>Settings</h2><form className="settings-form" onSubmit={(formEvent) => { formEvent.preventDefault(); const element = formEvent.currentTarget; void runManagerAction(() => saveSettings(element)); }}><label>Event name<input name="name" defaultValue={event.name} /></label><label>Welcome message<textarea name="welcomeMessage" rows={4} defaultValue={event.welcomeMessage} /></label><label className="toggle"><input type="checkbox" name="uploadsEnabled" defaultChecked={event.uploadsEnabled} /><span>Accept private photo deliveries</span></label><label className="toggle"><input type="checkbox" name="galleryVisible" defaultChecked={event.galleryVisible} /><span>Show the optional shared gallery</span></label><label className="toggle"><input type="checkbox" name="moderationRequired" defaultChecked={event.moderationRequired} /><span>Review notes before sharing</span></label><button className="button button--primary">Save settings</button></form><div className="danger-zone"><h3>Delete this event</h3><p>Type <strong>{event.name}</strong> to revoke both links and permanently remove every file.</p><form onSubmit={(formEvent) => { formEvent.preventDefault(); const element = formEvent.currentTarget; void runManagerAction(() => deleteEvent(element)); }}><input name="confirmation" aria-label="Confirm event name" autoComplete="off" /><button className="button button--danger-outline"><Trash2 aria-hidden="true" /> Delete event</button></form></div></section>}
    </main>

    <aside className="manager-utility">
      <section className="manager-utility__guest-entry"><p className="section-label">Guest entry</p><h2>Scan to contribute</h2>{qr && <img className="intake-qr" src={qr} alt="Guest event QR code" />}<button type="button" className="button button--secondary button--wide" onClick={() => void copyGuestLink()}><Copy aria-hidden="true" /> Copy guest link</button></section>
      <section className="manager-utility__capacity"><p className="section-label">Event capacity</p><div className="stat"><strong>{photoCount}</strong><span>photos stored</span></div><div className="meter"><span style={{ width: `${Math.min(100, (photoCount / MAX_EVENT_MEDIA) * 100)}%` }} /></div><small>{photoCount.toLocaleString()} of {PHOTO_CAP} · {formatBytes(event.storedBytes)} of {STORAGE_CAP}</small></section>
      {exportPanel('utility')}
    </aside>
  </div>;
}

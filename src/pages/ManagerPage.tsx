import { Check, Copy, Download, Eye, EyeOff, Image as ImageIcon, Inbox, Link as LinkIcon, MessageCircle, QrCode, Search, Settings, Trash2 } from 'lucide-react';
import QRCode from 'qrcode';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';

import { api, mediaOriginal, mediaPreview } from '../app/api';
import type { EventView, ExportDownloadView, ExportView, MediaView, MessageView } from '../app/types';
import { Brand } from '../components/Brand';
import { ErrorState, LoadingState } from '../components/States';

type Section = 'intake' | 'gallery' | 'messages' | 'share' | 'settings';
type MediaStatus = 'all' | MediaView['publicationStatus'];

function formatBytes(bytes = 0) {
  if (bytes < 1024 ** 2) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function ManagerPage() {
  const { eventId = '' } = useParams();
  const [event, setEvent] = useState<EventView | null>(null);
  const [media, setMedia] = useState<MediaView[]>([]);
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
  const [error, setError] = useState('');

  const mediaPath = useMemo(() => {
    const params = new URLSearchParams();
    if (status !== 'all') params.set('status', status);
    if (guestFilter) params.set('guestName', guestFilter);
    const query = params.toString();
    return `/api/manage/events/${eventId}/media${query ? `?${query}` : ''}`;
  }, [eventId, guestFilter, status]);

  async function refresh() {
    try {
      const [eventData, mediaData, messageData, exportData, linkData] = await Promise.all([
        api<{ event: EventView }>(`/api/manage/events/${eventId}`),
        api<{ media: MediaView[] }>(mediaPath),
        api<{ messages: MessageView[] }>(`/api/manage/events/${eventId}/messages`),
        api<{ exports: ExportView[] }>(`/api/manage/events/${eventId}/exports`),
        api<{ guestLink: string }>(`/api/manage/events/${eventId}/links`),
      ]);
      setEvent(eventData.event);
      setMedia(mediaData.media);
      setMessages(messageData.messages);
      setExports(exportData.exports);
      setGuestLink(linkData.guestLink);
      setError('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The event manager could not be loaded.');
    }
  }

  useEffect(() => { void refresh(); }, [mediaPath]);
  useEffect(() => {
    if (guestLink) void QRCode.toDataURL(guestLink, { width: 220, margin: 2, color: { dark: '#42103b', light: '#fffaf3' } }).then(setQr);
  }, [guestLink]);

  function openSection(next: Section) {
    setSection(next);
    setSelected([]);
    if (next === 'intake') setStatus('all');
    if (next === 'gallery' && status === 'all') setStatus('unpublished');
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

  async function saveSettings(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    const form = new FormData(formEvent.currentTarget);
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
  async function deleteEvent(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    const form = new FormData(formEvent.currentTarget);
    await api(`/api/manage/events/${eventId}`, { method: 'DELETE', body: JSON.stringify({ confirmation: form.get('confirmation') }) });
    window.location.assign('/');
  }

  function renderMediaGrid(publicationControls: boolean) {
    if (!media.length) return <div className="empty-state"><ImageIcon aria-hidden="true" /><h3>No matching photos.</h3><p>New private deliveries will appear here immediately.</p></div>;
    return <div className="moderation-grid intake-grid">{media.map((item) => <article className={selected.includes(item.id) ? 'selected' : ''} key={item.id}>
      <div className="intake-photo">
        {publicationControls && <label className="intake-select"><input type="checkbox" aria-label={`Select ${item.originalFilename}`} checked={selected.includes(item.id)} onChange={(change) => setSelected((current) => change.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} /></label>}
        <img src={mediaPreview(item.id)} alt={item.caption || item.originalFilename} />
      </div>
      <div>
        <span className={`publication publication--${item.publicationStatus}`}>{item.publicationStatus}</span>
        <strong>{item.caption || item.originalFilename}</strong>
        <small>From {item.guestName}</small>
        <div className="intake-card-actions">
          <a href={mediaOriginal(item.id)} download aria-label={`Download original ${item.originalFilename}`}><Download aria-hidden="true" /></a>
          {publicationControls && item.publicationStatus !== 'published' && <button aria-label={`Publish ${item.originalFilename}`} onClick={() => void changePublication(item, 'publish')}><Eye aria-hidden="true" /></button>}
          {publicationControls && item.publicationStatus !== 'hidden' && <button aria-label={`Hide ${item.originalFilename}`} onClick={() => void changePublication(item, 'hide')}><EyeOff aria-hidden="true" /></button>}
          <button aria-label={`Delete ${item.originalFilename}`} onClick={() => void changePublication(item, 'delete')}><Trash2 aria-hidden="true" /></button>
        </div>
      </div>
    </article>)}</div>;
  }

  if (error) return <main className="centered-state"><Brand /><ErrorState message={error} /></main>;
  if (!event) return <main className="centered-state"><Brand /><LoadingState label="Opening the event manager…" /></main>;

  const photoCount = event.storedMediaCount ?? 0;
  return <div className="manager-shell manager-shell--intake">
    <aside className="manager-nav"><Brand compact /><nav aria-label="Manager sections">
      <button className={section === 'intake' ? 'active' : ''} onClick={() => openSection('intake')}><Inbox aria-hidden="true" /> Intake <span>{photoCount}</span></button>
      <button className={section === 'gallery' ? 'active' : ''} onClick={() => openSection('gallery')}><ImageIcon aria-hidden="true" /> Gallery</button>
      <button className={section === 'messages' ? 'active' : ''} onClick={() => openSection('messages')}><MessageCircle aria-hidden="true" /> Notes <span>{messages.length}</span></button>
      <button className={section === 'share' ? 'active' : ''} onClick={() => openSection('share')}><LinkIcon aria-hidden="true" /> Share</button>
      <button className={section === 'settings' ? 'active' : ''} onClick={() => openSection('settings')}><Settings aria-hidden="true" /> Settings</button>
    </nav></aside>

    <main className="manager-main">
      <header className="manager-title"><div><p>{new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(`${event.eventDate}T12:00:00`))}</p><h1>{event.name}</h1></div><span className={`status status--${event.uploadsEnabled ? 'approved' : 'pending'}`}>{event.uploadsEnabled ? <Check aria-hidden="true" /> : <EyeOff aria-hidden="true" />} Guest uploads {event.uploadsEnabled ? 'open' : 'paused'}</span></header>
      <div className="lifecycle"><p><strong>{photoCount}</strong> private deliveries</p><p><strong>{formatBytes(event.storedBytes)}</strong> of 100 GB used</p><p>Files delete <strong>{event.purgeAfter ? new Date(event.purgeAfter).toLocaleDateString() : 'on schedule'}</strong></p></div>

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
        <div className="bulk-bar"><span>{selected.length ? `${selected.length} selected` : 'Select photos to update the optional gallery'}</span><button className="button button--approve" disabled={!selected.length} onClick={() => void bulk('publish')}><Eye aria-hidden="true" /> Publish selected</button><button className="button button--danger-outline" disabled={!selected.length} onClick={() => void bulk('hide')}><EyeOff aria-hidden="true" /> Hide selected</button></div>
        {renderMediaGrid(true)}
      </section>}

      {section === 'share' && <section className="manager-panel"><p className="section-label">Invite your guests</p><h2>Share the photo drop</h2><div className="share-layout"><div><div className="link-card"><span>Guest link</span><div><code>{guestLink}</code><button type="button" className="icon-button" aria-label="Copy guest link" onClick={() => void navigator.clipboard?.writeText(guestLink)}><Copy aria-hidden="true" /></button></div></div><div className="button-row"><button className="button button--secondary" onClick={() => void rotateGuestLink()}>Rotate guest link</button><button className="button button--secondary" onClick={() => void rotateManagerLink()}>Rotate manager link</button></div></div>{qr && <div className="manager-qr"><img src={qr} alt="Guest event QR code" /><a className="button button--secondary" href={qr} download="candidary-guest-qr.png"><QrCode aria-hidden="true" /> Download QR</a></div>}</div></section>}

      {section === 'messages' && <section className="manager-panel"><p className="section-label">Guest notes</p><h2>Notes from the day</h2>{messages.length ? <ul className="manager-messages">{messages.map((message) => <li key={message.id}><p>{message.body}</p><small>{message.guestName || 'A guest'} · {message.moderationStatus}</small><div className="button-row"><button className="button button--approve" onClick={() => void moderateMessage(message, 'approve')}><Check aria-hidden="true" /> Approve</button><button className="button button--danger-outline" onClick={() => void moderateMessage(message, 'reject')}><EyeOff aria-hidden="true" /> Hide</button><button className="button button--danger-outline" onClick={() => void moderateMessage(message, 'delete')}><Trash2 aria-hidden="true" /> Delete</button></div></li>)}</ul> : <div className="empty-state"><MessageCircle aria-hidden="true" /><h3>No notes yet.</h3><p>Optional guest messages will appear here.</p></div>}</section>}

      {section === 'settings' && <section className="manager-panel"><p className="section-label">Event controls</p><h2>Settings</h2><form className="settings-form" onSubmit={(formEvent) => void saveSettings(formEvent)}><label>Event name<input name="name" defaultValue={event.name} /></label><label>Welcome message<textarea name="welcomeMessage" rows={4} defaultValue={event.welcomeMessage} /></label><label className="toggle"><input type="checkbox" name="uploadsEnabled" defaultChecked={event.uploadsEnabled} /><span>Accept private photo deliveries</span></label><label className="toggle"><input type="checkbox" name="galleryVisible" defaultChecked={event.galleryVisible} /><span>Show the optional shared gallery</span></label><label className="toggle"><input type="checkbox" name="moderationRequired" defaultChecked={event.moderationRequired} /><span>Review notes before sharing</span></label><button className="button button--primary">Save settings</button></form><div className="danger-zone"><h3>Delete this event</h3><p>Type <strong>{event.name}</strong> to revoke both links and permanently remove every file.</p><form onSubmit={(formEvent) => void deleteEvent(formEvent)}><input name="confirmation" aria-label="Confirm event name" autoComplete="off" /><button className="button button--danger-outline"><Trash2 aria-hidden="true" /> Delete event</button></form></div></section>}
    </main>

    <aside className="manager-utility">
      <section><p className="section-label">Guest entry</p><h2>Scan to contribute</h2>{qr && <img className="intake-qr" src={qr} alt="Guest event QR code" />}<button type="button" className="button button--secondary button--wide" onClick={() => void navigator.clipboard?.writeText(guestLink)}><Copy aria-hidden="true" /> Copy guest link</button></section>
      <section><p className="section-label">Event capacity</p><div className="stat"><strong>{photoCount}</strong><span>photos stored</span></div><div className="meter"><span style={{ width: `${Math.min(100, (photoCount / 10_000) * 100)}%` }} /></div><small>{photoCount.toLocaleString()} of 10,000 · {formatBytes(event.storedBytes)} of 100 GB</small></section>
      <section><p className="section-label">Complete export</p><h2>Keep every original</h2>{exports[0] ? <div className="export-state"><strong>{exports[0].state}</strong><span>{exports[0].mediaCount} photos · {exports[0].partCount || 0} parts · attempt {exports[0].attempt}</span>{exports[0].state === 'ready' && !exportDownloads[exports[0].id] && <button className="button button--secondary" onClick={() => void downloadExport(exports[0]!)}><Download aria-hidden="true" /> Get download links</button>}{exportDownloads[exports[0].id] && <div className="export-links"><a href={exportDownloads[exports[0].id]!.manifest.url}>Manifest</a>{exportDownloads[exports[0].id]!.parts.map((part) => <a href={part.url} key={part.partNumber}>Part {part.partNumber} <small>{part.mediaCount} photos</small></a>)}</div>}{(exports[0].state === 'failed' || exports[0].state === 'expired') && <button className="button button--secondary" onClick={() => void retryExport(exports[0]!)}>Retry export</button>}</div> : <><p>Prepare every delivered original, whether or not it appears in the gallery.</p><button className="button button--primary button--wide" onClick={() => void prepareExport()}><Download aria-hidden="true" /> Prepare download</button></>}</section>
    </aside>
  </div>;
}

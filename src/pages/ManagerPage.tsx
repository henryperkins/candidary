import { Ban, Check, Copy, Download, Image, Link as LinkIcon, MessageCircle, QrCode, Settings, Trash2 } from 'lucide-react';
import QRCode from 'qrcode';
import { type FormEvent, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

import { api, mediaContent } from '../app/api';
import type { EventView, ExportView, MediaView, MessageView } from '../app/types';
import { Brand } from '../components/Brand';
import { ErrorState, LoadingState } from '../components/States';

type Section = 'overview' | 'moderation' | 'messages' | 'settings';

export function ManagerPage() {
  const { eventId = '' } = useParams();
  const [event, setEvent] = useState<EventView | null>(null);
  const [media, setMedia] = useState<MediaView[]>([]);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [exports, setExports] = useState<ExportView[]>([]);
  const [guestLink, setGuestLink] = useState('');
  const [qr, setQr] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [section, setSection] = useState<Section>('moderation');
  const [status, setStatus] = useState<'pending' | 'approved' | 'rejected'>('pending');
  const [error, setError] = useState('');

  async function refresh() {
    try {
      const [eventData, mediaData, messageData, exportData, linkData] = await Promise.all([
        api<{ event: EventView }>(`/api/manage/events/${eventId}`),
        api<{ media: MediaView[] }>(`/api/manage/events/${eventId}/media?status=${status}`),
        api<{ messages: MessageView[] }>(`/api/manage/events/${eventId}/messages`),
        api<{ exports: ExportView[] }>(`/api/manage/events/${eventId}/exports`),
        api<{ guestLink: string }>(`/api/manage/events/${eventId}/links`),
      ]);
      setEvent(eventData.event); setMedia(mediaData.media); setMessages(messageData.messages); setExports(exportData.exports); setGuestLink(linkData.guestLink);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'The event manager could not be loaded.'); }
  }
  useEffect(() => { void refresh(); }, [eventId, status]);
  useEffect(() => { if (guestLink) void QRCode.toDataURL(guestLink, { width: 220, margin: 2, color: { dark: '#42103b', light: '#fffaf3' } }).then(setQr); }, [guestLink]);

  async function bulk(action: 'approve' | 'reject') {
    await api(`/api/manage/events/${eventId}/media/bulk`, { method: 'POST', body: JSON.stringify({ ids: selected, action, expectedStatus: status }) });
    setSelected([]); await refresh();
  }
  async function moderate(id: string, action: 'approve' | 'reject' | 'delete') {
    await api(`/api/manage/events/${eventId}/media/${id}`, { method: 'PATCH', body: JSON.stringify({ action, expectedStatus: status }) }); await refresh();
  }
  async function saveSettings(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault(); const form = new FormData(formEvent.currentTarget);
    await api(`/api/manage/events/${eventId}/settings`, { method: 'PATCH', body: JSON.stringify({
      name: form.get('name'), welcomeMessage: form.get('welcomeMessage'), uploadsEnabled: form.get('uploadsEnabled') === 'on',
      galleryVisible: form.get('galleryVisible') === 'on', moderationRequired: form.get('moderationRequired') === 'on',
    }) }); await refresh();
  }
  async function prepareExport() { await api(`/api/manage/events/${eventId}/exports`, { method: 'POST', body: '{}' }); await refresh(); }
  async function downloadExport(job: ExportView) {
    const result = await api<{ url: string }>(`/api/manage/events/${eventId}/exports/${job.id}/download`, { method: 'POST', body: '{}' });
    window.location.assign(result.url);
  }
  async function retryExport(job: ExportView) { await api(`/api/manage/events/${eventId}/exports/${job.id}/retry`, { method: 'POST', body: '{}' }); await refresh(); }
  async function moderateMessage(message: MessageView, action: 'approve' | 'reject' | 'delete') {
    await api(`/api/manage/events/${eventId}/messages/${message.id}`, { method: 'PATCH', body: JSON.stringify({ action, expectedStatus: message.moderationStatus }) }); await refresh();
  }
  async function rotateGuestLink() {
    if (!window.confirm('Rotate the guest link? Every old guest link and session will stop working immediately.')) return;
    const rotated = await api<{ guestLink: string }>(`/api/manage/events/${eventId}/links/guest/rotate`, { method: 'POST', body: '{}' }); setGuestLink(rotated.guestLink);
  }
  async function rotateManagerLink() {
    if (!window.confirm('Rotate the management link? This session will stop working immediately.')) return;
    const rotated = await api<{ managementLink: string }>(`/api/manage/events/${eventId}/links/manager/rotate`, { method: 'POST', body: '{}' }); window.location.assign(rotated.managementLink);
  }
  async function deleteEvent(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault(); const form = new FormData(formEvent.currentTarget);
    await api(`/api/manage/events/${eventId}`, { method: 'DELETE', body: JSON.stringify({ confirmation: form.get('confirmation') }) }); window.location.assign('/');
  }

  if (error) return <main className="centered-state"><Brand /><ErrorState message={error} /></main>;
  if (!event) return <main className="centered-state"><Brand /><LoadingState label="Opening the event manager…" /></main>;

  return <div className="manager-shell">
    <aside className="manager-nav"><Brand compact /><nav aria-label="Manager sections">
      <button className={section === 'overview' ? 'active' : ''} onClick={() => setSection('overview')}><LinkIcon aria-hidden="true" /> Share</button>
      <button className={section === 'moderation' ? 'active' : ''} onClick={() => setSection('moderation')}><Image aria-hidden="true" /> Photos <span>{event.storedMediaCount ?? 0}</span></button>
      <button className={section === 'messages' ? 'active' : ''} onClick={() => setSection('messages')}><MessageCircle aria-hidden="true" /> Notes <span>{messages.length}</span></button>
      <button className={section === 'settings' ? 'active' : ''} onClick={() => setSection('settings')}><Settings aria-hidden="true" /> Settings</button>
    </nav></aside>
    <main className="manager-main">
      <header className="manager-title"><div><p>{new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(`${event.eventDate}T12:00:00`))}</p><h1>{event.name}</h1></div><span className="status status--approved"><Check aria-hidden="true" /> Guest uploads open</span></header>
      <div className="lifecycle"><p>Guest access closes <strong>{event.guestAccessExpiresAt ? new Date(event.guestAccessExpiresAt).toLocaleDateString() : 'on schedule'}</strong></p><p>Event files are deleted <strong>{event.purgeAfter ? new Date(event.purgeAfter).toLocaleDateString() : 'on schedule'}</strong></p></div>

      {section === 'moderation' && <section aria-labelledby="photos-title"><div className="workspace-heading"><div><p className="section-label">Review the shared view</p><h2 id="photos-title">Photos</h2></div><div className="filter-tabs" role="group" aria-label="Photo status">{(['pending', 'approved', 'rejected'] as const).map((value) => <button className={status === value ? 'active' : ''} onClick={() => { setStatus(value); setSelected([]); }} key={value}>{value}</button>)}</div></div>
        <div className="bulk-bar"><span>{selected.length ? `${selected.length} selected` : 'Select photos to moderate together'}</span><button className="button button--approve" disabled={!selected.length} onClick={() => void bulk('approve')}><Check aria-hidden="true" /> Approve selected</button><button className="button button--danger-outline" disabled={!selected.length} onClick={() => void bulk('reject')}><Ban aria-hidden="true" /> Reject selected</button></div>
        {media.length ? <div className="moderation-grid">{media.map((item) => <article className={selected.includes(item.id) ? 'selected' : ''} key={item.id}><label><input type="checkbox" aria-label={`Select ${item.originalFilename}`} checked={selected.includes(item.id)} onChange={(e) => setSelected((current) => e.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} /><img src={mediaContent(item.id)} alt={item.caption || item.originalFilename} /></label><div><strong>{item.caption || item.originalFilename}</strong><small>{item.guestName ? `From ${item.guestName}` : 'From a guest'}</small><div><button aria-label={`Approve ${item.originalFilename}`} onClick={() => void moderate(item.id, 'approve')}><Check aria-hidden="true" /></button><button aria-label={`Reject ${item.originalFilename}`} onClick={() => void moderate(item.id, 'reject')}><Ban aria-hidden="true" /></button><button aria-label={`Delete ${item.originalFilename}`} onClick={() => void moderate(item.id, 'delete')}><Trash2 aria-hidden="true" /></button></div></div></article>)}</div> : <div className="empty-state"><Image aria-hidden="true" /><h3>No {status} photos.</h3><p>New guest uploads will arrive here for review.</p></div>}
      </section>}

      {section === 'overview' && <section className="manager-panel"><p className="section-label">Invite your guests</p><h2>Share the event</h2><div className="share-layout"><div><div className="link-card"><span>Guest link</span><div><code>{guestLink}</code><button type="button" className="icon-button" aria-label="Copy guest link" onClick={() => void navigator.clipboard?.writeText(guestLink)}><Copy aria-hidden="true" /></button></div></div><div className="button-row"><button className="button button--secondary" onClick={() => void rotateGuestLink()}>Rotate guest link</button><button className="button button--secondary" onClick={() => void rotateManagerLink()}>Rotate manager link</button></div></div>{qr && <div className="manager-qr"><img src={qr} alt="Guest event QR code" /><a className="button button--secondary" href={qr} download="candidary-guest-qr.png"><QrCode aria-hidden="true" /> Download QR</a></div>}</div></section>}

      {section === 'messages' && <section className="manager-panel"><p className="section-label">Guest notes</p><h2>Notes from the day</h2>{messages.length ? <ul className="manager-messages">{messages.map((message) => <li key={message.id}><p>{message.body}</p><small>{message.guestName || 'A guest'} · {message.moderationStatus}</small><div className="button-row"><button className="button button--approve" onClick={() => void moderateMessage(message, 'approve')}><Check aria-hidden="true" /> Approve</button><button className="button button--danger-outline" onClick={() => void moderateMessage(message, 'reject')}><Ban aria-hidden="true" /> Reject</button><button className="button button--danger-outline" onClick={() => void moderateMessage(message, 'delete')}><Trash2 aria-hidden="true" /> Delete</button></div></li>)}</ul> : <div className="empty-state"><MessageCircle aria-hidden="true" /><h3>No notes yet.</h3><p>Guest messages will appear here.</p></div>}</section>}

      {section === 'settings' && <section className="manager-panel"><p className="section-label">Event controls</p><h2>Settings</h2><form className="settings-form" onSubmit={(e) => void saveSettings(e)}><label>Event name<input name="name" defaultValue={event.name} /></label><label>Welcome message<textarea name="welcomeMessage" rows={4} defaultValue={event.welcomeMessage} /></label><label className="toggle"><input type="checkbox" name="uploadsEnabled" defaultChecked={event.uploadsEnabled} /><span>Guest uploads</span></label><label className="toggle"><input type="checkbox" name="galleryVisible" defaultChecked={event.galleryVisible} /><span>Shared gallery</span></label><label className="toggle"><input type="checkbox" name="moderationRequired" defaultChecked={event.moderationRequired} /><span>Review before publishing</span></label><button className="button button--primary">Save settings</button></form><div className="danger-zone"><h3>Delete this event</h3><p>Type <strong>{event.name}</strong> to revoke both links and permanently remove every file.</p><form onSubmit={(e) => void deleteEvent(e)}><input name="confirmation" aria-label="Confirm event name" autoComplete="off" /><button className="button button--danger-outline"><Trash2 aria-hidden="true" /> Delete event</button></form></div></section>}
    </main>
    <aside className="manager-utility"><section><p className="section-label">Event snapshot</p><div className="stat"><strong>{event.storedMediaCount ?? 0}</strong><span>photos stored</span></div><div className="meter"><span style={{ width: `${Math.min(100, ((event.storedMediaCount ?? 0) / 50) * 100)}%` }} /></div><small>{event.storedMediaCount ?? 0} of 50 photos</small></section><section><p className="section-label">Export</p><h2>Keep the originals</h2>{exports[0] ? <div className="export-state"><strong>{exports[0].state}</strong><span>{exports[0].mediaCount} photos · attempt {exports[0].attempt}</span>{exports[0].state === 'ready' && <button className="button button--secondary" onClick={() => void downloadExport(exports[0]!)}><Download aria-hidden="true" /> Get download link</button>}{(exports[0].state === 'failed' || exports[0].state === 'expired') && <button className="button button--secondary" onClick={() => void retryExport(exports[0]!)}>Retry export</button>}</div> : <><p>Prepare a private ZIP of every approved original plus its details.</p><button className="button button--primary button--wide" onClick={() => void prepareExport()}><Download aria-hidden="true" /> Prepare export</button></>}</section></aside>
  </div>;
}

import { ArrowRight, Expand, ImagePlus, MessageCircle, Upload, X } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { api, mediaContent } from '../app/api';
import type { EventView, MediaView, MessageView } from '../app/types';
import { Brand } from '../components/Brand';
import { ErrorState, LoadingState } from '../components/States';

interface UploadItem { file: File; id: string; state: 'ready' | 'uploading' | 'done' | 'error'; error?: string }

export function EventPage({ fullscreen = false }: { fullscreen?: boolean }) {
  const { slug = '' } = useParams();
  const [event, setEvent] = useState<EventView | null>(null);
  const [gallery, setGallery] = useState<MediaView[]>([]);
  const [contributions, setContributions] = useState<MediaView[]>([]);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [name, setName] = useState(() => localStorage.getItem('candidary_guest_name') ?? '');
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);

  async function refresh() {
    try {
      const shell = await api<{ event: EventView; role: string }>(`/api/event/${slug}`);
      setEvent(shell.event);
      const [galleryData, contributionData, messageData] = await Promise.all([
        shell.event.galleryVisible ? api<{ media: MediaView[] }>(`/api/event/${slug}/gallery`) : Promise.resolve({ media: [] }),
        api<{ media: MediaView[] }>(`/api/event/${slug}/contributions`),
        api<{ items: MessageView[] }>(`/api/event/${slug}/messages`),
      ]);
      setGallery(galleryData.media); setContributions(contributionData.media); setMessages(messageData.items);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'This event could not be loaded.'); }
  }
  useEffect(() => { void refresh(); }, [slug]);

  function choose(files: FileList | null) {
    if (!files) return;
    setUploads((current) => [...current, ...[...files].map((file) => ({ file, id: crypto.randomUUID(), state: 'ready' as const }))]);
  }
  async function sendUploads() {
    for (const item of uploads.filter(({ state }) => state === 'ready' || state === 'error')) {
      setUploads((all) => all.map((entry) => entry.id === item.id ? { ...entry, state: 'uploading' } : entry));
      try {
        const result = await api<{ media: MediaView & { objectKey: string }; uploadUrl: string }>(`/api/event/${slug}/uploads`, { method: 'POST', body: JSON.stringify({
          filename: item.file.name, mimeType: item.file.type, byteSize: item.file.size,
          idempotencyKey: item.id, guestName: name || null, caption: null,
        }) });
        const uploaded = await fetch(result.uploadUrl, { method: 'PUT', headers: { 'content-type': item.file.type }, body: item.file });
        if (!uploaded.ok) throw new Error('Transfer failed.');
        await api(`/api/event/${slug}/uploads/${result.media.id}/finalize`, { method: 'POST', body: '{}' });
        setUploads((all) => all.map((entry) => entry.id === item.id ? { ...entry, state: 'done' } : entry));
      } catch (caught) { setUploads((all) => all.map((entry) => entry.id === item.id ? { ...entry, state: 'error', error: caught instanceof Error ? caught.message : 'Upload failed.' } : entry)); }
    }
    await refresh();
  }
  async function leaveNote(eventForm: FormEvent<HTMLFormElement>) {
    eventForm.preventDefault(); const form = new FormData(eventForm.currentTarget);
    await api(`/api/event/${slug}/messages`, { method: 'POST', body: JSON.stringify({ guestName: name || null, body: form.get('body') }) });
    eventForm.currentTarget.reset(); await refresh();
  }

  if (error) return <main className="centered-state"><Brand /><ErrorState message={error} /></main>;
  if (!event) return <main className="centered-state"><Brand /><LoadingState /></main>;
  if (fullscreen) return <main className="fullscreen"><div className="fullscreen__bar"><Brand compact /><Link to={`/event/${slug}`} aria-label="Close full-screen gallery"><X aria-hidden="true" /></Link></div>{gallery.length ? <div className="fullscreen__grid">{gallery.map((item) => <figure key={item.id}><img src={mediaContent(item.id)} alt={item.caption || item.originalFilename} /><figcaption>{item.caption || item.originalFilename}</figcaption></figure>)}</div> : <p>No approved photos yet.</p>}</main>;

  return <div className="guest-shell">
    <header className="guest-header"><Brand /><nav aria-label="Event sections"><a href="#add">Add photos</a><a href="#gallery">Gallery</a><a href="#notes">Notes</a></nav></header>
    <main>
      <section className="event-welcome"><div><time dateTime={event.eventDate}>{new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(`${event.eventDate}T12:00:00`))}</time><h1>{event.name}</h1><p>{event.welcomeMessage}</p><button className="button button--primary" onClick={() => input.current?.click()} disabled={!event.uploadsEnabled}><Upload aria-hidden="true" /> Add photos</button></div><img src={event.coverObjectKey ? `/api/event/${slug}/cover` : '/assets/candidary-hero.png'} alt={`Cover for ${event.name}`} /></section>
      <section className="upload-band" id="add"><div className="upload-drop"><ImagePlus aria-hidden="true" /><div><h2>Add what you noticed.</h2><p>JPEG, PNG, or WebP · up to 10 MB each</p></div><button className="button button--secondary" onClick={() => input.current?.click()}>Choose photos</button><input ref={input} className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(e) => choose(e.target.files)} /></div>
        <label className="guest-name">What should we call you?<input value={name} maxLength={80} placeholder="Your name (optional)" onChange={(e) => { setName(e.target.value); localStorage.setItem('candidary_guest_name', e.target.value); }} /></label>
        {uploads.length > 0 && <div className="upload-tray"><ul>{uploads.map((item) => <li key={item.id}><span>{item.file.name}</span><em>{item.state}</em>{item.error && <small>{item.error}</small>}</li>)}</ul><button className="button button--primary" onClick={() => void sendUploads()}>Upload {uploads.filter(({ state }) => state !== 'done').length} photos</button></div>}
      </section>
      <section className="gallery-section" id="gallery"><div className="section-heading"><div><p className="section-label">The shared view</p><h2>Moments so far</h2></div>{gallery.length > 0 && <Link className="text-link" to={`/event/${slug}/fullscreen`}><Expand aria-hidden="true" /> View full screen</Link>}</div>
        {gallery.length ? <div className="photo-grid">{gallery.map((item) => <figure key={item.id}><img loading="lazy" src={mediaContent(item.id)} alt={item.caption || item.originalFilename} /><figcaption><span>{item.caption}</span>{item.guestName && <small>by {item.guestName}</small>}</figcaption></figure>)}</div> : <div className="empty-state"><ImagePlus aria-hidden="true" /><h3>The gallery is waiting for its first moment.</h3><p>Approved photos will appear here.</p></div>}
      </section>
      <section className="contributions"><div><p className="section-label">Just yours</p><h2>My contributions</h2></div>{contributions.length ? <ul>{contributions.map((item) => <li key={item.id}><img src={mediaContent(item.id)} alt={item.originalFilename} /><span>{item.originalFilename}</span><em className={`status status--${item.moderationStatus}`}>{item.moderationStatus}</em></li>)}</ul> : <p>You haven’t added any photos from this device yet.</p>}</section>
      <section className="notes-section" id="notes"><div className="notes-intro"><MessageCircle aria-hidden="true" /><p className="section-label">Leave a little something</p><h2>Notes from the day</h2><p>Share a wish, a memory, or the thing you’ll remember.</p></div><div><form className="note-form" onSubmit={(e) => void leaveNote(e)}><textarea name="body" rows={3} maxLength={500} required placeholder="Write a note…" /><button className="button button--primary">Leave a note <ArrowRight aria-hidden="true" /></button></form><ul className="notes-feed">{messages.map((item) => <li key={item.id}><p>{item.body}</p><small>{item.guestName || 'A guest'}</small></li>)}</ul></div></section>
    </main>
    <footer><Brand compact /><p>Private moments, held together.</p></footer>
  </div>;
}

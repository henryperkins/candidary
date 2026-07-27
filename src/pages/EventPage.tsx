import { ArrowRight, ChevronDown, Expand, ImagePlus, MessageCircle, X } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { api, mediaPreview } from '../app/api';
import type { EventView, MediaView, MessageView } from '../app/types';
import { Brand } from '../components/Brand';
import { ErrorState, LoadingState } from '../components/States';
import { GuestUploadFlow } from '../features/uploads/GuestUploadFlow';

export function EventPage({ fullscreen = false }: { fullscreen?: boolean }) {
  const { slug = '' } = useParams();
  const [event, setEvent] = useState<EventView | null>(null);
  const [gallery, setGallery] = useState<MediaView[]>([]);
  const [contributions, setContributions] = useState<MediaView[]>([]);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [opened, setOpened] = useState({ gallery: false, contributions: false, notes: false });
  const [loaded, setLoaded] = useState({ gallery: false, contributions: false, notes: false });
  const [error, setError] = useState('');
  const [terminal, setTerminal] = useState(false);

  const loadGallery = useCallback(async () => {
    const result = await api<{ media: MediaView[] }>(`/api/event/${slug}/gallery`);
    setGallery(result.media);
  }, [slug]);
  const loadContributions = useCallback(async () => {
    const result = await api<{ media: MediaView[] }>(`/api/event/${slug}/contributions`);
    setContributions(result.media);
  }, [slug]);
  const loadMessages = useCallback(async () => {
    const result = await api<{ items: MessageView[] }>(`/api/event/${slug}/messages`);
    setMessages(result.items);
  }, [slug]);

  useEffect(() => {
    let active = true;
    void api<{ event: EventView; role: string }>(`/api/event/${slug}`)
      .then(async ({ event: eventView }) => {
        if (!active) return;
        setEvent(eventView);
        if (fullscreen && eventView.galleryVisible) {
          await loadGallery();
          if (active) setLoaded((current) => ({ ...current, gallery: true }));
        }
      })
      .catch((caught: unknown) => {
        if (active) setError(caught instanceof Error ? caught.message : 'This event could not be loaded.');
      });
    return () => { active = false; };
  }, [fullscreen, loadGallery, slug]);

  function toggleExtra(kind: keyof typeof opened, isOpen: boolean) {
    setOpened((current) => ({ ...current, [kind]: isOpen }));
    if (!isOpen || loaded[kind]) return;
    if (kind === 'gallery' && !event?.galleryVisible) {
      setLoaded((current) => ({ ...current, gallery: true }));
      return;
    }
    setLoaded((current) => ({ ...current, [kind]: true }));
    const request = kind === 'gallery' ? loadGallery() : kind === 'contributions' ? loadContributions() : loadMessages();
    void request.catch(() => setLoaded((current) => ({ ...current, [kind]: false })));
  }

  async function leaveNote(eventForm: FormEvent<HTMLFormElement>) {
    eventForm.preventDefault();
    const form = new FormData(eventForm.currentTarget);
    const guestName = localStorage.getItem('candidary_guest_name')?.trim() || null;
    await api(`/api/event/${slug}/messages`, {
      method: 'POST',
      body: JSON.stringify({ guestName, body: form.get('body') }),
    });
    eventForm.currentTarget.reset();
    await loadMessages();
    setLoaded((current) => ({ ...current, notes: true }));
  }

  if (error) return <main className="centered-state"><Brand /><ErrorState message={error} /></main>;
  if (!event) return <main className="centered-state"><Brand /><LoadingState /></main>;
  if (fullscreen) return <main className="fullscreen">
    <div className="fullscreen__bar"><Brand compact /><Link className="fullscreen__close" to={`/event/${slug}`} aria-label="Close full-screen gallery"><X aria-hidden="true" /></Link></div>
    {gallery.length
      ? <div className="fullscreen__grid">{gallery.map((item) => <figure key={item.id}><img src={mediaPreview(item.id)} alt={item.caption || item.originalFilename} /><figcaption>{item.caption || item.originalFilename}</figcaption></figure>)}</div>
      : <p>No shared photos yet.</p>}
  </main>;

  return <div className="guest-shell guest-shell--drop">
    <main className="guest-drop-main">
      <GuestUploadFlow
        event={event}
        slug={slug}
        onDelivered={() => setTerminal(true)}
      />

      {!terminal && <section className="guest-secondary" aria-labelledby="more-from-event">
        <div className="guest-secondary__heading">
          <p className="section-label">More from the event</p>
          <h2 id="more-from-event">Here when you want it.</h2>
          <p>Photos are delivered privately first. The shared gallery and notes stay out of your way until you choose them.</p>
        </div>

        <details className="event-extra" onToggle={(toggle) => toggleExtra('gallery', toggle.currentTarget.open)}>
          <summary><span>Shared gallery <small>{event.galleryVisible ? loaded.gallery ? `${gallery.length} shared` : 'Available' : 'Not shared yet'}</small></span><ChevronDown aria-hidden="true" /></summary>
          {opened.gallery && <div className="event-extra__content">
            {event.galleryVisible && gallery.length > 0
              ? <><div className="secondary-actions"><Link className="text-link" to={`/event/${slug}/fullscreen`}><Expand aria-hidden="true" /> View full screen</Link></div><div className="photo-grid">{gallery.map((item) => <figure key={item.id}><img loading="lazy" src={mediaPreview(item.id)} alt={item.caption || item.originalFilename} /><figcaption><span>{item.caption || item.originalFilename}</span><small>by {item.guestName}</small></figcaption></figure>)}</div></>
              : <div className="empty-state"><ImagePlus aria-hidden="true" /><h3>{event.galleryVisible ? 'The shared gallery is still quiet.' : 'The host is keeping the gallery private.'}</h3><p>Your delivery still goes straight to the host.</p></div>}
          </div>}
        </details>

        <details className="event-extra" onToggle={(toggle) => toggleExtra('contributions', toggle.currentTarget.open)}>
          <summary><span>My deliveries <small>{loaded.contributions ? `${contributions.filter(({ uploadState }) => uploadState === 'stored').length} received` : 'From this device'}</small></span><ChevronDown aria-hidden="true" /></summary>
          {opened.contributions && <div className="event-extra__content contributions contributions--compact">
            {contributions.length ? <ul>{contributions.map((item) => <li key={item.id}><img src={mediaPreview(item.id)} alt="" /><span>{item.originalFilename}</span><em className={`status status--${item.uploadState === 'stored' ? 'approved' : 'pending'}`}>{item.uploadState === 'stored' ? 'Delivered' : 'Not delivered'}</em></li>)}</ul> : <p>No earlier deliveries from this device.</p>}
          </div>}
        </details>

        <details className="event-extra" onToggle={(toggle) => toggleExtra('notes', toggle.currentTarget.open)}>
          <summary><span>Leave a note <small>Optional</small></span><ChevronDown aria-hidden="true" /></summary>
          {opened.notes && <div className="event-extra__content notes-secondary">
            <div><MessageCircle aria-hidden="true" /><h3>A few words for {event.name}</h3><p>Share a wish or memory whenever you have a moment.</p></div>
            <div><form className="note-form" onSubmit={(formEvent) => void leaveNote(formEvent)}><textarea name="body" rows={3} maxLength={500} required placeholder="Write a note…" /><button className="button button--primary">Leave a note <ArrowRight aria-hidden="true" /></button></form>{messages.length > 0 && <ul className="notes-feed">{messages.map((item) => <li key={item.id}><p>{item.body}</p><small>{item.guestName || 'A guest'}</small></li>)}</ul>}</div>
          </div>}
        </details>
      </section>}
    </main>
    {!terminal && <footer><Brand compact /><p>Private moments, held together.</p></footer>}
  </div>;
}

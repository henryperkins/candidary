import { ArrowRight, ChevronDown, Expand, ImagePlus, MessageCircle, X } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import type { GuestEventView } from '../../shared/contracts';
import { DEFAULT_EVENT_THEME_CONFIG, resolveEventTheme } from '../../shared/event-theme';
import { api, mediaPreview } from '../app/api';
import { eventThemeStyle } from '../app/event-theme-style';
import { readGuestName } from '../app/guest-name-storage';
import type { MediaView, MessageView } from '../app/types';
import { Brand } from '../components/Brand';
import { describeLoadFailure, ErrorState, LoadingState } from '../components/States';
import type { LoadFailure } from '../components/States';
import { GuestBeforeStart } from '../features/guest/GuestBeforeStart';
import { GuestWaiting } from '../features/guest/GuestWaiting';
import type { LifecycleRecheckOutcome } from '../features/guest/useLifecycleRecheck';
import { useLifecycleRecheck } from '../features/guest/useLifecycleRecheck';
import { GuestRsvpFlow } from '../features/rsvp/GuestRsvpFlow';
import { GuestUploadFlow } from '../features/uploads/GuestUploadFlow';

/* `GuestEventView.theme` is required in the contract, but this value arrives over the network: during
   a deploy an older Worker can still answer without one, and the guest would meet a blank error page
   instead of an event. The type cannot police that, so the canonical default stands behind it. This is
   deliberate, not the dead fallback the stylesheet used to carry. */
const DEFAULT_GUEST_THEME = resolveEventTheme(DEFAULT_EVENT_THEME_CONFIG);

function guestLifecycleKey(event: GuestEventView): string {
  return JSON.stringify([
    event.phase,
    event.rsvpState,
    event.rsvpAccess,
    event.eventStartAt,
    event.rsvpDeadlineAt,
    event.eventTimezone,
    event.rsvpDeadlineDate,
    event.lifecycleRecheckAfterMs !== null,
  ]);
}

export function EventPage({ fullscreen = false }: { fullscreen?: boolean }) {
  const { slug = '' } = useParams();
  const [event, setEvent] = useState<GuestEventView | null>(null);
  const [gallery, setGallery] = useState<MediaView[]>([]);
  const [contributions, setContributions] = useState<MediaView[]>([]);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [opened, setOpened] = useState({ gallery: false, contributions: false, notes: false });
  const [loaded, setLoaded] = useState({ gallery: false, contributions: false, notes: false });
  const [failure, setFailure] = useState<LoadFailure | null>(null);
  const [terminal, setTerminal] = useState(false);
  const [rsvpExpanded, setRsvpExpanded] = useState(false);
  // Each load takes the next ticket and only the newest one may install its answer. A slug change, a
  // second Try again press, or an unmount all leave an older load holding a ticket nobody honours.
  const loadTicket = useRef(0);
  // What is on screen, readable from the boundary refetch without re-arming its timer every render.
  const shownEvent = useRef<GuestEventView | null>(null);
  shownEvent.current = event;

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

  // The same request on mount and behind Try again, so a guest whose reception dropped at the venue
  // is one press from the photo drop instead of stranded on a dead end.
  const loadEvent = useCallback(async () => {
    const ticket = (loadTicket.current += 1);
    setFailure(null);
    try {
      const { event: eventView } = await api<{ event: GuestEventView; role: string }>(`/api/event/${slug}`);
      if (loadTicket.current !== ticket) return;
      setEvent(eventView);
      if (fullscreen && eventView.galleryVisible) {
        await loadGallery();
        if (loadTicket.current !== ticket) return;
        setLoaded((current) => ({ ...current, gallery: true }));
      }
    } catch (caught) {
      if (loadTicket.current !== ticket) return;
      setFailure(describeLoadFailure(caught, 'guest', 'This event could not be loaded.'));
    }
  }, [fullscreen, loadGallery, slug]);

  /* The lifecycle boundary refetch. It takes a ticket like every other load, so a slow answer that
     was overtaken cannot install itself, and it deliberately never touches `failure`: a background
     refresh that fails must leave the surface a guest is using alone rather than replace a working
     event with an error. The rejection is left to the hook, which retries with bounded backoff. */
  const recheckEvent = useCallback(async (): Promise<LifecycleRecheckOutcome> => {
    const ticket = (loadTicket.current += 1);
    const { event: next } = await api<{ event: GuestEventView; role: string }>(`/api/event/${slug}`);
    if (loadTicket.current !== ticket) return 'unchanged';
    const shown = shownEvent.current;
    const unchanged = shown && guestLifecycleKey(shown) === guestLifecycleKey(next);
    // Relative delays drift on every read. Installing a semantic no-op would
    // replace the delay-keyed effect and erase the floor it just established.
    if (unchanged) return 'unchanged';
    setEvent(next);
    return 'changed';
  }, [slug]);

  useEffect(() => {
    void loadEvent();
    // An unmount retires the ticket, so a load still in flight cannot install its answer afterwards.
    return () => { loadTicket.current += 1; };
  }, [loadEvent]);

  useLifecycleRecheck(
    event?.lifecycleRecheckAfterMs ?? null,
    recheckEvent,
    event ? guestLifecycleKey(event) : null,
  );

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
    const guestName = readGuestName() || null;
    await api(`/api/event/${slug}/messages`, {
      method: 'POST',
      body: JSON.stringify({ guestName, body: form.get('body') }),
    });
    eventForm.currentTarget.reset();
    await loadMessages();
    setLoaded((current) => ({ ...current, notes: true }));
  }

  if (failure) return <main className="centered-state"><Brand /><ErrorState
    message={failure.message}
    recoveryHint={failure.recoveryHint}
    onRetry={failure.retryable ? () => void loadEvent() : undefined}
  /></main>;
  if (!event) return <main className="centered-state"><Brand /><LoadingState /></main>;
  const themeStyle = eventThemeStyle((event.theme ?? DEFAULT_GUEST_THEME).tokens);
  if (fullscreen) return <main className="fullscreen" style={themeStyle}>
    {/* The full-screen gallery is its own route and had no level-one heading at all, so a screen
        reader arrived with nothing naming the view. The name belongs to the page, not to the layout,
        so it is announced rather than drawn — the bar's approved copy is unchanged. */}
    <h1 className="sr-only">Shared gallery · {event.name}</h1>
    <div className="fullscreen__bar"><Brand compact /><Link className="fullscreen__close" to={`/event/${slug}`} aria-label="Close full-screen gallery"><X aria-hidden="true" /></Link></div>
    {gallery.length
      ? <div className="fullscreen__grid">{gallery.map((item) => <figure key={item.id}><img src={mediaPreview(item.id)} alt={item.caption || item.originalFilename} /><figcaption>{item.caption || item.originalFilename}</figcaption></figure>)}</div>
      : <p>No shared photos yet.</p>}
  </main>;

  return <div className="guest-shell guest-shell--drop" style={themeStyle}>
    <main className="guest-drop-main">
      {event.phase === 'rsvp-primary' && <GuestRsvpFlow
        event={event}
        presentation="primary"
      />}

      {event.phase === 'before-start' && <GuestBeforeStart event={event} />}

      {event.phase === 'photos-primary' && <GuestUploadFlow
        event={event}
        slug={slug}
        onDelivered={() => setTerminal(true)}
      />}

      {event.phase === 'waiting' && <GuestWaiting event={event} />}

      {!terminal && event.phase === 'photos-primary' && <section className="guest-secondary" aria-labelledby="more-from-event">
        <div className="guest-secondary__heading">
          <p className="section-label">More from the event</p>
          <h2 id="more-from-event">Here when you want it.</h2>
          <p>Photos are delivered privately first. The shared gallery and notes stay out of your way until you choose them.</p>
        </div>

        {/* Photos can open before the event does, so the household disclosure survives into that
            early window and disappears at the start. The server says which it is — a date the
            browser compared itself would be a guest device's clock deciding a boundary. */}
        {(event.rsvpAccess === 'editable' || event.rsvpAccess === 'read-only') && <details
          className="event-extra"
          onToggle={(toggle) => setRsvpExpanded(toggle.currentTarget.open)}
        >
          <summary>
            <span>{event.rsvpState === 'open' ? 'View or change RSVP' : 'View RSVP'} <small>Household response</small></span>
            <ChevronDown aria-hidden="true" />
          </summary>
          {rsvpExpanded && <div className="event-extra__content guest-secondary">
            <GuestRsvpFlow event={event} presentation="secondary" />
          </div>}
        </details>}

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
            {/* The name belongs to the field, not to the placeholder that vanishes on the first keystroke. */}
            {/* The button is held for the round trip so the guest cannot answer silence with a second
                press, and a refusal is announced rather than swallowed. */}
            <div><form className="note-form" onSubmit={(formEvent) => void leaveNote(formEvent)}><label><span className="sr-only">Note for {event.name}</span><textarea name="body" rows={3} maxLength={500} required placeholder="Write a note…" /></label><button className="button button--primary">Leave a note <ArrowRight aria-hidden="true" /></button></form>{messages.length > 0 && <ul className="notes-feed">{messages.map((item) => <li key={item.id}><p>{item.body}</p><small>{item.guestName || 'A guest'}</small></li>)}</ul>}</div>
          </div>}
        </details>
      </section>}
    </main>
    {!terminal && <footer><Brand compact /><p>Private moments, held together.</p></footer>}
  </div>;
}

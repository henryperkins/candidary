import { ArrowRight, ChevronDown, Expand, ImagePlus, MessageCircle, X } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import type { GuestEventView } from '../../shared/contracts';
import { DEFAULT_EVENT_THEME_CONFIG, resolveEventTheme } from '../../shared/event-theme';
import { api, ClientApiError, mediaPreview } from '../app/api';
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

type NotesReadStatus = 'idle' | 'loading' | 'content' | 'empty' | 'retryable_error';
type NoteSubmitStatus = 'idle' | 'sending' | 'confirmed_success' | 'retryable_error' | 'invalid';

interface GuestMessagesPage {
  items: MessageView[];
  nextCursor: string | null;
}

interface GuestMessageSubmission {
  message: MessageView;
}

function mergeMessages(...pages: MessageView[][]): MessageView[] {
  const byId = new Map<string, MessageView>();
  for (const page of pages) {
    for (const message of page) byId.set(message.id, message);
  }
  return [...byId.values()].sort((left, right) => (
    left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
  ));
}

function messageStatus(message: MessageView): { label: string; visibility: string | null } {
  if (message.moderationStatus === 'approved') {
    return { label: 'Shared with guests', visibility: null };
  }
  if (message.moderationStatus === 'pending') {
    return {
      label: 'Awaiting host review',
      visibility: 'Only you can see this until the host shares it.',
    };
  }
  return { label: 'Kept private', visibility: 'Only you can see this.' };
}

function remainingCharacters(count: number): string {
  return count === 1 ? '1 character left' : `${count} characters left`;
}

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
  const [loaded, setLoaded] = useState({ gallery: false, contributions: false });
  const [failure, setFailure] = useState<LoadFailure | null>(null);
  const [terminal, setTerminal] = useState(false);
  const [rsvpExpanded, setRsvpExpanded] = useState(false);
  const [notesStatus, setNotesStatus] = useState<NotesReadStatus>('idle');
  const [notesError, setNotesError] = useState<string | null>(null);
  const [notesNextCursor, setNotesNextCursor] = useState<string | null>(null);
  const [notesLoadingEarlier, setNotesLoadingEarlier] = useState(false);
  const [notesEarlierError, setNotesEarlierError] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [noteSubmitStatus, setNoteSubmitStatus] = useState<NoteSubmitStatus>('idle');
  const [noteSubmitMessage, setNoteSubmitMessage] = useState<string | null>(null);
  const [noteSubmissionKey, setNoteSubmissionKey] = useState(() => crypto.randomUUID());
  const noteInput = useRef<HTMLTextAreaElement>(null);
  const notesLoadTicket = useRef(0);
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
  const loadMessages = useCallback(async (cursor?: string) => {
    const ticket = (notesLoadTicket.current += 1);
    if (cursor) {
      setNotesLoadingEarlier(true);
      setNotesEarlierError(null);
    } else {
      setNotesStatus('loading');
      setNotesError(null);
    }
    try {
      const path = cursor
        ? `/api/event/${slug}/messages?cursor=${encodeURIComponent(cursor)}`
        : `/api/event/${slug}/messages`;
      const result = await api<GuestMessagesPage>(path);
      if (notesLoadTicket.current !== ticket) return;
      setMessages((current) => cursor ? mergeMessages(result.items, current) : result.items);
      setNotesNextCursor(result.nextCursor ?? null);
      if (!cursor) setNotesStatus(result.items.length > 0 ? 'content' : 'empty');
    } catch (caught) {
      if (notesLoadTicket.current !== ticket) return;
      const message = caught instanceof ClientApiError
        ? caught.message
        : 'Guest notes could not be loaded. Check your connection and try again.';
      if (cursor) setNotesEarlierError(message);
      else {
        setNotesError(message);
        setNotesStatus('retryable_error');
      }
    } finally {
      if (cursor && notesLoadTicket.current === ticket) setNotesLoadingEarlier(false);
    }
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
    if (kind === 'notes') {
      if (isOpen && notesStatus === 'idle') void loadMessages();
      return;
    }
    if (!isOpen || loaded[kind]) return;
    if (kind === 'gallery' && !event?.galleryVisible) {
      setLoaded((current) => ({ ...current, gallery: true }));
      return;
    }
    setLoaded((current) => ({ ...current, [kind]: true }));
    const request = kind === 'gallery' ? loadGallery() : loadContributions();
    void request.catch(() => setLoaded((current) => ({ ...current, [kind]: false })));
  }

  async function leaveNote(eventForm: FormEvent<HTMLFormElement>) {
    eventForm.preventDefault();
    if (noteSubmitStatus === 'sending') return;
    const body = noteDraft.trim();
    if (!body) {
      setNoteSubmitStatus('invalid');
      setNoteSubmitMessage('Write a note before sending it.');
      noteInput.current?.focus();
      return;
    }
    const guestName = readGuestName() || null;
    setNoteSubmitStatus('sending');
    setNoteSubmitMessage(null);
    try {
      const result = await api<GuestMessageSubmission>(`/api/event/${slug}/messages`, {
        method: 'POST',
        body: JSON.stringify({ idempotencyKey: noteSubmissionKey, guestName, body }),
      });
      notesLoadTicket.current += 1;
      const message = { ...result.message, kind: 'message' as const, mediaId: null };
      setMessages((current) => mergeMessages(current, [message]));
      setNotesStatus('content');
      setNotesError(null);
      setNotesLoadingEarlier(false);
      setNotesEarlierError(null);
      setNoteDraft('');
      setNoteSubmissionKey(crypto.randomUUID());
      setNoteSubmitStatus('confirmed_success');
      setNoteSubmitMessage(message.moderationStatus === 'approved'
        ? 'Your note is now visible to the host and other guests.'
        : 'Your note was sent to the host for review. Only you can see it here for now.');
    } catch (caught) {
      if (caught instanceof ClientApiError && caught.code === 'MESSAGE_SUBMISSION_CONFLICT') {
        setNoteSubmissionKey(crypto.randomUUID());
      }
      setNoteSubmitStatus('retryable_error');
      setNoteSubmitMessage(caught instanceof ClientApiError
        ? caught.message
        : 'Your note was not sent. Check your connection and try again.');
    }
  }

  function updateNoteDraft(value: string) {
    if (noteSubmitStatus === 'retryable_error') setNoteSubmissionKey(crypto.randomUUID());
    setNoteDraft(value);
    setNoteSubmitStatus('idle');
    setNoteSubmitMessage(null);
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
          <summary><span>Guest notes <small>Read or add yours</small></span><ChevronDown aria-hidden="true" /></summary>
          {opened.notes && <div className="event-extra__content notes-secondary">
            <div className="notes-secondary__intro">
              <MessageCircle aria-hidden="true" />
              <h3>Leave a note for <bdi>{event.name}</bdi></h3>
              <p>Share a wish, memory, or moment from the day.</p>
              <p className="notes-secondary__privacy">{event.moderationRequired
                ? 'The host reviews notes before other guests can see them.'
                : 'Your note will appear here for the host and other guests.'}</p>
            </div>
            <div className="notes-secondary__workspace">
              <form className="note-form" onSubmit={(formEvent) => void leaveNote(formEvent)} aria-busy={noteSubmitStatus === 'sending'}>
                <label>
                  <span className="note-form__label">Your note for <bdi>{event.name}</bdi></span>
                  <textarea
                    ref={noteInput}
                    name="body"
                    rows={3}
                    maxLength={500}
                    required
                    dir="auto"
                    readOnly={noteSubmitStatus === 'sending'}
                    value={noteDraft}
                    aria-invalid={noteSubmitStatus === 'invalid'}
                    aria-describedby="note-help note-submit-feedback"
                    placeholder="Share a wish or memory…"
                    onChange={(change) => updateNoteDraft(change.currentTarget.value)}
                  />
                </label>
                <div className="note-form__footer">
                  <small id="note-help">{remainingCharacters(500 - noteDraft.length)}</small>
                  <button type="submit" className="button button--primary" disabled={noteSubmitStatus === 'sending'}>
                    {noteSubmitStatus === 'sending'
                      ? 'Sending note…'
                      : noteSubmitStatus === 'retryable_error'
                        ? 'Send note again'
                        : 'Send note'} <ArrowRight aria-hidden="true" />
                  </button>
                </div>
              </form>
              <div id="note-submit-feedback" className="note-submit-feedback" aria-atomic="true">
                {noteSubmitStatus === 'confirmed_success' && <p role="status">{noteSubmitMessage}</p>}
                {(noteSubmitStatus === 'retryable_error' || noteSubmitStatus === 'invalid')
                  && <p className="note-submit-feedback__error" role="alert">{noteSubmitMessage}</p>}
              </div>

              <section className="notes-feed-region" aria-labelledby="notes-feed-title">
                <h4 id="notes-feed-title">Guest notes and photo captions</h4>
                {notesStatus === 'loading' && <p className="notes-feed__state" role="status">
                  {messages.length > 0 ? 'Refreshing guest notes…' : 'Loading guest notes…'}
                </p>}
                {notesStatus === 'retryable_error' && <div className="notes-feed__recovery">
                  <p role="alert">{notesError}</p>
                  <button type="button" className="button button--secondary" onClick={() => void loadMessages()}>
                    Try again
                  </button>
                </div>}
                {notesStatus === 'empty'
                  && <p className="notes-feed__state" role="status">No notes or photo captions have been shared yet.</p>}
                {messages.length > 0 && <ul className="notes-feed">{messages.map((item) => {
                  const status = messageStatus(item);
                  const kind = item.kind === 'caption' ? 'Photo caption' : 'Note';
                  return <li key={item.id}>
                    <div className="notes-feed__entry">
                      {item.kind === 'caption' && item.mediaId
                        && <img
                          className="notes-feed__thumbnail"
                          loading="lazy"
                          width="58"
                          height="58"
                          src={mediaPreview(item.mediaId)}
                          alt=""
                        />}
                      <div className="notes-feed__body">
                        <p dir="auto">{item.body}</p>
                        <div className="notes-feed__meta">
                          <small><bdi>{item.guestName || 'A guest'}</bdi> · {kind}</small>
                          <span className={`status status--${item.moderationStatus}`}>{status.label}</span>
                        </div>
                        {status.visibility && <small className="notes-feed__visibility">{status.visibility}</small>}
                      </div>
                    </div>
                  </li>;
                })}</ul>}
                {notesNextCursor && <div className="notes-feed__more">
                  <button
                    type="button"
                    className="button button--secondary"
                    disabled={notesLoadingEarlier}
                    onClick={() => void loadMessages(notesNextCursor)}
                  >
                    {notesLoadingEarlier ? 'Loading earlier notes and captions…' : 'Show earlier notes and captions'}
                  </button>
                  {notesEarlierError && <p role="alert">{notesEarlierError}</p>}
                </div>}
              </section>
            </div>
          </div>}
        </details>
      </section>}
    </main>
    {!terminal && <footer><Brand compact /><p>Private moments, held together.</p></footer>}
  </div>;
}

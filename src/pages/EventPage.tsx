import { ChevronDown, Expand, ImagePlus, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import type { GuestEventView } from '../../shared/contracts';
import { DEFAULT_EVENT_THEME_CONFIG, resolveEventTheme } from '../../shared/event-theme';
import { GUEST_READ_SURFACES_UNAVAILABLE_MESSAGE } from '../../shared/rsvp';
import { api, mediaPreview } from '../app/api';
import { eventThemeStyle } from '../app/event-theme-style';
import { readGuestName, rememberGuestName } from '../app/guest-name-storage';
import type { GuestContributionMediaView, GuestGalleryMediaView } from '../app/types';
import { Brand } from '../components/Brand';
import { describeLoadFailure, ErrorState, LoadingState } from '../components/States';
import type { LoadFailure } from '../components/States';
import { GuestBeforeStart } from '../features/guest/GuestBeforeStart';
import { GuestEventRefreshProvider } from '../features/guest/GuestEventRefreshContext';
import { GuestWaiting } from '../features/guest/GuestWaiting';
import type { LifecycleRecheckOutcome } from '../features/guest/useLifecycleRecheck';
import { useLifecycleRecheck } from '../features/guest/useLifecycleRecheck';
import { Guestbook } from '../features/guestbook/Guestbook';
import { GuestRsvpFlow } from '../features/rsvp/GuestRsvpFlow';
import { GuestUploadFlow, type GuestUploadEvent } from '../features/uploads/GuestUploadFlow';
import type { UploadTransport } from '../features/uploads/upload-queue';
import { useGuestUploadSession } from '../features/uploads/use-guest-upload-session';

/* `GuestEventView.theme` is required in the contract, but this value arrives over the network: during
   a deploy an older Worker can still answer without one, and the guest would meet a blank error page
   instead of an event. The type cannot police that, so the canonical default stands behind it. This is
   deliberate, not the dead fallback the stylesheet used to carry. */
const DEFAULT_GUEST_THEME = resolveEventTheme(DEFAULT_EVENT_THEME_CONFIG);

/* What a shared photo is called when its uploader wrote no caption. The gallery used to fall back to
   the original filename, which is the uploader's device talking — `IMG_4471.HEIC`, or a name they
   never meant to publish — and it was read aloud to every other guest as the image's alternative
   text. The photograph is what is being shared; the filename never was. */
const SHARED_PHOTO_LABEL = 'Shared photo';

function guestLifecycleKey(event: GuestEventView): string {
  return JSON.stringify([
    event.phase,
    event.rsvpState,
    event.rsvpAccess,
    event.guestReadSurfaces.available,
    event.guestReadSurfaces.reason,
    event.eventStartAt,
    event.rsvpDeadlineAt,
    event.eventTimezone,
    event.rsvpDeadlineDate,
    event.lifecycleRecheckAfterMs !== null,
    event.cover.revision,
    event.cover.hasCover,
    event.cover.available2xProfiles,
    event.cover.surfaceTreatment,
  ]);
}

export function GuestPhotoUpload({
  event,
  slug,
  guestName,
  onGuestNameChange,
  onDelivered,
  onLeaveGuestbook,
  transport,
}: {
  event: GuestUploadEvent;
  slug: string;
  guestName: string;
  onGuestNameChange(name: string): void;
  onDelivered?(count: number): void;
  onLeaveGuestbook(): void;
  transport?: UploadTransport;
}) {
  const session = useGuestUploadSession({
    slug,
    guestName,
    uploadsAvailable: event.uploadsEnabled,
    transport,
    onDelivered,
  });
  return <GuestUploadFlow
    event={event}
    slug={slug}
    session={session}
    uploadsAvailable={event.uploadsEnabled}
    unavailableMessage="The host has paused new guest uploads for now."
    guestName={guestName}
    onGuestNameChange={onGuestNameChange}
    onLeaveGuestbook={onLeaveGuestbook}
  />;
}

export function EventPage({ fullscreen = false }: { fullscreen?: boolean }) {
  const { slug = '' } = useParams();
  const [event, setEvent] = useState<GuestEventView | null>(null);
  const [gallery, setGallery] = useState<GuestGalleryMediaView[]>([]);
  const [contributions, setContributions] = useState<GuestContributionMediaView[]>([]);
  const [opened, setOpened] = useState({ gallery: false, contributions: false });
  const [loaded, setLoaded] = useState({ gallery: false, contributions: false });
  const [failure, setFailure] = useState<LoadFailure | null>(null);
  const [terminal, setTerminal] = useState(false);
  const [rsvpExpanded, setRsvpExpanded] = useState(false);
  const [rememberedGuestName, setRememberedGuestName] = useState(readGuestName);
  const [guestbookOpenRequest, setGuestbookOpenRequest] = useState(0);
  const markUploadDelivered = useCallback(() => setTerminal(true), []);
  // Each load takes the next ticket and only the newest one may install its answer. A slug change, a
  // second Try again press, or an unmount all leave an older load holding a ticket nobody honours.
  const loadTicket = useRef(0);
  // What is on screen, readable from the boundary refetch without re-arming its timer every render.
  const shownEvent = useRef<GuestEventView | null>(null);
  shownEvent.current = event;

  const loadGallery = useCallback(async () => {
    const result = await api<{ media: GuestGalleryMediaView[] }>(`/api/event/${slug}/gallery`);
    setGallery(result.media);
  }, [slug]);
  const loadContributions = useCallback(async () => {
    const result = await api<{ media: GuestContributionMediaView[] }>(`/api/event/${slug}/contributions`);
    setContributions(result.media);
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
      if (fullscreen && eventView.guestReadSurfaces.available && eventView.galleryVisible) {
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
    const request = kind === 'gallery' ? loadGallery() : loadContributions();
    void request.catch(() => setLoaded((current) => ({ ...current, [kind]: false })));
  }

  const updateRememberedGuestName = useCallback((name: string) => {
    setRememberedGuestName(name);
    rememberGuestName(name);
  }, []);

  function openGuestbookFromReceipt() {
    setGuestbookOpenRequest((current) => current + 1);
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
    {!event.guestReadSurfaces.available
      ? <p>{GUEST_READ_SURFACES_UNAVAILABLE_MESSAGE}</p>
      : !event.galleryVisible
        ? <p>The host is keeping the gallery private.</p>
        : gallery.length
          ? <div className="fullscreen__grid">{gallery.map((item) => <figure key={item.id}><img src={mediaPreview(item.id)} alt={item.caption || SHARED_PHOTO_LABEL} /><figcaption>{item.caption || SHARED_PHOTO_LABEL}</figcaption></figure>)}</div>
          : <p>No shared photos yet.</p>}
  </main>;

  return <GuestEventRefreshProvider refreshEvent={recheckEvent}>
    <div className="guest-shell guest-shell--drop" style={themeStyle}>
    <main className="guest-drop-main">
      {event.phase === 'rsvp-primary' && <GuestRsvpFlow
        event={event}
        presentation="primary"
        guestName={rememberedGuestName}
        onGuestNameChange={updateRememberedGuestName}
      />}

      {event.phase === 'before-start' && <GuestBeforeStart
        event={event}
        guestName={rememberedGuestName}
        onGuestNameChange={updateRememberedGuestName}
      />}

      {(event.phase === 'photos-primary' || (terminal && event.phase === 'waiting')) && <GuestPhotoUpload
        event={event}
        slug={slug}
        guestName={rememberedGuestName}
        onGuestNameChange={updateRememberedGuestName}
        onDelivered={markUploadDelivered}
        onLeaveGuestbook={openGuestbookFromReceipt}
      />}

      {event.phase === 'waiting' && !terminal && <GuestWaiting event={event} />}

      {event.guestReadSurfaces.available && <section
        className={`guest-secondary${terminal ? ' guest-secondary--guestbook-only' : ''}`}
        aria-labelledby={terminal ? 'terminal-more-from-event' : 'more-from-event'}
      >
        {terminal && <h2 id="terminal-more-from-event" className="sr-only">More from the event</h2>}
        {!terminal && <div className="guest-secondary__heading">
          <p className="section-label">More from the event</p>
          <h2 id="more-from-event">Here when you want it.</h2>
          <p>Photos are delivered privately first. The shared gallery and Guestbook stay out of your way until you choose them.</p>
        </div>}

        <Guestbook
          key={event.id}
          event={event}
          contributionEnabled
          guestName={rememberedGuestName}
          onGuestNameChange={updateRememberedGuestName}
          openRequest={guestbookOpenRequest}
        />

        {/* Photos can open before the event does, so the household disclosure survives into that
            early window and disappears at the start. The server says which it is — a date the
            browser compared itself would be a guest device's clock deciding a boundary. */}
        {!terminal && event.phase === 'photos-primary'
          && (event.rsvpAccess === 'editable' || event.rsvpAccess === 'read-only') && <details
          className="event-extra"
          onToggle={(toggle) => setRsvpExpanded(toggle.currentTarget.open)}
        >
          <summary>
            <span>{event.rsvpState === 'open' ? 'View or change RSVP' : 'View RSVP'} <small>Household response</small></span>
            <ChevronDown aria-hidden="true" />
          </summary>
          {rsvpExpanded && <div className="event-extra__content guest-secondary">
            <GuestRsvpFlow
              event={event}
              presentation="secondary"
              guestName={rememberedGuestName}
              onGuestNameChange={updateRememberedGuestName}
            />
          </div>}
        </details>}

        <details className="event-extra" onToggle={(toggle) => toggleExtra('gallery', toggle.currentTarget.open)}>
          <summary><span>Shared gallery <small>{event.galleryVisible ? loaded.gallery ? `${gallery.length} shared` : 'Available' : 'Not shared yet'}</small></span><ChevronDown aria-hidden="true" /></summary>
          {opened.gallery && <div className="event-extra__content">
            {event.galleryVisible && gallery.length > 0
              ? <><div className="secondary-actions"><Link className="text-link" to={`/event/${slug}/fullscreen`}><Expand aria-hidden="true" /> View full screen</Link></div><div className="photo-grid">{gallery.map((item) => <figure key={item.id}><img loading="lazy" src={mediaPreview(item.id)} alt={item.caption || SHARED_PHOTO_LABEL} /><figcaption><span>{item.caption || SHARED_PHOTO_LABEL}</span><small>by {item.guestName}</small></figcaption></figure>)}</div></>
              : <div className="empty-state"><ImagePlus aria-hidden="true" /><h3>{event.galleryVisible ? 'The shared gallery is still quiet.' : 'The host is keeping the gallery private.'}</h3><p>Your delivery still goes straight to the host.</p></div>}
          </div>}
        </details>

        <details className="event-extra" onToggle={(toggle) => toggleExtra('contributions', toggle.currentTarget.open)}>
          <summary><span>My deliveries <small>{loaded.contributions ? `${contributions.filter(({ uploadState }) => uploadState === 'stored').length} received` : 'From this device'}</small></span><ChevronDown aria-hidden="true" /></summary>
          {opened.contributions && <div className="event-extra__content contributions contributions--compact">
            {contributions.length ? <ul>{contributions.map((item) => <li key={item.id}><img src={mediaPreview(item.id)} alt="" /><span>{item.originalFilename}</span><em className={`status status--${item.uploadState === 'stored' ? 'approved' : 'pending'}`}>{item.uploadState === 'stored' ? 'Delivered' : 'Not delivered'}</em></li>)}</ul> : <p>No earlier deliveries from this device.</p>}
          </div>}
        </details>
      </section>}
    </main>
    {!terminal && <footer><Brand compact /><p>Private moments, held together.</p></footer>}
    </div>
  </GuestEventRefreshProvider>;
}

import { Check, ImagePlus, LockKeyhole, QrCode } from 'lucide-react';
import QRCode from 'qrcode';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { api, ClientApiError } from '../app/api';
import {
  COVER_UPLOAD_MIME_TYPES,
  MAX_COVER_UPLOAD_BYTES,
} from '../../shared/constants';
import { CREATE_INTRO } from '../../shared/site-content';
import type { EventThemePresetId } from '../../shared/contracts';
import { EVENT_THEME_VERSION } from '../../shared/event-theme';
import { PageHeader } from '../components/Brand';
import { CopyableLinkCard } from '../components/CopyableLinkCard';
import { EventThemePresetSelector } from '../components/EventThemePresetSelector';
import { HostAccountPanel } from '../components/HostAccountPanel';
import { hostRegisterHref } from '../app/recovery';
import { detectedTimeZone, knownTimeZones } from '../app/time-zones';
import {
  CoverUploadRejected,
  publishCoverUpload,
  validateCoverFile,
} from '../features/cover/cover-draft-client';

// Both cover controls read the server's own list and ceiling. Neither restates
// them, and neither can drift from the route that enforces them.
const COVER_ACCEPT = COVER_UPLOAD_MIME_TYPES.join(',');
const COVER_MAX_MB = Math.floor(MAX_COVER_UPLOAD_BYTES / 1_000_000);

interface Created {
  // `eventStartAt` is the instant the Worker resolved from the date, the local
  // start time, and the zone. The receipt reads it back rather than leaving a
  // defaulted midnight as something the host never saw.
  event: {
    id: string;
    name: string;
    slug: string;
    eventDate: string;
    eventStartAt: string;
    eventStartTime: string;
    eventTimezone: string;
  };
  // The permanent printed credential. It never changes for the life of the
  // event, which is what lets a host print it on invitations and signs.
  eventLink: string;
  managementLink: string;
  csrfToken: string;
  // Committed server-side when a signed-in host created the event, so the success
  // screen never has to guess whether the event is already recoverable.
  savedToAccount?: boolean;
}

// Form order, not response order: the host should be taken to the first problem they would reach anyway.
const CREATE_FIELDS = [
  'name',
  'eventDate',
  'eventStartTime',
  'eventTimezone',
  'rsvpDeadlineDate',
  'welcomeMessage',
] as const;

// Always the event's own zone, never this device's: a host in another zone must
// read back the start they actually chose, not the one their laptop would show.
function formatEventStart(instant: string, timeZone: string): string {
  const at = new Date(instant);
  const date = new Intl.DateTimeFormat('en-US', {
    month: 'long', day: 'numeric', year: 'numeric', timeZone,
  }).format(at);
  const time = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone,
  }).format(at);
  return `${date} at ${time}`;
}

export function CreatePage() {
  const navigate = useNavigate();
  const [created, setCreated] = useState<Created | null>(null);
  const [saved, setSaved] = useState(false);
  const [cover, setCover] = useState<File | null>(null);
  const [coverError, setCoverError] = useState('');
  const [themePresetId, setThemePresetId] = useState<EventThemePresetId>('candidary-default');
  const [timeZone, setTimeZone] = useState(detectedTimeZone);
  const [zoneOptions] = useState(knownTimeZones);
  const [qr, setQr] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const formRef = useRef<HTMLFormElement>(null);

  function focusFirstInvalid(fieldErrors: Record<string, string>) {
    const firstName = CREATE_FIELDS.find((name) => fieldErrors[name]);
    if (!firstName) return;
    // Wait for the errors to paint so focus lands on a control that already announces its description.
    requestAnimationFrame(() => {
      const control = formRef.current?.elements.namedItem(firstName);
      if (control instanceof HTMLElement) control.focus();
    });
  }

  useEffect(() => { if (created) void QRCode.toDataURL(created.eventLink, { width: 260, margin: 2, color: { dark: '#4a2415', light: '#fffaf3' } }).then(setQr); }, [created]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); setFields({});
    const data = new FormData(event.currentTarget);
    try {
      const result = await api<Created>('/api/events', { method: 'POST', body: JSON.stringify({
        name: data.get('name'), eventDate: data.get('eventDate'), welcomeMessage: data.get('welcomeMessage'),
        eventStartTime: data.get('eventStartTime'), eventTimezone: data.get('eventTimezone'),
        rsvpDeadlineDate: data.get('rsvpDeadlineDate'),
        theme: { version: EVENT_THEME_VERSION, presetId: themePresetId, overrides: {} },
      }) });
      setCreated(result);
      setSaved(result.savedToAccount === true);
      if (cover) {
        try {
          // CreatePage deliberately keeps the thin automatic wrapper: unlike
          // Manager Studio it has no editable draft session. The wrapper still
          // performs the same replay-safe primitives in order, publishes the
          // faithful style once, and starts at the new event's revision 0.
          await publishCoverUpload({ eventId: result.event.id, file: cover, expectedRevision: 0 });
        } catch { setCoverError('Your event was created, but the cover did not finish uploading. Add it again from event settings.'); }
      }
    } catch (caught) {
      if (caught instanceof ClientApiError) {
        const fieldErrors = caught.fieldErrors ?? {};
        setError(caught.message); setFields(fieldErrors); focusFirstInvalid(fieldErrors);
      }
      else setError('The event could not be created. Try again.');
    } finally { setBusy(false); }
  }

  if (created) return <div className="public-shell"><PageHeader /><main className="success-layout">
    <section className="success-copy"><span className="success-icon"><Check aria-hidden="true" /></span><h1>Your event is ready.</h1><p>Save the management link somewhere safe, then share the event link when you’re ready.</p><p className="form-note">You can save this event to an account until its management deadline, or 12 hours after it was created — whichever comes first.</p>{coverError && <p className="form-error" role="alert">{coverError}</p>}
      {/* The warning is only true while the link is the sole way in. Once the event
          is saved to an account it stops being true, and leaving it up would talk a
          host out of the recovery they just set up. */}
      <div className="warning"><LockKeyhole aria-hidden="true" /><p><strong>Keep your management link private.</strong><br />{saved ? 'Anyone who has it can manage this event.' : 'Without an account, it cannot be recovered.'}</p></div>
      {/* The schedule the Worker resolved, said out loud in the event's own zone.
          A defaulted midnight is a choice the host made rather than an
          assumption they never saw. */}
      <p className="form-note">{created.event.name} begins {formatEventStart(created.event.eventStartAt, created.event.eventTimezone)} ({created.event.eventTimezone}).</p>
      <p className="form-note">RSVP is paused until you add and validate the guest list. Photo delivery opens by itself when the event starts.</p>
      <CopyableLinkCard label="Event link" value={created.eventLink} /><CopyableLinkCard label="Management link" value={created.managementLink} />
      <div className="button-row">
        <Link className="button button--primary" to={`/manage/event/${created.event.id}`}>Open event manager</Link>
        {/* The event is paused on purpose, so the receipt names the step that
            actually unpauses it rather than leaving the host to find it. */}
        <Link className="button button--secondary" to={`/manage/event/${created.event.id}?section=rsvp`}>Set up guest list</Link>
      </div>
    </section>
    <aside className="qr-card"><QrCode aria-hidden="true" /><h2>Event QR code</h2><p>The same code handles RSVPs now and event photos later. Print it once.</p>{qr && <img src={qr} alt="QR code for the event link" />}<a className="button button--secondary" href={qr} download={`${created.event.slug}-qr.png`}>Download QR code</a></aside>
    {/* Mounted on whether creation already attached the event, not on `saved`.
        Keying it to `saved` would unmount the panel the moment completion
        succeeded, so the host would click Confirm and watch it disappear instead
        of being told their address was confirmed. */}
    {!created.savedToAccount && <HostAccountPanel
      bindEventId={created.event.id}
      onCompleted={({ boundEvent }) => { if (boundEvent) setSaved(true); }}
      onStarted={() => navigate(hostRegisterHref(created.event.id, `/manage/event/${created.event.id}`, true))}
    />}
  </main></div>;

  return <div className="public-shell"><PageHeader action={<Link className="text-link" to="/">Back home</Link>} /><main className="create-layout">
    <section className="create-intro"><p className="section-label">{CREATE_INTRO.label}</p><h1>{CREATE_INTRO.title}</h1><p>{CREATE_INTRO.lede}</p>
      <ul className="trust-list">{CREATE_INTRO.facts.map((fact) => <li key={fact}><Check aria-hidden="true" /> {fact}</li>)}</ul>
    </section>
    <form className="create-form" ref={formRef} onSubmit={submit} noValidate>
      <h2>Event details</h2>{error && <p className="form-error" role="alert">{error}</p>}
      {/* The error sits outside the label: a name identifies the field, an error describes it. */}
      <div className="create-field"><label>Event name<input name="name" maxLength={80} required aria-invalid={Boolean(fields.name)} aria-describedby={fields.name ? 'name-error' : undefined} /></label>{fields.name && <small id="name-error">{fields.name}</small>}</div>
      <div className="create-field"><label>Event date<input name="eventDate" type="date" required aria-invalid={Boolean(fields.eventDate)} aria-describedby={fields.eventDate ? 'eventDate-error' : undefined} /></label>{fields.eventDate && <small id="eventDate-error">{fields.eventDate}</small>}</div>
      {/* Prefilled to midnight so a start time is not a new completion hurdle, and
          visible so it never becomes an invisible server assumption. */}
      <div className="create-field"><label>Event start time<input name="eventStartTime" type="time" defaultValue="00:00" required aria-invalid={Boolean(fields.eventStartTime)} aria-describedby={fields.eventStartTime ? 'eventStartTime-error' : undefined} /></label>{fields.eventStartTime && <small id="eventStartTime-error">{fields.eventStartTime}</small>}</div>
      <div className="create-field"><label>Event time zone<input name="eventTimezone" list="event-time-zones" value={timeZone} onChange={(changed) => setTimeZone(changed.target.value)} required autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-invalid={Boolean(fields.eventTimezone)} aria-describedby={fields.eventTimezone ? 'eventTimezone-error' : 'eventTimezone-hint'} /></label><small id="eventTimezone-hint">RSVP deadlines close at the end of this day, in this zone.</small>{fields.eventTimezone && <small id="eventTimezone-error">{fields.eventTimezone}</small>}{zoneOptions.length > 0 && <datalist id="event-time-zones">{zoneOptions.map((zone) => <option key={zone} value={zone} />)}</datalist>}</div>
      <div className="create-field"><label>RSVP deadline<input name="rsvpDeadlineDate" type="date" required aria-invalid={Boolean(fields.rsvpDeadlineDate)} aria-describedby={fields.rsvpDeadlineDate ? 'rsvpDeadlineDate-error' : undefined} /></label>{fields.rsvpDeadlineDate && <small id="rsvpDeadlineDate-error">{fields.rsvpDeadlineDate}</small>}</div>
      <div className="create-field"><label>Welcome message<textarea name="welcomeMessage" rows={4} maxLength={500} required placeholder="Tell guests what you’d love them to share." aria-invalid={Boolean(fields.welcomeMessage)} aria-describedby={fields.welcomeMessage ? 'welcomeMessage-error' : undefined} /></label>{fields.welcomeMessage && <small id="welcomeMessage-error">{fields.welcomeMessage}</small>}</div>
      <EventThemePresetSelector name="themePreset" value={themePresetId} onChange={setThemePresetId} disabled={busy} />
      <label className="cover-field"><ImagePlus aria-hidden="true" /><div><strong>Cover photo</strong><p>{cover ? cover.name : `Optional · JPEG, PNG, WebP, or HEIC · ${COVER_MAX_MB} MB max`}</p></div><span className="button button--secondary">{cover ? 'Change' : 'Choose photo'}</span><input className="sr-only cover-field__input" type="file" accept={COVER_ACCEPT} onChange={(event) => { const file = event.target.files?.[0] ?? null; if (!file) { setCover(null); return; } try { validateCoverFile(file); setCover(file); } catch (rejected) { setCover(null); setError(rejected instanceof CoverUploadRejected ? rejected.message : 'That photo could not be used as a cover.'); } }} /></label>
      <button className="button button--primary button--wide" disabled={busy}>{busy ? 'Creating your event…' : 'Create private event'}</button>
      <p className="form-note"><LockKeyhole aria-hidden="true" /> Your links act as the keys to this private event.</p>
    </form>
  </main></div>;
}

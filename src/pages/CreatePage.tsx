import { Check, ImagePlus, LockKeyhole, QrCode } from 'lucide-react';
import QRCode from 'qrcode';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { api, ClientApiError } from '../app/api';
import { MAX_EVENT_MEDIA } from '../../shared/constants';
import type { EventThemePresetId } from '../../shared/contracts';
import { EVENT_THEME_VERSION } from '../../shared/event-theme';
import { PageHeader } from '../components/Brand';
import { CopyableLinkCard } from '../components/CopyableLinkCard';
import { EventThemePresetSelector } from '../components/EventThemePresetSelector';
import { HostAccountPanel } from '../components/HostAccountPanel';
import { hostRegisterHref } from '../app/recovery';

interface Created {
  event: { id: string; name: string; slug: string };
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
  'eventTimezone',
  'rsvpDeadlineDate',
  'welcomeMessage',
] as const;

// The host's own zone is the right first guess, and the server validates
// whatever comes back. `supportedValuesOf` is recent enough that a browser
// without it still has to work: the datalist is a convenience, not the input.
function detectedTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function knownTimeZones(): string[] {
  try {
    return Intl.supportedValuesOf?.('timeZone') ?? [];
  } catch {
    return [];
  }
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
        eventTimezone: data.get('eventTimezone'), rsvpDeadlineDate: data.get('rsvpDeadlineDate'),
        theme: { version: EVENT_THEME_VERSION, presetId: themePresetId, overrides: {} },
      }) });
      setCreated(result);
      setSaved(result.savedToAccount === true);
      if (cover) {
        try {
          const upload = await api<{ objectKey: string; url: string }>(`/api/manage/events/${result.event.id}/cover`, { method: 'POST', body: JSON.stringify({ filename: cover.name, mimeType: cover.type, byteSize: cover.size }) });
          const transferred = await fetch(upload.url, { method: 'PUT', headers: { 'content-type': cover.type }, body: cover });
          if (!transferred.ok) throw new Error('Cover transfer failed.');
          await api(`/api/manage/events/${result.event.id}/cover/finalize`, { method: 'POST', body: JSON.stringify({ objectKey: upload.objectKey, mimeType: cover.type }) });
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
    <section className="success-copy"><span className="success-icon"><Check aria-hidden="true" /></span><h1>Your event is ready.</h1><p>Save the management link somewhere safe, then share the event link when you’re ready.</p><p className="form-note">The creator session’s ownership eligibility ends at the earlier of the management deadline and 12 hours after creation.</p>{coverError && <p className="form-error" role="alert">{coverError}</p>}
      {/* The warning is only true while the link is the sole way in. Once the event
          is saved to an account it stops being true, and leaving it up would talk a
          host out of the recovery they just set up. */}
      <div className="warning"><LockKeyhole aria-hidden="true" /><p><strong>Keep your management link private.</strong><br />{saved ? 'Anyone who has it can manage this event.' : 'Without an account, it cannot be recovered.'}</p></div>
      <p className="form-note">RSVP is paused until you add and validate the guest list, and photo delivery is paused until you open it.</p>
      <CopyableLinkCard label="Event link" value={created.eventLink} /><CopyableLinkCard label="Management link" value={created.managementLink} />
      <Link className="button button--primary" to={`/manage/event/${created.event.id}`}>Open event manager</Link>
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
    <section className="create-intro"><p className="section-label">Create your event</p><h1>A private home for every point of view.</h1><p>Start with the essentials. You can adjust sharing, moderation, and gallery visibility from your event manager.</p>
      <ul className="trust-list"><li><Check aria-hidden="true" /> Up to {MAX_EVENT_MEDIA.toLocaleString()} original photos</li><li><Check aria-hidden="true" /> Guest access without accounts</li><li><Check aria-hidden="true" /> Fixed, clear retention dates</li></ul>
    </section>
    <form className="create-form" ref={formRef} onSubmit={submit} noValidate>
      <h2>Event details</h2>{error && <p className="form-error" role="alert">{error}</p>}
      {/* The error sits outside the label: a name identifies the field, an error describes it. */}
      <div className="create-field"><label>Event name<input name="name" maxLength={80} required aria-invalid={Boolean(fields.name)} aria-describedby={fields.name ? 'name-error' : undefined} /></label>{fields.name && <small id="name-error">{fields.name}</small>}</div>
      <div className="create-field"><label>Event date<input name="eventDate" type="date" required aria-invalid={Boolean(fields.eventDate)} aria-describedby={fields.eventDate ? 'eventDate-error' : undefined} /></label>{fields.eventDate && <small id="eventDate-error">{fields.eventDate}</small>}</div>
      <div className="create-field"><label>Event time zone<input name="eventTimezone" list="event-time-zones" value={timeZone} onChange={(changed) => setTimeZone(changed.target.value)} required autoComplete="off" spellCheck={false} aria-invalid={Boolean(fields.eventTimezone)} aria-describedby={fields.eventTimezone ? 'eventTimezone-error' : 'eventTimezone-hint'} /></label><small id="eventTimezone-hint">RSVP deadlines close at the end of this day, in this zone.</small>{fields.eventTimezone && <small id="eventTimezone-error">{fields.eventTimezone}</small>}{zoneOptions.length > 0 && <datalist id="event-time-zones">{zoneOptions.map((zone) => <option key={zone} value={zone} />)}</datalist>}</div>
      <div className="create-field"><label>RSVP deadline<input name="rsvpDeadlineDate" type="date" required aria-invalid={Boolean(fields.rsvpDeadlineDate)} aria-describedby={fields.rsvpDeadlineDate ? 'rsvpDeadlineDate-error' : undefined} /></label>{fields.rsvpDeadlineDate && <small id="rsvpDeadlineDate-error">{fields.rsvpDeadlineDate}</small>}</div>
      <div className="create-field"><label>Welcome message<textarea name="welcomeMessage" rows={4} maxLength={500} required placeholder="Tell guests what you’d love them to share." aria-invalid={Boolean(fields.welcomeMessage)} aria-describedby={fields.welcomeMessage ? 'welcomeMessage-error' : undefined} /></label>{fields.welcomeMessage && <small id="welcomeMessage-error">{fields.welcomeMessage}</small>}</div>
      <EventThemePresetSelector name="themePreset" value={themePresetId} onChange={setThemePresetId} disabled={busy} />
      <label className="cover-field"><ImagePlus aria-hidden="true" /><div><strong>Cover photo</strong><p>{cover ? cover.name : 'Optional · JPEG, PNG, or WebP · 10 MB max'}</p></div><span className="button button--secondary">{cover ? 'Change' : 'Choose photo'}</span><input className="sr-only cover-field__input" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => { const file = event.target.files?.[0] ?? null; setCover(file && file.size <= 10 * 1024 * 1024 ? file : null); if (file && file.size > 10 * 1024 * 1024) setError('Cover photos must be 10 MB or smaller.'); }} /></label>
      <button className="button button--primary button--wide" disabled={busy}>{busy ? 'Creating your event…' : 'Create private event'}</button>
      <p className="form-note"><LockKeyhole aria-hidden="true" /> Your links act as the keys to this private event.</p>
    </form>
  </main></div>;
}

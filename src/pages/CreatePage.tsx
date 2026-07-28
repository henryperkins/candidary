import { Check, ImagePlus, LockKeyhole, QrCode } from 'lucide-react';
import QRCode from 'qrcode';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { api, ClientApiError } from '../app/api';
import { MAX_EVENT_MEDIA } from '../../shared/constants';
import { PageHeader } from '../components/Brand';
import { CopyableLinkCard } from '../components/CopyableLinkCard';
import { HostAccountPanel } from '../components/HostAccountPanel';

interface Created {
  event: { id: string; name: string; slug: string };
  guestLink: string;
  managementLink: string;
  csrfToken: string;
  // Committed server-side when a signed-in host created the event, so the success
  // screen never has to guess whether the event is already recoverable.
  savedToAccount?: boolean;
}

// Form order, not response order: the host should be taken to the first problem they would reach anyway.
const CREATE_FIELDS = ['name', 'eventDate', 'welcomeMessage'] as const;

export function CreatePage() {
  const [created, setCreated] = useState<Created | null>(null);
  const [saved, setSaved] = useState(false);
  const [cover, setCover] = useState<File | null>(null);
  const [coverError, setCoverError] = useState('');
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

  useEffect(() => { if (created) void QRCode.toDataURL(created.guestLink, { width: 260, margin: 2, color: { dark: '#42103b', light: '#fffaf3' } }).then(setQr); }, [created]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); setFields({});
    const data = new FormData(event.currentTarget);
    try {
      const result = await api<Created>('/api/events', { method: 'POST', body: JSON.stringify({
        name: data.get('name'), eventDate: data.get('eventDate'), welcomeMessage: data.get('welcomeMessage'),
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
    <section className="success-copy"><span className="success-icon"><Check aria-hidden="true" /></span><h1>Your event is ready.</h1><p>Save the management link somewhere safe, then share the guest link when you’re ready.</p>{coverError && <p className="form-error" role="alert">{coverError}</p>}
      {/* The warning is only true while the link is the sole way in. Once the event
          is saved to an account it stops being true, and leaving it up would talk a
          host out of the recovery they just set up. */}
      <div className="warning"><LockKeyhole aria-hidden="true" /><p><strong>Keep your management link private.</strong><br />{saved ? 'Anyone who has it can manage this event.' : 'Without an account, it cannot be recovered.'}</p></div>
      <CopyableLinkCard label="Guest link" value={created.guestLink} /><CopyableLinkCard label="Management link" value={created.managementLink} />
      <a className="button button--primary" href={created.managementLink}>Open event manager</a>
    </section>
    <aside className="qr-card"><QrCode aria-hidden="true" /><h2>Guest QR code</h2>{qr && <img src={qr} alt="QR code for the guest event link" />}<a className="button button--secondary" href={qr} download={`${created.event.slug}-qr.png`}>Download QR code</a></aside>
    {/* Mounted on whether creation already attached the event, not on `saved`.
        Keying it to `saved` would unmount the panel the moment completion
        succeeded, so the host would click Confirm and watch it disappear instead
        of being told their address was confirmed. */}
    {!created.savedToAccount && <HostAccountPanel
      bindEventId={created.event.id}
      onCompleted={({ boundEvent }) => { if (boundEvent) setSaved(true); }}
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
      <div className="create-field"><label>Welcome message<textarea name="welcomeMessage" rows={4} maxLength={500} required placeholder="Tell guests what you’d love them to share." aria-invalid={Boolean(fields.welcomeMessage)} aria-describedby={fields.welcomeMessage ? 'welcomeMessage-error' : undefined} /></label>{fields.welcomeMessage && <small id="welcomeMessage-error">{fields.welcomeMessage}</small>}</div>
      <label className="cover-field"><ImagePlus aria-hidden="true" /><div><strong>Cover photo</strong><p>{cover ? cover.name : 'Optional · JPEG, PNG, or WebP · 10 MB max'}</p></div><span className="button button--secondary">{cover ? 'Change' : 'Choose photo'}</span><input className="sr-only cover-field__input" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => { const file = event.target.files?.[0] ?? null; setCover(file && file.size <= 10 * 1024 * 1024 ? file : null); if (file && file.size > 10 * 1024 * 1024) setError('Cover photos must be 10 MB or smaller.'); }} /></label>
      <button className="button button--primary button--wide" disabled={busy}>{busy ? 'Creating your event…' : 'Create private event'}</button>
      <p className="form-note"><LockKeyhole aria-hidden="true" /> Your links act as the keys to this private event.</p>
    </form>
  </main></div>;
}

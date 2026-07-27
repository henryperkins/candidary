import { Check, ImagePlus, LockKeyhole, QrCode } from 'lucide-react';
import QRCode from 'qrcode';
import { type FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { api, ClientApiError } from '../app/api';
import { MAX_EVENT_MEDIA } from '../../shared/constants';
import { PageHeader } from '../components/Brand';
import { CopyableLinkCard } from '../components/CopyableLinkCard';

interface Created { event: { id: string; name: string; slug: string }; guestLink: string; managementLink: string; csrfToken: string }

export function CreatePage() {
  const [created, setCreated] = useState<Created | null>(null);
  const [cover, setCover] = useState<File | null>(null);
  const [coverError, setCoverError] = useState('');
  const [qr, setQr] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});

  useEffect(() => { if (created) void QRCode.toDataURL(created.guestLink, { width: 260, margin: 2, color: { dark: '#42103b', light: '#fffaf3' } }).then(setQr); }, [created]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); setFields({});
    const data = new FormData(event.currentTarget);
    try {
      const result = await api<Created>('/api/events', { method: 'POST', body: JSON.stringify({
        name: data.get('name'), eventDate: data.get('eventDate'), welcomeMessage: data.get('welcomeMessage'),
      }) });
      setCreated(result);
      if (cover) {
        try {
          const upload = await api<{ objectKey: string; url: string }>(`/api/manage/events/${result.event.id}/cover`, { method: 'POST', body: JSON.stringify({ filename: cover.name, mimeType: cover.type, byteSize: cover.size }) });
          const transferred = await fetch(upload.url, { method: 'PUT', headers: { 'content-type': cover.type }, body: cover });
          if (!transferred.ok) throw new Error('Cover transfer failed.');
          await api(`/api/manage/events/${result.event.id}/cover/finalize`, { method: 'POST', body: JSON.stringify({ objectKey: upload.objectKey, mimeType: cover.type }) });
        } catch { setCoverError('Your event was created, but the cover did not finish uploading. Add it again from event settings.'); }
      }
    } catch (caught) {
      if (caught instanceof ClientApiError) { setError(caught.message); setFields(caught.fieldErrors ?? {}); }
      else setError('The event could not be created. Try again.');
    } finally { setBusy(false); }
  }

  if (created) return <div className="public-shell"><PageHeader /><main className="success-layout">
    <section className="success-copy"><span className="success-icon"><Check aria-hidden="true" /></span><h1>Your event is ready.</h1><p>Save the management link somewhere safe, then share the guest link when you’re ready.</p>{coverError && <p className="form-error" role="alert">{coverError}</p>}
      <div className="warning"><LockKeyhole aria-hidden="true" /><p><strong>Keep your management link private.</strong><br />It cannot be recovered in this MVP.</p></div>
      <CopyableLinkCard label="Guest link" value={created.guestLink} /><CopyableLinkCard label="Management link" value={created.managementLink} />
      <a className="button button--primary" href={created.managementLink}>Open event manager</a>
    </section>
    <aside className="qr-card"><QrCode aria-hidden="true" /><h2>Guest QR code</h2>{qr && <img src={qr} alt="QR code for the guest event link" />}<a className="button button--secondary" href={qr} download={`${created.event.slug}-qr.png`}>Download QR code</a></aside>
  </main></div>;

  return <div className="public-shell"><PageHeader action={<Link className="text-link" to="/">Back home</Link>} /><main className="create-layout">
    <section className="create-intro"><p className="section-label">Create your event</p><h1>A private home for every point of view.</h1><p>Start with the essentials. You can adjust sharing, moderation, and gallery visibility from your event manager.</p>
      <ul className="trust-list"><li><Check aria-hidden="true" /> Up to {MAX_EVENT_MEDIA.toLocaleString()} original photos</li><li><Check aria-hidden="true" /> Guest access without accounts</li><li><Check aria-hidden="true" /> Fixed, clear retention dates</li></ul>
    </section>
    <form className="create-form" onSubmit={submit} noValidate>
      <h2>Event details</h2>{error && <p className="form-error" role="alert">{error}</p>}
      <label>Event name<input name="name" maxLength={80} required aria-invalid={Boolean(fields.name)} />{fields.name && <small>{fields.name}</small>}</label>
      <label>Event date<input name="eventDate" type="date" required aria-invalid={Boolean(fields.eventDate)} />{fields.eventDate && <small>{fields.eventDate}</small>}</label>
      <label>Welcome message<textarea name="welcomeMessage" rows={4} maxLength={500} required placeholder="Tell guests what you’d love them to share." />{fields.welcomeMessage && <small>{fields.welcomeMessage}</small>}</label>
      <label className="cover-field"><ImagePlus aria-hidden="true" /><div><strong>Cover photo</strong><p>{cover ? cover.name : 'Optional · JPEG, PNG, or WebP · 10 MB max'}</p></div><span className="button button--secondary">{cover ? 'Change' : 'Choose photo'}</span><input className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => { const file = event.target.files?.[0] ?? null; setCover(file && file.size <= 10 * 1024 * 1024 ? file : null); if (file && file.size > 10 * 1024 * 1024) setError('Cover photos must be 10 MB or smaller.'); }} /></label>
      <button className="button button--primary button--wide" disabled={busy}>{busy ? 'Creating your event…' : 'Create private event'}</button>
      <p className="form-note"><LockKeyhole aria-hidden="true" /> Your links act as the keys to this private event.</p>
    </form>
  </main></div>;
}

import { MailCheck, ShieldCheck } from 'lucide-react';
import { type FormEvent, useState } from 'react';

import { api, ClientApiError } from '../app/api';
import { MIN_HOST_PASSWORD_LENGTH } from '../../shared/constants';

interface HostAccountPanelProps {
  // Present on the create-success screen, absent everywhere else. The server still
  // re-checks that the browser holds this event's management session; passing the
  // id here only says which event to bind, never that binding is allowed.
  bindEventId?: string;
  // Reports what the server actually committed. Registration alone binds nothing,
  // so only a true `boundEvent` may be treated as the event becoming recoverable.
  onCompleted?: (result: { boundEvent: boolean }) => void;
  // The route owns durable presentation state. This fires only once the server has
  // accepted registration and the browser can resume its pending challenge.
  onStarted?: () => void;
  // Starting over changes only the local presentation and lets a route clear its
  // pending hint; it never consumes or changes the server-side challenge.
  onRestarted?: () => void;
  // `code` lets a host who skipped confirmation come back to it later without
  // re-registering, which is the only way back once the panel has been left.
  initialStage?: 'form' | 'code';
  // Two different proofs share this panel. `registration` finishes a pending
  // registration that has no account yet, so it answers to the registration cookie.
  // `verification` confirms the address of an account that is already signed in,
  // so it answers to the host session. They are never interchangeable.
  mode?: 'registration' | 'verification';
  // Set where the surface already carries the heading and the reason — the
  // registration page — so the form arrives once rather than under a second title
  // restating the first. The later stages keep their own headings either way,
  // because they replace the form rather than sit beneath it.
  embedded?: boolean;
}

type Stage = 'form' | 'code' | 'done';

// Registration and confirmation in one place, because on the create-success screen
// they are one thought: "make sure I can get back into this."
export function HostAccountPanel({
  bindEventId,
  onCompleted,
  onStarted,
  onRestarted,
  initialStage = 'form',
  mode = 'registration',
  embedded = false,
}: HostAccountPanelProps) {
  const [stage, setStage] = useState<Stage>(initialStage);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const [boundEvent, setBoundEvent] = useState(false);

  const completeEndpoint = mode === 'registration' ? '/api/host/register/complete' : '/api/host/verify';
  const resendEndpoint = mode === 'registration' ? '/api/host/register/resend' : '/api/host/verify/resend';

  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); setFields({});
    const data = new FormData(event.currentTarget);
    try {
      await api('/api/host/register', { method: 'POST', body: JSON.stringify({
        email: data.get('email'),
        password: data.get('password'),
        ...(bindEventId ? { bindEventId } : {}),
      }) });
      // Only the stage moves. Nothing is bound until the mailbox code is proved,
      // so the caller is deliberately not told anything here.
      setStage('code');
      onStarted?.();
    } catch (caught) {
      if (caught instanceof ClientApiError) { setError(caught.message); setFields(caught.fieldErrors ?? {}); }
      else setError('Your account could not be created. Try again.');
    } finally { setBusy(false); }
  }

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    const data = new FormData(event.currentTarget);
    try {
      const result = await api<{ boundEvent?: boolean }>(completeEndpoint, {
        method: 'POST', body: JSON.stringify({ code: data.get('code') }),
      });
      const bound = result?.boundEvent === true;
      setBoundEvent(bound);
      setStage('done');
      onCompleted?.({ boundEvent: bound });
    } catch (caught) {
      setError(caught instanceof ClientApiError ? caught.message : 'That code could not be checked. Try again.');
    } finally { setBusy(false); }
  }

  async function resend() {
    setBusy(true); setError(''); setNotice('');
    try {
      await api(resendEndpoint, { method: 'POST', body: JSON.stringify({}) });
      setNotice('A new code is on its way.');
    } catch (caught) {
      setError(caught instanceof ClientApiError ? caught.message : 'That code could not be sent. Try again.');
    } finally { setBusy(false); }
  }

  function restart() {
    setStage('form');
    setBusy(false);
    setError('');
    setFields({});
    setNotice('');
    setBoundEvent(false);
    onRestarted?.();
  }

  if (stage === 'done') {
    return <section className="host-panel">
      <span className="success-icon"><ShieldCheck aria-hidden="true" /></span>
      <h2>Your email is confirmed.</h2>
      {/* Two genuinely different outcomes. Claiming the first when only the second
          happened is what would talk a host out of keeping their link. */}
      {boundEvent || !bindEventId
        ? <p>You can sign in to reach this event any time, even without the management link.
          We’ll email you a short guide, a reminder the day before, and a warning before your
          access ends so you never lose the photos.</p>
        : <p>Your account is ready, but this event still depends on its management link —
          it was not added to your account. Keep the link, then open it and choose
          <strong> Add to my account</strong>.</p>}
    </section>;
  }

  if (stage === 'code') {
    return <section className="host-panel">
      <span className="success-icon"><MailCheck aria-hidden="true" /></span>
      <h2>Check your email.</h2>
      <p>Enter the six-digit code if one arrives. It confirms your address so we can email you about your event.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      {notice && <p className="form-note" role="status">{notice}</p>}
      <form className="create-form" onSubmit={confirm} noValidate>
        {/* One input, never six boxes: `autocomplete="one-time-code"` resolves on a
            single field only, and splitting it breaks paste, autofill, and the value a
            screen reader reads back. The tracking is what makes the digits countable
            at a glance, which is the only thing six boxes were ever doing. */}
        <div className="create-field code-field">
          <label htmlFor="confirmation-code">Confirmation code
            <input id="confirmation-code" name="code" inputMode="numeric" autoComplete="one-time-code"
              maxLength={6} placeholder="000000" required aria-describedby="confirmation-code-hint" />
          </label>
          <small id="confirmation-code-hint" className="field-hint">Six digits, from the email we just sent.</small>
        </div>
        <button className="button button--primary button--wide" disabled={busy}>
          {busy ? 'Checking…' : 'Confirm my email'}
        </button>
      </form>
      {/* The links row owns the gap. As bare siblings these two ran together into one
          unreadable string — JSX drops the newline between them, and neither carries
          spacing of its own. */}
      <div className="host-panel__links">
        <button type="button" className="text-link" onClick={resend} disabled={busy}>Send another code</button>
        {mode === 'registration' && <button type="button" className="text-link" onClick={restart} disabled={busy}>Start over</button>}
      </div>
      {/* Skippable on purpose. Confirming gates the emails, never the event itself —
          but until the code is entered nothing has been saved, so this must not say
          it has. */}
      <p className="form-note">{bindEventId
        ? 'Until you enter it, this event still depends on its management link.'
        : 'You can do this later. Confirming only gates the emails we send you.'}</p>
    </section>;
  }

  return <section className="host-panel">
    {!embedded && <>
      <h2>Save this event to your email</h2>
      <p>You’ll be able to get back to it without the management link,
        and we’ll warn you before your access ends.</p>
    </>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <form className="create-form" onSubmit={register} noValidate>
      <div className="create-field">
        <label>Email address
          <input name="email" type="email" autoComplete="email" required
            aria-invalid={Boolean(fields.email)} aria-describedby={fields.email ? 'host-email-error' : undefined} />
        </label>
        {fields.email && <small id="host-email-error">{fields.email}</small>}
      </div>
      <div className="create-field">
        <label>Password
          <input name="password" type="password" autoComplete="new-password"
            minLength={MIN_HOST_PASSWORD_LENGTH} required
            aria-invalid={Boolean(fields.password)}
            aria-describedby={fields.password ? 'host-password-error' : 'host-password-hint'} />
        </label>
        {/* The hint is generated from the constant, so the floor and the promise about
            it can never drift apart. It is not an error and must not borrow the colour
            that means one. */}
        {fields.password
          ? <small id="host-password-error">{fields.password}</small>
          : <small id="host-password-hint" className="field-hint">At least {MIN_HOST_PASSWORD_LENGTH} characters.</small>}
      </div>
      <button className="button button--primary button--wide" disabled={busy}>
        {busy ? 'Creating your account…' : 'Create account'}
      </button>
    </form>
  </section>;
}

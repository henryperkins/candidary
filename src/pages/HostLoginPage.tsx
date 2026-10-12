import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import type { HostSessionAccountView } from '../../shared/contracts';
import { api, ClientApiError } from '../app/api';
import { hostResetLandingIdentity, type HostAuthLandingIdentity } from '../app/host-auth-landing';
import {
  clearPendingRegistration,
  matchesPendingRegistration,
} from '../app/pending-registration';
import {
  adoptTargetFor,
  hostRegisterHref,
  HOST_EVENTS_PATH,
  safeReturnTo,
} from '../app/recovery';
import { MIN_HOST_PASSWORD_LENGTH } from '../../shared/constants';
import { PageHeader } from '../components/Brand';
import { AuthModeSwitch, AuthReturnNote } from '../components/HostAuthNav';

type Mode = 'signin' | 'forgot' | 'reset';

const TITLES: Record<Mode, string> = {
  signin: 'Sign in to your events',
  forgot: 'Reset your password',
  reset: 'Choose a new password',
};

export function HostLoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [search] = useSearchParams();
  const returnTo = safeReturnTo(search.get('returnTo'));
  const adopt = adoptTargetFor(returnTo, search.get('adopt'));
  const [mode, setMode] = useState<Mode>('signin');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  // Carried from the reset request so the host does not retype it alongside the code.
  const [email, setEmail] = useState('');
  const mounted = useRef(false);
  const requestSequence = useRef(0);
  const locationKey = useRef(location.key);
  locationKey.current = location.key;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; requestSequence.current += 1; };
  }, []);

  useEffect(() => {
    requestSequence.current += 1;
    setBusy(false);
  }, [location.key]);

  function switchTo(next: Mode) {
    requestSequence.current += 1; setBusy(false);
    setMode(next); setError(''); setFields({}); setNotice('');
  }

  // Both sign-in and a completed reset land here. The claim is made before the
  // navigation because the management-link cookie that authorizes it belongs to the
  // page the host came from, and a refusal is worth showing rather than swallowing.
  async function finishAuthenticated(identity: HostAuthLandingIdentity | null, isCurrent: () => boolean) {
    if (!isCurrent()) return;
    if (adopt) {
      try {
        await api(`/api/host/events/${adopt}/adopt`, { method: 'POST', body: JSON.stringify({}) });
      } catch (caught) {
        if (!isCurrent()) return;
        // The host is signed in either way, so they are not stranded — but the event
        // did not attach, and silently navigating on would repeat exactly the
        // false-success this branch exists to remove.
        setError(caught instanceof ClientApiError
          ? `You are signed in, but this event was not added to your account: ${caught.message}`
          : 'You are signed in, but this event could not be added to your account.');
        return;
      }
    }
    if (!isCurrent()) return;
    if (returnTo) navigate(returnTo);
    else navigate(HOST_EVENTS_PATH, { state: identity ? { hostAuthLanding: identity } : null });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); setFields({}); setNotice('');
    const sequence = ++requestSequence.current;
    const key = location.key;
    const isCurrent = () => mounted.current && locationKey.current === key && requestSequence.current === sequence;
    const data = new FormData(event.currentTarget);
    try {
      if (mode === 'signin') {
        const submittedEmail = String(data.get('email') ?? '');
        const matchesPending = await matchesPendingRegistration(submittedEmail, new Date());
        if (!isCurrent()) return;
        if (matchesPending) {
          const pending = await api<{ pending: boolean; expiresAt: string | null }>(
            '/api/host/register/pending',
          );
          if (!isCurrent()) return;
          if (pending.pending) {
            navigate(hostRegisterHref(adopt, returnTo, true), { replace: true });
            return;
          }
          clearPendingRegistration();
        }
        const signedIn = await api<{ account: HostSessionAccountView }>('/api/host/login', { method: 'POST', body: JSON.stringify({
          email: data.get('email'), password: data.get('password'),
        }) });
        await finishAuthenticated(signedIn.account?.id ? { kind: 'account', id: signedIn.account.id } : null, isCurrent);
        return;
      }
      if (mode === 'forgot') {
        await api('/api/host/password/forgot', { method: 'POST', body: JSON.stringify({ email: data.get('email') }) });
        if (!isCurrent()) return;
        setEmail(String(data.get('email') ?? ''));
        setMode('reset');
        // Worded to match what the server actually promises. It answers the same
        // way for an address with no account, and saying "we sent you a code"
        // outright would be a claim the response cannot support.
        setNotice('If that address has an account, a six-digit code is on its way.');
        return;
      }
      await api('/api/host/password/reset', { method: 'POST', body: JSON.stringify({
        email, code: data.get('code'), password: data.get('password'),
      }) });
      if (!isCurrent()) return;
      const identity = returnTo ? null : await hostResetLandingIdentity(email);
      await finishAuthenticated(identity, isCurrent);
    } catch (caught) {
      if (!isCurrent()) return;
      if (caught instanceof ClientApiError) { setError(caught.message); setFields(caught.fieldErrors ?? {}); }
      else setError('That did not go through. Try again.');
    } finally { if (isCurrent()) setBusy(false); }
  }

  return <div className="public-shell">
    <PageHeader action={<Link className="text-link" to="/">Back home</Link>} />
    <main className="host-layout">
      <section className="host-panel">
        {/* The event the host came from, named before they are asked for anything —
            they arrived holding its management link, and this page is otherwise
            indistinguishable from a sign-in that has nothing to do with it. */}
        <AuthReturnNote returnTo={returnTo} adopt={adopt} />
        <p className="section-label">Host sign in</p>
        <h1>{TITLES[mode]}</h1>
        {mode === 'signin' && <p>Signing in reaches every event saved to your account.
          Holding a management link works too, and always has.</p>}
        {/* Reset and confirm are stages inside this door, reached from the links row
            below — never a third tab. Only the two real destinations are switchable. */}
        {mode === 'signin' && <AuthModeSwitch mode="signin" returnTo={returnTo} adopt={adopt} />}
        {error && <p className="form-error" role="alert">{error}</p>}
        {notice && <p className="form-note" role="status">{notice}</p>}

        <form
          className="create-form"
          onSubmit={submit}
          noValidate
          {...(mode === 'signin'
            ? { id: 'auth-panel-signin', role: 'tabpanel', 'aria-labelledby': 'auth-tab-signin' }
            : {})}
        >
          {mode !== 'reset' && <div className="create-field">
            <label>Email address
              <input name="email" type="email" autoComplete="email" required
                aria-invalid={Boolean(fields.email)} aria-describedby={fields.email ? 'email-error' : undefined} />
            </label>
            {fields.email && <small id="email-error">{fields.email}</small>}
          </div>}

          {/* One input, never six boxes: `autocomplete="one-time-code"` resolves on a
              single field only, and splitting it breaks paste, autofill, and the value
              a screen reader reads back. The hint names the address carried over from
              the previous step so the host does not retype it beside the code. */}
          {mode === 'reset' && <div className="create-field code-field">
            <label htmlFor="reset-code">Confirmation code
              <input id="reset-code" name="code" inputMode="numeric" autoComplete="one-time-code"
                maxLength={6} placeholder="000000" required aria-describedby="reset-code-hint" />
            </label>
            <small id="reset-code-hint" className="field-hint">
              Six digits{email ? `, sent to ${email}` : ''}.
            </small>
          </div>}

          {mode !== 'forgot' && <div className="create-field">
            <label>{mode === 'reset' ? 'New password' : 'Password'}
              <input name="password" type="password"
                autoComplete={mode === 'reset' ? 'new-password' : 'current-password'}
                minLength={mode === 'reset' ? MIN_HOST_PASSWORD_LENGTH : undefined} required
                aria-invalid={Boolean(fields.password)}
                aria-describedby={fields.password ? 'password-error' : undefined} />
            </label>
            {fields.password && <small id="password-error">{fields.password}</small>}
          </div>}

          <button className="button button--primary button--wide" disabled={busy}>
            {busy ? 'Working…' : mode === 'signin' ? 'Sign in' : mode === 'forgot' ? 'Send reset code' : 'Set new password'}
          </button>
        </form>

        <div className="host-panel__links">
          {mode === 'signin'
            ? <button type="button" className="text-link" onClick={() => switchTo('forgot')}>Forgotten your password?</button>
            : <button type="button" className="text-link" onClick={() => switchTo('signin')}>Back to sign in</button>}
          {/* `Create account` is not repeated here: the switch above already carries
              it, and offering the same door twice makes the pair look like two
              different things. */}
          <Link className="text-link" to="/create">Create a new event</Link>
        </div>
      </section>
    </main>
  </div>;
}

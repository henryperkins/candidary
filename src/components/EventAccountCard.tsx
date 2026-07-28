import { ShieldCheck, UserPlus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { api, ClientApiError } from '../app/api';
import { hostRegisterHref, hostSignInHref } from '../app/recovery';

interface HostSession {
  account: { email: string };
  events: { id: string }[];
}

// Ownership, shown where the host would look for it. The adopt call is authorized
// by the management session that already loaded this page, so nothing here needs to
// prove anything the server will not re-check.
export function EventAccountCard({ eventId }: { eventId: string }) {
  const [session, setSession] = useState<HostSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setSession(await api<HostSession>('/api/host/session'));
    } catch {
      // Not signed in is the ordinary case here, not a failure worth reporting:
      // most hosts reach this page from a management link.
      setSession(null);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function adopt() {
    setBusy(true); setError('');
    try {
      await api(`/api/host/events/${eventId}/adopt`, { method: 'POST', body: JSON.stringify({}) });
      await load();
    } catch (caught) {
      setError(caught instanceof ClientApiError ? caught.message : 'This event could not be added. Try again.');
    } finally { setBusy(false); }
  }

  const saved = session?.events.some((event) => event.id === eventId) ?? false;

  return <div className="account-card">
    <h3>Account access</h3>
    {error && <p className="form-error" role="alert">{error}</p>}
    {saved && <p><ShieldCheck aria-hidden="true" /> Saved to <strong>{session!.account.email}</strong>.
      You can reach this event by signing in, even without the management link.</p>}
    {!saved && session && <>
      <p>Signed in as <strong>{session.account.email}</strong>. Add this event to your account
        so you can reach it without the management link.</p>
      <button type="button" className="button button--secondary" onClick={adopt} disabled={busy}>
        <UserPlus aria-hidden="true" /> {busy ? 'Adding…' : 'Add to my account'}
      </button>
    </>}
    {/* The link carries the event so the host comes back here and the claim happens
        while this page's management cookie is still the thing authorizing it. */}
    {!session && <p>This event is reachable only by its management link.
      {' '}<Link className="text-link" to={hostSignInHref(eventId)}>Sign in</Link> or
      {' '}<Link className="text-link" to={hostRegisterHref(eventId)}>Create account</Link> to save it to an account,
      so losing the link stops being permanent.</p>}
  </div>;
}

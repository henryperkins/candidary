import { CalendarDays, Images, MailWarning } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { api, ClientApiError } from '../app/api';
import { PageHeader } from '../components/Brand';
import { describeLoadFailure, ErrorState, LoadingState } from '../components/States';
import type { LoadFailure } from '../components/States';

interface HostSession {
  account: {
    id: string;
    email: string;
    displayName: string | null;
    emailVerified: boolean;
    notificationsEnabled: boolean;
  };
  events: {
    id: string;
    name: string;
    slug: string;
    eventDate: string;
    storedMediaCount: number;
    managementAccessExpiresAt: string;
  }[];
}

function formatDate(value: string): string {
  return new Date(value.length === 10 ? `${value}T00:00:00.000Z` : value)
    .toLocaleDateString(undefined, { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' });
}

export function HostEventsPage() {
  const navigate = useNavigate();
  const [session, setSession] = useState<HostSession | null>(null);
  const [failure, setFailure] = useState<LoadFailure | null>(null);
  const [busy, setBusy] = useState(false);
  // Kept apart from `failure`: these are refused actions on a page that loaded fine,
  // so they must not replace the events with an error screen.
  const [actionError, setActionError] = useState('');

  const load = useCallback(async () => {
    setFailure(null);
    try {
      setSession(await api<HostSession>('/api/host/session'));
    } catch (caught) {
      // A missing or expired account session is not an error page — it is the
      // sign-in page, which is the only thing that resolves it.
      if (caught instanceof ClientApiError
        && ['HOST_SESSION_REQUIRED', 'SESSION_REQUIRED', 'SESSION_EXPIRED'].includes(caught.code)) {
        navigate('/host/login');
        return;
      }
      setFailure(describeLoadFailure(caught, 'manager', 'Your events could not be loaded.'));
    }
  }, [navigate]);

  useEffect(() => { void load(); }, [load]);

  async function signOut() {
    setBusy(true); setActionError('');
    try {
      await api('/api/host/logout', { method: 'POST', body: JSON.stringify({}) });
      // Only once the server has confirmed the revocation. Leaving on a rejection
      // would show a signed-out page while the session is still live.
      navigate('/host/login');
    } catch (caught) {
      setActionError(caught instanceof ClientApiError
        ? caught.message
        : 'You could not be signed out. Try again.');
    } finally { setBusy(false); }
  }

  async function setNotifications(enabled: boolean) {
    setBusy(true); setActionError('');
    try {
      await api('/api/host/preferences', {
        method: 'PATCH', body: JSON.stringify({ notificationsEnabled: enabled }),
      });
      // Local state follows the server, never leads it, so a refused change does not
      // leave the control showing a preference that was never saved.
      setSession((current) => (current
        ? { ...current, account: { ...current.account, notificationsEnabled: enabled } }
        : current));
    } catch (caught) {
      setActionError(caught instanceof ClientApiError
        ? caught.message
        : 'That preference could not be saved. Try again.');
    } finally { setBusy(false); }
  }

  async function resendVerification() {
    setBusy(true);
    try {
      await api('/api/host/verify/resend', { method: 'POST', body: JSON.stringify({}) });
    } finally { setBusy(false); }
  }

  if (failure) return <ErrorState {...failure} onRetry={failure.retryable ? () => void load() : undefined} />;
  if (!session) return <LoadingState label="Loading your events" />;

  return <div className="public-shell">
    <PageHeader action={<button type="button" className="text-link" onClick={signOut} disabled={busy}>Sign out</button>} />
    <main className="host-layout">
      <section className="host-panel">
        <p className="section-label">{session.account.email}</p>
        <h1>Your events</h1>

        {actionError && <p className="form-error" role="alert">{actionError}</p>}

        <label className="toggle">
          <input
            type="checkbox"
            checked={session.account.notificationsEnabled}
            disabled={busy}
            onChange={(changed) => void setNotifications(changed.target.checked)}
          />
          <span>Send me event emails</span>
        </label>

        {!session.account.emailVerified && <div className="warning">
          <MailWarning aria-hidden="true" />
          <p><strong>Confirm your email address.</strong><br />
            Until you do, we can’t send your event guide or warn you before your access ends.
            {' '}<Link className="text-link" to="/host/verify">Enter your code</Link>, or
            {' '}<button type="button" className="text-link" onClick={resendVerification} disabled={busy}>send a new one</button>.
          </p>
        </div>}

        {session.events.length === 0
          ? <p>No events are saved to this account yet. Open an event’s management link and
              choose <strong>Add to my account</strong>, or <Link className="text-link" to="/create">create a new event</Link>.</p>
          : <ul className="host-event-list">
            {session.events.map((event) => <li key={event.id}>
              <Link to={`/manage/event/${event.id}`}>
                <strong>{event.name}</strong>
                <span><CalendarDays aria-hidden="true" /> {formatDate(event.eventDate)}</span>
                <span><Images aria-hidden="true" /> {event.storedMediaCount.toLocaleString()} photos</span>
              </Link>
              {/* The date that actually costs the host something if missed. */}
              <small>Manage and export until {formatDate(event.managementAccessExpiresAt)}</small>
            </li>)}
          </ul>}
      </section>
    </main>
  </div>;
}

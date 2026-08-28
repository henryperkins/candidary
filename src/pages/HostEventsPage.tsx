import { CalendarDays, Images, MailWarning } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import type { HostSessionResponse } from '../../shared/contracts';
import { api, ClientApiError } from '../app/api';
import {
  DATE_UNAVAILABLE,
  TIME_UNAVAILABLE,
  formatEventDate,
  formatRetentionDate,
} from '../app/event-date-time';
import { PageHeader } from '../components/Brand';
import { describeLoadFailure, ErrorState, LoadingState } from '../components/States';
import type { LoadFailure } from '../components/States';

type EventSortOrder = 'newest' | 'oldest';

export function HostEventsPage() {
  const navigate = useNavigate();
  const [session, setSession] = useState<HostSessionResponse | null>(null);
  const [failure, setFailure] = useState<LoadFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const [eventSearch, setEventSearch] = useState('');
  const [eventSort, setEventSort] = useState<EventSortOrder>('newest');
  // Kept apart from `failure`: these are refused actions on a page that loaded fine,
  // so they must not replace the events with an error screen.
  const [actionError, setActionError] = useState('');

  const load = useCallback(async () => {
    setFailure(null);
    try {
      setSession(await api<HostSessionResponse>('/api/host/session'));
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

  const normalizedSearch = eventSearch.trim().toLocaleLowerCase('en-US');
  const visibleEvents = session.events
    .map((event, loadedIndex) => ({ event, loadedIndex }))
    .filter(({ event }) => event.name.toLocaleLowerCase('en-US').includes(normalizedSearch))
    .sort((left, right) => {
      const byDate = left.event.eventDate.localeCompare(right.event.eventDate);
      if (byDate !== 0) return eventSort === 'newest' ? -byDate : byDate;
      return left.loadedIndex - right.loadedIndex;
    })
    .map(({ event }) => event);

  return <div className="public-shell">
    <PageHeader action={<button type="button" className="text-link" onClick={signOut} disabled={busy}>Sign out</button>} />
    <main className="host-layout">
      <section className="host-panel">
        <p className="section-label">{session.account.email}</p>
        <h1>Your events</h1>
        <Link className="button button--primary" to="/create">Create event</Link>

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

        {session.events.length > 0 && <div className="create-form">
          <label>
            Search events
            <input
              type="search"
              value={eventSearch}
              onChange={(changed) => setEventSearch(changed.target.value)}
            />
          </label>
          <label>
            Sort events
            <select
              value={eventSort}
              onChange={(changed) => setEventSort(changed.target.value as EventSortOrder)}
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
            </select>
          </label>
          <p role="status" aria-live="polite">
            {visibleEvents.length} {visibleEvents.length === 1 ? 'event' : 'events'}
          </p>
        </div>}

        {session.events.length === 0
          ? <p>No events are saved to this account yet. Open an event’s management link and
              choose <strong>Add to my account</strong>, or <Link className="text-link" to="/create">create a new event</Link>.</p>
          : visibleEvents.length === 0
            ? <p>No events match your search.</p>
            : <ul className="host-event-list">
              {visibleEvents.map((event) => {
                const eventDate = formatEventDate(event.eventDate);
                const managementExpiry = formatRetentionDate(
                  event.managementAccessExpiresAt,
                  event.eventTimezone,
                );
                return <li key={event.id}>
                  <Link to={`/manage/event/${event.id}`}>
                    <strong>{event.name}</strong>
                    <span><CalendarDays aria-hidden="true" /> {eventDate === null
                      ? DATE_UNAVAILABLE
                      : <time dateTime={event.eventDate}>{eventDate}</time>}</span>
                    <span><Images aria-hidden="true" /> {event.storedMediaCount.toLocaleString()} photos</span>
                  </Link>
                  {/* The date that actually costs the host something if missed. */}
                  <small>Manage and export until {managementExpiry === null
                    ? TIME_UNAVAILABLE
                    : <time dateTime={event.managementAccessExpiresAt}>{managementExpiry}</time>}</small>
                </li>;
              })}
            </ul>}
      </section>
    </main>
  </div>;
}

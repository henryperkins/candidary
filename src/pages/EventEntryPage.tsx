import { useEffect, useRef } from 'react';

import { api } from '../app/api';
import { PageHeader } from '../components/Brand';

const UNAVAILABLE = '/recover/event-entry?kind=unavailable';

/**
 * The shell behind the QR printed on every invitation.
 *
 * The credential arrives in the URL fragment, which the browser never puts in a
 * request line or a `Referer` header. This reads it once into a local variable,
 * erases it from the address bar before any network call, and sends it in a
 * same-origin POST body. After that the credential exists nowhere: not in React
 * state, not in history, not in a log line, and not on this page.
 */
export function EventEntryPage() {
  const started = useRef(false);

  useEffect(() => {
    // React runs effects twice in development StrictMode. The fragment is gone
    // after the first pass, so a second exchange would report a false failure.
    if (started.current) return;
    started.current = true;

    const token = window.location.hash.slice(1);
    window.history.replaceState(null, '', '/join');

    if (!token) {
      window.location.replace(UNAVAILABLE);
      return;
    }

    void api<{ location: string }>('/api/entry/exchange', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }).then(
      // `replace`, not `assign`: the entry URL must not be reachable with the
      // back button, and there is nothing useful to go back to.
      (result) => window.location.replace(result.location),
      () => window.location.replace(UNAVAILABLE),
    );
  }, []);

  return <div className="public-shell"><PageHeader /><main className="centered-state">
    <h1>Opening your event…</h1>
    <p aria-live="polite">One moment while we check your invitation.</p>
  </main></div>;
}

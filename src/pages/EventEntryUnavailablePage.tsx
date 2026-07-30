import { Link } from 'react-router-dom';

import { PageHeader } from '../components/Brand';

/**
 * Where a scan lands when the credential is missing, malformed, or no longer
 * honoured. It deliberately says the same thing in every case: a guest cannot
 * fix any of them, and distinguishing between them would tell a stranger
 * holding a guess which guess was closest.
 */
export function EventEntryUnavailablePage() {
  return <div className="public-shell"><PageHeader /><main className="centered-state">
    <h1>This event entry is not available.</h1>
    <p>
      The code you scanned is no longer active. Ask your host for the current
      invitation, and they can send you a working link.
    </p>
    <Link className="button button--secondary" to="/">Return to Candidary</Link>
  </main></div>;
}

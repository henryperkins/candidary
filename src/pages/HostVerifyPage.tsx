import { Link } from 'react-router-dom';

import { PageHeader } from '../components/Brand';
import { HostAccountPanel } from '../components/HostAccountPanel';

// The way back to a confirmation that was skipped. It carries no event id: the
// account already exists, and this only settles the address.
export function HostVerifyPage() {
  return <div className="public-shell">
    <PageHeader action={<Link className="text-link" to="/host/events">Your events</Link>} />
    <main className="host-layout">
      {/* The account already exists and is signed in, so this confirms an address
          through the host session rather than through a pending registration. */}
      <HostAccountPanel initialStage="code" mode="verification" />
    </main>
  </div>;
}

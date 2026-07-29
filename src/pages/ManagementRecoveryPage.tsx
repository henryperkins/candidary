import { Link, useSearchParams } from 'react-router-dom';

import type { LoadFailureKind } from '../../shared/load-failure';
import { Brand } from '../components/Brand';
import { ManagementLinkRecovery } from '../components/ManagementLinkRecovery';

const RECOVERY_KINDS = ['latest-link', 'ended-event', 'sign-in', 'retry'] as const satisfies readonly LoadFailureKind[];

function recoveryKind(value: string | null): LoadFailureKind {
  return RECOVERY_KINDS.includes(value as LoadFailureKind)
    ? value as LoadFailureKind
    : 'latest-link';
}

export function ManagementRecoveryPage() {
  const [search] = useSearchParams();
  const kind = recoveryKind(search.get('kind'));

  if (kind === 'ended-event') {
    return <main className="management-recovery-page">
      <Brand />
      <section aria-labelledby="management-recovery-title">
        <h1 id="management-recovery-title">This event can no longer be managed</h1>
        <p role="alert">
          Check the management link you saved. A closed or deleted event cannot be reopened from here.
        </p>
      </section>
    </main>;
  }

  return <main className="management-recovery-page">
    <Brand />
    <section aria-labelledby="management-recovery-title">
      <p className="section-label">Manager recovery</p>
      <h1 id="management-recovery-title">Recover event manager</h1>
      <p>Sign in helps only when this event is already saved to your account.</p>

      <div className="management-recovery-page__methods">
        <section className="management-recovery-page__method" aria-labelledby="saved-account-title">
          <h2 id="saved-account-title">Saved to your account</h2>
          <p>Sign in to see events that are already saved to your account.</p>
          <Link className="button button--secondary" to="/host/login">Sign in</Link>
        </section>

        <section className="management-recovery-page__method" aria-labelledby="management-link-title">
          <h2 id="management-link-title">Use a management link</h2>
          <ManagementLinkRecovery />
        </section>
      </div>
    </section>
  </main>;
}

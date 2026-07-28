import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { adoptTargetFor, hostRegisterHref, hostSignInHref, HOST_EVENTS_PATH, safeReturnTo } from '../app/recovery';
import { PageHeader } from '../components/Brand';
import { HostAccountPanel } from '../components/HostAccountPanel';

// Registration can be resumed after a reload because the pending challenge lives
// in an HttpOnly registration cookie. The URL records only which local UI stage to
// show; it never authorizes an event attachment by itself.
export function HostRegisterPage() {
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const returnTo = safeReturnTo(search.get('returnTo'));
  const adopt = adoptTargetFor(returnTo, search.get('adopt'));
  const pending = search.get('pending') === '1';
  const registerHref = hostRegisterHref(adopt, returnTo);

  function resumePending() {
    navigate(hostRegisterHref(adopt, returnTo, true), { replace: true });
  }

  function restart() {
    navigate(registerHref, { replace: true });
  }

  function completed({ boundEvent }: { boundEvent: boolean }) {
    // The API result is the sole client-visible proof that the event attached. A
    // non-attachment stays on the completion screen so the panel can say exactly
    // that rather than navigating as though recovery had succeeded.
    if (boundEvent) navigate(returnTo ?? HOST_EVENTS_PATH, { replace: true });
  }

  return <div className="public-shell">
    <PageHeader action={<Link className="text-link" to="/">Back home</Link>} />
    <main className="host-layout">
      <section className="host-panel">
        <p className="section-label">Host account</p>
        <h1>Create your account</h1>
        <p>Use your email to get back to saved events without relying on a management link.</p>
        <p className="form-note">The creator session’s ownership eligibility ends at the earlier of the management deadline and 12 hours after creation.</p>
        <HostAccountPanel
          bindEventId={adopt ?? undefined}
          initialStage={pending ? 'code' : 'form'}
          onStarted={resumePending}
          onRestarted={restart}
          onCompleted={completed}
        />
        <p className="host-panel__links">Already have an account? <Link className="text-link" to={hostSignInHref(adopt, returnTo)}>Sign in</Link>.</p>
      </section>
    </main>
  </div>;
}

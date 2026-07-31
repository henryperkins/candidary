import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { adoptTargetFor, hostRegisterHref, HOST_EVENTS_PATH, safeReturnTo } from '../app/recovery';
import { PageHeader } from '../components/Brand';
import { HostAccountPanel } from '../components/HostAccountPanel';
import { AuthModeSwitch, AuthReturnNote } from '../components/HostAuthNav';

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
        <AuthReturnNote returnTo={returnTo} adopt={adopt} />
        <p className="section-label">Host account</p>
        {/* Arriving with an event makes this page about that event, not about
            accounts in general. One heading and one sentence either way — the panel
            below is embedded so it does not restate them. */}
        <h1>{adopt ? 'Save this event to your email' : 'Create your account'}</h1>
        <p>{adopt
          ? 'You’ll be able to get back to it without the management link, and we’ll warn you before your access ends.'
          : 'Your email gets you back to your events without a management link.'}</p>
        {/* Once the code has been sent, the pair is no longer a choice: switching
            doors mid-flow would strand a registration the host cannot see. */}
        {!pending && <AuthModeSwitch mode="register" returnTo={returnTo} adopt={adopt} />}
        {/* The window is a fact about claiming an event, so it is disclosed only
            where an event is actually being claimed. On a registration carrying no
            event it named nothing on the page. */}
        {adopt && <p className="form-note">You can save this event to an account until its management
          deadline, or 12 hours after it was created — whichever comes first.</p>}
        {/* The panel is only a tabpanel while its tab is on the page; naming an absent
            tab would point `aria-labelledby` at an id that does not exist here. */}
        <div {...(pending
          ? {}
          : { id: 'auth-panel-register', role: 'tabpanel', 'aria-labelledby': 'auth-tab-register' })}>
          <HostAccountPanel
            embedded
            bindEventId={adopt ?? undefined}
            initialStage={pending ? 'code' : 'form'}
            onStarted={resumePending}
            onRestarted={restart}
            onCompleted={completed}
          />
        </div>
      </section>
    </main>
  </div>;
}

import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import {
  clearPendingRegistration,
  refreshPendingRegistrationExpiry,
  rememberPendingRegistration,
  type AcceptedPendingRegistration,
} from '../app/pending-registration';
import {
  adoptTargetFor,
  hostRegisterHref,
  HOST_EVENTS_PATH,
  registrationConfirmationDestination,
  safeReturnTo,
} from '../app/recovery';
import { PageHeader } from '../components/Brand';
import { HostAccountPanel } from '../components/HostAccountPanel';
import { AuthModeSwitch, AuthReturnNote } from '../components/HostAuthNav';

// Registration can be resumed after a reload because the pending challenge lives
// in an HttpOnly registration cookie. The URL records only which local UI stage to
// show; it never authorizes an event attachment by itself.
export function HostRegisterPage() {
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const originalReturnTo = search.get('returnTo');
  const returnTo = safeReturnTo(originalReturnTo);
  const adopt = adoptTargetFor(returnTo, search.get('adopt'));
  const pending = search.get('pending') === '1';
  const registerHref = hostRegisterHref(adopt, returnTo);
  const [bindingFailed, setBindingFailed] = useState(false);

  useEffect(() => {
    if (!pending) clearPendingRegistration();
  }, [pending]);

  function resumePending() {
    navigate(hostRegisterHref(adopt, returnTo, true), { replace: true });
  }

  function restart() {
    clearPendingRegistration();
    navigate(registerHref, { replace: true });
  }

  function completed({ boundEvent }: { boundEvent: boolean }) {
    clearPendingRegistration();
    const destination = registrationConfirmationDestination({
      boundEvent,
      returnTo: originalReturnTo,
      validatedAdopt: adopt,
    });
    if (boundEvent || !adopt) {
      navigate(destination, { replace: true });
      return;
    }

    // The account exists, but the event did not attach. Keep the panel's truthful
    // result, remove the pending URL state so reload cannot loop through the code
    // step, and offer one ordinary navigation to the account's event list.
    setBindingFailed(true);
    navigate(registerHref, { replace: true });
  }

  async function registrationPending(accepted: AcceptedPendingRegistration) {
    await rememberPendingRegistration(accepted);
  }

  function registrationResent({ resumeExpiresAt }: { resumeExpiresAt: string }) {
    refreshPendingRegistrationExpiry(resumeExpiresAt);
  }

  return <div className="public-shell">
    <PageHeader action={<Link className="text-link" to="/">Back home</Link>} />
    <main className="host-layout">
      <section className="host-panel">
        {!bindingFailed && <>
          <AuthReturnNote returnTo={returnTo} adopt={adopt} />
          <p className="section-label">Host account</p>
          {/* Arriving with an event makes this page about that event, not about
              accounts in general. One heading and one sentence either way — the panel
              below is embedded so it does not restate them. */}
          <h1>{adopt ? 'Save this event to your email' : 'Create your account'}</h1>
          <p>{adopt
            ? 'Your account is created only after you confirm the code we email you. Then you can get back without the management link.'
            : 'Your account is created only after you confirm the code we email you. Then your email gets you back to your events.'}</p>
          {/* Once the code has been sent, the pair is no longer a choice: switching
              doors mid-flow would strand a registration the host cannot see. */}
          {!pending && <AuthModeSwitch mode="register" returnTo={returnTo} adopt={adopt} />}
          {/* The window is a fact about claiming an event, so it is disclosed only
              where an event is actually being claimed. On a registration carrying no
              event it named nothing on the page. */}
          {adopt && <p className="form-note">You can save this event to an account until its management
            deadline, or 12 hours after it was created — whichever comes first.</p>}
        </>}
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
            onRegistrationPending={registrationPending}
            onRegistrationResent={registrationResent}
            onRestarted={restart}
            onCompleted={completed}
          />
          {bindingFailed && <Link className="button button--primary button--wide"
            to={HOST_EVENTS_PATH} replace>Continue to Host Events</Link>}
        </div>
      </section>
    </main>
  </div>;
}

import { LoaderCircle, TriangleAlert } from 'lucide-react';

import {
  failureDecisionForCode,
  type LoadFailureKind,
} from '../../shared/load-failure';
import { ClientApiError } from '../app/api';

export function LoadingState({
  label = 'Gathering the details…',
  live = true,
}: {
  label?: string;
  live?: boolean;
}) {
  return <div className="state-card" role={live ? 'status' : undefined}><LoaderCircle className="spin" aria-hidden="true" /><p>{label}</p></div>;
}

interface ErrorStateProps {
  message: string;
  recoveryHint: string;
  onRetry?: () => void;
  // Some failures are not retryable but still have exactly one way out — signing in.
  // Naming it as a link keeps that route reachable without pretending a repeat of
  // the same request would answer differently.
  action?: { label: string; href: string };
}

export function ErrorState({ message, recoveryHint, onRetry, action }: ErrorStateProps) {
  // The failure and the way out are announced together. Most of these states offer no button, no
  // heading, and nothing else focusable, so a live region carrying only the failure would tell a
  // screen-reader user what broke and never mention the one thing that recovers it.
  return <div className="state-card state-card--error">
    <TriangleAlert aria-hidden="true" />
    <div role="alert">
      <p>{message}</p>
      <p className="state-card__recovery">{recoveryHint}</p>
      {/* Inside the live region for the same reason the hint is: announcing the
          failure without the one route out of it is the half that does not help. */}
      {action && (
        <a className="button button--secondary" href={action.href}>{action.label}</a>
      )}
    </div>
    {onRetry && (
      <button type="button" className="button button--secondary" onClick={onRetry}>Try again</button>
    )}
  </div>;
}

const LINK_RECOVERY_HINT = {
  guest: 'Open the latest guest link from your host to start again.',
  manager: 'Open the latest management link you saved to start again.',
};

const LIFECYCLE_HINT = {
  guest: 'Your host can share a new link if you still need to send photos.',
  manager: 'Check the management link you saved. A closed or deleted event cannot be reopened from here.',
};

// Deliberately cause-neutral. A retry is worth offering whenever the request could answer differently
// next time, which is not the same as knowing why it did not answer this time.
const RETRY_HINT = 'This did not go through. Try again in a moment.';

// This hint is role-independent; the shared decision table controls whether the
// manager surface makes the sign-in route available.
const SIGN_IN_HINT = 'Sign in with your email and password to continue.';

export interface LoadFailure {
  kind: LoadFailureKind;
  message: string;
  recoveryHint: string;
  retryable: boolean;
  // Set by the code, not by the surface: whether signing in is a route out of this
  // particular failure.
  offerSignIn: boolean;
}

// The code decides recoverability, never the prose: rewording a message must not be able to turn an
// unrecoverable session failure back into a retry loop.
export function describeLoadFailure(
  caught: unknown,
  role: keyof typeof LINK_RECOVERY_HINT,
  fallback: string,
): LoadFailure {
  const message = caught instanceof Error && caught.message ? caught.message : fallback;
  const decision = caught instanceof ClientApiError
    ? failureDecisionForCode(caught.code)
    : { kind: 'retry' as const, offerSignIn: false };
  const offerSignIn = role === 'manager' && decision.offerSignIn;
  const { kind } = decision;
  if (kind === 'latest-link') {
    // The recovery table distinguishes failures where a fresh sign-in can help
    // from ones such as a disabled account, where it cannot.
    return {
      message,
      kind,
      recoveryHint: LINK_RECOVERY_HINT[role],
      retryable: false,
      offerSignIn,
    };
  }
  if (kind === 'ended-event') {
    // Signing in cannot reopen a closed or deleted event, so it is not offered here.
    return { message, kind, recoveryHint: LIFECYCLE_HINT[role], retryable: false, offerSignIn };
  }
  if (kind === 'sign-in') {
    return { message, kind, recoveryHint: SIGN_IN_HINT, retryable: false, offerSignIn };
  }
  return { message, kind, recoveryHint: RETRY_HINT, retryable: true, offerSignIn };
}

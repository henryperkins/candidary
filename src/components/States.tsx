import { LoaderCircle, TriangleAlert } from 'lucide-react';

import { ClientApiError } from '../app/api';

export function LoadingState({ label = 'Gathering the details…' }: { label?: string }) {
  return <div className="state-card" role="status"><LoaderCircle className="spin" aria-hidden="true" /><p>{label}</p></div>;
}

interface ErrorStateProps {
  message: string;
  recoveryHint: string;
  onRetry?: () => void;
}

export function ErrorState({ message, recoveryHint, onRetry }: ErrorStateProps) {
  // The failure and the way out are announced together. Most of these states offer no button, no
  // heading, and nothing else focusable, so a live region carrying only the failure would tell a
  // screen-reader user what broke and never mention the one thing that recovers it.
  return <div className="state-card state-card--error">
    <TriangleAlert aria-hidden="true" />
    <div role="alert">
      <p>{message}</p>
      <p className="state-card__recovery">{recoveryHint}</p>
    </div>
    {onRetry && (
      <button type="button" className="button button--secondary" onClick={onRetry}>Try again</button>
    )}
  </div>;
}

// Pressing a button cannot mint a session. A missing, expired, or revoked one — and a link used
// against the wrong role — recovers only by opening the link that carries the secret, so those states
// carry that instruction and no retry at all rather than a loop that is guaranteed to fail again.
const LINK_RECOVERY_CODES = new Set(['SESSION_REQUIRED', 'SESSION_EXPIRED', 'TOKEN_REVOKED', 'ROLE_FORBIDDEN']);

// The event itself has ended: its access window closed, the host deleted it, or retention purged it.
// This is the normal last state of every event rather than an exotic one, and no retry reaches past
// it either — so it is answered honestly instead of with a button and a guess about the network.
const LIFECYCLE_CODES = new Set(['EVENT_NOT_FOUND', 'EVENT_DELETED', 'EVENT_EXPIRED']);

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

export interface LoadFailure {
  message: string;
  recoveryHint: string;
  retryable: boolean;
}

// The code decides recoverability, never the prose: rewording a message must not be able to turn an
// unrecoverable session failure back into a retry loop.
export function describeLoadFailure(
  caught: unknown,
  role: keyof typeof LINK_RECOVERY_HINT,
  fallback: string,
): LoadFailure {
  const message = caught instanceof Error && caught.message ? caught.message : fallback;
  const code = caught instanceof ClientApiError ? caught.code : '';
  if (LINK_RECOVERY_CODES.has(code)) {
    return { message, recoveryHint: LINK_RECOVERY_HINT[role], retryable: false };
  }
  if (LIFECYCLE_CODES.has(code)) {
    return { message, recoveryHint: LIFECYCLE_HINT[role], retryable: false };
  }
  return { message, recoveryHint: RETRY_HINT, retryable: true };
}

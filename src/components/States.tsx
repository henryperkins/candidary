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
  // Only the failure itself interrupts; the hint and the action are read in place, in order.
  return <div className="state-card state-card--error">
    <TriangleAlert aria-hidden="true" />
    <p role="alert">{message}</p>
    <p>{recoveryHint}</p>
    {onRetry && (
      <button type="button" className="button button--secondary" onClick={onRetry}>Try again</button>
    )}
  </div>;
}

// Pressing a button cannot mint a session. A missing, expired, or revoked one — and a link used
// against the wrong role — recovers only by opening the link that carries the secret, so those states
// carry that instruction and no retry at all rather than a loop that is guaranteed to fail again.
const LINK_RECOVERY_CODES = new Set(['SESSION_REQUIRED', 'SESSION_EXPIRED', 'TOKEN_REVOKED', 'ROLE_FORBIDDEN']);

const LINK_RECOVERY_HINT = {
  guest: 'Open the latest guest link from your host to start again.',
  manager: 'Open the latest management link you saved to start again.',
};

const RETRY_HINT = 'Your connection may have dropped. Try again in a moment.';

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
  return LINK_RECOVERY_CODES.has(code)
    ? { message, recoveryHint: LINK_RECOVERY_HINT[role], retryable: false }
    : { message, recoveryHint: RETRY_HINT, retryable: true };
}

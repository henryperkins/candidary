import { LoaderCircle, TriangleAlert } from 'lucide-react';

import type { ApiErrorCode } from '../../shared/errors';
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

export type LoadFailureKind = 'latest-link' | 'ended-event' | 'retry';

// Every server code makes an explicit recovery decision here. `satisfies Record<ApiErrorCode, …>`
// turns a future API-code addition into a compile failure instead of silently falling into retry.
const LOAD_FAILURE_KIND = {
  EVENT_NOT_FOUND: 'ended-event',
  EVENT_DELETED: 'ended-event',
  EVENT_EXPIRED: 'ended-event',
  SESSION_REQUIRED: 'latest-link',
  SESSION_EXPIRED: 'latest-link',
  ROLE_FORBIDDEN: 'latest-link',
  UPLOADS_DISABLED: 'retry',
  GALLERY_HIDDEN: 'retry',
  TOKEN_REVOKED: 'latest-link',
  FILE_TYPE_UNSUPPORTED: 'retry',
  FILE_TOO_LARGE: 'retry',
  EVENT_MEDIA_LIMIT: 'retry',
  EVENT_STORAGE_LIMIT: 'retry',
  UPLOAD_RESERVATION_EXPIRED: 'retry',
  UPLOAD_OBJECT_MISSING: 'retry',
  UPLOAD_FINALIZE_CONFLICT: 'retry',
  MEDIA_STATE_CONFLICT: 'retry',
  EXPORT_ALREADY_ACTIVE: 'retry',
  EXPORT_EMPTY: 'retry',
  EXPORT_LIMIT_EXCEEDED: 'retry',
  EXPORT_FAILED: 'retry',
  VALIDATION_FAILED: 'retry',
  CSRF_INVALID: 'retry',
  ORIGIN_FORBIDDEN: 'retry',
  INTERNAL_ERROR: 'retry',
} as const satisfies Record<ApiErrorCode, LoadFailureKind>;

export function classifyApiErrorCode(code: ApiErrorCode): LoadFailureKind {
  return LOAD_FAILURE_KIND[code];
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
  const kind = caught instanceof ClientApiError ? classifyApiErrorCode(caught.code) : 'retry';
  if (kind === 'latest-link') {
    return { message, recoveryHint: LINK_RECOVERY_HINT[role], retryable: false };
  }
  if (kind === 'ended-event') {
    return { message, recoveryHint: LIFECYCLE_HINT[role], retryable: false };
  }
  return { message, recoveryHint: RETRY_HINT, retryable: true };
}

import type { ApiErrorCode } from './errors';

export type LoadFailureKind = 'latest-link' | 'ended-event' | 'sign-in' | 'retry';

export interface LoadFailureDecision {
  readonly kind: LoadFailureKind;
  readonly offerSignIn: boolean;
}

const decision = (
  kind: LoadFailureKind,
  offerSignIn = false,
): LoadFailureDecision => ({ kind, offerSignIn });

const LOAD_FAILURE_DECISION = {
  EVENT_NOT_FOUND: decision('ended-event'),
  EVENT_DELETED: decision('ended-event'),
  EVENT_EXPIRED: decision('ended-event'),
  SESSION_REQUIRED: decision('latest-link', true),
  SESSION_EXPIRED: decision('latest-link', true),
  ROLE_FORBIDDEN: decision('latest-link', true),
  RESOURCE_FORBIDDEN: decision('retry'),
  OWNER_CLAIM_REQUIRED: decision('retry'),
  UPLOADS_DISABLED: decision('retry'),
  GALLERY_HIDDEN: decision('retry'),
  TOKEN_REVOKED: decision('latest-link', true),
  GUEST_LINK_UNAVAILABLE: decision('retry'),
  FILE_TYPE_UNSUPPORTED: decision('retry'),
  FILE_TOO_LARGE: decision('retry'),
  EVENT_MEDIA_LIMIT: decision('retry'),
  EVENT_STORAGE_LIMIT: decision('retry'),
  UPLOAD_RESERVATION_EXPIRED: decision('retry'),
  UPLOAD_OBJECT_MISSING: decision('retry'),
  UPLOAD_FINALIZE_CONFLICT: decision('retry'),
  MEDIA_STATE_CONFLICT: decision('retry'),
  EXPORT_ALREADY_ACTIVE: decision('retry'),
  EXPORT_EMPTY: decision('retry'),
  EXPORT_LIMIT_EXCEEDED: decision('retry'),
  EXPORT_FAILED: decision('retry'),
  VALIDATION_FAILED: decision('retry'),
  CSRF_INVALID: decision('retry'),
  ORIGIN_FORBIDDEN: decision('retry'),
  HOST_SESSION_REQUIRED: decision('sign-in', true),
  LOGIN_CREDENTIALS_INVALID: decision('retry'),
  LOGIN_CODE_INVALID: decision('retry'),
  LOGIN_CODE_EXPIRED: decision('retry'),
  LOGIN_RATE_LIMITED: decision('retry'),
  RATE_LIMITED: decision('retry'),
  LOGIN_EMAIL_UNDELIVERABLE: decision('retry'),
  ACCOUNT_DISABLED: decision('latest-link'),
  INTERNAL_ERROR: decision('retry'),
} as const satisfies Record<ApiErrorCode, LoadFailureDecision>;

export function failureDecisionForCode(code: ApiErrorCode): LoadFailureDecision {
  return LOAD_FAILURE_DECISION[code];
}

export function classifyApiErrorCode(code: ApiErrorCode): LoadFailureKind {
  return failureDecisionForCode(code).kind;
}

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
  UPLOAD_RESERVATION_CANCELED: decision('retry'),
  UPLOAD_OBJECT_MISSING: decision('retry'),
  UPLOAD_FINALIZE_CONFLICT: decision('retry'),
  MEDIA_STATE_CONFLICT: decision('retry'),
  REVISION_CONFLICT: decision('retry'),
  ALBUM_FULL: decision('retry'),
  ALBUM_SHARE_UNAVAILABLE: decision('retry'),
  MESSAGE_SUBMISSION_CONFLICT: decision('retry'),
  MESSAGE_STATE_CONFLICT: decision('retry'),
  MESSAGE_EVENT_LIMIT: decision('retry'),
  MESSAGE_PURGED: decision('retry'),
  EVENT_PHASE_CONFLICT: decision('retry'),
  EXPORT_ALREADY_ACTIVE: decision('retry'),
  EXPORT_EMPTY: decision('retry'),
  EXPORT_LIMIT_EXCEEDED: decision('retry'),
  EXPORT_MEDIA_UPGRADE_REQUIRED: decision('retry'),
  EXPORT_FAILED: decision('retry'),
  // Retrying this job cannot work — its frozen bytes are gone. The recovery is
  // preparing the current collection, which is an ordinary action on the same
  // surface, so this stays in the retryable family rather than escalating.
  EXPORT_SOURCE_REMOVED: decision('retry'),
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
  // Disabling a printed entry is irreversible and has no replacement link, so
  // offering "get the latest link" would be a promise this product cannot keep.
  EVENT_ENTRY_UNAVAILABLE: decision('ended-event'),
  RSVP_UNAVAILABLE: decision('retry'),
  RSVP_CLOSED: decision('retry'),
  // The printed QR still works; only the household session lapsed, and the RSVP
  // flow sends the guest back to exact lookup before this table is consulted.
  RSVP_SESSION_REQUIRED: decision('retry'),
  RSVP_HOUSEHOLD_CONFLICT: decision('retry'),
  RSVP_SUBMISSION_CONFLICT: decision('retry'),
  RSVP_ROSTER_INVALID: decision('retry'),
  RSVP_IMPORT_CONFLICT: decision('retry'),
  RSVP_ROSTER_BATCH_TOO_LARGE: decision('retry'),
  RSVP_ROSTER_BATCH_CONFLICT: decision('retry'),
  RSVP_ROSTER_BATCH_IDEMPOTENCY_CONFLICT: decision('retry'),
  // Every cover code is Manager-only. None is reachable from a guest load, so
  // none of `latest-link`, `ended-event`, or `sign-in` describes what happened —
  // a manager whose upload was rejected corrects it and tries again. This is the
  // classification, not a placeholder, and `offerSignIn` stays off deliberately.
  COVER_SOURCE_UNSUPPORTED: decision('retry'),
  COVER_SOURCE_TOO_SMALL: decision('retry'),
  COVER_MASTER_BUDGET_EXHAUSTED: decision('retry'),
  COVER_PREVIEW_BUDGET_EXHAUSTED: decision('retry'),
  COVER_OUTPUT_BUDGET_EXHAUSTED: decision('retry'),
  COVER_DRAFT_LIMIT: decision('retry'),
  COVER_RAW_STORAGE_LIMIT: decision('retry'),
  COVER_DRAFT_STATE_CONFLICT: decision('retry'),
  COVER_PUBLICATION_CONFLICT: decision('retry'),
  COVER_RENDER_UNAVAILABLE: decision('retry'),
  INTERNAL_ERROR: decision('retry'),
} as const satisfies Record<ApiErrorCode, LoadFailureDecision>;

const UNKNOWN_FAILURE_DECISION = decision('retry');

export function failureDecisionForCode(code: string): LoadFailureDecision {
  return Object.prototype.hasOwnProperty.call(LOAD_FAILURE_DECISION, code)
    ? LOAD_FAILURE_DECISION[code as ApiErrorCode]
    : UNKNOWN_FAILURE_DECISION;
}

export function classifyApiErrorCode(code: ApiErrorCode): LoadFailureKind {
  return failureDecisionForCode(code).kind;
}

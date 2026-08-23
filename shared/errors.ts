export type ApiErrorCode =
  | 'EVENT_NOT_FOUND'
  | 'EVENT_DELETED'
  | 'EVENT_EXPIRED'
  | 'SESSION_REQUIRED'
  | 'SESSION_EXPIRED'
  | 'ROLE_FORBIDDEN'
  | 'RESOURCE_FORBIDDEN'
  | 'OWNER_CLAIM_REQUIRED'
  | 'UPLOADS_DISABLED'
  | 'GALLERY_HIDDEN'
  | 'TOKEN_REVOKED'
  | 'GUEST_LINK_UNAVAILABLE'
  | 'FILE_TYPE_UNSUPPORTED'
  | 'FILE_TOO_LARGE'
  | 'EVENT_MEDIA_LIMIT'
  | 'EVENT_STORAGE_LIMIT'
  | 'UPLOAD_RESERVATION_EXPIRED'
  | 'UPLOAD_OBJECT_MISSING'
  | 'UPLOAD_FINALIZE_CONFLICT'
  | 'MEDIA_STATE_CONFLICT'
  | 'REVISION_CONFLICT'
  | 'ALBUM_FULL'
  | 'ALBUM_SHARE_UNAVAILABLE'
  | 'MESSAGE_SUBMISSION_CONFLICT'
  | 'MESSAGE_STATE_CONFLICT'
  | 'MESSAGE_EVENT_LIMIT'
  | 'MESSAGE_PURGED'
  | 'EVENT_PHASE_CONFLICT'
  | 'EXPORT_ALREADY_ACTIVE'
  | 'EXPORT_EMPTY'
  | 'EXPORT_LIMIT_EXCEEDED'
  | 'EXPORT_MEDIA_UPGRADE_REQUIRED'
  | 'EXPORT_FAILED'
  | 'VALIDATION_FAILED'
  | 'CSRF_INVALID'
  | 'ORIGIN_FORBIDDEN'
  | 'HOST_SESSION_REQUIRED'
  | 'LOGIN_CREDENTIALS_INVALID'
  | 'LOGIN_CODE_INVALID'
  | 'LOGIN_CODE_EXPIRED'
  | 'LOGIN_RATE_LIMITED'
  | 'RATE_LIMITED'
  | 'LOGIN_EMAIL_UNDELIVERABLE'
  | 'ACCOUNT_DISABLED'
  | 'EVENT_ENTRY_UNAVAILABLE'
  | 'RSVP_UNAVAILABLE'
  | 'RSVP_CLOSED'
  | 'RSVP_SESSION_REQUIRED'
  | 'RSVP_HOUSEHOLD_CONFLICT'
  | 'RSVP_SUBMISSION_CONFLICT'
  | 'RSVP_ROSTER_INVALID'
  | 'RSVP_IMPORT_CONFLICT'
  | 'RSVP_ROSTER_BATCH_TOO_LARGE'
  | 'RSVP_ROSTER_BATCH_CONFLICT'
  | 'RSVP_ROSTER_BATCH_IDEMPOTENCY_CONFLICT'
  // Event cover. `FILE_TYPE_UNSUPPORTED` is deliberately not reused: the
  // preview route already returns it when the Images binding is unavailable,
  // so its name contradicts its meaning and a cover failure needs its own.
  //
  // A lost `cover_revision` compare-and-swap deliberately gets no code here.
  // The house precedent for a lost optimistic guard is `VALIDATION_FAILED` 409
  // (`worker/routes/manage.ts`, recorded in `docs/operations.md`), and cover
  // conflicts carry their recovery view in the response envelope rather than in
  // `ApiErrorDetails`.
  | 'COVER_SOURCE_UNSUPPORTED'
  | 'COVER_SOURCE_TOO_SMALL'
  | 'COVER_MASTER_BUDGET_EXHAUSTED'
  | 'COVER_PREVIEW_BUDGET_EXHAUSTED'
  | 'COVER_OUTPUT_BUDGET_EXHAUSTED'
  | 'COVER_DRAFT_LIMIT'
  | 'COVER_RAW_STORAGE_LIMIT'
  | 'COVER_DRAFT_STATE_CONFLICT'
  | 'COVER_PUBLICATION_CONFLICT'
  | 'COVER_RENDER_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export interface RsvpRosterBatchConflictTarget {
  clientHouseholdId: string;
  householdId: string;
  currentHouseholdVersion: number | null;
  state: 'changed' | 'archived' | 'missing';
}

export interface RsvpRosterBatchConflictDetails {
  currentRosterVersion: number;
  targets: RsvpRosterBatchConflictTarget[];
}

export type ApiErrorDetails = RsvpRosterBatchConflictDetails;

export interface ApiErrorBody {
  code: ApiErrorCode;
  message: string;
  requestId: string;
  fieldErrors?: Record<string, string>;
  details?: ApiErrorDetails;
}

export class ApiError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message: string,
    public readonly status = 400,
    public readonly fieldErrors?: Record<string, string>,
    public readonly details?: ApiErrorDetails,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function toErrorResponse(error: unknown, requestId: string): { status: number; body: ApiErrorBody } {
  if (error instanceof ApiError) {
    return {
      status: error.status,
      body: {
        code: error.code,
        message: error.message,
        ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
        ...(error.details ? { details: error.details } : {}),
        requestId,
      },
    };
  }

  return {
    status: 500,
    body: {
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong. Try again and keep this request ID if the problem continues.',
      requestId,
    },
  };
}

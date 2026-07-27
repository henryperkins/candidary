export type ApiErrorCode =
  | 'EVENT_NOT_FOUND'
  | 'EVENT_DELETED'
  | 'EVENT_EXPIRED'
  | 'SESSION_REQUIRED'
  | 'SESSION_EXPIRED'
  | 'ROLE_FORBIDDEN'
  | 'UPLOADS_DISABLED'
  | 'GALLERY_HIDDEN'
  | 'TOKEN_REVOKED'
  | 'FILE_TYPE_UNSUPPORTED'
  | 'FILE_TOO_LARGE'
  | 'EVENT_MEDIA_LIMIT'
  | 'EVENT_STORAGE_LIMIT'
  | 'UPLOAD_RESERVATION_EXPIRED'
  | 'UPLOAD_OBJECT_MISSING'
  | 'UPLOAD_FINALIZE_CONFLICT'
  | 'MEDIA_STATE_CONFLICT'
  | 'EXPORT_ALREADY_ACTIVE'
  | 'EXPORT_EMPTY'
  | 'EXPORT_LIMIT_EXCEEDED'
  | 'EXPORT_FAILED'
  | 'VALIDATION_FAILED'
  | 'CSRF_INVALID'
  | 'ORIGIN_FORBIDDEN'
  | 'HOST_SESSION_REQUIRED'
  | 'LOGIN_CREDENTIALS_INVALID'
  | 'LOGIN_CODE_INVALID'
  | 'LOGIN_CODE_EXPIRED'
  | 'LOGIN_RATE_LIMITED'
  | 'LOGIN_EMAIL_UNDELIVERABLE'
  | 'ACCOUNT_DISABLED'
  | 'INTERNAL_ERROR';

export interface ApiErrorBody {
  code: ApiErrorCode;
  message: string;
  requestId: string;
  fieldErrors?: Record<string, string>;
}

export class ApiError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message: string,
    public readonly status = 400,
    public readonly fieldErrors?: Record<string, string>,
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


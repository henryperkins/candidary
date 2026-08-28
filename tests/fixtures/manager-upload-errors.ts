import type { ApiErrorBody } from '../../shared/errors';

export const MANAGER_UPLOAD_RESOURCE_FORBIDDEN_ERROR = {
  code: 'RESOURCE_FORBIDDEN',
  message: 'This upload belongs to a different Manager or event.',
  requestId: 'request-manager-upload-expired',
} satisfies ApiErrorBody;

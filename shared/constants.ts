export const SUPPORTED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
] as const;

export type SupportedImageType = (typeof SUPPORTED_IMAGE_TYPES)[number];

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_EVENT_MEDIA = 10_000;
export const MAX_EVENT_BYTES = 100 * 1024 * 1024 * 1024;
export const UPLOAD_BATCH_SIZE = 20;
export const MAX_EXPORT_PART_SOURCE_BYTES = 2 * 1024 * 1024 * 1024;
export const MANAGER_MEDIA_PAGE_SIZE = 24;
export const MANAGER_MEDIA_MAX_PAGE_SIZE = 50;
export const MANAGER_BULK_SELECTION_MAX = 50;
export const UPLOAD_URL_TTL_SECONDS = 10 * 60;
export const UPLOAD_RESERVATION_TTL_SECONDS = 15 * 60;
// The security notes name this file as the single source of truth for limits, so
// the password floor lives here rather than being asserted twice. Every hint the
// host reads is generated from it, so the number and the promise cannot drift.
//
// 15, because NIST SP 800-63B (Rev. 4) §3.1.1.2 requires a minimum of 15 characters
// wherever a password is the single authentication factor, and `/host/login` has no
// second factor. Eight is permitted only as one factor of MFA, which this is not.
export const MIN_HOST_PASSWORD_LENGTH = 15;
export const MAX_HOST_PASSWORD_LENGTH = 256;

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
// Four date digits are not enough to make an event date plausible. In
// particular, a partially typed year such as 0202 must never become durable.
export const MIN_EVENT_CALENDAR_YEAR = 1900;
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

// RSVP limits. `shared/rsvp.ts` re-exports the five capacity numbers so the
// domain module reads as one piece, but this file stays the single place a
// number is allowed to change.
export const MAX_EVENT_RSVP_CAPACITY = 500;
export const MAX_RSVP_HOUSEHOLDS = 500;
export const MAX_NAMED_INVITEES_PER_HOUSEHOLD = 20;
export const MAX_PLUS_ONES_PER_HOUSEHOLD = 10;
export const MAX_HOUSEHOLD_CAPACITY = 30;
// Household labels and person names, measured after whitespace collapse.
export const MAX_RSVP_TEXT_LENGTH = 80;
export const MAX_RSVP_HOUSEHOLD_KEY_LENGTH = 64;
// UTF-8 bytes, not code units. A 500-household roster is far under this.
export const MAX_RSVP_CSV_BYTES = 256 * 1024;
// Serialized JSON bytes for the universal additive roster preview/commit
// envelopes. This is separate from the source-file limit above.
export const MAX_RSVP_BATCH_BYTES = 512 * 1024;
export const MANAGER_RSVP_PAGE_SIZE = 50;

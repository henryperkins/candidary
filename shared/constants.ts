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

// Event cover limits. `shared/event-cover.ts` re-exports what its domain reads,
// on the same terms as `shared/rsvp.ts`: this file is still the only place a
// number changes.
//
// Every one of these is a DECIMAL literal, and that is load-bearing rather than
// stylistic. The Images binding accepts at most 20 MB at `.input()`, so the
// binary `MAX_IMAGE_BYTES` above (20 * 1024 * 1024 = 20,971,520) is over the
// ceiling and would fail at the transform instead of at reservation. Cover
// intake therefore has its own number and must never borrow that one.
export const COVER_UPLOAD_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
] as const;

export type CoverUploadMimeType = (typeof COVER_UPLOAD_MIME_TYPES)[number];

export const MAX_COVER_UPLOAD_BYTES = 19_000_000;
export const MAX_COVER_MASTER_BYTES = 12_000_000;
// After orientation. Enough to produce every 1x profile without upscaling,
// which is exactly the widest and tallest profile in the registry.
export const MIN_COVER_SOURCE_WIDTH = 620;
export const MIN_COVER_SOURCE_HEIGHT = 420;
export const MAX_COVER_MANUAL_ZOOM = 2.0;
// The fixed paper matte composited under every cover transform, so a
// transparent PNG or WebP cannot produce format-dependent edges. It is
// server-owned and never follows the event theme.
export const COVER_PAPER_MATTE = '#fffaf3';

export const MAX_LIVE_COVER_DRAFTS_PER_EVENT = 3;
export const MAX_LIVE_COVER_RAW_BYTES_PER_EVENT = 57_000_000;
export const MAX_COVER_PREVIEW_FILES_PER_DRAFT = 5;
export const MAX_COVER_PREVIEW_BYTES = 1_000_000;
export const MAX_COVER_PREVIEW_BYTES_PER_DRAFT = 5_000_000;

export const MAX_PREPARING_COVER_PUBLICATIONS_PER_EVENT = 1;
export const MAX_NONACTIVE_COVER_RENDER_SETS_PER_EVENT = 32;
export const MAX_RETAINED_COVER_RECEIPTS_PER_EVENT = 1_024;

// Fixed hourly windows, counted in D1 rather than in a rate-limit binding, so
// every count and non-counting replay is reconstructable after a restart.
export const MAX_COVER_RESERVATIONS_PER_HOUR = 12;
export const MAX_COVER_INSPECTIONS_PER_HOUR = 12;
export const MAX_COVER_PREVIEWS_PER_HOUR = 30;
export const MAX_COVER_PUBLICATIONS_PER_HOUR = 6;

export const MAX_COVER_BACKFILL_PAGE_SIZE = 100;
export const MAX_COVER_BACKFILL_CREATE_BATCH = 25;
export const MAX_COVER_BACKFILL_IN_FLIGHT = 25;
export const MAX_COVER_BACKFILL_CREATIONS_PER_MINUTE = 25;

export const MAX_COVER_PURGE_FENCES_PER_PASS = 10;
export const MAX_COVER_PURGE_PLATFORM_MUTATIONS_PER_PASS = 5;
export const COVER_CLEANUP_ROWS_PER_CLASS = 100;

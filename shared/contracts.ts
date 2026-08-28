import type { SupportedImageType } from './constants';
import type { EventCoverView, GuestEventCoverView } from './event-cover';
import type { ApiErrorBody, ApiErrorCode } from './errors';

// Access links only ever grant these two. Keeping `Role` narrow is what stops a
// host account from being mistaken for something an event token can mint.
export type Role = 'guest' | 'manager';
// What a session's subject is. `host` sessions belong to an account rather than
// to one event, and no access token can produce one.
export type SessionRole = Role | 'host';
export type EventHostRole = 'owner' | 'cohost';
// Emailed codes prove control of an address. They never sign a host in on their
// own — `verify` unlocks notifications, `reset` authorizes one password change.
export type ChallengePurpose = 'verify' | 'reset';
export type NotificationKind = 'getting_started' | 'event_reminder' | 'retention_warning';
export type UploadState = 'reserved' | 'stored' | 'failed' | 'deleted';
export type ModerationStatus = 'pending' | 'approved' | 'rejected';
export type PublicationStatus = 'unpublished' | 'published' | 'hidden';
export type TimelineSource = 'capture' | 'received';
export type ExportKind = 'complete' | 'album';
export type ExportState = 'queued' | 'running' | 'ready' | 'failed' | 'expired';

export const MANAGER_EXPORT_ERROR_CODES = [
  'EXPORT_SOURCE_MISSING',
  'EXPORT_SOURCE_REMOVED',
  'EXPORT_EVENT_DELETED',
  'EXPORT_GUESTBOOK_SNAPSHOT_INVALID',
  'EXPORT_SNAPSHOT_CHANGED',
  'EXPORT_WORKFLOW_DISPATCH_FAILED',
  'EXPORT_FAILED',
] as const;

export type ManagerExportErrorCode = typeof MANAGER_EXPORT_ERROR_CODES[number];

/** Never expose an export worker's internal diagnostic through Manager JSON. */
export function normalizeManagerExportErrorCode(
  value: string | null,
): ManagerExportErrorCode | null {
  if (value === null) return null;
  return (MANAGER_EXPORT_ERROR_CODES as readonly string[]).includes(value)
    ? value as ManagerExportErrorCode
    : 'EXPORT_FAILED';
}

export interface ApiSuccess<T> {
  data: T;
  requestId: string;
}

export interface RegistrationPendingResponse {
  registrationPending: true;
  resumeExpiresAt: string;
}

export interface RegistrationCompleteResponse {
  registered: true;
  boundEvent: boolean;
}

export interface HostSessionAccountView {
  id: string;
  email: string;
  displayName: string | null;
  emailVerified: boolean;
  notificationsEnabled: boolean;
}

// This is an allowlist, not a projection-by-omission. An EventRecord field added
// later stays private until the account dashboard explicitly names it here.
export interface HostSessionEventView {
  id: string;
  name: string;
  slug: string;
  eventDate: string;
  eventTimezone: string;
  storedMediaCount: number;
  managementAccessExpiresAt: string;
}

export interface HostSessionResponse {
  account: HostSessionAccountView;
  events: HostSessionEventView[];
}

export type ApiResult<T> = ApiSuccess<T> | ApiErrorBody;

export type EventThemePresetId =
  | 'candidary-default'
  | 'garden-party'
  | 'midnight-film'
  | 'coastal-light';

export type HexColor = `#${string}`;
export type RgbaColor = `rgb(${number} ${number} ${number} / ${number}%)`;

export interface EventThemeOverridesV1 {
  primaryColor?: HexColor;
  accentColor?: HexColor;
}

export interface EventThemeConfigV1 {
  version: 1;
  presetId: EventThemePresetId;
  overrides: EventThemeOverridesV1;
}

export interface EventThemeTokens {
  page: HexColor;
  surface: HexColor;
  raisedSurface: HexColor;
  text: HexColor;
  pageText: HexColor;
  cardText: HexColor;
  mutedText: HexColor;
  secondaryMutedText: HexColor;
  quietText: HexColor;
  requiredText: HexColor;
  selectionSummaryText: HexColor;
  primary: HexColor;
  primaryForeground: HexColor;
  primaryHover: HexColor;
  primaryOnSurface: HexColor;
  primaryShadow: RgbaColor;
  accent: HexColor;
  accentForeground: HexColor;
  accentSoft: HexColor;
  accentSoftForeground: HexColor;
  border: HexColor;
  sectionBorder: HexColor;
  rememberedNameBorder: HexColor;
  reviewDivider: HexColor;
  inputBorder: HexColor;
  focus: HexColor;
  mediaPlaceholderStart: HexColor;
  mediaPlaceholderEnd: HexColor;
  mediaPlaceholderForeground: HexColor;
  heroStart: HexColor;
  heroMid: HexColor;
  heroEnd: HexColor;
  heroOverlayTop: RgbaColor;
  heroOverlayBottom: RgbaColor;
  coverOverlayTop: RgbaColor;
  coverOverlayBottom: RgbaColor;
  coverTextScrim: RgbaColor;
  fullscreenBackdrop: HexColor;
  fullscreenForeground: HexColor;
  inputShadow: RgbaColor;
  frameShadow: RgbaColor;
  inputRadius: `${number}px`;
  actionRadius: `${number}px`;
  cardRadius: `${number}px`;
  frameRadius: `${number}px`;
}

export interface ResolvedEventTheme {
  config: EventThemeConfigV1;
  tokens: EventThemeTokens;
}

export interface HostUploadAvailability {
  enabled: boolean;
  reason: 'event-unavailable' | 'media-cap' | 'storage-cap' | null;
}

export interface ManagerLinkRotationAvailability {
  enabled: boolean;
  reason: 'account-required' | null;
}

export interface EventView {
  id: string;
  slug: string;
  name: string;
  eventDate: string;
  welcomeMessage: string;
  guestbookPrompt: string;
  cover: EventCoverView;
  uploadsEnabled: boolean;
  galleryVisible: boolean;
  moderationRequired: boolean;
  reservedMediaCount: number;
  // Active delivered originals. Deliberately unchanged in meaning by recovery:
  // export freshness compares against this, so a trashed photo must leave it.
  storedMediaCount: number;
  reservedBytes: number;
  storedBytes: number;
  // Photos in Recently deleted. They are not delivered any more, but they still
  // hold their bytes and their slot: a Restore must never fail because later
  // uploads spent space this photo only looked like it had released. Manager
  // only — no guest projection carries either field.
  recoverableMediaCount: number;
  recoverableBytes: number;
  hostUploadAvailability: HostUploadAvailability;
  guestAccessExpiresAt: string;
  managementAccessExpiresAt: string;
  // Present only when this projection was authorized by an owning/cohosting
  // account. A management-link bearer cannot rotate itself and receives null.
  managerLinkRevision: number | null;
  managerLinkRotationAvailability: ManagerLinkRotationAvailability;
  purgeAfter: string;
  createdAt: string;
  deletedAt: string | null;
  eventTimezone: string;
  // The absolute instant the event begins, derived server-side from
  // `eventDate`, the host's local start time, and `eventTimezone`.
  eventStartAt: string;
  // That same instant as a 24-hour local wall clock in `eventTimezone`: what
  // the host typed, and what settings edits back.
  eventStartTime: string;
  // Whether photo delivery is effectively open right now — permitted, and past
  // its scheduled or manually advanced opening.
  photosOpen: boolean;
  photoIntakeState: PhotoIntakeState;
  // Relative delay to the next future scheduled opening or event start, or
  // null. Same reasoning as `lifecycleRecheckAfterMs`.
  photoIntakeRecheckAfterMs: number | null;
  rsvpEnabled: boolean;
  rsvpDeadlineAt: string | null;
  // The same instant as a calendar date in `eventTimezone`. Sent alongside the
  // absolute value so no browser has to reinterpret it in its own zone.
  rsvpDeadlineDate: string | null;
  rsvpRosterVersion: number;
  theme: ResolvedEventTheme;
}

// Deliberately an allowlist rather than an omission of what is secret: a field
// added to `EventView` should not reach a guest until somebody names it here.
// The phase is server-computed, because a guest device's clock is not evidence.
export type GuestEventView = Pick<
  EventView,
  | 'id'
  | 'slug'
  | 'name'
  | 'eventDate'
  | 'welcomeMessage'
  | 'guestbookPrompt'
  | 'uploadsEnabled'
  | 'galleryVisible'
  | 'moderationRequired'
  | 'eventTimezone'
  // Carried so the before-start surface can render a correctly zoned start
  // without asking the guest's device what time it is.
  | 'eventStartAt'
  | 'rsvpDeadlineAt'
  | 'rsvpDeadlineDate'
  | 'theme'
> & GuestPhaseView & { cover: GuestEventCoverView };

export type GuestbookSource = 'guest_note' | 'photo_caption';
export type GuestbookSharedVisibility = 'shared' | 'author_only';

export interface GuestbookNoteItem {
  id: string;
  source: 'guest_note';
  guestName: string | null;
  body: string;
  createdAt: string;
  state: 'pending' | 'approved' | 'rejected';
  visibility: GuestbookSharedVisibility;
}

export type DeletedGuestbookNoteItem = Omit<
  GuestbookNoteItem,
  'state' | 'visibility'
> & {
  state: 'deleted';
  visibility: 'host_only';
};

export interface GuestbookCaptionItem {
  id: string;
  source: 'photo_caption';
  mediaId: string;
  guestName: string | null;
  body: string;
  createdAt: string;
  state: 'unpublished' | 'published' | 'hidden';
  visibility: GuestbookSharedVisibility;
  previewAvailable: boolean;
}

export type GuestbookVisibleItem = GuestbookNoteItem | GuestbookCaptionItem;
export type GuestbookItem = GuestbookVisibleItem | DeletedGuestbookNoteItem;

export interface GuestbookNoteCompatibilityAliases {
  /** @deprecated Use `source`. */
  kind: 'message';
  /** @deprecated Use the source-specific `state`. */
  moderationStatus: 'pending' | 'approved' | 'rejected';
  /** @deprecated Caption items carry their media ID directly. */
  mediaId: null;
}

export interface GuestbookCaptionCompatibilityAliases {
  /** @deprecated Use `source`. */
  kind: 'caption';
  /** @deprecated Use the source-specific `state`. */
  moderationStatus: 'pending' | 'approved' | 'rejected';
  /** @deprecated Caption items carry their media ID directly. */
  mediaId: string;
}

export type GuestbookCompatibilityAliases =
  | GuestbookNoteCompatibilityAliases
  | GuestbookCaptionCompatibilityAliases;

type GuestbookNoteStateAliases =
  | { state: 'pending'; moderationStatus: 'pending' }
  | { state: 'approved'; moderationStatus: 'approved' }
  | { state: 'rejected'; moderationStatus: 'rejected' };

export type GuestGuestbookNoteItem = Omit<GuestbookNoteItem, 'state'>
  & { isOwn: boolean }
  & Omit<GuestbookNoteCompatibilityAliases, 'moderationStatus'>
  & GuestbookNoteStateAliases;

type GuestbookCaptionStateAliases =
  | { state: 'unpublished'; visibility: 'author_only'; moderationStatus: 'pending' }
  | { state: 'published'; visibility: 'shared'; moderationStatus: 'approved' }
  | { state: 'published'; visibility: 'author_only'; moderationStatus: 'rejected' }
  | { state: 'hidden'; visibility: 'author_only'; moderationStatus: 'rejected' };

export type GuestGuestbookCaptionItem = Omit<GuestbookCaptionItem, 'state' | 'visibility'>
  & { isOwn: boolean }
  & Omit<GuestbookCaptionCompatibilityAliases, 'moderationStatus'>
  & GuestbookCaptionStateAliases;

export type GuestGuestbookItem = GuestGuestbookNoteItem | GuestGuestbookCaptionItem;
export type ManagerGuestbookItem = GuestbookItem;

/** @deprecated Use the source-discriminated guestbook item contracts. */
export interface LegacyGuestbookItem {
  id: string;
  kind: 'message' | 'caption';
  guestName: string | null;
  body: string;
  createdAt: string;
  moderationStatus: 'pending' | 'approved' | 'rejected';
  mediaId: string | null;
}

// Guest media allowlists. Every one of these is written out field by field
// rather than derived from a repository record, because a guest response is the
// one place where "we forgot to strip it" is indistinguishable from "we meant to
// publish it". Nothing here carries an uploader session id, an object key, a
// bucket generation, byte or MIME metadata, an idempotency key, a reservation
// field, moderation internals, or Album membership.

/**
 * A published photo as one guest sees another guest's contribution.
 *
 * There is deliberately no `originalFilename`: a filename is the uploader's
 * device talking, and the shared gallery renders `Shared photo` instead.
 */
export interface GuestGalleryMediaView {
  id: string;
  guestName: string;
  caption: string | null;
  previewAvailable: boolean;
}

/**
 * A guest's own contribution. They may see the filename they sent and how far
 * the transfer got, because both are theirs; `deleted` is absent because a
 * guest's own deletion is permanent and the row simply stops being listed.
 */
export interface GuestContributionMediaView {
  id: string;
  originalFilename: string;
  caption: string | null;
  uploadState: 'reserved' | 'stored' | 'failed';
  previewAvailable: boolean;
  createdAt: string;
}

/** The acknowledgement of a guest's own permanent deletion. */
export interface GuestContributionDeletionView {
  id: string;
  deleted: true;
}

/** What the upload queue needs to drive one photo, and nothing else. */
export interface UploadMediaView {
  id: string;
  mimeType: SupportedImageType;
  uploadState: UploadState;
}

/**
 * One reservation outcome. `uploadUrl` exists only for an accepted reservation
 * that still needs its bytes, and is always a relative same-origin path.
 */
export type UploadBatchItemView =
  | {
      idempotencyKey: string;
      status: 'accepted';
      alreadyDelivered: boolean;
      media: UploadMediaView;
      uploadUrl?: string;
      uploadUrlExpiresAt?: string;
    }
  | {
      idempotencyKey: string;
      status: 'rejected';
      error: { code: ApiErrorCode; message: string };
    };

export interface ManagerMediaView {
  id: string;
  originalFilename: string;
  guestName: string;
  caption: string | null;
  publicationStatus: PublicationStatus;
  uploadState: UploadState;
  previewAvailable: boolean;
  width: number | null;
  height: number | null;
  createdAt: string;
}

/**
 * A photo the host moved to Recently deleted.
 *
 * No preview, storage, object, or session field appears here: a recoverable row
 * is retained, not delivered. The host recognizes it by name, guest, and caption,
 * and `restoreUntil` is the server's answer about how long that stays true.
 */
export interface ManagerTrashedMediaView {
  id: string;
  originalFilename: string;
  guestName: string;
  caption: string | null;
  trashedAt: string;
  restoreUntil: string;
}

export interface ManagerGalleryMediaView {
  id: string;
  originalFilename: string;
  guestName: string;
  caption: string | null;
  publicationStatus: PublicationStatus;
  previewAvailable: boolean;
  width: number | null;
  height: number | null;
  receivedAt: string;
  timelineAt: string;
  timelineSource: TimelineSource;
  isFavorite: boolean;
}

// Album. One curated artifact per event, ordered, divided by host-authored sections.
//
// `isFavorite` above is album membership — the transport keeps saying favorite because
// renaming it would be a breaking change to four components for a vocabulary shift the
// reader never sees. Everything below is the *order* that membership is read in.
//
// A section carries its own id because it is the only entry with no natural key: two
// sections may share a heading, and reorder, rename, and remove all need to name one.

export type AlbumEntryKind = 'photo' | 'section';

/** What the host stores: a position, never a membership claim. */
export type AlbumEntryInput =
  | { kind: 'photo'; mediaId: string }
  | { kind: 'section'; id: string; heading: string };

/**
 * What the host reads back. Photo entries are resolved against the live picked set, so
 * an entry whose photo was unpicked or deleted elsewhere is absent rather than broken —
 * and a pick with no stored position is appended in timeline order, which is what makes
 * picking in Library land somewhere sensible without a second write.
 */
/**
 * Whether a retained slot can still be brought back.
 *
 * `expired-cleanup-pending` is not a bug and not a promise: the deadline passed,
 * so Restore is gone, but an accepted export still holds the bytes and the slot
 * survives until that hold releases and cleanup runs.
 */
export type AlbumRetainedSlotState = 'recoverable' | 'expired-cleanup-pending';

/**
 * The opaque stand-in for a picked photo the host moved to Recently deleted.
 *
 * This is the one Album surface allowed to name a trashed row, and it is
 * deliberately not a photo: no image URL, caption, guest, or filename crosses
 * here, because the point of trashing was to stop showing the photograph. Its
 * timeline instant is ordering-only Manager data, so Reset can keep this slot
 * among the live photos without exposing any photo content or provenance.
 */
export interface AlbumRetainedSlotView {
  mediaId: string;
  restoreUntil: string;
  state: AlbumRetainedSlotState;
  timelineAt: string;
}

export type AlbumEntryView =
  | { kind: 'photo'; photo: ManagerGalleryMediaView }
  | { kind: 'photo-retained'; slot: AlbumRetainedSlotView }
  | { kind: 'section'; id: string; heading: string };

export interface AlbumMetadataInput {
  title: string;
  description: string;
  coverMediaId: string | null;
}

export interface AlbumMetadataView extends AlbumMetadataInput {
  effectiveCoverMediaId: string | null;
}

export interface AlbumSaveRequest {
  revision: number;
  entries: AlbumEntryInput[];
  /** Optional only for compatibility with clients deployed before migration 0018. */
  metadata?: AlbumMetadataInput;
}

export type AlbumReconciliation =
  | { kind: 'initialize' }
  | { kind: 'historical'; historicalPickCount: number }
  | { kind: 'over-capacity'; pickCount: number; historicalPickCount: number }
  | null;

export interface AlbumView extends AlbumMetadataInput {
  /** Compare-and-set token. Every write carries the revision it was composed against. */
  revision: number;
  /** False until the host first commits an album. */
  saved: boolean;
  /** Event-owned counter advanced by every actual Album-eligibility change. */
  pickGeneration: number;
  /** Server-computed first-read category; raw per-photo provenance never crosses the API. */
  reconciliation: AlbumReconciliation;
  effectiveCoverMediaId: string | null;
  /**
   * The chosen cover is a photo the host moved to Recently deleted. The slot is
   * held — a timely Restore puts the same photograph back as the cover — while
   * `effectiveCoverMediaId` falls through to the first visible photo meanwhile.
   */
  coverRetained: AlbumRetainedSlotView | null;
  entries: AlbumEntryView[];
  /** Photos in the album. Sections are excluded — a divider is not a photograph. */
  photoCount: number;
  /** Retained slots. Not photographs, but they hold both album and event capacity. */
  retainedCount: number;
  sectionCount: number;
  totalBytes: number;
}

export interface GalleryAudienceSummaryView {
  albumPhotoCount: number;
  albumEntryCount: number;
  albumLink: { active: boolean; sharedAt: string | null };
  guestGalleryVisible: boolean;
  guestGalleryPublishedCount: number;
}

export type PublicAlbumEntryView =
  | { kind: 'section'; id: string; heading: string }
  | {
      kind: 'photo';
      photo: { id: string; caption: string | null; previewAvailable: boolean };
    };

export interface PublicAlbumView {
  title: string;
  description: string;
  coverMediaId: string | null;
  entries: PublicAlbumEntryView[];
  photoCount: number;
}

export interface AlbumShareView {
  active: true;
  url: string;
  sharedAt: string;
}

export type AlbumShareStatus = AlbumShareView | null;

// RSVP. Every shape below is written out rather than derived from a database
// record, because the difference between what a household may see and what a
// host may see is the whole privacy story.

export type RsvpAttendance = 'pending' | 'attending' | 'declined';
export type RsvpInviteeKind = 'named' | 'plus_one';
export type RsvpState = 'disabled' | 'paused' | 'open' | 'closed';
// `before-start` is a product state of its own, not merely a reason photos are
// unavailable: the deadline has gone, the event has not begun, and a household
// may still read back what it already sent. `waiting` now means exactly one
// thing — the event has started and photo delivery is currently unavailable.
export type GuestEventPhase =
  | 'rsvp-primary'
  | 'before-start'
  | 'photos-primary'
  | 'waiting';
// Phase says *where* RSVP appears; this says *whether and how*. `rsvpState`
// still supplies the paused/closed wording. Split apart because `rsvpState`
// alone cannot tell "closed before the start" from "closed because the event
// started", and resolving that in a browser would mean comparing a clock.
export type RsvpAccess = 'editable' | 'read-only' | 'unavailable';
// Who committed a response. Hosts may correct a household after the deadline;
// households never act as a host.
export type RsvpActor = 'household' | 'host';

export type GuestReadSurfaces =
  | { available: true; reason: null }
  | { available: false; reason: 'before-photo-open' };

// What the host's photo-delivery controls are chosen from. `paused` is decided
// first, so an event whose capability is withheld never reports itself as
// scheduled to open.
export type PhotoIntakeState = 'scheduled' | 'open-early' | 'open' | 'paused';

export interface GuestPhaseView {
  phase: GuestEventPhase;
  rsvpState: RsvpState;
  rsvpAccess: RsvpAccess;
  guestReadSurfaces: GuestReadSurfaces;
  // A *relative* delay to the next guest-view boundary, computed by the server
  // from the same instant that resolved this view, or null when none remains.
  // Relative on purpose: an absolute instant compared against `Date.now()` is a
  // browser-clock comparison, and a device whose clock is wrong would switch
  // early or hours late.
  lifecycleRecheckAfterMs: number | null;
}

export interface RsvpInviteeView {
  id: string;
  kind: RsvpInviteeKind;
  displayName: string | null;
  attendance: RsvpAttendance;
  order: number;
}

export interface RsvpHouseholdView {
  id: string;
  label: string;
  version: number;
  editable: boolean;
  renewalRequired: boolean;
  deadlineAt: string;
  invitees: RsvpInviteeView[];
  firstRespondedAt: string | null;
  latestRespondedAt: string | null;
  latestActor: RsvpActor | null;
}

export interface RsvpLookupRequest {
  firstName: string;
  secondName?: string;
}

// One generic shape covers no match, paused RSVP, an unresolved second name,
// archived households, and closed events with nothing saved. Nothing here may
// tell a stranger whether a name is on the list.
export type RsvpLookupResponse =
  | { status: 'matched'; household: RsvpHouseholdView }
  | { status: 'second_name_required' }
  | { status: 'not_available'; message: string };

export interface RsvpSubmissionInvitee {
  id: string;
  attendance: Exclude<RsvpAttendance, 'pending'>;
  displayName: string | null;
}

export interface RsvpSubmissionRequest {
  version: number;
  idempotencyKey: string;
  invitees: RsvpSubmissionInvitee[];
}

export interface RsvpSubmissionResponse {
  household: RsvpHouseholdView;
  committedVersion: number;
  replayed: boolean;
}

export interface RsvpSummary {
  invitedCapacity: number;
  namedInvitees: number;
  plusOneCapacity: number;
  attending: number;
  declined: number;
  awaitingResponse: number;
  householdsResponded: number;
  householdsAwaitingResponse: number;
}

export type RsvpImportField =
  | 'file'
  | 'household_key'
  | 'household_label'
  | 'invitee_name'
  | 'plus_one_slots';

export type RsvpImportIssueCode =
  | 'file_too_large'
  | 'file_empty'
  | 'header_invalid'
  | 'row_malformed'
  | 'household_key_invalid'
  | 'household_label_invalid'
  | 'invitee_name_invalid'
  | 'plus_one_slots_invalid'
  | 'household_label_inconsistent'
  | 'household_plus_one_inconsistent'
  | 'household_duplicate_name'
  | 'household_lookup_unresolvable'
  | 'household_named_limit'
  | 'household_capacity_limit'
  | 'event_household_limit'
  | 'event_capacity_limit';

// `row` is the one-based line in the uploaded file: 1 is the header, data
// starts at 2, and 0 means the file as a whole.
export interface RsvpImportIssue {
  row: number;
  field: RsvpImportField;
  code: RsvpImportIssueCode;
  message: string;
  blocking: true;
}

export interface RsvpImportTotals {
  households: number;
  namedInvitees: number;
  plusOneCapacity: number;
  invitedCapacity: number;
}

export interface RsvpImportPreview {
  issues: RsvpImportIssue[];
  totals: RsvpImportTotals;
  sourceDigest: string;
  rosterVersion: number;
}

export interface RsvpImportCommitRequest {
  csv: string;
  sourceDigest: string;
  expectedRosterVersion: number;
}

export interface RsvpImportCommitResponse {
  totals: RsvpImportTotals;
  rosterVersion: number;
}

export type RsvpRosterBatchKeyProvenance = 'supplied' | 'generated';

export interface RsvpRosterBatchHouseholdKey {
  value: string;
  provenance: RsvpRosterBatchKeyProvenance;
}

export interface RsvpRosterBatchSuppliedHouseholdKey
  extends RsvpRosterBatchHouseholdKey {
  provenance: 'supplied';
}

export interface RsvpRosterBatchCreateInvitee {
  clientInviteeId: string;
  displayName: string;
}

export interface RsvpRosterBatchAppendInvitee extends RsvpRosterBatchCreateInvitee {
  attendance?: Exclude<RsvpAttendance, 'pending'>;
}

export interface RsvpRosterBatchPlusOneResponse {
  clientInviteeId: string;
  attendance: Exclude<RsvpAttendance, 'pending'>;
  displayName: string | null;
}

export interface RsvpRosterBatchCreate {
  clientHouseholdId: string;
  // Preview input may preserve a host-supplied key or omit it. Only the Worker
  // adds generated provenance to the canonical preview returned for commit.
  householdKey?: RsvpRosterBatchSuppliedHouseholdKey;
  label: string;
  namedInvitees: RsvpRosterBatchCreateInvitee[];
  plusOneSlots: number;
}

export interface RsvpRosterBatchCanonicalCreate extends Omit<RsvpRosterBatchCreate, 'householdKey'> {
  householdKey: RsvpRosterBatchHouseholdKey;
}

export interface RsvpRosterBatchAppend {
  clientHouseholdId: string;
  householdId: string;
  expectedHouseholdVersion: number;
  namedInvitees: RsvpRosterBatchAppendInvitee[];
  plusOneSlotsToAdd: number;
  newPlusOneResponses?: RsvpRosterBatchPlusOneResponse[];
}

export interface RsvpRosterBatchDraft {
  creates: RsvpRosterBatchCreate[];
  appends: RsvpRosterBatchAppend[];
}

export interface RsvpRosterCanonicalBatch {
  creates: RsvpRosterBatchCanonicalCreate[];
  appends: RsvpRosterBatchAppend[];
}

export type RsvpRosterBatchIssueSeverity = 'blocking' | 'advisory';

export type RsvpRosterBatchIssueCode =
  | 'household_key_invalid'
  | 'household_key_mapping_inconsistent'
  | 'household_key_in_use'
  | 'possible_existing_household_match'
  | 'household_label_invalid'
  | 'invitee_name_invalid'
  | 'plus_one_slots_invalid'
  | 'household_named_required'
  | 'household_duplicate_name'
  | 'household_lookup_unresolvable'
  | 'household_named_limit'
  | 'household_capacity_limit'
  | 'event_household_limit'
  | 'event_capacity_limit'
  | 'append_empty'
  | 'target_household_archived'
  | 'target_household_missing'
  | 'target_household_version_changed'
  | 'attendance_required'
  | 'plus_one_name_required';

export interface RsvpRosterBatchIssue {
  clientHouseholdId?: string;
  clientInviteeId?: string;
  field: string;
  code: RsvpRosterBatchIssueCode;
  message: string;
  severity: RsvpRosterBatchIssueSeverity;
}

export interface RsvpRosterBatchTotals {
  householdsCreated: number;
  householdsUpdated: number;
  namedInviteesAdded: number;
  plusOneCapacityAdded: number;
  invitedCapacityAdded: number;
  resultingHouseholds: number;
  resultingInvitedCapacity: number;
}

export interface RsvpRosterBatchTargetVersion {
  clientHouseholdId: string;
  householdId: string;
  version: number;
}

export interface RsvpRosterBatchPreviewRequest {
  batch: RsvpRosterBatchDraft;
  expectedRosterVersion: number;
}

export interface RsvpRosterBatchPreviewResponse {
  canonicalBatch: RsvpRosterCanonicalBatch;
  rosterVersion: number;
  targetVersions: RsvpRosterBatchTargetVersion[];
  totals: RsvpRosterBatchTotals;
  issues: RsvpRosterBatchIssue[];
  previewDigest: string;
  canCommit: boolean;
}

export interface RsvpRosterBatchCommitRequest {
  canonicalBatch: RsvpRosterCanonicalBatch;
  previewDigest: string;
  expectedRosterVersion: number;
  idempotencyKey: string;
}

export interface RsvpRosterBatchCreatedHousehold {
  clientHouseholdId: string;
  householdId: string;
}

export interface RsvpRosterBatchUpdatedHousehold {
  clientHouseholdId: string;
  householdId: string;
  committedVersion: number;
}

export interface RsvpRosterBatchReceipt {
  createdHouseholds: RsvpRosterBatchCreatedHousehold[];
  updatedHouseholds: RsvpRosterBatchUpdatedHousehold[];
  totals: RsvpRosterBatchTotals;
  committedRosterVersion: number;
}

export interface RsvpRosterBatchCommitResponse extends RsvpRosterBatchReceipt {
  currentRosterVersion: number;
  replayed: boolean;
}

export type RsvpHouseholdFilter = 'all' | 'responded' | 'awaiting' | 'archived';

export interface RsvpHouseholdListItem {
  id: string;
  householdKey: string;
  label: string;
  version: number;
  archivedAt: string | null;
  attending: number;
  declined: number;
  awaitingResponse: number;
  invitedCapacity: number;
  firstRespondedAt: string | null;
  latestRespondedAt: string | null;
  latestActor: RsvpActor | null;
  updatedAt: string;
}

export interface RsvpHouseholdListPage {
  households: RsvpHouseholdListItem[];
  nextCursor: string | null;
}

// What a host sees for one household. It carries the stable key and archive
// state a household view must never expose, and no session-scoped write flags.
export interface RsvpHouseholdDetail {
  id: string;
  householdKey: string;
  label: string;
  plusOneSlots: number;
  version: number;
  archivedAt: string | null;
  invitees: RsvpInviteeView[];
  firstRespondedAt: string | null;
  latestRespondedAt: string | null;
  latestActor: RsvpActor | null;
  updatedAt: string;
}

// A null id adds a new named invitee; an existing id renames one in place and
// keeps its attendance.
export interface RsvpNamedInviteeDraft {
  id: string | null;
  displayName: string;
  // Required only when this is a new row in a household that already
  // responded. Existing rows preserve attendance through roster edits.
  attendance?: Exclude<RsvpAttendance, 'pending'>;
}

export interface RsvpHouseholdCreateRequest {
  householdKey: string;
  label: string;
  plusOneSlots: number;
  namedInvitees: string[];
  expectedRosterVersion: number;
}

export interface RsvpHouseholdUpdateRequest {
  label: string;
  plusOneSlots: number;
  namedInvitees: RsvpNamedInviteeDraft[];
  // Covers exactly the newly added plus-one capacity of a household that
  // already responded. Unresponded additions always start pending.
  newPlusOneResponses?: Array<{
    attendance: Exclude<RsvpAttendance, 'pending'>;
    displayName: string | null;
  }>;
  expectedVersion: number;
  expectedRosterVersion: number;
}

export interface RsvpHouseholdVersionRequest {
  expectedVersion: number;
  expectedRosterVersion: number;
}

export interface RsvpHouseholdResponseRequest extends RsvpHouseholdVersionRequest {
  invitees: RsvpSubmissionInvitee[];
}

// One exported line per named invitee or plus-one slot, including pending and
// archived rows.
export interface RsvpExportRow {
  householdKey: string;
  householdLabel: string;
  householdArchivedAt: string | null;
  memberKind: RsvpInviteeKind;
  memberName: string | null;
  attendance: RsvpAttendance;
  memberOrder: number;
  householdVersion: number;
  firstRespondedAt: string | null;
  lastRespondedAt: string | null;
  lastActor: RsvpActor | null;
  eventTimezone: string;
}

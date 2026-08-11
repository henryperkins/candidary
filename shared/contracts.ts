import type { EventCoverPreparationView } from './event-cover';
import type { ApiErrorBody } from './errors';

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
export type ExportState = 'queued' | 'running' | 'ready' | 'failed' | 'expired';

export interface ApiSuccess<T> {
  data: T;
  requestId: string;
}

export interface RegistrationPendingResponse {
  registrationPending: true;
}

export interface RegistrationCompleteResponse {
  registered: true;
  boundEvent: boolean;
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

export interface EventView {
  id: string;
  slug: string;
  name: string;
  eventDate: string;
  welcomeMessage: string;
  coverObjectKey: string | null;
  uploadsEnabled: boolean;
  galleryVisible: boolean;
  moderationRequired: boolean;
  reservedMediaCount: number;
  storedMediaCount: number;
  reservedBytes: number;
  storedBytes: number;
  guestAccessExpiresAt: string;
  managementAccessExpiresAt: string;
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
  // Manager-only, and transitional. The server picks the one unresolved
  // receipt, otherwise the most recent terminal one from the last 24 hours, so
  // accepted cover work stays discoverable after a reload with every scrap of
  // local state cleared. Phase 3 removes this when Manager switches to
  // `cover: EventCoverView`, preventing two owners for the same receipt.
  coverPreparation: EventCoverPreparationView | null;
  // Not optional polish. Every publication sends `expectedRevision` and a stale
  // value is a 409 whose recovery view carries the current number — but a
  // manager who has never published has no recovery view to read, and the
  // sentinel `coverObjectKey` deliberately carries no revision. Without this
  // the first publication of every event has no legal value to send.
  coverRevision: number;
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
  | 'coverObjectKey'
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
> & GuestPhaseView;

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

// What the host's photo-delivery controls are chosen from. `paused` is decided
// first, so an event whose capability is withheld never reports itself as
// scheduled to open.
export type PhotoIntakeState = 'scheduled' | 'open-early' | 'open' | 'paused';

export interface GuestPhaseView {
  phase: GuestEventPhase;
  rsvpState: RsvpState;
  rsvpAccess: RsvpAccess;
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

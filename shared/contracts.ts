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
  theme: ResolvedEventTheme;
}

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
  | 'theme'
>;

// RSVP. Every shape below is written out rather than derived from a database
// record, because the difference between what a household may see and what a
// host may see is the whole privacy story.

export type RsvpAttendance = 'pending' | 'attending' | 'declined';
export type RsvpInviteeKind = 'named' | 'plus_one';
export type RsvpState = 'disabled' | 'paused' | 'open' | 'closed';
export type GuestEventPhase = 'rsvp-primary' | 'photos-primary' | 'waiting';
// Who committed a response. Hosts may correct a household after the deadline;
// households never act as a host.
export type RsvpActor = 'household' | 'host';

export interface GuestPhaseView {
  phase: GuestEventPhase;
  rsvpState: RsvpState;
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
  expectedVersion: number;
  expectedRosterVersion: number;
}

export interface RsvpHouseholdVersionRequest {
  expectedVersion: number;
  expectedRosterVersion: number;
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

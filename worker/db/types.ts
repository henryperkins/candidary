import type {
  ChallengePurpose,
  EventThemeConfigV1,
  EventHostRole,
  NotificationKind,
  ExportState,
  ModerationStatus,
  PublicationStatus,
  Role,
  RsvpActor,
  RsvpAttendance,
  RsvpInviteeKind,
  UploadState,
} from '../../shared/contracts';
import type { SupportedImageType } from '../../shared/constants';

export interface EventRecord {
  id: string;
  slug: string;
  name: string;
  eventDate: string;
  welcomeMessage: string;
  themeConfig: EventThemeConfigV1;
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
  // The IANA zone the host chose. Every deadline is computed in it, never in
  // the Worker's zone or a browser's.
  eventTimezone: string;
  // The absolute instant the event begins, resolved from `eventDate`, the
  // host's local start time, and `eventTimezone`. Never sent by a browser.
  eventStartAt: string;
  // Null means "photo delivery opens automatically at the start". A non-null
  // value is the server instant at which the host opened it early.
  photosOpenFrom: string | null;
  rsvpEnabled: boolean;
  rsvpDeadlineAt: string | null;
  rsvpRosterVersion: number;
  // The semantic cover recipe, kept as the stored string rather than parsed.
  // Every publish digest is taken over a canonical serialization, so the bytes
  // that were committed are the thing a later replay has to compare against;
  // parsing here would make the record's copy a different artifact from the
  // row's. `parseStoredCoverConfig` is the reader, at the boundary that needs it.
  coverConfig: string;
  // Compare-and-swapped by every publication, and the number a Manager sends
  // back as `expectedRevision`.
  coverRevision: number;
  // The active uploaded render set, or null for `none`, `preset`, and every
  // not-yet-backfilled legacy row.
  coverRenderSetId: string | null;
}

/* ------------------------------------------------------------------ *
 * Event cover inventory (0012)
 *
 * Hand-maintained projections of the cover tables, on the same terms as
 * `EventRow`: a column added to the schema is invisible to `SELECT *` until it
 * is named here too.
 * ------------------------------------------------------------------ */

export type CoverDraftSource = 'new_upload' | 'existing_upload';

export type CoverDraftState =
  | 'reserved' | 'transferred' | 'inspected' | 'ready'
  | 'publishing' | 'published' | 'failed' | 'expired';

export type CoverPreviewState = 'rendering' | 'ready' | 'failed';

export type CoverRenderSetState = 'staging' | 'ready' | 'active' | 'retired' | 'abandoned';

export type CoverReceiptStatus =
  | 'queued' | 'rendering' | 'finalizing' | 'applied' | 'conflict' | 'failed';

export type CoverDispatchState =
  | 'pending' | 'creating' | 'confirmed' | 'resuming' | 'restarting' | 'failed' | 'blocked';

export type CoverRateAction = 'reservation' | 'inspection' | 'preview' | 'publication';

export type CoverFenceState = 'open' | 'deletion-blocked';

export type CoverPurgePhase = 'fences' | 'r2' | 'relational';

export type CoverBackfillRunStatus = 'inventorying' | 'executing' | 'verified' | 'failed';

export type CoverBackfillJobStatus =
  | 'queued' | 'normalizing' | 'rendering' | 'finalizing' | 'applied'
  | 'skipped' | 'resolved' | 'needs_replacement' | 'failed';

export interface CoverMasterRow {
  id: string;
  event_id: string;
  object_key: string;
  mime_type: string;
  byte_size: number;
  width: number;
  height: number;
  sha256: string;
  normalization_version: number;
  normalization_rung: number;
  auto_focus_x: number | null;
  auto_focus_y: number | null;
  composition_model_version: number | null;
  created_at: string;
  cleanup_after: string | null;
}

export interface CoverDraftRow {
  id: string;
  event_id: string;
  source: CoverDraftSource;
  state: CoverDraftState;
  draft_intent_id: string;
  request_sha256: string;
  draft_revision: number;
  raw_object_key: string | null;
  declared_filename: string | null;
  declared_mime_type: string | null;
  declared_byte_size: number | null;
  verified_raw_byte_size: number | null;
  raw_etag: string | null;
  master_id: string | null;
  focus_x: number | null;
  focus_y: number | null;
  composition_model_version: number | null;
  inspection_json: string | null;
  failure_code: string | null;
  created_at: string;
  updated_at: string;
  reservation_expires_at: string | null;
  expires_at: string;
}

export interface CoverDraftPreviewRow {
  id: string;
  draft_id: string;
  event_id: string;
  effect_id: string;
  recipe_version: number;
  state: CoverPreviewState;
  object_key: string | null;
  mime_type: string | null;
  byte_size: number | null;
  width: number | null;
  height: number | null;
  ladder_rung: number | null;
  sha256: string | null;
  failure_code: string | null;
  retryable: number;
  created_at: string;
  updated_at: string;
}

export interface CoverRenderSetRow {
  id: string;
  event_id: string;
  master_id: string;
  draft_id: string | null;
  recipe_json: string;
  recipe_sha256: string;
  state: CoverRenderSetState;
  required_slots: number;
  manifest_sha256: string | null;
  published_revision: number | null;
  created_at: string;
  ready_at: string | null;
  published_at: string | null;
  retired_at: string | null;
  abandoned_reason: string | null;
  abandoned_at: string | null;
  cleanup_after: string | null;
}

export interface CoverRenderObjectRow {
  id: string;
  render_set_id: string;
  event_id: string;
  profile_id: string;
  density: string;
  format: string;
  object_key: string;
  content_type: string;
  byte_size: number;
  width: number;
  height: number;
  quality_rung: number;
  sha256: string;
  created_at: string;
}

export interface CoverPublishReceiptRow {
  event_id: string;
  operation_id: string;
  draft_id: string | null;
  render_set_id: string | null;
  request_sha256: string;
  action: 'publish' | 'remove';
  expected_revision: number;
  status: CoverReceiptStatus;
  workflow_instance_id: string | null;
  dependency_versions_json: string;
  completed_profiles: number;
  required_profiles: number;
  applied_revision: number | null;
  result_cover_json: string | null;
  failure_code: string | null;
  retryable: number;
  dispatch_state: CoverDispatchState;
  dispatch_generation: number;
  last_dispatch_at: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

export interface CoverWorkflowFenceRow {
  workflow_binding: string;
  workflow_instance_id: string;
  event_id: string;
  dispatch_generation: number;
  state: CoverFenceState;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

export interface CoverRateEventRow {
  id: string;
  event_id: string;
  action: CoverRateAction;
  replay_key: string;
  request_sha256: string;
  window_start: number;
  created_at: string;
  expires_at: string;
}

export interface CoverRetiredLegacyObjectRow {
  id: string;
  event_id: string;
  object_key: string;
  key_fingerprint: string;
  reason: 'replaced' | 'removed' | 'backfilled';
  retired_at: string;
  cleanup_after: string;
  deleted_at: string | null;
}

export interface CoverPurgeProgressRow {
  event_id: string;
  phase: CoverPurgePhase;
  workflow_binding: string | null;
  workflow_instance_id: string | null;
  fences_resolved: number;
  platform_mutations: number;
  created_at: string;
  updated_at: string;
}

export interface CoverBackfillRunRow {
  id: string;
  mode: 'inventory' | 'execute' | 'verify';
  cursor: string | null;
  inventory_sha256: string | null;
  total_count: number;
  queued_count: number;
  applied_count: number;
  skipped_count: number;
  resolved_count: number;
  failed_count: number;
  needs_replacement_count: number;
  status: CoverBackfillRunStatus;
  created_at: string;
  updated_at: string;
  verified_at: string | null;
  expires_at: string | null;
}

export interface CoverBackfillJobRow {
  id: string;
  run_id: string;
  event_id: string;
  expected_revision: number;
  legacy_key_fingerprint: string;
  master_id: string | null;
  render_set_id: string | null;
  workflow_instance_id: string;
  dispatch_state: CoverDispatchState;
  dispatch_generation: number;
  status: CoverBackfillJobStatus;
  dependency_versions_json: string;
  manifest_json: string | null;
  manifest_sha256: string | null;
  failure_code: string | null;
  retryable: number;
  terminal_at: string | null;
  reference_release_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

// The credential printed on the invitation. It outlives guest-grant rotation,
// session expiry, and the switch from RSVP to photos; only `disabledAt` ends it,
// and that cannot be undone.
export interface EventEntryRecord {
  id: string;
  eventId: string;
  secretDigest: string;
  secretCiphertext: string;
  createdAt: string;
  disabledAt: string | null;
}

export interface RsvpHouseholdRecord {
  id: string;
  eventId: string;
  householdKey: string;
  label: string;
  version: number;
  lastSubmissionKey: string | null;
  lastSubmissionDigest: string | null;
  lastSubmissionResultVersion: number | null;
  firstRespondedAt: string | null;
  latestRespondedAt: string | null;
  latestActorKind: RsvpActor | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RsvpInviteeRecord {
  id: string;
  eventId: string;
  householdId: string;
  kind: RsvpInviteeKind;
  displayName: string | null;
  // Present only for named guests. A plus-one is never searchable.
  lookupDigest: string | null;
  attendance: RsvpAttendance;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

// A household's own credential. It grants neither the event guest role nor any
// manager authority, and it is scoped to exactly one household.
export interface RsvpSessionRecord {
  id: string;
  secretDigest: string;
  csrfDigest: string;
  eventId: string;
  householdId: string;
  writeAuthorityDeadline: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

export interface TokenRecord {
  id: string;
  eventId: string;
  role: Role;
  secretDigest: string;
  secretCiphertext: string | null;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

// Event sessions are authorized by an access token and never double as account
// sessions. `canClaimOwner` is reserved for the management session created with a
// new event; exchanged link sessions always carry false.
export interface SessionRecord {
  id: string;
  secretDigest: string;
  csrfDigest: string;
  eventId: string;
  accessTokenId: string;
  role: Role;
  canClaimOwner: boolean;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

export interface HostSessionRecord {
  id: string;
  secretDigest: string;
  csrfDigest: string;
  accountId: string;
  authVersion: number;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

export interface HostAccountRecord {
  id: string;
  email: string;
  passwordHash: string;
  displayName: string | null;
  emailVerifiedAt: string | null;
  notificationsEnabled: boolean;
  authVersion: number;
  createdAt: string;
  lastSeenAt: string | null;
  disabledAt: string | null;
}

export interface LoginChallengeRecord {
  id: string;
  accountId: string;
  purpose: ChallengePurpose;
  secretDigest: string;
  bindEventId: string | null;
  attempts: number;
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
}

export interface PendingRegistrationRecord {
  id: string;
  email: string;
  passwordHash: string;
  displayName: string | null;
  browserSecretDigest: string;
  codeDigest: string;
  bindEventId: string | null;
  creatorSessionId: string | null;
  attempts: number;
  expiresAt: string;
  consumedAt: string | null;
  activationNonce: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EventHostRecord {
  eventId: string;
  accountId: string;
  role: EventHostRole;
  createdAt: string;
}

export interface NotificationRecord {
  id: string;
  accountId: string;
  eventId: string | null;
  kind: NotificationKind;
  sentAt: string;
}

export interface MediaRecord {
  id: string;
  eventId: string;
  uploaderSessionId: string;
  objectKey: string;
  originalFilename: string;
  mimeType: SupportedImageType;
  declaredByteSize: number;
  byteSize: number | null;
  width: number | null;
  height: number | null;
  guestName: string;
  caption: string | null;
  uploadState: UploadState;
  publicationStatus: PublicationStatus;
  idempotencyKey: string;
  reservationExpiresAt: string;
  createdAt: string;
  publishedAt: string | null;
  previewObjectKey: string | null;
  deletedAt: string | null;
}

export interface ExportRecord {
  id: string;
  eventId: string;
  state: ExportState;
  snapshotAt: string;
  objectKey: string | null;
  manifestObjectKey: string | null;
  partCount: number;
  mediaCount: number;
  totalBytes: number;
  attempt: number;
  errorCode: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  expiresAt: string | null;
}

export interface ExportPartRecord {
  id: string;
  exportJobId: string;
  partNumber: number;
  objectKey: string;
  mediaCount: number;
  sourceBytes: number;
  createdAt: string;
}

export interface MessageRecord {
  id: string;
  eventId: string;
  guestSessionId: string;
  guestName: string | null;
  body: string;
  moderationStatus: ModerationStatus;
  createdAt: string;
  approvedAt: string | null;
  deletedAt: string | null;
}

export interface FeedItem {
  id: string;
  kind: 'message' | 'caption';
  guestName: string | null;
  body: string;
  moderationStatus: ModerationStatus;
  createdAt: string;
  mediaId: string | null;
}

export interface ReleaseCertificationRow {
  worker_version_id: string;
  build_sha: string;
  guest_journey_version: number;
  migration_manifest_sha256: string;
  evidence_manifest_sha256: string;
  physical_evidence_refs_json: string;
  certified_at: string;
}

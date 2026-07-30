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
  rsvpEnabled: boolean;
  rsvpDeadlineAt: string | null;
  rsvpRosterVersion: number;
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

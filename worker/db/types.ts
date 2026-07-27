import type {
  ChallengePurpose,
  EventHostRole,
  NotificationKind,
  ExportState,
  ModerationStatus,
  PublicationStatus,
  Role,
  SessionRole,
  UploadState,
} from '../../shared/contracts';
import type { SupportedImageType } from '../../shared/constants';

export interface EventRecord {
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

// `eventId`/`accessTokenId` are set for guest and manager sessions, `accountId`
// for host sessions. The schema CHECK guarantees exactly one of those two shapes,
// so a narrowed `role` is enough to know which fields are present.
export interface SessionRecord {
  id: string;
  secretDigest: string;
  csrfDigest: string;
  eventId: string | null;
  accessTokenId: string | null;
  accountId: string | null;
  role: SessionRole;
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

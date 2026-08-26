import type { ExportKind, ManagerExportErrorCode } from '../../shared/contracts';

export type {
  AlbumRetainedSlotView,
  EventView,
  GuestContributionMediaView,
  GuestEventView,
  GuestGalleryMediaView,
  GuestbookItem,
  GuestbookSource,
  GuestGuestbookItem,
  ManagerGuestbookItem,
  ManagerTrashedMediaView,
  UploadMediaView,
} from '../../shared/contracts';

export interface MediaView {
  id: string;
  originalFilename: string;
  guestName: string;
  caption: string | null;
  publicationStatus: 'unpublished' | 'published' | 'hidden';
  uploadState: 'reserved' | 'stored' | 'failed' | 'deleted';
  previewObjectKey?: string | null;
  width?: number | null;
  height?: number | null;
  createdAt?: string;
}

// One keyset page of manager media. `nextCursor` is opaque: pass it back untouched, and omit the
// parameter entirely when it is null — the server rejects an empty `cursor` as malformed.
export interface ManagerMediaPage {
  media: MediaView[];
  nextCursor: string | null;
}

/**
 * One keyset page of Recently deleted. A separate type, and a separate cursor,
 * because it is a separate list: a trash cursor and an Intake cursor page over
 * different orderings and are never interchangeable.
 */
export interface ManagerTrashPage {
  media: TrashedMediaView[];
  nextCursor: string | null;
}

/**
 * A photo in Recently deleted.
 *
 * No preview, no original, no storage identity — a retained photo is not being
 * delivered, and the row deliberately carries only what the host needs to
 * recognize it and the server's answer about how long Restore lasts.
 */
export interface TrashedMediaView {
  id: string;
  originalFilename: string;
  guestName: string;
  caption: string | null;
  trashedAt: string;
  restoreUntil: string;
}

export interface MessageView {
  id: string;
  kind?: 'message' | 'caption';
  guestName: string | null;
  body: string;
  moderationStatus: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  mediaId?: string | null;
}

export interface ExportView {
  id: string;
  kind: ExportKind;
  state: 'queued' | 'running' | 'ready' | 'failed' | 'expired';
  snapshotAt: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  mediaCount: number;
  totalBytes: number;
  processedMediaCount: number | null;
  processedBytes: number | null;
  progressUpdatedAt: string | null;
  attempt: number;
  partCount: number;
  expiresAt: string | null;
  guestbookEntryCount: number | null;
  guestbookSharedCount: number | null;
  guestbookEventName: string | null;
  guestbookEventDate: string | null;
  guestbookEventTimezone: string | null;
  guestbookPrompt: string | null;
  guestbookGalleryVisible: boolean | null;
  /** A closed, client-safe recovery reason; raw Worker diagnostics stay in D1. */
  errorCode: ManagerExportErrorCode | null;
}

export interface ExportDownloadDescriptor {
  url: string;
  expiresAt: string;
  filename: string;
}

export interface ExportDownloadView {
  manifest: ExportDownloadDescriptor | null;
  parts: Array<{
    partNumber: number;
    mediaCount: number;
    sourceBytes: number;
    url: string;
    expiresAt: string;
    filename: string;
  }>;
  printableGuestbook: ExportDownloadDescriptor | null;
  privateGuestbook: ExportDownloadDescriptor | null;
}

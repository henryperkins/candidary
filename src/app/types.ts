export type { EventView, GuestEventView } from '../../shared/contracts';

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

export interface MessageView {
  id: string;
  kind?: 'message' | 'caption';
  guestName: string | null;
  body: string;
  moderationStatus: 'pending' | 'approved' | 'rejected';
  createdAt: string;
}

export interface ExportView {
  id: string;
  state: 'queued' | 'running' | 'ready' | 'failed' | 'expired';
  snapshotAt: string;
  mediaCount: number;
  totalBytes: number;
  attempt: number;
  manifestObjectKey?: string | null;
  partCount?: number;
  expiresAt: string | null;
}

export interface ExportDownloadView {
  manifest: { url: string; expiresAt: string; filename: string };
  parts: Array<{
    partNumber: number;
    mediaCount: number;
    sourceBytes: number;
    url: string;
    expiresAt: string;
    filename: string;
  }>;
}

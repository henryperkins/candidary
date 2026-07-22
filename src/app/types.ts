export interface EventView {
  id: string;
  slug: string;
  name: string;
  eventDate: string;
  welcomeMessage: string;
  coverObjectKey?: string | null;
  uploadsEnabled: boolean;
  galleryVisible: boolean;
  moderationRequired: boolean;
  storedMediaCount?: number;
  storedBytes?: number;
  guestAccessExpiresAt?: string;
  managementAccessExpiresAt?: string;
  purgeAfter?: string;
}

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
  expiresAt: string | null;
}

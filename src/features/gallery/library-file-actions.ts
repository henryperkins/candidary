import type { ManagerGalleryMediaView, ManagerTrashedMediaView } from '../../../shared/contracts';

export interface LibraryChange {
  version: number;
  eventId: string;
  kind: 'delivered' | 'trashed' | 'restored' | 'metadata';
  mediaIds: readonly string[];
}
export type TrashOutcome =
  | { status: 'trashed'; media: ManagerTrashedMediaView }
  | { status: 'retired' };
export interface LibraryFileActions {
  canTrash: boolean;
  trash(photo: ManagerGalleryMediaView, activation: 'keyboard' | 'pointer'): Promise<TrashOutcome>;
}

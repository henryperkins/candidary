import type { ManagerGalleryMediaView } from './contracts';
import type { GalleryTimelineOrder } from './constants';

export interface LibraryQuery {
  query: string;
  favorites: boolean;
  order: GalleryTimelineOrder;
}

/** Host-only identity for a delivered photo; deliverySequence is a positive safe integer. */
export interface LibraryMediaView extends ManagerGalleryMediaView {
  deliverySequence: number;
}

export interface LibraryPage {
  media: LibraryMediaView[];
  nextCursor: string | null;
  snapshotSequence: number;
}

export interface LibraryArrivalSummary {
  afterSequence: number;
  snapshotSequence: number;
  count: number;
}

export interface LibraryCursorV3 extends LibraryQuery {
  v: 3;
  eventId: string;
  snapshotSequence: number;
  timelineAt: string;
  id: string;
}

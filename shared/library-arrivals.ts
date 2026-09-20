import type { ManagerGalleryMediaView } from './contracts';
import type { GalleryTimelineOrder } from './constants';

export interface LibraryQuery {
  query: string;
  favorites: boolean;
  order: GalleryTimelineOrder;
}

export interface LibraryPage {
  media: ManagerGalleryMediaView[];
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

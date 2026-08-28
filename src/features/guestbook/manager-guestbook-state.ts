import type { ManagerGuestbookItem } from '../../../shared/contracts';

export type GuestbookManagerView = 'needs-review' | 'shared' | 'hidden' | 'deleted';
export type GuestbookManagerSource = 'all' | 'guest_note' | 'photo_caption';

export interface GuestbookSummary {
  needsReviewCount: number;
  sharedCount: number;
  hiddenCount: number;
  deletedCount: number;
  galleryVisible: boolean;
}
export interface ManagerGuestbookPage {
  items: ManagerGuestbookItem[];
  nextCursor: string | null;
  summary: GuestbookSummary;
}

export type GuestbookRowAction =
  | 'approve'
  | 'reject'
  | 'delete'
  | 'restore'
  | 'purge'
  | 'publish'
  | 'hide';

export function initialGuestbookView(_summary: GuestbookSummary | null): GuestbookManagerView {
  void _summary;
  return 'needs-review';
}

export function guestbookItemKey(item: ManagerGuestbookItem): string {
  return `${item.source}:${item.id}`;
}

export function guestbookItemBelongsToView(
  item: ManagerGuestbookItem,
  view: GuestbookManagerView,
  galleryVisible: boolean,
): boolean {
  if (item.source === 'guest_note') {
    if (item.state === 'deleted') return view === 'deleted';
    if (item.state === 'pending') return view === 'needs-review';
    if (item.state === 'approved') return view === 'shared';
    return view === 'hidden';
  }
  if (item.state === 'unpublished') return view === 'needs-review';
  if (item.state === 'published') return view === (galleryVisible ? 'shared' : 'hidden');
  return view === 'hidden';
}

export function guestbookItemMatchesSource(
  item: ManagerGuestbookItem,
  source: GuestbookManagerSource,
): boolean {
  return source === 'all' || item.source === source;
}

export function guestbookStateLabel(item: ManagerGuestbookItem, galleryVisible: boolean): string {
  if (item.source === 'photo_caption' && item.state === 'published' && !galleryVisible) {
    return 'Not currently visible to event guests';
  }
  return item.state.charAt(0).toUpperCase() + item.state.slice(1);
}

export function guestbookVisibilityLabel(item: ManagerGuestbookItem): string {
  if (item.visibility === 'shared') return 'Shared with guests';
  if (item.visibility === 'host_only') return 'Host only';
  return 'Private to contributor';
}

export function guestbookSourceLabel(item: ManagerGuestbookItem): string {
  return item.source === 'guest_note' ? 'Guest note' : 'Photo caption';
}

export function guestbookActions(item: ManagerGuestbookItem): Array<{
  action: GuestbookRowAction;
  label: string;
  busyLabel: string;
  tone: 'primary' | 'secondary' | 'danger';
}> {
  if (item.source === 'photo_caption') {
    if (item.state === 'unpublished') return [
      { action: 'publish', label: 'Publish photo & caption', busyLabel: 'Publishing…', tone: 'primary' },
      { action: 'hide', label: 'Hide photo & caption', busyLabel: 'Hiding…', tone: 'secondary' },
    ];
    if (item.state === 'published') return [
      { action: 'hide', label: 'Hide photo & caption', busyLabel: 'Hiding…', tone: 'secondary' },
    ];
    return [
      { action: 'publish', label: 'Publish photo & caption', busyLabel: 'Publishing…', tone: 'primary' },
    ];
  }
  if (item.state === 'pending') return [
    { action: 'approve', label: 'Share', busyLabel: 'Sharing…', tone: 'primary' },
    { action: 'reject', label: 'Keep private', busyLabel: 'Keeping private…', tone: 'secondary' },
    { action: 'delete', label: 'Delete', busyLabel: 'Deleting…', tone: 'danger' },
  ];
  if (item.state === 'approved') return [
    { action: 'reject', label: 'Keep private', busyLabel: 'Keeping private…', tone: 'secondary' },
    { action: 'delete', label: 'Delete', busyLabel: 'Deleting…', tone: 'danger' },
  ];
  if (item.state === 'rejected') return [
    { action: 'approve', label: 'Share', busyLabel: 'Sharing…', tone: 'primary' },
    { action: 'delete', label: 'Delete', busyLabel: 'Deleting…', tone: 'danger' },
  ];
  return [
    { action: 'restore', label: 'Restore', busyLabel: 'Restoring…', tone: 'primary' },
    { action: 'purge', label: 'Permanently delete', busyLabel: 'Permanently deleting…', tone: 'danger' },
  ];
}

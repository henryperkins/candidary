import type { GuestGuestbookItem } from '../../../shared/contracts';

export interface GuestbookPage {
  items: GuestGuestbookItem[];
  nextCursor: string | null;
  ownUnshared: GuestGuestbookItem[];
  ownUnsharedCount: number;
  ownUnsharedNextCursor: string | null;
}

export interface GuestbookSubmission {
  item: GuestGuestbookItem;
  replayed: boolean;
}

export interface GuestbookSubmissionIntent {
  body: string;
  effectiveGuestName: string | null;
  idempotencyKey: string;
}

export type GuestbookReadStatus = 'idle' | 'loading' | 'ready' | 'retryable_error';
export type GuestbookSubmitStatus = 'idle' | 'sending' | 'confirmed_success' | 'retryable_error' | 'invalid';

export function isSameGuestbookDraft(
  intent: GuestbookSubmissionIntent,
  body: string,
  effectiveGuestName: string | null,
): boolean {
  return intent.body === body && intent.effectiveGuestName === effectiveGuestName;
}

export function guestbookItemKey(item: Pick<GuestGuestbookItem, 'source' | 'id'>): string {
  return `${item.source}:${item.id}`;
}

/** Retains existing order, replaces confirmed copies in place, and appends only unseen rows. */
export function appendGuestbookItems(
  current: readonly GuestGuestbookItem[],
  incoming: readonly GuestGuestbookItem[],
): GuestGuestbookItem[] {
  const next = [...current];
  const positions = new Map(next.map((item, index) => [guestbookItemKey(item), index]));
  for (const item of incoming) {
    const key = guestbookItemKey(item);
    const position = positions.get(key);
    if (position === undefined) {
      positions.set(key, next.length);
      next.push(item);
    } else {
      next[position] = item;
    }
  }
  return next;
}

/** Puts a server-confirmed send first without duplicating an exact replay. */
export function prependGuestbookItem(
  current: readonly GuestGuestbookItem[],
  item: GuestGuestbookItem,
): GuestGuestbookItem[] {
  const key = guestbookItemKey(item);
  return [item, ...current.filter((candidate) => guestbookItemKey(candidate) !== key)];
}

export function guestbookSourceLabel(item: GuestGuestbookItem): 'Note' | 'Photo caption' {
  return item.source === 'guest_note' ? 'Note' : 'Photo caption';
}

export function guestbookStateLabel(item: GuestGuestbookItem): string {
  if (item.visibility === 'shared') return 'Shared with guests';
  if (item.source === 'guest_note' && item.state === 'pending') return 'Awaiting host review';
  if (item.source === 'photo_caption' && item.state === 'unpublished') return 'Awaiting host review';
  return 'Kept private';
}

export function guestbookPrivacyLabel(item: GuestGuestbookItem): string | null {
  if (item.visibility === 'shared') return null;
  if (
    (item.source === 'guest_note' && item.state === 'pending')
    || (item.source === 'photo_caption' && item.state === 'unpublished')
  ) {
    return 'Only this guest session and the hosts can see it until it is shared.';
  }
  return 'Only this guest session and the hosts can see it.';
}

import { describe, expect, it } from 'vitest';

import type { GuestGuestbookItem } from '../../shared/contracts';

function compatibilityAliases(item: GuestGuestbookItem) {
  if (item.source === 'guest_note') {
    const kind: 'message' = item.kind;
    const mediaId: null = item.mediaId;
    if (item.state === 'approved') {
      const moderationStatus: 'approved' = item.moderationStatus;
      return { kind, mediaId, moderationStatus };
    }
    if (item.state === 'rejected') {
      const moderationStatus: 'rejected' = item.moderationStatus;
      return { kind, mediaId, moderationStatus };
    }
    const moderationStatus: 'pending' = item.moderationStatus;
    return { kind, mediaId, moderationStatus };
  }

  const kind: 'caption' = item.kind;
  const mediaId: string = item.mediaId;
  if (item.state === 'published') {
    const moderationStatus: 'approved' | 'rejected' = item.moderationStatus;
    return { kind, mediaId, moderationStatus };
  }
  if (item.state === 'hidden') {
    const moderationStatus: 'rejected' = item.moderationStatus;
    return { kind, mediaId, moderationStatus };
  }
  const moderationStatus: 'pending' = item.moderationStatus;
  return { kind, mediaId, moderationStatus };
}

describe('guest guestbook wire contract', () => {
  it('correlates canonical sources and states with compatibility aliases', () => {
    const note: GuestGuestbookItem = {
      id: 'note-a',
      source: 'guest_note',
      guestName: 'Avery',
      body: 'A favorite memory.',
      createdAt: '2026-09-19T20:00:00.000Z',
      state: 'approved',
      visibility: 'shared',
      isOwn: false,
      kind: 'message',
      moderationStatus: 'approved',
      mediaId: null,
    };
    const caption: GuestGuestbookItem = {
      id: 'media-a',
      source: 'photo_caption',
      mediaId: 'media-a',
      guestName: 'Rowan',
      body: 'Golden hour.',
      createdAt: '2026-09-19T20:01:00.000Z',
      state: 'published',
      visibility: 'shared',
      previewAvailable: true,
      isOwn: true,
      kind: 'caption',
      moderationStatus: 'approved',
    };
    const suppressedCaption: GuestGuestbookItem = {
      ...caption,
      visibility: 'author_only',
      moderationStatus: 'rejected',
    };
    // @ts-expect-error A gallery-suppressed published caption must fail closed for legacy consumers.
    const impossibleSuppressedCaption: GuestGuestbookItem = {
      ...caption,
      visibility: 'author_only',
      moderationStatus: 'approved',
    };
    void impossibleSuppressedCaption;

    expect(compatibilityAliases(note)).toEqual({
      kind: 'message', mediaId: null, moderationStatus: 'approved',
    });
    expect(compatibilityAliases(caption)).toEqual({
      kind: 'caption', mediaId: 'media-a', moderationStatus: 'approved',
    });
    expect(compatibilityAliases(suppressedCaption)).toEqual({
      kind: 'caption', mediaId: 'media-a', moderationStatus: 'rejected',
    });
  });
});

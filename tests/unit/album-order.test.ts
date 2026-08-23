import { describe, expect, it } from 'vitest';

import type { AlbumEntryView, ManagerGalleryMediaView } from '../../shared/contracts';
import { moveEntry, toEntryInput } from '../../src/features/gallery/album-api';

function photo(id: string): ManagerGalleryMediaView {
  return {
    id,
    originalFilename: `${id}.jpg`,
    guestName: 'Jose',
    caption: null,
    publicationStatus: 'unpublished',
    previewAvailable: true,
    width: null,
    height: null,
    receivedAt: '2026-08-15T22:42:00.000Z',
    timelineAt: '2026-08-15T22:42:00.000Z',
    timelineSource: 'received',
    isFavorite: true,
  };
}

const entry = (id: string): AlbumEntryView => ({ kind: 'photo', photo: photo(id) });
const section = (id: string, heading: string): AlbumEntryView => ({ kind: 'section', id, heading });

function ids(entries: readonly AlbumEntryView[]): string[] {
  return entries.map((item) => (item.kind === 'photo' ? item.photo.id : item.id));
}

describe('moveEntry', () => {
  it('swaps with the neighbour in the requested direction', () => {
    const entries = [entry('a'), entry('b'), entry('c')];
    expect(ids(moveEntry(entries, 1, -1))).toEqual(['b', 'a', 'c']);
    expect(ids(moveEntry(entries, 1, 1))).toEqual(['a', 'c', 'b']);
  });

  it('refuses to move past either end, and leaves the list alone', () => {
    const entries = [entry('a'), entry('b')];
    expect(ids(moveEntry(entries, 0, -1))).toEqual(['a', 'b']);
    expect(ids(moveEntry(entries, 1, 1))).toEqual(['a', 'b']);
  });

  it('never mutates the list it was given', () => {
    const entries = [entry('a'), entry('b')];
    moveEntry(entries, 0, 1);
    expect(ids(entries)).toEqual(['a', 'b']);
  });

  /**
   * The one behaviour a "move past the next photo" implementation would get wrong. A
   * section is a real position, so stepping a photo over a heading has to put it *above*
   * that heading — otherwise buttons alone can never move a photo out of the section it
   * landed in, and only drag can arrange an album.
   */
  it('steps a photo across a section heading rather than over it', () => {
    const entries = [entry('a'), section('s1', 'Reception'), entry('b')];
    expect(ids(moveEntry(entries, 2, -1))).toEqual(['a', 'b', 's1']);
    expect(ids(moveEntry(entries, 1, -1))).toEqual(['s1', 'a', 'b']);
  });
});

describe('toEntryInput', () => {
  it('sends a photo as a position and a section with its own identity', () => {
    expect(toEntryInput([entry('a'), section('s1', 'Reception')])).toEqual([
      { kind: 'photo', mediaId: 'a' },
      { kind: 'section', id: 's1', heading: 'Reception' },
    ]);
  });
});

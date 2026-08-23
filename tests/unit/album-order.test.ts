import { describe, expect, it } from 'vitest';

import type { AlbumEntryView, ManagerGalleryMediaView } from '../../shared/contracts';
import { moveEntry, moveEntryTo, toEntryInput } from '../../src/features/gallery/album-api';

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

describe('moveEntryTo', () => {
  it('moves an entry to any valid target index', () => {
    const entries = [entry('a'), section('s1', 'Reception'), entry('b'), entry('c')];
    expect(ids(moveEntryTo(entries, 0, 3))).toEqual(['s1', 'b', 'c', 'a']);
    expect(ids(moveEntryTo(entries, 3, 1))).toEqual(['a', 'c', 's1', 'b']);
  });

  it('returns a copy for invalid or no-op movement', () => {
    const entries = [entry('a'), entry('b')];
    for (const [from, to] of [[-1, 0], [0, -1], [2, 0], [0, 2], [1, 1]]) {
      const result = moveEntryTo(entries, from!, to!);
      expect(ids(result)).toEqual(['a', 'b']);
      expect(result).not.toBe(entries);
    }
  });

  it('never mutates the list it was given', () => {
    const entries = [entry('a'), entry('b'), entry('c')];
    moveEntryTo(entries, 2, 0);
    expect(ids(entries)).toEqual(['a', 'b', 'c']);
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

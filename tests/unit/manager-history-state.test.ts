import { describe, expect, it } from 'vitest';
import {
  anchorCandidateIds,
  consumeManagerIntent,
  sanitizeManagerHistoryState,
  withGalleryAnchor,
  withManagerIntent,
  type GalleryAnchor,
  type ManagerNavigationIntent,
} from '../../src/app/manager-history-state';
import type { ManagerLocation } from '../../src/app/manager-location';

const mediaAnchor: GalleryAnchor = {
  kind: 'media', mediaId: 'm21', viewportOffset: 18, fallbackScrollY: 2450,
  before: ['m20'], after: ['m22'],
};
const albumAnchor: GalleryAnchor = {
  kind: 'album-entry', entryId: 'a21', viewportOffset: 12, fallbackScrollY: 1800,
  before: ['a20'], after: ['a22'],
};

describe('manager history state', () => {
  it('sanitizes a valid versioned envelope and preserves foreign keys', () => {
    const raw = { source: 'share', __candidaryManager: { version: 1, eventId: 'event-a', anchors: { library: mediaAnchor } } };
    const result = sanitizeManagerHistoryState(raw, 'event-a', { section: 'gallery', mode: 'library' });
    expect(result).toEqual({ state: raw, envelope: raw.__candidaryManager, needsReplace: false });
    expect(result.state).not.toBe(raw);
  });

  it('replaces non-plain, mismatched, or malformed envelopes with foreign state intact', () => {
    const raw = { source: 'share', __candidaryManager: { version: 2, eventId: 'other' } };
    const result = sanitizeManagerHistoryState(raw, 'event-a', { section: 'gallery', mode: 'library' });
    expect(result.state).toEqual({ source: 'share' });
    expect(result.envelope).toBeNull();
    expect(result.needsReplace).toBe(true);
  });

  it('accepts exact compatible intents and rejects incompatible ones', () => {
    const cases: Array<[ManagerNavigationIntent, ManagerLocation, boolean]> = [
      [{ kind: 'focus-complete-export' }, { section: 'gallery', mode: 'library' }, true],
      [{ kind: 'focus-intake-heading' }, { section: 'intake' }, true],
      [{ kind: 'open-recently-deleted', focusMediaId: 'm1' }, { section: 'intake' }, true],
      [{ kind: 'edit-guest-gallery-availability', returnTo: { section: 'gallery', mode: 'guest-gallery', publicationFilter: 'published' } }, { section: 'settings' }, true],
      [{ kind: 'focus-complete-export' }, { section: 'intake' }, false],
      [{ kind: 'focus-intake-heading' }, { section: 'gallery', mode: 'library' }, false],
      [{ kind: 'open-recently-deleted', focusMediaId: 'm1' }, { section: 'gallery', mode: 'library' }, false],
    ];
    for (const [intent, location, compatible] of cases) {
      const result = consumeManagerIntent({ __candidaryManager: { version: 1, eventId: 'e', intent } }, 'e', location);
      expect(Boolean(result.intent)).toBe(compatible);
    }
  });

  it('drops a valid but location-incompatible intent while retaining sibling anchors and requests replacement', () => {
    const result = consumeManagerIntent({ source: 'x', __candidaryManager: { version: 1, eventId: 'e', anchors: { library: mediaAnchor }, intent: { kind: 'focus-intake-heading' } } }, 'e', { section: 'gallery', mode: 'library' });
    expect(result.intent).toBeNull();
    expect(result.state).toEqual({ source: 'x', __candidaryManager: { version: 1, eventId: 'e', anchors: { library: mediaAnchor } } });
    expect(sanitizeManagerHistoryState({ __candidaryManager: { version: 1, eventId: 'e', intent: { kind: 'focus-intake-heading' } } }, 'e', { section: 'gallery', mode: 'library' }).needsReplace).toBe(true);
  });

  it('requires true plain objects for envelopes and nested records', () => {
    class Envelope { version = 1; eventId = 'e'; }
    expect(sanitizeManagerHistoryState({ __candidaryManager: new Envelope() }, 'e', { section: 'intake' }).envelope).toBeNull();
    expect(sanitizeManagerHistoryState({ __candidaryManager: { version: 1, eventId: 'e', anchors: new Date() } }, 'e', { section: 'intake' }).envelope).toBeNull();
    expect(sanitizeManagerHistoryState({ __candidaryManager: { version: 1, eventId: 'e', intent: { kind: 'edit-guest-gallery-availability', returnTo: new Date() } } }, 'e', { section: 'settings' }).envelope).toBeNull();
  });

  it('canonicalizes cyclic foreign envelope data without throwing', () => {
    const extra: Record<string, unknown> = {}; extra.self = extra;
    expect(() => sanitizeManagerHistoryState({ source: 'x', __candidaryManager: { version: 1, eventId: 'e', extra } }, 'e', { section: 'intake' })).not.toThrow();
  });

  it('consumes a compatible intent while preserving foreign state and anchors', () => {
    const result = consumeManagerIntent({
      source: 'share',
      __candidaryManager: {
        version: 1, eventId: 'event-a', anchors: { library: mediaAnchor },
        intent: { kind: 'focus-complete-export' },
      },
    }, 'event-a', { section: 'gallery', mode: 'library' });
    expect(result.intent).toEqual({ kind: 'focus-complete-export' });
    expect(result.state).toEqual({
      source: 'share',
      __candidaryManager: { version: 1, eventId: 'event-a', anchors: { library: mediaAnchor } },
    });
  });

  it('removes an empty envelope after consuming an incompatible or absent intent', () => {
    expect(consumeManagerIntent({ source: 'share', __candidaryManager: { version: 1, eventId: 'e' } }, 'e', { section: 'intake' }).state)
      .toEqual({ source: 'share' });
  });

  it('adds and removes anchors without mutating input', () => {
    const raw = { foreign: true };
    const next = withGalleryAnchor(raw, 'e', 'library', mediaAnchor);
    expect(next).toEqual({ foreign: true, __candidaryManager: { version: 1, eventId: 'e', anchors: { library: mediaAnchor } } });
    expect(raw).toEqual({ foreign: true });
    expect(withGalleryAnchor(next, 'e', 'library', null)).toEqual({ foreign: true });
    const owned = { ...mediaAnchor, before: ['m20'], after: ['m22'] };
    const ownedResult = withGalleryAnchor({}, 'e', 'library', owned);
    owned.before.push('changed'); owned.after[0] = 'changed';
    expect(ownedResult.__candidaryManager?.anchors?.library).toEqual(mediaAnchor);
    expect(withGalleryAnchor({}, 'e', 'library', albumAnchor)).toEqual({});
  });

  it('adds intents while retaining valid anchors', () => {
    expect(withManagerIntent({ __candidaryManager: { version: 1, eventId: 'e', anchors: { album: albumAnchor } } }, 'e', { kind: 'focus-intake-heading' }))
      .toEqual({ __candidaryManager: { version: 1, eventId: 'e', anchors: { album: albumAnchor }, intent: { kind: 'focus-intake-heading' } } });
    const intent: ManagerNavigationIntent = { kind: 'open-recently-deleted', focusMediaId: 'm1' };
    const result = withManagerIntent({}, 'e', intent);
    intent.focusMediaId = 'changed';
    expect(result.__candidaryManager?.intent).toEqual({ kind: 'open-recently-deleted', focusMediaId: 'm1' });
  });

  it('bounds candidate IDs to 20 and alternates after then before', () => {
    expect(anchorCandidateIds({ kind: 'media', mediaId: 'm3', viewportOffset: 0, fallbackScrollY: 900, before: ['m2', 'm1'], after: ['m4', 'm5'] }))
      .toEqual(['m3', 'm4', 'm2', 'm5', 'm1']);
    const long = { kind: 'media' as const, mediaId: 'm0', viewportOffset: 0, fallbackScrollY: 0, before: Array.from({ length: 25 }, (_, i) => `b${i}`), after: Array.from({ length: 25 }, (_, i) => `a${i}`) };
    expect(withGalleryAnchor({}, 'e', 'library', long).__candidaryManager?.anchors?.library).toMatchObject({ before: long.before.slice(0, 20), after: long.after.slice(0, 20) });
    expect(anchorCandidateIds(long)).toHaveLength(41);
  });

  it('strips incompatible anchor kinds by mode while retaining valid siblings', () => {
    const raw = { __candidaryManager: { version: 1, eventId: 'e', anchors: { library: albumAnchor, album: mediaAnchor, 'guest-gallery': mediaAnchor } } };
    expect(sanitizeManagerHistoryState(raw, 'e', { section: 'gallery', mode: 'library' }).envelope?.anchors)
      .toEqual({ 'guest-gallery': mediaAnchor });
    expect(sanitizeManagerHistoryState(raw, 'e', { section: 'gallery', mode: 'album' }).envelope?.anchors)
      .toEqual({ 'guest-gallery': mediaAnchor });
    expect(sanitizeManagerHistoryState({ __candidaryManager: { version: 1, eventId: 'e', anchors: { 'guest-gallery': albumAnchor, library: mediaAnchor } } }, 'e', { section: 'gallery', mode: 'guest-gallery' }).envelope?.anchors)
      .toEqual({ library: mediaAnchor });
  });

  it('removes canonical empty envelopes but retains intent-only envelopes', () => {
    expect(sanitizeManagerHistoryState({ source: 'x', __candidaryManager: { version: 1, eventId: 'e' } }, 'e', { section: 'intake' })).toMatchObject({ envelope: null, state: { source: 'x' }, needsReplace: true });
    expect(sanitizeManagerHistoryState({ __candidaryManager: { version: 1, eventId: 'e', intent: { kind: 'focus-intake-heading' } } }, 'e', { section: 'intake' }).envelope).toEqual({ version: 1, eventId: 'e', intent: { kind: 'focus-intake-heading' } });
  });

  it('treats absent manager state as canonical but present empty state as replacement-needed', () => {
    expect(sanitizeManagerHistoryState({ source: 'x' }, 'e', { section: 'intake' })).toMatchObject({ envelope: null, needsReplace: false, state: { source: 'x' } });
    expect(sanitizeManagerHistoryState(null, 'e', { section: 'intake' })).toMatchObject({ envelope: null, needsReplace: false, state: {} });
    expect(sanitizeManagerHistoryState({ source: 'x', __candidaryManager: {} }, 'e', { section: 'intake' }).needsReplace).toBe(true);
  });

  it('marks a truncated neighbor list as replacement-needed', () => {
    const anchor = { ...mediaAnchor, before: Array.from({ length: 21 }, (_, i) => `b${i}`) };
    const result = sanitizeManagerHistoryState({ __candidaryManager: { version: 1, eventId: 'e', anchors: { library: anchor } } }, 'e', { section: 'gallery', mode: 'library' });
    expect(result.needsReplace).toBe(true);
    expect(result.envelope?.anchors?.library).toMatchObject({ before: anchor.before.slice(0, 20) });
  });
});

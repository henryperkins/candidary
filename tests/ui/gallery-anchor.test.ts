import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GalleryAnchor } from '../../src/app/manager-history-state';
import {
  captureRenderedGalleryAnchor,
  restoreRenderedGalleryAnchor,
} from '../../src/features/gallery/gallery-anchor';

function rect(top: number, bottom: number): DOMRect {
  return { top, bottom, left: 0, right: 0, width: 0, height: bottom - top, x: 0, y: top, toJSON: () => ({}) };
}

function rendered(root: HTMLElement, ids: readonly string[], tops: readonly number[]): HTMLElement[] {
  return ids.map((id, index) => {
    const item = document.createElement('article');
    item.dataset.galleryAnchorId = id;
    vi.spyOn(item, 'getBoundingClientRect').mockReturnValue(rect(tops[index]!, tops[index]! + 40));
    root.append(item);
    return item;
  });
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('rendered Gallery anchors', () => {
  it('captures the first rendered item crossing the effective visible top with bounded neighbors', () => {
    const root = document.createElement('div');
    document.body.append(root);
    rendered(root, Array.from({ length: 43 }, (_, index) => `media-${index}`),
      Array.from({ length: 43 }, (_, index) => index * 40));
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 640 });

    expect(captureRenderedGalleryAnchor(root, 'media', 100)).toEqual({
      kind: 'media', mediaId: 'media-2', viewportOffset: -20, fallbackScrollY: 640,
      before: ['media-1', 'media-0'],
      after: Array.from({ length: 20 }, (_, index) => `media-${index + 3}`),
    });
  });

  it('restores exact and alternating rendered candidates to the saved viewport offset', () => {
    const root = document.createElement('div');
    document.body.append(root);
    rendered(root, ['exact', 'after', 'before'], [240, 260, 500]);
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 1000 });
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    const exactAnchor: GalleryAnchor = {
      kind: 'media', mediaId: 'exact', viewportOffset: 30, fallbackScrollY: 400,
      before: ['before'], after: ['after'],
    };
    expect(restoreRenderedGalleryAnchor(root, exactAnchor, 100)).toBe('item');
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1110, behavior: 'instant' });

    const alternateAnchor: GalleryAnchor = {
      kind: 'media', mediaId: 'missing', viewportOffset: 30, fallbackScrollY: 400,
      before: ['before'], after: ['after'],
    };

    expect(restoreRenderedGalleryAnchor(root, alternateAnchor, 100)).toBe('item');
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1130, behavior: 'instant' });
  });

  it('clamps raw fallback scrolling when no saved candidate remains rendered', () => {
    const root = document.createElement('div');
    document.body.append(root);
    rendered(root, ['other'], [200]);
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 300 });
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 900 });
    const anchor: GalleryAnchor = {
      kind: 'album-entry', entryId: 'missing', viewportOffset: 0, fallbackScrollY: 1200,
      before: [], after: [],
    };

    expect(restoreRenderedGalleryAnchor(root, anchor, 100)).toBe('fallback');
    expect(scrollTo).toHaveBeenCalledWith({ top: 600, behavior: 'instant' });
  });
});

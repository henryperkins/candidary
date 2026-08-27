import { anchorCandidateIds, type GalleryAnchor } from '../../app/manager-history-state';

const MAX_NEIGHBORS = 20;

export type GalleryAnchorRestoreOutcome = 'pending' | 'item' | 'fallback';

function renderedAnchorElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-gallery-anchor-id]'));
}

function scrollToY(top: number): void {
  window.scrollTo({ top, behavior: 'instant' as ScrollBehavior });
}

function maxScrollY(): number {
  return Math.max(0, Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) - window.innerHeight);
}

export function captureRenderedGalleryAnchor(
  root: HTMLElement,
  kind: GalleryAnchor['kind'],
  effectiveVisibleTop: number,
): GalleryAnchor | null {
  const elements = renderedAnchorElements(root);
  const index = elements.findIndex((element) => (
    element.getBoundingClientRect().bottom > effectiveVisibleTop
  ));
  const item = elements[index];
  const id = item?.dataset.galleryAnchorId;
  if (!item || !id) return null;
  const before = elements.slice(Math.max(0, index - MAX_NEIGHBORS), index)
    .map((element) => element.dataset.galleryAnchorId!)
    .reverse();
  const after = elements.slice(index + 1, index + 1 + MAX_NEIGHBORS)
    .map((element) => element.dataset.galleryAnchorId!);
  const viewportOffset = Math.round(item.getBoundingClientRect().top - effectiveVisibleTop);
  const shared = { viewportOffset, fallbackScrollY: window.scrollY, before, after };
  return kind === 'media' ? { kind, mediaId: id, ...shared } : { kind, entryId: id, ...shared };
}

export function restoreRenderedGalleryAnchor(
  root: HTMLElement,
  anchor: GalleryAnchor,
  effectiveVisibleTop: number,
): 'item' | 'fallback' {
  const byId = new Map<string, HTMLElement>();
  for (const element of renderedAnchorElements(root)) {
    const id = element.dataset.galleryAnchorId;
    if (id && !byId.has(id)) byId.set(id, element);
  }
  for (const id of anchorCandidateIds(anchor)) {
    const item = byId.get(id);
    if (!item) continue;
    const targetTop = window.scrollY + item.getBoundingClientRect().top
      - effectiveVisibleTop - anchor.viewportOffset;
    scrollToY(targetTop);
    return 'item';
  }
  scrollToY(Math.min(Math.max(0, anchor.fallbackScrollY), maxScrollY()));
  return 'fallback';
}

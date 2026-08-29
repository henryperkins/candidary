import { useEffect, useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';

/**
 * Three different things can occupy the bottom edge of a phone here: nothing, the action bar, or
 * the selection tray — whose own height moves with how its count message wraps. A reservation
 * hardcoded for one of them strands the last row of photographs, and its select control, behind
 * another. So the workspace reserves whatever is actually docked, measured.
 */
const DOCK_SELECTORS = '.selection-tray, .gallery-action';

/**
 * Only something that spans the width is reserved for. Below 761 the tray is an inset card with
 * 12px shoulders and the action bar is full-bleed; from 761 the tray becomes a `min(92vw, 470px)`
 * bottom-right card that overlays the page and carries its own clearance, which at every supported
 * width is under two thirds of it. The comparison is against `clientWidth` rather than
 * `innerWidth`, which includes a classic scrollbar and under-reports the viewport by about 15px.
 */
const SPAN_FRACTION = 0.8;

/**
 * What is reserved is the distance from the docked element's top to the bottom of the viewport,
 * not the element's own height: an inset card also owns the gap it floats above, and content
 * stopping level with its top edge is content the host can still read.
 */
function dockedExtent(root: HTMLElement): number {
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = document.documentElement.clientHeight;
  let extent = 0;
  for (const candidate of root.querySelectorAll<HTMLElement>(DOCK_SELECTORS)) {
    if (getComputedStyle(candidate).position !== 'fixed') continue;
    const rect = candidate.getBoundingClientRect();
    if (rect.height === 0) continue;
    if (rect.width < viewportWidth * SPAN_FRACTION) continue;
    extent = Math.max(extent, viewportHeight - rect.top);
  }
  return Math.max(0, extent);
}

/**
 * Writes the docked height to `--gallery-dock` on the Manager shell, which the workspace's own
 * bottom padding reads.
 *
 * The write is a DOM write rather than state, and it is synchronous rather than deferred to
 * `requestAnimationFrame`: an occluded iframe has its frame callbacks throttled, and offscreen
 * mounting is how thumbnail grids render. It cannot loop, because `--gallery-dock` changes the
 * workspace's padding, which changes the shell's height, and the next notification re-measures a
 * fixed bar whose own height did not move — so the equality guard ends the cycle in one round.
 */
export function useGalleryDock(rootRef: RefObject<HTMLElement | null>): void {
  const written = useRef<string | null>(null);
  const observed = useRef<HTMLElement | null>(null);

  const measure = useRef(() => {});
  measure.current = () => {
    const root = rootRef.current;
    if (root === null) return;
    const shell = root.closest<HTMLElement>('.manager-shell') ?? root;
    const value = `${Math.round(dockedExtent(root))}px`;
    if (written.current === value) return;
    written.current = value;
    shell.style.setProperty('--gallery-dock', value);
  };

  // No dependency array: a mode change, a filter change, or a tray verb swapping its label all
  // arrive as an ordinary render, and each of them can change what is docked.
  useLayoutEffect(() => {
    measure.current();
  });

  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const shell = root.closest<HTMLElement>('.manager-shell') ?? root;
    const remeasure = () => { measure.current(); };

    // The shell is observed because its own height moves with the reservation; the docked element
    // is observed because a wrapped count message is the case a fixed height would miss. Absent —
    // jsdom has no ResizeObserver — the resize listener and the mutation watch still carry the
    // cases a rendered test can produce.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(remeasure);
    observer?.observe(shell);
    const retargetDock = () => {
      // A selection tray suppresses the action host and owns the real reservation. Prefer it even
      // though the stable host appears earlier in the workspace heading.
      const docked = root.querySelector<HTMLElement>('.selection-tray')
        ?? root.querySelector<HTMLElement>('.gallery-action');
      if (docked === observed.current) return;
      if (observed.current !== null) observer?.unobserve(observed.current);
      observed.current = docked;
      if (docked !== null) observer?.observe(docked);
    };
    retargetDock();

    // The tray belongs to Library and Guest gallery, not to this workspace, so its arrival is a
    // subtree mutation rather than a render here. Only dock nodes are worth a re-measure — a
    // continuation page appending forty tiles is not.
    const touchesDock = (nodes: NodeList): boolean => {
      for (const node of nodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches(DOCK_SELECTORS) || node.querySelector(DOCK_SELECTORS) !== null) return true;
      }
      return false;
    };
    const mutations = new MutationObserver((records) => {
      for (const record of records) {
        const dockIdentityChanged = record.type === 'attributes'
          && record.target instanceof HTMLElement
          && record.target.matches(DOCK_SELECTORS);
        if (dockIdentityChanged || touchesDock(record.addedNodes) || touchesDock(record.removedNodes)) {
          retargetDock();
          remeasure();
          return;
        }
      }
    });
    mutations.observe(root, { attributes: true, attributeFilter: ['class'], childList: true, subtree: true });

    window.addEventListener('resize', remeasure);
    return () => {
      window.removeEventListener('resize', remeasure);
      mutations.disconnect();
      observer?.disconnect();
      observed.current = null;
      written.current = null;
      shell.style.removeProperty('--gallery-dock');
    };
  }, [rootRef]);

}

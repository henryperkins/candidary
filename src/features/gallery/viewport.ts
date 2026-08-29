import { useEffect, useState } from 'react';

/** The single Gallery breakpoint: below it the frame is the phone frame, above it it unfolds. */
export const GALLERY_WIDE_MIN_WIDTH = 761;

/**
 * True once the viewport is wide enough for the desktop frame — the action returns to the heading's
 * baseline and Album's details stand open, so neither needs its phone affordance.
 *
 * Read from `innerWidth` rather than `matchMedia` because it is the same number the layout is
 * authored against, and it is defined everywhere this renders.
 */
export function useWideViewport(): boolean {
  const [wide, setWide] = useState(() => (
    typeof window === 'undefined' || window.innerWidth >= GALLERY_WIDE_MIN_WIDTH
  ));
  useEffect(() => {
    const read = () => { setWide(window.innerWidth >= GALLERY_WIDE_MIN_WIDTH); };
    read();
    window.addEventListener('resize', read);
    return () => { window.removeEventListener('resize', read); };
  }, []);
  return wide;
}

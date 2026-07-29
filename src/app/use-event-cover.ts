import { useEffect, useRef, useState } from 'react';

export function useEventCover(path: string | null): string | null {
  const [cover, setCover] = useState<{ path: string; url: string } | null>(null);
  const coverUrlRef = useRef<string | null>(null);

  useEffect(() => {
    let current = true;
    const controller = new AbortController();
    const clearCover = () => {
      const previous = coverUrlRef.current;
      coverUrlRef.current = null;
      if (previous) URL.revokeObjectURL(previous);
    };

    clearCover();
    setCover(null);
    if (!path) return () => {
      current = false;
      controller.abort();
    };

    void (async () => {
      try {
        const response = await fetch(path, { credentials: 'same-origin', signal: controller.signal });
        if (!response.ok) return;
        const blob = await response.blob();
        const nextUrl = URL.createObjectURL(blob);
        if (!current) {
          URL.revokeObjectURL(nextUrl);
          return;
        }
        coverUrlRef.current = nextUrl;
        setCover({ path, url: nextUrl });
      } catch {
        // A private cover is optional, and aborted or failed reads keep the gradient fallback.
      }
    })();

    return () => {
      current = false;
      controller.abort();
      clearCover();
    };
  }, [path]);

  return cover?.path === path ? cover.url : null;
}

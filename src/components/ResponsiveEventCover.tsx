import { useEffect, useRef, useState } from 'react';

import {
  resolveCoverProfile,
  type EventCoverDensity,
  type EventCoverFormat,
  type EventCoverProfileId,
  type EventCoverSurfaceTreatmentId,
} from '../../shared/event-cover';

/**
 * The shared guest/Manager responsive image contract.
 *
 * Not wired to any shipped surface in this release. The guest hero still
 * installs a fetched blob as a CSS background, and phase 3 is where the
 * revision/profile/density routes are registered and this replaces it.
 *
 * The profile comes from measuring the actual container and hero state, never
 * from a user agent, a phone model, or a query string. Density selection is then
 * the browser's own resource-selection algorithm over the candidates advertised
 * here — this component does not promise a particular candidate on a particular
 * device, only that every candidate it offers exists.
 */

export interface ResponsiveEventCoverSource {
  revision: number;
  hasCover: boolean;
  /** Sorted, allowlisted, server-resolved. Never client-authored geometry. */
  available2xProfiles: readonly EventCoverProfileId[];
  surfaceTreatment: EventCoverSurfaceTreatmentId;
}

export interface ResponsiveEventCoverProps {
  cover: ResponsiveEventCoverSource;
  /** The authorized, same-origin route for one allowlisted slot. */
  sourceFor(slot: {
    revision: number;
    profile: EventCoverProfileId;
    density: EventCoverDensity;
    format: EventCoverFormat;
  }): string;
  welcomeExpanded?: boolean;
  lookup?: boolean;
  /** One sanitized observable event, never storage state. */
  onUnavailable?(detail: { profile: EventCoverProfileId; revision: number }): void;
  /** At most one event-view refresh per revision and profile. */
  onRefreshEvent?(): void;
}

interface Measurement {
  containerWidth: number;
  viewportWidth: number;
  viewportHeight: number;
}

function readViewport(): { viewportWidth: number; viewportHeight: number } {
  return {
    viewportWidth: typeof window === 'undefined' ? 0 : window.innerWidth,
    viewportHeight: typeof window === 'undefined' ? 0 : window.innerHeight,
  };
}

export function ResponsiveEventCover({
  cover,
  sourceFor,
  welcomeExpanded = false,
  lookup = false,
  onUnavailable,
  onRefreshEvent,
}: ResponsiveEventCoverProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  // Null until the container has actually been measured. Guessing a profile and
  // correcting it afterwards would fetch an image the layout never needed.
  const [measurement, setMeasurement] = useState<Measurement | null>(null);
  const [webpSuppressed, setWebpSuppressed] = useState(false);
  const [failed, setFailed] = useState(false);
  const refreshedRef = useRef<string | null>(null);

  useEffect(() => {
    const element = frameRef.current;
    if (!element) return;

    const apply = (containerWidth: number) => {
      if (containerWidth <= 0) return;
      setMeasurement({ containerWidth, ...readViewport() });
    };

    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver((entries) => {
        apply(entries[0]?.contentRect.width ?? element.clientWidth);
      });
      observer.observe(element);
      const onResize = () => apply(element.clientWidth || element.getBoundingClientRect().width);
      window.addEventListener('resize', onResize);
      return () => {
        observer.disconnect();
        window.removeEventListener('resize', onResize);
      };
    }

    const onResize = () => apply(element.clientWidth || element.getBoundingClientRect().width);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const profile = measurement
    ? resolveCoverProfile({
      containerWidth: measurement.containerWidth,
      viewportWidth: measurement.viewportWidth,
      viewportHeight: measurement.viewportHeight,
      welcomeExpanded,
      lookup,
    })
    : null;

  // A newer revision, or a different profile, is a different image: recovery
  // state resets rather than holding a gradient over bytes that may be fine.
  const slotKey = profile ? `${cover.revision}:${profile}` : null;
  useEffect(() => {
    setWebpSuppressed(false);
    setFailed(false);
  }, [slotKey]);

  const showPicture = cover.hasCover && profile !== null && !failed;

  function handleError() {
    if (!profile) return;
    if (!webpSuppressed) {
      // The WebP candidate failed. Drop that source once and let the verified
      // JPEG fallback answer; the picture is not given up on yet.
      setWebpSuppressed(true);
      return;
    }
    // The fallback failed too. Suppress immediately so no broken-image icon can
    // appear, then report once and refresh at most once for this exact slot.
    setFailed(true);
    onUnavailable?.({ profile, revision: cover.revision });
    if (refreshedRef.current !== slotKey) {
      refreshedRef.current = slotKey;
      onRefreshEvent?.();
    }
  }

  const has2x = profile !== null && cover.available2xProfiles.includes(profile);

  function candidates(format: EventCoverFormat): string {
    if (!profile) return '';
    const one = sourceFor({ revision: cover.revision, profile, density: '1x', format });
    if (!has2x) return `${one} 1x`;
    const two = sourceFor({ revision: cover.revision, profile, density: '2x', format });
    // Density descriptors, so no `sizes` attribute is needed or implied.
    return `${one} 1x, ${two} 2x`;
  }

  return <div
    ref={frameRef}
    className={[
      'responsive-cover',
      showPicture ? 'responsive-cover--image' : 'responsive-cover--gradient',
      cover.surfaceTreatment === 'film-grain-v1' ? 'responsive-cover--film-grain' : '',
    ].filter(Boolean).join(' ')}
    data-cover-profile={profile ?? undefined}
  >
    {showPicture && <picture key={slotKey ?? 'unmeasured'}>
      {!webpSuppressed && <source type="image/webp" srcSet={candidates('webp')} />}
      <img
        className="responsive-cover__image"
        // Empty on purpose: event identity and the welcome copy already name
        // this experience, and the cover is decoration over them.
        alt=""
        src={sourceFor({
          revision: cover.revision,
          profile: profile!,
          density: '1x',
          format: 'jpeg',
        })}
        srcSet={candidates('jpeg')}
        decoding="async"
        onError={handleError}
      />
    </picture>}
    {/* Runtime layers, in order: image, grain, contrast scrim, then content.
        None is ever baked into a rendered derivative, so a theme change is free. */}
    <div className="responsive-cover__treatment" aria-hidden="true" />
    <div className="responsive-cover__scrim" aria-hidden="true" />
  </div>;
}

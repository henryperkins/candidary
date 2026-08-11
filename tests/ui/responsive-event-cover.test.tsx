import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EventCoverProfileId } from '../../shared/event-cover';
import { ResponsiveEventCover } from '../../src/components/ResponsiveEventCover';

/**
 * The reader ships complete and wired to nothing. `tests/e2e/security.spec.ts`
 * still asserts the guest hero's `background-image` matches `/blob:/`, which is
 * the standing proof that phase 1 left it unwired.
 */

let observedWidth = 390;

class TestResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}

  observe() {
    this.callback(
      [{ contentRect: { width: observedWidth } } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }

  disconnect() {}

  unobserve() {}
}

function sourceFor(slot: {
  revision: number;
  profile: string;
  density: string;
  format: string;
}): string {
  return `/api/event/maya-theo/cover/${slot.revision}/${slot.profile}/${slot.density}.${slot.format}`;
}

function renderCover(options: {
  containerWidth?: number;
  viewportWidth?: number;
  viewportHeight?: number;
  welcomeExpanded?: boolean;
  lookup?: boolean;
  available2xProfiles?: readonly EventCoverProfileId[];
  hasCover?: boolean;
  revision?: number;
  onUnavailable?: () => void;
  onRefreshEvent?: () => void;
} = {}) {
  observedWidth = options.containerWidth ?? 390;
  window.innerWidth = options.viewportWidth ?? 390;
  window.innerHeight = options.viewportHeight ?? 844;
  return render(<ResponsiveEventCover
    cover={{
      revision: options.revision ?? 3,
      hasCover: options.hasCover ?? true,
      available2xProfiles: options.available2xProfiles ?? [],
      surfaceTreatment: 'none',
    }}
    sourceFor={sourceFor}
    welcomeExpanded={options.welcomeExpanded ?? false}
    lookup={options.lookup ?? false}
    onUnavailable={options.onUnavailable}
    onRefreshEvent={options.onRefreshEvent}
  />);
}

function frame(): HTMLElement {
  return document.querySelector<HTMLElement>('.responsive-cover')!;
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('responsive event cover', () => {
  it('installs one profile only after the container is measured', () => {
    renderCover({ containerWidth: 390 });
    expect(frame().dataset.coverProfile).toBe('compact-default');
    const image = screen.getByRole('presentation', { hidden: true }) as HTMLImageElement;
    expect(image.getAttribute('src'))
      .toBe('/api/event/maya-theo/cover/3/compact-default/1x.jpeg');
    // Every URL carries the active revision, so a newer view changes the source.
    expect(image.getAttribute('src')).toContain('/3/');
  });

  it.each([
    // container, viewportW, viewportH, expanded, lookup, profile
    [360, 360, 568, false, true, 'short-lookup'],
    [361, 361, 568, false, true, 'compact-default'],
    [360, 360, 599, false, true, 'short-lookup'],
    // The lookup hero's height bound is inclusive: 600 is still short.
    [360, 360, 600, false, true, 'short-lookup'],
    [360, 360, 601, false, true, 'compact-default'],
    [390, 390, 844, true, false, 'compact-expanded'],
    [391, 391, 844, true, false, 'wide-expanded'],
    [699, 699, 844, false, false, 'standard-default'],
    [620, 700, 760, false, false, 'framed-default'],
    [620, 700, 759, false, false, 'standard-default'],
    [390, 390, 844, false, false, 'compact-default'],
    [391, 391, 844, false, false, 'standard-default'],
  ])('maps %ipx/%ix%i expanded=%s lookup=%s to %s', (
    containerWidth,
    viewportWidth,
    viewportHeight,
    welcomeExpanded,
    lookup,
    profile,
  ) => {
    renderCover({ containerWidth, viewportWidth, viewportHeight, welcomeExpanded, lookup });
    expect(frame().dataset.coverProfile).toBe(profile);
  });

  it('advertises the 2x pair only for a qualified profile', () => {
    const { container } = renderCover({
      containerWidth: 390,
      available2xProfiles: ['compact-default'],
    });
    const source = container.querySelector('source')!;
    expect(source.getAttribute('srcset')).toBe(
      '/api/event/maya-theo/cover/3/compact-default/1x.webp 1x, /api/event/maya-theo/cover/3/compact-default/2x.webp 2x',
    );
    // Density descriptors, so no `sizes` attribute is needed.
    expect(source.getAttribute('sizes')).toBeNull();
  });

  it('offers only the mandatory 1x pair when the source cannot make 2x', () => {
    const { container } = renderCover({ containerWidth: 390, available2xProfiles: [] });
    expect(container.querySelector('source')!.getAttribute('srcset'))
      .toBe('/api/event/maya-theo/cover/3/compact-default/1x.webp 1x');
    const image = container.querySelector('img')!;
    expect(image.getAttribute('srcset'))
      .toBe('/api/event/maya-theo/cover/3/compact-default/1x.jpeg 1x');
  });

  it('drops the WebP source once and keeps the verified JPEG', () => {
    const onUnavailable = vi.fn();
    const { container } = renderCover({ containerWidth: 390, onUnavailable });
    expect(container.querySelector('source')).not.toBeNull();

    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('source')).toBeNull();
    // Still a picture: the fallback has not been given a chance to fail yet.
    expect(container.querySelector('img')).not.toBeNull();
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it('shows the no-cover hero after the fallback fails, once, without looping', () => {
    const onUnavailable = vi.fn();
    const onRefreshEvent = vi.fn();
    const { container } = renderCover({ containerWidth: 390, onUnavailable, onRefreshEvent });

    fireEvent.error(container.querySelector('img')!);
    fireEvent.error(container.querySelector('img')!);

    // Suppressed immediately, so no broken-image icon can ever be painted.
    expect(container.querySelector('img')).toBeNull();
    expect(frame().className).toContain('responsive-cover--gradient');
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(onRefreshEvent).toHaveBeenCalledTimes(1);
  });

  it('resets recovery on a newer revision and refreshes at most once per slot', () => {
    const onRefreshEvent = vi.fn();
    const { container, rerender } = renderCover({ containerWidth: 390, revision: 3, onRefreshEvent });
    fireEvent.error(container.querySelector('img')!);
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();

    rerender(<ResponsiveEventCover
      cover={{ revision: 4, hasCover: true, available2xProfiles: [], surfaceTreatment: 'none' }}
      sourceFor={sourceFor}
      onRefreshEvent={onRefreshEvent}
    />);
    const retried = container.querySelector('img')!;
    expect(retried.getAttribute('src')).toContain('/4/');
    expect(onRefreshEvent).toHaveBeenCalledTimes(1);
  });

  it('renders the theme gradient and no picture when there is no cover', () => {
    const { container } = renderCover({ hasCover: false });
    expect(container.querySelector('picture')).toBeNull();
    expect(frame().className).toContain('responsive-cover--gradient');
  });

  it('marks the film surface treatment without changing the image', () => {
    render(<ResponsiveEventCover
      cover={{
        revision: 1,
        hasCover: true,
        available2xProfiles: [],
        surfaceTreatment: 'film-grain-v1',
      }}
      sourceFor={sourceFor}
    />);
    expect(frame().className).toContain('responsive-cover--film-grain');
    // The grain is a runtime layer over the image, never baked into the bytes.
    expect(document.querySelector('.responsive-cover__treatment')).not.toBeNull();
  });
});

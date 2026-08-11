import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

import { MAX_COVER_MANUAL_ZOOM } from '../../../shared/constants';

/**
 * Automatic composition, with a correction path that needs no vocabulary.
 *
 * Candidary proposes the crop; the host may drag, or use three native ranges,
 * or reset. Drag moves the horizontal and vertical values and is never the only
 * input — Zoom stays a native range precisely so a two-finger gesture keeps
 * meaning browser page zoom rather than being captured here.
 */

export interface CoverFocusValue {
  x: number;
  y: number;
  zoom: number;
}

interface CoverComposerProps {
  value: CoverFocusValue;
  /** The draft's server-calculated ceiling, never the absolute 2.0. */
  safeZoomMaximum: number;
  /** The uncropped natural preview; positioning is applied locally. */
  previewUrl: string;
  /** Empty when the selected crop can produce no 2x profile at all. */
  available2xProfiles: readonly string[];
  onChange(value: CoverFocusValue): void;
  onReset(): void;
  disabled?: boolean;
}

function percent(value: number): number {
  return Math.round(value * 100);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function CoverComposer({
  value,
  safeZoomMaximum,
  previewUrl,
  available2xProfiles,
  onChange,
  onReset,
  disabled = false,
}: CoverComposerProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const dragOriginRef = useRef<{ x: number; y: number; from: CoverFocusValue } | null>(null);
  const [summary, setSummary] = useState('');
  const settleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Nothing is announced until the host has actually done something. Without
  // this the effect below fires on mount and reads out a crop summary 400 ms
  // after the step opens, with no interaction behind it.
  const interactedRef = useRef(false);

  // Announced when an interaction settles, never for every intermediate value:
  // a range that speaks on each arrow key makes a screen reader unusable.
  useEffect(() => {
    if (!interactedRef.current) return;
    if (settleRef.current) clearTimeout(settleRef.current);
    settleRef.current = setTimeout(() => {
      setSummary(
        `Cover positioned ${percent(value.x)} percent from left, ${percent(value.y)} percent from top, ${percent(value.zoom)} percent zoom.`,
      );
    }, 400);
    return () => {
      if (settleRef.current) clearTimeout(settleRef.current);
    };
  }, [value.x, value.y, value.zoom]);

  function change(next: CoverFocusValue) {
    interactedRef.current = true;
    onChange(next);
  }

  const ceiling = Math.min(safeZoomMaximum, MAX_COVER_MANUAL_ZOOM);

  // A delta from where the drag started, so the subject follows the pointer.
  // Jumping the focal point to wherever the surface was first touched would
  // move the crop before the host had asked for anything.
  function move(event: ReactPointerEvent<HTMLDivElement>) {
    const origin = dragOriginRef.current;
    if (!origin || disabled) return;
    const surface = surfaceRef.current;
    if (!surface) return;
    const bounds = surface.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    change({
      ...origin.from,
      x: clamp01(origin.from.x - (event.clientX - origin.x) / bounds.width),
      y: clamp01(origin.from.y - (event.clientY - origin.y) / bounds.height),
    });
  }

  return <div className="cover-composer">
    <div
      ref={surfaceRef}
      className="cover-composer__surface"
      style={{
        backgroundImage: `url("${previewUrl}")`,
        backgroundPosition: `${percent(value.x)}% ${percent(value.y)}%`,
        backgroundSize: `${percent(value.zoom)}%`,
      }}
      // Not a two-pointer surface. Browser pinch and page zoom stay native, and
      // the viewport never sets `user-scalable=no`.
      onPointerDown={(event) => {
        if (disabled) return;
        dragOriginRef.current = { x: event.clientX, y: event.clientY, from: value };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={move}
      onPointerUp={(event) => {
        dragOriginRef.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
    />

    {available2xProfiles.length === 0 && <p className="cover-composer__note">
      {/* Non-blocking: the photo is valid at every 1x profile, and zoom can
          never invalidate one. */}
      This photo works in every layout. It may look slightly softer on some
      high-density screens.
    </p>}

    <div className="cover-composer__controls">
      <label>
        <span>Horizontal focus</span>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={percent(value.x)}
          disabled={disabled}
          aria-valuetext={`${percent(value.x)} percent from left`}
          onChange={(event) => change({ ...value, x: Number(event.target.value) / 100 })}
        />
      </label>
      <label>
        <span>Vertical focus</span>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={percent(value.y)}
          disabled={disabled}
          aria-valuetext={`${percent(value.y)} percent from top`}
          onChange={(event) => change({ ...value, y: Number(event.target.value) / 100 })}
        />
      </label>
      <label>
        <span>Zoom</span>
        <input
          type="range"
          min={100}
          max={percent(ceiling)}
          step={5}
          value={percent(value.zoom)}
          disabled={disabled}
          aria-valuetext={`${percent(value.zoom)} percent zoom`}
          onChange={(event) => change({ ...value, zoom: Number(event.target.value) / 100 })}
        />
      </label>
      {/* Immediately after the ranges in focus order, so the way back is where
          a host who has just over-adjusted will reach for it. */}
      <button
        type="button"
        className="button button--secondary"
        disabled={disabled}
        onClick={() => { interactedRef.current = true; onReset(); }}
      >
        Reset to automatic
      </button>
    </div>

    <p className="sr-only" role="status">{summary}</p>
  </div>;
}

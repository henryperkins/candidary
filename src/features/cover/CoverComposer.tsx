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
  const draggingRef = useRef(false);
  const [summary, setSummary] = useState('');
  const settleRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Announced when an interaction settles, never for every intermediate value:
  // a range that speaks on each arrow key makes a screen reader unusable.
  useEffect(() => {
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

  const ceiling = Math.min(safeZoomMaximum, MAX_COVER_MANUAL_ZOOM);

  function move(event: ReactPointerEvent<HTMLDivElement>) {
    if (!draggingRef.current || disabled) return;
    const surface = surfaceRef.current;
    if (!surface) return;
    const bounds = surface.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    onChange({
      ...value,
      x: clamp01((event.clientX - bounds.left) / bounds.width),
      y: clamp01((event.clientY - bounds.top) / bounds.height),
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
        draggingRef.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        move(event);
      }}
      onPointerMove={move}
      onPointerUp={(event) => {
        draggingRef.current = false;
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
          onChange={(event) => onChange({ ...value, x: Number(event.target.value) / 100 })}
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
          onChange={(event) => onChange({ ...value, y: Number(event.target.value) / 100 })}
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
          onChange={(event) => onChange({ ...value, zoom: Number(event.target.value) / 100 })}
        />
      </label>
      {/* Immediately after the ranges in focus order, so the way back is where
          a host who has just over-adjusted will reach for it. */}
      <button type="button" className="button button--secondary" disabled={disabled} onClick={onReset}>
        Reset to automatic
      </button>
    </div>

    <p className="sr-only" role="status">{summary}</p>
  </div>;
}

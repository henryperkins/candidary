import { useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, Ref } from 'react';

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

export interface CoverComposerHandle {
  applyCanvasDrag(value: CoverFocusValue): void;
}

interface CoverComposerProps {
  ref?: Ref<CoverComposerHandle>;
  value: CoverFocusValue;
  /** The draft's server-calculated ceiling, never the absolute 2.0. */
  safeZoomMaximum: number;
  /** Empty when the selected crop can produce no 2x profile at all. */
  available2xProfiles: readonly string[];
  manual: boolean;
  onChange(value: CoverFocusValue): void;
  onAdjust(): void;
  onReset(): void;
  disabled?: boolean;
}

function percent(value: number): number {
  return Math.round(value * 100);
}

export function CoverComposer({
  ref,
  value,
  safeZoomMaximum,
  available2xProfiles,
  manual,
  onChange,
  onAdjust,
  onReset,
  disabled = false,
}: CoverComposerProps) {
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

  useImperativeHandle(ref, () => ({
    applyCanvasDrag(next) {
      if (!disabled) change(next);
    },
  }), [disabled, onChange]);

  const ceiling = Math.min(safeZoomMaximum, MAX_COVER_MANUAL_ZOOM);

  function rangeKey(
    event: ReactKeyboardEvent<HTMLInputElement>,
    current: number,
    minimum: number,
    maximum: number,
    step: number,
    apply: (next: number) => void,
  ) {
    let next: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = current + step;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = current - step;
    if (event.key === 'PageUp') next = current + step * 10;
    if (event.key === 'PageDown') next = current - step * 10;
    if (event.key === 'Home') next = minimum;
    if (event.key === 'End') next = maximum;
    if (next === null) return;
    event.preventDefault();
    apply(Math.min(maximum, Math.max(minimum, next)));
  }

  return <div className="cover-composer">
    <p className="cover-composer__mode">
      {manual ? 'Manual framing' : 'Automatic framing'}
    </p>
    <p className="cover-composer__instruction">
      {manual
        ? 'Drag the preview or use the controls below.'
        : 'Drag the preview to reposition it, or choose Adjust framing for precise controls.'}
    </p>

    {available2xProfiles.length === 0 && <p className="cover-composer__note">
      {/* Non-blocking: the photo is valid at every 1x profile, and zoom can
          never invalidate one. */}
      This photo works in every layout. It may look slightly softer on some
      high-density screens.
    </p>}

    {!manual
      ? <button
          type="button"
          className="button button--secondary cover-composer__adjust"
          disabled={disabled}
          onClick={onAdjust}
        >
          Adjust framing
        </button>
      : <div className="cover-composer__controls">
      <button
        type="button"
        className="button button--secondary"
        disabled={disabled}
        onClick={() => { interactedRef.current = true; onReset(); }}
      >
        Reset to automatic
      </button>
      <label>
        <span className="cover-composer__range-heading">
          <span>Left or right</span>
          <span className="cover-composer__range-value" aria-hidden="true">
            {percent(value.x)}% from left
          </span>
        </span>
        <input
          type="range"
          aria-label="Left or right"
          min={0}
          max={100}
          step={1}
          value={percent(value.x)}
          disabled={disabled}
          aria-valuetext={`${percent(value.x)} percent from left`}
          onChange={(event) => change({ ...value, x: Number(event.target.value) / 100 })}
          onKeyDown={(event) => rangeKey(
            event,
            percent(value.x),
            0,
            100,
            1,
            (next) => change({ ...value, x: next / 100 }),
          )}
        />
      </label>
      <label>
        <span className="cover-composer__range-heading">
          <span>Up or down</span>
          <span className="cover-composer__range-value" aria-hidden="true">
            {percent(value.y)}% from top
          </span>
        </span>
        <input
          type="range"
          aria-label="Up or down"
          min={0}
          max={100}
          step={1}
          value={percent(value.y)}
          disabled={disabled}
          aria-valuetext={`${percent(value.y)} percent from top`}
          onChange={(event) => change({ ...value, y: Number(event.target.value) / 100 })}
          onKeyDown={(event) => rangeKey(
            event,
            percent(value.y),
            0,
            100,
            1,
            (next) => change({ ...value, y: next / 100 }),
          )}
        />
      </label>
      <label>
        <span className="cover-composer__range-heading">
          <span>Zoom</span>
          <span className="cover-composer__range-value" aria-hidden="true">
            {percent(value.zoom)}%
          </span>
        </span>
        <input
          type="range"
          aria-label="Zoom"
          min={100}
          max={percent(ceiling)}
          step={5}
          value={percent(value.zoom)}
          disabled={disabled}
          aria-valuetext={`${percent(value.zoom)} percent zoom`}
          onChange={(event) => change({ ...value, zoom: Number(event.target.value) / 100 })}
          onKeyDown={(event) => rangeKey(
            event,
            percent(value.zoom),
            100,
            percent(ceiling),
            5,
            (next) => change({ ...value, zoom: next / 100 }),
          )}
        />
      </label>
      </div>}

    <p className="sr-only" role="status">{summary}</p>
  </div>;
}

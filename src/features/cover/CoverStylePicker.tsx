import { useLayoutEffect, useRef, useState } from 'react';

import { EVENT_COVER_EFFECTS, type EventCoverEffectId } from '../../../shared/event-cover';

export type CoverStyleThumbnailState =
  | { status: 'idle'; url: null; error: null }
  | { status: 'loading'; url: string | null; error: null }
  | { status: 'ready'; url: string; error: null }
  | { status: 'error'; url: string | null; error: unknown };

const STYLE_NAMES: Record<EventCoverEffectId, string> = {
  natural: 'Natural',
  warm: 'Warm',
  film: 'Film',
  soft: 'Soft',
  monochrome: 'Monochrome',
};

const STYLE_DESCRIPTIONS: Record<EventCoverEffectId, string> = {
  natural: 'Faithful color',
  warm: 'Gentle warmth',
  film: 'Fine grain',
  soft: 'Quieter contrast',
  monochrome: 'Black and white',
};

export function coverStyleName(effect: EventCoverEffectId): string {
  return STYLE_NAMES[effect];
}

interface CoverStylePickerProps {
  value: EventCoverEffectId;
  onChange(effect: EventCoverEffectId): void;
  thumbnail(effect: EventCoverEffectId): CoverStyleThumbnailState;
  onRetry?(effect: EventCoverEffectId): void;
  disabled?: boolean;
}

/** Named radios stay usable independently of each real preview's state. */
export function CoverStylePicker({
  value,
  onChange,
  thumbnail,
  onRetry = () => undefined,
  disabled = false,
}: CoverStylePickerProps) {
  const [retryingEffects, setRetryingEffects] = useState<ReadonlySet<EventCoverEffectId>>(
    () => new Set(),
  );
  const [completionAnnouncement, setCompletionAnnouncement] = useState('');
  const radioRefs = useRef(new Map<EventCoverEffectId, HTMLInputElement>());
  useLayoutEffect(() => {
    const settled = [...retryingEffects].filter((effect) => thumbnail(effect).status !== 'loading');
    if (settled.length === 0) return;
    const completed = settled.filter((effect) => thumbnail(effect).status === 'ready');
    const focusTarget = completed.at(-1);
    if (focusTarget !== undefined) {
      // A successful replacement removes the focused Retry. Restore a deliberate,
      // connected target without stealing focus when the host moved elsewhere while
      // the request was running.
      if (document.activeElement === document.body) {
        radioRefs.current.get(focusTarget)?.focus({ preventScroll: true });
      }
      setCompletionAnnouncement(`${coverStyleName(focusTarget)} preview ready.`);
    }
    setRetryingEffects((current) => {
      const next = new Set(current);
      for (const effect of settled) next.delete(effect);
      return next;
    });
  }, [retryingEffects, thumbnail]);

  return <fieldset className="cover-style-picker">
    <legend>Style</legend>
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {completionAnnouncement}
    </p>
    <ul>
      {EVENT_COVER_EFFECTS.map((effect) => {
        const preview = thumbnail(effect);
        const name = coverStyleName(effect);
        const retrying = preview.status === 'loading' && retryingEffects.has(effect);
        return <li key={effect} data-thumbnail-state={preview.status}>
          <label>
            <span className="cover-style-picker__choice-heading">
              <input
                ref={(node) => {
                  if (node) radioRefs.current.set(effect, node);
                  else radioRefs.current.delete(effect);
                }}
                type="radio"
                name="cover-style"
                value={effect}
                checked={value === effect}
                disabled={disabled}
                onChange={() => onChange(effect)}
              />
              <span className="cover-style-picker__name">{name}</span>
            </span>
            {preview.url
              ? <img src={preview.url} alt="" aria-hidden="true" />
              : <span className="cover-style-picker__placeholder" aria-hidden="true" />}
            <span className="cover-style-picker__note">{STYLE_DESCRIPTIONS[effect]}</span>
          </label>
          {preview.status === 'idle' && <span className="cover-style-picker__state">
            Preview not ready
          </span>}
          {(preview.status === 'loading' || preview.status === 'error') && <div
            className={`cover-style-picker__state${preview.status === 'error'
              ? ' cover-style-picker__state--error'
              : ''}`}
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <span>{preview.status === 'loading'
              ? `Loading ${name} preview`
              : 'Preview unavailable. Try this preview again.'}</span>
            {(preview.status === 'error' || retrying) && <button
              type="button"
              className="button button--secondary"
              aria-label={retrying
                ? `Retrying ${name} preview`
                : `Retry ${name} preview`}
              disabled={disabled}
              aria-disabled={retrying || undefined}
              aria-busy={retrying || undefined}
              onClick={() => {
                if (disabled || preview.status !== 'error') return;
                setCompletionAnnouncement('');
                setRetryingEffects((current) => {
                  const next = new Set(current);
                  next.add(effect);
                  return next;
                });
                onRetry(effect);
              }}
            >
              {retrying ? 'Retrying…' : 'Retry'}
            </button>}
          </div>}
        </li>;
      })}
    </ul>
  </fieldset>;
}

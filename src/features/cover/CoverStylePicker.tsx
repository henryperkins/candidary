import { EVENT_COVER_EFFECTS, type EventCoverEffectId } from '../../../shared/event-cover';

export type CoverStyleThumbnailState =
  | { status: 'idle'; url: null; error: null }
  | { status: 'loading'; url: null; error: null }
  | { status: 'ready'; url: string; error: null }
  | { status: 'error'; url: null; error: unknown };

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
  onRetry = onChange,
  disabled = false,
}: CoverStylePickerProps) {
  return <fieldset className="cover-style-picker">
    <legend>Style</legend>
    <ul>
      {EVENT_COVER_EFFECTS.map((effect) => {
        const preview = thumbnail(effect);
        const name = STYLE_NAMES[effect];
        return <li key={effect} data-thumbnail-state={preview.status}>
          <label>
            <input
              type="radio"
              name="cover-style"
              value={effect}
              checked={value === effect}
              disabled={disabled}
              onChange={() => onChange(effect)}
            />
            {preview.status === 'ready'
              ? <img src={preview.url} alt="" aria-hidden="true" />
              : <span className="cover-style-picker__placeholder" aria-hidden="true" />}
            <span className="cover-style-picker__name">{name}</span>
            <span className="cover-style-picker__note">{STYLE_DESCRIPTIONS[effect]}</span>
          </label>
          {preview.status === 'loading' && <span className="cover-style-picker__state">
            Loading {name} preview
          </span>}
          {preview.status === 'error' && <div className="cover-style-picker__state cover-style-picker__state--error">
            <span>Preview unavailable. Try this preview again.</span>
            <button
              type="button"
              className="button button--secondary"
              aria-label={`Retry ${name} preview`}
              onClick={() => onRetry(effect)}
            >
              Retry
            </button>
          </div>}
        </li>;
      })}
    </ul>
  </fieldset>;
}

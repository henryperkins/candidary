import { EVENT_COVER_EFFECTS, type EventCoverEffectId } from '../../../shared/event-cover';

/**
 * Exactly five styles, for uploads and built-in designs alike.
 *
 * No intensity slider, and no numeric value a host could submit: each recipe is
 * a fixed implementation constant built from allowlisted image operations. The
 * event theme owns guest surfaces and controls; the recipe owns source,
 * composition, and style; and they stay independent, so changing a theme later
 * preserves the photo exactly.
 */

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
  /** One authorized preview per draft and effect; never a client transform. */
  thumbnail(effect: EventCoverEffectId): string;
  disabled?: boolean;
}

export function CoverStylePicker({
  value,
  onChange,
  thumbnail,
  disabled = false,
}: CoverStylePickerProps) {
  return <fieldset className="cover-style-picker">
    <legend>Style</legend>
    <ul>
      {EVENT_COVER_EFFECTS.map((effect) => <li key={effect}>
        <label>
          <input
            type="radio"
            name="cover-style"
            value={effect}
            checked={value === effect}
            disabled={disabled}
            onChange={() => onChange(effect)}
          />
          <img src={thumbnail(effect)} alt="" aria-hidden="true" />
          {/* Names, always: selection is never carried by an image alone or by
              color alone. */}
          <span className="cover-style-picker__name">{STYLE_NAMES[effect]}</span>
          <span className="cover-style-picker__note">{STYLE_DESCRIPTIONS[effect]}</span>
        </label>
      </li>)}
    </ul>
  </fieldset>;
}

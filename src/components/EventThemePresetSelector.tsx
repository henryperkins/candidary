import type { EventThemePresetId } from '../../shared/contracts';
import { EVENT_THEME_PRESETS } from '../../shared/event-theme';

export interface EventThemePresetSelectorProps {
  value: EventThemePresetId;
  onChange(value: EventThemePresetId): void;
  name: string;
  disabled?: boolean;
}

export function EventThemePresetSelector({
  value,
  onChange,
  name,
  disabled = false,
}: EventThemePresetSelectorProps) {
  return <fieldset className="event-theme-preset-selector">
    <legend>Event appearance</legend>
    <div className="event-theme-preset-selector__options">
      {EVENT_THEME_PRESETS.map((preset) => <label className="event-theme-preset-selector__option" key={preset.id}>
        <input
          type="radio"
          name={name}
          value={preset.id}
          checked={value === preset.id}
          disabled={disabled}
          aria-label={preset.name}
          onChange={() => onChange(preset.id)}
        />
        <span className="event-theme-preset-selector__copy">
          <span className="event-theme-preset-selector__name">{preset.name}</span>
          <span className="event-theme-preset-selector__description">{preset.description}</span>
        </span>
        <span className="event-theme-preset-selector__swatch" data-event-theme-swatch aria-hidden="true">
          <i style={{ backgroundColor: preset.tokens.primary }} />
          <i style={{ backgroundColor: preset.tokens.accent }} />
          <i style={{ backgroundColor: preset.tokens.surface }} />
        </span>
      </label>)}
    </div>
  </fieldset>;
}

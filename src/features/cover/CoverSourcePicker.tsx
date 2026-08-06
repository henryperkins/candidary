import {
  EVENT_COVER_PRESETS,
  type EventCoverPresetId,
} from '../../../shared/event-cover';
import { COVER_UPLOAD_MIME_TYPES } from '../../../shared/constants';

/**
 * Upload, plus exactly six built-in designs.
 *
 * Six global choices, not six per theme: the same artwork is coordinated with
 * any of the four event themes by a runtime overlay recipe, so a theme change
 * never silently swaps the picture.
 *
 * `Remove cover` is a secondary action beside these, deliberately not a seventh
 * tile — removing a cover is not choosing one.
 */

export type CoverSourceChoice =
  | { kind: 'upload' }
  | { kind: 'preset'; presetId: EventCoverPresetId };

interface CoverSourcePickerProps {
  value: CoverSourceChoice | null;
  onChoose(choice: CoverSourceChoice): void;
  onUpload(file: File): void;
  onRemove?(): void;
  /** Preset thumbnails come from the versioned static manifest, not a guess. */
  presetThumbnail(presetId: EventCoverPresetId): string;
  busy?: boolean;
  canRemove?: boolean;
}

export function CoverSourcePicker({
  value,
  onChoose,
  onUpload,
  onRemove,
  presetThumbnail,
  busy = false,
  canRemove = false,
}: CoverSourcePickerProps) {
  return <div className="cover-source-picker">
    <fieldset className="cover-source-picker__group">
      <legend>Cover</legend>

      <label className="cover-source-picker__upload">
        <input
          type="radio"
          name="cover-source"
          value="upload"
          checked={value?.kind === 'upload'}
          disabled={busy}
          onChange={() => onChoose({ kind: 'upload' })}
        />
        <span className="cover-source-picker__name">Upload a photo</span>
        <input
          className="sr-only cover-source-picker__file"
          type="file"
          accept={COVER_UPLOAD_MIME_TYPES.join(',')}
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onUpload(file);
          }}
        />
      </label>

      <ul className="cover-source-picker__presets">
        {EVENT_COVER_PRESETS.map((preset) => <li key={preset.id}>
          <label>
            <input
              type="radio"
              name="cover-source"
              value={preset.id}
              checked={value?.kind === 'preset' && value.presetId === preset.id}
              disabled={busy}
              onChange={() => onChoose({ kind: 'preset', presetId: preset.id })}
            />
            {/* Named, always. An image alone never communicates selection. */}
            <img src={presetThumbnail(preset.id)} alt="" aria-hidden="true" />
            <span className="cover-source-picker__name">{preset.name}</span>
            {/* Already composed for every size, which is why a preset skips
                Compose entirely rather than opening an empty step. */}
            <span className="cover-source-picker__note">Ready for every size</span>
          </label>
        </li>)}
      </ul>
    </fieldset>

    {canRemove && onRemove && <button
      type="button"
      className="button button--secondary cover-source-picker__remove"
      disabled={busy}
      onClick={onRemove}
    >
      Remove cover
    </button>}
  </div>;
}

import { useId } from 'react';

import { COVER_UPLOAD_MIME_TYPES, MAX_COVER_UPLOAD_BYTES } from '../../../shared/constants';
import {
  EVENT_COVER_PRESETS,
  type EventCoverPresetId,
} from '../../../shared/event-cover';

export type CoverSourceChoice =
  | { kind: 'upload' }
  | { kind: 'preset'; presetId: EventCoverPresetId };

interface CoverSourcePickerProps {
  value: CoverSourceChoice | null;
  onChoose(choice: CoverSourceChoice): void;
  onUpload(file: File): void;
  onRemove?(): void;
  presetThumbnail(presetId: EventCoverPresetId): string;
  busy?: boolean;
  canRemove?: boolean;
}

/** The source choice and native file chooser are distinct accessible controls. */
export function CoverSourcePicker({
  value,
  onChoose,
  onUpload,
  onRemove,
  presetThumbnail,
  busy = false,
  canRemove = false,
}: CoverSourcePickerProps) {
  const fileId = useId();

  return <div className="cover-source-picker">
    <fieldset className="cover-source-picker__group">
      <legend>Cover</legend>

      <div className="cover-source-picker__upload">
        <label className="cover-source-picker__upload-choice">
          <input
            type="radio"
            name="cover-source"
            value="upload"
            checked={value?.kind === 'upload'}
            disabled={busy}
            onChange={() => onChoose({ kind: 'upload' })}
          />
          <span className="cover-source-picker__name">Upload a photo</span>
        </label>
        <label className="button button--secondary" htmlFor={fileId}>Choose photo</label>
        <input
          id={fileId}
          className="sr-only cover-source-picker__file"
          type="file"
          aria-label="Choose photo"
          accept={COVER_UPLOAD_MIME_TYPES.join(',')}
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            // Native-picker cancellation supplies no file and changes nothing.
            if (!file) return;
            onChoose({ kind: 'upload' });
            onUpload(file);
          }}
        />
        <span className="cover-source-picker__note">
          JPEG, PNG, WebP, or HEIC · {Math.floor(MAX_COVER_UPLOAD_BYTES / 1_000_000)} MB max.
        </span>
      </div>

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
            <img src={presetThumbnail(preset.id)} alt="" aria-hidden="true" />
            <span className="cover-source-picker__name">{preset.name}</span>
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

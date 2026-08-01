import { ImagePlus } from 'lucide-react';
import { useRef, useState } from 'react';

import type {
  EventThemeConfigV1,
  EventThemePresetId,
  EventView,
  HexColor,
  ResolvedEventTheme,
} from '../../shared/contracts';
import {
  DEFAULT_EVENT_THEME_CONFIG,
  EVENT_THEME_VERSION,
  EventThemeResolutionError,
  overrideLegibilityErrors,
  resolveEventTheme,
  serializeEventThemeConfig,
} from '../../shared/event-theme';
import { api, ClientApiError } from '../app/api';
import { EventAppearancePreview } from './EventAppearancePreview';
import { EventThemePresetSelector } from './EventThemePresetSelector';

interface EventAppearanceEditorProps {
  event: EventView;
  onEventSaved(event: EventView): void;
}

type ThemeField = 'overrides.primaryColor' | 'overrides.accentColor';
type ThemeErrors = Partial<Record<ThemeField, string>>;
type ColorKind = 'primaryColor' | 'accentColor';

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/u;
const SYNTAX_ERROR = 'Enter a six-digit hex color, such as #245c46.';
const COVER_ACCEPT = 'image/jpeg,image/png,image/webp';
const COVER_MAX_BYTES = 10 * 1024 * 1024;

function rawColors(theme: ResolvedEventTheme) {
  return {
    primary: theme.config.overrides.primaryColor ?? theme.tokens.primary,
    accent: theme.config.overrides.accentColor ?? theme.tokens.accent,
  };
}

function fieldFor(kind: ColorKind): ThemeField {
  return `overrides.${kind}`;
}

export function EventAppearanceEditor({ event, onEventSaved }: EventAppearanceEditorProps) {
  const initialRaw = rawColors(event.theme);
  const [savedTheme, setSavedTheme] = useState<EventThemeConfigV1>(() => event.theme.config);
  const [draftTheme, setDraftTheme] = useState<EventThemeConfigV1>(() => event.theme.config);
  const [previewTheme, setPreviewTheme] = useState<ResolvedEventTheme>(() => event.theme);
  const [rawPrimary, setRawPrimary] = useState<string>(initialRaw.primary);
  const [rawAccent, setRawAccent] = useState<string>(initialRaw.accent);
  const [errors, setErrors] = useState<ThemeErrors>({});
  const [busy, setBusy] = useState(false);
  const [coverBusy, setCoverBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [coverError, setCoverError] = useState<string | null>(null);
  const coverInput = useRef<HTMLInputElement>(null);

  const dirty = serializeEventThemeConfig(draftTheme) !== serializeEventThemeConfig(savedTheme);
  const invalid = Boolean(errors['overrides.primaryColor'] || errors['overrides.accentColor']);
  const unsaved = dirty || invalid;

  function adoptDraft(theme: ResolvedEventTheme) {
    setDraftTheme(theme.config);
    setPreviewTheme(theme);
  }

  /* The legibility floors gate Save, not rendering, so which color a refusal names decides what
     happens to the choice that provoked it. A floor refusing the color the host just chose keeps the
     last valid preview, as this editor has always done. A floor refusing the *other* saved color is
     not a verdict on this choice: dropping it there left the field showing one color, the preview
     showing another, Save disabled, and the only error sitting on a field the host never touched.
     So the choice takes effect, and the error stays on the color that has to change before Save is
     possible. Only stored colors can reach that state — both floors run on every write — which is
     exactly the case the floors were written to tolerate rather than retire. */
  function applyResolved(resolved: ResolvedEventTheme, field: ThemeField) {
    const refusals = overrideLegibilityErrors(resolved);
    if (!refusals[field]) adoptDraft(resolved);
    setErrors((current) => {
      const next = { ...current };
      delete next[field];
      for (const [refusedField, message] of Object.entries(refusals)) {
        const target = refusedField as ThemeField;
        if (target === field || !next[target]) next[target] = message;
      }
      return next;
    });
  }

  function choosePreset(presetId: EventThemePresetId) {
    const resolved = resolveEventTheme({ version: EVENT_THEME_VERSION, presetId, overrides: {} });
    const raw = rawColors(resolved);
    adoptDraft(resolved);
    setRawPrimary(raw.primary);
    setRawAccent(raw.accent);
    setErrors({});
    setSaveError(null);
  }

  function changeColor(kind: ColorKind, value: string) {
    const field = fieldFor(kind);
    if (kind === 'primaryColor') setRawPrimary(value);
    else setRawAccent(value);
    setSaveError(null);

    if (!HEX_COLOR.test(value)) {
      setErrors((current) => ({ ...current, [field]: SYNTAX_ERROR }));
      return;
    }

    const candidate: EventThemeConfigV1 = {
      ...draftTheme,
      overrides: {
        ...draftTheme.overrides,
        [kind]: value.toLowerCase() as HexColor,
      },
    };
    let resolved: ResolvedEventTheme;
    try {
      resolved = resolveEventTheme(candidate);
    } catch (caught) {
      if (!(caught instanceof EventThemeResolutionError)) throw caught;
      // Nothing can be drawn from this color at all, so the last valid preview stands.
      setErrors((current) => ({ ...current, [caught.field]: caught.message }));
      return;
    }
    applyResolved(resolved, field);
  }

  function usePresetColor(kind: ColorKind) {
    const overrides = { ...draftTheme.overrides };
    delete overrides[kind];
    const resolved = resolveEventTheme({ ...draftTheme, overrides });
    applyResolved(resolved, fieldFor(kind));
    if (kind === 'primaryColor') setRawPrimary(resolved.tokens.primary);
    else setRawAccent(resolved.tokens.accent);
    setSaveError(null);
  }

  function reset() {
    const resolved = resolveEventTheme(DEFAULT_EVENT_THEME_CONFIG);
    const raw = rawColors(resolved);
    adoptDraft(resolved);
    setRawPrimary(raw.primary);
    setRawAccent(raw.accent);
    setErrors({});
    setSaveError(null);
  }

  async function save() {
    if (!dirty || invalid || busy || coverBusy) return;
    setBusy(true);
    setSaveError(null);
    try {
      const result = await api<{ event: EventView }>(`/api/manage/events/${event.id}/theme`, {
        method: 'PUT',
        body: serializeEventThemeConfig(draftTheme),
      });
      const normalized = result.event.theme;
      const raw = rawColors(normalized);
      setSavedTheme(normalized.config);
      adoptDraft(normalized);
      setRawPrimary(raw.primary);
      setRawAccent(raw.accent);
      setErrors({});
      onEventSaved(result.event);
    } catch (caught) {
      if (caught instanceof ClientApiError) {
        setSaveError(caught.message);
        if (caught.fieldErrors) {
          setErrors((current) => ({
            ...current,
            ...Object.fromEntries(
              Object.entries(caught.fieldErrors ?? {})
                .filter(([field]) => field === 'overrides.primaryColor' || field === 'overrides.accentColor'),
            ),
          }));
        }
      } else {
        setSaveError(caught instanceof Error ? caught.message : 'The event appearance could not be saved.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function uploadCover(file: File) {
    if (busy || coverBusy) return;
    if (file.size > COVER_MAX_BYTES) {
      setCoverError('Cover photos must be 10 MB or smaller.');
      return;
    }
    setCoverBusy(true);
    setCoverError(null);
    try {
      const upload = await api<{ objectKey: string; url: string }>(`/api/manage/events/${event.id}/cover`, {
        method: 'POST',
        body: JSON.stringify({ filename: file.name, mimeType: file.type, byteSize: file.size }),
      });
      const transferred = await fetch(upload.url, {
        method: 'PUT',
        headers: { 'content-type': file.type },
        body: file,
      });
      if (!transferred.ok) throw new Error('Cover transfer failed.');
      const result = await api<{ event: EventView }>(`/api/manage/events/${event.id}/cover/finalize`, {
        method: 'POST',
        body: JSON.stringify({ objectKey: upload.objectKey, mimeType: file.type }),
      });
      onEventSaved(result.event);
    } catch (caught) {
      setCoverError(caught instanceof ClientApiError
        ? caught.message
        : 'The cover photo could not be saved. Try again.');
    } finally {
      setCoverBusy(false);
      if (coverInput.current) coverInput.current.value = '';
    }
  }

  async function removeCover() {
    if (busy || coverBusy || !event.coverObjectKey) return;
    setCoverBusy(true);
    setCoverError(null);
    try {
      const result = await api<{ event: EventView }>(`/api/manage/events/${event.id}/cover`, {
        method: 'DELETE',
      });
      onEventSaved(result.event);
    } catch (caught) {
      setCoverError(caught instanceof ClientApiError
        ? caught.message
        : 'The cover photo could not be removed. Try again.');
    } finally {
      setCoverBusy(false);
    }
  }

  const primaryError = errors['overrides.primaryColor'];
  const accentError = errors['overrides.accentColor'];
  const primaryPickerValue = HEX_COLOR.test(rawPrimary) ? rawPrimary : previewTheme.tokens.primary;
  const accentPickerValue = HEX_COLOR.test(rawAccent) ? rawAccent : previewTheme.tokens.accent;
  const locked = busy || coverBusy;

  return <section className="event-appearance-editor" aria-label="Event appearance editor">
    <div className="event-appearance-editor__heading">
      <div>
        <p className="section-label">Guest experience</p>
        <h3>Event appearance</h3>
        <p>Choose the colors and shape guests see. Color changes stay in this preview until you save. Cover changes apply immediately.</p>
      </div>
      <span className={`event-appearance-editor__status${unsaved ? ' event-appearance-editor__status--dirty' : ''}`}>
        {unsaved ? 'Unsaved changes' : 'Saved'}
      </span>
    </div>

    {saveError && <p className="form-error" role="alert">{saveError}</p>}
    {coverError && <p className="form-error" role="alert">{coverError}</p>}

    <div className="event-appearance-editor__cover">
      <div className="event-appearance-editor__cover-copy">
        <strong>Cover photo</strong>
        <p>{event.coverObjectKey
          ? 'Shown on the guest hero for RSVP and photo delivery.'
          : 'Optional. JPEG, PNG, or WebP · 10 MB max.'}</p>
      </div>
      <div className="event-appearance-editor__cover-actions">
        <label className="cover-field cover-field--compact">
          <ImagePlus aria-hidden="true" />
          <span className="button button--secondary">{coverBusy ? 'Working…' : event.coverObjectKey ? 'Change cover' : 'Add cover'}</span>
          <input
            ref={coverInput}
            className="sr-only cover-field__input"
            type="file"
            accept={COVER_ACCEPT}
            disabled={locked}
            onChange={(changeEvent) => {
              const file = changeEvent.target.files?.[0];
              if (file) void uploadCover(file);
            }}
          />
        </label>
        {event.coverObjectKey && <button
          type="button"
          className="button button--secondary"
          disabled={locked}
          onClick={() => void removeCover()}
        >
          Remove cover
        </button>}
      </div>
    </div>

    <form onSubmit={(formEvent) => {
      formEvent.preventDefault();
      void save();
    }}>
      <div className="event-appearance-editor__controls">
        <EventThemePresetSelector
          name={`event-theme-${event.id}`}
          value={draftTheme.presetId}
          onChange={choosePreset}
          disabled={locked}
        />

        <div className="event-appearance-editor__color-list">
          <div className="event-appearance-editor__color">
            <div className="event-appearance-editor__color-heading">
              <strong>Primary color</strong>
              <button type="button" onClick={() => usePresetColor('primaryColor')} disabled={locked}>
                Use preset primary
              </button>
            </div>
            <div className="event-appearance-editor__color-inputs">
              <label>
                <span className="sr-only">Primary color picker</span>
                <input
                  type="color"
                  value={primaryPickerValue}
                  disabled={locked}
                  aria-invalid={Boolean(primaryError)}
                  aria-describedby={primaryError ? 'event-theme-primary-error' : undefined}
                  onChange={(changeEvent) => changeColor('primaryColor', changeEvent.target.value)}
                />
              </label>
              <label>
                <span>Primary color</span>
                <input
                  type="text"
                  value={rawPrimary}
                  disabled={locked}
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={Boolean(primaryError)}
                  aria-describedby={primaryError ? 'event-theme-primary-error' : undefined}
                  onChange={(changeEvent) => changeColor('primaryColor', changeEvent.target.value)}
                />
              </label>
            </div>
            {primaryError && <small className="field-error" id="event-theme-primary-error">{primaryError}</small>}
          </div>

          <div className="event-appearance-editor__color">
            <div className="event-appearance-editor__color-heading">
              <strong>Accent color</strong>
              <button type="button" onClick={() => usePresetColor('accentColor')} disabled={locked}>
                Use preset accent
              </button>
            </div>
            <div className="event-appearance-editor__color-inputs">
              <label>
                <span className="sr-only">Accent color picker</span>
                <input
                  type="color"
                  value={accentPickerValue}
                  disabled={locked}
                  aria-invalid={Boolean(accentError)}
                  aria-describedby={accentError ? 'event-theme-accent-error' : undefined}
                  onChange={(changeEvent) => changeColor('accentColor', changeEvent.target.value)}
                />
              </label>
              <label>
                <span>Accent color</span>
                <input
                  type="text"
                  value={rawAccent}
                  disabled={locked}
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={Boolean(accentError)}
                  aria-describedby={accentError ? 'event-theme-accent-error' : undefined}
                  onChange={(changeEvent) => changeColor('accentColor', changeEvent.target.value)}
                />
              </label>
            </div>
            {accentError && <small className="field-error" id="event-theme-accent-error">{accentError}</small>}
          </div>
        </div>
      </div>

      <div className="event-appearance-editor__preview">
        <h4>Guest preview</h4>
        <EventAppearancePreview event={event} theme={previewTheme} />
      </div>

      <div className="event-appearance-editor__actions">
        <button
          type="button"
          className="button button--secondary"
          onClick={reset}
          disabled={locked}
        >
          Reset to Candidary default
        </button>
        <button
          type="submit"
          className="button button--primary"
          disabled={!dirty || invalid || locked}
        >
          {busy ? 'Saving…' : 'Save appearance'}
        </button>
      </div>
    </form>
  </section>;
}

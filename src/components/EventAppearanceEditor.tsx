import { useState } from 'react';

import type {
  EventThemeConfigV1,
  EventThemePresetId,
  EventView,
  HexColor,
  ResolvedEventTheme,
} from '../../shared/contracts';
import {
  DEFAULT_EVENT_THEME_CONFIG,
  EventThemeResolutionError,
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
  const [saveError, setSaveError] = useState<string | null>(null);

  const dirty = serializeEventThemeConfig(draftTheme) !== serializeEventThemeConfig(savedTheme);
  const invalid = Boolean(errors['overrides.primaryColor'] || errors['overrides.accentColor']);

  function adoptDraft(theme: ResolvedEventTheme) {
    setDraftTheme(theme.config);
    setPreviewTheme(theme);
  }

  function choosePreset(presetId: EventThemePresetId) {
    const resolved = resolveEventTheme({ version: 1, presetId, overrides: {} });
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
    try {
      adoptDraft(resolveEventTheme(candidate));
      setErrors((current) => {
        const next = { ...current };
        delete next[field];
        return next;
      });
    } catch (caught) {
      if (!(caught instanceof EventThemeResolutionError)) throw caught;
      setErrors((current) => ({ ...current, [caught.field]: caught.message }));
    }
  }

  function usePresetColor(kind: ColorKind) {
    const overrides = { ...draftTheme.overrides };
    delete overrides[kind];
    const resolved = resolveEventTheme({ ...draftTheme, overrides });
    adoptDraft(resolved);
    if (kind === 'primaryColor') setRawPrimary(resolved.tokens.primary);
    else setRawAccent(resolved.tokens.accent);
    setErrors((current) => {
      const next = { ...current };
      delete next[fieldFor(kind)];
      return next;
    });
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
    if (!dirty || invalid || busy) return;
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

  const primaryError = errors['overrides.primaryColor'];
  const accentError = errors['overrides.accentColor'];
  const primaryPickerValue = HEX_COLOR.test(rawPrimary) ? rawPrimary : previewTheme.tokens.primary;
  const accentPickerValue = HEX_COLOR.test(rawAccent) ? rawAccent : previewTheme.tokens.accent;

  return <section className="event-appearance-editor" aria-label="Event appearance editor">
    <div className="event-appearance-editor__heading">
      <div>
        <p className="section-label">Guest experience</p>
        <h3>Event appearance</h3>
        <p>Choose the colors and shape guests see. Changes stay in this preview until you save.</p>
      </div>
      <span className={`event-appearance-editor__status${dirty ? ' event-appearance-editor__status--dirty' : ''}`}>
        {dirty ? 'Unsaved changes' : 'Saved'}
      </span>
    </div>

    {saveError && <p className="form-error" role="alert">{saveError}</p>}

    <form onSubmit={(formEvent) => {
      formEvent.preventDefault();
      void save();
    }}>
      <div className="event-appearance-editor__controls">
        <EventThemePresetSelector
          name={`event-theme-${event.id}`}
          value={draftTheme.presetId}
          onChange={choosePreset}
          disabled={busy}
        />

        <div className="event-appearance-editor__color-list">
          <div className="event-appearance-editor__color">
            <div className="event-appearance-editor__color-heading">
              <strong>Primary color</strong>
              <button type="button" onClick={() => usePresetColor('primaryColor')} disabled={busy}>
                Use preset primary
              </button>
            </div>
            <div className="event-appearance-editor__color-inputs">
              <label>
                <span className="sr-only">Primary color picker</span>
                <input
                  type="color"
                  value={primaryPickerValue}
                  disabled={busy}
                  onChange={(changeEvent) => changeColor('primaryColor', changeEvent.target.value)}
                />
              </label>
              <label>
                <span>Primary color</span>
                <input
                  type="text"
                  value={rawPrimary}
                  disabled={busy}
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
              <button type="button" onClick={() => usePresetColor('accentColor')} disabled={busy}>
                Use preset accent
              </button>
            </div>
            <div className="event-appearance-editor__color-inputs">
              <label>
                <span className="sr-only">Accent color picker</span>
                <input
                  type="color"
                  value={accentPickerValue}
                  disabled={busy}
                  onChange={(changeEvent) => changeColor('accentColor', changeEvent.target.value)}
                />
              </label>
              <label>
                <span>Accent color</span>
                <input
                  type="text"
                  value={rawAccent}
                  disabled={busy}
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
          disabled={busy}
        >
          Reset to Candidary default
        </button>
        <button
          type="submit"
          className="button button--primary"
          disabled={!dirty || invalid || busy}
        >
          {busy ? 'Saving…' : 'Save appearance'}
        </button>
      </div>
    </form>
  </section>;
}

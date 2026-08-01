import { ImagePlus } from 'lucide-react';
import { useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { KeyboardEvent, Ref } from 'react';

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
import {
  createAutosaveQueue,
  type AutosaveFailure,
  type AutosaveHandle,
  type AutosaveOutcome,
  type AutosaveQueue,
  type AutosaveState,
  type DomainAutosaveState,
} from '../features/settings/autosave-queue';
import { AutosaveStatus } from './AutosaveStatus';
import { EventAppearancePreview } from './EventAppearancePreview';
import { EventThemePresetSelector } from './EventThemePresetSelector';
import { describeLoadFailure } from './States';

interface EventAppearanceEditorProps {
  event: EventView;
  // Theme and cover writes are separate domains, so the manager merges their
  // whole-event responses by ownership rather than adopting either wholesale.
  onThemeSaved(event: EventView): void;
  onCoverSaved(event: EventView): void;
  onAutosaveStateChange(state: DomainAutosaveState): void;
  // Brackets a write so an older whole-event read cannot rebase this editor.
  onEventWrite<T>(request: () => Promise<T>): Promise<T>;
  ref?: Ref<AutosaveHandle>;
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
  return ('overrides.' + kind) as ThemeField;
}

export function EventAppearanceEditor({
  event,
  onThemeSaved,
  onCoverSaved,
  onAutosaveStateChange,
  onEventWrite,
  ref,
}: EventAppearanceEditorProps) {
  const initialRaw = rawColors(event.theme);
  const [draftTheme, setDraftTheme] = useState<EventThemeConfigV1>(() => event.theme.config);
  const [previewTheme, setPreviewTheme] = useState<ResolvedEventTheme>(() => event.theme);
  const [rawPrimary, setRawPrimary] = useState<string>(initialRaw.primary);
  const [rawAccent, setRawAccent] = useState<string>(initialRaw.accent);
  const [errors, setErrors] = useState<ThemeErrors>({});
  const [coverBusy, setCoverBusy] = useState(false);
  const [coverError, setCoverError] = useState<string | null>(null);
  const [autosave, setAutosave] = useState<AutosaveState>({ status: 'saved', failure: null });
  const coverInput = useRef<HTMLInputElement>(null);
  const queueRef = useRef<AutosaveQueue<EventThemeConfigV1> | null>(null);
  // The queue settles from a promise continuation, so what is on screen has to
  // be readable without waiting for a render.
  const draftRef = useRef<EventThemeConfigV1>(event.theme.config);
  const errorsRef = useRef<ThemeErrors>({});
  // The raw text in the two hex fields moves for edits the canonical config
  // never sees.
  const rawRef = useRef<{ primary: string; accent: string }>({
    primary: initialRaw.primary,
    accent: initialRaw.accent,
  });
  // The queue is built once, so the saved callback is read through a ref rather
  // than closed over from the first render.
  const themeSavedRef = useRef(onThemeSaved);
  themeSavedRef.current = onThemeSaved;

  function adoptDraft(theme: ResolvedEventTheme) {
    draftRef.current = theme.config;
    setDraftTheme(theme.config);
    setPreviewTheme(theme);
  }

  function recordErrors(next: ThemeErrors) {
    errorsRef.current = next;
    setErrors(next);
  }

  function setRaw(kind: ColorKind, value: string) {
    if (kind === 'primaryColor') {
      rawRef.current = { ...rawRef.current, primary: value };
      setRawPrimary(value);
    } else {
      rawRef.current = { ...rawRef.current, accent: value };
      setRawAccent(value);
    }
  }

  // What the host can see, as one string. It changes for raw text that leaves
  // the canonical config alone, which is exactly the case a response has to
  // notice.
  function themeIntent(): string {
    return JSON.stringify([
      serializeEventThemeConfig(draftRef.current),
      rawRef.current.primary,
      rawRef.current.accent,
    ]);
  }

  /* The legibility floors gate persistence, not rendering, so which color a
     refusal names decides what happens to the choice that provoked it. A floor
     refusing the color the host just chose keeps the last valid preview. A
     floor refusing the other saved color is not a verdict on this choice, so
     the choice still takes effect and the error remains on the color that must
     change before the complete config can save. */
  function applyResolved(resolved: ResolvedEventTheme, field: ThemeField) {
    const refusals = overrideLegibilityErrors(resolved);
    if (!refusals[field]) adoptDraft(resolved);
    const next = { ...errorsRef.current };
    delete next[field];
    for (const [refusedField, message] of Object.entries(refusals)) {
      const target = refusedField as ThemeField;
      if (target === field || !next[target]) next[target] = message;
    }
    recordErrors(next);
  }

  function choosePreset(presetId: EventThemePresetId) {
    const resolved = resolveEventTheme({ version: EVENT_THEME_VERSION, presetId, overrides: {} });
    const raw = rawColors(resolved);
    adoptDraft(resolved);
    setRaw('primaryColor', raw.primary);
    setRaw('accentColor', raw.accent);
    recordErrors({});
    enqueueTheme(true);
  }

  function changeColor(kind: ColorKind, value: string) {
    const field = fieldFor(kind);
    setRaw(kind, value);

    if (!HEX_COLOR.test(value)) {
      recordErrors({ ...errorsRef.current, [field]: SYNTAX_ERROR });
      enqueueTheme(false);
      return;
    }

    const candidate: EventThemeConfigV1 = {
      ...draftRef.current,
      overrides: {
        ...draftRef.current.overrides,
        [kind]: value.toLowerCase() as HexColor,
      },
    };
    let resolved: ResolvedEventTheme;
    try {
      resolved = resolveEventTheme(candidate);
    } catch (caught) {
      if (!(caught instanceof EventThemeResolutionError)) throw caught;
      // Nothing can be drawn from this color at all, so the last valid preview
      // stands and the unsendable state cancels any pending snapshot.
      recordErrors({ ...errorsRef.current, [caught.field]: caught.message });
      enqueueTheme(false);
      return;
    }
    applyResolved(resolved, field);
    enqueueTheme(false);
  }

  function usePresetColor(kind: ColorKind) {
    const overrides = { ...draftRef.current.overrides };
    delete overrides[kind];
    const resolved = resolveEventTheme({ ...draftRef.current, overrides });
    applyResolved(resolved, fieldFor(kind));
    if (kind === 'primaryColor') setRaw('primaryColor', resolved.tokens.primary);
    else setRaw('accentColor', resolved.tokens.accent);
    enqueueTheme(true);
  }

  function reset() {
    const resolved = resolveEventTheme(DEFAULT_EVENT_THEME_CONFIG);
    const raw = rawColors(resolved);
    adoptDraft(resolved);
    setRaw('primaryColor', raw.primary);
    setRaw('accentColor', raw.accent);
    recordErrors({});
    enqueueTheme(true);
  }

  async function sendTheme(
    config: EventThemeConfigV1,
    draft: { key: string; intent: string },
  ): Promise<AutosaveOutcome> {
    const result = await onEventWrite(() => api<{ event: EventView }>(
      '/api/manage/events/' + event.id + '/theme',
      { method: 'PUT', body: serializeEventThemeConfig(config) },
    ));
    const normalized = result.event.theme;
    /* Normalization is adopted only while the host is still looking at the
       draft it answers. Invalid hex text leaves the canonical config untouched,
       so comparing configs would say nothing changed and would wipe the host's
       half-typed color and the error explaining it. Raw intent is what moved,
       so that is what is compared. */
    if (themeIntent() === draft.intent) {
      const raw = rawColors(normalized);
      adoptDraft(normalized);
      setRaw('primaryColor', raw.primary);
      setRaw('accentColor', raw.accent);
      recordErrors({});
    }
    themeSavedRef.current(result.event);
    // The Worker canonical form keeps a normalized answer from leaving the
    // draft looking permanently dirty.
    return { status: 'confirmed', key: serializeEventThemeConfig(normalized.config) };
  }

  function describeThemeFailure(error: unknown): AutosaveFailure {
    if (error instanceof ClientApiError && error.fieldErrors) {
      const refused: ThemeErrors = {};
      for (const field of ['overrides.primaryColor', 'overrides.accentColor'] as const) {
        const message = error.fieldErrors[field];
        if (message) refused[field] = message;
      }
      if (Object.keys(refused).length > 0) {
        recordErrors({ ...errorsRef.current, ...refused });
        return { message: error.message, retryable: false };
      }
    }
    const failure = describeLoadFailure(error, 'manager', 'The event appearance could not be saved.');
    return failure.kind === 'retry'
      ? { message: failure.message, retryable: true }
      : { message: failure.message, retryable: false, escalation: failure };
  }

  if (queueRef.current === null) {
    queueRef.current = createAutosaveQueue<EventThemeConfigV1>({
      baselineKey: serializeEventThemeConfig(event.theme.config),
      save: (snapshot, draft) => sendTheme(snapshot, draft),
      describeFailure: (error) => describeThemeFailure(error),
      onChange: setAutosave,
    });
  }
  const queue = queueRef.current;

  // Contrast and syntax refusals gate persistence, not the preview: the last
  // valid preview stays on screen while the domain reports it cannot save.
  function enqueueTheme(immediate: boolean) {
    const config = draftRef.current;
    const valid = !errorsRef.current['overrides.primaryColor'] && !errorsRef.current['overrides.accentColor'];
    queue.submit({
      key: serializeEventThemeConfig(config),
      intent: themeIntent(),
      snapshot: valid ? config : null,
    }, immediate);
  }

  useEffect(() => () => { queue.dispose(); }, [queue]);
  // A contrast or syntax refusal returned by the Worker is recorded from inside
  // the settle path, which must not re-enter the queue. This tells the queue
  // the domain became unsendable, so it reads as invalid rather than failed.
  const themeBlocked = Boolean(errors['overrides.primaryColor'] || errors['overrides.accentColor']);
  useEffect(() => {
    if (!themeBlocked) return;
    queue.submit({
      key: serializeEventThemeConfig(draftRef.current),
      intent: themeIntent(),
      snapshot: null,
    });
  }, [themeBlocked, queue]);
  const blockingField = errors['overrides.primaryColor']
    ? { label: 'Primary color', message: errors['overrides.primaryColor'] }
    : errors['overrides.accentColor']
      ? { label: 'Accent color', message: errors['overrides.accentColor'] }
      : null;
  useEffect(() => {
    onAutosaveStateChange({
      domain: 'appearance',
      label: 'Event appearance',
      status: autosave.status,
      failure: autosave.failure,
      blockingField,
    });
  }, [autosave, blockingField?.label, blockingField?.message, onAutosaveStateChange]);
  useImperativeHandle(ref, () => ({ flush: () => { queue.flush(); } }), [queue]);

  async function uploadCover(file: File) {
    if (coverBusy) return;
    if (file.size > COVER_MAX_BYTES) {
      setCoverError('Cover photos must be 10 MB or smaller.');
      return;
    }
    setCoverBusy(true);
    setCoverError(null);
    try {
      const result = await onEventWrite(async () => {
        const upload = await api<{ objectKey: string; url: string }>('/api/manage/events/' + event.id + '/cover', {
          method: 'POST',
          body: JSON.stringify({ filename: file.name, mimeType: file.type, byteSize: file.size }),
        });
        const transferred = await fetch(upload.url, {
          method: 'PUT',
          headers: { 'content-type': file.type },
          body: file,
        });
        if (!transferred.ok) throw new Error('Cover transfer failed.');
        return api<{ event: EventView }>('/api/manage/events/' + event.id + '/cover/finalize', {
          method: 'POST',
          body: JSON.stringify({ objectKey: upload.objectKey, mimeType: file.type }),
        });
      });
      onCoverSaved(result.event);
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
    if (coverBusy || !event.coverObjectKey) return;
    setCoverBusy(true);
    setCoverError(null);
    try {
      const result = await onEventWrite(() => api<{ event: EventView }>('/api/manage/events/' + event.id + '/cover', {
        method: 'DELETE',
      }));
      onCoverSaved(result.event);
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
  const coverLocked = coverBusy;

  function flushThemeOnEnter(keyEvent: KeyboardEvent) {
    if (keyEvent.key !== 'Enter') return;
    keyEvent.preventDefault();
    queue.flush();
  }

  return <section className="event-appearance-editor" aria-label="Event appearance editor">
    <div className="event-appearance-editor__heading">
      <div>
        <p className="section-label">Guest experience</p>
        <h3>Event appearance</h3>
        <p>Choose the colors and shape guests see. Changes save as you make them. Cover changes apply immediately.</p>
      </div>
      <AutosaveStatus
        className="event-appearance-editor__status"
        label="Event appearance"
        state={autosave}
        blockingField={blockingField}
        onRetry={() => enqueueTheme(true)}
      />
    </div>

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
            disabled={coverLocked}
            onChange={(changeEvent) => {
              const file = changeEvent.target.files?.[0];
              if (file) void uploadCover(file);
            }}
          />
        </label>
        {event.coverObjectKey && <button
          type="button"
          className="button button--secondary"
          disabled={coverLocked}
          onClick={() => void removeCover()}
        >
          Remove cover
        </button>}
      </div>
    </div>

    <form onSubmit={(formEvent) => {
      formEvent.preventDefault();
      queue.flush();
    }}>
      <div className="event-appearance-editor__controls">
        <EventThemePresetSelector
          name={'event-theme-' + event.id}
          value={draftTheme.presetId}
          onChange={choosePreset}
        />

        <div className="event-appearance-editor__color-list">
          <div className="event-appearance-editor__color">
            <div className="event-appearance-editor__color-heading">
              <strong>Primary color</strong>
              <button type="button" onClick={() => usePresetColor('primaryColor')}>
                Use preset primary
              </button>
            </div>
            <div className="event-appearance-editor__color-inputs">
              <label>
                <span className="sr-only">Primary color picker</span>
                <input
                  type="color"
                  value={primaryPickerValue}
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
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={Boolean(primaryError)}
                  aria-describedby={primaryError ? 'event-theme-primary-error' : undefined}
                  onChange={(changeEvent) => changeColor('primaryColor', changeEvent.target.value)}
                  onBlur={() => queue.flush()}
                  onKeyDown={flushThemeOnEnter}
                />
              </label>
            </div>
            {primaryError && <small className="field-error" id="event-theme-primary-error">{primaryError}</small>}
          </div>

          <div className="event-appearance-editor__color">
            <div className="event-appearance-editor__color-heading">
              <strong>Accent color</strong>
              <button type="button" onClick={() => usePresetColor('accentColor')}>
                Use preset accent
              </button>
            </div>
            <div className="event-appearance-editor__color-inputs">
              <label>
                <span className="sr-only">Accent color picker</span>
                <input
                  type="color"
                  value={accentPickerValue}
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
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={Boolean(accentError)}
                  aria-describedby={accentError ? 'event-theme-accent-error' : undefined}
                  onChange={(changeEvent) => changeColor('accentColor', changeEvent.target.value)}
                  onBlur={() => queue.flush()}
                  onKeyDown={flushThemeOnEnter}
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
        <button type="button" className="button button--secondary" onClick={reset}>
          Reset to Candidary default
        </button>
      </div>
    </form>
  </section>;
}

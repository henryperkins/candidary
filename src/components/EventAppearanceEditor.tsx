import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, Ref } from 'react';

import type {
  EventThemeConfigV1,
  EventThemePresetId,
  EventView,
  HexColor,
  ResolvedEventTheme,
} from '../../shared/contracts';
import {
  CURRENT_EVENT_COVER_PRESET_ASSET_VERSION,
  type EventCoverEffectId,
  type EventCoverPresetId,
  type EventCoverProfileId,
} from '../../shared/event-cover';
import {
  DEFAULT_EVENT_THEME_CONFIG,
  EVENT_THEME_VERSION,
  EventThemeResolutionError,
  overrideLegibilityErrors,
  resolveEventTheme,
  serializeEventThemeConfig,
} from '../../shared/event-theme';
import { presetCoverAssetPath } from '../../shared/event-cover-assets';
import { api, ClientApiError, managerEventCoverSlotPath } from '../app/api';
import { emitCoverUnavailable } from '../app/cover-observability';
import type { CoverCompositionRunner } from '../features/cover/cover-draft-client';
import { useCoverOperationReconciler } from '../features/cover/use-cover-operation-reconciler';
import { useCoverStudioSession } from '../features/cover/use-cover-studio-session';
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
import {
  EventAppearanceCanvas,
  type EventAppearanceCanvasPreview,
} from './EventAppearanceCanvas';
import { ManagerCoverPreparationStatus } from './ManagerCoverPreparationStatus';
import { EventThemePresetSelector } from './EventThemePresetSelector';
import { CoverStudio } from '../features/cover/CoverStudio';
import type { CoverStyleThumbnailState } from '../features/cover/CoverStylePicker';
import { describeLoadFailure } from './States';
import type { LoadFailure } from './States';

interface EventAppearanceEditorProps {
  event: EventView;
  // Theme and cover writes are separate domains, so the manager merges their
  // whole-event responses by ownership rather than adopting either wholesale.
  onThemeSaved(event: EventView): void;
  onCoverSaved(event: EventView): void;
  onAutosaveStateChange(state: DomainAutosaveState): void;
  // Brackets a write so an older whole-event read cannot rebase this editor.
  onEventWrite<T>(request: () => Promise<T>): Promise<T>;
  // A fresh whole-event read, so an outcome the host was not waiting on still
  // reaches the canvas. `EventSettingsEditor` already receives the same one.
  onEventRead<T>(request: () => Promise<T>): Promise<T>;
  onCoverAccessFailure(failure: LoadFailure | null): void;
  // Injected in tests for the same reason `GuestUploadFlow` takes a transport:
  // the real one decodes an image in a Web Worker, and jsdom has neither.
  compositionRunner?: CoverCompositionRunner;
  ref?: Ref<AutosaveHandle>;
}

type ThemeField = 'overrides.primaryColor' | 'overrides.accentColor';
type ThemeErrors = Partial<Record<ThemeField, string>>;
type ColorKind = 'primaryColor' | 'accentColor';

interface AppearanceQueueOwner {
  generation: number;
  queue: AutosaveQueue<EventThemeConfigV1>;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/u;
const SYNTAX_ERROR = 'Enter a six-digit hex color, such as #245c46.';

function presetStyleThumbnail(
  presetId: EventCoverPresetId,
  effect: EventCoverEffectId,
): CoverStyleThumbnailState {
  return {
    status: 'ready',
    url: presetCoverAssetPath(
      CURRENT_EVENT_COVER_PRESET_ASSET_VERSION,
      presetId,
      effect,
      'standard-default',
      '1x',
      'webp',
    ),
    error: null,
  };
}
// The recovery view travels in the response envelope rather than an error body,
// so these two are the client's own prose over a payload it can actually read.
const COVER_MOVED_ON = 'This cover changed somewhere else, so that change was not applied. The page is up to date now — try again.';
const COVER_PREPARE_UNAVAILABLE = 'That cover could not be started just now. Your current cover is still live — try again in a moment.';

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
  onEventRead,
  onCoverAccessFailure,
  compositionRunner,
  ref,
}: EventAppearanceEditorProps) {
  const initialRaw = rawColors(event.theme);
  const [draftTheme, setDraftTheme] = useState<EventThemeConfigV1>(() => event.theme.config);
  const [previewTheme, setPreviewTheme] = useState<ResolvedEventTheme>(() => event.theme);
  const [rawPrimary, setRawPrimary] = useState<string>(initialRaw.primary);
  const [rawAccent, setRawAccent] = useState<string>(initialRaw.accent);
  const [errors, setErrors] = useState<ThemeErrors>({});
  const [coverError, setCoverError] = useState<string | null>(null);
  const [autosave, setAutosave] = useState<AutosaveState>({ status: 'saved', failure: null });
  const queueRef = useRef<AppearanceQueueOwner | null>(null);
  const queueGenerationRef = useRef(0);
  const saveGenerationRef = useRef(0);
  const queuePausedRef = useRef(false);
  const sendThemeRef = useRef<((
    config: EventThemeConfigV1,
    draft: { key: string; intent: string },
    queueGeneration: number,
    saveGeneration: number,
  ) => Promise<AutosaveOutcome>) | null>(null);
  const describeThemeFailureRef = useRef<((error: unknown) => AutosaveFailure) | null>(null);
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
  const coverAccessFailureRef = useRef(onCoverAccessFailure);
  coverAccessFailureRef.current = onCoverAccessFailure;
  const pendingUnavailableRef = useRef<string | null>(null);
  const refreshedUnavailableRef = useRef<string | null>(null);

  async function readFreshEvent(): Promise<EventView> {
    const loaded = await onEventRead(() => api<{ event: EventView }>(
      '/api/manage/events/' + event.id,
    ));
    return loaded.event;
  }

  // Mounted at Manager scope: this remains attached when the Studio sheet is
  // closed, and is the only owner that polls a publication receipt.
  const coverReconciler = useCoverOperationReconciler({
    eventId: event.id,
    preparation: event.cover.preparation,
    onCoverEvent: onCoverSaved,
    onFreshEventRequired: readFreshEvent,
  });
  const coverSession = useCoverStudioSession({
    event,
    reconciler: coverReconciler,
    compositionRunner,
  });

  useEffect(() => {
    const access = coverReconciler.accessFailure;
    coverAccessFailureRef.current(access
      ? describeLoadFailure(access.error, 'manager', 'Manager access must be restored before cover work can continue.')
      : null);
  }, [coverReconciler.accessFailure]);

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

  function ownsSaveGeneration(queueGeneration: number, saveGeneration: number): boolean {
    return queueRef.current?.generation === queueGeneration
      && saveGenerationRef.current === saveGeneration
      && !queuePausedRef.current;
  }

  function currentQueue(): AutosaveQueue<EventThemeConfigV1> | null {
    return queueRef.current?.queue ?? null;
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
    queueGeneration: number,
    saveGeneration: number,
  ): Promise<AutosaveOutcome> {
    const result = await onEventWrite(() => api<{ event: EventView }>(
      '/api/manage/events/' + event.id + '/theme',
      { method: 'PUT', body: serializeEventThemeConfig(config) },
    ));
    const normalized = result.event.theme;
    const confirmedKey = serializeEventThemeConfig(normalized.config);
    if (!ownsSaveGeneration(queueGeneration, saveGeneration)) {
      return { status: 'confirmed', key: confirmedKey };
    }
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
    return { status: 'confirmed', key: confirmedKey };
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

  // Publish only committed callbacks. Writing these refs during render would
  // let an abandoned concurrent render replace the live queue's event owner.
  useLayoutEffect(() => {
    themeSavedRef.current = onThemeSaved;
    sendThemeRef.current = sendTheme;
    describeThemeFailureRef.current = describeThemeFailure;
  });

  useLayoutEffect(() => {
    const generation = queueGenerationRef.current + 1;
    queueGenerationRef.current = generation;
    const queue = createAutosaveQueue<EventThemeConfigV1>({
      baselineKey: serializeEventThemeConfig(event.theme.config),
      save: (snapshot, draft) => {
        const send = sendThemeRef.current;
        if (!send) return Promise.reject(new Error('The appearance save owner is unavailable.'));
        return send(snapshot, draft, generation, saveGenerationRef.current);
      },
      describeFailure: (error) => describeThemeFailureRef.current?.(error) ?? {
        message: 'The event appearance could not be saved.',
        retryable: true,
      },
      onChange: (next) => {
        if (queueRef.current?.generation === generation) setAutosave(next);
      },
    });
    const owner: AppearanceQueueOwner = { generation, queue };
    queueRef.current = owner;
    return () => {
      if (queueRef.current === owner) queueRef.current = null;
      queue.dispose();
    };
  }, [event.id]);

  // Contrast and syntax refusals gate persistence, not the preview: the last
  // valid preview stays on screen while the domain reports it cannot save.
  function enqueueTheme(immediate: boolean) {
    const config = draftRef.current;
    const valid = !errorsRef.current['overrides.primaryColor'] && !errorsRef.current['overrides.accentColor'];
    currentQueue()?.submit({
      key: serializeEventThemeConfig(config),
      intent: themeIntent(),
      snapshot: valid ? config : null,
    }, immediate);
  }

  // A contrast or syntax refusal returned by the Worker is recorded from inside
  // the settle path, which must not re-enter the queue. This tells the queue
  // the domain became unsendable, so it reads as invalid rather than failed.
  const themeBlocked = Boolean(errors['overrides.primaryColor'] || errors['overrides.accentColor']);
  useEffect(() => {
    if (!themeBlocked) return;
    queueRef.current?.queue.submit({
      key: serializeEventThemeConfig(draftRef.current),
      intent: themeIntent(),
      snapshot: null,
    });
  }, [themeBlocked]);
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
  useImperativeHandle(ref, () => ({
    flush: () => { queueRef.current?.queue.flush(); },
    pause: () => {
      if (queuePausedRef.current) return;
      queuePausedRef.current = true;
      saveGenerationRef.current += 1;
      queueRef.current?.queue.pause();
    },
    resume: () => {
      if (!queuePausedRef.current) return;
      queuePausedRef.current = false;
      queueRef.current?.queue.resume();
    },
  }), []);

  async function publishCover() {
    setCoverError(null);
    try {
      const result = await onEventWrite(() => coverSession.publish());
      if (result.status === 409) setCoverError(COVER_MOVED_ON);
      if (result.status === 503) setCoverError(COVER_PREPARE_UNAVAILABLE);
    } catch (caught) {
      setCoverError(caught instanceof ClientApiError
        ? caught.message
        : 'The cover could not be saved. Your current cover is still live.');
    }
  }

  const primaryError = errors['overrides.primaryColor'];
  const accentError = errors['overrides.accentColor'];
  const primaryPickerValue = HEX_COLOR.test(rawPrimary) ? rawPrimary : previewTheme.tokens.primary;
  const accentPickerValue = HEX_COLOR.test(rawAccent) ? rawAccent : previewTheme.tokens.accent;
  const coverLocked = coverReconciler.operationState.phase === 'dispatching'
    || coverReconciler.operationState.phase === 'preparing'
    || coverReconciler.operationState.phase === 'retryable-failed';

  const canvasPreview: EventAppearanceCanvasPreview = coverSession.open
    ? coverSession.canvasPreview.kind === 'draft' && coverSession.selection.focus
      ? {
          kind: 'draft',
          url: coverSession.canvasPreview.url,
          focus: coverSession.selection.focus,
          effect: coverSession.selection.effect,
        }
      : coverSession.canvasPreview.kind === 'preset'
        ? {
            ...coverSession.canvasPreview,
            assetVersion: CURRENT_EVENT_COVER_PRESET_ASSET_VERSION,
          }
        : coverSession.selection.source?.kind === 'none'
          ? { kind: 'none' }
          : { kind: 'authoritative' }
    : { kind: 'authoritative' };

  async function refreshCoverEvent() {
    const key = pendingUnavailableRef.current;
    if (!key || refreshedUnavailableRef.current === key) return;
    refreshedUnavailableRef.current = key;
    try {
      const fresh = await readFreshEvent();
      onCoverSaved(fresh);
      coverAccessFailureRef.current(null);
    } catch (caught) {
      coverAccessFailureRef.current(describeLoadFailure(
        caught,
        'manager',
        'The current cover could not be refreshed.',
      ));
    }
  }

  function recordCoverUnavailable(detail: { profile: EventCoverProfileId; revision: number }) {
    pendingUnavailableRef.current = `${detail.revision}:${detail.profile}`;
    emitCoverUnavailable({ audience: 'manager', ...detail });
  }

  const canvas = (summary?: boolean) => <EventAppearanceCanvas
    event={event}
    theme={previewTheme}
    preview={canvasPreview}
    sourceFor={(slot) => managerEventCoverSlotPath(event.id, slot)}
    onCoverUnavailable={recordCoverUnavailable}
    onRefreshCoverEvent={() => { void refreshCoverEvent(); }}
    summary={summary ? <div className="event-appearance-editor__cover">
      <div className="event-appearance-editor__cover-copy">
        <strong>Cover</strong>
        <p>{event.cover.hasCover
          ? 'Shown on the guest hero for RSVP and photo delivery.'
          : 'No cover is currently shown. The event theme gradient remains live.'}</p>
        <ManagerCoverPreparationStatus reconciler={coverReconciler} />
        {coverError && <p className="form-error" role="alert">{coverError}</p>}
      </div>
      <button
        type="button"
        className="button button--secondary"
        disabled={coverLocked}
        onClick={coverSession.openStudio}
      >
        Change cover
      </button>
    </div> : undefined}
  />;

  function flushThemeOnEnter(keyEvent: KeyboardEvent) {
    if (keyEvent.key !== 'Enter') return;
    keyEvent.preventDefault();
    currentQueue()?.flush();
  }

  return <section className="event-appearance-editor" aria-label="Event appearance editor">
    <div className="event-appearance-editor__heading">
      <div>
        <p className="section-label">Guest experience</p>
        <h3>Event appearance</h3>
        <p>Choose the colors and shape guests see. Theme and color changes save as you make them. Cover changes begin after you choose Done, and the current cover stays live until the new one is ready.</p>
      </div>
      <AutosaveStatus
        className="event-appearance-editor__status"
        label="Event appearance"
        state={autosave}
        blockingField={blockingField}
        onRetry={() => enqueueTheme(true)}
      />
    </div>

    {canvas(true)}

    <form onSubmit={(formEvent) => {
      formEvent.preventDefault();
      currentQueue()?.flush();
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
                  onBlur={() => currentQueue()?.flush()}
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
                  onBlur={() => currentQueue()?.flush()}
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
                  onBlur={() => currentQueue()?.flush()}
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
                  onBlur={() => currentQueue()?.flush()}
                  onKeyDown={flushThemeOnEnter}
                />
              </label>
            </div>
            {accentError && <small className="field-error" id="event-theme-accent-error">{accentError}</small>}
          </div>
        </div>
      </div>

      <div className="event-appearance-editor__actions">
        <button type="button" className="button button--secondary" onClick={reset}>
          Reset to Candidary default
        </button>
      </div>
    </form>
    <CoverStudio
      open={coverSession.open}
      canvas={canvas(false)}
      operation={coverReconciler.controller}
      operationState={coverReconciler.operationState}
      draft={coverSession.draft}
      composeState={coverSession.draftState}
      source={coverSession.selection.source}
      focus={coverSession.selection.focus}
      focusMode={coverSession.selection.focusMode}
      effect={coverSession.selection.effect}
      uploadReadyForCompose={
        coverSession.draftState.status !== 'idle'
        || event.cover.config.source.kind === 'upload'
      }
      accessFailure={coverSession.accessFailure}
      error={coverError}
      canRemove={event.cover.hasCover}
      presetThumbnail={(presetId) => presetCoverAssetPath(
        CURRENT_EVENT_COVER_PRESET_ASSET_VERSION,
        presetId,
        'natural',
        'standard-default',
        '1x',
        'webp',
      )}
      styleThumbnail={(effect) => (
        coverSession.selection.source?.kind === 'preset'
          ? presetStyleThumbnail(coverSession.selection.source.presetId, effect)
          : coverSession.styleThumbnails[effect]
      )}
      onStyleStepVisible={coverSession.prefetchStylePreviews}
      onSourceChange={(source) => {
        setCoverError(null);
        coverSession.chooseSource(source);
      }}
      onUpload={(file) => {
        setCoverError(null);
        void coverSession.chooseFile(file).catch((caught: unknown) => {
          setCoverError(caught instanceof Error
            ? caught.message
            : 'That photo could not be prepared. Choose another photo.');
        });
      }}
      onEnterCompose={() => {
        setCoverError(null);
        void coverSession.enterCompose().catch((caught: unknown) => {
          setCoverError(caught instanceof Error
            ? caught.message
            : 'That photo could not be prepared. Choose another photo.');
        });
      }}
      onFocusChange={coverSession.setFocus}
      onResetFocus={coverSession.resetFocus}
      onEffectChange={(effect) => { void coverSession.setEffect(effect).catch(() => undefined); }}
      onEffectRetry={(effect) => { void coverSession.retryEffectPreview(effect).catch(() => undefined); }}
      onPublish={() => { void publishCover(); }}
      onDiscardDraft={async () => {
        await coverSession.discard();
        setCoverError(null);
      }}
      onClose={coverSession.close}
    />
  </section>;
}

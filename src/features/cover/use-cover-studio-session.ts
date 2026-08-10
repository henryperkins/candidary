import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  EventCoverEffectId,
  EventCoverProfileId,
  EventCoverPresetId,
} from '../../../shared/event-cover';
import { EVENT_COVER_EFFECTS, qualifiedCover2xProfiles } from '../../../shared/event-cover';
import type { EventView } from '../../../shared/contracts';
import { ClientApiError } from '../../app/api';
import type { CoverFocusValue } from './CoverComposer';
import type { CoverSourceChoice } from './CoverSourcePicker';
import type { CoverStyleThumbnailState } from './CoverStylePicker';
import {
  createCoverDraft,
  discardCoverDraft,
  ensureCoverOperation,
  forgetCoverDraftIntent,
  inspectCoverDraft,
  publishCoverIntent,
  readCoverEffectPreview,
  resolveCompositionFromPreview,
  transferCoverDraft,
  validateCoverFile,
  writeCoverComposition,
  type CoverCompositionRunner,
  type CoverDraftView,
  type CoverOperationAnswer,
  type CoverPublishIntent,
} from './cover-draft-client';
import type { CoverOperationReconciler } from './use-cover-operation-reconciler';

export type CoverSessionSource = CoverSourceChoice | { kind: 'none' } | null;

export interface CoverStudioSelection {
  source: CoverSessionSource;
  focus: CoverFocusValue | null;
  focusMode: 'auto' | 'manual';
  effect: EventCoverEffectId;
}

export interface CoverSessionDraft {
  id: string;
  view: CoverDraftView;
  previewUrl: string;
  initialFocus: CoverFocusValue;
  automaticFocus: CoverFocusValue;
  master: {
    width: number;
    height: number;
    safeZoomMaximum: number;
  };
  available2xProfiles: readonly EventCoverProfileId[];
}

export type CoverDraftSessionState =
  | { status: 'idle'; error: null }
  | { status: 'loading'; error: null }
  | { status: 'ready'; error: null }
  | { status: 'error'; error: unknown };

export type CoverStyleThumbnail = CoverStyleThumbnailState;

export type CoverCanvasPreview =
  | { kind: 'authoritative' }
  | { kind: 'draft'; url: string }
  | { kind: 'preset'; presetId: EventCoverPresetId; effect: EventCoverEffectId };

export interface UseCoverStudioSessionOptions {
  event: EventView;
  reconciler: CoverOperationReconciler;
  compositionRunner?: CoverCompositionRunner;
}

export interface CoverStudioSession {
  open: boolean;
  selection: CoverStudioSelection;
  draft: CoverSessionDraft | null;
  draftState: CoverDraftSessionState;
  operation: CoverOperationReconciler['operation'];
  operationState: CoverOperationReconciler['operationState'];
  canvasPreview: CoverCanvasPreview;
  styleThumbnails: Record<EventCoverEffectId, CoverStyleThumbnail>;
  accessFailure: CoverOperationReconciler['accessFailure'];
  openStudio(): void;
  chooseSource(source: CoverSessionSource): void;
  chooseFile(file: File): Promise<void>;
  enterCompose(): Promise<void>;
  setFocus(focus: CoverFocusValue): void;
  resetFocus(): void;
  setEffect(effect: EventCoverEffectId): Promise<void>;
  publish(): Promise<CoverOperationAnswer>;
  discard(): Promise<void>;
  close(): void;
}

function idleThumbnails(): Record<EventCoverEffectId, CoverStyleThumbnail> {
  return Object.fromEntries(EVENT_COVER_EFFECTS.map((effect) => [
    effect,
    { status: 'idle', url: null, error: null },
  ])) as Record<EventCoverEffectId, CoverStyleThumbnail>;
}

function selectionFor(event: EventView): CoverStudioSelection {
  const config = event.cover.config;
  if (config.source.kind === 'none') {
    return { source: null, focus: null, focusMode: 'auto', effect: 'natural' };
  }
  if (config.source.kind === 'preset') {
    const presetConfig = config as Extract<typeof config, { source: { kind: 'preset' } }>;
    return {
      source: { kind: 'preset', presetId: presetConfig.source.presetId },
      focus: null,
      focusMode: 'auto',
      effect: presetConfig.effect,
    };
  }
  const uploadConfig = config as Extract<typeof config, { source: { kind: 'upload' } }>;
  return {
    source: { kind: 'upload' },
    focus: uploadConfig.focus.mode === 'manual'
      ? { x: uploadConfig.focus.x, y: uploadConfig.focus.y, zoom: uploadConfig.focus.zoom }
      : null,
    focusMode: uploadConfig.focus.mode,
    effect: uploadConfig.effect,
  };
}

function fileIntentKey(file: File): string {
  return `${file.name}.${file.size}.${file.lastModified}`;
}

const ACCESS_CODES = new Set([
  'SESSION_REQUIRED',
  'SESSION_EXPIRED',
  'HOST_SESSION_REQUIRED',
  'ACCOUNT_DISABLED',
  'ROLE_FORBIDDEN',
  'RESOURCE_FORBIDDEN',
  'CSRF_INVALID',
  'ORIGIN_FORBIDDEN',
]);

function isAccessError(error: unknown): boolean {
  return error instanceof ClientApiError && ACCESS_CODES.has(error.code);
}

function createPreviewUrl(bytes: ArrayBuffer): string {
  return URL.createObjectURL(new Blob([bytes], { type: 'image/webp' }));
}

/** Draft, preview, and publication ownership for one mounted Studio. */
export function useCoverStudioSession({
  event,
  reconciler,
  compositionRunner,
}: UseCoverStudioSessionOptions): CoverStudioSession {
  const [open, setOpen] = useState(false);
  const [selection, setSelectionState] = useState<CoverStudioSelection>(() => selectionFor(event));
  const [draft, setDraftStateValue] = useState<CoverSessionDraft | null>(null);
  const [draftState, setDraftState] = useState<CoverDraftSessionState>({ status: 'idle', error: null });
  const [styleThumbnails, setStyleThumbnails] = useState(idleThumbnails);
  const selectionRef = useRef(selection);
  const draftRef = useRef(draft);
  const generationRef = useRef(0);
  const draftPromiseRef = useRef<{ key: string; promise: Promise<void> } | null>(null);
  const draftIntentKeyRef = useRef<string | null>(null);
  const previewBytesRef = useRef(new Map<EventCoverEffectId, ArrayBuffer>());
  const previewAttemptedRef = useRef(new Set<EventCoverEffectId>());
  const previewUrlsRef = useRef(new Map<EventCoverEffectId, string>());
  const previewPromisesRef = useRef(new Map<EventCoverEffectId, Promise<void>>());
  const previewControllersRef = useRef(new Map<EventCoverEffectId, AbortController>());
  const mountedRef = useRef(true);

  function updateSelection(next: CoverStudioSelection) {
    selectionRef.current = next;
    setSelectionState(next);
  }

  function updateDraft(next: CoverSessionDraft | null) {
    draftRef.current = next;
    setDraftStateValue(next);
  }

  const revokeUrls = useCallback((preserveBytes: boolean) => {
    for (const controller of previewControllersRef.current.values()) controller.abort();
    previewControllersRef.current.clear();
    previewPromisesRef.current.clear();
    for (const url of new Set(previewUrlsRef.current.values())) URL.revokeObjectURL(url);
    previewUrlsRef.current.clear();
    if (!preserveBytes) {
      previewBytesRef.current.clear();
      previewAttemptedRef.current.clear();
    }
    if (mountedRef.current) {
      setStyleThumbnails(idleThumbnails());
      const held = draftRef.current;
      if (held) updateDraft({ ...held, previewUrl: '' });
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      revokeUrls(false);
    };
  }, [revokeUrls]);

  useEffect(() => {
    if (open || draftRef.current) return;
    updateSelection(selectionFor(event));
  }, [event.cover.revision, event.id, open]);

  const setThumbnail = useCallback((
    effect: EventCoverEffectId,
    next: CoverStyleThumbnail,
  ) => {
    if (!mountedRef.current) return;
    setStyleThumbnails((held) => ({ ...held, [effect]: next }));
  }, []);

  const ensureEffectPreview = useCallback((effect: EventCoverEffectId): Promise<void> => {
    const heldDraft = draftRef.current;
    if (!heldDraft) return Promise.resolve();
    const existing = previewPromisesRef.current.get(effect);
    if (existing) return existing;

    const cachedBytes = previewBytesRef.current.get(effect);
    if (cachedBytes) {
      const previous = previewUrlsRef.current.get(effect);
      if (previous) {
        setThumbnail(effect, { status: 'ready', url: previous, error: null });
        return Promise.resolve();
      }
      const url = createPreviewUrl(cachedBytes);
      previewUrlsRef.current.set(effect, url);
      setThumbnail(effect, { status: 'ready', url, error: null });
      if (effect === 'natural') updateDraft({ ...heldDraft, previewUrl: url });
      return Promise.resolve();
    }
    if (previewAttemptedRef.current.has(effect)) return Promise.resolve();
    previewAttemptedRef.current.add(effect);
    setThumbnail(effect, { status: 'loading', url: null, error: null });
    const controller = new AbortController();
    previewControllersRef.current.set(effect, controller);
    const draftId = heldDraft.view.id;
    const request = (async () => {
      try {
        const bytes = await readCoverEffectPreview(event.id, draftId, effect, controller.signal);
        if (draftRef.current?.view.id !== draftId || controller.signal.aborted) return;
        previewBytesRef.current.set(effect, bytes);
        const url = createPreviewUrl(bytes);
        previewUrlsRef.current.set(effect, url);
        setThumbnail(effect, { status: 'ready', url, error: null });
        if (effect === 'natural') updateDraft({ ...draftRef.current, previewUrl: url });
      } catch (error) {
        if (controller.signal.aborted) return;
        setThumbnail(effect, { status: 'error', url: null, error });
      } finally {
        previewControllersRef.current.delete(effect);
        previewPromisesRef.current.delete(effect);
      }
    })();
    previewPromisesRef.current.set(effect, request);
    return request;
  }, [event.id, setThumbnail]);

  const installReadyDraft = useCallback((view: CoverDraftView, naturalBytes: ArrayBuffer) => {
    if (!view.master) throw new Error('The ready cover draft is missing master geometry.');
    const automaticFocus: CoverFocusValue = {
      x: view.focus?.x ?? 0.5,
      y: view.focus?.y ?? 0.5,
      zoom: 1,
    };
    const initialFocus = selectionRef.current.focus ?? automaticFocus;
    const url = createPreviewUrl(naturalBytes);
    previewBytesRef.current.set('natural', naturalBytes);
    previewAttemptedRef.current.add('natural');
    previewUrlsRef.current.set('natural', url);
    setThumbnail('natural', { status: 'ready', url, error: null });
    updateDraft({
      id: view.id,
      view,
      previewUrl: url,
      initialFocus,
      automaticFocus,
      master: {
        width: view.master.width,
        height: view.master.height,
        safeZoomMaximum: view.master.safeZoomMaximum,
      },
      available2xProfiles: qualifiedCover2xProfiles(view.master, initialFocus),
    });
    if (selectionRef.current.focus === null) {
      updateSelection({ ...selectionRef.current, focus: initialFocus });
    }
    setDraftState({ status: 'ready', error: null });
  }, [setThumbnail]);

  const runDraft = useCallback((
    key: string,
    source: { kind: 'existing-upload' } | { kind: 'new-upload'; file: File },
  ): Promise<void> => {
    if (draftPromiseRef.current?.key === key) return draftPromiseRef.current.promise;
    const generation = ++generationRef.current;
    revokeUrls(false);
    updateDraft(null);
    setDraftState({ status: 'loading', error: null });
    draftIntentKeyRef.current = key;

    const request = (async () => {
      try {
        const reservation = await createCoverDraft(source.kind === 'new-upload'
          ? { eventId: event.id, intentKey: key, source: { kind: 'new-upload', file: source.file } }
          : {
              eventId: event.id,
              intentKey: key,
              source: { kind: 'existing-upload', expectedCoverRevision: event.cover.revision },
            });
        let view = reservation.draft;
        if (source.kind === 'new-upload' && view.state === 'reserved') {
          view = await transferCoverDraft({ eventId: event.id, draft: view, file: source.file });
        }
        if (view.state === 'transferred') view = await inspectCoverDraft(event.id, view);
        if (view.state !== 'inspected' && view.state !== 'ready') {
          throw new Error('The cover draft did not become available for composition.');
        }

        const naturalController = new AbortController();
        previewControllersRef.current.set('natural', naturalController);
        previewAttemptedRef.current.add('natural');
        const naturalBytes = await readCoverEffectPreview(
          event.id,
          view.id,
          'natural',
          naturalController.signal,
        );
        previewControllersRef.current.delete('natural');
        if (view.state === 'inspected') {
          const focus = await resolveCompositionFromPreview(naturalBytes, compositionRunner);
          view = await writeCoverComposition({ eventId: event.id, draft: view, focus });
          updateSelection({ ...selectionRef.current, focusMode: 'auto' });
        }
        if (view.state !== 'ready') throw new Error('The cover draft did not become ready.');
        if (generation !== generationRef.current) return;
        installReadyDraft(view, naturalBytes);
      } catch (error) {
        if (generation !== generationRef.current) return;
        setDraftState({ status: 'error', error });
        if (isAccessError(error)) reconciler.rejectBeforeDispatch(error);
        if (error instanceof ClientApiError && error.code === 'COVER_DRAFT_STATE_CONFLICT') {
          await reconciler.recoverAccess().catch(() => undefined);
        }
        throw error;
      } finally {
        if (draftPromiseRef.current?.key === key) draftPromiseRef.current = null;
      }
    })();
    draftPromiseRef.current = { key, promise: request };
    return request;
  }, [compositionRunner, event.cover.revision, event.id, installReadyDraft, reconciler, revokeUrls]);

  const openStudio = useCallback(() => {
    const terminal = reconciler.controller.getState().phase;
    if (terminal === 'applied' || terminal === 'permanent-failed') {
      generationRef.current += 1;
      revokeUrls(false);
      updateDraft(null);
      setDraftState({ status: 'idle', error: null });
      if (draftIntentKeyRef.current) {
        forgetCoverDraftIntent(event.id, draftIntentKeyRef.current);
        draftIntentKeyRef.current = null;
      }
      updateSelection(selectionFor(event));
    }
    reconciler.controller.releaseTerminal();
    setOpen(true);
    if (draftRef.current && !draftRef.current.previewUrl) void ensureEffectPreview('natural');
  }, [ensureEffectPreview, event, reconciler.controller, revokeUrls]);

  const chooseSource = useCallback((source: CoverSessionSource) => {
    const keepUploadFocus = source?.kind === 'upload'
      && selectionRef.current.source?.kind === 'upload';
    updateSelection({
      ...selectionRef.current,
      source,
      focus: keepUploadFocus ? selectionRef.current.focus : null,
      focusMode: keepUploadFocus ? selectionRef.current.focusMode : 'auto',
    });
  }, []);

  const chooseFile = useCallback(async (file: File) => {
    validateCoverFile(file);
    updateSelection({
      source: { kind: 'upload' },
      focus: null,
      focusMode: 'auto',
      effect: selectionRef.current.effect,
    });
    await runDraft(fileIntentKey(file), { kind: 'new-upload', file });
  }, [runDraft]);

  const enterCompose = useCallback(async () => {
    if (draftRef.current?.view.state === 'ready') return;
    if (event.cover.config.source.kind !== 'upload') return;
    await runDraft(`existing-upload.${event.cover.revision}`, { kind: 'existing-upload' });
  }, [event.cover.config.source.kind, event.cover.revision, runDraft]);

  const setFocus = useCallback((focus: CoverFocusValue) => {
    updateSelection({ ...selectionRef.current, focus, focusMode: 'manual' });
    const heldDraft = draftRef.current;
    if (heldDraft) {
      updateDraft({
        ...heldDraft,
        available2xProfiles: qualifiedCover2xProfiles(heldDraft.master, focus),
      });
    }
  }, []);

  const resetFocus = useCallback(() => {
    const automatic = draftRef.current?.automaticFocus;
    if (!automatic) return;
    updateSelection({ ...selectionRef.current, focus: automatic, focusMode: 'auto' });
    const heldDraft = draftRef.current;
    if (heldDraft) {
      updateDraft({
        ...heldDraft,
        available2xProfiles: qualifiedCover2xProfiles(heldDraft.master, automatic),
      });
    }
  }, []);

  const setEffect = useCallback(async (effect: EventCoverEffectId) => {
    updateSelection({ ...selectionRef.current, effect });
    if (styleThumbnails[effect].status === 'error') {
      previewAttemptedRef.current.delete(effect);
    }
    if (draftRef.current) await ensureEffectPreview(effect);
  }, [ensureEffectPreview, styleThumbnails]);

  const publish = useCallback(async (): Promise<CoverOperationAnswer> => {
    if (reconciler.accessFailure?.phase === 'before_dispatch') {
      throw reconciler.accessFailure.error;
    }
    const selected = selectionRef.current;
    let intent: CoverPublishIntent;
    if (selected.source === null) throw new Error('Choose a cover before publishing.');
    if (selected.source.kind === 'none') {
      intent = { source: { kind: 'none' } };
    } else if (selected.source.kind === 'preset') {
      intent = {
        source: { kind: 'preset', presetId: selected.source.presetId },
        effect: selected.effect,
      };
    } else {
      const heldDraft = draftRef.current;
      if (!heldDraft || heldDraft.view.state !== 'ready') {
        throw new Error('Finish preparing the cover photo before publishing.');
      }
      const focus = selected.focus ?? heldDraft.automaticFocus;
      intent = {
        source: { kind: 'upload', draftId: heldDraft.view.id },
        focus: selected.focusMode === 'auto'
          ? { mode: 'auto' }
          : { mode: 'manual', x: focus.x, y: focus.y, zoom: focus.zoom },
        effect: selected.effect,
      };
    }

    const operationId = ensureCoverOperation(event.id);
    reconciler.beginDispatch(operationId);
    try {
      const answer = await publishCoverIntent({
        eventId: event.id,
        expectedRevision: event.cover.revision,
        operationId,
        intent,
      });
      reconciler.dispatchSettled(answer);
      return answer;
    } catch (error) {
      // The request crossed the dispatch boundary. Never discard or republish;
      // status reconciliation decides whether it was accepted.
      reconciler.dispatchFailed(error);
      throw error;
    }
  }, [event.cover.revision, event.id, reconciler]);

  const discard = useCallback(async () => {
    if (!reconciler.controller.canDiscardDraft()) return;
    const heldDraft = draftRef.current;
    if (heldDraft) await discardCoverDraft(event.id, heldDraft.view);
    if (draftIntentKeyRef.current) {
      forgetCoverDraftIntent(event.id, draftIntentKeyRef.current);
      draftIntentKeyRef.current = null;
    }
    generationRef.current += 1;
    revokeUrls(false);
    updateDraft(null);
    setDraftState({ status: 'idle', error: null });
    updateSelection(selectionFor(event));
    setOpen(false);
  }, [event, reconciler.controller, revokeUrls]);

  const close = useCallback(() => {
    setOpen(false);
    // URLs are owned by the open session, while bytes stay cached for a replay-
    // free reopen of the same draft.
    revokeUrls(true);
  }, [revokeUrls]);

  let canvasPreview: CoverCanvasPreview = { kind: 'authoritative' };
  if (open) {
    const selectedThumbnail = styleThumbnails[selection.effect];
    const draftUrl = selectedThumbnail.status === 'ready'
      ? selectedThumbnail.url
      : draft?.previewUrl;
    if (draftUrl) canvasPreview = { kind: 'draft', url: draftUrl };
    else if (selection.source?.kind === 'preset') {
      const current = event.cover.config;
      const unchanged = current.source.kind === 'preset'
        && current.source.presetId === selection.source.presetId
        && (current as Extract<typeof current, { source: { kind: 'preset' } }>).effect === selection.effect;
      if (!unchanged) {
        canvasPreview = {
          kind: 'preset',
          presetId: selection.source.presetId,
          effect: selection.effect,
        };
      }
    }
  }

  return {
    open,
    selection,
    draft,
    draftState,
    operation: reconciler.operation,
    operationState: reconciler.operationState,
    canvasPreview,
    styleThumbnails,
    accessFailure: reconciler.accessFailure,
    openStudio,
    chooseSource,
    chooseFile,
    enterCompose,
    setFocus,
    resetFocus,
    setEffect,
    publish,
    discard,
    close,
  };
}

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
  readCoverDraft,
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
  prefetchStylePreviews(): Promise<void>;
  retryEffectPreview(effect: EventCoverEffectId): Promise<void>;
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

type CoverDraftSource =
  | { kind: 'existing-upload'; expectedCoverRevision: number }
  | { kind: 'new-upload'; file: File };

interface CoverDraftAttempt {
  key: string;
  source: CoverDraftSource;
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
const CONSUMED_DRAFT_STATES = new Set(['expired', 'published']);

function publishingDraftError(): Error {
  return new Error('That cover is being published. Wait for it to finish, then try discarding again.');
}

function isAccessError(error: unknown): boolean {
  return error instanceof ClientApiError && ACCESS_CODES.has(error.code);
}

function isDefinitiveReservationRejection(error: unknown): boolean {
  return error instanceof ClientApiError
    && error.status !== undefined
    && error.status >= 400
    && error.status < 500;
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
  const [draftState, setDraftSessionStateValue] = useState<CoverDraftSessionState>({ status: 'idle', error: null });
  const [styleThumbnails, setStyleThumbnails] = useState(idleThumbnails);
  const selectionRef = useRef(selection);
  const draftRef = useRef(draft);
  const draftStateRef = useRef(draftState);
  const generationRef = useRef(0);
  const draftPromiseRef = useRef<{ key: string; promise: Promise<void> } | null>(null);
  const pendingDraftPromisesRef = useRef(new Set<Promise<void>>());
  const draftAttemptRef = useRef<CoverDraftAttempt | null>(null);
  const unresolvedDraftAttemptsRef = useRef(new Map<string, CoverDraftSource>());
  const draftIntentKeysRef = useRef(new Set<string>());
  const ownedDraftsRef = useRef(new Map<string, CoverDraftView>());
  const discardingRef = useRef(false);
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

  function updateDraftState(next: CoverDraftSessionState) {
    draftStateRef.current = next;
    setDraftSessionStateValue(next);
  }

  const replacePreviewUrl = useCallback((effect: EventCoverEffectId, url: string) => {
    const previous = previewUrlsRef.current.get(effect);
    previewUrlsRef.current.set(effect, url);
    if (previous && previous !== url) {
      const stillOwned = [...previewUrlsRef.current.entries()]
        .some(([heldEffect, heldUrl]) => heldEffect !== effect && heldUrl === previous);
      if (!stillOwned) URL.revokeObjectURL(previous);
    }
  }, []);

  const revokeUrls = useCallback((preserveBytes: boolean, preserveUrls = false) => {
    for (const [effect, controller] of previewControllersRef.current) {
      controller.abort();
      previewAttemptedRef.current.delete(effect);
    }
    previewControllersRef.current.clear();
    previewPromisesRef.current.clear();
    if (!preserveUrls) {
      for (const url of new Set(previewUrlsRef.current.values())) URL.revokeObjectURL(url);
      previewUrlsRef.current.clear();
    }
    if (preserveBytes) {
      for (const effect of previewAttemptedRef.current) {
        if (!previewBytesRef.current.has(effect)) previewAttemptedRef.current.delete(effect);
      }
    } else {
      previewBytesRef.current.clear();
      previewAttemptedRef.current.clear();
    }
    if (mountedRef.current) {
      setStyleThumbnails(preserveUrls
        ? Object.fromEntries(EVENT_COVER_EFFECTS.map((effect) => {
            const url = previewUrlsRef.current.get(effect);
            return [effect, url
              ? { status: 'loading', url, error: null }
              : { status: 'idle', url: null, error: null }];
          })) as Record<EventCoverEffectId, CoverStyleThumbnail>
        : idleThumbnails());
      const held = draftRef.current;
      if (held && !preserveUrls) updateDraft({ ...held, previewUrl: '' });
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
      replacePreviewUrl(effect, url);
      setThumbnail(effect, { status: 'ready', url, error: null });
      if (effect === 'natural') updateDraft({ ...heldDraft, previewUrl: url });
      return Promise.resolve();
    }
    if (previewAttemptedRef.current.has(effect)) return Promise.resolve();
    previewAttemptedRef.current.add(effect);
    setThumbnail(effect, {
      status: 'loading',
      url: previewUrlsRef.current.get(effect) ?? null,
      error: null,
    });
    const controller = new AbortController();
    previewControllersRef.current.set(effect, controller);
    const draftId = heldDraft.view.id;
    const request = (async () => {
      try {
        const bytes = await readCoverEffectPreview(event.id, draftId, effect, controller.signal);
        const currentDraft = draftRef.current;
        if (currentDraft?.view.id !== draftId
            || controller.signal.aborted
            || previewControllersRef.current.get(effect) !== controller) return;
        previewBytesRef.current.set(effect, bytes);
        const url = createPreviewUrl(bytes);
        replacePreviewUrl(effect, url);
        setThumbnail(effect, { status: 'ready', url, error: null });
        if (effect === 'natural') updateDraft({ ...currentDraft, previewUrl: url });
      } catch (error) {
        if (controller.signal.aborted
            || previewControllersRef.current.get(effect) !== controller) return;
        setThumbnail(effect, {
          status: 'error',
          url: previewUrlsRef.current.get(effect) ?? null,
          error,
        });
      }
    })();
    previewPromisesRef.current.set(effect, request);
    const release = () => {
      if (previewControllersRef.current.get(effect) === controller) {
        previewControllersRef.current.delete(effect);
      }
      if (previewPromisesRef.current.get(effect) === request) {
        previewPromisesRef.current.delete(effect);
      }
    };
    void request.then(release, release);
    return request;
  }, [event.id, replacePreviewUrl, setThumbnail]);

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
    replacePreviewUrl('natural', url);
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
    updateDraftState({ status: 'ready', error: null });
  }, [replacePreviewUrl, setThumbnail]);

  const runDraft = useCallback((
    key: string,
    source: CoverDraftSource,
  ): Promise<void> => {
    if (discardingRef.current) {
      return Promise.reject(new Error('Cover draft discard is in progress.'));
    }
    if (draftPromiseRef.current?.key === key) return draftPromiseRef.current.promise;
    draftAttemptRef.current = { key, source };
    unresolvedDraftAttemptsRef.current.set(key, source);
    draftIntentKeysRef.current.add(key);
    const generation = ++generationRef.current;
    revokeUrls(false, true);
    updateDraft(null);
    updateDraftState({ status: 'loading', error: null });

    const request = (async () => {
      try {
        let reservation;
        try {
          reservation = await createCoverDraft(source.kind === 'new-upload'
            ? { eventId: event.id, intentKey: key, source: { kind: 'new-upload', file: source.file } }
            : {
                eventId: event.id,
                intentKey: key,
                source: {
                  kind: 'existing-upload',
                  expectedCoverRevision: source.expectedCoverRevision,
                },
              });
        } catch (error) {
          if (isDefinitiveReservationRejection(error)) {
            unresolvedDraftAttemptsRef.current.delete(key);
          }
          throw error;
        }
        let view = reservation.draft;
        ownedDraftsRef.current.set(view.id, view);
        unresolvedDraftAttemptsRef.current.delete(key);
        if (generation !== generationRef.current) return;
        if (source.kind === 'new-upload' && view.state === 'reserved') {
          view = await transferCoverDraft({ eventId: event.id, draft: view, file: source.file });
          ownedDraftsRef.current.set(view.id, view);
          if (generation !== generationRef.current) return;
        }
        if (view.state === 'transferred') {
          view = await inspectCoverDraft(event.id, view);
          ownedDraftsRef.current.set(view.id, view);
          if (generation !== generationRef.current) return;
        }
        if (view.state !== 'inspected' && view.state !== 'ready') {
          throw new Error('The cover draft did not become available for composition.');
        }

        const naturalController = new AbortController();
        previewControllersRef.current.set('natural', naturalController);
        previewAttemptedRef.current.add('natural');
        setThumbnail('natural', {
          status: 'loading',
          url: previewUrlsRef.current.get('natural') ?? null,
          error: null,
        });
        let naturalBytes: ArrayBuffer;
        try {
          naturalBytes = await readCoverEffectPreview(
            event.id,
            view.id,
            'natural',
            naturalController.signal,
          );
        } catch (error) {
          if (!naturalController.signal.aborted
              && previewControllersRef.current.get('natural') === naturalController) {
            setThumbnail('natural', {
              status: 'error',
              url: previewUrlsRef.current.get('natural') ?? null,
              error,
            });
          }
          throw error;
        } finally {
          if (previewControllersRef.current.get('natural') === naturalController) {
            previewControllersRef.current.delete('natural');
          }
        }
        if (generation !== generationRef.current) return;
        if (view.state === 'inspected') {
          const focus = await resolveCompositionFromPreview(naturalBytes, compositionRunner);
          if (generation !== generationRef.current) return;
          view = await writeCoverComposition({ eventId: event.id, draft: view, focus });
          ownedDraftsRef.current.set(view.id, view);
          if (generation !== generationRef.current) return;
          updateSelection({ ...selectionRef.current, focusMode: 'auto' });
        }
        if (view.state !== 'ready') throw new Error('The cover draft did not become ready.');
        if (generation !== generationRef.current) return;
        installReadyDraft(view, naturalBytes);
      } catch (error) {
        if (generation !== generationRef.current) return;
        updateDraftState({ status: 'error', error });
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
    pendingDraftPromisesRef.current.add(request);
    void request.then(
      () => pendingDraftPromisesRef.current.delete(request),
      () => pendingDraftPromisesRef.current.delete(request),
    );
    return request;
  }, [compositionRunner, event.cover.revision, event.id, installReadyDraft, reconciler, revokeUrls, setThumbnail]);

  const openStudio = useCallback(() => {
    const terminal = reconciler.controller.getState().phase;
    if (terminal === 'applied' || terminal === 'permanent-failed') {
      generationRef.current += 1;
      revokeUrls(false);
      updateDraft(null);
      updateDraftState({ status: 'idle', error: null });
      for (const key of draftIntentKeysRef.current) forgetCoverDraftIntent(event.id, key);
      draftIntentKeysRef.current.clear();
      draftAttemptRef.current = null;
      unresolvedDraftAttemptsRef.current.clear();
      ownedDraftsRef.current.clear();
      updateSelection(selectionFor(event));
    }
    reconciler.controller.releaseTerminal();
    setOpen(true);
    if (selectionRef.current.source?.kind === 'upload'
        && draftRef.current
        && !draftRef.current.previewUrl) {
      void ensureEffectPreview('natural');
    }
  }, [ensureEffectPreview, event, reconciler.controller, revokeUrls]);

  const chooseSource = useCallback((source: CoverSessionSource) => {
    if (discardingRef.current) return;
    const keepUploadFocus = draftRef.current !== null
      || (source?.kind === 'upload' && selectionRef.current.source?.kind === 'upload');
    updateSelection({
      ...selectionRef.current,
      source,
      focus: keepUploadFocus ? selectionRef.current.focus : null,
      focusMode: keepUploadFocus ? selectionRef.current.focusMode : 'auto',
    });
  }, []);

  const chooseFile = useCallback(async (file: File) => {
    if (discardingRef.current) throw new Error('Cover draft discard is in progress.');
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
    if (discardingRef.current) throw new Error('Cover draft discard is in progress.');
    if (draftRef.current?.view.state === 'ready') return;
    const attempt = draftAttemptRef.current;
    if (attempt) {
      await runDraft(attempt.key, attempt.source);
      return;
    }
    if (event.cover.config.source.kind !== 'upload') return;
    await runDraft(`existing-upload.${event.cover.revision}`, {
      kind: 'existing-upload',
      expectedCoverRevision: event.cover.revision,
    });
  }, [event.cover.config.source.kind, event.cover.revision, runDraft]);

  const setFocus = useCallback((focus: CoverFocusValue) => {
    if (discardingRef.current) return;
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
    if (discardingRef.current) return;
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
    if (discardingRef.current) throw new Error('Cover draft discard is in progress.');
    updateSelection({ ...selectionRef.current, effect });
    if (selectionRef.current.source?.kind === 'upload' && draftRef.current) {
      await ensureEffectPreview(effect);
    }
  }, [ensureEffectPreview]);

  const prefetchStylePreviews = useCallback(async () => {
    if (selectionRef.current.source?.kind !== 'upload') return;
    await Promise.all(EVENT_COVER_EFFECTS.map((effect) => ensureEffectPreview(effect)));
  }, [ensureEffectPreview]);

  const retryEffectPreview = useCallback(async (effect: EventCoverEffectId) => {
    if (discardingRef.current) throw new Error('Cover draft discard is in progress.');
    if (selectionRef.current.source?.kind !== 'upload') return;
    const inFlight = previewPromisesRef.current.get(effect);
    if (inFlight) return inFlight;
    if (styleThumbnails[effect].status !== 'error') return;
    previewAttemptedRef.current.delete(effect);
    await ensureEffectPreview(effect);
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
    if (discardingRef.current) throw new Error('Cover draft discard is already in progress.');
    discardingRef.current = true;
    const canceledIncompleteAttempt = draftStateRef.current.status === 'loading';
    generationRef.current += 1;
    const pending = [...pendingDraftPromisesRef.current];
    const pendingPreviews = [...previewPromisesRef.current.values()];
    for (const [effect, controller] of previewControllersRef.current) {
      controller.abort();
      previewAttemptedRef.current.delete(effect);
    }
    previewControllersRef.current.clear();
    previewPromisesRef.current.clear();
    if (mountedRef.current) {
      setStyleThumbnails((held) => Object.fromEntries(EVENT_COVER_EFFECTS.map((effect) => [
        effect,
        held[effect].status === 'loading'
          ? { status: 'idle', url: null, error: null }
          : held[effect],
      ])) as Record<EventCoverEffectId, CoverStyleThumbnail>);
    }

    try {
      await Promise.allSettled([...pending, ...pendingPreviews]);

      // A reservation POST may have committed even when its response was
      // lost. Replay only ambiguous attempts; acknowledged reservations are
      // already owned and must not be revalidated against a newer cover.
      for (const [key, source] of unresolvedDraftAttemptsRef.current) {
        const reservation = await createCoverDraft(source.kind === 'new-upload'
          ? { eventId: event.id, intentKey: key, source: { kind: 'new-upload', file: source.file } }
          : {
              eventId: event.id,
              intentKey: key,
              source: {
                kind: 'existing-upload',
                expectedCoverRevision: source.expectedCoverRevision,
              },
            });
        ownedDraftsRef.current.set(reservation.draft.id, reservation.draft);
        unresolvedDraftAttemptsRef.current.delete(key);
      }

      const currentDraftId = draftRef.current?.view.id ?? null;
      const owned = [...ownedDraftsRef.current.entries()].sort(([left], [right]) => {
        if (left === currentDraftId) return 1;
        if (right === currentDraftId) return -1;
        return 0;
      });
      for (const [id] of owned) {
        let current: CoverDraftView;
        try {
          current = await readCoverDraft(event.id, id);
        } catch (error) {
          if (error instanceof ClientApiError && error.code === 'EVENT_NOT_FOUND') {
            ownedDraftsRef.current.delete(id);
            continue;
          }
          throw error;
        }
        ownedDraftsRef.current.set(id, current);

        if (current.state === 'publishing') throw publishingDraftError();
        let discarded = CONSUMED_DRAFT_STATES.has(current.state);
        for (let attempt = 0; attempt < 2 && !discarded; attempt += 1) {
          try {
            await discardCoverDraft(event.id, current);
            discarded = true;
          } catch (error) {
            if (!(error instanceof TypeError)) throw error;
            try {
              current = await readCoverDraft(event.id, id);
            } catch (readError) {
              if (readError instanceof ClientApiError && readError.code === 'EVENT_NOT_FOUND') {
                discarded = true;
                break;
              }
              throw readError;
            }
            ownedDraftsRef.current.set(id, current);
            if (current.state === 'publishing') throw publishingDraftError();
            if (CONSUMED_DRAFT_STATES.has(current.state)) discarded = true;
          }
        }
        if (!discarded) {
          throw new Error('The draft deletion could not be confirmed. Try discarding again.');
        }
        ownedDraftsRef.current.delete(id);
      }

      revokeUrls(false);
      for (const key of draftIntentKeysRef.current) forgetCoverDraftIntent(event.id, key);
      draftIntentKeysRef.current.clear();
      draftAttemptRef.current = null;
      unresolvedDraftAttemptsRef.current.clear();
      updateDraft(null);
      updateDraftState({ status: 'idle', error: null });
      updateSelection(selectionFor(event));
      setOpen(false);
    } catch (error) {
      if (canceledIncompleteAttempt && draftAttemptRef.current) {
        updateDraftState({
          status: 'error',
          error: new Error('Photo preparation was canceled before the draft could be discarded.'),
        });
      }
      throw error;
    } finally {
      discardingRef.current = false;
    }
  }, [event, reconciler.controller, revokeUrls]);

  const close = useCallback(() => {
    setOpen(false);
    // URLs are owned by the open session, while bytes stay cached for a replay-
    // free reopen of the same draft.
    revokeUrls(true);
  }, [revokeUrls]);

  let canvasPreview: CoverCanvasPreview = { kind: 'authoritative' };
  if (open) {
    if (selection.source?.kind === 'upload') {
      const selectedThumbnail = styleThumbnails[selection.effect];
      const draftUrl = selectedThumbnail.status === 'ready'
        ? selectedThumbnail.url
        : draft?.previewUrl;
      if (draftUrl) canvasPreview = { kind: 'draft', url: draftUrl };
    } else if (selection.source?.kind === 'preset') {
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
    prefetchStylePreviews,
    retryEffectPreview,
    publish,
    discard,
    close,
  };
}

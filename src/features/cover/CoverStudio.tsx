import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';

import type {
  EventCoverEffectId,
  EventCoverPresetId,
  EventCoverProfileId,
} from '../../../shared/event-cover';
import { EVENT_COVER_PRESETS } from '../../../shared/event-cover';
import {
  CoverComposer,
  type CoverComposerHandle,
  type CoverFocusValue,
} from './CoverComposer';
import { CoverSourcePicker, type CoverSourceChoice } from './CoverSourcePicker';
import {
  CoverStylePicker,
  coverStyleName,
  type CoverStyleThumbnailState,
} from './CoverStylePicker';
import type { CoverOperationController, CoverOperationState } from './cover-operation-controller';
import type { CoverDraftSessionState } from './use-cover-studio-session';
import type { CoverAccessFailure } from './use-cover-operation-reconciler';

export type CoverStudioStep = 'choose' | 'compose' | 'style' | 'done';

export interface CoverStudioDraft {
  id: string;
  /** The focus active when this edit draft opened. */
  initialFocus: CoverFocusValue;
  /** The master's stored proposal used by Adjust and Reset. */
  automaticFocus: CoverFocusValue;
  master: {
    width: number;
    height: number;
    safeZoomMaximum: number;
  };
  available2xProfiles: readonly EventCoverProfileId[];
}

type StudioSource = CoverSourceChoice | { kind: 'none' } | null;

export interface CoverPublishIntent {
  source: CoverSourceChoice | { kind: 'none' };
  focus: CoverFocusValue | null;
  effect: EventCoverEffectId;
}

export interface CoverStudioProps {
  open: boolean;
  canvas?: ReactNode;
  operation: CoverOperationController;
  operationState: CoverOperationState;
  draft: CoverStudioDraft | null;
  composeState: CoverDraftSessionState;
  source: StudioSource;
  focus: CoverFocusValue | null;
  focusMode: 'auto' | 'manual';
  effect: EventCoverEffectId;
  accessFailure: CoverAccessFailure | null;
  error?: string | null;
  canRemove: boolean;
  presetThumbnail(presetId: EventCoverPresetId): string;
  styleThumbnail(effect: EventCoverEffectId): CoverStyleThumbnailState;
  onSourceChange(source: StudioSource): void;
  onUpload(file: File): void;
  onEnterCompose(): void;
  onFocusChange(focus: CoverFocusValue): void;
  onResetFocus(): void;
  onEffectChange(effect: EventCoverEffectId): void;
  onPublish(intent: CoverPublishIntent): void;
  onDiscardDraft(): void | Promise<void>;
  onClose(): void;
}

const STEP_TITLES: Record<CoverStudioStep, string> = {
  choose: 'Choose a cover',
  compose: 'Position the photo',
  style: 'Choose a style',
  done: 'Save this cover',
};

type CoverStudioViewport = 'default' | 'compact' | 'short';
type HistorySentinelState = 'disarmed' | 'armed' | 'consumed';
type CanvasDragOrigin = {
  pointerId: number;
  clientX: number;
  clientY: number;
  focus: CoverFocusValue;
  moved: boolean;
};

function readViewportMode(height: number): CoverStudioViewport {
  if (height <= 420) return 'short';
  if (height < 500) return 'compact';
  return 'default';
}

function focusableWithin(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
  ));
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function CoverStudio({
  open,
  canvas,
  operation,
  operationState,
  draft,
  composeState,
  source,
  focus,
  focusMode,
  effect,
  accessFailure,
  error = null,
  canRemove,
  presetThumbnail,
  styleThumbnail,
  onSourceChange,
  onUpload,
  onEnterCompose,
  onFocusChange,
  onResetFocus,
  onEffectChange,
  onPublish,
  onDiscardDraft,
  onClose,
}: CoverStudioProps) {
  const [step, setStep] = useState<CoverStudioStep>('choose');
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [discardError, setDiscardError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [submittedIntent, setSubmittedIntent] = useState<CoverPublishIntent | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  const confirmKeepRef = useRef<HTMLButtonElement>(null);
  const composeRetryRef = useRef<HTMLButtonElement>(null);
  const coverErrorRef = useRef<HTMLParagraphElement>(null);
  const discardErrorRef = useRef<HTMLParagraphElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const continueRef = useRef<HTMLButtonElement>(null);
  const pendingBackFocusRef = useRef(false);
  const pendingConfirmFocusRef = useRef(false);
  const confirmOriginRef = useRef<HTMLElement | null>(null);
  const returnFocusRef = useRef<Element | null>(null);
  const composeRequestedRef = useRef(false);
  const autoClosedRef = useRef(false);
  const composerRef = useRef<CoverComposerHandle>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const canvasDragRef = useRef<CanvasDragOrigin | null>(null);
  const [canvasDragging, setCanvasDragging] = useState(false);
  const hostRef = useRef<HTMLDivElement | null>(null);
  if (hostRef.current === null && typeof document !== 'undefined') {
    hostRef.current = document.createElement('div');
    hostRef.current.className = 'cover-studio-host';
  }
  const [viewport, setViewport] = useState<CoverStudioViewport>('default');
  const [visualRect, setVisualRect] = useState<{ top: number; height: number; width: number } | null>(null);

  const historyTokenRef = useRef(`cover-studio-${crypto.randomUUID()}`);
  const sentinelRef = useRef<HistorySentinelState>('disarmed');
  const suppressPopRef = useRef(false);

  const steps = useMemo<CoverStudioStep[]>(() => {
    if (source?.kind === 'upload') return ['choose', 'compose', 'style', 'done'];
    if (source?.kind === 'none') return ['choose', 'done'];
    return ['choose', 'style', 'done'];
  }, [source?.kind]);
  const stepIndex = Math.max(0, steps.indexOf(step));
  const dispatched = operationState.dispatched;

  const armSentinel = useCallback(() => {
    history.pushState({
      ...(typeof history.state === 'object' && history.state ? history.state : {}),
      coverStudio: historyTokenRef.current,
    }, '');
    sentinelRef.current = 'armed';
  }, []);

  const consumeSentinel = useCallback(() => {
    if (sentinelRef.current !== 'armed') return;
    sentinelRef.current = 'consumed';
    suppressPopRef.current = true;
    history.back();
  }, []);

  const finishClose = useCallback(() => {
    consumeSentinel();
    onClose();
  }, [consumeSentinel, onClose]);

  const requestClose = useCallback(() => {
    if (dispatched || !dirty) {
      finishClose();
      return;
    }
    const active = document.activeElement;
    confirmOriginRef.current = active instanceof HTMLElement && dialogRef.current?.contains(active)
      ? active
      : headingRef.current;
    setConfirmingDiscard(true);
  }, [dirty, dispatched, finishClose]);
  const closeRef = useRef(requestClose);
  closeRef.current = requestClose;

  const keepEditing = useCallback(() => {
    if (discarding || discardError) return;
    // A real browser Back consumed the entry. Replace it before the alertdialog
    // closes, so a second Back has exactly the same meaning.
    if (sentinelRef.current === 'consumed') armSentinel();
    pendingConfirmFocusRef.current = true;
    setConfirmingDiscard(false);
    setDiscardError(null);
  }, [armSentinel, discardError, discarding]);

  const discardDraft = useCallback(async () => {
    setDiscarding(true);
    setDiscardError(null);
    try {
      if (operation.canDiscardDraft()) await onDiscardDraft();
      finishClose();
    } catch {
      setDiscardError('This draft could not be discarded. Check your connection and try again.');
    } finally {
      setDiscarding(false);
    }
  }, [finishClose, onDiscardDraft, operation]);

  useEffect(() => {
    if (!open) return;
    setStep('choose');
    setDirty(false);
    setSubmittedIntent(null);
    setConfirmingDiscard(false);
    setDiscarding(false);
    setDiscardError(null);
    pendingConfirmFocusRef.current = false;
    composeRequestedRef.current = false;
    autoClosedRef.current = false;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement;
    operation.attach();
    const host = hostRef.current;
    const inerted: HTMLElement[] = [];
    for (const sibling of Array.from(document.body.children)) {
      if (sibling === host || !(sibling instanceof HTMLElement)) continue;
      if (sibling.hasAttribute('inert')) continue;
      sibling.setAttribute('inert', '');
      inerted.push(sibling);
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      operation.detach();
      for (const sibling of inerted) sibling.removeAttribute('inert');
      document.body.style.overflow = previousOverflow;
      const target = returnFocusRef.current;
      if (target instanceof HTMLElement) target.focus();
    };
  }, [open, operation]);

  useEffect(() => {
    if (!open) return;
    const visual = window.visualViewport;
    const apply = () => {
      const height = visual?.height ?? window.innerHeight;
      setViewport(readViewportMode(height));
      setVisualRect(visual
        ? { top: visual.offsetTop, height: visual.height, width: visual.width }
        : null);
    };
    apply();
    visual?.addEventListener('resize', apply);
    visual?.addEventListener('scroll', apply);
    window.addEventListener('resize', apply);
    return () => {
      visual?.removeEventListener('resize', apply);
      visual?.removeEventListener('scroll', apply);
      window.removeEventListener('resize', apply);
    };
  }, [open]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!open || !host) return;
    document.body.append(host);
    return () => host.remove();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    armSentinel();
    const onPopState = () => {
      if (suppressPopRef.current) {
        suppressPopRef.current = false;
        return;
      }
      if (sentinelRef.current !== 'armed') return;
      sentinelRef.current = 'consumed';
      closeRef.current();
    };
    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('popstate', onPopState);
      // External unmount must not leave the Studio-owned entry behind.
      consumeSentinel();
      sentinelRef.current = 'disarmed';
    };
  }, [armSentinel, consumeSentinel, open]);

  useEffect(() => {
    if (!open) return;
    if (pendingBackFocusRef.current) {
      pendingBackFocusRef.current = false;
      continueRef.current?.focus();
    } else {
      headingRef.current?.focus();
    }
  }, [open, step]);

  useEffect(() => {
    if (confirmingDiscard) confirmKeepRef.current?.focus();
  }, [confirmingDiscard]);

  useEffect(() => {
    if (confirmingDiscard || !pendingConfirmFocusRef.current) return;
    pendingConfirmFocusRef.current = false;
    confirmOriginRef.current?.focus();
  }, [confirmingDiscard]);

  useEffect(() => {
    if (step === 'compose' && composeState.status === 'error') composeRetryRef.current?.focus();
  }, [composeState.status, step]);

  useEffect(() => {
    if (open && error) coverErrorRef.current?.focus();
  }, [error, open]);

  useEffect(() => {
    if (discardError) discardErrorRef.current?.focus();
  }, [discardError]);

  useEffect(() => {
    if (!open || operationState.phase !== 'applied' || autoClosedRef.current) return;
    autoClosedRef.current = true;
    finishClose();
  }, [finishClose, open, operationState.phase]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (discarding) return;
        if (confirmingDiscard) keepEditing();
        else requestClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const root = confirmingDiscard ? confirmRef.current : dialogRef.current;
      const focusable = focusableWithin(root);
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [confirmingDiscard, discarding, keepEditing, open, requestClose]);

  if (!open || !hostRef.current) return null;

  function choose(next: CoverSourceChoice) {
    if (editingDisabled) return;
    if (next.kind !== 'upload' || source?.kind !== 'upload') composeRequestedRef.current = false;
    onSourceChange(next);
    setDirty(true);
  }

  function advance() {
    if (editingDisabled) return;
    const next = steps[stepIndex + 1];
    if (!next) return;
    if (next === 'compose' && !composeRequestedRef.current) {
      composeRequestedRef.current = true;
      onEnterCompose();
    }
    setStep(next);
  }

  function back() {
    if (editingDisabled) return;
    const previous = steps[stepIndex - 1];
    if (!previous) return;
    pendingBackFocusRef.current = true;
    setStep(previous);
  }

  function remove() {
    if (editingDisabled) return;
    onSourceChange({ kind: 'none' });
    setDirty(true);
    setStep('done');
  }

  function publish() {
    if (!source || editingDisabled || accessFailure?.phase === 'before_dispatch') return;
    const intent: CoverPublishIntent = {
      source,
      focus: source.kind === 'upload' ? (focus ?? draft?.initialFocus ?? null) : null,
      effect,
    };
    setSubmittedIntent(intent);
    onPublish(intent);
  }

  const effectiveFocus = focus ?? draft?.initialFocus ?? null;
  const available2xProfiles = draft?.available2xProfiles ?? [];
  const composeReady = composeState.status === 'ready' && Boolean(draft && effectiveFocus);
  const uploadIncomplete = source?.kind === 'upload' && !composeReady;
  const doneDisabled = !source
    || uploadIncomplete
    || operationState.dispatched
    || operationState.phase === 'dispatching'
    || accessFailure?.phase === 'before_dispatch';
  const preparing = operationState.phase === 'preparing';
  const stepLabel = `Step ${stepIndex + 1} of ${steps.length}`;
  const editingDisabled = operationState.dispatched;
  const dragEnabled = step === 'compose'
    && composeReady
    && Boolean(draft && effectiveFocus)
    && !editingDisabled;
  const currentIntent: CoverPublishIntent | null = source ? {
    source,
    focus: source.kind === 'upload' ? (focus ?? draft?.initialFocus ?? null) : null,
    effect,
  } : null;
  const receiptIntent = operationState.dispatched ? submittedIntent : currentIntent;
  const receipt = receiptIntent ? (() => {
    if (receiptIntent.source.kind === 'none') return {
      title: 'Remove the current cover',
      audience: 'Guests will see the event theme instead.',
      guarantee: 'The current cover stays live until this change is completely applied. If anything fails, nothing changes.',
    };
    const receiptSource = receiptIntent.source;
    const sourceName = receiptSource.kind === 'upload'
      ? 'Your photo'
      : EVENT_COVER_PRESETS.find(({ id }) => id === receiptSource.presetId)?.name
        ?? receiptSource.presetId;
    return {
      title: `${sourceName} · ${coverStyleName(receiptIntent.effect)}`,
      audience: 'Guests see this at the top of RSVP and photo delivery.',
      guarantee: 'Your current cover stays live until the new one is completely ready. If anything fails, nothing changes.',
    };
  })() : null;

  function releaseCanvasDrag(element: HTMLDivElement, pointerId: number) {
    const origin = canvasDragRef.current;
    if (!origin || origin.pointerId !== pointerId) return;
    if (typeof element.hasPointerCapture === 'function'
        && element.hasPointerCapture(pointerId)
        && typeof element.releasePointerCapture === 'function') {
      element.releasePointerCapture(pointerId);
    }
    canvasDragRef.current = null;
    setCanvasDragging(false);
  }

  function cancelExistingCanvasDrag(element: HTMLDivElement) {
    const origin = canvasDragRef.current;
    if (origin) releaseCanvasDrag(element, origin.pointerId);
  }

  function canvasPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.isPrimary === false) {
      cancelExistingCanvasDrag(event.currentTarget);
      return;
    }
    if (!dragEnabled || !effectiveFocus) return;
    canvasDragRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      focus: effectiveFocus,
      moved: false,
    };
  }

  function canvasPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const origin = canvasDragRef.current;
    if (!origin || origin.pointerId !== event.pointerId) return;
    if (event.isPrimary === false || !dragEnabled) {
      releaseCanvasDrag(event.currentTarget, origin.pointerId);
      return;
    }
    const dx = event.clientX - origin.clientX;
    const dy = event.clientY - origin.clientY;
    if (!origin.moved && Math.hypot(dx, dy) < 3) return;
    const guest = event.currentTarget.querySelector<HTMLElement>('.event-appearance-canvas__guest');
    const bounds = guest?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;
    if (!origin.moved) {
      origin.moved = true;
      if (typeof event.currentTarget.setPointerCapture === 'function') {
        event.currentTarget.setPointerCapture(origin.pointerId);
      }
      setCanvasDragging(true);
    }
    composerRef.current?.applyCanvasDrag({
      x: clamp01(origin.focus.x - dx / bounds.width),
      y: clamp01(origin.focus.y - dy / bounds.height),
      zoom: origin.focus.zoom,
    });
  }

  return createPortal(<div className="cover-studio-shell">
    <div className="cover-studio__backdrop" onClick={requestClose} data-testid="cover-studio-backdrop" />
    <div
      className="cover-studio"
      role="dialog"
      aria-modal="true"
      aria-label="Cover Studio"
      data-viewport={viewport}
      style={visualRect && visualRect.width <= 760
        ? { top: `${visualRect.top}px`, height: `${visualRect.height}px` }
        : undefined}
      ref={dialogRef}
    >
      <header className="cover-studio__header" inert={confirmingDiscard}>
        <button type="button" className="cover-studio__close" onClick={requestClose}>
          {dispatched ? 'Close' : 'Cancel'}
        </button>
        <h2 tabIndex={-1} ref={headingRef}>{STEP_TITLES[step]}</h2>
        <p className="cover-studio__step">{stepLabel}</p>
      </header>

      {canvas && <div
        ref={canvasRef}
        className="cover-studio__canvas"
        inert={confirmingDiscard}
        data-drag-enabled={dragEnabled ? 'true' : 'false'}
        data-dragging={canvasDragging ? 'true' : 'false'}
        onPointerDown={canvasPointerDown}
        onPointerMove={canvasPointerMove}
        onPointerUp={(event) => releaseCanvasDrag(event.currentTarget, event.pointerId)}
        onPointerCancel={(event) => releaseCanvasDrag(event.currentTarget, event.pointerId)}
      >{canvas}</div>}

      <div className="cover-studio__controls" inert={confirmingDiscard}>
        {error && <p
          ref={coverErrorRef}
          className="form-error cover-studio__error"
          role="alert"
          tabIndex={-1}
        >
          {error}
        </p>}

        {step === 'choose' && <CoverSourcePicker
          value={source && source.kind !== 'none' ? source : null}
          onChoose={choose}
          onUpload={(file) => {
            if (editingDisabled) return;
            setDirty(true);
            onUpload(file);
          }}
          onRemove={remove}
          presetThumbnail={presetThumbnail}
          canRemove={canRemove}
          busy={composeState.status === 'loading' || editingDisabled}
        />}

        {step === 'compose' && composeState.status !== 'ready' && <div className="cover-studio__compose-state">
          {composeState.status !== 'error'
            ? <p role="status">Preparing your photo…</p>
            : <div role={error ? undefined : 'alert'}>
                <p>That photo could not be prepared. Your current cover is still live.</p>
                <button
                  ref={composeRetryRef}
                  type="button"
                  className="button button--secondary"
                  onClick={onEnterCompose}
                >
                  Try preparing again
                </button>
              </div>}
        </div>}

        {step === 'compose' && composeReady && draft && effectiveFocus && <CoverComposer
          ref={composerRef}
          value={effectiveFocus}
          safeZoomMaximum={draft.master.safeZoomMaximum}
          available2xProfiles={available2xProfiles}
          manual={focusMode === 'manual'}
          disabled={editingDisabled}
          onAdjust={() => { if (!editingDisabled) onFocusChange(draft.automaticFocus); }}
          onChange={(next) => {
            if (editingDisabled) return;
            onFocusChange(next);
            setDirty(true);
          }}
          onReset={() => {
            if (editingDisabled) return;
            onResetFocus();
            setDirty(true);
          }}
        />}

        {step === 'style' && <CoverStylePicker
          value={effect}
          disabled={editingDisabled}
          onChange={(next) => {
            if (editingDisabled) return;
            onEffectChange(next);
            setDirty(true);
          }}
          onRetry={(next) => { if (!editingDisabled) onEffectChange(next); }}
          thumbnail={styleThumbnail}
        />}

        {step === 'done' && <div className="cover-studio__done">
          {receipt && <div className="cover-studio__receipt">
            <p className="cover-studio__receipt-title">{receipt.title}</p>
            <p>{receipt.audience}</p>
            <p>{receipt.guarantee}</p>
          </div>}
          {accessFailure && <p role="alert">
            {accessFailure.phase === 'before_dispatch'
              ? 'Manager access must be restored before this cover can be sent.'
              : 'Manager access changed after this cover was sent. The same operation will resume after access is restored.'}
          </p>}
          {preparing && <p role="status">
            {operationState.slow
              ? 'Still preparing. Your current cover is safe, and you can close this window.'
              : `Preparing cover ${Math.min((operationState.view?.completedSteps ?? 0) + 1, operationState.view?.requiredSteps ?? 6)} of ${operationState.view?.requiredSteps ?? 6}.`}
          </p>}
          {operationState.phase === 'retryable-failed' && <button
            type="button"
            className="button button--secondary"
            onClick={() => { void operation.retry(); }}
          >
            Try again
          </button>}
        </div>}
      </div>

      <footer className="cover-studio__footer" inert={confirmingDiscard}>
        {stepIndex > 0 && <button
          type="button"
          className="button button--secondary"
          disabled={editingDisabled}
          onClick={back}
        >
          Back
        </button>}
        {step === 'done'
          ? <button
              type="button"
              className="button button--primary"
              disabled={doneDisabled}
              onClick={publish}
            >
              Done
            </button>
          : <button
              ref={continueRef}
              type="button"
              className="button button--primary"
              disabled={editingDisabled || !source || (step === 'compose' && !composeReady)}
              onClick={advance}
            >
              Continue
            </button>}
      </footer>

      {confirmingDiscard && <div
        ref={confirmRef}
        className="cover-studio__confirm"
        role="alertdialog"
        aria-modal="true"
        aria-label="Discard cover changes"
        aria-busy={discarding}
      >
        <p>Discard this cover change?</p>
        {discarding && <p role="status">Discarding draft…</p>}
        {discardError && <p
          ref={discardErrorRef}
          className="form-error cover-studio__confirm-error"
          role="alert"
          tabIndex={-1}
        >
          {discardError}
        </p>}
        <button
          ref={confirmKeepRef}
          type="button"
          className="button button--secondary"
          aria-disabled={discarding || Boolean(discardError)}
          onClick={keepEditing}
        >
          Keep editing
        </button>
        <button
          type="button"
          className="button button--primary"
          aria-disabled={discarding}
          onClick={() => {
            if (!discarding) void discardDraft();
          }}
        >
          {discarding ? 'Discarding draft' : 'Discard draft'}
        </button>
      </div>}
    </div>
  </div>, hostRef.current);
}

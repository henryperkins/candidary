import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

import type {
  EventCoverEffectId,
  EventCoverPresetId,
  EventCoverProfileId,
} from '../../../shared/event-cover';
import { CoverComposer, type CoverFocusValue } from './CoverComposer';
import { CoverSourcePicker, type CoverSourceChoice } from './CoverSourcePicker';
import {
  CoverStylePicker,
  type CoverStyleThumbnailState,
} from './CoverStylePicker';
import type { CoverOperationController, CoverOperationState } from './cover-operation-controller';
import type { CoverDraftSessionState } from './use-cover-studio-session';
import type { CoverAccessFailure } from './use-cover-operation-reconciler';

export type CoverStudioStep = 'choose' | 'compose' | 'style' | 'done';

export interface CoverStudioDraft {
  id: string;
  previewUrl: string;
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
  canRemove: boolean;
  presetThumbnail(presetId: EventCoverPresetId): string;
  styleThumbnail(effect: EventCoverEffectId): CoverStyleThumbnailState;
  onSourceChange(source: StudioSource): void;
  onUpload(file: File): void;
  onEnterCompose(): void;
  onFocusChange(focus: CoverFocusValue): void;
  onResetFocus(): void;
  onEffectChange(effect: EventCoverEffectId): void;
  onPublish(intent: {
    source: CoverSourceChoice | { kind: 'none' };
    focus: CoverFocusValue | null;
    effect: EventCoverEffectId;
  }): void;
  onDiscardDraft(): void;
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
  const [dirty, setDirty] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  const confirmKeepRef = useRef<HTMLButtonElement>(null);
  const composeRetryRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const continueRef = useRef<HTMLButtonElement>(null);
  const pendingBackFocusRef = useRef(false);
  const confirmOriginRef = useRef<HTMLElement | null>(null);
  const returnFocusRef = useRef<Element | null>(null);
  const composeRequestedRef = useRef(false);
  const autoClosedRef = useRef(false);
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
    // A real browser Back consumed the entry. Replace it before the alertdialog
    // closes, so a second Back has exactly the same meaning.
    if (sentinelRef.current === 'consumed') armSentinel();
    setConfirmingDiscard(false);
    confirmOriginRef.current?.focus();
  }, [armSentinel]);

  useEffect(() => {
    if (!open) return;
    setStep('choose');
    setDirty(false);
    setConfirmingDiscard(false);
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
    if (step === 'compose' && composeState.status === 'error') composeRetryRef.current?.focus();
  }, [composeState.status, step]);

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
  }, [confirmingDiscard, keepEditing, open, requestClose]);

  if (!open || !hostRef.current) return null;

  function choose(next: CoverSourceChoice) {
    if (next.kind !== 'upload' || source?.kind !== 'upload') composeRequestedRef.current = false;
    onSourceChange(next);
    setDirty(true);
  }

  function advance() {
    const next = steps[stepIndex + 1];
    if (!next) return;
    if (next === 'compose' && !composeRequestedRef.current) {
      composeRequestedRef.current = true;
      onEnterCompose();
    }
    setStep(next);
  }

  function back() {
    const previous = steps[stepIndex - 1];
    if (!previous) return;
    pendingBackFocusRef.current = true;
    setStep(previous);
  }

  function remove() {
    onSourceChange({ kind: 'none' });
    setDirty(true);
    setStep('done');
  }

  function publish() {
    if (!source || accessFailure?.phase === 'before_dispatch') return;
    onPublish({
      source,
      focus: source.kind === 'upload' ? (focus ?? draft?.initialFocus ?? null) : null,
      effect,
    });
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
      <header className="cover-studio__header">
        <button type="button" className="cover-studio__close" onClick={requestClose}>
          {dispatched ? 'Close' : 'Cancel'}
        </button>
        <p className="cover-studio__step">{stepLabel}</p>
        <h2 tabIndex={-1} ref={headingRef}>{STEP_TITLES[step]}</h2>
      </header>

      {canvas && <div className="cover-studio__canvas">{canvas}</div>}

      <div className="cover-studio__controls">
        {step === 'choose' && <CoverSourcePicker
          value={source && source.kind !== 'none' ? source : null}
          onChoose={choose}
          onUpload={(file) => { setDirty(true); onUpload(file); }}
          onRemove={remove}
          presetThumbnail={presetThumbnail}
          canRemove={canRemove}
          busy={composeState.status === 'loading'}
        />}

        {step === 'compose' && composeState.status !== 'ready' && <div className="cover-studio__compose-state">
          {composeState.status !== 'error'
            ? <p role="status">Preparing your photo…</p>
            : <div role="alert">
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
          value={effectiveFocus}
          safeZoomMaximum={draft.master.safeZoomMaximum}
          previewUrl={draft.previewUrl}
          available2xProfiles={available2xProfiles}
          manual={focusMode === 'manual'}
          onAdjust={() => onFocusChange(draft.automaticFocus)}
          onChange={(next) => { onFocusChange(next); setDirty(true); }}
          onReset={() => { onResetFocus(); setDirty(true); }}
        />}

        {step === 'style' && <CoverStylePicker
          value={effect}
          onChange={(next) => { onEffectChange(next); setDirty(true); }}
          onRetry={onEffectChange}
          thumbnail={styleThumbnail}
        />}

        {step === 'done' && <div className="cover-studio__done">
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

      <footer className="cover-studio__footer">
        {stepIndex > 0 && <button type="button" className="button button--secondary" onClick={back}>
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
              disabled={!source || (step === 'compose' && !composeReady)}
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
      >
        <p>Discard this cover change?</p>
        <button
          ref={confirmKeepRef}
          type="button"
          className="button button--secondary"
          onClick={keepEditing}
        >
          Keep editing
        </button>
        <button
          type="button"
          className="button button--primary"
          onClick={() => {
            if (operation.canDiscardDraft()) onDiscardDraft();
            finishClose();
          }}
        >
          Discard draft
        </button>
      </div>}
    </div>
  </div>, hostRef.current);
}

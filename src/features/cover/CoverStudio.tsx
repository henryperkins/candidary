import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

import type { EventCoverEffectId, EventCoverPresetId } from '../../../shared/event-cover';
import { CoverComposer, type CoverFocusValue } from './CoverComposer';
import { CoverSourcePicker, type CoverSourceChoice } from './CoverSourcePicker';
import { CoverStylePicker } from './CoverStylePicker';
import type { CoverOperationController, CoverOperationState } from './cover-operation-controller';

/**
 * One short path: Choose, Compose for an upload only, Style, Done.
 *
 * A built-in design is already composed for every size, so it takes the honest
 * three-step path rather than being walked through an empty Compose. Removal is
 * the explicit exception and goes straight to a focused, labelled Done — there
 * is nothing to compose or style about not having a cover.
 *
 * Unwired in this release. Nothing shipped opens it.
 */

export type CoverStudioStep = 'choose' | 'compose' | 'style' | 'done';

export interface CoverStudioDraft {
  id: string;
  safeZoomMaximum: number;
  previewUrl: string;
  available2xProfiles: readonly string[];
  automaticFocus: CoverFocusValue;
}

export interface CoverStudioProps {
  open: boolean;
  /** The same live canvas the host is already looking at, not a second preview. */
  canvas?: ReactNode;
  operation: CoverOperationController;
  operationState: CoverOperationState;
  /** Null until an upload has been inspected and its composition stored. */
  draft: CoverStudioDraft | null;
  initialSource: CoverSourceChoice | null;
  initialEffect: EventCoverEffectId;
  canRemove: boolean;
  presetThumbnail(presetId: EventCoverPresetId): string;
  styleThumbnail(effect: EventCoverEffectId): string;
  onUpload(file: File): void;
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

/**
 * The geometry mode, measured rather than assumed.
 *
 * `short` is §6's short-height mode: below 421 visual pixels — which is also
 * what an approximately 320x180 viewport at 400% page zoom produces — sticky
 * geometry is abandoned for one dialog-level scroller, because a sticky header,
 * canvas, and footer would leave nothing for the controls.
 */
type CoverStudioViewport = 'default' | 'compact' | 'short';

function readViewportMode(height: number): CoverStudioViewport {
  if (height <= 420) return 'short';
  // An onscreen keyboard is open: the canvas compacts to 96 rather than pushing
  // the active control out of the visible rectangle.
  if (height < 500) return 'compact';
  return 'default';
}

export function CoverStudio({
  open,
  canvas,
  operation,
  operationState,
  draft,
  initialSource,
  initialEffect,
  canRemove,
  presetThumbnail,
  styleThumbnail,
  onUpload,
  onPublish,
  onDiscardDraft,
  onClose,
}: CoverStudioProps) {
  const [source, setSource] = useState<CoverSourceChoice | { kind: 'none' } | null>(initialSource);
  const [effect, setEffect] = useState<EventCoverEffectId>(initialEffect);
  const [focus, setFocus] = useState<CoverFocusValue | null>(null);
  const [step, setStep] = useState<CoverStudioStep>('choose');
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [dirty, setDirty] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  if (hostRef.current === null && typeof document !== 'undefined') {
    hostRef.current = document.createElement('div');
    hostRef.current.className = 'cover-studio-host';
  }
  const [viewport, setViewport] = useState<CoverStudioViewport>('default');
  const [visualRect, setVisualRect] = useState<{ top: number; height: number } | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const returnFocusRef = useRef<Element | null>(null);
  const poppedRef = useRef(false);
  const originRef = useRef<Partial<Record<CoverStudioStep, HTMLElement | null>>>({});

  // An upload takes four steps; a built-in design takes the accurate three.
  const steps = useMemo<CoverStudioStep[]>(() => {
    if (source?.kind === 'upload') return ['choose', 'compose', 'style', 'done'];
    if (source?.kind === 'none') return ['choose', 'done'];
    return ['choose', 'style', 'done'];
  }, [source?.kind]);

  const stepIndex = Math.max(0, steps.indexOf(step));
  const dispatched = operationState.dispatched;

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement;
    operation.attach();

    // The Manager page behind the sheet is genuinely inert and scroll-locked,
    // rather than merely described as such. The studio is portalled to the body
    // so its own subtree is not among the siblings being inerted.
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
      // Detaching stops polling and nothing else. It never cancels or discards
      // work an accepted receipt may still be doing.
      operation.detach();
      for (const sibling of inerted) sibling.removeAttribute('inert');
      document.body.style.overflow = previousOverflow;
      const target = returnFocusRef.current;
      if (target instanceof HTMLElement) target.focus();
    };
  }, [open, operation]);

  // Bound to the visible rectangle, not the layout viewport: with a keyboard
  // open they are different, and a footer pinned to the layout viewport sits
  // underneath the keyboard where nothing can reach it.
  useEffect(() => {
    if (!open) return;
    const visual = window.visualViewport;
    const apply = () => {
      const height = visual?.height ?? window.innerHeight;
      setViewport(readViewportMode(height));
      setVisualRect(visual ? { top: visual.offsetTop, height: visual.height } : null);
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

  // After Continue, focus moves to the new step heading rather than staying on
  // a button that has just changed meaning.
  useEffect(() => {
    if (open) headingRef.current?.focus();
  }, [open, step]);

  useEffect(() => {
    if (draft && focus === null) setFocus(draft.automaticFocus);
  }, [draft, focus]);

  const requestClose = useCallback(() => {
    // Once dispatch begins, Cancel is Close: there is no state left that closing
    // may throw away, whatever the client observed.
    if (dispatched || !dirty) {
      onClose();
      return;
    }
    setConfirmingDiscard(true);
  }, [dispatched, dirty, onClose]);

  // Browser Back is a dismissal like any other, so it takes the same
  // confirmation rather than leaving the sheet behind on the previous route.
  //
  // The handler reads `requestClose` through a ref rather than depending on it.
  // As a dependency, every change of `dirty` would tear the effect down — and
  // its cleanup pushes history back, which fires `popstate` against the closure
  // that was just replaced.
  const closeRef = useRef(requestClose);
  closeRef.current = requestClose;
  useEffect(() => {
    if (!open) return;
    history.pushState({ coverStudio: true }, '');
    poppedRef.current = false;
    const onPopState = () => {
      poppedRef.current = true;
      closeRef.current();
    };
    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('popstate', onPopState);
      // Only unwind the entry this sheet pushed, and only if Back did not
      // already consume it.
      if (!poppedRef.current && (history.state as { coverStudio?: boolean } | null)?.coverStudio) {
        history.back();
      }
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        requestClose();
        return;
      }
      if (event.key !== 'Tab') return;
      // Focus stays inside the sheet; the Manager page behind it is inert.
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable || focusable.length === 0) return;
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
  }, [open, requestClose]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!open || !host) return;
    document.body.append(host);
    return () => host.remove();
  }, [open]);

  if (!open || !hostRef.current) return null;

  function choose(choice: CoverSourceChoice) {
    setSource(choice);
    setDirty(true);
  }

  function advance() {
    const next = steps[stepIndex + 1];
    if (next) setStep(next);
  }

  function back() {
    const previous = steps[stepIndex - 1];
    if (!previous) return;
    setStep(previous);
    // Back restores the control that originated the later step.
    originRef.current[previous]?.focus();
  }

  function remove() {
    setSource({ kind: 'none' });
    setDirty(true);
    // The one path that skips the middle: there is nothing to compose or style.
    setStep('done');
  }

  function publish() {
    if (!source) return;
    onPublish({
      source,
      focus: source.kind === 'upload' ? focus : null,
      effect,
    });
  }

  const uploadIncomplete = source?.kind === 'upload' && (!draft || focus === null);
  const doneDisabled = !source || uploadIncomplete || operationState.phase === 'dispatching';

  const preparing = operationState.phase === 'preparing';
  const stepLabel = `Step ${stepIndex + 1} of ${steps.length}`;

  return createPortal(<div className="cover-studio-shell">
    {/* Dismissal here takes the same confirmation as Close, Escape, and Back. */}
    <div className="cover-studio__backdrop" onClick={requestClose} data-testid="cover-studio-backdrop" />
    <div
      className="cover-studio"
      role="dialog"
      aria-modal="true"
      aria-label="Cover Studio"
      data-viewport={viewport}
      style={visualRect ? { top: `${visualRect.top}px`, height: `${visualRect.height}px` } : undefined}
      ref={dialogRef}
    >
    <header className="cover-studio__header">
      <button type="button" className="cover-studio__close" onClick={requestClose}>
        {dispatched ? 'Close' : 'Cancel'}
      </button>
      <p className="cover-studio__step">{stepLabel}</p>
      <h2 tabIndex={-1} ref={headingRef}>{STEP_TITLES[step]}</h2>
    </header>

    {/* The same canvas, sticky above the controls — not a second preview. It
        compacts with the visible rectangle rather than requesting a new
        composition because the editor chrome got shorter. */}
    {canvas && <div className="cover-studio__canvas">{canvas}</div>}

    <div className="cover-studio__controls">
      {step === 'choose' && <CoverSourcePicker
        value={source && source.kind !== 'none' ? source : null}
        onChoose={choose}
        onUpload={(file) => { setDirty(true); onUpload(file); }}
        onRemove={remove}
        presetThumbnail={presetThumbnail}
        canRemove={canRemove}
      />}

      {step === 'compose' && draft && focus && <CoverComposer
        value={focus}
        safeZoomMaximum={draft.safeZoomMaximum}
        previewUrl={draft.previewUrl}
        available2xProfiles={draft.available2xProfiles}
        onChange={(next) => { setFocus(next); setDirty(true); }}
        onReset={() => setFocus(draft.automaticFocus)}
      />}

      {step === 'style' && <CoverStylePicker
        value={effect}
        onChange={(next) => { setEffect(next); setDirty(true); }}
        thumbnail={styleThumbnail}
      />}

      {step === 'done' && <div className="cover-studio__done">
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
          type="button"
          className="button button--primary"
          disabled={!source}
          ref={(node) => {
            const next = steps[stepIndex + 1];
            if (next) originRef.current[next] = node;
          }}
          onClick={advance}
        >
          Continue
        </button>}
    </footer>

    {confirmingDiscard && <div className="cover-studio__confirm" role="alertdialog" aria-label="Discard cover changes">
      <p>Discard this cover change?</p>
      <button type="button" className="button button--secondary" onClick={() => setConfirmingDiscard(false)}>
        Keep editing
      </button>
      <button
        type="button"
        className="button button--primary"
        onClick={() => {
          // Guarded on the server side too: a `publishing` draft refuses.
          if (operation.canDiscardDraft()) onDiscardDraft();
          onClose();
        }}
      >
        Discard
      </button>
    </div>}
    </div>
  </div>, hostRef.current);
}

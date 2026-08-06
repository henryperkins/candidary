import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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

export function CoverStudio({
  open,
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
  const headingRef = useRef<HTMLHeadingElement>(null);
  const returnFocusRef = useRef<Element | null>(null);
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
    return () => {
      // Detaching stops polling and nothing else. It never cancels or discards
      // work an accepted receipt may still be doing.
      operation.detach();
      const target = returnFocusRef.current;
      if (target instanceof HTMLElement) target.focus();
    };
  }, [open, operation]);

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

  if (!open) return null;

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

  return <div
    className="cover-studio"
    role="dialog"
    aria-modal="true"
    aria-label="Cover Studio"
    ref={dialogRef}
  >
    <header className="cover-studio__header">
      <button type="button" className="cover-studio__close" onClick={requestClose}>
        {dispatched ? 'Close' : 'Cancel'}
      </button>
      <p className="cover-studio__step">{stepLabel}</p>
      <h2 tabIndex={-1} ref={headingRef}>{STEP_TITLES[step]}</h2>
    </header>

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
  </div>;
}

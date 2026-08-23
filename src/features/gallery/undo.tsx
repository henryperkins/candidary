import { useCallback, useEffect, useRef, useState } from 'react';

/** The proposal's window. Long enough to read the sentence that explains what survived. */
export const UNDO_WINDOW_MS = 9_000;

export interface UndoOffer {
  /**
   * Names what changed *and* what survived it. Album mutations are frightening in a way
   * ordinary undo copy does not cover — a host removing a photo from the album needs to
   * be told, in the same breath, that the delivered original is untouched.
   */
  message: string;
  run(): Promise<void>;
}

interface PresentedOffer extends UndoOffer {
  sequence: number;
}

export interface UndoController {
  offer: PresentedOffer | null;
  running: boolean;
  error: string | null;
  present(offer: UndoOffer): void;
  dismiss(): void;
  run(): void;
  /** Held while focus is inside the bar; see `UndoBar`. */
  hold(source: 'focus' | 'pointer'): void;
  release(source: 'focus' | 'pointer'): void;
}

/**
 * A single-slot undo. A second mutation replaces the first offer rather than stacking,
 * because two live "Undo" controls on one surface cannot say which one they reverse.
 *
 * The expiry is suspended while focus is inside the bar. A control that removes itself
 * from under a keyboard host drops focus to `<body>` and loses their place in the mosaic
 * entirely — the nine seconds are a convenience for a pointer, never a deadline for
 * someone who has actually reached the button.
 */
export function useUndo(): UndoController {
  const [offer, setOffer] = useState<PresentedOffer | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const offerRef = useRef<PresentedOffer | null>(null);
  const sequence = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holds = useRef(new Set<'focus' | 'pointer'>());
  const expired = useRef(false);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const dismiss = useCallback(() => {
    clearTimer();
    expired.current = false;
    holds.current.clear();
    offerRef.current = null;
    setError(null);
    setOffer(null);
  }, [clearTimer]);

  const startTimer = useCallback((forSequence: number) => {
    clearTimer();
    timer.current = setTimeout(() => {
      timer.current = null;
      if (offerRef.current?.sequence !== forSequence) return;
      if (holds.current.size > 0) {
        expired.current = true;
        return;
      }
      offerRef.current = null;
      setOffer(null);
    }, UNDO_WINDOW_MS);
  }, [clearTimer]);

  const present = useCallback((next: UndoOffer) => {
    const nextSequence = ++sequence.current;
    expired.current = false;
    holds.current.clear();
    setError(null);
    const presented = { ...next, sequence: nextSequence };
    offerRef.current = presented;
    setOffer(presented);
    startTimer(nextSequence);
  }, [startTimer]);

  const run = useCallback(() => {
    if (!offer || running) return;
    clearTimer();
    setError(null);
    setRunning(true);
    void offer.run().then(() => {
      if (offerRef.current?.sequence !== offer.sequence) return;
      expired.current = false;
      holds.current.clear();
      offerRef.current = null;
      setOffer(null);
    }, (caught: unknown) => {
      if (offerRef.current?.sequence !== offer.sequence) return;
      setError(caught instanceof Error && caught.message
        ? caught.message
        : 'Undo could not be completed. Try again.');
      startTimer(offer.sequence);
    }).finally(() => setRunning(false));
  }, [clearTimer, offer, running, startTimer]);

  const hold = useCallback((source: 'focus' | 'pointer') => {
    holds.current.add(source);
  }, []);

  const release = useCallback((source: 'focus' | 'pointer') => {
    holds.current.delete(source);
    if (holds.current.size > 0) return;
    // The window ran out while the host was on the control. Honour the hold rather than
    // the clock: give the offer back its full window from the moment they leave.
    if (expired.current) {
      expired.current = false;
      const current = sequence.current;
      startTimer(current);
    }
  }, [startTimer]);

  useEffect(() => clearTimer, [clearTimer]);

  return { offer, running, error, present, dismiss, run, hold, release };
}

/**
 * The offer itself. `role="status"` rather than `alert`: an undoable success is not an
 * error, and an assertive interruption on every pick would make bulk work unusable with
 * a screen reader. The message is the live text; the controls are reachable but silent.
 */
export function UndoBar({
  controller,
  live = true,
  onRestoreFocus,
}: {
  controller: UndoController;
  live?: boolean;
  onRestoreFocus?: () => void;
}) {
  const { offer, running, error, dismiss, run, hold, release } = controller;
  const barRef = useRef<HTMLDivElement>(null);
  const closeFocusOrigin = useRef<HTMLElement | null>(null);
  const previousOffer = useRef(offer);

  const rememberCloseFocus = useCallback(() => {
    const active = document.activeElement;
    closeFocusOrigin.current = active instanceof HTMLElement && barRef.current?.contains(active)
      ? active
      : null;
  }, []);

  useEffect(() => {
    const previous = previousOffer.current;
    previousOffer.current = offer;
    if (!previous || offer) return;
    const origin = closeFocusOrigin.current;
    closeFocusOrigin.current = null;
    if (!origin) return;
    if (document.activeElement === origin || document.activeElement === document.body) {
      onRestoreFocus?.();
    }
  }, [offer, onRestoreFocus]);

  return <div className="album-undo" data-open={offer !== null}>
    <p
      className="sr-only"
      role={live ? 'status' : undefined}
      aria-live={live ? 'polite' : undefined}
      aria-atomic={live ? 'true' : undefined}
    >
      {offer ? `${offer.message} Undo is available for nine seconds.` : ''}
    </p>
    {offer && <div
      ref={barRef}
      className="album-undo__bar"
      onFocusCapture={() => hold('focus')}
      onBlurCapture={(blur) => {
        if (!blur.currentTarget.contains(blur.relatedTarget as Node | null)) release('focus');
      }}
      onPointerEnter={() => hold('pointer')}
      onPointerLeave={() => release('pointer')}
    >
      <span className="album-undo__message">{offer.message}</span>
      {error && <small className="album-undo__error" role={live ? 'alert' : undefined}>{error}</small>}
      <button
        type="button"
        className="album-undo__action"
        disabled={running}
        onClick={() => {
          rememberCloseFocus();
          run();
        }}
      >{running ? 'Undoing…' : 'Undo'}</button>
      <button
        type="button"
        className="album-undo__dismiss"
        aria-label="Dismiss"
        disabled={running}
        onClick={() => {
          rememberCloseFocus();
          dismiss();
        }}
      >Dismiss</button>
    </div>}
  </div>;
}

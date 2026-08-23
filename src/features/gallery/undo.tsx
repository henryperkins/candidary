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
  present(offer: UndoOffer): void;
  dismiss(): void;
  run(): void;
  /** Held while focus is inside the bar; see `UndoBar`. */
  hold(): void;
  release(): void;
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
  const sequence = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holding = useRef(false);
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
    setOffer(null);
  }, [clearTimer]);

  const startTimer = useCallback((forSequence: number) => {
    clearTimer();
    timer.current = setTimeout(() => {
      timer.current = null;
      if (holding.current) {
        expired.current = true;
        return;
      }
      setOffer((current) => (current?.sequence === forSequence ? null : current));
    }, UNDO_WINDOW_MS);
  }, [clearTimer]);

  const present = useCallback((next: UndoOffer) => {
    const nextSequence = ++sequence.current;
    expired.current = false;
    setOffer({ ...next, sequence: nextSequence });
    startTimer(nextSequence);
  }, [startTimer]);

  const run = useCallback(() => {
    if (!offer || running) return;
    clearTimer();
    setRunning(true);
    void offer.run().finally(() => {
      setRunning(false);
      expired.current = false;
      setOffer((current) => (current?.sequence === offer.sequence ? null : current));
    });
  }, [clearTimer, offer, running]);

  const hold = useCallback(() => {
    holding.current = true;
  }, []);

  const release = useCallback(() => {
    holding.current = false;
    // The window ran out while the host was on the control. Honour the hold rather than
    // the clock: give the offer back its full window from the moment they leave.
    if (expired.current) {
      expired.current = false;
      const current = sequence.current;
      startTimer(current);
    }
  }, [startTimer]);

  useEffect(() => clearTimer, [clearTimer]);

  return { offer, running, present, dismiss, run, hold, release };
}

/**
 * The offer itself. `role="status"` rather than `alert`: an undoable success is not an
 * error, and an assertive interruption on every pick would make bulk work unusable with
 * a screen reader. The message is the live text; the controls are reachable but silent.
 */
export function UndoBar({ controller }: { controller: UndoController }) {
  const { offer, running, dismiss, run, hold, release } = controller;
  return <div className="album-undo" data-open={offer !== null}>
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {offer ? `${offer.message} Undo is available for nine seconds.` : ''}
    </p>
    {offer && <div
      className="album-undo__bar"
      onFocusCapture={hold}
      onBlurCapture={release}
      onPointerEnter={hold}
      onPointerLeave={release}
    >
      <span className="album-undo__message">{offer.message}</span>
      <button
        type="button"
        className="album-undo__action"
        disabled={running}
        onClick={run}
      >{running ? 'Undoing…' : 'Undo'}</button>
      <button
        type="button"
        className="album-undo__dismiss"
        aria-label="Dismiss"
        disabled={running}
        onClick={dismiss}
      >Dismiss</button>
    </div>}
  </div>;
}

import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/** The standard Manager recovery window. */
export const UNDO_WINDOW_MS = 9_000;
/** Recoverable trash remains available longer, but never past its server deadline. */
export const TRASH_UNDO_WINDOW_MS = 30_000;
export const UNDO_FAILED_MESSAGE = 'Undo could not be completed. Check the current Manager state, then try Undo again.';

const MAX_TIMER_MS = 2_147_483_647;

export type ManagerUndoDuration = typeof UNDO_WINDOW_MS | typeof TRASH_UNDO_WINDOW_MS;
export type ManagerUndoState = 'idle' | 'offered' | 'running' | 'failed';

export interface ManagerUndoOffer {
  eventId: string;
  message: string;
  durationMs: ManagerUndoDuration;
  absoluteDeadline?: string;
  input: 'keyboard' | 'pointer';
  run(): Promise<void>;
}

export interface ManagerUndoController {
  state: ManagerUndoState;
  canPresent: boolean;
  present(offer: ManagerUndoOffer, presentation: { fallback: HTMLElement | null }): boolean;
  dismiss(): void;
  run(): void;
}

interface InternalUndoOffer {
  eventId: string;
  message: string;
  durationMs: number;
  absoluteDeadline?: string;
  input: 'keyboard' | 'pointer';
  run(): Promise<void>;
}

interface PresentedManagerUndoOffer extends InternalUndoOffer {
  sequence: number;
}

interface UndoSlot {
  offer: PresentedManagerUndoOffer;
  generation: number;
  remainingMs: number;
  durationDeadline: number | null;
  fallback: HTMLElement | null;
  focusUndo: boolean;
}

interface EngineSnapshot {
  state: ManagerUndoState;
  offer: PresentedManagerUndoOffer | null;
  rawError: string | null;
  announcement: string;
  restoreVersion: number;
  focusRequest: number | null;
}

type HoldSource = 'focus' | 'pointer';

interface UndoEngine {
  controller: ManagerUndoController;
  snapshot: EngineSnapshot;
  dismiss(): void;
  run(): void;
  hold(source: HoldSource): void;
  release(source: HoldSource): void;
  claimUndoFocus(sequence: number): boolean;
  restoreClosedFocus(): void;
}

function monotonicNow(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

function parsedDeadline(deadline: string | undefined): number | null {
  if (deadline === undefined) return null;
  const parsed = Date.parse(deadline);
  return Number.isFinite(parsed) ? parsed : null;
}

function currentSectionHeading(): HTMLElement | null {
  const selectors = [
    'main section:not([hidden]) h1',
    'main section:not([hidden]) h2',
    'main h1',
    'main h2',
  ];
  for (const selector of selectors) {
    const headings = document.querySelectorAll<HTMLElement>(selector);
    for (const heading of headings) {
      if (heading.closest('[hidden], [aria-hidden="true"]') === null) return heading;
    }
  }
  return null;
}

function focusElement(target: HTMLElement): void {
  if (!target.matches('button, a[href], input, select, textarea, [tabindex]')) target.tabIndex = -1;
  target.focus({ preventScroll: true });
}

function useUndoEngine(eventId: string): UndoEngine {
  const initialSnapshot: EngineSnapshot = {
    state: 'idle',
    offer: null,
    rawError: null,
    announcement: '',
    restoreVersion: 0,
    focusRequest: null,
  };
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const snapshotRef = useRef(initialSnapshot);
  const generationRef = useRef(0);
  const sequenceRef = useRef(0);
  const slotRef = useRef<UndoSlot | null>(null);
  const holdsRef = useRef(new Set<HoldSource>());
  const durationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const capTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closedFallbackRef = useRef<HTMLElement | null>(null);

  const publish = useCallback((next: EngineSnapshot) => {
    snapshotRef.current = next;
    setSnapshot(next);
  }, []);

  const clearDurationTimer = useCallback(() => {
    if (durationTimerRef.current !== null) {
      clearTimeout(durationTimerRef.current);
      durationTimerRef.current = null;
    }
  }, []);

  const clearCapTimer = useCallback(() => {
    if (capTimerRef.current !== null) {
      clearTimeout(capTimerRef.current);
      capTimerRef.current = null;
    }
  }, []);

  const retire = useCallback((sequence: number, announcement = '') => {
    const slot = slotRef.current;
    if (slot?.offer.sequence !== sequence) return;
    clearDurationTimer();
    clearCapTimer();
    holdsRef.current.clear();
    closedFallbackRef.current = slot.fallback;
    slotRef.current = null;
    const previous = snapshotRef.current;
    publish({
      state: 'idle',
      offer: null,
      rawError: null,
      announcement,
      restoreVersion: previous.restoreVersion + 1,
      focusRequest: null,
    });
  }, [clearCapTimer, clearDurationTimer, publish]);

  const armDurationTimer = useCallback((sequence: number) => {
    clearDurationTimer();
    const slot = slotRef.current;
    const currentState = snapshotRef.current.state;
    if (slot?.offer.sequence !== sequence || holdsRef.current.size > 0
      || (currentState !== 'offered' && currentState !== 'failed')) return;
    if (slot.remainingMs <= 0) {
      retire(sequence);
      return;
    }
    slot.durationDeadline = monotonicNow() + slot.remainingMs;
    const waitForDeadline = () => {
      const active = slotRef.current;
      if (active?.offer.sequence !== sequence || active.durationDeadline === null) return;
      const remaining = active.durationDeadline - monotonicNow();
      if (remaining <= 0) {
        active.remainingMs = 0;
        active.durationDeadline = null;
        retire(sequence);
        return;
      }
      durationTimerRef.current = setTimeout(waitForDeadline, Math.min(remaining, MAX_TIMER_MS));
    };
    durationTimerRef.current = setTimeout(waitForDeadline, Math.min(slot.remainingMs, MAX_TIMER_MS));
  }, [clearDurationTimer, retire]);

  const armCapTimer = useCallback((sequence: number) => {
    clearCapTimer();
    const waitForDeadline = () => {
      const active = slotRef.current;
      if (active?.offer.sequence !== sequence) return;
      const deadline = parsedDeadline(active.offer.absoluteDeadline);
      if (deadline === null) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        retire(sequence);
        return;
      }
      capTimerRef.current = setTimeout(waitForDeadline, Math.min(remaining, MAX_TIMER_MS));
    };
    waitForDeadline();
  }, [clearCapTimer, retire]);

  const pauseDuration = useCallback((slot: UndoSlot) => {
    if (slot.durationDeadline === null) return;
    slot.remainingMs = Math.max(0, slot.durationDeadline - monotonicNow());
    slot.durationDeadline = null;
    clearDurationTimer();
  }, [clearDurationTimer]);

  const retireIfDurationOverdue = useCallback((slot: UndoSlot): boolean => {
    if (slot.durationDeadline === null || slot.durationDeadline > monotonicNow()) return false;
    slot.remainingMs = 0;
    slot.durationDeadline = null;
    retire(slot.offer.sequence);
    return true;
  }, [retire]);

  const presentInternal = useCallback((
    next: InternalUndoOffer,
    fallback: HTMLElement | null,
  ): boolean => {
    if (next.eventId !== eventId
      || snapshotRef.current.state === 'running') return false;
    const absoluteDeadline = parsedDeadline(next.absoluteDeadline);
    if (absoluteDeadline !== null && absoluteDeadline <= Date.now()) return false;

    clearDurationTimer();
    clearCapTimer();
    closedFallbackRef.current = null;
    const sequence = ++sequenceRef.current;
    const active = typeof document === 'undefined' ? null : document.activeElement;
    const focusUndo = next.input === 'keyboard'
      && (active === document.body || active === fallback);
    const presented: PresentedManagerUndoOffer = { ...next, sequence };
    const slot: UndoSlot = {
      offer: presented,
      generation: generationRef.current,
      remainingMs: Math.max(0, next.durationMs),
      durationDeadline: null,
      fallback,
      focusUndo,
    };
    slotRef.current = slot;
    publish({
      state: 'offered',
      offer: presented,
      rawError: null,
      announcement: '',
      restoreVersion: snapshotRef.current.restoreVersion,
      focusRequest: focusUndo ? sequence : null,
    });
    armDurationTimer(sequence);
    armCapTimer(sequence);
    return true;
  }, [armCapTimer, armDurationTimer, clearCapTimer, clearDurationTimer, eventId, publish]);

  const present = useCallback((next: ManagerUndoOffer, presentation: {
    fallback: HTMLElement | null;
  }) => presentInternal(next, presentation.fallback), [presentInternal]);

  const dismiss = useCallback(() => {
    const slot = slotRef.current;
    if (!slot || snapshotRef.current.state === 'running') return;
    retire(slot.offer.sequence);
  }, [retire]);

  const run = useCallback(() => {
    const slot = slotRef.current;
    const state = snapshotRef.current.state;
    if (!slot || (state !== 'offered' && state !== 'failed')) return;
    if (retireIfDurationOverdue(slot)) return;
    const absoluteDeadline = parsedDeadline(slot.offer.absoluteDeadline);
    if (absoluteDeadline !== null && absoluteDeadline <= Date.now()) {
      retire(slot.offer.sequence);
      return;
    }
    pauseDuration(slot);
    const { generation, offer } = slot;
    publish({
      state: 'running',
      offer,
      rawError: null,
      announcement: '',
      restoreVersion: snapshotRef.current.restoreVersion,
      focusRequest: null,
    });
    void offer.run().then(() => {
      const active = slotRef.current;
      if (active?.offer.sequence !== offer.sequence || active.generation !== generation) return;
      retire(offer.sequence, 'Change undone.');
    }, (caught: unknown) => {
      const active = slotRef.current;
      if (active?.offer.sequence !== offer.sequence || active.generation !== generation) return;
      const cap = parsedDeadline(active.offer.absoluteDeadline);
      if (cap !== null && cap <= Date.now()) {
        retire(offer.sequence);
        return;
      }
      const rawError = caught instanceof Error && caught.message
        ? caught.message
        : UNDO_FAILED_MESSAGE;
      publish({
        state: 'failed',
        offer,
        rawError,
        announcement: '',
        restoreVersion: snapshotRef.current.restoreVersion,
        focusRequest: null,
      });
      armDurationTimer(offer.sequence);
    });
  }, [armDurationTimer, pauseDuration, publish, retire, retireIfDurationOverdue]);

  const hold = useCallback((source: HoldSource) => {
    const slot = slotRef.current;
    if (!slot || holdsRef.current.has(source)) return;
    if (holdsRef.current.size === 0) {
      const state = snapshotRef.current.state;
      if (state === 'offered' || state === 'failed') {
        if (retireIfDurationOverdue(slot)) return;
        pauseDuration(slot);
      }
    }
    holdsRef.current.add(source);
  }, [pauseDuration, retireIfDurationOverdue]);

  const release = useCallback((source: HoldSource) => {
    if (!holdsRef.current.delete(source) || holdsRef.current.size > 0) return;
    const slot = slotRef.current;
    const state = snapshotRef.current.state;
    if (slot && (state === 'offered' || state === 'failed')) {
      armDurationTimer(slot.offer.sequence);
    }
  }, [armDurationTimer]);

  const claimUndoFocus = useCallback((sequence: number) => {
    const slot = slotRef.current;
    if (slot?.offer.sequence !== sequence || !slot.focusUndo) return false;
    slot.focusUndo = false;
    return true;
  }, []);

  const restoreClosedFocus = useCallback(() => {
    const fallback = closedFallbackRef.current;
    closedFallbackRef.current = null;
    if (fallback?.isConnected) {
      focusElement(fallback);
      return;
    }
    const heading = currentSectionHeading();
    if (heading) focusElement(heading);
  }, []);

  useLayoutEffect(() => () => {
    generationRef.current += 1;
    clearDurationTimer();
    clearCapTimer();
    holdsRef.current.clear();
    slotRef.current = null;
  }, [clearCapTimer, clearDurationTimer]);

  const controller = useMemo<ManagerUndoController>(() => ({
    state: snapshot.state,
    canPresent: snapshot.state !== 'running',
    present,
    dismiss,
    run,
  }), [dismiss, present, run, snapshot.state]);

  return {
    controller,
    snapshot,
    dismiss,
    run,
    hold,
    release,
    claimUndoFocus,
    restoreClosedFocus,
  };
}

const ManagerUndoContext = createContext<UndoEngine | null>(null);

function ManagerUndoEventProvider({ eventId, children }: {
  eventId: string;
  children: ReactNode;
}) {
  const engine = useUndoEngine(eventId);
  return <ManagerUndoContext.Provider value={engine}>{children}</ManagerUndoContext.Provider>;
}

export function ManagerUndoProvider({ eventId, children }: {
  eventId: string;
  children: ReactNode;
}) {
  return <ManagerUndoEventProvider key={eventId} eventId={eventId}>
    {children}
  </ManagerUndoEventProvider>;
}

function useManagerUndoEngine(): UndoEngine {
  const engine = useContext(ManagerUndoContext);
  if (engine === null) throw new Error('useManagerUndo must be used within ManagerUndoProvider.');
  return engine;
}

export function useManagerUndo(): ManagerUndoController {
  return useManagerUndoEngine().controller;
}

function undoWindowSentence(windowMs: number): string {
  const seconds = Math.round(windowMs / 1_000);
  const spelled: Record<number, string> = { 9: 'nine', 15: 'fifteen', 30: 'thirty' };
  return `Undo is available for ${spelled[seconds] ?? String(seconds)} seconds.`;
}

function managerOfferSentence(offer: PresentedManagerUndoOffer): string {
  if (parsedDeadline(offer.absoluteDeadline) !== null) {
    return `Undo for up to ${Math.round(offer.durationMs / 1_000)} seconds, before ${offer.absoluteDeadline}.`;
  }
  return undoWindowSentence(offer.durationMs);
}

function UndoBarView({ engine }: { engine: UndoEngine }) {
  const { snapshot } = engine;
  const { offer } = snapshot;
  const barRef = useRef<HTMLDivElement>(null);
  const undoRef = useRef<HTMLButtonElement>(null);
  const closeFocusOrigin = useRef<HTMLElement | null>(null);
  const previousRestoreVersion = useRef(snapshot.restoreVersion);

  const rememberCloseFocus = useCallback(() => {
    const active = document.activeElement;
    closeFocusOrigin.current = active instanceof HTMLElement && barRef.current?.contains(active)
      ? active
      : null;
  }, []);

  useLayoutEffect(() => {
    if (offer === null || snapshot.focusRequest !== offer.sequence) return;
    if (engine.claimUndoFocus(offer.sequence)) undoRef.current?.focus({ preventScroll: true });
  }, [engine, offer, snapshot.focusRequest]);

  useLayoutEffect(() => {
    if (previousRestoreVersion.current === snapshot.restoreVersion) return;
    previousRestoreVersion.current = snapshot.restoreVersion;
    const origin = closeFocusOrigin.current;
    closeFocusOrigin.current = null;
    if (origin === null) return;
    const active = document.activeElement;
    if (active !== origin && active !== document.body) return;
    engine.restoreClosedFocus();
  }, [engine, snapshot.restoreVersion]);

  const failure = snapshot.state === 'failed'
    ? UNDO_FAILED_MESSAGE
    : null;
  const statusCopy = offer
    ? `${offer.message} ${managerOfferSentence(offer)}`
    : snapshot.announcement;
  const statusPayloadKey = offer
    ? `offer-${offer.sequence}`
    : `announcement-${snapshot.restoreVersion}`;

  return <div className="album-undo" data-open={offer !== null}>
    <p
      className="sr-only"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      {/* Keep the live region mounted, but add a fresh payload for every offer so
          two equal human-readable messages are still announced as two events. */}
      <span key={statusPayloadKey}>{statusCopy}</span>
    </p>
    {offer && <div
      ref={barRef}
      className="album-undo__bar"
      onFocusCapture={() => {
        rememberCloseFocus();
        engine.hold('focus');
      }}
      onBlurCapture={(blur) => {
        if (!blur.currentTarget.contains(blur.relatedTarget as Node | null)) engine.release('focus');
      }}
      onPointerEnter={() => engine.hold('pointer')}
      onPointerLeave={() => engine.release('pointer')}
    >
      <span className="album-undo__message">{offer.message}</span>
      {failure && <small className="album-undo__error" role="alert">{failure}</small>}
      <button
        ref={undoRef}
        type="button"
        className="album-undo__action"
        disabled={snapshot.state === 'running'}
        onClick={() => {
          rememberCloseFocus();
          engine.run();
        }}
      >{snapshot.state === 'running' ? 'Undoing…' : 'Undo'}</button>
      <button
        type="button"
        className="album-undo__dismiss"
        aria-label="Dismiss"
        disabled={snapshot.state === 'running'}
        onClick={() => {
          rememberCloseFocus();
          engine.dismiss();
        }}
      >Dismiss</button>
    </div>}
  </div>;
}

export function ManagerUndoBar() {
  const engine = useManagerUndoEngine();
  return <UndoBarView engine={engine} />;
}

import type { EventCoverPreparationView } from '../../../shared/event-cover';
import { readCoverOperation, restartCoverOperation } from './cover-draft-client';

/**
 * What happens after `Done` is pressed.
 *
 * The rule this exists to enforce: once dispatch begins, the outcome is
 * ambiguous until the server says otherwise. It does not matter whether the
 * client saw `202`, `503`, a network error, or nothing at all — Cancel becomes
 * Close, closing only detaches polling, and nothing local may discard a draft
 * that an accepted receipt may still need.
 *
 * Framework-free on purpose, so the rule is testable without a sheet.
 */

export type CoverOperationPhase =
  | 'idle'
  | 'dispatching'
  | 'preparing'
  | 'applied'
  | 'conflict'
  | 'retryable-failed'
  | 'permanent-failed';

export interface CoverOperationState {
  phase: CoverOperationPhase;
  operationId: string | null;
  view: EventCoverPreparationView | null;
  /** True from the moment dispatch begins, whatever the client observed. */
  dispatched: boolean;
  /** The 60-second copy change. Never a failure, and never a step count. */
  slow: boolean;
}

export interface CoverOperationControllerOptions {
  eventId: string;
  /** Called once with a terminal result, so the canvas can rebase on it. */
  onSettled?(view: EventCoverPreparationView): void;
  now?(): number;
  schedule?(callback: () => void, delayMs: number): () => void;
  isHidden?(): boolean;
}

const POLL_STEPS = [2_000, 4_000, 8_000, 10_000];
const SLOW_AFTER_MS = 60_000;

const TERMINAL: Record<string, CoverOperationPhase> = {
  applied: 'applied',
  conflict: 'conflict',
  'permanent-failed': 'permanent-failed',
};

function defaultSchedule(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
}

export function createCoverOperationController(options: CoverOperationControllerOptions) {
  const schedule = options.schedule ?? defaultSchedule;
  const now = options.now ?? (() => Date.now());
  const isHidden = options.isHidden
    ?? (() => typeof document !== 'undefined' && document.visibilityState === 'hidden');

  let state: CoverOperationState = {
    phase: 'idle',
    operationId: null,
    view: null,
    dispatched: false,
    slow: false,
  };
  const listeners = new Set<(next: CoverOperationState) => void>();
  let cancelPoll: (() => void) | null = null;
  let attached = false;
  let attempt = 0;
  let dispatchedAt = 0;

  function emit(patch: Partial<CoverOperationState>) {
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state);
  }

  function phaseFor(view: EventCoverPreparationView): CoverOperationPhase {
    if (view.status === 'preparing') return 'preparing';
    if (view.status === 'retryable-failed') {
      return view.retryable ? 'retryable-failed' : 'permanent-failed';
    }
    return TERMINAL[view.status] ?? 'preparing';
  }

  function adopt(view: EventCoverPreparationView) {
    const phase = phaseFor(view);
    emit({ view, phase, slow: phase === 'preparing' && now() - dispatchedAt >= SLOW_AFTER_MS });
    if (phase !== 'preparing') {
      stopPolling();
      options.onSettled?.(view);
    }
  }

  function stopPolling() {
    cancelPoll?.();
    cancelPoll = null;
  }

  function queueNext(delayMs?: number) {
    if (!attached || !state.operationId || state.phase !== 'preparing') return;
    const wait = delayMs ?? POLL_STEPS[Math.min(attempt, POLL_STEPS.length - 1)]!;
    attempt += 1;
    cancelPoll = schedule(() => { void tick(); }, wait);
  }

  async function tick() {
    if (!attached || !state.operationId) return;
    // Paused while the document is hidden, resumed by `attach()` on visibility.
    if (isHidden()) {
      queueNext(POLL_STEPS[POLL_STEPS.length - 1]);
      return;
    }
    if (state.phase === 'preparing' && now() - dispatchedAt >= SLOW_AFTER_MS && !state.slow) {
      emit({ slow: true });
    }
    try {
      const view = await readCoverOperation(options.eventId, state.operationId);
      if (view) adopt(view);
    } catch {
      // A lost poll is not a failure and never becomes one. Elapsed time alone
      // never turns into a terminal result.
    }
    queueNext();
  }

  return {
    getState: () => state,

    subscribe(listener: (next: CoverOperationState) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /**
     * Marks the operation dispatched *before* the request is made.
     *
     * This is the whole point: a client that never sees a response has still
     * dispatched, and must not be allowed to discard the draft behind it.
     */
    beginDispatch(operationId: string) {
      dispatchedAt = now();
      attempt = 0;
      emit({ phase: 'dispatching', operationId, dispatched: true, slow: false, view: null });
    },

    /** Whatever came back — `202`, `503`, or nothing — polling takes over. */
    dispatchSettled(view: EventCoverPreparationView | null) {
      if (view) adopt(view);
      else emit({ phase: 'preparing' });
      queueNext(POLL_STEPS[0]);
    },

    attach() {
      attached = true;
      if (state.phase === 'preparing' || state.phase === 'dispatching') {
        attempt = 0;
        stopPolling();
        queueNext(0);
      }
    },

    /** Closing the sheet detaches polling. It cancels and discards nothing. */
    detach() {
      attached = false;
      stopPolling();
    },

    /** Only for a receipt the server itself called retryable. */
    async retry(): Promise<void> {
      if (!state.operationId || state.phase !== 'retryable-failed') return;
      const view = await restartCoverOperation(options.eventId, state.operationId);
      dispatchedAt = now();
      attempt = 0;
      if (view) adopt(view);
      else emit({ phase: 'preparing', slow: false });
      queueNext(POLL_STEPS[0]);
    },

    /**
     * Whether a draft may still be discarded locally.
     *
     * False from dispatch onward, and true again only once the server has
     * confirmed a terminal, non-retryable outcome that released the draft.
     */
    canDiscardDraft(): boolean {
      if (!state.dispatched) return true;
      return state.phase === 'conflict' || state.phase === 'permanent-failed';
    },
  };
}

export type CoverOperationController = ReturnType<typeof createCoverOperationController>;

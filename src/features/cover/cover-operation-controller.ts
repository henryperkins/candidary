import type { EventCoverPreparationView } from '../../../shared/event-cover';
import {
  coverOperationReceiptPath,
  readCoverOperation,
  restartCoverOperation,
  type CoverOperationAnswer,
} from './cover-draft-client';

/**
 * Framework-free ownership of one accepted cover publication.
 *
 * Dispatch is ambiguous from the instant the request is sent. The controller
 * therefore keeps the receipt alive through lost responses and Studio closes;
 * only a server terminal answer can release it.
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
  answer: CoverOperationAnswer | null;
  receiptPath: string | null;
  retryAfterMs: number | null;
  /** True from the moment a publication may have reached the server. */
  dispatched: boolean;
  /** Copy-only threshold; elapsed time never manufactures a failure. */
  slow: boolean;
}

export interface CoverOperationControllerOptions {
  eventId: string;
  onAnswer?(answer: CoverOperationAnswer): void;
  onSettled?(answer: CoverOperationAnswer): void;
  onReadError?(error: unknown): void;
  now?(): number;
  schedule?(callback: () => void, delayMs: number): () => void;
  isHidden?(): boolean;
}

const POLL_STEPS = [2_000, 4_000, 8_000, 10_000] as const;
const SLOW_AFTER_MS = 60_000;

const TERMINAL_PHASE: Partial<Record<EventCoverPreparationView['status'], CoverOperationPhase>> = {
  applied: 'applied',
  conflict: 'conflict',
  'permanent-failed': 'permanent-failed',
};

function defaultSchedule(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
}

function phaseFor(view: EventCoverPreparationView): CoverOperationPhase {
  if (view.status === 'preparing') return 'preparing';
  if (view.status === 'retryable-failed') {
    return view.retryable ? 'retryable-failed' : 'permanent-failed';
  }
  return TERMINAL_PHASE[view.status] ?? 'preparing';
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
    answer: null,
    receiptPath: null,
    retryAfterMs: null,
    dispatched: false,
    slow: false,
  };
  const listeners = new Set<(next: CoverOperationState) => void>();
  let cancelPoll: (() => void) | null = null;
  let attachmentCount = 0;
  let attempt = 0;
  let dispatchedAt = 0;
  let settledKey: string | null = null;
  let suspended = false;

  function emit(patch: Partial<CoverOperationState>) {
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state);
  }

  function stopPolling() {
    cancelPoll?.();
    cancelPoll = null;
  }

  function isPollingPhase(): boolean {
    return state.phase === 'preparing' || state.phase === 'dispatching';
  }

  function queueNext(localDelay?: number) {
    if (suspended || attachmentCount === 0 || !state.operationId || !isPollingPhase()) return;
    stopPolling();
    const cadence = localDelay ?? POLL_STEPS[Math.min(attempt, POLL_STEPS.length - 1)]!;
    const wait = Math.max(cadence, state.retryAfterMs ?? 0);
    attempt += 1;
    cancelPoll = schedule(() => { void tick(); }, wait);
  }

  function adopt(answer: CoverOperationAnswer) {
    if (state.operationId && answer.operation.operationId !== state.operationId) return;
    const phase = phaseFor(answer.operation);
    const slow = phase === 'preparing' && now() - dispatchedAt >= SLOW_AFTER_MS;
    emit({
      phase,
      operationId: answer.operation.operationId,
      view: answer.operation,
      answer,
      receiptPath: answer.receiptPath,
      retryAfterMs: answer.retryAfterMs,
      dispatched: true,
      slow,
    });
    options.onAnswer?.(answer);
    if (phase !== 'preparing') stopPolling();
    if (phase === 'applied' || phase === 'conflict' || phase === 'permanent-failed') {
      const key = `${answer.operation.operationId}:${phase}`;
      if (settledKey !== key) {
        settledKey = key;
        options.onSettled?.(answer);
      }
    }
  }

  async function tick() {
    if (suspended || attachmentCount === 0 || !state.operationId || !isPollingPhase()) return;
    if (isHidden()) {
      queueNext(POLL_STEPS[POLL_STEPS.length - 1]);
      return;
    }
    if (now() - dispatchedAt >= SLOW_AFTER_MS && !state.slow) emit({ slow: true });
    try {
      const answer = await readCoverOperation(options.eventId, state.operationId);
      if (answer) adopt(answer);
    } catch (error) {
      // A lost read leaves the durable receipt authoritative and retryable.
      options.onReadError?.(error);
    }
    queueNext();
  }

  function wake() {
    if (suspended || attachmentCount === 0 || !isPollingPhase()) return;
    attempt = 0;
    stopPolling();
    // Recovery is allowed an immediate read; subsequent reads obey cadence and
    // any server Retry-After value.
    cancelPoll = schedule(() => { void tick(); }, 0);
  }

  function addRecoveryListeners() {
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', wake);
    if (typeof window !== 'undefined') window.addEventListener('online', wake);
  }

  function removeRecoveryListeners() {
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', wake);
    if (typeof window !== 'undefined') window.removeEventListener('online', wake);
  }

  return {
    getState: () => state,

    subscribe(listener: (next: CoverOperationState) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Marks ambiguity before the publication request is made. */
    beginDispatch(operationId: string) {
      suspended = false;
      dispatchedAt = now();
      attempt = 0;
      settledKey = null;
      emit({
        phase: 'dispatching',
        operationId,
        view: null,
        answer: null,
        receiptPath: coverOperationReceiptPath(options.eventId, operationId),
        retryAfterMs: null,
        dispatched: true,
        slow: false,
      });
    },

    /** Seeds the server-selected receipt after a Manager event read or reload. */
    resume(operationId: string, view?: EventCoverPreparationView | null) {
      suspended = false;
      dispatchedAt = now();
      attempt = 0;
      settledKey = null;
      if (view) {
        adopt({
          status: 200,
          operation: view,
          receiptPath: coverOperationReceiptPath(options.eventId, operationId),
          retryAfterMs: null,
        });
      } else {
        emit({
          phase: 'preparing',
          operationId,
          view: null,
          answer: null,
          receiptPath: coverOperationReceiptPath(options.eventId, operationId),
          retryAfterMs: null,
          dispatched: true,
          slow: false,
        });
      }
      queueNext(POLL_STEPS[0]);
    },

    /** Whatever came back—typed envelope or nothing—reconciliation owns next. */
    dispatchSettled(answer: CoverOperationAnswer | null) {
      suspended = false;
      if (answer) adopt(answer);
      else emit({ phase: 'preparing' });
      queueNext(POLL_STEPS[0]);
    },

    /** Only valid when access failed before the publication request was sent. */
    dispatchRejectedBeforeAcceptance() {
      stopPolling();
      attempt = 0;
      settledKey = null;
      emit({
        phase: 'idle',
        operationId: null,
        view: null,
        answer: null,
        receiptPath: null,
        retryAfterMs: null,
        dispatched: false,
        slow: false,
      });
    },

    attach() {
      attachmentCount += 1;
      if (attachmentCount !== 1) return;
      addRecoveryListeners();
      if (isPollingPhase()) wake();
    },

    /** Reference-counted so closing Studio cannot detach Manager ownership. */
    detach() {
      attachmentCount = Math.max(0, attachmentCount - 1);
      if (attachmentCount !== 0) return;
      stopPolling();
      removeRecoveryListeners();
    },

    /** Sends only the existing receipt ID and adopts its complete answer. */
    async retry(): Promise<void> {
      if (!state.operationId || state.phase !== 'retryable-failed') return;
      suspended = false;
      dispatchedAt = now();
      attempt = 0;
      const answer = await restartCoverOperation(options.eventId, state.operationId);
      if (answer) adopt(answer);
      else emit({ phase: 'preparing', slow: false });
      queueNext(POLL_STEPS[0]);
    },

    wake,

    /** Stops authorization-dependent reads while preserving the receipt. */
    suspend() {
      suspended = true;
      stopPolling();
    },

    /** Restarts the same receipt only after Manager access is confirmed. */
    resumePolling() {
      suspended = false;
      wake();
    },

    canDiscardDraft(): boolean {
      if (!state.dispatched) return true;
      return state.phase === 'conflict' || state.phase === 'permanent-failed';
    },
  };
}

export type CoverOperationController = ReturnType<typeof createCoverOperationController>;

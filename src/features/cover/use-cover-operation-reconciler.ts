import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { EventCoverPreparationView } from '../../../shared/event-cover';
import type { EventView } from '../../../shared/contracts';
import { ClientApiError } from '../../app/api';
import {
  forgetCoverOperation,
  persistCoverOperation,
  readPersistedCoverOperation,
  type CoverOperationAnswer,
} from './cover-draft-client';
import {
  createCoverOperationController,
  type CoverOperationController,
  type CoverOperationState,
} from './cover-operation-controller';

export interface CoverAccessFailure {
  phase: 'before_dispatch' | 'after_dispatch';
  error: unknown;
}

export interface UseCoverOperationReconcilerOptions {
  eventId: string;
  preparation: EventCoverPreparationView | null;
  /** The Manager owner merges this event through `mergeCoverResponse`. */
  onCoverEvent(event: EventView): void;
  /** A Manager access-guarded whole-event read; may return its adopted event. */
  onFreshEventRequired(): Promise<EventView | null | void>;
}

export interface CoverOperationReconciler {
  controller: CoverOperationController;
  operation: EventCoverPreparationView | null;
  operationState: CoverOperationState;
  accessFailure: CoverAccessFailure | null;
  beginDispatch(operationId: string): void;
  dispatchSettled(answer: CoverOperationAnswer | null): void;
  dispatchFailed(error: unknown): void;
  rejectBeforeDispatch(error: unknown): void;
  retry(): Promise<void>;
  recoverAccess(): Promise<void>;
}

const ACCESS_FAILURE_CODES = new Set([
  'SESSION_REQUIRED',
  'SESSION_EXPIRED',
  'HOST_SESSION_REQUIRED',
  'ACCOUNT_DISABLED',
  'ROLE_FORBIDDEN',
  'RESOURCE_FORBIDDEN',
  'CSRF_INVALID',
  'ORIGIN_FORBIDDEN',
]);

function isAccessFailure(error: unknown): boolean {
  return error instanceof ClientApiError && ACCESS_FAILURE_CODES.has(error.code);
}

function isClearableTerminal(view: EventCoverPreparationView): boolean {
  return view.status === 'applied'
    || view.status === 'conflict'
    || view.status === 'permanent-failed'
    || (view.status === 'retryable-failed' && !view.retryable);
}

/**
 * One Manager-level owner for one event receipt.
 *
 * The Studio consumes this object but cannot detach its baseline attachment;
 * closing the sheet therefore leaves reconciliation running.
 */
export function useCoverOperationReconciler(
  options: UseCoverOperationReconcilerOptions,
): CoverOperationReconciler {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const settleRef = useRef<(answer: CoverOperationAnswer) => void>(() => undefined);
  const readErrorRef = useRef<(error: unknown) => void>(() => undefined);

  const controller = useMemo(() => createCoverOperationController({
    eventId: options.eventId,
    onSettled: (answer) => settleRef.current(answer),
    onReadError: (error) => readErrorRef.current(error),
  }), [options.eventId]);
  const [operationState, setOperationState] = useState<CoverOperationState>(controller.getState());
  const [accessFailure, setAccessFailure] = useState<CoverAccessFailure | null>(null);
  const seededRef = useRef<string | null>(null);
  const handoffRef = useRef(new Map<string, Promise<void>>());
  const completedOperationRef = useRef(new Set<string>());
  const recoveryRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    setOperationState(controller.getState());
    const unsubscribe = controller.subscribe(setOperationState);
    // This attachment belongs to the Manager page, not to the sheet.
    controller.attach();
    return () => {
      unsubscribe();
      controller.detach();
    };
  }, [controller]);

  const handoffTerminal = useCallback((answer: CoverOperationAnswer) => {
    if (!isClearableTerminal(answer.operation)) return;
    const key = [
      answer.operation.operationId,
      answer.operation.status,
      answer.operation.updatedAt,
    ].join(':');
    if (handoffRef.current.has(key)) return;

    const handoff = (async () => {
      try {
        if (answer.event) {
          optionsRef.current.onCoverEvent(answer.event);
        } else {
          const fresh = await optionsRef.current.onFreshEventRequired();
          if (fresh) optionsRef.current.onCoverEvent(fresh);
        }
        // The operation ID is reusable only after the event handoff succeeds.
        completedOperationRef.current.add(answer.operation.operationId);
        forgetCoverOperation(optionsRef.current.eventId);
        setAccessFailure(null);
      } catch (error) {
        handoffRef.current.delete(key);
        if (isAccessFailure(error)) setAccessFailure({ phase: 'after_dispatch', error });
      }
    })();
    handoffRef.current.set(key, handoff);
  }, []);
  settleRef.current = handoffTerminal;
  readErrorRef.current = (error) => {
    if (isAccessFailure(error)) {
      controller.suspend();
      setAccessFailure({ phase: 'after_dispatch', error });
    }
  };

  // The Manager projection outranks browser storage. With no projected receipt,
  // storage still resumes an accepted response the browser may have lost.
  useEffect(() => {
    const projected = options.preparation;
    if (projected && isClearableTerminal(projected)
      && completedOperationRef.current.has(projected.operationId)) {
      forgetCoverOperation(options.eventId);
      return;
    }
    const operationId = projected?.operationId ?? readPersistedCoverOperation(options.eventId);
    if (!operationId) return;
    const signature = projected
      ? `${options.eventId}:${operationId}:${projected.status}:${projected.completedSteps}:${projected.updatedAt}`
      : `${options.eventId}:${operationId}:persisted`;
    if (seededRef.current === signature) return;
    seededRef.current = signature;
    persistCoverOperation(options.eventId, operationId);
    controller.resume(operationId, projected);
    if (projected) setAccessFailure(null);
  }, [controller, options.eventId, options.preparation]);

  const beginDispatch = useCallback((operationId: string) => {
    // Persistence precedes the request that might be accepted without an
    // observable response.
    persistCoverOperation(optionsRef.current.eventId, operationId);
    setAccessFailure(null);
    controller.beginDispatch(operationId);
  }, [controller]);

  const dispatchSettled = useCallback((answer: CoverOperationAnswer | null) => {
    controller.dispatchSettled(answer);
  }, [controller]);

  const dispatchFailed = useCallback((error: unknown) => {
    controller.dispatchSettled(null);
    if (isAccessFailure(error)) {
      controller.suspend();
      setAccessFailure({ phase: 'after_dispatch', error });
    }
  }, [controller]);

  const rejectBeforeDispatch = useCallback((error: unknown) => {
    controller.dispatchRejectedBeforeAcceptance();
    forgetCoverOperation(optionsRef.current.eventId);
    setAccessFailure({ phase: 'before_dispatch', error });
  }, [controller]);

  const retry = useCallback(async () => {
    try {
      await controller.retry();
      setAccessFailure(null);
    } catch (error) {
      if (isAccessFailure(error)) {
        controller.suspend();
        setAccessFailure({ phase: 'after_dispatch', error });
      }
      throw error;
    }
  }, [controller]);

  const recoverAccess = useCallback(async () => {
    if (recoveryRef.current) return recoveryRef.current;
    const recovery = (async () => {
      try {
        const fresh = await optionsRef.current.onFreshEventRequired();
        if (fresh) optionsRef.current.onCoverEvent(fresh);
        const selected = fresh?.cover.preparation;
        const operationId = selected?.operationId
          ?? operationState.operationId
          ?? readPersistedCoverOperation(optionsRef.current.eventId);
        if (operationId) {
          persistCoverOperation(optionsRef.current.eventId, operationId);
          controller.resume(operationId, selected ?? null);
        }
        setAccessFailure(null);
        controller.resumePolling();
      } finally {
        recoveryRef.current = null;
      }
    })();
    recoveryRef.current = recovery;
    return recovery;
  }, [controller, operationState.operationId]);

  useEffect(() => {
    if (!accessFailure) return;
    const recoverWhenAvailable = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void recoverAccess().catch(() => undefined);
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', recoverWhenAvailable);
    }
    if (typeof window !== 'undefined') window.addEventListener('online', recoverWhenAvailable);
    return () => {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', recoverWhenAvailable);
      }
      if (typeof window !== 'undefined') window.removeEventListener('online', recoverWhenAvailable);
    };
  }, [accessFailure, recoverAccess]);

  return {
    controller,
    operation: operationState.view,
    operationState,
    accessFailure,
    beginDispatch,
    dispatchSettled,
    dispatchFailed,
    rejectBeforeDispatch,
    retry,
    recoverAccess,
  };
}

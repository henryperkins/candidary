import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ClientApiError } from '../../app/api';
import { describeLoadFailure, type LoadFailure } from '../../components/States';
import {
  createBrowserTransport,
  type BrowserUploadTransport,
} from './browser-upload-transport';
import type { UploadFlowSession } from './GuestUploadFlow';
import {
  createManagerUploadCleanup,
  type CleanupItem,
  type CleanupOutcome,
  type ReservationDisposition,
} from './manager-upload-cleanup';
import { managerUploadTerminalReason } from './manager-upload-terminal-codes';
import { createUploadSelection } from './upload-selection';
import {
  getReceiptCount,
  removeQueueItem,
  runUploadQueue,
  type ReservationResult,
  type UploadQueueItem,
  type UploadReservation,
  type UploadTransport,
} from './upload-queue';

export interface UploadExitState {
  ownsBlock: boolean;
  warnBeforeUnload: boolean;
}

export type ManagerUploadPhase =
  | 'selecting'
  | 'sending'
  | 'needs-attention'
  | 'cleanup'
  | 'cleanup-retry'
  | 'receipt'
  | 'terminal';

export interface UseManagerUploadSessionOptions {
  eventId: string;
  uploadsAvailable: boolean;
  transport?: BrowserUploadTransport;
  hasUsableAccountCredential: boolean;
  onExitGateChange(state: UploadExitState): void;
  onEscalate(failure: LoadFailure): void;
  onFinalized?: (result: { itemId: string; mediaId: string }) => void;
  onRefreshAfterTerminal?: () => void;
  onSafeClose?: () => void;
}

export interface ManagerUploadSession {
  flow: UploadFlowSession;
  phase: ManagerUploadPhase;
  cleanupOutcome: CleanupOutcome | null;
  closeAllowed: boolean;
  discardSelection(): void;
  cancelUploads(): Promise<CleanupOutcome>;
  retryCleanup(): Promise<CleanupOutcome>;
}

function placeholderReservation(item: UploadQueueItem, mediaId: string): UploadReservation {
  return { mediaId, uploadUrl: '', mimeType: item.file.type };
}

function unresolvedCount(items: Iterable<CleanupItem>): number {
  let count = 0;
  for (const item of items) {
    if (item.disposition === 'ambiguous' || item.disposition === 'reserved') count += 1;
  }
  return count;
}

function failureForTerminal(
  item: UploadQueueItem | null,
  reason: Extract<CleanupOutcome, { kind: 'terminal' }>['reason'],
): LoadFailure {
  const message = item?.error ?? (reason === 'lifecycle'
    ? 'This event is no longer available.'
    : 'Manager access changed while the photos were being added.');
  const code = item?.failure?.code ?? (reason === 'lifecycle' ? 'EVENT_EXPIRED' : 'TOKEN_REVOKED');
  const described = describeLoadFailure(
    new ClientApiError(code, message, undefined, undefined, item?.failure?.status),
    'manager',
    message,
  );
  if (reason !== 'authorization' || described.kind !== 'retry') return described;
  // RESOURCE_FORBIDDEN is globally retryable because most call sites use it for
  // ordinary ownership conflicts. The upload actor's local terminal table has
  // already proved this instance is dead, so route it to the existing recovery.
  return {
    kind: 'latest-link',
    message,
    recoveryHint: 'Open the latest management link you saved to start again.',
    retryable: false,
    offerSignIn: true,
  };
}

export function useManagerUploadSession({
  eventId,
  uploadsAvailable,
  transport,
  hasUsableAccountCredential,
  onExitGateChange,
  onEscalate,
  onFinalized,
  onRefreshAfterTerminal,
  onSafeClose,
}: UseManagerUploadSessionOptions): ManagerUploadSession {
  const activeTransport = useMemo(
    () => transport ?? createBrowserTransport({ kind: 'manager', eventId }),
    [eventId, transport],
  );
  const [items, setItems] = useState<UploadQueueItem[]>([]);
  const [sending, setSending] = useState(false);
  const [phase, setPhase] = useState<ManagerUploadPhase>('selecting');
  const [cleanupOutcome, setCleanupOutcome] = useState<CleanupOutcome | null>(null);
  const itemsRef = useRef(items);
  const phaseRef = useRef(phase);
  const availableRef = useRef(uploadsAvailable);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const queuePromiseRef = useRef<Promise<UploadQueueItem[]> | null>(null);
  const cleanupPromiseRef = useRef<Promise<CleanupOutcome> | null>(null);
  const cleanupItemsRef = useRef(new Map<string, CleanupItem>());
  const objectUrlsRef = useRef(new Set<string>());
  const terminalItemRef = useRef<UploadQueueItem | null>(null);
  const terminalRetirementRef = useRef(false);
  const finalizedItemsRef = useRef(new Set<string>());
  const lastExitStateRef = useRef<UploadExitState | null>(null);
  const callbacksRef = useRef({
    hasUsableAccountCredential,
    onExitGateChange,
    onEscalate,
    onFinalized,
    onRefreshAfterTerminal,
    onSafeClose,
  });
  availableRef.current = uploadsAvailable;
  callbacksRef.current = {
    hasUsableAccountCredential,
    onExitGateChange,
    onEscalate,
    onFinalized,
    onRefreshAfterTerminal,
    onSafeClose,
  };

  const publish = useCallback((next: UploadQueueItem[]) => {
    itemsRef.current = next;
    if (mountedRef.current) setItems(next);
  }, []);

  const publishPhase = useCallback((next: ManagerUploadPhase) => {
    phaseRef.current = next;
    if (mountedRef.current) setPhase(next);
  }, []);

  const emitExitGate = useCallback((next: UploadExitState, force = false) => {
    const previous = lastExitStateRef.current;
    if (!force
      && previous?.ownsBlock === next.ownsBlock
      && previous.warnBeforeUnload === next.warnBeforeUnload) return;
    lastExitStateRef.current = next;
    callbacksRef.current.onExitGateChange(next);
  }, []);

  const revokePreviews = useCallback(() => {
    objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    objectUrlsRef.current.clear();
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      emitExitGate({ ownsBlock: false, warnBeforeUnload: false }, true);
      mountedRef.current = false;
      generationRef.current += 1;
      controllerRef.current?.abort();
      controllerRef.current = null;
      revokePreviews();
    };
  }, [emitExitGate, revokePreviews]);

  const ownsBlock = phase === 'sending'
    || phase === 'needs-attention'
    || phase === 'cleanup'
    || phase === 'cleanup-retry';
  useEffect(() => {
    emitExitGate({ ownsBlock, warnBeforeUnload: ownsBlock });
  }, [emitExitGate, ownsBlock]);

  const syncCleanupSnapshot = useCallback((next: readonly UploadQueueItem[]) => {
    for (const queueItem of next) {
      const previous = cleanupItemsRef.current.get(queueItem.id);
      let disposition: ReservationDisposition = previous?.disposition ?? 'unattempted';
      const reservation = queueItem.reservation ?? previous?.reservation ?? null;
      if (queueItem.validationError) disposition = 'known-absent';
      else if (queueItem.state === 'delivered') disposition = 'delivered';
      else if (queueItem.reservation) disposition = 'reserved';
      else if (queueItem.state === 'reserving'
        && !['known-absent', 'canceled', 'delivered', 'reserved'].includes(disposition)) {
        // A whole batch result is recorded before runUploadQueue emits each item's
        // state in turn. Do not let another item's intermediate snapshot erase a
        // disposition the server has already made authoritative.
        disposition = 'ambiguous';
      }
      cleanupItemsRef.current.set(queueItem.id, {
        itemId: queueItem.id,
        idempotencyKey: queueItem.id,
        queueItem,
        reservation,
        disposition,
      });
    }
  }, []);

  const applyReservationResult = useCallback((
    queueItem: UploadQueueItem,
    result: ReservationResult,
  ) => {
    let disposition: ReservationDisposition;
    let reservation: UploadReservation | null;
    if (result.status === 'accepted') {
      disposition = 'reserved';
      reservation = result.reservation;
    } else if (result.status === 'delivered') {
      disposition = 'delivered';
      reservation = placeholderReservation(queueItem, result.mediaId);
    } else if (result.status === 'canceled') {
      disposition = 'canceled';
      reservation = null;
    } else {
      disposition = 'known-absent';
      reservation = null;
    }
    cleanupItemsRef.current.set(queueItem.id, {
      itemId: queueItem.id,
      idempotencyKey: queueItem.id,
      queueItem,
      reservation,
      disposition,
    });
  }, []);

  const settleCleanup = useCallback(async (): Promise<CleanupOutcome> => {
    if (cleanupPromiseRef.current) return cleanupPromiseRef.current;
    const task = (async (): Promise<CleanupOutcome> => {
      publishPhase('cleanup');
      const queue = queuePromiseRef.current;
      generationRef.current += 1;
      controllerRef.current?.abort();
      await queue?.catch(() => undefined);
      if (!mountedRef.current) return { kind: 'retry', unresolvedCount: 0, deliveredIds: [] };
      setSending(false);

      const cleanupGeneration = generationRef.current;
      const cleanupController = new AbortController();
      controllerRef.current = cleanupController;
      const cleanup = createManagerUploadCleanup({
        reserve: async (item) => {
          const results = await activeTransport.reserve([item.queueItem], cleanupController.signal);
          const result = results.find(({ id }) => id === item.idempotencyKey);
          return result ?? {
            id: item.idempotencyKey,
            status: 'rejected',
            error: 'This temporary upload could not be found.',
          };
        },
        cancel: async (item, reservation) => {
          if (!activeTransport.cancelReservation) {
            throw new Error('This upload transport cannot clean up reservations.');
          }
          await activeTransport.cancelReservation(item.queueItem, reservation, cleanupController.signal);
        },
      });
      const outcome = await cleanup.run(
        [...cleanupItemsRef.current.values()],
        cleanupController.signal,
      );
      if (!mountedRef.current || cleanupGeneration !== generationRef.current) return outcome;
      controllerRef.current = null;
      setCleanupOutcome(outcome);

      if (outcome.kind === 'retry') {
        publishPhase('cleanup-retry');
        return outcome;
      }
      if (outcome.kind === 'terminal') {
        publishPhase('terminal');
        if (outcome.reason === 'authorization'
          && callbacksRef.current.hasUsableAccountCredential) {
          callbacksRef.current.onRefreshAfterTerminal?.();
        } else {
          callbacksRef.current.onEscalate(failureForTerminal(
            terminalItemRef.current,
            outcome.reason,
          ));
          emitExitGate({ ownsBlock: false, warnBeforeUnload: false });
          callbacksRef.current.onSafeClose?.();
        }
        return outcome;
      }

      revokePreviews();
      cleanupItemsRef.current.clear();
      finalizedItemsRef.current.clear();
      terminalItemRef.current = null;
      publish([]);
      publishPhase('selecting');
      emitExitGate({ ownsBlock: false, warnBeforeUnload: false });
      callbacksRef.current.onSafeClose?.();
      return outcome;
    })();
    cleanupPromiseRef.current = task;
    try {
      return await task;
    } finally {
      if (cleanupPromiseRef.current === task) cleanupPromiseRef.current = null;
    }
  }, [activeTransport, emitExitGate, publish, publishPhase, revokePreviews]);

  const adoptFiles = useCallback((files: FileList | null, isNewCapture: boolean) => {
    if (!files?.length || !availableRef.current || ownsBlock) return;
    const selected = createUploadSelection(files, isNewCapture);
    for (const queueItem of selected) {
      if (queueItem.previewUrl) objectUrlsRef.current.add(queueItem.previewUrl);
      cleanupItemsRef.current.set(queueItem.id, {
        itemId: queueItem.id,
        idempotencyKey: queueItem.id,
        queueItem,
        reservation: null,
        disposition: queueItem.validationError ? 'known-absent' : 'unattempted',
      });
    }
    setCleanupOutcome(null);
    publish([...itemsRef.current, ...selected]);
  }, [ownsBlock, publish]);

  const canRemoveItem = useCallback((itemId: string) => {
    const cleanupItem = cleanupItemsRef.current.get(itemId);
    const target = itemsRef.current.find((item) => item.id === itemId);
    if (!target || (target.state !== 'selected' && target.state !== 'failed')) return false;
    return !cleanupItem
      || cleanupItem.disposition === 'unattempted'
      || cleanupItem.disposition === 'known-absent';
  }, []);

  const removeItem = useCallback((itemId: string) => {
    if (!canRemoveItem(itemId)) return;
    const target = itemsRef.current.find((item) => item.id === itemId);
    if (target?.previewUrl) {
      URL.revokeObjectURL(target.previewUrl);
      objectUrlsRef.current.delete(target.previewUrl);
    }
    cleanupItemsRef.current.delete(itemId);
    const next = removeQueueItem(itemsRef.current, itemId);
    publish(next);
    if ((getReceiptCount(next) ?? 0) > 0) publishPhase('receipt');
  }, [canRemoveItem, publish, publishPhase]);

  const send = useCallback(async () => {
    if (!availableRef.current || queuePromiseRef.current || cleanupPromiseRef.current) return;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    terminalRetirementRef.current = false;
    terminalItemRef.current = null;
    setCleanupOutcome(null);
    publishPhase('sending');
    setSending(true);
    const controller = new AbortController();
    controllerRef.current = controller;

    const queueTransport: UploadTransport = {
      reserve: async (chunk, signal) => {
        for (const queueItem of chunk) {
          const previous = cleanupItemsRef.current.get(queueItem.id);
          cleanupItemsRef.current.set(queueItem.id, {
            itemId: queueItem.id,
            idempotencyKey: queueItem.id,
            queueItem,
            reservation: previous?.reservation ?? null,
            disposition: 'ambiguous',
          });
        }
        const results = await activeTransport.reserve(chunk, signal);
        if (signal?.aborted || generation !== generationRef.current) return results;
        const byId = new Map(chunk.map((item) => [item.id, item]));
        for (const result of results) {
          const queueItem = byId.get(result.id);
          if (queueItem) applyReservationResult(queueItem, result);
        }
        return results;
      },
      upload: (item, reservation, progress, signal) => (
        activeTransport.upload(item, reservation, progress, signal)
      ),
      finalize: (item, reservation, signal) => (
        activeTransport.finalize(item, reservation, signal)
      ),
      retryUploadAfterFinalizeError: activeTransport.retryUploadAfterFinalizeError,
    };

    const request = runUploadQueue(itemsRef.current, queueTransport, {
      concurrency: 2,
      signal: controller.signal,
      onChange: (next) => {
        if (controller.signal.aborted || generation !== generationRef.current) return;
        syncCleanupSnapshot(next);
        publish(next);
        const terminalItem = next.find(({ failure }) => (
          failure ? managerUploadTerminalReason(failure.code) !== null : false
        ));
        if (!terminalItem || terminalRetirementRef.current) return;
        terminalRetirementRef.current = true;
        terminalItemRef.current = terminalItem;
        void settleCleanup();
      },
      onFinalized: ({ itemId, mediaId }) => {
        if (controller.signal.aborted || generation !== generationRef.current) return;
        const queueItem = itemsRef.current.find((item) => item.id === itemId);
        if (!queueItem) return;
        const previous = cleanupItemsRef.current.get(itemId);
        cleanupItemsRef.current.set(itemId, {
          itemId,
          idempotencyKey: itemId,
          queueItem,
          reservation: previous?.reservation ?? placeholderReservation(queueItem, mediaId),
          disposition: 'delivered',
        });
        if (finalizedItemsRef.current.has(itemId)) return;
        finalizedItemsRef.current.add(itemId);
        callbacksRef.current.onFinalized?.({ itemId, mediaId });
      },
    });
    queuePromiseRef.current = request;
    try {
      const result = await request;
      if (controller.signal.aborted || generation !== generationRef.current) return;
      syncCleanupSnapshot(result);
      publish(result);
      setSending(false);
      controllerRef.current = null;
      const receiptCount = getReceiptCount(result) ?? 0;
      if (receiptCount > 0) publishPhase('receipt');
      else if (unresolvedCount(cleanupItemsRef.current.values()) > 0) publishPhase('needs-attention');
      else publishPhase('selecting');
    } finally {
      if (queuePromiseRef.current === request) queuePromiseRef.current = null;
    }
  }, [
    activeTransport,
    applyReservationResult,
    publish,
    publishPhase,
    settleCleanup,
    syncCleanupSnapshot,
  ]);

  const discardSelection = useCallback(() => {
    if (ownsBlock) return;
    revokePreviews();
    cleanupItemsRef.current.clear();
    finalizedItemsRef.current.clear();
    terminalItemRef.current = null;
    setCleanupOutcome(null);
    publish([]);
    publishPhase('selecting');
  }, [ownsBlock, publish, publishPhase, revokePreviews]);

  const cancelUploads = useCallback(async (): Promise<CleanupOutcome> => {
    if (unresolvedCount(cleanupItemsRef.current.values()) === 0) {
      discardSelection();
      const outcome: CleanupOutcome = { kind: 'settled', deliveredIds: [] };
      emitExitGate({ ownsBlock: false, warnBeforeUnload: false });
      callbacksRef.current.onSafeClose?.();
      return outcome;
    }
    return settleCleanup();
  }, [discardSelection, emitExitGate, settleCleanup]);

  const cancelFlow = useCallback(async (): Promise<void> => {
    await cancelUploads();
  }, [cancelUploads]);
  const retryCleanup = useCallback(async (): Promise<CleanupOutcome> => settleCleanup(), [settleCleanup]);
  const receiptCount = getReceiptCount(items) ?? 0;
  const flow = useMemo<UploadFlowSession>(() => ({
    items,
    sending,
    receiptCount,
    adoptFiles,
    canRemoveItem,
    removeItem,
    send,
    cancel: cancelFlow,
  }), [adoptFiles, canRemoveItem, cancelFlow, items, receiptCount, removeItem, send, sending]);

  return useMemo(() => ({
    flow,
    phase,
    cleanupOutcome,
    closeAllowed: !ownsBlock,
    discardSelection,
    cancelUploads,
    retryCleanup,
  }), [
    cancelUploads,
    cleanupOutcome,
    discardSelection,
    flow,
    ownsBlock,
    phase,
    retryCleanup,
  ]);
}

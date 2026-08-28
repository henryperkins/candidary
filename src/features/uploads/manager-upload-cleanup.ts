import { ClientApiError } from '../../app/api';
import {
  managerUploadTerminalReason,
  type ManagerUploadTerminalReason,
} from './manager-upload-terminal-codes';
import type {
  ReservationResult,
  UploadFailure,
  UploadQueueItem,
  UploadReservation,
} from './upload-queue';

export type ReservationDisposition =
  | 'unattempted'
  | 'known-absent'
  | 'ambiguous'
  | 'reserved'
  | 'delivered'
  | 'canceled';

export interface CleanupItem {
  itemId: string;
  idempotencyKey: string;
  queueItem: UploadQueueItem;
  reservation: UploadReservation | null;
  disposition: ReservationDisposition;
}

export type CleanupOutcome =
  | { kind: 'settled'; deliveredIds: string[] }
  | { kind: 'retry'; unresolvedCount: number; deliveredIds: string[] }
  | {
      kind: 'terminal';
      reason: ManagerUploadTerminalReason;
      unresolvedCount: number;
      deliveredIds: string[];
    };

export interface CleanupDeps {
  reserve(item: CleanupItem): Promise<ReservationResult>;
  cancel(item: CleanupItem, reservation: UploadReservation): Promise<void>;
}

type ItemOutcome =
  | { kind: 'settled'; deliveredId?: string }
  | { kind: 'retry' }
  | { kind: 'terminal'; reason: ManagerUploadTerminalReason };

function terminalFailureReason(failure: UploadFailure | undefined) {
  return failure ? managerUploadTerminalReason(failure.code) : null;
}

function terminalErrorReason(error: unknown) {
  return error instanceof ClientApiError ? managerUploadTerminalReason(error.code) : null;
}

function terminalResultReason(result: ReservationResult) {
  return result.status === 'rejected' ? terminalFailureReason(result.failure) : null;
}

export function createManagerUploadCleanup(deps: CleanupDeps): {
  run(items: readonly CleanupItem[], signal?: AbortSignal): Promise<CleanupOutcome>;
} {
  async function cancelOnce(
    item: CleanupItem,
    reservation: UploadReservation,
    signal?: AbortSignal,
  ): Promise<ItemOutcome> {
    if (signal?.aborted) return { kind: 'retry' };
    try {
      await deps.cancel(item, reservation);
      return { kind: 'settled' };
    } catch (error) {
      const reason = terminalErrorReason(error);
      return reason ? { kind: 'terminal', reason } : { kind: 'retry' };
    }
  }

  async function reserveOnce(
    item: CleanupItem,
    signal?: AbortSignal,
  ): Promise<ReservationResult | ItemOutcome> {
    if (signal?.aborted) return { kind: 'retry' };
    try {
      return await deps.reserve(item);
    } catch (error) {
      const reason = terminalErrorReason(error);
      return reason ? { kind: 'terminal', reason } : { kind: 'retry' };
    }
  }

  async function reconcileAfterCancelFailure(
    item: CleanupItem,
    priorReservation: UploadReservation,
    signal?: AbortSignal,
  ): Promise<ItemOutcome> {
    const replay = await reserveOnce(item, signal);
    if ('kind' in replay) return replay;
    const reason = terminalResultReason(replay);
    if (reason) return { kind: 'terminal', reason };
    if (replay.status === 'delivered') {
      return { kind: 'settled', deliveredId: replay.mediaId };
    }
    if (replay.status === 'canceled') return { kind: 'settled' };
    if (signal?.aborted) return { kind: 'retry' };
    const reservation = replay.status === 'accepted' ? replay.reservation : priorReservation;
    return cancelOnce(item, reservation, signal);
  }

  async function cancelWithReconciliation(
    item: CleanupItem,
    reservation: UploadReservation,
    signal?: AbortSignal,
  ): Promise<ItemOutcome> {
    const canceled = await cancelOnce(item, reservation, signal);
    if (canceled.kind !== 'retry' || signal?.aborted) return canceled;
    return reconcileAfterCancelFailure(item, reservation, signal);
  }

  async function resolveAmbiguous(
    item: CleanupItem,
    signal?: AbortSignal,
  ): Promise<ItemOutcome> {
    const replay = await reserveOnce(item, signal);
    if ('kind' in replay) return replay;
    const reason = terminalResultReason(replay);
    if (reason) return { kind: 'terminal', reason };
    if (replay.status === 'delivered') {
      return { kind: 'settled', deliveredId: replay.mediaId };
    }
    if (replay.status === 'canceled') return { kind: 'settled' };
    if (replay.status === 'rejected') return { kind: 'settled' };
    if (signal?.aborted) return { kind: 'retry' };
    return cancelWithReconciliation(item, replay.reservation, signal);
  }

  return {
    async run(items, signal) {
      const deliveredIds = new Set<string>();
      let unresolvedCount = items.filter(({ disposition }) =>
        disposition === 'ambiguous' || disposition === 'reserved').length;

      for (const item of items) {
        if (item.disposition === 'delivered' && item.reservation) {
          deliveredIds.add(item.reservation.mediaId);
        }
      }
      const priorTerminal = items
        .map(({ queueItem }) => terminalFailureReason(queueItem.failure))
        .find((reason): reason is ManagerUploadTerminalReason => reason !== null);
      if (priorTerminal) {
        return {
          kind: 'terminal',
          reason: priorTerminal,
          unresolvedCount,
          deliveredIds: [...deliveredIds],
        };
      }

      for (const item of items) {
        if (item.disposition !== 'ambiguous' && item.disposition !== 'reserved') continue;
        if (signal?.aborted) break;

        const outcome = item.disposition === 'ambiguous'
          ? await resolveAmbiguous(item, signal)
          : item.reservation
            ? await cancelWithReconciliation(item, item.reservation, signal)
            : { kind: 'retry' as const };
        if (outcome.kind === 'terminal') {
          return {
            kind: 'terminal',
            reason: outcome.reason,
            unresolvedCount,
            deliveredIds: [...deliveredIds],
          };
        }
        if (outcome.kind === 'settled') {
          unresolvedCount -= 1;
          if (outcome.deliveredId) deliveredIds.add(outcome.deliveredId);
        }
      }

      return unresolvedCount === 0
        ? { kind: 'settled', deliveredIds: [...deliveredIds] }
        : { kind: 'retry', unresolvedCount, deliveredIds: [...deliveredIds] };
    },
  };
}

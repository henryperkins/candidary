import type { LoadFailure } from '../../components/States';

/**
 * One persistence domain's write queue. It exists because the settings and
 * theme endpoints each accept one complete payload: two requests in flight at
 * once means the slower one decides what is stored, whatever the host last
 * typed. So a domain holds at most one in-flight snapshot and one pending
 * snapshot, and the pending one is always the newest valid draft. Intermediate
 * drafts are dropped on purpose — they are keystrokes, not intent.
 *
 * Aborting fetch is deliberately not the ordering mechanism: an aborted
 * request may already have committed on the Worker. Serialization is.
 */

export const AUTOSAVE_DEBOUNCE_MS = 600;

export type AutosaveStatus = 'saved' | 'scheduled' | 'saving' | 'invalid' | 'failed';

export interface AutosaveFailure {
  message: string;
  // Whether repeating the same request could reasonably succeed. A revoked
  // credential or an ended event cannot, and offering Retry there is a lie.
  retryable: boolean;
  // Set for credential and lifecycle failures, so the manager can raise its
  // existing recovery notice instead of a local Retry button.
  escalation?: LoadFailure;
}

export interface AutosaveState {
  status: AutosaveStatus;
  failure: AutosaveFailure | null;
}

export interface AutosaveDraft<S> {
  /** Persistence identity. Two drafts sharing a key are the same write. */
  key: string;
  /**
   * What the host can actually see. It changes for edits that leave the payload
   * alone — invalid hex text sitting on top of the last valid color, a trailing
   * space — which is the only way a response can tell whether the screen has
   * moved on since it was sent.
   */
  intent: string;
  /** Null means the latest complete domain draft cannot be sent at all. */
  snapshot: S | null;
}

/**
 * What a resolved save actually achieved. Confirmed carries the key the Worker
 * reports storing, which is not always the key that was sent: server
 * normalization would otherwise leave the draft looking dirty forever.
 * Rebased means the request resolved without committing and something newer
 * is already on its way — the domain is still saving, and must not say Saved.
 */
export type AutosaveOutcome =
  | { status: 'confirmed'; key: string }
  | { status: 'rebased' };

export interface AutosaveHandle {
  flush(): void;
}

export interface DomainAutosaveState {
  domain: 'settings' | 'appearance' | 'album';
  label: string;
  status: AutosaveStatus;
  failure: AutosaveFailure | null;
  blockingField: { label: string; message: string } | null;
}

export interface AutosaveQueueOptions<S> {
  baselineKey: string;
  debounceMs?: number;
  save(snapshot: S, draft: { key: string; intent: string }): Promise<AutosaveOutcome>;
  // Called only for a failure that still describes the latest draft, so the
  // editor can attach server field errors in the same moment it learns the
  // request was refused — and never for intent the host has already replaced.
  describeFailure(error: unknown, key: string): AutosaveFailure;
  onChange(state: AutosaveState): void;
}

export interface AutosaveQueue<S> {
  submit(draft: AutosaveDraft<S>, immediate?: boolean): void;
  flush(): void;
  waitForSettled(): Promise<AutosaveState>;
  /** Drops work that has not started. A request already in flight still owns its response. */
  discardPending(): void;
  adoptBaseline(key: string): void;
  state(): AutosaveState;
  dispose(): void;
}

interface Ready<S> {
  key: string;
  intent: string;
  snapshot: S;
}

export function createAutosaveQueue<S>(options: AutosaveQueueOptions<S>): AutosaveQueue<S> {
  const debounceMs = options.debounceMs ?? AUTOSAVE_DEBOUNCE_MS;
  let baselineKey = options.baselineKey;
  let latest: AutosaveDraft<S> | null = null;
  let scheduled: Ready<S> | null = null;
  let inFlight: Ready<S> | null = null;
  let pending: Ready<S> | null = null;
  let failure: AutosaveFailure | null = null;
  // A request resolved without committing and a replacement is expected. It
  // stops derive from reporting a Saved that no write earned, and clears on
  // the next submit — which is the replacement arriving.
  let rebasing = false;
  let timer: number | null = null;
  let announced: AutosaveState = { status: 'saved', failure: null };
  let settleWaiters: Array<(state: AutosaveState) => void> = [];
  let disposed = false;

  function cancelTimer() {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  }

  // Invalid outranks an older in-flight or failed state, and a live request
  // outranks an older failure: the host is told about the draft in front of
  // them, not about intent they have already moved past.
  function derive(): AutosaveStatus {
    if (latest?.snapshot === null) return 'invalid';
    if (inFlight) return 'saving';
    if (scheduled) return 'scheduled';
    if (rebasing) return 'saving';
    if (failure) return 'failed';
    return 'saved';
  }

  function isSettled() {
    return timer === null
      && scheduled === null
      && inFlight === null
      && pending === null
      && !rebasing;
  }

  function resolveSettled(next: AutosaveState) {
    if (!isSettled() || settleWaiters.length === 0) return;
    const ready = settleWaiters;
    settleWaiters = [];
    for (const resolve of ready) resolve(next);
  }

  function emit() {
    const next: AutosaveState = { status: derive(), failure };
    if (next.status !== announced.status || next.failure !== announced.failure) {
      announced = next;
      if (!disposed) options.onChange(next);
    }
    resolveSettled(next);
  }

  function settle(sent: Ready<S>, error: unknown, outcome: AutosaveOutcome | null) {
    if (inFlight !== sent) return;
    inFlight = null;
    // A response describes the snapshot it was sent for. If anything newer is
    // queued or on screen, its verdict is about intent that no longer exists.
    const superseded = pending !== null
      || latest === null
      || latest.snapshot === null
      || latest.key !== sent.key;
    if (error !== null) {
      rebasing = false;
      if (!superseded && !disposed) failure = options.describeFailure(error, sent.key);
    } else if (outcome?.status === 'confirmed') {
      // The Worker's own answer, not the key that was sent.
      baselineKey = outcome.key;
      rebasing = false;
      failure = null;
    } else {
      rebasing = true;
    }
    const next = pending;
    pending = null;
    if (next) start(next);
    else emit();
  }

  function start(next: Ready<S>) {
    if (disposed) return;
    if (inFlight) {
      pending = next;
      emit();
      return;
    }
    inFlight = next;
    emit();
    void options.save(next.snapshot, { key: next.key, intent: next.intent }).then(
      (outcome) => { settle(next, null, outcome); },
      (error: unknown) => {
        settle(next, error ?? new Error('The change could not be saved.'), null);
      },
    );
  }

  function submit(draft: AutosaveDraft<S>, immediate = false) {
    if (disposed) return;
    latest = draft;
    // A new draft is the replacement a rebased outcome was waiting for.
    rebasing = false;
    if (draft.snapshot === null) {
      // Saving historical intent after the host has made the domain unsendable
      // is worse than saving nothing, so nothing unstarted survives this.
      cancelTimer();
      scheduled = null;
      pending = null;
      emit();
      return;
    }
    const next: Ready<S> = { key: draft.key, intent: draft.intent, snapshot: draft.snapshot };
    if (failure) failure = null;
    // Equivalence is judged against the baseline, the in-flight snapshot, and
    // the pending snapshot together — never against the baseline alone.
    if (inFlight === null && next.key === baselineKey) {
      cancelTimer();
      scheduled = null;
      pending = null;
      emit();
      return;
    }
    if (inFlight?.key === next.key) {
      // The host is back at exactly what is being written. Anything queued
      // behind it described intent they have since abandoned, and letting it
      // run would make the older value the one that survives.
      cancelTimer();
      scheduled = null;
      pending = null;
      emit();
      return;
    }
    if (pending?.key === next.key) {
      cancelTimer();
      scheduled = null;
      pending = next;
      emit();
      return;
    }
    if (immediate) {
      cancelTimer();
      scheduled = null;
      start(next);
      return;
    }
    if (scheduled?.key === next.key) {
      // Resubmitting the same value must not keep pushing the deadline out.
      // Its visible intent and request metadata may still have moved, so the
      // already-owned deadline sends the newest equivalent draft.
      scheduled = next;
      emit();
      return;
    }
    scheduled = next;
    cancelTimer();
    timer = window.setTimeout(() => {
      timer = null;
      const ready = scheduled;
      scheduled = null;
      if (ready) start(ready);
    }, debounceMs);
    emit();
  }

  return {
    submit,
    flush() {
      if (disposed) return;
      cancelTimer();
      const ready = scheduled;
      scheduled = null;
      if (ready) start(ready);
    },
    waitForSettled() {
      const current: AutosaveState = { status: derive(), failure };
      if (isSettled()) return Promise.resolve(current);
      return new Promise((resolve) => { settleWaiters.push(resolve); });
    },
    discardPending() {
      if (disposed) return;
      cancelTimer();
      latest = null;
      scheduled = null;
      pending = null;
      failure = null;
      rebasing = false;
      emit();
    },
    adoptBaseline(key: string) {
      baselineKey = key;
      emit();
    },
    state: () => announced,
    /**
     * Everything not yet sent is discarded, and nothing new starts. This runs
     * on unmount — which is what a client navigation past the prompt causes —
     * and it is what makes Leave now honest: the host was told that unsent
     * changes go, so a debounce timer or a pending snapshot must not fire after
     * they have gone. A request already sent still finishes, because cancelling
     * it here would not un-commit it on the Worker; the prompt says that too.
     *
     * A destination change inside the manager does not unmount anything, so it
     * never reaches this.
     */
    dispose() {
      disposed = true;
      cancelTimer();
      scheduled = null;
      pending = null;
      emit();
    },
  };
}

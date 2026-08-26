import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { describeLoadFailure } from '../../components/States';
import type { LoadFailure } from '../../components/States';

/**
 * One Manager panel's data, owned by that panel.
 *
 * The Manager used to load its event, its Intake page, its exports, and its
 * printed credential in a single `Promise.all` and write all four or none. That
 * made every panel share one failure: a transient 500 from `GET .../exports`
 * took down the event header, the capacity meter, the nav, and Settings with it,
 * and a host whose exports endpoint was briefly unhappy was told their event
 * could not be loaded. It also made every filter change a whole-shell reload,
 * because the shell's one loader was keyed on the media query.
 *
 * A controller instead answers for exactly one resource, under exactly one event
 * and one query, and adopts a response only when both still match. What that
 * buys, precisely:
 *
 *  - a retryable failure stays inside its own panel and cannot clear a sibling
 *    that already loaded;
 *  - a credential, role, account, or event-lifecycle failure — from *any*
 *    resource — escalates once to the Manager's recovery surface, because those
 *    are never one panel's problem;
 *  - Retry keeps showing the last value it trusted while the new attempt runs,
 *    so pressing it does not blank the panel it is trying to repair;
 *  - a response from a generation that has been explicitly retired is dropped.
 *    Changing events, changing a query, or an operation that deliberately
 *    invalidates a prior read all retire generations, and a slower earlier
 *    request can never win against the newer state.
 *
 * There is no data-fetching library here on purpose: the generation counter, the
 * abort controller, and `describeLoadFailure` were already the house pattern, and
 * this only gives them one shape instead of six.
 */

export type ResourceStatus = 'idle' | 'loading' | 'ready' | 'failed';

export interface ResourceState<T> {
  /** The event this value answers for. A different event means a different value. */
  eventId: string;
  /** The exact query this value answers for — filters, cursors, and all. */
  queryKey: string;
  /** Monotonic per controller. Only the newest issued read may write. */
  generation: number;
  /** The last value this controller trusted. Retained across a retry. */
  value: T | null;
  status: ResourceStatus;
  /** Panel-local. Escalating failures are reported through `onEscalate` instead. */
  failure: LoadFailure | null;
  /** A credential/lifecycle answer is final for this resource identity. */
  terminal: boolean;
}

/** A read's exact right to change a resource. */
export interface ResourceCapture {
  eventId: string;
  queryKey: string;
  generation: number;
}

export interface ManagerResource<T> {
  state: ResourceState<T>;
  /** Load, or reload after a failure, keeping the last trusted value visible. */
  reload: () => Promise<void>;
  /**
   * Take a projection a mutation already returned.
   *
   * A write that answers with the new state of its own resource should not be
   * followed by a read of the same thing. Adopting retires every in-flight read,
   * so a load opened before the write cannot put the old value back.
   */
  adopt: (value: T) => void;
  /**
   * Fold a local change into the current value.
   *
   * For the narrow case where a mutation's own response is a *part* of this
   * resource rather than the whole of it — a photo-intake write that owns the
   * schedule fields but not the counters, say. Like `adopt`, it retires reads in
   * flight, so an older load cannot undo it.
   */
  update: (updater: (current: T | null) => T | null) => void;
  /** Capture this resource before an imperative read starts. */
  capture: () => ResourceCapture;
  /** Check capture ownership without retiring reads or changing resource state. */
  isCaptureCurrent: (capture: ResourceCapture) => boolean;
  /** Adopt only if no newer read, write, event, or query has replaced `capture`. */
  adoptIfCurrent: (capture: ResourceCapture, value: T) => boolean;
  /** Update only if no newer read, write, event, or query has replaced `capture`. */
  updateIfCurrent: (capture: ResourceCapture, updater: (current: T | null) => T | null) => boolean;
  /** Escalate a terminal imperative-read failure at most once for this identity. */
  reportTerminalIfCurrent: (capture: ResourceCapture, caught: unknown) => LoadFailure | null;
  /** Synchronous terminal lock for imperative timers retained from an old render. */
  isTerminal: () => boolean;
  /** Retire everything in flight and load again. Used by cross-resource invalidation. */
  invalidate: () => void;
  /** Drop the value without loading. Used when a resource stops being relevant. */
  clear: () => void;
}

export interface ManagerResourceOptions<T> {
  eventId: string;
  /** Everything that makes this a different question: filters, cursors, mode. */
  queryKey: string;
  load: (signal: AbortSignal) => Promise<T>;
  fallbackMessage: string;
  /**
   * Where a non-retryable failure goes.
   *
   * Credential, role, account, and lifecycle failures are facts about the
   * session or the event, not about this panel, so they leave the panel and
   * reach the one surface that can act on them.
   */
  onEscalate: (failure: LoadFailure) => void;
  /** False keeps the controller idle until something calls `reload`. */
  enabled?: boolean;
}

export function useManagerResource<T>({
  eventId,
  queryKey,
  load,
  fallbackMessage,
  onEscalate,
  enabled = true,
}: ManagerResourceOptions<T>): ManagerResource<T> {
  const [state, setState] = useState<ResourceState<T>>({
    eventId,
    queryKey,
    generation: 0,
    value: null,
    status: 'idle',
    failure: null,
    terminal: false,
  });
  const generation = useRef(0);
  const inFlight = useRef<AbortController | null>(null);
  // Imperative methods are routinely retained by timers, event handlers, and
  // mutation callbacks.  Their function identity describes the event/query
  // they were created for, but React does not revoke an old closure when those
  // inputs change.  Keep the committed identity separately so an old closure
  // cannot retire or write the controller that replaced it.
  const currentIdentity = useRef({ eventId, queryKey });
  // A terminal answer does not become retryable merely because its notice was
  // dismissed. The lock is identity-scoped and is cleared only by a different
  // event/query or a trusted projection.
  const terminalIdentity = useRef<string | null>(null);
  const lastIdentity = useRef({ eventId, queryKey });
  const escalate = useRef(onEscalate);
  const loader = useRef(load);

  // These refs are read by callbacks retained by timers and promises. Updating
  // them during render lets an abandoned concurrent render revoke a committed
  // owner; layout effects bind them only after that render has committed, before
  // this hook's passive loading effect can issue its next read.
  useLayoutEffect(() => {
    currentIdentity.current = { eventId, queryKey };
  }, [eventId, queryKey]);
  useLayoutEffect(() => {
    escalate.current = onEscalate;
  }, [onEscalate]);
  useLayoutEffect(() => {
    loader.current = load;
  }, [load]);

  const retire = useCallback(() => {
    generation.current += 1;
    const active = inFlight.current;
    inFlight.current = null;
    active?.abort();
    return generation.current;
  }, []);

  const isCurrent = useCallback((candidateEventId: string, candidateQueryKey: string) => (
    currentIdentity.current.eventId === candidateEventId
      && currentIdentity.current.queryKey === candidateQueryKey
  ), []);

  const identityKey = useCallback((candidateEventId: string, candidateQueryKey: string) => (
    `${candidateEventId}\u0000${candidateQueryKey}`
  ), []);

  const capture = useCallback((): ResourceCapture => ({
    eventId,
    queryKey,
    generation: generation.current,
  }), [eventId, queryKey]);

  const captureIsCurrent = useCallback((candidate: ResourceCapture) => (
    generation.current === candidate.generation
      && isCurrent(candidate.eventId, candidate.queryKey)
      && terminalIdentity.current !== identityKey(candidate.eventId, candidate.queryKey)
  ), [identityKey, isCurrent]);

  const isTerminal = useCallback(() => (
    terminalIdentity.current === identityKey(eventId, queryKey)
  ), [eventId, identityKey, queryKey]);

  const run = useCallback(async () => {
    const requestedEventId = eventId;
    const requestedQueryKey = queryKey;
    if (!isCurrent(requestedEventId, requestedQueryKey)) return;
    if (terminalIdentity.current === identityKey(requestedEventId, requestedQueryKey)) return;
    const issued = retire();
    const controller = new AbortController();
    inFlight.current = controller;
    // The last trusted value stays on screen. A panel that blanked itself every
    // time Retry was pressed would be hiding the thing the host is trying to get
    // back, and a refresh over a slow venue network would flicker the whole page.
    setState((current) => (
      isCurrent(requestedEventId, requestedQueryKey)
        && current.eventId === requestedEventId
        && current.queryKey === requestedQueryKey
        ? { ...current, generation: issued, status: 'loading', failure: null, terminal: false }
        : current
    ));
    try {
      const value = await loader.current(controller.signal);
      if (generation.current !== issued || !isCurrent(requestedEventId, requestedQueryKey)) return;
      // The authoritative answer replaces the page the issued generation read.
      // Retire continuations captured while it was pending so an old cursor or
      // mutation projection cannot amend the newly settled value.
      const settled = retire();
      setState((current) => (
        isCurrent(requestedEventId, requestedQueryKey)
          && current.eventId === requestedEventId && current.queryKey === requestedQueryKey
          ? {
              eventId: requestedEventId,
              queryKey: requestedQueryKey,
              generation: settled,
              value,
              status: 'ready',
              failure: null,
              terminal: false,
            }
          : current
      ));
    } catch (caught) {
      if (generation.current !== issued || !isCurrent(requestedEventId, requestedQueryKey)) return;
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      const failure = describeLoadFailure(caught, 'manager', fallbackMessage);
      if (failure.kind === 'retry') {
        setState((current) => (
          isCurrent(requestedEventId, requestedQueryKey)
            && current.eventId === requestedEventId && current.queryKey === requestedQueryKey
            ? { ...current, generation: issued, status: 'failed', failure, terminal: false }
            : current
        ));
        return;
      }
      const terminalKey = identityKey(requestedEventId, requestedQueryKey);
      const alreadyTerminal = terminalIdentity.current === terminalKey;
      terminalIdentity.current = terminalKey;
      // A terminal answer is also an authoritative settlement. In particular,
      // a continuation captured while this reload was pending must not clear
      // the terminal lock and put the retained value back into a ready state.
      const settled = retire();
      setState((current) => (
        isCurrent(requestedEventId, requestedQueryKey)
          && current.eventId === requestedEventId && current.queryKey === requestedQueryKey
          ? { ...current, generation: settled, status: 'failed', failure: null, terminal: true }
          : current
      ));
      if (!alreadyTerminal) escalate.current(failure);
    } finally {
      if (inFlight.current === controller) inFlight.current = null;
    }
  }, [eventId, fallbackMessage, identityKey, isCurrent, queryKey, retire]);

  // A new event retires every generation and clears the value: the previous
  // event's photos, exports, and credential are not a stale version of this
  // event's, they are somebody else's. A new query clears it too — a page and a
  // continuation cursor belong to the question that produced them, and keeping
  // either across a filter change would let a host spend the previous query's
  // cursor against the new one. Only Retry keeps the last trusted value, because
  // there the question has not changed.
  useEffect(() => {
    if (
      lastIdentity.current.eventId !== eventId
      || lastIdentity.current.queryKey !== queryKey
    ) {
      terminalIdentity.current = null;
      lastIdentity.current = { eventId, queryKey };
    }
    retire();
    setState((current) => (
      current.eventId === eventId && current.queryKey === queryKey
        ? current
        : {
            eventId,
            queryKey,
            generation: generation.current,
            value: null,
            status: 'idle',
            failure: null,
            terminal: false,
          }
    ));
    if (enabled) void run();
  }, [enabled, eventId, queryKey, retire, run]);

  useEffect(() => () => { retire(); }, [retire]);

  const adopt = useCallback((value: T) => {
    const requestedEventId = eventId;
    const requestedQueryKey = queryKey;
    if (!isCurrent(requestedEventId, requestedQueryKey)) return;
    terminalIdentity.current = null;
    const issued = retire();
    setState((current) => (
      isCurrent(requestedEventId, requestedQueryKey)
        && current.eventId === requestedEventId
        && current.queryKey === requestedQueryKey
        ? {
            eventId: requestedEventId,
            queryKey: requestedQueryKey,
            generation: issued,
            value,
            status: 'ready',
            failure: null,
            terminal: false,
          }
        : current
    ));
  }, [eventId, isCurrent, queryKey, retire]);

  const clear = useCallback(() => {
    const requestedEventId = eventId;
    const requestedQueryKey = queryKey;
    if (!isCurrent(requestedEventId, requestedQueryKey)) return;
    terminalIdentity.current = null;
    const issued = retire();
    setState((current) => (
      isCurrent(requestedEventId, requestedQueryKey)
        && current.eventId === requestedEventId
        && current.queryKey === requestedQueryKey
        ? {
            eventId: requestedEventId,
            queryKey: requestedQueryKey,
            generation: issued,
            value: null,
            status: 'idle',
            failure: null,
            terminal: false,
          }
        : current
    ));
  }, [eventId, isCurrent, queryKey, retire]);

  const update = useCallback((updater: (current: T | null) => T | null) => {
    const requestedEventId = eventId;
    const requestedQueryKey = queryKey;
    if (!isCurrent(requestedEventId, requestedQueryKey)) return;
    terminalIdentity.current = null;
    const issued = retire();
    setState((current) => {
      if (
        !isCurrent(requestedEventId, requestedQueryKey)
        || current.eventId !== requestedEventId
        || current.queryKey !== requestedQueryKey
      ) return current;
      const value = updater(current.value);
      return {
        eventId: requestedEventId,
        queryKey: requestedQueryKey,
        generation: issued,
        value,
        status: value === null ? 'idle' : 'ready',
        failure: null,
        terminal: false,
      };
    });
  }, [eventId, isCurrent, queryKey, retire]);

  const adoptIfCurrent = useCallback((requested: ResourceCapture, value: T) => {
    if (!captureIsCurrent(requested)) return false;
    terminalIdentity.current = null;
    const issued = retire();
    setState((current) => (
      // The capture check above makes the synchronous ownership decision. This
      // queued updater must remain composable with a later local projection;
      // React can defer it until after that later update was issued. Identity,
      // not the live generation ref, prevents an A-query projection from
      // crossing into B before the reset effect has committed.
      isCurrent(requested.eventId, requested.queryKey)
        && current.eventId === requested.eventId
        && current.queryKey === requested.queryKey
        ? {
            eventId: requested.eventId,
            queryKey: requested.queryKey,
            generation: issued,
            value,
            status: 'ready',
            failure: null,
            terminal: false,
          }
        : current
    ));
    return true;
  }, [captureIsCurrent, isCurrent, retire]);

  const updateIfCurrent = useCallback((requested: ResourceCapture, updater: (current: T | null) => T | null) => {
    if (!captureIsCurrent(requested)) return false;
    terminalIdentity.current = null;
    const issued = retire();
    setState((current) => {
      if (
        !isCurrent(requested.eventId, requested.queryKey)
        || current.eventId !== requested.eventId
        || current.queryKey !== requested.queryKey
      ) return current;
      const value = updater(current.value);
      return {
        eventId: requested.eventId,
        queryKey: requested.queryKey,
        generation: issued,
        value,
        status: value === null ? 'idle' : 'ready',
        failure: null,
        terminal: false,
      };
    });
    // React may defer the functional updater. The generation/identity guard
    // before it is queued is the synchronous ownership decision, so callers can safely
    // propagate their mutation projection immediately after this returns.
    return true;
  }, [captureIsCurrent, isCurrent, retire]);

  const reportTerminalIfCurrent = useCallback((requested: ResourceCapture, caught: unknown) => {
    const failure = describeLoadFailure(caught, 'manager', fallbackMessage);
    if (failure.kind === 'retry' || !captureIsCurrent(requested)) return null;
    const terminalKey = identityKey(requested.eventId, requested.queryKey);
    if (terminalIdentity.current === terminalKey) return failure;
    terminalIdentity.current = terminalKey;
    const issued = retire();
    setState((current) => (
      isCurrent(requested.eventId, requested.queryKey)
        && current.eventId === requested.eventId
        && current.queryKey === requested.queryKey
        ? { ...current, generation: issued, status: 'failed', failure: null, terminal: true }
        : current
    ));
    escalate.current(failure);
    return failure;
  }, [captureIsCurrent, fallbackMessage, identityKey, isCurrent, retire]);

  // Memoised, because a controller is routinely a dependency of a caller's own
  // `useCallback`. A fresh object every render would make every one of those
  // unstable, and an effect that depends on one would re-run forever.
  //
  // Identity reset remains a passive effect so it can retire work only for a
  // committed render. The public state cannot wait for that effect, though: a
  // consumer layout effect for B must never observe A's value or cursor. Project
  // the committed render's identity synchronously until the durable hook state
  // catches up.
  const identityMatchedState = state.eventId === eventId && state.queryKey === queryKey
    ? state
    : {
        eventId,
        queryKey,
        generation: generation.current,
        value: null,
        status: 'idle' as const,
        failure: null,
        terminal: false,
      };
  return useMemo(
    () => ({
      state: identityMatchedState,
      reload: run,
      adopt,
      update,
      capture,
      isCaptureCurrent: captureIsCurrent,
      adoptIfCurrent,
      updateIfCurrent,
      reportTerminalIfCurrent,
      isTerminal,
      invalidate: run,
      clear,
    }),
    [
      adopt,
      adoptIfCurrent,
      capture,
      captureIsCurrent,
      clear,
      identityMatchedState,
      isTerminal,
      reportTerminalIfCurrent,
      run,
      update,
      updateIfCurrent,
    ],
  );
}

/**
 * Whether a failure is this panel's to show.
 *
 * Kept beside the controller so a surface cannot accidentally decide that a
 * revoked credential is a retryable panel outage.
 */
export function isPanelFailure(failure: LoadFailure): boolean {
  return failure.kind === 'retry';
}

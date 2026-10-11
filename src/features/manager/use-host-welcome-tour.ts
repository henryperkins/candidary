import { useEffect, useRef, useState } from 'react';
import { HOST_EVENT_WELCOME_TOUR_KEY, HOST_EVENT_WELCOME_TOUR_VERSION, type HostTourStateView } from '../../../shared/contracts';
import { api } from '../../app/api';
import type { HostWelcomeMode } from './host-welcome-content';

const path = `/api/host/tours/${HOST_EVENT_WELCOME_TOUR_KEY}/${HOST_EVENT_WELCOME_TOUR_VERSION}`;
type Outcome = 'dismissed' | 'completed';
interface TourLookup {
  owner: { eventId: string; generation: number };
  pending: boolean;
  outcome: Outcome | null;
  account: HostTourStateView | null;
}
const seenInMemory = new Set<string>();
interface Preference { confirmed: Outcome | null; pending: Outcome | null }
const preferencesInMemory = new Map<string, Preference>();
const inFlight = new Map<string, { preference: Preference; promise: Promise<void> }>();
function sessionKey(accountId: string) { return `candidary:tour:${HOST_EVENT_WELCOME_TOUR_VERSION}:${accountId}`; }
function strongest(a: Outcome | null, b: Outcome | null): Outcome | null {
  return a === 'completed' || b === 'completed' ? 'completed' : a ?? b;
}
function terminal(value: unknown): Outcome | null { return value === 'dismissed' || value === 'completed' ? value : null; }
function preference(accountId: string): Preference {
  const local = inFlight.get(accountId)?.preference ?? preferencesInMemory.get(accountId);
  if (local) return local;
  try {
    // The old :outcome cache was written before PATCH succeeded, so it cannot
    // prove confirmation. The new record keeps the two states distinct.
    const stored = JSON.parse(sessionStorage.getItem(`${sessionKey(accountId)}:preference`) ?? 'null') as Preference | null;
    return { confirmed: terminal(stored?.confirmed), pending: terminal(stored?.pending) };
  } catch { return { confirmed: null, pending: null }; }
}
function rememberPreference(accountId: string, value: Preference) {
  if (value.confirmed === 'completed' || value.confirmed === value.pending) value.pending = null;
  try {
    sessionStorage.setItem(`${sessionKey(accountId)}:preference`, JSON.stringify(value));
    preferencesInMemory.delete(accountId);
  } catch {
    // Reads may still succeed when writes are blocked or the quota is full.
    // Retain the latest full record, including cleared pending state.
    preferencesInMemory.set(accountId, value);
  }
}
function seen(accountId: string) {
  const value = preference(accountId);
  if (seenInMemory.has(accountId) || value.confirmed || value.pending) return true;
  try { return sessionStorage.getItem(sessionKey(accountId)) === 'seen'; }
  catch { return false; }
}
function remember(accountId: string) {
  try { sessionStorage.setItem(sessionKey(accountId), 'seen'); seenInMemory.delete(accountId); }
  catch { seenInMemory.add(accountId); }
}
function confirmAccount(value: HostTourStateView) {
  const status = terminal(value.status);
  if (!status) return;
  const current = preference(value.accountId);
  current.confirmed = strongest(current.confirmed, status);
  rememberPreference(value.accountId, current);
}
function savePreference(accountId: string, status?: Outcome): Promise<void> | null {
  const current = preference(accountId);
  if (status) current.pending = strongest(current.pending, status);
  rememberPreference(accountId, current);
  const existing = inFlight.get(accountId);
  if (existing) return existing.promise;
  if (!current.pending) return null;

  const write = { preference: current, promise: Promise.resolve() };
  inFlight.set(accountId, write);
  write.promise = (async () => {
    while (current.pending) {
      const attempted = current.pending;
      try {
        const saved = await api<HostTourStateView>(path, {
          method: 'PATCH', headers: { 'x-candidary-tour-account-id': accountId },
          body: JSON.stringify({ status: attempted }),
        });
        if (saved.accountId !== accountId) throw new Error('Tour account changed');
        current.confirmed = strongest(current.confirmed, strongest(attempted, terminal(saved.status)));
        rememberPreference(accountId, current);
      } catch (error) {
        // A newer completion remains the requested outcome even if an older
        // dismissal fails. Try it once; ordinary failure stays recoverable.
        if (current.pending && current.pending === attempted) throw error;
      }
    }
  })().finally(() => { if (inFlight.get(accountId) === write) inFlight.delete(accountId); });
  return write.promise;
}

export function useHostWelcomeTour({ eventId, eligible }: { eventId: string; eligible: boolean | (() => boolean) }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<HostWelcomeMode>('intro');
  const [account, setAccount] = useState<HostTourStateView | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const owner = useRef({ eventId, generation: 0 });
  const observedEvent = useRef<string | null>(null);
  const manualVisit = useRef(false);
  const lookup = useRef<TourLookup | null>(null);
  if (owner.current.eventId !== eventId) owner.current = { eventId, generation: owner.current.generation + 1 };

  useEffect(() => {
    const scope = owner.current;
    let live = true;
    const read: TourLookup = { owner: scope, pending: true, outcome: null, account: null };
    lookup.current = read;
    observedEvent.current = null; manualVisit.current = false;
    setAccount(null); setOpen(false); setSaveFailed(false);
    const abort = new AbortController();
    void api<HostTourStateView>(path, { signal: abort.signal }).then(value => {
      if (!live || owner.current !== scope || lookup.current !== read) return;
      read.pending = false;
      read.account = value;
      const outcome = read.outcome;
      read.outcome = null;
      observedEvent.current = scope.eventId;
      if (manualVisit.current) remember(value.accountId);
      confirmAccount(value);
      setAccount(value);
      if (outcome) persistOutcome(read, outcome);
      else observeSave(read);
    }).catch(() => {
      if (!live || owner.current !== scope || lookup.current !== read) return;
      read.pending = false;
      read.outcome = null;
      // 401 is a management-link session. Other failures also stay manual for
      // this mount; neither can prove account eligibility for automatic launch.
    });
    return () => {
      live = false; read.pending = false; read.outcome = null;
      if (lookup.current === read) lookup.current = null;
      abort.abort();
    };
  }, [eventId]);

  useEffect(() => {
    if (manualVisit.current || !(typeof eligible === 'function' ? eligible() : eligible) || observedEvent.current !== eventId || !account || account.status !== 'unseen' || seen(account.accountId)) return;
    remember(account.accountId);
    setMode('intro'); setOpen(true);
  }, [account, eligible, eventId]);

  function observeSave(read: TourLookup) {
    if (!read.account) return;
    const accountId = read.account.accountId;
    const sync = () => {
      if (lookup.current !== read || owner.current !== read.owner) return;
      setSaveFailed(!!preference(accountId).pending && !inFlight.has(accountId));
    };
    sync();
    const write = inFlight.get(accountId);
    if (write) void write.promise.then(sync, sync);
  }
  function persistOutcome(read: TourLookup, status?: Outcome) {
    if (!read.account || read.owner !== owner.current || lookup.current !== read) return;
    remember(read.account.accountId);
    savePreference(read.account.accountId, status);
    observeSave(read);
  }
  return {
    open, mode, saveFailed,
    start(nextMode: HostWelcomeMode = 'intro') { setMode(nextMode); manualVisit.current = true; if (account && observedEvent.current === eventId) remember(account.accountId); setOpen(true); },
    close(status: Outcome) {
      manualVisit.current = true;
      setOpen(false);
      const read = lookup.current;
      if (!read || read.owner !== owner.current) return;
      if (read.pending) {
        // A manual exit can precede account identity. Keep only this read's
        // terminal outcome, with completion surviving later replay dismissal.
        read.outcome = read.outcome === 'completed' || status === 'completed' ? 'completed' : 'dismissed';
      } else if (read.account) persistOutcome(read, status);
    },
    retrySave() { const read = lookup.current; if (read && !read.pending) persistOutcome(read); },
  };
}

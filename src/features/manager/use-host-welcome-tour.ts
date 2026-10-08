import { useEffect, useRef, useState } from 'react';
import { HOST_EVENT_WELCOME_TOUR_KEY, HOST_EVENT_WELCOME_TOUR_VERSION, type HostTourStateView } from '../../../shared/contracts';
import { api } from '../../app/api';

const path = `/api/host/tours/${HOST_EVENT_WELCOME_TOUR_KEY}/${HOST_EVENT_WELCOME_TOUR_VERSION}`;
type Outcome = 'dismissed' | 'completed';
interface TourLookup {
  owner: { eventId: string; generation: number };
  pending: boolean;
  outcome: Outcome | null;
  account: HostTourStateView | null;
}
const seenInMemory = new Set<string>();
function sessionKey(accountId: string) { return `candidary:tour:${HOST_EVENT_WELCOME_TOUR_VERSION}:${accountId}`; }
function seen(accountId: string) {
  try { return sessionStorage.getItem(sessionKey(accountId)) === 'seen'; }
  catch { return seenInMemory.has(accountId); }
}
function savedOutcome(accountId: string): string | null {
  try { return sessionStorage.getItem(`${sessionKey(accountId)}:outcome`); } catch { return null; }
}
function rememberOutcome(accountId: string, status: Outcome) {
  try { sessionStorage.setItem(`${sessionKey(accountId)}:outcome`, status); } catch { /* In-memory write keys also suppress duplicate writes. */ }
}
function remember(accountId: string) {
  seenInMemory.add(accountId);
  try { sessionStorage.setItem(sessionKey(accountId), 'seen'); } catch { /* Private storage: retain suppression in this document. */ }
}

export function useHostWelcomeTour({ eventId, eligible }: { eventId: string; eligible: boolean }) {
  const [open, setOpen] = useState(false);
  const [account, setAccount] = useState<HostTourStateView | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const owner = useRef({ eventId, generation: 0 });
  const observedEvent = useRef<string | null>(null);
  const manualVisit = useRef(false);
  const lookup = useRef<TourLookup | null>(null);
  const retry = useRef<{ accountId: string; status: Outcome } | null>(null);
  const written = useRef(new Set<string>());
  if (owner.current.eventId !== eventId) owner.current = { eventId, generation: owner.current.generation + 1 };

  useEffect(() => {
    const scope = owner.current;
    let live = true;
    const read: TourLookup = { owner: scope, pending: true, outcome: null, account: null };
    lookup.current = read;
    observedEvent.current = null; manualVisit.current = false;
    setAccount(null); setOpen(false); setSaveFailed(false); retry.current = null;
    const abort = new AbortController();
    void api<HostTourStateView>(path, { signal: abort.signal }).then(value => {
      if (!live || owner.current !== scope || lookup.current !== read) return;
      read.pending = false;
      read.account = value;
      const outcome = read.outcome;
      read.outcome = null;
      observedEvent.current = scope.eventId;
      if (manualVisit.current) remember(value.accountId);
      setAccount(value);
      if (outcome) persistOutcome(value, outcome);
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
    if (manualVisit.current || !eligible || observedEvent.current !== eventId || !account || account.status !== 'unseen' || seen(account.accountId)) return;
    remember(account.accountId);
    setOpen(true);
  }, [account, eligible, eventId]);

  async function persist(value: { accountId: string; status: Outcome }, explicitRetry = false) {
    const scope = owner.current;
    const key = `${value.accountId}:${value.status}`;
    const outcome = savedOutcome(value.accountId);
    if (!explicitRetry && (written.current.has(key) || outcome === 'completed' || outcome === value.status)) return;
    written.current.add(key);
    rememberOutcome(value.accountId, value.status);
    setSaveFailed(false);
    try {
      await api<HostTourStateView>(path, {
        method: 'PATCH', headers: { 'x-candidary-tour-account-id': value.accountId },
        body: JSON.stringify({ status: value.status }),
      });
      if (owner.current === scope) retry.current = null;
    } catch {
      if (owner.current !== scope) return;
      retry.current = value; setSaveFailed(true);
    }
  }
  function persistOutcome(observedAccount: HostTourStateView, status: Outcome) {
    remember(observedAccount.accountId);
    if (observedAccount.status === 'completed' || observedAccount.status === status) return;
    void persist({ accountId: observedAccount.accountId, status });
  }
  return {
    open, saveFailed,
    start() { manualVisit.current = true; if (account && observedEvent.current === eventId) remember(account.accountId); setOpen(true); },
    close(status: Outcome) {
      manualVisit.current = true;
      setOpen(false);
      const read = lookup.current;
      if (!read || read.owner !== owner.current) return;
      if (read.pending) {
        // A manual exit can precede account identity. Keep only this read's
        // terminal outcome, with completion surviving later replay dismissal.
        read.outcome = read.outcome === 'completed' || status === 'completed' ? 'completed' : 'dismissed';
      } else if (read.account) persistOutcome(read.account, status);
    },
    retrySave() { if (retry.current) void persist(retry.current, true); },
  };
}

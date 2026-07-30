import { type KeyboardEvent, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { api } from '../app/api';
import { hostRegisterHref, hostSignInHref } from '../app/recovery';
import type { EventView } from '../app/types';

export type AuthMode = 'signin' | 'register';

interface RecoveryContext {
  // Both values arrive already validated by `src/app/recovery.ts`. Neither this
  // component nor anything below it re-derives permission from them.
  returnTo: string | null;
  adopt: string | null;
}

const TABS: ReadonlyArray<{ id: AuthMode; label: string }> = [
  { id: 'signin', label: 'Sign in' },
  { id: 'register', label: 'Create account' },
];

// Two ways in, shown as the peers they are. A host who has just been told to create an
// account has to be able to see that signing in is the other half of the same door —
// a sentence at the foot of the panel is not that.
//
// Routed rather than local state, so both doors stay deep-linkable, the recovery
// context survives the move, and Back behaves the way an anchor promises it will.
export function AuthModeSwitch({ mode, returnTo, adopt }: RecoveryContext & { mode: AuthMode }) {
  const navigate = useNavigate();
  const hrefFor = (id: AuthMode) => (id === 'signin'
    ? hostSignInHref(adopt, returnTo)
    : hostRegisterHref(adopt, returnTo));

  // Only the selected tab is in the tab order, so the arrow keys are the other door's
  // only keyboard route. Moving is activating here: each tab is a route, so there is
  // no panel to reveal separately, and focus resting on an unselected tab would
  // describe a state the page is not in.
  function onKeyDown(event: KeyboardEvent<HTMLAnchorElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next: AuthMode = event.key === 'Home'
      ? 'signin'
      : event.key === 'End' ? 'register' : (mode === 'signin' ? 'register' : 'signin');
    if (next !== mode) {
      navigate(hrefFor(next), { flushSync: true });
      document.getElementById(`auth-tab-${next}`)?.focus();
    }
  }

  return <div className="auth-switch" role="tablist" aria-label="Host access">
    {TABS.map((tab) => {
      const selected = tab.id === mode;
      return <Link
        key={tab.id}
        to={hrefFor(tab.id)}
        role="tab"
        id={`auth-tab-${tab.id}`}
        aria-selected={selected}
        // Only the selected tab's panel is on this page. Naming the other one would
        // point `aria-controls` at an id that does not exist here.
        aria-controls={selected ? `auth-panel-${tab.id}` : undefined}
        tabIndex={selected ? 0 : -1}
        onKeyDown={onKeyDown}
      >{tab.label}</Link>;
    })}
  </div>;
}

// `returnTo` has already been through `safeReturnTo`, so this only reads the id back
// out of a path known to be one of the two accepted shapes. It is not a second
// validator and must never become the thing that decides a path is acceptable.
const MANAGER_EVENT = /^\/manage\/event\/([0-9a-f-]+)$/iu;

type Resolution =
  | { state: 'pending' }
  | { state: 'named'; name: string; date: string }
  | { state: 'anonymous' };

function formatEventDate(value: string): string {
  const parsed = new Date(value.length === 10 ? `${value}T00:00:00.000Z` : value);
  return Number.isNaN(parsed.getTime())
    ? ''
    : parsed.toLocaleDateString(undefined, { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' });
}

// What the URL already carries, said out loud. Signing in and attaching are two
// outcomes and the second one can fail on its own, so the promise is worded from
// `adopt` rather than assumed from arrival.
//
// The name and date are resolved from the API by event id — never read from the query
// string, which is attacker-controlled and validated for navigation only.
export function AuthReturnNote({ returnTo, adopt }: RecoveryContext) {
  const eventId = returnTo ? MANAGER_EVENT.exec(returnTo)?.[1] ?? null : null;
  const [resolved, setResolved] = useState<Resolution>({ state: 'pending' });

  useEffect(() => {
    if (!eventId) return undefined;
    let live = true;
    // The management cookie the host arrived with is what authorizes this read, and
    // on a recovery it may already be the thing that expired. A refusal is not worth
    // an error: the note loses the event's name and keeps its promise.
    api<{ event: EventView }>(`/api/manage/events/${encodeURIComponent(eventId)}`)
      .then((result) => {
        if (!live) return;
        setResolved(result?.event?.name
          ? { state: 'named', name: result.event.name, date: result.event.eventDate }
          : { state: 'anonymous' });
      })
      .catch(() => { if (live) setResolved({ state: 'anonymous' }); });
    return () => { live = false; };
  }, [eventId]);

  // Nothing is rendered until the lookup settles, so the note appears once rather
  // than reflowing the panel's first line under the host as they read it.
  if (!eventId || resolved.state === 'pending') return null;

  const date = resolved.state === 'named' ? formatEventDate(resolved.date) : '';
  return <div className="auth-return">
    {resolved.state === 'named' && <p className="auth-return__event">
      <span className="auth-return__marker" aria-hidden="true" />
      {resolved.name}
      {date && <span className="auth-return__date" aria-hidden="true"> · {date}</span>}
    </p>}
    <p>{adopt
      ? 'You will come back here, and this event will be added to your account.'
      : 'You will come back here when you are done.'}</p>
  </div>;
}

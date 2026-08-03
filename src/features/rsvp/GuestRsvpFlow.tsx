import { useEffect, useRef, useState } from 'react';

import type {
  GuestEventView,
  RsvpHouseholdView,
  RsvpLookupResponse,
  RsvpSubmissionResponse,
} from '../../../shared/contracts';
import { api, ClientApiError } from '../../app/api';
import { rememberGuestName } from '../../app/guest-name-storage';
import { RsvpHouseholdForm } from './RsvpHouseholdForm';
import { RsvpLookup } from './RsvpLookup';
import { RsvpReceipt } from './RsvpReceipt';
import { RsvpShell } from './RsvpShell';
import {
  createHouseholdDraft,
  type RsvpDraft,
  submissionInvitees,
} from './rsvp-form';

type Presentation = 'primary' | 'secondary' | 'embedded';

type Screen =
  | { kind: 'restoring' }
  | { kind: 'lookup'; secondNameRequired: boolean }
  | { kind: 'editing'; household: RsvpHouseholdView; draft: RsvpDraft }
  | { kind: 'saving'; household: RsvpHouseholdView; draft: RsvpDraft }
  | { kind: 'receipt'; household: RsvpHouseholdView }
  | { kind: 'read-only'; household: RsvpHouseholdView }
  | { kind: 'before-start'; household: RsvpHouseholdView }
  | { kind: 'closed' }
  | { kind: 'paused'; household: RsvpHouseholdView | null };

interface GuestRsvpFlowProps {
  event: GuestEventView;
  presentation: Presentation;
}
/* `presentation` decides layout and nothing else. What a household may do comes from `rsvpAccess`,
   the same sentence the guest RSVP routes enforce, so the interface and the boundary can never
   disagree about a window the browser has no clock to resolve. */
function screenForHousehold(
  event: GuestEventView,
  household: RsvpHouseholdView,
): Screen {
  // Read-only is the pre-start window: the deadline has gone, the event has not begun, and the
  // household reads back what it already sent. It outranks the paused wording, because before the
  // start a paused roster still says the same thing to a household — nothing more is coming.
  if (event.rsvpAccess === 'read-only') return { kind: 'before-start', household };
  if (event.rsvpState === 'paused' || event.rsvpState === 'disabled') {
    return { kind: 'paused', household };
  }
  if (event.rsvpState !== 'open' || !household.editable) {
    return { kind: 'read-only', household };
  }
  if (household.renewalRequired) return { kind: 'read-only', household };
  if (household.firstRespondedAt) return { kind: 'receipt', household };
  return { kind: 'editing', household, draft: createHouseholdDraft(household) };
}

function screenWithoutHousehold(event: GuestEventView): Screen {
  // Lookup is offered wherever the server still answers one — including the read-only window, which
  // is the whole point of it: a household arriving on a new device may still read its response.
  return event.rsvpAccess === 'editable' || event.rsvpAccess === 'read-only'
    ? { kind: 'lookup', secondNameRequired: false }
    : { kind: 'paused', household: null };
}

/**
 * Where a refused write lands.
 *
 * The write path has no separate closed or paused refusal: a deadline that
 * passes, RSVP being paused, or the session's write window lapsing all fail the
 * server's guarded write and come back as a conflict. So the refetched household
 * is the only thing that says whether answering is still possible, and it has to
 * be read — reopening the form unconditionally would leave a guest pressing a
 * Submit button the server can never accept.
 */
function screenAfterConflict(
  event: GuestEventView,
  household: RsvpHouseholdView,
  draft: RsvpDraft,
): Screen {
  const settled = screenForHousehold(event, household);
  // A household that may still write goes back to the form even if it has
  // answered before, because the point of the conflict is to review and resend.
  if (settled.kind !== 'receipt' && settled.kind !== 'editing') return settled;
  // Only a roster whose people actually changed invalidates what was typed. A
  // host correcting attendance — or a transient fault reported as a conflict —
  // must not silently discard answers the guest still has on screen.
  const sameRoster = household.invitees.length === Object.keys(draft).length
    && household.invitees.every((invitee) => draft[invitee.id]);
  return {
    kind: 'editing',
    household,
    draft: sameRoster ? draft : createHouseholdDraft(household),
  };
}

export function GuestRsvpFlow({ event, presentation }: GuestRsvpFlowProps) {
  const [screen, setScreen] = useState<Screen>({ kind: 'restoring' });
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupMessage, setLookupMessage] = useState('');
  const [saveError, setSaveError] = useState('');
  const [reviewUpdated, setReviewUpdated] = useState(false);
  const idempotencyKey = useRef<string | null>(null);
  const requestGeneration = useRef(0);

  useEffect(() => {
    const generation = ++requestGeneration.current;
    setScreen({ kind: 'restoring' });
    setLookupBusy(false);
    setLookupMessage('');
    setSaveError('');
    setReviewUpdated(false);
    // No access, no request. A caller is not supposed to mount this at all here, but a household
    // read is itself an act on the guest's behalf, and the server would only refuse it.
    if (event.rsvpAccess === 'unavailable') {
      setScreen({ kind: 'paused', household: null });
      return () => { requestGeneration.current += 1; };
    }
    void api<{ household: RsvpHouseholdView }>(`/api/event/${event.slug}/rsvp/household`)
      .then(({ household }) => {
        if (requestGeneration.current === generation) {
          setScreen(screenForHousehold(event, household));
        }
      })
      .catch((caught: unknown) => {
        if (requestGeneration.current !== generation) return;
        if (caught instanceof ClientApiError && caught.code === 'RSVP_SESSION_REQUIRED') {
          setScreen(screenWithoutHousehold(event));
          return;
        }
        setLookupMessage(caught instanceof Error ? caught.message : 'We could not check for a saved RSVP.');
        setScreen(screenWithoutHousehold(event));
      });
    return () => { requestGeneration.current += 1; };
  }, [event.rsvpAccess, event.rsvpState, event.slug]);

  async function lookup(firstName: string, secondName?: string) {
    const generation = requestGeneration.current;
    setLookupBusy(true);
    setLookupMessage('');
    try {
      const result = await api<RsvpLookupResponse>(`/api/event/${event.slug}/rsvp/lookup`, {
        method: 'POST',
        body: JSON.stringify({
          firstName,
          ...(secondName ? { secondName } : {}),
        }),
      });
      if (requestGeneration.current !== generation) return;
      if (result.status === 'second_name_required') {
        setScreen({ kind: 'lookup', secondNameRequired: true });
        setLookupMessage('Enter the full name of another person on this invitation.');
        return;
      }
      if (result.status === 'not_available') {
        setLookupMessage(result.message);
        return;
      }
      rememberGuestName(firstName.trim());
      setReviewUpdated(false);
      setScreen(screenForHousehold(event, result.household));
    } catch (caught) {
      if (requestGeneration.current !== generation) return;
      setLookupMessage(caught instanceof Error ? caught.message : 'We could not find that invitation.');
    } finally {
      if (requestGeneration.current === generation) setLookupBusy(false);
    }
  }

  async function readCurrentHousehold() {
    return api<{ household: RsvpHouseholdView }>(`/api/event/${event.slug}/rsvp/household`);
  }

  async function submit(household: RsvpHouseholdView, draft: RsvpDraft) {
    const generation = requestGeneration.current;
    const key = idempotencyKey.current ?? crypto.randomUUID();
    idempotencyKey.current = key;
    setSaveError('');
    setScreen({ kind: 'saving', household, draft });
    try {
      const result = await api<RsvpSubmissionResponse>(`/api/event/${event.slug}/rsvp/household`, {
        method: 'PUT',
        body: JSON.stringify({
          version: household.version,
          idempotencyKey: key,
          invitees: submissionInvitees(household, draft),
        }),
      });
      if (requestGeneration.current !== generation) return;
      setReviewUpdated(false);
      setScreen({ kind: 'receipt', household: result.household });
    } catch (caught) {
      if (requestGeneration.current !== generation) return;
      if (caught instanceof ClientApiError && caught.code === 'RSVP_HOUSEHOLD_CONFLICT') {
        try {
          const current = await readCurrentHousehold();
          if (requestGeneration.current !== generation) return;
          idempotencyKey.current = null;
          const next = screenAfterConflict(event, current.household, draft);
          // The review banner is an instruction, so it belongs only where the
          // guest can still act on it.
          setReviewUpdated(next.kind === 'editing');
          setScreen(next);
          return;
        } catch (refreshError) {
          if (requestGeneration.current !== generation) return;
          if (refreshError instanceof ClientApiError && refreshError.code === 'RSVP_CLOSED') {
            idempotencyKey.current = null;
            setReviewUpdated(false);
            setScreen({ kind: 'closed' });
            return;
          }
          setSaveError(refreshError instanceof Error
            ? refreshError.message
            : 'The invitation changed, but we could not reload it.');
        }
      } else if (caught instanceof ClientApiError && caught.code === 'RSVP_CLOSED') {
        idempotencyKey.current = null;
        setScreen({ kind: 'closed' });
        return;
      } else if (caught instanceof ClientApiError && caught.code === 'RSVP_UNAVAILABLE') {
        try {
          const current = await readCurrentHousehold();
          if (requestGeneration.current !== generation) return;
          setScreen({ kind: 'paused', household: current.household });
          return;
        } catch {
          if (requestGeneration.current !== generation) return;
          setScreen({ kind: 'paused', household: null });
          return;
        }
      } else if (caught instanceof ClientApiError && caught.code === 'RSVP_SESSION_REQUIRED') {
        idempotencyKey.current = null;
        setLookupMessage('Find your invitation again to continue.');
        setScreen({ kind: 'lookup', secondNameRequired: false });
        return;
      } else {
        setSaveError('We could not save your RSVP. Your answers are still here.');
      }
      setScreen({ kind: 'editing', household, draft });
    }
  }

  function changeDraft(draft: RsvpDraft) {
    // A changed payload is a new submission intent. Keeping the earlier key
    // would correctly trigger a server digest conflict if the dropped request
    // actually committed, but would strand the guest instead of letting the
    // normal version check refetch that winning response.
    idempotencyKey.current = null;
    setSaveError('');
    setScreen((current) => current.kind === 'editing'
      ? { ...current, draft }
      : current);
  }

  function changeResponse(household: RsvpHouseholdView) {
    idempotencyKey.current = null;
    setSaveError('');
    setReviewUpdated(false);
    if (event.rsvpAccess !== 'editable') {
      setScreen(screenForHousehold(event, household));
      return;
    }
    setScreen({ kind: 'editing', household, draft: createHouseholdDraft(household) });
  }

  // Effects retire stale requests, but they run after render. Never paint an
  // editable or saving form for even one frame after the authoritative event
  // prop has moved out of editable access.
  const renderedScreen: Screen = (
    (screen.kind === 'editing' || screen.kind === 'saving')
    && event.rsvpAccess !== 'editable'
  )
    ? event.rsvpAccess === 'unavailable'
      && event.rsvpState !== 'paused'
      && event.rsvpState !== 'disabled'
      ? { kind: 'closed' }
      : screenForHousehold(event, screen.household)
    : screen;

  if (renderedScreen.kind === 'restoring') {
    return <RsvpShell event={event} presentation={presentation}>
      <div className="rsvp-card rsvp-restoring" aria-live="polite">
        <p>Checking for a saved RSVP…</p>
      </div>
    </RsvpShell>;
  }

  if (renderedScreen.kind === 'lookup') {
    return <RsvpLookup
      event={event}
      presentation={presentation}
      secondNameRequired={renderedScreen.secondNameRequired}
      busy={lookupBusy}
      message={lookupMessage}
      onLookup={lookup}
    />;
  }

  if (renderedScreen.kind === 'editing' || renderedScreen.kind === 'saving') {
    return <RsvpHouseholdForm
      event={event}
      presentation={presentation}
      household={renderedScreen.household}
      draft={renderedScreen.draft}
      saving={renderedScreen.kind === 'saving'}
      saveError={saveError}
      reviewUpdated={reviewUpdated}
      onDraftChange={changeDraft}
      onSubmit={(draft) => submit(renderedScreen.household, draft)}
    />;
  }

  if (renderedScreen.kind === 'receipt') {
    return <RsvpReceipt
      event={event}
      presentation={presentation}
      household={renderedScreen.household}
      mode="receipt"
      onChange={() => changeResponse(renderedScreen.household)}
      onRenew={() => setScreen({ kind: 'lookup', secondNameRequired: false })}
    />;
  }

  if (renderedScreen.kind === 'read-only') {
    return <RsvpReceipt
      event={event}
      presentation={presentation}
      household={renderedScreen.household}
      mode="read-only"
      onChange={() => changeResponse(renderedScreen.household)}
      onRenew={() => setScreen({ kind: 'lookup', secondNameRequired: false })}
    />;
  }

  if (renderedScreen.kind === 'before-start') {
    return <RsvpReceipt
      event={event}
      presentation={presentation}
      household={renderedScreen.household}
      mode="before-start"
      onChange={() => undefined}
      onRenew={() => setScreen({ kind: 'lookup', secondNameRequired: false })}
    />;
  }

  if (renderedScreen.kind === 'closed') {
    const HeadingTag = presentation === 'embedded' ? 'h2' : 'h1';
    return <RsvpShell event={event} presentation={presentation}>
      <div className="rsvp-card rsvp-unavailable" aria-live="polite">
        {presentation !== 'embedded' && <p className="rsvp-eyebrow">{event.name}</p>}
        <HeadingTag>RSVP is closed</HeadingTag>
        <p>The event has started, so guest RSVP is no longer available.</p>
      </div>
    </RsvpShell>;
  }

  if (renderedScreen.household) {
    return <RsvpReceipt
      event={event}
      presentation={presentation}
      household={renderedScreen.household}
      mode="paused"
      onChange={() => undefined}
      onRenew={() => setScreen({ kind: 'lookup', secondNameRequired: false })}
    />;
  }

  const HeadingTag = presentation === 'embedded' ? 'h2' : 'h1';
  return <RsvpShell event={event} presentation={presentation}>
    <div className="rsvp-card rsvp-unavailable" aria-live="polite">
      {presentation !== 'embedded' && <p className="rsvp-eyebrow">{event.name}</p>}
      <HeadingTag>{event.rsvpState === 'paused' ? 'RSVP is paused' : 'RSVP is closed'}</HeadingTag>
      <p>{event.rsvpState === 'paused'
        ? 'The host has paused RSVP for now. Try again later.'
        : 'The response deadline has passed.'}</p>
    </div>
  </RsvpShell>;
}

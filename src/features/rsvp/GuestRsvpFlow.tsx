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

type Presentation = 'primary' | 'secondary' | 'read-only';

type Screen =
  | { kind: 'restoring' }
  | { kind: 'lookup'; secondNameRequired: boolean }
  | { kind: 'editing'; household: RsvpHouseholdView; draft: RsvpDraft }
  | { kind: 'saving'; household: RsvpHouseholdView; draft: RsvpDraft }
  | { kind: 'receipt'; household: RsvpHouseholdView }
  | { kind: 'read-only'; household: RsvpHouseholdView }
  | { kind: 'paused'; household: RsvpHouseholdView | null };

interface GuestRsvpFlowProps {
  event: GuestEventView;
  presentation: Presentation;
}
function screenForHousehold(
  event: GuestEventView,
  presentation: Presentation,
  household: RsvpHouseholdView,
): Screen {
  if (event.rsvpState === 'paused' || event.rsvpState === 'disabled') {
    return { kind: 'paused', household };
  }
  if (event.rsvpState !== 'open' || presentation === 'read-only' || !household.editable) {
    return { kind: 'read-only', household };
  }
  if (household.renewalRequired) return { kind: 'read-only', household };
  if (household.firstRespondedAt) return { kind: 'receipt', household };
  return { kind: 'editing', household, draft: createHouseholdDraft(household) };
}

function screenWithoutHousehold(event: GuestEventView): Screen {
  return event.rsvpState === 'open'
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
  presentation: Presentation,
  household: RsvpHouseholdView,
  draft: RsvpDraft,
): Screen {
  const settled = screenForHousehold(event, presentation, household);
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

  useEffect(() => {
    let active = true;
    setScreen({ kind: 'restoring' });
    setLookupMessage('');
    setSaveError('');
    setReviewUpdated(false);
    void api<{ household: RsvpHouseholdView }>(`/api/event/${event.slug}/rsvp/household`)
      .then(({ household }) => {
        if (active) setScreen(screenForHousehold(event, presentation, household));
      })
      .catch((caught: unknown) => {
        if (!active) return;
        if (caught instanceof ClientApiError && caught.code === 'RSVP_SESSION_REQUIRED') {
          setScreen(screenWithoutHousehold(event));
          return;
        }
        setLookupMessage(caught instanceof Error ? caught.message : 'We could not check for a saved RSVP.');
        setScreen(screenWithoutHousehold(event));
      });
    return () => { active = false; };
  }, [event.rsvpState, event.slug, presentation]);

  async function lookup(firstName: string, secondName?: string) {
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
      setScreen(screenForHousehold(event, presentation, result.household));
    } catch (caught) {
      setLookupMessage(caught instanceof Error ? caught.message : 'We could not find that invitation.');
    } finally {
      setLookupBusy(false);
    }
  }

  async function readCurrentHousehold() {
    return api<{ household: RsvpHouseholdView }>(`/api/event/${event.slug}/rsvp/household`);
  }

  async function submit(household: RsvpHouseholdView, draft: RsvpDraft) {
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
      setReviewUpdated(false);
      setScreen({ kind: 'receipt', household: result.household });
    } catch (caught) {
      if (caught instanceof ClientApiError && caught.code === 'RSVP_HOUSEHOLD_CONFLICT') {
        try {
          const current = await readCurrentHousehold();
          idempotencyKey.current = null;
          const next = screenAfterConflict(event, presentation, current.household, draft);
          // The review banner is an instruction, so it belongs only where the
          // guest can still act on it.
          setReviewUpdated(next.kind === 'editing');
          setScreen(next);
          return;
        } catch (refreshError) {
          setSaveError(refreshError instanceof Error
            ? refreshError.message
            : 'The invitation changed, but we could not reload it.');
        }
      } else if (caught instanceof ClientApiError && caught.code === 'RSVP_CLOSED') {
        try {
          const current = await readCurrentHousehold();
          setScreen({ kind: 'read-only', household: current.household });
          return;
        } catch {
          // The original deadline message remains the most useful recovery hint.
        }
      } else if (caught instanceof ClientApiError && caught.code === 'RSVP_UNAVAILABLE') {
        try {
          const current = await readCurrentHousehold();
          setScreen({ kind: 'paused', household: current.household });
          return;
        } catch {
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
    setScreen({ kind: 'editing', household, draft: createHouseholdDraft(household) });
  }

  if (screen.kind === 'restoring') {
    return <RsvpShell event={event} presentation={presentation}>
      <div className="rsvp-card rsvp-restoring" aria-live="polite">
        <p>Checking for a saved RSVP…</p>
      </div>
    </RsvpShell>;
  }

  if (screen.kind === 'lookup') {
    return <RsvpLookup
      event={event}
      presentation={presentation}
      secondNameRequired={screen.secondNameRequired}
      busy={lookupBusy}
      message={lookupMessage}
      onLookup={lookup}
    />;
  }

  if (screen.kind === 'editing' || screen.kind === 'saving') {
    return <RsvpHouseholdForm
      event={event}
      presentation={presentation}
      household={screen.household}
      draft={screen.draft}
      saving={screen.kind === 'saving'}
      saveError={saveError}
      reviewUpdated={reviewUpdated}
      onDraftChange={changeDraft}
      onSubmit={(draft) => submit(screen.household, draft)}
    />;
  }

  if (screen.kind === 'receipt') {
    return <RsvpReceipt
      event={event}
      presentation={presentation}
      household={screen.household}
      mode="receipt"
      onChange={() => changeResponse(screen.household)}
      onRenew={() => setScreen({ kind: 'lookup', secondNameRequired: false })}
    />;
  }

  if (screen.kind === 'read-only') {
    return <RsvpReceipt
      event={event}
      presentation={presentation}
      household={screen.household}
      mode="read-only"
      onChange={() => changeResponse(screen.household)}
      onRenew={() => setScreen({ kind: 'lookup', secondNameRequired: false })}
    />;
  }

  if (screen.household) {
    return <RsvpReceipt
      event={event}
      presentation={presentation}
      household={screen.household}
      mode="paused"
      onChange={() => undefined}
      onRenew={() => setScreen({ kind: 'lookup', secondNameRequired: false })}
    />;
  }

  return <RsvpShell event={event} presentation={presentation}>
    <div className="rsvp-card rsvp-unavailable" aria-live="polite">
      <p className="rsvp-eyebrow">{event.name}</p>
      <h1>{event.rsvpState === 'paused' ? 'RSVP is paused' : 'RSVP is closed'}</h1>
      <p>{event.rsvpState === 'paused'
        ? 'The host has paused RSVP for now. Try again later.'
        : 'The response deadline has passed.'}</p>
    </div>
  </RsvpShell>;
}

import { useEffect, useRef } from 'react';

import type {
  GuestEventView,
  RsvpHouseholdView,
} from '../../../shared/contracts';
import { RsvpShell } from './RsvpShell';

interface RsvpReceiptProps {
  event: GuestEventView;
  presentation: 'primary' | 'secondary' | 'embedded';
  household: RsvpHouseholdView;
  mode: 'receipt' | 'read-only' | 'before-start' | 'paused';
  focusHeading?: boolean;
  onChange: () => void;
  onRenew: () => void;
}
function displayDeadline(value: string, timeZone: string) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone,
  }).format(new Date(value));
}

export function RsvpReceipt({
  event,
  presentation,
  household,
  mode,
  focusHeading = false,
  onChange,
  onRenew,
}: RsvpReceiptProps) {
  const attending = household.invitees.filter((invitee) => invitee.attendance === 'attending').length;
  const declined = household.invitees.filter((invitee) => invitee.attendance === 'declined').length;
  const renewalRequired = event.rsvpState === 'open'
    && (!household.editable || household.renewalRequired)
    && mode !== 'paused';
  const canChange = mode === 'receipt'
    && event.rsvpState === 'open'
    && household.editable
    && !household.renewalRequired;
  const HeadingTag = presentation === 'embedded' ? 'h2' : 'h1';
  const headingRef = useRef<HTMLHeadingElement>(null);
  const hasSavedResponse = Boolean(household.firstRespondedAt);
  let heading = mode === 'receipt' ? "You're all set" : 'Your RSVP';
  if (event.phase === 'before-start' && mode === 'before-start' && hasSavedResponse) {
    heading = 'Your RSVP is saved';
  }
  let plusOneNumber = 0;

  useEffect(() => {
    if (focusHeading) headingRef.current?.focus();
  }, [focusHeading, household.id]);

  return <RsvpShell event={event} presentation={presentation} className="rsvp-flow--receipt">
    <div className="rsvp-card rsvp-receipt" aria-live="polite">
      {/* The containing page already identifies the event for an embedded receipt. */}
      {presentation !== 'embedded' && <p className="rsvp-eyebrow">{event.name}</p>}
      <HeadingTag ref={headingRef} tabIndex={-1}>
        {heading}
      </HeadingTag>
      {mode === 'receipt' && <p>Your household response has been saved.</p>}
      {mode === 'read-only' && event.rsvpState !== 'open' && <p>
        RSVP is closed. Your saved response is shown below.
      </p>}
      {/* Whether this household answered is stated outright. Inferring it from closed copy is what
          left a household that never responded reading the same page as one that did. */}
      {mode === 'before-start' && <>
        {!hasSavedResponse && <p>There isn't a saved RSVP for this household.</p>}
        <p>{hasSavedResponse ? 'RSVP changes are closed.' : 'RSVP is closed.'}</p>
      </>}
      {mode === 'paused' && <p>RSVP is paused. Your saved response is still here.</p>}
      {renewalRequired && <p>The deadline was extended. Find your invitation again before making changes.</p>}

      {(mode !== 'before-start' || household.invitees.length > 1) && <p className="rsvp-counts">
        {attending} attending · {declined} not attending
      </p>}
      <ul className="rsvp-receipt__roster">
        {household.invitees.map((invitee) => {
          if (invitee.kind === 'plus_one') plusOneNumber += 1;
          const rowName = invitee.kind === 'named'
            ? invitee.displayName
            : invitee.displayName || `Plus one ${plusOneNumber}`;
          const attendance = invitee.attendance === 'attending'
            ? 'Attending'
            : invitee.attendance === 'declined'
              ? 'Not attending'
              : 'Not answered';
          return <li key={invitee.id}>
            <span>{rowName}</span>
            <strong className={`rsvp-response rsvp-response--${invitee.attendance}`}>{attendance}</strong>
          </li>;
        })}
      </ul>
      {/* Before the start the deadline is already behind the household, and repeating it is exactly
          the dead end this window replaces. */}
      {mode !== 'before-start' && <p className="rsvp-receipt__deadline">
        Changes close {displayDeadline(household.deadlineAt, event.eventTimezone)}.
      </p>}
      {canChange && <button className="rsvp-button rsvp-button--secondary" type="button" onClick={onChange}>
        Change RSVP
      </button>}
      {renewalRequired && <button className="rsvp-button rsvp-button--secondary" type="button" onClick={onRenew}>
        Find my invitation again
      </button>}
    </div>
  </RsvpShell>;
}

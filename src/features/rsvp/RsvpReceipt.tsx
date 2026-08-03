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
  let plusOneNumber = 0;

  return <RsvpShell event={event} presentation={presentation} className="rsvp-flow--receipt">
    <div className="rsvp-card rsvp-receipt" aria-live="polite">
      {/* The before-start page names the event in its hero and again in its start line; a third
          reading of it here would be the only new copy on that surface. */}
      {presentation !== 'embedded' && <p className="rsvp-eyebrow">{event.name}</p>}
      <HeadingTag>{mode === 'receipt' ? "You're all set" : 'Your RSVP'}</HeadingTag>
      {mode === 'receipt' && <p>Your household response has been saved.</p>}
      {mode === 'read-only' && event.rsvpState !== 'open' && <p>
        RSVP is closed. Your saved response is shown below.
      </p>}
      {/* Whether this household answered is stated outright. Inferring it from closed copy is what
          left a household that never responded reading the same page as one that did. */}
      {mode === 'before-start' && <p>{household.firstRespondedAt
        ? 'We appreciate your RSVP. Your saved household response is below.'
        : "There isn't a saved RSVP for this household."}</p>}
      {mode === 'paused' && <p>RSVP is paused. Your saved response is still here.</p>}
      {renewalRequired && <p>The deadline was extended. Find your invitation again before making changes.</p>}

      <p className="rsvp-counts">{attending} attending · {declined} not attending</p>
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

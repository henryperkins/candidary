import type { GuestEventView } from '../../../shared/contracts';
import { guestEventCoverSlotPath } from '../../app/api';
import { GuestEventHero } from '../../components/GuestEventHero';
import { GuestRsvpFlow } from '../rsvp/GuestRsvpFlow';

/* Both fragments are formatted in the event's own zone, never the device's. A guest reading this
   from another time zone — or on a phone whose clock is wrong — is still told the host's start. */
function startDate(value: string, timeZone: string) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone,
  }).format(new Date(value));
}

function startTime(value: string, timeZone: string) {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(new Date(value));
}

/**
 * The window between a shut RSVP and the event's own start.
 *
 * It is a product state rather than a fallback: it names when the event begins and says photos
 * follow it, instead of talking about a deadline the guest can no longer act on. The household
 * portion is the ordinary RSVP flow embedded — reusing lookup and receipt, so a household arriving
 * on a device that never held a session can still read back what it sent.
 */
export function GuestBeforeStart({
  event,
  guestName,
  onGuestNameChange,
}: {
  event: GuestEventView;
  guestName?: string;
  onGuestNameChange?: (name: string) => void;
}) {
  return <section className="rsvp-flow rsvp-flow--with-hero guest-before-start">
    <GuestEventHero
      event={event}
      sourceFor={(slot) => guestEventCoverSlotPath(event.slug, slot)}
      lookup={false}
      welcomeIsHeading={false}
    />
    <div className="rsvp-flow__body">
      <header className="rsvp-identity">
        <h1>The event hasn't started yet</h1>
        <p>{event.name} begins {startDate(event.eventStartAt, event.eventTimezone)} at {startTime(event.eventStartAt, event.eventTimezone)}.</p>
        <p>Come back when the event begins to take or add photos.</p>
      </header>
      {/* An event that never adopted RSVP — and one whose household window has closed for good —
          gets no household affordance here, and issues no household request either. */}
      {event.rsvpAccess !== 'unavailable' && <GuestRsvpFlow
        event={event}
        presentation="embedded"
        guestName={guestName}
        onGuestNameChange={onGuestNameChange}
      />}
    </div>
  </section>;
}

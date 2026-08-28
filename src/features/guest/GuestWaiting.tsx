import type { GuestEventView } from '../../../shared/contracts';
import { guestEventCoverSlotPath } from '../../app/api';
import { GuestEventHero } from '../../components/GuestEventHero';

/**
 * The event has started and new guest uploads are currently unavailable.
 *
 * That is now the only thing `waiting` means, so the surface says exactly that and nothing more.
 * The hero still names the event — the same one the before-start page draws, because a guest who
 * rechecked across the start must land on the same product, not a different page. Nothing about
 * RSVP mounts: at or after the start it has left the guest experience entirely.
 */
export function GuestWaiting({ event }: { event: GuestEventView }) {
  return <section className="rsvp-flow rsvp-flow--with-hero guest-waiting">
    <GuestEventHero
      event={event}
      sourceFor={(slot) => guestEventCoverSlotPath(event.slug, slot)}
      lookup={false}
      welcomeIsHeading={false}
    />
    <div className="rsvp-flow__body">
      <div className="rsvp-card">
        <h1>New guest uploads are paused</h1>
        <p>The host has paused new guest uploads for now. Shared photos, Guestbook, and My deliveries are still available below.</p>
      </div>
    </div>
  </section>;
}

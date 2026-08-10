import type { GuestEventView } from '../../../shared/contracts';
import { GuestEventHero } from '../../components/GuestEventHero';

/**
 * The event has started and photo delivery is currently unavailable.
 *
 * That is now the only thing `waiting` means, so the surface says exactly that and nothing more.
 * The hero still names the event — the same one the before-start page draws, because a guest who
 * rechecked across the start must land on the same product, not a different page. Nothing about
 * RSVP mounts: at or after the start it has left the guest experience entirely.
 */
export function GuestWaiting({ event }: { event: GuestEventView }) {
  return <section className="rsvp-flow rsvp-flow--with-hero guest-waiting">
    <GuestEventHero
      name={event.name}
      eventDate={event.eventDate}
      welcomeMessage={event.welcomeMessage}
      hasCover={event.cover.hasCover}
      slug={event.slug}
      welcomeIsHeading={false}
    />
    <div className="rsvp-flow__body">
      <div className="rsvp-card">
        <h1>Photo delivery is paused</h1>
        <p>The host has paused photo delivery for now. Please try again later.</p>
      </div>
    </div>
  </section>;
}

import type { ReactNode } from 'react';

import type { GuestEventView } from '../../../shared/contracts';
import { GuestEventHero } from '../../components/GuestEventHero';

type Presentation = 'primary' | 'secondary' | 'read-only';

interface RsvpShellProps {
  event: GuestEventView;
  presentation: Presentation;
  className?: string;
  children: ReactNode;
}

/* Primary and waiting (read-only) are full-page guest surfaces — same hero the photo drop uses.
   Secondary sits inside the photos-primary disclosure and keeps the compact text identity. */
export function RsvpShell({ event, presentation, className, children }: RsvpShellProps) {
  const withHero = presentation === 'primary' || presentation === 'read-only';
  const classes = [
    'rsvp-flow',
    `rsvp-flow--${presentation}`,
    withHero ? 'rsvp-flow--with-hero' : '',
    className ?? '',
  ].filter(Boolean).join(' ');

  return <section className={classes}>
    {withHero && <GuestEventHero
      name={event.name}
      eventDate={event.eventDate}
      welcomeMessage={event.welcomeMessage}
      coverObjectKey={event.coverObjectKey}
      slug={event.slug}
      welcomeIsHeading={false}
    />}
    {withHero ? <div className="rsvp-flow__body">{children}</div> : children}
  </section>;
}

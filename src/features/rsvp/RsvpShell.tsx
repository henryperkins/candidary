import type { ReactNode } from 'react';

import type { GuestEventView } from '../../../shared/contracts';
import { guestEventCoverSlotPath } from '../../app/api';
import { GuestEventHero } from '../../components/GuestEventHero';

type Presentation = 'primary' | 'secondary' | 'embedded';

interface RsvpShellProps {
  event: GuestEventView;
  presentation: Presentation;
  className?: string;
  lookup?: boolean;
  children: ReactNode;
}

/* Layout only — authority over what a household may do comes from `rsvpAccess`. Primary is the
   full-page RSVP surface and owns the hero the photo drop uses. Secondary sits inside the
   photos-primary disclosure, and embedded sits inside the before-start page, which already drew
   that hero and owns the level-one heading; neither may draw a second one. */
export function RsvpShell({ event, presentation, className, lookup = false, children }: RsvpShellProps) {
  const withHero = presentation === 'primary';
  const classes = [
    'rsvp-flow',
    `rsvp-flow--${presentation}`,
    withHero ? 'rsvp-flow--with-hero' : '',
    className ?? '',
  ].filter(Boolean).join(' ');

  return <section className={classes}>
    {withHero && <GuestEventHero
      event={event}
      sourceFor={(slot) => guestEventCoverSlotPath(event.slug, slot)}
      lookup={lookup}
      welcomeIsHeading={false}
    />}
    {withHero ? <div className="rsvp-flow__body">{children}</div> : children}
  </section>;
}

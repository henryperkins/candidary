import { type CSSProperties, useState } from 'react';

import { guestEventCoverPath } from '../app/api';
import { useEventCover } from '../app/use-event-cover';

export interface GuestEventHeroProps {
  name: string;
  eventDate: string;
  welcomeMessage: string;
  coverObjectKey?: string | null;
  slug: string;
  /* Photo drop owns the page heading here. RSVP keeps its task heading, so the
     welcome is painted the same size without claiming another level-one. */
  welcomeIsHeading?: boolean;
}

function eventDateLabel(eventDate: string) {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })
    .format(new Date(`${eventDate}T12:00:00`));
}

export function GuestEventHero({
  name,
  eventDate,
  welcomeMessage,
  coverObjectKey,
  slug,
  welcomeIsHeading = true,
}: GuestEventHeroProps) {
  const cover = useEventCover(coverObjectKey ? guestEventCoverPath(slug) : null);
  const [welcomeExpanded, setWelcomeExpanded] = useState(false);
  const message = welcomeMessage || 'Help us remember tonight.';
  const welcomeNeedsDisclosure = message.length > 180;
  const heroStyle = cover
    ? ({ '--event-cover': `url("${cover}")` } as CSSProperties)
    : undefined;
  const welcomeClass = welcomeNeedsDisclosure && !welcomeExpanded
    ? 'photo-drop__welcome--clamped'
    : undefined;
  const WelcomeTag = welcomeIsHeading ? 'h1' : 'p';

  return <div
    className={`photo-drop__hero${cover ? ' photo-drop__hero--cover' : ''}${welcomeExpanded ? ' photo-drop__hero--welcome-expanded' : ''}`}
    style={heroStyle}
  >
    <div className="photo-drop__hero-copy">
      <p className="photo-drop__event">{name} <span aria-hidden="true">·</span> {eventDateLabel(eventDate)}</p>
      <WelcomeTag id="guest-welcome" className={welcomeIsHeading ? welcomeClass : `photo-drop__welcome${welcomeClass ? ` ${welcomeClass}` : ''}`}>
        {message}
      </WelcomeTag>
      {welcomeNeedsDisclosure && <button
        type="button"
        className="photo-drop__welcome-toggle"
        aria-controls="guest-welcome"
        aria-expanded={welcomeExpanded}
        onClick={() => setWelcomeExpanded((current) => !current)}
      >
        {welcomeExpanded ? 'Show less' : 'Read full welcome'}
      </button>}
    </div>
  </div>;
}

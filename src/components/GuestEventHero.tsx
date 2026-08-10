import { useState } from 'react';

import type { GuestEventCoverView } from '../../shared/event-cover';
import { emitCoverUnavailable } from '../app/cover-observability';
import { useGuestEventRefresh } from '../features/guest/GuestEventRefreshContext';
import { ResponsiveEventCover, type ResponsiveEventCoverProps } from './ResponsiveEventCover';

export interface GuestEventHeroProps {
  event: {
    name: string;
    eventDate: string;
    welcomeMessage: string;
    cover: GuestEventCoverView;
  };
  sourceFor: ResponsiveEventCoverProps['sourceFor'];
  lookup: boolean;
  /* Photo drop owns the page heading here. RSVP keeps its task heading, so the
     welcome is painted the same size without claiming another level-one. */
  welcomeIsHeading?: boolean;
}

function eventDateLabel(eventDate: string) {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })
    .format(new Date(`${eventDate}T12:00:00`));
}

export function GuestEventHero({
  event,
  sourceFor,
  lookup,
  welcomeIsHeading = true,
}: GuestEventHeroProps) {
  const refreshEvent = useGuestEventRefresh();
  const [welcomeExpanded, setWelcomeExpanded] = useState(false);
  const message = event.welcomeMessage || 'Help us remember tonight.';
  const welcomeNeedsDisclosure = message.length > 180;
  const welcomeClass = welcomeNeedsDisclosure && !welcomeExpanded
    ? 'photo-drop__welcome--clamped'
    : undefined;
  const WelcomeTag = welcomeIsHeading ? 'h1' : 'p';

  return <div className={`photo-drop__hero${welcomeExpanded ? ' photo-drop__hero--welcome-expanded' : ''}`}>
    <ResponsiveEventCover
      cover={event.cover}
      sourceFor={sourceFor}
      welcomeExpanded={welcomeExpanded}
      lookup={lookup}
      onUnavailable={({ profile, revision }) => {
        emitCoverUnavailable({ audience: 'guest', profile, revision });
      }}
      onRefreshEvent={() => {
        if (refreshEvent) void refreshEvent().catch(() => undefined);
      }}
    />
    <div className="photo-drop__hero-copy">
      <p className="photo-drop__event">{event.name} <span aria-hidden="true">·</span> {eventDateLabel(event.eventDate)}</p>
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

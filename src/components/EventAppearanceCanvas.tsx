import type { CSSProperties, ReactNode } from 'react';

import type { ResolvedEventTheme } from '../../shared/contracts';
import {
  ResponsiveEventCover,
  type ResponsiveEventCoverProps,
} from './ResponsiveEventCover';

/**
 * The live event canvas: the host sees the result where they make the choice.
 *
 * Two concerns stay separate on purpose. The guest-like layer below responds to
 * the event theme; every Manager control placed in it keeps the familiar global
 * Candidary treatment, because a legible error or a focus ring must not inherit
 * a host's chosen colors. Theme overlays and the text scrim are runtime CSS on
 * this layer and are never baked into a rendered derivative, so changing a theme
 * updates presentation without re-rendering a single image file.
 *
 * Unwired in this release. `EventAppearancePreview` stays mounted, which is why
 * the theme-overlay scope list in `design/design-system.md` is unchanged.
 */

interface EventAppearanceCanvasProps {
  name: string;
  eventDate: string;
  welcomeMessage: string;
  theme: ResolvedEventTheme;
  cover: ResponsiveEventCoverProps['cover'];
  sourceFor: ResponsiveEventCoverProps['sourceFor'];
  /** Neutral Manager chrome, rendered over the themed layer. */
  controls?: ReactNode;
  /** The cover summary, its `Change cover` action, and any status beside it. */
  summary?: ReactNode;
}

function eventDateLabel(eventDate: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })
    .format(new Date(`${eventDate}T12:00:00`));
}

export function EventAppearanceCanvas({
  name,
  eventDate,
  welcomeMessage,
  theme,
  cover,
  sourceFor,
  controls,
  summary,
}: EventAppearanceCanvasProps) {
  const themeStyle = {
    '--event-primary': theme.tokens.primary,
    '--event-accent': theme.tokens.accent,
  } as CSSProperties;

  return <div className="event-appearance-canvas">
    <div className="event-appearance-canvas__guest" style={themeStyle} data-testid="event-appearance-canvas">
      <ResponsiveEventCover cover={cover} sourceFor={sourceFor} />
      <div className="event-appearance-canvas__copy">
        <p className="event-appearance-canvas__event">
          {name} <span aria-hidden="true">·</span> {eventDateLabel(eventDate)}
        </p>
        <p className="event-appearance-canvas__welcome">
          {welcomeMessage || 'Help us remember tonight.'}
        </p>
      </div>
      {/* Inert visual samples, not nested buttons or links. They stay out of the
          tab order because no guest workflow can be run from Settings, and a
          real control here would say otherwise. */}
      <div className="event-appearance-canvas__actions" aria-hidden="true">
        <span className="event-appearance-canvas__action event-appearance-canvas__action--primary">
          Add photos
        </span>
        <span className="event-appearance-canvas__action">View gallery</span>
      </div>
    </div>

    {/* Outside the themed layer: labels, status, validation, and retry keep the
        global Manager treatment and never inherit guest colors or radii. */}
    {summary && <div className="event-appearance-canvas__summary">{summary}</div>}
    {controls && <div className="event-appearance-canvas__controls">{controls}</div>}
  </div>;
}

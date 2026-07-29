import type { CSSProperties } from 'react';

import type { EventView, ResolvedEventTheme } from '../../shared/contracts';
import { managerEventCoverPath } from '../app/api';
import { eventThemeStyle } from '../app/event-theme-style';
import { useEventCover } from '../app/use-event-cover';

type PreviewEvent = Pick<EventView, 'id' | 'name' | 'eventDate' | 'welcomeMessage' | 'coverObjectKey'>;

export interface EventAppearancePreviewProps {
  event: PreviewEvent;
  theme: ResolvedEventTheme;
}

function previewDate(eventDate: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    .format(new Date(`${eventDate}T12:00:00`));
}

export function EventAppearancePreview({ event, theme }: EventAppearancePreviewProps) {
  const coverPath = event.coverObjectKey ? managerEventCoverPath(event.id) : null;
  const coverUrl = useEventCover(coverPath);
  const style = {
    ...eventThemeStyle(theme.tokens),
    ...(coverUrl ? { '--event-cover': `url("${coverUrl}")` } : {}),
  } as CSSProperties;

  return <figure className="event-appearance-preview" data-testid="event-appearance-preview" style={style}>
    <div className="event-appearance-preview__visual" aria-hidden="true">
      <div className={`event-appearance-preview__hero${coverUrl ? ' event-appearance-preview__hero--covered' : ''}`}>
        <span className="event-appearance-preview__date">{previewDate(event.eventDate)}</span>
        <span className="event-appearance-preview__name">{event.name}</span>
        <span className="event-appearance-preview__welcome">{event.welcomeMessage}</span>
      </div>
      <div className="event-appearance-preview__surface">
        <span className="event-appearance-preview__eyebrow">Private photo drop</span>
        <span className="event-appearance-preview__title">A place for every perspective</span>
        <span className="event-appearance-preview__body">Guests can add photos and revisit the shared gallery whenever it opens.</span>
        <span className="event-appearance-preview__actions">
          <span className="event-appearance-preview__action event-appearance-preview__action--primary">Add your photos</span>
          <span className="event-appearance-preview__action event-appearance-preview__action--secondary">View the gallery</span>
        </span>
      </div>
    </div>
    <figcaption>Preview only — guests cannot interact with this sample.</figcaption>
  </figure>;
}

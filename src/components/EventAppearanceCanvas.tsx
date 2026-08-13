import type { CSSProperties, ReactNode } from 'react';

import {
  allCover2xProfiles,
  coverSurfaceTreatment,
  type EventCoverEffectId,
  type EventCoverPresetId,
} from '../../shared/event-cover';
import { presetCoverAssetPath } from '../../shared/event-cover-assets';
import type { EventView, ResolvedEventTheme } from '../../shared/contracts';
import { eventThemeStyle } from '../app/event-theme-style';
import type { CoverFocusValue } from '../features/cover/CoverComposer';
import {
  ResponsiveEventCover,
  type ResponsiveEventCoverProps,
} from './ResponsiveEventCover';

export type EventAppearanceCanvasPreview =
  | { kind: 'authoritative' }
  | { kind: 'none' }
  | {
      kind: 'preset';
      presetId: EventCoverPresetId;
      effect: EventCoverEffectId;
      assetVersion: 1;
    }
  | { kind: 'draft'; url: string; focus: CoverFocusValue };

export interface EventAppearanceCanvasProps {
  event: Pick<EventView, 'id' | 'name' | 'eventDate' | 'welcomeMessage' | 'cover'>;
  theme: ResolvedEventTheme;
  sourceFor: ResponsiveEventCoverProps['sourceFor'];
  preview?: EventAppearanceCanvasPreview;
  /** Neutral Manager chrome, rendered outside the themed layer. */
  controls?: ReactNode;
  /** The cover summary, Change cover action, and current preparation state. */
  summary?: ReactNode;
  onCoverUnavailable?: ResponsiveEventCoverProps['onUnavailable'];
  onRefreshCoverEvent?: ResponsiveEventCoverProps['onRefreshEvent'];
}

function eventDateLabel(eventDate: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })
    .format(new Date(`${eventDate}T12:00:00`));
}

export function EventAppearanceCanvas({
  event,
  theme,
  sourceFor,
  preview = { kind: 'authoritative' },
  controls,
  summary,
  onCoverUnavailable,
  onRefreshCoverEvent,
}: EventAppearanceCanvasProps) {
  const coverLayer = preview.kind === 'draft'
    ? <div className="responsive-cover responsive-cover--image event-appearance-canvas__local-cover">
        <img
          alt=""
          className="responsive-cover__image"
          src={preview.url}
          style={{
            objectPosition: `${preview.focus.x * 100}% ${preview.focus.y * 100}%`,
            transform: `scale(${preview.focus.zoom})`,
            transformOrigin: `${preview.focus.x * 100}% ${preview.focus.y * 100}%`,
          }}
        />
        <div className="responsive-cover__treatment" aria-hidden="true" />
        <div className="responsive-cover__scrim" aria-hidden="true" />
      </div>
    : preview.kind === 'preset'
      ? <ResponsiveEventCover
          cover={{
            revision: event.cover.revision,
            hasCover: true,
            available2xProfiles: allCover2xProfiles(),
            surfaceTreatment: coverSurfaceTreatment({
              version: 1,
              source: {
                kind: 'preset',
                presetId: preview.presetId,
                assetVersion: preview.assetVersion,
              },
              effect: preview.effect,
            }),
          }}
          sourceFor={({ profile, density, format }) => presetCoverAssetPath(
            preview.assetVersion,
            preview.presetId,
            preview.effect,
            profile,
            density,
            format,
          )}
        />
      : <ResponsiveEventCover
          cover={preview.kind === 'none'
            ? { ...event.cover, hasCover: false }
            : event.cover}
          sourceFor={sourceFor}
          onUnavailable={preview.kind === 'authoritative' ? onCoverUnavailable : undefined}
          onRefreshEvent={preview.kind === 'authoritative' ? onRefreshCoverEvent : undefined}
        />;

  return <figure className="event-appearance-canvas">
    <figcaption className="event-appearance-canvas__caption">What guests see</figcaption>
    <div
      className="event-appearance-canvas__guest"
      style={eventThemeStyle(theme.tokens) as CSSProperties}
      data-testid="event-appearance-canvas"
    >
      {coverLayer}
      <div className="event-appearance-canvas__copy">
        <p className="event-appearance-canvas__event">
          {event.name} <span aria-hidden="true">·</span> {eventDateLabel(event.eventDate)}
        </p>
        <p className="event-appearance-canvas__welcome">
          {event.welcomeMessage || 'Help us remember tonight.'}
        </p>
      </div>
      <div className="event-appearance-canvas__actions" aria-hidden="true">
        <span className="event-appearance-canvas__action event-appearance-canvas__action--primary">
          Add photos
        </span>
        <span className="event-appearance-canvas__action">View gallery</span>
      </div>
    </div>

    {summary && <div className="event-appearance-canvas__summary">{summary}</div>}
    {controls && <div className="event-appearance-canvas__controls">{controls}</div>}
  </figure>;
}

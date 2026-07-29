import type { CSSProperties } from 'react';

import type { EventThemeTokens } from '../../shared/contracts';

export const EVENT_THEME_CSS_PROPERTIES = {
  page: '--event-page',
  surface: '--event-surface',
  raisedSurface: '--event-raised-surface',
  text: '--event-text',
  pageText: '--event-page-text',
  cardText: '--event-card-text',
  mutedText: '--event-muted-text',
  secondaryMutedText: '--event-secondary-muted-text',
  quietText: '--event-quiet-text',
  requiredText: '--event-required-text',
  selectionSummaryText: '--event-selection-summary-text',
  primary: '--event-primary',
  primaryForeground: '--event-primary-foreground',
  primaryHover: '--event-primary-hover',
  primaryOnSurface: '--event-primary-on-surface',
  primaryShadow: '--event-primary-shadow',
  accent: '--event-accent',
  accentForeground: '--event-accent-foreground',
  accentSoft: '--event-accent-soft',
  accentSoftForeground: '--event-accent-soft-foreground',
  border: '--event-border',
  sectionBorder: '--event-section-border',
  rememberedNameBorder: '--event-remembered-name-border',
  reviewDivider: '--event-review-divider',
  inputBorder: '--event-input-border',
  focus: '--event-focus',
  mediaPlaceholderStart: '--event-media-placeholder-start',
  mediaPlaceholderEnd: '--event-media-placeholder-end',
  mediaPlaceholderForeground: '--event-media-placeholder-foreground',
  heroStart: '--event-hero-start',
  heroMid: '--event-hero-mid',
  heroEnd: '--event-hero-end',
  heroOverlayTop: '--event-hero-overlay-top',
  heroOverlayBottom: '--event-hero-overlay-bottom',
  coverOverlayTop: '--event-cover-overlay-top',
  coverOverlayBottom: '--event-cover-overlay-bottom',
  coverTextScrim: '--event-cover-text-scrim',
  fullscreenBackdrop: '--event-fullscreen-backdrop',
  fullscreenForeground: '--event-fullscreen-foreground',
  inputShadow: '--event-input-shadow',
  frameShadow: '--event-frame-shadow',
  inputRadius: '--event-input-radius',
  actionRadius: '--event-action-radius',
  cardRadius: '--event-card-radius',
  frameRadius: '--event-frame-radius',
} as const satisfies Record<keyof EventThemeTokens, `--event-${string}`>;

type EventThemeCssProperty = (typeof EVENT_THEME_CSS_PROPERTIES)[keyof EventThemeTokens];

export function eventThemeStyle(tokens: EventThemeTokens): CSSProperties & Record<EventThemeCssProperty, string> {
  return (Object.keys(EVENT_THEME_CSS_PROPERTIES) as Array<keyof EventThemeTokens>).reduce(
    (style, token) => {
      style[EVENT_THEME_CSS_PROPERTIES[token]] = tokens[token];
      return style;
    },
    {} as Record<EventThemeCssProperty, string>,
  );
}

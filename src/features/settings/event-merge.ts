import type { EventView } from '../../../shared/contracts';

/**
 * Every manager mutation answers with a whole event, and the three writable
 * domains run independently. Adopting a whole response would let a settings
 * write that started before a theme write restore the old theme after it — so
 * each response is allowed to update only the fields it decided.
 */

const SETTINGS_OWNED = [
  'name',
  'welcomeMessage',
  'eventTimezone',
  'rsvpEnabled',
  'rsvpDeadlineAt',
  'rsvpDeadlineDate',
  'rsvpRosterVersion',
  'uploadsEnabled',
  'galleryVisible',
  'moderationRequired',
] as const satisfies readonly (keyof EventView)[];

const THEME_OWNED = ['theme'] as const satisfies readonly (keyof EventView)[];
const COVER_OWNED = ['coverObjectKey'] as const satisfies readonly (keyof EventView)[];

function mergeOwned(
  current: EventView,
  response: EventView,
  owned: readonly (keyof EventView)[],
): EventView {
  const merged = { ...current };
  for (const key of owned) {
    // One assignment per key rather than a spread, so nothing outside the
    // owned list can travel with it.
    (merged as Record<string, unknown>)[key] = response[key];
  }
  return merged;
}

export function mergeSettingsResponse(current: EventView, response: EventView): EventView {
  return mergeOwned(current, response, SETTINGS_OWNED);
}

export function mergeThemeResponse(current: EventView, response: EventView): EventView {
  return mergeOwned(current, response, THEME_OWNED);
}

export function mergeCoverResponse(current: EventView, response: EventView): EventView {
  return mergeOwned(current, response, COVER_OWNED);
}

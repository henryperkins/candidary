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
  'rsvpDeadlineAt',
  'rsvpDeadlineDate',
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

export function mergeSettingsResponse(
  current: EventView,
  response: EventView,
  { entryDisabled = false }: { entryDisabled?: boolean } = {},
): EventView {
  const merged = mergeOwned(current, response, SETTINGS_OWNED);
  // RSVP mutations own this counter too. A delayed settings response can only
  // confirm the version it read; it can never move a newer roster backward.
  merged.rsvpRosterVersion = Math.max(current.rsvpRosterVersion, response.rsvpRosterVersion);
  // Settings normally owns the two intake switches. Printed-entry disable is
  // the one irreversible writer that outranks it, so a response assembled
  // before the stop can never make either intake look open afterward.
  merged.uploadsEnabled = entryDisabled ? false : response.uploadsEnabled;
  merged.rsvpEnabled = entryDisabled ? false : response.rsvpEnabled;
  return merged;
}

export function mergeThemeResponse(current: EventView, response: EventView): EventView {
  return mergeOwned(current, response, THEME_OWNED);
}

export function mergeCoverResponse(current: EventView, response: EventView): EventView {
  return mergeOwned(current, response, COVER_OWNED);
}

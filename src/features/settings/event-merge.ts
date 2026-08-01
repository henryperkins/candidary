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
  // One edit recomputes both instants from the same tuple, so a response that
  // owns either of them owns all four values.
  'eventStartAt',
  'eventStartTime',
  'rsvpDeadlineAt',
  'rsvpDeadlineDate',
  'galleryVisible',
  'moderationRequired',
] as const satisfies readonly (keyof EventView)[];

const PHOTO_INTAKE_OWNED = [
  'uploadsEnabled',
  'photosOpen',
  'photoIntakeState',
  'photoIntakeRecheckAfterMs',
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
  // Settings owns RSVP intake and nothing else that can be switched: photo
  // delivery left this payload entirely, and its own writer below is the only
  // thing that moves it. Printed-entry disable is the one irreversible writer
  // that outranks this one, so a response assembled before the stop can never
  // make RSVP look open afterward.
  merged.rsvpEnabled = entryDisabled ? false : response.rsvpEnabled;
  return merged;
}

/**
 * The photo-intake action's answer, and the quiet boundary refetch that follows
 * it across the scheduled opening. Both decide exactly these four values from
 * the server clock, and neither may carry a settings field back with them.
 */
export function mergePhotoIntakeResponse(
  current: EventView,
  response: EventView,
  { entryDisabled = false }: { entryDisabled?: boolean } = {},
): EventView {
  const merged = mergeOwned(current, response, PHOTO_INTAKE_OWNED);
  // The same irreversible stop, restated for the writer that now owns intake.
  // After it, no later answer — action or refetch — may show delivery as open.
  if (entryDisabled) {
    merged.uploadsEnabled = false;
    merged.photosOpen = false;
    merged.photoIntakeState = 'paused';
  }
  return merged;
}

export function mergeThemeResponse(current: EventView, response: EventView): EventView {
  return mergeOwned(current, response, THEME_OWNED);
}

export function mergeCoverResponse(current: EventView, response: EventView): EventView {
  return mergeOwned(current, response, COVER_OWNED);
}

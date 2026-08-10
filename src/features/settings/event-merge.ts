import type { EventView } from '../../../shared/contracts';

/**
 * Every manager mutation answers with a whole event, and the three writable
 * domains run independently. Adopting a whole response would let a settings
 * write that started before a theme write restore the old theme after it — so
 * each response is allowed to update only the fields it decided.
 */

const SCHEDULE_OWNED = [
  'eventTimezone',
  // One edit recomputes both instants from the same tuple, so a response that
  // owns either of them owns all five schedule values.
  'eventStartAt',
  'eventStartTime',
  'rsvpDeadlineAt',
  'rsvpDeadlineDate',
] as const satisfies readonly (keyof EventView)[];

const SETTINGS_OWNED = [
  'name',
  'welcomeMessage',
  ...SCHEDULE_OWNED,
  'galleryVisible',
  'moderationRequired',
] as const satisfies readonly (keyof EventView)[];

const PHOTO_INTAKE_OWNED = [
  'uploadsEnabled',
  'photosOpen',
  'photoIntakeState',
  'photoIntakeRecheckAfterMs',
] as const satisfies readonly (keyof EventView)[];

const PHOTO_INTAKE_AND_SCHEDULE_OWNED = [
  ...PHOTO_INTAKE_OWNED,
  ...SCHEDULE_OWNED,
] as const satisfies readonly (keyof EventView)[];

const THEME_OWNED = ['theme'] as const satisfies readonly (keyof EventView)[];
// The nested cover projection has one response owner. Copying the whole value
// keeps its semantic config, revision, capability, and preparation coherent.
const COVER_OWNED = ['cover'] as const satisfies readonly (keyof EventView)[];

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
 * A photo-intake action decides exactly the four intake values. A fresh
 * lifecycle read can opt into the complete server-owned schedule tuple too,
 * because that tuple decides both its next timer and the schedule the manager
 * editor must rebase onto. Neither source may carry unrelated fields.
 */
export function mergePhotoIntakeResponse(
  current: EventView,
  response: EventView,
  {
    entryDisabled = false,
    ownsSchedule = false,
  }: { entryDisabled?: boolean; ownsSchedule?: boolean } = {},
): EventView {
  const merged = mergeOwned(
    current,
    response,
    ownsSchedule ? PHOTO_INTAKE_AND_SCHEDULE_OWNED : PHOTO_INTAKE_OWNED,
  );
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

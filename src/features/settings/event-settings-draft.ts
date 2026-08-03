import type { EventView } from '../../../shared/contracts';
import { MIN_EVENT_CALENDAR_YEAR } from '../../../shared/constants';
import { canonicalTimeZone, isIanaTimeZone } from '../../../shared/event-time';

/**
 * The eight general event settings, as the host edits them. The endpoint takes
 * one complete payload, so this is deliberately the whole domain rather than a
 * per-field shape: start-time/deadline/time-zone and RSVP/roster are cross-field
 * rules and splitting them would only move the invariants somewhere they are not
 * checked.
 *
 * Photo delivery is deliberately not one of them. Its meaning depends on the
 * server clock, and a stale autosave draft sending `uploadsEnabled: false`
 * meaning "pause until the start" would instead destroy capability for the
 * whole event. It follows the precedent of `Sign out guest devices` and
 * `Disable printed event QR`: an explicit action, not a settings field.
 */
export interface EventSettingsDraft {
  name: string;
  welcomeMessage: string;
  eventTimezone: string;
  // A local 24-hour wall clock, never an instant. The Worker resolves it
  // against the event date and the zone, for the same reason it owns the
  // deadline instant.
  eventStartTime: string;
  rsvpDeadlineDate: string;
  rsvpEnabled: boolean;
  galleryVisible: boolean;
  moderationRequired: boolean;
}

export type EventSettingsField = keyof EventSettingsDraft;

export interface EventSettingsPayload extends EventSettingsDraft {
  // The version the draft was built from. The Worker treats it as a stale-view
  // signal and guards its write on the version it reads itself.
  rsvpRosterVersion: number;
}

// Form order, not response order: a status that names the blocking field should
// name the first one the host would reach.
export const EVENT_SETTINGS_FIELDS = [
  'name',
  'welcomeMessage',
  'eventTimezone',
  'eventStartTime',
  'rsvpDeadlineDate',
  'rsvpEnabled',
  'galleryVisible',
  'moderationRequired',
] as const satisfies readonly EventSettingsField[];

export const EVENT_SETTINGS_LABELS: Record<EventSettingsField, string> = {
  name: 'Event name',
  welcomeMessage: 'Welcome message',
  eventTimezone: 'Event time zone',
  eventStartTime: 'Event start time',
  rsvpDeadlineDate: 'RSVP deadline',
  rsvpEnabled: 'Accept RSVPs',
  galleryVisible: 'Show the optional shared gallery',
  moderationRequired: 'Review notes before sharing',
};

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/u;
const LOCAL_TIME_ONLY = /^([01]\d|2[0-3]):[0-5]\d$/u;

/**
 * Shape is not enough: Date.UTC silently rolls February 31st into March, so
 * the only way to reject an impossible date is to build it and check it came
 * back unchanged. This mirrors parseCalendarDate in shared/event-time.ts,
 * which is what refuses the same value on the Worker.
 */
function isRealCalendarDate(value: string): boolean {
  const match = DATE_ONLY.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < MIN_EVENT_CALENDAR_YEAR) return false;
  const rebuilt = new Date(Date.UTC(year, month - 1, day));
  return rebuilt.getUTCFullYear() === year
    && rebuilt.getUTCMonth() + 1 === month
    && rebuilt.getUTCDate() === day;
}

export function draftFromEvent(event: EventView): EventSettingsDraft {
  return {
    name: event.name,
    welcomeMessage: event.welcomeMessage,
    eventTimezone: event.eventTimezone,
    eventStartTime: event.eventStartTime,
    rsvpDeadlineDate: event.rsvpDeadlineDate ?? '',
    rsvpEnabled: event.rsvpEnabled,
    galleryVisible: event.galleryVisible,
    moderationRequired: event.moderationRequired,
  };
}

/**
 * The one shape that is ever sent, and the one shape identity is computed from.
 * Canonicalizing here is what lets a raw edit that means nothing — trailing
 * space, lower-cased zone — settle back to Saved without a request.
 */
export function canonicalEventSettings(
  draft: EventSettingsDraft,
  rsvpRosterVersion: number,
): EventSettingsPayload {
  return {
    name: draft.name.trim(),
    welcomeMessage: draft.welcomeMessage.trim(),
    eventTimezone: canonicalTimeZone(draft.eventTimezone) ?? draft.eventTimezone,
    eventStartTime: draft.eventStartTime,
    rsvpDeadlineDate: draft.rsvpDeadlineDate,
    rsvpEnabled: draft.rsvpEnabled,
    galleryVisible: draft.galleryVisible,
    moderationRequired: draft.moderationRequired,
    rsvpRosterVersion,
  };
}

// Fixed key order, so two equivalent payloads always serialize identically.
export function eventSettingsKey(payload: EventSettingsPayload): string {
  return JSON.stringify([
    payload.name,
    payload.welcomeMessage,
    payload.eventTimezone,
    payload.eventStartTime,
    payload.rsvpDeadlineDate,
    payload.rsvpEnabled,
    payload.galleryVisible,
    payload.moderationRequired,
    payload.rsvpRosterVersion,
  ]);
}

/**
 * Mirrors the Worker's usable-input rules so an unsendable draft never becomes
 * a request. The Worker repeats every one of them, plus the open-entry and
 * roster rules only it can decide.
 */
export function validateEventSettings(
  draft: EventSettingsDraft,
  eventDate: string,
): Partial<Record<EventSettingsField, string>> {
  const errors: Partial<Record<EventSettingsField, string>> = {};
  const name = draft.name.trim();
  if (name.length === 0) errors.name = 'Enter an event name.';
  else if (name.length > 80) errors.name = 'Use 80 characters or fewer.';

  const welcome = draft.welcomeMessage.trim();
  if (welcome.length === 0) errors.welcomeMessage = 'Enter a welcome message.';
  else if (welcome.length > 500) errors.welcomeMessage = 'Use 500 characters or fewer.';

  if (!isIanaTimeZone(draft.eventTimezone)) errors.eventTimezone = 'Choose a valid time zone.';

  if (!LOCAL_TIME_ONLY.test(draft.eventStartTime)) {
    errors.eventStartTime = 'Choose a valid start time.';
  }

  if (!isRealCalendarDate(draft.rsvpDeadlineDate)) {
    errors.rsvpDeadlineDate = 'Choose a valid RSVP deadline.';
  } else if (draft.rsvpDeadlineDate >= eventDate) {
    // The deadline is the last millisecond of its own local day, so a deadline
    // on the event date is after every start time that date can hold. Only the
    // dates are comparable here; the Worker validates the resolved instants,
    // including a zone edit that moves them relative to each other.
    errors.rsvpDeadlineDate = 'The RSVP deadline must be before the event starts.';
  }
  return errors;
}

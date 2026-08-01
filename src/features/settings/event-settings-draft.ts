import type { EventView } from '../../../shared/contracts';
import { MIN_EVENT_CALENDAR_YEAR } from '../../../shared/constants';
import { canonicalTimeZone, isIanaTimeZone } from '../../../shared/event-time';

/**
 * The eight general event settings, as the host edits them. The endpoint takes
 * one complete payload, so this is deliberately the whole domain rather than a
 * per-field shape: deadline/time-zone and RSVP/roster are cross-field rules and
 * splitting them would only move the invariants somewhere they are not checked.
 */
export interface EventSettingsDraft {
  name: string;
  welcomeMessage: string;
  eventTimezone: string;
  rsvpDeadlineDate: string;
  rsvpEnabled: boolean;
  uploadsEnabled: boolean;
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
  'rsvpDeadlineDate',
  'rsvpEnabled',
  'uploadsEnabled',
  'galleryVisible',
  'moderationRequired',
] as const satisfies readonly EventSettingsField[];

export const EVENT_SETTINGS_LABELS: Record<EventSettingsField, string> = {
  name: 'Event name',
  welcomeMessage: 'Welcome message',
  eventTimezone: 'Event time zone',
  rsvpDeadlineDate: 'RSVP deadline',
  rsvpEnabled: 'Accept RSVPs',
  uploadsEnabled: 'Accept private photo deliveries',
  galleryVisible: 'Show the optional shared gallery',
  moderationRequired: 'Review notes before sharing',
};

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/u;

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
    rsvpDeadlineDate: event.rsvpDeadlineDate ?? '',
    rsvpEnabled: event.rsvpEnabled,
    uploadsEnabled: event.uploadsEnabled,
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
    rsvpDeadlineDate: draft.rsvpDeadlineDate,
    rsvpEnabled: draft.rsvpEnabled,
    uploadsEnabled: draft.uploadsEnabled,
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
    payload.rsvpDeadlineDate,
    payload.rsvpEnabled,
    payload.uploadsEnabled,
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

  if (!isRealCalendarDate(draft.rsvpDeadlineDate)) {
    errors.rsvpDeadlineDate = 'Choose a valid RSVP deadline.';
  } else if (draft.rsvpDeadlineDate > eventDate) {
    errors.rsvpDeadlineDate = 'The RSVP deadline must be on or before the event date.';
  }
  return errors;
}

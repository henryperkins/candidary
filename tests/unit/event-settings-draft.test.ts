import { describe, expect, it } from 'vitest';

import type { EventView } from '../../shared/contracts';
import { resolveEventTheme } from '../../shared/event-theme';
import {
  canonicalEventSettings,
  draftFromEvent,
  eventSettingsKey,
  EVENT_SETTINGS_FIELDS,
  EVENT_SETTINGS_LABELS,
  validateEventSettings,
} from '../../src/features/settings/event-settings-draft';

const event: EventView = {
  id: 'event-a', slug: 'maya-theo', name: 'Maya & Theo', eventDate: '2026-09-19',
  welcomeMessage: 'Welcome.', coverObjectKey: null,
  uploadsEnabled: true, galleryVisible: true, moderationRequired: true,
  reservedMediaCount: 0, storedMediaCount: 3, reservedBytes: 0, storedBytes: 128,
  guestAccessExpiresAt: '2026-10-19T00:00:00Z', managementAccessExpiresAt: '2026-10-19T00:00:00Z',
  purgeAfter: '2026-12-19T00:00:00Z', createdAt: '2026-07-29T00:00:00Z', deletedAt: null,
  eventTimezone: 'America/Chicago', rsvpEnabled: false,
  rsvpDeadlineAt: '2026-09-06T04:59:59.999Z', rsvpDeadlineDate: '2026-09-05',
  rsvpRosterVersion: 7,
  theme: resolveEventTheme({ version: 1, presetId: 'candidary-default', overrides: {} }),
};

describe('event settings draft', () => {
  it('covers every autosaving general setting exactly once, in form order', () => {
    expect(EVENT_SETTINGS_FIELDS).toEqual([
      'name', 'welcomeMessage', 'eventTimezone', 'rsvpDeadlineDate',
      'rsvpEnabled', 'uploadsEnabled', 'galleryVisible', 'moderationRequired',
    ]);
    expect(Object.keys(EVENT_SETTINGS_LABELS).sort()).toEqual([...EVENT_SETTINGS_FIELDS].sort());
  });

  it('reads a draft from the confirmed event and treats a missing deadline as empty', () => {
    expect(draftFromEvent(event)).toEqual({
      name: 'Maya & Theo', welcomeMessage: 'Welcome.', eventTimezone: 'America/Chicago',
      rsvpDeadlineDate: '2026-09-05', rsvpEnabled: false, uploadsEnabled: true,
      galleryVisible: true, moderationRequired: true,
    });
    expect(draftFromEvent({ ...event, rsvpDeadlineDate: null }).rsvpDeadlineDate).toBe('');
  });

  it('trims and canonicalizes before the value ever becomes a snapshot', () => {
    const payload = canonicalEventSettings({
      ...draftFromEvent(event), name: '  Maya & Theo  ', welcomeMessage: ' Welcome. ',
      eventTimezone: 'america/chicago',
    }, 7);
    expect(payload).toEqual({
      name: 'Maya & Theo', welcomeMessage: 'Welcome.', eventTimezone: 'America/Chicago',
      rsvpDeadlineDate: '2026-09-05', rsvpEnabled: false, uploadsEnabled: true,
      galleryVisible: true, moderationRequired: true, rsvpRosterVersion: 7,
    });
  });

  it('gives canonically equivalent drafts one identity and different drafts another', () => {
    const base = draftFromEvent(event);
    expect(eventSettingsKey(canonicalEventSettings({ ...base, name: '  Maya & Theo ' }, 7)))
      .toBe(eventSettingsKey(canonicalEventSettings(base, 7)));
    expect(eventSettingsKey(canonicalEventSettings(base, 8)))
      .not.toBe(eventSettingsKey(canonicalEventSettings(base, 7)));
    expect(eventSettingsKey(canonicalEventSettings({ ...base, rsvpEnabled: true }, 7)))
      .not.toBe(eventSettingsKey(canonicalEventSettings(base, 7)));
  });

  it('accepts the confirmed values it was built from', () => {
    expect(validateEventSettings(draftFromEvent(event), event.eventDate)).toEqual({});
  });

  it('mirrors the Worker rules field by field', () => {
    const base = draftFromEvent(event);
    expect(validateEventSettings({ ...base, name: '   ' }, event.eventDate))
      .toEqual({ name: 'Enter an event name.' });
    expect(validateEventSettings({ ...base, name: 'a'.repeat(81) }, event.eventDate))
      .toEqual({ name: 'Use 80 characters or fewer.' });
    expect(validateEventSettings({ ...base, welcomeMessage: '' }, event.eventDate))
      .toEqual({ welcomeMessage: 'Enter a welcome message.' });
    expect(validateEventSettings({ ...base, welcomeMessage: 'w'.repeat(501) }, event.eventDate))
      .toEqual({ welcomeMessage: 'Use 500 characters or fewer.' });
    expect(validateEventSettings({ ...base, eventTimezone: 'Mars/Olympus' }, event.eventDate))
      .toEqual({ eventTimezone: 'Choose a valid time zone.' });
    expect(validateEventSettings({ ...base, rsvpDeadlineDate: '' }, event.eventDate))
      .toEqual({ rsvpDeadlineDate: 'Choose a valid RSVP deadline.' });
    // Shape alone is not a date. The Worker rejects this in endOfLocalDate;
    // sending it would be a round trip spent learning what is already known.
    expect(validateEventSettings({ ...base, rsvpDeadlineDate: '2026-02-31' }, event.eventDate))
      .toEqual({ rsvpDeadlineDate: 'Choose a valid RSVP deadline.' });
    expect(validateEventSettings({ ...base, rsvpDeadlineDate: '2026-13-01' }, event.eventDate))
      .toEqual({ rsvpDeadlineDate: 'Choose a valid RSVP deadline.' });
    // A leap day that does exist is not rejected with them.
    expect(validateEventSettings(
      { ...base, rsvpDeadlineDate: '2028-02-29' },
      '2028-09-19',
    )).toEqual({});
    expect(validateEventSettings({ ...base, rsvpDeadlineDate: '2026-09-20' }, event.eventDate))
      .toEqual({ rsvpDeadlineDate: 'The RSVP deadline must be on or before the event date.' });
    // The deadline may fall on the event date itself.
    expect(validateEventSettings({ ...base, rsvpDeadlineDate: '2026-09-19' }, event.eventDate))
      .toEqual({});
  });

  it('reports every blocking field at once, because the payload is atomic', () => {
    expect(validateEventSettings(
      { ...draftFromEvent(event), name: '', eventTimezone: 'nope' },
      event.eventDate,
    )).toEqual({
      name: 'Enter an event name.',
      eventTimezone: 'Choose a valid time zone.',
    });
  });
});

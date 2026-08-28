import { describe, expect, it } from 'vitest';

import type { EventView } from '../../shared/contracts';
import { DEFAULT_GUESTBOOK_PROMPT, MAX_GUESTBOOK_PROMPT_LENGTH } from '../../shared/constants';
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
  welcomeMessage: 'Welcome.',
  guestbookPrompt: DEFAULT_GUESTBOOK_PROMPT,
  cover: {
    config: { version: 1, source: { kind: 'none' } }, revision: 0, hasCover: false,
    available2xProfiles: [], surfaceTreatment: 'none', preparation: null,
  },
  uploadsEnabled: true, galleryVisible: true, moderationRequired: true,
  reservedMediaCount: 0, storedMediaCount: 3, reservedBytes: 0, storedBytes: 128, recoverableMediaCount: 0, recoverableBytes: 0,
  guestAccessExpiresAt: '2026-10-19T00:00:00Z', managementAccessExpiresAt: '2026-10-19T00:00:00Z',
  purgeAfter: '2026-12-19T00:00:00Z', createdAt: '2026-07-29T00:00:00Z', deletedAt: null,
  eventTimezone: 'America/Chicago',
  eventStartAt: '2026-09-19T22:00:00.000Z', eventStartTime: '17:00',
  photosOpen: false, photoIntakeState: 'scheduled', photoIntakeRecheckAfterMs: 3_600_000,
  rsvpEnabled: false,
  rsvpDeadlineAt: '2026-09-06T04:59:59.999Z', rsvpDeadlineDate: '2026-09-05',
  rsvpRosterVersion: 7,
  theme: resolveEventTheme({ version: 1, presetId: 'candidary-default', overrides: {} }),
};

describe('event settings draft', () => {
  it('covers every autosaving general setting exactly once, in form order', () => {
    expect(EVENT_SETTINGS_FIELDS).toEqual([
      'name', 'welcomeMessage', 'guestbookPrompt', 'eventTimezone', 'eventStartTime', 'rsvpDeadlineDate',
      'rsvpEnabled', 'galleryVisible', 'moderationRequired',
    ]);
    expect(Object.keys(EVENT_SETTINGS_LABELS).sort()).toEqual([...EVENT_SETTINGS_FIELDS].sort());
  });

  it('reads a draft from the confirmed event and treats a missing deadline as empty', () => {
    expect(draftFromEvent(event)).toEqual({
      name: 'Maya & Theo', welcomeMessage: 'Welcome.', guestbookPrompt: DEFAULT_GUESTBOOK_PROMPT,
      eventTimezone: 'America/Chicago',
      eventStartTime: '17:00', rsvpDeadlineDate: '2026-09-05', rsvpEnabled: false,
      galleryVisible: true, moderationRequired: true,
    });
    expect(draftFromEvent({ ...event, rsvpDeadlineDate: null }).rsvpDeadlineDate).toBe('');
  });

  it('leaves photo delivery out of the payload, so a stale draft cannot pause it', () => {
    const payload = canonicalEventSettings(draftFromEvent(event), 7);
    expect(payload).not.toHaveProperty('uploadsEnabled');
    // Capability moving is not an edit this form has anything to say about, so
    // it must not make an otherwise untouched draft look dirty either.
    expect(eventSettingsKey(canonicalEventSettings(draftFromEvent(
      { ...event, uploadsEnabled: false, photosOpen: false, photoIntakeState: 'paused' },
    ), 7))).toBe(eventSettingsKey(payload));
  });

  it('trims and canonicalizes before the value ever becomes a snapshot', () => {
    const payload = canonicalEventSettings({
      ...draftFromEvent(event), name: '  Maya & Theo  ', welcomeMessage: ' Welcome. ',
      guestbookPrompt: ' Share a memory. ',
      eventTimezone: 'america/chicago',
    }, 7);
    expect(payload).toEqual({
      name: 'Maya & Theo', welcomeMessage: 'Welcome.', guestbookPrompt: 'Share a memory.',
      eventTimezone: 'America/Chicago',
      eventStartTime: '17:00', rsvpDeadlineDate: '2026-09-05', rsvpEnabled: false,
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
    expect(eventSettingsKey(canonicalEventSettings({ ...base, eventStartTime: '17:30' }, 7)))
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
    expect(validateEventSettings({ ...base, guestbookPrompt: '   ' }, event.eventDate))
      .toEqual({ guestbookPrompt: 'Enter a guestbook prompt.' });
    expect(validateEventSettings({
      ...base, guestbookPrompt: 'g'.repeat(MAX_GUESTBOOK_PROMPT_LENGTH + 1),
    }, event.eventDate)).toEqual({
      guestbookPrompt: `Use ${MAX_GUESTBOOK_PROMPT_LENGTH} characters or fewer.`,
    });
    expect(validateEventSettings({ ...base, eventTimezone: 'Mars/Olympus' }, event.eventDate))
      .toEqual({ eventTimezone: 'Choose a valid time zone.' });
    expect(validateEventSettings({ ...base, eventStartTime: '' }, event.eventDate))
      .toEqual({ eventStartTime: 'Choose a valid start time.' });
    expect(validateEventSettings({ ...base, rsvpDeadlineDate: '' }, event.eventDate))
      .toEqual({ rsvpDeadlineDate: 'Choose a valid RSVP deadline.' });
    // Shape alone is not a date. The Worker rejects this in endOfLocalDate;
    // sending it would be a round trip spent learning what is already known.
    expect(validateEventSettings({ ...base, rsvpDeadlineDate: '2026-02-31' }, event.eventDate))
      .toEqual({ rsvpDeadlineDate: 'Choose a valid RSVP deadline.' });
    expect(validateEventSettings({ ...base, rsvpDeadlineDate: '2026-13-01' }, event.eventDate))
      .toEqual({ rsvpDeadlineDate: 'Choose a valid RSVP deadline.' });
    expect(validateEventSettings({ ...base, rsvpDeadlineDate: '0202-09-19' }, event.eventDate))
      .toEqual({ rsvpDeadlineDate: 'Choose a valid RSVP deadline.' });
    // A leap day that does exist is not rejected with them.
    expect(validateEventSettings(
      { ...base, rsvpDeadlineDate: '2028-02-29' },
      '2028-09-19',
    )).toEqual({});
    expect(validateEventSettings({ ...base, rsvpDeadlineDate: '2026-09-20' }, event.eventDate))
      .toEqual({ rsvpDeadlineDate: 'The RSVP deadline must be before the event starts.' });
    // The deadline is the last local millisecond of its own day, so one on the
    // event date is after every start time that date can hold.
    expect(validateEventSettings({ ...base, rsvpDeadlineDate: '2026-09-19' }, event.eventDate))
      .toEqual({ rsvpDeadlineDate: 'The RSVP deadline must be before the event starts.' });
    expect(validateEventSettings({ ...base, rsvpDeadlineDate: '2026-09-18' }, event.eventDate))
      .toEqual({});
  });

  it.each<[string, boolean]>([
    ['00:00', true],
    ['09:05', true],
    ['17:00', true],
    ['23:59', true],
    ['24:00', false],
    ['17:60', false],
    ['7:00', false],
    ['07:0', false],
    ['17:00:00', false],
    ['5pm', false],
    ['', false],
  ])('accepts only a 24-hour local start time (%s)', (eventStartTime, valid) => {
    const errors = validateEventSettings(
      { ...draftFromEvent(event), eventStartTime },
      event.eventDate,
    );
    expect(errors.eventStartTime).toBe(valid ? undefined : 'Choose a valid start time.');
  });

  it('leaves the skipped-hour rule to the Worker, which owns the zone', () => {
    // 02:30 does not exist in Chicago on 2026-03-08, but only the resolved
    // instant proves that, so this draft is sendable and the Worker answers
    // with `eventStartTime` rather than the browser guessing.
    expect(validateEventSettings(
      { ...draftFromEvent(event), eventStartTime: '02:30', rsvpDeadlineDate: '2026-03-07' },
      '2026-03-08',
    )).toEqual({});
  });

  it('reports every blocking field at once, because the payload is atomic', () => {
    expect(validateEventSettings(
      { ...draftFromEvent(event), name: '', eventTimezone: 'nope', eventStartTime: '25:00' },
      event.eventDate,
    )).toEqual({
      name: 'Enter an event name.',
      eventTimezone: 'Choose a valid time zone.',
      eventStartTime: 'Choose a valid start time.',
    });
  });
});

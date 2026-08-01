import { describe, expect, it } from 'vitest';

import type { EventView } from '../../shared/contracts';
import { resolveEventTheme } from '../../shared/event-theme';
import {
  mergeCoverResponse,
  mergeSettingsResponse,
  mergeThemeResponse,
} from '../../src/features/settings/event-merge';

const candidary = resolveEventTheme({ version: 1, presetId: 'candidary-default', overrides: {} });
const garden = resolveEventTheme({ version: 1, presetId: 'garden-party', overrides: {} });

const current: EventView = {
  id: 'event-a', slug: 'maya-theo', name: 'Maya & Theo', eventDate: '2026-09-19',
  welcomeMessage: 'Welcome.', coverObjectKey: 'events/event-a/cover/new.jpg',
  uploadsEnabled: true, galleryVisible: true, moderationRequired: true,
  reservedMediaCount: 0, storedMediaCount: 3, reservedBytes: 0, storedBytes: 128,
  guestAccessExpiresAt: '2026-10-19T00:00:00Z', managementAccessExpiresAt: '2026-10-19T00:00:00Z',
  purgeAfter: '2026-12-19T00:00:00Z', createdAt: '2026-07-29T00:00:00Z', deletedAt: null,
  eventTimezone: 'America/Chicago', rsvpEnabled: false,
  rsvpDeadlineAt: '2026-09-06T04:59:59.999Z', rsvpDeadlineDate: '2026-09-05',
  rsvpRosterVersion: 7, theme: garden,
};

// What a settings PATCH answered with, built from a view that predates the newer
// theme and cover the host has since confirmed.
const staleElsewhere: EventView = {
  ...current, name: 'Renamed', rsvpEnabled: true, rsvpRosterVersion: 8,
  theme: candidary, coverObjectKey: null,
};

describe('manager event merges', () => {
  it('takes only the settings a settings response owns', () => {
    const merged = mergeSettingsResponse(current, staleElsewhere);
    expect(merged.name).toBe('Renamed');
    expect(merged.rsvpEnabled).toBe(true);
    expect(merged.rsvpRosterVersion).toBe(8);
    expect(merged.theme).toBe(garden);
    expect(merged.coverObjectKey).toBe('events/event-a/cover/new.jpg');
  });

  it('never regresses the roster version from a delayed settings response', () => {
    const merged = mergeSettingsResponse(
      { ...current, rsvpRosterVersion: 9 },
      { ...staleElsewhere, rsvpRosterVersion: 8 },
    );

    expect(merged.rsvpRosterVersion).toBe(9);
  });

  it('never reopens either intake from a settings response after entry disable', () => {
    const mergeWithEntryState = mergeSettingsResponse as (
      currentEvent: EventView,
      responseEvent: EventView,
      options: { entryDisabled: boolean },
    ) => EventView;
    const merged = mergeWithEntryState(
      { ...current, uploadsEnabled: false, rsvpEnabled: false },
      { ...staleElsewhere, uploadsEnabled: true, rsvpEnabled: true },
      { entryDisabled: true },
    );

    expect(merged.uploadsEnabled).toBe(false);
    expect(merged.rsvpEnabled).toBe(false);
  });

  it('takes only the theme a theme response owns', () => {
    const merged = mergeThemeResponse(current, { ...staleElsewhere, theme: candidary });
    expect(merged.theme).toBe(candidary);
    expect(merged.name).toBe('Maya & Theo');
    expect(merged.rsvpRosterVersion).toBe(7);
    expect(merged.coverObjectKey).toBe('events/event-a/cover/new.jpg');
  });

  it('takes only the cover a cover response owns', () => {
    const merged = mergeCoverResponse(current, staleElsewhere);
    expect(merged.coverObjectKey).toBeNull();
    expect(merged.theme).toBe(garden);
    expect(merged.name).toBe('Maya & Theo');
  });
});

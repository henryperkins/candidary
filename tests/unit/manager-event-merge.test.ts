import { describe, expect, it } from 'vitest';

import type { EventView } from '../../shared/contracts';
import { DEFAULT_GUESTBOOK_PROMPT } from '../../shared/constants';
import { resolveEventTheme } from '../../shared/event-theme';
import {
  mergeCoverResponse,
  mergePhotoIntakeResponse,
  mergeSettingsResponse,
  mergeThemeResponse,
} from '../../src/features/settings/event-merge';

const candidary = resolveEventTheme({ version: 1, presetId: 'candidary-default', overrides: {} });
const garden = resolveEventTheme({ version: 1, presetId: 'garden-party', overrides: {} });
const noCover = {
  config: { version: 1, source: { kind: 'none' } } as const,
  revision: 1,
  hasCover: false,
  available2xProfiles: [],
  surfaceTreatment: 'none' as const,
  preparation: null,
};
const covered = {
  config: {
    version: 1,
    source: { kind: 'preset', presetId: 'warm-linen', assetVersion: 1 },
    effect: 'natural',
  } as const,
  revision: 0,
  hasCover: true,
  available2xProfiles: [],
  surfaceTreatment: 'none' as const,
  preparation: null,
};

const current: EventView = {
  id: 'event-a', slug: 'maya-theo', name: 'Maya & Theo', eventDate: '2026-09-19',
  welcomeMessage: 'Welcome.', guestbookPrompt: DEFAULT_GUESTBOOK_PROMPT, cover: covered,
  uploadsEnabled: true, galleryVisible: true, moderationRequired: true,
  reservedMediaCount: 0, storedMediaCount: 3, reservedBytes: 0, storedBytes: 128, recoverableMediaCount: 0, recoverableBytes: 0,
  hostUploadAvailability: { enabled: true, reason: null },
  guestAccessExpiresAt: '2026-10-19T00:00:00Z', managementAccessExpiresAt: '2026-10-19T00:00:00Z',
  managerLinkRevision: 0,
  managerLinkRotationAvailability: { enabled: true, reason: null },
  purgeAfter: '2026-12-19T00:00:00Z', createdAt: '2026-07-29T00:00:00Z', deletedAt: null,
  eventTimezone: 'America/Chicago',
  eventStartAt: '2026-09-19T22:00:00.000Z', eventStartTime: '17:00',
  // The host has already opened photo delivery early on this page.
  photosOpen: true, photoIntakeState: 'open-early', photoIntakeRecheckAfterMs: 3_600_000,
  rsvpEnabled: false,
  rsvpDeadlineAt: '2026-09-06T04:59:59.999Z', rsvpDeadlineDate: '2026-09-05',
  rsvpRosterVersion: 7, theme: garden,
};

// What a settings PATCH answered with, built from a view that predates the newer
// theme and cover the host has since confirmed, and the early opening too.
const staleElsewhere: EventView = {
  ...current, name: 'Renamed', guestbookPrompt: 'Tell us your favorite memory.',
  rsvpEnabled: true, rsvpRosterVersion: 8,
  eventStartAt: '2026-09-19T23:00:00.000Z', eventStartTime: '18:00',
  rsvpDeadlineAt: '2026-09-05T04:59:59.999Z', rsvpDeadlineDate: '2026-09-04',
  photosOpen: false, photoIntakeState: 'scheduled', photoIntakeRecheckAfterMs: 7_200_000,
  theme: candidary, cover: noCover,
};

// What the photo-intake action, or the quiet refetch that follows it across the
// start, answered with. It carries the same stale name and theme.
const intakeAnswer: EventView = {
  ...staleElsewhere,
  photosOpen: true, photoIntakeState: 'open', photoIntakeRecheckAfterMs: null,
};

describe('manager event merges', () => {
  it('takes only the settings a settings response owns', () => {
    const merged = mergeSettingsResponse(current, staleElsewhere);
    expect(merged.name).toBe('Renamed');
    expect(merged.rsvpEnabled).toBe(true);
    expect(merged.rsvpRosterVersion).toBe(8);
    expect(merged.guestbookPrompt).toBe('Tell us your favorite memory.');
    expect(merged.theme).toBe(garden);
    expect(merged.cover).toBe(covered);
  });

  it('takes both schedule instants together, because one edit decides both', () => {
    const merged = mergeSettingsResponse(current, staleElsewhere);
    expect(merged.eventStartAt).toBe('2026-09-19T23:00:00.000Z');
    expect(merged.eventStartTime).toBe('18:00');
    expect(merged.rsvpDeadlineAt).toBe('2026-09-05T04:59:59.999Z');
    expect(merged.rsvpDeadlineDate).toBe('2026-09-04');
  });

  it('never lets a settings response move photo delivery', () => {
    // Photo delivery left this payload entirely. A response assembled before the
    // host opened it early would otherwise close a delivery already open.
    const merged = mergeSettingsResponse(current, staleElsewhere);
    expect(merged.uploadsEnabled).toBe(true);
    expect(merged.photosOpen).toBe(true);
    expect(merged.photoIntakeState).toBe('open-early');
    expect(merged.photoIntakeRecheckAfterMs).toBe(3_600_000);
  });

  it('never regresses the roster version from a delayed settings response', () => {
    const merged = mergeSettingsResponse(
      { ...current, rsvpRosterVersion: 9 },
      { ...staleElsewhere, rsvpRosterVersion: 8 },
    );

    expect(merged.rsvpRosterVersion).toBe(9);
  });

  it('never reopens RSVP from a settings response after entry disable', () => {
    const merged = mergeSettingsResponse(
      { ...current, rsvpEnabled: false },
      { ...staleElsewhere, rsvpEnabled: true },
      { entryDisabled: true },
    );

    expect(merged.rsvpEnabled).toBe(false);
  });

  it('takes only the intake a photo-intake response owns', () => {
    const merged = mergePhotoIntakeResponse(current, intakeAnswer);
    expect(merged.photosOpen).toBe(true);
    expect(merged.photoIntakeState).toBe('open');
    expect(merged.photoIntakeRecheckAfterMs).toBeNull();
    expect(merged.name).toBe('Maya & Theo');
    expect(merged.eventStartAt).toBe('2026-09-19T22:00:00.000Z');
    expect(merged.rsvpEnabled).toBe(false);
    expect(merged.rsvpRosterVersion).toBe(7);
    expect(merged.theme).toBe(garden);
    expect(merged.cover).toBe(covered);
  });

  it('adopts newer host upload availability without carrying stale settings', () => {
    const merged = mergePhotoIntakeResponse(current, {
      ...intakeAnswer,
      name: 'Stale server name',
      hostUploadAvailability: { enabled: false, reason: 'media-cap' },
    });

    expect(merged.hostUploadAvailability).toEqual({ enabled: false, reason: 'media-cap' });
    expect(merged.name).toBe('Maya & Theo');
  });

  it('takes the complete schedule tuple with intake only for a lifecycle read', () => {
    const lifecycleAnswer: EventView = {
      ...intakeAnswer,
      name: 'Remote rename outside lifecycle ownership',
      eventTimezone: 'America/Los_Angeles',
      eventStartAt: '2026-09-20T01:30:00.000Z',
      eventStartTime: '18:30',
      rsvpDeadlineAt: '2026-09-06T06:59:59.999Z',
      rsvpDeadlineDate: '2026-09-05',
      rsvpEnabled: true,
      theme: candidary,
      cover: noCover,
    };

    const merged = mergePhotoIntakeResponse(current, lifecycleAnswer, { ownsSchedule: true });

    expect(merged).toMatchObject({
      eventTimezone: 'America/Los_Angeles',
      eventStartAt: '2026-09-20T01:30:00.000Z',
      eventStartTime: '18:30',
      rsvpDeadlineAt: '2026-09-06T06:59:59.999Z',
      rsvpDeadlineDate: '2026-09-05',
      photosOpen: true,
      photoIntakeState: 'open',
      photoIntakeRecheckAfterMs: null,
    });
    expect(merged.name).toBe('Maya & Theo');
    expect(merged.rsvpEnabled).toBe(false);
    expect(merged.theme).toBe(garden);
    expect(merged.cover).toBe(covered);
  });

  it('carries a pause the action itself decided', () => {
    const merged = mergePhotoIntakeResponse(current, {
      ...intakeAnswer, uploadsEnabled: false, photosOpen: false, photoIntakeState: 'paused',
    });

    expect(merged.uploadsEnabled).toBe(false);
    expect(merged.photosOpen).toBe(false);
    expect(merged.photoIntakeState).toBe('paused');
  });

  it('never reopens photo delivery from an intake response after entry disable', () => {
    const merged = mergePhotoIntakeResponse(
      { ...current, uploadsEnabled: false, photosOpen: false, photoIntakeState: 'paused' },
      intakeAnswer,
      { entryDisabled: true },
    );

    expect(merged.uploadsEnabled).toBe(false);
    expect(merged.photosOpen).toBe(false);
    expect(merged.photoIntakeState).toBe('paused');
  });

  it('takes only the theme a theme response owns', () => {
    const merged = mergeThemeResponse(current, { ...staleElsewhere, theme: candidary });
    expect(merged.theme).toBe(candidary);
    expect(merged.name).toBe('Maya & Theo');
    expect(merged.rsvpRosterVersion).toBe(7);
    expect(merged.cover).toBe(covered);
  });

  it('takes only the cover a cover response owns', () => {
    const merged = mergeCoverResponse(current, staleElsewhere);
    expect(merged.cover).toBe(noCover);
    expect(merged.theme).toBe(garden);
    expect(merged.name).toBe('Maya & Theo');
  });

  it('adopts the revision and preparation a cover response carries', () => {
    const preparation = {
      operationId: 'operation-a',
      status: 'preparing' as const,
      completedSteps: 2,
      requiredSteps: 6,
      retryable: false,
      safeFailureCode: null,
      updatedAt: '2026-08-04T00:00:00.000Z',
    };
    const merged = mergeCoverResponse(current, {
      ...staleElsewhere,
      cover: { ...noCover, revision: 4, preparation },
    });
    // Without the revision, the next publication sends `expectedRevision: 0`
    // against a server at 4 and takes a 409 no host action caused.
    expect(merged.cover.revision).toBe(4);
    expect(merged.cover.preparation).toEqual(preparation);
  });

  it('never lets a delayed lower cover revision replace the current graph', () => {
    const currentAtNine: EventView = {
      ...current,
      cover: { ...covered, revision: 9 },
    };
    const delayed = {
      ...staleElsewhere,
      cover: { ...noCover, revision: 8 },
    };
    expect(mergeCoverResponse(currentAtNine, delayed).cover).toBe(currentAtNine.cover);
  });

  it('allows same-revision reconciliation to update preparation', () => {
    const currentAtNine: EventView = {
      ...current,
      cover: { ...covered, revision: 9, preparation: null },
    };
    const preparing = {
      operationId: 'operation-b',
      status: 'preparing' as const,
      completedSteps: 3,
      requiredSteps: 6,
      retryable: false,
      safeFailureCode: null,
      updatedAt: '2026-08-04T00:00:00.000Z',
    };
    const sameRevision = {
      ...staleElsewhere,
      cover: { ...covered, revision: 9, preparation: preparing },
    };
    expect(mergeCoverResponse(currentAtNine, sameRevision).cover.preparation).toEqual(preparing);
  });

  it('keeps settings, theme, and photo-intake responses out of the cover domain', () => {
    const coverMoved: EventView = {
      ...staleElsewhere,
      cover: { ...noCover, revision: 9, preparation: {
        operationId: 'operation-b',
        status: 'applied',
        completedSteps: 6,
        requiredSteps: 6,
        retryable: false,
        safeFailureCode: null,
        updatedAt: '2026-08-04T00:00:00.000Z',
      } },
    };
    for (const merged of [
      mergeSettingsResponse(current, coverMoved),
      mergeThemeResponse(current, coverMoved),
      mergePhotoIntakeResponse(current, coverMoved),
    ]) {
      expect(merged.cover.revision).toBe(0);
      expect(merged.cover.preparation).toBeNull();
      expect(merged.cover).toBe(covered);
    }
  });
});

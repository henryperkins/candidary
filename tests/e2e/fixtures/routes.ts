import type { Page } from '@playwright/test';

import type {
  EventThemeConfigV1,
  EventThemeOverridesV1,
  EventThemePresetId,
  EventView,
  GuestEventView,
  RsvpHouseholdDetail,
  RsvpHouseholdListPage,
  RsvpHouseholdView,
  RsvpImportPreview,
  RsvpLookupResponse,
  RsvpSubmissionResponse,
  RsvpSummary,
} from '../../../shared/contracts';
import { resolveEventTheme } from '../../../shared/event-theme';
import { PHOTOGRAPHIC_COVER } from './cover-images';
import { makeMedia } from './ui-data';

export function eventTheme(
  presetId: EventThemePresetId,
  overrides: EventThemeOverridesV1 = {},
) {
  return resolveEventTheme({ version: 1, presetId, overrides });
}

export const GUEST_EVENT_FIXTURE: GuestEventView = {
  id: 'event-a',
  slug: 'maya-theo',
  name: 'Maya & Theo',
  eventDate: '2026-09-19',
  welcomeMessage: 'We would love to see the day through your eyes.',
  coverObjectKey: null,
  uploadsEnabled: true,
  galleryVisible: true,
  moderationRequired: true,
  eventTimezone: 'America/Chicago',
  // The existing photo fixtures are explicitly photos-primary with RSVP off, so
  // no upload or receipt baseline picks up an RSVP disclosure it never had.
  rsvpDeadlineAt: null,
  rsvpDeadlineDate: null,
  phase: 'photos-primary',
  rsvpState: 'disabled',
  theme: eventTheme('candidary-default'),
};

export const EVENT_FIXTURE: EventView = {
  ...GUEST_EVENT_FIXTURE,
  reservedMediaCount: 0,
  storedMediaCount: 1,
  reservedBytes: 0,
  storedBytes: 128,
  guestAccessExpiresAt: '2026-10-19T00:00:00Z',
  managementAccessExpiresAt: '2026-10-19T00:00:00Z',
  purgeAfter: '2026-12-19T00:00:00Z',
  createdAt: '2026-07-29T00:00:00Z',
  deletedAt: null,
  rsvpEnabled: false,
  rsvpRosterVersion: 0,
};

export const RSVP_HOUSEHOLD_FIXTURE: RsvpHouseholdView = {
  id: 'household-a',
  label: 'The Morgan household',
  version: 4,
  editable: true,
  renewalRequired: false,
  deadlineAt: '2026-09-05T23:59:59.999Z',
  invitees: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      kind: 'named',
      displayName: 'Taylor Morgan',
      attendance: 'pending',
      order: 0,
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      kind: 'named',
      displayName: 'Alex Morgan',
      attendance: 'pending',
      order: 1,
    },
    {
      id: '33333333-3333-4333-8333-333333333333',
      kind: 'plus_one',
      displayName: null,
      attendance: 'pending',
      order: 2,
    },
  ],
  firstRespondedAt: null,
  latestRespondedAt: null,
  latestActor: null,
};

export const RSVP_SUMMARY_FIXTURE: RsvpSummary = {
  invitedCapacity: 8,
  namedInvitees: 6,
  plusOneCapacity: 2,
  attending: 3,
  declined: 2,
  awaitingResponse: 3,
  householdsResponded: 1,
  householdsAwaitingResponse: 2,
};

export const RSVP_HOUSEHOLD_DETAIL_FIXTURE: RsvpHouseholdDetail = {
  id: '11111111-1111-4111-8111-111111111111',
  householdKey: 'morgan',
  label: 'The Morgan household',
  plusOneSlots: 1,
  version: 4,
  archivedAt: null,
  invitees: [
    {
      id: '22222222-2222-4222-8222-222222222222',
      kind: 'named',
      displayName: 'Taylor Morgan',
      attendance: 'attending',
      order: 0,
    },
    {
      id: '33333333-3333-4333-8333-333333333333',
      kind: 'named',
      displayName: 'Alex Morgan',
      attendance: 'declined',
      order: 1,
    },
    {
      id: '44444444-4444-4444-8444-444444444444',
      kind: 'plus_one',
      displayName: 'Jamie Rivera',
      attendance: 'attending',
      order: 2,
    },
  ],
  firstRespondedAt: '2026-08-01T00:00:00Z',
  latestRespondedAt: '2026-08-02T00:00:00Z',
  latestActor: 'household',
  updatedAt: '2026-08-02T00:00:00Z',
};

export const RSVP_HOUSEHOLD_LIST_FIXTURE: RsvpHouseholdListPage = {
  households: [{
    id: RSVP_HOUSEHOLD_DETAIL_FIXTURE.id,
    householdKey: RSVP_HOUSEHOLD_DETAIL_FIXTURE.householdKey,
    label: RSVP_HOUSEHOLD_DETAIL_FIXTURE.label,
    version: RSVP_HOUSEHOLD_DETAIL_FIXTURE.version,
    archivedAt: null,
    attending: 2,
    declined: 1,
    awaitingResponse: 0,
    invitedCapacity: 3,
    firstRespondedAt: RSVP_HOUSEHOLD_DETAIL_FIXTURE.firstRespondedAt,
    latestRespondedAt: RSVP_HOUSEHOLD_DETAIL_FIXTURE.latestRespondedAt,
    latestActor: RSVP_HOUSEHOLD_DETAIL_FIXTURE.latestActor,
    updatedAt: RSVP_HOUSEHOLD_DETAIL_FIXTURE.updatedAt,
  }],
  nextCursor: null,
};

interface GuestMessage {
  id: string;
  guestName: string;
  body: string;
  moderationStatus: 'approved';
  createdAt: string;
}

interface GuestRouteOptions {
  event?: Partial<GuestEventView>;
  gallery?: ReturnType<typeof makeMedia>;
  contributions?: ReturnType<typeof makeMedia>;
  messages?: GuestMessage[];
  cover?: Buffer;
  household?: RsvpHouseholdView | null;
  lookup?: RsvpLookupResponse;
  submission?: RsvpSubmissionResponse;
}

interface ManagerRouteOptions {
  event?: Partial<EventView>;
  // Keyed by the cursor the client sends back; `first` answers a request that carries no cursor.
  mediaPages: Record<string, { media: ReturnType<typeof makeMedia>; nextCursor: string | null }>;
  messages?: GuestMessage[];
  exports?: unknown[];
  cover?: Buffer;
  entry?: { eventLink: string | null; disabledAt: string | null };
  rsvp?: {
    summary?: RsvpSummary;
    households?: RsvpHouseholdListPage;
    detail?: RsvpHouseholdDetail;
    preview?: RsvpImportPreview;
  };
}

// The one durable entry URL every browser test scans. It is a fixture string, not
// a credential: the real exchange is proved in `tests/worker/event-entry-api`.
export const EVENT_ENTRY_FIXTURE_TOKEN = `entry-fixture-id.${'entry-fixture-secret'.repeat(2)}`;

export async function stubGuestRoutes(page: Page, options: GuestRouteOptions = {}) {
  const event: GuestEventView = { ...GUEST_EVENT_FIXTURE, ...options.event };
  const gallery = options.gallery ?? makeMedia(1);
  const contributions = options.contributions ?? gallery;
  const messages = options.messages ?? [];
  const base = `**/api/event/${event.slug}`;

  await page.route('**/api/media/*/preview', (route) => route.fulfill({
    status: 200,
    contentType: 'image/png',
    body: PHOTOGRAPHIC_COVER,
  }));
  if (event.coverObjectKey) {
    await page.route(`${base}/cover`, (route) => route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: options.cover ?? PHOTOGRAPHIC_COVER,
    }));
  }
  await page.route(base, (route) => route.fulfill({
    json: { data: { event, role: 'guest' }, requestId: 'request-a' },
  }));
  await page.route(`${base}/gallery`, (route) => route.fulfill({
    json: { data: { media: gallery }, requestId: 'request-a' },
  }));
  await page.route(`${base}/contributions`, (route) => route.fulfill({
    json: { data: { media: contributions }, requestId: 'request-a' },
  }));
  await page.route(`${base}/messages`, (route) => route.fulfill({
    json: { data: { items: messages }, requestId: 'request-a' },
  }));
  await page.route(`${base}/rsvp/lookup`, (route) => route.fulfill({
    json: {
      data: options.lookup ?? (options.household
        ? { status: 'matched', household: options.household }
        : {
            status: 'not_available',
            message: 'We could not open an invitation with those details.',
          }),
      requestId: 'request-a',
    },
  }));
  await page.route(`${base}/rsvp/household`, (route) => {
    if (route.request().method() === 'PUT') {
      const household = options.submission?.household ?? options.household;
      if (!household) {
        return route.fulfill({
          status: 401,
          json: {
            code: 'RSVP_SESSION_REQUIRED',
            message: 'Find your invitation to continue.',
            requestId: 'request-a',
          },
        });
      }
      return route.fulfill({
        json: {
          data: options.submission ?? {
            household,
            committedVersion: household.version,
            replayed: false,
          },
          requestId: 'request-a',
        },
      });
    }
    return options.household
      ? route.fulfill({
          json: { data: { household: options.household }, requestId: 'request-a' },
        })
      : route.fulfill({
          status: 401,
          json: {
            code: 'RSVP_SESSION_REQUIRED',
            message: 'Find your invitation to continue.',
            requestId: 'request-a',
          },
        });
  });
}

export async function stubManagerRoutes(page: Page, options: ManagerRouteOptions) {
  const event = { ...EVENT_FIXTURE, ...options.event };
  const base = `**/api/manage/events/${event.id}`;

  await page.route('**/api/media/*/preview', (route) => route.fulfill({
    status: 200,
    contentType: 'image/png',
    body: PHOTOGRAPHIC_COVER,
  }));
  if (event.coverObjectKey) {
    await page.route(`${base}/cover`, (route) => route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: options.cover ?? PHOTOGRAPHIC_COVER,
    }));
  }
  await page.route(`${base}/media*`, (route) => {
    // `cursor=` is a 422, so the client omits the parameter for the first page.
    const cursor = new URL(route.request().url()).searchParams.get('cursor') ?? 'first';
    const mediaPage = options.mediaPages[cursor] ?? { media: [], nextCursor: null };
    return route.fulfill({ json: { data: mediaPage, requestId: 'request-a' } });
  });
  await page.route(new RegExp(`/api/manage/events/${event.id}$`, 'u'), (route) => route.fulfill({
    json: { data: { event }, requestId: 'request-a' },
  }));
  await page.route(`${base}/messages`, (route) => route.fulfill({
    json: { data: { messages: options.messages ?? [] }, requestId: 'request-a' },
  }));
  await page.route(`${base}/exports`, (route) => route.fulfill({
    json: { data: { exports: options.exports ?? [] }, requestId: 'request-a' },
  }));
  const summary = options.rsvp?.summary ?? RSVP_SUMMARY_FIXTURE;
  const households = options.rsvp?.households ?? RSVP_HOUSEHOLD_LIST_FIXTURE;
  const detail = options.rsvp?.detail ?? RSVP_HOUSEHOLD_DETAIL_FIXTURE;

  await page.route(`${base}/rsvp/summary`, (route) => route.fulfill({
    json: { data: summary, requestId: 'request-a' },
  }));
  await page.route(`${base}/rsvp/export.csv`, (route) => route.fulfill({
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${event.slug}-rsvp-2026-07-31.csv"`,
    },
    body: 'household_key,household_label\n',
  }));
  await page.route(`${base}/rsvp/import/preview`, (route) => route.fulfill({
    json: {
      data: options.rsvp?.preview ?? {
        issues: [],
        totals: { households: 1, namedInvitees: 2, plusOneCapacity: 1, invitedCapacity: 3 },
        sourceDigest: 'a'.repeat(64),
        rosterVersion: event.rsvpRosterVersion,
      },
      requestId: 'request-a',
    },
  }));
  await page.route(`${base}/rsvp/import/commit`, (route) => route.fulfill({
    status: 201,
    json: {
      data: {
        totals: { households: 1, namedInvitees: 2, plusOneCapacity: 1, invitedCapacity: 3 },
        rosterVersion: event.rsvpRosterVersion + 1,
      },
      requestId: 'request-a',
    },
  }));
  // `*` does not cross a slash, so the list glob and the household globs below
  // stay disjoint rather than shadowing one another.
  await page.route(`${base}/rsvp/households*`, (route) => route.fulfill({
    json: {
      data: route.request().method() === 'POST'
        ? { household: detail, rosterVersion: event.rsvpRosterVersion + 1 }
        : households,
      requestId: 'request-a',
    },
    ...(route.request().method() === 'POST' ? { status: 201 } : {}),
  }));
  await page.route(`${base}/rsvp/households/*`, (route) => route.fulfill({
    json: {
      data: route.request().method() === 'GET'
        ? detail
        : { household: detail, rosterVersion: event.rsvpRosterVersion + 1 },
      requestId: 'request-a',
    },
  }));
  for (const action of ['response', 'archive'] as const) {
    await page.route(`${base}/rsvp/households/*/${action}`, (route) => route.fulfill({
      json: {
        data: {
          household: action === 'archive'
            ? { ...detail, version: detail.version + 1, archivedAt: '2026-08-03T00:00:00Z' }
            : { ...detail, version: detail.version + 1, latestActor: 'host' },
          rosterVersion: event.rsvpRosterVersion + 1,
        },
        requestId: 'request-a',
      },
    }));
  }
  await page.route(`${base}/guest-sessions/rotate`, (route) => route.fulfill({
    json: {
      data: { rotated: true, eventLink: `https://candidary.test/join#${EVENT_ENTRY_FIXTURE_TOKEN}` },
      requestId: 'request-a',
    },
  }));
  await page.route(`${base}/entry/disable`, (route) => route.fulfill({
    json: { data: { disabledAt: '2026-07-31T12:00:00.000Z' }, requestId: 'request-a' },
  }));
  await page.route(`${base}/entry`, (route) => route.fulfill({
    json: {
      data: options.entry
        ?? { eventLink: `https://candidary.test/join#${EVENT_ENTRY_FIXTURE_TOKEN}`, disabledAt: null },
      requestId: 'request-a',
    },
  }));
  await page.route(`${base}/theme`, (route) => {
    const config = route.request().postDataJSON() as EventThemeConfigV1;
    return route.fulfill({
      json: {
        data: { event: { ...event, theme: eventTheme(config.presetId, config.overrides) } },
        requestId: 'request-a',
      },
    });
  });
}

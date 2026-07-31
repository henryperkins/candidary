import type { Page } from '@playwright/test';

import type {
  EventThemeConfigV1,
  EventThemeOverridesV1,
  EventThemePresetId,
  EventView,
  GuestEventView,
  RsvpHouseholdView,
  RsvpLookupResponse,
  RsvpSubmissionResponse,
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
}

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
  await page.route(`${base}/entry`, (route) => route.fulfill({
    json: {
      data: { eventLink: `https://candidary.test/join#${'entry-secret-'.repeat(8)}`, disabledAt: null },
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

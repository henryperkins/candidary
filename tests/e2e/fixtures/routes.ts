import type { Page, Route } from '@playwright/test';

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
  RsvpRosterBatchCommitRequest,
  RsvpRosterBatchCommitResponse,
  RsvpRosterBatchDraft,
  RsvpRosterBatchPreviewRequest,
  RsvpRosterBatchPreviewResponse,
  RsvpRosterBatchTotals,
  RsvpRosterCanonicalBatch,
  RsvpSubmissionRequest,
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
  // The guest fixtures keep a null deadline on purpose. The manager cannot:
  // its settings editor validates the deadline, and a null one would leave
  // every manager browser test sitting on an unsendable draft.
  rsvpDeadlineAt: '2026-09-06T04:59:59.999Z',
  rsvpDeadlineDate: '2026-09-05',
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
  // Whether the browser starts already holding a household session. It defaults to
  // true whenever a household fixture is supplied, so a test that wants the
  // first-visit lookup screen with a matchable household says so explicitly.
  rsvpSession?: boolean;
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

export interface RsvpRosterBatchRouteError {
  code: string;
  message: string;
  details?: unknown;
}

export interface RsvpRosterBatchRouteReply<T> {
  status?: number;
  data?: T;
  error?: RsvpRosterBatchRouteError;
}

export interface RsvpRosterBatchPreviewContext {
  attempt: number;
  request: RsvpRosterBatchPreviewRequest;
  defaultResponse: RsvpRosterBatchPreviewResponse;
}

export interface RsvpRosterBatchCommitContext {
  attempt: number;
  request: RsvpRosterBatchCommitRequest;
  defaultResponse: RsvpRosterBatchCommitResponse;
}

type RsvpRosterBatchResolverResult<T> =
  | T
  | RsvpRosterBatchRouteReply<T>
  | undefined;

export interface RsvpRosterBatchRouteOptions {
  initialHouseholds?: number;
  initialInvitedCapacity?: number;
  occupiedHouseholdKeys?: readonly string[];
  preview?(
    context: RsvpRosterBatchPreviewContext,
  ): RsvpRosterBatchResolverResult<RsvpRosterBatchPreviewResponse>
    | Promise<RsvpRosterBatchResolverResult<RsvpRosterBatchPreviewResponse>>;
  commit?(
    context: RsvpRosterBatchCommitContext,
  ): RsvpRosterBatchResolverResult<RsvpRosterBatchCommitResponse>
    | Promise<RsvpRosterBatchResolverResult<RsvpRosterBatchCommitResponse>>;
}

export interface RsvpRosterBatchRequestLog {
  previews: RsvpRosterBatchPreviewRequest[];
  previewResponses: RsvpRosterBatchPreviewResponse[];
  commits: RsvpRosterBatchCommitRequest[];
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
  // The RSVP half of the guest API is deliberately stateful: a successful lookup
  // grants the session, a saved response becomes what a later visit reads back,
  // and a reload has to find the same answer a real household would.
  let household = options.household ?? null;
  let session = options.rsvpSession ?? options.household !== undefined;
  const sessionRequired = (route: Route) => route.fulfill({
    status: 401,
    json: {
      code: 'RSVP_SESSION_REQUIRED',
      message: 'Find your invitation to continue.',
      requestId: 'request-a',
    },
  });

  await page.route(`${base}/rsvp/lookup`, (route) => {
    const answer: RsvpLookupResponse = options.lookup
      ?? (household
        ? { status: 'matched', household }
        : {
            status: 'not_available',
            message: 'We could not open an invitation with those details.',
          });
    if (answer.status === 'matched') {
      household = answer.household;
      session = true;
    }
    return route.fulfill({ json: { data: answer, requestId: 'request-a' } });
  });
  await page.route(`${base}/rsvp/household`, (route) => {
    if (route.request().method() === 'PUT') {
      if (options.submission) {
        household = options.submission.household;
        session = true;
        return route.fulfill({ json: { data: options.submission, requestId: 'request-a' } });
      }
      if (!household || !session) return sessionRequired(route);
      const submitted = route.request().postDataJSON() as RsvpSubmissionRequest;
      const answered = new Map(submitted.invitees.map((invitee) => [invitee.id, invitee]));
      const committed = household.version + 1;
      household = {
        ...household,
        version: committed,
        invitees: household.invitees.map((invitee) => {
          const answer = answered.get(invitee.id);
          if (!answer) return invitee;
          return {
            ...invitee,
            attendance: answer.attendance,
            displayName: invitee.kind === 'named' ? invitee.displayName : answer.displayName,
          };
        }),
        firstRespondedAt: household.firstRespondedAt ?? '2026-08-01T00:00:00Z',
        latestRespondedAt: '2026-08-02T00:00:00Z',
        latestActor: 'household',
      };
      return route.fulfill({
        json: {
          data: { household, committedVersion: committed, replayed: false },
          requestId: 'request-a',
        },
      });
    }
    return household && session
      ? route.fulfill({ json: { data: { household }, requestId: 'request-a' } })
      : sessionRequired(route);
  });
}

// The printed credential never travels in a URL the Worker sees, so the browser
// suite navigates the real `/join#…` shell and stubs only the same-origin POST it
// makes. Cookie and header behaviour is proved in `tests/worker`.
export async function stubEntryExchange(page: Page, slug = GUEST_EVENT_FIXTURE.slug) {
  const submitted: string[] = [];
  await page.route('**/api/entry/exchange', (route) => {
    const body = route.request().postDataJSON() as { token?: string };
    submitted.push(body.token ?? '');
    return route.fulfill({
      json: { data: { location: `/event/${slug}` }, requestId: 'request-a' },
    });
  });
  return submitted;
}

function generatedHouseholdKey(label: string): string {
  const normalized = label.normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/gu, '');
  return (normalized || 'household').slice(0, 64);
}

function availableGeneratedHouseholdKey(base: string, used: ReadonlySet<string>): string {
  if (!used.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const ending = `-${suffix}`;
    const candidate = `${base.slice(0, 64 - ending.length)}${ending}`;
    if (!used.has(candidate)) return candidate;
  }
}

function canonicalizeRosterBatch(
  batch: RsvpRosterBatchDraft,
  occupiedHouseholdKeys: readonly string[],
): RsvpRosterCanonicalBatch {
  const used = new Set(occupiedHouseholdKeys);
  for (const create of batch.creates) {
    if (create.householdKey?.provenance === 'supplied') {
      used.add(create.householdKey.value);
    }
  }

  return {
    creates: batch.creates.map((create) => {
      const supplied = create.householdKey?.provenance === 'supplied'
        ? { ...create.householdKey }
        : null;
      const generated = supplied
        ? null
        : availableGeneratedHouseholdKey(generatedHouseholdKey(create.label), used);
      if (generated) used.add(generated);
      return {
        ...create,
        householdKey: supplied ?? { value: generated!, provenance: 'generated' },
        namedInvitees: create.namedInvitees.map((invitee) => ({ ...invitee })),
      };
    }),
    appends: batch.appends.map((append) => ({
      ...append,
      namedInvitees: append.namedInvitees.map((invitee) => ({ ...invitee })),
      ...(append.newPlusOneResponses
        ? { newPlusOneResponses: append.newPlusOneResponses.map((response) => ({ ...response })) }
        : {}),
    })),
  };
}

function rosterBatchTotals(
  batch: RsvpRosterBatchDraft | RsvpRosterCanonicalBatch,
  options: RsvpRosterBatchRouteOptions,
): RsvpRosterBatchTotals {
  const namedInviteesAdded = [...batch.creates, ...batch.appends]
    .reduce((total, household) => total + household.namedInvitees.length, 0);
  const plusOneCapacityAdded = batch.creates
    .reduce((total, household) => total + household.plusOneSlots, 0)
    + batch.appends.reduce((total, household) => total + household.plusOneSlotsToAdd, 0);
  const invitedCapacityAdded = namedInviteesAdded + plusOneCapacityAdded;
  return {
    householdsCreated: batch.creates.length,
    householdsUpdated: batch.appends.length,
    namedInviteesAdded,
    plusOneCapacityAdded,
    invitedCapacityAdded,
    resultingHouseholds: (options.initialHouseholds ?? 0) + batch.creates.length,
    resultingInvitedCapacity: (options.initialInvitedCapacity ?? 0) + invitedCapacityAdded,
  };
}

function rosterBatchDigest(value: unknown): string {
  const source = JSON.stringify(value);
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0').repeat(8);
}

function deterministicHouseholdId(index: number): string {
  return `90000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
}

function isRosterBatchRouteReply<T extends object>(
  result: T | RsvpRosterBatchRouteReply<T>,
): result is RsvpRosterBatchRouteReply<T> {
  return 'status' in result || 'data' in result || 'error' in result;
}

async function fulfillRosterBatchRoute<T extends object>(
  route: Route,
  defaultResponse: T,
  result: RsvpRosterBatchResolverResult<T>,
  successStatus: number,
): Promise<T | null> {
  const response = result ?? defaultResponse;
  if (isRosterBatchRouteReply(response)) {
    if (response.error) {
      await route.fulfill({
        status: response.status ?? 409,
        json: { ...response.error, requestId: 'request-a' },
      });
      return null;
    }
    const data = response.data ?? defaultResponse;
    const status = response.status ?? successStatus;
    await route.fulfill({ json: { data, requestId: 'request-a' }, status });
    return status < 400 ? data : null;
  }
  await route.fulfill({
    status: successStatus,
    json: { data: response, requestId: 'request-a' },
  });
  return response;
}

export async function stubRsvpRosterBatchRoutes(
  page: Page,
  eventId = EVENT_FIXTURE.id,
  options: RsvpRosterBatchRouteOptions = {},
): Promise<RsvpRosterBatchRequestLog> {
  const requests: RsvpRosterBatchRequestLog = { previews: [], previewResponses: [], commits: [] };
  const previewsByDigest = new Map<string, RsvpRosterBatchPreviewResponse>();
  const committedByIdempotencyKey = new Map<string, {
    request: RsvpRosterBatchCommitRequest;
    response: RsvpRosterBatchCommitResponse;
  }>();
  let previewAttempt = 0;
  let commitAttempt = 0;
  const base = `**/api/manage/events/${eventId}/rsvp/roster`;

  await page.route(`${base}/preview`, async (route) => {
    const request = route.request().postDataJSON() as RsvpRosterBatchPreviewRequest;
    requests.previews.push(request);
    previewAttempt += 1;
    const canonicalBatch = canonicalizeRosterBatch(
      request.batch,
      options.occupiedHouseholdKeys ?? [],
    );
    const defaultResponse: RsvpRosterBatchPreviewResponse = {
      canonicalBatch,
      rosterVersion: request.expectedRosterVersion,
      targetVersions: canonicalBatch.appends.map((append) => ({
        clientHouseholdId: append.clientHouseholdId,
        householdId: append.householdId,
        version: append.expectedHouseholdVersion,
      })),
      totals: rosterBatchTotals(canonicalBatch, options),
      issues: [],
      previewDigest: rosterBatchDigest({
        eventId,
        canonicalBatch,
        expectedRosterVersion: request.expectedRosterVersion,
      }),
      canCommit: true,
    };
    const result = await options.preview?.({
      attempt: previewAttempt,
      request,
      defaultResponse,
    });
    const preview = await fulfillRosterBatchRoute(route, defaultResponse, result, 200);
    if (preview) {
      requests.previewResponses.push(preview);
      if (preview.canCommit) previewsByDigest.set(preview.previewDigest, preview);
    }
  });

  await page.route(`${base}/commit`, async (route) => {
    const request = route.request().postDataJSON() as RsvpRosterBatchCommitRequest;
    requests.commits.push(request);
    commitAttempt += 1;
    const reviewed = previewsByDigest.get(request.previewDigest);
    const priorCommit = committedByIdempotencyKey.get(request.idempotencyKey);
    const matchesPreview = reviewed !== undefined
      && request.expectedRosterVersion === reviewed.rosterVersion
      && JSON.stringify(request.canonicalBatch) === JSON.stringify(reviewed.canonicalBatch);
    const matchesReplay = priorCommit === undefined
      || JSON.stringify(request) === JSON.stringify(priorCommit.request);
    if (!matchesPreview || !matchesReplay) {
      await route.fulfill({
        status: 409,
        json: {
          code: 'RSVP_ROSTER_BATCH_CONFLICT',
          message: 'The committed roster batch no longer matches its reviewed preview.',
          requestId: 'request-a',
        },
      });
      return;
    }
    const replay = priorCommit?.response;
    const defaultResponse: RsvpRosterBatchCommitResponse = replay
      ? { ...replay, replayed: true }
      : {
          createdHouseholds: request.canonicalBatch.creates.map((create, index) => ({
            clientHouseholdId: create.clientHouseholdId,
            householdId: deterministicHouseholdId(index),
          })),
          updatedHouseholds: request.canonicalBatch.appends.map((append) => ({
            clientHouseholdId: append.clientHouseholdId,
            householdId: append.householdId,
            committedVersion: append.expectedHouseholdVersion + 1,
          })),
          totals: rosterBatchTotals(request.canonicalBatch, options),
          committedRosterVersion: request.expectedRosterVersion + 1,
          currentRosterVersion: request.expectedRosterVersion + 1,
          replayed: false,
        };
    const result = await options.commit?.({
      attempt: commitAttempt,
      request,
      defaultResponse,
    });
    const committed = await fulfillRosterBatchRoute(
      route,
      defaultResponse,
      result,
      replay ? 200 : 201,
    );
    if (!replay && committed) {
      committedByIdempotencyKey.set(request.idempotencyKey, {
        request,
        response: { ...committed, replayed: false },
      });
    }
  });

  return requests;
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
  await page.route(`${base}/settings`, (route) => route.fulfill({
    json: {
      data: { event: { ...event, ...route.request().postDataJSON() as Partial<EventView> } },
      requestId: 'request-a',
    },
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

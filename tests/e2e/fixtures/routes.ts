import type { Page, Route } from '@playwright/test';

import type {
  AlbumEntryInput,
  AlbumShareStatus,
  AlbumView,
  EventThemeConfigV1,
  EventThemeOverridesV1,
  EventThemePresetId,
  EventView,
  GalleryAudienceSummaryView,
  GuestEventView,
  GuestGuestbookItem,
  ManagerGuestbookItem,
  ManagerGalleryMediaView,
  ManagerTrashedMediaView,
  PhotoIntakeState,
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
  PublicAlbumView,
} from '../../../shared/contracts';
import type { ExportDownloadView, ExportView } from '../../../src/app/types';
import {
  EVENT_COVER_EFFECTS,
  type EventCoverEffectId,
  type EventCoverFocusV1,
  type EventCoverPreparationView,
} from '../../../shared/event-cover';
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
  guestbookPrompt: 'Share a wish, memory, or moment from the day.',
  cover: { revision: 0, hasCover: false, available2xProfiles: [], surfaceTreatment: 'none' },
  uploadsEnabled: true,
  galleryVisible: true,
  moderationRequired: true,
  eventTimezone: 'America/Chicago',
  // 5 pm on the event date in the event's own zone, which is UTC-5 that week.
  // Every guest fixture below is an event that has already begun.
  eventStartAt: '2026-09-19T22:00:00.000Z',
  // The existing photo fixtures are explicitly photos-primary with RSVP off, so
  // no upload or receipt baseline picks up an RSVP disclosure it never had.
  rsvpDeadlineAt: null,
  rsvpDeadlineDate: null,
  phase: 'photos-primary',
  rsvpState: 'disabled',
  // At or after the start RSVP has left the guest experience, and no boundary
  // remains to wake for. A partial that moves the phase moves both of these.
  rsvpAccess: 'unavailable',
  lifecycleRecheckAfterMs: null,
  theme: eventTheme('candidary-default'),
};

export const EVENT_FIXTURE: EventView = {
  ...GUEST_EVENT_FIXTURE,
  // Manager-only, like the capacity counters beside them: a guest is never told
  // how much of the event is in Recently deleted.
  recoverableMediaCount: 0,
  recoverableBytes: 0,
  // Manager-only semantic configuration and preparation never reach the guest.
  cover: {
    config: { version: 1, source: { kind: 'none' } },
    revision: 0,
    hasCover: false,
    available2xProfiles: [],
    surfaceTreatment: 'none',
    preparation: null,
  },
  eventStartTime: '17:00',
  // Permitted and past its start, which is the state every manager fixture is in.
  photosOpen: true,
  photoIntakeState: 'open',
  photoIntakeRecheckAfterMs: null,
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
  kind?: 'message' | 'caption';
  guestName: string | null;
  body: string;
  moderationStatus: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  mediaId?: string | null;
}

interface GuestRouteOptions {
  event?: Partial<GuestEventView>;
  eventReplies?: readonly GuestEventView[];
  gallery?: ReturnType<typeof makeMedia>;
  contributions?: ReturnType<typeof makeMedia>;
  messages?: GuestMessage[];
  guestbook?: {
    shared?: GuestGuestbookItem[];
    ownUnshared?: GuestGuestbookItem[];
    nextCursor?: string | null;
    ownUnsharedNextCursor?: string | null;
  };
  cover?: Buffer;
  coverSlotFailures?: Partial<Record<'webp' | 'jpeg', number>>;
  household?: RsvpHouseholdView | null;
  lookup?: RsvpLookupResponse;
  submission?: RsvpSubmissionResponse;
  // Whether the browser starts already holding a household session. It defaults to
  // true whenever a household fixture is supplied, so a test that wants the
  // first-visit lookup screen with a matchable household says so explicitly.
  rsvpSession?: boolean;
}

export type CoverRouteKind =
  | 'slot'
  | 'draft'
  | 'transform'
  | 'preview'
  | 'publication'
  | 'status'
  | 'restart'
  | 'event-refresh';

export interface CoverRouteObservation {
  kind: CoverRouteKind;
  method: string;
  path: string;
  timestamp: number;
  requestBody: unknown;
  responseStatus: number;
  responseHeaders: Record<string, string>;
}

export interface CoverFixtureAudit {
  records: CoverRouteObservation[];
}

export type CoverOperationScenarioReply =
  | { kind: 'drop' }
  | {
      kind: 'error';
      status: number;
      code: string;
      message: string;
    }
  | {
      kind?: 'operation';
      status?: number;
      operationStatus?: EventCoverPreparationView['status'];
      completedSteps?: number;
      requiredSteps?: number;
      retryable?: boolean;
      safeFailureCode?: EventCoverPreparationView['safeFailureCode'];
      retryAfter?: string;
      location?: string;
      includeEvent?: boolean;
    };

export interface CoverStudioRouteScenario {
  publicationReplies?: readonly CoverOperationScenarioReply[];
  statusReplies?: readonly CoverOperationScenarioReply[];
  restartReplies?: readonly CoverOperationScenarioReply[];
  eventReplies?: readonly EventView[];
  previewFailures?: Partial<Record<EventCoverEffectId, number>>;
  previewDelaysMs?: Partial<Record<EventCoverEffectId, number>>;
  slotFailures?: Partial<Record<'webp' | 'jpeg', number>>;
}

export interface AlbumWorkspaceRouteOptions {
  pickedMediaIds?: readonly string[];
  title?: string;
  description?: string;
  coverMediaId?: string | null;
  entries?: readonly AlbumEntryInput[];
  saved?: boolean;
  shareActive?: boolean;
  shareToken?: string;
  managerPreviewFailures?: readonly string[];
  publicPreviewFailures?: readonly string[];
  managerPreviewGates?: Readonly<Record<string, Promise<void>>>;
  publicPreviewGates?: Readonly<Record<string, Promise<void>>>;
  singlePublicationGate?: Promise<void>;
  bulkPublicationGate?: Promise<void>;
  albumReadGate?: Promise<void>;
  albumWriteGate?: Promise<void>;
  shareGate?: Promise<void>;
  exchangeGate?: Promise<void>;
  publicReadGate?: Promise<void>;
  exportGate?: Promise<void>;
  exportReadyAfterReads?: number;
}

interface ManagerRouteOptions {
  event?: Partial<EventView>;
  // Keyed by the cursor the client sends back; `first` answers a request that carries no cursor.
  mediaPages: Record<string, { media: ReturnType<typeof makeMedia>; nextCursor: string | null }>;
  trashedMedia?: readonly ManagerTrashedMediaView[];
  messages?: GuestMessage[];
  guestbook?: {
    items?: ManagerGuestbookItem[];
    summary?: GuestbookSummaryFixture;
    actionGate?: Promise<void>;
  };
  exports?: unknown[];
  album?: AlbumWorkspaceRouteOptions;
  galleryAudienceSummary?: GalleryAudienceSummaryView;
  cover?: Buffer;
  coverSlotFailures?: Partial<Record<'webp' | 'jpeg', number>>;
  coverScenario?: CoverStudioRouteScenario;
  entry?: { eventLink: string | null; disabledAt: string | null };
  rsvp?: {
    summary?: RsvpSummary;
    households?: RsvpHouseholdListPage;
    detail?: RsvpHouseholdDetail;
    preview?: RsvpImportPreview;
  };
}

export interface AlbumRouteObservation {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
  responseStatus: number;
}

export interface GuestbookSummaryFixture {
  needsReviewCount: number;
  sharedCount: number;
  hiddenCount: number;
  deletedCount: number;
  galleryVisible: boolean;
}

function guestItemFromMessage(message: GuestMessage): GuestGuestbookItem {
  if (message.kind === 'caption' && message.mediaId) {
    const state = message.moderationStatus === 'pending'
      ? 'unpublished'
      : message.moderationStatus === 'approved' ? 'published' : 'hidden';
    return {
      id: message.id,
      source: 'photo_caption',
      kind: 'caption',
      mediaId: message.mediaId,
      guestName: message.guestName,
      body: message.body,
      createdAt: message.createdAt,
      state,
      moderationStatus: message.moderationStatus,
      visibility: state === 'published' ? 'shared' : 'author_only',
      previewAvailable: true,
      isOwn: true,
    } as GuestGuestbookItem;
  }
  return {
    id: message.id,
    source: 'guest_note',
    kind: 'message',
    mediaId: null,
    guestName: message.guestName,
    body: message.body,
    createdAt: message.createdAt,
    state: message.moderationStatus,
    moderationStatus: message.moderationStatus,
    visibility: message.moderationStatus === 'approved' ? 'shared' : 'author_only',
    isOwn: true,
  } as GuestGuestbookItem;
}

function managerItemFromMessage(message: GuestMessage): ManagerGuestbookItem {
  const guestItem = guestItemFromMessage(message);
  if (guestItem.source === 'photo_caption') {
    return {
      id: guestItem.id,
      source: guestItem.source,
      mediaId: guestItem.mediaId,
      guestName: guestItem.guestName,
      body: guestItem.body,
      createdAt: guestItem.createdAt,
      state: guestItem.state,
      visibility: guestItem.visibility,
      previewAvailable: guestItem.previewAvailable,
    };
  }
  return {
    id: guestItem.id,
    source: guestItem.source,
    guestName: guestItem.guestName,
    body: guestItem.body,
    createdAt: guestItem.createdAt,
    state: guestItem.state,
    visibility: guestItem.visibility,
  };
}

function managerSummary(
  items: readonly ManagerGuestbookItem[],
  galleryVisible: boolean,
): GuestbookSummaryFixture {
  return {
    needsReviewCount: items.filter((item) => item.state === 'pending' || item.state === 'unpublished').length,
    sharedCount: items.filter((item) => item.visibility === 'shared').length,
    hiddenCount: items.filter((item) => item.visibility === 'author_only'
      && item.state !== 'pending' && item.state !== 'unpublished').length,
    deletedCount: items.filter((item) => item.state === 'deleted').length,
    galleryVisible,
  };
}

function coverAudit(): CoverFixtureAudit {
  return { records: [] };
}

function requestBody(route: Route): unknown {
  try {
    return route.request().postDataJSON();
  } catch {
    return route.request().postData() ?? null;
  }
}

function recordCoverRoute(
  audit: CoverFixtureAudit,
  route: Route,
  kind: CoverRouteKind,
  responseStatus: number,
  responseHeaders: Record<string, string> = {},
) {
  audit.records.push({
    kind,
    method: route.request().method(),
    path: new URL(route.request().url()).pathname,
    timestamp: Date.now(),
    requestBody: requestBody(route),
    responseStatus,
    responseHeaders,
  });
}

const COVER_PROFILE_PATTERN = '(?:short-lookup|compact-default|standard-default|framed-default|compact-expanded|wide-expanded)';

function selectedReply(
  replies: readonly CoverOperationScenarioReply[] | undefined,
  index: number,
  fallback: CoverOperationScenarioReply,
): CoverOperationScenarioReply {
  if (!replies?.length) return fallback;
  return replies[Math.min(index, replies.length - 1)]!;
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

const PHOTO_INTAKE_TRANSITIONS: Record<string, PhotoIntakeState> = {
  open_early: 'open-early',
  return_to_schedule: 'scheduled',
  pause: 'paused',
  reopen: 'open',
};

export async function stubGuestRoutes(page: Page, options: GuestRouteOptions = {}) {
  const audit = coverAudit();
  let event: GuestEventView = { ...GUEST_EVENT_FIXTURE, ...options.event };
  const gallery = options.gallery ?? makeMedia(1);
  const contributions = options.contributions ?? gallery;
  const messages = [...(options.messages ?? [])];
  const defaultGuestbook = messages.map(guestItemFromMessage);
  const sharedGuestbook = [...(options.guestbook?.shared
    ?? defaultGuestbook.filter((item) => item.visibility === 'shared'))];
  const ownGuestbook = [...(options.guestbook?.ownUnshared
    ?? defaultGuestbook.filter((item) => item.visibility === 'author_only'))];
  const submittedMessages = new Map<string, GuestMessage>();
  const coverSlotAttempts = new Map<'webp' | 'jpeg', number>();
  const base = `**/api/event/${event.slug}`;

  await page.route('**/api/media/*/preview', (route) => route.fulfill({
    status: 200,
    contentType: 'image/png',
    body: PHOTOGRAPHIC_COVER,
  }));
  await page.route(new RegExp(
    `/api/event/${event.slug}/cover/([0-9]+)/${COVER_PROFILE_PATTERN}/(?:1x|2x)\\.(?:webp|jpeg)$`,
    'u',
  ), (route) => {
    const path = new URL(route.request().url()).pathname;
    const requestedRevision = Number(path.split('/cover/')[1]?.split('/')[0]);
    const format = path.endsWith('.webp') ? 'webp' : 'jpeg';
    const attempt = (coverSlotAttempts.get(format) ?? 0) + 1;
    coverSlotAttempts.set(format, attempt);
    const forcedFailure = attempt <= (options.coverSlotFailures?.[format] ?? 0);
    const status = !forcedFailure && event.cover.hasCover && requestedRevision === event.cover.revision
      ? 200
      : 404;
    const headers: Record<string, string> = status === 200
      ? { 'cache-control': 'private, no-store', 'content-type': 'image/png' }
      : { 'cache-control': 'private, no-store' };
    recordCoverRoute(audit, route, 'slot', status, headers);
    return route.fulfill(status === 200
      ? { status, headers, body: options.cover ?? PHOTOGRAPHIC_COVER }
      : { status, headers, json: { code: 'EVENT_NOT_FOUND', message: 'No current cover.' } });
  });
  let eventReadIndex = 0;
  await page.route(base, (route) => {
    const replies = options.eventReplies;
    if (replies?.length) event = replies[Math.min(eventReadIndex, replies.length - 1)]!;
    eventReadIndex += 1;
    recordCoverRoute(audit, route, 'event-refresh', 200, { 'content-type': 'application/json' });
    return route.fulfill({ json: { data: { event, role: 'guest' }, requestId: 'request-a' } });
  });
  await page.route(`${base}/gallery`, (route) => route.fulfill({
    json: { data: { media: gallery }, requestId: 'request-a' },
  }));
  await page.route(`${base}/contributions`, (route) => route.fulfill({
    json: { data: { media: contributions }, requestId: 'request-a' },
  }));
  await page.route(`${base}/messages*`, async (route) => {
    if (route.request().method() === 'POST') {
      const payload = route.request().postDataJSON() as {
        idempotencyKey: string;
        guestName: string | null;
        body: string;
      };
      const replayed = submittedMessages.get(payload.idempotencyKey);
      const message = replayed ?? {
        id: crypto.randomUUID(),
        kind: 'message',
        guestName: payload.guestName,
        body: payload.body.trim(),
        moderationStatus: event.moderationRequired ? 'pending' : 'approved',
        createdAt: new Date().toISOString(),
        mediaId: null,
      };
      if (!replayed) {
        submittedMessages.set(payload.idempotencyKey, message);
        messages.push(message);
      }
      const item = guestItemFromMessage(message);
      if (!replayed) {
        if (item.visibility === 'shared') sharedGuestbook.unshift(item);
        else ownGuestbook.unshift(item);
      }
      await route.fulfill({
        status: replayed ? 200 : 201,
        json: { data: { item, message, replayed: Boolean(replayed) }, requestId: 'request-a' },
      });
      return;
    }
    const contract = new URL(route.request().url()).searchParams.get('contract');
    if (contract === '2') {
      await route.fulfill({
        json: {
          data: {
            items: sharedGuestbook,
            nextCursor: options.guestbook?.nextCursor ?? null,
            ownUnshared: ownGuestbook,
            ownUnsharedCount: ownGuestbook.length,
            ownUnsharedNextCursor: options.guestbook?.ownUnsharedNextCursor ?? null,
          },
          requestId: 'request-a',
        },
      });
      return;
    }
    await route.fulfill({
      json: { data: { items: messages, nextCursor: null }, requestId: 'request-a' },
    });
  });
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
  return audit;
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
  const audit = coverAudit();
  let event = { ...EVENT_FIXTURE, ...options.event };
  let guestbookItems = [...(options.guestbook?.items
    ?? (options.messages ?? []).map(managerItemFromMessage))];
  const currentGuestbookSummary = () => options.guestbook?.summary
    ?? managerSummary(guestbookItems, event.galleryVisible);
  const base = `**/api/manage/events/${event.id}`;
  const albumOptions = options.album ?? {};
  const albumRequests: AlbumRouteObservation[] = [];
  const initialMedia = options.mediaPages.first?.media ?? [];
  const entryPickedIds = albumOptions.entries?.flatMap((entry) => (
    entry.kind === 'photo' ? [entry.mediaId] : []
  )) ?? [];
  const pickedMediaIds = new Set(albumOptions.pickedMediaIds ?? entryPickedIds);
  let galleryMedia: ManagerGalleryMediaView[] = initialMedia.map((item, index) => {
    const receivedAt = item.createdAt ?? new Date(Date.UTC(2026, 8, 19, 20, 0, index)).toISOString();
    return {
      id: item.id,
      originalFilename: item.originalFilename,
      guestName: item.guestName,
      caption: item.caption,
      publicationStatus: item.publicationStatus,
      previewAvailable: true,
      width: item.width ?? 1200,
      height: item.height ?? 800,
      receivedAt,
      timelineAt: receivedAt,
      timelineSource: 'received',
      isFavorite: pickedMediaIds.has(item.id),
    };
  });
  let albumEntries: AlbumEntryInput[] = albumOptions.entries
    ? albumOptions.entries.map((entry) => ({ ...entry }))
    : [...pickedMediaIds].map((mediaId) => ({ kind: 'photo', mediaId }));
  let albumRevision = 1;
  let albumSaved = albumOptions.saved ?? true;
  let albumTitle = albumOptions.title ?? 'Album';
  let albumDescription = albumOptions.description ?? '';
  let albumCoverMediaId = albumOptions.coverMediaId ?? null;
  let shareActive = albumOptions.shareActive ?? false;
  const shareToken = albumOptions.shareToken ?? 'album-share-id.album-share-secret';
  let albumSessionActive = false;
  const sharedAt = '2026-08-23T12:00:00.000Z';
  const managerPreviewFailures = new Set(albumOptions.managerPreviewFailures ?? []);
  const publicPreviewFailures = new Set(albumOptions.publicPreviewFailures ?? []);
  const exportJobs = [...(options.exports ?? [])] as ExportView[];
  let createdExportId: string | null = null;
  let createdExportReads = 0;

  const observeAlbumRoute = (route: Route, responseStatus: number) => {
    albumRequests.push({
      method: route.request().method(),
      path: new URL(route.request().url()).pathname,
      body: requestBody(route),
      headers: route.request().headers(),
      responseStatus,
    });
  };

  const resolveAlbumEntries = () => {
    const placed = new Set<string>();
    const entries: AlbumView['entries'] = [];
    for (const entry of albumEntries) {
      if (entry.kind === 'section') {
        entries.push({ ...entry });
        continue;
      }
      if (!pickedMediaIds.has(entry.mediaId) || placed.has(entry.mediaId)) continue;
      const photo = galleryMedia.find(({ id }) => id === entry.mediaId);
      if (!photo) continue;
      placed.add(photo.id);
      entries.push({ kind: 'photo', photo: { ...photo, isFavorite: true } });
    }
    for (const photo of galleryMedia) {
      if (!pickedMediaIds.has(photo.id) || placed.has(photo.id)) continue;
      placed.add(photo.id);
      entries.push({ kind: 'photo', photo: { ...photo, isFavorite: true } });
    }
    return entries;
  };

  const albumView = (): AlbumView => {
    const entries = resolveAlbumEntries();
    const firstEntry = entries.find((entry) => entry.kind === 'photo');
    const firstPhotoId = firstEntry?.kind === 'photo' ? firstEntry.photo.id : null;
    const coverIsPicked = albumCoverMediaId !== null && pickedMediaIds.has(albumCoverMediaId);
    return {
      revision: albumRevision,
      saved: albumSaved,
      title: albumTitle,
      description: albumDescription,
      coverMediaId: coverIsPicked ? albumCoverMediaId : null,
      effectiveCoverMediaId: coverIsPicked ? albumCoverMediaId : firstPhotoId,
      // These fixtures never trash a photo, so nothing is retained here.
      coverRetained: null,
      entries,
      photoCount: entries.filter((entry) => entry.kind === 'photo').length,
      retainedCount: 0,
      sectionCount: entries.filter((entry) => entry.kind === 'section').length,
      totalBytes: entries.filter((entry) => entry.kind === 'photo').length * 128,
    };
  };

  const publicAlbumView = (): PublicAlbumView => {
    const album = albumView();
    const entries: PublicAlbumView['entries'] = [];
    let pendingSection: Extract<PublicAlbumView['entries'][number], { kind: 'section' }> | null = null;
    for (const entry of album.entries) {
      if (entry.kind === 'section') {
        pendingSection = { kind: 'section', id: entry.id, heading: entry.heading };
        continue;
      }
      // A retained slot is a Manager concept; a recipient sees the album close
      // up around the gap. Keep a section pending across that gap so it only
      // appears if a later included photo gives it content.
      if (entry.kind === 'photo-retained') continue;
      if (pendingSection) {
        entries.push(pendingSection);
        pendingSection = null;
      }
      entries.push({
        kind: 'photo',
        photo: {
          id: entry.photo.id,
          // Publication controls caption eligibility for the Album link only.
          caption: entry.photo.publicationStatus === 'published' ? entry.photo.caption : null,
          previewAvailable: true,
        },
      });
    }
    return {
      title: album.title,
      description: album.description,
      coverMediaId: album.effectiveCoverMediaId,
      entries,
      photoCount: entries.filter((entry) => entry.kind === 'photo').length,
    };
  };

  const shareStatus = (origin: string): AlbumShareStatus => shareActive
    ? { active: true, url: `${origin}/album#${shareToken}`, sharedAt }
    : null;
  const scenario = options.coverScenario;
  const coverSlotAttempts = new Map<'webp' | 'jpeg', number>();

  await page.route('**/api/media/*/preview', (route) => route.fulfill({
    status: 200,
    contentType: 'image/png',
    body: PHOTOGRAPHIC_COVER,
  }));
  await page.route(new RegExp(
    `/api/manage/events/${event.id}/cover/([0-9]+)/${COVER_PROFILE_PATTERN}/(?:1x|2x)\\.(?:webp|jpeg)$`,
    'u',
  ), (route) => {
    const path = new URL(route.request().url()).pathname;
    const requestedRevision = Number(path.split('/cover/')[1]?.split('/')[0]);
    const format = path.endsWith('.webp') ? 'webp' : 'jpeg';
    const attempt = (coverSlotAttempts.get(format) ?? 0) + 1;
    coverSlotAttempts.set(format, attempt);
    const forcedFailure = attempt <= (
      scenario?.slotFailures?.[format]
      ?? options.coverSlotFailures?.[format]
      ?? 0
    );
    const status = !forcedFailure && event.cover.hasCover && requestedRevision === event.cover.revision
      ? 200
      : 404;
    const headers: Record<string, string> = status === 200
      ? { 'cache-control': 'private, no-store', 'content-type': 'image/png' }
      : { 'cache-control': 'private, no-store' };
    recordCoverRoute(audit, route, 'slot', status, headers);
    return route.fulfill(status === 200
      ? { status, headers, body: options.cover ?? PHOTOGRAPHIC_COVER }
      : { status, headers, json: { code: 'EVENT_NOT_FOUND', message: 'No current cover.' } });
  });
  let publicationIndex = 0;
  let statusIndex = 0;
  let restartIndex = 0;
  let draftSource: 'new-upload' | 'existing-upload' = 'new-upload';
  let lastPublication: Record<string, unknown> | null = null;
  const appliedOperations = new Set<string>();
  const previewAttempts = new Map<EventCoverEffectId, number>();

  const draftView = (state: string) => ({
    id: 'draft-e2e',
    source: draftSource,
    state,
    revision: 1,
    expiresAt: '2026-08-17T00:00:00.000Z',
    compositionModelVersion: 1,
    master: { width: 2400, height: 1600, safeZoomMaximum: 2, available2xProfiles: [] },
    focus: state === 'reserved' || state === 'transferred'
      ? null
      : { x: 0.5, y: 0.5, modelVersion: 1 },
    preview: null,
  });

  const coverAfterPublication = (payload: Record<string, unknown>) => {
    const source = payload.source as { kind?: string; presetId?: string; draftId?: string } | undefined;
    const effect = typeof payload.effect === 'string' ? payload.effect : 'natural';
    if (source?.kind === 'none') {
      return {
        ...event.cover,
        config: { version: 1 as const, source: { kind: 'none' as const } },
        revision: event.cover.revision + 1,
        hasCover: false,
        available2xProfiles: [],
        surfaceTreatment: 'none' as const,
        preparation: null,
      };
    }
    if (source?.kind === 'preset') {
      return {
        ...event.cover,
        config: {
          version: 1 as const,
          source: { kind: 'preset' as const, presetId: source.presetId!, assetVersion: 1 as const },
          effect: effect as EventCoverEffectId,
        },
        revision: event.cover.revision + 1,
        hasCover: true,
        available2xProfiles: [],
        surfaceTreatment: effect === 'film' ? 'film-grain-v1' as const : 'none' as const,
        preparation: null,
      };
    }
    return {
      ...event.cover,
      config: {
        version: 1 as const,
        source: { kind: 'upload' as const },
        focus: (payload.focus ?? { mode: 'auto' }) as EventCoverFocusV1,
        effect: effect as EventCoverEffectId,
      },
      revision: event.cover.revision + 1,
      hasCover: true,
      available2xProfiles: [],
      surfaceTreatment: effect === 'film' ? 'film-grain-v1' as const : 'none' as const,
      preparation: null,
    };
  };

  const fulfillOperation = async (
    route: Route,
    kind: 'publication' | 'status' | 'restart',
    reply: CoverOperationScenarioReply,
    operationId: string,
  ) => {
    if (reply.kind === 'drop') {
      recordCoverRoute(audit, route, kind, 0);
      await route.abort('connectionclosed');
      return;
    }
    if (reply.kind === 'error') {
      recordCoverRoute(audit, route, kind, reply.status);
      await route.fulfill({
        status: reply.status,
        json: { code: reply.code, message: reply.message, requestId: 'request-a' },
      });
      return;
    }
    const operationStatus = reply.operationStatus ?? 'applied';
    const status = reply.status ?? (operationStatus === 'preparing' ? 202 : 200);
    const location = reply.location
      ?? `/api/manage/events/${event.id}/cover/publications/${operationId}`;
    const headers: Record<string, string> = {
      location,
      ...(reply.retryAfter ? { 'retry-after': reply.retryAfter } : {}),
    };
    const includeEvent = reply.includeEvent ?? operationStatus === 'applied';
    if (operationStatus === 'applied' && !appliedOperations.has(operationId)) {
      event = lastPublication
        ? { ...event, cover: coverAfterPublication(lastPublication) } as EventView
        : { ...event, cover: { ...event.cover, preparation: null } } as EventView;
      appliedOperations.add(operationId);
    }
    const operation: EventCoverPreparationView = {
      operationId,
      status: operationStatus,
      completedSteps: reply.completedSteps ?? (operationStatus === 'applied' ? 6 : 2),
      requiredSteps: reply.requiredSteps ?? 6,
      retryable: reply.retryable ?? operationStatus === 'retryable-failed',
      safeFailureCode: reply.safeFailureCode ?? null,
      updatedAt: new Date(1_775_000_000_000 + audit.records.length * 1000).toISOString(),
    };
    recordCoverRoute(audit, route, kind, status, headers);
    await route.fulfill({
      status,
      headers,
      json: {
        data: {
          operation,
          ...(operationStatus === 'applied' ? { appliedRevision: event.cover.revision } : {}),
          ...(includeEvent ? { event } : {}),
        },
        requestId: 'request-a',
      },
    });
  };

  // One stateful route covers drafts, bounded previews, publication dispatch,
  // polling, and same-operation restart. Its audit is the browser proof source.
  await page.route(
    new RegExp(`/api/manage/events/${event.id}/cover/(drafts|publications)`, 'u'),
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      const method = route.request().method();
      if (path.endsWith('/drafts')) {
        const payload = requestBody(route) as { source?: { kind?: string }; draftIntentId?: string };
        draftSource = payload.source?.kind === 'existing-upload' ? 'existing-upload' : 'new-upload';
        const state = draftSource === 'existing-upload' ? 'inspected' : 'reserved';
        recordCoverRoute(audit, route, 'draft', 200);
        return route.fulfill({
          json: {
            data: {
              draft: draftView(state),
              ingress: draftSource === 'new-upload'
                ? { method: 'PUT', path: `/api/manage/events/${event.id}/cover/drafts/draft-e2e/raw` }
                : null,
              replayed: false,
              draftIntentId: payload.draftIntentId,
            },
            requestId: 'request-a',
          },
        });
      }
      if (path.endsWith('/raw')) {
        recordCoverRoute(audit, route, 'transform', 200);
        return route.fulfill({
          json: { data: { draft: draftView('transferred') }, requestId: 'request-a' },
        });
      }
      if (path.endsWith('/inspect')) {
        recordCoverRoute(audit, route, 'transform', 200);
        return route.fulfill({
          json: { data: { draft: draftView('inspected') }, requestId: 'request-a' },
        });
      }
      if (path.endsWith('/composition')) {
        recordCoverRoute(audit, route, 'transform', 200);
        return route.fulfill({
          json: { data: { draft: draftView('ready') }, requestId: 'request-a' },
        });
      }
      const previewMatch = /\/previews\/([^/]+)$/u.exec(path);
      if (previewMatch) {
        const effect = previewMatch[1] as EventCoverEffectId;
        if (!(EVENT_COVER_EFFECTS as readonly string[]).includes(effect)) {
          recordCoverRoute(audit, route, 'preview', 404);
          return route.fulfill({ status: 404, json: { code: 'EVENT_NOT_FOUND', message: 'Unknown preview.' } });
        }
        const attempt = (previewAttempts.get(effect) ?? 0) + 1;
        previewAttempts.set(effect, attempt);
        const delay = scenario?.previewDelaysMs?.[effect] ?? 0;
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        const failThrough = scenario?.previewFailures?.[effect] ?? 0;
        const status = attempt <= failThrough ? 503 : 200;
        recordCoverRoute(audit, route, 'preview', status, { 'content-type': 'image/png' });
        return route.fulfill(status === 200
          ? { status, contentType: 'image/png', body: options.cover ?? PHOTOGRAPHIC_COVER }
          : { status, json: { code: 'COVER_PREVIEW_FAILED', message: 'Preview unavailable.' } });
      }
      if (path.endsWith('/restart')) {
        const operationId = path.split('/').at(-2)!;
        const reply = selectedReply(scenario?.restartReplies, restartIndex, {
          operationStatus: 'preparing', status: 202, retryAfter: '1',
        });
        restartIndex += 1;
        return fulfillOperation(route, 'restart', reply, operationId);
      }
      if (path.endsWith('/publications') && method === 'POST') {
        lastPublication = requestBody(route) as Record<string, unknown>;
        const operationId = String(lastPublication.operationId ?? 'operation-e2e');
        const reply = selectedReply(scenario?.publicationReplies, publicationIndex, {
          operationStatus: 'applied', status: 200, includeEvent: true,
        });
        publicationIndex += 1;
        return fulfillOperation(route, 'publication', reply, operationId);
      }
      if (path.includes('/publications/')) {
        const operationId = path.split('/').at(-1)!;
        const reply = selectedReply(scenario?.statusReplies, statusIndex, {
          operationStatus: 'applied', status: 200, includeEvent: true,
        });
        statusIndex += 1;
        return fulfillOperation(route, 'status', reply, operationId);
      }
      if (method === 'DELETE') {
        recordCoverRoute(audit, route, 'draft', 200);
        return route.fulfill({
          json: { data: { draft: draftView('discarded') }, requestId: 'request-a' },
        });
      }
      recordCoverRoute(audit, route, 'draft', 200);
      return route.fulfill({ json: { data: { draft: draftView('ready') }, requestId: 'request-a' } });
    },
  );
  await page.route(`${base}/media**`, async (route) => {
    if (route.request().method() === 'PATCH') {
      const mediaId = new URL(route.request().url()).pathname.split('/').at(-1)!;
      const payload = route.request().postDataJSON() as { action: 'publish' | 'hide' };
      const current = guestbookItems.find((item) => item.source === 'photo_caption' && item.mediaId === mediaId);
      if (!current || current.source !== 'photo_caption') {
        await route.fulfill({ status: 404, json: { code: 'MEDIA_NOT_FOUND', message: 'Photo not found.' } });
        return;
      }
      await options.guestbook?.actionGate;
      const item: ManagerGuestbookItem = {
        ...current,
        state: payload.action === 'publish' ? 'published' : 'hidden',
        visibility: payload.action === 'publish' && event.galleryVisible ? 'shared' : 'author_only',
      };
      guestbookItems = guestbookItems.map((candidate) => candidate.id === current.id ? item : candidate);
      await route.fulfill({ json: { data: { item }, requestId: 'request-a' } });
      return;
    }
    // `cursor=` is a 422, so the client omits the parameter for the first page.
    const query = new URL(route.request().url()).searchParams;
    const cursor = query.get('cursor') ?? 'first';
    const mediaPage = options.mediaPages[cursor] ?? { media: [], nextCursor: null };
    const status = query.get('status');
    const media = status === 'unpublished' || status === 'published' || status === 'hidden'
      ? mediaPage.media.filter((item) => item.publicationStatus === status)
      : mediaPage.media;
    return route.fulfill({
      json: { data: { ...mediaPage, media }, requestId: 'request-a' },
    });
  });
  // The broad media route above retains its Guestbook caption-PATCH semantics. This exact,
  // gate-scoped handler is registered afterwards so a Guest-gallery fixture can model the ordinary
  // Manager media write without changing unrelated route defaults.
  await page.route(new RegExp(`/api/manage/events/${event.id}/media/[^/?]+$`, 'u'), async (route) => {
    if (
      route.request().method() !== 'PATCH'
      || albumOptions.singlePublicationGate === undefined
    ) return route.fallback();

    await albumOptions.singlePublicationGate;
    const mediaId = new URL(route.request().url()).pathname.split('/').at(-1)!;
    const payload = route.request().postDataJSON() as {
      action: 'publish' | 'hide';
      expectedStatus?: ManagerGalleryMediaView['publicationStatus'];
    };
    const current = galleryMedia.find((item) => item.id === mediaId);
    if (!current) {
      return route.fulfill({
        status: 404,
        json: { code: 'MEDIA_NOT_FOUND', message: 'Photo not found.', requestId: 'request-a' },
      });
    }
    if (payload.expectedStatus && current.publicationStatus !== payload.expectedStatus) {
      return route.fulfill({
        status: 409,
        json: {
          code: 'VALIDATION_FAILED',
          message: 'The photo publication status has changed.',
          requestId: 'request-a',
        },
      });
    }

    const nextStatus = payload.action === 'publish' ? 'published' : 'hidden';
    const media = { ...current, publicationStatus: nextStatus };
    galleryMedia = galleryMedia.map((item) => item.id === mediaId ? media : item);
    for (const pageFixture of Object.values(options.mediaPages)) {
      const source = pageFixture.media.find((item) => item.id === mediaId);
      if (source) source.publicationStatus = nextStatus;
    }
    return route.fulfill({
      json: { data: { media }, requestId: 'request-a' },
    });
  });
  await page.route(`${base}/media/trash`, (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      json: {
        data: { media: options.trashedMedia ?? [], nextCursor: null },
        requestId: 'request-a',
      },
    });
  });
  await page.route(`${base}/gallery/summary`, (route) => {
    const album = albumView();
    const summary = options.galleryAudienceSummary ?? {
      albumPhotoCount: album.photoCount,
      albumEntryCount: album.entries.length,
      albumLink: { active: shareActive, sharedAt: shareActive ? sharedAt : null },
      guestGalleryVisible: event.galleryVisible,
      guestGalleryPublishedCount: galleryMedia.filter(
        ({ publicationStatus }) => publicationStatus === 'published',
      ).length,
    };
    return route.fulfill({ json: { data: { summary }, requestId: 'request-a' } });
  });
  await page.route(`${base}/gallery**`, (route) => {
    if (new URL(route.request().url()).pathname.endsWith('/gallery/summary')) {
      return route.fallback();
    }
    const first = options.mediaPages.first?.media ?? [];
    const media = (first as Array<Record<string, unknown>>).map((item, index) => ({
      id: item.id ?? `gallery-${index}`,
      originalFilename: item.originalFilename ?? `photo-${index}.jpg`,
      guestName: item.guestName ?? 'Avery',
      caption: item.caption ?? null,
      publicationStatus: item.publicationStatus ?? 'unpublished',
      previewAvailable: true,
      width: 1200,
      height: 800,
      receivedAt: '2026-09-19T00:00:00.000Z',
      timelineAt: '2026-09-19T00:00:00.000Z',
      timelineSource: 'received',
      isFavorite: false,
    }));
    return route.fulfill({ json: { data: { media, nextCursor: null }, requestId: 'request-a' } });
  });
  await page.route(new RegExp(`/api/manage/events/${event.id}/media/[^/?]+/favorite$`, 'u'), (route) => {
    const mediaId = new URL(route.request().url()).pathname.split('/').at(-2)!;
    const favorite = (route.request().postDataJSON() as { favorite: boolean }).favorite;
    return route.fulfill({ json: { data: { media: { id: mediaId, isFavorite: favorite } }, requestId: 'request-a' } });
  });
  let eventReadIndex = 0;
  await page.route(new RegExp(`/api/manage/events/${event.id}$`, 'u'), (route) => {
    const replies = scenario?.eventReplies;
    if (replies?.length) {
      event = replies[Math.min(eventReadIndex, replies.length - 1)]!;
    }
    eventReadIndex += 1;
    recordCoverRoute(audit, route, 'event-refresh', 200, { 'content-type': 'application/json' });
    return route.fulfill({ json: { data: { event }, requestId: 'request-a' } });
  });
  await page.route(`${base}/settings`, (route) => route.fulfill({
    json: {
      data: { event: { ...event, ...route.request().postDataJSON() as Partial<EventView> } },
      requestId: 'request-a',
    },
  }));
  // Photo delivery left the settings payload and became four explicit actions.
  // The stub answers each with the state it reaches, never a client timestamp;
  // which transition is legal from the current row is the Worker's decision and
  // is proved in `tests/worker/photo-intake-api`.
  await page.route(`${base}/photo-intake`, (route) => {
    const { action } = route.request().postDataJSON() as { action: string };
    const reached = PHOTO_INTAKE_TRANSITIONS[action] ?? event.photoIntakeState;
    return route.fulfill({
      json: {
        data: {
          event: {
            ...event,
            uploadsEnabled: reached !== 'paused',
            photosOpen: reached === 'open' || reached === 'open-early',
            photoIntakeState: reached,
          },
        },
        requestId: 'request-a',
      },
    });
  });
  await page.route(`${base}/messages`, (route) => route.fulfill({
    json: { data: { messages: options.messages ?? [] }, requestId: 'request-a' },
  }));
  await page.route(`${base}/guestbook/summary`, (route) => route.fulfill({
    json: { data: { summary: currentGuestbookSummary() }, requestId: 'request-a' },
  }));
  await page.route(`${base}/guestbook?*`, (route) => {
    const query = new URL(route.request().url()).searchParams;
    const view = query.get('view') ?? 'shared';
    const source = query.get('source') ?? 'all';
    const galleryVisible = currentGuestbookSummary().galleryVisible;
    const items = guestbookItems.filter((item) => {
      if (source !== 'all' && item.source !== source) return false;
      if (view === 'needs-review') return item.state === 'pending' || item.state === 'unpublished';
      if (view === 'deleted') return item.state === 'deleted';
      if (view === 'shared') return item.visibility === 'shared';
      return item.visibility === 'author_only'
        && item.state !== 'pending' && item.state !== 'unpublished'
        && !(item.source === 'photo_caption' && item.state === 'published' && galleryVisible);
    });
    return route.fulfill({ json: {
      data: { items, nextCursor: null, summary: currentGuestbookSummary() },
      requestId: 'request-a',
    } });
  });
  await page.route(new RegExp(`/api/manage/events/${event.id}/messages/[^/?]+$`, 'u'), async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1)!;
    const payload = route.request().postDataJSON() as {
      action: 'approve' | 'reject' | 'delete' | 'restore' | 'purge';
    };
    const current = guestbookItems.find((item) => item.source === 'guest_note' && item.id === id);
    if (!current || current.source !== 'guest_note') {
      await route.fulfill({ status: 404, json: { code: 'MESSAGE_NOT_FOUND', message: 'Note not found.' } });
      return;
    }
    if (payload.action === 'purge') {
      await options.guestbook?.actionGate;
      guestbookItems = guestbookItems.filter((item) => item.id !== id);
      await route.fulfill({ json: { data: { purged: { source: 'guest_note', id } }, requestId: 'request-a' } });
      return;
    }
    const state = payload.action === 'approve' ? 'approved'
      : payload.action === 'reject' || payload.action === 'restore' ? 'rejected'
        : 'deleted';
    await options.guestbook?.actionGate;
    const item: ManagerGuestbookItem = state === 'deleted'
      ? { ...current, state, visibility: 'host_only' }
      : { ...current, state, visibility: state === 'approved' ? 'shared' : 'author_only' };
    guestbookItems = guestbookItems.map((candidate) => candidate.id === id ? item : candidate);
    await route.fulfill({ json: { data: { item }, requestId: 'request-a' } });
  });
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

  // Stateful Task 5 routes are registered after their broad legacy counterparts.
  // Playwright resolves routes last-in-first-out, so these exact handlers own the
  // album journey without changing the long-standing default fixtures above.
  await page.route(`${base}/album**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path.endsWith('/picks') && method === 'POST') {
      await albumOptions.albumWriteGate;
      const payload = route.request().postDataJSON() as { mediaIds: string[]; picked: boolean };
      const changed: ManagerGalleryMediaView[] = [];
      for (const mediaId of new Set(payload.mediaIds)) {
        const current = galleryMedia.find((item) => item.id === mediaId);
        if (!current || current.isFavorite === payload.picked) continue;
        if (payload.picked) pickedMediaIds.add(mediaId);
        else pickedMediaIds.delete(mediaId);
        const next = { ...current, isFavorite: payload.picked };
        galleryMedia = galleryMedia.map((item) => item.id === mediaId ? next : item);
        changed.push(next);
      }
      if (changed.length > 0) {
        albumRevision += 1;
        if (!payload.picked) {
          const changedIds = new Set(changed.map(({ id }) => id));
          albumEntries = albumEntries.filter((entry) => (
            entry.kind === 'section' || !changedIds.has(entry.mediaId)
          ));
          if (albumCoverMediaId && changedIds.has(albumCoverMediaId)) albumCoverMediaId = null;
        }
      }
      observeAlbumRoute(route, 200);
      return route.fulfill({
        json: { data: { changed }, requestId: 'request-a' },
      });
    }
    if (path.endsWith('/start') && method === 'POST') {
      await albumOptions.albumWriteGate;
      const payload = route.request().postDataJSON() as { start: 'from-picks' | 'empty' };
      const cleared = payload.start === 'empty' ? [...pickedMediaIds] : [];
      if (payload.start === 'empty') {
        pickedMediaIds.clear();
        galleryMedia = galleryMedia.map((photo) => ({ ...photo, isFavorite: false }));
        albumEntries = [];
        albumCoverMediaId = null;
      } else {
        albumEntries = galleryMedia
          .filter(({ id }) => pickedMediaIds.has(id))
          .map(({ id }) => ({ kind: 'photo', mediaId: id }));
      }
      albumSaved = true;
      albumRevision += 1;
      observeAlbumRoute(route, 200);
      return route.fulfill({
        json: { data: { album: albumView(), started: true, cleared }, requestId: 'request-a' },
      });
    }
    if (method === 'PUT' && path.endsWith('/album')) {
      await albumOptions.albumWriteGate;
      const payload = route.request().postDataJSON() as {
        entries: AlbumEntryInput[];
        metadata?: { title: string; description: string; coverMediaId: string | null };
      };
      albumEntries = payload.entries.map((entry) => ({ ...entry }));
      if (payload.metadata) {
        albumTitle = payload.metadata.title;
        albumDescription = payload.metadata.description;
        albumCoverMediaId = payload.metadata.coverMediaId;
      }
      albumSaved = true;
      albumRevision += 1;
      observeAlbumRoute(route, 200);
      return route.fulfill({
        json: { data: { album: albumView() }, requestId: 'request-a' },
      });
    }
    if (method === 'GET' && path.endsWith('/album')) {
      await albumOptions.albumReadGate;
      observeAlbumRoute(route, 200);
      return route.fulfill({
        json: { data: { album: albumView() }, requestId: 'request-a' },
      });
    }
    observeAlbumRoute(route, 404);
    return route.fulfill({
      status: 404,
      json: { code: 'ALBUM_NOT_FOUND', message: 'Album route not found.', requestId: 'request-a' },
    });
  });

  // Manager Album Preview. Registered with the other exact `/album/...` routes,
  // and deliberately independent of `shareActive`: Preview answers "what will a
  // recipient see", which a host may ask before they ever share and after they
  // stop. It is Manager-authenticated and never mints or exposes a credential.
  await page.route(`${base}/album/preview`, async (route) => {
    observeAlbumRoute(route, 200);
    return route.fulfill({
      headers: { 'cache-control': 'private, no-store', vary: 'Cookie' },
      json: { data: { album: publicAlbumView() }, requestId: 'request-a' },
    });
  });

  await page.route(`${base}/album/media/*/preview`, async (route) => {
    const mediaId = new URL(route.request().url()).pathname.split('/').at(-2)!;
    if (!pickedMediaIds.has(mediaId)) {
      return route.fulfill({
        status: 403,
        headers: { 'cache-control': 'private, no-store', vary: 'Cookie' },
        json: {
          code: 'RESOURCE_FORBIDDEN',
          message: 'This photo is not available.',
          requestId: 'request-a',
        },
      });
    }
    observeAlbumRoute(route, 200);
    return route.fulfill({
      status: 200,
      headers: {
        'cache-control': 'private, no-store',
        vary: 'Cookie',
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-origin',
      },
      contentType: 'image/png',
      body: PHOTOGRAPHIC_COVER,
    });
  });

  // More exact than `/album**`, therefore intentionally registered afterwards.
  await page.route(`${base}/album/share`, async (route) => {
    await albumOptions.shareGate;
    const method = route.request().method();
    const origin = new URL(route.request().url()).origin;
    if (method === 'POST') shareActive = true;
    if (method === 'DELETE') {
      shareActive = false;
      albumSessionActive = false;
    }
    observeAlbumRoute(route, 200);
    return route.fulfill({
      headers: { 'cache-control': 'private, no-store' },
      json: {
        data: { share: method === 'DELETE' ? null : shareStatus(origin) },
        requestId: 'request-a',
      },
    });
  });

  await page.route(`${base}/media/bulk`, async (route) => {
    await albumOptions.bulkPublicationGate;
    const payload = route.request().postDataJSON() as {
      ids: string[];
      action: 'publish' | 'hide';
      expectedStatus?: ManagerGalleryMediaView['publicationStatus'];
    };
    const nextStatus = payload.action === 'publish' ? 'published' : 'hidden';
    const changed: string[] = [];
    for (const id of payload.ids) {
      const current = galleryMedia.find((item) => item.id === id);
      if (!current || current.publicationStatus === nextStatus) continue;
      if (payload.expectedStatus && current.publicationStatus !== payload.expectedStatus) continue;
      changed.push(id);
      galleryMedia = galleryMedia.map((item) => item.id === id
        ? { ...item, publicationStatus: nextStatus }
        : item);
      for (const pageFixture of Object.values(options.mediaPages)) {
        const source = pageFixture.media.find((item) => item.id === id);
        if (source) source.publicationStatus = nextStatus;
      }
    }
    observeAlbumRoute(route, 200);
    return route.fulfill({
      json: {
        data: { changed: galleryMedia.filter(({ id }) => changed.includes(id)) },
        requestId: 'request-a',
      },
    });
  });

  await page.route(`${base}/gallery**`, (route) => {
    if (new URL(route.request().url()).pathname.endsWith('/gallery/summary')) {
      return route.fallback();
    }
    const query = new URL(route.request().url()).searchParams;
    const search = query.get('query')?.toLocaleLowerCase() ?? '';
    const favoritesOnly = query.get('favorites') === '1';
    const order = query.get('order') === 'earliest' ? 'earliest' : 'newest';
    const media = galleryMedia
      .filter((photo) => !favoritesOnly || photo.isFavorite)
      .filter((photo) => !search || [photo.caption, photo.originalFilename, photo.guestName]
        .some((value) => value?.toLocaleLowerCase().includes(search)))
      .toSorted((left, right) => order === 'earliest'
        ? left.timelineAt.localeCompare(right.timelineAt)
        : right.timelineAt.localeCompare(left.timelineAt));
    observeAlbumRoute(route, 200);
    return route.fulfill({
      json: { data: { media, nextCursor: null }, requestId: 'request-a' },
    });
  });

  await page.route(new RegExp(`/api/manage/events/${event.id}/media/[^/?]+/favorite$`, 'u'), async (route) => {
    await albumOptions.albumWriteGate;
    const mediaId = new URL(route.request().url()).pathname.split('/').at(-2)!;
    const favorite = (route.request().postDataJSON() as { favorite: boolean }).favorite;
    const current = galleryMedia.find((item) => item.id === mediaId);
    if (!current) {
      observeAlbumRoute(route, 404);
      return route.fulfill({
        status: 404,
        json: { code: 'MEDIA_NOT_FOUND', message: 'Photo not found.', requestId: 'request-a' },
      });
    }
    if (favorite !== current.isFavorite) {
      if (favorite) pickedMediaIds.add(mediaId);
      else {
        pickedMediaIds.delete(mediaId);
        albumEntries = albumEntries.filter((entry) => entry.kind === 'section' || entry.mediaId !== mediaId);
        if (albumCoverMediaId === mediaId) albumCoverMediaId = null;
      }
      albumRevision += 1;
    }
    const media = { ...current, isFavorite: favorite };
    galleryMedia = galleryMedia.map((item) => item.id === mediaId ? media : item);
    observeAlbumRoute(route, 200);
    return route.fulfill({ json: { data: { media }, requestId: 'request-a' } });
  });

  // One authoritative list/create route owns the lifecycle. A newly created
  // job remains queued on the first list read, advances to running with
  // observable progress on the second, and becomes ready on the configured
  // terminal read.
  // Download and retry handlers are more exact and are registered last.
  await page.route(`${base}/exports`, async (route) => {
    const method = route.request().method();
    if (method === 'POST') {
      await albumOptions.exportGate;
      const payload = requestBody(route) as { kind?: 'complete' | 'album' } | null;
      const kind = payload?.kind === 'album' ? 'album' : 'complete';
      const album = albumView();
      const mediaCount = kind === 'album' ? album.photoCount : galleryMedia.length;
      const job: ExportView = {
        id: `${kind}-export-e2e`,
        kind,
        state: 'queued',
        snapshotAt: '2026-08-23T12:00:00.000Z',
        createdAt: '2026-08-23T12:00:00.000Z',
        startedAt: null,
        completedAt: null,
        mediaCount,
        totalBytes: mediaCount * 128,
        processedMediaCount: null,
        processedBytes: null,
        progressUpdatedAt: null,
        attempt: 1,
        partCount: 0,
        expiresAt: null,
        errorCode: null,
        guestbookEntryCount: kind === 'album' ? null : guestbookItems.length,
        guestbookSharedCount: kind === 'album' ? null : currentGuestbookSummary().sharedCount,
        guestbookEventName: kind === 'album' ? null : event.name,
        guestbookEventDate: kind === 'album' ? null : event.eventDate,
        guestbookEventTimezone: kind === 'album' ? null : event.eventTimezone,
        guestbookPrompt: kind === 'album' ? null : event.guestbookPrompt,
        guestbookGalleryVisible: kind === 'album' ? null : event.galleryVisible,
      };
      exportJobs.unshift(job);
      createdExportId = job.id;
      createdExportReads = 0;
      observeAlbumRoute(route, 202);
      return route.fulfill({
        status: 202,
        json: { data: { export: job }, requestId: 'request-a' },
      });
    }

    if (createdExportId) {
      createdExportReads += 1;
      const readyAfter = Math.max(3, albumOptions.exportReadyAfterReads ?? 3);
      const index = exportJobs.findIndex(({ id }) => id === createdExportId);
      const current = exportJobs[index];
      if (current && current.state !== 'ready') {
        if (createdExportReads >= readyAfter) {
          exportJobs[index] = {
            ...current,
            state: 'ready',
            startedAt: current.startedAt ?? '2026-08-23T12:00:01.000Z',
            completedAt: '2026-08-23T12:00:03.000Z',
            processedMediaCount: current.mediaCount,
            processedBytes: current.totalBytes,
            progressUpdatedAt: '2026-08-23T12:00:03.000Z',
            partCount: current.mediaCount > 0 ? 1 : 0,
            expiresAt: '2026-08-24T12:00:00.000Z',
          };
        } else if (createdExportReads > 1) {
          const processedMediaCount = current.mediaCount === 0
            ? 0
            : Math.max(1, Math.floor(current.mediaCount / 2));
          const processedBytes = current.mediaCount === 0
            ? 0
            : Math.round(current.totalBytes * processedMediaCount / current.mediaCount);
          exportJobs[index] = {
            ...current,
            state: 'running',
            startedAt: '2026-08-23T12:00:01.000Z',
            completedAt: null,
            processedMediaCount,
            processedBytes,
            progressUpdatedAt: '2026-08-23T12:00:02.000Z',
            partCount: 0,
            expiresAt: null,
            errorCode: null,
          };
        }
      }
    }
    observeAlbumRoute(route, 200);
    return route.fulfill({
      json: { data: { exports: exportJobs }, requestId: 'request-a' },
    });
  });

  await page.route(`${base}/exports/*/retry`, (route) => {
    const exportId = new URL(route.request().url()).pathname.split('/').at(-2)!;
    const index = exportJobs.findIndex(({ id }) => id === exportId);
    if (index >= 0) exportJobs[index] = {
      ...exportJobs[index]!,
      state: 'queued',
      startedAt: null,
      completedAt: null,
      processedMediaCount: null,
      processedBytes: null,
      progressUpdatedAt: null,
      attempt: exportJobs[index]!.attempt + 1,
      partCount: 0,
      expiresAt: null,
      errorCode: null,
    };
    observeAlbumRoute(route, 200);
    return route.fulfill({
      json: { data: { export: index >= 0 ? exportJobs[index] : null }, requestId: 'request-a' },
    });
  });

  await page.route(`${base}/exports/*/download`, (route) => {
    const exportId = new URL(route.request().url()).pathname.split('/').at(-2)!;
    const job = exportJobs.find(({ id }) => id === exportId);
    const albumOnly = job?.kind === 'album';
    const origin = new URL(route.request().url()).origin;
    const download: ExportDownloadView = {
      manifest: job && job.mediaCount > 0 ? {
        url: `${origin}/downloads/${exportId}/manifest.csv`,
        expiresAt: '2026-08-24T12:00:00.000Z',
        filename: `${event.slug}-${albumOnly ? 'album-' : ''}manifest.csv`,
      } : null,
      parts: job && job.mediaCount > 0 ? [{
        partNumber: 1,
        mediaCount: job.mediaCount,
        sourceBytes: job.totalBytes,
        url: `${origin}/downloads/${exportId}/photos-1.zip`,
        expiresAt: '2026-08-24T12:00:00.000Z',
        filename: `${event.slug}-${albumOnly ? 'album-' : ''}photos-1.zip`,
      }] : [],
      printableGuestbook: albumOnly ? null : {
        url: `${origin}/downloads/${exportId}/guestbook.pdf`,
        expiresAt: '2026-08-24T12:00:00.000Z',
        filename: `${event.slug}-guestbook.pdf`,
      },
      privateGuestbook: albumOnly ? null : {
        url: `${origin}/downloads/${exportId}/guestbook-private.json`,
        expiresAt: '2026-08-24T12:00:00.000Z',
        filename: `${event.slug}-guestbook-private.json`,
      },
    };
    observeAlbumRoute(route, job ? 200 : 404);
    return route.fulfill(job
      ? { json: { data: download, requestId: 'request-a' } }
      : { status: 404, json: { code: 'EXPORT_NOT_FOUND', message: 'Export not found.', requestId: 'request-a' } });
  });

  await page.route('**/api/media/*/preview', async (route) => {
    const mediaId = new URL(route.request().url()).pathname.split('/').at(-2)!;
    await albumOptions.managerPreviewGates?.[mediaId];
    const failed = managerPreviewFailures.has(mediaId);
    observeAlbumRoute(route, failed ? 404 : 200);
    return route.fulfill(failed
      ? { status: 404, json: { code: 'PREVIEW_UNAVAILABLE', message: 'Preview unavailable.' } }
      : { status: 200, contentType: 'image/png', body: PHOTOGRAPHIC_COVER });
  });

  await page.route('**/api/media/*/original', (route) => {
    observeAlbumRoute(route, 403);
    return route.fulfill({
      status: 403,
      headers: { 'cache-control': 'private, no-store' },
      json: { code: 'ORIGINAL_FORBIDDEN', message: 'Original access is not available.', requestId: 'request-a' },
    });
  });

  const unavailableAlbum = (route: Route) => {
    observeAlbumRoute(route, 410);
    return route.fulfill({
      status: 410,
      headers: { 'cache-control': 'private, no-store' },
      json: { code: 'ALBUM_SHARE_UNAVAILABLE', message: 'This album is not available.', requestId: 'request-a' },
    });
  };

  // Broad public read first; exchange and media preview are more exact and win by
  // being registered afterwards.
  await page.route('**/api/album-share**', async (route) => {
    await albumOptions.publicReadGate;
    const cookie = route.request().headers().cookie ?? '';
    if (!shareActive || !albumSessionActive || !cookie.includes('candidary_album=')) {
      return unavailableAlbum(route);
    }
    observeAlbumRoute(route, 200);
    return route.fulfill({
      headers: { 'cache-control': 'private, no-store' },
      json: { data: { album: publicAlbumView() }, requestId: 'request-a' },
    });
  });

  await page.route('**/api/album-share/exchange', async (route) => {
    await albumOptions.exchangeGate;
    const token = (route.request().postDataJSON() as { token?: string }).token;
    if (!shareActive || token !== shareToken) return unavailableAlbum(route);
    albumSessionActive = true;
    observeAlbumRoute(route, 200);
    return route.fulfill({
      headers: {
        'cache-control': 'private, no-store',
        'set-cookie': 'candidary_album=album-session.fixture-secret; Max-Age=3600; Path=/api/album-share; HttpOnly; Secure; SameSite=Strict',
      },
      json: { data: { album: publicAlbumView() }, requestId: 'request-a' },
    });
  });

  await page.route('**/api/album-share/media/*/preview', async (route) => {
    const mediaId = new URL(route.request().url()).pathname.split('/').at(-2)!;
    await albumOptions.publicPreviewGates?.[mediaId];
    const cookie = route.request().headers().cookie ?? '';
    const permitted = shareActive
      && albumSessionActive
      && cookie.includes('candidary_album=')
      && pickedMediaIds.has(mediaId);
    if (!permitted || publicPreviewFailures.has(mediaId)) return unavailableAlbum(route);
    observeAlbumRoute(route, 200);
    return route.fulfill({
      status: 200,
      headers: { 'cache-control': 'private, no-store' },
      contentType: 'image/png',
      body: PHOTOGRAPHIC_COVER,
    });
  });

  return { ...audit, album: { requests: albumRequests } };
}

import { Hono, type Context } from 'hono';
import { z } from 'zod';

import { MAX_COVER_UPLOAD_BYTES } from '../../shared/constants';
import { ApiError } from '../../shared/errors';
import {
  canonicalCoverDraftCreate,
  canonicalCoverRequest,
  eventCoverCompositionSchema,
  eventCoverDraftCreateSchema,
  eventCoverPublishSchema,
} from '../../shared/event-cover';
import { requireManager } from '../auth/manager';
import { loadCoverDraft, writeCoverComposition, discardCoverDraft } from '../db/event-covers';
import { EventsRepository } from '../db/events';
import type { CoverDraftRow, EventRecord } from '../db/types';
import type { AppBindings } from '../env';
import { eventView } from '../http/event-view';
import { fieldErrors } from '../http/validation';
import {
  coverDraftView,
  inspectCoverDraft,
  readCoverDraftPreview,
  receiveCoverRaw,
  reserveCoverDraft,
} from '../services/event-cover-drafts';
import {
  acceptCoverPublication,
  applyRemovalPublication,
  confirmCoverDispatch,
  coverRequestDigest,
  coverWorkflowInstanceId,
  defaultCoverWorkflowAccessor,
  markDispatchFailed,
  readCoverPublication,
  restartCoverPublication,
  selectEventCoverPreparation,
} from '../services/event-cover-publication';

/**
 * The cover draft-and-publish surface.
 *
 * These handlers authorize and translate HTTP and nothing else: no object key,
 * transformation recipe, manifest, or cleanup rule is built here. Every write
 * opens with `requireManager(context, { write: true })`, which resolves account
 * membership and management-link credentials with explicit precedence and then
 * checks CSRF against the credential that actually authorized the request — so
 * the host and event cookie scopes stay non-interchangeable.
 *
 * The presigned `POST /cover` + `POST /cover/finalize` + `DELETE /cover` trio
 * this replaces let a client name its own object key and PUT unbounded bytes
 * straight to R2. Neither is available here: ownership is always resolved from
 * the event-scoped draft ID, and raw bytes arrive through one authenticated,
 * length-bounded, streaming ingress.
 */
export const eventCoverRoutes = new Hono<AppBindings>();

const emptyBodySchema = z.strictObject({});

function coverBase(eventId: string): string {
  return `/api/manage/events/${eventId}/cover`;
}

/**
 * The draft revision, as an `If-Match` entity tag.
 *
 * No route in this repository reads `If-Match` today — every optimistic check
 * passes its expected version in the JSON body — but a `DELETE` and a binary
 * `PUT` have no body to carry one. Absent is `428 Precondition Required`,
 * because the client can retry correctly once it knows; malformed or stale is
 * `409`, because it cannot.
 */
function requireIfMatchRevision(context: Context<AppBindings>): number {
  const header = context.req.header('if-match');
  if (!header) {
    throw new ApiError(
      'VALIDATION_FAILED',
      'This request needs the version of the cover upload it expects.',
      428,
    );
  }
  const parsed = Number(header.trim().replace(/^"|"$/gu, ''));
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ApiError(
      'COVER_DRAFT_STATE_CONFLICT',
      'That cover upload has moved on since this page loaded. Reload and try again.',
      409,
    );
  }
  return parsed;
}

async function managerDraft(
  context: Context<AppBindings>,
  write: boolean,
): Promise<{ event: EventRecord; draft: CoverDraftRow }> {
  const auth = await requireManager(context, { write });
  const draftId = context.req.param('draftId');
  if (!draftId) {
    throw new ApiError('EVENT_NOT_FOUND', 'That cover upload could not be found.', 404);
  }
  // Event-scoped by the read itself: a draft ID from another event resolves to
  // nothing here rather than to someone else's upload.
  const draft = await loadCoverDraft(context.env.DB, draftId, auth.event.id);
  return { event: auth.event, draft };
}

async function draftResponse(
  context: Context<AppBindings>,
  draft: CoverDraftRow,
  status: 200 | 201 = 200,
  extra: Record<string, unknown> = {},
) {
  const view = await coverDraftView(context.env, draft);
  return context.json(
    { data: { draft: view, ...extra }, requestId: context.get('requestId') },
    status,
  );
}

/* ------------------------------------------------------------------ *
 * Drafts
 * ------------------------------------------------------------------ */

eventCoverRoutes.post('/manage/events/:eventId/cover/drafts', async (context) => {
  const auth = await requireManager(context, { write: true });
  const parsed = eventCoverDraftCreateSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError(
      'VALIDATION_FAILED',
      `Choose a JPEG, PNG, WebP, or HEIC photo under ${Math.floor(MAX_COVER_UPLOAD_BYTES / 1_000_000)} MB.`,
      422,
      fieldErrors(parsed.error),
    );
  }

  const reservation = await reserveCoverDraft(context.env, {
    event: auth.event,
    request: parsed.data,
    requestDigest: await coverRequestDigest(canonicalCoverDraftCreate(parsed.data)),
    now: new Date(),
  });

  // The ingress route is named rather than signed. A presigned R2 PUT cannot
  // enforce a byte ceiling, and this one aborts mid-stream.
  const ingress = reservation.draft.source === 'new_upload'
    ? {
      method: 'PUT' as const,
      path: `${coverBase(auth.event.id)}/drafts/${reservation.draft.id}/raw`,
    }
    : null;

  return draftResponse(context, reservation.draft, 201, {
    ingress,
    replayed: reservation.replayed,
  });
});

eventCoverRoutes.get('/manage/events/:eventId/cover/drafts/:draftId', async (context) => {
  const { draft } = await managerDraft(context, false);
  return draftResponse(context, draft);
});

eventCoverRoutes.put('/manage/events/:eventId/cover/drafts/:draftId/raw', async (context) => {
  // CSRF is checked here, before a single byte of the body is consumed.
  const { event, draft } = await managerDraft(context, true);
  const expectedRevision = requireIfMatchRevision(context);
  if (expectedRevision !== draft.draft_revision) {
    throw new ApiError(
      'COVER_DRAFT_STATE_CONFLICT',
      'That cover upload has moved on since this page loaded. Reload and try again.',
      409,
    );
  }

  const declaredLength = context.req.header('content-length');
  if (!declaredLength) {
    throw new ApiError(
      'VALIDATION_FAILED',
      'This upload needs to say how large the photo is.',
      411,
    );
  }
  const contentLength = Number(declaredLength);
  if (!Number.isInteger(contentLength) || contentLength <= 0) {
    throw new ApiError('VALIDATION_FAILED', 'That upload could not be read. Try again.', 422);
  }
  const body = context.req.raw.body;
  if (!body) {
    throw new ApiError('VALIDATION_FAILED', 'That upload could not be read. Try again.', 422);
  }

  const transferred = await receiveCoverRaw(context.env, {
    event,
    draft,
    body,
    contentType: context.req.header('content-type') ?? '',
    contentLength,
    now: new Date(),
  });
  return draftResponse(context, transferred);
});

eventCoverRoutes.delete('/manage/events/:eventId/cover/drafts/:draftId', async (context) => {
  const { event, draft } = await managerDraft(context, true);
  const expectedRevision = requireIfMatchRevision(context);
  const discarded = await discardCoverDraft(context.env.DB, {
    draftId: draft.id,
    eventId: event.id,
    expectedDraftRevision: expectedRevision,
    now: new Date(),
  });
  return draftResponse(context, discarded);
});

eventCoverRoutes.post('/manage/events/:eventId/cover/drafts/:draftId/inspect', async (context) => {
  const { event, draft } = await managerDraft(context, true);
  const inspected = await inspectCoverDraft(context.env, { event, draft, now: new Date() });
  return draftResponse(context, inspected);
});

eventCoverRoutes.patch(
  '/manage/events/:eventId/cover/drafts/:draftId/composition',
  async (context) => {
    const { event, draft } = await managerDraft(context, true);
    const parsed = eventCoverCompositionSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      // The pinned `modelVersion` literal lands here too: a client running an
      // older composition worker is refused rather than having its coordinates
      // silently reinterpreted by a newer model's geometry.
      throw new ApiError(
        'VALIDATION_FAILED',
        'That cover position could not be saved. Reload and try again.',
        422,
        fieldErrors(parsed.error),
      );
    }

    const ready = await writeCoverComposition(context.env.DB, {
      draftId: draft.id,
      eventId: event.id,
      expectedDraftRevision: parsed.data.expectedDraftRevision,
      modelVersion: parsed.data.modelVersion,
      x: parsed.data.x,
      y: parsed.data.y,
      now: new Date(),
    });
    return draftResponse(context, ready);
  },
);

eventCoverRoutes.post(
  '/manage/events/:eventId/cover/drafts/:draftId/previews/:effect',
  async (context) => {
    const { event, draft } = await managerDraft(context, true);
    const preview = await readCoverDraftPreview(context.env, {
      event,
      draft,
      effect: context.req.param('effect'),
      now: new Date(),
    });
    // Bytes, not a URL: the composition worker decodes this response directly,
    // and no cover derivative is ever addressable without authorization.
    return new Response(preview.body, {
      headers: {
        'content-type': preview.contentType,
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  },
);

/* ------------------------------------------------------------------ *
 * Publications
 * ------------------------------------------------------------------ */

eventCoverRoutes.post('/manage/events/:eventId/cover/publications', async (context) => {
  const auth = await requireManager(context, { write: true });
  const parsed = eventCoverPublishSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError(
      'VALIDATION_FAILED',
      'That cover choice could not be saved. Reload and try again.',
      422,
      fieldErrors(parsed.error),
    );
  }
  const request = parsed.data;
  // Parsed and validated, but not publishable in this release: there is no
  // preset applier yet, and accepting one would durably record a receipt no
  // pipeline can ever apply. The six designs arrive with Cover Studio.
  if (request.source.kind === 'preset') {
    throw new ApiError(
      'COVER_SOURCE_UNSUPPORTED',
      'Built-in cover designs are not available yet. Upload a photo instead.',
      422,
    );
  }

  const now = new Date();
  const requestDigest = await coverRequestDigest(canonicalCoverRequest(request));
  const acceptance = await acceptCoverPublication(context.env, {
    event: auth.event,
    request,
    requestDigest,
    now,
  });

  if (acceptance.receipt.status === 'conflict') {
    return context.json({
      data: {
        applied: false,
        operation: acceptance.view,
        event: await currentEventView(context, auth.event.id, now),
      },
      requestId: context.get('requestId'),
    }, 409);
  }

  if (request.source.kind === 'none') {
    const outcome = await applyRemovalPublication(context.env, {
      event: auth.event,
      operationId: request.operationId,
      requestDigest,
      expectedRevision: request.expectedRevision,
      now,
    });
    return context.json({
      data: {
        applied: outcome.applied,
        appliedRevision: outcome.appliedRevision,
        operation: outcome.view,
        event: await currentEventView(context, auth.event.id, now),
      },
      requestId: context.get('requestId'),
    });
  }

  if (acceptance.receipt.status === 'applied') {
    return context.json({
      data: {
        applied: true,
        appliedRevision: acceptance.receipt.applied_revision,
        operation: acceptance.view,
        event: await currentEventView(context, auth.event.id, now),
      },
      requestId: context.get('requestId'),
    });
  }

  const dispatched = await dispatchCoverRender(context, auth.event.id, request.operationId, now);
  if (!dispatched) {
    context.header('Retry-After', '2');
    return context.json({
      data: {
        applied: false,
        operation: await readCoverPublication(context.env, {
          eventId: auth.event.id,
          operationId: request.operationId,
          now,
        }),
      },
      requestId: context.get('requestId'),
    }, 503);
  }

  context.header('Location', `${coverBase(auth.event.id)}/publications/${request.operationId}`);
  context.header('Retry-After', '2');
  return context.json({
    data: { applied: false, operation: acceptance.view },
    requestId: context.get('requestId'),
  }, 202);
});

eventCoverRoutes.get(
  '/manage/events/:eventId/cover/publications/:operationId',
  async (context) => {
    const auth = await requireManager(context);
    // Side-effect-free: the platform map is applied in memory for the product
    // view. The Workflow handler, the restart POST, and bounded cleanup are the
    // only writers.
    const operation = await readCoverPublication(context.env, {
      eventId: auth.event.id,
      operationId: context.req.param('operationId'),
      now: new Date(),
    });
    if (!operation) {
      throw new ApiError('EVENT_NOT_FOUND', 'That cover change could not be found.', 404);
    }
    return context.json({ data: { operation }, requestId: context.get('requestId') });
  },
);

eventCoverRoutes.post(
  '/manage/events/:eventId/cover/publications/:operationId/restart',
  async (context) => {
    const auth = await requireManager(context, { write: true });
    // Strictly empty: the client never reconstructs or resubmits the recipe.
    // Everything the restart needs is pinned on the receipt, which is what lets
    // `Try again` survive a reload with every scrap of local state cleared.
    const raw = await context.req.json().catch(() => ({}));
    if (!emptyBodySchema.safeParse(raw ?? {}).success) {
      throw new ApiError('VALIDATION_FAILED', 'That retry could not be read. Reload and try again.', 422);
    }

    const operationId = context.req.param('operationId');
    const result = await restartCoverPublication(context.env, {
      eventId: auth.event.id,
      operationId,
      now: new Date(),
    });

    if (result.status === 'ineligible') {
      throw new ApiError(
        'COVER_PUBLICATION_CONFLICT',
        'That cover change cannot be retried. Choose the photo again.',
        409,
      );
    }
    if (result.status === 'unavailable') {
      context.header('Retry-After', String(result.retryAfterSeconds ?? 2));
      return context.json({
        data: { operation: result.view },
        requestId: context.get('requestId'),
      }, 503);
    }
    if (result.status === 'terminal') {
      return context.json({
        data: { operation: result.view },
        requestId: context.get('requestId'),
      });
    }

    context.header('Location', `${coverBase(auth.event.id)}/publications/${operationId}`);
    context.header('Retry-After', '2');
    return context.json({
      data: { operation: result.view },
      requestId: context.get('requestId'),
    }, 202);
  },
);

/**
 * Creates the recorded instance, then rechecks the deletion fence.
 *
 * A `create()` that refuses a retained ID is the same fenced operation, not a
 * failure — so an error is only fatal once a fresh status read cannot confirm
 * the instance exists.
 */
async function dispatchCoverRender(
  context: Context<AppBindings>,
  eventId: string,
  operationId: string,
  now: Date,
): Promise<boolean> {
  const accessor = defaultCoverWorkflowAccessor(context.env);
  const workflowInstanceId = await coverWorkflowInstanceId(eventId, operationId);

  try {
    await accessor.create(workflowInstanceId, { eventId, operationId });
  } catch {
    const platform = await accessor.status(workflowInstanceId).catch(() => 'unknown');
    if (platform === 'unknown') {
      await markDispatchFailed(context.env, eventId, operationId, now);
      return false;
    }
  }

  return confirmCoverDispatch(context.env, {
    eventId,
    operationId,
    workflowInstanceId,
    now,
    workflow: accessor,
  });
}

/** The Manager event view, read fresh, with its one safe preparation summary. */
async function currentEventView(
  context: Context<AppBindings>,
  eventId: string,
  now: Date,
) {
  const event = await new EventsRepository(context.env.DB).getById(eventId);
  if (!event) throw new ApiError('EVENT_NOT_FOUND', 'This event could not be found.', 404);
  return eventView(event, now, await selectEventCoverPreparation(context.env, eventId, now));
}

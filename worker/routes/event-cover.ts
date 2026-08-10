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
import {
  coverRateRetryAfterSeconds,
  discardCoverDraft,
  loadCoverDraft,
  writeCoverComposition,
} from '../db/event-covers';
import { EventsRepository } from '../db/events';
import type { CoverDraftRow, EventRecord } from '../db/types';
import type { AppBindings } from '../env';
import { selectManagerEventView } from '../http/event-view';
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
  applySemanticCoverPublication,
  claimInitialCoverDispatch,
  confirmCoverDispatch,
  coverRequestDigest,
  coverWorkflowInstanceId,
  markDispatchFailed,
  guardCoverDispatchAfterPlatformCall,
  readCoverPublication,
  readCoverPublicationTerminalResult,
  restartCoverPublication,
  selectEventCoverPreparation,
  type CoverPublicationRestartResult,
} from '../services/event-cover-publication';
import {
  defaultCoverWorkflowAccessor,
  dispositionForLookup,
  emitCoverPlatformTelemetry,
} from '../workflows/cover-platform';

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

/**
 * Attaches `Retry-After` to a cover rate rejection.
 *
 * §9.4 requires it and §14 restates it. The precedent is `routes/rsvp.ts`,
 * which sets the header immediately before its throw; this wraps the call
 * instead, because only the service knows whether a window was actually
 * charged or the request replayed into an existing row.
 */
async function withRateRetryAfter<T>(
  context: Context<AppBindings>,
  now: Date,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApiError && error.code === 'RATE_LIMITED') {
      context.header('Retry-After', String(coverRateRetryAfterSeconds(now)));
    }
    throw error;
  }
}

function coverBase(eventId: string): string {
  return `/api/manage/events/${eventId}/cover`;
}

async function coverPublicationTerminalResponse(
  context: Context<AppBindings>,
  eventId: string,
  operationId: string,
  now: Date,
): Promise<Response | null> {
  const terminal = await readCoverPublicationTerminalResult(context.env, eventId, operationId);
  if (!terminal) return null;
  if (terminal.status === 'applied') {
    return context.json({
      data: {
        applied: true,
        appliedRevision: terminal.appliedRevision,
        operation: terminal.view,
        event: await currentEventView(context, eventId, now),
      },
      requestId: context.get('requestId'),
    });
  }
  if (terminal.status === 'conflict') {
    return context.json({
      data: {
        applied: false,
        operation: terminal.view,
        event: await currentEventView(context, eventId, now),
      },
      requestId: context.get('requestId'),
    }, 409);
  }
  return context.json({
    data: { applied: false, operation: terminal.view },
    requestId: context.get('requestId'),
  });
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

  const now = new Date();
  const requestDigest = await coverRequestDigest(canonicalCoverDraftCreate(parsed.data));
  const reservation = await withRateRetryAfter(context, now, () => reserveCoverDraft(context.env, {
    event: auth.event,
    request: parsed.data,
    requestDigest,
    now,
  }));

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
  const now = new Date();
  const inspected = await withRateRetryAfter(
    context,
    now,
    () => inspectCoverDraft(context.env, { event, draft, now }),
  );
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
    const now = new Date();
    const preview = await withRateRetryAfter(context, now, () => readCoverDraftPreview(context.env, {
      event,
      draft,
      effect: context.req.param('effect'),
      now,
    }));
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
  const now = new Date();
  const requestDigest = await coverRequestDigest(canonicalCoverRequest(request));
  if (request.source.kind !== 'upload') {
    try {
      const outcome = await withRateRetryAfter(context, now, () => (
        applySemanticCoverPublication(context.env, {
          event: auth.event,
          request,
          requestDigest,
          now,
        })
      ));
      if (outcome.receipt.status === 'conflict') {
        return context.json({
          data: {
            applied: false,
            operation: outcome.view,
            event: await currentEventView(context, auth.event.id, now),
          },
          requestId: context.get('requestId'),
        }, 409);
      }
      return context.json({
        data: {
          applied: outcome.applied,
          appliedRevision: outcome.appliedRevision,
          operation: outcome.view,
          event: await currentEventView(context, auth.event.id, now),
        },
        requestId: context.get('requestId'),
      });
    } catch (error) {
      if (error instanceof ApiError
        && error.code === 'COVER_PUBLICATION_CONFLICT'
        && error.status === 409) {
        return context.json({
          code: error.code,
          message: error.message,
          data: {
            operation: await selectEventCoverPreparation(context.env, auth.event.id, now),
            event: await currentEventView(context, auth.event.id, now),
          },
          requestId: context.get('requestId'),
        }, 409);
      }
      throw error;
    }
  }

  let acceptance: Awaited<ReturnType<typeof acceptCoverPublication>>;
  try {
    acceptance = await withRateRetryAfter(context, now, () => acceptCoverPublication(context.env, {
      event: auth.event,
      request,
      requestDigest,
      now,
    }));
  } catch (error) {
    if (error instanceof ApiError
      && error.code === 'COVER_PUBLICATION_CONFLICT'
      && error.status === 409) {
      return context.json({
        code: error.code,
        message: error.message,
        data: {
          operation: await selectEventCoverPreparation(context.env, auth.event.id, now),
          event: await currentEventView(context, auth.event.id, now),
        },
        requestId: context.get('requestId'),
      }, 409);
    }
    throw error;
  }

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

  // A same-digest replay of a retryable failure is an authorized recovery
  // request under §9.4. It must use the retained instance/generation guards,
  // never fall back to the initial raw `create()` edge.
  let recovery = acceptance.receipt.status === 'failed' && acceptance.receipt.retryable === 1
    ? await restartCoverPublication(context.env, {
      eventId: auth.event.id,
      operationId: request.operationId,
      now,
    })
    : null;
  let dispatched: boolean;
  if (recovery) {
    dispatched = recovery.status === 'restarted' || recovery.status === 'active';
  } else {
    const dispatch = await dispatchCoverRender(context, auth.event.id, request.operationId, now);
    recovery = dispatch.recovery;
    dispatched = dispatch.dispatched;
  }
  const terminalResponse = await coverPublicationTerminalResponse(
    context, auth.event.id, request.operationId, now,
  );
  if (terminalResponse) return terminalResponse;
  // `complete + failed` deliberately returns the retained failed D1 result:
  // platform completion is not permission to reopen a recorded failure. A
  // retryable failure is not part of the ordinary terminal-read set, so honor
  // the recovery service's explicit terminal result here as the restart route
  // does instead of misreporting it as a transient dispatch outage.
  if (recovery?.status === 'terminal') {
    return context.json({
      data: { applied: false, operation: recovery.view },
      requestId: context.get('requestId'),
    });
  }
  if (recovery?.status === 'ineligible') {
    throw new ApiError(
      'COVER_PUBLICATION_CONFLICT',
      'That cover change cannot be retried. Choose the photo again.',
      409,
    );
  }
  if (!dispatched) {
    const operation = await readCoverPublication(context.env, {
      eventId: auth.event.id,
      operationId: request.operationId,
      now,
    });
    const lateTerminalResponse = await coverPublicationTerminalResponse(
      context, auth.event.id, request.operationId, now,
    );
    if (lateTerminalResponse) return lateTerminalResponse;
    context.header('Retry-After', String(recovery?.retryAfterSeconds ?? 2));
    return context.json({
      data: {
        applied: false,
        operation,
      },
      requestId: context.get('requestId'),
    }, 503);
  }

  const operation = recovery?.view ?? await readCoverPublication(context.env, {
    eventId: auth.event.id,
    operationId: request.operationId,
    now,
  }) ?? acceptance.view;
  const lateTerminalResponse = await coverPublicationTerminalResponse(
    context, auth.event.id, request.operationId, now,
  );
  if (lateTerminalResponse) return lateTerminalResponse;
  context.header('Location', `${coverBase(auth.event.id)}/publications/${request.operationId}`);
  context.header('Retry-After', '2');
  return context.json({
    data: {
      applied: false,
      operation,
    },
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
    const now = new Date();
    const operationId = context.req.param('operationId');
    let terminal = await readCoverPublicationTerminalResult(
      context.env,
      auth.event.id,
      operationId,
    );
    let operation = terminal?.view ?? await readCoverPublication(context.env, {
      eventId: auth.event.id,
      operationId,
      now,
    });
    if (!terminal) {
      terminal = await readCoverPublicationTerminalResult(
        context.env,
        auth.event.id,
        operationId,
      );
      if (terminal) operation = terminal.view;
    }
    if (!operation) {
      throw new ApiError('EVENT_NOT_FOUND', 'That cover change could not be found.', 404);
    }
    return context.json({
      data: {
        operation,
        ...(terminal?.status === 'applied'
          ? {
              appliedRevision: terminal.appliedRevision,
              event: await currentEventView(context, auth.event.id, now),
            }
          : {}),
      },
      requestId: context.get('requestId'),
    });
  },
);

eventCoverRoutes.post(
  '/manage/events/:eventId/cover/publications/:operationId/restart',
  async (context) => {
    const auth = await requireManager(context, { write: true });
    // Strictly empty: the client never reconstructs or resubmits the recipe.
    // Everything the restart needs is pinned on the receipt, which is what lets
    // `Try again` survive a reload with every scrap of local state cleared.
    let raw: unknown;
    try {
      raw = await context.req.json();
    } catch {
      throw new ApiError(
        'VALIDATION_FAILED', 'That retry could not be read. Reload and try again.', 422,
      );
    }
    if (!emptyBodySchema.safeParse(raw).success) {
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
      }, result.view?.status === 'conflict' ? 409 : 200);
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
interface CoverRenderDispatchResult {
  dispatched: boolean;
  recovery: CoverPublicationRestartResult | null;
}

async function dispatchCoverRender(
  context: Context<AppBindings>,
  eventId: string,
  operationId: string,
  now: Date,
): Promise<CoverRenderDispatchResult> {
  const accessor = defaultCoverWorkflowAccessor(context.env);
  const workflowInstanceId = await coverWorkflowInstanceId(eventId, operationId);
  const claim = await claimInitialCoverDispatch(context.env, {
    eventId,
    operationId,
    workflowInstanceId,
  });
  if (claim.kind === 'confirmed') return { dispatched: true, recovery: null };
  if (claim.kind === 'in-flight') {
    const lookup = await accessor.lookup(workflowInstanceId)
      .catch(() => ({ kind: 'unknown' as const, telemetry: 'cover_platform_lookup_failed' }));
    const disposition = dispositionForLookup(lookup);
    emitCoverPlatformTelemetry('publication', disposition.telemetry);
    // The exact open-fence claim belongs to another caller. Any recognized
    // platform state is durable progress and returns 202/polling; only unknown
    // or unmapped evidence is transiently unavailable. This caller never
    // repeats create/resume/restart for the retained ID.
    return {
      dispatched: disposition.kind !== 'unknown'
        && disposition.telemetry !== 'cover_platform_unmapped',
      recovery: null,
    };
  }
  if (claim.kind === 'stale') {
    const recovery = await restartCoverPublication(context.env, {
      eventId,
      operationId,
      now,
      workflow: accessor,
    });
    return {
      dispatched: recovery.status === 'restarted' || recovery.status === 'active',
      recovery,
    };
  }
  if (claim.kind !== 'claimed') return { dispatched: false, recovery: null };

  try {
    await accessor.create(workflowInstanceId, { eventId, operationId });
  } catch {
    // `create()` refuses an ID a live instance already holds, which is the same
    // fenced operation rather than a failure. A follow-up lookup must prove
    // that active instance before confirmation. An unknown lookup preserves the
    // durable claim for reconciliation; a known non-active result may fail only
    // the exact claim generation this request owns.
    const lookup = await accessor.lookup(workflowInstanceId)
      .catch(() => ({ kind: 'unknown' as const, telemetry: 'cover_platform_lookup_failed' }));
    const disposition = dispositionForLookup(lookup);
    emitCoverPlatformTelemetry('publication', disposition.telemetry);
    if (disposition.kind === 'unknown' || disposition.telemetry === 'cover_platform_unmapped') {
      await guardCoverDispatchAfterPlatformCall(context.env, {
        eventId,
        operationId,
        workflowInstanceId,
        dispatchGeneration: claim.dispatchGeneration,
        workflow: accessor,
      });
      return { dispatched: false, recovery: null };
    }
    if (disposition.kind !== 'active') {
      const failed = await markDispatchFailed(context.env, eventId, operationId, now, {
        workflowInstanceId,
        dispatchState: 'creating',
        dispatchGeneration: claim.dispatchGeneration,
      });
      if (!failed) {
        await confirmCoverDispatch(context.env, {
          eventId,
          operationId,
          workflowInstanceId,
          dispatchGeneration: claim.dispatchGeneration,
          now,
          workflow: accessor,
        });
      }
      return { dispatched: false, recovery: null };
    }
  }

  return {
    dispatched: await confirmCoverDispatch(context.env, {
      eventId,
      operationId,
      workflowInstanceId,
      dispatchGeneration: claim.dispatchGeneration,
      now,
      workflow: accessor,
    }),
    recovery: null,
  };
}

/** The Manager event view, read fresh, with its one safe preparation summary. */
async function currentEventView(
  context: Context<AppBindings>,
  eventId: string,
  now: Date,
) {
  const event = await new EventsRepository(context.env.DB).getById(eventId);
  if (!event) throw new ApiError('EVENT_NOT_FOUND', 'This event could not be found.', 404);
  return selectManagerEventView(context.env, event, now);
}

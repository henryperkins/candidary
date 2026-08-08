import type { AppEnv } from '../env';
import type { CoverBackfillPayload } from './cover-backfill';

/**
 * The one Worker-side authority on what a Cloudflare Workflows lookup means.
 *
 * Publication, backfill, and the purge coordinator all read instance state, and
 * all three must answer the same question the same way: is this instance
 * running, is it recoverable, is it genuinely gone, or do we simply not know?
 * Getting that last distinction wrong in either direction is expensive —
 * treating "we don't know" as "gone" recreates work that is still running, and
 * treating "gone" as "unknown" strands a job forever — so the classification
 * lives here once rather than three times.
 *
 * Worker-only. Nothing here may be imported by a client module: a raw platform
 * status name is operations telemetry, never a response body.
 */

/* ------------------------------------------------------------------ *
 * Status vocabulary
 * ------------------------------------------------------------------ */

/**
 * The total documented binding status union.
 *
 * Deliberately has no absence member. `InstanceStatus.status` can never say an
 * instance is missing — absence surfaces only as a thrown `get()`, which is a
 * different signal handled by `classifyWorkflowLookupError`.
 *
 * @see https://developers.cloudflare.com/workflows/build/workers-api/
 */
export const COVER_PLATFORM_STATUSES = [
  'queued',
  'running',
  'paused',
  'errored',
  'terminated',
  'complete',
  'waiting',
  'waitingForPause',
  'unknown',
] as const;

export type CoverPlatformStatus = (typeof COVER_PLATFORM_STATUSES)[number];

export type CoverPlatformRecovery = 'none' | 'resume' | 'restart' | 'create';

export interface CoverPlatformDisposition {
  /** What the platform says, reduced to the five things Candidary does about it. */
  kind: 'active' | 'recoverable' | 'complete' | 'unknown' | 'missing';
  recovery: CoverPlatformRecovery;
  /** What a manager should be told while D1 is still nonterminal. */
  productStatus: 'preparing' | 'retryable-failed';
  /** Whether any mutation predicate may be satisfied on this reading. */
  mutates: boolean;
  retryable: boolean;
  /** Sanitized operations telemetry; never a raw platform status in a response. */
  telemetry: string | null;
}

/**
 * The total map from §9.4, and deliberately total.
 *
 * Its `default` preserves product state and emits telemetry rather than
 * guessing: an unrecognized status is the one case where treating the instance
 * as gone could destroy work that is actually running. No value other than the
 * ones named below is ever treated as non-running, and **no** string value
 * reaches `missing` — absence is not something a status can assert.
 */
export function mapPlatformStatus(status: string): CoverPlatformDisposition {
  switch (status) {
    case 'queued':
    case 'running':
    case 'waiting':
    case 'waitingForPause':
      return {
        kind: 'active', recovery: 'none', productStatus: 'preparing',
        mutates: false, retryable: true, telemetry: null,
      };
    // A paused instance is resumed on the same ID. Restarting it would discard
    // completed steps that are still valid.
    case 'paused':
      return {
        kind: 'recoverable', recovery: 'resume', productStatus: 'retryable-failed',
        mutates: true, retryable: true, telemetry: null,
      };
    case 'errored':
    case 'terminated':
      return {
        kind: 'recoverable', recovery: 'restart', productStatus: 'retryable-failed',
        mutates: true, retryable: true, telemetry: null,
      };
    // Reconcile D1 first: an existing applied, conflict, or failed result wins.
    // Only an unexpectedly nonterminal D1 becomes a retryable divergence.
    case 'complete':
      return {
        kind: 'complete', recovery: 'restart', productStatus: 'retryable-failed',
        mutates: true, retryable: true, telemetry: 'cover_platform_complete',
      };
    // Never satisfies a mutation predicate. Absence of information is not
    // evidence of absence of work.
    case 'unknown':
      return {
        kind: 'unknown', recovery: 'none', productStatus: 'preparing',
        mutates: false, retryable: true, telemetry: 'cover_platform_unknown',
      };
    default:
      return {
        kind: 'active', recovery: 'none', productStatus: 'preparing',
        mutates: false, retryable: true, telemetry: `cover_platform_unmapped:${status.slice(0, 32)}`,
      };
  }
}

/** The disposition a *certified* absence earns. Unreachable from any status string. */
const MISSING_DISPOSITION: CoverPlatformDisposition = {
  kind: 'missing', recovery: 'create', productStatus: 'retryable-failed',
  mutates: true, retryable: true, telemetry: 'cover_platform_missing',
};

/** The disposition an unclassifiable lookup earns: report, change nothing. */
const UNKNOWN_LOOKUP_DISPOSITION: CoverPlatformDisposition = {
  kind: 'unknown', recovery: 'none', productStatus: 'preparing',
  mutates: false, retryable: true, telemetry: 'cover_platform_unknown',
};

/* ------------------------------------------------------------------ *
 * Lookup classification
 * ------------------------------------------------------------------ */

/**
 * The three things a lookup can establish, and no fourth.
 *
 * `status` carries the raw platform string rather than the narrowed union: a
 * value outside `COVER_PLATFORM_STATUSES` is still a genuine reading from a
 * live instance that answered, so it must reach `mapPlatformStatus`'s
 * preserving default instead of being flattened into `unknown`.
 */
export type CoverWorkflowLookup =
  | { kind: 'status'; status: string }
  | { kind: 'missing' }
  | { kind: 'unknown'; telemetry: string };

/**
 * Matchers that certify a thrown error as a genuine absent instance.
 *
 * **Empty, and correctly so.** Cloudflare documents that `get()` "will throw an
 * exception if the ID doesn't exist *or is invalid*" and shows callers only
 * `e.message` — there is no documented code, name, or type separating the two.
 * Those two conditions must not classify alike: an absent instance may be
 * recreated under its fenced ID, while an invalid ID is a defect that
 * recreating would paper over.
 *
 * So this candidate certifies nothing, every lookup failure is `unknown`, and
 * confirmed-missing recreation is disabled by construction. Task 11 exercises
 * the deployed adapter against a deliberately absent valid ID and, only if it
 * finds a stable discriminator, appends exactly one matcher here. If it finds
 * none, recreation stays disabled and Task 11 cannot pass — which is the
 * intended outcome, not a gap to route around.
 *
 * Never match on `error.message`: the documented failure text embeds the
 * instance ID verbatim, so matching it would both be brittle and pull an
 * identifier into a comparison.
 */
const CERTIFIED_NOT_FOUND_MATCHERS: ReadonlyArray<(error: unknown) => boolean> = [];

export function isCertifiedWorkflowNotFound(error: unknown): boolean {
  return CERTIFIED_NOT_FOUND_MATCHERS.some((matches) => matches(error));
}

/** Bounded, low-cardinality, and never derived from an error message. */
function errorLabel(error: unknown): string {
  if (error instanceof Error && error.name) {
    return error.name.replace(/[^A-Za-z0-9_]/gu, '').slice(0, 32) || 'Error';
  }
  return typeof error;
}

/**
 * Classify a thrown lookup.
 *
 * Everything that is not certified absent is `unknown`: it emits telemetry,
 * satisfies no mutation predicate, and causes no D1 or platform write.
 */
export function classifyWorkflowLookupError(error: unknown): CoverWorkflowLookup {
  if (isCertifiedWorkflowNotFound(error)) return { kind: 'missing' };
  return { kind: 'unknown', telemetry: `cover_platform_lookup_failed:${errorLabel(error)}` };
}

/**
 * Classify a successful `instance.status()` payload.
 *
 * A shapeless or absent payload is the platform's own `unknown` status, not an
 * unknown *lookup*: the instance was found and answered, so the fact that it
 * exists is established even when its state is not.
 */
export function classifyInstanceStatus(raw: unknown): CoverWorkflowLookup {
  const status = typeof raw === 'object' && raw !== null
    ? (raw as { status?: unknown }).status
    : undefined;
  return {
    kind: 'status',
    status: typeof status === 'string' && status.length > 0 ? status : 'unknown',
  };
}

/** The single place a lookup becomes a disposition. */
export function dispositionForLookup(lookup: CoverWorkflowLookup): CoverPlatformDisposition {
  switch (lookup.kind) {
    case 'status':
      return mapPlatformStatus(lookup.status);
    case 'missing':
      return MISSING_DISPOSITION;
    case 'unknown':
      return { ...UNKNOWN_LOOKUP_DISPOSITION, telemetry: lookup.telemetry };
  }
}

/* ------------------------------------------------------------------ *
 * Accessors
 * ------------------------------------------------------------------ */

/** The publication Workflow's payload. Distinct from the backfill payload. */
export interface CoverRenderDispatchPayload {
  eventId: string;
  operationId: string;
}

export interface CoverWorkflowAccessor {
  create(id: string, payload: CoverRenderDispatchPayload): Promise<void>;
  lookup(id: string): Promise<CoverWorkflowLookup>;
  resume(id: string): Promise<void>;
  restart(id: string): Promise<void>;
  terminate(id: string): Promise<void>;
}

/**
 * The backfill accessor.
 *
 * Has `createBatch` rather than `create` because backfill's one recovery edge
 * depends on its documented idempotency: an ID still inside its retention limit
 * is skipped rather than colliding, so replaying a stale `creating` claim with
 * its already-recorded ID is safe whether or not the instance exists.
 */
export interface CoverBackfillWorkflowAccessor {
  lookup(id: string): Promise<CoverWorkflowLookup>;
  createBatch(input: Array<{ id: string; params: CoverBackfillPayload }>): Promise<void>;
  resume(id: string): Promise<void>;
  restart(id: string): Promise<void>;
  terminate(id: string): Promise<void>;
}

/** Structural, so both bindings satisfy it without naming a generated type. */
interface WorkflowLookupSource {
  get(id: string): Promise<{ status(): Promise<unknown> }>;
}

/**
 * The only place `get()` is called, and the only place its throw is interpreted.
 *
 * Two separate try blocks because the two failures mean different things: a
 * throwing `get()` is a lookup that established nothing, while a throwing
 * `status()` came from an instance that was already found. Both are `unknown`
 * today, but conflating them would hide that distinction from Task 11.
 */
async function lookupInstance(
  workflow: WorkflowLookupSource,
  id: string,
): Promise<CoverWorkflowLookup> {
  let instance: { status(): Promise<unknown> };
  try {
    instance = await workflow.get(id);
  } catch (error) {
    return classifyWorkflowLookupError(error);
  }
  try {
    return classifyInstanceStatus(await instance.status());
  } catch (error) {
    return classifyWorkflowLookupError(error);
  }
}

export function defaultCoverWorkflowAccessor(env: AppEnv): CoverWorkflowAccessor {
  const workflow = env.COVER_RENDER_WORKFLOW;
  return {
    async create(id, payload) { await workflow.create({ id, params: payload }); },
    async lookup(id) { return lookupInstance(workflow, id); },
    async resume(id) { await (await workflow.get(id)).resume(); },
    async restart(id) { await (await workflow.get(id)).restart(); },
    async terminate(id) { await (await workflow.get(id)).terminate(); },
  };
}

export function defaultCoverBackfillWorkflowAccessor(env: AppEnv): CoverBackfillWorkflowAccessor {
  const workflow = env.COVER_BACKFILL_WORKFLOW;
  return {
    async lookup(id) { return lookupInstance(workflow, id); },
    async createBatch(input) { await workflow.createBatch(input); },
    async resume(id) { await (await workflow.get(id)).resume(); },
    async restart(id) { await (await workflow.get(id)).restart(); },
    async terminate(id) { await (await workflow.get(id)).terminate(); },
  };
}

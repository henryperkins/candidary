import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';

import { createApp } from './app';
import type { AppEnv } from './env';
import { NotificationService } from './services/notifications';
import { processExport } from './workflows/export';
import { scheduledCleanup } from './workflows/cleanup';
import { EVENT_COVER_PROFILES } from '../shared/event-cover';
import {
  coverBackfillConfirmStep,
  coverBackfillFinalize,
  coverBackfillNormalize,
  coverBackfillPreflight,
  coverBackfillProfileStep,
  type CoverBackfillPayload,
} from './workflows/cover-backfill';
import {
  coverRenderFinalize,
  coverRenderPreflight,
  coverRenderProfileStep,
  type CoverRenderPayload,
} from './workflows/cover-render';

const app = createApp();

export class ExportWorkflow extends WorkflowEntrypoint<AppEnv, { jobId: string }> {
  async run(event: WorkflowEvent<{ jobId: string }>, step: WorkflowStep) {
    return step.do('prepare private event export', async () => processExport(this.env, event.payload.jobId));
  }
}

/**
 * Materializes one uploaded cover's bounded render set.
 *
 * Deliberately not `ExportWorkflow`'s single-giant-step shape: this runs a
 * preflight, one deterministically named step per layout profile, and a
 * finalize, so a retry resumes at the profile that failed rather than
 * re-transforming every image. The bodies land with the driver they call.
 */
export class CoverRenderWorkflow extends WorkflowEntrypoint<AppEnv, CoverRenderPayload> {
  async run(event: WorkflowEvent<CoverRenderPayload>, step: WorkflowStep) {
    const preflight = await step.do(
      'preflight cover publication',
      async () => coverRenderPreflight(this.env, event.payload),
    );
    if (!preflight.shouldRender) return preflight.outcome;
    // Eight deterministically named steps, so a retry resumes at the profile
    // that failed rather than re-transforming every image. Each step records
    // only a small inventory summary; image bytes stay in R2, and no cross-step
    // state comes from mutable top-level memory.
    for (const profile of EVENT_COVER_PROFILES) {
      await step.do(
        `render cover profile ${profile.id}`,
        async () => coverRenderProfileStep(this.env, event.payload, profile.id),
      );
    }
    return step.do(
      'finalize cover publication',
      async () => coverRenderFinalize(this.env, event.payload),
    );
  }
}

/**
 * Release-only. Converts one pre-0012 legacy original onto the new pipeline.
 *
 * Nine deterministically named steps rather than the render Workflow's eight:
 * normalization is its own step because, unlike a publication, a backfill job
 * arrives with no master and its manifest cannot be derived until the ladder
 * has chosen a rung. Every exit before `finalize` leaves the legacy original in
 * place and the event on the compatibility reader.
 */
export class CoverBackfillWorkflow extends WorkflowEntrypoint<AppEnv, CoverBackfillPayload> {
  async run(event: WorkflowEvent<CoverBackfillPayload>, step: WorkflowStep) {
    // Before anything else, and its own step so a crash between the operator's
    // trigger and their confirm command heals here rather than leaving the
    // ledger claiming a dispatch nobody ever observed landing. A `blocked`
    // answer means a purge already owns this instance and the job has been
    // settled, so there is nothing left to preflight. A `stale` one falls
    // through: the preflight's own fence check is the barrier, and it fails
    // closed on exactly the cases that make a confirmation stale.
    const dispatch = await step.do(
      'confirm cover backfill dispatch',
      async () => coverBackfillConfirmStep(this.env, event.payload),
    );
    if (dispatch === 'blocked') {
      return {
        status: 'failed' as const, appliedRevision: null,
        failureCode: 'EVENT_DELETED', retryable: false,
      };
    }

    const preflight = await step.do(
      'preflight cover backfill job',
      async () => coverBackfillPreflight(this.env, event.payload),
    );
    if (!preflight.shouldContinue) return preflight.outcome;

    const normalized = await step.do(
      'normalize legacy cover master',
      async () => coverBackfillNormalize(this.env, event.payload),
    );
    if (!normalized.shouldContinue) return normalized.outcome;

    for (const profile of EVENT_COVER_PROFILES) {
      await step.do(
        `render backfill profile ${profile.id}`,
        async () => coverBackfillProfileStep(this.env, event.payload, profile.id),
      );
    }
    return step.do(
      'finalize cover backfill job',
      async () => coverBackfillFinalize(this.env, event.payload),
    );
  }
}

const NOTIFICATION_CRON = '47 * * * *';

// One scheduled handler, two jobs, chosen by the expression that fired. Work uses
// wall-clock execution time; scheduled time remains telemetry for delayed Crons.
export default {
  fetch: app.fetch,
  scheduled(controller: ScheduledController, env: AppEnv, context: ExecutionContext) {
    const scheduledAt = new Date(controller.scheduledTime);
    const executedAt = new Date();
    if (controller.cron === NOTIFICATION_CRON) {
      // A dispatcher-level failure fails this Cron event and is worth retrying;
      // per-recipient failures never reach here, they stay in the outbox.
      context.waitUntil(new NotificationService(env).dispatchPending(executedAt).then(
        (summary) => {
          console.log(JSON.stringify({
            event: 'notifications_dispatched',
            scheduledAt: scheduledAt.toISOString(),
            executedAt: executedAt.toISOString(),
            ...summary,
          }));
        },
        (error: unknown) => {
          console.error(JSON.stringify({ event: 'notifications_failed', message: String(error) }));
          throw error;
        },
      ));
      return;
    }
    context.waitUntil(scheduledCleanup(env, executedAt));
  },
} satisfies ExportedHandler<AppEnv>;

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';

import { createApp } from './app';
import type { AppEnv } from './env';
import { NotificationService } from './services/notifications';
import { processExport } from './workflows/export';
import { scheduledCleanup } from './workflows/cleanup';
import type { CoverBackfillPayload } from './workflows/cover-backfill';
import type { CoverRenderPayload } from './workflows/cover-render';

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
    return step.do('preflight cover publication', async () => ({
      eventId: event.payload.eventId,
      operationId: event.payload.operationId,
      shouldRender: false,
    }));
  }
}

/** Release-only. Converts one pre-0012 legacy original onto the new pipeline. */
export class CoverBackfillWorkflow extends WorkflowEntrypoint<AppEnv, CoverBackfillPayload> {
  async run(event: WorkflowEvent<CoverBackfillPayload>, step: WorkflowStep) {
    return step.do('preflight cover backfill job', async () => ({
      runId: event.payload.runId,
      jobId: event.payload.jobId,
      eventId: event.payload.eventId,
      shouldRender: false,
    }));
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

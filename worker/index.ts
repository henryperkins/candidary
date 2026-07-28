import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';

import { createApp } from './app';
import type { AppEnv } from './env';
import { NotificationService } from './services/notifications';
import { processExport } from './workflows/export';
import { scheduledCleanup } from './workflows/cleanup';

const app = createApp();

export class ExportWorkflow extends WorkflowEntrypoint<AppEnv, { jobId: string }> {
  async run(event: WorkflowEvent<{ jobId: string }>, step: WorkflowStep) {
    return step.do('prepare private event export', async () => processExport(this.env, event.payload.jobId));
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

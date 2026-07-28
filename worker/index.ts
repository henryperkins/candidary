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

// One scheduled handler, two jobs, chosen by the expression that fired. The
// scheduled time is the operation time so a delayed invocation still reasons about
// the moment it was meant to run.
export default {
  fetch: app.fetch,
  scheduled(controller: ScheduledController, env: AppEnv, context: ExecutionContext) {
    const now = new Date(controller.scheduledTime);
    if (controller.cron === NOTIFICATION_CRON) {
      // A dispatcher-level failure fails this Cron event and is worth retrying;
      // per-recipient failures never reach here, they stay in the outbox.
      context.waitUntil(new NotificationService(env).dispatchPending(now).then(
        (summary) => {
          console.log(JSON.stringify({ event: 'notifications_dispatched', ...summary }));
        },
        (error: unknown) => {
          console.error(JSON.stringify({ event: 'notifications_failed', message: String(error) }));
          throw error;
        },
      ));
      return;
    }
    context.waitUntil(scheduledCleanup(env, now));
  },
} satisfies ExportedHandler<AppEnv>;

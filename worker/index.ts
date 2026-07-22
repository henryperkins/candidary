import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';

import { createApp } from './app';
import type { AppEnv } from './env';
import { processExport } from './workflows/export';
import { scheduledCleanup } from './workflows/cleanup';

const app = createApp();

export class ExportWorkflow extends WorkflowEntrypoint<AppEnv, { jobId: string }> {
  async run(event: WorkflowEvent<{ jobId: string }>, step: WorkflowStep) {
    return step.do('prepare private event export', async () => processExport(this.env, event.payload.jobId));
  }
}

export default {
  fetch: app.fetch,
  scheduled(_controller: ScheduledController, env: AppEnv, context: ExecutionContext) {
    context.waitUntil(scheduledCleanup(env));
  },
} satisfies ExportedHandler<AppEnv>;

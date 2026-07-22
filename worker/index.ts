import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';

import { createApp } from './app';

const app = createApp();

export class ExportWorkflow extends WorkflowEntrypoint<Env, { jobId?: string }> {
  async run(event: WorkflowEvent<{ jobId?: string }>, step: WorkflowStep) {
    return step.do('initialize export', async () => ({
      jobId: event.payload.jobId ?? null,
    }));
  }
}

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;


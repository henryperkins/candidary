import { WorkerEntrypoint } from 'cloudflare:workers';

import { fingerprintWorkflowError, type WorkflowErrorFingerprint } from '../shared/staging-workflow-fingerprint';

interface ProbeEnv {
  readonly COVER_BACKFILL_WORKFLOW: Workflow<unknown>;
}

export type ProbeSampleResult =
  | { readonly outcome: 'found' }
  | { readonly outcome: 'threw'; readonly fingerprint: WorkflowErrorFingerprint };

export class StagingWorkflowProbe extends WorkerEntrypoint<ProbeEnv> {
  async sample(instanceId: string): Promise<ProbeSampleResult> {
    if (typeof instanceId !== 'string' || instanceId.length === 0 || instanceId.length > 128
      || [...instanceId].some((character) => {
        const codePoint = character.codePointAt(0)!;
        return codePoint <= 31 || codePoint === 127;
      })) {
      throw new Error('PROBE_INPUT_INVALID');
    }
    try {
      const instance = await this.env.COVER_BACKFILL_WORKFLOW.get(instanceId);
      await instance.status();
      return { outcome: 'found' };
    } catch (error) {
      return { outcome: 'threw', fingerprint: fingerprintWorkflowError(error) };
    }
  }
}

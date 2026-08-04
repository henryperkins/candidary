/**
 * The payload one legacy-cover backfill job's Workflow instance carries.
 *
 * Same shape of reasoning as `CoverRenderPayload`: the run and job identify the
 * durable ledger row, and every pinned dependency version, fingerprint, derived
 * manifest, and staging set is read from that row. A restart therefore reuses
 * the same immutable payload without the launcher reconstructing anything.
 */
export interface CoverBackfillPayload {
  runId: string;
  jobId: string;
  eventId: string;
}

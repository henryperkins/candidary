/**
 * Frozen pre-0020 export Worker evidence.
 *
 * Source revision: df2b66510ccee6893ca91ab752337df8e52c6207
 *
 * This is test-only compatibility evidence, never production fallback code.
 */

export const FROZEN_EXPORT_WORKER_0019_REVISION =
  'df2b66510ccee6893ca91ab752337df8e52c6207';

export const FROZEN_0019_GET_EXPORT_SQL = 'SELECT * FROM export_jobs WHERE id = ?';

export const FROZEN_0019_CLAIM_RUNNING_SQL = `
      UPDATE export_jobs SET state = 'running', started_at = ?, error_code = NULL
      WHERE id = ? AND state = 'queued' AND EXISTS (
        SELECT 1 FROM events
        WHERE events.id = export_jobs.event_id AND events.deleted_at IS NULL
      )
    `;

export const FROZEN_0019_ASSERT_OWNED_RUN_ACTIVE_SQL = `
      SELECT e.id AS event_id, e.deleted_at, j.state, j.started_at
      FROM export_jobs j
      LEFT JOIN events e ON e.id = j.event_id
      WHERE j.id = ?
    `;

export const FROZEN_0019_MARK_READY_CLAIM_SQL = `
        UPDATE export_jobs SET state = 'ready', error_code = ?
        WHERE id = ? AND state = 'running' AND EXISTS (
          SELECT 1 FROM events
          WHERE events.id = export_jobs.event_id AND events.deleted_at IS NULL
        )
      `;

export const FROZEN_0019_MARK_READY_DELETE_PARTS_SQL = `
        DELETE FROM export_parts WHERE export_job_id = ? AND EXISTS (
          SELECT 1 FROM export_jobs
          WHERE id = ? AND state = 'ready' AND error_code = ?
        )
      `;

export const FROZEN_0019_MARK_READY_INSERT_PART_SQL = `
        INSERT INTO export_parts (
          id, export_job_id, part_number, object_key, media_count, source_bytes, created_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (
          SELECT 1 FROM export_jobs
          WHERE id = ? AND state = 'ready' AND error_code = ?
        )
      `;

export const FROZEN_0019_MARK_READY_FINALIZE_SQL = `
        UPDATE export_jobs SET object_key = NULL, manifest_object_key = ?,
          part_count = ?, guestbook_html_object_key = ?, guestbook_html_bytes = ?,
          guestbook_html_sha256 = ?, guestbook_csv_object_key = ?, guestbook_csv_bytes = ?,
          guestbook_csv_sha256 = ?, completed_at = ?, expires_at = ?, error_code = NULL
        WHERE id = ? AND state = 'ready' AND error_code = ?
      `;

export const FROZEN_0019_MARK_FAILED_SQL = `
      UPDATE export_jobs SET state = 'failed', error_code = ? WHERE id = ? AND state IN ('queued', 'running')
    `;

export const FROZEN_0019_RETRY_STATE_SQL = `
          UPDATE export_jobs SET state = 'queued', attempt = attempt + 1, object_key = NULL,
            manifest_object_key = NULL, part_count = 0, error_code = NULL,
            guestbook_html_object_key = NULL, guestbook_html_bytes = NULL,
            guestbook_html_sha256 = NULL, guestbook_csv_object_key = NULL,
            guestbook_csv_bytes = NULL, guestbook_csv_sha256 = NULL,
            started_at = NULL, completed_at = NULL, expires_at = NULL
          WHERE id = ?1 AND state IN ('failed', 'expired')
            AND NOT EXISTS (
              SELECT 1 FROM export_jobs AS active
              WHERE active.event_id = export_jobs.event_id AND active.id <> export_jobs.id
                AND active.state IN ('queued', 'running')
            )
        `;

export const FROZEN_0019_RETRY_DELETE_PARTS_SQL =
  'DELETE FROM export_parts WHERE export_job_id = ? AND changes() = 1';

export const FROZEN_0019_RETRY_DIAGNOSTIC_SQL = `
          SELECT CASE WHEN EXISTS (
            SELECT 1 FROM export_jobs AS active
            JOIN export_jobs AS candidate ON candidate.id = ?1
            WHERE active.event_id = candidate.event_id AND active.id <> candidate.id
              AND active.state IN ('queued', 'running')
          ) THEN 1 ELSE 0 END AS active_conflict
        `;

export const FROZEN_0019_LIST_EXPIRED_READY_SQL = `
      SELECT * FROM export_jobs WHERE state = 'ready' AND expires_at <= ? ORDER BY expires_at LIMIT 100
    `;

export const FROZEN_0019_LIST_PARTS_SQL = `
      SELECT * FROM export_parts WHERE export_job_id = ? ORDER BY part_number ASC
    `;

export const FROZEN_0019_MARK_EXPIRED_SQL = `
      UPDATE export_jobs SET state = 'expired' WHERE id = ? AND state = 'ready' AND expires_at <= ?
    `;

export const FROZEN_0019_EVENT_SOFT_DELETE_SQL =
  'UPDATE events SET deleted_at = COALESCE(deleted_at, ?) WHERE id = ?';

export const FROZEN_0019_EVENT_PURGE_QUEUED_EXPORTS_SQL = `
      UPDATE export_jobs SET state = 'failed', error_code = 'EXPORT_EVENT_DELETED'
      WHERE event_id = ? AND state = 'queued'
    `;

export type Frozen0019R2Operation =
  | { kind: 'list'; prefix: string }
  | { kind: 'delete'; keys: readonly string[] }
  | { kind: 'get'; key: string }
  | { kind: 'put'; key: string }
  | { kind: 'multipart'; key: string };

export interface Frozen0019R2Boundary {
  list(prefix: string): Promise<readonly string[]>;
  delete(keys: readonly string[]): Promise<void>;
  get(key: string): Promise<void>;
  put(key: string): Promise<void>;
  multipart(key: string): Promise<void>;
}

export function createFrozen0019R2Sentinel(): {
  boundary: Frozen0019R2Boundary;
  operations: Frozen0019R2Operation[];
} {
  const operations: Frozen0019R2Operation[] = [];
  return {
    operations,
    boundary: {
      async list(prefix) {
        operations.push({ kind: 'list', prefix });
        return [];
      },
      async delete(keys) {
        operations.push({ kind: 'delete', keys: [...keys] });
      },
      async get(key) {
        operations.push({ kind: 'get', key });
      },
      async put(key) {
        operations.push({ kind: 'put', key });
      },
      async multipart(key) {
        operations.push({ kind: 'multipart', key });
      },
    },
  };
}

interface Frozen0019ExportRow {
  id: string;
  event_id: string;
  state: 'queued' | 'running' | 'ready' | 'failed' | 'expired';
  started_at: string | null;
  attempt: number;
}

export async function runFrozen0019CallbackPrelude(input: {
  db: D1Database;
  boundary: Frozen0019R2Boundary;
  jobId: string;
  claimStartedAt: string;
  sourceObjectKey: string;
}): Promise<'missing' | 'ready' | 'lost' | 'r2-boundary'> {
  const initial = await input.db.prepare(FROZEN_0019_GET_EXPORT_SQL)
    .bind(input.jobId).first<Frozen0019ExportRow>();
  if (!initial) return 'missing';
  if (initial.state === 'ready') return 'ready';

  const claimed = await input.db.prepare(FROZEN_0019_CLAIM_RUNNING_SQL)
    .bind(input.claimStartedAt, input.jobId).run();
  const job = await input.db.prepare(FROZEN_0019_GET_EXPORT_SQL)
    .bind(input.jobId).first<Frozen0019ExportRow>();
  if (job?.state !== 'running' || job.started_at !== input.claimStartedAt) return 'lost';

  const activity = await input.db.prepare(FROZEN_0019_ASSERT_OWNED_RUN_ACTIVE_SQL)
    .bind(input.jobId).first<{
      event_id: string | null;
      deleted_at: string | null;
      state: Frozen0019ExportRow['state'];
      started_at: string | null;
    }>();
  if (!activity || activity.event_id === null || activity.deleted_at !== null) {
    throw new Error('EXPORT_EVENT_DELETED');
  }
  if (activity.state !== 'running' || activity.started_at !== input.claimStartedAt) {
    throw new Error('EXPORT_RUN_NOT_OWNED');
  }

  if ((claimed.meta.changes ?? 0) !== 1) {
    const prefix = `events/${job.event_id}/exports/${job.id}/attempt-${job.attempt}/`;
    for (;;) {
      const keys = await input.boundary.list(prefix);
      if (keys.length === 0) break;
      await input.boundary.delete(keys);
    }
  }

  // The real callback performs D1 snapshot reads next. Once one frozen source
  // is selected, this is its first R2 boundary; later put/multipart work is
  // necessarily unreachable whenever this sentinel remains untouched.
  await input.boundary.get(input.sourceObjectKey);
  return 'r2-boundary';
}

interface Frozen0019ExpiredRow {
  id: string;
  object_key: string | null;
  manifest_object_key: string | null;
  guestbook_html_object_key: string | null;
  guestbook_csv_object_key: string | null;
}

export async function runFrozen0019ExpiredCleanup(input: {
  db: D1Database;
  bucket: Pick<R2Bucket, 'delete'>;
  now: string;
}): Promise<number> {
  const expired = await input.db.prepare(FROZEN_0019_LIST_EXPIRED_READY_SQL)
    .bind(input.now).all<Frozen0019ExpiredRow>();
  let cleaned = 0;
  for (const job of expired.results) {
    const parts = await input.db.prepare(FROZEN_0019_LIST_PARTS_SQL)
      .bind(job.id).all<{ object_key: string }>();
    const keys = [
      job.object_key,
      job.manifest_object_key,
      ...parts.results.map(({ object_key: objectKey }) => objectKey),
      job.guestbook_html_object_key,
      job.guestbook_csv_object_key,
    ].filter((key): key is string => Boolean(key));
    if (keys.length) await input.bucket.delete(keys);
    const result = await input.db.prepare(FROZEN_0019_MARK_EXPIRED_SQL)
      .bind(job.id, input.now).run();
    if ((result.meta.changes ?? 0) === 1) cleaned += 1;
  }
  return cleaned;
}

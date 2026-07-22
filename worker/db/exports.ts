import { ApiError } from '../../shared/errors';
import type { ExportRecord } from './types';

interface ExportRow {
  id: string;
  event_id: string;
  state: ExportRecord['state'];
  snapshot_at: string;
  object_key: string | null;
  media_count: number;
  total_bytes: number;
  attempt: number;
  error_code: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  expires_at: string | null;
}

export interface CreateExportRecord {
  id: string;
  eventId: string;
  snapshotAt: string;
  mediaCount: number;
  totalBytes: number;
  createdAt: string;
}

function mapExport(row: ExportRow): ExportRecord {
  return {
    id: row.id,
    eventId: row.event_id,
    state: row.state,
    snapshotAt: row.snapshot_at,
    objectKey: row.object_key,
    mediaCount: row.media_count,
    totalBytes: row.total_bytes,
    attempt: row.attempt,
    errorCode: row.error_code,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    expiresAt: row.expires_at,
  };
}

export class ExportsRepository {
  constructor(private readonly db: D1Database) {}

  async getById(id: string): Promise<ExportRecord | null> {
    const row = await this.db.prepare('SELECT * FROM export_jobs WHERE id = ?').bind(id).first<ExportRow>();
    return row ? mapExport(row) : null;
  }

  async createActive(input: CreateExportRecord): Promise<ExportRecord> {
    try {
      await this.db.prepare(`
        INSERT INTO export_jobs (
          id, event_id, state, snapshot_at, media_count, total_bytes, attempt, created_at
        ) VALUES (?, ?, 'queued', ?, ?, ?, 1, ?)
      `).bind(
        input.id,
        input.eventId,
        input.snapshotAt,
        input.mediaCount,
        input.totalBytes,
        input.createdAt,
      ).run();
    } catch {
      throw new ApiError('EXPORT_ALREADY_ACTIVE', 'An export is already being prepared for this event.', 409);
    }
    return (await this.getById(input.id))!;
  }

  async listForEvent(eventId: string): Promise<ExportRecord[]> {
    const result = await this.db.prepare(`
      SELECT * FROM export_jobs WHERE event_id = ? ORDER BY created_at DESC
    `).bind(eventId).all<ExportRow>();
    return result.results.map(mapExport);
  }

  async markRunning(id: string, startedAt: string): Promise<ExportRecord> {
    await this.db.prepare(`
      UPDATE export_jobs SET state = 'running', started_at = ?, error_code = NULL
      WHERE id = ? AND state = 'queued'
    `).bind(startedAt, id).run();
    return (await this.getById(id))!;
  }

  async markReady(id: string, objectKey: string, completedAt: string, expiresAt: string): Promise<ExportRecord> {
    await this.db.prepare(`
      UPDATE export_jobs SET state = 'ready', object_key = ?, completed_at = ?, expires_at = ?, error_code = NULL
      WHERE id = ? AND state = 'running'
    `).bind(objectKey, completedAt, expiresAt, id).run();
    return (await this.getById(id))!;
  }

  async markFailed(id: string, errorCode: string): Promise<ExportRecord> {
    await this.db.prepare(`
      UPDATE export_jobs SET state = 'failed', error_code = ? WHERE id = ? AND state IN ('queued', 'running')
    `).bind(errorCode, id).run();
    return (await this.getById(id))!;
  }

  async retry(id: string): Promise<ExportRecord> {
    const result = await this.db.prepare(`
      UPDATE export_jobs SET state = 'queued', attempt = attempt + 1, object_key = NULL,
        error_code = NULL, started_at = NULL, completed_at = NULL, expires_at = NULL
      WHERE id = ? AND state IN ('failed', 'expired')
    `).bind(id).run();
    if ((result.meta.changes ?? 0) !== 1) {
      throw new ApiError('EXPORT_ALREADY_ACTIVE', 'Only failed or expired exports can be retried.', 409);
    }
    return (await this.getById(id))!;
  }

  async expireReady(now: string): Promise<ExportRecord[]> {
    const expired = await this.db.prepare(`
      SELECT * FROM export_jobs WHERE state = 'ready' AND expires_at <= ?
    `).bind(now).all<ExportRow>();
    if (expired.results.length) {
      await this.db.prepare(`
        UPDATE export_jobs SET state = 'expired' WHERE state = 'ready' AND expires_at <= ?
      `).bind(now).run();
    }
    return expired.results.map(mapExport);
  }
}

import { ApiError } from '../../shared/errors';
import type { ExportPartRecord, ExportRecord } from './types';

interface ExportRow {
  id: string;
  event_id: string;
  state: ExportRecord['state'];
  snapshot_at: string;
  object_key: string | null;
  manifest_object_key: string | null;
  part_count: number;
  media_count: number;
  total_bytes: number;
  attempt: number;
  error_code: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  expires_at: string | null;
}

interface ExportPartRow {
  id: string;
  export_job_id: string;
  part_number: number;
  object_key: string;
  media_count: number;
  source_bytes: number;
  created_at: string;
}

export interface ReadyExportPart {
  partNumber: number;
  objectKey: string;
  mediaCount: number;
  sourceBytes: number;
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
    manifestObjectKey: row.manifest_object_key,
    partCount: row.part_count,
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

function mapPart(row: ExportPartRow): ExportPartRecord {
  return {
    id: row.id,
    exportJobId: row.export_job_id,
    partNumber: row.part_number,
    objectKey: row.object_key,
    mediaCount: row.media_count,
    sourceBytes: row.source_bytes,
    createdAt: row.created_at,
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

  async listParts(exportJobId: string): Promise<ExportPartRecord[]> {
    const result = await this.db.prepare(`
      SELECT * FROM export_parts WHERE export_job_id = ? ORDER BY part_number ASC
    `).bind(exportJobId).all<ExportPartRow>();
    return result.results.map(mapPart);
  }

  async markRunning(id: string, startedAt: string): Promise<ExportRecord> {
    await this.db.prepare(`
      UPDATE export_jobs SET state = 'running', started_at = ?, error_code = NULL
      WHERE id = ? AND state = 'queued'
    `).bind(startedAt, id).run();
    return (await this.getById(id))!;
  }

  async markReady(
    id: string,
    manifestObjectKey: string,
    parts: ReadyExportPart[],
    completedAt: string,
    expiresAt: string,
  ): Promise<ExportRecord> {
    if (!parts.length) throw new Error('A ready export must contain at least one part.');
    const statements = [
      this.db.prepare('DELETE FROM export_parts WHERE export_job_id = ?').bind(id),
      ...parts.map((part) => this.db.prepare(`
        INSERT INTO export_parts (
          id, export_job_id, part_number, object_key, media_count, source_bytes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        crypto.randomUUID(), id, part.partNumber, part.objectKey,
        part.mediaCount, part.sourceBytes, completedAt,
      )),
      this.db.prepare(`
        UPDATE export_jobs SET state = 'ready', object_key = NULL, manifest_object_key = ?,
          part_count = ?, completed_at = ?, expires_at = ?, error_code = NULL
        WHERE id = ? AND state = 'running'
      `).bind(manifestObjectKey, parts.length, completedAt, expiresAt, id),
    ];
    const results = await this.db.batch(statements);
    if ((results.at(-1)?.meta.changes ?? 0) !== 1) throw new Error('Export job was not running.');
    return (await this.getById(id))!;
  }

  async markFailed(id: string, errorCode: string): Promise<ExportRecord> {
    await this.db.prepare(`
      UPDATE export_jobs SET state = 'failed', error_code = ? WHERE id = ? AND state IN ('queued', 'running')
    `).bind(errorCode, id).run();
    return (await this.getById(id))!;
  }

  async retry(id: string): Promise<ExportRecord> {
    const results = await this.db.batch([
      this.db.prepare(`
        UPDATE export_jobs SET state = 'queued', attempt = attempt + 1, object_key = NULL,
          manifest_object_key = NULL, part_count = 0, error_code = NULL,
          started_at = NULL, completed_at = NULL, expires_at = NULL
        WHERE id = ? AND state IN ('failed', 'expired')
      `).bind(id),
      this.db.prepare('DELETE FROM export_parts WHERE export_job_id = ? AND changes() = 1').bind(id),
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1) {
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

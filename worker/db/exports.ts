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
}


export type MediaObjectWriteTombstoneKind = 'source' | 'final' | 'preview' | 'export' | 'cover';
export type MediaBucketGeneration = 'legacy' | 'canonical';

interface MediaObjectWriteTombstoneRow {
  bucket_generation: MediaBucketGeneration;
  object_key: string;
  event_id: string;
  media_id: string;
  object_kind: MediaObjectWriteTombstoneKind;
  suppression_started_at: string | null;
  last_observed_at: string | null;
  last_observed_present: 0 | 1 | null;
  next_check_at: string;
  created_at: string;
  updated_at: string;
}

export interface MediaObjectWriteTombstone {
  bucketGeneration: MediaBucketGeneration;
  objectKey: string;
  eventId: string;
  mediaId: string;
  objectKind: MediaObjectWriteTombstoneKind;
  suppressionStartedAt: string | null;
  lastObservedAt: string | null;
  lastObservedPresent: boolean | null;
  nextCheckAt: string;
  createdAt: string;
  updatedAt: string;
}

function mapTombstone(row: MediaObjectWriteTombstoneRow): MediaObjectWriteTombstone {
  return {
    bucketGeneration: row.bucket_generation,
    objectKey: row.object_key,
    eventId: row.event_id,
    mediaId: row.media_id,
    objectKind: row.object_kind,
    suppressionStartedAt: row.suppression_started_at,
    lastObservedAt: row.last_observed_at,
    lastObservedPresent: row.last_observed_present === null
      ? null
      : row.last_observed_present === 1,
    nextCheckAt: row.next_check_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class MediaObjectWriteTombstoneRepository {
  constructor(private readonly db: D1Database) {}

  async get(
    objectKey: string,
    bucketGeneration: MediaBucketGeneration = 'legacy',
  ): Promise<MediaObjectWriteTombstone | null> {
    const row = await this.db.prepare(`
      SELECT * FROM media_object_write_tombstones
      WHERE bucket_generation = ? AND object_key = ?
    `).bind(bucketGeneration, objectKey).first<MediaObjectWriteTombstoneRow>();
    return row ? mapTombstone(row) : null;
  }

  async ensure(input: {
    bucketGeneration?: MediaBucketGeneration;
    objectKey: string;
    eventId: string;
    mediaId: string;
    objectKind: MediaObjectWriteTombstoneKind;
    recordedAt: string;
    allowSuppressed?: boolean;
  }): Promise<MediaObjectWriteTombstone> {
    const bucketGeneration = input.bucketGeneration ?? 'legacy';
    try {
      await this.db.prepare(`
        INSERT INTO media_object_write_tombstones (
          bucket_generation, object_key, event_id, media_id, object_kind,
          next_check_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (bucket_generation, object_key) DO UPDATE SET
          updated_at = media_object_write_tombstones.updated_at
        WHERE media_object_write_tombstones.event_id = excluded.event_id
          AND media_object_write_tombstones.media_id = excluded.media_id
          AND media_object_write_tombstones.object_kind = excluded.object_kind
      `).bind(
        bucketGeneration,
        input.objectKey,
        input.eventId,
        input.mediaId,
        input.objectKind,
        input.recordedAt,
        input.recordedAt,
        input.recordedAt,
      ).run();
    } catch (error) {
      // A D1 response can be lost after the permanent row committed. Re-read
      // the composite identity before treating the inventory attempt as failed.
      const ambiguous = await this.get(input.objectKey, bucketGeneration);
      if (!ambiguous
        || ambiguous.eventId !== input.eventId
        || ambiguous.mediaId !== input.mediaId
        || ambiguous.objectKind !== input.objectKind) throw error;
    }
    const current = await this.get(input.objectKey, bucketGeneration);
    if (!current
      || current.eventId !== input.eventId
      || current.mediaId !== input.mediaId
      || current.objectKind !== input.objectKind) {
      throw new Error('Media object write tombstone ownership collision.');
    }
    if (current.suppressionStartedAt !== null && !input.allowSuppressed) {
      throw new Error('Media object write target is permanently suppressed.');
    }
    return current;
  }

  async listDue(
    now: string,
    suppressedQuota: number,
    classificationQuota: number,
  ): Promise<MediaObjectWriteTombstone[]> {
    const suppressedLimit = Math.max(0, Math.min(500, Math.trunc(suppressedQuota)));
    const classificationLimit = Math.max(0, Math.min(500, Math.trunc(classificationQuota)));
    const suppressed = await this.db.prepare(`
      SELECT * FROM media_object_write_tombstones
      WHERE next_check_at <= ? AND suppression_started_at IS NOT NULL
      ORDER BY next_check_at ASC, bucket_generation ASC, object_key ASC
      LIMIT ?
    `).bind(now, suppressedLimit).all<MediaObjectWriteTombstoneRow>();
    const classification = classificationLimit > 0
      ? await this.db.prepare(`
          SELECT * FROM media_object_write_tombstones
          WHERE next_check_at <= ? AND suppression_started_at IS NULL
          ORDER BY next_check_at ASC, bucket_generation ASC, object_key ASC
          LIMIT ?
        `).bind(now, classificationLimit).all<MediaObjectWriteTombstoneRow>()
      : { results: [] as MediaObjectWriteTombstoneRow[] };
    return [...suppressed.results, ...classification.results].map(mapTombstone);
  }

  async beginSuppression(
    objectKey: string,
    suppressedAt: string,
    bucketGeneration: MediaBucketGeneration = 'legacy',
  ): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE media_object_write_tombstones AS target
      SET suppression_started_at = ?, updated_at = ?
      WHERE target.bucket_generation = ? AND target.object_key = ?
        AND target.suppression_started_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM media AS m
          JOIN events AS e ON e.id = m.event_id AND e.deleted_at IS NULL
          WHERE m.id = target.media_id AND m.event_id = target.event_id
            AND m.deleted_at IS NULL
            AND (
              (target.object_kind = 'source'
                AND m.upload_state IN ('reserved', 'stored')
                AND m.object_bucket_generation = target.bucket_generation
                AND m.object_key = target.object_key)
              OR (target.object_kind = 'final'
                AND m.upload_state = 'stored'
                AND m.object_bucket_generation = target.bucket_generation
                AND m.object_key = target.object_key)
              OR (target.object_kind = 'preview'
                AND target.bucket_generation = 'legacy'
                AND m.upload_state = 'stored'
                AND m.preview_object_key = target.object_key)
            )
        )
        AND NOT EXISTS (
          SELECT 1 FROM media_object_promotions AS p
          WHERE p.media_id = target.media_id AND p.event_id = target.event_id
            AND (
              (p.source_bucket_generation = target.bucket_generation
                AND p.source_object_key = target.object_key)
              OR (p.final_bucket_generation = target.bucket_generation
                AND p.final_object_key = target.object_key)
              OR (target.object_kind = 'preview' AND target.bucket_generation = 'legacy')
            )
        )
        AND NOT EXISTS (
          SELECT 1 FROM export_jobs AS j
          WHERE target.object_kind = 'export'
            AND target.bucket_generation = 'legacy'
            AND j.id = target.media_id AND j.event_id = target.event_id
            AND EXISTS (
              SELECT 1 FROM events AS e
              WHERE e.id = j.event_id AND e.deleted_at IS NULL
            )
            AND (
              (
                j.state IN ('queued', 'running')
                AND substr(
                  target.object_key,
                  1,
                  length('events/' || j.event_id || '/exports/' || j.id ||
                    '/attempt-' || j.attempt || '/')
                ) = 'events/' || j.event_id || '/exports/' || j.id ||
                  '/attempt-' || j.attempt || '/'
              )
              OR (
                j.state = 'ready' AND j.expires_at > ?
                AND (
                  j.manifest_object_key = target.object_key
                  OR j.guestbook_html_object_key = target.object_key
                  OR j.guestbook_csv_object_key = target.object_key
                  OR EXISTS (
                    SELECT 1 FROM export_parts AS part
                    WHERE part.export_job_id = j.id
                      AND part.object_key = target.object_key
                  )
                )
              )
            )
        )
        AND NOT EXISTS (
          SELECT 1 FROM events AS e
          WHERE target.object_kind = 'cover'
            AND target.bucket_generation = 'legacy'
            AND e.id = target.event_id AND e.deleted_at IS NULL
        )
    `).bind(suppressedAt, suppressedAt, bucketGeneration, objectKey, suppressedAt).run();
    if ((result.meta.changes ?? 0) === 1) return true;
    const current = await this.get(objectKey, bucketGeneration);
    return current?.suppressionStartedAt != null;
  }

  async hasCurrentOwner(
    objectKey: string,
    bucketGeneration: MediaBucketGeneration,
    now: string,
  ): Promise<boolean> {
    const target = await this.get(objectKey, bucketGeneration);
    if (!target) return false;
    const row = await this.db.prepare(`
      SELECT 1 AS owned
      WHERE EXISTS (
        SELECT 1 FROM media AS m
        JOIN events AS e ON e.id = m.event_id AND e.deleted_at IS NULL
        WHERE m.id = ? AND m.event_id = ? AND m.deleted_at IS NULL
          AND (
            (? IN ('source', 'final') AND m.object_bucket_generation = ? AND m.object_key = ?)
            OR (? = 'preview' AND ? = 'legacy' AND m.preview_object_key = ?)
          )
      ) OR EXISTS (
        SELECT 1 FROM media_object_promotions AS p
        WHERE p.media_id = ? AND p.event_id = ? AND (
          (p.source_bucket_generation = ? AND p.source_object_key = ?)
          OR (p.final_bucket_generation = ? AND p.final_object_key = ?)
          OR (? = 'preview' AND ? = 'legacy')
        )
      ) OR EXISTS (
        SELECT 1 FROM export_jobs AS j
        WHERE ? = 'export' AND ? = 'legacy'
          AND j.id = ? AND j.event_id = ? AND (
            (j.state IN ('queued', 'running') AND substr(?, 1, length(
              'events/' || j.event_id || '/exports/' || j.id || '/attempt-' || j.attempt || '/'
            )) = 'events/' || j.event_id || '/exports/' || j.id || '/attempt-' || j.attempt || '/')
            OR (j.state = 'ready' AND j.expires_at > ? AND (
              j.manifest_object_key = ? OR j.guestbook_html_object_key = ?
              OR j.guestbook_csv_object_key = ?
              OR EXISTS (SELECT 1 FROM export_parts part WHERE part.export_job_id = j.id AND part.object_key = ?)
            ))
          ) AND EXISTS (
            SELECT 1 FROM events e WHERE e.id = j.event_id AND e.deleted_at IS NULL
          )
      ) OR EXISTS (
        SELECT 1 FROM events e
        WHERE ? = 'cover' AND ? = 'legacy' AND e.id = ? AND e.deleted_at IS NULL
      )
    `).bind(
      target.mediaId, target.eventId, target.objectKind, bucketGeneration, objectKey,
      target.objectKind, bucketGeneration, objectKey,
      target.mediaId, target.eventId, bucketGeneration, objectKey,
      bucketGeneration, objectKey, target.objectKind, bucketGeneration,
      target.objectKind, bucketGeneration, target.mediaId, target.eventId, objectKey, now,
      objectKey, objectKey, objectKey, objectKey,
      target.objectKind, bucketGeneration, target.eventId,
    ).first<number>('owned');
    return row === 1;
  }

  async recordObservation(input: {
    bucketGeneration?: MediaBucketGeneration;
    objectKey: string;
    observedAt: string;
    present: boolean;
    nextCheckAt: string;
  }): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE media_object_write_tombstones
      SET last_observed_at = ?, last_observed_present = ?,
          next_check_at = ?, updated_at = ?
      WHERE bucket_generation = ? AND object_key = ?
        AND suppression_started_at IS NOT NULL
    `).bind(
      input.observedAt,
      input.present ? 1 : 0,
      input.nextCheckAt,
      input.observedAt,
      input.bucketGeneration ?? 'legacy',
      input.objectKey,
    ).run();
    return (result.meta.changes ?? 0) === 1;
  }

  async defer(
    objectKey: string,
    deferredAt: string,
    nextCheckAt: string,
    bucketGeneration: MediaBucketGeneration = 'legacy',
  ): Promise<void> {
    await this.db.prepare(`
      UPDATE media_object_write_tombstones
      SET next_check_at = ?, updated_at = ?
      WHERE bucket_generation = ? AND object_key = ?
    `).bind(nextCheckAt, deferredAt, bucketGeneration, objectKey).run();
  }

  async count(): Promise<number> {
    return (await this.db.prepare(`
      SELECT count(*) AS count FROM media_object_write_tombstones
    `).first<number>('count')) ?? 0;
  }
}

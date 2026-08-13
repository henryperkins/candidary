export interface LegacyMediaScanState {
  cursor: string | null;
  epoch: number;
  epochStartedAt: string;
  epochDiscoveredCount: number;
  epochErrorCount: number;
  epochMaxHourlyGrowth: number;
  lastObservedAt: string | null;
  lastObservedInventoryCount: number;
  lastErrorAt: string | null;
  lastCompletedAt: string | null;
  lastCompletedStartedAt: string | null;
  lastCompletedDiscoveredCount: number | null;
  lastCompletedErrorCount: number | null;
  lastCompletedMaxHourlyGrowth: number | null;
  updatedAt: string;
}

export interface LegacyMediaScanObservation extends LegacyMediaScanState {
  totalTombstones: number;
  totalQuarantined: number;
  overdueSuppressedCount: number;
  oldestOverdueSuppressedAt: string | null;
  dueClassificationCount: number;
  oldestDueClassificationAt: string | null;
  lastCompletedWithinSla: boolean;
  growthWithinCeiling: boolean;
  completedEpochErrorFree: boolean;
  suppressedBacklogClear: boolean;
  readyForCanonicalLive: boolean;
}

interface LegacyMediaScanStateRow {
  cursor: string | null;
  epoch: number;
  epoch_started_at: string;
  epoch_discovered_count: number;
  epoch_error_count: number;
  epoch_max_hourly_growth: number;
  last_observed_at: string | null;
  last_observed_inventory_count: number;
  last_error_at: string | null;
  last_completed_at: string | null;
  last_completed_started_at: string | null;
  last_completed_discovered_count: number | null;
  last_completed_error_count: number | null;
  last_completed_max_hourly_growth: number | null;
  updated_at: string;
}

function mapState(row: LegacyMediaScanStateRow): LegacyMediaScanState {
  return {
    cursor: row.cursor,
    epoch: row.epoch,
    epochStartedAt: row.epoch_started_at,
    epochDiscoveredCount: row.epoch_discovered_count,
    epochErrorCount: row.epoch_error_count,
    epochMaxHourlyGrowth: row.epoch_max_hourly_growth,
    lastObservedAt: row.last_observed_at,
    lastObservedInventoryCount: row.last_observed_inventory_count,
    lastErrorAt: row.last_error_at,
    lastCompletedAt: row.last_completed_at,
    lastCompletedStartedAt: row.last_completed_started_at,
    lastCompletedDiscoveredCount: row.last_completed_discovered_count,
    lastCompletedErrorCount: row.last_completed_error_count,
    lastCompletedMaxHourlyGrowth: row.last_completed_max_hourly_growth,
    updatedAt: row.updated_at,
  };
}

/**
 * Permanent cursor and quarantine inventory for the legacy R2 namespace.
 *
 * Neither table owns relational rows. That is intentional: an already-admitted
 * old-bucket write can outlive the media/event rows that originally named it.
 */
export class LegacyMediaScanRepository {
  constructor(private readonly db: D1Database) {}

  async getState(): Promise<LegacyMediaScanState> {
    const row = await this.db.prepare(`
      SELECT cursor, epoch, last_completed_at, updated_at
        , epoch_started_at, epoch_discovered_count, epoch_error_count,
          epoch_max_hourly_growth, last_observed_at,
          last_observed_inventory_count, last_error_at,
          last_completed_started_at, last_completed_discovered_count,
          last_completed_error_count, last_completed_max_hourly_growth
      FROM legacy_media_scan_state WHERE singleton = 1
    `).first<LegacyMediaScanStateRow>();
    if (!row) throw new Error('Legacy media scan state is missing.');
    return mapState(row);
  }

  async recordQuarantine(objectKey: string, observedAt: string): Promise<void> {
    await this.db.prepare(`
      INSERT INTO legacy_media_scan_quarantine (
        object_key, first_observed_at, last_observed_at, observation_count
      ) VALUES (?, ?, ?, 1)
      ON CONFLICT (object_key) DO UPDATE SET
        last_observed_at = excluded.last_observed_at,
        observation_count = legacy_media_scan_quarantine.observation_count + 1
    `).bind(objectKey, observedAt, observedAt).run();
  }

  async advance(
    expectedCursor: string | null,
    nextCursor: string | null,
    completedAt: string,
    inventoryCount?: number,
  ): Promise<LegacyMediaScanState> {
    const wrapped = nextCursor === null;
    const before = await this.getState();
    const recordsObservation = inventoryCount !== undefined;
    const discovered = recordsObservation
      ? Math.max(0, inventoryCount - before.lastObservedInventoryCount)
      : 0;
    const elapsedMs = before.lastObservedAt === null
      ? null
      : Math.max(1, Date.parse(completedAt) - Date.parse(before.lastObservedAt));
    const hourlyGrowth = elapsedMs === null
      ? 0
      : Math.ceil((discovered * 60 * 60 * 1_000) / elapsedMs);
    const completedDiscovered = before.epochDiscoveredCount + discovered;
    const completedMaxGrowth = Math.max(before.epochMaxHourlyGrowth, hourlyGrowth);
    await this.db.prepare(`
      UPDATE legacy_media_scan_state
      SET cursor = ?,
          epoch = epoch + ?,
          epoch_started_at = CASE WHEN ? = 1 THEN ? ELSE epoch_started_at END,
          epoch_discovered_count = CASE
            WHEN ? = 1 THEN 0
            WHEN ? = 1 THEN ?
            ELSE epoch_discovered_count END,
          epoch_error_count = CASE WHEN ? = 1 THEN 0 ELSE epoch_error_count END,
          epoch_max_hourly_growth = CASE
            WHEN ? = 1 THEN 0
            WHEN ? = 1 THEN ?
            ELSE epoch_max_hourly_growth END,
          last_observed_at = CASE WHEN ? = 1 THEN ? ELSE last_observed_at END,
          last_observed_inventory_count = CASE
            WHEN ? = 1 THEN ? ELSE last_observed_inventory_count END,
          last_completed_at = CASE WHEN ? = 1 THEN ? ELSE last_completed_at END,
          last_completed_started_at = CASE
            WHEN ? = 1 THEN epoch_started_at ELSE last_completed_started_at END,
          last_completed_discovered_count = CASE
            WHEN ? = 1 THEN ? ELSE last_completed_discovered_count END,
          last_completed_error_count = CASE
            WHEN ? = 1 THEN epoch_error_count ELSE last_completed_error_count END,
          last_completed_max_hourly_growth = CASE
            WHEN ? = 1 THEN ? ELSE last_completed_max_hourly_growth END,
          updated_at = ?
      WHERE singleton = 1 AND cursor IS ?
    `).bind(
      nextCursor,
      wrapped ? 1 : 0,
      wrapped ? 1 : 0,
      completedAt,
      wrapped ? 1 : 0,
      recordsObservation ? 1 : 0,
      completedDiscovered,
      wrapped ? 1 : 0,
      wrapped ? 1 : 0,
      recordsObservation ? 1 : 0,
      completedMaxGrowth,
      recordsObservation ? 1 : 0,
      completedAt,
      recordsObservation ? 1 : 0,
      inventoryCount ?? before.lastObservedInventoryCount,
      wrapped ? 1 : 0,
      completedAt,
      wrapped ? 1 : 0,
      wrapped ? 1 : 0,
      completedDiscovered,
      wrapped ? 1 : 0,
      wrapped ? 1 : 0,
      completedMaxGrowth,
      completedAt,
      expectedCursor,
    ).run();
    // Losing this CAS means another invocation advanced the same durable page.
    // Every object was inventoried before either writer could move the cursor.
    return this.getState();
  }

  async countPermanentInventory(): Promise<number> {
    return (await this.db.prepare(`
      SELECT
        (SELECT count(*) FROM media_object_write_tombstones)
        + (SELECT count(*) FROM legacy_media_scan_quarantine) AS count
    `).first<number>('count')) ?? 0;
  }

  async recordError(failedAt: string): Promise<void> {
    await this.db.prepare(`
      UPDATE legacy_media_scan_state
      SET epoch_error_count = epoch_error_count + 1,
          last_error_at = ?, updated_at = ?
      WHERE singleton = 1
    `).bind(failedAt, failedAt).run();
  }

  async getObservation(
    now: string,
    growthCeilingPerHour: number,
    fullEpochSlaHours: number,
  ): Promise<LegacyMediaScanObservation> {
    const state = await this.getState();
    const inventory = await this.db.prepare(`
      SELECT
        (SELECT count(*) FROM media_object_write_tombstones) AS total_tombstones,
        (SELECT count(*) FROM legacy_media_scan_quarantine) AS total_quarantined,
        (SELECT count(*) FROM media_object_write_tombstones
          WHERE suppression_started_at IS NOT NULL AND next_check_at <= ?) AS overdue_suppressed_count,
        (SELECT min(next_check_at) FROM media_object_write_tombstones
          WHERE suppression_started_at IS NOT NULL AND next_check_at <= ?) AS oldest_overdue_suppressed_at,
        (SELECT count(*) FROM media_object_write_tombstones
          WHERE suppression_started_at IS NULL AND next_check_at <= ?) AS due_classification_count,
        (SELECT min(next_check_at) FROM media_object_write_tombstones
          WHERE suppression_started_at IS NULL AND next_check_at <= ?) AS oldest_due_classification_at
    `).bind(now, now, now, now).first<{
      total_tombstones: number;
      total_quarantined: number;
      overdue_suppressed_count: number;
      oldest_overdue_suppressed_at: string | null;
      due_classification_count: number;
      oldest_due_classification_at: string | null;
    }>();
    if (!inventory) throw new Error('Legacy media scanner inventory observation failed.');
    const completedAt = state.lastCompletedAt === null ? null : Date.parse(state.lastCompletedAt);
    const observedAt = Date.parse(now);
    const lastCompletedWithinSla = completedAt !== null
      && Number.isFinite(completedAt)
      && observedAt - completedAt <= fullEpochSlaHours * 60 * 60 * 1_000;
    const growthWithinCeiling = state.lastCompletedMaxHourlyGrowth !== null
      && state.lastCompletedMaxHourlyGrowth <= growthCeilingPerHour;
    const completedEpochErrorFree = state.lastCompletedErrorCount === 0;
    const suppressedBacklogClear = inventory.overdue_suppressed_count === 0;
    return {
      ...state,
      totalTombstones: inventory.total_tombstones,
      totalQuarantined: inventory.total_quarantined,
      overdueSuppressedCount: inventory.overdue_suppressed_count,
      oldestOverdueSuppressedAt: inventory.oldest_overdue_suppressed_at,
      dueClassificationCount: inventory.due_classification_count,
      oldestDueClassificationAt: inventory.oldest_due_classification_at,
      lastCompletedWithinSla,
      growthWithinCeiling,
      completedEpochErrorFree,
      suppressedBacklogClear,
      readyForCanonicalLive: lastCompletedWithinSla
        && growthWithinCeiling
        && completedEpochErrorFree
        && suppressedBacklogClear,
    };
  }

  async resetCursor(expectedCursor: string | null, resetAt: string): Promise<void> {
    await this.db.prepare(`
      UPDATE legacy_media_scan_state
      SET cursor = NULL, updated_at = ?
      WHERE singleton = 1 AND cursor IS ?
    `).bind(resetAt, expectedCursor).run();
  }
}

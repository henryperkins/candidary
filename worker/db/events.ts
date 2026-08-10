import { parseStoredEventThemeConfig } from '../../shared/event-theme';
import type { EventRecord } from './types';

export interface EventRow {
  id: string;
  slug: string;
  name: string;
  event_date: string;
  welcome_message: string;
  theme_config: string;
  cover_object_key: string | null;
  uploads_enabled: number;
  gallery_visible: number;
  moderation_required: number;
  reserved_media_count: number;
  stored_media_count: number;
  reserved_bytes: number;
  stored_bytes: number;
  guest_access_expires_at: string;
  management_access_expires_at: string;
  purge_after: string;
  created_at: string;
  deleted_at: string | null;
  event_timezone: string;
  event_start_at: string;
  photos_open_from: string | null;
  rsvp_enabled: number;
  rsvp_deadline_at: string | null;
  rsvp_roster_version: number;
  cover_config: string;
  cover_revision: number;
  cover_render_set_id: string | null;
}

export interface CreateEventRecord {
  id: string;
  slug: string;
  name: string;
  eventDate: string;
  welcomeMessage: string;
  guestAccessExpiresAt: string;
  managementAccessExpiresAt: string;
  purgeAfter: string;
  createdAt: string;
  themeConfig: string;
  eventTimezone: string;
  // The last millisecond of the host's chosen local day, already resolved. The
  // repository never converts a date, so no zone logic can drift in here.
  rsvpDeadlineAt: string;
  // The event's start as an absolute instant, resolved the same way and for the
  // same reason.
  eventStartAt: string;
}

export function mapEvent(row: EventRow): EventRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    eventDate: row.event_date,
    welcomeMessage: row.welcome_message,
    themeConfig: parseStoredEventThemeConfig(row.theme_config),
    coverObjectKey: row.cover_object_key,
    uploadsEnabled: row.uploads_enabled === 1,
    galleryVisible: row.gallery_visible === 1,
    moderationRequired: row.moderation_required === 1,
    reservedMediaCount: row.reserved_media_count,
    storedMediaCount: row.stored_media_count,
    reservedBytes: row.reserved_bytes,
    storedBytes: row.stored_bytes,
    guestAccessExpiresAt: row.guest_access_expires_at,
    managementAccessExpiresAt: row.management_access_expires_at,
    purgeAfter: row.purge_after,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
    eventTimezone: row.event_timezone,
    eventStartAt: row.event_start_at,
    photosOpenFrom: row.photos_open_from,
    rsvpEnabled: row.rsvp_enabled === 1,
    rsvpDeadlineAt: row.rsvp_deadline_at,
    rsvpRosterVersion: row.rsvp_roster_version,
    coverConfig: row.cover_config,
    coverRevision: row.cover_revision,
    coverRenderSetId: row.cover_render_set_id,
  };
}

export interface CoverPointerMove {
  eventId: string;
  expectedRevision: number;
  expectedCurrentKey: string | null;
  expectedCurrentRenderSetId: string | null;
  nextConfig: string;
  nextObjectKey: string | null;
  nextRenderSetId: string | null;
  retiredAt: string;
  cleanupAfter: string;
  /**
   * A lowercase SHA-256 of `expectedCurrentKey`, from `coverKeyFingerprint`.
   *
   * Passed in rather than computed here because the digest is asynchronous and
   * this is a statement builder. Ignored when nothing is displaced.
   */
  retiredKeyFingerprint: string;
  /**
   * Why the displaced original is being retired.
   *
   * Defaults to the publication reading — `removed` when nothing replaces it,
   * `replaced` otherwise. Only backfill passes this explicitly, because its
   * displacement is neither: the host did not ask for it, and the bytes it
   * displaces are the ones the compatibility reader was still serving.
   */
  reason?: 'replaced' | 'removed' | 'backfilled';
  /** Exact owner for a synchronous preset or removal pointer move. */
  semanticPublicationGuard?: {
    action: 'publish' | 'remove';
    operationId: string;
    requestSha256: string;
    expectedRevision: number;
  };
  /** Exact durable owner for an uploaded-cover Workflow pointer move. */
  renderPublicationGuard?: {
    operationId: string;
    requestSha256: string;
    workflowInstanceId: string;
    dispatchGeneration: number;
    renderSetId: string;
    draftId: string;
  };
  /** Exact durable owner for a release backfill Workflow pointer move. */
  backfillGuard?: {
    runId: string;
    jobId: string;
    workflowInstanceId: string;
    dispatchGeneration: number;
    masterId: string;
    renderSetId: string;
    legacyKeyFingerprint: string;
  };
  /** Require the immediately preceding guarded owner transition to have won. */
  onlyIfPriorStatementChanged?: boolean;
}

/**
 * The guarded cover-pointer move, as statements rather than as a method.
 *
 * A method that ran its own batch could not participate in the one transaction
 * publication actually needs: the pointer flip, the retirement insert, the
 * previous set's retirement, the new set's activation, the draft's `published`
 * flip, and the receipt's `applied` flip all have to commit together or not at
 * all. So this returns the two statements the caller composes into its own
 * `db.batch`.
 *
 * Order follows the house convention exactly — guard first — and here that
 * ordering fixes two things the naive shape gets wrong:
 *
 *  - A D1 batch rolls back only when a statement *errors*. A zero-change UPDATE
 *    does not error, so a retirement insert placed first would happily commit a
 *    row naming a cover that is still current after the guard was lost.
 *  - On the first cover an event ever gets, `expectedCurrentKey` is null. An
 *    unconditional insert would write NULL into a NOT NULL UNIQUE column and
 *    fail every first publication.
 *
 * `changes() = 1` plus the two null tests cover both. The caller checks
 * `results[0].meta.changes === 1` and raises the house 409 for a lost optimistic
 * guard; a plain `Error` would surface as INTERNAL_ERROR 500, which is the wrong
 * signal for a revision conflict.
 *
 * No R2 delete happens here. Only bounded cleanup may delete a retired object,
 * and only after its recovery window.
 */
export function coverPointerStatements(
  db: D1Database,
  input: CoverPointerMove,
): D1PreparedStatement[] {
  const renderGuardSql = input.renderPublicationGuard ? `
        AND EXISTS (
          SELECT 1
          FROM event_cover_publish_receipts r
          JOIN event_cover_render_sets s
            ON s.id = r.render_set_id AND s.event_id = r.event_id
              AND s.draft_id = r.draft_id AND s.state = 'ready'
          JOIN event_cover_drafts d
            ON d.id = r.draft_id AND d.event_id = r.event_id AND d.state = 'publishing'
          JOIN event_cover_workflow_fences f
            ON f.workflow_binding = 'COVER_RENDER_WORKFLOW'
              AND f.workflow_instance_id = r.workflow_instance_id
              AND f.event_id = r.event_id AND f.state = 'open'
              AND f.dispatch_generation = r.dispatch_generation
          WHERE r.event_id = events.id AND r.operation_id = ?
            AND r.request_sha256 = ? AND r.workflow_instance_id = ?
            AND r.dispatch_generation = ? AND r.render_set_id = ? AND r.draft_id = ?
            AND r.status = 'applied'
        )
  ` : '';
  const backfillGuardSql = input.backfillGuard ? `
        AND EXISTS (
          SELECT 1
          FROM event_cover_backfill_jobs j
          JOIN event_cover_render_sets s
            ON s.id = j.render_set_id AND s.event_id = j.event_id
              AND s.master_id = j.master_id AND s.draft_id IS NULL
              AND s.state = 'ready'
          JOIN event_cover_workflow_fences f
            ON f.workflow_binding = 'COVER_BACKFILL_WORKFLOW'
              AND f.workflow_instance_id = j.workflow_instance_id
              AND f.event_id = j.event_id AND f.state = 'open'
              AND f.dispatch_generation = j.dispatch_generation
          WHERE j.event_id = events.id AND j.run_id = ? AND j.id = ?
            AND j.workflow_instance_id = ? AND j.dispatch_generation = ?
            AND j.master_id = ? AND j.render_set_id = ?
            AND j.legacy_key_fingerprint = ?
            AND j.status = 'applied'
        )
  ` : '';
  const ownerBindings: unknown[] = [];
  if (input.renderPublicationGuard) {
    ownerBindings.push(
      input.renderPublicationGuard.operationId,
      input.renderPublicationGuard.requestSha256,
      input.renderPublicationGuard.workflowInstanceId,
      input.renderPublicationGuard.dispatchGeneration,
      input.renderPublicationGuard.renderSetId,
      input.renderPublicationGuard.draftId,
    );
  }
  if (input.backfillGuard) {
    ownerBindings.push(
      input.backfillGuard.runId,
      input.backfillGuard.jobId,
      input.backfillGuard.workflowInstanceId,
      input.backfillGuard.dispatchGeneration,
      input.backfillGuard.masterId,
      input.backfillGuard.renderSetId,
      input.backfillGuard.legacyKeyFingerprint,
    );
  }
  const priorChangeGuard = input.onlyIfPriorStatementChanged ? ' AND changes() = 1' : '';
  return [
    db.prepare(`
      UPDATE events SET
        cover_config = ?,
        cover_object_key = ?,
        cover_render_set_id = ?,
        cover_revision = cover_revision + 1
      WHERE id = ?
        AND deleted_at IS NULL
        AND cover_revision = ?
        AND cover_object_key IS ?
        AND cover_render_set_id IS ?
        AND (
          ? IS NULL OR EXISTS (
            SELECT 1 FROM event_cover_publish_receipts r
            WHERE r.event_id = events.id AND r.operation_id = ?
              AND r.request_sha256 = ? AND r.action = ?
              AND r.expected_revision = ? AND r.status = 'queued' AND r.retryable = 0
              AND r.workflow_instance_id IS NULL AND r.render_set_id IS NULL AND r.draft_id IS NULL
              AND r.dispatch_state = 'pending' AND r.dispatch_generation = 0
          )
        )
        ${renderGuardSql}
        ${backfillGuardSql}
        ${priorChangeGuard}
    `).bind(
      input.nextConfig,
      input.nextObjectKey,
      input.nextRenderSetId,
      input.eventId,
      input.expectedRevision,
      input.expectedCurrentKey,
      input.expectedCurrentRenderSetId,
      input.semanticPublicationGuard?.operationId ?? null,
      input.semanticPublicationGuard?.operationId ?? null,
      input.semanticPublicationGuard?.requestSha256 ?? null,
      input.semanticPublicationGuard?.action ?? null,
      input.semanticPublicationGuard?.expectedRevision ?? null,
      ...ownerBindings,
    ),
    db.prepare(`
      INSERT INTO event_cover_retired_legacy_objects (
        id, event_id, object_key, key_fingerprint, reason, retired_at, cleanup_after
      )
      SELECT ?, ?, ?, ?, ?, ?, ?
      WHERE changes() = 1 AND ? IS NOT NULL AND ? IS NULL
    `).bind(
      crypto.randomUUID(),
      input.eventId,
      input.expectedCurrentKey,
      input.retiredKeyFingerprint,
      input.reason ?? (input.nextObjectKey === null ? 'removed' : 'replaced'),
      input.retiredAt,
      input.cleanupAfter,
      // A key was actually displaced...
      input.expectedCurrentKey,
      // ...and it was a legacy original rather than a normalized master, which
      // is what a non-null current render set would mean.
      input.expectedCurrentRenderSetId,
    ),
  ];
}

export class EventsRepository {
  constructor(private readonly db: D1Database) {}

  // Exposed as a statement so event creation can commit the event, its tokens, the
  // creator session, and any account ownership in one batch rather than a sequence
  // of writes a failure could tear in half.
  createStatement(input: CreateEventRecord): D1PreparedStatement {
    // `uploads_enabled = 1` is capability, not an open door: photo delivery is
    // permitted for this event, and `event_start_at` decides when it opens.
    // Written explicitly rather than taken from the column default, so the
    // default itself stays untouched and existing rows are unaffected.
    //
    // `rsvp_enabled = 0` still waits for a roster that has passed collision and
    // capacity validation. Nothing about that changes here.
    return this.db.prepare(`
      INSERT INTO events (
        id, slug, name, event_date, welcome_message, gallery_visible,
        uploads_enabled, rsvp_enabled, event_timezone, event_start_at, rsvp_deadline_at,
        guest_access_expires_at, management_access_expires_at, purge_after, created_at, theme_config
      ) VALUES (?, ?, ?, ?, ?, 0, 1, 0, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      input.id,
      input.slug,
      input.name,
      input.eventDate,
      input.welcomeMessage,
      input.eventTimezone,
      input.eventStartAt,
      input.rsvpDeadlineAt,
      input.guestAccessExpiresAt,
      input.managementAccessExpiresAt,
      input.purgeAfter,
      input.createdAt,
      input.themeConfig,
    );
  }

  async create(input: CreateEventRecord): Promise<EventRecord> {
    await this.createStatement(input).run();
    return (await this.getById(input.id))!;
  }

  async getById(id: string): Promise<EventRecord | null> {
    const row = await this.db.prepare('SELECT * FROM events WHERE id = ?').bind(id).first<EventRow>();
    return row ? mapEvent(row) : null;
  }

  async getBySlug(slug: string): Promise<EventRecord | null> {
    const row = await this.db.prepare('SELECT * FROM events WHERE slug = ?').bind(slug).first<EventRow>();
    return row ? mapEvent(row) : null;
  }

  /**
   * Applies every event setting in one guarded write.
   *
   * `expectedRosterVersion` is the version the caller validated the roster at,
   * not a number from the browser. If the roster moved in between, the write
   * changes nothing and the caller re-validates rather than opening RSVP
   * against a list that no longer exists.
   */
  async updateSettings(
    id: string,
    input: {
      name?: string;
      welcomeMessage?: string;
      galleryVisible: boolean;
      moderationRequired: boolean;
      eventTimezone: string;
      // Both instants are recomputed from the same date/time/zone tuple and
      // written together. Moving one without the other would let a time-zone
      // change push the deadline past the start.
      rsvpDeadlineAt: string;
      eventStartAt: string;
      rsvpEnabled: boolean;
      expectedRosterVersion: number;
    },
  ): Promise<EventRecord | null> {
    const result = await this.db.prepare(`
      UPDATE events SET
        name = COALESCE(?, name),
        welcome_message = COALESCE(?, welcome_message),
        gallery_visible = ?,
        moderation_required = ?,
        event_timezone = ?,
        rsvp_deadline_at = ?,
        -- A pause after the old start cannot survive a move back into the
        -- future: that would create the forbidden pre-start paused state and
        -- prevent the automatic opening at the new start. Restore capability
        -- only while printed entry is still live; the emergency stop wins.
        uploads_enabled = CASE
          WHEN uploads_enabled = 0
            AND ? > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            AND EXISTS (
              SELECT 1 FROM event_entry_credentials
              WHERE event_id = events.id AND disabled_at IS NULL
            )
          THEN 1
          ELSE uploads_enabled
        END,
        photos_open_from = CASE
          WHEN uploads_enabled = 0
            AND ? > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            AND EXISTS (
              SELECT 1 FROM event_entry_credentials
              WHERE event_id = events.id AND disabled_at IS NULL
            )
          THEN NULL
          ELSE photos_open_from
        END,
        event_start_at = ?,
        rsvp_enabled = ?
      WHERE id = ? AND deleted_at IS NULL AND rsvp_roster_version = ?
        -- Reopening RSVP is only legal while a printed entry is still enabled,
        -- and that has to be decided inside this statement: the route's earlier
        -- check is a read, and a settings write already in flight when the entry
        -- was disabled would otherwise commit against a stale answer.
        AND (
          ? = 0
          OR EXISTS (
            SELECT 1 FROM event_entry_credentials
            WHERE event_id = events.id AND disabled_at IS NULL
          )
        )
    `).bind(
      input.name ?? null,
      input.welcomeMessage ?? null,
      input.galleryVisible ? 1 : 0,
      input.moderationRequired ? 1 : 0,
      input.eventTimezone,
      input.rsvpDeadlineAt,
      input.eventStartAt,
      input.eventStartAt,
      input.eventStartAt,
      input.rsvpEnabled ? 1 : 0,
      id,
      input.expectedRosterVersion,
      input.rsvpEnabled ? 1 : 0,
    ).run();
    // Null rather than an exception: a lost race is an ordinary outcome here,
    // and the route turns it into guest-facing prose.
    if ((result.meta.changes ?? 0) !== 1) return null;
    return (await this.getById(id))!;
  }

  /**
   * Applies one photo-intake transition, or nothing.
   *
   * The legal transition is decided in SQL against the row as it stands, not
   * from a state a manager page read earlier: a page that loaded before the
   * event started must not be able to send a pre-start action after it. Each
   * statement therefore restates the whole precondition its state name implies.
   *
   * `open_early` stamps the server's own clock. No client timestamp is accepted
   * anywhere on this path.
   *
   * A pre-start pause clears `photos_open_from` and deliberately leaves
   * `uploads_enabled` alone. This is the load-bearing rule of the whole feature:
   * if it withdrew capability, a host who opened photos early and then thought
   * better of it would silently cancel the scheduled opening, and the event
   * would sit on `waiting` through its own reception.
   */
  async applyPhotoIntake(
    id: string,
    action: 'open_early' | 'return_to_schedule' | 'pause' | 'reopen',
    now = new Date(),
  ): Promise<EventRecord | null> {
    const nowIso = now.toISOString();
    // Reopening cannot outrank the irreversible printed-entry stop, and the
    // check belongs inside the statement for the same reason it does in
    // `updateSettings`.
    const entryOpen = `
      EXISTS (
        SELECT 1 FROM event_entry_credentials
        WHERE event_id = events.id AND disabled_at IS NULL
      )
    `;
    const statement = action === 'open_early'
      // Legal only from `scheduled`: permitted, before the start, and not
      // already opened early.
      ? this.db.prepare(`
          UPDATE events SET photos_open_from = ?
          WHERE id = ? AND deleted_at IS NULL
            AND event_start_at > ?
            AND uploads_enabled = 1
            AND photos_open_from IS NULL
            AND ${entryOpen}
        `).bind(nowIso, id, nowIso)
      : action === 'return_to_schedule'
        // Legal only from `open-early`. There is deliberately no pre-start
        // control that revokes capability; a host who wants photo delivery off
        // for the event does it after the start, when the effect is visible.
        ? this.db.prepare(`
            UPDATE events SET photos_open_from = NULL
            WHERE id = ? AND deleted_at IS NULL
              AND event_start_at > ?
              AND uploads_enabled = 1
              AND photos_open_from IS NOT NULL
          `).bind(id, nowIso)
        : action === 'pause'
          ? this.db.prepare(`
              UPDATE events SET uploads_enabled = 0
              WHERE id = ? AND deleted_at IS NULL
                AND event_start_at <= ?
                AND uploads_enabled = 1
            `).bind(id, nowIso)
          : this.db.prepare(`
              UPDATE events SET uploads_enabled = 1
              WHERE id = ? AND deleted_at IS NULL
                AND event_start_at <= ?
                AND uploads_enabled = 0
                AND ${entryOpen}
            `).bind(id, nowIso);

    const result = await statement.run();
    // Null rather than an exception: a stale or illegal transition is an
    // ordinary outcome, and the route turns it into "reload and try again".
    if ((result.meta.changes ?? 0) !== 1) return null;
    return (await this.getById(id))!;
  }

  async updateTheme(id: string, serializedTheme: string): Promise<EventRecord> {
    const result = await this.db.prepare(`
      UPDATE events
      SET theme_config = ?
      WHERE id = ? AND deleted_at IS NULL
    `).bind(serializedTheme, id).run();
    if ((result.meta.changes ?? 0) !== 1) {
      throw new Error('Event theme was not updated.');
    }
    return (await this.getById(id))!;
  }

  async setCover(id: string, objectKey: string | null): Promise<EventRecord> {
    const result = await this.db.prepare(`
      UPDATE events SET cover_object_key = ? WHERE id = ? AND deleted_at IS NULL
    `).bind(objectKey, id).run();
    if ((result.meta.changes ?? 0) !== 1) throw new Error('Event cover was not updated.');
    return (await this.getById(id))!;
  }
}

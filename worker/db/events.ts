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
  };
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

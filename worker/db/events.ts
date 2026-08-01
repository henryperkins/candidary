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
    // Both intakes are written off explicitly rather than left to a column
    // default. A new event opens nothing until the host has seen what it will
    // collect: RSVP waits for a validated roster, photos wait for the day.
    return this.db.prepare(`
      INSERT INTO events (
        id, slug, name, event_date, welcome_message, gallery_visible,
        uploads_enabled, rsvp_enabled, event_timezone, rsvp_deadline_at,
        guest_access_expires_at, management_access_expires_at, purge_after, created_at, theme_config
      ) VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      input.id,
      input.slug,
      input.name,
      input.eventDate,
      input.welcomeMessage,
      input.eventTimezone,
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
      uploadsEnabled: boolean;
      galleryVisible: boolean;
      moderationRequired: boolean;
      eventTimezone: string;
      rsvpDeadlineAt: string;
      rsvpEnabled: boolean;
      expectedRosterVersion: number;
    },
  ): Promise<EventRecord | null> {
    const result = await this.db.prepare(`
      UPDATE events SET
        name = COALESCE(?, name),
        welcome_message = COALESCE(?, welcome_message),
        uploads_enabled = ?,
        gallery_visible = ?,
        moderation_required = ?,
        event_timezone = ?,
        rsvp_deadline_at = ?,
        rsvp_enabled = ?
      WHERE id = ? AND deleted_at IS NULL AND rsvp_roster_version = ?
        -- Reopening either intake is only legal while a printed entry is still
        -- enabled, and that has to be decided inside this statement: the route's
        -- earlier check is a read, and a settings write already in flight when
        -- the entry was disabled would otherwise commit against a stale answer.
        AND (
          (? = 0 AND ? = 0)
          OR EXISTS (
            SELECT 1 FROM event_entry_credentials
            WHERE event_id = events.id AND disabled_at IS NULL
          )
        )
    `).bind(
      input.name ?? null,
      input.welcomeMessage ?? null,
      input.uploadsEnabled ? 1 : 0,
      input.galleryVisible ? 1 : 0,
      input.moderationRequired ? 1 : 0,
      input.eventTimezone,
      input.rsvpDeadlineAt,
      input.rsvpEnabled ? 1 : 0,
      id,
      input.expectedRosterVersion,
      input.uploadsEnabled ? 1 : 0,
      input.rsvpEnabled ? 1 : 0,
    ).run();
    // Null rather than an exception: a lost race is an ordinary outcome here,
    // and the route turns it into guest-facing prose.
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

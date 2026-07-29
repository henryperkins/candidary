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
  };
}

export class EventsRepository {
  constructor(private readonly db: D1Database) {}

  // Exposed as a statement so event creation can commit the event, its tokens, the
  // creator session, and any account ownership in one batch rather than a sequence
  // of writes a failure could tear in half.
  createStatement(input: CreateEventRecord): D1PreparedStatement {
    return this.db.prepare(`
      INSERT INTO events (
        id, slug, name, event_date, welcome_message, gallery_visible,
        guest_access_expires_at, management_access_expires_at, purge_after, created_at, theme_config
      ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
    `).bind(
      input.id,
      input.slug,
      input.name,
      input.eventDate,
      input.welcomeMessage,
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

  async updateSettings(
    id: string,
    input: {
      name?: string;
      welcomeMessage?: string;
      uploadsEnabled: boolean;
      galleryVisible: boolean;
      moderationRequired: boolean;
    },
  ): Promise<EventRecord> {
    const result = await this.db.prepare(`
      UPDATE events SET
        name = COALESCE(?, name),
        welcome_message = COALESCE(?, welcome_message),
        uploads_enabled = ?,
        gallery_visible = ?,
        moderation_required = ?
      WHERE id = ? AND deleted_at IS NULL
    `).bind(
      input.name ?? null,
      input.welcomeMessage ?? null,
      input.uploadsEnabled ? 1 : 0,
      input.galleryVisible ? 1 : 0,
      input.moderationRequired ? 1 : 0,
      id,
    ).run();
    if ((result.meta.changes ?? 0) !== 1) throw new Error('Event settings were not updated.');
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

  async setCover(id: string, objectKey: string): Promise<EventRecord> {
    const result = await this.db.prepare(`
      UPDATE events SET cover_object_key = ? WHERE id = ? AND deleted_at IS NULL
    `).bind(objectKey, id).run();
    if ((result.meta.changes ?? 0) !== 1) throw new Error('Event cover was not updated.');
    return (await this.getById(id))!;
  }
}

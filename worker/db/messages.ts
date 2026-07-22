import type { ModerationStatus } from '../../shared/contracts';

export interface CreateMessageRecord {
  id: string;
  eventId: string;
  guestSessionId: string;
  guestName: string | null;
  body: string;
  moderationStatus: ModerationStatus;
  createdAt: string;
}

export class MessagesRepository {
  constructor(private readonly db: D1Database) {}

  async create(input: CreateMessageRecord): Promise<void> {
    await this.db.prepare(`
      INSERT INTO guest_messages (
        id, event_id, guest_session_id, guest_name, body, moderation_status, created_at, approved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      input.id,
      input.eventId,
      input.guestSessionId,
      input.guestName,
      input.body,
      input.moderationStatus,
      input.createdAt,
      input.moderationStatus === 'approved' ? input.createdAt : null,
    ).run();
  }
}


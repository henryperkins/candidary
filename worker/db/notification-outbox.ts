type ScheduledKind = 'getting_started' | 'event_reminder' | 'retention_warning';

export class NotificationOutboxRepository {
  constructor(private readonly db: D1Database) {}

  scheduleStatements(input: {
    accountId: string | null;
    accountEmail?: string | null;
    eventId: string;
    createdAt: string;
    ownerCreatedAt: string;
  }): D1PreparedStatement[] {
    const prepare = (
      kind: ScheduledKind,
      availableSql: string,
      discardSql: string,
      scheduleBindings: unknown[],
    ) => this.db.prepare(`
      INSERT OR IGNORE INTO host_notification_outbox (
        id, account_id, event_id, kind, available_at, retry_at,
        discard_after, created_at, updated_at
      )
      SELECT ?, event_hosts.account_id, events.id, ?,
        ${availableSql}, ${availableSql},
        ${discardSql}, ?, ?
      FROM event_hosts
      JOIN events ON events.id = event_hosts.event_id
      WHERE event_hosts.event_id = ?
        AND event_hosts.account_id = COALESCE(
          ?,
          (SELECT id FROM host_accounts WHERE email = ?)
        )
        AND event_hosts.role = 'owner'
        AND event_hosts.created_at = ?
    `).bind(
      crypto.randomUUID(),
      kind,
      ...scheduleBindings,
      ...scheduleBindings,
      input.createdAt,
      input.createdAt,
      input.eventId,
      input.accountId,
      input.accountEmail ?? null,
      input.ownerCreatedAt,
    );

    return [
      prepare('getting_started', '?', 'NULL', [input.createdAt]),
      prepare(
        'event_reminder',
        "strftime('%Y-%m-%dT%H:%M:%fZ', events.event_date || 'T00:00:00.000Z', '-1 day')",
        "strftime('%Y-%m-%dT%H:%M:%fZ', events.event_date || 'T23:59:59.999Z')",
        [],
      ),
      prepare(
        'retention_warning',
        "strftime('%Y-%m-%dT%H:%M:%fZ', events.management_access_expires_at, '-7 days')",
        'events.management_access_expires_at',
        [],
      ),
    ];
  }
}

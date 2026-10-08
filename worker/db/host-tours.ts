import { HOST_EVENT_WELCOME_TOUR_KEY, type HostTourStateView } from '../../shared/contracts';

type TerminalStatus = Exclude<HostTourStateView['status'], 'unseen'>;

export class HostToursRepository {
  constructor(private readonly db: D1Database) {}

  async get(accountId: string, version: number): Promise<HostTourStateView> {
    const row = await this.db.prepare(`
      SELECT status FROM host_tours
      WHERE account_id = ? AND tour_key = ? AND version = ?
    `).bind(accountId, HOST_EVENT_WELCOME_TOUR_KEY, version).first<{ status: TerminalStatus }>();
    return {
      accountId, tourKey: HOST_EVENT_WELCOME_TOUR_KEY, version, status: row?.status ?? 'unseen',
    };
  }

  async setStatus(
    accountId: string,
    version: number,
    status: TerminalStatus,
    now: string,
  ): Promise<HostTourStateView> {
    // Terminal completion cannot be downgraded by an older tab's delayed Skip.
    // Duplicate writes leave both original timestamps intact.
    await this.db.prepare(`
      INSERT INTO host_tours (account_id, tour_key, version, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (account_id, tour_key, version) DO UPDATE
      SET status = excluded.status, updated_at = excluded.updated_at
      WHERE host_tours.status = 'dismissed' AND excluded.status = 'completed'
    `).bind(accountId, HOST_EVENT_WELCOME_TOUR_KEY, version, status, now, now).run();
    return this.get(accountId, version);
  }
}

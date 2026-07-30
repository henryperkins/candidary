import { digestSecret } from '../security/crypto';

// Two independent budgets guard the exact-name lookup. `lookup_ip` bounds how
// much one visitor may try in a window; `lookup_name` bounds how often any one
// invited name may be probed, so a distributed attempt cannot walk the roster.
export type RsvpLookupRateAction = 'lookup_ip' | 'lookup_name';

const WINDOW_MS = 15 * 60 * 1000;

export const RSVP_LOOKUP_RATE_WINDOW_MS = WINDOW_MS;
export const RSVP_LOOKUP_IP_LIMIT = 20;
export const RSVP_LOOKUP_NAME_LIMIT = 8;

export class RsvpRateLimitsRepository {
  constructor(
    private readonly db: D1Database,
    private readonly hmacKey: string,
  ) {}

  /**
   * Charges one attempt and reports whether it is still within budget.
   *
   * The row holds only a keyed digest, never the address or the name that was
   * submitted, so this table cannot be read back into a guest list. Attempts
   * keep counting past the limit on purpose: continued probing extends the
   * refusal rather than resetting it.
   */
  async reserve(input: {
    eventId: string;
    action: RsvpLookupRateAction;
    normalizedValue: string;
    limit: number;
    now?: Date;
  }): Promise<boolean> {
    const now = input.now ?? new Date();
    const windowStartedAt = new Date(
      Math.floor(now.getTime() / WINDOW_MS) * WINDOW_MS,
    ).toISOString();
    const scopeDigest = await digestSecret(
      `rsvp-lookup:v1:${input.action}:${input.eventId}:${input.normalizedValue}`,
      this.hmacKey,
    );
    const row = await this.db.prepare(`
      INSERT INTO rsvp_lookup_rate_limits (
        event_id, action, scope_digest, window_started_at, attempts
      ) VALUES (?, ?, ?, ?, 1)
      ON CONFLICT (event_id, action, scope_digest, window_started_at)
      DO UPDATE SET attempts = rsvp_lookup_rate_limits.attempts + 1
      RETURNING attempts
    `).bind(input.eventId, input.action, scopeDigest, windowStartedAt)
      .first<{ attempts: number }>();
    return Boolean(row && row.attempts <= input.limit);
  }
}

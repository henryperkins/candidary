import { digestSecret } from '../security/crypto';

export type AuthRateLimitAction =
  | 'registration'
  | 'registration_resend'
  | 'login'
  | 'verification_resend'
  | 'password_reset_request';

export type AuthRateLimitScopeKind = 'ip' | 'email' | 'account' | 'pending_registration';

const WINDOW_MS = 15 * 60 * 1000;

export class AuthRateLimitsRepository {
  constructor(
    private readonly db: D1Database,
    private readonly hmacKey: string,
  ) {}

  async reserve(input: {
    action: AuthRateLimitAction;
    scopeKind: AuthRateLimitScopeKind;
    normalizedValue: string;
    limit: number;
    now?: Date;
  }): Promise<boolean> {
    const now = input.now ?? new Date();
    const windowStartedAt = new Date(
      Math.floor(now.getTime() / WINDOW_MS) * WINDOW_MS,
    ).toISOString();
    const scopeDigest = await digestSecret(
      `rate-limit:${input.action}:${input.scopeKind}:${input.normalizedValue}`,
      this.hmacKey,
    );
    const row = await this.db.prepare(`
      INSERT INTO host_auth_rate_limits (
        scope_digest, action, window_started_at, attempts
      ) VALUES (?, ?, ?, 1)
      ON CONFLICT (scope_digest, action, window_started_at)
      DO UPDATE SET attempts = host_auth_rate_limits.attempts + 1
      RETURNING attempts
    `).bind(scopeDigest, input.action, windowStartedAt).first<{ attempts: number }>();
    return Boolean(row && row.attempts <= input.limit);
  }
}

export const AUTH_RATE_LIMIT_WINDOW_MS = WINDOW_MS;

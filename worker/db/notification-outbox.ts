type ScheduledKind = 'getting_started' | 'event_reminder' | 'retention_warning';

// Long enough that an ordinary send cannot outlive it, short enough that a dead
// isolate does not strand a message for the rest of the day.
export const OUTBOX_LEASE_MS = 10 * 60 * 1000;

// Backoff for transient provider failures. The fifth failed attempt is terminal:
// a message still failing a day later is not going to succeed by repetition.
const RETRY_DELAYS_MS = [5 * 60 * 1000, 60 * 60 * 1000, 6 * 60 * 60 * 1000, 24 * 60 * 60 * 1000];
export const OUTBOX_MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

// Everything the dispatcher renders from, loaded in one explicit-column join so a
// page of messages costs one query rather than one per row.
export interface ClaimedOutboxRow {
  id: string;
  kind: ScheduledKind;
  attemptCount: number;
  discardAfter: string | null;
  accountId: string;
  email: string;
  notificationsEnabled: boolean;
  emailVerified: boolean;
  accountDisabled: boolean;
  eventId: string;
  eventName: string;
  eventDate: string;
  guestAccessExpiresAt: string;
  managementAccessExpiresAt: string;
  purgeAfter: string;
  eventDeleted: boolean;
}

interface ClaimedRow {
  id: string;
  kind: ScheduledKind;
  attempt_count: number;
  discard_after: string | null;
  account_id: string;
  email: string;
  notifications_enabled: number;
  email_verified_at: string | null;
  disabled_at: string | null;
  event_id: string;
  event_name: string;
  event_date: string;
  guest_access_expires_at: string;
  management_access_expires_at: string;
  purge_after: string;
  deleted_at: string | null;
}

export class NotificationOutboxRepository {
  constructor(private readonly db: D1Database) {}

  // Returns expired leases to the pool before anything is claimed, so a worker that
  // died mid-send does not hold its rows until the next scheduled run.
  async reclaimExpired(now: string): Promise<number> {
    const result = await this.db.prepare(`
      UPDATE host_notification_outbox
      SET status = 'pending', claim_token = NULL, claimed_at = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE status = 'sending' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
    `).bind(now, now).run();
    return result.meta.changes ?? 0;
  }

  // One conditional UPDATE under one token. Two dispatchers racing cannot claim the
  // same row because the second only matches rows still marked pending.
  async claimDue(now: string, limit: number, claimToken: string): Promise<number> {
    const leaseExpiresAt = new Date(Date.parse(now) + OUTBOX_LEASE_MS).toISOString();
    const result = await this.db.prepare(`
      UPDATE host_notification_outbox
      SET status = 'sending', claim_token = ?, claimed_at = ?, lease_expires_at = ?, updated_at = ?
      WHERE id IN (
        SELECT id FROM host_notification_outbox
        WHERE status = 'pending' AND retry_at <= ?
        ORDER BY retry_at, id
        LIMIT ?
      )
    `).bind(claimToken, now, leaseExpiresAt, now, now, limit).run();
    return result.meta.changes ?? 0;
  }

  async loadClaim(claimToken: string): Promise<ClaimedOutboxRow[]> {
    const { results } = await this.db.prepare(`
      SELECT
        outbox.id AS id, outbox.kind AS kind, outbox.attempt_count AS attempt_count,
        outbox.discard_after AS discard_after,
        accounts.id AS account_id, accounts.email AS email,
        accounts.notifications_enabled AS notifications_enabled,
        accounts.email_verified_at AS email_verified_at, accounts.disabled_at AS disabled_at,
        events.id AS event_id, events.name AS event_name, events.event_date AS event_date,
        events.guest_access_expires_at AS guest_access_expires_at,
        events.management_access_expires_at AS management_access_expires_at,
        events.purge_after AS purge_after, events.deleted_at AS deleted_at
      FROM host_notification_outbox AS outbox
      JOIN host_accounts AS accounts ON accounts.id = outbox.account_id
      JOIN events ON events.id = outbox.event_id
      WHERE outbox.claim_token = ? AND outbox.status = 'sending'
      ORDER BY outbox.id
    `).bind(claimToken).all<ClaimedRow>();

    return results.map((row) => ({
      id: row.id,
      kind: row.kind,
      attemptCount: row.attempt_count,
      discardAfter: row.discard_after,
      accountId: row.account_id,
      email: row.email,
      notificationsEnabled: row.notifications_enabled === 1,
      emailVerified: row.email_verified_at !== null,
      accountDisabled: row.disabled_at !== null,
      eventId: row.event_id,
      eventName: row.event_name,
      eventDate: row.event_date,
      guestAccessExpiresAt: row.guest_access_expires_at,
      managementAccessExpiresAt: row.management_access_expires_at,
      purgeAfter: row.purge_after,
      eventDeleted: row.deleted_at !== null,
    }));
  }

  // This conditional update is the durable send permit. Eligibility is decided
  // from live account and event state immediately before the provider call, not
  // from the data snapshot used to render the claimed page.
  async authorizeClaimedDelivery(
    id: string,
    claimToken: string,
    now: string,
  ): Promise<{ status: 'authorized' } | { status: 'retired'; reason: string } | null> {
    const row = await this.db.prepare(`
      WITH decision AS (
        SELECT CASE
          WHEN accounts.disabled_at IS NOT NULL THEN 'account_disabled'
          WHEN accounts.email_verified_at IS NULL THEN 'address_unverified'
          WHEN accounts.notifications_enabled = 0 THEN 'suppressed_by_preference'
          WHEN events.deleted_at IS NOT NULL THEN 'event_deleted'
          WHEN host_notification_outbox.discard_after IS NOT NULL
            AND host_notification_outbox.discard_after <= ? THEN 'obsolete'
          ELSE NULL
        END AS reason
        FROM host_notification_outbox
        JOIN host_accounts AS accounts ON accounts.id = host_notification_outbox.account_id
        JOIN events ON events.id = host_notification_outbox.event_id
        WHERE host_notification_outbox.id = ?
      )
      UPDATE host_notification_outbox
      SET status = CASE WHEN (SELECT reason FROM decision) IS NULL THEN status ELSE 'failed' END,
        last_error_code = CASE
          WHEN (SELECT reason FROM decision) IS NULL THEN last_error_code
          ELSE (SELECT reason FROM decision)
        END,
        claim_token = CASE WHEN (SELECT reason FROM decision) IS NULL THEN claim_token ELSE NULL END,
        claimed_at = CASE WHEN (SELECT reason FROM decision) IS NULL THEN claimed_at ELSE NULL END,
        lease_expires_at = CASE WHEN (SELECT reason FROM decision) IS NULL THEN lease_expires_at ELSE NULL END,
        updated_at = CASE WHEN (SELECT reason FROM decision) IS NULL THEN updated_at ELSE ? END
      WHERE id = ?
        AND status = 'sending'
        AND claim_token = ?
        AND lease_expires_at > ?
      RETURNING status, last_error_code
    `).bind(now, id, now, id, claimToken, now).first<{
      status: 'sending' | 'failed';
      last_error_code: string | null;
    }>();
    if (!row) return null;
    if (row.status === 'sending') return { status: 'authorized' };
    return { status: 'retired', reason: row.last_error_code! };
  }

  // Every outcome write is fenced by the claim token, so a worker whose lease was
  // reclaimed cannot overwrite the result of the worker that took over.
  async markSent(id: string, claimToken: string, now: string): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE host_notification_outbox
      SET status = 'sent', sent_at = ?, attempt_count = attempt_count + 1,
        claim_token = NULL, claimed_at = NULL, lease_expires_at = NULL,
        last_error_code = NULL, updated_at = ?
      WHERE id = ? AND status = 'sending' AND claim_token = ?
    `).bind(now, now, id, claimToken).run();
    return (result.meta.changes ?? 0) > 0;
  }

  // A row that will never be worth sending — opted out, unverified, disabled,
  // deleted, or past the deadline it describes — is retired with a non-sensitive
  // reason rather than delivered.
  async retire(id: string, claimToken: string, code: string, now: string): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE host_notification_outbox
      SET status = 'failed', last_error_code = ?, claim_token = NULL, claimed_at = NULL,
        lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'sending' AND claim_token = ?
    `).bind(code, now, id, claimToken).run();
    return (result.meta.changes ?? 0) > 0;
  }

  // A row retired only because the address was unconfirmed describes a message the
  // host still wants. Confirming the address is exactly the condition that was
  // missing, so the row returns to the queue rather than staying terminal.
  async reviveUnverified(accountId: string, now: string): Promise<number> {
    const result = await this.db.prepare(`
      UPDATE host_notification_outbox
      SET status = 'pending', retry_at = ?, last_error_code = NULL, updated_at = ?
      WHERE account_id = ? AND status = 'failed' AND last_error_code = 'address_unverified'
    `).bind(now, now, accountId).run();
    return result.meta.changes ?? 0;
  }

  async retryOrFail(
    id: string,
    claimToken: string,
    code: string,
    attemptCount: number,
    now: string,
  ): Promise<'pending' | 'failed'> {
    const nextAttempt = attemptCount + 1;
    const delay = RETRY_DELAYS_MS[attemptCount];
    if (nextAttempt >= OUTBOX_MAX_ATTEMPTS || delay === undefined) {
      await this.db.prepare(`
        UPDATE host_notification_outbox
        SET status = 'failed', attempt_count = ?, last_error_code = ?, claim_token = NULL,
          claimed_at = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'sending' AND claim_token = ?
      `).bind(nextAttempt, code, now, id, claimToken).run();
      return 'failed';
    }
    await this.db.prepare(`
      UPDATE host_notification_outbox
      SET status = 'pending', attempt_count = ?, retry_at = ?, last_error_code = ?,
        claim_token = NULL, claimed_at = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'sending' AND claim_token = ?
    `).bind(
      nextAttempt,
      new Date(Date.parse(now) + delay).toISOString(),
      code,
      now,
      id,
      claimToken,
    ).run();
    return 'pending';
  }

  scheduleStatements(input: {
    accountId: string | null;
    accountEmail?: string | null;
    eventId: string;
    createdAt: string;
    ownerCreatedAt: string;
  }, activationGuard?: { challengeId: string; activationNonce: string }): D1PreparedStatement[] {
    const activationGuardSql = activationGuard ? `
        AND EXISTS (
          SELECT 1 FROM host_registration_challenges
          WHERE id = ? AND activation_nonce = ?
        )` : '';
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
        ${activationGuardSql}
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
      ...(activationGuard ? [activationGuard.challengeId, activationGuard.activationNonce] : []),
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

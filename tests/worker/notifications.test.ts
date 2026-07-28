import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AccountsRepository } from '../../worker/db/accounts';
import { NotificationOutboxRepository } from '../../worker/db/notification-outbox';
import { EmailService } from '../../worker/services/email';
import { NotificationService } from '../../worker/services/notifications';
import { eventAccess, resetDatabase, testEnv } from './helpers';

const DAY_MS = 24 * 60 * 60 * 1000;

async function hostedEvent(options: {
  email?: string;
  eventDate?: string;
  managementExpiresAt?: string;
  verified?: boolean;
  notifications?: boolean;
} = {}) {
  const access = await eventAccess(`Event ${options.email ?? 'host@example.com'}`);
  const accounts = new AccountsRepository(env.DB);
  const now = new Date().toISOString();
  const account = (await accounts.create({
    email: options.email ?? 'host@example.com',
    passwordHash: 'scrypt$32768$8$3$c2FsdA$aGFzaA',
    displayName: null,
    createdAt: now,
  }))!;
  await accounts.addEventHost(access.event.id, account.id, 'owner', now);
  if (options.verified !== false) await accounts.markEmailVerified(account.id, now);
  if (options.notifications === false) await accounts.setNotificationsEnabled(account.id, false);

  if (options.eventDate || options.managementExpiresAt) {
    await env.DB.prepare(`
      UPDATE events SET event_date = COALESCE(?, event_date),
        management_access_expires_at = COALESCE(?, management_access_expires_at)
      WHERE id = ?
    `).bind(options.eventDate ?? null, options.managementExpiresAt ?? null, access.event.id).run();
  }
  return { account, eventId: access.event.id };
}

function inDays(days: number): string {
  return new Date(Date.now() + days * DAY_MS).toISOString();
}

async function sentKinds(): Promise<string[]> {
  const { results } = await env.DB.prepare('SELECT kind FROM host_notifications ORDER BY kind')
    .all<{ kind: string }>();
  return results.map((row) => row.kind);
}

beforeEach(resetDatabase);

describe('lifecycle notifications', () => {
  it('reminds a host the day before the event', async () => {
    await hostedEvent({ eventDate: new Date(Date.now() + DAY_MS).toISOString().slice(0, 10) });

    const result = await new NotificationService(testEnv).run();

    expect(result.reminders).toBe(1);
    expect(await sentKinds()).toEqual(['event_reminder']);
  });

  it('does not remind a host whose event is not tomorrow', async () => {
    await hostedEvent({ eventDate: new Date(Date.now() + 5 * DAY_MS).toISOString().slice(0, 10) });

    expect((await new NotificationService(testEnv).run()).reminders).toBe(0);
    expect(await sentKinds()).toEqual([]);
  });

  it('warns before management access ends, not before the purge date', async () => {
    await hostedEvent({ managementExpiresAt: inDays(6.5) });

    const result = await new NotificationService(testEnv).run();

    expect(result.warnings).toBe(1);
    expect(await sentKinds()).toEqual(['retention_warning']);
  });

  it('sends each notification once however often the cron runs', async () => {
    await hostedEvent({ managementExpiresAt: inDays(6.5) });

    const first = await new NotificationService(testEnv).run();
    const second = await new NotificationService(testEnv).run();
    const third = await new NotificationService(testEnv).run();

    expect(first.warnings).toBe(1);
    expect(second.warnings).toBe(0);
    expect(third.warnings).toBe(0);
    expect(await sentKinds()).toEqual(['retention_warning']);
  });

  it('skips a host who has not confirmed their address', async () => {
    await hostedEvent({ managementExpiresAt: inDays(6.5), verified: false });

    expect((await new NotificationService(testEnv).run()).warnings).toBe(0);
    expect(await sentKinds()).toEqual([]);
  });

  it('skips a host who unsubscribed', async () => {
    await hostedEvent({ managementExpiresAt: inDays(6.5), notifications: false });

    expect((await new NotificationService(testEnv).run()).warnings).toBe(0);
    expect(await sentKinds()).toEqual([]);
  });

  it('skips a deleted event', async () => {
    const { eventId } = await hostedEvent({ managementExpiresAt: inDays(6.5) });
    await env.DB.prepare('UPDATE events SET deleted_at = ? WHERE id = ?')
      .bind(new Date().toISOString(), eventId).run();

    expect((await new NotificationService(testEnv).run()).warnings).toBe(0);
  });

  it('sends the getting-started message only after the address is confirmed', async () => {
    const unverified = await hostedEvent({ email: 'new@example.com', verified: false });
    const accounts = new AccountsRepository(env.DB);
    const service = new NotificationService(testEnv);
    const event = (await accounts.listEventsForAccount(unverified.account.id))[0]!;

    expect(await service.sendGettingStarted(unverified.account, event)).toBe(false);

    await accounts.markEmailVerified(unverified.account.id, new Date().toISOString());
    const confirmed = (await accounts.getById(unverified.account.id))!;
    expect(await service.sendGettingStarted(confirmed, event)).toBe(true);
    expect(await sentKinds()).toEqual(['getting_started']);
  });
});

describe('durable notification outbox', () => {
  // Spies on the email boundary are per-test; without this a later assertion sees
  // the call counts of every test before it.
  beforeEach(() => { vi.restoreAllMocks(); });

  // Rows are inserted directly so each test pins one scheduling state exactly,
  // rather than depending on whatever the claim path happened to schedule.
  async function outboxRow(input: {
    accountId: string;
    eventId: string;
    kind?: string;
    availableAt?: string;
    status?: string;
    claimToken?: string | null;
    leaseExpiresAt?: string | null;
    discardAfter?: string | null;
  }) {
    const id = crypto.randomUUID();
    const at = input.availableAt ?? new Date(Date.now() - 1000).toISOString();
    await env.DB.prepare(`
      INSERT INTO host_notification_outbox (
        id, account_id, event_id, kind, status, available_at, retry_at, discard_after,
        claimed_at, claim_token, lease_expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id, input.accountId, input.eventId, input.kind ?? 'getting_started',
      input.status ?? 'pending', at, at, input.discardAfter ?? null,
      input.claimToken ? at : null, input.claimToken ?? null, input.leaseExpiresAt ?? null,
      at, at,
    ).run();
    return id;
  }

  async function stateOf(id: string) {
    return env.DB.prepare(`
      SELECT status, attempt_count, claim_token, last_error_code FROM host_notification_outbox WHERE id = ?
    `).bind(id).first<{ status: string; attempt_count: number; claim_token: string | null; last_error_code: string | null }>();
  }

  function failSendOnce() {
    let calls = 0;
    return vi.spyOn(EmailService.prototype, 'send').mockImplementation(async () => {
      calls += 1;
      return calls === 1 ? { delivered: false, code: 'temporary_failure' } : { delivered: true };
    });
  }

  it('retains a failed message as pending and sends it on the next run', async () => {
    const { account, eventId } = await hostedEvent();
    const id = await outboxRow({ accountId: account.id, eventId });
    failSendOnce();

    await new NotificationService(testEnv).dispatchPending(new Date());
    expect(await stateOf(id)).toMatchObject({ status: 'pending', attempt_count: 1 });
    // The retry is scheduled into the future, so it only becomes due later.
    await env.DB.prepare("UPDATE host_notification_outbox SET retry_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), id).run();

    await new NotificationService(testEnv).dispatchPending(new Date());
    expect(await stateOf(id)).toMatchObject({ status: 'sent', attempt_count: 2 });
  });

  it('continues delivering after one recipient fails', async () => {
    const first = await hostedEvent({ email: 'one@example.com' });
    const second = await hostedEvent({ email: 'two@example.com' });
    const third = await hostedEvent({ email: 'three@example.com' });
    await outboxRow({ accountId: first.account.id, eventId: first.eventId });
    await outboxRow({ accountId: second.account.id, eventId: second.eventId });
    await outboxRow({ accountId: third.account.id, eventId: third.eventId });

    let call = 0;
    vi.spyOn(EmailService.prototype, 'send').mockImplementation(async () => {
      call += 1;
      return call === 2 ? { delivered: false, code: 'temporary_failure' } : { delivered: true };
    });

    expect(await new NotificationService(testEnv).dispatchPending(new Date()))
      .toMatchObject({ sent: 2, retried: 1 });
  });

  it('claims no more than the fixed batch in one run', async () => {
    // One row per event: the outbox is unique per account, event, and kind, so a
    // batch of seven means seven events.
    for (let index = 0; index < 7; index += 1) {
      const hosted = await hostedEvent({ email: `host${index}@example.com` });
      await outboxRow({ accountId: hosted.account.id, eventId: hosted.eventId });
    }
    vi.spyOn(EmailService.prototype, 'send').mockResolvedValue({ delivered: true });

    const result = await new NotificationService(testEnv).dispatchPending(new Date(), 3);
    expect(result.sent).toBe(3);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM host_notification_outbox WHERE status = 'pending'")
      .first('count')).toBe(4);
  });

  it('keeps a run that was missed entirely still eligible', async () => {
    const { account, eventId } = await hostedEvent();
    // Due three days ago and never picked up: a fixed one-run window would have
    // dropped it, an outbox must not.
    const id = await outboxRow({ accountId: account.id, eventId, availableAt: inDays(-3) });
    vi.spyOn(EmailService.prototype, 'send').mockResolvedValue({ delivered: true });

    await new NotificationService(testEnv).dispatchPending(new Date());
    expect(await stateOf(id)).toMatchObject({ status: 'sent' });
  });

  it('reclaims a lease whose worker died and fences out its old token', async () => {
    const { account, eventId } = await hostedEvent();
    const id = await outboxRow({
      accountId: account.id, eventId, status: 'sending',
      claimToken: 'dead-worker-token',
      leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    vi.spyOn(EmailService.prototype, 'send').mockResolvedValue({ delivered: true });

    await new NotificationService(testEnv).dispatchPending(new Date());
    const after = await stateOf(id);
    expect(after).toMatchObject({ status: 'sent' });
    expect(after!.claim_token).not.toBe('dead-worker-token');

    // The dead worker waking up late must not be able to overwrite the result.
    const outbox = new NotificationOutboxRepository(env.DB);
    expect(await outbox.markSent(id, 'dead-worker-token', new Date().toISOString())).toBe(false);
    expect(await stateOf(id)).toMatchObject({ status: 'sent' });
  });

  it('retires a row for an opted-out account without sending it', async () => {
    const { account, eventId } = await hostedEvent({ notifications: false });
    const id = await outboxRow({ accountId: account.id, eventId });
    const send = vi.spyOn(EmailService.prototype, 'send').mockResolvedValue({ delivered: true });

    await new NotificationService(testEnv).dispatchPending(new Date());
    expect(send).not.toHaveBeenCalled();
    expect(await stateOf(id)).toMatchObject({ status: 'failed', last_error_code: 'suppressed_by_preference' });
  });

  it('retires a reminder that is already obsolete rather than sending it late', async () => {
    const { account, eventId } = await hostedEvent();
    const id = await outboxRow({
      accountId: account.id, eventId, kind: 'event_reminder',
      availableAt: inDays(-5), discardAfter: inDays(-2),
    });
    const send = vi.spyOn(EmailService.prototype, 'send').mockResolvedValue({ delivered: true });

    await new NotificationService(testEnv).dispatchPending(new Date());
    expect(send).not.toHaveBeenCalled();
    expect(await stateOf(id)).toMatchObject({ status: 'failed', last_error_code: 'obsolete' });
  });
});

import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AccountsRepository } from '../../worker/db/accounts';
import { NotificationOutboxRepository } from '../../worker/db/notification-outbox';
import { EmailService } from '../../worker/services/email';
import { NotificationService } from '../../worker/services/notifications';
import worker from '../../worker/index';
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

beforeEach(resetDatabase);

describe('lifecycle scheduling', () => {
  // The scan these replace is gone: eligibility now comes from the outbox row that
  // ownership commits, not from a nightly window query.
  it('schedules exactly one row per kind when a host takes ownership', async () => {
    const access = await eventAccess('Scheduled Event');
    const accounts = new AccountsRepository(env.DB);
    const now = new Date().toISOString();
    const account = (await accounts.create({
      email: 'host@example.com',
      passwordHash: 'scrypt$32768$8$3$c2FsdA$aGFzaA',
      displayName: null,
      createdAt: now,
    }))!;
    const session = await env.DB.prepare(
      "SELECT id FROM event_sessions WHERE event_id = ? AND role = 'manager'",
    ).bind(access.event.id).first<{ id: string }>();

    expect(await accounts.claimInitialOwnerAndSchedule(
      access.event.id, account.id, session!.id, now,
    )).toBe('claimed');

    const { results } = await env.DB.prepare(
      'SELECT kind, available_at, discard_after FROM host_notification_outbox WHERE event_id = ? ORDER BY kind',
    ).bind(access.event.id).all<{ kind: string; available_at: string; discard_after: string | null }>();
    expect(results.map((row) => row.kind))
      .toEqual(['event_reminder', 'getting_started', 'retention_warning']);

    const reminder = results.find((row) => row.kind === 'event_reminder')!;
    const event = await env.DB.prepare('SELECT event_date, management_access_expires_at FROM events WHERE id = ?')
      .bind(access.event.id).first<{ event_date: string; management_access_expires_at: string }>();
    // The day before the event, and discarded once the event day is over.
    expect(reminder.available_at.slice(0, 10)).toBe(
      new Date(Date.parse(`${event!.event_date}T00:00:00.000Z`) - DAY_MS).toISOString().slice(0, 10),
    );
    expect(reminder.discard_after!.slice(0, 10)).toBe(event!.event_date);

    const warning = results.find((row) => row.kind === 'retention_warning')!;
    expect(warning.discard_after).toBe(event!.management_access_expires_at);
    expect(Date.parse(warning.available_at))
      .toBe(Date.parse(event!.management_access_expires_at) - 7 * DAY_MS);
  });
});

describe('durable notification outbox', () => {
  // Spies on the email boundary are per-test; without this a later assertion sees
  // the call counts of every test before it.
  beforeEach(() => { vi.restoreAllMocks(); });

  // Rows are inserted directly so each test pins one scheduling state exactly,
  // rather than depending on whatever the claim path happened to schedule.
  async function outboxRow(input: {
    id?: string;
    accountId: string;
    eventId: string;
    kind?: string;
    availableAt?: string;
    status?: string;
    claimToken?: string | null;
    leaseExpiresAt?: string | null;
    discardAfter?: string | null;
  }) {
    const id = input.id ?? crypto.randomUUID();
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
      SELECT status, attempt_count, claim_token, claimed_at, lease_expires_at, last_error_code
      FROM host_notification_outbox WHERE id = ?
    `).bind(id).first<{
      status: string;
      attempt_count: number;
      claim_token: string | null;
      claimed_at: string | null;
      lease_expires_at: string | null;
      last_error_code: string | null;
    }>();
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

  it('does not call the provider after a loaded claim loses its live lease', async () => {
    const { account, eventId } = await hostedEvent();
    const id = await outboxRow({ accountId: account.id, eventId });
    const authorization = new NotificationOutboxRepository(env.DB);
    const authorizeClaimedDelivery = authorization.authorizeClaimedDelivery.bind(authorization);
    vi.spyOn(NotificationOutboxRepository.prototype, 'authorizeClaimedDelivery')
      .mockImplementationOnce(async (rowId, claimToken, authorizationTime) => {
        await env.DB.prepare(`
          UPDATE host_notification_outbox SET lease_expires_at = ? WHERE id = ?
        `).bind(authorizationTime, rowId).run();
        return authorizeClaimedDelivery(rowId, claimToken, authorizationTime);
      });
    const send = vi.spyOn(EmailService.prototype, 'send').mockResolvedValue({ delivered: true });

    expect(await new NotificationService(testEnv).dispatchPending(new Date()))
      .toEqual({ sent: 0, retried: 0, retired: 0 });

    expect(send).not.toHaveBeenCalled();
    expect(await stateOf(id)).toMatchObject({
      status: 'sending',
      claim_token: expect.any(String),
      lease_expires_at: expect.any(String),
    });
  });

  it('retires a row for an opted-out account without sending it', async () => {
    const { account, eventId } = await hostedEvent({ notifications: false });
    const id = await outboxRow({ accountId: account.id, eventId });
    const send = vi.spyOn(EmailService.prototype, 'send').mockResolvedValue({ delivered: true });

    await new NotificationService(testEnv).dispatchPending(new Date());
    expect(send).not.toHaveBeenCalled();
    expect(await stateOf(id)).toMatchObject({ status: 'failed', last_error_code: 'suppressed_by_preference' });
  });

  it('backs off on repeated failures and gives up on the fifth attempt', async () => {
    const { account, eventId } = await hostedEvent();
    const id = await outboxRow({ accountId: account.id, eventId });
    vi.spyOn(EmailService.prototype, 'send')
      .mockResolvedValue({ delivered: false, code: 'temporary_failure' });

    const seen: number[] = [];
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await new NotificationService(testEnv).dispatchPending(new Date());
      const row = await env.DB.prepare(
        'SELECT attempt_count, status, retry_at FROM host_notification_outbox WHERE id = ?',
      ).bind(id).first<{ attempt_count: number; status: string; retry_at: string }>();
      seen.push(row!.attempt_count);
      if (attempt < 5) {
        expect(row!.status).toBe('pending');
        // Force it due again so the next pass exercises the following delay rather
        // than the backoff simply parking the row out of reach.
        await env.DB.prepare('UPDATE host_notification_outbox SET retry_at = ? WHERE id = ?')
          .bind(new Date(Date.now() - 1000).toISOString(), id).run();
      }
    }

    expect(seen).toEqual([1, 2, 3, 4, 5]);
    expect(await stateOf(id)).toMatchObject({ status: 'failed', attempt_count: 5 });
  });

  it('retires rows for disabled and unverified accounts without sending', async () => {
    const disabled = await hostedEvent({ email: 'disabled@example.com' });
    const unverified = await hostedEvent({ email: 'unverified@example.com', verified: false });
    await env.DB.prepare('UPDATE host_accounts SET disabled_at = ? WHERE id = ?')
      .bind(new Date().toISOString(), disabled.account.id).run();
    const disabledId = await outboxRow({ accountId: disabled.account.id, eventId: disabled.eventId });
    const unverifiedId = await outboxRow({ accountId: unverified.account.id, eventId: unverified.eventId });
    const send = vi.spyOn(EmailService.prototype, 'send').mockResolvedValue({ delivered: true });

    await new NotificationService(testEnv).dispatchPending(new Date());

    expect(send).not.toHaveBeenCalled();
    expect(await stateOf(disabledId)).toMatchObject({ status: 'failed', last_error_code: 'account_disabled' });
    expect(await stateOf(unverifiedId)).toMatchObject({ status: 'failed', last_error_code: 'address_unverified' });
  });

  it('defaults the claim to one hundred rows when no limit is given', async () => {
    // Pins the documented bound itself, not merely that an explicitly passed limit
    // is honoured — the two are different guarantees.
    const { account, eventId } = await hostedEvent();
    await outboxRow({ accountId: account.id, eventId });
    const claimed: number[] = [];
    const outbox = new NotificationOutboxRepository(env.DB);
    const original = outbox.claimDue.bind(outbox);
    vi.spyOn(NotificationOutboxRepository.prototype, 'claimDue')
      .mockImplementation(async function (this: NotificationOutboxRepository, now, limit, token) {
        claimed.push(limit);
        return original.call(this, now, limit, token);
      } as typeof outbox.claimDue);
    vi.spyOn(EmailService.prototype, 'send').mockResolvedValue({ delivered: true });

    await new NotificationService(testEnv).dispatchPending(new Date());

    expect(claimed).toEqual([100]);
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

  it('finishes a permitted send but denies the next row after opt-out commits', async () => {
    const first = await hostedEvent({ email: 'host@example.com' });
    const second = await eventAccess('Second Event');
    const accounts = new AccountsRepository(env.DB);
    await accounts.addEventHost(
      second.event.id,
      first.account.id,
      'owner',
      new Date().toISOString(),
    );
    const firstId = await outboxRow({
      id: 'outbox-a',
      accountId: first.account.id,
      eventId: first.eventId,
    });
    const secondId = await outboxRow({
      id: 'outbox-b',
      accountId: first.account.id,
      eventId: second.event.id,
    });
    const authorization = new NotificationOutboxRepository(env.DB);
    const authorizeClaimedDelivery = authorization.authorizeClaimedDelivery.bind(authorization);
    vi.spyOn(NotificationOutboxRepository.prototype, 'authorizeClaimedDelivery')
      .mockImplementation(async (rowId, claimToken, authorizationTime) => {
        const permit = await authorizeClaimedDelivery(rowId, claimToken, authorizationTime);
        if (rowId === firstId && permit?.status === 'authorized') {
          await accounts.setNotificationsEnabled(first.account.id, false);
        }
        return permit;
      });
    const send = vi.spyOn(EmailService.prototype, 'send').mockResolvedValue({ delivered: true });

    expect(await new NotificationService(testEnv).dispatchPending(new Date()))
      .toEqual({ sent: 1, retried: 0, retired: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: 'host@example.com' }));
    expect(await stateOf(firstId)).toMatchObject({ status: 'sent' });
    expect(await stateOf(secondId)).toMatchObject({
      status: 'failed', last_error_code: 'suppressed_by_preference',
      claim_token: null, claimed_at: null, lease_expires_at: null,
    });
  });

  it('retires a claimed row that becomes obsolete before its provider call', async () => {
    const { account, eventId } = await hostedEvent();
    const current = Date.now();
    const id = await outboxRow({
      accountId: account.id,
      eventId,
      availableAt: new Date(current - 10_000).toISOString(),
      discardAfter: new Date(current - 1_000).toISOString(),
    });
    const send = vi.spyOn(EmailService.prototype, 'send').mockResolvedValue({ delivered: true });

    await new NotificationService(testEnv).dispatchPending(new Date(current - 5_000));

    expect(send).not.toHaveBeenCalled();
    expect(await stateOf(id)).toMatchObject({
      status: 'failed', last_error_code: 'obsolete',
      claim_token: null, claimed_at: null, lease_expires_at: null,
    });
  });

  it('uses cron execution time for notification authorization and records scheduled time separately', async () => {
    const { account, eventId } = await hostedEvent();
    const scheduledAt = new Date('2026-07-21T12:00:00.000Z');
    const executedAt = new Date('2026-07-21T12:10:00.000Z');
    const id = await outboxRow({
      accountId: account.id,
      eventId,
      availableAt: '2026-07-21T11:00:00.000Z',
      discardAfter: '2026-07-21T12:05:00.000Z',
    });
    const send = vi.spyOn(EmailService.prototype, 'send').mockResolvedValue({ delivered: true });
    const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const scheduled: Promise<unknown>[] = [];
    const clock = vi.useFakeTimers();
    clock.setSystemTime(executedAt);

    worker.scheduled!({ cron: '47 * * * *', scheduledTime: scheduledAt.getTime() } as ScheduledController,
      testEnv,
      { waitUntil: (promise: Promise<unknown>) => scheduled.push(promise), passThroughOnException() {} } as unknown as ExecutionContext);
    await Promise.all(scheduled);
    clock.useRealTimers();

    expect(send).not.toHaveBeenCalled();
    expect(await stateOf(id)).toMatchObject({
      status: 'failed', last_error_code: 'obsolete',
      claim_token: null, claimed_at: null, lease_expires_at: null,
    });
    expect(logged.mock.calls.map(([entry]) => JSON.parse(String(entry)))).toContainEqual(expect.objectContaining({
      event: 'notifications_dispatched',
      scheduledAt: scheduledAt.toISOString(),
      executedAt: executedAt.toISOString(),
    }));
  });
});

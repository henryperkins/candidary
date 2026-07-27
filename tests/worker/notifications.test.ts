import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

import { AccountsRepository } from '../../worker/db/accounts';
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

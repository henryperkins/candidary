import type { NotificationKind } from '../../shared/contracts';
import { AccountsRepository } from '../db/accounts';
import { EventsRepository } from '../db/events';
import type { EventRecord, HostAccountRecord } from '../db/types';
import type { AppEnv } from '../env';
import { constantTimeEqual, digestSecret } from '../security/crypto';
import { EmailService, layout } from './email';

// Lead time on the management deadline, not on the purge date. Access ends 90 days
// after the event and the photos are not deleted until 120, so a warning keyed to
// deletion would arrive a month after the host lost the ability to act on it. The
// deadline that matters is the last day they can still sign in and export.
const ACCESS_WARNING_LEAD_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

interface HostTarget {
  account: HostAccountRecord;
  event: EventRecord;
}

interface AccountEventRow {
  account_id: string;
  event_id: string;
}

export async function unsubscribeUrl(env: AppEnv, accountId: string): Promise<string> {
  const digest = await digestSecret(`unsubscribe:${accountId}`, env.LOGIN_HMAC_KEY);
  const origin = env.APP_ORIGIN.replace(/\/$/u, '');
  return `${origin}/host/unsubscribe/${accountId}.${digest}`;
}

// One-click unsubscribe has to work with no session — the whole point is that it
// works from an inbox, on a device that never signed in — so the link carries its
// own proof instead.
export async function verifyUnsubscribeToken(env: AppEnv, token: string): Promise<string | null> {
  const [accountId, digest, extra] = token.split('.');
  if (!accountId || !digest || extra) return null;
  const expected = await digestSecret(`unsubscribe:${accountId}`, env.LOGIN_HMAC_KEY);
  return constantTimeEqual(digest, expected) ? accountId : null;
}

function formatEventDate(eventDate: string): string {
  return new Date(`${eventDate}T00:00:00.000Z`).toLocaleDateString('en-US', {
    timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
}

function formatTimestamp(value: string): string {
  return new Date(value).toLocaleDateString('en-US', {
    timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric',
  });
}

export class NotificationService {
  private readonly accounts: AccountsRepository;
  private readonly email: EmailService;

  constructor(private readonly env: AppEnv) {
    this.accounts = new AccountsRepository(env.DB);
    this.email = new EmailService(env);
  }

  private get origin(): string {
    return this.env.APP_ORIGIN.replace(/\/$/u, '');
  }

  // Claim, then send, then release on failure. Claiming first is what makes a
  // second cron run — or two overlapping ones — unable to send twice; releasing on
  // failure is what stops one bad send from costing the host the message forever.
  private async deliver(
    target: HostTarget,
    kind: NotificationKind,
    build: (unsubscribe: string) => { subject: string; text: string; html: string },
    now: Date,
  ): Promise<boolean> {
    if (!target.account.notificationsEnabled || !target.account.emailVerifiedAt) return false;
    const claimed = await this.accounts.claimNotification({
      accountId: target.account.id,
      eventId: target.event.id,
      kind,
      sentAt: now.toISOString(),
    });
    if (!claimed) return false;

    const unsubscribe = await unsubscribeUrl(this.env, target.account.id);
    const outcome = await this.email.send({
      to: target.account.email,
      unsubscribeUrl: unsubscribe,
      ...build(unsubscribe),
    });
    if (!outcome.delivered) {
      await this.accounts.releaseNotification(target.account.id, target.event.id, kind);
      return false;
    }
    return true;
  }

  sendGettingStarted(account: HostAccountRecord, event: EventRecord, now = new Date()): Promise<boolean> {
    return this.deliver({ account, event }, 'getting_started', (unsubscribe) => ({
      subject: `Your Candidary event is ready: ${event.name}`,
      text: [
        `${event.name} is set up and ready for ${formatEventDate(event.eventDate)}.`,
        '',
        'How it works:',
        '1. Open your event in Candidary and show the QR code, or share the guest link.',
        '2. Guests scan it, type their name once, and send photos. No app, no account.',
        '3. Originals arrive privately in your intake as they are sent.',
        '4. Download everything as a complete export whenever you like.',
        '',
        `Manage your event: ${this.origin}/manage/event/${event.id}`,
        '',
        `Guests can send photos until ${formatTimestamp(event.guestAccessExpiresAt)}, `
          + `and you can manage and export until ${formatTimestamp(event.managementAccessExpiresAt)}.`,
        '',
        `Stop receiving these emails: ${unsubscribe}`,
      ].join('\n'),
      html: layout(`${event.name} is ready`, [
        `Your event is set up for <strong>${formatEventDate(event.eventDate)}</strong>.`,
        '<strong>Show the QR code</strong> on the day, or share your guest link ahead of time.',
        'Guests scan it, type their name once, and send photos — no app and no account. '
          + 'The untouched originals arrive privately in your intake as they are sent.',
        `<a href="${this.origin}/manage/event/${event.id}">Open your event</a>`,
        `Guests can send photos until ${formatTimestamp(event.guestAccessExpiresAt)}. `
          + `You can manage and export until ${formatTimestamp(event.managementAccessExpiresAt)}.`,
      ], unsubscribe),
    }), now);
  }

  private sendEventReminder(target: HostTarget, now: Date): Promise<boolean> {
    const { event } = target;
    return this.deliver(target, 'event_reminder', (unsubscribe) => ({
      subject: `${event.name} is tomorrow — your QR code is ready`,
      text: [
        `${event.name} is tomorrow. Two things worth doing tonight:`,
        '',
        '1. Open your event and check that photo sending is switched on.',
        '2. Have the QR code ready to show, print, or put on a table card.',
        '',
        `Open your event: ${this.origin}/manage/event/${event.id}`,
        '',
        `Stop receiving these emails: ${unsubscribe}`,
      ].join('\n'),
      html: layout(`${event.name} is tomorrow`, [
        'Two things worth doing tonight:',
        'Check that photo sending is switched on, and have your QR code ready to show, print, or put on a table card.',
        `<a href="${this.origin}/manage/event/${event.id}">Open your event</a>`,
      ], unsubscribe),
    }), now);
  }

  private sendAccessWarning(target: HostTarget, now: Date): Promise<boolean> {
    const { event } = target;
    const deadline = formatTimestamp(event.managementAccessExpiresAt);
    return this.deliver(target, 'retention_warning', (unsubscribe) => ({
      subject: `Download your ${event.name} photos before ${deadline}`,
      text: [
        `Your management access to ${event.name} ends on ${deadline}.`,
        '',
        'After that you will not be able to sign in to this event or start an export, '
          + `and the stored photos are permanently deleted on ${formatTimestamp(event.purgeAfter)}.`,
        '',
        'If you have not downloaded your photos yet, do it now — an export includes every '
          + 'original at full quality.',
        '',
        `Export your photos: ${this.origin}/manage/event/${event.id}`,
        '',
        `Stop receiving these emails: ${unsubscribe}`,
      ].join('\n'),
      html: layout(`Download your ${event.name} photos`, [
        `Your management access ends on <strong>${deadline}</strong>.`,
        'After that you cannot sign in to this event or start an export, and the stored photos '
          + `are permanently deleted on ${formatTimestamp(event.purgeAfter)}.`,
        'If you have not downloaded your photos yet, do it now — an export includes every original at full quality.',
        `<a href="${this.origin}/manage/event/${event.id}">Export your photos</a>`,
      ], unsubscribe),
    }), now);
  }

  // Only ever selects hosts who confirmed their address and left notifications on,
  // so an unverified or opted-out account is never even a candidate.
  private async targets(where: string, bindings: unknown[]): Promise<HostTarget[]> {
    const { results } = await this.env.DB.prepare(`
      SELECT event_hosts.account_id AS account_id, events.id AS event_id
      FROM events
      JOIN event_hosts ON event_hosts.event_id = events.id
      JOIN host_accounts ON host_accounts.id = event_hosts.account_id
      WHERE events.deleted_at IS NULL
        AND host_accounts.disabled_at IS NULL
        AND host_accounts.notifications_enabled = 1
        AND host_accounts.email_verified_at IS NOT NULL
        AND ${where}
    `).bind(...bindings).all<AccountEventRow>();

    const events = new Map<string, EventRecord | null>();
    const accounts = new Map<string, HostAccountRecord | null>();
    const targets: HostTarget[] = [];
    for (const row of results) {
      if (!events.has(row.event_id)) {
        events.set(row.event_id, await new EventsRepository(this.env.DB).getById(row.event_id));
      }
      if (!accounts.has(row.account_id)) {
        accounts.set(row.account_id, await this.accounts.getById(row.account_id));
      }
      const event = events.get(row.event_id);
      const account = accounts.get(row.account_id);
      if (event && account) targets.push({ account, event });
    }
    return targets;
  }

  async run(now = new Date()): Promise<{ reminders: number; warnings: number }> {
    const tomorrow = new Date(now.getTime() + DAY_MS).toISOString().slice(0, 10);
    const reminderTargets = await this.targets('events.event_date = ?', [tomorrow]);
    let reminders = 0;
    for (const target of reminderTargets) {
      if (await this.sendEventReminder(target, now)) reminders += 1;
    }

    // A window rather than an equality: the cron runs once a day, and a single
    // missed run must not skip the warning entirely.
    const warningOpens = new Date(now.getTime() + (ACCESS_WARNING_LEAD_DAYS - 1) * DAY_MS).toISOString();
    const warningCloses = new Date(now.getTime() + ACCESS_WARNING_LEAD_DAYS * DAY_MS).toISOString();
    const warningTargets = await this.targets(
      'events.management_access_expires_at > ? AND events.management_access_expires_at <= ?',
      [warningOpens, warningCloses],
    );
    let warnings = 0;
    for (const target of warningTargets) {
      if (await this.sendAccessWarning(target, now)) warnings += 1;
    }

    return { reminders, warnings };
  }
}

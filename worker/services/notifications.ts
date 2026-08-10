import { NotificationOutboxRepository, type ClaimedOutboxRow } from '../db/notification-outbox';
import type { EventRecord } from '../db/types';
import type { AppEnv } from '../env';
import { canonicalOrigin } from '../origins';
import { constantTimeEqual, digestSecret } from '../security/crypto';
import { EmailService, layout } from './email';

export async function unsubscribeUrl(env: AppEnv, accountId: string): Promise<string> {
  const digest = await digestSecret(`unsubscribe:${accountId}`, env.LOGIN_HMAC_KEY);
  return `${canonicalOrigin(env)}/host/unsubscribe/${accountId}.${digest}`;
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
  private readonly email: EmailService;

  // Account and event data now arrives on the claimed outbox rows themselves, so
  // the service no longer reads either repository per recipient.
  constructor(private readonly env: AppEnv) {
    this.email = new EmailService(env);
  }

  // Canonical, never the request's origin: these are composed by the hourly
  // Cron, where there is no request, and mail links have to match the `From`
  // domain the message was sent under.
  private get origin(): string {
    return canonicalOrigin(this.env);
  }

  private gettingStartedMessage(event: EventRecord, unsubscribe: string) {
    return ({
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
    });
  }

  private eventReminderMessage(event: EventRecord, unsubscribe: string, now: Date) {
    // Event dates and reminder cutoffs are stored in UTC. A row can be retried
    // through the end of the event day, so its wording must follow the execution
    // date rather than the day it first became available.
    const isEventDay = now.toISOString().slice(0, 10) === event.eventDate;
    const day = isEventDay ? 'today' : 'tomorrow';
    const preparationTime = isEventDay ? 'now' : 'tonight';
    return ({
      subject: `${event.name} is ${day} — your QR code is ready`,
      text: [
        `${event.name} is ${day}. Two things worth doing ${preparationTime}:`,
        '',
        '1. Open your event and check that photo sending is switched on.',
        '2. Have the QR code ready to show, print, or put on a table card.',
        '',
        `Open your event: ${this.origin}/manage/event/${event.id}`,
        '',
        `Stop receiving these emails: ${unsubscribe}`,
      ].join('\n'),
      html: layout(`${event.name} is ${day}`, [
        `Two things worth doing ${preparationTime}:`,
        'Check that photo sending is switched on, and have your QR code ready to show, print, or put on a table card.',
        `<a href="${this.origin}/manage/event/${event.id}">Open your event</a>`,
      ], unsubscribe),
    });
  }

  private accessWarningMessage(event: EventRecord, unsubscribe: string) {
    const deadline = formatTimestamp(event.managementAccessExpiresAt);
    return ({
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
    });
  }
  // statements, well inside D1's per-invocation ceiling.
  async dispatchPending(
    now = new Date(),
    limit = 100,
  ): Promise<{ sent: number; retried: number; retired: number }> {
    const outbox = new NotificationOutboxRepository(this.env.DB);
    const timestamp = now.toISOString();
    await outbox.reclaimExpired(timestamp);

    const claimToken = crypto.randomUUID();
    const claimed = await outbox.claimDue(timestamp, limit, claimToken);
    if (claimed === 0) return { sent: 0, retried: 0, retired: 0 };

    const rows = await outbox.loadClaim(claimToken);
    let sent = 0;
    let retried = 0;
    let retired = 0;

    for (const row of rows) {
      const unsubscribe = await unsubscribeUrl(this.env, row.accountId);
      const built = this.buildMessage(row, unsubscribe, now);
      const authorized = await outbox.authorizeClaimedDelivery(
        row.id,
        claimToken,
        new Date().toISOString(),
      );
      if (!authorized) continue;
      if (authorized.status === 'retired') {
        retired += 1;
        continue;
      }

      const outcome = await this.email.send({
        to: row.email,
        unsubscribeUrl: unsubscribe,
        ...built,
      });

      const outcomeAt = new Date().toISOString();
      if (outcome.delivered) {
        await outbox.markSent(row.id, claimToken, outcomeAt);
        sent += 1;
        continue;
      }
      // One recipient's provider failure is its own row's problem; the rest of the
      // page still goes out.
      const next = await outbox.retryOrFail(
        row.id,
        claimToken,
        outcome.code ?? 'send_failed',
        row.attemptCount,
        outcomeAt,
      );
      if (next === 'pending') retried += 1; else retired += 1;
    }

    return { sent, retried, retired };
  }

  private buildMessage(row: ClaimedOutboxRow, unsubscribe: string, now: Date) {
    const event: EventRecord = {
      id: row.eventId,
      name: row.eventName,
      eventDate: row.eventDate,
      guestAccessExpiresAt: row.guestAccessExpiresAt,
      managementAccessExpiresAt: row.managementAccessExpiresAt,
      purgeAfter: row.purgeAfter,
    } as EventRecord;
    if (row.kind === 'event_reminder') return this.eventReminderMessage(event, unsubscribe, now);
    if (row.kind === 'retention_warning') return this.accessWarningMessage(event, unsubscribe);
    return this.gettingStartedMessage(event, unsubscribe);
  }

}

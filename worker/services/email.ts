import type { AppEnv } from '../env';

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  // Rendered into a List-Unsubscribe header as well as the body. Omitted for the
  // transactional messages a host cannot opt out of and still use the product.
  unsubscribeUrl?: string;
}

export interface SendOutcome {
  delivered: boolean;
  code?: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

// Deliberately plain. A wedding host reads these on a phone, and a marketing
// layout would only add ways for the one thing that matters — a code or a link —
// to end up below the fold or stripped by a client.
export function layout(headline: string, body: string[], unsubscribeUrl?: string): string {
  const paragraphs = body.map((line) => `<p style="margin:0 0 16px;">${line}</p>`).join('');
  const footer = unsubscribeUrl
    ? `<p style="margin:24px 0 0;font-size:13px;color:#666;">
         <a href="${escapeHtml(unsubscribeUrl)}">Stop receiving these emails</a>
       </p>`
    : '';
  return `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:16px;line-height:1.5;color:#1a1a1a;max-width:520px;">
    <h1 style="font-size:20px;margin:0 0 16px;">${escapeHtml(headline)}</h1>
    ${paragraphs}${footer}
  </div>`;
}

export class EmailService {
  constructor(private readonly env: AppEnv) {}

  // Never throws. Every caller here is in the middle of something that already
  // succeeded — an account was created, a password was changed — and unwinding
  // that because a mail server was briefly unhappy would be worse than reporting
  // the failure and letting the host ask again.
  async send(message: OutboundEmail): Promise<SendOutcome> {
    try {
      await this.env.EMAIL.send({
        to: message.to,
        from: { email: this.env.EMAIL_FROM, name: 'Candidary' },
        subject: message.subject,
        text: message.text,
        html: message.html,
        ...(message.unsubscribeUrl
          ? {
            headers: {
              'List-Unsubscribe': `<${message.unsubscribeUrl}>`,
              'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
            },
          }
          : {}),
      });
      return { delivered: true };
    } catch (error) {
      // `code` is what Email Service uses to distinguish an unverified sender from
      // a rate limit from a suppressed recipient, and it is the only part worth
      // keeping: the message text is not safe to show a host.
      const code = typeof error === 'object' && error && 'code' in error
        ? String((error as { code: unknown }).code)
        : 'E_UNKNOWN';
      console.error(JSON.stringify({ event: 'email_send_failed', code }));
      return { delivered: false, code };
    }
  }
}

import { Hono, type Context } from 'hono';

import { AccountsRepository } from '../db/accounts';
import type { AppBindings } from '../env';
import { verifyUnsubscribeToken } from '../services/notifications';

export const hostPublicRoutes = new Hono<AppBindings>();

// Opting out has to work from the message itself: no session, no CSRF token, and
// on whatever device the mail happened to be opened. The signature in the link is
// the whole authorization, and it can only ever turn notifications off.
const PAGE = 'font-family:system-ui,sans-serif;max-width:420px;margin:15vh auto;padding:0 24px;line-height:1.5;';

function page(title: string, body: string) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
     <title>Email preferences</title>
     <div style="${PAGE}">${body}</div>`.replace('<title>Email preferences</title>', `<title>${title}</title>`);
}

// Read-only on purpose. A link in an inbox is followed by scanners, prefetchers, and
// preview generators long before the person reads it, so a GET that decided anything
// would unsubscribe hosts who never clicked.
hostPublicRoutes.get('/host/unsubscribe/:token', async (context) => {
  const token = context.req.param('token') ?? '';
  return context.html(page('Email preferences', `
       <h1 style="font-size:20px;">Turn off event emails?</h1>
       <p>This stops the guide, the reminder the day before, and the warning before
          your management access ends.</p>
       <p>Your events and photos are untouched, and you can turn these emails back on
          from your account settings at any time.</p>
       <form method="post" action="/host/unsubscribe/${encodeURIComponent(token)}">
         <button type="submit" style="font:inherit;padding:12px 20px;min-height:44px;cursor:pointer;">
           Unsubscribe me
         </button>
       </form>`));
});

// The mutation. Mail providers issuing a one-click unsubscribe POST the
// List-Unsubscribe target rather than following it as a link, so this stays the
// same signed URL the header advertises.
hostPublicRoutes.post('/host/unsubscribe/:token', async (context: Context<AppBindings>) => {
  const accountId = await verifyUnsubscribeToken(context.env, context.req.param('token') ?? '');
  if (accountId) {
    await new AccountsRepository(context.env.DB).setNotificationsEnabled(accountId, false);
  }
  // Answered identically either way. A bad signature is far more likely to be a
  // mail client mangling the URL than an attack, and confirming which addresses
  // exist would be a poor trade for a marginally clearer error.
  return context.html(page('Email preferences', `
       <h1 style="font-size:20px;">You are unsubscribed</h1>
       <p>You will not receive any more event emails from Candidary.</p>
       <p>Your events and photos are untouched. You can turn these emails back on
          from your account settings at any time.</p>`));
});

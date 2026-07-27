import { Hono, type Context } from 'hono';

import { AccountsRepository } from '../db/accounts';
import type { AppBindings } from '../env';
import { verifyUnsubscribeToken } from '../services/notifications';

export const hostPublicRoutes = new Hono<AppBindings>();

// Opting out has to work from the message itself: no session, no CSRF token, and
// on whatever device the mail happened to be opened. The signature in the link is
// the whole authorization, and it can only ever turn notifications off.
async function unsubscribe(context: Context<AppBindings>) {
  const accountId = await verifyUnsubscribeToken(context.env, context.req.param('token') ?? '');
  if (accountId) {
    await new AccountsRepository(context.env.DB).setNotificationsEnabled(accountId, false);
  }
  // Answered identically either way. A bad signature is far more likely to be a
  // mail client mangling the URL than an attack, and confirming which addresses
  // exist would be a poor trade for a marginally clearer error.
  return context.html(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
     <title>Email preferences</title>
     <div style="font-family:system-ui,sans-serif;max-width:420px;margin:15vh auto;padding:0 24px;line-height:1.5;">
       <h1 style="font-size:20px;">You are unsubscribed</h1>
       <p>You will not receive any more event emails from Candidary.</p>
       <p>Your events and photos are untouched. You can turn these emails back on
          from your account settings at any time.</p>
     </div>`,
  );
}

hostPublicRoutes.get('/host/unsubscribe/:token', unsubscribe);
// Mail providers issuing a one-click unsubscribe POST the List-Unsubscribe target
// rather than following it as a link.
hostPublicRoutes.post('/host/unsubscribe/:token', unsubscribe);

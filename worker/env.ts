import type { EventRecord, HostAccountRecord, HostSessionRecord, SessionRecord, TokenRecord } from './db/types';

// Every secret binding is declared in `wrangler.jsonc` under `secrets.required`
// and reaches this type through the generated `Cloudflare.Env`. Redeclaring them
// here would let the configuration and the code disagree silently, which is how
// `LOGIN_HMAC_KEY` came to be missing from the generated bindings in the first
// place.
export type AppEnv = Cloudflare.Env;

export interface AuthenticatedSession {
  event: EventRecord;
  session: SessionRecord;
  token: TokenRecord;
}

export interface AuthenticatedAccount {
  account: HostAccountRecord;
  session: HostSessionRecord;
}

// Link sessions speak for one event by way of an access token. Account sessions
// resolve separately through `host_sessions`.
export type Principal = { kind: 'event' } & AuthenticatedSession;

export type AppBindings = {
  Bindings: AppEnv;
  Variables: {
    requestId: string;
    auth: AuthenticatedSession;
  };
};

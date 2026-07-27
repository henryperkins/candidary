import type { EventRecord, HostAccountRecord, SessionRecord, TokenRecord } from './db/types';

export interface AppEnv extends Cloudflare.Env {
  TOKEN_HMAC_KEY: string;
  SESSION_HMAC_KEY: string;
  GUEST_TOKEN_ENCRYPTION_KEY: string;
  LOGIN_HMAC_KEY: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
}

export interface AuthenticatedSession {
  event: EventRecord;
  session: SessionRecord;
  token: TokenRecord;
}

export interface AuthenticatedAccount {
  account: HostAccountRecord;
  session: SessionRecord;
}

// A session either speaks for one event, by way of an access token, or for an
// account that may host several. Which one it is decides where the event on a
// request comes from: the session itself, or a membership lookup against the
// event named in the path.
export type Principal =
  | ({ kind: 'event' } & AuthenticatedSession)
  | ({ kind: 'account' } & AuthenticatedAccount);

export type AppBindings = {
  Bindings: AppEnv;
  Variables: {
    requestId: string;
    auth: AuthenticatedSession;
  };
};

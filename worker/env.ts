import type { EventRecord, HostAccountRecord, HostSessionRecord, SessionRecord, TokenRecord } from './db/types';

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

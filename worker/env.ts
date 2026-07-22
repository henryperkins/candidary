import type { EventRecord, SessionRecord, TokenRecord } from './db/types';

export interface AppEnv extends Cloudflare.Env {
  TOKEN_HMAC_KEY: string;
  SESSION_HMAC_KEY: string;
  GUEST_TOKEN_ENCRYPTION_KEY: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
}

export interface AuthenticatedSession {
  event: EventRecord;
  session: SessionRecord;
  token: TokenRecord;
}

export type AppBindings = {
  Bindings: AppEnv;
  Variables: {
    requestId: string;
    auth: AuthenticatedSession;
  };
};

import { digestSecret } from './crypto';

interface GuestMessageHmacBinding {
  readonly GUEST_MESSAGE_HMAC_KEY: string;
}

const PAYLOAD_DOMAIN = 'guest-message-payload:v1';
const SESSION_SCOPE_DOMAIN = 'guest-message-rate-session:v1';
const IP_SCOPE_DOMAIN = 'guest-message-rate-ip:v1';

export async function guestMessagePayloadHmac(
  env: GuestMessageHmacBinding,
  guestName: string | null,
  body: string,
): Promise<string> {
  return digestSecret(`${PAYLOAD_DOMAIN}:${JSON.stringify([guestName, body])}`, env.GUEST_MESSAGE_HMAC_KEY);
}

export async function guestMessageSessionScopeDigest(
  env: GuestMessageHmacBinding,
  eventId: string,
  guestSessionId: string,
): Promise<string> {
  return digestSecret(
    `${SESSION_SCOPE_DOMAIN}:${JSON.stringify([eventId, guestSessionId])}`,
    env.GUEST_MESSAGE_HMAC_KEY,
  );
}

export async function guestMessageIpScopeDigest(
  env: GuestMessageHmacBinding,
  eventId: string,
  trustedClientIp: string,
): Promise<string> {
  return digestSecret(
    `${IP_SCOPE_DOMAIN}:${JSON.stringify([eventId, trustedClientIp])}`,
    env.GUEST_MESSAGE_HMAC_KEY,
  );
}

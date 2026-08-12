import { digestSecret } from './crypto';

const PAYLOAD_DOMAIN = 'guest-message-payload:v1';
const SESSION_SCOPE_DOMAIN = 'guest-message-rate-session:v1';
const IP_SCOPE_DOMAIN = 'guest-message-rate-ip:v1';

export async function guestMessagePayloadHmac(
  hmacKey: string,
  guestName: string | null,
  body: string,
): Promise<string> {
  return digestSecret(`${PAYLOAD_DOMAIN}:${JSON.stringify([guestName, body])}`, hmacKey);
}

export async function guestMessageSessionScopeDigest(
  hmacKey: string,
  eventId: string,
  guestSessionId: string,
): Promise<string> {
  return digestSecret(
    `${SESSION_SCOPE_DOMAIN}:${JSON.stringify([eventId, guestSessionId])}`,
    hmacKey,
  );
}

export async function guestMessageIpScopeDigest(
  hmacKey: string,
  eventId: string,
  trustedClientIp: string,
): Promise<string> {
  return digestSecret(
    `${IP_SCOPE_DOMAIN}:${JSON.stringify([eventId, trustedClientIp])}`,
    hmacKey,
  );
}

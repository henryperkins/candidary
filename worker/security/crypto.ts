const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + padding);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function randomBase64Url(byteLength: number): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function importAesKey(keyMaterial: string): Promise<CryptoKey> {
  const bytes = base64UrlToBytes(keyMaterial);
  if (bytes.byteLength !== 32) throw new Error('Guest token encryption key must contain 32 bytes.');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export interface SecretToken {
  id: string;
  secret: string;
  token: string;
}

export function createSecretToken(): SecretToken {
  const id = randomBase64Url(16);
  const secret = randomBase64Url(32);
  return { id, secret, token: `${id}.${secret}` };
}

export async function digestSecret(secret: string, keyMaterial: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(keyMaterial),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(secret));
  return bytesToBase64Url(new Uint8Array(digest));
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return difference === 0;
}

export async function encryptGuestSecret(secret: string, keyMaterial: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importAesKey(keyMaterial);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(secret));
  return `v1.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ciphertext))}`;
}

export async function decryptGuestSecret(ciphertext: string, keyMaterial: string): Promise<string> {
  const [version, encodedIv, encodedCiphertext, extra] = ciphertext.split('.');
  if (version !== 'v1' || !encodedIv || !encodedCiphertext || extra) {
    throw new Error('Guest token ciphertext is malformed.');
  }

  const key = await importAesKey(keyMaterial);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64UrlToBytes(encodedIv) },
    key,
    base64UrlToBytes(encodedCiphertext),
  );
  return decoder.decode(plaintext);
}

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

import { MAX_HOST_PASSWORD_LENGTH, MIN_HOST_PASSWORD_LENGTH } from '../../shared/constants';

// WebCrypto is the wrong tool for this one job. workerd caps PBKDF2 at 100,000
// iterations to bound request CPU, which is well under current guidance, and the
// cap is not raisable from application code. `node:crypto` is available under the
// `nodejs_compat` flag this Worker already sets, and its scrypt is native.
//
// N=32768, r=8, p=3 is an OWASP-listed parameter set. The choice among their sets
// is forced by memory: scrypt needs about `128 * N * r` bytes, so N=32768 lands at
// 32 MiB, while the more familiar N=131072 set would want 128 MiB — the entire
// isolate limit. Node also refuses to run when that estimate exceeds `maxmem`, and
// its default maxmem is exactly 32 MiB, so the bound has to be raised explicitly
// or every hash throws at the boundary.
const PARAMETERS = { N: 32768, r: 8, p: 3 } as const;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const MAX_MEMORY = 64 * 1024 * 1024;

export const MIN_PASSWORD_LENGTH = MIN_HOST_PASSWORD_LENGTH;
export const MAX_PASSWORD_LENGTH = MAX_HOST_PASSWORD_LENGTH;

interface ScryptParameters { N: number; r: number; p: number }

function derive(password: string, salt: Buffer, parameters: ScryptParameters): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize('NFKC'),
      salt,
      KEY_LENGTH,
      { ...parameters, maxmem: MAX_MEMORY },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, PARAMETERS);
  const { N, r, p } = PARAMETERS;
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

// Reports whether the password matches, and whether the stored hash was produced
// with parameters weaker than the current ones. A caller that has the plaintext in
// hand — only ever a successful sign-in — can rehash on the spot, so raising the
// cost later does not require touching rows that may never be read again.
export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<{ valid: boolean; needsRehash: boolean }> {
  const [scheme, rawN, rawR, rawP, rawSalt, rawKey, extra] = encoded.split('$');
  if (scheme !== 'scrypt' || !rawN || !rawR || !rawP || !rawSalt || !rawKey || extra) {
    return { valid: false, needsRehash: false };
  }

  const parameters = { N: Number(rawN), r: Number(rawR), p: Number(rawP) };
  if (!Number.isSafeInteger(parameters.N) || !Number.isSafeInteger(parameters.r) || !Number.isSafeInteger(parameters.p)) {
    return { valid: false, needsRehash: false };
  }
  // A stored record could otherwise name parameters far past what this isolate can
  // afford, turning one crafted row into a memory exhaustion on every sign-in.
  if (128 * parameters.N * parameters.r > MAX_MEMORY) return { valid: false, needsRehash: false };

  const expected = Buffer.from(rawKey, 'base64url');
  let derived: Buffer;
  try {
    derived = await derive(password, Buffer.from(rawSalt, 'base64url'), parameters);
  } catch {
    return { valid: false, needsRehash: false };
  }

  const valid = expected.length === derived.length && timingSafeEqual(expected, derived);
  const needsRehash = parameters.N < PARAMETERS.N || parameters.r < PARAMETERS.r || parameters.p < PARAMETERS.p;
  return { valid, needsRehash: valid && needsRehash };
}

// Length is the only rule worth enforcing. Composition rules push people toward
// predictable substitutions without adding entropy, so the floor is set high
// instead and everything else is left to the host.
export function describePasswordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > MAX_PASSWORD_LENGTH) return `Use ${MAX_PASSWORD_LENGTH} characters or fewer.`;
  return null;
}

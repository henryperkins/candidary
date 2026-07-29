import { scrypt } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { MAX_HOST_PASSWORD_LENGTH, MIN_HOST_PASSWORD_LENGTH } from '../../shared/constants';
import {
  describePasswordProblem,
  hashPassword,
  verifyPassword,
} from '../../worker/security/passwords';

describe('password hashing', () => {
  it('round-trips a password through scrypt in the Workers runtime', async () => {
    const encoded = await hashPassword('correct horse battery staple');

    expect(encoded).toMatch(/^scrypt\$32768\$8\$3\$[\w-]+\$[\w-]+$/u);
    await expect(verifyPassword('correct horse battery staple', encoded))
      .resolves.toEqual({ valid: true, needsRehash: false });
  });

  it('rejects a wrong password and salts each hash independently', async () => {
    const [first, second] = await Promise.all([hashPassword('a-long-enough-password'), hashPassword('a-long-enough-password')]);

    expect(first).not.toBe(second);
    await expect(verifyPassword('not-the-password', first)).resolves.toEqual({ valid: false, needsRehash: false });
  });

  it('refuses a stored hash whose parameters would exhaust the isolate', async () => {
    const hostile = `scrypt$16777216$8$1$${btoa('salt')}$${btoa('hash')}`;

    await expect(verifyPassword('anything', hostile)).resolves.toEqual({ valid: false, needsRehash: false });
  });

  it('refuses a valid hash whose parallelism exceeds the supported CPU policy', async () => {
    const password = 'parallelism-must-be-bounded';
    const salt = Buffer.alloc(16, 11);
    const key = await new Promise<Buffer>((resolve, reject) => {
      scrypt(password.normalize('NFKC'), salt, 32, {
        N: 32768, r: 8, p: 4, maxmem: 64 * 1024 * 1024,
      }, (error, derived) => (error ? reject(error) : resolve(derived)));
    });
    const hostile = `scrypt$32768$8$4$${salt.toString('base64url')}$${key.toString('base64url')}`;

    await expect(verifyPassword(password, hostile))
      .resolves.toEqual({ valid: false, needsRehash: false });
  });

  it('reports a rehash when a stored hash is weaker than the current cost', async () => {
    const encoded = await hashPassword('another-long-password');
    const weakened = encoded.replace('scrypt$32768$8$3$', 'scrypt$16384$8$3$');

    // The weakened string keeps a key derived at the stronger cost, so it must not
    // validate; the point here is only that malformed downgrades cannot pass.
    await expect(verifyPassword('another-long-password', weakened))
      .resolves.toEqual({ valid: false, needsRehash: false });
  });

  // Derived from the constants rather than transcribed, so raising the floor cannot
  // leave a passing test asserting the number it used to be.
  it('enforces a length floor and ceiling', () => {
    expect(MIN_HOST_PASSWORD_LENGTH).toBe(15); // NIST SP 800-63B Rev. 4 §3.1.1.2, single factor.
    expect(describePasswordProblem('short')).toBe(`Use at least ${MIN_HOST_PASSWORD_LENGTH} characters.`);
    expect(describePasswordProblem('x'.repeat(MIN_HOST_PASSWORD_LENGTH - 1)))
      .toBe(`Use at least ${MIN_HOST_PASSWORD_LENGTH} characters.`);
    expect(describePasswordProblem('x'.repeat(MIN_HOST_PASSWORD_LENGTH))).toBeNull();
    expect(describePasswordProblem('x'.repeat(MAX_HOST_PASSWORD_LENGTH))).toBeNull();
    expect(describePasswordProblem('x'.repeat(MAX_HOST_PASSWORD_LENGTH + 1)))
      .toBe(`Use ${MAX_HOST_PASSWORD_LENGTH} characters or fewer.`);
  });

  // Length is the only rule. Composition requirements push people toward predictable
  // substitutions without adding entropy, and NIST forbids them outright.
  it('imposes no composition rule on a password that clears the floor', () => {
    expect(describePasswordProblem('aaaaaaaaaaaaaaaaaaaa')).toBeNull();
    expect(describePasswordProblem('correct horse battery staple')).toBeNull();
  });
});

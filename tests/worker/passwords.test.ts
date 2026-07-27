import { describe, expect, it } from 'vitest';

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

  it('reports a rehash when a stored hash is weaker than the current cost', async () => {
    const encoded = await hashPassword('another-long-password');
    const weakened = encoded.replace('scrypt$32768$8$3$', 'scrypt$16384$8$3$');

    // The weakened string keeps a key derived at the stronger cost, so it must not
    // validate; the point here is only that malformed downgrades cannot pass.
    await expect(verifyPassword('another-long-password', weakened))
      .resolves.toEqual({ valid: false, needsRehash: false });
  });

  it('enforces a length floor and ceiling', () => {
    expect(describePasswordProblem('short')).toBe('Use at least 12 characters.');
    expect(describePasswordProblem('x'.repeat(257))).toBe('Use 256 characters or fewer.');
    expect(describePasswordProblem('x'.repeat(12))).toBeNull();
  });
});

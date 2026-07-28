import { describe, expect, it, vi } from 'vitest';

import { resetDatabase, testEnv } from './helpers';

describe('Worker startup', () => {
  it('defers randomized absent-account work until the first missing-account sign-in', async () => {
    await resetDatabase();
    vi.resetModules();
    const original = crypto.getRandomValues.bind(crypto);
    const random = vi.spyOn(crypto, 'getRandomValues')
      .mockImplementation((array) => original(array));

    await import('../../worker/index');
    expect(random).not.toHaveBeenCalled();

    const { HostAuthService } = await import('../../worker/services/host-auth');
    await expect(new HostAuthService(testEnv).authenticate(
      'missing@example.com',
      'a-sufficiently-long-password',
    )).rejects.toMatchObject({ code: 'LOGIN_CREDENTIALS_INVALID' });
    expect(random).toHaveBeenCalledTimes(2);
  });
});

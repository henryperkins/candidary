import { describe, expect, it } from 'vitest';

import type { AppEnv } from '../../worker/env';
import { EmailService } from '../../worker/services/email';

describe('EmailService', () => {
  it('reports email as disabled when an isolated preview has no email binding', async () => {
    const service = new EmailService({ EMAIL: undefined } as unknown as AppEnv);

    await expect(service.send({
      to: 'host@example.com',
      subject: 'Preview message',
      text: 'This must not be sent.',
      html: '<p>This must not be sent.</p>',
    })).resolves.toEqual({ delivered: false, code: 'E_DISABLED' });
  });
});

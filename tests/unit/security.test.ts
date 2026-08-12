import { describe, expect, it } from 'vitest';

import {
  constantTimeEqual,
  createSecretToken,
  decryptSecret,
  digestSecret,
  encryptSecret,
} from '../../worker/security/crypto';
import { calculateLifecycle } from '../../worker/security/lifecycle';
import { sanitizeFilename } from '../../worker/security/filenames';
import {
  guestMessageIpScopeDigest,
  guestMessagePayloadHmac,
  guestMessageSessionScopeDigest,
} from '../../worker/security/guest-message';
import { eventSlug } from '../../worker/security/slugs';

const encryptionKey = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY';

describe('secret token security', () => {
  it('creates separate public ids and 256-bit base64url secrets', () => {
    const token = createSecretToken();

    expect(token.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(token.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token.token).toBe(`${token.id}.${token.secret}`);
  });

  it('digests secrets deterministically and distinguishes inputs', async () => {
    const first = await digestSecret('secret-one', 'hmac-key');
    const repeated = await digestSecret('secret-one', 'hmac-key');
    const second = await digestSecret('secret-two', 'hmac-key');

    expect(first).toBe(repeated);
    expect(first).not.toBe(second);
    expect(constantTimeEqual(first, repeated)).toBe(true);
    expect(constantTimeEqual(first, second)).toBe(false);
    expect(constantTimeEqual(first, `${first}x`)).toBe(false);
  });

  it('encrypts guest secrets with a unique IV and decrypts them', async () => {
    const first = await encryptSecret('guest-secret', encryptionKey);
    const second = await encryptSecret('guest-secret', encryptionKey);

    expect(first).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(first).not.toBe(second);
    await expect(decryptSecret(first, encryptionKey)).resolves.toBe('guest-secret');
    await expect(decryptSecret(`${first}tampered`, encryptionKey)).rejects.toThrow();
  });
});

describe('guest message persisted-data HMACs', () => {
  const env = {
    GUEST_MESSAGE_HMAC_KEY: 'test-guest-message-hmac-key-with-at-least-32-bytes',
  };

  it('canonicalizes the normalized nullable-name and body tuple under a versioned domain', async () => {
    await expect(guestMessagePayloadHmac(env, null, 'A quiet, perfect moment.'))
      .resolves.toBe('WWDxup0LSPV3jk5MwoHpAHvm7txGmkoqpyLxniu__x0');
    await expect(guestMessagePayloadHmac(env, 'Avery', 'A quiet, perfect moment.'))
      .resolves.toBe('SO_zVt6vEJiQpsmhSAw9uUP9aOw1c1UIPmNMWYFoStE');
  });

  it('domain-separates event-scoped session and trusted-IP rate identities', async () => {
    const session = await guestMessageSessionScopeDigest(env, 'event-a', 'session-a');
    const ip = await guestMessageIpScopeDigest(env, 'event-a', 'session-a');

    expect(session).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(ip).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(session).not.toBe(ip);
    await expect(guestMessageSessionScopeDigest(env, 'event-b', 'session-a'))
      .resolves.not.toBe(session);
    await expect(guestMessageIpScopeDigest(env, 'event-b', 'session-a'))
      .resolves.not.toBe(ip);
  });
});

describe('fixed lifecycle', () => {
  it('anchors future-event expiry to the event date', () => {
    const lifecycle = calculateLifecycle('2026-09-19', new Date('2026-07-21T12:00:00.000Z'));

    expect(lifecycle.guestAccessExpiresAt).toBe('2026-10-19T23:59:59.999Z');
    expect(lifecycle.managementAccessExpiresAt).toBe('2026-12-18T23:59:59.999Z');
    expect(lifecycle.purgeAfter).toBe('2027-01-17T23:59:59.999Z');
  });

  it('keeps the minimum lifetime when the event date is in the past', () => {
    const lifecycle = calculateLifecycle('2026-07-01', new Date('2026-07-21T12:00:00.000Z'));

    expect(lifecycle.guestAccessExpiresAt).toBe('2026-08-20T12:00:00.000Z');
    expect(lifecycle.managementAccessExpiresAt).toBe('2026-10-19T12:00:00.000Z');
    expect(lifecycle.purgeAfter).toBe('2026-11-18T12:00:00.000Z');
  });
});

describe('display filenames', () => {
  it('removes paths, controls, unsafe punctuation, and excessive length', () => {
    expect(sanitizeFilename('..\\secret/<wedding>\u0000 photo.JPG')).toBe('wedding photo.JPG');
    expect(sanitizeFilename('   ...   ')).toBe('image');
    expect(sanitizeFilename(`${'a'.repeat(180)}.jpg`).length).toBeLessThanOrEqual(120);
  });
});

describe('public event slugs', () => {
  it('normalizes base64url token suffixes to the route-safe alphabet', () => {
    expect(eventSlug('Maya & Theo', '_L1LbL')).toBe('maya-theo-l1lbl');
    expect(eventSlug('✨', '--ABC_')).toBe('event-abc');
  });
});

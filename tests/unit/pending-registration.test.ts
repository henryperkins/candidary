import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PENDING_REGISTRATION_KEY,
  clearPendingRegistration,
  matchesPendingRegistration,
  readPendingRegistration,
  refreshPendingRegistrationExpiry,
  rememberPendingRegistration,
} from '../../src/app/pending-registration';

const EMAIL_DIGEST = '61c0ee79db216f84107d8d2d7bfb35266f66b06773a99a0786e3a173ffe920ee';
const FIRST_EXPIRY = '2099-01-01T00:15:00.000Z';
const SECOND_EXPIRY = '2099-01-01T00:30:00.000Z';

function wholeLocalStoragePayload(): string {
  return JSON.stringify(Object.fromEntries(
    Array.from({ length: localStorage.length }, (_, index) => {
      const key = localStorage.key(index)!;
      return [key, localStorage.getItem(key)];
    }),
  ));
}

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

describe('pending registration marker', () => {
  it('round-trips only the normalized email digest and exact expiry', async () => {
    await rememberPendingRegistration({
      email: ' Host@Example.com ',
      resumeExpiresAt: FIRST_EXPIRY,
    });

    await expect(readPendingRegistration(new Date('2099-01-01T00:00:00.000Z')))
      .resolves.toEqual({ emailDigest: EMAIL_DIGEST, expiresAt: FIRST_EXPIRY });
    expect(wholeLocalStoragePayload()).not.toContain('Host@Example.com');
    expect(wholeLocalStoragePayload()).not.toContain('host@example.com');
  });

  it('clears an expired marker instead of returning it', async () => {
    await rememberPendingRegistration({
      email: 'host@example.com',
      resumeExpiresAt: '2099-01-01T00:05:00.000Z',
    });

    await expect(readPendingRegistration(new Date('2099-01-01T00:05:00.000Z')))
      .resolves.toBeNull();
    expect(localStorage.getItem(PENDING_REGISTRATION_KEY)).toBeNull();
  });

  it.each([
    ['corrupt JSON', '{not-json'],
    ['wrong payload version', JSON.stringify({
      version: 2,
      emailDigest: EMAIL_DIGEST,
      expiresAt: FIRST_EXPIRY,
    })],
    ['invalid digest', JSON.stringify({
      version: 1,
      emailDigest: 'not-a-sha-256-digest',
      expiresAt: FIRST_EXPIRY,
    })],
  ])('treats %s as absent without throwing', async (_label, serialized) => {
    localStorage.setItem(PENDING_REGISTRATION_KEY, serialized);

    await expect(readPendingRegistration(new Date('2099-01-01T00:00:00.000Z')))
      .resolves.toBeNull();
    expect(localStorage.getItem(PENDING_REGISTRATION_KEY)).toBeNull();
  });

  it('does not match a different normalized address', async () => {
    await rememberPendingRegistration({
      email: 'host@example.com',
      resumeExpiresAt: FIRST_EXPIRY,
    });

    await expect(matchesPendingRegistration(
      'other@example.com',
      new Date('2099-01-01T00:00:00.000Z'),
    )).resolves.toBe(false);
    await expect(matchesPendingRegistration(
      ' HOST@example.com ',
      new Date('2099-01-01T00:00:00.000Z'),
    )).resolves.toBe(true);
  });

  it('refreshes only the expiry after a reload with no raw email in memory', async () => {
    await rememberPendingRegistration({
      email: 'host@example.com',
      resumeExpiresAt: FIRST_EXPIRY,
    });
    const before = JSON.parse(localStorage.getItem(PENDING_REGISTRATION_KEY)!) as {
      emailDigest: string;
    };

    vi.resetModules();
    const reloaded = await import('../../src/app/pending-registration');
    expect(reloaded.refreshPendingRegistrationExpiry(SECOND_EXPIRY)).toBe(true);

    const after = JSON.parse(localStorage.getItem(PENDING_REGISTRATION_KEY)!) as {
      emailDigest: string;
      expiresAt: string;
    };
    expect(after.emailDigest).toBe(before.emailDigest);
    expect(after.emailDigest).toBe(EMAIL_DIGEST);
    expect(after.expiresAt).toBe(SECOND_EXPIRY);
    expect(wholeLocalStoragePayload()).not.toContain('host@example.com');
  });

  it.each([
    ['missing marker', null],
    ['corrupt marker', '{not-json'],
    ['expired marker', JSON.stringify({
      version: 1,
      emailDigest: EMAIL_DIGEST,
      expiresAt: '2000-01-01T00:00:00.000Z',
    })],
  ])('does not create a digest-less marker when refresh sees a %s', (_label, serialized) => {
    if (serialized !== null) localStorage.setItem(PENDING_REGISTRATION_KEY, serialized);

    expect(refreshPendingRegistrationExpiry(SECOND_EXPIRY)).toBe(false);
    expect(localStorage.getItem(PENDING_REGISTRATION_KEY)).toBeNull();
  });

  it('removes the marker explicitly', async () => {
    await rememberPendingRegistration({
      email: 'host@example.com',
      resumeExpiresAt: FIRST_EXPIRY,
    });

    clearPendingRegistration();

    expect(localStorage.getItem(PENDING_REGISTRATION_KEY)).toBeNull();
  });
});

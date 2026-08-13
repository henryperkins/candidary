import { describe, expect, it } from 'vitest';

import {
  decodeGuestbookCursor,
  encodeGuestbookCursor,
} from '../../worker/http/guestbook-cursor';
import { decodeMessageCursor, encodeMessageCursor } from '../../worker/http/message-cursor';

const eventId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const sessionHmacKey = 'unit-test-session-hmac-key-with-at-least-32-bytes';

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function tamperOneByte(segment: string): string {
  const bytes = decodeBase64Url(segment);
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  return encodeBase64Url(bytes);
}

describe('guestbook cursors', () => {
  it('round-trips a signed guest cursor without disclosing its raw session ID', async () => {
    const cursor = await encodeGuestbookCursor({
      version: 2,
      audience: 'guest',
      stream: 'shared',
      eventId,
      sessionId,
      createdAt: '2026-09-19T20:00:00.000Z',
      sourceRank: 1,
      id: '33333333-3333-4333-8333-333333333333',
    }, sessionHmacKey);

    const [encodedPayload, signature, extra] = cursor.split('.');
    expect(encodedPayload).toEqual(expect.any(String));
    expect(signature).toEqual(expect.any(String));
    expect(extra).toBeUndefined();
    const decodedPayload = new TextDecoder().decode(decodeBase64Url(encodedPayload!));
    expect(decodedPayload).not.toContain(sessionId);
    expect(JSON.parse(decodedPayload)).toMatchObject({
      version: 2,
      audience: 'guest',
      stream: 'shared',
      eventId,
      sessionBinding: expect.any(String),
    });
    expect(JSON.parse(decodedPayload)).not.toHaveProperty('sessionId');

    await expect(decodeGuestbookCursor(cursor, {
      audience: 'guest',
      stream: 'shared',
      eventId,
      sessionId,
    }, sessionHmacKey)).resolves.toMatchObject({
      version: 2,
      audience: 'guest',
      stream: 'shared',
      eventId,
      sessionBinding: expect.any(String),
      createdAt: '2026-09-19T20:00:00.000Z',
      sourceRank: 1,
      id: '33333333-3333-4333-8333-333333333333',
    });

    for (const binding of [
      { audience: 'guest' as const, stream: 'own_unshared' as const, eventId, sessionId },
      { audience: 'guest' as const, stream: 'shared' as const, eventId, sessionId: crypto.randomUUID() },
      { audience: 'guest' as const, stream: 'shared' as const, eventId: crypto.randomUUID(), sessionId },
    ]) {
      await expect(decodeGuestbookCursor(cursor, binding, sessionHmacKey)).rejects.toMatchObject(
        expect.objectContaining({ code: 'VALIDATION_FAILED', status: 422 }),
      );
    }
  });

  it('authenticates Manager cursors and binds event, view, and source', async () => {
    const cursor = await encodeGuestbookCursor({
      version: 2,
      audience: 'manager',
      eventId,
      view: 'needs-review',
      source: 'photo_caption',
      createdAt: '2026-09-19T20:00:00.000Z',
      sourceRank: 1,
      id: '33333333-3333-4333-8333-333333333333',
    }, sessionHmacKey);

    await expect(decodeGuestbookCursor(cursor, {
      audience: 'manager',
      eventId,
      view: 'needs-review',
      source: 'photo_caption',
    }, sessionHmacKey)).resolves.toMatchObject({ version: 2, audience: 'manager', sourceRank: 1 });
    await expect(decodeGuestbookCursor(cursor, {
      audience: 'manager',
      eventId,
      view: 'shared',
      source: 'photo_caption',
    }, sessionHmacKey)).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
    await expect(decodeGuestbookCursor(cursor, {
      audience: 'manager',
      eventId,
      view: 'needs-review',
      source: 'guest_note',
    }, sessionHmacKey)).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
    await expect(decodeGuestbookCursor(cursor, {
      audience: 'manager',
      eventId: crypto.randomUUID(),
      view: 'needs-review',
      source: 'photo_caption',
    }, sessionHmacKey)).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
  });

  it('rejects one-byte payload and signature tampering', async () => {
    const cursor = await encodeGuestbookCursor({
      version: 2,
      audience: 'guest',
      stream: 'shared',
      eventId,
      sessionId,
      createdAt: '2026-09-19T20:00:00.000Z',
      sourceRank: 1,
      id: '33333333-3333-4333-8333-333333333333',
    }, sessionHmacKey);
    const [payload, signature] = cursor.split('.') as [string, string];
    const binding = { audience: 'guest' as const, stream: 'shared' as const, eventId, sessionId };

    await expect(decodeGuestbookCursor(
      `${tamperOneByte(payload)}.${signature}`,
      binding,
      sessionHmacKey,
    )).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
    await expect(decodeGuestbookCursor(
      `${payload}.${tamperOneByte(signature)}`,
      binding,
      sessionHmacKey,
    )).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
  });

  it('rejects malformed, oversized, unsigned, and unsupported cursor payloads', async () => {
    const binding = { audience: 'guest' as const, stream: 'shared' as const, eventId, sessionId };
    const encoded = (value: unknown) => btoa(JSON.stringify(value))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/u, '');
    const invalid = [
      '',
      'not+a+cursor',
      'a'.repeat(513),
      encoded({ version: 3, audience: 'guest', stream: 'shared', eventId, sessionId }),
      encoded({
        version: 2,
        audience: 'guest',
        stream: 'shared',
        eventId,
        sessionId,
        createdAt: 'not-a-date',
        sourceRank: 2,
        id: 'not-a-uuid',
      }),
    ];

    for (const cursor of invalid) {
      await expect(decodeGuestbookCursor(cursor, binding, sessionHmacKey)).rejects.toMatchObject({
        code: 'VALIDATION_FAILED', status: 422,
      });
    }
  });

  it('marks an unversioned legacy message cursor as version 1 and re-emits its wire shape', () => {
    const cursor = encodeMessageCursor({
      version: 1,
      createdAt: '2026-09-19T20:00:00.000Z',
      id: '33333333-3333-4333-8333-333333333333',
    });
    expect(decodeMessageCursor(cursor)).toEqual({
      version: 1,
      createdAt: '2026-09-19T20:00:00.000Z',
      id: '33333333-3333-4333-8333-333333333333',
    });
    const decodedWire = JSON.parse(atob(
      cursor.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(cursor.length / 4) * 4, '='),
    ));
    expect(decodedWire).toEqual({
      createdAt: '2026-09-19T20:00:00.000Z',
      id: '33333333-3333-4333-8333-333333333333',
    });
  });
});

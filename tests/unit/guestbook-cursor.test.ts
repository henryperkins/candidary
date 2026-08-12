import { describe, expect, it } from 'vitest';

import {
  decodeGuestbookCursor,
  encodeGuestbookCursor,
} from '../../worker/http/guestbook-cursor';
import { decodeMessageCursor, encodeMessageCursor } from '../../worker/http/message-cursor';

const eventId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';

describe('guestbook cursors', () => {
  it('round-trips a version-2 guest cursor only for its event, session, and stream', () => {
    const cursor = encodeGuestbookCursor({
      version: 2,
      audience: 'guest',
      stream: 'shared',
      eventId,
      sessionId,
      createdAt: '2026-09-19T20:00:00.000Z',
      sourceRank: 1,
      id: '33333333-3333-4333-8333-333333333333',
    });

    expect(decodeGuestbookCursor(cursor, {
      audience: 'guest',
      stream: 'shared',
      eventId,
      sessionId,
    })).toEqual({
      version: 2,
      audience: 'guest',
      stream: 'shared',
      eventId,
      sessionId,
      createdAt: '2026-09-19T20:00:00.000Z',
      sourceRank: 1,
      id: '33333333-3333-4333-8333-333333333333',
    });

    for (const binding of [
      { audience: 'guest' as const, stream: 'own_unshared' as const, eventId, sessionId },
      { audience: 'guest' as const, stream: 'shared' as const, eventId, sessionId: crypto.randomUUID() },
      { audience: 'guest' as const, stream: 'shared' as const, eventId: crypto.randomUUID(), sessionId },
    ]) {
      expect(() => decodeGuestbookCursor(cursor, binding)).toThrowError(
        expect.objectContaining({ code: 'VALIDATION_FAILED', status: 422 }),
      );
    }
  });

  it('binds manager cursors to the event, view, and source filter', () => {
    const cursor = encodeGuestbookCursor({
      version: 2,
      audience: 'manager',
      eventId,
      view: 'needs-review',
      source: 'photo_caption',
      createdAt: '2026-09-19T20:00:00.000Z',
      sourceRank: 1,
      id: '33333333-3333-4333-8333-333333333333',
    });

    expect(decodeGuestbookCursor(cursor, {
      audience: 'manager',
      eventId,
      view: 'needs-review',
      source: 'photo_caption',
    })).toMatchObject({ version: 2, audience: 'manager', sourceRank: 1 });
    expect(() => decodeGuestbookCursor(cursor, {
      audience: 'manager',
      eventId,
      view: 'shared',
      source: 'photo_caption',
    })).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED', status: 422 }));
    expect(() => decodeGuestbookCursor(cursor, {
      audience: 'manager',
      eventId,
      view: 'needs-review',
      source: 'guest_note',
    })).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED', status: 422 }));
    expect(() => decodeGuestbookCursor(cursor, {
      audience: 'manager',
      eventId: crypto.randomUUID(),
      view: 'needs-review',
      source: 'photo_caption',
    })).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED', status: 422 }));
  });

  it('rejects malformed, oversized, and unsupported cursor payloads', () => {
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
      expect(() => decodeGuestbookCursor(cursor, binding)).toThrowError(
        expect.objectContaining({ code: 'VALIDATION_FAILED', status: 422 }),
      );
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

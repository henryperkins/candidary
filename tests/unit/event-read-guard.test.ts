import { describe, expect, it } from 'vitest';

import { createEventReadGuard } from '../../src/features/settings/event-read-guard';

describe('event read guard', () => {
  it('adopts a read that no write overlapped', () => {
    const guard = createEventReadGuard();
    const token = guard.openRead();
    expect(guard.adopt(token)).toBe(true);
  });

  it('drops a read that a write started under', () => {
    const guard = createEventReadGuard();
    const token = guard.openRead();
    guard.beginWrite();
    // The write may commit before this read's answer arrives, and that answer
    // was assembled from a row that is about to move.
    expect(guard.adopt(token)).toBe(false);
  });

  it('drops a read that a write finished under', () => {
    const guard = createEventReadGuard();
    guard.beginWrite();
    const token = guard.openRead();
    guard.endWrite();
    expect(guard.adopt(token)).toBe(false);
  });

  it('adopts a read taken after a write settled, which is the refresh case', () => {
    const guard = createEventReadGuard();
    guard.beginWrite();
    guard.endWrite();
    const token = guard.openRead();
    expect(guard.adopt(token)).toBe(true);
  });

  it('keeps concurrent reads independent', () => {
    const guard = createEventReadGuard();
    const first = guard.openRead();
    const second = guard.openRead();
    expect(guard.adopt(first)).toBe(true);
    guard.beginWrite();
    expect(guard.adopt(second)).toBe(false);
  });

  it('retries an explicit read until no write overlaps it', async () => {
    const guard = createEventReadGuard();
    let attempts = 0;

    const result = await guard.readFresh(async () => {
      attempts += 1;
      if (attempts === 1) {
        guard.beginWrite();
        guard.endWrite();
      }
      return attempts === 1 ? 8 : 9;
    });

    expect(result).toBe(9);
    expect(attempts).toBe(2);
  });
});

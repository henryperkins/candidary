import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { r2ImageReader } from '../../worker/storage/image-source';

describe('R2 image range source', () => {
  it('reads the pinned object version and refuses a replacement', async () => {
    const bucket = env.CANONICAL_MEDIA_BUCKET;
    const key = `image-source/${crypto.randomUUID()}`;
    const original = await bucket.put(key, Uint8Array.of(1, 2, 3, 4, 5));
    if (!original) throw new Error('Fixture object was not created.');
    const reader = r2ImageReader(bucket, key, original.etag, original.size);
    expect([...await reader.read(1, 3)]).toEqual([2, 3, 4]);
    await bucket.put(key, Uint8Array.of(9, 8, 7, 6, 5));
    await expect(reader.read(1, 3)).rejects.toMatchObject({ code: 'UPLOAD_FINALIZE_CONFLICT' });
    await bucket.delete(key);
  });

  it('refuses overflowing ranges before any object data is available', async () => {
    const reader = r2ImageReader(env.CANONICAL_MEDIA_BUCKET, 'never-created', 'etag', 12);
    await expect(reader.read(10, 3)).rejects.toThrow(/range|bounds/i);
    await expect(reader.read(Number.MAX_SAFE_INTEGER, 1)).rejects.toThrow(/range|bounds/i);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../worker/app';
import type { AppEnv } from '../../worker/env';
import { recordOriginalRead, recordPreviewRead } from '../../worker/observability/image-metrics';
import { eventAccess, resetDatabase, testEnv, uploadPending, withRecordingImages } from './helpers';

beforeEach(resetDatabase);
afterEach(() => { vi.restoreAllMocks(); });

function metered(base: AppEnv = testEnv) {
  const writeDataPoint = vi.fn();
  const env = Object.defineProperties(Object.create(base), { IMAGE_METRICS: { value: { writeDataPoint } } }) as AppEnv;
  return { env, writeDataPoint };
}
// Byte-identical apart from the per-request envelope ID that every response already varies.
async function snapshot(response: Response) {
  const bytes = new Uint8Array(await response.arrayBuffer());
  const json = (response.headers.get('content-type') ?? '').includes('application/json');
  const body = json ? (({ requestId: _requestId, ...rest }) => rest)(JSON.parse(new TextDecoder().decode(bytes))) : bytes;
  return { status: response.status, headers: [...response.headers.entries()], body };
}

describe('private image rehearsal metrics', () => {
  it('writes one identifier-free point per read and never throws without a usable binding', () => {
    const { env, writeDataPoint } = metered();
    recordOriginalRead(env, 'event-1', 'native-decode', 75 * 1024 ** 2);
    recordPreviewRead(env, 'event-1', 'persisted-hit', 1234);
    recordPreviewRead(env, 'event-1', 'denied');
    expect(writeDataPoint.mock.calls).toEqual([
      [{ indexes: ['event-1'], blobs: [env.IMAGE_DECODER_ENVIRONMENT, 'original-read', 'native-decode'], doubles: [75 * 1024 ** 2, 1] }],
      [{ indexes: ['event-1'], blobs: [env.IMAGE_DECODER_ENVIRONMENT, 'preview-read', 'persisted-hit'], doubles: [1234, 1] }],
      [{ indexes: ['event-1'], blobs: [env.IMAGE_DECODER_ENVIRONMENT, 'preview-read', 'denied'], doubles: [0, 1] }],
    ]);
    recordOriginalRead(env, 'x'.repeat(97), 'export', 1);
    recordOriginalRead(env, 'event-1', 'export', -1);
    expect(writeDataPoint).toHaveBeenLastCalledWith({ indexes: ['event-1'], blobs: [env.IMAGE_DECODER_ENVIRONMENT, 'original-read', 'export'], doubles: [0, 1] });
    expect(writeDataPoint).toHaveBeenCalledTimes(4);
    expect(testEnv.IMAGE_METRICS).toBeUndefined();
    expect(() => recordOriginalRead(testEnv, 'event-1', 'export', 1)).not.toThrow();
    const failing = Object.defineProperties(Object.create(testEnv), { IMAGE_METRICS: { value: { writeDataPoint: () => { throw new Error('dataset'); } } } }) as AppEnv;
    expect(() => recordPreviewRead(failing, 'event-1', 'persisted-hit', 1)).not.toThrow();
  });

  it('records a manager original download without changing the response', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'metered-original');
    const read = (env: AppEnv) => createApp().request(`/api/media/${media.id}/original`, { headers: { cookie: access.manager.cookie } }, env);
    const plain = await snapshot(await read(testEnv));
    const { env, writeDataPoint } = metered();
    const measured = await snapshot(await read(env));
    expect(plain.status).toBe(200);
    expect(measured).toEqual(plain);
    expect(writeDataPoint).toHaveBeenCalledOnce();
    expect(writeDataPoint).toHaveBeenCalledWith({ indexes: [media.eventId],
      blobs: [env.IMAGE_DECODER_ENVIRONMENT, 'original-read', 'original-download'], doubles: [media.byteSize, 1] });
  });

  it('records denied preview reads with the unchanged refusal and no original read', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'metered-denial');
    const other = await eventAccess('Other event');
    for (const cookie of [undefined, other.guest.cookie]) {
      const read = (env: AppEnv) => createApp().request(`/api/media/${media.id}/preview`, cookie ? { headers: { cookie } } : {}, env);
      const plain = await snapshot(await read(testEnv));
      const { env, writeDataPoint } = metered();
      const measured = await snapshot(await read(env));
      expect(plain.status).toBeGreaterThanOrEqual(400);
      expect(measured).toEqual(plain);
      expect(writeDataPoint.mock.calls).toEqual([[{ indexes: [media.eventId],
        blobs: [env.IMAGE_DECODER_ENVIRONMENT, 'preview-read', 'denied'], doubles: [0, 1] }]]);
    }
  });

  it('records an on-demand legacy Images preview together with its original read', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'metered-legacy');
    const images = withRecordingImages();
    const { env, writeDataPoint } = metered(images.env);
    const response = await createApp().request(`/api/media/${media.id}/preview`, { headers: { cookie: access.guest.cookie } }, env);
    expect(response.status).toBe(200);
    const served = (await response.arrayBuffer()).byteLength;
    expect(writeDataPoint.mock.calls).toEqual([
      [{ indexes: [media.eventId], blobs: [env.IMAGE_DECODER_ENVIRONMENT, 'original-read', 'images-transform'], doubles: [media.byteSize, 1] }],
      [{ indexes: [media.eventId], blobs: [env.IMAGE_DECODER_ENVIRONMENT, 'preview-read', 'legacy-images'], doubles: [served, 1] }],
    ]);
  });
});

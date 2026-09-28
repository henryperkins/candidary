import { createApp } from '../../../worker/app';
import { eventAccess, testEnv, writeHeaders } from '../helpers';
import type { TransferIdentity } from '../../../worker/db/upload-transfers';

export const TEST_FINGERPRINT = 'a'.repeat(64);
export const TEST_SHA = 'b'.repeat(64);
export const PART_BYTES = 8 * 1024 ** 2;

export async function reservedTransfer(byteSize = 64) {
  const access = await eventAccess();
  const response = await createApp().request(`/api/event/${access.event.slug}/uploads`, {
    method: 'POST', headers: writeHeaders(access.guest), body: JSON.stringify({
      filename: 'original.png', mimeType: 'image/png', byteSize, idempotencyKey: crypto.randomUUID(), guestName: 'Avery',
    }),
  }, testEnv);
  if (response.status !== 201) throw new Error(`Reservation failed ${response.status}: ${await response.text()}`);
  const { data } = await response.json<any>();
  const row = await testEnv.DB.prepare('SELECT * FROM media WHERE id = ?').bind(data.media.id).first<{ id: string; event_id: string; uploader_session_id: string }>();
  if (!row) throw new Error('Missing reserved media.');
  const now = new Date().toISOString();
  await testEnv.DB.prepare("UPDATE mobile_image_admission SET enabled = 1, revision = revision + 1, updated_at = ? WHERE case_id = 'png'").bind(now).run();
  const identity: TransferIdentity = { transferId: crypto.randomUUID(), mediaId: row.id, eventId: row.event_id,
    authority: { kind: 'guest', actorSessionId: row.uploader_session_id, eventSessionId: row.uploader_session_id } };
  return { access, identity, now, input: { ...identity, declared: { family: 'png' as const, mimeType: 'image/png', requiresSequence: false }, byteSize, now } };
}

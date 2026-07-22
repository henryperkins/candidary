import type { AppEnv } from '../env';
import { ExportsRepository } from '../db/exports';
import { MediaRepository } from '../db/media';

async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    if (page.objects.length) await bucket.delete(page.objects.map(({ key }) => key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

export async function cleanupExpiredReservations(env: AppEnv, now = new Date()): Promise<number> {
  const media = new MediaRepository(env.DB);
  let cleaned = 0;
  for (;;) {
    const expired = await media.listExpiredReservations(now.toISOString());
    if (!expired.length) break;
    for (const item of expired) {
      await env.MEDIA_BUCKET.delete(item.objectKey);
      await media.failReservation(item.id);
      cleaned += 1;
    }
    if (expired.length < 100) break;
  }
  return cleaned;
}

export async function cleanupExpiredExports(env: AppEnv, now = new Date()): Promise<number> {
  const expired = await new ExportsRepository(env.DB).expireReady(now.toISOString());
  await Promise.all(expired.filter(({ objectKey }) => objectKey).map(({ objectKey }) => env.MEDIA_BUCKET.delete(objectKey!)));
  return expired.length;
}

export async function deleteEventData(env: AppEnv, eventId: string, now = new Date()): Promise<void> {
  const timestamp = now.toISOString();
  await env.DB.batch([
    env.DB.prepare('UPDATE events SET deleted_at = COALESCE(deleted_at, ?) WHERE id = ?').bind(timestamp, eventId),
    env.DB.prepare('UPDATE event_access_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE event_id = ?').bind(timestamp, eventId),
    env.DB.prepare('UPDATE event_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE event_id = ?').bind(timestamp, eventId),
  ]);
  await deletePrefix(env.MEDIA_BUCKET, `events/${eventId}/`);
}

export async function scheduledCleanup(env: AppEnv, now = new Date()): Promise<void> {
  await cleanupExpiredReservations(env, now);
  await cleanupExpiredExports(env, now);
  const purged = await env.DB.prepare(`
    SELECT id FROM events WHERE deleted_at IS NULL AND purge_after <= ? LIMIT 100
  `).bind(now.toISOString()).all<{ id: string }>();
  for (const event of purged.results) await deleteEventData(env, event.id, now);
}

import type { AppEnv } from '../env';
import { NotificationService } from '../services/notifications';
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
  const repository = new ExportsRepository(env.DB);
  const expired = await repository.expireReady(now.toISOString());
  for (const job of expired) {
    const parts = await repository.listParts(job.id);
    const keys = [job.objectKey, job.manifestObjectKey, ...parts.map(({ objectKey }) => objectKey)]
      .filter((key): key is string => Boolean(key));
    if (keys.length) await env.MEDIA_BUCKET.delete(keys);
  }
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
  // Notifications go out before the purge, not after. The access warning is about
  // a deadline this same run may be enforcing, and sending it to a host whose event
  // has just been deleted would be worse than not sending it at all.
  await new NotificationService(env).run(now).catch((error: unknown) => {
    // Cleanup is the job that must not be skipped. A mail failure is logged and
    // dropped rather than allowed to abort the purge that follows it.
    console.error(JSON.stringify({ event: 'notifications_failed', message: String(error) }));
  });
  const purged = await env.DB.prepare(`
    SELECT id FROM events WHERE deleted_at IS NULL AND purge_after <= ? LIMIT 100
  `).bind(now.toISOString()).all<{ id: string }>();
  for (const event of purged.results) await deleteEventData(env, event.id, now);
}

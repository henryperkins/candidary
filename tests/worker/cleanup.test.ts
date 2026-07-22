import { beforeEach, describe, expect, it } from 'vitest';

import { AuthService } from '../../worker/auth/service';
import { MediaRepository } from '../../worker/db/media';
import { cleanupExpiredReservations, deleteEventData } from '../../worker/workflows/cleanup';
import { eventAccess, png, resetDatabase, testEnv } from './helpers';

describe('lifecycle cleanup', () => {
  beforeEach(resetDatabase);

  it('removes expired reserved objects and releases event quota', async () => {
    const access = await eventAccess();
    const repository = new MediaRepository(testEnv.DB);
    const media = await repository.reserve({
      id: crypto.randomUUID(), eventId: access.event.id, uploaderSessionId: (await new AuthService(testEnv).resolve(access.guest.cookie.split('=')[1]!.split(';')[0])).session.id,
      objectKey: `events/${access.event.id}/media/stale`, originalFilename: 'stale.png', mimeType: 'image/png',
      declaredByteSize: 64, guestName: 'Avery', caption: null, idempotencyKey: 'stale',
      reservationExpiresAt: '2026-07-21T12:00:00.000Z', createdAt: '2026-07-21T11:45:00.000Z',
    });
    await testEnv.MEDIA_BUCKET.put(media.objectKey, png());
    expect(await cleanupExpiredReservations(testEnv, new Date('2026-07-21T12:01:00.000Z'))).toBe(1);
    expect(await testEnv.MEDIA_BUCKET.head(media.objectKey)).toBeNull();
    const event = await testEnv.DB.prepare('SELECT reserved_media_count FROM events WHERE id = ?').bind(access.event.id).first<any>();
    expect(event.reserved_media_count).toBe(0);
  });

  it('marks an event inaccessible before deleting its object prefix', async () => {
    const access = await eventAccess();
    await testEnv.MEDIA_BUCKET.put(`events/${access.event.id}/media/orphan`, png());
    await deleteEventData(testEnv, access.event.id, new Date('2026-07-21T12:00:00.000Z'));
    const rows = await testEnv.MEDIA_BUCKET.list({ prefix: `events/${access.event.id}/` });
    expect(rows.objects).toHaveLength(0);
    const event = await testEnv.DB.prepare('SELECT deleted_at FROM events WHERE id = ?').bind(access.event.id).first<any>();
    expect(event.deleted_at).toBeTruthy();
    const tokens = await testEnv.DB.prepare('SELECT count(*) AS count FROM event_access_tokens WHERE event_id = ? AND revoked_at IS NULL').bind(access.event.id).first<any>();
    expect(tokens.count).toBe(0);
  });
});

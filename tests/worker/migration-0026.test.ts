import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrationOnly, migrationsUpTo, orderedMigrations } from './helpers';
import { cookiesFrom, eventAccess, futureCalendarDate, origin, png, seedExportJob, testEnv, trashMedia, uploadPending, writeHeaders } from './helpers';
import { createApp as createBaselineApp } from '../../output/verification/mobile-image-baseline/baseline-app.mjs';
import { MediaObjectWriteTombstoneRepository } from '../../worker/db/media-write-tombstones';

beforeEach(reset);
describe('0026 mobile image ownership migration', () => {
  it('starts fresh with a protected schema marker and every admission case disabled', async () => {
    await applyD1Migrations(env.DB, orderedMigrations);
    expect(await env.DB.prepare('SELECT * FROM mobile_image_schema').first()).toEqual({ singleton: 1, version: 26, protocol: 1 });
    expect(await env.DB.prepare('SELECT count(*) AS n FROM mobile_image_admission WHERE enabled = 1').first()).toEqual({ n: 0 });
    await expect(env.DB.prepare('UPDATE mobile_image_schema SET protocol = 2').run()).rejects.toThrow();
    await expect(env.DB.prepare('DELETE FROM mobile_image_schema').run()).rejects.toThrow();
  });

  it('widens the stored MIME check while preserving all prior schema objects', async () => {
    await applyD1Migrations(env.DB, migrationsUpTo('0026'));
    const before = (await env.DB.prepare("SELECT name, type, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name").all()).results;
    expect(await env.DB.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'media_upload_transfers'").first()).toEqual({ n: 0 });
    await applyD1Migrations(env.DB, [migrationOnly('0026')]);
    const after = (await env.DB.prepare("SELECT name, type, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name").all()).results;
    for (const object of before) {
      if (object.name === 'media') continue;
      const expected = {...object};
      if (object.name === 'media_object_promotion_reservation_capability_guard') {
        expected.sql = String(object.sql).replace("AND p.state = 'pending'", `AND (p.state = 'pending' OR (p.state = 'copying'
        AND OLD.upload_state = 'reserved' AND NEW.upload_state = 'reserved'
        AND NEW.object_key = OLD.object_key AND NEW.object_bucket_generation = OLD.object_bucket_generation
        AND p.source_writable_until >= NEW.reservation_expires_at
        AND EXISTS (SELECT 1 FROM media_upload_transfers t JOIN media_upload_assemblies a ON a.transfer_id = t.id
          AND a.attempt = t.attempt AND a.generation = t.generation
          WHERE t.media_id = NEW.id AND t.event_id = NEW.event_id AND t.state = 'processing'
            AND t.completion_token = p.claim_token AND a.completion_token = p.claim_token
            AND a.state = 'completing' AND a.writer_settled_at IS NULL
            AND p.source_etag = 'assembly:' || a.id || ':' || a.expected_sha256
            AND p.source_sha256 = a.expected_sha256 AND p.source_byte_size = a.expected_byte_size
            AND t.expires_at >= NEW.reservation_expires_at AND t.hard_expires_at >= t.expires_at
            AND t.completion_lease_expires_at = p.lease_expires_at)))`);
      }
      if (['media_object_write_tombstone_guard_insert','media_object_write_tombstone_guard_update'].includes(String(object.name))) {
        expected.sql = String(object.sql).replaceAll('(t.event_id = NEW.event_id AND t.media_id = NEW.id)', `(t.event_id = NEW.event_id AND t.media_id = NEW.id
              AND NOT (t.bucket_generation = 'canonical' AND t.object_kind = 'preview'
                AND EXISTS (SELECT 1 FROM media_image_previews p WHERE p.object_key = t.object_key
                  AND p.event_id = t.event_id AND p.media_id = t.media_id AND p.state = 'suppressed')))`);
      }
      expect(after.find((item) => item.name === object.name), String(object.name)).toEqual(expected);
    }
    expect((after.find((item) => item.name === 'media')?.sql as string)).toContain("'image/dng'");
    expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });

  it('preserves every media field, promotion, counter, sequence and export hold in a populated upgrade', async () => {
    // A genuine grandfathered legacy row is installed before the 0015 fence.
    await applyD1Migrations(env.DB, migrationsUpTo('0015'));
    const now = new Date().toISOString();
    const later = new Date(Date.now() + 365 * 86400000).toISOString();
    await env.DB.prepare("INSERT INTO events (id,slug,name,event_date,welcome_message,guest_access_expires_at,management_access_expires_at,purge_after,created_at) VALUES ('legacy','legacy','Legacy','2026-09-19','Welcome',?,?,?,?)").bind(later,later,later,now).run();
    await env.DB.prepare("INSERT INTO event_access_tokens (id,event_id,role,secret_digest,secret_ciphertext,expires_at,created_at) VALUES ('legacy-token','legacy','guest','digest','cipher',?,?)").bind(later,now).run();
    await env.DB.prepare("INSERT INTO event_sessions (id,secret_digest,event_id,access_token_id,role,csrf_digest,expires_at,created_at) VALUES ('legacy-session','digest','legacy','legacy-token','guest','csrf',?,?)").bind(later,now).run();
    await env.DB.prepare("INSERT INTO media (id,event_id,uploader_session_id,object_key,original_filename,mime_type,declared_byte_size,byte_size,width,height,guest_name,upload_state,publication_status,idempotency_key,reservation_expires_at,created_at) VALUES ('legacy-photo','legacy','legacy-session','events/legacy/media/legacy-photo','legacy.jpg','image/jpeg',20,20,4,3,'Avery','stored','unpublished','legacy',?,?)").bind(later,now).run();
    await env.DB.prepare("UPDATE events SET stored_media_count = 1, stored_bytes = 20 WHERE id = 'legacy'").run();
    const remaining = migrationsUpTo('0026').filter((migration) => migration.name >= '0015');
    await applyD1Migrations(env.DB, remaining);
    const access = await eventAccess();
    const held = await uploadPending(access, 'held');
    const trashed = await uploadPending(access, 'trashed');
    const deleted = await uploadPending(access, 'deleted');
    await trashMedia(access, trashed.id);
    await env.DB.prepare("UPDATE media SET deleted_at = ?, upload_state = 'deleted' WHERE id = ?").bind(now,deleted.id).run();
    const reserved = await createBaselineApp().request(`/api/event/${access.event.slug}/uploads`, { method: 'POST', headers: writeHeaders(access.guest), body: JSON.stringify({ filename:'pending.png',mimeType:'image/png',byteSize:64,idempotencyKey:'pending',guestName:'Avery' }) }, testEnv);
    expect(reserved.status).toBe(201);
    await seedExportJob({ id: 'held-export',eventId: access.event.id,snapshotAt: now,media:[held],executionProtocol:'legacy' });
    const snapshot = async () => {
      const data: Record<string, unknown[]> = {};
      for (const table of ['media','media_object_promotions','events','export_jobs','export_media_entries','media_object_write_tombstones']) data[table] = (await env.DB.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results;
      return data;
    };
    const before = await snapshot();
    expect(Object.keys(before.media![0] as object)).toHaveLength(29);
    expect(before.media_object_promotions!.length).toBeGreaterThan(0);
    await expect(env.DB.prepare("UPDATE media SET mime_type = 'image/dng' WHERE id = ?").bind(held.id).run()).rejects.toThrow();
    await applyD1Migrations(env.DB, [migrationOnly('0026')]);
    expect(await snapshot()).toEqual(before);
    expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    await expect(env.DB.prepare("UPDATE media_object_write_tombstones SET suppression_started_at = ? WHERE object_key = ? AND bucket_generation = 'canonical'").bind(now,held.objectKey).run()).rejects.toThrow('active export holds');
    await expect(env.DB.prepare("UPDATE media SET preview_object_key = 'forbidden' WHERE id = ?").bind(held.id).run()).rejects.toThrow();
    expect(await new MediaObjectWriteTombstoneRepository(env.DB).beginSuppression(trashed.objectKey, now, 'canonical')).toBe(false);
    const restore = await createBaselineApp().request(`/api/manage/events/${access.event.id}/media/${trashed.id}/restore`, { method:'POST',headers:writeHeaders(access.manager),body:'{}' }, testEnv);
    expect(restore.status).toBe(200);
  });

  it('runs the actual baseline application against 0026 with extended intake closed', async () => {
    await applyD1Migrations(env.DB, orderedMigrations);
    const app = createBaselineApp();
    const created = await app.request('/api/events', { method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify({name:'Old Worker',eventDate:futureCalendarDate(30),welcomeMessage:'Welcome.',eventTimezone:'America/Chicago',rsvpDeadlineDate:futureCalendarDate(16)}) }, testEnv);
    expect(created.status).toBe(201);
    const { data } = await created.json<any>();
    const manager = { ...cookiesFrom(created),csrf:data.csrfToken };
    const exchanged = await app.request('/api/entry/exchange', { method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify({token:new URL(data.eventLink).hash.slice(1)}) },testEnv);
    const guest = cookiesFrom(exchanged);
    expect((await app.request(`/api/manage/events/${data.event.id}/photo-intake`,{method:'POST',headers:writeHeaders(manager),body:JSON.stringify({action:'open_early'})},testEnv)).status).toBe(200);
    const bytes = png();
    const reserved = await app.request(`/api/event/${data.event.slug}/uploads`, {method:'POST',headers:writeHeaders(guest),body:JSON.stringify({filename:'old.png',mimeType:'image/png',byteSize:bytes.byteLength,idempotencyKey:'baseline-original',guestName:'Avery'})},testEnv);
    expect(reserved.status).toBe(201);
    const media = (await reserved.json<any>()).data.media;
    const put = () => app.request(`/api/event/${data.event.slug}/uploads/${media.id}/content`,{method:'PUT',headers:{...writeHeaders(guest),'content-type':'image/png','content-length':String(bytes.byteLength)},body:bytes},testEnv);
    expect((await put()).status).toBe(200);
    expect((await put()).status).toBe(200);
    const row = await env.DB.prepare('SELECT * FROM media WHERE id = ?').bind(media.id).first<any>();
    expect(row).toMatchObject({upload_state:'stored',byte_size:bytes.byteLength,delivery_sequence:1,publication_status:'unpublished'});
    expect(new Uint8Array(await (await env.CANONICAL_MEDIA_BUCKET.get(row.object_key))!.arrayBuffer())).toEqual(bytes);
    expect(await env.DB.prepare('SELECT reserved_media_count,stored_media_count,reserved_bytes,stored_bytes FROM events WHERE id = ?').bind(data.event.id).first()).toEqual({reserved_media_count:0,stored_media_count:1,reserved_bytes:0,stored_bytes:bytes.byteLength});
    for (const action of ['trash','restore']) expect((await app.request(`/api/manage/events/${data.event.id}/media/${media.id}/${action}`,{method:'POST',headers:writeHeaders(manager),body:'{}'},testEnv)).status).toBe(200);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM mobile_image_admission WHERE enabled = 1').first()).toEqual({n:0});
  });
});

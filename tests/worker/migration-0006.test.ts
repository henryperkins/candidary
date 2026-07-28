import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';

import type { AppEnv } from '../../worker/env';

interface Migration { name: string; queries: string[] }

const testEnv = env as AppEnv & { TEST_MIGRATIONS: string };
const migrations = JSON.parse(testEnv.TEST_MIGRATIONS) as Migration[];

function upTo(name: string): Migration[] {
  const index = migrations.findIndex((migration) => migration.name.startsWith(name));
  if (index === -1) throw new Error(`No migration named ${name}.`);
  return migrations.slice(0, index);
}

function only(name: string): Migration {
  const found = migrations.find((migration) => migration.name.startsWith(name));
  if (!found) throw new Error(`No migration named ${name}.`);
  return found;
}

beforeEach(reset);

it('applies 0006 without rebuilding populated event sessions', async () => {
  await applyD1Migrations(env.DB, upTo('0006'));

  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO events (id, slug, name, event_date, welcome_message,
        guest_access_expires_at, management_access_expires_at, purge_after, created_at)
      VALUES ('event-1', 'maya-theo', 'Maya & Theo', '2026-09-19', 'Welcome.', ?, ?, ?, ?)
    `).bind(now, now, now, now),
    env.DB.prepare(`
      INSERT INTO event_access_tokens (id, event_id, role, secret_digest, secret_ciphertext, expires_at, created_at)
      VALUES ('token-1', 'event-1', 'guest', 'digest', 'cipher', ?, ?)
    `).bind(now, now),
    env.DB.prepare(`
      INSERT INTO event_sessions (id, secret_digest, csrf_digest, event_id, access_token_id, role, expires_at, created_at)
      VALUES ('session-1', 'digest', 'csrf', 'event-1', 'token-1', 'guest', ?, ?)
    `).bind(now, now),
    env.DB.prepare(`
      INSERT INTO media (id, event_id, uploader_session_id, object_key, original_filename, mime_type,
        declared_byte_size, guest_name, upload_state, publication_status, idempotency_key,
        reservation_expires_at, created_at)
      VALUES ('media-1', 'event-1', 'session-1', 'events/event-1/a.jpg', 'a.jpg', 'image/jpeg',
        1024, 'Ada', 'stored', 'unpublished', 'key-1', ?, ?)
    `).bind(now, now),
    env.DB.prepare(`
      INSERT INTO guest_messages (id, event_id, guest_session_id, guest_name, body, moderation_status, created_at)
      VALUES ('message-1', 'event-1', 'session-1', 'Ada', 'Congratulations!', 'approved', ?)
    `).bind(now),
  ]);

  await applyD1Migrations(env.DB, [only('0006')]);
  await env.DB.prepare(`
    INSERT INTO events (id, slug, name, event_date, welcome_message,
      guest_access_expires_at, management_access_expires_at, purge_after, created_at)
    VALUES ('event-2', 'new-event', 'New event', '2026-09-20', 'Welcome.', ?, ?, ?, ?)
  `).bind(now, now, now, now).run();

  expect(await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM event_sessions WHERE id = 'session-1'",
  ).first('count')).toBe(1);
  expect(await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM media WHERE uploader_session_id = 'session-1'",
  ).first('count')).toBe(1);
  expect(await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM guest_messages WHERE guest_session_id = 'session-1'",
  ).first('count')).toBe(1);
  expect(await env.DB.prepare(
    "SELECT legacy_owner_claim_open FROM events WHERE id = 'event-1'",
  ).first('legacy_owner_claim_open')).toBe(1);
  expect(await env.DB.prepare(
    "SELECT legacy_owner_claim_open FROM events WHERE id = 'event-2'",
  ).first('legacy_owner_claim_open')).toBe(0);
});

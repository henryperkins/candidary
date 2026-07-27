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

// KNOWN DEFECT, asserted rather than described. Every other suite applies the whole
// migration set to an empty database, which is the one case where 0006 cannot fail —
// so nothing caught that `DROP TABLE event_sessions` violates the ON DELETE RESTRICT
// references `media` and `guest_messages` hold against it. `PRAGMA
// defer_foreign_keys` does not cover this: RESTRICT is enforced immediately even for
// deferred constraints.
//
// `it.fails` keeps this green while the defect stands and turns it red the moment
// the migration or the deployment procedure fixes it, which is the point — whoever
// fixes it has to come here and drop the `.fails` rather than leave a test that
// quietly asserts the old broken behaviour forever.
it.fails('applies 0006 to a database that already holds sessions and media', async () => {
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
  ]);

  await applyD1Migrations(env.DB, [only('0006')]);

  const accounts = await env.DB.prepare("SELECT name FROM sqlite_master WHERE name = 'host_accounts'").first();
  expect(accounts).not.toBeNull();
});

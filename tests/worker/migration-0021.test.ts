import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { migrationOnly, migrationsUpTo } from './helpers';

const NOW = '2026-08-27T00:00:00.000Z';
const EARLIER = '2026-08-26T00:00:00.000Z';
const LATER = '2026-08-28T00:00:00.000Z';
const EXPIRES_AT = '2026-10-01T00:00:00.000Z';
const PURGE_AFTER = '2026-11-01T00:00:00.000Z';
const PICKED_AT = '2026-08-27T01:00:00.000Z';
const TRASHED_AT = '2026-08-27T02:00:00.000Z';
const RESTORE_UNTIL = '2026-09-26T02:00:00.000Z';
const DELETED_AT = '2026-08-27T03:00:00.000Z';

async function applyThrough0020() {
  await applyD1Migrations(env.DB, [
    ...migrationsUpTo('0020'),
    migrationOnly('0020'),
  ]);
}

async function apply0021() {
  await applyD1Migrations(env.DB, [migrationOnly('0021')]);
}

async function applyFresh0021() {
  await applyThrough0020();
  await apply0021();
}

async function seedEvent(id: string) {
  await env.DB.prepare(`
    INSERT INTO events (
      id, slug, name, event_date, welcome_message,
      guest_access_expires_at, management_access_expires_at, purge_after, created_at
    ) VALUES (?, ?, 'Maya & Theo', '2026-09-19', 'Welcome.', ?, ?, ?, ?)
  `).bind(id, id, EXPIRES_AT, EXPIRES_AT, PURGE_AFTER, NOW).run();
}

async function seedAccount(id: string) {
  await env.DB.prepare(`
    INSERT INTO host_accounts (id, email, password_hash, created_at)
    VALUES (?, ?, 'password-hash', ?)
  `).bind(id, `${id}@example.com`, NOW).run();
}

async function seedMembership(eventId: string, accountId: string) {
  await env.DB.prepare(`
    INSERT INTO event_hosts (event_id, account_id, role, created_at)
    VALUES (?, ?, 'owner', ?)
  `).bind(eventId, accountId, NOW).run();
}

interface TokenFixture {
  id: string;
  eventId: string;
  role?: 'guest' | 'manager';
  createdAt?: string;
  revokedAt?: string | null;
}

function insert0020Token(fixture: TokenFixture) {
  const role = fixture.role ?? 'manager';
  return env.DB.prepare(`
    INSERT INTO event_access_tokens (
      id, event_id, role, secret_digest, secret_ciphertext,
      expires_at, revoked_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    fixture.id,
    fixture.eventId,
    role,
    `digest-${fixture.id}`,
    role === 'guest' ? `ciphertext-${fixture.id}` : null,
    EXPIRES_AT,
    fixture.revokedAt ?? null,
    fixture.createdAt ?? NOW,
  ).run();
}

/** The exact seven-column INSERT issued by the 0020 TokensRepository. */
function insertOld0020WorkerManagerToken(fixture: Pick<TokenFixture, 'id' | 'eventId' | 'createdAt'>) {
  return env.DB.prepare(`
    INSERT INTO event_access_tokens (
      id, event_id, role, secret_digest, secret_ciphertext, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    fixture.id,
    fixture.eventId,
    'manager',
    `digest-${fixture.id}`,
    null,
    EXPIRES_AT,
    fixture.createdAt ?? NOW,
  ).run();
}

interface SessionFixture {
  id: string;
  eventId: string;
  accessTokenId: string;
  role?: 'guest' | 'manager';
  canClaimOwner?: 0 | 1;
  revokedAt?: string | null;
  managerUploadAccountId?: string | null;
}

function insert0020Session(fixture: SessionFixture) {
  return env.DB.prepare(`
    INSERT INTO event_sessions (
      id, secret_digest, event_id, access_token_id, role, csrf_digest,
      expires_at, revoked_at, created_at, can_claim_owner
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    fixture.id,
    `digest-${fixture.id}`,
    fixture.eventId,
    fixture.accessTokenId,
    fixture.role ?? 'manager',
    `csrf-${fixture.id}`,
    EXPIRES_AT,
    fixture.revokedAt ?? null,
    NOW,
    fixture.canClaimOwner ?? 0,
  ).run();
}

function insertActorSession(fixture: SessionFixture) {
  return env.DB.prepare(`
    INSERT INTO event_sessions (
      id, secret_digest, event_id, access_token_id, role, csrf_digest,
      expires_at, revoked_at, created_at, can_claim_owner, manager_upload_account_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    fixture.id,
    `digest-${fixture.id}`,
    fixture.eventId,
    fixture.accessTokenId,
    fixture.role ?? 'manager',
    `csrf-${fixture.id}`,
    EXPIRES_AT,
    fixture.revokedAt ?? null,
    NOW,
    fixture.canClaimOwner ?? 0,
    fixture.managerUploadAccountId ?? null,
  ).run();
}

async function seedGuestSession(eventId: string) {
  const tokenId = `guest-token-${eventId}`;
  const sessionId = `guest-session-${eventId}`;
  await insert0020Token({ id: tokenId, eventId, role: 'guest' });
  await insert0020Session({ id: sessionId, eventId, accessTokenId: tokenId, role: 'guest' });
  return sessionId;
}

interface MediaFixture {
  id: string;
  eventId: string;
  uploaderSessionId: string;
  uploadState?: 'stored' | 'deleted';
  deletedAt?: string | null;
  trashedAt?: string | null;
  restoreUntil?: string | null;
  favoritedAt?: string | null;
  albumPickVersion?: 1 | null;
}

function insert0020Media(fixture: MediaFixture) {
  return env.DB.prepare(`
    INSERT INTO media (
      id, event_id, uploader_session_id, object_key, object_bucket_generation,
      preview_object_key, original_filename, mime_type, declared_byte_size, byte_size,
      width, height, guest_name, upload_state, publication_status, idempotency_key,
      reservation_expires_at, created_at, stored_at, timeline_at, favorited_at,
      deleted_at, trashed_at, restore_until
    ) VALUES (
      ?, ?, ?, ?, 'canonical', NULL, ?, 'image/jpeg', 12, 12,
      4, 3, 'Avery Stone', ?, 'unpublished', ?,
      ?, ?, ?, ?, ?, ?, ?, ?
    )
  `).bind(
    fixture.id,
    fixture.eventId,
    fixture.uploaderSessionId,
    `events/${fixture.eventId}/media/final/${fixture.id}`,
    `${fixture.id}.jpg`,
    fixture.uploadState ?? 'stored',
    `idem-${fixture.id}`,
    EXPIRES_AT,
    NOW,
    fixture.uploadState === 'deleted' ? NOW : NOW,
    NOW,
    fixture.favoritedAt ?? null,
    fixture.deletedAt ?? null,
    fixture.trashedAt ?? null,
    fixture.restoreUntil ?? null,
  ).run();
}

function insertMedia(fixture: MediaFixture) {
  return env.DB.prepare(`
    INSERT INTO media (
      id, event_id, uploader_session_id, object_key, object_bucket_generation,
      preview_object_key, original_filename, mime_type, declared_byte_size, byte_size,
      width, height, guest_name, upload_state, publication_status, idempotency_key,
      reservation_expires_at, created_at, stored_at, timeline_at, favorited_at,
      deleted_at, trashed_at, restore_until, album_pick_version
    ) VALUES (
      ?, ?, ?, ?, 'canonical', NULL, ?, 'image/jpeg', 12, 12,
      4, 3, 'Avery Stone', ?, 'unpublished', ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `).bind(
    fixture.id,
    fixture.eventId,
    fixture.uploaderSessionId,
    `events/${fixture.eventId}/media/final/${fixture.id}`,
    `${fixture.id}.jpg`,
    fixture.uploadState ?? 'stored',
    `idem-${fixture.id}`,
    EXPIRES_AT,
    NOW,
    NOW,
    NOW,
    fixture.favoritedAt ?? null,
    fixture.deletedAt ?? null,
    fixture.trashedAt ?? null,
    fixture.restoreUntil ?? null,
    fixture.albumPickVersion ?? null,
  ).run();
}

async function seedAlbum(eventId: string, savedAt: string | null) {
  await env.DB.prepare(`
    INSERT INTO event_albums (event_id, entries, saved_at, revision, created_at, updated_at)
    VALUES (?, '[]', ?, 0, ?, ?)
  `).bind(eventId, savedAt, NOW, NOW).run();
}

async function eventGeneration(eventId: string): Promise<number> {
  const row = await env.DB.prepare(`
    SELECT album_pick_generation AS generation FROM events WHERE id = ?
  `).bind(eventId).first<{ generation: number }>();
  if (!row) throw new Error(`Missing event ${eventId}.`);
  return row.generation;
}

describe('migration 0021 Manager upload actor authority', () => {
  beforeEach(reset);

  it('normalizes duplicate live Manager tokens by newest created_at and rejects another live token', async () => {
    await applyThrough0020();
    await seedEvent('event-a');
    await insert0020Token({ id: 'manager-older', eventId: 'event-a', createdAt: EARLIER });
    await insert0020Token({ id: 'manager-newer', eventId: 'event-a', createdAt: LATER });
    await insert0020Session({
      id: 'session-older', eventId: 'event-a', accessTokenId: 'manager-older',
    });
    await insert0020Session({
      id: 'session-newer', eventId: 'event-a', accessTokenId: 'manager-newer',
    });

    await apply0021();

    expect(await env.DB.prepare(`
      SELECT id, revoked_at FROM event_access_tokens
      WHERE event_id = 'event-a' AND role = 'manager' ORDER BY id
    `).all()).toMatchObject({ results: [
      { id: 'manager-newer', revoked_at: null },
      { id: 'manager-older', revoked_at: expect.any(String) },
    ] });
    expect(await env.DB.prepare(`
      SELECT id, revoked_at FROM event_sessions ORDER BY id
    `).all()).toMatchObject({ results: [
      { id: 'session-newer', revoked_at: null },
      { id: 'session-older', revoked_at: expect.any(String) },
    ] });
    await expect(insert0020Token({ id: 'manager-third', eventId: 'event-a' }))
      .rejects.toThrow();
  });

  it('uses id DESC to retain one duplicate live Manager token when created_at ties', async () => {
    await applyThrough0020();
    await seedEvent('event-a');
    await insert0020Token({ id: 'manager-a', eventId: 'event-a', createdAt: NOW });
    await insert0020Token({ id: 'manager-z', eventId: 'event-a', createdAt: NOW });
    await insert0020Session({
      id: 'session-a', eventId: 'event-a', accessTokenId: 'manager-a',
    });
    await insert0020Session({
      id: 'session-z', eventId: 'event-a', accessTokenId: 'manager-z',
    });

    await apply0021();

    expect(await env.DB.prepare(`
      SELECT id FROM event_access_tokens
      WHERE event_id = 'event-a' AND role = 'manager' AND revoked_at IS NULL
    `).first()).toEqual({ id: 'manager-z' });
    expect(await env.DB.prepare(`
      SELECT id FROM event_sessions WHERE revoked_at IS NULL
    `).first()).toEqual({ id: 'session-z' });
  });

  it('enforces one live account actor and permits a fresh actor after revocation', async () => {
    await applyFresh0021();
    await seedEvent('event-a');
    await seedAccount('account-a');
    await insert0020Token({ id: 'manager-token', eventId: 'event-a' });
    await insertActorSession({
      id: 'actor-a', eventId: 'event-a', accessTokenId: 'manager-token',
      managerUploadAccountId: 'account-a',
    });

    await expect(insertActorSession({
      id: 'actor-b', eventId: 'event-a', accessTokenId: 'manager-token',
      managerUploadAccountId: 'account-a',
    })).rejects.toThrow();

    await env.DB.prepare(`
      UPDATE event_sessions SET revoked_at = ? WHERE id = 'actor-a'
    `).bind(NOW).run();
    await expect(insertActorSession({
      id: 'actor-b', eventId: 'event-a', accessTokenId: 'manager-token',
      managerUploadAccountId: 'account-a',
    })).resolves.toBeDefined();
  });

  it('rejects guest or owner-claim account actors but leaves null actor sessions unaffected', async () => {
    await applyFresh0021();
    await seedEvent('event-a');
    await seedAccount('account-a');
    await insert0020Token({ id: 'manager-token', eventId: 'event-a' });
    await insert0020Token({ id: 'guest-token', eventId: 'event-a', role: 'guest' });

    await expect(insertActorSession({
      id: 'guest-actor', eventId: 'event-a', accessTokenId: 'guest-token', role: 'guest',
      managerUploadAccountId: 'account-a',
    })).rejects.toThrow(/manager upload actor/iu);
    await expect(insertActorSession({
      id: 'claiming-actor', eventId: 'event-a', accessTokenId: 'manager-token',
      canClaimOwner: 1, managerUploadAccountId: 'account-a',
    })).rejects.toThrow(/manager upload actor/iu);

    await insertActorSession({
      id: 'ordinary-guest', eventId: 'event-a', accessTokenId: 'guest-token', role: 'guest',
    });
    await insertActorSession({
      id: 'ordinary-claiming-manager', eventId: 'event-a', accessTokenId: 'manager-token',
      canClaimOwner: 1,
    });
    await expect(env.DB.prepare(`
      UPDATE event_sessions SET manager_upload_account_id = 'account-a'
      WHERE id = 'ordinary-guest'
    `).run()).rejects.toThrow(/manager upload actor/iu);
    await expect(env.DB.prepare(`
      UPDATE event_sessions SET manager_upload_account_id = 'account-a'
      WHERE id = 'ordinary-claiming-manager'
    `).run()).rejects.toThrow(/manager upload actor/iu);

    await expect(insertActorSession({
      id: 'null-actor-unaffected', eventId: 'event-a', accessTokenId: 'guest-token', role: 'guest',
      canClaimOwner: 1, managerUploadAccountId: null,
    })).resolves.toBeDefined();
    await expect(env.DB.prepare(`
      UPDATE event_sessions SET role = 'guest', can_claim_owner = 1
      WHERE id = 'null-actor-unaffected'
    `).run()).resolves.toBeDefined();
  });

  it('enforces the account actor foreign key', async () => {
    await applyFresh0021();
    await seedEvent('event-a');
    await insert0020Token({ id: 'manager-token', eventId: 'event-a' });

    await expect(insertActorSession({
      id: 'missing-account-actor', eventId: 'event-a', accessTokenId: 'manager-token',
      managerUploadAccountId: 'account-missing',
    })).rejects.toThrow(/foreign key/iu);
  });

  it('revokes an account actor with membership deletion and requires a fresh identity after re-add', async () => {
    await applyFresh0021();
    await seedEvent('event-a');
    await seedAccount('account-a');
    await seedMembership('event-a', 'account-a');
    await insert0020Token({ id: 'manager-token', eventId: 'event-a' });
    await insertActorSession({
      id: 'actor-old', eventId: 'event-a', accessTokenId: 'manager-token',
      managerUploadAccountId: 'account-a',
    });

    await env.DB.prepare(`
      DELETE FROM event_hosts WHERE event_id = 'event-a' AND account_id = 'account-a'
    `).run();
    expect(await env.DB.prepare(`
      SELECT revoked_at FROM event_sessions WHERE id = 'actor-old'
    `).first()).toEqual({ revoked_at: expect.any(String) });

    await seedMembership('event-a', 'account-a');
    expect(await env.DB.prepare(`
      SELECT revoked_at FROM event_sessions WHERE id = 'actor-old'
    `).first()).toEqual({ revoked_at: expect.any(String) });
    await expect(insertActorSession({
      id: 'actor-fresh', eventId: 'event-a', accessTokenId: 'manager-token',
      managerUploadAccountId: 'account-a',
    })).resolves.toBeDefined();
  });
});

describe('migration 0021 Album era and generation', () => {
  beforeEach(reset);

  it('backfills only picked rows belonging to saved Albums', async () => {
    await applyThrough0020();
    await seedEvent('event-saved');
    await seedEvent('event-unsaved');
    await seedEvent('event-no-album');
    const savedSession = await seedGuestSession('event-saved');
    const unsavedSession = await seedGuestSession('event-unsaved');
    const noAlbumSession = await seedGuestSession('event-no-album');
    await seedAlbum('event-saved', NOW);
    await seedAlbum('event-unsaved', null);
    await insert0020Media({
      id: 'saved-picked', eventId: 'event-saved', uploaderSessionId: savedSession,
      favoritedAt: PICKED_AT,
    });
    await insert0020Media({
      id: 'saved-unpicked', eventId: 'event-saved', uploaderSessionId: savedSession,
    });
    await insert0020Media({
      id: 'unsaved-picked', eventId: 'event-unsaved', uploaderSessionId: unsavedSession,
      favoritedAt: PICKED_AT,
    });
    await insert0020Media({
      id: 'no-album-picked', eventId: 'event-no-album', uploaderSessionId: noAlbumSession,
      favoritedAt: PICKED_AT,
    });

    await apply0021();

    expect(await env.DB.prepare(`
      SELECT id, album_pick_version FROM media ORDER BY id
    `).all()).toMatchObject({ results: [
      { id: 'no-album-picked', album_pick_version: null },
      { id: 'saved-picked', album_pick_version: 1 },
      { id: 'saved-unpicked', album_pick_version: null },
      { id: 'unsaved-picked', album_pick_version: null },
    ] });
  });

  it('commits the predecessor-shaped pick and stamps version 1', async () => {
    await applyFresh0021();
    await seedEvent('event-a');
    const sessionId = await seedGuestSession('event-a');
    await insertMedia({ id: 'media-a', eventId: 'event-a', uploaderSessionId: sessionId });

    await env.DB.prepare(`
      UPDATE media SET favorited_at = ? WHERE id = 'media-a'
    `).bind(PICKED_AT).run();

    expect(await env.DB.prepare(`
      SELECT favorited_at, album_pick_version FROM media WHERE id = 'media-a'
    `).first()).toEqual({ favorited_at: PICKED_AT, album_pick_version: 1 });
    expect(await eventGeneration('event-a')).toBe(1);
  });

  it('commits the predecessor-shaped unpick and clears version 1', async () => {
    await applyFresh0021();
    await seedEvent('event-a');
    const sessionId = await seedGuestSession('event-a');
    await insertMedia({
      id: 'media-a', eventId: 'event-a', uploaderSessionId: sessionId,
      favoritedAt: PICKED_AT, albumPickVersion: 1,
    });

    await env.DB.prepare(`
      UPDATE media SET favorited_at = NULL WHERE id = 'media-a'
    `).run();

    expect(await env.DB.prepare(`
      SELECT favorited_at, album_pick_version FROM media WHERE id = 'media-a'
    `).first()).toEqual({ favorited_at: null, album_pick_version: null });
    expect(await eventGeneration('event-a')).toBe(1);
  });

  it('rejects disagreeing version-only writes and preserves both rows', async () => {
    await applyFresh0021();
    await seedEvent('event-a');
    const sessionId = await seedGuestSession('event-a');
    await insertMedia({ id: 'unpicked', eventId: 'event-a', uploaderSessionId: sessionId });
    await insertMedia({
      id: 'picked', eventId: 'event-a', uploaderSessionId: sessionId,
      favoritedAt: PICKED_AT, albumPickVersion: 1,
    });

    await expect(env.DB.prepare(`
      UPDATE media SET album_pick_version = 1 WHERE id = 'unpicked'
    `).run()).rejects.toThrow(/disagrees/iu);
    await expect(env.DB.prepare(`
      UPDATE media SET album_pick_version = NULL WHERE id = 'picked'
    `).run()).rejects.toThrow(/disagrees/iu);

    expect(await env.DB.prepare(`
      SELECT id, favorited_at, album_pick_version FROM media ORDER BY id
    `).all()).toMatchObject({ results: [
      { id: 'picked', favorited_at: PICKED_AT, album_pick_version: 1 },
      { id: 'unpicked', favorited_at: null, album_pick_version: null },
    ] });
  });

  it('accepts consistent compound writes and increments generation once per eligibility change', async () => {
    await applyFresh0021();
    await seedEvent('event-a');
    const sessionId = await seedGuestSession('event-a');
    await insertMedia({ id: 'media-a', eventId: 'event-a', uploaderSessionId: sessionId });

    await env.DB.prepare(`
      UPDATE media SET favorited_at = ?, album_pick_version = 1 WHERE id = 'media-a'
    `).bind(PICKED_AT).run();
    expect(await env.DB.prepare(`
      SELECT favorited_at, album_pick_version FROM media WHERE id = 'media-a'
    `).first()).toEqual({ favorited_at: PICKED_AT, album_pick_version: 1 });
    expect(await eventGeneration('event-a')).toBe(1);

    await env.DB.prepare(`
      UPDATE media SET favorited_at = NULL, album_pick_version = NULL WHERE id = 'media-a'
    `).run();
    expect(await env.DB.prepare(`
      SELECT favorited_at, album_pick_version FROM media WHERE id = 'media-a'
    `).first()).toEqual({ favorited_at: null, album_pick_version: null });
    expect(await eventGeneration('event-a')).toBe(2);
  });

  it('increments independently and exactly once for every Album eligibility transition', async () => {
    await applyFresh0021();
    await seedEvent('event-a');
    await seedEvent('event-b');
    const sessionA = await seedGuestSession('event-a');
    const sessionB = await seedGuestSession('event-b');
    await insertMedia({ id: 'pick', eventId: 'event-a', uploaderSessionId: sessionA });
    await insertMedia({
      id: 'unpick', eventId: 'event-a', uploaderSessionId: sessionA,
      favoritedAt: PICKED_AT, albumPickVersion: 1,
    });
    await insertMedia({
      id: 'trash', eventId: 'event-a', uploaderSessionId: sessionA,
      favoritedAt: PICKED_AT, albumPickVersion: 1,
    });
    await insertMedia({
      id: 'restore', eventId: 'event-a', uploaderSessionId: sessionA,
      favoritedAt: PICKED_AT, albumPickVersion: 1,
      deletedAt: TRASHED_AT, trashedAt: TRASHED_AT, restoreUntil: RESTORE_UNTIL,
    });
    await insertMedia({
      id: 'guest-delete', eventId: 'event-a', uploaderSessionId: sessionA,
      favoritedAt: PICKED_AT, albumPickVersion: 1,
    });
    await insertMedia({
      id: 'cleanup-trashed', eventId: 'event-a', uploaderSessionId: sessionA,
      favoritedAt: PICKED_AT, albumPickVersion: 1,
      deletedAt: TRASHED_AT, trashedAt: TRASHED_AT, restoreUntil: RESTORE_UNTIL,
    });
    await insertMedia({ id: 'unpicked-delete', eventId: 'event-a', uploaderSessionId: sessionA });
    await insertMedia({
      id: 'row-delete', eventId: 'event-a', uploaderSessionId: sessionA,
      favoritedAt: PICKED_AT, albumPickVersion: 1,
    });
    await insertMedia({ id: 'event-b-pick', eventId: 'event-b', uploaderSessionId: sessionB });

    await env.DB.prepare(`
      UPDATE media SET favorited_at = ?, album_pick_version = 1 WHERE id = 'pick'
    `).bind(PICKED_AT).run();
    expect(await eventGeneration('event-a')).toBe(1);

    await env.DB.prepare(`
      UPDATE media SET favorited_at = NULL, album_pick_version = NULL WHERE id = 'unpick'
    `).run();
    expect(await eventGeneration('event-a')).toBe(2);

    await env.DB.prepare(`
      UPDATE media SET deleted_at = ?, trashed_at = ?, restore_until = ? WHERE id = 'trash'
    `).bind(TRASHED_AT, TRASHED_AT, RESTORE_UNTIL).run();
    expect(await eventGeneration('event-a')).toBe(3);

    await env.DB.prepare(`
      UPDATE media SET deleted_at = NULL, trashed_at = NULL, restore_until = NULL
      WHERE id = 'restore'
    `).run();
    expect(await eventGeneration('event-a')).toBe(4);

    await env.DB.prepare(`
      UPDATE media SET upload_state = 'deleted', deleted_at = ? WHERE id = 'guest-delete'
    `).bind(DELETED_AT).run();
    expect(await eventGeneration('event-a')).toBe(5);

    await env.DB.prepare(`
      UPDATE media SET upload_state = 'deleted', deleted_at = ?,
        trashed_at = NULL, restore_until = NULL
      WHERE id = 'cleanup-trashed'
    `).bind(DELETED_AT).run();
    expect(await eventGeneration('event-a')).toBe(5);

    await env.DB.prepare(`
      UPDATE media SET upload_state = 'deleted', deleted_at = ? WHERE id = 'unpicked-delete'
    `).bind(DELETED_AT).run();
    expect(await eventGeneration('event-a')).toBe(5);

    await env.DB.prepare(`DELETE FROM media WHERE id = 'row-delete'`).run();
    expect(await eventGeneration('event-a')).toBe(6);

    await env.DB.prepare(`
      UPDATE media SET favorited_at = ?, album_pick_version = 1 WHERE id = 'event-b-pick'
    `).bind(PICKED_AT).run();
    expect(await eventGeneration('event-a')).toBe(6);
    expect(await eventGeneration('event-b')).toBe(1);
  });

  it('defaults both event revisions to zero, rejects negatives, and keeps token identity separate', async () => {
    await applyThrough0020();
    await seedEvent('event-upgraded');
    await insert0020Token({ id: 'manager-token-secret-id', eventId: 'event-upgraded' });
    await apply0021();
    await seedEvent('event-fresh');

    expect(await env.DB.prepare(`
      SELECT id, album_pick_generation, manager_link_revision FROM events ORDER BY id
    `).all()).toMatchObject({ results: [
      { id: 'event-fresh', album_pick_generation: 0, manager_link_revision: 0 },
      { id: 'event-upgraded', album_pick_generation: 0, manager_link_revision: 0 },
    ] });
    expect(await env.DB.prepare(`
      SELECT id FROM event_access_tokens WHERE event_id = 'event-upgraded'
    `).first()).toEqual({ id: 'manager-token-secret-id' });
    await expect(env.DB.prepare(`
      UPDATE events SET album_pick_generation = -1 WHERE id = 'event-upgraded'
    `).run()).rejects.toThrow();
    await expect(env.DB.prepare(`
      UPDATE events SET manager_link_revision = -1 WHERE id = 'event-upgraded'
    `).run()).rejects.toThrow();
  });
});

describe('populated 0020 compatibility', () => {
  beforeEach(reset);

  async function seedPopulated0020() {
    await applyThrough0020();
    await seedEvent('event-saved');
    await seedEvent('event-unsaved');
    await seedEvent('event-tie');
    const savedSession = await seedGuestSession('event-saved');
    const unsavedSession = await seedGuestSession('event-unsaved');
    await seedAlbum('event-saved', NOW);
    await seedAlbum('event-unsaved', null);
    await insert0020Media({
      id: 'saved-picked', eventId: 'event-saved', uploaderSessionId: savedSession,
      favoritedAt: PICKED_AT,
    });
    await insert0020Media({
      id: 'saved-trashed-picked', eventId: 'event-saved', uploaderSessionId: savedSession,
      favoritedAt: PICKED_AT, deletedAt: TRASHED_AT,
      trashedAt: TRASHED_AT, restoreUntil: RESTORE_UNTIL,
    });
    await insert0020Media({
      id: 'unsaved-picked', eventId: 'event-unsaved', uploaderSessionId: unsavedSession,
      favoritedAt: PICKED_AT,
    });
    await env.DB.prepare(`
      INSERT INTO export_jobs (
        id, event_id, state, snapshot_at, media_count, total_bytes, attempt,
        error_code, created_at, kind, album_entries_json, guestbook_entry_count
      ) VALUES ('export-unchanged', 'event-saved', 'failed', ?, 0, 0, 1,
        'TEST_FAILURE', ?, 'complete', NULL, 0)
    `).bind(NOW, NOW).run();

    await insert0020Token({ id: 'manager-old', eventId: 'event-saved', createdAt: EARLIER });
    await insert0020Token({ id: 'manager-new', eventId: 'event-saved', createdAt: LATER });
    await insert0020Session({
      id: 'manager-old-session', eventId: 'event-saved', accessTokenId: 'manager-old',
    });
    await insert0020Session({
      id: 'manager-new-session', eventId: 'event-saved', accessTokenId: 'manager-new',
    });
    await insert0020Token({ id: 'manager-tie-a', eventId: 'event-tie', createdAt: NOW });
    await insert0020Token({ id: 'manager-tie-z', eventId: 'event-tie', createdAt: NOW });
    await insert0020Session({
      id: 'manager-tie-a-session', eventId: 'event-tie', accessTokenId: 'manager-tie-a',
    });
    await insert0020Session({
      id: 'manager-tie-z-session', eventId: 'event-tie', accessTokenId: 'manager-tie-z',
    });
  }

  it('preserves populated rows while normalizing duplicate live Manager tokens', async () => {
    await seedPopulated0020();

    await apply0021();

    expect(await env.DB.prepare(`
      SELECT id, album_pick_version FROM media ORDER BY id
    `).all()).toMatchObject({ results: [
      { id: 'saved-picked', album_pick_version: 1 },
      { id: 'saved-trashed-picked', album_pick_version: 1 },
      { id: 'unsaved-picked', album_pick_version: null },
    ] });
    expect(await env.DB.prepare(`
      SELECT id, revoked_at FROM event_access_tokens
      WHERE role = 'manager' ORDER BY id
    `).all()).toMatchObject({ results: [
      { id: 'manager-new', revoked_at: null },
      { id: 'manager-old', revoked_at: expect.any(String) },
      { id: 'manager-tie-a', revoked_at: expect.any(String) },
      { id: 'manager-tie-z', revoked_at: null },
    ] });
    expect(await env.DB.prepare(`
      SELECT id, revoked_at FROM event_sessions
      WHERE id LIKE 'manager-%-session' ORDER BY id
    `).all()).toMatchObject({ results: [
      { id: 'manager-new-session', revoked_at: null },
      { id: 'manager-old-session', revoked_at: expect.any(String) },
      { id: 'manager-tie-a-session', revoked_at: expect.any(String) },
      { id: 'manager-tie-z-session', revoked_at: null },
    ] });
    expect(await env.DB.prepare(`
      SELECT state, error_code, media_count, total_bytes
      FROM export_jobs WHERE id = 'export-unchanged'
    `).first()).toEqual({
      state: 'failed', error_code: 'TEST_FAILURE', media_count: 0, total_bytes: 0,
    });
    expect(await env.DB.prepare(`
      SELECT id, album_pick_generation, manager_link_revision FROM events ORDER BY id
    `).all()).toMatchObject({ results: [
      { id: 'event-saved', album_pick_generation: 0, manager_link_revision: 0 },
      { id: 'event-tie', album_pick_generation: 0, manager_link_revision: 0 },
      { id: 'event-unsaved', album_pick_generation: 0, manager_link_revision: 0 },
    ] });
  });

  it('allows the old 0020 Worker to delete an active preserved unsaved legacy favorite', async () => {
    await seedPopulated0020();
    await apply0021();

    expect(await env.DB.prepare(`
      SELECT favorited_at, album_pick_version, upload_state, deleted_at
      FROM media WHERE id = 'unsaved-picked'
    `).first()).toEqual({
      favorited_at: PICKED_AT,
      album_pick_version: null,
      upload_state: 'stored',
      deleted_at: null,
    });
    expect(await eventGeneration('event-unsaved')).toBe(0);

    // Exact active-row statement issued by the predecessor MediaRepository.
    const deleted = await env.DB.prepare(`
      UPDATE media SET upload_state = 'deleted', deleted_at = ?
      WHERE id = ? AND upload_state = ? AND deleted_at IS NULL AND trashed_at IS NULL
      RETURNING id
    `).bind(DELETED_AT, 'unsaved-picked', 'stored').first();

    expect(deleted).toEqual({ id: 'unsaved-picked' });
    expect(await env.DB.prepare(`
      SELECT favorited_at, album_pick_version, upload_state, deleted_at
      FROM media WHERE id = 'unsaved-picked'
    `).first()).toEqual({
      favorited_at: PICKED_AT,
      album_pick_version: null,
      upload_state: 'deleted',
      deleted_at: DELETED_AT,
    });
    expect(await eventGeneration('event-unsaved')).toBe(1);
  });

  it('rejects the old 0020 Worker exact second live Manager token insert', async () => {
    await seedPopulated0020();
    await apply0021();

    await expect(insertOld0020WorkerManagerToken({
      id: 'old-worker-second-live-manager', eventId: 'event-saved', createdAt: NOW,
    })).rejects.toThrow();
    expect(await env.DB.prepare(`
      SELECT id FROM event_access_tokens
      WHERE event_id = 'event-saved' AND role = 'manager' AND revoked_at IS NULL
    `).all()).toMatchObject({ results: [{ id: 'manager-new' }] });
  });
});

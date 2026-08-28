import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AccountsRepository } from '../../worker/db/accounts';
import { AuthRateLimitsRepository } from '../../worker/db/auth-rate-limits';
import { EventEntriesRepository } from '../../worker/db/event-entries';
import { EventsRepository, mapEvent, type EventRow } from '../../worker/db/events';
import { ExportsRepository } from '../../worker/db/exports';
import { buildManagerMediaQuery, MediaRepository } from '../../worker/db/media';
import { MediaObjectWriteTombstoneRepository } from '../../worker/db/media-write-tombstones';
import {
  buildRosterStatements,
  MAX_D1_BINDINGS,
  RsvpRepository,
} from '../../worker/db/rsvp';
import { RsvpRateLimitsRepository } from '../../worker/db/rsvp-rate-limits';
import { RsvpSessionsRepository } from '../../worker/db/rsvp-sessions';
import { HostSessionsRepository, SessionsRepository } from '../../worker/db/sessions';
import { TokensRepository } from '../../worker/db/tokens';
import { finalizeStoredMedia, receiveMediaUpload } from '../../worker/storage/media';
import { finalizedMediaObjectKey } from '../../worker/storage/media-keys';
import type { AppEnv } from '../../worker/env';
import { HostAuthService } from '../../worker/services/host-auth';
import type { UploadAuthority } from '../../worker/services/upload-authority';
import {
  DEFAULT_EVENT_THEME_CONFIG,
  serializeEventThemeConfig,
} from '../../shared/event-theme';
import { png, seedExportJob } from './helpers';

interface TestMigration {
  name: string;
  queries: string[];
}

const testEnv = env as Env & {
  TEST_MIGRATIONS: string;
  TEST_MIGRATION_QUERIES: string;
};
const now = '2026-07-21T12:00:00.000Z';
const rateKey = 'repository-rate-key-with-at-least-32-bytes';
const timelineContext = {
  eventStartAt: '2026-09-19T05:00:00.000Z',
  eventTimezone: 'America/Chicago',
};

async function seedEvent(id = 'event-a', slug = 'maya-theo') {
  const events = new EventsRepository(env.DB);
  await events.create({
    id,
    slug,
    name: 'Maya & Theo',
    eventDate: '2026-09-19',
    welcomeMessage: 'Add the moments only you noticed.',
    guestAccessExpiresAt: '2026-10-19T23:59:59.999Z',
    managementAccessExpiresAt: '2026-12-18T23:59:59.999Z',
    purgeAfter: '2027-01-17T23:59:59.999Z',
    createdAt: now,
    themeConfig: serializeEventThemeConfig(DEFAULT_EVENT_THEME_CONFIG),
    eventTimezone: 'America/Chicago',
    rsvpDeadlineAt: '2026-09-13T04:59:59.999Z',
    // Local midnight in Chicago on the event date, resolved the way the route
    // resolves it. The repository never converts a date itself.
    eventStartAt: '2026-09-19T05:00:00.000Z',
  });
  // Photo delivery is permitted from creation but opens on the schedule, and
  // these cases are about quota and idempotency rather than the clock, so the
  // early-open stamp is written directly rather than through the manager route.
  await env.DB.prepare('UPDATE events SET photos_open_from = ? WHERE id = ?')
    .bind(now, id).run();
  return events;
}

async function seedGuestSession(eventId = 'event-a', suffix = 'a') {
  const tokens = new TokensRepository(env.DB);
  await tokens.create({
    id: `token-${suffix}`,
    eventId,
    role: 'guest',
    secretDigest: `token-digest-${suffix}`,
    secretCiphertext: `ciphertext-${suffix}`,
    expiresAt: '2026-10-19T23:59:59.999Z',
    createdAt: now,
  });
  await env.DB.prepare(`
    INSERT INTO event_sessions (
      id, secret_digest, csrf_digest, event_id, access_token_id, role, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, 'guest', ?, ?)
  `).bind(
    `session-${suffix}`,
    `session-digest-${suffix}`,
    `csrf-${suffix}`,
    eventId,
    `token-${suffix}`,
    '2026-07-28T12:00:00.000Z',
    now,
  ).run();
  return `session-${suffix}`;
}

async function seedManagerSession(
  eventId = 'event-a',
  suffix = 'manager',
  canClaimOwner = true,
) {
  const tokens = new TokensRepository(env.DB);
  await tokens.create({
    id: `token-${suffix}`,
    eventId,
    role: 'manager',
    secretDigest: `token-digest-${suffix}`,
    secretCiphertext: null,
    expiresAt: '2026-12-18T23:59:59.999Z',
    createdAt: now,
  });
  await new SessionsRepository(env.DB).create({
    id: `session-${suffix}`,
    secretDigest: `session-digest-${suffix}`,
    csrfDigest: `csrf-${suffix}`,
    eventId,
    accessTokenId: `token-${suffix}`,
    role: 'manager',
    canClaimOwner,
    expiresAt: '2026-07-28T12:00:00.000Z',
    createdAt: now,
  });
  return `session-${suffix}`;
}

async function seedAccount(email: string) {
  return (await new AccountsRepository(env.DB).create({
    email,
    passwordHash: `hash-for-${email}`,
    displayName: null,
    createdAt: now,
  }))!;
}

type AuthorityKind = UploadAuthority['kind'];
type AuthorityIdentityField = 'eventSessionId' | 'hostSessionId' | 'accountId';

function alterAuthorityIdentity(
  authority: UploadAuthority,
  field: AuthorityIdentityField,
): UploadAuthority {
  if (field === 'eventSessionId') {
    if (authority.kind === 'manager-account') {
      throw new Error('Manager-account authority has no event session.');
    }
    return { ...authority, eventSessionId: `${authority.eventSessionId}-different` };
  }
  if (authority.kind !== 'manager-account') {
    throw new Error(`${authority.kind} authority has no ${field}.`);
  }
  return field === 'hostSessionId'
    ? { ...authority, hostSessionId: `${authority.hostSessionId}-different` }
    : { ...authority, accountId: `${authority.accountId}-different` };
}

function guestUploadAuthority(sessionId: string): UploadAuthority {
  return { kind: 'guest', actorSessionId: sessionId, eventSessionId: sessionId };
}

interface AuthorityFixture {
  authority: UploadAuthority;
  sessionId: string;
  tokenId: string;
  actorSessionId: string;
  hostSessionId: string | null;
  accountId: string | null;
}

async function seedAuthority(
  kind: AuthorityKind,
  eventId = 'event-a',
  fixtureSuffix?: string,
): Promise<AuthorityFixture> {
  if (kind === 'guest') {
    const suffix = fixtureSuffix ?? 'authority-guest';
    const sessionId = await seedGuestSession(eventId, suffix);
    return {
      authority: guestUploadAuthority(sessionId),
      sessionId,
      tokenId: `token-${suffix}`,
      actorSessionId: sessionId,
      hostSessionId: null,
      accountId: null,
    };
  }
  if (kind === 'manager-link') {
    const suffix = fixtureSuffix ?? 'authority-link';
    const sessionId = await seedManagerSession(eventId, suffix, false);
    return {
      authority: { kind, actorSessionId: sessionId, eventSessionId: sessionId },
      sessionId,
      tokenId: `token-${suffix}`,
      actorSessionId: sessionId,
      hostSessionId: null,
      accountId: null,
    };
  }

  const suffix = fixtureSuffix ?? 'authority-account';
  const tokenId = `token-${suffix}`;
  await new TokensRepository(env.DB).create({
    id: tokenId,
    eventId,
    role: 'manager',
    secretDigest: `token-digest-${suffix}`,
    secretCiphertext: null,
    expiresAt: '2026-12-18T23:59:59.999Z',
    createdAt: now,
  });
  const account = await seedAccount(`${suffix}@example.com`);
  await new AccountsRepository(env.DB).addEventHost(eventId, account.id, 'owner', now);
  const hostSessionId = `host-session-${suffix}`;
  await new HostSessionsRepository(env.DB).create({
    id: hostSessionId,
    secretDigest: `host-session-digest-${suffix}`,
    csrfDigest: `host-csrf-${suffix}`,
    accountId: account.id,
    authVersion: account.authVersion,
    expiresAt: '2026-08-21T12:00:00.000Z',
    createdAt: now,
  });
  const actorSessionId = `actor-session-${suffix}`;
  const actor = await new SessionsRepository(env.DB).createManagerUploadActor({
    id: actorSessionId,
    secretDigest: `actor-session-digest-${suffix}`,
    csrfDigest: `actor-csrf-${suffix}`,
    hostSessionId,
    accountId: account.id,
    eventId,
    createdAt: now,
    nowIso: now,
  });
  if (!actor) throw new Error('Expected Manager account upload actor fixture.');
  return {
    authority: { kind, actorSessionId, hostSessionId, accountId: account.id },
    sessionId: actorSessionId,
    tokenId,
    actorSessionId,
    hostSessionId,
    accountId: account.id,
  };
}

function reserveInputForEvent(
  authority: UploadAuthority,
  key: string,
  eventId: string,
  byteSize = 64,
) {
  return {
    id: `media-${key}`,
    eventId,
    uploaderSessionId: authority.actorSessionId,
    authority,
    objectKey: `events/${eventId}/uploads/media-${key}`,
    originalFilename: `${key}.png`,
    mimeType: 'image/png' as const,
    declaredByteSize: byteSize,
    guestName: authority.kind === 'guest' ? 'Avery' : 'Host',
    caption: null,
    idempotencyKey: key,
    reservationExpiresAt: '2026-07-21T12:15:00.000Z',
    createdAt: now,
  };
}

function reserveInput(authority: UploadAuthority, key: string, byteSize = 64) {
  return reserveInputForEvent(authority, key, 'event-a', byteSize);
}

type AuthorityRevocation = {
  condition: string;
  kind: AuthorityKind;
  mutate(fixture: AuthorityFixture): Promise<void>;
};

const AUTHORITY_REVOCATIONS: AuthorityRevocation[] = [
  {
    condition: 'disabled account', kind: 'manager-account',
    mutate: async ({ accountId }) => {
      await env.DB.prepare('UPDATE host_accounts SET disabled_at = ? WHERE id = ?')
        .bind('2026-07-21T12:01:30.000Z', accountId).run();
    },
  },
  {
    condition: 'removed membership', kind: 'manager-account',
    mutate: async ({ accountId }) => {
      await env.DB.prepare('DELETE FROM event_hosts WHERE event_id = ? AND account_id = ?')
        .bind('event-a', accountId).run();
    },
  },
  {
    condition: 'advanced auth version', kind: 'manager-account',
    mutate: async ({ accountId }) => {
      await env.DB.prepare('UPDATE host_accounts SET auth_version = auth_version + 1 WHERE id = ?')
        .bind(accountId).run();
    },
  },
  {
    condition: 'revoked host session', kind: 'manager-account',
    mutate: async ({ hostSessionId }) => {
      await new HostSessionsRepository(env.DB).revoke(
        hostSessionId!, '2026-07-21T12:01:30.000Z',
      );
    },
  },
  {
    condition: 'expired host session', kind: 'manager-account',
    mutate: async ({ hostSessionId }) => {
      await env.DB.prepare('UPDATE host_sessions SET expires_at = ? WHERE id = ?')
        .bind('2026-07-21T12:01:30.000Z', hostSessionId).run();
    },
  },
  {
    condition: 'rotated management link', kind: 'manager-link',
    mutate: async ({ tokenId }) => {
      await new TokensRepository(env.DB).revokeRole(
        'event-a', 'manager', '2026-07-21T12:01:30.000Z',
      );
      await new TokensRepository(env.DB).create({
        id: `${tokenId}-replacement`, eventId: 'event-a', role: 'manager',
        secretDigest: 'replacement-token-digest', secretCiphertext: null,
        expiresAt: '2026-12-18T23:59:59.999Z', createdAt: '2026-07-21T12:01:31.000Z',
      });
    },
  },
  {
    condition: 'revoked Manager event session', kind: 'manager-link',
    mutate: async ({ sessionId }) => {
      await new SessionsRepository(env.DB).revoke(sessionId, '2026-07-21T12:01:30.000Z');
    },
  },
  {
    condition: 'signed-out guest event session', kind: 'guest',
    mutate: async ({ sessionId }) => {
      await new SessionsRepository(env.DB).revoke(sessionId, '2026-07-21T12:01:30.000Z');
    },
  },
  {
    condition: 'revoked account actor', kind: 'manager-account',
    mutate: async ({ actorSessionId }) => {
      await new SessionsRepository(env.DB).revoke(
        actorSessionId, '2026-07-21T12:01:30.000Z',
      );
    },
  },
  {
    condition: 'expired account actor', kind: 'manager-account',
    mutate: async ({ actorSessionId }) => {
      await env.DB.prepare('UPDATE event_sessions SET expires_at = ? WHERE id = ?')
        .bind('2026-07-21T12:01:30.000Z', actorSessionId).run();
    },
  },
  {
    condition: 'actor bound to a non-current Manager token', kind: 'manager-account',
    mutate: async ({ tokenId }) => {
      await new TokensRepository(env.DB).revoke(tokenId, '2026-07-21T12:01:30.000Z');
      await new TokensRepository(env.DB).create({
        id: `${tokenId}-replacement`, eventId: 'event-a', role: 'manager',
        secretDigest: 'account-replacement-token-digest', secretCiphertext: null,
        expiresAt: '2026-12-18T23:59:59.999Z', createdAt: '2026-07-21T12:01:31.000Z',
      });
    },
  },
  {
    condition: 'expired management window', kind: 'manager-account',
    mutate: async () => {
      await env.DB.prepare('UPDATE events SET management_access_expires_at = ? WHERE id = ?')
        .bind('2026-07-21T12:01:30.000Z', 'event-a').run();
    },
  },
];

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, [{
    name: '0001_core.sql',
    queries: JSON.parse(testEnv.TEST_MIGRATION_QUERIES) as string[],
  }]);
  // Repository unit fixtures intentionally model rows grandfathered by 0015;
  // the dedicated migration suite owns the categorical trigger contract.
  await env.DB.exec(`
    DROP TRIGGER IF EXISTS media_stored_legacy_guard_insert;
    DROP TRIGGER IF EXISTS media_stored_legacy_guard_update;
  `);
});

describe('manager media storage timestamp migration', () => {
  it('backfills legacy stored rows from their reservation timestamp', async () => {
    await seedEvent();
    const sessionId = await seedGuestSession();
    await env.DB.prepare(`
      INSERT INTO media (
        id, event_id, uploader_session_id, object_key, original_filename, mime_type,
        declared_byte_size, byte_size, width, height, guest_name, caption, upload_state,
        publication_status, idempotency_key, reservation_expires_at, created_at
      )
      VALUES (
        'media-legacy', 'event-a', ?, 'events/event-a/media/legacy', 'legacy.jpg', 'image/jpeg',
        1024, 900, 1200, 800, 'Avery', NULL, 'stored',
        'unpublished', 'idem-legacy', '2026-07-21T12:15:00.000Z', ?
      )
    `).bind(sessionId, now).run();

    const migrationQueries = JSON.parse(testEnv.TEST_MIGRATION_QUERIES) as string[];
    const backfill = migrationQueries.find((query) => (
      query.includes('UPDATE media')
      && query.includes('stored_at')
      && query.includes("upload_state = 'stored'")
    ));
    expect(backfill).toBeDefined();

    await env.DB.prepare(backfill!).run();
    const row = await env.DB.prepare('SELECT created_at, stored_at FROM media WHERE id = ?')
      .bind('media-legacy')
      .first<{ created_at: string; stored_at: string | null }>();
    expect(row).toEqual({ created_at: now, stored_at: now });
  });

  it('stamps an old-worker finalization performed after the schema migration', async () => {
    await reset();
    const migrations = JSON.parse(testEnv.TEST_MIGRATIONS) as TestMigration[];
    const storedAtMigrationIndex = migrations.findIndex(
      ({ name }) => name === '0005_media_stored_at.sql',
    );
    expect(storedAtMigrationIndex).toBeGreaterThan(0);
    await applyD1Migrations(env.DB, migrations.slice(0, storedAtMigrationIndex));

    await env.DB.prepare(`
      INSERT INTO events (id, slug, name, event_date, welcome_message,
        guest_access_expires_at, management_access_expires_at, purge_after, created_at)
      VALUES ('event-a', 'maya-theo', 'Maya & Theo', '2026-09-19', 'Welcome.', ?, ?, ?, ?)
    `).bind(
      '2026-10-19T23:59:59.999Z',
      '2026-12-18T23:59:59.999Z',
      '2027-01-17T23:59:59.999Z',
      now,
    ).run();
    const sessionId = await seedGuestSession();
    await env.DB.prepare(`
      INSERT INTO media (
        id, event_id, uploader_session_id, object_key, original_filename, mime_type,
        declared_byte_size, guest_name, caption, upload_state, publication_status,
        idempotency_key, reservation_expires_at, created_at
      )
      VALUES (
        'media-old-worker', 'event-a', ?, 'events/event-a/media/old-worker',
        'old-worker.jpg', 'image/jpeg', 1024, 'Avery', NULL, 'reserved',
        'unpublished', 'idem-old-worker', '2026-07-21T12:15:00.000Z', ?
      )
    `).bind(sessionId, now).run();
    await env.DB.prepare(`
      UPDATE events
      SET reserved_media_count = 1, reserved_bytes = 1024
      WHERE id = 'event-a'
    `).run();

    await applyD1Migrations(env.DB, [migrations[storedAtMigrationIndex]!]);
    const results = await env.DB.batch([
      env.DB.prepare(`
        UPDATE media
        SET byte_size = ?, width = ?, height = ?, upload_state = 'stored'
        WHERE id = ? AND upload_state = 'reserved'
      `).bind(900, 1200, 800, 'media-old-worker'),
      env.DB.prepare(`
        UPDATE events
        SET reserved_media_count = reserved_media_count - 1,
            reserved_bytes = reserved_bytes - ?,
            stored_media_count = stored_media_count + 1,
            stored_bytes = stored_bytes + ?
        WHERE id = ? AND changes() = 1
      `).bind(1024, 900, 'event-a'),
    ]);
    // D1 reports both the outer update and trigger update in the first result,
    // but SQLite's changes() guard still sees the outer update and moves the
    // event counters exactly once in the second statement.
    expect(results.map((result) => result.meta.changes)).toEqual([2, 1]);

    const row = await env.DB.prepare(
      'SELECT upload_state, stored_at FROM media WHERE id = ?',
    ).bind('media-old-worker').first<{
      upload_state: string;
      stored_at: string | null;
    }>();
    expect(row?.upload_state).toBe('stored');
    expect(row?.stored_at).toEqual(expect.any(String));
    expect(await env.DB.prepare(`
      SELECT reserved_media_count, reserved_bytes, stored_media_count, stored_bytes
      FROM events
      WHERE id = ?
    `).bind('event-a').first()).toEqual({
      reserved_media_count: 0,
      reserved_bytes: 0,
      stored_media_count: 1,
      stored_bytes: 900,
    });

    // The stamp above is the point of this test and had to happen on the exact
    // 0005 schema. Reading it back is current-Worker code, and every ordinary
    // media query has selected `trashed_at` since 0019, so finish the upgrade
    // before asking the repository for the row the old Worker committed.
    await applyD1Migrations(env.DB, migrations.slice(storedAtMigrationIndex + 1));

    const managerPage = await new MediaRepository(env.DB).listForManager('event-a');
    expect(managerPage.media.map((media) => media.id)).toContain('media-old-worker');
  });
});

describe('event, token, and session repositories', () => {
  it('updates only one event theme and maps malformed stored JSON to the default', async () => {
    const repository = await seedEvent();
    await seedEvent('event-b', 'other-event');
    const coastal = {
      version: 1,
      presetId: 'coastal-light',
      overrides: { primaryColor: '#125f6b' },
    } as const;

    await repository.updateTheme('event-a', serializeEventThemeConfig(coastal));

    expect((await repository.getById('event-a'))?.themeConfig).toEqual(coastal);
    expect((await repository.getById('event-b'))?.themeConfig)
      .toEqual(DEFAULT_EVENT_THEME_CONFIG);

    const row = await env.DB.prepare('SELECT * FROM events WHERE id = ?').bind('event-a')
      .first<EventRow>();
    expect(mapEvent({ ...row!, theme_config: '{' }).themeConfig)
      .toEqual(DEFAULT_EVENT_THEME_CONFIG);
  });

  it('rejects theme updates for missing or deleted events', async () => {
    const repository = await seedEvent();

    await expect(repository.updateTheme(
      'missing-event',
      serializeEventThemeConfig(DEFAULT_EVENT_THEME_CONFIG),
    )).rejects.toThrow('Event theme was not updated.');

    await env.DB.prepare('UPDATE events SET deleted_at = ? WHERE id = ?')
      .bind(now, 'event-a').run();
    await expect(repository.updateTheme(
      'event-a',
      serializeEventThemeConfig(DEFAULT_EVENT_THEME_CONFIG),
    )).rejects.toThrow('Event theme was not updated.');
  });

  it('creates and resolves event-scoped records without crossing events', async () => {
    const events = await seedEvent();
    await seedEvent('event-b', 'other-event');
    await seedGuestSession();

    expect((await events.getBySlug('maya-theo'))?.id).toBe('event-a');
    expect((await new SessionsRepository(env.DB).getForEvent('session-a', 'event-a'))?.role).toBe('guest');
    expect(await new SessionsRepository(env.DB).getForEvent('session-a', 'event-b')).toBeNull();
  });

  it('atomically creates and narrowly maps a live Manager upload actor', async () => {
    await seedEvent();
    const account = await seedAccount('actor-owner@example.com');
    await new AccountsRepository(env.DB).addEventHost('event-a', account.id, 'owner', now);
    await new TokensRepository(env.DB).create({
      id: 'actor-manager-token',
      eventId: 'event-a',
      role: 'manager',
      secretDigest: 'actor-token-digest',
      secretCiphertext: null,
      expiresAt: '2026-12-18T23:59:59.999Z',
      createdAt: now,
    });
    await new HostSessionsRepository(env.DB).create({
      id: 'actor-host-session',
      secretDigest: 'host-session-digest',
      csrfDigest: 'host-csrf-digest',
      accountId: account.id,
      authVersion: account.authVersion,
      expiresAt: '2026-08-21T12:00:00.000Z',
      createdAt: now,
    });
    const sessions = new SessionsRepository(env.DB);

    const actor = await sessions.createManagerUploadActor({
      id: 'manager-upload-actor',
      secretDigest: 'actor-secret-digest',
      csrfDigest: 'actor-csrf-digest',
      hostSessionId: 'actor-host-session',
      accountId: account.id,
      eventId: 'event-a',
      createdAt: now,
      nowIso: now,
    });

    expect(actor).toEqual({
      id: 'manager-upload-actor',
      eventId: 'event-a',
      accessTokenId: 'actor-manager-token',
      accountId: account.id,
      expiresAt: '2026-12-18T23:59:59.999Z',
    });
    expect(Object.keys(actor!)).toEqual([
      'id', 'eventId', 'accessTokenId', 'accountId', 'expiresAt',
    ]);
    expect(await sessions.getLiveManagerUploadActor('event-a', account.id, now))
      .toEqual(actor);
  });

  it('returns null for failed actor proof and excludes revoked, expired, or non-current actors', async () => {
    await seedEvent();
    const account = await seedAccount('actor-liveness@example.com');
    await new AccountsRepository(env.DB).addEventHost('event-a', account.id, 'cohost', now);
    await new TokensRepository(env.DB).create({
      id: 'actor-live-token', eventId: 'event-a', role: 'manager',
      secretDigest: 'actor-live-token-digest', secretCiphertext: null,
      expiresAt: '2026-12-18T23:59:59.999Z', createdAt: now,
    });
    await new HostSessionsRepository(env.DB).create({
      id: 'actor-live-host', secretDigest: 'host-digest', csrfDigest: 'host-csrf',
      accountId: account.id, authVersion: account.authVersion,
      expiresAt: '2026-08-21T12:00:00.000Z', createdAt: now,
    });
    const sessions = new SessionsRepository(env.DB);
    const input = {
      id: 'actor-live', secretDigest: 'actor-digest', csrfDigest: 'actor-csrf',
      hostSessionId: 'actor-live-host', accountId: account.id, eventId: 'event-a',
      createdAt: now, nowIso: now,
    };

    expect(await sessions.createManagerUploadActor({
      ...input,
      id: 'wrong-host-proof',
      hostSessionId: 'missing-host-session',
    })).toBeNull();
    expect(await sessions.createManagerUploadActor(input)).not.toBeNull();
    expect(await sessions.getLiveManagerUploadActor(
      'event-a', account.id, '2027-01-01T00:00:00.000Z',
    )).toBeNull();

    await env.DB.prepare('UPDATE event_access_tokens SET revoked_at = ? WHERE id = ?')
      .bind('2026-07-21T12:00:01.000Z', 'actor-live-token').run();
    await new TokensRepository(env.DB).create({
      id: 'actor-replacement-token', eventId: 'event-a', role: 'manager',
      secretDigest: 'actor-replacement-digest', secretCiphertext: null,
      expiresAt: '2026-12-18T23:59:59.999Z', createdAt: '2026-07-21T12:00:01.000Z',
    });
    expect(await sessions.getLiveManagerUploadActor('event-a', account.id, now)).toBeNull();

    expect(await sessions.revokeManagerUploadActors(
      'event-a', account.id, '2026-07-21T12:00:02.000Z',
    )).toBe(1);
    expect(await sessions.getLiveManagerUploadActor('event-a', account.id, now)).toBeNull();

    const secondAccount = await seedAccount('actor-event-revoke@example.com');
    await new AccountsRepository(env.DB).addEventHost('event-a', secondAccount.id, 'cohost', now);
    await new HostSessionsRepository(env.DB).create({
      id: 'actor-second-host', secretDigest: 'second-host-digest', csrfDigest: 'second-host-csrf',
      accountId: secondAccount.id, authVersion: secondAccount.authVersion,
      expiresAt: '2026-08-21T12:00:00.000Z', createdAt: now,
    });
    expect(await sessions.createManagerUploadActor({
      id: 'actor-second', secretDigest: 'second-actor-digest', csrfDigest: 'second-actor-csrf',
      hostSessionId: 'actor-second-host', accountId: secondAccount.id, eventId: 'event-a',
      createdAt: now, nowIso: now,
    })).not.toBeNull();
    expect(await sessions.revokeManagerUploadActors(
      'event-a', null, '2026-07-21T12:00:03.000Z',
    )).toBe(1);
    expect(await sessions.getLiveManagerUploadActor('event-a', secondAccount.id, now)).toBeNull();
  });

  it('creates new events with the optional gallery hidden', async () => {
    const events = await seedEvent();

    expect((await events.getById('event-a'))?.galleryVisible).toBe(false);
  });

  it('refuses to reopen RSVP while the printed entry is disabled', async () => {
    const events = new EventsRepository(env.DB);
    const created = await events.create({
      id: 'event-entry-guard', slug: 'entry-guard', name: 'Maya & Theo',
      eventDate: '2026-09-19', welcomeMessage: 'Welcome.',
      guestAccessExpiresAt: now, managementAccessExpiresAt: now, purgeAfter: now,
      createdAt: now, themeConfig: serializeEventThemeConfig(DEFAULT_EVENT_THEME_CONFIG),
      eventTimezone: 'America/Chicago', rsvpDeadlineAt: '2026-09-06T04:59:59.999Z',
      eventStartAt: '2026-09-19T05:00:00.000Z',
    });
    const settings = {
      galleryVisible: true, moderationRequired: false,
      eventTimezone: 'America/Chicago', rsvpDeadlineAt: '2026-09-06T04:59:59.999Z',
      eventStartAt: '2026-09-19T05:00:00.000Z',
      expectedRosterVersion: 0,
    };
    const entries = new EventEntriesRepository(env.DB);
    await entries.createStatement({
      id: 'entry-a', eventId: created.id, secretDigest: 'digest', secretCiphertext: 'cipher',
      createdAt: now,
    }).run();

    // Open entry: reopening RSVP is allowed.
    expect(await events.updateSettings(created.id, {
      ...settings, rsvpEnabled: true,
    })).not.toBeNull();

    await entries.disableForEvent(created.id, now);
    await env.DB.prepare('UPDATE events SET uploads_enabled = 0, rsvp_enabled = 0 WHERE id = ?')
      .bind(created.id).run();

    // A disabled entry refuses the reopen atomically, whatever the caller checked first.
    expect(await events.updateSettings(created.id, {
      ...settings, rsvpEnabled: true,
    })).toBeNull();

    // Every other setting still saves, because the host has to keep managing the event.
    const kept = await events.updateSettings(created.id, {
      ...settings, name: 'Renamed', rsvpEnabled: false,
    });
    expect(kept?.name).toBe('Renamed');
    // Photo delivery left the settings payload entirely, so nothing this write
    // carries can restore the capability the entry stop withdrew.
    expect(kept?.uploadsEnabled).toBe(false);
  });
});

describe('atomic authentication budgets and ownership', () => {
  it('reserves a concurrent budget with one atomic upsert per attempt', async () => {
    const rates = new AuthRateLimitsRepository(env.DB, rateKey);
    const at = new Date('2026-07-21T12:14:59.999Z');

    const reservations = await Promise.all(Array.from({ length: 4 }, () => rates.reserve({
      action: 'registration',
      scopeKind: 'email',
      normalizedValue: 'host@example.com',
      limit: 3,
      now: at,
    })));

    expect(reservations.filter(Boolean)).toHaveLength(3);
    expect(await env.DB.prepare(`
      SELECT attempts, window_started_at FROM host_auth_rate_limits
    `).first()).toEqual({
      attempts: 4,
      window_started_at: '2026-07-21T12:00:00.000Z',
    });
  });

  it('starts a fresh fixed UTC bucket exactly on the quarter hour', async () => {
    const rates = new AuthRateLimitsRepository(env.DB, rateKey);
    const input = {
      action: 'login' as const,
      scopeKind: 'ip' as const,
      normalizedValue: 'unknown',
      limit: 20,
    };

    await rates.reserve({ ...input, now: new Date('2026-07-21T12:14:59.999Z') });
    await rates.reserve({ ...input, now: new Date('2026-07-21T12:15:00.000Z') });

    const rows = await env.DB.prepare(`
      SELECT window_started_at, attempts FROM host_auth_rate_limits
      ORDER BY window_started_at
    `).all();
    expect(rows.results).toEqual([
      { window_started_at: '2026-07-21T12:00:00.000Z', attempts: 1 },
      { window_started_at: '2026-07-21T12:15:00.000Z', attempts: 1 },
    ]);
  });

  it('enforces the exact login, verification, and reset secondary budgets', async () => {
    const service = new HostAuthService(env as AppEnv);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(service.reserveLogin(
        'Host@Example.com',
        '203.0.113.20',
      )).resolves.toBeUndefined();
    }
    await expect(service.reserveLogin('host@example.com', '203.0.113.20'))
      .rejects.toMatchObject({ code: 'RATE_LIMITED' });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(service.reserveVerificationResend(
        'account-a',
        '203.0.113.21',
      )).resolves.toBeUndefined();
    }
    await expect(service.reserveVerificationResend('account-a', '203.0.113.21'))
      .rejects.toMatchObject({ code: 'RATE_LIMITED' });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(service.reservePasswordReset(
        'Host@Example.com',
        '203.0.113.22',
      )).resolves.toBeUndefined();
    }
    await expect(service.reservePasswordReset('host@example.com', '203.0.113.22'))
      .rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('returns a committed activation after cleanup removes its consumed challenge', async () => {
    await seedEvent();
    const creatorSessionId = await seedManagerSession('event-a', 'activation-cleanup', true);
    const accounts = new AccountsRepository(env.DB);
    await accounts.replacePendingRegistration({
      id: 'registration-cleanup',
      email: 'host@example.com',
      passwordHash: 'password-hash',
      displayName: 'Host',
      browserSecretDigest: 'browser-secret-digest',
      codeDigest: 'code-digest',
      bindEventId: 'event-a',
      creatorSessionId,
      attempts: 0,
      expiresAt: '2026-07-21T12:15:00.000Z',
      consumedAt: null,
      activationNonce: null,
      createdAt: now,
      updatedAt: now,
    });
    const pending = await accounts.getPendingRegistration('registration-cleanup');
    expect(pending).not.toBeNull();

    const cleanupDb = {
      prepare: env.DB.prepare.bind(env.DB),
      async batch(statements: D1PreparedStatement[]) {
        const results = await env.DB.batch(statements);
        await env.DB.prepare(`
          DELETE FROM host_registration_challenges
          WHERE id = ? AND consumed_at IS NOT NULL
        `).bind(pending!.id).run();
        return results;
      },
    } as unknown as D1Database;

    const activated = await new AccountsRepository(cleanupDb)
      .activateRegistration(pending!, '2026-07-21T12:01:00.000Z');

    expect(activated).toMatchObject({
      account: { email: 'host@example.com' },
      boundEvent: true,
    });
    expect(await accounts.getPendingRegistration(pending!.id)).toBeNull();
    expect(await env.DB.prepare(`
      SELECT role FROM event_hosts WHERE event_id = ? AND account_id = ?
    `).bind('event-a', activated!.account.id).first('role')).toBe('owner');
    expect(await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM host_notification_outbox',
    ).first('count')).toBe(3);
  });

  it('claims one owner, closes a legacy path, and schedules exactly three rows', async () => {
    await seedEvent();
    await env.DB.prepare('UPDATE events SET legacy_owner_claim_open = 1 WHERE id = ?')
      .bind('event-a').run();
    const sessionId = await seedManagerSession('event-a', 'legacy', false);
    const account = await seedAccount('host@example.com');
    const accounts = new AccountsRepository(env.DB);

    const result = await accounts.claimInitialOwnerAndSchedule(
      'event-a',
      account.id,
      sessionId,
      '2026-07-21T12:01:00.000Z',
    );

    expect(result).toBe('claimed');
    expect(await env.DB.prepare(`
      SELECT legacy_owner_claim_open FROM events WHERE id = ?
    `).bind('event-a').first('legacy_owner_claim_open')).toBe(0);
    const scheduled = await env.DB.prepare(`
      SELECT kind FROM host_notification_outbox ORDER BY kind
    `).all<{ kind: string }>();
    expect(scheduled.results.map(({ kind }) => kind)).toEqual([
      'event_reminder',
      'getting_started',
      'retention_warning',
    ]);
  });

  it('refuses a live manager session that was never the creator', async () => {
    await seedEvent();
    // Post-0006 event: legacy claim closed, so creator authority is the only route.
    const delegateSession = await seedManagerSession('event-a', 'delegate', false);
    const account = await seedAccount('delegate@example.com');

    const result = await new AccountsRepository(env.DB).claimInitialOwnerAndSchedule(
      'event-a', account.id, delegateSession, '2026-07-21T12:01:00.000Z',
    );

    // Deleting "can_claim_owner = 1 OR legacy_owner_claim_open = 1" from the insert
    // would make this 'claimed', and nothing else in the suite would notice.
    expect(result).toBe('not_authorized');
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM event_hosts').first('count')).toBe(0);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM host_notification_outbox').first('count')).toBe(0);
  });

  it('lets the creator session claim the event the delegate could not', async () => {
    await seedEvent();
    const creatorSession = await seedManagerSession('event-a', 'creator', true);
    const account = await seedAccount('creator@example.com');

    // The positive half: a guard that refused everything would pass the test above.
    expect(await new AccountsRepository(env.DB).claimInitialOwnerAndSchedule(
      'event-a', account.id, creatorSession, '2026-07-21T12:01:00.000Z',
    )).toBe('claimed');
  });

  it('does not promote a cohost or close the legacy path on refusal', async () => {
    await seedEvent();
    await env.DB.prepare('UPDATE events SET legacy_owner_claim_open = 1 WHERE id = ?')
      .bind('event-a').run();
    const sessionId = await seedManagerSession('event-a', 'legacy', false);
    const account = await seedAccount('host@example.com');
    await env.DB.prepare(`
      INSERT INTO event_hosts (event_id, account_id, role, created_at)
      VALUES (?, ?, 'cohost', ?)
    `).bind('event-a', account.id, now).run();

    const result = await new AccountsRepository(env.DB).claimInitialOwnerAndSchedule(
      'event-a',
      account.id,
      sessionId,
      '2026-07-21T12:01:00.000Z',
    );

    expect(result).toBe('owned_by_other');
    expect(await env.DB.prepare(`
      SELECT role FROM event_hosts WHERE event_id = ? AND account_id = ?
    `).bind('event-a', account.id).first('role')).toBe('cohost');
    expect(await env.DB.prepare(`
      SELECT legacy_owner_claim_open FROM events WHERE id = ?
    `).bind('event-a').first('legacy_owner_claim_open')).toBe(1);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM host_notification_outbox').first('count')).toBe(0);
  });

  it('refuses a revoked creator session without closing or scheduling', async () => {
    await seedEvent();
    await env.DB.prepare('UPDATE events SET legacy_owner_claim_open = 1 WHERE id = ?')
      .bind('event-a').run();
    const sessionId = await seedManagerSession('event-a', 'revoked', true);
    await env.DB.prepare('UPDATE event_sessions SET revoked_at = ? WHERE id = ?')
      .bind('2026-07-21T12:00:30.000Z', sessionId).run();
    const account = await seedAccount('host@example.com');

    const result = await new AccountsRepository(env.DB).claimInitialOwnerAndSchedule(
      'event-a',
      account.id,
      sessionId,
      '2026-07-21T12:01:00.000Z',
    );

    // No membership exists, so the honest answer is that this credential could not
    // claim it — not that somebody else already had.
    expect(result).toBe('not_authorized');
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM event_hosts').first('count')).toBe(0);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM host_notification_outbox').first('count')).toBe(0);
    expect(await env.DB.prepare(`
      SELECT legacy_owner_claim_open FROM events WHERE id = ?
    `).bind('event-a').first('legacy_owner_claim_open')).toBe(1);
  });
});

describe('upload authority repository and ingress fences', () => {
  const authorityKinds = ['guest', 'manager-link', 'manager-account'] as const;

  async function revokeReservationAuthority(fixture: AuthorityFixture) {
    if (fixture.authority.kind === 'manager-account') {
      await new HostSessionsRepository(env.DB).revoke(
        fixture.hostSessionId!, '2026-07-21T12:00:30.000Z',
      );
      return;
    }
    await new SessionsRepository(env.DB).revoke(
      fixture.sessionId, '2026-07-21T12:00:30.000Z',
    );
  }

  async function uploadCounters(eventId: string) {
    return env.DB.prepare(`
      SELECT reserved_media_count, reserved_bytes, stored_media_count, stored_bytes
      FROM events WHERE id = ?
    `).bind(eventId).first<Record<string, number>>();
  }

  async function seedCrossEventReservation(
    kind: AuthorityKind,
    key: string,
    byteSize = 64,
  ) {
    await seedEvent();
    await seedEvent('event-b', `event-b-${key}`);
    const fixture = await seedAuthority(kind, 'event-a', `${key}-source`);
    const target = await seedAuthority('guest', 'event-b', `${key}-target`);
    const repository = new MediaRepository(env.DB);
    const reserved = await repository.reserve(
      reserveInputForEvent(target.authority, key, 'event-b', byteSize),
    );
    await env.DB.prepare('UPDATE media SET uploader_session_id = ? WHERE id = ?')
      .bind(fixture.authority.actorSessionId, reserved.id).run();
    const crossScoped = await repository.getById(reserved.id);
    if (!crossScoped) throw new Error('Expected cross-event reservation fixture.');
    return { fixture, target, repository, reserved: crossScoped };
  }

  function commitInput(
    mediaId: string,
    eventId: string,
    authority: UploadAuthority,
    claimToken: string,
    byteSize = 64,
  ) {
    return {
      mediaId,
      eventId,
      authority,
      claimToken,
      finalObjectKey: finalizedMediaObjectKey(eventId, mediaId),
      byteSize,
      width: 800,
      height: 600,
      finalEtag: 'canonical-final-etag',
      committedAt: '2026-07-21T12:02:00.000Z',
      capturedAt: null,
      timelineAt: '2026-07-21T12:02:00.000Z',
    };
  }

  it.each(authorityKinds)(
    'refuses a live %s authority for another event at single reserve',
    async (kind) => {
      await seedEvent();
      await seedEvent('event-b', `cross-single-${kind}`);
      const fixture = await seedAuthority(kind, 'event-a', `cross-single-${kind}`);
      const repository = new MediaRepository(env.DB);
      const input = reserveInputForEvent(
        fixture.authority,
        `cross-single-${kind}`,
        'event-b',
      );
      const before = await uploadCounters('event-b');

      await expect(repository.reserve(input)).rejects.toMatchObject({
        code: 'RESOURCE_FORBIDDEN', status: 403,
      });
      expect(await repository.getById(input.id)).toBeNull();
      expect(await repository.getPromotion(input.id)).toBeNull();
      expect(await uploadCounters('event-b')).toEqual(before);
    },
  );

  it.each(authorityKinds)(
    'refuses a live %s authority for another event at batch reserve',
    async (kind) => {
      await seedEvent();
      await seedEvent('event-b', `cross-batch-${kind}`);
      const fixture = await seedAuthority(kind, 'event-a', `cross-batch-${kind}`);
      const repository = new MediaRepository(env.DB);
      const inputs = ['one', 'two'].map((suffix) => reserveInputForEvent(
        fixture.authority,
        `cross-batch-${kind}-${suffix}`,
        'event-b',
      ));
      const before = await uploadCounters('event-b');

      await expect(repository.reserveBatch(inputs)).rejects.toMatchObject({
        code: 'RESOURCE_FORBIDDEN', status: 403,
      });
      for (const input of inputs) {
        expect(await repository.getById(input.id)).toBeNull();
        expect(await repository.getPromotion(input.id)).toBeNull();
      }
      expect(await uploadCounters('event-b')).toEqual(before);
    },
  );

  it.each(authorityKinds)(
    'refuses a live %s authority for another event at idempotent refresh',
    async (kind) => {
      const key = `cross-refresh-${kind}`;
      const { fixture, repository, reserved } = await seedCrossEventReservation(kind, key);
      const beforeMedia = await repository.getById(reserved.id);
      const beforePromotion = await repository.getPromotion(reserved.id);
      const beforeCounters = await uploadCounters('event-b');

      await expect(repository.reserve({
        ...reserveInputForEvent(fixture.authority, key, 'event-b'),
        id: `ignored-${key}`,
        objectKey: `events/event-b/uploads/ignored-${key}`,
        reservationExpiresAt: '2026-07-21T12:30:00.000Z',
        createdAt: '2026-07-21T12:01:00.000Z',
      })).rejects.toMatchObject({ code: 'RESOURCE_FORBIDDEN', status: 403 });
      expect(await repository.getById(reserved.id)).toEqual(beforeMedia);
      expect(await repository.getPromotion(reserved.id)).toEqual(beforePromotion);
      expect(await uploadCounters('event-b')).toEqual(beforeCounters);
    },
  );

  it.each(authorityKinds)(
    'refuses a live %s authority for another event at ingress claim',
    async (kind) => {
      const key = `cross-claim-${kind}`;
      const bytes = png(800, 600);
      const { fixture, repository, reserved } = await seedCrossEventReservation(
        kind,
        key,
        bytes.byteLength,
      );
      const beforeMedia = await repository.getById(reserved.id);
      const beforePromotion = await repository.getPromotion(reserved.id);
      const beforeCounters = await uploadCounters('event-b');

      await expect(receiveMediaUpload(
        env.CANONICAL_MEDIA_BUCKET,
        repository,
        reserved,
        timelineContext,
        fixture.authority,
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        'image/png',
        new Date('2026-07-21T12:02:00.000Z'),
      )).rejects.toMatchObject({ code: 'RESOURCE_FORBIDDEN', status: 403 });
      expect(await repository.getById(reserved.id)).toEqual(beforeMedia);
      expect(await repository.getPromotion(reserved.id)).toEqual(beforePromotion);
      expect(await uploadCounters('event-b')).toEqual(beforeCounters);
    },
  );

  it.each(authorityKinds)(
    'refuses a live %s authority for another event at ingress commit',
    async (kind) => {
      const key = `cross-commit-${kind}`;
      await seedEvent();
      await seedEvent('event-b', key);
      const fixture = await seedAuthority(kind, 'event-a', `${key}-source`);
      const target = await seedAuthority('guest', 'event-b', `${key}-target`);
      const repository = new MediaRepository(env.DB);
      const reserved = await repository.reserve(
        reserveInputForEvent(target.authority, key, 'event-b'),
      );
      const claimToken = `claim-${key}`;
      await expect(repository.claimReservationIngress({
        mediaId: reserved.id,
        eventId: 'event-b',
        authority: target.authority,
        sourceObjectKey: reserved.objectKey,
        mimeType: reserved.mimeType,
        byteSize: reserved.declaredByteSize,
        sha256: 'a'.repeat(64),
        width: 800,
        height: 600,
        claimToken,
        claimedAt: '2026-07-21T12:01:00.000Z',
        leaseExpiresAt: '2026-07-21T12:21:00.000Z',
      })).resolves.toMatchObject({ ok: true });
      const beforeMedia = await repository.getById(reserved.id);
      const beforePromotion = await repository.getPromotion(reserved.id);
      const beforeCounters = await uploadCounters('event-b');

      await expect(repository.commitReservationIngress(commitInput(
        reserved.id,
        'event-b',
        fixture.authority,
        claimToken,
      ))).resolves.toEqual({ ok: false, reason: 'forbidden' });
      expect(await repository.getById(reserved.id)).toEqual(beforeMedia);
      expect(await repository.getPromotion(reserved.id)).toEqual(beforePromotion);
      expect(await uploadCounters('event-b')).toEqual(beforeCounters);
    },
  );

  it.each(authorityKinds)(
    'does not commit a same-event reservation through a different %s actor',
    async (alternateKind) => {
      await seedEvent();
      const owner = await seedAuthority('guest', 'event-a', `commit-owner-${alternateKind}`);
      const alternate = await seedAuthority(
        alternateKind,
        'event-a',
        `commit-alternate-${alternateKind}`,
      );
      const repository = new MediaRepository(env.DB);
      const reserved = await repository.reserve(
        reserveInput(owner.authority, `commit-actor-${alternateKind}`),
      );
      const claimToken = `claim-actor-${alternateKind}`;
      await expect(repository.claimReservationIngress({
        mediaId: reserved.id,
        eventId: 'event-a',
        authority: owner.authority,
        sourceObjectKey: reserved.objectKey,
        mimeType: reserved.mimeType,
        byteSize: reserved.declaredByteSize,
        sha256: 'b'.repeat(64),
        width: 800,
        height: 600,
        claimToken,
        claimedAt: '2026-07-21T12:01:00.000Z',
        leaseExpiresAt: '2026-07-21T12:21:00.000Z',
      })).resolves.toMatchObject({ ok: true });
      const beforeMedia = await repository.getById(reserved.id);
      const beforePromotion = await repository.getPromotion(reserved.id);
      const beforeCounters = await uploadCounters('event-a');

      await expect(repository.commitReservationIngress(commitInput(
        reserved.id,
        'event-a',
        alternate.authority,
        claimToken,
      ))).resolves.toEqual({ ok: false, reason: 'conflict' });
      expect(await repository.getById(reserved.id)).toEqual(beforeMedia);
      expect(await repository.getPromotion(reserved.id)).toEqual(beforePromotion);
      expect(await uploadCounters('event-a')).toEqual(beforeCounters);
    },
  );

  it.each([
    { rowState: 'missing', authorityState: 'live', expected: 'conflict' },
    { rowState: 'missing', authorityState: 'dead', expected: 'forbidden' },
    { rowState: 'failed', authorityState: 'live', expected: 'conflict' },
    { rowState: 'failed', authorityState: 'dead', expected: 'forbidden' },
    { rowState: 'deleted', authorityState: 'live', expected: 'conflict' },
    { rowState: 'deleted', authorityState: 'dead', expected: 'forbidden' },
  ] as const)(
    'classifies a $authorityState authority after a failed commit to a $rowState row',
    async ({ rowState, authorityState, expected }) => {
      await seedEvent();
      const fixture = await seedAuthority(
        'guest',
        'event-a',
        `commit-${rowState}-${authorityState}`,
      );
      const repository = new MediaRepository(env.DB);
      const mediaId = `media-commit-${rowState}-${authorityState}`;
      if (rowState !== 'missing') {
        const reserved = await repository.reserve(
          reserveInput(fixture.authority, `commit-${rowState}-${authorityState}`),
        );
        if (rowState === 'failed') await repository.failReservation(reserved.id);
        else await repository.delete(reserved.id, '2026-07-21T12:01:00.000Z');
      }
      const beforeMedia = await repository.getById(mediaId);
      const beforePromotion = await repository.getPromotion(mediaId);
      const beforeCounters = await uploadCounters('event-a');
      if (authorityState === 'dead') await revokeReservationAuthority(fixture);

      await expect(repository.commitReservationIngress(commitInput(
        mediaId,
        'event-a',
        fixture.authority,
        `claim-${rowState}-${authorityState}`,
      ))).resolves.toEqual({ ok: false, reason: expected });
      expect(await repository.getById(mediaId)).toEqual(beforeMedia);
      expect(await repository.getPromotion(mediaId)).toEqual(beforePromotion);
      expect(await uploadCounters('event-a')).toEqual(beforeCounters);
    },
  );

  it.each([
    ['guest', 'eventSessionId'],
    ['manager-link', 'eventSessionId'],
    ['manager-account', 'hostSessionId'],
    ['manager-account', 'accountId'],
  ] as const)(
    'rejects a batch whose %s authority changes %s between items',
    async (kind, field) => {
      await seedEvent();
      const fixture = await seedAuthority(kind, 'event-a', `mixed-${kind}-${field}`);
      const altered = alterAuthorityIdentity(fixture.authority, field);
      const repository = new MediaRepository(env.DB);
      const inputs = [
        reserveInput(fixture.authority, `mixed-${kind}-${field}-one`),
        reserveInput(altered, `mixed-${kind}-${field}-two`),
      ];
      const before = await uploadCounters('event-a');

      await expect(repository.reserveBatch(inputs)).rejects.toMatchObject({
        code: 'VALIDATION_FAILED', status: 422,
      });
      for (const input of inputs) {
        expect(await repository.getById(input.id)).toBeNull();
        expect(await repository.getPromotion(input.id)).toBeNull();
      }
      expect(await uploadCounters('event-a')).toEqual(before);
    },
  );

  it.each(['guest', 'manager-link', 'manager-account'] as const)(
    're-proves a %s authority in the same statement that reserves quota',
    async (kind) => {
      await seedEvent();
      const fixture = await seedAuthority(kind);
      await revokeReservationAuthority(fixture);
      const repository = new MediaRepository(env.DB);

      await expect(repository.reserve(reserveInput(fixture.authority, `dead-reserve-${kind}`)))
        .rejects.toMatchObject({ code: 'RESOURCE_FORBIDDEN', status: 403 });
      expect(await repository.getById(`media-dead-reserve-${kind}`)).toBeNull();
      expect(await new EventsRepository(env.DB).getById('event-a')).toMatchObject({
        reservedMediaCount: 0, reservedBytes: 0,
      });
    },
  );

  it.each(['guest', 'manager-link', 'manager-account'] as const)(
    'refuses a %s idempotent refresh after its credential dies',
    async (kind) => {
      await seedEvent();
      const fixture = await seedAuthority(kind);
      const repository = new MediaRepository(env.DB);
      const input = reserveInput(fixture.authority, `dead-refresh-${kind}`);
      const reserved = await repository.reserve(input);
      await revokeReservationAuthority(fixture);

      await expect(repository.reserve({
        ...input,
        id: `ignored-dead-refresh-${kind}`,
        reservationExpiresAt: '2026-07-21T12:30:00.000Z',
        createdAt: '2026-07-21T12:01:00.000Z',
      })).rejects.toMatchObject({ code: 'RESOURCE_FORBIDDEN', status: 403 });
      expect(await repository.getById(reserved.id)).toMatchObject({
        uploadState: 'reserved', reservationExpiresAt: '2026-07-21T12:15:00.000Z',
      });
    },
  );

  it.each(['reserved', 'failed'] as const)(
    'cancels one Manager %s reservation, releases only charged quota, and classifies replay',
    async (state) => {
      await seedEvent();
      const fixture = await seedAuthority('manager-link');
      const repository = new MediaRepository(env.DB);
      const reserved = await repository.reserve(
        reserveInput(fixture.authority, `cancel-${state}`, 128),
      );
      if (state === 'failed') await repository.failReservation(reserved.id);

      const outcome = await repository.cancelReservation(
        reserved.id,
        fixture.authority,
        '2026-07-21T12:02:00.000Z',
      );

      expect(outcome).toMatchObject({
        kind: 'canceled',
        claim: { mediaId: reserved.id, eventId: 'event-a' },
      });
      if (outcome.kind !== 'canceled') throw new Error('Expected cancellation claim.');
      expect([...outcome.claim.legacyKeys].sort()).toEqual([
        reserved.objectKey,
        `events/event-a/previews/${reserved.id}.webp`,
      ].sort());
      expect(outcome.claim.canonicalKeys).toEqual([
        finalizedMediaObjectKey('event-a', reserved.id),
      ]);
      expect(await repository.getById(reserved.id)).toMatchObject({
        uploadState: 'deleted',
        deletedAt: '2026-07-21T12:02:00.000Z',
        trashedAt: null,
        restoreUntil: null,
      });
      expect(await repository.getPromotion(reserved.id)).toBeNull();
      expect(await uploadCounters('event-a')).toEqual({
        reserved_media_count: 0,
        reserved_bytes: 0,
        stored_media_count: 0,
        stored_bytes: 0,
      });
      await expect(repository.cancelReservation(
        reserved.id,
        fixture.authority,
        '2026-07-21T12:02:00.000Z',
      )).resolves.toEqual({ kind: 'already-canceled' });
    },
  );

  it('refuses guest, cross-event, and dead-authority reservations without changing rows or quota', async () => {
    await seedEvent();
    await seedEvent('event-b', 'event-b-cancel');
    const manager = await seedAuthority('manager-link', 'event-a', 'cancel-manager');
    const guest = await seedAuthority('guest', 'event-a', 'cancel-guest');
    const foreignGuest = await seedAuthority('guest', 'event-b', 'cancel-foreign-guest');
    const repository = new MediaRepository(env.DB);
    const guestRow = await repository.reserve(reserveInput(guest.authority, 'cancel-guest-row'));
    const foreignRow = await repository.reserve(
      reserveInputForEvent(foreignGuest.authority, 'cancel-foreign-row', 'event-b'),
    );
    const ownRow = await repository.reserve(reserveInput(manager.authority, 'cancel-dead-row'));

    await expect(repository.cancelReservation(
      guestRow.id, manager.authority, '2026-07-21T12:01:00.000Z',
    )).resolves.toEqual({ kind: 'forbidden' });
    await expect(repository.cancelReservation(
      foreignRow.id, manager.authority, '2026-07-21T12:01:00.000Z',
    )).resolves.toEqual({ kind: 'forbidden' });
    await new SessionsRepository(env.DB).revoke(
      manager.sessionId,
      '2026-07-21T12:01:30.000Z',
    );
    await expect(repository.cancelReservation(
      ownRow.id, manager.authority, '2026-07-21T12:02:00.000Z',
    )).resolves.toEqual({ kind: 'forbidden' });

    expect(await repository.getById(guestRow.id)).toMatchObject({ uploadState: 'reserved' });
    expect(await repository.getById(foreignRow.id)).toMatchObject({ uploadState: 'reserved' });
    expect(await repository.getById(ownRow.id)).toMatchObject({ uploadState: 'reserved' });
    expect(await uploadCounters('event-a')).toMatchObject({
      reserved_media_count: 2,
      reserved_bytes: 128,
    });
    expect(await uploadCounters('event-b')).toMatchObject({
      reserved_media_count: 1,
      reserved_bytes: 64,
    });
  });

  it('classifies delivered and Recently deleted Manager rows as conflicts without mutating them', async () => {
    await seedEvent();
    const fixture = await seedAuthority('manager-link');
    const repository = new MediaRepository(env.DB);
    const stored = await repository.reserve(reserveInput(fixture.authority, 'cancel-stored', 128));
    await repository.finalize(
      stored.id,
      { byteSize: 128, width: 800, height: 600 },
      '2026-07-21T12:01:00.000Z',
      { capturedAt: null, timelineAt: '2026-07-21T12:01:00.000Z' },
    );
    const beforeStored = await repository.getById(stored.id);

    await expect(repository.cancelReservation(
      stored.id, fixture.authority, '2026-07-21T12:02:00.000Z',
    )).resolves.toEqual({ kind: 'conflict' });
    expect(await repository.getById(stored.id)).toEqual(beforeStored);

    await repository.trashStored('event-a', stored.id, '2026-07-21T12:03:00.000Z');
    const beforeTrashed = await repository.getById(stored.id);
    await expect(repository.cancelReservation(
      stored.id, fixture.authority, '2026-07-21T12:04:00.000Z',
    )).resolves.toEqual({ kind: 'conflict' });
    expect(await repository.getById(stored.id)).toEqual(beforeTrashed);
    expect(await uploadCounters('event-a')).toMatchObject({
      reserved_media_count: 0,
      stored_media_count: 0,
    });
  });

  it.each(['reserved', 'failed'] as const)(
    'lets Manager cleanup cancel only a guest-owned %s row',
    async (state) => {
      await seedEvent();
      const guest = await seedAuthority('guest', 'event-a', 'legacy-cancel-guest');
      const manager = await seedAuthority('manager-link', 'event-a', 'legacy-cancel-manager');
      const repository = new MediaRepository(env.DB);
      const guestRow = await repository.reserve(
        reserveInput(guest.authority, 'legacy-cancel-guest-row', 96),
      );
      const managerRow = await repository.reserve(
        reserveInput(manager.authority, 'legacy-cancel-manager-row', 64),
      );
      if (state === 'failed') await repository.failReservation(guestRow.id);

      await expect(repository.cancelGuestReservationFromManager(
        managerRow.id, 'event-a', '2026-07-21T12:01:00.000Z',
      )).resolves.toEqual({ kind: 'forbidden' });
      const canceled = await repository.cancelGuestReservationFromManager(
        guestRow.id, 'event-a', '2026-07-21T12:02:00.000Z',
      );

      expect(canceled).toMatchObject({
        kind: 'canceled',
        claim: { mediaId: guestRow.id, eventId: 'event-a' },
      });
      expect(await repository.getById(guestRow.id)).toMatchObject({ uploadState: 'deleted' });
      expect(await repository.getById(managerRow.id)).toMatchObject({ uploadState: 'reserved' });
      expect(await uploadCounters('event-a')).toMatchObject({
        reserved_media_count: 1,
        reserved_bytes: 64,
      });
      await expect(repository.cancelGuestReservationFromManager(
        guestRow.id, 'event-a', '2026-07-21T12:02:00.000Z',
      )).resolves.toEqual({ kind: 'already-canceled' });
    },
  );

  it('never re-enters another actor row for the same event idempotency key', async () => {
    await seedEvent();
    const first = await seedAuthority('guest');
    const secondSessionId = await seedGuestSession('event-a', 'authority-guest-second');
    const second: UploadAuthority = {
      kind: 'guest', actorSessionId: secondSessionId, eventSessionId: secondSessionId,
    };
    const repository = new MediaRepository(env.DB);

    const firstMedia = await repository.reserve(reserveInput(first.authority, 'cross-actor'));
    const secondMedia = await repository.reserve({
      ...reserveInput(second, 'cross-actor'),
      id: 'media-cross-actor-second',
      objectKey: 'events/event-a/uploads/media-cross-actor-second',
    });

    expect(secondMedia.id).not.toBe(firstMedia.id);
    expect([firstMedia.uploaderSessionId, secondMedia.uploaderSessionId])
      .toEqual([first.authority.actorSessionId, second.actorSessionId]);
  });

  it('distinguishes a canceled Manager replay without resurrecting its row', async () => {
    await seedEvent();
    const fixture = await seedAuthority('manager-link');
    const repository = new MediaRepository(env.DB);
    const input = reserveInput(fixture.authority, 'manager-canceled-replay');
    const reserved = await repository.reserve(input);
    await repository.delete(reserved.id, '2026-07-21T12:01:00.000Z');

    await expect(repository.reserve({ ...input, id: 'ignored-manager-canceled-replay' }))
      .rejects.toMatchObject({ code: 'UPLOAD_RESERVATION_CANCELED', status: 409 });
    expect(await repository.getById(reserved.id)).toMatchObject({ uploadState: 'deleted' });
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM media WHERE event_id = ?')
      .bind('event-a').first<{ count: number }>())?.count).toBe(1);
  });

  it('keeps the canceled guest replay wire answer byte-identical', async () => {
    await seedEvent();
    const fixture = await seedAuthority('guest');
    const repository = new MediaRepository(env.DB);
    const input = reserveInput(fixture.authority, 'guest-canceled-replay');
    const reserved = await repository.reserve(input);
    await repository.delete(reserved.id, '2026-07-21T12:01:00.000Z');

    await expect(repository.reserve({ ...input, id: 'ignored-guest-canceled-replay' }))
      .rejects.toMatchObject({
        code: 'UPLOAD_FINALIZE_CONFLICT',
        status: 409,
        message: 'This photo was removed. Choose it again.',
      });
    expect(await repository.getById(reserved.id)).toMatchObject({ uploadState: 'deleted' });
  });

  it.each(AUTHORITY_REVOCATIONS)(
    'classifies $condition before claim as RESOURCE_FORBIDDEN and moves no promotion',
    async ({ kind, mutate }) => {
      await seedEvent();
      const fixture = await seedAuthority(kind);
      const repository = new MediaRepository(env.DB);
      const bytes = png(800, 600);
      const reserved = await repository.reserve(
        reserveInput(fixture.authority, `claim-${kind}-${crypto.randomUUID()}`, bytes.byteLength),
      );
      await mutate(fixture);

      await expect(receiveMediaUpload(
        env.CANONICAL_MEDIA_BUCKET,
        repository,
        reserved,
        timelineContext,
        fixture.authority,
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        'image/png',
        new Date('2026-07-21T12:02:00.000Z'),
      )).rejects.toMatchObject({ code: 'RESOURCE_FORBIDDEN', status: 403 });
      expect(await repository.getById(reserved.id)).toMatchObject({ uploadState: 'reserved' });
      expect(await repository.getPromotion(reserved.id)).toMatchObject({ state: 'pending' });
      expect(await new EventsRepository(env.DB).getById('event-a')).toMatchObject({
        reservedMediaCount: 1, storedMediaCount: 0,
      });
    },
  );

  it.each(AUTHORITY_REVOCATIONS)(
    'classifies $condition after claim as RESOURCE_FORBIDDEN and commits no row or counter',
    async ({ kind, mutate }) => {
      await seedEvent();
      const fixture = await seedAuthority(kind);
      const repository = new MediaRepository(env.DB);
      const bytes = png(800, 600);
      const reserved = await repository.reserve(
        reserveInput(fixture.authority, `commit-${kind}-${crypto.randomUUID()}`, bytes.byteLength),
      );
      const claimToken = `claim-${crypto.randomUUID()}`;
      const claimed = await repository.claimReservationIngress({
        mediaId: reserved.id,
        eventId: reserved.eventId,
        authority: fixture.authority,
        sourceObjectKey: reserved.objectKey,
        mimeType: reserved.mimeType,
        byteSize: bytes.byteLength,
        sha256: 'a'.repeat(64),
        width: 800,
        height: 600,
        claimToken,
        claimedAt: '2026-07-21T12:01:00.000Z',
        leaseExpiresAt: '2026-07-21T12:21:00.000Z',
      });
      expect(claimed).toMatchObject({ ok: true, value: { claimToken } });
      await mutate(fixture);

      await expect(repository.commitReservationIngress({
        mediaId: reserved.id,
        eventId: reserved.eventId,
        authority: fixture.authority,
        claimToken,
        finalObjectKey: finalizedMediaObjectKey('event-a', reserved.id),
        byteSize: bytes.byteLength,
        width: 800,
        height: 600,
        finalEtag: 'canonical-final-etag',
        committedAt: '2026-07-21T12:02:00.000Z',
        capturedAt: null,
        timelineAt: '2026-07-21T12:02:00.000Z',
      })).resolves.toEqual({ ok: false, reason: 'forbidden' });
      expect(await repository.getById(reserved.id)).toMatchObject({ uploadState: 'reserved' });
      expect(await repository.getPromotion(reserved.id)).toMatchObject({
        state: 'copying', claimToken, finalPointerCommitted: false,
      });
      expect(await new EventsRepository(env.DB).getById('event-a')).toMatchObject({
        reservedMediaCount: 1, storedMediaCount: 0,
      });
    },
  );

  it('returns an already-stored result before classifying a newly dead credential', async () => {
    await seedEvent();
    const fixture = await seedAuthority('guest');
    const receivedAt = new Date();
    const liveThrough = new Date(receivedAt.getTime() + 86_400_000).toISOString();
    await env.DB.batch([
      env.DB.prepare('UPDATE event_sessions SET expires_at = ? WHERE id = ?')
        .bind(liveThrough, fixture.sessionId),
      env.DB.prepare('UPDATE event_access_tokens SET expires_at = ? WHERE id = ?')
        .bind(liveThrough, fixture.tokenId),
      env.DB.prepare('UPDATE events SET guest_access_expires_at = ? WHERE id = ?')
        .bind(liveThrough, 'event-a'),
    ]);
    const repository = new MediaRepository(env.DB);
    const bytes = png(800, 600);
    const reserved = await repository.reserve(
      {
        ...reserveInput(fixture.authority, 'stored-before-revocation', bytes.byteLength),
        reservationExpiresAt: liveThrough,
      },
    );
    const stored = await receiveMediaUpload(
      env.CANONICAL_MEDIA_BUCKET,
      repository,
      reserved,
      timelineContext,
      fixture.authority,
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      'image/png',
      receivedAt,
    );
    await new SessionsRepository(env.DB).revoke(
      fixture.sessionId, new Date(receivedAt.getTime() + 1_000).toISOString(),
    );
    const beforeReplayMedia = await repository.getById(stored.id);
    const beforeReplayPromotion = await repository.getPromotion(stored.id);
    const beforeReplayCounters = await uploadCounters('event-a');

    await expect(receiveMediaUpload(
      env.CANONICAL_MEDIA_BUCKET,
      repository,
      stored,
      timelineContext,
      fixture.authority,
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      'image/png',
      new Date(receivedAt.getTime() + 2_000),
    )).resolves.toMatchObject({ id: stored.id, uploadState: 'stored' });
    expect(await repository.getById(stored.id)).toEqual(beforeReplayMedia);
    expect(await repository.getPromotion(stored.id)).toEqual(beforeReplayPromotion);
    expect(await uploadCounters('event-a')).toEqual(beforeReplayCounters);
  });
});

describe('media reservation and lifecycle', () => {
  it('leases durable legacy promotion work and atomically commits its pointer fence', async () => {
    await seedEvent();
    const sessionId = await seedGuestSession();
    const repository = new MediaRepository(env.DB);
    const reserved = await repository.reserve({
      id: 'media-durable-promotion', eventId: 'event-a', uploaderSessionId: sessionId, authority: guestUploadAuthority(sessionId),
      objectKey: 'events/event-a/media/media-durable-promotion', originalFilename: 'photo.png',
      mimeType: 'image/png', declaredByteSize: 128, guestName: 'Avery', caption: null,
      idempotencyKey: 'idem-durable-promotion',
      reservationExpiresAt: '2026-07-21T12:15:00.000Z', createdAt: now,
    });
    const bytes = png(1200, 800);
    await env.DB.exec('DROP TRIGGER IF EXISTS media_stored_legacy_guard_update;');
    await repository.finalize(
      reserved.id,
      { byteSize: bytes.byteLength, width: 1200, height: 800 },
      '2026-07-21T12:16:00.000Z',
      { capturedAt: null, timelineAt: '2026-07-21T12:16:00.000Z' },
    );
    const work = await repository.listPromotionWork('2026-07-21T12:16:00.000Z', 10);
    expect(work.map(({ mediaId }) => mediaId)).toEqual([reserved.id]);

    const claimed = await repository.claimPromotion(
      reserved.id,
      'owner-token-at-least-sixteen-bytes-a',
      '2026-07-21T12:16:00.000Z',
      '2026-07-21T12:36:00.000Z',
    );
    expect(claimed?.promotion).toMatchObject({
      state: 'copying', claimToken: 'owner-token-at-least-sixteen-bytes-a',
      leaseExpiresAt: '2026-07-21T12:36:00.000Z',
    });
    await expect(repository.claimPromotion(
      reserved.id,
      'owner-token-at-least-sixteen-bytes-b',
      '2026-07-21T12:35:59.999Z',
      '2026-07-21T12:55:59.999Z',
    )).resolves.toBeNull();

    const reclaimed = await repository.claimPromotion(
      reserved.id,
      'owner-token-at-least-sixteen-bytes-b',
      '2026-07-21T12:36:00.001Z',
      '2026-07-21T12:56:00.001Z',
    );
    expect(reclaimed?.promotion.claimToken).toBe('owner-token-at-least-sixteen-bytes-b');
    await expect(repository.recordPromotionSource(reserved.id, reclaimed!.promotion.claimToken!, {
      etag: 'source-etag', mimeType: 'image/png', byteSize: bytes.byteLength,
      sha256: 'a'.repeat(64), width: 1200, height: 800,
      recordedAt: '2026-07-21T12:36:01.000Z',
    })).resolves.toBe(true);
    await repository.ensureFinalObjectWriteTombstone(
      reserved.id,
      finalizedMediaObjectKey('event-a', reserved.id),
      '2026-07-21T12:36:01.000Z',
    );
    await expect(repository.markPromotionTargetVerified(
      reserved.id,
      reclaimed!.promotion.claimToken!,
      'canonical-target-etag',
      '2026-07-21T12:36:01.500Z',
    )).resolves.toBe(true);
    expect(await repository.getPromotion(reserved.id)).toMatchObject({
      state: 'target_verified', finalEtag: 'canonical-target-etag',
      targetVerifiedAt: '2026-07-21T12:36:01.500Z', leaseExpiresAt: null,
    });
    await expect(repository.commitPromotionPointer(
      reserved.id,
      reclaimed!.promotion.claimToken!,
      '2026-07-21T12:36:02.000Z',
    )).resolves.toBe(true);

    expect(await repository.getById(reserved.id)).toMatchObject({
      objectKey: finalizedMediaObjectKey('event-a', reserved.id), uploadState: 'stored',
    });
    expect(await repository.getPromotion(reserved.id)).toMatchObject({
      state: 'cleanup_pending', claimToken: reclaimed!.promotion.claimToken,
      leaseExpiresAt: null, sourceEtag: 'source-etag', sourceSha256: 'a'.repeat(64),
      finalPointerCommitted: true,
    });

    await expect(repository.handoffPromotionToPermanentSuppression(
      reserved.id,
      reclaimed!.promotion.claimToken!,
      '2026-07-21T12:36:03.000Z',
    )).resolves.toBe(true);
    expect(await repository.getPromotion(reserved.id)).toBeNull();
    const tombstones = new MediaObjectWriteTombstoneRepository(env.DB);
    expect(await tombstones.get(finalizedMediaObjectKey('event-a', reserved.id), 'canonical'))
      .toMatchObject({ suppressionStartedAt: null, objectKind: 'final' });
    expect(await tombstones.get(reserved.objectKey))
      .toMatchObject({ suppressionStartedAt: '2026-07-21T12:36:03.000Z' });
    expect(await tombstones.get(`events/event-a/previews/${reserved.id}.webp`))
      .toMatchObject({ suppressionStartedAt: '2026-07-21T12:36:03.000Z' });
  });

  it('settles a verified promotion when trash wins before the pointer compare-and-set', async () => {
    await seedEvent();
    const sessionId = await seedGuestSession();
    const repository = new MediaRepository(env.DB);
    const reserved = await repository.reserve({
      id: 'media-verified-trash-race', eventId: 'event-a', uploaderSessionId: sessionId, authority: guestUploadAuthority(sessionId),
      objectKey: 'events/event-a/media/media-verified-trash-race', originalFilename: 'photo.png',
      mimeType: 'image/png', declaredByteSize: 128, guestName: 'Avery', caption: null,
      idempotencyKey: 'idem-verified-trash-race',
      reservationExpiresAt: '2026-07-21T12:15:00.000Z', createdAt: now,
    });
    await env.DB.exec('DROP TRIGGER IF EXISTS media_stored_legacy_guard_update;');
    await repository.finalize(
      reserved.id,
      { byteSize: 128, width: 1200, height: 800 },
      '2026-07-21T12:16:00.000Z',
      { capturedAt: null, timelineAt: '2026-07-21T12:16:00.000Z' },
    );
    const previewKey = `events/event-a/previews/${reserved.id}.webp`;
    await repository.setPreviewObjectKey(reserved.id, previewKey);
    await env.MEDIA_BUCKET.put(previewKey, png(320, 240));
    const claimToken = 'verified-trash-race-owner-at-least-sixteen';
    const claimed = await repository.claimPromotion(
      reserved.id,
      claimToken,
      '2026-07-21T12:16:01.000Z',
      '2026-07-21T12:36:01.000Z',
    );
    expect(claimed).not.toBeNull();
    await expect(repository.recordPromotionSource(reserved.id, claimToken, {
      etag: 'legacy-source-etag', mimeType: 'image/png', byteSize: 128,
      sha256: 'c'.repeat(64), width: 1200, height: 800,
      recordedAt: '2026-07-21T12:16:02.000Z',
    })).resolves.toBe(true);
    const finalKey = finalizedMediaObjectKey('event-a', reserved.id);
    await repository.ensureFinalObjectWriteTombstone(
      reserved.id, finalKey, '2026-07-21T12:16:02.000Z',
    );
    await expect(repository.markPromotionTargetVerified(
      reserved.id,
      claimToken,
      'canonical-target-etag',
      '2026-07-21T12:16:03.000Z',
    )).resolves.toBe(true);

    // Trash commits after target verification but before the pointer CAS.
    await repository.trashStored('event-a', reserved.id, '2026-07-21T12:16:04.000Z');
    await expect(repository.commitPromotionPointer(
      reserved.id, claimToken, '2026-07-21T12:16:05.000Z',
    )).resolves.toBe(false);
    await expect(repository.parkInactiveVerifiedPromotionCleanup(
      reserved.id, claimToken, '2026-07-21T12:16:06.000Z',
    )).resolves.toBe(true);
    await expect(repository.handoffPromotionToPermanentSuppression(
      reserved.id, claimToken, '2026-07-21T12:16:07.000Z',
    )).resolves.toBe(true);

    expect(await repository.getPromotion(reserved.id)).toBeNull();
    expect(await repository.getById(reserved.id)).toMatchObject({
      uploadState: 'stored',
      objectBucketGeneration: 'legacy',
      objectKey: reserved.objectKey,
      previewObjectKey: previewKey,
      trashedAt: '2026-07-21T12:16:04.000Z',
    });
    const tombstones = new MediaObjectWriteTombstoneRepository(env.DB);
    expect(await tombstones.get(reserved.objectKey, 'legacy'))
      .toMatchObject({ suppressionStartedAt: null });
    expect(await tombstones.get(finalKey, 'canonical'))
      .toMatchObject({ suppressionStartedAt: '2026-07-21T12:16:07.000Z' });
    expect(await tombstones.get(previewKey, 'legacy'))
      .toMatchObject({ suppressionStartedAt: null });
    expect(await env.MEDIA_BUCKET.head(previewKey)).not.toBeNull();

    const restored = await repository.restoreTrashed(
      'event-a', reserved.id, '2026-07-21T12:16:08.000Z',
    );
    expect(restored).toMatchObject({
      uploadState: 'stored',
      objectBucketGeneration: 'legacy',
      objectKey: reserved.objectKey,
      previewObjectKey: previewKey,
      deletedAt: null,
      trashedAt: null,
      restoreUntil: null,
    });
    expect(await tombstones.get(previewKey, 'legacy'))
      .toMatchObject({ suppressionStartedAt: null });
    expect(await env.MEDIA_BUCKET.head(previewKey)).not.toBeNull();
  });

  it('hands a deleted canonical photo to permanent suppression without requiring a source-kind row', async () => {
    await seedEvent();
    const sessionId = await seedGuestSession();
    const repository = new MediaRepository(env.DB);
    const mediaId = 'media-canonical-delete';
    const finalKey = finalizedMediaObjectKey('event-a', mediaId);
    const reserved = await repository.reserve({
      id: mediaId, eventId: 'event-a', uploaderSessionId: sessionId, authority: guestUploadAuthority(sessionId),
      objectKey: finalKey, originalFilename: 'photo.png', mimeType: 'image/png',
      declaredByteSize: 128, guestName: 'Avery', caption: null,
      idempotencyKey: 'idem-canonical-delete',
      reservationExpiresAt: '2026-07-21T12:15:00.000Z', createdAt: now,
    });
    await repository.finalize(
      reserved.id,
      { byteSize: 128, width: 1, height: 1 },
      '2026-07-21T12:01:00.000Z',
      { capturedAt: null, timelineAt: '2026-07-21T12:01:00.000Z' },
    );
    await env.DB.prepare(`
      UPDATE media SET object_bucket_generation = 'canonical' WHERE id = ?
    `).bind(reserved.id).run();
    await env.DB.prepare('DELETE FROM media_object_promotions WHERE media_id = ?')
      .bind(reserved.id).run();
    await repository.delete(reserved.id, '2026-07-21T12:16:00.000Z');
    expect(await repository.getPromotion(reserved.id)).toBeNull();
    // Suppression is no longer a side effect of the delete — it is the claim
    // that wins the right to remove bytes, so that an export hold or a
    // recoverable owner can withhold a key from any caller. The claim still has
    // to reach a canonical final key with no promotion row behind it.
    const claim = await repository.claimMediaObjectDeletion(
      (await repository.getById(reserved.id))!,
      '2026-07-21T12:16:00.000Z',
    );
    expect(claim.canonicalKeys).toContain(finalKey);
    expect(await new MediaObjectWriteTombstoneRepository(env.DB).get(finalKey, 'canonical')).toMatchObject({
      objectKind: 'final',
      suppressionStartedAt: '2026-07-21T12:16:00.000Z',
    });
  });

  it('requires permanent final-key inventory immediately before authenticated ingress writes R2', async () => {
    await seedEvent();
    const sessionId = await seedGuestSession();
    const repository = new MediaRepository(env.DB);
    const bytes = png(800, 600);
    const reserved = await repository.reserve({
      id: 'media-pre-put-tombstone', eventId: 'event-a', uploaderSessionId: sessionId, authority: guestUploadAuthority(sessionId),
      objectKey: 'events/event-a/uploads/media-pre-put-tombstone',
      originalFilename: 'photo.png', mimeType: 'image/png',
      declaredByteSize: bytes.byteLength, guestName: 'Avery', caption: null,
      idempotencyKey: 'idem-pre-put-tombstone',
      reservationExpiresAt: '2026-07-21T12:15:00.000Z', createdAt: now,
    });
    const guard = vi.fn().mockRejectedValue(new Error('target permanently suppressed'));
    const guardedRepository = new Proxy(repository, {
      get(target, property) {
        if (property === 'ensureFinalObjectWriteTombstone') return guard;
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const put = vi.spyOn(env.MEDIA_BUCKET, 'put');

    await expect(receiveMediaUpload(
      env.MEDIA_BUCKET,
      guardedRepository,
      reserved,
      timelineContext,
      guestUploadAuthority(sessionId),
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      'image/png',
      new Date('2026-07-21T12:01:00.000Z'),
    )).rejects.toThrow('target permanently suppressed');

    expect(guard).toHaveBeenCalledWith(
      'media-pre-put-tombstone',
      finalizedMediaObjectKey('event-a', 'media-pre-put-tombstone'),
      expect.any(String),
    );
    expect(put).not.toHaveBeenCalled();
  });

  it('parks an inactive promotion without pretending an uncommitted final is canonical', async () => {
    await seedEvent();
    const sessionId = await seedGuestSession();
    const repository = new MediaRepository(env.DB);
    const reserved = await repository.reserve({
      id: 'media-inactive-promotion', eventId: 'event-a', uploaderSessionId: sessionId, authority: guestUploadAuthority(sessionId),
      objectKey: 'events/event-a/uploads/media-inactive-promotion', originalFilename: 'photo.png',
      mimeType: 'image/png', declaredByteSize: 128, guestName: 'Avery', caption: null,
      idempotencyKey: 'idem-inactive-promotion',
      reservationExpiresAt: '2026-07-21T12:15:00.000Z', createdAt: now,
    });
    await env.DB.prepare('UPDATE events SET deleted_at = ? WHERE id = ?')
      .bind('2026-07-21T12:16:00.000Z', 'event-a').run();

    const claimed = await repository.claimInactivePromotion(
      reserved.id,
      'inactive-owner-at-least-sixteen-bytes',
      '2026-07-21T12:16:01.000Z',
      '2026-07-21T12:36:01.000Z',
    );
    expect(claimed).not.toBeNull();
    await expect(repository.parkInactivePromotionCleanup(
      reserved.id,
      claimed!.promotion.claimToken!,
      '2026-07-21T12:16:02.000Z',
    )).resolves.toBe(true);
    expect(await repository.getPromotion(reserved.id)).toMatchObject({
      state: 'cleanup_pending',
      finalPointerCommitted: false,
      sourceEtag: null,
      sourceSha256: null,
    });
  });

  it('cannot downgrade an ingress commit that wins after an inactive probe selected copying work', async () => {
    await seedEvent();
    const sessionId = await seedGuestSession();
    const repository = new MediaRepository(env.DB);
    const reserved = await repository.reserve({
      id: 'media-ingress-park-race', eventId: 'event-a', uploaderSessionId: sessionId, authority: guestUploadAuthority(sessionId),
      objectKey: 'events/event-a/uploads/media-ingress-park-race',
      originalFilename: 'photo.png', mimeType: 'image/png', declaredByteSize: 128,
      guestName: 'Avery', caption: null, idempotencyKey: 'idem-ingress-park-race',
      reservationExpiresAt: '2026-07-21T12:15:00.000Z', createdAt: now,
    });
    const claimToken = 'ingress-park-race-owner-at-least-sixteen';
    const digest = 'b'.repeat(64);
    const claimed = await repository.claimReservationIngress({
      mediaId: reserved.id,
      eventId: reserved.eventId,
      authority: guestUploadAuthority(sessionId),
      sourceObjectKey: reserved.objectKey,
      mimeType: 'image/png',
      byteSize: 128,
      sha256: digest,
      width: 800,
      height: 600,
      claimToken,
      claimedAt: '2026-07-21T12:01:00.000Z',
      leaseExpiresAt: '2026-07-21T12:21:00.000Z',
    });
    expect(claimed).toMatchObject({ ok: true });

    // The scheduled pass selected the copying row. The HTTP writer commits
    // before its later inactive check/park CAS reaches D1.
    expect(await repository.commitReservationIngress({
      mediaId: reserved.id,
      eventId: reserved.eventId,
      authority: guestUploadAuthority(sessionId),
      claimToken,
      finalObjectKey: finalizedMediaObjectKey('event-a', reserved.id),
      byteSize: 128,
      width: 800,
      height: 600,
      finalEtag: 'canonical-final-etag',
      committedAt: '2026-07-21T12:02:00.000Z',
      capturedAt: null,
      timelineAt: '2026-07-21T12:02:00.000Z',
    })).toEqual({ ok: true, value: null });
    expect(await repository.ingressPromotionIsInactive(reserved.id)).toBe(true);
    expect(await repository.parkInactivePromotionCleanup(
      reserved.id,
      claimToken,
      '2026-07-21T12:02:01.000Z',
    )).toBe(false);

    expect(await repository.getById(reserved.id)).toMatchObject({
      uploadState: 'stored',
      objectBucketGeneration: 'canonical',
      objectKey: finalizedMediaObjectKey('event-a', reserved.id),
    });
    expect(await repository.getPromotion(reserved.id)).toMatchObject({
      state: 'cleanup_pending',
      finalPointerCommitted: true,
      claimToken,
    });
    expect(await new MediaObjectWriteTombstoneRepository(env.DB)
      .get(finalizedMediaObjectKey('event-a', reserved.id), 'canonical'))
      .toMatchObject({ suppressionStartedAt: null });
  });

  it('requires a named guest for every new photo', async () => {
    await seedEvent();
    const sessionId = await seedGuestSession();

    await expect(new MediaRepository(env.DB).reserve({
      id: 'media-nameless', eventId: 'event-a', uploaderSessionId: sessionId, authority: guestUploadAuthority(sessionId),
      objectKey: 'events/event-a/media/nameless', originalFilename: 'photo.jpg',
      mimeType: 'image/jpeg', declaredByteSize: 1024, guestName: null as never, caption: null,
      idempotencyKey: 'idem-nameless', reservationExpiresAt: '2026-07-21T12:15:00.000Z', createdAt: now,
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('uses wedding-scale count and storage quotas', async () => {
    await seedEvent();
    const sessionId = await seedGuestSession();
    await env.DB.prepare(`
      UPDATE events SET stored_media_count = 50, stored_bytes = ? WHERE id = ?
    `).bind(300 * 1024 * 1024, 'event-a').run();

    const reserved = await new MediaRepository(env.DB).reserve({
      id: 'media-scale', eventId: 'event-a', uploaderSessionId: sessionId, authority: guestUploadAuthority(sessionId),
      objectKey: 'events/event-a/media/scale', originalFilename: 'photo.jpg',
      mimeType: 'image/jpeg', declaredByteSize: 1024, guestName: 'Avery', caption: null,
      idempotencyKey: 'idem-scale', reservationExpiresAt: '2026-07-21T12:15:00.000Z', createdAt: now,
    });

    expect(reserved.id).toBe('media-scale');
  });

  it('reserves quota once for an idempotency key', async () => {
    const events = await seedEvent();
    const sessionId = await seedGuestSession();
    const media = new MediaRepository(env.DB);
    const input = {
      id: 'media-a', eventId: 'event-a', uploaderSessionId: sessionId, authority: guestUploadAuthority(sessionId),
      objectKey: 'events/event-a/media/media-a', originalFilename: 'photo.jpg',
      mimeType: 'image/jpeg' as const, declaredByteSize: 1024,
      guestName: 'Avery', caption: null, idempotencyKey: 'idem-a',
      reservationExpiresAt: '2026-07-21T12:15:00.000Z', createdAt: now,
    };

    const created = await media.reserve(input);
    const repeated = await media.reserve({ ...input, id: 'different-id', objectKey: 'different-key' });
    const event = await events.getById('event-a');

    expect(created.id).toBe('media-a');
    expect(repeated.id).toBe('media-a');
    expect(event?.reservedMediaCount).toBe(1);
    expect(event?.reservedBytes).toBe(1024);
  });

  it('reopens a failed idempotent reservation without duplicating quota', async () => {
    const events = await seedEvent();
    const sessionId = await seedGuestSession();
    const media = new MediaRepository(env.DB);
    const input = {
      id: 'media-retry', eventId: 'event-a', uploaderSessionId: sessionId, authority: guestUploadAuthority(sessionId),
      objectKey: 'events/event-a/media/media-retry', originalFilename: 'photo.jpg',
      mimeType: 'image/jpeg' as const, declaredByteSize: 1024,
      guestName: 'Avery', caption: null, idempotencyKey: 'idem-retry',
      reservationExpiresAt: '2026-07-21T12:15:00.000Z', createdAt: now,
    };

    await media.reserve(input);
    await media.failReservation(input.id);
    const retried = await media.reserve({
      ...input,
      id: 'must-not-create-a-second-row',
      objectKey: 'must-not-create-a-second-object',
      reservationExpiresAt: '2026-07-21T12:45:00.000Z',
      createdAt: '2026-07-21T12:30:00.000Z',
    });
    const event = await events.getById('event-a');

    expect(retried).toMatchObject({
      id: 'media-retry', uploadState: 'reserved', reservationExpiresAt: '2026-07-21T12:45:00.000Z',
    });
    expect(event?.reservedMediaCount).toBe(1);
    expect(event?.reservedBytes).toBe(1024);
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM media').first<{ count: number }>())?.count).toBe(1);
  });

  it('refreshes an expired active reservation without reserving quota twice', async () => {
    const events = await seedEvent();
    const sessionId = await seedGuestSession();
    const media = new MediaRepository(env.DB);
    const input = {
      id: 'media-refresh', eventId: 'event-a', uploaderSessionId: sessionId, authority: guestUploadAuthority(sessionId),
      objectKey: 'events/event-a/media/media-refresh', originalFilename: 'photo.jpg',
      mimeType: 'image/jpeg' as const, declaredByteSize: 1024,
      guestName: 'Avery', caption: null, idempotencyKey: 'idem-refresh',
      reservationExpiresAt: '2026-07-21T12:05:00.000Z', createdAt: now,
    };

    await media.reserve(input);
    expect(await media.getPromotion(input.id)).toMatchObject({
      state: 'pending', sourceObjectKey: input.objectKey,
    });
    expect(await env.DB.prepare(`
      SELECT 1 AS permitted FROM events
      WHERE id = ? AND deleted_at IS NULL AND uploads_enabled = 1
        AND COALESCE(photos_open_from, event_start_at) <= ?
    `).bind(input.eventId, '2026-07-21T12:30:00.000Z').first<number>('permitted')).toBe(1);
    const refreshed = await media.reserve({
      ...input,
      id: 'ignored-id',
      reservationExpiresAt: '2026-07-21T12:45:00.000Z',
      createdAt: '2026-07-21T12:30:00.000Z',
    });
    const event = await events.getById('event-a');

    expect(refreshed).toMatchObject({ id: 'media-refresh', reservationExpiresAt: '2026-07-21T12:45:00.000Z' });
    expect(await media.getPromotion(refreshed.id)).toMatchObject({
      state: 'pending', sourceWritableUntil: '2026-07-21T12:45:00.000Z',
    });
    expect(event?.reservedMediaCount).toBe(1);
    expect(event?.reservedBytes).toBe(1024);
  });

  it('rejects a reserved refresh after inactive cleanup owns the signed alias', async () => {
    await seedEvent();
    const sessionId = await seedGuestSession();
    const media = new MediaRepository(env.DB);
    const input = {
      id: 'media-refresh-claimed', eventId: 'event-a', uploaderSessionId: sessionId, authority: guestUploadAuthority(sessionId),
      objectKey: 'events/event-a/uploads/media-refresh-claimed', originalFilename: 'photo.jpg',
      mimeType: 'image/jpeg' as const, declaredByteSize: 1024,
      guestName: 'Avery', caption: null, idempotencyKey: 'idem-refresh-claimed',
      reservationExpiresAt: '2026-07-21T12:05:00.000Z', createdAt: now,
    };
    const reserved = await media.reserve(input);
    expect(await media.claimInactivePromotion(
      reserved.id,
      'refresh-owner-at-least-sixteen-bytes',
      '2026-07-21T12:06:00.000Z',
      '2026-07-21T12:26:00.000Z',
    )).not.toBeNull();

    await expect(media.reserve({
      ...input,
      id: 'ignored-refresh-id',
      reservationExpiresAt: '2026-07-21T12:45:00.000Z',
      createdAt: '2026-07-21T12:06:01.000Z',
    })).rejects.toMatchObject({ code: 'UPLOAD_FINALIZE_CONFLICT', status: 409 });
    expect(await media.getById(reserved.id)).toMatchObject({
      uploadState: 'reserved', reservationExpiresAt: '2026-07-21T12:05:00.000Z',
    });
    expect(await media.getPromotion(reserved.id)).toMatchObject({
      state: 'copying', sourceWritableUntil: '2026-07-21T12:05:00.000Z',
    });
  });

  it('rejects failed-reservation reactivation after inactive cleanup owns the alias', async () => {
    await seedEvent();
    const sessionId = await seedGuestSession();
    const media = new MediaRepository(env.DB);
    const input = {
      id: 'media-failed-claimed', eventId: 'event-a', uploaderSessionId: sessionId, authority: guestUploadAuthority(sessionId),
      objectKey: 'events/event-a/uploads/media-failed-claimed', originalFilename: 'photo.jpg',
      mimeType: 'image/jpeg' as const, declaredByteSize: 1024,
      guestName: 'Avery', caption: null, idempotencyKey: 'idem-failed-claimed',
      reservationExpiresAt: '2026-07-21T12:05:00.000Z', createdAt: now,
    };
    const reserved = await media.reserve(input);
    await media.failReservation(reserved.id);
    expect(await media.claimInactivePromotion(
      reserved.id,
      'failed-owner-at-least-sixteen-bytes',
      '2026-07-21T12:06:00.000Z',
      '2026-07-21T12:26:00.000Z',
    )).not.toBeNull();

    await expect(media.reserve({
      ...input,
      id: 'ignored-failed-id',
      reservationExpiresAt: '2026-07-21T12:45:00.000Z',
      createdAt: '2026-07-21T12:06:01.000Z',
    })).rejects.toMatchObject({ code: 'UPLOAD_FINALIZE_CONFLICT', status: 409 });
    expect(await media.getById(reserved.id)).toMatchObject({ uploadState: 'failed' });
    expect(await media.getPromotion(reserved.id)).toMatchObject({
      state: 'copying', sourceWritableUntil: '2026-07-21T12:05:00.000Z',
    });
  });

  it('decrements stored counters once when identical-timestamp deletes race', async () => {
    const events = await seedEvent();
    const sessionId = await seedGuestSession();
    const media = new MediaRepository(env.DB);
    const reserved = await media.reserve({
      id: 'media-delete-race', eventId: 'event-a', uploaderSessionId: sessionId, authority: guestUploadAuthority(sessionId),
      objectKey: 'events/event-a/media/media-delete-race', originalFilename: 'photo.jpg',
      mimeType: 'image/jpeg', declaredByteSize: 1024,
      guestName: 'Avery', caption: null, idempotencyKey: 'idem-delete-race',
      reservationExpiresAt: '2026-07-21T12:15:00.000Z', createdAt: now,
    });
    await media.finalize(
      reserved.id,
      { byteSize: 900, width: 800, height: 600 },
      '2026-07-21T12:15:00.000Z',
      { capturedAt: null, timelineAt: '2026-07-21T12:15:00.000Z' },
    );
    await env.DB.prepare('DELETE FROM media_object_promotions WHERE media_id = ?')
      .bind(reserved.id).run();

    const [first, second] = await Promise.all([
      media.delete(reserved.id, '2026-07-21T12:20:00.000Z'),
      media.delete(reserved.id, '2026-07-21T12:20:00.000Z'),
    ]);

    expect(first.uploadState).toBe('deleted');
    expect(second.uploadState).toBe('deleted');
    expect(await events.getById('event-a')).toMatchObject({
      storedMediaCount: 0, storedBytes: 0,
    });
  });

  it('reserves a new metadata batch through one aggregate repository operation', async () => {
    const events = await seedEvent();
    const sessionId = await seedGuestSession();
    const media = new MediaRepository(env.DB);
    const makeInput = (suffix: string, bytes: number) => ({
      id: `media-batch-${suffix}`, eventId: 'event-a', uploaderSessionId: sessionId, authority: guestUploadAuthority(sessionId),
      objectKey: `events/event-a/media/media-batch-${suffix}`, originalFilename: `${suffix}.jpg`,
      mimeType: 'image/jpeg' as const, declaredByteSize: bytes,
      guestName: 'Avery', caption: null, idempotencyKey: `idem-batch-${suffix}`,
      reservationExpiresAt: '2026-07-21T12:15:00.000Z', createdAt: now,
    });

    const results = await media.reserveBatch([makeInput('a', 100), makeInput('b', 200), makeInput('c', 300)]);
    const event = await events.getById('event-a');

    expect(results.map((result) => result.status)).toEqual(['accepted', 'accepted', 'accepted']);
    expect(results.map((result) => result.status === 'accepted' ? result.media.id : null))
      .toEqual(['media-batch-a', 'media-batch-b', 'media-batch-c']);
    expect(event).toMatchObject({ reservedMediaCount: 3, reservedBytes: 600 });
  });

  it('rejects count and byte quota overflow without leaving a row', async () => {
    await seedEvent();
    const sessionId = await seedGuestSession();
    await env.DB.prepare('UPDATE events SET stored_media_count = 10000 WHERE id = ?').bind('event-a').run();
    const media = new MediaRepository(env.DB);

    await expect(media.reserve({
      id: 'media-over', eventId: 'event-a', uploaderSessionId: sessionId, authority: guestUploadAuthority(sessionId),
      objectKey: 'events/event-a/media/over', originalFilename: 'over.jpg',
      mimeType: 'image/jpeg', declaredByteSize: 1024, guestName: 'Avery', caption: null,
      idempotencyKey: 'idem-over', reservationExpiresAt: '2026-07-21T12:15:00.000Z', createdAt: now,
    })).rejects.toMatchObject({ code: 'EVENT_MEDIA_LIMIT' });

    expect(await media.getById('media-over')).toBeNull();
  });

  it('finalizes once, enforces matching metadata, moderates, and deletes counters once', async () => {
    const events = await seedEvent();
    const sessionId = await seedGuestSession();
    const media = new MediaRepository(env.DB);
    await media.reserve({
      id: 'media-a', eventId: 'event-a', uploaderSessionId: sessionId, authority: guestUploadAuthority(sessionId),
      objectKey: 'events/event-a/media/media-a', originalFilename: 'photo.jpg',
      mimeType: 'image/jpeg', declaredByteSize: 2048, guestName: 'Avery', caption: 'A quiet moment',
      idempotencyKey: 'idem-a', reservationExpiresAt: '2026-07-21T12:15:00.000Z', createdAt: now,
    });

    const finalized = await media.finalize(
      'media-a',
      { byteSize: 1800, width: 1200, height: 800 },
      '2026-07-21T12:05:00.000Z',
      { capturedAt: null, timelineAt: '2026-07-21T12:05:00.000Z' },
    );
    const repeated = await media.finalize(
      'media-a',
      { byteSize: 1800, width: 1200, height: 800 },
      '2026-07-21T12:05:00.000Z',
      { capturedAt: null, timelineAt: '2026-07-21T12:05:00.000Z' },
    );
    await expect(media.finalize(
      'media-a',
      { byteSize: 1700, width: 1200, height: 800 },
      '2026-07-21T12:05:00.000Z',
      { capturedAt: null, timelineAt: '2026-07-21T12:05:00.000Z' },
    ))
      .rejects.toMatchObject({ code: 'UPLOAD_FINALIZE_CONFLICT' });
    const approved = await media.setPublication('media-a', 'unpublished', 'published', '2026-07-21T12:05:00.000Z');
    await expect(media.setPublication('media-a', 'unpublished', 'hidden', now))
      .rejects.toMatchObject({ code: 'MEDIA_STATE_CONFLICT' });
    await media.delete('media-a', '2026-07-21T12:06:00.000Z');
    await media.delete('media-a', '2026-07-21T12:07:00.000Z');
    const event = await events.getById('event-a');

    expect(finalized.uploadState).toBe('stored');
    expect(repeated.byteSize).toBe(1800);
    expect(approved.publishedAt).toBe('2026-07-21T12:05:00.000Z');
    expect(event?.storedMediaCount).toBe(0);
    expect(event?.storedBytes).toBe(0);
  });

  it('retries deletion when reserved finalization wins after the delete state read', async () => {
    const events = await seedEvent();
    const sessionId = await seedGuestSession();
    const base = new MediaRepository(env.DB);
    const reserved = await base.reserve({
      id: 'media-delete-finalize-race', eventId: 'event-a', uploaderSessionId: sessionId, authority: guestUploadAuthority(sessionId),
      objectKey: 'events/event-a/uploads/media-delete-finalize-race',
      originalFilename: 'race.png', mimeType: 'image/png', declaredByteSize: 128,
      guestName: 'Avery', caption: null, idempotencyKey: 'delete-finalize-race',
      reservationExpiresAt: '2026-07-21T12:15:00.000Z', createdAt: now,
    });
    let raced = false;
    const db = new Proxy(env.DB, {
      get(target, property) {
        if (property === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            if (!raced) {
              raced = true;
              await base.finalize(
                reserved.id,
                { byteSize: 120, width: 800, height: 600 },
                '2026-07-21T12:01:00.000Z',
                { capturedAt: null, timelineAt: '2026-07-21T12:01:00.000Z' },
              );
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const deleted = await new MediaRepository(db).delete(
      reserved.id,
      '2026-07-21T12:02:00.000Z',
    );
    expect(raced).toBe(true);
    expect(deleted).toMatchObject({ uploadState: 'deleted', deletedAt: '2026-07-21T12:02:00.000Z' });
    expect(await events.getById('event-a')).toMatchObject({
      reservedMediaCount: 0,
      reservedBytes: 0,
      storedMediaCount: 0,
      storedBytes: 0,
    });
  });

  it('retries deletion when failed reservation reactivation wins after the delete state read', async () => {
    const events = await seedEvent();
    const sessionId = await seedGuestSession();
    const base = new MediaRepository(env.DB);
    const input = {
      id: 'media-delete-refresh-race', eventId: 'event-a', uploaderSessionId: sessionId, authority: guestUploadAuthority(sessionId),
      objectKey: 'events/event-a/uploads/media-delete-refresh-race',
      originalFilename: 'race.png', mimeType: 'image/png' as const, declaredByteSize: 128,
      guestName: 'Avery', caption: null, idempotencyKey: 'delete-refresh-race',
      reservationExpiresAt: '2026-07-21T12:15:00.000Z', createdAt: now,
    };
    const failed = await base.reserve(input);
    await base.failReservation(failed.id);
    let raced = false;
    const db = new Proxy(env.DB, {
      get(target, property) {
        if (property === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            if (!raced) {
              raced = true;
              await base.reserve({
                ...input,
                id: 'ignored-refresh-race-id',
                reservationExpiresAt: '2026-07-21T12:30:00.000Z',
                createdAt: '2026-07-21T12:01:00.000Z',
              });
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const deleted = await new MediaRepository(db).delete(
      failed.id,
      '2026-07-21T12:02:00.000Z',
    );
    expect(raced).toBe(true);
    expect(deleted).toMatchObject({ uploadState: 'deleted', deletedAt: '2026-07-21T12:02:00.000Z' });
    expect(await events.getById('event-a')).toMatchObject({
      reservedMediaCount: 0,
      reservedBytes: 0,
      storedMediaCount: 0,
      storedBytes: 0,
    });
  });

  it('sets the storage timestamp on the first finalization and preserves it on repeats', async () => {
    await seedEvent();
    const sessionId = await seedGuestSession();
    const media = new MediaRepository(env.DB);
    await media.reserve({
      id: 'media-stored-at', eventId: 'event-a', uploaderSessionId: sessionId, authority: guestUploadAuthority(sessionId),
      objectKey: 'events/event-a/media/stored-at', originalFilename: 'photo.jpg',
      mimeType: 'image/jpeg', declaredByteSize: 2048, guestName: 'Avery', caption: null,
      idempotencyKey: 'idem-stored-at', reservationExpiresAt: '2026-07-21T12:15:00.000Z', createdAt: now,
    });
    const metadata = { byteSize: 1800, width: 1200, height: 800 };
    const firstStoredAt = '2026-07-21T12:01:00.000Z';

    await media.finalize(
      'media-stored-at',
      metadata,
      firstStoredAt,
      { capturedAt: null, timelineAt: firstStoredAt },
    );
    await media.finalize(
      'media-stored-at',
      metadata,
      '2026-07-21T12:02:00.000Z',
      { capturedAt: null, timelineAt: '2026-07-21T12:02:00.000Z' },
    );

    const row = await env.DB.prepare('SELECT created_at, stored_at FROM media WHERE id = ?')
      .bind('media-stored-at')
      .first<{ created_at: string; stored_at: string | null }>();
    expect(row).toEqual({ created_at: now, stored_at: firstStoredAt });
  });

  it('stamps storage eligibility after delayed validation while keeping expiry deterministic', async () => {
    await seedEvent();
    const sessionId = await seedGuestSession();
    const repository = new MediaRepository(env.DB);
    const reserved = await repository.reserve({
      id: 'media-delayed-validation', eventId: 'event-a', uploaderSessionId: sessionId, authority: guestUploadAuthority(sessionId),
      objectKey: 'events/event-a/media/delayed-validation', originalFilename: 'photo.png',
      mimeType: 'image/png', declaredByteSize: 128, guestName: 'Avery', caption: null,
      idempotencyKey: 'idem-delayed-validation',
      reservationExpiresAt: '2026-07-21T12:15:00.000Z', createdAt: now,
    });
    const bytes = png(1200, 800);
    const expiryCheckTime = new Date('2026-07-21T12:10:00.000Z');
    const storageEligibilityTime = new Date('2026-07-21T12:20:00.000Z');
    const laterRetryTime = new Date('2026-07-21T12:30:00.000Z');
    const copiedObjects = new Map<string, Uint8Array>();
    const bucket = {
      async head() {
        return {
          etag: 'validated-version',
          size: bytes.byteLength,
          httpMetadata: { contentType: 'image/png' },
        };
      },
      async get(key: string) {
        await Promise.resolve();
        vi.setSystemTime(storageEligibilityTime);
        const stored = copiedObjects.get(key);
        return stored
          ? {
            body: new Response(stored.buffer.slice(
              stored.byteOffset,
              stored.byteOffset + stored.byteLength,
            ) as ArrayBuffer).body,
            etag: 'canonical-validated-version',
            size: stored.byteLength,
            httpMetadata: { contentType: 'image/png' },
          }
          : {
              body: new Response(bytes).body,
              etag: 'validated-version',
              size: bytes.byteLength,
              httpMetadata: { contentType: 'image/png' },
            };
      },
      async put(key: string, value: ReadableStream) {
        const stored = new Uint8Array(await new Response(value).arrayBuffer());
        copiedObjects.set(key, stored);
        return { size: stored.byteLength };
      },
      delete: vi.fn((key: string | string[]) => {
        for (const item of Array.isArray(key) ? key : [key]) copiedObjects.delete(item);
      }),
    } as unknown as R2Bucket;

    vi.useFakeTimers();
    vi.setSystemTime(expiryCheckTime);
    try {
      const finalized = await finalizeStoredMedia(bucket, repository, reserved, timelineContext);
      vi.setSystemTime(laterRetryTime);
      await finalizeStoredMedia(bucket, repository, finalized, timelineContext);

      const row = await env.DB.prepare('SELECT stored_at FROM media WHERE id = ?')
        .bind(reserved.id)
        .first<{ stored_at: string | null }>();
      expect(row?.stored_at).toBe(storageEligibilityTime.toISOString());
      expect(bucket.delete).not.toHaveBeenCalled();
      expect(await repository.getPromotion(reserved.id)).toMatchObject({
        state: 'cleanup_pending',
        finalPointerCommitted: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses to copy a different temporary object version than the one whose image header was validated', async () => {
    await seedEvent();
    const sessionId = await seedGuestSession();
    const repository = new MediaRepository(env.DB);
    const reserved = await repository.reserve({
      id: 'media-version-race', eventId: 'event-a', uploaderSessionId: sessionId, authority: guestUploadAuthority(sessionId),
      objectKey: 'events/event-a/uploads/media-version-race', originalFilename: 'photo.png',
      mimeType: 'image/png', declaredByteSize: 128, guestName: 'Avery', caption: null,
      idempotencyKey: 'idem-version-race',
      reservationExpiresAt: '2026-07-21T12:15:00.000Z', createdAt: now,
    });
    const validated = png(1200, 800);
    const swapped = png(300, 200);
    await env.MEDIA_BUCKET.put(reserved.objectKey, validated, { httpMetadata: { contentType: 'image/png' } });
    let swappedAfterHeaderRead = false;
    const racingBucket = {
      head: env.MEDIA_BUCKET.head.bind(env.MEDIA_BUCKET),
      async get(key: string, options?: R2GetOptions) {
        const result = await env.MEDIA_BUCKET.get(key, options as R2GetOptions & { onlyIf: R2Conditional });
        if (options?.range && !swappedAfterHeaderRead) {
          swappedAfterHeaderRead = true;
          await env.MEDIA_BUCKET.put(key, swapped, { httpMetadata: { contentType: 'image/png' } });
        }
        return result;
      },
      put: env.MEDIA_BUCKET.put.bind(env.MEDIA_BUCKET),
      delete: env.MEDIA_BUCKET.delete.bind(env.MEDIA_BUCKET),
    } as unknown as R2Bucket;

    await expect(finalizeStoredMedia(
      racingBucket,
      repository,
      reserved,
      timelineContext,
      new Date('2026-07-21T12:10:00.000Z'),
    ))
      .rejects.toMatchObject({ code: 'UPLOAD_FINALIZE_CONFLICT', status: 409 });
    expect((await repository.getById(reserved.id))?.uploadState).toBe('reserved');
    expect(await env.MEDIA_BUCKET.head(`events/event-a/media/final/${reserved.id}`)).toBeNull();
  });

  it('recovers a validated final object left before the atomic D1 finalize transition', async () => {
    await seedEvent();
    const sessionId = await seedGuestSession();
    const repository = new MediaRepository(env.DB);
    const reserved = await repository.reserve({
      id: 'media-orphan-recovery', eventId: 'event-a', uploaderSessionId: sessionId, authority: guestUploadAuthority(sessionId),
      objectKey: 'events/event-a/uploads/media-orphan-recovery', originalFilename: 'photo.png',
      mimeType: 'image/png', declaredByteSize: 128, guestName: 'Avery', caption: null,
      idempotencyKey: 'idem-orphan-recovery',
      reservationExpiresAt: '2026-07-21T12:15:00.000Z', createdAt: now,
    });
    const bytes = png(1200, 800);
    await env.MEDIA_BUCKET.put(reserved.objectKey, bytes, { httpMetadata: { contentType: 'image/png' } });
    let failAfterFinalPut = true;
    const interruptedBucket = new Proxy(env.MEDIA_BUCKET, {
      get(target, property) {
        if (property === 'put') {
          return async (...args: Parameters<R2Bucket['put']>) => {
            const stored = await target.put(...args);
            if (failAfterFinalPut) {
              failAfterFinalPut = false;
              throw new Error('simulated isolate loss after final R2 put');
            }
            return stored;
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await expect(finalizeStoredMedia(
      interruptedBucket,
      repository,
      reserved,
      timelineContext,
      new Date('2026-07-21T12:10:00.000Z'),
    )).rejects.toThrow('simulated isolate loss');
    expect((await repository.getById(reserved.id))?.uploadState).toBe('reserved');
    expect(await env.MEDIA_BUCKET.head(finalizedMediaObjectKey('event-a', reserved.id))).not.toBeNull();

    const recovered = await finalizeStoredMedia(
      env.MEDIA_BUCKET,
      repository,
      reserved,
      timelineContext,
      new Date('2026-07-21T12:10:00.000Z'),
    );
    expect(recovered).toMatchObject({
      uploadState: 'stored', objectKey: finalizedMediaObjectKey('event-a', reserved.id),
      byteSize: bytes.byteLength, width: 1200, height: 800,
    });
    expect(await env.MEDIA_BUCKET.head(reserved.objectKey)).not.toBeNull();
    expect(await repository.getPromotion(reserved.id)).toMatchObject({
      state: 'cleanup_pending',
      finalPointerCommitted: true,
    });
    expect(new Uint8Array(await (await env.MEDIA_BUCKET.get(recovered.objectKey))!.arrayBuffer())).toEqual(bytes);
  });

  it('does not adopt an arbitrary preexisting final object during recovery', async () => {
    await seedEvent();
    const sessionId = await seedGuestSession();
    const repository = new MediaRepository(env.DB);
    const reserved = await repository.reserve({
      id: 'media-orphan-reject', eventId: 'event-a', uploaderSessionId: sessionId, authority: guestUploadAuthority(sessionId),
      objectKey: 'events/event-a/uploads/media-orphan-reject', originalFilename: 'photo.png',
      mimeType: 'image/png', declaredByteSize: 128, guestName: 'Avery', caption: null,
      idempotencyKey: 'idem-orphan-reject',
      reservationExpiresAt: '2026-07-21T12:15:00.000Z', createdAt: now,
    });
    const source = png(1200, 800);
    const unrelated = png(300, 200);
    await env.MEDIA_BUCKET.put(reserved.objectKey, source, { httpMetadata: { contentType: 'image/png' } });
    await env.MEDIA_BUCKET.put(finalizedMediaObjectKey('event-a', reserved.id), unrelated, {
      httpMetadata: { contentType: 'image/png' },
    });

    await expect(finalizeStoredMedia(
      env.MEDIA_BUCKET,
      repository,
      reserved,
      timelineContext,
      new Date('2026-07-21T12:10:00.000Z'),
    )).rejects.toMatchObject({ code: 'UPLOAD_FINALIZE_CONFLICT', status: 409 });
    expect((await repository.getById(reserved.id))?.uploadState).toBe('reserved');
    expect(await env.MEDIA_BUCKET.head(reserved.objectKey)).not.toBeNull();
  });

  it('keeps private delivery separate from optional publication and exports every stored original', async () => {
    await seedEvent();
    const sessionId = await seedGuestSession();
    const repository = new MediaRepository(env.DB);
    await repository.reserve({
      id: 'media-private', eventId: 'event-a', uploaderSessionId: sessionId, authority: guestUploadAuthority(sessionId),
      objectKey: 'events/event-a/media/private', originalFilename: 'private.heic',
      mimeType: 'image/heic' as never, declaredByteSize: 2048, guestName: 'Avery', caption: null,
      idempotencyKey: 'idem-private', reservationExpiresAt: '2026-07-21T12:15:00.000Z', createdAt: now,
    });

    const delivered = await repository.finalize(
      'media-private',
      { byteSize: 1800, width: 1200, height: 800 },
      '2026-07-21T12:15:00.000Z',
      { capturedAt: null, timelineAt: '2026-07-21T12:15:00.000Z' },
    );
    const snapshot = await repository.exportSnapshot('event-a', '2026-07-21T12:30:00.000Z');

    expect((delivered as unknown as { publicationStatus: string }).publicationStatus).toBe('unpublished');
    expect(snapshot.map(({ id }) => id)).toEqual(['media-private']);
  });
});

describe('manager media pagination', () => {
  async function seedStored(count: number, eventId = 'event-a') {
    const sessionId = await seedGuestSession(eventId);
    for (const index of Array.from({ length: count }, (_, offset) => offset)) {
      const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      const createdAt = new Date(Date.UTC(2026, 6, 20, 9, 0, 0) + index * 60_000).toISOString();
      await env.DB.prepare(`
        INSERT INTO media (
          id, event_id, uploader_session_id, object_key, original_filename, mime_type,
          declared_byte_size, byte_size, width, height, guest_name, caption, upload_state,
          publication_status, idempotency_key, reservation_expires_at, created_at, stored_at
        )
        VALUES (?, ?, ?, ?, ?, 'image/png', 128, 128, 800, 600, 'Avery', NULL, 'stored', 'unpublished', ?, ?, ?, ?)
      `).bind(
        id,
        eventId,
        sessionId,
        `events/${eventId}/media/${id}`,
        `${index}.png`,
        `idem-${index}`,
        createdAt,
        createdAt,
        createdAt,
      ).run();
    }
  }

  async function planFor(options: Parameters<typeof buildManagerMediaQuery>[1]) {
    const query = buildManagerMediaQuery('event-a', options);
    const explained = await env.DB.prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
      .bind(...query.bindings)
      .all<{ detail: string }>();
    return explained.results.map((row) => row.detail).join(' | ');
  }

  it('plans both manager pages through the dedicated partial indexes without sorting', async () => {
    await seedEvent();
    await seedStored(3);
    const cursor = { storedAt: '2026-07-20T09:02:00.000Z', id: '00000000-0000-4000-8000-000000000002' };

    const unfiltered = await planFor({ limit: 24 });
    const unfilteredWithCursor = await planFor({ limit: 24, cursor });
    const filtered = await planFor({ limit: 24, status: 'published' });
    const filteredWithCursor = await planFor({ limit: 24, status: 'published', cursor });

    expect(unfiltered).toContain('media_manager_stored_page_all');
    expect(unfilteredWithCursor).toContain('media_manager_stored_page_all');
    expect(filtered).toContain('media_manager_stored_page_status');
    expect(filteredWithCursor).toContain('media_manager_stored_page_status');
    for (const plan of [unfiltered, unfilteredWithCursor, filtered, filteredWithCursor]) {
      expect(plan).not.toContain('TEMP B-TREE');
      expect(plan).not.toContain('SCAN media');
    }
  });

  it('closes the cursor on a last page that is exactly full', async () => {
    await seedEvent();
    await seedStored(48);
    const repository = new MediaRepository(env.DB);

    const first = await repository.listForManager('event-a', { limit: 24 });
    expect(first.media).toHaveLength(24);
    expect(first.nextCursor).not.toBeNull();

    const second = await repository.listForManager('event-a', { limit: 24, cursor: first.nextCursor! });
    expect(second.media).toHaveLength(24);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.media, ...second.media].map(({ id }) => id)).size).toBe(48);
  });
});

describe('durable event entry credentials', () => {
  it('creates one entry in the event batch and disables it exactly once', async () => {
    await seedEvent();
    const entries = new EventEntriesRepository(env.DB);
    await env.DB.batch([entries.createStatement({
      id: 'entry-a',
      eventId: 'event-a',
      secretDigest: 'entry-digest',
      secretCiphertext: 'entry-ciphertext',
      createdAt: now,
    })]);

    expect(await entries.getForEvent('event-a')).toMatchObject({
      id: 'entry-a', disabledAt: null, secretCiphertext: 'entry-ciphertext',
    });
    expect(await entries.getById('entry-a')).toMatchObject({ eventId: 'event-a' });

    expect(await entries.disableForEvent('event-a', '2026-07-21T13:00:00.000Z')).toBe(true);
    // A second click is not an error, and must not move the timestamp.
    expect(await entries.disableForEvent('event-a', '2026-07-21T14:00:00.000Z')).toBe(false);
    expect((await entries.getForEvent('event-a'))?.disabledAt)
      .toBe('2026-07-21T13:00:00.000Z');
  });
});

describe('RSVP roster statements', () => {
  function worstCaseRoster() {
    const households = Array.from({ length: 500 }, (_unused, index) => ({
      id: `household-${index}`,
      householdKey: `h${index}`,
      label: `Household ${index}`,
    }));
    const invitees = households.map((household, index) => ({
      id: `invitee-${index}`,
      householdId: household.id,
      kind: 'named' as const,
      displayName: `Guest Number ${index}`,
      lookupDigest: `digest-${index}`,
      sortOrder: 0,
    }));
    return { eventId: 'event-a', households, invitees, createdAt: now };
  }

  it('keeps every generated statement inside D1 parameter limits', () => {
    const plans = buildRosterStatements(worstCaseRoster());

    for (const plan of plans) {
      expect(plan.bindings.length).toBeLessThanOrEqual(MAX_D1_BINDINGS);
      // A placeholder count that drifts from the binding count is the failure
      // mode this bound is protecting against.
      expect(plan.sql.split('?').length - 1).toBe(plan.bindings.length);
    }
    expect(plans.length).toBeGreaterThan(1);
  });

  it('commits a full five-hundred-capacity roster as one batch', async () => {
    await seedEvent();
    const repository = new RsvpRepository(env.DB);
    const plans = buildRosterStatements(worstCaseRoster());

    await env.DB.batch(repository.toStatements(plans));

    expect(await repository.countHouseholds('event-a')).toBe(500);
    expect(await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM rsvp_invitees WHERE event_id = ?',
    ).bind('event-a').first('count')).toBe(500);
  });

  it('rolls the whole roster back when one statement fails', async () => {
    await seedEvent();
    const repository = new RsvpRepository(env.DB);
    const roster = worstCaseRoster();
    // A duplicate household key in the final chunk: nothing may survive it.
    const plans = buildRosterStatements({
      ...roster,
      households: [...roster.households, {
        id: 'household-duplicate', householdKey: 'h0', label: 'Duplicate',
      }],
    });

    await expect(env.DB.batch(repository.toStatements(plans))).rejects.toThrow();
    expect(await repository.countHouseholds('event-a')).toBe(0);
  });

  it('offers only active named guests as lookup candidates', async () => {
    await seedEvent();
    const repository = new RsvpRepository(env.DB);
    await env.DB.batch(repository.toStatements(buildRosterStatements({
      eventId: 'event-a',
      createdAt: now,
      households: [
        { id: 'household-a', householdKey: 'perkins', label: 'Perkins household' },
        { id: 'household-b', householdKey: 'rivera', label: 'Rivera household' },
      ],
      invitees: [
        {
          id: 'invitee-a', householdId: 'household-a', kind: 'named',
          displayName: 'Henry Perkins', lookupDigest: 'digest-henry', sortOrder: 0,
        },
        {
          id: 'invitee-slot', householdId: 'household-a', kind: 'plus_one',
          displayName: null, lookupDigest: null, sortOrder: 1,
        },
        {
          id: 'invitee-b', householdId: 'household-b', kind: 'named',
          displayName: 'Avery Rivera', lookupDigest: 'digest-avery', sortOrder: 0,
        },
      ],
    })));
    await env.DB.prepare('UPDATE rsvp_households SET archived_at = ? WHERE id = ?')
      .bind(now, 'household-b').run();

    // The plus-one carries no digest, and the archived household is gone from
    // lookup entirely.
    expect(await repository.listActiveLookupKeys('event-a')).toEqual([
      { householdId: 'household-a', nameKeys: ['digest-henry'] },
    ]);
    expect((await repository.listInvitees('event-a', 'household-a')).map((i) => i.kind))
      .toEqual(['named', 'plus_one']);
    expect(await repository.getHousehold('event-a', 'household-a'))
      .toMatchObject({ householdKey: 'perkins', version: 1, archivedAt: null });
    expect(await repository.getHousehold('event-b', 'household-a')).toBeNull();
  });
});

describe('RSVP household sessions and lookup budgets', () => {
  async function seedHousehold() {
    await seedEvent();
    await env.DB.batch(new RsvpRepository(env.DB).toStatements(buildRosterStatements({
      eventId: 'event-a',
      createdAt: now,
      households: [{ id: 'household-a', householdKey: 'perkins', label: 'Perkins household' }],
      invitees: [{
        id: 'invitee-a', householdId: 'household-a', kind: 'named',
        displayName: 'Henry Perkins', lookupDigest: 'digest-henry', sortOrder: 0,
      }],
    })));
  }

  it('mints, resolves, and revokes one household session', async () => {
    await seedHousehold();
    const sessions = new RsvpSessionsRepository(env.DB);
    const created = await sessions.create({
      id: 'rsvp-session-a',
      secretDigest: 'session-digest',
      csrfDigest: 'csrf-digest',
      eventId: 'event-a',
      householdId: 'household-a',
      writeAuthorityDeadline: '2026-08-31T04:59:59.999Z',
      expiresAt: '2026-10-19T23:59:59.999Z',
      createdAt: now,
    });

    expect(created).toMatchObject({
      householdId: 'household-a',
      writeAuthorityDeadline: '2026-08-31T04:59:59.999Z',
      revokedAt: null,
    });
    expect(await sessions.revoke('rsvp-session-a', '2026-07-21T13:00:00.000Z')).toBe(true);
    expect(await sessions.revoke('rsvp-session-a', '2026-07-21T14:00:00.000Z')).toBe(false);
    expect((await sessions.getById('rsvp-session-a'))?.revokedAt)
      .toBe('2026-07-21T13:00:00.000Z');
  });

  it('signs every household device out of one event at once', async () => {
    await seedHousehold();
    const sessions = new RsvpSessionsRepository(env.DB);
    for (const suffix of ['a', 'b']) {
      await sessions.create({
        id: `rsvp-session-${suffix}`,
        secretDigest: `session-digest-${suffix}`,
        csrfDigest: `csrf-digest-${suffix}`,
        eventId: 'event-a',
        householdId: 'household-a',
        writeAuthorityDeadline: '2026-08-31T04:59:59.999Z',
        expiresAt: '2026-10-19T23:59:59.999Z',
        createdAt: now,
      });
    }

    await env.DB.batch([
      sessions.revokeForEventStatement('event-a', '2026-07-21T13:00:00.000Z'),
    ]);

    expect(await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM rsvp_sessions WHERE revoked_at IS NULL',
    ).first('count')).toBe(0);
  });

  it('charges lookup attempts per event, scope, and fixed fifteen-minute window', async () => {
    await seedEvent();
    await seedEvent('event-b', 'other-event');
    const rates = new RsvpRateLimitsRepository(env.DB, rateKey);
    const attempt = (eventId: string, at: string) => rates.reserve({
      eventId,
      action: 'lookup_name',
      normalizedValue: 'henry perkins',
      limit: 2,
      now: new Date(at),
    });

    expect(await attempt('event-a', '2026-07-21T12:14:59.999Z')).toBe(true);
    expect(await attempt('event-a', '2026-07-21T12:14:59.999Z')).toBe(true);
    expect(await attempt('event-a', '2026-07-21T12:14:59.999Z')).toBe(false);
    // A different event is a different budget for the same name.
    expect(await attempt('event-b', '2026-07-21T12:14:59.999Z')).toBe(true);
    // The window is fixed to the quarter hour, not a sliding window.
    expect(await attempt('event-a', '2026-07-21T12:15:00.000Z')).toBe(true);

    const rows = await env.DB.prepare(`
      SELECT event_id, window_started_at, attempts, scope_digest
      FROM rsvp_lookup_rate_limits ORDER BY event_id, window_started_at
    `).all<{
      event_id: string;
      window_started_at: string;
      attempts: number;
      scope_digest: string;
    }>();
    expect(rows.results.map((row) => [row.event_id, row.window_started_at, row.attempts]))
      .toEqual([
        ['event-a', '2026-07-21T12:00:00.000Z', 3],
        ['event-a', '2026-07-21T12:15:00.000Z', 1],
        ['event-b', '2026-07-21T12:00:00.000Z', 1],
      ]);
    // The submitted name must be unrecoverable from what was stored.
    for (const row of rows.results) {
      expect(row.scope_digest).not.toContain('henry');
      expect(row.scope_digest).not.toContain('perkins');
    }
  });

  it('keeps the IP and name budgets separate', async () => {
    await seedEvent();
    const rates = new RsvpRateLimitsRepository(env.DB, rateKey);
    const at = new Date('2026-07-21T12:00:00.000Z');

    expect(await rates.reserve({
      eventId: 'event-a', action: 'lookup_ip', normalizedValue: 'henry perkins', limit: 1, now: at,
    })).toBe(true);
    expect(await rates.reserve({
      eventId: 'event-a', action: 'lookup_name', normalizedValue: 'henry perkins', limit: 1, now: at,
    })).toBe(true);

    expect(await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM rsvp_lookup_rate_limits',
    ).first('count')).toBe(2);
  });
});

describe('export jobs', () => {
  it('permits only one queued or running export per event', async () => {
    await env.DB.prepare(`
      UPDATE export_protocol_admission
      SET state = 'closed', closed_at = '2026-08-25T00:00:00.000Z'
      WHERE singleton = 1 AND state = 'legacy-open'
    `).run();
    await env.DB.prepare(`
      UPDATE export_protocol_admission
      SET state = 'open',
        worker_version_id = '123e4567-e89b-42d3-a456-426614174000',
        admitted_at = '2026-08-25T00:00:01.000Z'
      WHERE singleton = 1 AND state = 'closed'
    `).run();
    await seedEvent();
    const exports = new ExportsRepository(env.DB);
    // The first job is seeded rather than created. Creation is what the second
    // call is testing, and since 0019 a queued complete job must be entry-backed
    // with its Guestbook counts already frozen — the shape `seedExportJob`
    // writes and the shape `createActive` no longer accepts as a fixture.
    await seedExportJob({ id: 'export-a', eventId: 'event-a', snapshotAt: now, createdAt: now });

    await expect(exports.createActive({
      id: 'export-b', eventId: 'event-a', snapshotAt: now, createdAt: now,
    })).rejects.toMatchObject({ code: 'EXPORT_ALREADY_ACTIVE' });
  });
});

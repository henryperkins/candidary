import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ManagerAuth } from '../../worker/auth/manager';
import { AuthService } from '../../worker/auth/service';
import { AccountsRepository } from '../../worker/db/accounts';
import { EventsRepository } from '../../worker/db/events';
import { MediaRepository } from '../../worker/db/media';
import { HostSessionsRepository, SessionsRepository } from '../../worker/db/sessions';
import { TokensRepository } from '../../worker/db/tokens';
import type { EventRecord } from '../../worker/db/types';
import type { AppEnv } from '../../worker/env';
import { LinkService } from '../../worker/services/links';
import { ManagerUploadActorService } from '../../worker/services/manager-upload-actor';
import type { UploadAuthority } from '../../worker/services/upload-authority';
import { receiveMediaUpload } from '../../worker/storage/media';
import {
  DEFAULT_EVENT_THEME_CONFIG,
  serializeEventThemeConfig,
} from '../../shared/event-theme';
import { png, resetDatabase, testEnv } from './helpers';

const NOW = new Date('2026-08-27T12:00:00.000Z');
const NOW_ISO = NOW.toISOString();
const MANAGEMENT_EXPIRES_AT = '2026-12-18T23:59:59.999Z';

function actorRows() {
  return env.DB.prepare(`
    SELECT id, event_id, access_token_id, manager_upload_account_id, expires_at, revoked_at
    FROM event_sessions
    WHERE manager_upload_account_id IS NOT NULL
    ORDER BY created_at, id
  `).all<{
    id: string;
    event_id: string;
    access_token_id: string;
    manager_upload_account_id: string;
    expires_at: string;
    revoked_at: string | null;
  }>();
}

async function seedEvent(id = 'event-a'): Promise<EventRecord> {
  const event = await new EventsRepository(env.DB).create({
    id,
    slug: id,
    name: 'Maya & Theo',
    eventDate: '2026-09-19',
    welcomeMessage: 'Welcome.',
    guestAccessExpiresAt: '2026-10-19T23:59:59.999Z',
    managementAccessExpiresAt: MANAGEMENT_EXPIRES_AT,
    purgeAfter: '2027-01-17T23:59:59.999Z',
    createdAt: NOW_ISO,
    themeConfig: serializeEventThemeConfig(DEFAULT_EVENT_THEME_CONFIG),
    eventTimezone: 'America/Chicago',
    rsvpDeadlineAt: '2026-09-13T04:59:59.999Z',
    eventStartAt: '2026-09-19T05:00:00.000Z',
  });
  await env.DB.prepare('UPDATE events SET photos_open_from = ? WHERE id = ?')
    .bind(NOW_ISO, event.id).run();
  return (await new EventsRepository(env.DB).getById(event.id))!;
}

async function seedManagerToken(eventId: string, id = 'manager-token') {
  return new TokensRepository(env.DB).create({
    id,
    eventId,
    role: 'manager',
    secretDigest: `digest-${id}`,
    secretCiphertext: null,
    expiresAt: MANAGEMENT_EXPIRES_AT,
    createdAt: NOW_ISO,
  });
}

async function accountManager(role: 'owner' | 'cohost' = 'owner') {
  const event = await seedEvent();
  const token = await seedManagerToken(event.id);
  const account = await new AccountsRepository(env.DB).create({
    email: `${role}-${crypto.randomUUID()}@example.com`,
    passwordHash: 'password-hash',
    displayName: role,
    createdAt: NOW_ISO,
  });
  if (!account) throw new Error('Expected an account fixture.');
  await new AccountsRepository(env.DB).addEventHost(event.id, account.id, role, NOW_ISO);
  const host = await new AuthService(testEnv).createHostSession(account.id, account.authVersion, NOW);
  const auth: ManagerAuth = {
    event,
    sessionId: host.session.id,
    csrfDigest: host.session.csrfDigest,
    scope: 'host',
    via: 'account',
    accountId: account.id,
  };
  return { event, token, account, host: host.session, auth };
}

async function linkManager(): Promise<ManagerAuth> {
  const event = await seedEvent();
  const token = await seedManagerToken(event.id);
  const session = await new SessionsRepository(env.DB).create({
    id: 'link-session',
    secretDigest: 'link-session-digest',
    csrfDigest: 'link-csrf-digest',
    eventId: event.id,
    accessTokenId: token.id,
    role: 'manager',
    canClaimOwner: false,
    expiresAt: '2026-08-28T00:00:00.000Z',
    createdAt: NOW_ISO,
  });
  return {
    event,
    sessionId: session.id,
    csrfDigest: session.csrfDigest,
    scope: 'event',
    via: 'link',
    accountId: null,
  };
}

function withDatabase(base: AppEnv, db: D1Database): AppEnv {
  const fixture = Object.create(base) as AppEnv;
  Object.defineProperty(fixture, 'DB', { value: db });
  return fixture;
}

function isActorInsert(sql: string): boolean {
  return sql.includes('INSERT INTO event_sessions')
    && sql.includes('manager_upload_account_id')
    && sql.includes('FROM host_sessions AS hs');
}

function isLiveActorLookup(sql: string): boolean {
  return sql.trimStart().startsWith('SELECT')
    && sql.includes('manager_upload_account_id')
    && sql.includes('event_access_tokens');
}

function wrapStatement(
  statement: D1PreparedStatement,
  overrides: {
    run?: (statement: D1PreparedStatement) => ReturnType<D1PreparedStatement['run']>;
    first?: (statement: D1PreparedStatement) => ReturnType<D1PreparedStatement['first']>;
  },
): D1PreparedStatement {
  return new Proxy(statement, {
    get(target, property) {
      if (property === 'bind') {
        return (...values: unknown[]) => wrapStatement(target.bind(...values), overrides);
      }
      if (property === 'run' && overrides.run) return () => overrides.run!(target);
      if (property === 'first' && overrides.first) {
        return (...values: unknown[]) => overrides.first!(target).then((result) => {
          if (values.length === 0) return result;
          const row = result as Record<string, unknown> | null;
          return row?.[values[0] as string] ?? null;
        });
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function reserveWithActor(event: EventRecord, authority: UploadAuthority, id: string) {
  const bytes = png(800, 600, 128);
  return new MediaRepository(env.DB).reserve({
    id,
    eventId: event.id,
    uploaderSessionId: authority.actorSessionId,
    authority,
    objectKey: `events/${event.id}/uploads/${id}`,
    originalFilename: `${id}.png`,
    mimeType: 'image/png',
    declaredByteSize: bytes.byteLength,
    guestName: 'Host',
    caption: null,
    idempotencyKey: id,
    reservationExpiresAt: '2026-08-28T12:00:00.000Z',
    createdAt: '2026-08-27T12:00:01.000Z',
  });
}

beforeEach(resetDatabase);

describe('ManagerUploadActorService', () => {
  it('reuses an authenticated Manager link session without creating an actor row', async () => {
    const auth = await linkManager();
    const service = new ManagerUploadActorService(testEnv);

    expect(await service.ensureForReservation(auth, NOW)).toEqual({
      kind: 'manager-link',
      actorSessionId: auth.sessionId,
      eventSessionId: auth.sessionId,
    });
    expect(await service.lookupForExistingUpload(auth)).toEqual({
      kind: 'manager-link',
      actorSessionId: auth.sessionId,
      eventSessionId: auth.sessionId,
    });
    expect((await actorRows()).results).toEqual([]);
  });

  it.each(['owner', 'cohost'] as const)(
    'creates one account actor for an account %s and reuses it',
    async (role) => {
      const fixture = await accountManager(role);
      const service = new ManagerUploadActorService(testEnv);

      const first = await service.ensureForReservation(fixture.auth, NOW);
      const second = await service.ensureForReservation(fixture.auth, NOW);

      expect(first).toEqual({
        kind: 'manager-account',
        actorSessionId: expect.any(String),
        hostSessionId: fixture.host.id,
        accountId: fixture.account.id,
      });
      expect(second).toEqual(first);
      expect((await actorRows()).results).toEqual([expect.objectContaining({
        id: first.actorSessionId,
        event_id: fixture.event.id,
        manager_upload_account_id: fixture.account.id,
        revoked_at: null,
      })]);
    },
  );

  it('converts the unique-index loser into the same live actor under a controlled race', async () => {
    const fixture = await accountManager();
    let completedInitialReads = 0;
    let releaseReads!: () => void;
    const bothRead = new Promise<void>((resolve) => { releaseReads = resolve; });
    let insertAttempts = 0;
    const db = new Proxy(env.DB, {
      get(target, property) {
        if (property === 'prepare') {
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (isLiveActorLookup(sql)) {
              return wrapStatement(statement, {
                async first(bound) {
                  const captured = await bound.first();
                  completedInitialReads += 1;
                  if (completedInitialReads === 2) releaseReads();
                  if (completedInitialReads <= 2) await bothRead;
                  return captured;
                },
              });
            }
            if (isActorInsert(sql)) {
              return wrapStatement(statement, {
                run(bound) {
                  insertAttempts += 1;
                  return bound.run();
                },
              });
            }
            return statement;
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const service = new ManagerUploadActorService(withDatabase(testEnv, db));

    const [first, second] = await Promise.all([
      service.ensureForReservation(fixture.auth, NOW),
      service.ensureForReservation(fixture.auth, NOW),
    ]);

    expect(completedInitialReads).toBeGreaterThanOrEqual(2);
    expect(insertAttempts).toBe(2);
    expect(second).toEqual(first);
    expect((await actorRows()).results).toHaveLength(1);
  });

  it('lookup returns null without creating an account actor', async () => {
    const fixture = await accountManager();

    expect(await new ManagerUploadActorService(testEnv)
      .lookupForExistingUpload(fixture.auth)).toBeNull();
    expect((await actorRows()).results).toEqual([]);
  });

  it('does not reuse a revoked actor and creates one fresh identity', async () => {
    const fixture = await accountManager();
    const service = new ManagerUploadActorService(testEnv);
    const first = await service.ensureForReservation(fixture.auth, NOW);
    await new SessionsRepository(env.DB).revokeManagerUploadActors(
      fixture.event.id,
      fixture.account.id,
      '2026-08-27T12:00:01.000Z',
    );

    expect(await service.lookupForExistingUpload(fixture.auth)).toBeNull();
    const fresh = await service.ensureForReservation(
      fixture.auth,
      new Date('2026-08-27T12:00:02.000Z'),
    );

    expect(fresh.actorSessionId).not.toBe(first.actorSessionId);
    expect((await actorRows()).results).toEqual([
      expect.objectContaining({ id: first.actorSessionId, revoked_at: expect.any(String) }),
      expect.objectContaining({ id: fresh.actorSessionId, revoked_at: null }),
    ]);
  });

  it('binds the actor to the current Manager token and management expiry', async () => {
    const fixture = await accountManager();
    const authority = await new ManagerUploadActorService(testEnv)
      .ensureForReservation(fixture.auth, NOW);

    expect((await actorRows()).results).toEqual([expect.objectContaining({
      id: authority.actorSessionId,
      access_token_id: fixture.token.id,
      expires_at: fixture.event.managementAccessExpiresAt,
    })]);
  });

  it('evaluates the guarded insert after rotation and binds only the replacement token', async () => {
    const fixture = await accountManager();
    const predecessor = await new TokensRepository(env.DB).getActiveForRole(fixture.event.id, 'manager');
    let rotated = false;
    const db = new Proxy(env.DB, {
      get(target, property) {
        if (property === 'prepare') {
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!isActorInsert(sql)) return statement;
            return wrapStatement(statement, {
              async run(bound) {
                if (!rotated) {
                  rotated = true;
                  await new LinkService(testEnv).rotateManagementLink(
                    fixture.event,
                    0,
                    new Date('2026-08-27T12:00:01.000Z'),
                  );
                }
                return bound.run();
              },
            });
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const authority = await new ManagerUploadActorService(withDatabase(testEnv, db))
      .ensureForReservation(fixture.auth, new Date('2026-08-27T12:00:02.000Z'));
    const replacement = await new TokensRepository(env.DB)
      .getActiveForRole(fixture.event.id, 'manager');

    expect(rotated).toBe(true);
    expect(replacement?.id).not.toBe(predecessor?.id);
    expect((await new TokensRepository(env.DB).getById(predecessor!.id))?.revokedAt)
      .not.toBeNull();
    expect((await actorRows()).results).toEqual([expect.objectContaining({
      id: authority.actorSessionId,
      access_token_id: replacement!.id,
      revoked_at: null,
    })]);

    const bytes = png(800, 600, 128);
    const reserved = await reserveWithActor(fixture.event, authority, 'rotated-reservation');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-27T12:00:03.000Z'));
    let stored;
    try {
      stored = await receiveMediaUpload(
        env.CANONICAL_MEDIA_BUCKET,
        new MediaRepository(env.DB),
        reserved,
        {
          eventStartAt: fixture.event.eventStartAt,
          eventTimezone: fixture.event.eventTimezone,
        },
        authority,
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        'image/png',
        new Date('2026-08-27T12:00:03.000Z'),
      );
    } finally {
      vi.useRealTimers();
    }
    expect(stored).toMatchObject({
      uploadState: 'stored',
      uploaderSessionId: authority.actorSessionId,
    });
  });

  it('binds a first post-rotation actor to the replacement on its first attempt', async () => {
    const fixture = await accountManager();
    const predecessor = fixture.token.id;
    await new LinkService(testEnv).rotateManagementLink(
      fixture.event,
      0,
      new Date('2026-08-27T12:00:01.000Z'),
    );

    const authority = await new ManagerUploadActorService(testEnv)
      .ensureForReservation(fixture.auth, new Date('2026-08-27T12:00:02.000Z'));
    const replacement = await new TokensRepository(env.DB)
      .getActiveForRole(fixture.event.id, 'manager');

    expect(replacement?.id).not.toBe(predecessor);
    expect((await actorRows()).results).toEqual([expect.objectContaining({
      id: authority.actorSessionId,
      access_token_id: replacement!.id,
    })]);
  });

  it('raises the lifecycle refusal and inserts nothing when the management window has closed', async () => {
    const fixture = await accountManager();
    await env.DB.batch([
      env.DB.prepare('UPDATE events SET management_access_expires_at = ? WHERE id = ?')
        .bind(NOW_ISO, fixture.event.id),
      env.DB.prepare('UPDATE event_access_tokens SET expires_at = ? WHERE id = ?')
        .bind(NOW_ISO, fixture.token.id),
    ]);

    await expect(new ManagerUploadActorService(testEnv)
      .ensureForReservation(fixture.auth, NOW)).rejects.toMatchObject({
      code: 'EVENT_EXPIRED',
      status: 410,
    });
    expect((await actorRows()).results).toEqual([]);
  });

  it.each([
    {
      condition: 'revoked host session',
      code: 'SESSION_EXPIRED',
      mutate: async ({ host }: Awaited<ReturnType<typeof accountManager>>) => {
        await new HostSessionsRepository(env.DB).revoke(host.id, NOW_ISO);
      },
    },
    {
      condition: 'advanced account auth version',
      code: 'SESSION_EXPIRED',
      mutate: async ({ account }: Awaited<ReturnType<typeof accountManager>>) => {
        await env.DB.prepare('UPDATE host_accounts SET auth_version = auth_version + 1 WHERE id = ?')
          .bind(account.id).run();
      },
    },
    {
      condition: 'disabled account',
      code: 'ACCOUNT_DISABLED',
      mutate: async ({ account }: Awaited<ReturnType<typeof accountManager>>) => {
        await env.DB.prepare('UPDATE host_accounts SET disabled_at = ? WHERE id = ?')
          .bind(NOW_ISO, account.id).run();
      },
    },
    {
      condition: 'removed membership',
      code: 'ROLE_FORBIDDEN',
      mutate: async ({ event, account }: Awaited<ReturnType<typeof accountManager>>) => {
        await env.DB.prepare('DELETE FROM event_hosts WHERE event_id = ? AND account_id = ?')
          .bind(event.id, account.id).run();
      },
    },
    {
      condition: 'deleted event',
      code: 'EVENT_DELETED',
      mutate: async ({ event }: Awaited<ReturnType<typeof accountManager>>) => {
        await env.DB.prepare('UPDATE events SET deleted_at = ? WHERE id = ?')
          .bind(NOW_ISO, event.id).run();
      },
    },
    {
      condition: 'expired event',
      code: 'EVENT_EXPIRED',
      mutate: async ({ event }: Awaited<ReturnType<typeof accountManager>>) => {
        await env.DB.prepare('UPDATE events SET management_access_expires_at = ? WHERE id = ?')
          .bind(NOW_ISO, event.id).run();
      },
    },
  ])('re-proves and classifies a $condition after ManagerAuth resolution', async ({ code, mutate }) => {
    const fixture = await accountManager();
    await mutate(fixture);

    await expect(new ManagerUploadActorService(testEnv)
      .ensureForReservation(fixture.auth, NOW)).rejects.toMatchObject({ code });
    expect((await actorRows()).results).toEqual([]);
  });

  it('revokes on membership removal and gives a re-added member no path to the old reservation', async () => {
    const fixture = await accountManager();
    const service = new ManagerUploadActorService(testEnv);
    const oldAuthority = await service.ensureForReservation(fixture.auth, NOW);
    const oldReservation = await reserveWithActor(
      fixture.event,
      oldAuthority,
      'old-membership-reservation',
    );

    await env.DB.prepare('DELETE FROM event_hosts WHERE event_id = ? AND account_id = ?')
      .bind(fixture.event.id, fixture.account.id).run();

    expect(await service.lookupForExistingUpload(fixture.auth)).toBeNull();
    await expect(service.ensureForReservation(fixture.auth, NOW))
      .rejects.toMatchObject({ code: 'ROLE_FORBIDDEN' });
    expect((await actorRows()).results).toEqual([expect.objectContaining({
      id: oldAuthority.actorSessionId,
      revoked_at: expect.any(String),
    })]);

    await new AccountsRepository(env.DB).addEventHost(
      fixture.event.id,
      fixture.account.id,
      'cohost',
      '2026-08-27T12:00:02.000Z',
    );
    const freshAuthority = await service.ensureForReservation(
      fixture.auth,
      new Date('2026-08-27T12:00:03.000Z'),
    );

    expect(freshAuthority.actorSessionId).not.toBe(oldAuthority.actorSessionId);
    expect(await new MediaRepository(env.DB).listContributions(
      fixture.event.id,
      freshAuthority.actorSessionId,
    )).toEqual([]);
    expect(await new MediaRepository(env.DB).listContributions(
      fixture.event.id,
      oldAuthority.actorSessionId,
    )).toEqual([expect.objectContaining({ id: oldReservation.id })]);
  });
});

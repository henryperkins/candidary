import type { AlbumShareStatus, AlbumShareView, PublicAlbumView } from '../../shared/contracts';
import {
  ALBUM_SHARE_MAX_ACTIVE_SESSIONS,
  ALBUM_SHARE_SESSION_SECONDS,
} from '../../shared/constants';
import { ApiError } from '../../shared/errors';
import { AlbumRepository } from '../db/album';
import { PublicAlbumService } from './public-album';
import {
  AlbumSharesRepository,
  type AlbumShareRecord,
  type AlbumShareSessionRecord,
} from '../db/album-shares';
import { EventsRepository } from '../db/events';
import type { AppEnv } from '../env';
import { canonicalOrigin } from '../origins';
import {
  constantTimeEqual,
  createSecretToken,
  decryptSecret,
  digestSecret,
  encryptSecret,
  type SecretToken,
} from '../security/crypto';

const TOKEN = /^([A-Za-z0-9_-]{1,128})\.([A-Za-z0-9_-]{1,128})$/u;

export function albumShareUnavailable(): ApiError {
  return new ApiError('ALBUM_SHARE_UNAVAILABLE', 'This album is not available.', 410);
}

export class AlbumShareSessionCapacityError extends ApiError {
  constructor(public readonly retryAfterSeconds: number) {
    super('RATE_LIMITED', 'Too many active album sessions. Try again later.', 429);
    this.name = 'AlbumShareSessionCapacityError';
  }
}

function tokenParts(token: string): { id: string; secret: string } | null {
  const match = TOKEN.exec(token);
  return match ? { id: match[1]!, secret: match[2]! } : null;
}

export interface AlbumShareExchange {
  album: PublicAlbumView;
  session: SecretToken;
  maxAgeSeconds: number;
}

export class AlbumShareService {
  private readonly shares: AlbumSharesRepository;
  private readonly albums: AlbumRepository;
  private readonly publicAlbums: PublicAlbumService;
  private readonly events: EventsRepository;

  constructor(
    private readonly env: AppEnv,
    private readonly origin: string = canonicalOrigin(env),
  ) {
    this.shares = new AlbumSharesRepository(env.DB);
    this.albums = new AlbumRepository(env.DB);
    this.publicAlbums = new PublicAlbumService(env.DB);
    this.events = new EventsRepository(env.DB);
  }

  private async shareView(share: AlbumShareRecord): Promise<AlbumShareView> {
    const secret = await decryptSecret(
      share.secretCiphertext,
      this.env.ALBUM_SHARE_ENCRYPTION_KEY,
    );
    const digest = await digestSecret(secret, this.env.ALBUM_SHARE_HMAC_KEY);
    if (!constantTimeEqual(digest, share.secretDigest)) throw albumShareUnavailable();
    return {
      active: true,
      url: `${this.origin}/album#${share.id}.${secret}`,
      sharedAt: share.sharedAt,
    };
  }

  async status(eventId: string): Promise<AlbumShareStatus> {
    const share = await this.shares.getForEvent(eventId);
    return share ? this.shareView(share) : null;
  }

  async enable(eventId: string, now = new Date()): Promise<AlbumShareView> {
    const existing = await this.shares.getForEvent(eventId);
    // This read linearizes before a later concurrent stop. Returning its observed
    // credential is safe: stop deletes the share and cascades every session, so it
    // cannot resurrect access even when the response arrives after revocation.
    if (existing) return this.shareView(existing);

    const album = await this.albums.get(eventId);
    if (!album.saved || album.photoCount === 0) {
      throw new ApiError(
        'VALIDATION_FAILED',
        'Save an album with at least one photo before sharing it.',
        409,
      );
    }

    const token = createSecretToken();
    const timestamp = now.toISOString();
    await this.shares.create({
      id: token.id,
      eventId,
      secretDigest: await digestSecret(token.secret, this.env.ALBUM_SHARE_HMAC_KEY),
      secretCiphertext: await encryptSecret(
        token.secret,
        this.env.ALBUM_SHARE_ENCRYPTION_KEY,
      ),
      sharedAt: timestamp,
      createdAt: timestamp,
    });
    const created = await this.shares.getForEvent(eventId);
    if (!created) throw new Error('Album share creation did not persist.');
    return this.shareView(created);
  }

  async stop(eventId: string): Promise<null> {
    await this.shares.deleteForEvent(eventId);
    return null;
  }

  private async activeEvent(eventId: string, now: Date) {
    const event = await this.events.getById(eventId);
    if (!event || event.deletedAt || Date.parse(event.purgeAfter) <= now.getTime()) {
      throw albumShareUnavailable();
    }
    return event;
  }

  private async credential(token: string, now: Date) {
    const parsed = tokenParts(token);
    if (!parsed) throw albumShareUnavailable();
    const share = await this.shares.getById(parsed.id);
    if (!share) throw albumShareUnavailable();
    const digest = await digestSecret(parsed.secret, this.env.ALBUM_SHARE_HMAC_KEY);
    if (!constantTimeEqual(digest, share.secretDigest)) throw albumShareUnavailable();
    const event = await this.activeEvent(share.eventId, now);
    return { share, event };
  }

  async exchange(token: string, now = new Date()): Promise<AlbumShareExchange> {
    const { share, event } = await this.credential(token, now);
    const album = await this.publicAlbums.project(share.eventId, now.toISOString());
    const session = createSecretToken();
    const expiresAtMs = Math.min(
      now.getTime() + (ALBUM_SHARE_SESSION_SECONDS * 1_000),
      Date.parse(event.purgeAfter),
    );
    const record: AlbumShareSessionRecord = {
      id: session.id,
      shareId: share.id,
      eventId: share.eventId,
      secretDigest: await digestSecret(session.secret, this.env.SESSION_HMAC_KEY),
      expiresAt: new Date(expiresAtMs).toISOString(),
      createdAt: now.toISOString(),
    };
    const admission = await this.shares.admitSession(
      record,
      now.toISOString(),
      ALBUM_SHARE_MAX_ACTIVE_SESSIONS,
    );
    if (!admission.created) {
      if (!admission.shareExists) throw albumShareUnavailable();
      const retryAtMs = Date.parse(admission.retryAt ?? '');
      if (!Number.isFinite(retryAtMs)) {
        throw new Error('A full album share has no active session expiry.');
      }
      throw new AlbumShareSessionCapacityError(Math.max(
        1,
        Math.ceil((retryAtMs - now.getTime()) / 1_000),
      ));
    }
    return {
      album,
      session,
      maxAgeSeconds: Math.max(1, Math.floor((expiresAtMs - now.getTime()) / 1_000)),
    };
  }

  async authorizeSession(token: string, now = new Date()): Promise<{ eventId: string }> {
    const parsed = tokenParts(token);
    if (!parsed) throw albumShareUnavailable();
    const session = await this.shares.getSession(parsed.id);
    if (!session || Date.parse(session.expiresAt) <= now.getTime()) {
      throw albumShareUnavailable();
    }
    const digest = await digestSecret(parsed.secret, this.env.SESSION_HMAC_KEY);
    if (!constantTimeEqual(digest, session.secretDigest)) throw albumShareUnavailable();
    const share = await this.shares.getById(session.shareId);
    if (!share || share.eventId !== session.eventId) throw albumShareUnavailable();
    await this.activeEvent(session.eventId, now);
    return { eventId: session.eventId };
  }

  async publicAlbum(token: string, now = new Date()): Promise<PublicAlbumView> {
    const session = await this.authorizeSession(token, now);
    return this.publicAlbums.project(session.eventId, now.toISOString());
  }
}

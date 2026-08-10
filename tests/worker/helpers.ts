import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';

import { createApp } from '../../worker/app';
import { AuthService } from '../../worker/auth/service';
import { AccountsRepository } from '../../worker/db/accounts';
import type { AppEnv } from '../../worker/env';
import { EVENT_COVER_PROFILES } from '../../shared/event-cover';

export const testEnv = env as AppEnv & { TEST_MIGRATION_QUERIES: string };
export const origin = env.APP_ORIGIN;

/**
 * Execute prepared statements without ever exceeding D1's 100-statement batch
 * ceiling. Rehearsals use this for large deterministic fixtures; callers still
 * receive every result in statement order.
 */
export async function batchD1Statements(
  db: D1Database,
  statements: readonly D1PreparedStatement[],
  batchSize = 100,
): Promise<D1Result[]> {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new RangeError('D1 rehearsal batches must contain between 1 and 100 statements.');
  }
  const results: D1Result[] = [];
  for (let offset = 0; offset < statements.length; offset += batchSize) {
    results.push(...await db.batch(statements.slice(offset, offset + batchSize)));
  }
  return results;
}

export interface RecordedR2Put {
  key: string;
}

/**
 * Observe R2 writes while delegating every operation to the real test bucket.
 * The body is never inspected or consumed, so the storage path under rehearsal
 * is byte-for-byte the same one production code invokes.
 */
export function withRecordingR2Puts(base: AppEnv = testEnv): {
  env: AppEnv;
  puts: RecordedR2Put[];
} {
  const puts: RecordedR2Put[] = [];
  const bucket = new Proxy(base.MEDIA_BUCKET, {
    get(target, property) {
      if (property === 'put') {
        return (...args: Parameters<R2Bucket['put']>) => {
          puts.push({ key: args[0] });
          return Reflect.apply(target.put, target, args) as ReturnType<R2Bucket['put']>;
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { env: { ...base, MEDIA_BUCKET: bucket }, puts };
}

export interface Migration { name: string; queries: string[] }

const migrationEnv = env as AppEnv & { TEST_MIGRATIONS: string };

/** Every migration under `migrations/`, in applied order. */
export const orderedMigrations = JSON.parse(migrationEnv.TEST_MIGRATIONS) as Migration[];

/**
 * Every migration *before* the named one — exclusive, so
 * `migrationsUpTo('0012')` builds the schema a populated pre-0012 database has
 * and leaves `0012` itself as the unit under test. `migration-0010.test.ts`
 * reads it the same way; do not make it inclusive.
 */
export function migrationsUpTo(name: string): Migration[] {
  const index = orderedMigrations.findIndex((migration) => migration.name.startsWith(name));
  if (index === -1) throw new Error(`No migration named ${name}.`);
  return orderedMigrations.slice(0, index);
}

export function migrationOnly(name: string): Migration {
  const found = orderedMigrations.find((migration) => migration.name.startsWith(name));
  if (!found) throw new Error(`No migration named ${name}.`);
  return found;
}

type EventAccessFixture = Awaited<ReturnType<typeof eventAccess>>;

/**
 * A durable host account, optionally owning the given events.
 *
 * Paired with `hostWriteHeaders` on purpose: the two halves are one credential,
 * and a caller that lifts only this one hand-rolls the header map — which is
 * exactly how a scope ends up tested against the wrong CSRF header and passes.
 * The return type stays inferred, because `AccountsRepository.create` already
 * derives the account shape and a hand-written interface would drift from it.
 */
export async function hostAccess(events: readonly EventAccessFixture[] = []) {
  const email = `host-${crypto.randomUUID()}@example.com`;
  const account = await new AccountsRepository(testEnv.DB).create({
    email,
    passwordHash: 'test-password-hash',
    displayName: null,
    createdAt: new Date().toISOString(),
  });
  if (!account) throw new Error('Expected a new host account.');
  for (const access of events) {
    await testEnv.DB.prepare(`
      INSERT INTO event_hosts (event_id, account_id, role, created_at)
      VALUES (?, ?, 'owner', ?)
    `).bind(access.event.id, account.id, new Date().toISOString()).run();
  }
  const session = await new AuthService(testEnv).createHostSession(account.id, account.authVersion);
  return {
    account,
    cookie: `candidary_host=${session.sessionToken.token}; candidary_host_csrf=${session.csrfToken}`,
    csrf: session.csrfToken,
  };
}

/** The host-account scope's write headers: `x-candidary-host-csrf`, not the guest pair. */
export function hostWriteHeaders(host: { cookie: string; csrf: string }, extraCookie = '') {
  return {
    'content-type': 'application/json',
    cookie: [host.cookie, extraCookie].filter(Boolean).join('; '),
    origin,
    'x-candidary-host-csrf': host.csrf,
  };
}

export interface RecordedImagesCall {
  input: { byteLength: number };
  transforms: unknown[];
  output: unknown;
}

export interface RecordingImagesOptions {
  /** Source dimensions `IMAGES.info()` reports, before any transform. */
  source?: { width: number; height: number };
  encode?(call: RecordedImagesCall): {
    bytes: Uint8Array;
    width: number;
    height: number;
    contentType: string;
  };
}

/**
 * The one Images fake.
 *
 * The pre-existing inline fake discarded every `transform()` argument and
 * returned a fixed 400x300 PNG, which cannot support an assertion about the
 * exact parameters a recipe requests or about a rung missing its byte ceiling.
 * This records every call and lets a test choose the encoded size, so ladder
 * exhaustion is provoked deliberately rather than hoped for.
 */
export function withRecordingImages(
  options: RecordingImagesOptions = {},
): { env: AppEnv; calls: RecordedImagesCall[] } {
  const calls: RecordedImagesCall[] = [];
  const source = options.source ?? { width: 2400, height: 1600 };
  const encode = options.encode ?? ((call: RecordedImagesCall) => {
    // Deterministic and dimension-proportional, so a smaller rung really does
    // produce fewer bytes and a quality step really does matter.
    const last = call.transforms.at(-1) as { width?: number; height?: number } | undefined;
    const width = last?.width ?? source.width;
    const height = last?.height ?? source.height;
    const quality = (call.output as { quality?: number }).quality ?? 82;
    const format = (call.output as { format?: string }).format ?? 'image/webp';
    const byteLength = Math.max(16, Math.round((width * height * quality) / 4_000));
    return { bytes: new Uint8Array(byteLength).fill(7), width, height, contentType: format };
  });

  const images = {
    info(stream: ReadableStream) {
      void stream;
      return Promise.resolve({ format: 'image/jpeg', ...source });
    },
    input(stream: ReadableStream) {
      const call: RecordedImagesCall = { input: { byteLength: 0 }, transforms: [], output: {} };
      void stream;
      const transformer = {
        transform(transform: unknown) {
          call.transforms.push(transform);
          return transformer;
        },
        draw() { return transformer; },
        output(output: unknown) {
          call.output = output;
          calls.push(call);
          const encoded = encode(call);
          // `.buffer` rather than the view: workerd's BodyInit does not accept a
          // generically-parameterized Uint8Array.
          const body = () => encoded.bytes.buffer.slice(
            encoded.bytes.byteOffset,
            encoded.bytes.byteOffset + encoded.bytes.byteLength,
          ) as ArrayBuffer;
          return Promise.resolve({
            image: () => new Response(body()).body!,
            contentType: () => encoded.contentType,
            response: () => new Response(body()),
          });
        },
      };
      return transformer;
    },
  };

  return { env: { ...testEnv, IMAGES: images } as unknown as AppEnv, calls };
}

const HEX_64 = 'a'.repeat(64);

export interface SeededCoverGraph {
  masterId: string;
  draftId: string;
  previewId: string;
  renderSetId: string;
  renderObjectId: string;
  operationId: string;
  rateEventId: string;
  retiredObjectId: string;
  runId: string;
  jobId: string;
  workflowInstanceId: string;
}

/**
 * One row in every cover table, all owned by `eventId`.
 *
 * Written by direct SQL rather than through the routes on purpose: the purge and
 * migration tests need every table populated including terminal and
 * release-only states no single request sequence produces, and they must be able
 * to do it against a partially migrated database.
 */
export async function seedEventCoverGraph(
  db: D1Database,
  eventId: string,
  now = '2026-08-04T00:00:00.000Z',
): Promise<SeededCoverGraph> {
  const suffix = crypto.randomUUID();
  const ids: SeededCoverGraph = {
    masterId: `master-${suffix}`,
    draftId: `draft-${suffix}`,
    previewId: `preview-${suffix}`,
    renderSetId: `set-${suffix}`,
    renderObjectId: `object-${suffix}`,
    operationId: `operation-${suffix}`,
    rateEventId: `rate-${suffix}`,
    retiredObjectId: `retired-${suffix}`,
    runId: `run-${suffix}`,
    jobId: `job-${suffix}`,
    workflowInstanceId: `instance-${suffix}`,
  };
  const prefix = `events/${eventId}/cover`;

  const renderObjectStatements = EVENT_COVER_PROFILES.flatMap((profile) => (
    ['webp', 'jpeg'] as const
  ).map((format) => {
    const isReturnedObject = profile.id === 'wide-expanded' && format === 'jpeg';
    const objectId = isReturnedObject
      ? ids.renderObjectId
      : `object-${suffix}-${profile.id}-${format}`;
    return db.prepare(`
      INSERT INTO event_cover_render_objects (
        id, render_set_id, event_id, profile_id, density, format, object_key,
        content_type, byte_size, width, height, quality_rung, sha256, created_at
      ) VALUES (?, ?, ?, ?, '1x', ?, ?, ?, 120000, ?, ?, 1, ?, ?)
    `).bind(
      objectId,
      ids.renderSetId,
      eventId,
      profile.id,
      format,
      `${prefix}/rendered/${ids.renderSetId}/${profile.id}-1x.${format}`,
      format === 'webp' ? 'image/webp' : 'image/jpeg',
      profile.width,
      profile.height,
      HEX_64,
      now,
    );
  }));

  await db.batch([
    db.prepare(`
      INSERT INTO event_cover_masters (
        id, event_id, object_key, mime_type, byte_size, width, height, sha256,
        normalization_version, normalization_rung, auto_focus_x, auto_focus_y,
        composition_model_version, created_at
      ) VALUES (?, ?, ?, 'image/webp', 900000, 2400, 1600, ?, 1, 1, 0.5, 0.5, 1, ?)
    `).bind(ids.masterId, eventId, `${prefix}/masters/${ids.masterId}.webp`, HEX_64, now),
    db.prepare(`
      INSERT INTO event_cover_drafts (
        id, event_id, source, state, draft_intent_id, request_sha256, draft_revision,
        raw_object_key, declared_filename, declared_mime_type, declared_byte_size,
        master_id, created_at, updated_at, expires_at
      ) VALUES (?, ?, 'new_upload', 'published', ?, ?, 3, ?, 'porch.jpg', 'image/jpeg', 400000, ?, ?, ?, ?)
    `).bind(
      ids.draftId, eventId, `intent-${suffix}`, HEX_64,
      `${prefix}/raw/${ids.draftId}`, ids.masterId, now, now, now,
    ),
    db.prepare(`
      INSERT INTO event_cover_draft_previews (
        id, draft_id, event_id, effect_id, recipe_version, state, object_key,
        mime_type, byte_size, width, height, ladder_rung, sha256, retryable,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'natural', 1, 'ready', ?, 'image/webp', 90000, 1280, 853, 1, ?, 0, ?, ?)
    `).bind(
      ids.previewId, ids.draftId, eventId,
      `${prefix}/previews/${ids.draftId}/natural-1.webp`, HEX_64, now, now,
    ),
    db.prepare(`
      INSERT INTO event_cover_render_sets (
        id, event_id, master_id, draft_id, recipe_json, recipe_sha256, state,
        required_slots, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'staging', 12, ?)
    `).bind(
      ids.renderSetId,
      eventId,
      ids.masterId,
      ids.draftId,
      '{"version":1,"source":{"kind":"upload"},"focus":{"mode":"auto"},"effect":"natural"}',
      HEX_64,
      now,
    ),
    ...renderObjectStatements,
    db.prepare(`
      UPDATE event_cover_render_sets
      SET state = 'active', manifest_sha256 = ?, published_revision = 1,
          ready_at = ?, published_at = ?
      WHERE id = ?
    `).bind(HEX_64, now, now, ids.renderSetId),
    db.prepare(`
      INSERT INTO event_cover_publish_receipts (
        event_id, operation_id, draft_id, render_set_id, request_sha256, action,
        expected_revision, status, workflow_instance_id, dependency_versions_json,
        completed_profiles, required_profiles, applied_revision, retryable,
        dispatch_state, dispatch_generation, created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, 'publish', 0, 'applied', ?, '{"tonalEffect":1}', 6, 6, 1, 0, 'confirmed', 1, ?, ?, ?)
    `).bind(
      eventId, ids.operationId, ids.draftId, ids.renderSetId, HEX_64,
      ids.workflowInstanceId, now, now, now,
    ),
    db.prepare(`
      INSERT INTO event_cover_workflow_fences (
        workflow_binding, workflow_instance_id, event_id, dispatch_generation,
        state, created_at, updated_at, expires_at
      ) VALUES ('COVER_RENDER_WORKFLOW', ?, ?, 1, 'open', ?, ?, ?)
    `).bind(ids.workflowInstanceId, eventId, now, now, now),
    db.prepare(`
      INSERT INTO event_cover_rate_events (
        id, event_id, action, replay_key, request_sha256, window_start, created_at, expires_at
      ) VALUES (?, ?, 'publication', ?, ?, 1785196800, ?, ?)
    `).bind(ids.rateEventId, eventId, ids.operationId, HEX_64, now, now),
    db.prepare(`
      INSERT INTO event_cover_retired_legacy_objects (
        id, event_id, object_key, key_fingerprint, reason, retired_at, cleanup_after
      ) VALUES (?, ?, ?, ?, 'replaced', ?, ?)
    `).bind(ids.retiredObjectId, eventId, `${prefix}/legacy-${suffix}.jpg`, HEX_64, now, now),
    db.prepare(`
      INSERT INTO event_cover_purge_progress (event_id, phase, created_at, updated_at)
      VALUES (?, 'fences', ?, ?)
    `).bind(eventId, now, now),
    db.prepare(`
      INSERT INTO event_cover_backfill_runs (id, mode, status, created_at, updated_at)
      VALUES (?, 'execute', 'executing', ?, ?)
    `).bind(ids.runId, now, now),
    db.prepare(`
      INSERT INTO event_cover_backfill_jobs (
        id, run_id, event_id, expected_revision, legacy_key_fingerprint, master_id,
        render_set_id, workflow_instance_id, dispatch_state, dispatch_generation,
        status, dependency_versions_json, retryable, terminal_at, created_at, updated_at
      ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, 'confirmed', 1, 'applied', '{"tonalEffect":1}', 0, ?, ?, ?)
    `).bind(
      ids.jobId, ids.runId, eventId, HEX_64, ids.masterId, ids.renderSetId,
      `backfill-${suffix}`, now, now, now,
    ),
  ]);

  return ids;
}

/** Every cover table that carries an `event_id`, in no particular order. */
export const EVENT_COVER_TABLES = [
  'event_cover_masters',
  'event_cover_drafts',
  'event_cover_draft_previews',
  'event_cover_render_sets',
  'event_cover_render_objects',
  'event_cover_publish_receipts',
  'event_cover_rate_events',
  'event_cover_retired_legacy_objects',
  'event_cover_purge_progress',
  'event_cover_backfill_jobs',
] as const;

export function cookiesFrom(response: Response) {
  const value = response.headers.get('set-cookie') ?? '';
  const session = /candidary_session=([^;,]+)/u.exec(value)?.[1];
  const csrf = /candidary_csrf=([^;,]+)/u.exec(value)?.[1];
  if (!session || !csrf) throw new Error(`Expected session and CSRF cookies, received: ${value}`);
  return { cookie: `candidary_session=${session}; candidary_csrf=${csrf}`, csrf };
}

export function writeHeaders(access: { cookie: string; csrf: string }) {
  return {
    'content-type': 'application/json',
    cookie: access.cookie,
    origin,
    'x-candidary-csrf': access.csrf,
  };
}

export function png(width = 800, height = 600, size = 64) {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

export async function resetDatabase() {
  await reset();
  await applyD1Migrations(env.DB, [{
    name: '0001_core.sql',
    queries: JSON.parse(testEnv.TEST_MIGRATION_QUERIES) as string[],
  }]);
}

// The printed credential lives in the URL fragment, which `new URL().pathname`
// deliberately excludes. Every caller has to send it in the POST body, exactly
// as the join shell does, or it is not testing the real exchange.
export async function exchangeEventEntry(eventLink: string) {
  return createApp().request('/api/entry/exchange', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ token: new URL(eventLink).hash.slice(1) }),
  }, testEnv);
}

/**
 * Sends a complete settings payload. Settings is one atomic write, so a caller
 * has to state every field; this fills in the current values and lets a test
 * name only what it is changing.
 */
export async function applySettings(
  access: { event: any; manager: { cookie: string; csrf: string } },
  patch: Record<string, unknown> = {},
) {
  return createApp().request(`/api/manage/events/${access.event.id}/settings`, {
    method: 'PATCH',
    headers: writeHeaders(access.manager),
    body: JSON.stringify({
      galleryVisible: access.event.galleryVisible,
      moderationRequired: access.event.moderationRequired,
      eventTimezone: access.event.eventTimezone,
      eventStartTime: access.event.eventStartTime,
      rsvpDeadlineDate: access.event.rsvpDeadlineDate,
      rsvpEnabled: access.event.rsvpEnabled,
      rsvpRosterVersion: access.event.rsvpRosterVersion,
      ...patch,
    }),
  }, testEnv);
}

// New events permit photo delivery, but the clock does the opening and this
// fixture's event is still ahead of its own start. The photo-journey fixtures
// all assume intake is running, so this opens it early the way a host would
// rather than by writing to the database behind the route that owns the
// decision.
export async function eventAccess(name = 'Maya & Theo', openPhotosEarly = true) {
  const created = await createApp().request('/api/events', {
    method: 'POST', headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({
      name, eventDate: '2026-09-19', welcomeMessage: 'Welcome.',
      eventTimezone: 'America/Chicago', rsvpDeadlineDate: '2026-09-05',
    }),
  }, testEnv);
  const body = await created.json<any>();
  const managerCookies = cookiesFrom(created);
  const guestExchange = await exchangeEventEntry(body.data.eventLink);
  const access = {
    event: body.data.event,
    eventLink: body.data.eventLink as string,
    managementLink: body.data.managementLink as string,
    manager: { ...managerCookies, csrf: body.data.csrfToken as string },
    guest: cookiesFrom(guestExchange),
  };

  if (!openPhotosEarly) return access;
  const opened = await createApp().request(`/api/manage/events/${access.event.id}/photo-intake`, {
    method: 'POST',
    headers: writeHeaders(access.manager),
    body: JSON.stringify({ action: 'open_early' }),
  }, testEnv);
  if (opened.status !== 200) {
    throw new Error(`Photo delivery fixture did not open: ${await opened.text()}`);
  }
  access.event = (await opened.json<any>()).data.event;
  return access;
}

export async function secondGuest(eventLink: string) {
  return cookiesFrom(await exchangeEventEntry(eventLink));
}

/** Previews and commits a guest list the way a host would. */
export async function importRoster(
  access: { event: any; manager: { cookie: string; csrf: string } },
  csv: string,
) {
  const previewed = await createApp().request(
    `/api/manage/events/${access.event.id}/rsvp/import/preview`,
    { method: 'POST', headers: writeHeaders(access.manager), body: JSON.stringify({ csv }) },
    testEnv,
  );
  const preview = (await previewed.json<any>()).data;
  if (preview.issues.length > 0) {
    throw new Error(`Roster fixture is invalid: ${JSON.stringify(preview.issues)}`);
  }
  const committed = await createApp().request(
    `/api/manage/events/${access.event.id}/rsvp/import/commit`,
    {
      method: 'POST',
      headers: writeHeaders(access.manager),
      body: JSON.stringify({
        csv,
        sourceDigest: preview.sourceDigest,
        expectedRosterVersion: preview.rosterVersion,
      }),
    },
    testEnv,
  );
  if (committed.status !== 201) {
    throw new Error(`Roster fixture did not commit: ${await committed.text()}`);
  }
  return (await committed.json<any>()).data;
}

/** Opens RSVP and refreshes the fixture's event view to match. */
export async function openRsvp(access: Awaited<ReturnType<typeof eventAccess>>) {
  // Importing a roster advances the version, so the fixture's copy is stale by
  // the time this runs and the settings write would be refused as a stale view.
  const current = await createApp().request(`/api/manage/events/${access.event.id}`, {
    headers: { cookie: access.manager.cookie },
  }, testEnv);
  access.event = (await current.json<any>()).data.event;

  const response = await applySettings(access, { rsvpEnabled: true });
  if (response.status !== 200) {
    throw new Error(`RSVP fixture did not open: ${await response.text()}`);
  }
  access.event = (await response.json<any>()).data.event;
  return access.event;
}

export async function uploadPending(
  access: Awaited<ReturnType<typeof eventAccess>>,
  key: string,
  caption: string | null = null,
  guestName = 'Avery',
) {
  const initiated = await createApp().request(`/api/event/${access.event.slug}/uploads`, {
    method: 'POST', headers: writeHeaders(access.guest),
    body: JSON.stringify({
      filename: `${key}.png`, mimeType: 'image/png', byteSize: 128,
      idempotencyKey: key, guestName, caption,
    }),
  }, testEnv);
  const media = (await initiated.json<any>()).data.media;
  await env.MEDIA_BUCKET.put(media.objectKey, png(), { httpMetadata: { contentType: 'image/png' } });
  const finalized = await createApp().request(`/api/event/${access.event.slug}/uploads/${media.id}/finalize`, {
    method: 'POST', headers: writeHeaders(access.guest), body: '{}',
  }, testEnv);
  return (await finalized.json<any>()).data.media;
}

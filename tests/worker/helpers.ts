import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';

import { createApp } from '../../worker/app';
import { AuthService } from '../../worker/auth/service';
import { AccountsRepository } from '../../worker/db/accounts';
import { ExportsRepository } from '../../worker/db/exports';
import type { AppEnv } from '../../worker/env';
import { processExport as processExportAttempt } from '../../worker/workflows/export';
import { EVENT_COVER_PROFILES } from '../../shared/event-cover';

const cloudflareTestEnv = env as AppEnv & { TEST_MIGRATION_QUERIES: string };
const permissiveGuestMessageRateLimit = {
  async limit(): Promise<RateLimitOutcome> { return { success: true }; },
} satisfies RateLimit;

export const testEnv = new Proxy(cloudflareTestEnv, {
  get(target, property) {
    if (property === 'GUEST_MESSAGE_RATE_LIMIT') return permissiveGuestMessageRateLimit;
    return Reflect.get(target, property, target) as unknown;
  },
});
export const origin = env.APP_ORIGIN;

/**
 * Test convenience for direct Workflow execution. Production callers must
 * carry the attempt in their durable payload; tests resolve the row explicitly
 * here so old fixtures stay readable without weakening that production API.
 */
export async function processExport(
  appEnv: AppEnv,
  jobId: string,
  now = new Date(),
  maxPartBytes?: number,
  executionStartedAt?: string,
  clock: () => Date = () => now,
) {
  const job = await new ExportsRepository(appEnv.DB).getById(jobId);
  if (!job) return null;
  return processExportAttempt(
    appEnv,
    { jobId, attempt: job.attempt },
    now,
    maxPartBytes,
    executionStartedAt,
    clock,
  );
}

/**
 * Miniflare does not instantiate Workers Rate Limiting bindings. Keep the
 * production-generated Env type and replace only that external edge decision.
 */
export function withGuestMessageRateLimit(
  decide: (key: string) => boolean = () => true,
): { env: AppEnv; keys: string[] } {
  const keys: string[] = [];
  const fixture = Object.create(testEnv) as AppEnv;
  Object.defineProperty(fixture, 'GUEST_MESSAGE_RATE_LIMIT', {
    value: {
      async limit({ key }: RateLimitOptions): Promise<RateLimitOutcome> {
        keys.push(key);
        return { success: decide(key) };
      },
    } satisfies RateLimit,
  });
  return { env: fixture, keys };
}

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

export async function resetDatabaseWithExportProtocolLegacyOpen() {
  await reset();
  await applyD1Migrations(env.DB, [{
    name: '0001_core.sql',
    queries: JSON.parse(testEnv.TEST_MIGRATION_QUERIES) as string[],
  }]);
}

export async function resetDatabaseWithExportProtocolClosed() {
  await resetDatabaseWithExportProtocolLegacyOpen();
  const closed = await env.DB.prepare(`
    UPDATE export_protocol_admission
    SET state = 'closed', closed_at = ?
    WHERE singleton = 1 AND state = 'legacy-open'
  `).bind('2026-08-25T00:00:00.000Z').run();
  if ((closed.meta.changes ?? 0) !== 1) {
    throw new Error('Current-schema test setup could not close export protocol admission.');
  }
}

export async function resetDatabase() {
  await resetDatabaseWithExportProtocolClosed();
  const admitted = await env.DB.prepare(`
    UPDATE export_protocol_admission
    SET state = 'open', worker_version_id = ?, admitted_at = ?
    WHERE singleton = 1 AND state = 'closed'
  `).bind(
    '123e4567-e89b-42d3-a456-426614174000',
    '2026-08-25T00:00:01.000Z',
  ).run();
  if ((admitted.meta.changes ?? 0) !== 1) {
    throw new Error('Current-schema test setup could not admit the export protocol.');
  }
}

const PHASE_3_COVER_TRIGGER_NAMES = [
  'event_cover_master_live_reference_delete',
  'event_cover_render_object_manifest_delete',
  'event_cover_render_object_manifest_insert',
  'event_cover_render_object_manifest_update',
  'event_cover_render_set_live_reference_delete',
  'event_cover_render_set_manifest_insert',
  'event_cover_render_set_manifest_update',
  'event_cover_source_pointer_insert',
  'event_cover_source_pointer_update',
] as const;

/**
 * Restore the route-disabled Phase 2 cover schema used by backfill rehearsals.
 *
 * The Worker test pool installs every migration as one bundle, including the
 * Phase 3 cutover triggers from 0014. Backfill tests intentionally exercise
 * legacy rows before that cutover, so they remove only the nine 0014 triggers
 * after the ordinary isolated reset. Migration and invariant tests continue to
 * use `resetDatabase()` and therefore always see the complete current schema.
 */
export async function resetDatabaseToPhase2CoverSchema() {
  await resetDatabase();
  await testEnv.DB.exec(PHASE_3_COVER_TRIGGER_NAMES
    .map((name) => `DROP TRIGGER IF EXISTS ${name};`)
    .join('\n'));
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
      guestbookPrompt: access.event.guestbookPrompt,
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
      filename: `${key}.png`, mimeType: 'image/png', byteSize: png().byteLength,
      idempotencyKey: key, guestName, caption,
    }),
  }, testEnv);
  const media = (await initiated.json<any>()).data.media;
  const bytes = png();
  const finalized = await createApp().request(`/api/event/${access.event.slug}/uploads/${media.id}/content`, {
    method: 'PUT',
    headers: {
      ...writeHeaders(access.guest),
      'content-type': 'image/png',
      'content-length': String(bytes.byteLength),
    },
    body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  }, testEnv);
  if (finalized.status !== 200) {
    throw new Error(`Upload fixture failed: ${finalized.status} ${await finalized.text()}`);
  }
  // The wire response is a deliberate allowlist — id, MIME, state — so fixtures
  // read the durable row for everything else they need. Tests that assert on the
  // response shape do so against the response, not against this record.
  const row = await testEnv.DB.prepare('SELECT * FROM media WHERE id = ?')
    .bind(media.id).first<Record<string, unknown>>();
  if (!row) throw new Error('Upload fixture did not persist a media row.');
  return {
    id: row.id as string,
    eventId: row.event_id as string,
    uploaderSessionId: row.uploader_session_id as string,
    objectKey: row.object_key as string,
    objectBucketGeneration: row.object_bucket_generation as 'legacy' | 'canonical',
    originalFilename: row.original_filename as string,
    mimeType: row.mime_type as string,
    declaredByteSize: row.declared_byte_size as number,
    byteSize: row.byte_size as number | null,
    width: row.width as number | null,
    height: row.height as number | null,
    guestName: row.guest_name as string,
    caption: row.caption as string | null,
    uploadState: row.upload_state as string,
    publicationStatus: row.publication_status as string,
    idempotencyKey: row.idempotency_key as string,
    reservationExpiresAt: row.reservation_expires_at as string,
    createdAt: row.created_at as string,
    storedAt: row.stored_at as string | null,
    capturedAt: row.captured_at as string | null,
    timelineAt: row.timeline_at as string,
    favoritedAt: row.favorited_at as string | null,
    publishedAt: row.published_at as string | null,
    previewObjectKey: row.preview_object_key as string | null,
    deletedAt: row.deleted_at as string | null,
    trashedAt: row.trashed_at as string | null,
    restoreUntil: row.restore_until as string | null,
  };
}

/**
 * Seed one entry-backed export job directly, for tests that need a specific job
 * state rather than a specific collection.
 *
 * Entry-backed on purpose: migration 0019 forbids a queued complete job with no
 * frozen `export_media_entries`, and the frozen count and byte sum must match
 * the job before the queued -> running fence will let it start. Passing the real
 * media rows keeps both true, so a seeded job behaves exactly like one intake
 * produced.
 */
export async function seedExportJob(input: {
  id: string;
  eventId: string;
  snapshotAt: string;
  createdAt?: string;
  state?: 'queued' | 'running' | 'ready' | 'failed' | 'expired';
  kind?: 'complete' | 'album';
  media?: ReadonlyArray<Awaited<ReturnType<typeof uploadPending>>>;
  attempt?: number;
  executionProtocol?: 'legacy' | 'attempt-v2';
}): Promise<void> {
  const media = input.media ?? [];
  const totalBytes = media.reduce((sum, row) => sum + (row.byteSize ?? row.declaredByteSize), 0);
  const kind = input.kind ?? 'complete';
  const createdAt = input.createdAt ?? input.snapshotAt;
  const state = input.state ?? 'queued';
  const executionProtocol = input.executionProtocol
    ?? (state === 'queued' || state === 'running' ? 'attempt-v2' : 'legacy');
  await testEnv.DB.prepare(`
    INSERT INTO export_jobs (
      id, event_id, kind, album_entries_json, state, snapshot_at, media_count,
      total_bytes, attempt, created_at, guestbook_entry_count, guestbook_shared_count,
      execution_protocol
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
  `).bind(
    input.id,
    input.eventId,
    kind,
    kind === 'album' ? '[]' : null,
    state,
    input.snapshotAt,
    media.length,
    totalBytes,
    input.attempt ?? 1,
    createdAt,
    kind === 'album' ? null : 0,
    kind === 'album' ? null : 0,
    executionProtocol,
  ).run();
  for (const [index, row] of media.entries()) {
    await testEnv.DB.prepare(`
      INSERT INTO export_media_entries (
        export_job_id, media_id, object_key, object_bucket_generation,
        original_filename, mime_type, declared_byte_size, byte_size, width, height,
        guest_name, caption, publication_status, created_at, published_at,
        album_tail_position
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
    `).bind(
      input.id,
      row.id,
      row.objectKey,
      row.objectBucketGeneration,
      row.originalFilename,
      row.mimeType,
      row.declaredByteSize,
      row.byteSize,
      row.width,
      row.height,
      row.guestName,
      row.caption,
      row.publicationStatus,
      row.createdAt,
      row.publishedAt,
      kind === 'album' ? index + 1 : null,
    ).run();
  }
}

/** Move one delivered photo to Recently deleted through the Manager route. */
export async function trashMedia(
  access: Awaited<ReturnType<typeof eventAccess>>,
  mediaId: string,
) {
  const response = await createApp().request(
    `/api/manage/events/${access.event.id}/media/${mediaId}/trash`,
    { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
    testEnv,
  );
  if (response.status !== 200) {
    throw new Error(`Trash fixture failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json<any>()).data.media as {
    id: string;
    originalFilename: string;
    guestName: string;
    caption: string | null;
    trashedAt: string;
    restoreUntil: string;
  };
}

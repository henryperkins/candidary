import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as EventTheme from '../../shared/event-theme';
import { createApp } from '../../worker/app';
import { EventsRepository } from '../../worker/db/events';
import { coverMasterKey, coverRenderKey } from '../../worker/storage/event-cover-keys';
import {
  cookiesFrom,
  eventAccess,
  exchangeEventEntry,
  hostAccess,
  hostWriteHeaders,
  origin,
  png,
  resetDatabase,
  seedEventCoverGraph,
  testEnv,
  uploadPending,
  writeHeaders,
} from './helpers';

const EVENT_VIEW_KEYS = [
  'id',
  'slug',
  'name',
  'eventDate',
  'welcomeMessage',
  'cover',
  'uploadsEnabled',
  'galleryVisible',
  'moderationRequired',
  'reservedMediaCount',
  'storedMediaCount',
  'reservedBytes',
  'storedBytes',
  'guestAccessExpiresAt',
  'managementAccessExpiresAt',
  'purgeAfter',
  'createdAt',
  'deletedAt',
  'eventTimezone',
  'eventStartAt',
  'eventStartTime',
  'photosOpen',
  'photoIntakeState',
  'photoIntakeRecheckAfterMs',
  'rsvpEnabled',
  'rsvpDeadlineAt',
  'rsvpDeadlineDate',
  'rsvpRosterVersion',
  'theme',
] as const;

const GUEST_EVENT_VIEW_KEYS = [
  'id',
  'slug',
  'name',
  'eventDate',
  'welcomeMessage',
  'cover',
  'uploadsEnabled',
  'galleryVisible',
  'moderationRequired',
  'eventTimezone',
  'eventStartAt',
  'rsvpDeadlineAt',
  'rsvpDeadlineDate',
  'phase',
  'rsvpState',
  'rsvpAccess',
  'lifecycleRecheckAfterMs',
  'theme',
] as const;

const THEME_TOKEN_KEYS = [
  'page',
  'surface',
  'raisedSurface',
  'text',
  'pageText',
  'cardText',
  'mutedText',
  'secondaryMutedText',
  'quietText',
  'requiredText',
  'selectionSummaryText',
  'primary',
  'primaryForeground',
  'primaryHover',
  'primaryOnSurface',
  'primaryShadow',
  'accent',
  'accentForeground',
  'accentSoft',
  'accentSoftForeground',
  'border',
  'sectionBorder',
  'rememberedNameBorder',
  'reviewDivider',
  'inputBorder',
  'focus',
  'mediaPlaceholderStart',
  'mediaPlaceholderEnd',
  'mediaPlaceholderForeground',
  'heroStart',
  'heroMid',
  'heroEnd',
  'heroOverlayTop',
  'heroOverlayBottom',
  'coverOverlayTop',
  'coverOverlayBottom',
  'coverTextScrim',
  'fullscreenBackdrop',
  'fullscreenForeground',
  'inputShadow',
  'frameShadow',
  'inputRadius',
  'actionRadius',
  'cardRadius',
  'frameRadius',
] as const;

const DEFAULT_CONFIG = {
  version: 1,
  presetId: 'candidary-default',
  overrides: {},
} as const;

function createEvent(extra: Record<string, unknown> = {}) {
  return createApp().request('/api/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({
      name: 'Maya & Theo',
      eventDate: '2026-09-19',
      welcomeMessage: 'Welcome.',
      eventTimezone: 'America/Chicago', rsvpDeadlineDate: '2026-09-05',
      ...extra,
    }),
  }, testEnv);
}

async function createdEvent(extra: Record<string, unknown> = {}) {
  const response = await createEvent(extra);
  expect(response.status).toBe(201);
  const body = await response.json<any>();
  return { response, body, manager: cookiesFrom(response) };
}

type EventAccess = Awaited<ReturnType<typeof eventAccess>>;

function putTheme(
  eventId: string,
  theme: unknown,
  headers: Record<string, string>,
) {
  return createApp().request(`/api/manage/events/${eventId}/theme`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(theme),
  }, testEnv);
}

beforeEach(resetDatabase);

describe('event theme create and read serialization', () => {
  it('creates an omitted theme as the canonical default with every resolved token', async () => {
    const { body } = await createdEvent();

    expect(Object.keys(body.data.event).sort()).toEqual([...EVENT_VIEW_KEYS].sort());
    expect(body.data.event).not.toHaveProperty('themeConfig');
    expect(body.data.event).not.toHaveProperty('theme_config');
    expect(body.data.event.theme.config).toEqual(DEFAULT_CONFIG);
    expect(Object.keys(body.data.event.theme.tokens).sort()).toEqual([...THEME_TOKEN_KEYS].sort());
    expect(body.data.event.theme.tokens).toMatchObject({
      page: '#f7f1e7',
      primary: '#4a2415',
      accent: '#3f6d95',
      frameRadius: '25px',
    });
  });

  it('normalizes, persists, and identically reads a valid Coastal Light theme', async () => {
    const theme = {
      version: 1,
      presetId: 'coastal-light',
      overrides: {
        primaryColor: '#0C6370',
        accentColor: '#112233',
      },
    };
    const { body, manager } = await createdEvent({ theme });
    const expectedConfig = {
      version: 1,
      presetId: 'coastal-light',
      overrides: { accentColor: '#112233' },
    };

    expect(body.data.event.theme.config).toEqual(expectedConfig);
    expect(await testEnv.DB.prepare('SELECT theme_config FROM events WHERE id = ?')
      .bind(body.data.event.id)
      .first('theme_config'))
      .toBe('{"version":1,"presetId":"coastal-light","overrides":{"accentColor":"#112233"}}');

    const managerRead = await createApp().request(`/api/manage/events/${body.data.event.id}`, {
      headers: { cookie: manager.cookie },
    }, testEnv);
    expect(managerRead.status).toBe(200);
    const managerBody = await managerRead.json<any>();
    expect(Object.keys(managerBody.data.event).sort()).toEqual([...EVENT_VIEW_KEYS].sort());
    expect(managerBody.data.event.theme).toEqual(body.data.event.theme);

    const guestExchange = await exchangeEventEntry(body.data.eventLink);
    const guest = cookiesFrom(guestExchange);
    const guestRead = await createApp().request(`/api/event/${body.data.event.slug}`, {
      headers: { cookie: guest.cookie },
    }, testEnv);
    expect(guestRead.status).toBe(200);
    const guestBody = await guestRead.json<any>();
    expect(Object.keys(guestBody.data.event).sort()).toEqual([...GUEST_EVENT_VIEW_KEYS].sort());
    expect(guestBody.data.event).not.toHaveProperty('themeConfig');
    expect(guestBody.data.event).not.toHaveProperty('theme_config');
    expect(guestBody.data.event.theme).toEqual(body.data.event.theme);
  });

  it('keeps the existing strip behavior for unrelated create-root keys', async () => {
    const { body } = await createdEvent({ unrelated: 'discard me' });

    expect(body.data.event).not.toHaveProperty('unrelated');
    expect(body.data.event.theme.config).toEqual(DEFAULT_CONFIG);
  });

  it.each([
    [
      'theme.evil',
      {
        theme: {
          version: 1,
          presetId: 'candidary-default',
          overrides: {},
          evil: true,
        },
      },
      ['theme.evil'],
    ],
    [
      'theme.overrides.evil',
      {
        theme: {
          version: 1,
          presetId: 'candidary-default',
          overrides: { evil: '#000000', another: '#ffffff' },
        },
      },
      ['theme.overrides.evil', 'theme.overrides.another'],
    ],
  ])('reports every exact unrecognized key for %s', async (_label, extra, fields) => {
    const response = await createEvent(extra);
    const body = await response.json<any>();

    expect(response.status).toBe(422);
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(Object.keys(body.fieldErrors).sort()).toEqual([...fields].sort());
  });

  it.each([
    ['CSS declarations', 'red; background: #000000', 'theme.overrides.primaryColor'],
    ['url()', 'url(https://evil.example/x)', 'theme.overrides.primaryColor'],
    ['var()', 'var(--primary)', 'theme.overrides.primaryColor'],
    ['HTML', '<style>body{display:none}</style>', 'theme.overrides.primaryColor'],
    ['external resource', 'https://evil.example/theme.css', 'theme.overrides.primaryColor'],
    ['shorthand hex', '#abc', 'theme.overrides.primaryColor'],
    ['alpha hex', '#11223344', 'theme.overrides.primaryColor'],
    ['unknown preset', 'not-a-preset', 'theme.presetId'],
    ['unknown version', 2, 'theme.version'],
  ])('rejects %s with an exact dotted field path', async (_label, value, field) => {
    const theme = field === 'theme.presetId'
      ? { version: 1, presetId: value, overrides: {} }
      : field === 'theme.version'
        ? { version: value, presetId: 'candidary-default', overrides: {} }
        : {
            version: 1,
            presetId: 'candidary-default',
            overrides: { primaryColor: value },
          };
    const response = await createEvent({ theme });
    const body = await response.json<any>();

    expect(response.status).toBe(422);
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.fieldErrors).toHaveProperty(field);
  });

  it('prefixes semantic theme resolution failures with the create field path', async () => {
    const response = await createEvent({
      theme: {
        version: 1,
        presetId: 'candidary-default',
        overrides: { primaryColor: '#777777' },
      },
    });
    const body = await response.json<any>();

    expect(response.status).toBe(422);
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.fieldErrors).toEqual({
      'theme.overrides.primaryColor': 'Primary color needs a 4.5:1 foreground contrast ratio.',
    });
  });

  it('refuses an accent that disappears into the event surfaces', async () => {
    const response = await createEvent({
      theme: {
        version: 1,
        presetId: 'candidary-default',
        overrides: { accentColor: '#f5efe6' },
      },
    });
    const body = await response.json<any>();

    expect(response.status).toBe(422);
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.fieldErrors).toEqual({
      'theme.overrides.accentColor': 'Accent color needs a 3:1 contrast ratio against the event surfaces.',
    });
  });

  it('refuses a primary that dissolves into the event surfaces', async () => {
    const response = await createEvent({
      theme: {
        version: 1,
        presetId: 'candidary-default',
        overrides: { primaryColor: '#ffffff' },
      },
    });
    const body = await response.json<any>();

    expect(response.status).toBe(422);
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.fieldErrors).toEqual({
      'theme.overrides.primaryColor': 'Primary color needs a 3:1 contrast ratio against the event surfaces.',
    });
  });
});

describe('authorized event theme updates', () => {
  const garden = {
    version: 1,
    presetId: 'garden-party',
    overrides: { primaryColor: '#123456' },
  } as const;

  /* The floors sit on the write, not on the read: a color already saved keeps resolving for guests
     and is only refused when the host next edits it. */
  it('refuses an accent that disappears into the event surfaces', async () => {
    const access = await eventAccess('Illegible accent');
    const response = await putTheme(access.event.id, {
      version: 1,
      presetId: 'candidary-default',
      overrides: { accentColor: '#f5efe6' },
    }, writeHeaders(access.manager));
    const body = await response.json<any>();

    expect(response.status).toBe(422);
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.fieldErrors).toEqual({
      'overrides.accentColor': 'Accent color needs a 3:1 contrast ratio against the event surfaces.',
    });
  });

  /* `primaryForeground` keeps the label on the button legible, which is why this one reaches the
     floor rather than the resolver: the send button would carry readable ink and still be invisible
     against the surface holding it. */
  it('refuses a primary that dissolves into the event surfaces', async () => {
    const access = await eventAccess('Dissolving primary');
    const response = await putTheme(access.event.id, {
      version: 1,
      presetId: 'candidary-default',
      overrides: { primaryColor: '#ffffff' },
    }, writeHeaders(access.manager));
    const body = await response.json<any>();

    expect(response.status).toBe(422);
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.fieldErrors).toEqual({
      'overrides.primaryColor': 'Primary color needs a 3:1 contrast ratio against the event surfaces.',
    });
    const read = await createApp().request(`/api/manage/events/${access.event.id}`, {
      headers: { cookie: access.manager.cookie },
    }, testEnv);
    expect((await read.json<any>()).data.event.theme.config).toEqual(DEFAULT_CONFIG);
  });

  /* The read path is untouched by the floors, so an event carrying a below-floor primary from before
     one existed still reaches its guests with the color its host chose. */
  it('keeps serving a stored below-floor primary to guests', async () => {
    const access = await eventAccess('Stored below floor');
    await testEnv.DB.prepare('UPDATE events SET theme_config = ? WHERE id = ?')
      .bind('{"version":1,"presetId":"garden-party","overrides":{"primaryColor":"#ffffff"}}', access.event.id)
      .run();

    const read = await createApp().request(`/api/event/${access.event.slug}`, {
      headers: { cookie: access.guest.cookie },
    }, testEnv);
    const view = (await read.json<any>()).data.event;

    expect(read.status).toBe(200);
    expect(view.theme.config.presetId).toBe('garden-party');
    expect(view.theme.tokens.primary).toBe('#ffffff');
  });

  it('updates through either a matching manager link or the owning account', async () => {
    const linked = await eventAccess('Linked event');
    const linkResponse = await putTheme(linked.event.id, garden, writeHeaders(linked.manager));
    expect(linkResponse.status).toBe(200);
    expect((await linkResponse.json<any>()).data.event.theme.config).toEqual(garden);

    const owned = await eventAccess('Owned event');
    const host = await hostAccess([owned]);
    const accountResponse = await putTheme(owned.event.id, {
      version: 1,
      presetId: 'coastal-light',
      overrides: {},
    }, hostWriteHeaders(host));
    expect(accountResponse.status).toBe(200);
    expect((await accountResponse.json<any>()).data.event.theme.config.presetId).toBe('coastal-light');
  });

  it('prefers an owning account when both credentials exist and therefore requires host CSRF', async () => {
    const access = await eventAccess();
    const host = await hostAccess([access]);
    const bothCookies = `${host.cookie}; ${access.manager.cookie}`;

    const wrongCredentialCsrf = await putTheme(access.event.id, garden, {
      ...writeHeaders(access.manager),
      cookie: bothCookies,
    });
    expect(wrongCredentialCsrf.status).toBe(403);
    expect((await wrongCredentialCsrf.json<any>()).code).toBe('CSRF_INVALID');

    const accepted = await putTheme(access.event.id, garden, hostWriteHeaders(host, access.manager.cookie));
    expect(accepted.status).toBe(200);
  });

  it('falls through from an unrelated account to a matching link and requires event CSRF', async () => {
    const access = await eventAccess();
    const stranger = await hostAccess();
    const bothCookies = `${stranger.cookie}; ${access.manager.cookie}`;

    const wrongCredentialCsrf = await putTheme(access.event.id, garden, {
      ...hostWriteHeaders(stranger, access.manager.cookie),
      cookie: bothCookies,
    });
    expect(wrongCredentialCsrf.status).toBe(403);
    expect((await wrongCredentialCsrf.json<any>()).code).toBe('CSRF_INVALID');

    const accepted = await putTheme(access.event.id, garden, {
      ...writeHeaders(access.manager),
      cookie: bothCookies,
    });
    expect(accepted.status).toBe(200);
  });

  it.each([
    ['missing CSRF', (access: EventAccess) => ({
      'content-type': 'application/json',
      cookie: access.manager.cookie,
      origin,
    }), 'CSRF_INVALID'],
    ['wrong CSRF', (access: EventAccess) => ({
      ...writeHeaders(access.manager),
      'x-candidary-csrf': 'wrong-token',
    }), 'CSRF_INVALID'],
    ['foreign origin', (access: EventAccess) => ({
      ...writeHeaders(access.manager),
      origin: 'https://evil.example',
    }), 'ORIGIN_FORBIDDEN'],
  ])('rejects %s on a theme write', async (_label, headers, code) => {
    const access = await eventAccess();
    const response = await putTheme(access.event.id, garden, headers(access));

    expect(response.status).toBe(403);
    expect((await response.json<any>()).code).toBe(code);
  });

  it('rejects missing, guest, unrelated-account, and cross-event management authorization', async () => {
    const access = await eventAccess();
    const other = await eventAccess('Other event');
    const stranger = await hostAccess();
    const cases = [
      ['missing', {}, 401, 'SESSION_REQUIRED'],
      ['guest', writeHeaders(access.guest), 403, 'ROLE_FORBIDDEN'],
      ['unrelated account', hostWriteHeaders(stranger), 403, 'ROLE_FORBIDDEN'],
      ['cross-event', writeHeaders(other.manager), 403, 'ROLE_FORBIDDEN'],
    ] as const;

    for (const [label, headers, status, code] of cases) {
      const response = await putTheme(access.event.id, garden, headers);
      expect([label, response.status]).toEqual([label, status]);
      expect((await response.json<any>()).code).toBe(code);
    }
  });

  it('resets through the same route with the canonical default payload', async () => {
    const access = await eventAccess();
    await putTheme(access.event.id, garden, writeHeaders(access.manager));

    const reset = await putTheme(access.event.id, DEFAULT_CONFIG, writeHeaders(access.manager));
    expect(reset.status).toBe(200);
    expect((await reset.json<any>()).data.event.theme.config).toEqual(DEFAULT_CONFIG);
    expect(await testEnv.DB.prepare('SELECT theme_config FROM events WHERE id = ?')
      .bind(access.event.id)
      .first('theme_config'))
      .toBe('{"version":1,"presetId":"candidary-default","overrides":{}}');
  });

  it('reports exact direct-body paths for unknown keys and semantic failures', async () => {
    const access = await eventAccess();
    const unknown = await putTheme(access.event.id, {
      ...DEFAULT_CONFIG,
      evil: true,
    }, writeHeaders(access.manager));
    expect(unknown.status).toBe(422);
    expect((await unknown.json<any>()).fieldErrors).toEqual({
      evil: expect.any(String),
    });

    const semantic = await putTheme(access.event.id, {
      ...DEFAULT_CONFIG,
      overrides: { primaryColor: '#777777' },
    }, writeHeaders(access.manager));
    expect(semantic.status).toBe(422);
    expect((await semantic.json<any>()).fieldErrors).toEqual({
      'overrides.primaryColor': 'Primary color needs a 4.5:1 foreground contrast ratio.',
    });
  });

  it.each([
    ['CSS declarations', 'red; background: #000000'],
    ['url()', 'url(https://evil.example/x)'],
    ['var()', 'var(--primary)'],
    ['HTML', '<style>body{display:none}</style>'],
    ['external resource', 'https://evil.example/theme.css'],
    ['shorthand hex', '#abc'],
    ['alpha hex', '#11223344'],
  ])('rejects malicious update value %s', async (_label, primaryColor) => {
    const access = await eventAccess();
    const response = await putTheme(access.event.id, {
      ...DEFAULT_CONFIG,
      overrides: { primaryColor },
    }, writeHeaders(access.manager));

    expect(response.status).toBe(422);
    expect((await response.json<any>()).fieldErrors).toHaveProperty('overrides.primaryColor');
  });

  it('updates only the authorized event', async () => {
    const first = await eventAccess('First');
    const second = await eventAccess('Second');

    const response = await putTheme(first.event.id, garden, writeHeaders(first.manager));
    expect(response.status).toBe(200);
    expect(await testEnv.DB.prepare('SELECT theme_config FROM events WHERE id = ?')
      .bind(first.event.id).first('theme_config'))
      .toBe('{"version":1,"presetId":"garden-party","overrides":{"primaryColor":"#123456"}}');
    expect(await testEnv.DB.prepare('SELECT theme_config FROM events WHERE id = ?')
      .bind(second.event.id).first('theme_config'))
      .toBe('{"version":1,"presetId":"candidary-default","overrides":{}}');
  });

  it('keeps the repository zero-change guard', async () => {
    await expect(new EventsRepository(testEnv.DB).updateTheme(
      'missing-event',
      '{"version":1,"presetId":"candidary-default","overrides":{}}',
    )).rejects.toThrow('Event theme was not updated.');
  });

  it('leaves the prior theme unchanged when D1 refuses the update', async () => {
    const access = await eventAccess();
    await testEnv.DB.prepare(`
      CREATE TRIGGER refuse_event_theme_update
      BEFORE UPDATE OF theme_config ON events
      BEGIN
        SELECT RAISE(ABORT, 'theme update refused');
      END
    `).run();

    const response = await putTheme(access.event.id, garden, writeHeaders(access.manager));
    expect(response.status).toBe(500);
    expect(await testEnv.DB.prepare('SELECT theme_config FROM events WHERE id = ?')
      .bind(access.event.id).first('theme_config'))
      .toBe('{"version":1,"presetId":"candidary-default","overrides":{}}');
  });

  it('defaults semantic-invalid stored config only in event views and never during upload auth', async () => {
    const access = await eventAccess();
    const stored = '{"version":1,"presetId":"candidary-default","overrides":{"primaryColor":"#777777"}}';
    await testEnv.DB.prepare('UPDATE events SET theme_config = ? WHERE id = ?')
      .bind(stored, access.event.id)
      .run();

    const managerRead = await createApp().request(`/api/manage/events/${access.event.id}`, {
      headers: { cookie: access.manager.cookie },
    }, testEnv);
    expect(managerRead.status).toBe(200);
    expect((await managerRead.json<any>()).data.event.theme.config).toEqual(DEFAULT_CONFIG);
    expect(await testEnv.DB.prepare('SELECT theme_config FROM events WHERE id = ?')
      .bind(access.event.id).first('theme_config')).toBe(stored);

    const viewSpy = vi.spyOn(EventTheme, 'resolvedThemeView');
    try {
      const uploaded = await uploadPending(access, `resolver-isolation-${crypto.randomUUID()}`);
      expect(uploaded.uploadState).toBe('stored');
      expect(viewSpy).not.toHaveBeenCalled();
    } finally {
      viewSpy.mockRestore();
    }
  });

  it('uses the explicit event view for cover publication, settings, and theme update responses', async () => {
    const access = await eventAccess();
    // A `none` publication is the one cover write that applies synchronously and
    // returns the full Manager event view, so it is what pins the key set here.
    const published = await createApp().request(
      `/api/manage/events/${access.event.id}/cover/publications`,
      {
        method: 'POST',
        headers: writeHeaders(access.manager),
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          expectedRevision: 0,
          source: { kind: 'none' },
        }),
      },
      testEnv,
    );
    expect(published.status).toBe(200);
    expect(Object.keys((await published.json<any>()).data.event).sort()).toEqual([...EVENT_VIEW_KEYS].sort());

    const settings = await createApp().request(`/api/manage/events/${access.event.id}/settings`, {
      method: 'PATCH',
      headers: writeHeaders(access.manager),
      body: JSON.stringify({
        galleryVisible: true,
        eventTimezone: 'America/Chicago', eventStartTime: '00:00',
        rsvpDeadlineDate: '2026-09-05',
        rsvpEnabled: false, rsvpRosterVersion: 0,
        moderationRequired: true,
      }),
    }, testEnv);
    expect(Object.keys((await settings.json<any>()).data.event).sort()).toEqual([...EVENT_VIEW_KEYS].sort());

    const themed = await putTheme(access.event.id, garden, writeHeaders(access.manager));
    expect(Object.keys((await themed.json<any>()).data.event).sort()).toEqual([...EVENT_VIEW_KEYS].sort());
  });
});

describe('manager-authorized event cover reads', () => {
  async function coveredEvent() {
    const access = await eventAccess();
    const graph = await seedEventCoverGraph(testEnv.DB, access.event.id);
    const objectKey = coverRenderKey(
      access.event.id,
      graph.renderSetId,
      'wide-expanded',
      '1x',
      'jpeg',
    );
    await testEnv.DB.prepare(`
      UPDATE events
      SET cover_config = ?, cover_object_key = ?, cover_render_set_id = ?, cover_revision = 1
      WHERE id = ?
    `).bind(
      '{"version":1,"source":{"kind":"upload"},"focus":{"mode":"auto"},"effect":"natural"}',
      coverMasterKey(access.event.id, graph.masterId),
      graph.renderSetId,
      access.event.id,
    ).run();
    await testEnv.MEDIA_BUCKET.put(objectKey, png(), { httpMetadata: { contentType: 'image/jpeg' } });
    return { access, objectKey };
  }

  it('serves the same private binary cover to a matching link without CSRF and an owning account', async () => {
    const { access } = await coveredEvent();
    const linkRead = await createApp().request(`/api/manage/events/${access.event.id}/cover`, {
      headers: { cookie: access.manager.cookie },
    }, testEnv);
    expect(linkRead.status).toBe(200);
    expect(linkRead.headers.get('content-type')).toBe('image/jpeg');
    expect(linkRead.headers.get('cache-control')).toBe('private, no-store');

    const host = await hostAccess([access]);
    const accountRead = await createApp().request(`/api/manage/events/${access.event.id}/cover`, {
      headers: { cookie: host.cookie },
    }, testEnv);
    expect(accountRead.status).toBe(200);
    expect(accountRead.headers.get('content-length')).toBe(String(png().byteLength));
  });

  it('rejects missing, unrelated-account, guest, and cross-event credentials', async () => {
    const { access } = await coveredEvent();
    const other = await eventAccess('Other');
    const stranger = await hostAccess();
    const cases = [
      ['missing', '', 401, 'SESSION_REQUIRED'],
      ['unrelated account', stranger.cookie, 403, 'ROLE_FORBIDDEN'],
      ['guest', access.guest.cookie, 403, 'ROLE_FORBIDDEN'],
      ['cross-event', other.manager.cookie, 403, 'ROLE_FORBIDDEN'],
    ] as const;

    for (const [label, cookie, status, code] of cases) {
      const response = await createApp().request(`/api/manage/events/${access.event.id}/cover`, {
        headers: cookie ? { cookie } : {},
      }, testEnv);
      expect([label, response.status]).toEqual([label, status]);
      expect((await response.json<any>()).code).toBe(code);
    }
  });

  it('preserves stable JSON errors for no cover and a missing R2 object', async () => {
    const noCover = await eventAccess();
    const absent = await createApp().request(`/api/manage/events/${noCover.event.id}/cover`, {
      headers: { cookie: noCover.manager.cookie },
    }, testEnv);
    expect(absent.status).toBe(404);
    expect((await absent.json<any>()).code).toBe('EVENT_NOT_FOUND');

    const { access, objectKey } = await coveredEvent();
    await testEnv.MEDIA_BUCKET.delete(objectKey);
    const missing = await createApp().request(`/api/manage/events/${access.event.id}/cover`, {
      headers: { cookie: access.manager.cookie },
    }, testEnv);
    expect(missing.status).toBe(404);
    expect((await missing.json<any>()).code).toBe('UPLOAD_OBJECT_MISSING');
  });
});

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Locator, Page, TestInfo } from '@playwright/test';

import type {
  EventView,
  GuestEventView,
  HostSessionResponse,
  ManagerGalleryMediaView,
} from '../../shared/contracts';
import type { ExportView } from '../../src/app/types';
import type { ExportGuestbookEntryRecord } from '../../worker/db/types';
import { buildGuestbookHtml } from '../../worker/export/guestbook-html';
import { EVENT_THEME_PRESETS } from '../../shared/event-theme';
import { PHOTOGRAPHIC_COVER } from './fixtures/cover-images';
import {
  EVENT_FIXTURE,
  RSVP_HOUSEHOLD_FIXTURE,
  eventTheme,
  stubGuestRoutes,
  stubManagerRoutes,
} from './fixtures/routes';
import { UNBROKEN_TOKEN, makeMedia } from './fixtures/ui-data';
import { measureContrast, measureDocument, measureSeparation, measureTarget } from './helpers/geometry';
import { computedStyleContrast } from './helpers/theme-contrast';

// 320 is the narrowest supported phone; 768 is the tablet side of the public header's own boundary.
const HEADER_WIDTHS = [320, 768];
const RECOVERY_EVENT_ID = '11111111-2222-4333-8444-555555555555';
const E2E_ORIGIN = 'http://127.0.0.1:4173';
const ROTATED_MANAGEMENT_LINK = 'https://example.test/manage/replacement-id.replacement-secret';
// The public header keeps exactly these exits: the count is asserted so neither a
// hidden one nor an added one can pass unnoticed. On `/` the row reads navigate | return | act, and
// `How it works` is the only member of it whose presence varies by width — it is a page anchor the
// hero and the footer both still offer, so below 761px it gives up its room to `Sign in`, which a
// host returning on a phone has no other route past. See `.site-nav` in `src/styles.css`.
function headerExits(width: number): { path: string; names: string[] }[] {
  const wayfinding = width > 760 ? ['How it works'] : [];
  return [
    { path: '/', names: ['Candidary home', ...wayfinding, 'Sign in', 'Create an event'] },
    { path: '/create', names: ['Candidary home', 'Back home'] },
  ];
}

const NOTE = {
  id: 'message-a',
  guestName: 'Rowan',
  body: 'To a lifetime of noticing the little things.',
  moderationStatus: 'approved' as const,
  createdAt: '2026-09-19T20:00:00Z',
};
// The six manager destinations, paired with the heading that proves the section is on screen before
// the engine reads it. An axe pass over a section that has not rendered yet proves nothing.
const MANAGER_SECTIONS = [
  { name: 'Intake', heading: 'Live intake' },
  { name: 'RSVP', heading: 'Guest list and RSVPs' },
  { name: 'Gallery', heading: 'Gallery' },
  { name: 'Guestbook', heading: 'Guestbook from the day' },
  { name: 'Share', heading: 'Share your event' },
  { name: 'Settings', heading: 'Settings' },
] as const;

// axe-core 4.12.1 ships 105 rules and leaves 9 off by default, so a bare `.analyze()` is axe's
// *default* rule set, not its *full* one. One of the nine is `target-size` — WCAG 2.2 SC 2.5.8 — so
// it is switched on here explicitly. Nothing is narrowed to pay for it: no `runOnly`, no `withTags`,
// no `disableRules`, no `include`/`exclude`.
//
// Its floor is 24 x 24 CSS px with spacing, inline and essential exceptions — NOT the 44 x 44 this
// suite enforces. It is worth running, but it would not notice a 44 px control shrinking to 24: the
// 44 px floor rests entirely on the `measureTarget` assertions in this file and the responsive
// specs. A green axe run is not touch-target conformance. Which rules still do not run, and why
// that is acceptable, is recorded in `design-qa.md`.
const AXE_OPTIONS = { rules: { 'target-size': { enabled: true } } };

const THEME_ACCESSIBILITY_CASES = [
  ...EVENT_THEME_PRESETS.map(({ id, name }) => ({ name, theme: eventTheme(id) })),
  {
    name: 'custom black',
    theme: eventTheme('candidary-default', { primaryColor: '#000000', accentColor: '#000000' }),
  },
  {
    name: 'custom white',
    theme: eventTheme('candidary-default', { primaryColor: '#ffffff', accentColor: '#ffffff' }),
  },
  {
    name: 'custom mid-tone',
    theme: eventTheme('coastal-light', { primaryColor: '#767676', accentColor: '#767676' }),
  },
];

function onlyOnce(testInfo: TestInfo) {
  test.skip(testInfo.project.name === 'mobile', 'Viewport-pinned accessibility evidence runs once.');
}

async function installViteRefreshGlobals(page: Page) {
  // The focused dev-server config uses Cloudflare's SPA fallback rather than Vite's transformed
  // HTML, so plugin-react's refresh globals are absent. These are inert for browser assertions;
  // the selected tests do not exercise HMR.
  await page.addInitScript(() => {
    Object.assign(window, {
      $RefreshReg$: () => undefined,
      $RefreshSig$: () => (type: unknown) => type,
    });
  });
}

// The engine runs over the whole document with axe's default rule set plus `target-size`. Narrowing
// it to make a surface pass would leave it proving nothing. Violations are reported by rule id,
// target, and axe's own explanation so a failure names the element and the measurement instead of
// dumping the rule catalogue; the array is empty exactly when `results.violations` is. Soft, so one
// run reports every surface rather than stopping at the first.
async function expectNoAxeViolations(page: Page, surface: string) {
  const results = await new AxeBuilder({ page }).options(AXE_OPTIONS).analyze();
  // A rule that never ran reports nothing, which on the wire is indistinguishable from a rule that
  // ran and found nothing. axe lists every rule it evaluated across these four buckets and omits any
  // rule that was switched off, so this is what makes the `target-size` claim in `design-qa.md`
  // checkable rather than merely written down. Remove the option above and this fails first.
  const evaluated = [results.passes, results.violations, results.incomplete, results.inapplicable]
    .flat().map(({ id }) => id);
  expect.soft(evaluated, `${surface} evaluated target-size`).toContain('target-size');
  expect.soft(
    results.violations.flatMap(({ id, impact, nodes }) => nodes.map((node) => ({
      id, impact, target: node.target, why: [...node.any, ...node.all].map(({ message }) => message),
    }))),
    `${surface} accessibility violations`,
  ).toEqual([]);
}

const REQUIRED_MANAGER_AXE_FIXTURES = [
  'Intake default', 'Intake filtered', 'Intake Recently deleted',
  'true-empty Intake', 'Manager upload held transfer', 'Cover upload progress', 'RSVP',
  'Library default', 'Library selection', 'Library selection tray', 'Library viewer',
  'Album editor', 'Album Preview', 'Album create-link dialog', 'Album live-link state',
  'Album stop-link alertdialog', 'Guest gallery all', 'Guest gallery unpublished',
  'Guest gallery published', 'Guest gallery hidden', 'Guest gallery single-write',
  'Guest gallery bulk-write', 'Guestbook', 'Share', 'Settings', 'Album-leave prompt',
  'Rotate management link confirmation', 'Rotate management link sensitive result',
  'RSVP pending-work prompt', 'Settings pending-work prompt',
  'Move to Recently deleted dialog', 'Entry rotation confirmation',
  'Entry disable confirmation',
] as const;

type ManagerAxeFixtureName = typeof REQUIRED_MANAGER_AXE_FIXTURES[number];
type ManagerAxeFixture = {
  name: ManagerAxeFixtureName;
  setup(page: Page): Promise<void>;
  ready(page: Page): Promise<void>;
  cleanup?(page: Page): Promise<void>;
};

const REQUIRED_GUEST_AXE_FIXTURES = [
  'paused guest main page',
  'paused guest fullscreen',
] as const;

type GuestAxeFixtureName = typeof REQUIRED_GUEST_AXE_FIXTURES[number];
type GuestAxeFixture = {
  name: GuestAxeFixtureName;
  setup(page: Page): Promise<void>;
  ready(page: Page): Promise<void>;
};

const REQUIRED_HOST_AXE_FIXTURES = [
  'pending registration route',
  'Host Events search and sort',
] as const;

type HostAxeFixtureName = typeof REQUIRED_HOST_AXE_FIXTURES[number];
type HostAxeFixture = {
  name: HostAxeFixtureName;
  setup(page: Page): Promise<void>;
  ready(page: Page): Promise<void>;
};

const REQUIRED_PUBLIC_ALBUM_AXE_FIXTURES = [
  'Public Album nonempty',
  'Public Album empty',
] as const;

type PublicAlbumAxeFixtureName = typeof REQUIRED_PUBLIC_ALBUM_AXE_FIXTURES[number];
type PublicAlbumAxeFixture = {
  name: PublicAlbumAxeFixtureName;
  setup(page: Page): Promise<void>;
  ready(page: Page): Promise<void>;
  cleanup?(page: Page): Promise<void>;
};

async function readyHeading(page: Page, name: string | RegExp) {
  await expect(page.getByRole('heading', { name })).toBeVisible();
}

async function readyModal(page: Page, role: 'dialog' | 'alertdialog', name: string | RegExp) {
  await expect(page.getByRole(role, { name })).toBeVisible();
}

async function installHostAccountSession(page: Page) {
  await page.context().addCookies([
    {
      name: 'candidary_host',
      value: 'host-session.fixture-secret',
      url: E2E_ORIGIN,
      httpOnly: true,
      sameSite: 'Lax',
    },
    {
      name: 'candidary_host_csrf',
      value: 'host-csrf-fixture',
      url: E2E_ORIGIN,
      sameSite: 'Strict',
    },
  ]);
  await page.route('**/api/host/session', (route) => route.fulfill({
    headers: { 'cache-control': 'private, no-store' },
    json: {
      data: {
        account: { email: 'host@example.test' },
        events: [{ id: EVENT_FIXTURE.id }],
      },
      requestId: 'request-host-session',
    },
  }));
}

async function openManagerSection(page: Page, name: typeof MANAGER_SECTIONS[number]['name']) {
  await page.goto(`/manage/event/${EVENT_FIXTURE.id}`);
  if (name !== 'Intake') {
    await page.getByRole('navigation', { name: 'Manager sections' })
      .getByRole('button', { name }).click();
  }
}

async function openManagerLinkRotationConfirmation(page: Page) {
  await installHostAccountSession(page);
  await stubManagerRoutes(page, {
    mediaPages: { first: { media: [], nextCursor: null } },
    event: {
      managerLinkRevision: 4,
      managerLinkRotationAvailability: { enabled: true, reason: null },
    },
    managerLinkRotation: { managementLink: ROTATED_MANAGEMENT_LINK },
  });
  await openManagerSection(page, 'Settings');
  await page.getByRole('button', { name: 'Rotate manager link' }).click();
}

async function openGalleryMode(page: Page, mode: 'Library' | 'Album' | 'Guest gallery') {
  await openManagerSection(page, 'Gallery');
  await page.getByRole('group', { name: 'Gallery mode' })
    .getByRole('button', { name: mode }).click();
}

async function scanManagerFixture(page: Page, fixture: ManagerAxeFixture) {
  try {
    await installViteRefreshGlobals(page);
    await fixture.setup(page);
    await fixture.ready(page);
    await expectNoAxeViolations(page, fixture.name);
  } finally {
    await fixture.cleanup?.(page);
  }
}

function makeAxeLibraryMedia() {
  return makeMedia(3, 'unpublished').map((photo, index) => ({
    ...photo,
    caption: `Axe Library photo ${index + 1}`,
  }));
}

function makeAxeAlbumMedia() {
  return makeMedia(2, 'published').map((photo, index) => ({
    ...photo,
    caption: `Axe Album photo ${index + 1}`,
  }));
}

function axeAlbumRouteState(
  rows: ReturnType<typeof makeAxeAlbumMedia>,
  share?: { active: boolean; token: string },
) {
  return {
    pickedMediaIds: rows.map(({ id }) => id),
    title: 'Axe Album',
    description: 'A saved two-photo accessibility fixture.',
    coverMediaId: rows[0]!.id,
    entries: rows.map(({ id }) => ({ kind: 'photo' as const, mediaId: id })),
    saved: true,
    ...(share ? { shareActive: share.active, shareToken: share.token } : {}),
  };
}

type AxeGuestGalleryFilter = 'all' | 'unpublished' | 'published' | 'hidden';

const AXE_GUEST_GALLERY_FILTER_LABELS: Record<AxeGuestGalleryFilter, string> = {
  all: 'All',
  unpublished: 'Unpublished',
  published: 'Published',
  hidden: 'Hidden',
};

function makeAxeGuestGalleryMedia() {
  const unpublished = makeMedia(2, 'unpublished').map((photo, index) => ({
    ...photo,
    id: `00000000-0000-4000-8100-${String(index + 1).padStart(12, '0')}`,
    originalFilename: `axe-unpublished-${index + 1}.jpg`,
    caption: `Axe unpublished photo ${index + 1}`,
  }));
  const published = makeMedia(1, 'published').map((photo) => ({
    ...photo,
    id: '00000000-0000-4000-8200-000000000001',
    originalFilename: 'axe-published-1.jpg',
    caption: 'Axe published photo 1',
  }));
  const hidden = makeMedia(1, 'hidden').map((photo) => ({
    ...photo,
    id: '00000000-0000-4000-8300-000000000001',
    originalFilename: 'axe-hidden-1.jpg',
    caption: 'Axe hidden photo 1',
  }));
  return [...unpublished, ...published, ...hidden];
}

function guestGalleryMediaResponse(page: Page, status: AxeGuestGalleryFilter) {
  return page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === 'GET'
      && url.pathname === `/api/manage/events/${EVENT_FIXTURE.id}/media`
      && url.searchParams.get('status') === (status === 'all' ? null : status);
  });
}

async function openGuestGalleryFilter(page: Page, status: AxeGuestGalleryFilter) {
  const initialResponse = guestGalleryMediaResponse(page, 'unpublished');
  await openGalleryMode(page, 'Guest gallery');
  await initialResponse;
  const controls = page.getByRole('group', { name: 'Publication status' });
  await expect(controls).toBeVisible();

  // Unpublished is the workspace default. Leave and return so this descriptor still proves the
  // literal Unpublished control and its action-caused request rather than scanning initial state.
  if (status === 'unpublished') {
    const allResponse = guestGalleryMediaResponse(page, 'all');
    await controls.getByRole('button', { name: 'All', exact: true }).click();
    await allResponse;
  }

  const filteredResponse = guestGalleryMediaResponse(page, status);
  await controls.getByRole('button', {
    name: AXE_GUEST_GALLERY_FILTER_LABELS[status],
    exact: true,
  }).click();
  await filteredResponse;
}

async function readyGuestGalleryFilter(
  page: Page,
  status: AxeGuestGalleryFilter,
  rows: ReturnType<typeof makeAxeGuestGalleryMedia>,
) {
  const controls = page.getByRole('group', { name: 'Publication status' });
  await expect(controls.getByRole('button', {
    name: AXE_GUEST_GALLERY_FILTER_LABELS[status],
    exact: true,
  })).toHaveAttribute('aria-pressed', 'true');

  const expected = status === 'all'
    ? rows
    : rows.filter((row) => row.publicationStatus === status);
  const nonmatching = rows.filter((row) => !expected.includes(row));
  const articles = page.locator('.moderation-grid article');
  await expect(articles).toHaveCount(expected.length);
  for (const row of expected) {
    const article = articles.filter({ hasText: row.caption! });
    await expect(article).toHaveCount(1);
    await expect(article).toBeVisible();
  }
  for (const row of nonmatching) {
    await expect(articles.filter({ hasText: row.caption! })).toHaveCount(0);
  }
}

const MANAGER_AXE_FIXTURES: ManagerAxeFixture[] = [((): ManagerAxeFixture => {
  const media = makeMedia(3);
  return {
    name: 'Intake default',
    async setup(page) {
      await stubManagerRoutes(page, {
        mediaPages: { first: { media, nextCursor: null } },
      });
      await openManagerSection(page, 'Intake');
    },
    async ready(page) {
      await readyHeading(page, 'Live intake');
      const liveIntake = page.getByRole('group', { name: 'Which photos to show' })
        .getByRole('button', { name: 'Live intake', exact: true });
      await expect(liveIntake).toBeVisible();
      await expect(liveIntake).toHaveAttribute('aria-pressed', 'true');
      const grid = page.locator('.intake-grid');
      await expect(grid.locator('article')).toHaveCount(media.length);
      await expect(grid.locator(`[data-intake-card="${media[0]!.id}"]`)).toBeVisible();
    },
  };
})(),
  {
    name: 'Intake filtered',
    async setup(page) {
      await stubManagerRoutes(page, {
        mediaPages: { first: { media: makeMedia(1), nextCursor: null } },
      });
      await openManagerSection(page, 'Intake');
      const filter = page.getByRole('textbox', { name: 'Filter by guest name' });
      await filter.fill('Avery Stone');
      const filteredResponse = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return response.request().method() === 'GET'
          && url.pathname === `/api/manage/events/${EVENT_FIXTURE.id}/media`
          && url.searchParams.get('guestName') === 'Avery Stone';
      });
      await page.getByRole('button', { name: 'Filter', exact: true }).click();
      await filteredResponse;
    },
    async ready(page) {
      await expect(page.getByRole('textbox', { name: 'Filter by guest name' }))
        .toHaveValue('Avery Stone');
      const filteredRows = page.locator('.intake-grid article').filter({ hasText: 'Avery Stone' });
      await expect(filteredRows).toHaveCount(1);
      await expect(filteredRows.first()).toBeVisible();
    },
  },
  {
    name: 'Intake Recently deleted',
    async setup(page) {
      await stubManagerRoutes(page, {
        mediaPages: { first: { media: [], nextCursor: null } },
        event: { recoverableMediaCount: 1 },
        trashedMedia: [{
          id: '00000000-0000-4000-8000-000000000099',
          originalFilename: 'retained-photo.jpg',
          guestName: 'Avery Stone',
          caption: 'Held moment',
          trashedAt: '2026-09-20T01:00:00.000Z',
          restoreUntil: '2099-10-19T00:00:00.000Z',
        }],
      });
      await openManagerSection(page, 'Intake');
      const trashResponse = page.waitForResponse((response) => (
        response.request().method() === 'GET'
        && new URL(response.url()).pathname
          === `/api/manage/events/${EVENT_FIXTURE.id}/media/trash`
      ));
      await page.getByRole('button', { name: 'Recently deleted (1)' }).click();
      await trashResponse;
    },
    async ready(page) {
      await expect(page.getByRole('heading', { name: 'Recently deleted', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Restore retained-photo.jpg' })).toBeVisible();
    },
  },
  {
    name: 'true-empty Intake',
    async setup(page) {
      await stubManagerRoutes(page, {
        event: { storedMediaCount: 0 },
        mediaPages: { first: { media: [], nextCursor: null } },
      });
      await openManagerSection(page, 'Intake');
    },
    async ready(page) {
      const empty = page.getByRole('heading', { name: 'No photos yet' }).locator('..');
      await expect(empty).toBeVisible();
      await expect(empty.getByText("Guests' photos arrive privately here.")).toBeVisible();
      await expect(empty.getByRole('button', { name: 'Share event' })).toBeVisible();
      await expect(empty.getByRole('button', { name: 'Add photos' })).toBeVisible();
      await expect(page.getByRole('img', { name: 'Event QR code' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'No matching photos' })).toHaveCount(0);
    },
  },
  (() => {
    let releaseContent = () => {};
    const contentGate = new Promise<void>((resolve) => { releaseContent = resolve; });
    let managerUrl = '';
    return {
      name: 'Manager upload held transfer',
      async setup(page) {
        await stubManagerRoutes(page, {
          mediaPages: { first: { media: [], nextCursor: null } },
          uploads: { contentGate },
        });
        await page.goto('/');
        await openManagerSection(page, 'Intake');
        managerUrl = page.url();
        await page.getByRole('button', { name: 'Add photos' }).click();
        const dialog = page.getByRole('dialog', { name: 'Add photos' });
        await dialog.locator('input[data-photo-source="library"]').setInputFiles({
          name: 'held-manager-upload.jpg',
          mimeType: 'image/jpeg',
          buffer: Buffer.from('held-manager-upload'),
        });
        const contentRequest = page.waitForRequest((request) => (
          request.method() === 'PUT'
          && new URL(request.url()).pathname.includes('/uploads/')
          && new URL(request.url()).pathname.endsWith('/content')
        ));
        await dialog.getByRole('button', { name: 'Send 1 photo' }).click();
        await contentRequest;
      },
      async ready(page) {
        const dialog = page.getByRole('dialog', { name: 'Add photos' });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'Close Add photos' })).toHaveCount(0);
        await expect(dialog.getByRole('button', { name: 'Cancel uploads' })).toBeVisible();

        const backNavigation = page.goBack();
        await expect(page).toHaveURL(managerUrl);
        await expect(dialog).toBeVisible();

        const gallery = page.locator('.manager-nav nav button').filter({ hasText: 'Gallery' });
        await gallery.evaluate((button) => {
          button.dispatchEvent(new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            button: 0,
            view: window,
          }));
        });
        await backNavigation;
        await expect(page).toHaveURL(managerUrl);
        await expect(gallery).toHaveAttribute('aria-pressed', 'false');
        await expect(dialog).toBeVisible();
      },
      async cleanup(page) {
        releaseContent();
        await expect(page).toHaveURL(
          `/manage/event/${EVENT_FIXTURE.id}?section=gallery`,
        );
        const dialog = page.getByRole('dialog', { name: 'Add photos' });
        await expect(dialog.getByRole('heading', { name: '1 photo was added.' })).toBeVisible();
      },
    } satisfies ManagerAxeFixture;
  })(),
  (() => {
    let releaseRawTransfer = () => {};
    let rawTransferReached = Promise.resolve();
    return {
      name: 'Cover upload progress',
      async setup(page) {
        let markRawTransferReached = () => {};
        rawTransferReached = new Promise<void>((resolve) => {
          markRawTransferReached = resolve;
        });
        const rawTransferGate = new Promise<void>((resolve) => {
          releaseRawTransfer = resolve;
        });
        await stubManagerRoutes(page, {
          mediaPages: { first: { media: [], nextCursor: null } },
        });
        await page.route(
          `**/api/manage/events/${EVENT_FIXTURE.id}/cover/drafts/draft-e2e/raw`,
          async (route) => {
            markRawTransferReached();
            await rawTransferGate;
            await route.fallback();
          },
        );
        await openManagerSection(page, 'Settings');
        await page.getByRole('button', { name: 'Change cover' }).click();
        await page.getByLabel('Choose photo').setInputFiles({
          name: 'cover-progress.jpg',
          mimeType: 'image/jpeg',
          buffer: Buffer.alloc(19_000_000),
        });
        await rawTransferReached;
      },
      async ready(page) {
        const studio = page.getByRole('dialog', { name: 'Cover Studio' });
        const progress = studio.getByRole('progressbar', { name: 'Uploading cover photo' });
        await expect(progress).toBeVisible();
        await expect(progress).toHaveAttribute('max', '19000000');
        await expect(studio.getByRole('status')).toContainText(/Upload (started|complete)|Uploading photo/u);
        await expect(studio.getByRole('button', { name: 'Continue' })).toBeDisabled();
      },
      async cleanup(page) {
        releaseRawTransfer();
        await expect(page.getByRole('progressbar', { name: 'Uploading cover photo' }))
          .toHaveCount(0);
      },
    } satisfies ManagerAxeFixture;
  })(),
  {
    name: 'RSVP',
    async setup(page) {
      await stubManagerRoutes(page, {
        mediaPages: { first: { media: [], nextCursor: null } },
      });
      await openManagerSection(page, 'RSVP');
    },
    async ready(page) {
      await readyHeading(page, 'Guest list and RSVPs');
      await expect(page.getByRole('button', { name: 'Add guests' })).toBeVisible();
    },
  },
  {
    name: 'Library default',
    async setup(page) {
      const rows = makeAxeLibraryMedia();
      await stubManagerRoutes(page, {
        mediaPages: { first: { media: rows, nextCursor: null } },
        event: { storedMediaCount: rows.length },
      });
      await openGalleryMode(page, 'Library');
    },
    async ready(page) {
      await expect(page.getByRole('group', { name: 'Gallery mode' })
        .getByRole('button', { name: 'Library', exact: true }))
        .toHaveAttribute('aria-pressed', 'true');
      const mosaic = page.locator('.gallery-mosaic__item');
      await expect(mosaic).toHaveCount(3);
      await expect(mosaic.first().locator('img')).toBeVisible();
    },
  },
  {
    name: 'Library selection',
    async setup(page) {
      const rows = makeAxeLibraryMedia();
      await stubManagerRoutes(page, {
        mediaPages: { first: { media: rows, nextCursor: null } },
        event: { storedMediaCount: rows.length },
      });
      await openGalleryMode(page, 'Library');
      await expect(page.locator('.gallery-mosaic__item')).toHaveCount(rows.length);
      await page.getByRole('button', { name: 'Select photos' }).click();
      await page.getByRole('button', {
        name: 'Select Axe Library photo 1, from Avery Stone',
        exact: true,
      }).click();
    },
    async ready(page) {
      const selected = page.getByRole('button', {
        name: 'Deselect Axe Library photo 1, from Avery Stone',
        exact: true,
      });
      await expect(selected).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('.gallery-mosaic__item.is-selected')
        .filter({ has: selected })).toHaveCount(1);
    },
  },
  {
    name: 'Library selection tray',
    async setup(page) {
      const rows = makeAxeLibraryMedia();
      await stubManagerRoutes(page, {
        mediaPages: { first: { media: rows, nextCursor: null } },
        event: { storedMediaCount: rows.length },
      });
      await openGalleryMode(page, 'Library');
      await expect(page.locator('.gallery-mosaic__item')).toHaveCount(rows.length);
      await page.getByRole('button', { name: 'Select photos' }).click();
      await page.getByRole('button', {
        name: 'Select Axe Library photo 1, from Avery Stone',
        exact: true,
      }).click();
    },
    async ready(page) {
      const tray = page.getByRole('region', { name: 'Album', exact: true });
      await expect(tray).toContainText('1 of 50 selected');
      await expect(tray.getByRole('button', { name: 'Pick for Album (1)' })).toBeEnabled();
      await expect(tray.getByRole('button', { name: 'Remove from Album (1)' })).toBeEnabled();
      await expect(tray.getByRole('button', { name: 'Clear selection' })).toBeEnabled();
    },
  },
  {
    name: 'Library viewer',
    async setup(page) {
      const rows = makeAxeLibraryMedia();
      await stubManagerRoutes(page, {
        mediaPages: { first: { media: rows, nextCursor: null } },
        event: { storedMediaCount: rows.length },
      });
      await openGalleryMode(page, 'Library');
      await expect(page.locator('.gallery-mosaic__item')).toHaveCount(rows.length);
      await page.locator('.gallery-mosaic__open').first().click();
    },
    async ready(page) {
      const viewer = page.getByRole('dialog', { name: 'Axe Library photo 3' });
      await expect(viewer).toBeVisible();
      await expect(viewer.getByRole('button', { name: 'Close viewer' })).toBeFocused();
      const currentImage = viewer.getByRole('img', { name: 'Axe Library photo 3' });
      const currentFallback = viewer.locator('.gallery-viewer__placeholder')
        .filter({ hasText: 'moment-3.jpg' });
      await expect.poll(async () => {
        if (await currentImage.count() === 1) {
          return currentImage.evaluate((image) => (
            image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
              ? 'decoded current image'
              : 'pending'
          ));
        }
        if (
          await currentFallback.count() === 1
          && await currentFallback.getByText('Preview unavailable', { exact: true }).isVisible()
          && await currentFallback.getByText(
            'This photo was delivered and is included in your download.',
            { exact: true },
          ).isVisible()
        ) return 'current-photo fallback';
        return 'pending';
      }).toMatch(/^(decoded current image|current-photo fallback)$/u);
    },
  },
  {
    name: 'Album editor',
    async setup(page) {
      const rows = makeAxeAlbumMedia();
      await stubManagerRoutes(page, {
        mediaPages: { first: { media: rows, nextCursor: null } },
        event: { storedMediaCount: rows.length },
        album: axeAlbumRouteState(rows),
      });
      await openGalleryMode(page, 'Album');
    },
    async ready(page) {
      await readyHeading(page, 'The order people with the Album link will see');
      await expect(page.getByLabel('Album title')).toHaveValue('Axe Album');
      await expect(page.locator('.album-review-grid > li')).toHaveCount(2);
      await expect(page.locator('.album-autosave-row').getByText('Saved', { exact: true }))
        .toBeVisible();
    },
  },
  {
    name: 'Album Preview',
    async setup(page) {
      const rows = makeAxeAlbumMedia();
      await stubManagerRoutes(page, {
        mediaPages: { first: { media: rows, nextCursor: null } },
        event: { storedMediaCount: rows.length },
        album: axeAlbumRouteState(rows),
      });
      await openGalleryMode(page, 'Album');
      await readyHeading(page, 'The order people with the Album link will see');
      const previewResponse = page.waitForResponse((response) => (
        response.request().method() === 'GET'
        && new URL(response.url()).pathname
          === `/api/manage/events/${EVENT_FIXTURE.id}/album/preview`
      ));
      await page.getByRole('button', { name: 'Preview album' }).click();
      await previewResponse;
    },
    async ready(page) {
      const preview = page.getByRole('region', { name: 'What people with the Album link see' });
      await expect(preview).toHaveClass(/album-preview/u);
      await expect(preview.getByRole('heading', { level: 3, name: 'Axe Album' })).toBeVisible();
      await expect(preview.getByRole('img', { name: 'Axe Album photo 1' })).toBeVisible();
      await expect(preview.locator('.public-album__photo')).toHaveCount(2);
    },
  },
  {
    name: 'Album create-link dialog',
    async setup(page) {
      const rows = makeAxeAlbumMedia();
      await stubManagerRoutes(page, {
        mediaPages: { first: { media: rows, nextCursor: null } },
        event: { storedMediaCount: rows.length },
        album: axeAlbumRouteState(rows),
      });
      await openGalleryMode(page, 'Album');
      await readyHeading(page, 'The order people with the Album link will see');
      await page.getByRole('button', { name: 'Create Album link' }).click();
    },
    async ready(page) {
      await readyModal(page, 'dialog', 'Create the Album link?');
      const dialog = page.getByRole('dialog', { name: 'Create the Album link?' });
      await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
      await expect(dialog).toContainText('This link will show 2 photos');
    },
  },
  {
    name: 'Album live-link state',
    async setup(page) {
      const rows = makeAxeAlbumMedia();
      await stubManagerRoutes(page, {
        mediaPages: { first: { media: rows, nextCursor: null } },
        event: { storedMediaCount: rows.length },
        album: axeAlbumRouteState(rows, {
          active: false,
          token: 'axe-live-album-id.axe-live-album-secret',
        }),
      });
      await openGalleryMode(page, 'Album');
      await readyHeading(page, 'The order people with the Album link will see');
      await page.getByRole('button', { name: 'Create Album link' }).click();
      const createResponse = page.waitForResponse((response) => (
        response.request().method() === 'POST'
        && new URL(response.url()).pathname
          === `/api/manage/events/${EVENT_FIXTURE.id}/album/share`
      ));
      await page.getByRole('dialog', { name: 'Create the Album link?' })
        .getByRole('button', { name: 'Create Album link' }).click();
      await createResponse;
      await page.getByRole('button', { name: 'Reveal Album link' }).click();
    },
    async ready(page) {
      const share = page.locator('.album-share');
      await expect(share).toBeVisible();
      await expect(page.getByRole('button', { name: 'Stop Album link', exact: true })).toBeVisible();
      await expect(share.getByRole('button', { name: 'Copy Album link' })).toBeVisible();
      await expect(share.getByRole('textbox', { name: 'Album link' })).toHaveValue(
        /\/album#axe-live-album-id\.axe-live-album-secret$/u,
      );
    },
  },
  {
    name: 'Album stop-link alertdialog',
    async setup(page) {
      const rows = makeAxeAlbumMedia();
      await stubManagerRoutes(page, {
        mediaPages: { first: { media: rows, nextCursor: null } },
        event: { storedMediaCount: rows.length },
        album: axeAlbumRouteState(rows, {
          active: true,
          token: 'axe-stop-album-id.axe-stop-album-secret',
        }),
      });
      await openGalleryMode(page, 'Album');
      await readyHeading(page, 'The order people with the Album link will see');
      await page.getByRole('button', { name: 'Stop Album link', exact: true }).click();
    },
    async ready(page) {
      await readyModal(page, 'alertdialog', 'Stop the Album link?');
      const dialog = page.getByRole('alertdialog', { name: 'Stop the Album link?' });
      await expect(dialog.getByRole('button', { name: 'Keep sharing' })).toBeFocused();
      await expect(dialog.getByRole('button', { name: 'Stop Album link' })).toBeVisible();
    },
  },
  ...(['all', 'unpublished', 'published', 'hidden'] as const).map((status): ManagerAxeFixture => {
    const rows = makeAxeGuestGalleryMedia();
    return {
      name: `Guest gallery ${status}`,
      async setup(page) {
        await stubManagerRoutes(page, {
          mediaPages: { first: { media: rows, nextCursor: null } },
          event: { storedMediaCount: rows.length },
        });
        await openGuestGalleryFilter(page, status);
      },
      ready: (page) => readyGuestGalleryFilter(page, status, rows),
    };
  }),
  (() => {
    const rows = makeAxeGuestGalleryMedia();
    let releaseSingle!: () => void;
    const singleGate = new Promise<void>((resolve) => { releaseSingle = resolve; });
    let publicationResponse: Promise<unknown> | null = null;
    return {
      name: 'Guest gallery single-write',
      async setup(page) {
        await stubManagerRoutes(page, {
          mediaPages: { first: { media: rows, nextCursor: null } },
          event: { storedMediaCount: rows.length },
          album: { singlePublicationGate: singleGate },
        });
        await openGuestGalleryFilter(page, 'unpublished');
        await readyGuestGalleryFilter(page, 'unpublished', rows);
        const mediaId = rows.find((row) => row.caption === 'Axe unpublished photo 1')!.id;
        const publicationRequest = page.waitForRequest((request) => (
          request.method() === 'PATCH'
          && new URL(request.url()).pathname
            === `/api/manage/events/${EVENT_FIXTURE.id}/media/${mediaId}`
        ));
        await Promise.all([
          publicationRequest,
          page.getByRole('button', { name: 'Publish axe-unpublished-1.jpg' }).click(),
        ]);
        // The route gate now owns the in-flight request, so the response cannot settle before this
        // waiter is armed. A click/setup failure never reaches this assignment.
        publicationResponse = page.waitForResponse((response) => (
          response.request().method() === 'PATCH'
          && new URL(response.url()).pathname
            === `/api/manage/events/${EVENT_FIXTURE.id}/media/${mediaId}`
        ));
      },
      async ready(page) {
        await expect(page.locator('[data-gallery-live-host] [role="status"]'))
          .toHaveText('Publishing Axe unpublished photo 1…');
      },
      async cleanup() {
        releaseSingle();
        if (publicationResponse !== null) await publicationResponse;
      },
    } satisfies ManagerAxeFixture;
  })(),
  (() => {
    const rows = makeAxeGuestGalleryMedia();
    let releaseBulk!: () => void;
    const bulkGate = new Promise<void>((resolve) => { releaseBulk = resolve; });
    let bulkResponse: Promise<unknown> | null = null;
    return {
      name: 'Guest gallery bulk-write',
      async setup(page) {
        await stubManagerRoutes(page, {
          mediaPages: { first: { media: rows, nextCursor: null } },
          event: { storedMediaCount: rows.length },
          album: { bulkPublicationGate: bulkGate },
        });
        await openGuestGalleryFilter(page, 'unpublished');
        await readyGuestGalleryFilter(page, 'unpublished', rows);
        await page.getByRole('checkbox', { name: 'Select Axe unpublished photo 1' }).check();
        await page.getByRole('checkbox', { name: 'Select Axe unpublished photo 2' }).check();
        const bulkRequest = page.waitForRequest((request) => (
          request.method() === 'POST'
          && new URL(request.url()).pathname
            === `/api/manage/events/${EVENT_FIXTURE.id}/media/bulk`
        ));
        await Promise.all([
          bulkRequest,
          page.getByRole('button', { name: 'Publish selected' }).click(),
        ]);
        // As above, arm the response waiter only after both the action and held request are known
        // to exist, so cleanup cannot mask an earlier setup failure.
        bulkResponse = page.waitForResponse((response) => (
          response.request().method() === 'POST'
          && new URL(response.url()).pathname
            === `/api/manage/events/${EVENT_FIXTURE.id}/media/bulk`
        ));
      },
      async ready(page) {
        const bulkBar = page.locator('.gallery-shared .bulk-bar');
        await expect(bulkBar).toHaveAttribute('aria-busy', 'true');
        await expect(bulkBar.locator('#bulk-selection-status')).toHaveText('2 of 50 selected');
        const publishing = bulkBar.getByRole('button', { name: 'Publishing…' });
        await expect(publishing).toBeDisabled();
        await expect(publishing).toHaveAttribute('aria-busy', 'true');
        await expect(bulkBar.getByRole('button', { name: 'Hide selected' })).toBeDisabled();
      },
      async cleanup() {
        releaseBulk();
        if (bulkResponse !== null) await bulkResponse;
      },
    } satisfies ManagerAxeFixture;
  })(),
  {
    name: 'Guestbook',
    async setup(page) {
      await stubManagerRoutes(page, {
        mediaPages: { first: { media: [], nextCursor: null } },
        messages: [NOTE],
      });
      const guestbookResponse = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return response.request().method() === 'GET'
          && url.pathname === `/api/manage/events/${EVENT_FIXTURE.id}/guestbook`
          && url.searchParams.get('view') === 'shared'
          && url.searchParams.get('source') === 'all'
          && url.searchParams.get('limit') === '25';
      });
      await openManagerSection(page, 'Guestbook');
      await guestbookResponse;
    },
    async ready(page) {
      await readyHeading(page, 'Guestbook from the day');
      await expect(page.getByRole('group', { name: 'Guestbook view' })
        .getByRole('button', { name: /^Shared\b/u }))
        .toHaveAttribute('aria-pressed', 'true');
      const row = page.getByRole('listitem', { name: 'Rowan Guest note' });
      await expect(row).toBeVisible();
      await expect(row.getByRole('heading', { name: 'Rowan' })).toBeVisible();
      await expect(row.getByText(NOTE.body, { exact: true })).toBeVisible();
    },
  },
  {
    name: 'Share',
    async setup(page) {
      const runningExport: ExportView = {
        id: 'axe-share-running-export',
        kind: 'complete',
        state: 'running',
        snapshotAt: '2026-09-20T09:00:00Z',
        createdAt: '2026-09-20T09:00:00Z',
        startedAt: '2026-09-20T09:00:01Z',
        completedAt: null,
        mediaCount: 4,
        totalBytes: 512,
        processedMediaCount: 2,
        processedBytes: 256,
        progressUpdatedAt: '2026-09-20T09:00:02Z',
        attempt: 1,
        partCount: 0,
        expiresAt: null,
        guestbookEntryCount: 1,
        guestbookSharedCount: 1,
        guestbookEventName: EVENT_FIXTURE.name,
        guestbookEventDate: EVENT_FIXTURE.eventDate,
        guestbookEventTimezone: EVENT_FIXTURE.eventTimezone,
        guestbookPrompt: EVENT_FIXTURE.guestbookPrompt,
        guestbookGalleryVisible: EVENT_FIXTURE.galleryVisible,
        errorCode: null,
      };
      await stubManagerRoutes(page, {
        mediaPages: { first: { media: [], nextCursor: null } },
        event: { storedMediaCount: 4, storedBytes: 512 },
        exports: [runningExport],
      });
      const exportsResponse = page.waitForResponse((response) => (
        response.request().method() === 'GET'
        && new URL(response.url()).pathname
          === `/api/manage/events/${EVENT_FIXTURE.id}/exports`
      ));
      await openManagerSection(page, 'Share');
      await exportsResponse;
    },
    async ready(page) {
      await readyHeading(page, 'Share your event');
      await expect(page.getByText('Event link', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Show full event link' })).toBeVisible();
      await expect(page.getByRole('region', { name: 'Event entry controls' })).toBeVisible();
      const progress = page.getByRole('region', { name: 'Export progress' });
      await expect(progress).toContainText('Complete export · Running');
      await expect(progress).toContainText('2 of 4 photos processed');
      await expect(progress.getByRole('button', { name: 'Open Gallery' })).toBeVisible();
    },
  },
  {
    name: 'Settings',
    async setup(page) {
      await stubManagerRoutes(page, {
        mediaPages: { first: { media: [], nextCursor: null } },
      });
      await openManagerSection(page, 'Settings');
    },
    async ready(page) {
      await readyHeading(page, /^Settings$/u);
      await expect(page.getByRole('textbox', { name: 'Event name', exact: true }))
        .toHaveValue(EVENT_FIXTURE.name);
    },
  },
  {
    name: 'Album-leave prompt',
    async setup(page) {
      const rows = makeAxeAlbumMedia();
      await stubManagerRoutes(page, {
        mediaPages: { first: { media: rows, nextCursor: null } },
        event: { storedMediaCount: rows.length },
        album: axeAlbumRouteState(rows),
      });
      await openGalleryMode(page, 'Album');
      await readyHeading(page, 'The order people with the Album link will see');
      const title = page.getByLabel('Album title');
      await title.fill('');
      await expect(title).toHaveAttribute('aria-invalid', 'true');
      await page.getByRole('group', { name: 'Gallery mode' })
        .getByRole('button', { name: 'Library', exact: true }).click();
    },
    async ready(page) {
      const prompt = page.getByRole('region', { name: 'Album changes are not saved yet' });
      await expect(prompt).toBeFocused();
      await expect(prompt.getByRole('status'))
        .toHaveText('Album title needs attention before the Album can be confirmed.');
      await expect(prompt.getByRole('button', { name: 'Stay in Album' })).toBeVisible();
      await expect(prompt.getByRole('button', {
        name: 'Discard unsent Album changes and leave',
      })).toBeVisible();
    },
  },
  {
    name: 'Rotate management link confirmation',
    async setup(page) {
      await openManagerLinkRotationConfirmation(page);
    },
    async ready(page) {
      await readyModal(page, 'dialog', 'Rotate management link?');
      const dialog = page.getByRole('dialog', { name: 'Rotate management link?' });
      await expect(dialog.getByRole('button', { name: 'Keep current link' })).toBeFocused();
      await expect(dialog.getByRole('button', { name: 'Rotate link' })).toBeEnabled();
      await expect(dialog).toContainText('The current management link will stop working immediately.');
      await expect(dialog).toContainText('You must save the replacement before continuing.');
    },
  },
  {
    name: 'Rotate management link sensitive result',
    async setup(page) {
      await openManagerLinkRotationConfirmation(page);
      await page.getByRole('dialog', { name: 'Rotate management link?' })
        .getByRole('button', { name: 'Rotate link' }).click();
    },
    async ready(page) {
      await readyModal(page, 'dialog', 'Save your new management link');
      const dialog = page.getByRole('dialog', { name: 'Save your new management link' });
      await expect(dialog.getByText('The prior management link is no longer valid.')).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Copy management link' })).toBeFocused();
      await expect(dialog.getByRole('button', { name: 'Continue managing' })).toBeDisabled();
      await expect(dialog.getByRole('textbox', { name: 'Management link' })).toHaveCount(0);
      await expect(dialog.getByText(ROTATED_MANAGEMENT_LINK, { exact: true })).toHaveCount(0);
      await expect(dialog.locator('.link-card__mask')).toBeVisible();
    },
  },
  {
    name: 'RSVP pending-work prompt',
    async setup(page) {
      await stubManagerRoutes(page, {
        mediaPages: { first: { media: [], nextCursor: null } },
      });
      await openManagerSection(page, 'RSVP');
      await readyHeading(page, 'Guest list and RSVPs');
      await page.getByRole('button', { name: 'Add guests' }).click();
      await readyHeading(page, 'Add guests');
      await page.getByLabel('Guest names or spreadsheet data').fill('Avery Lee');
      await page.getByRole('navigation', { name: 'Manager sections' })
        .getByRole('button', { name: 'Gallery' }).click();
    },
    async ready(page) {
      const prompt = page.getByRole('region', { name: 'Your pending work is not saved' });
      await expect(prompt.getByRole('heading', { name: 'Your pending work is not saved' }))
        .toBeVisible();
      await expect(prompt).toBeFocused();
    },
  },
  {
    name: 'Settings pending-work prompt',
    async setup(page) {
      await stubManagerRoutes(page, {
        mediaPages: { first: { media: [], nextCursor: null } },
      });
      await openManagerSection(page, 'Settings');
      await readyHeading(page, /^Settings$/u);
      await page.getByRole('textbox', { name: 'Event name', exact: true }).fill('');
      await expect(page.getByRole('region', { name: 'Unsaved settings' })).toBeVisible();
      await page.getByRole('navigation', { name: 'Manager sections' })
        .getByRole('button', { name: 'Gallery' }).click();
    },
    async ready(page) {
      const prompt = page.getByRole('region', { name: 'Event settings is not saved yet' });
      await expect(prompt).toContainText(
        'A change already sent may still finish saving after you leave. Leaving now discards anything that has not been sent.',
      );
      await expect(prompt).toBeFocused();
    },
  },
  {
    name: 'Move to Recently deleted dialog',
    async setup(page) {
      const media = makeMedia(1);
      await stubManagerRoutes(page, {
        mediaPages: { first: { media, nextCursor: null } },
        event: { storedMediaCount: media.length },
      });
      await openManagerSection(page, 'Intake');
      const row = page.locator('.intake-grid article').first();
      await expect(row).toBeVisible();
      const move = row.getByRole('button', {
        name: `Move ${media[0]!.originalFilename} to Recently deleted`,
      });
      await expect(move).toBeEnabled();
      await move.click();
    },
    async ready(page) {
      await readyModal(page, 'dialog', 'Move this photo to Recently deleted?');
      const dialog = page.getByRole('dialog', { name: 'Move this photo to Recently deleted?' });
      await expect(dialog.getByRole('button', { name: 'Keep photo' })).toBeFocused();
    },
  },
  {
    name: 'Entry rotation confirmation',
    async setup(page) {
      await stubManagerRoutes(page, {
        mediaPages: { first: { media: [], nextCursor: null } },
      });
      await openManagerSection(page, 'Share');
      const entryControls = page.getByRole('region', { name: 'Event entry controls' });
      await expect(entryControls).toBeVisible();
      await entryControls.getByRole('button', { name: 'Sign out guest devices', exact: true }).click();
    },
    async ready(page) {
      const confirmation = page.locator('fieldset').filter({
        has: page.locator('legend').filter({ hasText: 'Sign out guest devices' }),
      });
      await expect(confirmation).toBeVisible();
      await expect(confirmation.locator('legend')).toHaveText('Sign out guest devices');
      await expect(confirmation.getByRole('textbox', { name: 'Confirm event name' })).toBeVisible();
      await expect(confirmation.getByRole('button', {
        name: `Sign out guest devices for ${EVENT_FIXTURE.name}`,
      })).toBeDisabled();
      await expect(page.getByRole('dialog')).toHaveCount(0);
    },
  },
  {
    name: 'Entry disable confirmation',
    async setup(page) {
      await stubManagerRoutes(page, {
        mediaPages: { first: { media: [], nextCursor: null } },
      });
      await openManagerSection(page, 'Share');
      const entryControls = page.getByRole('region', { name: 'Event entry controls' });
      await expect(entryControls).toBeVisible();
      await entryControls.getByRole('button', { name: 'Disable printed event QR', exact: true }).click();
    },
    async ready(page) {
      const confirmation = page.locator('fieldset').filter({
        has: page.locator('legend').filter({ hasText: 'Disable printed event QR' }),
      });
      await expect(confirmation).toBeVisible();
      await expect(confirmation.locator('legend')).toHaveText('Disable printed event QR');
      await expect(confirmation.getByRole('textbox', { name: 'Confirm event name' })).toBeVisible();
      await expect(confirmation.getByRole('button', {
        name: `Disable printed event QR for ${EVENT_FIXTURE.name}`,
      })).toBeDisabled();
      await expect(page.getByRole('dialog')).toHaveCount(0);
    },
  },
];

for (const fixture of MANAGER_AXE_FIXTURES) {
  test(`${fixture.name} is axe-clean`, async ({ page }) => {
    await scanManagerFixture(page, fixture);
  });
}

const PAUSED_GUEST_EVENT = {
  uploadsEnabled: false,
  phase: 'waiting',
  guestReadSurfaces: { available: true, reason: null },
} satisfies Partial<GuestEventView>;

const PAUSED_GUEST_NOTE = {
  id: 'paused-axe-note',
  guestName: 'Avery',
  body: 'The shared celebration remains available while new uploads are paused.',
  moderationStatus: 'approved',
  createdAt: '2026-09-19T23:00:00Z',
} as const;

async function scanGuestFixture(page: Page, fixture: GuestAxeFixture) {
  await installViteRefreshGlobals(page);
  await fixture.setup(page);
  await fixture.ready(page);
  await expectNoAxeViolations(page, fixture.name);
}

const GUEST_AXE_FIXTURES: GuestAxeFixture[] = [
  (() => {
    const gallery = makeMedia(3, 'published');
    const contributions = makeMedia(1);
    return {
      name: 'paused guest main page',
      async setup(page) {
        await stubGuestRoutes(page, {
          event: PAUSED_GUEST_EVENT,
          gallery,
          contributions,
          messages: [PAUSED_GUEST_NOTE],
        });
        await page.goto(`/event/${EVENT_FIXTURE.slug}`);
        await page.locator('details.guestbook summary').click();
        await page.locator('details.event-extra').filter({ hasText: 'Shared gallery' })
          .locator('summary').click();
        await page.locator('details.event-extra').filter({ hasText: 'My deliveries' })
          .locator('summary').click();
      },
      async ready(page) {
        await readyHeading(page, 'New guest uploads are paused');
        await expect(page.getByRole('button', { name: 'Take a photo', exact: true }))
          .toHaveCount(0);
        await expect(page.locator('details.guestbook')).toHaveAttribute('open', '');
        await expect(page.getByText(PAUSED_GUEST_NOTE.body)).toBeVisible();
        await expect(page.locator('.photo-grid figure')).toHaveCount(gallery.length);
        await expect(page.locator('.contributions li')).toHaveCount(contributions.length);
      },
    } satisfies GuestAxeFixture;
  })(),
  (() => {
    const gallery = makeMedia(3, 'published');
    return {
      name: 'paused guest fullscreen',
      async setup(page) {
        await stubGuestRoutes(page, { event: PAUSED_GUEST_EVENT, gallery });
        await page.goto(`/event/${EVENT_FIXTURE.slug}/fullscreen`);
      },
      async ready(page) {
        await readyHeading(page, `Shared gallery · ${EVENT_FIXTURE.name}`);
        await expect(page.locator('.fullscreen__grid figure')).toHaveCount(gallery.length);
        await expect(page.getByRole('link', { name: 'Close full-screen gallery' })).toBeVisible();
        await expect(page.locator('details.guestbook')).toHaveCount(0);
        await expect(page.getByText(/My deliveries/u)).toHaveCount(0);
      },
    } satisfies GuestAxeFixture;
  })(),
];

for (const fixture of GUEST_AXE_FIXTURES) {
  test(`${fixture.name} is axe-clean`, async ({ page }) => {
    await scanGuestFixture(page, fixture);
  });
}

const HOST_AXE_SESSION = {
  account: {
    id: 'account-axe',
    email: 'host@example.test',
    displayName: 'Axe Host',
    emailVerified: true,
    notificationsEnabled: true,
  },
  events: [
    {
      id: 'event-gallery-dinner',
      name: 'Gallery Dinner',
      slug: 'gallery-dinner',
      eventDate: '2027-01-02',
      eventTimezone: 'Pacific/Auckland',
      storedMediaCount: 40,
      managementAccessExpiresAt: '2027-01-03T10:30:00.000Z',
    },
    {
      id: 'event-other',
      name: 'Studio Reception',
      slug: 'studio-reception',
      eventDate: '2026-09-19',
      eventTimezone: 'America/Chicago',
      storedMediaCount: 12,
      managementAccessExpiresAt: '2026-09-20T00:30:00.000Z',
    },
    {
      id: 'event-gallery-picnic',
      name: 'Gallery Picnic',
      slug: 'gallery-picnic',
      eventDate: '2025-06-01',
      eventTimezone: 'Europe/London',
      storedMediaCount: 3,
      managementAccessExpiresAt: '2025-06-01T23:30:00.000Z',
    },
  ],
} satisfies HostSessionResponse;

const HOST_AXE_FIXTURES: HostAxeFixture[] = [
  {
    name: 'pending registration route',
    async setup(page) {
      await page.addInitScript(() => {
        localStorage.setItem('candidary.pending-registration.v1', JSON.stringify({
          version: 1,
          emailDigest: '61c0ee79db216f84107d8d2d7bfb35266f66b06773a99a0786e3a173ffe920ee',
          expiresAt: '2099-01-01T00:15:00.000Z',
        }));
      });
      await page.goto('/host/register?pending=1');
    },
    async ready(page) {
      await readyHeading(page, 'Check your email.');
      await expect(page.getByRole('textbox', { name: 'Confirmation code' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Confirm my email' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Start over' })).toBeVisible();
      await expect(page.getByText('Until you enter it, no account exists.', { exact: false }))
        .toBeVisible();
    },
  },
  {
    name: 'Host Events search and sort',
    async setup(page) {
      await page.route('**/api/host/session', (route) => route.fulfill({
        headers: { 'cache-control': 'private, no-store' },
        json: { data: HOST_AXE_SESSION, requestId: 'request-host-events-axe' },
      }));
      await page.goto('/host/events');
      await readyHeading(page, 'Your events');
      await page.getByRole('searchbox', { name: 'Search events' }).fill('gallery');
      await page.getByRole('combobox', { name: 'Sort events' }).selectOption('oldest');
    },
    async ready(page) {
      await expect(page.getByRole('searchbox', { name: 'Search events' })).toHaveValue('gallery');
      await expect(page.getByRole('combobox', { name: 'Sort events' })).toHaveValue('oldest');
      await expect(page.getByRole('status')).toHaveText('2 events');
      const events = page.locator('.host-event-list > li');
      await expect(events).toHaveCount(2);
      await expect(events.nth(0)).toContainText('Gallery Picnic');
      await expect(events.nth(1)).toContainText('Gallery Dinner');
    },
  },
];

for (const fixture of HOST_AXE_FIXTURES) {
  test(`${fixture.name} is axe-clean`, async ({ page }) => {
    await installViteRefreshGlobals(page);
    await fixture.setup(page);
    await fixture.ready(page);
    await expectNoAxeViolations(page, fixture.name);
  });
}

async function scanPublicAlbumFixture(page: Page, fixture: PublicAlbumAxeFixture) {
  try {
    await installViteRefreshGlobals(page);
    await fixture.setup(page);
    await fixture.ready(page);
    await expectNoAxeViolations(page, fixture.name);
  } finally {
    await fixture.cleanup?.(page);
  }
}

async function readyPublicAlbumMedia(scope: Locator, label: string) {
  const media = scope.getByRole('img', { name: label, exact: true });
  await expect.poll(async () => {
    if (await media.count() !== 1 || !await media.isVisible()) return 'pending';
    const rendered = await media.evaluate((element) => {
      if (element instanceof HTMLImageElement) {
        return element.complete && element.naturalWidth > 0 ? 'decoded image' : 'pending';
      }
      return element instanceof HTMLElement
        && element.classList.contains('public-album__preview-fallback')
        ? 'preview fallback'
        : 'pending';
    });
    if (rendered !== 'preview fallback') return rendered;
    return await media.getByText('Preview unavailable', { exact: true }).isVisible()
      ? rendered
      : 'pending';
  }, { message: `${label} is a decoded image or its labelled preview fallback` })
    .toMatch(/^(decoded image|preview fallback)$/u);
}

const PUBLIC_ALBUM_AXE_FIXTURES: PublicAlbumAxeFixture[] = [
  (() => {
    const rows = makeMedia(2, 'published').map((row, index) => ({
      ...row,
      id: `00000000-0000-4000-8500-${String(index + 1).padStart(12, '0')}`,
      originalFilename: `axe-public-nonempty-${index + 1}.jpg`,
      caption: index === 0 ? 'Lantern portraits' : 'Last dance',
    }));
    const shareToken = 'axe-public-nonempty-id.axe-public-nonempty-secret';
    return {
      name: 'Public Album nonempty',
      async setup(page) {
        await stubManagerRoutes(page, {
          mediaPages: { first: { media: rows, nextCursor: null } },
          album: {
            shareActive: true,
            shareToken,
            pickedMediaIds: rows.map(({ id }) => id),
            title: 'Axe public Album',
            description: 'Two published moments from the evening.',
            coverMediaId: rows[0]!.id,
            entries: [
              { kind: 'photo', mediaId: rows[0]!.id },
              { kind: 'section', id: 'axe-public-dancing', heading: 'Dancing' },
              { kind: 'photo', mediaId: rows[1]!.id },
            ],
          },
        });
        await page.goto(`/album#${shareToken}`);
      },
      async ready(page) {
        await expect(page).toHaveURL((url) => (
          url.pathname === '/album' && url.search === '' && url.hash === ''
        ));
        await expect(page.getByRole('heading', { level: 1, name: 'Axe public Album' }))
          .toBeVisible();
        await readyPublicAlbumMedia(
          page.locator('.public-album__intro'),
          'Cover for Axe public Album',
        );
        await expect(page.getByText('2 photos', { exact: true })).toBeVisible();
        await expect(page.getByRole('heading', { level: 2, name: 'Dancing' })).toBeVisible();
        const figures = page.locator('.public-album__photo');
        await expect(figures).toHaveCount(2);
        const lanternPortraits = figures.filter({
          has: page.locator('figcaption', { hasText: /^Lantern portraits$/u }),
        });
        await expect(lanternPortraits).toHaveCount(1);
        await expect(lanternPortraits.locator('figcaption')).toHaveText('Lantern portraits');
        await readyPublicAlbumMedia(lanternPortraits, 'Lantern portraits');
        const lastDance = figures.filter({
          has: page.locator('figcaption', { hasText: /^Last dance$/u }),
        });
        await expect(lastDance).toHaveCount(1);
        await expect(lastDance.locator('figcaption')).toHaveText('Last dance');
        await readyPublicAlbumMedia(lastDance, 'Last dance');
      },
    } satisfies PublicAlbumAxeFixture;
  })(),
  (() => {
    const shareToken = 'axe-public-empty-id.axe-public-empty-secret';
    return {
      name: 'Public Album empty',
      async setup(page) {
        await stubManagerRoutes(page, {
          mediaPages: { first: { media: [], nextCursor: null } },
          album: {
            shareActive: true,
            shareToken,
            pickedMediaIds: [],
            title: 'Axe empty Album',
            description: 'The host has not added any photos yet.',
            coverMediaId: null,
            entries: [],
          },
        });
        await page.goto(`/album#${shareToken}`);
      },
      async ready(page) {
        await expect(page).toHaveURL((url) => (
          url.pathname === '/album' && url.search === '' && url.hash === ''
        ));
        await expect(page.getByRole('heading', { level: 1, name: 'Axe empty Album' }))
          .toBeVisible();
        await expect(page.getByText('0 photos', { exact: true })).toBeVisible();
        await expect(page.getByText('No photos in this Album yet.', { exact: true })).toBeVisible();
        await expect(page.locator('.public-album__photo')).toHaveCount(0);
      },
    } satisfies PublicAlbumAxeFixture;
  })(),
];

for (const fixture of PUBLIC_ALBUM_AXE_FIXTURES) {
  test(`${fixture.name} is axe-clean`, async ({ page }) => {
    await scanPublicAlbumFixture(page, fixture);
  });
}

test('Slice 5 named Axe inventories are exact and unique', () => {
  expect(MANAGER_AXE_FIXTURES.map(({ name }) => name))
    .toEqual([...REQUIRED_MANAGER_AXE_FIXTURES]);
  expect(GUEST_AXE_FIXTURES.map(({ name }) => name))
    .toEqual([...REQUIRED_GUEST_AXE_FIXTURES]);
  expect(HOST_AXE_FIXTURES.map(({ name }) => name))
    .toEqual([...REQUIRED_HOST_AXE_FIXTURES]);
  expect(PUBLIC_ALBUM_AXE_FIXTURES.map(({ name }) => name))
    .toEqual([...REQUIRED_PUBLIC_ALBUM_AXE_FIXTURES]);
  expect(new Set(MANAGER_AXE_FIXTURES.map(({ name }) => name)).size)
    .toBe(REQUIRED_MANAGER_AXE_FIXTURES.length);
  expect(new Set(GUEST_AXE_FIXTURES.map(({ name }) => name)).size)
    .toBe(REQUIRED_GUEST_AXE_FIXTURES.length);
  expect(new Set(HOST_AXE_FIXTURES.map(({ name }) => name)).size)
    .toBe(REQUIRED_HOST_AXE_FIXTURES.length);
  expect(new Set(PUBLIC_ALBUM_AXE_FIXTURES.map(({ name }) => name)).size)
    .toBe(REQUIRED_PUBLIC_ALBUM_AXE_FIXTURES.length);
  const allNames = [
    ...MANAGER_AXE_FIXTURES,
    ...GUEST_AXE_FIXTURES,
    ...HOST_AXE_FIXTURES,
    ...PUBLIC_ALBUM_AXE_FIXTURES,
  ].map(({ name }) => name);
  expect(new Set(allNames).size).toBe(allNames.length);
});

test('Manager upload terminal expiry closes through terminal handoff without claiming cancellation', async ({ page }) => {
  await installViteRefreshGlobals(page);
  const cancelRequests: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'DELETE' && path.includes('/uploads/')) cancelRequests.push(path);
  });
  await stubManagerRoutes(page, {
    event: { managerLinkRevision: null },
    mediaPages: { first: { media: [], nextCursor: null } },
    uploads: {
      contentFailure: {
        status: 410,
        code: 'EVENT_EXPIRED',
        message: 'This event access has expired.',
      },
    },
  });
  await page.goto(`/manage/event/${EVENT_FIXTURE.id}`);
  await page.getByRole('button', { name: 'Add photos' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add photos' });
  await dialog.locator('input[data-photo-source="library"]').setInputFiles({
    name: 'expired-manager-upload.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from('expired-manager-upload'),
  });
  await dialog.getByRole('button', { name: 'Send 1 photo' }).click();

  await expect(dialog).toHaveCount(0);
  const notice = page.getByRole('region', { name: 'Manager notice' });
  await expect(notice).toContainText('This event access has expired.');
  await expect(page.getByRole('button', { name: 'Add photos' })).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByText(/cancell?ed/iu)).toHaveCount(0);
  expect(cancelRequests).toEqual([]);
});

function animationName(locator: Locator) {
  return locator.evaluate((element) => getComputedStyle(element).animationName);
}

function outline(locator: Locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
  });
}

test('public actions and creation fields are keyboard reachable with named landmarks', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('banner')).toBeVisible();
  await expect(page.getByRole('main')).toBeVisible();
  // The landing page now carries a footer that repeats `How it works`, `Sign in` and
  // `Create an event`, so every exit here is resolved inside the banner rather than page-wide.
  const header = page.getByRole('banner');
  await page.keyboard.press('Tab');
  await expect(header.getByRole('link', { name: 'Candidary home' })).toBeFocused();
  // `How it works` is the one header exit whose presence varies by width: visible above 760px,
  // hidden below it, where `Sign in` takes its room. This spec runs in the desktop *and* mobile
  // projects, so the tab order is asserted against what is actually on screen rather than against
  // one project's width.
  const wayfinding = header.getByRole('link', { name: 'How it works', exact: true });
  if (await wayfinding.isVisible()) {
    await page.keyboard.press('Tab');
    await expect(wayfinding).toBeFocused();
  }
  await page.keyboard.press('Tab');
  await expect(header.getByRole('link', { name: 'Sign in', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(header.getByRole('link', { name: 'Create an event', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Create your event', exact: true })).toBeFocused();
  await page.goto('/create');
  await expect(page.getByLabel('Event name')).toHaveAttribute('required', '');
  await expect(page.getByLabel('Event date')).toHaveAttribute('type', 'date');
  await expect(page.getByLabel('Welcome message')).toHaveAttribute('maxlength', '500');
});

test('every public header exit stays visible and mobile-sized across the width matrix', async ({ page }) => {
  for (const width of HEADER_WIDTHS) {
    await page.setViewportSize({ width, height: 844 });
    for (const { path, names } of headerExits(width)) {
      await page.goto(path);
      const header = page.getByRole('banner');
      // Hiding an exit strands the visitor; adding one is unapproved navigation. Both fail here.
      await expect(header.getByRole('link'), `${path} header exits at ${width}`).toHaveCount(names.length);

      for (const name of names) {
        const link = header.getByRole('link', { name, exact: true });
        await expect(link, `${name} on ${path} at ${width}`).toBeVisible();
        const target = await measureTarget(link);
        expect(target.width, `${name} width on ${path} at ${width}`).toBeGreaterThanOrEqual(44);
        expect(target.height, `${name} height on ${path} at ${width}`).toBeGreaterThanOrEqual(44);
      }

      // Exits that touch are one mis-tap apart. Once a third exit joins the row the tightest pair is
      // no longer the outermost two — `Sign in` and `Create an event` sit together in the right-hand
      // group, far from the brand — so every neighbouring pair is measured instead of first-to-last.
      const exits = await header.getByRole('link').all();
      for (let index = 1; index < exits.length; index += 1) {
        const separation = await measureSeparation(exits[index - 1]!, exits[index]!);
        expect(separation, `${names[index - 1]} and ${names[index]} stay apart on ${path} at ${width}`)
          .toBeGreaterThanOrEqual(8);
      }

      const documentSize = await measureDocument(page);
      expect(documentSize.scrollWidth, `${path} contained at ${width}`)
        .toBeLessThanOrEqual(documentSize.clientWidth + 1);
    }
  }
});

test('cover photo focus lands on the control the host can actually see', async ({ page }) => {
  await page.goto('/create');
  const field = page.locator('.cover-field');
  const input = page.locator('.cover-field__input');
  await expect(field).toBeVisible();
  await expect(input).toHaveAttribute('type', 'file');

  const target = await measureTarget(field);
  expect(target.width, 'cover control width').toBeGreaterThanOrEqual(44);
  expect(target.height, 'cover control height').toBeGreaterThanOrEqual(44);

  await page.getByLabel('Welcome message').focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('radio', { name: /Candidary Default/u })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(input).toBeFocused();

  const visibleRing = await outline(field);
  expect(visibleRing.style, 'the visible cover control draws the focus ring').toBe('solid');
  expect(visibleRing.width, 'focus ring width').toBeGreaterThanOrEqual(2);

  const hiddenRing = await outline(input);
  expect(hiddenRing.style, 'no ring on the control the host cannot see').toBe('none');
  expect(hiddenRing.width).toBe(0);
});

test('guest photo sources have mobile-sized targets and name errors focus the field', async ({ page }) => {
  await page.route('**/api/event/maya-theo', (route) => route.fulfill({ json: { data: { event: {
    id: 'event-a', slug: 'maya-theo', name: 'Maya & Theo', eventDate: '2026-09-19', welcomeMessage: 'Help us remember tonight.',
    guestbookPrompt: 'Share a wish, memory, or moment from the day.',
    uploadsEnabled: true, galleryVisible: false, moderationRequired: true,
    cover: { revision: 0, hasCover: false, available2xProfiles: [], surfaceTreatment: 'none' },
    eventTimezone: 'America/Chicago', eventStartAt: '2026-09-19T22:00:00.000Z',
    rsvpDeadlineAt: null, rsvpDeadlineDate: null, phase: 'photos-primary', rsvpState: 'disabled',
    rsvpAccess: 'unavailable', lifecycleRecheckAfterMs: null,
    theme: eventTheme('candidary-default'),
  }, role: 'guest' }, requestId: 'r' } }));
  await page.route('**/api/event/maya-theo/contributions', (route) => route.fulfill({ json: { data: { media: [] }, requestId: 'r' } }));
  await page.route('**/api/event/maya-theo/messages', (route) => route.fulfill({ json: { data: { items: [] }, requestId: 'r' } }));
  await page.goto('/event/maya-theo');

  const camera = page.getByRole('button', { name: 'Take a photo', exact: true });
  const library = page.getByRole('button', { name: 'Choose recent photos', exact: true });
  for (const target of [camera, library]) {
    await expect.poll(async () => (await target.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    await expect.poll(async () => (await target.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(44);
  }
  await camera.click();
  await expect(page.getByLabel('Your name')).toBeFocused();
  await expect(page.getByText('Enter your name before adding photos.')).toHaveAttribute('role', 'alert');
});

test('guest RSVP lookup and household editor are semantic, touch-sized, focus-correct, and axe-clean', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubGuestRoutes(page, {
    event: {
      uploadsEnabled: false,
      phase: 'rsvp-primary',
      rsvpState: 'open',
      rsvpAccess: 'editable',
      rsvpDeadlineAt: RSVP_HOUSEHOLD_FIXTURE.deadlineAt,
      rsvpDeadlineDate: '2026-09-05',
    },
    lookup: { status: 'matched', household: RSVP_HOUSEHOLD_FIXTURE },
  });

  await page.goto(`/event/${EVENT_FIXTURE.slug}`);
  const name = page.getByLabel('Full name');
  await expect(name).toBeVisible();
  await expect(name).toHaveAttribute('autocomplete', 'name');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expectNoAxeViolations(page, 'guest RSVP lookup');

  await name.fill('Taylor Morgan');
  await page.getByRole('button', { name: 'Find my invitation' }).click();
  await expect(page.getByRole('heading', { name: 'Your household RSVP' })).toBeVisible();
  const householdGroups = page.locator('.rsvp-household form').getByRole('group');
  await expect(householdGroups).toHaveCount(3);
  for (const fieldset of await householdGroups.all()) {
    for (const label of ['Attending', 'Not attending']) {
      const radio = fieldset.getByRole('radio', { name: label, exact: true });
      await expect(radio).toHaveAccessibleName(label);
      const target = await measureTarget(radio.locator('..'));
      expect(target.width).toBeGreaterThanOrEqual(44);
      expect(target.height).toBeGreaterThanOrEqual(44);
    }
  }
  await expectNoAxeViolations(page, 'guest RSVP household editor');

  await page.getByRole('button', { name: 'Submit RSVP' }).click();
  const first = page.getByRole('group', { name: 'Taylor Morgan' })
    .getByRole('radio', { name: 'Attending', exact: true });
  await expect(first).toBeFocused();
  const describedBy = await first.getAttribute('aria-describedby');
  expect(describedBy).toBeTruthy();
  await expect(page.locator(`[id="${describedBy}"]`)).toHaveText('Choose attending or not attending.');
});

test('RSVP ambiguity, conflict, receipt, and keyboard-only operation stay announced and focused', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let ambiguous = true;
  let refused = false;
  const winner = {
    ...RSVP_HOUSEHOLD_FIXTURE,
    version: 9,
    invitees: [
      ...RSVP_HOUSEHOLD_FIXTURE.invitees,
      {
        id: '55555555-5555-4555-8555-555555555555',
        kind: 'named' as const,
        displayName: 'Robin Morgan',
        attendance: 'pending' as const,
        order: 3,
      },
    ],
  };
  await stubGuestRoutes(page, {
    event: {
      uploadsEnabled: false,
      phase: 'rsvp-primary',
      rsvpState: 'open',
      rsvpAccess: 'editable',
      rsvpDeadlineAt: RSVP_HOUSEHOLD_FIXTURE.deadlineAt,
      rsvpDeadlineDate: '2026-09-05',
    },
  });
  await page.route(`**/api/event/${EVENT_FIXTURE.slug}/rsvp/lookup`, (route) => {
    if (ambiguous) {
      ambiguous = false;
      return route.fulfill({ json: { data: { status: 'second_name_required' }, requestId: 'r' } });
    }
    return route.fulfill({
      json: { data: { status: 'matched', household: RSVP_HOUSEHOLD_FIXTURE }, requestId: 'r' },
    });
  });
  await page.route(`**/api/event/${EVENT_FIXTURE.slug}/rsvp/household`, (route) => {
    if (route.request().method() !== 'PUT') {
      return refused
        ? route.fulfill({ json: { data: { household: winner }, requestId: 'r' } })
        : route.fulfill({
            status: 401,
            json: { code: 'RSVP_SESSION_REQUIRED', message: 'Find your invitation to continue.', requestId: 'r' },
          });
    }
    refused = true;
    return route.fulfill({
      status: 409,
      json: { code: 'RSVP_HOUSEHOLD_CONFLICT', message: 'This invitation changed.', requestId: 'r' },
    });
  });

  await page.goto(`/event/${EVENT_FIXTURE.slug}`);
  // Keyboard only: reach the name field and the action without a pointer.
  const firstName = page.getByLabel('Full name');
  let tabs = 0;
  while (tabs < 8 && !await firstName.evaluate((element) => element === document.activeElement)) {
    await page.keyboard.press('Tab');
    tabs += 1;
  }
  expect(tabs, 'the lookup field is a few tabs from the top of the page').toBeLessThan(8);
  await expect(firstName).toBeFocused();
  await page.keyboard.type('Alex Lee');
  await page.keyboard.press('Enter');

  const second = page.getByLabel('Another full name');
  await expect(second, 'ambiguity moves focus to the second name').toBeFocused();
  const status = page.locator('.rsvp-status');
  await expect(status).toHaveAttribute('aria-live', 'polite');
  await expect(status).toHaveText('Enter the full name of another person on this invitation.');
  await expectNoAxeViolations(page, 'guest RSVP ambiguity');

  await page.keyboard.type('Taylor Morgan');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Your household RSVP' })).toBeVisible();
  for (const invitee of RSVP_HOUSEHOLD_FIXTURE.invitees) {
    const name = invitee.kind === 'named' ? invitee.displayName! : 'Plus one 1';
    await page.getByRole('group', { name, exact: true })
      .getByRole('radio', { name: 'Not attending', exact: true }).check();
  }
  await page.getByRole('button', { name: 'Submit RSVP' }).click();

  const review = page.getByRole('heading', { name: 'Review updated household' });
  await expect(review, 'a conflict returns the respondent to the top of the winning roster').toBeFocused();
  await expectNoAxeViolations(page, 'guest RSVP conflict review');
});

test('the saved RSVP receipt is announced, contained, and axe-clean', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubGuestRoutes(page, {
    event: {
      uploadsEnabled: false,
      phase: 'rsvp-primary',
      rsvpState: 'open',
      rsvpAccess: 'editable',
      rsvpDeadlineAt: RSVP_HOUSEHOLD_FIXTURE.deadlineAt,
      rsvpDeadlineDate: '2026-09-05',
    },
    household: {
      ...RSVP_HOUSEHOLD_FIXTURE,
      invitees: RSVP_HOUSEHOLD_FIXTURE.invitees.map((invitee, index) => ({
        ...invitee,
        attendance: index === 1 ? ('declined' as const) : ('attending' as const),
        displayName: invitee.kind === 'plus_one' ? 'Jamie Rivera' : invitee.displayName,
      })),
      firstRespondedAt: '2026-08-01T00:00:00Z',
      latestRespondedAt: '2026-08-01T00:00:00Z',
      latestActor: 'household' as const,
    },
  });
  await page.goto(`/event/${EVENT_FIXTURE.slug}`);

  const receipt = page.locator('.rsvp-flow--receipt .rsvp-receipt');
  await expect(receipt).toHaveAttribute('aria-live', 'polite');
  await expect(page.getByRole('heading', { name: "You're all set" })).toBeVisible();
  await expect(page.getByText('2 attending · 1 not attending')).toBeVisible();
  const change = page.getByRole('button', { name: 'Change RSVP' });
  const target = await measureTarget(change);
  expect(target.width).toBeGreaterThanOrEqual(44);
  expect(target.height).toBeGreaterThanOrEqual(44);
  await expectNoAxeViolations(page, 'guest RSVP receipt');
});

test('reduced motion stops every guest spinner instead of racing it', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });

  let releaseEvent = () => {};
  const eventGate = new Promise<void>((resolve) => { releaseEvent = resolve; });
  let releaseBatch = () => {};
  const batchGate = new Promise<void>((resolve) => { releaseBatch = resolve; });
  const base = `**/api/event/${EVENT_FIXTURE.slug}`;

  await page.route(base, async (route) => {
    await eventGate;
    await route.fulfill({
      json: {
        data: { event: { ...EVENT_FIXTURE, theme: eventTheme('midnight-film') }, role: 'guest' },
        requestId: 'r',
      },
    });
  });
  await page.route(`${base}/contributions`, (route) => route.fulfill({ json: { data: { media: [] }, requestId: 'r' } }));
  await page.route(`${base}/messages`, (route) => route.fulfill({ json: { data: { items: [] }, requestId: 'r' } }));
  await page.route(`${base}/uploads/batch`, async (route) => {
    await batchGate;
    const payload = route.request().postDataJSON() as { files: Array<{ idempotencyKey: string }> };
    await route.fulfill({ status: 201, json: { data: { items: payload.files.map(({ idempotencyKey }) => ({
      idempotencyKey, status: 'rejected', error: { message: 'Reception dropped out. Try this photo again.' },
    })) }, requestId: 'r' } });
  });

  await page.goto(`/event/${EVENT_FIXTURE.slug}`);
  const appSpinner = page.locator('.spin');
  await expect(appSpinner).toBeVisible();
  expect(await animationName(appSpinner)).toBe('none');
  releaseEvent();

  await page.getByLabel('Your name').fill('Taylor Morgan');
  await page.locator('input[data-photo-source="library"]').setInputFiles({
    name: 'recent.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('recent-photo'),
  });
  await page.getByRole('button', { name: 'Send 1 photo' }).click();

  const cardSpinner = page.locator('.selection-card__spinner svg');
  await expect(cardSpinner).toBeVisible();
  expect(await animationName(cardSpinner)).toBe('none');

  const sendSpinner = page.locator('.send-button svg');
  await expect(sendSpinner).toBeVisible();
  expect(await animationName(sendSpinner)).toBe('none');

  releaseBatch();
  await expect(page.getByRole('button', { name: 'Retry 1 photo' })).toBeVisible();
});

test('manager navigation exposes visible labels, selected state, and mobile-sized targets', async ({ page }) => {
  const event = {
    ...EVENT_FIXTURE,
    welcomeMessage: 'Welcome.',
    galleryVisible: false,
    storedMediaCount: 0,
    storedBytes: 0,
  };
  await page.route('**/api/manage/events/event-a', (route) => route.fulfill({ json: { data: { event }, requestId: 'r' } }));
  await page.route('**/api/manage/events/event-a/media*', (route) => route.fulfill({ json: { data: { media: [] }, requestId: 'r' } }));
  await page.route('**/api/manage/events/event-a/messages', (route) => route.fulfill({ json: { data: { messages: [] }, requestId: 'r' } }));
  await page.route('**/api/manage/events/event-a/exports', (route) => route.fulfill({ json: { data: { exports: [] }, requestId: 'r' } }));
  await page.route('**/api/manage/events/event-a/entry', (route) => route.fulfill({ json: { data: { eventLink: 'https://candidary.test/join#entry-id.entry-secret', disabledAt: null }, requestId: 'r' } }));
  await page.goto('/manage/event/event-a');
  await expect(page.getByRole('heading', { name: 'Live intake' })).toBeVisible();

  const intake = page.getByRole('button', { name: 'Intake', exact: true });
  await expect(intake).toHaveAttribute('aria-pressed', 'true');
  for (const name of MANAGER_SECTIONS.map(({ name: destination }) => destination)) {
    const button = page.getByRole('button', { name, exact: true });
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    const label = button.locator('.manager-nav__label');
    await expect(label).toBeVisible();
    expect(await label.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThan(0);
    expect((await label.boundingBox())?.height ?? 0).toBeGreaterThan(0);
    // Measured from the colours the browser resolved, so a token that never reaches the label fails here.
    expect(await measureContrast(label), `${name} label contrast`).toBeGreaterThanOrEqual(4.5);
  }

  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Share', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(intake).toHaveAttribute('aria-pressed', 'false');
});

test('Pause and Resume guest uploads stay keyboard reachable and touch-sized at 390px and 320px', async ({ page }, testInfo) => {
  onlyOnce(testInfo);
  await stubManagerRoutes(page, {
    mediaPages: { first: { media: [], nextCursor: null } },
  });

  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`/manage/event/${EVENT_FIXTURE.id}`);
    await expect(page.getByRole('heading', { name: 'Live intake' })).toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();

    for (const name of ['Pause guest uploads', 'Resume guest uploads'] as const) {
      const control = page.getByRole('button', { name, exact: true });
      await expect(control).toBeVisible();
      await control.focus();
      await page.keyboard.press('Shift+Tab');
      await expect(control).not.toBeFocused();
      await page.keyboard.press('Tab');
      await expect(control).toBeFocused();

      const target = await measureTarget(control);
      expect(target.width, `${name} width at ${width}`).toBeGreaterThanOrEqual(44);
      expect(target.height, `${name} height at ${width}`).toBeGreaterThanOrEqual(44);
      await page.keyboard.press('Enter');
    }
  }
});

test('full-page manager recovery is labelled, associated, touch-sized, contained, and axe-clean', async ({ page }) => {
  await stubManagerRoutes(page, {
    event: { id: RECOVERY_EVENT_ID },
    mediaPages: { first: { media: [], nextCursor: null } },
  });
  await page.route(new RegExp(`/api/manage/events/${RECOVERY_EVENT_ID}$`, 'u'), (route) => route.fulfill({
    status: 401,
    json: { code: 'SESSION_EXPIRED', message: 'This session has expired.', requestId: 'request-a' },
  }));
  await page.goto(`/manage/event/${RECOVERY_EVENT_ID}`);

  const input = page.getByRole('textbox', { name: 'Management link' });
  await expect(input).toBeVisible();
  await expect(input).toHaveAttribute('autocomplete', 'off');
  await expect(input).toHaveAttribute('spellcheck', 'false');
  await input.fill('/manage/event');
  await page.getByRole('button', { name: 'Open event manager' }).click();
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  const errorId = await input.getAttribute('aria-describedby');
  expect(errorId, 'the visible validation message is field-associated').toBeTruthy();
  await expect(page.locator(`#${errorId}`)).toHaveText('Enter a Candidary management link.');

  for (const target of [
    page.getByRole('link', { name: 'Sign in' }),
    page.getByRole('button', { name: 'Open event manager' }),
  ]) {
    const size = await measureTarget(target);
    expect(size.width).toBeGreaterThanOrEqual(44);
    expect(size.height).toBeGreaterThanOrEqual(44);
  }
  for (const width of [320, 768]) {
    await page.setViewportSize({ width, height: 844 });
    const documentSize = await measureDocument(page);
    expect(documentSize.scrollWidth, `full-page recovery contained at ${width}`)
      .toBeLessThanOrEqual(documentSize.clientWidth + 1);
  }
  await expectNoAxeViolations(page, 'full-page manager recovery');
});

test('inline manager recovery keeps forms outside alerts and remains touch-sized, contained, and axe-clean', async ({ page }) => {
  let mediaRequests = 0;
  await stubManagerRoutes(page, {
    event: { id: RECOVERY_EVENT_ID },
    mediaPages: { first: { media: makeMedia(1), nextCursor: null } },
  });
  await page.route(`**/api/manage/events/${RECOVERY_EVENT_ID}/media*`, (route) => {
    mediaRequests += 1;
    return mediaRequests > 1
      ? route.fulfill({
        status: 401,
        json: { code: 'SESSION_EXPIRED', message: 'This session has expired.', requestId: 'request-a' },
      })
      : route.fallback();
  });
  await page.goto(`/manage/event/${RECOVERY_EVENT_ID}`);
  await expect(page.getByRole('heading', { name: 'Live intake' })).toBeVisible();
  await page.getByLabel('Filter by guest name').fill('Avery');
  await page.getByRole('button', { name: 'Filter' }).click();

  await expect(page.getByRole('alert')).toContainText('This session has expired.');
  await expect(page.getByRole('alert').locator('form')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Management link' })).toBeVisible();
  for (const target of [
    page.getByRole('link', { name: 'Sign in' }),
    page.getByRole('button', { name: 'Open event manager' }),
  ]) {
    const size = await measureTarget(target);
    expect(size.width).toBeGreaterThanOrEqual(44);
    expect(size.height).toBeGreaterThanOrEqual(44);
  }
  for (const width of [320, 768]) {
    await page.setViewportSize({ width, height: 844 });
    const documentSize = await measureDocument(page);
    expect(documentSize.scrollWidth, `inline recovery contained at ${width}`)
      .toBeLessThanOrEqual(documentSize.clientWidth + 1);
  }
  await expectNoAxeViolations(page, 'inline manager recovery');
});

test('the public surfaces carry no automated accessibility violation', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expectNoAxeViolations(page, 'landing');

  await page.goto('/create');
  await expect(page.getByLabel('Event name')).toBeVisible();
  await expectNoAxeViolations(page, 'create');

  // The success state is the same route with a different document: a QR aside, both private links,
  // and the reveal control. It is where the host's only copy of the management link lives.
  await page.route('**/api/events', (route) => route.fulfill({ status: 201, json: { data: {
    event: EVENT_FIXTURE,
    eventLink: UNBROKEN_TOKEN,
    managementLink: `${UNBROKEN_TOKEN}-manage`,
    csrfToken: 'csrf-a',
  }, requestId: 'request-a' } }));
  await page.getByLabel('Event name').fill('Maya & Theo');
  await page.getByLabel('Event date').fill('2026-09-19');
  await page.getByLabel('Welcome message').fill('Come share the moments you caught.');
  await page.getByRole('button', { name: 'Create private event' }).click();
  await expect(page.getByRole('heading', { name: 'Your event is ready.' })).toBeVisible();
  await page.getByRole('button', { name: 'Show full event link' }).click();
  await expect(page.locator('.link-card--expanded code')).toHaveCount(1);
  await expectNoAxeViolations(page, 'create success');
});

test('the guest surfaces carry no automated accessibility violation', async ({ page }) => {
  await stubGuestRoutes(page, {
    gallery: makeMedia(3),
    contributions: makeMedia(2),
    messages: [NOTE],
  });

  await page.goto(`/event/${EVENT_FIXTURE.slug}`);
  await expect(page.getByRole('heading', { name: EVENT_FIXTURE.welcomeMessage })).toBeVisible();
  await expectNoAxeViolations(page, 'guest hero');

  // The secondary disclosures are collapsed by default, so their content is outside the hero pass.
  for (const [summary, rendered] of [
    ['Shared gallery', '.photo-grid figure'],
    ['My deliveries', '.contributions li'],
    ['Guestbook', '.note-form textarea'],
  ] as const) {
    await page.locator('.event-extra summary').filter({ hasText: summary }).click();
    await expect(page.locator(rendered).first()).toBeVisible();
  }
  await expectNoAxeViolations(page, 'guest secondary content');

  await page.goto(`/event/${EVENT_FIXTURE.slug}/fullscreen`);
  await expect(page.locator('.fullscreen figure')).toHaveCount(3);
  await expectNoAxeViolations(page, 'fullscreen gallery');
});

/**
 * The manager private mosaic had no axe pass at all: the guest `.photo-grid` and the fullscreen
 * gallery were covered, and the surface the host actually reviews their photographs on was not.
 * That gap is why a clipped focus ring on the mosaic's primary control survived.
 */
test('the manager private gallery mosaic is axe-clean, shows keyboard focus, and contains its viewer', async ({ page }) => {
  await installViteRefreshGlobals(page);
  await stubManagerRoutes(page, { mediaPages: { first: { media: makeMedia(6), nextCursor: null } } });
  await page.goto(`/manage/event/${EVENT_FIXTURE.id}`);
  await page.locator('.manager-nav nav button').filter({ hasText: 'Gallery' }).click();

  await expect(page.locator('.gallery-mosaic__item')).toHaveCount(6);
  await expect(page.locator('.gallery-mosaic__item img').first()).toBeVisible();
  await expect(page.getByText('Preview unavailable')).toHaveCount(0);
  await expectNoAxeViolations(page, 'manager private gallery mosaic');

  // Reached by real Tab presses: `:focus-visible` does not match a programmatic focus, so a
  // measurement taken after `.focus()` would report the ring missing whether or not it is.
  await page.locator('#gallery-search-input').focus();
  const onOpenControl = () => page.evaluate(
    () => document.activeElement?.classList.contains('gallery-mosaic__open') ?? false,
  );
  for (let step = 0; step < 12 && !(await onOpenControl()); step += 1) {
    await page.keyboard.press('Tab');
  }
  expect(await onOpenControl(), 'a tile is reachable by keyboard').toBe(true);

  const ring = await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    if (!active) return null;
    const style = getComputedStyle(active);
    const tile = active.closest<HTMLElement>('.gallery-mosaic__item');
    return {
      focusVisible: active.matches(':focus-visible'),
      outlineStyle: style.outlineStyle,
      outlineOffset: Number.parseFloat(style.outlineOffset),
      clipped: tile ? getComputedStyle(tile).overflow !== 'visible' : false,
    };
  });
  expect(ring?.focusVisible, 'the tile control takes a visible focus state').toBe(true);
  expect(ring?.outlineStyle).not.toBe('none');
  // The control fills its tile exactly and the tile clips, so any ring drawn outward is painted
  // and then discarded. A non-negative offset here is the defect, not a style preference.
  if (ring?.clipped) expect(ring.outlineOffset).toBeLessThan(0);

  await page.keyboard.press('Enter');
  const viewer = page.getByRole('dialog');
  await expect(viewer).toBeVisible();
  await expectNoAxeViolations(page, 'manager gallery viewer');

  // An opaque ground, not a 96% one: the remainder used to carry the manager shell's own text
  // through the dialog and into the photograph.
  await expect(viewer).toHaveCSS('background-color', 'rgb(43, 29, 23)');
  const backgroundContained = await page.evaluate(() => {
    const host = document.querySelector('.gallery-viewer')?.parentElement;
    return Array.from(document.body.children)
      .filter((child) => child !== host && !(child instanceof HTMLElement
        && child.dataset.galleryLiveHost === 'true'))
      .every((child) => child.hasAttribute('inert'));
  });
  expect(backgroundContained, 'the manager shell is inert behind the viewer').toBe(true);
  const liveHost = page.locator('[data-gallery-live-host="true"]');
  await expect(liveHost).toHaveCount(1);
  await expect(liveHost).not.toHaveAttribute('inert', '');
  await expect(liveHost.getByRole('status')).toHaveCount(1);
  expect(await liveHost.evaluate((element) => element.parentElement === document.body),
    'the persistent gallery live owner is a body-level sibling of the inert shell').toBe(true);

  // Closing is half of containment. The shell is inert while the dialog is open, so a
  // restoration that runs before the dialog is torn down calls `focus()` on an element
  // that is not focusable yet and drops the host at the top of the document.
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  expect(
    await page.evaluate(() => document.activeElement?.classList.contains('gallery-mosaic__open') ?? false),
    'focus returns to the tile the viewer was opened from',
  ).toBe(true);
});

test('viewer crosses a Gallery page boundary without losing its failed continuation state', async ({ page }) => {
  // This test fails if the continuation control is disabled at the end of the first page, if a
  // failed append replaces the current photo, or if the append's duplicate becomes a second tile.
  // The browser route stays here rather than changing `stubManagerRoutes`: every other manager
  // surface should retain its ordinary one-page fixture.
  await installViteRefreshGlobals(page);
  const first: ManagerGalleryMediaView = {
    id: '00000000-0000-4000-8000-000000000101',
    originalFilename: 'first-page-photo.jpg',
    guestName: 'Avery Stone',
    caption: 'First page photo',
    publicationStatus: 'published',
    previewAvailable: true,
    width: 1200,
    height: 900,
    receivedAt: '2026-07-27T12:01:00.000Z',
    timelineAt: '2026-07-27T12:01:00.000Z',
    timelineSource: 'received',
    isFavorite: false,
  };
  const second: ManagerGalleryMediaView = {
    id: '00000000-0000-4000-8000-000000000102',
    originalFilename: 'second-page-photo.jpg',
    guestName: 'Avery Stone',
    caption: 'Second page photo',
    publicationStatus: 'published',
    previewAvailable: true,
    width: 1200,
    height: 900,
    receivedAt: '2026-07-27T12:00:00.000Z',
    timelineAt: '2026-07-27T12:00:00.000Z',
    timelineSource: 'received',
    isFavorite: false,
  };
  expect(Date.parse(first.timelineAt), 'the first newest-first page is newer than its continuation')
    .toBeGreaterThan(Date.parse(second.timelineAt));
  let continuationAttempts = 0;
  let releaseRetryResponse: (() => void) | undefined;
  const retryResponseGate = new Promise<void>((resolve) => {
    releaseRetryResponse = resolve;
  });
  const galleryPath = `/api/manage/events/${EVENT_FIXTURE.id}/gallery`;
  await stubManagerRoutes(page, { mediaPages: { first: { media: [], nextCursor: null } } });
  await page.route(`**${galleryPath}**`, async (route) => {
    const request = route.request();
    const url = new URL(route.request().url());
    // The summary is a separate Manager resource owned by the common stub, but only its exact
    // GET read may fall through. Any other nested Gallery URL or write fails this wire contract.
    if (url.pathname === `${galleryPath}/summary`) {
      expect(request.method(), 'Gallery summary is read with GET').toBe('GET');
      return route.fallback();
    }
    expect(request.method(), 'viewer continuation only reads Gallery with GET').toBe('GET');
    expect(url.pathname, 'viewer continuation only reads the exact Gallery endpoint').toBe(galleryPath);
    const parameters = [...url.searchParams.entries()];
    if (url.searchParams.get('cursor') === null) {
      expect(parameters, 'first Gallery page carries only newest-first order').toEqual([['order', 'newest']]);
      return route.fulfill({
        json: { data: { media: [first], nextCursor: 'viewer-page-2' }, requestId: 'viewer-page-1' },
      });
    }
    expect(parameters, 'continuation uses only the original cursor and newest-first order').toEqual([
      ['order', 'newest'],
      ['cursor', 'viewer-page-2'],
    ]);
    continuationAttempts += 1;
    if (continuationAttempts === 1) {
      return route.fulfill({
        status: 500,
        json: { code: 'INTERNAL_ERROR', message: 'The next page is temporarily unavailable.', requestId: 'viewer-page-2-failed' },
      });
    }
    await retryResponseGate;
    return route.fulfill({
      json: { data: { media: [first, second], nextCursor: null }, requestId: 'viewer-page-2' },
    });
  });

  await page.goto(`/manage/event/${EVENT_FIXTURE.id}`);
  await page.locator('.manager-nav nav button').filter({ hasText: 'Gallery' }).click();
  const origin = page.getByRole('button', { name: 'Open First page photo, from Avery Stone' });
  await expect(origin).toBeVisible();
  await origin.click();

  const viewer = page.getByRole('dialog');
  const next = viewer.getByRole('button', { name: 'Load next photo' });
  await expect(next).toBeEnabled();
  await next.click();

  const alert = viewer.getByRole('alert');
  await expect(alert).toContainText('Could not load the next photo. Try again.');
  await expect(viewer).toContainText('First page photo');
  const retry = alert.getByRole('button', { name: 'Try again' });
  await expect(retry).toBeFocused();
  await expect(alert).toHaveCSS('background-color', 'rgb(255, 241, 238)');
  const retryTarget = await measureTarget(retry);
  expect(retryTarget.width, 'viewer Retry target width').toBeGreaterThanOrEqual(44);
  expect(retryTarget.height, 'viewer Retry target height').toBeGreaterThanOrEqual(44);
  expect(
    await computedStyleContrast(retry, 'outlineColor', alert),
    'viewer Retry focus indicator contrast against its adjacent failure surface',
  ).toBeGreaterThanOrEqual(3);
  await expectNoAxeViolations(page, 'viewer continuation failure');

  await retry.click();
  await expect.poll(() => continuationAttempts, 'the deferred retry starts exactly one request').toBe(2);
  await expect(retry).toBeFocused();
  expect(
    await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null),
    'focus remains inside the viewer throughout the deferred retry',
  ).toBe(true);
  releaseRetryResponse?.();
  await expect(viewer).toContainText('Second page photo');
  await expect(alert).toHaveCount(0);
  await expect(viewer.getByRole('button', { name: 'Close viewer' })).toBeFocused();
  await expect(page.locator(`[data-photo-id="${first.id}"]`)).toHaveCount(1);
  await expect(page.locator(`[data-photo-id="${second.id}"]`)).toHaveCount(1);
  expect(continuationAttempts, 'the failed cursor is retried once').toBe(2);

  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  await expect(origin).toBeFocused();
});

test('narrow Manager export progress has one scoped live owner and remains axe-clean', async ({ page }, testInfo) => {
  onlyOnce(testInfo);
  await page.setViewportSize({ width: 320, height: 844 });
  const job: ExportView = {
    id: 'accessible-running-export',
    kind: 'complete',
    state: 'running',
    snapshotAt: '2026-09-20T09:00:00Z',
    createdAt: '2026-09-20T09:00:00Z',
    startedAt: '2026-09-20T09:00:01Z',
    completedAt: null,
    mediaCount: 2,
    totalBytes: 256,
    processedMediaCount: 1,
    processedBytes: 128,
    progressUpdatedAt: '2026-09-20T09:00:02Z',
    attempt: 1,
    partCount: 0,
    expiresAt: null,
    guestbookEntryCount: 1,
    guestbookSharedCount: 1,
    guestbookEventName: EVENT_FIXTURE.name,
    guestbookEventDate: EVENT_FIXTURE.eventDate,
    guestbookEventTimezone: EVENT_FIXTURE.eventTimezone,
    guestbookPrompt: EVENT_FIXTURE.guestbookPrompt,
    guestbookGalleryVisible: EVENT_FIXTURE.galleryVisible,
    errorCode: null,
  };
  await stubManagerRoutes(page, {
    mediaPages: { first: { media: makeMedia(2), nextCursor: null } },
    event: { storedMediaCount: 2, storedBytes: 256 },
    exports: [job],
  });
  await page.goto(`/manage/event/${EVENT_FIXTURE.id}`);
  await expect(page.getByRole('heading', { name: 'Live intake' })).toBeVisible();

  const compact = page.getByRole('region', { name: 'Export progress' });
  await expect(compact).toContainText('Complete export · Running');
  await expect(compact).toContainText('1 of 2 photos processed');
  expect(await measureContrast(compact.locator(':scope > span')),
    'compact export progress text contrast').toBeGreaterThanOrEqual(4.5);
  const action = compact.getByRole('button', { name: 'Open Gallery' });
  const target = await measureTarget(action);
  expect(target.width, 'compact export action width').toBeGreaterThanOrEqual(44);
  expect(target.height, 'compact export action height').toBeGreaterThanOrEqual(44);

  const liveHost = page.locator('[data-gallery-live-host="true"]');
  await expect(liveHost).toHaveCount(1);
  await expect(liveHost.getByRole('status')).toHaveCount(1);
  expect(await liveHost.evaluate((element) => element.parentElement === document.body),
    'the one live owner stays outside Manager section churn').toBe(true);
  await expect(page.locator('.manager-shell [data-gallery-live-host]')).toHaveCount(0);

  const documentSize = await measureDocument(page);
  expect(documentSize.scrollWidth, 'narrow export progress stays inside the viewport')
    .toBeLessThanOrEqual(documentSize.clientWidth + 1);
  await expectNoAxeViolations(page, 'narrow Manager export progress');
});

test('manager Album Preview and the public Album keep their heading hierarchy axe-clean', async ({ page }, testInfo) => {
  onlyOnce(testInfo);
  await page.setViewportSize({ width: 1280, height: 900 });
  const rows = makeMedia(2, 'published').map((photo, index) => ({
    ...photo,
    caption: index === 0 ? 'First dance' : 'Night portraits',
  }));
  const shareToken = 'accessible-album-id.accessible-album-secret';
  await stubManagerRoutes(page, {
    mediaPages: { first: { media: rows, nextCursor: null } },
    event: { storedMediaCount: rows.length },
    album: {
      pickedMediaIds: rows.map(({ id }) => id),
      title: 'The evening',
      description: 'The photographs we kept together.',
      entries: [
        { kind: 'section', id: 'ceremony', heading: 'Ceremony' },
        ...rows.map(({ id }) => ({ kind: 'photo' as const, mediaId: id })),
      ],
      shareActive: false,
      shareToken,
    },
  });

  await page.goto(`/manage/event/${EVENT_FIXTURE.id}`);
  await expect(page.getByRole('heading', { name: 'Live intake' })).toBeVisible();
  await page.locator('.manager-nav nav button').filter({ hasText: 'Gallery' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Gallery', exact: true })).toHaveCount(1);
  await page.getByRole('group', { name: 'Gallery mode' })
    .getByRole('button', { name: /^Album/u }).click();
  const createAction = page.getByRole('button', { name: 'Create Album link' });
  await createAction.click();
  const createDialog = page.getByRole('dialog', { name: 'Create the Album link?' });
  await expect(createDialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await expectNoAxeViolations(page, 'Manager Album-link creation dialog');
  await page.keyboard.press('Shift+Tab');
  await expect(createDialog.getByRole('button', { name: 'Create Album link' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(createDialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Copy Album link' })).toBeFocused();
  await page.getByRole('button', { name: 'Preview album' }).click();

  const preview = page.getByRole('region', { name: 'What people with the Album link see' });
  await expect(preview.getByRole('heading', { level: 3, name: 'The evening' })).toBeVisible();
  await expect(preview.getByRole('heading', { level: 4, name: 'Ceremony' })).toBeVisible();
  await expectNoAxeViolations(page, 'Manager Album Preview heading hierarchy');

  await page.goto(`/album#${shareToken}`);
  await expect(page.getByRole('heading', { level: 1, name: 'The evening' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Ceremony' })).toBeVisible();
  await expectNoAxeViolations(page, 'public Album heading hierarchy');
});

test('reduced motion opens the terminal Guestbook without smooth scrolling or moving focus into the textarea', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    const observed: ScrollBehavior[] = [];
    Object.defineProperty(window, '__guestbookScrollBehaviors', { value: observed, configurable: true });
    HTMLElement.prototype.scrollIntoView = function scrollIntoView(options?: boolean | ScrollIntoViewOptions) {
      if (typeof options === 'object') observed.push(options.behavior ?? 'auto');
    };
  });
  await stubGuestRoutes(page);
  const base = `**/api/event/${EVENT_FIXTURE.slug}`;
  await page.route(`${base}/uploads/batch`, async (route) => {
    const payload = route.request().postDataJSON() as { files: Array<{ idempotencyKey: string; mimeType: string }> };
    const origin = new URL(page.url()).origin;
    await route.fulfill({ status: 201, json: { data: { items: payload.files.map((file) => ({
      idempotencyKey: file.idempotencyKey,
      status: 'accepted',
      media: { id: `media-${file.idempotencyKey}`, mimeType: file.mimeType },
      uploadUrl: `${origin}/direct-upload/${file.idempotencyKey}`,
    })) }, requestId: 'request-a' } });
  });
  await page.route('**/direct-upload/*', (route) => route.fulfill({ status: 200, body: '' }));
  await page.route(`${base}/uploads/*/finalize`, (route) => route.fulfill({
    json: { data: { media: { uploadState: 'stored' } }, requestId: 'request-a' },
  }));
  await page.goto(`/event/${EVENT_FIXTURE.slug}`);
  await page.getByLabel('Your name').fill('Taylor Morgan');
  await page.locator('input[data-photo-source="library"]').setInputFiles({
    name: 'wish.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('wish'),
  });
  await page.getByRole('button', { name: 'Send 1 photo' }).click();
  const action = page.getByRole('button', { name: 'Leave a guestbook note' });
  await action.focus();
  await page.keyboard.press('Enter');
  const heading = page.getByRole('heading', { name: 'Leave a note for Maya & Theo' });
  await expect(heading).toBeFocused();
  await expect(page.getByRole('textbox', { name: 'Your note for Maya & Theo' })).not.toBeFocused();
  expect(await page.evaluate(() => (window as unknown as { __guestbookScrollBehaviors: ScrollBehavior[] })
    .__guestbookScrollBehaviors)).toEqual(['auto']);
  const ring = await outline(heading);
  expect(ring.style).toBe('solid');
  expect(ring.width).toBeGreaterThanOrEqual(2);

  await action.focus();
  await page.keyboard.press('Enter');
  await expect(heading).toBeFocused();
  expect(await page.evaluate(() => (window as unknown as { __guestbookScrollBehaviors: ScrollBehavior[] })
    .__guestbookScrollBehaviors)).toEqual(['auto', 'auto']);
  await expectNoAxeViolations(page, 'terminal Guestbook focus');
});

test('printable Guestbook HTML stays self-contained, semantic, high-contrast, and axe-clean on screen and in print media', async ({ page }) => {
  const entry: ExportGuestbookEntryRecord = {
    exportJobId: 'export-a',
    source: 'guest_note',
    sourceId: 'note-a',
    sourceRank: 1,
    guestName: 'ليلى',
    body: 'ذكرى جميلة <script>never runs</script> 🌿',
    createdAt: '2026-09-19T20:00:00Z',
    sourceState: 'approved',
    guestVisibility: 'shared',
    includedInKeepsake: true,
    mediaId: null,
    originalFilename: null,
  };
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.setContent(buildGuestbookHtml({
    eventName: 'Maya & Theo',
    eventDate: '2026-09-19',
    eventTimezone: 'America/Chicago',
    prompt: 'Share a wish, memory, or moment from the day.',
    snapshotAt: '2026-09-20T02:00:00Z',
    entries: [entry],
    photoArchiveByMediaId: new Map(),
  }), { waitUntil: 'load' });
  await expect(page.getByRole('heading', { name: 'Maya & Theo' })).toBeVisible();
  await expect(page.locator('article')).toHaveCount(1);
  await expect(page.locator('article')).toHaveAttribute('dir', 'auto');
  await expect(page.locator('script, form, link[rel="stylesheet"], img')).toHaveCount(0);
  await expect(page.getByText(/never runs/u)).toBeVisible();
  expect(requests).toEqual([]);
  expect(await measureContrast(page.locator('body'))).toBeGreaterThanOrEqual(7);
  await expectNoAxeViolations(page, 'printable Guestbook screen rendering');

  await page.emulateMedia({ media: 'print' });
  expect(await page.locator('body').evaluate((element) => getComputedStyle(element).backgroundColor))
    .toBe('rgb(255, 255, 255)');
  expect(await measureContrast(page.locator('body'))).toBeGreaterThanOrEqual(7);
  await expect(page.locator('article')).toHaveCSS('break-inside', 'avoid');
  await expectNoAxeViolations(page, 'printable Guestbook print rendering');
  expect(requests).toEqual([]);
});

for (const { name, theme } of THEME_ACCESSIBILITY_CASES) {
  test(`${name} guest theme passes Axe and computed text, action, boundary, and focus contrast`, async ({ page }, testInfo) => {
    onlyOnce(testInfo);
    await page.setViewportSize({ width: 390, height: 844 });
    await stubGuestRoutes(page, { event: { theme } });
    await page.goto(`/event/${EVENT_FIXTURE.slug}`);
    await expect(page.getByRole('heading', { name: EVENT_FIXTURE.welcomeMessage })).toBeVisible();
    await expectNoAxeViolations(page, `${name} guest theme`);

    const nameInput = page.getByLabel('Your name');
    const helper = page.getByText('No account needed. Your name is remembered here.');
    const action = page.getByRole('button', { name: 'Take a photo', exact: true });
    expect(await measureContrast(helper), `${name} text contrast`).toBeGreaterThanOrEqual(4.5);
    expect(await measureContrast(action), `${name} action text contrast`).toBeGreaterThanOrEqual(4.5);
    expect(
      await computedStyleContrast(nameInput, 'borderTopColor'),
      `${name} input boundary contrast`,
    ).toBeGreaterThanOrEqual(3);

    await nameInput.focus();
    expect(
      await computedStyleContrast(nameInput, 'outlineColor', page.locator('.photo-drop')),
      `${name} focus contrast`,
    ).toBeGreaterThanOrEqual(3);
  });
}

test('theme radios have textual names, native checked state, and a full-document manager Settings Axe pass', async ({ page }, testInfo) => {
  onlyOnce(testInfo);
  await page.setViewportSize({ width: 390, height: 1400 });
  await page.goto('/create');
  for (const preset of EVENT_THEME_PRESETS) {
    const radio = page.getByRole('radio', { name: new RegExp(preset.name, 'u') });
    await expect(radio).toHaveAccessibleName(new RegExp(preset.name, 'u'));
    await radio.check();
    await expect(radio).toBeChecked();
  }

  await stubManagerRoutes(page, {
    mediaPages: { first: { media: [], nextCursor: null } },
  });
  await page.goto(`/manage/event/${EVENT_FIXTURE.id}`);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Event appearance editor' })).toBeVisible();
  await expect(page.locator('.event-appearance-canvas')).toBeVisible();
  const colorInputBorder = await page.getByLabel('Primary color picker').evaluate((element) => {
    const tokenProbe = document.createElement('span');
    tokenProbe.style.color = 'var(--border)';
    document.body.append(tokenProbe);
    const expected = getComputedStyle(tokenProbe).color;
    tokenProbe.remove();
    return {
      actual: getComputedStyle(element).borderTopColor,
      expected,
    };
  });
  expect(colorInputBorder.actual, 'Manager color input uses the global border token').toBe(colorInputBorder.expected);
  for (const toggle of await page.locator('.settings-form .toggle').all()) {
    const target = await measureTarget(toggle);
    expect(target.width, 'Settings toggle label width').toBeGreaterThanOrEqual(44);
    expect(target.height, 'Settings toggle label height').toBeGreaterThanOrEqual(44);
    const checkbox = await measureTarget(toggle.locator('input'));
    expect(checkbox.width, 'Settings checkbox width').toBeGreaterThanOrEqual(24);
    expect(checkbox.height, 'Settings checkbox height').toBeGreaterThanOrEqual(24);
  }
  for (const preset of EVENT_THEME_PRESETS) {
    const radio = page.getByRole('radio', { name: new RegExp(preset.name, 'u') });
    await expect(radio).toHaveAccessibleName(new RegExp(preset.name, 'u'));
    await radio.check();
    await expect(radio).toBeChecked();
  }
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    document.documentElement.style.scrollBehavior = 'auto';
    window.scrollTo(0, 0);
  });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expectNoAxeViolations(page, 'manager Settings editor and preview');
});

test('Cover Studio Choose, Compose, Style, Done, and preparing states are axe-clean and focus-ordered', async ({ page }, testInfo) => {
  onlyOnce(testInfo);
  await page.setViewportSize({ width: 390, height: 844 });
  const uploadCover: EventView['cover'] = {
    ...EVENT_FIXTURE.cover,
    config: {
      version: 1,
      source: { kind: 'upload' },
      focus: { mode: 'manual', x: 0.3, y: 0.7, zoom: 1.2 },
      effect: 'soft',
    },
    revision: 9,
    hasCover: true,
  };
  await stubManagerRoutes(page, {
    event: { cover: uploadCover },
    mediaPages: { first: { media: [], nextCursor: null } },
    cover: PHOTOGRAPHIC_COVER,
    coverScenario: {
      previewFailures: { natural: 1 },
      previewDelaysMs: { natural: 2_500 },
      publicationReplies: [{ operationStatus: 'preparing', status: 202, retryAfter: '30' }],
    },
  });
  await page.goto(`/manage/event/${EVENT_FIXTURE.id}`);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expectNoAxeViolations(page, 'Manager cover canvas');

  await page.getByRole('button', { name: 'Change cover' }).click();
  const chooseHeading = page.getByRole('heading', { name: 'Choose a cover' });
  await expect(chooseHeading).toBeFocused();
  await page.keyboard.press('Tab');
  const uploadRadio = page.getByRole('radio', { name: 'Upload a photo' });
  await expect(uploadRadio).toBeFocused();
  await page.keyboard.press('Tab');
  const file = page.locator('.cover-source-picker__file');
  await expect(file).toBeFocused();
  const proxy = page.locator('.cover-source-picker__file-proxy');
  expect(await proxy.evaluate((element) => {
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, width: style.outlineWidth, offset: style.outlineOffset };
  })).toEqual({ style: 'solid', width: '2px', offset: '2px' });
  const chooseDocument = await measureDocument(page);
  expect(chooseDocument.scrollWidth).toBeLessThanOrEqual(chooseDocument.clientWidth + 1);
  await expectNoAxeViolations(page, 'Cover Studio Choose');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Preparing your photo…')).toBeVisible();
  await expectNoAxeViolations(page, 'Cover Studio loading');

  const studio = page.getByRole('dialog', { name: 'Cover Studio' });
  const retry = studio.getByRole('button', { name: 'Try preparing again' });
  await expect(studio.getByRole('alert')).toBeFocused({ timeout: 5_000 });
  await expectNoAxeViolations(page, 'Cover Studio actionable error');
  await retry.click();
  await expect(page.getByRole('button', { name: 'Adjust framing' })).toBeVisible({ timeout: 5_000 });
  await expectNoAxeViolations(page, 'Cover Studio Compose automatic');

  await page.getByRole('button', { name: 'Adjust framing' }).click();
  await expectNoAxeViolations(page, 'Cover Studio Compose manual');
  const reset = page.getByRole('button', { name: 'Reset to automatic' });
  const horizontal = page.getByRole('slider', { name: 'Left or right' });
  const vertical = page.getByRole('slider', { name: 'Up or down' });
  const zoom = page.getByRole('slider', { name: 'Zoom' });
  await reset.focus();
  await page.keyboard.press('Tab');
  await expect(horizontal).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(vertical).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(zoom).toBeFocused();
  await horizontal.press('ArrowRight');
  await page.getByRole('button', { name: 'Cancel' }).click();
  const discard = page.getByRole('alertdialog', { name: 'Discard cover changes' });
  await expect(discard.getByRole('button', { name: 'Keep editing' })).toBeFocused();
  await expectNoAxeViolations(page, 'Cover Studio discard alertdialog');
  await discard.getByRole('button', { name: 'Keep editing' }).click();

  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Choose a style' })).toBeFocused();
  await expectNoAxeViolations(page, 'Cover Studio Style');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Save this cover' })).toBeFocused();
  await expectNoAxeViolations(page, 'Cover Studio Done');

  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('dialog', { name: 'Cover Studio' }).getByRole('status'))
    .toContainText('Preparing cover');
  await expectNoAxeViolations(page, 'Cover Studio preparing');
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('.cover-preparation')).toContainText('Preparing cover');
  await expectNoAxeViolations(page, 'Manager cover preparation');
});

test('Cover Studio Choose and Style are axe-clean with a native file-focus proxy at 320', async ({ page }, testInfo) => {
  onlyOnce(testInfo);
  await page.setViewportSize({ width: 320, height: 568 });
  await stubManagerRoutes(page, {
    mediaPages: { first: { media: [], nextCursor: null } },
  });
  await page.goto(`/manage/event/${EVENT_FIXTURE.id}`);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Change cover' }).click();
  await expect(page.getByRole('heading', { name: 'Choose a cover' })).toBeFocused();
  await expectNoAxeViolations(page, 'Cover Studio Choose at 320');

  await page.getByRole('radio', { name: 'Upload a photo' }).focus();
  await page.keyboard.press('Tab');
  const file = page.locator('.cover-source-picker__file');
  await expect(file).toBeFocused();
  const proxy = page.locator('.cover-source-picker__file-proxy');
  expect(await proxy.evaluate((element) => {
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, width: style.outlineWidth, offset: style.outlineOffset };
  })).toEqual({ style: 'solid', width: '2px', offset: '2px' });
  let documentSize = await measureDocument(page);
  expect(documentSize.scrollWidth).toBeLessThanOrEqual(documentSize.clientWidth + 1);

  await page.getByRole('radio', { name: /^Warm Linen/u }).check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Choose a style' })).toBeFocused();
  await expectNoAxeViolations(page, 'Cover Studio Style at 320');
  documentSize = await measureDocument(page);
  expect(documentSize.scrollWidth).toBeLessThanOrEqual(documentSize.clientWidth + 1);
});

for (const terminal of [
  { name: 'retryable', status: 'retryable-failed' as const, code: 503, retryable: true },
  { name: 'permanent', status: 'permanent-failed' as const, code: 503, retryable: false },
  { name: 'conflict', status: 'conflict' as const, code: 409, retryable: false },
]) {
  test(`Cover Studio ${terminal.name} terminal state is axe-clean`, async ({ page }, testInfo) => {
    onlyOnce(testInfo);
    await page.setViewportSize({ width: 1280, height: 900 });
    await stubManagerRoutes(page, {
      mediaPages: { first: { media: [], nextCursor: null } },
      coverScenario: {
        publicationReplies: [{
          operationStatus: terminal.status,
          status: terminal.code,
          retryable: terminal.retryable,
          includeEvent: true,
        }],
      },
    });
    await page.goto(`/manage/event/${EVENT_FIXTURE.id}`);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Change cover' }).click();
    await page.getByRole('radio', { name: 'Warm Linen' }).check();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('dialog', { name: 'Cover Studio' })).toBeVisible();
    await expectNoAxeViolations(page, `Cover Studio ${terminal.name} terminal`);
  });
}

test('every manager section carries no automated accessibility violation', async ({ page }) => {
  await stubManagerRoutes(page, {
    // Unpublished is the Gallery's default filter and the state that renders every card control.
    mediaPages: { first: { media: makeMedia(3, 'unpublished'), nextCursor: null } },
    messages: [NOTE],
    event: { storedMediaCount: 3 },
  });
  await page.goto(`/manage/event/${EVENT_FIXTURE.id}`);

  for (const { name, heading } of MANAGER_SECTIONS) {
    await page.locator('.manager-nav nav button').filter({ hasText: name }).click();
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await expectNoAxeViolations(page, `manager ${name}`);
  }
});

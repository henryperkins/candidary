import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';

import { makeMedia } from './ui-data';

const preview = readFileSync('public/assets/candidary-hero.png');

export const EVENT_FIXTURE = {
  id: 'event-a',
  slug: 'maya-theo',
  name: 'Maya & Theo',
  eventDate: '2026-09-19',
  welcomeMessage: 'We would love to see the day through your eyes.',
  uploadsEnabled: true,
  galleryVisible: true,
  moderationRequired: true,
  storedMediaCount: 1,
  storedBytes: 128,
  guestAccessExpiresAt: '2026-10-19T00:00:00Z',
  purgeAfter: '2026-12-19T00:00:00Z',
};

interface GuestRouteOptions {
  event?: Partial<typeof EVENT_FIXTURE>;
  gallery?: ReturnType<typeof makeMedia>;
  contributions?: ReturnType<typeof makeMedia>;
  messages?: Array<{
    id: string;
    guestName: string;
    body: string;
    moderationStatus: 'approved';
    createdAt: string;
  }>;
}

export async function stubGuestRoutes(page: Page, options: GuestRouteOptions = {}) {
  const event = { ...EVENT_FIXTURE, ...options.event };
  const gallery = options.gallery ?? makeMedia(1);
  const contributions = options.contributions ?? gallery;
  const messages = options.messages ?? [];
  const base = `**/api/event/${event.slug}`;

  await page.route('**/api/media/*/preview', (route) => route.fulfill({
    status: 200,
    contentType: 'image/png',
    body: preview,
  }));
  await page.route(base, (route) => route.fulfill({
    json: { data: { event, role: 'guest' }, requestId: 'request-a' },
  }));
  await page.route(`${base}/gallery`, (route) => route.fulfill({
    json: { data: { media: gallery }, requestId: 'request-a' },
  }));
  await page.route(`${base}/contributions`, (route) => route.fulfill({
    json: { data: { media: contributions }, requestId: 'request-a' },
  }));
  await page.route(`${base}/messages`, (route) => route.fulfill({
    json: { data: { items: messages }, requestId: 'request-a' },
  }));
}

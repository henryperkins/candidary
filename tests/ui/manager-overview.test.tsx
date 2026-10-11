import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventView, HostEventLifecycleView } from '../../shared/contracts';
import { DEFAULT_GUESTBOOK_PROMPT } from '../../shared/constants';
import { EVENT_START_MIGRATION_SENTINEL } from '../../shared/rsvp';
import { resolveEventTheme } from '../../shared/event-theme';
import { ManagerOverview } from '../../src/features/manager/ManagerOverview';
import type { ResourceState } from '../../src/features/manager/resources';
import { createAppRouter } from '../../src/app/router';
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(() => Promise.resolve('data:image/png;base64,x')) } }));
const EVENT: EventView = {
  id: 'event-a', slug: 'maya-theo', name: 'Maya & Theo', eventDate: '2026-09-19',
  welcomeMessage: 'Welcome.',
  guestbookPrompt: DEFAULT_GUESTBOOK_PROMPT,
  cover: {
    config: { version: 1, source: { kind: 'none' } }, revision: 0, hasCover: false,
    available2xProfiles: [], surfaceTreatment: 'none', preparation: null,
  },
  uploadsEnabled: true, galleryVisible: true, moderationRequired: true,
  reservedMediaCount: 0, storedMediaCount: 3, reservedBytes: 0, storedBytes: 128, recoverableMediaCount: 0, recoverableBytes: 0,
  hostUploadAvailability: { enabled: true, reason: null },
  guestAccessExpiresAt: '2026-10-19T00:00:00Z', managementAccessExpiresAt: '2026-10-19T00:00:00Z',
  managerLinkRevision: 0,
  managerLinkRotationAvailability: { enabled: true, reason: null },
  purgeAfter: '2026-12-19T00:00:00Z', createdAt: '2026-07-29T00:00:00Z', deletedAt: null,
  eventTimezone: 'America/Chicago',
  eventStartAt: '2026-09-19T22:00:00.000Z', eventStartTime: '17:00',
  photosOpen: false, photoIntakeState: 'scheduled', photoIntakeRecheckAfterMs: 60_000,
  rsvpEnabled: false,
  rsvpDeadlineAt: '2026-09-05T04:59:59.999Z', rsvpDeadlineDate: '2026-09-04',
  rsvpRosterVersion: 7,
  theme: resolveEventTheme({ version: 1, presetId: 'candidary-default', overrides: {} }),
};


const PHASE: HostEventLifecycleView = { phase: 'rsvp-primary', rsvpState: 'open', photoIntakeState: 'scheduled', entryDisabled: false, guestAccessEnded: false, lifecycleRecheckAfterMs: null };
const SUMMARY = { namedInvitees: 0, invitedCapacity: 0, plusOneCapacity: 0, attending: 0, declined: 0, awaitingResponse: 0, householdsResponded: 0, householdsAwaitingResponse: 0 };
function json(data: unknown, status = 200) { return Promise.resolve(new Response(JSON.stringify(status >= 400 ? { ...(data as object), requestId: 'overview' } : { data, requestId: 'overview' }), { status, headers: { 'content-type': 'application/json' } })); }
function deferred() { let resolve!: (value: Response) => void; const promise = new Promise<Response>(r => { resolve = r; }); return { promise, resolve }; }
function setup(options: { lifecycle?: () => Promise<Response>; summary?: () => Promise<Response>; event?: () => Promise<Response>; path?: string; entry?: { eventLink: string | null; disabledAt: string | null } } = {}) {
  const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/lifecycle')) return options.lifecycle?.() ?? json(PHASE);
    if (url.endsWith('/rsvp/summary')) return options.summary?.() ?? json(SUMMARY);
    if (/\/api\/manage\/events\/event-[ab]$/.test(url)) return options.event?.() ?? json({ event: { ...EVENT, id: url.endsWith('event-b') ? 'event-b' : 'event-a', name: url.endsWith('event-b') ? 'Second event' : EVENT.name } });
    if (url.endsWith('/exports')) return json({ exports: [] });
    if (url.endsWith('/entry')) return json(options.entry ?? { eventLink: 'https://candidary.test/join#fixture', disabledAt: null });
    if (url.includes('/guestbook')) return json({ summary: { needsReviewCount: 0 } });
    if (url.includes('/gallery/summary')) return json({ summary: { albumPhotoCount: 0, albumEntryCount: 0, albumLink: { active: false }, guestGalleryVisible: false, guestGalleryPublishedCount: 0 } });
    if (url.includes('/photo-exports/capabilities')) return json({ enabled: false });
    if (url.includes('/gallery/arrivals')) return json({ afterSequence: 0, snapshotSequence: 0, count: 0 });
    if (url.includes('/gallery') || url.includes('/media')) return json({ media: [], nextCursor: null, snapshotSequence: 0 });
    if (url.includes('/rsvp/households')) return json({ households: [], nextCursor: null });
    throw new Error('Unexpected request ' + url);
  });
  vi.stubGlobal('fetch', fetchMock);
  const router = createAppRouter([options.path ?? '/manage/event/event-a?section=overview']);
  render(<RouterProvider router={router} />);
  return { router, fetchMock };
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('Manager Overview', () => {
  it('uses only supplied guarded callbacks for every workflow and tour replay', async () => {
    function state<T>(value: T): ResourceState<T> { return { eventId: 'event-a', queryKey: 'test', generation: 1, value, status: 'ready', failure: null, terminal: false }; }
    const onNavigate = vi.fn(); const onTakeTour = vi.fn(); const onShowIntroduction = vi.fn();
    render(<ManagerOverview phaseLabel="RSVP is open" lifecycle={state(PHASE)} summary={state(SUMMARY)} exports={state([])} recommendation={{ label: 'Add guests', reason: 'RSVP is open.', destination: 'rsvp' }} onNavigate={onNavigate} onTakeTour={onTakeTour} onShowIntroduction={onShowIntroduction} onRetryLifecycle={vi.fn()} onRetrySummary={vi.fn()} onRetryExports={vi.fn()} />);
    const user = userEvent.setup();
    for (const label of ['Add guests', 'Open RSVP', 'Open Share', 'Open Library', 'Open Exports', 'Open Settings']) await user.click(screen.getByRole('button', { name: label }));
    expect(onNavigate.mock.calls.map(([destination]) => destination)).toEqual(['rsvp', 'rsvp', 'share', 'library', 'originals', 'settings']);
    const introduction = screen.getByRole('button', { name: 'Show me how to collect photos' });
    expect(introduction.closest('[data-host-tour-anchor]')).toHaveAttribute('data-host-tour-anchor', 'overview-task');
    expect(introduction).toHaveClass('button--quiet');
    await user.click(introduction);
    expect(onShowIntroduction).toHaveBeenCalledOnce();
    const tools = screen.getByRole('button', { name: 'Tour event tools' });
    expect(tools.closest('section')).toHaveAttribute('aria-labelledby', 'overview-workflows-title');
    await user.click(tools);
    expect(onTakeTour).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Add guests' }).closest('[data-host-tour-anchor]')).toHaveAttribute('data-host-tour-anchor', 'overview-task');
  });
  it('refetches after a server-relative phase boundary without deriving the new phase locally', async () => {
    let calls = 0;
    setup({ lifecycle: () => json(++calls === 1 ? { ...PHASE, lifecycleRecheckAfterMs: 30 } : { ...PHASE, phase: 'before-start' }) });
    expect(await screen.findByRole('button', { name: 'Prepare your QR' })).toBeVisible();
    expect(calls).toBe(2);
  });
  it('opens a shell with identity alone and keeps unknown summaries truthful', async () => {
    const phase = deferred(); const summary = deferred();
    const { fetchMock } = setup({ lifecycle: () => phase.promise, summary: () => summary.promise });
    expect(await screen.findByRole('heading', { name: EVENT.name })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Choose your next task' })).toBeVisible();
    expect(screen.getByText(/September 19, 2026 at 5:00 PM CDT/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Add guests' })).not.toBeInTheDocument();
    await act(async () => { phase.resolve(await json(PHASE)); });
    expect(await screen.findByRole('button', { name: 'Review RSVPs' })).toBeVisible();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rsvp/households'))).toBe(false);
    expect(screen.queryByRole('heading', { level: 2, name: 'Guest list and RSVPs' })).not.toBeInTheDocument();
  });
  it('uses the trusted event date for a legacy migration sentinel start', async () => {
    setup({ event: () => json({ event: { ...EVENT, eventStartAt: EVENT_START_MIGRATION_SENTINEL } }) });
    await screen.findByRole('heading', { name: EVENT.name });
    expect(screen.getByText(/September 19, 2026 · America\/Chicago/)).toBeVisible();
    expect(screen.queryByText(/December 31, 1969|January 1, 1970/)).not.toBeInTheDocument();
  });
  it('retries phase independently while summary remains confirmed', async () => {
    let calls = 0;
    setup({ lifecycle: () => ++calls === 1 ? json({ code: 'INTERNAL_ERROR', message: 'Phase unavailable' }, 500) : json(PHASE) });
    await screen.findByText('Phase unavailable');
    expect(screen.getByText(/0 named guests/)).toBeVisible();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Add guests' })).toBeVisible();
  });
  it('summary failure retains phase and retry never assumes zero guests', async () => {
    let calls = 0;
    setup({ summary: () => ++calls === 1 ? json({ code: 'INTERNAL_ERROR', message: 'Summary unavailable' }, 500) : json(SUMMARY) });
    await screen.findByText('Summary unavailable');
    expect(screen.getByText('RSVP is open')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Review RSVPs' })).toBeVisible();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Add guests' })).toBeVisible();
  });
  it('rechecks server phase on focus and routes retrieval to the existing export intent without creating an export', async () => {
    let calls = 0;
    const { router, fetchMock } = setup({ lifecycle: () => json(++calls === 1 ? PHASE : { ...PHASE, guestAccessEnded: true }) });
    await screen.findByRole('button', { name: 'Add guests' });
    fireEvent(window, new Event('focus'));
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Retrieve originals' }));
    await waitFor(() => expect(router.state.location.search).toBe(''));
    expect(router.state.location.search).toBe('');
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit)?.method === 'POST')).toBe(false);
  });
  it('discards an old event lifecycle response', async () => {
    const stale = deferred(); let calls = 0;
    const { router } = setup({ lifecycle: () => ++calls === 1 ? stale.promise : json({ ...PHASE, phase: 'before-start' }) });
    await screen.findByRole('heading', { name: EVENT.name });
    await act(async () => { await router.navigate('/manage/event/event-b?section=overview'); });
    expect(await screen.findByRole('button', { name: 'Prepare your QR' })).toBeVisible();
    await act(async () => { stale.resolve(await json({ ...PHASE, guestAccessEnded: true })); });
    expect(screen.getByRole('heading', { name: 'Second event' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Retrieve originals' })).not.toBeInTheDocument();
  });
  it.each(['', '?section=gallery&mode=guest-gallery'])('preserves existing direct work URL %s', async path => {
    const { router, fetchMock } = setup({ path: '/manage/event/event-a' + path });
    await screen.findByRole('heading', { name: EVENT.name });
    expect(router.state.location.search).toBe(path);
    expect(screen.queryByRole('heading', { name: 'Choose your next task' })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/lifecycle'))).toBe(false);
  });
});

it('uses confirmed disabled entry for both Overview phase and recommendation even before lifecycle catches up', async () => {
  setup({ lifecycle: () => json({ ...PHASE, phase: 'photos-primary', photoIntakeState: 'open' }), entry: { eventLink: null, disabledAt: '2026-10-11T00:00:00Z' } });
  expect(await screen.findByRole('button', { name: 'Review event access', exact: true })).toBeVisible();
  expect(screen.getByText('Event QR disabled', { exact: true })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Share your QR' })).not.toBeInTheDocument();
});

import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ManagerGalleryWorkspace } from '../../src/features/gallery/ManagerGalleryWorkspace';
import { ManagerUndoProvider } from '../../src/features/gallery/undo';
import { useGuestGallery } from '../../src/features/gallery/useGuestGallery';
import { EventPage } from '../../src/pages/EventPage';
import { EVENT_FIXTURE, GUEST_EVENT_FIXTURE } from '../e2e/fixtures/routes';
import { makeMedia } from '../e2e/fixtures/ui-data';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

const noop = () => {};
const asyncNoop = async () => {};
const photos = makeMedia(2, 'unpublished').map((photo, index) => ({
  ...photo, originalFilename: `photo-${index}.jpg`, caption: `Moment ${index}`,
}));
const guestPhoto = { ...photos[0]!, publicationStatus: 'published' as const, previewAvailable: true };
const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
const unavailable = () => new Response(JSON.stringify({ code: 'INTERNAL_ERROR', message: 'The gallery could not be loaded.' }), { status: 503 });

function stubFetch(handle: (path: string, init: RequestInit) => Response | Promise<Response> | undefined) {
  const fetcher = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = String(input);
    const handled = handle(path, init);
    if (handled !== undefined) return handled;
    if (path === '/api/event/maya-theo') return ok({ event: GUEST_EVENT_FIXTURE, role: 'guest' });
    if (path.includes('/photo-exports/capabilities')) return ok({ enabled: false, activeJob: null });
    if (path.includes('/gallery')) return ok({ media: [], nextCursor: null });
    throw new Error(`Unexpected request: ${init.method ?? 'GET'} ${path}`);
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

function renderManager() {
  return render(<MemoryRouter><ManagerUndoProvider eventId="event-a">
    <ManagerGalleryWorkspace
      event={EVENT_FIXTURE} eventId="event-a" mode="guest-gallery" onModeChange={noop}
      galleryMutationEpoch={0} invalidateGalleryAfterMutation={noop}
      audience={{ summary: null, freshness: 'unavailable', failure: null, reload: asyncNoop, invalidate: noop }}
      shared={{ onPublicationChanged: noop, onOpenSettings: noop, settingsBlocked: false }}
      exports={{ status: 'ready', onPrepare: asyncNoop, onDownload: asyncNoop, onRetry: asyncNoop,
        currentSource: { count: 2, freshness: 'fresh' } }}
      onAnnouncement={noop}
    />
  </ManagerUndoProvider></MemoryRouter>);
}

async function renderGuest(fullscreen: boolean) {
  render(<MemoryRouter initialEntries={['/event/maya-theo']}><Routes>
    <Route path="/event/:slug" element={<EventPage fullscreen={fullscreen} />} />
  </Routes></MemoryRouter>);
  if (fullscreen) {
    await screen.findByRole('heading', { name: 'Shared gallery · Maya & Theo' });
  } else {
    const label = await screen.findByText('Shared gallery');
    const details = label.closest('details')!;
    details.open = true;
    fireEvent(details, new Event('toggle'));
  }
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('gallery hardening', () => {
  it('keeps pending manager reads distinct from empty and failed reads', async () => {
    const first = deferred<Response>();
    stubFetch((path) => path.includes('/media?') ? first.promise : undefined);
    renderManager();
    expect(screen.queryByText('No unpublished photos.')).not.toBeInTheDocument();
    expect(screen.getByText('Loading Guest gallery…')).toBeVisible();
    await act(async () => first.resolve(unavailable()));
    expect(await screen.findByRole('alert')).toHaveTextContent('The gallery could not be loaded.');
    expect(screen.queryByText('No unpublished photos.')).not.toBeInTheDocument();
  });

  it('locks only the photo being published and permits a single retry after failure', async () => {
    const first = deferred<Response>();
    const retry = deferred<Response>();
    let writes = 0;
    stubFetch((path, init) => {
      if (init.method === 'PATCH') return ++writes === 1 ? first.promise : retry.promise;
      if (path.includes('/media?')) return ok({ media: photos, nextCursor: null });
    });
    renderManager();
    const publish = await screen.findByRole('button', { name: 'Publish photo-0.jpg' });
    act(() => { fireEvent.click(publish); fireEvent.click(publish); });
    expect(writes).toBe(1);
    expect(screen.getByRole('button', { name: 'Publishing photo-0.jpg' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Hide photo-0.jpg' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Publish photo-1.jpg' })).toBeEnabled();
    await act(async () => first.resolve(unavailable()));
    const retryButton = await screen.findByRole('button', { name: 'Try again' });
    act(() => { fireEvent.click(retryButton); fireEvent.click(retryButton); });
    expect(writes).toBe(2);
    await act(async () => retry.resolve(ok({ media: guestPhoto })));
    await waitFor(() => expect(screen.queryByRole('button', { name: /photo-0.jpg/ })).not.toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('refreshes a conflicted publication instead of offering a stale write retry', async () => {
    let writes = 0;
    let reads = 0;
    stubFetch((path, init) => {
      if (init.method === 'PATCH') {
        writes += 1;
        return new Response(JSON.stringify({ code: 'MEDIA_STATE_CONFLICT', message: 'The photo has changed.' }), { status: 409 });
      }
      if (path.includes('/media?')) return ok({ media: ++reads === 1 ? photos : [photos[1]], nextCursor: null });
    });
    renderManager();
    await userEvent.click(await screen.findByRole('button', { name: 'Publish photo-0.jpg' }));
    await waitFor(() => expect(reads).toBe(2));
    expect(screen.getByRole('alert')).toHaveTextContent('Review its current status before trying again.');
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(writes).toBe(1);
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss notice' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Publication status' })).getByRole('button', { name: 'Unpublished' })).toHaveFocus();
  });

  it.each([false, true])('recovers gallery reads without a false empty state (fullscreen=%s)', async (fullscreen) => {
    const first = deferred<Response>();
    let reads = 0;
    stubFetch((path) => path.endsWith('/gallery') ? ++reads === 1 ? first.promise : ok({ media: [guestPhoto] }) : undefined);
    await renderGuest(fullscreen);
    expect(screen.getByText('Loading shared photos…')).toBeVisible();
    expect(screen.queryByText(/No shared photos yet|shared gallery is still quiet/)).not.toBeInTheDocument();
    await act(async () => first.resolve(unavailable()));
    expect(await screen.findByRole('alert')).toHaveTextContent('The gallery could not be loaded.');
    if (fullscreen) expect(screen.getByRole('link', { name: 'Close full-screen gallery' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('img', { name: 'Moment 0' })).toBeVisible();
    expect(fullscreen
      ? screen.getByRole('link', { name: 'Close full-screen gallery' })
      : screen.getByText('Shared gallery').closest('summary')).toHaveFocus();
    expect(reads).toBe(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each([false, true])('offers one manual preview retry and preserves caption and focus (fullscreen=%s)', async (fullscreen) => {
    stubFetch((path) => path.endsWith('/gallery') ? ok({ media: [guestPhoto] }) : undefined);
    await renderGuest(fullscreen);
    const photo = await screen.findByRole('img', { name: 'Moment 0' });
    const originalSource = photo.getAttribute('src');
    fireEvent.error(photo);
    const fallback = await screen.findByText('Preview unavailable');
    const figure = fallback.closest('figure')!;
    expect(within(figure).getByText('Moment 0')).toBeVisible();
    const retry = within(figure).getByRole('button', { name: 'Retry preview' });
    retry.focus();
    await userEvent.keyboard('{Enter}');
    expect(figure).toHaveFocus();
    const reloaded = within(figure).getByRole('img', { name: 'Moment 0' });
    expect(reloaded.getAttribute('src')).not.toBe(originalSource);
    fireEvent.error(reloaded);
    expect(within(figure).getByRole('button', { name: 'Retry preview' })).toBeEnabled();
  });

  it('retires old guest reads when the event changes, even if the transport ignores abort', async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    let firstSignal: AbortSignal | null | undefined;
    stubFetch((path, init) => {
      if (path === '/api/event/first/gallery') { firstSignal = init.signal; return first.promise; }
      if (path === '/api/event/second/gallery') return second.promise;
    });
    const { result, rerender } = renderHook(({ slug }) => useGuestGallery(slug, true), { initialProps: { slug: 'first' } });
    rerender({ slug: 'second' });
    expect(firstSignal?.aborted).toBe(true);
    await act(async () => second.resolve(ok({ media: [{ ...guestPhoto, caption: 'Second event' }] })));
    await act(async () => first.resolve(ok({ media: [guestPhoto] })));
    expect(result.current.media.map(({ caption }) => caption)).toEqual(['Second event']);
    expect(result.current.loaded).toBe(true);
  });

  it('gives an expired guest session a current-link recovery without a read retry loop', async () => {
    stubFetch((path) => path.endsWith('/gallery')
      ? new Response(JSON.stringify({ code: 'SESSION_EXPIRED', message: 'Your guest session has expired.' }), { status: 403 })
      : undefined);
    await renderGuest(true);
    expect(await screen.findByRole('alert')).toHaveTextContent('Open the latest guest link from your host');
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Close full-screen gallery' })).toBeVisible();
  });
});

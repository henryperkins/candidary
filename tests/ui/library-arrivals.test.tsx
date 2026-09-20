import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { StrictMode, type ComponentProps } from 'react';
import { ManagerPrivateGallery } from '../../src/features/gallery/ManagerPrivateGallery';
import { ManagerUndoProvider } from '../../src/features/gallery/undo';
import { EVENT_FIXTURE } from '../e2e/fixtures/routes';
import type { ManagerGalleryMediaView } from '../../shared/contracts';
import { useLibraryArrivals } from '../../src/features/gallery/use-library-arrivals';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
it('checks availability without reading pages and retains a confirmed count on transient failure', async () => {
  vi.useFakeTimers();
  const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({data:{afterSequence:2,snapshotSequence:5,count:3}}))).mockRejectedValueOnce(new Error('offline'));
  vi.stubGlobal('fetch',fetcher);
  const {result}=renderHook(() => useLibraryArrivals({eventId:'event-a',query:'',favorites:false,order:'newest',snapshotSequence:2,active:true,paused:false}));
  await act(async () => {});
  expect(result.current.count).toBe(3);
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(result.current.count).toBe(3);
  expect(fetcher.mock.calls[0]?.[0]).toContain('/gallery/arrivals?');
});

const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve=done; }); return {promise,resolve}; }
const hookOptions = {eventId:'event-a',query:'',favorites:false,order:'newest' as const,snapshotSequence:2,active:true,paused:false};
const settle = async () => { await act(async () => {}); };
it('pauses when hidden, suspended or covered and checks immediately on resume', async () => {
  vi.useFakeTimers(); let visible = 'hidden';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible as DocumentVisibilityState);
  const fetcher=vi.fn().mockImplementation(async () => ok({afterSequence:2,snapshotSequence:5,count:3})); vi.stubGlobal('fetch',fetcher);
  const {rerender}=renderHook(options => useLibraryArrivals(options), {initialProps:hookOptions});
  await settle(); expect(fetcher).not.toHaveBeenCalled();
  visible='visible'; await act(async () => { fireEvent(document,new Event('visibilitychange')); });
  expect(fetcher).toHaveBeenCalledTimes(1);
  rerender({...hookOptions,active:false}); await act(async () => { await vi.advanceTimersByTimeAsync(15000); }); expect(fetcher).toHaveBeenCalledTimes(1);
  rerender({...hookOptions,paused:true}); await settle(); expect(fetcher).toHaveBeenCalledTimes(1);
  rerender(hookOptions); await settle(); expect(fetcher).toHaveBeenCalledTimes(2);
});
it.each(['HOST_SESSION_REQUIRED','TOKEN_REVOKED','EVENT_NOT_FOUND'])('escalates %s and retires periodic checks for that owner', async code => {
  vi.useFakeTimers(); const onEscalate=vi.fn();
  const fetcher=vi.fn().mockImplementation(async () => new Response(JSON.stringify({code,message:'Access ended'}), {status:403})); vi.stubGlobal('fetch',fetcher);
  const {result,rerender}=renderHook(options => useLibraryArrivals({...options,onEscalate}),{initialProps:hookOptions});
  await settle(); expect(onEscalate).toHaveBeenCalledOnce();
  await act(async () => { await vi.advanceTimersByTimeAsync(20000); await result.current.checkNow(); });
  rerender({...hookOptions,query:'different'}); await settle(); expect(fetcher).toHaveBeenCalledTimes(1);
});
it('fences query and event changes and StrictMode replay even for abort-insensitive polls', async () => {
  const pending: ReturnType<typeof deferred<Response>>[]=[];
  vi.stubGlobal('fetch',vi.fn(() => {const next=deferred<Response>();pending.push(next);return next.promise;}));
  const {result,rerender}=renderHook(options => useLibraryArrivals(options),{initialProps:hookOptions,wrapper:StrictMode});
  expect(pending).toHaveLength(2);
  rerender({...hookOptions,query:'new',eventId:'event-b'});
  await act(async () => { pending[0]!.resolve(ok({afterSequence:2,snapshotSequence:8,count:6})); pending[1]!.resolve(ok({afterSequence:2,snapshotSequence:8,count:6})); });
  expect(result.current.count).toBe(0);
  await act(async () => {pending[2]!.resolve(ok({afterSequence:2,snapshotSequence:3,count:1}));}); expect(result.current.count).toBe(1);
});
function photo(id: string): ManagerGalleryMediaView & { deliverySequence: number } { const time = `2026-09-19T10:00:0${id.slice(1)}.000Z`; return {id,deliverySequence:Number(id.slice(1)),originalFilename:`${id}.jpg`,guestName:'Guest',caption:null,publicationStatus:'unpublished',previewAvailable:true,width:null,height:null,receivedAt:time,timelineAt:time,timelineSource:'received',isFavorite:false}; }
const props = {event:EVENT_FIXTURE,eventId:'event-a',pickCount:0,albumEntryCount:0,onPicksChanged:()=>{},invalidateGalleryAfterMutation:()=>{}};
function Library(extra: Partial<ComponentProps<typeof ManagerPrivateGallery>> = {}) {return <ManagerUndoProvider eventId={extra.eventId ?? 'event-a'}><ManagerPrivateGallery {...props} {...extra}/></ManagerUndoProvider>;}
const gridIds = () => Array.from(document.querySelectorAll<HTMLElement>('[data-photo-id]')).map(item => item.dataset.photoId);
function arrivalFixture() {
  const poll=deferred<Response>(); const staged=deferred<Response>(); const laterPoll=deferred<Response>(); const urls: URL[]=[];
  vi.stubGlobal('fetch',vi.fn(async (input: RequestInfo | URL) => {
    const url=new URL(String(input),'https://test'); urls.push(url);
    if (url.pathname.endsWith('/arrivals')) return url.searchParams.get('after') === '8' ? ok({afterSequence:8,snapshotSequence:9,count:1}) : urls.filter(item => item.pathname.endsWith('/arrivals')).length === 1 ? poll.promise : laterPoll.promise;
    if (url.searchParams.has('snapshot')) {
      if (url.searchParams.get('cursor') === 'fresh2') return staged.promise;
      return ok({media:['p8','p7','p6','p5'].map(photo),nextCursor:'fresh2',snapshotSequence:8});
    }
    if (url.searchParams.get('cursor') === 'old2') return ok({media:['p3','p2'].map(photo),nextCursor:'old3',snapshotSequence:5});
    if (url.searchParams.get('cursor') === 'old3') return ok({media:[photo('p1')],nextCursor:null,snapshotSequence:5});
    return ok({media:['p5','p4'].map(photo),nextCursor:'old2',snapshotSequence:5});
  }));
  return {poll,staged,laterPoll,urls};
}
it('keeps rows, viewer, selection and cursor steady on polls, then adopts the complete window atomically', async () => {
  vi.useFakeTimers(); const fixture=arrivalFixture(); const accepted=vi.fn(); render(Library({onArrivalsAccepted:accepted})); await settle();
  fireEvent.click(screen.getByRole('button',{name:'Load more photos'})); await settle();
  fireEvent.click(screen.getByRole('button',{name:'Select photos'})); fireEvent.click(screen.getByRole('button',{name:'Select p4.jpg, from Guest'}));
  await act(async () => {fixture.poll.resolve(ok({afterSequence:5,snapshotSequence:8,count:3}));});
  expect(gridIds()).toEqual(['p5','p4','p3','p2']); expect(screen.getByRole('button',{name:'Deselect p4.jpg, from Guest'})).toHaveAttribute('aria-pressed','true');
  const button=screen.getByRole('button',{name:'3 new photos'}); button.focus(); fireEvent.click(button); await settle();
  expect(gridIds()).toEqual(['p5','p4','p3','p2']);
  // User interaction during staging remains authoritative.
  fireEvent.click(screen.getByRole('button',{name:'Select p3.jpg, from Guest'}));
  await act(async () => {fixture.staged.resolve(ok({media:['p5','p4','p3','p2'].map(photo),nextCursor:'fresh3',snapshotSequence:8}));});
  expect(gridIds()).toEqual(['p8','p7','p6','p5','p4','p3','p2']);
  expect(screen.getByRole('button',{name:'Deselect p3.jpg, from Guest'})).toHaveAttribute('aria-pressed','true');
  expect(screen.getByRole('button',{name:'Deselect p4.jpg, from Guest'})).toHaveAttribute('aria-pressed','true');
  expect(document.activeElement).not.toBe(document.body); expect(accepted).toHaveBeenCalledOnce();
  expect(screen.getByRole('button',{name:'1 new photo'})).toBeInTheDocument();
  expect(fixture.urls.filter(url=>url.searchParams.has('snapshot')).every(url=>url.searchParams.get('order')==='newest'&&url.searchParams.get('live')==='1')).toBe(true);
});
it('keeps the open viewer steady when a poll settles', async () => {
  const fixture=arrivalFixture(); render(Library()); await settle();
  fireEvent.click(screen.getByRole('button',{name:'Open p4.jpg, from Guest'}));
  await act(async () => {fixture.poll.resolve(ok({afterSequence:5,snapshotSequence:8,count:3}));});
  expect(screen.getByRole('dialog')).toHaveTextContent('p4.jpg'); expect(gridIds()).toEqual(['p5','p4']);
});
it('leaves the original continuation usable after a failed second acceptance page', async () => {
  const fixture=arrivalFixture(); render(Library()); await settle();
  fireEvent.click(screen.getByRole('button',{name:'Load more photos'})); await settle();
  await act(async () => {fixture.poll.resolve(ok({afterSequence:5,snapshotSequence:8,count:3}));});
  fireEvent.click(screen.getByRole('button',{name:'3 new photos'})); await settle();
  await act(async () => {fixture.staged.resolve(new Response(JSON.stringify({code:'INTERNAL_ERROR',message:'offline'}),{status:503}));});
  expect(screen.getByText('Could not load new photos. Try again.')).toBeInTheDocument(); expect(gridIds()).toEqual(['p5','p4','p3','p2']);
  fireEvent.click(screen.getByRole('button',{name:'Load more photos'})); await settle();
  expect(gridIds()).toEqual(['p5','p4','p3','p2','p1']); expect(screen.getByRole('button',{name:'3 new photos'})).toBeInTheDocument();
});
it('retires staged acceptance when the host continues the old loaded window', async () => {
  const fixture=arrivalFixture(); render(Library()); await settle();
  await act(async () => {fixture.poll.resolve(ok({afterSequence:5,snapshotSequence:8,count:3}));});
  fireEvent.click(screen.getByRole('button',{name:'3 new photos'})); await settle();
  fireEvent.click(screen.getByRole('button',{name:'Load more photos'})); await settle();
  await act(async () => {fixture.staged.resolve(ok({media:['p5','p4'].map(photo),nextCursor:'fresh3',snapshotSequence:8}));});
  expect(gridIds()).toEqual(['p5','p4','p3','p2']); expect(screen.getByRole('button',{name:'3 new photos'})).toBeInTheDocument();
});
it.each(['order', 'search', 'album', 'event'] as const)('retires an acceptance failure after a successful %s replacement', async replacement => {
  const fixture = arrivalFixture(); const view = render(Library()); await settle();
  fireEvent.click(screen.getByRole('button', { name: 'Load more photos' })); await settle();
  await act(async () => { fixture.poll.resolve(ok({afterSequence:5,snapshotSequence:8,count:3})); });
  fireEvent.click(screen.getByRole('button', { name: '3 new photos' })); await settle();
  await act(async () => { fixture.staged.resolve(new Response(JSON.stringify({code:'INTERNAL_ERROR',message:'offline'}),{status:503})); });
  expect(screen.getByText('Could not load new photos. Try again.')).toBeInTheDocument();
  if (replacement === 'order') fireEvent.change(screen.getByRole('combobox', { name: 'Photo order' }), { target: { value: 'earliest' } });
  else if (replacement === 'search') {
    fireEvent.change(screen.getByRole('textbox', { name: 'Find photos' }), { target: { value: 'Guest' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  } else if (replacement === 'album') fireEvent.change(screen.getByRole('combobox', { name: 'Photos shown' }), { target: { value: 'album' } });
  else view.rerender(Library({ eventId: 'event-b' }));
  await settle();
  expect(gridIds()).toEqual(['p5', 'p4']);
  expect(screen.queryByRole('button', { name: '3 new photos' })).not.toBeInTheDocument();
  expect(screen.queryByText('Could not load new photos. Try again.')).not.toBeInTheDocument();
});
it.each(['earliest', 'newest'] as const)('waits for the counted arrival beyond the old %s boundary before adopting', async order => {
  const laterPage = deferred<Response>(); const accepted = vi.fn();
  const arrived = { ...photo('p6'), timelineAt: order === 'earliest' ? '2026-09-19T11:00:00.000Z' : '2026-09-19T09:00:00.000Z' };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'https://test');
    if (url.pathname.endsWith('/arrivals')) return ok({afterSequence:5,snapshotSequence:6,count:1});
    if (url.searchParams.has('snapshot')) return url.searchParams.has('cursor') ? laterPage.promise : ok({media:[photo('p5')],nextCursor:'two',snapshotSequence:6});
    return ok({media:[photo('p5')],nextCursor:null,snapshotSequence:5});
  }));
  render(Library({ onArrivalsAccepted: accepted })); await settle();
  if (order === 'earliest') {
    fireEvent.change(screen.getByRole('combobox', { name: 'Photo order' }), { target: { value: order } }); await settle();
  }
  fireEvent.click(screen.getByRole('button', { name: '1 new photo' })); await settle();
  expect(gridIds()).toEqual(['p5']);
  expect(accepted).not.toHaveBeenCalled();
  await act(async () => { laterPage.resolve(ok({media:[arrived],nextCursor:null,snapshotSequence:6})); });
  expect(gridIds()).toEqual(['p5', 'p6']);
  expect(accepted).toHaveBeenCalledOnce();
});
it('retains browsing state when suspended and fences a confirmed trash against staged rows', async () => {
  const fixture=arrivalFixture(); const view=render(Library()); await settle();
  fireEvent.click(screen.getByRole('button',{name:'Select photos'})); fireEvent.click(screen.getByRole('button',{name:'Select p4.jpg, from Guest'}));
  await act(async () => {fixture.poll.resolve(ok({afterSequence:5,snapshotSequence:8,count:3}));});
  fireEvent.click(screen.getByRole('button',{name:'3 new photos'})); await settle();
  view.rerender(Library({suspended:true,libraryChange:{version:1,eventId:'event-a',kind:'trashed',mediaIds:['p5']}}));
  await act(async () => {fixture.staged.resolve(ok({media:['p5','p4'].map(photo),nextCursor:null,snapshotSequence:8}));});
  expect(gridIds()).toEqual(['p4']);
  view.rerender(Library({libraryChange:{version:1,eventId:'event-a',kind:'trashed',mediaIds:['p5']}})); await settle();
  expect(screen.getByRole('button',{name:'Deselect p4.jpg, from Guest'})).toHaveAttribute('aria-pressed','true');
});

it('ignores a later obsolete poll while acceptance owns the observed sequence', async () => {
  vi.useFakeTimers(); const fixture=arrivalFixture(); render(Library()); await settle();
  await act(async () => {fixture.poll.resolve(ok({afterSequence:5,snapshotSequence:8,count:3})); await vi.advanceTimersByTimeAsync(5000);});
  fireEvent.click(screen.getByRole('button',{name:'3 new photos'})); await settle();
  await act(async () => {fixture.laterPoll.resolve(ok({afterSequence:5,snapshotSequence:9,count:4}));});
  expect(screen.queryByRole('button',{name:'4 new photos'})).not.toBeInTheDocument();
  await act(async () => {fixture.staged.resolve(ok({media:['p5','p4'].map(photo),nextCursor:null,snapshotSequence:8}));});
  expect(screen.getByRole('button',{name:'1 new photo'})).toBeInTheDocument();
});
it('retires staged acceptance when the query changes', async () => {
  const fixture=arrivalFixture(); render(Library()); await settle();
  await act(async () => {fixture.poll.resolve(ok({afterSequence:5,snapshotSequence:8,count:3}));});
  fireEvent.click(screen.getByRole('button',{name:'3 new photos'})); await settle();
  fireEvent.change(screen.getByRole('combobox',{name:'Photo order'}),{target:{value:'earliest'}}); await settle();
  await act(async () => {fixture.staged.resolve(ok({media:['p8','p7','p6','p5','p4'].map(photo),nextCursor:null,snapshotSequence:8}));});
  expect(gridIds()).toEqual(['p5','p4']); expect(screen.getByRole('combobox',{name:'Photo order'})).toHaveValue('earliest');
});
it('reconciles metadata at the accepted sequence even after a prior delivered signal', async () => {
  const calls: URL[]=[]; let changed=false;
  vi.stubGlobal('fetch',vi.fn(async (input: RequestInfo | URL) => {
    const url=new URL(String(input),'https://test'); calls.push(url);
    if (url.pathname.endsWith('/arrivals')) return ok({afterSequence:5,snapshotSequence:8,count:3});
    return ok({media:[{...photo('p5'),isFavorite:changed}],nextCursor:null,snapshotSequence:5});
  }));
  const delivered={version:1,eventId:'event-a',kind:'delivered' as const,mediaIds:['p8']};
  const view=render(Library()); await settle();
  view.rerender(Library({libraryChange:delivered})); await settle();
  changed=true; view.rerender(Library({libraryChange:delivered,reconciliationVersion:'1'})); await settle();
  expect(screen.getByRole('button',{name:'In album: Remove p5.jpg from Album'})).toBeInTheDocument();
  expect(calls.filter(url=>url.searchParams.has('snapshot')).map(url=>url.searchParams.get('snapshot'))).toEqual(['5']);
});

function reconciliationFixture() {
  const firstRefresh = deferred<Response>();
  const refreshes: URL[] = [];
  const urls: URL[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'https://test'); urls.push(url);
    if (url.pathname.endsWith('/arrivals')) return ok({ afterSequence: 5, snapshotSequence: 5, count: 0 });
    if (url.searchParams.has('snapshot')) {
      refreshes.push(url);
      if (refreshes.length === 1) return firstRefresh.promise;
      return ok({ media: ['p5','p4','p3','p2'].map(id => ({ ...photo(id), isFavorite: id === 'p5' })), nextCursor: null, snapshotSequence: 5 });
    }
    if (url.searchParams.get('cursor') === 'old2') return ok({ media: ['p3','p2'].map(photo), nextCursor: null, snapshotSequence: 5 });
    return ok({ media: ['p5','p4'].map(photo), nextCursor: 'old2', snapshotSequence: 5 });
  }));
  return { firstRefresh, refreshes, urls };
}
it.each(['readsPaused','suspended','active'] as const)('resumes a pending restored/metadata obligation after %s cancellation', async gate => {
  const fixture = reconciliationFixture(); const view = render(Library()); await settle();
  fireEvent.click(screen.getByRole('button', { name: 'Select photos' }));
  fireEvent.click(screen.getByRole('button', { name: 'Select p4.jpg, from Guest' }));
  const change = { version: 1, eventId: 'event-a', kind: 'restored' as const, mediaIds: ['p5'] };
  view.rerender(Library({ libraryChange: change })); await settle();
  expect(fixture.refreshes).toHaveLength(1);
  view.rerender(Library({ libraryChange: change, [gate]: gate === 'active' ? false : true })); await settle();
  view.rerender(Library({ libraryChange: change })); await settle();
  expect(fixture.refreshes).toHaveLength(2);
  expect(fixture.refreshes.every(url => url.searchParams.get('snapshot') === '5')).toBe(true);
  expect(document.querySelector('[data-photo-id="p5"]')).toHaveTextContent('In album');
  await act(async () => { fixture.firstRefresh.resolve(ok({media:['p5','p4'].map(photo),nextCursor:'stale',snapshotSequence:5})); });
  expect(document.querySelector('[data-photo-id="p5"]')).toHaveTextContent('In album');
  if (gate !== 'active') expect(screen.getByRole('button', { name: 'Deselect p4.jpg, from Guest' })).toHaveAttribute('aria-pressed', 'true');
});
it('retries a pending metadata obligation after continuation cancels its staged window', async () => {
  const fixture = reconciliationFixture(); const view = render(Library()); await settle();
  const change = { version: 1, eventId: 'event-a', kind: 'metadata' as const, mediaIds: ['p5'] };
  view.rerender(Library({ libraryChange: change })); await settle();
  fireEvent.click(screen.getByRole('button', { name: 'Load more photos' })); await settle();
  expect(fixture.refreshes).toHaveLength(2);
  expect(gridIds()).toEqual(['p5','p4','p3','p2']);
  expect(document.querySelector('[data-photo-id="p5"]')).toHaveTextContent('In album');
  await act(async () => { fixture.firstRefresh.resolve(ok({media:['p5','p4'].map(photo),nextCursor:'stale',snapshotSequence:5})); });
  expect(gridIds()).toEqual(['p5','p4','p3','p2']);
});
it('retains a failed reconciliation for explicit retry without spinning or resetting selection', async () => {
  vi.useFakeTimers(); const fixture = reconciliationFixture(); const view = render(Library()); await settle();
  fireEvent.click(screen.getByRole('button', { name: 'Select photos' }));
  fireEvent.click(screen.getByRole('button', { name: 'Select p4.jpg, from Guest' }));
  view.rerender(Library({ reconciliationVersion: '1' })); await settle();
  await act(async () => { fixture.firstRefresh.resolve(new Response(JSON.stringify({code:'INTERNAL_ERROR',message:'Refresh failed'}),{status:503})); });
  await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
  expect(fixture.refreshes).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Try again' })); await settle();
  expect(fixture.refreshes).toHaveLength(2);
  expect(screen.getByRole('button', { name: 'Deselect p4.jpg, from Guest' })).toHaveAttribute('aria-pressed', 'true');
  expect(document.querySelector('[data-photo-id="p5"]')).toHaveTextContent('In album');
});
it('reloads a formerly confirmed query after another query fails so its snapshot and continuation work', async () => {
  const urls: URL[] = [];
  vi.stubGlobal('fetch',vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input),'https://test'); urls.push(url);
    if (url.pathname.endsWith('/arrivals')) return ok({afterSequence:5,snapshotSequence:5,count:0});
    if (url.searchParams.get('query') === 'missing') return new Response(JSON.stringify({code:'INTERNAL_ERROR',message:'Search failed'}),{status:503});
    if (url.searchParams.get('cursor') === 'old2') return ok({media:[photo('p3')],nextCursor:null,snapshotSequence:5});
    return ok({media:['p5','p4'].map(photo),nextCursor:'old2',snapshotSequence:5});
  }));
  render(Library()); await settle();
  fireEvent.change(screen.getByRole('textbox',{name:'Find photos'}),{target:{value:'missing'}});
  fireEvent.click(screen.getByRole('button',{name:'Search'})); await settle();
  expect(screen.getByText('Search failed')).toBeInTheDocument();
  const pollsBeforeReturn = urls.filter(url => url.pathname.endsWith('/arrivals')).length;
  fireEvent.click(screen.getByRole('button',{name:'Clear search'})); await settle();
  expect(urls.filter(url => url.pathname.endsWith('/arrivals'))).toHaveLength(pollsBeforeReturn + 1);
  fireEvent.click(screen.getByRole('button',{name:'Load more photos'})); await settle();
  expect(gridIds()).toEqual(['p5','p4','p3']);
  expect(urls.some(url => url.searchParams.get('cursor') === 'old2')).toBe(true);
});

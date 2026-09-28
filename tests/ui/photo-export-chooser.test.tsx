import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PhotoExportChooser } from '../../src/features/gallery/PhotoExportChooser';
import type { PhotoExportView } from '../../shared/photo-exports';
const source = { mode: 'ids', scope: 'library', mediaIds: ['photo-a'] } as const;
const job: PhotoExportView = { id: 'job-a', kind: 'selection', destination: 'device', source: { ...source, mediaIds: ['photo-a'] }, state: 'queued', snapshotAt: '2026-09-12T12:00:00Z', createdAt: '2026-09-12T12:00:00Z', confirmedAt: null, completedAt: null, mediaCount: 1, totalBytes: 2, handedOffCount: 0, unavailableCount: 0, holdExpiresAt: '2026-09-13T12:00:00Z', absoluteExpiresAt: '2026-09-14T12:00:00Z', cancelRequested: false, errorCode: null, attempt: 1 };
function ok(data: unknown) { return Promise.resolve(new Response(JSON.stringify({ data, requestId: 'r' }), { headers: { 'content-type': 'application/json' } })); }
function fixture(options: { paused?: boolean; ackFails?: boolean; retired?: boolean } = {}) {
  let ackFailed = false;
  return vi.fn<typeof fetch>((input) => {
    const path = String(input);
    if (path.endsWith('/capabilities')) return ok({ enabled: !options.paused, destinations: ['device', 'archive'], activeJob: options.paused ? { ...job, ownedByCurrentPrincipal: true } : null });
    if (path.endsWith('/file')) return Promise.resolve(new Response('ab', { headers: { 'content-type': 'image/jpeg' } }));
    if (path.includes('/entries?')) return ok({ entries: [{ mediaId: 'photo-a', position: 1, filename: 'original.jpg', mimeType: 'image/jpeg', byteSize: 2, state: 'pending' }], nextPosition: null });
    if (path.endsWith('/handoff')) {
      if (options.ackFails && !ackFailed) { ackFailed = true; return Promise.reject(new TypeError('offline')); }
      return ok({ export: { ...job, confirmedAt: job.createdAt, state: 'handed-off', handedOffCount: 1 } });
    }
    return ok({ export: { ...job, ...(path.endsWith('/confirm') ? { confirmedAt: job.createdAt, state: 'running' } : {}), cancelRequested: !!options.retired } });
  });
}
const props = () => ({ eventId: 'event-a', source: { ...source, mediaIds: ['photo-a'] }, onClose: vi.fn(), onJobChanged: vi.fn() });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); Reflect.deleteProperty(navigator, 'share'); Reflect.deleteProperty(navigator, 'canShare'); });
describe('photo export chooser', () => {
  it('offers ZIP when canShare refuses the actual original Files and never records a device handoff',async () => {
    const fallback=fixture();
    const fetcher=vi.fn<typeof fetch>((input,init) => String(input).endsWith('/archive')
      ? ok({export:{...job,id:'archive-b',destination:'archive'}}) : fallback(input,init));
    vi.stubGlobal('fetch',fetcher);
    const share=vi.fn(); const canShare=vi.fn(({files}:{files:File[]}) => {expect(files[0]).toBeInstanceOf(File); return false;});
    Object.defineProperties(navigator,{share:{configurable:true,value:share},canShare:{configurable:true,value:canShare}});
    render(<PhotoExportChooser {...props()} />);
    fireEvent.click(await screen.findByRole('button',{name:'Prepare for this device'}));
    fireEvent.click(await screen.findByRole('button',{name:'Confirm and prepare photos'}));
    fireEvent.click(await screen.findByRole('button',{name:'Share 1 photo'}));
    expect(await screen.findByText(/cannot share these original files/)).toBeVisible();
    expect(share).not.toHaveBeenCalled(); expect(fetcher.mock.calls.some(([path]) => String(path).endsWith('/handoff'))).toBe(false);
    fireEvent.click(screen.getByRole('button',{name:'Use ZIP instead'}));
    expect(await screen.findByRole('button',{name:'Confirm photo ZIP'})).toBeEnabled();
  });
  it('freezes and confirms before a fresh actual-File Share gesture, then retries only the ACK', async () => {
    const fetcher = fixture({ ackFails: true }); vi.stubGlobal('fetch', fetcher);
    const share = vi.fn().mockResolvedValue(undefined); const canShare = vi.fn().mockReturnValue(true);
    Object.defineProperties(navigator, { share: { configurable: true, value: share }, canShare: { configurable: true, value: canShare } });
    render(<PhotoExportChooser {...props()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Prepare for this device' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm and prepare photos' }));
    const button = await screen.findByRole('button', { name: 'Share 1 photo' });
    expect(share).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(share).toHaveBeenCalledTimes(1); expect(share.mock.calls[0]![0].files[0]).toBeInstanceOf(File);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry handoff receipt' }));
    await screen.findByText('Handed to your device: 1'); expect(share).toHaveBeenCalledTimes(1);
    expect(canShare.mock.calls[0]![0].files[0].name).toBe('original.jpg');
    expect(screen.queryByRole('button', { name: 'Use ZIP instead' })).toBeNull();
  });
  it('keeps AbortError files without ACK and exposes explicit ZIP fallback', async () => {
    const fetcher = fixture(); vi.stubGlobal('fetch', fetcher);
    Object.defineProperties(navigator, { share: { configurable: true, value: vi.fn().mockRejectedValue(new DOMException('Cancelled', 'AbortError')) }, canShare: { configurable: true, value: () => true } });
    render(<PhotoExportChooser {...props()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Prepare for this device' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm and prepare photos' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Share 1 photo' }));
    await screen.findByText(/Sharing was cancelled/);
    expect(fetcher.mock.calls.some(([path]) => String(path).endsWith('/handoff'))).toBe(false);
    expect(screen.getByRole('button', { name: 'Use ZIP instead' })).toBeEnabled();
  });
  it.each(['library', 'album'] as const)('keeps Resume and Cancel available to a paused %s owner, including retirement', async scope => {
    vi.stubGlobal('fetch', fixture({ paused: true, retired: true }));
    render(<PhotoExportChooser {...props()} source={{ ...props().source, scope }} onPrepareFullArchive={vi.fn()} />);
    const resume = await screen.findByRole('button', { name: 'Resume photo export' });
    if (scope === 'album') expect(screen.getByRole('button', { name: 'Prepare entire Album ZIP' })).toBeDisabled();
    fireEvent.click(resume);
    expect(await screen.findByRole('button', { name: 'Retry ZIP fallback' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Cancel photo export' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /Share 1/ })).toBeNull();
    if (scope === 'album') expect(screen.queryByRole('button', { name: 'Prepare entire Album ZIP' })).toBeNull();
  });

  it('recovers receipt uncertainty after remount without reading or sharing the photos again', async () => {
    const fetcher = fixture({ ackFails: true }); vi.stubGlobal('fetch', fetcher);
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperties(navigator, { share: { configurable: true, value: share }, canShare: { configurable: true, value: () => true } });
    const mounted = render(<PhotoExportChooser {...props()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Prepare for this device' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm and prepare photos' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Share 1 photo' }));
    await screen.findByRole('button', { name: 'Retry handoff receipt' });
    mounted.unmount();
    render(<PhotoExportChooser {...props()} resumeJobId="job-a" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry handoff receipt' }));
    await screen.findByText('Handed to your device: 1');
    expect(share).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls.filter(([path]) => String(path).endsWith('/file'))).toHaveLength(1);
  });

  it('aborts a stale source preparation and never adopts its late result', async () => {
    const original = fixture(); let resolve!: (value: Response) => void; let fileSignal: AbortSignal | undefined;
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/file')) { fileSignal = init?.signal as AbortSignal; return new Promise<Response>(yes => { resolve = yes; }); }
      return original(input, init);
    });
    vi.stubGlobal('fetch', fetcher);
    const onJobChanged = vi.fn(); const mounted = render(<PhotoExportChooser {...props()} onJobChanged={onJobChanged} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Prepare for this device' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm and prepare photos' }));
    await waitFor(() => expect(fileSignal).toBeDefined());
    mounted.rerender(<PhotoExportChooser {...props()} source={{ mode: 'ids', scope: 'album', mediaIds: ['other'] }} onJobChanged={onJobChanged} />);
    expect(fileSignal?.aborted).toBe(true);
    await act(async () => resolve(new Response('ab', { headers: { 'content-type': 'image/jpeg' } })));
    expect(screen.queryByRole('button', { name: 'Share 1 photo' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Prepare for this device' })).toBeEnabled();
  });

  it('preserves the whole frozen ZIP and old handoff receipt across a fallback remount', async () => {
    const original = fixture(); const archive = { ...job, id: 'archive-a', destination: 'archive', mediaCount: 3, totalBytes: 6 };
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith('/job-a')) return ok({ export: { ...job, state: 'running', confirmedAt: job.createdAt, mediaCount: 3, handedOffCount: 1 } });
      if (path.endsWith('/archive')) return ok({ export: archive });
      if (path.endsWith('/archive-a')) return ok({ export: archive });
      if (path.endsWith('/confirm')) return ok({ export: { ...archive, state: 'ready', confirmedAt: job.createdAt } });
      if (path.endsWith('/download')) return ok({ parts: [{ partNumber: 1, url: '/private/zip', mediaCount: 3, sourceBytes: 6 }] });
      return original(input, init);
    });
    vi.stubGlobal('fetch', fetcher);
    const mounted = render(<PhotoExportChooser {...props()} resumeJobId="job-a" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Use ZIP instead' }));
    await screen.findByRole('button', { name: 'Confirm photo ZIP' });
    expect(screen.getByText('Handed to your device: 1')).toBeVisible();
    mounted.unmount(); render(<PhotoExportChooser {...props()} resumeJobId="archive-a" />);
    expect(await screen.findByText('Handed to your device: 1')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm photo ZIP' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Get ZIP download links' }));
    expect(await screen.findByRole('link', { name: 'Photo ZIP part 1 of 1' })).toHaveAttribute('href', '/private/zip');
    expect(screen.getByText(/ZIP includes the complete frozen selection/)).toBeVisible();
  });

  it('waits for the current Album draft immediately before freezing and keeps unresolved changes recoverable', async () => {
    const fetcher = fixture(); vi.stubGlobal('fetch', fetcher);
    const settle = vi.fn().mockResolvedValue(false);
    render(<PhotoExportChooser {...props()} source={{ mode: 'all', scope: 'album', excludedMediaIds: [] }} onBeforeSnapshot={settle} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Prepare for this device' }));
    await screen.findByText(/Save the current Album changes/);
    expect(fetcher.mock.calls.some(([path, init]) => String(path).endsWith('/photo-exports') && init?.method === 'POST')).toBe(false);
    settle.mockResolvedValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Prepare for this device' }));
    await screen.findByRole('button', { name: 'Confirm and prepare photos' });
    expect(settle).toHaveBeenCalledTimes(2);
  });
});

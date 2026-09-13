import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { PhotoExportActiveConflict, PhotoExportCapabilities, PhotoExportEntryView, PhotoExportSource, PhotoExportView } from '../../../shared/photo-exports';
import { api, apiEnvelope } from '../../app/api';
import { formatBytes } from '../../app/format';
import type { ExportDownloadView } from '../../app/types';
import { prepareDeviceBatch, readPhotoExportFile, readDeviceReceipt, saveDeviceReceipt, type DeviceBatch, type PendingDeviceReceipt } from './photo-export-device';

const basePath = (eventId: string) => `/api/manage/events/${encodeURIComponent(eventId)}/photo-exports`;
const message = (error: unknown) => error instanceof Error ? error.message : 'The export could not be updated. Try again.';
const fallbackReceiptKey = (eventId: string, jobId: string) => `candidary-photo-archive-receipt:${eventId}:${jobId}`;
const fallbackRequestKey = (eventId: string, jobId: string) => `candidary-photo-archive-request:${eventId}:${jobId}`;
function priorHandoffCount(eventId: string, jobId: string): number {
  try { const count = Number(sessionStorage.getItem(fallbackReceiptKey(eventId, jobId))); return Number.isSafeInteger(count) && count >= 0 ? count : 0; } catch { return 0; }
}
export function usePhotoExportCapabilities(eventId: string) {
  const [capabilities, setCapabilities] = useState<PhotoExportCapabilities | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    void api<PhotoExportCapabilities>(`${basePath(eventId)}/capabilities`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) { setCapabilities(value); setError(null); } })
      .catch(error => { if (!controller.signal.aborted) { setCapabilities(null); setError(message(error)); } });
    return () => controller.abort();
  }, [eventId, revision]);
  return { capabilities, error, refresh };
}

export function PhotoExportEntryActions({ capabilities, error, onOpen, onResume, onCancel, onRetry, actionDock, recentJob, scope = 'library', chooserOpen = false }: {
  capabilities: PhotoExportCapabilities | null; error: string | null;
  onOpen(origin: HTMLElement): void; onResume(origin: HTMLElement): void; onCancel(): void;
  onRetry(): void;
  actionDock?: HTMLElement | null;
  recentJob?: PhotoExportView | null;
  scope?: 'library' | 'album';
  chooserOpen?: boolean;
}) {
  const active = capabilities?.activeJob;
  const album = scope === 'album';
  const showPrimary = !album || (capabilities?.enabled === true && !active);
  const showActive = active && (!album || active.kind === 'selection');
  if (album && (chooserOpen || (!showPrimary && !showActive && !recentJob && !error))) return null;
  const primary = showPrimary ? <button type="button" className={`button button--${album ? 'secondary' : 'primary'}`} data-photo-export-origin="save" disabled={!capabilities?.enabled || !!active} onClick={event => onOpen(event.currentTarget)}>Save / Share photos</button> : null;
  return <div className="photo-export-entry">
    {actionDock ? createPortal(primary, actionDock) : primary}
    {showActive && (active.ownedByCurrentPrincipal && active.kind === 'selection'
      ? <div className="photo-export-actions"><button type="button" className="button button--secondary" data-photo-export-origin="receipt" onClick={event => onResume(event.currentTarget)}>Resume photo export</button><button type="button" className="button button--secondary" onClick={onCancel}>Cancel photo export</button></div>
      : <p>{active.kind === 'selection' ? `${active.destination} photo export` : `${active.kind} archive`}: {active.state}. This operation must finish or expire before another export can start.</p>)}
    {!active && recentJob && <div><p>{recentJob.destination === 'archive' ? 'Photo ZIP' : 'Device photo export'}: {recentJob.state}. {recentJob.mediaCount.toLocaleString()} photos.{recentJob.destination === 'device' && ` Handed to your device: ${recentJob.handedOffCount}.`}</p><button type="button" className="text-button" data-photo-export-origin="receipt" onClick={event => onResume(event.currentTarget)}>View photo export</button></div>}
    {!album && capabilities && !capabilities.enabled && <p>New photo exports are paused. Your existing export can still be resumed or cancelled.</p>}
    {error && <p role="alert">{error} <button type="button" className="text-button" onClick={onRetry}>Check again</button></p>}
  </div>;
}

interface PhotoExportChooserProps {
  eventId: string;
  source: PhotoExportSource;
  onClose(): void;
  onJobChanged(job?: PhotoExportView): void;
  onPrepareFullArchive?(): Promise<void>;
  onBeforeSnapshot?(): Promise<boolean>;
  resumeJobId?: string;
}

export function PhotoExportChooser({ eventId, source, onClose, onJobChanged, onPrepareFullArchive, onBeforeSnapshot, resumeJobId }: PhotoExportChooserProps) {
  const { capabilities, error: capabilityError, refresh } = usePhotoExportCapabilities(eventId);
  const [job, setJob] = useState<PhotoExportView | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [batch, setBatch] = useState<DeviceBatch | null>(null);
  const [failed, setFailed] = useState<Set<string>>(() => new Set());
  const [receipt, setReceipt] = useState<PendingDeviceReceipt | null>(null);
  const [download, setDownload] = useState<ExportDownloadView | null>(null);
  const [priorHandoffs, setPriorHandoffs] = useState(0);
  const [conflict, setConflict] = useState<PhotoExportCapabilities['activeJob']>(null);
  const owner = useRef(new AbortController());
  const currentJob = useRef<PhotoExportView | null>(null);
  const callbacks = useRef({ onJobChanged }); callbacks.current = { onJobChanged };
  const createKeys = useRef(new Map<string, string>());
  const fallbackKey = useRef(crypto.randomUUID());
  const heading = useRef<HTMLHeadingElement>(null);
  const sourceKey = JSON.stringify(source);

  useLayoutEffect(() => {
    const controller = new AbortController(); owner.current = controller;
    currentJob.current = null; setJob(null); setBatch(null); setFailed(new Set()); setReceipt(null); setError(null); setDownload(null); setPriorHandoffs(0); setBusy(false); busyRef.current = false;
    createKeys.current.clear(); fallbackKey.current = crypto.randomUUID();
    heading.current?.focus();
    return () => { controller.abort(); };
  }, [eventId, sourceKey, resumeJobId]);

  function adopt(next: PhotoExportView, signal: AbortSignal) {
    if (signal.aborted) return;
    currentJob.current = next; setJob(next); callbacks.current.onJobChanged(next); refresh();
  }
  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (busyRef.current) return;
    const signal = owner.current.signal; busyRef.current = true; setBusy(true); setError(null);
    try { await action(signal); }
    catch (caught) { if (!signal.aborted) setError(message(caught)); }
    finally { if (!signal.aborted) { busyRef.current = false; setBusy(false); } }
  }
  async function getJob(id: string, signal: AbortSignal) {
    const result = await api<{ export: PhotoExportView }>(`${basePath(eventId)}/${id}`, { signal });
    adopt(result.export, signal);
    if (!signal.aborted) { setReceipt(readDeviceReceipt(eventId, id)); setPriorHandoffs(priorHandoffCount(eventId, id)); }
  }
  useEffect(() => {
    if (resumeJobId) void run(signal => getJob(resumeJobId, signal));
  }, [eventId, sourceKey, resumeJobId]);

  async function mutation(id: string, action: string, signal: AbortSignal, body?: unknown) {
    const result = await api<{ export: PhotoExportView }>(`${basePath(eventId)}/${id}/${action}`, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body), signal });
    adopt(result.export, signal); return result.export;
  }
  async function freeze(destination: 'device' | 'archive', signal: AbortSignal) {
    if (onBeforeSnapshot && !(await onBeforeSnapshot())) throw new Error('Save the current Album changes before preparing its photos.');
    if (signal.aborted) return;
    const key = createKeys.current.get(destination) ?? crypto.randomUUID(); createKeys.current.set(destination, key);
    const response = await apiEnvelope<{ export: PhotoExportView } | PhotoExportActiveConflict>(basePath(eventId), { method: 'POST', signal, body: JSON.stringify({ version: 1, idempotencyKey: key, source, destination }) });
    if (signal.aborted) return;
    if ('kind' in response.data) { setConflict(response.data.activeJob); refresh(); return; }
    adopt(response.data.export, signal);
  }
  async function prepare(next: PhotoExportView, signal: AbortSignal, smaller = false) {
    if (next.cancelRequested || readDeviceReceipt(eventId, next.id)) return;
    setBatch(null);
    const entries: PhotoExportEntryView[] = []; let after = 0; const maxFiles = smaller ? 5 : 20;
    do {
      const page = await api<{ entries: PhotoExportEntryView[]; nextPosition: number | null }>(`${basePath(eventId)}/${next.id}/entries?after=${after}&limit=100`, { signal });
      for (const entry of page.entries) {
        if (entry.state !== 'acknowledged' && (smaller || !failed.has(entry.mediaId))) entries.push(entry);
        if (entries.length >= maxFiles) break;
      }
      if (entries.length >= maxFiles || page.nextPosition === null) break;
      if (page.nextPosition <= after) throw new Error('Photo progress could not be read. Refresh this export.');
      after = page.nextPosition;
    } while (!signal.aborted);
    const prepared = await prepareDeviceBatch(entries, (entry, readSignal) => readPhotoExportFile(eventId, next.id, entry, readSignal), signal, { maxFiles });
    if (signal.aborted) return;
    setBatch(prepared); setFailed(current => {
      const updated = new Set(current); prepared.preparedIds.forEach(id => updated.delete(id)); prepared.failedIds.forEach(id => updated.add(id)); return updated;
    });
  }
  async function acknowledge(next: PhotoExportView, pending: PendingDeviceReceipt, signal: AbortSignal) {
    if (next.cancelRequested) return;
    await mutation(next.id, 'handoff', signal, { mediaIds: pending.mediaIds });
    // Persistence is independent of component lifetime: a completed receipt must retire its intent.
    saveDeviceReceipt(eventId, next.id, null);
    if (!signal.aborted) { setReceipt(null); setBatch(null); }
  }
  function sharePrepared() {
    if (!job || !batch?.files.length || busyRef.current || job.cancelRequested || receipt) return;
    const next = job; const files = batch.files; const signal = owner.current.signal;
    let nativeShare: Promise<void>;
    try {
      if (!navigator.canShare?.({ files }) || !navigator.share) throw new Error('This device cannot share these original files. Try a smaller batch or use ZIP.');
      const pending: PendingDeviceReceipt = { mediaIds: [...batch.preparedIds], stage: 'sharing' };
      saveDeviceReceipt(eventId, next.id, pending);
      // No await precedes this native call: it belongs to the fresh Share button gesture.
      nativeShare = navigator.share({ files });
      setReceipt(pending); busyRef.current = true; setBusy(true); setError(null);
    } catch (caught) { saveDeviceReceipt(eventId, next.id, null); setError(message(caught)); return; }
    void nativeShare.then(async () => {
      const pending: PendingDeviceReceipt = { mediaIds: [...batch.preparedIds], stage: 'handed-off' };
      saveDeviceReceipt(eventId, next.id, pending);
      if (signal.aborted) return;
      setReceipt(pending); setBatch(null);
      try { await acknowledge(next, pending, signal); }
      catch { if (!signal.aborted) setError('Your device received the handoff, but its receipt could not be confirmed. Retry the receipt without sharing again.'); }
    }, caught => {
      saveDeviceReceipt(eventId, next.id, null);
      if (signal.aborted) return;
      setReceipt(null); setError(caught instanceof DOMException && caught.name === 'AbortError' ? 'Sharing was cancelled. Your prepared photos are still here.' : 'Sharing could not finish. Try the batch again, prepare fewer photos, or use ZIP.');
    }).finally(() => { if (!signal.aborted) { busyRef.current = false; setBusy(false); } });
  }
  async function fallback(signal: AbortSignal) {
    if (!job) return;
    setBatch(null);
    const requestStorageKey = fallbackRequestKey(eventId, job.id);
    const key = sessionStorage.getItem(requestStorageKey) ?? fallbackKey.current;
    sessionStorage.setItem(requestStorageKey, key);
    try {
      const next = await mutation(job.id, 'archive', signal, { idempotencyKey: key });
      if (next.destination === 'archive') sessionStorage.setItem(fallbackReceiptKey(eventId, next.id), String(job.handedOffCount));
      if (!signal.aborted && next.destination === 'archive') { setPriorHandoffs(job.handedOffCount); setReceipt(null); setDownload(null); }
    } catch (caught) {
      // Busy retirement is recoverable; refresh the public cancellation state before retry.
      await getJob(job.id, signal).catch(() => {}); throw caught;
    }
  }
  const active = conflict ?? capabilities?.activeJob;
  const unavailable = Math.max(job?.unavailableCount ?? 0, failed.size);
  const remaining = Math.max(0, (job?.mediaCount ?? 0) - (job?.handedOffCount ?? 0) - unavailable);
  const terminal = job && ['ready', 'failed', 'expired', 'cancelled', 'handed-off', 'delivered'].includes(job.state);
  const albumSource = source.scope === 'album';
  const wholeAlbum = albumSource && source.mode === 'all' && source.excludedMediaIds.length === 0;
  let content: ReactNode;
  if (!job) content = <>
    {albumSource ? <p>
      {source.mode === 'ids'
        ? `Choose how to save your ${source.mediaIds.length.toLocaleString()} selected ${source.mediaIds.length === 1 ? 'photo' : 'photos'}.`
        : wholeAlbum ? 'Choose how to save the photos in your current Album.' : `Choose how to save all Album photos except ${source.excludedMediaIds.length.toLocaleString()}.`}
      {' '}You’ll confirm the photo count before transfer.
    </p> : <>
      <p>Prepare a private snapshot of your selected originals, then confirm the count before transfer.</p>
      {source.mode === 'all' && <p>All matching photos{source.excludedMediaIds.length ? ` except ${source.excludedMediaIds.length}` : ''}. Up to 10,000 photos; the exact frozen count appears next.</p>}
    </>}
    {active ? (active.ownedByCurrentPrincipal && active.kind === 'selection'
      ? <div className="photo-export-actions"><button type="button" className="button button--primary" disabled={busy} onClick={() => void run(signal => getJob(active.id, signal))}>Resume photo export</button><button type="button" className="button button--secondary" disabled={busy} onClick={() => void run(async signal => { await mutation(active.id, 'cancel', signal); })}>Cancel photo export</button></div>
      : <p>{active.kind} {active.destination} export: {active.state}. It must finish or expire before a new export can start.</p>)
      : <div className="photo-export-actions"><button type="button" className="button button--primary" disabled={busy || !capabilities?.enabled || !capabilities.destinations.includes('device')} onClick={() => void run(signal => freeze('device', signal))}>Prepare for this device</button><button type="button" className="button button--secondary" disabled={busy || !capabilities?.enabled || !capabilities.destinations.includes('archive')} onClick={() => void run(signal => freeze('archive', signal))}>Prepare photo ZIP</button></div>}
    {capabilities && !capabilities.enabled && <p>New photo exports are paused. You can resume or cancel your existing export.</p>}
  </>;
  else content = <>
    <p>Frozen {new Date(job.snapshotAt).toLocaleString()}: <strong>{job.mediaCount.toLocaleString()} photos · {formatBytes(job.totalBytes)} ({job.totalBytes.toLocaleString()} bytes)</strong></p>
    <p>Available until {new Date(job.holdExpiresAt).toLocaleString()}.</p>
    <div className="photo-export-counts" aria-live="polite"><span>Prepared: {batch?.files.length ?? 0}</span><span>Handed to your device: {job.destination === 'archive' ? priorHandoffs : job.handedOffCount}</span><span>Remaining: {remaining}</span><span>Unavailable: {unavailable}</span></div>
    {unavailable > 0 && <p>{unavailable} original{unavailable === 1 ? '' : 's'} could not be prepared. They remain in this frozen selection. Retry fewer photos or use the complete selection ZIP.</p>}
    {job.errorCode && <p role="alert">This export was interrupted ({job.errorCode}). Refresh its status or use the recovery actions below.</p>}
    {job.destination === 'archive' ? <>
      <p>The ZIP includes the complete frozen selection, including any photos previously handed to your device.</p>
      {!job.confirmedAt && !terminal && <button type="button" className="button button--primary" disabled={busy} onClick={() => void run(async signal => { await mutation(job.id, 'confirm', signal); })}>Confirm photo ZIP</button>}
      {job.confirmedAt && !terminal && <p>Preparing your photo ZIP. Refresh to check its progress.</p>}
      {job.state === 'ready' && <button type="button" className="button button--primary" disabled={busy} onClick={() => void run(async signal => { const result = await api<ExportDownloadView>(`/api/manage/events/${encodeURIComponent(eventId)}/exports/${job.id}/download`, { method: 'POST', signal }); if (!signal.aborted) setDownload(result); })}>Get ZIP download links</button>}
      {download && <div className="export-links">{download.manifest && <a href={download.manifest.url}>Photo manifest</a>}{download.parts.map(part => <a key={part.partNumber} href={part.url}>Photo ZIP part {part.partNumber} of {download.parts.length}</a>)}</div>}
      {['failed', 'expired'].includes(job.state) && <button type="button" className="button button--secondary" disabled={busy || !capabilities?.enabled} onClick={() => void run(async signal => { await mutation(job.id, 'retry', signal); setDownload(null); })}>Retry photo ZIP</button>}
    </> : <>
      <p>In the device sheet, choose Save Images when offered. Then open Photos and add the images to a new or existing personal album. iCloud syncing depends on your Photos settings.</p>
      <p>“Handed to your device” records the handoff; it does not confirm a save in Photos.</p>
      {!job.confirmedAt && !terminal && !job.cancelRequested && <button type="button" className="button button--primary" disabled={busy} onClick={() => void run(async signal => { const next = await mutation(job.id, 'confirm', signal); await prepare(next, signal); })}>Confirm and prepare photos</button>}
      {receipt && !job.cancelRequested && <div>
        {receipt.stage === 'sharing' && <p>The last device sheet was interrupted. We cannot tell whether those photos were handed off. They will not be shared automatically. Record the handoff only if you completed it, or use ZIP.</p>}
        <button type="button" className="button button--primary" disabled={busy} onClick={() => void run(signal => acknowledge(job, receipt, signal))}>{receipt.stage === 'handed-off' ? 'Retry handoff receipt' : 'Record completed handoff'}</button>
      </div>}
      {job.confirmedAt && !job.cancelRequested && !receipt && !terminal && <div className="photo-export-actions">
        {batch?.files.length ? <button type="button" className="button button--primary" disabled={busy} onClick={sharePrepared}>Share {batch.files.length} photo{batch.files.length === 1 ? '' : 's'}</button> : <button type="button" className="button button--primary" disabled={busy || remaining === 0} onClick={() => void run(signal => prepare(job, signal))}>Prepare next photos</button>}
        <button type="button" className="button button--secondary" disabled={busy} onClick={() => void run(signal => prepare(job, signal, true))}>Retry fewer photos</button>
      </div>}
      {!terminal && <button type="button" className="button button--secondary" disabled={busy} onClick={() => void run(fallback)}>{job.cancelRequested ? 'Retry ZIP fallback' : 'Use ZIP instead'}</button>}
      {terminal && <p>For another copy, close this receipt and start a new photo export. You can confirm its new snapshot before transferring.</p>}
      {job.cancelRequested && <p>Original reads are stopping. Retry ZIP fallback when they finish, or cancel this export.</p>}
    </>}
    <div className="photo-export-actions"><button type="button" className="text-button" disabled={busy} onClick={() => void run(signal => getJob(job.id, signal))}>Refresh export status</button>{!terminal && <button type="button" className="text-button" disabled={busy} onClick={() => void run(async signal => { await mutation(job.id, 'cancel', signal); setBatch(null); })}>Cancel photo export</button>}</div>
  </>;
  return <section className="photo-export-chooser" role="region" aria-label="Save or share photos" aria-busy={busy || undefined}>
    <div className="photo-export-heading">{albumSource ? <h4 tabIndex={-1} ref={heading}>Save Album photos</h4> : <h3 tabIndex={-1} ref={heading}>Save / Share photos</h3>}<button type="button" className="button button--secondary" onClick={onClose}>Close photo export</button></div>
    {content}
    {busy && <p role="status">Preparing or updating your export…</p>}
    {(error || capabilityError) && <p role="alert">{error ?? `Photo export availability could not be checked. ${capabilityError}`} <button type="button" className="text-button" onClick={refresh}>Check availability again</button></p>}
    {onPrepareFullArchive && !wholeAlbum && (!albumSource || !job) && <button type="button" className="text-button" disabled={busy || (albumSource && !!active)} onClick={() => void run(async () => { await onPrepareFullArchive(); })}>{albumSource ? 'Prepare entire Album ZIP' : 'Prepare full archive'}</button>}
  </section>;
}

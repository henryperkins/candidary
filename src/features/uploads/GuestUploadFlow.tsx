import { AlertCircle, Camera, Check, Image as ImageIcon, Images, LoaderCircle, Pencil, RotateCcw, X } from 'lucide-react';
import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '../../app/api';
import { MAX_IMAGE_BYTES, UPLOAD_BATCH_SIZE } from '../../../shared/constants';
import {
  getReceiptCount,
  removeQueueItem,
  runUploadQueue,
  type ReservationResult,
  type UploadQueueItem,
  type UploadQueueState,
  type UploadReservation,
  type UploadTransport,
} from './upload-queue';

const NAME_STORAGE_KEY = 'candidary_guest_name';
const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,image/heif,image/heic-sequence,image/heif-sequence,.heic,.heif';
const CLIENT_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_IMAGE_TYPES = new Set([
  ...CLIENT_IMAGE_TYPES,
  'image/jpg',
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
  '',
  'application/octet-stream',
]);

interface GuestUploadEvent {
  name: string;
  eventDate: string;
  welcomeMessage: string;
  uploadsEnabled: boolean;
  coverObjectKey?: string | null;
}

interface GuestUploadFlowProps {
  event: GuestUploadEvent;
  slug: string;
  transport?: UploadTransport;
  onDelivered?: (count: number) => void;
}

interface BatchResponseItem {
  idempotencyKey: string;
  status: 'accepted' | 'rejected';
  media?: { id: string; mimeType: string };
  uploadUrl?: string;
  error?: { message: string };
}

function xhrUpload(file: File, reservation: UploadReservation, progress: (percent: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', reservation.uploadUrl);
    request.setRequestHeader('Content-Type', reservation.mimeType);
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) progress((event.loaded / event.total) * 100);
    });
    request.addEventListener('load', () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(new Error('The transfer was interrupted. Try this photo again.'));
    });
    request.addEventListener('error', () => reject(new Error('Reception dropped out. Try this photo again.')));
    request.addEventListener('abort', () => reject(new Error('The transfer was cancelled.')));
    request.send(file);
  });
}

function createBrowserTransport(slug: string, guestName: string): UploadTransport {
  return {
    async reserve(items) {
      const results: ReservationResult[] = [];
      for (let offset = 0; offset < items.length; offset += UPLOAD_BATCH_SIZE) {
        const chunk = items.slice(offset, offset + UPLOAD_BATCH_SIZE);
        const response = await api<{ items: BatchResponseItem[] }>(`/api/event/${slug}/uploads/batch`, {
          method: 'POST',
          body: JSON.stringify({
            guestName,
            files: chunk.map(({ id, file }) => ({
              filename: file.name,
              mimeType: file.type,
              byteSize: file.size,
              idempotencyKey: id,
              caption: null,
            })),
          }),
        });
        results.push(...response.items.map((item) => {
          if (item.status === 'accepted' && item.media && item.uploadUrl) {
            return {
              id: item.idempotencyKey,
              status: 'accepted' as const,
              reservation: { mediaId: item.media.id, uploadUrl: item.uploadUrl, mimeType: item.media.mimeType },
            };
          }
          return {
            id: item.idempotencyKey,
            status: 'rejected' as const,
            error: item.error?.message ?? 'This photo could not be reserved.',
          };
        }));
      }
      return results;
    },
    async upload(item, reservation, progress) {
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await xhrUpload(item.file, reservation, progress);
          return;
        } catch (error) {
          lastError = error;
          if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 350 * 2 ** attempt));
        }
      }
      throw lastError;
    },
    async finalize(_item, reservation) {
      await api(`/api/event/${slug}/uploads/${reservation.mediaId}/finalize`, { method: 'POST', body: '{}' });
    },
  };
}

function validationMessage(file: File): string | null {
  if (file.size < 1) return 'This photo is empty. Choose it again.';
  if (file.size > MAX_IMAGE_BYTES) return 'This photo is larger than 20 MB.';
  const extension = file.name.toLowerCase().split('.').pop();
  const provisionalHeif = (!file.type || file.type === 'application/octet-stream') && (extension === 'heic' || extension === 'heif');
  if (!ALLOWED_IMAGE_TYPES.has(file.type.toLowerCase()) || ((!file.type || file.type === 'application/octet-stream') && !provisionalHeif)) {
    return 'Choose a JPG, PNG, WebP, HEIC, or HEIF photo.';
  }
  return null;
}

function statusLabel(state: UploadQueueState, progress: number) {
  if (state === 'uploading') return `Sending · ${progress}%`;
  if (state === 'reserving') return 'Getting ready';
  if (state === 'queued') return 'Waiting to send';
  if (state === 'finalizing') return 'Confirming delivery';
  if (state === 'delivered') return 'Delivered';
  if (state === 'failed') return 'Needs attention';
  return 'Selected';
}

function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return count === 1 ? singular : pluralForm;
}

export function GuestUploadFlow({ event, slug, transport, onDelivered }: GuestUploadFlowProps) {
  const rememberedName = useMemo(() => localStorage.getItem(NAME_STORAGE_KEY)?.trim() ?? '', []);
  const [name, setName] = useState(rememberedName);
  const [editingName, setEditingName] = useState(!rememberedName);
  const [nameError, setNameError] = useState('');
  const [items, setItems] = useState<UploadQueueItem[]>([]);
  const [sending, setSending] = useState(false);
  const cameraInput = useRef<HTMLInputElement>(null);
  const libraryInput = useRef<HTMLInputElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const objectUrls = useRef(new Set<string>());
  const notifiedReceipt = useRef<number | null>(null);
  const receiptCount = getReceiptCount(items);

  useEffect(() => () => {
    objectUrls.current.forEach((url) => URL.revokeObjectURL(url));
  }, []);

  useEffect(() => {
    if (receiptCount && notifiedReceipt.current !== receiptCount) {
      notifiedReceipt.current = receiptCount;
      onDelivered?.(receiptCount);
    }
  }, [onDelivered, receiptCount]);

  function saveName(): string | null {
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError('Enter your name before adding photos.');
      setEditingName(true);
      nameInput.current?.focus();
      requestAnimationFrame(() => nameInput.current?.focus());
      return null;
    }
    setName(trimmed);
    setNameError('');
    setEditingName(false);
    localStorage.setItem(NAME_STORAGE_KEY, trimmed);
    return trimmed;
  }

  function openSource(input: HTMLInputElement | null) {
    if (!event.uploadsEnabled || !saveName()) return;
    input?.click();
  }

  function addFiles(files: FileList | null, isNewCapture: boolean) {
    if (!files?.length || !saveName()) return;
    const next = Array.from(files).map((file): UploadQueueItem => {
      const error = validationMessage(file);
      let previewUrl: string | undefined;
      if (CLIENT_IMAGE_TYPES.has(file.type) && typeof URL.createObjectURL === 'function') {
        previewUrl = URL.createObjectURL(file);
        objectUrls.current.add(previewUrl);
      }
      return {
        id: crypto.randomUUID(),
        file,
        state: error ? 'failed' : 'selected',
        progress: 0,
        isNewCapture,
        ...(error ? { error, validationError: true } : {}),
        ...(previewUrl ? { previewUrl } : {}),
      };
    });
    setItems((current) => [...current, ...next]);
  }

  function remove(id: string) {
    const target = items.find((item) => item.id === id);
    if (target?.previewUrl) {
      URL.revokeObjectURL(target.previewUrl);
      objectUrls.current.delete(target.previewUrl);
    }
    setItems((current) => removeQueueItem(current, id));
  }

  async function send() {
    const savedName = saveName();
    if (!savedName || sending) return;
    setSending(true);
    const activeTransport = transport ?? createBrowserTransport(slug, savedName);
    const result = await runUploadQueue(items, activeTransport, 2, setItems);
    setItems(result);
    setSending(false);
  }

  const unresolvedCount = items.filter(({ state, validationError }) =>
    !validationError && (state === 'selected' || state === 'failed')).length;
  const failedCount = items.filter(({ state }) => state === 'failed').length;
  const reviewMode = items.length > 0;
  const eventDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })
    .format(new Date(`${event.eventDate}T12:00:00`));
  const heroStyle = event.coverObjectKey
    ? ({ '--event-cover': `url("/api/event/${encodeURIComponent(slug)}/cover")` } as CSSProperties)
    : undefined;

  if (receiptCount) {
    return <section className="photo-drop photo-drop--receipt" aria-live="polite">
      <div className="delivery-receipt">
        <span className="delivery-receipt__check"><Check aria-hidden="true" /></span>
        <p className="delivery-receipt__eyebrow">Delivered to {event.name}</p>
        <h1>Your {receiptCount} {plural(receiptCount, 'photo')} {receiptCount === 1 ? 'was' : 'were'} sent.</h1>
        <p>Thanks, {name}. You’re all done and can close this page.</p>
      </div>
    </section>;
  }

  return <section className={`photo-drop${reviewMode ? ' photo-drop--review' : ''}`}>
    {!reviewMode && <div className={`photo-drop__hero${event.coverObjectKey ? ' photo-drop__hero--cover' : ''}`} style={heroStyle}>
      <p className="photo-drop__event">{event.name} <span aria-hidden="true">·</span> {eventDate}</p>
      <h1>{event.welcomeMessage || 'Help us remember tonight.'}</h1>
    </div>}

    <div className="photo-drop__card">
      {reviewMode && <header className="review-heading">
        <p>Sending as {name}</p>
        <h1>Ready to send</h1>
        <button type="button" className="text-button" onClick={() => setEditingName(true)} disabled={sending}>
          <Pencil aria-hidden="true" /> Edit name
        </button>
      </header>}

      {editingName ? <label className="photo-drop__name">
        <span>Your name <strong>Required</strong></span>
        <input
          ref={nameInput}
          value={name}
          maxLength={80}
          autoComplete="name"
          aria-label="Your name"
          aria-invalid={Boolean(nameError)}
          aria-describedby={nameError ? 'guest-name-error' : undefined}
          placeholder="Taylor Morgan"
          onChange={(change) => { setName(change.target.value); setNameError(''); }}
          onBlur={() => { if (name.trim()) saveName(); }}
        />
      </label> : !reviewMode && <div className="sending-as">
        <span>Sending as {name}</span>
        <button type="button" className="text-button" aria-label="Edit name" onClick={() => setEditingName(true)}><Pencil aria-hidden="true" /> Edit</button>
      </div>}
      {nameError && <p className="field-error" id="guest-name-error" role="alert"><AlertCircle aria-hidden="true" /> {nameError}</p>}

      {!reviewMode ? <div className="photo-source-actions">
        <button type="button" className="source-button source-button--camera" disabled={!event.uploadsEnabled} onClick={() => openSource(cameraInput.current)}>
          <Camera aria-hidden="true" /> Take a photo
        </button>
        <button type="button" className="source-button source-button--library" disabled={!event.uploadsEnabled} onClick={() => openSource(libraryInput.current)}>
          <Images aria-hidden="true" /> Choose recent photos
        </button>
        <p>{event.uploadsEnabled ? 'No account needed. Your name is remembered here.' : 'The host has paused photo delivery for now.'}</p>
      </div> : <>
        <ul className="selection-grid" aria-label="Selected photos" aria-live="polite">
          {items.map((item) => <li key={item.id} className={`selection-card selection-card--${item.state}`}>
            <div className="selection-card__image">
              {item.previewUrl
                ? <img src={item.previewUrl} alt="" />
                : <ImageIcon aria-hidden="true" />}
              {item.isNewCapture && <span className="new-badge">New</span>}
              {['selected', 'failed'].includes(item.state) && <button type="button" aria-label={`Remove ${item.file.name}`} onClick={() => remove(item.id)} disabled={sending}><X aria-hidden="true" /></button>}
              {['reserving', 'queued', 'uploading', 'finalizing'].includes(item.state) && <span className="selection-card__spinner"><LoaderCircle aria-hidden="true" /></span>}
              {item.state === 'delivered' && <span className="selection-card__delivered"><Check aria-hidden="true" /></span>}
            </div>
            <div className="selection-card__status">
              <strong>{item.file.name}</strong>
              <span>{statusLabel(item.state, item.progress)}</span>
              {item.error && <small>{item.error}</small>}
              {item.state === 'uploading' && <progress max="100" value={item.progress} aria-label={`Sending ${item.file.name}`} />}
            </div>
          </li>)}
        </ul>
        <div className="selection-add-actions">
          <button type="button" className="source-button source-button--library" disabled={sending} onClick={() => openSource(libraryInput.current)}><Images aria-hidden="true" /> Add recent photos</button>
          <button type="button" className="text-button" disabled={sending} onClick={() => openSource(cameraInput.current)}><RotateCcw aria-hidden="true" /> Retake a photo</button>
        </div>
        <div className="selection-summary">
          <span>{items.length} {plural(items.length, 'photo')} selected</span>
          {failedCount > 0 && <span>{failedCount} need {failedCount === 1 ? 'attention' : 'attention'}</span>}
        </div>
        {unresolvedCount > 0 && <button type="button" className="send-button" disabled={sending} onClick={() => void send()}>
          {sending ? <><LoaderCircle aria-hidden="true" /> Sending…</> : `${items.some(({ state }) => state === 'failed') ? 'Retry' : 'Send'} ${unresolvedCount} ${plural(unresolvedCount, 'photo')}`}
        </button>}
        <p className="progress-note">Keep this page open while your photos transfer.</p>
      </>}

      <input
        ref={cameraInput}
        className="sr-only"
        hidden
        data-photo-source="camera"
        type="file"
        accept={IMAGE_ACCEPT}
        capture="environment"
        aria-label="Take a photo from your camera"
        onChange={(change) => { addFiles(change.currentTarget.files, true); change.currentTarget.value = ''; }}
      />
      <input
        ref={libraryInput}
        className="sr-only"
        hidden
        data-photo-source="library"
        type="file"
        accept={IMAGE_ACCEPT}
        multiple
        aria-label="Choose recent photos from your library"
        onChange={(change) => { addFiles(change.currentTarget.files, false); change.currentTarget.value = ''; }}
      />
    </div>
  </section>;
}

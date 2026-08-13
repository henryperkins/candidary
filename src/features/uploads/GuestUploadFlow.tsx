import { AlertCircle, Camera, Check, Image as ImageIcon, Images, LoaderCircle, Pencil, RotateCcw, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { MAX_IMAGE_BYTES } from '../../../shared/constants';
import type { GuestEventCoverView } from '../../../shared/event-cover';
import { guestEventCoverSlotPath } from '../../app/api';
import { readGuestName, rememberGuestName } from '../../app/guest-name-storage';
import { GuestEventHero } from '../../components/GuestEventHero';
import { createBrowserTransport } from './browser-upload-transport';
import {
  getReceiptCount,
  removeQueueItem,
  runUploadQueue,
  type UploadQueueItem,
  type UploadQueueState,
  type UploadTransport,
} from './upload-queue';

const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,image/heif,image/heic-sequence,image/heif-sequence,.heic,.heif';
const CLIENT_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_IMAGE_TYPES = new Set([
  ...CLIENT_IMAGE_TYPES,
  'image/jpg',
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
]);
const PROVISIONAL_HEIF_TYPES = new Map([
  ['', null],
  ['application/octet-stream', null],
  ['binary/octet-stream', null],
  ['image/x-heic', 'heic'],
  ['image/x-heic-sequence', 'heic'],
  ['image/x-heif', 'heif'],
  ['image/x-heif-sequence', 'heif'],
]);
interface GuestUploadEvent {
  name: string;
  eventDate: string;
  welcomeMessage: string;
  uploadsEnabled: boolean;
  cover: GuestEventCoverView;
}

interface GuestUploadFlowProps {
  event: GuestUploadEvent;
  slug: string;
  transport?: UploadTransport;
  onDelivered?: (count: number) => void;
  guestName?: string;
  onGuestNameChange?: (name: string) => void;
  onLeaveGuestbook?: () => void;
}

function validationMessage(file: File): string | null {
  if (file.size < 1) return 'This photo is empty. Choose it again.';
  if (file.size > MAX_IMAGE_BYTES) return 'This photo is larger than 20 MB.';
  const extension = file.name.toLowerCase().split('.').pop();
  const normalizedType = file.type.toLowerCase();
  const expectedExtension = PROVISIONAL_HEIF_TYPES.get(normalizedType);
  const provisionalHeif = PROVISIONAL_HEIF_TYPES.has(normalizedType)
    && (extension === 'heic' || extension === 'heif')
    && (!expectedExtension || extension === expectedExtension);
  if (!ALLOWED_IMAGE_TYPES.has(normalizedType) && !provisionalHeif) {
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

export function GuestUploadFlow({
  event,
  slug,
  transport,
  onDelivered,
  guestName,
  onGuestNameChange,
  onLeaveGuestbook,
}: GuestUploadFlowProps) {
  const [fallbackName, setFallbackName] = useState(readGuestName);
  const name = guestName ?? fallbackName;
  const [editingName, setEditingName] = useState(!name);
  const [nameError, setNameError] = useState('');
  const [items, setItems] = useState<UploadQueueItem[]>([]);
  const [sending, setSending] = useState(false);
  const cameraInput = useRef<HTMLInputElement>(null);
  const libraryInput = useRef<HTMLInputElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const objectUrls = useRef(new Set<string>());
  const uploadController = useRef<AbortController | null>(null);
  const notifiedReceipt = useRef<number | null>(null);
  const receiptCount = getReceiptCount(items);

  function updateName(value: string) {
    if (guestName === undefined) setFallbackName(value);
    onGuestNameChange?.(value);
  }

  useEffect(() => () => {
    uploadController.current?.abort();
    uploadController.current = null;
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
    updateName(trimmed);
    setNameError('');
    setEditingName(false);
    if (!onGuestNameChange) rememberGuestName(trimmed);
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
    const controller = new AbortController();
    uploadController.current = controller;
    setSending(true);
    const activeTransport = transport ?? createBrowserTransport(slug, savedName);
    const result = await runUploadQueue(items, activeTransport, {
      concurrency: 2,
      onChange: setItems,
      signal: controller.signal,
    });
    setItems(result);
    setSending(false);
    uploadController.current = null;
  }

  const unresolvedCount = items.filter(({ state, validationError }) =>
    !validationError && (state === 'selected' || state === 'failed')).length;
  const attemptedFailureCount = items.filter(({ state, validationError }) =>
    !validationError && state === 'failed').length;
  const failedCount = items.filter(({ state }) => state === 'failed').length;
  const validationFailureCount = items.filter(({ validationError }) => validationError).length;
  const onlyValidationFailures = items.length > 0 && validationFailureCount === items.length;
  const reviewMode = items.length > 0;
  const eventDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })
    .format(new Date(`${event.eventDate}T12:00:00`));

  if (receiptCount) {
    return <section className="photo-drop photo-drop--receipt" aria-live="polite">
      <div className="delivery-receipt">
        <span className="delivery-receipt__check"><Check aria-hidden="true" /></span>
        <p className="delivery-receipt__eyebrow">Delivered to {event.name}</p>
        <h1>Your {receiptCount} {plural(receiptCount, 'photo')} {receiptCount === 1 ? 'was' : 'were'} sent.</h1>
        {validationFailureCount > 0 && <p className="delivery-receipt__caveat">{validationFailureCount} {plural(validationFailureCount, 'photo')} could not be added.</p>}
        <p>Thanks, {name}. You’re all done and can close this page.</p>
        {onLeaveGuestbook && <button type="button" className="button button--secondary delivery-receipt__guestbook" onClick={onLeaveGuestbook}>Leave a guestbook note</button>}
      </div>
    </section>;
  }

  return <section className={`photo-drop${reviewMode ? ' photo-drop--review' : ''}`}>
    {!reviewMode && <GuestEventHero
      event={event}
      sourceFor={(slot) => guestEventCoverSlotPath(slug, slot)}
      lookup={false}
    />}

    <div className="photo-drop__card">
      {reviewMode && <header className="review-heading">
        <p>{event.name} <span aria-hidden="true">·</span> {eventDate}</p>
        <p>Sending as {name}</p>
        <h1>{sending ? 'Sending photos' : 'Ready to send'}</h1>
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
          onChange={(change) => { updateName(change.target.value); setNameError(''); }}
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
          {failedCount > 0 && <span className="selection-summary__attention">{failedCount} {plural(failedCount, 'needs', 'need')} attention</span>}
        </div>
        {(sending || unresolvedCount > 0) && <button type="button" className="send-button" disabled={sending} onClick={() => void send()}>
          {sending ? <><LoaderCircle aria-hidden="true" /> Sending…</> : `${attemptedFailureCount > 0 ? 'Retry' : 'Send'} ${unresolvedCount} ${plural(unresolvedCount, 'photo')}`}
        </button>}
        {sending && <button type="button" className="text-button send-cancel" onClick={() => uploadController.current?.abort()}>
          Cancel sending
        </button>}
        <p className="progress-note">{onlyValidationFailures
          ? 'Remove or replace the photos that need attention.'
          : 'Keep this page open while your photos transfer.'}</p>
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
